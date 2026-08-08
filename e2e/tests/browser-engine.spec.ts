/**
 * browser-engine.spec.ts – the public TypeScript API against the real engine.
 *
 * `browser-api.spec.ts` drives `FirebirdBrowser` against a stub C ABI, which
 * covers marshalling, error handling and persistence without needing a
 * compiled artifact.  This file closes the other half: the same class, the
 * same public methods, but the actual Firebird engine underneath.
 *
 * The engine runs in a Web Worker because it has to.  The build uses pthreads,
 * Firebird blocks on mutexes while opening a database, and a browser main
 * thread is not allowed to block — so `FirebirdBrowser` is constructed with a
 * `worker`, which is how a real application must use it too.
 *
 * Skipped until the WASM artifact has been built.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WASM_JS = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm/firebird-embedded.js',
);
const wasmAvailable = fs.existsSync(WASM_JS);

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
  }
}

/** Load the harness without any stub engine installed. */
async function openHarness(page: Page): Promise<void> {
  await page.goto('/browser-harness');
  await page.waitForFunction(() => Boolean(window.FB));
  // SharedArrayBuffer, and therefore Emscripten's pthreads, need this.
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
}

test.describe('FirebirdBrowser against the real engine', () => {
  test.skip(!wasmAvailable, 'WASM binary not built – run npm run build:wasm first');

  // Creating a database writes the whole system catalogue, which is slow.
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  test('creates a database and round-trips rows through query()', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-roundtrip', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(32))');
      await db.exec("INSERT INTO items VALUES (1, 'alpha')");
      await db.exec("INSERT INTO items VALUES (2, 'beta')");

      const res = await db.query('SELECT id, name FROM items ORDER BY id');
      await db.close();
      return res;
    });

    expect(result.fields).toEqual([{ name: 'ID' }, { name: 'NAME' }]);
    expect(result.rows).toEqual([
      { ID: 1, NAME: 'alpha' },
      { ID: 2, NAME: 'beta' },
    ]);
  });

  test('rolls a transaction back through the public API', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-rollback', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (1)');

      let message: string | null = null;
      try {
        await db.transaction(async (tx) => {
          await tx.exec('INSERT INTO t VALUES (2)');
          throw new Error('application failure');
        });
      } catch (err) {
        message = (err as Error).message;
      }

      // The insert ran under the transaction handle, so rolling back undoes it.
      const after = await db.query('SELECT COUNT(*) AS CNT FROM t');
      await db.close();
      return { message, count: after.rows[0]!['CNT'] };
    });

    expect(result.message).toBe('application failure');
    expect(result.count).toBe(1);
  });

  test('commits a transaction through the public API', async ({ page }) => {
    const count = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-commit', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (1)');
        await tx.exec('INSERT INTO t VALUES (2)');
      });

      const res = await db.query('SELECT COUNT(*) AS CNT FROM t');
      await db.close();
      return res.rows[0]!['CNT'];
    });

    expect(count).toBe(2);
  });

  test('surfaces Firebird error text for invalid SQL', async ({ page }) => {
    const message = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-errors', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      try {
        await db.query('SELECT * FROM no_such_table');
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        await db.close();
      }
    });

    // Not a bare status code — the engine's own diagnostic reaches the caller.
    expect(message).toContain('NO_SUCH_TABLE');
  });

  test('persists to IndexedDB and reopens the database after a reload', async ({
    page,
  }) => {
    // Session 1: create and populate, then close (which persists).
    await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-durable', {
        worker: new Worker('/firebird-engine-worker.js'),
      });
      await db.exec('CREATE TABLE survivors (id INTEGER, name VARCHAR(32))');
      await db.exec("INSERT INTO survivors VALUES (1, 'persisted')");
      await db.close();
    });

    await page.reload();
    await page.waitForFunction(() => Boolean(window.FB));

    // Session 2: a fresh WASM instance with an empty filesystem. The rows can
    // only come from IndexedDB.
    const rows = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-durable', {
        worker: new Worker('/firebird-engine-worker.js'),
      });
      const res = await db.query('SELECT id, name FROM survivors');
      await db.close();
      return res.rows;
    });

    expect(rows).toEqual([{ ID: 1, NAME: 'persisted' }]);
  });
});
