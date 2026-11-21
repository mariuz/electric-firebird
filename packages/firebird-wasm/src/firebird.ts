import * as fs from 'fs';
import type { Client, Attachment, Transaction } from 'node-firebird-driver';
import type {
  ArrayRow,
  FirebirdLiteOptions,
  QueryDescription,
  ExplainOptions,
  DatabaseInfo,
  SweepResult,
  PreparedStatement,
  DataStreamOptions,
  CopyFromOptions,
  CopyToOptions,
  CopyResult,
  IntrospectOptions,
  SchemaIntrospection,
  Migration,
  MigrateOptions,
  BlobStreamOptions,
  BlobHandle,
  BlobWritableStream,
  MigrateResult,
  QueryResult,
  QueryOptions,
  QueryStreamOptions,
  StatementExecutionOptions,
  Row,
  QueryParams,
  RowMode,
  TransactionOptions,
} from './types';
import { applySerializers } from './browser/value-types';
import { buildCopyToStream } from './browser/copy-stream';
import { introspect as introspectSchema, migrate as runMigrations } from './browser/schema';
import {
  type DatabaseSnapshot,
  type DatabaseSnapshotInfo,
  type SnapshotOptions,
  type PageDiffOptions,
  type ApplyPageDiffOptions,
} from './browser/snapshots';
import {
  assertNotAborted,
  DatabaseCoreSubsystems,
  type FirebirdDatabase,
  type UnifiedExecuteResult,
  validateTimeoutMs,
} from './database-core';
import type { ReplicableDatabase } from './replication/types';
import type { WebSocketLike } from './replication/transports';
import type { RtcDataChannelLike } from './replication/webrtc-resilient';
import {
  syncWithPeer,
  type SyncHandle,
  type SyncWithOptions,
} from './replication/presets';
import type { ColumnarQueryResult } from './columnar';
import type { TypedSqlFragment } from './schema-validation';
import {
  executePipelineFallback,
  normalizePipelineOperations,
  type PipelineOperation,
  type PipelineOptions,
  type PipelineResults,
  type PreparedPipeline,
  type PreparedPipelineStepTemplate,
} from './pipeline';
import {
  createArrowIpcReadableStream,
  createColumnarStreamFromRowStream,
  resolveColumnarStreamArgs,
  type ArrowStreamOptions,
  type ColumnarStreamOptions,
} from './columnar-stream';
import {
  createTableRepository,
  type TableOptions,
  type TableRepository,
} from './table-api';
import {
  loadArrowIpcIntoDatabase,
  type ArrowIngestResult,
  type ArrowIngestSource,
  type LoadArrowIpcOptions,
} from './arrow-ingest';
import {
  registerVirtualTableOnDatabase,
  type VirtualTableHandle,
  type VirtualTableOptions,
  type VirtualTableProvider,
} from './virtual-table';
import {
  createMaterializedViewOnDatabase,
  listMaterializedViewsOnDatabase,
  type MaterializedViewHandle,
  type MaterializedViewInfo,
  type MaterializedViewOptions,
} from './materialized-view';
import {
  createLiveColumnarQuery,
  createLiveIncrementalQuery,
  type IncrementalLiveSnapshot,
  type LiveColumnarOptions,
  type LiveColumnarQuery,
  type LiveIncrementalOptions,
  type LiveIncrementalQuery,
} from './live-incremental';
import {
  assertUdrCallback,
  executeArrowFromColumnar,
  executeColumnarViaArrayQuery,
  resolveColumnarQueryCall,
  runDriverApplyDiff,
  runDriverExportDiff,
  type QueryArrowOptions,
} from './shared-driver-ops';
import {
  describeNodeQuery,
  executeNodeQuery,
  explainNodeQuery,
  runNodeProfiledExec,
  runNodeProfiledExecBatch,
  runNodeProfiledExecute,
  runNodeSweep,
  runSharedNodeRead,
  streamNodeQuery,
  watchNodeLocalSqlEvents,
} from './firebird-query-runner';
import type {
  JsFunctionHandler,
  JsProcedureHandler,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  RegisteredRoutine,
  MonitorStats,
  QueryProfileListener,
} from './types';
import type { TypeOptions } from './browser/value-types';
import { resolveQueryCall, resolveBatchSize } from './sql-tag';
import type { SqlFragment, Statement as ParsedStatement } from './sql-tag';
import {
  type ArrayModeOptions,
  type ArrayStreamOptions,
} from './database-core';
import {
  StatementCache,
  cancelAttachmentOperation,
  loadNativeDriver,
} from './node-native-bindings';
import { FirebirdTransaction } from './firebird-tx';
export { FirebirdTransaction } from './firebird-tx';
import {
  captureNodeSnapshot,
  createNodeBlobStream,
  createNodeDumpDataStream,
  createNodePreparedPipeline,
  createNodePreparedStatement,
  openNodeBlobStream,
  readNodeDatabaseInfo,
  restoreNodeSnapshot,
  runNodeLoadDataStream,
  runNodeTransaction,
  type NodeStreamHost,
} from './firebird-streams';

/**
 * FirebirdLite – a PGlite-style wrapper around Firebird Embedded.
 *
 * Provides a simple async API for running SQL against a Firebird database
 * using the Firebird embedded engine (single-process mode).
 *
 * @example
 * ```ts
 * const db = new FirebirdLite('/tmp/my-database.fdb');
 * await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR(100))');
 * await db.query('INSERT INTO t VALUES (?, ?)', [1, 'hello']);
 * const result = await db.query('SELECT * FROM t');
 * // { rows: [ { ID: 1, NAME: 'hello' } ], fields: [...] }
 * await db.close();
 * ```
 */
export class FirebirdLite implements FirebirdDatabase {
  private readonly dbPath: string;
  private readonly libraryPath: string | undefined;
  private readonly connectOptions: { username?: string; password?: string; charSetForNONE?: string };
  private client: Client | null = null;
  private attachment: Attachment | null = null;
  private closed = false;
  private readonly sharedReads: boolean;
  /** The read-only transaction `query()` shares when `sharedReads` is on. */
  private readTransaction: Transaction | null = null;
  /** SQL texts that are not a SELECT, or that wrote: they get a transaction of their own. */
  private readonly ownTransaction = new Set<string>();
  private readonly statementCacheSize: number;
  /** Statements kept prepared by their SQL text, once connected (`statementCache`). */
  private statements: StatementCache | null = null;
  private readonly preparedStatements = new Set<PreparedStatement>();
  private readonly liveEventListeners = new Map<string, Set<() => void>>();
  private readonly core = new DatabaseCoreSubsystems(8192);
  private get udr() {
    return this.core.udr;
  }
  private get snapshotStore() {
    return this.core.snapshotStore;
  }
  private get profiler() {
    return this.core.profiler;
  }
  private readonly types: TypeOptions | undefined;

  constructor(dbPath: string, options: FirebirdLiteOptions = {}) {
    this.dbPath = dbPath;
    this.libraryPath = options.libraryPath;
    this.connectOptions = {
      username: options.username,
      password: options.password,
      charSetForNONE: options.charset,
    };
    this.sharedReads = options.sharedReads ?? false;
    const size = options.statementCache ?? 0;
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError('statementCache is a whole number of statements, 0 or more');
    }
    this.statementCacheSize = size;
    this.types = options.types;
  }

  private serialize(params: QueryParams): QueryParams {
    return applySerializers(params, this.types?.serializers);
  }

  /**
   * Lazily initialize the native client and open (or create) the database.
   */
  private async ensureReady(): Promise<void> {
    if (this.attachment) return;
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }

    const { createNativeClient, getDefaultLibraryFilename } = loadNativeDriver();
    this.client = createNativeClient(this.libraryPath ?? getDefaultLibraryFilename());

    try {
      this.attachment = await this.client.connect(this.dbPath, this.connectOptions);
    } catch {
      // Database does not exist yet – create it.
      this.attachment = await this.client.createDatabase(this.dbPath, this.connectOptions);
    }
    this.statements = new StatementCache(this.attachment, this.statementCacheSize);
  }

  /**
   * Cancel the currently running statement on this database attachment via
   * `IAttachment::cancelOperation(status, fb_cancel_raise)`.
   */
  async cancelOperation(): Promise<void> {
    await this.ensureReady();
    await cancelAttachmentOperation(this.attachment);
  }

  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<void> {
    return runNodeProfiledExec(
      this.profiler,
      (s, p, o) => this.transaction((tx) => tx.exec(s, p, o)),
      sql,
      paramsOrOptions,
      maybeOptions,
    );
  }

  async execute(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: StatementExecutionOptions = {},
  ): Promise<UnifiedExecuteResult> {
    return runNodeProfiledExecute(
      this.profiler,
      (s, p, o) => this.transaction((tx) => tx.execute(s, p, o)),
      sql,
      params,
      options,
    );
  }

  async syncWith(
    peerOrUrl: ReplicableDatabase | string | RtcDataChannelLike | WebSocketLike,
    options: SyncWithOptions = {},
  ): Promise<SyncHandle> {
    await this.ensureReady();
    return syncWithPeer(this, peerOrUrl, options);
  }

  async execBatch(sql: string, rows: QueryParams[]): Promise<void> {
    return runNodeProfiledExecBatch(
      this.profiler,
      (s, r) => this.transaction((tx) => tx.execBatch(s, r)),
      sql,
      rows,
    );
  }

  /**
   * Execute multiple heterogeneous `query`, `queryColumnar`, `queryArrow`,
   * `execute`, and `execBatch` operations in one pipeline (`M20 Item 2`).
   */
  async pipeline<const TOps extends readonly PipelineOperation[]>(
    ops: TOps,
    options: PipelineOptions = {},
  ): Promise<PipelineResults<TOps>> {
    assertNotAborted(options.signal);
    if (ops.length === 0) {
      return [] as unknown as PipelineResults<TOps>;
    }
    await this.ensureReady();
    const steps = normalizePipelineOperations(ops, (p) => this.serialize(p));
    let results: unknown[];
    if (options.transaction) {
      const txOpts =
        typeof options.transaction === 'object' ? options.transaction : {};
      results = await this.transaction(
        (tx) => executePipelineFallback(steps, tx),
        txOpts,
      );
    } else {
      results = await executePipelineFallback(steps, this);
    }
    assertNotAborted(options.signal);
    return results as PipelineResults<TOps>;
  }

  private dispatchLocalEvent(eventName: string): void {
    const callbacks = this.liveEventListeners.get(eventName);
    if (!callbacks) return;
    for (const cb of [...callbacks]) {
      cb();
    }
  }

  /** Post a named event to wake local `liveIncremental` / `liveColumnar` listeners (`M20 Item 3`). */
  async notify(name: string): Promise<void> {
    await this.ensureReady();
    await this.exec(
      'EXECUTE BLOCK (n VARCHAR(128) = ?) AS BEGIN POST_EVENT :n; END',
      [name],
    );
    this.dispatchLocalEvent(name);
  }

  private watchLocalSqlEvents(
    sqlText: string,
    explicitEvents: readonly string[] | undefined,
    onWakeup: () => void,
    options: { pollIntervalMs?: number },
  ): () => Promise<void> {
    return watchNodeLocalSqlEvents(
      this.liveEventListeners,
      sqlText,
      explicitEvents,
      onWakeup,
      options,
    );
  }

  /**
   * Subscribe to incremental `{ rows, deltas }` (`insert` / `update` / `delete`)
   * updates with structural sharing for unchanged rows (`M20 Item 3`).
   */
  async liveIncremental<T extends Row = Row>(
    sql: string | SqlFragment,
    optionsOrListener?:
      | LiveIncrementalOptions<T>
      | ((snapshot: IncrementalLiveSnapshot<T>) => void),
    maybeListener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
  ): Promise<LiveIncrementalQuery<T>> {
    await this.ensureReady();
    const opts: LiveIncrementalOptions<T> =
      typeof optionsOrListener === 'function' ? {} : (optionsOrListener ?? {});
    const listener =
      typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener;

    return createLiveIncrementalQuery<T>(
      {
        query: (qSql, qParams, qOpts) => this.query<T>(qSql, qParams, qOpts),
        queryColumnar: (qSql, qParams) => this.queryColumnar(qSql, qParams),
        watchSqlEvents: async (sqlText, explicitEvents, onWakeup, watchOpts) =>
          this.watchLocalSqlEvents(sqlText, explicitEvents, onWakeup, watchOpts),
      },
      sql,
      opts,
      listener,
    );
  }

  /**
   * Subscribe to reactive `ColumnarQueryResult` typed vectors without allocating
   * per-row JS objects (`M20 Item 3`).
   */
  async liveColumnar(
    sql: string | SqlFragment,
    optionsOrListener?:
      | LiveColumnarOptions
      | ((result: ColumnarQueryResult, version: number) => void),
    maybeListener?: (result: ColumnarQueryResult, version: number) => void,
  ): Promise<LiveColumnarQuery> {
    await this.ensureReady();
    const opts: LiveColumnarOptions =
      typeof optionsOrListener === 'function' ? {} : (optionsOrListener ?? {});
    const listener =
      typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener;

    return createLiveColumnarQuery(
      {
        queryColumnar: (qSql, qParams) => this.queryColumnar(qSql, qParams),
        watchSqlEvents: async (sqlText, explicitEvents, onWakeup, watchOpts) =>
          this.watchLocalSqlEvents(sqlText, explicitEvents, onWakeup, watchOpts),
      },
      sql,
      opts,
      listener,
    );
  }

  /**
   * Pre-compile a multi-statement pipeline on `FirebirdLite` (`M21 Item 2`).
   */
  async preparePipeline<
    const TTemplates extends readonly PreparedPipelineStepTemplate[],
  >(templates: TTemplates): Promise<PreparedPipeline<TTemplates>> {
    await this.ensureReady();
    return createNodePreparedPipeline(this, (p) => this.serialize(p), templates);
  }

  /**
   * Create a zero-boilerplate typed CRUD & upsert repository for `tableName` (`M21 Item 3`).
   */
  table<T extends Row = Row, K = unknown>(
    tableName: string,
    options?: TableOptions<T>,
  ): TableRepository<T, K> {
    return createTableRepository<T, K>(this, tableName, options);
  }

  async loadArrowIpc(
    tableName: string,
    source: ArrowIngestSource,
    options: LoadArrowIpcOptions = {},
  ): Promise<ArrowIngestResult> {
    await this.ensureReady();
    return loadArrowIpcIntoDatabase(this, tableName, source, options);
  }

  async registerVirtualTable(
    name: string,
    provider: VirtualTableProvider,
    options: VirtualTableOptions = {},
  ): Promise<VirtualTableHandle> {
    await this.ensureReady();
    return registerVirtualTableOnDatabase(this, name, provider, options);
  }

  async createMaterializedView<T extends Row = Row>(
    name: string,
    selectSql: string | SqlFragment,
    options: MaterializedViewOptions = {},
  ): Promise<MaterializedViewHandle<T>> {
    await this.ensureReady();
    const handle = await createMaterializedViewOnDatabase<T>(this, name, selectSql, options);
    this.core.disposables.add(() => handle.dispose());
    return handle;
  }

  async listMaterializedViews(): Promise<MaterializedViewInfo[]> {
    await this.ensureReady();
    return listMaterializedViewsOnDatabase(this);
  }

  /**
   * Execute a (parameterised) SQL statement and return the result rows.
   *
   * For SELECT queries the rows are returned as plain objects keyed by the
   * column name as Firebird reports it, mirroring the PGlite convention: an
   * unquoted name in upper case (`SELECT title` gives `TITLE`), a quoted alias
   * as written (`SELECT title AS "title"` gives `title`).
   *
   * ```ts
   * await db.query('SELECT * FROM items WHERE id = ?', [id]);
   * await db.query(sql`SELECT * FROM items WHERE id = ${id}`);
   * ```
   */
  // `rowMode: 'array'` first, so the literal in the options object picks these
  // and the return type follows the mode rather than the caller's hope.
  async query(
    sql: SqlFragment,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: TypedSqlFragment<T>,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  async query<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  async query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  // Both shapes at once, so a caller holding a `string | SqlFragment` — one
  // built conditionally — can call this without casting. Last, so the two
  // specific overloads still win where they apply.
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment | TypedSqlFragment<T>,
    paramsOrOptions: QueryParams | QueryOptions<T> = [],
    maybeOptions: QueryOptions<T> = {},
  ): Promise<QueryResult<T>> {
    return executeNodeQuery<T>(
      {
        ensureReady: () => this.ensureReady(),
        getAttachment: () => this.attachment!,
        getStatements: () => this.statements!,
        types: this.types,
        udr: this.udr,
        createUdrExecutor: () => this.createUdrExecutor(),
        profiler: this.profiler,
        sharedReads: this.sharedReads,
        ownTransaction: this.ownTransaction,
        sharedRead: (sqlText, p, rm) => this.sharedRead(sqlText, p, rm),
        endReadTransaction: () => this.endReadTransaction(),
        serialize: (p) => this.serialize(p),
        cancelOperation: () => this.cancelOperation(),
      },
      sql,
      paramsOrOptions,
      maybeOptions,
    );
  }

  /**
   * Execute a `SELECT` query and return typed columnar buffers (`Int32Array`,
   * `Float64Array`, `BigInt64Array`, UTF-8 offset buffers) (`M19 Item 2`).
   */
  async queryColumnar(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ColumnarQueryResult> {
    const { statement, options } = resolveColumnarQueryCall(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    return executeColumnarViaArrayQuery(() =>
      this.query(statement.sql, statement.params, {
        ...options,
        rowMode: 'array',
      }),
    );
  }

  /**
   * Execute a `SELECT` query and return a standard **Apache Arrow IPC V5**
   * stream (`Uint8Array`) (`M19 Item 2`).
   */
  async queryArrow(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryArrowOptions = [],
    maybeOptions: QueryArrowOptions = {},
  ): Promise<Uint8Array> {
    const { statement, options } = resolveColumnarQueryCall<QueryArrowOptions>(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    return executeArrowFromColumnar(
      () => this.queryColumnar(statement.sql, statement.params, options),
      options,
    );
  }

  queryColumnarStream(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | ColumnarStreamOptions,
    maybeOptions?: ColumnarStreamOptions,
  ): AsyncIterableIterator<ColumnarQueryResult> {
    return createColumnarStreamFromRowStream(
      (s, p, o) => this.queryStream<Row>(s, p ?? [], o),
      sql,
      paramsOrOptions,
      maybeOptions,
    );
  }

  queryArrowStream(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | ArrowStreamOptions,
    maybeOptions?: ArrowStreamOptions,
  ): ReadableStream<Uint8Array> {
    const { options } = resolveColumnarStreamArgs(paramsOrOptions, maybeOptions);
    return createArrowIpcReadableStream(
      () => this.queryColumnarStream(sql, paramsOrOptions, maybeOptions),
      async () => (await this.describeQuery(sql)).fields,
      options,
    );
  }

  /**
   * Stream a SQL query's result set in batches of `batchSize` rows (default 500).
   *
   * Yields one `QueryResult<T>` batch per cursor fetch instead of materialising
   * the entire result set into memory at once.  Breaking out of the `for await`
   * loop early closes the cursor and finishes the transaction immediately.
   */
  queryStream(
    sql: SqlFragment,
    options: ArrayStreamOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayStreamOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryStreamOptions = [],
    maybeOptions: QueryStreamOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    const { statement, options } = resolveQueryCall<QueryStreamOptions>(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    validateTimeoutMs(options.timeoutMs);
    const batchSize = resolveBatchSize(options.batchSize);
    return this.streamQuery<T>(statement, options, batchSize);
  }

  private streamQuery<T>(
    statement: ParsedStatement,
    options: QueryStreamOptions,
    batchSize: number,
  ): AsyncIterableIterator<QueryResult<T>> {
    return streamNodeQuery<T>(
      {
        ensureReady: () => this.ensureReady(),
        getAttachment: () => this.attachment!,
        getStatements: () => this.statements!,
        endReadTransaction: () => this.endReadTransaction(),
        serialize: (p) => this.serialize(p),
        types: this.types,
      },
      statement,
      options,
      batchSize,
    );
  }

  private sharedRead<T>(
    sql: string,
    params: QueryParams,
    rowMode: RowMode,
  ): Promise<{ result: QueryResult<T>; cacheHit: boolean } | undefined> {
    return runSharedNodeRead<T>(
      {
        getAttachment: () => this.attachment!,
        getStatements: () => this.statements!,
        getReadTransaction: () => this.readTransaction,
        setReadTransaction: (tx) => {
          this.readTransaction = tx;
        },
        endReadTransaction: () => this.endReadTransaction(),
        rememberOwnTx: (s) => this.remember(s),
        serialize: (p) => this.serialize(p),
        types: this.types,
      },
      sql,
      params,
      rowMode,
    );
  }

  private remember(sql: string): void {
    if (this.ownTransaction.size >= 1024) this.ownTransaction.clear();
    this.ownTransaction.add(sql);
  }

  /**
   * End the shared read transaction, before anything but a shared read runs.
   *
   * On a server, an open transaction that has read a table makes `DROP TABLE`
   * fail with "object in use", and `exec()` runs DDL without preparing it, so
   * this cannot be kept to DDL as the WASM engine does: the shared transaction
   * lives across consecutive reads only. A run of reads keeps it; a write
   * between two reads costs what a transaction per read used to.
   */
  private async endReadTransaction(): Promise<void> {
    const transaction = this.readTransaction;
    this.readTransaction = null;
    if (transaction) await transaction.commit().catch(() => transaction.rollback().catch(() => undefined));
  }

  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    return describeNodeQuery(this.attachment!, sql);
  }

  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    await this.ensureReady();
    return explainNodeQuery(this.attachment!, sql, options);
  }

  /**
   * Inspect database size, page utilization, ODS version, transaction counters
   * (OIT/OAT/OST/Next), memory pool usage, and page I/O statistics
   * (`IAttachment::getInfo`).
   *
   * ```ts
   * const info = await db.databaseInfo();
   * // info.pageSize          → 8192
   * // info.allocatedPages    → 280
   * // info.databaseSizeBytes → 2293760
   * // info.transactionGap    → info.nextTransaction - info.oldestActive
   * ```
   */
  async databaseInfo(): Promise<DatabaseInfo> {
    await this.ensureReady();
    return readNodeDatabaseInfo(this.attachment, (sql) => this.query(sql));
  }

  /**
   * Subscribe to structured query execution telemetry ({@link QueryProfileEvent}).
   * Returns an unsubscribe callback.
   */
  onQuery(listener: QueryProfileListener): () => void {
    return this.profiler.onQuery(listener);
  }

  /**
   * Return aggregated query profiling metrics, prepare-cache hit/miss rates,
   * page-level I/O counters, and transaction health diagnostics.
   */
  async monitorStats(): Promise<MonitorStats> {
    await this.ensureReady();
    return this.profiler.snapshot(() => this.databaseInfo());
  }

  /**
   * Reset accumulated query profiler counters and clear the recent queries buffer.
   */
  resetMonitorStats(): void {
    this.profiler.reset();
  }

  /**
   * Introspect the database catalog (`RDB$RELATIONS`, `RDB$RELATION_FIELDS`,
   * `RDB$FIELDS`, `RDB$RELATION_CONSTRAINTS`, `RDB$REF_CONSTRAINTS`,
   * `RDB$INDICES`, `RDB$GENERATORS`, and `RDB$TRIGGERS`) and return typed
   * metadata (`tables`, `views`, `columns`, `primaryKeys`, `foreignKeys`,
   * `indexes`, `sequences`, and `triggers`).
   */
  async introspect(options: IntrospectOptions = {}): Promise<SchemaIntrospection> {
    await this.ensureReady();
    return introspectSchema(this, options);
  }

  /**
   * Apply (or revert with `direction: 'down'`) versioned schema migrations
   * transactionally, recording applied versions in `FB_MIGRATIONS$`.
   */
  async migrate(
    migrations: readonly Migration[],
    options: MigrateOptions = {},
  ): Promise<MigrateResult> {
    await this.ensureReady();
    return runMigrations(this, migrations, options);
  }

  /**
   * Register a JavaScript scalar User-Defined Function (UDF) in Firebird.
   */
  registerFunction(
    name: string,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
  registerFunction(
    name: string,
    options: RegisterFunctionOptions,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
  async registerFunction(
    name: string,
    optionsOrFn: RegisterFunctionOptions | JsFunctionHandler,
    maybeFn?: JsFunctionHandler,
  ): Promise<RegisteredRoutine> {
    await this.ensureReady();
    assertUdrCallback('registerFunction', optionsOrFn, maybeFn);
    return this.udr.registerFunction(
      name,
      optionsOrFn,
      maybeFn,
      this.createUdrExecutor(),
    );
  }

  /**
   * Unregister a previously registered JavaScript scalar function.
   */
  async unregisterFunction(name: string): Promise<void> {
    if (this.closed) return;
    await this.ensureReady();
    await this.udr.unregisterFunction(name, this.createUdrExecutor());
  }

  /**
   * Register a JavaScript User-Defined Procedure (UDP) in Firebird.
   */
  registerProcedure(
    name: string,
    fn: JsProcedureHandler,
  ): Promise<RegisteredRoutine>;
  registerProcedure(
    name: string,
    options: RegisterProcedureOptions,
    fn: JsProcedureHandler,
  ): Promise<RegisteredRoutine>;
  async registerProcedure(
    name: string,
    optionsOrFn: RegisterProcedureOptions | JsProcedureHandler,
    maybeFn?: JsProcedureHandler,
  ): Promise<RegisteredRoutine> {
    await this.ensureReady();
    assertUdrCallback('registerProcedure', optionsOrFn, maybeFn);
    return this.udr.registerProcedure(
      name,
      optionsOrFn,
      maybeFn,
      this.createUdrExecutor(),
    );
  }

  /**
   * Unregister a previously registered JavaScript stored procedure.
   */
  async unregisterProcedure(name: string): Promise<void> {
    if (this.closed) return;
    await this.ensureReady();
    await this.udr.unregisterProcedure(name, this.createUdrExecutor());
  }

  private createUdrExecutor() {
    return {
      isDirect: false,
      exec: (sql: string, params: QueryParams = []) => this.exec(sql, params),
      query: <R extends Row = Row>(
        sql: string,
        params: QueryParams = [],
        opts?: { rowMode?: RowMode },
      ) => this.query<R>(sql, params, opts),
    };
  }

  async sweep(): Promise<SweepResult> {
    return runNodeSweep({
      ensureReady: () => this.ensureReady(),
      endReadTransaction: () => this.endReadTransaction(),
      databaseInfo: () => this.databaseInfo(),
      query: (s) => this.query(s),
      getAttachment: () => this.attachment!,
    });
  }

  private get streamHost(): NodeStreamHost {
    return {
      ensureReady: () => this.ensureReady(),
      isClosed: () => this.closed,
      dbPath: this.dbPath,
      getClient: () => this.client,
      connectOptions: this.connectOptions,
      statementCacheSize: this.statementCacheSize,
      types: this.types,
      snapshotStore: this.snapshotStore,
      preparedStatements: this.preparedStatements,
      getAttachment: () => {
        if (!this.attachment) {
          throw new Error('FirebirdLite attachment is not connected');
        }
        return this.attachment;
      },
      setAttachmentAndCache: (att, stmts) => {
        this.attachment = att;
        this.statements = stmts;
      },
      getStatements: () => this.statements,
      endReadTransaction: () => this.endReadTransaction(),
      serialize: (p) => this.serialize(p),
      cancelOperation: () => this.cancelOperation(),
    };
  }

  /**
   * Prepare a SQL statement explicitly and return a reusable
   * {@link PreparedStatement} handle exposing `fields`, `params`, `query()`,
   * `exec()`, `execBatch()`, and `close()`.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    return createNodePreparedStatement(this.streamHost, sql);
  }

  /**
   * Run a function inside an explicit transaction.
   *
   * The transaction is automatically committed on success or rolled back on
   * error.
   */
  async transaction<T>(
    fn: (tx: FirebirdTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    return runNodeTransaction(
      this.attachment!,
      this.statements,
      this.types,
      this.udr,
      () => this.endReadTransaction(),
      (evName) => this.dispatchLocalEvent(evName),
      fn,
      options,
    );
  }

  /**
   * Read the database file as a `Uint8Array`.
   */
  /**
   * Create a segmented writable BLOB stream (`WritableStream<Uint8Array>`)
   * backed by Firebird `IBlob::putSegment`.
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    return createNodeBlobStream(() => this.ensureReady(), options);
  }

  /**
   * Open a Firebird `BLOB` column (from a `SELECT` query or a {@link BlobHandle})
   * as a segmented Web `ReadableStream<Uint8Array>` backed by `IBlob::getSegment`.
   */
  async openBlobStream(
    handle: BlobHandle,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: SqlFragment,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: string | SqlFragment,
    params?: QueryParams | BlobStreamOptions,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions: QueryParams | BlobStreamOptions = [],
    maybeOptions: BlobStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    return openNodeBlobStream(this.streamHost, sqlOrHandle, paramsOrOptions, maybeOptions);
  }

  /**
   * Capture a lightweight copy-on-write point-in-time page snapshot of the
   * database file.
   */
  async snapshot(
    labelOrOptions?: string | SnapshotOptions,
  ): Promise<DatabaseSnapshot> {
    return captureNodeSnapshot(this.streamHost, labelOrOptions);
  }

  /**
   * Restore the database file to a previously captured {@link DatabaseSnapshot}
   * (by snapshot object, `id`, `label`, or raw `.fdb` bytes).
   */
  async restoreSnapshot(
    snapshotOrId: DatabaseSnapshot | string | Uint8Array,
  ): Promise<void> {
    return restoreNodeSnapshot(this.streamHost, snapshotOrId);
  }

  /** List metadata for all copy-on-write snapshots captured on this database. */
  listSnapshots(): DatabaseSnapshotInfo[] {
    return this.snapshotStore.listSnapshots();
  }

  /** Delete a stored copy-on-write snapshot by `id`, `label`, or reference. */
  deleteSnapshot(snapshotOrId: DatabaseSnapshot | string): boolean {
    return this.snapshotStore.deleteSnapshot(snapshotOrId);
  }

  /**
   * Export a compact binary page diff (`FBDF\x01`) between `fromSnapshot` (or
   * `null` for an initial full checkpoint) and `toSnapshot` (defaults to the
   * current live database file).
   */
  async exportDiff(
    fromSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
    toSnapshot?: DatabaseSnapshot | string | Uint8Array,
    options?: PageDiffOptions,
  ): Promise<Uint8Array> {
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }
    await this.ensureReady();
    return runDriverExportDiff(
      this.snapshotStore,
      () => this.dumpDataDir(),
      fromSnapshot,
      toSnapshot,
      options,
    );
  }

  /**
   * Apply a compact binary page diff (`FBDF\x01`) onto `baseSnapshot` (or the
   * current database file when `baseSnapshot` is omitted) and restore the
   * database file to the resulting state.
   */
  async applyDiff(
    diffBytes: Uint8Array,
    baseSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
    options: ApplyPageDiffOptions = {},
  ): Promise<Uint8Array> {
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }
    await this.ensureReady();
    return runDriverApplyDiff(
      this.snapshotStore,
      () => this.dumpDataDir(),
      (bytes) => this.restoreSnapshot(bytes),
      diffBytes,
      baseSnapshot,
      options,
    );
  }

  async dumpDataDir(): Promise<Uint8Array> {
    await this.ensureReady();
    const buf = await fs.promises.readFile(this.dbPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Stream the database file in fixed-size chunks
   * (`ReadableStream<Uint8Array>`) without allocating a single contiguous
   * `Uint8Array` of the entire database in memory.
   *
   * Pass `{ compression: 'gzip' }` to compress on the fly via
   * `CompressionStream('gzip')`.
   */
  dumpDataStream(options: DataStreamOptions = {}): ReadableStream<Uint8Array> {
    return createNodeDumpDataStream(() => this.ensureReady(), this.dbPath, options);
  }

  /**
   * Bulk-import CSV or JSONLines (`'jsonl'` / `'ndjson'`) records from a
   * `ReadableStream` or `AsyncIterable` into `tableName` in bounded-memory
   * batches of `options.batchSize` (default 500) inside a single transaction.
   */
  async copyFromStream(
    tableName: string,
    stream:
      | ReadableStream<Uint8Array | string>
      | AsyncIterable<Uint8Array | string>,
    options: CopyFromOptions = {},
  ): Promise<CopyResult> {
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    await this.ensureReady();
    return this.transaction((tx) =>
      tx.copyFromStream(tableName, stream, options),
    );
  }

  /**
   * Stream a table or `SELECT` query as UTF-8 CSV or JSONLines (`'jsonl'` /
   * `'ndjson'`) in bounded-memory cursor batches of `options.batchSize`
   * (default 500).
   */
  copyToStream(
    sql: SqlFragment,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string | SqlFragment,
    paramsOrOptions: QueryParams | CopyToOptions = [],
    maybeOptions: CopyToOptions = {},
  ): ReadableStream<Uint8Array> {
    return buildCopyToStream(this, tableOrQuery, paramsOrOptions, maybeOptions);
  }

  /**
   * Replace the database file with a raw or gzip-compressed `.fdb` byte stream
   * produced by {@link dumpDataStream} without buffering the entire database
   * in a single `Uint8Array`.
   */
  async loadDataStream(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options: DataStreamOptions = {},
  ): Promise<void> {
    return runNodeLoadDataStream(this.streamHost, stream, options);
  }

  /**
   * Close the database connection and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.liveEventListeners.clear();
    this.core.clear();

    await this.endReadTransaction();
    for (const stmt of [...this.preparedStatements]) {
      await stmt.close().catch(() => undefined);
    }
    await this.statements?.flush();
    this.statements = null;
    if (this.attachment) {
      await this.attachment.disconnect().catch(() => undefined);
      this.attachment = null;
    }
    if (this.client) {
      await this.client.dispose().catch(() => undefined);
      this.client = null;
    }
  }

  /** Async resource disposal (`await using db = ...`) (`M18 Item 3`). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

