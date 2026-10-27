import {
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  DEFAULT_BLOB_SEGMENT_SIZE,
  extractBlobHandle,
  isBlobHandle,
  isBlobWritableStream,
  MAX_BLOB_SEGMENT_SIZE,
  resolveBlobColumnIndex,
  resolveBlobSegmentSize,
} from '../browser/blob-stream';

describe('blob-stream helpers', () => {
  it('validates and normalizes segmentSize', () => {
    expect(resolveBlobSegmentSize()).toBe(DEFAULT_BLOB_SEGMENT_SIZE);
    expect(resolveBlobSegmentSize(4096)).toBe(4096);
    expect(resolveBlobSegmentSize(100_000, true)).toBe(MAX_BLOB_SEGMENT_SIZE);
    expect(resolveBlobSegmentSize(100_000, false)).toBe(100_000);
    expect(() => resolveBlobSegmentSize(0)).toThrow(RangeError);
    expect(() => resolveBlobSegmentSize(-8)).toThrow(RangeError);
    expect(() => resolveBlobSegmentSize(1.5)).toThrow(RangeError);
  });

  it('resolves BLOB column index by number or case-insensitive name', () => {
    const fields = ['ID', 'TITLE', 'PAYLOAD'];
    expect(resolveBlobColumnIndex(undefined, fields)).toBe(0);
    expect(resolveBlobColumnIndex(2, fields)).toBe(2);
    expect(resolveBlobColumnIndex('payload', fields)).toBe(2);
    expect(resolveBlobColumnIndex('TITLE', fields)).toBe(1);
    expect(() => resolveBlobColumnIndex(-1, fields)).toThrow(RangeError);
    expect(() => resolveBlobColumnIndex(3, fields)).toThrow(RangeError);
    expect(() => resolveBlobColumnIndex('missing', fields)).toThrow(/not found/);
    expect(() => resolveBlobColumnIndex(0, [])).toThrow(/does not return any columns/);
  });

  it('splits large writes into bounded segments and finalizes a BlobHandle', async () => {
    const writtenSegments: Uint8Array[] = [];
    const blobStream = buildBlobWritableStream(
      {
        writeSegment: async (seg) => {
          writtenSegments.push(seg.slice());
        },
        close: async (totalBytes) =>
          createBlobHandle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), totalBytes),
        abort: async () => undefined,
      },
      { segmentSize: 10 },
    );

    expect(isBlobWritableStream(blobStream)).toBe(true);
    expect(blobStream.handle).toBeNull();
    // Binding before closing throws a descriptive error
    expect(() => extractBlobHandle(blobStream, 0)).toThrow(/must be closed/);

    const payload = new Uint8Array(25);
    for (let i = 0; i < payload.length; i++) payload[i] = i + 1;

    await blobStream.writeChunk(payload);
    await blobStream.writeChunk('abc');
    const handle = await blobStream.finish();

    expect(isBlobHandle(handle)).toBe(true);
    expect(blobStream.handle).toBe(handle);
    expect(handle.byteLength).toBe(28);
    expect(blobStream.byteLength).toBe(28);
    expect(writtenSegments.map((s) => s.byteLength)).toEqual([10, 10, 5, 3]);
    expect(extractBlobHandle(blobStream)).toBe(handle);
    expect(extractBlobHandle(handle)).toBe(handle);
  });

  it('streams segments from BlobStreamSource and closes on completion or early cancel', async () => {
    const sourceBytes = new Uint8Array(20);
    for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = i + 10;

    let offset = 0;
    let closeCalls = 0;
    const readable = buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          if (offset >= sourceBytes.byteLength) return null;
          const end = Math.min(offset + maxBytes, sourceBytes.byteLength);
          const slice = sourceBytes.slice(offset, end);
          offset = end;
          return slice;
        },
        close: async () => {
          closeCalls++;
        },
      },
      { segmentSize: 6 },
    );

    const chunks: Uint8Array[] = [];
    const reader = readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(chunks.map((c) => c.byteLength)).toEqual([6, 6, 6, 2]);
    expect(closeCalls).toBe(1);
  });
});
