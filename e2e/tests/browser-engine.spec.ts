/**
 * browser-engine.spec.ts – the public TypeScript API against the real engine.
 *
 * `browser-api.spec.ts` drives `FirebirdBrowser` against a stub C ABI, which
 * covers marshalling, error handling and persistence without needing a
 * compiled artifact.  This file closes the other half: the same class, the
 * same public methods, but the actual Firebird engine underneath.
 *
 * The engine runs in a Web Worker because it has to.  The build uses pthreads,
 * Firebird blocks on mutexes while opening a database, and a browser main
 * thread is not allowed to block — so `FirebirdBrowser` is constructed with a
 * `worker`, which is how a real application must use it too.
 *
 * Skipped until the WASM artifact has been built.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WASM_JS = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm/firebird-embedded.js',
);
const wasmAvailable = fs.existsSync(WASM_JS);

declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
  }
}

/** Load the harness without any stub engine installed. */
async function openHarness(page: Page): Promise<void> {
  await page.goto('/browser-harness');
  await page.waitForFunction(() => Boolean(window.FB));
  // SharedArrayBuffer, and therefore Emscripten's pthreads, need this.
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
}

test.describe('FirebirdBrowser against the real engine', () => {
  test.skip(!wasmAvailable, 'WASM binary not built – run npm run build:wasm first');

  // Creating a database writes the whole system catalogue, which is slow.
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  test('creates a database and round-trips rows through query()', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-roundtrip', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(32))');
      await db.exec("INSERT INTO items VALUES (1, 'alpha')");
      await db.exec("INSERT INTO items VALUES (2, 'beta')");

      const res = await db.query('SELECT id, name FROM items ORDER BY id');
      await db.close();
      return res;
    });

    expect(result.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
    // Columns are described, not just named — see the field-metadata test.
    expect(result.fields.map((f) => f.typeName)).toEqual(['INTEGER', 'VARYING']);
    expect(result.rows).toEqual([
      { ID: 1, NAME: 'alpha' },
      { ID: 2, NAME: 'beta' },
    ]);
  });

  test('rolls a transaction back through the public API', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-rollback', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (1)');

      let message: string | null = null;
      try {
        await db.transaction(async (tx) => {
          await tx.exec('INSERT INTO t VALUES (2)');
          throw new Error('application failure');
        });
      } catch (err) {
        message = (err as Error).message;
      }

      // The insert ran under the transaction handle, so rolling back undoes it.
      const after = await db.query('SELECT COUNT(*) AS CNT FROM t');
      await db.close();
      return { message, count: after.rows[0]!['CNT'] };
    });

    expect(result.message).toBe('application failure');
    expect(result.count).toBe(1);
  });

  test('commits a transaction through the public API', async ({ page }) => {
    const count = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-commit', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (1)');
        await tx.exec('INSERT INTO t VALUES (2)');
      });

      const res = await db.query('SELECT COUNT(*) AS CNT FROM t');
      await db.close();
      return res.rows[0]!['CNT'];
    });

    expect(count).toBe(2);
  });

  test('surfaces Firebird error text for invalid SQL', async ({ page }) => {
    const message = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-errors', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      try {
        await db.query('SELECT * FROM no_such_table');
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        await db.close();
      }
    });

    // Not a bare status code — the engine's own diagnostic reaches the caller.
    expect(message).toContain('NO_SUCH_TABLE');
  });


  test('binds query parameters', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-params', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec(
        'CREATE TABLE t (id INTEGER, name VARCHAR(32), amount NUMERIC(10,2), ok BOOLEAN)',
      );

      // Every value crosses as text and Firebird converts it, so this also
      // covers integer, decimal and boolean conversion — not just strings.
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [1, 'alpha', 10.5, true]);
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [2, 'beta', 20.25, false]);
      await db.exec('INSERT INTO t VALUES (?, ?, ?, ?)', [3, null, null, null]);

      const byId = await db.query('SELECT id, name FROM t WHERE id >= ? ORDER BY id', [2]);
      const byName = await db.query('SELECT id FROM t WHERE name = ?', ['beta']);
      const nulls = await db.query('SELECT id FROM t WHERE name IS NULL');

      await db.close();
      return { byId: byId.rows, byName: byName.rows, nulls: nulls.rows };
    });

    expect(result.byId).toEqual([
      { ID: 2, NAME: 'beta' },
      { ID: 3, NAME: null },
    ]);
    expect(result.byName).toEqual([{ ID: 2 }]);
    // A null parameter stored SQL NULL, not the string "null".
    expect(result.nulls).toEqual([{ ID: 3 }]);
  });

  test('reports a parameter count mismatch instead of failing obscurely', async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-param-arity', {
        worker: new Worker('/firebird-engine-worker.js'),
      });
      await db.exec('CREATE TABLE t (id INTEGER)');

      try {
        await db.query('SELECT id FROM t WHERE id = ?', [1, 2]);
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        await db.close();
      }
    });

    expect(message).toContain('expects 1 parameter');
    expect(message).toContain('2 were supplied');
  });


  test('reports affected row counts', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-affected', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      const ddl = await db.exec('CREATE TABLE t (id INTEGER, tag VARCHAR(8))');
      const insert = await db.exec("INSERT INTO t VALUES (1, 'a')");
      await db.exec("INSERT INTO t VALUES (2, 'a')");
      await db.exec("INSERT INTO t VALUES (3, 'b')");

      const update = await db.exec("UPDATE t SET tag = 'z' WHERE tag = ?", ['a']);
      const del = await db.exec('DELETE FROM t WHERE id = ?', [3]);
      const noMatch = await db.exec('DELETE FROM t WHERE id = ?', [999]);

      await db.close();
      // exec() returns one result per statement; these are all single
      // statements, so each has exactly one.
      return {
        ddl: ddl[0]!.affectedRows,
        insert: insert[0]!.affectedRows,
        update: update[0]!.affectedRows,
        del: del[0]!.affectedRows,
        noMatch: noMatch[0]!.affectedRows,
      };
    });

    expect(result.ddl).toBe(0); // DDL reports nothing
    expect(result.insert).toBe(1);
    expect(result.update).toBe(2); // both rows tagged 'a'
    expect(result.del).toBe(1);
    expect(result.noMatch).toBe(0);
  });

  test('rolls back explicitly without throwing', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-explicit-rollback', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec('CREATE TABLE t (id INTEGER)');
      await db.exec('INSERT INTO t VALUES (1)');

      // Abandoning the transaction returns normally: no error propagates.
      const returned = await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (2)');
        await tx.rollback();
        return 'abandoned';
      });

      // Using the transaction after rollback is a mistake worth reporting.
      let afterRollback: string | null = null;
      await db.transaction(async (tx) => {
        await tx.rollback();
        try {
          await tx.exec('INSERT INTO t VALUES (3)');
        } catch (err) {
          afterRollback = (err as Error).message;
        }
      });

      const count = await db.query('SELECT COUNT(*) AS CNT FROM t');
      await db.close();
      return { returned, afterRollback, count: count.rows[0]!['CNT'] };
    });

    expect(result.returned).toBe('abandoned');
    expect(result.afterRollback).toContain('already been rolled back');
    // Only the row inserted outside the transactions survived.
    expect(result.count).toBe(1);
  });


  test('runs a migration script, including a procedure body', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-script', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      // The shape a real migration takes: several statements, a comment, and
      // a PSQL body whose internal semicolons must not split it.
      const results = await db.exec(`
        CREATE TABLE items (id INTEGER, name VARCHAR(32));
        -- seed data; note the semicolon in this comment
        INSERT INTO items VALUES (1, 'alpha');
        INSERT INTO items VALUES (2, 'a;b');

        SET TERM ^ ;
        CREATE PROCEDURE count_items RETURNS (total INTEGER) AS
        BEGIN
          SELECT COUNT(*) FROM items INTO :total;
          SUSPEND;
        END^
        SET TERM ; ^
      `);

      const rows = await db.query('SELECT id, name FROM items ORDER BY id');
      const viaProc = await db.query('SELECT total FROM count_items');

      await db.close();
      return { statements: results.length, rows: rows.rows, viaProc: viaProc.rows };
    });

    // Four statements: two DDL, two inserts. The SET TERM directives are not
    // statements, and the procedure body stayed in one piece.
    expect(result.statements).toBe(4);
    expect(result.rows).toEqual([
      { ID: 1, NAME: 'alpha' },
      { ID: 2, NAME: 'a;b' },
    ]);
    // The procedure was created and runs, so its body survived splitting.
    expect(result.viaProc).toEqual([{ TOTAL: 2 }]);
  });


  test('describes result columns, not just their names', async ({ page }) => {
    const fields = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-fields', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      await db.exec(`
        CREATE TABLE shapes (
          id INTEGER NOT NULL,
          name VARCHAR(16),
          price NUMERIC(10,2),
          big BIGINT,
          ok BOOLEAN,
          made TIMESTAMP
        );
      `);
      await db.exec(
        "INSERT INTO shapes VALUES (1, 'cube', 20.25, 9007199254740993, TRUE, '2024-01-02 03:04:05')",
      );

      const res = await db.query(
        'SELECT id, name, price, big, ok, made FROM shapes',
      );
      await db.close();
      return { fields: res.fields, row: res.rows[0] };
    });

    const byName = Object.fromEntries(fields.fields.map((f) => [f.name, f]));

    expect(byName['ID']!.typeName).toBe('INTEGER');
    expect(byName['ID']!.nullable).toBe(false); // declared NOT NULL
    expect(byName['NAME']!.typeName).toBe('VARYING');
    expect(byName['NAME']!.nullable).toBe(true);
    expect(byName['OK']!.typeName).toBe('BOOLEAN');
    expect(byName['MADE']!.typeName).toBe('TIMESTAMP');

    // The point of the exercise: NUMERIC is stored as a scaled integer, so the
    // raw type code says BIGINT. Reporting NUMERIC is what tells a caller the
    // string "20.25" is an exact number rather than text.
    expect(byName['PRICE']!.typeName).toBe('NUMERIC');
    expect(byName['PRICE']!.scale).toBe(-2);
    expect(fields.row!['PRICE']).toBe('20.25');

    // A BIGINT past 2^53 also arrives as a string, but is typed differently —
    // which is exactly what a caller needs to distinguish them.
    expect(byName['BIG']!.typeName).toBe('BIGINT');
    expect(byName['BIG']!.scale).toBe(0);
    expect(fields.row!['BIG']).toBe('9007199254740993');
  });

  test('persists to IndexedDB and reopens the database after a reload', async ({
    page,
  }) => {
    // Session 1: create and populate, then close (which persists).
    await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-durable', {
        worker: new Worker('/firebird-engine-worker.js'),
      });
      await db.exec('CREATE TABLE survivors (id INTEGER, name VARCHAR(32))');
      await db.exec("INSERT INTO survivors VALUES (1, 'persisted')");
      await db.close();
    });

    await page.reload();
    await page.waitForFunction(() => Boolean(window.FB));

    // Session 2: a fresh WASM instance with an empty filesystem. The rows can
    // only come from IndexedDB.
    const rows = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('engine-durable', {
        worker: new Worker('/firebird-engine-worker.js'),
      });
      const res = await db.query('SELECT id, name FROM survivors');
      await db.close();
      return res.rows;
    });

    expect(rows).toEqual([{ ID: 1, NAME: 'persisted' }]);
  });

  test('converts values to richer types only when asked', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const setup = `CREATE TABLE typed (
        d DATE, ts TIMESTAMP, tm TIME,
        big BIGINT, num NUMERIC(18,4),
        bin BLOB SUB_TYPE BINARY, txt BLOB SUB_TYPE TEXT
      )`;
      const insert = `INSERT INTO typed VALUES (
        DATE '2026-08-11', TIMESTAMP '2026-08-11 11:22:33.4567', TIME '11:22:33.4567',
        9007199254740993, 1234.5678, 'hello bytes', 'some text'
      )`;

      const plain = new window.FB.FirebirdBrowser('typed-off', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
      });
      await plain.exec(setup);
      await plain.exec(insert);
      const before = (await plain.query('SELECT * FROM typed')).rows[0] as Record<string, unknown>;
      await plain.close();

      const typed = new window.FB.FirebirdBrowser('typed-on', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
        types: { bigint: true, dates: true, binary: true },
      });
      await typed.exec(setup);
      await typed.exec(insert);
      const after = (await typed.query('SELECT * FROM typed')).rows[0] as Record<string, unknown>;
      await typed.close();

      const describe = (v: unknown) =>
        v instanceof Date ? 'Date' : v instanceof Uint8Array ? 'Uint8Array' : typeof v;

      return {
        beforeTypes: Object.fromEntries(
          Object.entries(before).map(([k, v]) => [k, describe(v)]),
        ),
        afterTypes: Object.fromEntries(
          Object.entries(after).map(([k, v]) => [k, describe(v)]),
        ),
        bigExact: after['BIG'] === 9007199254740993n,
        // UTC-anchored, so this is the same on any machine running the test.
        tsIso: (after['TS'] as Date).toISOString(),
        dIso: (after['D'] as Date).toISOString(),
        binText: new TextDecoder().decode(after['BIN'] as Uint8Array),
        numUnchanged: after['NUM'],
        beforeBig: before['BIG'],
      };
    });

    // Default: every value is a primitive, exactly as before.
    expect(result.beforeTypes).toEqual({
      D: 'string', TS: 'string', TM: 'string',
      BIG: 'string', NUM: 'string', BIN: 'string', TXT: 'string',
    });
    expect(result.beforeBig).toBe('9007199254740993');

    expect(result.afterTypes).toEqual({
      D: 'Date',
      TS: 'Date',
      // TIME has no Date representation — new Date('11:22:33') is invalid — so
      // it is deliberately left alone.
      TM: 'string',
      BIG: 'bigint',
      // NUMERIC shares BIGINT's storage; converting would drop the scale.
      NUM: 'string',
      BIN: 'Uint8Array',
      TXT: 'string',
    });

    expect(result.bigExact).toBe(true);
    // 100 microseconds truncated to milliseconds, and anchored to UTC rather
    // than to whatever zone the machine running this happens to be in.
    expect(result.tsIso).toBe('2026-08-11T11:22:33.456Z');
    expect(result.dIso).toBe('2026-08-11T00:00:00.000Z');
    expect(result.binText).toBe('hello bytes');
    expect(result.numUnchanged).toBe('1234.5678');
  });

  test('round-trips a database through dumpDataDir and loadDataDir', async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const source = new window.FB.FirebirdBrowser('dump-source', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
      });
      await source.exec('CREATE TABLE saved (id INTEGER, name VARCHAR(20))');
      await source.query('INSERT INTO saved VALUES (?, ?)', [1, 'carried over']);

      // Deliberately never persisted: autoPersist is off and persist() is not
      // called, so anything read out of IndexedDB would miss this row.
      const bytes = await source.dumpDataDir();
      await source.close();

      // Into a database that has never existed, and an ephemeral one, so
      // nothing stored can be supplying the answer.
      const restored = new window.FB.FirebirdBrowser('memory://restored', {
        worker: new Worker('/firebird-engine-worker.js'),
        loadDataDir: bytes,
      });
      const rows = (await restored.query('SELECT id, name FROM saved')).rows;

      // Still a working database, not just a readable one.
      await restored.exec("INSERT INTO saved VALUES (2, 'added after')");
      const after = (await restored.query('SELECT COUNT(*) AS N FROM saved')).rows[0];
      await restored.close();

      return { size: bytes.byteLength, rows, after };
    });

    expect(result.size).toBeGreaterThan(0);
    expect(result.rows).toEqual([{ ID: 1, NAME: 'carried over' }]);
    expect(result.after).toMatchObject({ N: 2 });
  });

  test('keeps the stored database when loadDataDir is also given', async ({ page }) => {
    const rows = await page.evaluate(async () => {
      const worker = () => new Worker('/firebird-engine-worker.js');

      // A snapshot of one database…
      const other = new window.FB.FirebirdBrowser('memory://snapshot', {
        worker: worker(),
      });
      await other.exec('CREATE TABLE t (id INTEGER)');
      await other.exec('INSERT INTO t VALUES (99)');
      const snapshot = await other.dumpDataDir();
      await other.close();

      // …and a real, stored database with different contents.
      const first = new window.FB.FirebirdBrowser('dump-existing', {
        worker: worker(),
      });
      await first.exec('CREATE TABLE t (id INTEGER)');
      await first.exec('INSERT INTO t VALUES (1)');
      await first.persist();
      await first.close();

      // Reopening with loadDataDir — what an application does on every load —
      // must not reset the user's data to the seed.
      const reopened = new window.FB.FirebirdBrowser('dump-existing', {
        worker: worker(),
        loadDataDir: snapshot,
      });
      const result = (await reopened.query('SELECT id FROM t')).rows;
      await reopened.close();
      return result;
    });

    expect(rows).toEqual([{ ID: 1 }]);
  });

  test('runs a memory:// database with nothing stored behind it', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const before = (await indexedDB.databases()).map((d) => d.name);

      const db = new window.FB.FirebirdBrowser('memory://scratch', {
        worker: new Worker('/firebird-engine-worker.js'),
      });

      // A real engine, a real database, a real transaction — only the storage
      // is absent. autoPersist is left at its default, so this also asserts
      // that the automatic path stays quiet rather than being switched off.
      await db.exec('CREATE TABLE ephemeral (id INTEGER, name VARCHAR(20))');
      await db.query('INSERT INTO ephemeral VALUES (?, ?)', [1, 'gone soon']);
      await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO ephemeral VALUES (?, ?)', [2, 'also gone']);
      });

      const rows = (await db.query('SELECT id, name FROM ephemeral ORDER BY id')).rows;
      await db.persist();
      await db.close();

      const after = (await indexedDB.databases()).map((d) => d.name);
      return { rows, before, after };
    });

    expect(result.rows).toEqual([
      { ID: 1, NAME: 'gone soon' },
      { ID: 2, NAME: 'also gone' },
    ]);
    // Nothing was created, not even an empty store.
    expect(result.after).toEqual(result.before);
  });

  test('carries binary BLOBs beside the JSON, not inside it', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('blob-side-channel', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
        types: { binary: true },
      });

      await db.exec(
        'CREATE TABLE payloads (id INTEGER, bytes BLOB SUB_TYPE BINARY, note BLOB SUB_TYPE TEXT)',
      );
      // Every byte value, so nothing survives by looking like text: a NUL, a
      // 0xFF, and everything between.
      await db.exec(
        "INSERT INTO payloads VALUES (1, x'00FF10203040506070', 'still text')",
      );
      await db.exec("INSERT INTO payloads VALUES (2, NULL, 'no bytes')");

      const rows = (
        await db.query('SELECT id, bytes, note FROM payloads ORDER BY id')
      ).rows as Array<Record<string, unknown>>;

      // Through a Worker, so these Uint8Arrays crossed postMessage — the
      // buffers are transferred rather than cloned, and a transferred buffer
      // is still perfectly readable here.
      const first = rows[0]!['BYTES'];
      await db.close();

      return {
        isBytes: first instanceof Uint8Array,
        bytes: first instanceof Uint8Array ? [...first] : null,
        // A text BLOB is not binary and must be untouched by any of this.
        note: rows[0]!['NOTE'],
        nullBlob: rows[1]!['BYTES'],
      };
    });

    expect(result.isBytes).toBe(true);
    expect(result.bytes).toEqual([0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70]);
    expect(result.note).toBe('still text');
    expect(result.nullBlob).toBeNull();
  });

  test('still base64s binary BLOBs when bytes were not asked for', async ({ page }) => {
    const value = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('blob-default', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
      });

      await db.exec('CREATE TABLE plain (bytes BLOB SUB_TYPE BINARY)');
      await db.exec("INSERT INTO plain VALUES (x'00FF10')");

      const row = (await db.query('SELECT bytes FROM plain')).rows[0] as Record<
        string,
        unknown
      >;
      await db.close();
      return row['BYTES'];
    });

    // Unchanged for a caller who never opted in.
    expect(typeof value).toBe('string');
    expect(value).toBe(btoa(String.fromCharCode(0x00, 0xff, 0x10)));
  });

  test('describes a statement without running it', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('describe-engine', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
      });

      await db.exec(
        'CREATE TABLE described (id INTEGER, name VARCHAR(20), amount NUMERIC(10,2))',
      );

      const select = await db.describeQuery(
        'SELECT id, name, amount FROM described WHERE id = ? AND name = ?',
      );
      const insert = await db.describeQuery(
        'INSERT INTO described VALUES (?, ?, ?)',
      );
      const ddl = await db.describeQuery('CREATE TABLE another (id INTEGER)');

      // Nothing above should have run: the INSERT describes three parameters
      // and must still have inserted nothing, and `another` must not exist.
      await db.exec("INSERT INTO described VALUES (1, 'real', 9.99)");
      const count = (await db.query('SELECT COUNT(*) AS N FROM described')).rows[0];

      let anotherExists = true;
      try {
        await db.query('SELECT id FROM another');
      } catch {
        anotherExists = false;
      }

      await db.close();
      return { select, insert, ddl, count, anotherExists };
    });

    // Real metadata from the engine: names and type codes for the columns,
    // and one entry per placeholder with the type the engine inferred.
    expect(result.select.statementType).toBe('SELECT');
    expect(result.select.hasResultSet).toBe(true);
    expect(result.select.fields.map((f) => f.name)).toEqual(['ID', 'NAME', 'AMOUNT']);
    expect(result.select.fields.map((f) => f.typeName)).toEqual([
      'INTEGER',
      'VARYING',
      // NUMERIC is a scaled integer, which is exactly what typeName exists to
      // disambiguate.
      'NUMERIC',
    ]);
    expect(result.select.params).toHaveLength(2);
    expect(result.select.params!.map((p) => p.typeName)).toEqual([
      'INTEGER',
      'VARYING',
    ]);

    expect(result.insert.statementType).toBe('INSERT');
    expect(result.insert.hasResultSet).toBe(false);
    expect(result.insert.fields).toEqual([]);
    expect(result.insert.params).toHaveLength(3);

    expect(result.ddl.statementType).toBe('DDL');

    // Describing executed nothing — one real row, and no table from the DDL.
    expect(result.count).toMatchObject({ N: 1 });
    expect(result.anotherExists).toBe(false);
  });

  test('returns positional rows through the Worker', async ({ page }) => {
    // Decoding happens inside the Worker, so `rowMode` has to travel with the
    // call — applying it to what comes back would be too late, and the rows
    // would already have been built as objects and structured-cloned.
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('rowmode-engine', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
      });

      await db.exec('CREATE TABLE shaped (id INTEGER, name VARCHAR(20))');
      await db.exec("INSERT INTO shaped VALUES (1, 'alpha')");
      await db.exec("INSERT INTO shaped VALUES (2, 'beta')");

      const arrays = await db.query('SELECT id, name FROM shaped ORDER BY id', [], {
        rowMode: 'array',
      });
      const objects = await db.query('SELECT id, name FROM shaped ORDER BY id');
      // Two columns, one name: object mode can only keep the last.
      const collided = await db.query(
        'SELECT a.id, b.id FROM shaped a JOIN shaped b ON b.id = 2 WHERE a.id = 1',
        [],
        { rowMode: 'array' },
      );
      await db.close();

      return {
        arrays: arrays.rows,
        names: arrays.fields.map((f) => f.name),
        objects: objects.rows,
        collided: collided.rows,
      };
    });

    expect(result.arrays).toEqual([
      [1, 'alpha'],
      [2, 'beta'],
    ]);
    expect(result.names).toEqual(['ID', 'NAME']);
    expect(result.objects).toEqual([
      { ID: 1, NAME: 'alpha' },
      { ID: 2, NAME: 'beta' },
    ]);
    expect(result.collided).toEqual([[1, 2]]);
  });

  test('query() runs a statement that returns no rows', async ({ page }) => {
    // `fb_query` prepared such a statement, serialised the empty result and
    // committed — without ever executing it. So `query('INSERT …')` reported
    // success and wrote nothing, silently, while the Node backend (which has
    // always had an explicit `stmt.execute()` for this case) wrote the row.
    // Every statement below goes through query() deliberately.
    const result = await page.evaluate(async () => {
      const db = new window.FB.FirebirdBrowser('query-dml', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
      });

      await db.query('CREATE TABLE dml (id INTEGER, name VARCHAR(20))');
      await db.query('INSERT INTO dml VALUES (?, ?)', [1, 'inserted']);
      await db.query('INSERT INTO dml VALUES (?, ?)', [2, 'doomed']);
      await db.query('UPDATE dml SET name = ? WHERE id = ?', ['updated', 1]);
      await db.query('DELETE FROM dml WHERE id = ?', [2]);

      const rows = (await db.query('SELECT id, name FROM dml ORDER BY id')).rows;
      await db.close();
      return rows;
    });

    expect(result).toEqual([{ ID: 1, NAME: 'updated' }]);
  });

  test('applies custom parsers and serializers', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // A value type the built-in encoder has no text form for — the gap a
      // serializer exists to fill.
      class Money {
        constructor(readonly cents: number) {}
      }

      const SQL_TIMESTAMP = 510;

      const db = new window.FB.FirebirdBrowser('custom-types', {
        worker: new Worker('/firebird-engine-worker.js'),
        autoPersist: false,
        types: {
          // `dates` would truncate the 100 µs Firebird stores; the parser
          // keeps the string the engine actually sent, and wins over it.
          dates: true,
          parsers: { [SQL_TIMESTAMP]: (v) => ({ exact: v as string }) },
          serializers: [
            (v) => (v instanceof Money ? (v.cents / 100).toFixed(2) : undefined),
          ],
        },
      });

      await db.exec(
        'CREATE TABLE custom (id INTEGER, price NUMERIC(10,2), ts TIMESTAMP)',
      );
      // The Money instance is serialized on this side and reaches the engine
      // as text, which Firebird converts to NUMERIC.
      await db.query('INSERT INTO custom VALUES (?, ?, ?)', [
        1,
        new Money(1999),
        '2026-08-11 11:22:33.4567',
      ]);

      const row = (await db.query('SELECT id, price, ts FROM custom')).rows[0] as Record<
        string,
        unknown
      >;
      await db.close();

      return { id: row['ID'], price: row['PRICE'], ts: row['TS'] };
    });

    expect(result.id).toBe(1);
    // Round-tripped through the serializer and Firebird's own conversion.
    expect(result.price).toBe('19.99');
    // The parser replaced `dates`, so the fourth fractional digit survived
    // instead of being truncated into a Date.
    expect(result.ts).toEqual({ exact: '2026-08-11T11:22:33.4567' });
  });
});
