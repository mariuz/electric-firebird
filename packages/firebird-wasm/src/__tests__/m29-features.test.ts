/**
 * M29 Feature Suite:
 * 1. Time-Series Hypertable Policies, Gap-Filling & LTTB Downsampling (`createTimeSeriesStore`, `lttbDownsample`, `registerTimeSeriesFunctions`)
 * 2. 2D Spatial R-Tree Index, GeoJSON / WKT & Geodesic Search (`createSpatialIndex`, `RTreeIndex`, `registerSpatialFunctions`)
 * 3. CloudEvents v1.0 Change-Data-Capture (CDC) & Signed Webhook Sink (`createChangeStreamSink`, `createHttpWebhookSink`, CLI `cdc-sink`)
 * 4. WinterCG Edge SQL Gateway & Key-Value Page VFS (`createEdgeSqlGateway`, `KeyValuePageVFS`)
 * 5. Sub-1,100-Line Source File Modularity Invariant across `packages/firebird-wasm/src`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CDC_DLQ_TABLE,
  DEFAULT_CDC_OFFSETS_TABLE,
  DEFAULT_SPATIAL_INDEX_TABLE,
  DEFAULT_TS_POLICIES_TABLE,
  FirebirdBrowser,
  KeyValuePageVFS,
  RTreeIndex,
  createChangeStreamSink,
  createEdgeSqlGateway,
  createHttpWebhookSink,
  createPublication,
  createSpatialIndex,
  createTimeSeriesStore,
  decodeArrowIpc,
  fillTimeGaps,
  floorToBucket,
  haversineDistanceMeters,
  lttbDownsample,
  parseBucketIntervalMs,
  parseGeoGeometry,
  pointInPolygon,
  polygonAreaSqMeters,
  registerSpatialFunctions,
  registerTimeSeriesFunctions,
  signSyncJwt,
  signWebhookPayload,
  toCloudEvent,
  toGeoJson,
  toWkt,
  verifyWebhookSignature,
} from '../browser';
import { runCli } from '../cli';

describe('M29: Time-Series Store & LTTB, 2D Spatial R-Tree, CloudEvents CDC Sink, WinterCG Edge SQL Gateway & Sub-1,100-Line Modularity', () => {
  it('enforces strict < 1,100-line source modularity across every non-test .ts file in src/', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const oversized: string[] = [];

    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== '__tests__') walk(full);
        } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
          const lineCount = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
          if (lineCount >= 1100) {
            oversized.push(`${path.relative(srcRoot, full)} (${lineCount} lines)`);
          }
        }
      }
    };

    walk(srcRoot);
    expect(oversized).toEqual([]);
  });

  it('M29 Item 1: parses durations, fills time gaps (locf & linear), preserves peaks via LTTB, runs continuous rollups + retention, and evaluates TS_BUCKET SQL UDR', async () => {
    expect(parseBucketIntervalMs('500ms')).toBe(500);
    expect(parseBucketIntervalMs('10s')).toBe(10_000);
    expect(parseBucketIntervalMs('5m')).toBe(300_000);
    expect(parseBucketIntervalMs('2h')).toBe(7_200_000);
    expect(parseBucketIntervalMs('1d')).toBe(86_400_000);
    expect(floorToBucket(65_432, 10_000)).toBe(60_000);

    // Peak-preserving LTTB visual downsampling
    const rawSeries = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i * 1_000,
      value: i === 47 ? 500 : i === 73 ? -250 : Math.sin(i / 8) * 10,
    }));
    const downsampled = lttbDownsample(rawSeries, 14);
    expect(downsampled).toHaveLength(14);
    expect(downsampled[0]).toEqual(rawSeries[0]);
    expect(downsampled[downsampled.length - 1]).toEqual(rawSeries[rawSeries.length - 1]);
    expect(downsampled.some((p) => p.value === 500)).toBe(true);
    expect(downsampled.some((p) => p.value === -250)).toBe(true);

    // Standalone fillTimeGaps linear interpolation
    const linearFilled = fillTimeGaps(
      [
        {
          bucketMs: 0,
          count: 1,
          min: 10,
          max: 10,
          avg: 10,
          sum: 10,
          first: 10,
          last: 10,
          interpolated: false,
        },
        {
          bucketMs: 30_000,
          count: 1,
          min: 40,
          max: 40,
          avg: 40,
          sum: 40,
          first: 40,
          last: 40,
          interpolated: false,
        },
      ],
      {
        startMs: 0,
        endMs: 30_000,
        bucketMs: 10_000,
        mode: 'linear',
      },
    );
    expect(linearFilled).toHaveLength(4);
    expect(linearFilled[1]!.interpolated).toBe(true);
    expect(linearFilled[1]!.avg).toBeCloseTo(20, 5);
    expect(linearFilled[2]!.avg).toBeCloseTo(30, 5);

    const db = new FirebirdBrowser('memory://m29-timeseries', { autoPersist: false });
    try {
      await db.execute(
        `CREATE TABLE CPU_SAMPLES (
          ID INTEGER NOT NULL PRIMARY KEY,
          TS_MS BIGINT NOT NULL,
          UTIL DOUBLE PRECISION NOT NULL
        )`,
      );
      await db.execute('INSERT INTO CPU_SAMPLES VALUES (1, 10000, 20.0)');
      await db.execute('INSERT INTO CPU_SAMPLES VALUES (2, 14000, 40.0)');
      await db.execute('INSERT INTO CPU_SAMPLES VALUES (3, 42000, 80.0)');

      const ts = createTimeSeriesStore(db);
      expect((await ts.listPolicies()).length).toBe(0);

      // Bucket query with LOCF gap-filling (buckets 10000, 20000, 30000, 40000)
      const locfRows = await ts.bucketQuery({
        table: 'CPU_SAMPLES',
        timeColumn: 'TS_MS',
        valueColumn: 'UTIL',
        bucket: '10s',
        startMs: 10_000,
        endMs: 45_000,
        gapFill: 'locf',
      });
      expect(locfRows.map((r) => r.bucketMs)).toEqual([10_000, 20_000, 30_000, 40_000]);
      expect(locfRows[0]!.first).toBe(20);
      expect(locfRows[0]!.last).toBe(40);
      expect(locfRows[1]!.interpolated).toBe(true);
      expect(locfRows[1]!.last).toBe(40);
      expect(locfRows[3]!.avg).toBe(80);

      // Continuous rollup policy + incremental refresh + sliding-window retention
      const pol = await ts.registerPolicy({
        name: 'cpu_10s_rollup',
        table: 'CPU_SAMPLES',
        timeColumn: 'TS_MS',
        valueColumn: 'UTIL',
        rollupTable: 'CPU_ROLLUP_10S',
        bucketInterval: '10s',
        retention: '25s',
      });
      expect(pol.bucketMs).toBe(10_000);
      expect(pol.retentionMs).toBe(25_000);
      expect(ts.policiesTable).toBe(DEFAULT_TS_POLICIES_TABLE);

      const r1 = await ts.refreshRollup('cpu_10s_rollup');
      expect(r1.bucketsUpserted).toBe(2);
      expect(r1.maxTimestamp).toBe(40_000);

      await db.execute('INSERT INTO CPU_SAMPLES VALUES (4, 53000, 95.0)');
      const r2 = await ts.refreshRollup('cpu_10s_rollup');
      expect(r2.bucketsUpserted).toBeGreaterThanOrEqual(1);
      expect(r2.maxTimestamp).toBe(50_000);

      const rollupRes = await db.query<{ BUCKET_START: string | number; AVG_VAL: number }>(
        'SELECT BUCKET_START, AVG_VAL FROM CPU_ROLLUP_10S ORDER BY BUCKET_START ASC',
      );
      expect(rollupRes.rows.map((r) => Number(r.BUCKET_START))).toEqual([10_000, 40_000, 50_000]);

      const ret = await ts.applyRetention('cpu_10s_rollup', 50_000);
      expect(ret.deletedRows).toBe(2); // 10000 and 14000 < (50000 - 25000 = 25000)

      // SQL UDR `TS_BUCKET`
      await registerTimeSeriesFunctions(db);
      const udrRes = await db.query<{ B: string | number }>(
        'SELECT TS_BUCKET(TS_MS, 10000) AS B FROM CPU_SAMPLES ORDER BY TS_MS ASC',
      );
      expect(udrRes.rows.map((r) => Number(r.B))).toEqual([40_000, 50_000]);
    } finally {
      await db.close();
    }
  });

  it('M29 Item 2: indexes WKT & GeoJSON geometries in persistent 2D R-Tree (FB_SPATIAL_INDEX$), runs Haversine kNN/radius & hole-aware polygon checks, auto-syncs mutations, and evaluates ST_* SQL UDRs', async () => {
    const pt = parseGeoGeometry('POINT(26.1025 44.4268)');
    expect(JSON.parse(toGeoJson(pt))).toEqual({ type: 'Point', coordinates: [26.1025, 44.4268] });
    expect(toWkt(pt)).toBe('POINT (26.1025 44.4268)');

    // Polygon with interior hole (courtyard excluded)
    const donut = parseGeoGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [3, 3],
          [7, 3],
          [7, 7],
          [3, 7],
          [3, 3],
        ],
      ],
    });
    expect(pointInPolygon(1, 1, donut)).toBe(true);
    expect(pointInPolygon(5, 5, donut)).toBe(false); // inside hole!
    expect(pointInPolygon(12, 5, donut)).toBe(false);
    expect(polygonAreaSqMeters(donut)).toBeGreaterThan(0);

    // Haversine Bucharest -> Cluj (~324 km)
    const distBucharestCluj = haversineDistanceMeters(26.1025, 44.4268, 23.6236, 46.7712);
    expect(distBucharestCluj).toBeGreaterThan(300_000);
    expect(distBucharestCluj).toBeLessThan(350_000);

    // Standalone RTreeIndex
    const memTree = new RTreeIndex<string>();
    memTree.insert('a', pt);
    expect(memTree.size).toBe(1);

    const db = new FirebirdBrowser('memory://m29-spatial', { autoPersist: false });
    try {
      await db.execute(
        `CREATE TABLE PLACES (
          ID INTEGER NOT NULL PRIMARY KEY,
          NAME VARCHAR(64) NOT NULL,
          CATEGORY VARCHAR(32) NOT NULL,
          GEOM VARCHAR(512) NOT NULL
        )`,
      );
      await db.execute(
        "INSERT INTO PLACES VALUES (1, 'University Square', 'landmark', 'POINT(26.1025 44.4355)')",
      );
      await db.execute(
        "INSERT INTO PLACES VALUES (2, 'Herastrau Park', 'park', 'POINT(26.0778 44.4708)')",
      );
      await db.execute(
        "INSERT INTO PLACES VALUES (3, 'Cluj Union Square', 'landmark', 'POINT(23.5899 46.7694)')",
      );

      const sp1 = await createSpatialIndex<number>(db, {
        table: 'PLACES',
        column: 'GEOM',
        keyColumn: 'ID',
        autoSync: true,
      });
      expect(sp1.size).toBe(3);

      // Verify persisted in FB_SPATIAL_INDEX$ and reloadable without scanning table
      const catCheck = await db.query<{ ITEM_COUNT: number }>(
        `SELECT ITEM_COUNT FROM "${DEFAULT_SPATIAL_INDEX_TABLE}"`,
      );
      expect(Number(catCheck.rows[0]?.ITEM_COUNT)).toBe(3);

      // Auto-sync live INSERT
      await db.execute(
        "INSERT INTO PLACES VALUES (4, 'Old Town Cafe', 'cafe', '{\"type\":\"Point\",\"coordinates\":[26.1012,44.4314]}')",
      );
      const nearBucharest = await sp1.withinRadius<{ ID: number; NAME: string }>(
        26.102,
        44.433,
        1_500,
      );
      expect(nearBucharest.map((r) => r.NAME.trim())).toEqual([
        'Old Town Cafe',
        'University Square',
      ]);

      const knnLandmarks = await sp1.knnSearch<{ ID: number; NAME: string }>(26.102, 44.433, {
        k: 2,
        where: "CATEGORY = 'landmark'",
      });
      expect(knnLandmarks.map((r) => r.NAME.trim())).toEqual([
        'University Square',
        'Cluj Union Square',
      ]);

      const bboxHits = await sp1.bboxSearch<{ ID: number; NAME: string }>([26.0, 44.4, 26.2, 44.5]);
      expect(bboxHits).toHaveLength(3);
      sp1.dispose();

      // Reload from persisted FB_SPATIAL_INDEX$
      const spReloaded = await createSpatialIndex<number>(db, {
        table: 'PLACES',
        column: 'GEOM',
        keyColumn: 'ID',
      });
      expect(spReloaded.size).toBe(4);
      spReloaded.dispose();

      // OGC Spatial SQL UDRs
      await registerSpatialFunctions(db);
      const udr = await db.query<{
        IN_RADIUS: number;
        CONTAINS_PT: number;
        INTERSECTS_BOX: number;
        GEO: string;
      }>(
        `SELECT
           ST_DWITHIN('POINT(26.1025 44.4355)', 'POINT(26.1012 44.4314)', 1000.0) AS IN_RADIUS,
           ST_CONTAINS('POLYGON((26.0 44.4, 26.2 44.4, 26.2 44.5, 26.0 44.5, 26.0 44.4))', GEOM) AS CONTAINS_PT,
           ST_INTERSECTS('LINESTRING(26.0 44.4, 26.2 44.5)', 'POLYGON((26.05 44.42, 26.15 44.42, 26.15 44.48, 26.05 44.48, 26.05 44.42))') AS INTERSECTS_BOX,
           ST_ASGEOJSON(GEOM) AS GEO
         FROM PLACES WHERE ID = 1`,
      );
      expect(Number(udr.rows[0]?.IN_RADIUS)).toBe(1);
      expect(Number(udr.rows[0]?.CONTAINS_PT)).toBe(1);
      expect(Number(udr.rows[0]?.INTERSECTS_BOX)).toBe(1);
      expect(JSON.parse(String(udr.rows[0]?.GEO)).type).toBe('Point');
    } finally {
      await db.close();
    }
  });

  it('M29 Item 3: streams CloudEvents v1.0 & Arrow IPC CDC batches with HMAC-SHA256 webhook signatures, durable FB_CDC_OFFSETS$, FB_CDC_DLQ$ quarantine, and CLI cdc-sink', async () => {
    const sampleEvt = toCloudEvent(
      {
        lsn: 7,
        txid: 'tx-7',
        origin: 'node-eu',
        publication: 'pub_orders',
        table: 'ORDERS',
        operation: 'INSERT',
        key: { ID: 42 },
        before: null,
        after: { ID: 42, TOTAL: 199 },
        timestamp: 1_700_000_000_000,
      },
      { source: 'urn:firebird:prod' },
    );
    expect(sampleEvt.specversion).toBe('1.0');
    expect(sampleEvt.type).toBe('org.firebirdsql.cdc.insert');
    expect(sampleEvt.subject).toBe('ORDERS/42');

    // HMAC-SHA256 webhook signature & tamper detection
    const bodyText = JSON.stringify([sampleEvt]);
    const sig = await signWebhookPayload(bodyText, 'whsec_test_key', 1_700_000_000);
    expect(
      await verifyWebhookSignature(bodyText, sig.signatureHeader, 'whsec_test_key', {
        nowSec: 1_700_000_120,
      }),
    ).toBe(true);
    expect(
      await verifyWebhookSignature(bodyText + ' ', sig.signatureHeader, 'whsec_test_key', {
        nowSec: 1_700_000_120,
      }),
    ).toBe(false);
    expect(
      await verifyWebhookSignature(bodyText, sig.signatureHeader, 'whsec_test_key', {
        nowSec: 1_700_001_000, // expired beyond 300s tolerance
      }),
    ).toBe(false);

    const db = new FirebirdBrowser('memory://m29-cdc', { autoPersist: false });
    try {
      await db.execute(
        'CREATE TABLE ORDERS (ID INTEGER NOT NULL PRIMARY KEY, AMOUNT INTEGER NOT NULL)',
      );
      await createPublication(db, {
        name: 'pub_cdc',
        nodeId: 'primary-1',
        tables: [{ table: 'ORDERS', primaryKey: 'ID' }],
        installTriggers: true,
      });

      await db.execute('INSERT INTO ORDERS VALUES (101, 500)');
      await db.execute('UPDATE ORDERS SET AMOUNT = 750 WHERE ID = 101');

      const deliveries: Array<{ headers: Headers; bodyText?: string; arrowRows?: number }> = [];
      const webhookSink = createHttpWebhookSink({
        url: 'https://hooks.acme.test/cdc',
        secret: 'whsec_live',
        format: 'cloudevents-json',
        fetchImpl: async (_url, init) => {
          const hdrs = new Headers(init?.headers);
          const rawBody = String(init?.body ?? '');
          const ok = await verifyWebhookSignature(
            rawBody,
            hdrs.get('x-firebird-signature') ?? '',
            'whsec_live',
          );
          if (!ok) return new Response('bad signature', { status: 401 });
          deliveries.push({ headers: hdrs, bodyText: rawBody });
          return new Response('ok', { status: 200 });
        },
      });

      const sink = createChangeStreamSink(db, {
        sinkId: 'billing_webhook',
        sink: webhookSink,
      });
      const r1 = await sink.flushOnce();
      expect(r1.deliveredEvents).toBe(2);
      expect(r1.quarantined).toBe(false);
      expect(deliveries).toHaveLength(1);
      const parsedEvents = JSON.parse(deliveries[0]!.bodyText!);
      expect(parsedEvents).toHaveLength(2);
      expect(parsedEvents[0].type).toBe('org.firebirdsql.cdc.insert');
      expect(parsedEvents[1].type).toBe('org.firebirdsql.cdc.update');

      // Durable FB_CDC_OFFSETS$ prevents duplicate delivery on subsequent poll
      const offsetAfter = await sink.getOffset();
      expect(offsetAfter).toBeGreaterThanOrEqual(2);
      expect((await sink.flushOnce()).deliveredEvents).toBe(0);

      // Rewind to LSN 0 and deliver as Apache Arrow IPC stream
      await sink.rewind(0);
      let arrowByteLen = 0;
      const arrowSink = createChangeStreamSink(db, {
        sinkId: 'billing_webhook',
        sink: createHttpWebhookSink({
          url: 'https://hooks.acme.test/arrow',
          format: 'arrow-ipc',
          fetchImpl: async (_u, init) => {
            const bytes = init?.body as Uint8Array;
            arrowByteLen = bytes.byteLength;
            const decoded = decodeArrowIpc(bytes);
            expect(decoded.rowCount).toBe(2);
            return new Response('ok', { status: 200 });
          },
        }),
      });
      await arrowSink.flushOnce();
      expect(arrowByteLen).toBeGreaterThan(64);

      // Poison sink -> retries & quarantines into FB_CDC_DLQ$
      await db.execute('INSERT INTO ORDERS VALUES (102, 900)');
      const poisonSink = createChangeStreamSink(db, {
        sinkId: 'poison_sink',
        maxRetries: 1,
        backoffBaseMs: 5,
        sink: async () => {
          throw new Error('downstream 503');
        },
      });
      const rPoison = await poisonSink.flushOnce();
      expect(rPoison.quarantined).toBe(true);
      const dlq = await poisonSink.listDlq();
      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.error).toContain('downstream 503');

      const tbls = await db.query<{ R: string }>(
        `SELECT TRIM(RDB$RELATION_NAME) AS R FROM RDB$RELATIONS
         WHERE TRIM(RDB$RELATION_NAME) IN ('${DEFAULT_CDC_OFFSETS_TABLE}', '${DEFAULT_CDC_DLQ_TABLE}')`,
      );
      expect(tbls.rows).toHaveLength(2);
    } finally {
      await db.close();
    }

    // CLI `cdc-sink --once` test on a temp `.fdb`
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-m29-cdc-'));
    const fdbPath = path.join(tmpDir, 'cdc.fdb');
    try {
      await runCli(['query', fdbPath, 'CREATE TABLE ITEMS (ID INTEGER NOT NULL PRIMARY KEY)']);
      const logs: string[] = [];
      const code = await runCli(
        [
          'cdc-sink',
          fdbPath,
          '--webhook',
          'https://hooks.acme.test/cdc',
          '--sink-id',
          'cli_test',
          '--json',
        ],
        { stdout: (s) => logs.push(s), stderr: (s) => logs.push(s) },
      );
      expect(code).toBe(0);
      expect(JSON.parse(logs.join('')).sinkId).toBe('cli_test');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('M29 Item 4: coalesces pages in KeyValuePageVFS and serves WinterCG Edge SQL Gateway (auth, readOnly/allowedTables firewall, ETag 304, Arrow IPC & atomic /batch rollback)', async () => {
    // 1. KeyValuePageVFS multi-page chunk coalescing & shrink cleanup
    const kvMap = new Map<string, Uint8Array>();
    let batchWriteCalls = 0;
    const store = {
      get: async (k: string) => kvMap.get(k) ?? null,
      put: async (k: string, v: Uint8Array) => {
        kvMap.set(k, v);
      },
      putBatch: async (entries: Readonly<Record<string, Uint8Array>>) => {
        batchWriteCalls++;
        for (const [k, v] of Object.entries(entries)) kvMap.set(k, v);
      },
      delete: async (k: string) => kvMap.delete(k),
    };

    const vfs = new KeyValuePageVFS(store, { pageSize: 4096, pagesPerChunk: 4 });
    await vfs.open();
    for (let p = 0; p < 6; p++) {
      const buf = new Uint8Array(4096);
      buf[0] = p + 10;
      buf[4095] = p + 20;
      await vfs.writePage(p, buf);
    }
    expect(vfs.dirtyChunkCount).toBe(2); // 6 pages across 4-page chunks -> 2 chunks
    const flushed = await vfs.flushDirtyPages();
    expect(flushed.chunksWritten).toBe(2);
    expect(batchWriteCalls).toBe(1);

    const exported = await vfs.exportDatabase();
    expect(exported.byteLength).toBe(6 * 4096);

    // Re-open in a fresh VFS instance over the same KV store
    const vfs2 = new KeyValuePageVFS(store, { pageSize: 4096, pagesPerChunk: 4 });
    await vfs2.open();
    expect(vfs2.pageCount).toBe(6);
    expect((await vfs2.readPage(5))[0]).toBe(15);

    // Shrink import deletes trailing chunk 1
    await vfs2.importDatabase(exported.subarray(0, 2 * 4096));
    expect(vfs2.pageCount).toBe(2);
    expect(kvMap.has('fb_vfs:chunk:00000001')).toBe(false);

    // 2. WinterCG Edge SQL Gateway (`createEdgeSqlGateway`)
    const db = new FirebirdBrowser('memory://m29-edge', { autoPersist: false });
    try {
      await db.execute(
        'CREATE TABLE PRODUCTS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(64), PRICE INTEGER)',
      );
      await db.execute('CREATE TABLE SECRETS (ID INTEGER NOT NULL PRIMARY KEY, TOKEN VARCHAR(64))');
      await db.execute("INSERT INTO PRODUCTS VALUES (1, 'Edge Router', 120)");
      await db.execute("INSERT INTO SECRETS VALUES (1, 'top-secret')");

      const jwtSecret = 'edge-hs256-secret-key-2026';
      const writerJwt = await signSyncJwt({ sub: 'svc-1', role: 'writer' }, jwtSecret);
      const readerJwt = await signSyncJwt({ sub: 'svc-read', role: 'reader' }, jwtSecret);

      const gateway = createEdgeSqlGateway(db, {
        jwtSecret,
        allowedTables: ['PRODUCTS'],
        cacheMaxAgeSec: 60,
      });

      // Health check requires no auth
      const healthRes = await gateway.fetch(new Request('https://edge.local/health'));
      expect(healthRes.status).toBe(200);
      expect((await healthRes.json()).ok).toBe(true);

      // Missing auth -> 401
      const unauthRes = await gateway.fetch(
        new Request('https://edge.local/query', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT * FROM PRODUCTS' }),
        }),
      );
      expect(unauthRes.status).toBe(401);

      // Allowed SELECT + ETag + 304 Not Modified
      const qRes = await gateway.fetch(
        new Request('https://edge.local/query', {
          method: 'POST',
          headers: { Authorization: `Bearer ${readerJwt}` },
          body: JSON.stringify({ sql: 'SELECT ID, NAME, PRICE FROM PRODUCTS WHERE ID = ?', params: [1] }),
        }),
      );
      expect(qRes.status).toBe(200);
      const etag = qRes.headers.get('etag');
      expect(etag).toBeTruthy();
      const qJson = await qRes.json();
      expect(qJson.rowCount).toBe(1);

      const cachedRes = await gateway.fetch(
        new Request('https://edge.local/query', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${readerJwt}`,
            'If-None-Match': etag!,
          },
          body: JSON.stringify({ sql: 'SELECT ID, NAME, PRICE FROM PRODUCTS WHERE ID = ?', params: [1] }),
        }),
      );
      expect(cachedRes.status).toBe(304);

      // SQL firewall: reader JWT cannot INSERT -> 403; disallowed table SECRETS -> 403
      const readerWriteRes = await gateway.fetch(
        new Request('https://edge.local/query', {
          method: 'POST',
          headers: { Authorization: `Bearer ${readerJwt}` },
          body: JSON.stringify({ sql: "INSERT INTO PRODUCTS VALUES (2, 'Switch', 80)" }),
        }),
      );
      expect(readerWriteRes.status).toBe(403);

      const secretTblRes = await gateway.fetch(
        new Request('https://edge.local/query', {
          method: 'POST',
          headers: { Authorization: `Bearer ${writerJwt}` },
          body: JSON.stringify({ sql: 'SELECT * FROM SECRETS' }),
        }),
      );
      expect(secretTblRes.status).toBe(403);

      // Arrow IPC streaming response
      const arrowRes = await gateway.fetch(
        new Request('https://edge.local/query', {
          method: 'POST',
          headers: { Authorization: `Bearer ${writerJwt}` },
          body: JSON.stringify({ sql: 'SELECT ID, PRICE FROM PRODUCTS', format: 'arrow' }),
        }),
      );
      expect(arrowRes.status).toBe(200);
      expect(arrowRes.headers.get('content-type')).toContain('application/vnd.apache.arrow.stream');
      const arrowDecoded = decodeArrowIpc(new Uint8Array(await arrowRes.arrayBuffer()));
      expect(arrowDecoded.rowCount).toBe(1);

      // Atomic POST /batch: rolls back statement #1 when statement #2 violates PK!
      const failedBatch = await gateway.fetch(
        new Request('https://edge.local/batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${writerJwt}` },
          body: JSON.stringify({
            statements: [
              { sql: "INSERT INTO PRODUCTS VALUES (2, 'Rolled Back Item', 99)" },
              { sql: "INSERT INTO PRODUCTS VALUES (1, 'Duplicate PK', 50)" },
            ],
          }),
        }),
      );
      expect(failedBatch.status).toBe(400);
      const countAfterRollback = await db.query<{ CNT: number }>(
        'SELECT COUNT(*) AS CNT FROM PRODUCTS',
      );
      expect(Number(countAfterRollback.rows[0]?.CNT)).toBe(1);

      // Successful atomic POST /batch
      const okBatch = await gateway.fetch(
        new Request('https://edge.local/batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${writerJwt}` },
          body: JSON.stringify({
            statements: [
              { sql: "INSERT INTO PRODUCTS VALUES (2, 'Edge Switch', 80)" },
              { sql: 'SELECT COUNT(*) AS CNT FROM PRODUCTS' },
            ],
          }),
        }),
      );
      expect(okBatch.status).toBe(200);
      const batchJson = await okBatch.json();
      expect(batchJson.results).toHaveLength(2);
      expect(Number(batchJson.results[1].rows[0].CNT)).toBe(2);
    } finally {
      await db.close();
    }
  });
});
