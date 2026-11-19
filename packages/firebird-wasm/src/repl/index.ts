/**
 * firebird-wasm/repl – an interactive SQL console as a custom element.
 *
 * ```js
 * import { defineFirebirdRepl } from 'firebird-wasm/repl';
 *
 * defineFirebirdRepl();                       // registers <firebird-repl>
 * document.querySelector('firebird-repl').db = db;
 * ```
 *
 * A custom element, so it works the same in plain pages, React and Vue: give
 * it a database through its `db` property.  Type SQL, run it with
 * Ctrl+Enter (⌘+Enter on a Mac) or the Run button; a script runs statement by
 * statement (`SET TERM` included) and stops at the first error.  ArrowUp on
 * the first line and ArrowDown on the last walk the history.
 *
 * Every value is written as text, never as HTML, so a row cannot inject
 * markup into the page.  The element draws in its own shadow root; colours
 * follow `color-scheme` and can be set with `--firebird-repl-*` properties.
 *
 * Nothing runs on import: the class is made by {@link defineFirebirdRepl},
 * so importing this module where there is no DOM (Node, server rendering) is
 * harmless.
 */

import { splitStatements } from '../browser/sql-script';
import type { ScriptStatement } from '../browser/sql-script';
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
  ArrayRow,
  DatabaseInfo,
  ExplainOptions,
  FieldInfo,
  IntrospectOptions,
  MigrateOptions,
  MonitorStats,
  QueryResult,
  SchemaIntrospection,
  SweepResult,
} from '../types';
import type { ReplicationStats } from '../replication';
import type { ColumnarQueryResult } from '../columnar';
import type { SyncHandleLike } from '../frameworks/sync-store';
import type { OptimisticMutationStore, OptimisticStoreSnapshot } from '../optimistic-store';
import type { UndoRedoEntry, UndoRedoManager } from '../undo-redo';
import type { MaterializedViewInfo } from '../materialized-view';
import type { DeclarativeSchemaInput, SchemaSyncResult } from '../schema-sync';
import type { AuditChainVerificationResult, AuditSignAlgorithm } from '../audit-log';
import type { PresenceRoom } from '../replication/presence';
import type { ReplSearchIndexSummary } from './repl-actions';

export type { ReplSearchIndexSummary } from './repl-actions';
export type { AuditChainVerificationResult } from '../audit-log';

export {
  computeTableIoBreakdown,
  parseQueryPlan,
  type ParsedQueryPlan,
  type PlanAccessMethod,
  type PlanOperatorKind,
  type PlanTreeNode,
  type TableIoStats,
};

/** Active tab in the `<firebird-repl>` Schema Inspector, Migration Viewer, Profiler, Query Plan Explorer, Replication & Sync/Arrow Inspector sidebar. */
export type ReplInspectorTab =
  | 'schema'
  | 'migrations'
  | 'profiler'
  | 'plan'
  | 'replication'
  | 'arrow'
  | 'outbox';

export interface ReplEditableTableConfig {
  readonly table: string;
  readonly primaryKey?: string;
}

/** Columnar vector & Apache Arrow IPC stream summary displayed in `<firebird-repl>` (`M20 Item 4`). */
export interface ReplArrowInspectorInfo {
  readonly sql: string;
  readonly rowCount: number;
  readonly arrowIpcBytes: number;
  readonly vectors: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly sqlType: string;
    readonly nullCount: number;
    readonly bufferBytes: number;
  }>;
  readonly syncState?: {
    readonly state: string;
    readonly mode: string;
    readonly paused: boolean;
    readonly lagEntries: number;
    readonly replicaLsn: number;
    readonly primaryLsn: number;
  } | null;
}

/** Replication slot summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationSlotInfo {
  readonly slotName: string;
  readonly nodeId: string;
  readonly confirmedFlushLsn: number;
  readonly updatedAt: string;
}

/** Subscriber watermark summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationWatermarkInfo {
  readonly peerId: string;
  readonly lastLsn: number;
  readonly updatedAt: string;
}

/** Recent journal entry summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationJournalEntrySummary {
  readonly lsn: number;
  readonly originNode: string;
  readonly tableName: string;
  readonly op: string;
  readonly pkJson: string;
  readonly createdAt: string;
}

/** Quarantined Dead-Letter Queue (`FB_REPL_DLQ$`) entry summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationDlqEntrySummary {
  readonly lsn: number;
  readonly subName: string;
  readonly errorMessage: string;
  readonly retryCount: number;
  readonly quarantinedAt: string;
}

/** Native Firebird engine `RDB$PUBLICATIONS` / `RDB$PUBLICATION_TABLES` catalog summary displayed in `<firebird-repl>`. */
export interface ReplEnginePublicationInfo {
  readonly name: string;
  readonly active: boolean;
  readonly autoEnable: boolean;
  readonly publishedTables: readonly string[];
  readonly replicaMode: string | null;
  readonly replicationSequence: number | null;
}

/** Structured replication state returned by `el.replication()` in `<firebird-repl>`. */
export interface ReplReplicationInfo {
  readonly journalTableExists: boolean;
  readonly journalEntryCount: number;
  readonly minJournalLsn: number;
  readonly maxJournalLsn: number;
  readonly slots: ReplReplicationSlotInfo[];
  readonly watermarks: ReplReplicationWatermarkInfo[];
  readonly recentEntries: ReplReplicationJournalEntrySummary[];
  readonly dlqTableExists?: boolean;
  readonly dlqEntryCount?: number;
  readonly dlqEntries?: ReplReplicationDlqEntrySummary[];
  readonly enginePublication?: ReplEnginePublicationInfo | null;
  readonly liveStats?: ReplicationStats | null;
}

/** What the console needs of a database: `FirebirdBrowser` has it. */
export interface ReplDatabase {
  query(
    sql: string,
    params: unknown[],
    options: { rowMode: 'array' },
  ): Promise<QueryResult<ArrayRow>>;
  /** Whether a statement yields rows, before running it. */
  describeQuery(sql: string): Promise<{ hasResultSet: boolean }>;
  /** Return the execution plan for `sql` without running it. */
  explain?(sql: string, options?: ExplainOptions): Promise<string>;
  /** Inspect database diagnostics and transaction counters. */
  databaseInfo?(): Promise<DatabaseInfo>;
  /** Trigger an immediate garbage-collection sweep and return before/after diagnostics. */
  sweep?(): Promise<SweepResult>;
  /** Introspect database tables, views, columns, keys, indexes, sequences, and triggers. */
  introspect?(options?: IntrospectOptions): Promise<SchemaIntrospection>;
  /** Inspect cumulative query telemetry, page I/O counters, and `MON$` state. */
  monitorStats?(): Promise<MonitorStats>;
  /** Reset cumulative query telemetry counters. */
  resetMonitorStats?(): void;
  /** Optional zero-copy columnar query execution (`M19 Item 2` / `M20 Item 4`). */
  queryColumnar?(sql: string, params?: unknown[]): Promise<ColumnarQueryResult>;
  /** Optional Apache Arrow IPC V5 query execution (`M19 Item 2` / `M20 Item 4`). */
  queryArrow?(sql: string, params?: unknown[]): Promise<Uint8Array>;
  /** Optional zero-copy Apache Arrow IPC V5 ingestion (`M22 Item 2` / `M22 Item 4`). */
  loadArrowIpc?(
    tableName: string,
    source: ArrowIngestSource,
    options?: LoadArrowIpcOptions,
  ): Promise<ArrowIngestResult>;
  execBatch?(sql: string, rows: unknown[][]): Promise<{ affectedRows: number } | void>;
  execute?(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
  listMaterializedViews?(): Promise<MaterializedViewInfo[]>;
  /**
   * For a statement without rows: a transaction's `exec()` runs exactly one
   * statement and reports what it changed.  (`FirebirdBrowser.exec()` would
   * split the statement again, cutting a PSQL body at its semicolons.)
   */
  transaction<T>(
    fn: (tx: { exec(sql: string): Promise<{ affectedRows: number }> }) => Promise<T>,
  ): Promise<T>;
}

/** One statement the console ran, as it reports it in `firebird-repl-run`. */
export interface ReplEntry {
  sql: string;
  /** 1-based line of the statement in what was run. */
  line: number;
  /** Milliseconds the statement took. */
  ms: number;
  fields?: FieldInfo[];
  rows?: ArrayRow[];
  affectedRows?: number;
  plan?: string;
  planTree?: ParsedQueryPlan;
  info?: DatabaseInfo;
  sweep?: SweepResult;
  schema?: SchemaIntrospection;
  migrations?: AppliedMigration[];
  stats?: MonitorStats;
  replication?: ReplReplicationInfo;
  arrow?: ReplArrowInspectorInfo;
  outbox?: OptimisticStoreSnapshot;
  error?: Error;
}

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
  /** Toggle (or switch to `tab` in) the interactive Schema Inspector, Migration Viewer, Profiler & Plan Explorer sidebar. */
  toggleInspector(tab?: ReplInspectorTab): Promise<void>;
  /** Refresh the interactive Schema Inspector, Migration Viewer, Profiler & Plan Explorer sidebar from the database. */
  refreshInspector(): Promise<void>;
  /** Empty the output. */
  clear(): void;
}

import { asError } from './repl-styles';
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
  executeReplMatViewRefresh,
  executeReplSchemaDiff,
  fetchReplSearchIndexes,
  stepReplHistoryKey,
  triggerArrowBrowserDownload,
} from './repl-actions';
import { renderReplEntryBlock } from './repl-entry-renderer';
import {
  executeReplVerifyAuditChain,
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
        onResetProfiler: () => {
          if (this.db && typeof this.db.resetMonitorStats === "function") {
            this.db.resetMonitorStats();
            void this.refreshInspector();
          }
        },
        onVerifyAudit: () => {
          void this.verifyAuditChain();
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

      const entries: ReplEntry[] = [];
      try {
        let statements: ScriptStatement[];
        try {
          statements = splitStatements(text);
        } catch (err) {
          statements = [];
          const entry: ReplEntry = {
            sql: text.trim(),
            line: 1,
            ms: 0,
            error: asError(err),
          };
          entries.push(entry);
          this.show(entry);
        }
        for (const statement of statements) {
          const started = performance.now();
          const entry: ReplEntry = {
            sql: statement.sql,
            line: statement.line,
            ms: 0,
          };
          try {
            const db = this.db;
            const { hasResultSet } = await db.describeQuery(statement.sql);
            if (hasResultSet) {
              const result = await db.query(statement.sql, [], {
                rowMode: 'array',
              });
              entry.fields = result.fields;
              entry.rows = result.rows;
            } else {
              entry.affectedRows = (
                await db.transaction((tx) => tx.exec(statement.sql))
              ).affectedRows;
            }
          } catch (err) {
            entry.error = asError(err);
          }
          entry.ms = performance.now() - started;
          entries.push(entry);
          this.show(entry);
          if (entry.error) break;
        }
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

      const entries: ReplEntry[] = [];
      try {
        let statements: ScriptStatement[];
        try {
          statements = splitStatements(text);
        } catch (err) {
          statements = [];
          const entry: ReplEntry = {
            sql: text.trim(),
            line: 1,
            ms: 0,
            error: asError(err),
          };
          entries.push(entry);
          this.show(entry);
        }

        // Refresh stats if available so table I/O can be attributed to plan nodes
        try {
          this.lastStats = await this.fetchStats();
        } catch {
          // Ignore if monitorStats is unavailable
        }

        const explainedPlans: Array<{ sql: string; parsed: ParsedQueryPlan }> = [];
        for (const statement of statements) {
          const started = performance.now();
          const entry: ReplEntry = {
            sql: statement.sql,
            line: statement.line,
            ms: 0,
          };
          try {
            entry.plan = await this.db.explain(statement.sql, options);
            entry.planTree = parseQueryPlan(entry.plan, this.lastStats);
            explainedPlans.push({
              sql: statement.sql,
              parsed: entry.planTree,
            });
          } catch (err) {
            entry.error = asError(err);
          }
          entry.ms = performance.now() - started;
          entries.push(entry);
          this.show(entry);
          if (entry.error) break;
        }

        if (explainedPlans.length > 0) {
          this.lastPlans = explainedPlans;
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
