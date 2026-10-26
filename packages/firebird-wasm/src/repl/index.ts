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
import type { ArrayRow, DatabaseInfo, ExplainOptions, FieldInfo, QueryResult } from '../types';

/** What the console needs of a database: `FirebirdBrowser` has it. */
export interface ReplDatabase {
  query(sql: string, params: unknown[], options: { rowMode: 'array' }): Promise<QueryResult<ArrayRow>>;
  /** Whether a statement yields rows, before running it. */
  describeQuery(sql: string): Promise<{ hasResultSet: boolean }>;
  /** Return the execution plan for `sql` without running it. */
  explain?(sql: string, options?: ExplainOptions): Promise<string>;
  /** Inspect database diagnostics and transaction counters. */
  databaseInfo?(): Promise<DatabaseInfo>;
  /**
   * For a statement without rows: a transaction's `exec()` runs exactly one
   * statement and reports what it changed.  (`FirebirdBrowser.exec()` would
   * split the statement again, cutting a PSQL body at its semicolons.)
   */
  transaction<T>(fn: (tx: { exec(sql: string): Promise<{ affectedRows: number }> }) => Promise<T>): Promise<T>;
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
  error?: Error;
}

/** The element's own API, beyond HTMLElement's. */
export interface FirebirdReplElement extends HTMLElement {
  /** The database statements run against. */
  db: ReplDatabase | null;
  /** The editor's text. */
  value: string;
  /** Run `script` (default: the editor's text); resolves with what each statement did. */
  run(script?: string): Promise<ReplEntry[]>;
  /** Explain `script` (default: the editor's text) without executing it; resolves with each statement's plan. */
  explain(script?: string, options?: ExplainOptions): Promise<ReplEntry[]>;
  /** Inspect database diagnostics and OIT/OAT transaction health; resolves with the info entry. */
  info(): Promise<ReplEntry | undefined>;
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
.output { flex: 1; overflow: auto; padding: 0.5rem 0.75rem; }
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
export function defineFirebirdRepl(tag = 'firebird-repl'): { new (): FirebirdReplElement } {
  const existing = customElements.get(tag);
  if (existing) return existing as unknown as { new (): FirebirdReplElement };

  class FirebirdRepl extends HTMLElement implements FirebirdReplElement {
    private database: ReplDatabase | null = null;
    private readonly output: HTMLDivElement;
    private readonly editor: HTMLTextAreaElement;
    private readonly button: HTMLButtonElement;
    private readonly explainButton: HTMLButtonElement;
    private readonly infoButton: HTMLButtonElement;
    private readonly history: string[] = [];
    /** Position in `history` while walking it; `history.length` is the draft. */
    private cursor = 0;
    private draft = '';
    private busy = false;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      this.output = el('div', 'output');
      this.output.setAttribute('role', 'log');
      this.output.setAttribute('aria-live', 'polite');
      const input = el('div', 'input');
      this.editor = document.createElement('textarea');
      this.editor.spellcheck = false;
      this.editor.placeholder = 'SQL; Ctrl+Enter runs it';
      this.editor.setAttribute('aria-label', 'SQL');
      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.textContent = 'Run';
      this.explainButton = document.createElement('button');
      this.explainButton.type = 'button';
      this.explainButton.className = 'explain';
      this.explainButton.textContent = 'Explain';
      this.explainButton.title = 'Explain query plan (Shift+click for detailed plan)';
      this.explainButton.title = 'Explain query plan (Shift+click for detailed plan)';
      this.infoButton = document.createElement('button');
      this.infoButton.type = 'button';
      this.infoButton.className = 'info';
      this.infoButton.textContent = 'Info';
      this.infoButton.title = 'Inspect database diagnostics and transaction counters';
      input.append(this.editor, this.infoButton, this.explainButton, this.button);
      root.append(style, this.output, input);

      this.button.addEventListener('click', () => void this.run());
      this.explainButton.addEventListener('click', (event) => void this.explain(undefined, { detailed: event.shiftKey }));
      this.infoButton.addEventListener('click', () => void this.info());
      this.editor.addEventListener('keydown', (event) => this.onKey(event));

      // A property set before the element was defined (React and Vue both
      // set properties as they render) sits on the instance and would hide
      // the accessor: take it over.
      for (const name of ['db', 'value'] as const) {
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

    clear(): void {
      this.output.replaceChildren();
    }

    async run(script?: string): Promise<ReplEntry[]> {
      const text = script ?? this.editor.value;
      if (this.busy || text.trim() === '') return [];
      if (!this.db) {
        const entry: ReplEntry = {
          sql: text.trim(), line: 1, ms: 0,
          error: new Error('No database: set the element’s db property first'),
        };
        this.show(entry);
        return [entry];
      }

      this.busy = true;
      this.button.disabled = true;
      this.explainButton.disabled = true;
      this.infoButton.disabled = true;
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
          const entry: ReplEntry = { sql: text.trim(), line: 1, ms: 0, error: asError(err) };
          entries.push(entry);
          this.show(entry);
        }
        for (const statement of statements) {
          const started = performance.now();
          const entry: ReplEntry = { sql: statement.sql, line: statement.line, ms: 0 };
          try {
            const db = this.db;
            const { hasResultSet } = await db.describeQuery(statement.sql);
            if (hasResultSet) {
              const result = await db.query(statement.sql, [], { rowMode: 'array' });
              entry.fields = result.fields;
              entry.rows = result.rows;
            } else {
              entry.affectedRows = (await db.transaction((tx) => tx.exec(statement.sql))).affectedRows;
            }
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
        this.button.disabled = false;
        this.explainButton.disabled = false;
        this.infoButton.disabled = false;
      }
      this.dispatchEvent(new CustomEvent('firebird-repl-run', { detail: entries, bubbles: true, composed: true }));
      return entries;
    }

    async explain(script?: string, options?: ExplainOptions): Promise<ReplEntry[]> {
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
      this.button.disabled = true;
      this.explainButton.disabled = true;
      this.infoButton.disabled = true;
      if (this.history[this.history.length - 1] !== text) this.history.push(text);
      this.cursor = this.history.length;

      const entries: ReplEntry[] = [];
      try {
        let statements: ScriptStatement[];
        try {
          statements = splitStatements(text);
        } catch (err) {
          statements = [];
          const entry: ReplEntry = { sql: text.trim(), line: 1, ms: 0, error: asError(err) };
          entries.push(entry);
          this.show(entry);
        }
        for (const statement of statements) {
          const started = performance.now();
          const entry: ReplEntry = { sql: statement.sql, line: statement.line, ms: 0 };
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
        this.button.disabled = false;
        this.explainButton.disabled = false;
        this.infoButton.disabled = false;
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
      this.button.disabled = true;
      this.explainButton.disabled = true;
      this.infoButton.disabled = true;
      const started = performance.now();
      const entry: ReplEntry = { sql: 'DATABASE INFO', line: 1, ms: 0 };
      try {
        entry.info = await this.db.databaseInfo();
      } catch (err) {
        entry.error = asError(err);
      } finally {
        entry.ms = performance.now() - started;
        this.busy = false;
        this.button.disabled = false;
        this.explainButton.disabled = false;
        this.infoButton.disabled = false;
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
      } else if (event.key === 'ArrowDown' && onLastLine && this.cursor < this.history.length) {
        this.cursor++;
      } else {
        return;
      }
      event.preventDefault();
      this.editor.value = this.cursor === this.history.length ? this.draft : this.history[this.cursor]!;
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
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
    const hex = Array.from(value.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('');
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
