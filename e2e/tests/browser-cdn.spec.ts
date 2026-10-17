/**
 * browser-cdn.spec.ts – the engine loaded from another origin, as from a CDN.
 *
 * The test server's second listener (CDN_PORT, 3002) serves the artifacts with
 * the headers jsDelivr and unpkg send — Access-Control-Allow-Origin: * and
 * Cross-Origin-Resource-Policy: cross-origin — and counts what it served, so a
 * test can tell the engine came from there and not from the app's origin.
 *
 * What `cdnArtifacts()` promises is checked here: the glue from the CDN, its
 * `.wasm` from the CDN through `locateFile`, both builds, the threaded one
 * under cross-origin isolation (its own workers start from the app's Worker
 * script), and the one without threads with no isolation and even no Worker.
 */

import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WASM_DIR = path.resolve(__dirname, '../../packages/firebird-wasm/dist/wasm');
const built = (file: string) => fs.existsSync(path.join(WASM_DIR, file));
const CDN = 'http://localhost:3002';

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
  }
}

async function cdnHits(request: APIRequestContext): Promise<Record<string, number>> {
  return (await request.get(`${CDN}/hits`)).json() as Promise<Record<string, number>>;
}

async function openHarness(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await page.waitForFunction(() => Boolean(window.FB));
}

/** A round trip through a FirebirdBrowser whose engine Worker loads from the CDN. */
async function roundTripInWorker(page: Page, workerUrl: string, name: string): Promise<unknown[]> {
  return page.evaluate(async ([url, dbName]) => {
    const db = new window.FB.FirebirdBrowser(dbName as string, { worker: new Worker(url as string) });
    await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR(20))');
    await db.exec("INSERT INTO t VALUES (1, 'from a cdn')");
    const res = await db.query('SELECT id, name FROM t');
    await db.close();
    return res.rows;
  }, [workerUrl, name] as const);
}

test.describe('the engine from a CDN', () => {
  test.setTimeout(180_000);

  test('the threaded build, in a Worker of an isolated page', async ({ page, request }) => {
    test.skip(!built('firebird-embedded.wasm'), 'threaded build not built');
    await openHarness(page, '/browser-harness');
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);

    const before = await cdnHits(request);
    const rows = await roundTripInWorker(
      page, '/firebird-engine-worker-cdn.js?glue=firebird-embedded.js', 'memory://cdn-threads');
    const after = await cdnHits(request);

    expect(rows).toEqual([{ ID: 1, NAME: 'from a cdn' }]);
    expect((after['firebird-embedded.wasm'] ?? 0) - (before['firebird-embedded.wasm'] ?? 0)).toBeGreaterThan(0);
    expect((after['firebird-embedded.js'] ?? 0) - (before['firebird-embedded.js'] ?? 0)).toBeGreaterThan(0);
  });

  test('the build without threads, in a Worker of a page that is not isolated', async ({ page, request }) => {
    test.skip(!built('firebird-embedded-st.wasm'), 'build without threads not built');
    await openHarness(page, '/no-isolation/browser-harness');
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(false);

    const before = await cdnHits(request);
    const rows = await roundTripInWorker(
      page, '/no-isolation/firebird-engine-worker-cdn.js?glue=firebird-embedded-st.js', 'memory://cdn-st');
    const after = await cdnHits(request);

    expect(rows).toEqual([{ ID: 1, NAME: 'from a cdn' }]);
    expect((after['firebird-embedded-st.wasm'] ?? 0) - (before['firebird-embedded-st.wasm'] ?? 0)).toBe(1);
  });

  test('the build without threads by <script src>, on the page thread, with no locateFile', async ({
    page,
    request,
  }) => {
    test.skip(!built('firebird-embedded-st.wasm'), 'build without threads not built');
    // A glue loaded by <script src> finds its .wasm beside itself: nothing to
    // configure at all.
    await openHarness(page, '/no-isolation/browser-harness-cdn-st');

    const before = await cdnHits(request);
    const rows = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('memory://cdn-page');
      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (7)');
      const res = await db.query('SELECT id FROM t');
      await db.close();
      return res.rows;
    });
    const after = await cdnHits(request);

    expect(rows).toEqual([{ ID: 7 }]);
    expect((after['firebird-embedded-st.wasm'] ?? 0) - (before['firebird-embedded-st.wasm'] ?? 0)).toBe(1);
  });
});
