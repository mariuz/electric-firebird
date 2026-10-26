/**
 * query-store.test.ts – the store under the React and Vue bindings.
 *
 * Against a stand-in database whose results the test releases by hand, so
 * the orders that matter can be forced: a result arriving after the store
 * stopped, a live query resolving after it was stopped, a stop and a start of
 * the same store (React's StrictMode).  The bindings themselves run in a real
 * browser against the real engine (e2e/tests/browser-frameworks.spec.ts).
 */

import { QueryStore, queryKey } from '../frameworks/query-store';
import type { QueryableDatabase } from '../frameworks/query-store';
import type { FirebirdBrowser } from '../browser/firebird-browser';
import type { LiveQuery, LiveQueryOptions } from '../browser/firebird-browser';
import type { QueryResult, Row } from '../types';

// FirebirdBrowser is what the bindings are given; this fails to compile if it
// stops fitting the shape they rely on.
const fits: (db: FirebirdBrowser) => QueryableDatabase = (db) => db;
void fits;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const result = (rows: Row[]): QueryResult<Row> => ({ rows, fields: [] } as unknown as QueryResult<Row>);
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A database whose every call waits for the test to answer it. */
class FakeDb implements QueryableDatabase {
  queries: Array<{ sql: string; params: unknown[] | undefined; answer: Deferred<QueryResult<Row>> }> = [];
  lives: Array<{
    options: LiveQueryOptions;
    onChange: (rows: Row[], result: QueryResult<Row>) => void;
    answer: Deferred<LiveQuery<Row>>;
    unsubscribed: number;
    refreshed: number;
  }> = [];

  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const answer = deferred<QueryResult<Row>>();
    this.queries.push({ sql, params, answer });
    return answer.promise as Promise<QueryResult<T>>;
  }

  live<T extends Row = Row>(
    _sql: string,
    options: LiveQueryOptions,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>> {
    const answer = deferred<LiveQuery<Row>>();
    const entry = {
      options,
      onChange: onChange as unknown as (rows: Row[], result: QueryResult<Row>) => void,
      answer,
      unsubscribed: 0,
      refreshed: 0,
    };
    this.lives.push(entry);
    return answer.promise as unknown as Promise<LiveQuery<T>>;
  }

  /** Resolve live query `i` the way FirebirdBrowser does: first rows, then the handle. */
  openLive(i: number, rows: Row[]): void {
    const entry = this.lives[i]!;
    entry.onChange(rows, result(rows));
    entry.answer.resolve({
      rows,
      refresh: async () => {
        entry.refreshed++;
      },
      unsubscribe: async () => {
        entry.unsubscribed++;
      },
    });
  }
}

describe('QueryStore, one-off', () => {
  it('loads, then holds the rows, and tells its listeners', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT 1', []);
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));

    expect(store.getSnapshot()).toEqual({ rows: undefined, error: undefined, loading: true });
    store.start();
    db.queries[0]!.answer.resolve(result([{ N: 1 }]));
    await settle();

    expect(store.getSnapshot()).toEqual({ rows: [{ N: 1 }], error: undefined, loading: false });
    expect(seen).toHaveLength(1);
  });

  it('starts once however often start() is called', () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT 1', []);
    store.start();
    store.start();
    expect(db.queries).toHaveLength(1);
  });

  it('drops a result that arrives after stop()', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT 1', []);
    store.start();
    store.stop();
    db.queries[0]!.answer.resolve(result([{ N: 1 }]));
    await settle();
    expect(store.getSnapshot().loading).toBe(true);
    expect(store.getSnapshot().rows).toBeUndefined();
  });

  it("after a stop and a start (StrictMode), only the second run's result lands", async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT 1', []);
    store.start();
    store.stop();
    store.start();
    db.queries[1]!.answer.resolve(result([{ RUN: 2 }]));
    db.queries[0]!.answer.resolve(result([{ RUN: 1 }]));
    await settle();
    expect(store.getSnapshot().rows).toEqual([{ RUN: 2 }]);
  });

  it('reports an error and keeps the rows it had', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT 1', [], {}, [{ OLD: true }]);
    store.start();
    db.queries[0]!.answer.reject(new Error('table unknown'));
    await settle();
    expect(store.getSnapshot()).toEqual({
      rows: [{ OLD: true }],
      error: new Error('table unknown'),
      loading: false,
    });
  });

  it('refresh() runs the statement again, and its result clears the error', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT 1', [7]);
    store.start();
    db.queries[0]!.answer.reject(new Error('lock conflict'));
    await settle();

    const refreshed = store.refresh();
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]!.params).toEqual([7]);
    db.queries[1]!.answer.resolve(result([{ N: 1 }]));
    await refreshed;
    await settle();
    expect(store.getSnapshot()).toEqual({ rows: [{ N: 1 }], error: undefined, loading: false });
  });

  it('keeps the rows it was given while its own load', () => {
    const store = new QueryStore(new FakeDb(), 'SELECT 1', [], {}, [{ PREVIOUS: 1 }]);
    expect(store.getSnapshot()).toEqual({ rows: [{ PREVIOUS: 1 }], error: undefined, loading: true });
  });
});

describe('QueryStore, live', () => {
  it('runs through live() with the events, and follows every change', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT * FROM t', [1], { events: ['t'], pollIntervalMs: 20 });
    store.start();
    expect(db.queries).toHaveLength(0);
    expect(db.lives[0]!.options).toMatchObject({ events: ['t'], params: [1], pollIntervalMs: 20 });

    db.openLive(0, [{ ID: 1 }]);
    await settle();
    expect(store.getSnapshot().rows).toEqual([{ ID: 1 }]);

    db.lives[0]!.onChange([{ ID: 1 }, { ID: 2 }], result([]));
    expect(store.getSnapshot().rows).toEqual([{ ID: 1 }, { ID: 2 }]);
  });

  it('stop() unsubscribes, and later changes are ignored', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT * FROM t', [], { events: ['t'] });
    store.start();
    db.openLive(0, [{ ID: 1 }]);
    await settle();

    store.stop();
    await settle();
    expect(db.lives[0]!.unsubscribed).toBe(1);
    db.lives[0]!.onChange([], result([]));
    expect(store.getSnapshot().rows).toEqual([{ ID: 1 }]);
  });

  it('a live query that resolves after stop() is released, not leaked', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT * FROM t', [], { events: ['t'] });
    store.start();
    store.stop();
    db.openLive(0, [{ ID: 1 }]);
    await settle();
    expect(db.lives[0]!.unsubscribed).toBeGreaterThanOrEqual(1);
    expect(store.getSnapshot().rows).toBeUndefined();
  });

  it('refresh() asks the live query to refresh', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT * FROM t', [], { events: ['t'] });
    store.start();
    db.openLive(0, []);
    await store.refresh();
    expect(db.lives[0]!.refreshed).toBe(1);
  });

  it("an error from the live query's refreshes is reported", async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT * FROM t', [], { events: ['t'] });
    store.start();
    db.openLive(0, [{ ID: 1 }]);
    db.lives[0]!.options.onError!(new Error('deadlock'));
    expect(store.getSnapshot()).toEqual({ rows: [{ ID: 1 }], error: new Error('deadlock'), loading: false });
  });

  it('runs through live() with events: undefined when live: true is set (zero-config)', async () => {
    const db = new FakeDb();
    const store = new QueryStore(db, 'SELECT * FROM t', [42], { live: true, pollIntervalMs: 25 });
    store.start();
    expect(db.queries).toHaveLength(0);
    expect(db.lives).toHaveLength(1);
    expect(db.lives[0]!.options.events).toBeUndefined();
    expect(db.lives[0]!.options.params).toEqual([42]);

    db.openLive(0, [{ ID: 42 }]);
    await settle();
    expect(store.getSnapshot().rows).toEqual([{ ID: 42 }]);
  });
});

describe('queryKey', () => {
  it('is equal for equal statements, whatever the array identity', () => {
    expect(queryKey('SELECT ?', [1, 'a'])).toBe(queryKey('SELECT ?', [1, 'a']));
  });

  it('tells apart values JSON would merge', () => {
    const at = new Date(0);
    expect(queryKey('?', [at])).not.toBe(queryKey('?', [at.toISOString()]));
    expect(queryKey('?', [1n])).not.toBe(queryKey('?', [1]));
    expect(queryKey('?', [new Uint8Array([1, 2])])).not.toBe(queryKey('?', [[1, 2]]));
    expect(queryKey('?', [undefined])).not.toBe(queryKey('?', [null]));
  });

  it('includes the events, live flag, and the poll interval', () => {
    expect(queryKey('S', [], { events: ['a'] })).not.toBe(queryKey('S', [], { events: ['b'] }));
    expect(queryKey('S', [], { live: true })).not.toBe(queryKey('S', []));
    expect(queryKey('S', [], { events: ['a'], pollIntervalMs: 10 }))
      .not.toBe(queryKey('S', [], { events: ['a'], pollIntervalMs: 20 }));
  });
});
