/**
 * sync-store.ts – Framework-agnostic reactive stores for `SyncHandle` telemetry
 * (`SyncStatusStore`), columnar queries (`ColumnarQueryStore`), and incremental
 * delta queries (`IncrementalQueryStore`) (`M20 Item 4`).
 *
 * Shared across `firebird-wasm/react`, `firebird-wasm/vue`, `firebird-wasm/svelte`,
 * and `firebird-wasm/solid`.
 */

import type { QueryParams, QueryResult, Row } from '../types';
import {
  rowsToColumnarResult,
  type ColumnarQueryResult,
} from '../columnar';
import type {
  IncrementalLiveSnapshot,
  LiveColumnarOptions,
  LiveColumnarQuery,
  LiveIncrementalOptions,
  LiveIncrementalQuery,
  LiveRowDelta,
} from '../live-incremental';
import type { ReplicationStats } from '../replication/types';
import type { ConnectionLifecycleState } from '../replication/webrtc-resilient';

// ---------------------------------------------------------------------------
// 1. `SyncStatusStore`
// ---------------------------------------------------------------------------

/** Structural subset of `SyncHandle` consumed by {@link SyncStatusStore} (`M20 Item 4`). */
export interface SyncHandleLike {
  readonly mode?: string;
  readonly direction?: 'one-way' | 'bidirectional';
  readonly paused: boolean;
  readonly connectionState?: ConnectionLifecycleState;
  readonly replicator?: {
    readonly replicaSubscription?: {
      listDeadLetters?(): Promise<readonly unknown[]>;
    };
  };
  syncNow(): Promise<unknown>;
  pause(): void;
  resume(): void;
  stats(): Promise<ReplicationStats>;
}

/** Lifecycle status rendered by `useSyncStatus` / `createSyncStatus` (`M20 Item 4`). */
export type ReactiveSyncLifecycleState =
  | ConnectionLifecycleState
  | 'paused'
  | 'stopped';

/** Immutable snapshot held by {@link SyncStatusStore} (`M20 Item 4`). */
export interface SyncStatusState {
  readonly state: ReactiveSyncLifecycleState;
  readonly mode: string;
  readonly direction: 'one-way' | 'bidirectional';
  readonly paused: boolean;
  readonly syncing: boolean;
  readonly replicaLsn: number;
  readonly primaryLsn: number;
  readonly lagLsn: number;
  readonly lagEntries: number;
  readonly appliedCount: number;
  readonly conflictCount: number;
  readonly dlqCount: number;
  readonly lastSyncedAt: number | null;
  readonly error: Error | undefined;
}

/** Options for {@link SyncStatusStore} (`M20 Item 4`). */
export interface SyncStatusStoreOptions {
  /** Polling interval in milliseconds for refreshing `handle.stats()`. @default 500 */
  pollIntervalMs?: number;
}

function initialSyncState(handle: SyncHandleLike | null | undefined): SyncStatusState {
  if (!handle) {
    return {
      state: 'offline',
      mode: 'logical',
      direction: 'one-way',
      paused: false,
      syncing: false,
      replicaLsn: 0,
      primaryLsn: 0,
      lagLsn: 0,
      lagEntries: 0,
      appliedCount: 0,
      conflictCount: 0,
      dlqCount: 0,
      lastSyncedAt: null,
      error: undefined,
    };
  }
  return {
    state: handle.paused ? 'paused' : (handle.connectionState ?? 'online'),
    mode: handle.mode ?? 'logical',
    direction: handle.direction ?? 'one-way',
    paused: handle.paused,
    syncing: false,
    replicaLsn: 0,
    primaryLsn: 0,
    lagLsn: 0,
    lagEntries: 0,
    appliedCount: 0,
    conflictCount: 0,
    dlqCount: 0,
    lastSyncedAt: null,
    error: undefined,
  };
}

/** Framework-agnostic store tracking a `SyncHandle` (`M20 Item 4`). */
export class SyncStatusStore {
  private state: SyncStatusState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private generation = 0;

  constructor(
    private readonly handle: SyncHandleLike | null | undefined,
    private readonly options: SyncStatusStoreOptions = {},
  ) {
    this.state = initialSyncState(handle);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SyncStatusState => this.state;

  start(): void {
    if (this.running || !this.handle) return;
    this.running = true;
    const gen = ++this.generation;
    void this.refreshInternal(gen);
    const interval = this.options.pollIntervalMs ?? 500;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.refreshInternal(gen);
      }, interval);
      if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
        (this.timer as { unref: () => void }).unref();
      }
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  readonly refresh = async (): Promise<void> => {
    await this.refreshInternal(this.generation);
  };

  readonly syncNow = async (): Promise<void> => {
    if (!this.handle) return;
    const gen = this.generation;
    this.set({ ...this.state, syncing: true, error: undefined });
    try {
      await this.handle.syncNow();
      await this.refreshInternal(gen);
    } catch (err) {
      if (gen === this.generation) {
        this.set({
          ...this.state,
          syncing: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
      throw err;
    }
  };

  readonly pause = (): void => {
    if (!this.handle) return;
    this.handle.pause();
    this.set({
      ...this.state,
      paused: true,
      state: 'paused',
    });
  };

  readonly resume = (): void => {
    if (!this.handle) return;
    this.handle.resume();
    this.set({
      ...this.state,
      paused: this.handle.paused,
      state: this.handle.paused ? 'paused' : (this.handle.connectionState ?? 'online'),
    });
    void this.refreshInternal(this.generation);
  };

  private async refreshInternal(gen: number): Promise<void> {
    if (!this.handle || gen !== this.generation) return;
    try {
      const stats = await this.handle.stats();
      let dlqCount = 0;
      const listDlq = this.handle.replicator?.replicaSubscription?.listDeadLetters;
      if (typeof listDlq === 'function') {
        const dlq = await listDlq.call(this.handle.replicator!.replicaSubscription);
        dlqCount = dlq.length;
      }
      if (gen !== this.generation) return;

      const resolvedState: ReactiveSyncLifecycleState = this.handle.paused
        ? 'paused'
        : (this.handle.connectionState ?? 'online');

      const next: SyncStatusState = {
        state: resolvedState,
        mode: this.handle.mode ?? 'logical',
        direction: this.handle.direction ?? 'one-way',
        paused: this.handle.paused,
        syncing: false,
        replicaLsn: stats.replicaWatermark,
        primaryLsn: stats.primaryLsn,
        lagLsn: Math.max(0, stats.primaryLsn - stats.replicaWatermark),
        lagEntries: stats.lagEntries,
        appliedCount: stats.totalApplied,
        conflictCount: stats.totalConflicts,
        dlqCount,
        lastSyncedAt: stats.lastSyncedAt,
        error: undefined,
      };
      if (!shallowSyncStateEqual(this.state, next)) {
        this.set(next);
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.set({
        ...this.state,
        syncing: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  private set(next: SyncStatusState): void {
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }
}

function shallowSyncStateEqual(a: SyncStatusState, b: SyncStatusState): boolean {
  return (
    a.state === b.state &&
    a.mode === b.mode &&
    a.direction === b.direction &&
    a.paused === b.paused &&
    a.syncing === b.syncing &&
    a.replicaLsn === b.replicaLsn &&
    a.primaryLsn === b.primaryLsn &&
    a.lagLsn === b.lagLsn &&
    a.lagEntries === b.lagEntries &&
    a.appliedCount === b.appliedCount &&
    a.conflictCount === b.conflictCount &&
    a.dlqCount === b.dlqCount &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.error === b.error
  );
}

// ---------------------------------------------------------------------------
// 2. `ColumnarQueryStore`
// ---------------------------------------------------------------------------

/** Structural database subset accepted by {@link ColumnarQueryStore} (`M20 Item 4`). */
export interface ColumnarQueryableDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  queryColumnar?(sql: string, params?: QueryParams): Promise<ColumnarQueryResult>;
  liveColumnar?(
    sql: string,
    options?: LiveColumnarOptions,
    listener?: (result: ColumnarQueryResult, version: number) => void,
  ): Promise<LiveColumnarQuery>;
}

/** State snapshot emitted by {@link ColumnarQueryStore} (`M20 Item 4`). */
export interface ColumnarQueryState {
  readonly result: ColumnarQueryResult | undefined;
  readonly version: number;
  readonly error: Error | undefined;
  readonly loading: boolean;
}

export interface ColumnarStoreOptions {
  events?: readonly string[];
  live?: boolean;
  pollIntervalMs?: number;
}

export class ColumnarQueryStore {
  private state: ColumnarQueryState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private running = false;
  private liveHandle: Promise<LiveColumnarQuery | undefined> | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: ColumnarQueryableDatabase,
    readonly sql: string,
    readonly params: QueryParams,
    private readonly options: ColumnarStoreOptions = {},
    placeholder?: ColumnarQueryResult,
  ) {
    this.state = {
      result: placeholder,
      version: placeholder ? 1 : 0,
      error: undefined,
      loading: true,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ColumnarQueryState => this.state;

  private runOneShotColumnar(): Promise<ColumnarQueryResult> {
    if (typeof this.db.queryColumnar === 'function') {
      return this.db.queryColumnar(this.sql, this.params);
    }
    return this.db.query(this.sql, this.params).then((qr) => rowsToColumnarResult(qr));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation;
    const isLive = Boolean(
      this.options.live ||
        (this.options.events !== undefined && this.options.events.length > 0),
    );

    if (!isLive || typeof this.db.liveColumnar !== 'function') {
      this.pending = this.runOneShotColumnar().then(
        (res) => {
          if (isCurrent()) {
            this.set({
              result: res,
              version: this.state.version + 1,
              error: undefined,
              loading: false,
            });
          }
        },
        (err: unknown) => {
          if (isCurrent()) this.fail(err);
        },
      );
      return;
    }

    this.liveHandle = this.db
      .liveColumnar(
        this.sql,
        {
          events: this.options.events !== undefined ? [...this.options.events] : undefined,
          params: this.params,
          pollIntervalMs: this.options.pollIntervalMs,
          onError: (err) => {
            if (isCurrent()) this.fail(err);
          },
        },
        (res, version) => {
          if (isCurrent()) {
            this.set({ result: res, version, error: undefined, loading: false });
          }
        },
      )
      .then(
        (h) => {
          if (!isCurrent()) {
            void h.unsubscribe();
            return undefined;
          }
          return h;
        },
        (err: unknown) => {
          if (isCurrent()) this.fail(err);
          return undefined;
        },
      );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    const prev = this.liveHandle;
    this.liveHandle = undefined;
    void prev?.then((h) => h?.unsubscribe());
  }

  readonly refresh = async (): Promise<void> => {
    if (!this.running) return;
    if (!this.liveHandle) {
      this.stop();
      this.start();
      await this.pending;
      return;
    }
    const h = await this.liveHandle;
    if (h && this.running) {
      await h.refresh();
    }
  };

  private fail(err: unknown): void {
    this.set({
      result: this.state.result,
      version: this.state.version,
      error: err instanceof Error ? err : new Error(String(err)),
      loading: false,
    });
  }

  private set(next: ColumnarQueryState): void {
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }
}

// ---------------------------------------------------------------------------
// 3. `IncrementalQueryStore`
// ---------------------------------------------------------------------------

/** Structural database subset accepted by {@link IncrementalQueryStore} (`M20 Item 4`). */
export interface IncrementalQueryableDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  liveIncremental?<T extends Row = Row>(
    sql: string,
    options?: LiveIncrementalOptions<T>,
    listener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
  ): Promise<LiveIncrementalQuery<T>>;
}

/** State snapshot emitted by {@link IncrementalQueryStore} (`M20 Item 4`). */
export interface IncrementalQueryState<T = Row> {
  readonly rows: readonly T[] | undefined;
  readonly deltas: readonly LiveRowDelta<T>[];
  readonly version: number;
  readonly error: Error | undefined;
  readonly loading: boolean;
}

export class IncrementalQueryStore<T extends Row = Row> {
  private state: IncrementalQueryState<T>;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private running = false;
  private liveHandle: Promise<LiveIncrementalQuery<T> | undefined> | undefined;

  constructor(
    private readonly db: IncrementalQueryableDatabase,
    readonly sql: string,
    readonly params: QueryParams,
    private readonly options: Omit<LiveIncrementalOptions<T>, 'params'> = {},
    placeholder?: readonly T[],
  ) {
    this.state = {
      rows: placeholder,
      deltas: [],
      version: 0,
      error: undefined,
      loading: true,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): IncrementalQueryState<T> => this.state;

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation;

    if (typeof this.db.liveIncremental !== 'function') {
      void this.db.query<T>(this.sql, this.params).then(
        (res) => {
          if (isCurrent()) {
            this.set({
              rows: res.rows,
              deltas: res.rows.map((row, index) => ({
                type: 'insert' as const,
                key: index,
                row,
                index,
              })),
              version: 1,
              error: undefined,
              loading: false,
            });
          }
        },
        (err: unknown) => {
          if (isCurrent()) this.fail(err);
        },
      );
      return;
    }

    this.liveHandle = this.db
      .liveIncremental<T>(
        this.sql,
        {
          ...this.options,
          params: this.params,
          onError: (err) => {
            if (isCurrent()) this.fail(err);
          },
        },
        (snap) => {
          if (isCurrent()) {
            this.set({
              rows: snap.rows,
              deltas: snap.deltas,
              version: snap.version,
              error: undefined,
              loading: false,
            });
          }
        },
      )
      .then(
        (h) => {
          if (!isCurrent()) {
            void h.unsubscribe();
            return undefined;
          }
          return h;
        },
        (err: unknown) => {
          if (isCurrent()) this.fail(err);
          return undefined;
        },
      );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    const prev = this.liveHandle;
    this.liveHandle = undefined;
    void prev?.then((h) => h?.unsubscribe());
  }

  readonly refresh = async (): Promise<void> => {
    if (!this.running) return;
    const h = await this.liveHandle;
    if (h && this.running) {
      await h.refresh();
    }
  };

  private fail(err: unknown): void {
    this.set({
      rows: this.state.rows,
      deltas: [],
      version: this.state.version,
      error: err instanceof Error ? err : new Error(String(err)),
      loading: false,
    });
  }

  private set(next: IncrementalQueryState<T>): void {
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }
}
