/**
 * firebird-wasm/solid – SolidJS reactive signal adapters.
 *
 * ```tsx
 * // Root component
 * import { setFirebirdContext } from 'firebird-wasm/solid';
 * setFirebirdContext(db);
 *
 * // Child component
 * import { createLiveQuery } from 'firebird-wasm/solid';
 * const [done, setDone] = createSignal(false);
 * const todos = createLiveQuery(
 *   () => 'SELECT id, title FROM todos WHERE done = ? ORDER BY id',
 *   { params: () => [done()], events: ['todos'] },
 * );
 * // Read todos.rows(), todos.loading(), todos.error() in JSX
 * ```
 *
 * Powered by the framework-agnostic {@link QueryStore}. Automatically binds to
 * SolidJS `createSignal`, `createEffect`, and `onCleanup` when `solid-js` is
 * present or configured via {@link configureSolidPrimitives}, and falls back to
 * lightweight built-in signal accessors in standalone / test environments.
 */

import { QueryStore, queryKey, resolveStatement } from '../frameworks/query-store';
import type {
  QueryableDatabase,
  QueryState,
  QueryStoreOptions,
} from '../frameworks/query-store';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, Row } from '../types';

export type { QueryableDatabase, QueryState } from '../frameworks/query-store';

/** A SolidJS signal accessor `() => T`. */
export type Accessor<T> = () => T;

/** Either a plain value `T` or a SolidJS signal accessor `() => T`. */
export type MaybeAccessor<T> = T | Accessor<T>;

/** Minimal SolidJS reactive primitives used by `firebird-wasm/solid`. */
export interface SolidPrimitives {
  createSignal?: <T>(
    value: T,
    options?: { equals?: boolean | ((prev: T, next: T) => boolean) },
  ) => [get: Accessor<T>, set: (next: T) => T];
  createEffect?: (fn: () => void) => void;
  onCleanup?: (fn: () => void) => void;
}

/** Symbol key for Solid context registration. */
export const FIREBIRD_SOLID_KEY: unique symbol = Symbol('firebird-wasm/solid');

let customSolidPrimitives: SolidPrimitives | null = null;
let fallbackSolidDb: QueryableDatabase | null = null;

function resolveSolidPrimitives(): SolidPrimitives {
  if (customSolidPrimitives) {
    return customSolidPrimitives;
  }
  try {
    // Optional dynamic require so unit tests and environments without `solid-js`
    // work seamlessly while binding to native Solid signals when installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const solid = require('solid-js') as SolidPrimitives;
    if (solid && typeof solid === 'object') {
      return solid;
    }
  } catch {
    // `solid-js` not installed; built-in signal accessors are used.
  }
  return {};
}

/**
 * Configure explicit SolidJS reactive primitives (`createSignal`, `createEffect`,
 * `onCleanup`). Passing `null` resets to default auto-detection.
 */
export function configureSolidPrimitives(
  primitives: SolidPrimitives | null,
): void {
  customSolidPrimitives = primitives;
}

/**
 * Set the default `FirebirdBrowser` (or compatible {@link QueryableDatabase})
 * for Solid components calling {@link useFirebird}.
 */
export function setFirebirdContext<
  D extends QueryableDatabase = QueryableDatabase,
>(db: D): D {
  fallbackSolidDb = db;
  return db;
}

/**
 * Retrieve the database registered with {@link setFirebirdContext}.
 */
export function useFirebird<
  D extends QueryableDatabase = QueryableDatabase,
>(): D {
  if (fallbackSolidDb) {
    return fallbackSolidDb as D;
  }
  throw new Error(
    'useFirebird() found no database: call setFirebirdContext(db) above this component, ' +
      'or pass { db } to createQuery / createLiveQuery',
  );
}

/** Signal accessors and controls returned by {@link createQuery} and {@link createLiveQuery}. */
export interface SolidQueryResult<T extends Row = Row> {
  /** Signal accessor returning the latest rows (`undefined` before the first result). */
  rows: Accessor<T[] | undefined>;
  /** Signal accessor returning the latest error (`undefined` when the last run succeeded). */
  error: Accessor<Error | undefined>;
  /** Signal accessor returning `true` while the initial result for the current query is loading. */
  loading: Accessor<boolean>;
  /** Signal accessor returning the combined `{ rows, error, loading }` state. */
  state: Accessor<QueryState<T>>;
  /** Re-run the current statement immediately. */
  refresh(): Promise<void>;
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: (state: QueryState<T>) => void): () => void;
  /** Stop the query and clean up any active `POST_EVENT` listeners. */
  dispose(): void;
}

/** Options for {@link createQuery}. */
export interface CreateSolidQueryOptions {
  /** Explicit database instance (overrides {@link useFirebird}). */
  db?: QueryableDatabase;
}

/** Options for {@link createLiveQuery}. */
export interface CreateSolidLiveQueryOptions extends CreateSolidQueryOptions {
  /**
   * Firebird `POST_EVENT` names to watch. When omitted, `FirebirdBrowser.live()`
   * automatically infers the referenced tables from the SQL statement.
   */
  events?: MaybeAccessor<readonly string[] | undefined>;
  /** Query parameters when `query` is a SQL string with `?` placeholders. */
  params?: MaybeAccessor<QueryParams | undefined>;
  /** Event polling interval in milliseconds. @default 250 */
  pollIntervalMs?: number;
}

function unwrapAccessor<T>(value: MaybeAccessor<T>): T {
  return typeof value === 'function' ? (value as Accessor<T>)() : value;
}

function createFallbackSignal<T>(
  initial: T,
): [get: Accessor<T>, set: (next: T) => T] {
  let current = initial;
  return [
    () => current,
    (next: T) => {
      current = next;
      return current;
    },
  ];
}

/**
 * Run a SQL query and expose its `{ rows, error, loading }` as SolidJS signal
 * accessors. Re-runs automatically when reactive signal accessors in `query` or
 * `params` change.
 */
export function createQuery<T extends Row = Row>(
  query: MaybeAccessor<string | SqlFragment>,
  params?: MaybeAccessor<QueryParams | undefined>,
  options: CreateSolidQueryOptions = {},
): SolidQueryResult<T> {
  return createSolidStoreInternal<T>(options.db, query, params, () => ({}));
}

/**
 * Run a live SQL query backed by `FirebirdBrowser.live()` and expose its
 * `{ rows, error, loading }` as SolidJS signal accessors.
 */
export function createLiveQuery<T extends Row = Row>(
  query: MaybeAccessor<string | SqlFragment>,
  options: CreateSolidLiveQueryOptions = {},
): SolidQueryResult<T> {
  return createSolidStoreInternal<T>(
    options.db,
    query,
    options.params,
    () => {
      const events =
        options.events !== undefined
          ? unwrapAccessor(options.events)
          : undefined;
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
  );
}

function createSolidStoreInternal<T extends Row>(
  explicitDb: QueryableDatabase | undefined,
  query: MaybeAccessor<string | SqlFragment>,
  params: MaybeAccessor<QueryParams | undefined> | undefined,
  storeOptions: () => QueryStoreOptions,
): SolidQueryResult<T> {
  const db = explicitDb ?? useFirebird();
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;

  const initialState: QueryState<T> = {
    rows: undefined,
    error: undefined,
    loading: true,
  };

  const [getRows, setRows] = makeSignal<T[] | undefined>(undefined);
  const [getError, setError] = makeSignal<Error | undefined>(undefined);
  const [getLoading, setLoading] = makeSignal<boolean>(true);
  const [getState, setState] = makeSignal<QueryState<T>>(initialState);

  const listeners = new Set<(state: QueryState<T>) => void>();
  let store: QueryStore<T> | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let currentKey: string | undefined;
  let disposed = false;

  const computeTarget = () => {
    const statement = resolveStatement(
      unwrapAccessor(query),
      params !== undefined ? unwrapAccessor(params) : undefined,
    );
    const opts = storeOptions();
    return {
      statement,
      options: opts,
      key: queryKey(statement.sql, statement.params, opts),
    };
  };

  const applySnapshot = (snapshot: QueryState<T>) => {
    setRows(snapshot.rows);
    setError(snapshot.error);
    setLoading(snapshot.loading);
    setState(snapshot);
    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  };

  const syncTarget = () => {
    if (disposed) return;
    const { statement, options, key } = computeTarget();
    if (store && key === currentKey) {
      return;
    }
    currentKey = key;
    const next = new QueryStore<T>(
      db,
      statement.sql,
      statement.params,
      options,
      getRows(),
    );
    unsubscribeStore?.();
    store?.stop();
    store = next;

    const sync = () => {
      if (store === next) {
        applySnapshot(next.getSnapshot());
      }
    };
    unsubscribeStore = next.subscribe(sync);
    sync();
    next.start();
  };

  const dispose = () => {
    disposed = true;
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    store?.stop();
    store = undefined;
    listeners.clear();
  };

  // Run immediately (validates options synchronously and starts initial query).
  syncTarget();

  if (typeof primitives.createEffect === 'function') {
    try {
      primitives.createEffect(() => {
        syncTarget();
      });
    } catch {
      // Ignore if called outside a reactive root.
    }
  }

  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(dispose);
    } catch {
      // Ignore if called outside a reactive owner.
    }
  }

  return {
    rows: () => {
      syncTarget();
      return getRows();
    },
    error: () => {
      syncTarget();
      return getError();
    },
    loading: () => {
      syncTarget();
      return getLoading();
    },
    state: () => {
      syncTarget();
      return getState();
    },
    refresh: () => {
      syncTarget();
      return store?.refresh() ?? Promise.resolve();
    },
    subscribe: (listener: (state: QueryState<T>) => void) => {
      listeners.add(listener);
      listener(getState());
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };
}
