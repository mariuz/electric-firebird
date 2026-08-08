/**
 * browser-api.spec.ts – Playwright tests for the browser build of firebird-wasm.
 *
 * These tests drive the **real** `FirebirdBrowser` and `IndexedDBVFS` classes
 * (bundled from `packages/firebird-wasm/src/browser` by the test server) inside
 * a real Chromium page, against the browser's real IndexedDB implementation.
 *
 * They do not require the compiled WASM artifact.  The C ABI is provided by
 * `e2e/fixtures/stub-engine.js`, which installs a `createFirebirdModule`
 * factory with a real byte heap and a real in-memory filesystem — so pointer
 * marshalling, result decoding, transaction control flow, memory ownership and
 * MEMFS ⇄ IndexedDB persistence are all exercised for real.  Only the SQL
 * engine itself is stubbed.
 *
 * End-to-end coverage against the actual Firebird engine lives in
 * `wasm.spec.ts`, which skips itself until the WASM artifact has been built.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as path from 'path';

const STUB_ENGINE = path.resolve(__dirname, '../fixtures/stub-engine.js');

/** Control surface exposed by `fixtures/stub-engine.js`. */
interface StubControl {
  factoryCalls: number;
  calls: Array<{ fn: string; args: unknown[] }>;
  initRc: number;
  execRc: number;
  queryResult: { columns: string[]; rows: unknown[][] };
  queryReturnsNull: boolean;
  createFails: boolean;
  startTxFails: boolean;
  commitRc: number;
  lastError: string;
  failReadFile: string | null;
  callNames(): string[];
  firstCall(fn: string): { fn: string; args: unknown[] } | null;
  countCalls(fn: string): number;
  resetCalls(): void;
  stats(): {
    liveAllocations: number;
    liveResults: number;
    doubleFrees: number;
    initialised: boolean;
    openAttachments: number;
  };
  fileBytes(path: string): number[];
  fileSize(path: string): number;
  fileExists(path: string): boolean;
  statementCount(path: string): number;
  pageSize: number;
}

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
    __stub: StubControl;
  }
}

/**
 * Load the harness with the stub engine installed, and wait for the library
 * bundle to finish evaluating.
 */
async function openHarness(page: Page): Promise<void> {
  await page.goto('/browser-harness');
  await page.waitForFunction(() => Boolean(window.FB));
}

test.beforeEach(async ({ page }) => {
  // Runs before any page script on every navigation, including reloads.
  await page.addInitScript({ path: STUB_ENGINE });
  await openHarness(page);
});

// ===========================================================================
// IndexedDBVFS — against the browser's real IndexedDB
// ===========================================================================

test.describe('IndexedDBVFS', () => {
  test('round-trips a page and zero-fills pages that were never written', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 64 });
      await vfs.open('roundtrip');

      const written = new Uint8Array(64);
      written[0] = 0xab;
      written[63] = 0xcd;
      await vfs.writePage(0, written.buffer);

      const readBack = new Uint8Array(await vfs.readPage(0));
      const unwritten = new Uint8Array(await vfs.readPage(5));

      await vfs.close();
      return {
        readBack: Array.from(readBack),
        unwrittenLength: unwritten.byteLength,
        unwrittenIsZero: unwritten.every((b) => b === 0),
      };
    });

    expect(result.readBack[0]).toBe(0xab);
    expect(result.readBack[63]).toBe(0xcd);
    expect(result.readBack).toHaveLength(64);
    expect(result.unwrittenLength).toBe(64);
    expect(result.unwrittenIsZero).toBe(true);
  });

  test('rejects a page whose length does not match the page size', async ({
    page,
  }) => {
    const error = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 64 });
      await vfs.open('wrong-size');
      try {
        await vfs.writePage(0, new ArrayBuffer(63));
        return null;
      } catch (err) {
        return {
          name: (err as Error).name,
          message: (err as Error).message,
        };
      } finally {
        await vfs.close();
      }
    });

    expect(error?.name).toBe('RangeError');
    expect(error?.message).toContain('64');
  });

  test('tracks pageCount as one past the highest page written', async ({
    page,
  }) => {
    const meta = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 64 });
      await vfs.open('meta');

      const before = await vfs.getMetadata();
      await vfs.writePage(0, new ArrayBuffer(64));
      const afterFirst = await vfs.getMetadata();
      // Writing a sparse, higher page must extend the count, not append.
      await vfs.writePage(4, new ArrayBuffer(64));
      const afterSparse = await vfs.getMetadata();
      // Rewriting a lower page must not shrink it.
      await vfs.writePage(1, new ArrayBuffer(64));
      const afterLower = await vfs.getMetadata();

      await vfs.close();
      return { before, afterFirst, afterSparse, afterLower };
    });

    expect(meta.before).toEqual({ pageSize: 64, pageCount: 0 });
    expect(meta.afterFirst.pageCount).toBe(1);
    expect(meta.afterSparse.pageCount).toBe(5);
    expect(meta.afterLower.pageCount).toBe(5);
  });

  test('exports pages as one contiguous image, in page order', async ({
    page,
  }) => {
    const exported = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('export');

      await vfs.writePage(0, new Uint8Array([1, 2, 3, 4]).buffer);
      await vfs.writePage(1, new Uint8Array([5, 6, 7, 8]).buffer);
      // Page 2 is never written: it must still be present, zero-filled.
      await vfs.writePage(3, new Uint8Array([9, 9, 9, 9]).buffer);

      const image = await vfs.exportDatabase();
      await vfs.close();
      return Array.from(image);
    });

    expect(exported).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 9, 9, 9, 9]);
  });

  test('imports an image, replacing everything already stored', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('import');

      // Pre-existing content that must not survive the import.
      await vfs.writePage(0, new Uint8Array([1, 1, 1, 1]).buffer);
      await vfs.writePage(1, new Uint8Array([2, 2, 2, 2]).buffer);
      await vfs.writePage(2, new Uint8Array([3, 3, 3, 3]).buffer);

      await vfs.importDatabase(new Uint8Array([7, 7, 7, 7, 8, 8, 8, 8]));

      const meta = await vfs.getMetadata();
      const image = await vfs.exportDatabase();
      await vfs.close();
      return { meta, image: Array.from(image) };
    });

    expect(result.meta.pageCount).toBe(2);
    expect(result.image).toEqual([7, 7, 7, 7, 8, 8, 8, 8]);
  });

  test('rejects an image that is not a whole number of pages', async ({
    page,
  }) => {
    const error = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('bad-image');
      try {
        await vfs.importDatabase(new Uint8Array(6));
        return null;
      } catch (err) {
        return { name: (err as Error).name, message: (err as Error).message };
      } finally {
        await vfs.close();
      }
    });

    expect(error?.name).toBe('RangeError');
    expect(error?.message).toContain('6');
  });

  test('clear() empties the page store', async ({ page }) => {
    const image = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('clear');
      await vfs.writePage(0, new Uint8Array([1, 2, 3, 4]).buffer);
      await vfs.clear();
      const after = await vfs.exportDatabase();
      await vfs.close();
      return Array.from(after);
    });

    expect(image).toEqual([]);
  });


  test('writes only the pages that changed', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('incremental');

      const image = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
      await vfs.importDatabase(image);

      // Count writes by instrumenting the store, so this measures what
      // actually reaches IndexedDB rather than trusting the implementation.
      const original = IDBObjectStore.prototype.put;
      let puts = 0;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: unknown[]
      ) {
        puts++;
        return (original as (...a: unknown[]) => IDBRequest).apply(this, args);
      } as typeof IDBObjectStore.prototype.put;

      try {
        // Re-import an identical image: only the metadata record should move.
        await vfs.importDatabase(image);
        const unchangedPuts = puts;

        // Change one page out of three.
        puts = 0;
        const edited = new Uint8Array(image);
        edited[4] = 9;
        await vfs.importDatabase(edited);
        const oneChangedPuts = puts;

        const after = await vfs.exportDatabase();
        await vfs.close();
        return { unchangedPuts, oneChangedPuts, after: Array.from(after) };
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    });

    // Metadata only.
    expect(result.unchangedPuts).toBe(1);
    // One page plus metadata — not all three pages.
    expect(result.oneChangedPuts).toBe(2);
    expect(result.after).toEqual([1, 1, 1, 1, 9, 2, 2, 2, 3, 3, 3, 3]);
  });

  test('drops pages past the end when the database shrinks', async ({ page }) => {
    const image = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('shrink');

      await vfs.importDatabase(new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]));
      // A smaller image must not leave the third page behind.
      await vfs.importDatabase(new Uint8Array([7, 7, 7, 7]));

      const out = await vfs.exportDatabase();
      await vfs.close();
      return Array.from(out);
    });

    expect(image).toEqual([7, 7, 7, 7]);
  });

  test('leaves the previous image intact when a persist is interrupted', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('atomic');

      const original = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]);
      await vfs.importDatabase(original);

      // Abort partway through the next import, standing in for a tab closing
      // mid-persist. Because the whole import is one transaction, IndexedDB
      // must roll it back rather than leave a half-written database.
      const put = IDBObjectStore.prototype.put;
      let calls = 0;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: unknown[]
      ) {
        const request = (put as (...a: unknown[]) => IDBRequest).apply(this, args);
        if (++calls === 1) {
          this.transaction.abort();
        }
        return request;
      } as typeof IDBObjectStore.prototype.put;

      let aborted = false;
      try {
        await vfs.importDatabase(new Uint8Array([9, 9, 9, 9, 8, 8, 8, 8]));
      } catch {
        aborted = true;
      } finally {
        IDBObjectStore.prototype.put = put;
      }

      const after = await vfs.exportDatabase();
      await vfs.close();
      return { aborted, after: Array.from(after) };
    });

    expect(result.aborted).toBe(true);
    // The original image survived; no page of the failed write is visible.
    expect(result.after).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('persists pages across a full page reload', async ({ page }) => {
    await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 8 });
      await vfs.open('durable');
      await vfs.writePage(0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
      await vfs.sync();
      await vfs.close();
    });

    await page.reload();
    await page.waitForFunction(() => Boolean(window.FB));

    const afterReload = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 8 });
      await vfs.open('durable');
      const image = await vfs.exportDatabase();
      await vfs.close();
      return Array.from(image);
    });

    expect(afterReload).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('isolates databases from each other and honours a custom prefix', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const a = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await a.open('alpha');
      await a.writePage(0, new Uint8Array([1, 1, 1, 1]).buffer);
      await a.close();

      const b = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await b.open('beta');
      await b.writePage(0, new Uint8Array([2, 2, 2, 2]).buffer);
      await b.close();

      // Same logical name, different prefix ⇒ a different IndexedDB database.
      const scoped = new window.FB.IndexedDBVFS({ pageSize: 4, prefix: 'other_' });
      await scoped.open('alpha');
      const scopedImage = await scoped.exportDatabase();
      await scoped.close();

      const reopened = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await reopened.open('alpha');
      const alphaImage = await reopened.exportDatabase();
      await reopened.close();

      const names = (await indexedDB.databases()).map((d) => d.name).sort();
      return {
        alphaImage: Array.from(alphaImage),
        scopedImage: Array.from(scopedImage),
        names,
      };
    });

    expect(result.alphaImage).toEqual([1, 1, 1, 1]);
    expect(result.scopedImage).toEqual([]);
    expect(result.names).toContain('firebird_alpha');
    expect(result.names).toContain('firebird_beta');
    expect(result.names).toContain('other_alpha');
  });

  test('destroy() removes the underlying IndexedDB database', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('doomed');
      await vfs.writePage(0, new Uint8Array([1, 2, 3, 4]).buffer);

      const before = (await indexedDB.databases()).map((d) => d.name);
      await vfs.destroy();
      const after = (await indexedDB.databases()).map((d) => d.name);

      return { before, after };
    });

    expect(result.before).toContain('firebird_doomed');
    expect(result.after).not.toContain('firebird_doomed');
  });

  test('rejects page I/O before open() and a second open()', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const unopened = new window.FB.IndexedDBVFS({ pageSize: 4 });
      let beforeOpen: string | null = null;
      try {
        await unopened.readPage(0);
      } catch (err) {
        beforeOpen = (err as Error).message;
      }

      const vfs = new window.FB.IndexedDBVFS({ pageSize: 4 });
      await vfs.open('double-open');
      let doubleOpen: string | null = null;
      try {
        await vfs.open('double-open');
      } catch (err) {
        doubleOpen = (err as Error).message;
      }
      await vfs.close();

      return { beforeOpen, doubleOpen };
    });

    expect(result.beforeOpen).toContain('not open');
    expect(result.doubleOpen).toContain('already open');
  });
});

// ===========================================================================
// FirebirdBrowser — driven against the stub C ABI
// ===========================================================================

test.describe('FirebirdBrowser', () => {
  test('does not load the WASM module until the first statement', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('lazy');
      const beforeFirstCall = window.__stub.factoryCalls;

      await db.exec('CREATE TABLE t (id INTEGER)');
      const afterFirstCall = window.__stub.factoryCalls;

      await db.exec('CREATE TABLE u (id INTEGER)');
      const afterSecondCall = window.__stub.factoryCalls;

      await db.close();
      return { beforeFirstCall, afterFirstCall, afterSecondCall };
    });

    expect(result.beforeFirstCall).toBe(0);
    expect(result.afterFirstCall).toBe(1);
    // The module is cached — a second statement must not re-instantiate it.
    expect(result.afterSecondCall).toBe(1);
  });

  test('initialises the engine once when several statements race', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('race');
      await Promise.all([
        db.exec('SELECT 1'),
        db.exec('SELECT 2'),
        db.exec('SELECT 3'),
      ]);
      const names = window.__stub.callNames();
      await db.close();
      return {
        factoryCalls: window.__stub.factoryCalls,
        initCalls: names.filter((n) => n === '_fb_init').length,
        createCalls: names.filter((n) => n === '_fb_create_database').length,
      };
    });

    expect(result.factoryCalls).toBe(1);
    expect(result.initCalls).toBe(1);
    expect(result.createCalls).toBe(1);
  });

  test('exec() passes the SQL across the ABI and frees the heap string', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('exec');
      await db.exec("INSERT INTO t VALUES (1, 'héllo')");

      const call = window.__stub.firstCall('_fb_execute');
      const stats = window.__stub.stats();
      await db.close();
      return {
        dbHandle: call?.args[0],
        txHandle: call?.args[1],
        sql: call?.args[2],
        liveAllocations: stats.liveAllocations,
      };
    });

    // Non-ASCII must survive the UTF-8 round-trip through the heap.
    expect(result.sql).toBe("INSERT INTO t VALUES (1, 'héllo')");
    expect(result.dbHandle).toBeGreaterThan(0);
    // Outside an explicit transaction the engine is asked to supply its own.
    expect(result.txHandle).toBe(0);
    expect(result.liveAllocations).toBe(0);
  });

  test('exec() reports the engine return code and still frees the heap string', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('exec-fail');
      await db.exec('CREATE TABLE t (id INTEGER)'); // succeeds, forces init

      window.__stub.execRc = 335544569;
      let message: string | null = null;
      try {
        await db.exec('THIS IS NOT SQL');
      } catch (err) {
        message = (err as Error).message;
      }
      const stats = window.__stub.stats();
      window.__stub.execRc = 0;
      await db.close();
      return { message, liveAllocations: stats.liveAllocations };
    });

    expect(result.message).toContain('335544569');
    expect(result.message).toContain('THIS IS NOT SQL');
    // The `finally` block must free the SQL pointer even on the error path.
    expect(result.liveAllocations).toBe(0);
  });

  test('query() decodes the result set into upper-cased column keys', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      window.__stub.queryResult = {
        columns: ['id', 'name', 'created_at'],
        rows: [
          [1, 'alpha', '2024-01-01'],
          [2, 'béta', null],
        ],
      };

      const db = new window.FB.FirebirdBrowser('query');
      const res = await db.query('SELECT id, name, created_at FROM items');
      const stats = window.__stub.stats();
      await db.close();
      return { res, stats };
    });

    expect(result.res.fields).toEqual([
      { name: 'ID' },
      { name: 'NAME' },
      { name: 'CREATED_AT' },
    ]);
    expect(result.res.rows).toEqual([
      { ID: 1, NAME: 'alpha', CREATED_AT: '2024-01-01' },
      { ID: 2, NAME: 'béta', CREATED_AT: null },
    ]);
    // Both the SQL pointer and the engine-owned result buffer must be released.
    expect(result.stats.liveResults).toBe(0);
    expect(result.stats.liveAllocations).toBe(0);
    expect(result.stats.doubleFrees).toBe(0);
  });

  test('query() handles an empty result set', async ({ page }) => {
    const res = await page.evaluate(async () => {
      window.__stub.queryResult = { columns: ['id'], rows: [] };
      const db = new window.FB.FirebirdBrowser('empty');
      const out = await db.query('SELECT id FROM items WHERE 1 = 0');
      await db.close();
      return out;
    });

    expect(res.rows).toEqual([]);
    expect(res.fields).toEqual([{ name: 'ID' }]);
  });

  test('query() throws when the engine returns a NULL result pointer', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('query-null');
      await db.exec('CREATE TABLE t (id INTEGER)');

      window.__stub.queryReturnsNull = true;
      let message: string | null = null;
      try {
        await db.query('SELECT * FROM missing_table');
      } catch (err) {
        message = (err as Error).message;
      }
      const stats = window.__stub.stats();
      window.__stub.queryReturnsNull = false;
      await db.close();
      return { message, liveAllocations: stats.liveAllocations };
    });

    expect(result.message).toContain('missing_table');
    expect(result.liveAllocations).toBe(0);
  });

  test('transaction() commits when the callback resolves', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__stub.queryResult = { columns: ['cnt'], rows: [[2]] };
      const db = new window.FB.FirebirdBrowser('tx-commit');
      await db.exec('CREATE TABLE t (id INTEGER)');
      window.__stub.resetCalls();

      const value = await db.transaction(async (tx) => {
        await tx.exec("INSERT INTO t VALUES (1, 'a')");
        const { rows } = await tx.query('SELECT COUNT(*) AS cnt FROM t');
        return rows[0]!['CNT'];
      });

      const names = window.__stub.callNames();
      await db.close();
      return { value, names };
    });

    expect(result.value).toBe(2);
    expect(result.names).toEqual([
      '_fb_start_transaction',
      '_fb_execute',
      '_fb_query',
      '_fb_free_result',
      '_fb_commit',
    ]);
  });

  test('transaction() rolls back and rethrows when the callback throws', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('tx-rollback');
      await db.exec('CREATE TABLE t (id INTEGER)');
      window.__stub.resetCalls();

      let message: string | null = null;
      try {
        await db.transaction(async (tx) => {
          await tx.exec("INSERT INTO t VALUES (1, 'a')");
          throw new Error('application failure');
        });
      } catch (err) {
        message = (err as Error).message;
      }

      const names = window.__stub.callNames();
      await db.close();
      return { message, names };
    });

    // The caller's error must survive the rollback, not be replaced by it.
    expect(result.message).toBe('application failure');
    expect(result.names).toContain('_fb_rollback');
    expect(result.names).not.toContain('_fb_commit');
  });

  test('transaction() surfaces a failed commit without a second rollback', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('tx-commit-fail');
      await db.exec('CREATE TABLE t (id INTEGER)');
      window.__stub.resetCalls();
      window.__stub.commitRc = 335544336;

      let message: string | null = null;
      try {
        await db.transaction(async (tx) => {
          await tx.exec('INSERT INTO t VALUES (1)');
        });
      } catch (err) {
        message = (err as Error).message;
      }

      const names = window.__stub.callNames();
      window.__stub.commitRc = 0;
      await db.close();
      return { message, names };
    });

    expect(result.message).toContain('335544336');
    // fb_commit() finishes the transaction whatever the outcome, so rolling
    // back afterwards would be operating on a dead handle.
    expect(result.names).not.toContain('_fb_rollback');
    expect(result.names).toContain('_fb_commit');
  });

  test('transaction() throws when the engine refuses to start one', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('tx-start-fail');
      await db.exec('CREATE TABLE t (id INTEGER)');
      window.__stub.startTxFails = true;

      let message: string | null = null;
      let callbackRan = false;
      try {
        await db.transaction(async () => {
          callbackRan = true;
        });
      } catch (err) {
        message = (err as Error).message;
      }

      window.__stub.startTxFails = false;
      await db.close();
      return { message, callbackRan };
    });

    expect(result.message).toContain('Failed to start transaction');
    expect(result.callbackRan).toBe(false);
  });

  test('surfaces a failure to open the database', async ({ page }) => {
    const message = await page.evaluate(async () => {
      window.__stub.createFails = true;
      const db = new window.FB.FirebirdBrowser('unopenable');
      try {
        await db.exec('SELECT 1');
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        window.__stub.createFails = false;
      }
    });

    expect(message).toContain('unopenable');
  });

  test('close() persists, detaches, and is idempotent', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('closing');
      await db.exec('CREATE TABLE t (id INTEGER)');

      await db.close();
      await db.close(); // must be a no-op, not a second detach

      let afterClose: string | null = null;
      try {
        await db.exec('SELECT 1');
      } catch (err) {
        afterClose = (err as Error).message;
      }

      // Closing an instance that was never used must not throw either.
      const untouched = new window.FB.FirebirdBrowser('never-used');
      let untouchedError: string | null = null;
      try {
        await untouched.close();
      } catch (err) {
        untouchedError = (err as Error).message;
      }

      return {
        detachCalls: window.__stub.countCalls('_fb_detach_database'),
        afterClose,
        untouchedError,
      };
    });

    expect(result.detachCalls).toBe(1);
    expect(result.afterClose).toContain('closed');
    expect(result.untouchedError).toBeNull();
  });

  test('persist() copies the MEMFS image into IndexedDB', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('persisting');
      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec("INSERT INTO t VALUES (1, 'a')");
      await db.persist();

      const memfsBytes = window.__stub.fileBytes('/data/persisting.fdb');

      // Read what actually landed in IndexedDB, through the public VFS API.
      const vfs = new window.FB.IndexedDBVFS();
      await vfs.open('persisting');
      const meta = await vfs.getMetadata();
      const image = await vfs.exportDatabase();
      await vfs.close();

      await db.close();
      return {
        meta,
        matches:
          image.byteLength === memfsBytes.length &&
          Array.from(image).every((b, i) => b === memfsBytes[i]),
        magic: image[0],
        statements: image[1],
        byteLength: image.byteLength,
      };
    });

    expect(result.meta).toEqual({ pageSize: 8192, pageCount: 2 });
    expect(result.byteLength).toBe(16384);
    expect(result.matches).toBe(true);
    expect(result.magic).toBe(0xfb);
    // Two statements were executed before persisting.
    expect(result.statements).toBe(2);
  });

  test('encodes parameters and forwards them to the engine', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__stub.queryResult = { columns: ['id'], rows: [[1]] };
      const db = new window.FB.FirebirdBrowser('params');
      await db.exec('CREATE TABLE t (id INTEGER)');
      window.__stub.resetCalls();

      // Values cross the ABI as text for the engine to convert, so each of
      // these should arrive in its SQL text form.
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [
        1,
        'alpha',
        true,
        null,
      ]);
      await db.query('SELECT id FROM t WHERE id = ?', [42n]);

      // A call with no parameters must still use the plain entry point, so it
      // does not pay for an input message it would not use.
      await db.query('SELECT id FROM t');

      // Only the statement calls; _fb_free_result and friends are noise here.
      const calls = window.__stub.calls
        .filter((c) => /^_fb_(execute|query)/.test(c.fn))
        .map((c) => ({ fn: c.fn, params: c.args[3] }));

      await db.close();
      return calls;
    });

    expect(result).toEqual([
      { fn: '_fb_execute_params', params: ['1', 'alpha', 'TRUE', null] },
      { fn: '_fb_query_params', params: ['42'] },
      // No parameters: the plain call, whose 4th argument does not exist.
      { fn: '_fb_query', params: undefined },
    ]);
  });

  test('rejects parameter values with no SQL text form', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('params-invalid');
      await db.exec('CREATE TABLE t (id INTEGER)');

      const capture = async (params: unknown[]): Promise<string | null> => {
        try {
          await db.query('SELECT id FROM t WHERE id = ?', params);
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      };

      const binary = await capture([new Uint8Array([1, 2, 3])]);
      const nan = await capture([Number.NaN]);
      const object = await capture([{ nope: true }]);

      await db.close();
      return { binary, nan, object };
    });

    // Each names what is wrong rather than corrupting the value silently.
    expect(result.binary).toContain('binary');
    expect(result.nan).toContain('NaN');
    expect(result.object).toContain('unsupported type');
  });

  test('binds statements inside a transaction to the transaction handle', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      window.__stub.queryResult = { columns: ['cnt'], rows: [[1]] };
      const db = new window.FB.FirebirdBrowser('tx-binding');
      await db.exec('CREATE TABLE t (id INTEGER)');
      window.__stub.resetCalls();

      await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (1)');
        await tx.query('SELECT COUNT(*) AS cnt FROM t');
      });

      const started = window.__stub.firstCall('_fb_start_transaction');
      const exec = window.__stub.firstCall('_fb_execute');
      const query = window.__stub.firstCall('_fb_query');
      const commit = window.__stub.firstCall('_fb_commit');

      await db.close();
      return {
        txHandle: commit?.args[0],
        execTx: exec?.args[1],
        queryTx: query?.args[1],
        startedOn: started?.args[0],
      };
    });

    // The handle the transaction was opened with must be the one every
    // statement runs under — otherwise a rollback would not undo them.
    expect(result.txHandle).toBeGreaterThan(0);
    expect(result.execTx).toBe(result.txHandle);
    expect(result.queryTx).toBe(result.txHandle);
    expect(result.startedOn).toBeGreaterThan(0);
  });

  test('surfaces the engine error text, not just a numeric code', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-errors');
      await db.exec('CREATE TABLE t (id INTEGER)');

      const capture = async (fn: () => Promise<unknown>): Promise<string> => {
        try {
          await fn();
          return '';
        } catch (err) {
          return (err as Error).message;
        }
      };

      window.__stub.execRc = 335544569;
      window.__stub.lastError =
        'Dynamic SQL Error: SQL error code = -204, Table unknown: MISSING';
      const execMessage = await capture(() => db.exec('SELECT * FROM missing'));

      window.__stub.execRc = 0;
      window.__stub.queryReturnsNull = true;
      window.__stub.lastError = 'fb_query: prepare failed: Column unknown: NOPE';
      const queryMessage = await capture(() => db.query('SELECT nope FROM t'));

      window.__stub.queryReturnsNull = false;
      window.__stub.lastError = '';
      await db.close();
      return { execMessage, queryMessage };
    });

    expect(result.execMessage).toContain('Table unknown: MISSING');
    expect(result.execMessage).toContain('335544569');
    expect(result.queryMessage).toContain('Column unknown: NOPE');
  });

  test('reports why the engine failed to initialise', async ({ page }) => {
    const message = await page.evaluate(async () => {
      window.__stub.initRc = 3;
      window.__stub.lastError = 'fb_init: no Firebird provider available';
      const db = new window.FB.FirebirdBrowser('init-failure');
      try {
        await db.exec('SELECT 1');
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        window.__stub.initRc = 0;
        window.__stub.lastError = '';
      }
    });

    expect(message).toContain('no Firebird provider available');
    expect(message).toContain('(code 3)');
  });


  // ── Automatic persistence ───────────────────────────────────────────────

  test('persists automatically after a write, coalescing a burst', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('autopersist', {
        autoPersistDebounceMs: 20,
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (1)');
      await db.exec('INSERT INTO t VALUES (2)');

      // Nothing written yet: the debounce has not elapsed.
      const before = window.__stub.countCalls('FS.readFile');

      await new Promise((r) => setTimeout(r, 120));
      const after = window.__stub.countCalls('FS.readFile');

      await db.close();
      return { before, after };
    });

    expect(result.before).toBe(0);
    // Three statements, one persist — the burst coalesced.
    expect(result.after).toBe(1);
  });

  test('does not persist automatically when the option is off', async ({
    page,
  }) => {
    const reads = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('autopersist-off', {
        autoPersist: false,
        autoPersistDebounceMs: 20,
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await new Promise((r) => setTimeout(r, 120));

      const count = window.__stub.countCalls('FS.readFile');
      await db.close();
      return count;
    });

    expect(reads).toBe(0);
  });

  test('flushes when the page is hidden, without waiting for the debounce', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('autopersist-hidden', {
        // Long enough that only the visibility handler can explain a write.
        autoPersistDebounceMs: 60_000,
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      const before = window.__stub.countCalls('FS.readFile');

      // Report the document as hidden and fire the event the browser would.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      await new Promise((r) => setTimeout(r, 50));
      const after = window.__stub.countCalls('FS.readFile');

      await db.close();
      return { before, after };
    });

    expect(result.before).toBe(0);
    expect(result.after).toBe(1);
  });

  test('reports a background persist failure instead of losing it', async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      let reported: string | null = null;

      const db = new window.FB.FirebirdBrowser('autopersist-error', {
        autoPersistDebounceMs: 20,
        onPersistError: (err) => {
          reported = err.message;
        },
      });

      await db.exec('CREATE TABLE t (id INTEGER)');

      // Break the read the persist depends on, after the database is open.
      const path = '/data/autopersist-error.fdb';
      window.__stub.failReadFile = path;

      await new Promise((r) => setTimeout(r, 120));
      window.__stub.failReadFile = null;

      await db.close();
      return reported;
    });

    // Surfaced through the callback rather than becoming an unhandled
    // rejection, which would hide data loss.
    expect(message).toContain('ENOENT');
  });

  test('cancels a pending persist when closed', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('autopersist-close', {
        autoPersistDebounceMs: 50,
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.close(); // close() persists once, itself

      const afterClose = window.__stub.countCalls('FS.readFile');
      await new Promise((r) => setTimeout(r, 150));
      const later = window.__stub.countCalls('FS.readFile');

      return { afterClose, later };
    });

    // close() persisted; the scheduled one must not fire afterwards, when the
    // engine is gone.
    expect(result.afterClose).toBe(1);
    expect(result.later).toBe(1);
  });

  test('reopens an existing database after a reload instead of recreating it', async ({
    page,
  }) => {
    // Session 1 — create the database and commit three statements.
    const first = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('survivor');
      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (1)');
      await db.exec('INSERT INTO t VALUES (2)');
      await db.close(); // close() persists before detaching
      return {
        names: window.__stub.callNames(),
        statements: window.__stub.statementCount('/data/survivor.fdb'),
      };
    });

    expect(first.names).toContain('_fb_create_database');
    expect(first.names).not.toContain('_fb_attach_database');
    expect(first.statements).toBe(3);

    await page.reload();
    await page.waitForFunction(() => Boolean(window.FB));

    // Session 2 — a fresh JS context and a fresh (empty) stub filesystem.
    const second = await page.evaluate(async () => {
      const existedBeforeInit = window.__stub.fileExists?.('/data/survivor.fdb');
      const db = new window.FB.FirebirdBrowser('survivor');
      await db.exec('INSERT INTO t VALUES (3)');
      const names = window.__stub.callNames();
      const statements = window.__stub.statementCount('/data/survivor.fdb');
      const size = window.__stub.fileSize('/data/survivor.fdb');
      await db.close();
      return { existedBeforeInit, names, statements, size };
    });

    // The file did not exist in MEMFS: it was restored from IndexedDB.
    expect(second.existedBeforeInit).toBeFalsy();
    expect(second.names).toContain('_fb_attach_database');
    expect(second.names).not.toContain('_fb_create_database');
    expect(second.size).toBe(16384);
    // Three statements from session 1, plus one more in session 2.
    expect(second.statements).toBe(4);
  });
});
