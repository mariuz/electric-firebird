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
import type { IndexedDBVFSOptions } from './indexeddb-vfs';
import { DirectTransport } from './engine-transport';
import type { EngineHandle, EngineTransport } from './engine-transport';
import { WorkerTransport } from './worker-transport';
import { splitStatements } from './sql-script';
import { hasTransactionOptions } from './isolation';
import { applyTypes, applySerializers } from './value-types';
import type { TypeOptions } from './value-types';
import { acquireDatabaseLock } from './db-lock';
import { SharedEngineTransport } from './shared-transport';
import type { DatabaseLock } from './db-lock';
import { toStatement, resolveQueryCall } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';
import type {
  ArrayRow,
  QueryResult,
  QueryDescription,
  QueryOptions,
  Row,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';

/** `QueryOptions` with the array mode pinned, for the overloads below. */
type ArrayModeOptions = QueryOptions & { rowMode: 'array' };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What a statement did.  Returned by `exec()`. */
export interface ExecResult {
  /** Rows affected — for INSERT, UPDATE and DELETE.  0 for DDL. */
  affectedRows: number;
}

/** Options for creating a {@link FirebirdBrowser} instance. */
export interface FirebirdBrowserOptions {
  /** Options forwarded to the IndexedDB VFS layer. */
  vfs?: IndexedDBVFSOptions;
  /**
   * URL or `ArrayBuffer` of the `firebird-embedded.wasm` binary.
   * Passed through to the engine loader.
   */
  wasmBinary?: ArrayBuffer | string;
  /**
   * Custom `locateFile` callback for Emscripten.
   * @see {@link import('../wasm-loader').WasmLoadOptions.locateFile}
   */
  locateFile?: (filename: string) => string;
  /**
   * Worker running the engine.
   *
   * **Browsers need this.**  The WASM build uses pthreads, so Firebird blocks
   * on mutexes while opening a database, and a browser main thread is not
   * allowed to block — without a Worker the page deadlocks.  Build the Worker
   * script from `firebird-wasm/browser/worker-entry`.
   *
   * Omit it only where blocking the calling thread is acceptable, such as
   * Node or a test harness driving a stub engine.
   *
   * With `multiTab: 'shared'` this must be a **factory**.  It is called only
   * if this tab wins the election, so a follower never downloads and
   * instantiates a 9 MB engine to sit idle beside the one already running.
   */
  worker?: Worker | (() => Worker);
  /**
   * Use a transport of your own.  Takes precedence over `worker`; mainly a
   * seam for tests.
   */
  transport?: EngineTransport;
  /**
   * Persist to IndexedDB automatically after writes.
   *
   * Without this, a tab closed without `close()` loses everything written in
   * that session — the common way to leave a page.  Enabled by default:
   * silently losing committed data is a worse default than the cost of
   * writing it.
   *
   * Set `false` to persist only on `close()` and explicit `persist()` calls.
   *
   * @default true
   */
  autoPersist?: boolean;
  /**
   * How long to wait after the last write before persisting, in
   * milliseconds.  Bursts of statements coalesce into one persist.
   *
   * @default 500
   */
  autoPersistDebounceMs?: number;
  /**
   * Called when a background persist fails.
   *
   * Background persists cannot reject into caller code, and swallowing the
   * error would hide data loss, so it is reported here.  Defaults to
   * `console.error`.
   */
  onPersistError?: (error: Error) => void;
  /**
   * What to do when the same database is already open in another tab.
   *
   * Every tab keeps its own complete copy of the database and persists the
   * whole image, so two writers do not interleave — the later persist discards
   * the earlier tab's work entirely, with both tabs reporting success.
   *
   * - `'exclusive'` (default) takes a cross-tab lock and fails with
   *   {@link DatabaseLockedError} if another tab will not release it in time.
   * - `'shared'` elects one tab to run the engine and serves the others from
   *   it, so every tab sees the same live database.  Needs `worker` to be a
   *   factory rather than an instance — a follower must not build an engine it
   *   will never use.
   * - `'allow-unsafe'` skips the lock.  Only sound when at most one of the
   *   tabs writes.
   *
   * @default 'exclusive'
   */
  multiTab?: 'exclusive' | 'shared' | 'allow-unsafe';
  /**
   * How long to wait for another tab to release the database, in
   * milliseconds.  `Infinity` waits indefinitely.
   *
   * @default 5000
   */
  lockTimeoutMs?: number;
  /**
   * Convert result values to richer JavaScript types.
   *
   * Off by default: every conversion trades something away, and values as
   * returned today are correct, just awkward. See {@link TypeOptions} for what
   * each one costs — `dates` in particular loses precision and has to choose a
   * time zone Firebird did not store.
   *
   * @example
   * ```ts
   * new FirebirdBrowser('mydb', { worker, types: { bigint: true, binary: true } })
   * ```
   */
  types?: TypeOptions;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Browser-side Firebird database backed by WASM + IndexedDB.
 *
 * Mirrors the `FirebirdLite` API so application code can switch between the
 * Node.js native driver and the in-browser WASM engine with minimal changes.
 */
export class FirebirdBrowser {
  private readonly dbName: string;
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
  /** Set only in shared mode; owns the election and the channel. */
  private shared: SharedEngineTransport | null = null;

  /**
   * @param dbName  Logical database name.  Used as the IndexedDB store name
   *                and the filename inside Emscripten's virtual FS.
   * @param options Optional configuration.
   */
  constructor(dbName: string, options: FirebirdBrowserOptions = {}) {
    this.dbName = dbName;
    this.options = options;
    this.vfs = new IndexedDBVFS(options.vfs);

    this.multiTab = options.multiTab ?? 'exclusive';
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;

    this.autoPersist = options.autoPersist ?? true;
    this.autoPersistDebounceMs = options.autoPersistDebounceMs ?? 500;
    this.onPersistError =
      options.onPersistError ??
      ((error) => console.error('[firebird-wasm] background persist failed', error));

    this.engine = options.transport ?? this.createEngine();
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
    return `/data/${this.dbName}.fdb`;
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
   * Execute one or more statements that do not return rows.
   *
   * A script may contain several statements, which is what makes this usable
   * for migrations.  Statement boundaries respect string literals, quoted
   * identifiers, comments and `SET TERM`, so a stored procedure body full of
   * semicolons survives intact.  Each statement runs in its own transaction,
   * committed on success — a failure part-way leaves the statements before it
   * committed, as it would in `isql`.
   *
   * Parameters may only be supplied for a single statement: there is no way to
   * say which statement a value belongs to otherwise.  Use `query()` for
   * parameterised statements that return rows.
   *
   * @returns one result per statement, in order.
   */
  async exec(
    sql: string | SqlFragment,
    params: QueryParams = [],
  ): Promise<ExecResult[]> {
    await this.ensureReady();

    const script = toStatement(sql, params);
    const statements = splitStatements(script.sql);

    if (script.params.length > 0 && statements.length > 1) {
      throw new Error(
        `Parameters cannot be used with a multi-statement script ` +
          `(${statements.length} statements found); run the statements separately`,
      );
    }

    const results: ExecResult[] = [];

    for (const statement of statements) {
      const affectedRows = await this.engine.execute(
        this.dbHandle,
        0,
        statement.sql,
        this.serialize(script.params),
      );
      results.push({ affectedRows });
    }

    if (results.length > 0) {
      this.markDirty();
    }

    return results;
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
    sql: SqlFragment,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  async query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  // Both shapes at once, so a caller holding a `string | SqlFragment` — one
  // built conditionally — can call this without casting. Last, so the two
  // specific overloads still win where they apply.
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryOptions = [],
    maybeOptions: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    await this.ensureReady();

    const { statement, options } = resolveQueryCall(
      sql,
      paramsOrOptions,
      maybeOptions,
    );

    // Without options the engine's own auto-commit transaction is used, which
    // is one fewer round trip to the Worker.  With them, the statement has to
    // run inside a transaction that carries them — matching the Node backend,
    // which starts one for every query.
    const rowMode = (options as QueryOptions).rowMode ?? 'object';
    // `types.binary` asks for Uint8Array values; the side channel is how they
    // travel. Same result for the caller, without the base64 round trip.
    const binaryBlobs = this.options.types?.binary === true;

    if (!hasTransactionOptions(options)) {
      return applyTypes(
        await this.engine.query<T>(
          this.dbHandle,
          0,
          statement.sql,
          this.serialize(statement.params),
          rowMode,
          binaryBlobs,
        ),
        this.options.types,
        rowMode,
      );
    }

    const txHandle = await this.engine.startTransaction(this.dbHandle, options);
    try {
      const result = await this.engine.query<T>(
        this.dbHandle,
        txHandle,
        statement.sql,
        this.serialize(statement.params),
        rowMode,
        binaryBlobs,
      );
      await this.engine.commit(txHandle);
      return applyTypes(result, this.options.types, rowMode);
    } catch (err) {
      // A failed commit finishes the transaction itself, so only a failure
      // from the query leaves anything to roll back.
      await this.engine.rollback(txHandle).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Describe a statement's shape without running it.
   *
   * ```ts
   * const shape = await db.describeQuery('SELECT id, name FROM items WHERE id = ?');
   * // shape.params        → [{ type: 496, typeName: 'INTEGER', … }]
   * // shape.fields        → [{ name: 'ID', … }, { name: 'NAME', … }]
   * // shape.statementType → 'SELECT'
   * ```
   *
   * The statement is prepared and dropped, so nothing happens: describing an
   * `INSERT` inserts nothing. Preparing is not free — the engine parses and
   * plans — but it is the only way to learn a shape, and the alternative,
   * running the statement to see what comes back, is not one.
   *
   * A `` sql`…` `` fragment is accepted and its values ignored; only the text
   * decides the shape, and a fragment is often what a caller has to hand.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    return this.engine.describe(this.dbHandle, 0, toStatement(sql).sql);
  }

  /**
   * Run a function inside an explicit transaction.
   */
  async transaction<T>(
    fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    const txHandle = await this.engine.startTransaction(this.dbHandle, options);

    const tx = new FirebirdBrowserTransaction(
      this.engine,
      this.dbHandle,
      txHandle,
      this.options.types,
    );

    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      if (!tx.isFinished) {
        await this.engine.rollback(txHandle);
      }
      throw err;
    }

    // The callback may have rolled back explicitly; committing after that
    // would target a handle the engine has already finished with.
    if (tx.isFinished) {
      this.markDirty();
      return result;
    }

    // A failed commit finishes the transaction too, so there is nothing left
    // to roll back here.
    await this.engine.commit(txHandle);
    this.markDirty();
    return result;
  }

  /**
   * Persist the in-memory database pages to IndexedDB.
   * Call this periodically or before the page unloads to avoid data loss.
   */
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

    this.closed = true;

    if (this.dbHandle) {
      // Persist before closing.
      await this.persist();
      await this.engine.detachDatabase(this.dbHandle);
      this.dbHandle = 0;
    }

    try {
      await this.vfs.close();
      await this.engine.dispose();
    } finally {
      // Last, and unconditionally: a lock still held after a failed teardown
      // locks the database out of every future tab until the page is gone.
      await this.releaseLock();
    }
  }

  /** Release the cross-tab lock, if this instance holds one. */
  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    await lock?.release();
  }

  // ── Automatic persistence ─────────────────────────────────────────────

  /**
   * Whether this tab may write the database image to IndexedDB.
   *
   * In shared mode only the leader may: a follower has no engine, and its
   * `readFile` would fetch the image across the channel only to race the
   * leader writing the same store — reintroducing the whole-image overwrite
   * that multi-tab safety exists to prevent.
   */
  private get mayPersist(): boolean {
    return this.shared === null || this.shared.isLeader;
  }

  /** Note that the database has changed and schedule a persist. */
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

  /**
   * Persist without a caller to reject into.
   *
   * Failures are reported through `onPersistError`; letting them become
   * unhandled rejections would hide data loss.
   */
  private async persistInBackground(): Promise<void> {
    if (this.closed) return;
    try {
      await this.persist();
    } catch (err) {
      this.onPersistError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Flush when the page is being hidden or unloaded.
   *
   * `visibilitychange` to hidden is the event to rely on: it fires on mobile
   * when an app is backgrounded, where `beforeunload` and `unload` often do
   * not fire at all.  `pagehide` covers the bfcache case.  Neither can await
   * an async write, so this is best-effort — which is why writes are also
   * persisted on a debounce rather than only here.
   */
  private attachLifecycleListeners(): void {
    if (this.lifecycleAttached || !this.autoPersist) return;
    if (typeof document === 'undefined' || typeof addEventListener !== 'function') {
      return; // not a browser
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

  // ── Initialisation ────────────────────────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (this.dbHandle) return;
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }

    // Prevent concurrent initialisation
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    await this.initPromise;
  }

  private async init(): Promise<void> {
    // Before anything reads the stored image.  A tab that loaded the database
    // and then waited for the lock would resume with a snapshot the departing
    // tab has since replaced — the very overwrite the lock prevents.
    if (this.multiTab === 'exclusive') {
      this.lock = await acquireDatabaseLock(this.dbName, {
        timeoutMs: this.lockTimeoutMs,
      });
    }
    // 'shared' deliberately takes no lock here: the transport's election holds
    // it, and a second request from the same tab would queue behind itself.

    await this.engine.init();
    await this.vfs.open(this.dbName);
    await this.openDatabase();
    this.attachLifecycleListeners();
  }

  /**
   * Restore the stored image if this tab owns the engine, then attach.
   *
   * Separate from init() because it has to run again whenever the engine
   * changes underneath us — in shared mode a leadership change replaces the
   * engine, and every handle it issued dies with it.
   *
   * The restore is guarded by {@link mayPersist} for the same reason
   * persistence is: a follower writing its IndexedDB snapshot into the
   * filesystem would be overwriting the leader's *live* database with a
   * possibly older image.
   */
  private async openDatabase(): Promise<void> {
    await this.engine.mkdir('/data');

    if (this.mayPersist) {
      const stored = await this.vfs.exportDatabase();
      if (stored.byteLength > 0) {
        await this.engine.writeFile(this.dbPath, stored);
      }
    }

    this.dbHandle = (await this.engine.exists(this.dbPath))
      ? await this.engine.attachDatabase(this.dbPath)
      : await this.engine.createDatabase(this.dbPath);
  }

  /**
   * The engine behind this connection was replaced; attach to the new one.
   *
   * Called on every tab after a leadership change, promoted or not. Silence
   * here would leave the caller holding a handle from an engine that no longer
   * exists, and writes through it would go nowhere — visibly succeeding.
   */
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

// ---------------------------------------------------------------------------
// Transaction handle
// ---------------------------------------------------------------------------

/**
 * A handle to an active transaction in the browser WASM engine.
 *
 * Statements issued here are bound to the transaction handle, so a rollback
 * really does undo them.
 */
export class FirebirdBrowserTransaction {
  private finished = false;

  constructor(
    private readonly engine: EngineTransport,
    private readonly dbHandle: EngineHandle,
    private readonly txHandle: EngineHandle,
    private readonly types?: TypeOptions,
  ) {}

  /** Whether this transaction has already been rolled back. */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Roll this transaction back and stop.
   *
   * The enclosing `transaction()` will not commit afterwards.  Use this to
   * abandon a transaction deliberately, rather than throwing an error you do
   * not mean — throwing also rolls back, but it propagates to the caller.
   */
  async rollback(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.engine.rollback(this.txHandle);
  }

  private assertUsable(): void {
    if (this.finished) {
      throw new Error('Transaction has already been rolled back');
    }
  }

  /**
   * Execute a DDL/DML statement inside this transaction.
   *
   * @returns the number of rows affected.
   */
  async exec(
    sql: string | SqlFragment,
    params: QueryParams = [],
  ): Promise<ExecResult> {
    this.assertUsable();
    const statement = toStatement(sql, params);
    const affectedRows = await this.engine.execute(
      this.dbHandle,
      this.txHandle,
      statement.sql,
      applySerializers(statement.params, this.types?.serializers),
    );
    return { affectedRows };
  }

  /** Execute a SELECT inside this transaction and return rows. */
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode },
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: { rowMode?: RowMode } = {},
  ): Promise<QueryResult<T>> {
    this.assertUsable();
    const statement = toStatement(sql, params);
    const rowMode = options.rowMode ?? 'object';
    return applyTypes(
      await this.engine.query<T>(
        this.dbHandle,
        this.txHandle,
        statement.sql,
        applySerializers(statement.params, this.types?.serializers),
        rowMode,
        this.types?.binary === true,
      ),
      this.types,
      rowMode,
    );
  }
}
