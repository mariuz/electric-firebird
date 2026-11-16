/**
 * live-incremental.ts – Incremental Row-Delta Live Queries (`db.liveIncremental()`)
 * & Zero-Copy Columnar Live Queries (`db.liveColumnar()`) (`M20 Item 3`).
 *
 * Shared across `FirebirdBrowser` (WASM) and `FirebirdLite` (Node.js):
 * - Preserves JS object identity (`prevRow === nextRow`) for unchanged rows so
 *   virtualized data grids and `React.memo` / Vue / Solid / Svelte components
 *   re-render only the rows that actually changed.
 * - Suppresses no-op notifications when a watched table event did not alter the
 *   query's projected result set.
 * - Supports direct O(k) in-memory replication log patching via `applyChanges()`.
 */

import type { FieldInfo, QueryParams, QueryResult, Row } from './types';
import { toStatement, type SqlFragment } from './sql-tag';
import type { ColumnarQueryResult, ColumnVector } from './columnar';
import type { StandardSchemaV1 } from './schema-validation';
import type { ReplicationLogEntry } from './replication/types';

/** Key selector for `db.liveIncremental()` (`M20 Item 3`). */
export type LiveRowKeySelector<T = Row> =
  | string
  | readonly string[]
  | ((row: T, index: number) => string | number);

/** Single row change emitted by `db.liveIncremental()` (`M20 Item 3`). */
export interface LiveRowDelta<T = Row> {
  readonly type: 'insert' | 'update' | 'delete';
  readonly key: string | number;
  readonly row?: T;
  readonly oldRow?: T;
  /** Index in the new `rows` array (`insert` / `update`), or previous index (`delete`). */
  readonly index: number;
  /** Previous index in `rows` before an `update` (when `type === 'update'`). */
  readonly previousIndex?: number;
}

/** Snapshot delivered to `db.liveIncremental()` listeners (`M20 Item 3`). */
export interface IncrementalLiveSnapshot<T = Row> {
  /** Current result rows (with object references preserved for unchanged rows). */
  readonly rows: readonly T[];
  /** Ordered `insert` / `update` / `delete` deltas since the previous snapshot. */
  readonly deltas: readonly LiveRowDelta<T>[];
  /** Result column metadata. */
  readonly fields: readonly FieldInfo[];
  /** Monotonically increasing snapshot version (`1` on initial load). */
  readonly version: number;
  /** `true` on the initial query execution, `false` on subsequent updates. */
  readonly isInitial: boolean;
}

/** Options for `db.liveIncremental()` (`M20 Item 3`). */
export interface LiveIncrementalOptions<T = Row> {
  /** Primary key column(s) or custom key extractor. Defaults to `'ID'` or first column. */
  key?: LiveRowKeySelector<T>;
  /** Explicit Firebird `POST_EVENT` names to watch (auto-inferred from SQL tables when omitted). */
  events?: readonly string[];
  /** Positional parameters when `sql` is a string with `?` placeholders. */
  params?: QueryParams;
  /** Optional Standard Schema v1 row validator (`M19 Item 4`). */
  schema?: StandardSchemaV1<unknown, T>;
  /** Polling interval in milliseconds. @default 250 */
  pollIntervalMs?: number;
  /** Emit an `'update'` delta when an unchanged row moves to a different sort index. @default false */
  emitMoves?: boolean;
  /** Emit snapshots even when `deltas` is empty and row order did not change. @default false */
  emitEmptyUpdates?: boolean;
  /** Optional error callback for background refresh failures. */
  onError?: (error: Error) => void;
}

/** Active incremental live query handle returned by `db.liveIncremental()` (`M20 Item 3`). */
export interface LiveIncrementalQuery<T = Row> {
  /** Latest rows (with structural sharing across refreshes). */
  readonly rows: readonly T[];
  /** Latest full snapshot (`{ rows, deltas, fields, version, isInitial }`). */
  readonly current: IncrementalLiveSnapshot<T>;
  /** Current monotonic snapshot version. */
  readonly version: number;
  /** Subscribe to subsequent snapshots; returns an unsubscribe function. */
  subscribe(listener: (snapshot: IncrementalLiveSnapshot<T>) => void): () => void;
  /** Force an immediate query refresh and return the resulting snapshot. */
  refresh(): Promise<IncrementalLiveSnapshot<T>>;
  /**
   * Apply incoming replication journal entries directly in memory without
   * re-querying SQL, emitting a new incremental snapshot if any rows changed.
   */
  applyChanges(entries: readonly ReplicationLogEntry[]): IncrementalLiveSnapshot<T>;
  /** Stop watching events and release underlying subscriptions. */
  unsubscribe(): Promise<void>;
  /** Alias for {@link unsubscribe} (`await using live = await db.liveIncremental(...)`). */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for `db.liveColumnar()` (`M20 Item 3`). */
export interface LiveColumnarOptions {
  /** Explicit Firebird `POST_EVENT` names to watch (auto-inferred from SQL tables when omitted). */
  events?: readonly string[];
  /** Positional parameters when `sql` is a string with `?` placeholders. */
  params?: QueryParams;
  /** Polling interval in milliseconds. @default 250 */
  pollIntervalMs?: number;
  /** Emit snapshots even when the columnar buffers are byte-for-byte identical. @default false */
  emitUnchanged?: boolean;
  /** Optional error callback for background refresh failures. */
  onError?: (error: Error) => void;
}

/** Active columnar live query handle returned by `db.liveColumnar()` (`M20 Item 3`). */
export interface LiveColumnarQuery {
  /** Latest `ColumnarQueryResult` typed vectors. */
  readonly current: ColumnarQueryResult;
  /** Current monotonic version (`1` on initial load). */
  readonly version: number;
  /** Subscribe to subsequent `ColumnarQueryResult` updates; returns an unsubscribe function. */
  subscribe(
    listener: (result: ColumnarQueryResult, version: number) => void,
  ): () => void;
  /** Force an immediate columnar re-query. */
  refresh(): Promise<ColumnarQueryResult>;
  /** Stop watching events and release underlying subscriptions. */
  unsubscribe(): Promise<void>;
  /** Alias for {@link unsubscribe} (`await using col = await db.liveColumnar(...)`). */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Host adapter supplied by `FirebirdBrowser` or `FirebirdLite`. */
export interface LiveQueryHostAdapter<T extends Row = Row> {
  query?(
    sql: string,
    params?: QueryParams,
    options?: { schema?: StandardSchemaV1<unknown, T> },
  ): Promise<QueryResult<T>>;
  queryColumnar(sql: string, params?: QueryParams): Promise<ColumnarQueryResult>;
  watchSqlEvents(
    sqlText: string,
    explicitEvents: readonly string[] | undefined,
    onWakeup: () => void,
    options: { pollIntervalMs?: number; onError: (error: Error) => void },
  ): Promise<() => Promise<void>>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cellValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return bytesEqual(a, b);
  }
  return false;
}

/** Shallow column-by-column equality check for two row objects (`M20 Item 3`). */
export function shallowRowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i]!;
    if (!Object.prototype.hasOwnProperty.call(recB, k)) return false;
    if (!cellValuesEqual(recA[k], recB[k])) return false;
  }
  return true;
}

function readRowColumnInsensitive(rec: Record<string, unknown>, col: string): unknown {
  if (col in rec) return rec[col];
  const upper = col.toUpperCase();
  if (upper in rec) return rec[upper];
  const lower = col.toLowerCase();
  if (lower in rec) return rec[lower];
  return undefined;
}

export function buildRowKeyExtractor<T>(
  keyOption: LiveRowKeySelector<T> | undefined,
  fields: readonly FieldInfo[],
): (row: T, index: number) => string | number {
  if (typeof keyOption === 'function') {
    return keyOption;
  }
  if (Array.isArray(keyOption)) {
    const cols = [...keyOption];
    return (row: T, idx: number) => {
      const rec = row as unknown as Record<string, unknown>;
      return cols.map((c) => String(readRowColumnInsensitive(rec, c) ?? idx)).join('\u001f');
    };
  }
  if (typeof keyOption === 'string' && keyOption.trim().length > 0) {
    const col = keyOption.trim();
    return (row: T, idx: number) => {
      const rec = row as unknown as Record<string, unknown>;
      const v = readRowColumnInsensitive(rec, col);
      return typeof v === 'number' || typeof v === 'string' ? v : v != null ? String(v) : idx;
    };
  }

  // Default: prefer 'ID' column if present, otherwise first column in `fields`
  const hasIdField = fields.some((f) => f.name.toUpperCase() === 'ID');
  const fallbackCol = hasIdField ? 'ID' : fields[0]?.name;
  if (fallbackCol) {
    return (row: T, idx: number) => {
      const rec = row as unknown as Record<string, unknown>;
      const v = readRowColumnInsensitive(rec, fallbackCol);
      return typeof v === 'number' || typeof v === 'string' ? v : v != null ? String(v) : idx;
    };
  }
  return (_row: T, idx: number) => idx;
}

/**
 * Compute minimal `insert` / `update` / `delete` deltas between `prevRows` and
 * `nextRawRows`, preserving exact JS object references (`prevRow === nextRow`)
 * for unchanged rows (`M20 Item 3`).
 */
export function computeIncrementalRowDeltas<T>(
  prevRows: readonly T[],
  nextRawRows: readonly T[],
  extractKey: (row: T, index: number) => string | number,
  options: { isInitial?: boolean; emitMoves?: boolean } = {},
): {
  rows: T[];
  deltas: LiveRowDelta<T>[];
  orderChanged: boolean;
} {
  if (options.isInitial) {
    const rows = [...nextRawRows];
    const deltas: LiveRowDelta<T>[] = rows.map((row, index) => ({
      type: 'insert',
      key: extractKey(row, index),
      row,
      index,
    }));
    return { rows, deltas, orderChanged: rows.length > 0 };
  }

  const prevMap = new Map<string | number, { row: T; index: number }>();
  for (let i = 0; i < prevRows.length; i++) {
    const r = prevRows[i]!;
    prevMap.set(extractKey(r, i), { row: r, index: i });
  }

  const seenKeys = new Set<string | number>();
  const finalRows: T[] = new Array(nextRawRows.length);
  const insertOrUpdateDeltas: LiveRowDelta<T>[] = [];
  let orderChanged = prevRows.length !== nextRawRows.length;

  for (let nextIdx = 0; nextIdx < nextRawRows.length; nextIdx++) {
    const candidate = nextRawRows[nextIdx]!;
    const key = extractKey(candidate, nextIdx);
    seenKeys.add(key);

    const prevEntry = prevMap.get(key);
    if (!prevEntry) {
      finalRows[nextIdx] = candidate;
      orderChanged = true;
      insertOrUpdateDeltas.push({
        type: 'insert',
        key,
        row: candidate,
        index: nextIdx,
      });
    } else {
      if (prevEntry.index !== nextIdx) {
        orderChanged = true;
      }
      if (shallowRowEqual(prevEntry.row, candidate)) {
        // Preserve exact JS reference for unchanged row!
        finalRows[nextIdx] = prevEntry.row;
        if (options.emitMoves && prevEntry.index !== nextIdx) {
          insertOrUpdateDeltas.push({
            type: 'update',
            key,
            row: prevEntry.row,
            oldRow: prevEntry.row,
            index: nextIdx,
            previousIndex: prevEntry.index,
          });
        }
      } else {
        finalRows[nextIdx] = candidate;
        insertOrUpdateDeltas.push({
          type: 'update',
          key,
          row: candidate,
          oldRow: prevEntry.row,
          index: nextIdx,
          previousIndex: prevEntry.index,
        });
      }
    }
  }

  const deleteDeltas: LiveRowDelta<T>[] = [];
  for (const [key, prevEntry] of prevMap.entries()) {
    if (!seenKeys.has(key)) {
      orderChanged = true;
      deleteDeltas.push({
        type: 'delete',
        key,
        oldRow: prevEntry.row,
        index: prevEntry.index,
      });
    }
  }

  return {
    rows: finalRows,
    deltas: [...deleteDeltas, ...insertOrUpdateDeltas],
    orderChanged,
  };
}

/** Create and start an active `LiveIncrementalQuery<T>` (`M20 Item 3`). */
export async function createLiveIncrementalQuery<T extends Row = Row>(
  host: LiveQueryHostAdapter<T>,
  sql: string | SqlFragment,
  options: LiveIncrementalOptions<T> = {},
  initialListener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
): Promise<LiveIncrementalQuery<T>> {
  if (options.events !== undefined && options.events.length === 0) {
    throw new RangeError(
      'liveIncremental() needs at least one event name when { events } is provided',
    );
  }

  const statement = toStatement(sql, options.params ?? []);
  const onError =
    options.onError ??
    ((error: Error) => console.error('[firebird-wasm] liveIncremental failed', error));

  const listeners = new Set<(snapshot: IncrementalLiveSnapshot<T>) => void>();
  if (initialListener) {
    listeners.add(initialListener);
  }

  let currentRows: T[] = [];
  let currentFields: readonly FieldInfo[] = [];
  let version = 0;
  let stopped = false;
  let refreshing = false;
  let again = false;

  let currentSnapshot: IncrementalLiveSnapshot<T> = {
    rows: currentRows,
    deltas: [],
    fields: currentFields,
    version: 0,
    isInitial: true,
  };

  const emitSnapshot = (snap: IncrementalLiveSnapshot<T>): void => {
    currentSnapshot = snap;
    for (const cb of [...listeners]) {
      cb(snap);
    }
  };

  const runOnce = async (forceEmit = false): Promise<IncrementalLiveSnapshot<T>> => {
    const result = await host.query!(
      statement.sql,
      statement.params,
      options.schema ? { schema: options.schema } : undefined,
    );
    const isInitial = version === 0;
    currentFields = result.fields;
    const keyExtractor = buildRowKeyExtractor<T>(options.key, currentFields);
    const { rows, deltas, orderChanged } = computeIncrementalRowDeltas(
      currentRows,
      result.rows,
      keyExtractor,
      { isInitial, emitMoves: options.emitMoves },
    );

    if (
      !isInitial &&
      !forceEmit &&
      !options.emitEmptyUpdates &&
      deltas.length === 0 &&
      !orderChanged
    ) {
      return currentSnapshot;
    }

    currentRows = rows;
    version += 1;
    const snap: IncrementalLiveSnapshot<T> = {
      rows: currentRows,
      deltas,
      fields: currentFields,
      version,
      isInitial,
    };
    emitSnapshot(snap);
    return snap;
  };

  const drain = async (): Promise<void> => {
    refreshing = true;
    try {
      while (again && !stopped) {
        again = false;
        try {
          await runOnce(false);
        } catch (err) {
          if (!stopped) onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      refreshing = false;
    }
  };

  const requestRefresh = (): void => {
    if (stopped) return;
    again = true;
    if (!refreshing) void drain();
  };

  const stopWatching = await host.watchSqlEvents(
    statement.sql,
    options.events,
    requestRefresh,
    { pollIntervalMs: options.pollIntervalMs, onError },
  );

  refreshing = true;
  try {
    await runOnce(true);
  } catch (err) {
    stopped = true;
    await stopWatching();
    throw err;
  } finally {
    refreshing = false;
  }
  if (again) void drain();

  const handle: LiveIncrementalQuery<T> = {
    get rows() {
      return currentRows;
    },
    get current() {
      return currentSnapshot;
    },
    get version() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      if (stopped) return currentSnapshot;
      return runOnce(true);
    },
    applyChanges(entries) {
      if (stopped || entries.length === 0) return currentSnapshot;
      const keyExtractor = buildRowKeyExtractor<T>(options.key, currentFields);
      const nextList = [...currentRows];

      for (const entry of entries) {
        if (entry.operation === 'DDL') continue;
        const sampleRow = (entry.after ?? entry.before ?? entry.key) as unknown as T;
        const targetKey = keyExtractor(sampleRow, -1);
        const existingIdx = nextList.findIndex(
          (r, idx) => keyExtractor(r, idx) === targetKey,
        );

        if (entry.operation === 'DELETE') {
          if (existingIdx !== -1) {
            nextList.splice(existingIdx, 1);
          }
        } else if (entry.after) {
          const incoming = { ...entry.after } as unknown as T;
          if (existingIdx !== -1) {
            nextList[existingIdx] = {
              ...(nextList[existingIdx] as Record<string, unknown>),
              ...entry.after,
            } as T;
          } else {
            nextList.push(incoming);
          }
        }
      }

      const { rows, deltas, orderChanged } = computeIncrementalRowDeltas(
        currentRows,
        nextList,
        keyExtractor,
        { isInitial: false, emitMoves: options.emitMoves },
      );
      if (deltas.length === 0 && !orderChanged && !options.emitEmptyUpdates) {
        return currentSnapshot;
      }
      currentRows = rows;
      version += 1;
      const snap: IncrementalLiveSnapshot<T> = {
        rows: currentRows,
        deltas,
        fields: currentFields,
        version,
        isInitial: false,
      };
      emitSnapshot(snap);
      return snap;
    },
    async unsubscribe() {
      if (stopped) return;
      stopped = true;
      listeners.clear();
      await stopWatching();
    },
    async [Symbol.asyncDispose]() {
      await handle.unsubscribe();
    },
  };

  return handle;
}

function typedArrayBytes(arr: ArrayBufferView): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function vectorsEqual(a: ColumnVector, b: ColumnVector): boolean {
  if (a.kind !== b.kind || a.length !== b.length || a.nullCount !== b.nullCount) {
    return false;
  }
  if (!bytesEqual(a.validity, b.validity)) {
    return false;
  }
  if ((a.kind === 'utf8' || a.kind === 'bytes') && (b.kind === 'utf8' || b.kind === 'bytes')) {
    return (
      bytesEqual(typedArrayBytes(a.offsets), typedArrayBytes(b.offsets)) &&
      bytesEqual(a.data, b.data)
    );
  }
  return bytesEqual(typedArrayBytes(a.data), typedArrayBytes(b.data));
}

/** Byte-exact equality test for two `ColumnarQueryResult` instances (`M20 Item 3`). */
export function columnarResultsEqual(
  a: ColumnarQueryResult | null,
  b: ColumnarQueryResult,
): boolean {
  if (!a) return false;
  if (a.rowCount !== b.rowCount || a.vectors.length !== b.vectors.length) {
    return false;
  }
  for (let i = 0; i < a.fields.length; i++) {
    if (a.fields[i]?.name !== b.fields[i]?.name) return false;
  }
  for (let i = 0; i < a.vectors.length; i++) {
    if (!vectorsEqual(a.vectors[i]!, b.vectors[i]!)) return false;
  }
  return true;
}

/** Create and start an active `LiveColumnarQuery` (`M20 Item 3`). */
export async function createLiveColumnarQuery(
  host: LiveQueryHostAdapter,
  sql: string | SqlFragment,
  options: LiveColumnarOptions = {},
  initialListener?: (result: ColumnarQueryResult, version: number) => void,
): Promise<LiveColumnarQuery> {
  if (options.events !== undefined && options.events.length === 0) {
    throw new RangeError(
      'liveColumnar() needs at least one event name when { events } is provided',
    );
  }

  const statement = toStatement(sql, options.params ?? []);
  const onError =
    options.onError ??
    ((error: Error) => console.error('[firebird-wasm] liveColumnar failed', error));

  const listeners = new Set<(result: ColumnarQueryResult, version: number) => void>();
  if (initialListener) {
    listeners.add(initialListener);
  }

  let currentResult: ColumnarQueryResult | null = null;
  let version = 0;
  let stopped = false;
  let refreshing = false;
  let again = false;

  const runOnce = async (forceEmit = false): Promise<ColumnarQueryResult> => {
    const next = await host.queryColumnar(statement.sql, statement.params);
    if (
      !forceEmit &&
      !options.emitUnchanged &&
      columnarResultsEqual(currentResult, next)
    ) {
      return currentResult!;
    }
    currentResult = next;
    version += 1;
    for (const cb of [...listeners]) {
      cb(next, version);
    }
    return next;
  };

  const drain = async (): Promise<void> => {
    refreshing = true;
    try {
      while (again && !stopped) {
        again = false;
        try {
          await runOnce(false);
        } catch (err) {
          if (!stopped) onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      refreshing = false;
    }
  };

  const requestRefresh = (): void => {
    if (stopped) return;
    again = true;
    if (!refreshing) void drain();
  };

  const stopWatching = await host.watchSqlEvents(
    statement.sql,
    options.events,
    requestRefresh,
    { pollIntervalMs: options.pollIntervalMs, onError },
  );

  refreshing = true;
  try {
    await runOnce(true);
  } catch (err) {
    stopped = true;
    await stopWatching();
    throw err;
  } finally {
    refreshing = false;
  }
  if (again) void drain();

  const handle: LiveColumnarQuery = {
    get current() {
      return currentResult!;
    },
    get version() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      if (stopped) return currentResult!;
      return runOnce(true);
    },
    async unsubscribe() {
      if (stopped) return;
      stopped = true;
      listeners.clear();
      await stopWatching();
    },
    async [Symbol.asyncDispose]() {
      await handle.unsubscribe();
    },
  };

  return handle;
}
