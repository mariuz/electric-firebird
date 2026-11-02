/**
 * Query Profiler & `MON$` / `IAttachment::getInfo` Telemetry Collector
 *
 * Tracks statement execution timing, prepare-cache hit/miss rates, recent
 * queries, and page-level I/O counters (`isc_info_reads`, `isc_info_writes`,
 * `isc_info_fetches`, `isc_info_marks`), and dispatches structured
 * {@link QueryProfileEvent} notifications to `db.onQuery(listener)` subscribers.
 */

import type {
  DatabaseInfo,
  MonitorStats,
  PageIoCounters,
  QueryProfileEvent,
  QueryProfileListener,
} from '../types';

export const DEFAULT_MAX_RECENT_QUERIES = 50;

export class QueryProfiler {
  private readonly listeners = new Set<QueryProfileListener>();
  private readonly recent: QueryProfileEvent[] = [];
  private readonly maxRecent: number;

  private totalQueries = 0;
  private totalExecs = 0;
  private totalErrors = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private slowestSql: string | null = null;
  private prepareCacheHits = 0;
  private prepareCacheMisses = 0;
  private inFlight = 0;

  constructor(maxRecent = DEFAULT_MAX_RECENT_QUERIES) {
    this.maxRecent = Math.max(1, maxRecent);
  }

  /** Whether any `onQuery` listeners are currently subscribed. */
  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  /** Number of statements currently executing. */
  get activeCount(): number {
    return this.inFlight;
  }

  /** Subscribe to query profile events. Returns an unsubscribe callback. */
  onQuery(listener: QueryProfileListener): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('onQuery requires a listener function');
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begin tracking an in-flight statement execution. */
  begin(): number {
    this.inFlight += 1;
    return performance.now();
  }

  /** Finish tracking an in-flight statement and emit its profile event. */
  end(options: {
    startedAt: number;
    sql: string;
    params?: unknown[];
    kind: QueryProfileEvent['kind'];
    rowCount?: number;
    cacheHit?: boolean;
    ioBefore?: PageIoCounters | null;
    ioAfter?: PageIoCounters | null;
    error?: unknown;
  }): QueryProfileEvent {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const durationMs = Math.max(0, performance.now() - options.startedAt);
    const cacheHit = Boolean(options.cacheHit);

    if (options.kind === 'query' || options.kind === 'prepared') {
      this.totalQueries += 1;
    } else {
      this.totalExecs += 1;
    }

    if (cacheHit) {
      this.prepareCacheHits += 1;
    } else {
      this.prepareCacheMisses += 1;
    }

    this.totalDurationMs += durationMs;
    if (durationMs >= this.maxDurationMs && options.sql.trim() !== '') {
      this.maxDurationMs = durationMs;
      this.slowestSql = options.sql;
    }

    let errObj: Error | undefined;
    if (options.error !== undefined) {
      this.totalErrors += 1;
      errObj =
        options.error instanceof Error
          ? options.error
          : new Error(String(options.error));
    }

    let io: PageIoCounters | undefined;
    if (options.ioBefore && options.ioAfter) {
      io = {
        reads: Math.max(0, options.ioAfter.reads - options.ioBefore.reads),
        writes: Math.max(0, options.ioAfter.writes - options.ioBefore.writes),
        fetches: Math.max(0, options.ioAfter.fetches - options.ioBefore.fetches),
        marks: Math.max(0, options.ioAfter.marks - options.ioBefore.marks),
      };
    }

    const event: QueryProfileEvent = {
      sql: options.sql,
      params: options.params ? [...options.params] : [],
      kind: options.kind,
      durationMs,
      rowCount: options.rowCount ?? 0,
      cacheHit,
      timestamp: Date.now(),
      ...(io ? { io } : {}),
      ...(errObj ? { error: errObj } : {}),
    };

    this.recent.push(event);
    if (this.recent.length > this.maxRecent) {
      this.recent.shift();
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Never allow a telemetry listener error to abort user queries.
      }
    }

    return event;
  }

  /** Reset accumulated counters and clear the recent queries buffer. */
  reset(): void {
    this.totalQueries = 0;
    this.totalExecs = 0;
    this.totalErrors = 0;
    this.totalDurationMs = 0;
    this.maxDurationMs = 0;
    this.slowestSql = null;
    this.prepareCacheHits = 0;
    this.prepareCacheMisses = 0;
    this.recent.length = 0;
  }

  /** Clear all listeners and counters on database close. */
  clear(): void {
    this.listeners.clear();
    this.reset();
    this.inFlight = 0;
  }

  /** Build a complete {@link MonitorStats} snapshot. */
  async snapshot(
    fetchDbInfo?: () => Promise<DatabaseInfo | null>,
    fetchActiveStatements?: () => Promise<number | null>,
  ): Promise<MonitorStats> {
    let info: DatabaseInfo | null = null;
    if (fetchDbInfo) {
      try {
        info = await fetchDbInfo();
      } catch {
        info = null;
      }
    }

    let monActive: number | null = null;
    if (fetchActiveStatements) {
      try {
        monActive = await fetchActiveStatements();
      } catch {
        monActive = null;
      }
    }

    const totalCount = this.totalQueries + this.totalExecs;
    const totalCacheAttempts = this.prepareCacheHits + this.prepareCacheMisses;

    return {
      totalQueries: this.totalQueries,
      totalExecs: this.totalExecs,
      totalErrors: this.totalErrors,
      totalDurationMs: this.totalDurationMs,
      avgDurationMs: totalCount > 0 ? this.totalDurationMs / totalCount : 0,
      maxDurationMs: this.maxDurationMs,
      slowestSql: this.slowestSql,
      prepareCacheHits: this.prepareCacheHits,
      prepareCacheMisses: this.prepareCacheMisses,
      prepareCacheHitRate:
        totalCacheAttempts > 0 ? this.prepareCacheHits / totalCacheAttempts : 0,
      io: {
        reads: info?.reads ?? 0,
        writes: info?.writes ?? 0,
        fetches: info?.fetches ?? 0,
        marks: info?.marks ?? 0,
        pageBuffers: info?.pageBuffers ?? 0,
        currentMemory: info?.currentMemory ?? 0,
        maxMemory: info?.maxMemory ?? 0,
      },
      transactions: {
        oldestTransaction: info?.oldestTransaction ?? 0,
        oldestActive: info?.oldestActive ?? 0,
        oldestSnapshot: info?.oldestSnapshot ?? 0,
        nextTransaction: info?.nextTransaction ?? 0,
        transactionGap: info?.transactionGap ?? 0,
      },
      activeStatements: monActive ?? this.inFlight,
      recentQueries: this.recent.map((e) => ({
        ...e,
        params: [...e.params],
        ...(e.io ? { io: { ...e.io } } : {}),
      })),
    };
  }
}
