import * as fs from 'fs';
import { Blob as FbBlob, TransactionIsolation } from 'node-firebird-driver';
import type { Client, Attachment, Statement, Transaction } from 'node-firebird-driver';
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
  FieldInfo,
} from './types';
import { statementKind } from './statement-types';
import {
  compressGzipStream,
  readDatabaseStreamChunks,
  resolveStreamChunkSize,
} from './browser/data-stream';
import {
  DATABASE_INFO_REQUEST_ITEMS,
  parseDatabaseInfoBuffer,
  normalizeDatabaseInfo,
  buildSweepResult,
} from './browser/engine-transport';
import { applyTypes, applySerializers } from './browser/value-types';
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
  createTimeoutError,
  DatabaseCoreSubsystems,
  type FirebirdDatabase,
  runWithCancellation,
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
  extractReferencedTables,
  liveTableEventName,
} from './browser/live-tables';
import {
  executePipelineFallback,
  normalizePipelineOperations,
  type PipelineOperation,
  type PipelineOptions,
  type PipelineResults,
} from './pipeline';
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
  assertBatchParameterRows,
  assertPreparedParamCount,
  assertUdrCallback,
  executeArrowFromColumnar,
  executeColumnarViaArrayQuery,
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
  resolveColumnarQueryCall,
  resolvePreparedCallArgs,
  runDriverApplyDiff,
  runDriverExportDiff,
  scanUserTablesForSweep,
  type QueryArrowOptions,
} from './shared-driver-ops';
import type {
  JsFunctionHandler,
  JsProcedureHandler,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  RegisteredRoutine,
  MonitorStats,
  QueryProfileListener,
} from './types';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobSegmentSize,
} from './browser/blob-stream';
import type { TypeOptions } from './browser/value-types';
import { toStatement, resolveQueryCall, resolveBatchSize } from './sql-tag';
import type { SqlFragment, Statement as ParsedStatement } from './sql-tag';
import {
  type ArrayModeOptions,
  type ArrayStreamOptions,
} from './database-core';
import {
  STMT_SELECT,
  StatementCache,
  type StatementLease,
  applyStatementHandleTimeout,
  bindParams,
  buildTransactionOptions,
  cancelAttachmentOperation,
  describeInputFields,
  explainStatement,
  fetchRows,
  loadNativeDriver,
  openNativeQueryBlobStream,
  outputFields,
  readAffectedRecords,
  shapeRows,
  streamRows,
  tryExecuteNativeBatch,
} from './node-native-bindings';
import { FirebirdTransaction } from './firebird-tx';
export { FirebirdTransaction } from './firebird-tx';

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

  /**
   * Execute a DDL or DML statement that does not return rows.
   *
   * The statement is executed in its own auto-committed transaction.
   *
   * Accepts a `` sql`…` `` fragment in place of a string, in which case its
   * values are bound rather than interpolated.
   */
  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<void> {
    const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
    const options = Array.isArray(paramsOrOptions)
      ? maybeOptions
      : (paramsOrOptions ?? {});
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    // Delegated rather than reimplemented: "parameters present → prepare,
    // execute, dispose; otherwise execute directly" is a rule that belongs in
    // one place, and `transaction()` already wraps it in the commit-or-roll-
    // back this needs. Two copies would drift the first time either grows a
    // case.
    const script = toStatement(sql, params);
    const startedAt = this.profiler.begin();
    try {
      await this.transaction((tx) => tx.exec(sql, params, options));
      this.profiler.end({
        startedAt,
        sql: script.sql,
        params: script.params,
        kind: 'exec',
        rowCount: 0,
        cacheHit: false,
      });
    } catch (err) {
      this.profiler.end({
        startedAt,
        sql: script.sql,
        params: script.params,
        kind: 'exec',
        cacheHit: false,
        error: err,
      });
      throw err;
    }
  }

  /**
   * Execute a single DDL or DML statement and return `{ affectedRows, changes }` (`M18 Item 3`).
   */
  async execute(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: StatementExecutionOptions = {},
  ): Promise<UnifiedExecuteResult> {
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    const script = toStatement(sql, params);
    const startedAt = this.profiler.begin();
    try {
      const res = await this.transaction((tx) => tx.execute(sql, params, options));
      this.profiler.end({
        startedAt,
        sql: script.sql,
        params: script.params,
        kind: 'exec',
        rowCount: res.affectedRows,
        cacheHit: false,
      });
      return res;
    } catch (err) {
      this.profiler.end({
        startedAt,
        sql: script.sql,
        params: script.params,
        kind: 'exec',
        cacheHit: false,
        error: err,
      });
      throw err;
    }
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
   * Execute one statement once per row of parameters: a batch, prepared once
   * and executed per row in one transaction, all or nothing.  The same call
   * as the browser backend's.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<void> {
    const startedAt = this.profiler.begin();
    try {
      await this.transaction((tx) => tx.execBatch(sql, rows));
      this.profiler.end({
        startedAt,
        sql,
        params: rows[0] ?? [],
        kind: 'execBatch',
        rowCount: rows.length,
        cacheHit: rows.length > 1,
      });
    } catch (err) {
      this.profiler.end({
        startedAt,
        sql,
        params: rows[0] ?? [],
        kind: 'execBatch',
        cacheHit: rows.length > 1,
        error: err,
      });
      throw err;
    }
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
    const events: string[] =
      explicitEvents !== undefined
        ? [...explicitEvents]
        : (() => {
            const tables = extractReferencedTables(sqlText);
            if (tables.length === 0) {
              throw new RangeError(
                'liveIncremental() / liveColumnar() could not infer any user tables from SQL; pass { events: [...] } explicitly',
              );
            }
            return tables.map((t) => liveTableEventName(t));
          })();

    for (const ev of events) {
      let set = this.liveEventListeners.get(ev);
      if (!set) {
        set = new Set();
        this.liveEventListeners.set(ev, set);
      }
      set.add(onWakeup);
    }

    const intervalMs = options.pollIntervalMs ?? 250;
    const pollTimer =
      intervalMs > 0 ? setInterval(() => onWakeup(), intervalMs) : null;
    if (pollTimer && typeof (pollTimer as { unref?: () => void }).unref === 'function') {
      (pollTimer as { unref: () => void }).unref();
    }

    return async () => {
      if (pollTimer) clearInterval(pollTimer);
      for (const ev of events) {
        const set = this.liveEventListeners.get(ev);
        if (set) {
          set.delete(onWakeup);
          if (set.size === 0) this.liveEventListeners.delete(ev);
        }
      }
    };
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
    const { statement, options } = resolveQueryCall(sql, paramsOrOptions, maybeOptions);
    const queryOpts = options as QueryOptions<T>;
    const schema = extractEffectiveQuerySchema<T>(sql, queryOpts);
    assertNotAborted(queryOpts.signal);
    validateTimeoutMs(queryOpts.timeoutMs);

    await this.ensureReady();
    const rowMode: RowMode = queryOpts.rowMode ?? 'object';
    if (this.udr.hasBridgeRoutines) {
      const rewritten = await this.udr.rewriteStatement(
        statement.sql,
        this.serialize(statement.params),
      );
      statement.sql = rewritten.sql;
      statement.params = rewritten.params;
      const intercepted = await this.udr.queryIfIntercepted<T>(
        statement.sql,
        statement.params,
        rowMode,
        this.createUdrExecutor(),
      );
      if (intercepted) {
        return finalizeQueryResultWithSchema(
          applyTypes(intercepted, this.types, rowMode),
          schema,
          rowMode,
        );
      }
    }
    const attachment = this.attachment!;

    const startedAt = this.profiler.begin();
    let cacheHit = false;
    try {
      if (
        this.sharedReads &&
        queryOpts.isolationLevel === undefined &&
        queryOpts.readOnly === undefined &&
        queryOpts.signal === undefined &&
        queryOpts.timeoutMs === undefined &&
        !this.ownTransaction.has(statement.sql)
      ) {
        const shared = await this.sharedRead<T>(statement.sql, statement.params, rowMode);
        if (shared) {
          const validatedShared = await finalizeQueryResultWithSchema(
            shared.result,
            schema,
            rowMode,
          );
          this.profiler.end({
            startedAt,
            sql: statement.sql,
            params: statement.params,
            kind: 'query',
            rowCount: validatedShared.rows.length,
            cacheHit: shared.cacheHit,
          });
          return validatedShared;
        }
      }
      await this.endReadTransaction();

      const serializedParams = this.serialize(statement.params);
      const txOptions = buildTransactionOptions(queryOpts);
      const transaction = await attachment.startTransaction(txOptions);

      let rows: T[];
      let fields: FieldInfo[];
      try {
        const lease = await this.statements!.acquire(transaction, statement.sql);
        cacheHit = lease.cacheHit;
        const stmt = lease.stmt;

        // Released in `finally`, not after the fetch: a statement that throws on
        // execute — a lock conflict, an overflow, a wrong parameter count — would
        // otherwise leak its handle, and the retry loop such failures are usually
        // wrapped in leaks one per attempt until the attachment refuses more.
        let failed = true;
        try {
          fields = await outputFields(stmt);
          if (queryOpts.timeoutMs !== undefined && queryOpts.timeoutMs > 0) {
            await applyStatementHandleTimeout(stmt, queryOpts.timeoutMs);
          }

          const rawRows = await runWithCancellation(
            () => fetchRows(stmt, transaction, serializedParams, fields, this.types),
            queryOpts,
            () => this.cancelOperation(),
          );
          rows = shapeRows<T>(rawRows, fields, rowMode);
          failed = false;
        } finally {
          if (queryOpts.timeoutMs !== undefined && queryOpts.timeoutMs > 0 && !failed) {
            await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
          }
          await lease.release(failed);
        }

        // After the statement is disposed, as before — the commit is the last
        // thing that happens on the success path.
        try {
          await transaction.commit();
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      const typed = await finalizeQueryResultWithSchema(
        applyTypes({ rows, fields }, this.types, rowMode),
        schema,
        rowMode,
      );
      this.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        rowCount: typed.rows.length,
        cacheHit,
      });
      return typed;
    } catch (err) {
      this.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        cacheHit,
        error: err,
      });
      throw err;
    }
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

  private async *streamQuery<T>(
    statement: ParsedStatement,
    options: QueryStreamOptions,
    batchSize: number,
  ): AsyncIterableIterator<QueryResult<T>> {
    assertNotAborted(options.signal);
    const totalTimeoutMs = validateTimeoutMs(options.timeoutMs);
    const deadline =
      totalTimeoutMs && totalTimeoutMs > 0
        ? Date.now() + totalTimeoutMs
        : undefined;
    const checkStreamDeadline = (): void => {
      assertNotAborted(options.signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw createTimeoutError(totalTimeoutMs!);
      }
    };

    await this.ensureReady();
    const rowMode: RowMode = options.rowMode ?? 'object';
    const attachment = this.attachment!;
    await this.endReadTransaction();

    const serializedParams = this.serialize(statement.params);
    const txOptions = buildTransactionOptions(options);
    const transaction = await attachment.startTransaction(txOptions);

    let engineFailed = false;
    let lease: StatementLease | undefined;
    let txFinished = false;

    try {
      try {
        lease = await this.statements!.acquire(transaction, statement.sql);
      } catch (err) {
        engineFailed = true;
        throw err;
      }
      const stmt = lease.stmt;

      let fields: FieldInfo[];
      try {
        fields = await outputFields(stmt);
        if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
          await applyStatementHandleTimeout(stmt, totalTimeoutMs);
        }
      } catch (err) {
        engineFailed = true;
        throw err;
      }

      for await (const batch of streamRows<T>(
        stmt,
        transaction,
        serializedParams,
        fields,
        rowMode,
        batchSize,
        this.types,
        () => {
          engineFailed = true;
        },
      )) {
        checkStreamDeadline();
        yield batch;
        checkStreamDeadline();
      }

      if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
        await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
      }
      const toRelease = lease;
      lease = undefined;
      await toRelease.release(false);

      txFinished = true;
      try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
    } finally {
      if (lease) {
        await lease.release(engineFailed);
      }
      if (!txFinished) {
        if (engineFailed) {
          await transaction.rollback().catch(() => undefined);
        } else {
          await transaction
            .commit()
            .catch(() => transaction.rollback().catch(() => undefined));
        }
      }
    }
  }

  /**
   * Run a SELECT in the shared read-only transaction, starting it if need be.
   *
   * `undefined` means "run it in a transaction of its own": the statement is
   * not a SELECT, or it tried to write ("attempted update during read-only
   * transaction"). Either way its text is remembered, so the next call goes
   * there directly. Any other failure ends the shared transaction, so the
   * next read starts afresh, and is thrown.
   */
  private async sharedRead<T>(
    sql: string,
    params: QueryParams,
    rowMode: RowMode,
  ): Promise<{ result: QueryResult<T>; cacheHit: boolean } | undefined> {
    const serializedParams = this.serialize(params);
    const attachment = this.attachment!;
    this.readTransaction ??= await attachment.startTransaction({
      isolation: TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      accessMode: 'READ_ONLY',
    });
    const transaction = this.readTransaction;

    let lease: StatementLease;
    try {
      lease = await this.statements!.acquire(transaction, sql);
    } catch (err) {
      await this.endReadTransaction();
      throw err;
    }
    const stmt = lease.stmt;
    // A writing SELECT stays kept: only the transaction was wrong for it.
    let failed = false;
    let fields: FieldInfo[];
    let rawRows: unknown[][];
    try {
      if ((await stmt.type) !== STMT_SELECT) {
        this.remember(sql);
        return undefined;
      }
      fields = await outputFields(stmt);
      rawRows = await fetchRows(stmt, transaction, serializedParams, fields, this.types);
    } catch (err) {
      // The native driver's errors carry only the message text.
      if (/attempted update during read-only transaction/.test(String((err as Error)?.message))) {
        this.remember(sql);
        return undefined;
      }
      failed = true;
      await this.endReadTransaction();
      throw err;
    } finally {
      await lease.release(failed);
    }
    return {
      result: applyTypes({ rows: shapeRows<T>(rawRows, fields, rowMode), fields }, this.types, rowMode),
      cacheHit: lease.cacheHit,
    };
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

  /**
   * Describe a statement's shape without running it.
   *
   * ```ts
   * const shape = await db.describeQuery('SELECT id, name FROM items WHERE id = ?');
   * // shape.params        → [{ name: '', type: 496, typeName: 'INTEGER', ... }]
   * // shape.fields        → [{ name: 'ID', type: 496, typeName: 'INTEGER', ... }, ...]
   * // shape.statementType → 'SELECT'
   * ```
   *
   * The statement is prepared and disposed, so nothing runs: describing an
   * `INSERT` inserts nothing. Both `params` and `fields` carry the full
   * {@link FieldInfo} from Firebird's prepared input and output metadata.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const text = toStatement(sql).sql;

    const transaction = await attachment.startTransaction();
    try {
      const stmt = await attachment.prepare(transaction, text);
      try {
        const params = await describeInputFields(stmt);
        const fields = await outputFields(stmt);
        const type = await stmt.type;

        return {
          params,
          fields,
          statementType: statementKind(type),
          hasResultSet: stmt.hasResultSet,
        };
      } finally {
        await stmt.dispose().catch(() => undefined);
      }
    } finally {
      // Nothing ran, so there is nothing to commit — but the transaction still
      // has to be finished.
      await transaction.commit().catch(() => undefined);
    }
  }

  /**
   * Return Firebird's execution plan for `sql` (`IStatement::getPlan`) without
   * executing the statement.
   *
   * By default (`{ detailed: false }`), returns the compact `PLAN (...)` string.
   * With `{ detailed: true }`, returns Firebird 5/6's structured multi-line
   * explained plan tree (`Select Expression\n    -> ...`). Statements that carry
   * no execution plan (such as DDL) return `""`.
   */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const text = toStatement(sql).sql;
    const detailed = options.detailed === true;

    const transaction = await attachment.startTransaction();
    try {
      const stmt = await attachment.prepare(transaction, text);
      try {
        return await explainStatement(stmt, detailed);
      } finally {
        await stmt.dispose().catch(() => undefined);
      }
    } finally {
      await transaction.commit().catch(() => undefined);
    }
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
    const attachment = this.attachment as unknown as {
      attachmentHandle?: {
        getInfoAsync?: (
          status: unknown,
          itemsLength: number,
          items: Uint8Array,
          bufferLength: number,
          buffer: Uint8Array,
        ) => Promise<void>;
        getInfoSync?: (
          status: unknown,
          itemsLength: number,
          items: Uint8Array,
          bufferLength: number,
          buffer: Uint8Array,
        ) => void;
      };
      client?: {
        statusAction?: <T>(fn: (status: unknown) => Promise<T>) => Promise<T>;
      };
    };

    const client = attachment?.client;
    const getInfoAsync = attachment?.attachmentHandle?.getInfoAsync;
    const getInfoSync = attachment?.attachmentHandle?.getInfoSync;

    if (typeof client?.statusAction === 'function' && typeof getInfoAsync === 'function') {
      return client.statusAction(async (status) => {
        const buffer = new Uint8Array(512);
        await getInfoAsync.call(
          attachment.attachmentHandle,
          status,
          DATABASE_INFO_REQUEST_ITEMS.byteLength,
          DATABASE_INFO_REQUEST_ITEMS,
          buffer.byteLength,
          buffer,
        );
        return parseDatabaseInfoBuffer(buffer);
      });
    }
    if (typeof client?.statusAction === 'function' && typeof getInfoSync === 'function') {
      return client.statusAction(async (status) => {
        const buffer = new Uint8Array(512);
        getInfoSync.call(
          attachment.attachmentHandle,
          status,
          DATABASE_INFO_REQUEST_ITEMS.byteLength,
          DATABASE_INFO_REQUEST_ITEMS,
          buffer.byteLength,
          buffer,
        );
        return parseDatabaseInfoBuffer(buffer);
      });
    }

    const dbRes = await this.query<Record<string, unknown>>(
      'SELECT MON$PAGE_SIZE, MON$PAGES, MON$ODS_MAJOR, MON$ODS_MINOR, ' +
        'MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$OLDEST_SNAPSHOT, ' +
        'MON$NEXT_TRANSACTION, MON$PAGE_BUFFERS FROM MON$DATABASE',
    );
    const dbRow = dbRes.rows[0] ?? {};
    let currentMemory = 0;
    let maxMemory = 0;
    let reads = 0;
    let writes = 0;
    let fetches = 0;
    let marks = 0;
    try {
      const memRes = await this.query<Record<string, unknown>>(
        'SELECT MON$MEMORY_USED, MON$MEMORY_MAX_USED FROM MON$MEMORY_USAGE WHERE MON$STAT_GROUP = 0',
      );
      const memRow = memRes.rows[0] ?? {};
      currentMemory = Number(memRow['MON$MEMORY_USED'] ?? 0);
      maxMemory = Number(memRow['MON$MEMORY_MAX_USED'] ?? 0);
    } catch {
      // Optional monitoring table
    }
    try {
      const ioRes = await this.query<Record<string, unknown>>(
        'SELECT MON$PAGE_READS, MON$PAGE_WRITES, MON$PAGE_FETCHES, MON$PAGE_MARKS FROM MON$IO_STATS WHERE MON$STAT_GROUP = 0',
      );
      const ioRow = ioRes.rows[0] ?? {};
      reads = Number(ioRow['MON$PAGE_READS'] ?? 0);
      writes = Number(ioRow['MON$PAGE_WRITES'] ?? 0);
      fetches = Number(ioRow['MON$PAGE_FETCHES'] ?? 0);
      marks = Number(ioRow['MON$PAGE_MARKS'] ?? 0);
    } catch {
      // Optional monitoring table
    }
    return normalizeDatabaseInfo({
      pageSize: Number(dbRow['MON$PAGE_SIZE'] ?? 0),
      allocatedPages: Number(dbRow['MON$PAGES'] ?? 0),
      odsVersion: Number(dbRow['MON$ODS_MAJOR'] ?? 0),
      odsMinorVersion: Number(dbRow['MON$ODS_MINOR'] ?? 0),
      oldestTransaction: Number(dbRow['MON$OLDEST_TRANSACTION'] ?? 0),
      oldestActive: Number(dbRow['MON$OLDEST_ACTIVE'] ?? 0),
      oldestSnapshot: Number(dbRow['MON$OLDEST_SNAPSHOT'] ?? 0),
      nextTransaction: Number(dbRow['MON$NEXT_TRANSACTION'] ?? 0),
      currentMemory,
      maxMemory,
      pageBuffers: Number(dbRow['MON$PAGE_BUFFERS'] ?? 0),
      reads,
      writes,
      fetches,
      marks,
    });
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

  /**
   * Trigger an immediate database garbage-collection sweep, scanning user
   * tables to collect old record versions and advancing OIT/OAT counters.
   */
  async sweep(): Promise<SweepResult> {
    await this.ensureReady();
    const started = performance.now();
    await this.endReadTransaction();
    const before = await this.databaseInfo();
    const tablesScanned = await scanUserTablesForSweep((s) => this.query(s));

    await this.endReadTransaction();
    const attachment = this.attachment!;
    const tx = await attachment.startTransaction();
    await tx.commit().catch(() => tx.rollback().catch(() => undefined));

    const after = await this.databaseInfo();
    return buildSweepResult(before, after, tablesScanned, performance.now() - started);
  }

  /**
   * Prepare a SQL statement explicitly and return a reusable
   * {@link PreparedStatement} handle exposing `fields`, `params`, `query()`,
   * `exec()`, `execBatch()`, and `close()`.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const sqlText = toStatement(sql).sql;

    const prepareTx = await attachment.startTransaction();
    let nativeStmt: Statement;
    let params: FieldInfo[];
    let fields: FieldInfo[];
    let type: number;
    try {
      nativeStmt = await attachment.prepare(prepareTx, sqlText);
      try {
        params = await describeInputFields(nativeStmt);
        fields = await outputFields(nativeStmt);
        type = await nativeStmt.type;
      } catch (err) {
        await nativeStmt.dispose().catch(() => undefined);
        throw err;
      }
    } finally {
      await prepareTx.commit().catch(() => undefined);
    }

    const statementType = statementKind(type);
    const hasResultSet = nativeStmt.hasResultSet;
    let isClosed = false;
    let busy = false;
    let currentTimeoutMs = 0;
    const isDbClosed = () => this.closed;

    const assertOpen = (): void => {
      if (isClosed || this.closed) {
        throw new Error('PreparedStatement has been closed');
      }
    };

    const checkParamCount = (actual: number): void => {
      assertPreparedParamCount(params.length, actual);
    };

    const withStatement = async <R>(
      transaction: Transaction,
      fn: (target: Statement) => Promise<R>,
    ): Promise<R> => {
      if (!busy) {
        busy = true;
        try {
          return await fn(nativeStmt);
        } finally {
          busy = false;
          if (isClosed) {
            await nativeStmt.dispose().catch(() => undefined);
          }
        }
      }
      const tempStmt = await attachment.prepare(transaction, sqlText);
      try {
        if (currentTimeoutMs > 0) {
          await applyStatementHandleTimeout(tempStmt, currentTimeoutMs);
        }
        return await fn(tempStmt);
      } finally {
        await tempStmt.dispose().catch(() => undefined);
      }
    };

    const stmt: PreparedStatement = {
      sql: sqlText,
      get params() {
        return params.map((p) => ({ ...p }));
      },
      get fields() {
        return fields.map((f) => ({ ...f }));
      },
      statementType,
      hasResultSet,
      get closed() {
        return isClosed || isDbClosed();
      },
      get timeoutMs() {
        return currentTimeoutMs;
      },
      setTimeout: async (timeoutMs: number) => {
        assertOpen();
        const validated = validateTimeoutMs(timeoutMs) ?? 0;
        currentTimeoutMs = validated;
        await applyStatementHandleTimeout(nativeStmt, validated);
      },
      query: (async <T = Row>(
        paramsOrOptions: QueryParams | QueryOptions<T> = [],
        maybeOptions: QueryOptions<T> = {},
      ): Promise<QueryResult<T>> => {
        assertOpen();
        const { callParams, rawOptions, callOptions } = resolvePreparedCallArgs<QueryOptions<T>>(
          paramsOrOptions,
          maybeOptions,
          currentTimeoutMs,
        );
        checkParamCount(callParams.length);
        assertNotAborted(callOptions.signal);
        validateTimeoutMs(callOptions.timeoutMs);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const serializedParams = this.serialize(callParams);
        await this.endReadTransaction();
        const txOptions = buildTransactionOptions(callOptions);
        const transaction = await attachment.startTransaction(txOptions);
        try {
          const rawRows = await withStatement(transaction, async (target) => {
            const hasPerCallTimeout =
              rawOptions.timeoutMs !== undefined && rawOptions.timeoutMs !== currentTimeoutMs;
            if (hasPerCallTimeout) {
              await applyStatementHandleTimeout(target, rawOptions.timeoutMs);
            }
            try {
              return await runWithCancellation(
                () => fetchRows(target, transaction, serializedParams, fields, this.types),
                callOptions,
                () => this.cancelOperation(),
              );
            } finally {
              if (hasPerCallTimeout && target === nativeStmt) {
                await applyStatementHandleTimeout(target, currentTimeoutMs).catch(() => undefined);
              }
            }
          });
          try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          const outFields = fields.map((f) => ({ ...f }));
          return finalizeQueryResultWithSchema(
            applyTypes(
              { rows: shapeRows<T>(rawRows, outFields, rowMode), fields: outFields },
              this.types,
              rowMode,
            ),
            callOptions.schema,
            rowMode,
          );
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      }) as PreparedStatement['query'],
      queryStream: (<T = Row>(
        paramsOrOptions: QueryParams | QueryStreamOptions = [],
        maybeOptions: QueryStreamOptions = {},
      ): AsyncIterableIterator<QueryResult<T>> => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const rawOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        const callOptions: QueryStreamOptions =
          rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...rawOptions, timeoutMs: currentTimeoutMs }
            : rawOptions;
        checkParamCount(callParams.length);
        validateTimeoutMs(callOptions.timeoutMs);
        const batchSize = resolveBatchSize(callOptions.batchSize);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const serializeParams = () => this.serialize(callParams);
        const endReadTx = () => this.endReadTransaction();
        const customTypes = this.types;

        return (async function* (): AsyncIterableIterator<QueryResult<T>> {
          assertOpen();
          assertNotAborted(callOptions.signal);
          const totalTimeoutMs = validateTimeoutMs(callOptions.timeoutMs);
          const deadline =
            totalTimeoutMs && totalTimeoutMs > 0
              ? Date.now() + totalTimeoutMs
              : undefined;
          const checkStreamDeadline = (): void => {
            assertNotAborted(callOptions.signal);
            if (deadline !== undefined && Date.now() >= deadline) {
              throw createTimeoutError(totalTimeoutMs!);
            }
          };

          const serializedParams = serializeParams();
          await endReadTx();
          const txOptions = buildTransactionOptions(callOptions);
          const transaction = await attachment.startTransaction(txOptions);

          let engineFailed = false;
          let txFinished = false;
          let claimedPrimary = false;
          let tempStmt: Statement | undefined;

          try {
            let target: Statement;
            if (!busy) {
              busy = true;
              claimedPrimary = true;
              target = nativeStmt;
            } else {
              try {
                tempStmt = await attachment.prepare(transaction, sqlText);
              } catch (err) {
                engineFailed = true;
                throw err;
              }
              target = tempStmt;
            }

            if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
              await applyStatementHandleTimeout(target, totalTimeoutMs);
            }

            for await (const batch of streamRows<T>(
              target,
              transaction,
              serializedParams,
              fields,
              rowMode,
              batchSize,
              customTypes,
              () => {
                engineFailed = true;
              },
            )) {
              checkStreamDeadline();
              yield batch;
              checkStreamDeadline();
            }

            if (claimedPrimary && totalTimeoutMs !== undefined && totalTimeoutMs !== currentTimeoutMs) {
              await applyStatementHandleTimeout(nativeStmt, currentTimeoutMs).catch(() => undefined);
            }

            if (tempStmt) {
              const toDispose = tempStmt;
              tempStmt = undefined;
              await toDispose.dispose().catch(() => undefined);
            }
            if (claimedPrimary) {
              claimedPrimary = false;
              busy = false;
              if (isClosed) {
                await nativeStmt.dispose().catch(() => undefined);
              }
            }

            txFinished = true;
            try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          } finally {
            if (tempStmt) {
              await tempStmt.dispose().catch(() => undefined);
            }
            if (claimedPrimary) {
              busy = false;
              if (isClosed) {
                await nativeStmt.dispose().catch(() => undefined);
              }
            }
            if (!txFinished) {
              if (engineFailed) {
                await transaction.rollback().catch(() => undefined);
              } else {
                await transaction
                  .commit()
                  .catch(() => transaction.rollback().catch(() => undefined));
              }
            }
          }
        })();
      }) as PreparedStatement['queryStream'],
      exec: async (
        callParams: QueryParams = [],
        execOptions: StatementExecutionOptions = {},
      ) => {
        assertOpen();
        checkParamCount(callParams.length);
        const effectiveOptions: StatementExecutionOptions =
          execOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...execOptions, timeoutMs: currentTimeoutMs }
            : execOptions;
        assertNotAborted(effectiveOptions.signal);
        validateTimeoutMs(effectiveOptions.timeoutMs);
        const serializedParams = this.serialize(callParams);
        await this.endReadTransaction();
        const transaction = await attachment.startTransaction();
        try {
          const affectedRows = await withStatement(transaction, async (target) => {
            const hasPerCallTimeout =
              execOptions.timeoutMs !== undefined && execOptions.timeoutMs !== currentTimeoutMs;
            if (hasPerCallTimeout) {
              await applyStatementHandleTimeout(target, execOptions.timeoutMs);
            }
            try {
              await runWithCancellation(
                async () => {
                  await target.execute(
                    transaction,
                    await bindParams(target, transaction, serializedParams),
                  );
                },
                effectiveOptions,
                () => this.cancelOperation(),
              );
              return readAffectedRecords(target);
            } finally {
              if (hasPerCallTimeout && target === nativeStmt) {
                await applyStatementHandleTimeout(target, currentTimeoutMs).catch(() => undefined);
              }
            }
          });
          try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          return { affectedRows };
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        assertBatchParameterRows(rows, params.length);
        if (rows.length === 0) return { affectedRows: 0 };
        const serializedRows = this.types?.serializers?.length
          ? rows.map((row) => this.serialize(row))
          : rows;
        await this.endReadTransaction();
        const transaction = await attachment.startTransaction();
        try {
          const affectedRows = await withStatement(transaction, async (target) => {
            if (
              serializedRows.length > 1 &&
              (await tryExecuteNativeBatch(target, transaction, serializedRows))
            ) {
              return serializedRows.length;
            }
            let total = 0;
            for (const row of serializedRows) {
              await target.execute(
                transaction,
                await bindParams(target, transaction, row),
              );
              total += (await readAffectedRecords(target)) || 1;
            }
            return total;
          });
          try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          return { affectedRows };
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        this.preparedStatements.delete(stmt);
        if (!busy) {
          await nativeStmt.dispose().catch(() => undefined);
        }
      },
      [Symbol.asyncDispose]: async () => {
        await stmt.close();
      },
    };

    this.preparedStatements.add(stmt);
    return stmt;
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
    const attachment = this.attachment!;
    const txOptions = buildTransactionOptions(options);
    await this.endReadTransaction();
    const transaction = await attachment.startTransaction(txOptions);

    // A shared read made from inside the callback starts the shared
    // transaction again; each statement here ends it first.
    const tx = new FirebirdTransaction(
      attachment,
      transaction,
      () => this.endReadTransaction(),
      this.statements ?? undefined,
      this.types,
      undefined,
      undefined,
      this.udr,
    );

    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      // The callback may have rolled back before throwing; rolling back twice
      // targets a transaction the driver has already finished with.
      if (!tx.isFinished) {
        await transaction.rollback().catch(() => undefined);
      }
      throw err;
    }

    // A callback that rolled back deliberately must not then be committed.
    if (tx.isFinished) {
      return result;
    }

    try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
    for (const tbl of tx.committedTables) {
      this.dispatchLocalEvent(liveTableEventName(tbl));
    }
    return result;
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
    await this.ensureReady();
    resolveBlobSegmentSize(options.segmentSize, true);

    const chunks: Uint8Array[] = [];
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          chunks.push(segment.slice());
        },
        close: async (totalBytes) => {
          const stagedBytes = new Uint8Array(totalBytes);
          let pos = 0;
          for (const c of chunks) {
            stagedBytes.set(c, pos);
            pos += c.byteLength;
          }
          return createBlobHandle(new Uint8Array(8), totalBytes, {
            stagedBytes,
          });
        },
        abort: async () => {
          chunks.length = 0;
        },
      },
      options,
    );
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
    await this.ensureReady();
    const attachment = this.attachment!;

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
      const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      if (staged) {
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              if (offset >= staged.byteLength) return null;
              const end = Math.min(offset + maxBytes, staged.byteLength);
              const slice = staged.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      await this.endReadTransaction();
      const tx = await attachment.startTransaction(
        buildTransactionOptions({ isolationLevel: 'READ_COMMITTED', readOnly: true }),
      );
      const fbBlob =
        ((sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.nativeBlob as FbBlob | undefined) ??
        new FbBlob(attachment, sqlOrHandle.blobId);
      let stream: Awaited<ReturnType<Attachment['openBlob']>>;
      try {
        stream = await attachment.openBlob(tx, fbBlob);
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }

      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            const buf = Buffer.alloc(maxBytes);
            const n = await stream.read(buf);
            if (n < 0) return null;
            return new Uint8Array(buf.buffer, buf.byteOffset, n);
          },
          close: async () => {
            await stream.close().catch(() => undefined);
            await tx.commit().catch(() => tx.rollback().catch(() => undefined));
          },
        },
        opts,
      );
    }

    const { statement, options } = resolveQueryCall<BlobStreamOptions>(
      sqlOrHandle,
      paramsOrOptions,
      maybeOptions,
    );
    resolveBlobSegmentSize(options.segmentSize, false);
    await this.endReadTransaction();

    const tx = await attachment.startTransaction(
      buildTransactionOptions({ isolationLevel: 'READ_COMMITTED', readOnly: true }),
    );
    try {
      return await openNativeQueryBlobStream(
        attachment,
        tx,
        this.statements!,
        statement.sql,
        this.serialize(statement.params),
        options,
        true,
      );
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Capture a lightweight copy-on-write point-in-time page snapshot of the
   * database file.
   */
  async snapshot(
    labelOrOptions?: string | SnapshotOptions,
  ): Promise<DatabaseSnapshot> {
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }
    await this.ensureReady();
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

    try {
      const buf = await fs.promises.readFile(this.dbPath);
      const image = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return this.snapshotStore.createSnapshot(image, labelOrOptions);
    } finally {
      this.attachment = await this.client!.connect(
        this.dbPath,
        this.connectOptions,
      );
      this.statements = new StatementCache(
        this.attachment,
        this.statementCacheSize,
      );
    }
  }

  /**
   * Restore the database file to a previously captured {@link DatabaseSnapshot}
   * (by snapshot object, `id`, `label`, or raw `.fdb` bytes).
   */
  async restoreSnapshot(
    snapshotOrId: DatabaseSnapshot | string | Uint8Array,
  ): Promise<void> {
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }
    await this.ensureReady();
    const bytes =
      snapshotOrId instanceof Uint8Array
        ? snapshotOrId
        : this.snapshotStore.getSnapshot(snapshotOrId).toUint8Array();

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

    await fs.promises.writeFile(this.dbPath, bytes);
    this.attachment = await this.client!.connect(
      this.dbPath,
      this.connectOptions,
    );
    this.statements = new StatementCache(
      this.attachment,
      this.statementCacheSize,
    );
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
    const chunkSize = resolveStreamChunkSize(options.chunkSize);
    let handle: fs.promises.FileHandle | null = null;
    let totalSize = 0;
    let offset = 0;

    const closeHandle = async (): Promise<void> => {
      if (handle) {
        const h = handle;
        handle = null;
        await h.close().catch(() => undefined);
      }
    };

    const raw = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          await this.ensureReady();
          if (!handle) {
            handle = await fs.promises.open(this.dbPath, 'r');
            const stat = await handle.stat();
            totalSize = stat.size;
          }
          if (offset >= totalSize) {
            await closeHandle();
            controller.close();
            return;
          }
          const toRead = Math.min(chunkSize, totalSize - offset);
          const buf = new Uint8Array(toRead);
          const { bytesRead } = await handle.read(buf, 0, toRead, offset);
          if (bytesRead <= 0) {
            await closeHandle();
            controller.close();
            return;
          }
          offset += bytesRead;
          controller.enqueue(bytesRead === toRead ? buf : buf.slice(0, bytesRead));
          if (offset >= totalSize) {
            await closeHandle();
            controller.close();
          }
        } catch (err) {
          await closeHandle();
          throw err;
        }
      },
      cancel: async () => {
        await closeHandle();
      },
    });

    return options.compression === 'gzip' ? compressGzipStream(raw) : raw;
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
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }
    await this.ensureReady();

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

    const handle = await fs.promises.open(this.dbPath, 'w');
    let offset = 0;
    try {
      for await (const chunk of readDatabaseStreamChunks(stream, options)) {
        await handle.write(chunk, 0, chunk.byteLength, offset);
        offset += chunk.byteLength;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (offset === 0) {
      throw new RangeError(
        'loadDataStream received an empty stream; pass a stream from dumpDataStream()',
      );
    }

    this.attachment = await this.client!.connect(this.dbPath, this.connectOptions);
    this.statements = new StatementCache(this.attachment, this.statementCacheSize);
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

