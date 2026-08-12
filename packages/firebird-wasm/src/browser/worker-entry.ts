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
 * The page must be cross-origin isolated (COOP/COEP): Emscripten's pthreads
 * need SharedArrayBuffer, which browsers withhold otherwise.
 */

import { DirectTransport } from './engine-transport';
import type { DirectTransportOptions, EngineTransport } from './engine-transport';
import type { EngineRequest, EngineResponse } from './worker-protocol';

/**
 * The part of a Worker's global scope this file uses.
 *
 * Declared structurally rather than using `DedicatedWorkerGlobalScope`, which
 * lives in TypeScript's `WebWorker` lib — and that cannot be combined with
 * `DOM` in one compilation without duplicate-declaration errors.  A library
 * shipping both browser and worker code has to avoid the clash.
 */
export interface EngineWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<EngineRequest>) => void,
  ): void;
}

/** Configuration read from `self.FIREBIRD_WORKER_OPTIONS`, if set. */
declare const self: EngineWorkerScope & {
  FIREBIRD_WORKER_OPTIONS?: DirectTransportOptions;
};

/**
 * Every distinct ArrayBuffer behind a Uint8Array in a query result.
 *
 * Only query results are walked, and only one level into each row: a value is
 * either a blob or it is not, and scanning arbitrary structures on every reply
 * would cost more than the transfer saves.
 *
 * De-duplicated because transferring the same buffer twice throws
 * DataCloneError, and two rows can hold views on one buffer if the same blob
 * appeared twice.
 */
function collectBlobBuffers(result: unknown): ArrayBufferLike[] {
  if (typeof result !== 'object' || result === null) return [];

  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];

  const buffers = new Set<ArrayBufferLike>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    // Rows are arrays in rowMode 'array' and plain objects otherwise;
    // Object.values covers both.
    for (const value of Object.values(row as Record<string, unknown>)) {
      if (value instanceof Uint8Array) buffers.add(value.buffer);
    }
  }

  return [...buffers];
}

/**
 * Wire a transport up to a Worker scope.
 *
 * Exported so a host application can build its own Worker entry point — for
 * example to set `locateFile` before any message is handled.
 */
export function serveEngine(
  scope: EngineWorkerScope,
  transport: EngineTransport,
): void {
  const reply = (response: EngineResponse): void => {
    // Transfer the buffer for readFile rather than copying it: a database
    // image is measured in megabytes and this runs on every persist.
    //
    // The same applies to binary BLOBs coming back from a query, which arrive
    // as Uint8Arrays inside the rows. Structured cloning would copy every one
    // of them across the boundary — the cost a base64 string could never avoid
    // and the reason the side channel is worth having at all.
    const transfer =
      response.result instanceof Uint8Array
        ? [response.result.buffer]
        : collectBlobBuffers(response.result);
    scope.postMessage(response, transfer as Transferable[]);
  };

  scope.addEventListener('message', (event: MessageEvent<EngineRequest>) => {
    const { id, op, args } = event.data;

    void (async () => {
      try {
        // The op names are exactly the transport's method names, so this is a
        // direct dispatch rather than a switch that has to be kept in step.
        const fn = (transport as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];

        if (typeof fn !== 'function') {
          throw new Error(`unknown engine operation: ${op}`);
        }

        const result = (await fn.apply(transport, args)) ?? null;
        reply({ id, ok: true, result: result as EngineResponse['result'] });
      } catch (err) {
        reply({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
}

// Auto-start when loaded as a Worker script.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
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
