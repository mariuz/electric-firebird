/**
 * repl-inspectors.ts – Catalog/telemetry fetchers & Inspector DOM renderers
 * for `<firebird-repl>` (`M21 Item 5`).
 */

import { computeTableIoBreakdown, type ParsedQueryPlan } from './plan-tree';
import type {
  AppliedMigration,
  MonitorStats,
  SchemaIntrospection,
} from '../types';
import type { OptimisticMutationStore } from '../optimistic-store';
import type { UndoRedoSnapshot } from '../undo-redo';
import type { MaterializedViewInfo } from '../materialized-view';
import type { SchemaSyncResult } from '../schema-sync';
import type { AuditChainVerificationResult } from '../audit-log';
import type { McpToolDescriptor } from '../mcp-server';
import type { PresenceRoom } from '../replication/presence';
import type { WorkloadAdvisorReport } from '../workload-advisor';
import type { JobQueueStats } from '../job-queue';
import type { ReplSearchIndexSummary } from './repl-actions';
import {
  appendMcpAndPrometheusSections,
  appendPresenceAndAuditSections,
  appendSpatialAndTimeSeriesSections,
} from './repl-presence-audit';
import {
  fetchReplArrowInspector,
  fetchReplMaterializedViews,
  renderArrowInspectorPanel,
  renderMigrationsInspectorPanel,
  renderOutboxInspectorPanel,
  renderPlanExplorerPanel,
  renderPlanTreeNode,
} from './repl-panel-renderers';
import { el } from './repl-styles';
import {
  fetchReplMigrations,
  fetchReplReplication,
  fetchReplSchema,
  fetchReplStats,
} from './repl-fetchers';

export {
  fetchReplArrowInspector,
  fetchReplMaterializedViews,
  fetchReplMigrations,
  fetchReplReplication,
  fetchReplSchema,
  fetchReplStats,
  renderArrowInspectorPanel,
  renderMigrationsInspectorPanel,
  renderOutboxInspectorPanel,
  renderPlanExplorerPanel,
  renderPlanTreeNode,
};
import type {
  EventProjectionStatus,
  JsonGinIndexInfo,
  ReplArrowInspectorInfo,
  ReplDatabase,
  ReplInspectorTab,
  ReplReplicationInfo,
  ReplSpatialIndexSummary,
  TemporalTableInfo,
  TimeSeriesPolicyInfo,
  TrigramIndexInfo,
} from './repl-types';

export interface ReplInspectorRenderContext {
  readonly db: ReplDatabase | null;
  readonly inspectorBody: HTMLDivElement;
  readonly editor: HTMLTextAreaElement;
  readonly activeTab: ReplInspectorTab;
  readonly lastSchema: SchemaIntrospection | null;
  readonly lastMatViews?: readonly MaterializedViewInfo[];
  readonly lastSearchIndexes?: readonly ReplSearchIndexSummary[];
  readonly lastSpatialIndexes?: readonly ReplSpatialIndexSummary[];
  readonly lastTimeSeriesPolicies?: readonly TimeSeriesPolicyInfo[];
  readonly lastTemporalTables?: readonly TemporalTableInfo[];
  readonly lastEventProjections?: readonly EventProjectionStatus[];
  readonly lastJsonGinIndexes?: readonly JsonGinIndexInfo[];
  readonly lastTrigramIndexes?: readonly TrigramIndexInfo[];
  readonly lastSchemaDiff?: SchemaSyncResult | null;
  readonly schemaDiffDraft?: string;
  readonly lastMigrations: AppliedMigration[];
  readonly lastStats: MonitorStats | null;
  readonly lastPlans: ReadonlyArray<{ sql: string; parsed: ParsedQueryPlan }>;
  readonly lastReplication: ReplReplicationInfo | null;
  readonly lastArrow: ReplArrowInspectorInfo | null;
  readonly optimisticStore?: OptimisticMutationStore | null;
  readonly undoRedoSnapshot?: UndoRedoSnapshot | null;
  readonly presenceRoom?: PresenceRoom | null;
  readonly lastAuditReport?: AuditChainVerificationResult | null;
  readonly mcpTools?: readonly McpToolDescriptor[];
  readonly lastPrometheusText?: string | null;
  readonly lastAdvisorReport?: WorkloadAdvisorReport | null;
  readonly lastJobQueueStats?: JobQueueStats | null;
  readonly onResetProfiler: () => void;
  readonly onVerifyAudit?: () => void;
  readonly onExportPrometheus?: () => void;
  readonly onRunAdvisor?: () => void;
  readonly onLoadAdvisorSql?: (ddl: string) => void;
  readonly onExportArrow?: () => void;
  readonly onImportArrowFile?: (fileName: string, bytes: Uint8Array) => void;
  readonly onFlushOutbox?: () => void;
  readonly onRevertMutation?: (id: string) => void;
  readonly onRevertAllOutbox?: () => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly onRefreshMaterializedView?: (name: string) => void;
  readonly onPreviewSchemaDiff?: (ddlSql: string) => void;
  readonly onApplySchemaPush?: (ddlSql: string) => void;
}

export function renderReplInspector(ctx: ReplInspectorRenderContext): void {
  ctx.inspectorBody.replaceChildren();
  if (!ctx.db) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No database connected.';
        ctx.inspectorBody.append(empty);
        return;
      }

      if (ctx.activeTab === 'plan') {
        ctx.inspectorBody.append(renderPlanExplorerPanel(ctx.lastPlans));
        return;
      }

      if (ctx.activeTab === 'arrow') {
        ctx.inspectorBody.append(
          renderArrowInspectorPanel(
            ctx.lastArrow,
            ctx.onExportArrow,
            ctx.onImportArrowFile,
          ),
        );
        return;
      }

      if (ctx.activeTab === 'outbox') {
        ctx.inspectorBody.append(
          renderOutboxInspectorPanel(
            ctx.optimisticStore ? ctx.optimisticStore.getSnapshot() : null,
            ctx.undoRedoSnapshot ?? null,
            ctx.onFlushOutbox,
            ctx.onRevertMutation,
            ctx.onRevertAllOutbox,
            ctx.onUndo,
            ctx.onRedo,
          ),
        );
        return;
      }

      if (ctx.activeTab === 'profiler') {
        const panel = el('div', 'inspector-profiler');
        const stats = ctx.lastStats;
        if (!stats) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No profiler telemetry available.';
          panel.append(empty);
          appendMcpAndPrometheusSections(panel, {
            mcpTools: ctx.mcpTools,
            prometheusText: ctx.lastPrometheusText,
            onExportPrometheus: ctx.onExportPrometheus,
          });
          ctx.inspectorBody.append(panel);
          return;
        }

        const totalStmts = stats.totalQueries + stats.totalExecs;
        const hitPct = (stats.prepareCacheHitRate * 100).toFixed(1);
        const totalCache = stats.prepareCacheHits + stats.prepareCacheMisses;
        const summaryEl = el('p', 'inspector-summary');
        summaryEl.textContent =
          `${totalStmts} ${totalStmts === 1 ? 'query' : 'queries'} · ` +
          `avg ${stats.avgDurationMs.toFixed(1)} ms · ` +
          `cache ${hitPct}% (${stats.prepareCacheHits}/${totalCache})`;
        panel.append(summaryEl);

        const ioDiv = el('div', 'schema-sub');
        const ioLabel = el('span', 'schema-sub-label');
        ioLabel.textContent = 'Engine & Page I/O:';
        ioDiv.append(ioLabel);
        const ioList = el('ul', 'schema-list profiler-metrics');
        const metrics: Array<[string, string]> = [
          ['Page reads / writes', `${stats.io.reads} / ${stats.io.writes}`],
          ['Page fetches / marks', `${stats.io.fetches} / ${stats.io.marks}`],
          [
            'Transaction gap (OIT → Next)',
            `${stats.transactions.transactionGap} (${stats.transactions.oldestTransaction} → ${stats.transactions.nextTransaction})`,
          ],
          [
            'Memory (current / max)',
            `${stats.io.currentMemory} / ${stats.io.maxMemory} bytes`,
          ],
        ];
        for (const [label, value] of metrics) {
          const li = el('li', 'schema-meta-item');
          const k = el('span', 'col-name');
          k.textContent = `${label}:`;
          const v = el('span', 'col-type');
          v.textContent = value;
          li.append(k, v);
          ioList.append(li);
        }
        ioDiv.append(ioList);
        panel.append(ioDiv);

        // Per-Table Page I/O Flamegraph Breakdown
        const tableIoBreakdown = computeTableIoBreakdown(
          stats,
          ctx.lastSchema?.tables.map((t) => t.name) ?? [],
        );
        if (tableIoBreakdown.size > 0) {
          const tblIoTitle = el('div', 'schema-group-title');
          tblIoTitle.textContent = 'Per-Table Page I/O Flamegraph';
          panel.append(tblIoTitle);

          const flameWrap = el('div', 'flamegraph profiler-table-io');
          const sortedTables = [...tableIoBreakdown.values()].sort(
            (a, b) =>
              b.fetches + b.reads - (a.fetches + a.reads) ||
              b.totalDurationMs - a.totalDurationMs,
          );
          for (const tStat of sortedTables) {
            const pct = Math.max(10, Math.round(tStat.ioShare * 100));
            const bar = el('div', 'flame-bar table-io-bar');
            bar.setAttribute('style', `width: ${pct}%`);
            const nameSpan = el('span', 'col-name');
            nameSpan.textContent = tStat.tableName;
            const detailSpan = el('span', 'schema-badge');
            detailSpan.textContent =
              `fetches: ${tStat.fetches} · reads: ${tStat.reads} · ` +
              `writes: ${tStat.writes} · ${tStat.totalDurationMs.toFixed(1)} ms`;
            bar.append(nameSpan, detailSpan);
            flameWrap.append(bar);
          }
          panel.append(flameWrap);
        }

        const recentTitle = el('div', 'schema-group-title');
        recentTitle.textContent = `Recent Queries (${stats.recentQueries.length})`;
        panel.append(recentTitle);

        if (stats.recentQueries.length === 0) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No queries profiled yet.';
          panel.append(empty);
        } else {
          const qList = el('ol', 'migrations-list profiler-queries');
          for (const q of [...stats.recentQueries].reverse()) {
            const li = el('li', 'migration-item profiler-query-item');
            const dur = el('span', 'migration-version');
            dur.textContent = `${q.durationMs.toFixed(2)} ms`;
            const sqlSpan = el('span', 'migration-name');
            sqlSpan.textContent = q.sql;
            const badge = el('span', 'schema-badge');
            const ioSummary = q.io
              ? ` · fetches:${q.io.fetches} reads:${q.io.reads}`
              : '';
            badge.textContent = `${q.kind} · ${q.rowCount} rows${q.cacheHit ? ' · cached' : ''}${ioSummary}`;
            li.append(dur, sqlSpan, badge);
            qList.append(li);
          }
          panel.append(qList);
        }

        appendMcpAndPrometheusSections(panel, {
          mcpTools: ctx.mcpTools,
          prometheusText: ctx.lastPrometheusText,
          onExportPrometheus: ctx.onExportPrometheus,
          advisorReport: ctx.lastAdvisorReport,
          onRunAdvisor: ctx.onRunAdvisor,
          onLoadAdvisorSql: ctx.onLoadAdvisorSql,
          jobQueueStats: ctx.lastJobQueueStats,
        });
        ctx.inspectorBody.append(panel);
        return;
      }

      if (ctx.activeTab === 'migrations') {
        ctx.inspectorBody.append(renderMigrationsInspectorPanel(ctx.lastMigrations));
        return;
      }

      if (ctx.activeTab === 'replication') {
        const panel = el('div', 'inspector-replication');
        appendPresenceAndAuditSections(panel, {
          presenceRoom: ctx.presenceRoom,
          lastAuditReport: ctx.lastAuditReport,
          onVerifyAudit: ctx.onVerifyAudit,
        });
        const repl = ctx.lastReplication;
        if (!repl) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No replication state loaded yet.';
          panel.append(empty);
          ctx.inspectorBody.append(panel);
          return;
        }

        const dlqList = repl.dlqEntries ?? [];
        const summaryEl = el('p', 'inspector-summary');
        summaryEl.textContent =
          `Journal: ${repl.journalEntryCount} ${repl.journalEntryCount === 1 ? 'entry' : 'entries'} ` +
          `(LSN ${repl.minJournalLsn} → ${repl.maxJournalLsn}) · ` +
          `${repl.slots.length} ${repl.slots.length === 1 ? 'slot' : 'slots'} · ` +
          `${repl.watermarks.length} ${repl.watermarks.length === 1 ? 'watermark' : 'watermarks'} · ` +
          `${dlqList.length} DLQ`;
        panel.append(summaryEl);

        if (repl.enginePublication) {
          const ep = repl.enginePublication;
          const engDiv = el('div', 'schema-sub replication-engine-pub');
          const engLabel = el('span', 'schema-sub-label');
          engLabel.textContent = 'Native Engine Publication (RDB$PUBLICATIONS):';
          engDiv.append(engLabel);
          const engList = el('ul', 'schema-list replication-engine-metrics');
          const engMetrics: Array<[string, string]> = [
            [
              'Publication',
              `${ep.name} (${ep.active ? 'ACTIVE' : 'INACTIVE'}${ep.autoEnable ? ' · INCLUDE ALL' : ''})`,
            ],
            [
              'Published tables',
              ep.publishedTables.length > 0 ? ep.publishedTables.join(', ') : 'none',
            ],
            [
              'Replica mode / sequence',
              `${ep.replicaMode ?? 'NONE'} / seq ${ep.replicationSequence ?? 0}`,
            ],
          ];
          for (const [label, value] of engMetrics) {
            const li = el('li', 'schema-meta-item');
            const k = el('span', 'col-name');
            k.textContent = `${label}:`;
            const v = el('span', 'col-type');
            v.textContent = value;
            li.append(k, v);
            engList.append(li);
          }
          engDiv.append(engList);
          panel.append(engDiv);
        }

        if (repl.liveStats) {
          const st = repl.liveStats;
          const liveDiv = el('div', 'schema-sub');
          const liveLabel = el('span', 'schema-sub-label');
          liveLabel.textContent = 'Live Replicator Telemetry:';
          liveDiv.append(liveLabel);
          const liveList = el('ul', 'schema-list replication-live-metrics');
          const metrics: Array<[string, string]> = [
            ['Status', st.status],
            [
              'LSN (primary / watermark)',
              `${st.primaryLsn} / ${st.replicaWatermark}`,
            ],
            [
              'Lag (entries / ms)',
              `${st.lagEntries} entries / ${st.lagMs} ms`,
            ],
            [
              'Changes (fetched / applied)',
              `${st.totalFetched} / ${st.totalApplied} (${st.bytesTransferred} B)`,
            ],
            [
              'Conflicts resolved',
              String(st.totalConflicts),
            ],
          ];
          for (const [label, value] of metrics) {
            const li = el('li', 'schema-meta-item');
            const k = el('span', 'col-name');
            k.textContent = `${label}:`;
            const v = el('span', 'col-type');
            v.textContent = value;
            li.append(k, v);
            liveList.append(li);
          }
          liveDiv.append(liveList);
          panel.append(liveDiv);
        }

        const slotsTitle = el('div', 'schema-group-title');
        slotsTitle.textContent = `Replication Slots (${repl.slots.length})`;
        panel.append(slotsTitle);
        if (repl.slots.length === 0) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No replication slots registered in FB_REPL_SLOTS$.';
          panel.append(empty);
        } else {
          const slotList = el('ul', 'schema-list replication-slots');
          for (const s of repl.slots) {
            const li = el('li', 'migration-item replication-slot-item');
            const nameEl = el('span', 'migration-version');
            nameEl.textContent = s.slotName;
            const nodeEl = el('span', 'migration-name');
            nodeEl.textContent = `node: ${s.nodeId}`;
            const lag = Math.max(0, repl.maxJournalLsn - s.confirmedFlushLsn);
            const badgeEl = el('span', 'schema-badge');
            badgeEl.textContent = `ack LSN ${s.confirmedFlushLsn} · lag ${lag}`;
            li.append(nameEl, nodeEl, badgeEl);
            slotList.append(li);
          }
          panel.append(slotList);
        }

        const wmTitle = el('div', 'schema-group-title');
        wmTitle.textContent = `Peer Watermarks (${repl.watermarks.length})`;
        panel.append(wmTitle);
        if (repl.watermarks.length === 0) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No peer watermarks recorded in FB_REPL_WATERMARKS$.';
          panel.append(empty);
        } else {
          const wmList = el('ul', 'schema-list replication-watermarks');
          for (const w of repl.watermarks) {
            const li = el('li', 'migration-item replication-watermark-item');
            const peerEl = el('span', 'migration-version');
            peerEl.textContent = w.peerId;
            const lsnEl = el('span', 'migration-name');
            lsnEl.textContent = `last LSN ${w.lastLsn}`;
            const dateEl = el('span', 'schema-badge');
            dateEl.textContent = w.updatedAt;
            li.append(peerEl, lsnEl, dateEl);
            wmList.append(li);
          }
          panel.append(wmList);
        }

        const entriesTitle = el('div', 'schema-group-title');
        entriesTitle.textContent = `Recent Journal Entries (${repl.recentEntries.length})`;
        panel.append(entriesTitle);
        if (repl.recentEntries.length === 0) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = repl.journalTableExists
            ? 'No journal entries in FB_REPL_JOURNAL$.'
            : 'Replication journal table FB_REPL_JOURNAL$ is not initialized.';
          panel.append(empty);
        } else {
          const jList = el('ol', 'migrations-list replication-entries');
          for (const e of repl.recentEntries) {
            const li = el('li', 'migration-item replication-entry-item');
            const lsnSpan = el('span', 'migration-version');
            lsnSpan.textContent = `#${e.lsn}`;
            const descSpan = el('span', 'migration-name');
            descSpan.textContent = `${e.op} ${e.tableName} ${e.pkJson}`;
            const badge = el('span', 'schema-badge');
            badge.textContent = `${e.originNode} · ${e.createdAt}`;
            li.append(lsnSpan, descSpan, badge);
            jList.append(li);
          }
          panel.append(jList);
        }

        const dlqTitle = el('div', 'schema-group-title');
        dlqTitle.textContent = `Dead-Letter Queue (${dlqList.length})`;
        panel.append(dlqTitle);
        if (dlqList.length === 0) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No quarantined entries in FB_REPL_DLQ$.';
          panel.append(empty);
        } else {
          const dList = el('ul', 'schema-list replication-dlq');
          for (const d of dlqList) {
            const li = el('li', 'migration-item replication-dlq-item');
            const lsnSpan = el('span', 'migration-version');
            lsnSpan.textContent = `#${d.lsn}`;
            const errSpan = el('span', 'migration-name');
            errSpan.textContent = `${d.subName}: ${d.errorMessage}`;
            const badge = el('span', 'schema-badge');
            badge.textContent = `retries ${d.retryCount}`;
            li.append(lsnSpan, errSpan, badge);
            dList.append(li);
          }
          panel.append(dList);
        }

        ctx.inspectorBody.append(panel);
        return;
      }

      const panel = el('div', 'inspector-schema');
      const schema = ctx.lastSchema;
      if (!schema) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No schema loaded yet.';
        panel.append(empty);
        ctx.inspectorBody.append(panel);
        return;
      }

      const summaryEl = el('p', 'inspector-summary');
      summaryEl.textContent =
        `${schema.tables.length} ${schema.tables.length === 1 ? 'table' : 'tables'} · ` +
        `${schema.views.length} ${schema.views.length === 1 ? 'view' : 'views'} · ` +
        `${schema.sequences.length} ${schema.sequences.length === 1 ? 'sequence' : 'sequences'} · ` +
        `${schema.triggers.length} ${schema.triggers.length === 1 ? 'trigger' : 'triggers'}`;
      panel.append(summaryEl);

      if (
        schema.tables.length === 0 &&
        schema.views.length === 0 &&
        schema.sequences.length === 0
      ) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No user tables, views, or sequences.';
        panel.append(empty);
      }

      if (schema.tables.length > 0) {
        const groupTitle = el('div', 'schema-group-title');
        groupTitle.textContent = 'Tables';
        panel.append(groupTitle);

        for (const tbl of schema.tables) {
          const details = el('details', 'schema-table');
          details.open = true;
          const header = el('summary', 'schema-item-header');
          const nameSpan = el('span', 'schema-table-name');
          nameSpan.textContent = tbl.name;
          const badge = el('span', 'schema-badge');
          badge.textContent = `(${tbl.columns.length} cols)`;
          const queryBtn = document.createElement('button');
          queryBtn.type = 'button';
          queryBtn.className = 'schema-query-btn';
          queryBtn.textContent = 'SELECT';
          queryBtn.title = `Populate SELECT * FROM ${tbl.name}`;
          queryBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const ident = /^[A-Z0-9_$]+$/.test(tbl.name)
              ? tbl.name
              : `"${tbl.name.replace(/"/g, '""')}"`;
            ctx.editor.value = `SELECT * FROM ${ident};`;
            ctx.editor.focus();
          });
          header.append(nameSpan, badge, queryBtn);
          details.append(header);

          const pkSet = new Set(tbl.primaryKey ?? []);
          const colList = el('ul', 'schema-list schema-columns');
          for (const col of tbl.columns) {
            const li = el('li', 'schema-col');
            const cName = el('span', 'col-name');
            cName.textContent = col.name;
            const cType = el('span', 'col-type');
            cType.textContent = col.typeName;
            li.append(cName, cType);
            if (pkSet.has(col.name) || col.isPrimaryKey) {
              const pkFlag = el('span', 'col-flag');
              pkFlag.textContent = 'PK';
              li.append(pkFlag);
            }
            if (!col.nullable) {
              const nnFlag = el('span', 'schema-badge');
              nnFlag.textContent = 'NOT NULL';
              li.append(nnFlag);
            }
            if (col.isIdentity) {
              const idFlag = el('span', 'col-flag');
              idFlag.textContent = 'IDENTITY';
              li.append(idFlag);
            }
            if (col.defaultSource) {
              const defBadge = el('span', 'schema-badge');
              defBadge.textContent = col.defaultSource;
              li.append(defBadge);
            }
            colList.append(li);
          }
          details.append(colList);

          if (tbl.foreignKeys.length > 0) {
            const fkDiv = el('div', 'schema-sub');
            const fkLabel = el('span', 'schema-sub-label');
            fkLabel.textContent = 'Foreign Keys:';
            fkDiv.append(fkLabel);
            const fkList = el('ul', 'schema-list schema-fks');
            for (const fk of tbl.foreignKeys) {
              const li = el('li', 'schema-meta-item');
              li.textContent = `${fk.name}: (${fk.columns.join(', ')}) → ${fk.referencedTableName}(${fk.referencedColumns.join(', ')})`;
              fkList.append(li);
            }
            fkDiv.append(fkList);
            details.append(fkDiv);
          }

          if (tbl.indexes.length > 0) {
            const idxDiv = el('div', 'schema-sub');
            const idxLabel = el('span', 'schema-sub-label');
            idxLabel.textContent = 'Indexes:';
            idxDiv.append(idxLabel);
            const idxList = el('ul', 'schema-list schema-indexes');
            for (const idx of tbl.indexes) {
              const li = el('li', 'schema-meta-item');
              const kind = idx.unique ? 'UNIQUE' : 'INDEX';
              const dir = idx.descending ? ' DESC' : '';
              li.textContent = `${idx.name} (${kind}${dir}): (${idx.columns.join(', ')})`;
              idxList.append(li);
            }
            idxDiv.append(idxList);
            details.append(idxDiv);
          }

          if (tbl.triggers.length > 0) {
            const trgDiv = el('div', 'schema-sub');
            const trgLabel = el('span', 'schema-sub-label');
            trgLabel.textContent = 'Triggers:';
            trgDiv.append(trgLabel);
            const trgList = el('ul', 'schema-list schema-triggers');
            for (const trg of tbl.triggers) {
              const li = el('li', 'schema-meta-item');
              li.textContent = `${trg.name} (${trg.timing} ${trg.events.join(' OR ')})`;
              trgList.append(li);
            }
            trgDiv.append(trgList);
            details.append(trgDiv);
          }

          panel.append(details);
        }
      }

      if (schema.views.length > 0) {
        const groupTitle = el('div', 'schema-group-title');
        groupTitle.textContent = 'Views';
        panel.append(groupTitle);

        for (const vw of schema.views) {
          const details = el('details', 'schema-view');
          const header = el('summary', 'schema-item-header');
          const nameSpan = el('span', 'schema-view-name');
          nameSpan.textContent = vw.name;
          const badge = el('span', 'schema-badge');
          badge.textContent = `(${vw.columns.length} cols)`;
          header.append(nameSpan, badge);
          details.append(header);
          if (vw.source) {
            const src = el('pre', 'schema-view-source');
            src.textContent = vw.source;
            details.append(src);
          }
          panel.append(details);
        }
      }

      if (ctx.lastMatViews && ctx.lastMatViews.length > 0) {
        const mvTitle = el('div', 'schema-group-title');
        mvTitle.textContent = 'Materialized Views';
        panel.append(mvTitle);

        for (const mv of ctx.lastMatViews) {
          const details = el('details', 'schema-view schema-matview');
          const header = el('summary', 'schema-item-header');
          const nameSpan = el('span', 'schema-view-name');
          nameSpan.textContent = mv.name;
          const badge = el('span', 'schema-badge');
          badge.textContent = `${mv.rowCount} rows · ${mv.refreshStrategy}`;

          const refreshMvBtn = document.createElement('button');
          refreshMvBtn.type = 'button';
          refreshMvBtn.className = 'schema-query-btn matview-refresh-btn';
          refreshMvBtn.textContent = 'Refresh MV';
          refreshMvBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ctx.onRefreshMaterializedView?.(mv.name);
          });

          header.append(nameSpan, badge, refreshMvBtn);
          details.append(header);
          const src = el('pre', 'schema-view-source');
          src.textContent = mv.selectSql;
          details.append(src);
          panel.append(details);
        }
      }

      if (schema.sequences.length > 0) {
        const groupTitle = el('div', 'schema-group-title');
        groupTitle.textContent = 'Sequences';
        panel.append(groupTitle);
        const seqList = el('ul', 'schema-list schema-sequences');
        for (const seq of schema.sequences) {
          const li = el('li', 'schema-meta-item');
          li.textContent = seq.name;
          seqList.append(li);
        }
        panel.append(seqList);
      }

      if (ctx.lastSearchIndexes && ctx.lastSearchIndexes.length > 0) {
        const siTitle = el('div', 'schema-group-title');
        siTitle.textContent = 'Search Indexes (Vector HNSW & BM25 FTS)';
        panel.append(siTitle);
        const siList = el('ul', 'schema-list schema-search-indexes');
        for (const idx of ctx.lastSearchIndexes) {
          const li = el('li', 'schema-meta-item schema-search-index');
          const nameSpan = el('span', 'col-name');
          nameSpan.textContent = `${idx.name} → ${idx.tableName}`;
          const badge = el('span', 'schema-badge');
          badge.textContent = `${idx.details} · ${idx.entryCount} ${idx.kind === 'vector' ? 'vectors' : 'docs'}`;
          li.append(nameSpan, badge);
          siList.append(li);
        }
        panel.append(siList);
      }

      appendSpatialAndTimeSeriesSections(panel, {
        spatialIndexes: ctx.lastSpatialIndexes,
        timeSeriesPolicies: ctx.lastTimeSeriesPolicies,
        temporalTables: ctx.lastTemporalTables,
        eventProjections: ctx.lastEventProjections,
        jsonGinIndexes: ctx.lastJsonGinIndexes,
        trigramIndexes: ctx.lastTrigramIndexes,
      });

      if (ctx.onPreviewSchemaDiff || ctx.lastSchemaDiff) {
        const diffBox = el('div', 'schema-sub schema-diff-preview');
        const diffTitle = el('div', 'schema-group-title');
        diffTitle.textContent = 'Declarative Schema Diff';
        diffBox.append(diffTitle);

        const diffInput = document.createElement('input');
        diffInput.type = 'text';
        diffInput.className = 'schema-diff-input';
        diffInput.placeholder = 'Paste desired CREATE TABLE DDL to preview migration diff…';
        diffInput.value = ctx.schemaDiffDraft ?? '';
        diffBox.append(diffInput);

        const btnRow = el('div', 'schema-sub');
        const diffBtn = document.createElement('button');
        diffBtn.type = 'button';
        diffBtn.className = 'schema-diff-btn';
        diffBtn.textContent = 'Preview Diff';
        diffBtn.addEventListener('click', () => {
          ctx.onPreviewSchemaDiff?.(diffInput.value);
        });
        btnRow.append(diffBtn);

        if (ctx.onApplySchemaPush) {
          const pushBtn = document.createElement('button');
          pushBtn.type = 'button';
          pushBtn.className = 'schema-push-btn';
          pushBtn.textContent = 'Push Additive DDL';
          pushBtn.addEventListener('click', () => {
            ctx.onApplySchemaPush?.(diffInput.value);
          });
          btnRow.append(pushBtn);
        }
        diffBox.append(btnRow);

        if (ctx.lastSchemaDiff) {
          const diffOut = el('pre', 'schema-view-source schema-diff-output');
          if (ctx.lastSchemaDiff.statements.length === 0) {
            diffOut.textContent = '-- Schemas match (0 DDL statements needed).';
          } else {
            const headerWarn = ctx.lastSchemaDiff.hasDestructiveChanges
              ? `-- ⚠ DESTRUCTIVE CHANGES DETECTED (${ctx.lastSchemaDiff.destructiveStatements.length})\n`
              : '';
            diffOut.textContent = `${headerWarn}${ctx.lastSchemaDiff.sql}`;
          }
          diffBox.append(diffOut);
        }
        panel.append(diffBox);
      }

      ctx.inspectorBody.append(panel);
    }

