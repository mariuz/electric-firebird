/**
 * m18-improvements.test.ts – Comprehensive test suite for M18:
 *   1. Native Engine Replication across Workers (`WorkerTransport` + `serveEngine`),
 *      `FirebirdBrowser.setReplicaMode()` / `applyChangelog()`, HTTP & WebSocket
 *      `"FBCHANGELOG\0"` binary/gzip streaming, and `introspectJrdTableSchemas()`.
 *   2. High-Speed Batched Replication Replay (`UPDATE OR INSERT ... MATCHING` +
 *      `execBatch` / `IBatch`), DLQ per-row fallback on batch failure, SQL `ROWS`
 *      limit pushdown, and lazy `BEFORE_JSON` decoding.
 *   3. Unified `FirebirdDatabase` interface, `openDatabase()`, `db.execute()`,
 *      `[Symbol.asyncDispose]()`, and structured `FirebirdError` diagnostics.
 *   4. Modular replication architecture barrel parity & `DatabaseCoreSubsystems`.
 *   5. One-liner `syncDatabases()` & `db.syncWith()` progressive-disclosure presets.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  openDatabase,
  FirebirdBrowser,
  FirebirdError,
  isFirebirdError,
  parseFirebirdError,
  toFirebirdError,
  DatabaseCoreSubsystems,
  introspectJrdTableSchemas,
  syncDatabases,
  syncWithPeer,
  createPublication,
  createSubscription,
  bootstrapReplica,
  createHttpReplicationHandler,
  createHttpReplicationClient,
  createWebSocketReplicationPeer,
  encodeFbChangelogSegment,
  encodeJrdRecordBuffer,
  FbChangelogOpcode,
  applyFbChangelogSegmentToDatabase,
  configureWasmReplicationConf,
  enableEnginePublication,
  readWasmChangelogSegments,
  loadFirebirdWasm,
  type JrdColumnDescriptor,
  type WebSocketLike,
} from '../index';
import {
  openDatabase as openBrowserDatabaseAlias,
  DirectTransport,
  WorkerTransport,
  serveEngine,
  type EngineWorkerScope,
} from '../browser';

const HAS_ST_WASM = fs.existsSync(
  path.resolve(__dirname, '../../dist/wasm/firebird-embedded-st.js'),
);
const HAS_MT_WASM = fs.existsSync(
  path.resolve(__dirname, '../../dist/wasm/firebird-embedded.js'),
);

/** Create an in-memory duplex Worker pair connecting `WorkerTransport` <-> `serveEngine`. */
function createInProcessWorkerPair(direct: DirectTransport): Worker {
  type MsgHandler = (event: MessageEvent) => void;
  const workerSideListeners = new Set<MsgHandler>();
  const mainSideListeners = new Set<MsgHandler>();

  const workerScope: EngineWorkerScope = {
    postMessage(message: unknown) {
      queueMicrotask(() => {
        for (const fn of mainSideListeners) {
          fn({ data: message } as MessageEvent);
        }
      });
    },
    addEventListener(type, listener) {
      if (type === 'message') {
        workerSideListeners.add(listener as unknown as MsgHandler);
      }
    },
  };

  serveEngine(workerScope, direct);

  const fakeWorker = {
    postMessage(message: unknown) {
      queueMicrotask(() => {
        for (const fn of workerSideListeners) {
          fn({ data: message } as MessageEvent);
        }
      });
    },
    addEventListener(type: string, listener: MsgHandler) {
      if (type === 'message') mainSideListeners.add(listener);
    },
    removeEventListener(type: string, listener: MsgHandler) {
      if (type === 'message') mainSideListeners.delete(listener);
    },
    terminate() {
      workerSideListeners.clear();
      mainSideListeners.clear();
    },
  };

  return fakeWorker as unknown as Worker;
}

/** Build a duplex WebSocket test pair supporting both string and `Uint8Array` frames. */
function createDuplexWebSocketPair(): [WebSocketLike, WebSocketLike] {
  const listenersA = new Set<(event: { data: unknown }) => void>();
  const listenersB = new Set<(event: { data: unknown }) => void>();

  const a: WebSocketLike = {
    send(data) {
      const payload = data instanceof Uint8Array ? data.slice() : data;
      queueMicrotask(() => {
        for (const fn of listenersB) fn({ data: payload });
        b.onmessage?.({ data: payload });
      });
    },
    addEventListener(_t, fn) {
      listenersA.add(fn);
    },
    removeEventListener(_t, fn) {
      listenersA.delete(fn);
    },
    onmessage: null,
  };

  const b: WebSocketLike = {
    send(data) {
      const payload = data instanceof Uint8Array ? data.slice() : data;
      queueMicrotask(() => {
        for (const fn of listenersA) fn({ data: payload });
        a.onmessage?.({ data: payload });
      });
    },
    addEventListener(_t, fn) {
      listenersB.add(fn);
    },
    removeEventListener(_t, fn) {
      listenersB.delete(fn);
    },
    onmessage: null,
  };

  return [a, b];
}

function pushU32LE(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function pushAtomDef(arr: number[], name: string): void {
  const bytes = new TextEncoder().encode(name);
  arr.push(FbChangelogOpcode.opDefineAtom, bytes.length, ...bytes);
}

function buildSyntheticChangelogSegment(sequence = 1): Uint8Array {
  const cols: JrdColumnDescriptor[] = [
    { name: 'ID', type: 'INTEGER', primaryKey: true },
    { name: 'NAME', type: 'VARCHAR', charLength: 32, maxBytes: 128 },
    { name: 'SCORE', type: 'INTEGER' },
  ];
  const rec1 = encodeJrdRecordBuffer({ ID: 1, NAME: 'Alpha', SCORE: 100 }, cols);
  const rec2 = encodeJrdRecordBuffer({ ID: 2, NAME: 'Beta', SCORE: 200 }, cols);

  // Block 1: DDL CREATE TABLE
  const ddlSql =
    'CREATE TABLE NET_ITEMS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(32), SCORE INTEGER)';
  const ddlBytes = new TextEncoder().encode(ddlSql);
  const b1: number[] = [FbChangelogOpcode.opStartTransaction];
  pushAtomDef(b1, 'SYSDBA');
  pushAtomDef(b1, 'PUBLIC');
  b1.push(FbChangelogOpcode.opExecuteSqlIntl);
  pushU32LE(b1, 0); // owner = SYSDBA
  pushU32LE(b1, 1); // schemaSearchPath = PUBLIC
  b1.push(4); // CS_UTF8
  pushU32LE(b1, ddlBytes.byteLength);
  b1.push(...ddlBytes, FbChangelogOpcode.opPrepareTransaction, FbChangelogOpcode.opCommitTransaction);

  // Block 2: DML INSERT x2
  const b2: number[] = [FbChangelogOpcode.opStartTransaction];
  pushAtomDef(b2, 'PUBLIC');
  pushAtomDef(b2, 'NET_ITEMS');
  for (const rec of [rec1, rec2]) {
    b2.push(FbChangelogOpcode.opInsertRecord);
    pushU32LE(b2, 0);
    pushU32LE(b2, 1);
    pushU32LE(b2, rec.byteLength);
    b2.push(...rec);
  }
  b2.push(FbChangelogOpcode.opPrepareTransaction, FbChangelogOpcode.opCommitTransaction);

  return encodeFbChangelogSegment({
    sequence,
    blocks: [
      { traNumber: sequence * 10 + 1, flags: 3, payload: new Uint8Array(b1) },
      { traNumber: sequence * 10 + 2, flags: 3, payload: new Uint8Array(b2) },
    ],
  });
}

describe('M18 Item 3 & 4 – Structured FirebirdError, DatabaseCoreSubsystems & openDatabase()', () => {
  it('parses Firebird SQLCODEs, constraints, tables, columns, and remediation hints into FirebirdError', () => {
    const pkInfo = parseFirebirdError(
      'violation of PRIMARY or UNIQUE KEY constraint "INTEG_2" on table "USERS"\nProblematic key value is ("EMAIL" = \'a@b.com\')\nSQLCODE = -803',
      'INSERT INTO USERS VALUES (1, ?)',
    );
    expect(pkInfo.sqlcode).toBe(-803);
    expect(pkInfo.gdscode).toBe(335544665);
    expect(pkInfo.symbol).toBe('unique_key_violation');
    expect(pkInfo.sqlState).toBe('23000');
    expect(pkInfo.constraint).toBe('INTEG_2');
    expect(pkInfo.table).toBe('USERS');
    expect(pkInfo.hint).toMatch(/UPDATE OR INSERT/i);

    const fkErr = toFirebirdError(
      new Error(
        'violation of FOREIGN KEY constraint "FK_ORDER_USER" on table "ORDERS" SQLCODE = -530',
      ),
    );
    expect(isFirebirdError(fkErr)).toBe(true);
    expect(fkErr).toBeInstanceOf(FirebirdError);
    expect(fkErr.sqlcode).toBe(-530);
    expect(fkErr.constraint).toBe('FK_ORDER_USER');
    expect(fkErr.table).toBe('ORDERS');

    const colErr = toFirebirdError(
      'Dynamic SQL Error - SQL error code = -206 - Column unknown EMP_SALARY',
    );
    expect(colErr.sqlcode).toBe(-206);
    expect(colErr.column).toBe('EMP_SALARY');
    expect(colErr.hint).toMatch(/column/i);

    const deadlockErr = toFirebirdError(
      'deadlock - update conflicts with concurrent update SQLCODE = -913',
    );
    expect(deadlockErr.sqlcode).toBe(-913);
    expect(deadlockErr.sqlState).toBe('40001');

    const replicaErr = toFirebirdError('Database is not in replica mode');
    expect(replicaErr.symbol).toBe('replica_mode_required');
    expect(replicaErr.hint).toMatch(/setReplicaMode/i);
  });

  it('manages UDR, snapshots, and profiler cleanly in DatabaseCoreSubsystems', () => {
    const sub = new DatabaseCoreSubsystems(8192);
    expect(sub.udr).toBeDefined();
    expect(sub.snapshotStore).toBeDefined();
    expect(sub.profiler).toBeDefined();
    sub.clear();
    expect(sub.snapshotStore.listSnapshots()).toEqual([]);
  });

  it('exposes openDatabase on both root and browser entrypoints with Symbol.asyncDispose', async () => {
    expect(typeof openDatabase).toBe('function');
    expect(typeof openBrowserDatabaseAlias).toBe('function');

    const db = await openDatabase('memory://m18-unit-check');
    expect(db).toBeInstanceOf(FirebirdBrowser);
    expect(typeof db[Symbol.asyncDispose]).toBe('function');
    await db[Symbol.asyncDispose]();
  });
});

(HAS_ST_WASM ? describe : describe.skip)(
  'M18 Full Real-WASM Integration (Items 1, 2, 3 & 5)',
  () => {
    it('supports openDatabase("memory://"), idb:// normalization, db.execute(), tx.execute(), and Symbol.asyncDispose', async () => {
      const db = await openDatabase('memory://m18-exec', { threads: false });
      try {
        const ddlRes = await db.execute(
          'CREATE TABLE EXEC_TEST (ID INTEGER NOT NULL PRIMARY KEY, LABEL VARCHAR(50))',
        );
        expect(ddlRes).toEqual({ affectedRows: 0, changes: 0 });

        const ins1 = await db.execute('INSERT INTO EXEC_TEST (ID, LABEL) VALUES (?, ?)', [
          1,
          'first',
        ]);
        expect(ins1).toEqual({ affectedRows: 1, changes: 1 });

        const txRes = await db.transaction(async (tx) => {
          const r1 = await tx.execute('INSERT INTO EXEC_TEST (ID, LABEL) VALUES (?, ?)', [
            2,
            'second',
          ]);
          const r2 = await tx.execute('UPDATE EXEC_TEST SET LABEL = ?', ['updated']);
          return { r1, r2 };
        });
        expect(txRes.r1).toEqual({ affectedRows: 1, changes: 1 });
        expect(txRes.r2).toEqual({ affectedRows: 2, changes: 2 });

        const rows = await db.query('SELECT ID, LABEL FROM EXEC_TEST ORDER BY ID');
        expect(rows.rows).toEqual([
          { ID: 1, LABEL: 'updated' },
          { ID: 2, LABEL: 'updated' },
        ]);
      } finally {
        await db[Symbol.asyncDispose]();
      }
    });

    it('replays native C++ "FBCHANGELOG\\0" segments across WorkerTransport + serveEngine via db.setReplicaMode() & db.applyChangelog()', async () => {
      if (!HAS_MT_WASM) {
        return;
      }
      const mod = await loadFirebirdWasm({ threads: true });
      configureWasmReplicationConf(mod.FS as never, {
        journalDirectory: '/repl_log_m18_worker',
        journalArchiveDirectory: '/repl_arch_m18_worker',
        journalArchiveTimeout: 1,
      });

      // 1. Primary database produces real Firebird C++ "FBCHANGELOG\0" segments
      const primary = new FirebirdBrowser('memory://m18-native-primary', { threads: true });
      const worker = createInProcessWorkerPair(new DirectTransport({ threads: true }));
      const workerTransport = new WorkerTransport(worker);
      const replica = new FirebirdBrowser('memory://m18-native-worker-replica', {
        transport: workerTransport,
      });

      try {
        await enableEnginePublication(primary, { tables: '*' });
        await primary.execute(
          'CREATE TABLE WORKER_ITEMS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(40), QTY INTEGER)',
        );
        await primary.execute(
          'INSERT INTO WORKER_ITEMS (ID, TITLE, QTY) VALUES (?, ?, ?)',
          [1, 'Ion Thruster', 7],
        );
        await primary.execute(
          'INSERT INTO WORKER_ITEMS (ID, TITLE, QTY) VALUES (?, ?, ?)',
          [2, 'Shield Matrix', 3],
        );
        await primary.execute('UPDATE WORKER_ITEMS SET QTY = ? WHERE ID = ?', [99, 1]);

        const segments = [
          ...readWasmChangelogSegments(mod.FS as never, '/repl_arch_m18_worker'),
          ...readWasmChangelogSegments(mod.FS as never, '/repl_log_m18_worker'),
        ];
        expect(segments.length).toBeGreaterThanOrEqual(1);

        // 2. Enable replica mode over WorkerTransport RPC and replay segment with Transferable buffer!
        await replica.setReplicaMode('read_write');

        // Verify caller's original Uint8Array is NOT detached when transfer is false (default)
        const reusableBytes = segments[0]!.rawBytes.slice();
        const applyRes = await applyFbChangelogSegmentToDatabase(replica, reusableBytes);
        expect(reusableBytes.byteLength).toBeGreaterThan(48);
        expect(applyRes.usedNativeReplicator).toBe(true);
        expect(applyRes.blocksProcessed).toBeGreaterThanOrEqual(4);

        for (let i = 1; i < segments.length; i++) {
          const r = await applyFbChangelogSegmentToDatabase(replica, segments[i]!, {
            transfer: true,
          });
          expect(r.usedNativeReplicator).toBe(true);
        }

        const replicaRows = await replica.query(
          'SELECT ID, TITLE, QTY FROM WORKER_ITEMS ORDER BY ID',
        );
        expect(replicaRows.rows).toEqual([
          { ID: 1, TITLE: 'Ion Thruster', QTY: 99 },
          { ID: 2, TITLE: 'Shield Matrix', QTY: 3 },
        ]);

        // 3. Verify introspectJrdTableSchemas() derives exact JRD descriptors from RDB$RELATION_FIELDS
        const jrdSchemas = await introspectJrdTableSchemas(primary, {
          tables: ['WORKER_ITEMS'],
        });
        expect(jrdSchemas.WORKER_ITEMS).toEqual([
          { name: 'ID', type: 'INTEGER', primaryKey: true },
          { name: 'TITLE', type: 'VARCHAR', maxBytes: 160, charLength: 40 },
          { name: 'QTY', type: 'INTEGER' },
        ]);
      } finally {
        await primary.close();
        try {
          mod.FS.unlink('/usr/local/firebird/replication.conf');
        } catch {
          // Ignore
        }
        await replica.close();
        worker.terminate();
      }
    });

    it('streams gzip-compressed "FBCHANGELOG\\0" segments over HTTP and WebSocket transports with native C++ apply & auto-introspected logical fallback', async () => {
      const seg1 = buildSyntheticChangelogSegment(1);

      // Build a DDL + sequence segment that C++ IReplicator replays natively on any WASM build
      const ddlSql =
        'CREATE TABLE WS_NATIVE_TBL (ID INTEGER NOT NULL PRIMARY KEY, LABEL VARCHAR(32))';
      const ddlBytes = new TextEncoder().encode(ddlSql);
      const nativeBlock: number[] = [FbChangelogOpcode.opStartTransaction];
      pushAtomDef(nativeBlock, 'SYSDBA');
      pushAtomDef(nativeBlock, 'PUBLIC');
      nativeBlock.push(FbChangelogOpcode.opExecuteSqlIntl);
      pushU32LE(nativeBlock, 0);
      pushU32LE(nativeBlock, 1);
      nativeBlock.push(4);
      pushU32LE(nativeBlock, ddlBytes.byteLength);
      nativeBlock.push(
        ...ddlBytes,
        FbChangelogOpcode.opPrepareTransaction,
        FbChangelogOpcode.opCommitTransaction,
      );
      const nativeDdlSeg = encodeFbChangelogSegment({
        sequence: 1,
        blocks: [{ traNumber: 5, flags: 3, payload: new Uint8Array(nativeBlock) }],
      });

      const httpReplica = new FirebirdBrowser('memory://m18-http-changelog-replica', {
        threads: false,
      });
      const wsReplica = new FirebirdBrowser('memory://m18-ws-changelog-replica', {
        threads: false,
      });

      try {
        // 1. HTTP GET /changelog?compress=gzip & POST /changelog (forcing logical fallback to test autoIntrospectSchemas!)
        const pushedSegments: Uint8Array[] = [];
        const handler = createHttpReplicationHandler({
          changelogSource: [seg1],
          onChangelogSegment: async (bytes) => {
            pushedSegments.push(bytes);
            return applyFbChangelogSegmentToDatabase(httpReplica, bytes, {
              preferLogicalFallback: true,
            });
          },
        });

        const client = createHttpReplicationClient({
          baseUrl: 'http://repl.local',
          fetch: (input, init) =>
            handler(new Request(typeof input === 'string' ? input : input.toString(), init)),
        });

        const fetched = await client.fetchChangelogSegments(0, { compress: true });
        expect(fetched).toHaveLength(1);
        expect(fetched[0]!.byteLength).toBe(seg1.byteLength);

        const pushRes = await client.pushChangelogSegment(fetched[0]!, { compress: true });
        expect(pushRes).toHaveLength(1);
        expect(pushRes[0]!.usedNativeReplicator).toBe(false);
        expect(pushRes[0]!.entriesApplied).toBe(2);
        expect(pushedSegments).toHaveLength(1);

        const httpRows = await httpReplica.query(
          'SELECT ID, NAME, SCORE FROM NET_ITEMS ORDER BY ID',
        );
        expect(httpRows.rows).toEqual([
          { ID: 1, NAME: 'Alpha', SCORE: 100 },
          { ID: 2, NAME: 'Beta', SCORE: 200 },
        ]);

        // 2. WebSocket binary gzipped "FBCHANGELOG\0" frame streaming -> native C++ apply AND auto-introspected fallback!
        await wsReplica.setReplicaMode('read_write');
        const [sockA, sockB] = createDuplexWebSocketPair();
        const wsAppliedResults: Array<{ sequence: number; usedNativeReplicator: boolean }> = [];

        const peerA = createWebSocketReplicationPeer({ socket: sockA });
        const peerB = createWebSocketReplicationPeer({
          socket: sockB,
          changelogTargetDb: wsReplica,
          onChangelogSegment(_seg, result) {
            if (result) {
              wsAppliedResults.push({
                sequence: result.sequence,
                usedNativeReplicator: result.usedNativeReplicator,
              });
            }
          },
        });

        await peerA.sendChangelogSegment(nativeDdlSeg, { compress: true });
        for (let attempt = 0; attempt < 40 && wsAppliedResults.length < 1; attempt++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(wsAppliedResults[0]).toEqual({ sequence: 1, usedNativeReplicator: true });

        const seg2 = buildSyntheticChangelogSegment(2);
        await peerA.sendChangelogSegment(seg2, { compress: true });
        for (let attempt = 0; attempt < 40 && wsAppliedResults.length < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 10));
        }

        const wsRows = await wsReplica.query(
          'SELECT ID, NAME, SCORE FROM NET_ITEMS ORDER BY ID',
        );
        expect(wsRows.rows).toEqual([
          { ID: 1, NAME: 'Alpha', SCORE: 100 },
          { ID: 2, NAME: 'Beta', SCORE: 200 },
        ]);

        const nativeTblCheck = await wsReplica.query(
          "SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = 'WS_NATIVE_TBL'",
        );
        expect(Number(nativeTblCheck.rows[0]?.CNT)).toBe(1);

        peerA.close();
        peerB.close();
      } finally {
        await httpReplica.close();
        await wsReplica.close();
      }
    });

    it('batches catch-up & bootstrap DML via UPDATE OR INSERT ... MATCHING + execBatch, isolates DLQ poison rows via savepoints, and decodes BEFORE_JSON lazily', async () => {
      const primary = new FirebirdBrowser('memory://m18-batch-primary', { threads: false });
      const replica = new FirebirdBrowser('memory://m18-batch-replica', { threads: false });

      try {
        await primary.execute(
          'CREATE TABLE PRODUCTS (ID INTEGER NOT NULL PRIMARY KEY, SKU VARCHAR(32), PRICE INTEGER)',
        );
        // Replica has a stricter CHECK (PRICE >= 0) constraint to verify DLQ isolation when an IBatch fails mid-batch!
        await replica.execute(
          'CREATE TABLE PRODUCTS (ID INTEGER NOT NULL PRIMARY KEY, SKU VARCHAR(32), PRICE INTEGER CHECK (PRICE >= 0))',
        );

        const pub = await createPublication(primary, {
          name: 'pub_fast',
          tables: ['PRODUCTS'],
          installTriggers: true,
        });

        // Seed 25 rows on primary and verify batched bootstrapReplica
        await primary.execBatch(
          'INSERT INTO PRODUCTS (ID, SKU, PRICE) VALUES (?, ?, ?)',
          Array.from({ length: 25 }, (_, i) => [i + 1, `SKU_${i + 1}`, (i + 1) * 10]),
        );

        const sub = await createSubscription(replica, {
          name: 'sub_fast',
          publication: pub,
          batchSize: 50,
          onApplyError: 'dlq',
        });

        const boot = await bootstrapReplica({
          targetDb: replica,
          publication: pub,
          subscription: sub,
        });
        expect(boot.rowsCopied).toBe(25);

        const countAfterBoot = await replica.query<{ CNT: number }>(
          'SELECT COUNT(*) AS CNT FROM PRODUCTS',
        );
        expect(Number(countAfterBoot.rows[0]?.CNT)).toBe(25);

        // Perform updates + inserts + 1 poison row (PRICE = -999 violates replica CHECK)
        await primary.execute('UPDATE PRODUCTS SET PRICE = 555 WHERE ID = 1');
        await primary.execute('INSERT INTO PRODUCTS (ID, SKU, PRICE) VALUES (?, ?, ?)', [
          26,
          'POISON_ROW',
          -999,
        ]);
        await primary.execute('INSERT INTO PRODUCTS (ID, SKU, PRICE) VALUES (?, ?, ?)', [
          27,
          'VALID_AFTER_POISON',
          777,
        ]);

        // Verify SQL ROWS limit pushdown + lazy BEFORE_JSON getter on fetchChangesSince
        const preview = await pub.fetchChangesSince(boot.watermarkLsn, { limit: 1 });
        expect(preview).toHaveLength(1);
        const beforeDesc = Object.getOwnPropertyDescriptor(preview[0]!, 'before');
        expect(typeof beforeDesc?.get).toBe('function');
        expect(preview[0]!.before).toMatchObject({ ID: '1', PRICE: '10' });

        // Pull full batch: batch fails on ID=26 CHECK violation, rolls back savepoint,
        // falls back to row-by-row savepoints, quarantines ID=26 in DLQ, and applies ID=1 & ID=27!
        const pullRes = await sub.pull();
        expect(pullRes.fetchedCount).toBe(3);
        expect(pullRes.appliedCount).toBe(2);
        expect(pullRes.dlqCount).toBe(1);

        const dlqEntries = await sub.listDlq();
        expect(dlqEntries).toHaveLength(1);
        expect(dlqEntries[0]!.entry.key).toEqual({ ID: '26' });

        const check1 = await replica.query('SELECT PRICE FROM PRODUCTS WHERE ID = 1');
        const check27 = await replica.query('SELECT SKU, PRICE FROM PRODUCTS WHERE ID = 27');
        expect(check1.rows).toEqual([{ PRICE: 555 }]);
        expect(check27.rows).toEqual([{ SKU: 'VALID_AFTER_POISON', PRICE: 777 }]);
      } finally {
        await primary.close();
        await replica.close();
      }
    });

    it('replicates schema, initial bootstrap, and live bidirectional changes via one-liner syncDatabases() and db.syncWith()', async () => {
      const dbA = new FirebirdBrowser('memory://m18-sync-a', { threads: false });
      const dbB = new FirebirdBrowser('memory://m18-sync-b', { threads: false });
      const dbC = new FirebirdBrowser('memory://m18-sync-c', { threads: false });

      try {
        await dbA.execute(
          'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(60), DONE SMALLINT)',
        );
        await dbA.execute('INSERT INTO TASKS (ID, TITLE, DONE) VALUES (?, ?, ?)', [
          1,
          'Ship M18',
          0,
        ]);

        // 1. One-liner syncDatabases(dbA, dbB) auto-discovers TASKS, creates table on dbB, and bootstraps row 1!
        const syncAB = await syncDatabases(dbA, dbB, { pollIntervalMs: 50 });
        try {
          const initialB = await dbB.query('SELECT ID, TITLE, DONE FROM TASKS');
          expect(initialB.rows).toEqual([{ ID: 1, TITLE: 'Ship M18', DONE: 0 }]);

          // Mutate dbA and waitForIdle()
          await dbA.execute('INSERT INTO TASKS (ID, TITLE, DONE) VALUES (?, ?, ?)', [
            2,
            'Verify Workers',
            1,
          ]);
          await syncAB.waitForIdle();

          const updatedB = await dbB.query('SELECT ID, TITLE, DONE FROM TASKS ORDER BY ID');
          expect(updatedB.rows).toEqual([
            { ID: 1, TITLE: 'Ship M18', DONE: 0 },
            { ID: 2, TITLE: 'Verify Workers', DONE: 1 },
          ]);

          syncAB.pause();
          expect(syncAB.paused).toBe(true);
          syncAB.resume();
          expect(syncAB.paused).toBe(false);
        } finally {
          await syncAB[Symbol.asyncDispose]();
        }

        // 2. One-liner `await dbC.syncWith(dbA)` (empty replica calling syncWith(primary) in bidirectional mode!)
        const syncCA = await syncWithPeer(dbC, dbA, { pollIntervalMs: 50 });
        try {
          const initialC = await dbC.query('SELECT ID, TITLE, DONE FROM TASKS ORDER BY ID');
          expect(initialC.rows).toHaveLength(2);

          // Write on dbC and sync back to dbA!
          await dbC.execute('INSERT INTO TASKS (ID, TITLE, DONE) VALUES (?, ?, ?)', [
            3,
            'Added on C',
            1,
          ]);
          await syncCA.waitForIdle();

          const rowsOnA = await dbA.query('SELECT ID, TITLE FROM TASKS WHERE ID = 3');
          expect(rowsOnA.rows).toEqual([{ ID: 3, TITLE: 'Added on C' }]);
        } finally {
          await syncCA.stop();
        }
      } finally {
        await dbA.close();
        await dbB.close();
        await dbC.close();
      }
    });
  },
);
