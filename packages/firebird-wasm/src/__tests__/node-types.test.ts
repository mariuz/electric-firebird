import * as os from 'os';
import { Blob as FbBlob } from 'node-firebird-driver';
import {
  FirebirdLite,
  sql,
  firebirdTypeName,
  applyTypes,
  applySerializers,
  hasTypeOptions,
} from '../index';
import type { FieldInfo, TypeOptions } from '../index';

const littleEndian = os.endianness() === 'LE';

// Firebird SQL type codes
const SQL_TEXT = 452;
const SQL_VARYING = 448;
const SQL_SHORT = 500;
const SQL_LONG = 496;
const SQL_FLOAT = 482;
const SQL_DOUBLE = 480;
const SQL_TIMESTAMP = 510;
const SQL_BLOB = 520;
const SQL_TYPE_TIME = 560;
const SQL_TYPE_DATE = 570;
const SQL_INT64 = 580;
const SQL_TIMESTAMP_TZ = 32754;
const SQL_INT128 = 32752;
const SQL_BOOLEAN = 32764;

interface ColumnSpec {
  name: string;
  type: number;
  subType?: number;
  scale?: number;
  length: number;
  charSet?: number;
  nullable?: boolean;
}

/**
 * Build a simulated `NativeMetadata` object and layout its message buffer
 * offsets/nullOffsets so `FirebirdLite`'s `setupOutput` and `dataReader` can
 * be exercised end-to-end without a running Firebird server.
 */
function buildMockNativeMetadata(specs: ColumnSpec[]) {
  const cols = specs.map((s) => ({
    name: s.name,
    type: s.type,
    subType: s.subType ?? 0,
    scale: s.scale ?? 0,
    length: s.length,
    charSet: s.charSet ?? 4, // default UTF8
    nullable: s.nullable ?? true,
  }));

  function layoutOf(items: typeof cols) {
    let offset = 0;
    const offsets: number[] = [];
    const nullOffsets: number[] = [];
    for (const c of items) {
      const wireLen = (c.type & ~1) === SQL_VARYING ? c.length + 2 : c.length;
      offsets.push(offset);
      offset += wireLen;
      nullOffsets.push(offset);
      offset += 2;
    }
    return { offsets, nullOffsets, totalLength: offset };
  }

  function makeMetadata(items: typeof cols) {
    const { offsets, nullOffsets, totalLength } = layoutOf(items);
    let released = false;
    const meta = {
      get released() {
        return released;
      },
      getCountSync: () => items.length,
      getTypeSync: (_s: unknown, i: number) => items[i]!.type,
      getSubTypeSync: (_s: unknown, i: number) => items[i]!.subType,
      getScaleSync: (_s: unknown, i: number) => items[i]!.scale,
      getLengthSync: (_s: unknown, i: number) => items[i]!.length,
      getCharSetSync: (_s: unknown, i: number) => items[i]!.charSet,
      getAliasSync: (_s: unknown, i: number) => items[i]!.name,
      isNullableSync: (_s: unknown, i: number) => items[i]!.nullable,
      getOffsetSync: (_s: unknown, i: number) => offsets[i]!,
      getNullOffsetSync: (_s: unknown, i: number) => nullOffsets[i]!,
      getMessageLengthSync: () => totalLength,
      releaseSync: () => {
        released = true;
        return 0;
      },
      getBuilderSync: () => {
        const copy = items.map((c) => ({ ...c }));
        let builderReleased = false;
        return {
          get released() {
            return builderReleased;
          },
          setTypeSync: (_s: unknown, i: number, t: number) => {
            copy[i]!.type = t;
          },
          setSubTypeSync: (_s: unknown, i: number, st: number) => {
            copy[i]!.subType = st;
          },
          setLengthSync: (_s: unknown, i: number, l: number) => {
            copy[i]!.length = l;
          },
          setCharSetSync: (_s: unknown, i: number, cs: number) => {
            copy[i]!.charSet = cs;
          },
          setScaleSync: (_s: unknown, i: number, sc: number) => {
            copy[i]!.scale = sc;
          },
          getMetadataSync: () => makeMetadata(copy),
          releaseSync: () => {
            builderReleased = true;
            return 0;
          },
        };
      },
    };
    return meta;
  }

  return makeMetadata(cols);
}

/**
 * Create a `FirebirdLite` instance backed by an in-memory mock attachment.
 */
function createMockFirebirdLite(
  config: {
    fields?: FieldInfo[];
    rows?: unknown[][];
    options?: ConstructorParameters<typeof FirebirdLite>[1];
    stmtType?: number;
    hasResultSet?: boolean;
  } = {},
) {
  const fields = config.fields ?? [{ name: 'ID', type: SQL_LONG, subType: 0, scale: 0, length: 4, nullable: false }];
  const allRows = config.rows ?? [[1]];
  const stmtType = config.stmtType ?? 1;
  const hasResultSet = config.hasResultSet ?? fields.length > 0;

  const executedParams: unknown[][] = [];

  const attachment = {
    startTransaction: jest.fn(async () => ({
      commit: jest.fn(async () => undefined),
      rollback: jest.fn(async () => undefined),
    })),
    execute: jest.fn(async () => undefined),
    prepare: jest.fn(async () => {
      const stmt = {
        fields,
        columnLabels: Promise.resolve(fields.map((f) => f.name)),
        type: Promise.resolve(stmtType),
        hasResultSet,
        execute: jest.fn(async (_tx: unknown, params: unknown[] = []) => {
          executedParams.push(params);
        }),
        executeSingleton: jest.fn(async (_tx: unknown, params: unknown[] = []) => {
          executedParams.push(params);
          return allRows[0] ?? [];
        }),
        executeQuery: jest.fn(async (_tx: unknown, params: unknown[] = []) => {
          executedParams.push(params);
          let cursor = 0;
          return {
            fetch: jest.fn(async (opts?: { fetchSize?: number }) => {
              if (cursor >= allRows.length) return [];
              const count = opts?.fetchSize ?? allRows.length;
              const slice = allRows.slice(cursor, cursor + count).map((r) => [...r]);
              cursor += slice.length;
              return slice;
            }),
            close: jest.fn(async () => undefined),
          };
        }),
        dispose: jest.fn(async () => undefined),
      };
      return stmt;
    }),
    disconnect: jest.fn(async () => undefined),
  };

  const db = new FirebirdLite('/tmp/mock-types.fdb', config.options);
  return { db, attachment, executedParams };
}

/** Attach a mock `Attachment` to a `FirebirdLite` instance with its `StatementCache` ready. */
async function attachMock(
  db: FirebirdLite,
  attachment: Record<string, unknown>,
  cacheSize = 0,
): Promise<void> {
  const internal = db as unknown as {
    attachment: unknown;
    statements: unknown;
  };
  internal.attachment = attachment;
  internal.statements = {
    enabled: cacheSize > 0,
    acquire: async (tx: unknown, s: string) => {
      const stmt = await (
        attachment.prepare as (t: unknown, q: string) => Promise<{ dispose: () => Promise<void> }>
      )(tx, s);
      return { stmt, release: () => stmt.dispose().catch(() => undefined) };
    },
    flush: async () => undefined,
  };
}

describe('Root exports for types parity', () => {
  it('re-exports firebirdTypeName, applyTypes, applySerializers, and hasTypeOptions from root index', () => {
    expect(firebirdTypeName(SQL_INT64, 0)).toBe('BIGINT');
    expect(firebirdTypeName(SQL_INT64, -2)).toBe('NUMERIC');
    expect(hasTypeOptions(undefined)).toBe(false);
    expect(hasTypeOptions({ bigint: true })).toBe(true);
    expect(typeof applyTypes).toBe('function');
    expect(typeof applySerializers).toBe('function');
  });
});

describe('Native output metadata & binary buffer decoding on FirebirdLite', () => {
  it('decodes all Firebird wire types identically to the WASM bridge and populates FieldInfo', async () => {
    const specs: ColumnSpec[] = [
      { name: 'SMALL', type: SQL_SHORT, length: 2, scale: 0, nullable: false },
      { name: 'NUM_S', type: SQL_SHORT, length: 2, scale: -2, nullable: true },
      { name: 'INT_COL', type: SQL_LONG, length: 4, scale: 0, nullable: false },
      { name: 'SAFE_BIG', type: SQL_INT64, length: 8, scale: 0, nullable: true },
      { name: 'HUGE_BIG', type: SQL_INT64, length: 8, scale: 0, nullable: true },
      { name: 'PRICE', type: SQL_INT64, subType: 1, length: 8, scale: -4, nullable: true },
      { name: 'FLT', type: SQL_FLOAT, length: 4, scale: 0, nullable: true },
      { name: 'DBL', type: SQL_DOUBLE, length: 8, scale: 0, nullable: true },
      { name: 'FLAG', type: SQL_BOOLEAN, length: 1, scale: 0, nullable: true },
      { name: 'DT', type: SQL_TYPE_DATE, length: 4, scale: 0, nullable: true },
      { name: 'TM', type: SQL_TYPE_TIME, length: 4, scale: 0, nullable: true },
      { name: 'TS', type: SQL_TIMESTAMP, length: 8, scale: 0, nullable: true },
      { name: 'CODE', type: SQL_TEXT, length: 12, charSet: 4, nullable: true }, // CHAR(3) in UTF-8 = 12 bytes
      { name: 'RAW_FIX', type: SQL_TEXT, length: 3, charSet: 1, nullable: true }, // CHAR(3) OCTETS
      { name: 'TITLE', type: SQL_VARYING, length: 20, charSet: 4, nullable: true },
      { name: 'RAW_VAR', type: SQL_VARYING, length: 10, charSet: 1, nullable: true }, // VARCHAR(10) OCTETS
      { name: 'TSTZ', type: SQL_TIMESTAMP_TZ, length: 12, charSet: 0, nullable: true },
      { name: 'I128', type: SQL_INT128, length: 16, scale: 0, nullable: true },
      { name: 'NOTE', type: SQL_BLOB, subType: 1, length: 8, charSet: 4, nullable: true },
      { name: 'BIN_BLOB', type: SQL_BLOB, subType: 0, length: 8, charSet: 1, nullable: true },
      { name: 'NUL_COL', type: SQL_LONG, length: 4, scale: 0, nullable: true },
    ];

    const driverOutMeta = buildMockNativeMetadata(specs);
    const preparedOutMeta = buildMockNativeMetadata(specs);

    const blobContents = new Map<number, Buffer>([
      [1, Buffer.from('hello world ✓', 'utf8')],
      [2, Buffer.from([0x00, 0xff, 0x80, 0x0a])],
    ]);

    let stmtDisposed = false;
    const attachment: Record<string, unknown> = {
      client: {
        statusAction: async <T>(fn: (status: unknown) => Promise<T>) => fn({}),
      },
      startTransaction: jest.fn(async () => ({
        commit: jest.fn(async () => undefined),
        rollback: jest.fn(async () => undefined),
      })),
      openBlob: jest.fn(async (_tx: unknown, blob: FbBlob) => {
        const id = blob.id[0]!;
        const data = blobContents.get(id) ?? Buffer.alloc(0);
        let readDone = false;
        return {
          read: jest.fn(async (buf: Buffer) => {
            if (readDone) return -1;
            readDone = true;
            data.copy(buf, 0);
            return data.length;
          }),
          close: jest.fn(async () => undefined),
        };
      }),
      prepare: jest.fn(async () => {
        const stmt: Record<string, unknown> = {
          attachment,
          hasResultSet: true,
          type: Promise.resolve(1),
          outMetadata: driverOutMeta,
          outBuffer: new Uint8Array(driverOutMeta.getMessageLengthSync()),
          dataReader: jest.fn(),
          statementHandle: {
            getOutputMetadataAsync: jest.fn(async () => preparedOutMeta),
          },
          internalDispose: async function (this: { outMetadata?: { releaseSync: () => void } }) {
            if (this.outMetadata) {
              this.outMetadata.releaseSync();
              this.outMetadata = undefined;
            }
            stmtDisposed = true;
          },
          dispose: async function (this: { internalDispose: () => Promise<void> }) {
            await this.internalDispose();
          },
          executeQuery: jest.fn(async (tx: unknown) => {
            // Populate stmt.outBuffer according to the custom outMetadata installed by setupOutput
            const outMeta = stmt.outMetadata as ReturnType<typeof buildMockNativeMetadata>;
            const buf = new Uint8Array(outMeta.getMessageLengthSync());
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

            const setNotNull = (i: number) =>
              dv.setInt16(outMeta.getNullOffsetSync({}, i), 0, littleEndian);
            const setNull = (i: number) =>
              dv.setInt16(outMeta.getNullOffsetSync({}, i), -1, littleEndian);

            // 0: SMALL = -42
            setNotNull(0);
            dv.setInt16(outMeta.getOffsetSync({}, 0), -42, littleEndian);
            // 1: NUM_S = -5 (scale -2 -> "-0.05")
            setNotNull(1);
            dv.setInt16(outMeta.getOffsetSync({}, 1), -5, littleEndian);
            // 2: INT_COL = 123456
            setNotNull(2);
            dv.setInt32(outMeta.getOffsetSync({}, 2), 123456, littleEndian);
            // 3: SAFE_BIG = 9007199254740991n (MAX_SAFE_INTEGER -> number)
            setNotNull(3);
            dv.setBigInt64(outMeta.getOffsetSync({}, 3), 9007199254740991n, littleEndian);
            // 4: HUGE_BIG = 9007199254740993n (past 2^53 -> string)
            setNotNull(4);
            dv.setBigInt64(outMeta.getOffsetSync({}, 4), 9007199254740993n, littleEndian);
            // 5: PRICE = 123456789012345678n (scale -4 -> "12345678901234.5678")
            setNotNull(5);
            dv.setBigInt64(outMeta.getOffsetSync({}, 5), 123456789012345678n, littleEndian);
            // 6: FLT = 1.5
            setNotNull(6);
            dv.setFloat32(outMeta.getOffsetSync({}, 6), 1.5, littleEndian);
            // 7: DBL = 0.1
            setNotNull(7);
            dv.setFloat64(outMeta.getOffsetSync({}, 7), 0.1, littleEndian);
            // 8: FLAG = true
            setNotNull(8);
            dv.setInt8(outMeta.getOffsetSync({}, 8), 1);
            // 9: DT = 2024-02-29 (days since 1858-11-17 = 60369)
            setNotNull(9);
            dv.setInt32(outMeta.getOffsetSync({}, 9), 60369, littleEndian);
            // 10: TM = 13:45:01.5000 ((13*3600 + 45*60 + 1)*10000 + 5000 = 495015000)
            setNotNull(10);
            dv.setUint32(outMeta.getOffsetSync({}, 10), 495015000, littleEndian);
            // 11: TS = 2024-02-29T13:45:01.5000
            setNotNull(11);
            dv.setInt32(outMeta.getOffsetSync({}, 11), 60369, littleEndian);
            dv.setUint32(outMeta.getOffsetSync({}, 11) + 4, 495015000, littleEndian);
            // 12: CODE = 'a✓ ' padded to 12 bytes in UTF-8 ('a' = 1 byte, '✓' = 3 bytes, 8 spaces = 12 bytes)
            setNotNull(12);
            const codeBytes = Buffer.from('a✓          ', 'utf8').subarray(0, 12);
            buf.set(codeBytes, outMeta.getOffsetSync({}, 12));
            // 13: RAW_FIX = [0xde, 0xad, 0xbe]
            setNotNull(13);
            buf.set([0xde, 0xad, 0xbe], outMeta.getOffsetSync({}, 13));
            // 14: TITLE = 'hello'
            setNotNull(14);
            const titleBytes = Buffer.from('hello', 'utf8');
            dv.setUint16(outMeta.getOffsetSync({}, 14), titleBytes.length, littleEndian);
            buf.set(titleBytes, outMeta.getOffsetSync({}, 14) + 2);
            // 15: RAW_VAR = [0x01, 0x02]
            setNotNull(15);
            dv.setUint16(outMeta.getOffsetSync({}, 15), 2, littleEndian);
            buf.set([0x01, 0x02], outMeta.getOffsetSync({}, 15) + 2);
            // 16: TSTZ coerced to SQL_VARYING: '2024-05-01 12:00:00.1234 +02:00'
            setNotNull(16);
            const tstzBytes = Buffer.from('2024-05-01 12:00:00.1234 +02:00', 'utf8');
            dv.setUint16(outMeta.getOffsetSync({}, 16), tstzBytes.length, littleEndian);
            buf.set(tstzBytes, outMeta.getOffsetSync({}, 16) + 2);
            // 17: I128 coerced to SQL_VARYING: '170141183460469231731687303715884105727'
            setNotNull(17);
            const i128Bytes = Buffer.from('170141183460469231731687303715884105727', 'utf8');
            dv.setUint16(outMeta.getOffsetSync({}, 17), i128Bytes.length, littleEndian);
            buf.set(i128Bytes, outMeta.getOffsetSync({}, 17) + 2);
            // 18: NOTE (text blob id = 1)
            setNotNull(18);
            buf.set([1, 0, 0, 0, 0, 0, 0, 0], outMeta.getOffsetSync({}, 18));
            // 19: BIN_BLOB (binary blob id = 2)
            setNotNull(19);
            buf.set([2, 0, 0, 0, 0, 0, 0, 0], outMeta.getOffsetSync({}, 19));
            // 20: NUL_COL = null
            setNull(20);

            const reader = stmt.dataReader as (
              a: unknown,
              t: unknown,
              b: Uint8Array,
            ) => Promise<unknown[]>;
            const decodedRow = await reader(attachment, tx, buf);
            let fetched = false;
            return {
              fetch: jest.fn(async () => {
                if (fetched) return [];
                fetched = true;
                return [decodedRow];
              }),
              close: jest.fn(async () => undefined),
            };
          }),
        };
        return stmt;
      }),
      disconnect: jest.fn(async () => undefined),
    };

    const db = new FirebirdLite('/tmp/wire-decode.fdb');
    await attachMock(db, attachment);

    const result = await db.query('SELECT * FROM everything');
    expect(result.fields[0]).toEqual({
      name: 'SMALL',
      type: SQL_SHORT,
      typeName: 'SMALLINT',
      subType: 0,
      scale: 0,
      length: 2,
      nullable: false,
    });
    expect(result.fields[5]).toEqual({
      name: 'PRICE',
      type: SQL_INT64,
      typeName: 'NUMERIC',
      subType: 1,
      scale: -4,
      length: 8,
      nullable: true,
    });

    expect(result.rows[0]).toEqual({
      SMALL: -42,
      NUM_S: '-0.05',
      INT_COL: 123456,
      SAFE_BIG: 9007199254740991,
      HUGE_BIG: '9007199254740993',
      PRICE: '12345678901234.5678',
      FLT: 1.5,
      DBL: 0.1,
      FLAG: true,
      DT: '2024-02-29',
      TM: '13:45:01.5000',
      TS: '2024-02-29T13:45:01.5000',
      CODE: 'a✓ ', // 3 characters (trimmed from 12 UTF-8 buffer bytes)
      RAW_FIX: Buffer.from([0xde, 0xad, 0xbe]).toString('base64'),
      TITLE: 'hello',
      RAW_VAR: Buffer.from([0x01, 0x02]).toString('base64'),
      TSTZ: '2024-05-01T12:00:00.1234 +02:00',
      I128: '170141183460469231731687303715884105727',
      NOTE: 'hello world ✓',
      BIN_BLOB: Buffer.from([0x00, 0xff, 0x80, 0x0a]).toString('base64'),
      NUL_COL: null,
    });

    // Both preparedOutMeta and driverOutMeta were released cleanly on dispose
    expect(stmtDisposed).toBe(true);
    expect(preparedOutMeta.released).toBe(true);
    expect(driverOutMeta.released).toBe(true);
  });
});

describe('FirebirdLite types: { bigint, dates, binary, parsers, serializers }', () => {
  const columns: FieldInfo[] = [
    { name: 'SAFE_BIG', type: SQL_INT64, subType: 0, scale: 0, length: 8, nullable: true },
    { name: 'HUGE_BIG', type: SQL_INT64, subType: 0, scale: 0, length: 8, nullable: true },
    { name: 'PRICE', type: SQL_INT64, subType: 1, scale: -2, length: 8, nullable: true },
    { name: 'DT', type: SQL_TYPE_DATE, subType: 0, scale: 0, length: 4, nullable: true },
    { name: 'TM', type: SQL_TYPE_TIME, subType: 0, scale: 0, length: 4, nullable: true },
    { name: 'TS', type: SQL_TIMESTAMP, subType: 0, scale: 0, length: 8, nullable: true },
    { name: 'TSTZ', type: SQL_TIMESTAMP_TZ, subType: 0, scale: 0, length: 12, nullable: true },
    { name: 'RAW_BLOB', type: SQL_BLOB, subType: 0, scale: 0, length: 8, nullable: true },
    { name: 'TXT_BLOB', type: SQL_BLOB, subType: 1, scale: 0, length: 8, nullable: true },
    { name: 'RAW_OCT', type: SQL_VARYING, subType: 0, scale: 0, length: 4, nullable: true },
  ];

  const sampleRow = [
    42,
    '9007199254740993',
    '19.99',
    '2026-08-11',
    '11:22:33.4567',
    '2026-08-11T11:22:33.4567',
    '2026-08-11T11:22:33.4567 Europe/Bucharest',
    Buffer.from([1, 2, 3]),
    'plain text blob',
    Buffer.from([9, 8]),
  ];

  async function runWithTypes(types?: TypeOptions) {
    const { db, attachment } = createMockFirebirdLite({
      fields: columns,
      rows: [sampleRow, columns.map(() => null)],
      options: { types },
    });
    await attachMock(db, attachment);
    return db.query('SELECT * FROM t');
  }

  it('keeps wire types by default when types option is omitted', async () => {
    const { rows } = await runWithTypes(undefined);
    expect(rows[0]).toEqual({
      SAFE_BIG: 42,
      HUGE_BIG: '9007199254740993',
      PRICE: '19.99',
      DT: '2026-08-11',
      TM: '11:22:33.4567',
      TS: '2026-08-11T11:22:33.4567',
      TSTZ: '2026-08-11T11:22:33.4567 Europe/Bucharest',
      RAW_BLOB: Buffer.from([1, 2, 3]).toString('base64'),
      TXT_BLOB: 'plain text blob',
      RAW_OCT: Buffer.from([9, 8]).toString('base64'),
    });
    expect(rows[1]).toEqual({
      SAFE_BIG: null,
      HUGE_BIG: null,
      PRICE: null,
      DT: null,
      TM: null,
      TS: null,
      TSTZ: null,
      RAW_BLOB: null,
      TXT_BLOB: null,
      RAW_OCT: null,
    });
  });

  it('converts BIGINT, DATE/TIMESTAMP, and binary BLOB/OCTETS when bigint, dates, and binary are true', async () => {
    const { rows } = await runWithTypes({ bigint: true, dates: true, binary: true });
    expect(rows[0]).toEqual({
      SAFE_BIG: 42n,
      HUGE_BIG: 9007199254740993n,
      PRICE: '19.99', // NUMERIC(scale -2) stays exact string
      DT: new Date('2026-08-11T00:00:00.000Z'),
      TM: '11:22:33.4567', // TIME stays string
      TS: new Date('2026-08-11T11:22:33.456Z'),
      TSTZ: '2026-08-11T11:22:33.4567 Europe/Bucharest', // zoned stays string
      RAW_BLOB: new Uint8Array([1, 2, 3]),
      TXT_BLOB: 'plain text blob',
      RAW_OCT: new Uint8Array([9, 8]),
    });
    expect((rows[0]!.RAW_BLOB as Uint8Array).constructor).toBe(Uint8Array);
    expect((rows[0]!.RAW_OCT as Uint8Array).constructor).toBe(Uint8Array);
  });

  it('applies custom parsers, skips null, passes FieldInfo, and overrides built-in conversions', async () => {
    let timestampCalls = 0;
    const { rows } = await runWithTypes({
      dates: true,
      parsers: {
        // Keyed with nullable low bit set (511 -> 510): still fires and overrides `dates: true`
        [SQL_TIMESTAMP + 1]: (v) => {
          timestampCalls += 1;
          return `ts:${v as string}`;
        },
        // Distinguishes BIGINT (scale 0) from NUMERIC (scale -2) using FieldInfo
        [SQL_INT64]: (v, field) =>
          field.scale === 0 ? `int64:${String(v)}` : `dec(${field.scale}):${String(v)}`,
      },
    });

    expect(timestampCalls).toBe(1); // called for row 0, skipped for row 1 (null)
    expect(rows[0]!.TS).toBe('ts:2026-08-11T11:22:33.4567');
    expect(rows[0]!.DT).toEqual(new Date('2026-08-11T00:00:00.000Z')); // `dates: true` still applies to DATE
    expect(rows[0]!.SAFE_BIG).toBe('int64:42');
    expect(rows[0]!.HUGE_BIG).toBe('int64:9007199254740993');
    expect(rows[0]!.PRICE).toBe('dec(-2):19.99');
    expect(rows[1]!.TS).toBeNull();
    expect(rows[1]!.SAFE_BIG).toBeNull();
  });

  it('rejects duplicate parser keys differing only in the nullable bit', async () => {
    await expect(
      runWithTypes({
        parsers: {
          [SQL_INT64]: (v) => v,
          [SQL_INT64 + 1]: (v) => v,
        },
      }),
    ).rejects.toThrow('two entries for SQL type 580');
  });

  it('wraps parser errors with the column name, type code, value, and original cause', async () => {
    const rootCause = new RangeError('bad date');
    let caught: (Error & { cause?: unknown }) | undefined;
    try {
      await runWithTypes({
        parsers: {
          [SQL_TIMESTAMP]: () => {
            throw rootCause;
          },
        },
      });
    } catch (err) {
      caught = err as Error & { cause?: unknown };
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('parser for column TS (type 510) failed');
    expect(caught!.message).toContain('"2026-08-11T11:22:33.4567"');
    expect(caught!.message).toContain('bad date');
    expect(caught!.cause).toBe(rootCause);
  });

  it('handles duplicate column names in object mode and positional values in array mode', async () => {
    const dupeFields: FieldInfo[] = [
      { name: 'ID', type: SQL_LONG, subType: 0, scale: 0, length: 4, nullable: false },
      { name: 'ID', type: SQL_LONG, subType: 0, scale: 0, length: 4, nullable: false },
    ];
    const { db, attachment } = createMockFirebirdLite({
      fields: dupeFields,
      rows: [[10, 20]],
      options: {
        types: {
          parsers: {
            [SQL_LONG]: (v) => ({ wrapped: v }),
          },
        },
      },
    });
    await attachMock(db, attachment);

    const objResult = await db.query('SELECT a.id, b.id FROM t');
    expect(objResult.rows).toEqual([{ ID: { wrapped: 20 } }]);

    const arrResult = await db.query('SELECT a.id, b.id FROM t', [], { rowMode: 'array' });
    expect(arrResult.rows).toEqual([[{ wrapped: 10 }, { wrapped: 20 }]]);
  });

  it('applies types and serializers across queryStream(), sharedReads, and transaction()', async () => {
    class DecimalValue {
      constructor(readonly text: string) {}
    }

    const streamFields: FieldInfo[] = [
      { name: 'ID', type: SQL_INT64, subType: 0, scale: 0, length: 8, nullable: false },
      { name: 'AMOUNT', type: SQL_INT64, subType: 1, scale: -2, length: 8, nullable: false },
    ];
    const streamRows = [
      [1, '10.00'],
      [2, '20.50'],
      [3, '30.75'],
    ];

    const { db, attachment, executedParams } = createMockFirebirdLite({
      fields: streamFields,
      rows: streamRows,
      options: {
        sharedReads: true,
        types: {
          bigint: true,
          parsers: {
            [SQL_INT64]: (v, f) =>
              f.scale === 0 ? BigInt(v as number | string) : new DecimalValue(String(v)),
          },
          serializers: [
            (v) => (v instanceof DecimalValue ? v.text : undefined),
          ],
        },
      },
    });
    await attachMock(db, attachment);

    // 1. sharedRead via query()
    const sharedRes = await db.query(
      sql`SELECT id, amount FROM t WHERE amount >= ${new DecimalValue('10.00')}`,
    );
    expect(executedParams[0]).toEqual(['10.00']);
    expect(sharedRes.rows[0]).toEqual({
      ID: 1n,
      AMOUNT: new DecimalValue('10.00'),
    });

    // 2. queryStream() on FirebirdLite
    const batches: unknown[] = [];
    for await (const batch of db.queryStream(
      'SELECT id, amount FROM t WHERE amount >= ?',
      [new DecimalValue('15.00')],
      { batchSize: 2 },
    )) {
      batches.push(batch.rows);
    }
    expect(executedParams[1]).toEqual(['15.00']);
    expect(batches).toEqual([
      [
        { ID: 1n, AMOUNT: new DecimalValue('10.00') },
        { ID: 2n, AMOUNT: new DecimalValue('20.50') },
      ],
      [{ ID: 3n, AMOUNT: new DecimalValue('30.75') }],
    ]);

    // 3. Inside db.transaction(): exec, execBatch, query, and queryStream
    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (?, ?)', [1, new DecimalValue('99.95')]);
      await tx.execBatch('INSERT INTO t VALUES (?, ?)', [
        [2, new DecimalValue('1.25')],
        [3, null],
      ]);

      const txQuery = await tx.query(
        'SELECT id, amount FROM t WHERE amount = ?',
        [new DecimalValue('20.50')],
        { rowMode: 'array' },
      );
      expect(txQuery.rows[0]).toEqual([1n, new DecimalValue('10.00')]);

      const txStreamRows: unknown[][] = [];
      for await (const batch of tx.queryStream(
        'SELECT id, amount FROM t',
        [],
        { rowMode: 'array', batchSize: 2 },
      )) {
        txStreamRows.push(...batch.rows);
      }
      expect(txStreamRows).toHaveLength(3);
      expect(txStreamRows[2]).toEqual([3n, new DecimalValue('30.75')]);
    });

    expect(executedParams[2]).toEqual([1, '99.95']);
    expect(executedParams[3]).toEqual([2, '1.25']);
    expect(executedParams[4]).toEqual([3, null]);
    expect(executedParams[5]).toEqual(['20.50']);
  });
});
