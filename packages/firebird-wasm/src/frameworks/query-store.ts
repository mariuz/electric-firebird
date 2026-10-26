/**
 * query-store.ts – a query's rows as a value a UI framework can watch.
 *
 * The React and Vue bindings are thin: each wraps a {@link QueryStore}, which
 * runs a statement once (`query()`) or keeps it running (`live()`), and holds
 * the latest `{ rows, error, loading }` for whoever subscribed.  What both
 * frameworks get wrong in the same way without it lives here once: a result
 * that arrives after the component moved on to another query, a live query
 * that resolves after it was stopped, and a stop and restart of the same store
 * (React's StrictMode does exactly that on every mount).
 */

import { toStatement } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, QueryResult, Row } from '../types';
import type { LiveQuery, LiveQueryOptions } from '../browser/firebird-browser';

/**
 * What the store needs of a database: `FirebirdBrowser` has both.
 *
 * Structural, so a test can hand it a stand-in, and so the bindings import no
 * engine code of their own.
 */
export interface QueryableDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  live<T extends Row = Row>(
    sql: string,
    options: LiveQueryOptions,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>>;
}

/** The state a component renders from. */
export interface QueryState<T> {
  /**
   * The latest rows, or `undefined` before the first result.  While a new
   * query (other SQL or parameters) loads, the previous one's rows stay here,
   * so a list does not blank out between two results.
   */
  readonly rows: T[] | undefined;
  /** Why the latest run failed; cleared by the next result. */
  readonly error: Error | undefined;
  /** True until this query's first result or error. */
  readonly loading: boolean;
}

/** Options shared by the bindings' hooks. */
export interface QueryStoreOptions {
  /**
   * Event names to watch, as posted by `POST_EVENT`: with any, the statement
   * runs again each time one fires (`FirebirdBrowser.live()`).  When `live`
   * is `true` and `events` is omitted, `FirebirdBrowser.live()` infers the
   * referenced tables and installs `POST_EVENT` triggers automatically.
   */
  events?: readonly string[];
  /**
   * Whether to run as a live query even when `events` is omitted (auto-detecting
   * referenced tables).
   */
  live?: boolean;
  /** As `LiveQueryOptions.pollIntervalMs`. */
  pollIntervalMs?: number;
}

/**
 * One statement with its parameters, run against one database.
 *
 * Immutable in what it runs: other SQL or parameters make a new store, which
 * is how a stale result can never land in the wrong one.
 */
export class QueryStore<T extends Row = Row> {
  private state: QueryState<T>;
  private readonly listeners = new Set<() => void>();
  /** Bumped by every start() and stop(); a result from an older run is dropped. */
  private generation = 0;
  private running = false;
  private live: Promise<LiveQuery<T> | undefined> | undefined;
  /** The one-off run in flight, settled once its result or error is applied. */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: QueryableDatabase,
    readonly sql: string,
    readonly params: QueryParams,
    private readonly options: QueryStoreOptions = {},
    placeholder?: T[],
  ) {
    this.state = { rows: placeholder, error: undefined, loading: true };
  }

  /** For `useSyncExternalStore`: register a listener, get its removal. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current state; the same object until something changes. */
  readonly getSnapshot = (): QueryState<T> => this.state;

  /** Run the statement, and with events keep running it.  Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const hasExplicitEvents = this.options.events !== undefined && this.options.events.length > 0;
    const isLive = Boolean(this.options.live || hasExplicitEvents);

    if (!isLive) {
      this.pending = this.db.query<T>(this.sql, this.params).then(
        (result) => {
          if (current()) this.set({ rows: result.rows, error: undefined, loading: false });
        },
        (error: unknown) => {
          if (current()) this.fail(error);
        },
      );
      return;
    }

    this.live = this.db
      .live<T>(
        this.sql,
        {
          events: this.options.events !== undefined ? [...this.options.events] : undefined,
          params: this.params,
          pollIntervalMs: this.options.pollIntervalMs,
          onError: (error) => {
            if (current()) this.fail(error);
          },
        },
        (rows) => {
          if (current()) this.set({ rows, error: undefined, loading: false });
        },
      )
      .then(
        (live) => {
          // Stopped while it was starting: nobody else will release it.
          if (!current()) {
            void live.unsubscribe();
            return undefined;
          }
          return live;
        },
        (error: unknown) => {
          if (current()) this.fail(error);
          return undefined;
        },
      );
  }

  /** Stop watching; results still in flight are dropped.  start() may follow. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    const live = this.live;
    this.live = undefined;
    void live?.then((running) => running?.unsubscribe());
  }

  /** Run the statement again now, without waiting for an event. */
  readonly refresh = async (): Promise<void> => {
    if (!this.running) return;
    if (this.live === undefined) {
      // A one-off query: run it again, and settle when its result is in.
      this.stop();
      this.start();
      await this.pending;
      return;
    }
    const live = await this.live;
    if (live && this.running) {
      await live.refresh();
    } else if (this.running) {
      // The live query failed to start: try again.
      this.stop();
      this.start();
    }
  };

  private fail(error: unknown): void {
    this.set({
      rows: this.state.rows,
      error: error instanceof Error ? error : new Error(String(error)),
      loading: false,
    });
  }

  private set(next: QueryState<T>): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The statement a hook was given, resolved: SQL text and parameters from a
 * string with parameters, or from an `sql` tagged template.
 */
export function resolveStatement(
  query: string | SqlFragment,
  params: QueryParams | undefined,
): { sql: string; params: QueryParams } {
  const statement = toStatement(query, params ?? []);
  return { sql: statement.sql, params: statement.params };
}

/**
 * A string that is equal exactly when two calls would run the same thing.
 *
 * Components pass a fresh parameter array on every render; comparing by
 * identity would restart the query each time.  Types JSON would merge are
 * kept apart: a Date and its ISO string, a bigint and a number, bytes and an
 * array of numbers.
 */
export function queryKey(sql: string, params: QueryParams, options: QueryStoreOptions = {}): string {
  const eventsOrAuto =
    options.events !== undefined
      ? options.events
      : options.live
        ? '$auto'
        : [];
  return JSON.stringify(
    [sql, params, eventsOrAuto, options.pollIntervalMs ?? null],
    function (this: Record<string, unknown>, key: string, value: unknown) {
      const raw = this[key];
      if (typeof raw === 'bigint') return { $bigint: raw.toString() };
      if (raw instanceof Date) return { $date: raw.getTime() };
      if (raw instanceof Uint8Array) return { $bytes: Array.from(raw) };
      if (raw === undefined && Array.isArray(this)) return { $undefined: true };
      return value;
    },
  );
}
