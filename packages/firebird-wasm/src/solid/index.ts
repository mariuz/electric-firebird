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
import {
  createOptimisticMutationStore,
  ReactiveTableStore,
  type OptimisticMutationStore,
  type OptimisticMutationStoreOptions,
  type OptimisticStoreSnapshot,
  type ReactiveTableDatabase,
  type ReactiveTableState,
  type ReactiveTableStoreOptions,
} from '../optimistic-store';
import type { TableExecutionHost, TableRepository } from '../table-api';
import {
  createUndoRedoManager,
  type UndoRedoEntry,
  type UndoRedoManager,
  type UndoRedoOptions,
  type UndoRedoSnapshot,
} from '../undo-redo';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, Row } from '../types';

export type { QueryableDatabase, QueryState } from '../frameworks/query-store';
export type {
  OptimisticMutationStore,
  OptimisticMutationStoreOptions,
  OptimisticStoreSnapshot,
  ReactiveTableDatabase,
  ReactiveTableState,
  ReactiveTableStoreOptions,
} from '../optimistic-store';
export type {
  ColumnarQueryState,
  ColumnarQueryableDatabase,
  IncrementalQueryState,
  IncrementalQueryableDatabase,
  SyncHandleLike,
  SyncStatusState,
  SyncStatusStoreOptions,
} from '../frameworks/sync-store';

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

/** SolidJS signal accessors returned by {@link createSyncStatus} (`M20 Item 4`). */
export interface SolidSyncStatusResult {
  state: Accessor<SyncStatusState['state']>;
  paused: Accessor<boolean>;
  syncing: Accessor<boolean>;
  lagEntries: Accessor<number>;
  dlqCount: Accessor<number>;
  error: Accessor<Error | undefined>;
  snapshot: Accessor<SyncStatusState>;
  syncNow(): Promise<void>;
  pause(): void;
  resume(): void;
  refresh(): Promise<void>;
  dispose(): void;
}

/** Track a `SyncHandle` as SolidJS signal accessors (`M20 Item 4`). */
export function createSyncStatus(
  handle: MaybeAccessor<SyncHandleLike | null | undefined>,
  options: SyncStatusStoreOptions = {},
): SolidSyncStatusResult {
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;
  const store = new SyncStatusStore(unwrapAccessor(handle), options);
  const [getSnap, setSnap] = makeSignal<SyncStatusState>(store.getSnapshot());
  const unsub = store.subscribe(() => setSnap(store.getSnapshot()));
  store.start();

  const dispose = () => {
    unsub();
    store.stop();
  };

  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(dispose);
    } catch {
      // Ignore outside reactive owner
    }
  }

  return {
    state: () => getSnap().state,
    paused: () => getSnap().paused,
    syncing: () => getSnap().syncing,
    lagEntries: () => getSnap().lagEntries,
    dlqCount: () => getSnap().dlqCount,
    error: () => getSnap().error,
    snapshot: getSnap,
    syncNow: () => store.syncNow(),
    pause: () => store.pause(),
    resume: () => store.resume(),
    refresh: () => store.refresh(),
    dispose,
  };
}


/** SolidJS signal accessors returned by {@link createColumnarQuery} (`M20 Item 4`). */
export interface SolidColumnarResult {
  result: Accessor<ColumnarQueryResult | undefined>;
  version: Accessor<number>;
  error: Accessor<Error | undefined>;
  loading: Accessor<boolean>;
  state: Accessor<ColumnarQueryState>;
  refresh(): Promise<void>;
  dispose(): void;
}

/** Run a one-shot or live columnar query exposed as SolidJS signal accessors (`M20 Item 4`). */
export function createColumnarQuery(
  query: MaybeAccessor<string | SqlFragment>,
  options: {
    db?: ColumnarQueryableDatabase;
    events?: MaybeAccessor<readonly string[] | undefined>;
    live?: boolean;
    params?: MaybeAccessor<QueryParams | undefined>;
    pollIntervalMs?: number;
  } = {},
): SolidColumnarResult {
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;
  const db = (options.db ?? useFirebird()) as ColumnarQueryableDatabase;
  const stmt = resolveStatement(unwrapAccessor(query), unwrapAccessor(options.params));
  const evs = options.events !== undefined ? unwrapAccessor(options.events) : undefined;
  const store = new ColumnarQueryStore(db, stmt.sql, stmt.params, {
    events: evs !== undefined ? [...evs] : undefined,
    live: options.live,
    pollIntervalMs: options.pollIntervalMs,
  });
  const [getSnap, setSnap] = makeSignal<ColumnarQueryState>(store.getSnapshot());
  const unsub = store.subscribe(() => setSnap(store.getSnapshot()));
  store.start();

  const dispose = () => {
    unsub();
    store.stop();
  };

  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(dispose);
    } catch {
      // Ignore outside reactive owner
    }
  }

  return {
    result: () => getSnap().result,
    version: () => getSnap().version,
    error: () => getSnap().error,
    loading: () => getSnap().loading,
    state: getSnap,
    refresh: () => store.refresh(),
    dispose,
  };
}


/** SolidJS signal accessors returned by {@link createLiveIncrementalQuery} (`M20 Item 4`). */
export interface SolidIncrementalResult<T = Row> {
  rows: Accessor<readonly T[] | undefined>;
  deltas: Accessor<readonly LiveRowDelta<T>[]>;
  version: Accessor<number>;
  error: Accessor<Error | undefined>;
  loading: Accessor<boolean>;
  state: Accessor<IncrementalQueryState<T>>;
  refresh(): Promise<void>;
  dispose(): void;
}

/** Run an incremental `{ rows, deltas }` live query exposed as SolidJS signals (`M20 Item 4`). */
export function createLiveIncrementalQuery<T extends Row = Row>(
  query: MaybeAccessor<string | SqlFragment>,
  options: {
    db?: IncrementalQueryableDatabase;
    key?: LiveRowKeySelector<T>;
    events?: MaybeAccessor<readonly string[] | undefined>;
    params?: MaybeAccessor<QueryParams | undefined>;
    pollIntervalMs?: number;
  } = {},
): SolidIncrementalResult<T> {
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;
  const db = (options.db ?? useFirebird()) as IncrementalQueryableDatabase;
  const stmt = resolveStatement(unwrapAccessor(query), unwrapAccessor(options.params));
  const evs = options.events !== undefined ? unwrapAccessor(options.events) : undefined;
  const store = new IncrementalQueryStore<T>(db, stmt.sql, stmt.params, {
    key: options.key,
    events: evs !== undefined ? [...evs] : undefined,
    pollIntervalMs: options.pollIntervalMs,
  });
  const [getSnap, setSnap] = makeSignal<IncrementalQueryState<T>>(store.getSnapshot());
  const unsub = store.subscribe(() => setSnap(store.getSnapshot()));
  store.start();

  const dispose = () => {
    unsub();
    store.stop();
  };

  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(dispose);
    } catch {
      // Ignore outside reactive owner
    }
  }

  return {
    rows: () => getSnap().rows,
    deltas: () => getSnap().deltas,
    version: () => getSnap().version,
    error: () => getSnap().error,
    loading: () => getSnap().loading,
    state: getSnap,
    refresh: () => store.refresh(),
    dispose,
  };
}

/** SolidJS signal result returned by {@link createOptimisticMutation} (`M22 Item 3`). */
export interface SolidOptimisticMutationResult {
  readonly store: OptimisticMutationStore;
  state: Accessor<OptimisticStoreSnapshot>;
  pendingCount: Accessor<number>;
  flushing: Accessor<boolean>;
  lastError: Accessor<Error | undefined>;
  insert: OptimisticMutationStore['insert'];
  update: OptimisticMutationStore['update'];
  upsert: OptimisticMutationStore['upsert'];
  delete: OptimisticMutationStore['delete'];
  revert: OptimisticMutationStore['revert'];
  revertAll: OptimisticMutationStore['revertAll'];
  flush: OptimisticMutationStore['flush'];
  table: OptimisticMutationStore['table'];
  dispose(): void;
}

/** Create SolidJS signal accessors backed by {@link OptimisticMutationStore} (`M22 Item 3`). */
export function createOptimisticMutation(
  options: OptimisticMutationStoreOptions & {
    db?: TableExecutionHost;
    store?: OptimisticMutationStore;
  } = {},
): SolidOptimisticMutationResult {
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;
  const optStore =
    options.store ??
    createOptimisticMutationStore(
      (options.db ?? useFirebird()) as unknown as TableExecutionHost,
      options,
    );
  const [getSnap, setSnap] = makeSignal<OptimisticStoreSnapshot>(optStore.getSnapshot());
  const unsub = optStore.subscribe(() => setSnap(optStore.getSnapshot()));

  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(unsub);
    } catch {
      // Ignore outside reactive owner
    }
  }

  return {
    store: optStore,
    state: getSnap,
    pendingCount: () => getSnap().pendingCount,
    flushing: () => getSnap().flushing,
    lastError: () => getSnap().lastError,
    insert: optStore.insert,
    update: optStore.update,
    upsert: optStore.upsert,
    delete: optStore.delete,
    revert: optStore.revert,
    revertAll: optStore.revertAll,
    flush: optStore.flush,
    table: optStore.table,
    dispose: unsub,
  };
}

/** SolidJS signal result returned by {@link createTable} (`M22 Item 3`). */
export interface SolidTableResult<T extends Row = Row, K = unknown> {
  readonly repository: TableRepository<T, K>;
  rows: Accessor<T[] | undefined>;
  deltas: Accessor<readonly LiveRowDelta<T>[]>;
  version: Accessor<number>;
  loading: Accessor<boolean>;
  error: Accessor<Error | undefined>;
  pendingCount: Accessor<number>;
  flushing: Accessor<boolean>;
  state: Accessor<ReactiveTableState<T>>;
  refresh(): Promise<void>;
  insert(row: Partial<T> & Record<string, unknown>): Promise<T>;
  update(key: K, patch: Partial<T> & Record<string, unknown>): Promise<{ affectedRows: number }>;
  upsert(
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<T>;
  remove(key: K): Promise<{ affectedRows: number }>;
  dispose(): void;
}

/** Create a SolidJS reactive typed table handle (`M22 Item 3`). */
export function createTable<T extends Row = Row, K = unknown>(
  tableName: string,
  options: ReactiveTableStoreOptions<T> & { db?: ReactiveTableDatabase } = {},
): SolidTableResult<T, K> {
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;
  const db = (options.db ?? useFirebird()) as unknown as ReactiveTableDatabase;
  const store = new ReactiveTableStore<T, K>(db, tableName, options);
  const [getSnap, setSnap] = makeSignal<ReactiveTableState<T>>(store.getSnapshot());
  const unsub = store.subscribe(() => setSnap(store.getSnapshot()));
  store.start();
  setSnap(store.getSnapshot());

  const dispose = () => {
    unsub();
    store.stop();
  };
  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(dispose);
    } catch {
      // Ignore outside reactive owner
    }
  }

  return {
    repository: store.repository,
    rows: () => getSnap().rows,
    deltas: () => getSnap().deltas,
    version: () => getSnap().version,
    loading: () => getSnap().loading,
    error: () => getSnap().error,
    pendingCount: () => getSnap().pendingCount,
    flushing: () => getSnap().flushing,
    state: getSnap,
    refresh: store.refresh,
    insert: store.insert,
    update: store.update,
    upsert: store.upsert,
    remove: store.remove,
    dispose,
  };
}

export type { UndoRedoEntry, UndoRedoManager, UndoRedoOptions, UndoRedoSnapshot } from '../undo-redo';

/** SolidJS signal result returned by {@link createUndoRedo} (`M24 Item 4`). */
export interface SolidUndoRedoResult {
  readonly manager: UndoRedoManager;
  state: Accessor<UndoRedoSnapshot>;
  canUndo: Accessor<boolean>;
  canRedo: Accessor<boolean>;
  undoCount: Accessor<number>;
  redoCount: Accessor<number>;
  lastUndone: Accessor<UndoRedoEntry | null>;
  lastRedone: Accessor<UndoRedoEntry | null>;
  busy: Accessor<boolean>;
  undo: UndoRedoManager['undo'];
  redo: UndoRedoManager['redo'];
  run: UndoRedoManager['run'];
  clear: UndoRedoManager['clear'];
  insert: UndoRedoManager['insert'];
  update: UndoRedoManager['update'];
  upsert: UndoRedoManager['upsert'];
  delete: UndoRedoManager['delete'];
  table: UndoRedoManager['table'];
  dispose(): void;
}

function isSolidUndoRedoManager(val: unknown): val is UndoRedoManager {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as UndoRedoManager).undo === 'function' &&
    typeof (val as UndoRedoManager).redo === 'function' &&
    typeof (val as UndoRedoManager).getSnapshot === 'function'
  );
}

/** Create SolidJS signal accessors backed by {@link UndoRedoManager} (`M24 Item 4`). */
export function createUndoRedo(
  managerOrOptions:
    | UndoRedoManager
    | (UndoRedoOptions & { db?: TableExecutionHost; manager?: UndoRedoManager }) = {},
): SolidUndoRedoResult {
  const primitives = resolveSolidPrimitives();
  const makeSignal = primitives.createSignal ?? createFallbackSignal;
  const manager = isSolidUndoRedoManager(managerOrOptions)
    ? managerOrOptions
    : managerOrOptions.manager ??
      createUndoRedoManager(
        (managerOrOptions.db ?? useFirebird()) as unknown as TableExecutionHost,
        managerOrOptions,
      );
  const owned = !isSolidUndoRedoManager(managerOrOptions) && !managerOrOptions.manager;

  const [getSnap, setSnap] = makeSignal<UndoRedoSnapshot>(manager.getSnapshot());
  const unsub = manager.subscribe(() => setSnap(manager.getSnapshot()));

  const dispose = () => {
    unsub();
    if (owned) manager.close();
  };
  if (typeof primitives.onCleanup === 'function') {
    try {
      primitives.onCleanup(dispose);
    } catch {
      // Ignore outside reactive owner
    }
  }

  return {
    manager,
    state: getSnap,
    canUndo: () => getSnap().canUndo,
    canRedo: () => getSnap().canRedo,
    undoCount: () => getSnap().undoCount,
    redoCount: () => getSnap().redoCount,
    lastUndone: () => getSnap().lastUndone,
    lastRedone: () => getSnap().lastRedone,
    busy: () => getSnap().busy,
    undo: manager.undo,
    redo: manager.redo,
    run: manager.run,
    clear: manager.clear,
    insert: manager.insert,
    update: manager.update,
    upsert: manager.upsert,
    delete: manager.delete,
    table: manager.table,
    dispose,
  };
}
