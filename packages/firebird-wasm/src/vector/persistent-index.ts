/**
 * Database-Backed Persistent Vector Index (`createVectorIndex`) for `firebird-wasm/vector`.
 */

import type { QueryParams, Row } from '../types';
import type { ReplicationIndexHook } from '../replication/types';
import type {
  VectorDatabaseExecutor,
  VectorInput,
  VectorSearchRow,
} from './index';
import type { VectorQuantizationMode } from './quantization';
import {
  attachIndexAutoSync,
  buildReplicationIndexHook,
  type QueryObservableExecutor,
} from './auto-sync';
import { HnswIndex, type HnswIndexOptions } from './hnsw';

export interface VectorIndexDatabaseExecutor
  extends VectorDatabaseExecutor,
    QueryObservableExecutor {
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

/**
 * Options for {@link createVectorIndex}.
 */
export interface CreateVectorIndexOptions extends HnswIndexOptions {
  /** Target table name containing the vectors. */
  table: string;
  /** Column name storing the vector embeddings. */
  column: string;
  /** Primary-key column name on `table` (default: `'ID'`). */
  keyColumn?: string;
  /** Optional explicit index name (default: `'IDX_<TABLE>_<COLUMN>_HNSW'`). */
  name?: string;
  /**
   * Whether to persist the HNSW graph inside the database's `FB_VECTOR_INDEX$`
   * catalog table and reload it if already saved (default: `false`).
   */
  persist?: boolean;
  /**
   * When `persist: true`, force a full rebuild from `table` even if a stored
   * snapshot already exists in `FB_VECTOR_INDEX$` (default: `false`).
   */
  forceRebuild?: boolean;
  /**
   * Automatically refresh the HNSW index when local DML (`INSERT` / `UPDATE` / `DELETE`)
   * mutates `table` via `db.onQuery` (`M25 Item 3`). @default false
   */
  autoSync?: boolean;
}

/**
 * Options for querying a {@link PersistentVectorIndex}.
 */
export interface PersistentVectorIndexSearchOptions {
  /** Maximum number of nearest neighbors to return (default: `10`). */
  limit?: number;
  /** HNSW beam width during search (default: `index.hnsw.efSearch`). */
  efSearch?: number;
  /** Optional SQL `WHERE` predicate for hybrid pre-filtering. */
  where?: string;
  /** Positional parameters for `where`. */
  params?: QueryParams;
  /** Columns to select from the table (default: `'*'`). */
  select?: readonly string[] | '*';
  /** Maximum distance threshold. */
  maxDistance?: number;
  /** Minimum similarity threshold. */
  minSimilarity?: number;
  /** Output property name for distance (default: `'DISTANCE'`). */
  distanceColumn?: string;
  /** Output property name for similarity (default: `'SIMILARITY'`). */
  similarityColumn?: string;
  /** Include the raw vector column in the returned rows (default: `false`). */
  includeVector?: boolean;
}

/**
 * Handle to a table-bound HNSW vector index created by {@link createVectorIndex}.
 */
export interface PersistentVectorIndex<ID = string | number> {
  /** Unique index name. */
  readonly name: string;
  /** Indexed table name. */
  readonly table: string;
  /** Indexed vector column name. */
  readonly column: string;
  /** Primary-key column name. */
  readonly keyColumn: string;
  /** Underlying in-memory {@link HnswIndex} graph. */
  readonly hnsw: HnswIndex<ID>;
  /** Number of indexed vectors. */
  readonly size: number;
  /** Active vector quantization mode (`'none' | 'int8' | 'binary'`, `M25 Item 3`). */
  readonly quantization: VectorQuantizationMode;

  /** Insert or update a vector in the index (and optionally persist). */
  upsert(id: ID, vector: VectorInput): Promise<void>;
  /** Remove a vector from the index by primary key. */
  remove(id: ID): Promise<boolean>;
  /** Rebuild the entire HNSW graph from the current rows in `table`. */
  rebuild(): Promise<void>;
  /** Persist the serialized HNSW graph into `FB_VECTOR_INDEX$`. */
  save(): Promise<void>;
  /** Drop the persisted entry from `FB_VECTOR_INDEX$` and clear the in-memory index. */
  drop(): Promise<void>;
  /** Return a `ReplicationIndexHook` keeping this index incrementally synced on inbound replication (`M25 Item 3`). */
  asReplicationIndexHook(): ReplicationIndexHook;
  /** Unsubscribe any `autoSync` `db.onQuery` listener (`M25 Item 3`). */
  dispose(): void;
  /**
   * Search the HNSW index and fetch the matching rows from Firebird.
   */
  search<T extends Row = Row>(
    query: VectorInput,
    options?: PersistentVectorIndexSearchOptions,
  ): Promise<Array<VectorSearchRow<T>>>;
}

const VECTOR_INDEX_TABLE = 'FB_VECTOR_INDEX$';

function quoteIdent(ident: string, label: string): string {
  const trimmed = ident.trim();
  if (!trimmed) {
    throw new RangeError(`${label} cannot be empty`);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
    throw new RangeError(`Invalid ${label} '${ident}'`);
  }
  return `"${trimmed.toUpperCase()}"`;
}

function getFieldCI(
  row: Record<string, unknown>,
  name: string,
): { key: string; value: unknown } | undefined {
  const clean = name.replace(/^"|"$/g, '');
  if (clean in row) return { key: clean, value: row[clean] };
  const upper = clean.toUpperCase();
  if (upper in row) return { key: upper, value: row[upper] };
  const lower = clean.toLowerCase();
  if (lower in row) return { key: lower, value: row[lower] };
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return { key: k, value: row[k] };
  }
  return undefined;
}

async function runStatement(
  db: VectorIndexDatabaseExecutor,
  sql: string,
  params?: QueryParams,
): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
  } else {
    await db.query(sql, params);
  }
}

async function ensureVectorIndexCatalogTable(
  db: VectorIndexDatabaseExecutor,
): Promise<void> {
  const check = await db.query<{ CNT: number }>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = '${VECTOR_INDEX_TABLE}'`,
  );
  const cnt = Number(check.rows[0]?.CNT ?? 0);
  if (cnt > 0) return;

  await runStatement(
    db,
    `CREATE TABLE "${VECTOR_INDEX_TABLE}" (
      INDEX_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
      TABLE_NAME VARCHAR(128) NOT NULL,
      COLUMN_NAME VARCHAR(128) NOT NULL,
      KEY_COLUMN VARCHAR(128) NOT NULL,
      METRIC VARCHAR(16) NOT NULL,
      GRAPH_JSON BLOB SUB_TYPE TEXT NOT NULL,
      UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

/**
 * Create (or load) an HNSW Approximate Nearest Neighbor vector index over a
 * Firebird table's vector column.
 */
export async function createVectorIndex<ID = number | string>(
  db: VectorIndexDatabaseExecutor,
  options: CreateVectorIndexOptions,
): Promise<PersistentVectorIndex<ID>> {
  const tableIdent = quoteIdent(options.table, 'table name');
  const colIdent = quoteIdent(options.column, 'vector column name');
  const keyColRaw = options.keyColumn ?? 'ID';
  const keyIdent = quoteIdent(keyColRaw, 'key column name');
  const cleanTable = options.table.trim().replace(/^"|"$/g, '').toUpperCase();
  const cleanCol = options.column.trim().replace(/^"|"$/g, '').toUpperCase();
  const cleanKey = keyColRaw.trim().replace(/^"|"$/g, '');
  const indexName = (
    options.name ?? `IDX_${cleanTable}_${cleanCol}_HNSW`
  ).toUpperCase();
  const persist = options.persist === true;

  const buildHnsw = () =>
    new HnswIndex<ID>({
      dimensions: options.dimensions,
      metric: options.metric,
      M: options.M,
      efConstruction: options.efConstruction,
      efSearch: options.efSearch,
      seed: options.seed,
      quantization: options.quantization,
      rescoreOversample: options.rescoreOversample,
    });

  let hnsw = buildHnsw();

  const populateFromTable = async (): Promise<void> => {
    hnsw = buildHnsw();
    const res = await db.query<Record<string, unknown>>(
      `SELECT ${keyIdent}, ${colIdent} FROM ${tableIdent} WHERE ${colIdent} IS NOT NULL`,
    );
    for (const row of res.rows) {
      const kEntry = getFieldCI(row, cleanKey);
      const vEntry = getFieldCI(row, cleanCol);
      if (
        !kEntry ||
        kEntry.value === null ||
        kEntry.value === undefined ||
        !vEntry ||
        vEntry.value === null ||
        vEntry.value === undefined
      ) {
        continue;
      }
      hnsw.add(kEntry.value as ID, vEntry.value as VectorInput);
    }
  };

  const saveToCatalog = async (): Promise<void> => {
    await ensureVectorIndexCatalogTable(db);
    const json = JSON.stringify(hnsw.toJSON());
    await runStatement(
      db,
      `UPDATE OR INSERT INTO "${VECTOR_INDEX_TABLE}" (INDEX_NAME, TABLE_NAME, COLUMN_NAME, KEY_COLUMN, METRIC, GRAPH_JSON, UPDATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (INDEX_NAME)`,
      [indexName, cleanTable, cleanCol, cleanKey.toUpperCase(), hnsw.metric, json],
    );
  };

  if (persist) {
    await ensureVectorIndexCatalogTable(db);
    if (!options.forceRebuild) {
      const saved = await db.query<{ GRAPH_JSON: string }>(
        `SELECT GRAPH_JSON FROM "${VECTOR_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
        [indexName],
      );
      const graphJson = saved.rows[0]?.GRAPH_JSON;
      if (typeof graphJson === 'string' && graphJson.length > 0) {
        hnsw = HnswIndex.deserialize<ID>(graphJson, {
          seed: options.seed,
          quantization: options.quantization,
        });
      } else {
        await populateFromTable();
        await saveToCatalog();
      }
    } else {
      await populateFromTable();
      await saveToCatalog();
    }
  } else {
    await populateFromTable();
  }

  const autoSyncCtrl = attachIndexAutoSync(
    db,
    cleanTable,
    options.autoSync === true,
    async () => {
      await populateFromTable();
      if (persist) {
        await saveToCatalog();
      }
    },
  );

  const handle: PersistentVectorIndex<ID> = {
    name: indexName,
    table: options.table,
    column: options.column,
    keyColumn: keyColRaw,
    get hnsw(): HnswIndex<ID> {
      return hnsw;
    },
    get size(): number {
      return hnsw.size;
    },
    get quantization(): VectorQuantizationMode {
      return hnsw.quantization;
    },
    async upsert(id: ID, vector: VectorInput): Promise<void> {
      hnsw.add(id, vector);
      if (persist) {
        await saveToCatalog();
      }
    },
    async remove(id: ID): Promise<boolean> {
      const removed = hnsw.remove(id);
      if (removed && persist) {
        await saveToCatalog();
      }
      return removed;
    },
    async rebuild(): Promise<void> {
      await populateFromTable();
      if (persist) {
        await saveToCatalog();
      }
    },
    async save(): Promise<void> {
      await saveToCatalog();
    },
    async drop(): Promise<void> {
      autoSyncCtrl.dispose();
      for (const node of hnsw.toJSON().nodes) {
        hnsw.remove(node.id);
      }
      if (persist) {
        await ensureVectorIndexCatalogTable(db);
        await runStatement(
          db,
          `DELETE FROM "${VECTOR_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
          [indexName],
        );
      }
    },
    asReplicationIndexHook(): ReplicationIndexHook {
      return buildReplicationIndexHook<ID>({
        cleanTableUpper: cleanTable,
        keyColumn: cleanKey,
        async onUpsertRow(id, row) {
          const vEntry = getFieldCI(row, cleanCol);
          if (!vEntry || vEntry.value === null || vEntry.value === undefined) {
            await handle.remove(id);
            return;
          }
          await handle.upsert(id, vEntry.value as VectorInput);
        },
        async onDeleteId(id) {
          await handle.remove(id);
        },
      });
    },
    dispose(): void {
      autoSyncCtrl.dispose();
    },
    async search<T extends Row = Row>(
      query: VectorInput,
      searchOpts: PersistentVectorIndexSearchOptions = {},
    ): Promise<Array<VectorSearchRow<T>>> {
      await autoSyncCtrl.ensureSynced();
      const limit = searchOpts.limit ?? 10;
      const distanceCol = searchOpts.distanceColumn ?? 'DISTANCE';
      const similarityCol = searchOpts.similarityColumn ?? 'SIMILARITY';
      const includeVector = searchOpts.includeVector === true;

      let allowedIds: Set<string> | null = null;
      if (searchOpts.where?.trim()) {
        const filterRes = await db.query<Record<string, unknown>>(
          `SELECT ${keyIdent} FROM ${tableIdent} WHERE (${searchOpts.where.trim()}) AND ${colIdent} IS NOT NULL`,
          searchOpts.params ?? [],
        );
        allowedIds = new Set<string>();
        for (const r of filterRes.rows) {
          const kv = getFieldCI(r, cleanKey);
          if (kv && kv.value !== null && kv.value !== undefined) {
            allowedIds.add(String(kv.value));
          }
        }
        if (allowedIds.size === 0) {
          return [];
        }
      }

      const hits = hnsw.search(query, {
        k: limit,
        efSearch: searchOpts.efSearch,
        filter: allowedIds ? (id) => allowedIds!.has(String(id)) : undefined,
        maxDistance: searchOpts.maxDistance,
        minSimilarity: searchOpts.minSimilarity,
      });

      if (hits.length === 0) {
        return [];
      }

      let selectClause = '*';
      if (Array.isArray(searchOpts.select) && searchOpts.select.length > 0) {
        const requested = [...searchOpts.select];
        const hasKeyCol = requested.some(
          (s) =>
            s.trim() === '*' ||
            s.trim().replace(/^"|"$/g, '').toUpperCase() === cleanKey.toUpperCase(),
        );
        if (!hasKeyCol) {
          requested.push(keyIdent);
        }
        selectClause = requested.join(', ');
      }

      const placeholders = hits.map(() => '?').join(', ');
      const rowRes = await db.query<Record<string, unknown>>(
        `SELECT ${selectClause} FROM ${tableIdent} WHERE ${keyIdent} IN (${placeholders})`,
        hits.map((h) => h.id),
      );

      const rowById = new Map<string, Record<string, unknown>>();
      for (const r of rowRes.rows) {
        const kv = getFieldCI(r, cleanKey);
        if (kv && kv.value !== null && kv.value !== undefined) {
          rowById.set(String(kv.value), r);
        }
      }

      const out: Array<VectorSearchRow<T>> = [];
      for (const hit of hits) {
        const row = rowById.get(String(hit.id));
        if (!row) continue;
        const copy: Record<string, unknown> = { ...row };
        if (!includeVector) {
          const vecField = getFieldCI(copy, cleanCol);
          if (vecField) {
            delete copy[vecField.key];
          }
        }
        copy[distanceCol] = hit.distance;
        copy[similarityCol] = hit.similarity;
        out.push(copy as VectorSearchRow<T>);
      }

      return out;
    },
  };
  return handle;
}
