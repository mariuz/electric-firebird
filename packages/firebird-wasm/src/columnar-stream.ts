/**
 * columnar-stream.ts – Bounded-Memory Streaming Columnar & Apache Arrow IPC V5
 * Cursors (`db.queryColumnarStream()` & `db.queryArrowStream()`) (`M21 Item 2`).
 */

import type { FieldInfo, QueryParams, QueryResult, QueryStreamOptions, Row } from './types';
import type { SqlFragment } from './sql-tag';
import {
  encodeArrowIpcEosFrame,
  encodeArrowIpcRecordBatchFrame,
  encodeArrowIpcSchemaFrame,
  rowsToColumnarResult,
  type ArrowIpcOptions,
  type ColumnarQueryResult,
} from './columnar';
import { assertNotAborted } from './database-core';

/** Options for `db.queryColumnarStream()` (`M21 Item 2`). */
export interface ColumnarStreamOptions {
  /** Maximum rows fetched per cursor batch. @default 1024 */
  batchSize?: number;
  /** Optional `AbortSignal` cancelling the underlying cursor. */
  signal?: AbortSignal;
}

/** Options for `db.queryArrowStream()` (`M21 Item 2`). */
export interface ArrowStreamOptions extends ColumnarStreamOptions, ArrowIpcOptions {}

/** Normalize overloaded `(sql, paramsOrOptions?, maybeOptions?)` arguments for streaming columnar/Arrow queries. */
export function resolveColumnarStreamArgs<TOpts extends ColumnarStreamOptions>(
  paramsOrOptions?: QueryParams | TOpts,
  maybeOptions?: TOpts,
): { params: QueryParams | undefined; options: TOpts | undefined } {
  if (Array.isArray(paramsOrOptions)) {
    return { params: paramsOrOptions, options: maybeOptions };
  }
  return {
    params: undefined,
    options: (paramsOrOptions as TOpts | undefined) ?? maybeOptions,
  };
}

/**
 * Create a bounded-memory `AsyncIterableIterator<ColumnarQueryResult>` from a
 * database's `queryStream()` cursor (`M21 Item 2`).
 */
export function createColumnarStreamFromRowStream(
  openRowStream: (
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: QueryStreamOptions,
  ) => AsyncIterableIterator<QueryResult<Row>>,
  sql: string | SqlFragment,
  paramsOrOptions?: QueryParams | ColumnarStreamOptions,
  maybeOptions?: ColumnarStreamOptions,
): AsyncIterableIterator<ColumnarQueryResult> {
  const { params, options } = resolveColumnarStreamArgs(paramsOrOptions, maybeOptions);
  const batchSize = Math.max(1, Math.floor(options?.batchSize ?? 1024));

  async function* generator(): AsyncGenerator<ColumnarQueryResult> {
    assertNotAborted(options?.signal);
    const stream = openRowStream(sql, params, {
      batchSize,
      signal: options?.signal,
    });
    for await (const batch of stream) {
      assertNotAborted(options?.signal);
      yield rowsToColumnarResult(batch);
    }
  }

  return generator();
}

/** Stream `FBR\x01` binary cursor chunks directly into `ColumnarQueryResult` batches (`M21 Item 2`). */
export async function* streamBinaryColumnarCursor(options: {
  ensureReady: () => Promise<void>;
  openCursor: () => Promise<number>;
  fetchBatch: (cursorHandle: number, batchSize: number) => Promise<ColumnarQueryResult>;
  closeCursor: (cursorHandle: number) => Promise<void>;
  batchSize: number;
  signal?: AbortSignal;
}): AsyncGenerator<ColumnarQueryResult> {
  assertNotAborted(options.signal);
  await options.ensureReady();
  const cursorHandle = await options.openCursor();
  let closed = false;
  try {
    for (;;) {
      assertNotAborted(options.signal);
      const col = await options.fetchBatch(cursorHandle, options.batchSize);
      if (col.rowCount === 0) break;
      yield col;
    }
    closed = true;
    await options.closeCursor(cursorHandle);
  } finally {
    if (!closed) {
      await options.closeCursor(cursorHandle).catch(() => undefined);
    }
  }
}

/**
 * Create a Web Streams `ReadableStream<Uint8Array>` emitting a spec-compliant
 * **Apache Arrow IPC V5** stream (`Schema` frame -> N `RecordBatch` frames -> `EOS`
 * marker) in bounded `O(batchSize)` memory (`M21 Item 2`).
 */
export function createArrowIpcReadableStream(
  openColumnarStream: () => AsyncIterableIterator<ColumnarQueryResult>,
  describeFallbackFields: () => Promise<readonly FieldInfo[]>,
  options?: ArrowStreamOptions,
): ReadableStream<Uint8Array> {
  let iterator: AsyncIterableIterator<ColumnarQueryResult> | null = null;
  let schemaEmitted = false;
  let finished = false;
  let bufferedBatch: ColumnarQueryResult | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      assertNotAborted(options?.signal);
      if (finished) {
        controller.close();
        return;
      }

      if (!iterator) {
        iterator = openColumnarStream();
      }

      if (bufferedBatch) {
        const nextBatch = bufferedBatch;
        bufferedBatch = null;
        controller.enqueue(encodeArrowIpcRecordBatchFrame(nextBatch));
        return;
      }

      const step = await iterator.next();
      if (step.done) {
        if (!schemaEmitted) {
          const fields = await describeFallbackFields();
          schemaEmitted = true;
          controller.enqueue(encodeArrowIpcSchemaFrame(fields, options));
        }
        finished = true;
        controller.enqueue(encodeArrowIpcEosFrame());
        controller.close();
        return;
      }

      const batch = step.value;
      if (!schemaEmitted) {
        schemaEmitted = true;
        bufferedBatch = batch;
        controller.enqueue(encodeArrowIpcSchemaFrame(batch, options));
        return;
      }

      controller.enqueue(encodeArrowIpcRecordBatchFrame(batch));
    },

    async cancel() {
      finished = true;
      bufferedBatch = null;
      if (iterator && typeof iterator.return === 'function') {
        await iterator.return();
      }
      iterator = null;
    },
  });
}

/** Collect all chunks from a `ReadableStream<Uint8Array>` into a single `Uint8Array` (`M21 Item 2`). */
export async function collectArrowStreamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}
