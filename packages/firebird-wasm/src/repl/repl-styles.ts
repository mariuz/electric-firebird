/**
 * repl-styles.ts – Shadow-DOM stylesheet & safe text-only DOM table helpers
 * for `<firebird-repl>` (`M21 Item 5`).
 */

import type { ArrayRow, FieldInfo } from '../types';
import type { ReplEntry } from './index';

/** At most this many rows of one result are drawn; the rest are counted. */
export const MAX_ROWS = 500;

export const REPL_STYLE = `
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
td.editable-cell { cursor: pointer; }
tr.fb-repl-row-optimistic td { background: rgba(245, 158, 11, 0.14); }
.fb-repl-optimistic-badge {
  display: inline-block; margin-left: 0.35rem; padding: 0 0.3rem; border-radius: 3px;
  font-size: 10px; font-weight: 600; background: rgba(245, 158, 11, 0.25); color: #f59e0b;
}
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


export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function summary(entry: ReplEntry, returnsRows: boolean): string {
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
  if (entry.arrow !== undefined) {
    return `arrow (${entry.arrow.rowCount} ${entry.arrow.rowCount === 1 ? 'row' : 'rows'}, ${entry.arrow.arrowIpcBytes} B)`;
  }
  if (entry.outbox !== undefined) {
    return `outbox (${entry.outbox.pendingCount} pending, ${entry.outbox.confirmedCount} confirmed, ${entry.outbox.revertedCount} reverted)`;
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

export interface ReplTableRenderOptions {
  readonly pkIndex?: number;
  readonly pendingKeys?: ReadonlySet<string>;
  readonly onEditCell?: (
    keyValue: unknown,
    columnName: string,
    newValue: string,
  ) => Promise<void> | void;
}

export function table(
  fields: FieldInfo[],
  rows: ArrayRow[],
  options?: ReplTableRenderOptions,
): HTMLElement {
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
  const pkIdx = options?.pkIndex ?? -1;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const tr = document.createElement('tr');
    const rowKey = pkIdx >= 0 ? row[pkIdx] : undefined;
    const isOptimistic =
      rowKey !== undefined &&
      rowKey !== null &&
      Boolean(options?.pendingKeys?.has(String(rowKey)));
    if (isOptimistic) {
      tr.classList.add('fb-repl-row-optimistic');
    }
    row.forEach((value, colIdx) => {
      const td = cell(value);
      if (isOptimistic && colIdx === Math.max(0, pkIdx)) {
        const badge = el('span', 'fb-repl-optimistic-badge');
        badge.textContent = 'pending';
        td.append(badge);
      }
      if (options?.onEditCell && pkIdx >= 0 && colIdx !== pkIdx) {
        td.classList.add('editable-cell');
        td.title = 'Double-click to edit cell';
        td.addEventListener('dblclick', () => {
          if (td.querySelector('input')) return;
          const prevText = value === null || value === undefined ? '' : String(value);
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = prevText;
          inp.className = 'fb-repl-inline-input';
          inp.style.width = '100%';
          td.replaceChildren(inp);
          inp.focus();
          let committed = false;
          const finish = (save: boolean) => {
            if (committed) return;
            committed = true;
            const nextVal = inp.value;
            td.textContent = nextVal;
            if (save && nextVal !== prevText) {
              void options.onEditCell!(rowKey, fields[colIdx]!.name, nextVal);
            }
          };
          inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              finish(true);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              td.textContent = prevText;
              committed = true;
            }
          });
          inp.addEventListener('blur', () => finish(true));
        });
      }
      tr.append(td);
    });
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
export function cell(value: unknown): HTMLTableCellElement {
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

