/**
 * wasm-loader.ts – Load and initialise the Firebird WASM module.
 *
 * This module provides a thin wrapper around the Emscripten-generated JS glue
 * code produced by the WASM build (see `wasm/build.sh`).  It handles:
 *
 *   1. Locating the `.wasm` binary (node filesystem or HTTP fetch).
 *   2. Instantiating the Emscripten module with the correct options.
 *   3. Exposing a typed interface (`FirebirdWasmModule`) to the rest of the
 *      library.
 */

import { VERSION } from './version';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Emscripten virtual-filesystem interface (subset used by this library). */
export interface EmscriptenFS {
  mkdir(path: string): void;
  mount(fsType: unknown, opts: Record<string, unknown>, mountPoint: string): void;
  unmount(mountPoint: string): void;
  writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string }): void;
  readFile(path: string, opts?: { encoding?: string }): Uint8Array;
  unlink(path: string): void;
  stat(path: string): { size: number; mtime: Date };
  analyzePath(path: string): { exists: boolean };
  syncfs(populate: boolean, callback: (err: unknown) => void): void;
}

/** Handle value returned by the C API (opaque integer pointer). */
export type FbHandle = number;

/**
 * Typed interface for the Emscripten-compiled Firebird module.
 *
 * All `_fb_*` functions correspond to the C API surface exported via
 * `-s EXPORTED_FUNCTIONS` in the CMake build.
 */
export interface FirebirdWasmModule {
  // ── Firebird C API ──────────────────────────────────────────────────────
  /**
   * Initialise the embedded engine.  Must be called once before any other
   * call.  Returns 0 on success; on failure the reason is available from
   * {@link FirebirdWasmModule._fb_last_error}.
   */
  _fb_init(): number;
  /**
   * Pointer to a NUL-terminated message describing the most recent failure,
   * or to an empty string when the last call succeeded.
   *
   * The buffer is owned by the engine and is overwritten by the next call —
   * read it with `UTF8ToString` immediately, and do not free it.
   */
  _fb_last_error(): number;
  /** Create a new database file at `pathPtr` and return a db handle (0 = failed). */
  _fb_create_database(pathPtr: number): FbHandle;
  /** Attach to an existing database at `pathPtr` (0 = failed). */
  _fb_attach_database(pathPtr: number): FbHandle;
  /** Detach from a database, rolling back any transaction left open on it. */
  _fb_detach_database(handle: FbHandle): number;
  /**
   * Execute a statement that returns no rows.
   *
   * @param txHandle - transaction to run in, or 0 to run the statement in its
   *                   own transaction (committed on success, rolled back on
   *                   failure).
   */
  _fb_execute(handle: FbHandle, txHandle: FbHandle, sqlPtr: number): number;
  /**
   * Execute a query and return a pointer to a JSON-encoded result set, or 0
   * on failure.  Release it with `_fb_free_result`.
   *
   * @param txHandle - transaction to run in, or 0 for a self-contained one.
   * @param flags - bit 0 sends binary BLOBs through the side channel instead
   *                of base64 inside the JSON.  See `BLOB_SIDE_CHANNEL`.
   */
  _fb_query(
    handle: FbHandle,
    txHandle: FbHandle,
    sqlPtr: number,
    flags: number,
  ): number;
  /**
   * Execute a statement with bound parameters.
   *
   * `paramsPtr` points at the packed parameter buffer (see
   * `encodeParams`), `paramsLength` is its size in bytes.  Pass 0/0 for none.
   */
  _fb_execute_params(
    handle: FbHandle,
    txHandle: FbHandle,
    sqlPtr: number,
    paramsPtr: number,
    paramsLength: number,
  ): number;
  /**
   * Execute one statement once per row of parameters (see `encodeParamRows`),
   * prepared once.  Returns 0 on success; `_fb_last_affected_rows` then
   * counts the whole batch.
   */
  _fb_execute_batch(
    handle: FbHandle,
    txHandle: FbHandle,
    sqlPtr: number,
    rowsPtr: number,
    rowsLength: number,
  ): number;
  /**
   * Execute a query with bound parameters.  Returns a pointer to the JSON
   * result set, or 0 on failure.  Release it with `_fb_free_result`.
   */
  _fb_query_params(
    handle: FbHandle,
    txHandle: FbHandle,
    sqlPtr: number,
    paramsPtr: number,
    paramsLength: number,
    flags: number,
  ): number;
  /**
   * Rows affected by the most recent execute.
   *
   * Like `_fb_last_error`, this is out-of-band state overwritten by the next
   * call — read it immediately.  A double because JavaScript numbers are
   * doubles, which keeps counts above 2^31 intact.
   */
  _fb_last_affected_rows(): number;
  /**
   * How many prepared statements each database keeps, keyed by their SQL
   * text (64 by default); returns the previous size.  0 turns the cache off.
   * Any change empties every database's cache.
   */
  _fb_statement_cache(size: number): number;
  /**
   * 1 runs this database's autocommit SELECTs in a read-only transaction it
   * keeps open, 0 (the default) each in one of its own; returns the previous
   * setting, or -1 for an unknown handle.  A SELECT that writes is run again
   * in its own transaction.
   */
  _fb_read_transaction(dbHandle: number, on: number): number;
  /**
   * The columns of a kept statement's shape, `{"columns":[...]}`, for a
   * result that named them by id (`{"shape":N,...}`); 0 if no kept statement
   * has that shape any more. Free with `_fb_free_result`.
   */
  _fb_shape_columns(id: number): number;
  /**
   * Pointer to the binary BLOB side buffer for the most recent query, or 0.
   *
   * Owned by the engine and replaced by the next query, like the error text —
   * read it immediately and do not free it.  Layout, little-endian:
   * a `u32` count, then one `u32` length per blob, then the bytes.
   */
  _fb_last_blobs(): number;
  /** Byte length of the buffer `_fb_last_blobs` points at; 0 when there is none. */
  _fb_last_blobs_size(): number;
  /**
   * Describe a statement without running it.
   *
   * Returns a pointer to JSON — `{params, columns, statementType}` — or 0 on
   * failure.  Released with `_fb_free_result`, like a result set.
   */
  _fb_describe(
    dbHandle: FbHandle,
    txHandle: FbHandle,
    sqlPtr: number,
  ): number;
  /**
   * Subscribe to one or more comma-separated event names.
   *
   * Returns a subscription handle, or 0 on failure.
   */
  _fb_events_subscribe(dbHandle: FbHandle, namesPtr: number): number;
  /**
   * Counts that have arrived since the last poll, as a JSON object keyed by
   * event name.  `{}` means nothing fired.  Released with `_free`.
   *
   * Polling also re-arms the subscription, which is why it exists at all: the
   * engine's callback runs on an engine thread, and re-arming from there would
   * mean calling into the engine from its own callback.
   */
  _fb_events_poll(subscriptionHandle: number): number;
  /** Cancel a subscription.  The handle is invalid afterwards. */
  _fb_events_cancel(subscriptionHandle: number): number;
  /** Free a result set returned by `_fb_query`. */
  _fb_free_result(resultPtr: number): void;
  /** Start a new transaction and return a transaction handle (0 = failed). */
  _fb_start_transaction(handle: FbHandle): FbHandle;
  /**
   * Start a transaction with an explicit isolation level.
   *
   * `isolation` is an {@link IsolationCode}; `readOnly` is 0 or 1.
   * Integers rather than strings: this crosses the WASM boundary on
   * every transaction, and a string would mean an allocation each time.
   */
  _fb_start_transaction_ex(
    handle: FbHandle,
    isolation: number,
    readOnly: number,
  ): FbHandle;
  /** Commit a transaction.  The handle is invalid afterwards either way. */
  _fb_commit(txHandle: FbHandle): number;
  /** Rollback a transaction.  The handle is invalid afterwards either way. */
  _fb_rollback(txHandle: FbHandle): number;

  // ── Emscripten memory helpers ───────────────────────────────────────────
  _malloc(size: number): number;
  _free(ptr: number): void;
  /**
   * The WASM heap as bytes.
   *
   * Re-read it after any call that might grow memory: growth replaces the
   * backing buffer and detaches every existing view.
   */
  HEAPU8: Uint8Array;

  // ── Emscripten runtime helpers ──────────────────────────────────────────
  UTF8ToString(ptr: number, maxLength?: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
  lengthBytesUTF8(str: string): number;

  // ── Emscripten virtual filesystem ───────────────────────────────────────
  FS: EmscriptenFS;
  MEMFS: unknown;
}

/** Options accepted by {@link loadFirebirdWasm}. */
export interface WasmLoadOptions {
  /**
   * URL or filesystem path to `firebird-embedded.wasm`.
   * When omitted the loader looks for the file next to the JS glue module.
   */
  wasmBinary?: ArrayBuffer | string;
  /**
   * URL or filesystem path to `firebird-embedded.js` (Emscripten glue).
   * Required in environments where dynamic `import()` cannot resolve it
   * automatically (e.g. bundled browser apps).
   */
  locateFile?: (filename: string) => string;
  /**
   * Which build to load.  `true` is `firebird-embedded.js`: pthreads over Web
   * Workers, whose heap is a `SharedArrayBuffer` and which a browser gives
   * only to a cross-origin isolated page.  `false` is
   * `firebird-embedded-st.js`: no threads and a plain `ArrayBuffer` heap, at
   * the cost of statement and idle timeouts.  `'auto'` (the default) is
   * `false` since 0.9.0: the build without threads runs everywhere, starts in
   * about a third of the time and was not slower in anything measured.  Pass
   * `true` for the threaded build (Node, or a cross-origin isolated page).
   *
   * In Node this picks the file the loader requires.  In a browser the page
   * loads the glue itself, so the choice is made there:
   * {@link wasmGlueFile} names the file to load.
   */
  threads?: boolean | 'auto';
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** One module per build: the two can live side by side in one process. */
const cachedModules = new Map<string, FirebirdWasmModule>();

/**
 * The glue script of the build `threads` selects.
 *
 * `'auto'` (the default) is the build without threads, which runs anywhere:
 * it needs no `SharedArrayBuffer`, so no cross-origin isolation, and no
 * Worker.  `true` is the threaded build, which a page can run only when it is
 * cross-origin isolated; it adds statement and idle timeouts.  Until 0.9.0
 * `'auto'` picked the threaded build where it could run.
 *
 * @example
 * ```js
 * // in the engine's Worker, before the transport loads the module
 * importScripts(`/wasm/${wasmGlueFile()}`);
 * // threads where the page allows them
 * importScripts(`/wasm/${wasmGlueFile(self.crossOriginIsolated)}`);
 * ```
 */
export function wasmGlueFile(threads: boolean | 'auto' = 'auto'): string {
  return useThreads(threads) ? 'firebird-embedded.js' : 'firebird-embedded-st.js';
}

function useThreads(threads: boolean | 'auto' | undefined): boolean {
  // 'auto' and undefined: the build without threads, everywhere.
  return threads === true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Firebird Embedded WASM module.
 *
 * The result is cached – subsequent calls return the same module instance.
 *
 * @param options - optional overrides for locating the WASM artefacts.
 * @returns The initialised Emscripten module with Firebird bindings.
 *
 * @example
 * ```ts
 * const mod = await loadFirebirdWasm();
 * mod._fb_init();
 * const dbHandle = mod._fb_create_database(allocString(mod, '/data/test.fdb'));
 * ```
 */
export async function loadFirebirdWasm(
  options: WasmLoadOptions = {},
): Promise<FirebirdWasmModule> {
  const glueFile = wasmGlueFile(options.threads);
  const cached = cachedModules.get(glueFile);
  if (cached) return cached;

  // The Emscripten glue script exports a factory function named
  // `createFirebirdModule` (configured via `-s EXPORT_NAME` in CMake).
  // In Node it can be `require()`-d; in browsers it is expected to be
  // available on `globalThis` or loaded via a <script> tag / importmap.
  const factory = await resolveFactory(glueFile);

  // Each build marks its factory (wasm/glue-threads.js, wasm/glue-st.js).
  // The threaded one cannot run without SharedArrayBuffer: its runtime fails
  // to hand its memory to its own workers, the error is not reported to the
  // caller, and every call waits forever.  Say so instead.
  if (factory.threads === true && (globalThis as Record<string, unknown>)['crossOriginIsolated'] === false) {
    throw new Error(
      'firebird-embedded.js is the threaded build, which needs SharedArrayBuffer, and this page is ' +
        'not cross-origin isolated (it needs COOP/COEP headers).  Load firebird-embedded-st.js, the ' +
        'build without threads, instead: wasmGlueFile() names the build a page can run.',
    );
  }

  const moduleOptions: Record<string, unknown> = {};

  if (options.locateFile) {
    moduleOptions['locateFile'] = options.locateFile;
  }

  if (options.wasmBinary) {
    if (typeof options.wasmBinary === 'string') {
      moduleOptions['locateFile'] = () => options.wasmBinary as string;
    } else {
      moduleOptions['wasmBinary'] = options.wasmBinary;
    }
  }

  const mod: FirebirdWasmModule = await factory(moduleOptions);
  cachedModules.set(glueFile, mod);
  return mod;
}

/** Options for {@link cdnArtifacts}. */
export interface CdnOptions {
  /** Which build; as {@link wasmGlueFile}.  Default `'auto'`. */
  threads?: boolean | 'auto';
  /**
   * `'jsdelivr'` (the default), `'unpkg'`, or the base URL of a directory
   * holding the four artifacts, such as a mirror of `dist/wasm/`.
   */
  cdn?: 'jsdelivr' | 'unpkg' | string;
  /** The package version to load.  Default: this package's own. */
  version?: string;
}

/** Where to load the engine from: the glue script, and a `locateFile` for its `.wasm`. */
export interface CdnArtifacts {
  /** URL of the glue script, for `importScripts()` or a `<script src>`. */
  glueUrl: string;
  /** Pass to `FirebirdBrowser`, `DirectTransport` or `FIREBIRD_WORKER_OPTIONS`. */
  locateFile: (file: string) => string;
}

/**
 * The engine's URLs on a CDN, so nothing has to be copied next to the app.
 *
 * Emscripten finds the `.wasm` next to the script that loaded the glue.  Glue
 * pulled into a Worker with `importScripts()` sees the *Worker's* URL instead,
 * so without a `locateFile` it fetches the binary from the app's own origin;
 * this pairs the glue's URL with one that points at the CDN.  The URLs name
 * this package's exact version by default, so the glue and the TypeScript
 * calling it always match.
 *
 * Both builds load this way.  jsDelivr and unpkg send
 * `Cross-Origin-Resource-Policy: cross-origin`, which a cross-origin isolated
 * page needs for the threaded build; the threaded build's own workers start
 * from the Worker's script, which must be on the app's origin.
 *
 * @example
 * ```js
 * // the engine Worker, on the app's own origin
 * const { glueUrl, locateFile } = cdnArtifacts();
 * importScripts(glueUrl);
 * self.FIREBIRD_WORKER_OPTIONS = { locateFile };
 * ```
 */
export function cdnArtifacts(options: CdnOptions = {}): CdnArtifacts {
  const version = options.version ?? VERSION;
  const cdn = options.cdn ?? 'jsdelivr';
  const base =
    cdn === 'jsdelivr'
      ? `https://cdn.jsdelivr.net/npm/firebird-wasm@${version}/dist/wasm/`
      : cdn === 'unpkg'
        ? `https://unpkg.com/firebird-wasm@${version}/dist/wasm/`
        : cdn.endsWith('/') ? cdn : `${cdn}/`;
  return {
    glueUrl: base + wasmGlueFile(options.threads),
    locateFile: (file: string) => base + file,
  };
}

/**
 * True when the module's heap is a `SharedArrayBuffer`, which is the case for
 * the threaded build only.
 */
export function hasSharedHeap(mod: FirebirdWasmModule): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && mod.HEAPU8.buffer instanceof SharedArrayBuffer;
}

/**
 * Allocate a UTF-8 C string on the WASM heap and return its pointer.
 * The caller is responsible for calling `mod._free(ptr)` afterwards.
 */
export function allocString(mod: FirebirdWasmModule, str: string): number {
  const len = mod.lengthBytesUTF8(str) + 1;
  const ptr = mod._malloc(len);
  mod.stringToUTF8(str, ptr, len);
  return ptr;
}

/**
 * Read the engine's message for the most recent failure.
 *
 * Returns an empty string when the engine reported nothing, so callers should
 * always have a fallback of their own rather than surfacing a bare "".
 */
export function lastError(mod: FirebirdWasmModule): string {
  const ptr = mod._fb_last_error();
  return ptr ? mod.UTF8ToString(ptr) : '';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ModuleFactory = ((opts?: Record<string, unknown>) => Promise<FirebirdWasmModule>) & {
  /** Which build this is, set by the glue (wasm/glue-*.js); absent from older artifacts. */
  threads?: boolean;
};

async function resolveFactory(glueFile: string): Promise<ModuleFactory> {
  // Node.js environment
  if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined') {
    try {
      // Two literal requires, not one with the name in a template: a bundler
      // resolves string literals (and marks these external), but turns a
      // template into a glob over dist/wasm, .wasm files included.
      const glue = glueFile === 'firebird-embedded-st.js'
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ? require('../dist/wasm/firebird-embedded-st.js')
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        : require('../dist/wasm/firebird-embedded.js');
      return glue as ModuleFactory;
    } catch {
      throw new Error(
        `${glueFile} not found.  Run the WASM build first: packages/firebird-wasm/wasm/build.sh`,
      );
    }
  }

  // Browser environment – look on globalThis
  const g = globalThis as Record<string, unknown>;
  if (typeof g['createFirebirdModule'] === 'function') {
    return g['createFirebirdModule'] as ModuleFactory;
  }

  throw new Error(
    'Could not locate the Firebird WASM module.  ' +
      'In browsers, load firebird-embedded.js via a <script> tag before calling loadFirebirdWasm().',
  );
}
