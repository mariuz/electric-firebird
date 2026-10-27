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
  WorkerTransport,
  SharedEngineTransport,
  serveEngine,
  isBinaryResultPayload,
} from '../browser/index';
import type { EngineRequest, EngineResponse } from '../browser/index';
import * as leaderElectionModule from '../browser/leader-election';
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

  test('serveEngine and WorkerTransport transfer raw FBR\\x01 ArrayBuffers and deduplicate shapeFields', async () => {
    const queryFields = sampleFields.slice(0, 2);
    const shape11Buf1 = encodeBinaryResultSet(
      { fields: queryFields, rows: [{ ID: 1, ACTIVE: true }] },
      { shapeId: 11 },
    );
    const shape11Buf2 = encodeBinaryResultSet(
      { fields: queryFields, rows: [{ ID: 2, ACTIVE: false }] },
      { shapeId: 11 },
    );
    const cursorBuf = encodeBinaryResultSet({
      fields: queryFields,
      rows: [
        { ID: 10, ACTIVE: true },
        { ID: 20, ACTIVE: false },
      ],
    });

    const heap = new Uint8Array(8192);
    let bump = 64;
    let queryCallIndex = 0;

    const shapeJson = JSON.stringify({
      columns: queryFields.map((f) => ({
        name: f.name,
        type: f.type,
        subType: f.subType,
        scale: f.scale,
        length: f.length,
        nullable: f.nullable,
      })),
    });

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
      UTF8ToString(ptr: number) {
        let end = ptr;
        while (end < heap.length && heap[end] !== 0) end++;
        return new TextDecoder().decode(heap.subarray(ptr, end));
      },
      _fb_shape_columns(shapeId: number) {
        expect(shapeId).toBe(11);
        const bytes = new TextEncoder().encode(shapeJson);
        const ptr = mockMod._malloc(bytes.byteLength + 1);
        heap.set(bytes, ptr);
        heap[ptr + bytes.byteLength] = 0;
        return ptr;
      },
      _fb_query_binary(
        _dbHandle: number,
        _txHandle: number,
        _sqlPtr: number,
        _paramPtr: number,
        _paramLen: number,
        _flags: number,
        lenPtr: number,
      ) {
        const payload = queryCallIndex++ === 0 ? shape11Buf1 : shape11Buf2;
        const ptr = mockMod._malloc(payload.byteLength);
        heap.set(payload, ptr);
        new DataView(heap.buffer, heap.byteOffset + lenPtr, 4).setUint32(
          0,
          payload.byteLength,
          true,
        );
        return ptr;
      },
      _fb_cursor_fetch_binary(
        _cursorHandle: number,
        _maxRows: number,
        _flags: number,
        lenPtr: number,
      ) {
        const ptr = mockMod._malloc(cursorBuf.byteLength);
        heap.set(cursorBuf, ptr);
        new DataView(heap.buffer, heap.byteOffset + lenPtr, 4).setUint32(
          0,
          cursorBuf.byteLength,
          true,
        );
        return ptr;
      },
    };

    const direct = new DirectTransport();
    (direct as unknown as { mod: unknown }).mod = mockMod;

    // Wire up an in-memory Worker scope + Worker client pair
    const workerScopeListeners: Array<(ev: MessageEvent<EngineRequest>) => void> = [];
    const clientListeners: Array<(ev: MessageEvent<EngineResponse>) => void> = [];
    const recordedReplies: Array<{
      response: EngineResponse;
      transfer?: Transferable[];
    }> = [];

    const workerScope = {
      addEventListener(
        type: 'message',
        listener: (ev: MessageEvent<EngineRequest>) => void,
      ) {
        if (type === 'message') workerScopeListeners.push(listener);
      },
      postMessage(message: unknown, transfer?: Transferable[]) {
        const response = message as EngineResponse;
        recordedReplies.push({ response, transfer });
        for (const fn of clientListeners) {
          fn({ data: response } as MessageEvent<EngineResponse>);
        }
      },
    };

    const fakeWorker = {
      addEventListener(type: string, listener: unknown) {
        if (type === 'message') {
          clientListeners.push(
            listener as (ev: MessageEvent<EngineResponse>) => void,
          );
        }
      },
      removeEventListener() {},
      postMessage(request: EngineRequest) {
        for (const fn of workerScopeListeners) {
          fn({ data: request } as MessageEvent<EngineRequest>);
        }
      },
      terminate() {},
    } as unknown as Worker;

    serveEngine(workerScope, direct);
    const workerTransport = new WorkerTransport(fakeWorker);

    // 1st query with shapeId = 11: transfers ArrayBuffer AND includes shapeFields
    const q1 = await workerTransport.query(1, 0, 'SELECT ID, ACTIVE FROM T');
    expect(q1.rows).toEqual([{ ID: 1, ACTIVE: true }]);
    expect(recordedReplies).toHaveLength(1);
    const reply1 = recordedReplies[0]!;
    expect(isBinaryResultPayload(reply1.response.result)).toBe(true);
    if (isBinaryResultPayload(reply1.response.result)) {
      expect(reply1.response.result.shapeId).toBe(11);
      expect(reply1.response.result.shapeFields).toEqual(queryFields);
      expect(reply1.transfer).toEqual([
        reply1.response.result.binaryResult.buffer,
      ]);
      // Standalone ArrayBuffer (not aliasing WASM HEAPU8.buffer)
      expect(reply1.response.result.binaryResult.buffer).not.toBe(heap.buffer);
    }

    // 2nd query with shapeId = 11 (in array mode): transfers ArrayBuffer and OMITS shapeFields
    const q2 = await workerTransport.query<unknown[]>(
      1,
      0,
      'SELECT ID, ACTIVE FROM T',
      [],
      'array',
    );
    expect(q2.rows).toEqual([[2, false]]);
    expect(q2.fields).toEqual(queryFields);
    expect(recordedReplies).toHaveLength(2);
    const reply2 = recordedReplies[1]!;
    expect(isBinaryResultPayload(reply2.response.result)).toBe(true);
    if (isBinaryResultPayload(reply2.response.result)) {
      expect(reply2.response.result.shapeId).toBe(11);
      expect(reply2.response.result.shapeFields).toBeUndefined();
      expect(reply2.transfer).toEqual([
        reply2.response.result.binaryResult.buffer,
      ]);
    }

    // cursorFetch: transfers ArrayBuffer and decodes on main thread
    const batch = await workerTransport.cursorFetch(9, 50, 'object');
    expect(batch.rows).toEqual([
      { ID: 10, ACTIVE: true },
      { ID: 20, ACTIVE: false },
    ]);
    expect(recordedReplies).toHaveLength(3);
    const reply3 = recordedReplies[2]!;
    expect(isBinaryResultPayload(reply3.response.result)).toBe(true);
    if (isBinaryResultPayload(reply3.response.result)) {
      expect(reply3.transfer).toEqual([
        reply3.response.result.binaryResult.buffer,
      ]);
    }

    await workerTransport.dispose();
  });

  test('SharedEngineTransport forwards raw FBR\\x01 binary payloads from leader to followers without decoding on leader', async () => {
    const queryFields = sampleFields.slice(0, 2);
    const shape7Buf = encodeBinaryResultSet(
      { fields: queryFields, rows: [{ ID: 42, ACTIVE: true }] },
      { shapeId: 7 },
    );
    const cursorBuf = encodeBinaryResultSet({
      fields: queryFields,
      rows: [{ ID: 99, ACTIVE: false }],
    });

    const leaderQuerySpy = jest.fn();
    const leaderQueryBinarySpy = jest.fn(async () => ({
      binaryResult: shape7Buf,
      shapeId: 7,
      shapeFields: queryFields,
    }));
    const leaderCursorFetchBinarySpy = jest.fn(async () => ({
      binaryResult: cursorBuf,
    }));

    const mockLeaderEngine = {
      init: jest.fn(async () => undefined),
      createDatabase: jest.fn(async () => 1),
      attachDatabase: jest.fn(async () => 1),
      detachDatabase: jest.fn(async () => undefined),
      execute: jest.fn(async () => 0),
      executeBatch: jest.fn(async () => 0),
      query: leaderQuerySpy,
      queryBinary: leaderQueryBinarySpy,
      cursorOpen: jest.fn(async () => 3),
      cursorFetch: jest.fn(),
      cursorFetchBinary: leaderCursorFetchBinarySpy,
      cursorClose: jest.fn(async () => undefined),
      describe: jest.fn(),
      startTransaction: jest.fn(async () => 1),
      commit: jest.fn(async () => undefined),
      rollback: jest.fn(async () => undefined),
      mkdir: jest.fn(async () => undefined),
      exists: jest.fn(async () => true),
      readFile: jest.fn(async () => new Uint8Array(0)),
      writeFile: jest.fn(async () => undefined),
      unlink: jest.fn(async () => undefined),
      eventsSubscribe: jest.fn(async () => 1),
      eventsPoll: jest.fn(async () => ({})),
      eventsCancel: jest.fn(async () => undefined),
      mountOpfs: jest.fn(async () => '/opfs/test.fdb'),
      dispose: jest.fn(async () => undefined),
    };

    let electedFirst = false;
    const electSpy = jest
      .spyOn(leaderElectionModule, 'electLeader')
      .mockImplementation((_dbName, opts) => {
        if (!electedFirst) {
          electedFirst = true;
          const promoted = Promise.resolve().then(async () => {
            await opts?.onPromoted?.();
          });
          return {
            isLeader: true,
            enforced: true,
            promoted,
            resign: async () => undefined,
          };
        }
        return {
          isLeader: false,
          enforced: true,
          promoted: new Promise<void>(() => {}),
          resign: async () => undefined,
        };
      });
    let lockHeld = false;
    const origNavigator = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator?: unknown }).navigator = {
      locks: {
        request: (
          _name: string,
          _opts: unknown,
          cb: () => Promise<unknown>,
        ) => {
          if (!lockHeld) {
            lockHeld = true;
            return Promise.resolve().then(() => cb());
          }
          // Second tab waits in the lock queue (follower)
          return new Promise<void>(() => {});
        },
      },
    };

    const channelMessages: unknown[] = [];
    const origBC = globalThis.BroadcastChannel;
    const peers = new Set<{
      listeners: Array<(ev: MessageEvent) => void>;
    }>();

    class FakeBroadcastChannel {
      readonly listeners: Array<(ev: MessageEvent) => void> = [];
      constructor(readonly name: string) {
        peers.add(this);
      }
      addEventListener(type: string, fn: (ev: MessageEvent) => void) {
        if (type === 'message') this.listeners.push(fn);
      }
      removeEventListener(type: string, fn: (ev: MessageEvent) => void) {
        if (type === 'message') {
          const i = this.listeners.indexOf(fn);
          if (i >= 0) this.listeners.splice(i, 1);
        }
      }
      postMessage(data: unknown) {
        channelMessages.push(data);
        for (const peer of peers) {
          if (peer === this) continue;
          for (const fn of peer.listeners) {
            fn({ data } as MessageEvent);
          }
        }
      }
      close() {
        peers.delete(this);
      }
    }
    globalThis.BroadcastChannel =
      FakeBroadcastChannel as unknown as typeof BroadcastChannel;

    const leader = new SharedEngineTransport({
      dbName: 'shared-bin-test',
      createEngine: () => mockLeaderEngine as never,
    });
    const follower = new SharedEngineTransport({
      dbName: 'shared-bin-test',
      createEngine: () => {
        throw new Error('follower should not create engine');
      },
    });

    try {
      await leader.init();
      await follower.init();
      expect(leader.isLeader).toBe(true);
      expect(follower.isLeader).toBe(false);

      // 1st follower query: leader calls queryBinary (NOT query), sends shapeFields
      const res1 = await follower.query(1, 0, 'SELECT ID, ACTIVE FROM T');
      expect(res1.rows).toEqual([{ ID: 42, ACTIVE: true }]);
      expect(leaderQuerySpy).not.toHaveBeenCalled();
      expect(leaderQueryBinarySpy).toHaveBeenCalledTimes(1);

      // 2nd follower query in 'array' mode: leader omits shapeFields on 2nd send for shape 7
      const res2 = await follower.query<unknown[]>(
        1,
        0,
        'SELECT ID, ACTIVE FROM T',
        [],
        'array',
      );
      expect(res2.rows).toEqual([[42, true]]);
      expect(res2.fields).toEqual(queryFields);

      const replyMessages = channelMessages.filter(
        (m): m is { kind: string; result?: unknown } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { kind?: string }).kind === 'reply',
      );
      expect(replyMessages).toHaveLength(2);
      expect(isBinaryResultPayload(replyMessages[0]?.result)).toBe(true);
      expect(isBinaryResultPayload(replyMessages[1]?.result)).toBe(true);
      if (
        isBinaryResultPayload(replyMessages[0]?.result) &&
        isBinaryResultPayload(replyMessages[1]?.result)
      ) {
        expect(replyMessages[0].result.shapeFields).toEqual(queryFields);
        expect(replyMessages[1].result.shapeFields).toBeUndefined();
      }

      // Follower cursorFetch also uses cursorFetchBinary
      const cRes = await follower.cursorFetch(3, 10, 'object');
      expect(cRes.rows).toEqual([{ ID: 99, ACTIVE: false }]);
      expect(leaderCursorFetchBinarySpy).toHaveBeenCalledTimes(1);
    } finally {
      await follower.dispose();
      await leader.dispose();
      electSpy.mockRestore();
      globalThis.BroadcastChannel = origBC;
      if (origNavigator === undefined) {
        delete (globalThis as { navigator?: unknown }).navigator;
      } else {
        (globalThis as { navigator?: unknown }).navigator = origNavigator;
      }
    }
  });
});
