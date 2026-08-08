/**
 * engine-transport.ts – the boundary between `FirebirdBrowser` and the engine.
 *
 * There are two ways to reach the compiled engine, and they differ enough to
 * be worth naming:
 *
 *   • {@link DirectTransport} calls the WASM exports in this thread.  Simple,
 *     and what Node uses.
 *   • {@link WorkerTransport} (see `worker-transport.ts`) forwards to a Web
 *     Worker.  Browsers *must* use it: the build uses pthreads, Firebird
 *     blocks on mutexes while opening a database, and a browser main thread is
 *     not allowed to block — calling the engine directly from a page deadlocks.
 *
 * Both sides of that split need the same operations, including filesystem
 * access: persistence copies the database between Emscripten's in-memory FS
 * and IndexedDB, and in the Worker case that filesystem lives in the Worker.
 *
 * Every method is async so the two are interchangeable, even though the direct
 * one never actually suspends.
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import { loadFirebirdWasm, allocString, lastError } from '../wasm-loader';
import type { Row, QueryResult, FieldInfo, QueryParams } from '../types';
import { encodeParams } from './params';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque engine handle (database or transaction). 0 means "none". */
export type EngineHandle = number;

/**
 * The operations `FirebirdBrowser` needs from the engine, wherever it runs.
 *
 * `txHandle` of 0 means "run this statement in its own transaction", matching
 * the C API.
 */
export interface EngineTransport {
  /** Initialise the engine.  Safe to call more than once. */
  init(): Promise<void>;

  createDatabase(path: string): Promise<EngineHandle>;
  attachDatabase(path: string): Promise<EngineHandle>;
  detachDatabase(dbHandle: EngineHandle): Promise<void>;

  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
  ): Promise<void>;
  query<T extends Row = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;

  startTransaction(dbHandle: EngineHandle): Promise<EngineHandle>;
  commit(txHandle: EngineHandle): Promise<void>;
  rollback(txHandle: EngineHandle): Promise<void>;

  // ── Filesystem, for the IndexedDB persistence layer ────────────────────
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;

  /** Release anything the transport owns.  Does not detach databases. */
  dispose(): Promise<void>;
}

/** Options accepted by {@link DirectTransport}. */
export interface DirectTransportOptions {
  wasmBinary?: ArrayBuffer | string;
  locateFile?: (filename: string) => string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build an Error carrying whatever the engine reported.
 *
 * The C API returns only a numeric code; the readable Firebird message lives
 * behind `_fb_last_error()` and is lost unless it is read immediately, before
 * another call overwrites it.
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

/** Decode the engine's JSON result set into rows keyed by column name. */
export function decodeResultSet<T extends Row>(json: string): QueryResult<T> {
  const parsed = JSON.parse(json) as { columns: string[]; rows: unknown[][] };

  const fields: FieldInfo[] = parsed.columns.map((c) => ({ name: c.toUpperCase() }));

  const rows = parsed.rows.map((cols) =>
    Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])),
  ) as T[];

  return { rows, fields };
}

// ---------------------------------------------------------------------------
// DirectTransport
// ---------------------------------------------------------------------------

/**
 * Calls the engine in the current thread.
 *
 * Used by Node, by the Worker (which is where a browser's engine actually
 * runs), and by tests that install a stub `createFirebirdModule`.
 */
export class DirectTransport implements EngineTransport {
  private mod: FirebirdWasmModule | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly options: DirectTransportOptions = {}) {}

  async init(): Promise<void> {
    // Concurrent first calls must not each load the module.
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.mod = await loadFirebirdWasm({
      wasmBinary: this.options.wasmBinary,
      locateFile: this.options.locateFile,
    });

    const rc = this.mod._fb_init();
    if (rc !== 0) {
      throw engineError(this.mod, 'Failed to initialise the Firebird engine', rc);
    }
  }

  private get module(): FirebirdWasmModule {
    if (!this.mod) {
      throw new Error('EngineTransport used before init()');
    }
    return this.mod;
  }

  /** Run `fn` with `str` allocated on the WASM heap, freeing it afterwards. */
  private withString<T>(str: string, fn: (ptr: number) => T): T {
    const mod = this.module;
    const ptr = allocString(mod, str);
    try {
      return fn(ptr);
    } finally {
      mod._free(ptr);
    }
  }

  async createDatabase(path: string): Promise<EngineHandle> {
    const mod = this.module;
    const handle = this.withString(path, (p) => mod._fb_create_database(p));
    if (handle === 0) {
      throw engineError(mod, `Failed to create database "${path}"`);
    }
    return handle;
  }

  async attachDatabase(path: string): Promise<EngineHandle> {
    const mod = this.module;
    const handle = this.withString(path, (p) => mod._fb_attach_database(p));
    if (handle === 0) {
      throw engineError(mod, `Failed to open database "${path}"`);
    }
    return handle;
  }

  async detachDatabase(dbHandle: EngineHandle): Promise<void> {
    this.module._fb_detach_database(dbHandle);
  }

  /**
   * Run `fn` with the packed parameters on the WASM heap.
   *
   * An empty list is passed as a null pointer rather than an empty buffer, so
   * the C side takes its "no parameters" path and skips preparing an input
   * message it would not use.
   */
  private withParams<T>(
    params: QueryParams,
    fn: (ptr: number, length: number) => T,
  ): T {
    if (!params || params.length === 0) {
      return fn(0, 0);
    }

    const mod = this.module;
    const packed = encodeParams(params);
    const ptr = mod._malloc(packed.length);
    try {
      mod.HEAPU8.set(packed, ptr);
      return fn(ptr, packed.length);
    } finally {
      mod._free(ptr);
    }
  }

  async execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
  ): Promise<void> {
    const mod = this.module;
    const rc = this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) =>
        params.length === 0
          ? mod._fb_execute(dbHandle, txHandle, sqlPtr)
          : mod._fb_execute_params(dbHandle, txHandle, sqlPtr, paramPtr, paramLen),
      ),
    );
    if (rc !== 0) {
      throw engineError(mod, `Firebird exec failed for: ${sql}`, rc);
    }
  }

  async query<T extends Row = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
  ): Promise<QueryResult<T>> {
    const mod = this.module;
    return this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) => {
      const resultPtr =
        params.length === 0
          ? mod._fb_query(dbHandle, txHandle, sqlPtr)
          : mod._fb_query_params(dbHandle, txHandle, sqlPtr, paramPtr, paramLen);
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird query failed for: ${sql}`);
      }

      // The engine owns the buffer until fb_free_result.
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);

      return decodeResultSet<T>(json);
      }),
    );
  }

  async startTransaction(dbHandle: EngineHandle): Promise<EngineHandle> {
    const mod = this.module;
    const txHandle = mod._fb_start_transaction(dbHandle);
    if (txHandle === 0) {
      throw engineError(mod, 'Failed to start transaction');
    }
    return txHandle;
  }

  async commit(txHandle: EngineHandle): Promise<void> {
    const mod = this.module;
    const rc = mod._fb_commit(txHandle);
    if (rc !== 0) {
      // fb_commit finishes the transaction whatever the outcome, so there is
      // nothing left to roll back here.
      throw engineError(mod, 'Transaction commit failed', rc);
    }
  }

  async rollback(txHandle: EngineHandle): Promise<void> {
    this.module._fb_rollback(txHandle);
  }

  // ── Filesystem ─────────────────────────────────────────────────────────

  async mkdir(path: string): Promise<void> {
    const mod = this.module;
    if (!mod.FS.analyzePath(path).exists) {
      mod.FS.mkdir(path);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.module.FS.analyzePath(path).exists;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.module.FS.readFile(path);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.module.FS.writeFile(path, data);
  }

  async dispose(): Promise<void> {
    // The module is cached process-wide by loadFirebirdWasm and shared with
    // any other instance, so it is deliberately not torn down here.
    this.mod = null;
    this.initPromise = null;
  }
}
