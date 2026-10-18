/**
 * firebird-wasm/react – hooks that keep a component in step with a query.
 *
 * ```tsx
 * import { FirebirdProvider, useLiveQuery } from 'firebird-wasm/react';
 *
 * <FirebirdProvider db={db}><Todos /></FirebirdProvider>
 *
 * function Todos() {
 *   const { rows, error } = useLiveQuery<{ ID: number; TITLE: string }>(
 *     'SELECT id, title FROM todos ORDER BY id', { events: ['todos'] });
 *   if (error) return <p>{error.message}</p>;
 *   return <ul>{rows?.map((r) => <li key={r.ID}>{r.TITLE}</li>)}</ul>;
 * }
 * ```
 *
 * React 18 or later (`useSyncExternalStore`), a peer dependency the package
 * does not install for you.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { QueryStore, queryKey, resolveStatement } from '../frameworks/query-store';
import type { QueryableDatabase, QueryState, QueryStoreOptions } from '../frameworks/query-store';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, Row } from '../types';

export type { QueryableDatabase, QueryState } from '../frameworks/query-store';

const FirebirdContext = createContext<QueryableDatabase | null>(null);

/** Makes `db` the database of every hook below it. */
export function FirebirdProvider(props: { db: QueryableDatabase; children?: ReactNode }) {
  return createElement(FirebirdContext.Provider, { value: props.db }, props.children);
}

/** The database a `FirebirdProvider` above this component provides. */
export function useFirebird<D extends QueryableDatabase = QueryableDatabase>(): D {
  const db = useContext(FirebirdContext);
  if (db === null) {
    throw new Error(
      'useFirebird() found no database: wrap the component in <FirebirdProvider db={…}>, ' +
        'or pass { db } to the hook',
    );
  }
  return db as D;
}

/** What `useQuery` and `useLiveQuery` return. */
export interface QueryHookResult<T> extends QueryState<T> {
  /** Run the statement again now. */
  refresh(): Promise<void>;
}

/** Options of {@link useQuery}. */
export interface UseQueryOptions {
  /** A database other than the provider's. */
  db?: QueryableDatabase;
}

/** Options of {@link useLiveQuery}. */
export interface UseLiveQueryOptions extends UseQueryOptions {
  /** Event names whose firing re-runs the statement (`POST_EVENT`). */
  events: readonly string[];
  /** Parameters, when the statement is a string with `?` placeholders. */
  params?: QueryParams;
  /** How often to poll for events, in milliseconds.  @default 250 */
  pollIntervalMs?: number;
}

/**
 * Run a statement and render its rows.  It runs again when the SQL or the
 * parameters change (by value: a new array with the same values does not).
 *
 * ```tsx
 * const { rows, loading } = useQuery('SELECT * FROM todos WHERE done = ?', [false]);
 * const { rows } = useQuery(sql`SELECT * FROM todos WHERE id = ${id}`);
 * ```
 */
export function useQuery<T extends Row = Row>(
  query: string | SqlFragment,
  params?: QueryParams,
  options: UseQueryOptions = {},
): QueryHookResult<T> {
  return useStore<T>(options.db, query, params, {});
}

/**
 * Like {@link useQuery}, and the statement runs again each time one of
 * `events` fires: `FirebirdBrowser.live()` under a hook.  A trigger posts
 * the events (`POST_EVENT 'todos'` after insert, update and delete), or the
 * code that wrote calls `db.notify()`.
 */
export function useLiveQuery<T extends Row = Row>(
  query: string | SqlFragment,
  options: UseLiveQueryOptions,
): QueryHookResult<T> {
  if (options.events.length === 0) {
    throw new RangeError('useLiveQuery() needs at least one event name; useQuery() runs a statement once');
  }
  return useStore<T>(options.db, query, options.params, {
    events: options.events,
    pollIntervalMs: options.pollIntervalMs,
  });
}

function useStore<T extends Row>(
  explicitDb: QueryableDatabase | undefined,
  query: string | SqlFragment,
  params: QueryParams | undefined,
  storeOptions: QueryStoreOptions,
): QueryHookResult<T> {
  const provided = useContext(FirebirdContext);
  const db = explicitDb ?? provided;
  if (db === null) {
    throw new Error(
      'No database for this query: wrap the component in <FirebirdProvider db={…}>, ' +
        'or pass { db } to the hook',
    );
  }

  const statement = resolveStatement(query, params);
  const key = queryKey(statement.sql, statement.params, storeOptions);

  // The last store this component ran, for its rows while the next one loads.
  const previous = useRef<QueryStore<T> | null>(null);
  const store = useMemo(
    () =>
      new QueryStore<T>(db, statement.sql, statement.params, storeOptions,
        previous.current?.getSnapshot().rows),
    // `key` stands for the statement, its parameters and the options, which
    // are new objects on every render.
    [db, key],
  );

  useEffect(() => {
    previous.current = store;
    store.start();
    return () => store.stop();
  }, [store]);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => ({ ...state, refresh: store.refresh }), [state, store]);
}
