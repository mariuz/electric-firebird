/**
 * repl-presence-audit.ts – Collaborative Presence Peer Badges, `"FB_AUDIT_LOG$"`
 * Hash-Chain Verification & Diagnostic Runner Helpers for `<firebird-repl>` (`M26 Item 5`).
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
import type { ReplicationStats } from '../replication';
import type { PresenceRoom } from '../replication/presence';
import type { Row } from '../types';
import { asError, el } from './repl-styles';
import type { ReplDatabase, ReplEntry } from './index';

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

export function appendMcpAndPrometheusSections(
  panel: HTMLElement,
  opts: {
    mcpTools?: readonly McpToolDescriptor[];
    prometheusText?: string | null;
    onExportPrometheus?: () => void;
  },
): void {
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
  return verifyAuditChain(
    {
      query: async <T extends Row = Row>(sqlText: string, params: unknown[] = []) => {
        const res = await db.query(sqlText, params, { rowMode: 'array' });
        const rows = res.rows.map((cols) =>
          Object.fromEntries(res.fields.map((f, idx) => [f.name, cols[idx]])),
        ) as unknown as T[];
        return { fields: res.fields, rows };
      },
    },
    options,
  );
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
