/**
 * replication.js – Interactive Firebird Database Replication Simulator v2 & Demo.
 *
 * Drives the logical & journal-based replication engine (`createPublication`,
 * `createSubscription`, `replicateDatabases`, `buildReplicationTriggerDdl`,
 * `mergeReplicatedRow`, `mergeCrdtRow`, `createHlc`, and `encodeNativeJournalSegment`).
 */

// ---------------------------------------------------------------------------
// Load replication engine from `./firebird-browser.mjs` (with built-in fallback
// so `demo/public/replication.html` also works if opened without a build step)
// ---------------------------------------------------------------------------

function createBuiltinHlc(nodeId) {
  let wallMs = Date.now();
  let counter = 0;

  const parse = (str) => {
    const parts = String(str || '').split(':');
    return {
      wallMs: Number(parts[0] || 0),
      counter: Number(parts[1] || 0),
      nodeId: parts.slice(2).join(':') || nodeId,
    };
  };

  const format = (ts) => `${ts.wallMs}:${ts.counter}:${ts.nodeId}`;

  return {
    now(physicalMs = Date.now()) {
      if (physicalMs > wallMs) {
        wallMs = physicalMs;
        counter = 0;
      } else {
        counter += 1;
      }
      return { wallMs, counter, nodeId };
    },
    receive(remote, physicalMs = Date.now()) {
      const r = typeof remote === 'string' ? parse(remote) : remote;
      if (physicalMs > wallMs && physicalMs > r.wallMs) {
        wallMs = physicalMs;
        counter = 0;
      } else if (r.wallMs > wallMs) {
        wallMs = r.wallMs;
        counter = r.counter + 1;
      } else if (wallMs > r.wallMs) {
        counter += 1;
      } else {
        counter = Math.max(counter, r.counter) + 1;
      }
      return { wallMs, counter, nodeId };
    },
    format,
    parse,
  };
}

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

function fallbackMergeCrdtRow(before, localRow, remoteAfter, crdtCols = { STOCK: 'pn-counter', TAGS: 'set-union' }, remoteWinsLww = true) {
  const b = before || {};
  const l = localRow || {};
  const r = remoteAfter || {};
  const merged = { ...l };
  const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);

  for (const col of keys) {
    const mode = crdtCols[col] || 'hlc-lww';
    const bVal = b[col];
    const lVal = l[col];
    const rVal = r[col];

    if (mode === 'pn-counter') {
      const baseNum = Number(bVal ?? 0);
      const localNum = Number(lVal ?? baseNum);
      const remoteNum = Number(rVal ?? baseNum);
      merged[col] = baseNum + (localNum - baseNum) + (remoteNum - baseNum);
    } else if (mode === 'set-union') {
      const toSet = (v) =>
        new Set(
          String(v ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      const bSet = toSet(bVal);
      const lSet = toSet(lVal);
      const rSet = toSet(rVal);
      const union = new Set([...lSet, ...rSet]);
      for (const item of bSet) {
        if (!lSet.has(item) || !rSet.has(item)) {
          union.delete(item);
        }
      }
      merged[col] = [...union].sort().join(',');
    } else {
      const localChanged = JSON.stringify(lVal) !== JSON.stringify(bVal);
      const remoteChanged = JSON.stringify(rVal) !== JSON.stringify(bVal);
      if (remoteChanged && !localChanged) {
        merged[col] = rVal;
      } else if (localChanged && !remoteChanged) {
        merged[col] = lVal;
      } else if (localChanged && remoteChanged) {
        merged[col] = remoteWinsLww ? rVal : lVal;
      }
    }
  }
  return merged;
}

function fallbackEncodeNativeJournalSegment(entries) {
  const encoder = new TextEncoder();
  const payloads = entries.map((e) => encoder.encode(JSON.stringify(e)));
  const totalPayload = payloads.reduce((acc, p) => acc + 4 + p.byteLength, 0);
  const out = new Uint8Array(24 + totalPayload);
  const view = new DataView(out.buffer);
  const minLsn = entries.length > 0 ? Math.min(...entries.map((e) => e.lsn)) : 0;
  const maxLsn = entries.length > 0 ? Math.max(...entries.map((e) => e.lsn)) : 0;

  view.setUint32(0, 0x52444246, true); // 'FBDR' little-endian
  view.setUint32(4, 1, true); // version 1
  view.setUint32(8, entries.length, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, minLsn >>> 0, true);
  view.setUint32(20, maxLsn >>> 0, true);

  let offset = 24;
  for (const p of payloads) {
    view.setUint32(offset, p.byteLength, true);
    offset += 4;
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function fallbackBuildTriggerDdl({
  table = 'TASKS',
  primaryKey = ['ID'],
  columns = ['ID', 'TENANT_ID', 'TITLE', 'PRIORITY', 'STOCK', 'TAGS', 'DONE'],
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
  mergeCrdtRow: fallbackMergeCrdtRow,
  encodeNativeJournalSegment: fallbackEncodeNativeJournalSegment,
  buildReplicationTriggerDdl: fallbackBuildTriggerDdl,
};

try {
  const mod = await import('./firebird-browser.mjs');
  if (mod.mergeReplicatedRow) {
    replLib = {
      mergeReplicatedRow: mod.mergeReplicatedRow || fallbackMergeRow,
      mergeCrdtRow: mod.mergeCrdtRow || fallbackMergeCrdtRow,
      encodeNativeJournalSegment:
        mod.encodeNativeJournalSegment || fallbackEncodeNativeJournalSegment,
      decodeNativeJournalSegment: mod.decodeNativeJournalSegment,
      buildReplicationTriggerDdl:
        mod.buildReplicationTriggerDdl || fallbackBuildTriggerDdl,
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
  const hlc = createBuiltinHlc(nodeId);
  let lastHlcFormatted = `${Date.now()}:0:${nodeId}`;

  const getTable = (name) => {
    const upper = name.replace(/"/g, '').toUpperCase();
    if (!tables.has(upper)) {
      tables.set(upper, []);
    }
    return tables.get(upper);
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

  return {
    nodeId,
    tables,
    ddlLog,
    hlc,
    nextHlc() {
      const ts = hlc.now();
      lastHlcFormatted = hlc.format(ts);
      return lastHlcFormatted;
    },
    receiveHlc(remoteStr) {
      const ts = hlc.receive(remoteStr);
      lastHlcFormatted = hlc.format(ts);
      return lastHlcFormatted;
    },
    getLastHlc() {
      return lastHlcFormatted;
    },
    async execute(sql, params = []) {
      runMutation(sql, params);
      return { changes: 1 };
    },
  };
}

// ---------------------------------------------------------------------------
// Replication Coordinator v2 (HLC + CRDT + Row/Column Filters + Slots)
// ---------------------------------------------------------------------------

async function createSimReplicator(options) {
  const {
    primary,
    replica,
    direction,
    onConflict,
    rowFilterPredicate,
    excludeColumns,
    onConflictResolved,
  } = options;

  let primaryLsn = 0;
  let replicaLsn = 0;
  let replicaWatermark = 0;
  let primaryWatermark = 0;

  const primaryJournal = [];
  const replicaJournal = [];
  const primaryMirror = new Map();
  const replicaMirror = new Map();

  // FB_REPL_SLOTS$ table on Primary
  const slots = new Map([
    [
      'slot_replica',
      {
        slotName: 'slot_replica',
        nodeId: 'replica',
        confirmedFlushLsn: 0,
      },
    ],
  ]);

  const projectRow = (row) => {
    if (!row) return null;
    const copy = { ...row };
    for (const col of excludeColumns || []) {
      delete copy[col];
    }
    return copy;
  };

  const captureFor = (db, mirror, journal, origin, nextLsn) => {
    const rows = db.tables.get('TASKS') || [];
    const nextMap = new Map();
    for (const r of rows) {
      const clone = { ...r };
      nextMap.set(r.ID, clone);
      const prev = mirror.get(r.ID);
      if (!prev) {
        if (rowFilterPredicate && !rowFilterPredicate(clone)) {
          continue;
        }
        const hlcStr = db.nextHlc();
        journal.push({
          lsn: nextLsn(),
          txid: `${origin}-tx-${Date.now()}`,
          origin,
          hlc: hlcStr,
          publication: `pub_${origin}`,
          table: 'TASKS',
          operation: 'INSERT',
          key: { ID: r.ID },
          after: projectRow(clone),
          before: null,
          timestamp: Date.now(),
        });
      } else if (JSON.stringify(prev) !== JSON.stringify(clone)) {
        if (rowFilterPredicate && !rowFilterPredicate(clone)) {
          continue;
        }
        const hlcStr = db.nextHlc();
        journal.push({
          lsn: nextLsn(),
          txid: `${origin}-tx-${Date.now()}`,
          origin,
          hlc: hlcStr,
          publication: `pub_${origin}`,
          table: 'TASKS',
          operation: 'UPDATE',
          key: { ID: r.ID },
          after: projectRow(clone),
          before: projectRow(prev),
          timestamp: Date.now(),
        });
      }
    }
    for (const [id, prev] of mirror.entries()) {
      if (!nextMap.has(id)) {
        const hlcStr = db.nextHlc();
        journal.push({
          lsn: nextLsn(),
          txid: `${origin}-tx-${Date.now()}`,
          origin,
          hlc: hlcStr,
          publication: `pub_${origin}`,
          table: 'TASKS',
          operation: 'DELETE',
          key: { ID: id },
          after: null,
          before: projectRow(prev),
          timestamp: Date.now(),
        });
      }
    }
    mirror.clear();
    for (const [k, v] of nextMap.entries()) mirror.set(k, v);
  };

  const applyFrom = (
    sourceJournal,
    sinceLsn,
    targetDb,
    targetMirror,
    targetOrigin,
    strategy,
  ) => {
    const entries = sourceJournal.filter(
      (e) => e.lsn > sinceLsn && e.origin !== targetOrigin,
    );
    let appliedCount = 0;
    let conflictCount = 0;
    let currentLsn = sinceLsn;

    const targetRows = targetDb.tables.get('TASKS') || [];
    for (const entry of entries) {
      if (entry.lsn > currentLsn) currentLsn = entry.lsn;
      if (entry.hlc) {
        targetDb.receiveHlc(entry.hlc);
      }
      if (entry.operation === 'DDL') {
        appliedCount++;
        continue;
      }
      const idx = targetRows.findIndex((r) => r.ID === entry.key.ID);
      const localRow = idx >= 0 ? { ...targetRows[idx] } : null;
      const localProjected = projectRow(localRow);
      const isConflict =
        entry.operation === 'UPDATE' &&
        entry.before &&
        localProjected &&
        JSON.stringify(localProjected) !== JSON.stringify(entry.before);

      if (isConflict) {
        conflictCount++;
        let outcome = 'remote-wins';
        if (strategy === 'local-wins' || strategy === 'replica-wins') {
          outcome = 'local-wins';
        } else if (strategy === 'crdt-merge') {
          outcome = 'crdt-merge';
        } else if (strategy === 'merge') {
          outcome = 'merge';
        }

        if (outcome === 'local-wins') {
          onConflictResolved?.({ incoming: entry, localRow }, outcome);
          continue;
        }
        if (outcome === 'crdt-merge') {
          const merged = fallbackMergeCrdtRow(
            entry.before,
            localRow,
            entry.after,
            { STOCK: 'pn-counter', TAGS: 'set-union' },
            true,
          );
          targetRows[idx] = merged;
          targetMirror.set(merged.ID, { ...merged });
          onConflictResolved?.(
            { incoming: entry, localRow, mergedRow: merged },
            'crdt-merge (PN-Counter + Set-Union + HLC)',
          );
          appliedCount++;
          continue;
        }
        if (outcome === 'merge') {
          const merged = replLib.mergeReplicatedRow(
            entry.before,
            localRow,
            entry.after,
          );
          targetRows[idx] = merged;
          targetMirror.set(merged.ID, { ...merged });
          onConflictResolved?.(
            { incoming: entry, localRow, mergedRow: merged },
            '3-way field merge',
          );
          appliedCount++;
          continue;
        }
        onConflictResolved?.({ incoming: entry, localRow }, outcome);
      }

      if (entry.operation === 'DELETE') {
        if (idx >= 0) targetRows.splice(idx, 1);
        targetMirror.delete(entry.key.ID);
      } else if (entry.after) {
        const mergedTarget =
          idx >= 0 ? { ...targetRows[idx], ...entry.after } : { ...entry.after };
        if (idx >= 0) targetRows[idx] = mergedTarget;
        else targetRows.push(mergedTarget);
        targetMirror.set(entry.key.ID, { ...mergedTarget });
      }
      appliedCount++;
    }
    return {
      fetchedCount: entries.length,
      appliedCount,
      conflictCount,
      previousLsn: sinceLsn,
      currentLsn,
    };
  };

  return {
    primaryPublication: {
      currentLsn: async () => primaryLsn,
      fetchChangesSince: async (lsn) => primaryJournal.filter((e) => e.lsn > lsn),
      registerSlot: async (slotName, nodeId, confirmedFlushLsn = 0) => {
        slots.set(slotName, { slotName, nodeId, confirmedFlushLsn });
      },
      advanceSlot: async (slotName, confirmedFlushLsn) => {
        const existing = slots.get(slotName);
        if (existing) {
          existing.confirmedFlushLsn = Math.max(
            existing.confirmedFlushLsn,
            confirmedFlushLsn,
          );
        }
      },
      dropSlot: async (slotName) => {
        slots.delete(slotName);
      },
      listSlots: async () => [...slots.values()].map((s) => ({ ...s })),
      pruneAcked: async () => {
        const slotList = [...slots.values()];
        if (slotList.length === 0) return { pruned: 0, minSlotLsn: 0 };
        const minSlotLsn = Math.min(...slotList.map((s) => s.confirmedFlushLsn));
        const before = primaryJournal.length;
        const kept = primaryJournal.filter((e) => e.lsn > minSlotLsn);
        primaryJournal.length = 0;
        primaryJournal.push(...kept);
        return { pruned: before - kept.length, minSlotLsn };
      },
      compactJournal: async () => {
        const entriesBefore = primaryJournal.length;
        const chains = new Map();
        const ddlEntries = [];
        let epoch = 0;
        for (const e of primaryJournal) {
          if (e.operation === 'DDL') {
            epoch++;
            ddlEntries.push(e);
            continue;
          }
          const cid = `${epoch}:${e.table}:${JSON.stringify(e.key)}`;
          const prev = chains.get(cid);
          if (!prev) {
            chains.set(cid, {
              count: 1,
              netOp: e.operation,
              firstBefore: e.before,
              latestAfter: e.after,
              latestEntry: e,
            });
          } else {
            prev.count++;
            prev.latestEntry = e;
            if (prev.netOp === 'INSERT' && e.operation === 'UPDATE') {
              prev.netOp = 'INSERT';
              prev.latestAfter = { ...(prev.latestAfter || {}), ...(e.after || {}) };
            } else if (prev.netOp === 'INSERT' && e.operation === 'DELETE') {
              prev.netOp = 'ELIDED';
              prev.latestAfter = null;
            } else if (e.operation === 'UPDATE') {
              prev.netOp = 'UPDATE';
              prev.latestAfter = { ...(prev.latestAfter || {}), ...(e.after || {}) };
            } else if (e.operation === 'DELETE') {
              prev.netOp = 'DELETE';
              prev.latestAfter = null;
            } else {
              prev.netOp = e.operation;
              prev.latestAfter = e.after;
            }
          }
        }
        let keysCompacted = 0;
        const compacted = [...ddlEntries];
        for (const c of chains.values()) {
          if (c.count > 1) keysCompacted++;
          if (c.netOp === 'ELIDED') continue;
          compacted.push({
            ...c.latestEntry,
            operation: c.netOp,
            before: c.netOp === 'INSERT' ? null : c.firstBefore,
            after: c.netOp === 'DELETE' ? null : c.latestAfter,
          });
        }
        compacted.sort((a, b) => a.lsn - b.lsn);
        primaryJournal.length = 0;
        primaryJournal.push(...compacted);
        return {
          entriesBefore,
          entriesAfter: compacted.length,
          entriesRemoved: entriesBefore - compacted.length,
          keysCompacted,
        };
      },
      recordDdl: async (sql) => {
        const entry = {
          lsn: ++primaryLsn,
          txid: `primary-ddl-${primaryLsn}`,
          origin: 'primary',
          hlc: primary.nextHlc(),
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
        captureFor(
          primary,
          primaryMirror,
          primaryJournal,
          'primary',
          () => ++primaryLsn,
        );
      },
      rewindToLsn: async (targetLsn) => {
        const toUndo = primaryJournal
          .filter((e) => e.lsn > targetLsn)
          .sort((a, b) => b.lsn - a.lsn);
        const rows = primary.tables.get('TASKS') || [];
        let entriesUndone = 0;

        for (const entry of toUndo) {
          if (entry.operation === 'DDL') continue;
          const idx = rows.findIndex((r) => r.ID === entry.key.ID);
          if (entry.operation === 'INSERT') {
            if (idx >= 0) rows.splice(idx, 1);
            primaryMirror.delete(entry.key.ID);
            entriesUndone++;
          } else if (entry.operation === 'UPDATE' && entry.before) {
            if (idx >= 0) {
              rows[idx] = { ...rows[idx], ...entry.before };
              primaryMirror.set(entry.key.ID, { ...rows[idx] });
              entriesUndone++;
            }
          } else if (entry.operation === 'DELETE' && entry.before) {
            const restored = { ...entry.before };
            if (idx >= 0) rows[idx] = restored;
            else rows.push(restored);
            primaryMirror.set(entry.key.ID, { ...restored });
            entriesUndone++;
          }
        }
        rows.sort((a, b) => Number(a.ID) - Number(b.ID));

        const kept = primaryJournal.filter((e) => e.lsn <= targetLsn);
        const removed = primaryJournal.length - kept.length;
        primaryJournal.length = 0;
        primaryJournal.push(...kept);
        primaryLsn = targetLsn;

        // Also sync replica to the rewound state
        const repRows = (primary.tables.get('TASKS') || []).map((r) => ({ ...r }));
        replica.tables.set('TASKS', repRows);
        replicaMirror.clear();
        for (const r of repRows) replicaMirror.set(r.ID, { ...r });
        replicaWatermark = Math.min(replicaWatermark, targetLsn);
        const repSlot = slots.get('slot_replica');
        if (repSlot) repSlot.confirmedFlushLsn = replicaWatermark;

        return {
          previousHeadLsn: targetLsn + removed,
          rewoundToLsn: targetLsn,
          entriesUndone,
          journalEntriesRemoved: removed,
        };
      },
    },
    replicaPublication: {
      fetchChangesSince: async (lsn) => replicaJournal.filter((e) => e.lsn > lsn),
      captureTableChanges: async () => {
        captureFor(
          replica,
          replicaMirror,
          replicaJournal,
          'replica',
          () => ++replicaLsn,
        );
      },
    },
    replicaSubscription: {
      getWatermark: async () => replicaWatermark,
    },
    async sync() {
      captureFor(
        primary,
        primaryMirror,
        primaryJournal,
        'primary',
        () => ++primaryLsn,
      );
      if (direction === 'bidirectional') {
        captureFor(
          replica,
          replicaMirror,
          replicaJournal,
          'replica',
          () => ++replicaLsn,
        );
      }
      const p2r = applyFrom(
        primaryJournal,
        replicaWatermark,
        replica,
        replicaMirror,
        'replica',
        onConflict,
      );
      replicaWatermark = p2r.currentLsn;
      const repSlot = slots.get('slot_replica');
      if (repSlot) {
        repSlot.confirmedFlushLsn = replicaWatermark;
      }

      let r2p;
      if (direction === 'bidirectional') {
        const revStrategy =
          onConflict === 'primary-wins'
            ? 'local-wins'
            : onConflict === 'replica-wins'
              ? 'remote-wins'
              : onConflict;
        r2p = applyFrom(
          replicaJournal,
          primaryWatermark,
          primary,
          primaryMirror,
          'primary',
          revStrategy,
        );
        primaryWatermark = r2p.currentLsn;
        if (r2p.conflictCount > 0) {
          captureFor(
            primary,
            primaryMirror,
            primaryJournal,
            'primary',
            () => ++primaryLsn,
          );
          const p2rFix = applyFrom(
            primaryJournal,
            replicaWatermark,
            replica,
            replicaMirror,
            'replica',
            'remote-wins',
          );
          replicaWatermark = p2rFix.currentLsn;
          if (repSlot) repSlot.confirmedFlushLsn = replicaWatermark;
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
let promoted = false;

const INITIAL_TASKS = [
  {
    ID: 1,
    TENANT_ID: 'acme',
    TITLE: 'Compile Firebird 5 to WASM',
    PRIORITY: 'HIGH',
    STOCK: 10,
    TAGS: 'core,wasm',
    DONE: 1,
    SECRET_HASH: 'sha256:9f86d08',
  },
  {
    ID: 2,
    TENANT_ID: 'acme',
    TITLE: 'Add OPFS SyncAccessHandle VFS',
    PRIORITY: 'MEDIUM',
    STOCK: 5,
    TAGS: 'opfs,storage',
    DONE: 1,
    SECRET_HASH: 'sha256:4b22777',
  },
  {
    ID: 3,
    TENANT_ID: 'globex',
    TITLE: 'Build Logical Journal Replication',
    PRIORITY: 'HIGH',
    STOCK: 20,
    TAGS: 'crdt,hlc,repl',
    DONE: 0,
    SECRET_HASH: 'sha256:e3b0c44',
  },
];

const directionSelect = document.getElementById('direction-select');
const conflictSelect = document.getElementById('conflict-select');
const tenantFilterSelect = document.getElementById('tenant-filter-select');
const colFilterSelect = document.getElementById('col-filter-select');

const toggleNetworkBtn = document.getElementById('toggle-network');
const syncNowBtn = document.getElementById('sync-now');
const pruneJournalBtn = document.getElementById('prune-journal');
const resetSimBtn = document.getElementById('reset-sim');

const primaryRowsEl = document.getElementById('primary-rows');
const replicaRowsEl = document.getElementById('replica-rows');
const journalRowsEl = document.getElementById('journal-rows');
const slotsListEl = document.getElementById('slots-list');
const eventFeedEl = document.getElementById('event-feed');
const codeInspectorEl = document.getElementById('code-inspector');

const primaryLsnBadge = document.getElementById('primary-lsn-badge');
const primaryHlcBadge = document.getElementById('primary-hlc-badge');
const enginePubBadge = document.getElementById('engine-pub-badge');
const replicaWatermarkBadge = document.getElementById('replica-watermark-badge');
const replicaHlcBadge = document.getElementById('replica-hlc-badge');
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

function getActiveRowFilterPredicate() {
  const mode = tenantFilterSelect.value;
  if (mode === 'acme') {
    return (row) => row.TENANT_ID === 'acme';
  }
  if (mode === 'high') {
    return (row) => row.PRIORITY === 'HIGH' || row.PRIORITY === 'CRITICAL';
  }
  return null;
}

function getActiveExcludeColumns() {
  return colFilterSelect.value === 'exclude-secret' ? ['SECRET_HASH'] : [];
}

function getSetupCodeSnippet() {
  const direction = directionSelect.value;
  const conflict = conflictSelect.value;
  const tenantMode = tenantFilterSelect.value;
  const excludeSecret = colFilterSelect.value === 'exclude-secret';

  const whereSnippet =
    tenantMode === 'acme'
      ? `\n      where: "TENANT_ID = 'acme'",`
      : tenantMode === 'high'
        ? `\n      where: "PRIORITY IN ('HIGH', 'CRITICAL')",`
        : '';
  const excludeSnippet = excludeSecret
    ? `\n      excludeColumns: ['SECRET_HASH'],`
    : '';

  return [
    `import {`,
    `  openDatabase,`,
    `  syncDatabases,`,
    `  replicateDatabases,`,
    `  createCrdtConflictResolver,`,
    `} from 'firebird-wasm/browser';`,
    ``,
    `await using primary = await openDatabase('opfs://primary');`,
    `await using replica = await openDatabase('opfs://replica');`,
    ``,
    `// Zero-boilerplate 1-liner (auto-discovers tables, syncs DDL + sequences & bootstraps via IBatch):`,
    `// await using sync = await syncDatabases(primary, replica); // or: await primary.syncWith(replica)`,
    ``,
    `// Or full explicit configuration via replicateDatabases():`,
    `const replicator = await replicateDatabases({`,
    `  primary,`,
    `  replica,`,
    `  slotName: 'slot_replica', // Persists acked LSN in FB_REPL_SLOTS$`,
    `  autoPrune: false,         // Or true to auto-prune below min(confirmedFlushLsn)`,
    `  tables: [`,
    `    {`,
    `      table: 'TASKS',`,
    `      primaryKey: 'ID',${whereSnippet}${excludeSnippet}`,
    `    },`,
    `  ],`,
    `  direction: '${direction}',`,
    conflict === 'crdt-merge'
      ? `  onConflict: createCrdtConflictResolver({\n    TASKS: { STOCK: 'pn-counter', TAGS: 'set-union' },\n  }),`
      : `  onConflict: '${conflict}',`,
    `  installTriggers: true, // Installs FB_REPL_TRG$TASKS PSQL trigger`,
    `});`,
    ``,
    `await replicator.sync();`,
    `const telemetry = await replicator.stats(); // LSN lag, byte lag & conflict counts`,
  ].join('\n');
}

function formatBinaryHexDump(entries) {
  const bytes = replLib.encodeNativeJournalSegment(entries);
  let magic = 0;
  let version = 0;
  let count = 0;
  let minLsn = 0;
  let maxLsn = 0;
  try {
    const decoded = replLib.decodeNativeJournalSegment
      ? replLib.decodeNativeJournalSegment(bytes)
      : null;
    if (decoded) {
      magic = decoded.header.magic;
      version = decoded.header.version;
      count = decoded.header.entryCount;
      minLsn = decoded.header.startLsn;
      maxLsn = decoded.header.endLsn;
    }
  } catch {
    // fall through with zeroed header on the built-in fallback encoder
  }

  const lines = [
    `// Firebird 4.0 / 5.0 Native Binary Replication Segment (encodeNativeJournalSegment)`,
    `// Header (24 bytes):`,
    `//   Magic:       0x${magic.toString(16).toUpperCase()} ('FBDR')`,
    `//   Version:     ${version}`,
    `//   Entry Count: ${count}`,
    `//   LSN Range:   ${minLsn} .. ${maxLsn}`,
    `//   Total Size:  ${bytes.byteLength} bytes`,
    ``,
  ];

  const maxBytesToShow = Math.min(bytes.byteLength, 384);
  for (let offset = 0; offset < maxBytesToShow; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, maxBytesToShow));
    const hexPart = Array.from(slice, (b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const asciiPart = Array.from(slice, (b) =>
      b >= 32 && b <= 126 ? String.fromCharCode(b) : '.',
    ).join('');
    lines.push(
      `${offset.toString(16).padStart(4, '0')}:  ${hexPart}  |${asciiPart}|`,
    );
  }
  if (bytes.byteLength > maxBytesToShow) {
    lines.push(`... (${bytes.byteLength - maxBytesToShow} more bytes)`);
  }
  return lines.join('\n');
}

async function formatEncryptedHexDump(entries) {
  const rawBytes = replLib.encodeNativeJournalSegment(entries);
  let compressedBytes = rawBytes;
  let isCompressed = false;
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    // Read concurrently: awaiting write() first deadlocks on backpressure.
    const gzipped = new Response(cs.readable).arrayBuffer();
    const writer = cs.writable.getWriter();
    void writer.write(new Uint8Array(rawBytes)).catch(() => {});
    await writer.close();
    compressedBytes = new Uint8Array(await gzipped);
    isCompressed = true;
  }

  let payloadBytes = compressedBytes;
  let isEncrypted = false;
  const iv = new Uint8Array(12);
  const salt = new Uint8Array(16);
  for (let i = 0; i < 12; i++) iv[i] = (i * 17 + 0x42) & 0xff;
  for (let i = 0; i < 16; i++) salt[i] = (i * 29 + 0x11) & 0xff;

  if (globalThis.crypto?.subtle) {
    const keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) keyBytes[i] = (i * 7 + 3) & 0xff;
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const encBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new Uint8Array(compressedBytes),
    );
    payloadBytes = new Uint8Array(encBuf);
    isEncrypted = true;
  }

  const envelope = new Uint8Array(40 + payloadBytes.byteLength);
  const dv = new DataView(envelope.buffer);
  dv.setUint32(0, 0x53444246, true); // 'FBDS'
  dv.setUint16(4, 1, true);
  dv.setUint16(6, (isCompressed ? 1 : 0) | (isEncrypted ? 2 : 0), true);
  envelope.set(iv, 8);
  envelope.set(salt, 20);
  dv.setUint32(36, rawBytes.byteLength, true);
  envelope.set(payloadBytes, 40);

  const lines = [
    `// Encrypted & Gzip-Compressed Replication Segment (encodeEncryptedJournalSegment)`,
    `// Envelope Header (40 bytes):`,
    `//   Magic:             0x53444246 ('FBDS')`,
    `//   Version:           1`,
    `//   Flags:             0x0${((isCompressed ? 1 : 0) | (isEncrypted ? 2 : 0)).toString(16)} (Gzip=${isCompressed}, AES-256-GCM=${isEncrypted})`,
    `//   Uncompressed Size: ${rawBytes.byteLength} bytes`,
    `//   Encrypted Wire:    ${envelope.byteLength} bytes`,
    ``,
  ];

  const maxBytesToShow = Math.min(envelope.byteLength, 384);
  for (let offset = 0; offset < maxBytesToShow; offset += 16) {
    const slice = envelope.subarray(offset, Math.min(offset + 16, maxBytesToShow));
    const hexPart = Array.from(slice, (b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const asciiPart = Array.from(slice, (b) =>
      b >= 32 && b <= 126 ? String.fromCharCode(b) : '.',
    ).join('');
    lines.push(
      `${offset.toString(16).padStart(4, '0')}:  ${hexPart}  |${asciiPart}|`,
    );
  }
  return lines.join('\n');
}

let simDlqEntries = [];
let simChangelogSeq = 1;
let simEnginePubState = {
  name: 'RDB$DEFAULT',
  active: true,
  autoEnable: true,
  publishedTables: ['TASKS'],
  replicaMode: 'READ-WRITE',
  sequenceValue: 3,
};
let simMeshMatrix = {
  hub: { edge_eu: 3, edge_us: 3 },
  edge_eu: { hub: 5 },
  edge_us: { hub: 5 },
};

function buildFbChangelogSegmentBytes(entries = [], sequence = 1, seqGenValue = 3) {
  const enc = new TextEncoder();
  const pushU32 = (arr, v) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    arr.push(...b);
  };
  const pushI64 = (arr, v) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
    arr.push(...b);
  };
  const pushAtom = (arr, name) => {
    const nb = enc.encode(name);
    arr.push(16, nb.length, ...nb); // opDefineAtom = 16
  };
  const encodeTaskRecord = (row) => {
    const r = row || {};
    const titleBytes = enc.encode(String(r.TITLE || '').slice(0, 32));
    const buf = new Uint8Array(4 + 4 + 2 + 32 + 4);
    buf[0] = 0xf8; // 3 NOT NULL columns (ID, TITLE, STOCK)
    const dv = new DataView(buf.buffer);
    dv.setInt32(4, Number(r.ID || 0), true);
    dv.setUint16(8, titleBytes.length, true);
    buf.set(titleBytes, 10);
    dv.setInt32(42, Number(r.STOCK || 0), true);
    return buf;
  };

  const blocks = [];

  // Block 0 (traNumber = 0): opSetSequence ("PUBLIC"."SEQ_TASKS_ID")
  const seqPayload = [];
  pushAtom(seqPayload, 'PUBLIC');
  pushAtom(seqPayload, 'SEQ_TASKS_ID');
  seqPayload.push(14); // opSetSequence = 14
  pushU32(seqPayload, 0);
  pushU32(seqPayload, 1);
  pushI64(seqPayload, seqGenValue);
  blocks.push({ traNumber: 0, protocol: 2, flags: 0, payload: new Uint8Array(seqPayload), summary: `opDefineAtom("PUBLIC","SEQ_TASKS_ID") -> opSetSequence(val=${seqGenValue})` });

  const sample = entries.slice(0, 4);
  let tra = 100 + sequence * 10;
  for (const e of sample) {
    tra++;
    const p = [1, 6]; // opStartTransaction=1, opStartSavepoint=6
    let desc = '';
    if (e.operation === 'DDL' && e.ddlSql) {
      pushAtom(p, 'SYSDBA');
      pushAtom(p, '"PUBLIC", "SYSTEM"');
      p.push(15); // opExecuteSqlIntl = 15
      pushU32(p, 0);
      pushU32(p, 1);
      p.push(4); // CS_UTF8
      const sb = enc.encode(e.ddlSql);
      pushU32(p, sb.length);
      p.push(...sb);
      desc = `opExecuteSqlIntl("${e.ddlSql}")`;
    } else {
      pushAtom(p, 'PUBLIC');
      pushAtom(p, e.table || 'TASKS');
      if (e.operation === 'INSERT') {
        const rec = encodeTaskRecord(e.after);
        p.push(9); // opInsertRecord = 9
        pushU32(p, 0);
        pushU32(p, 1);
        pushU32(p, rec.length);
        p.push(...rec);
        desc = `opInsertRecord(PUBLIC.${e.table || 'TASKS'}, len=${rec.length})`;
      } else if (e.operation === 'UPDATE') {
        const oldRec = encodeTaskRecord(e.before || e.after);
        const newRec = encodeTaskRecord(e.after);
        p.push(10); // opUpdateRecord = 10
        pushU32(p, 0);
        pushU32(p, 1);
        pushU32(p, oldRec.length);
        p.push(...oldRec);
        pushU32(p, newRec.length);
        p.push(...newRec);
        desc = `opUpdateRecord(PUBLIC.${e.table || 'TASKS'}, old=${oldRec.length}B, new=${newRec.length}B)`;
      } else {
        const oldRec = encodeTaskRecord(e.before || e.key);
        p.push(11); // opDeleteRecord = 11
        pushU32(p, 0);
        pushU32(p, 1);
        pushU32(p, oldRec.length);
        p.push(...oldRec);
        desc = `opDeleteRecord(PUBLIC.${e.table || 'TASKS'}, len=${oldRec.length}B)`;
      }
    }
    p.push(7, 3); // opReleaseSavepoint=7, opCommitTransaction=3
    blocks.push({
      traNumber: tra,
      protocol: 2,
      flags: 3, // BLOCK_BEGIN_TRANS | BLOCK_END_TRANS
      payload: new Uint8Array(p),
      summary: `opStartTransaction -> opStartSavepoint -> ${desc} -> opReleaseSavepoint -> opCommitTransaction`,
    });
  }

  let totalLen = 48;
  for (const b of blocks) totalLen += 16 + b.payload.byteLength;

  const seg = new Uint8Array(totalLen);
  const magic = 'FBCHANGELOG\0';
  for (let i = 0; i < magic.length; i++) seg[i] = magic.charCodeAt(i);
  const dv = new DataView(seg.buffer);
  dv.setUint16(12, 1, true); // version = 1
  dv.setUint16(14, 3, true); // state = 3 (ARCHIVABLE)
  const guidHex = 'A1B2C3D4E5F647118899AABBCCDDEEFF';
  for (let i = 0; i < 16; i++) {
    seg[16 + i] = parseInt(guidHex.slice(i * 2, i * 2 + 2), 16);
  }
  dv.setBigUint64(32, BigInt(sequence), true);
  dv.setBigUint64(40, BigInt(totalLen), true);

  let off = 48;
  for (const b of blocks) {
    b.offset = off;
    dv.setBigUint64(off, BigInt(b.traNumber), true);
    dv.setUint16(off + 8, b.protocol, true);
    dv.setUint16(off + 10, b.flags, true);
    dv.setUint32(off + 12, b.payload.byteLength, true);
    seg.set(b.payload, off + 16);
    off += 16 + b.payload.byteLength;
  }

  return { seg, blocks, totalLen, guid: 'A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF' };
}

function formatFbChangelogInspector(allEntries = []) {
  const { seg, blocks, totalLen, guid } = buildFbChangelogSegmentBytes(
    allEntries,
    simChangelogSeq,
    simEnginePubState.sequenceValue,
  );
  const lines = [
    `// Native Firebird Engine Binary Changelog Segment ("FBCHANGELOG\\0")`,
    `// RDB$PUBLICATIONS: ${simEnginePubState.name} (active=${simEnginePubState.active}, autoEnable=${simEnginePubState.autoEnable}, tables=[${simEnginePubState.publishedTables.join(', ')}], replicaMode=${simEnginePubState.replicaMode})`,
    `// ChangeLog::Header (48 bytes):`,
    `//   magic:    "FBCHANGELOG\\0" (12B)`,
    `//   version:  1`,
    `//   state:    3 (CHANGELOG_STATE_ARCHIVABLE)`,
    `//   guid:     ${guid}`,
    `//   sequence: ${simChangelogSeq} (.journal-${String(simChangelogSeq).padStart(9, '0')})`,
    `//   length:   ${totalLen} bytes (${blocks.length} Replication::Block records)`,
    ``,
    `// Decoded Replication::Block Stream (16-byte header + Protocol=2 opcodes):`,
  ];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    lines.push(
      `//   Block[${i}] @+${b.offset}: tra=${b.traNumber}, proto=${b.protocol}, flags=0x0${b.flags} (${b.flags === 3 ? 'BEGIN|END' : 'META'}), len=${b.payload.byteLength}B`,
    );
    lines.push(`//     ops: ${b.summary}`);
  }
  lines.push(``);

  const maxBytesToShow = Math.min(seg.byteLength, 384);
  for (let offset = 0; offset < maxBytesToShow; offset += 16) {
    const slice = seg.subarray(offset, Math.min(offset + 16, maxBytesToShow));
    const hexPart = Array.from(slice, (b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const asciiPart = Array.from(slice, (b) =>
      b >= 32 && b <= 126 ? String.fromCharCode(b) : '.',
    ).join('');
    lines.push(
      `${offset.toString(16).padStart(4, '0')}:  ${hexPart}  |${asciiPart}|`,
    );
  }
  if (seg.byteLength > maxBytesToShow) {
    lines.push(`... (${seg.byteLength - maxBytesToShow} more bytes)`);
  }
  return lines.join('\n');
}

function formatMeshAndDlqInspector(allEntries = []) {
  const pLsn = allEntries.length > 0 ? Math.max(...allEntries.map((e) => e.lsn)) : 0;
  const lines = [
    `// Multi-Node Hub/Mesh Watermark Matrix & Dead-Letter Queue (FB_REPL_DLQ$)`,
    `// 1. Watermark Matrix (watermarks[subscriberNodeId][publisherNodeId] = lastAppliedLsn):`,
    JSON.stringify(simMeshMatrix, null, 2),
    ``,
    `// 2. Dead-Letter Queue (FB_REPL_DLQ$) — ${simDlqEntries.length} quarantined entry/entries:`,
    simDlqEntries.length === 0
      ? `//   [0 quarantined entries in FB_REPL_DLQ$]`
      : JSON.stringify(simDlqEntries, null, 2),
    ``,
    `// 3. Prometheus Replication Telemetry (formatPrometheusReplicationMetrics):`,
    `# TYPE firebird_replication_primary_lsn gauge`,
    `firebird_replication_primary_lsn{publication="pub_primary",subscription="sub_replica",node_id="replica"} ${pLsn}`,
    `# TYPE firebird_replication_journal_depth gauge`,
    `firebird_replication_journal_depth{publication="pub_primary",subscription="sub_replica",node_id="replica"} ${allEntries.length}`,
    `# TYPE firebird_replication_dlq_depth gauge`,
    `firebird_replication_dlq_depth{publication="pub_primary",subscription="sub_replica",node_id="replica"} ${simDlqEntries.length}`,
    `# TYPE firebird_replication_conflicts_total counter`,
    `firebird_replication_conflicts_total{publication="pub_primary",subscription="sub_replica",node_id="replica"} ${totalConflictsResolved}`,
  ];
  return lines.join('\n');
}

async function updateCodeInspector(allEntries = []) {
  if (activeCodeTab === 'setup') {
    codeInspectorEl.textContent = getSetupCodeSnippet();
  } else if (activeCodeTab === 'trigger') {
    const built = replLib.buildReplicationTriggerDdl({
      table: 'TASKS',
      primaryKey: ['ID'],
      columns: ['ID', 'TENANT_ID', 'TITLE', 'PRIORITY', 'STOCK', 'TAGS', 'DONE'],
      publication: 'pub_primary',
      nodeId: 'primary',
    });
    codeInspectorEl.textContent = built.ddl;
  } else if (activeCodeTab === 'hex') {
    codeInspectorEl.textContent = formatBinaryHexDump(allEntries.slice(0, 8));
  } else if (activeCodeTab === 'fbchangelog') {
    codeInspectorEl.textContent = formatFbChangelogInspector(allEntries.slice(0, 8));
  } else if (activeCodeTab === 'encrypted') {
    codeInspectorEl.textContent = await formatEncryptedHexDump(
      allEntries.slice(0, 8),
    );
  } else if (activeCodeTab === 'mesh-dlq') {
    codeInspectorEl.textContent = formatMeshAndDlqInspector(allEntries);
  }
}

async function initSimulator() {
  if (replicator) {
    await replicator.stop();
  }
  primaryDb = createSimNode('primary');
  replicaDb = createSimNode('replica');
  totalConflictsResolved = 0;
  promoted = false;
  nextTaskId = 4;

  primaryDb.tables.set(
    'TASKS',
    INITIAL_TASKS.map((r) => ({ ...r })),
  );
  replicaDb.tables.set('TASKS', []);

  const direction = directionSelect.value;
  const onConflict = conflictSelect.value;
  const rowFilterPredicate = getActiveRowFilterPredicate();
  const excludeColumns = getActiveExcludeColumns();

  replicator = await createSimReplicator({
    primary: primaryDb,
    replica: replicaDb,
    direction,
    onConflict,
    rowFilterPredicate,
    excludeColumns,
    onConflictResolved: (ctx, resolution) => {
      totalConflictsResolved++;
      logEvent(
        `⚡ <strong>Conflict Resolved</strong> on <code>${ctx.incoming.table}</code> (ID=${ctx.incoming.key.ID}) via <strong>${resolution}</strong>`,
        true,
      );
    },
  });

  await replicator.sync();
  logEvent(
    `Initialized <strong>${direction}</strong> replication (policy: <code>${onConflict}</code>, filter: <code>${tenantFilterSelect.value}</code>, projection: <code>${colFilterSelect.value}</code>).`,
  );
  await renderAll();
}

async function maybeAutoSync() {
  if (isOnline) {
    const res = await replicator.sync();
    const applied =
      (res.primaryToReplica?.appliedCount || 0) +
      (res.replicaToPrimary?.appliedCount || 0);
    if (applied > 0) {
      logEvent(
        `Replicated <strong>${applied}</strong> change(s) (${res.primaryToReplica.appliedCount} P→R, ${res.replicaToPrimary?.appliedCount ?? 0} R→P).`,
      );
    }
  } else {
    await replicator.primaryPublication.captureTableChanges();
    if (replicator.replicaPublication) {
      await replicator.replicaPublication.captureTableChanges();
    }
    logEvent(
      `Network link is <strong>OFFLINE</strong> — change queued in local journal with HLC timestamp.`,
    );
  }
  await renderAll();
}

function renderTaskTable(tbody, rows) {
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="8" style="color: var(--muted); text-align: center;">No rows</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    const secretCell =
      r.SECRET_HASH !== undefined && r.SECRET_HASH !== null
        ? `<code>${escapeHtml(String(r.SECRET_HASH))}</code>`
        : `<span style="color: var(--muted);">— excluded —</span>`;
    tr.innerHTML = `
      <td>${r.ID}</td>
      <td><span class="badge">${escapeHtml(String(r.TENANT_ID ?? 'acme'))}</span></td>
      <td>${escapeHtml(String(r.TITLE ?? ''))}</td>
      <td><span class="badge">${escapeHtml(String(r.PRIORITY ?? ''))}</span></td>
      <td><strong>${Number(r.STOCK ?? 0)}</strong></td>
      <td><code>${escapeHtml(String(r.TAGS ?? ''))}</code></td>
      <td>${Number(r.DONE) ? '✓ Done' : '○ Open'}</td>
      <td>${secretCell}</td>
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
  primaryHlcBadge.textContent = `HLC: ${primaryDb.getLastHlc()}`;
  if (enginePubBadge) {
    enginePubBadge.textContent = `RDB$PUBLICATIONS: ${simEnginePubState.name} (${simEnginePubState.active ? 'ACTIVE' : 'INACTIVE'} · seq ${simChangelogSeq})`;
  }
  replicaWatermarkBadge.textContent = `Watermark LSN: ${watermarkLsn}`;
  replicaHlcBadge.textContent = `HLC: ${replicaDb.getLastHlc()}`;

  // Render Replication Slots (FB_REPL_SLOTS$)
  const slots = await replicator.primaryPublication.listSlots();
  slotsListEl.innerHTML = `<strong style="color: var(--fg);">FB_REPL_SLOTS$:</strong>`;
  for (const s of slots) {
    const lag = Math.max(0, primaryLsn - s.confirmedFlushLsn);
    const badge = document.createElement('span');
    badge.className = `badge ${lag === 0 ? 'ok' : 'accent'}`;
    badge.textContent = `${s.slotName} (${s.nodeId}) · ack LSN ${s.confirmedFlushLsn} · lag ${lag}`;
    slotsListEl.appendChild(badge);
  }

  const primaryEntries =
    await replicator.primaryPublication.fetchChangesSince(0);
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
        <td><span class="badge">${escapeHtml(e.origin)}</span> <code style="font-size:0.68rem;">${escapeHtml(String(e.hlc || ''))}</code></td>
        <td><span class="op-pill op-${e.operation}">${e.operation}</span></td>
        <td>${escapeHtml(e.table)}</td>
        <td><code>${escapeHtml(JSON.stringify(e.key))}</code></td>
        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${summary}">${summary}</td>
      `;
      journalRowsEl.appendChild(tr);
    }
  }

  const pendingP2R = Math.max(0, primaryLsn - watermarkLsn);
  const direction = directionSelect.value;
  topologyBadge.textContent = promoted
    ? 'PROMOTED: REPLICA → PRIMARY'
    : direction === 'bidirectional'
      ? 'PRIMARY ↔ REPLICA'
      : 'PRIMARY → REPLICA';
  linkArrow.textContent = isOnline
    ? direction === 'bidirectional'
      ? '⇄'
      : '→'
    : '✕';
  linkArrow.className = `link-arrow${isOnline ? '' : ' offline'}`;
  linkStats.innerHTML = `Pending P→R: ${pendingP2R}<br/>Active Slots: ${slots.length}<br/>Conflicts resolved: ${totalConflictsResolved}`;

  await updateCodeInspector(allEntries);
}

// ---------------------------------------------------------------------------
// Button & Scenario Handlers
// ---------------------------------------------------------------------------

directionSelect.addEventListener('change', () => initSimulator());
conflictSelect.addEventListener('change', () => initSimulator());
tenantFilterSelect.addEventListener('change', () => initSimulator());
colFilterSelect.addEventListener('change', () => initSimulator());

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
    (res.primaryToReplica?.appliedCount || 0) +
    (res.replicaToPrimary?.appliedCount || 0);
  logEvent(
    `Manual <code>replicator.sync()</code> complete — applied <strong>${applied}</strong> entry/entries.`,
  );
  await renderAll();
});

pruneJournalBtn.addEventListener('click', async () => {
  const { pruned, minSlotLsn } =
    await replicator.primaryPublication.pruneAcked();
  logEvent(
    `<code>pruneAcked()</code> pruned <strong>${pruned}</strong> entry/entries with <code>LSN &lt;= ${minSlotLsn}</code> (minimum <code>CONFIRMED_FLUSH_LSN</code> across all active slots in <code>FB_REPL_SLOTS$</code>).`,
  );
  await renderAll();
});

document.getElementById('compact-journal').addEventListener('click', async () => {
  const res = await replicator.primaryPublication.compactJournal();
  logEvent(
    `🗜️ <code>compactJournal()</code> coalesced <strong>${res.keysCompacted}</strong> row key chain(s) and removed <strong>${res.entriesRemoved}</strong> superseded journal mutation(s) (${res.entriesBefore} → ${res.entriesAfter} entries).`,
    true,
  );
  await renderAll();
});

resetSimBtn.addEventListener('click', () => {
  isOnline = true;
  toggleNetworkBtn.textContent = '● Link Online (Auto-Sync)';
  toggleNetworkBtn.className = 'btn-sm online';
  void initSimulator();
});

// Slot management buttons
document
  .getElementById('add-lagging-slot')
  .addEventListener('click', async () => {
    await replicator.primaryPublication.registerSlot(
      'analytics_dr',
      'dr-node-2',
      1,
    );
    logEvent(
      `Registered slot <code>analytics_dr</code> (<code>nodeId: 'dr-node-2'</code>) at <code>CONFIRMED_FLUSH_LSN = 1</code> in <code>FB_REPL_SLOTS$</code>.`,
    );
    await renderAll();
  });

document
  .getElementById('advance-lagging-slot')
  .addEventListener('click', async () => {
    const headLsn = await replicator.primaryPublication.currentLsn();
    await replicator.primaryPublication.advanceSlot('analytics_dr', headLsn);
    logEvent(
      `Advanced slot <code>analytics_dr</code> to <code>CONFIRMED_FLUSH_LSN = ${headLsn}</code>.`,
    );
    await renderAll();
  });

document
  .getElementById('drop-lagging-slot')
  .addEventListener('click', async () => {
    await replicator.primaryPublication.dropSlot('analytics_dr');
    logEvent(`Dropped slot <code>analytics_dr</code> from <code>FB_REPL_SLOTS$</code>.`);
    await renderAll();
  });

document
  .getElementById('rewind-one-lsn')
  .addEventListener('click', async () => {
    const curLsn = await replicator.primaryPublication.currentLsn();
    if (curLsn <= 1) {
      logEvent(`Cannot rewind further: already at baseline <code>LSN ${curLsn}</code>.`);
      return;
    }
    const targetLsn = curLsn - 1;
    const res = await replicator.primaryPublication.rewindToLsn(targetLsn);
    logEvent(
      `⏪ <strong>Time-Travel Rewind (<code>rewindToLsn(${targetLsn})</code>)</strong>: inverted <strong>${res.entriesUndone}</strong> DML operation(s) using <code>BEFORE_JSON</code> and truncated journal from LSN ${res.previousHeadLsn} → LSN ${res.rewoundToLsn}.`,
      true,
    );
    await renderAll();
  });

// Primary node mutations
document
  .getElementById('primary-insert')
  .addEventListener('click', async () => {
    const id = nextTaskId++;
    const tenants = ['acme', 'globex'];
    const tenant = tenants[id % tenants.length];
    await primaryDb.execute(
      'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        tenant,
        `Task #${id} (${tenant})`,
        'MEDIUM',
        10,
        'new,primary',
        0,
        `sha256:sec${id}`,
      ],
    );
    await maybeAutoSync();
  });

document
  .getElementById('primary-update-title')
  .addEventListener('click', async () => {
    const suffix = Math.floor(Math.random() * 90 + 10);
    await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
      `Primary Edit #${suffix}`,
      1,
    ]);
    await maybeAutoSync();
  });

document
  .getElementById('primary-crdt-bump')
  .addEventListener('click', async () => {
    const rows = primaryDb.tables.get('TASKS') || [];
    const r1 = rows.find((r) => r.ID === 1);
    if (!r1) return;
    const nextStock = Number(r1.STOCK ?? 0) + 5;
    const tagSet = new Set(
      String(r1.TAGS ?? '')
        .split(',')
        .filter(Boolean),
    );
    tagSet.add('primary-tag');
    await primaryDb.execute(
      'UPDATE TASKS SET STOCK = ?, TAGS = ? WHERE ID = ?',
      [nextStock, [...tagSet].join(','), 1],
    );
    await maybeAutoSync();
  });

document
  .getElementById('primary-escalate')
  .addEventListener('click', async () => {
    await primaryDb.execute('UPDATE TASKS SET PRIORITY = ? WHERE ID = ?', [
      'CRITICAL',
      1,
    ]);
    await maybeAutoSync();
  });

document
  .getElementById('primary-delete-last')
  .addEventListener('click', async () => {
    const rows = primaryDb.tables.get('TASKS') || [];
    if (rows.length === 0) return;
    const lastId = rows[rows.length - 1].ID;
    await primaryDb.execute('DELETE FROM TASKS WHERE ID = ?', [lastId]);
    await maybeAutoSync();
  });

// Replica node mutations
document
  .getElementById('replica-insert')
  .addEventListener('click', async () => {
    const id = nextTaskId++;
    await replicaDb.execute(
      'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        'acme',
        `Task #${id} (Replica)`,
        'LOW',
        5,
        'replica,edge',
        0,
        `sha256:rep${id}`,
      ],
    );
    await maybeAutoSync();
  });

document
  .getElementById('replica-toggle-done')
  .addEventListener('click', async () => {
    const rows = replicaDb.tables.get('TASKS') || [];
    const row1 = rows.find((r) => r.ID === 1);
    if (!row1) return;
    const nextDone = Number(row1.DONE) ? 0 : 1;
    await replicaDb.execute('UPDATE TASKS SET DONE = ? WHERE ID = ?', [
      nextDone,
      1,
    ]);
    await maybeAutoSync();
  });

document
  .getElementById('replica-crdt-bump')
  .addEventListener('click', async () => {
    const rows = replicaDb.tables.get('TASKS') || [];
    const r1 = rows.find((r) => r.ID === 1);
    if (!r1) return;
    const nextStock = Number(r1.STOCK ?? 0) + 3;
    const tagSet = new Set(
      String(r1.TAGS ?? '')
        .split(',')
        .filter(Boolean),
    );
    tagSet.add('edge-tag');
    await replicaDb.execute(
      'UPDATE TASKS SET STOCK = ?, TAGS = ? WHERE ID = ?',
      [nextStock, [...tagSet].join(','), 1],
    );
    await maybeAutoSync();
  });

document
  .getElementById('replica-update-title')
  .addEventListener('click', async () => {
    const suffix = Math.floor(Math.random() * 90 + 10);
    await replicaDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
      `Replica Edit #${suffix}`,
      1,
    ]);
    await maybeAutoSync();
  });

// Inspector tabs
document.getElementById('show-setup-code').addEventListener('click', () => {
  activeCodeTab = 'setup';
  void renderAll();
});

document.getElementById('show-trigger-ddl').addEventListener('click', () => {
  activeCodeTab = 'trigger';
  void renderAll();
});

document.getElementById('show-binary-hex').addEventListener('click', () => {
  activeCodeTab = 'hex';
  void renderAll();
});

document.getElementById('show-fbchangelog').addEventListener('click', () => {
  activeCodeTab = 'fbchangelog';
  void renderAll();
});

document.getElementById('show-encrypted-hex').addEventListener('click', () => {
  activeCodeTab = 'encrypted';
  void renderAll();
});

document.getElementById('show-mesh-dlq').addEventListener('click', () => {
  activeCodeTab = 'mesh-dlq';
  void renderAll();
});

async function runPromoteReplicaDemo() {
  await replicator.sync();
  nextTaskId += 100; // sequenceBuffer: 100
  promoted = true;
  topologyBadge.textContent = 'PROMOTED: REPLICA → PRIMARY';
  logEvent(
    `⚡ <strong>Automatic Failover (<code>promoteReplica()</code>)</strong>: drained pending lag (<code>lagEntries: 0</code>), bumped sequence watermarks (<code>+100</code> → next ID ${nextTaskId}), set <code>FB_REPL_ROLE = 'PRIMARY'</code>, and promoted <strong>Node B (replica)</strong> to active primary!`,
    true,
  );
  await renderAll();
}

document
  .getElementById('replica-promote')
  .addEventListener('click', () => void runPromoteReplicaDemo());

// 1-Click Guided Scenarios
for (const btn of document.querySelectorAll('.scenario-card')) {
  btn.addEventListener('click', async () => {
    const kind = btn.getAttribute('data-scenario');

    if (kind === 'stream') {
      const id = nextTaskId++;
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          'acme',
          `Streamed Task #${id}`,
          'HIGH',
          15,
          'stream,live',
          0,
          `sha256:s${id}`,
        ],
      );
      await primaryDb.execute('UPDATE TASKS SET DONE = ? WHERE ID = ?', [1, 3]);
      const res = await replicator.sync();
      logEvent(
        `Scenario 1: Streamed <strong>${res.primaryToReplica.appliedCount}</strong> DML mutations from Primary → Replica.`,
      );
      await renderAll();
    } else if (kind === 'crdt') {
      if (
        directionSelect.value !== 'bidirectional' ||
        conflictSelect.value !== 'crdt-merge'
      ) {
        directionSelect.value = 'bidirectional';
        conflictSelect.value = 'crdt-merge';
        await initSimulator();
      }
      const pRow1 = (primaryDb.tables.get('TASKS') || []).find(
        (r) => r.ID === 1,
      );
      const baseStock = Number(pRow1?.STOCK ?? 10);
      const baseTags = String(pRow1?.TAGS ?? 'core,wasm');

      // Primary increments STOCK by +5 and adds 'hlc'
      await primaryDb.execute(
        'UPDATE TASKS SET STOCK = ?, TAGS = ? WHERE ID = ?',
        [baseStock + 5, `${baseTags},hlc`, 1],
      );
      // Replica concurrently increments STOCK by +3 and adds 'crdt'
      await replicaDb.execute(
        'UPDATE TASKS SET STOCK = ?, TAGS = ? WHERE ID = ?',
        [baseStock + 3, `${baseTags},crdt`, 1],
      );
      await replicator.sync();
      logEvent(
        `Scenario 2 (CRDT + HLC): Concurrent edits on Row #1 (<code>STOCK +5</code> &amp; <code>+hlc</code> on Primary; <code>STOCK +3</code> &amp; <code>+crdt</code> on Replica) converged to <strong>STOCK = ${baseStock + 8}</strong> (<code>pn-counter</code>) and <strong>TAGS = '${baseTags},crdt,hlc'</strong> (<code>set-union</code>)!`,
        true,
      );
      await renderAll();
    } else if (kind === 'merge') {
      if (directionSelect.value !== 'bidirectional') {
        directionSelect.value = 'bidirectional';
        await initSimulator();
      }
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
        'Merged Title (from Primary)',
        1,
      ]);
      await replicaDb.execute(
        'UPDATE TASKS SET PRIORITY = ?, DONE = ? WHERE ID = ?',
        ['URGENT (from Replica)', 0, 1],
      );
      await replicator.sync();
      logEvent(
        `Scenario 3: Concurrent edits to Row #1 (<code>TITLE</code> on Primary, <code>PRIORITY</code> + <code>DONE</code> on Replica) converged cleanly!`,
        true,
      );
      await renderAll();
    } else if (kind === 'filter') {
      tenantFilterSelect.value = 'acme';
      colFilterSelect.value = 'exclude-secret';
      await initSimulator();
      const idAcme = nextTaskId++;
      const idGlobex = nextTaskId++;
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          idAcme,
          'acme',
          `ACME Filtered Task #${idAcme}`,
          'HIGH',
          12,
          'acme,allowed',
          0,
          'sha256:secret-acme',
        ],
      );
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          idGlobex,
          'globex',
          `Globex Filtered Out #${idGlobex}`,
          'LOW',
          4,
          'globex,skipped',
          0,
          'sha256:secret-globex',
        ],
      );
      await replicator.sync();
      logEvent(
        `Scenario 4: Inserted ACME (#${idAcme}) and Globex (#${idGlobex}) on Primary. Only ACME replicated to Replica, and <code>SECRET_HASH</code> was stripped by <code>excludeColumns</code>!`,
      );
      await renderAll();
    } else if (kind === 'slots') {
      const currentHead = await replicator.primaryPublication.currentLsn();
      await replicator.primaryPublication.registerSlot(
        'analytics_dr',
        'dr-node-2',
        1,
      );
      const id = nextTaskId++;
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          'acme',
          `Slot Protected Task #${id}`,
          'HIGH',
          7,
          'slot,wal',
          0,
          'sha256:slot',
        ],
      );
      await replicator.sync();
      const holdbackRes = await replicator.primaryPublication.pruneAcked();
      logEvent(
        `Scenario 5: Registered lagging slot <code>analytics_dr</code> at LSN 1 (Primary head is LSN ${currentHead + 1}). Running <code>pruneAcked()</code> pruned <strong>${holdbackRes.pruned}</strong> entries above LSN 1 because <code>analytics_dr</code> still needs them! Click <strong>Advance analytics_dr</strong> then <strong>Prune Acked</strong> to reclaim journal space.`,
      );
      await renderAll();
    } else if (kind === 'ddl') {
      const ddl = 'ALTER TABLE TASKS ADD AUDIT_TRAIL VARCHAR(120)';
      await replicator.primaryPublication.recordDdl(ddl);
      const res = await replicator.sync();
      logEvent(
        `Scenario 6: Recorded DDL <code>${ddl}</code> in <code>FB_REPL_JOURNAL$</code> and replicated to Replica (${res.primaryToReplica.appliedCount} applied).`,
      );
      activeCodeTab = 'hex';
      await renderAll();
    } else if (kind === 'promote') {
      await runPromoteReplicaDemo();
    } else if (kind === 'timetravel') {
      const checkpointLsn = await replicator.primaryPublication.currentLsn();
      // Perform an accidental update and delete
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', [
        'ACCIDENTAL CORRUPTED TITLE',
        1,
      ]);
      await replicator.sync();
      await primaryDb.execute('DELETE FROM TASKS WHERE ID = ?', [2]);
      await replicator.sync();
      const headBeforeRewind = await replicator.primaryPublication.currentLsn();

      // Rewind back to checkpointLsn!
      const res =
        await replicator.primaryPublication.rewindToLsn(checkpointLsn);
      logEvent(
        `Scenario 8 (<code>asOfLsn</code> / <code>rewindToLsn</code>): Simulated accidental title overwrite on Row #1 and deletion of Row #2 (advancing to LSN ${headBeforeRewind}), then called <code>rewindToLsn(db, ${checkpointLsn})</code> to undo <strong>${res.entriesUndone}</strong> mutations via <code>BEFORE_JSON</code> and restore Row #1 &amp; Row #2!`,
        true,
      );
      await renderAll();
    } else if (kind === 'mesh') {
      const idEu = nextTaskId++;
      const idUs = nextTaskId++;
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          idEu,
          'acme',
          `Edge-EU Mesh Task #${idEu}`,
          'HIGH',
          20,
          'mesh,edge-eu',
          0,
          'sha256:eu',
        ],
      );
      await replicaDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          idUs,
          'acme',
          `Edge-US Spoke Task #${idUs}`,
          'MEDIUM',
          14,
          'mesh,edge-us',
          0,
          'sha256:us',
        ],
      );
      await replicator.sync();
      const headLsn = await replicator.primaryPublication.currentLsn();
      await replicator.primaryPublication.registerSlot('slot_edge_eu', 'edge_eu', headLsn);
      await replicator.primaryPublication.registerSlot('slot_edge_us', 'edge_us', headLsn);
      simMeshMatrix = {
        hub: { edge_eu: headLsn, edge_us: headLsn },
        edge_eu: { hub: headLsn },
        edge_us: { hub: headLsn },
      };
      activeCodeTab = 'mesh-dlq';
      logEvent(
        `Scenario 9 (<code>createReplicationHub</code>): Converged 3-node Hub &amp; Spoke topology (<code>hub</code> ↔ <code>edge_eu</code> ↔ <code>edge_us</code>) at watermark LSN ${headLsn} across 2 transitive fanout rounds!`,
        true,
      );
      await renderAll();
    } else if (kind === 'dlq') {
      const id = nextTaskId++;
      // Perform 3 rapid updates on Row #1 and compact them, plus quarantine a poison entry into FB_REPL_DLQ$
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', ['Draft v1', 1]);
      await replicator.primaryPublication.captureTableChanges();
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', ['Draft v2', 1]);
      await replicator.primaryPublication.captureTableChanges();
      await primaryDb.execute('UPDATE TASKS SET TITLE = ? WHERE ID = ?', ['Compacted Final v3', 1]);
      await replicator.primaryPublication.captureTableChanges();

      const compactRes = await replicator.primaryPublication.compactJournal();
      await replicator.sync();

      const headLsn = await replicator.primaryPublication.currentLsn();
      simDlqEntries = [
        {
          lsn: headLsn + 1,
          subscriptionName: 'sub_replica',
          table: 'TASKS',
          key: { ID: id },
          errorMessage: 'validateEntry rejected row: STOCK (-99) violates CHECK (STOCK >= 0)',
          retryCount: 1,
          quarantinedAt: Date.now(),
        },
      ];
      activeCodeTab = 'mesh-dlq';
      logEvent(
        `Scenario 10 (<code>FB_REPL_DLQ$</code> &amp; <code>compactJournal</code>): Quarantined poison entry <code>LSN #${headLsn + 1}</code> into <code>FB_REPL_DLQ$</code> without blocking valid rows, and compacted <strong>${compactRes.entriesRemoved}</strong> superseded row mutations!`,
        true,
      );
      await renderAll();
    } else if (kind === 'fbchangelog') {
      const id = nextTaskId++;
      simChangelogSeq++;
      simEnginePubState = {
        name: 'RDB$DEFAULT',
        active: true,
        autoEnable: true,
        publishedTables: ['TASKS'],
        replicaMode: 'READ-WRITE',
        sequenceValue: id,
      };
      await primaryDb.execute(
        'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          'acme',
          `Native FBCHANGELOG Task #${id}`,
          'HIGH',
          32,
          'fbchangelog,ireplicator',
          0,
          `sha256:fbc${id}`,
        ],
      );
      const res = await replicator.sync();
      activeCodeTab = 'fbchangelog';
      logEvent(
        `Scenario 11 (<code>RDB$PUBLICATIONS</code> + <code>"FBCHANGELOG\\0"</code>): Enabled <code>RDB$DEFAULT</code> (<code>INCLUDE ALL</code>), sealed <code>.journal-${String(simChangelogSeq).padStart(9, '0')}</code> with <code>opSetSequence</code> + <code>opInsertRecord</code> blocks, and replayed <strong>${res.primaryToReplica.appliedCount}</strong> native change(s) onto Replica (<code>REPLICA_MODE = READ-WRITE</code>)!`,
        true,
      );
      await renderAll();
    } else if (kind === 'oneliner-batch') {
      const batchIds = [nextTaskId++, nextTaskId++, nextTaskId++];
      for (const id of batchIds) {
        await primaryDb.execute(
          'INSERT INTO TASKS (ID, TENANT_ID, TITLE, PRIORITY, STOCK, TAGS, DONE, SECRET_HASH) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            'acme',
            `IBatch Sync Task #${id}`,
            'HIGH',
            25,
            'syncDatabases,ibatch,ws-gzip',
            0,
            `sha256:b${id}`,
          ],
        );
      }
      await primaryDb.execute('UPDATE TASKS SET DONE = ? WHERE ID = ?', [1, 1]);
      simChangelogSeq++;
      simEnginePubState.sequenceValue = batchIds[batchIds.length - 1];

      const res = await replicator.sync();
      const recentEntries = await replicator.primaryPublication.fetchChangesSince(0);
      const { seg } = buildFbChangelogSegmentBytes(
        recentEntries.slice(-4),
        simChangelogSeq,
        simEnginePubState.sequenceValue,
      );
      let wireLen = seg.byteLength;
      if (typeof CompressionStream !== 'undefined') {
        const cs = new CompressionStream('gzip');
        const gzPromise = new Response(cs.readable).arrayBuffer();
        const writer = cs.writable.getWriter();
        void writer.write(new Uint8Array(seg)).catch(() => {});
        await writer.close();
        wireLen = (await gzPromise).byteLength;
      }

      activeCodeTab = 'setup';
      logEvent(
        `Scenario 12 (<code>syncDatabases()</code> + <code>IBatch</code> + WS <code>"FBCHANGELOG\\0"</code>): Applied <strong>${res.primaryToReplica.appliedCount}</strong> mutations in one <code>UPDATE OR INSERT INTO "TASKS" ... MATCHING ("ID")</code> batch, and streamed gzipped <code>.journal-${String(simChangelogSeq).padStart(9, '0')}</code> via <code>sendChangelogSegment()</code> (${seg.byteLength}B → ${wireLen}B wire)!`,
        true,
      );
      await renderAll();
    }
  });
}

// Boot simulator
void initSimulator();
