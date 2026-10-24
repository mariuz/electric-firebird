import {
  and,
  asc,
  boolean,
  drizzle,
  eq,
  firebirdTable,
  gt,
  integer,
  numeric,
  sql,
  timestamp,
  varchar,
} from '../drizzle';
import type {
  FirebirdDrizzleClient,
  FirebirdDrizzleTransactionClient,
} from '../drizzle';
import type { FirebirdBrowser } from '../browser/firebird-browser';
import type { FirebirdLite } from '../firebird';
import type { ArrayRow, QueryParams, QueryResult, Row, TransactionOptions } from '../types';

// Static type assertion: both FirebirdBrowser and FirebirdLite satisfy FirebirdDrizzleClient.
const _assertBrowserCompatible: (b: FirebirdBrowser) => FirebirdDrizzleClient = (b) => b;
const _assertNodeCompatible: (n: FirebirdLite) => FirebirdDrizzleClient = (n) => n;
void _assertBrowserCompatible;
void _assertNodeCompatible;

const items = firebirdTable('items', {
  id: integer('id').primaryKey(),
  title: varchar('title', { length: 80 }).notNull(),
  done: boolean('done').default(false),
  price: numeric('price', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at'),
});

class FakeDrizzleClient implements FirebirdDrizzleClient {
  readonly calls: Array<{
    kind: 'query' | 'exec' | 'tx';
    sql?: string;
    params?: QueryParams;
    rowMode?: 'object' | 'array';
    txOptions?: TransactionOptions;
  }> = [];
  nextArrayRows: ArrayRow[] = [];
  nextObjectRows: Row[] = [];
  nextAffectedRows = 1;
  rolledBack = false;

  query(
    sqlText: string,
    params: QueryParams | undefined,
    options: { rowMode: 'array' },
  ): Promise<QueryResult<ArrayRow>>;
  query<T = Row>(
    sqlText: string,
    params?: QueryParams,
    options?: { rowMode?: 'object' | 'array' },
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sqlText: string,
    params?: QueryParams,
    options?: { rowMode?: 'object' | 'array' },
  ): Promise<QueryResult<T>> {
    this.calls.push({
      kind: 'query',
      sql: sqlText,
      params,
      rowMode: options?.rowMode,
    });
    if (options?.rowMode === 'array') {
      return {
        rows: this.nextArrayRows as unknown as T[],
        fields: [],
      };
    }
    return {
      rows: this.nextObjectRows as unknown as T[],
      fields: [],
    };
  }

  async exec(sqlText: string, params?: QueryParams): Promise<{ affectedRows: number }> {
    this.calls.push({ kind: 'exec', sql: sqlText, params });
    return { affectedRows: this.nextAffectedRows };
  }

  async transaction<T>(
    fn: (tx: FirebirdDrizzleTransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    this.calls.push({ kind: 'tx', txOptions: options });
    const tx: FirebirdDrizzleTransactionClient = {
      query: ((s: string, p?: QueryParams, o?: { rowMode?: 'object' | 'array' }) =>
        this.query(s, p, o)) as FirebirdDrizzleTransactionClient['query'],
      exec: (s, p) => this.exec(s, p),
      rollback: async () => {
        this.rolledBack = true;
      },
    };
    try {
      return await fn(tx);
    } catch (err) {
      this.rolledBack = true;
      throw err;
    }
  }
}

describe('firebird-wasm/drizzle', () => {
  it('compiles SELECT queries with Firebird ? placeholders, identifier folding, and OFFSET/FETCH pagination', async () => {
    const fb = new FakeDrizzleClient();
    fb.nextArrayRows = [
      [1, 'First', false, '12.50', '2024-05-01T12:00:00.0000'],
    ];
    const db = drizzle(fb, { schema: { items } });
    expect(db.$client).toBe(fb);

    const rows = await db
      .select()
      .from(items)
      .where(and(eq(items.done, false), gt(items.id, 0)))
      .orderBy(asc(items.id))
      .limit(5)
      .offset(10);

    expect(fb.calls).toEqual([
      {
        kind: 'query',
        sql: 'select "ID", "TITLE", "DONE", "PRICE", "CREATED_AT" from "ITEMS" where ("ITEMS"."DONE" = ? and "ITEMS"."ID" > ?) order by "ITEMS"."ID" asc offset ? rows fetch next ? rows only',
        params: [false, 0, 10, 5],
        rowMode: 'array',
      },
    ]);
    expect(rows).toEqual([
      {
        id: 1,
        title: 'First',
        done: false,
        price: '12.50',
        createdAt: new Date('2024-05-01T12:00:00.000Z'),
      },
    ]);
  });

  it('compiles single-row INSERT, omitted defaults, multi-row INSERT via RDB$DATABASE, RETURNING, and onConflictDoUpdate MATCHING', async () => {
    const fb = new FakeDrizzleClient();
    const db = drizzle({ client: fb, schema: { items } });

    // Single-row INSERT omitting optional columns (done, price, createdAt)
    const dt = new Date('2024-05-01T12:00:00.123Z');
    await db.insert(items).values({
      id: 1,
      title: 'Alpha',
      createdAt: dt,
    });
    expect(fb.calls[0]).toEqual({
      kind: 'exec',
      sql: 'insert into "ITEMS" ("ID", "TITLE", "CREATED_AT") values (?, ?, ?)',
      params: [1, 'Alpha', '2024-05-01 12:00:00.123'],
    });

    // Multi-row INSERT -> SELECT ... FROM RDB$DATABASE UNION ALL ...
    fb.calls.length = 0;
    await db.insert(items).values([
      { id: 2, title: 'Beta', done: false },
      { id: 3, title: 'Gamma', done: true },
    ]);
    expect(fb.calls[0]).toEqual({
      kind: 'exec',
      sql: 'insert into "ITEMS" ("ID", "TITLE", "DONE") select ?, ?, ? from rdb$database union all select ?, ?, ? from rdb$database',
      params: [2, 'Beta', false, 3, 'Gamma', true],
    });

    // INSERT ... RETURNING
    fb.calls.length = 0;
    fb.nextArrayRows = [[4, 'Delta']];
    const returned = await db
      .insert(items)
      .values({ id: 4, title: 'Delta' })
      .returning({ id: items.id, title: items.title });
    expect(returned).toEqual([{ id: 4, title: 'Delta' }]);
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'insert into "ITEMS" ("ID", "TITLE") values (?, ?) returning "ID", "TITLE"',
      params: [4, 'Delta'],
      rowMode: 'array',
    });

    // Upsert via onConflictDoUpdate -> UPDATE OR INSERT INTO ... MATCHING (...)
    fb.calls.length = 0;
    fb.nextArrayRows = [[1, 'Alpha Edited']];
    const upserted = await db
      .insert(items)
      .values({ id: 1, title: 'Alpha Edited' })
      .onConflictDoUpdate({
        target: items.id,
        set: { title: 'Alpha Edited' },
      })
      .returning({ id: items.id, title: items.title });
    expect(upserted).toEqual([{ id: 1, title: 'Alpha Edited' }]);
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'update or insert into "ITEMS" ("ID", "TITLE") values (?, ?) matching ("ID") returning "ID", "TITLE"',
      params: [1, 'Alpha Edited'],
      rowMode: 'array',
    });
  });

  it('compiles UPDATE, DELETE, $count, relational queries, and transactions with nested savepoints', async () => {
    const fb = new FakeDrizzleClient();
    const db = drizzle(fb, { schema: { items } });

    // UPDATE ... RETURNING
    fb.nextArrayRows = [[1, 'Updated', true]];
    const updated = await db
      .update(items)
      .set({ title: 'Updated', done: true })
      .where(eq(items.id, 1))
      .returning({ id: items.id, title: items.title, done: items.done });
    expect(updated).toEqual([{ id: 1, title: 'Updated', done: true }]);
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'update "ITEMS" set "TITLE" = ?, "DONE" = ? where "ITEMS"."ID" = ? returning "ID", "TITLE", "DONE"',
      params: ['Updated', true, 1],
      rowMode: 'array',
    });

    // DELETE without RETURNING
    fb.calls.length = 0;
    await db.delete(items).where(eq(items.id, 1));
    expect(fb.calls[0]).toEqual({
      kind: 'exec',
      sql: 'delete from "ITEMS" where "ITEMS"."ID" = ?',
      params: [1],
    });

    // $count quotes AS "COUNT" and strips trailing semicolon
    fb.calls.length = 0;
    fb.nextObjectRows = [{ COUNT: 3 }];
    const total = await db.$count(items, eq(items.done, false));
    expect(total).toBe(3);
    expect(fb.calls[0]).toEqual({
      kind: 'query',
      sql: 'select count(*) as "COUNT" from "ITEMS" where "ITEMS"."DONE" = ?',
      params: [false],
      rowMode: 'object',
    });

    // Relational query: db.query.items.findMany
    fb.calls.length = 0;
    fb.nextArrayRows = [[2, 'RelItem']];
    const found = await db.query.items.findMany({
      columns: { id: true, title: true },
      where: eq(items.done, false),
      limit: 2,
      offset: 1,
    });
    expect(found).toEqual([{ id: 2, title: 'RelItem' }]);
    expect(fb.calls[0]?.sql).toBe(
      'select "ID", "TITLE" from "ITEMS" "ITEMS" where "ITEMS"."DONE" = ? offset ? rows fetch next ? rows only',
    );
    expect(fb.calls[0]?.params).toEqual([false, 1, 2]);

    // Transaction with isolation level + nested savepoint
    fb.calls.length = 0;
    await db.transaction(
      async (tx) => {
        await tx.insert(items).values({ id: 10, title: 'Outer' });
        await tx
          .transaction(async (nested) => {
            await nested.insert(items).values({ id: 11, title: 'Inner' });
            throw new Error('nested fail');
          })
          .catch(() => undefined);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read write' },
    );

    expect(fb.calls[0]).toEqual({
      kind: 'tx',
      txOptions: { isolationLevel: 'SNAPSHOT' },
    });
    expect(fb.calls.slice(1).map((c) => c.sql)).toEqual([
      'insert into "ITEMS" ("ID", "TITLE") values (?, ?)',
      'savepoint sp1',
      'insert into "ITEMS" ("ID", "TITLE") values (?, ?)',
      'rollback to savepoint sp1',
    ]);

    // Raw db.execute(sql`...`)
    fb.calls.length = 0;
    fb.nextObjectRows = [{ V: 99 }];
    const raw = await db.execute(sql`SELECT ${99} AS v FROM RDB$DATABASE`);
    expect(raw.rows).toEqual([{ v: 99 }]);
  });
});
