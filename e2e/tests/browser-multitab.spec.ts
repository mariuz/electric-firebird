/**
 * browser-multitab.spec.ts – two real tabs contending for one database.
 *
 * Every tab runs its own engine with its own complete copy of the database and
 * persists the *whole image*, so concurrent tabs do not interleave writes —
 * the later persist discards the earlier tab's work outright.  These tests use
 * two live pages in one browser context, which is what makes them meaningful:
 * the pages share an origin, so they share both IndexedDB and the Web Locks
 * namespace, exactly as two tabs of a real application would.
 *
 * The engine is `fixtures/stub-engine.js`, whose database image carries a
 * durable statement counter.  That counter is what makes the data loss
 * *visible* rather than merely argued about — see the `allow-unsafe` test,
 * which demonstrates the loss the default exists to prevent.
 */

import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';
import * as path from 'path';

const STUB_ENGINE = path.resolve(__dirname, '../fixtures/stub-engine.js');

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
  }
}

/** Open a harness page with the stub engine installed. */
async function newTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript({ path: STUB_ENGINE });
  await page.goto('/browser-harness');
  await page.waitForFunction(() => Boolean(window.FB));
  return page;
}

/**
 * Open a database in `page` and keep it open, parked on `window.__db`.
 *
 * Returns the error message if opening was refused, or null on success.
 */
async function openAndHold(
  page: Page,
  dbName: string,
  options: Record<string, unknown> = {},
): Promise<string | null> {
  return page.evaluate(
    async ([name, opts]) => {
      const db = new window.FB.FirebirdBrowser(name as string, {
        autoPersist: false,
        ...(opts as object),
      });
      try {
        // exec() drives the lazy open, so this is where a refusal surfaces.
        await db.exec('CREATE TABLE t (id INTEGER)');
      } catch (err) {
        return (err as Error).message;
      }
      (window as unknown as { __db: unknown }).__db = db;
      return null;
    },
    [dbName, options] as const,
  );
}

/** Run `statements` more statements against the held database and persist. */
async function writeAndPersist(page: Page, statements: number): Promise<void> {
  await page.evaluate(async (count) => {
    const db = (window as unknown as { __db: { exec: (s: string) => Promise<unknown>; persist: () => Promise<void> } }).__db;
    for (let i = 0; i < count; i++) {
      await db.exec(`INSERT INTO t VALUES (${i})`);
    }
    await db.persist();
  }, statements);
}

/** Close the held database, releasing the lock. */
async function closeHeld(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = (window as unknown as { __db?: { close: () => Promise<void> } }).__db;
    await db?.close();
  });
}

/**
 * Read the durable statement counter straight out of IndexedDB.
 *
 * Deliberately not through a `FirebirdBrowser`: opening one would take the
 * lock and perturb what is being measured.
 */
async function persistedStatementCount(page: Page, dbName: string): Promise<number> {
  return page.evaluate(async (name) => {
    const vfs = new window.FB.IndexedDBVFS();
    await vfs.open(name);
    const image = await vfs.exportDatabase();
    await vfs.close();
    return image.byteLength === 0 ? -1 : image[1];
  }, dbName);
}

test.describe('Multi-tab safety', () => {
  test('refuses to open a database a second tab already holds', async ({
    context,
  }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    expect(await openAndHold(tabA, 'contended')).toBeNull();

    // The message has to be actionable: an application catching this needs to
    // know which database, and what to do, not just "AbortError".
    const refusal = await openAndHold(tabB, 'contended', { lockTimeoutMs: 300 });
    expect(refusal).toContain('already open in another tab');
    expect(refusal).toContain('contended');
    expect(refusal).toContain('allow-unsafe');

    await closeHeld(tabA);
  });

  test('does not block a different database', async ({ context }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    expect(await openAndHold(tabA, 'alpha')).toBeNull();
    // Locking per database rather than globally: unrelated databases in
    // different tabs are not in conflict and must not wait on each other.
    expect(await openAndHold(tabB, 'beta', { lockTimeoutMs: 300 })).toBeNull();

    await closeHeld(tabA);
    await closeHeld(tabB);
  });

  test('hands the database over once the holding tab closes it', async ({
    context,
  }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    expect(await openAndHold(tabA, 'handover')).toBeNull();
    await writeAndPersist(tabA, 3);
    await closeHeld(tabA);

    // The waiting tab must see what the departing tab wrote.  It takes the
    // lock before reading the stored image, so there is no window in which it
    // could load a snapshot the other tab then replaced.
    expect(await openAndHold(tabB, 'handover', { lockTimeoutMs: 2000 })).toBeNull();
    await writeAndPersist(tabB, 1);
    await closeHeld(tabB);

    // 1 (CREATE TABLE) + 3 from A, + 1 (CREATE TABLE) + 1 from B.
    expect(await persistedStatementCount(tabA, 'handover')).toBe(6);
  });

  test('releases the lock when the holding tab goes away without closing', async ({
    context,
  }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    expect(await openAndHold(tabA, 'crashed')).toBeNull();

    // No close(), no unload handler — the tab simply ceases to exist, which is
    // how tabs usually go.  This is the whole reason for using Web Locks: a
    // lease record in IndexedDB would still be sitting there claiming the
    // database, with no way to tell a dead holder from a busy one.
    await tabA.close();

    expect(await openAndHold(tabB, 'crashed', { lockTimeoutMs: 5000 })).toBeNull();
    await closeHeld(tabB);
  });

  test('a waiting tab is granted the lock as soon as the holder releases', async ({
    context,
  }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    expect(await openAndHold(tabA, 'queued')).toBeNull();

    // Start waiting with a generous timeout, then release: the tab should be
    // granted the lock promptly rather than polling for it.
    const waiting = openAndHold(tabB, 'queued', { lockTimeoutMs: 10_000 });
    await tabB.waitForTimeout(200);

    await closeHeld(tabA);
    expect(await waiting).toBeNull();

    await closeHeld(tabB);
  });

  test("allow-unsafe opts out — and loses the other tab's writes", async ({
    context,
  }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    // This test exists to show what the default prevents.  If it ever stops
    // losing data, the lock is no longer the thing standing between an
    // application and silent corruption, and the default should be revisited.
    expect(await openAndHold(tabA, 'unsafe-demo')).toBeNull();
    await writeAndPersist(tabA, 2); // 3 statements total
    expect(await persistedStatementCount(tabA, 'unsafe-demo')).toBe(3);

    // B loads A's image, so both tabs now hold the same 3 statements.
    expect(
      await openAndHold(tabB, 'unsafe-demo', { multiTab: 'allow-unsafe' }),
    ).toBeNull();

    await writeAndPersist(tabA, 4); // A: 8 statements
    await writeAndPersist(tabB, 1); // B: 5 statements, persisted last

    // B's whole-image write wins outright.  A's four statements are not
    // conflicted or merged — they are simply gone, and A was told they
    // committed.
    expect(await persistedStatementCount(tabA, 'unsafe-demo')).toBe(5);

    await closeHeld(tabA);
    await closeHeld(tabB);
  });

  test('the same tab can reopen a database it closed', async ({ context }) => {
    const tabA = await newTab(context);

    // Release must actually complete, not just be requested: a lock held by a
    // finished instance would lock the tab out of its own database.
    expect(await openAndHold(tabA, 'reopen')).toBeNull();
    await closeHeld(tabA);
    expect(await openAndHold(tabA, 'reopen', { lockTimeoutMs: 1000 })).toBeNull();
    await closeHeld(tabA);
  });
});
