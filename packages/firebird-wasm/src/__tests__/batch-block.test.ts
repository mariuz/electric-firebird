import { blockParamType, buildBlock, placeholderOffsets } from '../batch-block';
import type { CharacterSet } from '../batch-block';
import { FirebirdTransaction } from '../firebird';
import type { Attachment, Transaction } from 'node-firebird-driver';

describe('placeholderOffsets', () => {
  it('finds each ? in plain SQL', () => {
    const sql = 'INSERT INTO t VALUES (?, ?, ?)';
    expect(placeholderOffsets(sql)).toEqual([22, 25, 28]);
  });

  it('skips strings, quoted identifiers and comments', () => {
    const sql = `INSERT INTO "odd?name" VALUES (?, 'what?', 'it''s ?') -- a ? here
      /* and ? here */ RETURNING ?`;
    const offsets = placeholderOffsets(sql)!;
    expect(offsets.map((i) => sql[i])).toEqual(['?', '?']);
    expect(offsets).toHaveLength(2);
  });

  it('skips Q-strings, with bracket and plain delimiters', () => {
    const sql = "UPDATE t SET a = q'{is it?}', b = Q'!what?!', c = ?";
    expect(placeholderOffsets(sql)).toEqual([sql.lastIndexOf('?')]);
  });

  it('does not read a word ending in q as a Q-string', () => {
    const sql = "SELECT seq'x' FROM t WHERE a = ?";
    // seq followed by a string literal: the literal is skipped, the ? found.
    expect(placeholderOffsets(sql)).toEqual([sql.length - 1]);
  });

  it('refuses text that ends inside a string or comment', () => {
    expect(placeholderOffsets("INSERT INTO t VALUES ('?")).toBeUndefined();
    expect(placeholderOffsets('INSERT INTO t VALUES (?) /* ?')).toBeUndefined();
    expect(placeholderOffsets("SELECT q'{?' FROM t")).toBeUndefined();
  });
});

describe('blockParamType', () => {
  const charsets = new Map<number, CharacterSet>([
    [0, { name: 'NONE', bytesPerCharacter: 1 }],
    [2, { name: 'ASCII', bytesPerCharacter: 1 }],
    [4, { name: 'UTF8', bytesPerCharacter: 4 }],
  ]);
  const p = (type: number, extra: Partial<{ subType: number; length: number; scale: number; charSet: number }> = {}) =>
    blockParamType({ type, subType: 0, length: 8, scale: 0, charSet: 0, ...extra }, charsets);

  it('declares character types in characters, with their character set', () => {
    expect(p(448, { length: 80, charSet: 4 })).toBe('VARCHAR(20) CHARACTER SET UTF8');
    expect(p(449, { length: 80, charSet: 4 })).toBe('VARCHAR(20) CHARACTER SET UTF8'); // nullable bit
    expect(p(452, { length: 10, charSet: 0 })).toBe('CHAR(10) CHARACTER SET NONE');
    expect(p(448, { length: 10, charSet: 4 | (1 << 8) })).toBe('VARCHAR(2) CHARACTER SET UTF8'); // collation ignored
    expect(p(448, { length: 10, charSet: 99 })).toBeUndefined();
  });

  it('declares numbers, scaled ones as NUMERIC', () => {
    expect(p(480)).toBe('DOUBLE PRECISION');
    expect(p(482)).toBe('FLOAT');
    expect(p(496)).toBe('INTEGER');
    expect(p(580)).toBe('BIGINT');
    expect(p(580, { scale: -2 })).toBe('NUMERIC(18, 2)');
    expect(p(500, { scale: -1 })).toBe('NUMERIC(4, 1)');
    expect(p(32752)).toBe('INT128');
    expect(p(32762)).toBe('DECFLOAT(34)');
  });

  it('declares dates, times, booleans and blobs', () => {
    expect(p(510)).toBe('TIMESTAMP');
    expect(p(570)).toBe('DATE');
    expect(p(560)).toBe('TIME');
    expect(p(32748)).toBe('TIMESTAMP WITH TIME ZONE');
    expect(p(32750)).toBe('TIME WITH TIME ZONE');
    expect(p(32764)).toBe('BOOLEAN');
    expect(p(520, { subType: 0 })).toBe('BLOB SUB_TYPE 0');
    expect(p(520, { subType: 1, charSet: 4 })).toBe('BLOB SUB_TYPE TEXT CHARACTER SET UTF8');
  });

  it('has nothing to declare for an untyped parameter', () => {
    expect(p(32766)).toBeUndefined(); // SQL_NULL
    expect(p(540)).toBeUndefined(); // an array
  });
});

describe('buildBlock', () => {
  it('repeats the statement per row, each ? a declared parameter', () => {
    const sql = 'INSERT INTO t VALUES (?, ?);';
    const block = buildBlock(sql, placeholderOffsets(sql)!, ['INTEGER', 'VARCHAR(5) CHARACTER SET UTF8'], 2);
    expect(block).toBe(
      'EXECUTE BLOCK (p0_0 INTEGER = ?, p0_1 VARCHAR(5) CHARACTER SET UTF8 = ?, ' +
        'p1_0 INTEGER = ?, p1_1 VARCHAR(5) CHARACTER SET UTF8 = ?) AS BEGIN\n' +
        'INSERT INTO t VALUES (:p0_0, :p0_1);\n' +
        'INSERT INTO t VALUES (:p1_0, :p1_1);\n' +
        'END',
    );
  });

  it('keeps the text around and after the placeholders', () => {
    const sql = "UPDATE t SET a = ?, note = 'why?' WHERE id = ? AND b > 0";
    const block = buildBlock(sql, placeholderOffsets(sql)!, ['INTEGER', 'INTEGER'], 1);
    expect(block).toContain("UPDATE t SET a = :p0_0, note = 'why?' WHERE id = :p0_1 AND b > 0;");
  });

  it('uses statementHandle.createBatchAsync and addBlobAsync when available (PR #178), and falls back to EXECUTE BLOCK when unsupported', async () => {
    const addedMessages: { count: number; bytes: Uint8Array }[] = [];
    const addedBlobs: Uint8Array[] = [];
    let batchClosed = false;

    const inMeta = {
      getCountSync: () => 2,
      getTypeSync: (_s: unknown, i: number) => (i === 0 ? 480 : 520), // SQL_DOUBLE (for INTEGER), SQL_BLOB
      getSubTypeSync: () => 0,
      getLengthSync: () => 8,
      getScaleSync: () => 0,
      getCharSetSync: () => 0,
      getOffsetSync: (_s: unknown, i: number) => i * 10,
      getNullOffsetSync: (_s: unknown, i: number) => i * 10 + 8,
      getMessageLengthSync: () => 20,
      getAlignedLengthSync: () => 24,
      getBuilderSync: () => ({
        setTypeSync: () => undefined,
        setSubTypeSync: () => undefined,
        setLengthSync: () => undefined,
        setCharSetSync: () => undefined,
        setScaleSync: () => undefined,
        getMetadataSync: () => inMeta,
        releaseSync: () => 0,
      }),
      releaseSync: () => 0,
    };

    const preparedInMeta = {
      ...inMeta,
      getTypeSync: (_s: unknown, i: number) => (i === 0 ? 496 : 520), // SQL_LONG, SQL_BLOB
    };

    const makeStmt = (createBatchImpl: () => Promise<unknown>) => ({
      type: Promise.resolve(2), // INSERT
      hasResultSet: false,
      columnLabels: Promise.resolve([]),
      inMetadata: inMeta,
      outMetadata: undefined,
      inBuffer: new Uint8Array(20),
      dataWriter: async (_att: unknown, _tx: unknown, buf: Uint8Array, values: unknown[]) => {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (values[0] === null || values[0] === undefined) {
          dv.setInt16(8, -1, true);
        } else {
          dv.setFloat64(0, Number(values[0]), true);
          dv.setInt16(8, 0, true);
        }
        if (values[1] === null || values[1] === undefined) {
          dv.setInt16(18, -1, true);
        }
      },
      attachment: {
        client: {
          statusAction: async <T>(fn: (s: unknown) => Promise<T>) => fn({}),
        },
      },
      statementHandle: {
        getInputMetadataAsync: async () => preparedInMeta,
        getOutputMetadataAsync: async () => undefined,
        createBatchAsync: createBatchImpl,
      },
      execute: jest.fn(async () => undefined),
      dispose: jest.fn(async () => undefined),
    });

    const batchHandle = {
      addAsync: async (_s: unknown, count: number, inBuffer: Uint8Array) => {
        addedMessages.push({ count, bytes: new Uint8Array(inBuffer) });
      },
      addBlobAsync: async (
        _s: unknown,
        _len: number,
        inBuffer: Uint8Array,
        blobId: Uint8Array,
      ) => {
        addedBlobs.push(new Uint8Array(inBuffer));
        blobId.set([1, 2, 3, 4, 5, 6, 7, addedBlobs.length]);
      },
      executeAsync: async () => ({
        getSizeSync: () => 2,
        getStateSync: () => 1,
        getStatusSync: () => undefined,
        disposeSync: () => undefined,
      }),
      closeAsync: async () => {
        batchClosed = true;
      },
    };

    const stmt1 = makeStmt(async () => batchHandle);
    const attachment1 = {
      prepare: jest.fn(async () => stmt1),
    } as unknown as Attachment;
    const tx1 = { transactionHandle: {} } as unknown as Transaction;

    const fbTx1 = new FirebirdTransaction(attachment1, tx1);
    await fbTx1.execBatch('INSERT INTO b VALUES (?, ?)', [
      [10, new Uint8Array([0xaa, 0xbb])],
      [20, 'hello blob'],
    ]);

    expect(addedMessages).toHaveLength(1);
    expect(addedMessages[0]!.count).toBe(2);
    expect(addedMessages[0]!.bytes.byteLength).toBe(48); // 2 rows * 24-byte aligned stride
    expect(addedBlobs).toHaveLength(2);
    expect(Array.from(addedBlobs[0]!)).toEqual([0xaa, 0xbb]);
    expect(Buffer.from(addedBlobs[1]!).toString('utf8')).toBe('hello blob');
    // Row 0's blobId written at offset 10..18, nullFlag=0 at 18..20
    expect(Array.from(addedMessages[0]!.bytes.subarray(10, 18))).toEqual([1, 2, 3, 4, 5, 6, 7, 1]);
    expect(Array.from(addedMessages[0]!.bytes.subarray(18, 20))).toEqual([0, 0]);
    expect(batchClosed).toBe(true);
    expect(stmt1.execute).not.toHaveBeenCalled();

    // When createBatchAsync throws (e.g. against Firebird 3), falls back cleanly
    const stmt2 = makeStmt(async () => {
      throw new Error('feature is not supported');
    });
    const attachment2 = {
      prepare: jest.fn(async () => stmt2),
      executeQuery: jest.fn(async () => ({
        fetch: async () => [[0, 'NONE', 1]],
        close: async () => undefined,
      })),
    } as unknown as Attachment;
    const fbTx2 = new FirebirdTransaction(attachment2, tx1);
    await fbTx2.execBatch('INSERT INTO b VALUES (?, ?)', [
      [1, new Uint8Array([1])],
      [2, new Uint8Array([2])],
    ]);
    // Executed via EXECUTE BLOCK fallback
    expect(attachment2.prepare).toHaveBeenCalledTimes(2);
  });
});
