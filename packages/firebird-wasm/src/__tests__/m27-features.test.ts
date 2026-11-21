/**
 * M27 Feature Suite:
 * 1. Guarded Model Context Protocol (MCP) Server & CLI `mcp` (`createFirebirdMcpServer`)
 * 2. Markdown/Code-Aware Document Chunker & Incremental SHA-256 RAG Ingester (`chunkDocument`, `createRagIngester`)
 * 3. OpenTelemetry Tracing, W3C `traceparent` Propagation & Prometheus `/metrics` (`createOtelInstrumentation`, `formatPrometheusMetrics`)
 * 4. Authenticated Encrypted `.fbkp` Backup Archives, Incremental Chains & CLI `backup` / `verify-backup`
 * 5. Sub-1,350-Line Source File Modularity Invariant across `packages/firebird-wasm/src`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  FBKP_ARCHIVE_MAGIC,
  FirebirdBrowser,
  MCP_PROTOCOL_VERSION,
  chunkDocument,
  createAuditLog,
  createEncryptedBackup,
  createFirebirdMcpServer,
  createHttpReplicationClient,
  createHttpReplicationHandler,
  createOtelInstrumentation,
  createPublication,
  createRagIngester,
  encodeVector,
  formatPrometheusMetrics,
  generateTraceparent,
  isEncryptedBackupArchive,
  parseTraceparent,
  restoreEncryptedBackup,
  sha256HexSync,
  verifyAuditChain,
  verifyBackupArchive,
  type OtelAttributeValue,
  type OtelMeterLike,
  type OtelTracerLike,
} from '../browser';
import { runCli, startCliReplicationServer } from '../cli';

function deterministicEmbed(text: string): number[] {
  const lower = text.toLowerCase();
  const sOpfs = (lower.match(/opfs|storage|vfs|page/g) ?? []).length;
  const sSync = (lower.match(/sync|replication|crdt|hlc/g) ?? []).length;
  const sMcp = (lower.match(/mcp|agent|tool|json-rpc/g) ?? []).length;
  const sOtel = (lower.match(/otel|traceparent|prometheus|metric/g) ?? []).length;
  const raw = [sOpfs + 0.1, sSync + 0.1, sMcp + 0.1, sOtel + 0.1];
  const norm = Math.hypot(...raw) || 1;
  return raw.map((v) => v / norm);
}

describe('M27 Feature Suite', () => {
  it('enforces strict < 1,350-line source modularity across every non-test .ts file in src/', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const oversized: Array<{ file: string; lines: number }> = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.d.ts')
        ) {
          const content = fs.readFileSync(full, 'utf8');
          const lineCount = content.split(/\r?\n/).length;
          if (lineCount >= 1350) {
            oversized.push({
              file: path.relative(srcRoot, full).replace(/\\/g, '/'),
              lines: lineCount,
            });
          }
        }
      }
    };

    walk(srcRoot);
    expect(oversized).toEqual([]);
  });

  it('serves guarded MCP JSON-RPC tools, resources, prompts, HTTP /mcp & CLI stdio with audit attestation', async () => {
    const db = new FirebirdBrowser('memory://m27_mcp', {
      threads: false,
      types: { binary: true },
    });
    try {
      await db.execute(
        'CREATE TABLE DOCS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(120), BODY VARCHAR(500), EMB VARBINARY(16))',
      );
      await db.execute('INSERT INTO DOCS VALUES (?, ?, ?, ?)', [
        1,
        'OPFS VFS Engine',
        'Firebird WASM persists pages durability in browser OPFS storage.',
        encodeVector(deterministicEmbed('opfs storage page vfs')),
      ]);
      await db.execute('INSERT INTO DOCS VALUES (?, ?, ?, ?)', [
        2,
        'CRDT Replication',
        'Hybrid logical clocks merge concurrent sync updates across nodes.',
        encodeVector(deterministicEmbed('sync replication crdt hlc')),
      ]);

      // 1. Read-only MCP server (default allowWrites: false)
      const roMcp = createFirebirdMcpServer(db, { maxRows: 1, apiKey: 'secret-mcp' });
      expect(roMcp.allowWrites).toBe(false);
      expect(roMcp.listTools().map((t) => t.name)).toEqual([
        'list_tables',
        'describe_table',
        'read_query',
        'explain_query',
        'hybrid_search',
      ]);

      const initRes = await roMcp.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      });
      expect((initRes?.result as Record<string, unknown>).protocolVersion).toBe(
        MCP_PROTOCOL_VERSION,
      );

      // read_query enforces maxRows=1 and blocks DML/DDL
      const readRes = await roMcp.callTool('read_query', {
        sql: 'SELECT ID, TITLE FROM DOCS ORDER BY ID',
      });
      expect(readRes.isError).toBeUndefined();
      const parsedRead = JSON.parse(readRes.content[0]!.text) as {
        rowCount: number;
        truncated: boolean;
      };
      expect(parsedRead.rowCount).toBe(1);
      expect(parsedRead.truncated).toBe(true);

      const blockedDml = await roMcp.callTool('read_query', {
        sql: 'DELETE FROM DOCS WHERE ID = 1',
      });
      expect(blockedDml.isError).toBe(true);
      expect(blockedDml.content[0]!.text).toMatch(/only permits read-only SELECT/i);

      const blockedWriteTool = await roMcp.callTool('write_query', {
        sql: "INSERT INTO DOCS (ID, TITLE, BODY) VALUES (3, 'x', 'y')",
      });
      expect(blockedWriteTool.isError).toBe(true);
      expect(blockedWriteTool.content[0]!.text).toMatch(/disabled/i);

      // describe_table, explain_query, hybrid_search, resources & prompts
      const descTool = await roMcp.callTool('describe_table', { table: 'DOCS' });
      expect(JSON.parse(descTool.content[0]!.text).table).toBe('DOCS');

      const planTool = await roMcp.callTool('explain_query', {
        sql: 'SELECT * FROM DOCS WHERE ID = 1',
      });
      expect(planTool.isError).toBeUndefined();
      expect(planTool.content[0]!.text.length).toBeGreaterThan(0);

      const hybridTool = await roMcp.callTool('hybrid_search', {
        table: 'DOCS',
        ftsColumns: ['TITLE', 'BODY'],
        vectorColumn: 'EMB',
        textQuery: 'OPFS browser storage',
        vectorQuery: deterministicEmbed('opfs storage'),
        limit: 2,
      });
      const hybridJson = JSON.parse(hybridTool.content[0]!.text) as {
        hits: Array<{ ID: number }>;
      };
      expect(hybridJson.hits[0]?.ID).toBe(1);

      const schemaResource = await roMcp.readResource('firebird://schema');
      expect(schemaResource.contents[0]!.text).toMatch(/CREATE TABLE/i);

      const sampleResource = await roMcp.readResource('firebird://table/DOCS/sample');
      expect(JSON.parse(sampleResource.contents[0]!.text).sampleRows.length).toBe(2);

      const promptReply = await roMcp.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'prompts/get',
        params: { name: 'firebird_sql_assistant', arguments: { question: 'Count docs' } },
      });
      expect(JSON.stringify(promptReply?.result)).toContain('DOCS');

      // HTTP fetchHandler auth check + JSON-RPC POST
      const unauthHttp = await roMcp.fetchHandler(
        new Request('http://localhost/mcp', { method: 'GET' }),
      );
      expect(unauthHttp.status).toBe(401);

      const authHttp = await roMcp.fetchHandler(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret-mcp',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
        }),
      );
      expect(authHttp.status).toBe(200);
      const httpPayload = (await authHttp.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(httpPayload.result.tools.length).toBe(5);

      // 2. Opt-in write_query + FB_AUDIT_LOG$ attestation
      const rwMcp = createFirebirdMcpServer(db, {
        allowWrites: true,
        audit: true,
        auditActor: 'claude-mcp',
      });
      expect(rwMcp.listTools().some((t) => t.name === 'write_query')).toBe(true);
      const writeRes = await rwMcp.callTool('write_query', {
        sql: 'INSERT INTO DOCS (ID, TITLE, BODY) VALUES (?, ?, ?)',
        params: [3, 'MCP Agent Guide', 'Guarded SQL tool execution with audit chain.'],
      });
      expect(writeRes.isError).toBeUndefined();

      const auditHead = await rwMcp.readResource('firebird://audit/head');
      const parsedAudit = JSON.parse(auditHead.contents[0]!.text) as {
        valid: boolean;
        checkedCount: number;
      };
      expect(parsedAudit.valid).toBe(true);
      expect(parsedAudit.checkedCount).toBe(1);

      // 3. CLI `firebird-wasm mcp` over newline-delimited stdio
      const cliOut: string[] = [];
      const exitCode = await runCli(['mcp', 'memory://m27_cli_mcp'], {
        stdinLines: [
          JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'initialize' }),
          JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' }),
        ],
        stdout: (s) => cliOut.push(s),
      });
      expect(exitCode).toBe(0);
      const lines = cliOut.join('').trim().split(/\r?\n/);
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[1]!).id).toBe(102);
    } finally {
      await db.close();
    }
  });

  it('chunks Markdown/code with heading breadcrumbs & incrementally ingests RAG docs via SHA-256 diffing', async () => {
    // FIPS 180-4 test vectors for sha256HexSync
    expect(sha256HexSync('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );

    const markdown = [
      '# Architecture',
      '',
      '## OPFS Storage',
      'Firebird WASM stores 8 KB database pages in Origin Private File System handles.',
      '',
      '```sql',
      'SELECT * FROM RDB$DATABASE;',
      '```',
      '',
      '## CRDT Sync',
      'Hybrid logical clocks merge concurrent updates deterministically across peers.',
    ].join('\n');

    const chunks = chunkDocument(markdown, {
      maxTokens: 32,
      overlapTokens: 6,
      strategy: 'markdown',
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.headingPath).toEqual(['Architecture', 'OPFS Storage']);
    expect(chunks.some((c) => c.text.includes('SELECT * FROM RDB$DATABASE;'))).toBe(true);
    expect(chunks.some((c) => c.headingPath.includes('CRDT Sync'))).toBe(true);
    expect(chunks[0]!.startLine).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.contentHash).toHaveLength(64);

    // Sentence strategy sanity check
    const sentenceChunks = chunkDocument(
      'First sentence about OPFS. Second sentence about CRDT sync. Third sentence about MCP.',
      { maxTokens: 10, overlapTokens: 0, strategy: 'sentence' },
    );
    expect(sentenceChunks.length).toBeGreaterThanOrEqual(2);

    const db = new FirebirdBrowser('memory://m27_rag_ingester', {
      threads: false,
      types: { binary: true },
    });
    try {
      let embedBatchCalls = 0;
      let embeddedStringsTotal = 0;

      const ingester = createRagIngester(db, {
        embed: (texts) => {
          embedBatchCalls += 1;
          embeddedStringsTotal += texts.length;
          return texts.map(deterministicEmbed);
        },
        chunkOptions: { maxTokens: 40, overlapTokens: 4 },
        quantization: 'int8',
        persistIndexes: true,
        semanticCache: true,
      });

      // 1. Initial ingest embeds all chunks
      const r1 = await ingester.ingestDocument({
        docId: 'guide-v1',
        title: 'Engine Guide',
        text: markdown,
        metadata: { version: 1 },
      });
      expect(r1.totalChunks).toBeGreaterThanOrEqual(2);
      expect(r1.embeddedChunks).toBe(r1.totalChunks);
      expect(r1.skippedChunks).toBe(0);
      const callsAfterFirst = embedBatchCalls;
      const stringsAfterFirst = embeddedStringsTotal;

      // 2. Re-ingesting identical document skips 100% of chunks (0 embed calls!)
      const r2 = await ingester.ingestDocument({
        docId: 'guide-v1',
        title: 'Engine Guide',
        text: markdown,
      });
      expect(r2.embeddedChunks).toBe(0);
      expect(r2.skippedChunks).toBe(r1.totalChunks);
      expect(embedBatchCalls).toBe(callsAfterFirst);
      expect(embeddedStringsTotal).toBe(stringsAfterFirst);

      // 3. Updating only the second section skips the unchanged first section
      const updatedMarkdown = markdown.replace(
        'Hybrid logical clocks merge concurrent updates deterministically across peers.',
        'OpenTelemetry traceparent headers propagate spans across HTTP replication.',
      );
      const r3 = await ingester.ingestDocument({
        docId: 'guide-v1',
        title: 'Engine Guide',
        text: updatedMarkdown,
      });
      expect(r3.embeddedChunks).toBeGreaterThanOrEqual(1);
      expect(r3.skippedChunks).toBeGreaterThanOrEqual(1);

      // 4. askContext packs context within tokenBudget & populates semanticCache
      const ctx1 = await ingester.askContext('opfs storage pages', { tokenBudget: 120 });
      expect(ctx1.fromCache).toBe(false);
      expect(ctx1.includedChunks.length).toBeGreaterThanOrEqual(1);
      expect(ctx1.promptContext).toMatch(/OPFS/i);

      const ctx2 = await ingester.askContext('opfs storage pages', { tokenBudget: 120 });
      expect(ctx2.fromCache).toBe(true);
      expect(ctx2.promptContext).toBe(ctx1.promptContext);

      // 5. deleteDocument removes all chunks for docId
      const deleted = await ingester.deleteDocument('guide-v1');
      expect(deleted).toBe(r3.totalChunks);

      await ingester.close();
    } finally {
      await db.close();
    }
  });

  it('captures OpenTelemetry spans, propagates W3C traceparent, and serves Prometheus GET /metrics', async () => {
    const parentTp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parsed = parseTraceparent(parentTp);
    expect(parsed).toEqual({
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
      sampled: true,
    });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();

    const child = generateTraceparent({ parent: parentTp });
    expect(child.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(child.parentSpanId).toBe('00f067aa0ba902b7');
    expect(child.spanId).not.toBe('00f067aa0ba902b7');

    const db = new FirebirdBrowser('memory://m27_otel', { threads: false });
    try {
      const externalSpans: Array<{ name: string; attrs: Record<string, OtelAttributeValue> }> = [];
      let counterTotal = 0;

      const mockTracer: OtelTracerLike = {
        startSpan(name, opts) {
          const attrs: Record<string, OtelAttributeValue> = { ...(opts?.attributes ?? {}) };
          externalSpans.push({ name, attrs });
          return {
            setAttribute(k, v) {
              attrs[k] = v;
            },
            end() {},
          };
        },
      };
      const mockMeter: OtelMeterLike = {
        createCounter() {
          return {
            add(v) {
              counterTotal += v;
            },
          };
        },
      };

      const otel = createOtelInstrumentation({
        db,
        tracer: mockTracer,
        meter: mockMeter,
        dbNamespace: 'tenant_acme',
      });

      await db.execute(
        "CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, SECRET VARCHAR(64))",
      );
      await db.execute("INSERT INTO ITEMS VALUES (1, 'super_secret_token')");
      await db.query('SELECT ID FROM ITEMS WHERE ID = 1');

      const spans = otel.getRecordedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(3);
      expect(counterTotal).toBeGreaterThanOrEqual(3);
      expect(externalSpans.length).toBeGreaterThanOrEqual(3);

      const insertSpan = spans.find((s) =>
        String(s.attributes['db.query.text'] ?? '').includes('INSERT INTO ITEMS'),
      );
      expect(insertSpan).toBeDefined();
      expect(insertSpan!.attributes['db.system']).toBe('firebird');
      expect(insertSpan!.attributes['db.namespace']).toBe('tenant_acme');
      // Redacted literal check
      expect(String(insertSpan!.attributes['db.query.text'])).not.toContain('super_secret_token');

      // HTTP Replication GET /metrics & W3C traceparent propagation
      const pub = await createPublication(db, {
        name: 'pub_otel',
        nodeId: 'primary',
        tables: ['ITEMS'],
        installTriggers: true,
      });
      const handler = createHttpReplicationHandler({
        publication: pub,
        metricsDb: db,
        otel,
      });

      const client = createHttpReplicationClient({
        baseUrl: 'http://sync.local',
        fetch: (input, init) =>
          handler(new Request(String(input), init)),
        traceparent: parentTp,
      });
      await client.fetchChangesSince(0);

      const metricsRes = await handler(
        new Request('http://sync.local/metrics', {
          method: 'GET',
          headers: { traceparent: parentTp },
        }),
      );
      expect(metricsRes.status).toBe(200);
      const echoedTp = metricsRes.headers.get('traceparent');
      expect(echoedTp).toBeTruthy();
      expect(parseTraceparent(echoedTp)?.traceId).toBe(parsed!.traceId);

      const promText = await metricsRes.text();
      expect(promText).toContain('firebird_queries_total');
      expect(promText).toContain('firebird_replication_primary_lsn');
      expect(promText).toContain('firebird_sse_subscribers');
      expect(promText).toContain('firebird_presence_online_peers');
      expect(formatPrometheusMetrics({ sseSubscribers: 3 }, { prefix: 'fb_custom' })).toContain(
        'fb_custom_sse_subscribers 3',
      );

      // Verify `startCliReplicationServer` (`serve-sync`) exposes GET /metrics over real TCP
      const srv = await startCliReplicationServer({ db, port: 0 });
      try {
        const tcpRes = await fetch(`${srv.url}/metrics`, {
          headers: { traceparent: parentTp },
        });
        expect(tcpRes.status).toBe(200);
        expect(tcpRes.headers.get('traceparent')).toContain(parsed!.traceId);
        const tcpProm = await tcpRes.text();
        expect(tcpProm).toContain('firebird_queries_total');
      } finally {
        await srv.close();
      }

      otel.dispose();
    } finally {
      await db.close();
    }
  });

  it('creates, verifies, tampert-tests, and restores full + incremental .fbkp encrypted backups & CLI commands', async () => {
    const db = new FirebirdBrowser('memory://m27_backup_src', { threads: false });
    const restoredDb = new FirebirdBrowser('memory://m27_backup_dst', { threads: false });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m27-fbkp-'));

    try {
      await db.execute(
        'CREATE TABLE LEDGER (ID INTEGER NOT NULL PRIMARY KEY, AMOUNT INTEGER NOT NULL)',
      );
      const audit = createAuditLog(db, { actorResolver: () => 'treasury@acme.io' });
      const repo = audit.wrapTable(db.table('LEDGER'));
      await repo.insert({ ID: 1, AMOUNT: 500 });

      // 1. Full encrypted backup with audit Merkle attestation
      const fullBkp = await createEncryptedBackup(db, {
        key: 'correct-horse-battery-staple',
        backupId: 'bkp_full_001',
        pbkdf2Iterations: 5_000,
        chunkSize: 16_384,
      });
      expect(isEncryptedBackupArchive(fullBkp.archiveBytes)).toBe(true);
      expect(Array.from(fullBkp.archiveBytes.subarray(0, 8))).toEqual(
        Array.from(FBKP_ARCHIVE_MAGIC),
      );
      expect(fullBkp.header.kind).toBe('full');
      expect(fullBkp.header.auditAttestation?.valid).toBe(true);
      expect(fullBkp.header.auditAttestation?.checkedCount).toBe(1);

      // Zero-knowledge Merkle verification (no passphrase) & full AES-GCM verification
      const zkCheck = await verifyBackupArchive(fullBkp.archiveBytes);
      expect(zkCheck.valid).toBe(true);
      expect(zkCheck.decrypted).toBe(false);

      const keyCheck = await verifyBackupArchive(fullBkp.archiveBytes, {
        key: 'correct-horse-battery-staple',
      });
      expect(keyCheck.valid).toBe(true);
      expect(keyCheck.decrypted).toBe(true);

      // Tamper 1 ciphertext byte -> Merkle / SHA-256 verification catches corruption
      const tampered = new Uint8Array(fullBkp.archiveBytes);
      tampered[tampered.length - 5] ^= 0xff;
      const tamperCheck = await verifyBackupArchive(tampered);
      expect(tamperCheck.valid).toBe(false);
      expect(tamperCheck.reason).toMatch(/hash mismatch/i);

      // Wrong passphrase rejected by AES-256-GCM authentication tag
      await expect(
        restoreEncryptedBackup(fullBkp.archiveBytes, null, { key: 'wrong-passphrase' }),
      ).rejects.toThrow(/authentication failed/i);

      // 2. Incremental page-diff backup ("FBDF\x01") chained off fullBkp.rawDatabaseBytes
      await repo.insert({ ID: 2, AMOUNT: 1250 });
      const incBkp = await createEncryptedBackup(db, {
        key: 'correct-horse-battery-staple',
        backupId: 'bkp_inc_002',
        baseImage: fullBkp.rawDatabaseBytes,
        baseBackupId: fullBkp.header.backupId,
        pbkdf2Iterations: 5_000,
      });
      expect(incBkp.header.kind).toBe('incremental');
      expect(incBkp.header.baseBackupId).toBe('bkp_full_001');
      expect(incBkp.archiveBytes.byteLength).toBeLessThan(fullBkp.rawDatabaseBytes.byteLength);

      // Restore incremental backup onto `restoredDb` and verify both rows + audit chain
      const restored = await restoreEncryptedBackup(incBkp.archiveBytes, restoredDb, {
        key: 'correct-horse-battery-staple',
        baseImage: fullBkp.rawDatabaseBytes,
      });
      expect(restored.auditVerified).toBe(true);
      const rows = await restoredDb.query<{ ID: number; AMOUNT: number }>(
        'SELECT ID, AMOUNT FROM LEDGER ORDER BY ID',
      );
      expect(rows.rows).toEqual([
        { ID: 1, AMOUNT: 500 },
        { ID: 2, AMOUNT: 1250 },
      ]);
      const restoredAudit = await verifyAuditChain(restoredDb);
      expect(restoredAudit.valid).toBe(true);
      expect(restoredAudit.checkedCount).toBe(2);

      // 3. CLI `backup` and `verify-backup --restore-to` end-to-end on local .fdb files
      const srcFdb = path.join(tmpDir, 'cli_src.fdb');
      const outFbkp = path.join(tmpDir, 'cli_src.fbkp');
      const dstFdb = path.join(tmpDir, 'cli_restored.fdb');
      fs.writeFileSync(srcFdb, await db.dumpDataDir());

      const bkpStdout: string[] = [];
      const bkpExit = await runCli(
        ['backup', srcFdb, '--out', outFbkp, '--key', 'cli-secret', '--json'],
        { cwd: tmpDir, stdout: (s) => bkpStdout.push(s) },
      );
      expect(bkpExit).toBe(0);
      expect(fs.existsSync(outFbkp)).toBe(true);

      const verStdout: string[] = [];
      const verExit = await runCli(
        [
          'verify-backup',
          outFbkp,
          '--key',
          'cli-secret',
          '--restore-to',
          dstFdb,
          '--json',
        ],
        { cwd: tmpDir, stdout: (s) => verStdout.push(s) },
      );
      expect(verExit).toBe(0);
      expect(JSON.parse(verStdout.join('')).valid).toBe(true);
      expect(fs.existsSync(dstFdb)).toBe(true);
    } finally {
      await db.close();
      await restoredDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
