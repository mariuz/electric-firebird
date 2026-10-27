import { FirebirdBrowser } from '../browser/firebird-browser';
import { DirectTransport } from '../browser/engine-transport';
import type { EngineHandle, EngineTransport } from '../browser/engine-transport';
import { sql } from '../sql-tag';
import type {
  FieldInfo,
  QueryDescription,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
  TransactionOptions,
} from '../types';
import type { FirebirdWasmModule } from '../wasm-loader';

interface MockCursor {
  dbHandle: EngineHandle;
  txHandle: EngineHandle;
  sql: string;
  params: QueryParams;
  offset: number;
  closed: boolean;
}

class MockCursorTransport implements EngineTransport {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  readonly cursors = new Map<EngineHandle, MockCursor>();
  rows: unknown[][] = [];
  params: FieldInfo[] = [];
  fields: FieldInfo[] = [
    { name: 'ID', type: 496, typeName: 'INTEGER', scale: 0 },
    { name: 'NAME', type: 448, typeName: 'VARYING', scale: 0 },
  ];
  failOnOpen = false;
  failOnFetchAtCall = 0;
  private fetchCalls = 0;
  private nextCursor = 100;
  private nextTx = 500;

  async init(): Promise<void> {
    this.calls.push({ op: 'init', args: [] });
  }
  async createDatabase(path: string): Promise<EngineHandle> {
    this.calls.push({ op: 'createDatabase', args: [path] });
    return 1;
  }
  async attachDatabase(path: string): Promise<EngineHandle> {
    this.calls.push({ op: 'attachDatabase', args: [path] });
    return 1;
  }
  async detachDatabase(dbHandle: EngineHandle): Promise<void> {
    this.calls.push({ op: 'detachDatabase', args: [dbHandle] });
  }
  async execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    statement: string,
    params: QueryParams = [],
  ): Promise<number> {
    this.calls.push({ op: 'execute', args: [dbHandle, txHandle, statement, params] });
    return 0;
  }
  async executeBatch(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    statement: string,
    rows: QueryParams[],
  ): Promise<number> {
    this.calls.push({ op: 'executeBatch', args: [dbHandle, txHandle, statement, rows] });
    return rows.length;
  }
  async query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    statement: string,
    params: QueryParams = [],
    rowMode: RowMode = 'object',
  ): Promise<QueryResult<T>> {
    this.calls.push({ op: 'query', args: [dbHandle, txHandle, statement, params, rowMode] });
    return this.buildBatch<T>(this.rows, rowMode);
  }
  async cursorOpen(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    statement: string,
    params: QueryParams = [],
  ): Promise<EngineHandle> {
    this.calls.push({ op: 'cursorOpen', args: [dbHandle, txHandle, statement, params] });
    if (this.failOnOpen) {
      throw new Error('simulated cursorOpen failure');
    }
    const handle = this.nextCursor++;
    this.cursors.set(handle, {
      dbHandle,
      txHandle,
      sql: statement,
      params,
      offset: 0,
      closed: false,
    });
    return handle;
  }
  async cursorFetch<T = Row>(
    cursorHandle: EngineHandle,
    batchSize: number,
    rowMode: RowMode = 'object',
  ): Promise<QueryResult<T>> {
    this.fetchCalls += 1;
    this.calls.push({ op: 'cursorFetch', args: [cursorHandle, batchSize, rowMode] });
    if (this.failOnFetchAtCall > 0 && this.fetchCalls === this.failOnFetchAtCall) {
      throw new Error('simulated cursorFetch failure');
    }
    const cursor = this.cursors.get(cursorHandle);
    if (!cursor || cursor.closed) {
      throw new Error('invalid or closed cursor');
    }
    const slice = this.rows.slice(cursor.offset, cursor.offset + batchSize);
    cursor.offset += slice.length;
    return this.buildBatch<T>(slice, rowMode);
  }
  async cursorClose(cursorHandle: EngineHandle): Promise<void> {
    this.calls.push({ op: 'cursorClose', args: [cursorHandle] });
    const cursor = this.cursors.get(cursorHandle);
    if (cursor) {
      cursor.closed = true;
    }
  }
  async describe(): Promise<QueryDescription> {
    return { params: this.params, fields: this.fields, statementType: 'SELECT', hasResultSet: true };
  }
  async startTransaction(
    dbHandle: EngineHandle,
    options?: TransactionOptions,
  ): Promise<EngineHandle> {
    const tx = this.nextTx++;
    this.calls.push({ op: 'startTransaction', args: [dbHandle, options, tx] });
    return tx;
  }
  async commit(txHandle: EngineHandle): Promise<void> {
    this.calls.push({ op: 'commit', args: [txHandle] });
  }
  async rollback(txHandle: EngineHandle): Promise<void> {
    this.calls.push({ op: 'rollback', args: [txHandle] });
  }
  async mkdir(): Promise<void> {}
  async exists(): Promise<boolean> {
    return false;
  }
  async readFile(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }
  async writeFile(): Promise<void> {}
  async unlink(): Promise<void> {}
  async eventsSubscribe(): Promise<number> {
    return 1;
  }
  async eventsPoll(): Promise<Record<string, number>> {
    return {};
  }
  async eventsCancel(): Promise<void> {}
  async mountOpfs(): Promise<string> {
    return '/opfs/test.fdb';
  }
  async dispose(): Promise<void> {}

  private buildBatch<T>(slice: unknown[][], rowMode: RowMode): QueryResult<T> {
    const fields = this.fields.map((f) => ({ ...f }));
    if (rowMode === 'array') {
      return { rows: slice.map((r) => [...r]) as T[], fields };
    }
    const rows = slice.map((cols) =>
      Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])),
    ) as T[];
    return { rows, fields };
  }
}

describe('queryStream()', () => {
  it('streams rows in batches of batchSize and closes the cursor at EOF', async () => {
    const transport = new MockCursorTransport();
    transport.rows = [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
      [4, 'd'],
      [5, 'e'],
      [6, 'f'],
      [7, 'g'],
    ];
    const db = new FirebirdBrowser('memory://stream-batches', {
      transport,
      multiTab: 'allow-unsafe',
    });

    const batches: Array<Array<{ ID: number; NAME: string }>> = [];
    for await (const batch of db.queryStream<{ ID: number; NAME: string }>(
      'SELECT id, name FROM items ORDER BY id',
      [],
      { batchSize: 3 },
    )) {
      expect(batch.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
      batches.push(batch.rows);
    }

    expect(batches).toEqual([
      [
        { ID: 1, NAME: 'a' },
        { ID: 2, NAME: 'b' },
        { ID: 3, NAME: 'c' },
      ],
      [
        { ID: 4, NAME: 'd' },
        { ID: 5, NAME: 'e' },
        { ID: 6, NAME: 'f' },
      ],
      [{ ID: 7, NAME: 'g' }],
    ]);

    const cursorOps = transport.calls
      .filter((c) => c.op.startsWith('cursor'))
      .map((c) => c.op);
    expect(cursorOps).toEqual([
      'cursorOpen',
      'cursorFetch',
      'cursorFetch',
      'cursorFetch',
      'cursorFetch', // returns [] -> EOF
      'cursorClose',
    ]);

    await db.close();
  });

  it('closes the cursor immediately when the caller breaks out of the loop early', async () => {
    const transport = new MockCursorTransport();
    transport.rows = Array.from({ length: 20 }, (_, i) => [i + 1, `item-${i + 1}`]);
    const db = new FirebirdBrowser('memory://stream-break', {
      transport,
      multiTab: 'allow-unsafe',
    });

    const seen: number[] = [];
    for await (const batch of db.queryStream<{ ID: number; NAME: string }>(
      'SELECT id, name FROM items',
      [],
      { batchSize: 4 },
    )) {
      for (const row of batch.rows) {
        seen.push(row.ID);
      }
      break;
    }

    expect(seen).toEqual([1, 2, 3, 4]);
    const cursorOps = transport.calls
      .filter((c) => c.op.startsWith('cursor'))
      .map((c) => c.op);
    expect(cursorOps).toEqual(['cursorOpen', 'cursorFetch', 'cursorClose']);
    expect([...transport.cursors.values()][0]?.closed).toBe(true);

    await db.close();
  });

  it('yields zero batches for an empty result set and still closes the cursor', async () => {
    const transport = new MockCursorTransport();
    transport.rows = [];
    const db = new FirebirdBrowser('memory://stream-empty', {
      transport,
      multiTab: 'allow-unsafe',
    });

    const batches: unknown[] = [];
    for await (const batch of db.queryStream('SELECT id, name FROM items WHERE 1 = 0')) {
      batches.push(batch);
    }

    expect(batches).toEqual([]);
    const cursorOps = transport.calls
      .filter((c) => c.op.startsWith('cursor'))
      .map((c) => c.op);
    expect(cursorOps).toEqual(['cursorOpen', 'cursorFetch', 'cursorClose']);

    await db.close();
  });

  it('supports rowMode: "array" and sql`...` template fragments', async () => {
    const transport = new MockCursorTransport();
    transport.rows = [
      [10, 'ten'],
      [20, 'twenty'],
      [30, 'thirty'],
    ];
    const db = new FirebirdBrowser('memory://stream-array-sql', {
      transport,
      multiTab: 'allow-unsafe',
    });

    const minId = 5;
    const batches: unknown[][][] = [];
    for await (const batch of db.queryStream(
      sql`SELECT id, name FROM items WHERE id >= ${minId}`,
      { rowMode: 'array', batchSize: 2 },
    )) {
      batches.push(batch.rows);
    }

    expect(batches).toEqual([
      [
        [10, 'ten'],
        [20, 'twenty'],
      ],
      [[30, 'thirty']],
    ]);

    const openCall = transport.calls.find((c) => c.op === 'cursorOpen');
    expect(openCall?.args[2]).toBe('SELECT id, name FROM items WHERE id >= ?');
    expect(openCall?.args[3]).toEqual([5]);

    await db.close();
  });

  it('applies configured value types and parameter serializers to each batch', async () => {
    const transport = new MockCursorTransport();
    transport.fields = [
      { name: 'BIG', type: 580, typeName: 'BIGINT', scale: 0 },
    ];
    transport.rows = [['9007199254740993'], ['9007199254740994']];

    const db = new FirebirdBrowser('memory://stream-types', {
      transport,
      multiTab: 'allow-unsafe',
      types: {
        bigint: true,
        serializers: [
          (v: unknown) =>
            typeof v === 'object' && v !== null && 'tag' in v
              ? `tag:${String((v as { tag: unknown }).tag)}`
              : undefined,
        ],
      },
    });

    const values: bigint[] = [];
    for await (const batch of db.queryStream<{ BIG: bigint }>(
      'SELECT big FROM t WHERE tag = ?',
      [{ tag: 42 }],
      { batchSize: 1 },
    )) {
      values.push(batch.rows[0]!.BIG);
    }

    expect(values).toEqual([9007199254740993n, 9007199254740994n]);
    const openCall = transport.calls.find((c) => c.op === 'cursorOpen');
    expect(openCall?.args[3]).toEqual(['tag:42']);

    await db.close();
  });

  it('starts and commits an explicit transaction when transaction options are supplied, and rolls back on fetch failure', async () => {
    const transport = new MockCursorTransport();
    transport.rows = [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ];
    const db = new FirebirdBrowser('memory://stream-tx-opts', {
      transport,
      multiTab: 'allow-unsafe',
    });

    // 1. Early break with transaction options commits the read transaction
    for await (const batch of db.queryStream(
      'SELECT id, name FROM items',
      [],
      { isolationLevel: 'SNAPSHOT', readOnly: true, batchSize: 2 },
    )) {
      expect(batch.rows).toHaveLength(2);
      break;
    }

    expect(transport.calls.map((c) => c.op)).toContain('startTransaction');
    expect(transport.calls.map((c) => c.op)).toContain('commit');

    // 2. Fetch failure rolls back the transaction
    transport.calls.length = 0;
    transport.failOnFetchAtCall = 3; // fail on second batch fetch of this stream (after call 1 from part 1)

    await expect(async () => {
      for await (const _batch of db.queryStream(
        'SELECT id, name FROM items',
        [],
        { isolationLevel: 'READ_COMMITTED', batchSize: 1 },
      )) {
        // first batch succeeds, second fetch throws
      }
    }).rejects.toThrow('simulated cursorFetch failure');

    const ops = transport.calls.map((c) => c.op);
    expect(ops).toEqual([
      'startTransaction',
      'cursorOpen',
      'cursorFetch',
      'cursorFetch',
      'cursorClose',
      'rollback',
    ]);

    await db.close();
  });

  it('streams inside db.transaction(tx => tx.queryStream(...))', async () => {
    const transport = new MockCursorTransport();
    transport.rows = [
      [1, 'x'],
      [2, 'y'],
      [3, 'z'],
    ];
    const db = new FirebirdBrowser('memory://stream-in-tx', {
      transport,
      multiTab: 'allow-unsafe',
    });

    const collected: unknown[][] = [];
    await db.transaction(async (tx) => {
      for await (const batch of tx.queryStream(
        sql`SELECT id, name FROM items WHERE id >= ${1}`,
        { rowMode: 'array', batchSize: 2 },
      )) {
        collected.push(...batch.rows);
      }
    });

    expect(collected).toEqual([
      [1, 'x'],
      [2, 'y'],
      [3, 'z'],
    ]);

    const openCall = transport.calls.find((c) => c.op === 'cursorOpen');
    const startTxCall = transport.calls.find((c) => c.op === 'startTransaction');
    expect(openCall?.args[1]).toBe(startTxCall?.args[2]);

    await db.close();
  });

  it('rejects invalid batchSize values with RangeError', () => {
    const transport = new MockCursorTransport();
    const db = new FirebirdBrowser('memory://stream-invalid-batch', {
      transport,
      multiTab: 'allow-unsafe',
    });

    expect(() => db.queryStream('SELECT 1', [], { batchSize: 0 })).toThrow(RangeError);
    expect(() => db.queryStream('SELECT 1', [], { batchSize: -5 })).toThrow(RangeError);
    expect(() => db.queryStream('SELECT 1', [], { batchSize: 2.5 })).toThrow(RangeError);
    expect(() => db.queryStream('SELECT 1', [], { batchSize: Number.NaN })).toThrow(RangeError);
  });

  it('falls back to slicing query() results when a custom transport omits cursor methods', async () => {
    const base = new MockCursorTransport();
    base.rows = [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ];
    const customTransport: EngineTransport = {
      init: () => base.init(),
      createDatabase: (p) => base.createDatabase(p),
      attachDatabase: (p) => base.attachDatabase(p),
      detachDatabase: (h) => base.detachDatabase(h),
      execute: (d, t, s, p) => base.execute(d, t, s, p),
      executeBatch: (d, t, s, r) => base.executeBatch(d, t, s, r),
      query: (d, t, s, p, m) => base.query(d, t, s, p, m),
      describe: () => base.describe(),
      startTransaction: (d, o) => base.startTransaction(d, o),
      commit: (t) => base.commit(t),
      rollback: (t) => base.rollback(t),
      mkdir: () => base.mkdir(),
      exists: () => base.exists(),
      readFile: () => base.readFile(),
      writeFile: () => base.writeFile(),
      unlink: () => base.unlink(),
      eventsSubscribe: () => base.eventsSubscribe(),
      eventsPoll: () => base.eventsPoll(),
      eventsCancel: () => base.eventsCancel(),
      mountOpfs: () => base.mountOpfs(),
      dispose: () => base.dispose(),
    };

    const db = new FirebirdBrowser('memory://stream-fallback', {
      transport: customTransport,
      multiTab: 'allow-unsafe',
    });

    const batches: number[] = [];
    for await (const batch of db.queryStream('SELECT id, name FROM items', [], {
      batchSize: 2,
    })) {
      batches.push(batch.rows.length);
    }

    expect(batches).toEqual([2, 1]);
    await db.close();
  });

  it('DirectTransport uses _fb_cursor_open / _fb_cursor_fetch / _fb_cursor_close on the WASM module', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const heap = new Uint8Array(65536);
    let brk = 16;

    const alloc = (s: string): number => {
      const bytes = encoder.encode(s);
      const ptr = brk;
      brk += bytes.length + 1;
      heap.set(bytes, ptr);
      heap[ptr + bytes.length] = 0;
      return ptr;
    };

    const allRows = [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ];
    let cursorOffset = 0;
    const closedCursors: number[] = [];

    const fakeMod: Partial<FirebirdWasmModule> = {
      HEAPU8: heap,
      _malloc: (size: number) => {
        const ptr = brk;
        brk += size;
        return ptr;
      },
      _free: () => undefined,
      lengthBytesUTF8: (s: string) => encoder.encode(s).length,
      stringToUTF8: (s: string, outPtr: number) => {
        const bytes = encoder.encode(s);
        heap.set(bytes, outPtr);
        heap[outPtr + bytes.length] = 0;
      },
      UTF8ToString: (ptr: number) => {
        let end = ptr;
        while (heap[end] !== 0) end++;
        return decoder.decode(heap.subarray(ptr, end));
      },
      _fb_free_result: () => undefined,
      _fb_last_blobs: () => 0,
      _fb_last_blobs_size: () => 0,
      _fb_cursor_open: () => {
        cursorOffset = 0;
        return 77;
      },
      _fb_cursor_fetch: (_handle: number, maxRows: number) => {
        const slice = allRows.slice(cursorOffset, cursorOffset + maxRows);
        cursorOffset += slice.length;
        return alloc(
          JSON.stringify({
            columns: [
              { name: 'ID', type: 496, subType: 0, scale: 0, length: 4, nullable: false },
              { name: 'LABEL', type: 448, subType: 0, scale: 0, length: 16, nullable: false },
            ],
            rows: slice,
          }),
        );
      },
      _fb_cursor_close: (handle: number) => {
        closedCursors.push(handle);
        return 0;
      },
    };

    const transport = new DirectTransport();
    (transport as unknown as { mod: FirebirdWasmModule }).mod =
      fakeMod as FirebirdWasmModule;

    const handle = await transport.cursorOpen(1, 0, 'SELECT id, label FROM t');
    expect(handle).toBe(77);

    const b1 = await transport.cursorFetch(handle, 2, 'object');
    expect(b1.rows).toEqual([
      { ID: 1, LABEL: 'one' },
      { ID: 2, LABEL: 'two' },
    ]);

    const b2 = await transport.cursorFetch(handle, 2, 'object');
    expect(b2.rows).toEqual([{ ID: 3, LABEL: 'three' }]);

    const b3 = await transport.cursorFetch(handle, 2, 'object');
    expect(b3.rows).toEqual([]);

    await transport.cursorClose(handle);
    expect(closedCursors).toEqual([77]);
  });

  it('streams batches from PreparedStatement handles via stmt.queryStream() and tx.prepare().queryStream()', async () => {
    const transport = new MockCursorTransport();
    transport.params = [{ name: 'PARAM_0', type: 496, typeName: 'INTEGER', scale: 0, nullable: false }];
    transport.rows = [
      [2, 'two'],
      [3, 'three'],
      [4, 'four'],
    ];
    const db = new FirebirdBrowser('memory://stream-prep', {
      transport,
      multiTab: 'allow-unsafe',
    });
    try {
      const stmt = await db.prepare('SELECT id, name FROM items WHERE id >= ? ORDER BY id');
      expect(typeof stmt.queryStream).toBe('function');

      const objBatches: Array<Array<{ ID: number; NAME: string }>> = [];
      for await (const batch of stmt.queryStream<{ ID: number; NAME: string }>([2], {
        batchSize: 2,
      })) {
        objBatches.push(batch.rows);
      }
      expect(objBatches).toEqual([
        [
          { ID: 2, NAME: 'two' },
          { ID: 3, NAME: 'three' },
        ],
        [{ ID: 4, NAME: 'four' }],
      ]);

      const arrBatches: unknown[][][] = [];
      for await (const batch of stmt.queryStream([3], { rowMode: 'array', batchSize: 2 })) {
        arrBatches.push(batch.rows);
      }
      expect(arrBatches).toEqual([
        [
          [2, 'two'],
          [3, 'three'],
        ],
        [[4, 'four']],
      ]);

      // Parameter count and batchSize validation rejects before iteration starts
      expect(() => stmt.queryStream([])).toThrow(/expects 1 parameter/i);
      expect(() => stmt.queryStream([1], { batchSize: 0 })).toThrow(/batchSize/i);

      await stmt.close();
      expect(() => stmt.queryStream([1])).toThrow(/closed/i);

      // Transaction-scoped PreparedStatement.queryStream
      await db.transaction(async (tx) => {
        const txStmt = await tx.prepare('SELECT id, name FROM items WHERE id <= ? ORDER BY id');
        const txRows: Array<{ ID: number; NAME: string }> = [];
        for await (const batch of txStmt.queryStream<{ ID: number; NAME: string }>([2], {
          batchSize: 2,
        })) {
          txRows.push(...batch.rows);
        }
        expect(txRows).toEqual([
          { ID: 2, NAME: 'two' },
          { ID: 3, NAME: 'three' },
          { ID: 4, NAME: 'four' },
        ]);
        await txStmt.close();
      });
    } finally {
      await db.close();
    }
  });
});
