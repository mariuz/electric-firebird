/**
 * serve-engine.ts – answer engine requests arriving at a Worker.
 *
 * Kept apart from worker-entry.ts, which starts serving as soon as it is
 * loaded: this module has no side effects, so the library's index can export
 * serveEngine() without every importer of the library, page or Worker,
 * starting an engine server.
 */

import type { QueryParams } from '../types';
import type { EngineTransport, BinaryResultPayload } from './engine-transport';
import { encodeBinaryResultSet, isBinaryResultPayload } from './binary-result';
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

function isTransferableBuffer(buf: ArrayBufferLike): buf is ArrayBuffer {
  return (
    typeof SharedArrayBuffer === 'undefined' ||
    !(buf instanceof SharedArrayBuffer)
  );
}

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
function collectBlobBuffers(result: unknown): ArrayBuffer[] {
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

  return [...buffers].filter(isTransferableBuffer);
}

function collectTransferables(result: unknown): Transferable[] {
  if (result instanceof Uint8Array) {
    return isTransferableBuffer(result.buffer) ? [result.buffer] : [];
  }
  if (isBinaryResultPayload(result)) {
    return isTransferableBuffer(result.binaryResult.buffer)
      ? [result.binaryResult.buffer]
      : [];
  }
  return collectBlobBuffers(result);
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
  // A page's window receives messages from every window that can reach it,
  // other origins included: a frame, an opener.  Serving the engine there
  // would hand each of them the database.  A dedicated Worker hears only its
  // owner.
  if (typeof (scope as { document?: unknown }).document !== 'undefined') {
    throw new Error(
      'serveEngine() serves the engine to a Worker\'s owner; called on a page, it would answer ' +
        'any window that can postMessage to it.  Call it in the engine\'s Worker.',
    );
  }
  const sentShapes = new Set<number>();
  const prepareBinaryPayload = (
    payload: BinaryResultPayload,
  ): BinaryResultPayload => {
    if (typeof payload.shapeId === 'number') {
      if (sentShapes.has(payload.shapeId)) {
        return {
          binaryResult: payload.binaryResult,
          shapeId: payload.shapeId,
        };
      }
      if (payload.shapeFields) {
        if (sentShapes.size >= 256) sentShapes.clear();
        sentShapes.add(payload.shapeId);
      }
    }
    return payload;
  };
  const reply = (response: EngineResponse): void => {
    // Transfer the buffer for readFile and "FBR\x01" binary query/cursor results
    // rather than copying them across the Worker boundary.
    const transfer = collectTransferables(response.result);
    scope.postMessage(response, transfer);
  };

  scope.addEventListener('message', (event: MessageEvent<EngineRequest>) => {
    const { id, op, args } = event.data;

    void (async () => {
      try {
        if (op === 'query' || op === 'queryBinary') {
          const dbHandle = args[0] as number;
          const txHandle = args[1] as number;
          const sql = args[2] as string;
          const params = (args[3] as QueryParams | undefined) ?? [];
          const binaryBlobs = Boolean(op === 'query' ? args[5] : args[4]);
          if (typeof transport.queryBinary === 'function') {
            const payload = await transport.queryBinary(
              dbHandle,
              txHandle,
              sql,
              params,
              binaryBlobs,
            );
            reply({ id, ok: true, result: prepareBinaryPayload(payload) });
            return;
          }
          if (typeof transport.query === 'function') {
            const decoded = await transport.query<unknown[]>(
              dbHandle,
              txHandle,
              sql,
              params,
              'array',
              binaryBlobs,
            );
            const binaryResult = encodeBinaryResultSet(decoded, {
              rowMode: 'array',
            });
            reply({ id, ok: true, result: { binaryResult } });
            return;
          }
          throw new Error(`unknown engine operation: ${op}`);
        }

        if (op === 'cursorFetch' || op === 'cursorFetchBinary') {
          const cursorHandle = args[0] as number;
          const batchSize = args[1] as number;
          const binaryBlobs = Boolean(op === 'cursorFetch' ? args[3] : args[2]);
          if (typeof transport.cursorFetchBinary === 'function') {
            const payload = await transport.cursorFetchBinary(
              cursorHandle,
              batchSize,
              binaryBlobs,
            );
            reply({ id, ok: true, result: prepareBinaryPayload(payload) });
            return;
          }
          if (typeof transport.cursorFetch === 'function') {
            const decoded = await transport.cursorFetch<unknown[]>(
              cursorHandle,
              batchSize,
              'array',
              binaryBlobs,
            );
            const binaryResult = encodeBinaryResultSet(decoded, {
              rowMode: 'array',
            });
            reply({ id, ok: true, result: { binaryResult } });
            return;
          }
          throw new Error(`unknown engine operation: ${op}`);
        }

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
