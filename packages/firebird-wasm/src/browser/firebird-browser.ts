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
import { loadFirebirdWasm, allocString, lastError } from '../wasm-loader';
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
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build an Error carrying whatever the engine reported.
 *
 * The C API returns only a numeric code; the human-readable Firebird message
 * lives behind `_fb_last_error()` and is lost unless it is read immediately,
 * before any other call overwrites it.
 */
function engineError(
  mod: FirebirdWasmModule,
  context: string,
  code?: number,
): Error {
  const detail = lastError(mod);
  const suffix = code === undefined ? '' : ` (code ${code})`;
  return new Error(detail ? `${context}${suffix}: ${detail}` : `${context}${suffix}`);
}

/**
 * Run a statement that returns no rows.
 *
 * @param txHandle - transaction to run in, or 0 for a self-contained one.
 */
function execStatement(
  mod: FirebirdWasmModule,
  dbHandle: number,
  txHandle: number,
  sql: string,
): void {
  const sqlPtr = allocString(mod, sql);
  try {
    const rc = mod._fb_execute(dbHandle, txHandle, sqlPtr);
    if (rc !== 0) {
      throw engineError(mod, `Firebird exec failed for: ${sql}`, rc);
    }
  } finally {
    mod._free(sqlPtr);
  }
}

/**
 * Run a query and decode the engine's JSON result set.
 *
 * @param txHandle - transaction to run in, or 0 for a self-contained one.
 */
function queryStatement<T extends Row>(
  mod: FirebirdWasmModule,
  dbHandle: number,
  txHandle: number,
  sql: string,
): QueryResult<T> {
  const sqlPtr = allocString(mod, sql);

  try {
    const resultPtr = mod._fb_query(dbHandle, txHandle, sqlPtr);
    if (resultPtr === 0) {
      throw engineError(mod, `Firebird query failed for: ${sql}`);
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
 * Reject parameters instead of ignoring them.
 *
 * The WASM C API has no parameter-binding entry point yet (see
 * docs/roadmap.md, M2).  Dropping the parameters silently would make the same
 * call return different results in Node and in the browser, so it is refused
 * outright.
 */
function rejectParams(params: QueryParams, sql: string): void {
  if (params && params.length > 0) {
    throw new Error(
      'Parameterised queries are not supported by the browser WASM build yet. ' +
        'Inline the values or use the Node.js FirebirdLite backend. ' +
        `Statement: ${sql}`,
    );
  }
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
   *
   * The statement runs in its own transaction, committed on success.
   */
  async exec(sql: string): Promise<void> {
    await this.ensureReady();
    execStatement(this.mod!, this.dbHandle, 0, sql);
  }

  /**
   * Execute a SQL query and return the result rows.
   *
   * > **Note:** parameterised queries are not supported by the browser WASM
   * > build yet — passing `params` throws rather than silently ignoring them.
   */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
    _options: TransactionOptions = {},
  ): Promise<QueryResult<T>> {
    rejectParams(params, sql);
    await this.ensureReady();
    return queryStatement<T>(this.mod!, this.dbHandle, 0, sql);
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

    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      mod._fb_rollback(txHandle);
      throw err;
    }

    const rc = mod._fb_commit(txHandle);
    if (rc !== 0) {
      // The engine releases the transaction whether or not the commit
      // succeeded, so there is nothing left to roll back here.
      throw engineError(mod, 'Transaction commit failed', rc);
    }
    return result;
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
    const initRc = mod._fb_init();
    if (initRc !== 0) {
      throw engineError(mod, 'Failed to initialise the Firebird engine', initRc);
    }

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
      throw engineError(mod, `Failed to open database "${this.dbName}"`);
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
  constructor(
    private readonly mod: FirebirdWasmModule,
    private readonly dbHandle: number,
    private readonly txHandle: number,
  ) {}

  /** Execute a DDL/DML statement inside this transaction. */
  async exec(sql: string): Promise<void> {
    execStatement(this.mod, this.dbHandle, this.txHandle, sql);
  }

  /**
   * Execute a SELECT inside this transaction and return rows.
   *
   * As with {@link FirebirdBrowser.query}, parameters are refused rather than
   * ignored until the C API can bind them.
   */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
  ): Promise<QueryResult<T>> {
    rejectParams(params, sql);
    return queryStatement<T>(this.mod, this.dbHandle, this.txHandle, sql);
  }
}
