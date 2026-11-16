/**
 * m21-features.test.ts – Comprehensive integration tests for M21:
 *   1. Read/Write Replica Router (`createReplicaRouter`) with causal `read-your-writes`
 *      fencing, load-balancing, automatic failover promotion & Object-Store checkpoint rotation
 *   2. Streaming Columnar & Apache Arrow IPC V5 cursors (`queryColumnarStream`, `queryArrowStream`,
 *      multi-batch `decodeArrowIpcBatches` / `decodeArrowIpc`) & `db.preparePipeline()`
 *   3. Zero-boilerplate Typed Table & Upsert API (`db.table<T>()`, keyset `findPage`, `upsertMany`)
 *   4. CLI `sync`, `wal-ship`, `pitr-restore`, and `bench` subcommands (`runCli`)
 *   5. Modular decomposition export parity (`engine-transport`, `native-changelog`, `repl`)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  collectArrowStreamBytes,
  concatColumnarResults,
  createMemoryObjectStoreAdapter,
  createObjectStoreReplicationTarget,
  createPublication,
  createReplicaRouter,
  createRowSchema,
  decodeArrowIpc,
  decodeArrowIpcBatches,
  isReadOnlySqlStatement,
  openDatabase,
  restoreDatabaseToPointInTime,
  syncDatabases,
} from '../index';
import * as rootExports from '../index';
import * as browserExports from '../browser';
import {
  DirectTransport,
  FirebirdBrowser,
  serveEngine,
  WorkerTransport,
  type EngineWorkerScope,
} from '../browser';
import { runCli } from '../cli';
import type { ReplicableDatabase } from '../replication';

function createInProcessWorkerPair(): {
  workerTransport: WorkerTransport;
  directTransport: DirectTransport;
  sentMessages: unknown[];
} {
  const directTransport = new DirectTransport({ threads: false });
  const workerListeners = new Set<(ev: MessageEvent) => void>();
  const mainListeners = new Set<(ev: MessageEvent) => void>();
  const sentMessages: unknown[] = [];

  const scope: EngineWorkerScope = {
    postMessage(message: unknown) {
      const ev = { data: message } as MessageEvent;
      for (const fn of mainListeners) fn(ev);
    },
    addEventListener(_type: 'message', listener: (ev: MessageEvent) => void) {
      workerListeners.add(listener);
    },
  };

  serveEngine(scope, directTransport);

  const fakeWorker = {
    postMessage(message: unknown) {
      sentMessages.push(message);
      const ev = { data: message } as MessageEvent;
      for (const fn of workerListeners) fn(ev);
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'message' && typeof listener === 'function') {
        mainListeners.add(listener as (ev: MessageEvent) => void);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'message' && typeof listener === 'function') {
        mainListeners.delete(listener as (ev: MessageEvent) => void);
      }
    },
    terminate() {
      workerListeners.clear();
      mainListeners.clear();
    },
  } as unknown as Worker;

  return {
    workerTransport: new WorkerTransport(fakeWorker),
    directTransport,
    sentMessages,
  };
}

describe('M21 Item 1: Read/Write Replica Router & Object-Store Checkpoint Rotation', () => {
  it('classifies read-only vs mutating SQL statements accurately', () => {
    expect(isReadOnlySqlStatement('SELECT id, name FROM users WHERE id = 1')).toBe(true);
    expect(isReadOnlySqlStatement('  /* comment */\n WITH cte AS (SELECT 1 AS x FROM RDB$DATABASE) SELECT x FROM cte')).toBe(true);
    expect(isReadOnlySqlStatement('INSERT INTO users (id) VALUES (1) RETURNING id')).toBe(false);
    expect(isReadOnlySqlStatement('SELECT id FROM users WITH LOCK')).toBe(false);
    expect(isReadOnlySqlStatement('SELECT id FROM users FOR UPDATE')).toBe(false);
    expect(isReadOnlySqlStatement('UPDATE users SET name = ? WHERE id = ?')).toBe(false);
  });

  it(
    'routes writes to primary, enforces causal read-your-writes fencing across replicas, falls back on lag timeout, and auto-promotes on primary outage',
    async () => {
      const primary = await openDatabase('memory://m21_router_primary');
      const replica1 = await openDatabase('memory://m21_router_r1');
      const replica2 = await openDatabase('memory://m21_router_r2');

      await primary.execute(
        'CREATE TABLE ORDERS (ID INTEGER NOT NULL PRIMARY KEY, ITEM VARCHAR(64), QTY INTEGER)',
      );
      await primary.execute('INSERT INTO ORDERS (ID, ITEM, QTY) VALUES (?, ?, ?)', [1, 'Keyboard', 2]);

      const sync1 = await syncDatabases(
        primary as unknown as ReplicableDatabase,
        replica1 as unknown as ReplicableDatabase,
        { live: false, installTriggers: true },
      );
      const sync2 = await syncDatabases(
        primary as unknown as ReplicableDatabase,
        replica2 as unknown as ReplicableDatabase,
        { live: false, installTriggers: true },
      );

      let failoverEvents = 0;
      const router = createReplicaRouter({
        primary,
        replicas: [replica1, replica2],
        syncHandles: [sync1, sync2],
        consistency: 'read-your-writes',
        consistencyTimeoutMs: 1500,
        failover: {
          autoPromote: true,
          onFailover: () => {
            failoverEvents++;
          },
        },
      });

      // Write via router -> automatically routes to primary and advances sessionMinLsn!
      await router.execute('INSERT INTO ORDERS (ID, ITEM, QTY) VALUES (?, ?, ?)', [2, 'Monitor', 1]);
      expect(router.sessionMinLsn).toBeGreaterThan(0);

      // Immediate read via router -> triggers causal catch-up sync and serves fresh data from replica!
      const read1 = await router.query<{ ID: number; ITEM: string }>(
        'SELECT ID, ITEM FROM ORDERS ORDER BY ID',
      );
      expect(read1.rows.map((r) => r.ITEM)).toEqual(['Keyboard', 'Monitor']);

      // Second read hits replica2 via round-robin
      const read2 = await router.query<{ ID: number; ITEM: string }>(
        'SELECT ID, ITEM FROM ORDERS WHERE ID = ?',
        [2],
      );
      expect(read2.rows[0]?.ITEM).toBe('Monitor');

      const stats1 = router.routerStats();
      expect(stats1.writesRoutedToPrimary).toBe(1);
      expect(stats1.readsRoutedToReplicas).toBe(2);
      expect(stats1.causalCatchUpSyncs).toBeGreaterThanOrEqual(1);

      // Test primary fallback when sessionMinLsn is artificially ahead of any replica
      router.advanceSessionLsn(999_999);
      const fallbackRouter = createReplicaRouter({
        primary,
        replicas: [replica1],
        consistency: 'read-your-writes',
        consistencyTimeoutMs: 30,
      });
      fallbackRouter.advanceSessionLsn(999_999);
      const fbRead = await fallbackRouter.query('SELECT COUNT(*) AS CNT FROM ORDERS');
      expect(Number(fbRead.rows[0]?.CNT)).toBe(2);
      expect(fallbackRouter.routerStats().causalPrimaryFallbacks).toBe(1);

      // Simulate primary failure by closing primary -> router auto-promotes freshest replica and completes write!
      await sync1.stop();
      await sync2.stop();
      await primary.close();

      await router.execute('INSERT INTO ORDERS (ID, ITEM, QTY) VALUES (?, ?, ?)', [3, 'Mouse', 4]);
      expect(failoverEvents).toBe(1);
      expect(router.routerStats().failoversCompleted).toBe(1);

      const postFailover = await router.primary.query('SELECT COUNT(*) AS CNT FROM ORDERS');
      expect(Number(postFailover.rows[0]?.CNT)).toBe(3);

      await replica1.close();
      await replica2.close();
    },
    30_000,
  );

  it(
    'rotates checkpoints automatically every N WAL segments and prunes superseded object-store segments',
    async () => {
      const db = await openDatabase('memory://m21_wal_rotate');
      await db.execute('CREATE TABLE LOGS (ID INTEGER NOT NULL PRIMARY KEY, MSG VARCHAR(64))');

      const pub = await createPublication(db as unknown as ReplicableDatabase, {
        name: 'pub_rotate',
        tables: ['LOGS'],
        installTriggers: true,
      });
      const store = createMemoryObjectStoreAdapter();
      const wal = await createObjectStoreReplicationTarget({
        db: db as unknown as ReplicableDatabase,
        store,
        publication: pub,
        checkpointMode: 'logical',
        checkpointEverySegments: 2,
        autoPruneBeforeCheckpoint: true,
        maxEntriesPerSegment: 1,
      });

      await db.execute('INSERT INTO LOGS VALUES (?, ?)', [1, 'first']);
      await wal.shipWalOnce();
      let manifest = await wal.getManifest();
      expect(manifest.checkpoints.length).toBe(0);
      expect(manifest.segments.length).toBe(1);

      // 2nd segment triggers automatic checkpoint rotation + auto-pruning of segments <= ckpt.lsn!
      await db.execute('INSERT INTO LOGS VALUES (?, ?)', [2, 'second']);
      await wal.shipWalOnce();
      manifest = await wal.getManifest();
      expect(manifest.checkpoints.length).toBe(1);
      expect(manifest.segments.length).toBe(0);

      // Add a 3rd entry after checkpoint and verify PITR restore combines rotated checkpoint + tail WAL
      await db.execute('INSERT INTO LOGS VALUES (?, ?)', [3, 'third']);
      await wal.shipWalOnce();

      const restoredDb = await openDatabase('memory://m21_wal_restored');
      await restoredDb.execute('CREATE TABLE LOGS (ID INTEGER NOT NULL PRIMARY KEY, MSG VARCHAR(64))');
      const pitr = await restoreDatabaseToPointInTime({
        targetDb: restoredDb as unknown as ReplicableDatabase,
        store,
      });
      expect(pitr.checkpointUsed).toBeTruthy();
      expect(pitr.segmentsReplayed).toBe(1);

      const rows = await restoredDb.query('SELECT ID, MSG FROM LOGS ORDER BY ID');
      expect(rows.rows).toEqual([
        { ID: 1, MSG: 'first' },
        { ID: 2, MSG: 'second' },
        { ID: 3, MSG: 'third' },
      ]);

      await wal.stop();
      await restoredDb.close();
      await db.close();
    },
    25_000,
  );
});

describe('M21 Item 2: Streaming Columnar / Arrow IPC Cursors & db.preparePipeline()', () => {
  it(
    'streams bounded ColumnarQueryResult chunks and multi-batch Apache Arrow IPC V5 streams',
    async () => {
      const db = await openDatabase('memory://m21_arrow_stream');
      await db.execute(
        'CREATE TABLE SENSORS (ID INTEGER NOT NULL PRIMARY KEY, TAG VARCHAR(32), READING DOUBLE PRECISION)',
      );
      await db.execBatch(
        'INSERT INTO SENSORS (ID, TAG, READING) VALUES (?, ?, ?)',
        Array.from({ length: 10 }, (_, i) => [
          i + 1,
          `s_${i + 1}`,
          i % 3 === 0 ? null : (i + 1) * 2.5,
        ]),
      );

      // 1. Bounded queryColumnarStream (batchSize: 3 -> 4 batches: 3, 3, 3, 1)
      const chunkCounts: number[] = [];
      const chunks = [];
      for await (const batch of db.queryColumnarStream(
        'SELECT ID, TAG, READING FROM SENSORS ORDER BY ID',
        { batchSize: 3 },
      )) {
        chunkCounts.push(batch.rowCount);
        chunks.push(batch);
      }
      expect(chunkCounts).toEqual([3, 3, 3, 1]);
      const merged = concatColumnarResults(chunks);
      expect(merged.rowCount).toBe(10);
      expect(Array.from(merged.getColumn('ID')!.data as Int32Array)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);

      // Early break closes cursor cleanly without locking table
      for await (const batch of db.queryColumnarStream(
        'SELECT ID FROM SENSORS ORDER BY ID',
        { batchSize: 2 },
      )) {
        expect(batch.rowCount).toBe(2);
        break;
      }

      // 2. queryArrowStream emitting Schema + 4 RecordBatch frames + EOS
      const arrowBytes = await collectArrowStreamBytes(
        db.queryArrowStream('SELECT ID, TAG, READING FROM SENSORS ORDER BY ID', {
          batchSize: 3,
          metadata: { stream: 'm21' },
        }),
      );
      const arrowBatches = decodeArrowIpcBatches(arrowBytes);
      expect(arrowBatches.map((b) => b.rowCount)).toEqual([3, 3, 3, 1]);

      const fullArrow = decodeArrowIpc(arrowBytes);
      expect(fullArrow.rowCount).toBe(10);
      expect(fullArrow.metadata).toEqual({ stream: 'm21' });
      expect(fullArrow.toRows()).toEqual([
        { ID: 1, TAG: 's_1', READING: null },
        { ID: 2, TAG: 's_2', READING: 5 },
        { ID: 3, TAG: 's_3', READING: 7.5 },
        { ID: 4, TAG: 's_4', READING: null },
        { ID: 5, TAG: 's_5', READING: 12.5 },
        { ID: 6, TAG: 's_6', READING: 15 },
        { ID: 7, TAG: 's_7', READING: null },
        { ID: 8, TAG: 's_8', READING: 20 },
        { ID: 9, TAG: 's_9', READING: 22.5 },
        { ID: 10, TAG: 's_10', READING: null },
      ]);

      await db.close();
    },
    25_000,
  );

  it(
    'pre-compiles stmtHandles via db.preparePipeline() and executes in 1 Worker round-trip without SQL text',
    async () => {
      const { workerTransport, sentMessages } = createInProcessWorkerPair();
      const db = new FirebirdBrowser('memory://m21_prep_pipe', {
        persist: false,
        transport: workerTransport,
      });

      await db.execute(
        'CREATE TABLE LEDGER (ID INTEGER NOT NULL PRIMARY KEY, CODE VARCHAR(16), AMOUNT INTEGER)',
      );

      const prep = await db.preparePipeline([
        { kind: 'execute', sql: 'INSERT INTO LEDGER (ID, CODE, AMOUNT) VALUES (?, ?, ?)' },
        { kind: 'execBatch', sql: 'INSERT INTO LEDGER (ID, CODE, AMOUNT) VALUES (?, ?, ?)' },
        { kind: 'query', sql: 'SELECT ID, CODE, AMOUNT FROM LEDGER WHERE AMOUNT >= ? ORDER BY ID' },
        { kind: 'queryColumnar', sql: 'SELECT ID, AMOUNT FROM LEDGER ORDER BY ID' },
      ] as const);

      sentMessages.length = 0;
      const [insRes, batchRes, queryRes, colRes] = await prep.run(
        [
          [1, 'A', 100],
          [
            [2, 'B', 250],
            [3, 'C', 50],
          ],
          [100],
          [],
        ],
        { transaction: true },
      );

      // Exactly 1 postMessage round-trip for the entire transactional 4-step prepared pipeline,
      // and every step carries integer stmtHandle with empty SQL string!
      expect(sentMessages.length).toBe(1);
      const wireMsg = sentMessages[0] as {
        op: string;
        args: [number, number, Array<{ sql: string; stmtHandle?: number }>];
      };
      expect(wireMsg.op).toBe('pipeline');
      for (const stepReq of wireMsg.args[2]) {
        expect(stepReq.sql).toBe('');
        expect(stepReq.stmtHandle).toBeGreaterThan(0);
      }

      expect(insRes.affectedRows).toBe(1);
      expect(batchRes.affectedRows).toBe(2);
      expect(queryRes.rows).toEqual([
        { ID: 1, CODE: 'A', AMOUNT: 100 },
        { ID: 2, CODE: 'B', AMOUNT: 250 },
      ]);
      expect(Array.from(colRes.getColumn('AMOUNT')!.data as Int32Array)).toEqual([100, 250, 50]);

      await prep.close();
      expect(prep.closed).toBe(true);
      await db.close();
    },
    25_000,
  );
});

describe('M21 Item 3: Zero-Boilerplate Typed Table & Upsert API (db.table<T>())', () => {
  it(
    'supports typed insert, insertMany, get, upsert, upsertMany, keyset findPage, update, delete, and liveIncremental',
    async () => {
      const db = await openDatabase('memory://m21_table_api');
      await db.execute(
        'CREATE TABLE PRODUCTS (ID INTEGER NOT NULL PRIMARY KEY, SKU VARCHAR(32), PRICE DOUBLE PRECISION, STOCK INTEGER)',
      );

      interface Product {
        id: number;
        sku: string;
        price: number;
        stock: number;
      }

      const ProductSchema = createRowSchema<Product>({
        id: (_v, r) => Number(r.ID),
        sku: (_v, r) => String(r.SKU),
        price: (_v, r) => Number(r.PRICE),
        stock: (_v, r) => Number(r.STOCK),
      });

      const products = db.table<Product, number>('PRODUCTS', {
        primaryKey: 'ID',
        schema: ProductSchema,
      });

      const p1 = await products.insert({ ID: 1, SKU: 'KB-01', PRICE: 99.5, STOCK: 10 });
      expect(p1).toEqual({ id: 1, sku: 'KB-01', price: 99.5, stock: 10 });

      await products.insertMany([
        { ID: 2, SKU: 'MS-02', PRICE: 49.0, STOCK: 25 },
        { ID: 3, SKU: 'MN-03', PRICE: 299.0, STOCK: 5 },
        { ID: 4, SKU: 'HD-04', PRICE: 79.0, STOCK: 15 },
      ]);

      expect(await products.count()).toBe(4);
      expect(await products.exists(3)).toBe(true);
      expect(await products.exists(99)).toBe(false);
      expect((await products.get(2))?.sku).toBe('MS-02');

      // Upsert & upsertMany via Firebird UPDATE OR INSERT ... MATCHING ("ID")
      const upserted = await products.upsert({ ID: 2, SKU: 'MS-02-PRO', PRICE: 59.0, STOCK: 30 });
      expect(upserted.sku).toBe('MS-02-PRO');

      await products.upsertMany([
        { ID: 4, SKU: 'HD-04-V2', PRICE: 89.0, STOCK: 20 },
        { ID: 5, SKU: 'DK-05', PRICE: 149.0, STOCK: 8 },
      ]);
      expect(await products.count()).toBe(5);

      // Keyset cursor pagination ordered by PRICE DESC (with automatic ID tie-breaker)
      const page1 = await products.findPage({ orderBy: 'PRICE DESC', limit: 2 });
      expect(page1.rows.map((p) => p.id)).toEqual([3, 5]);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await products.findPage({
        orderBy: 'PRICE DESC',
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.rows.map((p) => p.id)).toEqual([1, 4]);
      expect(page2.hasMore).toBe(true);

      const page3 = await products.findPage({
        orderBy: 'PRICE DESC',
        limit: 2,
        cursor: page2.nextCursor!,
      });
      expect(page3.rows.map((p) => p.id)).toEqual([2]);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();

      // Update & delete
      await products.update(5, { STOCK: 12 });
      expect((await products.get(5))?.stock).toBe(12);

      await products.delete(1);
      expect(await products.count()).toBe(4);

      // Transaction-scoped tx.table()
      await db.transaction(async (tx) => {
        const txProducts = tx.table('PRODUCTS', { primaryKey: 'ID' });
        await txProducts.deleteWhere({ SKU: 'MS-02-PRO' });
      });
      expect(await products.count()).toBe(3);

      // table.liveIncremental()
      const live = await products.liveIncremental({ orderBy: 'ID ASC' });
      expect(live.rows.map((p) => p.id)).toEqual([3, 4, 5]);
      await live.unsubscribe();

      await db.close();
    },
    25_000,
  );
});

describe('M21 Item 4 & 5: CLI sync / wal-ship / pitr-restore / bench & Modular Export Parity', () => {
  it(
    'executes CLI sync, wal-ship, pitr-restore, and bench subcommands against local .fdb files',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m21-cli-'));
      const srcFdb = path.join(tmpDir, 'primary.fdb');
      const dstFdb = path.join(tmpDir, 'replica.fdb');
      const pitrFdb = path.join(tmpDir, 'restored.fdb');
      const walDir = path.join(tmpDir, 'wal_bucket');

      try {
        // 1. Seed primary.fdb via CLI query
        let outBuf = '';
        let code = await runCli(
          [
            'query',
            srcFdb,
            "CREATE TABLE NOTES (ID INTEGER NOT NULL PRIMARY KEY, BODY VARCHAR(64)); INSERT INTO NOTES VALUES (1, 'hello'); INSERT INTO NOTES VALUES (2, 'world');",
            '--backend',
            'wasm',
          ],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);

        // 2. Sync primary.fdb -> replica.fdb via CLI `sync --bootstrap binary-image`
        outBuf = '';
        code = await runCli(
          ['sync', srcFdb, dstFdb, '--bootstrap', 'binary-image', '--backend', 'wasm', '--json'],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);
        const syncJson = JSON.parse(outBuf) as { bootstrapStrategy: string; lagEntries: number };
        expect(syncJson.bootstrapStrategy).toBe('binary-image');
        expect(syncJson.lagEntries).toBe(0);

        // 3. Ship checkpoint + WAL segments to local directory via CLI `wal-ship`
        outBuf = '';
        code = await runCli(
          ['wal-ship', srcFdb, '--dir', walDir, '--checkpoint', '--backend', 'wasm', '--json'],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);
        const ship1 = JSON.parse(outBuf) as { checkpointCreated: string; totalCheckpoints: number };
        expect(ship1.checkpointCreated).toBeTruthy();
        expect(ship1.totalCheckpoints).toBe(1);

        // Append a post-checkpoint row on primary.fdb and ship WAL delta
        await runCli(
          ['query', srcFdb, "INSERT INTO NOTES VALUES (3, 'after-ckpt');", '--backend', 'wasm'],
          { stdout: () => undefined, stderr: () => undefined, cwd: tmpDir },
        );
        outBuf = '';
        code = await runCli(
          ['wal-ship', srcFdb, '--dir', walDir, '--backend', 'wasm', '--json'],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);
        const ship2 = JSON.parse(outBuf) as { segmentsShipped: number };
        expect(ship2.segmentsShipped).toBe(1);

        // 4. Restore PITR database via CLI `pitr-restore`
        outBuf = '';
        code = await runCli(
          ['pitr-restore', pitrFdb, '--dir', walDir, '--backend', 'wasm', '--json'],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);
        const pitrReport = JSON.parse(outBuf) as { segmentsReplayed: number };
        expect(pitrReport.segmentsReplayed).toBe(1);

        outBuf = '';
        code = await runCli(
          ['query', pitrFdb, 'SELECT ID, BODY FROM NOTES ORDER BY ID', '--format', 'json', '--backend', 'wasm'],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);
        expect(JSON.parse(outBuf)).toEqual([
          { ID: 1, BODY: 'hello' },
          { ID: 2, BODY: 'world' },
          { ID: 3, BODY: 'after-ckpt' },
        ]);

        // 5. Run CLI `bench`
        outBuf = '';
        code = await runCli(
          ['bench', 'memory://m21_cli_bench', '--rows', '30', '--json'],
          { stdout: (s) => (outBuf += s), stderr: (s) => (outBuf += s), cwd: tmpDir },
        );
        expect(code).toBe(0);
        const benchReport = JSON.parse(outBuf) as {
          rows: number;
          benchmarks: Array<{ WORKLOAD: string; ROWS: number }>;
        };
        expect(benchReport.rows).toBe(30);
        expect(benchReport.benchmarks.length).toBe(5);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it('maintains 100% root & browser barrel export parity for M21 symbols and decomposed modules', () => {
    const expectedSymbols = [
      'createReplicaRouter',
      'isReadOnlySqlStatement',
      'encodeArrowIpcSchemaFrame',
      'encodeArrowIpcRecordBatchFrame',
      'encodeArrowIpcEosFrame',
      'concatColumnarResults',
      'decodeArrowIpcBatches',
      'createColumnarStreamFromRowStream',
      'createArrowIpcReadableStream',
      'collectArrowStreamBytes',
      'buildPreparedEnginePipelineRequests',
      'quoteTableIdent',
      'createTableRepository',
      'decodeJrdRecordBuffer',
      'encodeJrdRecordBuffer',
      'parseFbChangelogSegment',
      'logicalEntriesToFbChangelogSegment',
    ];

    for (const sym of expectedSymbols) {
      expect(typeof (rootExports as Record<string, unknown>)[sym]).toBe('function');
      expect(typeof (browserExports as Record<string, unknown>)[sym]).toBe('function');
    }
  });
});
