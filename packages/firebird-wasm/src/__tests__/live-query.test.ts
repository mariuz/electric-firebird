/**
 * live() against a scripted transport, so the orderings that made the browser
 * test flaky can be forced instead of waited for.
 *
 * The fake models what matters about the engine and nothing else: a table that
 * grows by committed rows, a query that reads the rows committed when it
 * *starts* (and can be held open), and event subscriptions that count only the
 * posts made after they were created — what Firebird's events promise once the
 * subscription's baseline is in.
 */
import { FirebirdBrowser } from '../browser/firebird-browser';
import {
  extractReferencedTables,
  extractMutatedTables,
  liveTableEventName,
  CrossTabLiveBridge,
} from '../browser/live-tables';
import type { EngineTransport } from '../browser/engine-transport';

interface Gate {
  /** Resolves when the held query has started reading. */
  started: Promise<void>;
  /** Let the held query return. */
  release(): void;
}

class ScriptedEngine {
  committed = 0;
  queries = 0;
  executedDdl: string[] = [];
  /** The next query to start waits for its gate. */
  private nextGate: { started: () => void; wait: Promise<void> } | null = null;
  /** The next query to start throws this. */
  failNext: Error | null = null;
  private subscriptions = new Map<number, Record<string, number>>();
  private nextSubscription = 1;

  /** Commit one row, and post the event the way a trigger would. */
  insert(event = 'items_changed'): void {
    this.committed += 1;
    for (const pending of this.subscriptions.values()) {
      if (event in pending) pending[event] = (pending[event] ?? 0) + 1;
    }
  }

  /** Hold the next query open once it has read its rows. */
  holdNextQuery(): Gate {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const wait = new Promise<void>((r) => (release = r));
    this.nextGate = { started, wait };
    return { started: startedP, release };
  }

  get activeSubscriptions(): number {
    return this.subscriptions.size;
  }

  transport(): EngineTransport {
    const unused = (): never => {
      throw new Error('not used by these tests');
    };
    return {
      init: async () => undefined,
      createDatabase: async () => 1,
      attachDatabase: async () => 1,
      detachDatabase: async () => undefined,
      execute: async (_db, _tx, sql) => {
        this.executedDdl.push(sql);
        return 0;
      },
      executeBatch: unused,
      describe: unused,
      startTransaction: unused,
      commit: unused,
      rollback: unused,
      mkdir: async () => undefined,
      exists: async () => false,
      readFile: unused,
      writeFile: unused,
      unlink: async () => undefined,
      mountOpfs: unused,
      dispose: async () => undefined,
      query: (async () => {
        this.queries += 1;
        if (this.failNext) {
          const error = this.failNext;
          this.failNext = null;
          throw error;
        }
        // The snapshot is taken when the query starts, as a transaction's is.
        const rows = Array.from({ length: this.committed }, (_, i) => ({ ID: i + 1 }));
        const gate = this.nextGate;
        this.nextGate = null;
        if (gate) {
          gate.started();
          await gate.wait;
        }
        return { fields: [{ name: 'ID' }], rows };
      }) as EngineTransport['query'],
      eventsSubscribe: async (_db, names) => {
        const handle = this.nextSubscription++;
        this.subscriptions.set(handle, Object.fromEntries(names.map((n) => [n, 0])));
        return handle;
      },
      eventsPoll: async (handle) => {
        const pending = this.subscriptions.get(handle);
        if (!pending) throw new Error('unknown subscription');
        const counts = { ...pending };
        for (const name of Object.keys(pending)) pending[name] = 0;
        return counts;
      },
      eventsCancel: async (handle) => {
        this.subscriptions.delete(handle);
      },
    };
  }
}

const POLL_MS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `check` holds, or fail after `ms`. */
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await sleep(2);
  }
}

const opened: FirebirdBrowser[] = [];

function open(engine: ScriptedEngine): FirebirdBrowser {
  const db = new FirebirdBrowser('memory://live-query-test', {
    transport: engine.transport(),
    autoPersist: false,
  });
  opened.push(db);
  return db;
}

// Closing also stops every live query's polling, so a failed test cannot leave
// a timer behind to keep Jest alive.
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => undefined);
});

describe('live()', () => {
  it('refreshes again for an event heard while a refresh is running', async () => {
    const engine = new ScriptedEngine();
    const db = open(engine);
    const seen: number[] = [];
    const live = await db.live(
      'SELECT id FROM items',
      { events: ['items_changed'], pollIntervalMs: POLL_MS },
      (rows) => seen.push(rows.length),
    );
    expect(seen).toEqual([0]);

    // The first insert's refresh reads one row, then is held open...
    const gate = engine.holdNextQuery();
    engine.insert();
    await gate.started;

    // ...while the second insert commits and its event is polled.  The running
    // refresh read before this row existed, so it cannot be the one to show it.
    engine.insert();
    await sleep(POLL_MS * 5);
    gate.release();

    await until(() => live.rows.length === 2);
    // Exactly one more run for everything heard during the held one: the
    // one-at-a-time rule still holds, nothing piles up.
    await sleep(POLL_MS * 5);
    expect(seen).toEqual([0, 1, 2]);
    expect(engine.queries).toBe(3);

    await live.unsubscribe();
    await db.close();
  });

  it('sees a change committed while the first query runs', async () => {
    const engine = new ScriptedEngine();
    const db = open(engine);

    // The first query reads an empty table and is held open; meanwhile a row
    // commits.  Subscribing only after that query would miss its event
    // entirely: too late for the query, too early for the subscription.
    const gate = engine.holdNextQuery();
    const pending = db.live(
      'SELECT id FROM items',
      { events: ['items_changed'], pollIntervalMs: POLL_MS },
      () => undefined,
    );
    await gate.started;
    engine.insert();
    await sleep(POLL_MS * 5);
    gate.release();

    const live = await pending;
    await until(() => live.rows.length === 1);

    await live.unsubscribe();
    await db.close();
  });

  it('keeps refreshing after a refresh fails', async () => {
    const engine = new ScriptedEngine();
    const db = open(engine);
    const errors: Error[] = [];
    const live = await db.live(
      'SELECT id FROM items',
      { events: ['items_changed'], pollIntervalMs: POLL_MS, onError: (e) => errors.push(e) },
      () => undefined,
    );

    engine.failNext = new Error('lock conflict');
    engine.insert();
    await until(() => errors.length === 1);

    engine.insert();
    await until(() => live.rows.length === 2);

    await live.unsubscribe();
    await db.close();
  });

  it('releases its subscription when the first query fails', async () => {
    const engine = new ScriptedEngine();
    const db = open(engine);
    engine.failNext = new Error('no such table');

    await expect(
      db.live('SELECT id FROM missing', { events: ['items_changed'] }, () => undefined),
    ).rejects.toThrow('no such table');
    expect(engine.activeSubscriptions).toBe(0);

    await db.close();
  });

  it('auto-installs POST_EVENT triggers and watches referenced tables when events is omitted', async () => {
    const engine = new ScriptedEngine();
    const db = open(engine);
    const seen: number[] = [];

    // 2-argument form: db.live(sql, onChange) with no options object at all,
    // plus a second live query on the same table to verify trigger DDL runs once.
    const live1 = await db.live(
      'SELECT i.id FROM items i JOIN categories c ON c.id = i.cat_id',
      { pollIntervalMs: POLL_MS },
      (rows) => seen.push(rows.length),
    );
    const live2 = await db.live('SELECT id FROM items', () => undefined);

    // Trigger created once for ITEMS and once for CATEGORIES (not twice for ITEMS).
    expect(engine.executedDdl).toHaveLength(2);
    expect(engine.executedDdl[0]).toContain('FOR "ITEMS"');
    expect(engine.executedDdl[1]).toContain('FOR "CATEGORIES"');

    // Firing the auto-generated event for either table refreshes live1.
    engine.insert(liveTableEventName('CATEGORIES'));
    await until(() => live1.rows.length === 1);
    expect(seen).toEqual([0, 1]);

    await live1.unsubscribe();
    await live2.unsubscribe();
    await db.close();
  });

  it('rejects when events is omitted and the statement references no user tables', async () => {
    const engine = new ScriptedEngine();
    const db = open(engine);

    await expect(
      db.live('SELECT 1 FROM RDB$DATABASE', () => undefined),
    ).rejects.toThrow(RangeError);

    await db.close();
  });
});

describe('extractReferencedTables()', () => {
  it('extracts base tables from FROM, JOIN, comma joins, and subqueries while skipping CTEs, system tables, and functions with FROM', () => {
    expect(extractReferencedTables('SELECT id, name FROM todos WHERE done = FALSE ORDER BY id')).toEqual([
      'TODOS',
    ]);
    expect(
      extractReferencedTables(
        'SELECT a.id, b.name FROM items a LEFT JOIN categories b ON b.id = a.cat_id, tags t WHERE t.item_id = a.id',
      ),
    ).toEqual(['ITEMS', 'CATEGORIES', 'TAGS']);
    expect(
      extractReferencedTables(
        'WITH recent AS (SELECT * FROM notes), counts (id, c) AS (SELECT id, 1 FROM recent) ' +
          'SELECT * FROM counts JOIN authors ON authors.id = counts.id',
      ),
    ).toEqual(['NOTES', 'AUTHORS']);
    expect(
      extractReferencedTables(
        "SELECT EXTRACT(YEAR FROM created_at), TRIM(BOTH ' ' FROM title), SUBSTRING(title FROM 1 FOR 3) FROM articles",
      ),
    ).toEqual(['ARTICLES']);
    expect(
      extractReferencedTables('SELECT * FROM "MixedCase" JOIN my_proc(1, 2) ON 1=1 FROM RDB$DATABASE'),
    ).toEqual(['MixedCase']);

    // DML target extraction
    expect(extractMutatedTables("INSERT INTO todos (id, title) VALUES (1, 'buy milk')")).toEqual(['TODOS']);
    expect(extractMutatedTables('UPDATE OR INSERT INTO "MyNotes" (id) VALUES (1) MATCHING (id)')).toEqual(['MyNotes']);
    expect(extractMutatedTables('UPDATE items SET done = TRUE WHERE id = 1')).toEqual(['ITEMS']);
    expect(extractMutatedTables('DELETE FROM categories WHERE id = 2')).toEqual(['CATEGORIES']);
    expect(extractMutatedTables('MERGE INTO inventory i USING staging s ON (i.id = s.id) WHEN MATCHED THEN DELETE')).toEqual(['INVENTORY']);
    expect(extractMutatedTables('SELECT * FROM todos')).toEqual([]);
  });
});

describe('cross-tab reactive live queries (BroadcastChannel + POST_EVENT bridge)', () => {
  it('re-runs live queries in Tab B when Tab A executes DML or notify() on the same persistent DB', async () => {
    const engineA = new ScriptedEngine();
    const engineB = new ScriptedEngine();

    const dbA = new FirebirdBrowser('memory://shared-todos.fdb', {
      transport: engineA.transport(),
      autoPersist: false,
      crossTabLive: true,
    });
    const dbB = new FirebirdBrowser('memory://shared-todos.fdb', {
      transport: engineB.transport(),
      autoPersist: false,
      crossTabLive: true,
    });
    opened.push(dbA, dbB);

    const seenB: number[] = [];
    const liveB = await dbB.live(
      'SELECT id FROM items',
      { pollIntervalMs: 5000 }, // long poll interval to prove BroadcastChannel wakes it up immediately
      (rows) => seenB.push(rows.length),
    );
    expect(seenB).toEqual([0]);

    // Simulate Tab A committing a row (which also updates the shared backend state seen by B)
    engineB.committed = 1;
    await dbA.exec("INSERT INTO items (id) VALUES (1)");

    await until(() => liveB.rows.length === 1);
    expect(seenB).toEqual([0, 1]);

    // Also test explicit custom event notification across tabs
    const customSeen: number[] = [];
    const liveCustom = await dbB.live(
      'SELECT id FROM items',
      { events: ['custom_sync_done'], pollIntervalMs: 5000 },
      (rows) => customSeen.push(rows.length),
    );
    expect(customSeen).toEqual([1]);

    engineB.committed = 2;
    await dbA.notify('custom_sync_done');

    await until(() => liveCustom.rows.length === 2);
    expect(customSeen).toEqual([1, 2]);

    await liveB.unsubscribe();
    await liveCustom.unsubscribe();
    await dbA.close();
    await dbB.close();
  });

  it('ignores loopbacks from the same tab and isolates different channels', async () => {
    const bridgeA1 = new CrossTabLiveBridge({ dbName: 'idb://db1.fdb' });
    const bridgeA2 = new CrossTabLiveBridge({ dbName: 'idb://db1.fdb' });
    const bridgeOtherDb = new CrossTabLiveBridge({ dbName: 'idb://db2.fdb' });

    const receivedA1: string[] = [];
    const receivedA2: string[] = [];
    const receivedOther: string[] = [];

    bridgeA1.subscribe([liveTableEventName('TODOS')], (counts) => receivedA1.push(...Object.keys(counts)));
    bridgeA2.subscribe([liveTableEventName('TODOS')], (counts) => receivedA2.push(...Object.keys(counts)));
    bridgeOtherDb.subscribe([liveTableEventName('TODOS')], (counts) => receivedOther.push(...Object.keys(counts)));

    bridgeA1.broadcastTables(['TODOS']);
    await sleep(10);

    expect(receivedA1).toEqual([]);
    expect(receivedA2).toEqual([liveTableEventName('TODOS')]);
    expect(receivedOther).toEqual([]);

    bridgeA1.close();
    bridgeA2.close();
    bridgeOtherDb.close();
  });
});
