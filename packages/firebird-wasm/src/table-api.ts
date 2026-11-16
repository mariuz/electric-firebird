/**
 * table-api.ts – Zero-Boilerplate Typed Table & Upsert Repository API
 * (`db.table<T>(name, options?)` & `tx.table<T>(name, options?)`) (`M21 Item 3`).
 */

import type { PreparedStatement, QueryParams, QueryResult, Row } from './types';
import { isSqlFragment, toStatement, type SqlFragment } from './sql-tag';
import {
  validateRowsWithSchema,
  type StandardSchemaV1,
} from './schema-validation';
import type {
  IncrementalLiveSnapshot,
  LiveIncrementalOptions,
  LiveIncrementalQuery,
} from './live-incremental';
import {
  loadArrowIpcIntoDatabase,
  type ArrowIngestHost,
  type ArrowIngestResult,
  type ArrowIngestSource,
  type LoadArrowIpcOptions,
} from './arrow-ingest';

const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Quote a Firebird SQL identifier safely, upper-casing unquoted standard identifiers (`M21 Item 3`). */
export function quoteTableIdent(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Identifier must not be empty');
  }
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
      ? trimmed.slice(1, -1).replace(/""/g, '"')
      : SAFE_IDENT_RE.test(trimmed)
        ? trimmed.toUpperCase()
        : trimmed;
  return `"${unquoted.replace(/"/g, '""')}"`;
}

function normalizeColName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return SAFE_IDENT_RE.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

/** Equality filter map or raw `SqlFragment` accepted by `table.findMany` / `count` / `updateWhere` / `deleteWhere` (`M21 Item 3`). */
export type TableWhereFilter<T = Row> =
  | Partial<Record<keyof T & string, unknown>>
  | Record<string, unknown>
  | SqlFragment;

/** Sort specification accepted by `table.findMany` / `table.findPage` (`M21 Item 3`). */
export type TableOrderBySpec<T = Row> =
  | (keyof T & string)
  | string
  | ReadonlyArray<
      | (keyof T & string)
      | string
      | { readonly column: (keyof T & string) | string; readonly direction?: 'ASC' | 'DESC' }
    >;

/** Options for `db.table<T>(name, options)` (`M21 Item 3`). */
export interface TableOptions<T = Row> {
  /** Primary key column (`'ID'` by default) or composite primary key column list. @default 'ID' */
  primaryKey?: (keyof T & string) | string | ReadonlyArray<(keyof T & string) | string>;
  /** Optional Standard Schema v1 validator (`zod`, `valibot`, `arktype`, `createRowSchema`) applied to returned rows. */
  schema?: StandardSchemaV1<unknown, T>;
  /** Optional input validator applied before `insert` / `upsert` writes. */
  writeSchema?: StandardSchemaV1<unknown, Record<string, unknown>>;
  /**
   * Cache compiled `PreparedStatement` handles for hot CRUD templates (`get`,
   * `exists`, `count`, `insert`, `upsert`, `update`, `delete`) in a bounded LRU
   * cache when `host.prepare()` is available (`M22 Item 2`).
   *
   * Pass `true` (default, max `16` statements), `false` to disable, or a positive
   * integer to configure the bounded LRU capacity.
   *
   * @default true
   */
  cacheStatements?: boolean | number;
}

/** Query options for `table.findMany()` / `table.findOne()` (`M21 Item 3`). */
export interface TableFindOptions<T = Row> {
  where?: TableWhereFilter<T>;
  orderBy?: TableOrderBySpec<T>;
  limit?: number;
  offset?: number;
  /** Keyset pagination cursor (`{ ID: lastSeenId }`) advancing strictly past `cursor` along `orderBy`. */
  cursor?: Readonly<Record<string, unknown>>;
  /** Projected column subset (defaults to `*`). */
  columns?: ReadonlyArray<(keyof T & string) | string>;
}

/** Result page returned by `table.findPage()` (`M21 Item 3`). */
export interface TablePageResult<T = Row> {
  readonly rows: T[];
  readonly hasMore: boolean;
  readonly nextCursor: Record<string, unknown> | null;
}

/** Minimal execution host required by {@link createTableRepository} (`FirebirdBrowser`, `FirebirdLite`, `tx`, or `ReplicaRouter`). */
export interface TableExecutionHost {
  query<R extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { schema?: StandardSchemaV1<unknown, R> },
  ): Promise<QueryResult<R>>;
  execute(
    sql: string | SqlFragment,
    params?: QueryParams,
  ): Promise<{ affectedRows: number }>;
  execBatch(
    sql: string,
    rows: QueryParams[],
  ): Promise<{ affectedRows: number } | void>;
  execWireBatch?(
    sql: string,
    wireRows: Uint8Array,
    rowCount: number,
  ): Promise<{ affectedRows: number }>;
  prepare?(sql: string | SqlFragment): Promise<PreparedStatement>;
  loadArrowIpc?(
    tableName: string,
    source: ArrowIngestSource,
    options?: LoadArrowIpcOptions,
  ): Promise<ArrowIngestResult>;
  liveIncremental?<R extends Row = Row>(
    sql: string | SqlFragment,
    optionsOrListener?:
      | LiveIncrementalOptions<R>
      | ((snapshot: IncrementalLiveSnapshot<R>) => void),
    maybeListener?: (snapshot: IncrementalLiveSnapshot<R>) => void,
  ): Promise<LiveIncrementalQuery<R>>;
}

/** Fluent typed repository returned by `db.table<T>(name)` / `tx.table<T>(name)` (`M21 Item 3`). */
export interface TableRepository<T extends Row = Row, K = unknown> {
  readonly tableName: string;
  readonly primaryKey: readonly string[];
  /** Fetch a single row by primary key value (scalar for single-PK tables, or `{ col: val }` object for composite PKs). */
  get(key: K): Promise<T | null>;
  /** Fetch the first row matching `options` (`FETCH FIRST 1 ROWS ONLY`), or `null`. */
  findOne(options?: Omit<TableFindOptions<T>, 'limit'>): Promise<T | null>;
  /** Fetch all rows matching `options` (`where`, `orderBy`, `limit`, `offset`, `cursor`, `columns`). */
  findMany(options?: TableFindOptions<T>): Promise<T[]>;
  /** Keyset-paginated query returning `{ rows, hasMore, nextCursor }` with deterministic PK tie-breaking. */
  findPage(options?: Omit<TableFindOptions<T>, 'offset'>): Promise<TablePageResult<T>>;
  /** Count rows matching optional `where`. */
  count(where?: TableWhereFilter<T>): Promise<number>;
  /** Return `true` when a row with `key` (or matching `where`) exists. */
  exists(keyOrWhere: K | TableWhereFilter<T>): Promise<boolean>;
  /** Insert a single row (`INSERT INTO ... RETURNING *`) and return the inserted row. */
  insert(row: Partial<T> & Record<string, unknown>): Promise<T>;
  /** Bulk-insert rows in a single prepared `IBatch` (`execBatch`). */
  insertMany(rows: ReadonlyArray<Partial<T> & Record<string, unknown>>): Promise<{ affectedRows: number }>;
  /** Atomic Firebird `UPDATE OR INSERT INTO ... MATCHING (...) RETURNING *`. */
  upsert(
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<T>;
  /** Batched Firebird `UPDATE OR INSERT INTO ... MATCHING (...)` across many rows via `IBatch`. */
  upsertMany(
    rows: ReadonlyArray<Partial<T> & Record<string, unknown>>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<{ affectedRows: number }>;
  /** Update a single row by primary key. */
  update(
    key: K,
    patch: Partial<T> & Record<string, unknown>,
  ): Promise<{ affectedRows: number }>;
  /** Update all rows matching `where`. */
  updateWhere(
    where: TableWhereFilter<T>,
    patch: Partial<T> & Record<string, unknown>,
  ): Promise<{ affectedRows: number }>;
  /** Delete a single row by primary key. */
  delete(key: K): Promise<{ affectedRows: number }>;
  /** Delete all rows matching `where`. */
  deleteWhere(where: TableWhereFilter<T>): Promise<{ affectedRows: number }>;
  /** Subscribe to reactive incremental `{ rows, deltas }` updates for this table (`M20 Item 3` + `M21 Item 3`). */
  liveIncremental(
    options?: Omit<TableFindOptions<T>, 'offset' | 'cursor'> &
      Omit<LiveIncrementalOptions<T>, 'key' | 'params' | 'schema'>,
    listener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
  ): Promise<LiveIncrementalQuery<T>>;
  /** Zero-copy bulk insert from an Apache Arrow IPC V5 payload, `ColumnarQueryResult`, `ReadableStream`, or `AsyncIterable` (`M22 Item 2`). */
  insertArrow(
    source: ArrowIngestSource,
    options?: Omit<LoadArrowIpcOptions, 'upsertMatching'>,
  ): Promise<ArrowIngestResult>;
  /** Zero-copy bulk upsert (`UPDATE OR INSERT ... MATCHING (...)`) from an Apache Arrow IPC V5 payload or stream (`M22 Item 2`). */
  upsertArrow(
    source: ArrowIngestSource,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
    options?: Omit<LoadArrowIpcOptions, 'upsertMatching'>,
  ): Promise<ArrowIngestResult>;
  /** Number of compiled `PreparedStatement` handles currently retained in this repository's LRU cache (`M22 Item 2`). */
  readonly cachedStatementCount: number;
  /** Close and evict all cached `PreparedStatement` handles held by this repository (`M22 Item 2`). */
  close(): Promise<void>;
  /** Async disposal (`await using users = db.table('USERS')`) (`M22 Item 2`). */
  [Symbol.asyncDispose](): Promise<void>;
}

function getRowFieldCaseInsensitive(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

function compileWhereClause<T>(
  where: TableWhereFilter<T> | undefined,
): { clause: string; params: QueryParams } {
  if (!where) return { clause: '', params: [] };
  if (isSqlFragment(where)) {
    const stmt = toStatement(where);
    const trimmed = stmt.sql.trim();
    if (!trimmed) return { clause: '', params: [] };
    return {
      clause: /^WHERE\b/i.test(trimmed) ? trimmed : `WHERE ${trimmed}`,
      params: stmt.params,
    };
  }
  const entries = Object.entries(where as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return { clause: '', params: [] };
  const predicates: string[] = [];
  const params: QueryParams = [];
  for (const [col, val] of entries) {
    const qCol = quoteTableIdent(col);
    if (val === null) {
      predicates.push(`${qCol} IS NULL`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        predicates.push('1 = 0');
      } else {
        predicates.push(`${qCol} IN (${val.map(() => '?').join(', ')})`);
        params.push(...val);
      }
    } else {
      predicates.push(`${qCol} = ?`);
      params.push(val);
    }
  }
  return { clause: `WHERE ${predicates.join(' AND ')}`, params };
}

function normalizeOrderItems<T>(
  orderBy: TableOrderBySpec<T> | undefined,
  pkCols: readonly string[],
  ensurePkTieBreaker = false,
): Array<{ column: string; direction: 'ASC' | 'DESC' }> {
  const out: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];
  if (typeof orderBy === 'string') {
    const parts = orderBy.trim().split(/\s+/);
    const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    out.push({ column: normalizeColName(parts[0]!), direction: dir });
  } else if (Array.isArray(orderBy)) {
    for (const item of orderBy) {
      if (typeof item === 'string') {
        const parts = item.trim().split(/\s+/);
        const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        out.push({ column: normalizeColName(parts[0]!), direction: dir });
      } else {
        out.push({
          column: normalizeColName(item.column),
          direction: item.direction === 'DESC' ? 'DESC' : 'ASC',
        });
      }
    }
  }

  if (ensurePkTieBreaker) {
    const seen = new Set(out.map((o) => o.column.toUpperCase()));
    const fallbackDir = out[0]?.direction ?? 'ASC';
    for (const pk of pkCols) {
      if (!seen.has(pk.toUpperCase())) {
        out.push({ column: pk, direction: fallbackDir });
      }
    }
  }
  return out;
}

function compileKeyPredicate(
  pkCols: readonly string[],
  key: unknown,
): { clause: string; params: QueryParams } {
  if (pkCols.length === 1) {
    const col = pkCols[0]!;
    const val =
      typeof key === 'object' &&
      key !== null &&
      !(key instanceof Uint8Array) &&
      !(key instanceof Date)
        ? getRowFieldCaseInsensitive(key as Record<string, unknown>, col)
        : key;
    return { clause: `WHERE ${quoteTableIdent(col)} = ?`, params: [val] };
  }
  if (typeof key !== 'object' || key === null) {
    throw new TypeError(
      `Composite primary key (${pkCols.join(', ')}) requires an object key`,
    );
  }
  const rec = key as Record<string, unknown>;
  const parts: string[] = [];
  const params: QueryParams = [];
  for (const col of pkCols) {
    parts.push(`${quoteTableIdent(col)} = ?`);
    params.push(getRowFieldCaseInsensitive(rec, col));
  }
  return { clause: `WHERE ${parts.join(' AND ')}`, params };
}

function compileCursorCondition(
  orderItems: ReadonlyArray<{ column: string; direction: 'ASC' | 'DESC' }>,
  cursor: Readonly<Record<string, unknown>>,
): { sql: string; params: QueryParams } {
  // Lexicographic tuple comparison expanded to standard SQL for Firebird 3/4/5/6:
  // For (A ASC, B ASC): (A > :a) OR (A = :a AND B > :b)
  const disjuncts: string[] = [];
  const params: QueryParams = [];

  for (let i = 0; i < orderItems.length; i++) {
    const eqParts: string[] = [];
    for (let j = 0; j < i; j++) {
      const prev = orderItems[j]!;
      const prevVal = getRowFieldCaseInsensitive(cursor, prev.column);
      eqParts.push(`${quoteTableIdent(prev.column)} = ?`);
      params.push(prevVal);
    }
    const cur = orderItems[i]!;
    const curVal = getRowFieldCaseInsensitive(cursor, cur.column);
    const cmp = cur.direction === 'DESC' ? '<' : '>';
    eqParts.push(`${quoteTableIdent(cur.column)} ${cmp} ?`);
    params.push(curVal);
    disjuncts.push(eqParts.length === 1 ? eqParts[0]! : `(${eqParts.join(' AND ')})`);
  }

  return {
    sql: disjuncts.length === 1 ? disjuncts[0]! : `(${disjuncts.join(' OR ')})`,
    params,
  };
}

/**
 * Create a fluent typed {@link TableRepository} bound to `host` (`M21 Item 3`).
 */
export function createTableRepository<T extends Row = Row, K = unknown>(
  host: TableExecutionHost,
  tableName: string,
  options: TableOptions<T> = {},
): TableRepository<T, K> {
  const quotedTable = quoteTableIdent(tableName);
  const rawPk = options.primaryKey ?? 'ID';
  const pkCols: readonly string[] = Array.isArray(rawPk)
    ? rawPk.map((c) => normalizeColName(String(c)))
    : [normalizeColName(String(rawPk))];
  if (pkCols.length === 0) {
    throw new Error(`Table "${tableName}": primaryKey must name at least one column`);
  }

  const validateOutput = async (rows: Row[]): Promise<T[]> => {
    if (!options.schema) return rows as T[];
    return validateRowsWithSchema(options.schema, rows);
  };

  const validateWriteRow = async (
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (!options.writeSchema) return row;
    const [validated] = await validateRowsWithSchema(options.writeSchema, [row]);
    return validated!;
  };

  const buildSelectSql = (
    findOpts: TableFindOptions<T> = {},
    ensurePkOrder = false,
  ): {
    sql: string;
    params: QueryParams;
    orderItems: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  } => {
    const colSelect =
      findOpts.columns && findOpts.columns.length > 0
        ? findOpts.columns.map((c) => quoteTableIdent(String(c))).join(', ')
        : '*';
    const baseWhere = compileWhereClause(findOpts.where);
    const orderItems = normalizeOrderItems(
      findOpts.orderBy,
      pkCols,
      ensurePkOrder || Boolean(findOpts.cursor),
    );

    const predicates: string[] = [];
    const params: QueryParams = [...baseWhere.params];
    if (baseWhere.clause) {
      predicates.push(baseWhere.clause.replace(/^WHERE\s+/i, ''));
    }
    if (findOpts.cursor && orderItems.length > 0) {
      const cursorPred = compileCursorCondition(orderItems, findOpts.cursor);
      predicates.push(cursorPred.sql);
      params.push(...cursorPred.params);
    }

    let sql = `SELECT ${colSelect} FROM ${quotedTable}`;
    if (predicates.length > 0) {
      sql += ` WHERE ${predicates.join(' AND ')}`;
    }
    if (orderItems.length > 0) {
      sql +=
        ' ORDER BY ' +
        orderItems.map((o) => `${quoteTableIdent(o.column)} ${o.direction}`).join(', ');
    }
    if (findOpts.offset !== undefined && findOpts.offset > 0) {
      sql += ` OFFSET ${Math.floor(findOpts.offset)} ROWS`;
    }
    if (findOpts.limit !== undefined && findOpts.limit >= 0) {
      sql += ` FETCH FIRST ${Math.floor(findOpts.limit)} ROWS ONLY`;
    }
    return { sql, params, orderItems };
  };

  // Bounded LRU PreparedStatement handle cache (`M22 Item 2`)
  const maxCachedStmts =
    options.cacheStatements === false || typeof host.prepare !== 'function'
      ? 0
      : typeof options.cacheStatements === 'number'
        ? Math.max(0, Math.floor(options.cacheStatements))
        : 16;
  const stmtCache = new Map<string, Promise<PreparedStatement>>();

  const acquirePrepared = async (sqlText: string): Promise<PreparedStatement | null> => {
    if (maxCachedStmts <= 0 || typeof host.prepare !== 'function') {
      return null;
    }
    const existing = stmtCache.get(sqlText);
    if (existing) {
      stmtCache.delete(sqlText);
      stmtCache.set(sqlText, existing);
      const stmt = await existing;
      if (!stmt.closed) {
        return stmt;
      }
      stmtCache.delete(sqlText);
    }
    while (stmtCache.size >= maxCachedStmts) {
      const oldestKey = stmtCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = stmtCache.get(oldestKey);
      stmtCache.delete(oldestKey);
      if (evicted) {
        void evicted.then((s) => s.close()).catch(() => undefined);
      }
    }
    const createdPromise = host.prepare(sqlText).catch((err) => {
      stmtCache.delete(sqlText);
      throw err;
    });
    stmtCache.set(sqlText, createdPromise);
    return createdPromise;
  };

  const runCachedQuery = async (
    sqlText: string,
    params: QueryParams,
  ): Promise<QueryResult<Row>> => {
    const stmt = await acquirePrepared(sqlText);
    if (stmt) {
      return stmt.query<Row>(params);
    }
    return host.query<Row>(sqlText, params);
  };

  const runCachedExec = async (
    sqlText: string,
    params: QueryParams,
  ): Promise<{ affectedRows: number }> => {
    const stmt = await acquirePrepared(sqlText);
    if (stmt) {
      return stmt.exec(params);
    }
    return host.execute(sqlText, params);
  };

  const closeCachedStatements = async (): Promise<void> => {
    const pending = [...stmtCache.values()];
    stmtCache.clear();
    await Promise.all(
      pending.map((p) =>
        p.then((s) => s.close().catch(() => undefined)).catch(() => undefined),
      ),
    );
  };

  return {
    tableName: normalizeColName(tableName),
    primaryKey: pkCols,

    get cachedStatementCount(): number {
      return stmtCache.size;
    },

    async close(): Promise<void> {
      await closeCachedStatements();
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await closeCachedStatements();
    },

    async get(key: K): Promise<T | null> {
      const { clause, params } = compileKeyPredicate(pkCols, key);
      const res = await runCachedQuery(
        `SELECT * FROM ${quotedTable} ${clause} FETCH FIRST 1 ROWS ONLY`,
        params,
      );
      if (res.rows.length === 0) return null;
      const validated = await validateOutput(res.rows);
      return validated[0] ?? null;
    },

    async findOne(findOpts = {}): Promise<T | null> {
      const rows = await this.findMany({ ...findOpts, limit: 1 });
      return rows[0] ?? null;
    },

    async findMany(findOpts = {}): Promise<T[]> {
      const { sql, params } = buildSelectSql(findOpts, false);
      const res = await host.query<Row>(sql, params);
      return validateOutput(res.rows);
    },

    async findPage(findOpts = {}): Promise<TablePageResult<T>> {
      const pageSize = Math.max(1, Math.floor(findOpts.limit ?? 50));
      const { sql, params, orderItems } = buildSelectSql(
        { ...findOpts, limit: pageSize + 1 },
        true,
      );
      const res = await host.query<Row>(sql, params);
      const hasMore = res.rows.length > pageSize;
      const rawSlice = hasMore ? res.rows.slice(0, pageSize) : res.rows;
      let nextCursor: Record<string, unknown> | null = null;
      if (hasMore && rawSlice.length > 0) {
        const lastRaw = rawSlice[rawSlice.length - 1]!;
        nextCursor = {};
        for (const o of orderItems) {
          nextCursor[o.column] = getRowFieldCaseInsensitive(lastRaw, o.column);
        }
      }
      const rows = await validateOutput(rawSlice);
      return { rows, hasMore, nextCursor };
    },

    async count(where): Promise<number> {
      const { clause, params } = compileWhereClause(where);
      const sqlText = `SELECT COUNT(*) AS CNT FROM ${quotedTable}${clause ? ' ' + clause : ''}`;
      const res = where
        ? await host.query<Row>(sqlText, params)
        : await runCachedQuery(sqlText, params);
      const first = res.rows[0];
      return Number(first?.CNT ?? first?.cnt ?? 0);
    },

    async exists(keyOrWhere): Promise<boolean> {
      const isFilterObj =
        isSqlFragment(keyOrWhere) ||
        (typeof keyOrWhere === 'object' &&
          keyOrWhere !== null &&
          !(keyOrWhere instanceof Uint8Array) &&
          !(keyOrWhere instanceof Date) &&
          (pkCols.length > 1 ||
            !pkCols.every((pk) => getRowFieldCaseInsensitive(keyOrWhere as Record<string, unknown>, pk) !== undefined)));
      const { clause, params } = isFilterObj
        ? compileWhereClause(keyOrWhere as TableWhereFilter<T>)
        : compileKeyPredicate(pkCols, keyOrWhere);
      const sqlText = `SELECT 1 AS FOUND FROM ${quotedTable}${clause ? ' ' + clause : ''} FETCH FIRST 1 ROWS ONLY`;
      const res = isFilterObj
        ? await host.query<Row>(sqlText, params)
        : await runCachedQuery(sqlText, params);
      return res.rows.length > 0;
    },

    async insert(rawRow): Promise<T> {
      const row = await validateWriteRow(rawRow);
      const entries = Object.entries(row).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        throw new Error(`Table "${tableName}".insert(): row must specify at least one column`);
      }
      const colsSql = entries.map(([c]) => quoteTableIdent(c)).join(', ');
      const placeholders = entries.map(() => '?').join(', ');
      const params = entries.map(([, v]) => v);
      const res = await runCachedQuery(
        `INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders}) RETURNING *`,
        params,
      );
      const validated = await validateOutput(res.rows);
      return validated[0]!;
    },

    async insertMany(rawRows): Promise<{ affectedRows: number }> {
      if (rawRows.length === 0) return { affectedRows: 0 };
      const validatedRows: Record<string, unknown>[] = [];
      for (const r of rawRows) {
        validatedRows.push(await validateWriteRow(r));
      }
      const colNames = Object.keys(validatedRows[0]!).filter(
        (c) => validatedRows[0]![c] !== undefined,
      );
      const colsSql = colNames.map((c) => quoteTableIdent(c)).join(', ');
      const placeholders = colNames.map(() => '?').join(', ');
      const paramMatrix: QueryParams[] = validatedRows.map((r) =>
        colNames.map((c) => getRowFieldCaseInsensitive(r, c) ?? null),
      );
      const res = await host.execBatch(
        `INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders})`,
        paramMatrix,
      );
      return {
        affectedRows:
          typeof res === 'object' && res !== null && typeof res.affectedRows === 'number'
            ? res.affectedRows
            : rawRows.length,
      };
    },

    async upsert(rawRow, matchingColumns): Promise<T> {
      const row = await validateWriteRow(rawRow);
      const entries = Object.entries(row).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        throw new Error(`Table "${tableName}".upsert(): row must specify at least one column`);
      }
      const matchCols = (matchingColumns ?? pkCols).map((c) => quoteTableIdent(String(c)));
      const colsSql = entries.map(([c]) => quoteTableIdent(c)).join(', ');
      const placeholders = entries.map(() => '?').join(', ');
      const params = entries.map(([, v]) => v);
      const res = await runCachedQuery(
        `UPDATE OR INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders}) MATCHING (${matchCols.join(', ')}) RETURNING *`,
        params,
      );
      const validated = await validateOutput(res.rows);
      return validated[0]!;
    },

    async upsertMany(rawRows, matchingColumns): Promise<{ affectedRows: number }> {
      if (rawRows.length === 0) return { affectedRows: 0 };
      const validatedRows: Record<string, unknown>[] = [];
      for (const r of rawRows) {
        validatedRows.push(await validateWriteRow(r));
      }
      const colNames = Object.keys(validatedRows[0]!).filter(
        (c) => validatedRows[0]![c] !== undefined,
      );
      const matchCols = (matchingColumns ?? pkCols).map((c) => quoteTableIdent(String(c)));
      const colsSql = colNames.map((c) => quoteTableIdent(c)).join(', ');
      const placeholders = colNames.map(() => '?').join(', ');
      const paramMatrix: QueryParams[] = validatedRows.map((r) =>
        colNames.map((c) => getRowFieldCaseInsensitive(r, c) ?? null),
      );
      const res = await host.execBatch(
        `UPDATE OR INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders}) MATCHING (${matchCols.join(', ')})`,
        paramMatrix,
      );
      return {
        affectedRows:
          typeof res === 'object' && res !== null && typeof res.affectedRows === 'number'
            ? res.affectedRows
            : rawRows.length,
      };
    },

    async update(key, patch): Promise<{ affectedRows: number }> {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return { affectedRows: 0 };
      const setSql = entries.map(([c]) => `${quoteTableIdent(c)} = ?`).join(', ');
      const setParams = entries.map(([, v]) => v);
      const keyPred = compileKeyPredicate(pkCols, key);
      const res = await runCachedExec(
        `UPDATE ${quotedTable} SET ${setSql} ${keyPred.clause}`,
        [...setParams, ...keyPred.params],
      );
      return { affectedRows: res.affectedRows };
    },

    async updateWhere(where, patch): Promise<{ affectedRows: number }> {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return { affectedRows: 0 };
      const setSql = entries.map(([c]) => `${quoteTableIdent(c)} = ?`).join(', ');
      const setParams = entries.map(([, v]) => v);
      const wherePred = compileWhereClause(where);
      const res = await host.execute(
        `UPDATE ${quotedTable} SET ${setSql}${wherePred.clause ? ' ' + wherePred.clause : ''}`,
        [...setParams, ...wherePred.params],
      );
      return { affectedRows: res.affectedRows };
    },

    async delete(key): Promise<{ affectedRows: number }> {
      const keyPred = compileKeyPredicate(pkCols, key);
      const res = await runCachedExec(
        `DELETE FROM ${quotedTable} ${keyPred.clause}`,
        keyPred.params,
      );
      return { affectedRows: res.affectedRows };
    },

    async deleteWhere(where): Promise<{ affectedRows: number }> {
      const wherePred = compileWhereClause(where);
      const res = await host.execute(
        `DELETE FROM ${quotedTable}${wherePred.clause ? ' ' + wherePred.clause : ''}`,
        wherePred.params,
      );
      return { affectedRows: res.affectedRows };
    },

    async insertArrow(source, arrowOpts = {}): Promise<ArrowIngestResult> {
      if (typeof host.loadArrowIpc === 'function') {
        return host.loadArrowIpc(tableName, source, {
          primaryKey: pkCols,
          ...arrowOpts,
        });
      }
      return loadArrowIpcIntoDatabase(host as unknown as ArrowIngestHost, tableName, source, {
        primaryKey: pkCols,
        ...arrowOpts,
      });
    },

    async upsertArrow(source, matchingColumns, arrowOpts = {}): Promise<ArrowIngestResult> {
      const match = (matchingColumns ?? pkCols).map((c) => String(c));
      if (typeof host.loadArrowIpc === 'function') {
        return host.loadArrowIpc(tableName, source, {
          primaryKey: pkCols,
          ...arrowOpts,
          upsertMatching: match,
        });
      }
      return loadArrowIpcIntoDatabase(host as unknown as ArrowIngestHost, tableName, source, {
        primaryKey: pkCols,
        ...arrowOpts,
        upsertMatching: match,
      });
    },

    async liveIncremental(liveOpts = {}, listener): Promise<LiveIncrementalQuery<T>> {
      if (typeof host.liveIncremental !== 'function') {
        throw new Error('liveIncremental() is not available on this execution context');
      }
      const { sql, params } = buildSelectSql(liveOpts, true);
      const keyOption = pkCols.length === 1 ? pkCols[0]! : pkCols;
      return host.liveIncremental<T>(
        sql,
        {
          key: keyOption,
          params,
          schema: options.schema,
          events: liveOpts.events,
          pollIntervalMs: liveOpts.pollIntervalMs,
          emitMoves: liveOpts.emitMoves,
          emitEmptyUpdates: liveOpts.emitEmptyUpdates,
          onError: liveOpts.onError,
        },
        listener,
      );
    },
  };
}
