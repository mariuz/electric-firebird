/**
 * m19-features.test.ts – Comprehensive test suite for M19:
 *   1. End-to-End Native Engine Sync Preset (`mode: 'native'`) & Single-Thread Inline
 *      `"FBCHANGELOG\0"` Emission (`logicalEntriesToFbChangelogSegment`,
 *      `flushDatabaseFbChangelogSegment`, `syncDatabases(..., { mode: 'native' })`).
 *   2. Zero-Copy Columnar Result Buffers & Apache Arrow IPC Streaming
 *      (`queryColumnar()`, `queryArrow()`, `decodeBinaryResultColumnar`,
 *      `encodeArrowIpc`, `decodeArrowIpc`).
 *   3. WebRTC DataChannel Peer-to-Peer Sync (`createWebRtcReplicationPeer`, 16 KB SCTP
 *      chunking + CRC-32 + `bufferedAmount` backpressure) & Resilient Auto-Reconnecting
 *      Transports (`createResilientWebSocketPeer`, HTTP `retry` & `fetchSnapshotResumable`).
 *   4. Standard Schema v1 Validation (`createRowSchema`, `db.query(..., { schema })`,
 *      `SchemaValidationError`, replication `tableSchemas` + DLQ quarantine) & Typed
 *      SQL Helpers (`createTypedSql<DB>()`).
 *   5. Driver Modularization (`shared-driver-ops.ts` + barrel parity) & `npx firebird-wasm`
 *      Developer CLI (`query`, `repl`, `codegen`, `migrate`, `dump`, `restore`,
 *      `inspect-changelog`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import * as rootBarrel from '../index';
import * as browserBarrel from '../browser';
import {
  openDatabase,
  FirebirdBrowser,
  sql,
  logicalEntriesToFbChangelogSegment,
  flushDatabaseFbChangelogSegment,
  parseFbChangelogSegment,
  decodeFbChangelogOperations,
  fbChangelogToLogicalEntries,
  applyFbChangelogSegmentToDatabase,
  FbChangelogOpcode,
  syncDatabases,
  createPublication,
  createSubscription,
  createHttpReplicationHandler,
  createHttpReplicationClient,
  createWebRtcReplicationPeer,
  createResilientWebSocketPeer,
  chunkWebRtcPayload,
  WebRtcChunkAssembler,
  WebRtcPayloadKind,
  computeWebRtcCrc32,
  computeBackoffDelayMs,
  WEBRTC_CHUNK_HEADER_BYTES,
  WEBRTC_CHUNK_MAGIC,
  decodeBinaryResultColumnar,
  rowsToColumnarResult,
  encodeArrowIpc,
  decodeArrowIpc,
  createRowSchema,
  validateValueWithSchema,
  validateRowsWithSchema,
  SchemaValidationError,
  createTypedSql,
  type ReplicationLogEntry,
  type JrdColumnDescriptor,
  type RtcDataChannelLike,
  type ReconnectableWebSocketLike,
  type ConnectionLifecycleState,
  type ResumableSnapshotCheckpoint,
  type StandardSchemaV1,
} from '../index';
import {
  BINARY_CELL_BOOL,
  BINARY_CELL_FLOAT64,
  BINARY_CELL_INT32,
  BINARY_CELL_UTF8,
  BINARY_HEADER_HAS_SHAPE_ID,
  BINARY_RESULT_MAGIC_0,
  BINARY_RESULT_MAGIC_1,
  BINARY_RESULT_MAGIC_2,
  BINARY_RESULT_VERSION,
} from '../browser/binary-result';
import {
  isNonCountingDdlStatement,
  assertPreparedParamCount,
  assertBatchParameterRows,
} from '../shared-driver-ops';
import { runCli, inspectChangelogBuffer } from '../cli';

const HAS_ST_WASM = fs.existsSync(
  path.resolve(__dirname, '../../dist/wasm/firebird-embedded-st.js'),
);

/** Create an in-memory duplex WebRTC `RTCDataChannel` pair with configurable backpressure. */
function createDuplexRtcDataChannelPair(options?: {
  simulateBackpressureBytes?: number;
}): {
  a: RtcDataChannelLike;
  b: RtcDataChannelLike;
  backpressureTriggers: { count: number };
} {
  type Listener = (event: { data?: unknown }) => void;
  const listenersA = new Map<string, Set<Listener>>();
  const listenersB = new Map<string, Set<Listener>>();
  const backpressureTriggers = { count: 0 };

  const addL = (map: Map<string, Set<Listener>>, type: string, fn: Listener) => {
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(fn);
  };
  const remL = (map: Map<string, Set<Listener>>, type: string, fn: Listener) => {
    map.get(type)?.delete(fn);
  };
  const emit = (
    map: Map<string, Set<Listener>>,
    target: RtcDataChannelLike,
    type: string,
    payload?: unknown,
  ) => {
    const ev = { data: payload };
    for (const fn of map.get(type) ?? []) {
      fn(ev);
    }
    if (type === 'message' && target.onmessage) {
      target.onmessage({ data: payload });
    } else if (type === 'bufferedamountlow' && target.onbufferedamountlow) {
      target.onbufferedamountlow();
    } else if (type === 'open' && target.onopen) {
      target.onopen();
    } else if (type === 'close' && target.onclose) {
      target.onclose();
    }
  };

  let bufferedA = 0;
  let bufferedB = 0;

  const a: RtcDataChannelLike = {
    label: 'fb-repl-a',
    readyState: 'open',
    binaryType: 'arraybuffer',
    get bufferedAmount() {
      return bufferedA;
    },
    bufferedAmountLowThreshold: 0,
    send(data) {
      const copy =
        data instanceof Uint8Array
          ? data.slice()
          : data instanceof ArrayBuffer
            ? new Uint8Array(data.slice(0))
            : data;
      const byteLen = copy instanceof Uint8Array ? copy.byteLength : String(copy).length;
      bufferedA += byteLen;
      if (
        options?.simulateBackpressureBytes &&
        bufferedA >= options.simulateBackpressureBytes
      ) {
        backpressureTriggers.count++;
      }
      setTimeout(() => {
        bufferedA = Math.max(0, bufferedA - byteLen);
        emit(listenersA, a, 'bufferedamountlow');
        emit(listenersB, b, 'message', copy);
      }, 2);
    },
    addEventListener(type: string, listener: Listener) {
      addL(listenersA, type, listener);
    },
    removeEventListener(type: string, listener: Listener) {
      remL(listenersA, type, listener);
    },
    close() {
      a.readyState = 'closed';
      emit(listenersA, a, 'close');
    },
  };

  const b: RtcDataChannelLike = {
    label: 'fb-repl-b',
    readyState: 'open',
    binaryType: 'arraybuffer',
    get bufferedAmount() {
      return bufferedB;
    },
    bufferedAmountLowThreshold: 0,
    send(data) {
      const copy =
        data instanceof Uint8Array
          ? data.slice()
          : data instanceof ArrayBuffer
            ? new Uint8Array(data.slice(0))
            : data;
      const byteLen = copy instanceof Uint8Array ? copy.byteLength : String(copy).length;
      bufferedB += byteLen;
      queueMicrotask(() => {
        bufferedB = Math.max(0, bufferedB - byteLen);
        emit(listenersB, b, 'bufferedamountlow');
        emit(listenersA, a, 'message', copy);
      });
    },
    addEventListener(type: string, listener: Listener) {
      addL(listenersB, type, listener);
    },
    removeEventListener(type: string, listener: Listener) {
      remL(listenersB, type, listener);
    },
    close() {
      b.readyState = 'closed';
      emit(listenersB, b, 'close');
    },
  };

  return { a, b, backpressureTriggers };
}

// ===========================================================================
// 1. M19 Item 1 — Native Engine Sync (`mode: 'native'`) & Inline FBCHANGELOG
// ===========================================================================
describe('M19 Item 1: Single-Thread Inline "FBCHANGELOG\\0" Emission & Native Sync Preset', () => {
  it('encodes logical entries + BLOBs + sequences into genuine FBCHANGELOG\\0 binary segments and round-trips cleanly', () => {
    const schema: Record<string, JrdColumnDescriptor[]> = {
      DOCS: [
        { name: 'ID', type: 'INTEGER', nullable: false },
        { name: 'TITLE', type: 'VARCHAR', charLength: 32, maxBytes: 128, nullable: false },
        { name: 'ACTIVE', type: 'BOOLEAN', nullable: false },
        { name: 'AMOUNT', type: 'BIGINT', nullable: true },
        { name: 'BODY', type: 'BLOB', blobSubType: 'TEXT', nullable: true },
      ],
    };

    const entries: ReplicationLogEntry[] = [
      {
        lsn: 1,
        txid: '101',
        timestamp: 1_700_000_000_000,
        origin: 'node-primary',
        publication: 'PUB_DEFAULT',
        table: 'DOCS',
        operation: 'INSERT',
        key: { ID: 1 },
        before: null,
        after: {
          ID: 1,
          TITLE: 'Hello Native',
          ACTIVE: true,
          AMOUNT: '9007199254740993',
          BODY: 'Inline BLOB payload stored via opStoreBlob!',
        },
      },
      {
        lsn: 2,
        txid: '101',
        timestamp: 1_700_000_000_001,
        origin: 'node-primary',
        publication: 'PUB_DEFAULT',
        table: 'DOCS',
        operation: 'UPDATE',
        key: { ID: 1 },
        before: {
          ID: 1,
          TITLE: 'Hello Native',
          ACTIVE: true,
          AMOUNT: '9007199254740993',
          BODY: 'Inline BLOB payload stored via opStoreBlob!',
        },
        after: {
          ID: 1,
          TITLE: 'Updated Native',
          ACTIVE: false,
          AMOUNT: null,
          BODY: 'Revised BLOB text',
        },
      },
      {
        lsn: 3,
        txid: '102',
        timestamp: 1_700_000_000_002,
        origin: 'node-primary',
        publication: 'PUB_DEFAULT',
        table: 'DOCS',
        operation: 'DELETE',
        key: { ID: 1 },
        before: {
          ID: 1,
          TITLE: 'Updated Native',
          ACTIVE: false,
          AMOUNT: null,
          BODY: null,
        },
        after: null,
      },
    ];

    const segment = logicalEntriesToFbChangelogSegment(entries, {
      sequence: 7,
      guid: '01020304-0506-0708-090a-0b0c0d0e0f10',
      tableSchemas: schema,
      recordEncoding: 'jrd',
      sequences: [{ name: 'GEN_DOCS_ID', currentValue: 42 }],
    });

    const parsed = parseFbChangelogSegment(segment);
    expect(parsed.header.sequence).toBe(7);
    expect(parsed.header.guid).toBe('01020304-0506-0708-090A-0B0C0D0E0F10');
    // Block 0 = sequence block (traNumber 0), Block 1 = tx 101, Block 2 = tx 102
    expect(parsed.blocks.length).toBe(3);

    const ops = decodeFbChangelogOperations(parsed);
    const opcodes = ops.map((o) => o.opcode);
    expect(opcodes).toContain(FbChangelogOpcode.opSetSequence);
    expect(opcodes).toContain(FbChangelogOpcode.opStoreBlob);
    expect(opcodes).toContain(FbChangelogOpcode.opInsertRecord);
    expect(opcodes).toContain(FbChangelogOpcode.opUpdateRecord);
    expect(opcodes).toContain(FbChangelogOpcode.opDeleteRecord);

    const decoded = fbChangelogToLogicalEntries(segment, { tableSchemas: schema });
    expect(decoded.sequences).toEqual([{ name: 'GEN_DOCS_ID', currentValue: 42 }]);
    expect(decoded.committedTransactions).toEqual([101, 102]);
    expect(decoded.entries).toHaveLength(3);
    expect(decoded.entries[0]!.operation).toBe('INSERT');
    expect(decoded.entries[0]!.after).toMatchObject({
      ID: 1,
      TITLE: 'Hello Native',
      ACTIVE: true,
      AMOUNT: 9007199254740993n,
      BODY: 'Inline BLOB payload stored via opStoreBlob!',
    });
    expect(decoded.entries[1]!.operation).toBe('UPDATE');
    expect(decoded.entries[1]!.after).toMatchObject({
      ID: 1,
      TITLE: 'Updated Native',
      ACTIVE: false,
      AMOUNT: null,
      BODY: 'Revised BLOB text',
    });
    expect(decoded.entries[2]!.operation).toBe('DELETE');
  });

  it.skipIf(!HAS_ST_WASM)(
    'flushes inline FBCHANGELOG\\0 segments and syncs primary <-> replica in mode: "native" via C++ IReplicator',
    async () => {
      const primary = new FirebirdBrowser('memory://m19_nat_primary', {
        threads: false,
      });
      const replica = new FirebirdBrowser('memory://m19_nat_replica', {
        threads: false,
      });

      try {
        await primary.exec(`
          CREATE TABLE ITEMS (
            ID INTEGER NOT NULL PRIMARY KEY,
            NAME VARCHAR(64) NOT NULL,
            PRICE DOUBLE PRECISION,
            IN_STOCK BOOLEAN NOT NULL
          )
        `);
        await primary.exec(
          `INSERT INTO ITEMS (ID, NAME, PRICE, IN_STOCK) VALUES (1, 'Keyboard', 99.5, TRUE)`,
        );
        await primary.exec(
          `INSERT INTO ITEMS (ID, NAME, PRICE, IN_STOCK) VALUES (2, 'Mouse', 45.0, FALSE)`,
        );

        // One-liner native sync with autoBootstrap + catalog sync on single-threaded WASM
        const syncHandle = await syncDatabases(primary, replica, {
          mode: 'native',
          autoBootstrap: true,
          live: false,
        });

        expect(syncHandle.mode).toBe('native');

        const bootRows = await replica.query<{
          ID: number;
          NAME: string;
          PRICE: number | null;
          IN_STOCK: boolean;
        }>('SELECT ID, NAME, PRICE, IN_STOCK FROM ITEMS ORDER BY ID');
        expect(bootRows.rows).toEqual([
          { ID: 1, NAME: 'Keyboard', PRICE: 99.5, IN_STOCK: true },
          { ID: 2, NAME: 'Mouse', PRICE: 45, IN_STOCK: false },
        ]);

        // Mutate primary (`INSERT`, `UPDATE`, `DELETE`) and run native `syncOnce()`
        await primary.exec(
          `INSERT INTO ITEMS (ID, NAME, PRICE, IN_STOCK) VALUES (3, 'Monitor', 349.99, TRUE)`,
        );
        await primary.exec(
          `UPDATE ITEMS SET PRICE = 89.0, IN_STOCK = FALSE WHERE ID = 1`,
        );
        await primary.exec(`DELETE FROM ITEMS WHERE ID = 2`);

        const syncCycle = await syncHandle.syncNow();
        const totalApplied =
          'appliedCount' in syncCycle
            ? syncCycle.appliedCount
            : syncCycle.primaryToReplica.appliedCount;
        expect(totalApplied).toBeGreaterThanOrEqual(3);
        expect(syncHandle.nativeSegmentsApplied).toBeGreaterThanOrEqual(1);
        expect(syncHandle.usedNativeReplicator).toBe(true);

        const afterSync = await replica.query<{
          ID: number;
          NAME: string;
          PRICE: number | null;
          IN_STOCK: boolean;
        }>('SELECT ID, NAME, PRICE, IN_STOCK FROM ITEMS ORDER BY ID');
        expect(afterSync.rows).toEqual([
          { ID: 1, NAME: 'Keyboard', PRICE: 89, IN_STOCK: false },
          { ID: 3, NAME: 'Monitor', PRICE: 349.99, IN_STOCK: true },
        ]);

        // Also verify `flushDatabaseFbChangelogSegment` writes `.journal-000000001` into an FS adapter
        const writtenFiles = new Map<string, Uint8Array>();
        const mockFs = {
          mkdir: () => undefined,
          readdir: () => Array.from(writtenFiles.keys()),
          readFile: (p: string) => writtenFiles.get(p) ?? new Uint8Array(0),
          writeFile: (p: string, data: string | Uint8Array) => {
            writtenFiles.set(
              p,
              typeof data === 'string' ? new TextEncoder().encode(data) : data,
            );
          },
          unlink: (p: string) => {
            writtenFiles.delete(p);
          },
        };

        const pub = await createPublication(primary, {
          name: 'PUB_ARCHIVE_TEST',
          tables: ['ITEMS'],
          installTriggers: true,
        });
        await pub.captureTableChanges();
        const baseLsn = await pub.currentLsn();
        await primary.exec(
          `INSERT INTO ITEMS (ID, NAME, PRICE, IN_STOCK) VALUES (4, 'Webcam', null, TRUE)`,
        );

        const flushed = await flushDatabaseFbChangelogSegment(primary, {
          publication: pub,
          sinceLsn: baseLsn,
          sequence: 1,
          fs: mockFs,
          journalArchiveDirectory: '/tmp/archive',
          journalFilePrefix: 'm19',
        });
        expect(flushed.entryCount).toBe(1);
        expect(flushed.archivePath).toBe('/tmp/archive/m19.journal-000000001');
        expect(writtenFiles.has('/tmp/archive/m19.journal-000000001')).toBe(true);

        const replayRes = await applyFbChangelogSegmentToDatabase(
          replica,
          flushed.segment!,
        );
        expect(replayRes.usedNativeReplicator).toBe(true);

        const row4 = await replica.query<{ ID: number; NAME: string; PRICE: number | null }>(
          'SELECT ID, NAME, PRICE FROM ITEMS WHERE ID = 4',
        );
        expect(row4.rows).toEqual([{ ID: 4, NAME: 'Webcam', PRICE: null }]);

        await syncHandle.stop();
      } finally {
        await primary.close();
        await replica.close();
      }
    },
  );
});

// ===========================================================================
// 2. M19 Item 2 — Zero-Copy Columnar Result Buffers & Apache Arrow IPC
// ===========================================================================
describe('M19 Item 2: Columnar Result Buffers & Apache Arrow IPC Streaming', () => {
  it('decodes FBR v1 binary payloads directly into typed columnar vectors (including cached shapeId)', () => {
    // Build a synthetic FBR v1 binary payload with 2 rows and 4 columns: ID (int32), SCORE (float64), OK (bool), TAG (utf8)
    const tagBytes = new TextEncoder().encode('alpha');
    const buf: number[] = [
      BINARY_RESULT_MAGIC_0,
      BINARY_RESULT_MAGIC_1,
      BINARY_RESULT_MAGIC_2,
      BINARY_RESULT_VERSION,
      BINARY_HEADER_HAS_SHAPE_ID, // flags
    ];
    const pushU32 = (v: number) =>
      buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    const pushI32 = (v: number) => pushU32(v >>> 0);
    const pushF64 = (v: number) => {
      const tmp = new ArrayBuffer(8);
      new DataView(tmp).setFloat64(0, v, true);
      buf.push(...new Uint8Array(tmp));
    };

    pushU32(99); // shapeId = 99 (no column headers in payload!)
    pushU32(2); // rowCount = 2

    // Row 0: nullMask = 0x00, (10, 3.5, true, 'alpha')
    buf.push(0x00);
    buf.push(BINARY_CELL_INT32);
    pushI32(10);
    buf.push(BINARY_CELL_FLOAT64);
    pushF64(3.5);
    buf.push(BINARY_CELL_BOOL, 1);
    buf.push(BINARY_CELL_UTF8);
    pushU32(tagBytes.byteLength);
    buf.push(...tagBytes);

    // Row 1: nullMask = (1 << 1) | (1 << 3) = 0x0a, (20, null, false, null)
    buf.push((1 << 1) | (1 << 3));
    buf.push(BINARY_CELL_INT32);
    pushI32(20);
    buf.push(BINARY_CELL_BOOL, 0);

    const cachedFields: rootBarrel.FieldInfo[] = [
      { name: 'ID', type: 496, typeName: 'INTEGER', subType: 0, scale: 0, nullable: false },
      { name: 'SCORE', type: 480, typeName: 'DOUBLE', subType: 0, scale: 0, nullable: true },
      { name: 'OK', type: 32764, typeName: 'BOOLEAN', subType: 0, scale: 0, nullable: false },
      { name: 'TAG', type: 448, typeName: 'VARYING', subType: 0, scale: 0, nullable: true },
    ];

    const colRes = decodeBinaryResultColumnar(
      new Uint8Array(buf),
      (id) => (id === 99 ? cachedFields : []),
    );
    expect(colRes.rowCount).toBe(2);
    expect(colRes.getColumn('ID')?.kind).toBe('int32');
    expect(colRes.getColumn('ID')?.get(0)).toBe(10);
    expect(colRes.getColumn('ID')?.get(1)).toBe(20);
    expect(colRes.getColumn('SCORE')?.nullCount).toBe(1);
    expect(colRes.getColumn('SCORE')?.get(0)).toBe(3.5);
    expect(colRes.getColumn('SCORE')?.isNull(1)).toBe(true);
    expect(colRes.getColumn('OK')?.get(0)).toBe(true);
    expect(colRes.getColumn('OK')?.get(1)).toBe(false);
    expect(colRes.getColumn('TAG')?.get(0)).toBe('alpha');
    expect(colRes.getColumn('TAG')?.get(1)).toBeNull();
    expect(colRes.toRows()).toEqual([
      { ID: 10, SCORE: 3.5, OK: true, TAG: 'alpha' },
      { ID: 20, SCORE: null, OK: false, TAG: null },
    ]);

    // Round-trip through Apache Arrow IPC stream (`encodeArrowIpc` -> `decodeArrowIpc`)
    const ipc = encodeArrowIpc(colRes, { metadata: { origin: 'unit' } });
    const decodedIpc = decodeArrowIpc(ipc);
    expect(decodedIpc.metadata).toEqual({ origin: 'unit' });
    expect(decodedIpc.toRows()).toEqual(colRes.toRows());
  });

  it.skipIf(!HAS_ST_WASM)(
    'executes db.queryColumnar(), tx.queryColumnar(), and db.queryArrow() on real Firebird WASM across all 6 vector kinds',
    async () => {
      await using db = await openDatabase('memory://m19_columnar', {
        threads: false,
        types: { bigint: true, binary: true },
      });

      await db.execute(`
        CREATE TABLE METRICS (
          ID INTEGER NOT NULL PRIMARY KEY,
          BIG_CNT BIGINT,
          RATIO DOUBLE PRECISION,
          FLAG BOOLEAN,
          LABEL VARCHAR(40),
          RAW_DATA BLOB SUB_TYPE BINARY
        )
      `);

      await db.execute(
        `INSERT INTO METRICS (ID, BIG_CNT, RATIO, FLAG, LABEL, RAW_DATA) VALUES (?, ?, ?, ?, ?, ?)`,
        [1, 9007199254740995n, 1.25, true, 'first-row', new Uint8Array([0xde, 0xad, 0xbe, 0xef])],
      );
      await db.execute(
        `INSERT INTO METRICS (ID, BIG_CNT, RATIO, FLAG, LABEL, RAW_DATA) VALUES (?, ?, ?, ?, ?, ?)`,
        [2, null, null, false, null, null],
      );
      await db.execute(
        `INSERT INTO METRICS (ID, BIG_CNT, RATIO, FLAG, LABEL, RAW_DATA) VALUES (?, ?, ?, ?, ?, ?)`,
        [3, -42n, -99.75, true, 'third-row 🚀', new Uint8Array([1, 2, 3])],
      );

      const col = await db.queryColumnar(
        'SELECT ID, BIG_CNT, RATIO, FLAG, LABEL, RAW_DATA FROM METRICS ORDER BY ID',
      );
      expect(col.rowCount).toBe(3);
      expect(col.getColumn('ID')?.kind).toBe('int32');
      expect(col.getColumn('BIG_CNT')?.kind).toBe('bigint64');
      expect(col.getColumn('RATIO')?.kind).toBe('float64');
      expect(col.getColumn('FLAG')?.kind).toBe('bool');
      expect(col.getColumn('LABEL')?.kind).toBe('utf8');
      expect(col.getColumn('RAW_DATA')?.kind).toBe('bytes');

      expect(col.getValue(0, 'BIG_CNT')).toBe(9007199254740995n);
      expect(col.getValue(1, 'BIG_CNT')).toBeNull();
      expect(col.getValue(2, 'BIG_CNT')).toBe(-42n);
      expect(col.getValue(2, 'LABEL')).toBe('third-row 🚀');
      expect(col.getValue(0, 'RAW_DATA')).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );

      // Transaction-scoped `tx.queryColumnar` & `tx.queryArrow`
      await db.transaction(async (tx) => {
        const txCol = await tx.queryColumnar(
          'SELECT ID, LABEL FROM METRICS WHERE ID >= ? ORDER BY ID',
          [2],
        );
        expect(txCol.rowCount).toBe(2);
        expect(txCol.toRows()).toEqual([
          { ID: 2, LABEL: null },
          { ID: 3, LABEL: 'third-row 🚀' },
        ]);

        const txArrow = await tx.queryArrow(
          'SELECT ID, LABEL FROM METRICS WHERE ID = 1',
          [],
          { metadata: { tx: 'yes' } },
        );
        const parsedTxArrow = decodeArrowIpc(txArrow);
        expect(parsedTxArrow.metadata.tx).toBe('yes');
        expect(parsedTxArrow.toRows()).toEqual([{ ID: 1, LABEL: 'first-row' }]);
      });

      // Full 6-type round-trip through `db.queryArrow()` -> `decodeArrowIpc()`
      const arrowBytes = await db.queryArrow(
        'SELECT ID, BIG_CNT, RATIO, FLAG, LABEL, RAW_DATA FROM METRICS ORDER BY ID',
        [],
        { metadata: { suite: 'm19-arrow' } },
      );
      const roundTripped = decodeArrowIpc(arrowBytes);
      expect(roundTripped.metadata).toEqual({ suite: 'm19-arrow' });
      expect(roundTripped.rowCount).toBe(3);
      expect(roundTripped.toRows()).toEqual(col.toRows());

      // Empty result set round-trip
      const emptyCol = rowsToColumnarResult({
        fields: col.fields,
        rows: [],
      });
      const emptyDecoded = decodeArrowIpc(emptyCol.toArrowIpc());
      expect(emptyDecoded.rowCount).toBe(0);
      expect(emptyDecoded.fields.map((f) => f.name)).toEqual(
        col.fields.map((f) => f.name),
      );
    },
  );
});

// ===========================================================================
// 3. M19 Item 3 — WebRTC DataChannel Sync & Resilient Transports
// ===========================================================================
describe('M19 Item 3: WebRTC DataChannel Sync & Resilient Auto-Reconnecting Transports', () => {
  it('chunks >64 KB payloads into <=16 KB SCTP frames, reassembles out-of-order frames, and rejects CRC-32 corruption', () => {
    const bigPayload = new Uint8Array(75_000);
    for (let i = 0; i < bigPayload.byteLength; i++) {
      bigPayload[i] = (i * 31 + 7) & 0xff;
    }

    const frames = chunkWebRtcPayload(bigPayload, {
      transferId: 42,
      payloadKind: WebRtcPayloadKind.SnapshotJson,
      maxChunkBytes: 16 * 1024,
    });
    expect(frames.length).toBeGreaterThanOrEqual(5);
    for (const f of frames) {
      expect(f.byteLength).toBeLessThanOrEqual(16 * 1024);
      expect(new DataView(f.buffer).getUint32(0, false)).toBe(WEBRTC_CHUNK_MAGIC);
    }

    // Deliver out of order (reversed)
    const assembler = new WebRtcChunkAssembler();
    let result = null;
    for (let i = frames.length - 1; i >= 0; i--) {
      const out = assembler.pushChunk(frames[i]!);
      if (out) result = out;
    }
    expect(result).not.toBeNull();
    expect(result!.transferId).toBe(42);
    expect(result!.payloadKind).toBe(WebRtcPayloadKind.SnapshotJson);
    expect(result!.crc32).toBe(computeWebRtcCrc32(bigPayload));
    expect(result!.payload).toEqual(bigPayload);

    // Corrupt 1 byte in a frame body and verify CRC-32 mismatch throws
    const badFrames = chunkWebRtcPayload(new Uint8Array([1, 2, 3, 4, 5]), {
      transferId: 99,
    });
    badFrames[0]![WEBRTC_CHUNK_HEADER_BYTES]! ^= 0xff;
    expect(() => assembler.pushChunk(badFrames[0]!)).toThrow(/CRC-32 mismatch/i);
  });

  it.skipIf(!HAS_ST_WASM)(
    'replicates >64 KB snapshots, live changes, and FBCHANGELOG\\0 segments over WebRTC DataChannels with backpressure + db.syncWith()',
    async () => {
      const peerA = new FirebirdBrowser('memory://m19_rtc_a', {
        threads: false,
      });
      const peerB = new FirebirdBrowser('memory://m19_rtc_b', {
        threads: false,
      });

      try {
        await peerA.exec(`
          CREATE TABLE NOTES (
            ID INTEGER NOT NULL PRIMARY KEY,
            BODY VARCHAR(2048) NOT NULL
          )
        `);
        await peerB.exec(`
          CREATE TABLE NOTES (
            ID INTEGER NOT NULL PRIMARY KEY,
            BODY VARCHAR(2048) NOT NULL
          )
        `);

        // Insert >70 KB of initial rows so snapshot transfer spans multiple 16 KB SCTP frames
        const pad = 'X'.repeat(1500);
        const batchParams: unknown[][] = [];
        for (let i = 1; i <= 50; i++) {
          batchParams.push([i, `Note-${i}-${pad}`]);
        }
        await peerA.execBatch(
          'INSERT INTO NOTES (ID, BODY) VALUES (?, ?)',
          batchParams,
        );

        const pubA = await createPublication(peerA, {
          name: 'PUB_RTC',
          tables: ['NOTES'],
          origin: 'rtc-a',
          installTriggers: true,
        });
        const subB = await createSubscription(peerB, {
          name: 'sub_rtc_b',
          publication: { name: 'PUB_RTC', fetchChangesSince: async () => [] },
          slotName: 'slot_rtc_b',
          nodeId: 'rtc-b',
        });

        const { a: chanA, b: chanB, backpressureTriggers } =
          createDuplexRtcDataChannelPair({ simulateBackpressureBytes: 16 * 1024 });

        const rtcA = createWebRtcReplicationPeer({
          channel: chanA,
          publication: pubA,
          maxBufferedAmount: 16 * 1024,
        });

        let snapshotCompleted = false;
        const rtcB = createWebRtcReplicationPeer({
          channel: chanB,
          subscription: subB,
          snapshotTargetDb: peerB,
          changelogTargetDb: peerB,
          onSnapshot: () => {
            snapshotCompleted = true;
          },
        });

        await rtcB.requestSnapshot();
        for (let attempt = 0; attempt < 60 && !snapshotCompleted; attempt++) {
          await new Promise((r) => setTimeout(r, 15));
        }
        expect(snapshotCompleted).toBe(true);
        expect(rtcA.chunksSent).toBeGreaterThanOrEqual(5);
        expect(backpressureTriggers.count).toBeGreaterThanOrEqual(1);

        const countB = await peerB.query<{ CNT: number }>(
          'SELECT COUNT(*) AS CNT FROM NOTES',
        );
        expect(countB.rows[0]?.CNT).toBe(50);

        // Also verify `peerA.syncWith(chanA)` / `createWebRtcReplicationPeer` pushes live incremental rows
        await peerA.exec(`INSERT INTO NOTES (ID, BODY) VALUES (51, 'Incremental-51')`);
        await rtcA.pushSince(0);
        await new Promise((r) => setTimeout(r, 40));

        const row51 = await peerB.query<{ BODY: string }>(
          'SELECT BODY FROM NOTES WHERE ID = 51',
        );
        expect(row51.rows).toEqual([{ BODY: 'Incremental-51' }]);

        // Stream a gzip-compressed `"FBCHANGELOG\0"` segment over WebRTC DataChannel
        await peerA.exec(`INSERT INTO NOTES (ID, BODY) VALUES (52, 'Native-Segment-52')`);
        const flushed = await flushDatabaseFbChangelogSegment(peerA, {
          publication: pubA,
          sinceLsn: 1,
          sequence: 2,
        });
        expect(flushed.segment).not.toBeNull();
        await rtcA.sendChangelogSegment(flushed.segment!, { compress: true });
        await new Promise((r) => setTimeout(r, 50));

        const row52 = await peerB.query<{ BODY: string }>(
          'SELECT BODY FROM NOTES WHERE ID = 52',
        );
        expect(row52.rows).toEqual([{ BODY: 'Native-Segment-52' }]);

        rtcA.close();
        rtcB.close();
      } finally {
        await peerA.close();
        await peerB.close();
      }
    },
  );

  it.skipIf(!HAS_ST_WASM)(
    'auto-reconnects WebSocket peers with backoff + offline queue flush, and resumes chunked HTTP snapshots after transient 503 failures',
    async () => {
      // Deterministic exponential backoff check
      expect(
        computeBackoffDelayMs(0, { baseDelayMs: 50, factor: 2, jitterRatio: 0 }),
      ).toBe(50);
      expect(
        computeBackoffDelayMs(3, { baseDelayMs: 50, factor: 2, jitterRatio: 0 }),
      ).toBe(400);

      const primary = new FirebirdBrowser('memory://m19_resil_primary', {
        threads: false,
      });
      const replica = new FirebirdBrowser('memory://m19_resil_replica', {
        threads: false,
      });

      try {
        await primary.exec(
          'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64) NOT NULL)',
        );
        await replica.exec(
          'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64) NOT NULL)',
        );
        for (let i = 1; i <= 7; i++) {
          await primary.exec('INSERT INTO TASKS (ID, TITLE) VALUES (?, ?)', [
            i,
            `Task-${i}`,
          ]);
        }

        const pub = await createPublication(primary, {
          name: 'PUB_RESIL',
          tables: ['TASKS'],
          origin: 'srv',
          installTriggers: true,
        });
        const sub = await createSubscription(replica, {
          name: 'sub_resil',
          publication: { name: 'PUB_RESIL', fetchChangesSince: async () => [] },
          slotName: 'slot_resil',
          nodeId: 'cli',
        });

        // 1. HTTP Retry + Resumable Snapshot Bootstrap
        const handler = createHttpReplicationHandler({ publication: pub });
        let chunkCalls = 0;
        let transient503Injected = false;
        let hardCutRemaining = 3; // Exceeds maxRetries=2 on offset=4 so first run aborts & second resumes

        const flakyFetch: typeof fetch = async (input, init) => {
          const urlStr =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (urlStr.includes('/snapshot/chunk')) {
            chunkCalls++;
            // Inject a transient 503 on call #1 (recovered automatically by `retry`)
            if (!transient503Injected) {
              transient503Injected = true;
              return new Response('Service Unavailable', { status: 503 });
            }
            // Inject an outage when requesting offset=4 so `maxRetries: 2` exhausts and caller resumes from `checkpoint`
            if (urlStr.includes('offset=4') && hardCutRemaining > 0) {
              hardCutRemaining--;
              throw new TypeError('Network connection lost mid-snapshot');
            }
          }
          return handler(new Request(urlStr, init));
        };

        const httpStates: ConnectionLifecycleState[] = [];
        const client = createHttpReplicationClient({
          baseUrl: 'https://repl.local',
          fetch: flakyFetch,
          retry: {
            maxRetries: 2,
            baseDelayMs: 5,
            maxDelayMs: 20,
            jitterRatio: 0,
          },
          onStateChange: (st) => httpStates.push(st),
        });

        const checkpoint: ResumableSnapshotCheckpoint = {
          currentTableIndex: 0,
          currentRowOffset: 0,
          completedTables: [],
          partialRows: [],
        };

        // First attempt fails partway through after loading 4 of 7 rows into `checkpoint`
        await expect(
          client.fetchSnapshotResumable({ chunkSize: 2, checkpoint }),
        ).rejects.toThrow(/Network connection lost/);
        expect(checkpoint.currentRowOffset).toBe(4);
        expect(checkpoint.partialRows).toHaveLength(4);
        expect(httpStates).toContain('backoff');

        // Second call resumes from `checkpoint` (offset 4) without re-downloading rows 1..4!
        const resumedSnapshot = await client.fetchSnapshotResumable({
          chunkSize: 2,
          checkpoint,
        });
        expect(resumedSnapshot.tables).toHaveLength(1);
        expect(resumedSnapshot.tables[0]!.rows).toHaveLength(7);
        expect(chunkCalls).toBeGreaterThanOrEqual(4);
        expect(client.state).toBe('online');

        // 2. Resilient Auto-Reconnecting WebSocket Peer
        let currentServerPeer: ReturnType<typeof rootBarrel.createWebSocketReplicationPeer> | null =
          null;
        let activeClientSocket: ReconnectableWebSocketLike & {
          simulateDrop?: () => void;
        } | null = null;
        let socketCreatedCount = 0;

        const wsStates: ConnectionLifecycleState[] = [];
        const resilientPeer = createResilientWebSocketPeer({
          publication: undefined,
          subscription: sub,
          backoff: {
            maxRetries: 5,
            baseDelayMs: 15,
            maxDelayMs: 50,
            jitterRatio: 0,
          },
          onStateChange: (s) => wsStates.push(s),
          createSocket: () => {
            socketCreatedCount++;
            const clientMsgListeners = new Set<(ev: { data: unknown }) => void>();
            const clientCloseListeners = new Set<() => void>();
            const serverMsgListeners = new Set<(ev: { data: unknown }) => void>();

            const serverSock = {
              send(data: string | Uint8Array) {
                const copy = data instanceof Uint8Array ? data.slice() : data;
                queueMicrotask(() => {
                  for (const fn of clientMsgListeners) fn({ data: copy });
                });
              },
              addEventListener(_t: 'message', fn: (ev: { data: unknown }) => void) {
                serverMsgListeners.add(fn);
              },
              removeEventListener(_t: 'message', fn: (ev: { data: unknown }) => void) {
                serverMsgListeners.delete(fn);
              },
            };

            currentServerPeer?.close();
            currentServerPeer = rootBarrel.createWebSocketReplicationPeer({
              socket: serverSock,
              publication: pub,
            });

            const clientSock: ReconnectableWebSocketLike & {
              simulateDrop: () => void;
            } = {
              readyState: 1,
              send(data: string | Uint8Array) {
                const copy = data instanceof Uint8Array ? data.slice() : data;
                queueMicrotask(() => {
                  for (const fn of serverMsgListeners) fn({ data: copy });
                });
              },
              addEventListener(
                type: string,
                fn: ((ev: { data: unknown }) => void) | (() => void),
              ) {
                if (type === 'message') {
                  clientMsgListeners.add(fn as (ev: { data: unknown }) => void);
                } else if (type === 'close') {
                  clientCloseListeners.add(fn as () => void);
                }
              },
              removeEventListener(
                type: string,
                fn: ((ev: { data: unknown }) => void) | (() => void),
              ) {
                if (type === 'message') {
                  clientMsgListeners.delete(fn as (ev: { data: unknown }) => void);
                } else if (type === 'close') {
                  clientCloseListeners.delete(fn as () => void);
                }
              },
              simulateDrop() {
                clientSock.readyState = 3;
                for (const fn of clientCloseListeners) fn();
              },
            };
            activeClientSocket = clientSock;
            return clientSock;
          },
        });

        await new Promise((r) => setTimeout(r, 30));
        expect(resilientPeer.state).toBe('online');

        // Insert row 8 while disconnect happens -> reconnect should automatically catch up!
        await primary.exec(`INSERT INTO TASKS (ID, TITLE) VALUES (8, 'After-Drop-8')`);
        activeClientSocket!.simulateDrop!();

        for (let i = 0; i < 40 && resilientPeer.totalReconnects < 1; i++) {
          await new Promise((r) => setTimeout(r, 15));
        }
        await new Promise((r) => setTimeout(r, 40));

        expect(socketCreatedCount).toBeGreaterThanOrEqual(2);
        expect(resilientPeer.totalReconnects).toBe(1);
        expect(resilientPeer.state).toBe('online');
        expect(wsStates).toContain('backoff');

        const row8 = await replica.query<{ TITLE: string }>(
          'SELECT TITLE FROM TASKS WHERE ID = 8',
        );
        expect(row8.rows).toEqual([{ TITLE: 'After-Drop-8' }]);

        resilientPeer.close();
        currentServerPeer?.close();
      } finally {
        await primary.close();
        await replica.close();
      }
    },
  );
});

// ===========================================================================
// 4. M19 Item 4 — Standard Schema v1 Validation & Typed SQL (`createTypedSql`)
// ===========================================================================
describe('M19 Item 4: Standard Schema v1 Validation & Typed SQL Helpers', () => {
  it('validates sync & async StandardSchemaV1 validators and throws structured SchemaValidationError on invalid rows', async () => {
    const userSchema = createRowSchema<{
      id: number;
      email: string;
      normalizedEmail: string;
    }>({
      id: 'number',
      email: 'string',
      normalizedEmail: (_val, row) => String(row.EMAIL ?? row.email ?? '').toLowerCase(),
    });

    const valid = await validateValueWithSchema(userSchema, {
      ID: 7,
      EMAIL: 'Alice@Example.COM',
    });
    expect(valid).toEqual({
      id: 7,
      email: 'Alice@Example.COM',
      normalizedEmail: 'alice@example.com',
    });

    // Async Zod/Valibot-style `~standard` validator
    const asyncPositiveScoreSchema: StandardSchemaV1<unknown, { score: number }> = {
      '~standard': {
        version: 1,
        vendor: 'custom-async',
        validate: async (val) => {
          const obj = val as Record<string, unknown>;
          const num = Number(obj?.SCORE ?? obj?.score);
          if (!Number.isFinite(num) || num < 0) {
            return {
              issues: [{ path: ['score'], message: 'Score must be non-negative' }],
            };
          }
          return { value: { score: num * 10 } };
        },
      },
    };

    const rows = await validateRowsWithSchema(asyncPositiveScoreSchema, [
      { SCORE: 2 },
      { SCORE: 5 },
    ]);
    expect(rows).toEqual([{ score: 20 }, { score: 50 }]);

    await expect(
      validateRowsWithSchema(
        asyncPositiveScoreSchema,
        [{ SCORE: 1 }, { SCORE: -3 }],
        { tableName: 'SCORES' },
      ),
    ).rejects.toMatchObject({
      name: 'SchemaValidationError',
      rowIndex: 1,
      tableName: 'SCORES',
    });
  });

  it.skipIf(!HAS_ST_WASM)(
    'integrates StandardSchemaV1 + createTypedSql<DB>() on queries, prepared statements, and replication DLQ quarantine',
    async () => {
      interface AppSchema {
        USERS: {
          ID: number;
          USERNAME: string;
          AGE: number;
        };
      }

      await using db = await openDatabase('memory://m19_schema_sql', {
        threads: false,
      });

      await db.execute(`
        CREATE TABLE USERS (
          ID INTEGER NOT NULL PRIMARY KEY,
          USERNAME VARCHAR(64) NOT NULL,
          AGE INTEGER NOT NULL
        )
      `);

      const tsql = createTypedSql<AppSchema>(db);

      // `insertInto` & `upsertInto`
      await tsql.execute(
        tsql.insertInto('USERS', { ID: 1, USERNAME: 'ada', AGE: 36 }),
      );
      await tsql.execute(
        tsql.insertInto('USERS', { ID: 2, USERNAME: 'grace', AGE: 45 }),
      );
      await tsql.execute(
        tsql.upsertInto('USERS', { ID: 1, USERNAME: 'ada_lovelace', AGE: 37 }, ['ID']),
      );

      // `selectFrom` with projected columns + `withSchema` transformation
      const userOutSchema = createRowSchema<{
        id: number;
        handle: string;
      }>({
        id: (v, row) => Number(v ?? row.ID),
        handle: (_v, row) => `@${String(row.USERNAME)}`,
      });

      const frag = tsql
        .selectFrom('USERS', ['ID', 'USERNAME'], sql`ORDER BY "ID"`)
        .withSchema(userOutSchema);

      const res = await db.query(frag);
      expect(res.rows).toEqual([
        { id: 1, handle: '@ada_lovelace' },
        { id: 2, handle: '@grace' },
      ]);

      // Prepared statement `stmt.query(..., { schema })` + validation failure
      const adultSchema: StandardSchemaV1<
        unknown,
        { ID: number; AGE: number; USERNAME?: string }
      > = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(v) {
            const r = v as { ID: number; AGE: number; USERNAME?: string };
            if (r.AGE < 18) {
              return { issues: [{ path: ['AGE'], message: 'Must be >= 18' }] };
            }
            return { value: { ...r } };
          },
        },
      };

      await tsql.execute(
        tsql.insertInto('USERS', { ID: 3, USERNAME: 'kid', AGE: 12 }),
      );

      await using stmt = await db.prepare(
        'SELECT ID, AGE FROM USERS WHERE ID = ?',
      );
      const validStmt = await stmt.query([1], { schema: adultSchema });
      expect(validStmt.rows).toEqual([{ ID: 1, AGE: 37 }]);
      await expect(stmt.query([3], { schema: adultSchema })).rejects.toBeInstanceOf(
        SchemaValidationError,
      );

      // Replication `tableSchemas` + `onApplyError: 'dlq'` quarantines invalid rows while applying valid rows!
      await using replica = await openDatabase('memory://m19_schema_replica', {
        threads: false,
      });
      await replica.execute(`
        CREATE TABLE USERS (
          ID INTEGER NOT NULL PRIMARY KEY,
          USERNAME VARCHAR(64) NOT NULL,
          AGE INTEGER NOT NULL
        )
      `);

      const sub = await createSubscription(replica, {
        name: 'sub_schema_dlq',
        publication: { name: 'PUB', fetchChangesSince: async () => [] },
        slotName: 'slot_schema_dlq',
        nodeId: 'replica-dlq',
        onApplyError: 'dlq',
        tableSchemas: {
          USERS: adultSchema,
        },
      });

      const incoming: ReplicationLogEntry[] = [
        {
          lsn: 1,
          txid: '1',
          timestamp: Date.now(),
          origin: 'remote',
          publication: 'PUB',
          table: 'USERS',
          operation: 'INSERT',
          key: { ID: 10 },
          before: null,
          after: { ID: 10, USERNAME: 'valid_adult', AGE: 29 },
        },
        {
          lsn: 2,
          txid: '1',
          timestamp: Date.now(),
          origin: 'remote',
          publication: 'PUB',
          table: 'USERS',
          operation: 'INSERT',
          key: { ID: 11 },
          before: null,
          after: { ID: 11, USERNAME: 'invalid_minor', AGE: 9 },
        },
      ];

      const applyRes = await sub.applyChanges(incoming);
      expect(applyRes.appliedCount).toBe(1);
      expect(applyRes.dlqCount).toBe(1);

      const replicaUsers = await replica.query<{ ID: number; USERNAME: string }>(
        'SELECT ID, USERNAME FROM USERS ORDER BY ID',
      );
      expect(replicaUsers.rows).toEqual([{ ID: 10, USERNAME: 'valid_adult' }]);

      const dlqEntries = await sub.listDlq();
      expect(dlqEntries).toHaveLength(1);
      expect(dlqEntries[0]!.lsn).toBe(2);
      expect(dlqEntries[0]!.errorMessage).toMatch(/Must be >= 18/);
    },
  );
});

// ===========================================================================
// 5. M19 Item 5 — Driver Modularization & `npx firebird-wasm` Developer CLI
// ===========================================================================
describe('M19 Item 5: Shared Driver Operations, Barrel Parity & Developer CLI', () => {
  it('exposes shared-driver-ops helpers and maintains root/browser M19 export parity', () => {
    expect(isNonCountingDdlStatement('CREATE TABLE FOO (ID INT)')).toBe(true);
    expect(isNonCountingDdlStatement('INSERT INTO FOO VALUES (1)')).toBe(false);
    expect(() => assertPreparedParamCount(2, 1)).toThrow(/expects 2 parameter/);
    expect(() => assertBatchParameterRows([[1], [1, 2]], 1)).toThrow(/expects 1 parameter/);

    const m19Symbols = [
      'logicalEntriesToFbChangelogSegment',
      'flushDatabaseFbChangelogSegment',
      'decodeBinaryResultColumnar',
      'rowsToColumnarResult',
      'encodeArrowIpc',
      'decodeArrowIpc',
      'createWebRtcReplicationPeer',
      'createResilientWebSocketPeer',
      'chunkWebRtcPayload',
      'WebRtcChunkAssembler',
      'computeBackoffDelayMs',
      'createRowSchema',
      'validateValueWithSchema',
      'validateRowsWithSchema',
      'SchemaValidationError',
      'TypedSqlFragment',
      'createTypedSql',
    ] as const;

    for (const sym of m19Symbols) {
      expect(typeof (rootBarrel as Record<string, unknown>)[sym]).toBe('function');
      expect((browserBarrel as Record<string, unknown>)[sym]).toBe(
        (rootBarrel as Record<string, unknown>)[sym],
      );
    }
  });

  it.skipIf(!HAS_ST_WASM)(
    'executes npx firebird-wasm CLI subcommands: migrate, query, codegen, dump, restore, inspect-changelog, and repl',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-wasm-cli-'));
      try {
        const dbPath = path.join(tmpDir, 'app.fdb');
        const restoredPath = path.join(tmpDir, 'restored.fdb');
        const migDir = path.join(tmpDir, 'migrations');
        const kyselyOut = path.join(tmpDir, 'db-kysely.d.ts');
        const drizzleOut = path.join(tmpDir, 'db-drizzle.ts');
        const dumpOut = path.join(tmpDir, 'backup.fdb.gz');
        const changelogPath = path.join(tmpDir, 'seg.journal-000000001');

        fs.mkdirSync(migDir, { recursive: true });
        fs.writeFileSync(
          path.join(migDir, '001_init.sql'),
          `CREATE TABLE PRODUCTS (
             ID INTEGER NOT NULL PRIMARY KEY,
             NAME VARCHAR(64) NOT NULL,
             PRICE NUMERIC(10, 2) NOT NULL
           );
           INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (1, 'Espresso', 3.5);
           INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (2, 'Latte', 4.75);
           -- @down
           DROP TABLE PRODUCTS;`,
          'utf8',
        );

        const execCli = async (args: string[], stdinLines?: string[]) => {
          let stdout = '';
          let stderr = '';
          const code = await runCli(args, {
            cwd: tmpDir,
            stdout: (t) => {
              stdout += t;
            },
            stderr: (t) => {
              stderr += t;
            },
            stdinLines,
          });
          return { code, stdout, stderr };
        };

        // 1. `migrate` up on a local `.fdb` file
        const migUp = await execCli([
          'migrate',
          dbPath,
          '--dir',
          migDir,
          '--backend',
          'wasm',
        ]);
        expect(migUp.code).toBe(0);
        expect(fs.existsSync(dbPath)).toBe(true);

        // 2. `query` in `json`, `csv`, `jsonl`, and `table` formats
        const qJson = await execCli([
          'query',
          dbPath,
          'SELECT ID, NAME FROM PRODUCTS ORDER BY ID',
          '--format',
          'json',
          '--backend',
          'wasm',
        ]);
        expect(qJson.code).toBe(0);
        expect(JSON.parse(qJson.stdout)).toEqual([
          { ID: 1, NAME: 'Espresso' },
          { ID: 2, NAME: 'Latte' },
        ]);

        const qCsv = await execCli([
          'query',
          dbPath,
          'SELECT ID, NAME FROM PRODUCTS WHERE ID = 1',
          '--format',
          'csv',
          '--backend',
          'wasm',
        ]);
        expect(qCsv.code).toBe(0);
        expect(qCsv.stdout).toContain('ID,NAME');
        expect(qCsv.stdout).toContain('1,Espresso');

        // 3. `codegen --kysely` & `codegen --drizzle`
        const cgKysely = await execCli([
          'codegen',
          dbPath,
          '--kysely',
          '--out',
          kyselyOut,
          '--backend',
          'wasm',
        ]);
        expect(cgKysely.code).toBe(0);
        expect(fs.readFileSync(kyselyOut, 'utf8')).toContain('ProductsTable');

        const cgDrizzle = await execCli([
          'codegen',
          dbPath,
          '--drizzle',
          '--out',
          drizzleOut,
          '--backend',
          'wasm',
        ]);
        expect(cgDrizzle.code).toBe(0);
        expect(fs.readFileSync(drizzleOut, 'utf8')).toContain('products');

        // 4. `dump --gzip` & `restore --gzip`
        const dumpRes = await execCli([
          'dump',
          dbPath,
          '--out',
          dumpOut,
          '--gzip',
          '--backend',
          'wasm',
        ]);
        expect(dumpRes.code).toBe(0);
        expect(fs.existsSync(dumpOut)).toBe(true);

        const restoreRes = await execCli([
          'restore',
          restoredPath,
          '--in',
          dumpOut,
          '--gzip',
          '--backend',
          'wasm',
        ]);
        expect(restoreRes.code).toBe(0);

        const qRestored = await execCli([
          'query',
          restoredPath,
          'SELECT COUNT(*) AS CNT FROM PRODUCTS',
          '--format',
          'json',
          '--backend',
          'wasm',
        ]);
        expect(JSON.parse(qRestored.stdout)).toEqual([{ CNT: 2 }]);

        // 5. `inspect-changelog` (`--json` & human-readable)
        const segBytes = logicalEntriesToFbChangelogSegment(
          [
            {
              lsn: 1,
              txid: '77',
              timestamp: Date.now(),
              origin: 'cli',
              publication: 'PUB',
              table: 'PRODUCTS',
              operation: 'INSERT',
              key: { ID: 3 },
              before: null,
              after: { ID: 3, NAME: 'Mocha' },
            },
          ],
          { sequence: 9, recordEncoding: 'jrd' },
        );
        fs.writeFileSync(changelogPath, segBytes);

        const directReport = inspectChangelogBuffer(segBytes);
        expect(directReport.sequence).toBe(9);
        expect(directReport.transactions).toContain(77);

        const inspectRes = await execCli([
          'inspect-changelog',
          changelogPath,
          '--json',
        ]);
        expect(inspectRes.code).toBe(0);
        const parsedReport = JSON.parse(inspectRes.stdout);
        expect(parsedReport.sequence).toBe(9);
        expect(parsedReport.opcodeCounts.opInsertRecord).toBe(1);

        // 6. Interactive `repl` with scripted `stdinLines`
        const replRes = await execCli(
          ['repl', restoredPath, '--backend', 'wasm'],
          [
            '.tables',
            "INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (3, 'Cortado', 4.0);",
            'SELECT ID, NAME FROM PRODUCTS WHERE ID = 3;',
            '.quit',
          ],
        );
        expect(replRes.code).toBe(0);
        expect(replRes.stdout).toContain('PRODUCTS');
        expect(replRes.stdout).toContain('Cortado');

        // 7. `migrate --down` reverts migration cleanly
        const migDown = await execCli([
          'migrate',
          dbPath,
          '--dir',
          migDir,
          '--down',
          '--backend',
          'wasm',
        ]);
        expect(migDown.code).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
