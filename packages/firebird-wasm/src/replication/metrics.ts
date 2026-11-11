/**
 * Replication Telemetry Hooks, Prometheus Exposition & OpenTelemetry Export.
 */

import type {
  ReplicationDlq,
  ReplicationPublication,
  ReplicationSubscription,
} from './types';

// ---------------------------------------------------------------------------
// 14. Structured Replication Telemetry & Prometheus / OTel Export (M15 Item 4)
// ---------------------------------------------------------------------------

/** Structured telemetry snapshot emitted by {@link ReplicationMetricsCollector}. */
export interface ReplicationTelemetrySnapshot {
  /** Epoch timestamp (`Date.now()`) when the snapshot was sampled. */
  readonly timestamp: number;
  /** Publication name (`'unknown'` if not attached). */
  readonly publicationName: string;
  /** Subscription name (`'unknown'` if not attached). */
  readonly subscriptionName: string;
  /** Node identifier. */
  readonly nodeId: string;
  /** Current replication state (`'idle'`, `'running'`, `'syncing'`). */
  readonly status: 'idle' | 'running' | 'syncing';
  /** Highest LSN on the source publication. */
  readonly primaryLsn: number;
  /** Applied LSN watermark on the replica. */
  readonly replicaWatermark: number;
  /** Unapplied journal entries (`Math.max(0, primaryLsn - replicaWatermark)`). */
  readonly lagEntries: number;
  /** Age in milliseconds of the oldest unapplied journal entry (`0` when caught up). */
  readonly lagMs: number;
  /** Number of entries currently retained in `FB_REPL_JOURNAL$` (`0` if publication not attached). */
  readonly journalDepth: number;
  /** Number of active replication slots registered on the publication (`0` if publication not attached). */
  readonly activeSlots: number;
  /** Number of quarantined poison entries currently in `FB_REPL_DLQ$`. */
  readonly dlqDepth: number;
  /** Cumulative entries fetched by the subscriber. */
  readonly totalFetched: number;
  /** Cumulative entries applied by the subscriber. */
  readonly totalApplied: number;
  /** Cumulative conflicts resolved by the subscriber. */
  readonly totalConflicts: number;
  /** Cumulative payload bytes transferred. */
  readonly bytesTransferred: number;
  /** Instantaneous apply throughput (`entries / sec`) since the previous sample. */
  readonly throughputEntriesPerSec: number;
  /** Ratio of conflicts to applied entries (`totalConflicts / Math.max(1, totalApplied)`). */
  readonly conflictRate: number;
}

/** OpenTelemetry-compatible metric data point returned by `collector.toOpenTelemetry()`. */
export interface ReplicationOtelMetric {
  /** Metric name (e.g. `'firebird.replication.lag.entries'`). */
  readonly name: string;
  /** Human-readable metric description. */
  readonly description: string;
  /** Metric unit (`'1'`, `'ms'`, `'By'`, `'1/s'`). */
  readonly unit: string;
  /** Instrument kind (`'gauge'` or `'counter'`). */
  readonly type: 'gauge' | 'counter';
  /** Numeric value. */
  readonly value: number;
  /** Metric attributes (`publication`, `subscription`, `node_id`). */
  readonly attributes: Readonly<Record<string, string>>;
  /** Sample timestamp in milliseconds. */
  readonly timestamp: number;
}

/** Options for {@link createReplicationMetricsCollector}. */
export interface CreateReplicationMetricsCollectorOptions {
  /** Optional source publication to inspect `currentLsn()`, `fetchChangesSince(0)` depth, and `listSlots()`. */
  publication?: ReplicationPublication;
  /** Optional target subscription to inspect `stats()` and `listDlq()` depth. */
  subscription?: ReplicationSubscription;
  /** Optional explicit DLQ manager if `subscription` is not provided. */
  dlq?: ReplicationDlq;
  /** Node identifier label override. */
  nodeId?: string;
  /** Optional callback invoked whenever `collect()` produces a new `ReplicationTelemetrySnapshot`. */
  onSnapshot?: (snapshot: ReplicationTelemetrySnapshot) => void;
}

/** Telemetry collector returned by {@link createReplicationMetricsCollector}. */
export interface ReplicationMetricsCollector {
  /** Sample current replication telemetry and notify any registered listeners. */
  collect(now?: number): Promise<ReplicationTelemetrySnapshot>;
  /** Subscribe to telemetry snapshots emitted on each `collect()` call. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: ReplicationTelemetrySnapshot) => void): () => void;
  /** Return the most recently collected `ReplicationTelemetrySnapshot`, or `null`. */
  lastSnapshot(): ReplicationTelemetrySnapshot | null;
  /** Collect and format telemetry in Prometheus text exposition format (`0.0.4`). */
  toPrometheus(prefix?: string): Promise<string>;
  /** Collect and format telemetry as OpenTelemetry-compatible metric records. */
  toOpenTelemetry(): Promise<ReplicationOtelMetric[]>;
}

/**
 * Format a {@link ReplicationTelemetrySnapshot} in Prometheus text exposition format (`M15 Item 4`).
 */
export function formatPrometheusReplicationMetrics(
  snapshot: ReplicationTelemetrySnapshot,
  prefix = 'firebird_replication',
): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const labels = `publication="${esc(snapshot.publicationName)}",subscription="${esc(snapshot.subscriptionName)}",node_id="${esc(snapshot.nodeId)}"`;

  const lines: string[] = [
    `# HELP ${prefix}_primary_lsn Highest LSN recorded on the source publication.`,
    `# TYPE ${prefix}_primary_lsn gauge`,
    `${prefix}_primary_lsn{${labels}} ${snapshot.primaryLsn}`,
    `# HELP ${prefix}_replica_watermark_lsn Last applied LSN watermark on the replica.`,
    `# TYPE ${prefix}_replica_watermark_lsn gauge`,
    `${prefix}_replica_watermark_lsn{${labels}} ${snapshot.replicaWatermark}`,
    `# HELP ${prefix}_lag_entries Unapplied journal entries between primary and replica.`,
    `# TYPE ${prefix}_lag_entries gauge`,
    `${prefix}_lag_entries{${labels}} ${snapshot.lagEntries}`,
    `# HELP ${prefix}_lag_ms Replication lag in milliseconds.`,
    `# TYPE ${prefix}_lag_ms gauge`,
    `${prefix}_lag_ms{${labels}} ${snapshot.lagMs}`,
    `# HELP ${prefix}_journal_depth Retained entries in FB_REPL_JOURNAL$.`,
    `# TYPE ${prefix}_journal_depth gauge`,
    `${prefix}_journal_depth{${labels}} ${snapshot.journalDepth}`,
    `# HELP ${prefix}_active_slots Active replication slots in FB_REPL_SLOTS$.`,
    `# TYPE ${prefix}_active_slots gauge`,
    `${prefix}_active_slots{${labels}} ${snapshot.activeSlots}`,
    `# HELP ${prefix}_dlq_depth Quarantined poison entries in FB_REPL_DLQ$.`,
    `# TYPE ${prefix}_dlq_depth gauge`,
    `${prefix}_dlq_depth{${labels}} ${snapshot.dlqDepth}`,
    `# HELP ${prefix}_fetched_total Cumulative journal entries fetched.`,
    `# TYPE ${prefix}_fetched_total counter`,
    `${prefix}_fetched_total{${labels}} ${snapshot.totalFetched}`,
    `# HELP ${prefix}_applied_total Cumulative journal entries applied.`,
    `# TYPE ${prefix}_applied_total counter`,
    `${prefix}_applied_total{${labels}} ${snapshot.totalApplied}`,
    `# HELP ${prefix}_conflicts_total Cumulative replication conflicts resolved.`,
    `# TYPE ${prefix}_conflicts_total counter`,
    `${prefix}_conflicts_total{${labels}} ${snapshot.totalConflicts}`,
    `# HELP ${prefix}_bytes_transferred_total Cumulative replication payload bytes transferred.`,
    `# TYPE ${prefix}_bytes_transferred_total counter`,
    `${prefix}_bytes_transferred_total{${labels}} ${snapshot.bytesTransferred}`,
    `# HELP ${prefix}_throughput_entries_per_sec Instantaneous replication apply throughput.`,
    `# TYPE ${prefix}_throughput_entries_per_sec gauge`,
    `${prefix}_throughput_entries_per_sec{${labels}} ${Number(snapshot.throughputEntriesPerSec.toFixed(4))}`,
    `# HELP ${prefix}_conflict_rate Ratio of conflicts to applied entries.`,
    `# TYPE ${prefix}_conflict_rate gauge`,
    `${prefix}_conflict_rate{${labels}} ${Number(snapshot.conflictRate.toFixed(6))}`,
  ];

  return lines.join('\n') + '\n';
}

/**
 * Create a structured replication telemetry collector with Prometheus & OpenTelemetry
 * export helpers (`M15 Item 4`).
 */
export function createReplicationMetricsCollector(
  options: CreateReplicationMetricsCollectorOptions,
): ReplicationMetricsCollector {
  const listeners = new Set<(snapshot: ReplicationTelemetrySnapshot) => void>();
  if (options.onSnapshot) {
    listeners.add(options.onSnapshot);
  }

  let prevSnapshot: ReplicationTelemetrySnapshot | null = null;

  const collect = async (now = Date.now()): Promise<ReplicationTelemetrySnapshot> => {
    const pub = options.publication;
    const sub = options.subscription;

    const subStats = sub ? await sub.stats() : null;
    const primaryLsn = subStats
      ? subStats.primaryLsn
      : pub
        ? await pub.currentLsn()
        : 0;
    const replicaWatermark = subStats ? subStats.replicaWatermark : 0;
    const lagEntries = subStats
      ? subStats.lagEntries
      : Math.max(0, primaryLsn - replicaWatermark);
    const lagMs = subStats ? subStats.lagMs : 0;

    let journalDepth = 0;
    let activeSlots = 0;
    if (pub) {
      const [entries, slots] = await Promise.all([
        pub.fetchChangesSince(0),
        pub.listSlots(),
      ]);
      journalDepth = entries.length;
      activeSlots = slots.length;
    }

    let dlqDepth = 0;
    if (options.dlq) {
      const dlqItems = await options.dlq.listEntries();
      dlqDepth = dlqItems.length;
    } else if (sub) {
      const dlqItems = await sub.listDlq();
      dlqDepth = dlqItems.length;
    }

    const totalFetched = subStats?.totalFetched ?? 0;
    const totalApplied = subStats?.totalApplied ?? 0;
    const totalConflicts = subStats?.totalConflicts ?? 0;
    const bytesTransferred = subStats?.bytesTransferred ?? 0;

    let throughputEntriesPerSec = 0;
    if (prevSnapshot && now > prevSnapshot.timestamp) {
      const deltaApplied = Math.max(0, totalApplied - prevSnapshot.totalApplied);
      const elapsedSec = (now - prevSnapshot.timestamp) / 1000;
      throughputEntriesPerSec = elapsedSec > 0 ? deltaApplied / elapsedSec : 0;
    }

    const conflictRate = totalApplied > 0 ? totalConflicts / totalApplied : 0;

    const snapshot: ReplicationTelemetrySnapshot = {
      timestamp: now,
      publicationName: pub?.name ?? 'default',
      subscriptionName: sub?.name ?? 'default_sub',
      nodeId: options.nodeId ?? sub?.nodeId ?? pub?.nodeId ?? 'node',
      status: subStats?.status ?? 'idle',
      primaryLsn,
      replicaWatermark,
      lagEntries,
      lagMs,
      journalDepth,
      activeSlots,
      dlqDepth,
      totalFetched,
      totalApplied,
      totalConflicts,
      bytesTransferred,
      throughputEntriesPerSec,
      conflictRate,
    };

    prevSnapshot = snapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
    return snapshot;
  };

  return {
    collect,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastSnapshot() {
      return prevSnapshot;
    },
    async toPrometheus(prefix = 'firebird_replication'): Promise<string> {
      const snap = await collect();
      return formatPrometheusReplicationMetrics(snap, prefix);
    },
    async toOpenTelemetry(): Promise<ReplicationOtelMetric[]> {
      const snap = await collect();
      const attributes = {
        publication: snap.publicationName,
        subscription: snap.subscriptionName,
        node_id: snap.nodeId,
      };
      const ts = snap.timestamp;
      return [
        {
          name: 'firebird.replication.primary_lsn',
          description: 'Highest LSN recorded on the source publication.',
          unit: '1',
          type: 'gauge',
          value: snap.primaryLsn,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.replica_watermark_lsn',
          description: 'Last applied LSN watermark on the replica.',
          unit: '1',
          type: 'gauge',
          value: snap.replicaWatermark,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.lag.entries',
          description: 'Unapplied journal entries between primary and replica.',
          unit: '1',
          type: 'gauge',
          value: snap.lagEntries,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.lag.ms',
          description: 'Replication lag in milliseconds.',
          unit: 'ms',
          type: 'gauge',
          value: snap.lagMs,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.journal.depth',
          description: 'Retained entries in FB_REPL_JOURNAL$.',
          unit: '1',
          type: 'gauge',
          value: snap.journalDepth,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.dlq.depth',
          description: 'Quarantined poison entries in FB_REPL_DLQ$.',
          unit: '1',
          type: 'gauge',
          value: snap.dlqDepth,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.applied.total',
          description: 'Cumulative journal entries applied.',
          unit: '1',
          type: 'counter',
          value: snap.totalApplied,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.conflicts.total',
          description: 'Cumulative replication conflicts resolved.',
          unit: '1',
          type: 'counter',
          value: snap.totalConflicts,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.bytes_transferred.total',
          description: 'Cumulative replication payload bytes transferred.',
          unit: 'By',
          type: 'counter',
          value: snap.bytesTransferred,
          attributes,
          timestamp: ts,
        },
        {
          name: 'firebird.replication.throughput.entries_per_sec',
          description: 'Instantaneous replication apply throughput.',
          unit: '1/s',
          type: 'gauge',
          value: snap.throughputEntriesPerSec,
          attributes,
          timestamp: ts,
        },
      ];
    },
  };
}

