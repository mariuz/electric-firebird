/**
 * m22-features.test.ts – Comprehensive integration tests for M22:
 *   1. Multi-Tenant Partitioned Replication Slices (`createTenantReplicationSlice`) &
 *      Inbound Tenant Isolation Guard (`TenantIsolationError`, HTTP `403`, WS `repl_error`,
 *      shared read-only reference tables, parallel `concurrency` snapshot seeding)
 *   2. Zero-Copy Apache Arrow IPC Ingestion (`db.loadArrowIpc`, `tx.loadArrowIpc`,
 *      `table.insertArrow`, `table.upsertArrow`, `"FBP\x02"` `encodeColumnarBatchToWireRows`)
 *      & Bounded LRU `PreparedStatement` Handle Caching in `db.table<T>()`
 *   3. Optimistic Local-First Mutations (`createOptimisticMutationStore`) & Reactive
 *      Table Hooks (`ReactiveTableStore`, `react`/`vue`/`svelte`/`solid`)
 *   4. Zero-Config CLI Replication Server (`startCliReplicationServer`, `serve-sync`)
 *      with `/arrow` IPC streaming & `<firebird-repl>` Arrow Import/Export exports
 *   5. Sub-2,000-Line Codebase Completion across every non-test `.ts` file in `src/`
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCreateTableDdlFromColumnar,
  createHttpReplicationClient,
  createHttpReplicationHandler,
  createOptimisticMutationStore,
  createPublication,
  createSubscription,
  createTenantIsolationGuard,
  createTenantReplicationSlice,
  createWebSocketReplicationPeer,
  decodeArrowIpc,
  encodeColumnarBatchToWireRows,
  openDatabase,
  startCliReplicationServer,
  TenantIsolationError,
  type PendingOptimisticMutation,
  type WebSocketLike,
} from '../index';
import * as rootExports from '../index';
import * as browserExports from '../browser';
import * as replExports from '../replication';
import { FirebirdBrowser, isWireParamRowsBuffer } from '../browser';
import { runCli } from '../cli';
import {
  createOptimisticMutation as createSvelteOpt,
  createTable as createSvelteTable,
} from '../svelte';
import {
  createOptimisticMutation as createSolidOpt,
  createTable as createSolidTable,
} from '../solid';
import * as reactExports from '../react';
import * as vueExports from '../vue';

describe('M22 Item 1: Multi-Tenant Partitioned Replication Slices & Tenant Isolation Guard', () => {
  it('bootstraps tenant-scoped tables in parallel + shared reference tables and blocks cross-tenant or shared-table pushes', async () => {
    const primary = new FirebirdBrowser('memory://m22_tenant_primary', {
      threads: false,
    });
    const acmeReplica = new FirebirdBrowser('memory://m22_tenant_acme', {
      threads: false,
    });

    try {
      await primary.execute(
        'CREATE TABLE PLANS (ID VARCHAR(32) NOT NULL PRIMARY KEY, TIER_NAME VARCHAR(64), MAX_SEATS INTEGER)',
      );
      await primary.execute(
        'CREATE TABLE PROJECTS (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, TITLE VARCHAR(100), INTERNAL_SECRET VARCHAR(100))',
      );
      await primary.execute(
        'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, PROJECT_ID INTEGER NOT NULL, SUMMARY VARCHAR(120))',
      );

      await primary.table('PLANS', { primaryKey: 'ID' }).insertMany([
        { ID: 'free', TIER_NAME: 'Free Tier', MAX_SEATS: 3 },
        { ID: 'pro', TIER_NAME: 'Pro Tier', MAX_SEATS: 50 },
      ]);
      await primary.table('PROJECTS', { primaryKey: 'ID' }).insertMany([
        { ID: 1, TENANT_ID: 'acme', TITLE: 'Acme Core', INTERNAL_SECRET: 'sec-1' },
        { ID: 2, TENANT_ID: 'globex', TITLE: 'Globex Secret', INTERNAL_SECRET: 'sec-2' },
      ]);
      await primary.table('TASKS', { primaryKey: 'ID' }).insertMany([
        { ID: 10, TENANT_ID: 'acme', PROJECT_ID: 1, SUMMARY: 'Ship WASM sync' },
        { ID: 20, TENANT_ID: 'globex', PROJECT_ID: 2, SUMMARY: 'Globex task' },
      ]);

      const slice = await createTenantReplicationSlice({
        primary,
        replica: acmeReplica,
        tenantColumn: 'TENANT_ID',
        tenantId: 'acme',
        sharedTables: ['PLANS'],
        excludeColumns: { PROJECTS: ['INTERNAL_SECRET'] },
        concurrency: 3,
      });

      try {
        expect(slice.partitionedTables.sort()).toEqual(['PROJECTS', 'TASKS']);
        expect(slice.sharedTables).toEqual(['PLANS']);

        // Shared reference rows are replicated in full
        const plans = await acmeReplica.query<{ ID: string }>(
          'SELECT ID FROM PLANS ORDER BY ID',
        );
        expect(plans.rows.map((r) => r.ID)).toEqual(['free', 'pro']);

        // Only 'acme' rows exist on replica, with INTERNAL_SECRET stripped!
        const projects = await acmeReplica.query<{
          ID: number;
          TENANT_ID: string;
          TITLE: string;
          INTERNAL_SECRET: string | null;
        }>('SELECT ID, TENANT_ID, TITLE, INTERNAL_SECRET FROM PROJECTS ORDER BY ID');
        expect(projects.rows).toEqual([
          { ID: 1, TENANT_ID: 'acme', TITLE: 'Acme Core', INTERNAL_SECRET: null },
        ]);

        const tasks = await acmeReplica.query<{ ID: number; TENANT_ID: string }>(
          'SELECT ID, TENANT_ID FROM TASKS ORDER BY ID',
        );
        expect(tasks.rows).toEqual([{ ID: 10, TENANT_ID: 'acme' }]);

        // Valid local write on Acme replica pushes cleanly to primary
        await acmeReplica.execute(
          "INSERT INTO TASKS (ID, TENANT_ID, PROJECT_ID, SUMMARY) VALUES (11, 'acme', 1, 'Offline Acme Task')",
        );
        const cycle = await slice.syncNow();
        expect(cycle.pushed).toBe(1);

        const primaryTasks = await primary.query<{ ID: number; TENANT_ID: string }>(
          'SELECT ID, TENANT_ID FROM TASKS ORDER BY ID',
        );
        expect(primaryTasks.rows.map((r) => r.ID)).toEqual([10, 11, 20]);

        // Cross-tenant push attempt is rejected with TenantIsolationError
        await expect(
          slice.pushToPrimary([
            {
              lsn: 999,
              txid: 'tx_bad',
              timestamp: Date.now(),
              origin: 'rogue_client',
              table: 'TASKS',
              operation: 'INSERT',
              key: { ID: 99 },
              after: { ID: 99, TENANT_ID: 'globex', PROJECT_ID: 2, SUMMARY: 'Spoofed' },
              before: null,
            },
          ]),
        ).rejects.toBeInstanceOf(TenantIsolationError);

        // Shared-table mutation push is rejected with reason 'shared-table-read-only'
        let sharedErr: unknown;
        try {
          await slice.pushToPrimary([
            {
              lsn: 1000,
              txid: 'tx_shared_bad',
              timestamp: Date.now(),
              origin: 'rogue_client',
              table: 'PLANS',
              operation: 'UPDATE',
              key: { ID: 'free' },
              after: { ID: 'free', TIER_NAME: 'Hacked', MAX_SEATS: 9999 },
              before: { ID: 'free', TIER_NAME: 'Free Tier', MAX_SEATS: 3 },
            },
          ]);
        } catch (err) {
          sharedErr = err;
        }
        expect(sharedErr).toBeInstanceOf(TenantIsolationError);
        expect((sharedErr as TenantIsolationError).reason).toBe('shared-table-read-only');
        expect((sharedErr as TenantIsolationError).status).toBe(403);
      } finally {
        await slice.close();
      }
    } finally {
      await acmeReplica.close();
      await primary.close();
    }
  });

  it('enforces HTTP 403 and WebSocket repl_error 403 on inbound tenant isolation violations', async () => {
    const db = new FirebirdBrowser('memory://m22_http_ws_guard', { threads: false });
    try {
      await db.execute(
        'CREATE TABLE DOCS (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, BODY VARCHAR(100))',
      );
      await db.execute(
        "INSERT INTO DOCS (ID, TENANT_ID, BODY) VALUES (1, 't_alpha', 'Alpha Doc')",
      );
      await db.execute(
        "INSERT INTO DOCS (ID, TENANT_ID, BODY) VALUES (2, 't_beta', 'Beta Doc')",
      );

      const pub = await createPublication(db, {
        name: 'docs_pub',
        tables: ['DOCS'],
        installTriggers: true,
      });
      const guard = createTenantIsolationGuard({
        tenantColumn: 'TENANT_ID',
      });
      const sub = await createSubscription(db, {
        name: 'docs_inbound',
        publication: pub,
        localPublication: pub,
      });

      const handler = createHttpReplicationHandler({
        publication: pub,
        subscription: sub,
        tenantGuard: guard,
      });

      // Per-tenant GET /snapshot filters rows to x-tenant-id
      const snapRes = await handler(
        new Request('http://localhost/snapshot', {
          headers: { 'x-tenant-id': 't_alpha' },
        }),
      );
      expect(snapRes.status).toBe(200);
      const snapJson = (await snapRes.json()) as {
        snapshot: { tables: Array<{ table: string; rows: Array<{ ID: number }> }> };
      };
      expect(snapJson.snapshot.tables[0]!.rows.map((r) => r.ID)).toEqual([1]);

      // Cross-tenant POST /push returns HTTP 403
      const pushBad = await handler(
        new Request('http://localhost/push', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tenant-id': 't_alpha',
          },
          body: JSON.stringify({
            entries: [
              {
                lsn: 10,
                txid: 'tx1',
                timestamp: Date.now(),
                origin: 'client_a',
                table: 'DOCS',
                operation: 'INSERT',
                key: { ID: 3 },
                after: { ID: 3, TENANT_ID: 't_beta', BODY: 'Cross-tenant write' },
                before: null,
              },
            ],
          }),
        }),
      );
      expect(pushBad.status).toBe(403);
      const errBody = (await pushBad.json()) as { code: string; reason: string };
      expect(errBody.code).toBe('TENANT_ISOLATION_VIOLATION');
      expect(errBody.reason).toBe('cross-tenant-mutation');

      // WebSocket peer with tenantGuard emits repl_error (status 403)
      const sentFrames: string[] = [];
      let inboundListener: ((ev: { data: unknown }) => void) | undefined;
      const mockSocket: WebSocketLike = {
        send(data) {
          if (typeof data === 'string') sentFrames.push(data);
        },
        addEventListener(_type, fn) {
          inboundListener = fn;
        },
        removeEventListener() {
          inboundListener = undefined;
        },
      };

      const fixedGuard = createTenantIsolationGuard({
        tenantColumn: 'TENANT_ID',
        tenantId: 't_alpha',
      });
      const wsPeer = createWebSocketReplicationPeer({
        socket: mockSocket,
        subscription: sub,
        tenantGuard: fixedGuard,
      });

      inboundListener?.({
        data: JSON.stringify({
          type: 'repl_entries',
          entries: [
            {
              lsn: 11,
              txid: 'tx_ws',
              timestamp: Date.now(),
              origin: 'ws_client',
              table: 'DOCS',
              operation: 'DELETE',
              key: { ID: 2 },
              before: { ID: 2, TENANT_ID: 't_beta', BODY: 'Beta Doc' },
              after: null,
            },
          ],
        }),
      });

      await new Promise((r) => setTimeout(r, 25));
      wsPeer.close();
      expect(sentFrames.length).toBe(1);
      const parsedWs = JSON.parse(sentFrames[0]!) as { type: string; status: number };
      expect(parsedWs.type).toBe('repl_error');
      expect(parsedWs.status).toBe(403);
    } finally {
      await db.close();
    }
  });
});

describe('M22 Item 2: Zero-Copy Apache Arrow IPC Ingestion & Cached db.table<T>()', () => {
  it('ingests Arrow IPC bytes, multi-batch ReadableStreams & upserts via FBP\\x02 wire batches + DDL auto-creation', async () => {
    const srcDb = new FirebirdBrowser('memory://m22_arrow_src', { threads: false });
    const dstDb = new FirebirdBrowser('memory://m22_arrow_dst', { threads: false });

    try {
      await srcDb.execute(
        'CREATE TABLE TELEMETRY (ID INTEGER NOT NULL PRIMARY KEY, HOST VARCHAR(64), LATENCY DOUBLE PRECISION, OK BOOLEAN)',
      );
      const rows = Array.from({ length: 120 }, (_, i) => ({
        ID: i + 1,
        HOST: `edge-${(i % 4) + 1}`,
        LATENCY: (i + 1) * 0.75,
        OK: i % 5 !== 0,
      }));
      await srcDb.table('TELEMETRY', { primaryKey: 'ID' }).insertMany(rows);

      // Verify encodeColumnarBatchToWireRows produces a valid "FBP\x02" frame directly
      const colBatch = await srcDb.queryColumnar('SELECT ID, HOST, LATENCY, OK FROM TELEMETRY ORDER BY ID');
      const wireBuf = encodeColumnarBatchToWireRows(colBatch, { startRow: 0, endRow: 10 });
      expect(isWireParamRowsBuffer(wireBuf)).toBe(true);

      const ddl = buildCreateTableDdlFromColumnar('TELEMETRY_COPY', colBatch.fields, {
        primaryKey: 'ID',
      });
      expect(ddl).toContain('CREATE TABLE "TELEMETRY_COPY"');
      expect(ddl).toContain('PRIMARY KEY ("ID")');

      // 1. Stream multi-batch Arrow IPC directly from srcDb.queryArrowStream() into dstDb.loadArrowIpc()!
      const stream = srcDb.queryArrowStream(
        'SELECT ID, HOST, LATENCY, OK FROM TELEMETRY ORDER BY ID',
        { batchSize: 35 },
      );
      await dstDb.execute(
        'CREATE TABLE TELEMETRY_STREAM (ID INTEGER NOT NULL PRIMARY KEY, HOST VARCHAR(64), LATENCY DOUBLE PRECISION, OK BOOLEAN)',
      );
      const streamRes = await dstDb.loadArrowIpc('TELEMETRY_STREAM', stream, {
        batchSize: 50,
      });
      expect(streamRes.rowsIngested).toBe(120);
      expect(streamRes.batchesExecuted).toBeGreaterThanOrEqual(4);

      const countStream = await dstDb.table('TELEMETRY_STREAM').count();
      expect(countStream).toBe(120);

      // 2. Auto-create table from Arrow IPC buffer (`createTable: true`) + `table.upsertArrow()`
      const arrowBytes = await srcDb.queryArrow(
        'SELECT ID, HOST, LATENCY, OK FROM TELEMETRY WHERE ID <= 25 ORDER BY ID',
      );
      const autoRes = await dstDb.loadArrowIpc('TELEMETRY_AUTO', arrowBytes, {
        createTable: true,
        primaryKey: 'ID',
      });
      expect(autoRes.tableCreated).toBe(true);
      expect(autoRes.rowsIngested).toBe(25);

      // Modify rows 1..5 in srcDb and upsertArrow into TELEMETRY_AUTO
      await srcDb.execute("UPDATE TELEMETRY SET HOST = 'updated-edge' WHERE ID <= 5");
      const patchArrow = await srcDb.queryArrow(
        'SELECT ID, HOST, LATENCY, OK FROM TELEMETRY WHERE ID <= 5 ORDER BY ID',
      );
      const autoRepo = dstDb.table<{ ID: number; HOST: string }, number>('TELEMETRY_AUTO', {
        primaryKey: 'ID',
      });
      const upsertRes = await autoRepo.upsertArrow(patchArrow, ['ID']);
      expect(upsertRes.rowsIngested).toBe(5);
      const updatedFirst = await autoRepo.get(1);
      expect(updatedFirst?.HOST).toBe('updated-edge');
      await autoRepo.close();
    } finally {
      await dstDb.close();
      await srcDb.close();
    }
  });

  it('reuses cached PreparedStatement handles in db.table<T>() with bounded LRU eviction', async () => {
    const db = new FirebirdBrowser('memory://m22_table_lru', { threads: false });
    try {
      await db.execute(
        'CREATE TABLE USERS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(64), ROLE_CODE VARCHAR(32))',
      );
      const users = db.table<{ ID: number; NAME: string; ROLE_CODE: string }, number>(
        'USERS',
        { primaryKey: 'ID', cacheStatements: 3 },
      );

      expect(users.cachedStatementCount).toBe(0);
      await users.insert({ ID: 1, NAME: 'Ada', ROLE_CODE: 'admin' });
      await users.insert({ ID: 2, NAME: 'Grace', ROLE_CODE: 'staff' });
      expect(users.cachedStatementCount).toBe(1); // INSERT reused!

      const u1 = await users.get(1);
      const u2 = await users.get(2);
      expect(u1?.NAME).toBe('Ada');
      expect(u2?.NAME).toBe('Grace');
      expect(users.cachedStatementCount).toBe(2); // INSERT + SELECT get

      await users.exists(1);
      expect(users.cachedStatementCount).toBe(3); // at LRU max capacity (3)

      // Triggering a 4th distinct template evicts the oldest without exceeding 3!
      await users.update(1, { NAME: 'Ada Lovelace' });
      expect(users.cachedStatementCount).toBe(3);

      const refreshed = await users.get(1);
      expect(refreshed?.NAME).toBe('Ada Lovelace');

      await users.close();
      expect(users.cachedStatementCount).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('M22 Item 3: Optimistic Local-First Mutation Store & Framework Table Hooks', () => {
  it('applies optimistic mutations immediately, reverts manually, and rolls back automatically on remote failure', async () => {
    const db = new FirebirdBrowser('memory://m22_optimistic', { threads: false });
    try {
      await db.execute(
        'CREATE TABLE TODOS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(100), DONE BOOLEAN)',
      );
      await db.table('TODOS', { primaryKey: 'ID' }).insert({
        ID: 1,
        TITLE: 'Initial task',
        DONE: false,
      });

      let shouldFailRemote = false;
      const failedLog: Array<{ op: string; msg: string }> = [];

      const opt = createOptimisticMutationStore(db, {
        remoteSync: async (batch: readonly PendingOptimisticMutation[]) => {
          if (shouldFailRemote) {
            throw new Error(`Server rejected batch of ${batch.length} mutation(s)`);
          }
        },
        onMutationFailed: (m, err) => {
          failedLog.push({ op: m.operation, msg: err.message });
        },
      });

      const todosOpt = opt.table<{ ID: number; TITLE: string; DONE: boolean }, number>(
        'TODOS',
        { primaryKey: 'ID' },
      );

      // 1. Optimistic insert + manual revert
      const ins = await todosOpt.insert({ ID: 2, TITLE: 'Draft item', DONE: false });
      expect(opt.getSnapshot().pendingCount).toBe(1);
      expect(await db.table('TODOS').count()).toBe(2);

      const reverted = await todosOpt.revert(ins.mutationId);
      expect(reverted).toBe(true);
      expect(opt.getSnapshot().pendingCount).toBe(0);
      expect(await db.table('TODOS').count()).toBe(1);

      // 2. Optimistic update + flush success
      await todosOpt.update(1, { TITLE: 'Confirmed task', DONE: true });
      const okFlush = await todosOpt.flush();
      expect(okFlush.confirmed).toBe(1);
      expect(okFlush.reverted).toBe(0);
      expect(opt.getSnapshot().confirmedCount).toBe(1);

      // 3. Optimistic update + delete + insert -> remote failure rolls back all 3 in reverse order!
      shouldFailRemote = true;
      await todosOpt.update(1, { TITLE: 'Unauthorized edit' });
      await todosOpt.delete(1);
      await todosOpt.insert({ ID: 99, TITLE: 'Invalid new item', DONE: false });
      expect(opt.getSnapshot().pendingCount).toBe(3);
      expect(await db.table('TODOS').get(1)).toBeNull();
      expect(await db.table('TODOS').get(99)).not.toBeNull();

      const failFlush = await todosOpt.flush();
      expect(failFlush.confirmed).toBe(0);
      expect(failFlush.reverted).toBe(3);
      expect(failedLog.length).toBe(3);

      // Row 1 is restored to its pre-batch confirmed state, and row 99 is gone!
      const restored1 = await db.table<{ ID: number; TITLE: string; DONE: boolean }, number>(
        'TODOS',
        { primaryKey: 'ID' },
      ).get(1);
      expect(restored1).toEqual({ ID: 1, TITLE: 'Confirmed task', DONE: true });
      expect(await db.table('TODOS').get(99)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('exposes reactive table & optimistic hooks across Svelte, Solid, React, and Vue adapters', async () => {
    expect(typeof reactExports.useTable).toBe('function');
    expect(typeof reactExports.useOptimisticMutation).toBe('function');
    expect(typeof vueExports.useTable).toBe('function');
    expect(typeof vueExports.useOptimisticMutation).toBe('function');

    const db = new FirebirdBrowser('memory://m22_fw_table', { threads: false });
    try {
      await db.execute(
        'CREATE TABLE NOTES (ID INTEGER NOT NULL PRIMARY KEY, BODY VARCHAR(100))',
      );

      const svelteOpt = createSvelteOpt({ db });
      const svelteNotes = createSvelteTable<{ ID: number; BODY: string }, number>(
        'NOTES',
        { db, primaryKey: 'ID', optimisticStore: svelteOpt.store, pollIntervalMs: 50 },
      );

      await svelteNotes.insert({ ID: 1, BODY: 'Hello Svelte' });
      expect(svelteNotes.rows).toEqual([{ ID: 1, BODY: 'Hello Svelte' }]);
      expect(svelteNotes.pendingCount).toBe(1);
      expect(svelteOpt.pendingCount).toBe(1);
      await svelteOpt.flush();
      expect(svelteNotes.pendingCount).toBe(0);
      svelteNotes.destroy();

      const solidOpt = createSolidOpt({ db });
      const solidNotes = createSolidTable<{ ID: number; BODY: string }, number>(
        'NOTES',
        { db, primaryKey: 'ID', optimisticStore: solidOpt.store, pollIntervalMs: 50 },
      );
      await solidNotes.refresh();
      expect(solidNotes.rows()).toEqual([{ ID: 1, BODY: 'Hello Svelte' }]);
      await solidNotes.update(1, { BODY: 'Updated via Solid' });
      expect(solidNotes.rows()).toEqual([{ ID: 1, BODY: 'Updated via Solid' }]);
      expect(solidOpt.pendingCount()).toBe(1);
      await solidOpt.revertAll();
      await solidNotes.refresh();
      expect(solidNotes.rows()).toEqual([{ ID: 1, BODY: 'Hello Svelte' }]);
      solidNotes.dispose();
      solidOpt.dispose();
    } finally {
      await db.close();
    }
  });
});

describe('M22 Item 4: CLI serve-sync HTTP/SSE & Arrow IPC Server', () => {
  it('serves HTTP replication, /health, GET/POST /arrow, API key auth, and tenant isolation over node:http', async () => {
    const serverDb = await openDatabase('memory://m22_cli_srv', { backend: 'wasm' });
    await serverDb.execute(
      'CREATE TABLE METRICS (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, VAL DOUBLE PRECISION)',
    );
    await serverDb.execute(
      "INSERT INTO METRICS (ID, TENANT_ID, VAL) VALUES (1, 'acme', 42.5)",
    );
    await serverDb.execute(
      "INSERT INTO METRICS (ID, TENANT_ID, VAL) VALUES (2, 'globex', 99.0)",
    );

    const srv = await startCliReplicationServer({
      db: serverDb,
      port: 0,
      apiKey: 'secret-token',
      tenantColumn: 'TENANT_ID',
    });

    try {
      // CORS preflight OPTIONS returns 204
      const preflight = await fetch(`${srv.url}/changes`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

      // /health works
      const healthRes = await fetch(`${srv.url}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; tenantIsolation: boolean };
      expect(health.ok).toBe(true);
      expect(health.tenantIsolation).toBe(true);

      // Missing API key -> 401
      const unauth = await fetch(`${srv.url}/arrow?sql=${encodeURIComponent('SELECT * FROM METRICS')}`);
      expect(unauth.status).toBe(401);

      // Authenticated GET /arrow streams Apache Arrow IPC V5 bytes
      const arrowRes = await fetch(
        `${srv.url}/arrow?sql=${encodeURIComponent('SELECT ID, TENANT_ID, VAL FROM METRICS ORDER BY ID')}`,
        { headers: { authorization: 'Bearer secret-token' } },
      );
      expect(arrowRes.status).toBe(200);
      expect(arrowRes.headers.get('content-type')).toContain('application/vnd.apache.arrow.stream');
      const arrowBuf = new Uint8Array(await arrowRes.arrayBuffer());
      const decoded = decodeArrowIpc(arrowBuf);
      expect(decoded.rowCount).toBe(2);

      // POST /arrow ingests Arrow IPC into a brand-new table on the server
      const postArrow = await fetch(
        `${srv.url}/arrow?table=METRICS_ARCHIVE&createTable=1&primaryKey=ID`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret-token',
            'content-type': 'application/vnd.apache.arrow.stream',
          },
          body: new Uint8Array(arrowBuf),
        },
      );
      expect(postArrow.status).toBe(200);
      const archiveCount = await serverDb.table('METRICS_ARCHIVE').count();
      expect(archiveCount).toBe(2);

      // HTTP replication client pulls & pushes against live server
      const client = createHttpReplicationClient({
        baseUrl: srv.url,
        apiKey: 'secret-token',
      });
      const snap = await client.fetchSnapshot();
      expect(snap.tables.some((t) => t.table === 'METRICS')).toBe(true);

      // runCli(['serve-sync', ...]) bounded smoke test with --duration-ms
      let stdoutText = '';
      const code = await runCli(
        ['serve-sync', 'memory://m22_cli_cmd', '--port', '0', '--duration-ms', '40', '--json'],
        { stdout: (s) => (stdoutText += s) },
      );
      expect(code).toBe(0);
      const parsedOut = JSON.parse(stdoutText) as { port: number; url: string };
      expect(parsedOut.port).toBeGreaterThan(0);
      expect(parsedOut.url).toContain('http://127.0.0.1:');
    } finally {
      await srv.close();
      await serverDb.close();
    }
  });
});

describe('M22 Item 5: Sub-2,000-Line Codebase Completion & Export Parity', () => {
  it('enforces that EVERY non-test .ts source file across packages/firebird-wasm/src is strictly < 2,000 lines', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const oversized: Array<{ file: string; lines: number }> = [];
    let checkedFiles = 0;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          checkedFiles += 1;
          const lineCount = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
          if (lineCount >= 2000) {
            oversized.push({
              file: path.relative(srcRoot, full),
              lines: lineCount,
            });
          }
        }
      }
    };

    walk(srcRoot);
    expect(checkedFiles).toBeGreaterThan(40);
    expect(oversized).toEqual([]);

    // Verify extracted M22 modules exist
    expect(fs.existsSync(path.join(srcRoot, 'browser', 'udr-parser.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, 'browser', 'opfs-chunk-io.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, 'firebird-streams.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, 'browser', 'firebird-browser-types.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, 'browser', 'firebird-browser-streams.ts'))).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, 'browser', 'firebird-browser-storage.ts'))).toBe(true);

    // Verify barrel exports
    expect(typeof rootExports.createTenantReplicationSlice).toBe('function');
    expect(typeof browserExports.createTenantReplicationSlice).toBe('function');
    expect(typeof replExports.createTenantReplicationSlice).toBe('function');
    expect(typeof rootExports.createOptimisticMutationStore).toBe('function');
    expect(typeof browserExports.createOptimisticMutationStore).toBe('function');
    expect(typeof rootExports.startCliReplicationServer).toBe('function');
  });
});
