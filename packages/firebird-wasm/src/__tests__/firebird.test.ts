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
function makeDb(dbName: string): FirebirdLite {
  const host = process.env['FIREBIRD_HOST'] ?? 'localhost';
  const user = process.env['FIREBIRD_USER'] ?? 'SYSDBA';
  const password = process.env['FIREBIRD_PASSWORD'] ?? '';
  const tmpDir = os.tmpdir();
  const dbPath = path.join(tmpDir, dbName);
  const uri = `${host}:${dbPath}`;

  return new FirebirdLite(uri, { username: user, password });
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

  it('throws after close()', async () => {
    await db.query("SELECT 1 FROM RDB$DATABASE");
    await db.close();
    await expect(db.query("SELECT 1 FROM RDB$DATABASE")).rejects.toThrow(
      'FirebirdLite instance has been closed',
    );
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

describe('FirebirdLite (no Firebird installed)', () => {
  it('exports FirebirdLite class', async () => {
    const { FirebirdLite: FB } = await import('../index');
    expect(typeof FB).toBe('function');
  });
});
