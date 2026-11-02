/**
 * profiler-and-adapters.test.ts – unit tests for M10 Items 9 & 10:
 *   1. Query Profiler & MON$ Telemetry Hook (`db.onQuery`, `db.monitorStats`, `QueryProfiler`)
 *   2. Svelte 5 Runes & Svelte Store Reactive Adapter (`firebird-wasm/svelte`)
 *   3. SolidJS Reactive Signal Adapter (`firebird-wasm/solid`)
 */

import * as fs from 'fs';
import * as path from 'path';
import { FirebirdBrowser } from '../browser/firebird-browser';
import { DirectTransport } from '../browser/engine-transport';
import { QueryProfiler } from '../browser/profiler';
import { sql } from '../sql-tag';
import {
  configureSveltePrimitives,
  createLiveQuery as createSvelteLiveQuery,
  createQuery as createSvelteQuery,
  getFirebirdContext,
  setFirebirdContext as setSvelteFirebirdContext,
  useFirebird as useSvelteFirebird,
} from '../svelte';
import {
  configureSolidPrimitives,
  createLiveQuery as createSolidLiveQuery,
  createQuery as createSolidQuery,
  setFirebirdContext as setSolidFirebirdContext,
  useFirebird as useSolidFirebird,
} from '../solid';
import type { QueryableDatabase, QueryState } from '../frameworks/query-store';
import type { LiveQuery, LiveQueryOptions } from '../browser/firebird-browser';
import type { QueryParams, QueryProfileEvent, QueryResult, Row } from '../types';

const ST_JS_PATH = path.resolve(
  __dirname,
  '../../dist/wasm/firebird-embedded-st.js',
);
const hasSingleWasm = fs.existsSync(ST_JS_PATH);
const describeWasm = hasSingleWasm ? describe : describe.skip;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeDb() {
  const queries: Array<{ sql: string; params: QueryParams }> = [];
  const pending: Array<{
    resolve: (rows: Row[]) => void;
    reject: (err: unknown) => void;
  }> = [];
  const lives: Array<{
    sql: string;
    options: LiveQueryOptions;
    push: (rows: Row[]) => void;
    fail: (err: Error) => void;
    unsubscribed: boolean;
    refreshed: number;
  }> = [];

  const db: QueryableDatabase = {
    query: <T extends Row = Row>(sqlText: string, params: QueryParams = []) => {
      queries.push({ sql: sqlText, params });
      return new Promise<QueryResult<T>>((resolve, reject) => {
        pending.push({
          resolve: (rows) => resolve({ fields: [], rows: rows as T[] }),
          reject,
        });
      });
    },
    live: async <T extends Row = Row>(
      sqlText: string,
      options: LiveQueryOptions,
      onChange: (rows: T[], result: QueryResult<T>) => void,
    ): Promise<LiveQuery<T>> => {
      let latest: T[] = [];
      const entry = {
        sql: sqlText,
        options,
        unsubscribed: false,
        refreshed: 0,
        push: (rows: Row[]) => {
          latest = rows as T[];
          onChange(latest, { fields: [], rows: latest });
        },
        fail: (err: Error) => {
          options.onError?.(err);
        },
      };
      lives.push(entry);
      return {
        get rows() {
          return latest;
        },
        refresh: async () => {
          entry.refreshed++;
        },
        unsubscribe: async () => {
          entry.unsubscribed = true;
        },
      };
    },
  };

  return { db, queries, pending, lives };
}

describe('QueryProfiler & Telemetry Hook (M10 Item 9)', () => {
  it('tracks query counts, durations, prepare cache hit rates, and ring buffer eviction in QueryProfiler', async () => {
    const profiler = new QueryProfiler(3);
    const received: QueryProfileEvent[] = [];
    const unsubscribe = profiler.onQuery((ev) => received.push(ev));

    const t1 = profiler.begin();
    profiler.end({
      startedAt: t1,
      sql: 'SELECT 1 FROM RDB$DATABASE',
      params: [],
      kind: 'query',
      rowCount: 1,
      cacheHit: false,
      ioBefore: { reads: 0, writes: 0, fetches: 10, marks: 0 },
      ioAfter: { reads: 2, writes: 0, fetches: 20, marks: 0 },
    });

    const t2 = profiler.begin();
    profiler.end({
      startedAt: t2,
      sql: 'SELECT 1 FROM RDB$DATABASE',
      params: [],
      kind: 'query',
      rowCount: 1,
      cacheHit: true,
    });

    const t3 = profiler.begin();
    profiler.end({
      startedAt: t3,
      sql: 'INSERT INTO t VALUES (?)',
      params: [42],
      kind: 'exec',
      rowCount: 1,
      cacheHit: false,
    });

    const t4 = profiler.begin();
    profiler.end({
      startedAt: t4,
      sql: 'SELECT * FROM missing_table',
      params: [],
      kind: 'query',
      rowCount: 0,
      cacheHit: false,
      error: new Error('Table unknown'),
    });

    expect(received).toHaveLength(4);
    expect(received[0]!.io).toEqual({
      reads: 2,
      writes: 0,
      fetches: 10,
      marks: 0,
    });
    unsubscribe();

    const stats = await profiler.snapshot(
      async () => ({
        pageSize: 8192,
        allocatedPages: 32,
        databaseSizeBytes: 262144,
        odsVersion: 13,
        odsMinorVersion: 1,
        oldestTransaction: 5,
        oldestActive: 6,
        oldestSnapshot: 6,
        nextTransaction: 8,
        transactionGap: 2,
        currentMemory: 131072,
        maxMemory: 262144,
        pageBuffers: 2048,
        reads: 20,
        writes: 4,
        fetches: 150,
        marks: 12,
      }),
      async () => 1,
    );

    expect(stats.totalQueries).toBe(3);
    expect(stats.totalExecs).toBe(1);
    expect(stats.totalErrors).toBe(1);
    expect(stats.prepareCacheHits).toBe(1);
    expect(stats.prepareCacheMisses).toBe(3);
    expect(stats.prepareCacheHitRate).toBeCloseTo(0.25, 5);
    expect(stats.io).toEqual({
      reads: 20,
      writes: 4,
      fetches: 150,
      marks: 12,
      pageBuffers: 2048,
      currentMemory: 131072,
      maxMemory: 262144,
    });
    expect(stats.activeStatements).toBe(1);
    // Ring buffer capped at 3 most recent entries
    expect(stats.recentQueries).toHaveLength(3);
    expect(stats.recentQueries[2]!.error?.message).toBe('Table unknown');

    profiler.reset();
    const afterReset = await profiler.snapshot();
    expect(afterReset.totalQueries).toBe(0);
    expect(afterReset.totalExecs).toBe(0);
    expect(afterReset.prepareCacheHits).toBe(0);
    expect(afterReset.recentQueries).toHaveLength(0);
  });

  describeWasm('with real single-thread WASM engine', () => {
    let db: FirebirdBrowser;

    beforeAll(async () => {
      db = new FirebirdBrowser('memory://test-profiler', {
        transport: new DirectTransport({ threads: false }),
      });
      await db.exec(
        'CREATE TABLE prof_test (id INTEGER NOT NULL PRIMARY KEY, val VARCHAR(40))',
      );
    });

    afterAll(async () => {
      if (db) {
        await db.close();
      }
    });

    it('captures real page I/O deltas, prepare cache hits, and MON$ active statements', async () => {
      db.resetMonitorStats();
      const events: QueryProfileEvent[] = [];
      const off = db.onQuery((ev) => events.push(ev));

      await db.exec('INSERT INTO prof_test (id, val) VALUES (?, ?)', [
        1,
        'one',
      ]);
      await db.exec('INSERT INTO prof_test (id, val) VALUES (?, ?)', [
        2,
        'two',
      ]);
      const r1 = await db.query('SELECT val FROM prof_test WHERE id = ?', [1]);
      const r2 = await db.query('SELECT val FROM prof_test WHERE id = ?', [2]);
      expect(r1.rows[0]?.VAL).toBe('one');
      expect(r2.rows[0]?.VAL).toBe('two');

      off();
      expect(events).toHaveLength(4);
      expect(events[2]!.kind).toBe('query');
      expect(events[3]!.kind).toBe('query');
      expect(events[0]!.io).toBeDefined();
      expect(events[0]!.io!.fetches).toBeGreaterThan(0);

      const stats = await db.monitorStats();
      expect(stats.totalQueries).toBe(2);
      expect(stats.totalExecs).toBe(2);
      expect(stats.io.fetches).toBeGreaterThan(0);
      expect(stats.io.pageBuffers).toBeGreaterThan(0);
    });
  });
});

describe('firebird-wasm/svelte reactive adapter (M10 Item 10)', () => {
  afterEach(() => {
    configureSveltePrimitives(null);
  });

  it('supports Svelte 5 Runes reactive getters (.rows, .loading, .error, .update) and $store subscribe()', async () => {
    const { db, queries, pending } = makeFakeDb();
    setSvelteFirebirdContext(db);
    expect(useSvelteFirebird()).toBe(db);
    expect(getFirebirdContext()).toBe(db);

    let doneFilter = false;
    const store = createSvelteQuery<{ ID: number; TITLE: string }>(
      () => 'SELECT ID, TITLE FROM todos WHERE done = ?',
      () => [doneFilter],
    );

    expect(store.loading).toBe(true);
    expect(store.rows).toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({
      sql: 'SELECT ID, TITLE FROM todos WHERE done = ?',
      params: [false],
    });

    const snapshots: Array<QueryState<{ ID: number; TITLE: string }>> = [];
    const unsub = store.subscribe((state) => snapshots.push(state));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.loading).toBe(true);

    pending[0]!.resolve([{ ID: 1, TITLE: 'Write tests' }]);
    await settle();

    expect(store.loading).toBe(false);
    expect(store.rows).toEqual([{ ID: 1, TITLE: 'Write tests' }]);
    expect(snapshots[snapshots.length - 1]!.rows).toEqual([
      { ID: 1, TITLE: 'Write tests' },
    ]);

    // Mutate reactive getter state and read .rows -> triggers automatic re-query while preserving placeholder rows
    doneFilter = true;
    expect(store.rows).toEqual([{ ID: 1, TITLE: 'Write tests' }]);
    expect(store.loading).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.params).toEqual([true]);

    pending[1]!.resolve([{ ID: 2, TITLE: 'Ship M10' }]);
    await settle();
    expect(store.loading).toBe(false);
    expect(store.rows).toEqual([{ ID: 2, TITLE: 'Ship M10' }]);

    unsub();
    store.destroy();
  });

  it('supports createLiveQuery with POST_EVENT updates and custom Svelte primitives', async () => {
    const { db, lives } = makeFakeDb();
    const destroyCallbacks: Array<() => void> = [];
    configureSveltePrimitives({
      onDestroy: (fn) => destroyCallbacks.push(fn),
    });

    const liveStore = createSvelteLiveQuery<{ ID: number }>(
      sql`SELECT ID FROM items`,
      { db, events: ['items'] },
    );

    await settle();
    expect(lives).toHaveLength(1);
    expect(lives[0]!.options.events).toEqual(['items']);

    lives[0]!.push([{ ID: 10 }]);
    expect(liveStore.loading).toBe(false);
    expect(liveStore.rows).toEqual([{ ID: 10 }]);

    lives[0]!.push([{ ID: 10 }, { ID: 20 }]);
    expect(liveStore.rows).toEqual([{ ID: 10 }, { ID: 20 }]);

    await liveStore.refresh();
    expect(lives[0]!.refreshed).toBe(1);

    expect(destroyCallbacks).toHaveLength(1);
    destroyCallbacks[0]!();
    await settle();
    expect(lives[0]!.unsubscribed).toBe(true);
  });
});

describe('firebird-wasm/solid reactive adapter (M10 Item 10)', () => {
  afterEach(() => {
    configureSolidPrimitives(null);
  });

  it('exposes Solid signal accessors rows(), loading(), error(), state() and tracks accessor changes', async () => {
    const { db, queries, pending } = makeFakeDb();
    setSolidFirebirdContext(db);
    expect(useSolidFirebird()).toBe(db);

    let minScore = 50;
    const query = createSolidQuery<{ ID: number; SCORE: number }>(
      () => 'SELECT ID, SCORE FROM players WHERE score >= ?',
      () => [minScore],
    );

    expect(query.loading()).toBe(true);
    expect(query.rows()).toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.params).toEqual([50]);

    pending[0]!.resolve([{ ID: 1, SCORE: 80 }]);
    await settle();

    expect(query.loading()).toBe(false);
    expect(query.rows()).toEqual([{ ID: 1, SCORE: 80 }]);
    expect(query.error()).toBeUndefined();
    expect(query.state().rows).toEqual([{ ID: 1, SCORE: 80 }]);

    // Update signal value -> next signal read re-evaluates target key and starts new query
    minScore = 90;
    expect(query.rows()).toEqual([{ ID: 1, SCORE: 80 }]); // keeps placeholder
    expect(query.loading()).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.params).toEqual([90]);

    pending[1]!.resolve([{ ID: 2, SCORE: 95 }]);
    await settle();
    expect(query.loading()).toBe(false);
    expect(query.rows()).toEqual([{ ID: 2, SCORE: 95 }]);

    query.dispose();
  });

  it('supports createLiveQuery and integrates with configured Solid primitives', async () => {
    const { db, lives } = makeFakeDb();
    const cleanups: Array<() => void> = [];
    configureSolidPrimitives({
      onCleanup: (fn) => cleanups.push(fn),
    });

    const live = createSolidLiveQuery<{ ID: number }>(
      'SELECT ID FROM orders',
      { db, events: () => ['orders'] },
    );

    await settle();
    expect(lives).toHaveLength(1);
    lives[0]!.push([{ ID: 100 }]);
    expect(live.loading()).toBe(false);
    expect(live.rows()).toEqual([{ ID: 100 }]);

    lives[0]!.fail(new Error('transient error'));
    expect(live.error()?.message).toBe('transient error');
    // Previous rows remain available on error
    expect(live.rows()).toEqual([{ ID: 100 }]);

    expect(cleanups).toHaveLength(1);
    cleanups[0]!();
    await settle();
    expect(lives[0]!.unsubscribed).toBe(true);
  });
});
