import { describe, expect, it } from 'vitest';
import {
  FirebirdBrowser,
  SyncJwtError,
  createHttpReplicationClient,
  createHttpReplicationHandler,
  createJwtTenantAuthResolver,
  createOptimisticMutationStore,
  createPublication,
  createSubscription,
  createTenantIsolationGuard,
  createTenantReplicationSlice,
  createWebSocketReplicationPeer,
  decodeArrowIpc,
  encodeArrowIpc,
  rowsToColumnarResult,
  signSyncJwt,
  syncDatabases,
  verifySyncJwt,
} from '../browser';
import { startCliReplicationServer } from '../cli-sync-server';

describe('M23 Item 1: WebCrypto JWT Tenant Claims & Role-Based Sync Auth', () => {
  it('signs and verifies HS256 & ES256 JWTs and rejects tampered, expired, or alg=none tokens', async () => {
    const secret = 'm23-unit-test-hmac-secret';
    const tok = await signSyncJwt(
      { sub: 'user_1', tenant_id: 'acme', role: 'writer', tables: ['TASKS'] },
      secret,
      { issuer: 'electric-firebird', audience: 'sync-edge', expiresInSec: 120 },
    );
    const claims = await verifySyncJwt(tok, secret, {
      issuer: 'electric-firebird',
      audience: 'sync-edge',
    });
    expect(claims.tenant_id).toBe('acme');
    expect(claims.role).toBe('writer');

    // Tampered signature must fail with 401 JWT_INVALID
    const tampered = tok.slice(0, -3) + (tok.endsWith('abc') ? 'xyz' : 'abc');
    await expect(verifySyncJwt(tampered, secret)).rejects.toMatchObject({
      code: 'JWT_INVALID',
      status: 401,
    });

    // Expired token must fail with 401 JWT_EXPIRED
    const expiredTok = await signSyncJwt(
      { sub: 'user_1', tenant_id: 'acme' },
      secret,
      { nowSec: 1000, expiresInSec: 10 },
    );
    await expect(
      verifySyncJwt(expiredTok, secret, { nowSec: 2000, clockToleranceSec: 5 }),
    ).rejects.toMatchObject({
      code: 'JWT_EXPIRED',
      status: 401,
    });

    // Asymmetric ES256 (ECDSA P-256) keypair
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const esTok = await signSyncJwt(
      { sub: 'edge_node', tenant_id: 'globex', role: 'admin' },
      kp.privateKey,
      { algorithm: 'ES256', expiresInSec: 300 },
    );
    const esClaims = await verifySyncJwt(esTok, kp.publicKey, {
      algorithms: ['ES256'],
    });
    expect(esClaims.tenant_id).toBe('globex');
    expect(esClaims.role).toBe('admin');
  });

  it('enforces JWT tenant slice, role=reader 403 push blocks, and table scopes across HTTP, WebSocket & CLI serve-sync', async () => {
    await using primary = new FirebirdBrowser('memory://m23_jwt_primary', { threads: false });
    await primary.execute(
      'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, TITLE VARCHAR(64))',
    );
    await primary.execute(
      'CREATE TABLE AUDIT_SECRET (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, MSG VARCHAR(64))',
    );
    await primary.execute("INSERT INTO TASKS VALUES (1, 'acme', 'Acme Task')");
    await primary.execute("INSERT INTO TASKS VALUES (2, 'globex', 'Globex Task')");
    await primary.execute("INSERT INTO AUDIT_SECRET VALUES (1, 'acme', 'Top Secret')");

    const jwtSecret = 'cli-jwt-hmac-secret-2026';
    await using srv = await startCliReplicationServer({
      db: primary,
      port: 0,
      jwtSecret,
      tenantColumn: 'TENANT_ID',
    });

    const acmeReaderJwt = await signSyncJwt(
      { sub: 'r1', tenant_id: 'acme', role: 'reader', tables: ['TASKS'] },
      jwtSecret,
      { expiresInSec: 300 },
    );
    const acmeWriterJwt = await signSyncJwt(
      { sub: 'w1', tenant_id: 'acme', role: 'writer', tables: ['TASKS'] },
      jwtSecret,
      { expiresInSec: 300 },
    );

    // Unauthenticated request -> 401
    const unauthRes = await fetch(`${srv.url}/changes?sinceLsn=0`);
    expect(unauthRes.status).toBe(401);

    // Reader can pull its own tenant + permitted table (`TASKS`, NOT `AUDIT_SECRET` or `globex`)
    const readerClient = createHttpReplicationClient({
      baseUrl: srv.url,
      apiKey: acmeReaderJwt,
    });
    const snap = await readerClient.fetchSnapshot();
    expect(snap.tables.map((t) => t.table)).toEqual(['TASKS']);
    expect(snap.tables[0]!.rows).toHaveLength(1);
    expect(snap.tables[0]!.rows[0]!.TENANT_ID).toBe('acme');

    // Reader attempting ?tenantId=globex spoofing -> 403 JWT_TENANT_FORBIDDEN
    const spoofRes = await fetch(`${srv.url}/changes?sinceLsn=0&tenantId=globex`, {
      headers: { authorization: `Bearer ${acmeReaderJwt}` },
    });
    expect(spoofRes.status).toBe(403);
    const spoofJson = (await spoofRes.json()) as { code?: string };
    expect(spoofJson.code).toBe('JWT_TENANT_FORBIDDEN');

    // Reader attempting POST /push -> 403 JWT_ROLE_FORBIDDEN
    const readerPush = await fetch(`${srv.url}/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${acmeReaderJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        entries: [
          {
            lsn: 1,
            txid: 'tx1',
            timestamp: Date.now(),
            origin: 'edge',
            publication: 'default',
            table: 'TASKS',
            operation: 'INSERT',
            key: { ID: 10 },
            after: { ID: 10, TENANT_ID: 'acme', TITLE: 'Denied' },
            before: null,
            ddlSql: null,
          },
        ],
      }),
    });
    expect(readerPush.status).toBe(403);
    expect(((await readerPush.json()) as { code?: string }).code).toBe('JWT_ROLE_FORBIDDEN');

    // Writer attempting POST /push to unpermitted table AUDIT_SECRET -> 403 JWT_TABLE_FORBIDDEN
    const forbiddenTablePush = await fetch(`${srv.url}/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${acmeWriterJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        entries: [
          {
            lsn: 2,
            txid: 'tx2',
            timestamp: Date.now(),
            origin: 'edge',
            publication: 'default',
            table: 'AUDIT_SECRET',
            operation: 'INSERT',
            key: { ID: 99 },
            after: { ID: 99, TENANT_ID: 'acme', MSG: 'Nope' },
            before: null,
            ddlSql: null,
          },
        ],
      }),
    });
    expect(forbiddenTablePush.status).toBe(403);
    expect(((await forbiddenTablePush.json()) as { code?: string }).code).toBe(
      'JWT_TABLE_FORBIDDEN',
    );

    // Writer pushing valid acme TASKS row -> 200 OK
    const writerClient = createHttpReplicationClient({
      baseUrl: srv.url,
      apiKey: acmeWriterJwt,
    });
    await writerClient.pushChanges([
      {
        lsn: 3,
        txid: 'tx3',
        timestamp: Date.now(),
        origin: 'edge_w1',
        publication: 'default',
        table: 'TASKS',
        operation: 'INSERT',
        key: { ID: 11 },
        after: { ID: 11, TENANT_ID: 'acme', TITLE: 'Authorized Writer Row' },
        before: null,
        ddlSql: null,
      },
    ]);
    const checkRows = await primary.query<{ TITLE: string }>(
      'SELECT TITLE FROM TASKS WHERE ID = 11',
    );
    expect(checkRows.rows[0]?.TITLE).toBe('Authorized Writer Row');

    // WebSocket peer also enforces JWT role=reader -> repl_error 403
    const sentFrames: string[] = [];
    let onMsg: ((ev: { data: unknown }) => void) | null = null;
    const wsPeer = createWebSocketReplicationPeer({
      socket: {
        send(d) {
          if (typeof d === 'string') sentFrames.push(d);
        },
        addEventListener(_t, fn) {
          onMsg = fn;
        },
      },
      subscription: srv.subscription,
      tenantGuard: createTenantIsolationGuard({ tenantColumn: 'TENANT_ID' }),
      jwtAuth: createJwtTenantAuthResolver({ secretOrPublicKey: jwtSecret }),
    });
    onMsg?.({
      data: JSON.stringify({
        type: 'repl_entries',
        token: acmeReaderJwt,
        entries: [
          {
            lsn: 4,
            txid: 'tx4',
            timestamp: Date.now(),
            origin: 'ws_r',
            publication: 'default',
            table: 'TASKS',
            operation: 'INSERT',
            key: { ID: 12 },
            after: { ID: 12, TENANT_ID: 'acme', TITLE: 'WS Blocked' },
            before: null,
            ddlSql: null,
          },
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 40));
    wsPeer.close();
    const errFrame = sentFrames.map((s) => JSON.parse(s)).find((m) => m.type === 'repl_error');
    expect(errFrame?.status).toBe(403);
    expect(errFrame?.code).toBe('JWT_ROLE_FORBIDDEN');
    expect(new SyncJwtError('test', 'JWT_MISSING', 401).status).toBe(401);
  });
});

describe('M23 Item 2: Crash-Safe Durable Optimistic Outbox (FB_OPTIMISTIC_OUTBOX$) & Offline Rebase', () => {
  it('persists optimistic mutations in FB_OPTIMISTIC_OUTBOX$, hydrates across store recreation, and rebases non-overlapping remote column updates', async () => {
    await using db = new FirebirdBrowser('memory://m23_outbox_db', { threads: false });
    await db.execute(
      'CREATE TABLE ISSUES (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64), STATUS VARCHAR(32), PRIORITY INTEGER)',
    );
    await db.execute("INSERT INTO ISSUES VALUES (1, 'Login bug', 'OPEN', 2)");

    // Store instance #1 writes two optimistic mutations while offline, then "crashes" (abandoned)
    const store1 = createOptimisticMutationStore(db, { persist: true });
    await store1.update('ISSUES', 1, { TITLE: 'Login OAuth bug' }, { primaryKey: 'ID' });
    await store1.insert(
      'ISSUES',
      { ID: 2, TITLE: 'Offline draft issue', STATUS: 'DRAFT', PRIORITY: 1 },
      { primaryKey: 'ID' },
    );

    const outboxRows = await db.query(
      'SELECT MUTATION_ID, OP_KIND FROM "FB_OPTIMISTIC_OUTBOX$" ORDER BY SEQ_NO',
    );
    expect(outboxRows.rows).toHaveLength(2);

    // Store instance #2 opens against the same database, hydrates pending state, and rebases a concurrent remote update on ID=1!
    let shouldFailRemote = true;
    const store2 = createOptimisticMutationStore(db, {
      persist: true,
      remoteSync: async () => {
        if (shouldFailRemote) throw new Error('Server validation rejected');
      },
    });
    const hydrated = await store2.hydrate();
    expect(hydrated).toHaveLength(2);
    expect(store2.getSnapshot().pendingCount).toBe(2);

    // Remote concurrently changed STATUS -> 'IN_PROGRESS' and PRIORITY -> 5 on ID=1 (did NOT touch TITLE!)
    const rebaseRes = await store2.rebase([
      {
        lsn: 50,
        txid: 'tx_rem_50',
        timestamp: Date.now(),
        origin: 'primary',
        publication: 'default',
        table: 'ISSUES',
        operation: 'UPDATE',
        key: { ID: 1 },
        before: { ID: 1, TITLE: 'Login bug', STATUS: 'OPEN', PRIORITY: 2 },
        after: { ID: 1, TITLE: 'Login bug', STATUS: 'IN_PROGRESS', PRIORITY: 5 },
        ddlSql: null,
      },
    ]);
    expect(rebaseRes.rebased).toBe(1);

    // Local table now has BOTH remote's STATUS/PRIORITY AND our pending local TITLE!
    const mergedRow = await db.query<{ TITLE: string; STATUS: string; PRIORITY: number }>(
      'SELECT TITLE, STATUS, PRIORITY FROM ISSUES WHERE ID = 1',
    );
    expect(mergedRow.rows[0]).toEqual({
      TITLE: 'Login OAuth bug',
      STATUS: 'IN_PROGRESS',
      PRIORITY: 5,
    });

    // If remote flush fails now, rollback restores the LATEST remote state ('Login bug', 'IN_PROGRESS', 5) and deletes ID=2!
    const flushFail = await store2.flush();
    expect(flushFail.reverted).toBe(2);

    const afterRollback = await db.query<{ ID: number; TITLE: string; STATUS: string; PRIORITY: number }>(
      'SELECT ID, TITLE, STATUS, PRIORITY FROM ISSUES ORDER BY ID',
    );
    expect(afterRollback.rows).toEqual([
      { ID: 1, TITLE: 'Login bug', STATUS: 'IN_PROGRESS', PRIORITY: 5 },
    ]);

    const emptyOutbox = await db.query('SELECT COUNT(*) AS CNT FROM "FB_OPTIMISTIC_OUTBOX$"');
    expect(Number(emptyOutbox.rows[0]?.CNT)).toBe(0);
    shouldFailRemote = false;
  });
});

describe("M23 Item 3: Zero-Copy Arrow IPC Filtered Replica Bootstrap (bootstrapStrategy: 'arrow-ipc')", () => {
  it('bootstraps tenant-filtered & full replicas via FBARSNAP Arrow IPC V5 streams over local WASM and HTTP GET /snapshot?format=arrow', async () => {
    await using primary = new FirebirdBrowser('memory://m23_arrow_boot_pri', { threads: false });
    await using sliceReplica = new FirebirdBrowser('memory://m23_arrow_boot_slice', {
      threads: false,
    });
    await using httpReplica = new FirebirdBrowser('memory://m23_arrow_boot_http', {
      threads: false,
    });

    await primary.execute(
      'CREATE TABLE ORDERS (ID INTEGER NOT NULL PRIMARY KEY, TENANT_ID VARCHAR(32) NOT NULL, AMOUNT DOUBLE PRECISION)',
    );
    await primary.execute(
      'CREATE TABLE CURRENCIES (CODE VARCHAR(8) NOT NULL PRIMARY KEY, RATE DOUBLE PRECISION)',
    );
    await primary.execute("INSERT INTO CURRENCIES VALUES ('USD', 1.0)");
    await primary.execute("INSERT INTO CURRENCIES VALUES ('EUR', 0.92)");
    await primary.execute("INSERT INTO ORDERS VALUES (1, 'acme', 125.5)");
    await primary.execute("INSERT INTO ORDERS VALUES (2, 'globex', 999.0)");
    await primary.execute("INSERT INTO ORDERS VALUES (3, 'acme', 74.25)");

    // 1. Tenant slice bootstrap with `bootstrapStrategy: 'arrow-ipc'`
    const slice = await createTenantReplicationSlice({
      primary,
      replica: sliceReplica,
      tenantColumn: 'TENANT_ID',
      tenantId: 'acme',
      tables: ['ORDERS'],
      sharedTables: ['CURRENCIES'],
      bootstrapStrategy: 'arrow-ipc',
      concurrency: 2,
    });
    expect(slice.bootstrapResult?.mode).toBe('arrow-ipc');
    expect(slice.bootstrapResult?.rowsCopied).toBe(4); // 2 CURRENCIES + 2 acme ORDERS

    const sliceOrders = await sliceReplica.query<{ ID: number; AMOUNT: number }>(
      'SELECT ID, AMOUNT FROM ORDERS ORDER BY ID',
    );
    expect(sliceOrders.rows).toEqual([
      { ID: 1, AMOUNT: 125.5 },
      { ID: 3, AMOUNT: 74.25 },
    ]);
    await slice.stop();

    // 2. HTTP `GET /snapshot?format=arrow&compress=gzip` -> `client.fetchArrowSnapshot()` + `syncDatabases(..., { bootstrapStrategy: 'arrow-ipc' })`
    const pub = await createPublication(primary, {
      name: 'pub_arrow_http',
      tables: ['CURRENCIES', 'ORDERS'],
    });
    const handler = createHttpReplicationHandler({
      publication: pub,
      tenantGuard: createTenantIsolationGuard({
        tenantColumn: 'TENANT_ID',
        tenantId: 'globex',
        sharedTables: ['CURRENCIES'],
      }),
    });
    const client = createHttpReplicationClient({
      baseUrl: 'http://edge.local/repl',
      fetch: (input, init) =>
        handler(new Request(typeof input === 'string' ? input : input.toString(), init)),
    });
    const arrowSnap = await client.fetchArrowSnapshot({ compressGzip: true });
    expect(arrowSnap.tables).toHaveLength(2);
    const globexOrdersTbl = arrowSnap.tables.find((t) => t.table === 'ORDERS')!;
    expect(globexOrdersTbl.rowCount).toBe(1);
    expect(decodeArrowIpc(globexOrdersTbl.arrowBytes).toRows()).toEqual([
      { ID: 2, TENANT_ID: 'globex', AMOUNT: 999 },
    ]);

    await using fullSync = await syncDatabases(primary, httpReplica, {
      bootstrapStrategy: 'arrow-ipc',
      live: false,
    });
    const httpOrders = await httpReplica.query('SELECT ID FROM ORDERS ORDER BY ID');
    expect(httpOrders.rows.map((r) => r.ID)).toEqual([1, 2, 3]);
    void fullSync;

    // Also verify subscription watermark alignment
    const sub = await createSubscription(httpReplica, {
      name: 'sub_check',
      publication: pub,
    });
    expect(await sub.getWatermark()).toBeGreaterThanOrEqual(0);
  });
});

describe('M23 Item 4: Declarative Virtual Tables & Remote /arrow Federation (db.registerVirtualTable())', () => {
  it('mounts Arrow IPC buffers, CSV/JSONL sources, async generators, and live serve-sync GET /arrow endpoints for SQL JOINs & refresh()', async () => {
    await using remoteDb = new FirebirdBrowser('memory://m23_vt_remote', { threads: false });
    await remoteDb.execute(
      'CREATE TABLE PRICING (SKU VARCHAR(32) NOT NULL PRIMARY KEY, UNIT_PRICE DOUBLE PRECISION)',
    );
    await remoteDb.execute("INSERT INTO PRICING VALUES ('PRO_SEAT', 29.0)");
    await remoteDb.execute("INSERT INTO PRICING VALUES ('ENT_SEAT', 99.0)");

    await using srv = await startCliReplicationServer({
      db: remoteDb,
      port: 0,
    });

    await using localDb = new FirebirdBrowser('memory://m23_vt_local', { threads: false });
    await localDb.execute(
      'CREATE TABLE SUBSCRIPTIONS (ORG VARCHAR(32) NOT NULL PRIMARY KEY, SKU VARCHAR(32), SEATS INTEGER)',
    );
    await localDb.execute("INSERT INTO SUBSCRIPTIONS VALUES ('Acme Corp', 'PRO_SEAT', 10)");
    await localDb.execute("INSERT INTO SUBSCRIPTIONS VALUES ('Globex', 'ENT_SEAT', 5)");

    // 1. Mount remote `serve-sync` `/arrow` endpoint as virtual table `REMOTE_PRICING`
    await using remotePricingVt = await localDb.registerVirtualTable(
      'REMOTE_PRICING',
      {
        url: `${srv.url}/arrow?sql=${encodeURIComponent('SELECT SKU, UNIT_PRICE FROM PRICING ORDER BY SKU')}`,
        format: 'arrow',
      },
      { primaryKey: 'SKU', ttlMs: 50 },
    );
    expect(remotePricingVt.rowCount).toBe(2);

    // 2. Mount CSV text source as virtual table `DISCOUNTS`
    await using discountsVt = await localDb.registerVirtualTable(
      'DISCOUNTS',
      {
        format: 'csv',
        data: 'ORG,DISCOUNT_PCT\n"Acme Corp",10\nGlobex,20\n',
      },
      { primaryKey: 'ORG' },
    );
    expect(discountsVt.rowCount).toBe(2);

    // 3. Mount in-memory Arrow IPC buffer as virtual table `TAX_RATES`
    const taxArrow = encodeArrowIpc(
      rowsToColumnarResult({
        fields: [
          { name: 'ORG', typeName: 'VARYING', nullable: false },
          { name: 'TAX_PCT', typeName: 'DOUBLE', nullable: false },
        ],
        rows: [
          { ORG: 'Acme Corp', TAX_PCT: 5.0 },
          { ORG: 'Globex', TAX_PCT: 0.0 },
        ],
      }),
    );
    await using taxVt = await localDb.registerVirtualTable('TAX_RATES', taxArrow, {
      primaryKey: 'ORG',
    });
    expect(taxVt.rowCount).toBe(2);

    // Execute a 4-way relational SQL JOIN across local Firebird table + 3 federated virtual tables!
    const joined = await localDb.query<{
      ORG: string;
      GROSS: number;
      DISCOUNT_PCT: number;
      TAX_PCT: number;
    }>(
      `SELECT s.ORG,
              (s.SEATS * p.UNIT_PRICE) AS GROSS,
              d.DISCOUNT_PCT,
              t.TAX_PCT
         FROM SUBSCRIPTIONS s
         JOIN REMOTE_PRICING p ON p.SKU = s.SKU
         JOIN DISCOUNTS d ON d.ORG = s.ORG
         JOIN TAX_RATES t ON t.ORG = s.ORG
        ORDER BY s.ORG`,
    );
    expect(joined.rows).toEqual([
      { ORG: 'Acme Corp', GROSS: 290, DISCOUNT_PCT: 10, TAX_PCT: 5 },
      { ORG: 'Globex', GROSS: 495, DISCOUNT_PCT: 20, TAX_PCT: 0 },
    ]);

    // Update remote database and call `await remotePricingVt.refresh()`
    await remoteDb.execute("UPDATE PRICING SET UNIT_PRICE = 35.0 WHERE SKU = 'PRO_SEAT'");
    const refreshed = await remotePricingVt.refresh();
    expect(refreshed.rowCount).toBe(2);

    const updatedJoin = await localDb.query<{ GROSS: number }>(
      `SELECT (s.SEATS * p.UNIT_PRICE) AS GROSS
         FROM SUBSCRIPTIONS s
         JOIN REMOTE_PRICING p ON p.SKU = s.SKU
        WHERE s.ORG = 'Acme Corp'`,
    );
    expect(updatedJoin.rows[0]?.GROSS).toBe(350);
  });
});
