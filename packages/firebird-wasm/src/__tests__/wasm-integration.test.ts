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
 *   - Return values match the expected contract (currently stub behaviour).
 *   - `allocString` correctly allocates a UTF-8 string on the WASM heap.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadFirebirdWasm, allocString } from '../wasm-loader';
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

    // ── _fb_init ────────────────────────────────────────────────────────

    it('_fb_init() returns 0 (success)', () => {
      const rc = mod._fb_init();
      expect(rc).toBe(0);
    });

    // ── _fb_create_database / _fb_attach_database / _fb_detach_database ─

    it('_fb_create_database() accepts a path pointer and returns a number', () => {
      const pathPtr = allocString(mod, '/data/test.fdb');
      try {
        const handle = mod._fb_create_database(pathPtr);
        expect(typeof handle).toBe('number');
      } finally {
        mod._free(pathPtr);
      }
    });

    it('_fb_attach_database() accepts a path pointer and returns a number', () => {
      const pathPtr = allocString(mod, '/data/test.fdb');
      try {
        const handle = mod._fb_attach_database(pathPtr);
        expect(typeof handle).toBe('number');
      } finally {
        mod._free(pathPtr);
      }
    });

    it('_fb_detach_database() returns 0 (success)', () => {
      const rc = mod._fb_detach_database(0);
      expect(rc).toBe(0);
    });

    // ── _fb_execute ─────────────────────────────────────────────────────

    it('_fb_execute() returns 0 (success)', () => {
      const sqlPtr = allocString(mod, 'CREATE TABLE t (id INTEGER)');
      try {
        const rc = mod._fb_execute(0, sqlPtr);
        expect(rc).toBe(0);
      } finally {
        mod._free(sqlPtr);
      }
    });

    // ── _fb_query ───────────────────────────────────────────────────────

    it('_fb_query() returns a non-zero pointer', () => {
      const sqlPtr = allocString(mod, 'SELECT 1 FROM RDB$DATABASE');
      try {
        const resultPtr = mod._fb_query(0, sqlPtr);
        expect(resultPtr).toBeGreaterThan(0);
        mod._fb_free_result(resultPtr);
      } finally {
        mod._free(sqlPtr);
      }
    });

    it('_fb_query() result is valid JSON with columns and rows arrays', () => {
      const sqlPtr = allocString(mod, 'SELECT 1 FROM RDB$DATABASE');
      try {
        const resultPtr = mod._fb_query(0, sqlPtr);
        expect(resultPtr).toBeGreaterThan(0);

        const json = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);

        const parsed = JSON.parse(json) as { columns: string[]; rows: unknown[][] };
        expect(Array.isArray(parsed.columns)).toBe(true);
        expect(Array.isArray(parsed.rows)).toBe(true);
      } finally {
        mod._free(sqlPtr);
      }
    });

    // ── _fb_start_transaction / _fb_commit / _fb_rollback ───────────────

    it('_fb_start_transaction() returns a number', () => {
      const txHandle = mod._fb_start_transaction(0);
      expect(typeof txHandle).toBe('number');
    });

    it('_fb_commit() returns 0 (success)', () => {
      const rc = mod._fb_commit(0);
      expect(rc).toBe(0);
    });

    it('_fb_rollback() returns 0 (success)', () => {
      const rc = mod._fb_rollback(0);
      expect(rc).toBe(0);
    });
  },
);
