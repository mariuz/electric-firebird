/**
 * repl-presence-audit.ts – Collaborative Presence Peer Badges, `"FB_AUDIT_LOG$"`
 * Hash-Chain Verification, MCP/Prometheus, Adaptive Index Advisor & Job Queue
 * Helpers for `<firebird-repl>` (`M26`–`M28`).
 */

import {
  verifyAuditChain,
  type AuditChainVerificationResult,
  type AuditSignAlgorithm,
} from '../audit-log';
import {
  createFirebirdMcpServer,
  type McpToolDescriptor,
} from '../mcp-server';
import { formatPrometheusMetrics } from '../otel-metrics';
import {
  createWorkloadAdvisor,
  type WorkloadAdvisorReport,
} from '../workload-advisor';
import {
  DEFAULT_JOB_QUEUE_TABLE,
  createJobQueue,
  type JobQueueStats,
} from '../job-queue';
import type { ReplicationStats } from '../replication';
import type { PresenceRoom } from '../replication/presence';
import type { Row } from '../types';
import { asError, el } from './repl-styles';
import type { ReplDatabase, ReplEntry } from './repl-types';

function createReplObjectQueryAdapter(db: ReplDatabase) {
  return {
    query: async <T extends Row = Row>(sqlText: string, params: unknown[] = []) => {
      const res = await db.query(sqlText, params, { rowMode: 'array' });
      const rows = res.rows.map((cols) =>
        Object.fromEntries(res.fields.map((f, idx) => [f.name, cols[idx]])),
      ) as unknown as T[];
      return { fields: res.fields, rows };
    },
    ...(typeof db.explain === 'function'
      ? { explain: (s: string, o?: { detailed?: boolean }) => db.explain!(s, o) }
      : {}),
    ...(typeof db.introspect === 'function'
      ? { introspect: () => db.introspect!() }
      : {}),
    ...(typeof db.monitorStats === 'function'
      ? { monitorStats: () => db.monitorStats!() }
      : {}),
  };
}

export function getReplMcpTools(
  db: ReplDatabase | null,
  allowWrites = false,
): McpToolDescriptor[] {
  const srv = createFirebirdMcpServer(
    {
      query: async <T extends Row = Row>(sqlText: string, params: unknown[] = []) => {
        if (!db) return { fields: [], rows: [] as T[] };
        const res = await db.query(sqlText, params, { rowMode: 'array' });
        const rows = res.rows.map((cols) =>
          Object.fromEntries(res.fields.map((f, idx) => [f.name, cols[idx]])),
        ) as unknown as T[];
        return { fields: res.fields, rows };
      },
    },
    { allowWrites },
  );
  return srv.listTools();
}

export async function exportReplPrometheusMetrics(
  db: ReplDatabase | null,
  replicator?: { stats(): Promise<ReplicationStats> } | null,
): Promise<string> {
  const [monitor, dbInfo, replication] = await Promise.all([
    db?.monitorStats ? db.monitorStats().catch(() => null) : null,
    db?.databaseInfo ? db.databaseInfo().catch(() => null) : null,
    replicator ? replicator.stats().catch(() => null) : null,
  ]);
  return formatPrometheusMetrics({ monitor, dbInfo, replication });
}

export async function executeReplWorkloadAdvisor(
  db: ReplDatabase,
  extraQueries: readonly string[] = [],
): Promise<WorkloadAdvisorReport> {
  const adapter = createReplObjectQueryAdapter(db);
  const advisor = createWorkloadAdvisor(adapter, { captureLiveQueries: false });
  try {
    return await advisor.analyze(extraQueries);
  } finally {
    advisor.dispose();
  }
}

export async function fetchReplJobQueueStats(
  db: ReplDatabase,
): Promise<JobQueueStats> {
  try {
    const check = await db.query(
      `SELECT 1 FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [DEFAULT_JOB_QUEUE_TABLE],
      { rowMode: 'array' },
    );
    if (check.rows.length === 0) {
      return {
        pending: 0,
        running: 0,
        completed: 0,
        dead: 0,
        dlqCount: 0,
        schedulesCount: 0,
      };
    }
    const queue = createJobQueue(createReplObjectQueryAdapter(db));
    return await queue.stats();
  } catch {
    return {
      pending: 0,
      running: 0,
      completed: 0,
      dead: 0,
      dlqCount: 0,
      schedulesCount: 0,
    };
  }
}

export function appendMcpAndPrometheusSections(
  panel: HTMLElement,
  opts: {
    mcpTools?: readonly McpToolDescriptor[];
    prometheusText?: string | null;
    onExportPrometheus?: () => void;
    advisorReport?: WorkloadAdvisorReport | null;
    onRunAdvisor?: () => void;
    onLoadAdvisorSql?: (ddl: string) => void;
    jobQueueStats?: JobQueueStats | null;
  },
): void {
  if (opts.onRunAdvisor || opts.advisorReport) {
    const advBox = el('div', 'schema-sub workload-advisor-panel');
    const title = el('div', 'schema-group-title');
    title.textContent = 'Adaptive Index & Workload Advisor';
    advBox.append(title);
    if (opts.onRunAdvisor) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'advisor-run-btn';
      btn.textContent = 'Run Index Advisor';
      btn.addEventListener('click', () => opts.onRunAdvisor?.());
      advBox.append(btn);
    }
    if (opts.advisorReport) {
      const recs = opts.advisorReport.recommendations;
      const summary = el('p', 'inspector-summary workload-advisor-summary');
      summary.textContent =
        recs.length === 0
          ? `0 index issues across ${opts.advisorReport.analyzedQueries} analyzed query(s).`
          : `${recs.length} recommendation(s) across ${opts.advisorReport.analyzedQueries} query(s):`;
      advBox.append(summary);
      if (recs.length > 0) {
        const ddlScript = recs.map((r) => `-- [${r.severity.toUpperCase()}] ${r.kind}: ${r.rationale}\n${r.sql}`).join('\n');
        const pre = el('pre', 'schema-view-source workload-advisor-output');
        pre.textContent = ddlScript;
        advBox.append(pre);
        if (opts.onLoadAdvisorSql) {
          const loadBtn = document.createElement('button');
          loadBtn.type = 'button';
          loadBtn.className = 'advisor-load-ddl-btn';
          loadBtn.textContent = 'Load Recommended DDL in Editor';
          const rawDdl = recs.map((r) => r.sql).join('\n');
          loadBtn.addEventListener('click', () => opts.onLoadAdvisorSql?.(rawDdl));
          advBox.append(loadBtn);
        }
      }
    }
    panel.append(advBox);
  }

  if (opts.jobQueueStats) {
    const jq = opts.jobQueueStats;
    const jqBox = el('div', 'schema-sub job-queue-panel');
    const title = el('div', 'schema-group-title');
    title.textContent = 'Durable Job Queue (FB_JOB_QUEUE$)';
    jqBox.append(title);
    const summary = el('p', 'inspector-summary job-queue-summary');
    summary.textContent =
      `pending: ${jq.pending} · running: ${jq.running} · completed: ${jq.completed} · ` +
      `dead: ${jq.dead} · DLQ: ${jq.dlqCount} · cron: ${jq.schedulesCount}`;
    jqBox.append(summary);
    panel.append(jqBox);
  }

  if (opts.mcpTools && opts.mcpTools.length > 0) {
    const mcpBox = el('div', 'schema-sub mcp-tools-panel');
    const title = el('div', 'schema-group-title');
    title.textContent = `MCP Agent Tools (${opts.mcpTools.length} active · firebird://schema, firebird://audit/head)`;
    mcpBox.append(title);
    const badgeWrap = el('div', 'schema-sub mcp-tool-badges');
    for (const t of opts.mcpTools) {
      const b = el('span', 'schema-badge mcp-tool-badge');
      b.textContent = t.name;
      b.title = t.description;
      badgeWrap.append(b);
    }
    mcpBox.append(badgeWrap);
    panel.append(mcpBox);
  }

  if (opts.onExportPrometheus || opts.prometheusText) {
    const promBox = el('div', 'schema-sub otel-prometheus-panel');
    const title = el('div', 'schema-group-title');
    title.textContent = 'OpenTelemetry & Prometheus /metrics';
    promBox.append(title);
    if (opts.onExportPrometheus) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prometheus-export-btn';
      btn.textContent = 'Export /metrics';
      btn.addEventListener('click', () => opts.onExportPrometheus?.());
      promBox.append(btn);
    }
    if (opts.prometheusText) {
      const pre = el('pre', 'schema-view-source prometheus-metrics-output');
      pre.textContent = opts.prometheusText;
      promBox.append(pre);
    }
    panel.append(promBox);
  }
}

export async function executeReplVerifyAuditChain(
  db: ReplDatabase,
  options: {
    tableName?: string;
    verifyKey?: CryptoKey | string | Uint8Array;
    signAlgorithm?: AuditSignAlgorithm;
  } = {},
): Promise<AuditChainVerificationResult> {
  return verifyAuditChain(createReplObjectQueryAdapter(db), options);
}

export function appendPresenceAndAuditSections(
  panel: HTMLElement,
  opts: {
    presenceRoom?: PresenceRoom | null;
    lastAuditReport?: AuditChainVerificationResult | null;
    onVerifyAudit?: () => void;
  },
): void {
  if (opts.presenceRoom) {
    const snap = opts.presenceRoom.getSnapshot();
    const box = el('div', 'schema-sub presence-awareness-panel');
    const title = el('div', 'schema-group-title');
    title.textContent = `Collaborative Presence (${snap.onlineCount} online · room "${snap.roomId}")`;
    box.append(title);

    const badgeWrap = el('div', 'schema-sub presence-badges');
    const allPeers = [snap.self, ...snap.peers];
    for (const p of allPeers) {
      const badge = el('span', 'schema-badge presence-peer-badge');
      const stateObj = (p.state ?? {}) as Record<string, unknown>;
      const displayName =
        typeof stateObj.name === 'string' && stateObj.name.trim()
          ? `${stateObj.name} (${p.peerId})`
          : p.peerId;
      const cursorInfo = p.cursor?.table
        ? ` @ ${p.cursor.table}${p.cursor.rowKey != null ? `#${String(p.cursor.rowKey)}` : ''}${p.cursor.column ? `.${p.cursor.column}` : ''}`
        : '';
      const typingInfo = p.typing ? ' · typing…' : '';
      const selfTag = p.peerId === snap.self.peerId ? ' [you]' : '';
      badge.textContent = `${displayName}${selfTag}${cursorInfo}${typingInfo}`;
      badgeWrap.append(badge);
    }
    box.append(badgeWrap);
    panel.append(box);
  }

  if (opts.onVerifyAudit || opts.lastAuditReport) {
    const auditBox = el('div', 'schema-sub audit-chain-panel');
    const title = el('div', 'schema-group-title');
    title.textContent = 'Cryptographic Audit Chain (FB_AUDIT_LOG$)';
    auditBox.append(title);

    if (opts.onVerifyAudit) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'audit-verify-btn';
      btn.textContent = 'Verify Audit Chain';
      btn.addEventListener('click', () => opts.onVerifyAudit?.());
      auditBox.append(btn);
    }

    if (opts.lastAuditReport) {
      const r = opts.lastAuditReport;
      const statusEl = el('p', 'inspector-summary audit-chain-status');
      if (r.valid) {
        statusEl.textContent =
          `VALID · ${r.checkedCount} ${r.checkedCount === 1 ? 'record' : 'records'} · ` +
          `head: ${r.headHash ? r.headHash.slice(0, 12) + '…' : 'empty'} · ` +
          `merkle: ${r.merkleRoot ? r.merkleRoot.slice(0, 12) + '…' : 'empty'}`;
      } else {
        statusEl.textContent =
          `TAMPERED at SEQ #${r.tamperedAtSeq ?? '?'} · ${r.reason ?? 'hash mismatch'}`;
      }
      auditBox.append(statusEl);
    }
    panel.append(auditBox);
  }
}

export async function runReplBusyDiagnostic(ctx: {
  isBusy: () => boolean;
  setBusy: (b: boolean) => void;
  sqlLabel: string;
  eventName: string;
  guardError?: Error | null;
  execute: (entry: ReplEntry) => Promise<void>;
  show: (entry: ReplEntry) => void;
  dispatch: (ev: CustomEvent) => void;
}): Promise<ReplEntry | undefined> {
  if (ctx.isBusy()) return undefined;
  if (ctx.guardError) {
    const errEntry: ReplEntry = {
      sql: ctx.sqlLabel,
      line: 1,
      ms: 0,
      error: ctx.guardError,
    };
    ctx.show(errEntry);
    return errEntry;
  }

  ctx.setBusy(true);
  const started = performance.now();
  const entry: ReplEntry = { sql: ctx.sqlLabel, line: 1, ms: 0 };
  try {
    await ctx.execute(entry);
  } catch (err) {
    entry.error = asError(err);
  } finally {
    entry.ms = performance.now() - started;
    ctx.setBusy(false);
  }
  ctx.show(entry);
  ctx.dispatch(
    new CustomEvent(ctx.eventName, {
      detail: entry,
      bubbles: true,
      composed: true,
    }),
  );
  return entry;
}
