/**
 * optimistic-store.ts – Optimistic Local-First Mutation Queue with Automatic
 * Pre-Image Capture, Inverse-Row Rollback & Reactive Table Store (`M22 Item 3`).
 */

import type { QueryParams, QueryResult, Row } from './types';
import {
  createTableRepository,
  quoteTableIdent,
  type TableExecutionHost,
  type TableFindOptions,
  type TableOptions,
  type TableRepository,
} from './table-api';
import {
  IncrementalQueryStore,
  type IncrementalQueryableDatabase,
} from './frameworks/sync-store';
import type { LiveRowDelta } from './live-incremental';

export type OptimisticOperation = 'INSERT' | 'UPDATE' | 'UPSERT' | 'DELETE';

export interface PendingOptimisticMutation {
  readonly id: string;
  readonly tableName: string;
  readonly primaryKey: readonly string[];
  readonly operation: OptimisticOperation;
  readonly keyValue: unknown;
  /** Row state before this optimistic mutation (`null` if row did not exist before). */
  readonly beforeRow: Row | null;
  /** Row state written optimistically (`null` for `DELETE`). */
  readonly afterRow: Row | null;
  readonly createdAt: number;
  readonly status: 'pending' | 'flushing' | 'reverted';
  readonly error?: Error;
}

export interface OptimisticStoreSnapshot {
  readonly pendingCount: number;
  readonly flushing: boolean;
  readonly pending: readonly PendingOptimisticMutation[];
  readonly confirmedCount: number;
  readonly revertedCount: number;
  readonly lastError: Error | undefined;
}

export interface OptimisticMutationStoreOptions {
  /**
   * Optional replication `SyncHandle` (e.g. from `db.syncWith()`, `syncDatabases()`,
   * or `createTenantReplicationSlice()`) invoked on `flush()`.
   */
  syncHandle?: { syncNow(): Promise<unknown> } | null;
  /**
   * Optional custom async remote commit handler invoked on `flush(mutations)`.
   * Takes precedence over `syncHandle` when both are supplied.
   */
  remoteSync?: (mutations: readonly PendingOptimisticMutation[]) => Promise<void>;
  /**
   * Automatically trigger `flush()` in the background after each optimistic write
   * when `syncHandle` or `remoteSync` is configured.
   *
   * @default false
   */
  autoFlush?: boolean;
  /** Callback invoked whenever a mutation fails remote sync and is rolled back locally. */
  onMutationFailed?: (mutation: PendingOptimisticMutation, error: Error) => void;
}

export interface OptimisticFlushResult {
  readonly confirmed: number;
  readonly reverted: number;
  readonly errors: readonly Error[];
}

export interface OptimisticTableActions<T extends Row = Row, K = unknown> {
  insert(row: Partial<T> & Record<string, unknown>): Promise<{ mutationId: string; row: T }>;
  update(
    key: K,
    patch: Partial<T> & Record<string, unknown>,
  ): Promise<{ mutationId: string; affectedRows: number }>;
  upsert(
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<{ mutationId: string; row: T }>;
  delete(key: K): Promise<{ mutationId: string; affectedRows: number }>;
  revert(mutationId: string): Promise<boolean>;
  flush(): Promise<OptimisticFlushResult>;
}

export interface OptimisticMutationStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => OptimisticStoreSnapshot;
  insert<T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    options?: { primaryKey?: string | readonly string[] },
  ): Promise<{ mutationId: string; row: T }>;
  update<T extends Row = Row, K = unknown>(
    tableName: string,
    key: K,
    patch: Partial<T> & Record<string, unknown>,
    options?: { primaryKey?: string | readonly string[] },
  ): Promise<{ mutationId: string; affectedRows: number }>;
  upsert<T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    options?: {
      primaryKey?: string | readonly string[];
      matchingColumns?: readonly string[];
    },
  ): Promise<{ mutationId: string; row: T }>;
  delete<K = unknown>(
    tableName: string,
    key: K,
    options?: { primaryKey?: string | readonly string[] },
  ): Promise<{ mutationId: string; affectedRows: number }>;
  /** Roll back a pending optimistic mutation in-place using its captured pre-image. */
  revert(mutationId: string): Promise<boolean>;
  /** Revert all currently pending optimistic mutations in reverse chronological order. */
  revertAll(): Promise<number>;
  /** Push pending optimistic mutations to `remoteSync` / `syncHandle`; rolls back locally on failure. */
  flush(): Promise<OptimisticFlushResult>;
  /** Return typed optimistic CRUD helpers bound to `tableName`. */
  table<T extends Row = Row, K = unknown>(
    tableName: string,
    options?: TableOptions<T>,
  ): OptimisticTableActions<T, K>;
}

function normalizePkList(pk?: string | readonly string[]): string[] {
  if (!pk) return ['ID'];
  if (typeof pk === 'string') return [pk.toUpperCase()];
  return pk.length > 0 ? pk.map((c) => String(c).toUpperCase()) : ['ID'];
}

function getFieldCI(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

function extractKeyFromRow(row: Record<string, unknown>, pkCols: readonly string[]): unknown {
  if (pkCols.length === 1) {
    return getFieldCI(row, pkCols[0]!);
  }
  const obj: Record<string, unknown> = {};
  for (const c of pkCols) {
    obj[c] = getFieldCI(row, c);
  }
  return obj;
}

/**
 * Create an optimistic local-first mutation store backed by a Firebird database
 * (`FirebirdBrowser`, `FirebirdLite`, or `ReplicaRouter`) (`M22 Item 3`).
 */
export function createOptimisticMutationStore(
  db: TableExecutionHost & { notify?(name: string): Promise<void> },
  options: OptimisticMutationStoreOptions = {},
): OptimisticMutationStore {
  const listeners = new Set<() => void>();
  let nextSeq = 1;
  let pendingList: PendingOptimisticMutation[] = [];
  let flushing = false;
  let confirmedCount = 0;
  let revertedCount = 0;
  let lastError: Error | undefined = undefined;

  let snapshot: OptimisticStoreSnapshot = {
    pendingCount: 0,
    flushing: false,
    pending: [],
    confirmedCount: 0,
    revertedCount: 0,
    lastError: undefined,
  };

  const emit = (): void => {
    snapshot = {
      pendingCount: pendingList.length,
      flushing,
      pending: [...pendingList],
      confirmedCount,
      revertedCount,
      lastError,
    };
    for (const cb of [...listeners]) {
      cb();
    }
  };

  const applyInverseMutation = async (m: PendingOptimisticMutation): Promise<void> => {
    const repo = createTableRepository<Row, unknown>(db, m.tableName, {
      primaryKey: m.primaryKey,
      cacheStatements: false,
    });

    if (m.beforeRow === null) {
      // Row did not exist prior to INSERT / UPSERT -> DELETE it
      if (m.keyValue !== undefined && m.keyValue !== null) {
        await repo.delete(m.keyValue);
      }
      return;
    }

    if (m.operation === 'DELETE') {
      // Row was deleted -> re-insert its exact pre-mutation state
      await repo.upsert(m.beforeRow as Record<string, unknown>, m.primaryKey);
      return;
    }

    // Row existed before UPDATE / UPSERT -> restore all pre-mutation columns
    await repo.upsert(m.beforeRow as Record<string, unknown>, m.primaryKey);
  };

  const maybeAutoFlush = (): void => {
    if (options.autoFlush && (options.remoteSync || options.syncHandle)) {
      void store.flush().catch(() => undefined);
    }
  };

  const store: OptimisticMutationStore = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => snapshot,

    async insert<T extends Row = Row>(
      tableName: string,
      row: Partial<T> & Record<string, unknown>,
      opts: { primaryKey?: string | readonly string[] } = {},
    ): Promise<{ mutationId: string; row: T }> {
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<T, unknown>(db, tableName, {
        primaryKey: pkCols,
      });
      const inserted = await repo.insert(row);
      await repo.close();
      const keyVal = extractKeyFromRow(inserted as Record<string, unknown>, pkCols);
      const mutationId = `opt_${nextSeq++}`;
      pendingList = [
        ...pendingList,
        {
          id: mutationId,
          tableName: tableName.toUpperCase(),
          primaryKey: pkCols,
          operation: 'INSERT',
          keyValue: keyVal,
          beforeRow: null,
          afterRow: inserted,
          createdAt: Date.now(),
          status: 'pending',
        },
      ];
      emit();
      maybeAutoFlush();
      return { mutationId, row: inserted };
    },

    async update<T extends Row = Row, K = unknown>(
      tableName: string,
      key: K,
      patch: Partial<T> & Record<string, unknown>,
      opts: { primaryKey?: string | readonly string[] } = {},
    ): Promise<{ mutationId: string; affectedRows: number }> {
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<T, K>(db, tableName, {
        primaryKey: pkCols,
      });
      const beforeRow = await repo.get(key);
      const res = await repo.update(key, patch);
      const afterRow = res.affectedRows > 0 ? await repo.get(key) : beforeRow;
      await repo.close();
      const mutationId = `opt_${nextSeq++}`;
      if (res.affectedRows > 0) {
        pendingList = [
          ...pendingList,
          {
            id: mutationId,
            tableName: tableName.toUpperCase(),
            primaryKey: pkCols,
            operation: 'UPDATE',
            keyValue: key,
            beforeRow,
            afterRow,
            createdAt: Date.now(),
            status: 'pending',
          },
        ];
        emit();
        maybeAutoFlush();
      }
      return { mutationId, affectedRows: res.affectedRows };
    },

    async upsert<T extends Row = Row>(
      tableName: string,
      row: Partial<T> & Record<string, unknown>,
      opts: {
        primaryKey?: string | readonly string[];
        matchingColumns?: readonly string[];
      } = {},
    ): Promise<{ mutationId: string; row: T }> {
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<T, unknown>(db, tableName, {
        primaryKey: pkCols,
      });
      const candidateKey = extractKeyFromRow(row, pkCols);
      const beforeRow =
        candidateKey !== undefined && candidateKey !== null
          ? await repo.get(candidateKey)
          : null;
      const upserted = await repo.upsert(row, opts.matchingColumns);
      await repo.close();
      const finalKey = extractKeyFromRow(upserted as Record<string, unknown>, pkCols);
      const mutationId = `opt_${nextSeq++}`;
      pendingList = [
        ...pendingList,
        {
          id: mutationId,
          tableName: tableName.toUpperCase(),
          primaryKey: pkCols,
          operation: 'UPSERT',
          keyValue: finalKey,
          beforeRow,
          afterRow: upserted,
          createdAt: Date.now(),
          status: 'pending',
        },
      ];
      emit();
      maybeAutoFlush();
      return { mutationId, row: upserted };
    },

    async delete<K = unknown>(
      tableName: string,
      key: K,
      opts: { primaryKey?: string | readonly string[] } = {},
    ): Promise<{ mutationId: string; affectedRows: number }> {
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<Row, K>(db, tableName, {
        primaryKey: pkCols,
      });
      const beforeRow = await repo.get(key);
      const res = await repo.delete(key);
      await repo.close();
      const mutationId = `opt_${nextSeq++}`;
      if (res.affectedRows > 0 && beforeRow) {
        pendingList = [
          ...pendingList,
          {
            id: mutationId,
            tableName: tableName.toUpperCase(),
            primaryKey: pkCols,
            operation: 'DELETE',
            keyValue: key,
            beforeRow,
            afterRow: null,
            createdAt: Date.now(),
            status: 'pending',
          },
        ];
        emit();
        maybeAutoFlush();
      }
      return { mutationId, affectedRows: res.affectedRows };
    },

    async revert(mutationId: string): Promise<boolean> {
      const idx = pendingList.findIndex((m) => m.id === mutationId);
      if (idx < 0) return false;
      const target = pendingList[idx]!;
      pendingList = pendingList.filter((m) => m.id !== mutationId);
      await applyInverseMutation(target);
      revertedCount += 1;
      emit();
      return true;
    },

    async revertAll(): Promise<number> {
      if (pendingList.length === 0) return 0;
      const toRevert = [...pendingList].reverse();
      pendingList = [];
      for (const m of toRevert) {
        await applyInverseMutation(m);
        revertedCount += 1;
      }
      emit();
      return toRevert.length;
    },

    async flush(): Promise<OptimisticFlushResult> {
      if (pendingList.length === 0) {
        return { confirmed: 0, reverted: 0, errors: [] };
      }
      if (flushing) {
        return { confirmed: 0, reverted: 0, errors: [] };
      }

      const batch = [...pendingList];
      const batchIds = new Set(batch.map((m) => m.id));
      flushing = true;
      lastError = undefined;
      pendingList = pendingList.map((m) =>
        batchIds.has(m.id) ? { ...m, status: 'flushing' } : m,
      );
      emit();

      try {
        if (options.remoteSync) {
          await options.remoteSync(batch);
        } else if (options.syncHandle) {
          await options.syncHandle.syncNow();
        }
        pendingList = pendingList.filter((m) => !batchIds.has(m.id));
        confirmedCount += batch.length;
        flushing = false;
        emit();
        return { confirmed: batch.length, reverted: 0, errors: [] };
      } catch (err) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        lastError = errorObj;
        // Roll back the rejected optimistic batch in reverse chronological order!
        pendingList = pendingList.filter((m) => !batchIds.has(m.id));
        const reversed = [...batch].reverse();
        for (const m of reversed) {
          try {
            await applyInverseMutation(m);
          } catch {
            // Best-effort local rollback
          }
          revertedCount += 1;
          options.onMutationFailed?.(
            { ...m, status: 'reverted', error: errorObj },
            errorObj,
          );
        }
        flushing = false;
        emit();
        return {
          confirmed: 0,
          reverted: batch.length,
          errors: [errorObj],
        };
      }
    },

    table<T extends Row = Row, K = unknown>(
      tableName: string,
      tableOpts: TableOptions<T> = {},
    ): OptimisticTableActions<T, K> {
      const pk = tableOpts.primaryKey as string | readonly string[] | undefined;
      return {
        insert: (row) => store.insert<T>(tableName, row, { primaryKey: pk }),
        update: (key, patch) =>
          store.update<T, K>(tableName, key, patch, { primaryKey: pk }),
        upsert: (row, matchingColumns) =>
          store.upsert<T>(tableName, row, {
            primaryKey: pk,
            matchingColumns: matchingColumns?.map((c) => String(c)),
          }),
        delete: (key) => store.delete<K>(tableName, key, { primaryKey: pk }),
        revert: (id) => store.revert(id),
        flush: () => store.flush(),
      };
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Framework-Agnostic `ReactiveTableStore<T, K>` (`useTable` / `createTable`)
// ---------------------------------------------------------------------------

export type ReactiveTableDatabase = TableExecutionHost & IncrementalQueryableDatabase;

export interface ReactiveTableStoreOptions<T extends Row = Row>
  extends TableOptions<T>,
    Omit<TableFindOptions<T>, 'offset' | 'cursor'> {
  /** Optional `OptimisticMutationStore` enabling optimistic writes + pending telemetry. */
  optimisticStore?: OptimisticMutationStore;
  /** Live event polling interval in milliseconds. @default 250 */
  pollIntervalMs?: number;
  /** Optional explicit Firebird `POST_EVENT` names to watch. */
  events?: readonly string[];
}

export interface ReactiveTableState<T extends Row = Row> {
  readonly rows: T[] | undefined;
  readonly deltas: readonly LiveRowDelta<T>[];
  readonly version: number;
  readonly loading: boolean;
  readonly error: Error | undefined;
  readonly pendingCount: number;
  readonly flushing: boolean;
}

function buildReactiveTableQuery<T extends Row>(
  tableName: string,
  pkCols: readonly string[],
  options: ReactiveTableStoreOptions<T>,
): { sql: string; params: QueryParams } {
  const quotedTable = quoteTableIdent(tableName);
  const cols =
    options.columns && options.columns.length > 0
      ? options.columns.map((c) => quoteTableIdent(String(c))).join(', ')
      : '*';
  let sql = `SELECT ${cols} FROM ${quotedTable}`;
  const params: QueryParams = [];

  if (options.where && typeof options.where === 'object' && !('sql' in options.where)) {
    const preds: string[] = [];
    for (const [k, v] of Object.entries(options.where as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (v === null) {
        preds.push(`${quoteTableIdent(k)} IS NULL`);
      } else {
        preds.push(`${quoteTableIdent(k)} = ?`);
        params.push(v);
      }
    }
    if (preds.length > 0) {
      sql += ` WHERE ${preds.join(' AND ')}`;
    }
  }

  if (typeof options.orderBy === 'string' && options.orderBy.trim()) {
    const parts = options.orderBy.trim().split(/\s+/);
    const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${quoteTableIdent(parts[0]!)} ${dir}`;
  } else if (Array.isArray(options.orderBy) && options.orderBy.length > 0) {
    const items = options.orderBy.map((item) => {
      if (typeof item === 'string') {
        const parts = item.trim().split(/\s+/);
        const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${quoteTableIdent(parts[0]!)} ${dir}`;
      }
      return `${quoteTableIdent(String(item.column))} ${item.direction === 'DESC' ? 'DESC' : 'ASC'}`;
    });
    sql += ` ORDER BY ${items.join(', ')}`;
  } else {
    sql += ` ORDER BY ${pkCols.map((c) => `${quoteTableIdent(c)} ASC`).join(', ')}`;
  }

  if (options.limit !== undefined && options.limit >= 0) {
    sql += ` FETCH FIRST ${Math.floor(options.limit)} ROWS ONLY`;
  }
  return { sql, params };
}

/**
 * Framework-agnostic reactive table store backing `useTable` (React / Vue) and
 * `createTable` (Svelte / Solid) (`M22 Item 3`).
 */
export class ReactiveTableStore<T extends Row = Row, K = unknown> {
  readonly repository: TableRepository<T, K>;
  private readonly queryStore: IncrementalQueryStore<T>;
  private readonly optStore: OptimisticMutationStore | undefined;
  private readonly pkCols: readonly string[];
  private readonly tableNameUpper: string;
  private readonly listeners = new Set<() => void>();
  private unsubQuery: (() => void) | null = null;
  private unsubOpt: (() => void) | null = null;
  private state: ReactiveTableState<T>;

  constructor(
    db: ReactiveTableDatabase,
    tableName: string,
    options: ReactiveTableStoreOptions<T> = {},
    initialRows?: T[],
  ) {
    this.tableNameUpper = tableName.toUpperCase();
    this.pkCols = normalizePkList(
      options.primaryKey as string | readonly string[] | undefined,
    );
    this.repository = createTableRepository<T, K>(db, tableName, options);
    this.optStore = options.optimisticStore;
    const { sql, params } = buildReactiveTableQuery(tableName, this.pkCols, options);
    const keyOpt = this.pkCols.length === 1 ? this.pkCols[0]! : this.pkCols;
    this.queryStore = new IncrementalQueryStore<T>(
      db as unknown as {
        query<R extends Row = Row>(s: string, p?: QueryParams): Promise<QueryResult<R>>;
      },
      sql,
      params,
      {
        key: keyOpt,
        events: options.events,
        pollIntervalMs: options.pollIntervalMs,
      },
      initialRows,
    );
    this.state = this.computeSnapshot();
  }

  private computeSnapshot(): ReactiveTableState<T> {
    const q = this.queryStore.getSnapshot();
    const o = this.optStore?.getSnapshot();
    return {
      rows: q.rows ? [...q.rows] : undefined,
      deltas: q.deltas,
      version: q.version,
      loading: q.loading,
      error: q.error ?? o?.lastError,
      pendingCount: o?.pendingCount ?? 0,
      flushing: o?.flushing ?? false,
    };
  }

  private syncSnapshot = (): void => {
    this.state = this.computeSnapshot();
    for (const cb of [...this.listeners]) {
      cb();
    }
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReactiveTableState<T> => this.state;

  start(): void {
    if (!this.unsubQuery) {
      this.unsubQuery = this.queryStore.subscribe(this.syncSnapshot);
    }
    if (this.optStore && !this.unsubOpt) {
      this.unsubOpt = this.optStore.subscribe(this.syncSnapshot);
    }
    this.queryStore.start();
    this.syncSnapshot();
  }

  stop(): void {
    this.unsubQuery?.();
    this.unsubQuery = null;
    this.unsubOpt?.();
    this.unsubOpt = null;
    this.queryStore.stop();
    void this.repository.close().catch(() => undefined);
  }

  readonly refresh = async (): Promise<void> => {
    await this.queryStore.refresh();
  };

  readonly insert = async (row: Partial<T> & Record<string, unknown>): Promise<T> => {
    if (this.optStore) {
      const res = await this.optStore.insert<T>(this.tableNameUpper, row, {
        primaryKey: this.pkCols,
      });
      await this.queryStore.refresh();
      return res.row;
    }
    const inserted = await this.repository.insert(row);
    await this.queryStore.refresh();
    return inserted;
  };

  readonly update = async (
    key: K,
    patch: Partial<T> & Record<string, unknown>,
  ): Promise<{ affectedRows: number }> => {
    const res = this.optStore
      ? await this.optStore.update<T, K>(this.tableNameUpper, key, patch, {
          primaryKey: this.pkCols,
        })
      : await this.repository.update(key, patch);
    await this.queryStore.refresh();
    return { affectedRows: res.affectedRows };
  };

  readonly upsert = async (
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<T> => {
    if (this.optStore) {
      const res = await this.optStore.upsert<T>(this.tableNameUpper, row, {
        primaryKey: this.pkCols,
        matchingColumns: matchingColumns?.map((c) => String(c)),
      });
      await this.queryStore.refresh();
      return res.row;
    }
    const upserted = await this.repository.upsert(row, matchingColumns);
    await this.queryStore.refresh();
    return upserted;
  };

  readonly remove = async (key: K): Promise<{ affectedRows: number }> => {
    const res = this.optStore
      ? await this.optStore.delete<K>(this.tableNameUpper, key, {
          primaryKey: this.pkCols,
        })
      : await this.repository.delete(key);
    await this.queryStore.refresh();
    return { affectedRows: res.affectedRows };
  };
}
