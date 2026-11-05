/**
 * replication.js – Interactive Firebird Database Replication Simulator & Demo.
 *
 * Drives the logical & journal-based replication engine (`createPublication`,
 * `createSubscription`, `replicateDatabases`, `buildReplicationTriggerDdl`,
 * and `mergeReplicatedRow`).
 */

// ---------------------------------------------------------------------------
// Load replication engine from `./firebird-browser.mjs` (with built-in fallback
// so `demo/public/replication.html` also works if opened without a build step)
// ---------------------------------------------------------------------------

function fallbackMergeRow(before, localRow, remoteAfter) {
  const b = before || {};
  const l = localRow || {};
  const r = remoteAfter || {};
  const merged = { ...l };
  const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
  for (const k of keys) {
    if (JSON.stringify(r[k]) !== JSON.stringify(b[k]) && r[k] !== undefined) {
      merged[k] = r[k];
    }
  }
  return merged;
}

function fallbackBuildTriggerDdl({
  table = 'TASKS',
  primaryKey = ['ID'],
  columns = ['ID', 'TITLE', 'OWNER', 'PRIORITY', 'DONE'],
  publication = 'pub_primary',
  nodeId = 'primary',
} = {}) {
  const triggerName = `FB_REPL_TRG$${table.toUpperCase()}`;
  const eventName = `fb_repl_${publication}`;
  const ddl = [
    `CREATE OR ALTER TRIGGER ${triggerName} FOR ${table.toUpperCase()}`,
    `ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 32000`,
    `AS`,
    `  DECLARE VARIABLE v_op VARCHAR(16);`,
    `  DECLARE VARIABLE v_key VARCHAR(2000);`,
    `  DECLARE VARIABLE v_after VARCHAR(8191);`,
    `  DECLARE VARIABLE v_before VARCHAR(8191);`,
    `  DECLARE VARIABLE v_origin VARCHAR(128);`,
    `BEGIN`,
    `  IF (RDB$GET_CONTEXT('USER_SESSION', 'FB_REPL_ROLE') IS DISTINCT FROM 'REPLICA') THEN`,
    `  BEGIN`,
    `    v_origin = COALESCE(RDB$GET_CONTEXT('USER_SESSION', 'FB_REPL_ORIGIN'), '${nodeId}');`,
    `    -- Serializes ${primaryKey.join(', ')} into KEY_JSON and ${columns.join(', ')} into AFTER_JSON / BEFORE_JSON`,
    `    INSERT INTO FB_REPL_JOURNAL$ (LSN, TXID, ORIGIN, PUBLICATION, TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS)`,
    `    VALUES (`,
    `      NEXT VALUE FOR FB_REPL_LSN_GEN$,`,
    `      CAST(CURRENT_TRANSACTION AS VARCHAR(128)),`,
    `      :v_origin,`,
    `      '${publication}',`,
    `      '${table.toUpperCase()}',`,
    `      :v_op, :v_key, :v_after, :v_before, NULL,`,
    `      DATEDIFF(MILLISECOND FROM TIMESTAMP '1970-01-01 00:00:00' TO CURRENT_TIMESTAMP)`,
    `    );`,
    `    POST_EVENT '${eventName}';`,
    `  END`,
    `END`,
  ].join('\n');
  return { triggerName, eventName, ddl };
}

let replLib = {
  mergeReplicatedRow: fallbackMergeRow,
  buildReplicationTriggerDdl: fallbackBuildTriggerDdl,
  replicateDatabases: null,
};

try {
  const mod = await import('./firebird-browser.mjs');
  if (mod.replicateDatabases) {
    replLib = {
      mergeReplicatedRow: mod.mergeReplicatedRow || fallbackMergeRow,
      buildReplicationTriggerDdl: mod.buildReplicationTriggerDdl || fallbackBuildTriggerDdl,
      replicateDatabases: mod.replicateDatabases,
    };
  }
} catch {
  // Running directly from demo/public without bundle; simulator uses built-in engine
}

// ---------------------------------------------------------------------------
// In-Memory SQL Database Node Satisfying `ReplicableDatabase`
// ---------------------------------------------------------------------------

function createSimNode(nodeId) {
  const tables = new Map();
  const ddlLog = [];

  const getTable = (name) => {
    const upper = name.replace(/"/g, '').toUpperCase();
    if (!tables.has(upper)) {
      tables.set(upper, []);
    }
    return tables.get(upper);
  };

  const runSelect = (sql, params = []) => {
    const trimmed = sql.trim();

    if (/RDB\$SET_CONTEXT\s*\(/i.test(trimmed)) {
      return { rows: [{ RESULT: 1 }] };
    }

    const maxMatch = /SELECT\s+MAX\(LSN\)\s+AS\s+MAX_LSN\s+FROM\s+([A-Za-z0-9_$"]+)/i.exec(trimmed);
    if (maxMatch) {
      const rows = getTable(maxMatch[1]);
      let max = 0;
      for (const r of rows) {
        const lsn = Number(r.LSN ?? 0);
        if (lsn > max) max = lsn;
      }
      return { rows: [{ MAX_LSN: max }] };
    }

    const descMatch = /SELECT\s+LSN\s+FROM\s+([A-Za-z0-9_$"]+)\s+ORDER\s+BY\s+LSN\s+DESC/i.exec(trimmed);
    if (descMatch) {
      const rows = [...getTable(descMatch[1])].sort((a, b) => Number(b.LSN ?? 0) - Number(a.LSN ?? 0));
      return { rows: rows.map((r) => ({ LSN: r.LSN })) };
    }

    const journalSinceMatch = /FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*>\s*\?\s+ORDER\s+BY\s+LSN\s+ASC/i.exec(trimmed);
    if (journalSinceMatch) {
      const minLsn = Number(params[0] ?? 0);
      const rows = getTable(journalSinceMatch[1])
        .filter((r) => Number(r.LSN ?? 0) > minLsn)
        .sort((a, b) => Number(a.LSN ?? 0) - Number(b.LSN ?? 0))
        .map((r) => ({ ...r }));
      return { rows };
    }

    const journalPruneMatch = /FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*<=\s*\?/i.exec(trimmed);
    if (journalPruneMatch && /^SELECT\b/i.test(trimmed)) {
      const maxLsn = Number(params[0] ?? 0);
      const rows = getTable(journalPruneMatch[1])
        .filter((r) => Number(r.LSN ?? 0) <= maxLsn)
        .map((r) => ({ ...r }));
      return { rows };
    }

    const watermarkMatch = /FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+SUB_NAME\s*=\s*\?/i.exec(trimmed);
    if (watermarkMatch && /^SELECT\b/i.test(trimmed)) {
      const subName = String(params[0] ?? '');
      const rows = getTable(watermarkMatch[1])
        .filter((r) => String(r.SUB_NAME) === subName)
        .map((r) => ({ ...r }));
      return { rows };
    }

    const fromMatch = /FROM\s+([A-Za-z0-9_$"]+)(?:\s+WHERE\s+(.+))?$/i.exec(trimmed);
    if (fromMatch) {
      const list = getTable(fromMatch[1]);
      const wherePart = fromMatch[2];
      if (!wherePart) {
        return { rows: list.map((r) => ({ ...r })) };
      }
      const cols = wherePart
        .split(/\s+AND\s+/i)
        .map((part) => part.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      const filtered = list
        .filter((r) => cols.every((c, idx) => r[c] === params[idx]))
        .map((r) => ({ ...r }));
      return { rows: filtered };
    }

    return { rows: [] };
  };

  const runMutation = (sql, params = []) => {
    const trimmed = sql.trim();

    if (/^\s*(CREATE|ALTER)\s+TABLE\s+([A-Za-z0-9_$"]+)/i.test(trimmed)) {
      const m = /^\s*(CREATE|ALTER)\s+TABLE\s+([A-Za-z0-9_$"]+)/i.exec(trimmed);
      const tbl = m[2].replace(/"/g, '').toUpperCase();
      getTable(tbl);
      if (!tbl.startsWith('FB_REPL_')) {
        ddlLog.push(trimmed);
      }
      return;
    }

    const insertMatch = /^INSERT\s+INTO\s+([A-Za-z0-9_$"]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(trimmed);
    if (insertMatch) {
      const list = getTable(insertMatch[1]);
      const cols = insertMatch[2].split(',').map((c) => c.trim().replace(/"/g, '').toUpperCase());
      const row = {};
      cols.forEach((col, i) => {
        row[col] = params[i];
      });
      list.push(row);
      return;
    }

    const updateMatch = /^UPDATE\s+([A-Za-z0-9_$"]+)\s+SET\s+(.+)\s+WHERE\s+(.+)$/i.exec(trimmed);
    if (updateMatch) {
      const list = getTable(updateMatch[1]);
      const setCols = updateMatch[2].split(',').map((p) => p.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      const whereCols = updateMatch[3].split(/\s+AND\s+/i).map((p) => p.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      for (const r of list) {
        const matches = whereCols.every((c, i) => r[c] === params[setCols.length + i]);
        if (matches) {
          setCols.forEach((c, i) => {
            r[c] = params[i];
          });
        }
      }
      return;
    }

    const deletePruneMatch = /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*<=\s*\?/i.exec(trimmed);
    if (deletePruneMatch) {
      const tbl = deletePruneMatch[1].replace(/"/g, '').toUpperCase();
      const maxLsn = Number(params[0] ?? 0);
      tables.set(
        tbl,
        getTable(tbl).filter((r) => Number(r.LSN ?? 0) > maxLsn),
      );
      return;
    }

    const deleteMatch = /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+(.+)$/i.exec(trimmed);
    if (deleteMatch) {
      const tbl = deleteMatch[1].replace(/"/g, '').toUpperCase();
      const whereCols = deleteMatch[2].split(/\s+AND\s+/i).map((p) => p.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      tables.set(
        tbl,
        getTable(tbl).filter((r) => !whereCols.every((c, i) => r[c] === params[i])),
      );
    }
  };

  const db = {
    nodeId,
    tables,
    ddlLog,
    async query(sql, params = []) {
      if (/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        runMutation(sql, params);
        return { rows: [] };
      }
      return runSelect(sql, params);
    },
    async execute(sql, params = []) {
      runMutation(sql, params);
      return { changes: 1 };
    },
    async exec(sql, params = []) {
      runMutation(sql, params);
    },
    async transaction(fn) {
      return fn(db);
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Built-in Replication Coordinator Fallback (if bundle is not present)
// ---------------------------------------------------------------------------

async function createFallbackReplicator(options) {
  const { primary, replica, direction, onConflict, onConflictResolved } = options;
  let primaryLsn = 0;
  let replicaLsn = 0;
  let replicaWatermark = 0;
  let primaryWatermark = 0;

  const primaryJournal = [];
  const replicaJournal = [];
  const primaryMirror = new Map();
  const replicaMirror = new Map();

  const captureFor = (db, mirror, journal, origin, nextLsn) => {
    const rows = db.tables.get('TASKS') || [];
    const nextMap = new Map();
    for (const r of rows) {
      const clone = { ...r };
      nextMap.set(r.ID, clone);
      const prev = mirror.get(r.ID);
      if (!prev) {
        journal.push({
          lsn: nextLsn(),
          txid: `${origin}-tx-${Date.now()}`,
          origin,
          publication: `pub_${origin}`,
          table: 'TASKS',
          operation: 'INSERT',
          key: { ID: r.ID },
          after: clone,
          before: null,
          timestamp: Date.now(),
        });
      } else if (JSON.stringify(prev) !== JSON.stringify(clone)) {
        journal.push({
          lsn: nextLsn(),
          txid: `${origin}-tx-${Date.now()}`,
          origin,
          publication: `pub_${origin}`,
          table: 'TASKS',
          operation: 'UPDATE',
          key: { ID: r.ID },
          after: clone,
          before: prev,
          timestamp: Date.now(),
        });
      }
    }
    for (const [id, prev] of mirror.entries()) {
      if (!nextMap.has(id)) {
        journal.push({
          lsn: nextLsn(),
          txid: `${origin}-tx-${Date.now()}`,
          origin,
          publication: `pub_${origin}`,
          table: 'TASKS',
          operation: 'DELETE',
          key: { ID: id },
          after: null,
          before: prev,
          timestamp: Date.now(),
        });
      }
    }
    mirror.clear();
    for (const [k, v] of nextMap.entries()) mirror.set(k, v);
  };

  const applyFrom = (sourceJournal, sinceLsn, targetDb, targetMirror, targetOrigin, strategy) => {
    const entries = sourceJournal.filter((e) => e.lsn > sinceLsn && e.origin !== targetOrigin);
    let appliedCount = 0;
    let conflictCount = 0;
    let currentLsn = sinceLsn;

    const targetRows = targetDb.tables.get('TASKS') || [];
    for (const entry of entries) {
      if (entry.lsn > currentLsn) currentLsn = entry.lsn;
      if (entry.operation === 'DDL') {
        appliedCount++;
        continue;
      }
      const idx = targetRows.findIndex((r) => r.ID === entry.key.ID);
      const localRow = idx >= 0 ? { ...targetRows[idx] } : null;
      const isConflict =
        entry.operation === 'UPDATE' &&
        entry.before &&
        localRow &&
        JSON.stringify(localRow) !== JSON.stringify(entry.before);

      if (isConflict) {
        conflictCount++;
        let outcome = 'remote-wins';
        if (strategy === 'local-wins' || strategy === 'replica-wins') outcome = 'local-wins';
        else if (strategy === 'merge') outcome = 'merge';
        onConflictResolved?.({ incoming: entry, localRow }, outcome);

        if (outcome === 'local-wins') continue;
        if (outcome === 'merge') {
          const merged = fallbackMergeRow(entry.before, localRow, entry.after);
          targetRows[idx] = merged;
          targetMirror.set(merged.ID, { ...merged });
          appliedCount++;
          continue;
        }
      }

      if (entry.operation === 'DELETE') {
        if (idx >= 0) targetRows.splice(idx, 1);
        targetMirror.delete(entry.key.ID);
      } else if (entry.after) {
        if (idx >= 0) targetRows[idx] = { ...entry.after };
        else targetRows.push({ ...entry.after });
        targetMirror.set(entry.key.ID, { ...entry.after });
      }
      appliedCount++;
    }
    return { fetchedCount: entries.length, appliedCount, conflictCount, previousLsn: sinceLsn, currentLsn };
  };

  return {
    primaryPublication: {
      currentLsn: async () => primaryLsn,
      fetchChangesSince: async (lsn) => primaryJournal.filter((e) => e.lsn > lsn),
      pruneJournal: async (upTo) => {
        const before = primaryJournal.length;
        const kept = primaryJournal.filter((e) => e.lsn > upTo);
        primaryJournal.length = 0;
        primaryJournal.push(...kept);
        return before - kept.length;
      },
      recordDdl: async (sql) => {
        const entry = {
          lsn: ++primaryLsn,
          txid: `primary-ddl-${primaryLsn}`,
          origin: 'primary',
          publication: 'pub_primary',
          table: '$DDL',
          operation: 'DDL',
          key: {},
          after: null,
          before: null,
          ddlSql: sql,
          timestamp: Date.now(),
        };
        primaryJournal.push(entry);
        return entry;
      },
      captureTableChanges: async () => {
        captureFor(primary, primaryMirror, primaryJournal, 'primary', () => ++primaryLsn);
      },
    },
    replicaPublication: {
      fetchChangesSince: async (lsn) => replicaJournal.filter((e) => e.lsn > lsn),
      captureTableChanges: async () => {
        captureFor(replica, replicaMirror, replicaJournal, 'replica', () => ++replicaLsn);
      },
    },
    replicaSubscription: {
      getWatermark: async () => replicaWatermark,
    },
    async sync() {
      captureFor(primary, primaryMirror, primaryJournal, 'primary', () => ++primaryLsn);
      if (direction === 'bidirectional') {
        captureFor(replica, replicaMirror, replicaJournal, 'replica', () => ++replicaLsn);
      }
      const p2r = applyFrom(primaryJournal, replicaWatermark, replica, replicaMirror, 'replica', onConflict);
      replicaWatermark = p2r.currentLsn;
      let r2p;
      if (direction === 'bidirectional') {
        const revStrategy =
          onConflict === 'primary-wins' ? 'local-wins' : onConflict === 'replica-wins' ? 'remote-wins' : onConflict;
        r2p = applyFrom(replicaJournal, primaryWatermark, primary, primaryMirror, 'primary', revStrategy);
        primaryWatermark = r2p.currentLsn;
        if (r2p.conflictCount > 0) {
          captureFor(primary, primaryMirror, primaryJournal, 'primary', () => ++primaryLsn);
          const p2rFix = applyFrom(primaryJournal, replicaWatermark, replica, replicaMirror, 'replica', 'remote-wins');
          replicaWatermark = p2rFix.currentLsn;
        }
      }
      return { primaryToReplica: p2r, replicaToPrimary: r2p };
    },
    stop: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Simulator State & UI Wiring
// ---------------------------------------------------------------------------

let primaryDb;
let replicaDb;
let replicator;
let isOnline = true;
let totalConflictsResolved = 0;
let nextTaskId = 4;
let activeCodeTab = 'setup';

const INITIAL_TASKS = [
  { ID: 1, TITLE: 'Compile Firebird 5 to WASM', OWNER: 'Ada', PRIORITY: 'HIGH', DONE: 1 },
  { ID: 2, TITLE: 'Add OPFS SyncAccessHandle VFS', OWNER: 'Grace', PRIORITY: 'MEDIUM', DONE: 1 },
  { ID: 3, TITLE: 'Build Logical Journal Replication', OWNER: 'Alan', PRIORITY: 'HIGH', DONE: 0 },
];

const directionSelect = document.getElementById('direction-select');
const conflictSelect = document.getElementById('conflict-select');
const toggleNetworkBtn = document.getElementById('toggle-network');
const syncNowBtn = document.getElementById('sync-now');
const pruneJournalBtn = document.getElementById('prune-journal');
const resetSimBtn = document.getElementById('reset-sim');

const primaryRowsEl = document.getElementById('primary-rows');
const replicaRowsEl = document.getElementById('replica-rows');
const journalRowsEl = document.getElementById('journal-rows');
const eventFeedEl = document.getElementById('event-feed');
const codeInspectorEl = document.getElementById('code-inspector');

const primaryLsnBadge = document.getElementById('primary-lsn-badge');
const replicaWatermarkBadge = document.getElementById('replica-watermark-badge');
const journalCountBadge = document.getElementById('journal-count-badge');
const topologyBadge = document.getElementById('topology-badge');
const linkArrow = document.getElementById('link-arrow');
const linkStats = document.getElementById('link-stats');

function logEvent(html, isConflict = false) {
  const div = document.createElement('div');
  div.className = `event-item${isConflict ? ' conflict' : ''}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  div.innerHTML = `[${time}] ${html}`;
  eventFeedEl.prepend(div);
}

function getSetupCodeSnippet() {
  const direction = directionSelect.value;
  const conflict = conflictSelect.value;
  return [
    `import { FirebirdBrowser, replicateDatabases } from 'firebird-wasm/browser';`,
    ``,
    `const primary = await FirebirdBrowser.create({ database: 'primary.fdb' });`,
    `const replica = await FirebirdBrowser.create({ database: 'replica.fdb' });`,
    ``,
    `const replicator = await replicateDatabases({`,
    `  primary,`,
    `  replica,`,
    `  tables: [`,
    `    {`,
    `      table: 'TASKS',`,
    `      primaryKey: 'ID',`,
    `      columns: ['ID', 'TITLE', 'OWNER', 'PRIORITY', 'DONE'],`,
    `    },`,
    `  ],`,
    `  direction: '${direction}',`,
    `  onConflict: '${conflict}',`,
    `  installTriggers: true, // Installs FB_REPL_TRG$TASKS PSQL trigger`,
    `});`,
    ``,
    `// Run a sync cycle or start background replication:`,
    `await replicator.sync();`,
  ].join('\n');
}

function updateCodeInspector() {
  if (activeCodeTab === 'setup') {
    codeInspectorEl.textContent = getSetupCodeSnippet();
  } else {
    const built = replLib.buildReplicationTriggerDdl({
      table: 'TASKS',
      primaryKey: ['ID'],
      columns: ['ID', 'TITLE', 'OWNER', 'PRIORITY', 'DONE'],
      publication: 'pub_primary',
      nodeId: 'primary',
    });
    codeInspectorEl.textContent = built.ddl;
  }
}

async function initSimulator() {
  if (replicator) {
    await replicator.stop();
  }
  primaryDb = createSimNode('primary');
  replicaDb = createSimNode('replica');
  totalConflictsResolved = 0;
  nextTaskId = 4;

  primaryDb.tables.set(
    'TASKS',
    INITIAL_TASKS.map((r) => ({ ...r })),
  );
  replicaDb.tables.set('TASKS', []);

  const direction = directionSelect.value;
  const onConflict = conflictSelect.value;

  const opts = {
    primary: primaryDb,
    replica: replicaDb,
    tables: [{ table: 'TASKS', primaryKey: 'ID', columns: ['ID', 'TITLE', 'OWNER', 'PRIORITY', 'DONE'] }],
    direction,
    onConflict,
    onConflictResolved: (ctx, resolution) => {
      totalConflictsResolved++;
      logEvent(
        `⚡ <strong>Conflict Resolved</strong> on <code>${ctx.incoming.table}</code> (ID=${ctx.incoming.key.ID}) via <strong>${resolution}</strong> (policy: <code>${onConflict}</code>)`,
        true,
      );
    },
  };

  if (replLib.replicateDatabases) {
    replicator = await replLib.replicateDatabases(opts);
  } else {
    replicator = await createFallbackReplicator(opts);
  }

  // Initial seed sync so both nodes start with the 3 initial tasks
  await replicator.sync();
  logEvent(
    `Initialized <strong>${direction}</strong> replication with <code>onConflict: '${onConflict}'</code>.`,
  );
  await renderAll();
}

async function maybeAutoSync() {
  if (isOnline) {
    const res = await replicator.sync();
    const applied =
      (res.primaryToReplica?.appliedCount || 0) + (res.replicaToPrimary?.appliedCount || 0);
    if (applied > 0) {
      logEvent(
        `Replicated <strong>${applied}</strong> change(s) (${res.primaryToReplica.appliedCount} P→R, ${res.replicaToPrimary?.appliedCount ?? 0} R→P).`,
      );
    }
  } else {
    // Capture into local journals so pending count is visible while partitioned
    await replicator.primaryPublication.captureTableChanges();
    if (replicator.replicaPublication) {
      await replicator.replicaPublication.captureTableChanges();
    }
    logEvent(`Network link is <strong>OFFLINE</strong> — change queued in local journal.`);
  }
  await renderAll();
}

function renderTaskTable(tbody, rows) {
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="color: var(--muted); text-align: center;">No rows</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.ID}</td>
      <td>${escapeHtml(String(r.TITLE ?? ''))}</td>
      <td>${escapeHtml(String(r.OWNER ?? ''))}</td>
      <td><span class="badge">${escapeHtml(String(r.PRIORITY ?? ''))}</span></td>
      <td>${Number(r.DONE) ? '✓ Done' : '○ Open'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderAll() {
  renderTaskTable(primaryRowsEl, primaryDb.tables.get('TASKS') || []);
  renderTaskTable(replicaRowsEl, replicaDb.tables.get('TASKS') || []);

  const primaryLsn = await replicator.primaryPublication.currentLsn();
  const watermarkLsn = await replicator.replicaSubscription.getWatermark();

  primaryLsnBadge.textContent = `Journal LSN: ${primaryLsn}`;
  replicaWatermarkBadge.textContent = `Watermark LSN: ${watermarkLsn}`;

  const primaryEntries = await replicator.primaryPublication.fetchChangesSince(0);
  const replicaEntries = replicator.replicaPublication
    ? await replicator.replicaPublication.fetchChangesSince(0)
    : [];

  const allEntries = [...primaryEntries, ...replicaEntries].sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return b.lsn - a.lsn;
  });

  journalCountBadge.textContent = `${allEntries.length} entries`;
  journalRowsEl.innerHTML = '';

  if (allEntries.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" style="color: var(--muted); text-align: center;">Journal empty</td>`;
    journalRowsEl.appendChild(tr);
  } else {
    for (const e of allEntries.slice(0, 12)) {
      const tr = document.createElement('tr');
      const summary =
        e.operation === 'DDL'
          ? escapeHtml(String(e.ddlSql || ''))
          : `${e.before ? escapeHtml(JSON.stringify(e.before)) + ' → ' : ''}${
              e.after ? escapeHtml(JSON.stringify(e.after)) : 'DELETED'
            }`;
      tr.innerHTML = `
        <td>#${e.lsn}</td>
        <td><span class="badge">${escapeHtml(e.origin)}</span></td>
        <td><span class="op-pill op-${e.operation}">${e.operation}</span></td>
        <td>${escapeHtml(e.table)}</td>
        <td><code>${escapeHtml(JSON.stringify(e.key))}</code></td>
        <td style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${summary}">${summary}</td>
      `;
      journalRowsEl.appendChild(tr);
    }
  }

  const pendingP2R = Math.max(0, primaryLsn - watermarkLsn);
  const direction = directionSelect.value;
  topologyBadge.textContent =
    direction === 'bidirectional' ? 'PRIMARY ↔ REPLICA' : 'PRIMARY → REPLICA';
  linkArrow.textContent = isOnline
    ? direction === 'bidirectional'
      ? '⇄'
      : '→'
    : '✕';
  linkArrow.className = `link-arrow${isOnline ? '' : ' offline'}`;
  linkStats.innerHTML = `Pending P→R: ${pendingP2R}<br/>Conflicts resolved: ${totalConflictsResolved}`;

  updateCodeInspector();
}

// ---------------------------------------------------------------------------
// Button & Scenario Handlers
// ---------------------------------------------------------------------------

directionSelect.addEventListener('change', () => initSimulator());
conflictSelect.addEventListener('change', () => initSimulator());

toggleNetworkBtn.addEventListener('click', () => {
  isOnline = !isOnline;
  toggleNetworkBtn.textContent = isOnline
    ? '● Link Online (Auto-Sync)'
    : '○ Link Offline (Partitioned)';
  toggleNetworkBtn.className = `btn-sm ${isOnline ? 'online' : 'offline'}`;
  logEvent(
    isOnline
      ? 'Network link restored to <strong>ONLINE</strong>.'
      : 'Network link switched to <strong>OFFLINE PARTITION</strong>.',
  );
  void renderAll();
});

syncNowBtn.addEventListener('click', async () => {
  const res = await replicator.sync();
  const applied =
    (res.primaryToReplica?.appliedCount || 0) + (res.replicaToPrimary?.appliedCount || 0);
  logEvent(
    `Manual <code>replicator.sync()</code> complete — applied <strong>${applied}</strong> entry/entries.`,
  );
  await renderAll();
});

pruneJournalBtn.addEventListener('click', async () => {
  const watermark = await replicator.replicaSubscription.getWatermark();
  const pruned = await replicator.primaryPublication.pruneJournal(watermark);
  logEvent(
    `Pruned <strong>${pruned}</strong> journal entry/entries with <code>LSN &lt;= ${watermark}</code>.`,
  );
  await renderAll();
});

resetSimBtn.addEventListener('click', () => {
  isOnline = true;
  toggleNetworkBtn.textContent = '● Link Online (Auto-Sync)';
  toggleNetworkBtn.className = 'btn-sm online';
  void initSimulator();
});

// Primary node mutations
document.getElementById('primary-insert').addEventListener('click', async () => {
  const id = nextTaskId++;
  const owners = ['Ada', 'Grace', 'Alan', 'Radia'];
  await primaryDb.execute(
    'INSERT INTO TASKS (ID, TITLE, OWNER, PRIORITY, DONE) VALUES (?, ?, ?, ?, ?)',
    [id, `Task #${id} (from Primary)`, owners[id % owners.length], 'MEDIUM', 0],
  );
  await maybeAutoSync();
});

document.getElementById('primary-update-title').addEventListener('click', async () => {
  const suffix = Math.floor(Math.random() * 90 + 10);
  await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
    `Primary Edit #${suffix}`,
    1,
  ]);
  await maybeAutoSync();
});

document.getElementById('primary-escalate').addEventListener('click', async () => {
  await primaryDb.execute('UPDATE TASKS SET PRIORITY = ? WHERE ID = ?', ['CRITICAL', 1]);
  await maybeAutoSync();
});

document.getElementById('primary-delete-last').addEventListener('click', async () => {
  const rows = primaryDb.tables.get('TASKS') || [];
  if (rows.length === 0) return;
  const lastId = rows[rows.length - 1].ID;
  await primaryDb.execute('DELETE FROM TASKS WHERE ID = ?', [lastId]);
  await maybeAutoSync();
});

// Replica node mutations
document.getElementById('replica-insert').addEventListener('click', async () => {
  const id = nextTaskId++;
  await replicaDb.execute(
    'INSERT INTO TASKS (ID, TITLE, OWNER, PRIORITY, DONE) VALUES (?, ?, ?, ?, ?)',
    [id, `Task #${id} (from Replica)`, 'Susan', 'LOW', 0],
  );
  await maybeAutoSync();
});

document.getElementById('replica-toggle-done').addEventListener('click', async () => {
  const rows = replicaDb.tables.get('TASKS') || [];
  const row1 = rows.find((r) => r.ID === 1);
  if (!row1) return;
  const nextDone = Number(row1.DONE) ? 0 : 1;
  await replicaDb.execute('UPDATE TASKS SET DONE = ? WHERE ID = ?', [nextDone, 1]);
  await maybeAutoSync();
});

document.getElementById('replica-update-title').addEventListener('click', async () => {
  const suffix = Math.floor(Math.random() * 90 + 10);
  await replicaDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
    `Replica Edit #${suffix}`,
    1,
  ]);
  await maybeAutoSync();
});

// Code inspector tabs
document.getElementById('show-setup-code').addEventListener('click', () => {
  activeCodeTab = 'setup';
  updateCodeInspector();
});

document.getElementById('show-trigger-ddl').addEventListener('click', () => {
  activeCodeTab = 'trigger';
  updateCodeInspector();
});

// 1-Click Scenarios
for (const btn of document.querySelectorAll('.scenario-card')) {
  btn.addEventListener('click', async () => {
    const kind = btn.getAttribute('data-scenario');

    if (kind === 'stream') {
      const id = nextTaskId++;
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TITLE, OWNER, PRIORITY, DONE) VALUES (?, ?, ?, ?, ?)',
        [id, `Streamed Task #${id}`, 'Ada', 'HIGH', 0],
      );
      await primaryDb.execute('UPDATE TASKS SET DONE = ? WHERE ID = ?', [1, 3]);
      const res = await replicator.sync();
      logEvent(
        `Scenario 1: Streamed <strong>${res.primaryToReplica.appliedCount}</strong> DML mutations from Primary → Replica.`,
      );
      await renderAll();
    } else if (kind === 'merge') {
      if (directionSelect.value !== 'bidirectional' || conflictSelect.value !== 'merge') {
        directionSelect.value = 'bidirectional';
        conflictSelect.value = 'merge';
        await initSimulator();
      }
      // Partition edits on Row #1: Primary changes TITLE, Replica changes PRIORITY and DONE
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
        'Merged Title (from Primary)',
        1,
      ]);
      await replicaDb.execute('UPDATE TASKS SET PRIORITY = ?, DONE = ? WHERE ID = ?', [
        'URGENT (from Replica)',
        0,
        1,
      ]);
      await replicator.sync();
      logEvent(
        `Scenario 2: Concurrent edits to Row #1 (<code>TITLE</code> on Primary, <code>PRIORITY</code> + <code>DONE</code> on Replica) converged via <strong>3-Way Field Merge</strong>!`,
        true,
      );
      await renderAll();
    } else if (kind === 'lww') {
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
        'Primary Concurrent Title',
        1,
      ]);
      await replicaDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
        'Replica Concurrent Title',
        1,
      ]);
      await replicator.sync();
      logEvent(
        `Scenario 3: Same-column concurrent edit on Row #1 resolved using <code>${conflictSelect.value}</code>.`,
        true,
      );
      await renderAll();
    } else if (kind === 'ddl') {
      const ddl = 'ALTER TABLE TASKS ADD TAGS VARCHAR(120)';
      await replicator.primaryPublication.recordDdl(ddl);
      const res = await replicator.sync();
      logEvent(
        `Scenario 4: Recorded DDL <code>${ddl}</code> in <code>FB_REPL_JOURNAL$</code> and replicated to Replica (${res.primaryToReplica.appliedCount} applied).`,
      );
      await renderAll();
    }
  });
}

// Boot simulator
void initSimulator();
