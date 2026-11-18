import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATVIEWS_TABLE,
  FirebirdBrowser,
  arrowToCsvStream,
  arrowToNdjsonStream,
  collectArrowStreamBytes,
  createHttpReplicationClient,
  createJwksKeyProvider,
  createJwtTenantAuthResolver,
  createOptimisticMutationStore,
  createPublication,
  createSubscription,
  createUndoRedoManager,
  createWebSocketReplicationPeer,
  csvToArrowStream,
  decodeArrowIpc,
  ndjsonToArrowStream,
  signSyncJwt,
  verifySyncJwt,
  type JwksDocument,
  type WebSocketLike,
} from '../browser';
import { startCliReplicationServer } from '../cli-sync-server';
import { runCli } from '../cli';
import { useUndoRedo as useReactUndoRedo } from '../react';
import { useUndoRedo as useVueUndoRedo } from '../vue';
import { createUndoRedo as createSvelteUndoRedo } from '../svelte';
import { createUndoRedo as createSolidUndoRedo } from '../solid';

describe('M24 Item 1: JWKS Key Rotation, Per-Row RLS Claims & Live Token Refresh', () => {
  it('resolves JWKS keys by kid, caches within TTL, and auto-refreshes on unknown kid rotation', async () => {
    const kp1 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const kp2 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const pubJwk1 = { ...(await crypto.subtle.exportKey('jwk', kp1.publicKey)), kid: 'kid_v1', alg: 'ES256', use: 'sig' };
    const pubJwk2 = { ...(await crypto.subtle.exportKey('jwk', kp2.publicKey)), kid: 'kid_v2', alg: 'ES256', use: 'sig' };

    let activeKeys = [pubJwk1];
    let jwksFetchCount = 0;
    const provider = createJwksKeyProvider({
      jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
      cacheTtlMs: 600_000,
      fetch: async () => {
        jwksFetchCount++;
        const doc: JwksDocument = { keys: activeKeys };
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const tok1 = await signSyncJwt(
      { sub: 'u_1', tenant_id: 'acme', role: 'writer' },
      kp1.privateKey,
      { algorithm: 'ES256', kid: 'kid_v1', expiresInSec: 120 },
    );
    const verified1 = await verifySyncJwt(tok1, provider);
    expect(verified1.tenant_id).toBe('acme');
    expect(jwksFetchCount).toBe(1);

    // Second verification of kid_v1 hits cache without re-fetching
    await verifySyncJwt(tok1, provider);
    expect(jwksFetchCount).toBe(1);

    // Rotate server JWKS to include kid_v2 and sign with kp2 before TTL expires
    activeKeys = [pubJwk1, pubJwk2];
    const tok2 = await signSyncJwt(
      { sub: 'u_1', tenant_id: 'acme', role: 'admin' },
      kp2.privateKey,
      { algorithm: 'ES256', kid: 'kid_v2', expiresInSec: 120 },
    );
    const verified2 = await verifySyncJwt(tok2, provider);
    expect(verified2.role).toBe('admin');
    expect(jwksFetchCount).toBe(2);
    expect(provider.cachedKeysCount).toBe(2);
  });

  it('enforces per-row rls JWT claims across outbound /changes, JSON & Arrow /snapshot, and inbound /push + live token refresh', async () => {
    const db = new FirebirdBrowser('memory://m24_rls_srv', { threads: false });
    await db.execute(
      `CREATE TABLE ORDERS (
        ID INTEGER NOT NULL PRIMARY KEY,
        TENANT_ID VARCHAR(32) NOT NULL,
        REGION VARCHAR(16) NOT NULL,
        OWNER_ID VARCHAR(32) NOT NULL,
        TOTAL INTEGER NOT NULL
      )`,
    );

    const jwtSecret = 'm24-rls-secret-key-32-bytes-long!';
    const server = await startCliReplicationServer({
      db,
      port: 0,
      tenantColumn: 'TENANT_ID',
      jwtSecret,
    });

    try {
      await db.execute(
        `INSERT INTO ORDERS (ID, TENANT_ID, REGION, OWNER_ID, TOTAL) VALUES (1, 'acme', 'EU', 'u_42', 120)`,
      );
      await db.execute(
        `INSERT INTO ORDERS (ID, TENANT_ID, REGION, OWNER_ID, TOTAL) VALUES (2, 'acme', 'US', 'u_42', 250)`,
      );
      await db.execute(
        `INSERT INTO ORDERS (ID, TENANT_ID, REGION, OWNER_ID, TOTAL) VALUES (3, 'acme', 'EU', 'u_99', 410)`,
      );
      await db.execute(
        `INSERT INTO ORDERS (ID, TENANT_ID, REGION, OWNER_ID, TOTAL) VALUES (4, 'globex', 'EU', 'u_42', 999)`,
      );

      const expiredOrWrongToken = await signSyncJwt(
        { sub: 'u_42', tenant_id: 'acme', role: 'reader', rls: { ORDERS: { REGION: 'APAC' } } },
        jwtSecret,
        { expiresInSec: 120 },
      );

      const client = createHttpReplicationClient({
        baseUrl: server.url,
        apiKey: () => expiredOrWrongToken,
      });

      const apacSnap = await client.fetchSnapshot();
      const apacOrders = apacSnap.tables.find((t) => t.table === 'ORDERS');
      expect(apacOrders?.rows ?? []).toHaveLength(0);

      // Live token rotation via setAuthToken() without recreating client
      const euUser42Token = await signSyncJwt(
        {
          sub: 'u_42',
          tenant_id: 'acme',
          role: 'writer',
          rls: { ORDERS: { REGION: 'EU', OWNER_ID: 'u_42' } },
        },
        jwtSecret,
        { expiresInSec: 300 },
      );
      client.setAuthToken(async () => euUser42Token);

      const changes = await client.fetchChangesSince(0);
      expect(changes.map((e) => Number(e.after?.ID))).toEqual([1]);

      const jsonSnap = await client.fetchSnapshot();
      const euOrders = jsonSnap.tables.find((t) => t.table === 'ORDERS');
      expect(euOrders?.rows.map((r) => r.ID)).toEqual([1]);

      const arrowSnap = await client.fetchArrowSnapshot();
      const arrowOrders = arrowSnap.tables.find((t) => t.table === 'ORDERS')!;
      const decodedArrow = decodeArrowIpc(arrowOrders.arrowBytes);
      expect(decodedArrow.toRows().map((r) => r.ID)).toEqual([1]);

      // Inbound push violating RLS (REGION = 'US') is rejected with HTTP 403 JWT_RLS_FORBIDDEN
      const forbiddenPush = await fetch(`${server.url}/push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${euUser42Token}`,
        },
        body: JSON.stringify({
          entries: [
            {
              lsn: 100,
              txid: 'tx_bad_rls',
              timestamp: Date.now(),
              origin: 'edge_client',
              publication: 'default',
              table: 'ORDERS',
              operation: 'INSERT',
              key: { ID: 10 },
              after: { ID: 10, TENANT_ID: 'acme', REGION: 'US', OWNER_ID: 'u_42', TOTAL: 50 },
              ddlSql: null,
            },
          ],
        }),
      });
      expect(forbiddenPush.status).toBe(403);
      const forbiddenBody = (await forbiddenPush.json()) as { code: string };
      expect(forbiddenBody.code).toBe('JWT_RLS_FORBIDDEN');

      // Authorized RLS push (REGION = 'EU', OWNER_ID = 'u_42') succeeds
      await client.pushChanges([
        {
          lsn: 101,
          txid: 'tx_ok_rls',
          timestamp: Date.now(),
          origin: 'edge_client',
          publication: 'default',
          table: 'ORDERS',
          operation: 'INSERT',
          key: { ID: 11 },
          after: { ID: 11, TENANT_ID: 'acme', REGION: 'EU', OWNER_ID: 'u_42', TOTAL: 75 },
          ddlSql: null,
        },
      ]);
      const checkRow = await db.query('SELECT TOTAL FROM ORDERS WHERE ID = 11');
      expect(checkRow.rows).toEqual([{ TOTAL: 75 }]);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('supports live WebSocket JWT rotation via wsPeer.refreshAuth()', async () => {
    const serverDb = new FirebirdBrowser('memory://m24_ws_srv', { threads: false });
    const clientDb = new FirebirdBrowser('memory://m24_ws_cli', { threads: false });
    await serverDb.execute('CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, REGION VARCHAR(16))');
    await clientDb.execute('CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, REGION VARCHAR(16))');

    const secret = 'ws-jwt-rotation-secret-32-bytes!!';
    const resolver = createJwtTenantAuthResolver({ secretOrPublicKey: secret });

    const serverPub = await createPublication(serverDb, {
      name: 'pub_ws',
      nodeId: 'srv',
      tables: [{ table: 'ITEMS', primaryKey: 'ID' }],
    });
    const serverSub = await createSubscription(serverDb, {
      name: 'sub_ws_srv',
      nodeId: 'srv',
      publication: serverPub,
    });
    const clientPub = await createPublication(clientDb, {
      name: 'pub_ws',
      nodeId: 'cli',
      tables: [{ table: 'ITEMS', primaryKey: 'ID' }],
    });

    const srvHandlers: Array<(ev: { data: unknown }) => void> = [];
    const cliHandlers: Array<(ev: { data: unknown }) => void> = [];
    const srvSocket: WebSocketLike = {
      send(data) {
        for (const fn of cliHandlers) fn({ data });
      },
      addEventListener(_t, fn) {
        srvHandlers.push(fn);
      },
    };
    const cliSocket: WebSocketLike = {
      send(data) {
        for (const fn of srvHandlers) fn({ data });
      },
      addEventListener(_t, fn) {
        cliHandlers.push(fn);
      },
    };

    const wsErrors: Error[] = [];
    const srvPeer = createWebSocketReplicationPeer({
      socket: srvSocket,
      publication: serverPub,
      subscription: serverSub,
      jwtAuth: resolver,
      onError: (e) => wsErrors.push(e),
    });

    const readerTok = await signSyncJwt({ sub: 'u1', role: 'reader' }, secret, { expiresInSec: 60 });
    const cliPeer = createWebSocketReplicationPeer({
      socket: cliSocket,
      publication: clientPub,
      authToken: readerTok,
    });

    try {
      const writerTok = await signSyncJwt(
        { sub: 'u1', role: 'writer', rls: { ITEMS: { REGION: 'EU' } } },
        secret,
        { expiresInSec: 60 },
      );
      await cliPeer.refreshAuth(writerTok);
      await new Promise((r) => setTimeout(r, 20));

      await clientDb.execute("INSERT INTO ITEMS VALUES (1, 'EU')");
      await clientPub.captureTableChanges();
      await cliPeer.pushSince(0);
      await new Promise((r) => setTimeout(r, 30));

      expect(wsErrors).toHaveLength(0);
      const srvRows = await serverDb.query('SELECT ID, REGION FROM ITEMS');
      expect(srvRows.rows).toEqual([{ ID: 1, REGION: 'EU' }]);
    } finally {
      cliPeer.close();
      srvPeer.close();
      await clientDb.close();
      await serverDb.close();
    }
  });
});

describe('M24 Item 2: Persistent & Auto-Refreshing Materialized Views', () => {
  it('creates indexed materialized views in FB_MATVIEWS$, performs keyed diff + full refresh, and auto-refreshes on commit', async () => {
    const db = new FirebirdBrowser('memory://m24_matview', { threads: false });
    try {
      await db.execute(
        `CREATE TABLE SALES (
          ID INTEGER NOT NULL PRIMARY KEY,
          REGION VARCHAR(32) NOT NULL,
          AMOUNT INTEGER NOT NULL
        )`,
      );
      await db.execute("INSERT INTO SALES VALUES (1, 'EU', 100)");
      await db.execute("INSERT INTO SALES VALUES (2, 'EU', 50)");
      await db.execute("INSERT INTO SALES VALUES (3, 'US', 80)");

      const mv = await db.createMaterializedView<{
        REGION: string;
        ORDER_CNT: number;
        TOTAL_AMT: number;
      }>(
        'MV_SALES_REGION',
        `SELECT REGION, CAST(COUNT(*) AS INTEGER) AS ORDER_CNT, CAST(SUM(AMOUNT) AS INTEGER) AS TOTAL_AMT
         FROM SALES GROUP BY REGION`,
        {
          primaryKey: 'REGION',
          indexes: ['TOTAL_AMT'],
          refreshStrategy: 'on-commit',
        },
      );

      expect(mv.rowCount).toBe(2);
      expect(mv.watchTables).toEqual(['SALES']);

      const catalogList = await db.listMaterializedViews();
      expect(catalogList).toHaveLength(1);
      expect(catalogList[0]?.name).toBe('MV_SALES_REGION');
      expect(catalogList[0]?.primaryKey).toEqual(['REGION']);

      const initialRows = await mv.query('1 = 1 ORDER BY "REGION"');
      expect(initialRows.rows).toEqual([
        { REGION: 'EU', ORDER_CNT: 2, TOTAL_AMT: 150 },
        { REGION: 'US', ORDER_CNT: 1, TOTAL_AMT: 80 },
      ]);

      // Mutate source table -> 'on-commit' automatically triggers diff refresh!
      await db.execute("INSERT INTO SALES VALUES (4, 'APAC', 200)");
      await db.execute("UPDATE SALES SET AMOUNT = 120 WHERE ID = 1");
      await db.execute("DELETE FROM SALES WHERE REGION = 'US'");

      // Wait for microtask + async diff refresh queue to settle
      for (let attempt = 0; attempt < 40; attempt++) {
        const cur = await mv.query('1 = 1 ORDER BY "REGION"');
        if (
          cur.rows.length === 2 &&
          cur.rows.some((r) => r.REGION === 'APAC') &&
          cur.rows.some((r) => r.REGION === 'EU' && r.TOTAL_AMT === 170)
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const afterAuto = await mv.query('1 = 1 ORDER BY "REGION"');
      expect(afterAuto.rows).toEqual([
        { REGION: 'APAC', ORDER_CNT: 1, TOTAL_AMT: 200 },
        { REGION: 'EU', ORDER_CNT: 2, TOTAL_AMT: 170 },
      ]);

      // Explicit diff refresh when 1 row inserted, 1 updated, 1 deleted
      await mv.dispose(); // Stop auto-watcher to test explicit diff counts deterministically
      await db.execute("INSERT INTO SALES VALUES (5, 'LATAM', 90)");
      await db.execute("UPDATE SALES SET AMOUNT = 250 WHERE ID = 4");
      await db.execute("DELETE FROM SALES WHERE REGION = 'EU'");

      const diffRes = await mv.refresh({ mode: 'diff' });
      expect(diffRes.mode).toBe('diff');
      expect(diffRes.inserted).toBe(1);
      expect(diffRes.updated).toBe(1);
      expect(diffRes.deleted).toBe(1);
      expect(diffRes.rowCount).toBe(2);

      const fullRes = await mv.refresh({ mode: 'full' });
      expect(fullRes.mode).toBe('full');
      expect(fullRes.rowCount).toBe(2);

      await mv.drop();
      expect(await db.listMaterializedViews()).toHaveLength(0);
      const tblCheck = await db.query(
        `SELECT 1 FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) IN ('MV_SALES_REGION')`,
      );
      expect(tblCheck.rows).toHaveLength(0);
      const catCheck = await db.query(`SELECT COUNT(*) AS CNT FROM "${DEFAULT_MATVIEWS_TABLE}"`);
      expect(Number(catCheck.rows[0]?.CNT ?? 0)).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('M24 Item 3: Streaming CSV / NDJSON <-> Apache Arrow IPC V5 & CLI export-arrow / import-arrow', () => {
  it('streams NDJSON and CSV to/from chunked Apache Arrow IPC V5 in bounded batchSize chunks', async () => {
    const ndjsonInput = [
      JSON.stringify({ ID: 1, NAME: 'Alpha', SCORE: 12.5, ACTIVE: true }),
      JSON.stringify({ ID: 2, NAME: 'Beta', SCORE: 24.0, ACTIVE: false }),
      JSON.stringify({ ID: 3, NAME: 'Gamma', SCORE: null, ACTIVE: true }),
      JSON.stringify({ ID: 4, NAME: 'Delta', SCORE: 99.25, ACTIVE: false }),
    ].join('\n');

    const arrowFromNdjson = await collectArrowStreamBytes(
      ndjsonToArrowStream(ndjsonInput, { batchSize: 2 }),
    );
    const decodedNdjson = decodeArrowIpc(arrowFromNdjson);
    expect(decodedNdjson.rowCount).toBe(4);

    const roundTripNdjsonBytes = await collectArrowStreamBytes(
      arrowToNdjsonStream(arrowFromNdjson),
    );
    const roundTripLines = new TextDecoder()
      .decode(roundTripNdjsonBytes)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(roundTripLines).toEqual([
      { ID: 1, NAME: 'Alpha', SCORE: 12.5, ACTIVE: true },
      { ID: 2, NAME: 'Beta', SCORE: 24, ACTIVE: false },
      { ID: 3, NAME: 'Gamma', SCORE: null, ACTIVE: true },
      { ID: 4, NAME: 'Delta', SCORE: 99.25, ACTIVE: false },
    ]);

    const csvInput = [
      'ID,LABEL,NOTES,COUNT',
      '10,"Quote ""A""",First line,42',
      '20,"Comma, B","Multi\nLine",84',
      '30,Plain,,0',
    ].join('\n');

    const arrowFromCsv = await collectArrowStreamBytes(
      csvToArrowStream(csvInput, { batchSize: 2 }),
    );
    const csvBackBytes = await collectArrowStreamBytes(arrowToCsvStream(arrowFromCsv));
    const reParsedArrow = await collectArrowStreamBytes(csvToArrowStream(csvBackBytes));
    expect(decodeArrowIpc(reParsedArrow).toRows()).toEqual([
      { ID: 10, LABEL: 'Quote "A"', NOTES: 'First line', COUNT: 42 },
      { ID: 20, LABEL: 'Comma, B', NOTES: 'Multi\nLine', COUNT: 84 },
      { ID: 30, LABEL: 'Plain', NOTES: null, COUNT: 0 },
    ]);
  });

  it('exports and imports gzipped Apache Arrow IPC V5 files via CLI export-arrow & import-arrow', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m24-cli-arrow-'));
    const srcFdb = path.join(tmpDir, 'source.fdb');
    const dstFdb = path.join(tmpDir, 'dest.fdb');
    const arrowFile = path.join(tmpDir, 'items.arrow.gz');

    try {
      await runCli(
        [
          'query',
          srcFdb,
          "CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64)); INSERT INTO ITEMS VALUES (1, 'One'); INSERT INTO ITEMS VALUES (2, 'Two');",
          '--backend',
          'wasm',
        ],
        { cwd: tmpDir, stdout: () => undefined, stderr: () => undefined },
      );

      let exportOut = '';
      const exportCode = await runCli(
        [
          'export-arrow',
          srcFdb,
          'SELECT ID, TITLE FROM ITEMS ORDER BY ID',
          '--out',
          arrowFile,
          '--gzip',
          '--backend',
          'wasm',
          '--json',
        ],
        { cwd: tmpDir, stdout: (s) => (exportOut += s), stderr: () => undefined },
      );
      expect(exportCode).toBe(0);
      const exportJson = JSON.parse(exportOut) as { rows: number; gzip: boolean };
      expect(exportJson.rows).toBe(2);
      expect(exportJson.gzip).toBe(true);
      expect(fs.existsSync(arrowFile)).toBe(true);

      let importOut = '';
      const importCode = await runCli(
        [
          'import-arrow',
          dstFdb,
          'IMPORTED_ITEMS',
          '--in',
          arrowFile,
          '--create-table',
          '--pk',
          'ID',
          '--backend',
          'wasm',
          '--json',
        ],
        { cwd: tmpDir, stdout: (s) => (importOut += s), stderr: () => undefined },
      );
      expect(importCode).toBe(0);
      const importJson = JSON.parse(importOut) as { rowsIngested: number; tableCreated: boolean };
      expect(importJson.rowsIngested).toBe(2);
      expect(importJson.tableCreated).toBe(true);

      let verifyOut = '';
      await runCli(
        ['query', dstFdb, 'SELECT ID, TITLE FROM IMPORTED_ITEMS ORDER BY ID', '--format', 'json', '--backend', 'wasm'],
        { cwd: tmpDir, stdout: (s) => (verifyOut += s), stderr: () => undefined },
      );
      expect(JSON.parse(verifyOut)).toEqual([
        { ID: 1, TITLE: 'One' },
        { ID: 2, TITLE: 'Two' },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('M24 Item 4 & 5: Local-First Undo/Redo, Cross-Tab Outbox Sync, Framework Hooks & Sub-1,800-Line Modules', () => {
  it('selectively undoes and redoes grouped user actions without touching concurrent peer rows and syncs across BroadcastChannel', async () => {
    const db = new FirebirdBrowser('memory://m24_undo_redo', { threads: false });
    try {
      await db.execute(
        'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64), DONE SMALLINT)',
      );
      await db.execute("INSERT INTO TASKS VALUES (1, 'Initial Task', 0)");

      const optTabA = createOptimisticMutationStore(db, {
        persist: true,
        broadcastChannel: 'm24_outbox_bus',
      });
      const optTabB = createOptimisticMutationStore(db, {
        persist: true,
        broadcastChannel: 'm24_outbox_bus',
      });
      await optTabA.hydrate();
      await optTabB.hydrate();

      const undoTabA = createUndoRedoManager(db, {
        optimisticStore: optTabA,
        broadcastChannel: 'm24_undo_bus',
      });
      const undoTabB = createUndoRedoManager(db, {
        optimisticStore: optTabB,
        broadcastChannel: 'm24_undo_bus',
      });

      // User performs a grouped multi-row edit in Tab A
      await undoTabA.run('Add #2 and complete #1', async (tx) => {
        await tx.update('TASKS', 1, { TITLE: 'Edited By User', DONE: 1 }, { primaryKey: 'ID' });
        await tx.insert('TASKS', { ID: 2, TITLE: 'User Added Task', DONE: 0 }, { primaryKey: 'ID' });
      });

      // Wait briefly for async cross-tab hydration
      await new Promise((r) => setTimeout(r, 40));
      expect(optTabB.getSnapshot().pendingCount).toBe(2);
      expect(undoTabB.getSnapshot().undoCount).toBe(1);

      // Meanwhile, a background replication peer inserts Row #99 directly into TASKS
      await db.execute("INSERT INTO TASKS VALUES (99, 'Background Peer Task', 1)");

      // Undo the user's grouped checkpoint -> reverts #1 and #2 while leaving #99 intact!
      const undone = await undoTabA.undo();
      expect(undone?.label).toBe('Add #2 and complete #1');

      const afterUndo = await db.query('SELECT ID, TITLE, DONE FROM TASKS ORDER BY ID');
      expect(afterUndo.rows).toEqual([
        { ID: 1, TITLE: 'Initial Task', DONE: 0 },
        { ID: 99, TITLE: 'Background Peer Task', DONE: 1 },
      ]);
      expect(undoTabA.canUndo).toBe(false);
      expect(undoTabA.canRedo).toBe(true);

      // Redo re-applies #1 and #2 while still keeping #99 intact!
      const redone = await undoTabA.redo();
      expect(redone?.label).toBe('Add #2 and complete #1');

      const afterRedo = await db.query('SELECT ID, TITLE, DONE FROM TASKS ORDER BY ID');
      expect(afterRedo.rows).toEqual([
        { ID: 1, TITLE: 'Edited By User', DONE: 1 },
        { ID: 2, TITLE: 'User Added Task', DONE: 0 },
        { ID: 99, TITLE: 'Background Peer Task', DONE: 1 },
      ]);

      // Verify Svelte & Solid reactive adapters + React & Vue hook exports
      expect(typeof useReactUndoRedo).toBe('function');
      expect(typeof useVueUndoRedo).toBe('function');

      const svelteUndo = createSvelteUndoRedo(undoTabA);
      const solidUndo = createSolidUndoRedo(undoTabA);
      expect(svelteUndo.canUndo).toBe(true);
      expect(solidUndo.canUndo()).toBe(true);

      await svelteUndo.undo();
      expect(svelteUndo.canRedo).toBe(true);
      expect(solidUndo.canRedo()).toBe(true);

      await solidUndo.redo();
      expect(svelteUndo.undoCount).toBe(1);
      expect(solidUndo.undoCount()).toBe(1);

      svelteUndo.destroy();
      solidUndo.dispose();
      undoTabA.close();
      undoTabB.close();
      optTabA.close();
      optTabB.close();
    } finally {
      await db.close();
    }
  });

  it('keeps every non-test .ts source file in packages/firebird-wasm/src strictly below 1,800 lines', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const oversized: Array<{ file: string; lines: number }> = [];

    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === '__tests__') continue;
          walk(full);
        } else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
          const lineCount = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
          if (lineCount >= 1800) {
            oversized.push({ file: path.relative(srcRoot, full), lines: lineCount });
          }
        }
      }
    };

    walk(srcRoot);
    expect(oversized).toEqual([]);
  });
});
