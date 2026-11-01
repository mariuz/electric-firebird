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
import type {
  AppliedMigration,
  ArrayRow,
  DatabaseInfo,
  ExplainOptions,
  FieldInfo,
  IntrospectOptions,
  MigrateOptions,
  QueryResult,
  Row,
  SchemaIntrospection,
  SweepResult,
} from '../types';

/** Active tab in the `<firebird-repl>` Schema Inspector & Migration Viewer sidebar. */
export type ReplInspectorTab = 'schema' | 'migrations';

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
  info?: DatabaseInfo;
  sweep?: SweepResult;
  schema?: SchemaIntrospection;
  migrations?: AppliedMigration[];
  error?: Error;
}

/** The element's own API, beyond HTMLElement's. */
export interface FirebirdReplElement extends HTMLElement {
  /** The database statements run against. */
  db: ReplDatabase | null;
  /** The editor's text. */
  value: string;
  /** Whether the Schema Inspector & Migration Viewer sidebar is open. */
  inspectorOpen: boolean;
  /** Currently active sidebar tab (`'schema'` or `'migrations'`). */
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
  /** Toggle (or switch to `tab` in) the interactive Schema Inspector & Migration Viewer sidebar. */
  toggleInspector(tab?: ReplInspectorTab): Promise<void>;
  /** Refresh the interactive Schema Inspector & Migration Viewer sidebar from the database. */
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
  width: 22rem; max-width: 50%; border-left: 1px solid var(--firebird-repl-border);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
.inspector[hidden] { display: none; }
.inspector-header {
  display: flex; align-items: center; border-bottom: 1px solid var(--firebird-repl-border);
  min-height: 2rem;
}
.inspector-tabs { display: flex; flex: 1; }
.inspector-header button {
  padding: 0.25rem 0.65rem; border-left: 0; border-right: 1px solid var(--firebird-repl-border);
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
details.schema-table, details.schema-view {
  border: 1px solid var(--firebird-repl-border); border-radius: 4px;
  margin: 0 0 0.4rem; padding: 0.2rem 0.45rem;
}
summary.schema-item-header {
  cursor: pointer; display: flex; align-items: center; gap: 0.4rem; font-weight: 600;
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
.col-flag {
  font-size: 11px; padding: 0 0.25rem; border: 1px solid var(--firebird-repl-border);
  border-radius: 3px; color: var(--firebird-repl-accent);
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
    private readonly output: HTMLDivElement;
    private readonly inspector: HTMLDivElement;
    private readonly inspectorBody: HTMLDivElement;
    private readonly tabSchemaBtn: HTMLButtonElement;
    private readonly tabMigrationsBtn: HTMLButtonElement;
    private readonly inspectorRefreshBtn: HTMLButtonElement;
    private readonly inspectorCloseBtn: HTMLButtonElement;
    private readonly editor: HTMLTextAreaElement;
    private readonly button: HTMLButtonElement;
    private readonly explainButton: HTMLButtonElement;
    private readonly infoButton: HTMLButtonElement;
    private readonly sweepButton: HTMLButtonElement;
    private readonly schemaButton: HTMLButtonElement;
    private readonly migrationsButton: HTMLButtonElement;
    private readonly history: string[] = [];
    /** Position in `history` while walking it; `history.length` is the draft. */
    private cursor = 0;
    private draft = '';
    private busy = false;
    private isInspectorOpen = false;
    private activeTab: ReplInspectorTab = 'schema';
    private lastSchema: SchemaIntrospection | null = null;
    private lastMigrations: AppliedMigration[] = [];

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
      this.inspector.setAttribute('aria-label', 'Schema and migrations inspector');

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
      inspectorTabs.append(this.tabSchemaBtn, this.tabMigrationsBtn);

      const inspectorActions = el('div', 'inspector-actions');
      this.inspectorRefreshBtn = document.createElement('button');
      this.inspectorRefreshBtn.type = 'button';
      this.inspectorRefreshBtn.className = 'inspector-refresh';
      this.inspectorRefreshBtn.textContent = 'Refresh';
      this.inspectorRefreshBtn.title = 'Refresh schema and migrations';

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
      this.tabSchemaBtn.addEventListener('click', () => {
        this.inspectorTab = 'schema';
        void this.refreshInspector();
      });
      this.tabMigrationsBtn.addEventListener('click', () => {
        this.inspectorTab = 'migrations';
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
      for (const name of ['db', 'value', 'inspectorOpen', 'inspectorTab'] as const) {
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
      this.activeTab = tab === 'migrations' ? 'migrations' : 'schema';
      this.tabSchemaBtn.classList.toggle('active', this.activeTab === 'schema');
      this.tabMigrationsBtn.classList.toggle(
        'active',
        this.activeTab === 'migrations',
      );
      this.renderInspector();
    }

    private setButtonsDisabled(disabled: boolean): void {
      this.button.disabled = disabled;
      this.explainButton.disabled = disabled;
      this.infoButton.disabled = disabled;
      this.sweepButton.disabled = disabled;
      this.schemaButton.disabled = disabled;
      this.migrationsButton.disabled = disabled;
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
        this.renderInspector();
        return;
      }
      try {
        if (this.activeTab === 'schema') {
          this.lastSchema = await this.fetchSchema();
        } else {
          this.lastMigrations = await this.fetchMigrations();
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

    private renderInspector(): void {
      this.inspectorBody.replaceChildren();
      if (!this.db) {
        const empty = el('p', 'inspector-empty');
        empty.textContent = 'No database connected.';
        this.inspectorBody.append(empty);
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
        for (const statement of statements) {
          const started = performance.now();
          const entry: ReplEntry = {
            sql: statement.sql,
            line: statement.line,
            ms: 0,
          };
          try {
            entry.plan = await this.db.explain(statement.sql, options);
          } catch (err) {
            entry.error = asError(err);
          }
          entry.ms = performance.now() - started;
          entries.push(entry);
          this.show(entry);
          if (entry.error) break;
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
        this.tabSchemaBtn.classList.add('active');
        this.tabMigrationsBtn.classList.remove('active');
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
        this.tabMigrationsBtn.classList.add('active');
        this.tabSchemaBtn.classList.remove('active');
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
