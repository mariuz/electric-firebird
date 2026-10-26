/**
 * data-stream.ts – Streaming and gzip-compressed database dump & restore helpers.
 */

import type { DataStreamOptions } from '../types';

/** Default chunk size for `dumpDataStream()`: 64 KiB (8 × 8 KiB pages). */
/** Default chunk size for `dumpDataStream()`: 64 KiB (8 × 8 KiB pages). */
export const DEFAULT_STREAM_CHUNK_SIZE = 65536;

/** Return `true` when `bytes` starts with the 2-byte gzip magic header (`0x1f 0x8b`). */
export function isGzipHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Create a `ReadableStream<Uint8Array>` that emits `bytes` in chunks of `chunkSize`. */
export function createChunkedByteStream(
  bytes: Uint8Array,
  chunkSize = DEFAULT_STREAM_CHUNK_SIZE,
): ReadableStream<Uint8Array> {
  const step = resolveStreamChunkSize(chunkSize);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const next = Math.min(offset + step, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, next));
      offset = next;
    },
  });
}

interface CompressionStreamConstructor {
  new (format: 'gzip' | 'deflate' | 'deflate-raw'): ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
}

function getCompressionStreamCtor(): CompressionStreamConstructor {
  const ctor = (
    globalThis as unknown as {
      CompressionStream?: CompressionStreamConstructor;
    }
  ).CompressionStream;
  if (typeof ctor !== 'function') {
    throw new Error(
      'CompressionStream is not available in this environment; cannot compress with gzip',
    );
  }
  return ctor;
}

function getDecompressionStreamCtor(): CompressionStreamConstructor {
  const ctor = (
    globalThis as unknown as {
      DecompressionStream?: CompressionStreamConstructor;
    }
  ).DecompressionStream;
  if (typeof ctor !== 'function') {
    throw new Error(
      'DecompressionStream is not available in this environment; cannot decompress gzip stream',
    );
  }
  return ctor;
}

/**
 * Pipe a `ReadableStream<Uint8Array>` through `CompressionStream('gzip')`.
 */
export function compressGzipStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const Ctor = getCompressionStreamCtor();
  return source.pipeThrough(new Ctor('gzip'));
}

/**
 * Pipe a `ReadableStream<Uint8Array>` through `DecompressionStream('gzip')`.
 */
export function decompressGzipStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const Ctor = getDecompressionStreamCtor();
  return source.pipeThrough(new Ctor('gzip'));
}

/**
 * Resolve a positive integer chunk size for `dumpDataStream()`.
 */
export function resolveStreamChunkSize(chunkSize?: number): number {
  const size = chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError('chunkSize must be a positive integer');
  }
  return size;
}

async function* iterateStreamOrIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (
    typeof (source as ReadableStream<Uint8Array>).getReader === 'function'
  ) {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          yield value instanceof Uint8Array ? value : new Uint8Array(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    if (chunk && chunk.byteLength > 0) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
  }
}

/**
 * Yield raw `.fdb` chunks from `source`, decompressing on the fly when
 * `options.compression === 'gzip'` or when the stream starts with the gzip
 * magic header (`0x1f 0x8b`) and `options.compression` is not `'none'`.
 */
export async function* readDatabaseStreamChunks(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DataStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  const iterator = iterateStreamOrIterable(source);
  const first = await iterator.next();
  if (first.done || !first.value) {
    return;
  }

  let firstChunk = first.value;
  let secondChunk: Uint8Array | undefined;
  if (firstChunk.byteLength === 1 && options.compression === undefined) {
    const second = await iterator.next();
    if (!second.done && second.value) {
      const merged = new Uint8Array(1 + second.value.byteLength);
      merged[0] = firstChunk[0]!;
      merged.set(second.value, 1);
      firstChunk = merged;
    }
  }

  const hasGzipMagic =
    firstChunk.byteLength >= 2 &&
    firstChunk[0] === 0x1f &&
    firstChunk[1] === 0x8b;
  const shouldDecompress =
    options.compression === 'gzip' ||
    (options.compression === undefined && hasGzipMagic);

  if (!shouldDecompress) {
    yield firstChunk;
    if (secondChunk) yield secondChunk;
    for await (const chunk of iterator) {
      yield chunk;
    }
    return;
  }

  let sentFirst = false;
  const rawStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(firstChunk);
        return;
      }
      const next = await iterator.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  const decompressed = decompressGzipStream(rawStream);
  for await (const chunk of iterateStreamOrIterable(decompressed)) {
    yield chunk;
  }
}
