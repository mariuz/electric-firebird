/**
 * serve-engine.ts – answer engine requests arriving at a Worker.
 *
 * Kept apart from worker-entry.ts, which starts serving as soon as it is
 * loaded: this module has no side effects, so the library's index can export
 * serveEngine() without every importer of the library, page or Worker,
 * starting an engine server.
 */

import type { QueryParams, TransactionOptions } from '../types';
import type { EngineTransport, BinaryResultPayload } from './engine-transport';
import { encodeBinaryResultSet, isBinaryResultPayload } from './binary-result';
import {
  decodeWireParamRows,
  decodeWireParams,
  isWireParamRowsBuffer,
  isWireParamsBuffer,
} from './wire-params';
import {
  isEnginePipelineResponseArray,
  type EnginePipelineStepRequest,
  type EnginePipelineStepResponse,
  type EnginePipelineWireOptions,
} from '../pipeline';
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
  if (isEnginePipelineResponseArray(result)) {
    const buffers = new Set<ArrayBuffer>();
    for (const item of result) {
      if (item.kind === 'binary' && isTransferableBuffer(item.payload.binaryResult.buffer)) {
        buffers.add(item.payload.binaryResult.buffer);
      }
    }
    return [...buffers];
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

    const unwrapParamsArg = (raw: unknown): QueryParams | Uint8Array => {
      if (raw === undefined || raw === null) return [];
      if (isWireParamsBuffer(raw)) {
        return transport.acceptsWireParams ? raw : decodeWireParams(raw);
      }
      return raw as QueryParams;
    };

    const unwrapRowsArg = (raw: unknown): QueryParams[] | Uint8Array => {
      if (raw === undefined || raw === null) return [];
      if (isWireParamRowsBuffer(raw)) {
        return transport.acceptsWireParams ? raw : decodeWireParamRows(raw);
      }
      return raw as QueryParams[];
    };

    void (async () => {
      try {
        if (op === 'pipeline') {
          const dbHandle = args[0] as number;
          const txHandle = args[1] as number;
          const rawSteps = (args[2] as EnginePipelineStepRequest[]) ?? [];
          const wireOpts = (args[3] as EnginePipelineWireOptions | undefined) ?? {};
          const steps = transport.acceptsWireParams
            ? rawSteps
            : rawSteps.map((s): EnginePipelineStepRequest =>
                s.op === 'executeBatch'
                  ? { op: 'executeBatch', sql: s.sql, rows: unwrapRowsArg(s.rows) }
                  : s.op === 'execute'
                    ? { op: 'execute', sql: s.sql, params: unwrapParamsArg(s.params) }
                    : {
                        op: 'queryBinary',
                        sql: s.sql,
                        params: unwrapParamsArg(s.params),
                        binaryBlobs: s.binaryBlobs,
                      },
              );

          let rawOut: EnginePipelineStepResponse[];
          if (typeof transport.pipeline === 'function') {
            rawOut = await transport.pipeline(dbHandle, txHandle, steps, wireOpts);
          } else {
            let activeTx = txHandle;
            const ownsTx = activeTx === 0 && Boolean(wireOpts.transaction);
            if (ownsTx) {
              const txOpts: TransactionOptions =
                typeof wireOpts.transaction === 'object' && wireOpts.transaction !== null
                  ? wireOpts.transaction
                  : {};
              activeTx = await transport.startTransaction(dbHandle, txOpts);
            }
            rawOut = new Array(steps.length);
            try {
              for (let i = 0; i < steps.length; i++) {
                const s = steps[i]!;
                if (s.op === 'execute') {
                  rawOut[i] = {
                    kind: 'affected',
                    affectedRows: await transport.execute(dbHandle, activeTx, s.sql, s.params),
                  };
                } else if (s.op === 'executeBatch') {
                  rawOut[i] = {
                    kind: 'affected',
                    affectedRows: await transport.executeBatch(dbHandle, activeTx, s.sql, s.rows),
                  };
                } else if (typeof transport.queryBinary === 'function') {
                  rawOut[i] = {
                    kind: 'binary',
                    payload: await transport.queryBinary(
                      dbHandle,
                      activeTx,
                      s.sql,
                      s.params,
                      s.binaryBlobs,
                    ),
                  };
                } else {
                  const decoded = await transport.query<unknown[]>(
                    dbHandle,
                    activeTx,
                    s.sql,
                    s.params,
                    'array',
                    s.binaryBlobs,
                  );
                  rawOut[i] = {
                    kind: 'binary',
                    payload: { binaryResult: encodeBinaryResultSet(decoded, { rowMode: 'array' }) },
                  };
                }
              }
              if (ownsTx) await transport.commit(activeTx);
            } catch (err) {
              if (ownsTx && activeTx !== 0) {
                await transport.rollback(activeTx).catch(() => undefined);
              }
              throw err;
            }
          }

          const prepared = rawOut.map((item) =>
            item.kind === 'binary'
              ? { kind: 'binary' as const, payload: prepareBinaryPayload(item.payload) }
              : item,
          );
          reply({ id, ok: true, result: prepared });
          return;
        }

        if (op === 'query' || op === 'queryBinary') {
          const dbHandle = args[0] as number;
          const txHandle = args[1] as number;
          const sql = args[2] as string;
          const params = unwrapParamsArg(args[3]);
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

        if (op === 'queryStmt' || op === 'queryStmtBinary') {
          const dbHandle = args[0] as number;
          const txHandle = args[1] as number;
          const stmtHandle = args[2] as number;
          const params = unwrapParamsArg(args[3]);
          const binaryBlobs = Boolean(op === 'queryStmt' ? args[5] : args[4]);
          if (typeof transport.queryStmtBinary === 'function') {
            const payload = await transport.queryStmtBinary(
              dbHandle,
              txHandle,
              stmtHandle,
              params,
              binaryBlobs,
            );
            reply({ id, ok: true, result: prepareBinaryPayload(payload) });
            return;
          }
          if (typeof transport.queryStmt === 'function') {
            const decoded = await transport.queryStmt<unknown[]>(
              dbHandle,
              txHandle,
              stmtHandle,
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

        let resolvedArgs = args;
        if (!transport.acceptsWireParams) {
          if (
            op === 'execute' ||
            op === 'cursorOpen' ||
            op === 'executeStmt' ||
            op === 'cursorOpenStmt' ||
            op === 'blobOpenQuery'
          ) {
            resolvedArgs = [...args];
            resolvedArgs[3] = unwrapParamsArg(args[3]);
          } else if (op === 'executeBatch' || op === 'executeBatchStmt') {
            resolvedArgs = [...args];
            resolvedArgs[3] = unwrapRowsArg(args[3]);
          }
        }

        const result = (await fn.apply(transport, resolvedArgs)) ?? null;
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
