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
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, Row } from '../types';

export type { QueryableDatabase } from '../frameworks/query-store';

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
  /** Event names whose firing re-runs the statement (`POST_EVENT`). */
  events: MaybeRefOrGetter<readonly string[]>;
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
  options: UseLiveQueryOptions,
): QueryRefs<T> {
  return useStore<T>(options.db, query, options.params, () => {
    const events = toValue(options.events);
    if (events.length === 0) {
      throw new RangeError('useLiveQuery() needs at least one event name; useQuery() runs a statement once');
    }
    return { events: [...events], pollIntervalMs: options.pollIntervalMs };
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
