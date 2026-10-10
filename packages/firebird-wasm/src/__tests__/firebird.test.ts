import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FirebirdLite } from '../firebird';
import { sql } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';

// Skip tests if Firebird client library is not available or server is not running
const hasFirebirdLib = (() => {
  try {
    // Try actually creating a client to verify the library can be loaded
    // a synchronous probe inside try: an import would fail the whole file when the library is missing
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createNativeClient, getDefaultLibraryFilename } = require('node-firebird-driver-native');
    const client = createNativeClient(getDefaultLibraryFilename());
    // If we get here without throwing, the library loaded successfully
    void client;
    return true;
  } catch {
    return false;
  }
})();

/**
 * Build a FirebirdLite instance using environment variables for credentials,
 * falling back to sensible defaults for local development.
 *
 * In CI the GitHub Action sets:
 *   FIREBIRD_HOST     – hostname/IP (default: localhost)
 *   FIREBIRD_USER     – Firebird user  (default: SYSDBA)
 *   FIREBIRD_PASSWORD – Firebird password
 */
function makeDb(
  dbName: string,
  options: { sharedReads?: boolean; statementCache?: number } = {},
): FirebirdLite {
  const host = process.env['FIREBIRD_HOST'] ?? 'localhost';
  const user = process.env['FIREBIRD_USER'] ?? 'SYSDBA';
  const password = process.env['FIREBIRD_PASSWORD'] ?? '';
  const tmpDir = os.tmpdir();
  const dbPath = path.join(tmpDir, dbName);
  const uri = `${host}:${dbPath}`;

  return new FirebirdLite(uri, { username: user, password, ...options });
}

function tmpDbName(name: string): string {
  return `firebird-wasm-test-${name}-${Date.now()}.fdb`;
}

const describeIfFirebird = hasFirebirdLib ? describe : describe.skip;

describeIfFirebird('FirebirdLite', () => {
  let db: FirebirdLite;
  let dbPath: string;

  beforeEach(() => {
    const name = tmpDbName('unit');
    dbPath = path.join(os.tmpdir(), name);
    db = makeDb(name);
  });

  afterEach(async () => {
    await db.close();
    // Remove db file if accessible
    if (fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  it('creates a new database and queries it', async () => {
    const result = await db.query(
      "SELECT 'Hello world' as MESSAGE FROM RDB$DATABASE",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toHaveProperty('MESSAGE', 'Hello world');
  });

  it('creates a table, inserts rows, and selects them', async () => {
    await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
    await db.exec("INSERT INTO items VALUES (1, 'alpha')");
    await db.exec("INSERT INTO items VALUES (2, 'beta')");

    const result = await db.query(
      'SELECT id, name FROM items ORDER BY id',
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ ID: 1, NAME: 'alpha' });
    expect(result.rows[1]).toMatchObject({ ID: 2, NAME: 'beta' });
  });

  it('supports parameterised queries', async () => {
    await db.exec('CREATE TABLE users (id INTEGER, email VARCHAR(200))');
    await db.query('INSERT INTO users (id, email) VALUES (?, ?)', [
      42,
      'test@example.com',
    ]);

    const result = await db.query<{ ID: number; EMAIL: string }>(
      'SELECT id, email FROM users WHERE id = ?',
      [42],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      ID: 42,
      EMAIL: 'test@example.com',
    });
  });

  it('runs multiple statements inside a transaction', async () => {
    await db.exec('CREATE TABLE counters (name VARCHAR(50), cnt INTEGER)');

    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO counters VALUES (?, ?)', ['hits', 0]);
      await tx.exec(
        'UPDATE counters SET cnt = cnt + 1 WHERE name = ?',
        ['hits'],
      );
      await tx.exec(
        'UPDATE counters SET cnt = cnt + 1 WHERE name = ?',
        ['hits'],
      );
    });

    const result = await db.query(
      "SELECT cnt FROM counters WHERE name = 'hits'",
    );
    expect(result.rows[0]).toMatchObject({ CNT: 2 });
  });

  it('rolls back explicitly, without raising an error', async () => {
    await db.exec('CREATE TABLE ledger (id INTEGER, amount INTEGER)');
    await db.exec('INSERT INTO ledger VALUES (1, 100)');

    // Throwing also rolls back, but it propagates to the caller. Abandoning a
    // transaction on purpose should not require inventing an error, and the
    // call that does it must not then be committed on top.
    const decided = await db.transaction(async (tx) => {
      await tx.exec('UPDATE ledger SET amount = 999 WHERE id = 1');

      const inside = await tx.query('SELECT amount FROM ledger WHERE id = 1');
      expect(inside.rows[0]).toMatchObject({ AMOUNT: 999 });

      await tx.rollback();
      return 'abandoned';
    });

    // The callback's value is still returned: rolling back is not a failure.
    expect(decided).toBe('abandoned');

    const after = await db.query('SELECT amount FROM ledger WHERE id = 1');
    expect(after.rows[0]).toMatchObject({ AMOUNT: 100 });
  });

  it('refuses to use a transaction after rolling it back', async () => {
    await db.exec('CREATE TABLE guarded (id INTEGER)');

    await db.transaction(async (tx) => {
      await tx.rollback();

      // Statements after a rollback would run outside any transaction the
      // caller believes in, so they fail rather than quietly succeeding.
      await expect(tx.exec('INSERT INTO guarded VALUES (1)')).rejects.toThrow(
        'already been rolled back',
      );
      await expect(tx.query('SELECT * FROM guarded')).rejects.toThrow(
        'already been rolled back',
      );

      expect(tx.isFinished).toBe(true);
    });

    const rows = await db.query('SELECT COUNT(*) AS CNT FROM guarded');
    expect(rows.rows[0]).toMatchObject({ CNT: 0 });
  });

  it('tolerates rollback() being called twice', async () => {
    await db.transaction(async (tx) => {
      await tx.rollback();
      await expect(tx.rollback()).resolves.toBeUndefined();
    });
  });

  it('rolls back a transaction on error', async () => {
    await db.exec('CREATE TABLE accounts (id INTEGER, balance INTEGER)');
    await db.exec('INSERT INTO accounts VALUES (1, 1000)');

    await expect(
      db.transaction(async (tx) => {
        await tx.exec(
          'UPDATE accounts SET balance = balance - 200 WHERE id = ?',
          [1],
        );
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');

    const result = await db.query(
      'SELECT balance FROM accounts WHERE id = 1',
    );
    expect(result.rows[0]).toMatchObject({ BALANCE: 1000 });
  });

  it('populates the fields array', async () => {
    await db.exec('CREATE TABLE products (id INTEGER, price NUMERIC(10,2))');
    await db.exec('INSERT INTO products VALUES (1, 9.99)');

    const result = await db.query('SELECT id, price FROM products');

    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].name).toBe('ID');
    expect(result.fields[1].name).toBe('PRICE');
  });

  it('returns the outputs of EXECUTE PROCEDURE as one row', async () => {
    await db.exec(
      'CREATE PROCEDURE add_two (a INTEGER, b INTEGER) RETURNS (total INTEGER, label VARCHAR(10)) ' +
        "AS BEGIN total = a + b; label = 'sum'; END",
    );

    const result = await db.query('EXECUTE PROCEDURE add_two(?, ?)', [2, 3]);
    expect(result.rows).toEqual([{ TOTAL: 5, LABEL: 'sum' }]);
    expect(result.fields.map((f) => f.name)).toEqual(['TOTAL', 'LABEL']);

    const inTx = await db.transaction((tx) =>
      tx.query('EXECUTE PROCEDURE add_two(?, ?)', [4, 5], { rowMode: 'array' }),
    );
    expect(inTx.rows).toEqual([[9, 'sum']]);
  });

  it('throws after close()', async () => {
    await db.query("SELECT 1 FROM RDB$DATABASE");
    await db.close();
    await expect(db.query("SELECT 1 FROM RDB$DATABASE")).rejects.toThrow(
      'FirebirdLite instance has been closed',
    );
  });

  describe('describeQuery', () => {
    beforeEach(async () => {
      await db.exec('CREATE TABLE described (id INTEGER, name VARCHAR(20))');
    });

    it('reports the result columns and the statement kind', async () => {
      const shape = await db.describeQuery(
        'SELECT id, name FROM described WHERE id = ?',
      );

      expect(shape.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
      expect(shape.statementType).toBe('SELECT');
      expect(shape.hasResultSet).toBe(true);
    });

    it('reports params as undefined, which is not the same as none', async () => {
      // The native driver exposes no input metadata at all. Returning [] would
      // say "this statement takes no parameters", which is a different and
      // wrong claim about a statement with a placeholder in it.
      const shape = await db.describeQuery('SELECT id FROM described WHERE id = ?');

      expect(shape.params).toBeUndefined();
    });

    it('describes a statement that returns nothing', async () => {
      const shape = await db.describeQuery('INSERT INTO described VALUES (?, ?)');

      expect(shape.statementType).toBe('INSERT');
      expect(shape.hasResultSet).toBe(false);
      expect(shape.fields).toEqual([]);
    });

    it('names DDL and UPDATE too', async () => {
      expect((await db.describeQuery('CREATE TABLE later (id INTEGER)')).statementType)
        .toBe('DDL');
      expect((await db.describeQuery('UPDATE described SET name = ?')).statementType)
        .toBe('UPDATE');
      expect((await db.describeQuery('DELETE FROM described')).statementType)
        .toBe('DELETE');
    });

    it('runs nothing — describing an INSERT inserts nothing', async () => {
      await db.describeQuery("INSERT INTO described VALUES (1, 'ghost')");
      await db.describeQuery('DELETE FROM described');

      const after = await db.query<{ N: number }>(
        'SELECT COUNT(*) AS N FROM described',
      );
      expect(after.rows[0].N).toBe(0);
    });

    it('accepts a fragment, describing its text', async () => {
      // The values are irrelevant to the shape; only the text decides it.
      const shape = await db.describeQuery(
        sql`SELECT id FROM described WHERE id = ${99}`,
      );

      expect(shape.fields.map((f) => f.name)).toEqual(['ID']);
      expect(shape.statementType).toBe('SELECT');
    });

    it('surfaces the engine error for a statement that will not prepare', async () => {
      await expect(db.describeQuery('SELECT * FROM no_such_table')).rejects.toThrow();
    });
  });

  describe('rowMode', () => {
    beforeEach(async () => {
      await db.exec('CREATE TABLE shaped (id INTEGER, name VARCHAR(20))');
      await db.exec("INSERT INTO shaped VALUES (1, 'alpha')");
      await db.exec("INSERT INTO shaped VALUES (2, 'beta')");
    });

    it('returns positional rows, with the names still in fields', async () => {
      const result = await db.query('SELECT id, name FROM shaped ORDER BY id', [], {
        rowMode: 'array',
      });

      expect(result.rows).toEqual([
        [1, 'alpha'],
        [2, 'beta'],
      ]);
      // Nothing is lost: the names are where they always were.
      expect(result.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
    });

    it('defaults to objects', async () => {
      const result = await db.query('SELECT id, name FROM shaped WHERE id = 1');

      expect(result.rows).toEqual([{ ID: 1, NAME: 'alpha' }]);
    });

    it('types the rows by the mode, not by hope', async () => {
      // Compiling is the test. `rows` is unknown[][] here, so indexing it is
      // allowed and reading a property is not — the overload picked the array
      // shape from the literal in the options object.
      const arrays = await db.query('SELECT id, name FROM shaped WHERE id = 1', [], {
        rowMode: 'array',
      });
      const first: unknown[] = arrays.rows[0];
      expect(first[1]).toBe('alpha');

      const objects = await db.query<{ ID: number }>(
        'SELECT id FROM shaped WHERE id = 1',
      );
      const id: number = objects.rows[0].ID;
      expect(id).toBe(1);
    });

    it('keeps both columns when two share a name', async () => {
      // In object mode `SELECT a.id, b.id` collapses to one ID and the first
      // value is unreachable. Positional rows keep both, which is the reason
      // to reach for this mode beyond speed.
      const result = await db.query(
        'SELECT a.id, b.id FROM shaped a JOIN shaped b ON b.id = 2 WHERE a.id = 1',
        [],
        { rowMode: 'array' },
      );

      expect(result.rows).toEqual([[1, 2]]);
      expect(result.fields.map((f) => f.name)).toEqual(['ID', 'ID']);
    });

    it('works with a fragment and inside a transaction', async () => {
      const viaFragment = await db.query(sql`SELECT id FROM shaped WHERE id = ${2}`, {
        rowMode: 'array',
      });
      expect(viaFragment.rows).toEqual([[2]]);

      await db.transaction(async (tx) => {
        const inside = await tx.query('SELECT id, name FROM shaped ORDER BY id', [], {
          rowMode: 'array',
        });
        expect(inside.rows).toEqual([
          [1, 'alpha'],
          [2, 'beta'],
        ]);
      });
    });
  });

  // The unit tests cover what the tag builds; these cover the engine accepting
  // it — that the `?` placeholders and the parameter order actually line up
  // once a real statement is prepared.
  describe('sql`…`', () => {
    beforeEach(async () => {
      await db.exec('CREATE TABLE tagged (id INTEGER, name VARCHAR(50))');
      await db.exec("INSERT INTO tagged VALUES (1, 'first')");
      await db.exec("INSERT INTO tagged VALUES (2, 'second')");
    });

    it('runs a tagged query', async () => {
      const id = 2;
      const result = await db.query<{ NAME: string }>(
        sql`SELECT name FROM tagged WHERE id = ${id}`,
      );

      expect(result.rows).toEqual([{ NAME: 'second' }]);
    });

    it('binds values in template order', async () => {
      const result = await db.query<{ ID: number }>(
        sql`SELECT id FROM tagged WHERE name = ${'first'} AND id = ${1}`,
      );

      expect(result.rows).toEqual([{ ID: 1 }]);
    });

    it('expands a list through sql.join', async () => {
      const result = await db.query<{ ID: number }>(
        sql`SELECT id FROM tagged WHERE id IN (${sql.join([1, 2])}) ORDER BY id`,
      );

      expect(result.rows).toEqual([{ ID: 1 }, { ID: 2 }]);
    });

    it('quotes an identifier the engine then resolves', async () => {
      // Upper case because `CREATE TABLE tagged` stored TAGGED — the folding
      // rule sql.identifier deliberately does not paper over.
      const result = await db.query(
        sql`SELECT COUNT(*) AS N FROM ${sql.identifier('TAGGED')}`,
      );

      expect(result.rows[0]).toMatchObject({ N: 2 });
    });

    it('treats a value that looks like SQL as data', async () => {
      const hostile = "'; DELETE FROM tagged; --";
      const result = await db.query(
        sql`SELECT id FROM tagged WHERE name = ${hostile}`,
      );

      expect(result.rows).toEqual([]);
      // The table survived, which is the point.
      const after = await db.query<{ N: number }>(
        'SELECT COUNT(*) AS N FROM tagged',
      );
      expect(after.rows[0].N).toBe(2);
    });

    it('runs a tagged statement through exec() and inside a transaction', async () => {
      await db.exec(sql`INSERT INTO tagged VALUES (${3}, ${'third'})`);

      await db.transaction(async (tx) => {
        await tx.exec(sql`UPDATE tagged SET name = ${'renamed'} WHERE id = ${3}`);
        const inside = await tx.query<{ NAME: string }>(
          sql`SELECT name FROM tagged WHERE id = ${3}`,
        );
        expect(inside.rows).toEqual([{ NAME: 'renamed' }]);
      });

      const result = await db.query<{ NAME: string }>(
        sql`SELECT name FROM tagged WHERE id = ${3}`,
      );
      expect(result.rows).toEqual([{ NAME: 'renamed' }]);
    });

    it('accepts a statement whose type is string-or-fragment', async () => {
      // Compiling is half the test: with only the two specific overloads this
      // is TS2769, so a caller building a statement conditionally had to cast.
      const useTag = true as boolean;
      const statement: string | SqlFragment = useTag
        ? sql`SELECT id FROM tagged WHERE id = ${1}`
        : 'SELECT id FROM tagged WHERE id = 1';

      const result = await db.query<{ ID: number }>(statement);
      expect(result.rows).toEqual([{ ID: 1 }]);
    });

    it('releases the statement when the query fails', async () => {
      // A statement that throws on execute used to leak its handle, so a
      // retry loop — the usual response to a lock conflict — leaked one per
      // attempt. Twenty failures now leave the attachment perfectly usable.
      for (let i = 0; i < 20; i++) {
        await expect(db.query('SELECT * FROM no_such_table')).rejects.toThrow();
      }

      const after = await db.query<{ ID: number }>(
        sql`SELECT id FROM tagged WHERE id = ${1}`,
      );
      expect(after.rows).toEqual([{ ID: 1 }]);
    });

    it('passes transaction options in the slot parameters would have used', async () => {
      const result = await db.query<{ ID: number }>(
        sql`SELECT id FROM tagged WHERE id = ${1}`,
        { readOnly: true, isolationLevel: 'READ_COMMITTED' },
      );

      expect(result.rows).toEqual([{ ID: 1 }]);
    });
  });
});

describeIfFirebird('FirebirdLite with sharedReads', () => {
  let db: FirebirdLite;
  let dbPath: string;

  beforeEach(() => {
    const name = tmpDbName('shared-reads');
    dbPath = path.join(os.tmpdir(), name);
    db = makeDb(name, { sharedReads: true });
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  it('reads every commit, and nothing uncommitted', async () => {
    await db.exec('CREATE TABLE c (id INTEGER)');
    expect((await db.query('SELECT COUNT(*) AS N FROM c')).rows).toEqual([{ N: 0 }]);
    await db.exec('INSERT INTO c VALUES (?)', [1]);
    expect((await db.query('SELECT COUNT(*) AS N FROM c')).rows).toEqual([{ N: 1 }]);
    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO c VALUES (?)', [2]);
      expect((await db.query('SELECT COUNT(*) AS N FROM c')).rows).toEqual([{ N: 1 }]);
    });
    expect((await db.query('SELECT COUNT(*) AS N FROM c')).rows).toEqual([{ N: 2 }]);
    // A failed read leaves the next one working.
    await expect(db.query('SELECT 1 / 0 FROM c')).rejects.toThrow();
    expect((await db.query('SELECT COUNT(*) AS N FROM c')).rows).toEqual([{ N: 2 }]);
  });

  it('runs a SELECT that writes in a transaction of its own, and remembers it', async () => {
    await db.exec('CREATE TABLE w (id INTEGER)');
    await db.exec(
      'CREATE PROCEDURE add_row RETURNS (n INTEGER) AS BEGIN ' +
        "RDB$SET_CONTEXT('USER_SESSION', 'RUNS', " +
        "COALESCE(CAST(RDB$GET_CONTEXT('USER_SESSION', 'RUNS') AS INTEGER), 0) + 1); " +
        'INSERT INTO w VALUES (1); SELECT COUNT(*) FROM w INTO n; SUSPEND; END',
    );
    const runs = async () =>
      (await db.query(
        "SELECT CAST(RDB$GET_CONTEXT('USER_SESSION', 'RUNS') AS INTEGER) FROM RDB$DATABASE",
        [],
        { rowMode: 'array' },
      )).rows[0][0];

    expect((await db.query('SELECT n FROM add_row', [], { rowMode: 'array' })).rows).toEqual([[1]]);
    expect(await runs()).toBe(2); // the read-only try, then its own transaction
    expect((await db.query('SELECT n FROM add_row', [], { rowMode: 'array' })).rows).toEqual([[2]]);
    expect(await runs()).toBe(3); // straight to its own transaction
  });

  it('runs what is not a SELECT as before', async () => {
    await db.exec(
      'CREATE PROCEDURE add_two (a INTEGER, b INTEGER) RETURNS (total INTEGER) ' +
        'AS BEGIN total = a + b; END',
    );
    expect((await db.query('EXECUTE PROCEDURE add_two(?, ?)', [2, 3])).rows).toEqual([{ TOTAL: 5 }]);
    await db.exec('CREATE TABLE i (id INTEGER)');
    await db.query('INSERT INTO i VALUES (?)', [7]);
    expect((await db.query('SELECT id FROM i')).rows).toEqual([{ ID: 7 }]);
  });

  it('lets DDL change what shared reads read', async () => {
    await db.exec('CREATE TABLE d (id INTEGER)');
    await db.exec('INSERT INTO d VALUES (1)');
    expect((await db.query('SELECT id FROM d')).rows).toEqual([{ ID: 1 }]);
    await db.exec('DROP TABLE d');
    await db.exec('CREATE TABLE d (id INTEGER, w INTEGER)');
    await db.exec('INSERT INTO d VALUES (7, 8)');
    expect((await db.query('SELECT id, w FROM d')).rows).toEqual([{ ID: 7, W: 8 }]);
    await db.exec('ALTER TABLE d ADD v INTEGER');
    expect((await db.query('SELECT id, w, v FROM d')).rows).toEqual([{ ID: 7, W: 8, V: null }]);
  });
});

describeIfFirebird('FirebirdLite with statementCache', () => {
  let db: FirebirdLite;
  let dbPath: string;

  const open = (options: { sharedReads?: boolean; statementCache?: number }) => {
    const name = tmpDbName('stmt-cache');
    dbPath = path.join(os.tmpdir(), name);
    db = makeDb(name, options);
  };

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  it('runs a kept statement again with new parameters and in another transaction', async () => {
    open({ statementCache: 16 });
    await db.exec('CREATE TABLE r (id INTEGER NOT NULL PRIMARY KEY, v VARCHAR(10))');
    for (let i = 0; i < 5; i++) await db.exec('INSERT INTO r VALUES (?, ?)', [i, `v${i}`]);
    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO r VALUES (?, ?)', [9, 'v9']);
      await tx.rollback();
    });
    expect((await db.query('SELECT COUNT(*) AS N FROM r')).rows).toEqual([{ N: 5 }]);
    expect((await db.query('SELECT v FROM r WHERE id = ?', [3])).rows).toEqual([{ V: 'v3' }]);
    expect((await db.query('SELECT v FROM r WHERE id = ?', [4])).rows).toEqual([{ V: 'v4' }]);
  });

  it('drops a kept statement whose execution failed, and the next call works', async () => {
    open({ statementCache: 16 });
    await db.exec('CREATE TABLE f (id INTEGER NOT NULL PRIMARY KEY)');
    await db.exec('INSERT INTO f VALUES (?)', [1]);
    await expect(db.exec('INSERT INTO f VALUES (?)', [1])).rejects.toThrow();
    await db.exec('INSERT INTO f VALUES (?)', [2]);
    expect((await db.query('SELECT COUNT(*) AS N FROM f')).rows).toEqual([{ N: 2 }]);
  });

  it('empties itself before DDL: an altered procedure, a dropped and recreated table', async () => {
    open({ statementCache: 16 });
    await db.exec('CREATE PROCEDURE p RETURNS (v INTEGER) AS BEGIN v = 1; SUSPEND; END');
    expect((await db.query('SELECT v FROM p')).rows).toEqual([{ V: 1 }]);
    await db.exec('ALTER PROCEDURE p RETURNS (v INTEGER) AS BEGIN v = 2; SUSPEND; END');
    expect((await db.query('SELECT v FROM p')).rows).toEqual([{ V: 2 }]);

    await db.exec('CREATE TABLE d (id INTEGER)');
    await db.exec('INSERT INTO d VALUES (1)');
    expect((await db.query('SELECT * FROM d')).rows).toEqual([{ ID: 1 }]);
    await db.exec('DROP TABLE d'); // "object in use" if the SELECT were still kept
    await db.exec('CREATE TABLE d (id INTEGER, w INTEGER)');
    await db.exec('INSERT INTO d VALUES (7, 8)');
    expect((await db.query('SELECT * FROM d')).rows).toEqual([{ ID: 7, W: 8 }]);
  });

  it('keeps no more than its size', async () => {
    open({ statementCache: 2 });
    await db.exec('CREATE TABLE s (id INTEGER)');
    await db.exec('INSERT INTO s VALUES (?)', [1]);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 6; i++) {
        expect((await db.query(`SELECT id + ${i} AS X FROM s`)).rows).toEqual([{ X: 1 + i }]);
      }
    }
  });

  it('gives concurrent calls with the same text a statement each', async () => {
    open({ statementCache: 16 });
    await db.exec('CREATE TABLE c (id INTEGER)');
    for (let i = 0; i < 5; i++) await db.exec('INSERT INTO c VALUES (?)', [i]);
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => db.query('SELECT id FROM c WHERE id = ?', [i], { rowMode: 'array' })),
    );
    expect(results.map((r) => r.rows)).toEqual([[[0]], [[1]], [[2]], [[3]], [[4]]]);
  });

  it('works with sharedReads, a writing SELECT included', async () => {
    open({ statementCache: 16, sharedReads: true });
    await db.exec('CREATE TABLE w (id INTEGER)');
    await db.query(
      'CREATE PROCEDURE add_row RETURNS (n INTEGER) AS BEGIN ' +
        'INSERT INTO w VALUES (1); SELECT COUNT(*) FROM w INTO n; SUSPEND; END',
    );
    expect((await db.query('SELECT n FROM add_row')).rows).toEqual([{ N: 1 }]);
    expect((await db.query('SELECT n FROM add_row')).rows).toEqual([{ N: 2 }]);
    expect((await db.query('SELECT COUNT(*) AS N FROM w')).rows).toEqual([{ N: 2 }]);
  });

  it('refuses a size that is not a whole number of statements', () => {
    expect(() => makeDb('never-opened', { statementCache: -1 })).toThrow(RangeError);
    expect(() => makeDb('never-opened', { statementCache: 1.5 })).toThrow(RangeError);
    db = makeDb('never-opened');
  });
});

describe('FirebirdLite (no Firebird installed)', () => {
  it('exports FirebirdLite class', async () => {
    const { FirebirdLite: FB } = await import('../index');
    expect(typeof FB).toBe('function');
  });
});
