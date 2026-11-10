import { describe, it, expect } from 'vitest';
import {
  createPublication,
  createSubscription,
  replicateDatabases,
  mergeReplicatedRow,
  replicationTriggerName,
  replicationEventName,
  buildReplicationTriggerDdl,
  installReplicationTriggers,
  dropReplicationTriggers,
  needsBootstrap,
  bootstrapReplica,
  publishAllTables,
  exportSequences,
  applySequences,
  syncCatalog,
  projectReplicatedRow,
  matchesRowFilter,
  orderEntriesByTopology,
  formatHlc,
  parseHlc,
  compareHlc,
  createHlc,
  mergeCrdtRow,
  createCrdtConflictResolver,
  createHttpReplicationHandler,
  createHttpReplicationClient,
  createBroadcastChannelTransport,
  createWebSocketReplicationPeer,
  encodeNativeJournalSegment,
  decodeNativeJournalSegment,
  NATIVE_REPL_SEGMENT_MAGIC,
  NATIVE_REPL_PROTOCOL_VERSION,
  promoteReplica,
  NATIVE_REPL_ENCRYPTED_SEGMENT_MAGIC,
  encodeEncryptedJournalSegment,
  decodeEncryptedJournalSegment,
  asOfLsn,
  rewindToLsn,
  createReplicationMesh,
  createReplicationHub,
  createReplicationDlq,
  createPiiMaskingTransformer,
  exportJournalArchive,
  applyJournalArchive,
  compactJournal,
  applyRetentionPolicy,
  createReplicationMetricsCollector,
  formatPrometheusReplicationMetrics,
  classifyDdlStatement,
  resolveDdlConflict,
  checkReplicationSchemaCompatibility,
  FB_CHANGELOG_MAGIC,
  FB_CHANGELOG_HEADER_BYTES,
  FB_CHANGELOG_BLOCK_HEADER_BYTES,
  FbChangelogOpcode,
  includeTablesInPublication,
  excludeTablesFromPublication,
  enableEnginePublication,
  disableEnginePublication,
  getEnginePublicationStatus,
  buildReplicationConf,
  configureWasmReplicationConf,
  isFbChangelogSegment,
  parseFbChangelogSegment,
  readWasmChangelogSegments,
  applyFbChangelogSegmentToDatabase,
  decodeFbChangelogOperations,
  decodeJrdRecordBuffer,
  encodeJrdRecordBuffer,
  encodeFbChangelogSegment,
  fbChangelogToLogicalEntries,
  setWasmDatabaseReplicaMode,
  createWasmChangelogPoller,
  type JrdColumnDescriptor,
  type ReplicableDatabase,
  type ReplicationEmscriptenFS,
  type WebSocketLike,
} from '../replication';
import type { QueryParams, QueryResult, Row } from '../types';

// ---------------------------------------------------------------------------
// In-Memory SQL Mock Database for Logical & Journal Replication Tests
// ---------------------------------------------------------------------------

function createMockReplDb(): ReplicableDatabase & {
  tables: Map<string, Row[]>;
  sequences: Map<string, number>;
  ddlLog: string[];
  triggerDdlLog: string[];
  contextLog: string[];
} {
  const tables = new Map<string, Row[]>();
  const sequences = new Map<string, number>();
  const ddlLog: string[] = [];
  const triggerDdlLog: string[] = [];
  const contextLog: string[] = [];
  let pubActive = 0;
  let pubAutoEnable = 0;
  const pubTables = new Set<string>();

  const getTable = (name: string): Row[] => {
    const upper = name.replace(/"/g, '').toUpperCase();
    let list = tables.get(upper);
    if (!list) {
      list = [];
      tables.set(upper, list);
    }
    return list;
  };

  const runSelect = (sql: string, params: QueryParams = []): QueryResult<Row> => {
    const trimmed = sql.trim();

    if (/RDB\$SET_CONTEXT\s*\(/i.test(trimmed)) {
      contextLog.push(trimmed);
      return { rows: [{ RESULT: 1 }] };
    }

    if (/FROM\s+RDB\$PUBLICATIONS\b/i.test(trimmed)) {
      return {
        rows: [
          {
            PUB_NAME: 'RDB$DEFAULT',
            ACTIVE_FLAG: pubActive,
            AUTO_ENABLE: pubAutoEnable,
          },
        ],
      };
    }

    if (/FROM\s+RDB\$PUBLICATION_TABLES\b/i.test(trimmed)) {
      return {
        rows: Array.from(pubTables)
          .sort()
          .map((t) => ({ TABLE_NAME: t })),
      };
    }

    if (/RDB\$GET_CONTEXT\s*\(\s*'SYSTEM'\s*,\s*'REPLICA_MODE'\s*\)/i.test(trimmed)) {
      return {
        rows: [{ REPL_MODE: 'NONE', REPL_SEQ: pubActive ? 1 : 0 }],
      };
    }

    // MAX(col) AS alias
    const maxMatch =
      /SELECT\s+MAX\(([A-Za-z0-9_$"]+)\)\s+AS\s+([A-Za-z0-9_$"]+)\s+FROM\s+([A-Za-z0-9_$"]+)/i.exec(
        trimmed,
      );
    if (maxMatch) {
      const col = maxMatch[1]!.replace(/"/g, '').toUpperCase();
      const alias = maxMatch[2]!.replace(/"/g, '').toUpperCase();
      const rows = getTable(maxMatch[3]!);
      let max = 0;
      for (const r of rows) {
        const val = Number(r[col] ?? 0);
        if (val > max) max = val;
      }
      return { rows: [{ [alias]: max }] };
    }

    // Journal WHERE LSN > ?
    const journalSinceMatch =
      /FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*>\s*\?\s+ORDER\s+BY\s+LSN\s+ASC/i.exec(
        trimmed,
      );
    if (journalSinceMatch) {
      const minLsn = Number(params[0] ?? 0);
      const rows = getTable(journalSinceMatch[1]!)
        .filter((r) => Number(r.LSN ?? 0) > minLsn)
        .sort((a, b) => Number(a.LSN ?? 0) - Number(b.LSN ?? 0))
        .map((r) => ({ ...r }));
      return { rows };
    }

    // Journal WHERE LSN <= ?
    const journalPruneMatch = /FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*<=\s*\?/i.exec(
      trimmed,
    );
    if (journalPruneMatch && /^SELECT\b/i.test(trimmed)) {
      const maxLsn = Number(params[0] ?? 0);
      const rows = getTable(journalPruneMatch[1]!)
        .filter((r) => Number(r.LSN ?? 0) <= maxLsn)
        .map((r) => ({ ...r }));
      return { rows };
    }

    // Watermark WHERE SUB_NAME = ?
    const watermarkMatch =
      /FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+SUB_NAME\s*=\s*\?/i.exec(trimmed);
    if (watermarkMatch && /^SELECT\b/i.test(trimmed)) {
      const subName = String(params[0] ?? '');
      const rows = getTable(watermarkMatch[1]!)
        .filter((r) => String(r.SUB_NAME) === subName)
        .map((r) => ({ ...r }));
      return { rows };
    }

    // Generic SELECT * FROM <table> [WHERE ...] [ORDER BY ...]
    const withoutOrder = trimmed.replace(/\s+ORDER\s+BY\s+.+$/i, '');
    const fromMatch = /FROM\s+([A-Za-z0-9_$"]+)(?:\s+WHERE\s+(.+))?$/i.exec(withoutOrder);
    if (fromMatch) {
      const list = getTable(fromMatch[1]!);
      const wherePart = fromMatch[2];
      if (!wherePart) {
        return { rows: list.map((r) => ({ ...r })) };
      }
      const cols = wherePart
        .split(/\s+AND\s+/i)
        .map((part) => part.split('=')[0]!.trim().replace(/"/g, '').toUpperCase());
      const filtered = list
        .filter((r) => cols.every((c, idx) => r[c] === params[idx]))
        .map((r) => ({ ...r }));
      return { rows: filtered };
    }

    return { rows: [] };
  };

  const runMutation = (sql: string, params: QueryParams = []): void => {
    const trimmed = sql.trim();

    if (/^\s*CREATE\s+OR\s+ALTER\s+TRIGGER\b/i.test(trimmed) || /^\s*DROP\s+TRIGGER\b/i.test(trimmed)) {
      triggerDdlLog.push(trimmed);
      return;
    }

    if (/^\s*CREATE\s+SEQUENCE\b/i.test(trimmed)) {
      return;
    }

    if (/^\s*ALTER\s+DATABASE\b/i.test(trimmed)) {
      ddlLog.push(trimmed);
      if (/ENABLE\s+PUBLICATION/i.test(trimmed)) {
        pubActive = 1;
      } else if (/DISABLE\s+PUBLICATION/i.test(trimmed)) {
        pubActive = 0;
      } else if (/INCLUDE\s+ALL\s+TO\s+PUBLICATION/i.test(trimmed)) {
        pubAutoEnable = 1;
        for (const t of tables.keys()) {
          if (!t.startsWith('FB_REPL_')) pubTables.add(t);
        }
      } else if (/EXCLUDE\s+ALL\s+FROM\s+PUBLICATION/i.test(trimmed)) {
        pubAutoEnable = 0;
        pubTables.clear();
      } else {
        const incMatch = /INCLUDE\s+TABLE\s+([A-Za-z0-9_$"]+)\s+TO\s+PUBLICATION/i.exec(trimmed);
        if (incMatch) {
          pubTables.add(incMatch[1]!.replace(/"/g, '').toUpperCase());
        }
        const excMatch = /EXCLUDE\s+TABLE\s+([A-Za-z0-9_$"]+)\s+FROM\s+PUBLICATION/i.exec(trimmed);
        if (excMatch) {
          pubTables.delete(excMatch[1]!.replace(/"/g, '').toUpperCase());
        }
      }
      return;
    }

    if (/^\s*(CREATE|ALTER)\s+TABLE\s+([A-Za-z0-9_$"]+)/i.test(trimmed)) {
      const m = /^\s*(CREATE|ALTER)\s+TABLE\s+([A-Za-z0-9_$"]+)/i.exec(trimmed)!;
      const tbl = m[2]!.replace(/"/g, '').toUpperCase();
      getTable(tbl);
      if (!tbl.startsWith('FB_REPL_')) {
        ddlLog.push(trimmed);
      }
      return;
    }

    const insertMatch =
      /^INSERT\s+INTO\s+([A-Za-z0-9_$"]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(
        trimmed,
      );
    if (insertMatch) {
      const list = getTable(insertMatch[1]!);
      const cols = insertMatch[2]!
        .split(',')
        .map((c) => c.trim().replace(/"/g, '').toUpperCase());
      const row: Row = {};
      cols.forEach((col, i) => {
        row[col] = params[i];
      });
      list.push(row);
      return;
    }

    const updateMatch =
      /^UPDATE\s+([A-Za-z0-9_$"]+)\s+SET\s+(.+)\s+WHERE\s+(.+)$/i.exec(trimmed);
    if (updateMatch) {
      const list = getTable(updateMatch[1]!);
      const setCols = updateMatch[2]!
        .split(',')
        .map((p) => p.split('=')[0]!.trim().replace(/"/g, '').toUpperCase());
      const whereCols = updateMatch[3]!
        .split(/\s+AND\s+/i)
        .map((p) => p.split('=')[0]!.trim().replace(/"/g, '').toUpperCase());
      for (const r of list) {
        const matches = whereCols.every(
          (c, i) => r[c] === params[setCols.length + i],
        );
        if (matches) {
          setCols.forEach((c, i) => {
            r[c] = params[i];
          });
        }
      }
      return;
    }

    const deletePruneMatch =
      /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*<=\s*\?/i.exec(trimmed);
    if (deletePruneMatch) {
      const tbl = deletePruneMatch[1]!.replace(/"/g, '').toUpperCase();
      const maxLsn = Number(params[0] ?? 0);
      tables.set(
        tbl,
        getTable(tbl).filter((r) => Number(r.LSN ?? 0) > maxLsn),
      );
      return;
    }

    const deleteAfterLsnMatch =
      /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+LSN\s*>\s*\?/i.exec(trimmed);
    if (deleteAfterLsnMatch) {
      const tbl = deleteAfterLsnMatch[1]!.replace(/"/g, '').toUpperCase();
      const cutoffLsn = Number(params[0] ?? 0);
      tables.set(
        tbl,
        getTable(tbl).filter((r) => Number(r.LSN ?? 0) <= cutoffLsn),
      );
      return;
    }

    const deleteMatch = /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+(.+)$/i.exec(
      trimmed,
    );
    if (deleteMatch) {
      const tbl = deleteMatch[1]!.replace(/"/g, '').toUpperCase();
      const whereCols = deleteMatch[2]!
        .split(/\s+AND\s+/i)
        .map((p) => p.split('=')[0]!.trim().replace(/"/g, '').toUpperCase());
      tables.set(
        tbl,
        getTable(tbl).filter((r) => !whereCols.every((c, i) => r[c] === params[i])),
      );
      return;
    }

    const deleteAllMatch = /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)$/i.exec(trimmed);
    if (deleteAllMatch) {
      const tbl = deleteAllMatch[1]!.replace(/"/g, '').toUpperCase();
      tables.set(tbl, []);
    }
  };

  const db = {
    tables,
    sequences,
    ddlLog,
    triggerDdlLog,
    contextLog,
    async query<T extends Row = Row>(
      sql: string,
      params: QueryParams = [],
    ): Promise<QueryResult<T>> {
      if (/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        runMutation(sql, params);
        return { rows: [] as T[] };
      }
      return runSelect(sql, params) as QueryResult<T>;
    },
    async execute(sql: string, params: QueryParams = []): Promise<{ changes?: number }> {
      runMutation(sql, params);
      return { changes: 1 };
    },
    async exec(sql: string, params: QueryParams = []): Promise<void> {
      runMutation(sql, params);
    },
    async transaction<T>(
      fn: (tx: {
        query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
        execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
        exec?(sql: string, params?: QueryParams): Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T> {
      return fn(db);
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('firebird-wasm/replication – Logical & Journal-Based Database Replication', () => {
  it('replicates DDL + DML changes from primary to replica with LSN watermarking and journal pruning', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    const pub = await createPublication(primary, {
      name: 'app_pub',
      nodeId: 'primary-1',
      tables: [{ table: 'USERS', primaryKey: 'ID' }],
    });

    const sub = await createSubscription(replica, {
      name: 'replica_sub',
      nodeId: 'replica-1',
      publication: pub,
    });

    // 1. Record DDL + DML on primary
    await pub.recordDdl('CREATE TABLE USERS (ID INTEGER PRIMARY KEY, NAME VARCHAR(100), ROLE VARCHAR(50))');
    await pub.recordDml({
      table: 'USERS',
      operation: 'INSERT',
      after: { ID: 1, NAME: 'Alice', ROLE: 'admin' },
    });
    await pub.recordDml({
      table: 'USERS',
      operation: 'INSERT',
      after: { ID: 2, NAME: 'Bob', ROLE: 'member' },
    });
    await pub.recordDml({
      table: 'USERS',
      operation: 'UPDATE',
      key: { ID: 2 },
      after: { NAME: 'Bob Updated', ROLE: 'editor' },
    });

    expect(await pub.currentLsn()).toBe(4);
    expect(await sub.getWatermark()).toBe(0);

    // 2. Pull batch into replica
    const pull1 = await sub.pull();
    expect(pull1.fetchedCount).toBe(4);
    expect(pull1.appliedCount).toBe(4);
    expect(pull1.previousLsn).toBe(0);
    expect(pull1.currentLsn).toBe(4);
    expect(await sub.getWatermark()).toBe(4);

    expect(replica.ddlLog).toEqual([
      'CREATE TABLE USERS (ID INTEGER PRIMARY KEY, NAME VARCHAR(100), ROLE VARCHAR(50))',
    ]);
    expect(replica.tables.get('USERS')).toEqual([
      { ID: 1, NAME: 'Alice', ROLE: 'admin' },
      { ID: 2, NAME: 'Bob Updated', ROLE: 'editor' },
    ]);

    // 3. Subsequent pull when no new changes -> no-op
    const pull2 = await sub.pull();
    expect(pull2.fetchedCount).toBe(0);
    expect(pull2.appliedCount).toBe(0);
    expect(pull2.currentLsn).toBe(4);

    // 4. Delete row on primary and pull
    await pub.recordDml({
      table: 'USERS',
      operation: 'DELETE',
      key: { ID: 1 },
    });
    const pull3 = await sub.pull();
    expect(pull3.appliedCount).toBe(1);
    expect(pull3.currentLsn).toBe(5);
    expect(replica.tables.get('USERS')).toEqual([
      { ID: 2, NAME: 'Bob Updated', ROLE: 'editor' },
    ]);

    // 5. Prune journal on primary up to LSN 4
    const pruned = await pub.pruneJournal(4);
    expect(pruned).toBe(4);
    const remaining = await pub.fetchChangesSince(0);
    expect(remaining.map((e) => e.lsn)).toEqual([5]);
  });

  it('auto-captures direct SQL table changes and performs bidirectional sync with conflict resolution', async () => {
    const nodeA = createMockReplDb();
    const nodeB = createMockReplDb();

    nodeA.tables.set('TODOS', [{ ID: 1, TITLE: 'Initial task', DONE: 0 }]);
    nodeB.tables.set('TODOS', []);

    const conflicts: string[] = [];
    const replicator = await replicateDatabases({
      primary: nodeA,
      replica: nodeB,
      tables: [{ table: 'TODOS', primaryKey: 'ID' }],
      direction: 'bidirectional',
      onConflict: 'merge',
      onConflictResolved: (ctx, res) => {
        conflicts.push(`${ctx.incoming.table}:${res}`);
      },
    });

    // 1. Initial sync propagates row 1 from nodeA -> nodeB
    const cycle1 = await replicator.sync();
    expect(cycle1.primaryToReplica.appliedCount).toBe(1);
    expect(nodeB.tables.get('TODOS')).toEqual([
      { ID: 1, TITLE: 'Initial task', DONE: 0 },
    ]);

    // 2. Direct SQL insert on nodeB (replica) propagates back to nodeA (primary) without echo loop
    await nodeB.execute!(
      'INSERT INTO TODOS (ID, TITLE, DONE) VALUES (?, ?, ?)',
      [2, 'Created on replica', 0],
    );
    const cycle2 = await replicator.sync();
    expect(cycle2.replicaToPrimary?.appliedCount).toBe(1);
    expect(nodeA.tables.get('TODOS')).toEqual([
      { ID: 1, TITLE: 'Initial task', DONE: 0 },
      { ID: 2, TITLE: 'Created on replica', DONE: 0 },
    ]);

    // 3. Concurrent conflicting updates to row 1 on both nodes:
    //    nodeA changes TITLE, while nodeB changes DONE
    await nodeA.execute!(
      'UPDATE TODOS SET TITLE = ? WHERE ID = ?',
      ['Renamed on Primary', 1],
    );
    await nodeB.execute!(
      'UPDATE TODOS SET DONE = ? WHERE ID = ?',
      [1, 1],
    );

    await replicator.sync();
    expect(conflicts.length).toBeGreaterThanOrEqual(1);

    // Both nodes converge to the 3-way merged state (`TITLE: 'Renamed on Primary'`, `DONE: 1`)
    expect(nodeA.tables.get('TODOS')?.find((r) => r.ID === 1)).toEqual({
      ID: 1,
      TITLE: 'Renamed on Primary',
      DONE: 1,
    });
    expect(nodeB.tables.get('TODOS')?.find((r) => r.ID === 1)).toEqual({
      ID: 1,
      TITLE: 'Renamed on Primary',
      DONE: 1,
    });

    await replicator.stop();
  });

  it('supports 3-way field-level merge helper (mergeReplicatedRow)', () => {
    const before = { ID: 1, TITLE: 'Old', DONE: 0, PRIORITY: 'low' };
    const local = { ID: 1, TITLE: 'Old', DONE: 1, PRIORITY: 'low' };
    const remote = { ID: 1, TITLE: 'New', DONE: 0, PRIORITY: 'high' };

    const merged = mergeReplicatedRow(before, local, remote);
    expect(merged).toEqual({
      ID: 1,
      TITLE: 'New',
      DONE: 1,
      PRIORITY: 'high',
    });
  });

  it('generates and installs Firebird SQL replication triggers (installReplicationTriggers) and sets RDB$SET_CONTEXT on replica apply', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    // Seed sample row so column discovery detects ID, TITLE, STATUS
    primary.tables.set('TASKS', [{ ID: 1, TITLE: 'Ship M12', STATUS: 'active' }]);

    const pub = await createPublication(primary, {
      name: 'default',
      nodeId: 'primary-node',
      tables: [{ table: 'TASKS', primaryKey: 'ID', columns: ['ID', 'TITLE', 'STATUS'] }],
      installTriggers: true,
    });

    expect(primary.triggerDdlLog.length).toBe(1);
    const ddl = primary.triggerDdlLog[0]!;
    expect(ddl).toContain('CREATE OR ALTER TRIGGER FB_REPL_TRG$TASKS FOR TASKS');
    expect(ddl).toContain(`RDB$GET_CONTEXT('USER_SESSION', 'FB_REPL_ROLE') IS DISTINCT FROM 'REPLICA'`);
    expect(ddl).toContain('NEXT VALUE FOR FB_REPL_LSN_GEN$');
    expect(ddl).toContain(`POST_EVENT 'fb_repl_default'`);

    // Verify deterministic identifier helpers stay <= 31 characters
    expect(replicationTriggerName('TASKS').length).toBeLessThanOrEqual(31);
    expect(
      replicationTriggerName('VERY_LONG_ENTERPRISE_DOCUMENT_ITEMS_TABLE_NAME', 'custom_pub').length,
    ).toBeLessThanOrEqual(31);
    expect(
      replicationEventName('very_long_publication_identifier_exceeding_31_bytes').length,
    ).toBeLessThanOrEqual(31);

    const built = buildReplicationTriggerDdl({
      table: 'ORDERS',
      primaryKey: ['ORDER_ID'],
      columns: ['ORDER_ID', 'TOTAL'],
      publication: 'orders_pub',
      nodeId: 'edge-1',
    });
    expect(built.triggerName.length).toBeLessThanOrEqual(31);
    expect(built.ddl).toContain('NEW.ORDER_ID');
    expect(built.ddl).toContain('OLD.ORDER_ID');

    // Verify replica subscription sets and resets RDB$SET_CONTEXT('USER_SESSION', 'FB_REPL_ROLE', ...)
    const sub = await createSubscription(replica, {
      name: 'sub_tasks',
      nodeId: 'replica-node',
      publication: pub,
    });

    await pub.recordDml({
      table: 'TASKS',
      operation: 'INSERT',
      after: { ID: 2, TITLE: 'Test Trigger Context', STATUS: 'done' },
    });

    await sub.pull();
    expect(replica.contextLog.some((c) => c.includes(`'REPLICA'`))).toBe(true);
    expect(replica.contextLog.some((c) => c.includes(`'PRIMARY'`))).toBe(true);

    const dropped = await pub.dropTriggers();
    expect(dropped).toEqual(['FB_REPL_TRG$TASKS']);
    expect(
      await dropReplicationTriggers(primary, { tables: ['TASKS'], publication: 'default' }),
    ).toEqual(['FB_REPL_TRG$TASKS']);
    expect(
      await installReplicationTriggers(primary, { tables: ['TASKS'], publication: 'default' }),
    ).toHaveLength(1);
  });

  it('tracks replication slots (FB_REPL_SLOTS$), heartbeats, TTL expiration, and safe pruneAcked()', async () => {
    const primary = createMockReplDb();
    const replicaA = createMockReplDb();
    const replicaB = createMockReplDb();

    const pub = await createPublication(primary, {
      name: 'slots_pub',
      nodeId: 'primary-1',
      tables: [{ table: 'ITEMS', primaryKey: 'ID' }],
    });

    const subA = await createSubscription(replicaA, {
      name: 'sub_a',
      nodeId: 'replica-a',
      slotName: 'slot_a',
      slotTtlMs: 60_000,
      publication: pub,
    });

    const subB = await createSubscription(replicaB, {
      name: 'sub_b',
      nodeId: 'replica-b',
      slotName: 'slot_b',
      slotTtlMs: 1_000, // short TTL to test expiration
      publication: pub,
    });
    expect(subB.slotName).toBe('slot_b');

    // Record 4 changes on primary
    for (let i = 1; i <= 4; i++) {
      await pub.recordDml({
        table: 'ITEMS',
        operation: 'INSERT',
        after: { ID: i, NAME: `Item ${i}` },
      });
    }

    // Replica A pulls all 4 changes -> slot_a confirmedFlushLsn = 4
    await subA.pull();
    // Replica B only acknowledges LSN 2 at t = 1000
    await pub.advanceSlot('slot_b', 2, { nodeId: 'replica-b', ttlMs: 1_000, now: 1_000 });

    const slotsBefore = await pub.listSlots();
    expect(slotsBefore).toHaveLength(2);

    // At t = 1500 (slot_b still alive), safeLsn = MIN(4, 2) = 2
    const prune1 = await pub.pruneAcked({ now: 1_500 });
    expect(prune1.expiredSlots).toEqual([]);
    expect(prune1.activeSlotCount).toBe(2);
    expect(prune1.safeLsn).toBe(2);
    expect(prune1.prunedEntries).toBe(2);
    expect(await pub.minRetainedLsn()).toBe(3);

    // Heartbeat slot_a
    const hb = await subA.heartbeat({ now: Date.now() });
    expect(hb?.slotName).toBe('slot_a');

    // At t = Date.now() + 5000 (slot_b has expired past its 1000ms TTL from t=1000),
    // slot_b is expired and removed, so safeLsn advances to slot_a's LSN (4)!
    const prune2 = await pub.pruneAcked({ now: Date.now() + 5_000 });
    expect(prune2.expiredSlots).toEqual(['slot_b']);
    expect(prune2.activeSlotCount).toBe(1);
    expect(prune2.safeLsn).toBe(4);
    expect(prune2.prunedEntries).toBe(2);
    expect(await pub.minRetainedLsn()).toBeNull();
  });

  it('bootstraps new and fallen-behind replicas via exportSnapshot, bootstrapReplica, and autoBootstrap', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    const pub = await createPublication(primary, {
      name: 'boot_pub',
      nodeId: 'primary-1',
      tables: [{ table: 'PRODUCTS', primaryKey: 'ID' }],
    });

    await pub.recordDml({
      table: 'PRODUCTS',
      operation: 'INSERT',
      after: { ID: 1, NAME: 'Keyboard', PRICE: 120 },
    });
    await pub.recordDml({
      table: 'PRODUCTS',
      operation: 'INSERT',
      after: { ID: 2, NAME: 'Monitor', PRICE: 350 },
    });
    await pub.recordDml({
      table: 'PRODUCTS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { NAME: 'Mechanical Keyboard', PRICE: 145 },
    });

    // Prune journal up to LSN 2 so a new replica at watermark 0 is behind the retained journal
    await pub.pruneJournal(2);
    expect(await pub.minRetainedLsn()).toBe(3);

    const sub = await createSubscription(replica, {
      name: 'sub_boot',
      nodeId: 'replica-boot',
      publication: pub,
      autoBootstrap: true,
    });

    const check = await needsBootstrap(pub, sub);
    expect(check.needed).toBe(true);
    expect(check.reason).toBe('behind-retained-journal');

    // Calling pull() with autoBootstrap: true automatically seeds from exportSnapshot()
    const pullRes = await sub.pull();
    expect(pullRes.bootstrapped).toBe(true);
    expect(pullRes.currentLsn).toBe(3);
    expect(await sub.getWatermark()).toBe(3);
    expect(replica.tables.get('PRODUCTS')).toEqual([
      { ID: 1, NAME: 'Mechanical Keyboard', PRICE: 145 },
      { ID: 2, NAME: 'Monitor', PRICE: 350 },
    ]);

    // Subsequent incremental DML after bootstrap replays normally
    await pub.recordDml({
      table: 'PRODUCTS',
      operation: 'INSERT',
      after: { ID: 3, NAME: 'Mouse', PRICE: 65 },
    });
    const pullNext = await sub.pull();
    expect(pullNext.bootstrapped).toBeUndefined();
    expect(pullNext.appliedCount).toBe(1);
    expect(pullNext.currentLsn).toBe(4);
    expect(replica.tables.get('PRODUCTS')).toHaveLength(3);

    // Explicit bootstrapReplica call also works directly
    const replica2 = createMockReplDb();
    const sub2 = await createSubscription(replica2, {
      name: 'sub_boot_2',
      nodeId: 'replica-boot-2',
      publication: pub,
    });
    const manualBoot = await bootstrapReplica({
      targetDb: replica2,
      publication: pub,
      subscription: sub2,
    });
    expect(manualBoot.watermarkLsn).toBe(4);
    expect(manualBoot.rowsCopied).toBe(3);
    expect(replica2.tables.get('PRODUCTS')).toHaveLength(3);
  });

  it('supports whole-database tables: "*", publishAllTables, sequence watermarks, and syncCatalog', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    await primary.execute!('CREATE TABLE CUSTOMERS (ID INTEGER PRIMARY KEY, NAME VARCHAR(64))');
    await primary.execute!('CREATE TABLE INVOICES (ID INTEGER PRIMARY KEY, TOTAL INTEGER)');
    primary.sequences.set('GEN_CUSTOMER_ID', 42);
    primary.sequences.set('GEN_INVOICE_ID', 108);

    const pub = await publishAllTables(primary, {
      name: 'full_pub',
      nodeId: 'primary-full',
      excludeTables: ['AUDIT_SCRATCH'],
    });
    expect(Array.from(pub.tables.keys()).sort()).toEqual(['CUSTOMERS', 'INVOICES']);

    // Create a new table dynamically after initial publication and verify refreshPublishedTables()
    await primary.execute!('CREATE TABLE PAYMENTS (ID INTEGER PRIMARY KEY, AMOUNT INTEGER)');
    await primary.execute!('CREATE TABLE AUDIT_SCRATCH (ID INTEGER PRIMARY KEY)');
    await primary.execute!('INSERT INTO CUSTOMERS (ID, NAME) VALUES (?, ?)', [1, 'Acme Corp']);
    await primary.execute!('INSERT INTO PAYMENTS (ID, AMOUNT) VALUES (?, ?)', [10, 500]);

    const catRes = await syncCatalog({
      sourceDb: primary,
      targetDb: replica,
      excludeTables: ['AUDIT_SCRATCH'],
    });
    expect(catRes.sequencesSynced).toBe(2);
    expect(replica.sequences.get('GEN_CUSTOMER_ID')).toBe(42);
    expect(replica.sequences.get('GEN_INVOICE_ID')).toBe(108);
    expect(catRes.discoveredTables).toEqual(['CUSTOMERS', 'INVOICES', 'PAYMENTS']);

    const seqs = await exportSequences(primary);
    expect(seqs).toEqual([
      { name: 'GEN_CUSTOMER_ID', currentValue: 42 },
      { name: 'GEN_INVOICE_ID', currentValue: 108 },
    ]);
    await applySequences(replica, [{ name: 'GEN_CUSTOMER_ID', currentValue: 99 }]);
    expect(replica.sequences.get('GEN_CUSTOMER_ID')).toBe(99);

    // Replicate with tables: '*' and syncCatalog: true
    const replicator = await replicateDatabases({
      primary,
      replica,
      tables: '*',
      excludeTables: ['AUDIT_SCRATCH'],
      syncCatalog: true,
    });
    const cycle = await replicator.sync();
    expect(cycle.catalogSync?.discoveredTables).toEqual(['CUSTOMERS', 'INVOICES', 'PAYMENTS']);
    expect(replica.tables.get('CUSTOMERS')).toEqual([{ ID: 1, NAME: 'Acme Corp' }]);
    expect(replica.tables.get('PAYMENTS')).toEqual([{ ID: 10, AMOUNT: 500 }]);
  });

  it('supports row filtering (where), column projection (columns/excludeColumns), and topological FK replay', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    // Direct helper unit checks
    expect(
      projectReplicatedRow(
        { ID: 1, NAME: 'Alice', SECRET_HASH: 'xyz', TENANT_ID: 7 },
        ['ID'],
        ['NAME', 'TENANT_ID'],
        ['SECRET_HASH'],
      ),
    ).toEqual({ ID: 1, NAME: 'Alice', TENANT_ID: 7 });
    expect(matchesRowFilter({ ID: 1, TENANT_ID: 7, ACTIVE: 1 }, 'TENANT_ID = 7 AND ACTIVE = 1')).toBe(
      true,
    );
    expect(matchesRowFilter({ ID: 2, TENANT_ID: 8, ACTIVE: 1 }, 'TENANT_ID = 7 AND ACTIVE = 1')).toBe(
      false,
    );

    const pub = await createPublication(primary, {
      name: 'tenant_pub',
      nodeId: 'primary-1',
      tables: [
        {
          table: 'USERS',
          primaryKey: 'ID',
          excludeColumns: ['PASSWORD_HASH'],
          where: "TENANT_ID = 't1'",
        },
      ],
    });

    const sub = await createSubscription(replica, {
      name: 'tenant_sub',
      nodeId: 'edge-t1',
      publication: pub,
    });

    // Row for t1 (in scope) and row for t2 (out of scope)
    await pub.recordDml({
      table: 'USERS',
      operation: 'INSERT',
      after: { ID: 1, NAME: 'Alice', TENANT_ID: 't1', PASSWORD_HASH: 'secret1' },
    });
    await pub.recordDml({
      table: 'USERS',
      operation: 'INSERT',
      after: { ID: 2, NAME: 'Bob', TENANT_ID: 't2', PASSWORD_HASH: 'secret2' },
    });

    await sub.pull();
    expect(replica.tables.get('USERS')).toEqual([
      { ID: 1, NAME: 'Alice', TENANT_ID: 't1' },
    ]);

    // Updating row 1 from TENANT_ID = 't1' to 't2' moves it out of filter scope -> synthetic DELETE on replica
    await pub.recordDml({
      table: 'USERS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { NAME: 'Alice', TENANT_ID: 't2', PASSWORD_HASH: 'secret1' },
    });
    // Updating row 2 from TENANT_ID = 't2' to 't1' moves it into filter scope -> synthetic INSERT on replica
    await pub.recordDml({
      table: 'USERS',
      operation: 'UPDATE',
      key: { ID: 2 },
      after: { NAME: 'Bob', TENANT_ID: 't1', PASSWORD_HASH: 'secret2' },
    });

    await sub.pull();
    expect(replica.tables.get('USERS')).toEqual([
      { ID: 2, NAME: 'Bob', TENANT_ID: 't1' },
    ]);

    // Topological FK ordering within the same txid:
    // Child ORDER_ITEMS references Parent ORDERS
    const orderedInsert = orderEntriesByTopology(
      [
        {
          lsn: 10,
          txid: 'tx-fk-1',
          origin: 'p',
          publication: 'pub',
          table: 'ORDER_ITEMS',
          operation: 'INSERT',
          key: { ID: 100 },
          after: { ID: 100, ORDER_ID: 1 },
          before: null,
          timestamp: 1,
        },
        {
          lsn: 11,
          txid: 'tx-fk-1',
          origin: 'p',
          publication: 'pub',
          table: 'ORDERS',
          operation: 'INSERT',
          key: { ID: 1 },
          after: { ID: 1, TOTAL: 50 },
          before: null,
          timestamp: 1,
        },
      ],
      { ORDER_ITEMS: ['ORDERS'] },
    );
    expect(orderedInsert.map((e) => e.table)).toEqual(['ORDERS', 'ORDER_ITEMS']);

    const orderedDelete = orderEntriesByTopology(
      [
        {
          lsn: 12,
          txid: 'tx-fk-2',
          origin: 'p',
          publication: 'pub',
          table: 'ORDERS',
          operation: 'DELETE',
          key: { ID: 1 },
          after: null,
          before: { ID: 1, TOTAL: 50 },
          timestamp: 2,
        },
        {
          lsn: 13,
          txid: 'tx-fk-2',
          origin: 'p',
          publication: 'pub',
          table: 'ORDER_ITEMS',
          operation: 'DELETE',
          key: { ID: 100 },
          after: null,
          before: { ID: 100, ORDER_ID: 1 },
          timestamp: 2,
        },
      ],
      { ORDER_ITEMS: ['ORDERS'] },
    );
    expect(orderedDelete.map((e) => e.table)).toEqual(['ORDER_ITEMS', 'ORDERS']);
  });

  it('provides monotonic Hybrid Logical Clocks (HLC) and per-column CRDT conflict resolution', async () => {
    const hlcA = createHlc('node-a', { initialWallMs: 1_000 });
    const hlcB = createHlc('node-b', { initialWallMs: 1_000 });

    // Same millisecond advances logical counter monotonically
    const t1 = hlcA.now(1_000);
    const t2 = hlcA.now(1_000);
    expect(parseHlc(t1)).toEqual({ wallMs: 1_000, counter: 1, nodeId: 'node-a' });
    expect(parseHlc(t2)).toEqual({ wallMs: 1_000, counter: 2, nodeId: 'node-a' });
    expect(compareHlc(t1, t2)).toBeLessThan(0);

    // Even when node-b's physical clock lags at 950ms, receiving t2 advances node-b causally past t2
    const t3 = hlcB.receive(t2, 950);
    expect(parseHlc(t3)).toEqual({ wallMs: 1_000, counter: 3, nodeId: 'node-b' });
    expect(compareHlc(t2, t3)).toBeLessThan(0);
    expect(formatHlc(parseHlc(t3))).toBe(t3);

    // Per-column CRDT conflict resolution:
    // -STOCK: 'pn-counter' (additive deltas: base 100, local -5 = 95, remote +20 = 120 -> merged 115)
    // -TAGS: 'set-union' (JSON array 2P/OR-Set: base ['sale','featured'], local adds 'clearance', remote removes 'sale' & adds 'popular' -> ['featured','clearance','popular'])
    // -HIGH_BID: 'max' (local 240 vs remote 310 -> 310)
    // -LOW_ASK: 'min' (local 180 vs remote 195 -> 180)
    // -TITLE: 'lww' (remote HLC t3 > local HLC t2 -> remote wins)
    const merged = mergeCrdtRow(
      {
        incoming: {
          lsn: 5,
          txid: 'tx-b',
          origin: 'node-b',
          publication: 'pub',
          table: 'LISTINGS',
          operation: 'UPDATE',
          key: { ID: 1 },
          before: {
            ID: 1,
            TITLE: 'Original Title',
            STOCK: 100,
            TAGS: JSON.stringify(['sale', 'featured']),
            HIGH_BID: 200,
            LOW_ASK: 200,
          },
          after: {
            ID: 1,
            TITLE: 'Remote Title',
            STOCK: 120,
            TAGS: JSON.stringify(['featured', 'popular']),
            HIGH_BID: 310,
            LOW_ASK: 195,
          },
          timestamp: 1_000,
          hlc: t3,
        },
        localRow: {
          ID: 1,
          TITLE: 'Local Title',
          STOCK: 95,
          TAGS: JSON.stringify(['sale', 'featured', 'clearance']),
          HIGH_BID: 240,
          LOW_ASK: 180,
        },
        localEntry: {
          lsn: 4,
          txid: 'tx-a',
          origin: 'node-a',
          publication: 'pub',
          table: 'LISTINGS',
          operation: 'UPDATE',
          key: { ID: 1 },
          before: {
            ID: 1,
            TITLE: 'Original Title',
            STOCK: 100,
            TAGS: JSON.stringify(['sale', 'featured']),
            HIGH_BID: 200,
            LOW_ASK: 200,
          },
          after: {
            ID: 1,
            TITLE: 'Local Title',
            STOCK: 95,
            TAGS: JSON.stringify(['sale', 'featured', 'clearance']),
            HIGH_BID: 240,
            LOW_ASK: 180,
          },
          timestamp: 1_000,
          hlc: t2,
        },
      },
      {
        columns: {
          STOCK: 'pn-counter',
          TAGS: 'set-union',
          HIGH_BID: 'max',
          LOW_ASK: 'min',
          TITLE: 'lww',
        },
      },
    );

    expect(merged).toEqual({
      ID: 1,
      TITLE: 'Remote Title',
      STOCK: 115,
      TAGS: JSON.stringify(['featured', 'clearance', 'popular']),
      HIGH_BID: 310,
      LOW_ASK: 180,
    });

    // End-to-end bidirectional replication using createCrdtConflictResolver
    const nodeA = createMockReplDb();
    const nodeB = createMockReplDb();
    const replicator = await replicateDatabases({
      primary: nodeA,
      replica: nodeB,
      tables: [{ table: 'COUNTERS', primaryKey: 'ID' }],
      direction: 'bidirectional',
      onConflict: createCrdtConflictResolver({
        columns: { VIEWS: 'pn-counter', TAGS: 'g-set' },
      }),
    });

    await replicator.primaryPublication.recordDml({
      table: 'COUNTERS',
      operation: 'INSERT',
      after: { ID: 1, VIEWS: 10, TAGS: 'alpha' },
    });
    await replicator.sync();

    // Concurrent updates on nodeA (+7 views, 'beta' tag) and nodeB (+12 views, 'gamma' tag)
    await replicator.primaryPublication.recordDml({
      table: 'COUNTERS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { VIEWS: 17, TAGS: 'alpha,beta' },
    });
    await replicator.replicaPublication!.recordDml({
      table: 'COUNTERS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { VIEWS: 22, TAGS: 'alpha,gamma' },
    });

    await replicator.sync();
    expect(nodeA.tables.get('COUNTERS')?.[0]?.VIEWS).toBe(29);
    expect(nodeB.tables.get('COUNTERS')?.[0]?.VIEWS).toBe(29);
    expect(String(nodeA.tables.get('COUNTERS')?.[0]?.TAGS).split(',').sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('replicates over HTTP/SSE, BroadcastChannel, and duplex WebSocket transports', async () => {
    // 1. HTTP Handler & Client
    const serverDb = createMockReplDb();
    const clientDb = createMockReplDb();

    const serverPub = await createPublication(serverDb, {
      name: 'http_pub',
      nodeId: 'server-node',
      tables: [{ table: 'NOTES', primaryKey: 'ID' }],
    });
    await serverPub.recordDml({
      table: 'NOTES',
      operation: 'INSERT',
      after: { ID: 1, BODY: 'Hello from HTTP Primary' },
    });

    const handler = createHttpReplicationHandler({
      publication: serverPub,
      apiKey: 'secret-token',
    });

    const httpClient = createHttpReplicationClient({
      baseUrl: 'http://localhost/repl',
      name: 'http_pub',
      apiKey: 'secret-token',
      fetch: (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return handler(new Request(url, init));
      },
    });

    const clientSub = await createSubscription(clientDb, {
      name: 'http_sub',
      nodeId: 'browser-client-1',
      publication: httpClient,
    });

    const pullRes = await clientSub.pull();
    expect(pullRes.appliedCount).toBe(1);
    expect(clientDb.tables.get('NOTES')).toEqual([
      { ID: 1, BODY: 'Hello from HTTP Primary' },
    ]);

    // Acknowledge slot and push a client change back to server
    const slotAck = await httpClient.ackSlot('slot_http_client', pullRes.currentLsn, {
      nodeId: 'browser-client-1',
    });
    expect(slotAck.confirmedFlushLsn).toBe(1);

    await httpClient.pushChanges([
      {
        lsn: 1,
        txid: 'client-tx-1',
        origin: 'browser-client-1',
        publication: 'http_pub',
        table: 'NOTES',
        operation: 'INSERT',
        key: { ID: 2 },
        after: { ID: 2, BODY: 'Pushed from Browser' },
        before: null,
        timestamp: Date.now(),
      },
    ]);
    expect(serverDb.tables.get('NOTES')).toHaveLength(2);

    // 2. BroadcastChannel cross-tab transport
    const tabADb = createMockReplDb();
    const tabBDb = createMockReplDb();
    const tabAPub = await createPublication(tabADb, {
      name: 'tab_pub',
      nodeId: 'tab-a',
      tables: [{ table: 'TABS', primaryKey: 'ID' }],
    });
    const tabBSub = await createSubscription(tabBDb, {
      name: 'tab_sub',
      nodeId: 'tab-b',
      publication: tabAPub,
    });

    const bcA = createBroadcastChannelTransport({
      channelName: 'test_fb_repl_tabs',
      publication: tabAPub,
    });
    const bcB = createBroadcastChannelTransport({
      channelName: 'test_fb_repl_tabs',
      subscription: tabBSub,
    });

    await tabAPub.recordDml({
      table: 'TABS',
      operation: 'INSERT',
      after: { ID: 10, TITLE: 'Synced via BroadcastChannel' },
    });
    await bcA.sync();
    // Allow microtask queue to settle
    await new Promise((r) => setTimeout(r, 15));
    expect(tabBDb.tables.get('TABS')).toEqual([
      { ID: 10, TITLE: 'Synced via BroadcastChannel' },
    ]);
    bcA.close();
    bcB.close();

    // 3. Duplex WebSocket peer transport
    const wsPrimaryDb = createMockReplDb();
    const wsReplicaDb = createMockReplDb();
    const wsPub = await createPublication(wsPrimaryDb, {
      name: 'ws_pub',
      nodeId: 'ws-primary',
      tables: [{ table: 'EVENTS', primaryKey: 'ID' }],
    });
    const wsSub = await createSubscription(wsReplicaDb, {
      name: 'ws_sub',
      nodeId: 'ws-replica',
      publication: wsPub,
    });

    // Linked in-memory WebSocket pair
    let onMessageA: ((ev: { data: unknown }) => void) | null = null;
    let onMessageB: ((ev: { data: unknown }) => void) | null = null;
    const sockA: WebSocketLike = {
      send(data) {
        onMessageB?.({ data });
      },
      addEventListener(_t, fn) {
        onMessageA = fn;
      },
      removeEventListener() {
        onMessageA = null;
      },
    };
    const sockB: WebSocketLike = {
      send(data) {
        onMessageA?.({ data });
      },
      addEventListener(_t, fn) {
        onMessageB = fn;
      },
      removeEventListener() {
        onMessageB = null;
      },
    };

    const peerA = createWebSocketReplicationPeer({
      socket: sockA,
      publication: wsPub,
    });
    const peerB = createWebSocketReplicationPeer({
      socket: sockB,
      subscription: wsSub,
    });

    await wsPub.recordDml({
      table: 'EVENTS',
      operation: 'INSERT',
      after: { ID: 77, KIND: 'ws_stream' },
    });
    await peerB.requestPull(0);
    await new Promise((r) => setTimeout(r, 15));
    expect(wsReplicaDb.tables.get('EVENTS')).toEqual([{ ID: 77, KIND: 'ws_stream' }]);
    peerA.close();
    peerB.close();
  });

  it('encodes/decodes Firebird 4/5 native binary journal segments, maintains indexHooks, and reports replicator.stats()', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    const indexedDocs = new Map<number, string>();

    const replicator = await replicateDatabases({
      primary,
      replica,
      tables: [{ table: 'DOCS', primaryKey: 'ID' }],
      indexHooks: [
        {
          table: 'DOCS',
          onInsertOrUpdate(row, key) {
            indexedDocs.set(Number(key.ID), String(row.CONTENT ?? ''));
          },
          onDelete(key) {
            indexedDocs.delete(Number(key.ID));
          },
        },
      ],
    });

    await replicator.primaryPublication.recordDml({
      table: 'DOCS',
      operation: 'INSERT',
      after: { ID: 1, CONTENT: 'Firebird 5 vector search' },
    });
    await replicator.primaryPublication.recordDml({
      table: 'DOCS',
      operation: 'INSERT',
      after: { ID: 2, CONTENT: 'Hybrid logical clocks' },
    });

    // Check lag telemetry before sync()
    const statsBefore = await replicator.stats();
    expect(statsBefore.primaryLsn).toBe(2);
    expect(statsBefore.replicaWatermark).toBe(0);
    expect(statsBefore.lagEntries).toBe(2);

    await replicator.sync();

    const statsAfter = await replicator.stats();
    expect(statsAfter.lagEntries).toBe(0);
    expect(statsAfter.replicaWatermark).toBe(2);
    expect(statsAfter.totalFetched).toBe(2);
    expect(statsAfter.totalApplied).toBe(2);
    expect(statsAfter.bytesTransferred).toBeGreaterThan(0);
    expect(indexedDocs.get(1)).toBe('Firebird 5 vector search');
    expect(indexedDocs.get(2)).toBe('Hybrid logical clocks');

    // Delete doc 1 and verify indexHook.onDelete fires on replica
    await replicator.primaryPublication.recordDml({
      table: 'DOCS',
      operation: 'DELETE',
      key: { ID: 1 },
    });
    await replicator.sync();
    expect(indexedDocs.has(1)).toBe(false);

    // Encode and decode Firebird 4/5 native binary journal segment
    const entries = await replicator.primaryPublication.fetchChangesSince(0);
    const segmentBytes = encodeNativeJournalSegment(entries, {
      guid: 'a1b2c3d4-e5f6-4789-8012-3456789abcde',
      sequence: 9,
      state: 'archivable',
    });

    const decoded = decodeNativeJournalSegment(segmentBytes);
    expect(decoded.header.magic).toBe(NATIVE_REPL_SEGMENT_MAGIC);
    expect(decoded.header.version).toBe(NATIVE_REPL_PROTOCOL_VERSION);
    expect(decoded.header.state).toBe('archivable');
    expect(decoded.header.guid).toBe('a1b2c3d4-e5f6-4789-8012-3456789abcde');
    expect(decoded.header.sequence).toBe(9);
    expect(decoded.header.startLsn).toBe(1);
    expect(decoded.header.endLsn).toBe(3);
    expect(decoded.header.entryCount).toBe(3);
    expect(decoded.entries).toEqual(entries);

    // Tampering with payload triggers checksum verification error
    const corrupted = new Uint8Array(segmentBytes);
    corrupted[corrupted.byteLength - 1]! ^= 0xff;
    expect(() => decodeNativeJournalSegment(corrupted)).toThrow(/checksum mismatch/i);
  });

  it('promotes a replica to primary via promoteReplica() with lag guards, sequence buffer, and peer re-routing', async () => {
    const oldPrimary = createMockReplDb();
    const replica1 = createMockReplDb();
    const replica2 = createMockReplDb();

    oldPrimary.tables.set('ORDERS', [{ ID: 1, ITEM: 'Keyboard' }]);
    replica1.tables.set('ORDERS', [{ ID: 1, ITEM: 'Keyboard' }]);
    replica2.tables.set('ORDERS', [{ ID: 1, ITEM: 'Keyboard' }]);

    const oldPub = await createPublication(oldPrimary, {
      name: 'pub_orders',
      nodeId: 'primary-1',
      tables: [{ table: 'ORDERS', primaryKey: 'ID' }],
    });
    // Record baseline and one new insert on oldPrimary
    await oldPub.captureTableChanges();
    await oldPrimary.execute?.(
      'INSERT INTO ORDERS (ID, ITEM) VALUES (?, ?)',
      [2, 'Monitor'],
    );
    await oldPub.captureTableChanges();

    const sub1 = await createSubscription(replica1, {
      name: 'sub_r1',
      nodeId: 'replica-1',
      publication: oldPub,
    });
    const sub2 = await createSubscription(replica2, {
      name: 'sub_r2',
      nodeId: 'replica-2',
      publication: oldPub,
    });
    await sub2.pull();

    // Promoting replica1 delivers final pending changes from oldPub, sets FB_REPL_ROLE='PRIMARY',
    // installs triggers, primes baseline mirror, and updates peerSubscriptions watermarks
    const promoted = await promoteReplica({
      replicaDb: replica1,
      subscription: sub1,
      maxAllowedLagEntries: 0,
      promotedNodeId: 'primary-2',
      publicationName: 'pub_orders_v2',
      tables: [{ table: 'ORDERS', primaryKey: 'ID', columns: ['ID', 'ITEM'] }],
      installTriggers: true,
      peerSubscriptions: [sub2],
    });

    expect(promoted.promotedNodeId).toBe('primary-2');
    expect(promoted.finalPullResult?.appliedCount).toBe(2);
    expect(promoted.publishedTables).toEqual(['ORDERS']);
    expect(promoted.triggersInstalled).toBe(1);
    expect(promoted.roleContextCleared).toBe(true);
    expect(replica1.tables.get('ORDERS')).toEqual([
      { ID: 1, ITEM: 'Keyboard' },
      { ID: 2, ITEM: 'Monitor' },
    ]);

    // Now write a new row on the newly promoted primary (replica1) and replicate to replica2
    await replica1.execute?.(
      'INSERT INTO ORDERS (ID, ITEM) VALUES (?, ?)',
      [3, 'Mouse'],
    );
    await promoted.publication.captureTableChanges();

    const sub2OnNewPrimary = await createSubscription(replica2, {
      name: 'sub_r2',
      nodeId: 'replica-2',
      publication: promoted.publication,
    });
    const pullRes = await sub2OnNewPrimary.pull();
    expect(pullRes.appliedCount).toBe(1);
    expect(replica2.tables.get('ORDERS')).toEqual([
      { ID: 1, ITEM: 'Keyboard' },
      { ID: 2, ITEM: 'Monitor' },
      { ID: 3, ITEM: 'Mouse' },
    ]);
  });

  it('compresses and encrypts replication journal segments with Gzip and WebCrypto AES-256-GCM', async () => {
    const entries = Array.from({ length: 10 }, (_, idx) => ({
      lsn: idx + 1,
      txid: `tx-${idx + 1}`,
      origin: 'node-primary',
      publication: 'pub_main',
      table: 'CUSTOMER_EVENTS',
      operation: 'INSERT' as const,
      key: { ID: idx + 1 },
      after: {
        ID: idx + 1,
        PAYLOAD: 'repeated-compressible-event-payload-string-for-gzip-testing',
      },
      before: null,
      ddlSql: null,
      timestamp: 1700000000000 + idx,
    }));

    // 1. Raw 32-byte AES-256-GCM key + Gzip compression + AAD
    const rawKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) rawKey[i] = (i * 7 + 3) & 0xff;

    const encryptedBytes = await encodeEncryptedJournalSegment(entries, {
      key: rawKey,
      compress: true,
      aad: 'cluster-prod-eu',
      sequence: 42,
      state: 'full',
    });

    const magic = new DataView(
      encryptedBytes.buffer,
      encryptedBytes.byteOffset,
      4,
    ).getUint32(0, true);
    expect(magic).toBe(NATIVE_REPL_ENCRYPTED_SEGMENT_MAGIC);

    const decoded = await decodeEncryptedJournalSegment(encryptedBytes, {
      key: rawKey,
      aad: 'cluster-prod-eu',
    });
    expect(decoded.compressed).toBe(true);
    expect(decoded.encrypted).toBe(true);
    expect(decoded.wireBytes).toBeLessThan(decoded.uncompressedBytes);
    expect(decoded.segment.header.sequence).toBe(42);
    expect(decoded.segment.header.state).toBe('full');
    expect(decoded.segment.entries).toEqual(entries);

    // Wrong key or wrong AAD fails authentication tag check
    await expect(
      decodeEncryptedJournalSegment(encryptedBytes, {
        key: new Uint8Array(32),
        aad: 'cluster-prod-eu',
      }),
    ).rejects.toThrow(/Failed to decrypt/i);

    await expect(
      decodeEncryptedJournalSegment(encryptedBytes, {
        key: rawKey,
        aad: 'wrong-cluster-aad',
      }),
    ).rejects.toThrow(/Failed to decrypt/i);

    // 2. Passphrase-derived key (PBKDF2-HMAC-SHA256)
    const passBytes = await encodeEncryptedJournalSegment(entries.slice(0, 2), {
      key: 'correct-horse-battery-staple',
      compress: true,
    });
    const passDecoded = await decodeEncryptedJournalSegment(passBytes, {
      key: 'correct-horse-battery-staple',
    });
    expect(passDecoded.encrypted).toBe(true);
    expect(passDecoded.compressed).toBe(true);
    expect(passDecoded.segment.entries).toEqual(entries.slice(0, 2));
  });

  it('supports time-travel point-in-time querying (asOfLsn) and database rollback (rewindToLsn)', async () => {
    const db = createMockReplDb();
    db.tables.set('ACCOUNTS', []);

    const pub = await createPublication(db, {
      name: 'pub_bank',
      nodeId: 'bank-primary',
      tables: [{ table: 'ACCOUNTS', primaryKey: 'ID' }],
    });

    // LSN 1: Insert Alice ($100)
    await db.execute?.(
      'INSERT INTO ACCOUNTS (ID, OWNER, BALANCE) VALUES (?, ?, ?)',
      [1, 'Alice', 100],
    );
    await pub.captureTableChanges({ timestamp: 1000 });

    // LSN 2: Insert Bob ($250)
    await db.execute?.(
      'INSERT INTO ACCOUNTS (ID, OWNER, BALANCE) VALUES (?, ?, ?)',
      [2, 'Bob', 250],
    );
    await pub.captureTableChanges({ timestamp: 2000 });

    // LSN 3: Update Alice ($100 -> $175)
    await db.execute?.(
      'UPDATE ACCOUNTS SET BALANCE = ? WHERE ID = ?',
      [175, 1],
    );
    await pub.captureTableChanges({ timestamp: 3000 });

    // LSN 4: Delete Bob
    await db.execute?.('DELETE FROM ACCOUNTS WHERE ID = ?', [2]);
    await pub.captureTableChanges({ timestamp: 4000 });

    // Live table at LSN 4 only has Alice ($175)
    expect(db.tables.get('ACCOUNTS')).toEqual([
      { ID: 1, OWNER: 'Alice', BALANCE: 175 },
    ]);

    // Time-travel query as of LSN 1
    const snap1 = await asOfLsn(db, 1);
    expect(snap1.targetLsn).toBe(1);
    expect(snap1.currentLsn).toBe(4);
    expect(snap1.tables.ACCOUNTS).toEqual([
      { ID: 1, OWNER: 'Alice', BALANCE: 100 },
    ]);

    // Time-travel query as of LSN 2 (or timestamp 2000)
    const snap2 = await asOfLsn(db, { timestamp: 2000 });
    expect(snap2.targetLsn).toBe(2);
    expect(snap2.tables.ACCOUNTS).toEqual([
      { ID: 1, OWNER: 'Alice', BALANCE: 100 },
      { ID: 2, OWNER: 'Bob', BALANCE: 250 },
    ]);

    // Time-travel query as of LSN 3
    const snap3 = await asOfLsn(db, 3);
    expect(snap3.tables.ACCOUNTS).toEqual([
      { ID: 1, OWNER: 'Alice', BALANCE: 175 },
      { ID: 2, OWNER: 'Bob', BALANCE: 250 },
    ]);

    // Rewind live database back to LSN 2 (undoes LSN 4 DELETE of Bob and LSN 3 UPDATE of Alice)
    const rewindRes = await rewindToLsn(db, 2);
    expect(rewindRes.previousHeadLsn).toBe(4);
    expect(rewindRes.rewoundToLsn).toBe(2);
    expect(rewindRes.entriesUndone).toBe(2);
    expect(rewindRes.journalEntriesRemoved).toBe(2);
    expect(rewindRes.tablesAffected).toEqual(['ACCOUNTS']);

    // Live table is now restored to its exact LSN 2 state!
    const liveRows = [...(db.tables.get('ACCOUNTS') ?? [])].sort(
      (a, b) => Number(a.ID) - Number(b.ID),
    );
    expect(liveRows).toEqual([
      { ID: 1, OWNER: 'Alice', BALANCE: 100 },
      { ID: 2, OWNER: 'Bob', BALANCE: 250 },
    ]);
    const remainingEntries = await pub.fetchChangesSince(0);
    expect(remainingEntries.map((e) => e.lsn)).toEqual([1, 2]);
  });

  it('coordinates multi-node mesh and hub-and-spoke topologies with transitive routing and quorum pruning', async () => {
    // 1. 3-node Hub-and-Spoke topology: spoke-a <-> hub <-> spoke-b
    const hubDb = createMockReplDb();
    const spokeADb = createMockReplDb();
    const spokeBDb = createMockReplDb();

    hubDb.tables.set('TASKS', []);
    spokeADb.tables.set('TASKS', []);
    spokeBDb.tables.set('TASKS', []);

    const hubCoord = await createReplicationHub({
      hubNodeId: 'hub',
      nodes: [
        { nodeId: 'hub', db: hubDb },
        { nodeId: 'spoke-a', db: spokeADb },
        { nodeId: 'spoke-b', db: spokeBDb },
      ],
      tables: [{ table: 'TASKS', primaryKey: 'ID' }],
    });

    // Insert on spoke-a -> routes spoke-a -> hub -> spoke-b in a single sync()
    const pubSpokeA = hubCoord.publications.get('spoke-a')!;
    await pubSpokeA.recordDml({
      table: 'TASKS',
      operation: 'INSERT',
      after: { ID: 1, TITLE: 'Created on Spoke A', DONE: 0 },
    });

    // Insert on spoke-b -> routes spoke-b -> hub -> spoke-a
    const pubSpokeB = hubCoord.publications.get('spoke-b')!;
    await pubSpokeB.recordDml({
      table: 'TASKS',
      operation: 'INSERT',
      after: { ID: 2, TITLE: 'Created on Spoke B', DONE: 1 },
    });

    const syncRes = await hubCoord.sync();
    expect(syncRes.totalApplied).toBeGreaterThanOrEqual(4);

    const sortById = (rows: Row[] = []) =>
      [...rows].sort((a, b) => Number(a.ID) - Number(b.ID));

    expect(sortById(hubDb.tables.get('TASKS'))).toEqual([
      { ID: 1, TITLE: 'Created on Spoke A', DONE: 0 },
      { ID: 2, TITLE: 'Created on Spoke B', DONE: 1 },
    ]);
    expect(sortById(spokeADb.tables.get('TASKS'))).toEqual([
      { ID: 1, TITLE: 'Created on Spoke A', DONE: 0 },
      { ID: 2, TITLE: 'Created on Spoke B', DONE: 1 },
    ]);
    expect(sortById(spokeBDb.tables.get('TASKS'))).toEqual([
      { ID: 1, TITLE: 'Created on Spoke A', DONE: 0 },
      { ID: 2, TITLE: 'Created on Spoke B', DONE: 1 },
    ]);

    const matrix = await hubCoord.watermarkMatrix();
    expect(matrix['spoke-a']?.['hub']).toBeGreaterThan(0);
    expect(matrix['spoke-b']?.['hub']).toBeGreaterThan(0);

    // Quorum pruning across all nodes
    const pruned = await hubCoord.pruneQuorum();
    expect(pruned['hub']).toBeGreaterThanOrEqual(2);
    expect(pruned['spoke-a']).toBe(1);
    expect(pruned['spoke-b']).toBe(1);

    // 2. 3-node full Mesh topology with CRDT conflict resolution
    const mesh1 = createMockReplDb();
    const mesh2 = createMockReplDb();
    const mesh3 = createMockReplDb();

    const mesh = await createReplicationMesh({
      topology: 'mesh',
      nodes: [
        { nodeId: 'n1', db: mesh1 },
        { nodeId: 'n2', db: mesh2 },
        { nodeId: 'n3', db: mesh3 },
      ],
      tables: [{ table: 'METRICS', primaryKey: 'ID' }],
      onConflict: createCrdtConflictResolver({
        columns: { HITS: 'pn-counter' },
      }),
    });

    await mesh.publications.get('n1')!.recordDml({
      table: 'METRICS',
      operation: 'INSERT',
      after: { ID: 1, HITS: 10 },
    });
    await mesh.sync();

    expect(mesh2.tables.get('METRICS')).toEqual([{ ID: 1, HITS: 10 }]);
    expect(mesh3.tables.get('METRICS')).toEqual([{ ID: 1, HITS: 10 }]);
  });

  it('quarantines poison entries into FB_REPL_DLQ$ and supports retryDlq() and discardDlq()', async () => {
    const primary = createMockReplDb();
    const replica = createMockReplDb();

    const pub = await createPublication(primary, {
      name: 'pub_orders',
      nodeId: 'primary-1',
      tables: [{ table: 'ORDERS', primaryKey: 'ID' }],
    });

    // Valid order #1, poison order #2 (negative total), valid order #3
    await pub.recordDml({
      table: 'ORDERS',
      operation: 'INSERT',
      after: { ID: 1, CUSTOMER: 'Alice', TOTAL: 50 },
    });
    await pub.recordDml({
      table: 'ORDERS',
      operation: 'INSERT',
      after: { ID: 2, CUSTOMER: 'Mallory', TOTAL: -999 },
    });
    await pub.recordDml({
      table: 'ORDERS',
      operation: 'INSERT',
      after: { ID: 3, CUSTOMER: 'Bob', TOTAL: 120 },
    });

    const sub = await createSubscription(replica, {
      name: 'sub_orders',
      nodeId: 'replica-1',
      publication: pub,
      onApplyError: 'dlq',
      validateEntry(entry) {
        if (entry.after && Number(entry.after.TOTAL ?? 0) < 0) {
          throw new Error('CHECK constraint violation: TOTAL must be non-negative');
        }
      },
    });

    // Pull batch: order #1 and #3 apply cleanly; order #2 is quarantined in FB_REPL_DLQ$
    const pullRes = await sub.pull();
    expect(pullRes.fetchedCount).toBe(3);
    expect(pullRes.appliedCount).toBe(2);
    expect(pullRes.dlqCount).toBe(1);
    expect(pullRes.currentLsn).toBe(3);

    expect(replica.tables.get('ORDERS')).toEqual([
      { ID: 1, CUSTOMER: 'Alice', TOTAL: 50 },
      { ID: 3, CUSTOMER: 'Bob', TOTAL: 120 },
    ]);

    const dlqItems = await sub.listDlq!();
    expect(dlqItems).toHaveLength(1);
    expect(dlqItems[0]!.lsn).toBe(2);
    expect(dlqItems[0]!.errorMessage).toMatch(/TOTAL must be non-negative/);
    expect(dlqItems[0]!.attempts).toBe(1);

    // Retry without transform still fails validation and increments attempts
    const failedRetry = await sub.retryDlq!();
    expect(failedRetry.retried).toBe(1);
    expect(failedRetry.succeeded).toBe(0);
    expect(failedRetry.failed).toBe(1);
    expect((await sub.listDlq!())[0]!.attempts).toBe(2);

    // Retry with transformEntry sanitizing negative TOTAL -> applies row and clears DLQ
    const fixedRetry = await sub.retryDlq!({
      transformEntry(entry) {
        return {
          ...entry,
          after: { ...entry.after, TOTAL: Math.abs(Number(entry.after?.TOTAL ?? 0)) },
        };
      },
    });
    expect(fixedRetry.succeeded).toBe(1);
    expect(await sub.listDlq!()).toHaveLength(0);

    const allOrders = [...(replica.tables.get('ORDERS') ?? [])].sort(
      (a, b) => Number(a.ID) - Number(b.ID),
    );
    expect(allOrders).toEqual([
      { ID: 1, CUSTOMER: 'Alice', TOTAL: 50 },
      { ID: 2, CUSTOMER: 'Mallory', TOTAL: 999 },
      { ID: 3, CUSTOMER: 'Bob', TOTAL: 120 },
    ]);

    // Direct DLQ manager test for discardDlq()
    const dlq = await createReplicationDlq(replica);
    await dlq.enqueue({
      subscriptionName: 'sub_orders',
      entry: {
        lsn: 99,
        txid: 'tx-99',
        origin: 'primary-1',
        publication: 'pub_orders',
        table: 'ORDERS',
        operation: 'INSERT',
        key: { ID: 99 },
        after: { ID: 99, TOTAL: -1 },
        before: null,
        timestamp: Date.now(),
      },
      errorMessage: 'manual test error',
    });
    expect(await dlq.list('sub_orders')).toHaveLength(1);
    const discarded = await sub.discardDlq!();
    expect(discarded).toBe(1);
    expect(await dlq.list('sub_orders')).toHaveLength(0);
  });

  it('masks PII and transforms rows on outbound publications and inbound subscriptions', async () => {
    const primary = createMockReplDb();
    const analyticsReplica = createMockReplDb();

    const piiMasker = createPiiMaskingTransformer(
      {
        EMAIL: 'email-mask',
        CARD_NUMBER: 'card-last4',
        SSN: 'redact',
        PHONE: 'hash-sha256',
        SECRET_TOKEN: 'null',
        INTERNAL_SCORE: (val) => Number(val ?? 0) * 10,
      },
      { salt: 'tenant-salt-2026' },
    );

    const pub = await createPublication(primary, {
      name: 'pub_users',
      nodeId: 'prod-primary',
      tables: [{ table: 'CUSTOMERS', primaryKey: 'ID' }],
      transformRow: piiMasker,
    });

    await pub.recordDml({
      table: 'CUSTOMERS',
      operation: 'INSERT',
      after: {
        ID: 1,
        NAME: 'Jane Doe',
        EMAIL: 'jane.doe@example.com',
        CARD_NUMBER: '4111-2222-3333-4444',
        SSN: '123-45-6789',
        PHONE: '+1-555-0199',
        SECRET_TOKEN: 'tok_live_secret',
        INTERNAL_SCORE: 7,
      },
    });

    const sub = await createSubscription(analyticsReplica, {
      name: 'sub_analytics',
      nodeId: 'analytics-replica',
      publication: pub,
      // Inbound enrichment transformer adds a derived column
      transformRow(row) {
        return { ...row, ANONYMIZED: 1 };
      },
    });

    await sub.pull();

    const rows = analyticsReplica.tables.get('CUSTOMERS') ?? [];
    expect(rows).toHaveLength(1);
    const synced = rows[0]!;
    expect(synced.ID).toBe(1);
    expect(synced.NAME).toBe('Jane Doe');
    expect(synced.EMAIL).toBe('j***e@example.com');
    expect(synced.CARD_NUMBER).toBe('************4444');
    expect(synced.SSN).toBe('[REDACTED]');
    expect(String(synced.PHONE)).toMatch(/^[0-9a-f]{64}$/);
    expect(synced.SECRET_TOKEN).toBeNull();
    expect(synced.INTERNAL_SCORE).toBe(70);
    expect(synced.ANONYMIZED).toBe(1);
  });

  it('exports and applies encrypted PITR journal archives to restore a database to a target LSN', async () => {
    const primary = createMockReplDb();
    primary.tables.set('LEDGER', [
      { ID: 1, ACCOUNT: 'Operating', BALANCE: 1000 },
    ]);

    const pub = await createPublication(primary, {
      name: 'pub_ledger',
      nodeId: 'ledger-primary',
      tables: [{ table: 'LEDGER', primaryKey: 'ID' }],
    });

    // Record baseline for row 1, then 4 journaled mutations (LSNs 1..4)
    await pub.captureTableChanges({ timestamp: 1000 }); // LSN 1: INSERT ID=1 (1000)

    await primary.execute?.(
      'INSERT INTO LEDGER (ID, ACCOUNT, BALANCE) VALUES (?, ?, ?)',
      [2, 'Payroll', 500],
    );
    await pub.captureTableChanges({ timestamp: 2000 }); // LSN 2: INSERT ID=2 (500)

    await primary.execute?.(
      'UPDATE LEDGER SET BALANCE = ? WHERE ID = ?',
      [850, 1],
    );
    await pub.captureTableChanges({ timestamp: 3000 }); // LSN 3: UPDATE ID=1 (850)

    await primary.execute?.(
      'UPDATE LEDGER SET BALANCE = ? WHERE ID = ?',
      [0, 2],
    );
    await pub.captureTableChanges({ timestamp: 4000 }); // LSN 4: UPDATE ID=2 (0)

    // Export an encrypted, Gzip-compressed multi-segment PITR archive (2 entries per segment)
    const archive = await exportJournalArchive(pub, {
      maxEntriesPerSegment: 2,
      compress: true,
      key: 'pitr-archive-passphrase',
      aad: 'ledger-prod',
      includeBaseSnapshot: false,
    });

    expect(archive.format).toBe('firebird-repl-archive-v1');
    expect(archive.startLsn).toBe(1);
    expect(archive.endLsn).toBe(4);
    expect(archive.entryCount).toBe(4);
    expect(archive.segments).toHaveLength(2);
    expect(archive.segments[0]!.encrypted).toBe(true);
    expect(archive.segments[0]!.compressed).toBe(true);

    // Restore into a fresh disaster-recovery database stopping at PITR LSN 3 (before Payroll was zeroed out at LSN 4)
    const restoredDb = createMockReplDb();
    restoredDb.tables.set('LEDGER', []);

    const restoreRes = await applyJournalArchive(restoredDb, archive, {
      key: 'pitr-archive-passphrase',
      aad: 'ledger-prod',
      target: { lsn: 3 },
    });

    expect(restoreRes.segmentsDecoded).toBe(2);
    expect(restoreRes.entriesApplied).toBe(3);
    expect(restoreRes.restoredToLsn).toBe(3);

    const restoredRows = [...(restoredDb.tables.get('LEDGER') ?? [])].sort(
      (a, b) => Number(a.ID) - Number(b.ID),
    );
    expect(restoredRows).toEqual([
      { ID: 1, ACCOUNT: 'Operating', BALANCE: 850 },
      { ID: 2, ACCOUNT: 'Payroll', BALANCE: 500 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Regressions found running replication against the real Firebird engine
// (FBSimCity machine room, Firebird 6.0 WASM). The in-memory mock above
// accepts SQL the engine rejects, so these pin the engine-facing behaviour.
// ---------------------------------------------------------------------------

describe('firebird-wasm/replication - real-engine regressions', () => {
  it('quotes the PUBLICATION column, a reserved word since Firebird 4.0', async () => {
    const db = createMockReplDb();
    const seen: string[] = [];
    const origExec = db.exec!.bind(db);
    const origQuery = db.query.bind(db);
    db.exec = async (sql: string, params?: QueryParams) => {
      seen.push(sql);
      return origExec(sql, params);
    };
    db.query = (async (sql: string, params?: QueryParams) => {
      seen.push(sql);
      return origQuery(sql, params);
    }) as typeof db.query;

    const pub = await createPublication(db, {
      name: 'pub_q',
      nodeId: 'n1',
      tables: [{ table: 'ITEMS', primaryKey: 'ID' }],
    });
    await pub.recordDml({ table: 'ITEMS', operation: 'INSERT', after: { ID: 1 }, applyLocally: false });
    await pub.registerSlot('slot_q');
    await pub.minRetainedLsn();

    const touchingPublication = seen.filter((s) => /PUBLICATION/i.test(s) && /FB_REPL_/i.test(s));
    expect(touchingPublication.length).toBeGreaterThan(0);
    for (const sql of touchingPublication) {
      // every SQL occurrence of the column is double-quoted
      expect(sql).not.toMatch(/(^|[^"\w$])PUBLICATION(?![\w$"])/);
    }
    const { ddl } = buildReplicationTriggerDdl({
      table: 'ITEMS', primaryKey: ['ID'], columns: ['ID'], publication: 'pub_q', nodeId: 'n1',
    });
    expect(ddl).toContain('"PUBLICATION"');
  });

  it('installs PSQL trigger DDL through a transaction, not the script-splitting exec()', async () => {
    const db = createMockReplDb();
    db.tables.set('ITEMS', [{ ID: 1, NAME: 'a' }]);
    const topLevelTriggerExecs: string[] = [];
    const origExec = db.exec!.bind(db);
    db.exec = async (sql: string, params?: QueryParams) => {
      if (/CREATE\s+OR\s+ALTER\s+TRIGGER/i.test(sql)) topLevelTriggerExecs.push(sql);
      return origExec(sql, params);
    };
    let txCalls = 0;
    db.transaction = (async (fn: Parameters<NonNullable<typeof db.transaction>>[0]) => {
      txCalls++;
      // a transaction handle whose exec runs the statement verbatim
      return fn({
        query: origExec as never,
        exec: origExec,
      } as never);
    }) as typeof db.transaction;

    await installReplicationTriggers(db, { tables: [{ table: 'ITEMS', primaryKey: 'ID', columns: ['ID', 'NAME'] }] });
    expect(topLevelTriggerExecs).toEqual([]);
    expect(txCalls).toBe(1);
    expect(db.triggerDdlLog.length).toBe(1);
  });

  it('draws journal LSNs from FB_REPL_LSN_GEN$ once capture triggers are installed', async () => {
    const db = createMockReplDb();
    db.tables.set('ITEMS', [{ ID: 1, NAME: 'a' }]);
    let gen = 0;
    const origQuery = db.query.bind(db);
    db.query = (async (sql: string, params?: QueryParams) => {
      const next = /NEXT\s+VALUE\s+FOR/i.test(sql) && /RDB\$DATABASE/i.test(sql);
      if (next) return { rows: [{ NEXT_LSN: ++gen }] };
      const peek = /GEN_ID\(\s*"?FB_REPL_LSN_GEN\$"?\s*,\s*(-?\d+)\s*\)/i.exec(sql);
      if (peek) {
        gen += Number(peek[1]);
        return { rows: [{ CUR_LSN: gen, NEW_LSN: gen }] };
      }
      return origQuery(sql, params);
    }) as typeof db.query;

    // the sequence has already been advanced by triggers firing elsewhere
    gen = 40;
    const pub = await createPublication(db, {
      name: 'default',
      nodeId: 'n1',
      tables: [{ table: 'ITEMS', primaryKey: 'ID', columns: ['ID', 'NAME'] }],
      installTriggers: true,
    });
    const entry = await pub.recordDml({
      table: 'ITEMS', operation: 'INSERT', after: { ID: 2, NAME: 'b' }, applyLocally: false,
    });
    // in-memory counter would have said 1; the shared sequence says 41
    expect(entry.lsn).toBe(41);
    const next = await pub.recordDml({
      table: 'ITEMS', operation: 'INSERT', after: { ID: 3, NAME: 'c' }, applyLocally: false,
    });
    expect(next.lsn).toBe(42);
  });

  // -------------------------------------------------------------------------
  // M15 Item 1: High-Concurrency Multi-Node Mesh & DLQ Stress Suite
  // -------------------------------------------------------------------------
  it('converges a 4-node full-mesh cluster under concurrent multi-writer CRDT updates and DLQ quarantine/recovery (M15 Item 1)', async () => {
    const dbA = createMockReplDb();
    const dbB = createMockReplDb();
    const dbC = createMockReplDb();
    const dbD = createMockReplDb();

    for (const db of [dbA, dbB, dbC, dbD]) {
      db.tables.set('COUNTERS', []);
    }

    const crdtResolver = createCrdtConflictResolver({
      columns: { HITS: 'pn-counter', TAG: 'lww' },
    });

    let rejectPoisonOnD = true;
    const mesh = await createReplicationMesh({
      topology: 'full-mesh',
      tables: [{ table: 'COUNTERS', primaryKey: 'ID' }],
      onConflict: crdtResolver,
      nodes: [
        { nodeId: 'node_a', db: dbA },
        { nodeId: 'node_b', db: dbB },
        { nodeId: 'node_c', db: dbC },
        {
          nodeId: 'node_d',
          db: dbD,
          onApplyError: 'dlq',
          validateEntry: (entry) => {
            if (rejectPoisonOnD && entry.after?.TAG === 'POISON_ROW') {
              throw new Error('Poison row blocked on node_d');
            }
            return true;
          },
        },
      ],
    });

    const pubA = mesh.publications.get('node_a')!;
    const pubB = mesh.publications.get('node_b')!;
    const pubC = mesh.publications.get('node_c')!;

    // Seed initial counter row (ID=1, HITS=10) across all 4 nodes
    await pubA.recordDml({
      table: 'COUNTERS',
      operation: 'INSERT',
      key: { ID: 1 },
      after: { ID: 1, HITS: 10, TAG: 'init' },
      timestamp: 900,
    });
    await mesh.sync();

    // Concurrent counter increments on A (+5), B (+12), C (+8) from base 10 => net 10 + 5 + 12 + 8 = 35
    await pubA.recordDml({
      table: 'COUNTERS',
      operation: 'UPDATE',
      key: { ID: 1 },
      before: { ID: 1, HITS: 10, TAG: 'init' },
      after: { ID: 1, HITS: 15, TAG: 'from_a' },
      timestamp: 1000,
    });
    await pubB.recordDml({
      table: 'COUNTERS',
      operation: 'UPDATE',
      key: { ID: 1 },
      before: { ID: 1, HITS: 10, TAG: 'init' },
      after: { ID: 1, HITS: 22, TAG: 'from_b' },
      timestamp: 1010,
    });
    await pubC.recordDml({
      table: 'COUNTERS',
      operation: 'UPDATE',
      key: { ID: 1 },
      before: { ID: 1, HITS: 10, TAG: 'init' },
      after: { ID: 1, HITS: 18, TAG: 'from_c' },
      timestamp: 1020,
    });

    // Also insert a poison row on node A that node D quarantines in FB_REPL_DLQ$
    await pubA.recordDml({
      table: 'COUNTERS',
      operation: 'INSERT',
      key: { ID: 99 },
      after: { ID: 99, HITS: 1, TAG: 'POISON_ROW' },
      timestamp: 1030,
    });

    const syncRes = await mesh.sync();
    expect(syncRes.rounds).toBeGreaterThanOrEqual(1);
    expect(syncRes.totalApplied).toBeGreaterThan(0);

    // Nodes A, B, C have both ID=1 (converged HITS=35, TAG='from_c') and ID=99
    for (const db of [dbA, dbB, dbC]) {
      const row1 = db.tables.get('COUNTERS')!.find((r) => r.ID === 1);
      expect(row1?.HITS).toBe(35);
      expect(row1?.TAG).toBe('from_c');
      const row99 = db.tables.get('COUNTERS')!.find((r) => r.ID === 99);
      expect(row99?.TAG).toBe('POISON_ROW');
    }

    // Node D applied ID=1 (HITS=35) and quarantined ID=99 in FB_REPL_DLQ$
    const row1OnD = dbD.tables.get('COUNTERS')!.find((r) => r.ID === 1);
    expect(row1OnD?.HITS).toBe(35);
    expect(dbD.tables.get('COUNTERS')!.find((r) => r.ID === 99)).toBeUndefined();

    const dlqOnD = await createReplicationDlq(dbD);
    const quarantined = await dlqOnD.listEntries();
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
    expect(quarantined[0]?.errorMessage).toContain('Poison row blocked on node_d');

    // Clear the validation block and retry DLQ on node_d -> node_d converges on ID=99 too
    rejectPoisonOnD = false;
    const subDFromA = mesh.subscriptions.get('node_d<-node_a')!;
    const retryRes = await subDFromA.retryDlq({
      transformEntry: (e) => ({
        ...e,
        after: { ...(e.after ?? {}), TAG: 'SANITIZED_ROW' },
      }),
    });
    expect(retryRes.succeeded).toBe(1);
    const row99OnD = dbD.tables.get('COUNTERS')!.find((r) => r.ID === 99);
    expect(row99OnD?.TAG).toBe('SANITIZED_ROW');
  });

  // -------------------------------------------------------------------------
  // M15 Item 3: Journal Compaction & Automated PITR Retention Policy
  // -------------------------------------------------------------------------
  it('compacts superseded per-row mutations and rotates pruned entries into PITR archives (M15 Item 3)', async () => {
    const db = createMockReplDb();
    db.tables.set('ITEMS', []);

    const pub = await createPublication(db, {
      name: 'pub_compact',
      nodeId: 'node_1',
      tables: [{ table: 'ITEMS', primaryKey: 'ID' }],
    });

    // Row 1: INSERT + 3 UPDATEs -> compacts to a single INSERT at the latest LSN with final state
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'INSERT',
      key: { ID: 1 },
      after: { ID: 1, NAME: 'v1', QTY: 1 },
      timestamp: 1000,
    });
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { ID: 1, NAME: 'v2', QTY: 2 },
      timestamp: 1010,
    });
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { ID: 1, NAME: 'v3', QTY: 3 },
      timestamp: 1020,
    });
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { ID: 1, NAME: 'v4', QTY: 4 },
      timestamp: 1030,
    });

    // Row 2: INSERT + UPDATE + DELETE within the window -> elided completely
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'INSERT',
      key: { ID: 2 },
      after: { ID: 2, NAME: 'temp', QTY: 1 },
      timestamp: 1040,
    });
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'UPDATE',
      key: { ID: 2 },
      after: { ID: 2, NAME: 'temp2', QTY: 2 },
      timestamp: 1050,
    });
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'DELETE',
      key: { ID: 2 },
      timestamp: 1060,
    });

    // Row 3: untouched single INSERT
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'INSERT',
      key: { ID: 3 },
      after: { ID: 3, NAME: 'stable', QTY: 10 },
      timestamp: 1070,
    });

    const compactRes = await compactJournal(db, { publication: 'pub_compact' });
    expect(compactRes.entriesBefore).toBe(8);
    expect(compactRes.entriesAfter).toBe(2); // Row 1 net INSERT (LSN 4) + Row 3 INSERT (LSN 8)
    expect(compactRes.entriesRemoved).toBe(6);
    expect(compactRes.keysCompacted).toBe(2);

    const remaining = await pub.fetchChangesSince(0);
    expect(remaining).toHaveLength(2);
    expect(remaining[0]?.lsn).toBe(4);
    expect(remaining[0]?.operation).toBe('INSERT');
    expect(remaining[0]?.after).toEqual({ ID: 1, NAME: 'v4', QTY: 4 });
    expect(remaining[1]?.lsn).toBe(8);
    expect(remaining[1]?.after).toEqual({ ID: 3, NAME: 'stable', QTY: 10 });

    // A fresh replica pulling from the compacted journal converges to the exact table state
    const replicaDb = createMockReplDb();
    replicaDb.tables.set('ITEMS', []);
    const sub = await createSubscription(replicaDb, {
      publication: pub,
      name: 'sub_after_compact',
      nodeId: 'node_2',
    });
    await sub.pull();
    expect(replicaDb.tables.get('ITEMS')).toEqual([
      { ID: 1, NAME: 'v4', QTY: 4 },
      { ID: 3, NAME: 'stable', QTY: 10 },
    ]);

    // Now test applyRetentionPolicy with archiveBeforePrune: true
    await pub.recordDml({
      table: 'ITEMS',
      operation: 'UPDATE',
      key: { ID: 1 },
      after: { ID: 1, NAME: 'v5', QTY: 50 },
      timestamp: 2000,
    });
    const retentionRes = await applyRetentionPolicy(db, pub, {
      maxEntries: 1,
      archiveBeforePrune: true,
      ignoreSlotWatermarks: true,
    });
    expect(retentionRes.prunedEntries).toBe(2);
    expect(retentionRes.prunedUpToLsn).toBe(8);
    expect(retentionRes.archive).not.toBeNull();
    expect(retentionRes.archive?.totalEntries).toBe(2);
  });

  // -------------------------------------------------------------------------
  // M15 Item 4: Structured Replication Telemetry & Prometheus / OTel Export
  // -------------------------------------------------------------------------
  it('collects structured replication telemetry and exports Prometheus & OpenTelemetry metrics (M15 Item 4)', async () => {
    const primaryDb = createMockReplDb();
    const replicaDb = createMockReplDb();
    primaryDb.tables.set('ORDERS', []);
    replicaDb.tables.set('ORDERS', []);

    const pub = await createPublication(primaryDb, {
      name: 'orders_pub',
      nodeId: 'primary_1',
      tables: [{ table: 'ORDERS', primaryKey: 'ID' }],
    });
    await pub.registerSlot({ slotName: 'slot_rep_1', nodeId: 'replica_1' });

    const sub = await createSubscription(replicaDb, {
      publication: pub,
      name: 'orders_sub',
      nodeId: 'replica_1',
      slotName: 'slot_rep_1',
      onApplyError: 'dlq',
      validateEntry: (e) => {
        if (Number(e.after?.TOTAL ?? 0) < 0) {
          throw new Error('Negative order total');
        }
      },
    });

    await pub.recordDml({
      table: 'ORDERS',
      operation: 'INSERT',
      key: { ID: 1 },
      after: { ID: 1, TOTAL: 100 },
      timestamp: 1000,
    });
    await pub.recordDml({
      table: 'ORDERS',
      operation: 'INSERT',
      key: { ID: 2 },
      after: { ID: 2, TOTAL: -50 },
      timestamp: 1010,
    });

    const snapshots: unknown[] = [];
    const collector = createReplicationMetricsCollector({
      publication: pub,
      subscription: sub,
      onSnapshot: (s) => snapshots.push(s),
    });

    // Before pull: lagEntries = 2, dlqDepth = 0
    const beforeSnap = await collector.collect(1050);
    expect(beforeSnap.lagEntries).toBe(2);
    expect(beforeSnap.dlqDepth).toBe(0);
    expect(beforeSnap.journalDepth).toBe(2);
    expect(beforeSnap.activeSlots).toBe(1);

    // Pull: 1 applied, 1 quarantined in FB_REPL_DLQ$
    await sub.pull();

    const afterSnap = await collector.collect(2050);
    expect(afterSnap.lagEntries).toBe(0);
    expect(afterSnap.totalApplied).toBe(1);
    expect(afterSnap.dlqDepth).toBe(1);
    expect(afterSnap.throughputEntriesPerSec).toBeCloseTo(1.0, 2);
    expect(snapshots).toHaveLength(2);

    const promText = await collector.toPrometheus('fb_repl');
    expect(promText).toContain('fb_repl_primary_lsn{publication="orders_pub",subscription="orders_sub",node_id="replica_1"} 2');
    expect(promText).toContain('fb_repl_dlq_depth{publication="orders_pub",subscription="orders_sub",node_id="replica_1"} 1');
    expect(promText).toContain('fb_repl_applied_total{publication="orders_pub",subscription="orders_sub",node_id="replica_1"} 1');
    expect(formatPrometheusReplicationMetrics(collector.lastSnapshot()!, 'fb_repl')).toBe(promText);

    const otelMetrics = await collector.toOpenTelemetry();
    const dlqMetric = otelMetrics.find((m) => m.name === 'firebird.replication.dlq.depth');
    expect(dlqMetric?.value).toBe(1);
    expect(dlqMetric?.attributes.publication).toBe('orders_pub');
  });

  // -------------------------------------------------------------------------
  // M15 Item 5: Schema-Aware Replication & DDL Compatibility / Conflict Guard
  // -------------------------------------------------------------------------
  it('classifies DDL statements, guards additive-only / idempotent DDL replay, and checks catalog compatibility (M15 Item 5)', async () => {
    const createCls = classifyDdlStatement('CREATE TABLE "AUDIT_LOG" (ID INT NOT NULL PRIMARY KEY)');
    expect(createCls.category).toBe('create-table');
    expect(createCls.table).toBe('AUDIT_LOG');
    expect(createCls.isAdditive).toBe(true);
    expect(createCls.isDestructive).toBe(false);

    const addColCls = classifyDdlStatement('ALTER TABLE USERS ADD PHONE VARCHAR(32)');
    expect(addColCls.category).toBe('add-column');
    expect(addColCls.table).toBe('USERS');
    expect(addColCls.column).toBe('PHONE');
    expect(addColCls.isAdditive).toBe(true);

    const dropColCls = classifyDdlStatement('ALTER TABLE USERS DROP COLUMN LEGACY_FLAG');
    expect(dropColCls.category).toBe('drop-column');
    expect(dropColCls.isDestructive).toBe(true);

    // Duplicate column on replica is skipped idempotently
    const skipRes = resolveDdlConflict(
      'ALTER TABLE USERS ADD EMAIL VARCHAR(120)',
      ['ID', 'NAME', 'EMAIL'],
      { policy: 'idempotent' },
    );
    expect(skipRes.action).toBe('skip');

    // Destructive DDL under 'additive-only' is rejected
    const rejectRes = resolveDdlConflict(
      'ALTER TABLE USERS DROP COLUMN EMAIL',
      ['ID', 'NAME', 'EMAIL'],
      { policy: 'additive-only' },
    );
    expect(rejectRes.action).toBe('reject');

    // End-to-end subscription with ddlPolicy: 'additive-only' + onApplyError: 'dlq'
    const primaryDb = createMockReplDb();
    const replicaDb = createMockReplDb();
    primaryDb.tables.set('USERS', [{ ID: 1, NAME: 'Ada' }]);
    replicaDb.tables.set('USERS', [{ ID: 1, NAME: 'Ada', PHONE: null }]);

    const pub = await createPublication(primaryDb, {
      name: 'ddl_pub',
      nodeId: 'node_p',
      tables: [{ table: 'USERS', primaryKey: 'ID' }],
    });
    const sub = await createSubscription(replicaDb, {
      publication: pub,
      name: 'ddl_sub',
      nodeId: 'node_r',
      ddlPolicy: 'additive-only',
      onApplyError: 'dlq',
    });

    // 1. Additive DDL for column that already exists on replica -> skipped idempotently
    await pub.recordDdl('ALTER TABLE USERS ADD PHONE VARCHAR(32)');
    // 2. Additive DDL for new column -> applied on replica
    await pub.recordDdl('ALTER TABLE USERS ADD TIER VARCHAR(16)');
    // 3. Destructive DDL -> rejected by 'additive-only' and quarantined in FB_REPL_DLQ$
    await pub.recordDdl('DROP TABLE USERS');

    const pullRes = await sub.pull();
    expect(pullRes.appliedCount).toBe(1); // Only TIER was executed
    expect(pullRes.dlqCount).toBe(1); // DROP TABLE was quarantined
    expect(replicaDb.ddlLog).toContain('ALTER TABLE USERS ADD TIER VARCHAR(16)');
    expect(replicaDb.ddlLog).not.toContain('DROP TABLE USERS');

    // Catalog compatibility check between primaryDb and replicaDb
    primaryDb.tables.set('USERS', [{ ID: 1, NAME: 'Ada', NEW_SOURCE_COL: 'val' }]);
    const compatReport = await checkReplicationSchemaCompatibility({
      sourceDb: primaryDb,
      targetDb: replicaDb,
      tables: ['USERS'],
    });
    expect(compatReport.compatible).toBe(false);
    expect(compatReport.issues.some((i) => i.code === 'missing-replica-column' && i.column === 'NEW_SOURCE_COL')).toBe(true);
    expect(compatReport.remediationDdl[0]).toContain('ALTER TABLE USERS ADD NEW_SOURCE_COL');
  });

  // -------------------------------------------------------------------------
  // M16 Items 1–4: Native Firebird Engine Publication DDL, replication.conf,
  // "FBCHANGELOG\0" Binary Segment Parser & Applier Bridge
  // -------------------------------------------------------------------------
  it('manages native RDB$PUBLICATIONS catalog DDL, provisions replication.conf, and parses/applies "FBCHANGELOG\\0" binary segments (M16 Items 1–4)', async () => {
    const db = createMockReplDb();
    db.tables.set('USERS', [{ ID: 1, NAME: 'Ada' }]);
    db.tables.set('ORDERS', [{ ID: 10, TOTAL: 100 }]);

    // 1. Enable native engine publication for specific tables
    const status1 = await enableEnginePublication(db, { tables: ['USERS', 'ORDERS'] });
    expect(status1.name).toBe('RDB$DEFAULT');
    expect(status1.active).toBe(true);
    expect(status1.publishedTables).toEqual(['ORDERS', 'USERS']);
    expect(status1.replicaMode).toBe('NONE');

    // Exclude one table
    await excludeTablesFromPublication(db, ['ORDERS']);
    const status2 = await getEnginePublicationStatus(db);
    expect(status2.publishedTables).toEqual(['USERS']);

    // Include all tables (`*`) and disable
    await includeTablesInPublication(db, '*');
    const status3 = await disableEnginePublication(db);
    expect(status3.active).toBe(false);
    expect(status3.autoEnable).toBe(true);
    expect(status3.publishedTables).toEqual(['ORDERS', 'USERS']);

    // Unified engineMode: 'native' in createPublication
    const pub = await createPublication(db, {
      name: 'native_pub',
      tables: ['USERS'],
      engineMode: 'native',
    });
    expect(pub.name).toBe('native_pub');
    expect((await getEnginePublicationStatus(db)).active).toBe(true);

    // 2. Provision replication.conf in a mock Emscripten FS
    const files = new Map<string, Uint8Array | string>();
    const dirs = new Set<string>();
    const mockFs: ReplicationEmscriptenFS = {
      mkdir(p) {
        dirs.add(p);
      },
      writeFile(p, data) {
        files.set(p, data);
      },
      readFile(p) {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      readdir(p) {
        const prefix = p.endsWith('/') ? p : p + '/';
        const out = ['.', '..'];
        for (const k of files.keys()) {
          if (k.startsWith(prefix)) {
            const rest = k.slice(prefix.length);
            if (!rest.includes('/')) out.push(rest);
          }
        }
        return out;
      },
      analyzePath(p) {
        return { exists: dirs.has(p) || files.has(p) };
      },
    };

    const confText = configureWasmReplicationConf(mockFs, {
      database: '/data/primary.fdb',
      journalDirectory: '/repl_log',
      journalArchiveDirectory: '/repl_arch',
      journalArchiveTimeout: 1,
      verboseLogging: true,
    });
    expect(confText).toBe(
      buildReplicationConf({
        database: '/data/primary.fdb',
        journalDirectory: '/repl_log',
        journalArchiveDirectory: '/repl_arch',
        journalArchiveTimeout: 1,
        verboseLogging: true,
      }),
    );
    expect(confText).toContain('journal_directory = /repl_log');
    expect(confText).toContain('journal_archive_directory = /repl_arch');
    expect(dirs.has('/repl_log')).toBe(true);
    expect(dirs.has('/repl_arch')).toBe(true);
    expect(files.get('/usr/local/firebird/replication.conf')).toBe(confText);

    // 3. Construct a binary "FBCHANGELOG\0" segment with Protocol=2 block (StartTx + DefineAtom + ExecuteSqlIntl + CommitTx)
    const sqlText = 'ALTER TABLE USERS ADD SCORE INT';
    const sqlBytes = new TextEncoder().encode(sqlText);
    const atomBytes = new Uint8Array([
      FbChangelogOpcode.opStartTransaction,
      FbChangelogOpcode.opDefineAtom,
      6,
      0x53,
      0x59,
      0x53,
      0x44,
      0x42,
      0x41, // atom[0] = "SYSDBA"
      FbChangelogOpcode.opDefineAtom,
      5,
      0x55,
      0x53,
      0x45,
      0x52,
      0x53, // atom[1] = "USERS"
    ]);
    // opExecuteSqlIntl (15): i32 ownerAtom (0), i32 schemaSearchPathAtom (1), u8 charset (4 = UTF8), u32 sqlLen, sqlBytes, opCommitTransaction (3)
    const sqlBlockPayload = new Uint8Array(atomBytes.length + 1 + 9 + 4 + sqlBytes.length + 1);
    sqlBlockPayload.set(atomBytes, 0);
    let pOff = atomBytes.length;
    sqlBlockPayload[pOff++] = FbChangelogOpcode.opExecuteSqlIntl;
    sqlBlockPayload.set([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x04], pOff);
    pOff += 9;
    new DataView(sqlBlockPayload.buffer).setUint32(pOff, sqlBytes.length, true);
    pOff += 4;
    sqlBlockPayload.set(sqlBytes, pOff);
    pOff += sqlBytes.length;
    sqlBlockPayload[pOff] = FbChangelogOpcode.opCommitTransaction;

    const totalLen =
      FB_CHANGELOG_HEADER_BYTES + FB_CHANGELOG_BLOCK_HEADER_BYTES + sqlBlockPayload.length;
    const segmentBytes = new Uint8Array(totalLen);
    const segView = new DataView(segmentBytes.buffer);
    for (let i = 0; i < FB_CHANGELOG_MAGIC.length; i++) {
      segmentBytes[i] = FB_CHANGELOG_MAGIC.charCodeAt(i);
    }
    segView.setUint16(12, 1, true); // version = 1
    segView.setUint16(14, 3, true); // state = 3 (ARCHIVABLE)
    for (let i = 0; i < 16; i++) segmentBytes[16 + i] = i + 1; // guid
    segView.setBigUint64(32, 1n, true); // sequence = 1
    segView.setBigUint64(40, BigInt(totalLen), true); // length

    // Block header at offset 48
    segView.setBigUint64(48, 7n, true); // traNumber = 7
    segView.setUint16(56, 2, true); // protocol = 2
    segView.setUint16(58, 3, true); // flags = BEGIN | END
    segView.setUint32(60, sqlBlockPayload.length, true);
    segmentBytes.set(sqlBlockPayload, 64);

    mockFs.writeFile('/repl_arch/primary.fdb_GUID.journal-000000001', segmentBytes);

    expect(isFbChangelogSegment(segmentBytes)).toBe(true);
    expect(parseFbChangelogSegment(segmentBytes).header.sequence).toBe(1);
    const parsedSegments = readWasmChangelogSegments(mockFs, '/repl_arch');
    expect(parsedSegments).toHaveLength(1);
    const seg = parsedSegments[0]!;
    expect(seg.header.version).toBe(1);
    expect(seg.header.state).toBe(3);
    expect(seg.header.sequence).toBe(1);
    expect(seg.header.guid).toBe('01020304-0506-0708-090A-0B0C0D0E0F10');
    expect(seg.blocks).toHaveLength(1);
    expect(seg.blocks[0]!.traNumber).toBe(7);
    expect(seg.blocks[0]!.protocol).toBe(2);
    expect(seg.blocks[0]!.beginTrans).toBe(true);
    expect(seg.blocks[0]!.endTrans).toBe(true);
    expect(seg.atoms).toContain('USERS');
    expect(seg.executedSql).toEqual(['ALTER TABLE USERS ADD SCORE INT']);

    // 4. Apply segment to replica database
    const replicaDb = createMockReplDb();
    const applyRes = await applyFbChangelogSegmentToDatabase(replicaDb, seg);
    expect(applyRes.sequence).toBe(1);
    expect(applyRes.blocksProcessed).toBe(1);
    expect(applyRes.ddlExecuted).toEqual(['ALTER TABLE USERS ADD SCORE INT']);
    expect(replicaDb.ddlLog).toContain('ALTER TABLE USERS ADD SCORE INT');
  });

  // -------------------------------------------------------------------------
  // M17 Items 1, 2 & 5: Full "FBCHANGELOG\0" Binary Operation Decoder,
  // JRD Record/BLOB/Sequence Decoder, Replica Mode Header & Changelog Poller
  // -------------------------------------------------------------------------
  it('decodes all "FBCHANGELOG\\0" opcodes (JRD records, BLOBs, sequences, savepoints) and streams archived segments via createWasmChangelogPoller (M17 Items 1, 2 & 5)', async () => {
    const itemColumns: readonly JrdColumnDescriptor[] = [
      { name: 'ID', type: 'INTEGER', primaryKey: true },
      { name: 'TITLE', type: 'VARCHAR', charLength: 16 },
      { name: 'QTY', type: 'BIGINT' },
      { name: 'ACTIVE', type: 'BOOLEAN' },
      { name: 'NOTE', type: 'BLOB', blobSubType: 'TEXT' },
    ];

    const blobIdHex = '8000000000000000';
    const blobBytes = new TextEncoder().encode('Warp coil online');
    const row1v1 = encodeJrdRecordBuffer(
      { ID: 1, TITLE: 'Warp Coil', QTY: 10, ACTIVE: true, NOTE: blobIdHex },
      itemColumns,
    );
    expect(decodeJrdRecordBuffer(row1v1, itemColumns).TITLE).toBe('Warp Coil');
    const row1v2 = encodeJrdRecordBuffer(
      { ID: 1, TITLE: 'Warp Coil Mk2', QTY: 25, ACTIVE: true, NOTE: blobIdHex },
      itemColumns,
    );
    const row2RolledBack = encodeJrdRecordBuffer(
      { ID: 2, TITLE: 'Ghost Item', QTY: 99, ACTIVE: false, NOTE: null },
      itemColumns,
    );
    const row3Deleted = encodeJrdRecordBuffer(
      { ID: 3, TITLE: 'Temp Fuse', QTY: 1, ACTIVE: false, NOTE: null },
      itemColumns,
    );

    const enc = new TextEncoder();
    const pushU32 = (arr: number[], v: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, v, true);
      arr.push(...b);
    };
    const pushI64 = (arr: number[], v: bigint) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigInt64(0, v, true);
      arr.push(...b);
    };
    const pushAtom = (arr: number[], name: string) => {
      const nb = enc.encode(name);
      arr.push(FbChangelogOpcode.opDefineAtom, nb.length, ...nb);
    };

    // Block 1 (tra=0): opSetSequence ("PUBLIC"."SEQ_ITEM" = 42)
    const b1: number[] = [];
    pushAtom(b1, 'PUBLIC');
    pushAtom(b1, 'SEQ_ITEM');
    b1.push(FbChangelogOpcode.opSetSequence);
    pushU32(b1, 0);
    pushU32(b1, 1);
    pushI64(b1, 42n);

    // Block 2 (tra=10): committed tx with StoreBlob + Insert(1) + Savepoint(Insert(2) -> RollbackSavepoint) + Update(1) + Insert(3) + Delete(3) + Commit
    const b2: number[] = [FbChangelogOpcode.opStartTransaction];
    pushAtom(b2, 'PUBLIC'); // 0
    pushAtom(b2, 'ITEMS'); // 1
    // opStoreBlob
    b2.push(FbChangelogOpcode.opStoreBlob, 0x80, 0, 0, 0, 0, 0, 0, 0);
    b2.push(blobBytes.length & 0xff, (blobBytes.length >> 8) & 0xff, ...blobBytes, 0, 0);
    // Insert row 1
    b2.push(FbChangelogOpcode.opStartSavepoint, FbChangelogOpcode.opInsertRecord);
    pushU32(b2, 0);
    pushU32(b2, 1);
    pushU32(b2, row1v1.length);
    b2.push(...row1v1, FbChangelogOpcode.opReleaseSavepoint);
    // Savepoint that rolls back row 2!
    b2.push(FbChangelogOpcode.opStartSavepoint, FbChangelogOpcode.opInsertRecord);
    pushU32(b2, 0);
    pushU32(b2, 1);
    pushU32(b2, row2RolledBack.length);
    b2.push(...row2RolledBack, FbChangelogOpcode.opRollbackSavepoint);
    // Update row 1 -> row1v2
    b2.push(FbChangelogOpcode.opUpdateRecord);
    pushU32(b2, 0);
    pushU32(b2, 1);
    pushU32(b2, row1v1.length);
    b2.push(...row1v1);
    pushU32(b2, row1v2.length);
    b2.push(...row1v2);
    // Insert & Delete row 3
    b2.push(FbChangelogOpcode.opInsertRecord);
    pushU32(b2, 0);
    pushU32(b2, 1);
    pushU32(b2, row3Deleted.length);
    b2.push(...row3Deleted);
    b2.push(FbChangelogOpcode.opDeleteRecord);
    pushU32(b2, 0);
    pushU32(b2, 1);
    pushU32(b2, row3Deleted.length);
    b2.push(...row3Deleted);
    b2.push(FbChangelogOpcode.opPrepareTransaction, FbChangelogOpcode.opCommitTransaction);

    // Block 3 (tra=11): rolled-back transaction (must NOT appear in logical entries!)
    const b3: number[] = [FbChangelogOpcode.opStartTransaction];
    pushAtom(b3, 'PUBLIC');
    pushAtom(b3, 'ITEMS');
    b3.push(FbChangelogOpcode.opInsertRecord);
    pushU32(b3, 0);
    pushU32(b3, 1);
    pushU32(b3, row2RolledBack.length);
    b3.push(...row2RolledBack, FbChangelogOpcode.opRollbackTransaction);

    const seg1 = encodeFbChangelogSegment({
      sequence: 1,
      guid: '11223344-5566-7788-99AA-BBCCDDEEFF00',
      blocks: [
        { traNumber: 0, flags: 0, payload: new Uint8Array(b1) },
        { traNumber: 10, flags: 3, payload: new Uint8Array(b2) },
        { traNumber: 11, flags: 3, payload: new Uint8Array(b3) },
      ],
    });

    const ops = decodeFbChangelogOperations(seg1);
    expect(ops.some((o) => o.kind === 'set_sequence' && o.sequenceName === 'SEQ_ITEM' && o.value === 42)).toBe(true);
    expect(ops.some((o) => o.kind === 'store_blob' && o.chunkCount === 1)).toBe(true);
    expect(ops.some((o) => o.kind === 'rollback_savepoint')).toBe(true);
    expect(ops.some((o) => o.kind === 'rollback_transaction')).toBe(true);

    const logical = fbChangelogToLogicalEntries(seg1, {
      tableSchemas: { ITEMS: itemColumns },
      origin: 'primary_node',
    });
    expect(logical.committedTransactions).toEqual([10]);
    expect(logical.rolledBackTransactions).toEqual([11]);
    expect(logical.sequences).toEqual([{ name: 'SEQ_ITEM', currentValue: 42 }]);
    // Actions in tra=10 after savepoint rollback: INSERT(1), UPDATE(1), INSERT(3), DELETE(3)
    expect(logical.entries).toHaveLength(4);
    expect(logical.entries[0]!.operation).toBe('INSERT');
    expect(logical.entries[0]!.after).toEqual({
      ID: 1,
      TITLE: 'Warp Coil',
      QTY: 10,
      ACTIVE: true,
      NOTE: 'Warp coil online',
    });
    expect(logical.entries[1]!.operation).toBe('UPDATE');
    expect(logical.entries[1]!.after?.TITLE).toBe('Warp Coil Mk2');
    expect(logical.entries[1]!.after?.QTY).toBe(25);
    expect(logical.entries[3]!.operation).toBe('DELETE');
    expect(logical.entries[3]!.key).toEqual({ ID: 3 });

    // Continuous poller & archiver with unlinkArchivedSegments: true
    const fsMap = new Map<string, Uint8Array | string>();
    const mockFs: ReplicationEmscriptenFS = {
      mkdir() {},
      writeFile(p, d) {
        fsMap.set(p, d);
      },
      readFile(p) {
        const v = fsMap.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      readdir(p) {
        const pref = p.endsWith('/') ? p : p + '/';
        const out = ['.', '..'];
        for (const k of fsMap.keys()) {
          if (k.startsWith(pref)) out.push(k.slice(pref.length));
        }
        return out;
      },
      unlink(p) {
        fsMap.delete(p);
      },
    };

    // Verify setWasmDatabaseReplicaMode sets byte 26 on a valid ODS header page
    const fakeHeader = new Uint8Array(8192);
    fakeHeader[0] = 1; // pag_header
    new DataView(fakeHeader.buffer).setUint16(16, 8192, true); // hdr_page_size = 8192
    mockFs.writeFile('/data/replica.fdb', fakeHeader);
    const modeInfo = setWasmDatabaseReplicaMode(mockFs, '/data/replica.fdb', 'read_write');
    expect(modeInfo.modeCode).toBe(2);
    expect((mockFs.readFile('/data/replica.fdb') as Uint8Array)[26]).toBe(2);

    fsMap.set('/arch/db.journal-000000001', seg1);
    const replicaDb = createMockReplDb();
    replicaDb.tables.set('ITEMS', []);

    const observedSeqs: number[] = [];
    const poller = createWasmChangelogPoller({
      fs: mockFs,
      targetDb: replicaDb,
      journalArchiveDirectory: '/arch',
      journalDirectory: '/jrn',
      unlinkArchivedSegments: true,
      tableSchemas: { ITEMS: itemColumns },
      onSegment(seg) {
        observedSeqs.push(seg.header.sequence);
      },
    });

    const poll1 = await poller.pollOnce();
    expect(poll1).toHaveLength(1);
    expect(poller.lastAppliedSequence()).toBe(1);
    expect(observedSeqs).toEqual([1]);
    expect(fsMap.has('/arch/db.journal-000000001')).toBe(false); // unlinked!
    expect(replicaDb.sequences.get('SEQ_ITEM')).toBe(42);
    expect(replicaDb.tables.get('ITEMS')).toEqual([
      { ID: 1, TITLE: 'Warp Coil Mk2', QTY: 25, ACTIVE: true, NOTE: 'Warp coil online' },
    ]);
    expect(poller.stats()).toMatchObject({
      pollCount: 1,
      segmentsApplied: 1,
      filesUnlinked: 1,
      lastAppliedSequence: 1,
    });
  });
});
