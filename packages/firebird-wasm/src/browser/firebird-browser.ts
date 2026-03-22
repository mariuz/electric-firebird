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
 * const db = new FirebirdBrowser('mydb');
 * await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR(100))');
 * const result = await db.query('SELECT * FROM t');
 * await db.close();
 * ```
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import { loadFirebirdWasm, allocString } from '../wasm-loader';
import { IndexedDBVFS } from './indexeddb-vfs';
import type { IndexedDBVFSOptions } from './indexeddb-vfs';
import type {
  QueryResult,
  Row,
  QueryParams,
  FieldInfo,
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
   * Passed through to {@link loadFirebirdWasm}.
   */
  wasmBinary?: ArrayBuffer | string;
  /**
   * Custom `locateFile` callback for Emscripten.
   * @see {@link import('../wasm-loader').WasmLoadOptions.locateFile}
   */
  locateFile?: (filename: string) => string;
}

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
  private mod: FirebirdWasmModule | null = null;
  private dbHandle = 0;
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
  }

  // ── Public API (mirrors FirebirdLite) ─────────────────────────────────

  /**
   * Execute a DDL or DML statement that does not return rows.
   */
  async exec(sql: string): Promise<void> {
    await this.ensureReady();
    const mod = this.mod!;
    const sqlPtr = allocString(mod, sql);
    try {
      const rc = mod._fb_execute(this.dbHandle, sqlPtr);
      if (rc !== 0) {
        throw new Error(`Firebird exec error (code ${rc}): ${sql}`);
      }
    } finally {
      mod._free(sqlPtr);
    }
  }

  /**
   * Execute a SQL query and return the result rows.
   *
   * > **Note:** Parameterised queries are not yet supported in the browser
   * > WASM build.  Parameters will be supported once the C API wrapper
   * > exposes `_fb_query_params`.
   */
  async query<T extends Row = Row>(
    sql: string,
    _params: QueryParams = [],
    _options: TransactionOptions = {},
  ): Promise<QueryResult<T>> {
    await this.ensureReady();
    const mod = this.mod!;
    const sqlPtr = allocString(mod, sql);

    try {
      const resultPtr = mod._fb_query(this.dbHandle, sqlPtr);
      if (resultPtr === 0) {
        throw new Error(`Firebird query error: ${sql}`);
      }

      // The WASM C API packs the result into a JSON-formatted UTF-8 string.
      const jsonStr = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);

      const parsed = JSON.parse(jsonStr) as { columns: string[]; rows: unknown[][] };

      const fields: FieldInfo[] = parsed.columns.map((c) => ({
        name: c.toUpperCase(),
      }));

      const rows = parsed.rows.map((cols) =>
        Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])),
      ) as T[];

      return { rows, fields };
    } finally {
      mod._free(sqlPtr);
    }
  }

  /**
   * Run a function inside an explicit transaction.
   */
  async transaction<T>(
    fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
    _options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    const mod = this.mod!;
    const txHandle = mod._fb_start_transaction(this.dbHandle);
    if (txHandle === 0) {
      throw new Error('Failed to start transaction');
    }

    const tx = new FirebirdBrowserTransaction(mod, this.dbHandle, txHandle);

    try {
      const result = await fn(tx);
      const rc = mod._fb_commit(txHandle);
      if (rc !== 0) throw new Error(`Transaction commit failed (code ${rc})`);
      return result;
    } catch (err) {
      mod._fb_rollback(txHandle);
      throw err;
    }
  }

  /**
   * Persist the in-memory database pages to IndexedDB.
   * Call this periodically or before the page unloads to avoid data loss.
   */
  async persist(): Promise<void> {
    if (!this.mod) return;
    const dbPath = `/data/${this.dbName}.fdb`;
    await this.vfs.syncWithEmscriptenFS(
      'persist',
      (path) => this.mod!.FS.readFile(path),
      (path, data) => this.mod!.FS.writeFile(path, data),
      dbPath,
    );
  }

  /**
   * Close the database and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.mod && this.dbHandle) {
      // Persist before closing
      await this.persist();
      this.mod._fb_detach_database(this.dbHandle);
      this.dbHandle = 0;
    }

    await this.vfs.close();
    this.mod = null;
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
    // 1. Load WASM module
    this.mod = await loadFirebirdWasm({
      wasmBinary: this.options.wasmBinary,
      locateFile: this.options.locateFile,
    });

    const mod = this.mod;
    const dbPath = `/data/${this.dbName}.fdb`;

    // 2. Create /data directory in Emscripten FS
    if (!mod.FS.analyzePath('/data').exists) {
      mod.FS.mkdir('/data');
    }

    // 3. Open IndexedDB and populate MEMFS from persisted pages
    await this.vfs.open(this.dbName);
    await this.vfs.syncWithEmscriptenFS(
      'populate',
      (path) => mod.FS.readFile(path),
      (path, data) => mod.FS.writeFile(path, data),
      dbPath,
    );

    // 4. Initialise Firebird engine
    mod._fb_init();

    // 5. Attach or create database
    const pathPtr = allocString(mod, dbPath);
    try {
      if (mod.FS.analyzePath(dbPath).exists) {
        this.dbHandle = mod._fb_attach_database(pathPtr);
      } else {
        this.dbHandle = mod._fb_create_database(pathPtr);
      }
    } finally {
      mod._free(pathPtr);
    }

    if (this.dbHandle === 0) {
      throw new Error(`Failed to open database "${this.dbName}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Transaction handle
// ---------------------------------------------------------------------------

/**
 * A handle to an active transaction in the browser WASM engine.
 */
export class FirebirdBrowserTransaction {
  constructor(
    private readonly mod: FirebirdWasmModule,
    private readonly dbHandle: number,
    private readonly txHandle: number,
  ) {}

  /** Execute a DDL/DML statement inside this transaction. */
  async exec(sql: string): Promise<void> {
    const sqlPtr = allocString(this.mod, sql);
    try {
      const rc = this.mod._fb_execute(this.dbHandle, sqlPtr);
      if (rc !== 0) {
        throw new Error(`Firebird exec error (code ${rc}): ${sql}`);
      }
    } finally {
      this.mod._free(sqlPtr);
    }
  }

  /** Execute a SELECT inside this transaction and return rows. */
  async query<T extends Row = Row>(sql: string): Promise<QueryResult<T>> {
    const sqlPtr = allocString(this.mod, sql);
    try {
      const resultPtr = this.mod._fb_query(this.dbHandle, sqlPtr);
      if (resultPtr === 0) {
        throw new Error(`Firebird query error: ${sql}`);
      }

      const jsonStr = this.mod.UTF8ToString(resultPtr);
      this.mod._fb_free_result(resultPtr);

      const parsed = JSON.parse(jsonStr) as { columns: string[]; rows: unknown[][] };
      const fields: FieldInfo[] = parsed.columns.map((c) => ({
        name: c.toUpperCase(),
      }));
      const rows = parsed.rows.map((cols) =>
        Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])),
      ) as T[];

      return { rows, fields };
    } finally {
      this.mod._free(sqlPtr);
    }
  }
}
