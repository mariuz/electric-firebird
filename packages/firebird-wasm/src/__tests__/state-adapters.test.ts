import { describe, it, expect, vi } from 'vitest';
import {
  extractReferencedTables,
  buildFirebirdQueryKey,
  createFirebirdQueryOptions,
  connectFirebirdQueryClient,
  createWriteQueueMutationOptions,
  createFirebirdCollection,
  FIREBIRD_QUERY_KEY_PREFIX,
  type TanStackFirebirdDatabase,
  type TanStackQueryClientLike,
  type TanStackWriteQueueLike,
} from '../tanstack';
import {
  getRxStorageFirebird,
  matchesMangoSelector,
  type RxDocumentData,
  type RxFirebirdDatabase,
} from '../rxdb';
import type { LiveQuery, LiveQueryOptions } from '../browser/firebird-browser';
import type { QueryParams, QueryResult, Row } from '../types';

// ---------------------------------------------------------------------------
// In-memory Mock Database for TanStack & RxDB Adapter Tests
// ---------------------------------------------------------------------------

function createMockDb(): TanStackFirebirdDatabase &
  RxFirebirdDatabase & {
    tables: Map<string, Row[]>;
    triggerLive(sqlSubstring: string): Promise<void>;
    fireEvent(name: string, count?: number): void;
  } {
  const tables = new Map<string, Row[]>();
  const liveListeners: Array<{
    sql: string;
    params: QueryParams;
    onChange: (rows: Row[], result: QueryResult<Row>) => void;
  }> = [];
  const eventListeners = new Map<string, Set<(count: number) => void>>();

  const runSelect = (sql: string, params: QueryParams = []): QueryResult<Row> => {
    const trimmed = sql.trim();

    // MAX(SEQ) query for RxDB
    const maxSeqMatch = /SELECT\s+MAX\(SEQ\)\s+AS\s+MAX_SEQ\s+FROM\s+([A-Za-z0-9_$]+)/i.exec(
      trimmed,
    );
    if (maxSeqMatch) {
      const table = maxSeqMatch[1].toUpperCase();
      const rows = tables.get(table) ?? [];
      let max = 0;
      for (const r of rows) {
        const s = Number(r.SEQ ?? 0);
        if (s > max) max = s;
      }
      return { rows: [{ MAX_SEQ: max }] };
    }

    // COUNT(*) query for RxDB
    const countMatch =
      /SELECT\s+COUNT\(\*\)\s+AS\s+CNT\s+FROM\s+([A-Za-z0-9_$]+)\s+WHERE\s+DELETED\s*=\s*0/i.exec(
        trimmed,
      );
    if (countMatch) {
      const table = countMatch[1].toUpperCase();
      const rows = (tables.get(table) ?? []).filter((r) => Number(r.DELETED ?? 0) === 0);
      return { rows: [{ CNT: rows.length }] };
    }

    // Generic FROM <table>
    const fromMatch = /FROM\s+([A-Za-z0-9_$"]+)/i.exec(trimmed);
    const tableName = fromMatch
      ? fromMatch[1].replace(/"/g, '').toUpperCase()
      : 'DEFAULT';
    let rows = [...(tables.get(tableName) ?? [])];

    // WHERE DOC_ID = ?
    if (/WHERE\s+DOC_ID\s*=\s*\?/i.test(trimmed)) {
      const id = String(params[0] ?? '');
      rows = rows.filter((r) => String(r.DOC_ID) === id);
    } else if (/WHERE\s+DOC_ID\s+IN\s*\(/i.test(trimmed)) {
      const idSet = new Set(params.map((p) => String(p)));
      rows = rows.filter((r) => idSet.has(String(r.DOC_ID)));
    } else if (/WHERE\s+DELETED\s*=\s*0/i.test(trimmed)) {
      rows = rows.filter((r) => Number(r.DELETED ?? 0) === 0);
    } else if (/WHERE\s+SEQ\s*>\s*\?/i.test(trimmed)) {
      const minSeq = Number(params[0] ?? 0);
      rows = rows
        .filter((r) => Number(r.SEQ ?? 0) > minSeq)
        .sort((a, b) => Number(a.SEQ ?? 0) - Number(b.SEQ ?? 0));
    } else if (/WHERE\s+DONE\s*=\s*\?/i.test(trimmed)) {
      const doneVal = params[0];
      rows = rows.filter((r) => (r.DONE ?? r.done) === doneVal);
    }

    return { rows };
  };

  const applyMutation = (sql: string, params: QueryParams = []): void => {
    const trimmed = sql.trim();

    if (/^CREATE\s+TABLE\s+([A-Za-z0-9_$"]+)/i.test(trimmed)) {
      const m = /^CREATE\s+TABLE\s+([A-Za-z0-9_$"]+)/i.exec(trimmed)!;
      const t = m[1].replace(/"/g, '').toUpperCase();
      if (!tables.has(t)) tables.set(t, []);
      return;
    }

    if (/^DROP\s+TABLE\s+([A-Za-z0-9_$"]+)/i.test(trimmed)) {
      const m = /^DROP\s+TABLE\s+([A-Za-z0-9_$"]+)/i.exec(trimmed)!;
      const t = m[1].replace(/"/g, '').toUpperCase();
      tables.delete(t);
      return;
    }

    const insertMatch =
      /^INSERT\s+INTO\s+([A-Za-z0-9_$"]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(
        trimmed,
      );
    if (insertMatch) {
      const table = insertMatch[1].replace(/"/g, '').toUpperCase();
      const cols = insertMatch[2].split(',').map((c) => c.trim().replace(/"/g, '').toUpperCase());
      const row: Row = {};
      cols.forEach((col, idx) => {
        row[col] = params[idx];
      });
      const list = tables.get(table) ?? [];
      list.push(row);
      tables.set(table, list);
      return;
    }

    const updateRxMatch =
      /^UPDATE\s+([A-Za-z0-9_$"]+)\s+SET\s+REV\s*=\s*\?,\s*DELETED\s*=\s*\?,\s*LWT\s*=\s*\?,\s*SEQ\s*=\s*\?,\s*DOC_JSON\s*=\s*\?,\s*ATTACHMENTS_JSON\s*=\s*\?\s+WHERE\s+DOC_ID\s*=\s*\?/i.exec(
        trimmed,
      );
    if (updateRxMatch) {
      const table = updateRxMatch[1].replace(/"/g, '').toUpperCase();
      const list = tables.get(table) ?? [];
      const docId = String(params[6]);
      for (const r of list) {
        if (String(r.DOC_ID) === docId) {
          r.REV = params[0];
          r.DELETED = params[1];
          r.LWT = params[2];
          r.SEQ = params[3];
          r.DOC_JSON = params[4];
          r.ATTACHMENTS_JSON = params[5];
        }
      }
      return;
    }

    const updateGenericMatch =
      /^UPDATE\s+([A-Za-z0-9_$"]+)\s+SET\s+(.+)\s+WHERE\s+(.+)$/i.exec(trimmed);
    if (updateGenericMatch) {
      const table = updateGenericMatch[1].replace(/"/g, '').toUpperCase();
      const setCols = updateGenericMatch[2]
        .split(',')
        .map((part) => part.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      const whereCols = updateGenericMatch[3]
        .split(/\s+AND\s+/i)
        .map((part) => part.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      const list = tables.get(table) ?? [];
      for (const r of list) {
        const matches = whereCols.every(
          (col, idx) => r[col] === params[setCols.length + idx],
        );
        if (matches) {
          setCols.forEach((col, idx) => {
            r[col] = params[idx];
          });
        }
      }
      return;
    }

    const deleteCleanupMatch =
      /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+DELETED\s*=\s*1\s+AND\s+LWT\s*<\s*\?/i.exec(
        trimmed,
      );
    if (deleteCleanupMatch) {
      const table = deleteCleanupMatch[1].replace(/"/g, '').toUpperCase();
      const cutoff = Number(params[0]);
      const list = tables.get(table) ?? [];
      tables.set(
        table,
        list.filter((r) => !(Number(r.DELETED) === 1 && Number(r.LWT) < cutoff)),
      );
      return;
    }

    const deleteGenericMatch = /^DELETE\s+FROM\s+([A-Za-z0-9_$"]+)\s+WHERE\s+(.+)$/i.exec(
      trimmed,
    );
    if (deleteGenericMatch) {
      const table = deleteGenericMatch[1].replace(/"/g, '').toUpperCase();
      const whereCols = deleteGenericMatch[2]
        .split(/\s+AND\s+/i)
        .map((part) => part.split('=')[0].trim().replace(/"/g, '').toUpperCase());
      const list = tables.get(table) ?? [];
      tables.set(
        table,
        list.filter(
          (r) => !whereCols.every((col, idx) => r[col] === params[idx]),
        ),
      );
    }
  };

  const db = {
    tables,
    async query<T extends Row = Row>(
      sql: string,
      params: QueryParams = [],
    ): Promise<QueryResult<T>> {
      if (/^(CREATE|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql.trim())) {
        applyMutation(sql, params);
        return { rows: [] as T[] };
      }
      return runSelect(sql, params) as QueryResult<T>;
    },
    async execute(sql: string, params: QueryParams = []): Promise<{ changes?: number }> {
      applyMutation(sql, params);
      return { changes: 1 };
    },
    async exec(sql: string): Promise<void> {
      applyMutation(sql, []);
    },
    async transaction<T>(
      fn: (tx: {
        query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
        execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
        exec?(sql: string): Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      return fn(db);
    },
    async live<T extends Row = Row>(
      sql: string,
      options: LiveQueryOptions,
      onChange: (rows: T[], result: QueryResult<T>) => void,
    ): Promise<LiveQuery<T>> {
      const params = options.params ?? [];
      const initial = runSelect(sql, params) as QueryResult<T>;
      onChange(initial.rows, initial);
      const entry = {
        sql,
        params,
        onChange: onChange as (rows: Row[], result: QueryResult<Row>) => void,
      };
      liveListeners.push(entry);
      return {
        async refresh() {
          const next = runSelect(sql, params) as QueryResult<T>;
          onChange(next.rows, next);
        },
        async unsubscribe() {
          const idx = liveListeners.indexOf(entry);
          if (idx >= 0) liveListeners.splice(idx, 1);
        },
      };
    },
    async onEvent(
      name: string,
      listener: (count: number) => void,
    ): Promise<() => Promise<void>> {
      let set = eventListeners.get(name);
      if (!set) {
        set = new Set();
        eventListeners.set(name, set);
      }
      set.add(listener);
      return async () => {
        set?.delete(listener);
      };
    },
    async triggerLive(sqlSubstring: string): Promise<void> {
      for (const l of liveListeners) {
        if (l.sql.toUpperCase().includes(sqlSubstring.toUpperCase())) {
          const res = runSelect(l.sql, l.params);
          l.onChange(res.rows, res);
        }
      }
    },
    fireEvent(name: string, count = 1): void {
      const set = eventListeners.get(name);
      if (set) {
        for (const fn of [...set]) fn(count);
      }
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// 1. TanStack Query & TanStack DB Adapter Tests
// ---------------------------------------------------------------------------

describe('firebird-wasm/tanstack – TanStack Query & TanStack DB adapters', () => {
  it('extracts referenced tables and builds deterministic query keys', () => {
    const tables = extractReferencedTables(
      'SELECT t.id, u.name FROM todos t JOIN "users" u ON u.id = t.user_id WHERE t.done = ?',
    );
    expect(tables).toEqual(['TODOS', 'USERS']);

    const key = buildFirebirdQueryKey(
      'SELECT * FROM todos WHERE created_at > ? AND id = ?',
      [new Date('2026-01-01T00:00:00Z'), 42n],
    );
    expect(key[0]).toBe(FIREBIRD_QUERY_KEY_PREFIX);
    expect(key[1].tables).toEqual(['TODOS']);
    expect(key[1].params).toEqual([
      { $date: new Date('2026-01-01T00:00:00Z').getTime() },
      { $bigint: '42' },
    ]);
  });

  it('creates queryOptions, runs queryFn with select, and updates QueryClient on live changes', async () => {
    const db = createMockDb();
    db.tables.set('TODOS', [
      { ID: 1, TITLE: 'Write adapter', DONE: 0 },
      { ID: 2, TITLE: 'Ship release', DONE: 1 },
    ]);

    const cache = new Map<string, unknown>();
    const queryClient: TanStackQueryClientLike = {
      invalidateQueries: vi.fn(),
      setQueryData(queryKey, updater) {
        const k = JSON.stringify(queryKey);
        const prev = cache.get(k);
        const next = typeof updater === 'function' ? (updater as (p: unknown) => unknown)(prev) : updater;
        cache.set(k, next);
        return next;
      },
      getQueryData(queryKey) {
        return cache.get(JSON.stringify(queryKey)) as never;
      },
    };

    const opts = createFirebirdQueryOptions<{ ID: number; TITLE: string; DONE: number }, string[]>(
      db,
      'SELECT ID, TITLE, DONE FROM TODOS WHERE DONE = ?',
      [0],
      {
        live: true,
        queryClient,
        select: (rows) => rows.map((r) => r.TITLE),
      },
    );

    const titles = await opts.queryFn();
    expect(titles).toEqual(['Write adapter']);
    expect(queryClient.getQueryData?.(opts.queryKey)).toEqual(['Write adapter']);

    // Mutate table and trigger live update
    db.tables.get('TODOS')!.push({ ID: 3, TITLE: 'Test live sync', DONE: 0 });
    await db.triggerLive('TODOS');

    expect(queryClient.getQueryData?.(opts.queryKey)).toEqual([
      'Write adapter',
      'Test live sync',
    ]);

    await opts.unsubscribe();
  });

  it('bridges Firebird events, SyncBatchCommitInfo, and WriteQueue mutations to QueryClient invalidation', async () => {
    const db = createMockDb();
    const invalidatedPredicates: Array<(q: { queryKey: readonly unknown[] }) => boolean> = [];

    const queryClient: TanStackQueryClientLike = {
      invalidateQueries: vi.fn(async (filters) => {
        if (filters?.predicate) {
          invalidatedPredicates.push(filters.predicate);
        }
      }),
    };

    const bridge = await connectFirebirdQueryClient(db, queryClient, {
      tables: ['TODOS'],
      events: ['custom_todos_event'],
      eventToTables: { custom_todos_event: ['TODOS'] },
    });

    const todosQueryKey = buildFirebirdQueryKey('SELECT * FROM TODOS');
    const usersQueryKey = buildFirebirdQueryKey('SELECT * FROM USERS');

    // 1. Firebird POST_EVENT
    db.fireEvent('fb_live_TODOS');
    expect(invalidatedPredicates.length).toBe(1);
    expect(invalidatedPredicates[0]({ queryKey: todosQueryKey })).toBe(true);
    expect(invalidatedPredicates[0]({ queryKey: usersQueryKey })).toBe(false);

    // 2. Electric multi-shape batch commit hook
    bridge.onSyncBatchCommitted({ tables: ['"USERS"'], txids: ['101'] });
    expect(invalidatedPredicates.length).toBe(2);
    expect(invalidatedPredicates[1]({ queryKey: usersQueryKey })).toBe(true);
    expect(invalidatedPredicates[1]({ queryKey: todosQueryKey })).toBe(false);

    // 3. WriteQueue mutation options
    const writes: TanStackWriteQueueLike = {
      insert: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({ id: 2 })),
      delete: vi.fn(async () => ({ id: 3 })),
      flush: vi.fn(async () => undefined),
    };

    const mutation = createWriteQueueMutationOptions(writes, {
      queryClient,
      flushImmediately: true,
    });
    await mutation.mutationFn({
      operation: 'insert',
      table: 'TODOS',
      value: { ID: 10, TITLE: 'Queued item' },
    });

    expect(writes.insert).toHaveBeenCalledWith('TODOS', { ID: 10, TITLE: 'Queued item' });
    expect(writes.flush).toHaveBeenCalledTimes(1);
    expect(invalidatedPredicates.length).toBe(3);
    expect(invalidatedPredicates[2]({ queryKey: todosQueryKey })).toBe(true);

    await bridge.close();
  });

  it('supports TanStack DB local-first collection CRUD, subscriptions, and sync protocol', async () => {
    const db = createMockDb();
    db.tables.set('ITEMS', [{ ID: 'a', NAME: 'Alpha' }]);

    const writes: TanStackWriteQueueLike = {
      insert: vi.fn(async (table, value) => {
        await db.execute!(
          `INSERT INTO ${table} (ID, NAME) VALUES (?, ?)`,
          [value.ID as string, value.NAME as string],
        );
      }),
      update: vi.fn(async (table, key, value) => {
        await db.execute!(
          `UPDATE ${table} SET NAME = ? WHERE ID = ?`,
          [value.NAME as string, key.ID as string],
        );
      }),
      delete: vi.fn(async (table, key) => {
        await db.execute!(
          `DELETE FROM ${table} WHERE ID = ?`,
          [key.ID as string],
        );
      }),
    };

    const collection = createFirebirdCollection<{ ID: string; NAME: string }>(db, {
      table: 'ITEMS',
      primaryKey: 'ID',
      writes,
    });

    const syncOps: Array<{ type: string; key?: string; value?: unknown }> = [];
    const stopSync = collection.tanstackSync.sync({
      begin: () => undefined,
      write: (op) => syncOps.push(op),
      commit: () => undefined,
    });

    const all = await collection.getAll();
    expect(all).toEqual([{ ID: 'a', NAME: 'Alpha' }]);

    await collection.insert({ ID: 'b', NAME: 'Beta' });
    expect(writes.insert).toHaveBeenCalledTimes(1);
    expect(await collection.get('b')).toEqual({ ID: 'b', NAME: 'Beta' });

    await collection.update('b', { NAME: 'Beta v2' });
    expect(writes.update).toHaveBeenCalledTimes(1);
    expect(await collection.get('b')).toEqual({ ID: 'b', NAME: 'Beta v2' });

    const deleted = await collection.delete('a');
    expect(deleted).toBe(true);
    expect(writes.delete).toHaveBeenCalledTimes(1);
    expect(collection.items).toEqual([{ ID: 'b', NAME: 'Beta v2' }]);

    expect(syncOps.some((op) => op.type === 'insert' && op.key === 'b')).toBe(true);
    expect(syncOps.some((op) => op.type === 'update' && op.key === 'b')).toBe(true);
    expect(syncOps.some((op) => op.type === 'delete' && op.key === 'a')).toBe(true);

    stopSync();
    await collection.close();
  });
});

// ---------------------------------------------------------------------------
// 2. RxDB Storage Adapter (`firebird-wasm/rxdb`) Tests
// ---------------------------------------------------------------------------

interface HeroDoc {
  id: string;
  name: string;
  level: number;
  tags?: string[];
}

function makeRxDoc(
  doc: HeroDoc,
  rev = '1-abc',
  deleted = false,
  lwt = 1000,
): RxDocumentData<HeroDoc> {
  return {
    ...doc,
    _rev: rev,
    _deleted: deleted,
    _meta: { lwt },
    _attachments: {},
  };
}

describe('firebird-wasm/rxdb – RxDB Storage Adapter', () => {
  it('supports bulkWrite with revision conflict detection, findDocumentsById, Mango query, count, checkpoints, and changeStream', async () => {
    const db = createMockDb();
    const writesBridge = {
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    const storage = getRxStorageFirebird({
      database: db,
      writes: writesBridge,
    });

    const instance = await storage.createStorageInstance<HeroDoc>({
      databaseName: 'heroesdb',
      collectionName: 'heroes',
      schema: {
        version: 0,
        primaryKey: 'id',
      },
    });

    const streamEvents: string[] = [];
    const sub = instance.changeStream().subscribe((bulk) => {
      for (const ev of bulk.events) {
        streamEvents.push(`${ev.operation}:${ev.documentId}`);
      }
    });

    const aliceV1 = makeRxDoc({ id: 'alice', name: 'Alice', level: 10 }, '1-a', false, 1001);
    const bobV1 = makeRxDoc({ id: 'bob', name: 'Bob', level: 25 }, '1-b', false, 1002);
    const charlieV1 = makeRxDoc({ id: 'charlie', name: 'Charlie', level: 5 }, '1-c', false, 1003);

    // 1. Initial bulk insert
    const writeRes1 = await instance.bulkWrite([
      { document: aliceV1 },
      { document: bobV1 },
      { document: charlieV1 },
    ]);
    expect(Object.keys(writeRes1.success)).toEqual(['alice', 'bob', 'charlie']);
    expect(Object.keys(writeRes1.error)).toEqual([]);
    expect(writesBridge.insert).toHaveBeenCalledTimes(3);

    // 2. Duplicate insert without `previous` -> 409 conflict
    const duplicateAlice = makeRxDoc({ id: 'alice', name: 'Alice Dup', level: 99 }, '1-dup');
    const conflictRes = await instance.bulkWrite([{ document: duplicateAlice }]);
    expect(conflictRes.error.alice?.status).toBe(409);
    expect(conflictRes.error.alice?.documentInDb.name).toBe('Alice');

    // 3. Valid update with matching `previous._rev`
    const aliceV2 = makeRxDoc({ id: 'alice', name: 'Alice Master', level: 30 }, '2-a', false, 1005);
    const updateRes = await instance.bulkWrite([
      { previous: aliceV1, document: aliceV2 },
    ]);
    expect(updateRes.success.alice?.level).toBe(30);
    expect(writesBridge.update).toHaveBeenCalledTimes(1);

    // 4. findDocumentsById
    const byId = await instance.findDocumentsById(['alice', 'bob', 'missing']);
    expect(Object.keys(byId)).toEqual(['alice', 'bob']);
    expect(byId.alice.name).toBe('Alice Master');

    // 5. Mango query with $gte + sort + limit
    const prepared = storage.statics.prepareQuery(instance.schema, {
      selector: {
        level: { $gte: 10 },
      },
      sort: [{ level: 'desc' }],
    });
    const queryRes = await instance.query(prepared);
    expect(queryRes.documents.map((d) => d.id)).toEqual(['alice', 'bob']);

    const countRes = await instance.count(prepared);
    expect(countRes.count).toBe(2);

    // 6. Checkpoints (`getChangedDocumentsSince`)
    const changes1 = await instance.getChangedDocumentsSince(2);
    expect(changes1.documents.length).toBe(2);
    const changes2 = await instance.getChangedDocumentsSince(10, changes1.checkpoint);
    expect(changes2.documents.length).toBe(1);
    expect(changes2.documents[0].id).toBe('alice');

    // 7. Soft-delete and cleanup
    const charlieDeleted = makeRxDoc(
      { id: 'charlie', name: 'Charlie', level: 5 },
      '2-c',
      true,
      500,
    );
    await instance.bulkWrite([{ previous: charlieV1, document: charlieDeleted }]);
    expect(writesBridge.delete).toHaveBeenCalledTimes(1);

    const withoutDeleted = await instance.findDocumentsById(['charlie'], false);
    expect(withoutDeleted.charlie).toBeUndefined();
    const withDeleted = await instance.findDocumentsById(['charlie'], true);
    expect(withDeleted.charlie?._deleted).toBe(true);

    await instance.cleanup(1000);
    expect(streamEvents).toEqual([
      'INSERT:alice',
      'INSERT:bob',
      'INSERT:charlie',
      'UPDATE:alice',
      'DELETE:charlie',
    ]);

    sub.unsubscribe();
    await instance.remove();
  });

  it('evaluates complex Mango selectors ($and, $or, $in, $regex)', () => {
    const doc = {
      id: '1',
      name: 'Firebird SQL',
      meta: { tier: 'pro', score: 95 },
    };

    expect(
      matchesMangoSelector(doc, {
        $and: [
          { 'meta.tier': { $in: ['free', 'pro'] } },
          { 'meta.score': { $gt: 90 } },
          { name: { $regex: /^Firebird/i } },
        ],
      }),
    ).toBe(true);

    expect(
      matchesMangoSelector(doc, {
        $or: [{ 'meta.score': { $lt: 50 } }, { 'meta.tier': 'enterprise' }],
      }),
    ).toBe(false);
  });
});
