/**
 * browser-firebird-shapes.spec.ts – a table on a Firebird server, through
 * firebird-wasm/electric-server, into the Firebird engine in Chromium.
 *
 * The shape server runs here, in the test's Node process, against a real
 * Firebird server; the page syncs from it with the same syncShapeToTable it
 * would point at Electric.  Needs (CI starts a Firebird container; see
 * build-wasm.yml):
 *   FIREBIRD_SHAPES_HOST  e.g. localhost  (or localhost/3055 for another port)
 *   FIREBIRD_SHAPES_PASSWORD
 * and skips without them.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { FirebirdLite } from '../../packages/firebird-wasm/src/firebird';
import { createShapeServer } from '../../packages/firebird-wasm/src/electric-server';
import type { ShapeServer } from '../../packages/firebird-wasm/src/electric-server';

const HOST = process.env['FIREBIRD_SHAPES_HOST'];
const PASSWORD = process.env['FIREBIRD_SHAPES_PASSWORD'];
const ST_JS = path.resolve(__dirname, '../../packages/firebird-wasm/dist/wasm/firebird-embedded-st.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

let source: FirebirdLite;
let shapes: ShapeServer;
let httpServer: http.Server;
let url: string;

async function rowsWhen(page: Page, query: string, until: (rows: any[]) => boolean): Promise<any[]> {
  let rows: any[] = [];
  await expect.poll(async () => {
    rows = await page.evaluate((q) => (window as any).db.query(q).then((r: any) => r.rows), query);
    return until(rows);
  }, { timeout: 20_000 }).toBe(true);
  return rows;
}

test.describe('Firebird server → firebird-wasm/electric-server → Firebird in the browser', () => {
  test.skip(!HOST || PASSWORD === undefined, 'FIREBIRD_SHAPES_HOST and FIREBIRD_SHAPES_PASSWORD not set');
  test.skip(!fs.existsSync(ST_JS), 'firebird-embedded-st not built');
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    const credentials = { username: 'SYSDBA', password: PASSWORD! };
    const database = `${HOST}:/tmp/browser-shapes-${Date.now()}.fdb`;
    source = new FirebirdLite(database, credentials);
    await source.exec(
      'CREATE TABLE notes (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(60), body BLOB SUB_TYPE TEXT, ' +
        'price NUMERIC(10,2), done BOOLEAN, at_ TIMESTAMP)');
    await source.exec(
      "INSERT INTO notes VALUES (1, 'first', 'a body', 12.5, TRUE, '2024-05-01 12:00:00.1234')");
    shapes = await createShapeServer({ database, ...credentials, tables: ['notes'], pollIntervalMs: 50 });
    httpServer = http.createServer(shapes.handler);
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/v1/shape`;
  });

  test.afterAll(async () => {
    httpServer?.closeAllConnections?.();
    await new Promise((r) => httpServer?.close(r));
    await shapes?.close();
    await source?.close();
  });

  test('copies the table, then follows every commit on the server', async ({ page }) => {
    await page.goto('/no-isolation/browser-harness-frameworks-st');
    await page.waitForFunction(() => Boolean((window as any).FB && (window as any).Frameworks));
    const schema = JSON.parse((await fetch(`${url}?table=notes&offset=-1`)).headers.get('electric-schema')!);

    await page.evaluate(async ({ url, schema }) => {
      const w = window as any;
      const db = new w.FB.FirebirdBrowser('memory://from-a-firebird-server');
      await db.exec(w.Frameworks.FBElectric.tableFromSchema('notes', schema));
      w.db = db;
      w.sync = await w.Frameworks.FBElectric.syncShapeToTable(db, {
        shape: { url, params: { table: 'notes' } },
        table: 'notes',
        shapeKey: 'notes',
      });
      await w.sync.upToDate;
    }, { url, schema });

    const first = await rowsWhen(page,
      'SELECT id, title, body, CAST(price AS VARCHAR(20)) AS price, done, CAST(at_ AS VARCHAR(24)) AS at_ FROM notes',
      (r) => r.length === 1);
    expect(first).toEqual([{
      ID: 1, TITLE: 'first', BODY: 'a body', PRICE: '12.50', DONE: true, AT_: '2024-05-01 12:00:00.1234',
    }]);

    await source.transaction(async (tx) => {
      await tx.exec("INSERT INTO notes (id, title, body) VALUES (2, 'second', 'more')");
      await tx.exec("UPDATE notes SET title = 'FIRST', done = FALSE WHERE id = 1");
    });
    await source.exec("INSERT INTO notes (id, title) VALUES (3, 'gone soon')");
    await source.exec('DELETE FROM notes WHERE id = 3');

    const rows = await rowsWhen(page, 'SELECT id, title, body, done FROM notes ORDER BY id',
      (r) => r.length === 2 && r[0].TITLE === 'FIRST');
    expect(rows).toEqual([
      { ID: 1, TITLE: 'FIRST', BODY: 'a body', DONE: false },
      { ID: 2, TITLE: 'second', BODY: 'more', DONE: null },
    ]);
  });
});
