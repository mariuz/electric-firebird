import {
  createWriteQueue,
  WriteConflict,
  WriteRejected,
  mergeWriteConflict,
  DEFAULT_WRITE_QUEUE_TABLE,
} from '../electric';
import type {
  ElectricDatabase,
  ElectricTransaction,
  LocalWrite,
  ResolvedConflictOutcome,
  WriteConflictContext,
} from '../electric';

class InMemoryWritesDb implements ElectricDatabase {
  hasQueueTable = false;
  rowsById = new Map<number, Record<string, unknown>>([
    [1, { ID: 1, TITLE: 'Initial', DONE: false, NOTES: 'v1' }],
  ]);
  queueRows = new Map<number, Record<string, unknown>>();

  async transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T> {
    const tx: ElectricTransaction = {
      exec: async (sql, params = []) => {
        if (
          sql.startsWith('CREATE TABLE "FB_WRITE_QUEUE$"') ||
          sql.startsWith('CREATE TABLE "ELECTRIC_WRITES"')
        ) {
          this.hasQueueTable = true;
          return { affectedRows: 0 };
        }
        if (sql.includes('INSERT INTO "FB_WRITE_QUEUE$"')) {
          const id = Number(params[0]);
          this.queueRows.set(id, {
            ID: id,
            TABLE_NAME: params[1],
            OP: params[2],
            KEY_JSON: params[3],
            VALUE_JSON: params[4],
            BEFORE_JSON: params[5] ?? null,
            STATE: 'P',
            TXID: null,
            SENT_AT: null,
          });
          return { affectedRows: 1 };
        }
        if (
          sql.startsWith(
            'UPDATE "FB_WRITE_QUEUE$" SET OP = ?, VALUE_JSON = ?, BEFORE_JSON = ? WHERE ID = ?',
          )
        ) {
          const id = Number(params[3]);
          const row = this.queueRows.get(id);
          if (row) {
            row['OP'] = params[0];
            row['VALUE_JSON'] = params[1];
            row['BEFORE_JSON'] = params[2];
          }
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE "FB_WRITE_QUEUE$" SET BEFORE_JSON = ? WHERE ID = ?')) {
          const id = Number(params[1]);
          const row = this.queueRows.get(id);
          if (row) {
            row['BEFORE_JSON'] = params[0];
          }
          return { affectedRows: 1 };
        }
        if (sql.startsWith("UPDATE \"FB_WRITE_QUEUE$\" SET STATE = 'S'")) {
          const id = Number(params[2]);
          const row = this.queueRows.get(id);
          if (row) {
            row['STATE'] = 'S';
            row['TXID'] = params[0];
            row['SENT_AT'] = params[1];
          }
          return { affectedRows: 1 };
        }
        if (sql.startsWith('DELETE FROM "FB_WRITE_QUEUE$" WHERE ID = ?')) {
          this.queueRows.delete(Number(params[0]));
          return { affectedRows: 1 };
        }
        if (sql.startsWith('DELETE FROM "ITEMS" WHERE "ID" = ?')) {
          this.rowsById.delete(Number(params[0]));
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE OR INSERT INTO "ITEMS"')) {
          const colMatch = /\(([^)]+)\)\s+VALUES/i.exec(sql);
          const cols = colMatch![1]!
            .split(',')
            .map((c) => c.trim().replace(/"/g, ''));
          const idIdx = cols.indexOf('ID');
          const id = Number(params[idIdx]);
          const next: Record<string, unknown> = {
            ...(this.rowsById.get(id) ?? {}),
          };
          cols.forEach((col, i) => {
            next[col] = params[i];
          });
          this.rowsById.set(id, next);
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE "ITEMS" SET ')) {
          const setPart = /^UPDATE "ITEMS" SET (.+) WHERE "ID" = \?$/i.exec(sql);
          const cols = setPart![1]!
            .split(',')
            .map((s) => s.split('=')[0]!.trim().replace(/"/g, ''));
          const id = Number(params[cols.length]);
          const existing = this.rowsById.get(id);
          if (existing) {
            cols.forEach((c, idx) => {
              existing[c] = params[idx];
            });
          }
          return { affectedRows: 1 };
        }
        return { affectedRows: 1 };
      },
      execBatch: async () => ({ affectedRows: 0 }),
      query: async (sql, params = []) => {
        if (sql.includes('RDB$RELATIONS')) {
          return { rows: this.hasQueueTable ? [{ X: 1 }] : [] };
        }
        if (sql.includes('RDB$RELATION_FIELDS')) {
          return { rows: [{ X: 1 }] };
        }
        if (sql.includes('RDB$RELATION_CONSTRAINTS')) {
          return { rows: [{ F: 'ID' }] };
        }
        if (sql.startsWith('SELECT * FROM "ITEMS" WHERE "ID" = ?')) {
          const r = this.rowsById.get(Number(params[0]));
          return { rows: r ? [{ ...r }] : [] };
        }
        if (
          sql.startsWith(
            'SELECT COALESCE(MAX(ID), 0) + 1 AS N FROM "FB_WRITE_QUEUE$"',
          )
        ) {
          const max = Math.max(0, ...this.queueRows.keys());
          return { rows: [{ N: max + 1 }] };
        }
        if (sql.startsWith('SELECT ID, TABLE_NAME, OP, KEY_JSON')) {
          const all = [...this.queueRows.values()].sort(
            (a, b) => Number(a['ID']) - Number(b['ID']),
          );
          return { rows: all.map((r) => ({ ...r })) };
        }
        return { rows: [] };
      },
    };
    return fn(tx);
  }
}

describe('createWriteQueue conflict resolution strategies (onConflict)', () => {
  it('supports mergeWriteConflict 3-way field-level merge helper', () => {
    const before = { id: 1, title: 'Orig', done: false, notes: 'v1' };
    const server = { id: 1, title: 'Orig', done: true, notes: 'v2' };
    const outcome = mergeWriteConflict(before, server, {
      operation: 'update',
      key: { id: 1 },
      value: { title: 'Edited offline', done: false },
    });
    expect(outcome).toEqual({
      action: 'merge',
      operation: 'update',
      value: {
        title: 'Edited offline',
        done: true,
        notes: 'v2',
      },
    });
  });

  it('resolves flush conflicts with onConflict: "server-wins" by reverting local row to server state', async () => {
    const db = new InMemoryWritesDb();
    const resolved: Array<{
      ctx: WriteConflictContext;
      outcome: ResolvedConflictOutcome;
    }> = [];

    const queue = await createWriteQueue(db, {
      tableName: DEFAULT_WRITE_QUEUE_TABLE,
      paused: true,
      autoFlushOnOnline: false,
      onConflict: 'server-wins',
      onConflictResolved: (ctx, outcome) => resolved.push({ ctx, outcome }),
      send: async () => {
        throw new WriteConflict('409 Conflict', {
          server: {
            id: 1,
            title: 'Server Winner',
            done: true,
            notes: 'server-v2',
          },
        });
      },
    });

    await queue.update('items', { id: 1 }, { title: 'Client Attempt' });
    expect(db.rowsById.get(1)?.['TITLE']).toBe('Client Attempt');

    await queue.flush();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.outcome).toEqual({ action: 'server-wins' });
    expect(resolved[0]!.ctx.before).toEqual({
      id: 1,
      title: 'Initial',
      done: false,
      notes: 'v1',
    });
    expect(await queue.pending()).toEqual([]);
    expect(db.rowsById.get(1)).toEqual({
      ID: 1,
      TITLE: 'Server Winner',
      DONE: true,
      NOTES: 'server-v2',
    });

    await queue.close();
  });

  it('resolves flush conflicts with onConflict: "client-wins", "merge", and custom resolver callbacks', async () => {
    const db = new InMemoryWritesDb();
    const sentWrites: LocalWrite[] = [];

    const queue = await createWriteQueue(db, {
      tableName: DEFAULT_WRITE_QUEUE_TABLE,
      paused: true,
      autoFlushOnOnline: false,
      onConflict: 'merge',
      send: async (w) => {
        if (!w.conflictResolved) {
          throw new WriteConflict('Version conflict', {
            id: 1,
            title: 'Initial',
            done: true,
            notes: 'server-updated',
          });
        }
        sentWrites.push(w);
        return { txid: 42 };
      },
    });

    // Client changes `title`, while `done` was unchanged from `before`
    await queue.update(
      'items',
      { id: 1 },
      { title: 'Client Title', done: false },
    );
    await queue.flush();

    expect(sentWrites).toHaveLength(1);
    expect(sentWrites[0]!.conflictResolved).toBe(true);
    expect(sentWrites[0]!.value).toEqual({
      title: 'Client Title',
      done: true,
      notes: 'server-updated',
    });
    expect(db.rowsById.get(1)).toEqual({
      ID: 1,
      TITLE: 'Client Title',
      DONE: true,
      NOTES: 'server-updated',
    });

    await queue.close();

    // Custom callback inspecting before, server, and write via getServerRow pre-send detection
    const db2 = new InMemoryWritesDb();
    const customSent: LocalWrite[] = [];
    const queue2 = await createWriteQueue(db2, {
      tableName: DEFAULT_WRITE_QUEUE_TABLE,
      paused: true,
      autoFlushOnOnline: false,
      getServerRow: async () => ({
        id: 1,
        title: 'Server Title',
        done: true,
        notes: 'v2',
      }),
      onConflict: ({ before, server, write }) => ({
        title: `${String(server?.['title'])} + ${String(write.value['title'])} (was ${String(before?.['title'])})`,
        done: server?.['done'],
        notes: server?.['notes'],
      }),
      send: async (w) => {
        if (w.value['title'] === 'reject-me') {
          throw new WriteRejected('bad');
        }
        customSent.push(w);
        return { txid: 99 };
      },
    });

    await queue2.update('items', { id: 1 }, { title: 'Offline Edit' });
    await queue2.flush();

    expect(customSent).toHaveLength(1);
    expect(customSent[0]!.value).toEqual({
      title: 'Server Title + Offline Edit (was Initial)',
      done: true,
      notes: 'v2',
    });
    expect(db2.rowsById.get(1)?.['TITLE']).toBe(
      'Server Title + Offline Edit (was Initial)',
    );

    await queue2.close();
  });

  it('resolves sync.reconcile conflicts when server changes touch a row with pending offline writes', async () => {
    const db = new InMemoryWritesDb();
    const resolved: ResolvedConflictOutcome[] = [];

    const queue = await createWriteQueue(db, {
      tableName: DEFAULT_WRITE_QUEUE_TABLE,
      paused: true,
      autoFlushOnOnline: false,
      onConflict: 'server-wins',
      onConflictResolved: (_ctx, outcome) => resolved.push(outcome),
      send: async () => ({ txid: 1 }),
    });

    await queue.update('items', { id: 1 }, { title: 'Local Offline Edit' });
    expect(db.rowsById.get(1)?.['TITLE']).toBe('Local Offline Edit');

    // Simulate incoming Electric sync batch updating row 1 to server values before reconcile runs
    await db.transaction(async (tx) => {
      await tx.exec(
        'UPDATE "ITEMS" SET "TITLE" = ?, "DONE" = ? WHERE "ID" = ?',
        ['Server Synced Title', true, 1],
      );
      await queue.sync.reconcile(tx, 'items', 'all', new Set());
    });

    expect(resolved).toEqual([{ action: 'server-wins' }]);
    expect(await queue.pending()).toEqual([]);
    expect(db.rowsById.get(1)).toEqual({
      ID: 1,
      TITLE: 'Server Synced Title',
      DONE: true,
      NOTES: 'v1',
    });

    await queue.close();
  });
});
