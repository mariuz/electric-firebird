/**
 * firebird-wasm/vue – composables that keep a component in step with a query.
 *
 * ```ts
 * // main.ts
 * app.provide(FIREBIRD, db);              // or provideFirebird(db) in a setup()
 *
 * // a component's setup()
 * const { rows, error } = useLiveQuery('SELECT id, title FROM todos ORDER BY id',
 *   { events: ['todos'] });
 * ```
 *
 * The statement, its parameters and the events may be refs or getters; the
 * query runs again when what they hold changes.  Vue 3.3 or later
 * (`toValue`), a peer dependency the package does not install for you.
 */

import { inject, onScopeDispose, provide, ref, shallowRef, toValue, watch } from 'vue';
import type { InjectionKey, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import { QueryStore, queryKey, resolveStatement } from '../frameworks/query-store';
import type { QueryableDatabase, QueryStoreOptions } from '../frameworks/query-store';
import {
  ColumnarQueryStore,
  IncrementalQueryStore,
  SyncStatusStore,
  type ColumnarQueryableDatabase,
  type IncrementalQueryableDatabase,
  type ReactiveSyncLifecycleState,
  type SyncHandleLike,
  type SyncStatusStoreOptions,
} from '../frameworks/sync-store';
import type { ColumnarQueryResult } from '../columnar';
import type { LiveRowDelta, LiveRowKeySelector } from '../live-incremental';
import {
  createOptimisticMutationStore,
  ReactiveTableStore,
  type OptimisticMutationStore,
  type OptimisticMutationStoreOptions,
  type PendingOptimisticMutation,
  type ReactiveTableDatabase,
  type ReactiveTableStoreOptions,
} from '../optimistic-store';
import type { TableExecutionHost, TableRepository } from '../table-api';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, Row } from '../types';

export type { QueryableDatabase } from '../frameworks/query-store';
export type {
  OptimisticMutationStore,
  OptimisticMutationStoreOptions,
  PendingOptimisticMutation,
  ReactiveTableDatabase,
  ReactiveTableStoreOptions,
} from '../optimistic-store';
export type {
  ColumnarQueryableDatabase,
  IncrementalQueryableDatabase,
  ReactiveSyncLifecycleState,
  SyncHandleLike,
  SyncStatusStoreOptions,
} from '../frameworks/sync-store';

/** The injection key of the database: `app.provide(FIREBIRD, db)`. */
export const FIREBIRD: InjectionKey<QueryableDatabase> = Symbol('firebird-wasm');

/** Makes `db` the database of this component and those below it. */
export function provideFirebird(db: QueryableDatabase): void {
  provide(FIREBIRD, db);
}

/** The database provided above this component. */
export function useFirebird<D extends QueryableDatabase = QueryableDatabase>(): D {
  const db = inject(FIREBIRD, null);
  if (db === null) {
    throw new Error(
      'useFirebird() found no database: app.provide(FIREBIRD, db) or provideFirebird(db) ' +
        'above this component, or pass { db } to the composable',
    );
  }
  return db as D;
}

/** What `useQuery` and `useLiveQuery` return: refs, for a template to read. */
export interface QueryRefs<T> {
  /** The latest rows; `undefined` before the first result. */
  rows: ShallowRef<T[] | undefined>;
  /** Why the latest run failed; cleared by the next result. */
  error: ShallowRef<Error | undefined>;
  /** True until the current statement's first result or error. */
  loading: Ref<boolean>;
  /** Run the statement again now. */
  refresh(): Promise<void>;
}

/** Options of {@link useQuery}. */
export interface UseQueryOptions {
  /** A database other than the provided one. */
  db?: QueryableDatabase;
}

/** Options of {@link useLiveQuery}. */
export interface UseLiveQueryOptions extends UseQueryOptions {
  /**
   * Event names whose firing re-runs the statement (`POST_EVENT`).
   * When omitted, `FirebirdBrowser.live()` infers the referenced tables and
   * installs `POST_EVENT` triggers automatically.
   */
  events?: MaybeRefOrGetter<readonly string[] | undefined>;
  /** Parameters, when the statement is a string with `?` placeholders. */
  params?: MaybeRefOrGetter<QueryParams | undefined>;
  /** How often to poll for events, in milliseconds.  @default 250 */
  pollIntervalMs?: number;
}

/**
 * Run a statement and keep its rows in refs.  It runs again when the SQL or
 * the parameters change by value.
 *
 * ```ts
 * const done = ref(false);
 * const { rows } = useQuery('SELECT * FROM todos WHERE done = ?', () => [done.value]);
 * ```
 */
export function useQuery<T extends Row = Row>(
  query: MaybeRefOrGetter<string | SqlFragment>,
  params?: MaybeRefOrGetter<QueryParams | undefined>,
  options: UseQueryOptions = {},
): QueryRefs<T> {
  return useStore<T>(options.db, query, params, () => ({}));
}

/**
 * Like {@link useQuery}, and the statement runs again each time one of
 * `events` fires: `FirebirdBrowser.live()` as a composable.
 */
export function useLiveQuery<T extends Row = Row>(
  query: MaybeRefOrGetter<string | SqlFragment>,
  options: UseLiveQueryOptions = {},
): QueryRefs<T> {
  return useStore<T>(options.db, query, options.params, () => {
    const events = options.events !== undefined ? toValue(options.events) : undefined;
    if (events !== undefined && events.length === 0) {
      throw new RangeError('useLiveQuery() needs at least one event name; useQuery() runs a statement once');
    }
    return {
      events: events !== undefined ? [...events] : undefined,
      live: true,
      pollIntervalMs: options.pollIntervalMs,
    };
  });
}

function useStore<T extends Row>(
  explicitDb: QueryableDatabase | undefined,
  query: MaybeRefOrGetter<string | SqlFragment>,
  params: MaybeRefOrGetter<QueryParams | undefined> | undefined,
  storeOptions: () => QueryStoreOptions,
): QueryRefs<T> {
  const db = explicitDb ?? useFirebird();

  const rows = shallowRef<T[] | undefined>(undefined);
  const error = shallowRef<Error | undefined>(undefined);
  const loading = ref(true);

  let store: QueryStore<T> | undefined;
  let unsubscribe: (() => void) | undefined;

  const target = () => {
    const statement = resolveStatement(toValue(query), toValue(params));
    const options = storeOptions();
    return { statement, options, key: queryKey(statement.sql, statement.params, options) };
  };

  // Watching the key, not the statement: a getter returning a new parameter
  // array with the same values must not run the query again.
  watch(
    () => target().key,
    () => {
      const { statement, options } = target();
      const next = new QueryStore<T>(db, statement.sql, statement.params, options, rows.value);
      unsubscribe?.();
      store?.stop();
      store = next;
      const sync = () => {
        const state = next.getSnapshot();
        rows.value = state.rows;
        error.value = state.error;
        loading.value = state.loading;
      };
      unsubscribe = next.subscribe(sync);
      sync();
      next.start();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    unsubscribe?.();
    store?.stop();
  });

  return {
    rows,
    error,
    loading,
    refresh: () => store?.refresh() ?? Promise.resolve(),
  };
}

/** Vue refs returned by {@link useSyncStatus} (`M20 Item 4`). */
export interface SyncStatusRefs {
  state: Ref<ReactiveSyncLifecycleState>;
  paused: Ref<boolean>;
  syncing: Ref<boolean>;
  replicaLsn: Ref<number>;
  primaryLsn: Ref<number>;
  lagEntries: Ref<number>;
  dlqCount: Ref<number>;
  error: ShallowRef<Error | undefined>;
  syncNow(): Promise<void>;
  pause(): void;
  resume(): void;
  refresh(): Promise<void>;
}

/** Watch a `SyncHandle` (`syncDatabases()` / `db.syncWith()`) as Vue refs (`M20 Item 4`). */
export function useSyncStatus(
  handle: MaybeRefOrGetter<SyncHandleLike | null | undefined>,
  options: SyncStatusStoreOptions = {},
): SyncStatusRefs {
  const state = ref<ReactiveSyncLifecycleState>('offline');
  const paused = ref(false);
  const syncing = ref(false);
  const replicaLsn = ref(0);
  const primaryLsn = ref(0);
  const lagEntries = ref(0);
  const dlqCount = ref(0);
  const error = shallowRef<Error | undefined>(undefined);

  let store: SyncStatusStore | undefined;
  let unsubscribe: (() => void) | undefined;

  watch(
    () => toValue(handle),
    (h) => {
      unsubscribe?.();
      store?.stop();
      const next = new SyncStatusStore(h, options);
      store = next;
      const sync = () => {
        const snap = next.getSnapshot();
        state.value = snap.state;
        paused.value = snap.paused;
        syncing.value = snap.syncing;
        replicaLsn.value = snap.replicaLsn;
        primaryLsn.value = snap.primaryLsn;
        lagEntries.value = snap.lagEntries;
        dlqCount.value = snap.dlqCount;
        error.value = snap.error;
      };
      unsubscribe = next.subscribe(sync);
      sync();
      next.start();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    unsubscribe?.();
    store?.stop();
  });

  return {
    state,
    paused,
    syncing,
    replicaLsn,
    primaryLsn,
    lagEntries,
    dlqCount,
    error,
    syncNow: () => store?.syncNow() ?? Promise.resolve(),
    pause: () => store?.pause(),
    resume: () => store?.resume(),
    refresh: () => store?.refresh() ?? Promise.resolve(),
  };
}

/** Vue refs returned by {@link useColumnarQuery} (`M20 Item 4`). */
export interface ColumnarQueryRefs {
  result: ShallowRef<ColumnarQueryResult | undefined>;
  version: Ref<number>;
  error: ShallowRef<Error | undefined>;
  loading: Ref<boolean>;
  refresh(): Promise<void>;
}

/** Run a one-shot or live columnar query as Vue refs (`M20 Item 4`). */
export function useColumnarQuery(
  query: MaybeRefOrGetter<string | SqlFragment>,
  options: {
    db?: ColumnarQueryableDatabase;
    events?: MaybeRefOrGetter<readonly string[] | undefined>;
    live?: boolean;
    params?: MaybeRefOrGetter<QueryParams | undefined>;
    pollIntervalMs?: number;
  } = {},
): ColumnarQueryRefs {
  const db = (options.db ?? useFirebird()) as ColumnarQueryableDatabase;
  const result = shallowRef<ColumnarQueryResult | undefined>(undefined);
  const version = ref(0);
  const error = shallowRef<Error | undefined>(undefined);
  const loading = ref(true);

  let store: ColumnarQueryStore | undefined;
  let unsubscribe: (() => void) | undefined;

  const target = () => {
    const statement = resolveStatement(toValue(query), toValue(options.params));
    const events = options.events !== undefined ? toValue(options.events) : undefined;
    const storeOpts = {
      events: events !== undefined ? [...events] : undefined,
      live: options.live,
      pollIntervalMs: options.pollIntervalMs,
    };
    return { statement, storeOpts, key: queryKey(statement.sql, statement.params, storeOpts) };
  };

  watch(
    () => target().key,
    () => {
      const { statement, storeOpts } = target();
      const next = new ColumnarQueryStore(
        db,
        statement.sql,
        statement.params,
        storeOpts,
        result.value,
      );
      unsubscribe?.();
      store?.stop();
      store = next;
      const sync = () => {
        const snap = next.getSnapshot();
        result.value = snap.result;
        version.value = snap.version;
        error.value = snap.error;
        loading.value = snap.loading;
      };
      unsubscribe = next.subscribe(sync);
      sync();
      next.start();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    unsubscribe?.();
    store?.stop();
  });

  return {
    result,
    version,
    error,
    loading,
    refresh: () => store?.refresh() ?? Promise.resolve(),
  };
}

/** Vue refs returned by {@link useLiveIncrementalQuery} (`M20 Item 4`). */
export interface IncrementalQueryRefs<T = Row> {
  rows: ShallowRef<readonly T[] | undefined>;
  deltas: ShallowRef<readonly LiveRowDelta<T>[]>;
  version: Ref<number>;
  error: ShallowRef<Error | undefined>;
  loading: Ref<boolean>;
  refresh(): Promise<void>;
}

/** Subscribe a Vue component to incremental `{ rows, deltas }` updates (`M20 Item 4`). */
export function useLiveIncrementalQuery<T extends Row = Row>(
  query: MaybeRefOrGetter<string | SqlFragment>,
  options: {
    db?: IncrementalQueryableDatabase;
    key?: LiveRowKeySelector<T>;
    events?: MaybeRefOrGetter<readonly string[] | undefined>;
    params?: MaybeRefOrGetter<QueryParams | undefined>;
    pollIntervalMs?: number;
  } = {},
): IncrementalQueryRefs<T> {
  const db = (options.db ?? useFirebird()) as IncrementalQueryableDatabase;
  const rows = shallowRef<readonly T[] | undefined>(undefined);
  const deltas = shallowRef<readonly LiveRowDelta<T>[]>([]);
  const version = ref(0);
  const error = shallowRef<Error | undefined>(undefined);
  const loading = ref(true);

  let store: IncrementalQueryStore<T> | undefined;
  let unsubscribe: (() => void) | undefined;

  const target = () => {
    const statement = resolveStatement(toValue(query), toValue(options.params));
    const events = options.events !== undefined ? toValue(options.events) : undefined;
    const storeOpts = {
      events: events !== undefined ? [...events] : undefined,
      live: true,
      pollIntervalMs: options.pollIntervalMs,
    };
    return { statement, events, key: queryKey(statement.sql, statement.params, storeOpts) };
  };

  watch(
    () => target().key,
    () => {
      const { statement, events } = target();
      const next = new IncrementalQueryStore<T>(
        db,
        statement.sql,
        statement.params,
        {
          key: options.key,
          events: events !== undefined ? [...events] : undefined,
          pollIntervalMs: options.pollIntervalMs,
        },
        rows.value,
      );
      unsubscribe?.();
      store?.stop();
      store = next;
      const sync = () => {
        const snap = next.getSnapshot();
        rows.value = snap.rows;
        deltas.value = snap.deltas;
        version.value = snap.version;
        error.value = snap.error;
        loading.value = snap.loading;
      };
      unsubscribe = next.subscribe(sync);
      sync();
      next.start();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    unsubscribe?.();
    store?.stop();
  });

  return {
    rows,
    deltas,
    version,
    error,
    loading,
    refresh: () => store?.refresh() ?? Promise.resolve(),
  };
}

/** Vue refs returned by {@link useOptimisticMutation} (`M22 Item 3`). */
export interface OptimisticMutationRefs {
  readonly store: OptimisticMutationStore;
  pendingCount: Ref<number>;
  flushing: Ref<boolean>;
  pending: ShallowRef<readonly PendingOptimisticMutation[]>;
  confirmedCount: Ref<number>;
  revertedCount: Ref<number>;
  lastError: ShallowRef<Error | undefined>;
  insert: OptimisticMutationStore['insert'];
  update: OptimisticMutationStore['update'];
  upsert: OptimisticMutationStore['upsert'];
  delete: OptimisticMutationStore['delete'];
  revert: OptimisticMutationStore['revert'];
  revertAll: OptimisticMutationStore['revertAll'];
  flush: OptimisticMutationStore['flush'];
  table: OptimisticMutationStore['table'];
}

/** Composable wrapping {@link OptimisticMutationStore} as Vue refs (`M22 Item 3`). */
export function useOptimisticMutation(
  options: OptimisticMutationStoreOptions & {
    db?: TableExecutionHost;
    store?: OptimisticMutationStore;
  } = {},
): OptimisticMutationRefs {
  const store =
    options.store ??
    createOptimisticMutationStore(
      (options.db ?? useFirebird()) as unknown as TableExecutionHost,
      options,
    );
  const init = store.getSnapshot();
  const pendingCount = ref(init.pendingCount);
  const flushing = ref(init.flushing);
  const pending = shallowRef(init.pending);
  const confirmedCount = ref(init.confirmedCount);
  const revertedCount = ref(init.revertedCount);
  const lastError = shallowRef<Error | undefined>(init.lastError);

  const unsub = store.subscribe(() => {
    const s = store.getSnapshot();
    pendingCount.value = s.pendingCount;
    flushing.value = s.flushing;
    pending.value = s.pending;
    confirmedCount.value = s.confirmedCount;
    revertedCount.value = s.revertedCount;
    lastError.value = s.lastError;
  });

  onScopeDispose(unsub);

  return {
    store,
    pendingCount,
    flushing,
    pending,
    confirmedCount,
    revertedCount,
    lastError,
    insert: store.insert,
    update: store.update,
    upsert: store.upsert,
    delete: store.delete,
    revert: store.revert,
    revertAll: store.revertAll,
    flush: store.flush,
    table: store.table,
  };
}

/** Vue refs returned by {@link useTable} (`M22 Item 3`). */
export interface TableRefs<T extends Row = Row, K = unknown> {
  readonly repository: TableRepository<T, K>;
  rows: ShallowRef<T[] | undefined>;
  deltas: ShallowRef<readonly LiveRowDelta<T>[]>;
  version: Ref<number>;
  loading: Ref<boolean>;
  error: ShallowRef<Error | undefined>;
  pendingCount: Ref<number>;
  flushing: Ref<boolean>;
  refresh(): Promise<void>;
  insert(row: Partial<T> & Record<string, unknown>): Promise<T>;
  update(key: K, patch: Partial<T> & Record<string, unknown>): Promise<{ affectedRows: number }>;
  upsert(
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<T>;
  remove(key: K): Promise<{ affectedRows: number }>;
}

/** Reactive typed table composable for Vue (`M22 Item 3`). */
export function useTable<T extends Row = Row, K = unknown>(
  tableName: string,
  options: ReactiveTableStoreOptions<T> & { db?: ReactiveTableDatabase } = {},
): TableRefs<T, K> {
  const db = (options.db ?? useFirebird()) as unknown as ReactiveTableDatabase;
  const store = new ReactiveTableStore<T, K>(db, tableName, options);
  const rows = shallowRef<T[] | undefined>(undefined);
  const deltas = shallowRef<readonly LiveRowDelta<T>[]>([]);
  const version = ref(0);
  const loading = ref(true);
  const error = shallowRef<Error | undefined>(undefined);
  const pendingCount = ref(0);
  const flushing = ref(false);

  const sync = () => {
    const s = store.getSnapshot();
    rows.value = s.rows;
    deltas.value = s.deltas;
    version.value = s.version;
    loading.value = s.loading;
    error.value = s.error;
    pendingCount.value = s.pendingCount;
    flushing.value = s.flushing;
  };
  const unsub = store.subscribe(sync);
  store.start();
  sync();

  onScopeDispose(() => {
    unsub();
    store.stop();
  });

  return {
    repository: store.repository,
    rows,
    deltas,
    version,
    loading,
    error,
    pendingCount,
    flushing,
    refresh: store.refresh,
    insert: store.insert,
    update: store.update,
    upsert: store.upsert,
    remove: store.remove,
  };
}
