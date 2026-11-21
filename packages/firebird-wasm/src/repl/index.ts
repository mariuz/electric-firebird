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
  JobQueueStats,
  ReplArrowInspectorInfo,
  ReplDatabase,
  ReplEditableTableConfig,
  ReplEntry,
  ReplInspectorTab,
  ReplReplicationInfo,
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

/** The element's own API, beyond HTMLElement's. */
export interface FirebirdReplElement extends HTMLElement {
  /** The database statements run against. */
  db: ReplDatabase | null;
  /** Optional `DatabaseReplicator` or `ReplicationSubscription` providing live `stats()` telemetry. */
  replicator?: { stats(): Promise<ReplicationStats> } | null;
  /** Optional `SyncHandle` (`syncDatabases()` / `db.syncWith()`) inspected in the Sync & Arrow panel (`M20 Item 4`). */
  syncHandle?: SyncHandleLike | null;
  /** Optional `OptimisticMutationStore` enabling optimistic cell edits, pending row badges, and the `Outbox` inspector (`M23 Item 5`). */
  optimisticStore?: OptimisticMutationStore | null;
  /** Optional `UndoRedoManager` enabling local-first `Undo` / `Redo` toolbar & Outbox controls (`M24 Item 5`). */
  undoRedoManager?: UndoRedoManager | null;
  /** Optional collaborative `PresenceRoom` displaying live peer awareness badges in the Replication Inspector (`M26 Item 5`). */
  presenceRoom?: PresenceRoom | null;
  /** Optional target table config enabling inline double-click cell editing in result grids (`M23 Item 5`). */
  editableTable?: ReplEditableTableConfig | null;
  /** The editor's text. */
  value: string;
  /** Whether the Schema Inspector & Migration Viewer sidebar is open. */
  inspectorOpen: boolean;
  /** Currently active sidebar tab (`'schema'`, `'migrations'`, `'profiler'`, `'plan'`, or `'replication'`). */
  inspectorTab: ReplInspectorTab;
  /** Run `script` (default: the editor's text); resolves with what each statement did. */
  run(script?: string): Promise<ReplEntry[]>;
  /** Explain `script` (default: the editor's text) without executing it; resolves with each statement's plan. */
  explain(script?: string, options?: ExplainOptions): Promise<ReplEntry[]>;
  /** Inspect database diagnostics and OIT/OAT transaction health; resolves with the info entry. */
  info(): Promise<ReplEntry | undefined>;
  /** Run an immediate garbage-collection sweep and display before/after OIT/OAT counters. */
  sweep(): Promise<ReplEntry | undefined>;
  /** Introspect the database catalog, open/update the Schema Inspector, and log a schema summary entry. */
  schema(options?: IntrospectOptions): Promise<ReplEntry | undefined>;
  /** Read applied migrations from `FB_MIGRATIONS$`, open/update the Migration Viewer, and log a migrations entry. */
  migrations(
    options?: Pick<MigrateOptions, 'tableName'>,
  ): Promise<ReplEntry | undefined>;
  /** Inspect query telemetry and `MON$` monitoring counters, open/update the Profiler tab, and log a profiler entry. */
  profiler(): Promise<ReplEntry | undefined>;
  /** Inspect replication journal (`FB_REPL_JOURNAL$`), slots (`FB_REPL_SLOTS$`), watermarks (`FB_REPL_WATERMARKS$`), and live lag telemetry. */
  replication(): Promise<ReplEntry | undefined>;
  /** Execute `sql` (default: editor text) as columnar vectors + Apache Arrow IPC stream and open the Sync & Arrow Inspector (`M20 Item 4`). */
  inspectArrow(sql?: string): Promise<ReplEntry | undefined>;
  /** Export `sql` (default: editor text) as an Apache Arrow IPC V5 `Uint8Array` (`M22 Item 4`). */
  exportArrow(sql?: string): Promise<Uint8Array>;
  /** Import an Apache Arrow IPC V5 stream/buffer into `tableName` (`M22 Item 4`). */
  importArrow(
    tableName: string,
    source: ArrowIngestSource,
    options?: LoadArrowIpcOptions,
  ): Promise<ArrowIngestResult>;
  /** Open the Optimistic Outbox inspector and log an outbox summary entry (`M23 Item 5`). */
  inspectOutbox(): Promise<ReplEntry | undefined>;
  /** Programmatically or interactively edit a single cell value via `optimisticStore` or `db.execute` (`M23 Item 5`). */
  editCell(
    tableName: string,
    keyValue: unknown,
    column: string,
    newValue: unknown,
    primaryKey?: string,
  ): Promise<void>;
  /** Undo the most recent user action recorded in `undoRedoManager` (`M24 Item 5`). */
  undo(): Promise<UndoRedoEntry | null>;
  /** Redo the most recently undone user action recorded in `undoRedoManager` (`M24 Item 5`). */
  redo(): Promise<UndoRedoEntry | null>;
  /** List persistent materialized views recorded in `"FB_MATVIEWS$"` (`M24 Item 5`). */
  materializedViews(): Promise<MaterializedViewInfo[]>;
  /** Re-populate a persistent materialized view recorded in `"FB_MATVIEWS$"` (`M24 Item 5`). */
  refreshMaterializedView(name: string): Promise<void>;
  /** List persisted Vector HNSW (`FB_VECTOR_INDEX$`) and BM25 FTS (`FB_FTS_INDEX$`) indexes (`M25 Item 5`). */
  searchIndexes(): Promise<ReplSearchIndexSummary[]>;
  /** Preview declarative DDL schema diff against `desiredSource` without mutating the database (`M25 Item 5`). */
  previewSchemaDiff(desiredSource: DeclarativeSchemaInput): Promise<SchemaSyncResult | null>;
  /** Push declarative schema changes from `desiredSource` onto the database (`M25 Item 5`). */
  applySchemaPush(
    desiredSource: DeclarativeSchemaInput,
    options?: { allowDestructive?: boolean },
  ): Promise<SchemaSyncResult | null>;
  /** Verify `"FB_AUDIT_LOG$"` SHA-256 hash chain & Merkle root integrity and render status in the Replication Inspector (`M26 Item 5`). */
  verifyAuditChain(options?: {
    tableName?: string;
    verifyKey?: CryptoKey | string | Uint8Array;
    signAlgorithm?: AuditSignAlgorithm;
  }): Promise<AuditChainVerificationResult | null>;
  /** List active Model Context Protocol (MCP) tools exposed for this database (`M27 Item 5`). */
  mcpTools(options?: { allowWrites?: boolean }): McpToolDescriptor[];
  /** Export OpenMetrics / Prometheus exposition text and render preview in the Profiler Inspector (`M27 Item 5`). */
  prometheusMetrics(): Promise<string>;
  /** Analyze recent/explicit queries and catalog indexes, surfacing DDL recommendations in the Profiler Inspector (`M28 Item 5`). */
  adviseWorkload(extraQueries?: readonly string[]): Promise<WorkloadAdvisorReport | null>;
  /** Inspect durable `FB_JOB_QUEUE$` background job, DLQ, and cron schedule counts (`M28 Item 5`). */
  jobQueueStats(): Promise<JobQueueStats | null>;
  /** Toggle (or switch to `tab` in) the interactive Schema Inspector, Migration Viewer, Profiler & Plan Explorer sidebar. */
  toggleInspector(tab?: ReplInspectorTab): Promise<void>;
  /** Refresh the interactive Schema Inspector, Migration Viewer, Profiler & Plan Explorer sidebar from the database. */
  refreshInspector(): Promise<void>;
  /** Empty the output. */
  clear(): void;
}

import { createReplDomElements } from './repl-dom';
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
  executeReplVerifyAuditChain,
  executeReplWorkloadAdvisor,
  exportReplPrometheusMetrics,
  fetchReplJobQueueStats,
  getReplMcpTools,
  runReplBusyDiagnostic,
} from './repl-presence-audit';

/**
 * Register the element under `tag` (default `firebird-repl`) and return its
 * class.  Calling it again returns the class already registered.
 */
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
    private readonly output: HTMLDivElement;
    private readonly inspector: HTMLDivElement;
    private readonly inspectorBody: HTMLDivElement;
    private readonly tabSchemaBtn: HTMLButtonElement;
    private readonly tabMigrationsBtn: HTMLButtonElement;
    private readonly tabProfilerBtn: HTMLButtonElement;
    private readonly tabPlanBtn: HTMLButtonElement;
    private readonly tabReplicationBtn: HTMLButtonElement;
    private readonly tabArrowBtn: HTMLButtonElement;
    private readonly tabOutboxBtn: HTMLButtonElement;
    private readonly inspectorRefreshBtn: HTMLButtonElement;
    private readonly inspectorCloseBtn: HTMLButtonElement;
    private readonly editor: HTMLTextAreaElement;
    private readonly button: HTMLButtonElement;
    private readonly explainButton: HTMLButtonElement;
    private readonly infoButton: HTMLButtonElement;
    private readonly sweepButton: HTMLButtonElement;
    private readonly schemaButton: HTMLButtonElement;
    private readonly migrationsButton: HTMLButtonElement;
    private readonly profilerButton: HTMLButtonElement;
    private readonly replicationButton: HTMLButtonElement;
    private readonly arrowButton: HTMLButtonElement;
    private readonly outboxButton: HTMLButtonElement;
    private readonly undoButton: HTMLButtonElement;
    private readonly redoButton: HTMLButtonElement;
    private readonly history: string[] = [];
    /** Position in `history` while walking it; `history.length` is the draft. */
    private cursor = 0;
    private draft = '';
    private busy = false;
    private isInspectorOpen = false;
    private activeTab: ReplInspectorTab = 'schema';
    private lastSchema: SchemaIntrospection | null = null;
    private lastMatViews: MaterializedViewInfo[] = [];
    private lastSearchIndexes: ReplSearchIndexSummary[] = [];
    private lastSchemaDiff: SchemaSyncResult | null = null;
    private schemaDiffDraft = '';
    private lastMigrations: AppliedMigration[] = [];
    private lastStats: MonitorStats | null = null;
    private lastPlans: Array<{ sql: string; parsed: ParsedQueryPlan }> = [];
    private lastReplication: ReplReplicationInfo | null = null;
    private lastArrow: ReplArrowInspectorInfo | null = null;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const dom = createReplDomElements(root);
      this.output = dom.output;
      this.inspector = dom.inspector;
      this.inspectorBody = dom.inspectorBody;
      this.tabSchemaBtn = dom.tabSchemaBtn;
      this.tabMigrationsBtn = dom.tabMigrationsBtn;
      this.tabProfilerBtn = dom.tabProfilerBtn;
      this.tabPlanBtn = dom.tabPlanBtn;
      this.tabReplicationBtn = dom.tabReplicationBtn;
      this.tabArrowBtn = dom.tabArrowBtn;
      this.tabOutboxBtn = dom.tabOutboxBtn;
      this.inspectorRefreshBtn = dom.inspectorRefreshBtn;
      this.inspectorCloseBtn = dom.inspectorCloseBtn;
      this.editor = dom.editor;
      this.button = dom.button;
      this.explainButton = dom.explainButton;
      this.infoButton = dom.infoButton;
      this.sweepButton = dom.sweepButton;
      this.schemaButton = dom.schemaButton;
      this.migrationsButton = dom.migrationsButton;
      this.profilerButton = dom.profilerButton;
      this.replicationButton = dom.replicationButton;
      this.arrowButton = dom.arrowButton;
      this.outboxButton = dom.outboxButton;
      this.undoButton = dom.undoButton;
      this.redoButton = dom.redoButton;

      this.button.addEventListener('click', () => void this.run());
      this.explainButton.addEventListener('click', (event) =>
        void this.explain(undefined, { detailed: event.shiftKey }),
      );
      this.infoButton.addEventListener('click', () => void this.info());
      this.sweepButton.addEventListener('click', () => void this.sweep());
      this.schemaButton.addEventListener('click', () => void this.schema());
      this.migrationsButton.addEventListener('click', () => void this.migrations());
      this.profilerButton.addEventListener('click', () => void this.profiler());
      this.replicationButton.addEventListener('click', () => void this.replication());
      this.arrowButton.addEventListener('click', () => void this.inspectArrow());
      this.outboxButton.addEventListener('click', () => void this.inspectOutbox());
      this.undoButton.addEventListener('click', () => void this.undo());
      this.redoButton.addEventListener('click', () => void this.redo());
      this.tabSchemaBtn.addEventListener('click', () => {
        this.inspectorTab = 'schema';
        void this.refreshInspector();
      });
      this.tabMigrationsBtn.addEventListener('click', () => {
        this.inspectorTab = 'migrations';
        void this.refreshInspector();
      });
      this.tabProfilerBtn.addEventListener('click', () => {
        this.inspectorTab = 'profiler';
        void this.refreshInspector();
      });
      this.tabPlanBtn.addEventListener('click', () => {
        this.inspectorTab = 'plan';
        void this.refreshInspector();
      });
      this.tabReplicationBtn.addEventListener('click', () => {
        this.inspectorTab = 'replication';
        void this.refreshInspector();
      });
      this.tabArrowBtn.addEventListener('click', () => {
        this.inspectorTab = 'arrow';
        void this.refreshInspector();
      });
      this.tabOutboxBtn.addEventListener('click', () => {
        this.inspectorTab = 'outbox';
        void this.refreshInspector();
      });
      this.inspectorRefreshBtn.addEventListener(
        'click',
        () => void this.refreshInspector(),
      );
      this.inspectorCloseBtn.addEventListener('click', () => {
        this.inspectorOpen = false;
      });
      this.editor.addEventListener('keydown', (event) => this.onKey(event));

      // A property set before the element was defined (React and Vue both
      // set properties as they render) sits on the instance and would hide
      // the accessor: take it over.
      for (const name of ['db', 'replicator', 'syncHandle', 'optimisticStore', 'undoRedoManager', 'presenceRoom', 'editableTable', 'value', 'inspectorOpen', 'inspectorTab'] as const) {
        if (Object.prototype.hasOwnProperty.call(this, name)) {
          const early = (this as Record<string, unknown>)[name];
          delete (this as Record<string, unknown>)[name];
          (this as Record<string, unknown>)[name] = early;
        }
      }
    }

    get db(): ReplDatabase | null {
      return this.database;
    }

    set db(db: ReplDatabase | null) {
      this.database = db;
    }

    get replicator(): { stats(): Promise<ReplicationStats> } | null {
      return this.replicatorHandle;
    }

    set replicator(rep: { stats(): Promise<ReplicationStats> } | null) {
      this.replicatorHandle = rep;
    }

    get syncHandle(): SyncHandleLike | null {
      return this.syncHandleRef;
    }

    set syncHandle(handle: SyncHandleLike | null) {
      this.syncHandleRef = handle;
    }

    get optimisticStore(): OptimisticMutationStore | null {
      return this.optStoreRef;
    }

    set optimisticStore(store: OptimisticMutationStore | null) {
      this.unsubOptStore?.();
      this.unsubOptStore = null;
      this.optStoreRef = store;
      if (store) {
        this.unsubOptStore = store.subscribe(() => {
          if (this.isInspectorOpen && this.activeTab === 'outbox') {
            this.renderInspector();
          }
        });
      }
    }

    get undoRedoManager(): UndoRedoManager | null {
      return this.undoRedoRef;
    }

    set undoRedoManager(mgr: UndoRedoManager | null) {
      this.unsubUndoRedo?.();
      this.unsubUndoRedo = null;
      this.undoRedoRef = mgr;
      this.syncUndoRedoButtons();
      if (mgr) {
        this.unsubUndoRedo = mgr.subscribe(() => {
          this.syncUndoRedoButtons();
          if (this.isInspectorOpen && this.activeTab === 'outbox') {
            this.renderInspector();
          }
        });
      }
    }

    private syncUndoRedoButtons(): void {
      const snap = this.undoRedoRef?.getSnapshot();
      this.undoButton.disabled = this.busy || !snap?.canUndo;
      this.redoButton.disabled = this.busy || !snap?.canRedo;
    }

    get presenceRoom(): PresenceRoom | null {
      return this.presenceRoomRef;
    }

    set presenceRoom(room: PresenceRoom | null) {
      this.unsubPresence?.();
      this.unsubPresence = null;
      this.presenceRoomRef = room;
      if (room) {
        this.unsubPresence = room.subscribe(() => {
          if (this.isInspectorOpen && this.activeTab === 'replication') {
            this.renderInspector();
          }
        });
      }
      if (this.isInspectorOpen && this.activeTab === 'replication') {
        this.renderInspector();
      }
    }

    get editableTable(): ReplEditableTableConfig | null {
      return this.editableCfg;
    }

    set editableTable(cfg: ReplEditableTableConfig | null) {
      this.editableCfg = cfg;
    }

    get value(): string {
      return this.editor.value;
    }

    set value(text: string) {
      this.editor.value = text;
    }

    get inspectorOpen(): boolean {
      return this.isInspectorOpen;
    }

    set inspectorOpen(open: boolean) {
      this.isInspectorOpen = Boolean(open);
      this.inspector.hidden = !this.isInspectorOpen;
    }

    get inspectorTab(): ReplInspectorTab {
      return this.activeTab;
    }

    set inspectorTab(tab: ReplInspectorTab) {
      this.activeTab =
        tab === 'migrations'
          ? 'migrations'
          : tab === 'profiler'
            ? 'profiler'
            : tab === 'plan'
              ? 'plan'
              : tab === 'replication'
                ? 'replication'
                : tab === 'arrow'
                  ? 'arrow'
                  : tab === 'outbox'
                    ? 'outbox'
                    : 'schema';
      this.updateActiveTabButtons();
      this.renderInspector();
    }

    private updateActiveTabButtons(): void {
      this.tabSchemaBtn.classList.toggle('active', this.activeTab === 'schema');
      this.tabMigrationsBtn.classList.toggle(
        'active',
        this.activeTab === 'migrations',
      );
      this.tabProfilerBtn.classList.toggle(
        'active',
        this.activeTab === 'profiler',
      );
      this.tabPlanBtn.classList.toggle('active', this.activeTab === 'plan');
      this.tabReplicationBtn.classList.toggle(
        'active',
        this.activeTab === 'replication',
      );
      this.tabArrowBtn.classList.toggle('active', this.activeTab === 'arrow');
      this.tabOutboxBtn.classList.toggle('active', this.activeTab === 'outbox');
    }

    private setButtonsDisabled(disabled: boolean): void {
      this.button.disabled = disabled;
      this.explainButton.disabled = disabled;
      this.infoButton.disabled = disabled;
      this.sweepButton.disabled = disabled;
      this.schemaButton.disabled = disabled;
      this.migrationsButton.disabled = disabled;
      this.profilerButton.disabled = disabled;
      this.replicationButton.disabled = disabled;
      this.arrowButton.disabled = disabled;
      this.outboxButton.disabled = disabled;
      this.inspectorRefreshBtn.disabled = disabled;
      this.syncUndoRedoButtons();
    }

    clear(): void {
      this.output.replaceChildren();
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
      if (this.isInspectorOpen) {
        await this.refreshInspector();
      }
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
          this.lastSchema = await this.fetchSchema();
          this.lastMatViews = await fetchReplMaterializedViews(this.db);
          this.lastSearchIndexes = await fetchReplSearchIndexes(this.db);
        } else if (this.activeTab === 'migrations') {
          this.lastMigrations = await this.fetchMigrations();
        } else if (this.activeTab === 'profiler' || this.activeTab === 'plan') {
          this.lastStats = await this.fetchStats();
          if (this.activeTab === 'profiler') {
            this.lastJobQueueStats = await fetchReplJobQueueStats(this.db);
          }
        } else if (this.activeTab === 'replication') {
          this.lastReplication = await this.fetchReplication();
          this.lastAuditReport = await executeReplVerifyAuditChain(this.db);
        } else if (this.activeTab === 'arrow') {
          this.lastArrow = await this.fetchArrowInspector(this.lastArrow?.sql);
        }
      } catch {
        // Keep previous state on transient failure.
      }
      this.renderInspector();
    }

    private fetchSchema(options?: IntrospectOptions): Promise<SchemaIntrospection> {
      return fetchReplSchema(this.db!, options);
    }

    private fetchMigrations(options: Pick<MigrateOptions, 'tableName'> = {}): Promise<AppliedMigration[]> {
      return fetchReplMigrations(this.db!, options);
    }

    private fetchStats(): Promise<MonitorStats | null> {
      return fetchReplStats(this.db!);
    }

    private fetchReplication(): Promise<ReplReplicationInfo> {
      return fetchReplReplication(this.db!, this.replicatorHandle);
    }

    private fetchArrowInspector(explicitSql?: string): Promise<ReplArrowInspectorInfo> {
      return fetchReplArrowInspector(this.db!, this.editor.value, this.syncHandleRef, explicitSql);
    }

    private renderInspector(): void {
      renderReplInspector({
        db: this.db,
        inspectorBody: this.inspectorBody,
        editor: this.editor,
        activeTab: this.activeTab,
        lastSchema: this.lastSchema,
        lastMatViews: this.lastMatViews,
        lastSearchIndexes: this.lastSearchIndexes,
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
          if (this.db && typeof this.db.resetMonitorStats === "function") {
            this.db.resetMonitorStats();
            void this.refreshInspector();
          }
        },
        onVerifyAudit: () => {
          void this.verifyAuditChain();
        },
        onExportPrometheus: () => {
          void this.prometheusMetrics();
        },
        onRunAdvisor: () => {
          void this.adviseWorkload();
        },
        onLoadAdvisorSql: (ddl) => {
          this.editor.value = ddl;
          this.editor.focus();
        },
        onFlushOutbox: () => {
          if (this.optStoreRef) {
            void this.optStoreRef.flush().then(() => this.refreshInspector());
          }
        },
        onRevertMutation: (id) => {
          if (this.optStoreRef) {
            void this.optStoreRef.revert(id).then(() => this.refreshInspector());
          }
        },
        onRevertAllOutbox: () => {
          if (this.optStoreRef) {
            void this.optStoreRef.revertAll().then(() => this.refreshInspector());
          }
        },
        onUndo: () => {
          void this.undo();
        },
        onRedo: () => {
          void this.redo();
        },
        onRefreshMaterializedView: (mvName) => {
          void this.refreshMaterializedView(mvName);
        },
        onPreviewSchemaDiff: (ddlSql) => {
          this.schemaDiffDraft = ddlSql;
          void this.previewSchemaDiff(ddlSql);
        },
        onApplySchemaPush: (ddlSql) => {
          this.schemaDiffDraft = ddlSql;
          void this.applySchemaPush(ddlSql);
        },
        onExportArrow: () => {
          void this.exportArrow().then(triggerArrowBrowserDownload);
        },
        onImportArrowFile: (fileName, bytes) => {
          const base = fileName
            .replace(/\.(arrow|ipc)$/i, '')
            .replace(/[^A-Za-z0-9_]/g, '_')
            .toUpperCase() || 'IMPORTED_ARROW';
          void this.importArrow(base, bytes, { createTable: true });
        },
      });
    }

    async run(script?: string): Promise<ReplEntry[]> {
      const text = script ?? this.editor.value;
      if (this.busy || text.trim() === '') return [];
      if (!this.db) {
        const entry: ReplEntry = {
          sql: text.trim(),
          line: 1,
          ms: 0,
          error: new Error('No database: set the element’s db property first'),
        };
        this.show(entry);
        return [entry];
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      if (this.history[this.history.length - 1] !== text) this.history.push(text);
      this.cursor = this.history.length;
      this.draft = '';
      if (script === undefined) this.editor.value = '';

      let entries: ReplEntry[] = [];
      try {
        entries = await executeReplScriptBatch(this.db, text, (entry) => this.show(entry));
        if (this.isInspectorOpen) {
          await this.refreshInspector();
        }
      } finally {
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.dispatchEvent(
        new CustomEvent('firebird-repl-run', {
          detail: entries,
          bubbles: true,
          composed: true,
        }),
      );
      return entries;
    }

    async explain(
      script?: string,
      options?: ExplainOptions,
    ): Promise<ReplEntry[]> {
      const text = script ?? this.editor.value;
      if (this.busy || text.trim() === '') return [];
      if (!this.db || typeof this.db.explain !== 'function') {
        const entry: ReplEntry = {
          sql: text.trim(),
          line: 1,
          ms: 0,
          error: new Error(
            !this.db
              ? 'No database: set the element’s db property first'
              : 'Database does not support explain()',
          ),
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
          this.lastStats = await this.fetchStats();
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
          this.activeTab = 'plan';
          this.updateActiveTabButtons();
          this.inspectorOpen = true;
          this.renderInspector();
        }
      } finally {
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.dispatchEvent(
        new CustomEvent('firebird-repl-explain', {
          detail: entries,
          bubbles: true,
          composed: true,
        }),
      );
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

    async info(): Promise<ReplEntry | undefined> {
      const err =
        !this.db
          ? new Error('No database: set the element’s db property first')
          : typeof this.db.databaseInfo !== 'function'
            ? new Error('Database does not support databaseInfo()')
            : null;
      return this.runDiagnostic('DATABASE INFO', 'firebird-repl-info', err, async (entry) => {
        entry.info = await this.db!.databaseInfo!();
      });
    }

    async sweep(): Promise<ReplEntry | undefined> {
      const err =
        !this.db
          ? new Error('No database: set the element’s db property first')
          : typeof this.db.sweep !== 'function'
            ? new Error('Database does not support sweep()')
            : null;
      return this.runDiagnostic('SWEEP DATABASE', 'firebird-repl-sweep', err, async (entry) => {
        entry.sweep = await this.db!.sweep!();
      });
    }

    async schema(options?: IntrospectOptions): Promise<ReplEntry | undefined> {
      const err = !this.db ? new Error('No database: set the element’s db property first') : null;
      return this.runDiagnostic('INSPECT SCHEMA', 'firebird-repl-schema', err, async (entry) => {
        const result = await this.fetchSchema(options);
        this.lastMatViews = await fetchReplMaterializedViews(this.db!);
        this.lastSearchIndexes = await fetchReplSearchIndexes(this.db!);
        entry.schema = result;
        this.lastSchema = result;
        this.activeTab = 'schema';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      });
    }

    async migrations(
      options: Pick<MigrateOptions, 'tableName'> = {},
    ): Promise<ReplEntry | undefined> {
      const err = !this.db ? new Error('No database: set the element’s db property first') : null;
      return this.runDiagnostic(
        'INSPECT MIGRATIONS',
        'firebird-repl-migrations',
        err,
        async (entry) => {
          const list = await this.fetchMigrations(options);
          entry.migrations = list;
          this.lastMigrations = list;
          this.activeTab = 'migrations';
          this.updateActiveTabButtons();
          this.inspectorOpen = true;
          this.renderInspector();
        },
      );
    }

    async profiler(): Promise<ReplEntry | undefined> {
      const err = !this.db
        ? new Error('No database: set the element’s db property first')
        : typeof this.db.monitorStats !== 'function' && typeof this.db.databaseInfo !== 'function'
          ? new Error('Database does not support monitorStats()')
          : null;
      return this.runDiagnostic('MONITOR STATS', 'firebird-repl-profiler', err, async (entry) => {
        const stats = await this.fetchStats();
        if (stats) {
          entry.stats = stats;
          this.lastStats = stats;
        }
        this.lastJobQueueStats = await fetchReplJobQueueStats(this.db!);
        this.activeTab = 'profiler';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      });
    }

    async replication(): Promise<ReplEntry | undefined> {
      const err = !this.db ? new Error('No database: set the element’s db property first') : null;
      return this.runDiagnostic(
        'INSPECT REPLICATION',
        'firebird-repl-replication',
        err,
        async (entry) => {
          const info = await this.fetchReplication();
          this.lastAuditReport = await executeReplVerifyAuditChain(this.db!);
          entry.replication = info;
          this.lastReplication = info;
          this.activeTab = 'replication';
          this.updateActiveTabButtons();
          this.inspectorOpen = true;
          this.renderInspector();
        },
      );
    }

    async inspectArrow(sql?: string): Promise<ReplEntry | undefined> {
      const sqlLabel = (sql ?? this.editor.value ?? '').trim() || 'INSPECT ARROW';
      const err = !this.db ? new Error('No database: set the element’s db property first') : null;
      return this.runDiagnostic(sqlLabel, 'firebird-repl-arrow', err, async (entry) => {
        const info = await this.fetchArrowInspector(sql);
        entry.arrow = info;
        this.lastArrow = info;
        this.activeTab = 'arrow';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      });
    }

    async exportArrow(sql?: string): Promise<Uint8Array> {
      if (!this.db) {
        throw new Error('No database: set the element’s db property first');
      }
      const { targetSql, bytes } = await executeReplArrowExport(this.db, this.editor.value, sql);
      await this.inspectArrow(targetSql);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-arrow-export', {
          detail: { sql: targetSql, bytes, byteLength: bytes.byteLength },
          bubbles: true,
          composed: true,
        }),
      );
      return bytes;
    }

    async importArrow(
      tableName: string,
      source: ArrowIngestSource,
      options: LoadArrowIpcOptions = {},
    ): Promise<ArrowIngestResult> {
      if (!this.db) {
        throw new Error('No database: set the element’s db property first');
      }
      const { result, entry } = await executeReplArrowImport(this.db, tableName, source, options);
      this.show(entry);
      if (this.isInspectorOpen) {
        await this.refreshInspector();
      }
      this.dispatchEvent(
        new CustomEvent('firebird-repl-arrow-import', {
          detail: result,
          bubbles: true,
          composed: true,
        }),
      );
      return result;
    }

    async inspectOutbox(): Promise<ReplEntry | undefined> {
      if (!this.optStoreRef) {
        this.inspectorTab = 'outbox';
        this.inspectorOpen = true;
        this.renderInspector();
        return undefined;
      }
      const started = performance.now();
      await this.optStoreRef.hydrate();
      const snap = this.optStoreRef.getSnapshot();
      this.inspectorTab = 'outbox';
      this.inspectorOpen = true;
      this.renderInspector();
      const entry: ReplEntry = {
        sql: 'INSPECT OUTBOX',
        line: 1,
        ms: performance.now() - started,
        outbox: snap,
      };
      this.show(entry);
      return entry;
    }

    async editCell(
      tableName: string,
      keyValue: unknown,
      column: string,
      newValue: unknown,
      primaryKey = 'ID',
    ): Promise<void> {
      if (!this.db) {
        throw new Error('No database: set the element’s db property first');
      }
      const detail = await executeReplCellEdit(
        this.db,
        this.undoRedoRef,
        this.optStoreRef,
        tableName,
        keyValue,
        column,
        newValue,
        primaryKey,
      );
      if (this.isInspectorOpen) {
        await this.refreshInspector();
      }
      this.dispatchEvent(
        new CustomEvent('firebird-repl-cell-edit', {
          detail,
          bubbles: true,
          composed: true,
        }),
      );
    }

    async undo(): Promise<UndoRedoEntry | null> {
      if (!this.undoRedoRef) return null;
      const started = performance.now();
      const undone = await this.undoRedoRef.undo();
      if (undone) {
        this.show({
          sql: `UNDO (${undone.label})`,
          line: 1,
          ms: performance.now() - started,
          affectedRows: undone.operations.length,
        });
        if (this.isInspectorOpen) await this.refreshInspector();
      }
      return undone;
    }

    async redo(): Promise<UndoRedoEntry | null> {
      if (!this.undoRedoRef) return null;
      const started = performance.now();
      const redone = await this.undoRedoRef.redo();
      if (redone) {
        this.show({
          sql: `REDO (${redone.label})`,
          line: 1,
          ms: performance.now() - started,
          affectedRows: redone.operations.length,
        });
        if (this.isInspectorOpen) await this.refreshInspector();
      }
      return redone;
    }

    async materializedViews(): Promise<MaterializedViewInfo[]> {
      if (!this.db) return [];
      const views = await fetchReplMaterializedViews(this.db);
      this.lastMatViews = views;
      return views;
    }

    async refreshMaterializedView(name: string): Promise<void> {
      if (!this.db) return;
      const entry = await executeReplMatViewRefresh(this.db, name);
      if (entry) this.show(entry);
      if (this.isInspectorOpen) {
        await this.refreshInspector();
      }
    }

    async searchIndexes(): Promise<ReplSearchIndexSummary[]> {
      if (!this.db) return [];
      this.lastSearchIndexes = await fetchReplSearchIndexes(this.db);
      return this.lastSearchIndexes;
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

    async applySchemaPush(
      desiredSource: DeclarativeSchemaInput,
      options: { allowDestructive?: boolean } = {},
    ): Promise<SchemaSyncResult | null> {
      if (!this.db) return null;
      if (typeof desiredSource === 'string') this.schemaDiffDraft = desiredSource;
      const res = await executeReplSchemaDiff(this.db, desiredSource, {
        dryRun: false,
        allowDestructive: options.allowDestructive,
      });
      this.lastSchemaDiff = res;
      if (this.isInspectorOpen) await this.refreshInspector();
      return res;
    }

    async verifyAuditChain(
      options: {
        tableName?: string;
        verifyKey?: CryptoKey | string | Uint8Array;
        signAlgorithm?: AuditSignAlgorithm;
      } = {},
    ): Promise<AuditChainVerificationResult | null> {
      if (!this.db) return null;
      const report = await executeReplVerifyAuditChain(this.db, options);
      this.lastAuditReport = report;
      this.activeTab = 'replication';
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      this.renderInspector();
      this.dispatchEvent(
        new CustomEvent('firebird-repl-audit-verify', {
          detail: report,
          bubbles: true,
          composed: true,
        }),
      );
      return report;
    }

    mcpTools(options: { allowWrites?: boolean } = {}): McpToolDescriptor[] {
      return getReplMcpTools(this.db, Boolean(options.allowWrites));
    }

    async prometheusMetrics(): Promise<string> {
      const text = await exportReplPrometheusMetrics(this.db, this.replicatorHandle);
      this.lastPrometheusText = text;
      this.activeTab = 'profiler';
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      await this.refreshInspector();
      return text;
    }

    async adviseWorkload(
      extraQueries: readonly string[] = [],
    ): Promise<WorkloadAdvisorReport | null> {
      if (!this.db) return null;
      const queries =
        extraQueries.length > 0
          ? extraQueries
          : this.editor.value.trim()
            ? [this.editor.value.trim()]
            : [];
      const report = await executeReplWorkloadAdvisor(this.db, queries);
      this.lastAdvisorReport = report;
      this.activeTab = 'profiler';
      this.updateActiveTabButtons();
      this.inspectorOpen = true;
      await this.refreshInspector();
      return report;
    }

    async jobQueueStats(): Promise<JobQueueStats | null> {
      if (!this.db) return null;
      const st = await fetchReplJobQueueStats(this.db);
      this.lastJobQueueStats = st;
      if (this.isInspectorOpen && this.activeTab === 'profiler') {
        this.renderInspector();
      }
      return st;
    }

    private onKey(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.run();
        return;
      }
      const state = { cursor: this.cursor, draft: this.draft };
      stepReplHistoryKey(event, this.editor, this.history, state, () => {
        void this.run();
      });
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
      this.output.append(block);
      this.output.scrollTop = this.output.scrollHeight;
    }
  }

  customElements.define(tag, FirebirdRepl);
  return FirebirdRepl;
}
