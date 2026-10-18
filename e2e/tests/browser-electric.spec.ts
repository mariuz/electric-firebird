/**
 * browser-electric.spec.ts – firebird-wasm/electric against a real Postgres
 * and a real Electric, into the real engine in Chromium.
 *
 * Needs both running (CI starts them as containers; see build-wasm.yml):
 *   ELECTRIC_URL  e.g. http://localhost:3000
 *   PG_URL        e.g. postgresql://postgres:pg@localhost:54321/postgres
 * and skips without them.  The test writes in Postgres and reads Firebird;
 * every test uses a table of its own, so shapes never carry over.
 *
 * The orderings a real server will not produce on demand (a failed
 * transaction, a must-refetch mid-batch) are unit-tested against a scripted
 * stream in packages/firebird-wasm/src/__tests__/electric.test.ts.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';

const ELECTRIC_URL = process.env['ELECTRIC_URL'];
const PG_URL = process.env['PG_URL'];
const ST_JS = path.resolve(__dirname, '../../packages/firebird-wasm/dist/wasm/firebird-embedded-st.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

let pg: Client;

async function sql(text: string): Promise<void> {
  await pg.query(text);
}

/** The shape's electric-schema header, as Electric reports it for `table`. */
async function schemaOf(table: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${ELECTRIC_URL}/v1/shape?table=${table}&offset=-1`);
  await response.arrayBuffer();
  return JSON.parse(response.headers.get('electric-schema')!);
}

async function openPage(page: Page): Promise<void> {
  await page.goto('/no-isolation/browser-harness-frameworks-st');
  await page.waitForFunction(() => Boolean((window as any).FB && (window as any).Frameworks));
}

/** Open `dbName`, create `table` from its shape's schema, and start syncing it. */
async function startSync(page: Page, dbName: string, table: string, create: boolean): Promise<void> {
  const schema = create ? await schemaOf(table) : null;
  await page.evaluate(async ({ dbName, table, schema, url }) => {
    const w = window as any;
    const db = new w.FB.FirebirdBrowser(dbName);
    if (schema) await db.exec(w.Frameworks.FBElectric.tableFromSchema(table, schema));
    w.db = db;
    w.sync = await w.Frameworks.FBElectric.syncShapeToTable(db, {
      shape: { url: `${url}/v1/shape`, params: { table } },
      table,
      shapeKey: table,
    });
    await w.sync.upToDate;
  }, { dbName, table, schema, url: ELECTRIC_URL });
}

/** Rows of a Firebird query, once `until` accepts them (the sync is asynchronous). */
async function rowsWhen(page: Page, query: string, until: (rows: any[]) => boolean): Promise<any[]> {
  let rows: any[] = [];
  await expect.poll(async () => {
    rows = await page.evaluate((q) => (window as any).db.query(q).then((r: any) => r.rows), query);
    return until(rows);
  }, { timeout: 20_000 }).toBe(true);
  return rows;
}

test.describe('firebird-wasm/electric with Postgres and Electric', () => {
  test.skip(!ELECTRIC_URL || !PG_URL, 'ELECTRIC_URL and PG_URL not set: no Electric to sync from');
  test.skip(!fs.existsSync(ST_JS), 'firebird-embedded-st not built');
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    pg = new Client({ connectionString: PG_URL });
    await pg.connect();
  });
  test.afterAll(async () => {
    await pg?.end();
  });

  test('copies every mapped type exactly', async ({ page }) => {
    const table = `types_${Date.now()}`;
    await sql(`CREATE TABLE ${table} (
      id integer PRIMARY KEY, small smallint, big bigint, price numeric(10,2), ratio double precision,
      title text, code varchar(8), done boolean, uid uuid, day date, at_time time, ts timestamp,
      tstz timestamptz, doc jsonb, tags text[], "camelCase" text, nothing text)`);
    await sql(`INSERT INTO ${table} VALUES (1, -2, 9007199254740993, 12.50, 0.1, 'it''s "x"', 'abc', true,
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2024-02-29', '13:45:01.5', '2024-05-01 12:00:00.123456',
      '2024-05-01 12:00:00+02', '{"a":[1,2]}', ARRAY['a','b,c'], 'cc', NULL)`);

    await openPage(page);
    await startSync(page, 'memory://electric-types', table, true);

    const rows = await rowsWhen(page,
      `SELECT id, small, big, price, ratio, title, code, done, uid, "DAY", at_time, ts,
         CAST(tstz AT TIME ZONE 'UTC' AS VARCHAR(40)) AS tstz, doc, tags, "camelCase", nothing FROM ${table}`,
      (r) => r.length === 1);
    expect(rows[0]).toMatchObject({
      ID: 1, SMALL: -2, PRICE: '12.50', RATIO: 0.1, TITLE: `it's "x"`, CODE: 'abc', DONE: true,
      UID: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', DOC: '{"a": [1, 2]}', TAGS: '["a","b,c"]',
      // Stored under its quoted name; the library upper-cases result names.
      CAMELCASE: 'cc', NOTHING: null,
    });
    expect(String(rows[0].BIG)).toBe('9007199254740993');
    expect(String(rows[0].DAY)).toContain('2024-02-29');
    expect(String(rows[0].AT_TIME)).toContain('13:45:01.5');
    expect(String(rows[0].TS)).toContain('12:00:00.1234');
    expect(rows[0].TSTZ).toMatch(/^2024-05-01 10:00:00\.0000 UTC$/);
  });

  test('follows inserts, updates and deletes as Postgres commits them', async ({ page }) => {
    const table = `live_${Date.now()}`;
    await sql(`CREATE TABLE ${table} (id integer PRIMARY KEY, title text, done boolean)`);
    await sql(`INSERT INTO ${table} VALUES (1, 'one', false), (2, 'two', false)`);

    await openPage(page);
    await startSync(page, 'memory://electric-live', table, true);
    await rowsWhen(page, `SELECT id FROM ${table}`, (r) => r.length === 2);

    // The sync posts an event per applied batch, which listen() and the hooks follow.
    await page.evaluate(async (t) => {
      const w = window as any;
      w.heard = 0;
      w.sub = await w.db.listen(`electric_${t}`, () => { w.heard++; }, { pollIntervalMs: 20 });
    }, table);

    await sql(`BEGIN; UPDATE ${table} SET done = true, title = 'ONE' WHERE id = 1;
      DELETE FROM ${table} WHERE id = 2; INSERT INTO ${table} VALUES (3, 'three', true); COMMIT`);
    const rows = await rowsWhen(page, `SELECT id, title, done FROM ${table} ORDER BY id`,
      (r) => r.length === 2 && r[1].ID === 3);
    expect(rows).toEqual([
      { ID: 1, TITLE: 'ONE', DONE: true },
      { ID: 3, TITLE: 'three', DONE: true },
    ]);
    await expect.poll(() => page.evaluate(() => (window as any).heard)).toBeGreaterThan(0);
  });

  test('resumes after a reload from where the stored database is', async ({ page }) => {
    const table = `resume_${Date.now()}`;
    const dbName = `electric-${table}`;
    await sql(`CREATE TABLE ${table} (id integer PRIMARY KEY, title text)`);
    await sql(`INSERT INTO ${table} VALUES (1, 'one')`);

    await openPage(page);
    await startSync(page, dbName, table, true);
    await rowsWhen(page, `SELECT id FROM ${table}`, (r) => r.length === 1);
    await page.evaluate(async () => {
      const w = window as any;
      await w.sync.unsubscribe();
      await w.db.close();
    });

    // Written while no page was syncing.
    await sql(`INSERT INTO ${table} VALUES (2, 'two')`);

    const requests: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/v1/shape')) requests.push(r.url()); });
    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).FB && (window as any).Frameworks));
    await startSync(page, dbName, table, false);
    // It asked for what followed the stored position, not for the shape again.
    const first = new URL(requests[0]!);
    expect(first.searchParams.get('offset')).not.toBe('-1');
    expect(first.searchParams.get('handle')).toBeTruthy();
    const rows = await rowsWhen(page, `SELECT id, title FROM ${table} ORDER BY id`, (r) => r.length === 2);
    expect(rows).toEqual([{ ID: 1, TITLE: 'one' }, { ID: 2, TITLE: 'two' }]);
    const stored = await page.evaluate(
      (t) => (window as any).db.query('SELECT shape_offset FROM electric_shapes WHERE shape_key = ?', [t])
        .then((r: any) => r.rows[0].SHAPE_OFFSET),
      table,
    );
    expect(stored).toMatch(/^\d+_\d+$/);
  });

  test('starts over when Postgres truncates the table (must-refetch)', async ({ page }) => {
    const table = `refetch_${Date.now()}`;
    await sql(`CREATE TABLE ${table} (id integer PRIMARY KEY, title text)`);
    await sql(`INSERT INTO ${table} VALUES (1, 'old'), (2, 'old')`);

    await openPage(page);
    await startSync(page, 'memory://electric-refetch', table, true);
    await rowsWhen(page, `SELECT id FROM ${table}`, (r) => r.length === 2);

    await sql(`TRUNCATE ${table}`);
    await sql(`INSERT INTO ${table} VALUES (9, 'new')`);
    const rows = await rowsWhen(page, `SELECT id, title FROM ${table}`,
      (r) => r.length === 1 && r[0].ID === 9);
    expect(rows).toEqual([{ ID: 9, TITLE: 'new' }]);
  });
});
