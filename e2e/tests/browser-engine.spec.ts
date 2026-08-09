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


  test('binds query parameters', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-params', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec(
        'CREATE TABLE t (id INTEGER, name VARCHAR(32), amount NUMERIC(10,2), ok BOOLEAN)',
      );

      // Every value crosses as text and Firebird converts it, so this also
      // covers integer, decimal and boolean conversion — not just strings.
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [1, 'alpha', 10.5, true]);
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [2, 'beta', 20.25, false]);
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [3, null, null, null]);

      const byId = await db.query('SELECT id, name FROM t WHERE id >= ? ORDER BY id', [2]);
      const byName = await db.query('SELECT id FROM t WHERE name = ?', ['beta']);
      const nulls = await db.query('SELECT id FROM t WHERE name IS NULL');

      await db.close();
      return { byId: byId.rows, byName: byName.rows, nulls: nulls.rows };
    });

    expect(result.byId).toEqual([
      { ID: 2, NAME: 'beta' },
      { ID: 3, NAME: null },
    ]);
    expect(result.byName).toEqual([{ ID: 2 }]);
    // A null parameter stored SQL NULL, not the string "null".
    expect(result.nulls).toEqual([{ ID: 3 }]);
  });

  test('reports a parameter count mismatch instead of failing obscurely', async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-param-arity', {
        worker: new Worker('/firebird-engine-worker.js'),
      });
      await db.exec('CREATE TABLE t (id INTEGER)');

      try {
        await db.query('SELECT id FROM t WHERE id = ?', [1, 2]);
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        await db.close();
      }
    });

    expect(message).toContain('expects 1 parameter');
    expect(message).toContain('2 were supplied');
  });


  test('reports affected row counts', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-affected', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      const ddl = await db.exec('CREATE TABLE t (id INTEGER, tag VARCHAR(8))');
      const insert = await db.exec("INSERT INTO t VALUES (1, 'a')");
      await db.exec("INSERT INTO t VALUES (2, 'a')");
      await db.exec("INSERT INTO t VALUES (3, 'b')");

      const update = await db.exec("UPDATE t SET tag = 'z' WHERE tag = ?", ['a']);
      const del = await db.exec('DELETE FROM t WHERE id = ?', [3]);
      const noMatch = await db.exec('DELETE FROM t WHERE id = ?', [999]);

      await db.close();
      // exec() returns one result per statement; these are all single
      // statements, so each has exactly one.
      return {
        ddl: ddl[0]!.affectedRows,
        insert: insert[0]!.affectedRows,
        update: update[0]!.affectedRows,
        del: del[0]!.affectedRows,
        noMatch: noMatch[0]!.affectedRows,
      };
    });

    expect(result.ddl).toBe(0); // DDL reports nothing
    expect(result.insert).toBe(1);
    expect(result.update).toBe(2); // both rows tagged 'a'
    expect(result.del).toBe(1);
    expect(result.noMatch).toBe(0);
  });

  test('rolls back explicitly without throwing', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-explicit-rollback', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (1)');

      // Abandoning the transaction returns normally: no error propagates.
      const returned = await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (2)');
        await tx.rollback();
        return 'abandoned';
      });

      // Using the transaction after rollback is a mistake worth reporting.
      let afterRollback: string | null = null;
      await db.transaction(async (tx) => {
        await tx.rollback();
        try {
          await tx.exec('INSERT INTO t VALUES (3)');
        } catch (err) {
          afterRollback = (err as Error).message;
        }
      });

      const count = await db.query('SELECT COUNT(*) AS CNT FROM t');
      await db.close();
      return { returned, afterRollback, count: count.rows[0]!['CNT'] };
    });

    expect(result.returned).toBe('abandoned');
    expect(result.afterRollback).toContain('already been rolled back');
    // Only the row inserted outside the transactions survived.
    expect(result.count).toBe(1);
  });


  test('runs a migration script, including a procedure body', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-script', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      // The shape a real migration takes: several statements, a comment, and
      // a PSQL body whose internal semicolons must not split it.
      const results = await db.exec(`
        CREATE TABLE items (id INTEGER, name VARCHAR(32));
        -- seed data; note the semicolon in this comment
        INSERT INTO items VALUES (1, 'alpha');
        INSERT INTO items VALUES (2, 'a;b');

        SET TERM ^ ;
        CREATE PROCEDURE count_items RETURNS (total INTEGER) AS
        BEGIN
          SELECT COUNT(*) FROM items INTO :total;
          SUSPEND;
        END^
        SET TERM ; ^
      `);

      const rows = await db.query('SELECT id, name FROM items ORDER BY id');
      const viaProc = await db.query('SELECT total FROM count_items');

      await db.close();
      return { statements: results.length, rows: rows.rows, viaProc: viaProc.rows };
    });

    // Four statements: two DDL, two inserts. The SET TERM directives are not
    // statements, and the procedure body stayed in one piece.
    expect(result.statements).toBe(4);
    expect(result.rows).toEqual([
      { ID: 1, NAME: 'alpha' },
      { ID: 2, NAME: 'a;b' },
    ]);
    // The procedure was created and runs, so its body survived splitting.
    expect(result.viaProc).toEqual([{ TOTAL: 2 }]);
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
