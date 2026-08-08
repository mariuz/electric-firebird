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
        const resultPtr = mod._fb_query(db, 0, sqlPtr);
        expect({ pointer: resultPtr > 0, error: errorText() })
          .toEqual({ pointer: true, error: '' });

        const json = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);

        const parsed = JSON.parse(json) as { columns: string[]; rows: unknown[][] };
        expect(parsed.columns).toEqual(['ID', 'NAME']);
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
        const resultPtr = mod._fb_query(db, 0, sqlPtr);
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
        expect(mod._fb_query(db, 0, sqlPtr)).toBe(0);
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
