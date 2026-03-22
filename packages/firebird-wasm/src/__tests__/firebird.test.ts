import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FirebirdLite } from '../firebird';

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
});

describe('FirebirdLite (no Firebird installed)', () => {
  it('exports FirebirdLite class', async () => {
    const { FirebirdLite: FB } = await import('../index');
    expect(typeof FB).toBe('function');
  });
});
