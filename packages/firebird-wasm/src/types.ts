/**
 * TypeScript types for FirebirdLite
 */

import type { TypeOptions } from './browser/value-types';

/**
 * Options for creating a FirebirdLite instance.
 */
export interface FirebirdLiteOptions {
  /** Path to the Firebird client library. Defaults to the system default. */
  libraryPath?: string;
  /**
   * Character set for `NONE`-charset columns/parameters.
   * Passed as `charSetForNONE` to the underlying driver.
   */
  charset?: string;
  /** Firebird user name. Defaults to 'SYSDBA'. */
  username?: string;
  /** Firebird user password. */
  password?: string;
  /**
   * Run `query()` calls that are a `SELECT` in one read-only READ COMMITTED
   * transaction kept open, instead of starting and committing a transaction
   * around each. The browser backend's option of the same name; see
   * `FirebirdBrowserOptions.sharedReads` for the two things that differ.
   * A call that passes `isolationLevel` or `readOnly` keeps its own.
   *
   * @default false
   */
  sharedReads?: boolean;
  /**
   * How many prepared statements to keep by their SQL text, so a statement
   * sent again skips the prepare (a round trip to the server). DDL run here
   * empties the cache first. 0 keeps none.
   *
   * Off by default because what this connection keeps, other connections
   * feel: a kept statement makes another connection's `DROP TABLE` of a table
   * it reads wait until it is released, and keeps running a procedure's old
   * body after another connection alters it. Turn it on where this process
   * is the only one changing the schema while it runs.
   *
   * @default 0
   */
  statementCache?: number;
  /**
   * Opt-in conversions from the wire types (`string` for exact numbers and
   * dates, base64 for binary BLOBs) to `bigint`, `Date` and `Uint8Array`,
   * plus custom `parsers` and `serializers`.
   *
   * Everything defaults to off. See {@link TypeOptions} for what each
   * conversion trades away.
   */
  types?: TypeOptions;
}

/**
 * Result returned from a query execution.
 */
export interface QueryResult<T = Row> {
  /** Array of result rows. */
  rows: T[];
  /** Column names in the result set (in order). */
  fields: FieldInfo[];
  /** Number of rows affected (for INSERT/UPDATE/DELETE). */
  affectedRows?: number;
}

/**
 * Information about a result set column.
 *
 * Populated from Firebird's prepared output metadata on both the WASM and
 * Node.js backends.
 */
export interface FieldInfo {
  /** Column name (alias if provided, otherwise the field name). */
  name: string;
  /**
   * Firebird SQL type code — `SQL_LONG` (496), `SQL_VARYING` (448) and so on.
   *
   * Worth having because the JSON encoding is lossy about types: a
   * `NUMERIC(10,2)` arrives as the string `"20.25"` to preserve its exactness,
   * and without this it is indistinguishable from a `VARCHAR` containing
   * digits.
   */
  type?: number;
  /** A readable form of {@link FieldInfo.type}, e.g. `'NUMERIC'`. */
  typeName?: FirebirdTypeName;
  /** Type-specific subtype; for BLOBs, 1 means text. */
  subType?: number;
  /** Decimal scale.  Non-zero means the value is exact and arrives as a string. */
  scale?: number;
  /** Declared length in bytes. */
  length?: number;
  /** Whether the column may be NULL. */
  nullable?: boolean;
}

/** Readable names for the Firebird SQL type codes this library reports. */
export type FirebirdTypeName =
  | 'TEXT'
  | 'VARYING'
  | 'SMALLINT'
  | 'INTEGER'
  | 'BIGINT'
  | 'INT128'
  | 'FLOAT'
  | 'DOUBLE'
  | 'DECFLOAT16'
  | 'DECFLOAT34'
  | 'NUMERIC'
  | 'DATE'
  | 'TIME'
  | 'TIMESTAMP'
  | 'TIME_TZ'
  | 'TIMESTAMP_TZ'
  | 'BOOLEAN'
  | 'BLOB'
  | 'ARRAY'
  | 'NULL'
  | 'UNKNOWN';

/**
 * A single row from a query result, keyed by column name.
 */
export type Row = Record<string, unknown>;

/**
 * Parameters passed to a parameterized query.
 */
export type QueryParams = unknown[];

/**
 * Transaction isolation level.
 *
 * - `READ_COMMITTED` – reads the latest committed version of each row;
 *   other transactions' commits become visible during the transaction.
 * - `SNAPSHOT` – provides a stable, point-in-time view of the database
 *   from the moment the transaction started (Firebird's default).
 * - `SNAPSHOT_TABLE_STABILITY` – acquires shared table locks to prevent
 *   concurrent writes; mapped to Firebird `CONSISTENCY` isolation.
 */
export type IsolationLevel =
  | 'READ_COMMITTED'
  | 'SNAPSHOT'
  | 'SNAPSHOT_TABLE_STABILITY';

/**
 * Options for beginning a transaction.
 */
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}

/**
 * What each row is.
 *
 * - `'object'` (default) keys every value by its column name as Firebird
 *   reports it: upper case unless quoted (`AS "title"` stays `title`).
 * - `'array'` gives the values in column order, positionally.
 *
 * Names live in `fields` either way, so `'array'` loses nothing — it trades
 * the convenience of `row.NAME` for `row[1]`, and for that it skips building
 * one object per row.
 */
export type RowMode = 'object' | 'array';

/**
 * Options accepted by `query()`.
 *
 * A superset of {@link TransactionOptions}: a query may start a transaction of
 * its own, and it decides the shape of what comes back.
 */
export interface QueryOptions extends TransactionOptions {
  /**
   * How to shape each row.
   *
   * `'array'` is worth reaching for on large result sets and on columns whose
   * names collide: `SELECT a.ID, b.ID` has two columns and, in object mode,
   * one `ID` key — the second value wins and the first is unreachable.
   * Positional rows keep both.
   *
   * @default 'object'
   */
  rowMode?: RowMode;
}

/** A row in `rowMode: 'array'` — values in column order. */
export type ArrayRow = unknown[];

/**
 * Options accepted by `queryStream()`.
 */
export interface QueryStreamOptions extends QueryOptions {
  /**
   * Maximum number of rows fetched per cursor batch.
   *
   * @default 500
   */
  batchSize?: number;
}

/**
 * What a statement is, from Firebird's `isc_info_sql_stmt_*` codes.
 *
 * `'UNKNOWN'` covers a code this library does not name rather than a failure
 * to describe the statement.
 */
export type StatementKind =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'DDL'
  | 'GET_SEGMENT'
  | 'PUT_SEGMENT'
  | 'EXEC_PROCEDURE'
  | 'START_TRANS'
  | 'COMMIT'
  | 'ROLLBACK'
  | 'SELECT_FOR_UPD'
  | 'SET_GENERATOR'
  | 'SAVEPOINT'
  | 'UNKNOWN';

/**
 * The shape of a statement, without running it.
 *
 * Returned by `describeQuery()`. Parameters are positional `?` in Firebird and
 * carry no names, so a `ParamInfo` has everything a {@link FieldInfo} has
 * except a meaningful one.
 */
export interface QueryDescription {
  /**
   * One entry per `?` parameter, in order.  Empty for a statement that takes
   * no parameters.
   */
  params: FieldInfo[];
  /** One entry per result column, in order.  Empty for a statement returning none. */
  fields: FieldInfo[];
  /** What kind of statement it is. */
  statementType: StatementKind;
  /** Whether executing it yields rows. */
  hasResultSet: boolean;
}

/**
 * Options for `explain()`.
 */
export interface ExplainOptions {
  /**
   * When `true`, returns Firebird 5/6's structured multi-line explained plan
   * tree (`Select Expression\n    -> ...`). When `false` or omitted, returns
   * the compact `PLAN (...)` string.
   *
   * @default false
   */
  detailed?: boolean;
}

/**
 * Database storage, ODS, memory pool, I/O, and transaction health diagnostics
 * returned by `db.databaseInfo()` (`IAttachment::getInfo`).
 */
export interface DatabaseInfo {
  /** Database page size in bytes (`isc_info_page_size`, e.g. 8192). */
  pageSize: number;
  /** Number of allocated database pages (`isc_info_allocation`). */
  allocatedPages: number;
  /** Total allocated database size in bytes (`pageSize * allocatedPages`). */
  databaseSizeBytes: number;
  /** On-Disk Structure major version (`isc_info_ods_version`, e.g. 13 or 14). */
  odsVersion: number;
  /** On-Disk Structure minor version (`isc_info_ods_minor_version`). */
  odsMinorVersion: number;
  /** Oldest Interesting Transaction (`isc_info_oldest_transaction` / OIT). */
  oldestTransaction: number;
  /** Oldest Active Transaction (`isc_info_oldest_active` / OAT). */
  oldestActive: number;
  /** Oldest Snapshot Transaction (`isc_info_oldest_snapshot` / OST). */
  oldestSnapshot: number;
  /** Next transaction ID to be assigned (`isc_info_next_transaction`). */
  nextTransaction: number;
  /**
   * Transaction health gap (`nextTransaction - oldestActive`).
   * A growing gap indicates an uncommitted long-running transaction holding
   * back garbage collection.
   */
  transactionGap: number;
  /** Bytes currently in use across the attachment's memory pools (`isc_info_current_memory`). */
  currentMemory: number;
  /** Peak bytes allocated across the attachment's memory pools (`isc_info_max_memory`). */
  maxMemory: number;
  /** Page cache buffer count (`isc_info_num_buffers`). */
  pageBuffers: number;
  /** Physical page reads since attachment opened (`isc_info_reads`). */
  reads: number;
  /** Physical page writes since attachment opened (`isc_info_writes`). */
  writes: number;
  /** Page cache fetches since attachment opened (`isc_info_fetches`). */
  fetches: number;
  /** Page cache marks (modified pages) since attachment opened (`isc_info_marks`). */
  /** Page cache marks (modified pages) since attachment opened (`isc_info_marks`). */
  marks: number;
}

/**
 * An explicitly prepared SQL statement handle returned by `db.prepare(sql)`
 * (or `tx.prepare(sql)`).
 *
 * Exposes the statement's input parameter metadata (`params`), output column
 * metadata (`fields`), statement classification (`statementType`,
 * `hasResultSet`), and execution methods (`query`, `exec`, `execBatch`,
 * `close`).
 */
export interface PreparedStatement {
  /** The SQL statement text that was prepared. */
  readonly sql: string;
  /** Input `?` parameter metadata, in positional order. */
  readonly params: FieldInfo[];
  /** Output column metadata, in positional order. */
  readonly fields: FieldInfo[];
  /** What kind of statement it is (`'SELECT'`, `'INSERT'`, etc.). */
  readonly statementType: StatementKind;
  /** Whether executing the statement yields a result set. */
  readonly hasResultSet: boolean;
  /** Whether `close()` has been called on this handle. */
  readonly closed: boolean;

  /**
   * Execute the prepared statement and return its result rows.
   */
  query(
    options: QueryOptions & { rowMode: 'array' },
  ): Promise<QueryResult<ArrayRow>>;
  query(
    params: QueryParams | undefined,
    options: QueryOptions & { rowMode: 'array' },
  ): Promise<QueryResult<ArrayRow>>;
  query<T extends Row = Row>(
    params?: QueryParams | QueryOptions,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;

  /**
   * Execute the prepared statement without returning rows.
   */
  exec(params?: QueryParams): Promise<{ affectedRows: number }>;

  /**
   * Execute the prepared statement once per row of parameters in a single
   * atomic batch transaction.
   */
  execBatch(rows: QueryParams[]): Promise<{ affectedRows: number }>;

  /**
   * Release the prepared statement handle. Safe to call more than once.
   */
  close(): Promise<void>;

  /** Support `await using stmt = await db.prepare(...)`. */
  /** Support `await using stmt = await db.prepare(...)`. */
  [Symbol.asyncDispose]?(): Promise<void>;
}

/**
 * Options for `dumpDataStream()` and `loadDataStream()`.
 */
export interface DataStreamOptions {
  /**
   * Compress (`dumpDataStream`) or decompress (`loadDataStream`) the stream on
   * the fly using Web Streams `CompressionStream('gzip')` /
   * `DecompressionStream('gzip')`.
   *
   * On `loadDataStream()`, when `compression` is omitted, gzip streams (magic
   * bytes `0x1f 0x8b`) are also detected and decompressed automatically.
   *
   * @default 'none'
   */
  compression?: 'none' | 'gzip';
  /**
   * Byte size of each chunk read from the database file during
   * `dumpDataStream()`. Defaults to `65536` (64 KiB, i.e. 8 × 8 KiB pages).
   *
   * @default 65536
   */
  chunkSize?: number;
}
