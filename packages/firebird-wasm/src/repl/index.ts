/**
 * firebird-wasm/repl – Interactive SQL console & database inspector custom element (`<firebird-repl>`).
 */

import {
  computeTableIoBreakdown,
  parseQueryPlan,
  type ParsedQueryPlan,
  type PlanAccessMethod,
  type PlanOperatorKind,
  type PlanTreeNode,
  type TableIoStats,
} from './plan-tree';
import type {
  AppliedMigration,
  ExplainOptions,
  IntrospectOptions,
  MigrateOptions,
  MonitorStats,
  SchemaIntrospection,
} from '../types';
import type { ReplicationStats } from '../replication';
import type { SyncHandleLike } from '../frameworks/sync-store';
import type { OptimisticMutationStore } from '../optimistic-store';
import type { UndoRedoEntry, UndoRedoManager } from '../undo-redo';
import type { MaterializedViewInfo } from '../materialized-view';
import type { DeclarativeSchemaInput, SchemaSyncResult } from '../schema-sync';
import type { AuditChainVerificationResult, AuditSignAlgorithm } from '../audit-log';
import type { McpToolDescriptor } from '../mcp-server';
import type { PresenceRoom } from '../replication/presence';
import type { ReplSearchIndexSummary } from './repl-actions';
import type {
  EventProjectionStatus,
  JobQueueStats,
  ReplArrowInspectorInfo,
  ReplDatabase,
  ReplEditableTableConfig,
  ReplEntry,
  ReplInspectorTab,
  ReplReplicationInfo,
  ReplSpatialIndexSummary,
  TemporalTableInfo,
  TimeSeriesPolicyInfo,
  WorkloadAdvisorReport,
} from './repl-types';

export * from './repl-types';
export type { ReplSearchIndexSummary } from './repl-actions';
export type { AuditChainVerificationResult } from '../audit-log';
export type { McpToolDescriptor } from '../mcp-server';
export {
  computeTableIoBreakdown,
  parseQueryPlan,
  type ParsedQueryPlan,
  type PlanAccessMethod,
  type PlanOperatorKind,
  type PlanTreeNode,
  type TableIoStats,
};

export interface FirebirdReplElement extends HTMLElement {
  db: ReplDatabase | null;
  replicator?: { stats(): Promise<ReplicationStats> } | null;
  syncHandle?: SyncHandleLike | null;
  optimisticStore?: OptimisticMutationStore | null;
  undoRedoManager?: UndoRedoManager | null;
  presenceRoom?: PresenceRoom | null;
  editableTable?: ReplEditableTableConfig | null;
  value: string;
  inspectorOpen: boolean;
  inspectorTab: ReplInspectorTab;
  run(script?: string): Promise<ReplEntry[]>;
  explain(script?: string, options?: ExplainOptions): Promise<ReplEntry[]>;
  info(): Promise<ReplEntry | undefined>;
  sweep(): Promise<ReplEntry | undefined>;
  schema(options?: IntrospectOptions): Promise<ReplEntry | undefined>;
  migrations(options?: Pick<MigrateOptions, 'tableName'>): Promise<ReplEntry | undefined>;
  profiler(): Promise<ReplEntry | undefined>;
  replication(): Promise<ReplEntry | undefined>;
  inspectArrow(sql?: string): Promise<ReplEntry | undefined>;
  exportArrow(sql?: string): Promise<Uint8Array>;
  importArrow(
    tableName: string,
    source: ArrowIngestSource,
    options?: LoadArrowIpcOptions,
  ): Promise<ArrowIngestResult>;
  inspectOutbox(): Promise<ReplEntry | undefined>;
  editCell(
    tableName: string,
    keyValue: unknown,
    column: string,
    newValue: unknown,
    primaryKey?: string,
  ): Promise<void>;
  undo(): Promise<UndoRedoEntry | null>;
  redo(): Promise<UndoRedoEntry | null>;
  materializedViews(): Promise<MaterializedViewInfo[]>;
  refreshMaterializedView(name: string): Promise<void>;
  searchIndexes(): Promise<ReplSearchIndexSummary[]>;
  spatialIndexes(): Promise<ReplSpatialIndexSummary[]>;
  timeSeriesPolicies(): Promise<TimeSeriesPolicyInfo[]>;
  /** List system-versioned bitemporal tables recorded in `FB_TEMPORAL_META$` (`M30 Item 5`). */
  temporalTables(): Promise<TemporalTableInfo[]>;
  /** List persisted CQRS event projections recorded in `FB_EVENT_PROJECTIONS$` (`M30 Item 5`). */
  eventProjections(): Promise<EventProjectionStatus[]>;
  previewSchemaDiff(desiredSource: DeclarativeSchemaInput): Promise<SchemaSyncResult | null>;
  applySchemaPush(
    desiredSource: DeclarativeSchemaInput,
    options?: { allowDestructive?: boolean },
  ): Promise<SchemaSyncResult | null>;
  verifyAuditChain(options?: {
    tableName?: string;
    verifyKey?: CryptoKey | string | Uint8Array;
    signAlgorithm?: AuditSignAlgorithm;
  }): Promise<AuditChainVerificationResult | null>;
  mcpTools(options?: { allowWrites?: boolean }): McpToolDescriptor[];
  prometheusMetrics(): Promise<string>;
  adviseWorkload(extraQueries?: readonly string[]): Promise<WorkloadAdvisorReport | null>;
  jobQueueStats(): Promise<JobQueueStats | null>;
  toggleInspector(tab?: ReplInspectorTab): Promise<void>;
  refreshInspector(): Promise<void>;
  clear(): void;
}

import { createReplDomElements, type ReplDomHandles } from './repl-dom';
import type {
  ArrowIngestResult,
  ArrowIngestSource,
  LoadArrowIpcOptions,
} from '../arrow-ingest';
import {
  fetchReplArrowInspector,
  fetchReplMaterializedViews,
  fetchReplMigrations,
  fetchReplReplication,
  fetchReplSchema,
  fetchReplStats,
  renderReplInspector,
} from './repl-inspectors';
import {
  executeReplArrowExport,
  executeReplArrowImport,
  executeReplCellEdit,
  executeReplExplainBatch,
  executeReplMatViewRefresh,
  executeReplSchemaDiff,
  executeReplScriptBatch,
  fetchReplSearchIndexes,
  stepReplHistoryKey,
  triggerArrowBrowserDownload,
} from './repl-actions';
import { renderReplEntryBlock } from './repl-entry-renderer';
import {
  executeReplOutboxInspect,
  executeReplUndoRedo,
  executeReplVerifyAuditChain,
  executeReplWorkloadAdvisor,
  exportReplPrometheusMetrics,
  fetchReplEventProjections,
  fetchReplJobQueueStats,
  fetchReplSpatialIndexes,
  fetchReplTemporalTables,
  fetchReplTimeSeriesPolicies,
  getReplMcpTools,
  runReplBusyDiagnostic,
} from './repl-presence-audit';

const NO_DB_MSG = 'No database: set the element’s db property first';

export function defineFirebirdRepl(
  tag = 'firebird-repl',
): { new (): FirebirdReplElement } {
  const existing = customElements.get(tag);
  if (existing) return existing as unknown as { new (): FirebirdReplElement };

  class FirebirdRepl extends HTMLElement implements FirebirdReplElement {
    private database: ReplDatabase | null = null;
    private replicatorHandle: { stats(): Promise<ReplicationStats> } | null = null;
    private syncHandleRef: SyncHandleLike | null = null;
    private optStoreRef: OptimisticMutationStore | null = null;
    private unsubOptStore: (() => void) | null = null;
    private undoRedoRef: UndoRedoManager | null = null;
    private unsubUndoRedo: (() => void) | null = null;
    private presenceRoomRef: PresenceRoom | null = null;
    private unsubPresence: (() => void) | null = null;
    private lastAuditReport: AuditChainVerificationResult | null = null;
    private lastPrometheusText: string | null = null;
    private lastAdvisorReport: WorkloadAdvisorReport | null = null;
    private lastJobQueueStats: JobQueueStats | null = null;
    private editableCfg: ReplEditableTableConfig | null = null;
    private readonly dom: ReplDomHandles;
    private readonly history: string[] = [];
    private cursor = 0;
    private draft = '';
    private busy = false;
    private isInspectorOpen = false;
    private activeTab: ReplInspectorTab = 'schema';
    private lastSchema: SchemaIntrospection | null = null;
    private lastMatViews: MaterializedViewInfo[] = [];
    private lastSearchIndexes: ReplSearchIndexSummary[] = [];
    private lastSpatialIndexes: ReplSpatialIndexSummary[] = [];
    private lastTimeSeriesPolicies: TimeSeriesPolicyInfo[] = [];
    private lastTemporalTables: TemporalTableInfo[] = [];
    private lastEventProjections: EventProjectionStatus[] = [];
    private lastSchemaDiff: SchemaSyncResult | null = null;
    private schemaDiffDraft = '';
    private lastMigrations: AppliedMigration[] = [];
    private lastStats: MonitorStats | null = null;
    private lastPlans: Array<{ sql: string; parsed: ParsedQueryPlan }> = [];
    private lastReplication: ReplReplicationInfo | null = null;
    private lastArrow: ReplArrowInspectorInfo | null = null;

    constructor() {
      super();
      const dom = createReplDomElements(this.attachShadow({ mode: 'open' }));
      this.dom = dom;
      dom.button.addEventListener('click', () => void this.run());
      dom.explainButton.addEventListener('click', (ev) =>
        void this.explain(undefined, { detailed: ev.shiftKey }),
      );
      dom.infoButton.addEventListener('click', () => void this.info());
      dom.sweepButton.addEventListener('click', () => void this.sweep());
      dom.schemaButton.addEventListener('click', () => void this.schema());
      dom.migrationsButton.addEventListener('click', () => void this.migrations());
      dom.profilerButton.addEventListener('click', () => void this.profiler());
      dom.replicationButton.addEventListener('click', () => void this.replication());
      dom.arrowButton.addEventListener('click', () => void this.inspectArrow());
      dom.outboxButton.addEventListener('click', () => void this.inspectOutbox());
      dom.undoButton.addEventListener('click', () => void this.undo());
      dom.redoButton.addEventListener('click', () => void this.redo());

      const bindTab = (btn: HTMLButtonElement, tab: ReplInspectorTab) =>
        btn.addEventListener('click', () => {
          this.inspectorTab = tab;
          void this.refreshInspector();
        });
      bindTab(dom.tabSchemaBtn, 'schema');
      bindTab(dom.tabMigrationsBtn, 'migrations');
      bindTab(dom.tabProfilerBtn, 'profiler');
      bindTab(dom.tabPlanBtn, 'plan');
      bindTab(dom.tabReplicationBtn, 'replication');
      bindTab(dom.tabArrowBtn, 'arrow');
      bindTab(dom.tabOutboxBtn, 'outbox');
      dom.inspectorRefreshBtn.addEventListener('click', () => void this.refreshInspector());
      dom.inspectorCloseBtn.addEventListener('click', () => {
        this.inspectorOpen = false;
      });
      dom.editor.addEventListener('keydown', (ev) => this.onKey(ev));

      for (const name of [
        'db',
        'replicator',
        'syncHandle',
        'optimisticStore',
        'undoRedoManager',
        'presenceRoom',
        'editableTable',
        'value',
        'inspectorOpen',
        'inspectorTab',
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(this, name)) {
          const early = (this as Record<string, unknown>)[name];
          delete (this as Record<string, unknown>)[name];
          (this as Record<string, unknown>)[name] = early;
        }
      }
    }

    get db(): ReplDatabase | null { return this.database; }
    set db(db: ReplDatabase | null) { this.database = db; }
    get replicator() { return this.replicatorHandle; }
    set replicator(rep) { this.replicatorHandle = rep ?? null; }
    get syncHandle() { return this.syncHandleRef; }
    set syncHandle(h) { this.syncHandleRef = h ?? null; }
    get optimisticStore() { return this.optStoreRef; }
    set optimisticStore(store: OptimisticMutationStore | null) {
      this.unsubOptStore?.();
      this.unsubOptStore = null;
      this.optStoreRef = store;
      if (store) {
        this.unsubOptStore = store.subscribe(() => {
          if (this.isInspectorOpen && this.activeTab === 'outbox') this.renderInspector();
        });
      }
    }
    get undoRedoManager() { return this.undoRedoRef; }
    set undoRedoManager(mgr: UndoRedoManager | null) {
      this.unsubUndoRedo?.();
      this.unsubUndoRedo = null;
      this.undoRedoRef = mgr;
      this.syncUndoRedoButtons();
      if (mgr) {
        this.unsubUndoRedo = mgr.subscribe(() => {
          this.syncUndoRedoButtons();
          if (this.isInspectorOpen && this.activeTab === 'outbox') this.renderInspector();
        });
      }
    }
    private syncUndoRedoButtons(): void {
      const snap = this.undoRedoRef?.getSnapshot();
      this.dom.undoButton.disabled = this.busy || !snap?.canUndo;
      this.dom.redoButton.disabled = this.busy || !snap?.canRedo;
    }
    get presenceRoom() { return this.presenceRoomRef; }
    set presenceRoom(room: PresenceRoom | null) {
      this.unsubPresence?.();
      this.unsubPresence = null;
      this.presenceRoomRef = room;
      if (room) {
        this.unsubPresence = room.subscribe(() => {
          if (this.isInspectorOpen && this.activeTab === 'replication') this.renderInspector();
        });
      }
      if (this.isInspectorOpen && this.activeTab === 'replication') this.renderInspector();
    }
    get editableTable() { return this.editableCfg; }
    set editableTable(cfg) { this.editableCfg = cfg ?? null; }
    get value(): string { return this.dom.editor.value; }
    set value(text: string) { this.dom.editor.value = text; }
    get inspectorOpen(): boolean { return this.isInspectorOpen; }
    set inspectorOpen(open: boolean) {
      this.isInspectorOpen = Boolean(open);
      this.dom.inspector.hidden = !this.isInspectorOpen;
    }
    get inspectorTab(): ReplInspectorTab { return this.activeTab; }
    set inspectorTab(tab: ReplInspectorTab) {
      this.activeTab =
        tab === 'migrations' ||
        tab === 'profiler' ||
        tab === 'plan' ||
        tab === 'replication' ||
        tab === 'arrow' ||
        tab === 'outbox'
          ? tab
          : 'schema';
      this.updateActiveTabButtons();
      this.renderInspector();
    }

    private updateActiveTabButtons(): void {
      this.dom.tabSchemaBtn.classList.toggle('active', this.activeTab === 'schema');
      this.dom.tabMigrationsBtn.classList.toggle('active', this.activeTab === 'migrations');
      this.dom.tabProfilerBtn.classList.toggle('active', this.activeTab === 'profiler');
      this.dom.tabPlanBtn.classList.toggle('active', this.activeTab === 'plan');
      this.dom.tabReplicationBtn.classList.toggle('active', this.activeTab === 'replication');
      this.dom.tabArrowBtn.classList.toggle('active', this.activeTab === 'arrow');
      this.dom.tabOutboxBtn.classList.toggle('active', this.activeTab === 'outbox');
    }

    private setButtonsDisabled(disabled: boolean): void {
      for (const b of [
        this.dom.button,
        this.dom.explainButton,
        this.dom.infoButton,
        this.dom.sweepButton,
        this.dom.schemaButton,
        this.dom.migrationsButton,
        this.dom.profilerButton,
        this.dom.replicationButton,
        this.dom.arrowButton,
        this.dom.outboxButton,
        this.dom.inspectorRefreshBtn,
      ]) {
        b.disabled = disabled;
      }
      this.syncUndoRedoButtons();
    }

    private activateTabAndOpen(tab: ReplInspectorTab): void {
      this.activeTab = tab;
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      this.renderInspector();
    }

    clear(): void {
      this.dom.output.replaceChildren();
    }

    async toggleInspector(tab?: ReplInspectorTab): Promise<void> {
      if (tab) {
        if (this.isInspectorOpen && this.activeTab === tab) {
          this.inspectorOpen = false;
          return;
        }
        this.inspectorTab = tab;
        this.inspectorOpen = true;
      } else {
        this.inspectorOpen = !this.isInspectorOpen;
      }
      if (this.isInspectorOpen) await this.refreshInspector();
    }

    private async loadSchemaTabData(options?: IntrospectOptions): Promise<SchemaIntrospection> {
      const [schema, mvs, searchIdxs, spatialIdxs, tsPolicies, tmpTables, evProjs] =
        await Promise.all([
          fetchReplSchema(this.db!, options),
          fetchReplMaterializedViews(this.db!),
          fetchReplSearchIndexes(this.db!),
          fetchReplSpatialIndexes(this.db!),
          fetchReplTimeSeriesPolicies(this.db!),
          fetchReplTemporalTables(this.db!),
          fetchReplEventProjections(this.db!),
        ]);
      this.lastSchema = schema;
      this.lastMatViews = mvs;
      this.lastSearchIndexes = searchIdxs;
      this.lastSpatialIndexes = spatialIdxs;
      this.lastTimeSeriesPolicies = tsPolicies;
      this.lastTemporalTables = tmpTables;
      this.lastEventProjections = evProjs;
      return schema;
    }

    async refreshInspector(): Promise<void> {
      if (!this.db) {
        this.lastSchema = null;
        this.lastMigrations = [];
        this.lastStats = null;
        this.lastReplication = null;
        this.renderInspector();
        return;
      }
      try {
        if (this.activeTab === 'schema') {
          await this.loadSchemaTabData();
        } else if (this.activeTab === 'migrations') {
          this.lastMigrations = await fetchReplMigrations(this.db);
        } else if (this.activeTab === 'profiler' || this.activeTab === 'plan') {
          this.lastStats = await fetchReplStats(this.db);
          if (this.activeTab === 'profiler') {
            this.lastJobQueueStats = await fetchReplJobQueueStats(this.db);
          }
        } else if (this.activeTab === 'replication') {
          this.lastReplication = await fetchReplReplication(this.db, this.replicatorHandle);
          this.lastAuditReport = await executeReplVerifyAuditChain(this.db);
        } else if (this.activeTab === 'arrow') {
          this.lastArrow = await fetchReplArrowInspector(
            this.db,
            this.dom.editor.value,
            this.syncHandleRef,
            this.lastArrow?.sql,
          );
        }
      } catch {
        // Keep previous state on transient failure.
      }
      this.renderInspector();
    }

    private renderInspector(): void {
      renderReplInspector({
        db: this.db,
        inspectorBody: this.dom.inspectorBody,
        editor: this.dom.editor,
        activeTab: this.activeTab,
        lastSchema: this.lastSchema,
        lastMatViews: this.lastMatViews,
        lastSearchIndexes: this.lastSearchIndexes,
        lastSpatialIndexes: this.lastSpatialIndexes,
        lastTimeSeriesPolicies: this.lastTimeSeriesPolicies,
        lastTemporalTables: this.lastTemporalTables,
        lastEventProjections: this.lastEventProjections,
        lastSchemaDiff: this.lastSchemaDiff,
        schemaDiffDraft: this.schemaDiffDraft,
        lastMigrations: this.lastMigrations,
        lastStats: this.lastStats,
        lastPlans: this.lastPlans,
        lastReplication: this.lastReplication,
        lastArrow: this.lastArrow,
        optimisticStore: this.optStoreRef,
        undoRedoSnapshot: this.undoRedoRef ? this.undoRedoRef.getSnapshot() : null,
        presenceRoom: this.presenceRoomRef,
        lastAuditReport: this.lastAuditReport,
        mcpTools: getReplMcpTools(this.db),
        lastPrometheusText: this.lastPrometheusText,
        lastAdvisorReport: this.lastAdvisorReport,
        lastJobQueueStats: this.lastJobQueueStats,
        onResetProfiler: () => {
          if (this.db && typeof this.db.resetMonitorStats === 'function') {
            this.db.resetMonitorStats();
            void this.refreshInspector();
          }
        },
        onVerifyAudit: () => void this.verifyAuditChain(),
        onExportPrometheus: () => void this.prometheusMetrics(),
        onRunAdvisor: () => void this.adviseWorkload(),
        onLoadAdvisorSql: (ddl) => {
          this.dom.editor.value = ddl;
          this.dom.editor.focus();
        },
        onFlushOutbox: () => {
          if (this.optStoreRef) void this.optStoreRef.flush().then(() => this.refreshInspector());
        },
        onRevertMutation: (id) => {
          if (this.optStoreRef) void this.optStoreRef.revert(id).then(() => this.refreshInspector());
        },
        onRevertAllOutbox: () => {
          if (this.optStoreRef) void this.optStoreRef.revertAll().then(() => this.refreshInspector());
        },
        onUndo: () => void this.undo(),
        onRedo: () => void this.redo(),
        onRefreshMaterializedView: (mvName) => void this.refreshMaterializedView(mvName),
        onPreviewSchemaDiff: (ddlSql) => {
          this.schemaDiffDraft = ddlSql;
          void this.previewSchemaDiff(ddlSql);
        },
        onApplySchemaPush: (ddlSql) => {
          this.schemaDiffDraft = ddlSql;
          void this.applySchemaPush(ddlSql);
        },
        onExportArrow: () => void this.exportArrow().then(triggerArrowBrowserDownload),
        onImportArrowFile: (fileName, bytes) => {
          const base =
            fileName
              .replace(/\.(arrow|ipc)$/i, '')
              .replace(/[^A-Za-z0-9_]/g, '_')
              .toUpperCase() || 'IMPORTED_ARROW';
          void this.importArrow(base, bytes, { createTable: true });
        },
      });
    }

    async run(script?: string): Promise<ReplEntry[]> {
      const text = script ?? this.dom.editor.value;
      if (this.busy || text.trim() === '') return [];
      if (!this.db) {
        const entry: ReplEntry = { sql: text.trim(), line: 1, ms: 0, error: new Error(NO_DB_MSG) };
        this.show(entry);
        return [entry];
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      if (this.history[this.history.length - 1] !== text) this.history.push(text);
      this.cursor = this.history.length;
      this.draft = '';
      if (script === undefined) this.dom.editor.value = '';

      let entries: ReplEntry[] = [];
      try {
        entries = await executeReplScriptBatch(this.db, text, (entry) => this.show(entry));
        if (this.isInspectorOpen) await this.refreshInspector();
      } finally {
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.dispatchEvent(new CustomEvent('firebird-repl-run', { detail: entries, bubbles: true, composed: true }));
      return entries;
    }

    async explain(script?: string, options?: ExplainOptions): Promise<ReplEntry[]> {
      const text = script ?? this.dom.editor.value;
      if (this.busy || text.trim() === '') return [];
      if (!this.db || typeof this.db.explain !== 'function') {
        const entry: ReplEntry = {
          sql: text.trim(),
          line: 1,
          ms: 0,
          error: new Error(!this.db ? NO_DB_MSG : 'Database does not support explain()'),
        };
        this.show(entry);
        return [entry];
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      if (this.history[this.history.length - 1] !== text) this.history.push(text);
      this.cursor = this.history.length;

      let entries: ReplEntry[] = [];
      try {
        try {
          this.lastStats = await fetchReplStats(this.db);
        } catch {
          // Ignore if monitorStats is unavailable
        }
        const res = await executeReplExplainBatch(
          this.db,
          text,
          options,
          this.lastStats,
          (entry) => this.show(entry),
        );
        entries = res.entries;
        if (res.explainedPlans.length > 0) {
          this.lastPlans = res.explainedPlans;
          this.activateTabAndOpen('plan');
        }
      } finally {
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.dispatchEvent(new CustomEvent('firebird-repl-explain', { detail: entries, bubbles: true, composed: true }));
      return entries;
    }

    private runDiagnostic(
      sqlLabel: string,
      eventName: string,
      guardError: Error | null,
      execute: (entry: ReplEntry) => Promise<void>,
    ): Promise<ReplEntry | undefined> {
      return runReplBusyDiagnostic({
        isBusy: () => this.busy,
        setBusy: (b) => {
          this.busy = b;
          this.setButtonsDisabled(b);
        },
        sqlLabel,
        eventName,
        guardError,
        execute,
        show: (e) => this.show(e),
        dispatch: (ev) => this.dispatchEvent(ev),
      });
    }

    info(): Promise<ReplEntry | undefined> {
      const err = !this.db
        ? new Error(NO_DB_MSG)
        : typeof this.db.databaseInfo !== 'function'
          ? new Error('Database does not support databaseInfo()')
          : null;
      return this.runDiagnostic('DATABASE INFO', 'firebird-repl-info', err, async (entry) => {
        entry.info = await this.db!.databaseInfo!();
      });
    }

    sweep(): Promise<ReplEntry | undefined> {
      const err = !this.db
        ? new Error(NO_DB_MSG)
        : typeof this.db.sweep !== 'function'
          ? new Error('Database does not support sweep()')
          : null;
      return this.runDiagnostic('SWEEP DATABASE', 'firebird-repl-sweep', err, async (entry) => {
        entry.sweep = await this.db!.sweep!();
      });
    }

    schema(options?: IntrospectOptions): Promise<ReplEntry | undefined> {
      return this.runDiagnostic('INSPECT SCHEMA', 'firebird-repl-schema', !this.db ? new Error(NO_DB_MSG) : null, async (entry) => {
        entry.schema = await this.loadSchemaTabData(options);
        this.activateTabAndOpen('schema');
      });
    }

    migrations(options: Pick<MigrateOptions, 'tableName'> = {}): Promise<ReplEntry | undefined> {
      return this.runDiagnostic('INSPECT MIGRATIONS', 'firebird-repl-migrations', !this.db ? new Error(NO_DB_MSG) : null, async (entry) => {
        const list = await fetchReplMigrations(this.db!, options);
        entry.migrations = list;
        this.lastMigrations = list;
        this.activateTabAndOpen('migrations');
      });
    }

    profiler(): Promise<ReplEntry | undefined> {
      const err = !this.db
        ? new Error(NO_DB_MSG)
        : typeof this.db.monitorStats !== 'function' && typeof this.db.databaseInfo !== 'function'
          ? new Error('Database does not support monitorStats()')
          : null;
      return this.runDiagnostic('MONITOR STATS', 'firebird-repl-profiler', err, async (entry) => {
        const stats = await fetchReplStats(this.db!);
        if (stats) {
          entry.stats = stats;
          this.lastStats = stats;
        }
        this.lastJobQueueStats = await fetchReplJobQueueStats(this.db!);
        this.activateTabAndOpen('profiler');
      });
    }

    replication(): Promise<ReplEntry | undefined> {
      return this.runDiagnostic('INSPECT REPLICATION', 'firebird-repl-replication', !this.db ? new Error(NO_DB_MSG) : null, async (entry) => {
        const info = await fetchReplReplication(this.db!, this.replicatorHandle);
        this.lastAuditReport = await executeReplVerifyAuditChain(this.db!);
        entry.replication = info;
        this.lastReplication = info;
        this.activateTabAndOpen('replication');
      });
    }

    inspectArrow(sql?: string): Promise<ReplEntry | undefined> {
      const sqlLabel = (sql ?? this.dom.editor.value ?? '').trim() || 'INSPECT ARROW';
      return this.runDiagnostic(sqlLabel, 'firebird-repl-arrow', !this.db ? new Error(NO_DB_MSG) : null, async (entry) => {
        const info = await fetchReplArrowInspector(this.db!, this.dom.editor.value, this.syncHandleRef, sql);
        entry.arrow = info;
        this.lastArrow = info;
        this.activateTabAndOpen('arrow');
      });
    }

    async exportArrow(sql?: string): Promise<Uint8Array> {
      if (!this.db) throw new Error(NO_DB_MSG);
      const { targetSql, bytes } = await executeReplArrowExport(this.db, this.dom.editor.value, sql);
      await this.inspectArrow(targetSql);
      this.dispatchEvent(new CustomEvent('firebird-repl-arrow-export', { detail: { sql: targetSql, bytes, byteLength: bytes.byteLength }, bubbles: true, composed: true }));
      return bytes;
    }

    async importArrow(tableName: string, source: ArrowIngestSource, options: LoadArrowIpcOptions = {}): Promise<ArrowIngestResult> {
      if (!this.db) throw new Error(NO_DB_MSG);
      const { result, entry } = await executeReplArrowImport(this.db, tableName, source, options);
      this.show(entry);
      if (this.isInspectorOpen) await this.refreshInspector();
      this.dispatchEvent(new CustomEvent('firebird-repl-arrow-import', { detail: result, bubbles: true, composed: true }));
      return result;
    }

    inspectOutbox(): Promise<ReplEntry | undefined> {
      return executeReplOutboxInspect(this.optStoreRef, () => this.activateTabAndOpen('outbox'), (e) => this.show(e));
    }

    async editCell(tableName: string, keyValue: unknown, column: string, newValue: unknown, primaryKey = 'ID'): Promise<void> {
      if (!this.db) throw new Error(NO_DB_MSG);
      const detail = await executeReplCellEdit(this.db, this.undoRedoRef, this.optStoreRef, tableName, keyValue, column, newValue, primaryKey);
      if (this.isInspectorOpen) await this.refreshInspector();
      this.dispatchEvent(new CustomEvent('firebird-repl-cell-edit', { detail, bubbles: true, composed: true }));
    }

    undo(): Promise<UndoRedoEntry | null> {
      return executeReplUndoRedo(this.undoRedoRef, 'undo', (e) => this.show(e), async () => {
        if (this.isInspectorOpen) await this.refreshInspector();
      });
    }

    redo(): Promise<UndoRedoEntry | null> {
      return executeReplUndoRedo(this.undoRedoRef, 'redo', (e) => this.show(e), async () => {
        if (this.isInspectorOpen) await this.refreshInspector();
      });
    }

    async materializedViews(): Promise<MaterializedViewInfo[]> {
      if (!this.db) return [];
      this.lastMatViews = await fetchReplMaterializedViews(this.db);
      return this.lastMatViews;
    }

    async refreshMaterializedView(name: string): Promise<void> {
      if (!this.db) return;
      const entry = await executeReplMatViewRefresh(this.db, name);
      if (entry) this.show(entry);
      if (this.isInspectorOpen) await this.refreshInspector();
    }

    async searchIndexes(): Promise<ReplSearchIndexSummary[]> {
      if (!this.db) return [];
      this.lastSearchIndexes = await fetchReplSearchIndexes(this.db);
      return this.lastSearchIndexes;
    }

    async spatialIndexes(): Promise<ReplSpatialIndexSummary[]> {
      if (!this.db) return [];
      this.lastSpatialIndexes = await fetchReplSpatialIndexes(this.db);
      if (this.isInspectorOpen && this.activeTab === 'schema') this.renderInspector();
      return this.lastSpatialIndexes;
    }

    async timeSeriesPolicies(): Promise<TimeSeriesPolicyInfo[]> {
      if (!this.db) return [];
      this.lastTimeSeriesPolicies = await fetchReplTimeSeriesPolicies(this.db);
      if (this.isInspectorOpen && this.activeTab === 'schema') this.renderInspector();
      return this.lastTimeSeriesPolicies;
    }

    async temporalTables(): Promise<TemporalTableInfo[]> {
      if (!this.db) return [];
      this.lastTemporalTables = await fetchReplTemporalTables(this.db);
      if (this.isInspectorOpen && this.activeTab === 'schema') this.renderInspector();
      return this.lastTemporalTables;
    }

    async eventProjections(): Promise<EventProjectionStatus[]> {
      if (!this.db) return [];
      this.lastEventProjections = await fetchReplEventProjections(this.db);
      if (this.isInspectorOpen && this.activeTab === 'schema') this.renderInspector();
      return this.lastEventProjections;
    }

    async previewSchemaDiff(desiredSource: DeclarativeSchemaInput): Promise<SchemaSyncResult | null> {
      if (!this.db) return null;
      if (typeof desiredSource === 'string') this.schemaDiffDraft = desiredSource;
      this.lastSchemaDiff = await executeReplSchemaDiff(this.db, desiredSource, { dryRun: true });
      this.activeTab = 'schema';
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      await this.refreshInspector();
      return this.lastSchemaDiff;
    }

    async applySchemaPush(desiredSource: DeclarativeSchemaInput, options: { allowDestructive?: boolean } = {}): Promise<SchemaSyncResult | null> {
      if (!this.db) return null;
      if (typeof desiredSource === 'string') this.schemaDiffDraft = desiredSource;
      this.lastSchemaDiff = await executeReplSchemaDiff(this.db, desiredSource, { dryRun: false, allowDestructive: options.allowDestructive });
      if (this.isInspectorOpen) await this.refreshInspector();
      return this.lastSchemaDiff;
    }

    async verifyAuditChain(options: { tableName?: string; verifyKey?: CryptoKey | string | Uint8Array; signAlgorithm?: AuditSignAlgorithm } = {}): Promise<AuditChainVerificationResult | null> {
      if (!this.db) return null;
      const report = await executeReplVerifyAuditChain(this.db, options);
      this.lastAuditReport = report;
      this.activateTabAndOpen('replication');
      this.dispatchEvent(new CustomEvent('firebird-repl-audit-verify', { detail: report, bubbles: true, composed: true }));
      return report;
    }

    mcpTools(options: { allowWrites?: boolean } = {}): McpToolDescriptor[] {
      return getReplMcpTools(this.db, Boolean(options.allowWrites));
    }

    async prometheusMetrics(): Promise<string> {
      this.lastPrometheusText = await exportReplPrometheusMetrics(this.db, this.replicatorHandle);
      this.activeTab = 'profiler';
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      await this.refreshInspector();
      return this.lastPrometheusText;
    }

    async adviseWorkload(extraQueries: readonly string[] = []): Promise<WorkloadAdvisorReport | null> {
      if (!this.db) return null;
      const queries = extraQueries.length > 0 ? extraQueries : this.dom.editor.value.trim() ? [this.dom.editor.value.trim()] : [];
      this.lastAdvisorReport = await executeReplWorkloadAdvisor(this.db, queries);
      this.activeTab = 'profiler';
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      await this.refreshInspector();
      return this.lastAdvisorReport;
    }

    async jobQueueStats(): Promise<JobQueueStats | null> {
      if (!this.db) return null;
      this.lastJobQueueStats = await fetchReplJobQueueStats(this.db);
      if (this.isInspectorOpen && this.activeTab === 'profiler') this.renderInspector();
      return this.lastJobQueueStats;
    }

    private onKey(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.run();
        return;
      }
      const state = { cursor: this.cursor, draft: this.draft };
      stepReplHistoryKey(event, this.dom.editor, this.history, state, () => void this.run());
      this.cursor = state.cursor;
      this.draft = state.draft;
    }

    private show(entry: ReplEntry): void {
      const block = renderReplEntryBlock(entry, {
        editableTable: this.editableCfg,
        optimisticStore: this.optStoreRef,
        onEditCell: (tbl, keyVal, colName, nextVal, pkName) =>
          this.editCell(tbl, keyVal, colName, nextVal, pkName),
      });
      this.dom.output.append(block);
      this.dom.output.scrollTop = this.dom.output.scrollHeight;
    }
  }

  customElements.define(tag, FirebirdRepl);
  return FirebirdRepl;
}
