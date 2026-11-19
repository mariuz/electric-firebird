/**
 * m25-features.test.ts – Comprehensive Verification Suite for Milestone M25:
 *   1. Real-Time SSE Fanout Hub (`GET /events`), `Last-Event-ID` Resume & `liveSse: true`
 *   2. Client-Side Column-Level E2EE Sync (`createColumnEncryptionTransformer`) & Key Rotation
 *   3. Auto-Maintained Quantized Hybrid Vector + BM25 Search (`autoSync`, `int8`/`binary`, SQL `where`)
 *   4. Declarative Schema Diff / Push (`syncDatabaseSchema`) & CLI `schema-diff` / `schema-push`
 *   5. `<firebird-repl>` Search Index & Schema-Diff Telemetry + Strict `< 1,650`-Line Module Budget
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ColumnEncryptionError,
  DestructiveSchemaSyncError,
  FirebirdBrowser,
  bootstrapReplica,
  createColumnEncryptionTransformer,
  createFtsIndex,
  createPublication,
  createSseReplicationClient,
  createSubscription,
  createVectorIndex,
  decodeQuantizedInt8,
  dequantizeVectorInt8,
  encodeQuantizedInt8,
  encodeVector,
  hammingDistance,
  hybridSearch,
  isEncryptedColumnEnvelope,
  quantizeVectorBinary,
  quantizeVectorInt8,
  signSyncJwt,
  syncCatalog,
  syncDatabaseSchema,
  syncDatabases,
  syncWithPeer,
  vectorSearch,
} from '../index';
import { startCliReplicationServer, runCli } from '../cli';
import { executeReplSchemaDiff, fetchReplSearchIndexes } from '../repl/repl-actions';

describe('M25 Item 1: Real-Time SSE Fanout Hub, Last-Event-ID Resume & Zero-Polling liveSse', () => {
  it('fans out live local DML and POST /push deltas over SSE GET /events with per-tenant JWT filtering and Last-Event-ID catch-up', async () => {
    const serverDb = new FirebirdBrowser('memory://m25_sse_primary', { threads: false });
    const acmeReplica = new FirebirdBrowser('memory://m25_sse_acme', { threads: false });
    const globexReplica = new FirebirdBrowser('memory://m25_sse_globex', { threads: false });

    const jwtSecret = 'm25-sse-super-secret-hmac-key-256bits';
    let serverHandle: Awaited<ReturnType<typeof startCliReplicationServer>> | null = null;

    try {
      await serverDb.execute(
        `CREATE TABLE TASKS (
          ID INTEGER NOT NULL PRIMARY KEY,
          TENANT_ID VARCHAR(32) NOT NULL,
          TITLE VARCHAR(120) NOT NULL
        )`,
      );
      await syncCatalog({ sourceDb: serverDb, targetDb: acmeReplica });
      await syncCatalog({ sourceDb: serverDb, targetDb: globexReplica });

      serverHandle = await startCliReplicationServer({
        db: serverDb,
        port: 0,
        jwtSecret,
        tenantColumn: 'TENANT_ID',
      });

      const acmeToken = await signSyncJwt(
        { sub: 'u_acme', tenant_id: 'acme', role: 'writer' },
        jwtSecret,
        { expiresInSec: 300 },
      );
      const globexToken = await signSyncJwt(
        { sub: 'u_globex', tenant_id: 'globex', role: 'writer' },
        jwtSecret,
        { expiresInSec: 300 },
      );

      const acmeSub = await createSubscription(acmeReplica, {
        name: 'sub_sse_acme',
        publication: serverHandle.publication,
      });
      const globexSub = await createSubscription(globexReplica, {
        name: 'sub_sse_globex',
        publication: serverHandle.publication,
      });

      const acmeSse = createSseReplicationClient({
        baseUrl: serverHandle.url,
        authToken: acmeToken,
        subscription: acmeSub,
      });
      const globexSse = createSseReplicationClient({
        baseUrl: serverHandle.url,
        authToken: globexToken,
        subscription: globexSub,
      });

      try {
        await Promise.all([acmeSse.waitForConnected(), globexSse.waitForConnected()]);
        expect(serverHandle.sseHub.subscriberCount).toBe(2);

        // Execute direct SQL DML on serverDb -> auto-fanout over SSE without polling!
        await serverDb.execute("INSERT INTO TASKS VALUES (1, 'acme', 'Acme Live SSE #1')");
        await serverDb.execute("INSERT INTO TASKS VALUES (2, 'globex', 'Globex Live SSE #2')");

        for (let i = 0; i < 40; i++) {
          const a = await acmeReplica.query('SELECT ID FROM TASKS');
          const g = await globexReplica.query('SELECT ID FROM TASKS');
          if (a.rows.length === 1 && g.rows.length === 1) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        const acmeRows1 = await acmeReplica.query('SELECT ID, TENANT_ID, TITLE FROM TASKS');
        const globexRows1 = await globexReplica.query('SELECT ID, TENANT_ID, TITLE FROM TASKS');
        expect(acmeRows1.rows).toEqual([
          { ID: 1, TENANT_ID: 'acme', TITLE: 'Acme Live SSE #1' },
        ]);
        expect(globexRows1.rows).toEqual([
          { ID: 2, TENANT_ID: 'globex', TITLE: 'Globex Live SSE #2' },
        ]);

        // Disconnect acme SSE, commit missed changes while offline, then resume via Last-Event-ID / sinceLsn
        const lastAcmeEventId = acmeSse.lastEventId;
        expect(lastAcmeEventId).toBeGreaterThan(0);
        await acmeSse.close();

        await serverDb.execute("INSERT INTO TASKS VALUES (3, 'acme', 'Acme Missed While Offline')");
        await serverDb.execute("INSERT INTO TASKS VALUES (4, 'globex', 'Globex Ignored By Acme')");

        const acmeResumed = createSseReplicationClient({
          baseUrl: serverHandle.url,
          authToken: acmeToken,
          sinceLsn: lastAcmeEventId,
          subscription: acmeSub,
        });
        try {
          await acmeResumed.waitForConnected();
          for (let i = 0; i < 40; i++) {
            const a = await acmeReplica.query('SELECT ID FROM TASKS ORDER BY ID');
            if (a.rows.length === 2) break;
            await new Promise((r) => setTimeout(r, 25));
          }
          const acmeAfterResume = await acmeReplica.query(
            'SELECT ID, TENANT_ID, TITLE FROM TASKS ORDER BY ID',
          );
          expect(acmeAfterResume.rows).toEqual([
            { ID: 1, TENANT_ID: 'acme', TITLE: 'Acme Live SSE #1' },
            { ID: 3, TENANT_ID: 'acme', TITLE: 'Acme Missed While Offline' },
          ]);
        } finally {
          await acmeResumed.close();
        }
      } finally {
        await acmeSse.close();
        await globexSse.close();
      }
    } finally {
      if (serverHandle) await serverHandle.close();
      await globexReplica.close();
      await acmeReplica.close();
      await serverDb.close();
    }
  });

  it('synchronizes bidirectionally with zero polling via syncWithPeer(..., { liveSse: true })', async () => {
    const serverDb = new FirebirdBrowser('memory://m25_livesse_srv', { threads: false });
    const edgeDb = new FirebirdBrowser('memory://m25_livesse_edge', { threads: false });
    let serverHandle: Awaited<ReturnType<typeof startCliReplicationServer>> | null = null;

    try {
      await serverDb.execute(
        'CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(80) NOT NULL)',
      );
      await serverDb.execute("INSERT INTO ITEMS VALUES (1, 'Seed Item')");
      await syncCatalog({ sourceDb: serverDb, targetDb: edgeDb });

      serverHandle = await startCliReplicationServer({
        db: serverDb,
        port: 0,
      });

      const sync = await syncWithPeer(edgeDb, serverHandle.url, {
        direction: 'bidirectional',
        liveSse: true,
      });
      try {
        // Wait for SSE client inside syncWithPeer to register
        for (let i = 0; i < 30 && serverHandle.sseHub.subscriberCount === 0; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }

        // 1. Server -> Edge push via SSE
        await serverDb.execute("INSERT INTO ITEMS VALUES (2, 'Pushed From Server')");
        for (let i = 0; i < 40; i++) {
          const r = await edgeDb.query('SELECT ID FROM ITEMS WHERE ID = 2');
          if (r.rows.length === 1) break;
          await new Promise((res) => setTimeout(res, 25));
        }
        expect((await edgeDb.query('SELECT NAME FROM ITEMS WHERE ID = 2')).rows).toEqual([
          { NAME: 'Pushed From Server' },
        ]);

        // 2. Edge -> Server reactive push via onQuery
        await edgeDb.execute("INSERT INTO ITEMS VALUES (3, 'Written On Edge')");
        for (let i = 0; i < 40; i++) {
          const r = await serverDb.query('SELECT ID FROM ITEMS WHERE ID = 3');
          if (r.rows.length === 1) break;
          await new Promise((res) => setTimeout(res, 25));
        }
        expect((await serverDb.query('SELECT NAME FROM ITEMS WHERE ID = 3')).rows).toEqual([
          { NAME: 'Written On Edge' },
        ]);
      } finally {
        await sync.stop();
      }
    } finally {
      if (serverHandle) await serverHandle.close();
      await edgeDb.close();
      await serverDb.close();
    }
  });
});

describe('M25 Item 2: Client-Side Column-Level E2EE Sync & Key Rotation', () => {
  it('encrypts sensitive columns end-to-end with AAD binding and zero-downtime key rotation while keeping TENANT_ID cleartext on relays', async () => {
    const writerDb = new FirebirdBrowser('memory://m25_e2ee_writer', { threads: false });
    const relayDb = new FirebirdBrowser('memory://m25_e2ee_relay', { threads: false });
    const readerDb = new FirebirdBrowser('memory://m25_e2ee_reader', { threads: false });

    try {
      const ddl = `CREATE TABLE VAULT_NOTES (
        ID INTEGER NOT NULL PRIMARY KEY,
        TENANT_ID VARCHAR(32) NOT NULL,
        SECRET_BODY VARCHAR(512) NOT NULL,
        CLEARANCE VARCHAR(256) NOT NULL
      )`;
      await writerDb.execute(ddl);
      await relayDb.execute(ddl);
      await readerDb.execute(ddl);

      await writerDb.execute(
        "INSERT INTO VAULT_NOTES VALUES (1, 'acme', 'Launch code alpha-9', 'LEVEL-5')",
      );

      const writerCrypto = createColumnEncryptionTransformer({
        columns: { VAULT_NOTES: ['SECRET_BODY', 'CLEARANCE'] },
        keys: { k1: 'tenant-acme-master-key-v1' },
        activeKid: 'k1',
      });
      const readerCrypto = createColumnEncryptionTransformer({
        columns: { VAULT_NOTES: ['SECRET_BODY', 'CLEARANCE'] },
        keys: { k1: 'tenant-acme-master-key-v1' },
        activeKid: 'k1',
        mode: 'decrypt',
        strictInbound: true,
      });

      const writerPub = await createPublication(writerDb, {
        name: 'pub_e2ee',
        tables: ['VAULT_NOTES'],
        transformRow: writerCrypto.encrypt,
      });

      // Relay subscription stores ciphertext verbatim without possessing any key!
      const relayPub = await createPublication(relayDb, {
        name: 'pub_relay',
        tables: ['VAULT_NOTES'],
        installTriggers: false,
      });
      const relaySub = await createSubscription(relayDb, {
        name: 'sub_relay',
        publication: writerPub,
      });

      // Bootstrap relay from writer's encrypted snapshot
      await bootstrapReplica({
        targetDb: relayDb,
        publication: writerPub,
        subscription: relaySub,
      });

      const relayRow1 = (await relayDb.query('SELECT * FROM VAULT_NOTES WHERE ID = 1'))
        .rows[0]!;
      expect(relayRow1.TENANT_ID).toBe('acme');
      expect(isEncryptedColumnEnvelope(relayRow1.SECRET_BODY)).toBe(true);
      expect(String(relayRow1.SECRET_BODY).startsWith('enc:v1:k1:')).toBe(true);
      expect(String(relayRow1.SECRET_BODY)).not.toContain('Launch code');

      // Authorized reader bootstraps from untrusted relay and decrypts transparently
      const readerSub = await createSubscription(readerDb, {
        name: 'sub_reader',
        publication: relayPub,
        transformRow: readerCrypto.decrypt,
      });
      await bootstrapReplica({
        targetDb: readerDb,
        publication: relayPub,
        subscription: readerSub,
      });

      expect((await readerDb.query('SELECT * FROM VAULT_NOTES WHERE ID = 1')).rows).toEqual([
        {
          ID: 1,
          TENANT_ID: 'acme',
          SECRET_BODY: 'Launch code alpha-9',
          CLEARANCE: 'LEVEL-5',
        },
      ]);

      // Rotate key to k2 and replicate incremental row #2
      writerCrypto.rotateKey('k2', 'tenant-acme-master-key-v2');
      readerCrypto.addKey('k2', 'tenant-acme-master-key-v2');
      expect(writerCrypto.activeKid).toBe('k2');

      await writerDb.execute(
        "INSERT INTO VAULT_NOTES VALUES (2, 'acme', 'Post-rotation secret beta', 'LEVEL-9')",
      );
      await writerPub.captureTableChanges();
      await relaySub.pull();
      await relayPub.captureTableChanges();
      await readerSub.pull();

      const relayRow2 = (await relayDb.query('SELECT * FROM VAULT_NOTES WHERE ID = 2'))
        .rows[0]!;
      expect(String(relayRow2.SECRET_BODY).startsWith('enc:v1:k2:')).toBe(true);

      const readerRows = await readerDb.query('SELECT * FROM VAULT_NOTES ORDER BY ID');
      expect(readerRows.rows).toEqual([
        {
          ID: 1,
          TENANT_ID: 'acme',
          SECRET_BODY: 'Launch code alpha-9',
          CLEARANCE: 'LEVEL-5',
        },
        {
          ID: 2,
          TENANT_ID: 'acme',
          SECRET_BODY: 'Post-rotation secret beta',
          CLEARANCE: 'LEVEL-9',
        },
      ]);

      // Verify AAD binding prevents swapping ciphertext across rows OR across columns!
      await expect(
        readerCrypto.decryptRow('VAULT_NOTES', {
          ID: 999, // Wrong PK -> AAD mismatch!
          TENANT_ID: 'acme',
          SECRET_BODY: relayRow2.SECRET_BODY,
          CLEARANCE: relayRow2.CLEARANCE,
        }),
      ).rejects.toThrow(ColumnEncryptionError);

      await expect(
        readerCrypto.decryptRow('VAULT_NOTES', {
          ID: 2,
          TENANT_ID: 'acme',
          SECRET_BODY: relayRow2.CLEARANCE, // Swapped column -> AAD mismatch!
          CLEARANCE: relayRow2.SECRET_BODY,
        }),
      ).rejects.toThrow(ColumnEncryptionError);
    } finally {
      await readerDb.close();
      await relayDb.close();
      await writerDb.close();
    }
  });
});

describe('M25 Item 3: Auto-Maintained Quantized Hybrid Vector + BM25 Search & SQL Pushdown', () => {
  it('supports int8 & binary vector quantization, autoSync on local DML, SQL where pushdown, and replication indexHooks', async () => {
    // 1. Unit-verify int8 and binary quantization kernels
    const sampleVec = [0.9, -0.4, 0.25, -0.8, 0.1, 0.75, -0.15, 0.5];
    const qInt8 = quantizeVectorInt8(sampleVec);
    expect(qInt8.dimensions).toBe(8);
    expect(qInt8.data).toBeInstanceOf(Int8Array);

    const packedInt8 = encodeQuantizedInt8(qInt8);
    const unpackedInt8 = decodeQuantizedInt8(packedInt8);
    const deq = dequantizeVectorInt8(unpackedInt8);
    for (let i = 0; i < sampleVec.length; i++) {
      expect(Math.abs(deq[i]! - sampleVec[i]!)).toBeLessThan(0.02);
    }

    const binA = quantizeVectorBinary([1, 1, -1, -1, 1, -1, 1, -1]);
    const binB = quantizeVectorBinary([1, -1, -1, 1, 1, -1, 1, -1]);
    expect(binA.byteLength).toBe(1);
    expect(hammingDistance(binA, binB)).toBe(2);

    // 2. Database-backed autoSync quantized HNSW + BM25 + hybridSearch
    const primaryDb = new FirebirdBrowser('memory://m25_rag_primary', {
      threads: false,
      types: { binary: true },
    });
    const replicaDb = new FirebirdBrowser('memory://m25_rag_replica', {
      threads: false,
      types: { binary: true },
    });

    try {
      const ddl = `CREATE TABLE DOCS (
        ID INTEGER NOT NULL PRIMARY KEY,
        TENANT_ID VARCHAR(16) NOT NULL,
        TITLE VARCHAR(120) NOT NULL,
        BODY VARCHAR(512) NOT NULL,
        EMB VARBINARY(16) NOT NULL
      )`;
      await primaryDb.execute(ddl);
      await replicaDb.execute(ddl);

      await primaryDb.execute(
        'INSERT INTO DOCS VALUES (?, ?, ?, ?, ?)',
        [1, 'acme', 'Firebird WASM Replication', 'Zero-polling SSE sync with HNSW search', encodeVector([1, 0, 0, 0])],
      );
      await primaryDb.execute(
        'INSERT INTO DOCS VALUES (?, ?, ?, ?, ?)',
        [2, 'globex', 'Firebird WASM Security', 'Zero-polling SSE sync for globex tenant', encodeVector([0.98, 0.02, 0, 0])],
      );
      await primaryDb.execute(
        'INSERT INTO DOCS VALUES (?, ?, ?, ?, ?)',
        [3, 'acme', 'PostgreSQL FDW Notes', 'Unrelated legacy batch job documentation', encodeVector([0, 0, 1, 0])],
      );

      const vecIdx = await createVectorIndex(primaryDb, {
        table: 'DOCS',
        column: 'EMB',
        quantization: 'int8',
        persist: true,
        autoSync: true,
      });
      const ftsIdx = await createFtsIndex(primaryDb, {
        table: 'DOCS',
        columns: ['TITLE', 'BODY'],
        persist: true,
        autoSync: true,
      });

      expect(vecIdx.quantization).toBe('int8');
      expect(vecIdx.size).toBe(3);

      // Insert row #4 via plain SQL DML -> autoSync updates both indexes without manual upsert()!
      await primaryDb.execute(
        'INSERT INTO DOCS VALUES (?, ?, ?, ?, ?)',
        [
          4,
          'acme',
          'Column Encryption E2EE',
          'AES-256-GCM zero-knowledge column encryption in Firebird WASM',
          encodeVector([0, 1, 0, 0]),
        ],
      );

      // Hybrid search with SQL `where` metadata pre-filter (`TENANT_ID = ?`)
      const hybridHits = await hybridSearch(primaryDb, {
        table: 'DOCS',
        textQuery: 'encryption AES-256-GCM',
        ftsIndex: ftsIdx,
        vectorColumn: 'EMB',
        vectorQuery: [0.05, 0.99, 0, 0],
        vectorIndex: vecIdx,
        where: 'TENANT_ID = ?',
        params: ['acme'],
        limit: 3,
      });

      expect(hybridHits.length).toBeGreaterThanOrEqual(1);
      expect(hybridHits[0]?.ID).toBe(4);
      expect(hybridHits.every((r) => r.TENANT_ID === 'acme')).toBe(true);

      // Binary-quantized scan with exact float32 rescoring + SQL where pushdown
      const binScanHits = await vectorSearch(primaryDb, {
        table: 'DOCS',
        column: 'EMB',
        query: [1, 0, 0, 0],
        quantization: 'binary',
        where: 'TENANT_ID = ?',
        params: ['acme'],
        limit: 2,
      });
      expect(binScanHits[0]?.ID).toBe(1);
      expect(binScanHits.every((r) => r.TENANT_ID === 'acme')).toBe(true);

      // Replicate to replicaDb with asReplicationIndexHook() keeping replica indexes live!
      const replicaVecIdx = await createVectorIndex(replicaDb, {
        table: 'DOCS',
        column: 'EMB',
        quantization: 'binary',
      });
      const replicaFtsIdx = await createFtsIndex(replicaDb, {
        table: 'DOCS',
        columns: ['TITLE', 'BODY'],
      });

      const sync = await syncDatabases(primaryDb, replicaDb, {
        tables: ['DOCS'],
        live: false,
        indexHooks: [
          replicaVecIdx.asReplicationIndexHook(),
          replicaFtsIdx.asReplicationIndexHook(),
        ],
      });
      try {
        await primaryDb.execute(
          'INSERT INTO DOCS VALUES (?, ?, ?, ?, ?)',
          [5, 'acme', 'Replicated RAG Chunk', 'Live replicated HNSW BM25 document', encodeVector([0, 0, 0, 1])],
        );
        await sync.syncNow();
        expect(replicaVecIdx.has ? undefined : replicaVecIdx.size).toBeGreaterThanOrEqual(1);

        const repHits = await hybridSearch(replicaDb, {
          table: 'DOCS',
          textQuery: 'Replicated RAG',
          ftsIndex: replicaFtsIdx,
          vectorColumn: 'EMB',
          vectorQuery: [0, 0, 0, 1],
          vectorIndex: replicaVecIdx,
          limit: 2,
        });
        expect(repHits[0]?.ID).toBe(5);
      } finally {
        await sync.stop();
      }

      // Verify M25 Item 5 `<firebird-repl>` search index telemetry helper
      const replIndexes = await fetchReplSearchIndexes(primaryDb as never);
      expect(replIndexes).toHaveLength(2);
      expect(replIndexes.find((i) => i.kind === 'vector')?.details).toContain('int8');
      expect(replIndexes.find((i) => i.kind === 'fts')?.details).toContain('BM25');

      vecIdx.dispose();
      ftsIdx.dispose();
    } finally {
      await replicaDb.close();
      await primaryDb.close();
    }
  });
});

describe('M25 Item 4 & 5: Declarative Schema Diff / Push, CLI schema-diff / schema-push & < 1,650-Line Budget', () => {
  it('diffs and pushes declarative SQL schemas with destructive-DDL guards via syncDatabaseSchema and <firebird-repl>', async () => {
    const db = new FirebirdBrowser('memory://m25_schema_sync', { threads: false });
    try {
      await db.execute(
        `CREATE TABLE USERS (
          ID INTEGER NOT NULL PRIMARY KEY,
          EMAIL VARCHAR(120) NOT NULL,
          LEGACY_CODE VARCHAR(32)
        )`,
      );

      const additiveDdl = `
        CREATE TABLE USERS (
          ID INTEGER NOT NULL PRIMARY KEY,
          EMAIL VARCHAR(120) NOT NULL,
          LEGACY_CODE VARCHAR(32),
          DISPLAY_NAME VARCHAR(80)
        );
        CREATE TABLE AUDIT_LOGS (
          ID INTEGER NOT NULL PRIMARY KEY,
          ACTION_NAME VARCHAR(64) NOT NULL
        );
      `;

      // Preview via `<firebird-repl>` helper (`dryRun: true`)
      const preview = await executeReplSchemaDiff(db as never, additiveDdl, { dryRun: true });
      expect(preview.applied).toBe(false);
      expect(preview.hasDestructiveChanges).toBe(false);
      expect(preview.statements.some((s) => /CREATE TABLE AUDIT_LOGS/i.test(s))).toBe(true);
      expect(preview.statements.some((s) => /ALTER TABLE USERS ADD DISPLAY_NAME/i.test(s))).toBe(true);

      // Apply additive schema push
      const pushed = await syncDatabaseSchema(additiveDdl, db);
      expect(pushed.applied).toBe(true);
      expect(pushed.statementsExecuted).toBeGreaterThanOrEqual(2);

      const afterSchema = await db.introspect();
      expect(afterSchema.tables.map((t) => t.name)).toEqual(['AUDIT_LOGS', 'USERS']);

      // Destructive change (dropping AUDIT_LOGS & dropping LEGACY_CODE) is blocked unless allowDestructive: true
      const destructiveDdl = `
        CREATE TABLE USERS (
          ID INTEGER NOT NULL PRIMARY KEY,
          EMAIL VARCHAR(120) NOT NULL,
          DISPLAY_NAME VARCHAR(80)
        );
      `;
      await expect(syncDatabaseSchema(destructiveDdl, db)).rejects.toThrow(
        DestructiveSchemaSyncError,
      );

      const allowed = await syncDatabaseSchema(destructiveDdl, db, {
        allowDestructive: true,
      });
      expect(allowed.applied).toBe(true);
      expect(allowed.hasDestructiveChanges).toBe(true);

      const finalSchema = await db.introspect();
      expect(finalSchema.tables.map((t) => t.name)).toEqual(['USERS']);
      expect(finalSchema.tables[0]?.columns.map((c) => c.name)).toEqual([
        'ID',
        'EMAIL',
        'DISPLAY_NAME',
      ]);
    } finally {
      await db.close();
    }
  });

  it('executes CLI schema-diff and schema-push against .fdb and .sql files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m25-cli-schema-'));
    const targetFdb = path.join(tmpDir, 'target.fdb');
    const desiredSql = path.join(tmpDir, 'desired.sql');
    const shrunkSql = path.join(tmpDir, 'shrunk.sql');

    try {
      // Create initial target.fdb
      await runCli(
        [
          'query',
          targetFdb,
          'CREATE TABLE PROJECTS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(80) NOT NULL)',
          '--backend',
          'wasm',
        ],
        { cwd: tmpDir },
      );

      fs.writeFileSync(
        desiredSql,
        `
        CREATE TABLE PROJECTS (
          ID INTEGER NOT NULL PRIMARY KEY,
          NAME VARCHAR(80) NOT NULL,
          OWNER VARCHAR(64)
        );
        CREATE TABLE MILESTONES (
          ID INTEGER NOT NULL PRIMARY KEY,
          TITLE VARCHAR(120) NOT NULL
        );
        `,
        'utf8',
      );

      // 1. schema-diff --json
      let diffOut = '';
      const diffCode = await runCli(
        ['schema-diff', targetFdb, desiredSql, '--json', '--backend', 'wasm'],
        { cwd: tmpDir, stdout: (s) => (diffOut += s) },
      );
      expect(diffCode).toBe(0);
      const diffJson = JSON.parse(diffOut) as {
        hasChanges: boolean;
        addedTables: string[];
        addedColumns: string[];
      };
      expect(diffJson.hasChanges).toBe(true);
      expect(diffJson.addedTables).toEqual(['MILESTONES']);
      expect(diffJson.addedColumns).toEqual(['PROJECTS.OWNER']);

      // 2. schema-push additive
      let pushOut = '';
      const pushCode = await runCli(
        ['schema-push', targetFdb, '--from', desiredSql, '--json', '--backend', 'wasm'],
        { cwd: tmpDir, stdout: (s) => (pushOut += s) },
      );
      expect(pushCode).toBe(0);
      expect((JSON.parse(pushOut) as { applied: boolean }).applied).toBe(true);

      // 3. schema-push destructive blocked without --allow-destructive, then succeeds with --allow-destructive
      fs.writeFileSync(
        shrunkSql,
        'CREATE TABLE PROJECTS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(80) NOT NULL);',
        'utf8',
      );

      let errOut = '';
      const blockedCode = await runCli(
        ['schema-push', targetFdb, '--from', shrunkSql, '--backend', 'wasm'],
        { cwd: tmpDir, stderr: (s) => (errOut += s) },
      );
      expect(blockedCode).toBe(1);
      expect(errOut).toContain('--allow-destructive');

      const forceCode = await runCli(
        [
          'schema-push',
          targetFdb,
          '--from',
          shrunkSql,
          '--allow-destructive',
          '--backend',
          'wasm',
        ],
        { cwd: tmpDir },
      );
      expect(forceCode).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps every non-test .ts source file in packages/firebird-wasm/src strictly below 1,650 lines', () => {
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
          if (lineCount >= 1650) {
            oversized.push({ file: path.relative(srcRoot, full), lines: lineCount });
          }
        }
      }
    };

    walk(srcRoot);
    expect(oversized).toEqual([]);
  });
});
