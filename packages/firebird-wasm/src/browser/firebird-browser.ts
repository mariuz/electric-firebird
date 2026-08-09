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
import type {
  QueryResult,
  Row,
  QueryParams,
  TransactionOptions,
} from '../types';

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
   */
  worker?: Worker;
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

  /**
   * @param dbName  Logical database name.  Used as the IndexedDB store name
   *                and the filename inside Emscripten's virtual FS.
   * @param options Optional configuration.
   */
  constructor(dbName: string, options: FirebirdBrowserOptions = {}) {
    this.dbName = dbName;
    this.options = options;
    this.vfs = new IndexedDBVFS(options.vfs);

    this.autoPersist = options.autoPersist ?? true;
    this.autoPersistDebounceMs = options.autoPersistDebounceMs ?? 500;
    this.onPersistError =
      options.onPersistError ??
      ((error) => console.error('[firebird-wasm] background persist failed', error));

    this.engine =
      options.transport ??
      (options.worker
        ? new WorkerTransport(options.worker)
        : new DirectTransport({
            wasmBinary: options.wasmBinary,
            locateFile: options.locateFile,
          }));
  }

  /** Path of the database inside Emscripten's filesystem. */
  private get dbPath(): string {
    return `/data/${this.dbName}.fdb`;
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
  async exec(sql: string, params: QueryParams = []): Promise<ExecResult[]> {
    await this.ensureReady();

    const statements = splitStatements(sql);

    if (params.length > 0 && statements.length > 1) {
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
        params,
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
   * Parameters are bound with `?` placeholders, as in the Node.js backend:
   *
   * ```ts
   * await db.query('SELECT * FROM items WHERE id = ?', [1]);
   * ```
   */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
    _options: TransactionOptions = {},
  ): Promise<QueryResult<T>> {
    await this.ensureReady();
    return this.engine.query<T>(this.dbHandle, 0, sql, params);
  }

  /**
   * Run a function inside an explicit transaction.
   */
  async transaction<T>(
    fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
    _options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    const txHandle = await this.engine.startTransaction(this.dbHandle);

    const tx = new FirebirdBrowserTransaction(this.engine, this.dbHandle, txHandle);

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
    if (!this.dbHandle) return;

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

    await this.vfs.close();
    await this.engine.dispose();
  }

  // ── Automatic persistence ─────────────────────────────────────────────

  /** Note that the database has changed and schedule a persist. */
  private markDirty(): void {
    if (!this.autoPersist || this.closed) return;

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
    await this.engine.init();

    await this.engine.mkdir('/data');

    // Restore any previously persisted image into the engine's filesystem
    // before attaching, so a reload reopens the same database.
    await this.vfs.open(this.dbName);
    const stored = await this.vfs.exportDatabase();
    if (stored.byteLength > 0) {
      await this.engine.writeFile(this.dbPath, stored);
    }

    this.dbHandle = (await this.engine.exists(this.dbPath))
      ? await this.engine.attachDatabase(this.dbPath)
      : await this.engine.createDatabase(this.dbPath);

    this.attachLifecycleListeners();
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
  async exec(sql: string, params: QueryParams = []): Promise<ExecResult> {
    this.assertUsable();
    const affectedRows = await this.engine.execute(
      this.dbHandle,
      this.txHandle,
      sql,
      params,
    );
    return { affectedRows };
  }

  /** Execute a SELECT inside this transaction and return rows. */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
  ): Promise<QueryResult<T>> {
    this.assertUsable();
    return this.engine.query<T>(this.dbHandle, this.txHandle, sql, params);
  }
}
