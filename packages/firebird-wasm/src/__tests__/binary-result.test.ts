import {
  encodeBinaryResultSet,
  decodeBinaryResultSet,
  BINARY_RESULT_MAGIC_0,
  BINARY_RESULT_MAGIC_1,
  BINARY_RESULT_MAGIC_2,
  BINARY_RESULT_VERSION,
  BINARY_HEADER_HAS_SHAPE_ID,
  BINARY_CELL_INT32,
  DirectTransport,
} from '../browser/index';
import type { FieldInfo, QueryResult } from '../types';

describe('Binary result wire format (encodeBinaryResultSet / decodeBinaryResultSet)', () => {
  const sampleFields: FieldInfo[] = [
    {
      name: 'ID',
      type: 496,
      typeName: 'INTEGER',
      subType: 0,
      scale: 0,
      length: 4,
      nullable: false,
    },
    {
      name: 'ACTIVE',
      type: 32764,
      typeName: 'BOOLEAN',
      subType: 0,
      scale: 0,
      length: 1,
      nullable: true,
    },
    {
      name: 'SCORE',
      type: 480,
      typeName: 'DOUBLE',
      subType: 0,
      scale: 0,
      length: 8,
      nullable: true,
    },
    {
      name: 'TITLE',
      type: 448,
      typeName: 'VARYING',
      subType: 0,
      scale: 0,
      length: 120,
      nullable: true,
    },
    {
      name: 'PAYLOAD',
      type: 520,
      typeName: 'BLOB',
      subType: 0,
      scale: 0,
      length: 8,
      nullable: true,
    },
  ];

  test('round-trips booleans, int32, float64, utf8 strings, binary blobs, and nulls in object mode', () => {
    const rawBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42]);
    const input: QueryResult = {
      fields: sampleFields,
      rows: [
        {
          ID: 1,
          ACTIVE: true,
          SCORE: 98.75,
          TITLE: 'Hello Firebird 🔥',
          PAYLOAD: rawBytes,
        },
        {
          ID: -42,
          ACTIVE: false,
          SCORE: null,
          TITLE: '',
          PAYLOAD: null,
        },
      ],
    };

    const buffer = encodeBinaryResultSet(input);
    expect(buffer[0]).toBe(BINARY_RESULT_MAGIC_0);
    expect(buffer[1]).toBe(BINARY_RESULT_MAGIC_1);
    expect(buffer[2]).toBe(BINARY_RESULT_MAGIC_2);
    expect(buffer[3]).toBe(BINARY_RESULT_VERSION);
    expect(buffer[4]).toBe(0);

    // Decode with binaryBlobs = true -> Uint8Array
    const decodedBin = decodeBinaryResultSet(buffer, 'object', true);
    expect(decodedBin.fields).toEqual(sampleFields);
    expect(decodedBin.rows).toHaveLength(2);
    expect(decodedBin.rows[0]).toEqual({
      ID: 1,
      ACTIVE: true,
      SCORE: 98.75,
      TITLE: 'Hello Firebird 🔥',
      PAYLOAD: rawBytes,
    });
    expect(decodedBin.rows[1]).toEqual({
      ID: -42,
      ACTIVE: false,
      SCORE: null,
      TITLE: '',
      PAYLOAD: null,
    });

    // Decode with binaryBlobs = false -> base64 string
    const decodedB64 = decodeBinaryResultSet(buffer, 'object', false);
    expect(decodedB64.rows[0]?.PAYLOAD).toBe(
      Buffer.from(rawBytes).toString('base64'),
    );
  });

  test('round-trips positional rows in array mode and handles >8 columns null bitmask', () => {
    const tenFields: FieldInfo[] = Array.from({ length: 10 }, (_, idx) => ({
      name: `C${idx}`,
      type: 496,
      typeName: 'INTEGER',
      subType: 0,
      scale: 0,
      length: 4,
      nullable: true,
    }));

    const rows: unknown[][] = [
      [0, null, 2, null, 4, null, 6, null, 8, null],
      [null, 1, null, 3, null, 5, null, 7, null, 9],
    ];

    const buffer = encodeBinaryResultSet(
      { fields: tenFields, rows },
      { rowMode: 'array' },
    );
    const decoded = decodeBinaryResultSet<unknown[]>(buffer, 'array', true);
    expect(decoded.fields).toHaveLength(10);
    expect(decoded.rows).toEqual(rows);
  });

  test('supports compact shapeId headers resolved via shapes callback', () => {
    const input: QueryResult = {
      fields: sampleFields.slice(0, 2),
      rows: [{ ID: 7, ACTIVE: true }],
    };

    const buffer = encodeBinaryResultSet(input, { shapeId: 19 });
    expect(buffer[4]).toBe(BINARY_HEADER_HAS_SHAPE_ID);

    const decoded = decodeBinaryResultSet(buffer, 'object', false, (id) => {
      expect(id).toBe(19);
      return sampleFields.slice(0, 2);
    });
    expect(decoded.rows).toEqual([{ ID: 7, ACTIVE: true }]);
  });

  test('handles __proto__ column names safely in object mode', () => {
    const protoFields: FieldInfo[] = [
      {
        name: '__proto__',
        type: 496,
        typeName: 'INTEGER',
        subType: 0,
        scale: 0,
        length: 4,
        nullable: false,
      },
    ];
    const buffer = encodeBinaryResultSet(
      { fields: protoFields, rows: [[123]] },
      { rowMode: 'array' },
    );
    const decoded = decodeBinaryResultSet(buffer, 'object');
    expect(Object.prototype.hasOwnProperty.call(decoded.rows[0], '__proto__')).toBe(
      true,
    );
    expect((decoded.rows[0] as Record<string, unknown>)['__proto__']).toBe(123);
  });

  test('rejects malformed headers, missing shape resolver, and unknown cell tags', () => {
    expect(() => decodeBinaryResultSet(new Uint8Array([1, 2, 3]))).toThrow(
      /invalid binary result header/,
    );

    const shapeBuf = encodeBinaryResultSet(
      { fields: sampleFields.slice(0, 1), rows: [{ ID: 1 }] },
      { shapeId: 3 },
    );
    expect(() => decodeBinaryResultSet(shapeBuf)).toThrow(
      /no shapes resolver was provided/,
    );

    const corrupted = encodeBinaryResultSet({
      fields: sampleFields.slice(0, 1),
      rows: [{ ID: 1 }],
    });
    // Corrupt the cell tag right before the final 4-byte int32 payload
    corrupted[corrupted.byteLength - 5] = 99;
    expect(BINARY_CELL_INT32).toBe(2);
    expect(() => decodeBinaryResultSet(corrupted)).toThrow(/unknown cell tag 99/);
  });

  test('DirectTransport uses _fb_query_binary and _fb_cursor_fetch_binary when exported by WASM module', async () => {
    const encodedQuery = encodeBinaryResultSet({
      fields: sampleFields.slice(0, 2),
      rows: [{ ID: 101, ACTIVE: true }],
    });
    const encodedCursorBatch = encodeBinaryResultSet({
      fields: sampleFields.slice(0, 2),
      rows: [{ ID: 202, ACTIVE: false }],
    });

    const heap = new Uint8Array(4096);
    let bump = 64;
    const queryCalls: number[] = [];
    const cursorFetchCalls: number[] = [];

    const mockMod = {
      HEAPU8: heap,
      _malloc(size: number) {
        const ptr = bump;
        bump += (size + 7) & ~7;
        return ptr;
      },
      _free() {},
      _fb_free_result() {},
      _fb_last_error() {
        return 0;
      },
      lengthBytesUTF8(str: string) {
        return new TextEncoder().encode(str).byteLength;
      },
      stringToUTF8(str: string, outPtr: number) {
        const bytes = new TextEncoder().encode(str);
        heap.set(bytes, outPtr);
        heap[outPtr + bytes.byteLength] = 0;
      },
      UTF8ToString() {
        return '';
      },
      _fb_query_binary(
        dbHandle: number,
        _txHandle: number,
        _sqlPtr: number,
        _paramPtr: number,
        _paramLen: number,
        _flags: number,
        lenPtr: number,
      ) {
        queryCalls.push(dbHandle);
        const ptr = mockMod._malloc(encodedQuery.byteLength);
        heap.set(encodedQuery, ptr);
        new DataView(heap.buffer, heap.byteOffset + lenPtr, 4).setUint32(
          0,
          encodedQuery.byteLength,
          true,
        );
        return ptr;
      },
      _fb_cursor_fetch_binary(
        cursorHandle: number,
        _maxRows: number,
        _flags: number,
        lenPtr: number,
      ) {
        cursorFetchCalls.push(cursorHandle);
        const ptr = mockMod._malloc(encodedCursorBatch.byteLength);
        heap.set(encodedCursorBatch, ptr);
        new DataView(heap.buffer, heap.byteOffset + lenPtr, 4).setUint32(
          0,
          encodedCursorBatch.byteLength,
          true,
        );
        return ptr;
      },
    };

    const transport = new DirectTransport();
    (transport as unknown as { mod: unknown }).mod = mockMod;

    const qRes = await transport.query(1, 0, 'SELECT ID, ACTIVE FROM T');
    expect(queryCalls).toEqual([1]);
    expect(qRes.rows).toEqual([{ ID: 101, ACTIVE: true }]);

    const cRes = await transport.cursorFetch(5, 10);
    expect(cursorFetchCalls).toEqual([5]);
    expect(cRes.rows).toEqual([{ ID: 202, ACTIVE: false }]);
  });

  test('decodes UTF-8 strings safely from a SharedArrayBuffer-backed view (pthreads WASM heap)', () => {
    const encoded = encodeBinaryResultSet({
      fields: sampleFields,
      rows: [
        {
          ID: 7,
          ACTIVE: true,
          SCORE: 3.5,
          TITLE: 'Shared heap text',
          PAYLOAD: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    const sab = new SharedArrayBuffer(encoded.byteLength + 16);
    const sharedView = new Uint8Array(sab, 8, encoded.byteLength);
    sharedView.set(encoded);

    const origDecode = TextDecoder.prototype.decode;
    const decodeSpy = jest
      .spyOn(TextDecoder.prototype, 'decode')
      .mockImplementation(function (this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
        if (
          input &&
          ArrayBuffer.isView(input) &&
          input.buffer instanceof SharedArrayBuffer
        ) {
          throw new TypeError(
            "Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.",
          );
        }
        return origDecode.call(this, input as BufferSource, options);
      });

    try {
      const decoded = decodeBinaryResultSet(sharedView, 'object', true);
      expect(decoded.rows[0]?.TITLE).toBe('Shared heap text');
      expect(decoded.fields[3]?.name).toBe('TITLE');
    } finally {
      decodeSpy.mockRestore();
    }
  });
});
