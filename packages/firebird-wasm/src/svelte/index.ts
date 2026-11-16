/**
 * firebird-wasm/svelte – Svelte 5 Runes & Svelte Store reactive adapters.
 *
 * ```ts
 * // Parent component
 * import { setFirebirdContext } from 'firebird-wasm/svelte';
 * setFirebirdContext(db);
 *
 * // Child component (Svelte 5 Runes or $store auto-subscription)
 * import { createLiveQuery } from 'firebird-wasm/svelte';
 * let done = $state(false);
 * const todos = createLiveQuery(
 *   () => 'SELECT id, title FROM todos WHERE done = ? ORDER BY id',
 *   { params: () => [done], events: ['todos'] },
 * );
 * // Use $todos.rows in templates or todos.rows with Svelte 5 Runes
 * ```
 *
 * Powered by the framework-agnostic {@link QueryStore}. Works with both
 * Svelte 5 Runes (reactive getter inputs + `.rows` / `.loading` / `.error`
 * getters) and Svelte's `Readable` store contract (`subscribe()`).
 */

import { QueryStore, queryKey, resolveStatement } from '../frameworks/query-store';
import type {
  QueryableDatabase,
  QueryState,
  QueryStoreOptions,
} from '../frameworks/query-store';
import {
  ColumnarQueryStore,
  IncrementalQueryStore,
  SyncStatusStore,
  type ColumnarQueryState,
  type ColumnarQueryableDatabase,
  type IncrementalQueryState,
  type IncrementalQueryableDatabase,
  type SyncHandleLike,
  type SyncStatusState,
  type SyncStatusStoreOptions,
} from '../frameworks/sync-store';
import type { ColumnarQueryResult } from '../columnar';
import type { LiveRowDelta, LiveRowKeySelector } from '../live-incremental';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, Row } from '../types';

export type { QueryableDatabase, QueryState } from '../frameworks/query-store';
export type {
  ColumnarQueryState,
  ColumnarQueryableDatabase,
  IncrementalQueryState,
  IncrementalQueryableDatabase,
  SyncHandleLike,
  SyncStatusState,
  SyncStatusStoreOptions,
} from '../frameworks/sync-store';

/** A value or a Svelte 5 Rune getter function `() => T`. */
export type MaybeGetter<T> = T | (() => T);

/** Optional Svelte runtime hooks for component context and lifecycle integration. */
export interface SveltePrimitives {
  setContext?: <T>(key: unknown, context: T) => T;
  getContext?: <T>(key: unknown) => T | undefined;
  onDestroy?: (fn: () => void) => void;
  /** Optional reactive state box factory (e.g. wrapping Svelte 5 `$state`). */
  createStateBox?: <T>(initial: T) => { get(): T; set(next: T): void };
}

/** Context key used by `setFirebirdContext` and `useFirebird`. */
export const FIREBIRD_CONTEXT_KEY: unique symbol = Symbol('firebird-wasm/svelte');

let customPrimitives: SveltePrimitives | null = null;
let fallbackContextDb: QueryableDatabase | null = null;

function resolveSveltePrimitives(): SveltePrimitives {
  if (customPrimitives) {
    return customPrimitives;
  }
  try {
    // Optional dynamic require so this module works without a hard `svelte` install
    // in pure store/unit-test environments while binding automatically when Svelte is present.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svelte = require('svelte') as SveltePrimitives;
    if (svelte && typeof svelte === 'object') {
      return svelte;
    }
  } catch {
    // Svelte not installed or ESM-only environment without require; fallback context is used.
  }
  return {};
}

/**
 * Configure explicit Svelte runtime primitives (`setContext`, `getContext`,
 * `onDestroy`, or a `$state` box factory). Passing `null` resets to default
 * auto-detection.
 */
export function configureSveltePrimitives(
  primitives: SveltePrimitives | null,
): void {
  customPrimitives = primitives;
}

/**
 * Provide a `FirebirdBrowser` (or compatible {@link QueryableDatabase}) in the
 * current Svelte component tree.
 */
export function setFirebirdContext<
  D extends QueryableDatabase = QueryableDatabase,
>(db: D): D {
  fallbackContextDb = db;
  const primitives = resolveSveltePrimitives();
  if (typeof primitives.setContext === 'function') {
    try {
      primitives.setContext(FIREBIRD_CONTEXT_KEY, db);
    } catch {
      // Called outside component initialization; fallbackContextDb still holds `db`.
    }
  }
  return db;
}

/**
 * Retrieve the database provided by {@link setFirebirdContext}.
 */
export function useFirebird<
  D extends QueryableDatabase = QueryableDatabase,
>(): D {
  const primitives = resolveSveltePrimitives();
  if (typeof primitives.getContext === 'function') {
    try {
      const ctx = primitives.getContext<D>(FIREBIRD_CONTEXT_KEY);
      if (ctx) return ctx;
    } catch {
      // Fall back to module-scoped context if called outside component init.
    }
  }
  if (fallbackContextDb) {
    return fallbackContextDb as D;
  }
  throw new Error(
    'useFirebird() found no database: call setFirebirdContext(db) in a parent component, ' +
      'or pass { db } in the query options',
  );
}

/** Alias for {@link useFirebird}. */
export const getFirebirdContext = useFirebird;

/**
 * Reactive query handle returned by {@link createQuery} and {@link createLiveQuery}.
 *
 * Implements Svelte's `Readable<QueryState<T>>` store contract (`subscribe`)
 * for `$query` syntax, and exposes reactive `.rows`, `.error`, and `.loading`
 * getters for Svelte 5 Runes templates.
 */
export interface SvelteQueryStore<T extends Row = Row> {
  /** Latest result rows (`undefined` before the first result). */
  readonly rows: T[] | undefined;
  /** Latest error (`undefined` when the last execution succeeded). */
  readonly error: Error | undefined;
  /** `true` until the current query's first result or error arrives. */
  readonly loading: boolean;
  /** Current immutable snapshot `{ rows, error, loading }`. */
  readonly current: QueryState<T>;
  /** Svelte `Readable` store subscription (`$store` syntax). */
  subscribe(run: (value: QueryState<T>) => void): () => void;
  /** Re-run the current statement immediately. */
  refresh(): Promise<void>;
  /**
   * Re-evaluate reactive getter arguments (SQL, params, or events) and
   * restart the underlying `QueryStore` if the query key changed.
   */
  update(): void;
  /** Stop the underlying query and release any live event subscriptions. */
  destroy(): void;
}

/** Options for {@link createQuery}. */
export interface CreateSvelteQueryOptions {
  /** Explicit database instance (overrides {@link useFirebird}). */
  db?: QueryableDatabase;
  /**
   * Start executing the query immediately on creation even before `.subscribe()`
   * is called. Defaults to `true` so Svelte 5 Runes consumers reading `.rows`
   * directly do not need `$store` auto-subscription.
   *
   * @default true
   */
  autoStart?: boolean;
}

/** Options for {@link createLiveQuery}. */
export interface CreateSvelteLiveQueryOptions extends CreateSvelteQueryOptions {
  /**
   * Firebird `POST_EVENT` names to watch. When omitted, `FirebirdBrowser.live()`
   * automatically infers the referenced tables from the SQL statement.
   */
  events?: MaybeGetter<readonly string[] | undefined>;
  /** Query parameters when `query` is a SQL string with `?` placeholders. */
  params?: MaybeGetter<QueryParams | undefined>;
  /** Event polling interval in milliseconds. @default 250 */
  pollIntervalMs?: number;
}

function unwrapGetter<T>(value: MaybeGetter<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

/**
 * Create a reactive one-shot query for Svelte 5 Runes and Svelte stores.
 */
export function createQuery<T extends Row = Row>(
  query: MaybeGetter<string | SqlFragment>,
  params?: MaybeGetter<QueryParams | undefined>,
  options: CreateSvelteQueryOptions = {},
): SvelteQueryStore<T> {
  return createSvelteStoreInternal<T>(
    options.db,
    query,
    params,
    () => ({}),
    options.autoStart ?? true,
  );
}

/**
 * Create a reactive live query for Svelte 5 Runes and Svelte stores that
 * automatically re-runs when Firebird `POST_EVENT` notifications fire.
 */
export function createLiveQuery<T extends Row = Row>(
  query: MaybeGetter<string | SqlFragment>,
  options: CreateSvelteLiveQueryOptions = {},
): SvelteQueryStore<T> {
  return createSvelteStoreInternal<T>(
    options.db,
    query,
    options.params,
    () => {
      const events =
        options.events !== undefined ? unwrapGetter(options.events) : undefined;
      if (events !== undefined && events.length === 0) {
        throw new RangeError(
          'createLiveQuery() needs at least one event name; createQuery() runs a statement once',
        );
      }
      return {
        events: events !== undefined ? [...events] : undefined,
        live: true,
        pollIntervalMs: options.pollIntervalMs,
      };
    },
    options.autoStart ?? true,
  );
}

function createSvelteStoreInternal<T extends Row>(
  explicitDb: QueryableDatabase | undefined,
  query: MaybeGetter<string | SqlFragment>,
  params: MaybeGetter<QueryParams | undefined> | undefined,
  storeOptions: () => QueryStoreOptions,
  autoStart: boolean,
): SvelteQueryStore<T> {
  const db = explicitDb ?? useFirebird();
  const primitives = resolveSveltePrimitives();

  const initialState: QueryState<T> = {
    rows: undefined,
    error: undefined,
    loading: true,
  };
  const stateBox = primitives.createStateBox
    ? primitives.createStateBox<QueryState<T>>(initialState)
    : {
        value: initialState,
        get() {
          return this.value;
        },
        set(next: QueryState<T>) {
          this.value = next;
        },
      };

  const subscribers = new Set<(value: QueryState<T>) => void>();
  let store: QueryStore<T> | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let currentKey: string | undefined;
  let destroyed = false;

  const computeTarget = () => {
    const statement = resolveStatement(
      unwrapGetter(query),
      params !== undefined ? unwrapGetter(params) : undefined,
    );
    const opts = storeOptions();
    return {
      statement,
      options: opts,
      key: queryKey(statement.sql, statement.params, opts),
    };
  };

  const notifySubscribers = (snapshot: QueryState<T>) => {
    stateBox.set(snapshot);
    for (const run of [...subscribers]) {
      run(snapshot);
    }
  };

  const ensureStore = (shouldStart: boolean) => {
    if (destroyed) return;
    const { statement, options, key } = computeTarget();
    if (store && key === currentKey) {
      if (shouldStart) {
        store.start();
      }
      return;
    }

    currentKey = key;
    const previousRows = stateBox.get().rows;
    const next = new QueryStore<T>(
      db,
      statement.sql,
      statement.params,
      options,
      previousRows,
    );
    unsubscribeStore?.();
    store?.stop();
    store = next;

    const sync = () => {
      if (store === next) {
        notifySubscribers(next.getSnapshot());
      }
    };
    unsubscribeStore = next.subscribe(sync);
    notifySubscribers(next.getSnapshot());

    if (shouldStart || subscribers.size > 0) {
      next.start();
    }
  };

  const destroy = () => {
    destroyed = true;
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    store?.stop();
    store = undefined;
    subscribers.clear();
  };

  if (typeof primitives.onDestroy === 'function') {
    try {
      primitives.onDestroy(destroy);
    } catch {
      // Ignore when called outside a Svelte component initialization context.
    }
  }

  // Eagerly evaluate options (so invalid options throw synchronously) and optionally start.
  ensureStore(autoStart);

  return {
    get rows(): T[] | undefined {
      ensureStore(autoStart || subscribers.size > 0);
      return stateBox.get().rows;
    },
    get error(): Error | undefined {
      ensureStore(autoStart || subscribers.size > 0);
      return stateBox.get().error;
    },
    get loading(): boolean {
      ensureStore(autoStart || subscribers.size > 0);
      return stateBox.get().loading;
    },
    get current(): QueryState<T> {
      ensureStore(autoStart || subscribers.size > 0);
      return stateBox.get();
    },
    subscribe(run: (value: QueryState<T>) => void): () => void {
      if (destroyed) {
        run(stateBox.get());
        return () => {};
      }
      subscribers.add(run);
      ensureStore(true);
      run(stateBox.get());
      return () => {
        subscribers.delete(run);
        if (subscribers.size === 0 && !autoStart) {
          store?.stop();
        }
      };
    },
    refresh(): Promise<void> {
      ensureStore(true);
      return store?.refresh() ?? Promise.resolve();
    },
    update(): void {
      ensureStore(autoStart || subscribers.size > 0);
    },
    destroy,
  };
}

/** Reactive Svelte store/Runes handle returned by {@link createSyncStatus} (`M20 Item 4`). */
export interface SvelteSyncStatusStore {
  readonly current: SyncStatusState;
  readonly state: SyncStatusState['state'];
  readonly paused: boolean;
  readonly syncing: boolean;
  readonly lagEntries: number;
  readonly dlqCount: number;
  readonly error: Error | undefined;
  subscribe(run: (value: SyncStatusState) => void): () => void;
  syncNow(): Promise<void>;
  pause(): void;
  resume(): void;
  refresh(): Promise<void>;
  destroy(): void;
}

/** Create a Svelte 5 Runes / `Readable` store tracking a `SyncHandle` (`M20 Item 4`). */
export function createSyncStatus(
  handle: MaybeGetter<SyncHandleLike | null | undefined>,
  options: SyncStatusStoreOptions = {},
): SvelteSyncStatusStore {
  const primitives = resolveSveltePrimitives();
  const initialHandle = unwrapGetter(handle);
  const store = new SyncStatusStore(initialHandle, options);
  const subscribers = new Set<(value: SyncStatusState) => void>();
  let currentVal = store.getSnapshot();
  const stateBox = primitives.createStateBox
    ? primitives.createStateBox<SyncStatusState>(currentVal)
    : {
        get: () => currentVal,
        set: (next: SyncStatusState) => {
          currentVal = next;
        },
      };

  const unsub = store.subscribe(() => {
    const snap = store.getSnapshot();
    stateBox.set(snap);
    for (const run of [...subscribers]) run(snap);
  });
  store.start();

  const destroy = () => {
    unsub();
    store.stop();
    subscribers.clear();
  };

  if (typeof primitives.onDestroy === 'function') {
    try {
      primitives.onDestroy(destroy);
    } catch {
      // Ignore outside component context
    }
  }

  return {
    get current() {
      return stateBox.get();
    },
    get state() {
      return stateBox.get().state;
    },
    get paused() {
      return stateBox.get().paused;
    },
    get syncing() {
      return stateBox.get().syncing;
    },
    get lagEntries() {
      return stateBox.get().lagEntries;
    },
    get dlqCount() {
      return stateBox.get().dlqCount;
    },
    get error() {
      return stateBox.get().error;
    },
    subscribe(run) {
      subscribers.add(run);
      run(stateBox.get());
      return () => {
        subscribers.delete(run);
      };
    },
    syncNow: () => store.syncNow(),
    pause: () => store.pause(),
    resume: () => store.resume(),
    refresh: () => store.refresh(),
    destroy,
  };
}

/** Reactive Svelte store/Runes handle returned by {@link createColumnarQuery} (`M20 Item 4`). */
export interface SvelteColumnarStore {
  readonly result: ColumnarQueryResult | undefined;
  readonly version: number;
  readonly error: Error | undefined;
  readonly loading: boolean;
  readonly current: ColumnarQueryState;
  subscribe(run: (value: ColumnarQueryState) => void): () => void;
  refresh(): Promise<void>;
  destroy(): void;
}

/** Create a one-shot or live columnar query store for Svelte (`M20 Item 4`). */
export function createColumnarQuery(
  query: MaybeGetter<string | SqlFragment>,
  options: {
    db?: ColumnarQueryableDatabase;
    events?: MaybeGetter<readonly string[] | undefined>;
    live?: boolean;
    params?: MaybeGetter<QueryParams | undefined>;
    pollIntervalMs?: number;
  } = {},
): SvelteColumnarStore {
  const primitives = resolveSveltePrimitives();
  const db = (options.db ?? useFirebird()) as ColumnarQueryableDatabase;
  const stmt = resolveStatement(unwrapGetter(query), unwrapGetter(options.params));
  const evs = options.events !== undefined ? unwrapGetter(options.events) : undefined;
  const store = new ColumnarQueryStore(db, stmt.sql, stmt.params, {
    events: evs !== undefined ? [...evs] : undefined,
    live: options.live,
    pollIntervalMs: options.pollIntervalMs,
  });
  const subscribers = new Set<(value: ColumnarQueryState) => void>();
  let currentVal = store.getSnapshot();
  const stateBox = primitives.createStateBox
    ? primitives.createStateBox<ColumnarQueryState>(currentVal)
    : {
        get: () => currentVal,
        set: (next: ColumnarQueryState) => {
          currentVal = next;
        },
      };

  const unsub = store.subscribe(() => {
    const snap = store.getSnapshot();
    stateBox.set(snap);
    for (const run of [...subscribers]) run(snap);
  });
  store.start();

  const destroy = () => {
    unsub();
    store.stop();
    subscribers.clear();
  };

  if (typeof primitives.onDestroy === 'function') {
    try {
      primitives.onDestroy(destroy);
    } catch {
      // Ignore outside component context
    }
  }

  return {
    get result() {
      return stateBox.get().result;
    },
    get version() {
      return stateBox.get().version;
    },
    get error() {
      return stateBox.get().error;
    },
    get loading() {
      return stateBox.get().loading;
    },
    get current() {
      return stateBox.get();
    },
    subscribe(run) {
      subscribers.add(run);
      run(stateBox.get());
      return () => {
        subscribers.delete(run);
      };
    },
    refresh: () => store.refresh(),
    destroy,
  };
}

/** Reactive Svelte store/Runes handle returned by {@link createLiveIncrementalQuery} (`M20 Item 4`). */
export interface SvelteIncrementalStore<T = Row> {
  readonly rows: readonly T[] | undefined;
  readonly deltas: readonly LiveRowDelta<T>[];
  readonly version: number;
  readonly error: Error | undefined;
  readonly loading: boolean;
  readonly current: IncrementalQueryState<T>;
  subscribe(run: (value: IncrementalQueryState<T>) => void): () => void;
  refresh(): Promise<void>;
  destroy(): void;
}

/** Create an incremental `{ rows, deltas }` live query store for Svelte (`M20 Item 4`). */
export function createLiveIncrementalQuery<T extends Row = Row>(
  query: MaybeGetter<string | SqlFragment>,
  options: {
    db?: IncrementalQueryableDatabase;
    key?: LiveRowKeySelector<T>;
    events?: MaybeGetter<readonly string[] | undefined>;
    params?: MaybeGetter<QueryParams | undefined>;
    pollIntervalMs?: number;
  } = {},
): SvelteIncrementalStore<T> {
  const primitives = resolveSveltePrimitives();
  const db = (options.db ?? useFirebird()) as IncrementalQueryableDatabase;
  const stmt = resolveStatement(unwrapGetter(query), unwrapGetter(options.params));
  const evs = options.events !== undefined ? unwrapGetter(options.events) : undefined;
  const store = new IncrementalQueryStore<T>(db, stmt.sql, stmt.params, {
    key: options.key,
    events: evs !== undefined ? [...evs] : undefined,
    pollIntervalMs: options.pollIntervalMs,
  });
  const subscribers = new Set<(value: IncrementalQueryState<T>) => void>();
  let currentVal = store.getSnapshot();
  const stateBox = primitives.createStateBox
    ? primitives.createStateBox<IncrementalQueryState<T>>(currentVal)
    : {
        get: () => currentVal,
        set: (next: IncrementalQueryState<T>) => {
          currentVal = next;
        },
      };

  const unsub = store.subscribe(() => {
    const snap = store.getSnapshot();
    stateBox.set(snap);
    for (const run of [...subscribers]) run(snap);
  });
  store.start();

  const destroy = () => {
    unsub();
    store.stop();
    subscribers.clear();
  };

  if (typeof primitives.onDestroy === 'function') {
    try {
      primitives.onDestroy(destroy);
    } catch {
      // Ignore outside component context
    }
  }

  return {
    get rows() {
      return stateBox.get().rows;
    },
    get deltas() {
      return stateBox.get().deltas;
    },
    get version() {
      return stateBox.get().version;
    },
    get error() {
      return stateBox.get().error;
    },
    get loading() {
      return stateBox.get().loading;
    },
    get current() {
      return stateBox.get();
    },
    subscribe(run) {
      subscribers.add(run);
      run(stateBox.get());
      return () => {
        subscribers.delete(run);
      };
    },
    refresh: () => store.refresh(),
    destroy,
  };
}
