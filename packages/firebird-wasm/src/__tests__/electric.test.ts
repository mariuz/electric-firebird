/**
 * electric.test.ts – firebird-wasm/electric against a scripted shape stream.
 *
 * The stream is a stand-in the test feeds by hand, so the orderings that
 * matter can be forced: batches before up-to-date, a must-refetch, a failed
 * transaction, a resume.  The database records what each transaction ran.
 * The same code runs against a real Postgres and Electric, in Chromium with
 * the real engine, in e2e/tests/browser-electric.spec.ts.
 */

import { syncShapeToTable, syncShapesToTables, tableFromSchema, toFirebird, firebirdColumn, firebirdName, checkSchema } from '../electric';
import { planColumn } from '../electric-server/catalog';
import type { ElectricDatabase, ElectricSchema, ElectricTransaction } from '../electric';
import type { FirebirdBrowser } from '../browser/firebird-browser';

// FirebirdBrowser is what apps pass; this fails to compile if it stops fitting.
const fits: (db: FirebirdBrowser) => ElectricDatabase = (db) => db;
void fits;

const SCHEMA: ElectricSchema = {
  id: { type: 'int4', pk_index: 0, not_null: true },
  title: { type: 'text' },
  done: { type: 'bool' },
};

/** A database that records each committed transaction's statements. */
class FakeDb implements ElectricDatabase {
  committed: Array<Array<{ sql: string; params: unknown[] }>> = [];
  metadata = new Map<string, { handle: string; offset: string; schema: string }>();
  hasMetadataTable = false;
  failNext: Error | null = null;

  async transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T> {
    const ran: Array<{ sql: string; params: unknown[] }> = [];
    const writes = new Map(this.metadata);
    const tx: ElectricTransaction = {
      exec: async (sql, params = []) => {
        if (this.failNext) {
          const e = this.failNext;
          this.failNext = null;
          throw e;
        }
        ran.push({ sql, params });
        if (sql.includes('ELECTRIC_SHAPES') && sql.startsWith('UPDATE OR INSERT')) {
          writes.set(String(params[0]), {
            handle: String(params[1]), offset: String(params[2]), schema: String(params[3]),
          });
        }
        if (sql.startsWith('CREATE TABLE "ELECTRIC_SHAPES"')) this.hasMetadataTable = true;
        return { affectedRows: 1 };
      },
      execBatch: async (sql, rows) => {
        for (const params of rows) ran.push({ sql, params });
        return { affectedRows: rows.length };
      },
      query: async (sql, params = []) => {
        if (sql.includes('RDB$RELATIONS')) return { rows: this.hasMetadataTable ? [{ X: 1 }] : [] };
        const saved = this.metadata.get(String(params[0]));
        return {
          rows: saved
            ? [{ SHAPE_HANDLE: saved.handle, SHAPE_OFFSET: saved.offset, SHAPE_SCHEMA: saved.schema }]
            : [],
        };
      },
    };
    const result = await fn(tx);
    this.metadata = writes;
    if (ran.length > 0) this.committed.push(ran);
    return result;
  }

  /** The data statements of the last commit, without the bookkeeping. */
  lastData(): string[] {
    const last = this.committed[this.committed.length - 1] ?? [];
    return last
      .filter((s) => !s.sql.includes('ELECTRIC_SHAPES') && !s.sql.startsWith('EXECUTE BLOCK'))
      .map((s) => `${s.sql} ${JSON.stringify(s.params, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
  }
}

/** A ShapeStream the test drives: `deliver()` hands messages to the subscriber. */
function scriptedStream() {
  const created: Array<{ options: Record<string, unknown>; instance: FakeStream }> = [];
  class FakeStream {
    shapeHandle: string | undefined = 'h1';
    lastOffset = '0_0';
    private callback: ((m: unknown[]) => Promise<void>) | null = null;
    constructor(readonly options: Record<string, unknown>) {
      created.push({ options, instance: this });
    }
    subscribe(cb: (m: unknown[]) => Promise<void>) {
      this.callback = cb;
      return () => undefined;
    }
    unsubscribeAll() {
      this.callback = null;
    }
    refreshes = 0;
    async forceDisconnectAndRefresh() {
      this.refreshes++;
    }
    /** Simulate a response: its schema header, then its messages. */
    async deliver(messages: unknown[], offset: string, schema?: ElectricSchema) {
      if (schema) {
        // Run the sync's fetch wrapper over a response carrying the header.
        await wrapFetch(this.options['fetchClient'] as typeof fetch, async () =>
          new Response('[]', { headers: { 'electric-schema': JSON.stringify(schema) } }));
      }
      this.lastOffset = offset;
      await this.callback?.(messages);
    }
    get subscribed() {
      return this.callback !== null;
    }
  }
  return { FakeStream, created };
}

/** Call the sync's fetchClient with a base fetch swapped in for the test. */
async function wrapFetch(fetchClient: typeof fetch, base: () => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = base as unknown as typeof fetch;
  try {
    await fetchClient('http://electric.test/v1/shape');
  } finally {
    globalThis.fetch = original;
  }
}

const insert = (value: Record<string, unknown>) => ({ headers: { operation: 'insert' }, key: String(value['id']), value });
const update = (value: Record<string, unknown>) => ({ headers: { operation: 'update' }, key: String(value['id']), value });
const del = (id: string) => ({ headers: { operation: 'delete' }, key: id, value: { id } });
const upToDate = { headers: { control: 'up-to-date' } };
const mustRefetch = { headers: { control: 'must-refetch' } };

async function start(db: FakeDb, shapeKey: string | null = 'items', extra: Record<string, unknown> = {}) {
  const { FakeStream, created } = scriptedStream();
  const errors: Error[] = [];
  const sync = await syncShapeToTable(db, {
    shape: { url: 'http://electric.test/v1/shape', params: { table: 'items' } },
    table: 'items',
    shapeKey,
    onError: (e) => errors.push(e),
    ShapeStream: FakeStream as never,
    ...extra,
  });
  return { sync, stream: created[0]!.instance, options: created[0]!.options, errors };
}

describe('syncShapeToTable', () => {
  it('applies nothing until up-to-date, then everything in one transaction with the position', async () => {
    const db = new FakeDb();
    const { sync, stream } = await start(db);

    await stream.deliver([insert({ id: '1', title: 'a', done: 'true' })], '0_0', SCHEMA);
    expect(db.committed.filter((t) => t.some((s) => s.sql.includes('"ITEMS"')))).toHaveLength(0);
    expect(sync.isUpToDate).toBe(false);

    await stream.deliver([insert({ id: '2', title: 'b', done: 'f' }), upToDate], '10_2');
    await sync.upToDate;
    expect(db.lastData()).toEqual([
      'DELETE FROM "ITEMS" []',
      'UPDATE OR INSERT INTO "ITEMS" ("ID", "TITLE", "DONE") VALUES (?, ?, ?) MATCHING ("ID") [1,"a",true]',
      'UPDATE OR INSERT INTO "ITEMS" ("ID", "TITLE", "DONE") VALUES (?, ?, ?) MATCHING ("ID") [2,"b",false]',
    ]);
    expect(db.metadata.get('items')).toEqual({ handle: 'h1', offset: '10_2', schema: JSON.stringify(SCHEMA) });
    const last = db.committed[db.committed.length - 1]!;
    expect(last[last.length - 1]).toEqual({
      sql: 'EXECUTE BLOCK (event_name VARCHAR(127) = ?) AS BEGIN POST_EVENT :event_name; END',
      params: ['electric_items'],
    });
    expect(sync.isUpToDate).toBe(true);
  });

  it('applies partial updates and deletes by key', async () => {
    const db = new FakeDb();
    const { stream } = await start(db);
    await stream.deliver([insert({ id: '1', title: 'a', done: 'true' }), upToDate], '1_0', SCHEMA);
    await stream.deliver([update({ id: '1', done: 'f' }), del('1'), upToDate], '2_0');
    expect(db.lastData()).toEqual([
      'UPDATE "ITEMS" SET "DONE" = ? WHERE "ID" = ? [false,1]',
      'DELETE FROM "ITEMS" WHERE "ID" = ? [1]',
    ]);
  });

  it('applies replica=full updates: upserts full rows and deletes old keys on key changes', async () => {
    const db = new FakeDb();
    const { stream } = await start(db);
    await stream.deliver([insert({ id: '1', title: 'a', done: 'true' }), upToDate], '1_0', SCHEMA);
    await stream.deliver(
      [
        {
          headers: { operation: 'update' },
          key: '1',
          value: { id: '1', title: 'updated', done: 'false' },
          old_value: { title: 'a', done: 'true' },
        },
        {
          headers: { operation: 'update' },
          key: '2',
          value: { id: '2', title: 'rekeyed', done: 'true' },
          old_value: { id: '1' },
        },
        upToDate,
      ],
      '2_0',
    );
    expect(db.lastData()).toEqual([
      'UPDATE OR INSERT INTO "ITEMS" ("ID", "TITLE", "DONE") VALUES (?, ?, ?) MATCHING ("ID") [1,"updated",false]',
      'DELETE FROM "ITEMS" WHERE "ID" = ? [1]',
      'UPDATE OR INSERT INTO "ITEMS" ("ID", "TITLE", "DONE") VALUES (?, ?, ?) MATCHING ("ID") [2,"rekeyed",true]',
    ]);
  });

  it('resumes from the stored position, and does not empty the table', async () => {
    const db = new FakeDb();
    const first = await start(db);
    await first.stream.deliver([insert({ id: '1', title: 'a', done: 't' }), upToDate], '5_1', SCHEMA);
    await first.sync.unsubscribe();
    expect(first.stream.subscribed).toBe(false);

    const second = await start(db);
    expect(second.options).toMatchObject({ handle: 'h1', offset: '5_1' });
    // No schema header on a live response: the stored one is used.
    await second.stream.deliver([insert({ id: '2', title: 'b', done: 't' }), upToDate], '6_0');
    expect(db.lastData()).toEqual([
      'UPDATE OR INSERT INTO "ITEMS" ("ID", "TITLE", "DONE") VALUES (?, ?, ?) MATCHING ("ID") [2,"b",true]',
    ]);
  });

  it('on must-refetch drops what it held and reloads the table in one transaction', async () => {
    const db = new FakeDb();
    const { stream } = await start(db);
    await stream.deliver([insert({ id: '1', title: 'a', done: 't' }), upToDate], '1_0', SCHEMA);
    await stream.deliver([update({ id: '1', title: 'stale' })], '2_0');
    await stream.deliver([mustRefetch], '-1');
    await stream.deliver([insert({ id: '7', title: 'fresh', done: 'f' }), upToDate], '9_0', SCHEMA);
    expect(db.lastData()).toEqual([
      'DELETE FROM "ITEMS" []',
      'UPDATE OR INSERT INTO "ITEMS" ("ID", "TITLE", "DONE") VALUES (?, ?, ?) MATCHING ("ID") [7,"fresh",false]',
    ]);
  });

  it('stops on a failed transaction, keeps the old position, and says why', async () => {
    const db = new FakeDb();
    const { sync, stream, errors } = await start(db);
    await stream.deliver([insert({ id: '1', title: 'a', done: 't' }), upToDate], '1_0', SCHEMA);
    db.failNext = new Error('lock conflict');
    await stream.deliver([insert({ id: '2', title: 'b', done: 't' }), upToDate], '2_0');
    expect(errors.map((e) => e.message)).toEqual(['lock conflict']);
    expect(sync.error?.message).toBe('lock conflict');
    expect(stream.subscribed).toBe(false);
    expect(db.metadata.get('items')?.offset).toBe('1_0');
  });

  it('refuses a shape with a column it cannot store, before storing any row', async () => {
    const db = new FakeDb();
    const { sync, stream, errors } = await start(db);
    await stream.deliver(
      [insert({ id: '1', blob: '\\x00' }), upToDate], '1_0',
      { id: { type: 'int4', pk_index: 0 }, span: { type: 'tsrange' }, at: { type: 'interval' } },
    );
    await expect(sync.upToDate).rejects.toThrow(/span \(tsrange\)[\s\S]*at \(interval\)/);
    expect(errors).toHaveLength(1);
    expect(db.committed.filter((t) => t.some((s) => s.sql.includes('"ITEMS"')))).toHaveLength(0);
  });

  it('without a shape key, starts over every time', async () => {
    const db = new FakeDb();
    const { stream, options } = await start(db, null);
    expect(options).not.toHaveProperty('offset');
    await stream.deliver([upToDate], '1_0', SCHEMA);
    expect(db.lastData()).toEqual(['DELETE FROM "ITEMS" []']);
    expect(db.metadata.size).toBe(0);
  });

  it('keeps every value as Postgres text, for the sync to convert', async () => {
    const { options } = await start(new FakeDb());
    const parser = options['parser'] as Record<string, (v: string) => unknown>;
    for (const type of ['int2', 'int4', 'int8', 'float4', 'float8', 'bool', 'json', 'jsonb']) {
      expect(parser[type]!('t')).toBe('t');
    }
  });
});

describe('syncShapesToTables', () => {
  const TAGS: ElectricSchema = { id: { type: 'int4', pk_index: 0, not_null: true }, item: { type: 'int4' } };
  const at = (lsn: string) => ({ headers: { control: 'up-to-date', global_last_seen_lsn: lsn } });
  /** Data statements of every commit, per commit, without the bookkeeping. */
  const commits = (db: FakeDb) => db.committed
    .map((t) => t.filter((s) => /"(ITEMS|TAGS)"/.test(s.sql)).map((s) => s.sql.split(' (')[0]!.replace('UPDATE OR INSERT INTO', 'upsert')))
    .filter((t) => t.length > 0);

  async function startTwo(db: FakeDb, key: string | null = 'app') {
    const { FakeStream, created } = scriptedStream();
    const errors: Error[] = [];
    const sync = await syncShapesToTables(db, {
      shapes: {
        items: { shape: { url: 'http://electric.test/v1/shape', params: { table: 'items' } }, table: 'items' },
        tags: { shape: { url: 'http://electric.test/v1/shape', params: { table: 'tags' } }, table: 'tags' },
      },
      key,
      onError: (e) => errors.push(e),
      ShapeStream: FakeStream as never,
    });
    return { sync, items: created[0]!.instance, tags: created[1]!.instance, created, errors };
  }

  it('commits nothing until every shape is up to date, then all of it in one transaction', async () => {
    const db = new FakeDb();
    const { sync, items, tags } = await startTwo(db);
    await items.deliver([insert({ id: '1', title: 'a', done: 'f' }), upToDate], '1_0', SCHEMA);
    expect(commits(db)).toEqual([]);
    await tags.deliver([insert({ id: '7', item: '1' }), upToDate], '1_0', TAGS);
    await sync.upToDate;
    expect(commits(db)).toEqual([['DELETE FROM "ITEMS"', 'upsert "ITEMS"', 'DELETE FROM "TAGS"', 'upsert "TAGS"']]);
    expect([...db.metadata.keys()].sort()).toEqual(['app:items', 'app:tags']);
    // One event per commit, named after the key.
    expect(db.committed[db.committed.length - 1]!.filter((s) => s.sql.startsWith('EXECUTE BLOCK')).map((s) => s.params))
      .toEqual([['electric_app']]);
  });

  it('waits while a shape is mid-transaction', async () => {
    const db = new FakeDb();
    const { items, tags } = await startTwo(db);
    await items.deliver([upToDate], '1_0', SCHEMA);
    await tags.deliver([upToDate], '1_0', TAGS);
    const before = commits(db).length;
    // tags has a change and no up-to-date yet: items' next batch waits for it.
    await tags.deliver([insert({ id: '8', item: '2' })], '2_0');
    await items.deliver([insert({ id: '2', title: 'b', done: 't' }), upToDate], '2_0');
    expect(commits(db).length).toBe(before);
    await tags.deliver([upToDate], '2_0');
    expect(commits(db).slice(before)).toEqual([['upsert "ITEMS"', 'upsert "TAGS"']]);
  });

  it('holds a batch until every shape has seen the same Postgres position, refreshing one behind', async () => {
    const db = new FakeDb();
    const { items, tags } = await startTwo(db);
    await items.deliver([at('100')], '1_0', SCHEMA);
    await tags.deliver([at('100')], '1_0', TAGS);
    const before = commits(db).length;
    // A transaction wrote to both: items has its part, tags is idle at 100.
    await items.deliver([insert({ id: '3', title: 'c', done: 'f' }), at('120')], '2_0');
    expect(commits(db).length).toBe(before);
    expect(tags.refreshes).toBe(1);
    // Refreshed, tags brings its part of the same transaction.
    await tags.deliver([insert({ id: '9', item: '3' }), at('120')], '2_0');
    expect(commits(db).slice(before)).toEqual([['upsert "ITEMS"', 'upsert "TAGS"']]);
  });

  it('resumes every shape from its own stored position', async () => {
    const db = new FakeDb();
    const first = await startTwo(db);
    await first.items.deliver([upToDate], '5_1', SCHEMA);
    first.tags.shapeHandle = 'h2';
    await first.tags.deliver([upToDate], '6_2', TAGS);
    await first.sync.unsubscribe();

    const second = await startTwo(db);
    expect(second.created.map((c) => [c.options['handle'], c.options['offset']])).toEqual([['h1', '5_1'], ['h2', '6_2']]);
  });

  it('refuses two shapes into one table', async () => {
    await expect(syncShapesToTables(new FakeDb(), {
      shapes: {
        a: { shape: { url: 'http://electric.test/v1/shape' }, table: 'items' },
        b: { shape: { url: 'http://electric.test/v1/shape' }, table: 'ITEMS' },
      },
      key: null,
    })).rejects.toThrow(/table of its own/);
  });
});

describe('values', () => {
  const col = (type: string, extra = {}) => ({ type, ...extra });

  it('converts each mapped type to what Firebird stores exactly', () => {
    expect(toFirebird('42', 'c', col('int4'))).toBe(42);
    expect(toFirebird('9007199254740993', 'c', col('int8'))).toBe('9007199254740993');
    expect(toFirebird('12.50', 'c', col('numeric'))).toBe('12.50');
    expect(toFirebird('1.25E+20', 'c', col('numeric'))).toBe('1.25E+20');
    expect(toFirebird('-1e-30', 'c', col('decfloat'))).toBe('-1e-30');
    expect(toFirebird('0.1', 'c', col('float8'))).toBe(0.1);
    expect(toFirebird('true', 'c', col('bool'))).toBe(true);
    expect(toFirebird('f', 'c', col('bool'))).toBe(false);
    expect(toFirebird('2024-02-29', 'c', col('date'))).toBe('2024-02-29');
    expect(toFirebird('13:45:01.123456', 'c', col('time'))).toBe('13:45:01.1234');
    expect(toFirebird('2024-05-01 12:00:00.123456', 'c', col('timestamp'))).toBe('2024-05-01 12:00:00.1234');
    expect(toFirebird('2024-05-01 10:00:00+00', 'c', col('timestamptz'))).toBe('2024-05-01 10:00:00 +00:00');
    expect(toFirebird('10:00:00+05:30', 'c', col('timetz'))).toBe('10:00:00 +05:30');
    expect(toFirebird('{"a": [1, 2]}', 'c', col('jsonb'))).toBe('{"a": [1, 2]}');
    expect(toFirebird(['a', 'b,c', null], 'c', col('text', { dims: 1 }))).toBe('["a","b,c",null]');
    expect(toFirebird(null, 'c', col('int4'))).toBeNull();
    expect(toFirebird('\\x00ff800a', 'c', col('bytea'))).toEqual(new Uint8Array([0, 0xff, 0x80, 0x0a]));
    expect(toFirebird('\\x', 'c', col('bytea'))).toEqual(new Uint8Array(0));
  });

  it('refuses values Firebird cannot hold, naming the column', () => {
    expect(() => toFirebird('NaN', 'ratio', col('float8'))).toThrow(/ratio holds NaN/);
    expect(() => toFirebird('NaN', 'price', col('numeric'))).toThrow(/price holds NaN/);
    expect(() => toFirebird('infinity', 'day', col('date'))).toThrow(/day holds infinity/);
    expect(() => toFirebird('maybe', 'ok', col('bool'))).toThrow(/ok holds maybe/);
    // bytea_output = 'escape' instead of the default hex.
    expect(() => toFirebird('\\000abc', 'raw', col('bytea'))).toThrow(/raw holds bytea that is not in hex form/);
  });

  it('maps names the way the same unquoted word finds them', () => {
    expect(firebirdColumn('title')).toBe('"TITLE"');
    expect(firebirdColumn('camelCase')).toBe('"camelCase"');
    expect(firebirdName('items')).toBe('"ITEMS"');
    expect(firebirdName('"Mixed"')).toBe('"Mixed"');
    expect(() => firebirdName('bad name')).toThrow(/not a Firebird name/);
  });

  it('accepts every mapped type, and refuses the rest by name', () => {
    expect(() =>
      checkSchema({ a: col('int4'), b: col('text', { dims: 2 }), c: col('uuid'), d: col('decfloat') }),
    ).not.toThrow();
    expect(() => checkSchema({ m: col('money') })).toThrow(/m \(money\)/);
    expect(
      planColumn({
        name: 'DF',
        type: 25,
        subType: 0,
        scale: 0,
        precision: 34,
        charLength: 16,
        notNull: false,
      }),
    ).toEqual({
      name: 'DF',
      shapeName: 'df',
      select: 'CAST("DF" AS VARCHAR(64))',
      render: 'text',
      schema: { type: 'numeric' },
    });
  });

  it('writes a CREATE TABLE for a schema, to review', () => {
    expect(tableFromSchema('items', {
      id: { type: 'uuid', pk_index: 0, not_null: true },
      title: { type: 'varchar', max_length: 80 },
      price: { type: 'numeric', precision: 10, scale: 2 },
      doc: { type: 'jsonb' },
      at: { type: 'timestamptz' },
      raw: { type: 'bytea' },
    })).toBe(
      'CREATE TABLE "ITEMS" (\n' +
        '  "ID" VARCHAR(36) NOT NULL,\n' +
        '  "TITLE" VARCHAR(80),\n' +
        '  "PRICE" NUMERIC(10, 2),\n' +
        '  "DOC" BLOB SUB_TYPE TEXT,\n' +
        '  "AT" TIMESTAMP WITH TIME ZONE,\n' +
        '  "RAW" BLOB SUB_TYPE BINARY,\n' +
        '  PRIMARY KEY ("ID")\n' +
        ')',
    );
  });
});
