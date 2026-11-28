/**
 * M30 Feature Suite:
 * 1. System-Versioned Bitemporal History Tables (`createTemporalTable`, `rewriteTemporalSql`, `listTemporalTables`)
 * 2. Append-Only Event Sourcing Store, Snapshots & CQRS Projections (`createEventStore`, `ConcurrencyConflictError`, CLI `projections`)
 * 3. Zero-Code Introspected GraphQL & RESTful JSON Gateway (`createAutoApiGateway`, CLI `serve-api`)
 * 4. Multi-Database `ATTACH` Cross-DB SQL Federation & Sharded Scatter-Gather (`createDatabaseFederation`, `createShardedPool`)
 * 5. Strict Sub-1,000-Line Source File Modularity Invariant across `packages/firebird-wasm/src`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ConcurrencyConflictError,
  DEFAULT_EVENT_PROJECTIONS_TABLE,
  DEFAULT_EVENT_SNAPSHOTS_TABLE,
  DEFAULT_EVENT_STORE_TABLE,
  DEFAULT_TEMPORAL_META_TABLE,
  FirebirdBrowser,
  TEMPORAL_INFINITY_MS,
  createAutoApiGateway,
  createDatabaseFederation,
  createEventStore,
  createShardedPool,
  createTemporalTable,
  fetchPersistedEventProjections,
  fnv1aHash32,
  listTemporalTables,
  parseTemporalTimestampMs,
  rewriteTemporalSql,
  signSyncJwt,
} from '../browser';
import { runCli } from '../cli';

describe('M30: Bitemporal History Tables, Event Sourcing & CQRS Projections, Auto-GraphQL/REST Gateway, Cross-DB Federation & Sub-1,000-Line Modularity', () => {
  it('enforces strict < 1,000-line source modularity across every non-test .ts file in src/', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const oversized: string[] = [];

    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== '__tests__') walk(full);
        } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
          const lineCount = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
          if (lineCount >= 1000) {
            oversized.push(`${path.relative(srcRoot, full)} (${lineCount} lines)`);
          }
        }
      }
    };

    walk(srcRoot);
    expect(oversized).toEqual([]);
  });

  it('M30 Item 1: captures system-versioned PSQL history, queries FOR SYSTEM_TIME AS OF / BETWEEN, diffs row revisions, reverts rows & prunes history', async () => {
    expect(parseTemporalTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseTemporalTimestampMs('2026-01-01T00:00:00.000Z')).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );

    const db = new FirebirdBrowser('memory://m30-temporal', { autoPersist: false });
    try {
      await db.execute(
        'CREATE TABLE CONTRACTS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(80) NOT NULL, AMOUNT INTEGER NOT NULL)',
      );
      await db.execute("INSERT INTO CONTRACTS (ID, TITLE, AMOUNT) VALUES (1, 'Seed Plan', 100)");

      const temporal = createTemporalTable<{ ID: number; TITLE: string; AMOUNT: number }>(db, {
        table: 'CONTRACTS',
        primaryKey: 'ID',
        initialNowMs: 1_000,
      });
      const info = await temporal.enable();
      expect(info.tableName).toBe('CONTRACTS');
      expect(info.historyTable).toBe('FB_THIST$CONTRACTS');
      expect(info.versionCount).toBe(1);
      expect(DEFAULT_TEMPORAL_META_TABLE).toBe('FB_TEMPORAL_META$');
      expect(TEMPORAL_INFINITY_MS).toBeGreaterThan(1_000_000_000_000);

      // T = 2000: insert #2 and update #1
      await temporal.setSystemTime(2_000);
      await db.execute("INSERT INTO CONTRACTS (ID, TITLE, AMOUNT) VALUES (2, 'Addon SLA', 50)");
      await db.execute('UPDATE CONTRACTS SET AMOUNT = 250 WHERE ID = 1');

      // T = 3000: delete #2
      await temporal.setSystemTime(3_000);
      await db.execute('DELETE FROM CONTRACTS WHERE ID = 2');

      // Point-in-time queries via queryAsOf()
      const at1500 = await temporal.queryAsOf(1_500);
      expect(at1500).toEqual([{ ID: 1, TITLE: 'Seed Plan', AMOUNT: 100 }]);

      const at2500 = await temporal.queryAsOf(2_500);
      expect(at2500).toEqual([
        { ID: 1, TITLE: 'Seed Plan', AMOUNT: 250 },
        { ID: 2, TITLE: 'Addon SLA', AMOUNT: 50 },
      ]);

      const at3500 = await temporal.queryAsOf(3_500);
      expect(at3500).toEqual([{ ID: 1, TITLE: 'Seed Plan', AMOUNT: 250 }]);

      // Interval overlap via queryBetween()
      const between = await temporal.queryBetween(1_500, 2_500);
      expect(between.map((r) => ({ id: r.ID, amount: r.AMOUNT }))).toEqual([
        { id: 1, amount: 100 },
        { id: 2, amount: 50 },
        { id: 1, amount: 250 },
      ]);

      // SQL:2011 FOR SYSTEM_TIME AS OF & BETWEEN query rewriter
      const asOfSql = rewriteTemporalSql(
        'SELECT ID, TITLE, AMOUNT FROM CONTRACTS FOR SYSTEM_TIME AS OF 1500 ORDER BY ID',
      );
      const asOfRes = await db.query<{ ID: number; TITLE: string; AMOUNT: number }>(asOfSql);
      expect(asOfRes.rows).toEqual([{ ID: 1, TITLE: 'Seed Plan', AMOUNT: 100 }]);

      const betweenSql = rewriteTemporalSql(
        'SELECT ID, AMOUNT FROM CONTRACTS FOR SYSTEM_TIME BETWEEN 1500 AND 2500 WHERE HIST_OP <> \'DELETE\' ORDER BY SYS_START_MS ASC, ID ASC',
      );
      const betweenRes = await db.query<{ ID: number; AMOUNT: number }>(betweenSql);
      expect(betweenRes.rows).toEqual([
        { ID: 1, AMOUNT: 100 },
        { ID: 1, AMOUNT: 250 },
        { ID: 2, AMOUNT: 50 },
      ]);

      // Row-level revision diffing
      const diffs1 = await temporal.diffRowHistory(1);
      expect(diffs1).toHaveLength(2);
      expect(diffs1[0]?.op).toBe('INSERT');
      expect(diffs1[1]?.op).toBe('UPDATE');
      expect(diffs1[1]?.changedColumns).toEqual(['AMOUNT']);

      // Revert row #1 back to T=1500 and resurrect deleted row #2 from T=2500
      await temporal.setSystemTime(4_000);
      const rev1 = await temporal.revertRowAsOf(1, 1_500);
      expect(rev1.action).toBe('restored');
      expect(rev1.row?.AMOUNT).toBe(100);

      const rev2 = await temporal.revertRowAsOf(2, 2_500);
      expect(rev2.action).toBe('restored');
      const liveNow = await db.query<{ ID: number; AMOUNT: number }>(
        'SELECT ID, AMOUNT FROM CONTRACTS ORDER BY ID',
      );
      expect(liveNow.rows).toEqual([
        { ID: 1, AMOUNT: 100 },
        { ID: 2, AMOUNT: 50 },
      ]);

      // Retention pruning of closed versions ending <= 2500
      const pruned = await temporal.pruneHistoryBefore(2_500);
      expect(pruned.deletedVersions).toBeGreaterThanOrEqual(1);

      const listed = await listTemporalTables(db);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.tableName).toBe('CONTRACTS');

      await temporal.disable();
    } finally {
      await db.close();
    }
  });

  it('M30 Item 2: enforces optimistic concurrency, upcasts events, auto-snapshots aggregates, runs & rebuilds CQRS projections + CLI projections', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m30-ev-'));
    const dbFile = path.join(tmpDir, 'events.fdb');
    const db = new FirebirdBrowser('memory://m30-eventstore', { autoPersist: false });
    try {
      expect(DEFAULT_EVENT_STORE_TABLE).toBe('FB_EVENT_STORE$');
      expect(DEFAULT_EVENT_SNAPSHOTS_TABLE).toBe('FB_EVENT_SNAPSHOTS$');
      expect(DEFAULT_EVENT_PROJECTIONS_TABLE).toBe('FB_EVENT_PROJECTIONS$');

      await db.execute(
        'CREATE TABLE ACCOUNT_BALANCES (ACCOUNT_ID VARCHAR(64) NOT NULL PRIMARY KEY, BALANCE INTEGER NOT NULL, CURRENCY VARCHAR(8) NOT NULL)',
      );

      const store = createEventStore(db, {
        upcasters: {
          'AccountOpened.v1': (payload, meta) => ({
            type: 'AccountOpened.v2',
            payload: { ...payload, currency: payload.currency ?? 'EUR' },
            metadata: { ...meta, upcastedFrom: 'v1' },
          }),
        },
      });

      const appended1 = await store.appendToStream(
        'acct-1',
        [
          { type: 'AccountOpened.v1', payload: { initialDeposit: 100 } },
          { type: 'FundsDeposited', payload: { amount: 50 } },
        ],
        { expectedVersion: 'no_stream' },
      );
      expect(appended1.streamVersion).toBe(2);

      // Optimistic concurrency guards
      await expect(
        store.appendToStream('acct-1', [{ type: 'FundsDeposited', payload: { amount: 10 } }], {
          expectedVersion: 'no_stream',
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      await expect(
        store.appendToStream('acct-1', [{ type: 'FundsDeposited', payload: { amount: 10 } }], {
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      await store.appendToStream(
        'acct-1',
        [{ type: 'FundsWithdrawn', payload: { amount: 30 } }],
        { expectedVersion: 2 },
      );

      // Upcaster verification on readStream
      const events = await store.readStream('acct-1');
      expect(events).toHaveLength(3);
      expect(events[0]?.type).toBe('AccountOpened.v2');
      expect((events[0]?.payload as { currency: string }).currency).toBe('EUR');

      // Aggregate loading + snapshotEvery auto-snapshotting
      type AccountState = { balance: number; currency: string };
      const reducer = (state: AccountState, ev: (typeof events)[number]): AccountState => {
        const p = ev.payload as Record<string, unknown>;
        if (ev.type === 'AccountOpened.v2') {
          return {
            balance: Number(p.initialDeposit ?? 0),
            currency: String(p.currency ?? 'USD'),
          };
        }
        if (ev.type === 'FundsDeposited') {
          return { ...state, balance: state.balance + Number(p.amount ?? 0) };
        }
        if (ev.type === 'FundsWithdrawn') {
          return { ...state, balance: state.balance - Number(p.amount ?? 0) };
        }
        return state;
      };

      const agg1 = await store.loadAggregate(
        'acct-1',
        reducer,
        { balance: 0, currency: 'USD' },
        { snapshotEvery: 2 },
      );
      expect(agg1).toEqual({
        state: { balance: 120, currency: 'EUR' },
        version: 3,
        eventsReplayed: 3,
        fromSnapshot: false,
      });

      const snap = await store.getSnapshot<AccountState>('acct-1');
      expect(snap?.version).toBe(3);

      // Append 1 more event -> loadAggregate replays ONLY 1 delta event from snapshot!
      await store.appendToStream(
        'acct-1',
        [{ type: 'FundsDeposited', payload: { amount: 25 } }],
        { expectedVersion: 3 },
      );
      const agg2 = await store.loadAggregate('acct-1', reducer, { balance: 0, currency: 'USD' });
      expect(agg2).toEqual({
        state: { balance: 145, currency: 'EUR' },
        version: 4,
        eventsReplayed: 1,
        fromSnapshot: true,
      });

      // Checkpointed CQRS projector + rebuild
      store.registerProjection({
        name: 'account_balances_view',
        reset: async (runner) => {
          await runner.execute!('DELETE FROM ACCOUNT_BALANCES');
        },
        handler: async (ev, runner) => {
          const p = ev.payload as Record<string, unknown>;
          if (ev.type === 'AccountOpened.v2') {
            await runner.execute!(
              'UPDATE OR INSERT INTO ACCOUNT_BALANCES (ACCOUNT_ID, BALANCE, CURRENCY) VALUES (?, ?, ?) MATCHING (ACCOUNT_ID)',
              [ev.streamId, Number(p.initialDeposit ?? 0), String(p.currency ?? 'EUR')],
            );
          } else if (ev.type === 'FundsDeposited') {
            await runner.execute!(
              'UPDATE ACCOUNT_BALANCES SET BALANCE = BALANCE + ? WHERE ACCOUNT_ID = ?',
              [Number(p.amount ?? 0), ev.streamId],
            );
          } else if (ev.type === 'FundsWithdrawn') {
            await runner.execute!(
              'UPDATE ACCOUNT_BALANCES SET BALANCE = BALANCE - ? WHERE ACCOUNT_ID = ?',
              [Number(p.amount ?? 0), ev.streamId],
            );
          }
        },
      });

      const projRun = await store.runProjections();
      expect(projRun.processedEvents).toBe(4);
      const balRow = await db.query<{ BALANCE: number; CURRENCY: string }>(
        "SELECT BALANCE, CURRENCY FROM ACCOUNT_BALANCES WHERE ACCOUNT_ID = 'acct-1'",
      );
      expect(balRow.rows[0]).toEqual({ BALANCE: 145, CURRENCY: 'EUR' });

      const statuses = await fetchPersistedEventProjections(db);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.name).toBe('account_balances_view');
      expect(statuses[0]?.lagEvents).toBe(0);
      expect(statuses[0]?.processedCount).toBe(4);

      const rebuilt = await store.rebuildProjection('account_balances_view');
      expect(rebuilt.processedEvents).toBe(4);

      // Persist .fdb to disk and test CLI `projections --json`
      const exported = await db.dumpDataDir();
      fs.writeFileSync(dbFile, exported);

      let cliOut = '';
      const code = await runCli(['projections', dbFile, '--json', '--backend', 'wasm'], {
        stdout: (s) => {
          cliOut += s;
        },
        stderr: () => {},
      });
      expect(code).toBe(0);
      const parsedCli = JSON.parse(cliOut) as { projections: Array<{ name: string; lagEvents: number }> };
      expect(parsedCli.projections[0]?.name).toBe('account_balances_view');
      expect(parsedCli.projections[0]?.lagEvents).toBe(0);

      store.dispose();
    } finally {
      await db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('M30 Item 3: serves introspected GraphQL (with DataLoader FK batching & mutations), REST CRUD, JWT rls & OpenAPI 3.1 + CLI serve-api', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m30-api-'));
    const dbFile = path.join(tmpDir, 'api.fdb');
    const db = new FirebirdBrowser('memory://m30-auto-api', { autoPersist: false });
    try {
      await db.execute(
        'CREATE TABLE CUSTOMERS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(64) NOT NULL, TENANT_ID VARCHAR(32) NOT NULL)',
      );
      await db.execute(
        'CREATE TABLE INVOICES (ID INTEGER NOT NULL PRIMARY KEY, CUSTOMER_ID INTEGER NOT NULL REFERENCES CUSTOMERS(ID), TOTAL INTEGER NOT NULL, TENANT_ID VARCHAR(32) NOT NULL)',
      );

      await db.execBatch('INSERT INTO CUSTOMERS (ID, NAME, TENANT_ID) VALUES (?, ?, ?)', [
        [1, 'Acme Corp', 'acme'],
        [2, 'Globex Inc', 'globex'],
        [3, 'Acme Labs', 'acme'],
      ]);
      await db.execBatch(
        'INSERT INTO INVOICES (ID, CUSTOMER_ID, TOTAL, TENANT_ID) VALUES (?, ?, ?, ?)',
        [
          [101, 1, 500, 'acme'],
          [102, 1, 300, 'acme'],
          [103, 2, 900, 'globex'],
        ],
      );

      const secret = 'm30-auto-api-jwt-secret-key-32b!!';
      const gateway = createAutoApiGateway(db);

      // Warm up schema cache before counting N+1 queries
      const sdl = await gateway.getGraphqlSdl();
      expect(sdl).toContain('type Customers');
      expect(sdl).toContain('invoicesList');
      expect(sdl).toContain('customer: Customers');

      // Track SQL SELECT queries to prove DataLoader FK batching (2 queries, NOT 1 + 3 = 4!)
      const executedSelects: string[] = [];
      const unsub = db.onQuery((ev) => {
        if (/^\s*SELECT\b/i.test(ev.sql)) executedSelects.push(ev.sql);
      });

      const gqlRes = await gateway.fetch(
        new Request('http://edge.local/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{
              customers(orderBy: "ID ASC") {
                id
                name
                invoicesList { id total }
              }
            }`,
          }),
        }),
      );
      unsub();

      expect(gqlRes.status).toBe(200);
      const gqlBody = (await gqlRes.json()) as {
        data: { customers: Array<{ id: number; name: string; invoicesList: Array<{ id: number; total: number }> }> };
      };
      expect(gqlBody.data.customers).toHaveLength(3);
      expect(gqlBody.data.customers[0]?.invoicesList).toEqual([
        { id: 101, total: 500 },
        { id: 102, total: 300 },
      ]);
      // Exactly 2 SELECTs: 1 for CUSTOMERS + 1 batched `WHERE "CUSTOMER_ID" IN (?, ?, ?)`!
      expect(executedSelects).toHaveLength(2);
      expect(executedSelects[1]).toContain('IN (');

      // GraphQL mutation (insert + update + delete)
      const mutRes = await gateway.fetch(
        new Request('http://edge.local/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `mutation {
              insertCustomers(input: { id: 4, name: "Initech", tenantId: "acme" }) {
                id
                name
              }
            }`,
          }),
        }),
      );
      const mutJson = (await mutRes.json()) as {
        data: { insertCustomers: { id: number; name: string } };
      };
      expect(mutJson.data.insertCustomers).toEqual({ id: 4, name: 'Initech' });

      // REST CRUD endpoints
      const restList = await gateway.fetch(
        new Request('http://edge.local/rest/CUSTOMERS?TENANT_ID=globex&orderBy=ID'),
      );
      const restListJson = (await restList.json()) as { rows: Array<{ ID: number; NAME: string }> };
      expect(restListJson.rows).toEqual([{ ID: 2, NAME: 'Globex Inc', TENANT_ID: 'globex' }]);

      const patchRes = await gateway.fetch(
        new Request('http://edge.local/rest/CUSTOMERS/4', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ NAME: 'Initech Updated' }),
        }),
      );
      expect(patchRes.status).toBe(200);

      const delRes = await gateway.fetch(
        new Request('http://edge.local/rest/CUSTOMERS/4', { method: 'DELETE' }),
      );
      expect(delRes.status).toBe(200);

      // JWT RLS & reader role enforcement
      const guarded = createAutoApiGateway(db, { jwtSecret: secret });
      const readerJwt = await signSyncJwt(
        {
          sub: 'reader-acme',
          role: 'reader',
          rls: { CUSTOMERS: { TENANT_ID: 'acme' } },
        },
        secret,
      );

      const rlsGet = await guarded.fetch(
        new Request('http://edge.local/rest/CUSTOMERS?orderBy=ID', {
          headers: { Authorization: `Bearer ${readerJwt}` },
        }),
      );
      const rlsJson = (await rlsGet.json()) as { rows: Array<{ ID: number; TENANT_ID: string }> };
      expect(rlsJson.rows.map((r) => r.ID)).toEqual([1, 3]);

      const rlsWriteBlocked = await guarded.fetch(
        new Request('http://edge.local/rest/CUSTOMERS', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${readerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ID: 99, NAME: 'Blocked', TENANT_ID: 'acme' }),
        }),
      );
      expect(rlsWriteBlocked.status).toBe(403);

      // OpenAPI 3.1 document + CLI `serve-api --openapi` / `--sdl`
      const oaRes = await gateway.fetch(new Request('http://edge.local/openapi.json'));
      const oaDoc = (await oaRes.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(oaDoc.openapi).toBe('3.1.0');
      expect(oaDoc.paths['/rest/customers']).toBeDefined();

      fs.writeFileSync(dbFile, await db.dumpDataDir());
      let cliSdl = '';
      const sdlCode = await runCli(['serve-api', dbFile, '--sdl', '--backend', 'wasm'], {
        stdout: (s) => {
          cliSdl += s;
        },
        stderr: () => {},
      });
      expect(sdlCode).toBe(0);
      expect(cliSdl).toContain('type Customers');
    } finally {
      await db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('M30 Item 4: executes cross-DB ATTACH SQL joins (`createDatabaseFederation`) & scatter-gather sharded queries + rebalancing (`createShardedPool`)', async () => {
    const primaryDb = new FirebirdBrowser('memory://m30-fed-primary', { autoPersist: false });
    const analyticsDb = new FirebirdBrowser('memory://m30-fed-analytics', { autoPersist: false });
    const shard0 = new FirebirdBrowser('memory://m30-shard-0', { autoPersist: false });
    const shard1 = new FirebirdBrowser('memory://m30-shard-1', { autoPersist: false });
    const shard2 = new FirebirdBrowser('memory://m30-shard-2', { autoPersist: false });

    try {
      await primaryDb.execute(
        'CREATE TABLE ORDERS (ID INTEGER NOT NULL PRIMARY KEY, CUSTOMER VARCHAR(64) NOT NULL, TOTAL INTEGER NOT NULL)',
      );
      await primaryDb.execBatch('INSERT INTO ORDERS (ID, CUSTOMER, TOTAL) VALUES (?, ?, ?)', [
        [1, 'Ada', 120],
        [2, 'Grace', 340],
      ]);

      await analyticsDb.execute(
        'CREATE TABLE ORDER_CLICKS (ORDER_ID INTEGER NOT NULL PRIMARY KEY, CLICKS INTEGER NOT NULL)',
      );
      await analyticsDb.execBatch('INSERT INTO ORDER_CLICKS (ORDER_ID, CLICKS) VALUES (?, ?)', [
        [1, 9],
        [2, 24],
      ]);

      const fed = createDatabaseFederation(primaryDb);
      await fed.attach('analytics', analyticsDb);
      await fed.execute("ATTACH 'memory://m30-fed-ephemeral' AS scratch");
      expect(fed.listAttached().map((a) => a.alias)).toEqual(['ANALYTICS', 'SCRATCH']);

      const joined = await fed.query<{ CUSTOMER: string; TOTAL: number; CLICKS: number }>(
        `SELECT o.CUSTOMER, o.TOTAL, c.CLICKS
         FROM ORDERS o
         JOIN analytics.ORDER_CLICKS c ON o.ID = c.ORDER_ID
         ORDER BY c.CLICKS DESC`,
      );
      expect(joined.rows).toEqual([
        { CUSTOMER: 'Grace', TOTAL: 340, CLICKS: 24 },
        { CUSTOMER: 'Ada', TOTAL: 120, CLICKS: 9 },
      ]);

      await fed.execute('DETACH scratch');
      expect(fed.listAttached().map((a) => a.alias)).toEqual(['ANALYTICS']);
      await fed.close();

      // Horizontal Sharded Pool (`createShardedPool`) + Scatter-Gather + Live Rebalancing
      expect(fnv1aHash32('tenant-acme')).toBe(fnv1aHash32('tenant-acme'));
      const pool2 = createShardedPool(
        [
          { id: 'shard-0', db: shard0 },
          { id: 'shard-1', db: shard1 },
        ],
        { shardKeyColumn: 'TENANT_KEY', strategy: 'hash' },
      );

      const ddl =
        'CREATE TABLE SHARD_LEDGER (ID INTEGER NOT NULL PRIMARY KEY, TENANT_KEY VARCHAR(32) NOT NULL, AMOUNT INTEGER NOT NULL)';
      await pool2.execAll(ddl);
      await shard2.execute(ddl);

      const sampleRows = [
        { ID: 1, TENANT_KEY: 't-alpha', AMOUNT: 10 },
        { ID: 2, TENANT_KEY: 't-beta', AMOUNT: 20 },
        { ID: 3, TENANT_KEY: 't-gamma', AMOUNT: 30 },
        { ID: 4, TENANT_KEY: 't-delta', AMOUNT: 40 },
        { ID: 5, TENANT_KEY: 't-epsilon', AMOUNT: 50 },
        { ID: 6, TENANT_KEY: 't-zeta', AMOUNT: 60 },
      ];
      for (const r of sampleRows) {
        await pool2.insert('SHARD_LEDGER', r);
      }

      // Cross-shard global scalar aggregates (COUNT, SUM, MIN, MAX, AVG)
      const aggRes = await pool2.query<{
        CNT: number;
        TOTAL: number;
        LO: number;
        HI: number;
        MEAN: number;
      }>(
        'SELECT COUNT(*) AS CNT, SUM(AMOUNT) AS TOTAL, MIN(AMOUNT) AS LO, MAX(AMOUNT) AS HI, AVG(AMOUNT) AS MEAN FROM SHARD_LEDGER',
      );
      expect(aggRes.rows[0]).toEqual({
        CNT: 6,
        TOTAL: 210,
        LO: 10,
        HI: 60,
        MEAN: 35,
      });

      // Cross-shard global ORDER BY + FIRST N
      const top3 = await pool2.query<{ ID: number; AMOUNT: number }>(
        'SELECT FIRST 3 ID, AMOUNT FROM SHARD_LEDGER ORDER BY AMOUNT DESC',
      );
      expect(top3.rows).toEqual([
        { ID: 6, AMOUNT: 60 },
        { ID: 5, AMOUNT: 50 },
        { ID: 4, AMOUNT: 40 },
      ]);

      // Live shard rebalancing from 2 shards -> 3 shards
      const nextNodes = [
        { id: 'shard-0', db: shard0 },
        { id: 'shard-1', db: shard1 },
        { id: 'shard-2', db: shard2 },
      ];
      const rebalanced = await pool2.rebalanceTable('SHARD_LEDGER', nextNodes, {
        primaryKey: 'ID',
      });
      const totalAfter = Object.values(rebalanced.perShardCounts).reduce((a, b) => a + b, 0);
      expect(totalAfter).toBe(6);

      const pool3 = createShardedPool(nextNodes, { shardKeyColumn: 'TENANT_KEY', strategy: 'hash' });
      const postAgg = await pool3.query<{ TOTAL: number }>(
        'SELECT SUM(AMOUNT) AS TOTAL FROM SHARD_LEDGER',
      );
      expect(postAgg.rows[0]?.TOTAL).toBe(210);
    } finally {
      await primaryDb.close();
      await analyticsDb.close();
      await shard0.close();
      await shard1.close();
      await shard2.close();
    }
  });
});
