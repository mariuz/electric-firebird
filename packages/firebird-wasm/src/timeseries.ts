/**
 * timeseries.ts – Time-Series Hypertable Policies, Gap-Filling (`locf` / `linear`),
 * Continuous Rollup Aggregations, Retention Compaction & LTTB Downsampling (`M29 Item 1`).
 */

import type {
  JsFunctionHandler,
  QueryParams,
  QueryResult,
  RegisterFunctionOptions,
  RegisteredRoutine,
  Row,
} from './types';

export const DEFAULT_TS_POLICIES_TABLE = 'FB_TS_POLICIES$';

export type TimeSeriesGapFillMode = 'none' | 'null' | 'zero' | 'locf' | 'linear';

export interface TimeSeriesDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  registerFunction?(
    name: string,
    options: RegisterFunctionOptions,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
}

export interface TimeSeriesPolicyInput {
  readonly name: string;
  readonly table: string;
  readonly timeColumn: string;
  readonly valueColumn: string;
  readonly rollupTable?: string;
  /** Bucket interval in ms or duration string (`'1s'`, `'5m'`, `'1h'`, `'1d'`). */
  readonly bucketInterval: number | string;
  /** Optional retention window in ms or duration string (`'7d'`, `'24h'`). */
  readonly retention?: number | string | null;
}

export interface TimeSeriesPolicyInfo {
  readonly name: string;
  readonly table: string;
  readonly timeColumn: string;
  readonly valueColumn: string;
  readonly rollupTable: string;
  readonly bucketMs: number;
  readonly retentionMs: number | null;
  readonly lastRollupTs: number | null;
}

export interface TimeSeriesBucketRow {
  readonly bucketMs: number;
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly sum: number | null;
  readonly first: number | null;
  readonly last: number | null;
  readonly interpolated: boolean;
}

export interface TimeSeriesBucketQueryOptions {
  readonly table: string;
  readonly timeColumn: string;
  readonly valueColumn: string;
  readonly bucket: number | string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly where?: string;
  readonly params?: QueryParams;
  readonly gapFill?: TimeSeriesGapFillMode;
}

export interface TimeSeriesDownsampleOptions {
  readonly table: string;
  readonly timeColumn: string;
  readonly valueColumn: string;
  readonly threshold: number;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly where?: string;
  readonly params?: QueryParams;
}

export interface TimeSeriesPoint {
  readonly timestamp: number;
  readonly value: number;
}

export interface TimeSeriesStoreHandle {
  readonly policiesTable: string;
  ensureSchema(): Promise<void>;
  registerPolicy(input: TimeSeriesPolicyInput): Promise<TimeSeriesPolicyInfo>;
  listPolicies(): Promise<TimeSeriesPolicyInfo[]>;
  bucketQuery(options: TimeSeriesBucketQueryOptions): Promise<TimeSeriesBucketRow[]>;
  downsampleQuery(options: TimeSeriesDownsampleOptions): Promise<TimeSeriesPoint[]>;
  refreshRollup(policyName: string): Promise<{ bucketsUpserted: number; maxTimestamp: number | null }>;
  applyRetention(policyName: string, nowMs?: number): Promise<{ deletedRows: number; cutoffMs: number | null }>;
}

/**
 * Parse a human duration (`'500ms'`, `'10s'`, `'5m'`, `'1h'`, `'7d'`) or numeric milliseconds
 * into positive integer milliseconds (`M29 Item 1`).
 */
export function parseBucketIntervalMs(interval: number | string): number {
  if (typeof interval === 'number') {
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new RangeError(`Bucket interval must be > 0 (got ${String(interval)})`);
    }
    return Math.floor(interval);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(interval);
  if (!m) {
    throw new Error(`Invalid duration "${interval}". Expected e.g. "500ms", "10s", "5m", "1h", "7d".`);
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const mult =
    unit === 'd'
      ? 86_400_000
      : unit === 'h'
        ? 3_600_000
        : unit === 'm'
          ? 60_000
          : unit === 's'
            ? 1_000
            : 1;
  const ms = Math.floor(n * mult);
  if (ms <= 0) throw new RangeError(`Duration "${interval}" resolved to <= 0 ms.`);
  return ms;
}

/** Floor an epoch millisecond timestamp to a fixed `bucketMs` grid (`M29 Item 1`). */
export function floorToBucket(timestampMs: number, bucketMs: number, originMs = 0): number {
  if (bucketMs <= 0) throw new RangeError('bucketMs must be > 0');
  return originMs + Math.floor((timestampMs - originMs) / bucketMs) * bucketMs;
}

/**
 * Largest-Triangle-Three-Buckets (LTTB) peak-preserving time-series visual downsampling
 * (`M29 Item 1`). Preserves the exact first and last points while selecting intermediate
 * points that maximize triangle area with neighboring bucket centroids.
 */
export function lttbDownsample<T>(
  points: readonly T[],
  threshold: number,
  accessors: {
    x?: (point: T) => number;
    y?: (point: T) => number;
  } = {},
): T[] {
  const len = points.length;
  if (threshold <= 0) return [];
  if (threshold >= len || len <= 2) return [...points];
  if (threshold === 1) return [points[0]!];
  if (threshold === 2) return [points[0]!, points[len - 1]!];

  const getX =
    accessors.x ??
    ((p: T) => Number((p as Record<string, unknown>).timestamp ?? (p as Record<string, unknown>).x ?? 0));
  const getY =
    accessors.y ??
    ((p: T) => Number((p as Record<string, unknown>).value ?? (p as Record<string, unknown>).y ?? 0));

  const sampled: T[] = [points[0]!];
  const every = (len - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const avgRangeStart = Math.floor((i + 1) * every) + 1;
    const avgRangeEnd = Math.min(len, Math.floor((i + 2) * every) + 1);
    const avgRangeLength = Math.max(1, avgRangeEnd - avgRangeStart);

    let avgX = 0;
    let avgY = 0;
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += getX(points[j]!);
      avgY += getY(points[j]!);
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    const rangeOffs = Math.floor(i * every) + 1;
    const rangeTo = Math.min(len - 1, Math.floor((i + 1) * every) + 1);

    const pointAX = getX(points[a]!);
    const pointAY = getY(points[a]!);

    let maxArea = -1;
    let nextA = rangeOffs;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area =
        Math.abs(
          (pointAX - avgX) * (getY(points[j]!) - pointAY) -
            (pointAX - getX(points[j]!)) * (avgY - pointAY),
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }
    sampled.push(points[nextA]!);
    a = nextA;
  }

  sampled.push(points[len - 1]!);
  return sampled;
}

/**
 * Fill missing buckets across `[startMs, endMs]` using `'null'`, `'zero'`,
 * Last-Observation-Carried-Forward (`'locf'`), or `'linear'` interpolation (`M29 Item 1`).
 */
export function fillTimeGaps(
  sparse: readonly TimeSeriesBucketRow[],
  options: {
    startMs: number;
    endMs: number;
    bucketMs: number;
    mode: TimeSeriesGapFillMode;
  },
): TimeSeriesBucketRow[] {
  if (options.mode === 'none') return [...sparse];
  const bMs = options.bucketMs;
  const firstBucket = floorToBucket(options.startMs, bMs);
  const lastBucket = floorToBucket(options.endMs, bMs);
  if (lastBucket < firstBucket) return [];

  const byBucket = new Map<number, TimeSeriesBucketRow>();
  for (const row of sparse) {
    byBucket.set(row.bucketMs, row);
  }

  const out: TimeSeriesBucketRow[] = [];
  for (let t = firstBucket; t <= lastBucket; t += bMs) {
    const existing = byBucket.get(t);
    if (existing) {
      out.push(existing);
    } else {
      const fillVal = options.mode === 'zero' ? 0 : null;
      out.push({
        bucketMs: t,
        count: 0,
        min: fillVal,
        max: fillVal,
        avg: fillVal,
        sum: fillVal === 0 ? 0 : null,
        first: fillVal,
        last: fillVal,
        interpolated: true,
      });
    }
  }

  if (options.mode === 'locf') {
    let carry: number | null = null;
    for (let i = 0; i < out.length; i++) {
      const r = out[i]!;
      if (!r.interpolated && r.avg !== null) {
        carry = r.last ?? r.avg;
      } else if (r.interpolated && carry !== null) {
        out[i] = {
          bucketMs: r.bucketMs,
          count: 0,
          min: carry,
          max: carry,
          avg: carry,
          sum: 0,
          first: carry,
          last: carry,
          interpolated: true,
        };
      }
    }
  } else if (options.mode === 'linear') {
    let prevKnownIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]!.interpolated && out[i]!.avg !== null) {
        if (prevKnownIdx !== -1 && i - prevKnownIdx > 1) {
          const v0 = out[prevKnownIdx]!.avg!;
          const v1 = out[i]!.avg!;
          const span = i - prevKnownIdx;
          for (let k = prevKnownIdx + 1; k < i; k++) {
            const frac = (k - prevKnownIdx) / span;
            const interp = v0 + (v1 - v0) * frac;
            out[k] = {
              bucketMs: out[k]!.bucketMs,
              count: 0,
              min: interp,
              max: interp,
              avg: interp,
              sum: 0,
              first: interp,
              last: interp,
              interpolated: true,
            };
          }
        }
        prevKnownIdx = i;
      }
    }
  }

  return out;
}

function qTsIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function tsCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

function toEpochMs(raw: unknown): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'number') return raw;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function execTsSql(
  db: TimeSeriesDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<number> {
  if (typeof db.execute === 'function') {
    const r = await db.execute(sql, params);
    return r.affectedRows;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
    return 0;
  }
  await db.query(sql, params);
  return 0;
}

/**
 * Create a Firebird time-series policy, continuous rollup, retention, and
 * bucketed analytics store (`M29 Item 1`).
 */
export function createTimeSeriesStore(
  db: TimeSeriesDatabaseExecutor,
  options: { policiesTable?: string } = {},
): TimeSeriesStoreHandle {
  const policiesTable = (options.policiesTable ?? DEFAULT_TS_POLICIES_TABLE).toUpperCase();
  let schemaReady = false;

  const ensureSchema = async (): Promise<void> => {
    if (schemaReady) return;
    const chk = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [policiesTable],
    );
    if (Number(tsCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execTsSql(
        db,
        `CREATE TABLE ${qTsIdent(policiesTable)} (
          POLICY_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
          TABLE_NAME VARCHAR(128) NOT NULL,
          TIME_COLUMN VARCHAR(128) NOT NULL,
          VALUE_COLUMN VARCHAR(128) NOT NULL,
          ROLLUP_TABLE VARCHAR(128) NOT NULL,
          BUCKET_MS BIGINT NOT NULL,
          RETENTION_MS BIGINT,
          LAST_ROLLUP_TS BIGINT
        )`,
      );
    }
    schemaReady = true;
  };

  const computeBucketsFromRows = (
    rows: readonly Record<string, unknown>[],
    timeUpper: string,
    valUpper: string,
    bucketMs: number,
  ): TimeSeriesBucketRow[] => {
    const acc = new Map<
      number,
      {
        count: number;
        min: number;
        max: number;
        sum: number;
        firstTs: number;
        firstVal: number;
        lastTs: number;
        lastVal: number;
      }
    >();

    for (const r of rows) {
      const rawT = tsCol(r, timeUpper);
      const rawV = tsCol(r, valUpper);
      if (rawT === null || rawT === undefined || rawV === null || rawV === undefined) continue;
      const ts = toEpochMs(rawT);
      const val = Number(rawV);
      if (!Number.isFinite(val)) continue;
      const bStart = floorToBucket(ts, bucketMs);
      const cur = acc.get(bStart);
      if (!cur) {
        acc.set(bStart, {
          count: 1,
          min: val,
          max: val,
          sum: val,
          firstTs: ts,
          firstVal: val,
          lastTs: ts,
          lastVal: val,
        });
      } else {
        cur.count += 1;
        if (val < cur.min) cur.min = val;
        if (val > cur.max) cur.max = val;
        cur.sum += val;
        if (ts < cur.firstTs) {
          cur.firstTs = ts;
          cur.firstVal = val;
        }
        if (ts >= cur.lastTs) {
          cur.lastTs = ts;
          cur.lastVal = val;
        }
      }
    }

    return [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, s]) => ({
        bucketMs: b,
        count: s.count,
        min: s.min,
        max: s.max,
        avg: s.sum / s.count,
        sum: s.sum,
        first: s.firstVal,
        last: s.lastVal,
        interpolated: false,
      }));
  };

  return {
    policiesTable,
    ensureSchema,

    async registerPolicy(input: TimeSeriesPolicyInput): Promise<TimeSeriesPolicyInfo> {
      await ensureSchema();
      const name = input.name.trim();
      const table = input.table.trim().toUpperCase();
      const timeCol = input.timeColumn.trim().toUpperCase();
      const valCol = input.valueColumn.trim().toUpperCase();
      const rollupTable = (input.rollupTable ?? `${table}_ROLLUP_${name}`.slice(0, 31))
        .trim()
        .toUpperCase();
      const bucketMs = parseBucketIntervalMs(input.bucketInterval);
      const retentionMs =
        input.retention !== null && input.retention !== undefined
          ? parseBucketIntervalMs(input.retention)
          : null;

      const rChk = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [rollupTable],
      );
      if (Number(tsCol(rChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
        await execTsSql(
          db,
          `CREATE TABLE ${qTsIdent(rollupTable)} (
            BUCKET_START BIGINT NOT NULL PRIMARY KEY,
            SAMPLE_COUNT BIGINT NOT NULL,
            MIN_VAL DOUBLE PRECISION,
            MAX_VAL DOUBLE PRECISION,
            AVG_VAL DOUBLE PRECISION,
            SUM_VAL DOUBLE PRECISION,
            FIRST_VAL DOUBLE PRECISION,
            LAST_VAL DOUBLE PRECISION
          )`,
        );
      }

      await execTsSql(
        db,
        `UPDATE OR INSERT INTO ${qTsIdent(policiesTable)} (
          POLICY_NAME, TABLE_NAME, TIME_COLUMN, VALUE_COLUMN, ROLLUP_TABLE, BUCKET_MS, RETENTION_MS, LAST_ROLLUP_TS
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) MATCHING (POLICY_NAME)`,
        [name, table, timeCol, valCol, rollupTable, bucketMs, retentionMs],
      );

      return {
        name,
        table,
        timeColumn: timeCol,
        valueColumn: valCol,
        rollupTable,
        bucketMs,
        retentionMs,
        lastRollupTs: null,
      };
    },

    async listPolicies(): Promise<TimeSeriesPolicyInfo[]> {
      const chk = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [policiesTable],
      );
      if (Number(tsCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qTsIdent(policiesTable)} ORDER BY POLICY_NAME`,
      );
      return res.rows.map((r) => {
        const ret = tsCol(r, 'RETENTION_MS');
        const last = tsCol(r, 'LAST_ROLLUP_TS');
        return {
          name: String(tsCol(r, 'POLICY_NAME') ?? ''),
          table: String(tsCol(r, 'TABLE_NAME') ?? ''),
          timeColumn: String(tsCol(r, 'TIME_COLUMN') ?? ''),
          valueColumn: String(tsCol(r, 'VALUE_COLUMN') ?? ''),
          rollupTable: String(tsCol(r, 'ROLLUP_TABLE') ?? ''),
          bucketMs: Number(tsCol(r, 'BUCKET_MS') ?? 0),
          retentionMs: ret === null || ret === undefined ? null : Number(ret),
          lastRollupTs: last === null || last === undefined ? null : Number(last),
        };
      });
    },

    async bucketQuery(qOpts: TimeSeriesBucketQueryOptions): Promise<TimeSeriesBucketRow[]> {
      const bucketMs = parseBucketIntervalMs(qOpts.bucket);
      const tbl = qTsIdent(qOpts.table);
      const tCol = qTsIdent(qOpts.timeColumn);
      const vCol = qTsIdent(qOpts.valueColumn);

      const conds: string[] = [];
      const params: unknown[] = [];
      if (qOpts.startMs !== undefined) {
        conds.push(`${tCol} >= ?`);
        params.push(qOpts.startMs);
      }
      if (qOpts.endMs !== undefined) {
        conds.push(`${tCol} <= ?`);
        params.push(qOpts.endMs);
      }
      if (qOpts.where?.trim()) {
        conds.push(`(${qOpts.where.trim()})`);
        params.push(...(qOpts.params ?? []));
      }
      const whereSql = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
      const res = await db.query<Record<string, unknown>>(
        `SELECT ${tCol}, ${vCol} FROM ${tbl}${whereSql} ORDER BY ${tCol} ASC`,
        params as QueryParams,
      );

      const sparse = computeBucketsFromRows(
        res.rows,
        qOpts.timeColumn.trim().toUpperCase(),
        qOpts.valueColumn.trim().toUpperCase(),
        bucketMs,
      );

      const fillMode = qOpts.gapFill ?? 'none';
      if (fillMode === 'none' || sparse.length === 0 && (qOpts.startMs === undefined || qOpts.endMs === undefined)) {
        return sparse;
      }
      const startMs = qOpts.startMs ?? sparse[0]!.bucketMs;
      const endMs = qOpts.endMs ?? sparse[sparse.length - 1]!.bucketMs;
      return fillTimeGaps(sparse, { startMs, endMs, bucketMs, mode: fillMode });
    },

    async downsampleQuery(dOpts: TimeSeriesDownsampleOptions): Promise<TimeSeriesPoint[]> {
      const tbl = qTsIdent(dOpts.table);
      const tCol = qTsIdent(dOpts.timeColumn);
      const vCol = qTsIdent(dOpts.valueColumn);
      const conds: string[] = [];
      const params: unknown[] = [];
      if (dOpts.startMs !== undefined) {
        conds.push(`${tCol} >= ?`);
        params.push(dOpts.startMs);
      }
      if (dOpts.endMs !== undefined) {
        conds.push(`${tCol} <= ?`);
        params.push(dOpts.endMs);
      }
      if (dOpts.where?.trim()) {
        conds.push(`(${dOpts.where.trim()})`);
        params.push(...(dOpts.params ?? []));
      }
      const whereSql = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
      const res = await db.query<Record<string, unknown>>(
        `SELECT ${tCol}, ${vCol} FROM ${tbl}${whereSql} ORDER BY ${tCol} ASC`,
        params as QueryParams,
      );
      const tUpper = dOpts.timeColumn.trim().toUpperCase();
      const vUpper = dOpts.valueColumn.trim().toUpperCase();
      const pts: TimeSeriesPoint[] = [];
      for (const r of res.rows) {
        const rt = tsCol(r, tUpper);
        const rv = tsCol(r, vUpper);
        if (rt === null || rt === undefined || rv === null || rv === undefined) continue;
        pts.push({ timestamp: toEpochMs(rt), value: Number(rv) });
      }
      return lttbDownsample(pts, dOpts.threshold);
    },

    async refreshRollup(policyName: string) {
      await ensureSchema();
      const policies = await this.listPolicies();
      const pol = policies.find((p) => p.name === policyName.trim());
      if (!pol) throw new Error(`Time-series policy "${policyName}" not found.`);

      // Recompute from the bucket containing `lastRollupTs` so late arrivals in the active bucket merge cleanly
      const startBucket =
        pol.lastRollupTs !== null ? floorToBucket(pol.lastRollupTs, pol.bucketMs) : undefined;

      const buckets = await this.bucketQuery({
        table: pol.table,
        timeColumn: pol.timeColumn,
        valueColumn: pol.valueColumn,
        bucket: pol.bucketMs,
        startMs: startBucket,
        gapFill: 'none',
      });

      let maxTs: number | null = pol.lastRollupTs;
      for (const b of buckets) {
        await execTsSql(
          db,
          `UPDATE OR INSERT INTO ${qTsIdent(pol.rollupTable)} (
            BUCKET_START, SAMPLE_COUNT, MIN_VAL, MAX_VAL, AVG_VAL, SUM_VAL, FIRST_VAL, LAST_VAL
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) MATCHING (BUCKET_START)`,
          [b.bucketMs, b.count, b.min, b.max, b.avg, b.sum, b.first, b.last],
        );
        if (maxTs === null || b.bucketMs > maxTs) maxTs = b.bucketMs;
      }

      if (maxTs !== null) {
        await execTsSql(
          db,
          `UPDATE ${qTsIdent(policiesTable)} SET LAST_ROLLUP_TS = ? WHERE POLICY_NAME = ?`,
          [maxTs, pol.name],
        );
      }

      return { bucketsUpserted: buckets.length, maxTimestamp: maxTs };
    },

    async applyRetention(policyName: string, nowMs = Date.now()) {
      await ensureSchema();
      const policies = await this.listPolicies();
      const pol = policies.find((p) => p.name === policyName.trim());
      if (!pol) throw new Error(`Time-series policy "${policyName}" not found.`);
      if (pol.retentionMs === null) {
        return { deletedRows: 0, cutoffMs: null };
      }
      const cutoffMs = nowMs - pol.retentionMs;
      const beforeRes = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM ${qTsIdent(pol.table)} WHERE ${qTsIdent(pol.timeColumn)} < ?`,
        [cutoffMs],
      );
      const countToDelete = Number(tsCol(beforeRes.rows[0] ?? {}, 'CNT') ?? 0);
      if (countToDelete > 0) {
        await execTsSql(
          db,
          `DELETE FROM ${qTsIdent(pol.table)} WHERE ${qTsIdent(pol.timeColumn)} < ?`,
          [cutoffMs],
        );
      }
      return { deletedRows: countToDelete, cutoffMs };
    },
  };
}

/**
 * Register Firebird SQL time-series UDR helper `TS_BUCKET(epoch_ms, bucket_ms)` (`M29 Item 1`).
 */
export async function registerTimeSeriesFunctions(
  db: TimeSeriesDatabaseExecutor,
  options: { replace?: boolean } = {},
): Promise<RegisteredRoutine[]> {
  if (typeof db.registerFunction !== 'function') {
    throw new TypeError('Database instance does not support db.registerFunction()');
  }
  const replace = options.replace !== false;
  const routine = await db.registerFunction(
    'TS_BUCKET',
    {
      args: ['BIGINT', 'BIGINT'],
      returns: 'BIGINT',
      deterministic: true,
      replace,
    },
    (ts: unknown, bucket: unknown) => {
      if (ts === null || ts === undefined || bucket === null || bucket === undefined) return null;
      return floorToBucket(Number(ts), Number(bucket));
    },
  );
  return [routine];
}
