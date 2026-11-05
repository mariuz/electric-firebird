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
  type ReplicableDatabase,
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

    // MAX(LSN)
    const maxMatch = /SELECT\s+MAX\(LSN\)\s+AS\s+MAX_LSN\s+FROM\s+([A-Za-z0-9_$"]+)/i.exec(
      trimmed,
    );
    if (maxMatch) {
      const rows = getTable(maxMatch[1]!);
      let max = 0;
      for (const r of rows) {
        const lsn = Number(r.LSN ?? 0);
        if (lsn > max) max = lsn;
      }
      return { rows: [{ MAX_LSN: max }] };
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

    // Generic SELECT * FROM <table> [WHERE ...]
    const fromMatch = /FROM\s+([A-Za-z0-9_$"]+)(?:\s+WHERE\s+(.+))?$/i.exec(trimmed);
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
});
