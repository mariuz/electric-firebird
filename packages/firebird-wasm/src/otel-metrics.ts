/**
 * otel-metrics.ts – OpenTelemetry-Compatible Tracing, W3C `traceparent`
 * Propagation & OpenMetrics / Prometheus Exposition (`M27 Item 3`).
 */

import type {
  DatabaseInfo,
  MonitorStats,
  QueryProfileEvent,
  QueryProfileListener,
} from './types';
import type { ReplicationStats } from './replication/types';

// ---------------------------------------------------------------------------
// W3C Trace Context (`traceparent`: `00-<32hex traceId>-<16hex spanId>-<2hex flags>`)
// ---------------------------------------------------------------------------

export interface ParsedTraceparent {
  readonly version: string;
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceFlags: string;
  readonly sampled: boolean;
}

const TRACEPARENT_RE =
  /^\s*([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\s*$/i;

function randomHexBytes(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < byteLength; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  // Ensure non-all-zero IDs per W3C Trace Context spec
  if (buf.every((b) => b === 0)) buf[byteLength - 1] = 1;
  let out = '';
  for (let i = 0; i < byteLength; i++) {
    out += buf[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Parse and validate a W3C `traceparent` header (`M27 Item 3`). */
export function parseTraceparent(
  header: string | null | undefined,
): ParsedTraceparent | null {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header);
  if (!m) return null;
  const version = m[1]!.toLowerCase();
  const traceId = m[2]!.toLowerCase();
  const parentSpanId = m[3]!.toLowerCase();
  const traceFlags = m[4]!.toLowerCase();
  if (version === 'ff' || /^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) {
    return null;
  }
  const flagsNum = parseInt(traceFlags, 16);
  return {
    version,
    traceId,
    parentSpanId,
    traceFlags,
    sampled: (flagsNum & 0x01) === 1,
  };
}

/** Generate a fresh W3C `traceparent` header (inheriting `traceId` when `parent` is provided) (`M27 Item 3`). */
export function generateTraceparent(
  options: { parent?: string | ParsedTraceparent | null; sampled?: boolean } = {},
): {
  traceparent: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
} {
  const parsedParent =
    typeof options.parent === 'string'
      ? parseTraceparent(options.parent)
      : (options.parent ?? null);
  const traceId = parsedParent?.traceId ?? randomHexBytes(16);
  const spanId = randomHexBytes(8);
  const sampled = options.sampled ?? parsedParent?.sampled ?? true;
  const traceFlags = sampled ? '01' : '00';
  return {
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
    traceId,
    spanId,
    parentSpanId: parsedParent?.parentSpanId ?? null,
    traceFlags,
  };
}

// ---------------------------------------------------------------------------
// Structural OpenTelemetry Tracer / Span / Meter Interfaces
// ---------------------------------------------------------------------------

export type OtelAttributeValue = string | number | boolean;

/** Structural subset of `@opentelemetry/api` `Span` (`M27 Item 3`). */
export interface OtelSpanLike {
  setAttribute(key: string, value: OtelAttributeValue): unknown;
  setAttributes?(attributes: Readonly<Record<string, OtelAttributeValue>>): unknown;
  setStatus?(status: { code: 0 | 1 | 2; message?: string }): unknown;
  recordException?(err: Error | string): unknown;
  end(endTimeMs?: number): void;
}

/** Structural subset of `@opentelemetry/api` `Tracer` (`M27 Item 3`). */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: {
      startTime?: number;
      attributes?: Readonly<Record<string, OtelAttributeValue>>;
    },
  ): OtelSpanLike;
}

/** Structural subset of `@opentelemetry/api` `Meter` (`M27 Item 3`). */
export interface OtelMeterLike {
  createCounter?(name: string, options?: { description?: string; unit?: string }): {
    add(value: number, attributes?: Record<string, OtelAttributeValue>): void;
  };
  createHistogram?(name: string, options?: { description?: string; unit?: string }): {
    record(value: number, attributes?: Record<string, OtelAttributeValue>): void;
  };
}

/** Built-in recorded span captured in memory when inspecting or testing OTel spans (`M27 Item 3`). */
export interface RecordedOtelSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceparent: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly durationMs: number;
  readonly status: 'unset' | 'ok' | 'error';
  readonly errorMessage?: string;
  readonly attributes: Readonly<Record<string, OtelAttributeValue>>;
}

/** Observable database interface accepted by {@link createOtelInstrumentation} (`M27 Item 3`). */
export interface OtelObservableDatabase {
  onQuery?(listener: QueryProfileListener): () => void;
  monitorStats?(): Promise<MonitorStats>;
  databaseInfo?(): Promise<DatabaseInfo>;
}

/** Aggregated metrics snapshot formatted by {@link formatPrometheusMetrics} (`M27 Item 3`). */
export interface FirebirdPrometheusInput {
  readonly monitor?: MonitorStats | null;
  readonly dbInfo?: DatabaseInfo | null;
  readonly replication?: Partial<ReplicationStats> | {
    readonly primaryLsn?: number;
    readonly replicaWatermark?: number;
    readonly lagEntries?: number;
    readonly conflictsResolved?: number;
  } | null;
  readonly sseSubscribers?: number;
  readonly presencePeers?: number;
}

function escapePromLabel(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Format Firebird query, page I/O, transaction health, and replication lag
 * counters in standard **OpenMetrics / Prometheus** text exposition format (`M27 Item 3`).
 */
export function formatPrometheusMetrics(
  input: FirebirdPrometheusInput,
  options: { prefix?: string; labels?: Readonly<Record<string, string>> } = {},
): string {
  const p = (options.prefix ?? 'firebird').replace(/_+$/, '');
  const labelEntries = Object.entries(options.labels ?? {});
  const labelSuffix =
    labelEntries.length > 0
      ? `{${labelEntries.map(([k, v]) => `${k}="${escapePromLabel(v)}"`).join(',')}}`
      : '';

  const lines: string[] = [];
  const emitMetric = (
    name: string,
    type: 'counter' | 'gauge',
    help: string,
    value: number,
  ) => {
    const full = `${p}_${name}`;
    lines.push(`# HELP ${full} ${help}`);
    lines.push(`# TYPE ${full} ${type}`);
    lines.push(`${full}${labelSuffix} ${Number.isFinite(value) ? value : 0}`);
  };

  if (input.monitor) {
    const m = input.monitor;
    emitMetric('queries_total', 'counter', 'Total SQL query executions.', m.totalQueries);
    emitMetric('execs_total', 'counter', 'Total SQL exec/batch executions.', m.totalExecs);
    emitMetric('query_errors_total', 'counter', 'Total failed SQL executions.', m.totalErrors);
    emitMetric(
      'query_duration_ms_total',
      'counter',
      'Cumulative SQL execution duration in milliseconds.',
      Number(m.totalDurationMs.toFixed(3)),
    );
    emitMetric(
      'prepare_cache_hits_total',
      'counter',
      'Total prepared statement cache hits.',
      m.prepareCacheHits,
    );
    emitMetric(
      'prepare_cache_hit_ratio',
      'gauge',
      'Prepared statement cache hit ratio in [0, 1].',
      Number(m.prepareCacheHitRate.toFixed(4)),
    );
    emitMetric('page_fetches_total', 'counter', 'Buffer cache page fetches.', m.io.fetches);
    emitMetric('page_reads_total', 'counter', 'Physical disk page reads.', m.io.reads);
    emitMetric('page_writes_total', 'counter', 'Physical disk page writes.', m.io.writes);
    emitMetric('page_marks_total', 'counter', 'Dirtied buffer cache pages.', m.io.marks);
    emitMetric(
      'memory_current_bytes',
      'gauge',
      'Current Firebird engine memory pool usage in bytes.',
      m.io.currentMemory,
    );
    emitMetric(
      'transaction_gap',
      'gauge',
      'Gap between Next Transaction and Oldest Active Transaction (OAT).',
      m.transactions.transactionGap,
    );
  }

  if (input.dbInfo) {
    emitMetric(
      'database_size_bytes',
      'gauge',
      'Allocated Firebird database size in bytes.',
      input.dbInfo.databaseSizeBytes,
    );
    emitMetric(
      'allocated_pages',
      'gauge',
      'Allocated database pages.',
      input.dbInfo.allocatedPages,
    );
  }

  if (input.replication) {
    const r = input.replication as Record<string, unknown>;
    if (typeof r.primaryLsn === 'number') {
      emitMetric('replication_primary_lsn', 'gauge', 'Current primary journal LSN.', r.primaryLsn);
    }
    if (typeof r.replicaWatermark === 'number') {
      emitMetric(
        'replication_replica_watermark_lsn',
        'gauge',
        'Current replica applied LSN watermark.',
        r.replicaWatermark,
      );
    }
    if (typeof r.lagEntries === 'number') {
      emitMetric(
        'replication_lag_entries',
        'gauge',
        'Unapplied replication journal entries.',
        r.lagEntries,
      );
    }
    const conflicts =
      typeof r.totalConflictsResolved === 'number'
        ? r.totalConflictsResolved
        : typeof r.conflictsResolved === 'number'
          ? r.conflictsResolved
          : undefined;
    if (conflicts !== undefined) {
      emitMetric(
        'replication_conflicts_total',
        'counter',
        'Total replication conflicts resolved.',
        conflicts,
      );
    }
  }

  if (input.sseSubscribers !== undefined) {
    emitMetric(
      'sse_subscribers',
      'gauge',
      'Connected live SSE replication subscribers.',
      input.sseSubscribers,
    );
  }

  if (input.presencePeers !== undefined) {
    emitMetric(
      'presence_online_peers',
      'gauge',
      'Online ephemeral collaborative presence peers.',
      input.presencePeers,
    );
  }

  return `${lines.join('\n')}\n`;
}

/** Options for {@link createOtelInstrumentation} (`M27 Item 3`). */
export interface OtelInstrumentationOptions {
  db?: OtelObservableDatabase;
  replicator?: { stats(): Promise<ReplicationStats> };
  tracer?: OtelTracerLike;
  meter?: OtelMeterLike;
  /** Database namespace attribute (`db.namespace`). @default 'default' */
  dbNamespace?: string;
  /** Redact SQL literal strings/numbers and omit bound parameter counts if sensitive. @default true */
  redactParams?: boolean;
  /** Maximum spans kept in the built-in ring buffer (`getRecordedSpans()`). @default 200 */
  maxRecordedSpans?: number;
}

/** Handle returned by {@link createOtelInstrumentation} (`M27 Item 3`). */
export interface OtelInstrumentationHandle {
  recordQueryEvent(event: QueryProfileEvent, parentTraceparent?: string): RecordedOtelSpan;
  withSpan<T>(
    name: string,
    attributes: Readonly<Record<string, OtelAttributeValue>>,
    fn: (ctx: { traceparent: string; span: OtelSpanLike }) => Promise<T> | T,
    parentTraceparent?: string | null,
  ): Promise<T>;
  getRecordedSpans(): readonly RecordedOtelSpan[];
  clearSpans(): void;
  exportPrometheus(options?: {
    prefix?: string;
    labels?: Readonly<Record<string, string>>;
    sseSubscribers?: number;
    presencePeers?: number;
  }): Promise<string>;
  dispose(): void;
}

function extractOperationVerb(sql: string): string {
  const m = /^\s*([A-Za-z]+)/.exec(sql);
  return m ? m[1]!.toUpperCase() : 'SQL';
}

function redactSqlLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "'?'");
}

/**
 * Attach zero-dependency OpenTelemetry tracing, W3C `traceparent` context
 * propagation, and Prometheus metric exposition to a Firebird database &
 * optional replicator (`M27 Item 3`).
 */
export function createOtelInstrumentation(
  options: OtelInstrumentationOptions = {},
): OtelInstrumentationHandle {
  const dbNamespace = options.dbNamespace ?? 'default';
  const redactParams = options.redactParams !== false;
  const maxRecorded = Math.max(1, options.maxRecordedSpans ?? 200);
  const recordedSpans: RecordedOtelSpan[] = [];

  const queryCounter = options.meter?.createCounter?.('db.client.operation.count', {
    description: 'Number of Firebird SQL operations executed.',
  });
  const durationHistogram = options.meter?.createHistogram?.('db.client.operation.duration', {
    description: 'Duration of Firebird SQL operations in milliseconds.',
    unit: 'ms',
  });

  const pushRecorded = (span: RecordedOtelSpan): void => {
    if (recordedSpans.length >= maxRecorded) {
      recordedSpans.shift();
    }
    recordedSpans.push(span);
  };

  const recordQueryEvent = (
    ev: QueryProfileEvent,
    parentTraceparent?: string,
  ): RecordedOtelSpan => {
    const opName = extractOperationVerb(ev.sql);
    const spanName = `firebird.${opName.toLowerCase()}`;
    const tp = generateTraceparent({ parent: parentTraceparent });
    const endMs = ev.timestamp || Date.now();
    const startMs = Math.max(0, endMs - ev.durationMs);
    const sanitizedSql = redactParams ? redactSqlLiterals(ev.sql) : ev.sql;

    const attrs: Record<string, OtelAttributeValue> = {
      'db.system': 'firebird',
      'db.namespace': dbNamespace,
      'db.operation.name': opName,
      'db.query.text': sanitizedSql,
      'firebird.execution.kind': ev.kind,
      'firebird.row_count': ev.rowCount,
      'firebird.cache_hit': ev.cacheHit,
      traceparent: tp.traceparent,
    };
    if (!redactParams) {
      attrs['firebird.param_count'] = ev.params.length;
    }
    if (ev.io) {
      attrs['firebird.io.fetches'] = ev.io.fetches;
      attrs['firebird.io.reads'] = ev.io.reads;
      attrs['firebird.io.writes'] = ev.io.writes;
      attrs['firebird.io.marks'] = ev.io.marks;
    }

    if (options.tracer) {
      const extSpan = options.tracer.startSpan(spanName, {
        startTime: startMs,
        attributes: attrs,
      });
      if (ev.error) {
        extSpan.recordException?.(ev.error);
        extSpan.setStatus?.({ code: 2, message: ev.error.message });
      } else {
        extSpan.setStatus?.({ code: 1 });
      }
      extSpan.end(endMs);
    }

    queryCounter?.add(1, { 'db.system': 'firebird', 'db.operation.name': opName });
    durationHistogram?.record(ev.durationMs, {
      'db.system': 'firebird',
      'db.operation.name': opName,
    });

    const recorded: RecordedOtelSpan = {
      name: spanName,
      traceId: tp.traceId,
      spanId: tp.spanId,
      parentSpanId: tp.parentSpanId,
      traceparent: tp.traceparent,
      startTimeMs: startMs,
      endTimeMs: endMs,
      durationMs: ev.durationMs,
      status: ev.error ? 'error' : 'ok',
      ...(ev.error ? { errorMessage: ev.error.message } : {}),
      attributes: attrs,
    };
    pushRecorded(recorded);
    return recorded;
  };

  const unsub = options.db?.onQuery
    ? options.db.onQuery((ev) => {
        recordQueryEvent(ev);
      })
    : null;

  return {
    recordQueryEvent,

    async withSpan<T>(
      name: string,
      attributes: Readonly<Record<string, OtelAttributeValue>>,
      fn: (ctx: { traceparent: string; span: OtelSpanLike }) => Promise<T> | T,
      parentTraceparent?: string | null,
    ): Promise<T> {
      const tp = generateTraceparent({ parent: parentTraceparent });
      const startMs = Date.now();
      const mutableAttrs: Record<string, OtelAttributeValue> = {
        'db.system': 'firebird',
        'db.namespace': dbNamespace,
        ...attributes,
        traceparent: tp.traceparent,
      };
      let status: 'unset' | 'ok' | 'error' = 'unset';
      let errorMessage: string | undefined;

      const extSpan = options.tracer?.startSpan(name, {
        startTime: startMs,
        attributes: mutableAttrs,
      });

      const spanWrapper: OtelSpanLike = {
        setAttribute(k, v) {
          mutableAttrs[k] = v;
          extSpan?.setAttribute(k, v);
        },
        setAttributes(map) {
          Object.assign(mutableAttrs, map);
          extSpan?.setAttributes?.(map);
        },
        setStatus(s) {
          status = s.code === 2 ? 'error' : s.code === 1 ? 'ok' : 'unset';
          if (s.message) errorMessage = s.message;
          extSpan?.setStatus?.(s);
        },
        recordException(err) {
          errorMessage = err instanceof Error ? err.message : String(err);
          extSpan?.recordException?.(err);
        },
        end() {
          // Managed by withSpan finally block
        },
      };

      try {
        const result = await fn({ traceparent: tp.traceparent, span: spanWrapper });
        if (status === 'unset') status = 'ok';
        extSpan?.setStatus?.({ code: 1 });
        return result;
      } catch (err) {
        status = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
        extSpan?.recordException?.(err instanceof Error ? err : String(err));
        extSpan?.setStatus?.({ code: 2, message: errorMessage });
        throw err;
      } finally {
        const endMs = Date.now();
        extSpan?.end(endMs);
        pushRecorded({
          name,
          traceId: tp.traceId,
          spanId: tp.spanId,
          parentSpanId: tp.parentSpanId,
          traceparent: tp.traceparent,
          startTimeMs: startMs,
          endTimeMs: endMs,
          durationMs: Math.max(0, endMs - startMs),
          status,
          ...(errorMessage ? { errorMessage } : {}),
          attributes: mutableAttrs,
        });
      }
    },

    getRecordedSpans() {
      return [...recordedSpans];
    },

    clearSpans() {
      recordedSpans.length = 0;
    },

    async exportPrometheus(promOpts = {}) {
      const [monitor, dbInfo, replication] = await Promise.all([
        options.db?.monitorStats ? options.db.monitorStats().catch(() => null) : null,
        options.db?.databaseInfo ? options.db.databaseInfo().catch(() => null) : null,
        options.replicator ? options.replicator.stats().catch(() => null) : null,
      ]);
      return formatPrometheusMetrics(
        {
          monitor,
          dbInfo,
          replication,
          sseSubscribers: promOpts.sseSubscribers,
          presencePeers: promOpts.presencePeers,
        },
        { prefix: promOpts.prefix, labels: promOpts.labels },
      );
    },

    dispose() {
      unsub?.();
    },
  };
}
