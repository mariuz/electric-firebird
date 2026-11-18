/**
 * repl-entry-renderer.ts – DOM Entry Log Block Renderer for `<firebird-repl>` (`M24 Item 5`).
 */

import type { ArrayRow } from '../types';
import type { OptimisticMutationStore } from '../optimistic-store';
import { el, summary, table } from './repl-styles';
import { renderPlanTreeNode } from './repl-inspectors';
import type { ReplEditableTableConfig, ReplEntry } from './index';

export interface RenderReplEntryOptions {
  readonly editableTable?: ReplEditableTableConfig | null;
  readonly optimisticStore?: OptimisticMutationStore | null;
  readonly onEditCell?: (
    tableName: string,
    keyValue: unknown,
    columnName: string,
    newValue: string,
    primaryKey: string,
  ) => Promise<void> | void;
}

export function renderReplEntryBlock(
  entry: ReplEntry,
  options: RenderReplEntryOptions = {},
): HTMLDivElement {
  const block = el('div', 'entry');
  const sql = el('pre', 'sql');
  sql.textContent = entry.sql;
  block.append(sql);

  if (entry.error) {
    const error = el('pre', 'error');
    error.textContent = entry.error.message;
    block.append(error);
    return block;
  }

  const fields = entry.fields ?? [];
  const rows = entry.rows ?? [];
  if (fields.length > 0) {
    const editTarget = options.editableTable;
    const pkName = (editTarget?.primaryKey ?? 'ID').toUpperCase();
    const pkIdx = fields.findIndex((f) => f.name.toUpperCase() === pkName);
    const pendingKeys = new Set<string>();
    if (options.optimisticStore) {
      const snap = options.optimisticStore.getSnapshot();
      for (const m of snap.pending) {
        if (!editTarget || m.tableName === editTarget.table.toUpperCase()) {
          pendingKeys.add(String(m.keyValue));
        }
      }
    }
    block.append(
      table(fields, rows, {
        pkIndex: pkIdx,
        pendingKeys,
        onEditCell:
          editTarget && pkIdx >= 0 && options.onEditCell
            ? (keyVal, colName, nextVal) =>
                options.onEditCell!(editTarget.table, keyVal, colName, nextVal, pkName)
            : undefined,
      }),
    );
  }

  if (entry.plan !== undefined) {
    const plan = el('pre', 'plan');
    plan.textContent = entry.plan || '(no plan)';
    block.append(plan);
    if (entry.planTree && entry.planTree.format !== 'empty') {
      const treeWrap = el('div', 'entry-plan-tree');
      treeWrap.append(renderPlanTreeNode(entry.planTree.root));
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
          ['OIT (before → after)', `${s.before.oldestTransaction} → ${s.after.oldestTransaction}`],
          ['OAT (before → after)', `${s.before.oldestActive} → ${s.after.oldestActive}`],
          ['OST (before → after)', `${s.before.oldestSnapshot} → ${s.after.oldestSnapshot}`],
          ['Next transaction', `${s.before.nextTransaction} → ${s.after.nextTransaction}`],
          ['Transaction gap (before → after)', `${s.before.transactionGap} → ${s.after.transactionGap}`],
          ['OIT advanced', s.oitAdvanced],
          ['Gap reduced', s.gapReduced],
          ['Allocated pages (before → after)', `${s.before.allocatedPages} → ${s.after.allocatedPages}`],
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
      table([{ name: 'Version' }, { name: 'Name' }, { name: 'Applied At' }], migRows),
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
          [
            'Total / Avg / Max duration (ms)',
            `${st.totalDurationMs.toFixed(2)} / ${st.avgDurationMs.toFixed(2)} / ${st.maxDurationMs.toFixed(2)}`,
          ],
          [
            'Prepare cache hits / misses',
            `${st.prepareCacheHits} / ${st.prepareCacheMisses} (${(st.prepareCacheHitRate * 100).toFixed(1)}%)`,
          ],
          ['Page reads / writes', `${st.io.reads} / ${st.io.writes}`],
          ['Page fetches / marks', `${st.io.fetches} / ${st.io.marks}`],
          [
            'Transaction gap (OIT → Next)',
            `${st.transactions.transactionGap} (${st.transactions.oldestTransaction} → ${st.transactions.nextTransaction})`,
          ],
          ['Current / Max memory (bytes)', `${st.io.currentMemory} / ${st.io.maxMemory}`],
        ],
      ),
    );
  }

  if (entry.replication !== undefined) {
    const r = entry.replication;
    const rRows: ArrayRow[] = [
      ['Journal initialized', r.journalTableExists ? 'Yes' : 'No'],
      ['Journal entries', r.journalEntryCount],
      ['Journal LSN range', `${r.minJournalLsn} → ${r.maxJournalLsn}`],
      [
        'Registered slots',
        r.slots.length > 0
          ? r.slots
              .map((s) => `${s.slotName} (${s.nodeId} @ LSN ${s.confirmedFlushLsn})`)
              .join(', ')
          : 'none',
      ],
      [
        'Peer watermarks',
        r.watermarks.length > 0
          ? r.watermarks.map((w) => `${w.peerId} @ LSN ${w.lastLsn}`).join(', ')
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
      rRows.push([
        'Native Engine Publication (RDB$PUBLICATIONS)',
        `${ep.name} (${ep.active ? 'ACTIVE' : 'INACTIVE'}${ep.autoEnable ? ', INCLUDE ALL' : ''}) · tables: ${ep.publishedTables.length > 0 ? ep.publishedTables.join(', ') : 'none'} · mode: ${ep.replicaMode ?? 'NONE'} · seq: ${ep.replicationSequence ?? 0}`,
      ]);
    }
    if (r.liveStats) {
      rRows.push(
        [
          'Live Replicator Status',
          `${r.liveStats.status} (primary LSN ${r.liveStats.primaryLsn} / watermark ${r.liveStats.replicaWatermark})`,
        ],
        ['Live Lag (entries / ms)', `${r.liveStats.lagEntries} entries / ${r.liveStats.lagMs} ms`],
        [
          'Changes fetched / applied (conflicts)',
          `${r.liveStats.totalFetched} / ${r.liveStats.totalApplied} (${r.liveStats.totalConflicts}, ${r.liveStats.bytesTransferred} B)`,
        ],
      );
    }
    block.append(table([{ name: 'Metric' }, { name: 'Value' }], rRows));
  }

  if (entry.arrow !== undefined) {
    const a = entry.arrow;
    const aRows: ArrayRow[] = [
      ['Row count', a.rowCount],
      ['Apache Arrow IPC stream (bytes)', a.arrowIpcBytes],
      [
        'Columnar vectors',
        a.vectors
          .map((v) => `${v.name}:${v.kind}(${v.bufferBytes}B, nulls=${v.nullCount})`)
          .join(', '),
      ],
    ];
    if (a.syncState) {
      aRows.push([
        'SyncHandle status',
        `${a.syncState.state} (${a.syncState.mode}) · LSN ${a.syncState.replicaLsn}/${a.syncState.primaryLsn} · lag ${a.syncState.lagEntries}`,
      ]);
    }
    block.append(table([{ name: 'Metric' }, { name: 'Value' }], aRows));
  }

  if (entry.outbox !== undefined) {
    const ob = entry.outbox;
    block.append(
      table(
        [{ name: 'Metric' }, { name: 'Value' }],
        [
          ['Pending optimistic mutations', ob.pendingCount],
          [
            'Confirmed / Reverted / Rebased',
            `${ob.confirmedCount} / ${ob.revertedCount} / ${ob.rebasedCount}`,
          ],
          [
            'Queued IDs',
            ob.pending.length > 0
              ? ob.pending.map((m) => `${m.id} (${m.operation} ${m.tableName})`).join(', ')
              : 'none',
          ],
        ],
      ),
    );
  }

  const meta = el('p', 'meta');
  meta.textContent = `${summary(entry, fields.length > 0)} · ${entry.ms.toFixed(1)} ms`;
  block.append(meta);
  return block;
}
