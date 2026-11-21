/**
 * firebird-browser.ts – Browser-compatible FirebirdLite backed by WASM + IndexedDB.
 */

import { IndexedDBVFS } from './indexeddb-vfs';
import type { EngineHandle, EngineTransport } from './engine-transport';
import { WorkerTransport } from './worker-transport';
import { CrossTabLiveBridge } from './live-tables';
import {
  type DatabaseSnapshot,
  type DatabaseSnapshotInfo,
  type SnapshotOptions,
  type PageDiffOptions,
  type ApplyPageDiffOptions,
} from './snapshots';
import { introspect as introspectSchema, migrate as runMigrations } from './schema';
import { buildCopyToStream } from './copy-stream';
import { applySerializers } from './value-types';
import { SharedEngineTransport } from './shared-transport';
import type { DatabaseLock } from './db-lock';
import { toStatement, resolveQueryCall, resolveBatchSize } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';
import {
  assertNotAborted,
  DatabaseCoreSubsystems,
  type FirebirdDatabase,
  type UnifiedExecuteResult,
  validateTimeoutMs,
} from '../database-core';
import type { ReplicableDatabase } from '../replication/types';
import type { WebSocketLike } from '../replication/transports';
import type { RtcDataChannelLike } from '../replication/webrtc-resilient';
import {
  syncWithPeer,
  type SyncHandle,
  type SyncWithOptions,
} from '../replication/presets';
import type { ColumnarQueryResult } from '../columnar';
import type { TypedSqlFragment } from '../schema-validation';
import {
  createBrowserPreparedPipeline,
  executeBrowserPipeline,
  type BrowserPipelineDriverHost,
  type PipelineOperation,
  type PipelineOptions,
  type PipelineResults,
  type PreparedPipeline,
  type PreparedPipelineStepTemplate,
} from '../pipeline';
import {
  createArrowIpcReadableStream,
  resolveColumnarStreamArgs,
  type ArrowStreamOptions,
  type ColumnarStreamOptions,
} from '../columnar-stream';
import {
  createTableRepository,
  type TableOptions,
  type TableRepository,
} from '../table-api';
import {
  loadArrowIpcIntoDatabase,
  type ArrowIngestResult,
  type ArrowIngestSource,
  type LoadArrowIpcOptions,
} from '../arrow-ingest';
import {
  registerVirtualTableOnDatabase,
  type VirtualTableHandle,
  type VirtualTableOptions,
  type VirtualTableProvider,
} from '../virtual-table';
import {
  createMaterializedViewOnDatabase,
  listMaterializedViewsOnDatabase,
  type MaterializedViewHandle,
  type MaterializedViewInfo,
  type MaterializedViewOptions,
} from '../materialized-view';
import { decodeWireParamRows } from './wire-params';
import {
  type IncrementalLiveSnapshot,
  type LiveColumnarOptions,
  type LiveColumnarQuery,
  type LiveIncrementalOptions,
  type LiveIncrementalQuery,
} from '../live-incremental';
import {
  executeArrowFromColumnar,
  resolveColumnarQueryCall,
  type QueryArrowOptions,
} from '../shared-driver-ops';
import {
  BrowserPersistScheduler,
  closeBrowserDatabaseFull,
  createBrowserEngineTransport,
  executeBrowserQuery,
  initializeBrowserDatabase,
  registerBrowserFunction,
  registerBrowserProcedure,
  reopenBrowserDatabaseAfterEngineChange,
} from './firebird-browser-lifecycle';
import type {
  ArrayRow,
  FieldInfo,
  QueryResult,
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
  JsFunctionHandler,
  JsProcedureHandler,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  RegisteredRoutine,
  MonitorStats,
  PageIoCounters,
  QueryProfileListener,
  QueryOptions,
  QueryStreamOptions,
  StatementExecutionOptions,
  Row,
  QueryParams,
  TransactionOptions,
} from '../types';
import { FirebirdBrowserTransaction, type ExecResult } from './firebird-browser-tx';
export { FirebirdBrowserTransaction, type ExecResult } from './firebird-browser-tx';
import {
  ephemeralFileName,
  IDB_PREFIX,
  MEMORY_PREFIX,
  OPFS_PREFIX,
  type ArrayModeOptions,
  type ArrayStreamOptions,
  type BranchOptions,
  type EventSubscription,
  type FirebirdBrowserOptions,
  type ListenOptions,
  type LiveQuery,
  type LiveQueryOptions,
} from './firebird-browser-types';
export type {
  BranchOptions,
  EventSubscription,
  FirebirdBrowserOptions,
  ListenOptions,
  LiveQuery,
  LiveQueryOptions,
} from './firebird-browser-types';
import {
  createBrowserPreparedStatement,
  executeBrowserQueryColumnar,
  executeBrowserQueryColumnarStream,
  executeBrowserWireBatch,
  listenBrowserEvents,
  runBrowserLiveColumnar,
  runBrowserLiveIncremental,
  runBrowserLiveQuery,
  streamBrowserQuery,
  type BrowserStreamsHost,
} from './firebird-browser-streams';
import {
  applyBrowserDiff,
  applyBrowserIcuLocaleData,
  captureBrowserSnapshot,
  createBrowserBlobStream,
  createBrowserDumpDataStream,
  exportBrowserDiff,
  openBrowserBlobStream,
  restoreBrowserSnapshot,
  runBrowserLoadDataStream,
  setBrowserReplicaMode,
  type BrowserStorageHost,
} from './firebird-browser-storage';
import {
  buildBrowserPipelineHost,
  buildBrowserUdrExecutor,
  captureBrowserMonitorStats,
  captureBrowserPageIo,
  explainBrowserQuery,
  prepareBrowserBranchArgs,
  readBrowserDatabaseInfo,
  runBrowserExecBatch,
  runBrowserExecScript,
  runBrowserSweep,
  runBrowserTransaction,
} from './firebird-browser-diagnostics';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Browser-side Firebird database backed by WASM + IndexedDB.
 *
 * Mirrors the `FirebirdLite` API so application code can switch between the
 * Node.js native driver and the in-browser WASM engine with minimal changes.
 */
export class FirebirdBrowser implements FirebirdDatabase {
  private readonly dbName: string;
  /** True for a `memory://` database: never stored, discarded on close. */
  private readonly ephemeral: boolean;
  /** True for an `opfs://` database: the engine writes its pages straight to a file. */
  private readonly opfs: boolean;
  /** Path the engine opens. Set by the OPFS mount, which chooses it. */
  private opfsPath: string | null = null;
  /** Unique filename inside the engine's virtual FS (`memory://` gets a per-instance name). */
  private readonly fileName: string;
  private readonly options: FirebirdBrowserOptions;
  private readonly vfs: IndexedDBVFS;
  private readonly engine: EngineTransport;
  private dbHandle: EngineHandle = 0;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  private readonly onPersistError: (error: Error) => void;
  private readonly persistScheduler: BrowserPersistScheduler;

  private readonly multiTab: 'exclusive' | 'shared' | 'allow-unsafe';
  private readonly lockTimeoutMs: number;
  private lock: DatabaseLock | null = null;
  private readonly liveQueries = new Set<{ unsubscribe(): Promise<void> }>();
  private readonly preparedStatements = new Set<PreparedStatement>();
  private readonly columnarShapeCache = new Map<number, readonly FieldInfo[]>();
  private readonly liveTriggerPromises = new Map<string, Promise<string>>();
  private readonly core: DatabaseCoreSubsystems;
  private get udr() { return this.core.udr; }
  private get snapshotStore() { return this.core.snapshotStore; }
  private get profiler() { return this.core.profiler; }
  private readonly liveBridge: CrossTabLiveBridge;
  private shared: SharedEngineTransport | null = null;

  constructor(dbName: string, options: FirebirdBrowserOptions = {}) {
    const normalizedDbName = dbName.startsWith(IDB_PREFIX)
      ? dbName.slice(IDB_PREFIX.length)
      : dbName;
    this.dbName = normalizedDbName;
    this.ephemeral = normalizedDbName.startsWith(MEMORY_PREFIX);
    this.opfs = normalizedDbName.startsWith(OPFS_PREFIX);
    this.fileName = this.ephemeral
      ? ephemeralFileName(normalizedDbName)
      : this.opfs
        ? normalizedDbName.slice(OPFS_PREFIX.length)
        : normalizedDbName;
    this.options = options;
    this.vfs = new IndexedDBVFS({
      ...options.vfs,
      ...(options.encryptionKey !== undefined
        ? { encryptionKey: options.encryptionKey }
        : {}),
    });
    this.core = new DatabaseCoreSubsystems(options.vfs?.pageSize ?? 8192);
    this.liveBridge = new CrossTabLiveBridge({
      dbName: normalizedDbName,
      enabled: options.crossTabLive ?? !this.ephemeral,
    });

    // Ephemeral and OPFS databases do not take a cross-tab Web Lock.
    this.multiTab =
      this.ephemeral || this.opfs ? 'allow-unsafe' : options.multiTab ?? 'exclusive';
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;

    const autoPersist = options.autoPersist ?? true;
    const autoPersistDebounceMs = options.autoPersistDebounceMs ?? 500;
    this.onPersistError =
      options.onPersistError ??
      ((error) => console.error('[firebird-wasm] background persist failed', error));
    this.persistScheduler = new BrowserPersistScheduler({
      autoPersist,
      debounceMs: autoPersistDebounceMs,
      onError: this.onPersistError,
      isClosed: () => this.closed,
      canPersistNow: () => Boolean(this.dbHandle) && this.mayPersist,
      readAndImport: async () => {
        const image = await this.engine.readFile(this.dbPath);
        await this.vfs.importDatabase(image);
      },
    });

    if (options.transport) {
      this.engine = options.transport;
    } else {
      const built = createBrowserEngineTransport({
        multiTab: this.multiTab,
        dbName: this.dbName,
        options: this.options,
        onServedMutation: () => this.markDirty(),
        onEngineReplaced: () => this.reopenAfterEngineChange(),
      });
      this.engine = built.engine;
      this.shared = built.shared;
    }
    if (options.sharedReads && !this.engine.setSharedReads) {
      throw new Error('sharedReads needs a transport with setSharedReads; this one has none');
    }
  }

  /** Whether this tab is the one actually running the engine. */
  get isLeader(): boolean {
    return this.shared === null || this.shared.isLeader;
  }

  /** Path of the database inside Emscripten's filesystem. */
  private get dbPath(): string {
    return this.opfsPath ?? `/data/${this.fileName}.fdb`;
  }

  /**
   * Run any configured serializers over outgoing parameters.
   *
   * Here rather than in the encoder because the encoder may be on the far side
   * of a Worker, where the serializer functions cannot follow — see
   * {@link applySerializers}.
   */
  private serialize(params: QueryParams): QueryParams {
    return applySerializers(params, this.options.types?.serializers);
  }

  // ── Public API (mirrors FirebirdLite) ─────────────────────────────────

  /**
   * Cancel the currently running statement on this database attachment via
   * `IAttachment::cancelOperation(status, fb_cancel_raise)`.
   */
  async cancelOperation(): Promise<void> {
    await this.ensureReady();
    if (typeof this.engine.cancelOperation === 'function') {
      await this.engine.cancelOperation(this.dbHandle);
    }
  }

  private async applyOneShotTimeout(timeoutMs?: number): Promise<void> {
    const validated = validateTimeoutMs(timeoutMs);
    if (
      validated !== undefined &&
      validated > 0 &&
      typeof this.engine.stmtSetTimeout === 'function'
    ) {
      await this.engine.stmtSetTimeout(0, validated);
    }
  }

  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ExecResult[]> {
    return runBrowserExecScript(
      {
        engine: this.engine,
        getDbHandle: () => this.dbHandle,
        udr: this.udr,
        profiler: this.profiler,
        liveBridge: this.liveBridge,
        liveTriggerPromises: this.liveTriggerPromises,
        captureIo: () => this.captureIoIfListening(),
        applyOneShotTimeout: (t) => this.applyOneShotTimeout(t),
        cancelOperation: () => this.cancelOperation(),
        serialize: (p) => this.serialize(p),
        markDirty: () => this.markDirty(),
        ensureReady: () => this.ensureReady(),
      },
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
    const results = await this.exec(sql, params, options);
    const affectedRows = results.reduce((sum, r) => sum + r.affectedRows, 0);
    return { affectedRows, changes: affectedRows };
  }

  async setReplicaMode(
    mode: 'none' | 'read_only' | 'read_write' | 0 | 1 | 2 = 'read_write',
  ): Promise<void> {
    return setBrowserReplicaMode(
      this.storageHost,
      async () => {
        const ctxRes = await this.query<{ REPL_MODE: string | null }>(
          "SELECT RDB$GET_CONTEXT('SYSTEM', 'REPLICA_MODE') AS REPL_MODE FROM RDB$DATABASE",
        );
        const raw = ctxRes.rows[0]?.REPL_MODE;
        return raw === null || raw === undefined ? null : String(raw).trim().toUpperCase();
      },
      mode,
    );
  }

  async applyChangelog(
    segment: Uint8Array,
    options: { transfer?: boolean } = {},
  ): Promise<number> {
    await this.ensureReady();
    if (typeof this.engine.replicateChangelog !== 'function') {
      throw new Error('The configured EngineTransport does not support applyChangelog()');
    }
    const blocksProcessed = await this.engine.replicateChangelog(
      this.dbHandle,
      segment,
      options.transfer === true,
    );
    this.markDirty();
    return blocksProcessed;
  }

  async syncWith(
    peerOrUrl: ReplicableDatabase | string | RtcDataChannelLike | WebSocketLike,
    options: SyncWithOptions = {},
  ): Promise<SyncHandle> {
    await this.ensureReady();
    return syncWithPeer(this, peerOrUrl, options);
  }

  async execBatch(sql: string, rows: QueryParams[]): Promise<ExecResult> {
    await this.ensureReady();
    return runBrowserExecBatch(
      this.engine,
      this.dbHandle,
      this.profiler,
      this.liveBridge,
      () => this.captureIoIfListening(),
      (row) => this.serialize(row),
      () => this.markDirty(),
      sql,
      rows,
    );
  }

  private createPipelineDriverHost(): BrowserPipelineDriverHost {
    return buildBrowserPipelineHost(
      this,
      this.engine,
      this.dbHandle,
      this.columnarShapeCache,
      this.options.types,
      this.liveBridge,
      (p) => this.serialize(p),
      () => this.markDirty(),
    );
  }

  async pipeline<const TOps extends readonly PipelineOperation[]>(
    ops: TOps,
    options: PipelineOptions = {},
  ): Promise<PipelineResults<TOps>> {
    await this.ensureReady();
    return executeBrowserPipeline(this.createPipelineDriverHost(), ops, options);
  }

  async preparePipeline<
    const TTemplates extends readonly PreparedPipelineStepTemplate[],
  >(templates: TTemplates): Promise<PreparedPipeline<TTemplates>> {
    await this.ensureReady();
    return createBrowserPreparedPipeline(this.createPipelineDriverHost(), templates);
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

  async execWireBatch(
    sql: string,
    wireRows: Uint8Array,
    rowCount: number,
  ): Promise<ExecResult> {
    return executeBrowserWireBatch(
      this.streamsHost,
      sql,
      wireRows,
      rowCount,
      decodeWireParamRows,
      this.engine instanceof WorkerTransport,
    );
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
    return executeBrowserQuery<T>(
      {
        ensureReady: () => this.ensureReady(),
        getDbHandle: () => this.dbHandle,
        engine: this.engine,
        types: this.options.types,
        udr: this.udr,
        createUdrExecutor: (tx) => this.createUdrExecutor(tx),
        profiler: this.profiler,
        captureIo: () => this.captureIoIfListening(),
        applyOneShotTimeout: (t) => this.applyOneShotTimeout(t),
        cancelOperation: () => this.cancelOperation(),
        serialize: (p) => this.serialize(p),
      },
      sql,
      paramsOrOptions,
      maybeOptions,
    );
  }

  async queryColumnar(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ColumnarQueryResult> {
    return executeBrowserQueryColumnar(
      this.streamsHost,
      (s, p, o) => this.query(s, p, { ...o, rowMode: 'array' }),
      sql,
      paramsOrOptions,
      maybeOptions,
    );
  }

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
    return executeBrowserQueryColumnarStream(
      this.streamsHost,
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

  private get streamsHost(): BrowserStreamsHost {
    return {
      ensureReady: () => this.ensureReady(),
      isClosed: () => this.closed,
      engine: this.engine,
      getDbHandle: () => this.dbHandle,
      types: this.options.types,
      profiler: this.profiler,
      liveBridge: this.liveBridge,
      liveQueries: this.liveQueries,
      liveTriggerPromises: this.liveTriggerPromises,
      preparedStatements: this.preparedStatements,
      columnarShapeCache: this.columnarShapeCache,
      hasBridgeRoutines: () => this.udr.hasBridgeRoutines,
      serialize: (p) => this.serialize(p),
      applyOneShotTimeout: (t) => this.applyOneShotTimeout(t),
      cancelOperation: () => this.cancelOperation(),
      captureIoIfListening: () => this.captureIoIfListening(),
      markDirty: () => this.markDirty(),
      query: (s, p, o) => this.query(s, p, o),
      queryColumnar: (s, p) => this.queryColumnar(s, p),
      queryStream: (s, p, o) => this.queryStream(s, p, o),
      execBatch: (s, r) => this.execBatch(s, r),
    };
  }

  private get storageHost(): BrowserStorageHost {
    return {
      ensureReady: () => this.ensureReady(),
      isClosed: () => this.closed,
      engine: this.engine,
      getDbPath: () => this.dbPath,
      sharedReads: this.options.sharedReads,
      snapshotStore: this.snapshotStore,
      preparedStatements: this.preparedStatements,
      liveTriggerPromises: this.liveTriggerPromises,
      liveQueries: this.liveQueries,
      getDbHandle: () => this.dbHandle,
      setDbHandle: (h) => {
        this.dbHandle = h;
      },
      cancelScheduledPersist: () => this.cancelScheduledPersist(),
      markDirty: () => this.markDirty(),
      serialize: (p) => this.serialize(p),
      describeQuery: (s) => this.describeQuery(s),
      queryArray: (s, p) => this.query(s, p, { rowMode: 'array' }),
    };
  }

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
    return streamBrowserQuery<T>(this.streamsHost, statement, options, batchSize);
  }

  async listen(
    names: string | string[],
    onEvent: (counts: Record<string, number>) => void,
    options: ListenOptions = {},
  ): Promise<EventSubscription> {
    return listenBrowserEvents(this.streamsHost, names, onEvent, options);
  }

  async notify(name: string): Promise<void> {
    await this.query(
      'EXECUTE BLOCK (event_name VARCHAR(31) = ?) AS BEGIN POST_EVENT :event_name; END',
      [name],
    );
    this.liveBridge.broadcastEvents({ [name]: 1 });
  }

  async live<T extends Row = Row>(
    sql: string | SqlFragment,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>>;
  async live<T extends Row = Row>(
    sql: string | SqlFragment,
    options: LiveQueryOptions,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>>;
  async live<T extends Row = Row>(
    sql: string | SqlFragment,
    optionsOrOnChange: LiveQueryOptions | ((rows: T[], result: QueryResult<T>) => void),
    maybeOnChange?: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>> {
    return runBrowserLiveQuery<T>(this.streamsHost, sql, optionsOrOnChange, maybeOnChange);
  }

  async liveIncremental<T extends Row = Row>(
    sql: string | SqlFragment,
    optionsOrListener?:
      | LiveIncrementalOptions<T>
      | ((snapshot: IncrementalLiveSnapshot<T>) => void),
    maybeListener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
  ): Promise<LiveIncrementalQuery<T>> {
    return runBrowserLiveIncremental<T>(this.streamsHost, sql, optionsOrListener, maybeListener);
  }

  async liveColumnar(
    sql: string | SqlFragment,
    optionsOrListener?:
      | LiveColumnarOptions
      | ((result: ColumnarQueryResult, version: number) => void),
    maybeListener?: (result: ColumnarQueryResult, version: number) => void,
  ): Promise<LiveColumnarQuery> {
    return runBrowserLiveColumnar(this.streamsHost, sql, optionsOrListener, maybeListener);
  }

  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    return this.engine.describe(this.dbHandle, 0, toStatement(sql).sql);
  }

  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    await this.ensureReady();
    return explainBrowserQuery(this.engine, this.dbHandle, sql, options);
  }

  async databaseInfo(): Promise<DatabaseInfo> {
    await this.ensureReady();
    return readBrowserDatabaseInfo(this.engine, this.dbHandle);
  }

  onQuery(listener: QueryProfileListener): () => void {
    return this.profiler.onQuery(listener);
  }

  async monitorStats(): Promise<MonitorStats> {
    await this.ensureReady();
    return captureBrowserMonitorStats(this.profiler, this.engine, this.dbHandle);
  }

  resetMonitorStats(): void {
    this.profiler.reset();
  }

  private async captureIoIfListening(): Promise<PageIoCounters | null> {
    return captureBrowserPageIo(this.profiler, this.engine, this.dbHandle);
  }

  async sweep(): Promise<SweepResult> {
    await this.ensureReady();
    return runBrowserSweep(
      this.engine,
      this.dbHandle,
      (s) => this.query(s),
      () => this.markDirty(),
    );
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaIntrospection> {
    await this.ensureReady();
    return introspectSchema(this, options);
  }

  async migrate(
    migrations: readonly Migration[],
    options: MigrateOptions = {},
  ): Promise<MigrateResult> {
    await this.ensureReady();
    return runMigrations(this, migrations, options);
  }

  async registerFunction(
    name: string,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
  async registerFunction(
    name: string,
    options: RegisterFunctionOptions,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
  async registerFunction(
    name: string,
    optionsOrFn: RegisterFunctionOptions | JsFunctionHandler,
    maybeFn?: JsFunctionHandler,
  ): Promise<RegisteredRoutine> {
    return registerBrowserFunction(
      {
        isClosed: () => this.closed,
        ensureReady: () => this.ensureReady(),
        udr: this.udr,
        createUdrExecutor: (tx) => this.createUdrExecutor(tx),
        markDirty: () => this.markDirty(),
      },
      name,
      optionsOrFn,
      maybeFn,
    );
  }

  async registerProcedure(
    name: string,
    fn: JsProcedureHandler,
  ): Promise<RegisteredRoutine>;
  async registerProcedure(
    name: string,
    options: RegisterProcedureOptions,
    fn: JsProcedureHandler,
  ): Promise<RegisteredRoutine>;
  async registerProcedure(
    name: string,
    optionsOrFn: RegisterProcedureOptions | JsProcedureHandler,
    maybeFn?: JsProcedureHandler,
  ): Promise<RegisteredRoutine> {
    return registerBrowserProcedure(
      {
        isClosed: () => this.closed,
        ensureReady: () => this.ensureReady(),
        udr: this.udr,
        createUdrExecutor: (tx) => this.createUdrExecutor(tx),
        markDirty: () => this.markDirty(),
      },
      name,
      optionsOrFn,
      maybeFn,
    );
  }

  async unregisterFunction(name: string): Promise<void> {
    if (this.closed) return;
    await this.ensureReady();
    await this.udr.unregisterFunction(name, this.createUdrExecutor(0));
    this.markDirty();
  }

  async unregisterProcedure(name: string): Promise<void> {
    if (this.closed) return;
    await this.ensureReady();
    await this.udr.unregisterProcedure(name, this.createUdrExecutor(0));
    this.markDirty();
  }

  private createUdrExecutor(txHandle: EngineHandle) {
    return buildBrowserUdrExecutor(
      this.engine,
      this.dbHandle,
      txHandle,
      this.options.types?.binary === true,
      (params) => this.serialize(params),
    );
  }

  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    return createBrowserPreparedStatement(this.streamsHost, sql);
  }

  async transaction<T>(
    fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    return runBrowserTransaction(
      this.engine,
      this.dbHandle,
      this.options.types,
      this.udr,
      this.liveBridge,
      () => this.markDirty(),
      fn,
      options,
    );
  }

  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    return createBrowserBlobStream(this.storageHost, options);
  }

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
    return openBrowserBlobStream(this.storageHost, sqlOrHandle, paramsOrOptions, maybeOptions);
  }

  async snapshot(
    labelOrOptions?: string | SnapshotOptions,
  ): Promise<DatabaseSnapshot> {
    return captureBrowserSnapshot(this.storageHost, labelOrOptions);
  }

  async restoreSnapshot(
    snapshotOrId: DatabaseSnapshot | string | Uint8Array,
  ): Promise<void> {
    return restoreBrowserSnapshot(this.storageHost, snapshotOrId);
  }

  listSnapshots(): DatabaseSnapshotInfo[] {
    return this.snapshotStore.listSnapshots();
  }

  deleteSnapshot(snapshotOrId: DatabaseSnapshot | string): boolean {
    return this.snapshotStore.deleteSnapshot(snapshotOrId);
  }

  async exportDiff(
    fromSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
    toSnapshot?: DatabaseSnapshot | string | Uint8Array,
    options?: PageDiffOptions,
  ): Promise<Uint8Array> {
    return exportBrowserDiff(this.storageHost, fromSnapshot, toSnapshot, options);
  }

  async applyDiff(
    diffBytes: Uint8Array,
    baseSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
    options: ApplyPageDiffOptions = {},
  ): Promise<Uint8Array> {
    return applyBrowserDiff(this.storageHost, diffBytes, baseSnapshot, options);
  }

  async branch(
    branchName?: string,
    options: BranchOptions = {},
  ): Promise<FirebirdBrowser> {
    const { targetName, mergedOptions } = await prepareBrowserBranchArgs(
      this.fileName,
      this.options,
      this.snapshotStore,
      () => this.snapshot(),
      branchName,
      options,
    );
    return new FirebirdBrowser(targetName, mergedOptions);
  }

  async dumpDataDir(): Promise<Uint8Array> {
    await this.ensureReady();
    return this.engine.readFile(this.dbPath);
  }

  dumpDataStream(options: DataStreamOptions = {}): ReadableStream<Uint8Array> {
    return createBrowserDumpDataStream(this.storageHost, options);
  }

  async loadDataStream(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options: DataStreamOptions = {},
  ): Promise<void> {
    return runBrowserLoadDataStream(this.storageHost, stream, options);
  }

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

  async loadIcuLocaleData(data: Uint8Array | ArrayBufferLike): Promise<void> {
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }
    await this.ensureReady();
    await this.applyIcuLocaleData(data);
  }

  private async applyIcuLocaleData(data: Uint8Array | ArrayBufferLike): Promise<void> {
    return applyBrowserIcuLocaleData(this.engine, data);
  }

  async persist(): Promise<void> {
    return this.persistScheduler.persist();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    return closeBrowserDatabaseFull({
      cancelScheduledPersist: () => this.cancelScheduledPersist(),
      detachLifecycle: () => this.persistScheduler.detachLifecycle(),
      getPersistInFlight: () => this.persistScheduler.persistInFlight,
      preparedStatements: this.preparedStatements,
      liveQueries: this.liveQueries,
      markClosedAndClear: () => {
        this.closed = true;
        this.liveTriggerPromises.clear();
        this.core.clear();
        this.liveBridge.close();
      },
      getDbHandle: () => this.dbHandle,
      resetDbHandle: () => { this.dbHandle = 0; },
      persist: () => this.persist(),
      engine: this.engine,
      dbPath: this.dbPath,
      opfs: this.opfs,
      ephemeral: this.ephemeral,
      closeVfs: () => this.vfs.close(),
      releaseLock: () => this.releaseLock(),
    });
  }

  /** Async resource disposal (`await using db = ...`) (`M18 Item 3`). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    await lock?.release();
  }

  private get mayPersist(): boolean {
    if (this.ephemeral || this.opfs) return false;
    return this.shared === null || this.shared.isLeader;
  }

  private markDirty(): void {
    this.persistScheduler.markDirty();
  }

  private cancelScheduledPersist(): void {
    this.persistScheduler.cancelScheduled();
  }

  private async ensureReady(): Promise<void> {
    if (this.dbHandle) return;
    if (this.closed) throw new Error('FirebirdBrowser instance has been closed');
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
  }

  private async init(): Promise<void> {
    return initializeBrowserDatabase({
      multiTab: this.multiTab,
      dbName: this.dbName,
      fileName: this.fileName,
      lockTimeoutMs: this.lockTimeoutMs,
      opfs: this.opfs,
      ephemeral: this.ephemeral,
      options: this.options,
      engine: this.engine,
      vfs: this.vfs,
      getDbPath: () => this.dbPath,
      getMayPersist: () => this.mayPersist,
      setLock: (l) => { this.lock = l; },
      releaseLock: () => this.releaseLock(),
      setOpfsPath: (p) => { this.opfsPath = p; },
      setDbHandle: (h) => { this.dbHandle = h; },
      applyIcuLocaleData: (d) => this.applyIcuLocaleData(d),
      attachLifecycleListeners: () => this.persistScheduler.attachLifecycle(),
    });
  }

  private async reopenAfterEngineChange(): Promise<void> {
    return reopenBrowserDatabaseAfterEngineChange({
      isClosed: () => this.closed,
      setDbHandle: (h) => { this.dbHandle = h; },
      engine: this.engine,
      dbPath: this.dbPath,
      mayPersist: this.mayPersist,
      exportStored: () => this.vfs.exportDatabase(),
      options: this.options,
      onError: this.onPersistError,
    });
  }
}

