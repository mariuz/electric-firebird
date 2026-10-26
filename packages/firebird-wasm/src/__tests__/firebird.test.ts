import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FirebirdLite } from '../firebird';
import { sql } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';
import type { FirebirdLiteOptions } from '../types';
import { createKysely } from '../kysely';
import { drizzle, firebirdTable, integer, varchar, eq, asc } from '../drizzle';

/** The major version of the client library the driver loads; set by the probe below. */
let clientMajor = 0;

// Skip tests if Firebird client library is not available or server is not running
const hasFirebirdLib = (() => {
  try {
    // Try actually creating a client to verify the library can be loaded
    // a synchronous probe inside try: an import would fail the whole file when the library is missing
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createNativeClient, getDefaultLibraryFilename } = require('node-firebird-driver-native');
    const client = createNativeClient(getDefaultLibraryFilename());
    // If we get here without throwing, the library loaded successfully
    clientMajor = client.util.getClientVersionSync() >> 8;
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
  options: Omit<FirebirdLiteOptions, 'username' | 'password'> = {},
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

/**
 * CI's server matrix sets FIREBIRD_REQUIRE_SERVER=1: there, a client library
 * that fails to load must fail the run, not skip every test and pass.
 */
if (process.env['FIREBIRD_REQUIRE_SERVER'] === '1' && !hasFirebirdLib) {
  describe('Firebird server required', () => {
    it('loads the Firebird client library', () => {
      throw new Error(
        'FIREBIRD_REQUIRE_SERVER=1 but node-firebird-driver-native could not load libfbclient: ' +
          'the server suite would have been skipped',
      );
    });
  });
}

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

  // CI runs this suite against Firebird 3, 4 and 5 (FIREBIRD_EXPECT_MAJOR);
  // this is what makes a green run mean the version it names.
  it('talks to the server version it was given', async () => {
    const { rows } = await db.query<{ V: string }>(
      "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS v FROM rdb$database",
    );
    const version = rows[0]!.V.trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const expected = process.env['FIREBIRD_EXPECT_MAJOR'];
    if (expected !== undefined) {
      expect(version.split('.')[0]).toBe(expected);
    }
  });

  it('binds a string into a BLOB parameter, by every route', async () => {
    // The driver takes a Buffer there and refused a string.
    await db.exec('CREATE TABLE notes (id INTEGER, body BLOB SUB_TYPE TEXT)');
    const big = 'ž€ '.repeat(30_000);
    await db.exec('INSERT INTO notes VALUES (?, ?)', [1, 'exec']);
    await db.query('INSERT INTO notes VALUES (?, ?)', [2, big]);
    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO notes VALUES (?, ?)', [3, 'in a transaction']);
      await tx.execBatch('INSERT INTO notes VALUES (?, ?)', [[4, 'batch a'], [5, null], [6, 'batch b']]);
    });
    // In bytes: the database's default character set may be NONE, which
    // counts characters as bytes.
    const lengths = await db.query<{ ID: number; L: number }>('SELECT id, OCTET_LENGTH(body) AS l FROM notes ORDER BY id');
    expect(lengths.rows).toEqual([
      { ID: 1, L: 4 }, { ID: 2, L: Buffer.byteLength(big) }, { ID: 3, L: 16 }, { ID: 4, L: 7 }, { ID: 5, L: null }, { ID: 6, L: 7 },
    ]);
    const match = await db.query('SELECT id FROM notes WHERE body = ?', ['batch b']);
    expect(match.rows).toEqual([{ ID: 6 }]);
  });

  it('binds bytes into a binary BLOB and an OCTETS column, by every route', async () => {
    // A Uint8Array or ArrayBuffer, as the browser engine takes them.
    await db.exec('CREATE TABLE raws (id INTEGER, raw BLOB SUB_TYPE BINARY, code VARCHAR(4) CHARACTER SET OCTETS)');
    const bytes = new Uint8Array([0, 0xff, 0x80, 0x0a]);
    await db.exec('INSERT INTO raws VALUES (?, ?, ?)', [1, bytes, bytes]);
    await db.query('INSERT INTO raws VALUES (?, ?, ?)', [2, bytes.buffer, bytes.subarray(1, 3)]);
    await db.transaction(async (tx) => {
      await tx.execBatch('INSERT INTO raws VALUES (?, ?, ?)', [[3, bytes, null], [4, new Uint8Array(0), bytes]]);
    });
    // Compared in SQL: the driver reads an OCTETS column back as text.
    const { rows } = await db.query<{ ID: number; L: number; SAME: boolean; CODE: string | null }>(
      "SELECT id, OCTET_LENGTH(raw) AS l, CAST(raw AS VARCHAR(8) CHARACTER SET OCTETS) = x'00ff800a' AS same, " +
        "TRIM(CASE WHEN code = x'00ff800a' THEN 'all' WHEN code = x'ff80' THEN 'part' END) AS code FROM raws ORDER BY id");
    expect(rows.map((r) => [r.ID, r.L, r.SAME, r.CODE])).toEqual([
      [1, 4, true, 'all'], [2, 4, true, 'part'], [3, 4, true, null], [4, 0, false, 'all'],
    ]);
  });

  describe('dates and times given as text', () => {
    // As firebird-wasm/electric's syncShapeToTable sends them, and as the
    // browser engine takes them: Firebird converts the text, to 1/10000 s.
    const asText = 'CAST(d AS VARCHAR(10)), CAST(t AS VARCHAR(13)), CAST(ts AS VARCHAR(24))';

    beforeEach(async () => {
      await db.exec('CREATE TABLE dt (id INTEGER, d DATE, t TIME, ts TIMESTAMP)');
    });

    it('binds them exactly, by every route', async () => {
      const row = ['2024-02-29', '13:45:01.5', '2024-05-01 12:00:00.1234'];
      await db.exec('INSERT INTO dt VALUES (?, ?, ?, ?)', [1, ...row]);
      await db.query('INSERT INTO dt VALUES (?, ?, ?, ?)', [2, ...row]);
      await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO dt VALUES (?, ?, ?, ?)', [3, ...row]);
        // Blocks of rows, and one row at a time.
        await tx.execBatch('INSERT INTO dt VALUES (?, ?, ?, ?)', [[4, ...row], [5, null, null, null], [6, ...row]]);
        await tx.execBatch('INSERT INTO dt VALUES (?, ?, ?, ?)', [[7, ...row]]);
      });
      const { rows } = await db.query(`SELECT id, ${asText} FROM dt ORDER BY id`, [], { rowMode: 'array' });
      const exact = ['2024-02-29', '13:45:01.5000', '2024-05-01 12:00:00.1234'];
      expect(rows).toEqual([
        [1, ...exact], [2, ...exact], [3, ...exact], [4, ...exact], [5, null, null, null], [6, ...exact], [7, ...exact],
      ]);
      // In a WHERE clause too, to the last digit.
      const hit = await db.query('SELECT id FROM dt WHERE ts = ? AND d = ? AND t = ? ORDER BY id', [
        '2024-05-01 12:00:00.1234', '2024-02-29', '13:45:01.5',
      ], { rowMode: 'array' });
      expect(hit.rows).toEqual([[1], [2], [3], [4], [6], [7]]);
      const miss = await db.query('SELECT id FROM dt WHERE ts = ?', ['2024-05-01 12:00:00.1235']);
      expect(miss.rows).toEqual([]);
    });

    it('still takes a Date, and both on one kept statement', async () => {
      const cached = makeDb(tmpDbName('dates-cached'), { statementCache: 8 });
      try {
        await cached.exec('CREATE TABLE dt (id INTEGER, d DATE, t TIME, ts TIMESTAMP)');
        const sql = 'INSERT INTO dt VALUES (?, ?, ?, ?)';
        const date = new Date(2024, 4, 1, 12, 30, 15, 250); // the driver reads a Date in local time
        await cached.exec(sql, [1, '2024-02-29', '13:45:01.5', '2024-05-01 12:00:00.1234']);
        await cached.exec(sql, [2, date, date, date]);
        await cached.exec(sql, [3, date, '23:59:59.9999', date]); // some as text, some not
        await cached.exec(sql, [4, '2024-01-02', date, '2024-01-02 03:04:05']);
        await cached.exec(sql, [5, date, date, date]);
        const { rows } = await cached.query(`SELECT id, ${asText} FROM dt ORDER BY id`, [], { rowMode: 'array' });
        expect(rows).toEqual([
          [1, '2024-02-29', '13:45:01.5000', '2024-05-01 12:00:00.1234'],
          [2, '2024-05-01', '12:30:15.2500', '2024-05-01 12:30:15.2500'],
          [3, '2024-05-01', '23:59:59.9999', '2024-05-01 12:30:15.2500'],
          [4, '2024-01-02', '12:30:15.2500', '2024-01-02 03:04:05.0000'],
          [5, '2024-05-01', '12:30:15.2500', '2024-05-01 12:30:15.2500'],
        ]);
      } finally {
        await cached.close();
      }
    });

    it('takes the zoned types as text where the server has them', async () => {
      const { rows } = await db.query<{ V: string }>(
        "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS v FROM rdb$database");
      // Firebird 3 has no time zones, neither as a server nor as a client
      // library: a 3.0 libfbclient (Ubuntu's libfbclient2, as CI installs)
      // refuses the statement with "Data type unknown" before it is sent.
      if (Number(rows[0]!.V.split('.')[0]) < 4 || clientMajor < 4) return;
      await db.exec('CREATE TABLE z (id INTEGER, tz TIME WITH TIME ZONE, tstz TIMESTAMP WITH TIME ZONE)');
      await db.exec('INSERT INTO z VALUES (?, ?, ?)', [1, '10:00:00.1234 +02:00', '2024-05-01 12:00:00.1234 +02:00']);
      await db.execBatch('INSERT INTO z VALUES (?, ?, ?)', [
        [2, '10:00:00 America/Sao_Paulo', '2024-05-01 12:00:00 America/Argentina/ComodRivadavia'],
        [3, null, '2024-12-31 23:59:59.9999 -05:30'],
      ]);
      const read = await db.query(
        "SELECT id, CAST(tz AS VARCHAR(60)), CAST(tstz AS VARCHAR(80)) FROM z ORDER BY id", [], { rowMode: 'array' });
      expect(read.rows).toEqual([
        [1, '10:00:00.1234 +02:00', '2024-05-01 12:00:00.1234 +02:00'],
        [2, '10:00:00.0000 America/Sao_Paulo', '2024-05-01 12:00:00.0000 America/Argentina/ComodRivadavia'],
        [3, null, '2024-12-31 23:59:59.9999 -05:30'],
      ]);
    });

    it('fails with the engine error for text that is not a date', async () => {
      await expect(db.exec('INSERT INTO dt (id, d) VALUES (?, ?)', [1, '2023-02-29'])).rejects.toThrow(/conversion error/i);
      await expect(db.exec('INSERT INTO dt (id, ts) VALUES (?, ?)', [1, 'soon'])).rejects.toThrow(/conversion error/i);
      expect((await db.query('SELECT COUNT(*) AS N FROM dt')).rows).toEqual([{ N: 0 }]);
    });
  });

  it('binds a string into an integer or NUMERIC parameter digit for digit', async () => {
    // The driver binds these as doubles: a string used to go through one.
    // syncShapeToTable sends int8 and numeric values as text.
    await db.exec('CREATE TABLE nums (id INTEGER, big BIGINT, money NUMERIC(18,4), tiny NUMERIC(18,17), f DOUBLE PRECISION)');
    const row = ['9007199254740993', '12345678901234.5678', '0.12345678901234567', '0.1'];
    await db.exec('INSERT INTO nums VALUES (?, ?, ?, ?, ?)', ['1', ...row]);
    await db.execBatch('INSERT INTO nums VALUES (?, ?, ?, ?, ?)', [[2, ...row], [3, '-9007199254740993', '-0.0001', null, 2.5]]);
    // A number is still a number: as exact as a double is.
    await db.exec('INSERT INTO nums VALUES (?, ?, ?, ?, ?)', [4, 9007199254740992, 12.25, 0.5, 0.1]);
    const { rows } = await db.query(
      'SELECT id, CAST(big AS VARCHAR(21)), CAST(money AS VARCHAR(21)), CAST(tiny AS VARCHAR(21)), f FROM nums ORDER BY id',
      [], { rowMode: 'array' });
    expect(rows).toEqual([
      [1, '9007199254740993', '12345678901234.5678', '0.12345678901234567', 0.1],
      [2, '9007199254740993', '12345678901234.5678', '0.12345678901234567', 0.1],
      [3, '-9007199254740993', '-0.0001', null, 2.5],
      [4, '9007199254740992', '12.2500', '0.50000000000000000', 0.1],
    ]);
    const hit = await db.query('SELECT id FROM nums WHERE big = ? ORDER BY id', ['9007199254740993'], { rowMode: 'array' });
    expect(hit.rows).toEqual([[1], [2]]);
    await expect(db.exec('INSERT INTO nums (id, big) VALUES (?, ?)', [5, 'many'])).rejects.toThrow(/conversion error/i);
  });

  it('throws, and does not crash, when a parameter beside a BLOB is wrong', async () => {
    // The driver used to write the blob while encoding the other parameters,
    // and roll back under it when one failed: the process died with SIGSEGV
    // within a few rounds of this.
    await db.exec('CREATE TABLE nb (note BLOB SUB_TYPE TEXT, s VARCHAR(2), d DATE)');
    const note = 'x'.repeat(1000);
    for (let i = 0; i < 40; i++) {
      await expect(db.exec('INSERT INTO nb (note, s) VALUES (?, ?)', [note, 'too long'])).rejects.toThrow(/Length in bytes/);
      await expect(db.exec('INSERT INTO nb (note, s) VALUES (?, ?)', [Buffer.from(note), 'too long'])).rejects.toThrow(/Length in bytes/);
      await expect(db.exec('INSERT INTO nb (note, d) VALUES (?, ?)', [note, 'not a date'])).rejects.toThrow(/conversion error/i);
    }
    await db.exec('INSERT INTO nb (note, s, d) VALUES (?, ?, ?)', [note, 'ok', '2024-02-29']);
    const { rows } = await db.query(
      'SELECT OCTET_LENGTH(note), s, CAST(d AS VARCHAR(10)) FROM nb', [], { rowMode: 'array' });
    expect(rows).toEqual([[1000, 'ok', '2024-02-29']]);
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

    it('reports input parameter metadata (params) matching FirebirdBrowser', async () => {
      const withParam = await db.describeQuery('SELECT id FROM described WHERE id = ?');
      expect(withParam.params).toEqual([
        {
          name: '',
          type: 496,
          typeName: 'INTEGER',
          subType: 0,
          scale: 0,
          length: 4,
          nullable: true,
        },
      ]);

      const withoutParams = await db.describeQuery('SELECT id, name FROM described');
      expect(withoutParams.params).toEqual([]);

      const insertShape = await db.describeQuery('INSERT INTO described VALUES (?, ?)');
      expect(insertShape.params.map((p) => p.typeName)).toEqual(['INTEGER', 'VARYING']);
    });

    it('reports the result columns and the statement kind', async () => {
      const shape = await db.describeQuery(
        'SELECT id, name FROM described WHERE id = ?',
      );

      expect(shape.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
      expect(shape.statementType).toBe('SELECT');
      expect(shape.hasResultSet).toBe(true);
    });

    it('reports input parameter metadata', async () => {
      // The native driver exposes no input metadata at all. Returning [] would
      // say "this statement takes no parameters", which is a different and
      // wrong claim about a statement with a placeholder in it.
      const shape = await db.describeQuery('SELECT id FROM described WHERE id = ?');

      expect(shape.params).toHaveLength(1);
      expect(shape.params[0]?.typeName).toBe('INTEGER');
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

describeIfFirebird('FirebirdLite.execBatch in blocks', () => {
  let db: FirebirdLite;
  let dbPath: string;

  beforeEach(() => {
    const name = tmpDbName('batch-block');
    dbPath = path.join(os.tmpdir(), name);
    db = makeDb(name);
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  const COLUMNS =
    '(id INTEGER NOT NULL PRIMARY KEY, big BIGINT, money NUMERIC(18,2), d DOUBLE PRECISION, ' +
    "s VARCHAR(20) CHARACTER SET UTF8, c CHAR(5), dt DATE, ts TIMESTAMP, ok BOOLEAN, note BLOB SUB_TYPE TEXT CHARACTER SET UTF8)";

  it('stores every row exactly as one execute per row would', async () => {
    await db.exec(`CREATE TABLE blocked ${COLUMNS}`);
    await db.exec(`CREATE TABLE looped ${COLUMNS}`);
    const rows = Array.from({ length: 450 }, (_, i) => [
      i,
      i % 7 === 0 ? null : 9007199254740 + i,
      i % 5 === 0 ? null : i + 0.25,
      i / 3,
      i % 3 === 0 ? `ñandú ✓ ${i}` : `row ${i}`,
      i % 4 === 0 ? null : `c${i % 10}`,
      new Date(Date.UTC(2026, 9, (i % 28) + 1)),
      new Date(Date.UTC(2026, 9, 10, 12, i % 60, i % 60, 500)),
      i % 2 === 0,
      i % 6 === 0 ? null : Buffer.from(`note ${i} ✓`), // the driver takes a Buffer for a BLOB
    ]);

    await db.execBatch('INSERT INTO blocked VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rows);
    await db.transaction(async (tx) => {
      for (const row of rows) await tx.exec('INSERT INTO looped VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row);
    });

    const read = async (table: string) =>
      (await db.query(
        `SELECT id, big, money, d, s, c, dt, ts, ok, CAST(note AS VARCHAR(100) CHARACTER SET UTF8) FROM ${table} ORDER BY id`,
        [],
        { rowMode: 'array' },
      )).rows;
    const blocked = await read('blocked');
    expect(blocked).toHaveLength(450);
    expect(blocked).toEqual(await read('looped'));
    expect(blocked[3][4]).toBe('ñandú ✓ 3');
    expect(blocked[1][3]).toBe(1 / 3);
  });

  it('is all or nothing, and fails with the row-by-row error', async () => {
    await db.exec('CREATE TABLE k (id INTEGER NOT NULL PRIMARY KEY)');
    const rows = Array.from({ length: 300 }, (_, i) => [i]);
    rows[250] = [3]; // a duplicate key, in the second block
    await expect(db.execBatch('INSERT INTO k VALUES (?)', rows)).rejects.toThrow(/PRIMARY or UNIQUE KEY/);
    expect((await db.query('SELECT COUNT(*) AS N FROM k')).rows).toEqual([{ N: 0 }]);
  });

  it('runs UPDATE and EXECUTE PROCEDURE batches', async () => {
    await db.exec('CREATE TABLE u (id INTEGER NOT NULL PRIMARY KEY, v INTEGER)');
    await db.execBatch('INSERT INTO u VALUES (?, ?)', Array.from({ length: 250 }, (_, i) => [i, 0]));
    await db.execBatch('UPDATE u SET v = ? WHERE id = ?', Array.from({ length: 250 }, (_, i) => [i * 2, i]));
    expect((await db.query('SELECT SUM(v) AS S FROM u')).rows).toEqual([{ S: 249 * 250 }]);

    await db.query('CREATE PROCEDURE bump (i INTEGER) AS BEGIN UPDATE u SET v = v + 1 WHERE id = :i; END');
    await db.execBatch('EXECUTE PROCEDURE bump(?)', Array.from({ length: 250 }, (_, i) => [i]));
    expect((await db.query('SELECT SUM(v) AS S FROM u')).rows).toEqual([{ S: 249 * 250 + 250 }]);
  });

  it('halves a block that uses too many contexts to prepare', async () => {
    await db.exec('CREATE TABLE m (id INTEGER, name VARCHAR(10))');
    // Three contexts a row: 200 rows would need 600 of the engine's 256.
    const sql =
      'INSERT INTO m SELECT ?, ? FROM RDB$DATABASE r1 JOIN RDB$DATABASE r2 ON 1 = 1 JOIN RDB$DATABASE r3 ON 1 = 1';
    await db.execBatch(sql, Array.from({ length: 300 }, (_, i) => [i, `n${i}`]));
    expect((await db.query('SELECT COUNT(*) AS N, SUM(id) AS S FROM m')).rows).toEqual([{ N: 300, S: 299 * 150 }]);
  });

  it('leaves a ? inside a string alone', async () => {
    await db.exec('CREATE TABLE q (id INTEGER, note VARCHAR(10))');
    await db.execBatch("INSERT INTO q VALUES (?, 'why?')", [[1], [2], [3]]);
    expect((await db.query('SELECT id, note FROM q ORDER BY id', [], { rowMode: 'array' })).rows).toEqual([
      [1, 'why?'],
      [2, 'why?'],
      [3, 'why?'],
    ]);
  });

  it('returns compact and detailed execution plans via explain() without executing the statement', async () => {
    await db.exec('CREATE TABLE plan_items (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(20))');
    await db.exec("INSERT INTO plan_items VALUES (1, 'alpha')");

    const compact = await db.explain('SELECT id, label FROM plan_items');
    expect(compact).toMatch(/^PLAN\s*\(/i);
    expect(compact).toMatch(/PLAN_ITEMS/i);

    const indexed = await db.explain(sql`SELECT id, label FROM plan_items WHERE id = ${1}`);
    expect(indexed).toMatch(/^PLAN\s*\(/i);
    expect(indexed).toMatch(/INDEX/i);

    const detailed = await db.explain('SELECT id, label FROM plan_items WHERE id = ?', { detailed: true });
    expect(detailed).toMatch(/Select Expression/i);
    expect(detailed).toMatch(/PLAN_ITEMS/i);

    const ddlPlan = await db.explain('CREATE TABLE never_created (id INTEGER)');
    expect(ddlPlan).toBe('');

    // Explain on an INSERT must not insert any rows
    await db.explain("INSERT INTO plan_items VALUES (2, 'beta')");
    const count = await db.query<{ N: number }>('SELECT COUNT(*) AS N FROM plan_items');
    expect(count.rows).toEqual([{ N: 1 }]);

    // Transaction explain() works inside an explicit transaction
    await db.transaction(async (tx) => {
      const txPlan = await tx.explain('SELECT id FROM plan_items WHERE id = 1');
      expect(txPlan).toMatch(/PLAN_ITEMS/i);
    });
  });

  it('reports database diagnostics and OIT/OAT transaction counters via databaseInfo()', async () => {
    const info = await db.databaseInfo();
    expect(info.pageSize).toBeGreaterThanOrEqual(4096);
    expect(info.allocatedPages).toBeGreaterThan(0);
    expect(info.databaseSizeBytes).toBe(info.pageSize * info.allocatedPages);
    expect(info.odsVersion).toBeGreaterThanOrEqual(12);
    expect(info.oldestTransaction).toBeGreaterThan(0);
    expect(info.oldestActive).toBeGreaterThanOrEqual(info.oldestTransaction);
    expect(info.nextTransaction).toBeGreaterThanOrEqual(info.oldestActive);
    expect(info.transactionGap).toBe(Math.max(0, info.nextTransaction - info.oldestActive));
    expect(info.currentMemory).toBeGreaterThan(0);
    expect(info.maxMemory).toBeGreaterThanOrEqual(info.currentMemory);
  });

  it('supports explicit prepared statement handles via db.prepare() and tx.prepare()', async () => {
    await db.exec('CREATE TABLE prep_items (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(20))');

    const insertStmt = await db.prepare('INSERT INTO prep_items (id, label) VALUES (?, ?)');
    expect(insertStmt.sql).toBe('INSERT INTO prep_items (id, label) VALUES (?, ?)');
    expect(insertStmt.statementType).toBe('INSERT');
    expect(insertStmt.hasResultSet).toBe(false);
    expect(insertStmt.params).toHaveLength(2);
    expect(insertStmt.params[0]?.typeName).toBe('INTEGER');
    expect(insertStmt.params[1]?.typeName).toBe('VARYING');
    expect(insertStmt.fields).toEqual([]);
    expect(insertStmt.closed).toBe(false);

    const r1 = await insertStmt.exec([1, 'alpha']);
    expect(r1.affectedRows).toBe(1);

    const batchRes = await insertStmt.execBatch([
      [2, 'beta'],
      [3, 'gamma'],
    ]);
    expect(batchRes.affectedRows).toBe(2);

    await expect(insertStmt.exec([4])).rejects.toThrow(/expects 2 parameter\(s\) but 1/);

    await insertStmt.close();
    expect(insertStmt.closed).toBe(true);
    await expect(insertStmt.exec([4, 'delta'])).rejects.toThrow(/PreparedStatement has been closed/);

    const selectStmt = await db.prepare('SELECT id, label FROM prep_items WHERE id >= ? ORDER BY id');
    expect(selectStmt.statementType).toBe('SELECT');
    expect(selectStmt.hasResultSet).toBe(true);
    expect(selectStmt.params).toHaveLength(1);
    expect(selectStmt.fields.map((f) => f.name)).toEqual(['ID', 'LABEL']);

    const objRes = await selectStmt.query<{ ID: number; LABEL: string }>([2]);
    expect(objRes.rows).toEqual([
      { ID: 2, LABEL: 'beta' },
      { ID: 3, LABEL: 'gamma' },
    ]);

    const arrRes = await selectStmt.query([1], { rowMode: 'array' });
    expect(arrRes.rows).toEqual([
      [1, 'alpha'],
      [2, 'beta'],
      [3, 'gamma'],
    ]);

    await selectStmt.close();

    // Transaction-scoped prepare()
    await db.transaction(async (tx) => {
      const txStmt = await tx.prepare('UPDATE prep_items SET label = ? WHERE id = ?');
      expect(txStmt.params).toHaveLength(2);
      const upd = await txStmt.exec(['ALPHA', 1]);
      expect(upd.affectedRows).toBe(1);
      await txStmt.close();
    });

    const check = await db.query<{ LABEL: string }>('SELECT label FROM prep_items WHERE id = 1');
    expect(check.rows).toEqual([{ LABEL: 'ALPHA' }]);
  });

  it('streams rows in batches with queryStream() and cleans up on early break', async () => {
    await db.exec('CREATE TABLE s (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(20))');
    await db.execBatch(
      'INSERT INTO s VALUES (?, ?)',
      Array.from({ length: 7 }, (_, i) => [i + 1, `r${i + 1}`]),
    );

    const batches: number[] = [];
    const labels: string[] = [];
    for await (const batch of db.queryStream<{ ID: number; LABEL: string }>(
      'SELECT id, label FROM s ORDER BY id',
      [],
      { batchSize: 3 },
    )) {
      batches.push(batch.rows.length);
      for (const row of batch.rows) labels.push(row.LABEL);
    }
    expect(batches).toEqual([3, 3, 1]);
    expect(labels).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);

    const firstBatchOnly: unknown[][] = [];
    for await (const batch of db.queryStream(
      sql`SELECT id, label FROM s WHERE id >= ${2} ORDER BY id`,
      { rowMode: 'array', batchSize: 2 },
    )) {
      firstBatchOnly.push(...batch.rows);
      break;
    }
    expect(firstBatchOnly).toEqual([
      [2, 'r2'],
      [3, 'r3'],
    ]);

    // Subsequent DDL (DROP TABLE) succeeds because early break closed the cursor and transaction
    await db.exec('DROP TABLE s');
  });
});

describeIfFirebird('FirebirdLite with types parity', () => {
  let db: FirebirdLite;
  let dbPath: string;

  afterEach(async () => {
    await db?.close();
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  it('returns browser-identical wire values by default and converts with types: { bigint, dates, binary, parsers, serializers }', async () => {
    const name = tmpDbName('types-parity');
    dbPath = path.join(os.tmpdir(), name);
    db = makeDb(name);

    await db.exec(
      'CREATE TABLE typed_items (' +
        'id BIGINT NOT NULL PRIMARY KEY, ' +
        'price NUMERIC(18,4), ' +
        'dt DATE, ' +
        'tm TIME, ' +
        'ts TIMESTAMP, ' +
        'note BLOB SUB_TYPE TEXT, ' +
        'raw BLOB SUB_TYPE BINARY, ' +
        'oct VARCHAR(4) CHARACTER SET OCTETS)',
    );
    await db.exec(
      'INSERT INTO typed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        9007199254740993n,
        '12345678901234.5678',
        '2024-02-29',
        '13:45:01.5000',
        '2024-05-01 12:00:00.1234',
        'text blob ✓',
        new Uint8Array([0, 0xff, 0x80, 0x0a]),
        new Uint8Array([1, 2, 3, 4]),
      ],
    );

    const wire = await db.query('SELECT * FROM typed_items');
    expect(wire.fields.map((f) => [f.name, f.typeName])).toEqual([
      ['ID', 'BIGINT'],
      ['PRICE', 'NUMERIC'],
      ['DT', 'DATE'],
      ['TM', 'TIME'],
      ['TS', 'TIMESTAMP'],
      ['NOTE', 'BLOB'],
      ['RAW', 'BLOB'],
      ['OCT', 'VARYING'],
    ]);
    expect(wire.rows[0]).toEqual({
      ID: '9007199254740993',
      PRICE: '12345678901234.5678',
      DT: '2024-02-29',
      TM: '13:45:01.5000',
      TS: '2024-05-01T12:00:00.1234',
      NOTE: 'text blob ✓',
      RAW: Buffer.from([0, 0xff, 0x80, 0x0a]).toString('base64'),
      OCT: Buffer.from([1, 2, 3, 4]).toString('base64'),
    });
    await db.close();

    class Price {
      constructor(readonly value: string) {}
    }
    const SQL_INT64 = 580;

    db = makeDb(name, {
      types: {
        bigint: true,
        dates: true,
        binary: true,
        parsers: {
          [SQL_INT64]: (v, f) =>
            f.scale === 0 ? BigInt(v as string | number) : new Price(String(v)),
        },
        serializers: [(v) => (v instanceof Price ? v.value : undefined)],
      },
    });

    const rich = await db.query(
      'SELECT * FROM typed_items WHERE price = ?',
      [new Price('12345678901234.5678')],
    );
    expect(rich.rows[0]).toEqual({
      ID: 9007199254740993n,
      PRICE: new Price('12345678901234.5678'),
      DT: new Date('2024-02-29T00:00:00.000Z'),
      TM: '13:45:01.5000',
      TS: new Date('2024-05-01T12:00:00.123Z'),
      NOTE: 'text blob ✓',
      RAW: new Uint8Array([0, 0xff, 0x80, 0x0a]),
      OCT: new Uint8Array([1, 2, 3, 4]),
    });
  });
});

describeIfFirebird('FirebirdLite with Kysely and Drizzle ORM', () => {
  let db: FirebirdLite;
  let dbPath: string;

  afterEach(async () => {
    await db?.close();
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  it('runs Kysely and Drizzle ORM queries end-to-end against FirebirdLite', async () => {
    const name = tmpDbName('orm-parity');
    dbPath = path.join(os.tmpdir(), name);
    db = makeDb(name);

    interface OrmSchema {
      users: {
        id: number;
        name: string;
        score: number;
      };
    }
    const kdb = createKysely<OrmSchema>(db);
    await kdb.schema
      .createTable('users')
      .addColumn('id', 'integer', (col) => col.primaryKey())
      .addColumn('name', 'varchar(64)', (col) => col.notNull())
      .addColumn('score', 'integer', (col) => col.defaultTo(0).notNull())
      .execute();

    const inserted = await kdb
      .insertInto('users')
      .values({ id: 1, name: 'Alice', score: 10 })
      .returning(['id', 'name', 'score'])
      .executeTakeFirstOrThrow();
    expect(inserted).toEqual({ id: 1, name: 'Alice', score: 10 });

    await kdb
      .insertInto('users')
      .values([
        { id: 2, name: 'Bob', score: 20 },
        { id: 3, name: 'Carol', score: 30 },
      ])
      .execute();

    await kdb
      .insertInto('users')
      .values({ id: 2, name: 'Bobby', score: 25 })
      .onConflict((oc) => oc.column('id').doUpdateSet({ name: 'Bobby', score: 25 }))
      .execute();

    const page = await kdb
      .selectFrom('users')
      .select(['id', 'name', 'score'])
      .orderBy('id', 'asc')
      .offset(1)
      .limit(2)
      .execute();
    expect(page).toEqual([
      { id: 2, name: 'Bobby', score: 25 },
      { id: 3, name: 'Carol', score: 30 },
    ]);

    const usersTable = firebirdTable('users', {
      id: integer('id').primaryKey(),
      name: varchar('name', { length: 64 }).notNull(),
      score: integer('score').notNull().default(0),
    });
    const ddb = drizzle(db, { schema: { users: usersTable } });

    await ddb.insert(usersTable).values([
      { id: 4, name: 'Dave', score: 40 },
      { id: 5, name: 'Eve', score: 50 },
    ]);

    const updated = await ddb
      .update(usersTable)
      .set({ score: 99 })
      .where(eq(usersTable.id, 1))
      .returning({ id: usersTable.id, score: usersTable.score });
    expect(updated).toEqual([{ id: 1, score: 99 }]);

    const allUsers = await ddb
      .select()
      .from(usersTable)
      .orderBy(asc(usersTable.id))
      .offset(0)
      .limit(2);
    expect(allUsers).toEqual([
      { id: 1, name: 'Alice', score: 99 },
      { id: 2, name: 'Bobby', score: 25 },
    ]);

    const count = await ddb.$count(usersTable);
    expect(count).toBe(5);

    await kdb.destroy();
  });
});

describe('FirebirdLite (no Firebird installed)', () => {
  it('supports explain() against a mocked native attachment', async () => {
    const db = new FirebirdLite('/tmp/mock-explain.fdb');
    const getPlanAsync = jest.fn(async (_status: unknown, detailed: boolean) =>
      detailed
        ? '\nSelect Expression\n    -> Table "ITEMS" Full Scan\n'
        : '\nPLAN (ITEMS NATURAL)\n',
    );
    const dispose = jest.fn(async () => undefined);
    const commit = jest.fn(async () => undefined);
    const mockTx = { commit, rollback: jest.fn(async () => undefined) };
    const mockAttachment: Record<string, unknown> = {
      client: {
        master: {},
        async statusAction<T>(this: { master?: unknown }, fn: (s: unknown) => Promise<T>): Promise<T> {
          if (!this.master) {
            throw new TypeError("Cannot read properties of undefined (reading 'master')");
          }
          return fn({});
        },
      },
      startTransaction: jest.fn(async () => mockTx),
      prepare: jest.fn(async () => ({
        attachment: mockAttachment,
        statementHandle: { getPlanAsync },
        dispose,
      })),
      disconnect: jest.fn(async () => undefined),
    };
    (db as unknown as { attachment: unknown }).attachment = mockAttachment;

    expect(await db.explain('SELECT * FROM items')).toBe('PLAN (ITEMS NATURAL)');
    expect(getPlanAsync).toHaveBeenLastCalledWith({}, false);

    expect(await db.explain(sql`SELECT * FROM items WHERE id = ${1}`, { detailed: true })).toBe(
      'Select Expression\n    -> Table "ITEMS" Full Scan',
    );
    expect(getPlanAsync).toHaveBeenLastCalledWith({}, true);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
  });
  it('supports describeQuery() input parameter metadata via statementHandle.getInputMetadataAsync', async () => {
    const db = new FirebirdLite('/tmp/mock-describe.fdb');
    const inReleaseSync = jest.fn(() => 0);
    const mockInMeta = {
      getCountSync: () => 2,
      getTypeSync: (_s: unknown, i: number) => (i === 0 ? 496 : 580),
      getSubTypeSync: () => 0,
      getScaleSync: (_s: unknown, i: number) => (i === 0 ? 0 : -2),
      getLengthSync: (_s: unknown, i: number) => (i === 0 ? 4 : 8),
      isNullableSync: (_s: unknown, i: number) => i === 1,
      getAliasSync: () => '',
      releaseSync: inReleaseSync,
    };
    const dispose = jest.fn(async () => undefined);
    const commit = jest.fn(async () => undefined);
    const mockTx = { commit, rollback: jest.fn(async () => undefined) };
    const mockAttachment: Record<string, unknown> = {
      client: {
        master: {},
        async statusAction<T>(this: { master?: unknown }, fn: (s: unknown) => Promise<T>): Promise<T> {
          if (!this.master) {
            throw new TypeError("Cannot read properties of undefined (reading 'master')");
          }
          return fn({});
        },
      },
      startTransaction: jest.fn(async () => mockTx),
      prepare: jest.fn(async () => ({
        attachment: mockAttachment,
        statementHandle: {
          getInputMetadataAsync: jest.fn(async () => mockInMeta),
        },
        fields: [
          {
            name: 'ID',
            type: 496,
            typeName: 'INTEGER',
            subType: 0,
            scale: 0,
            length: 4,
            nullable: false,
          },
        ],
        type: Promise.resolve(1),
        hasResultSet: true,
        dispose,
      })),
      disconnect: jest.fn(async () => undefined),
    };
    (db as unknown as { attachment: unknown }).attachment = mockAttachment;

    const desc = await db.describeQuery(
      'SELECT id FROM items WHERE id = ? AND price >= ?',
    );
    expect(desc.statementType).toBe('SELECT');
    expect(desc.hasResultSet).toBe(true);
    expect(desc.fields).toEqual([
      {
        name: 'ID',
        type: 496,
        typeName: 'INTEGER',
        subType: 0,
        scale: 0,
        length: 4,
        nullable: false,
      },
    ]);
    expect(desc.params).toEqual([
      {
        name: '',
        type: 496,
        typeName: 'INTEGER',
        subType: 0,
        scale: 0,
        length: 4,
        nullable: false,
      },
      {
        name: '',
        type: 580,
        typeName: 'NUMERIC',
        subType: 0,
        scale: -2,
        length: 8,
        nullable: true,
      },
    ]);
    expect(inReleaseSync).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('decodes IAttachment::getInfo clumplets in databaseInfo()', async () => {
    const db = new FirebirdLite('/nonexistent/db.fdb');
    (db as unknown as { initialized: boolean }).initialized = true;
    const writeClumplet = (buf: number[], tag: number, val: number) => {
      buf.push(
        tag,
        4,
        0,
        val & 0xff,
        (val >>> 8) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 24) & 0xff,
      );
    };
    const getInfoAsync = jest.fn(
      async (
        _status: unknown,
        _itemsLen: number,
        _items: Uint8Array,
        _bufLen: number,
        buffer: Uint8Array,
      ) => {
        const bytes: number[] = [];
        writeClumplet(bytes, 14, 8192); // isc_info_page_size
        writeClumplet(bytes, 21, 300); // isc_info_allocation
        writeClumplet(bytes, 32, 13); // isc_info_ods_version
        writeClumplet(bytes, 33, 1); // isc_info_ods_minor_version
        writeClumplet(bytes, 104, 10); // isc_info_oldest_transaction (OIT)
        writeClumplet(bytes, 105, 12); // isc_info_oldest_active (OAT)
        writeClumplet(bytes, 106, 12); // isc_info_oldest_snapshot (OST)
        writeClumplet(bytes, 107, 20); // isc_info_next_transaction
        writeClumplet(bytes, 17, 1048576); // isc_info_current_memory
        writeClumplet(bytes, 18, 2097152); // isc_info_max_memory
        writeClumplet(bytes, 15, 2048); // isc_info_num_buffers
        writeClumplet(bytes, 5, 40); // isc_info_reads
        writeClumplet(bytes, 6, 15); // isc_info_writes
        writeClumplet(bytes, 7, 500); // isc_info_fetches
        writeClumplet(bytes, 8, 25); // isc_info_marks
        bytes.push(1); // isc_info_end
        buffer.set(bytes, 0);
      },
    );
    (db as unknown as { attachment: unknown }).attachment = {
      client: {
        master: {},
        async statusAction<T>(this: { master?: unknown }, fn: (s: unknown) => Promise<T>): Promise<T> {
          if (!this.master) {
            throw new TypeError("Cannot read properties of undefined (reading 'master')");
          }
          return fn({});
        },
      },
      attachmentHandle: {
        getInfoAsync,
      },
      disconnect: jest.fn(async () => undefined),
    };

    const info = await db.databaseInfo();
    expect(info).toEqual({
      pageSize: 8192,
      allocatedPages: 300,
      databaseSizeBytes: 8192 * 300,
      odsVersion: 13,
      odsMinorVersion: 1,
      oldestTransaction: 10,
      oldestActive: 12,
      oldestSnapshot: 12,
      nextTransaction: 20,
      transactionGap: 8,
      currentMemory: 1048576,
      maxMemory: 2097152,
      pageBuffers: 2048,
      reads: 40,
      writes: 15,
      fetches: 500,
      marks: 25,
    });
    expect(getInfoAsync).toHaveBeenCalledTimes(1);
  });

  it('reuses a single prepared native statement across stmt.exec, stmt.query, and stmt.close in db.prepare()', async () => {
    const db = new FirebirdLite('/nonexistent/db.fdb');
    (db as unknown as { initialized: boolean }).initialized = true;
    const dispose = jest.fn(async () => undefined);
    const execute = jest.fn(async () => undefined);
    const fetch = jest.fn(async () => [[1, 'alpha']]);
    const closeResultSet = jest.fn(async () => undefined);
    const executeQuery = jest.fn(async () => ({
      fetch,
      close: closeResultSet,
    }));
    const getAffectedRecordsAsync = jest.fn(async () => 1);
    const commit = jest.fn(async () => undefined);
    const rollback = jest.fn(async () => undefined);

    const mockAttachment: Record<string, unknown> = {
      client: {
        master: {},
        async statusAction<T>(this: { master?: unknown }, fn: (s: unknown) => Promise<T>): Promise<T> {
          if (!this.master) {
            throw new TypeError("Cannot read properties of undefined (reading 'master')");
          }
          return fn({});
        },
      },
      startTransaction: jest.fn(async () => ({ commit, rollback })),
      prepare: jest.fn(async () => ({
        attachment: mockAttachment,
        statementHandle: {
          getAffectedRecordsAsync,
        },
        params: [{ name: '', type: 496, typeName: 'INTEGER', subType: 0, scale: 0, length: 4, nullable: false }],
        fields: [
          { name: 'ID', type: 496, typeName: 'INTEGER', subType: 0, scale: 0, length: 4, nullable: false },
          { name: 'LABEL', type: 448, typeName: 'VARCHAR', subType: 0, scale: 0, length: 20, nullable: true },
        ],
        type: Promise.resolve(1),
        hasResultSet: true,
        execute,
        executeQuery,
        dispose,
      })),
      disconnect: jest.fn(async () => undefined),
    };
    (db as unknown as { attachment: unknown }).attachment = mockAttachment;

    const stmt = await db.prepare('SELECT id, label FROM items WHERE id = ?');
    expect(mockAttachment.prepare).toHaveBeenCalledTimes(1);
    expect(stmt.params).toHaveLength(1);
    expect(stmt.fields.map((f) => f.name)).toEqual(['ID', 'LABEL']);
    expect(stmt.statementType).toBe('SELECT');
    expect(stmt.hasResultSet).toBe(true);

    // Multiple query calls reuse the same prepared statement without calling attachment.prepare again
    const q1 = await stmt.query([1]);
    const q2 = await stmt.query([1], { rowMode: 'array' });
    expect(q1.rows).toEqual([{ ID: 1, LABEL: 'alpha' }]);
    expect(q2.rows).toEqual([[1, 'alpha']]);
    expect(mockAttachment.prepare).toHaveBeenCalledTimes(1);

    const execRes = await stmt.exec([1]);
    expect(execRes).toEqual({ affectedRows: 1 });
    expect(mockAttachment.prepare).toHaveBeenCalledTimes(1);

    await expect(stmt.query([1, 2])).rejects.toThrow(/expects 1 parameter\(s\) but 2/);

    await stmt.close();
    expect(stmt.closed).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(stmt.query([1])).rejects.toThrow(/PreparedStatement has been closed/);
  });

  it('streams and compresses database dumps via dumpDataStream() and loadDataStream()', async () => {
    const tmpSrc = path.join(os.tmpdir(), `fb-stream-src-${Date.now()}.fdb`);
    const tmpDst = path.join(os.tmpdir(), `fb-stream-dst-${Date.now()}.fdb`);
    const payload = new Uint8Array(65536);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    await fs.promises.writeFile(tmpSrc, payload);
    await fs.promises.writeFile(tmpDst, new Uint8Array(16));

    const srcDb = new FirebirdLite(tmpSrc);
    const dstDb = new FirebirdLite(tmpDst);
    (srcDb as unknown as { initialized: boolean }).initialized = true;
    (dstDb as unknown as { initialized: boolean }).initialized = true;
    (srcDb as unknown as { attachment: unknown }).attachment = {
      disconnect: jest.fn(async () => undefined),
    };
    const reconnect = jest.fn(async () => ({
      disconnect: jest.fn(async () => undefined),
    }));
    (dstDb as unknown as { client: unknown }).client = {
      connect: reconnect,
      dispose: jest.fn(async () => undefined),
    };
    (dstDb as unknown as { attachment: unknown }).attachment = {
      disconnect: jest.fn(async () => undefined),
    };

    try {
      const gzStream = srcDb.dumpDataStream({ compression: 'gzip', chunkSize: 16384 });
      await dstDb.loadDataStream(gzStream);
      const restored = new Uint8Array(await fs.promises.readFile(tmpDst));
      expect(restored.byteLength).toBe(payload.byteLength);
      expect(Buffer.compare(Buffer.from(restored), Buffer.from(payload))).toBe(0);
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally {
      await fs.promises.unlink(tmpSrc).catch(() => undefined);
      await fs.promises.unlink(tmpDst).catch(() => undefined);
    }
  });

  it('builds and validates optional ICU locale tailoring packs via buildIcuLocalePack and loadIcuLocaleData', async () => {
    const {
      buildIcuLocalePack,
      isValidIcuDataPackage,
      ICU_LOCALE_DATA_PATH,
    } = await import('../browser/icu-locales');
    const { FirebirdBrowser } = await import('../browser/firebird-browser');

    const pack = buildIcuLocalePack(['de_DE', 'es_ES', 'fr_FR', 'ja_JP']);
    expect(isValidIcuDataPackage(pack)).toBe(true);
    expect(isValidIcuDataPackage(new Uint8Array([1, 2, 3]))).toBe(false);

    const loadedPacks: Uint8Array[] = [];
    const writtenFiles = new Map<string, Uint8Array>();
    const mockTransport = {
      init: jest.fn(async () => undefined),
      loadIcuLocaleData: jest.fn(async (data: Uint8Array) => {
        loadedPacks.push(data);
        writtenFiles.set(ICU_LOCALE_DATA_PATH, data);
      }),
      createDatabase: jest.fn(async () => 1),
      attachDatabase: jest.fn(async () => 1),
      detachDatabase: jest.fn(async () => undefined),
      execute: jest.fn(async () => 0),
      executeBatch: jest.fn(async () => 0),
      query: jest.fn(async () => ({ fields: [], rows: [] })),
      describe: jest.fn(async () => ({
        params: [],
        fields: [],
        statementType: 'DDL' as const,
        hasResultSet: false,
      })),
      startTransaction: jest.fn(async () => 1),
      commit: jest.fn(async () => undefined),
      rollback: jest.fn(async () => undefined),
      mkdir: jest.fn(async () => undefined),
      exists: jest.fn(async (p: string) => writtenFiles.has(p)),
      readFile: jest.fn(async (p: string) => writtenFiles.get(p) ?? new Uint8Array(0)),
      writeFile: jest.fn(async (p: string, d: Uint8Array) => {
        writtenFiles.set(p, d);
      }),
      unlink: jest.fn(async () => undefined),
      eventsSubscribe: jest.fn(async () => 1),
      eventsPoll: jest.fn(async () => ({})),
      eventsCancel: jest.fn(async () => undefined),
      mountOpfs: jest.fn(async () => '/opfs/test.fdb'),
      dispose: jest.fn(async () => undefined),
    };

    const db = new FirebirdBrowser('memory://icu-opt-test', {
      transport: mockTransport,
      icuLocaleData: () => Promise.resolve(pack),
    });
    try {
      await db.exec("CREATE COLLATION u_de FOR UTF8 FROM UNICODE 'LOCALE=de_DE'");
      expect(loadedPacks).toHaveLength(1);
      expect(loadedPacks[0]?.byteLength).toBe(pack.byteLength);

      const secondPack = buildIcuLocalePack(['fr_CA']);
      await db.loadIcuLocaleData(secondPack.buffer);
      expect(loadedPacks).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it('exports FirebirdLite class', async () => {
    const { FirebirdLite: FB } = await import('../index');
    expect(typeof FB).toBe('function');
  });
});
