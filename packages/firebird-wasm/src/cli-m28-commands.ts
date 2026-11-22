/**
 * cli-m28-commands.ts – CLI Subcommands for Durable Job Queue Worker (`worker`),
 * Online Schema Migrations (`migrate-online`), and Adaptive Workload Advisor (`advise`)
 * (`M28 Items 1, 3 & 4`).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FirebirdDatabase } from './database-core';
import type { FieldInfo, Row } from './types';
import { createJobQueue } from './job-queue';
import {
  createOnlineMigrator,
  type OnlineMigrationPlan,
} from './online-migrator';
import { createWorkloadAdvisor } from './workload-advisor';
import {
  createChangeStreamSink,
  createHttpWebhookSink,
  type CdcDeliveryFormat,
} from './cdc-sink';

export interface CliM28Context {
  positional: readonly string[];
  flags: Map<string, string | boolean>;
  cwd: string;
  backend?: 'auto' | 'wasm' | 'native';
  out: (text: string) => void;
  err: (text: string) => void;
  formatCliTable: (fields: readonly FieldInfo[], rows: readonly Row[]) => string;
  openCliDatabase: (
    uri: string,
    opts: { cwd: string; backend?: 'auto' | 'wasm' | 'native'; allowMissing?: boolean },
  ) => Promise<{
    readonly db: FirebirdDatabase;
    flushAndClose(persistChanges: boolean): Promise<void>;
  }>;
}

export async function runCliWorker(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, openCliDatabase } = ctx;
  const uri = positional[1] ?? 'memory://worker';
  const maxJobs =
    typeof flags.get('max-jobs') === 'string' ? Number(flags.get('max-jobs')) : 25;
  const sqlQueue =
    typeof flags.get('queue') === 'string' ? String(flags.get('queue')) : 'sql';

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: true });
  try {
    const queue = createJobQueue(managed.db);
    const batchRes = await queue.processBatch(
      {
        [sqlQueue]: async (job) => {
          const payload = (job.payload ?? {}) as { sql?: string; params?: unknown[] };
          if (typeof payload.sql === 'string' && payload.sql.trim()) {
            await managed.db.execute(payload.sql, (payload.params ?? []) as never[]);
          }
        },
      },
      { maxJobs, workerId: 'cli-worker' },
    );
    const st = await queue.stats();
    if (flags.get('json') === true) {
      out(`${JSON.stringify({ ...batchRes, stats: st }, null, 2)}\n`);
    } else {
      out(
        `Processed ${batchRes.processed} job(s) (${batchRes.succeeded} succeeded, ${batchRes.failed} failed · pending=${st.pending}, dlq=${st.dlqCount})\n`,
      );
    }
    return 0;
  } finally {
    await managed.flushAndClose(true);
  }
}

export async function runCliMigrateOnline(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  const planArg = flags.get('plan');
  if (!uri || typeof planArg !== 'string' || !planArg.trim()) {
    err(
      'Usage: firebird-wasm migrate-online <uri> --plan <plan.json | inlineJson> [--batch-size <n>] [--drop-source] [--json]\n',
    );
    return 1;
  }

  let plan: OnlineMigrationPlan;
  const trimmed = planArg.trim();
  if (trimmed.startsWith('{')) {
    plan = JSON.parse(trimmed) as OnlineMigrationPlan;
  } else {
    const absPlan = path.resolve(cwd, trimmed);
    if (!fs.existsSync(absPlan)) {
      err(`Online migration plan file not found: ${absPlan}\n`);
      return 1;
    }
    plan = JSON.parse(fs.readFileSync(absPlan, 'utf8')) as OnlineMigrationPlan;
  }

  const batchSize =
    typeof flags.get('batch-size') === 'string' ? Number(flags.get('batch-size')) : 200;
  const dropSourceColumns = flags.get('drop-source') === true;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  try {
    const migrator = createOnlineMigrator(managed.db, plan);
    const res = await migrator.runAll({ batchSize, dropSourceColumns });
    if (flags.get('json') === true) {
      out(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      out(
        `Online migration "${plan.id}" contracted on ${plan.table}: backfilled ${res.backfill.rowsUpdated} row(s), parity=${res.parity.valid}, dropped=[${res.droppedColumns.join(', ')}]\n`,
      );
    }
    return 0;
  } finally {
    await managed.flushAndClose(true);
  }
}

export async function runCliAdvise(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, formatCliTable, openCliDatabase } = ctx;
  const uri = positional[1] ?? 'memory://advise';
  const rawSqlFlag = flags.get('sql') ?? flags.get('query');
  const sqlArg = typeof rawSqlFlag === 'string' ? rawSqlFlag : undefined;
  const applyFlag = flags.get('apply') === true;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  try {
    const advisor = createWorkloadAdvisor(managed.db, { captureLiveQueries: false });
    const extraQueries = sqlArg
      ? sqlArg
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const report = await advisor.analyze(extraQueries);
    let appliedCount = 0;
    if (applyFlag && report.recommendations.length > 0) {
      const applied = await advisor.applyRecommendations();
      appliedCount = applied.statements.length;
    }
    advisor.dispose();

    if (flags.get('json') === true) {
      out(`${JSON.stringify({ ...report, appliedCount }, null, 2)}\n`);
      return 0;
    }
    if (report.recommendations.length === 0) {
      out('No index or schema recommendations found (0 issues).\n');
      return 0;
    }
    const rows: Row[] = report.recommendations.map((r) => ({
      SEVERITY: r.severity.toUpperCase(),
      KIND: r.kind,
      TABLE: r.table,
      SQL: r.sql,
    }));
    out(formatCliTable([], rows));
    return 0;
  } finally {
    await managed.flushAndClose(applyFlag);
  }
}

export async function runCliCdcSink(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  const webhookUrl = flags.get('webhook') ?? flags.get('url');
  if (!uri || typeof webhookUrl !== 'string' || !webhookUrl.trim()) {
    err(
      'Usage: firebird-wasm cdc-sink <uri> --webhook <url> [--secret <hmacKey>] [--sink-id <id>] [--format cloudevents-json|cloudevents-ndjson|arrow-ipc] [--batch-size <n>] [--json]\n',
    );
    return 1;
  }
  const sinkId =
    typeof flags.get('sink-id') === 'string' ? String(flags.get('sink-id')) : 'cli-cdc';
  const secret =
    typeof flags.get('secret') === 'string' ? String(flags.get('secret')) : undefined;
  const fmtRaw = String(flags.get('format') ?? 'cloudevents-json').toLowerCase();
  const format: CdcDeliveryFormat =
    fmtRaw === 'cloudevents-ndjson' || fmtRaw === 'arrow-ipc' ? fmtRaw : 'cloudevents-json';
  const batchSize =
    typeof flags.get('batch-size') === 'string' ? Number(flags.get('batch-size')) : 100;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  try {
    const sink = createChangeStreamSink(managed.db, {
      sinkId,
      batchSize,
      sink: createHttpWebhookSink({ url: webhookUrl.trim(), secret, format }),
    });
    const res = await sink.flushOnce();
    const offset = await sink.getOffset();
    if (flags.get('json') === true) {
      out(`${JSON.stringify({ ...res, offset, sinkId, format }, null, 2)}\n`);
    } else {
      out(
        `CDC sink "${sinkId}" flushed ${res.deliveredEvents} event(s) (offset=${offset}, quarantined=${res.quarantined})\n`,
      );
    }
    return 0;
  } finally {
    await managed.flushAndClose(true);
  }
}
