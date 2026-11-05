import { describe, it, expect } from 'vitest';
import {
  createPublication,
  createSubscription,
  replicateDatabases,
  mergeReplicatedRow,
  type ReplicableDatabase,
} from '../replication';
import type { QueryParams, QueryResult, Row } from '../types';

// ---------------------------------------------------------------------------
// In-Memory SQL Mock Database for Logical & Journal Replication Tests
// ---------------------------------------------------------------------------

function createMockReplDb(): ReplicableDatabase & {
  tables: Map<string, Row[]>;
  ddlLog: string[];
} {
  const tables = new Map<string, Row[]>();
  const ddlLog: string[] = [];

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
    ddlLog,
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
});
