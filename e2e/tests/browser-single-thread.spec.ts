/**
 * browser-single-thread.spec.ts – the build without threads, in a page that is
 * not cross-origin isolated.
 *
 * Every page here is served under /no-isolation/, without COOP/COEP: the
 * situation of GitHub Pages and other static hosts that cannot send them,
 * where a browser hands out no SharedArrayBuffer.  The threaded build cannot
 * run there; `firebird-embedded-st` must, in a Worker and, having nothing to
 * block on, on the page's own thread too.
 *
 * Skipped until that artifact has been built (`wasm/build.sh` builds it by
 * default).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ST_JS = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm/firebird-embedded-st.js',
);
const stAvailable = fs.existsSync(ST_JS);

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
  }
}

async function openHarness(page: Page, route: string): Promise<void> {
  await page.goto(`/no-isolation${route}`);
  await page.waitForFunction(() => Boolean(window.FB));
  expect(await page.evaluate(() => ({
    isolated: self.crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
  }))).toEqual({ isolated: false, sab: 'undefined' });
}

test.describe('the build without threads, without cross-origin isolation', () => {
  test.skip(!stAvailable, 'firebird-embedded-st not built – run npm run build:wasm first');
  test.setTimeout(180_000);

  test('names the build to load', async ({ page }) => {
    await openHarness(page, '/browser-harness');
    expect(await page.evaluate(() => window.FB.wasmGlueFile())).toBe('firebird-embedded-st.js');
  });

  test('runs on the page thread: rows, a rollback, events, and a stored database', async ({ page }) => {
    await openHarness(page, '/browser-harness-wasm-st');

    const result = await page.evaluate(async () => {
      // No worker: nothing in this build blocks, so the page thread can host
      // the engine directly.
      const db = new window.FB.FirebirdBrowser('st-page');
      await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(32))');
      await db.query("CREATE TRIGGER items_ai FOR items AFTER INSERT AS BEGIN POST_EVENT 'items'; END");

      const heard: number[] = [];
      const sub = await db.listen('items', (counts) => heard.push(counts.items ?? 0), { pollIntervalMs: 10 });
      await db.exec("INSERT INTO items VALUES (1, 'alpha')");
      await db.exec("INSERT INTO items VALUES (2, 'beta')");
      for (let i = 0; i < 200 && heard.reduce((a, b) => a + b, 0) < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await sub.unsubscribe();

      let rolledBack = '';
      try {
        await db.transaction(async (tx) => {
          await tx.exec("INSERT INTO items VALUES (3, 'gamma')");
          throw new Error('undo');
        });
      } catch (e) {
        rolledBack = (e as Error).message;
      }

      const rows = (await db.query('SELECT id, name FROM items ORDER BY id')).rows;
      await db.close();

      // Opened again by name: the database was stored in IndexedDB.
      const again = new window.FB.FirebirdBrowser('st-page');
      const stored = (await again.query('SELECT COUNT(*) AS n FROM items')).rows;
      await again.close();
      return { rows, heard: heard.reduce((a, b) => a + b, 0), rolledBack, stored };
    });

    expect(result).toEqual({
      rows: [{ ID: 1, NAME: 'alpha' }, { ID: 2, NAME: 'beta' }],
      heard: 2,
      rolledBack: 'undo',
      stored: [{ N: 2 }],
    });
  });

  test('does not answer engine requests posted to the page by another window', async ({ page }) => {
    // The engine on the page thread shares the page's window, which every
    // window that can reach it (a frame, an opener) can postMessage to.  The
    // library used to start an engine server there on import, so a posted
    // init and execute ran SQL against the page's database.
    await openHarness(page, '/browser-harness-wasm-st');

    const rows = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('memory://posted-to');
      await db.exec('CREATE TABLE secrets (v VARCHAR(20))');
      await db.exec("INSERT INTO secrets VALUES ('kept')");
      for (const handle of [1, 2, 3]) {
        window.postMessage({ id: 1, op: 'init', args: [] }, '*');
        window.postMessage({ id: 2, op: 'execute', args: [handle, 0, 'DELETE FROM secrets'] }, '*');
      }
      await new Promise((r) => setTimeout(r, 1_000));
      const result = await db.query('SELECT v FROM secrets');
      await db.close();
      return result.rows;
    });

    expect(rows).toEqual([{ V: 'kept' }]);
  });

  test('runs in a Worker, including an opfs:// database directly from the plain ArrayBuffer heap', async ({ page }) => {
    await openHarness(page, '/browser-harness');

    const result = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('firebird', { create: true });
      await dir.removeEntry('st-opfs.fdb').catch(() => undefined);

      const db = new window.FB.FirebirdBrowser('opfs://st-opfs', {
        worker: new Worker('/no-isolation/firebird-engine-worker-st.js'),
      });
      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (42)');
      const first = (await db.query('SELECT id FROM t')).rows;
      await db.close();

      const reopened = new window.FB.FirebirdBrowser('opfs://st-opfs', {
        worker: new Worker('/no-isolation/firebird-engine-worker-st.js'),
      });
      const second = (await reopened.query('SELECT id FROM t')).rows;
      await reopened.close();
      return { first, second };
    });

    expect(result).toEqual({ first: [{ ID: 42 }], second: [{ ID: 42 }] });
  });

  test('refuses the threaded build with a message, instead of hanging', async ({ page }) => {
    await openHarness(page, '/browser-harness');

    const outcome = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('memory://mt-no-isolation', {
        worker: new Worker('/no-isolation/firebird-engine-worker.js'),
      });
      // Before the loader checked, this never settled.
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('no answer in 30 s'), 30_000));
      try {
        return await Promise.race([db.query('SELECT 1 FROM RDB$DATABASE').then(() => 'ran'), timeout]);
      } catch (e) {
        return (e as Error).message;
      }
    });

    expect(outcome).toContain('not cross-origin isolated');
    expect(outcome).toContain('firebird-embedded-st.js');
  });
});
