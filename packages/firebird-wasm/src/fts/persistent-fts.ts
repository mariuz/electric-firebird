/**
 * persistent-fts.ts – Database-Persisted Okapi BM25 Full-Text Search Index (`createFtsIndex`).
 */

import type { QueryParams, Row } from '../types';
import type { ReplicationIndexHook } from '../replication/types';
import {
  attachIndexAutoSync,
  buildReplicationIndexHook,
} from '../vector/auto-sync';
import {
  Bm25Index,
  highlightSnippet,
  type Bm25IndexOptions,
  type FtsDatabaseExecutor,
} from './index';

export interface CreateFtsIndexOptions extends Bm25IndexOptions {
  table: string;
  columns: readonly string[];
  keyColumn?: string;
  name?: string;
  persist?: boolean;
  forceRebuild?: boolean;
  autoSync?: boolean;
}

export interface PersistentFtsSearchOptions {
  limit?: number;
  matchMode?: 'any' | 'all';
  where?: string;
  params?: QueryParams;
  select?: readonly string[] | '*';
  minScore?: number;
  scoreColumn?: string;
  highlightColumn?: string;
  highlightTargetColumn?: string;
}

export type FtsSearchRow<T extends Row = Row> = T & {
  BM25_SCORE: number;
  HIGHLIGHT?: string;
};

export interface PersistentFtsIndex<ID = string | number> {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly keyColumn: string;
  readonly bm25: Bm25Index<ID>;
  readonly size: number;

  upsert(id: ID, content: string | Record<string, unknown>): Promise<void>;
  remove(id: ID): Promise<boolean>;
  rebuild(): Promise<void>;
  save(): Promise<void>;
  drop(): Promise<void>;
  asReplicationIndexHook(): ReplicationIndexHook;
  dispose(): void;
  search<T extends Row = Row>(
    query: string,
    options?: PersistentFtsSearchOptions,
  ): Promise<Array<FtsSearchRow<T>>>;
}

const FTS_INDEX_TABLE = 'FB_FTS_INDEX$';

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

async function runSql(
  db: FtsDatabaseExecutor,
  sql: string,
  params?: QueryParams,
): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
  } else {
    await db.query(sql, params);
  }
}

async function ensureFtsCatalogTable(db: FtsDatabaseExecutor): Promise<void> {
  const check = await db.query<{ CNT: number }>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = '${FTS_INDEX_TABLE}'`,
  );
  if (Number(check.rows[0]?.CNT ?? 0) > 0) return;

  await runSql(
    db,
    `CREATE TABLE "${FTS_INDEX_TABLE}" (
      INDEX_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
      TABLE_NAME VARCHAR(128) NOT NULL,
      COLUMNS_CSV VARCHAR(512) NOT NULL,
      KEY_COLUMN VARCHAR(128) NOT NULL,
      INDEX_JSON BLOB SUB_TYPE TEXT NOT NULL,
      UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

export async function createFtsIndex<ID = number | string>(
  db: FtsDatabaseExecutor,
  options: CreateFtsIndexOptions,
): Promise<PersistentFtsIndex<ID>> {
  if (!options.columns || options.columns.length === 0) {
    throw new RangeError('createFtsIndex requires at least one column');
  }
  const tableIdent = quoteIdent(options.table, 'table name');
  const keyColRaw = options.keyColumn ?? 'ID';
  const keyIdent = quoteIdent(keyColRaw, 'key column name');
  const colIdents = options.columns.map((c) => quoteIdent(c, 'column name'));
  const cleanTable = options.table.trim().replace(/^"|"$/g, '').toUpperCase();
  const cleanKey = keyColRaw.trim().replace(/^"|"$/g, '');
  const cleanCols = options.columns.map((c) => c.trim().replace(/^"|"$/g, ''));
  const indexName = (options.name ?? `IDX_${cleanTable}_FTS`).toUpperCase();
  const persist = options.persist === true;

  let bm25 = new Bm25Index<ID>(options);

  const populateFromTable = async (): Promise<void> => {
    bm25 = new Bm25Index<ID>(options);
    const res = await db.query<Record<string, unknown>>(
      `SELECT ${keyIdent}, ${colIdents.join(', ')} FROM ${tableIdent}`,
    );
    for (const row of res.rows) {
      const kEntry = getFieldCI(row, cleanKey);
      if (!kEntry || kEntry.value === null || kEntry.value === undefined) continue;
      const fieldsObj: Record<string, unknown> = {};
      for (const col of cleanCols) {
        const cEntry = getFieldCI(row, col);
        if (cEntry && cEntry.value !== null && cEntry.value !== undefined) {
          fieldsObj[col.toUpperCase()] = cEntry.value;
        }
      }
      bm25.add(kEntry.value as ID, fieldsObj);
    }
  };

  const saveToCatalog = async (): Promise<void> => {
    await ensureFtsCatalogTable(db);
    const json = JSON.stringify(bm25.toJSON());
    await runSql(
      db,
      `UPDATE OR INSERT INTO "${FTS_INDEX_TABLE}" (INDEX_NAME, TABLE_NAME, COLUMNS_CSV, KEY_COLUMN, INDEX_JSON, UPDATED_AT)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (INDEX_NAME)`,
      [
        indexName,
        cleanTable,
        cleanCols.map((c) => c.toUpperCase()).join(','),
        cleanKey.toUpperCase(),
        json,
      ],
    );
  };

  if (persist) {
    await ensureFtsCatalogTable(db);
    if (!options.forceRebuild) {
      const saved = await db.query<{ INDEX_JSON: string }>(
        `SELECT INDEX_JSON FROM "${FTS_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
        [indexName],
      );
      const indexJson = saved.rows[0]?.INDEX_JSON;
      if (typeof indexJson === 'string' && indexJson.length > 0) {
        bm25 = Bm25Index.deserialize<ID>(indexJson);
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

  const handle: PersistentFtsIndex<ID> = {
    name: indexName,
    table: options.table,
    columns: options.columns,
    keyColumn: keyColRaw,
    get bm25(): Bm25Index<ID> {
      return bm25;
    },
    get size(): number {
      return bm25.size;
    },
    async upsert(id: ID, content: string | Record<string, unknown>): Promise<void> {
      bm25.add(id, content);
      if (persist) {
        await saveToCatalog();
      }
    },
    async remove(id: ID): Promise<boolean> {
      const removed = bm25.remove(id);
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
      for (const d of bm25.toJSON().docs) {
        bm25.remove(d.id);
      }
      if (persist) {
        await ensureFtsCatalogTable(db);
        await runSql(
          db,
          `DELETE FROM "${FTS_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
          [indexName],
        );
      }
    },
    asReplicationIndexHook(): ReplicationIndexHook {
      return buildReplicationIndexHook<ID>({
        cleanTableUpper: cleanTable,
        keyColumn: cleanKey,
        async onUpsertRow(id, row) {
          const fieldsObj: Record<string, unknown> = {};
          for (const col of cleanCols) {
            const cEntry = getFieldCI(row, col);
            if (cEntry && cEntry.value !== null && cEntry.value !== undefined) {
              fieldsObj[col.toUpperCase()] = cEntry.value;
            }
          }
          await handle.upsert(id, fieldsObj);
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
      query: string,
      searchOpts: PersistentFtsSearchOptions = {},
    ): Promise<Array<FtsSearchRow<T>>> {
      await autoSyncCtrl.ensureSynced();
      const limit = searchOpts.limit ?? 10;
      const scoreCol = searchOpts.scoreColumn ?? 'BM25_SCORE';
      const highlightTargetCol = searchOpts.highlightTargetColumn ?? 'HIGHLIGHT';

      let allowedIds: Set<string> | null = null;
      if (searchOpts.where?.trim()) {
        const filterRes = await db.query<Record<string, unknown>>(
          `SELECT ${keyIdent} FROM ${tableIdent} WHERE ${searchOpts.where.trim()}`,
          searchOpts.params ?? [],
        );
        allowedIds = new Set<string>();
        for (const r of filterRes.rows) {
          const kv = getFieldCI(r, cleanKey);
          if (kv && kv.value !== null && kv.value !== undefined) {
            allowedIds.add(String(kv.value));
          }
        }
        if (allowedIds.size === 0) return [];
      }

      const hits = bm25.search(query, {
        limit,
        matchMode: searchOpts.matchMode,
        filter: allowedIds ? (id) => allowedIds!.has(String(id)) : undefined,
        minScore: searchOpts.minScore,
      });

      if (hits.length === 0) return [];

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

      const out: Array<FtsSearchRow<T>> = [];
      for (const hit of hits) {
        const row = rowById.get(String(hit.id));
        if (!row) continue;
        const copy: Record<string, unknown> = { ...row, [scoreCol]: hit.score };
        if (searchOpts.highlightColumn) {
          const hlField = getFieldCI(row, searchOpts.highlightColumn);
          if (hlField && hlField.value !== null && hlField.value !== undefined) {
            copy[highlightTargetCol] = highlightSnippet(String(hlField.value), query, options);
          }
        }
        out.push(copy as FtsSearchRow<T>);
      }

      return out;
    },
  };
  return handle;
}
