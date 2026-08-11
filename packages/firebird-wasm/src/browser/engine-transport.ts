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
import type {
  Row,
  QueryResult,
  FieldInfo,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';
import { isolationCode } from './isolation';
import { encodeParams } from './params';
import { firebirdTypeName } from './field-types';

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

  /** Returns the number of rows the statement affected. */
  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
  ): Promise<number>;
  query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
    rowMode?: RowMode,
  ): Promise<QueryResult<T>>;

  /**
   * Begin a transaction.
   *
   * `options` is honoured, not accepted and dropped: the Node backend has
   * always applied isolationLevel and readOnly, and a browser caller
   * writing the same code deserves the same transaction.
   */
  startTransaction(
    dbHandle: EngineHandle,
    options?: TransactionOptions,
  ): Promise<EngineHandle>;
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

/** How the engine describes one column. */
interface EncodedColumn {
  name: string;
  type: number;
  subType: number;
  scale: number;
  length: number;
  nullable: boolean;
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

/**
 * Row builders, keyed by the column-name signature.
 *
 * Building one costs more than it saves on a single small result, so a query
 * run repeatedly — which is most of them — has to reuse the builder. Measured
 * on 5 columns: rebuilding per call turns 2.5 ms into 5.5 ms across 2000
 * one-row queries, while reusing turns it into 1.1 ms.
 */
const rowBuilders = new Map<string, (cols: unknown[]) => Row>();

/**
 * Cap on distinct shapes remembered.  Cleared wholesale rather than evicted
 * one at a time: this exists to stop unbounded growth in a process issuing
 * endlessly varied `SELECT` lists, not to be a good cache.
 */
const MAX_ROW_BUILDERS = 64;

/** Set once `new Function` is known to be unavailable — see {@link rowBuilder}. */
let codeGenerationBlocked = false;

/**
 * A column name as a JavaScript string literal.
 *
 * `JSON.stringify` handles quotes, backslashes and control characters. U+2028
 * and U+2029 are legal in string literals from ES2019 and are escaped anyway,
 * because the cost is nothing and the failure would be a syntax error at
 * runtime on an older engine.
 */
function stringLiteral(name: string): string {
  return JSON.stringify(name)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build a function that turns one row of values into an object.
 *
 * Generated with literal keys, which is the whole point: every row then shares
 * one hidden class, and the engine can compile the construction. The obvious
 * safe alternative — computed keys, `{[name]: c[0]}` — forces dictionary-mode
 * objects and measured *no faster than `Object.fromEntries`* (14.7 ms against
 * 15.2 ms on 10,000 rows), so it is not a trade worth making.
 *
 * Returns null when the caller must fall back:
 *
 * - A column named `__proto__`. As a literal key that sets the prototype
 *   instead of defining a property, so the value would be silently lost.
 *   `Object.fromEntries` defines it correctly, so the slow path is also the
 *   right path here. Unreachable today, because column names are upper-cased
 *   before they get here and `__PROTO__` is an ordinary key — kept because the
 *   guard costs one comparison and the upper-casing is not this function's to
 *   rely on.
 * - A Content-Security-Policy without `unsafe-eval`, where `new Function`
 *   throws. Remembered, so it is attempted once rather than per query.
 */
function rowBuilder(names: string[]): ((cols: unknown[]) => Row) | null {
  if (codeGenerationBlocked || names.includes('__proto__')) {
    return null;
  }

  // \u0000 cannot appear in a Firebird identifier, so it cannot make two
  // different column lists collide.
  const signature = names.join('\u0000');
  const cached = rowBuilders.get(signature);
  if (cached) return cached;

  let built: (cols: unknown[]) => Row;
  try {
    built = new Function(
      'c',
      'return {' + names.map((n, i) => `${stringLiteral(n)}:c[${i}]`).join(',') + '}',
    ) as (cols: unknown[]) => Row;
  } catch {
    // A strict CSP. Every later result set takes the fallback without
    // re-testing, and nothing about the returned rows changes.
    codeGenerationBlocked = true;
    return null;
  }

  if (rowBuilders.size >= MAX_ROW_BUILDERS) {
    rowBuilders.clear();
  }
  rowBuilders.set(signature, built);
  return built;
}

/**
 * Decode the engine's JSON result set.
 *
 * `rowMode: 'array'` returns the parsed rows as they arrive — the engine
 * already sends each row as an array of values, so this is the one shape that
 * costs nothing to produce. Object mode is what the row builder above exists
 * for, and what the decode benchmark measures.
 */
export function decodeResultSet<T = Row>(
  json: string,
  rowMode: RowMode = 'object',
): QueryResult<T> {
  const parsed = JSON.parse(json) as {
    columns: EncodedColumn[];
    rows: unknown[][];
  };

  const fields: FieldInfo[] = parsed.columns.map((c) => ({
    name: c.name.toUpperCase(),
    type: c.type,
    typeName: firebirdTypeName(c.type, c.scale),
    subType: c.subType,
    scale: c.scale,
    length: c.length,
    nullable: c.nullable,
  }));

  if (rowMode === 'array') {
    // Handed straight through: no builder, no per-row object, and nothing to
    // collide when two columns share a name.
    return { rows: parsed.rows as T[], fields };
  }

  const names = fields.map((f) => f.name);
  const build = rowBuilder(names);

  const rows = (
    build
      ? parsed.rows.map(build)
      : parsed.rows.map((cols) =>
          Object.fromEntries(names.map((name, i) => [name, cols[i]])),
        )
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
  ): Promise<number> {
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
    return mod._fb_last_affected_rows();
  }

  async query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
    rowMode: RowMode = 'object',
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

      return decodeResultSet<T>(json, rowMode);
      }),
    );
  }

  async startTransaction(
    dbHandle: EngineHandle,
    options: TransactionOptions = {},
  ): Promise<EngineHandle> {
    const mod = this.module;
    const txHandle = mod._fb_start_transaction_ex(
      dbHandle,
      isolationCode(options),
      options.readOnly === true ? 1 : 0,
    );
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
