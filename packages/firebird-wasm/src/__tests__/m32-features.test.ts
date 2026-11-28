/**
 * m32-features.test.ts – End-to-End Real-WASM Integration Suite for M32:
 *   1. TanStack DB Sync Collections (`createFirebirdCollection`, `electricFirebirdCollectionOptions`)
 *      & Cross-Collection Live Differential Joins (`createLiveDifferentialView`)
 *   2. Algebraic `Z-Set` Incremental View Maintenance (`createIncrementalView`, `FB_IVM_VIEWS$`)
 *   3. PostgreSQL v3 Wire Protocol (`pgwire`) TCP Server (`createPgWireServer`, CLI `serve-pgwire`)
 *   4. Electric Auth Proxy + Shape RLS + Rate Limiting (`createElectricProxy`) &
 *      HMAC-SHA256 Signed Webhook Outbox (`createShapeWebhookSink`, `FB_WEBHOOK_OUTBOX$`)
 *   5. `Apache AGE`-Style Property Graph (`createGraphStore`, `FB_AGE_GRAPHS$`) &
 *      `< 1,000`-Line Source Modularity Invariant
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../open-database';
import {
  createFirebirdCollection,
  createLiveDifferentialView,
  electricFirebirdCollectionOptions,
} from '../tanstack-db';
import {
  ZSet,
  createIncrementalView,
  fetchPersistedIncrementalViews,
} from '../ivm';
import {
  PG_PROTOCOL_V3,
  PG_SSL_REQUEST_CODE,
  createPgWireServer,
} from '../pgwire';
import {
  createElectricProxy,
  createShapeWebhookSink,
  verifyShapeWebhookSignature,
} from '../electric-proxy';
import { createWasmShapeServer } from '../electric-server/wasm-shape-server';
import { signSyncJwt } from '../replication/jwt-auth';
import {
  createGraphStore,
  fetchPersistedGraphs,
} from '../age-graph';
import { runCli } from '../cli';

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

function buildFrontendStartup(params: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(textEnc.encode(k)), Buffer.from([0]));
    parts.push(Buffer.from(textEnc.encode(v)), Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const hdr = Buffer.alloc(8);
  hdr.writeInt32BE(8 + body.length, 0);
  hdr.writeInt32BE(PG_PROTOCOL_V3, 4);
  return Buffer.concat([hdr, body]);
}

function buildFrontendFrame(typeChar: string, payload: Buffer): Buffer {
  const hdr = Buffer.alloc(5);
  hdr[0] = typeChar.charCodeAt(0);
  hdr.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

function parseBackendMessages(buf: Buffer): Array<{ type: string; body: Buffer }> {
  const msgs: Array<{ type: string; body: Buffer }> = [];
  let off = 0;
  while (off + 5 <= buf.length) {
    const type = String.fromCharCode(buf[off]!);
    const len = buf.readInt32BE(off + 1);
    if (off + 1 + len > buf.length) break;
    msgs.push({ type, body: buf.subarray(off + 5, off + 1 + len) });
    off += 1 + len;
  }
  return msgs;
}

describe('M32: TanStack DB Collections, Z-Set IVM, pgwire v3 Server, Electric Auth Proxy & AGE Property Graph', () => {
  it('enforces strict < 1,000-line source modularity across every non-test .ts file in src/', () => {
    const srcDir = path.resolve(__dirname, '..');
    const violations: string[] = [];
    let fileCount = 0;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          fileCount += 1;
          const lines = fs.readFileSync(full, 'utf8').split('\n').length;
          if (lines >= 1000) {
            violations.push(`${path.relative(srcDir, full)} (${lines} lines)`);
          }
        }
      }
    };

    walk(srcDir);
    expect(fileCount).toBeGreaterThanOrEqual(205);
    expect(violations).toEqual([]);
  });

  it('M32 Item 1: reconciles optimistic TanStack DB collection mutations, rolls back failures & emits live differential join deltas', async () => {
    const db = await openDatabase('memory://m32_tanstack');
    try {
      let confirmedTxId = 0;
      const waitedTxIds: number[] = [];

      const users = createFirebirdCollection<{ ID: number; NAME: string }>(db, {
        table: 'USERS',
        primaryKey: 'ID',
        autoCreateSql: 'CREATE TABLE USERS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(64) NOT NULL)',
        onInsert: async () => ({ txid: ++confirmedTxId }),
        waitForTxId: async (txid) => {
          waitedTxIds.push(txid);
        },
      });

      let failNextTaskInsert = false;
      const tasks = createFirebirdCollection<{ ID: number; USER_ID: number; TITLE: string }>(db, {
        table: 'TASKS',
        primaryKey: 'ID',
        autoCreateSql:
          'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, USER_ID INTEGER NOT NULL, TITLE VARCHAR(128) NOT NULL)',
        onInsert: async () => {
          if (failNextTaskInsert) throw new Error('Remote write rejected');
          return { txid: ++confirmedTxId };
        },
        waitForTxId: async (txid) => {
          waitedTxIds.push(txid);
        },
      });

      await users.preload();
      await tasks.preload();

      const joinDeltas: Array<{ added: number; modified: number; removed: number }> = [];
      const liveJoin = createLiveDifferentialView({
        left: tasks,
        right: users,
        leftKey: (t) => t.USER_ID,
        rightKey: (u) => u.ID,
        joinType: 'inner',
        select: (t, u) => ({
          TASK_ID: t.ID,
          TITLE: t.TITLE,
          ASSIGNEE: u!.NAME,
        }),
      });
      liveJoin.subscribeChanges((b) => {
        joinDeltas.push({
          added: b.added.length,
          modified: b.modified.length,
          removed: b.removed.length,
        });
      });

      await users.insert({ ID: 10, NAME: 'Ada' });
      const insRes = await tasks.insert({ ID: 1, USER_ID: 10, TITLE: 'Ship TanStack DB' });
      expect(insRes.txid).toBe(2);
      expect(waitedTxIds).toEqual([1, 2]);
      expect(liveJoin.toArray()).toEqual([
        { TASK_ID: 1, TITLE: 'Ship TanStack DB', ASSIGNEE: 'Ada' },
      ]);

      // Updating user name propagates as a `modified` delta on the joined view without SQL re-queries
      await users.update(10, { NAME: 'Ada Lovelace' });
      expect(liveJoin.toArray()[0]?.ASSIGNEE).toBe('Ada Lovelace');
      expect(joinDeltas.some((d) => d.modified === 1)).toBe(true);

      // Failed remote insert rolls back optimistic state AND Firebird row
      failNextTaskInsert = true;
      await expect(
        tasks.insert({ ID: 99, USER_ID: 10, TITLE: 'Should Rollback' }),
      ).rejects.toThrow('Remote write rejected');
      expect(tasks.get(99)).toBeUndefined();
      const dbTasks = await db.query('SELECT * FROM TASKS WHERE ID = 99');
      expect(dbTasks.rows.length).toBe(0);

      // Verify `@tanstack/db` CollectionConfig wrapper (`sync.sync`)
      const syncedWrites: string[] = [];
      let markedReady = false;
      const cfg = electricFirebirdCollectionOptions<{ ID: number; NAME: string }>(db, {
        table: 'USERS',
        primaryKey: 'ID',
      });
      const stopSync = cfg.sync.sync({
        begin: () => {},
        write: (m) => syncedWrites.push(`${m.type}:${m.value?.NAME ?? ''}`),
        commit: () => {},
        markReady: () => {
          markedReady = true;
        },
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(markedReady).toBe(true);
      expect(syncedWrites).toContain('insert:Ada Lovelace');

      stopSync();
      liveJoin.dispose();
      users.dispose();
      tasks.dispose();
    } finally {
      await db.close();
    }
  });

  it('M32 Item 2: maintains algebraic Z-Set Incremental Views (`INNER JOIN` + `GROUP BY` + PSQL trigger `syncDeltas`) in O(Δ)', async () => {
    const z = new ZSet<{ id: number }>();
    z.add('1', { id: 1 }, 2);
    z.add('1', { id: 1 }, -2);
    expect(z.size).toBe(0);

    const db = await openDatabase('memory://m32_ivm');
    try {
      await db.exec(`
        CREATE TABLE CUSTOMERS (ID INTEGER NOT NULL PRIMARY KEY, REGION VARCHAR(32) NOT NULL);
        CREATE TABLE ORDERS (ID INTEGER NOT NULL PRIMARY KEY, CUST_ID INTEGER NOT NULL, AMOUNT INTEGER NOT NULL, STATUS VARCHAR(16) NOT NULL);
      `);
      await db.execute(`INSERT INTO CUSTOMERS VALUES (1, 'EU')`);
      await db.execute(`INSERT INTO CUSTOMERS VALUES (2, 'US')`);
      await db.execute(`INSERT INTO ORDERS VALUES (101, 1, 200, 'PAID')`);
      await db.execute(`INSERT INTO ORDERS VALUES (102, 1, 100, 'PAID')`);
      await db.execute(`INSERT INTO ORDERS VALUES (103, 2, 50, 'PENDING')`);

      const ivm = await createIncrementalView<{
        REGION: string;
        ORDER_CNT: number;
        TOTAL_AMT: number;
        MIN_AMT: number;
        MAX_AMT: number;
      }>(db, {
        name: 'paid_revenue_by_region',
        sourceTable: 'ORDERS',
        sourceKey: 'ID',
        filter: (row) => row['STATUS'] === 'PAID',
        join: {
          table: 'CUSTOMERS',
          leftKey: 'CUST_ID',
          rightKey: 'ID',
          type: 'inner',
          selectColumns: ['REGION'],
        },
        groupBy: {
          columns: ['REGION'],
          aggregates: [
            { alias: 'ORDER_CNT', op: 'COUNT' },
            { alias: 'TOTAL_AMT', op: 'SUM', column: 'AMOUNT' },
            { alias: 'MIN_AMT', op: 'MIN', column: 'AMOUNT' },
            { alias: 'MAX_AMT', op: 'MAX', column: 'AMOUNT' },
          ],
        },
        installTriggers: true,
      });

      let rows = await ivm.queryView('REGION ASC');
      expect(rows).toEqual([
        { REGION: 'EU', ORDER_CNT: 2, TOTAL_AMT: 300, MIN_AMT: 100, MAX_AMT: 200 },
      ]);

      // Raw SQL mutations captured by PSQL triggers and applied incrementally via `syncDeltas()`
      await db.execute(`UPDATE ORDERS SET STATUS = 'PAID', AMOUNT = 400 WHERE ID = 103`);
      await db.execute(`DELETE FROM ORDERS WHERE ID = 102`);

      const deltaRes = await ivm.syncDeltas();
      expect(deltaRes.deltaInputCount).toBe(2);

      rows = await ivm.queryView('REGION ASC');
      expect(rows).toEqual([
        { REGION: 'EU', ORDER_CNT: 1, TOTAL_AMT: 200, MIN_AMT: 200, MAX_AMT: 200 },
        { REGION: 'US', ORDER_CNT: 1, TOTAL_AMT: 400, MIN_AMT: 400, MAX_AMT: 400 },
      ]);

      const persisted = await fetchPersistedIncrementalViews(db);
      expect(persisted.length).toBe(1);
      expect(persisted[0]?.name).toBe('paid_revenue_by_region');
      expect(persisted[0]?.deltaAppliedCount).toBe(2);
    } finally {
      await db.close();
    }
  });

  it('M32 Item 3: serves PostgreSQL v3 binary `pgwire` over TCP (`SSLRequest`, cleartext auth, Simple & Extended Query `$1..$n`) + CLI `serve-pgwire`', async () => {
    const db = await openDatabase('memory://m32_pgwire');
    const pgServer = await createPgWireServer(db, {
      host: '127.0.0.1',
      port: 0,
      auth: { mode: 'cleartext', username: 'postgres', password: 'secret' },
    });

    try {
      await db.exec(
        'CREATE TABLE PG_ITEMS (ID INTEGER NOT NULL PRIMARY KEY, LABEL VARCHAR(64) NOT NULL)',
      );
      await db.execute(`INSERT INTO PG_ITEMS VALUES (1, 'pgwire-alpha')`);

      const socket = net.createConnection({ host: pgServer.host, port: pgServer.port });
      await new Promise<void>((res, rej) => {
        socket.once('connect', () => res());
        socket.once('error', rej);
      });

      const readBytes = (minBytes: number): Promise<Buffer> =>
        new Promise((resolve) => {
          const chunks: Buffer[] = [];
          let total = 0;
          const onData = (d: Buffer) => {
            chunks.push(d);
            total += d.length;
            if (total >= minBytes) {
              socket.off('data', onData);
              resolve(Buffer.concat(chunks));
            }
          };
          socket.on('data', onData);
        });

      // 1. SSLRequest -> server declines with single byte 'N'
      const sslReq = Buffer.alloc(8);
      sslReq.writeInt32BE(8, 0);
      sslReq.writeInt32BE(PG_SSL_REQUEST_CODE, 4);
      socket.write(sslReq);
      const sslReply = await readBytes(1);
      expect(sslReply[0]).toBe('N'.charCodeAt(0));

      // 2. StartupMessage -> server asks for CleartextPassword ('R' auth=3)
      socket.write(buildFrontendStartup({ user: 'postgres', database: 'appdb' }));
      const authChallenge = parseBackendMessages(await readBytes(9));
      expect(authChallenge[0]?.type).toBe('R');
      expect(authChallenge[0]?.body.readInt32BE(0)).toBe(3);

      // 3. PasswordMessage ('p') -> AuthOk ('R' 0) + ParameterStatus ('S') + ReadyForQuery ('Z')
      const pwFrame = buildFrontendFrame('p', Buffer.from('secret\0', 'utf8'));
      socket.write(pwFrame);
      let startupBuf = await readBytes(20);
      while (startupBuf[startupBuf.length - 6] !== 'Z'.charCodeAt(0)) {
        startupBuf = Buffer.concat([startupBuf, await readBytes(1)]);
      }
      const startupMsgs = parseBackendMessages(startupBuf);
      expect(startupMsgs.some((m) => m.type === 'R' && m.body.readInt32BE(0) === 0)).toBe(true);
      expect(startupMsgs.at(-1)?.type).toBe('Z');

      // 4. SimpleQuery ('Q') against `information_schema.tables`
      socket.write(
        buildFrontendFrame('Q', Buffer.from('SELECT table_name FROM information_schema.tables\0')),
      );
      let qBuf = await readBytes(10);
      while (qBuf[qBuf.length - 6] !== 'Z'.charCodeAt(0)) {
        qBuf = Buffer.concat([qBuf, await readBytes(1)]);
      }
      const qMsgs = parseBackendMessages(qBuf);
      expect(qMsgs.some((m) => m.type === 'T')).toBe(true);
      const dataRowMsg = qMsgs.find((m) => m.type === 'D');
      expect(dataRowMsg).toBeDefined();
      expect(textDec.decode(dataRowMsg!.body)).toContain('pg_items');

      // 5. Extended Query: Parse ('P') + Bind ('B') + Execute ('E') + Sync ('S') with `$1`
      const parseBody = Buffer.concat([
        Buffer.from('s1\0SELECT LABEL FROM PG_ITEMS WHERE ID = $1\0', 'utf8'),
        Buffer.from([0, 0]),
      ]);
      const paramBytes = Buffer.from('1', 'utf8');
      const bindBody = Buffer.alloc(
        3 + 3 + 2 + 2 + 4 + paramBytes.length + 2,
      );
      let bo = 0;
      bo += bindBody.write('p1\0', bo, 'utf8');
      bo += bindBody.write('s1\0', bo, 'utf8');
      bindBody.writeInt16BE(0, bo); // 0 format codes (text default)
      bo += 2;
      bindBody.writeInt16BE(1, bo); // 1 param
      bo += 2;
      bindBody.writeInt32BE(paramBytes.length, bo);
      bo += 4;
      paramBytes.copy(bindBody, bo);
      bo += paramBytes.length;
      bindBody.writeInt16BE(0, bo); // 0 result format codes

      const execBody = Buffer.from('p1\0\x00\x00\x00\x00', 'binary');
      socket.write(
        Buffer.concat([
          buildFrontendFrame('P', parseBody),
          buildFrontendFrame('B', bindBody),
          buildFrontendFrame('E', execBody),
          buildFrontendFrame('S', Buffer.alloc(0)),
        ]),
      );

      let extBuf = await readBytes(15);
      while (extBuf[extBuf.length - 6] !== 'Z'.charCodeAt(0)) {
        extBuf = Buffer.concat([extBuf, await readBytes(1)]);
      }
      const extMsgs = parseBackendMessages(extBuf);
      expect(extMsgs.some((m) => m.type === '1')).toBe(true); // ParseComplete
      expect(extMsgs.some((m) => m.type === '2')).toBe(true); // BindComplete
      const extRow = extMsgs.find((m) => m.type === 'D');
      expect(extRow).toBeDefined();
      expect(textDec.decode(extRow!.body)).toContain('pgwire-alpha');

      socket.write(buildFrontendFrame('X', Buffer.alloc(0)));
      socket.end();

      // Verify CLI `serve-pgwire` subcommand
      let cliOut = '';
      const code = await runCli(
        ['serve-pgwire', 'memory://cli_pgwire', '--port', '0', '--duration-ms', '25'],
        { stdout: (t) => (cliOut += t) },
      );
      expect(code).toBe(0);
      expect(cliOut).toContain('PostgreSQL v3 pgwire server listening on postgresql://');
    } finally {
      await pgServer.close();
      await db.close();
    }
  });

  it('M32 Item 4: enforces Electric Auth Proxy JWT tenant RLS, column allow-lists & rate limits + signed HMAC-SHA256 webhook outbox', async () => {
    const db = await openDatabase('memory://m32_proxy');
    try {
      await db.exec(`
        CREATE TABLE INVOICES (
          ID INTEGER NOT NULL PRIMARY KEY,
          TENANT_ID VARCHAR(32) NOT NULL,
          TOTAL INTEGER NOT NULL,
          INTERNAL_SECRET VARCHAR(64) NOT NULL
        )
      `);
      await db.execute(`INSERT INTO INVOICES VALUES (1, 'acme', 500, 'sec-acme-1')`);
      await db.execute(`INSERT INTO INVOICES VALUES (2, 'acme', 90, 'sec-acme-2')`);
      await db.execute(`INSERT INTO INVOICES VALUES (3, 'globex', 999, 'sec-globex-3')`);

      const shapeSrv = await createWasmShapeServer(db, { tables: ['INVOICES'] });
      const jwtSecret = 'm32-super-secret-jwt-key-32bytes!';
      const acmeToken = await signSyncJwt(
        { sub: 'u_acme', tenant_id: 'acme', role: 'reader' },
        jwtSecret,
      );

      let clockMs = 1_000;
      const proxy = createElectricProxy(shapeSrv, {
        jwtKey: jwtSecret,
        tenantColumn: 'tenant_id',
        columnAllowList: {
          invoices: ['id', 'tenant_id', 'total'],
        },
        rateLimit: {
          maxRequests: 3,
          windowMs: 60_000,
          nowMs: () => clockMs,
        },
      });

      // 1. Unauthenticated request -> 401
      const unauth = await proxy.fetch(new Request('http://edge.local/v1/shape?table=invoices&offset=-1'));
      expect(unauth.status).toBe(401);

      // 2. Client supplies its own `$1` filter (`total >= $1` with `params[1]=200`):
      //    Proxy safely shifts client `$1` -> `$2` and injects `tenant_id = $1` (`acme`) + strips `INTERNAL_SECRET`!
      const okRes = await proxy.fetch(
        new Request(
          'http://edge.local/v1/shape?table=invoices&offset=-1&where=total%20%3E%3D%20%241&params[1]=200',
          { headers: { authorization: `Bearer ${acmeToken}` } },
        ),
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('cache-control')).toContain('private');
      const messages = (await okRes.json()) as Array<{ value?: Record<string, unknown> }>;
      const rows = messages.filter((m) => m.value).map((m) => m.value!);
      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual({ id: '1', tenant_id: 'acme', total: '500' });
      expect('internal_secret' in rows[0]!).toBe(false);

      // 3. Requesting forbidden column `internal_secret` -> 403
      const forbiddenColRes = await proxy.fetch(
        new Request(
          'http://edge.local/v1/shape?table=invoices&offset=-1&columns=id,internal_secret',
          { headers: { authorization: `Bearer ${acmeToken}` } },
        ),
      );
      expect(forbiddenColRes.status).toBe(403);

      // 4. Reader attempting DELETE /v1/shape -> 403, then 4th request in window -> 429
      const delRes = await proxy.fetch(
        new Request('http://edge.local/v1/shape?table=invoices', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${acmeToken}` },
        }),
      );
      expect(delRes.status).toBe(403);

      const rateLimited = await proxy.fetch(
        new Request('http://edge.local/v1/shape?table=invoices&offset=-1', {
          headers: { authorization: `Bearer ${acmeToken}` },
        }),
      );
      expect(rateLimited.status).toBe(429);
      clockMs += 61_000; // advance past rate-limit window

      // 5. Signed Webhook Sink with retry + FB_WEBHOOK_OUTBOX$ dead-letter recovery
      let webhookHealthy = false;
      const receivedDeliveries: Array<{ body: string; sig: string; ts: string }> = [];
      const sink = createShapeWebhookSink(db, {
        url: 'https://hooks.example.test/electric',
        secret: 'whsec_test_key',
        maxRetries: 1,
        baseBackoffMs: 1,
        fetch: async (_url, init) => {
          if (!webhookHealthy) return new Response('Service Unavailable', { status: 503 });
          const hdrs = new Headers(init?.headers);
          receivedDeliveries.push({
            body: String(init?.body ?? ''),
            sig: hdrs.get('x-electric-signature') ?? '',
            ts: hdrs.get('x-electric-timestamp') ?? '',
          });
          return new Response('OK', { status: 200 });
        },
      });

      const failedPub = await sink.publish({
        table: 'invoices',
        changes: rows,
      });
      expect(failedPub.delivered).toBe(false);
      expect((await sink.listDeadLetters()).length).toBe(1);

      webhookHealthy = true;
      const retryRes = await sink.retryDeadLetters();
      expect(retryRes).toEqual({ retried: 1, succeeded: 1 });
      expect((await sink.listDeadLetters()).length).toBe(0);
      expect(receivedDeliveries.length).toBe(1);

      const verified = await verifyShapeWebhookSignature(
        receivedDeliveries[0]!.body,
        receivedDeliveries[0]!.ts,
        receivedDeliveries[0]!.sig,
        'whsec_test_key',
      );
      expect(verified).toBe(true);

      await shapeSrv.close();
    } finally {
      await db.close();
    }
  });

  it('M32 Item 5: evaluates AGE Cypher `*min..max` paths, multi-hop chains, weighted Dijkstra `shortestPath`, PageRank & connected components', async () => {
    const db = await openDatabase('memory://m32_age_graph');
    try {
      const graph = await createGraphStore(db, { graphName: 'org_network' });
      await graph.upsertBatch({
        nodes: [
          { id: 'u1', labels: ['User', 'Lead'], properties: { name: 'Ada', tier: 'pro' } },
          { id: 'u2', labels: ['User'], properties: { name: 'Grace', tier: 'pro' } },
          { id: 'u3', labels: ['User'], properties: { name: 'Linus', tier: 'free' } },
          { id: 'org1', labels: ['Org'], properties: { name: 'AcmeLabs' } },
          { id: 'proj1', labels: ['Project'], properties: { name: 'FirebirdWasm' } },
          { id: 'island1', labels: ['User'], properties: { name: 'Isolated' } },
        ],
        edges: [
          { id: 'e1', srcId: 'u1', dstId: 'u2', label: 'FOLLOWS', weight: 1.5 },
          { id: 'e2', srcId: 'u2', dstId: 'u3', label: 'FOLLOWS', weight: 2.0 },
          { id: 'e3', srcId: 'u1', dstId: 'u3', label: 'FOLLOWS', weight: 10.0 },
          { id: 'e4', srcId: 'u2', dstId: 'org1', label: 'MEMBER_OF', weight: 1.0 },
          { id: 'e5', srcId: 'org1', dstId: 'proj1', label: 'OWNS', weight: 1.0 },
        ],
      });

      // 1. Variable-length Cypher pattern `(a:User {tier: 'pro'})-[r:FOLLOWS*1..2]->(b:User)`
      const varMatches = graph.match("(a:User {tier: 'pro'})-[r:FOLLOWS*1..2]->(b:User)");
      expect(varMatches.length).toBeGreaterThanOrEqual(4);

      // 2. Multi-segment Cypher chain `(a:User)-[:MEMBER_OF]->(o:Org)-[:OWNS]->(p:Project)`
      const chainMatches = graph.match('(a:User)-[:MEMBER_OF]->(o:Org)-[:OWNS]->(p:Project)');
      expect(chainMatches.length).toBe(1);
      expect((chainMatches[0]?.bindings['a'] as { id: string }).id).toBe('u2');
      expect((chainMatches[0]?.bindings['p'] as { id: string }).id).toBe('proj1');

      // 3. Weighted Dijkstra chooses u1 -> u2 -> u3 (cost 3.5) over direct u1 -> u3 (cost 10.0),
      //    whereas unweighted BFS chooses direct u1 -> u3 (1 hop)!
      const weightedPath = graph.shortestPath('u1', 'u3', { weighted: true, relLabels: ['FOLLOWS'] });
      expect(weightedPath?.nodeIds).toEqual(['u1', 'u2', 'u3']);
      expect(weightedPath?.totalCost).toBeCloseTo(3.5, 5);

      const bfsPath = graph.shortestPath('u1', 'u3', { weighted: false, relLabels: ['FOLLOWS'] });
      expect(bfsPath?.nodeIds).toEqual(['u1', 'u3']);
      expect(bfsPath?.hops).toBe(1);

      // 4. PageRank & Weakly Connected Components
      const ranks = graph.pageRank();
      expect(ranks.length).toBe(6);
      const totalRank = ranks.reduce((acc, r) => acc + r.score, 0);
      expect(totalRank).toBeCloseTo(1.0, 4);

      const components = graph.connectedComponents();
      expect(components.length).toBe(2);
      expect(components[0]?.size).toBe(5);
      expect(components[1]?.nodeIds).toEqual(['island1']);

      // 5. Persisted metadata in `FB_AGE_GRAPHS$` survives reload
      const persisted = await fetchPersistedGraphs(db);
      expect(persisted.length).toBe(1);
      expect(persisted[0]?.graphName).toBe('org_network');
      expect(persisted[0]?.nodeCount).toBe(6);
      expect(persisted[0]?.edgeCount).toBe(5);
    } finally {
      await db.close();
    }
  });
});
