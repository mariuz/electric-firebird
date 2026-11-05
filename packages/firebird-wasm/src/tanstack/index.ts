/**
 * firebird-wasm/tanstack – TanStack Query & TanStack DB reactive adapters.
 *
 * Bridges `FirebirdBrowser` (`db.query()`, `db.live()`, `db.onEvent()`),
 * `syncShapeToTable` / `syncShapesToTables`, and `createWriteQueue` with:
 * 1. **TanStack Query (`@tanstack/query-core` / `@tanstack/react-query` / etc.)**:
 *    - {@link createFirebirdQueryOptions}: builds `queryOptions({ queryKey, queryFn })`
 *      for any TanStack Query hook (`useQuery`, `createQuery`, `injectQuery`).
 *    - {@link connectFirebirdQueryClient}: bridges Firebird `POST_EVENT` / `db.live()`
 *      change notifications directly into `queryClient.invalidateQueries()` or
 *      `queryClient.setQueryData()`.
 *    - {@link createWriteQueueMutationOptions}: builds TanStack `mutationOptions`
 *      backed by a durable offline {@link WriteQueue} (`FB_WRITE_QUEUE$`) with
 *      automatic query cache invalidation.
 * 2. **TanStack DB (`@tanstack/db` local-first collections)**:
 *    - {@link createFirebirdCollection}: creates a live, reactive collection
 *      backed by a Firebird SQL table (`getAll`, `get`, `insert`, `update`,
 *      `delete`, `upsert`, `subscribe`, and TanStack DB `sync` config), optionally
 *      wired to a {@link WriteQueue} for offline-first optimistic mutations.
 */

import { resolveStatement } from '../frameworks/query-store';
import type { SqlFragment } from '../sql-tag';
import type { QueryParams, QueryResult, Row } from '../types';
import type { LiveQuery, LiveQueryOptions } from '../browser/firebird-browser';

// ---------------------------------------------------------------------------
// Minimal Structural Types for Database, WriteQueue & TanStack QueryClient
// ---------------------------------------------------------------------------

/**
 * Structural database contract satisfied by `FirebirdBrowser` and `FirebirdLite`.
 */
export interface TanStackFirebirdDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
  exec?(sql: string): Promise<void>;
  live?<T extends Row = Row>(
    sql: string,
    options: LiveQueryOptions,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>>;
  onEvent?(name: string, listener: (count: number) => void): Promise<() => Promise<void>>;
}

/**
 * Minimal structural interface matching `WriteQueue` from `firebird-wasm/electric`.
 */
export interface TanStackWriteQueueLike {
  insert(table: string, value: Record<string, unknown>): Promise<unknown>;
  update(
    table: string,
    key: Record<string, unknown>,
    value: Record<string, unknown>,
  ): Promise<unknown>;
  delete(table: string, key: Record<string, unknown>): Promise<unknown>;
  flush?(): Promise<void>;
}

/**
 * Structural interface matching TanStack Query's `QueryClient` (`@tanstack/query-core`).
 * Works with React Query, Vue Query, Solid Query, Svelte Query, and Angular Query
 * without requiring a hard runtime dependency on `@tanstack/query-core`.
 */
export interface TanStackQueryClientLike {
  invalidateQueries(filters?: {
    queryKey?: readonly unknown[];
    exact?: boolean;
    predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
  }): Promise<void> | void;
  setQueryData?<TData = unknown>(
    queryKey: readonly unknown[],
    updater: TData | undefined | ((oldData: TData | undefined) => TData | undefined),
  ): TData | undefined;
  getQueryData?<TData = unknown>(queryKey: readonly unknown[]): TData | undefined;
}

// ---------------------------------------------------------------------------
// 1. TanStack Query Key & QueryOptions Helpers
// ---------------------------------------------------------------------------

/** Prefix used for all Firebird TanStack Query keys. */
export const FIREBIRD_QUERY_KEY_PREFIX = 'firebird' as const;

/** Structured query key tuple for TanStack Query. */
export type FirebirdTanStackQueryKey = readonly [
  typeof FIREBIRD_QUERY_KEY_PREFIX,
  {
    readonly sql: string;
    readonly params: readonly unknown[];
    readonly tables?: readonly string[];
    readonly events?: readonly string[];
  },
];

/** Options for {@link createFirebirdQueryOptions}. */
export interface FirebirdTanStackQueryOptions<TData extends Row = Row, TSelected = TData[]> {
  /**
   * Explicit table names referenced by this query. When omitted, table names
   * are inferred from `FROM` / `JOIN` clauses so event bridges can invalidate
   * matching queries automatically.
   */
  tables?: readonly string[];
  /**
   * Firebird `POST_EVENT` names associated with this query.
   */
  events?: readonly string[];
  /**
   * Optional selector to transform the returned `TData[]` rows (or full
   * `QueryResult<TData>`).
   */
  select?: (rows: TData[], result: QueryResult<TData>) => TSelected;
  /**
   * When `true` and a `queryClient` is provided, starts a background
   * `db.live()` subscription that pushes fresh rows directly into
   * `queryClient.setQueryData(queryKey, ...)` whenever the underlying
   * Firebird tables or `POST_EVENT`s fire.
   */
  live?: boolean;
  /**
   * Optional `QueryClient` used when `live: true` to push live updates into
   * the TanStack Query cache via `setQueryData` / `invalidateQueries`.
   */
  queryClient?: TanStackQueryClientLike;
  /** Poll interval in milliseconds when `live: true` is used. */
  pollIntervalMs?: number;
  /** Optional `staleTime` forwarded to TanStack Query. */
  staleTime?: number;
  /** Optional `gcTime` forwarded to TanStack Query. */
  gcTime?: number;
}

/** Descriptor returned by {@link createFirebirdQueryOptions}. */
export interface FirebirdQueryDescriptor<TData extends Row = Row, TSelected = TData[]> {
  readonly queryKey: FirebirdTanStackQueryKey;
  readonly queryFn: (context?: { signal?: AbortSignal }) => Promise<TSelected>;
  readonly staleTime?: number;
  readonly gcTime?: number;
  /** Referenced upper-case table names inferred or supplied for this query. */
  readonly tables: readonly string[];
  /** Associated Firebird event names. */
  readonly events: readonly string[];
  /**
   * Stop the background `db.live()` subscription if one was started with
   * `live: true`. Safe to call multiple times.
   */
  readonly unsubscribe: () => Promise<void>;
}

/**
 * Extract upper-case table identifiers referenced in `FROM` and `JOIN` clauses
 * of a SQL query for automatic cache invalidation matching.
 */
export function extractReferencedTables(sql: string): string[] {
  const tables = new Set<string>();
  const regex = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (raw) {
      tables.add(raw.toUpperCase());
    }
  }
  return Array.from(tables);
}

/**
 * Normalize parameter values so `BigInt`, `Date`, and `Uint8Array` serialize
 * deterministically inside TanStack Query keys.
 */
function normalizeParamForKey(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }
  if (value instanceof Date) {
    return { $date: value.getTime() };
  }
  if (value instanceof Uint8Array) {
    return { $bytes: Array.from(value) };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeParamForKey);
  }
  return value;
}

/**
 * Build a deterministic TanStack Query key for a Firebird SQL query.
 */
export function buildFirebirdQueryKey(
  query: string | SqlFragment,
  params?: QueryParams,
  meta?: { tables?: readonly string[]; events?: readonly string[] },
): FirebirdTanStackQueryKey {
  const resolved = resolveStatement(query, params);
  const tables =
    meta?.tables && meta.tables.length > 0
      ? meta.tables.map((t) => t.toUpperCase())
      : extractReferencedTables(resolved.sql);
  const events = meta?.events ? [...meta.events] : [];
  return [
    FIREBIRD_QUERY_KEY_PREFIX,
    {
      sql: resolved.sql,
      params: resolved.params.map(normalizeParamForKey),
      ...(tables.length > 0 ? { tables } : {}),
      ...(events.length > 0 ? { events } : {}),
    },
  ] as const;
}

/**
 * Create a TanStack Query options object (`{ queryKey, queryFn, ... }`) backed
 * by `FirebirdBrowser` or `FirebirdLite`.
 *
 * When `options.live` is `true` and `options.queryClient` is supplied, also
 * attaches a `db.live()` listener that keeps the TanStack Query cache warm
 * via `setQueryData` (or `invalidateQueries`) whenever changes occur.
 */
export function createFirebirdQueryOptions<
  TData extends Row = Row,
  TSelected = TData[],
>(
  db: TanStackFirebirdDatabase,
  query: string | SqlFragment,
  params?: QueryParams,
  options: FirebirdTanStackQueryOptions<TData, TSelected> = {},
): FirebirdQueryDescriptor<TData, TSelected> {
  const resolved = resolveStatement(query, params);
  const tables =
    options.tables && options.tables.length > 0
      ? options.tables.map((t) => t.toUpperCase())
      : extractReferencedTables(resolved.sql);
  const events = options.events ? [...options.events] : [];
  const queryKey = buildFirebirdQueryKey(resolved.sql, resolved.params, {
    tables,
    events,
  });

  let liveSubPromise: Promise<LiveQuery<TData> | undefined> | null = null;
  let stopped = false;

  const ensureLiveSubscription = () => {
    if (!options.live || !options.queryClient || !db.live || liveSubPromise || stopped) {
      return;
    }
    const client = options.queryClient;
    liveSubPromise = db
      .live<TData>(
        resolved.sql,
        {
          params: resolved.params,
          events: events.length > 0 ? events : undefined,
          pollIntervalMs: options.pollIntervalMs,
        },
        (rows, result) => {
          if (stopped) return;
          const transformed = options.select
            ? options.select(rows, result)
            : (rows as unknown as TSelected);
          if (typeof client.setQueryData === 'function') {
            client.setQueryData<TSelected>(queryKey, transformed);
          } else {
            void client.invalidateQueries({ queryKey });
          }
        },
      )
      .then((sub) => {
        if (stopped) {
          void sub.unsubscribe();
          return undefined;
        }
        return sub;
      })
      .catch(() => undefined);
  };

  if (options.live && options.queryClient) {
    ensureLiveSubscription();
  }

  const queryFn = async (context?: { signal?: AbortSignal }): Promise<TSelected> => {
    if (context?.signal?.aborted) {
      throw new Error('Query aborted');
    }
    ensureLiveSubscription();
    const result = await db.query<TData>(resolved.sql, resolved.params);
    if (options.select) {
      return options.select(result.rows, result);
    }
    return result.rows as unknown as TSelected;
  };

  const unsubscribe = async (): Promise<void> => {
    stopped = true;
    if (liveSubPromise) {
      const sub = await liveSubPromise;
      liveSubPromise = null;
      if (sub) {
        await sub.unsubscribe();
      }
    }
  };

  return {
    queryKey,
    queryFn,
    ...(options.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
    ...(options.gcTime !== undefined ? { gcTime: options.gcTime } : {}),
    tables,
    events,
    unsubscribe,
  };
}

// ---------------------------------------------------------------------------
// 2. Event & Sync Cache Invalidation Bridge (`connectFirebirdQueryClient`)
// ---------------------------------------------------------------------------

/** Options for {@link connectFirebirdQueryClient}. */
export interface ConnectFirebirdQueryClientOptions {
  /**
   * Firebird `POST_EVENT` names to subscribe to via `db.onEvent()`.
   * When an event fires, any TanStack query whose `events` or `tables` match
   * (or all `'firebird'` queries if no specific mapping matches) is invalidated.
   */
  events?: readonly string[];
  /**
   * Table names to watch. For each table `'ITEMS'`, subscribes to both `'ITEMS'`
   * and `'fb_live_ITEMS'` events on `db.onEvent` when available.
   */
  tables?: readonly string[];
  /**
   * Optional map from event name to one or more table names (e.g.
   * `{ electric_items: ['ITEMS'] }`).
   */
  eventToTables?: Record<string, readonly string[]>;
}

/** Handle returned by {@link connectFirebirdQueryClient}. */
export interface FirebirdQueryClientBridge {
  /**
   * Manually invalidate all TanStack Query entries referencing any of `tables`
   * (or all `'firebird'` queries when `tables` is omitted).
   */
  invalidateTables(tables?: readonly string[]): Promise<void>;
  /**
   * Manually invalidate all TanStack Query entries listening to `event`.
   */
  invalidateEvent(event: string): Promise<void>;
  /**
   * Callback compatible with `SyncShapesToTablesOptions.onBatchCommitted`:
   * pass `onBatchCommitted: bridge.onSyncBatchCommitted` to automatically
   * invalidate affected TanStack queries after every atomic Electric batch.
   */
  onSyncBatchCommitted(info: { tables: string[]; txids?: string[]; lsn?: bigint }): void;
  /** Unsubscribe all `db.onEvent` listeners registered by this bridge. */
  close(): Promise<void>;
}

function stripQuotes(ident: string): string {
  return ident.replace(/^"+|"+$/g, '').toUpperCase();
}

/**
 * Inspect whether a TanStack Query key matches a set of upper-case table names
 * or an event name.
 */
export function matchesFirebirdQueryKey(
  queryKey: readonly unknown[],
  filter: { tables?: ReadonlySet<string>; event?: string },
): boolean {
  if (!Array.isArray(queryKey) || queryKey[0] !== FIREBIRD_QUERY_KEY_PREFIX) {
    return false;
  }
  const meta = queryKey[1] as
    | {
        sql?: string;
        tables?: readonly string[];
        events?: readonly string[];
      }
    | undefined;
  if (!meta || typeof meta !== 'object') {
    return true;
  }

  if (filter.event) {
    if (Array.isArray(meta.events) && meta.events.includes(filter.event)) {
      return true;
    }
  }

  if (filter.tables && filter.tables.size > 0) {
    const queryTables = Array.isArray(meta.tables)
      ? meta.tables.map((t) => stripQuotes(t))
      : typeof meta.sql === 'string'
        ? extractReferencedTables(meta.sql)
        : [];
    for (const t of queryTables) {
      if (filter.tables.has(t)) {
        return true;
      }
    }
    return false;
  }

  return !filter.event;
}

/**
 * Bridge a `FirebirdBrowser` instance and/or Electric multi-shape sync with a
 * TanStack `QueryClient`.
 */
export async function connectFirebirdQueryClient(
  db: TanStackFirebirdDatabase,
  queryClient: TanStackQueryClientLike,
  options: ConnectFirebirdQueryClientOptions = {},
): Promise<FirebirdQueryClientBridge> {
  const unsubscribers: Array<() => Promise<void>> = [];

  const invalidateTables = async (tables?: readonly string[]): Promise<void> => {
    if (!tables || tables.length === 0) {
      await queryClient.invalidateQueries({
        queryKey: [FIREBIRD_QUERY_KEY_PREFIX],
      });
      return;
    }
    const tableSet = new Set(tables.map(stripQuotes));
    await queryClient.invalidateQueries({
      queryKey: [FIREBIRD_QUERY_KEY_PREFIX],
      predicate: (query) => matchesFirebirdQueryKey(query.queryKey, { tables: tableSet }),
    });
  };

  const invalidateEvent = async (event: string): Promise<void> => {
    const mappedTables = options.eventToTables?.[event];
    const inferredTable = event.startsWith('fb_live_')
      ? event.slice('fb_live_'.length)
      : event.startsWith('electric_')
        ? event.slice('electric_'.length)
        : undefined;
    const tableSet = new Set<string>();
    if (mappedTables) {
      for (const t of mappedTables) tableSet.add(stripQuotes(t));
    }
    if (inferredTable) {
      tableSet.add(stripQuotes(inferredTable));
    }

    await queryClient.invalidateQueries({
      queryKey: [FIREBIRD_QUERY_KEY_PREFIX],
      predicate: (query) =>
        matchesFirebirdQueryKey(query.queryKey, {
          event,
          tables: tableSet.size > 0 ? tableSet : undefined,
        }),
    });
  };

  if (typeof db.onEvent === 'function') {
    const eventNames = new Set<string>(options.events ?? []);
    for (const table of options.tables ?? []) {
      const upper = stripQuotes(table);
      eventNames.add(upper);
      eventNames.add(`fb_live_${upper}`);
    }
    for (const eventName of eventNames) {
      const unsub = await db.onEvent(eventName, () => {
        void invalidateEvent(eventName);
      });
      unsubscribers.push(unsub);
    }
  }

  return {
    invalidateTables,
    invalidateEvent,
    onSyncBatchCommitted(info: { tables: string[] }): void {
      void invalidateTables(info.tables);
    },
    async close(): Promise<void> {
      while (unsubscribers.length > 0) {
        const unsub = unsubscribers.pop();
        if (unsub) {
          await unsub();
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. TanStack Mutation Options for Durable Offline WriteQueue
// ---------------------------------------------------------------------------

/** Mutation payload accepted by {@link createWriteQueueMutationOptions}. */
export type WriteQueueMutationVariables =
  | {
      operation: 'insert';
      table: string;
      value: Record<string, unknown>;
    }
  | {
      operation: 'update';
      table: string;
      key: Record<string, unknown>;
      value: Record<string, unknown>;
    }
  | {
      operation: 'delete';
      table: string;
      key: Record<string, unknown>;
    };

/** Options for {@link createWriteQueueMutationOptions}. */
export interface WriteQueueMutationAdapterOptions {
  /** Optional TanStack `QueryClient` to invalidate affected table queries immediately after local apply. */
  queryClient?: TanStackQueryClientLike;
  /** If `true`, calls `writes.flush()` immediately after recording the local mutation (default `false`, since `WriteQueue` schedules sending automatically). */
  flushImmediately?: boolean;
}

/**
 * Create a TanStack Query `mutationOptions` descriptor (`{ mutationKey, mutationFn }`)
 * that records optimistic local writes through a durable `WriteQueue` (`FB_WRITE_QUEUE$`)
 * and invalidates matching TanStack queries as soon as the local Firebird
 * transaction commits.
 */
export function createWriteQueueMutationOptions(
  writes: TanStackWriteQueueLike,
  options: WriteQueueMutationAdapterOptions = {},
): {
  readonly mutationKey: readonly [typeof FIREBIRD_QUERY_KEY_PREFIX, 'writeQueue'];
  readonly mutationFn: (variables: WriteQueueMutationVariables) => Promise<unknown>;
} {
  return {
    mutationKey: [FIREBIRD_QUERY_KEY_PREFIX, 'writeQueue'] as const,
    mutationFn: async (variables: WriteQueueMutationVariables): Promise<unknown> => {
      let result: unknown;
      if (variables.operation === 'insert') {
        result = await writes.insert(variables.table, variables.value);
      } else if (variables.operation === 'update') {
        result = await writes.update(variables.table, variables.key, variables.value);
      } else {
        result = await writes.delete(variables.table, variables.key);
      }

      if (options.queryClient) {
        const tableSet = new Set([stripQuotes(variables.table)]);
        await options.queryClient.invalidateQueries({
          queryKey: [FIREBIRD_QUERY_KEY_PREFIX],
          predicate: (query) => matchesFirebirdQueryKey(query.queryKey, { tables: tableSet }),
        });
      }

      if (options.flushImmediately && typeof writes.flush === 'function') {
        await writes.flush();
      }

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// 4. TanStack DB Local-First Collection Adapter (`createFirebirdCollection`)
// ---------------------------------------------------------------------------

/** Change event emitted to {@link FirebirdCollection.subscribe} listeners. */
export interface FirebirdCollectionChange<T extends Row = Row> {
  readonly type: 'initial' | 'insert' | 'update' | 'delete' | 'sync';
  readonly items: readonly T[];
  readonly map: ReadonlyMap<string, T>;
  readonly key?: string;
  readonly item?: T;
}

/** Options for {@link createFirebirdCollection}. */
export interface FirebirdCollectionOptions<T extends Row = Row> {
  /** Firebird SQL table name (e.g. `'TODOS'`). */
  table: string;
  /**
   * Primary key column name(s). Defaults to `'ID'`.
   * Matched case-insensitively against returned row properties.
   */
  primaryKey?: string | readonly string[];
  /**
   * Optional custom `SELECT` query used to load collection items.
   * Defaults to `SELECT * FROM <table>`.
   */
  selectSql?: string;
  /** Optional parameters for `selectSql`. */
  selectParams?: QueryParams;
  /**
   * Optional durable {@link TanStackWriteQueueLike} (`createWriteQueue`).
   * When provided, `collection.insert()`, `update()`, and `delete()` route
   * through the offline write queue (`FB_WRITE_QUEUE$`) in addition to
   * updating the local Firebird table.
   */
  writes?: TanStackWriteQueueLike;
  /**
   * Optional TanStack `QueryClient` to keep in sync when collection mutations
   * occur.
   */
  queryClient?: TanStackQueryClientLike;
  /**
   * Optional transform applied to each row read from Firebird.
   */
  mapRow?: (row: Row) => T;
}

/**
 * A local-first TanStack DB compatible collection backed by a Firebird SQL table.
 */
export interface FirebirdCollection<T extends Row = Row> {
  /** Collection identifier (table name). */
  readonly id: string;
  /** Primary key column(s). */
  readonly primaryKey: readonly string[];
  /** Latest in-memory snapshot of rows keyed by serialized primary key. */
  readonly state: ReadonlyMap<string, T>;
  /** Latest in-memory array of items. */
  readonly items: readonly T[];
  /** Load / refresh the collection from the underlying Firebird table. */
  refresh(): Promise<readonly T[]>;
  /** Query all rows currently in the Firebird table. */
  getAll(): Promise<readonly T[]>;
  /** Look up a single row by its primary key value (or composite key record). */
  get(key: string | number | Record<string, unknown>): Promise<T | undefined>;
  /** Insert a new row (via `writes` if configured, or direct SQL `INSERT`). */
  insert(item: T): Promise<T>;
  /** Update an existing row by key (via `writes` if configured, or direct SQL `UPDATE`). */
  update(
    key: string | number | Record<string, unknown>,
    patch: Partial<T>,
  ): Promise<T | undefined>;
  /** Insert or update a row depending on whether its primary key already exists. */
  upsert(item: T): Promise<T>;
  /** Delete a row by key (via `writes` if configured, or direct SQL `DELETE`). */
  delete(key: string | number | Record<string, unknown>): Promise<boolean>;
  /**
   * Subscribe to collection changes. Immediately emits the current items once
   * initial hydration finishes, and re-emits on any local mutation or `db.live()`
   * update.
   */
  subscribe(listener: (change: FirebirdCollectionChange<T>) => void): () => void;
  /**
   * TanStack DB `SyncConfig` object (`{ sync: ({ begin, write, commit }) => ... }`)
   * so this adapter can be passed directly into `@tanstack/db`'s `createCollection({ sync })`.
   */
  readonly tanstackSync: {
    sync: (params: {
      begin: () => void;
      write: (op: { type: 'insert' | 'update' | 'delete'; value?: T; previous?: T; key?: string }) => void;
      commit: () => void;
    }) => () => void;
  };
  /** Stop any active `db.live()` subscription. */
  close(): Promise<void>;
}

function quoteIdentifier(ident: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(ident)) {
    return ident.toUpperCase();
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

function getFieldCaseInsensitive(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

/**
 * Create a reactive local-first collection backed by a Firebird SQL table,
 * compatible with TanStack DB (`@tanstack/db`) and optionally wired to
 * `createWriteQueue` + `QueryClient`.
 */
export function createFirebirdCollection<T extends Row = Row>(
  db: TanStackFirebirdDatabase,
  options: FirebirdCollectionOptions<T>,
): FirebirdCollection<T> {
  const pkCols: readonly string[] = Array.isArray(options.primaryKey)
    ? options.primaryKey
    : [typeof options.primaryKey === 'string' ? options.primaryKey : 'ID'];
  const quotedTable = quoteIdentifier(options.table);
  const selectSql = options.selectSql ?? `SELECT * FROM ${quotedTable}`;
  const selectParams = options.selectParams ?? [];

  let currentMap = new Map<string, T>();
  let currentItems: T[] = [];
  const listeners = new Set<(change: FirebirdCollectionChange<T>) => void>();
  let liveSubPromise: Promise<LiveQuery<Row> | undefined> | null = null;
  let closed = false;

  const keyRecordFromInput = (
    input: string | number | Record<string, unknown>,
  ): Record<string, unknown> => {
    if (typeof input === 'object' && input !== null) {
      const rec: Record<string, unknown> = {};
      for (const col of pkCols) {
        rec[col] = getFieldCaseInsensitive(input, col);
      }
      return rec;
    }
    return { [pkCols[0]]: input };
  };

  const serializeKey = (input: string | number | Record<string, unknown>): string => {
    const rec = keyRecordFromInput(input);
    if (pkCols.length === 1) {
      return String(rec[pkCols[0]] ?? '');
    }
    return JSON.stringify(pkCols.map((c) => rec[c]));
  };

  const applyRows = (
    rawRows: Row[],
    type: FirebirdCollectionChange<T>['type'],
    changedKey?: string,
    changedItem?: T,
  ): readonly T[] => {
    const nextMap = new Map<string, T>();
    const nextItems: T[] = [];
    for (const raw of rawRows) {
      const item = options.mapRow
        ? options.mapRow({ ...raw })
        : ({ ...raw } as T);
      const key = serializeKey(item as Record<string, unknown>);
      nextMap.set(key, item);
      nextItems.push(item);
    }
    currentMap = nextMap;
    currentItems = nextItems;

    const event: FirebirdCollectionChange<T> = {
      type,
      items: currentItems,
      map: currentMap,
      ...(changedKey !== undefined ? { key: changedKey } : {}),
      ...(changedItem !== undefined ? { item: changedItem } : {}),
    };
    for (const listener of [...listeners]) {
      listener(event);
    }
    return currentItems;
  };

  const notifyQueryClient = async (): Promise<void> => {
    if (!options.queryClient) return;
    const tableSet = new Set([stripQuotes(options.table)]);
    await options.queryClient.invalidateQueries({
      queryKey: [FIREBIRD_QUERY_KEY_PREFIX],
      predicate: (query) => matchesFirebirdQueryKey(query.queryKey, { tables: tableSet }),
    });
  };

  const runStatement = async (sql: string, params: QueryParams): Promise<void> => {
    if (typeof db.execute === 'function') {
      await db.execute(sql, params);
    } else {
      await db.query(sql, params);
    }
  };

  const refresh = async (): Promise<readonly T[]> => {
    const result = await db.query<Row>(selectSql, selectParams);
    return applyRows(result.rows, 'sync');
  };

  const ensureLive = () => {
    if (liveSubPromise || closed || typeof db.live !== 'function') return;
    liveSubPromise = db
      .live<Row>(selectSql, { params: selectParams }, (rows) => {
        if (!closed) {
          applyRows(rows, 'sync');
        }
      })
      .then((sub) => {
        if (closed) {
          void sub.unsubscribe();
          return undefined;
        }
        return sub;
      })
      .catch(() => undefined);
  };

  const collection: FirebirdCollection<T> = {
    id: options.table,
    primaryKey: pkCols,
    get state(): ReadonlyMap<string, T> {
      return currentMap;
    },
    get items(): readonly T[] {
      return currentItems;
    },
    refresh,
    async getAll(): Promise<readonly T[]> {
      return refresh();
    },
    async get(key: string | number | Record<string, unknown>): Promise<T | undefined> {
      const k = serializeKey(key);
      if (currentMap.has(k)) {
        return currentMap.get(k);
      }
      await refresh();
      return currentMap.get(k);
    },
    async insert(item: T): Promise<T> {
      if (options.writes) {
        await options.writes.insert(options.table, item as Record<string, unknown>);
      } else {
        const cols = Object.keys(item);
        const quotedCols = cols.map(quoteIdentifier).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const values = cols.map((c) => item[c]) as QueryParams;
        await runStatement(
          `INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`,
          values,
        );
      }
      const result = await db.query<Row>(selectSql, selectParams);
      const k = serializeKey(item as Record<string, unknown>);
      applyRows(result.rows, 'insert', k, currentMap.get(k) ?? item);
      await notifyQueryClient();
      return currentMap.get(k) ?? item;
    },
    async update(
      key: string | number | Record<string, unknown>,
      patch: Partial<T>,
    ): Promise<T | undefined> {
      const keyRec = keyRecordFromInput(key);
      const patchEntries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (patchEntries.length === 0) {
        return collection.get(key);
      }

      if (options.writes) {
        const cleanPatch: Record<string, unknown> = {};
        for (const [k, v] of patchEntries) cleanPatch[k] = v;
        await options.writes.update(options.table, keyRec, cleanPatch);
      } else {
        const setClause = patchEntries
          .map(([col]) => `${quoteIdentifier(col)} = ?`)
          .join(', ');
        const whereClause = pkCols
          .map((col) => `${quoteIdentifier(col)} = ?`)
          .join(' AND ');
        const params = [
          ...patchEntries.map(([, v]) => v),
          ...pkCols.map((col) => keyRec[col]),
        ] as QueryParams;
        await runStatement(
          `UPDATE ${quotedTable} SET ${setClause} WHERE ${whereClause}`,
          params,
        );
      }

      const result = await db.query<Row>(selectSql, selectParams);
      const k = serializeKey(keyRec);
      applyRows(result.rows, 'update', k);
      await notifyQueryClient();
      return currentMap.get(k);
    },
    async upsert(item: T): Promise<T> {
      const existing = await collection.get(item as Record<string, unknown>);
      if (existing) {
        const updated = await collection.update(item as Record<string, unknown>, item);
        return updated ?? item;
      }
      return collection.insert(item);
    },
    async delete(key: string | number | Record<string, unknown>): Promise<boolean> {
      const keyRec = keyRecordFromInput(key);
      const k = serializeKey(keyRec);
      const existed = currentMap.has(k) || (await collection.get(keyRec)) !== undefined;

      if (options.writes) {
        await options.writes.delete(options.table, keyRec);
      } else {
        const whereClause = pkCols
          .map((col) => `${quoteIdentifier(col)} = ?`)
          .join(' AND ');
        const params = pkCols.map((col) => keyRec[col]) as QueryParams;
        await runStatement(`DELETE FROM ${quotedTable} WHERE ${whereClause}`, params);
      }

      const result = await db.query<Row>(selectSql, selectParams);
      applyRows(result.rows, 'delete', k);
      await notifyQueryClient();
      return existed;
    },
    subscribe(listener: (change: FirebirdCollectionChange<T>) => void): () => void {
      listeners.add(listener);
      ensureLive();
      if (currentItems.length > 0) {
        listener({
          type: 'initial',
          items: currentItems,
          map: currentMap,
        });
      } else {
        void refresh();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    tanstackSync: {
      sync({ begin, write, commit }) {
        let prevMap = new Map<string, T>();
        return collection.subscribe((change) => {
          begin();
          const nextMap = change.map;
          for (const [k, item] of nextMap.entries()) {
            const prev = prevMap.get(k);
            if (!prev) {
              write({ type: 'insert', key: k, value: item });
            } else if (JSON.stringify(prev) !== JSON.stringify(item)) {
              write({ type: 'update', key: k, value: item, previous: prev });
            }
          }
          for (const [k, prev] of prevMap.entries()) {
            if (!nextMap.has(k)) {
              write({ type: 'delete', key: k, previous: prev });
            }
          }
          prevMap = new Map(nextMap);
          commit();
        });
      },
    },
    async close(): Promise<void> {
      closed = true;
      listeners.clear();
      if (liveSubPromise) {
        const sub = await liveSubPromise;
        liveSubPromise = null;
        if (sub) {
          await sub.unsubscribe();
        }
      }
    },
  };

  return collection;
}
