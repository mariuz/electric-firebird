/**
 * wasm-integration.test.ts – Node.js (console) smoke tests for the compiled
 * Firebird WASM artifact.
 *
 * These tests are skipped automatically when the WASM binary has not been
 * built yet.  Run `npm run build:wasm` first to enable them.
 *
 * What is exercised:
 *   - The Emscripten module factory loads without throwing.
 *   - Every exported `_fb_*` C API function is present and callable.
 *   - A real round-trip: create a database, execute DDL/DML, read rows back,
 *     roll a transaction back, and surface engine error text.
 *   - `allocString` correctly allocates a UTF-8 string on the WASM heap.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadFirebirdWasm, allocString, lastError } from '../wasm-loader';
import type { FirebirdWasmModule } from '../wasm-loader';
import { encodeParams, encodeParamRows } from '../browser/params';
import type { QueryParams } from '../types';
import { FirebirdBrowser } from '../browser/firebird-browser';
import { DirectTransport } from '../browser/engine-transport';
import type { EngineTransport } from '../browser/engine-transport';

// The WASM artifact lives at dist/wasm/ after `npm run build:wasm` +
// `npm run build`.  Skip the whole suite if the binary is absent.
const WASM_JS_PATH = path.resolve(__dirname, '../../dist/wasm/firebird-embedded.js');
const hasWasm = fs.existsSync(WASM_JS_PATH);

(hasWasm ? describe : describe.skip)(
  'Firebird WASM module – console (Node.js) integration',
  () => {
    let mod: FirebirdWasmModule;

    beforeAll(async () => {
      mod = await loadFirebirdWasm();
    });

    // ── Module surface ──────────────────────────────────────────────────

    it('loads the WASM module without throwing', () => {
      expect(mod).toBeDefined();
    });

    it('exports all required C API functions', () => {
      const exports: Array<keyof FirebirdWasmModule> = [
        '_fb_init',
        '_fb_last_error',
        '_fb_create_database',
        '_fb_attach_database',
        '_fb_detach_database',
        '_fb_execute',
        '_fb_query',
        '_fb_execute_params',
        '_fb_query_params',
        '_fb_execute_batch',
        '_fb_free_result',
        '_fb_start_transaction',
        '_fb_commit',
        '_fb_rollback',
      ];
      for (const fn of exports) {
        expect(typeof mod[fn]).toBe('function');
      }
    });

    it('exports Emscripten memory helpers', () => {
      expect(typeof mod._malloc).toBe('function');
      expect(typeof mod._free).toBe('function');
      expect(typeof mod.UTF8ToString).toBe('function');
      expect(typeof mod.stringToUTF8).toBe('function');
      expect(typeof mod.lengthBytesUTF8).toBe('function');
    });

    it('exposes the Emscripten FS object', () => {
      expect(mod.FS).toBeDefined();
      expect(typeof mod.FS.mkdir).toBe('function');
      expect(typeof mod.FS.writeFile).toBe('function');
      expect(typeof mod.FS.readFile).toBe('function');
      expect(typeof mod.FS.analyzePath).toBe('function');
    });

    // ── allocString helper ──────────────────────────────────────────────

    it('allocString allocates a UTF-8 string on the WASM heap', () => {
      const str = '/data/test.fdb';
      const ptr = allocString(mod, str);
      expect(ptr).toBeGreaterThan(0);
      expect(mod.UTF8ToString(ptr)).toBe(str);
      mod._free(ptr);
    });

    it('allocString handles an empty string', () => {
      const ptr = allocString(mod, '');
      expect(ptr).toBeGreaterThan(0);
      expect(mod.UTF8ToString(ptr)).toBe('');
      mod._free(ptr);
    });

    it('allocString handles unicode strings', () => {
      const str = 'tëst/pàth.fdb';
      const ptr = allocString(mod, str);
      expect(ptr).toBeGreaterThan(0);
      expect(mod.UTF8ToString(ptr)).toBe(str);
      mod._free(ptr);
    });

    // ── Real engine round-trip ──────────────────────────────────────────
    //
    // These assertions describe the *real* C API contract, not the stub one
    // the file previously encoded (handle 0 is no longer "success", it is an
    // invalid handle).  They only run once a working artifact exists.

    /** Read the engine's message for the most recent failure. */
    const errorText = (): string => lastError(mod);

    it('_fb_init() succeeds', () => {
      const rc = mod._fb_init();
      expect(`${rc} ${errorText()}`).toBe('0 ');
    });

    it('_fb_init() is idempotent', () => {
      expect(mod._fb_init()).toBe(0);
      expect(mod._fb_init()).toBe(0);
    });

    it('rejects an unknown database handle instead of silently succeeding', () => {
      const sqlPtr = allocString(mod, 'CREATE TABLE t (id INTEGER)');
      try {
        expect(mod._fb_execute(0, 0, sqlPtr)).not.toBe(0);
        expect(errorText()).toContain('unknown database handle');
      } finally {
        mod._free(sqlPtr);
      }
    });

    it('creates a database, round-trips a row, and detaches', () => {
      mod._fb_init();
      if (!mod.FS.analyzePath('/data').exists) {
        mod.FS.mkdir('/data');
      }

      const dbPath = '/data/integration.fdb';
      if (mod.FS.analyzePath(dbPath).exists) {
        mod.FS.unlink(dbPath);
      }

      const pathPtr = allocString(mod, dbPath);
      let db = 0;
      try {
        db = mod._fb_create_database(pathPtr);
        // Report the engine's own message when this fails, rather than a bare
        // "expected 0 to be greater than 0".
        expect({ handle: db > 0, error: errorText() })
          .toEqual({ handle: true, error: '' });
      } finally {
        mod._free(pathPtr);
      }

      const exec = (sql: string): void => {
        const ptr = allocString(mod, sql);
        try {
          const rc = mod._fb_execute(db, 0, ptr);
          expect(`${sql} -> ${rc} ${errorText()}`).toBe(`${sql} -> 0 `);
        } finally {
          mod._free(ptr);
        }
      };

      exec('CREATE TABLE items (id INTEGER, name VARCHAR(32))');
      exec("INSERT INTO items VALUES (1, 'alpha')");

      const sqlPtr = allocString(mod, 'SELECT id, name FROM items ORDER BY id');
      try {
        const resultPtr = mod._fb_query(db, 0, sqlPtr, 0);
        expect({ pointer: resultPtr > 0, error: errorText() })
          .toEqual({ pointer: true, error: '' });

        const json = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);

        const parsed = JSON.parse(json) as {
          columns: Array<{ name: string; type: number; nullable: boolean }>;
          rows: unknown[][];
        };

        // This test reads the C ABI's own JSON, so it asserts the wire shape
        // directly: the engine describes each column rather than just naming
        // it.  ID is a plain INTEGER, NAME a VARCHAR — 496 and 448 are
        // Firebird's SQL_LONG and SQL_VARYING.
        expect(parsed.columns).toEqual([
          { name: 'ID', type: 496, subType: 0, scale: 0, length: 4, nullable: true },
          { name: 'NAME', type: 448, subType: 0, scale: 0, length: 128, nullable: true },
        ]);
        expect(parsed.rows).toEqual([[1, 'alpha']]);
      } finally {
        mod._free(sqlPtr);
      }

      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('rolls a transaction back', () => {
      mod._fb_init();

      const dbPath = '/data/rollback.fdb';
      if (mod.FS.analyzePath(dbPath).exists) {
        mod.FS.unlink(dbPath);
      }

      const pathPtr = allocString(mod, dbPath);
      const db = mod._fb_create_database(pathPtr);
      mod._free(pathPtr);
      expect(db).toBeGreaterThan(0);

      const exec = (sql: string, tx: number): number => {
        const ptr = allocString(mod, sql);
        try {
          return mod._fb_execute(db, tx, ptr);
        } finally {
          mod._free(ptr);
        }
      };

      expect(exec('CREATE TABLE t (id INTEGER)', 0)).toBe(0);

      const tx = mod._fb_start_transaction(db);
      expect(tx).toBeGreaterThan(0);
      expect(exec('INSERT INTO t VALUES (1)', tx)).toBe(0);
      expect(mod._fb_rollback(tx)).toBe(0);

      // The insert ran inside the transaction, so the rollback must undo it.
      const sqlPtr = allocString(mod, 'SELECT COUNT(*) AS CNT FROM t');
      try {
        const resultPtr = mod._fb_query(db, 0, sqlPtr, 0);
        const parsed = JSON.parse(mod.UTF8ToString(resultPtr)) as {
          rows: unknown[][];
        };
        mod._fb_free_result(resultPtr);
        expect(parsed.rows).toEqual([[0]]);
      } finally {
        mod._free(sqlPtr);
      }

      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('applies the isolation level rather than accepting and ignoring it', () => {
      mod._fb_init();

      const dbPath = '/data/isolation.fdb';
      if (mod.FS.analyzePath(dbPath).exists) mod.FS.unlink(dbPath);

      const pathPtr = allocString(mod, dbPath);
      const db = mod._fb_create_database(pathPtr);
      mod._free(pathPtr);
      expect(db).toBeGreaterThan(0);

      const exec = (sql: string, tx: number): number => {
        const ptr = allocString(mod, sql);
        try {
          return mod._fb_execute(db, tx, ptr);
        } finally {
          mod._free(ptr);
        }
      };

      const countIn = (tx: number): number => {
        const ptr = allocString(mod, 'SELECT COUNT(*) AS CNT FROM t');
        try {
          const resultPtr = mod._fb_query(db, tx, ptr, 0);
          expect(resultPtr).toBeGreaterThan(0);
          const parsed = JSON.parse(mod.UTF8ToString(resultPtr)) as {
            rows: number[][];
          };
          mod._fb_free_result(resultPtr);
          return parsed.rows[0]![0]!;
        } finally {
          mod._free(ptr);
        }
      };

      expect(exec('CREATE TABLE t (id INTEGER)', 0)).toBe(0);
      expect(exec('INSERT INTO t VALUES (1)', 0)).toBe(0);

      // Asserting that the argument arrives would not be worth much; what
      // matters is that it changes what the transaction can see.  So the same
      // concurrent commit is run against two isolation levels, which must
      // disagree about it.

      // 1 = READ_COMMITTED: sees work committed after it started.
      const readCommitted = mod._fb_start_transaction_ex(db, 1, 0);
      expect(readCommitted).toBeGreaterThan(0);
      const rcBefore = countIn(readCommitted);
      expect(exec('INSERT INTO t VALUES (2)', 0)).toBe(0);
      expect(countIn(readCommitted)).toBe(rcBefore + 1);
      expect(mod._fb_commit(readCommitted)).toBe(0);

      // 2 = SNAPSHOT: does not.
      const snapshot = mod._fb_start_transaction_ex(db, 2, 0);
      expect(snapshot).toBeGreaterThan(0);
      const snapBefore = countIn(snapshot);
      expect(exec('INSERT INTO t VALUES (3)', 0)).toBe(0);
      expect(countIn(snapshot)).toBe(snapBefore);
      expect(mod._fb_commit(snapshot)).toBe(0);

      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('enforces a read-only transaction, and rejects an unknown level', () => {
      mod._fb_init();

      const dbPath = '/data/readonly.fdb';
      if (mod.FS.analyzePath(dbPath).exists) mod.FS.unlink(dbPath);

      const pathPtr = allocString(mod, dbPath);
      const db = mod._fb_create_database(pathPtr);
      mod._free(pathPtr);
      expect(db).toBeGreaterThan(0);

      const exec = (sql: string, tx: number): number => {
        const ptr = allocString(mod, sql);
        try {
          return mod._fb_execute(db, tx, ptr);
        } finally {
          mod._free(ptr);
        }
      };

      expect(exec('CREATE TABLE t (id INTEGER)', 0)).toBe(0);

      // read_only is enforced by the engine, not advisory.
      const readOnly = mod._fb_start_transaction_ex(db, 0, 1);
      expect(readOnly).toBeGreaterThan(0);
      expect(exec('INSERT INTO t VALUES (1)', readOnly)).not.toBe(0);
      expect(errorText()).toMatch(/read-only/i);
      expect(mod._fb_rollback(readOnly)).toBe(0);

      // An out-of-range code must fail loudly instead of falling back to the
      // default, which would be the original bug wearing a different hat.
      expect(mod._fb_start_transaction_ex(db, 99, 0)).toBe(0);
      expect(errorText()).toContain('unknown isolation level');

      expect(mod._fb_detach_database(db)).toBe(0);
    });

    // ── Typed parameter binding and batches ─────────────────────────────

    /** Create a fresh database for one test and return its handle. */
    const freshDatabase = (name: string): number => {
      mod._fb_init();
      if (!mod.FS.analyzePath('/data').exists) mod.FS.mkdir('/data');
      const dbPath = `/data/${name}.fdb`;
      if (mod.FS.analyzePath(dbPath).exists) mod.FS.unlink(dbPath);
      const pathPtr = allocString(mod, dbPath);
      try {
        const db = mod._fb_create_database(pathPtr);
        expect({ handle: db > 0, error: errorText() }).toEqual({ handle: true, error: '' });
        return db;
      } finally {
        mod._free(pathPtr);
      }
    };

    /** Copy a packed buffer onto the heap and hand it to one ABI call. */
    const withHeapBytes = <T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T => {
      const ptr = mod._malloc(bytes.length);
      try {
        mod.HEAPU8.set(bytes, ptr);
        return fn(ptr, bytes.length);
      } finally {
        mod._free(ptr);
      }
    };

    const execParams = (db: number, tx: number, sql: string, params: QueryParams): number => {
      const sqlPtr = allocString(mod, sql);
      try {
        return withHeapBytes(encodeParams(params), (ptr, len) =>
          mod._fb_execute_params(db, tx, sqlPtr, ptr, len));
      } finally {
        mod._free(sqlPtr);
      }
    };

    const execBatch = (db: number, tx: number, sql: string, rows: QueryParams[]): number => {
      const sqlPtr = allocString(mod, sql);
      try {
        return withHeapBytes(encodeParamRows(rows), (ptr, len) =>
          mod._fb_execute_batch(db, tx, sqlPtr, ptr, len));
      } finally {
        mod._free(sqlPtr);
      }
    };

    const queryRows = (db: number, sql: string): unknown[][] => {
      const sqlPtr = allocString(mod, sql);
      try {
        const resultPtr = mod._fb_query(db, 0, sqlPtr, 0);
        expect({ pointer: resultPtr > 0, error: errorText() })
          .toEqual({ pointer: true, error: '' });
        const parsed = JSON.parse(mod.UTF8ToString(resultPtr)) as { rows: unknown[][] };
        mod._fb_free_result(resultPtr);
        return parsed.rows;
      } finally {
        mod._free(sqlPtr);
      }
    };

    it('collects garbage cooperatively, on create and on attach', () => {
      // The engine's default in Super ("combined") has the statement and a
      // collector thread fight over the same pages; the bridge opens every
      // database with "cooperative", which starts no collector thread.
      const db = freshDatabase('gc-policy');
      const policy = (handle: number) => queryRows(handle,
        "SELECT TRIM(RDB$CONFIG_VALUE), TRIM(RDB$CONFIG_SOURCE) FROM RDB$CONFIG WHERE RDB$CONFIG_NAME = 'GCPolicy'");
      expect(policy(db)).toEqual([['cooperative', '<DPB>']]);
      expect(mod._fb_detach_database(db)).toBe(0);

      const pathPtr = allocString(mod, '/data/gc-policy.fdb');
      try {
        const again = mod._fb_attach_database(pathPtr);
        expect({ handle: again > 0, error: errorText() }).toEqual({ handle: true, error: '' });
        expect(policy(again)).toEqual([['cooperative', '<DPB>']]);
        expect(mod._fb_detach_database(again)).toBe(0);
      } finally {
        mod._free(pathPtr);
      }
    });

    it('binds a double from its binary form, bit for bit', () => {
      const db = freshDatabase('typed-double');
      expect(execParams(db, 0, 'CREATE TABLE d (id INTEGER, v DOUBLE PRECISION)', [])).toBe(0);

      // Firebird's text-to-double conversion is off by one ulp for roughly one
      // value in six, which is what the binary form exists to bypass.  A few
      // hundred deterministic doubles across the exponent range would catch
      // the text path with certainty; the binary path must return every one
      // of them unchanged.  The shortest round-trip text on the way out is
      // exact for a double.
      const values: number[] = [];
      let seed = 0x2545f491;
      for (let i = 0; i < 300; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const mantissa = seed / 0x100000000 + 1; // [1, 2)
        const exponent = (i % 60) - 30;
        values.push((i % 2 ? -1 : 1) * mantissa * 2 ** exponent * (1 + i / 7));
      }
      values.push(0.1, 0.2, 0.3, 1 / 3, Math.PI, 1e-300, -1.5e300, 2 ** 53);

      const rows = values.map((v, i) => [i, v]);
      expect(`${execBatch(db, 0, 'INSERT INTO d VALUES (?, ?)', rows)} ${errorText()}`).toBe('0 ');
      expect(mod._fb_last_affected_rows()).toBe(values.length);

      const back = queryRows(db, 'SELECT v FROM d ORDER BY id').map((r) => r[0]);
      const wrong = values.filter((v, i) => !Object.is(v, back[i]));
      expect(wrong).toEqual([]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('binds a whole number from its INT64 form and keeps text where it is exact', () => {
      const db = freshDatabase('typed-mixed');
      expect(execParams(db, 0,
        'CREATE TABLE m (i BIGINT, n NUMERIC(18,2), s VARCHAR(20), f FLOAT)', [])).toBe(0);

      // 2^53 + 1 cannot be a JS number but is a bigint, and must arrive whole.
      // 1.1 bound to NUMERIC(18,2) must stay the text 1.1 → 1.10, not a double
      // rounded on the way in; 1.5 bound to a VARCHAR is still the text '1.5'.
      const rc = execParams(db, 0, 'INSERT INTO m VALUES (?, ?, ?, ?)',
        [9007199254740993n, 1.1, 1.5, 0.1]);
      expect(`${rc} ${errorText()}`).toBe('0 ');

      const [row] = queryRows(db,
        'SELECT CAST(i AS VARCHAR(30)), CAST(n AS VARCHAR(30)), s, CAST(f AS DOUBLE PRECISION) FROM m');
      expect(row).toEqual(['9007199254740993', '1.10', '1.5', Math.fround(0.1)]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('writes dates, times, integers and doubles as the engine would print them', () => {
      const db = freshDatabase('value-text');
      // The bridge decodes dates and times itself and writes numbers with
      // to_chars; the calendar edges, leap days, fractions and the integer
      // extremes are where hand-written formatting goes wrong.
      const sqlPtr = allocString(mod, `SELECT
          DATE '0001-01-01', DATE '9999-12-31', DATE '1858-11-17', DATE '1858-11-16',
          DATE '2000-02-29', DATE '1900-02-28',
          TIMESTAMP '0001-01-01 00:00:00.0001', TIMESTAMP '9999-12-31 23:59:59.9999',
          TIME '00:00:00', TIME '23:59:59.9999', TIME '07:08:09.0100',
          CAST(-32768 AS SMALLINT), CAST(-2147483648 AS INTEGER),
          CAST(-9223372036854775808 AS BIGINT), CAST(9007199254740991 AS BIGINT),
          CAST(9007199254740992 AS BIGINT), CAST(-12345.6789 AS NUMERIC(18,4)),
          CAST(0.1 AS DOUBLE PRECISION), CAST(-0e0 AS DOUBLE PRECISION),
          CAST(1e21 AS DOUBLE PRECISION), CAST(1e-7 AS DOUBLE PRECISION)
        FROM RDB$DATABASE`);
      try {
        const resultPtr = mod._fb_query(db, 0, sqlPtr, 0);
        expect({ pointer: resultPtr > 0, error: errorText() }).toEqual({ pointer: true, error: '' });
        const text = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);
        // Shortest round-trip doubles: 0.1, not 0.10000000000000001.
        expect(text).toContain(',0.1,');
        const [row] = (JSON.parse(text) as { rows: unknown[][] }).rows;
        expect(row.slice(0, 11)).toEqual([
          '0001-01-01', '9999-12-31', '1858-11-17', '1858-11-16', '2000-02-29', '1900-02-28',
          '0001-01-01T00:00:00.0001', '9999-12-31T23:59:59.9999',
          '00:00:00.0000', '23:59:59.9999', '07:08:09.0100',
        ]);
        expect(row.slice(11, 17)).toEqual([
          -32768, -2147483648, '-9223372036854775808', 9007199254740991,
          '9007199254740992', '-12345.6789',
        ]);
        const doubles = row.slice(17);
        expect(doubles.length).toBe(4);
        expect(Object.is(doubles[0], 0.1)).toBe(true);
        expect(Object.is(doubles[1], -0)).toBe(true);
        expect(Object.is(doubles[2], 1e21)).toBe(true);
        expect(Object.is(doubles[3], 1e-7)).toBe(true);
      } finally {
        mod._free(sqlPtr);
      }
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('runs a batch as one prepared statement, all rows or none', () => {
      const db = freshDatabase('batch');
      expect(execParams(db, 0, 'CREATE TABLE b (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(16))', []))
        .toBe(0);

      const rows: QueryParams[] = [];
      for (let i = 0; i < 1000; i++) rows.push([i, `row ${i}`]);
      expect(`${execBatch(db, 0, 'INSERT INTO b VALUES (?, ?)', rows)} ${errorText()}`).toBe('0 ');
      expect(mod._fb_last_affected_rows()).toBe(1000);
      expect(queryRows(db, 'SELECT COUNT(*), MAX(id) FROM b')).toEqual([[1000, 999]]);

      // The second row collides with an existing key: the whole batch is
      // rolled back, and the error says which row failed.
      const rc = execBatch(db, 0, 'INSERT INTO b VALUES (?, ?)', [[5000, 'new'], [0, 'dup']]);
      expect(rc).not.toBe(0);
      expect(errorText()).toContain('row 1');
      expect(queryRows(db, 'SELECT COUNT(*) FROM b')).toEqual([[1000]]);

      // Inside a caller's transaction the batch is its work: a rollback undoes it.
      const tx = mod._fb_start_transaction(db);
      expect(tx).toBeGreaterThan(0);
      expect(execBatch(db, tx, 'INSERT INTO b VALUES (?, ?)', [[6000, 'a'], [6001, 'b']])).toBe(0);
      expect(mod._fb_rollback(tx)).toBe(0);
      expect(queryRows(db, 'SELECT COUNT(*) FROM b')).toEqual([[1000]]);

      // A row that is not an array of the statement's arity is refused before
      // anything runs.
      expect(execBatch(db, 0, 'INSERT INTO b VALUES (?, ?)', [[7000]])).not.toBe(0);
      expect(queryRows(db, 'SELECT COUNT(*) FROM b')).toEqual([[1000]]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('closing one database leaves another database\'s transactions open', () => {
      const a = freshDatabase('detach-a');
      const b = freshDatabase('detach-b');
      expect(execParams(b, 0, 'CREATE TABLE t (id INTEGER)', [])).toBe(0);
      const txA = mod._fb_start_transaction(a);
      const txB = mod._fb_start_transaction(b);
      expect(execParams(b, txB, 'INSERT INTO t VALUES (?)', [1])).toBe(0);

      // A's own transaction goes with it; B's must not.
      expect(mod._fb_detach_database(a)).toBe(0);
      expect(mod._fb_rollback(txA)).not.toBe(0);   // already gone
      expect(`${mod._fb_commit(txB)} ${errorText()}`).toBe('0 ');
      expect(queryRows(b, 'SELECT COUNT(*) FROM t')).toEqual([[1]]);
      expect(mod._fb_detach_database(b)).toBe(0);
    });

    // ── The statement cache ─────────────────────────────────────────────
    //
    // Statements are kept prepared per database, keyed by their SQL text.  These
    // are the cases a cache could get wrong.

    const exec = (db: number, tx: number, sql: string): number => execParams(db, tx, sql, []);

    it('exports the cache size control, 64 by default, 0 to turn it off', () => {
      expect(typeof mod._fb_statement_cache).toBe('function');
      expect(mod._fb_statement_cache(0)).toBe(64);
      expect(mod._fb_statement_cache(64)).toBe(0);
    });

    it('runs a kept statement again with new parameters and in another transaction', () => {
      const db = freshDatabase('cache-reuse');
      expect(exec(db, 0, 'CREATE TABLE r (id INTEGER NOT NULL PRIMARY KEY, v VARCHAR(10))')).toBe(0);
      for (let i = 0; i < 5; i++) expect(execParams(db, 0, 'INSERT INTO r VALUES (?, ?)', [i, `v${i}`])).toBe(0);
      expect(queryRows(db, 'SELECT COUNT(*) FROM r')).toEqual([[5]]);
      // the same INSERT inside a transaction that is rolled back: kept, and the rollback holds
      const tx = mod._fb_start_transaction(db);
      expect(execParams(db, tx, 'INSERT INTO r VALUES (?, ?)', [9, 'v9'])).toBe(0);
      expect(mod._fb_rollback(tx)).toBe(0);
      expect(queryRows(db, 'SELECT COUNT(*) FROM r')).toEqual([[5]]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('drops a kept statement whose execution failed, and the next call works', () => {
      const db = freshDatabase('cache-fail');
      expect(exec(db, 0, 'CREATE TABLE f (id INTEGER NOT NULL PRIMARY KEY)')).toBe(0);
      expect(execParams(db, 0, 'INSERT INTO f VALUES (?)', [1])).toBe(0);
      expect(execParams(db, 0, 'INSERT INTO f VALUES (?)', [1])).not.toBe(0);   // duplicate key
      expect(execParams(db, 0, 'INSERT INTO f VALUES (?)', [2])).toBe(0);
      expect(queryRows(db, 'SELECT COUNT(*) FROM f')).toEqual([[2]]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('runs the new body of a procedure altered after a kept call', () => {
      const db = freshDatabase('cache-ddl');
      expect(exec(db, 0, 'CREATE OR ALTER PROCEDURE p RETURNS (v INTEGER) AS BEGIN v = 1; SUSPEND; END')).toBe(0);
      expect(queryRows(db, 'SELECT v FROM p')).toEqual([[1]]);
      expect(exec(db, 0, 'CREATE OR ALTER PROCEDURE p RETURNS (v INTEGER) AS BEGIN v = 2; SUSPEND; END')).toBe(0);
      expect(queryRows(db, 'SELECT v FROM p')).toEqual([[2]]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('lets DDL drop a table a kept statement reads', () => {
      const db = freshDatabase('cache-drop');
      expect(exec(db, 0, 'CREATE TABLE d (id INTEGER)')).toBe(0);
      expect(exec(db, 0, 'INSERT INTO d VALUES (1)')).toBe(0);
      expect(queryRows(db, 'SELECT id FROM d')).toEqual([[1]]);
      expect(`${exec(db, 0, 'DROP TABLE d')} ${errorText()}`).toBe('0 ');
      const sqlPtr = allocString(mod, 'SELECT id FROM d');
      try {
        expect(mod._fb_query(db, 0, sqlPtr, 0)).toBe(0);   // gone, not answered from a kept statement
        expect(errorText().toUpperCase()).toContain('D');
      } finally {
        mod._free(sqlPtr);
      }
      expect(exec(db, 0, 'CREATE TABLE d (id INTEGER, w INTEGER)')).toBe(0);
      expect(exec(db, 0, 'INSERT INTO d VALUES (7, 8)')).toBe(0);
      expect(queryRows(db, 'SELECT id FROM d')).toEqual([[7]]);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('keeps no more than its size, and works with the cache off', () => {
      const db = freshDatabase('cache-size');
      expect(exec(db, 0, 'CREATE TABLE s (id INTEGER)')).toBe(0);
      mod._fb_statement_cache(2);
      for (let i = 0; i < 6; i++) expect(queryRows(db, `SELECT ${i} FROM s`)).toEqual([]);
      mod._fb_statement_cache(0);
      for (let i = 0; i < 3; i++) expect(execParams(db, 0, 'INSERT INTO s VALUES (?)', [i])).toBe(0);
      expect(queryRows(db, 'SELECT COUNT(*) FROM s')).toEqual([[3]]);
      mod._fb_statement_cache(64);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    // ── The shared read transaction ─────────────────────────────────────
    //
    // With it on, an autocommit SELECT runs in a read-only transaction the
    // database keeps open.  It must read what a transaction of its own would.

    it('exports the read transaction switch, per database and off by default', () => {
      expect(typeof mod._fb_read_transaction).toBe('function');
      const a = freshDatabase('read-switch-a');
      const b = freshDatabase('read-switch-b');
      expect(mod._fb_read_transaction(a, 1)).toBe(0);
      expect(mod._fb_read_transaction(b, 1)).toBe(0);   // the other database's is its own
      expect(mod._fb_read_transaction(a, 0)).toBe(1);
      expect(mod._fb_read_transaction(b, 0)).toBe(1);
      expect(mod._fb_read_transaction(999999, 1)).toBe(-1);
      expect(errorText()).toContain('unknown database handle');
      expect(mod._fb_detach_database(a)).toBe(0);
      expect(mod._fb_detach_database(b)).toBe(0);
    });

    it('reads every commit, and nothing uncommitted, between shared reads', () => {
      const db = freshDatabase('read-commits');
      expect(exec(db, 0, 'CREATE TABLE c (id INTEGER)')).toBe(0);
      mod._fb_read_transaction(db, 1);
      try {
        expect(queryRows(db, 'SELECT COUNT(*) FROM c')).toEqual([[0]]);
        expect(execParams(db, 0, 'INSERT INTO c VALUES (?)', [1])).toBe(0);
        expect(queryRows(db, 'SELECT COUNT(*) FROM c')).toEqual([[1]]);
        const tx = mod._fb_start_transaction(db);
        expect(execParams(db, tx, 'INSERT INTO c VALUES (?)', [2])).toBe(0);
        expect(queryRows(db, 'SELECT COUNT(*) FROM c')).toEqual([[1]]);
        expect(mod._fb_commit(tx)).toBe(0);
        expect(queryRows(db, 'SELECT COUNT(*) FROM c')).toEqual([[2]]);
        // A failed read leaves the next one working.
        const sqlPtr = allocString(mod, 'SELECT 1 / 0 FROM c');
        try {
          expect(mod._fb_query(db, 0, sqlPtr, 0)).toBe(0);
        } finally {
          mod._free(sqlPtr);
        }
        expect(queryRows(db, 'SELECT COUNT(*) FROM c')).toEqual([[2]]);
        expect(mod._fb_detach_database(db)).toBe(0);
      } finally {
        mod._fb_read_transaction(db, 0);
      }
    });

    it('runs a SELECT that writes in a transaction of its own, and remembers it', () => {
      const db = freshDatabase('read-writer');
      expect(exec(db, 0, 'CREATE TABLE w (id INTEGER)')).toBe(0);
      // Counts its runs in a context variable, which no rollback undoes, then writes.
      expect(exec(db, 0, `CREATE PROCEDURE add_row RETURNS (n INTEGER) AS BEGIN
        RDB$SET_CONTEXT('USER_SESSION', 'RUNS',
          COALESCE(CAST(RDB$GET_CONTEXT('USER_SESSION', 'RUNS') AS INTEGER), 0) + 1);
        INSERT INTO w VALUES (1);
        SELECT COUNT(*) FROM w INTO n;
        SUSPEND;
      END`)).toBe(0);
      const runs = () => queryRows(db,
        "SELECT CAST(RDB$GET_CONTEXT('USER_SESSION', 'RUNS') AS INTEGER) FROM RDB$DATABASE")[0][0];
      mod._fb_read_transaction(db, 1);
      try {
        expect(queryRows(db, 'SELECT n FROM add_row')).toEqual([[1]]);
        expect(runs()).toBe(2);   // the read-only try, then its own transaction
        expect(queryRows(db, 'SELECT n FROM add_row')).toEqual([[2]]);
        expect(runs()).toBe(3);   // straight to its own transaction
        // EXECUTE PROCEDURE never tries the shared transaction.
        expect(exec(db, 0, 'CREATE PROCEDURE add_one AS BEGIN INSERT INTO w VALUES (2); END')).toBe(0);
        expect(queryRows(db, 'EXECUTE PROCEDURE add_one')).toEqual([]);
        expect(queryRows(db, 'SELECT COUNT(*) FROM w')).toEqual([[3]]);
        expect(mod._fb_detach_database(db)).toBe(0);
      } finally {
        mod._fb_read_transaction(db, 0);
      }
    });

    it('lets DDL change what shared reads read', () => {
      const db = freshDatabase('read-ddl');
      expect(exec(db, 0, 'CREATE TABLE d (id INTEGER)')).toBe(0);
      expect(exec(db, 0, 'INSERT INTO d VALUES (1)')).toBe(0);
      mod._fb_read_transaction(db, 1);
      try {
        expect(queryRows(db, 'SELECT id FROM d')).toEqual([[1]]);
        expect(`${exec(db, 0, 'DROP TABLE d')} ${errorText()}`).toBe('0 ');
        expect(exec(db, 0, 'CREATE TABLE d (id INTEGER, w INTEGER)')).toBe(0);
        expect(exec(db, 0, 'INSERT INTO d VALUES (7, 8)')).toBe(0);
        expect(queryRows(db, 'SELECT id, w FROM d')).toEqual([[7, 8]]);
        expect(mod._fb_detach_database(db)).toBe(0);
      } finally {
        mod._fb_read_transaction(db, 0);
      }
    });

    it('takes sharedReads as a FirebirdBrowser option', async () => {
      const db = new FirebirdBrowser('memory://shared-reads-option', {
        transport: new DirectTransport(),
        sharedReads: true,
      });
      try {
        await db.exec('CREATE TABLE o (id INTEGER)');
        expect((await db.query('SELECT COUNT(*) AS N FROM o')).rows).toEqual([{ N: 0 }]);
        await db.exec('INSERT INTO o VALUES (?)', [1]);
        expect((await db.query('SELECT COUNT(*) AS N FROM o')).rows).toEqual([{ N: 1 }]);
        // query(), not exec(): exec() splits a script on semicolons.
        await db.query('CREATE PROCEDURE ins RETURNS (n INTEGER) AS BEGIN ' +
          'INSERT INTO o VALUES (2); SELECT COUNT(*) FROM o INTO n; SUSPEND; END');
        expect((await db.query('SELECT n FROM ins')).rows).toEqual([{ N: 2 }]);
        expect((await db.query('SELECT COUNT(*) AS N FROM o')).rows).toEqual([{ N: 2 }]);
      } finally {
        await db.close();
      }
    });

    it('refuses sharedReads on a transport that cannot do it', () => {
      const bare = {} as EngineTransport;
      expect(() => new FirebirdBrowser('memory://shared-reads-bare', { transport: bare, sharedReads: true }))
        .toThrow('setSharedReads');
    });

    // ── Shape ids ───────────────────────────────────────────────────────
    //
    // With FB_QUERY_SHAPE_IDS (2), a kept statement's result names its
    // columns by id instead of describing them; fb_shape_columns(id) says
    // what the id means.

    const rawQuery = (db: number, sql: string, flags: number): string => {
      const sqlPtr = allocString(mod, sql);
      try {
        const ptr = mod._fb_query(db, 0, sqlPtr, flags);
        expect({ pointer: ptr > 0, error: errorText() }).toEqual({ pointer: true, error: '' });
        const json = mod.UTF8ToString(ptr);
        mod._fb_free_result(ptr);
        return json;
      } finally {
        mod._free(sqlPtr);
      }
    };
    const shapeColumns = (id: number): string | null => {
      const ptr = mod._fb_shape_columns(id);
      if (!ptr) return null;
      const json = mod.UTF8ToString(ptr);
      mod._fb_free_result(ptr);
      return json;
    };
    const idOf = (json: string): number => Number(/^\{"shape":(\d+),"rows":/.exec(json)![1]);

    it('names a kept statement\'s columns by id, only when asked', () => {
      const db = freshDatabase('shape-ids');
      expect(exec(db, 0, 'CREATE TABLE s (id INTEGER, name VARCHAR(10))')).toBe(0);
      expect(exec(db, 0, "INSERT INTO s VALUES (1, 'one')")).toBe(0);
      const sql = 'SELECT id, name FROM s';

      const plain = rawQuery(db, sql, 0);
      expect(plain.startsWith('{"columns":[')).toBe(true);

      const named = rawQuery(db, sql, 2);
      const id = idOf(named);
      expect(id).toBeGreaterThan(0);
      expect(JSON.parse(named)).toEqual({ shape: id, rows: [[1, 'one']] });
      expect(rawQuery(db, sql, 2)).toBe(named);   // the same id each time

      // The id stands for exactly the columns the plain form describes.
      expect(JSON.parse(shapeColumns(id)!)).toEqual({ columns: JSON.parse(plain).columns });

      // DDL empties the cache: the id is gone, and the statement comes back with a new one.
      expect(exec(db, 0, 'CREATE TABLE other (x INTEGER)')).toBe(0);
      expect(shapeColumns(id)).toBeNull();
      expect(idOf(rawQuery(db, sql, 2))).toBeGreaterThan(id);
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('describes the columns of a statement it does not keep', () => {
      const db = freshDatabase('shape-uncached');
      expect(exec(db, 0, 'CREATE TABLE u (id INTEGER)')).toBe(0);
      mod._fb_statement_cache(0);
      try {
        expect(rawQuery(db, 'SELECT id FROM u', 2).startsWith('{"columns":[')).toBe(true);
      } finally {
        mod._fb_statement_cache(64);
      }
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('returns the outputs of EXECUTE PROCEDURE as one row', () => {
      const db = freshDatabase('exec-proc-outputs');
      expect(exec(db, 0, `CREATE PROCEDURE add_two (a INTEGER, b INTEGER)
        RETURNS (total INTEGER, label VARCHAR(10)) AS BEGIN total = a + b; label = 'sum'; END`)).toBe(0);
      expect(queryRows(db, 'EXECUTE PROCEDURE add_two(2, 3)')).toEqual([[5, 'sum']]);

      // Inside a caller's transaction, and with the shared read transaction on
      // (which an EXECUTE PROCEDURE never uses).
      const sqlPtr = allocString(mod, 'EXECUTE PROCEDURE add_two(4, 5)');
      try {
        const tx = mod._fb_start_transaction(db);
        const resultPtr = mod._fb_query(db, tx, sqlPtr, 0);
        expect({ pointer: resultPtr > 0, error: errorText() }).toEqual({ pointer: true, error: '' });
        expect((JSON.parse(mod.UTF8ToString(resultPtr)) as { rows: unknown[][] }).rows).toEqual([[9, 'sum']]);
        mod._fb_free_result(resultPtr);
        expect(mod._fb_commit(tx)).toBe(0);
      } finally {
        mod._free(sqlPtr);
      }
      mod._fb_read_transaction(db, 1);
      try {
        expect(queryRows(db, 'EXECUTE PROCEDURE add_two(6, 7)')).toEqual([[13, 'sum']]);
      } finally {
        mod._fb_read_transaction(db, 0);
      }
      expect(mod._fb_detach_database(db)).toBe(0);
    });

    it('reports a readable message for invalid SQL', () => {
      mod._fb_init();

      const dbPath = '/data/errors.fdb';
      if (mod.FS.analyzePath(dbPath).exists) {
        mod.FS.unlink(dbPath);
      }
      const pathPtr = allocString(mod, dbPath);
      const db = mod._fb_create_database(pathPtr);
      mod._free(pathPtr);

      const sqlPtr = allocString(mod, 'SELECT * FROM no_such_table');
      try {
        expect(mod._fb_query(db, 0, sqlPtr, 0)).toBe(0);
        // Not just a numeric code — the engine's own text must reach the caller.
        expect(errorText().length).toBeGreaterThan(0);
        expect(errorText().toUpperCase()).toContain('NO_SUCH_TABLE');
      } finally {
        mod._free(sqlPtr);
      }

      mod._fb_detach_database(db);
    });
  },
);
