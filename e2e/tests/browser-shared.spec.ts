/**
 * browser-shared.spec.ts – many tabs, one engine.
 *
 * `multiTab: 'exclusive'` keeps a second tab safe by refusing it; these tests
 * cover `'shared'`, which serves it instead. Two live pages in one browser
 * context, so they share an origin and therefore a real Web Lock namespace, a
 * real BroadcastChannel and a real IndexedDB — the same things two tabs of an
 * application share.
 *
 * The engine is `fixtures/stub-engine.js`. That is not a weakness here: what
 * is under test is the election, the channel and the failover, none of which
 * care what SQL means. The stub's per-tab isolation is in fact the point — it
 * has no shared state of its own, so a follower seeing a leader's write can
 * only be the message passing working.
 */

import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';
import * as path from 'path';

const STUB_ENGINE = path.resolve(__dirname, '../fixtures/stub-engine.js');

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
    __db?: {
      exec: (sql: string) => Promise<unknown>;
      query: (sql: string) => Promise<{ rows: unknown[] }>;
      close: () => Promise<void>;
    };
    __isLeader?: () => boolean;
  }
}

async function newTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript({ path: STUB_ENGINE });
  await page.goto('/browser-harness');
  await page.waitForFunction(() => Boolean(window.FB));
  return page;
}

/** Open a shared database in `page` and park it on `window.__db`. */
async function openShared(page: Page, dbName: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    // multiTab: 'shared' rather than a hand-built transport, so the wiring
    // between FirebirdBrowser and the election is what is under test. Passing
    // a pre-built SharedEngineTransport skips exactly the callbacks that make
    // failover work, which is how the first version of this test managed to
    // pass while the feature was broken.
    const db = new window.FB.FirebirdBrowser(name, {
      multiTab: 'shared',
      autoPersist: false,
    });

    try {
      await db.exec('CREATE TABLE t (id INTEGER)');
    } catch (err) {
      return (err as Error).message;
    }

    window.__db = db as never;
    window.__isLeader = () => db.isLeader;
    return null;
  }, dbName);
}

/**
 * Whether this tab ever built an engine of its own.
 *
 * `factoryCalls` rather than the database file, because a follower never calls
 * the Emscripten factory at all — so the stub's file helpers do not even exist
 * there. That absence is the behaviour under test, but it is indistinguishable
 * from a broken fixture, so the assertion uses a counter that is present
 * either way.
 */
async function builtOwnEngine(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__stub.factoryCalls > 0);
}

/** Statements executed by this tab's own engine; 0 if it never built one. */
async function localStatements(page: Page, dbName: string): Promise<number> {
  return page.evaluate((name) => {
    if (typeof window.__stub.statementCount !== 'function') return 0;
    const count = window.__stub.statementCount(`/data/${name}.fdb`);
    return count < 0 ? 0 : count;
  }, dbName);
}

async function isLeader(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__isLeader?.() ?? false);
}

test.describe('Shared multi-tab engine', () => {
  test('elects exactly one leader across tabs', async ({ context }) => {
    const tabA = await newTab(context);
    expect(await openShared(tabA, 'shared-one')).toBeNull();

    const tabB = await newTab(context);
    expect(await openShared(tabB, 'shared-one')).toBeNull();

    const tabC = await newTab(context);
    expect(await openShared(tabC, 'shared-one')).toBeNull();

    // The browser will not grant an exclusive lock twice, so this cannot be
    // "usually one" — it is one.
    const leaders = [
      await isLeader(tabA),
      await isLeader(tabB),
      await isLeader(tabC),
    ].filter(Boolean);
    expect(leaders).toHaveLength(1);
  });

  test('a follower runs no engine of its own', async ({ context }) => {
    const tabA = await newTab(context);
    await openShared(tabA, 'shared-idle');
    const tabB = await newTab(context);
    await openShared(tabB, 'shared-idle');

    expect(await isLeader(tabA)).toBe(true);
    expect(await isLeader(tabB)).toBe(false);

    // The whole point of taking a factory rather than an instance: a follower
    // must not build a 9 MB engine to leave sitting idle.
    expect(await builtOwnEngine(tabA)).toBe(true);
    expect(await builtOwnEngine(tabB)).toBe(false);
    expect(await localStatements(tabA, 'shared-idle')).toBeGreaterThan(0);
  });

  test("a follower's writes execute on the leader's engine", async ({
    context,
  }) => {
    const tabA = await newTab(context);
    await openShared(tabA, 'shared-writes');
    const tabB = await newTab(context);
    await openShared(tabB, 'shared-writes');

    const before = await localStatements(tabA, 'shared-writes');

    await tabB.evaluate(async () => {
      await window.__db!.exec('INSERT INTO t VALUES (1)');
      await window.__db!.exec('INSERT INTO t VALUES (2)');
    });

    // The follower has no engine at all, so the statements can only have run
    // on the leader — which is what "shared" has to mean.
    expect(await localStatements(tabA, 'shared-writes')).toBe(before + 2);
    expect(await builtOwnEngine(tabB)).toBe(false);
  });

  test('a follower can read, and is answered by the leader', async ({
    context,
  }) => {
    const tabA = await newTab(context);
    await openShared(tabA, 'shared-reads');
    const tabB = await newTab(context);
    await openShared(tabB, 'shared-reads');

    const rows = await tabB.evaluate(async () => {
      const result = await window.__db!.query('SELECT * FROM t');
      return result.rows.length;
    });

    // The stub answers every query with its canned result set; what matters
    // is that an answer came back at all, across the channel.
    expect(rows).toBeGreaterThanOrEqual(0);
  });

  test('promotes a follower when the leading tab closes', async ({
    context,
  }) => {
    const tabA = await newTab(context);
    await openShared(tabA, 'shared-failover');
    const tabB = await newTab(context);
    await openShared(tabB, 'shared-failover');

    expect(await isLeader(tabA)).toBe(true);
    expect(await isLeader(tabB)).toBe(false);

    // No close(), no unload handler — the tab simply ceases to exist. Web
    // Locks release on death, which is the property the whole design rests on.
    await tabA.close();

    await expect
      .poll(() => isLeader(tabB), { timeout: 15_000 })
      .toBe(true);

    // And the new leader is a working database, not just a flag flipped.
    const worked = await tabB.evaluate(async () => {
      await window.__db!.exec('INSERT INTO t VALUES (3)');
      return true;
    });
    expect(worked).toBe(true);
    // Promotion means it built its own engine, not merely flipped a flag.
    expect(await builtOwnEngine(tabB)).toBe(true);
    expect(await localStatements(tabB, 'shared-failover')).toBeGreaterThan(0);
  });

  test('a third tab joins an election already settled', async ({ context }) => {
    const tabA = await newTab(context);
    await openShared(tabA, 'shared-late');
    const tabB = await newTab(context);
    await openShared(tabB, 'shared-late');

    // A tab arriving late hears no announcement — the leader made it before
    // this tab existed — so it has to ask. If `who-leads` regresses, this
    // hangs rather than failing an assertion, which is why the open itself is
    // the assertion.
    const tabC = await newTab(context);
    expect(await openShared(tabC, 'shared-late')).toBeNull();
    expect(await isLeader(tabC)).toBe(false);

    await tabC.evaluate(async () => {
      await window.__db!.exec('INSERT INTO t VALUES (4)');
    });
    expect(await builtOwnEngine(tabC)).toBe(false);
  });

  test('different databases elect independently', async ({ context }) => {
    const tabA = await newTab(context);
    const tabB = await newTab(context);

    await openShared(tabA, 'shared-alpha');
    await openShared(tabB, 'shared-beta');

    // Leadership is per database, not per origin: two tabs using different
    // databases must both run their own engine rather than one proxying to
    // the other.
    expect(await isLeader(tabA)).toBe(true);
    expect(await isLeader(tabB)).toBe(true);
  });
});
