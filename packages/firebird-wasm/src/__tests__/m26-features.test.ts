/**
 * M26 Feature Suite:
 * 1. Real-Time Collaborative Presence, Ephemeral Awareness & Framework Hooks
 * 2. Tamper-Evident Cryptographic Audit Log & Merkle Hash-Chain Verification
 * 3. Semantic Query Cache, MMR Diversity Reranking & Token-Budgeted RAG Context Packer
 * 4. Deterministic PII Anonymizer & Foreign-Key-Aware Database Seeder (+ CLI)
 * 5. Sub-1,500-Line Source File Modularity Invariant across `packages/firebird-wasm/src`
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  FirebirdBrowser,
  anonymizeDatabase,
  computeAuditMerkleRoot,
  createAuditLog,
  createHttpReplicationHandler,
  createPresenceHub,
  createPresenceRoom,
  createSemanticCache,
  createTenantIsolationGuard,
  createWebSocketReplicationPeer,
  encodeVector,
  hybridSearch,
  mmrRerank,
  packRagContext,
  seedDatabase,
  vectorSearch,
  type BroadcastChannelLike,
  type WebSocketLike,
} from '../browser';
import { runCli } from '../cli';
import { usePresence as useReactPresence } from '../react';
import { usePresence as useVuePresence } from '../vue';
import { createPresence as createSveltePresence } from '../svelte';
import { createPresence as createSolidPresence } from '../solid';

function createLinkedBroadcastChannels(): [BroadcastChannelLike, BroadcastChannelLike] {
  const listenersA = new Set<(ev: { data: unknown }) => void>();
  const listenersB = new Set<(ev: { data: unknown }) => void>();

  const chA: BroadcastChannelLike = {
    postMessage(msg) {
      for (const fn of listenersB) fn({ data: structuredClone(msg) });
    },
    addEventListener(_t, fn) {
      listenersA.add(fn);
    },
    removeEventListener(_t, fn) {
      listenersA.delete(fn);
    },
    close() {
      listenersA.clear();
    },
  };
  const chB: BroadcastChannelLike = {
    postMessage(msg) {
      for (const fn of listenersA) fn({ data: structuredClone(msg) });
    },
    addEventListener(_t, fn) {
      listenersB.add(fn);
    },
    removeEventListener(_t, fn) {
      listenersB.delete(fn);
    },
    close() {
      listenersB.clear();
    },
  };
  return [chA, chB];
}

function createLinkedWebSockets(): [WebSocketLike, WebSocketLike] {
  const listenersA = new Set<(ev: { data: unknown }) => void>();
  const listenersB = new Set<(ev: { data: unknown }) => void>();
  const sockA: WebSocketLike = {
    readyState: 1,
    send(data) {
      for (const fn of listenersB) fn({ data });
    },
    addEventListener(_t, fn) {
      listenersA.add(fn);
    },
    removeEventListener(_t, fn) {
      listenersA.delete(fn);
    },
  };
  const sockB: WebSocketLike = {
    readyState: 1,
    send(data) {
      for (const fn of listenersA) fn({ data });
    },
    addEventListener(_t, fn) {
      listenersB.add(fn);
    },
    removeEventListener(_t, fn) {
      listenersB.delete(fn);
    },
  };
  return [sockA, sockB];
}

describe('M26 Item 5: Sub-1,500-Line Source File Modularity Invariant', () => {
  it('keeps every non-test .ts source file in packages/firebird-wasm/src strictly < 1,500 lines', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const walk = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          files.push(...walk(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(full);
        }
      }
      return files;
    };

    const allSourceFiles = walk(srcRoot);
    expect(allSourceFiles.length).toBeGreaterThan(50);

    const violations: Array<{ file: string; lines: number }> = [];
    for (const file of allSourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const lineCount = content.split(/\r?\n/).length;
      if (lineCount >= 1500) {
        violations.push({
          file: path.relative(srcRoot, file).replace(/\\/g, '/'),
          lines: lineCount,
        });
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('M26 Item 1: Real-Time Collaborative Presence & Framework Hooks', () => {
  it('synchronizes peer cursors, typing state, late-join discovery, leave & TTL across BroadcastChannel', async () => {
    const [chA, chB] = createLinkedBroadcastChannels();
    let clock = 10_000;

    const roomA = createPresenceRoom<{ name: string; color: string }>({
      roomId: 'sheet-1',
      peerId: 'peer-a',
      initialState: { name: 'Alice', color: '#3b82f6' },
      broadcastChannel: chA,
      ttlMs: 5_000,
      heartbeatIntervalMs: 0,
      now: () => clock,
    });
    roomA.setCursor({ table: 'TASKS', rowKey: 1, column: 'TITLE' });

    // peer-b joins later and immediately discovers peer-a via requestReply
    const roomB = createPresenceRoom<{ name: string; color: string }>({
      roomId: 'sheet-1',
      peerId: 'peer-b',
      initialState: { name: 'Bob', color: '#10b981' },
      broadcastChannel: chB,
      ttlMs: 5_000,
      heartbeatIntervalMs: 0,
      now: () => clock,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(roomA.getSnapshot().onlineCount).toBe(2);
    expect(roomB.getSnapshot().onlineCount).toBe(2);
    expect(roomB.getPeers()[0]?.cursor).toEqual({
      table: 'TASKS',
      rowKey: 1,
      column: 'TITLE',
    });

    roomB.setTyping(true);
    expect(roomA.getPeers()[0]?.typing).toBe(true);

    // Advance clock past TTL without heartbeat
    clock += 6_000;
    expect(roomA.pruneExpired(clock)).toBe(1);
    expect(roomA.getSnapshot().onlineCount).toBe(1);

    await roomB.leave();
    await roomA.close();
    await roomB.close();
  });

  it('isolates HTTP /presence & SSE event: presence frames strictly per tenant and supports WebSocket presence', async () => {
    const guard = createTenantIsolationGuard({ tenantColumn: 'TENANT_ID' });
    const handler = createHttpReplicationHandler({
      tenantGuard: guard,
      resolveTenantId: (req) => req.headers.get('x-tenant-id') ?? undefined,
      sseHeartbeatIntervalMs: 0,
    });

    // Open live SSE stream for tenant 'acme'
    const sseAbort = new AbortController();
    const sseRes = await handler(
      new Request('http://localhost/events', {
        headers: { 'x-tenant-id': 'acme' },
        signal: sseAbort.signal,
      }),
    );
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    // Read initial replication frame
    await reader.read();

    // Post presence for 'acme'
    const postAcme = await handler(
      new Request('http://localhost/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'acme' },
        body: JSON.stringify({
          roomId: 'board',
          peerId: 'acme-user-1',
          state: { name: 'Acme Alice' },
          cursor: { table: 'TASKS', rowKey: 10 },
        }),
      }),
    );
    expect(postAcme.status).toBe(200);

    // Post presence for 'globex' (must NOT leak to 'acme' GET /presence or SSE stream!)
    await handler(
      new Request('http://localhost/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'globex' },
        body: JSON.stringify({
          roomId: 'board',
          peerId: 'globex-user-9',
          state: { name: 'Globex Eve' },
        }),
      }),
    );

    const sseChunk = decoder.decode((await reader.read()).value);
    expect(sseChunk).toContain('event: presence');
    expect(sseChunk).toContain('acme-user-1');
    expect(sseChunk).not.toContain('globex-user-9');

    const getAcme = await (
      await handler(
        new Request('http://localhost/presence?roomId=board', {
          headers: { 'x-tenant-id': 'acme' },
        }),
      )
    ).json();
    expect(getAcme.peers.map((p: { peerId: string }) => p.peerId)).toEqual(['acme-user-1']);

    sseAbort.abort();

    // WebSocket presenceHub integration
    const [clientSock, serverSock] = createLinkedWebSockets();
    const wsHub = createPresenceHub();
    const wsPeer = createWebSocketReplicationPeer({
      socket: serverSock,
      presenceHub: wsHub,
    });
    const wsRoom = createPresenceRoom({
      roomId: 'ws-room',
      peerId: 'ws-client-1',
      websocket: clientSock,
      heartbeatIntervalMs: 0,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(wsHub.listPeers({ roomId: 'ws-room' }).map((p) => p.peerId)).toEqual([
      'ws-client-1',
    ]);
    await wsRoom.leave();
    expect(wsHub.listPeers({ roomId: 'ws-room' })).toEqual([]);
    await wsRoom.close();
    wsPeer.close();
  });

  it('exposes reactive createPresence / usePresence bindings across Svelte, Solid, React & Vue', async () => {
    expect(typeof useReactPresence).toBe('function');
    expect(typeof useVuePresence).toBe('function');

    const svelteStore = createSveltePresence<{ role: string }>({
      roomId: 'fw-room',
      peerId: 'sv-1',
      initialState: { role: 'owner' },
      heartbeatIntervalMs: 0,
    });
    const observedCounts: number[] = [];
    const unsub = svelteStore.subscribe((snap) => observedCounts.push(snap.onlineCount));
    svelteStore.room.applyRemoteUpdate({
      peerId: 'sv-2',
      roomId: 'fw-room',
      version: 1,
      updatedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      cursor: null,
      typing: false,
      state: { role: 'viewer' },
    });
    expect(svelteStore.onlineCount).toBe(2);
    expect(observedCounts).toEqual([1, 2]);
    unsub();
    svelteStore.destroy();

    const solidStore = createSolidPresence({
      roomId: 'fw-room-solid',
      peerId: 'so-1',
      heartbeatIntervalMs: 0,
    });
    solidStore.setCursor({ table: 'DOCS', rowKey: 5 });
    expect(solidStore.self().cursor?.rowKey).toBe(5);
    solidStore.dispose();
  });
});

describe('M26 Item 2: Tamper-Evident Cryptographic Audit Log & Merkle Chains', () => {
  it('records signed mutations in FB_AUDIT_LOG$, computes Merkle roots, and detects tampering', async () => {
    const db = new FirebirdBrowser('memory://m26-audit');
    try {
      await db.execute(
        'CREATE TABLE ACCOUNTS (ID INTEGER NOT NULL PRIMARY KEY, OWNER VARCHAR(64), BALANCE INTEGER)',
      );

      // Generate an ECDSA P-256 (ES256) keypair for asymmetric detached signatures
      const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );

      const audit = createAuditLog(db, {
        actorResolver: () => 'auditor@acme.io',
        signKey: keyPair.privateKey,
        verifyKey: keyPair.publicKey,
        signAlgorithm: 'ES256',
      });

      const accounts = audit.wrapTable(db.table('ACCOUNTS'));
      await accounts.insert({ ID: 1, OWNER: 'Alice', BALANCE: 500 });
      await accounts.update(1, { BALANCE: 750 });
      await accounts.insert({ ID: 2, OWNER: 'Bob', BALANCE: 200 });
      await accounts.delete(2);

      // Internal FB_AUDIT_LOG$ must be hidden from user schema introspection
      const schema = await db.introspect();
      expect(schema.tables.map((t) => t.name)).toEqual(['ACCOUNTS']);

      const entries = await audit.listEntries();
      expect(entries).toHaveLength(4);
      expect(entries.map((e) => e.op)).toEqual(['INSERT', 'UPDATE', 'INSERT', 'DELETE']);
      expect(entries[1]!.diff.changedColumns).toEqual(['BALANCE']);

      const validCheck = await audit.verifyChain();
      expect(validCheck.valid).toBe(true);
      expect(validCheck.checkedCount).toBe(4);
      expect(validCheck.merkleRoot).toBe(
        await computeAuditMerkleRoot(entries.map((e) => e.entryHash)),
      );

      // Tamper with a historical row's DIFF_JSON
      await db.execute(
        `UPDATE "FB_AUDIT_LOG$" SET DIFF_JSON = '{"tampered":true}' WHERE SEQ = 2`,
      );
      const tamperedCheck = await audit.verifyChain();
      expect(tamperedCheck.valid).toBe(false);
      expect(tamperedCheck.tamperedAtSeq).toBe(2);
      expect(tamperedCheck.reason).toContain('ENTRY_HASH tampering');
    } finally {
      await db.close();
    }
  });
});

describe('M26 Item 3: Semantic Query Cache, MMR Reranking & RAG Context Packer', () => {
  it('persists semantic cache entries in FB_SEMANTIC_CACHE$, serves cosine hits, and enforces TTL & maxEntries', async () => {
    const db = new FirebirdBrowser('memory://m26-semcache', { types: { binary: true } });
    try {
      let now = 1_000_000;
      const cache = createSemanticCache(db, {
        similarityThreshold: 0.9,
        maxEntries: 2,
        quantization: 'int8',
        now: () => now,
      });

      const miss = await cache.get([1, 0, 0, 0]);
      expect(miss).toBeNull();

      await cache.set({
        key: 'q1',
        prompt: 'How does Firebird WASM persist pages in the browser?',
        embedding: [1, 0, 0, 0],
        response: { answer: 'Via OPFS SyncAccessHandle or IndexedDB VFS.' },
        ttlMs: 5_000,
      });

      // Near-identical query vector -> cache HIT!
      const hit = await cache.get<{ answer: string }>([0.99, 0.05, 0, 0]);
      expect(hit).not.toBeNull();
      expect(hit?.response.answer).toContain('OPFS');
      expect(hit?.similarity).toBeGreaterThan(0.95);

      const st1 = await cache.stats();
      expect(st1.hits).toBe(1);
      expect(st1.misses).toBe(1);
      expect(st1.hitRate).toBeCloseTo(0.5, 5);

      // Expire q1 via TTL
      now += 6_000;
      const expiredMiss = await cache.get([1, 0, 0, 0]);
      expect(expiredMiss).toBeNull();

      // Test maxEntries=2 eviction
      await cache.set({ key: 'a', prompt: 'A', embedding: [1, 0, 0, 0], response: 'A', now: 10 });
      await cache.set({ key: 'b', prompt: 'B', embedding: [0, 1, 0, 0], response: 'B', now: 20 });
      await cache.set({ key: 'c', prompt: 'C', embedding: [0, 0, 1, 0], response: 'C', now: 30 });
      expect((await cache.stats()).entryCount).toBe(2);
      expect(await cache.get([1, 0, 0, 0])).toBeNull(); // 'a' evicted

      await cache.close();
    } finally {
      await db.close();
    }
  });

  it('applies diversityLambda MMR reranking in vectorSearch/hybridSearch and packs token-budgeted RAG context', async () => {
    const db = new FirebirdBrowser('memory://m26-rag', { types: { binary: true } });
    try {
      await db.execute(
        'CREATE TABLE KB (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(80), CONTENT VARCHAR(500), EMB VARBINARY(16))',
      );
      await db.execute('INSERT INTO KB VALUES (?, ?, ?, ?)', [
        1,
        'OPFS 1',
        'Firebird WASM persists database pages directly in browser OPFS storage.',
        encodeVector([1, 0, 0, 0]),
      ]);
      await db.execute('INSERT INTO KB VALUES (?, ?, ?, ?)', [
        2,
        'OPFS 2 (Near Dup)',
        'Firebird WASM persists database pages directly in browser OPFS storage fast.',
        encodeVector([0.99, 0.02, 0, 0]),
      ]);
      await db.execute('INSERT INTO KB VALUES (?, ?, ?, ?)', [
        3,
        'Replication',
        'Logical HLC and CRDT replication synchronizes Firebird WASM peers over SSE.',
        encodeVector([0.75, 0.66, 0, 0]),
      ]);

      // Pure similarity picks [1, 2], whereas MMR diversityLambda=0.25 picks [1, 3]!
      const pureHits = await vectorSearch(db, {
        table: 'KB',
        column: 'EMB',
        query: [1, 0, 0, 0],
        limit: 2,
      });
      expect(pureHits.map((r) => r.ID)).toEqual([1, 2]);

      const diverseVecHits = await vectorSearch(db, {
        table: 'KB',
        column: 'EMB',
        query: [1, 0, 0, 0],
        limit: 2,
        diversityLambda: 0.25,
      });
      expect(diverseVecHits.map((r) => r.ID)).toEqual([1, 3]);

      const diverseHybridHits = await hybridSearch(db, {
        table: 'KB',
        ftsColumns: ['TITLE', 'CONTENT'],
        vectorColumn: 'EMB',
        textQuery: 'Firebird WASM',
        vectorQuery: [1, 0, 0, 0],
        limit: 2,
        diversityLambda: 0.25,
      });
      expect(diverseHybridHits.map((r) => r.ID)).toEqual([1, 3]);

      // RAG Context Packer deduplicates near-duplicate OPFS 2 and respects tokenBudget
      const allThree = await vectorSearch(db, {
        table: 'KB',
        column: 'EMB',
        query: [1, 0, 0, 0],
        limit: 3,
      });
      const packed = packRagContext(allThree, {
        tokenBudget: 55,
        dedupeOverlap: 0.75,
      });
      expect(packed.duplicateCount).toBe(1);
      expect(packed.includedChunks.map((c) => c.id)).toEqual(['1', '3']);
      expect(packed.estimatedTokens).toBeLessThanOrEqual(55);
      expect(packed.promptContext).toContain('[1] (id=1)');
      expect(packed.promptContext).toContain('[2] (id=3)');

      const directMmr = mmrRerank(allThree, { diversityLambda: 0.25, limit: 2 });
      expect(directMmr.map((r) => r.ID)).toEqual([1, 3]);
    } finally {
      await db.close();
    }
  });
});

describe('M26 Item 4: Deterministic PII Anonymizer, FK-Aware Seeder & CLI Subcommands', () => {
  it('seeds multi-table foreign-key hierarchies in parent-first order and scrubs PII deterministically', async () => {
    const db1 = new FirebirdBrowser('memory://m26-seed-1');
    const db2 = new FirebirdBrowser('memory://m26-seed-2');
    const stageDb = new FirebirdBrowser('memory://m26-stage');

    const ddl = `
      CREATE TABLE ORGS (
        ID INTEGER NOT NULL PRIMARY KEY,
        NAME VARCHAR(80) NOT NULL
      );
      CREATE TABLE MEMBERS (
        ID INTEGER NOT NULL PRIMARY KEY,
        ORG_ID INTEGER NOT NULL REFERENCES ORGS(ID),
        EMAIL VARCHAR(120) NOT NULL UNIQUE,
        FULL_NAME VARCHAR(100) NOT NULL,
        PHONE VARCHAR(32) NOT NULL,
        SALARY INTEGER NOT NULL
      );
      CREATE TABLE API_KEYS (
        ID INTEGER NOT NULL PRIMARY KEY,
        MEMBER_ID INTEGER NOT NULL REFERENCES MEMBERS(ID),
        SECRET_TOKEN VARCHAR(64) NOT NULL
      );
    `;

    try {
      await db1.exec(ddl);
      await db2.exec(ddl);

      const s1 = await seedDatabase(db1, { rowsPerTable: 5, seed: 777 });
      const s2 = await seedDatabase(db2, { rowsPerTable: 5, seed: 777 });

      // Parent-first topological order: ORGS -> MEMBERS -> API_KEYS
      expect(s1.insertionOrder.indexOf('ORGS')).toBeLessThan(
        s1.insertionOrder.indexOf('MEMBERS'),
      );
      expect(s1.insertionOrder.indexOf('MEMBERS')).toBeLessThan(
        s1.insertionOrder.indexOf('API_KEYS'),
      );
      expect(s1.totalRowsInserted).toBe(15);
      expect(s2.totalRowsInserted).toBe(15);

      // Identical seed produces byte-for-byte identical rows
      const m1 = (await db1.query('SELECT * FROM MEMBERS ORDER BY ID')).rows;
      const m2 = (await db2.query('SELECT * FROM MEMBERS ORDER BY ID')).rows;
      expect(m1).toEqual(m2);

      // Cross-database deterministic PII anonymization into empty stageDb
      const anonRes = await anonymizeDatabase(db1, stageDb, {
        seed: 99,
        rules: {
          'MEMBERS.EMAIL': 'email',
          'MEMBERS.FULL_NAME': 'full-name',
          'MEMBERS.PHONE': 'phone',
          'MEMBERS.SALARY': 'number-jitter',
          'API_KEYS.SECRET_TOKEN': 'redact',
        },
      });
      expect(anonRes.inPlace).toBe(false);
      expect(anonRes.rowsProcessed).toBe(15);

      const scrubbedMembers = (
        await stageDb.query<{ EMAIL: string; FULL_NAME: string; PHONE: string }>(
          'SELECT EMAIL, FULL_NAME, PHONE FROM MEMBERS ORDER BY ID',
        )
      ).rows;
      expect(scrubbedMembers).toHaveLength(5);
      expect(scrubbedMembers[0]!.EMAIL).toMatch(/^user_[0-9a-f]{8}@example\.invalid$/);
      expect(scrubbedMembers[0]!.EMAIL).not.toBe((m1[0] as { EMAIL: string }).EMAIL);

      const scrubbedKeys = (
        await stageDb.query<{ SECRET_TOKEN: string }>('SELECT SECRET_TOKEN FROM API_KEYS')
      ).rows;
      expect(scrubbedKeys.every((r) => r.SECRET_TOKEN === '[REDACTED]')).toBe(true);
    } finally {
      await db1.close();
      await db2.close();
      await stageDb.close();
    }
  });

  it('executes CLI seed, anonymize, and verify-audit subcommands end-to-end', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-m26-cli-'));
    const dbPath = path.join(tmpDir, 'app.fdb');

    try {
      // 1. Create schema + audit record in dbPath via WASM backend
      let outBuf = '';
      let errBuf = '';
      const codeCreate = await runCli(
        [
          'query',
          dbPath,
          'CREATE TABLE CUSTOMERS (ID INTEGER NOT NULL PRIMARY KEY, EMAIL VARCHAR(100) NOT NULL, FULL_NAME VARCHAR(80) NOT NULL)',
          '--backend',
          'wasm',
        ],
        { stdout: (s) => (outBuf += s), stderr: (s) => (errBuf += s) },
      );
      expect(codeCreate).toBe(0);

      // 2. Seed 4 synthetic rows via `firebird-wasm seed`
      outBuf = '';
      const codeSeed = await runCli(
        ['seed', dbPath, '--rows', '4', '--seed', '123', '--backend', 'wasm', '--json'],
        { stdout: (s) => (outBuf += s), stderr: (s) => (errBuf += s) },
      );
      expect(codeSeed).toBe(0);
      expect(JSON.parse(outBuf).totalRowsInserted).toBe(4);

      // 3. Scrub PII in-place via `firebird-wasm anonymize`
      outBuf = '';
      const codeAnon = await runCli(
        [
          'anonymize',
          dbPath,
          '--rules',
          '{"CUSTOMERS.EMAIL":"email","CUSTOMERS.FULL_NAME":"name"}',
          '--seed',
          '55',
          '--backend',
          'wasm',
          '--json',
        ],
        { stdout: (s) => (outBuf += s), stderr: (s) => (errBuf += s) },
      );
      expect(codeAnon).toBe(0);
      expect(JSON.parse(outBuf).columnsScrubbed).toBe(8);

      // 4. Append signed audit records & run `firebird-wasm verify-audit`
      const rawBytes = new Uint8Array(fs.readFileSync(dbPath));
      const wasmDb = new FirebirdBrowser('memory://m26-cli-audit', {
        initialData: rawBytes,
      });
      const audit = createAuditLog(wasmDb, { signKey: 'cli-hmac-secret' });
      await audit.record({
        table: 'CUSTOMERS',
        op: 'UPDATE',
        key: { ID: 1 },
        after: { EMAIL: 'scrubbed@example.invalid' },
      });
      fs.writeFileSync(dbPath, await wasmDb.dumpDataDir());
      await wasmDb.close();

      outBuf = '';
      const codeVerifyOk = await runCli(
        ['verify-audit', dbPath, '--sign-key', 'cli-hmac-secret', '--backend', 'wasm', '--json'],
        { stdout: (s) => (outBuf += s), stderr: (s) => (errBuf += s) },
      );
      expect(codeVerifyOk).toBe(0);
      const parsedVerify = JSON.parse(outBuf);
      expect(parsedVerify.valid).toBe(true);
      expect(parsedVerify.checkedCount).toBe(1);

      // Wrong HMAC key must exit with code 2
      outBuf = '';
      const codeVerifyBad = await runCli(
        ['verify-audit', dbPath, '--sign-key', 'wrong-secret', '--backend', 'wasm', '--json'],
        { stdout: (s) => (outBuf += s), stderr: (s) => (errBuf += s) },
      );
      expect(codeVerifyBad).toBe(2);
      expect(JSON.parse(outBuf).valid).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
