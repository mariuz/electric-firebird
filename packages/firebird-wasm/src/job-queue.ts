/**
 * job-queue.ts – Durable Transactional Job Queue, Cron Scheduler & Crash-Safe
 * Checkpointed Workflows (`createJobQueue`) (`M28 Item 1`).
 */

import type { QueryParams, QueryResult, Row, TransactionOptions } from './types';

export const DEFAULT_JOB_QUEUE_TABLE = 'FB_JOB_QUEUE$';
export const DEFAULT_JOB_DLQ_TABLE = 'FB_JOB_DLQ$';
export const DEFAULT_JOB_SCHEDULES_TABLE = 'FB_JOB_SCHEDULES$';
export const DEFAULT_WORKFLOW_STEPS_TABLE = 'FB_WORKFLOW_STEPS$';
export const DEFAULT_JOB_WAKEUP_EVENT = 'FB_JOB_WAKEUP$';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead';

/** Minimal database executor required by {@link createJobQueue} (`M28 Item 1`). */
export interface JobQueueDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  transaction?<T>(
    fn: (tx: {
      query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
    }) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  notify?(eventName: string): Promise<void>;
  listen?(
    eventName: string,
    handler: (count: number) => void,
  ): Promise<{ unsubscribe(): Promise<void> }>;
}

/** Persisted job record (`M28 Item 1`). */
export interface JobRecord<TPayload = unknown> {
  readonly id: string;
  readonly jobId: string;
  readonly queueName: string;
  readonly payload: TPayload;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: number;
  readonly leaseUntil: number | null;
  readonly workerId: string | null;
  readonly dedupeKey: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Dead-lettered job record (`M28 Item 1`). */
export interface DeadLetterJobRecord<TPayload = unknown> {
  readonly id: string;
  readonly jobId: string;
  readonly queueName: string;
  readonly payload: TPayload;
  readonly attempts: number;
  readonly error: string | null;
  readonly errorMessage: string | null;
  readonly failedAt: number;
}

/** Enqueue options for {@link JobQueueHandle.enqueue} (`M28 Item 1`). */
export interface EnqueueJobOptions {
  readonly jobId?: string;
  readonly priority?: number;
  readonly delayMs?: number;
  readonly runAt?: number;
  readonly maxAttempts?: number;
  readonly dedupeKey?: string;
  readonly now?: number;
}

/** Queue depth & execution summary (`M28 Item 1`). */
export interface JobQueueStats {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly dead: number;
  readonly dlqCount: number;
  readonly schedulesCount: number;
}

/** Step runner passed into {@link JobQueueHandle.runWorkflow} (`M28 Item 1`). */
export interface WorkflowStepRunner {
  run<R>(stepKey: string, fn: () => Promise<R> | R): Promise<R>;
}

/** Parsed cron schedule matcher (`M28 Item 1`). */
export interface ParsedCronSchedule {
  readonly kind: 'interval' | 'cron';
  readonly intervalMs?: number;
  readonly minutes?: ReadonlySet<number>;
  readonly hours?: ReadonlySet<number>;
  readonly daysOfMonth?: ReadonlySet<number>;
  readonly months?: ReadonlySet<number>;
  readonly daysOfWeek?: ReadonlySet<number>;
}

/** Options for {@link createJobQueue} (`M28 Item 1`). */
export interface JobQueueOptions {
  readonly queueTable?: string;
  readonly dlqTable?: string;
  readonly schedulesTable?: string;
  readonly workflowTable?: string;
  readonly wakeupEvent?: string;
  readonly defaultLeaseMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
}

export type JobHandlerMap = Readonly<
  Record<string, (job: JobRecord) => Promise<unknown> | unknown>
>;

/** Handle returned by {@link createJobQueue} (`M28 Item 1`). */
export interface JobQueueHandle {
  readonly queueTable: string;
  enqueue<TPayload = unknown>(
    queueName: string,
    payload: TPayload,
    options?: EnqueueJobOptions,
  ): Promise<{ job: JobRecord<TPayload>; deduplicated: boolean }>;
  claimNext<TPayload = unknown>(
    queueName?: string | readonly string[],
    options?: { workerId?: string; leaseMs?: number; now?: number },
  ): Promise<JobRecord<TPayload> | null>;
  complete(jobId: string, options?: { deleteCompleted?: boolean; now?: number }): Promise<boolean>;
  fail(
    jobId: string,
    error: unknown,
    options?: { backoffBaseMs?: number; maxBackoffMs?: number; now?: number },
  ): Promise<{ status: 'pending' | 'dead'; nextRunAt: number | null }>;
  extendLease(jobId: string, extraMs: number, options?: { now?: number }): Promise<boolean>;
  schedule(
    scheduleId: string,
    spec: { queueName: string; cron: string; payload?: unknown; now?: number },
  ): Promise<{ scheduleId: string; nextRunAt: number }>;
  tickSchedules(now?: number): Promise<number>;
  processBatch(
    handlers: JobHandlerMap,
    options?: { workerId?: string; maxJobs?: number; leaseMs?: number; now?: number },
  ): Promise<{ processed: number; succeeded: number; failed: number }>;
  startWorker(
    handlers: JobHandlerMap,
    options?: { pollIntervalMs?: number; workerId?: string; leaseMs?: number },
  ): Promise<{ stop(): Promise<void> }>;
  runWorkflow<T>(
    workflowId: string,
    fn: (step: WorkflowStepRunner) => Promise<T>,
  ): Promise<{ result: T; executedSteps: number; replayedSteps: number }>;
  stats(): Promise<JobQueueStats>;
  listDlq<TPayload = unknown>(): Promise<DeadLetterJobRecord<TPayload>[]>;
}

// ---------------------------------------------------------------------------
// Cron & `@every` Expression Parser
// ---------------------------------------------------------------------------

function parseCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const stepSplit = part.trim().split('/');
    const rangePart = stepSplit[0]!;
    const step = stepSplit[1] !== undefined ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step in "${field}"`);
    }
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [loStr, hiStr] = rangePart.split('-');
        start = Number(loStr);
        end = Number(hiStr);
      } else {
        start = Number(rangePart);
        end = stepSplit[1] !== undefined ? max : start;
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron range "${part}" (bounds ${min}..${max})`);
    }
    for (let v = start; v <= end; v += step) {
      out.add(v === 7 && max === 7 ? 0 : v);
    }
  }
  return out;
}

/** Parse a 5-field cron expression or `@hourly` / `@daily` / `@every <N>ms|s|m|h` (`M28 Item 1`). */
export function parseCronExpression(expr: string): ParsedCronSchedule {
  const clean = expr.trim().toLowerCase();
  if (clean === '@hourly') return parseCronExpression('0 * * * *');
  if (clean === '@daily' || clean === '@midnight') return parseCronExpression('0 0 * * *');
  if (clean === '@weekly') return parseCronExpression('0 0 * * 0');
  const everyMatch = /^@every\s+(\d+)\s*(ms|s|m|h)$/i.exec(clean);
  if (everyMatch) {
    const val = Number(everyMatch[1]);
    const unit = everyMatch[2]!.toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
    if (val <= 0) throw new Error(`Invalid @every interval: ${expr}`);
    return { kind: 'interval', intervalMs: val * mult };
  }

  const parts = clean.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields (min hour dom month dow) or @every`,
    );
  }
  return {
    kind: 'cron',
    minutes: parseCronField(parts[0]!, 0, 59),
    hours: parseCronField(parts[1]!, 0, 23),
    daysOfMonth: parseCronField(parts[2]!, 1, 31),
    months: parseCronField(parts[3]!, 1, 12),
    daysOfWeek: parseCronField(parts[4]!, 0, 7),
  };
}

/** Compute the next execution timestamp strictly after `afterMs` (UTC) (`M28 Item 1`). */
export function nextCronRunAfter(
  expr: string | ParsedCronSchedule,
  afterMs: number | Date,
): number {
  const baseMs = afterMs instanceof Date ? afterMs.getTime() : afterMs;
  const parsed = typeof expr === 'string' ? parseCronExpression(expr) : expr;
  if (parsed.kind === 'interval') {
    return baseMs + (parsed.intervalMs ?? 60_000);
  }
  const d = new Date(Math.floor(baseMs / 60_000) * 60_000 + 60_000);
  const maxChecks = 366 * 24 * 60;
  for (let i = 0; i < maxChecks; i++) {
    if (
      parsed.months!.has(d.getUTCMonth() + 1) &&
      parsed.daysOfMonth!.has(d.getUTCDate()) &&
      parsed.daysOfWeek!.has(d.getUTCDay()) &&
      parsed.hours!.has(d.getUTCHours()) &&
      parsed.minutes!.has(d.getUTCMinutes())
    ) {
      return d.getTime();
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error('Cron expression did not match any timestamp within 366 days.');
}

// ---------------------------------------------------------------------------
// Internal SQL Helpers
// ---------------------------------------------------------------------------

function qIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function execSql(
  target: {
    query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
    execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  },
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof target.execute === 'function') {
    await target.execute(sql, params);
  } else if (typeof target.exec === 'function') {
    await target.exec(sql, params);
  } else {
    await target.query(sql, params);
  }
}

function readCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

function mapJobRow<TPayload = unknown>(raw: Record<string, unknown>): JobRecord<TPayload> {
  const payloadRaw = String(readCol(raw, 'PAYLOAD_JSON') ?? 'null');
  let payload: TPayload;
  try {
    payload = JSON.parse(payloadRaw) as TPayload;
  } catch {
    payload = payloadRaw as unknown as TPayload;
  }
  const leaseVal = readCol(raw, 'LEASE_UNTIL');
  const workerVal = readCol(raw, 'WORKER_ID');
  const dedupeVal = readCol(raw, 'DEDUPE_KEY');
  const errVal = readCol(raw, 'LAST_ERROR');
  const jobId = String(readCol(raw, 'JOB_ID') ?? '');
  return {
    id: jobId,
    jobId,
    queueName: String(readCol(raw, 'QUEUE_NAME') ?? ''),
    payload,
    status: String(readCol(raw, 'STATUS') ?? 'pending') as JobStatus,
    priority: Number(readCol(raw, 'PRIORITY') ?? 0),
    attempts: Number(readCol(raw, 'ATTEMPTS') ?? 0),
    maxAttempts: Number(readCol(raw, 'MAX_ATTEMPTS') ?? 3),
    runAt: Number(readCol(raw, 'RUN_AT') ?? 0),
    leaseUntil: leaseVal === null || leaseVal === undefined ? null : Number(leaseVal),
    workerId: workerVal === null || workerVal === undefined ? null : String(workerVal),
    dedupeKey: dedupeVal === null || dedupeVal === undefined ? null : String(dedupeVal),
    lastError: errVal === null || errVal === undefined ? null : String(errVal),
    createdAt: Number(readCol(raw, 'CREATED_AT') ?? 0),
    updatedAt: Number(readCol(raw, 'UPDATED_AT') ?? 0),
  };
}

let jobSeqCounter = 0;
function makeJobId(now: number): string {
  jobSeqCounter = (jobSeqCounter + 1) & 0xffffff;
  return `job_${now.toString(36)}_${jobSeqCounter.toString(36).padStart(4, '0')}`;
}

/**
 * Create a durable Firebird-backed transactional job queue, cron scheduler,
 * and checkpointed workflow runner (`M28 Item 1`).
 */
export function createJobQueue(
  db: JobQueueDatabaseExecutor,
  options: JobQueueOptions = {},
): JobQueueHandle {
  const queueTable = (options.queueTable ?? DEFAULT_JOB_QUEUE_TABLE).toUpperCase();
  const dlqTable = (options.dlqTable ?? DEFAULT_JOB_DLQ_TABLE).toUpperCase();
  const schedulesTable = (options.schedulesTable ?? DEFAULT_JOB_SCHEDULES_TABLE).toUpperCase();
  const workflowTable = (options.workflowTable ?? DEFAULT_WORKFLOW_STEPS_TABLE).toUpperCase();
  const wakeupEvent = options.wakeupEvent ?? DEFAULT_JOB_WAKEUP_EVENT;
  const defaultLeaseMs = Math.max(500, options.defaultLeaseMs ?? 30_000);
  const defaultMaxAttempts = Math.max(1, options.defaultMaxAttempts ?? 3);
  const defaultBackoffBaseMs = Math.max(50, options.backoffBaseMs ?? 500);
  const defaultMaxBackoffMs = Math.max(defaultBackoffBaseMs, options.maxBackoffMs ?? 60_000);
  const clock = options.now ?? (() => Date.now());

  let schemaInitPromise: Promise<void> | null = null;

  const ensureTableExists = async (relName: string, createDdl: string): Promise<void> => {
    const check = await db.query<{ CNT: number }>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [relName],
    );
    if (Number(readCol(check.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execSql(db, createDdl);
    }
  };

  const ensureSchema = (): Promise<void> => {
    if (!schemaInitPromise) {
      schemaInitPromise = (async () => {
        await ensureTableExists(
          queueTable,
          `CREATE TABLE ${qIdent(queueTable)} (
            JOB_ID VARCHAR(96) NOT NULL PRIMARY KEY,
            QUEUE_NAME VARCHAR(64) NOT NULL,
            PAYLOAD_JSON BLOB SUB_TYPE TEXT NOT NULL,
            STATUS VARCHAR(16) NOT NULL,
            PRIORITY INTEGER NOT NULL,
            ATTEMPTS INTEGER NOT NULL,
            MAX_ATTEMPTS INTEGER NOT NULL,
            RUN_AT BIGINT NOT NULL,
            LEASE_UNTIL BIGINT,
            WORKER_ID VARCHAR(64),
            DEDUPE_KEY VARCHAR(128),
            LAST_ERROR VARCHAR(1024),
            CREATED_AT BIGINT NOT NULL,
            UPDATED_AT BIGINT NOT NULL
          )`,
        );
        await ensureTableExists(
          dlqTable,
          `CREATE TABLE ${qIdent(dlqTable)} (
            JOB_ID VARCHAR(96) NOT NULL PRIMARY KEY,
            QUEUE_NAME VARCHAR(64) NOT NULL,
            PAYLOAD_JSON BLOB SUB_TYPE TEXT NOT NULL,
            ATTEMPTS INTEGER NOT NULL,
            ERROR_MESSAGE VARCHAR(1024),
            FAILED_AT BIGINT NOT NULL
          )`,
        );
        await ensureTableExists(
          schedulesTable,
          `CREATE TABLE ${qIdent(schedulesTable)} (
            SCHEDULE_ID VARCHAR(96) NOT NULL PRIMARY KEY,
            QUEUE_NAME VARCHAR(64) NOT NULL,
            CRON_EXPR VARCHAR(64) NOT NULL,
            PAYLOAD_JSON BLOB SUB_TYPE TEXT NOT NULL,
            NEXT_RUN_AT BIGINT NOT NULL,
            UPDATED_AT BIGINT NOT NULL
          )`,
        );
        await ensureTableExists(
          workflowTable,
          `CREATE TABLE ${qIdent(workflowTable)} (
            WORKFLOW_ID VARCHAR(128) NOT NULL,
            STEP_KEY VARCHAR(128) NOT NULL,
            STATUS VARCHAR(16) NOT NULL,
            RESULT_JSON BLOB SUB_TYPE TEXT,
            COMPLETED_AT BIGINT NOT NULL,
            PRIMARY KEY (WORKFLOW_ID, STEP_KEY)
          )`,
        );
      })();
    }
    return schemaInitPromise;
  };

  const runInTx = async <T>(
    fn: (tx: {
      query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
    }) => Promise<T>,
  ): Promise<T> => {
    if (typeof db.transaction === 'function') {
      return db.transaction((tx) => fn(tx));
    }
    return fn(db);
  };

  const enqueue: JobQueueHandle['enqueue'] = async <TPayload = unknown>(
    queueName: string,
    payload: TPayload,
    enqOpts: EnqueueJobOptions = {},
  ) => {
    await ensureSchema();
    const now = enqOpts.now ?? clock();
    const cleanQueue = queueName.trim() || 'default';
    const priority = Math.floor(enqOpts.priority ?? 0);
    const runAt = enqOpts.runAt ?? now + Math.max(0, enqOpts.delayMs ?? 0);
    const maxAttempts = Math.max(1, enqOpts.maxAttempts ?? defaultMaxAttempts);
    const dedupeKey = enqOpts.dedupeKey?.trim() || null;
    const payloadJson = JSON.stringify(payload ?? null);

    const outcome = await runInTx(async (tx) => {
      if (dedupeKey) {
        const existing = await tx.query<Record<string, unknown>>(
          `SELECT FIRST 1 * FROM ${qIdent(queueTable)}
           WHERE QUEUE_NAME = ? AND DEDUPE_KEY = ? AND STATUS IN ('pending', 'running')`,
          [cleanQueue, dedupeKey],
        );
        if (existing.rows.length > 0) {
          return {
            job: mapJobRow<TPayload>(existing.rows[0]!),
            deduplicated: true,
          };
        }
      }

      const jobId = enqOpts.jobId?.trim() || makeJobId(now);
      await execSql(
        tx,
        `INSERT INTO ${qIdent(queueTable)} (
          JOB_ID, QUEUE_NAME, PAYLOAD_JSON, STATUS, PRIORITY, ATTEMPTS, MAX_ATTEMPTS,
          RUN_AT, LEASE_UNTIL, WORKER_ID, DEDUPE_KEY, LAST_ERROR, CREATED_AT, UPDATED_AT
        ) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
        [jobId, cleanQueue, payloadJson, priority, maxAttempts, runAt, dedupeKey, now, now],
      );

      const created: JobRecord<TPayload> = {
        id: jobId,
        jobId,
        queueName: cleanQueue,
        payload,
        status: 'pending',
        priority,
        attempts: 0,
        maxAttempts,
        runAt,
        leaseUntil: null,
        workerId: null,
        dedupeKey,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      return { job: created, deduplicated: false };
    });

    if (!outcome.deduplicated && runAt <= now && typeof db.notify === 'function') {
      await db.notify(wakeupEvent).catch(() => undefined);
    }
    return outcome;
  };

  const claimNext: JobQueueHandle['claimNext'] = async <TPayload = unknown>(
    queueFilter?: string | readonly string[],
    claimOpts: { workerId?: string; leaseMs?: number; now?: number } = {},
  ) => {
    await ensureSchema();
    const now = claimOpts.now ?? clock();
    const workerId = claimOpts.workerId ?? 'worker-default';
    const leaseMs = Math.max(100, claimOpts.leaseMs ?? defaultLeaseMs);
    const leaseUntil = now + leaseMs;

    const queueNames =
      typeof queueFilter === 'string'
        ? [queueFilter]
        : Array.isArray(queueFilter)
          ? [...queueFilter]
          : [];

    return runInTx(async (tx) => {
      // Dead-letter any expired running jobs that have exhausted maxAttempts
      const expiredExhausted = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ${qIdent(queueTable)}
         WHERE STATUS = 'running' AND LEASE_UNTIL IS NOT NULL AND LEASE_UNTIL <= ? AND ATTEMPTS >= MAX_ATTEMPTS`,
        [now],
      );
      for (const expRow of expiredExhausted.rows) {
        const expJob = mapJobRow(expRow);
        await execSql(
          tx,
          `UPDATE ${qIdent(queueTable)} SET STATUS = 'dead', LEASE_UNTIL = NULL, LAST_ERROR = ?, UPDATED_AT = ? WHERE JOB_ID = ?`,
          ['Lease expired after maxAttempts', now, expJob.jobId],
        );
        await execSql(
          tx,
          `UPDATE OR INSERT INTO ${qIdent(dlqTable)} (JOB_ID, QUEUE_NAME, PAYLOAD_JSON, ATTEMPTS, ERROR_MESSAGE, FAILED_AT)
           VALUES (?, ?, ?, ?, ?, ?) MATCHING (JOB_ID)`,
          [
            expJob.jobId,
            expJob.queueName,
            JSON.stringify(expJob.payload ?? null),
            expJob.attempts,
            expJob.lastError ?? 'Lease expired after maxAttempts',
            now,
          ],
        );
      }

      const qClause =
        queueNames.length > 0
          ? `AND QUEUE_NAME IN (${queueNames.map(() => '?').join(', ')})`
          : '';
      const params: QueryParams = [now, now, ...queueNames];

      const cand = await tx.query<Record<string, unknown>>(
        `SELECT FIRST 1 * FROM ${qIdent(queueTable)}
         WHERE (
           (STATUS = 'pending' AND RUN_AT <= ?)
           OR (STATUS = 'running' AND LEASE_UNTIL IS NOT NULL AND LEASE_UNTIL <= ? AND ATTEMPTS < MAX_ATTEMPTS)
         ) ${qClause}
         ORDER BY PRIORITY DESC, RUN_AT ASC, CREATED_AT ASC`,
        params,
      );
      if (cand.rows.length === 0) return null;

      const picked = mapJobRow<TPayload>(cand.rows[0]!);
      const nextAttempts = picked.attempts + 1;
      await execSql(
        tx,
        `UPDATE ${qIdent(queueTable)}
         SET STATUS = 'running', ATTEMPTS = ?, LEASE_UNTIL = ?, WORKER_ID = ?, UPDATED_AT = ?
         WHERE JOB_ID = ?`,
        [nextAttempts, leaseUntil, workerId, now, picked.jobId],
      );

      return {
        ...picked,
        status: 'running',
        attempts: nextAttempts,
        leaseUntil,
        workerId,
        updatedAt: now,
      };
    });
  };

  const complete: JobQueueHandle['complete'] = async (jobId, compOpts = {}) => {
    await ensureSchema();
    const now = compOpts.now ?? clock();
    if (compOpts.deleteCompleted) {
      await execSql(db, `DELETE FROM ${qIdent(queueTable)} WHERE JOB_ID = ?`, [jobId]);
      return true;
    }
    await execSql(
      db,
      `UPDATE ${qIdent(queueTable)}
       SET STATUS = 'completed', LEASE_UNTIL = NULL, UPDATED_AT = ?
       WHERE JOB_ID = ?`,
      [now, jobId],
    );
    return true;
  };

  const fail: JobQueueHandle['fail'] = async (jobId, error, failOpts = {}) => {
    await ensureSchema();
    const now = failOpts.now ?? clock();
    const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const baseMs = failOpts.backoffBaseMs ?? defaultBackoffBaseMs;
    const maxMs = failOpts.maxBackoffMs ?? defaultMaxBackoffMs;

    return runInTx(async (tx) => {
      const res = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ${qIdent(queueTable)} WHERE JOB_ID = ?`,
        [jobId],
      );
      if (res.rows.length === 0) {
        return { status: 'dead' as const, nextRunAt: null };
      }
      const job = mapJobRow(res.rows[0]!);
      if (job.attempts >= job.maxAttempts) {
        await execSql(
          tx,
          `UPDATE ${qIdent(queueTable)}
           SET STATUS = 'dead', LEASE_UNTIL = NULL, LAST_ERROR = ?, UPDATED_AT = ?
           WHERE JOB_ID = ?`,
          [errMsg, now, jobId],
        );
        await execSql(
          tx,
          `UPDATE OR INSERT INTO ${qIdent(dlqTable)} (JOB_ID, QUEUE_NAME, PAYLOAD_JSON, ATTEMPTS, ERROR_MESSAGE, FAILED_AT)
           VALUES (?, ?, ?, ?, ?, ?) MATCHING (JOB_ID)`,
          [job.jobId, job.queueName, JSON.stringify(job.payload ?? null), job.attempts, errMsg, now],
        );
        return { status: 'dead' as const, nextRunAt: null };
      }

      const backoff = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, job.attempts - 1)));
      const nextRunAt = now + Math.floor(backoff);
      await execSql(
        tx,
        `UPDATE ${qIdent(queueTable)}
         SET STATUS = 'pending', RUN_AT = ?, LEASE_UNTIL = NULL, LAST_ERROR = ?, UPDATED_AT = ?
         WHERE JOB_ID = ?`,
        [nextRunAt, errMsg, now, jobId],
      );
      return { status: 'pending' as const, nextRunAt };
    });
  };

  const extendLease: JobQueueHandle['extendLease'] = async (jobId, extraMs, extOpts = {}) => {
    await ensureSchema();
    const now = extOpts.now ?? clock();
    const res = await db.query<Record<string, unknown>>(
      `SELECT LEASE_UNTIL FROM ${qIdent(queueTable)} WHERE JOB_ID = ? AND STATUS = 'running'`,
      [jobId],
    );
    if (res.rows.length === 0) return false;
    const base = Math.max(now, Number(readCol(res.rows[0]!, 'LEASE_UNTIL') ?? now));
    await execSql(
      db,
      `UPDATE ${qIdent(queueTable)} SET LEASE_UNTIL = ?, UPDATED_AT = ? WHERE JOB_ID = ?`,
      [base + Math.max(1, extraMs), now, jobId],
    );
    return true;
  };

  const schedule: JobQueueHandle['schedule'] = async (scheduleId, spec) => {
    await ensureSchema();
    const now = spec.now ?? clock();
    const parsed = parseCronExpression(spec.cron);
    const nextRunAt = nextCronRunAfter(parsed, now);
    await execSql(
      db,
      `UPDATE OR INSERT INTO ${qIdent(schedulesTable)} (
        SCHEDULE_ID, QUEUE_NAME, CRON_EXPR, PAYLOAD_JSON, NEXT_RUN_AT, UPDATED_AT
      ) VALUES (?, ?, ?, ?, ?, ?) MATCHING (SCHEDULE_ID)`,
      [
        scheduleId.trim(),
        spec.queueName.trim(),
        spec.cron.trim(),
        JSON.stringify(spec.payload ?? {}),
        nextRunAt,
        now,
      ],
    );
    return { scheduleId: scheduleId.trim(), nextRunAt };
  };

  const tickSchedules: JobQueueHandle['tickSchedules'] = async (explicitNow?: number) => {
    await ensureSchema();
    const now = explicitNow ?? clock();
    const due = await db.query<Record<string, unknown>>(
      `SELECT * FROM ${qIdent(schedulesTable)} WHERE NEXT_RUN_AT <= ?`,
      [now],
    );
    let enqueuedCount = 0;
    for (const row of due.rows) {
      const schedId = String(readCol(row, 'SCHEDULE_ID') ?? '');
      const qName = String(readCol(row, 'QUEUE_NAME') ?? 'default');
      const cronExpr = String(readCol(row, 'CRON_EXPR') ?? '@hourly');
      const rawPayload = String(readCol(row, 'PAYLOAD_JSON') ?? '{}');
      const dueAt = Number(readCol(row, 'NEXT_RUN_AT') ?? now);
      let payload: unknown = {};
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        payload = rawPayload;
      }
      const nextRunAt = nextCronRunAfter(cronExpr, Math.max(now, dueAt));
      await execSql(
        db,
        `UPDATE ${qIdent(schedulesTable)} SET NEXT_RUN_AT = ?, UPDATED_AT = ? WHERE SCHEDULE_ID = ?`,
        [nextRunAt, now, schedId],
      );
      const { deduplicated } = await enqueue(qName, payload, {
        dedupeKey: `sched:${schedId}:${dueAt}`,
        now,
      });
      if (!deduplicated) enqueuedCount++;
    }
    return enqueuedCount;
  };

  const processBatch: JobQueueHandle['processBatch'] = async (handlers, batchOpts = {}) => {
    await ensureSchema();
    const now = batchOpts.now;
    await tickSchedules(now);
    const queueNames = Object.keys(handlers);
    if (queueNames.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

    const maxJobs = Math.max(1, batchOpts.maxJobs ?? 25);
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < maxJobs; i++) {
      const job = await claimNext(queueNames, {
        workerId: batchOpts.workerId,
        leaseMs: batchOpts.leaseMs,
        now,
      });
      if (!job) break;
      processed++;
      const handler = handlers[job.queueName];
      if (!handler) {
        await fail(job.jobId, new Error(`No handler registered for queue "${job.queueName}"`), {
          now,
        });
        failed++;
        continue;
      }
      try {
        await handler(job);
        await complete(job.jobId, { now });
        succeeded++;
      } catch (err) {
        await fail(job.jobId, err, { now });
        failed++;
      }
    }
    return { processed, succeeded, failed };
  };

  const startWorker: JobQueueHandle['startWorker'] = async (handlers, workerOpts = {}) => {
    await ensureSchema();
    const pollIntervalMs = Math.max(25, workerOpts.pollIntervalMs ?? 250);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let runningPump = false;
    let wakeQueued = false;

    const pump = async (): Promise<void> => {
      if (stopped) return;
      if (runningPump) {
        wakeQueued = true;
        return;
      }
      runningPump = true;
      try {
        do {
          wakeQueued = false;
          await processBatch(handlers, {
            workerId: workerOpts.workerId,
            leaseMs: workerOpts.leaseMs,
          });
        } while (wakeQueued && !stopped);
      } finally {
        runningPump = false;
        if (!stopped) {
          timer = setTimeout(() => void pump(), pollIntervalMs);
        }
      }
    };

    const sub =
      typeof db.listen === 'function'
        ? await db
            .listen(wakeupEvent, () => {
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              void pump();
            })
            .catch(() => null)
        : null;

    void pump();

    return {
      async stop(): Promise<void> {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (sub) {
          await sub.unsubscribe().catch(() => undefined);
        }
      },
    };
  };

  const runWorkflow: JobQueueHandle['runWorkflow'] = async <T>(
    workflowId: string,
    fn: (step: WorkflowStepRunner) => Promise<T>,
  ) => {
    await ensureSchema();
    const cleanWfId = workflowId.trim();
    if (!cleanWfId) throw new Error('workflowId must not be empty');
    let executedSteps = 0;
    let replayedSteps = 0;

    const stepRunner: WorkflowStepRunner = {
      async run<R>(stepKey: string, stepFn: () => Promise<R> | R): Promise<R> {
        const cleanKey = stepKey.trim();
        const existing = await db.query<Record<string, unknown>>(
          `SELECT STATUS, RESULT_JSON FROM ${qIdent(workflowTable)}
           WHERE WORKFLOW_ID = ? AND STEP_KEY = ?`,
          [cleanWfId, cleanKey],
        );
        if (
          existing.rows.length > 0 &&
          String(readCol(existing.rows[0]!, 'STATUS')) === 'completed'
        ) {
          replayedSteps++;
          const rawJson = String(readCol(existing.rows[0]!, 'RESULT_JSON') ?? 'null');
          return JSON.parse(rawJson) as R;
        }

        const out = await stepFn();
        executedSteps++;
        await execSql(
          db,
          `UPDATE OR INSERT INTO ${qIdent(workflowTable)} (
            WORKFLOW_ID, STEP_KEY, STATUS, RESULT_JSON, COMPLETED_AT
          ) VALUES (?, ?, 'completed', ?, ?) MATCHING (WORKFLOW_ID, STEP_KEY)`,
          [cleanWfId, cleanKey, JSON.stringify(out === undefined ? null : out), clock()],
        );
        return out;
      },
    };

    const result = await fn(stepRunner);
    return { result, executedSteps, replayedSteps };
  };

  const stats: JobQueueHandle['stats'] = async () => {
    await ensureSchema();
    const [statusRows, dlqRes, schedRes] = await Promise.all([
      db.query<Record<string, unknown>>(
        `SELECT STATUS, COUNT(*) AS CNT FROM ${qIdent(queueTable)} GROUP BY STATUS`,
      ),
      db.query<Record<string, unknown>>(`SELECT COUNT(*) AS CNT FROM ${qIdent(dlqTable)}`),
      db.query<Record<string, unknown>>(`SELECT COUNT(*) AS CNT FROM ${qIdent(schedulesTable)}`),
    ]);
    const counts: Record<string, number> = {};
    for (const r of statusRows.rows) {
      counts[String(readCol(r, 'STATUS') ?? '')] = Number(readCol(r, 'CNT') ?? 0);
    }
    return {
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      completed: counts.completed ?? 0,
      dead: counts.dead ?? 0,
      dlqCount: Number(readCol(dlqRes.rows[0] ?? {}, 'CNT') ?? 0),
      schedulesCount: Number(readCol(schedRes.rows[0] ?? {}, 'CNT') ?? 0),
    };
  };

  const listDlq: JobQueueHandle['listDlq'] = async <TPayload = unknown>() => {
    await ensureSchema();
    const res = await db.query<Record<string, unknown>>(
      `SELECT * FROM ${qIdent(dlqTable)} ORDER BY FAILED_AT DESC`,
    );
    return res.rows.map((r) => {
      const rawJson = String(readCol(r, 'PAYLOAD_JSON') ?? 'null');
      let payload: TPayload;
      try {
        payload = JSON.parse(rawJson) as TPayload;
      } catch {
        payload = rawJson as unknown as TPayload;
      }
      const errVal = readCol(r, 'ERROR_MESSAGE');
      const errStr = errVal === null || errVal === undefined ? null : String(errVal);
      const jId = String(readCol(r, 'JOB_ID') ?? '');
      return {
        id: jId,
        jobId: jId,
        queueName: String(readCol(r, 'QUEUE_NAME') ?? ''),
        payload,
        attempts: Number(readCol(r, 'ATTEMPTS') ?? 0),
        error: errStr,
        errorMessage: errStr,
        failedAt: Number(readCol(r, 'FAILED_AT') ?? 0),
      };
    });
  };

  return {
    queueTable,
    enqueue,
    claimNext,
    complete,
    fail,
    extendLease,
    schedule,
    tickSchedules,
    processBatch,
    startWorker,
    runWorkflow,
    stats,
    listDlq,
  };
}
