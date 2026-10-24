import { Kysely, sql } from 'kysely';
import type { Generated } from 'kysely';
import {
  FirebirdDialect,
  createKysely,
} from '../kysely';
import type {
  FirebirdKyselyDatabase,
  FirebirdKyselyTransaction,
} from '../kysely';
import type { FirebirdBrowser } from '../browser/firebird-browser';
import type { FirebirdLite } from '../firebird';
import type { QueryParams, QueryResult, Row, TransactionOptions } from '../types';

// Static type assertion: both FirebirdBrowser and FirebirdLite satisfy FirebirdKyselyDatabase.
const _assertBrowserCompatible: (b: FirebirdBrowser) => FirebirdKyselyDatabase = (b) => b;
const _assertNodeCompatible: (n: FirebirdLite) => FirebirdKyselyDatabase = (n) => n;
void _assertBrowserCompatible;
void _assertNodeCompatible;

interface TestDatabase {
  items: {
    id: Generated<number>;
    title: string;
    done: boolean;
    camelCol?: string | null;
  };
  pairs: {
    a: number;
    b: string;
    val: string;
  };
}

class FakeFirebird implements FirebirdKyselyDatabase {
  readonly calls: Array<{
    kind: 'query' | 'exec' | 'stream' | 'tx';
    sql?: string;
    params?: QueryParams;
    txOptions?: TransactionOptions;
  }> = [];
  nextQueryRows: Row[] = [];
  nextAffectedRows = 1;
  rolledBack = false;
  closed = false;

  async query<T = Row>(sqlText: string, params?: QueryParams): Promise<QueryResult<T>> {
    this.calls.push({ kind: 'query', sql: sqlText, params });
    return {
      rows: this.nextQueryRows as unknown as T[],
      fields: [],
    };
  }

  async exec(sqlText: string, params?: QueryParams): Promise<{ affectedRows: number }> {
    this.calls.push({ kind: 'exec', sql: sqlText, params });
    return { affectedRows: this.nextAffectedRows };
  }

  async transaction<T>(
    fn: (tx: FirebirdKyselyTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    this.calls.push({ kind: 'tx', txOptions: options });
    const tx: FirebirdKyselyTransaction = {
      query: (s, p) => this.query(s, p),
      exec: (s, p) => this.exec(s, p),
      rollback: async () => {
        this.rolledBack = true;
      },
      queryStream: (s, p, o) => this.queryStream(s, p, o),
    };
    return fn(tx);
  }

  async *queryStream<T = Row>(
    sqlText: string,
    params?: QueryParams,
    options?: { batchSize?: number },
  ): AsyncIterableIterator<QueryResult<T>> {
    this.calls.push({ kind: 'stream', sql: sqlText, params });
    const batchSize = options?.batchSize ?? 2;
    for (let i = 0; i < this.nextQueryRows.length; i += batchSize) {
      yield {
        rows: this.nextQueryRows.slice(i, i + batchSize) as unknown as T[],
        fields: [],
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('firebird-wasm/kysely', () => {
  it('compiles SELECT queries with Firebird ? placeholders, uppercase identifier folding, and OFFSET/FETCH pagination', async () => {
    const fb = new FakeFirebird();
    fb.nextQueryRows = [
      { ID: 1, TITLE: 'Alpha', DONE: false, camelCol: 'keepMe' },
    ];
    const db = createKysely<TestDatabase>(fb);

    // limit + offset (even when .limit() is called before .offset()) -> OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    const rows = await db
      .selectFrom('items')
      .select(['id', 'title', 'done', 'camelCol'])
      .where('done', '=', false)
      .orderBy('id', 'asc')
      .limit(5)
      .offset(10)
      .execute();

    expect(fb.calls).toEqual([
      {
        kind: 'query',
        sql: 'select "ID", "TITLE", "DONE", "camelCol" from "ITEMS" where "DONE" = ? order by "ID" asc offset ? rows fetch next ? rows only',
        params: [false, 10, 5],
      },
    ]);
    expect(rows).toEqual([
      { id: 1, title: 'Alpha', done: false, camelCol: 'keepMe' },
    ]);

    // limit alone -> FETCH NEXT ? ROWS ONLY
    fb.calls.length = 0;
    await db.selectFrom('items').selectAll().limit(3).execute();
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'select * from "ITEMS" fetch next ? rows only',
      params: [3],
    });

    // offset alone -> OFFSET ? ROWS
    fb.calls.length = 0;
    await db.selectFrom('items').selectAll().offset(4).execute();
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'select * from "ITEMS" offset ? rows',
      params: [4],
    });
  });

  it('supports single-row INSERT, multi-row INSERT via RDB$DATABASE, RETURNING, and UPDATE OR INSERT MATCHING', async () => {
    const fb = new FakeFirebird();
    const db = createKysely<TestDatabase>(fb);

    // Single-row INSERT without RETURNING uses exec() and returns numAffectedRows
    fb.nextAffectedRows = 1;
    const single = await db
      .insertInto('items')
      .values({ title: 'One', done: false })
      .executeTakeFirst();
    expect(single.numInsertedOrUpdatedRows).toBe(1n);
    expect(fb.calls[0]).toEqual({
      kind: 'exec',
      sql: 'insert into "ITEMS" ("TITLE", "DONE") values (?, ?)',
      params: ['One', false],
    });

    // Multi-row INSERT compiles to SELECT ... FROM RDB$DATABASE UNION ALL ...
    fb.calls.length = 0;
    fb.nextAffectedRows = 2;
    const multi = await db
      .insertInto('items')
      .values([
        { title: 'Two', done: false },
        { title: 'Three', done: true },
      ])
      .executeTakeFirst();
    expect(multi.numInsertedOrUpdatedRows).toBe(2n);
    expect(fb.calls[0]).toEqual({
      kind: 'exec',
      sql: 'insert into "ITEMS" ("TITLE", "DONE") select ?, ? from rdb$database union all select ?, ? from rdb$database',
      params: ['Two', false, 'Three', true],
    });

    // When execBatch is available (as on FirebirdLite and FirebirdBrowser),
    // multi-row INSERT routes through execBatch('insert into ... values (?, ?)', rows)
    // to avoid Firebird's -804 Data type unknown on untyped SELECT ? FROM RDB$DATABASE.
    const batchCalls: Array<{ sql: string; rows: QueryParams[] }> = [];
    (fb as FirebirdKyselyDatabase).execBatch = async (sqlText, rows) => {
      batchCalls.push({ sql: sqlText, rows });
      return { affectedRows: rows.length };
    };
    const batchRes = await db
      .insertInto('items')
      .values([
        { title: 'Four', done: false },
        { title: 'Five', done: true },
      ])
      .executeTakeFirst();
    expect(batchRes.numInsertedOrUpdatedRows).toBe(2n);
    expect(batchCalls).toEqual([
      {
        sql: 'insert into "ITEMS" ("TITLE", "DONE") values (?, ?)',
        rows: [
          ['Four', false],
          ['Five', true],
        ],
      },
    ]);
    delete (fb as FirebirdKyselyDatabase).execBatch;

    // INSERT ... RETURNING uses query() and maps uppercase keys back to lowercase
    fb.calls.length = 0;
    fb.nextQueryRows = [{ ID: 42, TITLE: 'Returned' }];
    const inserted = await db
      .insertInto('items')
      .values({ title: 'Returned', done: false })
      .returning(['id', 'title'])
      .executeTakeFirstOrThrow();
    expect(inserted).toEqual({ id: 42, title: 'Returned' });
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'insert into "ITEMS" ("TITLE", "DONE") values (?, ?) returning "ID", "TITLE"',
      params: ['Returned', false],
    });

    // Upsert via onConflict -> UPDATE OR INSERT INTO ... VALUES (...) MATCHING (...)
    fb.calls.length = 0;
    fb.nextQueryRows = [{ ID: 1, TITLE: 'Upserted' }];
    const upserted = await db
      .insertInto('items')
      .values({ id: 1, title: 'Upserted', done: true })
      .onConflict((oc) => oc.column('id').doUpdateSet({ title: 'Upserted' }))
      .returning(['id', 'title'])
      .executeTakeFirstOrThrow();
    expect(upserted).toEqual({ id: 1, title: 'Upserted' });
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'update or insert into "ITEMS" ("ID", "TITLE", "DONE") values (?, ?, ?) matching ("ID") returning "ID", "TITLE"',
      params: [1, 'Upserted', true],
    });
  });

  it('compiles UPDATE and DELETE with RETURNING and Firebird ROWS limit', async () => {
    const fb = new FakeFirebird();
    const db = createKysely<TestDatabase>(fb);

    fb.nextQueryRows = [{ ID: 5, TITLE: 'Edited', DONE: true }];
    const updated = await db
      .updateTable('items')
      .set({ title: 'Edited', done: true })
      .where('id', '=', 5)
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(updated).toEqual({ id: 5, title: 'Edited', done: true });
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'update "ITEMS" set "TITLE" = ?, "DONE" = ? where "ID" = ? returning *',
      params: ['Edited', true, 5],
    });

    fb.calls.length = 0;
    await db.deleteFrom('items').where('done', '=', true).limit(10).execute();
    expect(fb.calls[0]).toEqual({
      kind: 'exec',
      sql: 'delete from "ITEMS" where "DONE" = ? rows ?',
      params: [true, 10],
    });
  });

  it('compiles Firebird DDL: identity columns, data type mapping, global temporary tables, and ALTER TABLE', async () => {
    const fb = new FakeFirebird();
    const db = createKysely<TestDatabase>(fb);

    await db.schema
      .createTable('items')
      .addColumn('id', 'integer', (c) => c.autoIncrement().primaryKey())
      .addColumn('title', 'varchar(80)', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('raw', 'bytea')
      .addColumn('created_at', 'timestamptz')
      .execute();

    expect(fb.calls[0]?.sql).toBe(
      'create table "ITEMS" ("ID" integer generated by default as identity primary key, "TITLE" varchar(80) not null, "NOTE" blob sub_type text, "RAW" blob sub_type binary, "CREATED_AT" timestamp with time zone)',
    );

    fb.calls.length = 0;
    await db.schema
      .createTable('temp_items')
      .temporary()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .onCommit('delete rows')
      .execute();
    expect(fb.calls[0]?.sql).toBe(
      'create global temporary table "TEMP_ITEMS" ("ID" integer generated by default as identity primary key) on commit delete rows',
    );

    fb.calls.length = 0;
    await db.schema.alterTable('items').addColumn('extra', 'integer').execute();
    await db.schema.alterTable('items').renameColumn('extra', 'more').execute();
    await db.schema.alterTable('items').dropColumn('more').execute();
    expect(fb.calls.map((c) => c.sql)).toEqual([
      'alter table "ITEMS" add "EXTRA" integer',
      'alter table "ITEMS" alter column "EXTRA" to "MORE"',
      'alter table "ITEMS" drop "MORE"',
    ]);
  });

  it('runs transactions with isolation level mapping, rollback, and streaming over queryStream', async () => {
    const fb = new FakeFirebird();
    const db = new Kysely<TestDatabase>({
      dialect: new FirebirdDialect({
        database: () => Promise.resolve(fb),
        closeOnDestroy: true,
      }),
    });

    await db
      .transaction()
      .setIsolationLevel('snapshot')
      .setAccessMode('read only')
      .execute(async (trx) => {
        await trx.selectFrom('items').selectAll().execute();
      });

    expect(fb.calls[0]).toEqual({
      kind: 'tx',
      txOptions: { isolationLevel: 'SNAPSHOT', readOnly: true },
    });

    // Rollback when callback throws
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('items').values({ title: 'Rollback me', done: false }).execute();
        throw new Error('abort tx');
      }),
    ).rejects.toThrow('abort tx');
    expect(fb.rolledBack).toBe(true);

    // Streaming via queryStream
    fb.calls.length = 0;
    fb.nextQueryRows = [
      { ID: 1, TITLE: 'A', DONE: false },
      { ID: 2, TITLE: 'B', DONE: true },
      { ID: 3, TITLE: 'C', DONE: false },
    ];
    const streamed: Array<{ id: number; title: string; done: boolean }> = [];
    for await (const row of db.selectFrom('items').selectAll().stream(2)) {
      streamed.push(row);
    }
    expect(streamed).toEqual([
      { id: 1, title: 'A', done: false },
      { id: 2, title: 'B', done: true },
      { id: 3, title: 'C', done: false },
    ]);
    expect(fb.calls[0]?.kind).toBe('stream');

    // sql template tag
    fb.calls.length = 0;
    fb.nextQueryRows = [{ N: 7 }];
    const raw = await sql<{ n: number }>`SELECT ${7} AS n FROM RDB$DATABASE`.execute(db);
    expect(raw.rows).toEqual([{ n: 7 }]);

    await db.destroy();
    expect(fb.closed).toBe(true);
  });

  it('introspects Firebird system tables into TableMetadata', async () => {
    const fb = new FakeFirebird();
    const origQuery = fb.query.bind(fb);
    fb.query = async <T = Row>(sqlText: string, params?: QueryParams): Promise<QueryResult<T>> => {
      if (sqlText.includes('FROM RDB$RELATIONS')) {
        return {
          rows: [
            { name: 'ITEMS   ', is_view: 0 },
            { name: 'KYSELY_MIGRATION', is_view: 0 },
          ] as unknown as T[],
          fields: [],
        };
      }
      if (sqlText.includes('FROM RDB$RELATION_FIELDS')) {
        return {
          rows: [
            {
              relation_name: 'ITEMS',
              field_name: 'ID',
              field_type: 8,
              field_sub_type: 0,
              field_scale: 0,
              null_flag: 1,
              has_default: 0,
              is_identity: 1,
            },
            {
              relation_name: 'ITEMS',
              field_name: 'PRICE',
              field_type: 16,
              field_sub_type: 1,
              field_scale: -2,
              null_flag: 0,
              has_default: 1,
              is_identity: 0,
            },
          ] as unknown as T[],
          fields: [],
        };
      }
      return origQuery(sqlText, params);
    };

    const db = createKysely<TestDatabase>(fb);
    const tables = await db.introspection.getTables();
    expect(tables).toEqual([
      {
        name: 'items',
        isView: false,
        columns: [
          {
            name: 'id',
            dataType: 'integer',
            isNullable: false,
            isAutoIncrementing: true,
            hasDefaultValue: true,
          },
          {
            name: 'price',
            dataType: 'numeric',
            isNullable: true,
            isAutoIncrementing: false,
            hasDefaultValue: true,
          },
        ],
      },
    ]);
  });
});
