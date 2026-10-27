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
 * Diagnostic summary returned by `db.sweep()`.
 */
export interface SweepResult {
  /** Database diagnostics captured immediately before the sweep. */
  before: DatabaseInfo;
  /** Database diagnostics captured immediately after the sweep. */
  after: DatabaseInfo;
  /** Number of user tables scanned during the garbage-collection pass. */
  tablesScanned: number;
  /** How many transaction IDs OIT (`oldestTransaction`) advanced (`Math.max(0, after.oldestTransaction - before.oldestTransaction)`). */
  oitAdvanced: number;
  /** Reduction in `transactionGap` (`Math.max(0, before.transactionGap - after.transactionGap)`). */
  gapReduced: number;
  /** Wall-clock duration of the sweep in milliseconds. */
  durationMs: number;
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
   * Stream the prepared statement's result set in batches of `batchSize` rows
   * (default `500`).
   *
   * Breaking out of `for await` early closes the cursor immediately without
   * fetching the rest of the result set.
   */
  queryStream(
    options: QueryStreamOptions & { rowMode: 'array' },
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    params: QueryParams | undefined,
    options: QueryStreamOptions & { rowMode: 'array' },
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    params?: QueryParams | QueryStreamOptions,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;

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

/**
 * Options for `db.introspect()` / `introspect(db, options)`.
 */
export interface IntrospectOptions {
  /**
   * Include Firebird system objects (`RDB$*`, `MON$*`, `SEC$*`, or objects with
   * `RDB$SYSTEM_FLAG > 0`).
   *
   * @default false
   */
  includeSystem?: boolean;
  /**
   * Include internal helper tables created by `firebird-wasm` (`FB_MIGRATIONS$`,
   * `ELECTRIC_SHAPES`, `ELECTRIC_WRITES`, `ELECTRIC_SHADOW$*`,
   * `KYSELY_MIGRATION`, `KYSELY_MIGRATION_LOCK`).
   *
   * @default false
   */
  includeInternal?: boolean;
  /**
   * Optional table or view name filter (matched case-insensitively when
   * unquoted).
   */
  tableName?: string;
}

/**
 * Column metadata returned by `db.introspect()`.
 */
export interface ColumnSchemaInfo {
  /** Relation (table or view) name. */
  tableName: string;
  /** Column name (`TRIM(RDB$FIELD_NAME)`). */
  name: string;
  /** 0-based ordinal position (`RDB$FIELD_POSITION`). */
  position: number;
  /** Formatted SQL type expression (e.g. `'INTEGER'`, `'VARCHAR(100)'`, `'NUMERIC(10,2)'`). */
  typeName: string;
  /** Canonical Firebird type name (`'INTEGER'`, `'VARYING'`, `'TEXT'`, `'INT64'`, `'BLOB'`, etc.). */
  dataType: FirebirdTypeName;
  /** Raw `RDB$FIELD_TYPE` code. */
  fieldType: number;
  /** Raw `RDB$FIELD_SUB_TYPE` code. */
  subType: number;
  /** Raw `RDB$FIELD_SCALE` (negative for exact numeric scale). */
  scale: number;
  /** Numeric precision (`RDB$FIELD_PRECISION`). */
  precision: number;
  /** Character length (or byte length for binary types). */
  length: number;
  /** Whether the column allows `NULL` values (`RDB$NULL_FLAG === 0`). */
  nullable: boolean;
  /** Raw `DEFAULT ...` clause from `RDB$DEFAULT_SOURCE`, or `null` if none. */
  defaultSource: string | null;
  /** Whether the column is an identity column (`GENERATED ... AS IDENTITY`). */
  isIdentity: boolean;
  /** Whether the column is `COMPUTED BY (...)` (`RDB$COMPUTED_BLR IS NOT NULL`). */
  isComputed: boolean;
  /** Whether the column participates in the relation's primary key. */
  isPrimaryKey: boolean;
}

/**
 * Primary key constraint metadata returned by `db.introspect()`.
 */
export interface PrimaryKeySchemaInfo {
  /** Table name (`TRIM(RDB$RELATION_NAME)`). */
  tableName: string;
  /** Constraint name (`TRIM(RDB$CONSTRAINT_NAME)`). */
  constraintName: string;
  /** Backing index name (`TRIM(RDB$INDEX_NAME)`). */
  indexName: string;
  /** Ordered primary key column names. */
  columns: string[];
}

/**
 * Foreign key constraint metadata returned by `db.introspect()`.
 */
export interface ForeignKeySchemaInfo {
  /** Constraint name (`TRIM(RDB$CONSTRAINT_NAME)`). */
  name: string;
  /** Referencing table name. */
  tableName: string;
  /** Ordered referencing column names. */
  columns: string[];
  /** Referenced target table name. */
  referencedTableName: string;
  /** Ordered referenced column names on `referencedTableName`. */
  referencedColumns: string[];
  /** `ON UPDATE` referential action (`'RESTRICT'`, `'CASCADE'`, `'SET NULL'`, `'SET DEFAULT'`, `'NO ACTION'`). */
  onUpdate: string;
  /** `ON DELETE` referential action (`'RESTRICT'`, `'CASCADE'`, `'SET NULL'`, `'SET DEFAULT'`, `'NO ACTION'`). */
  onDelete: string;
}

/**
 * Index metadata returned by `db.introspect()`.
 */
export interface IndexSchemaInfo {
  /** Index name (`TRIM(RDB$INDEX_NAME)`). */
  name: string;
  /** Table name (`TRIM(RDB$RELATION_NAME)`). */
  tableName: string;
  /** Ordered index segment column names. */
  columns: string[];
  /** Whether the index enforces uniqueness (`RDB$UNIQUE_FLAG = 1`). */
  unique: boolean;
  /** Whether the index is descending (`RDB$INDEX_TYPE = 1`). */
  descending: boolean;
  /** Whether the index is currently inactive (`RDB$INDEX_INACTIVE = 1`). */
  inactive: boolean;
}

/**
 * Sequence / generator metadata (`RDB$GENERATORS`) returned by `db.introspect()`.
 */
export interface SequenceSchemaInfo {
  /** Sequence / generator name (`TRIM(RDB$GENERATOR_NAME)`). */
  name: string;
  /** Initial value (`RDB$INITIAL_VALUE`). */
  initialValue: number;
  /** Step increment (`RDB$GENERATOR_INCREMENT`). */
  increment: number;
}

/**
 * Trigger metadata (`RDB$TRIGGERS`) returned by `db.introspect()`.
 */
export interface TriggerSchemaInfo {
  /** Trigger name (`TRIM(RDB$TRIGGER_NAME)`). */
  name: string;
  /** Relation name, or `null` for database-level triggers. */
  tableName: string | null;
  /** Raw `RDB$TRIGGER_TYPE` bitmask. */
  triggerType: number;
  /** Trigger timing (`'BEFORE'`, `'AFTER'`, or `'ON CONNECT'` / `'ON TRANSACTION ...'`). */
  timing: string;
  /** Triggered DML or database events (e.g. `['INSERT']`, `['INSERT', 'UPDATE']`). */
  events: string[];
  /** Execution sequence (`RDB$TRIGGER_SEQUENCE`). */
  sequence: number;
  /** Whether the trigger is inactive (`RDB$TRIGGER_INACTIVE = 1`). */
  inactive: boolean;
  /** PSQL trigger source (`RDB$TRIGGER_SOURCE`), or `null` if unavailable. */
  source: string | null;
}

/**
 * User table metadata returned by `db.introspect()`.
 */
export interface TableSchemaInfo {
  /** Table name (`TRIM(RDB$RELATION_NAME)`). */
  name: string;
  /** Ordered table columns. */
  columns: ColumnSchemaInfo[];
  /** Ordered primary key column names (empty if the table has no primary key). */
  primaryKey: string[];
  /** Outgoing foreign key constraints defined on this table. */
  foreignKeys: ForeignKeySchemaInfo[];
  /** Indexes defined on this table. */
  indexes: IndexSchemaInfo[];
  /** Triggers defined on this table. */
  triggers: TriggerSchemaInfo[];
}

/**
 * View metadata returned by `db.introspect()`.
 */
export interface ViewSchemaInfo {
  /** View name (`TRIM(RDB$RELATION_NAME)`). */
  name: string;
  /** Ordered view columns. */
  columns: ColumnSchemaInfo[];
  /** View SQL definition (`RDB$VIEW_SOURCE`), or `null` if unavailable. */
  source: string | null;
}

/**
 * Complete database schema metadata returned by `db.introspect()`.
 */
export interface SchemaIntrospection {
  /** User tables with nested columns, primaryKey, foreignKeys, indexes, and triggers. */
  tables: TableSchemaInfo[];
  /** Views with nested columns and view SQL definition. */
  views: ViewSchemaInfo[];
  /** Flat list of all columns across introspected tables and views. */
  columns: ColumnSchemaInfo[];
  /** Flat list of all primary key constraints. */
  primaryKeys: PrimaryKeySchemaInfo[];
  /** Flat list of all foreign key constraints. */
  foreignKeys: ForeignKeySchemaInfo[];
  /** Flat list of all indexes. */
  indexes: IndexSchemaInfo[];
  /** Flat list of all sequences / generators (`RDB$GENERATORS`). */
  sequences: SequenceSchemaInfo[];
  /** Flat list of all triggers (`RDB$TRIGGERS`). */
  triggers: TriggerSchemaInfo[];
}

/**
 * Minimal query/exec interface required by `introspect()` and migration steps.
 */
export interface MigrationExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec(sql: string, params?: QueryParams): Promise<unknown>;
}

/**
 * Database handle accepted by `migrate(db, migrations, options)`.
 */
export interface MigratableDatabase extends MigrationExecutor {
  transaction?<T>(
    fn: (tx: MigrationExecutor) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

/**
 * A single migration action (`up` or `down`):
 * - a SQL string or multi-statement SQL script (supporting `SET TERM`),
 * - an array of SQL statements, or
 * - an async callback receiving the active transaction / executor.
 */
export type MigrationStep =
  | string
  | readonly string[]
  | ((tx: MigrationExecutor) => Promise<void> | void);

/**
 * A versioned schema migration definition for `migrate()`.
 */
export interface Migration {
  /** Unique migration version (e.g. `1`, `'001'`, `'20261027_create_users'`). */
  version: number | string;
  /** Optional human-readable migration name. */
  name?: string;
  /** Forward migration step. */
  up: MigrationStep;
  /** Optional rollback migration step for `direction: 'down'`. */
  down?: MigrationStep;
}

/**
 * Record of an applied migration stored in `FB_MIGRATIONS$`.
 */
export interface AppliedMigration {
  /** Version string as stored in `FB_MIGRATIONS$`. */
  version: string;
  /** Optional migration name. */
  name: string | null;
  /** ISO-8601 timestamp when the migration was applied. */
  appliedAt: string;
}

/**
 * Options for `migrate(db, migrations, options)` / `db.migrate(migrations, options)`.
 */
export interface MigrateOptions {
  /**
   * Metadata table used to track applied migrations.
   *
   * @default 'FB_MIGRATIONS$'
   */
  tableName?: string;
  /**
   * Migration direction:
   * - `'up'` (default): applies all unapplied migrations up to `targetVersion`
   *   (or all migrations if `targetVersion` is omitted).
   * - `'down'`: reverts applied migrations in reverse order down to (but not
   *   including) `targetVersion`. If `targetVersion` is omitted when
   *   `direction === 'down'`, reverts the single most recently applied
   *   migration (`targetVersion = 0` or `''` reverts all applied migrations).
   *
   * @default 'up'
   */
  direction?: 'up' | 'down';
  /**
   * Optional target version boundary.
   */
  targetVersion?: number | string;
}

/**
 * Summary returned by `migrate(db, migrations, options)`.
 */
export interface MigrateResult {
  /** Migrations applied during this `migrate()` call. */
  applied: AppliedMigration[];
  /** Migrations rolled back during this `migrate()` call (`direction: 'down'`). */
  reverted: AppliedMigration[];
  /** Latest applied version remaining in `FB_MIGRATIONS$`, or `null` if none. */
  currentVersion: string | null;
  /** Full ordered list of applied migrations currently in `FB_MIGRATIONS$`. */
  history: AppliedMigration[];
}

/**
 * Options for `db.openBlobStream()`, `tx.openBlobStream()`, `db.createBlobStream()`,
 * and `tx.createBlobStream()`.
 */
export interface BlobStreamOptions {
  /**
   * Maximum segment/chunk size in bytes transferred per `IBlob::getSegment` or
   * `IBlob::putSegment` step. Must be a positive integer (`<= 65535` when writing).
   *
   * @default 32768
   */
  segmentSize?: number;
  /**
   * 0-based column index or column name (case-insensitive) to stream when
   * opening a BLOB via a `SELECT` query that returns multiple columns.
   *
   * @default 0
   */
  column?: number | string;
}

/**
 * Reference to a Firebird BLOB written via `createBlobStream()`.
 *
 * Can be passed directly as a parameter in `exec()`, `query()`, or
 * `PreparedStatement.exec()` (e.g. `await tx.exec('INSERT INTO files VALUES (?, ?)', [1, handle])`),
 * or re-opened for reading via `openBlobStream(handle)`.
 */
export interface BlobHandle {
  readonly __brand: 'FirebirdBlobHandle';
  /** The 8-byte Firebird `ISC_QUAD` BLOB identifier. */
  readonly blobId: Uint8Array;
  /** Total byte length written to the BLOB. */
  readonly byteLength: number;
}

/**
 * A Web `WritableStream<Uint8Array>` backed by Firebird `IBlob::putSegment`.
 *
 * Can be piped to from any `ReadableStream<Uint8Array>` (e.g. `await readable.pipeTo(blobStream)`)
 * or written to via `getWriter()` or `writeChunk()` + `finish()`. Once the stream
 * closes, `blobStream.handle` (or `blobStream` itself) can be bound as a parameter
 * in an `INSERT` or `UPDATE` statement.
 */
export interface BlobWritableStream extends WritableStream<Uint8Array> {
  /** Resolves to the finalized {@link BlobHandle} once the stream is closed. */
  readonly closed: Promise<BlobHandle>;
  /**
   * The finalized {@link BlobHandle} after the stream has been closed,
   * or `null` while the stream is still open.
   */
  readonly handle: BlobHandle | null;
  /** Total bytes written to the BLOB so far. */
  readonly byteLength: number;
  /** Write a single `Uint8Array` or UTF-8 `string` chunk to the BLOB. */
  writeChunk(chunk: Uint8Array | string): Promise<void>;
  /** Close the writer and return the finalized {@link BlobHandle}. */
  finish(): Promise<BlobHandle>;
}
