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
import type {
  QueryResult,
  Row,
  QueryParams,
  TransactionOptions,
} from '../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

  /**
   * @param dbName  Logical database name.  Used as the IndexedDB store name
   *                and the filename inside Emscripten's virtual FS.
   * @param options Optional configuration.
   */
  constructor(dbName: string, options: FirebirdBrowserOptions = {}) {
    this.dbName = dbName;
    this.options = options;
    this.vfs = new IndexedDBVFS(options.vfs);

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
   * Execute a DDL or DML statement that does not return rows.
   *
   * The statement runs in its own transaction, committed on success.
   */
  async exec(sql: string, params: QueryParams = []): Promise<void> {
    await this.ensureReady();
    await this.engine.execute(this.dbHandle, 0, sql, params);
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
      await this.engine.rollback(txHandle);
      throw err;
    }

    // A failed commit finishes the transaction too, so there is nothing left
    // to roll back here.
    await this.engine.commit(txHandle);
    return result;
  }

  /**
   * Persist the in-memory database pages to IndexedDB.
   * Call this periodically or before the page unloads to avoid data loss.
   */
  async persist(): Promise<void> {
    if (!this.dbHandle) return;
    const image = await this.engine.readFile(this.dbPath);
    await this.vfs.importDatabase(image);
  }

  /**
   * Close the database and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
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
  constructor(
    private readonly engine: EngineTransport,
    private readonly dbHandle: EngineHandle,
    private readonly txHandle: EngineHandle,
  ) {}

  /** Execute a DDL/DML statement inside this transaction. */
  async exec(sql: string, params: QueryParams = []): Promise<void> {
    await this.engine.execute(this.dbHandle, this.txHandle, sql, params);
  }

  /** Execute a SELECT inside this transaction and return rows. */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
  ): Promise<QueryResult<T>> {
    return this.engine.query<T>(this.dbHandle, this.txHandle, sql, params);
  }
}
