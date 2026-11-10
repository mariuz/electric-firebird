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
  DEFAULT_MIGRATIONS_TABLE,
  introspect as introspectCatalog,
} from '../browser/schema';
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
  Row,
  SchemaIntrospection,
  SweepResult,
} from '../types';
import {
  DEFAULT_REPL_DLQ_TABLE,
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_SLOTS_TABLE,
  DEFAULT_REPL_WATERMARK_TABLE,
  type ReplicationStats,
} from '../replication';

export {
  computeTableIoBreakdown,
  parseQueryPlan,
  type ParsedQueryPlan,
  type PlanAccessMethod,
  type PlanOperatorKind,
  type PlanTreeNode,
  type TableIoStats,
};

/** Active tab in the `<firebird-repl>` Schema Inspector, Migration Viewer, Profiler, Query Plan Explorer & Replication Inspector sidebar. */
export type ReplInspectorTab =
  | 'schema'
  | 'migrations'
  | 'profiler'
  | 'plan'
  | 'replication';

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
  error?: Error;
}

/** The element's own API, beyond HTMLElement's. */
export interface FirebirdReplElement extends HTMLElement {
  /** The database statements run against. */
  db: ReplDatabase | null;
  /** Optional `DatabaseReplicator` or `ReplicationSubscription` providing live `stats()` telemetry. */
  replicator?: { stats(): Promise<ReplicationStats> } | null;
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
  /** Toggle (or switch to `tab` in) the interactive Schema Inspector, Migration Viewer, Profiler & Plan Explorer sidebar. */
  toggleInspector(tab?: ReplInspectorTab): Promise<void>;
  /** Refresh the interactive Schema Inspector, Migration Viewer, Profiler & Plan Explorer sidebar from the database. */
  refreshInspector(): Promise<void>;
  /** Empty the output. */
  clear(): void;
}

/** At most this many rows of one result are drawn; the rest are counted. */
const MAX_ROWS = 500;

const STYLE = `
:host {
  --firebird-repl-bg: Canvas;
  --firebird-repl-fg: CanvasText;
  --firebird-repl-muted: color-mix(in srgb, CanvasText 55%, Canvas);
  --firebird-repl-border: color-mix(in srgb, CanvasText 18%, Canvas);
  --firebird-repl-error: #c62828;
  --firebird-repl-accent: #b71c1c;
  --firebird-repl-font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: flex;
  flex-direction: column;
  color-scheme: light dark;
  background: var(--firebird-repl-bg);
  color: var(--firebird-repl-fg);
  font: 13px/1.45 var(--firebird-repl-font);
  border: 1px solid var(--firebird-repl-border);
  border-radius: 6px;
  min-height: 12rem;
  overflow: hidden;
}
.workspace { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.output { flex: 1; overflow: auto; padding: 0.5rem 0.75rem; min-width: 0; }
.inspector {
  width: 24rem; max-width: 50%; border-left: 1px solid var(--firebird-repl-border);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
.inspector[hidden] { display: none; }
.inspector-header {
  display: flex; align-items: center; border-bottom: 1px solid var(--firebird-repl-border);
  min-height: 2rem;
}
.inspector-tabs { display: flex; flex: 1; overflow-x: auto; }
.inspector-header button {
  padding: 0.25rem 0.6rem; border-left: 0; border-right: 1px solid var(--firebird-repl-border);
}
.inspector-header button.active {
  font-weight: 600; text-decoration: underline;
}
.inspector-actions { display: flex; margin-left: auto; }
.inspector-actions button {
  border-right: 0; border-left: 1px solid var(--firebird-repl-border); padding: 0.25rem 0.55rem;
}
.inspector-body { flex: 1; overflow: auto; padding: 0.5rem 0.65rem; }
.inspector-summary { color: var(--firebird-repl-muted); margin: 0 0 0.5rem; font-size: 12px; }
.inspector-empty { color: var(--firebird-repl-muted); font-style: italic; margin: 0.25rem 0; }
.schema-group-title {
  font-weight: 600; margin: 0.5rem 0 0.25rem; font-size: 12px;
  text-transform: uppercase; color: var(--firebird-repl-muted);
}
details.schema-table, details.schema-view, details.plan-node {
  border: 1px solid var(--firebird-repl-border); border-radius: 4px;
  margin: 0 0 0.35rem; padding: 0.2rem 0.45rem;
}
details.plan-node details.plan-node {
  margin-top: 0.25rem; margin-left: 0.4rem;
}
summary.schema-item-header, summary.plan-node-header {
  cursor: pointer; display: flex; align-items: center; gap: 0.35rem; font-weight: 600; flex-wrap: wrap;
}
summary.schema-item-header button.schema-query-btn {
  margin-left: auto; border: 1px solid var(--firebird-repl-border); border-radius: 3px;
  padding: 0 0.35rem; font-size: 11px; line-height: 1.4;
}
.schema-badge {
  color: var(--firebird-repl-muted); font-weight: 400; font-size: 11px;
}
.schema-sub { margin: 0.25rem 0 0.15rem; font-size: 12px; }
.schema-sub-label { color: var(--firebird-repl-muted); font-weight: 600; }
ul.schema-list, ol.migrations-list {
  list-style: none; padding: 0; margin: 0.15rem 0 0.25rem;
}
li.schema-col, li.schema-meta-item, li.migration-item {
  padding: 0.1rem 0; display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: baseline;
  border-top: 1px dotted var(--firebird-repl-border);
}
li.schema-col:first-child, li.schema-meta-item:first-child, li.migration-item:first-child {
  border-top: 0;
}
.col-name, .migration-version { font-weight: 600; }
.col-type { color: var(--firebird-repl-muted); }
.col-flag, .plan-badge-warn {
  font-size: 11px; padding: 0 0.25rem; border: 1px solid var(--firebird-repl-border);
  border-radius: 3px; color: var(--firebird-repl-accent);
}
.plan-badge-index {
  font-size: 11px; padding: 0 0.25rem; border: 1px solid var(--firebird-repl-border);
  border-radius: 3px; color: var(--firebird-repl-fg);
}
.flamegraph {
  display: flex; flex-direction: column; gap: 0.2rem; margin: 0.25rem 0 0.5rem;
}
.flame-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 0.4rem;
  padding: 0.15rem 0.4rem; border: 1px solid var(--firebird-repl-border); border-radius: 3px;
  font-size: 11px; background: color-mix(in srgb, var(--firebird-repl-accent) 14%, transparent);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.flame-bar.natural {
  background: color-mix(in srgb, var(--firebird-repl-error) 22%, transparent);
  border-color: var(--firebird-repl-error);
}
.schema-view-source {
  white-space: pre-wrap; margin: 0.2rem 0 0; font-size: 11px; color: var(--firebird-repl-muted);
}
.entry { margin: 0 0 0.75rem; }
.sql { white-space: pre-wrap; margin: 0; }
.sql::before { content: '> '; color: var(--firebird-repl-muted); }
.meta { color: var(--firebird-repl-muted); margin: 0.15rem 0 0; }
.plan { white-space: pre-wrap; margin: 0.2rem 0 0; }
.error { color: var(--firebird-repl-error); white-space: pre-wrap; margin: 0.15rem 0 0; }
.table { overflow-x: auto; margin-top: 0.25rem; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--firebird-repl-border); padding: 0.1rem 0.5rem; text-align: left; vertical-align: top; white-space: pre; }
th { font-weight: 600; }
td.num { text-align: right; }
.null { color: var(--firebird-repl-muted); font-style: italic; }
.input { display: flex; border-top: 1px solid var(--firebird-repl-border); }
textarea {
  flex: 1; resize: vertical; min-height: 3.5rem; border: 0; padding: 0.5rem 0.75rem;
  background: transparent; color: inherit; font: inherit; outline: none;
}
button {
  font: inherit; border: 0; border-left: 1px solid var(--firebird-repl-border);
  background: transparent; color: var(--firebird-repl-accent); padding: 0 1rem; cursor: pointer;
}
button:disabled { color: var(--firebird-repl-muted); cursor: default; }
`;

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
    private readonly output: HTMLDivElement;
    private readonly inspector: HTMLDivElement;
    private readonly inspectorBody: HTMLDivElement;
    private readonly tabSchemaBtn: HTMLButtonElement;
    private readonly tabMigrationsBtn: HTMLButtonElement;
    private readonly tabProfilerBtn: HTMLButtonElement;
    private readonly tabPlanBtn: HTMLButtonElement;
    private readonly tabReplicationBtn: HTMLButtonElement;
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
    private readonly history: string[] = [];
    /** Position in `history` while walking it; `history.length` is the draft. */
    private cursor = 0;
    private draft = '';
    private busy = false;
    private isInspectorOpen = false;
    private activeTab: ReplInspectorTab = 'schema';
    private lastSchema: SchemaIntrospection | null = null;
    private lastMigrations: AppliedMigration[] = [];
    private lastStats: MonitorStats | null = null;
    private lastPlans: Array<{ sql: string; parsed: ParsedQueryPlan }> = [];
    private lastReplication: ReplReplicationInfo | null = null;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;

      const workspace = el('div', 'workspace');
      this.output = el('div', 'output');
      this.output.setAttribute('role', 'log');
      this.output.setAttribute('aria-live', 'polite');

      this.inspector = el('div', 'inspector');
      this.inspector.hidden = true;
      this.inspector.setAttribute(
        'aria-label',
        'Schema, migrations, profiler, and query plan inspector',
      );

      const inspectorHeader = el('div', 'inspector-header');
      const inspectorTabs = el('div', 'inspector-tabs');
      this.tabSchemaBtn = document.createElement('button');
      this.tabSchemaBtn.type = 'button';
      this.tabSchemaBtn.className = 'tab-schema active';
      this.tabSchemaBtn.textContent = 'Schema';

      this.tabMigrationsBtn = document.createElement('button');
      this.tabMigrationsBtn.type = 'button';
      this.tabMigrationsBtn.className = 'tab-migrations';
      this.tabMigrationsBtn.textContent = 'Migrations';

      this.tabProfilerBtn = document.createElement('button');
      this.tabProfilerBtn.type = 'button';
      this.tabProfilerBtn.className = 'tab-profiler';
      this.tabProfilerBtn.textContent = 'Profiler';

      this.tabPlanBtn = document.createElement('button');
      this.tabPlanBtn.type = 'button';
      this.tabPlanBtn.className = 'tab-plan';
      this.tabPlanBtn.textContent = 'Plan';

      this.tabReplicationBtn = document.createElement('button');
      this.tabReplicationBtn.type = 'button';
      this.tabReplicationBtn.className = 'tab-replication';
      this.tabReplicationBtn.textContent = 'Replication';

      inspectorTabs.append(
        this.tabSchemaBtn,
        this.tabMigrationsBtn,
        this.tabProfilerBtn,
        this.tabPlanBtn,
        this.tabReplicationBtn,
      );

      const inspectorActions = el('div', 'inspector-actions');
      this.inspectorRefreshBtn = document.createElement('button');
      this.inspectorRefreshBtn.type = 'button';
      this.inspectorRefreshBtn.className = 'inspector-refresh';
      this.inspectorRefreshBtn.textContent = 'Refresh';
      this.inspectorRefreshBtn.title = 'Refresh schema, migrations, profiler, and plan';

      this.inspectorCloseBtn = document.createElement('button');
      this.inspectorCloseBtn.type = 'button';
      this.inspectorCloseBtn.className = 'inspector-close';
      this.inspectorCloseBtn.textContent = '×';
      this.inspectorCloseBtn.title = 'Close inspector';
      inspectorActions.append(this.inspectorRefreshBtn, this.inspectorCloseBtn);

      inspectorHeader.append(inspectorTabs, inspectorActions);
      this.inspectorBody = el('div', 'inspector-body');
      this.inspector.append(inspectorHeader, this.inspectorBody);

      workspace.append(this.output, this.inspector);

      const input = el('div', 'input');
      this.editor = document.createElement('textarea');
      this.editor.spellcheck = false;
      this.editor.placeholder = 'SQL; Ctrl+Enter runs it';
      this.editor.setAttribute('aria-label', 'SQL');

      this.schemaButton = document.createElement('button');
      this.schemaButton.type = 'button';
      this.schemaButton.className = 'schema';
      this.schemaButton.textContent = 'Schema';
      this.schemaButton.title = 'Inspect tables, columns, keys, indexes, sequences, and triggers';

      this.migrationsButton = document.createElement('button');
      this.migrationsButton.type = 'button';
      this.migrationsButton.className = 'migrations';
      this.migrationsButton.textContent = 'Migrations';
      this.migrationsButton.title = 'Inspect applied schema migrations (FB_MIGRATIONS$)';

      this.profilerButton = document.createElement('button');
      this.profilerButton.type = 'button';
      this.profilerButton.className = 'profiler';
      this.profilerButton.textContent = 'Profiler';
      this.profilerButton.title = 'Inspect query telemetry, cache hits, and MON$ monitoring counters';

      this.replicationButton = document.createElement('button');
      this.replicationButton.type = 'button';
      this.replicationButton.className = 'replication';
      this.replicationButton.textContent = 'Replication';
      this.replicationButton.title = 'Inspect replication journal, slots, watermarks, and lag telemetry';

      this.sweepButton = document.createElement('button');
      this.sweepButton.type = 'button';
      this.sweepButton.className = 'sweep';
      this.sweepButton.textContent = 'Sweep';
      this.sweepButton.title = 'Run garbage-collection sweep and advance OIT';

      this.infoButton = document.createElement('button');
      this.infoButton.type = 'button';
      this.infoButton.className = 'info';
      this.infoButton.textContent = 'Info';
      this.infoButton.title = 'Inspect database diagnostics and transaction counters';

      this.explainButton = document.createElement('button');
      this.explainButton.type = 'button';
      this.explainButton.className = 'explain';
      this.explainButton.textContent = 'Explain';
      this.explainButton.title = 'Explain query plan (Shift+click for detailed plan)';

      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.textContent = 'Run';

      input.append(
        this.editor,
        this.schemaButton,
        this.migrationsButton,
        this.profilerButton,
        this.replicationButton,
        this.sweepButton,
        this.infoButton,
        this.explainButton,
        this.button,
      );
      root.append(style, workspace, input);

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
      for (const name of ['db', 'replicator', 'value', 'inspectorOpen', 'inspectorTab'] as const) {
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
      this.inspectorRefreshBtn.disabled = disabled;
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
        } else if (this.activeTab === 'migrations') {
          this.lastMigrations = await this.fetchMigrations();
        } else if (this.activeTab === 'profiler' || this.activeTab === 'plan') {
          this.lastStats = await this.fetchStats();
        } else if (this.activeTab === 'replication') {
          this.lastReplication = await this.fetchReplication();
        }
      } catch {
        // Keep previous state on transient failure.
      }
      this.renderInspector();
    }

    private async fetchSchema(
      options?: IntrospectOptions,
    ): Promise<SchemaIntrospection> {
      const db = this.db!;
      if (typeof db.introspect === 'function') {
        return db.introspect(options);
      }
      return introspectCatalog(
        {
          query: async <T = Row>(sqlText: string, params: unknown[] = []) => {
            const res = await db.query(sqlText, params, { rowMode: 'array' });
            const objRows = res.rows.map((cols) =>
              Object.fromEntries(res.fields.map((f, idx) => [f.name, cols[idx]])),
            ) as unknown as T[];
            return { fields: res.fields, rows: objRows };
          },
          exec: async () => undefined,
        },
        options,
      );
    }

    private async fetchMigrations(
      options: Pick<MigrateOptions, 'tableName'> = {},
    ): Promise<AppliedMigration[]> {
      const db = this.db!;
      const rawName = (options.tableName ?? DEFAULT_MIGRATIONS_TABLE).trim();
      const rawUpper = rawName.toUpperCase();
      const quoted = `"${rawUpper.replace(/"/g, '""')}"`;

      const exists = await db.query(
        'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
        [rawUpper],
        { rowMode: 'array' },
      );
      if (exists.rows.length === 0) {
        return [];
      }

      const res = await db.query(
        `SELECT VERSION, NAME, APPLIED_AT FROM ${quoted} ORDER BY SEQ ASC, VERSION ASC`,
        [],
        { rowMode: 'array' },
      );
      return res.rows.map((row) => ({
        version: String(row[0] ?? '').trim(),
        name:
          row[1] !== null && row[1] !== undefined && String(row[1]).trim() !== ''
            ? String(row[1]).trim()
            : null,
        appliedAt: String(row[2] ?? '').trim(),
      }));
    }

    private async fetchStats(): Promise<MonitorStats | null> {
      const db = this.db!;
      if (typeof db.monitorStats === 'function') {
        return db.monitorStats();
      }
      if (typeof db.databaseInfo === 'function') {
        const info = await db.databaseInfo();
        return {
          totalQueries: 0,
          totalExecs: 0,
          totalErrors: 0,
          totalDurationMs: 0,
          avgDurationMs: 0,
          maxDurationMs: 0,
          slowestSql: null,
          prepareCacheHits: 0,
          prepareCacheMisses: 0,
          prepareCacheHitRate: 0,
          io: {
            reads: info.reads,
            writes: info.writes,
            fetches: info.fetches,
            marks: info.marks,
            pageBuffers: info.pageBuffers,
            currentMemory: info.currentMemory,
            maxMemory: info.maxMemory,
          },
          transactions: {
            oldestTransaction: info.oldestTransaction,
            oldestActive: info.oldestActive,
            oldestSnapshot: info.oldestSnapshot,
            nextTransaction: info.nextTransaction,
            transactionGap: info.transactionGap,
          },
          activeStatements: 0,
          recentQueries: [],
        };
      }
      return null;
    }

    private async fetchReplication(): Promise<ReplReplicationInfo> {
      const db = this.db!;
      const relRes = await db.query(
        `SELECT TRIM(RDB$RELATION_NAME) AS REL_NAME
         FROM RDB$RELATIONS
         WHERE TRIM(RDB$RELATION_NAME) IN (?, ?, ?, ?)`,
        [
          DEFAULT_REPL_JOURNAL_TABLE,
          DEFAULT_REPL_SLOTS_TABLE,
          DEFAULT_REPL_WATERMARK_TABLE,
          DEFAULT_REPL_DLQ_TABLE,
        ],
        { rowMode: 'array' },
      );
      const existingTables = new Set(
        relRes.rows.map((r) => String(r[0] ?? '').trim().toUpperCase()),
      );

      let journalEntryCount = 0;
      let minJournalLsn = 0;
      let maxJournalLsn = 0;
      const recentEntries: ReplReplicationJournalEntrySummary[] = [];

      if (existingTables.has(DEFAULT_REPL_JOURNAL_TABLE)) {
        const jQuoted = `"${DEFAULT_REPL_JOURNAL_TABLE}"`;
        const statsRes = await db.query(
          `SELECT COUNT(*), COALESCE(MIN(LSN), 0), COALESCE(MAX(LSN), 0) FROM ${jQuoted}`,
          [],
          { rowMode: 'array' },
        );
        const sRow = statsRes.rows[0];
        if (sRow) {
          journalEntryCount = Number(sRow[0] ?? 0);
          minJournalLsn = Number(sRow[1] ?? 0);
          maxJournalLsn = Number(sRow[2] ?? 0);
        }

        const recentRes = await db.query(
          `SELECT LSN, ORIGIN_NODE, TABLE_NAME, OP, PK_JSON, CREATED_AT
           FROM ${jQuoted}
           ORDER BY LSN DESC
           ROWS 20`,
          [],
          { rowMode: 'array' },
        );
        for (const r of recentRes.rows) {
          recentEntries.push({
            lsn: Number(r[0] ?? 0),
            originNode: String(r[1] ?? '').trim(),
            tableName: String(r[2] ?? '').trim(),
            op: String(r[3] ?? '').trim(),
            pkJson: String(r[4] ?? '').trim(),
            createdAt: String(r[5] ?? '').trim(),
          });
        }
      }

      const slots: ReplReplicationSlotInfo[] = [];
      if (existingTables.has(DEFAULT_REPL_SLOTS_TABLE)) {
        const sQuoted = `"${DEFAULT_REPL_SLOTS_TABLE}"`;
        const slotRes = await db.query(
          `SELECT SLOT_NAME, NODE_ID, CONFIRMED_FLUSH_LSN, UPDATED_AT
           FROM ${sQuoted}
           ORDER BY SLOT_NAME ASC`,
          [],
          { rowMode: 'array' },
        );
        for (const r of slotRes.rows) {
          slots.push({
            slotName: String(r[0] ?? '').trim(),
            nodeId: String(r[1] ?? '').trim(),
            confirmedFlushLsn: Number(r[2] ?? 0),
            updatedAt: String(r[3] ?? '').trim(),
          });
        }
      }

      const watermarks: ReplReplicationWatermarkInfo[] = [];
      if (existingTables.has(DEFAULT_REPL_WATERMARK_TABLE)) {
        const wQuoted = `"${DEFAULT_REPL_WATERMARK_TABLE}"`;
        const wmRes = await db.query(
          `SELECT PEER_ID, LAST_LSN, UPDATED_AT
           FROM ${wQuoted}
           ORDER BY PEER_ID ASC`,
          [],
          { rowMode: 'array' },
        );
        for (const r of wmRes.rows) {
          watermarks.push({
            peerId: String(r[0] ?? '').trim(),
            lastLsn: Number(r[1] ?? 0),
            updatedAt: String(r[2] ?? '').trim(),
          });
        }
      }

      const dlqEntries: ReplReplicationDlqEntrySummary[] = [];
      if (existingTables.has(DEFAULT_REPL_DLQ_TABLE)) {
        const dQuoted = `"${DEFAULT_REPL_DLQ_TABLE}"`;
        const dlqRes = await db.query(
          `SELECT LSN, SUB_NAME, ERROR_MSG, RETRY_COUNT, QUARANTINED_AT
           FROM ${dQuoted}
           ORDER BY LSN ASC`,
          [],
          { rowMode: 'array' },
        );
        for (const r of dlqRes.rows) {
          dlqEntries.push({
            lsn: Number(r[0] ?? 0),
            subName: String(r[1] ?? '').trim(),
            errorMessage: String(r[2] ?? '').trim(),
            retryCount: Number(r[3] ?? 0),
            quarantinedAt: String(r[4] ?? '').trim(),
          });
        }
      }

      let enginePublication: ReplEnginePublicationInfo | null = null;
      try {
        const pubRes = await db.query(
          `SELECT TRIM(RDB$PUBLICATION_NAME), RDB$ACTIVE_FLAG, RDB$AUTO_ENABLE
           FROM RDB$PUBLICATIONS`,
          [],
          { rowMode: 'array' },
        );
        const pubRow = pubRes.rows[0];
        if (pubRow) {
          const pubName = String(pubRow[0] ?? 'RDB$DEFAULT').trim() || 'RDB$DEFAULT';
          const active = Number(pubRow[1] ?? 0) === 1;
          const autoEnable = Number(pubRow[2] ?? 0) === 1;

          const publishedTables: string[] = [];
          try {
            const tblRes = await db.query(
              `SELECT TRIM(RDB$TABLE_NAME)
               FROM RDB$PUBLICATION_TABLES
               ORDER BY RDB$TABLE_NAME`,
              [],
              { rowMode: 'array' },
            );
            for (const tr of tblRes.rows) {
              const tName = String(tr[0] ?? '').trim().toUpperCase();
              if (tName) publishedTables.push(tName);
            }
          } catch {
            // Ignore if RDB$PUBLICATION_TABLES is unavailable
          }

          let replicaMode: string | null = null;
          let replicationSequence: number | null = null;
          try {
            const ctxRes = await db.query(
              `SELECT RDB$GET_CONTEXT('SYSTEM', 'REPLICA_MODE'),
                      RDB$GET_CONTEXT('SYSTEM', 'REPLICATION_SEQUENCE')
               FROM RDB$DATABASE`,
              [],
              { rowMode: 'array' },
            );
            const ctxRow = ctxRes.rows[0];
            if (ctxRow) {
              if (ctxRow[0] !== null && ctxRow[0] !== undefined) {
                replicaMode = String(ctxRow[0]).trim();
              }
              if (ctxRow[1] !== null && ctxRow[1] !== undefined) {
                const parsedSeq = Number(ctxRow[1]);
                if (Number.isFinite(parsedSeq)) {
                  replicationSequence = parsedSeq;
                }
              }
            }
          } catch {
            // Ignore if SYSTEM context variables are unavailable
          }

          enginePublication = {
            name: pubName,
            active,
            autoEnable,
            publishedTables,
            replicaMode,
            replicationSequence,
          };
        }
      } catch {
        enginePublication = null;
      }

      let liveStats: ReplicationStats | null = null;
      if (this.replicatorHandle && typeof this.replicatorHandle.stats === 'function') {
        try {
          liveStats = await this.replicatorHandle.stats();
        } catch {
          liveStats = null;
        }
      }

      return {
        journalTableExists: existingTables.has(DEFAULT_REPL_JOURNAL_TABLE),
        journalEntryCount,
        minJournalLsn,
        maxJournalLsn,
        slots,
        watermarks,
        recentEntries,
        dlqTableExists: existingTables.has(DEFAULT_REPL_DLQ_TABLE),
        dlqEntryCount: dlqEntries.length,
        dlqEntries,
        enginePublication,
        liveStats,
      };
    }

    private renderPlanTreeNode(node: PlanTreeNode): HTMLElement {
      const details = el('details', 'plan-node');
      details.open = true;

      const summaryNode = el('summary', 'plan-node-header');
      const labelSpan = el('span', 'plan-node-label');
      labelSpan.textContent = node.label;
      summaryNode.append(labelSpan);

      if (node.accessMethod === 'NATURAL') {
        const warnBadge = el('span', 'plan-badge-warn');
        warnBadge.textContent = 'NATURAL SCAN';
        summaryNode.append(warnBadge);
      } else if (node.accessMethod && node.indexNames.length > 0) {
        const idxBadge = el('span', 'plan-badge-index');
        idxBadge.textContent = `${node.accessMethod}: ${node.indexNames.join(', ')}`;
        summaryNode.append(idxBadge);
      }

      const pct = Math.round(node.weightFraction * 100);
      const weightBadge = el('span', 'schema-badge plan-node-weight');
      weightBadge.textContent = `${pct}% (w:${node.estimatedWeight})`;
      summaryNode.append(weightBadge);

      if (node.tableIo) {
        const ioBadge = el('span', 'schema-badge plan-node-io');
        ioBadge.textContent = `fetches:${node.tableIo.fetches} reads:${node.tableIo.reads}`;
        summaryNode.append(ioBadge);
      }

      details.append(summaryNode);

      if (node.warnings.length > 0) {
        for (const w of node.warnings) {
          const warnEl = el('p', 'inspector-summary plan-warning');
          warnEl.textContent = `⚠ ${w}`;
          details.append(warnEl);
        }
      }

      for (const child of node.children) {
        details.append(this.renderPlanTreeNode(child));
      }

      return details;
    }

    private renderPlanExplorerPanel(): HTMLElement {
      const panel = el('div', 'inspector-plan');
      if (this.lastPlans.length === 0) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No query plan explained yet. Click Explain to analyze a query.';
        panel.append(empty);
        return panel;
      }

      for (const item of this.lastPlans) {
        const parsed = item.parsed;
        const sqlHeader = el('div', 'schema-group-title');
        sqlHeader.textContent = item.sql;
        panel.append(sqlHeader);

        const summaryEl = el('p', 'inspector-summary');
        summaryEl.textContent =
          `${parsed.format} plan · ${parsed.nodes.length} ${parsed.nodes.length === 1 ? 'node' : 'nodes'} · ` +
          `${parsed.indexScanCount} index ${parsed.indexScanCount === 1 ? 'scan' : 'scans'} · ` +
          `${parsed.naturalScanCount} natural ${parsed.naturalScanCount === 1 ? 'scan' : 'scans'}`;
        panel.append(summaryEl);

        // 1. Flamegraph visualization
        const flameTitle = el('div', 'schema-sub-label');
        flameTitle.textContent = 'Cost Flamegraph:';
        panel.append(flameTitle);

        const flameWrap = el('div', 'flamegraph');
        for (const n of parsed.nodes) {
          const pct = Math.max(8, Math.round(n.weightFraction * 100));
          const bar = el(
            'div',
            `flame-bar${n.accessMethod === 'NATURAL' ? ' natural' : ''}`,
          );
          bar.setAttribute('style', `width: ${pct}%; margin-left: ${n.depth * 6}px`);
          const nameSpan = el('span', 'flame-label');
          nameSpan.textContent = n.label;
          const pctSpan = el('span', 'schema-badge flame-pct');
          pctSpan.textContent = `${Math.round(n.weightFraction * 100)}%`;
          bar.append(nameSpan, pctSpan);
          flameWrap.append(bar);
        }
        panel.append(flameWrap);

        // 2. Interactive collapsible Plan Tree
        const treeTitle = el('div', 'schema-sub-label');
        treeTitle.textContent = 'Plan Tree:';
        panel.append(treeTitle);
        panel.append(this.renderPlanTreeNode(parsed.root));
      }

      return panel;
    }

    private renderInspector(): void {
      this.inspectorBody.replaceChildren();
      if (!this.db) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No database connected.';
        this.inspectorBody.append(empty);
        return;
      }

      if (this.activeTab === 'plan') {
        this.inspectorBody.append(this.renderPlanExplorerPanel());
        return;
      }

      if (this.activeTab === 'profiler') {
        const panel = el('div', 'inspector-profiler');
        const stats = this.lastStats;
        if (!stats) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No profiler telemetry available.';
          panel.append(empty);
          this.inspectorBody.append(panel);
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
          this.lastSchema?.tables.map((t) => t.name) ?? [],
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

        this.inspectorBody.append(panel);
        return;
      }

      if (this.activeTab === 'migrations') {
        const panel = el('div', 'inspector-migrations');
        const list = this.lastMigrations;
        const latest = list.length > 0 ? list[list.length - 1]!.version : 'none';
        const summaryEl = el('p', 'inspector-summary');
        summaryEl.textContent = `Current version: ${latest} · ${list.length} applied`;
        panel.append(summaryEl);

        if (list.length === 0) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No applied migrations in FB_MIGRATIONS$.';
          panel.append(empty);
        } else {
          const ol = el('ol', 'migrations-list');
          for (const m of list) {
            const li = el('li', 'migration-item');
            const ver = el('span', 'migration-version');
            ver.textContent = m.version;
            li.append(ver);
            if (m.name) {
              const nameEl = el('span', 'migration-name');
              nameEl.textContent = m.name;
              li.append(nameEl);
            }
            const dateEl = el('span', 'schema-badge migration-date');
            dateEl.textContent = m.appliedAt;
            li.append(dateEl);
            ol.append(li);
          }
          panel.append(ol);
        }
        this.inspectorBody.append(panel);
        return;
      }

      if (this.activeTab === 'replication') {
        const panel = el('div', 'inspector-replication');
        const repl = this.lastReplication;
        if (!repl) {
          const empty = el('p', 'inspector-empty');
          empty.textContent = 'No replication state loaded yet.';
          panel.append(empty);
          this.inspectorBody.append(panel);
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

        this.inspectorBody.append(panel);
        return;
      }

      const panel = el('div', 'inspector-schema');
      const schema = this.lastSchema;
      if (!schema) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No schema loaded yet.';
        panel.append(empty);
        this.inspectorBody.append(panel);
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
            this.editor.value = `SELECT * FROM ${ident};`;
            this.editor.focus();
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

      this.inspectorBody.append(panel);
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

    async info(): Promise<ReplEntry | undefined> {
      if (this.busy) return undefined;
      if (!this.db || typeof this.db.databaseInfo !== 'function') {
        const entry: ReplEntry = {
          sql: 'DATABASE INFO',
          line: 1,
          ms: 0,
          error: new Error(
            !this.db
              ? 'No database: set the element’s db property first'
              : 'Database does not support databaseInfo()',
          ),
        };
        this.show(entry);
        return entry;
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      const started = performance.now();
      const entry: ReplEntry = { sql: 'DATABASE INFO', line: 1, ms: 0 };
      try {
        entry.info = await this.db.databaseInfo();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.show(entry);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-info', {
          detail: entry,
          bubbles: true,
          composed: true,
        }),
      );
      return entry;
    }

    async sweep(): Promise<ReplEntry | undefined> {
      if (this.busy) return undefined;
      if (!this.db || typeof this.db.sweep !== 'function') {
        const entry: ReplEntry = {
          sql: 'SWEEP DATABASE',
          line: 1,
          ms: 0,
          error: new Error(
            !this.db
              ? 'No database: set the element’s db property first'
              : 'Database does not support sweep()',
          ),
        };
        this.show(entry);
        return entry;
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      const started = performance.now();
      const entry: ReplEntry = { sql: 'SWEEP DATABASE', line: 1, ms: 0 };
      try {
        entry.sweep = await this.db.sweep();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.show(entry);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-sweep', {
          detail: entry,
          bubbles: true,
          composed: true,
        }),
      );
      return entry;
    }

    async schema(options?: IntrospectOptions): Promise<ReplEntry | undefined> {
      if (this.busy) return undefined;
      if (!this.db) {
        const entry: ReplEntry = {
          sql: 'INSPECT SCHEMA',
          line: 1,
          ms: 0,
          error: new Error('No database: set the element’s db property first'),
        };
        this.show(entry);
        return entry;
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      const started = performance.now();
      const entry: ReplEntry = { sql: 'INSPECT SCHEMA', line: 1, ms: 0 };
      try {
        const result = await this.fetchSchema(options);
        entry.schema = result;
        this.lastSchema = result;
        this.activeTab = 'schema';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.show(entry);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-schema', {
          detail: entry,
          bubbles: true,
          composed: true,
        }),
      );
      return entry;
    }

    async migrations(
      options: Pick<MigrateOptions, 'tableName'> = {},
    ): Promise<ReplEntry | undefined> {
      if (this.busy) return undefined;
      if (!this.db) {
        const entry: ReplEntry = {
          sql: 'INSPECT MIGRATIONS',
          line: 1,
          ms: 0,
          error: new Error('No database: set the element’s db property first'),
        };
        this.show(entry);
        return entry;
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      const started = performance.now();
      const entry: ReplEntry = { sql: 'INSPECT MIGRATIONS', line: 1, ms: 0 };
      try {
        const list = await this.fetchMigrations(options);
        entry.migrations = list;
        this.lastMigrations = list;
        this.activeTab = 'migrations';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.show(entry);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-migrations', {
          detail: entry,
          bubbles: true,
          composed: true,
        }),
      );
      return entry;
    }

    async profiler(): Promise<ReplEntry | undefined> {
      if (this.busy) return undefined;
      if (
        !this.db ||
        (typeof this.db.monitorStats !== 'function' &&
          typeof this.db.databaseInfo !== 'function')
      ) {
        const entry: ReplEntry = {
          sql: 'MONITOR STATS',
          line: 1,
          ms: 0,
          error: new Error(
            !this.db
              ? 'No database: set the element’s db property first'
              : 'Database does not support monitorStats()',
          ),
        };
        this.show(entry);
        return entry;
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      const started = performance.now();
      const entry: ReplEntry = { sql: 'MONITOR STATS', line: 1, ms: 0 };
      try {
        const stats = await this.fetchStats();
        if (stats) {
          entry.stats = stats;
          this.lastStats = stats;
        }
        this.activeTab = 'profiler';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.show(entry);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-profiler', {
          detail: entry,
          bubbles: true,
          composed: true,
        }),
      );
      return entry;
    }

    async replication(): Promise<ReplEntry | undefined> {
      if (this.busy) return undefined;
      if (!this.db) {
        const entry: ReplEntry = {
          sql: 'INSPECT REPLICATION',
          line: 1,
          ms: 0,
          error: new Error('No database: set the element’s db property first'),
        };
        this.show(entry);
        return entry;
      }

      this.busy = true;
      this.setButtonsDisabled(true);
      const started = performance.now();
      const entry: ReplEntry = { sql: 'INSPECT REPLICATION', line: 1, ms: 0 };
      try {
        const info = await this.fetchReplication();
        entry.replication = info;
        this.lastReplication = info;
        this.activeTab = 'replication';
        this.updateActiveTabButtons();
        this.inspectorOpen = true;
        this.renderInspector();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.setButtonsDisabled(false);
      }
      this.show(entry);
      this.dispatchEvent(
        new CustomEvent('firebird-repl-replication', {
          detail: entry,
          bubbles: true,
          composed: true,
        }),
      );
      return entry;
    }

    private onKey(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.run();
        return;
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      const { value, selectionStart, selectionEnd } = this.editor;
      if (selectionStart !== selectionEnd) return;
      const onFirstLine = !value.slice(0, selectionStart).includes('\n');
      const onLastLine = !value.slice(selectionEnd).includes('\n');

      if (event.key === 'ArrowUp' && onFirstLine && this.cursor > 0) {
        if (this.cursor === this.history.length) this.draft = value;
        this.cursor--;
      } else if (
        event.key === 'ArrowDown' &&
        onLastLine &&
        this.cursor < this.history.length
      ) {
        this.cursor++;
      } else {
        return;
      }
      event.preventDefault();
      this.editor.value =
        this.cursor === this.history.length
          ? this.draft
          : this.history[this.cursor]!;
      const end = this.editor.value.length;
      this.editor.setSelectionRange(end, end);
    }

    private show(entry: ReplEntry): void {
      const block = el('div', 'entry');
      const sql = el('pre', 'sql');
      sql.textContent = entry.sql;
      block.append(sql);

      if (entry.error) {
        const error = el('pre', 'error');
        error.textContent = entry.error.message;
        block.append(error);
      } else {
        const fields = entry.fields ?? [];
        const rows = entry.rows ?? [];
        if (fields.length > 0) block.append(table(fields, rows));
        if (entry.plan !== undefined) {
          const plan = el('pre', 'plan');
          plan.textContent = entry.plan || '(no plan)';
          block.append(plan);
          if (entry.planTree && entry.planTree.format !== 'empty') {
            const treeWrap = el('div', 'entry-plan-tree');
            treeWrap.append(this.renderPlanTreeNode(entry.planTree.root));
            block.append(treeWrap);
          }
        }
        if (entry.info !== undefined) {
          const d = entry.info;
          block.append(
            table(
              [{ name: 'Metric' }, { name: 'Value' }],
              [
                ['Page size', d.pageSize],
                ['Allocated pages', d.allocatedPages],
                ['Database size (bytes)', d.databaseSizeBytes],
                ['ODS version', `${d.odsVersion}.${d.odsMinorVersion}`],
                ['Oldest transaction (OIT)', d.oldestTransaction],
                ['Oldest active (OAT)', d.oldestActive],
                ['Oldest snapshot (OST)', d.oldestSnapshot],
                ['Next transaction', d.nextTransaction],
                ['Transaction gap', d.transactionGap],
                ['Current memory (bytes)', d.currentMemory],
                ['Max memory (bytes)', d.maxMemory],
                ['Page buffers', d.pageBuffers],
                ['Page reads / writes', `${d.reads} / ${d.writes}`],
                ['Page fetches / marks', `${d.fetches} / ${d.marks}`],
              ],
            ),
          );
        }
        if (entry.sweep !== undefined) {
          const s = entry.sweep;
          block.append(
            table(
              [{ name: 'Metric' }, { name: 'Value' }],
              [
                ['Tables scanned', s.tablesScanned],
                [
                  'OIT (before → after)',
                  `${s.before.oldestTransaction} → ${s.after.oldestTransaction}`,
                ],
                [
                  'OAT (before → after)',
                  `${s.before.oldestActive} → ${s.after.oldestActive}`,
                ],
                [
                  'OST (before → after)',
                  `${s.before.oldestSnapshot} → ${s.after.oldestSnapshot}`,
                ],
                [
                  'Next transaction',
                  `${s.before.nextTransaction} → ${s.after.nextTransaction}`,
                ],
                [
                  'Transaction gap (before → after)',
                  `${s.before.transactionGap} → ${s.after.transactionGap}`,
                ],
                ['OIT advanced', s.oitAdvanced],
                ['Gap reduced', s.gapReduced],
                [
                  'Allocated pages (before → after)',
                  `${s.before.allocatedPages} → ${s.after.allocatedPages}`,
                ],
              ],
            ),
          );
        }
        if (entry.schema !== undefined) {
          const sc = entry.schema;
          const schemaRows: ArrayRow[] = sc.tables.map((t) => [
            t.name,
            t.columns.map((c) => `${c.name} ${c.typeName}`).join(', '),
            t.primaryKey.length > 0 ? t.primaryKey.join(', ') : null,
            t.indexes.length,
            t.triggers.length,
          ]);
          block.append(
            table(
              [
                { name: 'Table' },
                { name: 'Columns' },
                { name: 'Primary Key' },
                { name: 'Indexes' },
                { name: 'Triggers' },
              ],
              schemaRows,
            ),
          );
        }
        if (entry.migrations !== undefined) {
          const migRows: ArrayRow[] = entry.migrations.map((m) => [
            m.version,
            m.name,
            m.appliedAt,
          ]);
          block.append(
            table(
              [{ name: 'Version' }, { name: 'Name' }, { name: 'Applied At' }],
              migRows,
            ),
          );
        }
        if (entry.stats !== undefined) {
          const st = entry.stats;
          const totalStmts = st.totalQueries + st.totalExecs;
          block.append(
            table(
              [{ name: 'Metric' }, { name: 'Value' }],
              [
                ['Queries profiled (errors)', `${totalStmts} (${st.totalErrors})`],
                ['Total / Avg / Max duration (ms)', `${st.totalDurationMs.toFixed(2)} / ${st.avgDurationMs.toFixed(2)} / ${st.maxDurationMs.toFixed(2)}`],
                ['Prepare cache hits / misses', `${st.prepareCacheHits} / ${st.prepareCacheMisses} (${(st.prepareCacheHitRate * 100).toFixed(1)}%)`],
                ['Page reads / writes', `${st.io.reads} / ${st.io.writes}`],
                ['Page fetches / marks', `${st.io.fetches} / ${st.io.marks}`],
                ['Transaction gap (OIT → Next)', `${st.transactions.transactionGap} (${st.transactions.oldestTransaction} → ${st.transactions.nextTransaction})`],
                ['Current / Max memory (bytes)', `${st.io.currentMemory} / ${st.io.maxMemory}`],
              ],
            ),
          );
        }
        if (entry.replication !== undefined) {
          const r = entry.replication;
          const rows: ArrayRow[] = [
            ['Journal initialized', r.journalTableExists ? 'Yes' : 'No'],
            ['Journal entries', r.journalEntryCount],
            ['Journal LSN range', `${r.minJournalLsn} → ${r.maxJournalLsn}`],
            [
              'Registered slots',
              r.slots.length > 0
                ? r.slots
                    .map(
                      (s) =>
                        `${s.slotName} (${s.nodeId} @ LSN ${s.confirmedFlushLsn})`,
                    )
                    .join(', ')
                : 'none',
            ],
            [
              'Peer watermarks',
              r.watermarks.length > 0
                ? r.watermarks
                    .map((w) => `${w.peerId} @ LSN ${w.lastLsn}`)
                    .join(', ')
                : 'none',
            ],
            [
              'Dead-letter queue (FB_REPL_DLQ$)',
              (r.dlqEntries?.length ?? 0) > 0
                ? r.dlqEntries!
                    .map((d) => `#${d.lsn} (${d.errorMessage}, retries ${d.retryCount})`)
                    .join(', ')
                : '0 quarantined',
            ],
          ];
          if (r.enginePublication) {
            const ep = r.enginePublication;
            rows.push([
              'Native Engine Publication (RDB$PUBLICATIONS)',
              `${ep.name} (${ep.active ? 'ACTIVE' : 'INACTIVE'}${ep.autoEnable ? ', INCLUDE ALL' : ''}) · tables: ${ep.publishedTables.length > 0 ? ep.publishedTables.join(', ') : 'none'} · mode: ${ep.replicaMode ?? 'NONE'} · seq: ${ep.replicationSequence ?? 0}`,
            ]);
          }
          if (r.liveStats) {
            rows.push(
              [
                'Live Replicator Status',
                `${r.liveStats.status} (primary LSN ${r.liveStats.primaryLsn} / watermark ${r.liveStats.replicaWatermark})`,
              ],
              [
                'Live Lag (entries / ms)',
                `${r.liveStats.lagEntries} entries / ${r.liveStats.lagMs} ms`,
              ],
              [
                'Changes fetched / applied (conflicts)',
                `${r.liveStats.totalFetched} / ${r.liveStats.totalApplied} (${r.liveStats.totalConflicts}, ${r.liveStats.bytesTransferred} B)`,
              ],
            );
          }
          block.append(table([{ name: 'Metric' }, { name: 'Value' }], rows));
        }
        const meta = el('p', 'meta');
        meta.textContent = `${summary(entry, fields.length > 0)} · ${entry.ms.toFixed(1)} ms`;
        block.append(meta);
      }

      this.output.append(block);
      this.output.scrollTop = this.output.scrollHeight;
    }
  }

  customElements.define(tag, FirebirdRepl);
  return FirebirdRepl;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function summary(entry: ReplEntry, returnsRows: boolean): string {
  if (entry.plan !== undefined) return 'plan';
  if (entry.info !== undefined) return 'info';
  if (entry.sweep !== undefined) return 'sweep';
  if (entry.schema !== undefined) {
    const n = entry.schema.tables.length;
    return `schema (${n} ${n === 1 ? 'table' : 'tables'})`;
  }
  if (entry.migrations !== undefined) {
    const n = entry.migrations.length;
    return `migrations (${n} applied)`;
  }
  if (entry.stats !== undefined) {
    const n = entry.stats.totalQueries + entry.stats.totalExecs;
    return `profiler (${n} ${n === 1 ? 'query' : 'queries'})`;
  }
  if (entry.replication !== undefined) {
    const n = entry.replication.journalEntryCount;
    return `replication (${n} ${n === 1 ? 'entry' : 'entries'}, ${entry.replication.slots.length} ${entry.replication.slots.length === 1 ? 'slot' : 'slots'})`;
  }
  if (returnsRows) {
    const n = entry.rows?.length ?? 0;
    return `${n} ${n === 1 ? 'row' : 'rows'}`;
  }
  if (entry.affectedRows !== undefined && entry.affectedRows > 0) {
    return `${entry.affectedRows} ${entry.affectedRows === 1 ? 'row' : 'rows'} affected`;
  }
  return 'done';
}

function table(fields: FieldInfo[], rows: ArrayRow[]): HTMLElement {
  const wrap = el('div', 'table');
  const grid = document.createElement('table');
  const head = document.createElement('tr');
  for (const field of fields) {
    const th = document.createElement('th');
    th.textContent = field.name;
    if (field.typeName) th.title = field.typeName;
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const row of rows.slice(0, MAX_ROWS)) {
    const tr = document.createElement('tr');
    row.forEach((value) => tr.append(cell(value)));
    tbody.append(tr);
  }
  grid.append(thead, tbody);
  wrap.append(grid);
  if (rows.length > MAX_ROWS) {
    const more = el('p', 'meta');
    more.textContent = `… ${rows.length - MAX_ROWS} more rows not shown`;
    wrap.append(more);
  }
  return wrap;
}

/** A value as a table cell, always through textContent. */
function cell(value: unknown): HTMLTableCellElement {
  const td = document.createElement('td');
  if (value === null || value === undefined) {
    td.className = 'null';
    td.textContent = 'NULL';
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    td.className = 'num';
    td.textContent = String(value);
  } else if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, 32), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    td.textContent = `x'${hex}${value.length > 32 ? '…' : ''}' (${value.length} bytes)`;
  } else if (value instanceof Date) {
    td.textContent = value.toISOString();
  } else if (typeof value === 'object') {
    td.textContent = JSON.stringify(value);
  } else {
    td.textContent = String(value);
  }
  return td;
}
