/**
 * worker-entry.ts – the Worker side of the engine.
 *
 * Bundle this as the Worker script:
 *
 * ```ts
 * // firebird-engine-worker.ts
 * import 'firebird-wasm/browser/worker-entry';
 * ```
 *
 * ```ts
 * // application code
 * const worker = new Worker('/firebird-engine-worker.js');
 * const db = new FirebirdBrowser('mydb', { worker });
 * ```
 *
 * The Worker owns the WASM module and therefore Emscripten's filesystem, so it
 * serves filesystem requests too — persistence copies the database between
 * that filesystem and IndexedDB, and only this side can read it.
 *
 * With the threaded build the page must be cross-origin isolated (COOP/COEP):
 * Emscripten's pthreads need SharedArrayBuffer, which browsers withhold
 * otherwise.  The build without threads needs no isolation.
 *
 * Loading this module starts serving, but only in a dedicated Worker; the
 * library's index exports serveEngine from serve-engine.ts, which has no such
 * side effect, so importing the library starts nothing.
 */

import { DirectTransport } from './engine-transport';
import type { DirectTransportOptions } from './engine-transport';
import { serveEngine } from './serve-engine';
import type { EngineWorkerScope } from './serve-engine';

export { serveEngine } from './serve-engine';
export type { EngineWorkerScope } from './serve-engine';

/** Configuration read from `self.FIREBIRD_WORKER_OPTIONS`, if set. */
declare const self: EngineWorkerScope & {
  FIREBIRD_WORKER_OPTIONS?: DirectTransportOptions;
};

// Start serving when loaded as a dedicated Worker's script, and only then.
// `self.postMessage` alone is no test: a page's window has one too, and
// serving there would answer every window that can message the page.
const workerScope = (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
if (typeof workerScope === 'function' && self instanceof (workerScope as new () => object)
  && typeof self.postMessage === 'function') {
  try {
    serveEngine(self, new DirectTransport(self.FIREBIRD_WORKER_OPTIONS ?? {}));
  } catch (err) {
    // No request to answer yet, so report the bootstrap failure out of band;
    // WorkerTransport treats id -1 as "this worker is unusable".
    self.postMessage({
      id: -1,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
