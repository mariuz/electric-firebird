/**
 * repl-panel-renderers.ts – Arrow/Sync, Query Plan Flamegraph & Optimistic Outbox
 * Panel Renderers for `<firebird-repl>` (`M27 Item 5`).
 */

import type { ParsedQueryPlan, PlanTreeNode } from './plan-tree';
import type { OptimisticStoreSnapshot } from '../optimistic-store';
import type { UndoRedoSnapshot } from '../undo-redo';
import { el } from './repl-styles';
import type { ReplArrowInspectorInfo } from './index';

export function renderArrowInspectorPanel(
  info: ReplArrowInspectorInfo | null,
  onExportArrow?: () => void,
  onImportArrowFile?: (fileName: string, bytes: Uint8Array) => void,
): HTMLElement {
  const panel = el('div', 'inspector-arrow');
  const actionsRow = el('div', 'inspector-actions');
  if (onExportArrow) {
    const exportBtn = el('button', 'arrow-export-btn') as HTMLButtonElement;
    exportBtn.type = 'button';
    exportBtn.textContent = 'Export .arrow';
    exportBtn.addEventListener('click', () => onExportArrow());
    actionsRow.append(exportBtn);
  }
  if (onImportArrowFile) {
    const importBtn = el('button', 'arrow-import-btn') as HTMLButtonElement;
    importBtn.type = 'button';
    importBtn.textContent = 'Import .arrow';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.arrow,.ipc,application/vnd.apache.arrow.stream';
    fileInput.style.display = 'none';
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      void f.arrayBuffer().then((buf) => {
        onImportArrowFile(f.name, new Uint8Array(buf));
        fileInput.value = '';
      });
    });
    actionsRow.append(importBtn, fileInput);
  }
  if (actionsRow.childElementCount > 0) {
    panel.append(actionsRow);
  }

  if (info?.syncState) {
    const syncTitle = el('div', 'schema-group-title');
    syncTitle.textContent = 'SyncHandle Live Telemetry';
    panel.append(syncTitle);
    const syncSummary = el('p', 'inspector-summary');
    syncSummary.textContent =
      `${info.syncState.state.toUpperCase()} (${info.syncState.mode}) · ` +
      `LSN ${info.syncState.replicaLsn}/${info.syncState.primaryLsn} · ` +
      `lag ${info.syncState.lagEntries}`;
    panel.append(syncSummary);
  }

  if (!info) {
    const empty = el('p', 'inspector-empty');
    empty.textContent =
      'Click Arrow to inspect zero-copy columnar vectors & Apache Arrow IPC V5 buffers.';
    panel.append(empty);
    return panel;
  }

  const hdr = el('div', 'schema-group-title');
  hdr.textContent = 'Apache Arrow IPC V5 & Columnar Vectors';
  panel.append(hdr);

  const summaryEl = el('p', 'inspector-summary');
  summaryEl.textContent =
    `${info.rowCount} ${info.rowCount === 1 ? 'row' : 'rows'} · ` +
    `${info.vectors.length} ${info.vectors.length === 1 ? 'vector' : 'vectors'} · ` +
    `Arrow IPC ${info.arrowIpcBytes} bytes`;
  panel.append(summaryEl);

  const list = el('ul', 'schema-list');
  for (const vec of info.vectors) {
    const li = el('li', 'schema-meta-item');
    const name = el('span', 'col-name');
    name.textContent = vec.name;
    const badge = el('span', 'schema-badge');
    badge.textContent =
      `${vec.kind} (${vec.sqlType}) · ${vec.bufferBytes} B · nulls:${vec.nullCount}`;
    li.append(name, badge);
    list.append(li);
  }
  panel.append(list);
  return panel;
}

export function renderPlanTreeNode(node: PlanTreeNode): HTMLElement {
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
    details.append(renderPlanTreeNode(child));
  }

  return details;
}

export function renderPlanExplorerPanel(
  lastPlans: ReadonlyArray<{ sql: string; parsed: ParsedQueryPlan }>,
): HTMLElement {
  const panel = el('div', 'inspector-plan');
  if (lastPlans.length === 0) {
    const empty = el('p', 'inspector-empty');
    empty.textContent = 'No query plan explained yet. Click Explain to analyze a query.';
    panel.append(empty);
    return panel;
  }

  for (const item of lastPlans) {
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

    const flameTitle = el('div', 'schema-sub-label');
    flameTitle.textContent = 'Cost Flamegraph:';
    panel.append(flameTitle);

    const flameWrap = el('div', 'flamegraph');
    for (const n of parsed.nodes) {
      const pct = Math.max(8, Math.round(n.weightFraction * 100));
      const bar = el('div', `flame-bar${n.accessMethod === 'NATURAL' ? ' natural' : ''}`);
      bar.setAttribute('style', `width: ${pct}%; margin-left: ${n.depth * 6}px`);
      const nameSpan = el('span', 'flame-label');
      nameSpan.textContent = n.label;
      const pctSpan = el('span', 'schema-badge flame-pct');
      pctSpan.textContent = `${Math.round(n.weightFraction * 100)}%`;
      bar.append(nameSpan, pctSpan);
      flameWrap.append(bar);
    }
    panel.append(flameWrap);

    const treeTitle = el('div', 'schema-sub-label');
    treeTitle.textContent = 'Plan Tree:';
    panel.append(treeTitle);
    panel.append(renderPlanTreeNode(parsed.root));
  }

  return panel;
}

export function renderOutboxInspectorPanel(
  snap: OptimisticStoreSnapshot | null,
  undoSnap: UndoRedoSnapshot | null,
  onFlush?: () => void,
  onRevert?: (id: string) => void,
  onRevertAll?: () => void,
  onUndo?: () => void,
  onRedo?: () => void,
): HTMLElement {
  const panel = el('div', 'inspector-outbox');
  if (undoSnap) {
    const undoRow = el('div', 'schema-sub');
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'schema-query-btn outbox-undo-btn';
    undoBtn.textContent = `Undo (${undoSnap.undoCount})`;
    undoBtn.disabled = !undoSnap.canUndo;
    undoBtn.addEventListener('click', () => onUndo?.());

    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'schema-query-btn outbox-redo-btn';
    redoBtn.textContent = `Redo (${undoSnap.redoCount})`;
    redoBtn.disabled = !undoSnap.canRedo;
    redoBtn.addEventListener('click', () => onRedo?.());
    undoRow.append(undoBtn, redoBtn);
    panel.append(undoRow);
  }

  if (!snap) {
    const empty = el('p', 'inspector-empty');
    empty.textContent = undoSnap
      ? `Undo stack: ${undoSnap.undoCount} · Redo stack: ${undoSnap.redoCount}`
      : 'No optimisticStore attached to <firebird-repl>.';
    panel.append(empty);
    return panel;
  }

  const summaryEl = el('p', 'inspector-summary');
  summaryEl.textContent =
    `${snap.pendingCount} pending · ${snap.confirmedCount} confirmed · ` +
    `${snap.revertedCount} reverted · ${snap.rebasedCount} rebased`;
  panel.append(summaryEl);

  const actionsBar = el('div', 'schema-sub');
  const flushBtn = document.createElement('button');
  flushBtn.type = 'button';
  flushBtn.className = 'schema-query-btn outbox-flush-btn';
  flushBtn.textContent = snap.flushing ? 'Flushing…' : 'Flush Outbox';
  flushBtn.disabled = snap.pendingCount === 0 || snap.flushing;
  flushBtn.addEventListener('click', () => onFlush?.());

  const revertAllBtn = document.createElement('button');
  revertAllBtn.type = 'button';
  revertAllBtn.className = 'schema-query-btn outbox-revert-all-btn';
  revertAllBtn.textContent = 'Revert All';
  revertAllBtn.disabled = snap.pendingCount === 0 || snap.flushing;
  revertAllBtn.addEventListener('click', () => onRevertAll?.());
  actionsBar.append(flushBtn, revertAllBtn);
  panel.append(actionsBar);

  if (snap.pending.length === 0) {
    const clean = el('p', 'inspector-empty');
    clean.textContent = 'Outbox is clean (0 pending optimistic mutations).';
    panel.append(clean);
    return panel;
  }

  const list = el('ul', 'schema-list outbox-list');
  for (const item of snap.pending) {
    const li = el('li', 'schema-meta-item outbox-item');
    const txt = document.createElement('span');
    txt.textContent = `${item.id} · ${item.operation} ${item.tableName} (${JSON.stringify(item.keyValue)}) [${item.status}] `;
    const revBtn = document.createElement('button');
    revBtn.type = 'button';
    revBtn.className = 'schema-query-btn outbox-revert-btn';
    revBtn.textContent = 'Revert';
    revBtn.addEventListener('click', () => onRevert?.(item.id));
    li.append(txt, revBtn);
    list.append(li);
  }
  panel.append(list);
  return panel;
}
