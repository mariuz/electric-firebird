/**
 * firebird-browser.ts – Browser-compatible FirebirdLite backed by WASM + IndexedDB.
 *
 * Provides the same PGlite-style async API as the Node.js `FirebirdLite` class,
 * but runs entirely in the browser using:
 *
 *   1. The Firebird Embedded engine compiled to WebAssembly (see `wasm/`).
 *   2. An IndexedDB-backed virtual filesystem for durable page storage.
 *
 * @example
 * ```ts
 * import { FirebirdBrowser } from 'firebird-wasm/browser';
 *
 * // A browser must run the engine in a Worker — see the `worker` option.
 * const db = new FirebirdBrowser('mydb', {
 *   worker: new Worker('/firebird-engine-worker.js'),
 * });
 *
 * await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR(100))');
 * const result = await db.query('SELECT * FROM t');
 * await db.close();
 * ```
 */

import { IndexedDBVFS } from './indexeddb-vfs';
import { DirectTransport } from './engine-transport';
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
import { hasTransactionOptions } from './isolation';
import { applyTypes, applySerializers } from './value-types';
import { acquireDatabaseLock } from './db-lock';
import { SharedEngineTransport } from './shared-transport';
import type { DatabaseLock } from './db-lock';
import { toStatement, resolveQueryCall, resolveBatchSize } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';
import {
  assertNotAborted,
  DatabaseCoreSubsystems,
  type FirebirdDatabase,
  runWithCancellation,
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
  assertUdrCallback,
  executeArrowFromColumnar,
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
  resolveColumnarQueryCall,
  type QueryArrowOptions,
} from '../shared-driver-ops';
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
  openBrowserDatabaseFile,
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
  /** Path the engine opens.  Set by the OPFS mount, which chooses it. */
  private opfsPath: string | null = null;
  /**
   * Name of the file inside the engine's own filesystem.
   *
   * The same as `dbName` for a stored database. For an ephemeral one it is
   * made unique per instance, so two `memory://` databases in one page cannot
   * land on the same path — the WASM module, and therefore its filesystem, is
   * shared by every instance in a tab.
   */
  private readonly fileName: string;
  private readonly options: FirebirdBrowserOptions;
  private readonly vfs: IndexedDBVFS;
  private readonly engine: EngineTransport;
  private dbHandle: EngineHandle = 0;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  private readonly autoPersist: boolean;
  private readonly autoPersistDebounceMs: number;
  private readonly onPersistError: (error: Error) => void;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight persist, so two never overlap. */
  private persistInFlight: Promise<void> | null = null;
  /** A write arrived while a persist was running; persist again after it. */
  private persistAgain = false;
  private lifecycleAttached = false;

  private readonly multiTab: 'exclusive' | 'shared' | 'allow-unsafe';
  private readonly lockTimeoutMs: number;
  /** Held for the connection's lifetime; released by close(). */
  private lock: DatabaseLock | null = null;
  /** Live queries to tear down with the connection. */
  private readonly liveQueries = new Set<{ unsubscribe(): Promise<void> }>();
  private readonly preparedStatements = new Set<PreparedStatement>();
  /** Cached binary-result shape descriptors for zero-copy `queryColumnar()` (`M19 Item 2`). */
  private readonly columnarShapeCache = new Map<number, readonly FieldInfo[]>();
  /** Per-table auto-installed live trigger promises (table -> event name). */
  private readonly liveTriggerPromises = new Map<string, Promise<string>>();
  /** Shared UDR, copy-on-write snapshot, and query profiler subsystems (`M18 Item 4`). */
  private readonly core: DatabaseCoreSubsystems;
  private get udr() {
    return this.core.udr;
  }
  private get snapshotStore() {
    return this.core.snapshotStore;
  }
  private get profiler() {
    return this.core.profiler;
  }
  /** Cross-tab BroadcastChannel + POST_EVENT live query invalidation bridge. */
  private readonly liveBridge: CrossTabLiveBridge;
  /** Set only in shared mode; owns the election and the channel. */
  private shared: SharedEngineTransport | null = null;

  /**
   * @param dbName  Logical database name.  Used as the IndexedDB store name
   *                and the filename inside Emscripten's virtual FS.
   * @param options Optional configuration.
   */
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

    // An ephemeral database is private to this instance and never stored, so
    // there is nothing for another tab to overwrite and nothing to lock
    // against. Taking the lock anyway would make two tabs queue for a database
    // neither of them shares.
    // OPFS holds the file exclusively itself — a second sync access handle on
    // the same file is refused by the platform — so the Web Lock would be a
    // second, weaker copy of a guarantee already made.
    this.multiTab =
      this.ephemeral || this.opfs ? 'allow-unsafe' : options.multiTab ?? 'exclusive';
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;

    this.autoPersist = options.autoPersist ?? true;
    this.autoPersistDebounceMs = options.autoPersistDebounceMs ?? 500;
    this.onPersistError =
      options.onPersistError ??
      ((error) => console.error('[firebird-wasm] background persist failed', error));

    this.engine = options.transport ?? this.createEngine();
    // Refused here, before anything is opened, rather than after an attach.
    if (options.sharedReads && !this.engine.setSharedReads) {
      throw new Error('sharedReads needs a transport with setSharedReads; this one has none');
    }
  }

  /** Build the real engine for this tab: a Worker if given one, else direct. */
  private createLocalEngine(): EngineTransport {
    const worker = this.options.worker;
    if (worker) {
      return new WorkerTransport(typeof worker === 'function' ? worker() : worker);
    }
    return new DirectTransport({
      wasmBinary: this.options.wasmBinary,
      locateFile: this.options.locateFile,
      threads: this.options.threads,
    });
  }

  private createEngine(): EngineTransport {
    if (this.multiTab !== 'shared') {
      return this.createLocalEngine();
    }

    if (typeof BroadcastChannel === 'undefined') {
      throw new Error(
        "multiTab: 'shared' needs BroadcastChannel, which this environment " +
          "does not have. Use 'exclusive' instead.",
      );
    }

    const shared = new SharedEngineTransport({
      dbName: this.dbName,
      createEngine: () => this.createLocalEngine(),
      // A follower's writes run on the leader's engine, so the leader is the
      // only one that can know its image went stale.
      onServedMutation: () => this.markDirty(),
      onEngineReplaced: () => this.reopenAfterEngineChange(),
    });
    this.shared = shared;
    return shared;
  }

  /**
   * Whether this tab is the one actually running the engine.
   *
   * Always true unless `multiTab: 'shared'`, where exactly one tab owns the
   * engine and the rest are served by it. Useful for deciding which tab should
   * do work that must happen once — an import, a migration, a scheduled
   * cleanup — rather than once per open tab.
   */
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

  /**
   * Execute a single DDL or DML statement and return `{ affectedRows, changes }` (`M18 Item 3`).
   */
  async execute(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: StatementExecutionOptions = {},
  ): Promise<UnifiedExecuteResult> {
    const results = await this.exec(sql, params, options);
    const affectedRows = results.reduce((sum, r) => sum + r.affectedRows, 0);
    return { affectedRows, changes: affectedRows };
  }

  /**
   * Configure Firebird's ODS header `hdr_replica_mode` (`'none'`, `'read_only'`,
   * or `'read_write'`) on this WASM database across `DirectTransport`,
   * `WorkerTransport`, or `SharedEngineTransport` (`M18 Item 1`).
   */
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

  /**
   * Replay a raw `"FBCHANGELOG\0"` binary segment directly through Firebird's
   * native C++ `IAttachment::createReplicator` (`_fb_replicate_changelog`)
   * across `DirectTransport`, `WorkerTransport`, or `SharedEngineTransport` (`M18 Item 1`).
   */
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

  /**
   * One-liner synchronization with another `FirebirdBrowser`/`FirebirdLite`
   * instance, WebRTC `RTCDataChannel`, `WebSocket`, HTTP(S) replication URL,
   * `ws(s)://` URL, or `broadcast://<channel>` URI (`M18 Item 5` / `M19 Item 3`).
   */
  async syncWith(
    peerOrUrl: ReplicableDatabase | string | RtcDataChannelLike | WebSocketLike,
    options: SyncWithOptions = {},
  ): Promise<SyncHandle> {
    await this.ensureReady();
    return syncWithPeer(this, peerOrUrl, options);
  }

  /**
   * Execute one statement once per row of parameters in a single atomic batch.
   */
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

  /**
   * Execute a SQL query and return the result rows.
   *
   * Parameters are bound with `?` placeholders, as in the Node.js backend, or
   * interpolated into a `` sql`…` `` fragment:
   *
   * ```ts
   * await db.query('SELECT * FROM items WHERE id = ?', [1]);
   * await db.query(sql`SELECT * FROM items WHERE id = ${1}`);
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
    const { statement, options } = resolveQueryCall(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    const queryOpts = options as QueryOptions<T>;
    const schema = extractEffectiveQuerySchema<T>(sql, queryOpts);
    assertNotAborted(queryOpts.signal);
    validateTimeoutMs(queryOpts.timeoutMs);

    await this.ensureReady();

    // Without options the engine's own auto-commit transaction is used, which
    // is one fewer round trip to the Worker.  With them, the statement has to
    // run inside a transaction that carries them — matching the Node backend,
    // which starts one for every query.
    const rowMode = queryOpts.rowMode ?? 'object';
    // `types.binary` asks for Uint8Array values; the side channel is how they
    // travel. Same result for the caller, without the base64 round trip.
    const binaryBlobs = this.options.types?.binary === true;

    if (this.udr.hasBridgeRoutines) {
      const rewritten = await this.udr.rewriteStatement(
        statement.sql,
        statement.params,
      );
      statement.sql = rewritten.sql;
      statement.params = rewritten.params;
      const intercepted = await this.udr.queryIfIntercepted<T>(
        statement.sql,
        statement.params,
        rowMode,
        this.createUdrExecutor(0),
      );
      if (intercepted) {
        const typedIntercepted = applyTypes(intercepted, this.options.types, rowMode);
        return finalizeQueryResultWithSchema(typedIntercepted, schema, rowMode);
      }
    }
    if (!hasTransactionOptions(queryOpts)) {
      const startedAt = this.profiler.begin();
      const ioBefore = await this.captureIoIfListening();
      try {
        const raw = await runWithCancellation(
          async () => {
            await this.applyOneShotTimeout(queryOpts.timeoutMs);
            return this.engine.query<T>(
              this.dbHandle,
              0,
              statement.sql,
              this.serialize(statement.params),
              rowMode,
              binaryBlobs,
            );
          },
          queryOpts,
          () => this.cancelOperation(),
        );
        const typed = await finalizeQueryResultWithSchema(
          applyTypes(raw, this.options.types, rowMode),
          schema,
          rowMode,
        );
        const ioAfter = await this.captureIoIfListening();
        this.profiler.end({
          startedAt,
          sql: statement.sql,
          params: statement.params,
          kind: 'query',
          rowCount: typed.rows.length,
          cacheHit: false,
          ioBefore,
          ioAfter,
        });
        return typed;
      } catch (err) {
        this.profiler.end({
          startedAt,
          sql: statement.sql,
          params: statement.params,
          kind: 'query',
          cacheHit: false,
          error: err,
        });
        throw err;
      }
    }

    const startedAt = this.profiler.begin();
    const ioBefore = await this.captureIoIfListening();
    const txHandle = await this.engine.startTransaction(this.dbHandle, queryOpts);
    try {
      const result = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(queryOpts.timeoutMs);
          return this.engine.query<T>(
            this.dbHandle,
            txHandle,
            statement.sql,
            this.serialize(statement.params),
            rowMode,
            binaryBlobs,
          );
        },
        queryOpts,
        () => this.cancelOperation(),
      );
      await this.engine.commit(txHandle);
      const typed = await finalizeQueryResultWithSchema(
        applyTypes(result, this.options.types, rowMode),
        schema,
        rowMode,
      );
      const ioAfter = await this.captureIoIfListening();
      this.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        rowCount: typed.rows.length,
        cacheHit: false,
        ioBefore,
        ioAfter,
      });
      return typed;
    } catch (err) {
      // A failed commit finishes the transaction itself, so only a failure
      // from the query leaves anything to roll back.
      await this.engine.rollback(txHandle).catch(() => undefined);
      this.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        cacheHit: false,
        error: err,
      });
      throw err;
    }
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

  /** Describe a statement's input/output shape without running it. */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    return this.engine.describe(this.dbHandle, 0, toStatement(sql).sql);
  }

  /** Return Firebird's execution plan for `sql` (`IStatement::getPlan`) without executing it. */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    await this.ensureReady();
    return explainBrowserQuery(this.engine, this.dbHandle, sql, options);
  }

  /**
   * Inspect database size, page utilization, ODS version, transaction counters,
   * memory pool usage, and page I/O statistics (`IAttachment::getInfo`).
   */
  async databaseInfo(): Promise<DatabaseInfo> {
    await this.ensureReady();
    return readBrowserDatabaseInfo(this.engine, this.dbHandle);
  }

  /**
   * Subscribe to structured query execution telemetry ({@link QueryProfileEvent}).
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
    return captureBrowserMonitorStats(this.profiler, this.engine, this.dbHandle);
  }

  /** Reset accumulated query profiler counters and clear the recent queries buffer. */
  resetMonitorStats(): void {
    this.profiler.reset();
  }

  private async captureIoIfListening(): Promise<PageIoCounters | null> {
    return captureBrowserPageIo(this.profiler, this.engine, this.dbHandle);
  }

  /**
   * Trigger an immediate database garbage-collection sweep and return
   * before/after {@link DatabaseInfo} diagnostics.
   */
  async sweep(): Promise<SweepResult> {
    await this.ensureReady();
    return runBrowserSweep(
      this.engine,
      this.dbHandle,
      (s) => this.query(s),
      () => this.markDirty(),
    );
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
   * Register a JavaScript scalar function callable inside SQL `SELECT`,
   * `WHERE`, and `COMPUTED BY` expressions.
   *
   * ```ts
   * await db.registerFunction(
   *   'SLUGIFY',
   *   { args: ['VARCHAR(200)'], returns: 'VARCHAR(200)' },
   *   (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
   * );
   * const res = await db.query("SELECT SLUGIFY('Hello World!') AS SLUG FROM RDB$DATABASE");
   * ```
   */
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
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }
    assertUdrCallback('registerFunction', optionsOrFn, maybeFn);
    await this.ensureReady();
    const handle = await this.udr.registerFunction(
      name,
      optionsOrFn,
      maybeFn,
      this.createUdrExecutor(0),
    );
    this.markDirty();
    return handle;
  }

  /**
   * Register a JavaScript table-valued or executable procedure callable inside
   * SQL `SELECT * FROM <name>(...)` and `EXECUTE PROCEDURE <name>(...)`.
   */
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
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }
    assertUdrCallback('registerProcedure', optionsOrFn, maybeFn);
    await this.ensureReady();
    const handle = await this.udr.registerProcedure(
      name,
      optionsOrFn,
      maybeFn,
      this.createUdrExecutor(0),
    );
    this.markDirty();
    return handle;
  }

  /**
   * Unregister a JavaScript user-defined function and drop it from the catalog.
   */
  async unregisterFunction(name: string): Promise<void> {
    if (this.closed) return;
    await this.ensureReady();
    await this.udr.unregisterFunction(name, this.createUdrExecutor(0));
    this.markDirty();
  }

  /**
   * Unregister a JavaScript user-defined procedure and drop it from the catalog.
   */
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

  /**
   * Prepare a SQL statement explicitly and return a reusable
   * {@link PreparedStatement} handle exposing `fields`, `params`, `query()`,
   * `exec()`, `execBatch()`, and `close()`.
   *
   * ```ts
   * const stmt = await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)');
   * // stmt.params → [{ type: 496, typeName: 'INTEGER', … }, { type: 448, typeName: 'VARCHAR', … }]
   * await stmt.exec([1, 'alpha']);
   * await stmt.execBatch([[2, 'beta'], [3, 'gamma']]);
   * await stmt.close();
   * ```
   */
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
    if (!this.dbHandle || !this.mayPersist) return;

    // Two persists must not interleave: both read the image and write the
    // same store, and the later one could finish first and roll the database
    // back to an older state.
    if (this.persistInFlight) {
      this.persistAgain = true;
      await this.persistInFlight;
      return;
    }

    this.cancelScheduledPersist();

    const run = (async () => {
      const image = await this.engine.readFile(this.dbPath);
      await this.vfs.importDatabase(image);
    })();

    this.persistInFlight = run;
    try {
      await run;
    } finally {
      this.persistInFlight = null;
    }

    // Writes that arrived mid-persist are not covered by the image just
    // written, so go again.
    if (this.persistAgain) {
      this.persistAgain = false;
      await this.persist();
    }
  }

  /**
   * Close the database and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    // Stop scheduling before marking closed, so nothing fires mid-teardown.
    this.cancelScheduledPersist();
    this.detachLifecycleListeners();

    // A background persist may still be running; let it finish so it cannot
    // write after the engine has gone.
    if (this.persistInFlight) {
      try {
        await this.persistInFlight;
      } catch {
        // Already reported through onPersistError.
      }
    }

    // Before the handle goes: each one holds a subscription on it, and a
    // timer that would otherwise keep firing at a closed database.
    for (const stmt of [...this.preparedStatements]) {
      await stmt.close().catch(() => undefined);
    }
    for (const live of [...this.liveQueries]) {
      await live.unsubscribe().catch(() => undefined);
    }

    this.closed = true;
    this.liveTriggerPromises.clear();
    this.core.clear();
    this.liveBridge.close();

    if (this.dbHandle) {
      // Persist before closing.
      await this.persist();
      await this.engine.detachDatabase(this.dbHandle);
      this.dbHandle = 0;
    }

    try {
      if (this.opfs) {
        // Sync access handle is released with the module.
      } else if (this.ephemeral) {
        await this.engine.unlink(this.dbPath).catch(() => undefined);
      } else {
        await this.vfs.close();
      }
      await this.engine.dispose();
    } finally {
      await this.releaseLock();
    }
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
    if (!this.autoPersist || this.closed || !this.mayPersist) return;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistInBackground();
    }, this.autoPersistDebounceMs);
  }

  private cancelScheduledPersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private async persistInBackground(): Promise<void> {
    if (this.closed) return;
    try {
      await this.persist();
    } catch (err) {
      this.onPersistError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private attachLifecycleListeners(): void {
    if (this.lifecycleAttached || !this.autoPersist) return;
    if (typeof document === 'undefined' || typeof addEventListener !== 'function') {
      return;
    }
    this.lifecycleAttached = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    addEventListener('pagehide', this.onPageHide);
  }

  private detachLifecycleListeners(): void {
    if (!this.lifecycleAttached) return;
    this.lifecycleAttached = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    removeEventListener('pagehide', this.onPageHide);
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.cancelScheduledPersist();
      void this.persistInBackground();
    }
  };

  private readonly onPageHide = (): void => {
    this.cancelScheduledPersist();
    void this.persistInBackground();
  };

  private async ensureReady(): Promise<void> {
    if (this.dbHandle) return;
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    await this.initPromise;
  }

  private async init(): Promise<void> {
    if (this.multiTab === 'exclusive') {
      this.lock = await acquireDatabaseLock(this.dbName, {
        timeoutMs: this.lockTimeoutMs,
      });
    }
    try {
      await this.engine.init();
      if (this.options.icuLocaleData) {
        const localeBytes =
          typeof this.options.icuLocaleData === 'function'
            ? await this.options.icuLocaleData()
            : this.options.icuLocaleData;
        await this.applyIcuLocaleData(localeBytes);
      }
      if (this.opfs) {
        this.opfsPath = await this.engine.mountOpfs(this.fileName);
      } else if (!this.ephemeral) {
        await this.vfs.open(this.dbName);
      }
      await this.openDatabase();
    } catch (err) {
      await this.releaseLock();
      throw err;
    }
    this.attachLifecycleListeners();
  }

  private async openDatabase(): Promise<void> {
    this.dbHandle = await openBrowserDatabaseFile({
      engine: this.engine,
      dbPath: this.dbPath,
      mayPersist: this.mayPersist,
      exportStored: () => this.vfs.exportDatabase(),
      loadDataDir: this.options.loadDataDir,
      loadDataStream: this.options.loadDataStream,
      sharedReads: this.options.sharedReads,
    });
  }

  private async reopenAfterEngineChange(): Promise<void> {
    if (this.closed) return;
    this.dbHandle = 0;
    try {
      await this.openDatabase();
    } catch (err) {
      this.onPersistError(
        err instanceof Error
          ? err
          : new Error(`could not reopen after a leadership change: ${String(err)}`),
      );
    }
  }
}

