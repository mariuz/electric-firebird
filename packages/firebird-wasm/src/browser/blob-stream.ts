/**
 * blob-stream.ts – Segmented BLOB streaming (`openBlobStream` & `createBlobStream`)
 * over Web Streams (`ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>`).
 */

import type { BlobHandle, BlobStreamOptions, BlobWritableStream } from '../types';

/** Default segment size for BLOB streaming (32 KiB). */
export const DEFAULT_BLOB_SEGMENT_SIZE = 32 * 1024;

/** Maximum single-segment payload accepted by Firebird `IBlob::putSegment` (65535 bytes). */
export const MAX_BLOB_SEGMENT_SIZE = 65535;

/** Internal symbol carrying staged bytes or native driver blob reference when needed. */
export const BLOB_INTERNAL_DATA = Symbol.for('firebird-wasm.blobInternalData');

export interface InternalBlobHandle extends BlobHandle {
  [BLOB_INTERNAL_DATA]?: {
    /** Staged bytes for standalone `db.createBlobStream()` or fallback transport. */
    stagedBytes?: Uint8Array;
    /** Native driver `FbBlob` object when created inside a `FirebirdTransaction`. */
    nativeBlob?: unknown;
  };
}

/**
 * Validate and normalize `segmentSize` (default `32768`, capped at `65535` when `capForWrite` is true).
 */
export function resolveBlobSegmentSize(segmentSize?: number, capForWrite = false): number {
  if (segmentSize === undefined) {
    return DEFAULT_BLOB_SEGMENT_SIZE;
  }
  if (!Number.isInteger(segmentSize) || segmentSize <= 0) {
    throw new RangeError(
      `segmentSize must be a positive integer, got ${String(segmentSize)}`,
    );
  }
  return capForWrite ? Math.min(segmentSize, MAX_BLOB_SEGMENT_SIZE) : segmentSize;
}

/**
 * Construct a {@link BlobHandle} wrapping an 8-byte Firebird `ISC_QUAD` ID.
 */
export function createBlobHandle(
  blobId: Uint8Array,
  byteLength: number,
  internal?: InternalBlobHandle[typeof BLOB_INTERNAL_DATA],
): BlobHandle {
  const idCopy = new Uint8Array(8);
  idCopy.set(blobId.subarray(0, 8));
  const handle: InternalBlobHandle = {
    __brand: 'FirebirdBlobHandle',
    blobId: idCopy,
    byteLength,
  };
  if (internal) {
    Object.defineProperty(handle, BLOB_INTERNAL_DATA, {
      value: internal,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return handle;
}

/**
 * Return `true` when `value` is a {@link BlobHandle}.
 */
export function isBlobHandle(value: unknown): value is BlobHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as BlobHandle).__brand === 'FirebirdBlobHandle' &&
    (value as BlobHandle).blobId instanceof Uint8Array &&
    (value as BlobHandle).blobId.byteLength === 8
  );
}

/**
 * Return `true` when `value` is a {@link BlobWritableStream}.
 */
export function isBlobWritableStream(value: unknown): value is BlobWritableStream {
  return (
    typeof value === 'object' &&
    value !== null &&
    'finish' in value &&
    'writeChunk' in value &&
    'handle' in value &&
    typeof (value as BlobWritableStream).finish === 'function'
  );
}

/**
 * Extract a finalized {@link InternalBlobHandle} from a parameter value if it
 * is a `BlobHandle` or a closed `BlobWritableStream`.
 *
 * @throws if `value` is an unclosed `BlobWritableStream`.
 */
export function extractBlobHandle(value: unknown, paramIndex?: number): InternalBlobHandle | null {
  if (isBlobHandle(value)) {
    return value as InternalBlobHandle;
  }
  if (isBlobWritableStream(value)) {
    if (!value.handle) {
      const prefix = paramIndex !== undefined ? `Parameter ${paramIndex}: ` : '';
      throw new Error(
        `${prefix}BlobWritableStream must be closed (e.g. via finish(), writer.close(), or pipeTo()) before binding as a query parameter`,
      );
    }
    return value.handle as InternalBlobHandle;
  }
  return null;
}

/**
 * Split a `Uint8Array` into slices of at most `maxSegmentSize` bytes and pass
 * each slice to `putSegment`.
 */
export async function writeChunkInSegments(
  chunk: Uint8Array,
  maxSegmentSize: number,
  putSegment: (segment: Uint8Array) => Promise<void>,
): Promise<void> {
  if (chunk.byteLength === 0) return;
  for (let offset = 0; offset < chunk.byteLength; offset += maxSegmentSize) {
    const end = Math.min(offset + maxSegmentSize, chunk.byteLength);
    await putSegment(chunk.subarray(offset, end));
  }
}

export interface BlobStreamSink {
  writeSegment(segment: Uint8Array): Promise<void>;
  close(totalBytes: number): Promise<BlobHandle>;
  abort(reason?: unknown): Promise<void>;
}

/**
 * Create a {@link BlobWritableStream} backed by `sink`.
 */
export function buildBlobWritableStream(
  sink: BlobStreamSink,
  options: BlobStreamOptions = {},
): BlobWritableStream {
  const maxSegment = resolveBlobSegmentSize(options.segmentSize, true);
  const encoder = new TextEncoder();
  let totalBytes = 0;
  let finalizedHandle: BlobHandle | null = null;
  let sinkClosed = false;
  let resolveClosed!: (handle: BlobHandle) => void;
  let rejectClosed!: (err: unknown) => void;

  const closedPromise = new Promise<BlobHandle>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Prevent unhandled rejection if caller only awaits writer.close() or pipeTo()
  closedPromise.catch(() => undefined);

  const finalizeClose = async (): Promise<BlobHandle> => {
    if (finalizedHandle) return finalizedHandle;
    if (sinkClosed) {
      return closedPromise;
    }
    sinkClosed = true;
    try {
      const handle = await sink.close(totalBytes);
      finalizedHandle = handle;
      resolveClosed(handle);
      return handle;
    } catch (err) {
      rejectClosed(err);
      throw err;
    }
  };

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const bytes =
        chunk instanceof Uint8Array
          ? chunk
          : typeof chunk === 'string'
            ? encoder.encode(chunk)
            : new Uint8Array(chunk as ArrayBufferLike);
      await writeChunkInSegments(bytes, maxSegment, (seg) => sink.writeSegment(seg));
      totalBytes += bytes.byteLength;
    },
    async close() {
      await finalizeClose();
    },
    async abort(reason) {
      if (!sinkClosed) {
        sinkClosed = true;
        await sink.abort(reason).catch(() => undefined);
        const err = reason instanceof Error ? reason : new Error(String(reason ?? 'Blob stream aborted'));
        rejectClosed(err);
      }
    },
  });

  let directWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  Object.defineProperties(writable, {
    closed: {
      get: () => closedPromise,
      enumerable: true,
    },
    handle: {
      get: () => finalizedHandle,
      enumerable: true,
    },
    byteLength: {
      get: () => totalBytes,
      enumerable: true,
    },
    writeChunk: {
      value: async (chunk: Uint8Array | string): Promise<void> => {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        if (!directWriter) {
          directWriter = writable.getWriter();
        }
        await directWriter.write(bytes);
      },
      enumerable: true,
    },
    finish: {
      value: async (): Promise<BlobHandle> => {
        if (directWriter) {
          const w = directWriter;
          directWriter = null;
          await w.close();
        } else if (!finalizedHandle) {
          const w = writable.getWriter();
          await w.close();
        }
        return closedPromise;
      },
      enumerable: true,
    },
  });

  return writable as BlobWritableStream;
}

export interface BlobStreamSource {
  readSegment(maxBytes: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

/**
 * Create a Web `ReadableStream<Uint8Array>` backed by `source`.
 */
export function buildBlobReadableStream(
  source: BlobStreamSource,
  options: BlobStreamOptions = {},
): ReadableStream<Uint8Array> {
  const segmentSize = resolveBlobSegmentSize(options.segmentSize, false);
  let closed = false;

  const safeClose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await source.close().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await source.readSegment(segmentSize);
        if (chunk === null) {
          await safeClose();
          controller.close();
          return;
        }
        if (chunk.byteLength > 0) {
          controller.enqueue(chunk);
        } else {
          // Empty segment at EOF
          await safeClose();
          controller.close();
        }
      } catch (err) {
        await safeClose();
        controller.error(err);
      }
    },
    async cancel() {
      await safeClose();
    },
  });
}

/**
 * Resolve the 0-based column index from `options.column` against `fieldNames`.
 */
export function resolveBlobColumnIndex(
  column: number | string | undefined,
  fieldNames: readonly string[],
): number {
  if (fieldNames.length === 0) {
    throw new Error('openBlobStream: query does not return any columns');
  }
  if (column === undefined) {
    return 0;
  }
  if (typeof column === 'number') {
    if (!Number.isInteger(column) || column < 0 || column >= fieldNames.length) {
      throw new RangeError(
        `openBlobStream: column index ${column} is out of range (0..${fieldNames.length - 1})`,
      );
    }
    return column;
  }
  const upper = column.toUpperCase();
  const idx = fieldNames.findIndex((name) => name === column || name.toUpperCase() === upper);
  if (idx < 0) {
    throw new Error(
      `openBlobStream: column "${column}" not found in result set (${fieldNames.join(', ')})`,
    );
  }
  return idx;
}
