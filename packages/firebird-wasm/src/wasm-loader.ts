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
  /** Initialise the embedded engine.  Must be called once before any other call. */
  _fb_init(): number;
  /** Create a new database file at `pathPtr` and return a db handle. */
  _fb_create_database(pathPtr: number): FbHandle;
  /** Attach to an existing database at `pathPtr`. */
  _fb_attach_database(pathPtr: number): FbHandle;
  /** Detach from a database. */
  _fb_detach_database(handle: FbHandle): number;
  /** Execute a non-query SQL statement. */
  _fb_execute(handle: FbHandle, sqlPtr: number): number;
  /** Execute a query and return a result-set handle. */
  _fb_query(handle: FbHandle, sqlPtr: number): number;
  /** Free a result set returned by `_fb_query`. */
  _fb_free_result(resultPtr: number): void;
  /** Start a new transaction and return a transaction handle. */
  _fb_start_transaction(handle: FbHandle): FbHandle;
  /** Commit a transaction. */
  _fb_commit(txHandle: FbHandle): number;
  /** Rollback a transaction. */
  _fb_rollback(txHandle: FbHandle): number;

  // ── Emscripten memory helpers ───────────────────────────────────────────
  _malloc(size: number): number;
  _free(ptr: number): void;

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
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let cachedModule: FirebirdWasmModule | null = null;

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
  if (cachedModule) return cachedModule;

  // The Emscripten glue script exports a factory function named
  // `createFirebirdModule` (configured via `-s EXPORT_NAME` in CMake).
  // In Node it can be `require()`-d; in browsers it is expected to be
  // available on `globalThis` or loaded via a <script> tag / importmap.
  const factory = await resolveFactory(options);

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
  cachedModule = mod;
  return mod;
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ModuleFactory = (opts?: Record<string, unknown>) => Promise<FirebirdWasmModule>;

async function resolveFactory(_options: WasmLoadOptions): Promise<ModuleFactory> {
  // Node.js environment
  if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const glue = require('../dist/wasm/firebird-embedded.js');
      return glue as ModuleFactory;
    } catch {
      throw new Error(
        'firebird-embedded.js not found.  Run the WASM build first: packages/firebird-wasm/wasm/build.sh',
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
