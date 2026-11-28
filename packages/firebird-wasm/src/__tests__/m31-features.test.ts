/**
 * M31 Feature Suite:
 * 1. CDN-Cacheable Electric `/v1/shape` Protocol, `live_sse=true`, `DELETE /v1/shape` & `createWasmShapeServer`
 * 2. On-Demand `subset__*` Snapshots, Progressive / On-Demand Sync (`syncMode`) & `autoCreateTable`
 * 3. Relational Subquery `WHERE` Shapes (`move-in` / `move-out`) & Exact `replica=full` `old_value` Capture
 * 4. Postgres `JSONB` SQL UDR + Inverted `GIN` Index (`createJsonGinIndex`) & `pg_trgm` Fuzzy Trigram Search (`createTrigramIndex`)
 * 5. Prisma Driver Adapter (`createFirebirdPrismaAdapter`), Monotonic `uuidv7` / `ulid` & Strict `< 1,000`-Line Modularity
 */

import * as fs from 'fs';
import * as path from 'path';
import { Shape, ShapeStream } from '@electric-sql/client';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JSON_GIN_TABLE,
  DEFAULT_TRIGRAM_INDEX_TABLE,
  FirebirdBrowser,
  WASM_SHAPE_CHANGES_TABLE,
  WASM_SHAPE_META_TABLE,
  computeElectricCursor,
  computeShapeEtag,
  createFirebirdPrismaAdapter,
  createJsonGinIndex,
  createTrigramIndex,
  createWasmShapeServer,
  extractTrigrams,
  fetchPersistedJsonGinIndexes,
  fetchPersistedTrigramIndexes,
  jsonContains,
  jsonExtractQuery,
  jsonExtractValue,
  jsonHasKey,
  jsonSetPath,
  jsonStripNulls,
  jsonTypeof,
  levenshteinDistance,
  registerIdFunctions,
  registerJsonbFunctions,
  registerTrigramFunctions,
  trigramSimilarity,
  ulid,
  uuidv7,
  wordSimilarity,
} from '../browser';
import { ensureTableFromElectricSchema, syncShapeToTable } from '../electric';

describe('M31: Electric Postgres Full Parity — CDN /v1/shape + SSE, subset__* & Auto-DDL, Subquery move-in/move-out, JSONB GIN, pg_trgm & Prisma Adapter', () => {
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

  it('M31 Item 1: serves CDN-cacheable immutable chunks, ETag 304 Not Modified, live_sse=true EventSource stream & DELETE /v1/shape handle rotation', async () => {
    const db = new FirebirdBrowser('memory://m31-shape-cdn', { autoPersist: false });
    try {
      expect(WASM_SHAPE_CHANGES_TABLE).toBe('ELECTRIC_WASM_CHANGES$');
      expect(WASM_SHAPE_META_TABLE).toBe('ELECTRIC_WASM_META$');
      expect(computeElectricCursor('h1', '0_0', 5000, 12_000)).toBe(
        computeElectricCursor('h1', '0_0', 5000, 14_999),
      );
      expect(computeShapeEtag('h1', '2_0', 2, 3)).toContain('ef-h1-2_0-2-3');

      await db.execute(
        'CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64) NOT NULL, PRIORITY VARCHAR(16) NOT NULL)',
      );
      await db.execBatch('INSERT INTO ITEMS (ID, TITLE, PRIORITY) VALUES (?, ?, ?)', [
        [1, 'Alpha', 'HIGH'],
        [2, 'Beta', 'LOW'],
        [3, 'Gamma', 'HIGH'],
      ]);

      const shapeSrv = await createWasmShapeServer(db, {
        tables: ['ITEMS'],
        snapshotPageRows: 2,
        liveTimeoutMs: 400,
        pollIntervalMs: 20,
      });

      const localFetch: typeof fetch = (input, init) =>
        shapeSrv.fetch(new Request(typeof input === 'string' ? input : input.toString(), init));

      // 1. Paginated snapshot (`offset=-1` -> `0_1` immutable page -> `304 Not Modified` on ETag match)
      const p0 = await localFetch('http://shape.local/v1/shape?table=items&offset=-1');
      expect(p0.status).toBe(200);
      expect(p0.headers.get('cache-control')).toContain('max-age=60');
      const handle = p0.headers.get('electric-handle')!;
      const nextOff = p0.headers.get('electric-offset')!;
      expect(nextOff).toMatch(/^\d+_1$/);

      const p1 = await localFetch(
        `http://shape.local/v1/shape?table=items&offset=${nextOff}&handle=${handle}`,
      );
      expect(p1.status).toBe(200);
      expect(p1.headers.get('cache-control')).toBe('public, max-age=604800, immutable');
      const etag1 = p1.headers.get('etag')!;
      expect(etag1).toBeTruthy();

      const p1Cached = await localFetch(
        `http://shape.local/v1/shape?table=items&offset=${nextOff}&handle=${handle}`,
        { headers: { 'If-None-Match': etag1 } },
      );
      expect(p1Cached.status).toBe(304);

      // 2. Real `@electric-sql/client` `ShapeStream` with `liveSse: true`
      const abortSse = new AbortController();
      const sseStream = new ShapeStream({
        url: 'http://shape.local/v1/shape',
        params: { table: 'items' },
        liveSse: true,
        fetchClient: localFetch,
        signal: abortSse.signal,
      });
      const liveShape = new Shape(sseStream);
      const initialRows = await liveShape.rows;
      expect(initialRows).toHaveLength(3);

      // Commit a new row while SSE stream is active
      await shapeSrv.applyWrite({
        table: 'items',
        operation: 'insert',
        key: { id: 4 },
        value: { title: 'Delta SSE', priority: 'HIGH' },
      });

      const deadline = Date.now() + 3_000;
      while (liveShape.currentRows.length < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(liveShape.currentRows.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4,
      ]);
      abortSse.abort();
      sseStream.unsubscribeAll();

      // 3. `DELETE /v1/shape?table=items` rotates handle -> old handle receives 409 must-refetch
      const delRes = await localFetch('http://shape.local/v1/shape?table=items', {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(202);

      const stalePoll = await localFetch(
        `http://shape.local/v1/shape?table=items&offset=0_0&handle=${handle}`,
      );
      expect(stalePoll.status).toBe(409);
      const staleBody = (await stalePoll.json()) as Array<{ headers: { control: string } }>;
      expect(staleBody[0]?.headers.control).toBe('must-refetch');
      expect(stalePoll.headers.get('electric-handle')).not.toBe(handle);

      await shapeSrv.close();
    } finally {
      await db.close();
    }
  });

  it('M31 Item 2: hydrates on-demand subset__* snapshots (`GET` & `POST`), runs syncMode: "on-demand" + requestSubset, and auto-creates / migrates tables from electric-schema', async () => {
    const sourceDb = new FirebirdBrowser('memory://m31-subset-src', { autoPersist: false });
    const clientDb = new FirebirdBrowser('memory://m31-subset-dst', { autoPersist: false });
    try {
      await sourceDb.execute(
        'CREATE TABLE TASKS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(64) NOT NULL, PRIORITY VARCHAR(16) NOT NULL, SCORE INTEGER NOT NULL)',
      );
      await sourceDb.execBatch(
        'INSERT INTO TASKS (ID, TITLE, PRIORITY, SCORE) VALUES (?, ?, ?, ?)',
        [
          [1, 'Low-1', 'LOW', 10],
          [2, 'High-2', 'HIGH', 80],
          [3, 'Low-3', 'LOW', 20],
          [4, 'High-4', 'HIGH', 95],
          [5, 'High-5', 'HIGH', 60],
        ],
      );

      const shapeSrv = await createWasmShapeServer(sourceDb, {
        tables: ['TASKS'],
        liveTimeoutMs: 250,
        pollIntervalMs: 20,
      });
      const localFetch: typeof fetch = (input, init) =>
        shapeSrv.fetch(new Request(typeof input === 'string' ? input : input.toString(), init));

      // 1. Direct `@electric-sql/client` `fetchSnapshot()` over both GET `subset__*` and POST JSON body
      const abort = new AbortController();
      const rawStream = new ShapeStream({
        url: 'http://shape.local/v1/shape',
        params: { table: 'tasks' },
        log: 'changes_only',
        subscribe: false,
        fetchClient: localFetch,
        signal: abort.signal,
      });

      const subGet = await rawStream.fetchSnapshot({
        where: 'priority = $1',
        params: { '1': 'HIGH' },
        orderBy: 'score DESC',
        limit: 2,
      });
      expect(subGet.data.map((m) => Number(m.value.id))).toEqual([4, 2]);

      const subPost = await rawStream.fetchSnapshot({
        where: 'score >= $1',
        params: { '1': 60 },
        orderBy: 'id ASC',
        method: 'POST',
      });
      expect(subPost.data.map((m) => Number(m.value.id))).toEqual([2, 4, 5]);
      abort.abort();

      // 2. `syncShapeToTable` with `syncMode: 'on-demand'` + `autoCreateTable: true` (clientDb starts completely empty!)
      const sync = await syncShapeToTable(clientDb, {
        shape: {
          url: 'http://shape.local/v1/shape',
          params: { table: 'tasks' },
          fetchClient: localFetch,
        },
        table: 'tasks',
        shapeKey: 'tasks_ondemand',
        syncMode: 'on-demand',
        autoCreateTable: { migrateColumns: true },
      });

      await sync.upToDate;
      // On-demand starts at `offset=now`, so 0 historical rows were downloaded upfront!
      const beforeSubset = await clientDb.query<{ CNT: number }>(
        'SELECT COUNT(*) AS CNT FROM "TASKS"',
      );
      expect(Number(beforeSubset.rows[0]?.CNT ?? 0)).toBe(0);

      // Hydrate only top-2 HIGH priority rows on demand!
      const hydrated = await sync.requestSubset({
        where: "priority = 'HIGH'",
        orderBy: 'score DESC',
        limit: 2,
      });
      expect(hydrated.appliedRows).toBe(2);

      const afterSubset = await clientDb.query<{ ID: number; TITLE: string }>(
        'SELECT ID, TITLE FROM "TASKS" ORDER BY ID ASC',
      );
      expect(afterSubset.rows).toEqual([
        { ID: 2, TITLE: 'High-2' },
        { ID: 4, TITLE: 'High-4' },
      ]);

      // Live commit after `offset=now` streams into `clientDb` automatically!
      await sourceDb.execute(
        "INSERT INTO TASKS (ID, TITLE, PRIORITY, SCORE) VALUES (6, 'Live-6', 'HIGH', 100)",
      );
      shapeSrv.notifyChanges();

      const waitDeadline = Date.now() + 3_000;
      let countNow = 2;
      while (countNow < 3 && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 30));
        const r = await clientDb.query<{ CNT: number }>('SELECT COUNT(*) AS CNT FROM "TASKS"');
        countNow = Number(r.rows[0]?.CNT ?? 0);
      }
      expect(countNow).toBe(3);

      // Additive column evolution via `ensureTableFromElectricSchema`
      const evolved = await ensureTableFromElectricSchema(
        clientDb,
        'tasks',
        {
          id: { type: 'int4', pk_index: 0, not_null: true },
          title: { type: 'varchar', max_length: 64 },
          priority: { type: 'varchar', max_length: 16 },
          score: { type: 'int4' },
          assignee: { type: 'varchar', max_length: 48 },
        },
        { migrateColumns: true },
      );
      expect(evolved.addedColumns).toEqual(['ASSIGNEE']);

      await sync.unsubscribe();
      await shapeSrv.close();
    } finally {
      await sourceDb.close();
      await clientDb.close();
    }
  });

  it('M31 Item 3: propagates relational subquery WHERE move-in / move-out changes and captures exact replica=full old_value diffs', async () => {
    const db = new FirebirdBrowser('memory://m31-subquery-moves', { autoPersist: false });
    try {
      await db.execute(
        'CREATE TABLE PROJECTS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(64) NOT NULL, ACTIVE BOOLEAN NOT NULL)',
      );
      await db.execute(
        'CREATE TABLE ISSUES (ID INTEGER NOT NULL PRIMARY KEY, PROJECT_ID INTEGER NOT NULL, TITLE VARCHAR(64) NOT NULL)',
      );

      await db.execBatch('INSERT INTO PROJECTS (ID, NAME, ACTIVE) VALUES (?, ?, ?)', [
        [1, 'Core Engine', true],
        [2, 'Legacy Plugin', false],
      ]);
      await db.execBatch('INSERT INTO ISSUES (ID, PROJECT_ID, TITLE) VALUES (?, ?, ?)', [
        [101, 1, 'Optimize WAL'],
        [102, 1, 'Add GIN Index'],
        [201, 2, 'Archive Old Docs'],
      ]);

      const shapeSrv = await createWasmShapeServer(db, {
        tables: ['PROJECTS', 'ISSUES'],
      });

      const whereEnc = encodeURIComponent(
        'project_id IN (SELECT id FROM projects WHERE active = true)',
      );
      const snapRes = await shapeSrv.fetch(
        new Request(
          `http://shape.local/v1/shape?table=issues&offset=-1&where=${whereEnc}&replica=full`,
        ),
      );
      expect(snapRes.status).toBe(200);
      const handle = snapRes.headers.get('electric-handle')!;
      const off0 = snapRes.headers.get('electric-offset')!;
      const snapMsgs = (await snapRes.json()) as Array<{ value?: { id: string } }>;
      // Only project #1's issues (101, 102) + up-to-date
      expect(snapMsgs.filter((m) => m.value).map((m) => m.value!.id)).toEqual(['101', '102']);

      // 1. Activate project #2 (`ACTIVE = FALSE -> TRUE`) without touching `ISSUES` -> synthetic `move_in` insert!
      await db.execute('UPDATE PROJECTS SET ACTIVE = TRUE WHERE ID = 2');
      const moveInRes = await shapeSrv.fetch(
        new Request(
          `http://shape.local/v1/shape?table=issues&offset=${off0}&handle=${handle}&where=${whereEnc}&replica=full`,
        ),
      );
      const off1 = moveInRes.headers.get('electric-offset')!;
      const moveInMsgs = (await moveInRes.json()) as Array<{
        value?: { id: string; title: string };
        headers: { operation?: string; move_in?: boolean };
      }>;
      const movedIn = moveInMsgs.find((m) => m.headers.move_in === true);
      expect(movedIn).toBeDefined();
      expect(movedIn?.headers.operation).toBe('insert');
      expect(movedIn?.value).toMatchObject({ id: '201', title: 'Archive Old Docs' });

      // 2. Deactivate project #1 (`ACTIVE = TRUE -> FALSE`) -> synthetic `move_out` deletes with `old_value`!
      await db.execute('UPDATE PROJECTS SET ACTIVE = FALSE WHERE ID = 1');
      const moveOutRes = await shapeSrv.fetch(
        new Request(
          `http://shape.local/v1/shape?table=issues&offset=${off1}&handle=${handle}&where=${whereEnc}&replica=full`,
        ),
      );
      const off2 = moveOutRes.headers.get('electric-offset')!;
      const moveOutMsgs = (await moveOutRes.json()) as Array<{
        value?: { id: string; title?: string };
        old_value?: { title?: string };
        headers: { operation?: string; move_out?: boolean };
      }>;
      const movedOut = moveOutMsgs.filter((m) => m.headers.move_out === true);
      expect(movedOut.map((m) => m.value?.id)).toEqual(['101', '102']);
      expect(movedOut[0]?.headers.operation).toBe('delete');
      expect(movedOut[0]?.old_value?.title).toBe('Optimize WAL');

      // 3. Direct row UPDATE & DELETE with `replica=full` -> exact changed `old_value`!
      await db.execute("UPDATE ISSUES SET TITLE = 'Archive v2 Docs' WHERE ID = 201");
      const updRes = await shapeSrv.fetch(
        new Request(
          `http://shape.local/v1/shape?table=issues&offset=${off2}&handle=${handle}&where=${whereEnc}&replica=full`,
        ),
      );
      const updMsgs = (await updRes.json()) as Array<{
        value?: { id: string; title: string };
        old_value?: { title?: string };
        headers: { operation?: string };
      }>;
      const updItem = updMsgs.find((m) => m.headers.operation === 'update');
      expect(updItem?.value?.title).toBe('Archive v2 Docs');
      expect(updItem?.old_value).toEqual({ title: 'Archive Old Docs' });

      await shapeSrv.close();
    } finally {
      await db.close();
    }
  });

  it('M31 Item 4: evaluates JSONB SQL UDRs + inverted GIN index (`createJsonGinIndex`) and pg_trgm fuzzy trigram search (`createTrigramIndex`)', async () => {
    expect(DEFAULT_JSON_GIN_TABLE).toBe('FB_JSON_GIN$');
    expect(DEFAULT_TRIGRAM_INDEX_TABLE).toBe('FB_TRGM_INDEX$');
    expect(jsonExtractValue('{"plan":{"tier":"pro"}}', '$.plan.tier')).toBe('pro');
    expect(jsonExtractQuery('{"tags":["eu","gdpr"]}', '$.tags')).toBe('["eu","gdpr"]');
    expect(jsonContains('{"role":"admin","tags":["eu","soc2"]}', '{"tags":["eu"]}')).toBe(true);
    expect(jsonHasKey('{"stripeId":"cus_1","ok":true}', 'stripeId')).toBe(true);
    expect(jsonSetPath('{"a":{"b":1}}', '$.a.b', '42')).toBe('{"a":{"b":42}}');
    expect(jsonStripNulls('{"a":1,"b":null,"arr":[null,2]}')).toBe('{"a":1,"arr":[null,2]}');
    expect(jsonTypeof('[1,2,3]')).toBe('array');

    expect(extractTrigrams('postgres')).toContain('  p');
    expect(trigramSimilarity('postgresql', 'postgrsql')).toBeGreaterThan(0.5);
    expect(wordSimilarity('firebird', 'embedded firebrd wasm engine')).toBeGreaterThan(0.45);
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);

    const db = new FirebirdBrowser('memory://m31-jsonb-trgm', { autoPersist: false });
    try {
      await db.execute(
        'CREATE TABLE PROFILES (ID INTEGER NOT NULL PRIMARY KEY, DOC_JSON VARCHAR(2048) NOT NULL, BIO VARCHAR(512) NOT NULL)',
      );
      await db.execBatch('INSERT INTO PROFILES (ID, DOC_JSON, BIO) VALUES (?, ?, ?)', [
        [
          1,
          JSON.stringify({ role: 'admin', region: 'eu', tags: ['replication', 'wasm'], plan: { tier: 'enterprise' } }),
          'PostgreSQL ElectricSQL Shape Sync Architect',
        ],
        [
          2,
          JSON.stringify({ role: 'member', region: 'us', tags: ['graphql'], plan: { tier: 'pro' } }),
          'Firebird Embedded WebAssembly Engine Developer',
        ],
        [
          3,
          JSON.stringify({ role: 'admin', region: 'apac', tags: ['wasm', 'fts'], plan: { tier: 'enterprise' } }),
          'Distributed Vector Search and Hybrid GraphRAG Engineer',
        ],
      ]);

      await registerJsonbFunctions(db);
      await registerTrigramFunctions(db);

      // SQL UDR verification
      const udrRes = await db.query<{ TIER: string; IS_ADMIN: number; SIM: number; DIST: number }>(
        `SELECT
           JSON_VALUE(DOC_JSON, '$.plan.tier') AS TIER,
           JSON_CONTAINS(DOC_JSON, '{"role":"admin"}') AS IS_ADMIN,
           SIMILARITY(BIO, 'Postgresql ElectrcSql') AS SIM,
           LEVENSHTEIN('firebird', 'firebrd') AS DIST
         FROM PROFILES WHERE ID = 1`,
      );
      expect(udrRes.rows[0]?.TIER).toBe('enterprise');
      expect(Number(udrRes.rows[0]?.IS_ADMIN)).toBe(1);
      expect(Number(udrRes.rows[0]?.SIM)).toBeGreaterThan(0.35);
      expect(Number(udrRes.rows[0]?.DIST)).toBe(1);

      // Persistent Inverted JSONB GIN Index + autoSync
      const gin = await createJsonGinIndex(db, {
        table: 'PROFILES',
        column: 'DOC_JSON',
        keyColumn: 'ID',
        autoSync: true,
      });

      const adminWasm = await gin.contains({ role: 'admin', tags: ['wasm'] });
      expect(adminWasm.map((h) => Number(h.key)).sort()).toEqual([1, 3]);

      const proTier = await gin.pathEquals('$.plan.tier', 'pro');
      expect(proTier.map((h) => Number(h.key))).toEqual([2]);

      await db.execute(
        'INSERT INTO PROFILES (ID, DOC_JSON, BIO) VALUES (?, ?, ?)',
        [4, JSON.stringify({ role: 'admin', tags: ['wasm', 'edge'], stripeKey: 'sk_live' }), 'Cloudflare Edge SQL Worker'],
      );
      const hasStripe = await gin.hasKey('stripeKey');
      expect(hasStripe.map((h) => Number(h.key))).toEqual([4]);

      const persistedGin = await fetchPersistedJsonGinIndexes(db);
      expect(persistedGin[0]?.docCount).toBe(4);

      // Persistent pg_trgm Fuzzy Trigram Index
      const trgm = await createTrigramIndex(db, {
        table: 'PROFILES',
        column: 'BIO',
        keyColumn: 'ID',
        threshold: 0.15,
      });
      const fuzzyHits = await trgm.search('Firbird WebAssmbly Engin', { limit: 2 });
      expect(Number(fuzzyHits[0]?.key)).toBe(2);

      const subHits = await trgm.search('GraphRAG', { mode: 'substring' });
      expect(subHits.map((h) => Number(h.key))).toEqual([3]);

      const persistedTrgm = await fetchPersistedTrigramIndexes(db);
      expect(persistedTrgm[0]?.docCount).toBe(4);

      gin.dispose();
      trgm.dispose();
    } finally {
      await db.close();
    }
  });

  it('M31 Item 5: executes Prisma Driver Adapter `$1..$n` queries & interactive transactions (`createFirebirdPrismaAdapter`) + monotonic UUIDv7 & ULID', async () => {
    const u1 = uuidv7(1_700_000_000_000);
    const u2 = uuidv7(1_700_000_000_000);
    expect(u1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(u1 < u2).toBe(true);

    const l1 = ulid(1_700_000_000_000);
    const l2 = ulid(1_700_000_000_000);
    expect(l1).toHaveLength(26);
    expect(l1 < l2).toBe(true);

    const db = new FirebirdBrowser('memory://m31-prisma-adapter', { autoPersist: false });
    try {
      await registerIdFunctions(db);
      const idRes = await db.query<{ U: string; L: string }>(
        'SELECT GEN_UUID_V7() AS U, GEN_ULID() AS L FROM RDB$DATABASE',
      );
      expect(idRes.rows[0]?.U).toHaveLength(36);
      expect(idRes.rows[0]?.L).toHaveLength(26);

      const prismaAdapter = await createFirebirdPrismaAdapter(db).connect();
      expect(prismaAdapter.provider).toBe('postgres');
      expect(prismaAdapter.adapterName).toBe('firebird-wasm/prisma');

      await prismaAdapter.executeScript(
        'CREATE TABLE USERS (ID VARCHAR(36) NOT NULL PRIMARY KEY, EMAIL VARCHAR(80) NOT NULL, CREDITS INTEGER NOT NULL);',
      );
      const affected = await prismaAdapter.executeRaw({
        sql: 'INSERT INTO "USERS" ("ID", "EMAIL", "CREDITS") VALUES ($1, $2, $3)',
        args: [u1, 'ada@electric.local', 100],
      });
      expect(affected).toBe(1);

      // Interactive Prisma transaction: commit + rollback
      const tx1 = await prismaAdapter.startTransaction('READ COMMITTED');
      expect(tx1.options.usePhantomQuery).toBe(false);
      await tx1.executeRaw({
        sql: 'UPDATE "USERS" SET "CREDITS" = $1 WHERE "ID" = $2',
        args: [250, u1],
      });
      await tx1.commit();

      const tx2 = await prismaAdapter.startTransaction('REPEATABLE READ');
      await tx2.executeRaw({
        sql: 'UPDATE "USERS" SET "CREDITS" = $1 WHERE "ID" = $2',
        args: [999, u1],
      });
      await tx2.rollback();

      const raw = await prismaAdapter.queryRaw({
        sql: 'SELECT "EMAIL", "CREDITS" FROM "USERS" WHERE "ID" = $1',
        args: [u1],
      });
      expect(raw.columnNames).toEqual(['EMAIL', 'CREDITS']);
      expect(raw.rows).toEqual([['ada@electric.local', 250]]);

      await prismaAdapter.dispose();
    } finally {
      await db.close();
    }
  });
});
