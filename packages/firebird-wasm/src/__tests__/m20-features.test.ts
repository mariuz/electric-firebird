/**
 * m20-features.test.ts – Comprehensive unit & real-WASM integration suite for M20:
 *   1. Binary `.fdb` / Page-Diff Replica Bootstrap (`bootstrapStrategy: 'binary-image' | 'page-diff'`)
 *      & Zero-Server S3 / R2 / HTTP Object-Store WAL Shipping + Point-in-Time Restore
 *      (`signAwsSigV4Headers`, `createHttpObjectStoreAdapter`, `createObjectStoreReplicationTarget`,
 *      `restoreDatabaseToPointInTime`).
 *   2. Compact Binary Parameter Wire Frame (`"FBP\x01"` / `"FBP\x02"`) across `WorkerTransport` +
 *      `serveEngine` & Multi-Statement `db.pipeline()` / `tx.pipeline()` (single Worker round-trip).
 *   3. Incremental Row-Delta Live Queries (`db.liveIncremental()`) with structural row sharing &
 *      Zero-Copy Columnar Live Queries (`db.liveColumnar()`).
 *   4. Reactive Framework Sync & Columnar Adapters (`react`, `vue`, `svelte`, `solid`),
 *      `SyncStatusStore` / `ColumnarQueryStore` / `IncrementalQueryStore`, and `columnar` / `schema` subpaths.
 *   5. Core Monolith Decomposition (`replication/core.ts`, `firebird.ts`, `firebird-browser.ts`)
 *      & 100% root/browser barrel export parity.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import * as rootBarrel from '../index';
import * as browserBarrel from '../browser';
import {
  FirebirdBrowser,
  DirectTransport,
  WorkerTransport,
  serveEngine,
  type EngineRequest,
  type EngineResponse,
} from '../browser';
import {
  sql,
  decodeArrowIpc,
  createRowSchema,
  createTypedSql,
  syncDatabases,
  createPublication,
  createSubscription,
  bootstrapReplica,
  createMemoryObjectStoreAdapter,
  createHttpObjectStoreAdapter,
  buildS3ObjectUrl,
  signAwsSigV4Headers,
  createObjectStoreReplicationTarget,
  restoreDatabaseToPointInTime,
  encodeWireParams,
  decodeWireParams,
  encodeWireParamRows,
  decodeWireParamRows,
  isWireParamsBuffer,
  isWireParamRowsBuffer,
  wireParamsToCAbi,
  computeIncrementalRowDeltas,
} from '../index';
import {
  SyncStatusStore,
  ColumnarQueryStore,
  IncrementalQueryStore,
} from '../frameworks/sync-store';
import {
  createSyncStatus as createSvelteSyncStatus,
  createColumnarQuery as createSvelteColumnarQuery,
  createLiveIncrementalQuery as createSvelteIncrementalQuery,
} from '../svelte';
import {
  createSyncStatus as createSolidSyncStatus,
  createColumnarQuery as createSolidColumnarQuery,
  createLiveIncrementalQuery as createSolidIncrementalQuery,
} from '../solid';
import * as reactAdapter from '../react';
import * as vueAdapter from '../vue';

const HAS_ST_WASM = fs.existsSync(
  path.resolve(__dirname, '../../dist/wasm/firebird-embedded-st.js'),
);

/** Create an in-memory duplex Worker pair connecting `WorkerTransport` <-> `serveEngine` and counting requests. */
function createInstrumentedWorkerPair(backend: DirectTransport): {
  worker: Worker;
  requests: EngineRequest[];
  transferredBuffersCount: () => number;
} {
  const requests: EngineRequest[] = [];
  let transferredCount = 0;
  const workerListeners: Array<(ev: MessageEvent<EngineRequest>) => void> = [];
  const clientListeners: Array<(ev: MessageEvent<EngineResponse>) => void> = [];

  const scope = {
    addEventListener(
      type: 'message',
      listener: (ev: MessageEvent<EngineRequest>) => void,
    ) {
      if (type === 'message') workerListeners.push(listener);
    },
    postMessage(message: unknown, transfer?: Transferable[]) {
      if (transfer) transferredCount += transfer.length;
      for (const fn of clientListeners) {
        fn({ data: message as EngineResponse } as MessageEvent<EngineResponse>);
      }
    },
  };

  serveEngine(scope, backend);

  const worker = {
    addEventListener(type: string, listener: unknown) {
      if (type === 'message') {
        clientListeners.push(listener as (ev: MessageEvent<EngineResponse>) => void);
      }
    },
    removeEventListener() {},
    postMessage(req: EngineRequest, transfer?: Transferable[]) {
      requests.push(req);
      if (transfer) transferredCount += transfer.length;
      for (const fn of workerListeners) {
        fn({ data: req } as MessageEvent<EngineRequest>);
      }
    },
    terminate() {},
  } as unknown as Worker;

  return {
    worker,
    requests,
    transferredBuffersCount: () => transferredCount,
  };
}

// ===========================================================================
// 1. M20 Item 1 — Binary / Page-Diff Replica Bootstrap & Object-Store WAL PITR
// ===========================================================================
describe('M20 Item 1: Binary/Page-Diff Replica Bootstrap & S3/R2 Object-Store WAL PITR', () => {
  it('signs deterministic AWS SigV4 headers and round-trips objects via createHttpObjectStoreAdapter', async () => {
    const s3Cfg = {
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'firebird-wal',
      region: 'auto',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };
    const url = buildS3ObjectUrl(s3Cfg, 'tenants/acme/manifest.json');
    expect(url).toBe(
      'https://acct123.r2.cloudflarestorage.com/firebird-wal/tenants/acme/manifest.json',
    );

    const fixedDate = new Date('2026-11-16T12:00:00Z');
    const headers1 = await signAwsSigV4Headers({
      method: 'PUT',
      url,
      region: 'auto',
      accessKeyId: s3Cfg.accessKeyId,
      secretAccessKey: s3Cfg.secretAccessKey,
      body: new Uint8Array([1, 2, 3, 4]),
      now: fixedDate,
    });
    const headers2 = await signAwsSigV4Headers({
      method: 'PUT',
      url,
      region: 'auto',
      accessKeyId: s3Cfg.accessKeyId,
      secretAccessKey: s3Cfg.secretAccessKey,
      body: new Uint8Array([1, 2, 3, 4]),
      now: fixedDate,
    });
    expect(headers1.Authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261116/auto/s3/aws4_request',
    );
    expect(headers1.Authorization).toBe(headers2.Authorization);

    // Mock HTTP S3 server verifying SigV4 headers on PUT / GET / DELETE
    const objects = new Map<string, Uint8Array>();
    const seenAuthHeaders: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const reqUrl = String(input);
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      seenAuthHeaders.push(hdrs.Authorization ?? '');
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        const body = init?.body as Uint8Array;
        objects.set(reqUrl, body.slice());
        return new Response('', { status: 200 });
      }
      if (method === 'GET') {
        const found = objects.get(reqUrl);
        if (!found) return new Response('Not Found', { status: 404 });
        return new Response(
          new Uint8Array(found.buffer, found.byteOffset, found.byteLength) as unknown as BodyInit,
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        objects.delete(reqUrl);
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 405 });
    };

    const httpStore = createHttpObjectStoreAdapter({ s3: s3Cfg, fetch: mockFetch });
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    await httpStore.putObject('wal/seg-000001.fbrseg', payload);
    const loaded = await httpStore.getObject('wal/seg-000001.fbrseg');
    expect(loaded).toEqual(payload);
    expect(await httpStore.getObject('wal/missing.fbrseg')).toBeNull();
    await httpStore.deleteObject!('wal/seg-000001.fbrseg');
    expect(await httpStore.getObject('wal/seg-000001.fbrseg')).toBeNull();
    expect(seenAuthHeaders.every((h) => h.startsWith('AWS4-HMAC-SHA256 '))).toBe(true);
  });

  it.skipIf(!HAS_ST_WASM)(
    'bootstraps replicas via gzipped binary-image & page-diff strategies and continues live sync on real WASM',
    async () => {
      const primary = new FirebirdBrowser('memory://m20-boot-primary', {
        threads: false,
        autoPersist: false,
      });
      const replicaBin = new FirebirdBrowser('memory://m20-boot-replica-bin', {
        threads: false,
        autoPersist: false,
      });
      const replicaDiff = new FirebirdBrowser('memory://m20-boot-replica-diff', {
        threads: false,
        autoPersist: false,
      });

      try {
        await primary.exec(
          'CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(64) NOT NULL)',
        );
        await primary.execBatch('INSERT INTO ITEMS (ID, NAME) VALUES (?, ?)', [
          [1, 'One'],
          [2, 'Two'],
          [3, 'Three'],
        ]);

        // 1. Gzipped binary-image bootstrap via syncDatabases() + live incremental continuation
        await using syncBin = await syncDatabases(primary, replicaBin, {
          bootstrapStrategy: 'binary-image',
          bootstrapCompressGzip: true,
          live: false,
        });

        const binRows1 = await replicaBin.query<{ ID: number; NAME: string }>(
          'SELECT ID, NAME FROM ITEMS ORDER BY ID',
        );
        expect(binRows1.rows).toEqual([
          { ID: 1, NAME: 'One' },
          { ID: 2, NAME: 'Two' },
          { ID: 3, NAME: 'Three' },
        ]);

        // Subsequent primary write syncs incrementally from the binary-image watermark!
        await primary.execute('INSERT INTO ITEMS (ID, NAME) VALUES (?, ?)', [4, 'Four']);
        await syncBin.syncNow();
        const binRows2 = await replicaBin.query<{ ID: number; NAME: string }>(
          'SELECT ID, NAME FROM ITEMS ORDER BY ID',
        );
        expect(binRows2.rows).toHaveLength(4);
        expect(binRows2.rows[3]).toEqual({ ID: 4, NAME: 'Four' });

        // 2. Incremental page-diff bootstrap against primary's base .fdb image
        const baseImage = await primary.dumpDataDir();
        await replicaDiff.loadDataStream(
          (async function* () {
            yield baseImage;
          })(),
        );
        await primary.execute('INSERT INTO ITEMS (ID, NAME) VALUES (?, ?)', [5, 'Five']);

        const pub = await createPublication(primary, { name: 'pub_diff', tables: '*' });
        const sub = await createSubscription(replicaDiff, {
          name: 'sub_diff',
          publication: pub,
        });
        const diffRes = await bootstrapReplica({
          targetDb: replicaDiff,
          publication: pub,
          subscription: sub,
          bootstrapStrategy: 'page-diff',
          baseSnapshot: baseImage,
        });
        expect(diffRes.mode).toBe('page-diff');
        expect(diffRes.bytesTransferred).toBeLessThan(baseImage.byteLength);

        const diffRows = await replicaDiff.query<{ ID: number; NAME: string }>(
          'SELECT ID, NAME FROM ITEMS ORDER BY ID',
        );
        expect(diffRows.rows.map((r) => r.ID)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        await replicaDiff.close();
        await replicaBin.close();
        await primary.close();
      }
    },
  );

  it.skipIf(!HAS_ST_WASM)(
    'ships binary checkpoints + AES-256-GCM WAL segments to object storage, tails read replicas, and restores PITR to exact LSN',
    async () => {
      const primary = new FirebirdBrowser('memory://m20-wal-primary', {
        threads: false,
        autoPersist: false,
      });
      const followerDb = new FirebirdBrowser('memory://m20-wal-follower', {
        threads: false,
        autoPersist: false,
      });
      const pitrDb = new FirebirdBrowser('memory://m20-wal-pitr', {
        threads: false,
        autoPersist: false,
      });

      try {
        await primary.exec(
          'CREATE TABLE LEDGER (ID INTEGER NOT NULL PRIMARY KEY, AMOUNT INTEGER NOT NULL)',
        );
        await primary.execBatch('INSERT INTO LEDGER (ID, AMOUNT) VALUES (?, ?)', [
          [1, 100],
          [2, 200],
        ]);

        const bucket = createMemoryObjectStoreAdapter();
        const secret = 'm20-super-secret-wal-passphrase';

        await using walTarget = await createObjectStoreReplicationTarget({
          db: primary,
          store: bucket,
          prefix: 'clusters/prod',
          installTriggers: true,
          encryptionKey: secret,
          compress: true,
        });

        // 1. Ship initial binary .fdb checkpoint
        const ckpt = await walTarget.createCheckpoint({ mode: 'binary-image' });
        expect(ckpt.mode).toBe('binary-image');
        expect(ckpt.compressed).toBe(true);

        // 2. Commit two separate mutations -> capture LSN after first mutation for PITR!
        await primary.execute('INSERT INTO LEDGER (ID, AMOUNT) VALUES (?, ?)', [3, 300]);
        const segs1 = await walTarget.shipWalOnce();
        expect(segs1).toHaveLength(1);
        expect(segs1[0]!.encrypted).toBe(true);
        const safeLsnBeforeMistake = segs1[0]!.endLsn;

        // Accidental destructive mutation at later LSN
        await primary.execute('DELETE FROM LEDGER WHERE ID = ?', [1]);
        await primary.execute('UPDATE LEDGER SET AMOUNT = ? WHERE ID = ?', [9999, 2]);
        const segs2 = await walTarget.shipWalOnce();
        expect(segs2).toHaveLength(1);

        // 3. Zero-server read replica follower catches up to head
        await using follower = await walTarget.followInto(followerDb, {
          decryptionKey: secret,
        });
        const followRes = await follower.followOnce();
        expect(followRes.bootstrapped).toBe(true);
        expect(followRes.segmentsApplied).toBe(2);

        const headRows = await followerDb.query<{ ID: number; AMOUNT: number }>(
          'SELECT ID, AMOUNT FROM LEDGER ORDER BY ID',
        );
        expect(headRows.rows).toEqual([
          { ID: 2, AMOUNT: 9999 },
          { ID: 3, AMOUNT: 300 },
        ]);

        // 4. Point-in-Time Restore to `safeLsnBeforeMistake` (before DELETE + bad UPDATE!)
        const pitrRes = await restoreDatabaseToPointInTime({
          targetDb: pitrDb,
          store: bucket,
          prefix: 'clusters/prod',
          target: { lsn: safeLsnBeforeMistake },
          decryptionKey: secret,
        });
        expect(pitrRes.checkpointUsed).toBe(ckpt.id);
        expect(pitrRes.restoredToLsn).toBe(safeLsnBeforeMistake);

        const restoredRows = await pitrDb.query<{ ID: number; AMOUNT: number }>(
          'SELECT ID, AMOUNT FROM LEDGER ORDER BY ID',
        );
        expect(restoredRows.rows).toEqual([
          { ID: 1, AMOUNT: 100 },
          { ID: 2, AMOUNT: 200 },
          { ID: 3, AMOUNT: 300 },
        ]);
      } finally {
        await pitrDb.close();
        await followerDb.close();
        await primary.close();
      }
    },
  );
});

// ===========================================================================
// 2. M20 Item 2 — Binary Wire Params ("FBP\x01") & Multi-Statement Pipeline
// ===========================================================================
describe('M20 Item 2: Binary Wire Params ("FBP\\x01" / "FBP\\x02") & db.pipeline()', () => {
  it('round-trips all parameter types in FBP\\x01 and FBP\\x02 binary frames and converts to C-ABI', () => {
    const dt = new Date('2026-11-16T10:20:30.456Z');
    const hugeBig = 123456789012345678901234567890n;
    const rawBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const input = [
      null,
      false,
      true,
      42,
      -2147483648,
      9007199254740991,
      9007199254740992n,
      hugeBig,
      3.141592653589793,
      dt,
      'Hello Firebird 🔥',
      rawBytes,
    ];

    const wire = encodeWireParams(input);
    expect(isWireParamsBuffer(wire)).toBe(true);
    const decoded = decodeWireParams(wire);
    expect(decoded).toEqual(input);

    const cabi = wireParamsToCAbi(wire);
    expect(cabi.byteLength).toBeGreaterThan(32);

    const batchWire = encodeWireParamRows([
      [1, 'alpha', true],
      [2, 'beta', null],
    ]);
    expect(isWireParamRowsBuffer(batchWire)).toBe(true);
    expect(decodeWireParamRows(batchWire)).toEqual([
      [1, 'alpha', true],
      [2, 'beta', null],
    ]);
  });

  it.skipIf(!HAS_ST_WASM)(
    'executes heterogeneous transactional db.pipeline() across WorkerTransport in 1 postMessage round-trip and rolls back on error',
    async () => {
      const direct = new DirectTransport({ threads: false });
      const { worker, requests, transferredBuffersCount } =
        createInstrumentedWorkerPair(direct);
      const workerTransport = new WorkerTransport(worker);
      const db = new FirebirdBrowser('memory://m20-pipeline', {
        transport: workerTransport,
        autoPersist: false,
      });

      try {
        await db.exec(
          'CREATE TABLE METRICS (ID INTEGER NOT NULL PRIMARY KEY, LABEL VARCHAR(32) NOT NULL, VAL DOUBLE PRECISION)',
        );

        interface DbSchema {
          METRICS: { ID: number; LABEL: string; VAL: number | null };
        }
        const tsql = createTypedSql<DbSchema>();
        const labelSchema = createRowSchema({
          id: (_v, r) => Number(r.ID),
          upperLabel: (_v, r) => String(r.LABEL).toUpperCase(),
        });

        const reqCountBefore = requests.length;
        const transfersBefore = transferredBuffersCount();

        const [insRes, batchRes, rowsRes, colRes, arrowBytes] = await db.pipeline(
          [
            sql`INSERT INTO METRICS (ID, LABEL, VAL) VALUES (${1}, ${'first'}, ${10.5})`,
            {
              kind: 'execBatch',
              sql: 'INSERT INTO METRICS (ID, LABEL, VAL) VALUES (?, ?, ?)',
              rows: [
                [2, 'second', 20.25],
                [3, 'third', null],
              ],
            },
            tsql.selectFrom('METRICS', ['ID', 'LABEL']).withSchema(labelSchema),
            {
              kind: 'queryColumnar',
              sql: 'SELECT ID, VAL FROM METRICS ORDER BY ID',
            },
            {
              kind: 'queryArrow',
              sql: 'SELECT ID, LABEL FROM METRICS WHERE ID <= ?',
              params: [2],
              arrowOptions: { metadata: { pipeline: 'true' } },
            },
          ],
          { transaction: true },
        );

        // Entire 5-step transactional pipeline took ONE Worker postMessage ('pipeline')!
        const pipelineReqs = requests.slice(reqCountBefore);
        expect(pipelineReqs).toHaveLength(1);
        expect(pipelineReqs[0]!.op).toBe('pipeline');
        expect(transferredBuffersCount()).toBeGreaterThan(transfersBefore);

        expect(insRes.affectedRows).toBe(1);
        expect(batchRes.affectedRows).toBe(2);
        expect(rowsRes.rows).toEqual([
          { id: 1, upperLabel: 'FIRST' },
          { id: 2, upperLabel: 'SECOND' },
          { id: 3, upperLabel: 'THIRD' },
        ]);
        expect(colRes.rowCount).toBe(3);
        expect(Array.from((colRes.columns.ID as { data: Int32Array }).data)).toEqual([
          1, 2, 3,
        ]);

        const decodedArrow = decodeArrowIpc(arrowBytes);
        expect(decodedArrow.rowCount).toBe(2);
        expect(decodedArrow.metadata).toEqual({ pipeline: 'true' });

        // Atomic rollback when a later step in `{ transaction: true }` fails!
        await expect(
          db.pipeline(
            [
              {
                kind: 'execute',
                sql: 'INSERT INTO METRICS (ID, LABEL, VAL) VALUES (?, ?, ?)',
                params: [99, 'transient', 1.0],
              },
              {
                kind: 'execute',
                sql: 'INSERT INTO METRICS (ID, LABEL, VAL) VALUES (?, ?, ?)',
                params: [1, 'duplicate-pk', 2.0],
              },
            ],
            { transaction: true },
          ),
        ).rejects.toThrow();

        const checkAfterRollback = await db.query(
          'SELECT ID FROM METRICS WHERE ID = 99',
        );
        expect(checkAfterRollback.rows).toHaveLength(0);
      } finally {
        await db.close();
      }
    },
  );
});

// ===========================================================================
// 3. M20 Item 3 — Incremental & Columnar Live Queries
// ===========================================================================
describe('M20 Item 3: Incremental Row-Delta & Columnar Live Queries', () => {
  it('preserves object identity for unchanged rows in computeIncrementalRowDeltas', () => {
    const r1 = { ID: 1, NAME: 'Alpha' };
    const r2 = { ID: 2, NAME: 'Beta' };
    const r3 = { ID: 3, NAME: 'Gamma' };

    const nextRaw = [
      { ID: 1, NAME: 'Alpha' }, // unchanged
      { ID: 2, NAME: 'Beta v2' }, // updated
      { ID: 4, NAME: 'Delta' }, // inserted (ID 3 deleted)
    ];

    const diff = computeIncrementalRowDeltas([r1, r2, r3], nextRaw, (r) => r.ID);
    expect(diff.rows[0]).toBe(r1); // Exact JS reference preserved!
    expect(diff.rows[1]).toEqual({ ID: 2, NAME: 'Beta v2' });
    expect(diff.rows[2]).toEqual({ ID: 4, NAME: 'Delta' });
    expect(diff.deltas).toEqual([
      { type: 'delete', key: 3, oldRow: r3, index: 2 },
      {
        type: 'update',
        key: 2,
        row: { ID: 2, NAME: 'Beta v2' },
        oldRow: r2,
        index: 1,
        previousIndex: 1,
      },
      { type: 'insert', key: 4, row: { ID: 4, NAME: 'Delta' }, index: 2 },
    ]);
  });

  it.skipIf(!HAS_ST_WASM)(
    'drives db.liveIncremental() and db.liveColumnar() on real Firebird WASM',
    async () => {
      const db = new FirebirdBrowser('memory://m20-live-inc', {
        threads: false,
        autoPersist: false,
      });

      try {
        await db.exec(
          'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64) NOT NULL, SCORE INTEGER NOT NULL)',
        );
        await db.execBatch('INSERT INTO TASKS (ID, TITLE, SCORE) VALUES (?, ?, ?)', [
          [1, 'Design', 10],
          [2, 'Build', 20],
        ]);

        const snapshots: Array<{ version: number; deltaTypes: string[] }> = [];
        await using inc = await db.liveIncremental<{
          ID: number;
          TITLE: string;
          SCORE: number;
        }>(
          'SELECT ID, TITLE, SCORE FROM TASKS ORDER BY ID',
          { key: 'ID', pollIntervalMs: 30 },
          (snap) => {
            snapshots.push({
              version: snap.version,
              deltaTypes: snap.deltas.map((d) => `${d.type}:${d.key}`),
            });
          },
        );

        await using colLive = await db.liveColumnar(
          'SELECT ID, SCORE FROM TASKS ORDER BY ID',
          { pollIntervalMs: 30 },
        );

        expect(inc.rows).toHaveLength(2);
        const firstRowRef = inc.rows[0]!;
        expect(colLive.current.rowCount).toBe(2);

        // Mutate row 2 and insert row 3; row 1 stays untouched
        await db.execute('UPDATE TASKS SET SCORE = ? WHERE ID = ?', [25, 2]);
        await db.execute('INSERT INTO TASKS (ID, TITLE, SCORE) VALUES (?, ?, ?)', [
          3,
          'Ship',
          30,
        ]);

        await inc.refresh();
        await colLive.refresh();

        expect(inc.rows).toHaveLength(3);
        expect(inc.rows[0]).toBe(firstRowRef); // Structural sharing verified!
        expect(snapshots[snapshots.length - 1]!.deltaTypes).toEqual([
          'update:2',
          'insert:3',
        ]);
        expect(
          Array.from((colLive.current.columns.SCORE as { data: Int32Array }).data),
        ).toEqual([10, 25, 30]);

        // Direct in-memory replication log patch via applyChanges()
        const patched = inc.applyChanges([
          {
            lsn: 99,
            txid: '1',
            timestamp: Date.now(),
            origin: 'peer',
            publication: 'pub',
            table: 'TASKS',
            operation: 'DELETE',
            key: { ID: 2 },
            before: null,
            after: null,
          },
        ]);
        expect(patched.deltas).toHaveLength(1);
        expect(patched.deltas[0]!.type).toBe('delete');
        expect(inc.rows.map((r) => r.ID)).toEqual([1, 3]);
      } finally {
        await db.close();
      }
    },
  );
});

// ===========================================================================
// 4. M20 Item 4 & Item 5 — Reactive Sync/Columnar Adapters, Subpaths & Decomposition
// ===========================================================================
describe('M20 Items 4 & 5: Reactive Framework Sync/Columnar Stores, Subpaths & Barrel Parity', () => {
  it('exposes reactive SyncStatus, Columnar, and Incremental primitives across React, Vue, Svelte & Solid', async () => {
    expect(typeof reactAdapter.useSyncStatus).toBe('function');
    expect(typeof reactAdapter.useColumnarQuery).toBe('function');
    expect(typeof reactAdapter.useLiveIncrementalQuery).toBe('function');
    expect(typeof vueAdapter.useSyncStatus).toBe('function');
    expect(typeof vueAdapter.useColumnarQuery).toBe('function');
    expect(typeof vueAdapter.useLiveIncrementalQuery).toBe('function');

    let paused = false;
    let lag = 3;
    const mockSyncHandle = {
      mode: 'native',
      direction: 'one-way' as const,
      get paused() {
        return paused;
      },
      async syncNow() {
        lag = 0;
      },
      pause() {
        paused = true;
      },
      resume() {
        paused = false;
      },
      async stats() {
        return {
          status: lag === 0 ? ('idle' as const) : ('syncing' as const),
          replicaWatermark: 10 - lag,
          primaryLsn: 10,
          lagEntries: lag,
          lagMs: lag * 15,
          totalFetched: 10,
          totalApplied: 10 - lag,
          totalConflicts: 0,
          bytesTransferred: 512,
          lastSyncedAt: 1_700_000_000_000,
        };
      },
    };

    const svelteSync = createSvelteSyncStatus(mockSyncHandle, { pollIntervalMs: 0 });
    await svelteSync.refresh();
    expect(svelteSync.lagEntries).toBe(3);
    expect(svelteSync.state).toBe('online');

    svelteSync.pause();
    expect(svelteSync.paused).toBe(true);
    expect(svelteSync.state).toBe('paused');

    svelteSync.resume();
    await svelteSync.syncNow();
    expect(svelteSync.lagEntries).toBe(0);
    svelteSync.destroy();

    const solidSync = createSolidSyncStatus(() => mockSyncHandle, { pollIntervalMs: 0 });
    await solidSync.refresh();
    expect(solidSync.lagEntries()).toBe(0);
    solidSync.dispose();

    const mockDb = {
      async query<T = Record<string, unknown>>() {
        return {
          fields: [{ name: 'ID', type: 496, typeName: 'INTEGER', subType: 0, scale: 0, length: 4, nullable: false }],
          rows: [{ ID: 7 }, { ID: 8 }] as unknown as T[],
        };
      },
    };

    const svelteCol = createSvelteColumnarQuery('SELECT ID FROM T', { db: mockDb });
    await svelteCol.refresh();
    expect(svelteCol.result?.rowCount).toBe(2);
    svelteCol.destroy();

    const solidCol = createSolidColumnarQuery('SELECT ID FROM T', { db: mockDb });
    await solidCol.refresh();
    expect(solidCol.result()?.rowCount).toBe(2);
    solidCol.dispose();

    const svelteInc = createSvelteIncrementalQuery('SELECT ID FROM T', { db: mockDb });
    await new Promise((r) => setTimeout(r, 10));
    expect(svelteInc.rows).toHaveLength(2);
    svelteInc.destroy();

    const solidInc = createSolidIncrementalQuery('SELECT ID FROM T', { db: mockDb });
    await new Promise((r) => setTimeout(r, 10));
    expect(solidInc.rows()).toHaveLength(2);
    solidInc.dispose();

    // Direct store classes sanity check
    expect(SyncStatusStore).toBeDefined();
    expect(ColumnarQueryStore).toBeDefined();
    expect(IncrementalQueryStore).toBeDefined();
  });

  it('maintains M20 barrel export parity, package.json subpaths, and monolith decomposition targets', () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(pkgJson.exports['./columnar']).toBeDefined();
    expect(pkgJson.exports['./schema']).toBeDefined();

    const m20Exports = [
      'compressGzipBytes',
      'decompressGzipBytes',
      'createMemoryObjectStoreAdapter',
      'buildS3ObjectUrl',
      'signAwsSigV4Headers',
      'createHttpObjectStoreAdapter',
      'createObjectStoreReplicationTarget',
      'restoreDatabaseToPointInTime',
      'encodeWireParams',
      'decodeWireParams',
      'encodeWireParamRows',
      'decodeWireParamRows',
      'isWireParamsBuffer',
      'isWireParamRowsBuffer',
      'wireParamsToCAbi',
      'wireParamRowsToCAbi',
      'normalizePipelineOperations',
      'computeIncrementalRowDeltas',
      'createLiveIncrementalQuery',
      'createLiveColumnarQuery',
    ];

    for (const sym of m20Exports) {
      expect(sym in rootBarrel, `${sym} in root barrel`).toBe(true);
      expect(sym in browserBarrel, `${sym} in browser barrel`).toBe(true);
    }

    // Verify core.ts and firebird.ts were genuinely decomposed!
    const coreLines = fs
      .readFileSync(path.resolve(__dirname, '../replication/core.ts'), 'utf8')
      .split('\n').length;
    const firebirdLines = fs
      .readFileSync(path.resolve(__dirname, '../firebird.ts'), 'utf8')
      .split('\n').length;
    const browserLines = fs
      .readFileSync(path.resolve(__dirname, '../browser/firebird-browser.ts'), 'utf8')
      .split('\n').length;

    expect(coreLines).toBeLessThan(50);
    expect(firebirdLines).toBeLessThan(2500);
    expect(browserLines).toBeLessThan(3600);
  });
});
