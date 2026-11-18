/**
 * router.ts – Read/Write Replica Router with Per-Session Causal Read-Your-Writes
 * (`minLsn`) Fencing, Load Balancing & Automatic Failover Promotion (`M21 Item 1`).
 */

import type {
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  CopyFromOptions,
  CopyResult,
  CopyToOptions,
  DatabaseInfo,
  DataStreamOptions,
  ExplainOptions,
  IntrospectOptions,
  JsFunctionHandler,
  JsProcedureHandler,
  MigrateOptions,
  MigrateResult,
  Migration,
  MonitorStats,
  PreparedStatement,
  QueryDescription,
  QueryParams,
  QueryProfileListener,
  QueryResult,
  QueryStreamOptions,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  RegisteredRoutine,
  Row,
  SchemaIntrospection,
  StatementExecutionOptions,
  SweepResult,
  TransactionOptions,
} from '../types';
import { isSqlFragment, toStatement, type SqlFragment } from '../sql-tag';
import type { ArrowIpcOptions, ColumnarQueryResult } from '../columnar';
import type {
  ArrowIngestResult,
  ArrowIngestSource,
  LoadArrowIpcOptions,
} from '../arrow-ingest';
import type { TypedSqlFragment } from '../schema-validation';
import type {
  PipelineOperation,
  PipelineOptions,
  PipelineResults,
  PreparedPipeline,
  PreparedPipelineStepTemplate,
} from '../pipeline';
import type {
  IncrementalLiveSnapshot,
  LiveColumnarOptions,
  LiveColumnarQuery,
  LiveIncrementalOptions,
  LiveIncrementalQuery,
} from '../live-incremental';
import type {
  FirebirdDatabase,
  FirebirdTransactionClient,
  UnifiedExecuteResult,
} from '../database-core';
import type {
  ApplyPageDiffOptions,
  DatabaseSnapshot,
  DatabaseSnapshotInfo,
  PageDiffOptions,
  SnapshotOptions,
} from '../browser/snapshots';
import type {
  ColumnarStreamOptions,
  ArrowStreamOptions,
} from '../columnar-stream';
import type { TableOptions, TableRepository } from '../table-api';
import type { MaterializedViewOptions } from '../materialized-view';
import {
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_WATERMARK_TABLE,
  type ReplicationStats,
} from './types';
import { promoteReplica } from './orchestration';

/** Consistency guarantee enforced by {@link createReplicaRouter} (`M21 Item 1`). */
export type ReplicaConsistencyMode =
  | 'read-your-writes'
  | 'bounded-staleness'
  | 'eventual';

/** Sync link handle supplied to {@link createReplicaRouter} for fast replica catch-up (`M21 Item 1`). */
export interface ReplicaSyncLink {
  syncNow?(): Promise<unknown>;
  syncOnce?(): Promise<unknown>;
  sync?(): Promise<unknown>;
  stats?(): Promise<Partial<ReplicationStats>>;
}

/** Event payload emitted when {@link ReplicaRouter} promotes a replica on primary failure (`M21 Item 1`). */
export interface ReplicaFailoverEvent {
  readonly promotedReplicaIndex: number;
  readonly promotedDatabase: FirebirdDatabase;
  readonly promotedAtLsn: number;
  readonly reason: Error;
}

/** Options for {@link createReplicaRouter} (`M21 Item 1`). */
export interface ReplicaRouterOptions {
  /** Primary read-write database node. */
  primary: FirebirdDatabase;
  /** One or more read-replica database nodes. */
  replicas: readonly FirebirdDatabase[];
  /** Optional sync handles (`syncDatabases` / `replicateDatabases`) paired with `replicas` for on-demand catch-up. */
  syncHandles?: readonly ReplicaSyncLink[];
  /** Consistency mode for read queries. @default 'read-your-writes' */
  consistency?: ReplicaConsistencyMode;
  /** Maximum wait time in ms for replica catch-up before falling back to `primary`. @default 2000 */
  consistencyTimeoutMs?: number;
  /** Maximum allowed replica lag in milliseconds when `consistency === 'bounded-staleness'`. @default 5000 */
  maxStalenessMs?: number;
  /** Maximum allowed unapplied journal entries when `consistency === 'bounded-staleness'`. @default 50 */
  maxLagEntries?: number;
  /** Load-balancing policy across eligible replicas. @default 'round-robin' */
  selectionStrategy?: 'round-robin' | 'lowest-lag';
  /** Optional automatic replica promotion on primary write/connection failure. */
  failover?: {
    autoPromote?: boolean;
    newNodeId?: string;
    onFailover?: (event: ReplicaFailoverEvent) => void;
  };
  /** Close underlying `primary` and `replicas` when `router.close()` is called. @default false */
  closeNodesOnClose?: boolean;
}

/** Telemetry counters exposed by `router.routerStats()` (`M21 Item 1`). */
export interface ReplicaRouterStats {
  readonly consistency: ReplicaConsistencyMode;
  readonly sessionMinLsn: number;
  readonly replicaCount: number;
  readonly writesRoutedToPrimary: number;
  readonly readsRoutedToReplicas: number;
  readonly readsRoutedToPrimary: number;
  readonly causalCatchUpSyncs: number;
  readonly causalPrimaryFallbacks: number;
  readonly failoversCompleted: number;
  readonly perReplicaReads: readonly number[];
}

/** Extended `FirebirdDatabase` router returned by {@link createReplicaRouter} (`M21 Item 1`). */
export interface ReplicaRouter extends FirebirdDatabase {
  readonly primary: FirebirdDatabase;
  readonly replicas: readonly FirebirdDatabase[];
  /** Current causal read-your-writes LSN fence recorded by writes in this session. */
  readonly sessionMinLsn: number;
  /** Manually advance the causal session LSN token (e.g. from an HTTP header or client token). */
  advanceSessionLsn(minLsn: number): number;
  /** Trigger an immediate sync pass across all attached `syncHandles`. */
  syncReplicas(): Promise<void>;
  /** Inspect routing & causal fencing counters. */
  routerStats(): ReplicaRouterStats;
  /** Explicitly fail over to a healthy replica, promoting it to the new active `primary`. */
  failoverToReplica(replicaIndex?: number, reason?: Error): Promise<FirebirdDatabase>;
}

const LEADING_COMMENTS_RE = /^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/;

/**
 * Determine whether a SQL statement is safe to route to a read-only replica (`M21 Item 1`).
 */
export function isReadOnlySqlStatement(sql: string | SqlFragment): boolean {
  const text = (typeof sql === 'string' ? sql : toStatement(sql).sql)
    .replace(LEADING_COMMENTS_RE, '')
    .trim();
  if (!text) return true;
  const upper = text.toUpperCase();

  if (/\bRETURNING\b/.test(upper)) return false;
  if (/\bFOR\s+UPDATE\b/.test(upper) || /\bWITH\s+LOCK\b/.test(upper)) return false;

  if (upper.startsWith('SELECT')) {
    return true;
  }
  if (upper.startsWith('WITH')) {
    if (/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO)\b/.test(upper)) {
      return false;
    }
    return /\bSELECT\b/.test(upper);
  }
  return false;
}

async function queryPrimaryHeadLsn(db: FirebirdDatabase): Promise<number> {
  try {
    const res = await db.query<Row>(
      `SELECT COALESCE(MAX(LSN), 0) AS HEAD_LSN FROM "${DEFAULT_REPL_JOURNAL_TABLE}"`,
    );
    const val = Number(res.rows[0]?.HEAD_LSN ?? res.rows[0]?.head_lsn ?? 0);
    if (Number.isFinite(val) && val > 0) return val;
  } catch {
    // Journal table may not exist when using native engine replication
  }
  try {
    const seqRes = await db.query<Row>(
      `SELECT RDB$GET_CONTEXT('SYSTEM', 'REPLICATION_SEQUENCE') AS SEQ FROM RDB$DATABASE`,
    );
    const seq = Number(seqRes.rows[0]?.SEQ ?? seqRes.rows[0]?.seq ?? 0);
    if (Number.isFinite(seq) && seq > 0) return seq;
  } catch {
    // Ignore if unavailable
  }
  return 0;
}

async function queryReplicaWatermarkLsn(
  replica: FirebirdDatabase,
  link?: ReplicaSyncLink,
): Promise<{ watermark: number; lagEntries: number; lagMs: number }> {
  if (link && typeof link.stats === 'function') {
    try {
      const st = await link.stats();
      if (typeof st.replicaWatermark === 'number') {
        return {
          watermark: st.replicaWatermark,
          lagEntries: st.lagEntries ?? 0,
          lagMs: st.lagMs ?? 0,
        };
      }
    } catch {
      // Fall back to watermark table query
    }
  }
  try {
    const res = await replica.query<Row>(
      `SELECT COALESCE(MAX(LAST_LSN), 0) AS WM FROM "${DEFAULT_REPL_WATERMARK_TABLE}"`,
    );
    const wm = Number(res.rows[0]?.WM ?? res.rows[0]?.wm ?? 0);
    return { watermark: Number.isFinite(wm) ? wm : 0, lagEntries: 0, lagMs: 0 };
  } catch {
    return { watermark: 0, lagEntries: 0, lagMs: 0 };
  }
}

/**
 * Create a read/write splitting `ReplicaRouter` implementing `FirebirdDatabase`
 * with causal read-your-writes LSN fencing and optional automatic failover (`M21 Item 1`).
 */
export function createReplicaRouter(options: ReplicaRouterOptions): ReplicaRouter {
  let activePrimary = options.primary;
  const activeReplicas = [...options.replicas];
  const activeLinks = options.syncHandles ? [...options.syncHandles] : [];
  const consistency: ReplicaConsistencyMode = options.consistency ?? 'read-your-writes';
  const timeoutMs = Math.max(0, options.consistencyTimeoutMs ?? 2000);
  const maxStalenessMs = Math.max(0, options.maxStalenessMs ?? 5000);
  const maxLagEntries = Math.max(0, options.maxLagEntries ?? 50);
  const strategy = options.selectionStrategy ?? 'round-robin';

  let sessionMinLsn = 0;
  let rrCursor = 0;
  let writesRoutedToPrimary = 0;
  let readsRoutedToReplicas = 0;
  let readsRoutedToPrimary = 0;
  let causalCatchUpSyncs = 0;
  let causalPrimaryFallbacks = 0;
  let failoversCompleted = 0;
  const perReplicaReads = activeReplicas.map(() => 0);

  const syncAllLinks = async (): Promise<void> => {
    for (const link of activeLinks) {
      if (!link) continue;
      if (typeof link.syncNow === 'function') {
        await link.syncNow();
      } else if (typeof link.syncOnce === 'function') {
        await link.syncOnce();
      } else if (typeof link.sync === 'function') {
        await link.sync();
      }
    }
  };

  const recordWriteOnPrimary = async (): Promise<void> => {
    writesRoutedToPrimary++;
    let sawLinkPrimaryLsn = false;
    for (const link of activeLinks) {
      if (link && typeof link.stats === 'function') {
        try {
          const st = await link.stats();
          if (typeof st.primaryLsn === 'number' && st.primaryLsn > 0) {
            sawLinkPrimaryLsn = true;
            if (st.primaryLsn > sessionMinLsn) {
              sessionMinLsn = st.primaryLsn;
            }
          }
        } catch {
          // Ignore
        }
      }
    }
    const head = await queryPrimaryHeadLsn(activePrimary);
    if (head > sessionMinLsn) {
      sessionMinLsn = head;
    } else if (!sawLinkPrimaryLsn && activeReplicas.length > 0 && activeLinks.length > 0 && head === 0) {
      // Uncaptured triggerless write: bump virtual LSN by 1 so syncOnce() runs before next causal read
      sessionMinLsn += 1;
    }
  };

  const performFailover = async (
    preferredIndex?: number,
    reason = new Error('Manual or automatic primary failover'),
  ): Promise<FirebirdDatabase> => {
    if (activeReplicas.length === 0) {
      throw new Error(`Cannot fail over: no replicas available (${reason.message})`);
    }
    let bestIdx = preferredIndex ?? 0;
    let bestWm = -1;
    if (preferredIndex === undefined) {
      for (let i = 0; i < activeReplicas.length; i++) {
        const info = await queryReplicaWatermarkLsn(activeReplicas[i]!, activeLinks[i]);
        if (info.watermark > bestWm) {
          bestWm = info.watermark;
          bestIdx = i;
        }
      }
    } else {
      const info = await queryReplicaWatermarkLsn(activeReplicas[bestIdx]!, activeLinks[bestIdx]);
      bestWm = info.watermark;
    }

    const candidate = activeReplicas[bestIdx]!;
    try {
      await promoteReplica({
        replicaDb: candidate as unknown as import('./types').ReplicableDatabase,
        promotedNodeId: options.failover?.newNodeId ?? `promoted_${bestIdx}`,
        force: true,
      });
    } catch {
      // Replica may use native replication or have no logical subscription table; safe to promote handle directly
    }

    activeReplicas.splice(bestIdx, 1);
    if (bestIdx < activeLinks.length) activeLinks.splice(bestIdx, 1);
    if (bestIdx < perReplicaReads.length) perReplicaReads.splice(bestIdx, 1);
    activePrimary = candidate;
    failoversCompleted++;

    options.failover?.onFailover?.({
      promotedReplicaIndex: bestIdx,
      promotedDatabase: candidate,
      promotedAtLsn: Math.max(0, bestWm),
      reason,
    });
    return candidate;
  };

  const runWrite = async <R>(fn: (db: FirebirdDatabase) => Promise<R>): Promise<R> => {
    try {
      const out = await fn(activePrimary);
      await recordWriteOnPrimary();
      return out;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const msg = error.message.toLowerCase();
      const isAvailabilityError =
        msg.includes('closed') ||
        msg.includes('unavailable') ||
        msg.includes('offline') ||
        msg.includes('connection') ||
        msg.includes('network') ||
        msg.includes('detach');
      if (options.failover?.autoPromote && activeReplicas.length > 0 && isAvailabilityError) {
        const nextPrimary = await performFailover(undefined, error);
        const out = await fn(nextPrimary);
        await recordWriteOnPrimary();
        return out;
      }
      throw err;
    }
  };

  const pickReplicaIndex = async (): Promise<number> => {
    if (activeReplicas.length === 1) return 0;
    if (strategy === 'lowest-lag') {
      let bestIdx = 0;
      let highestWm = -1;
      for (let i = 0; i < activeReplicas.length; i++) {
        const info = await queryReplicaWatermarkLsn(activeReplicas[i]!, activeLinks[i]);
        if (info.watermark > highestWm) {
          highestWm = info.watermark;
          bestIdx = i;
        }
      }
      return bestIdx;
    }
    const idx = rrCursor % activeReplicas.length;
    rrCursor = (rrCursor + 1) >>> 0;
    return idx;
  };

  const selectReadTarget = async (): Promise<{
    db: FirebirdDatabase;
    replicaIndex: number | null;
  }> => {
    if (activeReplicas.length === 0) {
      readsRoutedToPrimary++;
      return { db: activePrimary, replicaIndex: null };
    }

    const idx = await pickReplicaIndex();
    const replica = activeReplicas[idx]!;
    const link = activeLinks[idx];

    if (consistency === 'eventual') {
      readsRoutedToReplicas++;
      perReplicaReads[idx] = (perReplicaReads[idx] ?? 0) + 1;
      return { db: replica, replicaIndex: idx };
    }

    if (consistency === 'bounded-staleness') {
      let info = await queryReplicaWatermarkLsn(replica, link);
      if (info.lagEntries > maxLagEntries || info.lagMs > maxStalenessMs) {
        if (activeLinks.length > 0) {
          causalCatchUpSyncs++;
          await syncAllLinks().catch(() => undefined);
          info = await queryReplicaWatermarkLsn(replica, link);
        }
      }
      if (info.lagEntries <= maxLagEntries && info.lagMs <= maxStalenessMs) {
        readsRoutedToReplicas++;
        perReplicaReads[idx] = (perReplicaReads[idx] ?? 0) + 1;
        return { db: replica, replicaIndex: idx };
      }
      causalPrimaryFallbacks++;
      readsRoutedToPrimary++;
      return { db: activePrimary, replicaIndex: null };
    }

    // 'read-your-writes'
    if (sessionMinLsn <= 0) {
      readsRoutedToReplicas++;
      perReplicaReads[idx] = (perReplicaReads[idx] ?? 0) + 1;
      return { db: replica, replicaIndex: idx };
    }

    let info = await queryReplicaWatermarkLsn(replica, link);
    if (info.watermark >= sessionMinLsn) {
      readsRoutedToReplicas++;
      perReplicaReads[idx] = (perReplicaReads[idx] ?? 0) + 1;
      return { db: replica, replicaIndex: idx };
    }

    // Wait / sync up to `timeoutMs`
    const deadline = Date.now() + timeoutMs;
    if (activeLinks.length > 0 && timeoutMs > 0) {
      causalCatchUpSyncs++;
      try {
        await Promise.race([
          syncAllLinks(),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch {
        // Fall through to watermark check / primary fallback
      }
      const postSyncHead = await queryPrimaryHeadLsn(activePrimary);
      if (postSyncHead > 0 && postSyncHead < sessionMinLsn) {
        sessionMinLsn = postSyncHead;
      }
      info = await queryReplicaWatermarkLsn(replica, link);
    }

    while (info.watermark < sessionMinLsn && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      info = await queryReplicaWatermarkLsn(replica, link);
    }

    if (info.watermark >= sessionMinLsn) {
      readsRoutedToReplicas++;
      perReplicaReads[idx] = (perReplicaReads[idx] ?? 0) + 1;
      return { db: replica, replicaIndex: idx };
    }

    causalPrimaryFallbacks++;
    readsRoutedToPrimary++;
    return { db: activePrimary, replicaIndex: null };
  };

  const runRead = async <R>(
    sql: string | SqlFragment,
    fn: (db: FirebirdDatabase) => Promise<R>,
  ): Promise<R> => {
    if (!isReadOnlySqlStatement(sql)) {
      return runWrite(fn);
    }
    const target = await selectReadTarget();
    try {
      return await fn(target.db);
    } catch (err) {
      if (target.replicaIndex !== null) {
        readsRoutedToPrimary++;
        return fn(activePrimary);
      }
      throw err;
    }
  };

  const routerQuery: FirebirdDatabase['query'] = ((
    sql: string | SqlFragment | TypedSqlFragment<Row>,
    paramsOrOptions?: unknown,
    maybeOptions?: unknown,
  ) =>
    runRead(sql as string | SqlFragment, (db) =>
      (db.query as (...a: unknown[]) => Promise<QueryResult<Row>>)(
        sql,
        paramsOrOptions,
        maybeOptions,
      ),
    )) as FirebirdDatabase['query'];

  const router: ReplicaRouter = {
    get primary() {
      return activePrimary;
    },
    get replicas() {
      return activeReplicas;
    },
    get sessionMinLsn() {
      return sessionMinLsn;
    },
    advanceSessionLsn(minLsn: number): number {
      if (Number.isFinite(minLsn) && minLsn > sessionMinLsn) {
        sessionMinLsn = Math.floor(minLsn);
      }
      return sessionMinLsn;
    },
    async syncReplicas(): Promise<void> {
      await syncAllLinks();
    },
    routerStats(): ReplicaRouterStats {
      return {
        consistency,
        sessionMinLsn,
        replicaCount: activeReplicas.length,
        writesRoutedToPrimary,
        readsRoutedToReplicas,
        readsRoutedToPrimary,
        causalCatchUpSyncs,
        causalPrimaryFallbacks,
        failoversCompleted,
        perReplicaReads: [...perReplicaReads],
      };
    },
    failoverToReplica: performFailover,

    query: routerQuery,

    queryColumnar(
      sql: string | SqlFragment,
      params?: QueryParams | StatementExecutionOptions,
      execOpts?: StatementExecutionOptions,
    ): Promise<ColumnarQueryResult> {
      return runRead(sql, (db) => db.queryColumnar(sql, params as QueryParams, execOpts));
    },

    queryArrow(
      sql: string | SqlFragment,
      params?: QueryParams | (StatementExecutionOptions & ArrowIpcOptions),
      arrowOpts?: StatementExecutionOptions & ArrowIpcOptions,
    ): Promise<Uint8Array> {
      return runRead(sql, (db) => db.queryArrow(sql, params as QueryParams, arrowOpts));
    },

    queryColumnarStream(
      sql: string | SqlFragment,
      paramsOrOptions?: QueryParams | ColumnarStreamOptions,
      maybeOptions?: ColumnarStreamOptions,
    ): AsyncIterableIterator<ColumnarQueryResult> {
      async function* gen(): AsyncGenerator<ColumnarQueryResult> {
        const target = isReadOnlySqlStatement(sql)
          ? (await selectReadTarget()).db
          : activePrimary;
        for await (const batch of target.queryColumnarStream(sql, paramsOrOptions, maybeOptions)) {
          yield batch;
        }
      }
      return gen();
    },

    queryArrowStream(
      sql: string | SqlFragment,
      paramsOrOptions?: QueryParams | ArrowStreamOptions,
      maybeOptions?: ArrowStreamOptions,
    ): ReadableStream<Uint8Array> {
      let innerReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!innerReader) {
            const target = isReadOnlySqlStatement(sql)
              ? (await selectReadTarget()).db
              : activePrimary;
            innerReader = target
              .queryArrowStream(sql, paramsOrOptions, maybeOptions)
              .getReader();
          }
          const { done, value } = await innerReader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        },
        async cancel(reason) {
          if (innerReader) {
            await innerReader.cancel(reason);
          }
        },
      });
    },

    queryStream<T extends Row = Row>(
      sql: string | SqlFragment,
      paramsOrOptions?: QueryParams | QueryStreamOptions,
      maybeOptions?: QueryStreamOptions,
    ): AsyncIterableIterator<QueryResult<T>> {
      async function* gen(): AsyncGenerator<QueryResult<T>> {
        const target = isReadOnlySqlStatement(sql)
          ? (await selectReadTarget()).db
          : activePrimary;
        for await (const batch of target.queryStream<T>(sql, paramsOrOptions, maybeOptions)) {
          yield batch;
        }
      }
      return gen();
    },

    exec(
      sql: string | SqlFragment,
      paramsOrOptions?: QueryParams | StatementExecutionOptions,
      maybeOptions?: StatementExecutionOptions,
    ): Promise<Array<{ affectedRows: number }> | void> {
      return runWrite((db) => db.exec(sql, paramsOrOptions as QueryParams, maybeOptions));
    },

    execute(
      sql: string | SqlFragment,
      params?: QueryParams,
      execOpts?: StatementExecutionOptions,
    ): Promise<UnifiedExecuteResult> {
      return runWrite((db) => db.execute(sql, params, execOpts));
    },

    execBatch(
      sql: string,
      rows: QueryParams[],
    ): Promise<{ affectedRows: number } | void> {
      return runWrite((db) => db.execBatch(sql, rows));
    },

    pipeline<const TOps extends readonly PipelineOperation[]>(
      ops: TOps,
      pipeOpts?: PipelineOptions,
    ): Promise<PipelineResults<TOps>> {
      const allReads = ops.every((op) =>
        isSqlFragment(op)
          ? isReadOnlySqlStatement(op)
          : (op.kind === undefined ||
              op.kind === 'query' ||
              op.kind === 'queryColumnar' ||
              op.kind === 'queryArrow') &&
            isReadOnlySqlStatement(op.sql),
      );
      if (allReads && !pipeOpts?.transaction) {
        return selectReadTarget().then(({ db }) => db.pipeline(ops, pipeOpts));
      }
      return runWrite((db) => db.pipeline(ops, pipeOpts));
    },

    preparePipeline<const TTemplates extends readonly PreparedPipelineStepTemplate[]>(
      templates: TTemplates,
    ): Promise<PreparedPipeline<TTemplates>> {
      return activePrimary.preparePipeline(templates);
    },

    table<T extends Row = Row, K = unknown>(
      tableName: string,
      tableOptions?: TableOptions<T>,
    ): TableRepository<T, K> {
      return activePrimary.table<T, K>(tableName, tableOptions);
    },

    registerVirtualTable(name, provider, vtOpts) {
      return runWrite((db) => db.registerVirtualTable(name, provider, vtOpts));
    },

    createMaterializedView<T extends Row = Row>(
      name: string,
      selectSql: string | SqlFragment,
      mvOpts?: MaterializedViewOptions,
    ) {
      return runWrite((db) => db.createMaterializedView<T>(name, selectSql, mvOpts));
    },

    listMaterializedViews() {
      return runRead('SELECT 1 FROM RDB$DATABASE', (db) => db.listMaterializedViews());
    },

    liveIncremental<T extends Row = Row>(
      sql: string | SqlFragment,
      optionsOrListener?:
        | LiveIncrementalOptions<T>
        | ((snapshot: IncrementalLiveSnapshot<T>) => void),
      maybeListener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
    ): Promise<LiveIncrementalQuery<T>> {
      return activePrimary.liveIncremental<T>(sql, optionsOrListener as LiveIncrementalOptions<T>, maybeListener);
    },

    liveColumnar(
      sql: string | SqlFragment,
      optionsOrListener?:
        | LiveColumnarOptions
        | ((result: ColumnarQueryResult, version: number) => void),
      maybeListener?: (result: ColumnarQueryResult, version: number) => void,
    ): Promise<LiveColumnarQuery> {
      return activePrimary.liveColumnar(sql, optionsOrListener as LiveColumnarOptions, maybeListener);
    },

    prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
      return activePrimary.prepare(sql);
    },

    async transaction<T>(
      fn: (tx: FirebirdTransactionClient) => Promise<T>,
      txOptions?: TransactionOptions,
    ): Promise<T> {
      if (txOptions?.readOnly === true) {
        const target = await selectReadTarget();
        return target.db.transaction(fn, txOptions);
      }
      return runWrite((db) => db.transaction(fn, txOptions));
    },

    cancelOperation(): Promise<void> {
      return activePrimary.cancelOperation();
    },

    describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
      return runRead(sql, (db) => db.describeQuery(sql));
    },

    explain(sql: string | SqlFragment, explainOpts?: ExplainOptions): Promise<string> {
      return runRead(sql, (db) => db.explain(sql, explainOpts));
    },

    databaseInfo(): Promise<DatabaseInfo> {
      return activePrimary.databaseInfo();
    },

    sweep(): Promise<SweepResult> {
      return activePrimary.sweep();
    },

    introspect(introspectOpts?: IntrospectOptions): Promise<SchemaIntrospection> {
      return activePrimary.introspect(introspectOpts);
    },

    migrate(
      migrations: readonly Migration[],
      migrateOpts?: MigrateOptions,
    ): Promise<MigrateResult> {
      return runWrite((db) => db.migrate(migrations, migrateOpts));
    },

    registerFunction(
      name: string,
      optionsOrFn: RegisterFunctionOptions | JsFunctionHandler,
      maybeFn?: JsFunctionHandler,
    ): Promise<RegisteredRoutine> {
      return activePrimary.registerFunction(name, optionsOrFn as RegisterFunctionOptions, maybeFn);
    },

    unregisterFunction(name: string): Promise<void> {
      return activePrimary.unregisterFunction(name);
    },

    registerProcedure(
      name: string,
      optionsOrFn: RegisterProcedureOptions | JsProcedureHandler,
      maybeFn?: JsProcedureHandler,
    ): Promise<RegisteredRoutine> {
      return activePrimary.registerProcedure(name, optionsOrFn as RegisterProcedureOptions, maybeFn);
    },

    unregisterProcedure(name: string): Promise<void> {
      return activePrimary.unregisterProcedure(name);
    },

    snapshot(labelOrOptions?: string | SnapshotOptions): Promise<DatabaseSnapshot> {
      return activePrimary.snapshot(labelOrOptions);
    },

    restoreSnapshot(snapshotOrId: DatabaseSnapshot | string | Uint8Array): Promise<void> {
      return runWrite((db) => db.restoreSnapshot(snapshotOrId));
    },

    listSnapshots(): DatabaseSnapshotInfo[] {
      return activePrimary.listSnapshots();
    },

    deleteSnapshot(snapshotOrId: DatabaseSnapshot | string): boolean {
      return activePrimary.deleteSnapshot(snapshotOrId);
    },

    exportDiff(
      fromSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
      toSnapshot?: DatabaseSnapshot | string | Uint8Array,
      diffOpts?: PageDiffOptions,
    ): Promise<Uint8Array> {
      return activePrimary.exportDiff(fromSnapshot, toSnapshot, diffOpts);
    },

    applyDiff(
      diffBytes: Uint8Array,
      baseSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
      applyOpts?: ApplyPageDiffOptions,
    ): Promise<Uint8Array> {
      return runWrite((db) => db.applyDiff(diffBytes, baseSnapshot, applyOpts));
    },

    dumpDataDir(): Promise<Uint8Array> {
      return activePrimary.dumpDataDir();
    },

    dumpDataStream(streamOpts?: DataStreamOptions): ReadableStream<Uint8Array> {
      return activePrimary.dumpDataStream(streamOpts);
    },

    loadDataStream(
      stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
      streamOpts?: DataStreamOptions,
    ): Promise<void> {
      return runWrite((db) => db.loadDataStream(stream, streamOpts));
    },

    copyFromStream(
      tableName: string,
      stream: ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
      copyOpts?: CopyFromOptions,
    ): Promise<CopyResult> {
      return runWrite((db) => db.copyFromStream(tableName, stream, copyOpts));
    },

    loadArrowIpc(
      tableName: string,
      source: ArrowIngestSource,
      arrowOpts?: LoadArrowIpcOptions,
    ): Promise<ArrowIngestResult> {
      return runWrite((db) => db.loadArrowIpc(tableName, source, arrowOpts));
    },

    copyToStream(
      sql: string | SqlFragment,
      params?: QueryParams | CopyToOptions,
      copyOpts?: CopyToOptions,
    ): ReadableStream<Uint8Array> {
      return activePrimary.copyToStream(sql, params as QueryParams, copyOpts);
    },

    createBlobStream(blobOpts?: BlobStreamOptions): Promise<BlobWritableStream> {
      return activePrimary.createBlobStream(blobOpts);
    },

    openBlobStream(
      sqlOrHandle: string | SqlFragment | BlobHandle,
      paramsOrOptions?: QueryParams | BlobStreamOptions,
      maybeOptions?: BlobStreamOptions,
    ): Promise<ReadableStream<Uint8Array>> {
      return activePrimary.openBlobStream(sqlOrHandle, paramsOrOptions as QueryParams, maybeOptions);
    },

    onQuery(listener: QueryProfileListener): () => void {
      return activePrimary.onQuery(listener);
    },

    monitorStats(): Promise<MonitorStats> {
      return activePrimary.monitorStats();
    },

    resetMonitorStats(): void {
      activePrimary.resetMonitorStats();
    },

    async close(): Promise<void> {
      if (options.closeNodesOnClose) {
        await activePrimary.close();
        for (const r of activeReplicas) {
          await r.close();
        }
      }
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await router.close();
    },
  };

  // Make `router.table(...)` route reads through `router` and writes through `router`!
  router.table = <T extends Row = Row, K = unknown>(
    tableName: string,
    tableOptions?: TableOptions<T>,
  ): TableRepository<T, K> => {
    // Delegate to `createTableRepository(router, tableName, tableOptions)` via primary's constructor or lazy import
    return createRouterBackedTable<T, K>(router, tableName, tableOptions);
  };

  return router;
}

import { createTableRepository } from '../table-api';

function createRouterBackedTable<T extends Row = Row, K = unknown>(
  router: ReplicaRouter,
  tableName: string,
  tableOptions?: TableOptions<T>,
): TableRepository<T, K> {
  return createTableRepository<T, K>(router, tableName, tableOptions);
}
