/**
 * tanstack-db/index.ts – `@tanstack/db`-Compatible Reactive Sync Collection Adapter
 * (`createFirebirdCollection`, `electricFirebirdCollectionOptions`) & Cross-Collection
 * Live Differential Join Views (`createLiveDifferentialView`) (`M32 Item 1`).
 */

import type { QueryParams, QueryResult, Row } from '../types';

export interface TanStackCompatibleDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  onQuery?: (listener: (event: { sql: string; params?: unknown }) => void) => () => void;
}

export interface CollectionDifferentialChange<T> {
  readonly key: string;
  readonly type: 'insert' | 'update' | 'delete';
  readonly value?: T;
  readonly previousValue?: T;
  readonly optimistic: boolean;
}

export interface CollectionDeltaBatch<T> {
  readonly added: readonly T[];
  readonly modified: ReadonlyArray<{ readonly key: string; readonly previous: T; readonly next: T }>;
  readonly removed: readonly T[];
  readonly changes: readonly CollectionDifferentialChange<T>[];
  readonly rows: readonly T[];
}

export type CollectionDeltaListener<T> = (batch: CollectionDeltaBatch<T>) => void;

export interface RemoteMutationResult {
  readonly txid?: number;
}

export interface FirebirdCollectionOptions<T extends Row = Row> {
  /** Collection identifier (defaults to lowercase `table`). */
  readonly id?: string;
  /** Backed Firebird table name. */
  readonly table: string;
  /** Primary key column name (or custom key extractor). @default 'ID' */
  readonly primaryKey?: string;
  /** Optional custom key extractor. */
  readonly getKey?: (item: T) => string | number;
  /** Optional `CREATE TABLE ...` DDL executed if `table` does not exist yet. */
  readonly autoCreateSql?: string;
  /** Optional ordering clause when hydrating from Firebird (e.g. `'ID ASC'`). */
  readonly orderBy?: string;
  /** Optional `waitForTxId` reconciliation hook (e.g. from `syncShapeToTable` or `WasmShapeServer`). */
  readonly waitForTxId?: (txid: number, timeoutMs?: number) => Promise<void>;
  /** Optional remote `insert` mutation handler returning `{ txid }`. */
  readonly onInsert?: (items: readonly T[]) => Promise<RemoteMutationResult | void>;
  /** Optional remote `update` mutation handler returning `{ txid }`. */
  readonly onUpdate?: (
    updates: ReadonlyArray<{ readonly key: string; readonly previous: T; readonly changes: Partial<T>; readonly next: T }>,
  ) => Promise<RemoteMutationResult | void>;
  /** Optional remote `delete` mutation handler returning `{ txid }`. */
  readonly onDelete?: (
    deletes: ReadonlyArray<{ readonly key: string; readonly previous: T }>,
  ) => Promise<RemoteMutationResult | void>;
  /** Timeout for `waitForTxId` reconciliation in milliseconds. @default 5000 */
  readonly txTimeoutMs?: number;
}

export interface PendingOptimisticMutation<T> {
  readonly id: string;
  readonly op: 'insert' | 'update' | 'delete';
  readonly keys: readonly string[];
  readonly startedAtMs: number;
  readonly snapshotBefore: ReadonlyMap<string, T | undefined>;
}

export interface FirebirdCollection<T extends Row = Row> {
  readonly id: string;
  readonly table: string;
  readonly primaryKey: string;
  /** Current materialized view of rows (`confirmed` overlaid with active `optimistic` mutations). */
  readonly state: ReadonlyMap<string, T>;
  /** Pending optimistic mutations awaiting server `txid` confirmation. */
  readonly pendingMutations: readonly PendingOptimisticMutation<T>[];
  readonly isReady: boolean;
  /** Ensure optional `autoCreateSql` and load initial rows from Firebird. */
  preload(): Promise<T[]>;
  /** Reload confirmed state from the underlying Firebird table and emit any differential delta. */
  refreshFromDatabase(): Promise<CollectionDeltaBatch<T>>;
  /** Return all rows in insertion/key order. */
  toArray(): T[];
  /** Lookup a single item by primary key. */
  get(key: string | number): T | undefined;
  /** Optimistically insert one or more rows, persist to Firebird, and reconcile remote `txid`. */
  insert(input: T | readonly T[]): Promise<{ keys: string[]; txid?: number }>;
  /** Optimistically update a row by key, persist to Firebird, and reconcile remote `txid`. */
  update(
    key: string | number,
    updater: Partial<T> | ((draft: T) => T | Partial<T>),
  ): Promise<{ key: string; next: T; txid?: number }>;
  /** Optimistically delete one or more rows by key, persist to Firebird, and reconcile remote `txid`. */
  delete(keys: string | number | ReadonlyArray<string | number>): Promise<{ keys: string[]; txid?: number }>;
  /** Subscribe to fine-grained `(added, modified, removed)` differential row batches. */
  subscribeChanges(
    listener: CollectionDeltaListener<T>,
    options?: { emitInitial?: boolean },
  ): () => void;
  /** Apply an external server/shape sync batch directly to confirmed state (`@tanstack/db` sync bridge). */
  applySyncedRows(
    mutations: ReadonlyArray<{ type: 'insert' | 'update' | 'delete'; value?: T; key?: string | number }>,
  ): CollectionDeltaBatch<T>;
  dispose(): void;
}

function qTsIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function readCaseInsensitive(row: Record<string, unknown>, col: string): unknown {
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

async function execTsSql(
  db: TanStackCompatibleDatabase,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

function shallowEqualRow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function computeMapDiff<T extends Row>(
  prev: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
  optimistic: boolean,
): CollectionDeltaBatch<T> {
  const added: T[] = [];
  const modified: Array<{ key: string; previous: T; next: T }> = [];
  const removed: T[] = [];
  const changes: CollectionDifferentialChange<T>[] = [];

  for (const [k, nextVal] of next) {
    const prevVal = prev.get(k);
    if (prevVal === undefined) {
      added.push(nextVal);
      changes.push({ key: k, type: 'insert', value: nextVal, optimistic });
    } else if (!shallowEqualRow(prevVal, nextVal)) {
      modified.push({ key: k, previous: prevVal, next: nextVal });
      changes.push({
        key: k,
        type: 'update',
        value: nextVal,
        previousValue: prevVal,
        optimistic,
      });
    }
  }

  for (const [k, prevVal] of prev) {
    if (!next.has(k)) {
      removed.push(prevVal);
      changes.push({ key: k, type: 'delete', previousValue: prevVal, optimistic });
    }
  }

  return {
    added,
    modified,
    removed,
    changes,
    rows: [...next.values()],
  };
}

let mutCounter = 0;

/**
 * Create a `@tanstack/db`-compatible reactive Firebird collection with optimistic
 * mutations, local SQL persistence, and server `txid` reconciliation (`M32 Item 1`).
 */
export function createFirebirdCollection<T extends Row = Row>(
  db: TanStackCompatibleDatabase,
  options: FirebirdCollectionOptions<T>,
): FirebirdCollection<T> {
  const tableUpper = options.table.trim().replace(/^"|"$/g, '').toUpperCase();
  const pkCol = (options.primaryKey ?? 'ID').trim().replace(/^"|"$/g, '');
  const pkUpper = pkCol.toUpperCase();
  const id = options.id ?? tableUpper.toLowerCase();
  const txTimeoutMs = options.txTimeoutMs ?? 5_000;

  const keyOf = (item: T): string => {
    if (options.getKey) return String(options.getKey(item));
    const v = readCaseInsensitive(item, pkUpper);
    if (v === undefined || v === null) {
      throw new Error(`Primary key "${pkCol}" missing on row in collection "${id}".`);
    }
    return String(v);
  };

  let confirmed = new Map<string, T>();
  let effective = new Map<string, T>();
  const pending: Array<{
    id: string;
    op: 'insert' | 'update' | 'delete';
    keys: string[];
    startedAtMs: number;
    snapshotBefore: Map<string, T | undefined>;
    applyOverlay: (map: Map<string, T>) => void;
  }> = [];
  const listeners = new Set<CollectionDeltaListener<T>>();
  let ready = false;

  const recomputeEffective = (optimisticFlag: boolean): CollectionDeltaBatch<T> => {
    const next = new Map<string, T>(confirmed);
    for (const m of pending) {
      m.applyOverlay(next);
    }
    const prev = effective;
    effective = next;
    const batch = computeMapDiff(prev, effective, optimisticFlag);
    if (batch.changes.length > 0) {
      for (const fn of listeners) fn(batch);
    }
    return batch;
  };

  const ensureTableIfConfigured = async (): Promise<void> => {
    if (!options.autoCreateSql) return;
    const chk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [tableUpper],
    );
    const cnt = Number(readCaseInsensitive(chk.rows[0] ?? {}, 'CNT') ?? 0);
    if (cnt === 0) {
      await execTsSql(db, options.autoCreateSql);
    }
  };

  const refreshFromDatabase = async (): Promise<CollectionDeltaBatch<T>> => {
    await ensureTableIfConfigured();
    const orderSql = options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
    const res = await db.query<T>(`SELECT * FROM ${qTsIdent(tableUpper)}${orderSql}`);
    const nextConfirmed = new Map<string, T>();
    for (const r of res.rows) {
      nextConfirmed.set(keyOf(r), r);
    }
    confirmed = nextConfirmed;
    ready = true;
    return recomputeEffective(false);
  };

  const upsertRowInDb = async (item: T): Promise<void> => {
    const cols = Object.keys(item);
    if (cols.length === 0) return;
    const quotedCols = cols.map((c) => qTsIdent(c.toUpperCase())).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const vals = cols.map((c) => item[c]);
    await execTsSql(
      db,
      `UPDATE OR INSERT INTO ${qTsIdent(tableUpper)} (${quotedCols}) VALUES (${placeholders}) MATCHING (${qTsIdent(pkUpper)})`,
      vals,
    );
  };

  const deleteKeyInDb = async (rawKey: string | number): Promise<void> => {
    await execTsSql(
      db,
      `DELETE FROM ${qTsIdent(tableUpper)} WHERE ${qTsIdent(pkUpper)} = ?`,
      [rawKey],
    );
  };

  const removePending = (mutId: string): void => {
    const idx = pending.findIndex((p) => p.id === mutId);
    if (idx >= 0) pending.splice(idx, 1);
  };

  return {
    id,
    table: tableUpper,
    primaryKey: pkUpper,
    get state() {
      return effective;
    },
    get pendingMutations() {
      return pending.map((p) => ({
        id: p.id,
        op: p.op,
        keys: p.keys,
        startedAtMs: p.startedAtMs,
        snapshotBefore: p.snapshotBefore,
      }));
    },
    get isReady() {
      return ready;
    },

    async preload(): Promise<T[]> {
      await refreshFromDatabase();
      return [...effective.values()];
    },

    refreshFromDatabase,

    toArray(): T[] {
      return [...effective.values()];
    },

    get(key: string | number): T | undefined {
      return effective.get(String(key));
    },

    async insert(input: T | readonly T[]): Promise<{ keys: string[]; txid?: number }> {
      await ensureTableIfConfigured();
      const items = (Array.isArray(input) ? input : [input]) as readonly T[];
      const keys = items.map((it) => keyOf(it));
      const before = new Map<string, T | undefined>();
      for (const k of keys) before.set(k, confirmed.get(k));

      const mutId = `mut_${++mutCounter}`;
      pending.push({
        id: mutId,
        op: 'insert',
        keys,
        startedAtMs: Date.now(),
        snapshotBefore: before,
        applyOverlay(map) {
          for (let i = 0; i < items.length; i++) {
            map.set(keys[i]!, items[i]!);
          }
        },
      });
      recomputeEffective(true);

      try {
        for (const it of items) {
          await upsertRowInDb(it);
        }
        let txid: number | undefined;
        if (options.onInsert) {
          const remoteRes = await options.onInsert(items);
          txid = remoteRes?.txid;
          if (txid !== undefined && options.waitForTxId) {
            await options.waitForTxId(txid, txTimeoutMs);
          }
        }
        for (let i = 0; i < items.length; i++) {
          confirmed.set(keys[i]!, items[i]!);
        }
        removePending(mutId);
        recomputeEffective(false);
        return { keys, ...(txid !== undefined ? { txid } : {}) };
      } catch (err) {
        for (const [k, prevRow] of before) {
          if (prevRow === undefined) await deleteKeyInDb(k).catch(() => undefined);
          else await upsertRowInDb(prevRow).catch(() => undefined);
        }
        removePending(mutId);
        recomputeEffective(false);
        throw err;
      }
    },

    async update(
      rawKey: string | number,
      updater: Partial<T> | ((draft: T) => T | Partial<T>),
    ): Promise<{ key: string; next: T; txid?: number }> {
      await ensureTableIfConfigured();
      const k = String(rawKey);
      const current = effective.get(k);
      if (!current) {
        throw new Error(`Cannot update missing key "${k}" in collection "${id}".`);
      }
      const patch =
        typeof updater === 'function' ? updater({ ...current }) : updater;
      const nextRow = { ...current, ...patch } as T;
      const before = new Map<string, T | undefined>([[k, confirmed.get(k)]]);

      const mutId = `mut_${++mutCounter}`;
      pending.push({
        id: mutId,
        op: 'update',
        keys: [k],
        startedAtMs: Date.now(),
        snapshotBefore: before,
        applyOverlay(map) {
          map.set(k, nextRow);
        },
      });
      recomputeEffective(true);

      try {
        await upsertRowInDb(nextRow);
        let txid: number | undefined;
        if (options.onUpdate) {
          const remoteRes = await options.onUpdate([
            { key: k, previous: current, changes: patch, next: nextRow },
          ]);
          txid = remoteRes?.txid;
          if (txid !== undefined && options.waitForTxId) {
            await options.waitForTxId(txid, txTimeoutMs);
          }
        }
        confirmed.set(k, nextRow);
        removePending(mutId);
        recomputeEffective(false);
        return { key: k, next: nextRow, ...(txid !== undefined ? { txid } : {}) };
      } catch (err) {
        const orig = before.get(k);
        if (orig !== undefined) await upsertRowInDb(orig).catch(() => undefined);
        removePending(mutId);
        recomputeEffective(false);
        throw err;
      }
    },

    async delete(
      rawKeys: string | number | ReadonlyArray<string | number>,
    ): Promise<{ keys: string[]; txid?: number }> {
      await ensureTableIfConfigured();
      const keyList = (Array.isArray(rawKeys) ? rawKeys : [rawKeys]) as ReadonlyArray<string | number>;
      const keys = keyList.map((k) => String(k));
      const before = new Map<string, T | undefined>();
      const deletePayloads: Array<{ key: string; previous: T }> = [];
      for (const k of keys) {
        const cur = effective.get(k);
        before.set(k, confirmed.get(k));
        if (cur) deletePayloads.push({ key: k, previous: cur });
      }

      const mutId = `mut_${++mutCounter}`;
      pending.push({
        id: mutId,
        op: 'delete',
        keys,
        startedAtMs: Date.now(),
        snapshotBefore: before,
        applyOverlay(map) {
          for (const k of keys) map.delete(k);
        },
      });
      recomputeEffective(true);

      try {
        for (const rk of keyList) {
          await deleteKeyInDb(rk);
        }
        let txid: number | undefined;
        if (options.onDelete && deletePayloads.length > 0) {
          const remoteRes = await options.onDelete(deletePayloads);
          txid = remoteRes?.txid;
          if (txid !== undefined && options.waitForTxId) {
            await options.waitForTxId(txid, txTimeoutMs);
          }
        }
        for (const k of keys) confirmed.delete(k);
        removePending(mutId);
        recomputeEffective(false);
        return { keys, ...(txid !== undefined ? { txid } : {}) };
      } catch (err) {
        for (const [, orig] of before) {
          if (orig !== undefined) await upsertRowInDb(orig).catch(() => undefined);
        }
        removePending(mutId);
        recomputeEffective(false);
        throw err;
      }
    },

    subscribeChanges(
      listener: CollectionDeltaListener<T>,
      subOpts?: { emitInitial?: boolean },
    ): () => void {
      listeners.add(listener);
      if (subOpts?.emitInitial && effective.size > 0) {
        const rows = [...effective.values()];
        listener({
          added: rows,
          modified: [],
          removed: [],
          changes: rows.map((r) => ({
            key: keyOf(r),
            type: 'insert',
            value: r,
            optimistic: false,
          })),
          rows,
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },

    applySyncedRows(
      mutations: ReadonlyArray<{ type: 'insert' | 'update' | 'delete'; value?: T; key?: string | number }>,
    ): CollectionDeltaBatch<T> {
      for (const m of mutations) {
        if (m.type === 'delete') {
          const k = m.key !== undefined ? String(m.key) : m.value ? keyOf(m.value) : '';
          if (k) confirmed.delete(k);
        } else if (m.value) {
          const k = m.key !== undefined ? String(m.key) : keyOf(m.value);
          confirmed.set(k, m.value);
        }
      }
      ready = true;
      return recomputeEffective(false);
    },

    dispose(): void {
      listeners.clear();
      pending.length = 0;
    },
  };
}

/**
 * Build a `@tanstack/db`-compatible `CollectionConfig` object backed by `FirebirdDatabase`
 * (`sync: { sync: ({ begin, write, commit, markReady }) => ... }`) (`M32 Item 1`).
 */
export function electricFirebirdCollectionOptions<T extends Row = Row>(
  db: TanStackCompatibleDatabase,
  options: FirebirdCollectionOptions<T>,
) {
  const col = createFirebirdCollection<T>(db, options);
  return {
    id: col.id,
    collection: col,
    getKey: (item: T) =>
      options.getKey
        ? options.getKey(item)
        : (readCaseInsensitive(item, col.primaryKey) as string | number),
    sync: {
      sync(params: {
        begin: () => void;
        write: (msg: { type: 'insert' | 'update' | 'delete'; value?: T; previousValue?: T }) => void;
        commit: () => void;
        markReady: () => void;
      }): () => void {
        let active = true;
        const unsub = col.subscribeChanges((batch) => {
          if (!active || batch.changes.length === 0) return;
          params.begin();
          for (const ch of batch.changes) {
            params.write({
              type: ch.type,
              value: ch.value,
              previousValue: ch.previousValue,
            });
          }
          params.commit();
        });
        void col.preload().then((initialRows) => {
          if (!active) return;
          if (initialRows.length > 0) {
            params.begin();
            for (const r of initialRows) {
              params.write({ type: 'insert', value: r });
            }
            params.commit();
          }
          params.markReady();
        });
        return () => {
          active = false;
          unsub();
          col.dispose();
        };
      },
    },
    async onInsert(ctx: { transaction: { mutations: ReadonlyArray<{ modified: T }> } }) {
      const items = ctx.transaction.mutations.map((m) => m.modified);
      await col.insert(items);
    },
    async onUpdate(ctx: {
      transaction: { mutations: ReadonlyArray<{ key: string | number; changes: Partial<T> }> };
    }) {
      for (const m of ctx.transaction.mutations) {
        await col.update(m.key, m.changes);
      }
    },
    async onDelete(ctx: { transaction: { mutations: ReadonlyArray<{ key: string | number }> } }) {
      await col.delete(ctx.transaction.mutations.map((m) => m.key));
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-Collection Reactive Live Differential Join View (`M32 Item 1`)
// ---------------------------------------------------------------------------

export interface LiveDifferentialJoinOptions<
  TLeft extends Row,
  TRight extends Row,
  TOut extends Row,
> {
  readonly left: FirebirdCollection<TLeft>;
  readonly right: FirebirdCollection<TRight>;
  readonly leftKey: (row: TLeft) => string | number | null | undefined;
  readonly rightKey: (row: TRight) => string | number | null | undefined;
  readonly joinType?: 'inner' | 'left';
  readonly filter?: (left: TLeft, right: TRight | null) => boolean;
  readonly select: (left: TLeft, right: TRight | null) => TOut;
  readonly resultKey?: (out: TOut, leftKeyId: string, rightKeyId: string) => string;
}

export interface LiveDifferentialView<TOut extends Row> {
  readonly state: ReadonlyMap<string, TOut>;
  toArray(): TOut[];
  subscribeChanges(
    listener: CollectionDeltaListener<TOut>,
    options?: { emitInitial?: boolean },
  ): () => void;
  recompute(): CollectionDeltaBatch<TOut>;
  dispose(): void;
}

/**
 * Maintain a reactive hash-joined differential view across two `FirebirdCollection`s,
 * emitting fine-grained `(added, modified, removed)` row deltas without SQL re-queries (`M32 Item 1`).
 */
export function createLiveDifferentialView<
  TLeft extends Row,
  TRight extends Row,
  TOut extends Row,
>(
  options: LiveDifferentialJoinOptions<TLeft, TRight, TOut>,
): LiveDifferentialView<TOut> {
  const joinType = options.joinType ?? 'inner';
  let current = new Map<string, TOut>();
  const listeners = new Set<CollectionDeltaListener<TOut>>();

  const evaluate = (): CollectionDeltaBatch<TOut> => {
    // Build hash index over right collection O(|R|)
    const rightBuckets = new Map<string, Array<{ rId: string; row: TRight }>>();
    for (const [rId, rRow] of options.right.state) {
      const jk = options.rightKey(rRow);
      if (jk === null || jk === undefined) continue;
      const kStr = String(jk);
      let arr = rightBuckets.get(kStr);
      if (!arr) {
        arr = [];
        rightBuckets.set(kStr, arr);
      }
      arr.push({ rId, row: rRow });
    }

    const next = new Map<string, TOut>();
    for (const [lId, lRow] of options.left.state) {
      const lk = options.leftKey(lRow);
      const matches = lk !== null && lk !== undefined ? rightBuckets.get(String(lk)) : undefined;
      if (matches && matches.length > 0) {
        for (const m of matches) {
          if (options.filter && !options.filter(lRow, m.row)) continue;
          const projected = options.select(lRow, m.row);
          const outKey = options.resultKey
            ? options.resultKey(projected, lId, m.rId)
            : `${lId}::${m.rId}`;
          next.set(outKey, projected);
        }
      } else if (joinType === 'left') {
        if (options.filter && !options.filter(lRow, null)) continue;
        const projected = options.select(lRow, null);
        const outKey = options.resultKey
          ? options.resultKey(projected, lId, '$null')
          : `${lId}::$null`;
        next.set(outKey, projected);
      }
    }

    const prev = current;
    current = next;
    const batch = computeMapDiff(prev, current, false);
    if (batch.changes.length > 0) {
      for (const fn of listeners) fn(batch);
    }
    return batch;
  };

  evaluate();
  const unsubLeft = options.left.subscribeChanges(() => evaluate());
  const unsubRight = options.right.subscribeChanges(() => evaluate());

  return {
    get state() {
      return current;
    },
    toArray(): TOut[] {
      return [...current.values()];
    },
    subscribeChanges(
      listener: CollectionDeltaListener<TOut>,
      subOpts?: { emitInitial?: boolean },
    ): () => void {
      listeners.add(listener);
      if (subOpts?.emitInitial && current.size > 0) {
        const rows = [...current.values()];
        listener({
          added: rows,
          modified: [],
          removed: [],
          changes: rows.map((v, idx) => ({
            key: [...current.keys()][idx]!,
            type: 'insert',
            value: v,
            optimistic: false,
          })),
          rows,
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
    recompute: evaluate,
    dispose(): void {
      unsubLeft();
      unsubRight();
      listeners.clear();
    },
  };
}
