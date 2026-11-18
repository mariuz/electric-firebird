/**
 * materialized-view.ts – Persistent & Auto-Refreshing Materialized Views
 * (`db.createMaterializedView()` & `db.listMaterializedViews()`) (`M24 Item 2`).
 */

import type {
  FieldInfo,
  QueryParams,
  QueryProfileListener,
  QueryResult,
  Row,
} from './types';
import { toStatement, type SqlFragment } from './sql-tag';
import {
  buildCreateTableDdlFromColumnar,
  type ArrowIngestHost,
  type ArrowIngestResult,
  type ArrowIngestSource,
} from './arrow-ingest';
import { quoteTableIdent } from './table-api';
import { extractMutatedTables, extractReferencedTables } from './browser/live-tables';
import type {
  IncrementalLiveSnapshot,
  LiveIncrementalOptions,
  LiveIncrementalQuery,
} from './live-incremental';

export const DEFAULT_MATVIEWS_TABLE = 'FB_MATVIEWS$';

export type MaterializedViewRefreshStrategy = 'manual' | 'on-commit' | 'interval';
export type MaterializedViewRefreshMode = 'full' | 'diff';

export interface MaterializedViewOptions {
  /** Primary key column(s) enabling incremental `'diff'` refresh and indexed lookups. */
  primaryKey?: string | readonly string[];
  /** Optional secondary index definitions (column name or composite column list). */
  indexes?: ReadonlyArray<string | readonly string[]>;
  /** Automatic refresh policy. @default 'manual' */
  refreshStrategy?: MaterializedViewRefreshStrategy;
  /** Source tables watched when `refreshStrategy === 'on-commit'` (auto-inferred from `selectSql` when omitted). */
  watchTables?: readonly string[];
  /** Polling interval in milliseconds when `refreshStrategy === 'interval'`. @default 5000 */
  intervalMs?: number;
  /** Recreate the backing materialized table on creation if it already exists. @default true */
  replaceExisting?: boolean;
}

export interface MaterializedViewRefreshOptions {
  /** Refresh mode (`'diff'` requires `primaryKey`; defaults to `'diff'` when `primaryKey` is set, else `'full'`). */
  mode?: MaterializedViewRefreshMode;
}

export interface MaterializedViewRefreshResult {
  readonly mode: MaterializedViewRefreshMode;
  readonly rowCount: number;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly durationMs: number;
  readonly refreshedAt: number;
}

export interface MaterializedViewInfo {
  readonly name: string;
  readonly selectSql: string;
  readonly primaryKey: readonly string[];
  readonly indexes: ReadonlyArray<readonly string[]>;
  readonly refreshStrategy: MaterializedViewRefreshStrategy;
  readonly watchTables: readonly string[];
  readonly intervalMs: number | null;
  readonly rowCount: number;
  readonly lastRefreshedAt: number;
  readonly lastDurationMs: number;
}

export interface MaterializedViewHandle<T extends Row = Row> {
  readonly name: string;
  readonly selectSql: string;
  readonly fields: readonly FieldInfo[];
  readonly primaryKey: readonly string[];
  readonly refreshStrategy: MaterializedViewRefreshStrategy;
  readonly watchTables: readonly string[];
  readonly rowCount: number;
  readonly lastRefreshedAt: number;
  /** Execute a `'full'` or keyed `'diff'` refresh of the materialized view. */
  refresh(options?: MaterializedViewRefreshOptions): Promise<MaterializedViewRefreshResult>;
  /** Query rows directly from the materialized backing table. */
  query(whereSql?: string, params?: QueryParams): Promise<QueryResult<T>>;
  /** Subscribe to reactive incremental `{ rows, deltas }` updates on the materialized view. */
  liveIncremental(
    optionsOrListener?:
      | LiveIncrementalOptions<T>
      | ((snapshot: IncrementalLiveSnapshot<T>) => void),
    maybeListener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
  ): Promise<LiveIncrementalQuery<T>>;
  /** Stop background refresh listeners/timers while keeping the materialized table persisted. */
  dispose(): Promise<void>;
  /** Stop listeners/timers, remove catalog metadata from `"FB_MATVIEWS$"`, and `DROP TABLE`. */
  drop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface MaterializedViewDatabaseHost extends ArrowIngestHost {
  query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
  execute(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  execBatch(sql: string, rows: QueryParams[]): Promise<{ affectedRows: number } | void>;
  describeQuery(sql: string | SqlFragment): Promise<{ fields: FieldInfo[] }>;
  queryArrow?(sql: string | SqlFragment, params?: QueryParams): Promise<Uint8Array>;
  loadArrowIpc?(
    tableName: string,
    source: ArrowIngestSource,
    options?: {
      createTable?: boolean;
      primaryKey?: string | readonly string[];
      upsertMatching?: string | readonly string[];
    },
  ): Promise<ArrowIngestResult>;
  onQuery(listener: QueryProfileListener): () => void;
  liveIncremental<R extends Row = Row>(
    sql: string | SqlFragment,
    optionsOrListener?:
      | LiveIncrementalOptions<R>
      | ((snapshot: IncrementalLiveSnapshot<R>) => void),
    maybeListener?: (snapshot: IncrementalLiveSnapshot<R>) => void,
  ): Promise<LiveIncrementalQuery<R>>;
}

function normalizeUpperIdent(raw: string, label: string): string {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) {
    throw new Error(`${label} must not be empty`);
  }
  return trimmed;
}

async function relationExists(
  db: Pick<MaterializedViewDatabaseHost, 'query'>,
  tableUpper: string,
): Promise<boolean> {
  const res = await db.query<Row>(
    `SELECT 1 AS PRESENT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [tableUpper],
  );
  return res.rows.length > 0;
}

async function ensureMatViewsCatalogTable(
  db: Pick<MaterializedViewDatabaseHost, 'query' | 'execute'>,
): Promise<void> {
  if (await relationExists(db, DEFAULT_MATVIEWS_TABLE)) {
    return;
  }
  await db.execute(
    `CREATE TABLE "${DEFAULT_MATVIEWS_TABLE}" (` +
      `"VIEW_NAME" VARCHAR(128) NOT NULL PRIMARY KEY, ` +
      `"SELECT_SQL" BLOB SUB_TYPE TEXT NOT NULL, ` +
      `"PRIMARY_KEY_JSON" VARCHAR(1024), ` +
      `"INDEXES_JSON" VARCHAR(2048), ` +
      `"REFRESH_STRATEGY" VARCHAR(32) NOT NULL, ` +
      `"WATCH_TABLES_JSON" VARCHAR(2048), ` +
      `"INTERVAL_MS" INTEGER, ` +
      `"ROW_COUNT" INTEGER NOT NULL, ` +
      `"LAST_REFRESHED_AT" BIGINT NOT NULL, ` +
      `"LAST_DURATION_MS" DOUBLE PRECISION NOT NULL` +
      `)`,
  );
}

function readRowCol(row: Row, colUpper: string): unknown {
  if (colUpper in row) return row[colUpper];
  const lower = colUpper.toLowerCase();
  if (lower in row) return row[lower];
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase() === colUpper) return v;
  }
  return undefined;
}

function serializePkKey(row: Row, pkCols: readonly string[]): string {
  if (pkCols.length === 1) {
    const v = readRowCol(row, pkCols[0]!);
    return typeof v === 'bigint' ? `b:${v.toString()}` : JSON.stringify(v ?? null);
  }
  return JSON.stringify(
    pkCols.map((c) => {
      const v = readRowCol(row, c);
      return typeof v === 'bigint' ? v.toString() : (v ?? null);
    }),
  );
}

function scalarValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return String(a) === String(b);
  }
  return false;
}

function rowsEqualOnColumns(a: Row, b: Row, colsUpper: readonly string[]): boolean {
  for (const col of colsUpper) {
    if (!scalarValuesEqual(readRowCol(a, col), readRowCol(b, col))) {
      return false;
    }
  }
  return true;
}

function capIndexedVarcharFields(
  fields: readonly FieldInfo[],
  indexedColsUpper: ReadonlySet<string>,
): FieldInfo[] {
  return fields.map((f) => {
    const colUpper = f.name.trim().toUpperCase();
    if (!indexedColsUpper.has(colUpper)) {
      return { ...f };
    }
    const len = f.length;
    if (len === undefined || len <= 0 || len > 255) {
      return { ...f, length: 255 };
    }
    return { ...f };
  });
}

/**
 * List all persistent materialized views recorded in `"FB_MATVIEWS$"` (`M24 Item 2`).
 */
export async function listMaterializedViewsOnDatabase(
  db: Pick<MaterializedViewDatabaseHost, 'query'>,
): Promise<MaterializedViewInfo[]> {
  if (!(await relationExists(db, DEFAULT_MATVIEWS_TABLE))) {
    return [];
  }
  const res = await db.query<Row>(
    `SELECT "VIEW_NAME", "SELECT_SQL", "PRIMARY_KEY_JSON", "INDEXES_JSON", ` +
      `"REFRESH_STRATEGY", "WATCH_TABLES_JSON", "INTERVAL_MS", "ROW_COUNT", ` +
      `"LAST_REFRESHED_AT", "LAST_DURATION_MS" ` +
      `FROM "${DEFAULT_MATVIEWS_TABLE}" ORDER BY "VIEW_NAME"`,
  );
  return res.rows.map((r) => {
    const pkJson = String(readRowCol(r, 'PRIMARY_KEY_JSON') ?? '[]');
    const idxJson = String(readRowCol(r, 'INDEXES_JSON') ?? '[]');
    const watchJson = String(readRowCol(r, 'WATCH_TABLES_JSON') ?? '[]');
    const intervalVal = readRowCol(r, 'INTERVAL_MS');
    return {
      name: String(readRowCol(r, 'VIEW_NAME') ?? '').trim(),
      selectSql: String(readRowCol(r, 'SELECT_SQL') ?? ''),
      primaryKey: JSON.parse(pkJson) as string[],
      indexes: JSON.parse(idxJson) as string[][],
      refreshStrategy: (String(
        readRowCol(r, 'REFRESH_STRATEGY') ?? 'manual',
      ).trim() || 'manual') as MaterializedViewRefreshStrategy,
      watchTables: JSON.parse(watchJson) as string[],
      intervalMs:
        intervalVal === null || intervalVal === undefined ? null : Number(intervalVal),
      rowCount: Number(readRowCol(r, 'ROW_COUNT') ?? 0),
      lastRefreshedAt: Number(readRowCol(r, 'LAST_REFRESHED_AT') ?? 0),
      lastDurationMs: Number(readRowCol(r, 'LAST_DURATION_MS') ?? 0),
    };
  });
}

/**
 * Create (or attach/recreate) a persistent Firebird materialized view backed by a
 * real indexed Firebird table and `"FB_MATVIEWS$"` catalog metadata (`M24 Item 2`).
 */
export async function createMaterializedViewOnDatabase<T extends Row = Row>(
  db: MaterializedViewDatabaseHost,
  name: string,
  selectSql: string | SqlFragment,
  options: MaterializedViewOptions = {},
): Promise<MaterializedViewHandle<T>> {
  const viewName = normalizeUpperIdent(name, 'Materialized view name');
  if (viewName === DEFAULT_MATVIEWS_TABLE) {
    throw new Error(`Reserved materialized view name: ${viewName}`);
  }
  const sqlText = toStatement(selectSql).sql.trim();
  if (!sqlText) {
    throw new Error('Materialized view selectSql must not be empty');
  }

  const pkCols: string[] =
    typeof options.primaryKey === 'string'
      ? [normalizeUpperIdent(options.primaryKey, 'primaryKey')]
      : Array.isArray(options.primaryKey)
        ? options.primaryKey.map((c) => normalizeUpperIdent(c, 'primaryKey'))
        : [];

  const normalizedIndexes: string[][] = (options.indexes ?? []).map((idxDef) =>
    typeof idxDef === 'string'
      ? [normalizeUpperIdent(idxDef, 'index column')]
      : idxDef.map((c) => normalizeUpperIdent(c, 'index column')),
  );

  const refreshStrategy: MaterializedViewRefreshStrategy =
    options.refreshStrategy ?? 'manual';

  const inferredWatchTables = options.watchTables
    ? options.watchTables.map((t) => normalizeUpperIdent(t, 'watchTable'))
    : extractReferencedTables(sqlText)
        .map((t) => t.trim().toUpperCase())
        .filter((t) => Boolean(t) && t !== viewName && t !== DEFAULT_MATVIEWS_TABLE);
  const watchTables = [...new Set(inferredWatchTables)];
  const watchSet = new Set(watchTables);
  const intervalMs =
    refreshStrategy === 'interval' ? Math.max(25, Math.floor(options.intervalMs ?? 5_000)) : null;

  await ensureMatViewsCatalogTable(db);

  const desc = await db.describeQuery(sqlText);
  if (desc.fields.length === 0) {
    throw new Error(`Materialized view '${viewName}' SELECT query produced 0 output columns`);
  }

  const allIndexedUpper = new Set<string>(pkCols);
  for (const cols of normalizedIndexes) {
    for (const c of cols) allIndexedUpper.add(c);
  }
  const safeFields = capIndexedVarcharFields(desc.fields, allIndexedUpper);
  const colNamesUpper = safeFields.map((f) => f.name.trim().toUpperCase());

  for (const pk of pkCols) {
    if (!colNamesUpper.includes(pk)) {
      throw new Error(
        `Materialized view '${viewName}' primaryKey column '${pk}' not found in SELECT columns (${colNamesUpper.join(', ')})`,
      );
    }
  }

  const replaceExisting = options.replaceExisting ?? true;
  const existsAlready = await relationExists(db, viewName);

  if (existsAlready && replaceExisting) {
    await db.execute(`DROP TABLE ${quoteTableIdent(viewName)}`);
  }

  if (!existsAlready || replaceExisting) {
    const createDdl = buildCreateTableDdlFromColumnar(viewName, safeFields, {
      primaryKey: pkCols,
    });
    await db.execute(createDdl);

    for (let i = 0; i < normalizedIndexes.length; i++) {
      const idxCols = normalizedIndexes[i]!;
      const idxName = `IDX_${viewName.slice(0, 18)}_${i + 1}`;
      const colListSql = idxCols.map((c) => quoteTableIdent(c)).join(', ');
      await db.execute(
        `CREATE INDEX ${quoteTableIdent(idxName)} ON ${quoteTableIdent(viewName)} (${colListSql})`,
      );
    }
  }

  let currentRowCount = 0;
  let lastRefreshedAt = 0;
  let disposed = false;
  let refreshQueue: Promise<MaterializedViewRefreshResult> | null = null;
  let scheduledAutoRefresh = false;

  const persistMetadata = async (
    rowCount: number,
    refreshedAt: number,
    durationMs: number,
  ): Promise<void> => {
    await db.execute(
      `UPDATE OR INSERT INTO "${DEFAULT_MATVIEWS_TABLE}" (` +
        `"VIEW_NAME", "SELECT_SQL", "PRIMARY_KEY_JSON", "INDEXES_JSON", ` +
        `"REFRESH_STRATEGY", "WATCH_TABLES_JSON", "INTERVAL_MS", ` +
        `"ROW_COUNT", "LAST_REFRESHED_AT", "LAST_DURATION_MS"` +
        `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) MATCHING ("VIEW_NAME")`,
      [
        viewName,
        sqlText,
        JSON.stringify(pkCols),
        JSON.stringify(normalizedIndexes),
        refreshStrategy,
        JSON.stringify(watchTables),
        intervalMs,
        rowCount,
        refreshedAt,
        durationMs,
      ],
    );
  };

  const insertRowsBatched = async (rows: readonly Row[]): Promise<void> => {
    if (rows.length === 0) return;
    const colsSql = colNamesUpper.map((c) => quoteTableIdent(c)).join(', ');
    const placeholders = colNamesUpper.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${quoteTableIdent(viewName)} (${colsSql}) VALUES (${placeholders})`;
    const paramRows: QueryParams[] = rows.map(
      (r) => colNamesUpper.map((c) => readRowCol(r, c) ?? null) as QueryParams,
    );
    await db.execBatch(insertSql, paramRows);
  };

  const performRefreshInternal = async (
    mode: MaterializedViewRefreshMode,
  ): Promise<MaterializedViewRefreshResult> => {
    if (mode === 'diff' && pkCols.length === 0) {
      throw new Error(
        `Materialized view '${viewName}' cannot run 'diff' refresh without a configured primaryKey`,
      );
    }
    const started = performance.now();
    if (mode === 'full') {
        const previousCount = currentRowCount;
        await db.execute(`DELETE FROM ${quoteTableIdent(viewName)}`);
        let nextCount = 0;
        if (typeof db.queryArrow === 'function' && typeof db.loadArrowIpc === 'function') {
          const arrowBytes = await db.queryArrow(sqlText);
          const ingestRes = await db.loadArrowIpc(viewName, arrowBytes, {
            createTable: false,
          });
          nextCount = ingestRes.rowsIngested;
        } else {
          const qRes = await db.query<Row>(sqlText);
          await insertRowsBatched(qRes.rows);
          nextCount = qRes.rows.length;
        }
        const refreshedAt = Date.now();
        const durationMs = performance.now() - started;
        currentRowCount = nextCount;
        lastRefreshedAt = refreshedAt;
        await persistMetadata(nextCount, refreshedAt, durationMs);
        return {
          mode: 'full',
          rowCount: nextCount,
          inserted: nextCount,
          updated: 0,
          deleted: previousCount,
          durationMs,
          refreshedAt,
        };
      }

      // Keyed 'diff' refresh
      const [nextRes, curRes] = await Promise.all([
        db.query<Row>(sqlText),
        db.query<Row>(`SELECT * FROM ${quoteTableIdent(viewName)}`),
      ]);

      const curMap = new Map<string, Row>();
      for (const r of curRes.rows) {
        curMap.set(serializePkKey(r, pkCols), r);
      }

      const pkSet = new Set(pkCols);
      const nonPkCols = colNamesUpper.filter((c) => !pkSet.has(c));

      const toInsert: Row[] = [];
      const toUpdate: Row[] = [];

      for (const nextRow of nextRes.rows) {
        const key = serializePkKey(nextRow, pkCols);
        const existing = curMap.get(key);
        if (!existing) {
          toInsert.push(nextRow);
        } else {
          curMap.delete(key);
          if (nonPkCols.length > 0 && !rowsEqualOnColumns(existing, nextRow, nonPkCols)) {
            toUpdate.push(nextRow);
          }
        }
      }

      const toDelete = [...curMap.values()];
      const pkWhereSql = pkCols.map((c) => `${quoteTableIdent(c)} = ?`).join(' AND ');

      if (toDelete.length > 0) {
        const delSql = `DELETE FROM ${quoteTableIdent(viewName)} WHERE ${pkWhereSql}`;
        const delParams: QueryParams[] = toDelete.map(
          (r) => pkCols.map((c) => readRowCol(r, c) ?? null) as QueryParams,
        );
        await db.execBatch(delSql, delParams);
      }

      if (toUpdate.length > 0 && nonPkCols.length > 0) {
        const setSql = nonPkCols.map((c) => `${quoteTableIdent(c)} = ?`).join(', ');
        const updSql = `UPDATE ${quoteTableIdent(viewName)} SET ${setSql} WHERE ${pkWhereSql}`;
        const updParams: QueryParams[] = toUpdate.map(
          (r) =>
            [
              ...nonPkCols.map((c) => readRowCol(r, c) ?? null),
              ...pkCols.map((c) => readRowCol(r, c) ?? null),
            ] as QueryParams,
        );
        await db.execBatch(updSql, updParams);
      }

      if (toInsert.length > 0) {
        await insertRowsBatched(toInsert);
      }

      const refreshedAt = Date.now();
      const durationMs = performance.now() - started;
      currentRowCount = nextRes.rows.length;
      lastRefreshedAt = refreshedAt;
      await persistMetadata(currentRowCount, refreshedAt, durationMs);

      return {
        mode: 'diff',
        rowCount: currentRowCount,
        inserted: toInsert.length,
        updated: toUpdate.length,
        deleted: toDelete.length,
        durationMs,
        refreshedAt,
      };
  };

  const enqueueRefresh = (
    mode: MaterializedViewRefreshMode,
  ): Promise<MaterializedViewRefreshResult> => {
    const run = (refreshQueue ?? Promise.resolve()).then(
      () => performRefreshInternal(mode),
      () => performRefreshInternal(mode),
    );
    refreshQueue = run;
    return run;
  };

  if (!existsAlready || replaceExisting) {
    await enqueueRefresh('full');
  } else {
    const cntRes = await db.query<Row>(
      `SELECT COUNT(*) AS CNT FROM ${quoteTableIdent(viewName)}`,
    );
    currentRowCount = Number(readRowCol(cntRes.rows[0] ?? {}, 'CNT') ?? 0);
    lastRefreshedAt = Date.now();
    await persistMetadata(currentRowCount, lastRefreshedAt, 0);
  }

  let unsubOnQuery: (() => void) | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  if (refreshStrategy === 'on-commit' && watchSet.size > 0) {
    unsubOnQuery = db.onQuery((event) => {
      if (disposed || event.error !== undefined) return;
      const mutated = extractMutatedTables(event.sql).map((t) => t.toUpperCase());
      if (mutated.length === 0) return;
      const touchesWatched = mutated.some(
        (t) => t !== viewName && t !== DEFAULT_MATVIEWS_TABLE && watchSet.has(t),
      );
      if (!touchesWatched || scheduledAutoRefresh) return;
      scheduledAutoRefresh = true;
      queueMicrotask(() => {
        scheduledAutoRefresh = false;
        if (disposed) return;
        const defaultMode: MaterializedViewRefreshMode =
          pkCols.length > 0 ? 'diff' : 'full';
        void enqueueRefresh(defaultMode).catch(() => undefined);
      });
    });
  } else if (refreshStrategy === 'interval' && intervalMs !== null) {
    intervalTimer = setInterval(() => {
      if (disposed) return;
      const defaultMode: MaterializedViewRefreshMode =
        pkCols.length > 0 ? 'diff' : 'full';
      void enqueueRefresh(defaultMode).catch(() => undefined);
    }, intervalMs);
    if (typeof (intervalTimer as { unref?: () => void }).unref === 'function') {
      (intervalTimer as { unref: () => void }).unref();
    }
  }

  const stopWatchers = (): void => {
    disposed = true;
    if (unsubOnQuery) {
      unsubOnQuery();
      unsubOnQuery = null;
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };

  return {
    name: viewName,
    selectSql: sqlText,
    fields: safeFields,
    primaryKey: pkCols,
    refreshStrategy,
    watchTables,
    get rowCount() {
      return currentRowCount;
    },
    get lastRefreshedAt() {
      return lastRefreshedAt;
    },
    refresh(refreshOpts = {}) {
      const mode: MaterializedViewRefreshMode =
        refreshOpts.mode ?? (pkCols.length > 0 ? 'diff' : 'full');
      return enqueueRefresh(mode);
    },
    query(whereSql?: string, params: QueryParams = []) {
      const clause = whereSql?.trim();
      const q = clause
        ? `SELECT * FROM ${quoteTableIdent(viewName)} WHERE ${clause}`
        : `SELECT * FROM ${quoteTableIdent(viewName)}`;
      return db.query<T>(q, params);
    },
    liveIncremental(optionsOrListener, maybeListener) {
      const defaultKey =
        pkCols.length === 1 ? pkCols[0] : pkCols.length > 1 ? pkCols : undefined;
      if (typeof optionsOrListener === 'function') {
        return db.liveIncremental<T>(
          `SELECT * FROM ${quoteTableIdent(viewName)}`,
          defaultKey ? { key: defaultKey } : {},
          optionsOrListener,
        );
      }
      const mergedOpts: LiveIncrementalOptions<T> = {
        ...(defaultKey ? { key: defaultKey } : {}),
        ...(optionsOrListener ?? {}),
      };
      return db.liveIncremental<T>(
        `SELECT * FROM ${quoteTableIdent(viewName)}`,
        mergedOpts,
        maybeListener,
      );
    },
    async dispose() {
      stopWatchers();
      if (refreshQueue) {
        await refreshQueue.catch(() => undefined);
      }
    },
    async drop() {
      stopWatchers();
      if (refreshQueue) {
        await refreshQueue.catch(() => undefined);
      }
      if (await relationExists(db, DEFAULT_MATVIEWS_TABLE)) {
        await db.execute(
          `DELETE FROM "${DEFAULT_MATVIEWS_TABLE}" WHERE "VIEW_NAME" = ?`,
          [viewName],
        );
      }
      if (await relationExists(db, viewName)) {
        await db.execute(`DROP TABLE ${quoteTableIdent(viewName)}`);
      }
    },
    async [Symbol.asyncDispose]() {
      stopWatchers();
      if (refreshQueue) {
        await refreshQueue.catch(() => undefined);
      }
    },
  };
}
