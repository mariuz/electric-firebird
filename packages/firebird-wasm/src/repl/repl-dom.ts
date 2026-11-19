/**
 * repl-dom.ts – Shadow DOM Layout & Control Construction for `<firebird-repl>` (`M26 Item 5`).
 */

import { REPL_STYLE, el } from './repl-styles';

export interface ReplDomHandles {
  readonly output: HTMLDivElement;
  readonly inspector: HTMLDivElement;
  readonly inspectorBody: HTMLDivElement;
  readonly tabSchemaBtn: HTMLButtonElement;
  readonly tabMigrationsBtn: HTMLButtonElement;
  readonly tabProfilerBtn: HTMLButtonElement;
  readonly tabPlanBtn: HTMLButtonElement;
  readonly tabReplicationBtn: HTMLButtonElement;
  readonly tabArrowBtn: HTMLButtonElement;
  readonly tabOutboxBtn: HTMLButtonElement;
  readonly inspectorRefreshBtn: HTMLButtonElement;
  readonly inspectorCloseBtn: HTMLButtonElement;
  readonly editor: HTMLTextAreaElement;
  readonly button: HTMLButtonElement;
  readonly explainButton: HTMLButtonElement;
  readonly infoButton: HTMLButtonElement;
  readonly sweepButton: HTMLButtonElement;
  readonly schemaButton: HTMLButtonElement;
  readonly migrationsButton: HTMLButtonElement;
  readonly profilerButton: HTMLButtonElement;
  readonly replicationButton: HTMLButtonElement;
  readonly arrowButton: HTMLButtonElement;
  readonly outboxButton: HTMLButtonElement;
  readonly undoButton: HTMLButtonElement;
  readonly redoButton: HTMLButtonElement;
}

function makeBtn(
  className: string,
  text: string,
  title?: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (className) btn.className = className;
  btn.textContent = text;
  if (title) btn.title = title;
  return btn;
}

export function createReplDomElements(root: ShadowRoot): ReplDomHandles {
  const style = document.createElement('style');
  style.textContent = REPL_STYLE;

  const workspace = el('div', 'workspace');
  const output = el('div', 'output');
  output.setAttribute('role', 'log');
  output.setAttribute('aria-live', 'polite');

  const inspector = el('div', 'inspector');
  inspector.hidden = true;
  inspector.setAttribute(
    'aria-label',
    'Schema, migrations, profiler, and query plan inspector',
  );

  const inspectorHeader = el('div', 'inspector-header');
  const inspectorTabs = el('div', 'inspector-tabs');
  const tabSchemaBtn = makeBtn('tab-schema active', 'Schema');
  const tabMigrationsBtn = makeBtn('tab-migrations', 'Migrations');
  const tabProfilerBtn = makeBtn('tab-profiler', 'Profiler');
  const tabPlanBtn = makeBtn('tab-plan', 'Plan');
  const tabReplicationBtn = makeBtn('tab-replication', 'Replication');
  const tabArrowBtn = makeBtn('tab-arrow', 'Arrow / Sync');
  const tabOutboxBtn = makeBtn('tab-outbox', 'Outbox');

  inspectorTabs.append(
    tabSchemaBtn,
    tabMigrationsBtn,
    tabProfilerBtn,
    tabPlanBtn,
    tabReplicationBtn,
    tabArrowBtn,
    tabOutboxBtn,
  );

  const inspectorActions = el('div', 'inspector-actions');
  const inspectorRefreshBtn = makeBtn(
    'inspector-refresh',
    'Refresh',
    'Refresh schema, migrations, profiler, and plan',
  );
  const inspectorCloseBtn = makeBtn('inspector-close', '×', 'Close inspector');
  inspectorActions.append(inspectorRefreshBtn, inspectorCloseBtn);

  inspectorHeader.append(inspectorTabs, inspectorActions);
  const inspectorBody = el('div', 'inspector-body');
  inspector.append(inspectorHeader, inspectorBody);

  workspace.append(output, inspector);

  const input = el('div', 'input');
  const editor = document.createElement('textarea');
  editor.spellcheck = false;
  editor.placeholder = 'SQL; Ctrl+Enter runs it';
  editor.setAttribute('aria-label', 'SQL');

  const schemaButton = makeBtn(
    'schema',
    'Schema',
    'Inspect tables, columns, keys, indexes, sequences, and triggers',
  );
  const migrationsButton = makeBtn(
    'migrations',
    'Migrations',
    'Inspect applied schema migrations (FB_MIGRATIONS$)',
  );
  const profilerButton = makeBtn(
    'profiler',
    'Profiler',
    'Inspect query telemetry, cache hits, and MON$ monitoring counters',
  );
  const replicationButton = makeBtn(
    'replication',
    'Replication',
    'Inspect replication journal, slots, watermarks, and lag telemetry',
  );
  const arrowButton = makeBtn(
    'arrow',
    'Arrow',
    'Inspect typed columnar vectors, Apache Arrow IPC stream size, and SyncHandle telemetry',
  );
  const outboxButton = makeBtn(
    'outbox',
    'Outbox',
    'Inspect optimistic local-first mutation outbox (flush / revert)',
  );
  const undoButton = makeBtn('undo', 'Undo', 'Undo last local-first action');
  undoButton.disabled = true;
  const redoButton = makeBtn('redo', 'Redo', 'Redo last undone local-first action');
  redoButton.disabled = true;
  const sweepButton = makeBtn(
    'sweep',
    'Sweep',
    'Run garbage-collection sweep and advance OIT',
  );
  const infoButton = makeBtn(
    'info',
    'Info',
    'Inspect database diagnostics and transaction counters',
  );
  const explainButton = makeBtn(
    'explain',
    'Explain',
    'Explain query plan (Shift+click for detailed plan)',
  );
  const button = makeBtn('', 'Run');

  input.append(
    editor,
    schemaButton,
    migrationsButton,
    profilerButton,
    replicationButton,
    arrowButton,
    outboxButton,
    undoButton,
    redoButton,
    sweepButton,
    infoButton,
    explainButton,
    button,
  );
  root.append(style, workspace, input);

  return {
    output,
    inspector,
    inspectorBody,
    tabSchemaBtn,
    tabMigrationsBtn,
    tabProfilerBtn,
    tabPlanBtn,
    tabReplicationBtn,
    tabArrowBtn,
    tabOutboxBtn,
    inspectorRefreshBtn,
    inspectorCloseBtn,
    editor,
    button,
    explainButton,
    infoButton,
    sweepButton,
    schemaButton,
    migrationsButton,
    profilerButton,
    replicationButton,
    arrowButton,
    outboxButton,
    undoButton,
    redoButton,
  };
}
