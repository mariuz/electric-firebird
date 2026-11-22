/**
 * reactive-table-store.ts – Framework-Agnostic `ReactiveTableStore<T, K>`
 * backing `useTable` (React / Vue) and `createTable` (Svelte / Solid) (`M22 Item 3`).
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
import type { OptimisticMutationStore } from './optimistic-store';

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

function normalizePkCols(
  pk: string | readonly string[] | undefined,
): readonly string[] {
  if (!pk) return ['ID'];
  if (typeof pk === 'string') return [pk.trim().toUpperCase()];
  return pk.length > 0 ? pk.map((c) => String(c).trim().toUpperCase()) : ['ID'];
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
    this.pkCols = normalizePkCols(
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
