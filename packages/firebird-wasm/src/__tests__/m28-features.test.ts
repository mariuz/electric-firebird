/**
 * M28 Feature Suite:
 * 1. Durable Transactional Job Queue, Cron Scheduler & Crash-Safe Agent Workflows (`createJobQueue`, CLI `worker`)
 * 2. Property Graph & Knowledge-GraphRAG Engine over `WITH RECURSIVE` + HNSW (`createKnowledgeGraph`, `graphRagSearch`, MCP `graph_search`)
 * 3. Zero-Downtime Online Schema Migrations (Expand / Backfill / Contract) (`createOnlineMigrator`, CLI `migrate-online`)
 * 4. Adaptive Index Advisor, Workload Analyzer & Slow-Query Diagnostics (`createWorkloadAdvisor`, MCP `advise_workload`, CLI `advise`)
 * 5. Sub-1,200-Line Source File Modularity Invariant across `packages/firebird-wasm/src`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_EDGES_TABLE,
  DEFAULT_GRAPH_NODES_TABLE,
  DEFAULT_JOB_DLQ_TABLE,
  DEFAULT_JOB_QUEUE_TABLE,
  DEFAULT_JOB_SCHEDULES_TABLE,
  DEFAULT_ONLINE_MIGRATIONS_TABLE,
  DEFAULT_WORKFLOW_STEPS_TABLE,
  FirebirdBrowser,
  compileGraphPatternSql,
  createFirebirdMcpServer,
  createJobQueue,
  createKnowledgeGraph,
  createOnlineMigrator,
  createWorkloadAdvisor,
  graphRagSearch,
  nextCronRunAfter,
  parseCronExpression,
} from '../browser';
import { runCli } from '../cli';

function graphVec(text: string): number[] {
  const lower = text.toLowerCase();
  const sAuth = (lower.match(/jwt|jwks|auth|token|rls/g) ?? []).length;
  const sSync = (lower.match(/sync|replication|sse|crdt/g) ?? []).length;
  const sStorage = (lower.match(/opfs|indexeddb|vfs|page/g) ?? []).length;
  const sAi = (lower.match(/rag|hnsw|vector|graph/g) ?? []).length;
  return [1 + sAuth * 3, 1 + sSync * 3, 1 + sStorage * 3, 1 + sAi * 3];
}

describe('M28: Job Queue & Workflows, Knowledge-GraphRAG, Online Migrator, Workload Advisor & Sub-1,200-Line Modularity', () => {
  it('enforces strict < 1,200-line source modularity across every non-test .ts file in src/', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const oversized: Array<{ file: string; lines: number }> = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(abs);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const lineCount = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
          if (lineCount >= 1200) {
            oversized.push({ file: path.relative(srcRoot, abs), lines: lineCount });
          }
        }
      }
    };

    walk(srcRoot);
    expect(oversized).toEqual([]);
  });

  it('Item 1: parses 5-field cron & @every schedules, deduplicates jobs, handles lease expiry + DLQ, runs background worker & replays crash-safe workflows', async () => {
    const cron = parseCronExpression('*/15 9-17 * * 1-5');
    expect(cron.kind).toBe('cron');
    expect(cron.minutes?.has(0)).toBe(true);
    expect(cron.minutes?.has(30)).toBe(true);
    const nextMs = nextCronRunAfter('*/15 9-17 * * 1-5', new Date('2026-06-01T09:04:00.000Z'));
    expect(new Date(nextMs).toISOString()).toBe('2026-06-01T09:15:00.000Z');

    const every5s = parseCronExpression('@every 5s');
    expect(every5s).toEqual({ kind: 'interval', intervalMs: 5000 });
    expect(nextCronRunAfter('@every 5s', 1_000)).toBe(6_000);

    const db = new FirebirdBrowser('memory://m28-job-queue', { threads: false });
    try {
      let fakeNow = 1_700_000_000_000;
      const queue = createJobQueue(db, {
        defaultLeaseMs: 1_000,
        defaultMaxAttempts: 2,
        backoffBaseMs: 500,
        now: () => fakeNow,
      });
      expect(queue.queueTable).toBe(DEFAULT_JOB_QUEUE_TABLE);

      // Deduplication + priority ordering
      const low = await queue.enqueue('emails', { to: 'low@acme.io' }, { priority: 1, dedupeKey: 'mail-1' });
      const dup = await queue.enqueue('emails', { to: 'low@acme.io' }, { priority: 1, dedupeKey: 'mail-1' });
      expect(low.deduplicated).toBe(false);
      expect(dup.deduplicated).toBe(true);
      expect(dup.job.id).toBe(low.job.id);

      const high = await queue.enqueue('emails', { to: 'vip@acme.io' }, { priority: 10 });

      // Highest priority claimed first
      const claimedHigh = await queue.claimNext('emails', { workerId: 'w1' });
      expect(claimedHigh?.id).toBe(high.job.id);
      await queue.extendLease(claimedHigh!.id, 2_000);
      expect(await queue.complete(claimedHigh!.id)).toBe(true);

      // Lease timeout recovery + exponential retry + DLQ dead-lettering
      const claimed1 = await queue.claimNext('emails', { workerId: 'w1', leaseMs: 1_000 });
      expect(claimed1?.id).toBe(low.job.id);
      expect(claimed1?.attempts).toBe(1);

      // Before lease expires, another worker sees nothing
      expect(await queue.claimNext('emails', { workerId: 'w2' })).toBeNull();

      // Advance clock past lease expiry -> reclaimed on attempt #2
      fakeNow += 1_500;
      const reclaimed = await queue.claimNext('emails', { workerId: 'w2' });
      expect(reclaimed?.id).toBe(low.job.id);
      expect(reclaimed?.attempts).toBe(2);

      // Failing on maxAttempts (2) quarantines into FB_JOB_DLQ$
      const failOutcome = await queue.fail(reclaimed!.id, new Error('SMTP 550 bounce'));
      expect(failOutcome.status).toBe('dead');
      const dlq = await queue.listDlq<{ to: string }>();
      expect(dlq).toHaveLength(1);
      expect(dlq[0]?.payload.to).toBe('low@acme.io');
      expect(dlq[0]?.error).toContain('SMTP 550 bounce');

      // Cron schedule + tickSchedules + processBatch
      await queue.schedule('cleanup-hourly', {
        queueName: 'maintenance',
        cron: '@every 10s',
        payload: { task: 'vacuum' },
      });
      fakeNow += 12_000;
      const enqueuedCron = await queue.tickSchedules(fakeNow);
      expect(enqueuedCron).toBe(1);

      const handledTasks: string[] = [];
      const batchRes = await queue.processBatch({
        maintenance: (job) => {
          handledTasks.push((job.payload as { task: string }).task);
        },
      });
      expect(batchRes).toEqual({ processed: 1, succeeded: 1, failed: 0 });
      expect(handledTasks).toEqual(['vacuum']);

      // Live background startWorker
      const liveProcessed: number[] = [];
      const worker = await queue.startWorker(
        {
          fast: (job) => {
            liveProcessed.push((job.payload as { n: number }).n);
          },
        },
        { pollIntervalMs: 25, workerId: 'live-w' },
      );
      await queue.enqueue('fast', { n: 77 });
      for (let i = 0; i < 40 && liveProcessed.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await worker.stop();
      expect(liveProcessed).toEqual([77]);

      // Crash-safe checkpointed workflow (`FB_WORKFLOW_STEPS$`)
      const sideEffects: string[] = [];
      await expect(
        queue.runWorkflow('order-wf-1', async (step) => {
          const chargeId = await step.run('charge-card', () => {
            sideEffects.push('charged');
            return 'ch_999';
          });
          await step.run('send-receipt', () => {
            throw new Error('transient network timeout');
          });
          return chargeId;
        }),
      ).rejects.toThrow('transient network timeout');
      expect(sideEffects).toEqual(['charged']);

      // Resume workflow: step 1 ('charge-card') is replayed from FB_WORKFLOW_STEPS$ WITHOUT re-running!
      const resumed = await queue.runWorkflow('order-wf-1', async (step) => {
        const chargeId = await step.run('charge-card', () => {
          sideEffects.push('charged-twice-bug');
          return 'wrong';
        });
        const receipt = await step.run('send-receipt', () => {
          sideEffects.push('emailed');
          return `rcpt_for_${chargeId}`;
        });
        return { chargeId, receipt };
      });
      expect(resumed).toEqual({
        result: { chargeId: 'ch_999', receipt: 'rcpt_for_ch_999' },
        executedSteps: 1,
        replayedSteps: 1,
      });
      expect(sideEffects).toEqual(['charged', 'emailed']);

      const st = await queue.stats();
      expect(st.dlqCount).toBe(1);
      expect(st.schedulesCount).toBe(1);
      expect(DEFAULT_JOB_DLQ_TABLE).toBe('FB_JOB_DLQ$');
      expect(DEFAULT_JOB_SCHEDULES_TABLE).toBe('FB_JOB_SCHEDULES$');
      expect(DEFAULT_WORKFLOW_STEPS_TABLE).toBe('FB_WORKFLOW_STEPS$');
    } finally {
      await db.close();
    }
  });

  it('Item 2: traverses cyclic property graphs via Firebird WITH RECURSIVE SQL, computes shortestPath & PageRank, compiles Cypher-lite & serves GraphRAG + MCP graph_search', async () => {
    const db = new FirebirdBrowser('memory://m28-graph', {
      threads: false,
      types: { binary: true },
    });
    try {
      const graph = createKnowledgeGraph(db);
      expect(graph.nodesTable).toBe(DEFAULT_GRAPH_NODES_TABLE);
      expect(graph.edgesTable).toBe(DEFAULT_GRAPH_EDGES_TABLE);

      const up = await graph.upsertSubgraph({
        nodes: [
          {
            id: 'auth_svc',
            label: 'Service',
            name: 'Auth Gateway',
            summary: 'Validates JWT and JWKS key rotation tokens for multi-tenant RLS.',
            properties: { tier: 'edge' },
            embedding: graphVec('jwt jwks auth token rls'),
          },
          {
            id: 'sync_hub',
            label: 'Service',
            name: 'SSE Sync Hub',
            summary: 'Streams incremental replication deltas over SSE with CRDT HLC merge.',
            properties: { tier: 'core' },
            embedding: graphVec('sync replication sse crdt'),
          },
          {
            id: 'opfs_vfs',
            label: 'Component',
            name: 'OPFS Page Store',
            summary: 'Persists 8 KB Firebird pages in browser OPFS and IndexedDB VFS.',
            properties: { tier: 'storage' },
            embedding: graphVec('opfs indexeddb vfs page'),
          },
          {
            id: 'audit_chain',
            label: 'Component',
            name: 'Merkle Audit Log',
            summary: 'Seals row mutations with SHA-256 hash chains and Ed25519 signatures.',
            properties: { tier: 'security' },
            embedding: graphVec('auth token'),
          },
        ],
        edges: [
          // Intentional cycle (`auth_svc -> sync_hub -> opfs_vfs -> auth_svc`) to prove cycle-safe WITH RECURSIVE!
          { srcId: 'auth_svc', relType: 'DEPENDS_ON', dstId: 'sync_hub', weight: 1 },
          { srcId: 'sync_hub', relType: 'DEPENDS_ON', dstId: 'opfs_vfs', weight: 2 },
          { srcId: 'opfs_vfs', relType: 'DEPENDS_ON', dstId: 'auth_svc', weight: 5 },
          { srcId: 'auth_svc', relType: 'AUDITED_BY', dstId: 'audit_chain', weight: 1 },
        ],
      });
      expect(up).toEqual({ nodesUpserted: 4, edgesUpserted: 4 });

      // Cycle-safe multi-hop `WITH RECURSIVE` traversal
      const neigh = await graph.neighbors('auth_svc', { maxHops: 4, direction: 'out' });
      const reachedIds = neigh.map((n) => n.node.id).sort();
      expect(reachedIds).toEqual(['audit_chain', 'opfs_vfs', 'sync_hub']);

      // Weighted Dijkstra shortest path
      const pathRes = await graph.shortestPath('auth_svc', 'opfs_vfs');
      expect(pathRes).toEqual({
        nodeIds: ['auth_svc', 'sync_hub', 'opfs_vfs'],
        relations: ['DEPENDS_ON', 'DEPENDS_ON'],
        hops: 2,
        totalWeight: 3,
      });

      // Personalized PageRank
      const ranks = await graph.pageRank({
        iterations: 20,
        personalizedSeeds: { auth_svc: 1 },
      });
      expect(ranks).toHaveLength(4);
      expect(ranks[0]?.score).toBeGreaterThan(0);

      // Cypher-lite pattern compiler & execution
      const compiled = compileGraphPatternSql(
        '(s:Service)-[:DEPENDS_ON*1..2]->(c:Component)',
      );
      expect(compiled.sql).toContain('WITH RECURSIVE');
      const matched = await graph.matchPattern(
        '(s:Service)-[:DEPENDS_ON*1..2]->(c:Component)',
      );
      expect(matched.length).toBeGreaterThanOrEqual(2);
      expect(matched.some((m) => m.srcId === 'auth_svc' && m.dstId === 'opfs_vfs' && m.hops === 2)).toBe(true);

      // Multi-hop GraphRAG context retrieval (seed = auth_svc, expands 1-2 hops to sync_hub & opfs_vfs!)
      const rag = await graphRagSearch(graph, db, {
        query: 'JWT JWKS key rotation authentication',
        embed: graphVec,
        seedLimit: 1,
        maxHops: 2,
        tokenBudget: 400,
      });
      expect(rag.seedNodeIds).toEqual(['auth_svc']);
      expect(rag.expandedNodeIds).toContain('sync_hub');
      expect(rag.expandedNodeIds).toContain('opfs_vfs');
      expect(rag.promptContext).toContain('Auth Gateway');
      expect(rag.promptContext).toContain('SSE Sync Hub');
      expect(rag.citations.length).toBeGreaterThanOrEqual(2);

      // MCP `graph_search` tool
      const mcp = createFirebirdMcpServer(db, { enableGraphRag: true });
      expect(mcp.listTools().map((t) => t.name)).toContain('graph_search');
      const mcpRes = await mcp.callTool('graph_search', {
        query: 'JWT JWKS authentication',
        maxHops: 2,
      });
      expect(mcpRes.isError).toBeUndefined();
      const parsedMcp = JSON.parse(mcpRes.content[0]!.text);
      expect(parsedMcp.seedNodeIds).toContain('auth_svc');
    } finally {
      await db.close();
    }
  });

  it('Item 3: executes zero-downtime Expand / Backfill / Contract online migrations with bidirectional PSQL dual-write triggers & rollback', async () => {
    const db = new FirebirdBrowser('memory://m28-online-mig', { threads: false });
    try {
      await db.exec(`
        CREATE TABLE CUSTOMERS (
          ID INTEGER NOT NULL PRIMARY KEY,
          FULL_NAME VARCHAR(80),
          PRICE_CENTS INTEGER,
          QTY INTEGER
        )
      `);
      for (let i = 1; i <= 7; i++) {
        await db.execute('INSERT INTO CUSTOMERS VALUES (?, ?, ?, ?)', [
          i,
          `Customer ${i}`,
          i * 100,
          2,
        ]);
      }

      const migrator = createOnlineMigrator(db, {
        id: 'mig_customers_v2',
        table: 'CUSTOMERS',
        primaryKey: 'ID',
        rules: [
          {
            kind: 'renameColumn',
            from: 'FULL_NAME',
            to: 'DISPLAY_NAME',
            type: 'VARCHAR(80)',
          },
          {
            kind: 'transformColumn',
            from: 'PRICE_CENTS',
            to: 'UNIT_DOLLARS',
            type: 'NUMERIC(12, 2)',
            forwardSql: 'CAST(NEW."PRICE_CENTS" AS NUMERIC(12, 2)) / 100',
            reverseSql: 'CAST(NEW."UNIT_DOLLARS" * 100 AS INTEGER)',
          },
          {
            kind: 'computeColumn',
            to: 'LINE_TOTAL_CENTS',
            type: 'INTEGER',
            expressionSql: 'COALESCE(NEW."PRICE_CENTS", 0) * COALESCE(NEW."QTY", 0)',
          },
        ],
      });

      expect(DEFAULT_ONLINE_MIGRATIONS_TABLE).toBe('FB_ONLINE_MIGRATIONS$');
      expect(await migrator.getPhase()).toBe('planned');

      // Phase 1: Expand (adds nullable shadow columns + installs bidirectional PSQL trigger)
      const expanded = await migrator.expand();
      expect(expanded.addedColumns).toEqual(['DISPLAY_NAME', 'UNIT_DOLLARS', 'LINE_TOTAL_CENTS']);
      expect(await migrator.getPhase()).toBe('expanded');

      // Live dual-write while migration is mid-flight!
      // Writer A (legacy app code) writes ONLY old columns:
      await db.execute(
        'INSERT INTO CUSTOMERS (ID, FULL_NAME, PRICE_CENTS, QTY) VALUES (?, ?, ?, ?)',
        [100, 'Legacy Writer', 2500, 3],
      );
      // Writer B (canary v2 app code) writes ONLY new columns:
      await db.execute(
        'INSERT INTO CUSTOMERS (ID, DISPLAY_NAME, UNIT_DOLLARS, QTY) VALUES (?, ?, ?, ?)',
        [101, 'Canary Writer', 19.5, 4],
      );

      const liveCheck = await db.query<Record<string, unknown>>(
        'SELECT ID, FULL_NAME, DISPLAY_NAME, PRICE_CENTS, UNIT_DOLLARS, LINE_TOTAL_CENTS FROM CUSTOMERS WHERE ID IN (100, 101) ORDER BY ID',
      );
      expect(liveCheck.rows[0]?.DISPLAY_NAME).toBe('Legacy Writer');
      expect(Number(liveCheck.rows[0]?.UNIT_DOLLARS)).toBeCloseTo(25.0, 2);
      expect(Number(liveCheck.rows[0]?.LINE_TOTAL_CENTS)).toBe(7500);

      expect(liveCheck.rows[1]?.FULL_NAME).toBe('Canary Writer');
      expect(Number(liveCheck.rows[1]?.PRICE_CENTS)).toBe(1950);
      expect(Number(liveCheck.rows[1]?.LINE_TOTAL_CENTS)).toBe(7800);

      // Phase 2: Throttled keyset backfill of pre-existing rows (batchSize = 3)
      const progressEvents: number[] = [];
      const bf = await migrator.backfill({
        batchSize: 3,
        onProgress: (p) => progressEvents.push(p.rowsUpdated),
      });
      expect(bf.rowsUpdated).toBe(9);
      expect(bf.batchesCompleted).toBe(3);
      expect(progressEvents).toEqual([3, 6, 9]);

      // Phase 3: Parity verification (`IS DISTINCT FROM` -> 0 mismatches)
      const parity = await migrator.verifyParity();
      expect(parity.valid).toBe(true);
      expect(parity.mismatchedRows).toBe(0);
      expect(parity.totalRows).toBe(9);

      // Phase 4: Contract (drops PSQL dual-write trigger + legacy columns)
      const contracted = await migrator.contract({ dropSourceColumns: true });
      expect(contracted.droppedColumns).toEqual(['FULL_NAME', 'PRICE_CENTS']);
      expect(await migrator.getPhase()).toBe('contracted');

      const finalRow = await db.query<Record<string, unknown>>(
        'SELECT DISPLAY_NAME, UNIT_DOLLARS, LINE_TOTAL_CENTS FROM CUSTOMERS WHERE ID = 1',
      );
      expect(finalRow.rows[0]?.DISPLAY_NAME).toBe('Customer 1');
      expect(Number(finalRow.rows[0]?.UNIT_DOLLARS)).toBeCloseTo(1.0, 2);
      expect(Number(finalRow.rows[0]?.LINE_TOTAL_CENTS)).toBe(200);

      // Safe rollback test on a second migration
      const mig2 = createOnlineMigrator(db, {
        id: 'mig_abort_demo',
        table: 'CUSTOMERS',
        rules: [{ kind: 'renameColumn', from: 'DISPLAY_NAME', to: 'TEMP_NAME', type: 'VARCHAR(80)' }],
      });
      await mig2.expand();
      const rolled = await mig2.rollback();
      expect(rolled.droppedColumns).toEqual(['TEMP_NAME']);
      expect(await mig2.getPhase()).toBe('rolled_back');
    } finally {
      await db.close();
    }
  });

  it('Item 4: detects NATURAL scans, unindexed FKs, redundant prefix indexes & inactive indexes via createWorkloadAdvisor, applies fixes & exposes CLI worker/migrate-online/advise', async () => {
    const db = new FirebirdBrowser('memory://m28-advisor', { threads: false });
    try {
      await db.exec(`
        CREATE TABLE TENANTS (
          ID INTEGER NOT NULL PRIMARY KEY,
          NAME VARCHAR(60)
        );
        CREATE TABLE INVOICES (
          ID INTEGER NOT NULL PRIMARY KEY,
          TENANT_ID INTEGER,
          CUSTOMER_EMAIL VARCHAR(100),
          STATUS VARCHAR(20),
          CREATED_AT INTEGER
        );
        CREATE INDEX IDX_INV_STATUS ON INVOICES (STATUS);
        CREATE INDEX IDX_INV_STATUS_CREATED ON INVOICES (STATUS, CREATED_AT);
        CREATE INDEX IDX_INV_STALE ON INVOICES (CREATED_AT);
        ALTER INDEX IDX_INV_STALE INACTIVE;
      `);
      await db.execute("INSERT INTO TENANTS VALUES (1, 'Acme')");
      await db.execute("INSERT INTO INVOICES VALUES (10, 1, 'billing@acme.io', 'OPEN', 1000)");

      const advisor = createWorkloadAdvisor(db);
      // Run an unindexed filter query captured automatically via db.onQuery()
      await db.query("SELECT * FROM INVOICES WHERE CUSTOMER_EMAIL = 'billing@acme.io'");

      const report = await advisor.analyze();
      const kinds = report.recommendations.map((r) => r.kind);
      expect(kinds).toContain('MISSING_FILTER_INDEX');
      expect(kinds).toContain('UNINDEXED_FOREIGN_KEY');
      expect(kinds).toContain('REDUNDANT_PREFIX_INDEX');
      expect(kinds).toContain('INACTIVE_OR_STALE_INDEX');

      // Apply MISSING_FILTER_INDEX + REDUNDANT_PREFIX_INDEX recommendations and verify plan flips from NATURAL -> INDEX!
      const planBefore = await db.explain(
        "SELECT * FROM INVOICES WHERE CUSTOMER_EMAIL = 'billing@acme.io'",
      );
      expect(planBefore.toUpperCase()).toContain('NATURAL');

      const applied = await advisor.applyRecommendations({
        kinds: ['MISSING_FILTER_INDEX', 'REDUNDANT_PREFIX_INDEX'],
      });
      expect(applied.applied).toBe(true);
      expect(applied.statements.length).toBeGreaterThanOrEqual(2);

      const planAfter = await db.explain(
        "SELECT * FROM INVOICES WHERE CUSTOMER_EMAIL = 'billing@acme.io'",
      );
      expect(planAfter.toUpperCase()).toContain('INDEX');
      advisor.dispose();

      // MCP `advise_workload` tool
      const mcp = createFirebirdMcpServer(db, { enableAdvisor: true });
      expect(mcp.listTools().map((t) => t.name)).toContain('advise_workload');
      const mcpAdv = await mcp.callTool('advise_workload', {
        queries: ["SELECT * FROM TENANTS WHERE NAME = 'Acme'"],
      });
      expect(mcpAdv.isError).toBeUndefined();
      expect(JSON.parse(mcpAdv.content[0]!.text).recommendations.length).toBeGreaterThanOrEqual(1);
    } finally {
      await db.close();
    }

    // CLI `worker`, `migrate-online`, and `advise` integration on a file-backed `.fdb`
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m28-cli-'));
    const fdbPath = path.join(tmpDir, 'm28.fdb');
    try {
      const seedDb = new FirebirdBrowser('memory://m28-cli-seed', { threads: false });
      await seedDb.exec(
        'CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, LEGACY_TITLE VARCHAR(60), CATEGORY VARCHAR(40))',
      );
      await seedDb.execute("INSERT INTO ITEMS VALUES (1, 'Widget', 'hardware')");
      const jq = createJobQueue(seedDb);
      await jq.enqueue('sql', {
        sql: "INSERT INTO ITEMS VALUES (2, 'Queued Gadget', 'hardware')",
      });
      fs.writeFileSync(fdbPath, await seedDb.dumpDataDir());
      await seedDb.close();

      // 1. CLI `worker`
      let workerOut = '';
      const wCode = await runCli(
        ['worker', fdbPath, '--backend', 'wasm', '--json'],
        { stdout: (s) => (workerOut += s), stderr: () => {} },
      );
      expect(wCode).toBe(0);
      expect(JSON.parse(workerOut).succeeded).toBe(1);

      // 2. CLI `migrate-online`
      let migOut = '';
      const planJson = JSON.stringify({
        id: 'cli_rename_title',
        table: 'ITEMS',
        primaryKey: 'ID',
        rules: [{ kind: 'renameColumn', from: 'LEGACY_TITLE', to: 'TITLE', type: 'VARCHAR(60)' }],
      });
      const mCode = await runCli(
        ['migrate-online', fdbPath, '--plan', planJson, '--drop-source', '--backend', 'wasm', '--json'],
        { stdout: (s) => (migOut += s), stderr: () => {} },
      );
      expect(mCode).toBe(0);
      const migParsed = JSON.parse(migOut);
      expect(migParsed.parity.valid).toBe(true);
      expect(migParsed.droppedColumns).toEqual(['LEGACY_TITLE']);

      // 3. CLI `advise`
      let advOut = '';
      const aCode = await runCli(
        [
          'advise',
          fdbPath,
          '--sql',
          "SELECT * FROM ITEMS WHERE CATEGORY = 'hardware'",
          '--apply',
          '--backend',
          'wasm',
          '--json',
        ],
        { stdout: (s) => (advOut += s), stderr: () => {} },
      );
      expect(aCode).toBe(0);
      const advParsed = JSON.parse(advOut);
      expect(advParsed.appliedCount).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
