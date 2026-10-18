/**
 * wasm-single-thread.test.ts – the build without threads
 * (`firebird-embedded-st`, FB_WASM_THREADS=OFF).
 *
 * Skipped when that artifact has not been built: `wasm/build.sh` builds it by
 * default, `--variant threads` does not.
 *
 * What it holds the build to: a heap that is not a SharedArrayBuffer, and the
 * life of a database that the threaded build's engine started threads for
 * (docs/plans/sab-free-build.md) working without them: create, DDL, DML,
 * updates that leave garbage, an explicit transaction, events, detach and
 * attach.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadFirebirdWasm, allocString, lastError, hasSharedHeap, wasmGlueFile } from '../wasm-loader';
import type { FirebirdWasmModule } from '../wasm-loader';
import { FirebirdBrowser } from '../browser/firebird-browser';
import { DirectTransport } from '../browser/engine-transport';

const ST_JS_PATH = path.resolve(__dirname, '../../dist/wasm/firebird-embedded-st.js');
const hasSingleThread = fs.existsSync(ST_JS_PATH);

describe('wasmGlueFile', () => {
  it('names each build, and picks the threaded one in Node', () => {
    expect(wasmGlueFile(true)).toBe('firebird-embedded.js');
    expect(wasmGlueFile(false)).toBe('firebird-embedded-st.js');
    // The default since 0.9.0, in Node too: the build without threads.
    expect(wasmGlueFile()).toBe('firebird-embedded-st.js');
    expect(wasmGlueFile('auto')).toBe('firebird-embedded-st.js');
  });
});

(hasSingleThread ? describe : describe.skip)('the build without threads', () => {
  let mod: FirebirdWasmModule;

  beforeAll(async () => {
    mod = await loadFirebirdWasm({ threads: false });
    expect(mod._fb_init()).toBe(0);
    if (!mod.FS.analyzePath('/data').exists) mod.FS.mkdir('/data');
  });

  const withString = <T>(str: string, fn: (ptr: number) => T): T => {
    const ptr = allocString(mod, str);
    try {
      return fn(ptr);
    } finally {
      mod._free(ptr);
    }
  };
  const exec = (db: number, sql: string, tx = 0) => {
    const rc = withString(sql, (p) => mod._fb_execute(db, tx, p));
    expect(`${rc} ${lastError(mod)}`).toBe('0 ');
  };
  const query = (db: number, sql: string): unknown[][] => {
    const ptr = withString(sql, (p) => mod._fb_query(db, 0, p, 0));
    expect({ pointer: ptr > 0, error: lastError(mod) }).toEqual({ pointer: true, error: '' });
    const parsed = JSON.parse(mod.UTF8ToString(ptr)) as { rows: unknown[][] };
    mod._fb_free_result(ptr);
    return parsed.rows;
  };

  it('has a heap that is not a SharedArrayBuffer', () => {
    expect(hasSharedHeap(mod)).toBe(false);
    // Not instanceof: Jest runs tests in a realm of their own.
    expect(Object.prototype.toString.call(mod.HEAPU8.buffer)).toBe('[object ArrayBuffer]');
  });

  it('is a module of its own beside the threaded one', async () => {
    expect(await loadFirebirdWasm({ threads: false })).toBe(mod);
  });

  it('creates a database, changes it, and attaches to it again', () => {
    const file = '/data/st-life.fdb';
    if (mod.FS.analyzePath(file).exists) mod.FS.unlink(file);
    let db = withString(file, (p) => mod._fb_create_database(p));
    expect({ handle: db > 0, error: lastError(mod) }).toEqual({ handle: true, error: '' });

    exec(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, s VARCHAR(40), n INTEGER)');
    exec(db, 'CREATE INDEX t_s ON t (s)');
    exec(db, `EXECUTE BLOCK AS DECLARE i INTEGER = 0; BEGIN
      WHILE (i < 2000) DO BEGIN INSERT INTO t VALUES (:i, 'row ' || :i, 0); i = i + 1; END END`);
    // Updates and deletes leave back versions: garbage collection runs in the
    // statements here, with no collector thread.
    for (let i = 0; i < 10; i++) exec(db, 'UPDATE t SET n = n + 1 WHERE id < 500');
    exec(db, 'DELETE FROM t WHERE id >= 1500');
    expect(query(db, 'SELECT COUNT(*), SUM(n) FROM t')).toEqual([[1500, 5000]]);

    const tx = mod._fb_start_transaction(db);
    expect(tx).toBeGreaterThan(0);
    exec(db, "INSERT INTO t VALUES (99999, 'tx', 0)", tx);
    expect(mod._fb_commit(tx)).toBe(0);

    expect(query(db, "SELECT TRIM(RDB$CONFIG_VALUE) FROM RDB$CONFIG WHERE RDB$CONFIG_NAME = 'GCPolicy'"))
      .toEqual([['cooperative']]);
    expect(mod._fb_detach_database(db)).toBe(0);

    db = withString(file, (p) => mod._fb_attach_database(p));
    expect({ handle: db > 0, error: lastError(mod) }).toEqual({ handle: true, error: '' });
    expect(query(db, 'SELECT COUNT(*) FROM t')).toEqual([[1501]]);
    expect(mod._fb_detach_database(db)).toBe(0);
  });

  it('delivers events without a watcher thread', () => {
    const file = '/data/st-events.fdb';
    if (mod.FS.analyzePath(file).exists) mod.FS.unlink(file);
    const db = withString(file, (p) => mod._fb_create_database(p));
    expect(db).toBeGreaterThan(0);
    exec(db, 'CREATE TABLE e (id INTEGER)');
    exec(db, "CREATE TRIGGER e_ai FOR e AFTER INSERT AS BEGIN POST_EVENT 'ping'; END");

    const sub = withString('ping', (p) => mod._fb_events_subscribe(db, p));
    expect({ handle: sub > 0, error: lastError(mod) }).toEqual({ handle: true, error: '' });
    const poll = (): Record<string, number> => {
      const ptr = mod._fb_events_poll(sub);
      const counts = JSON.parse(mod.UTF8ToString(ptr)) as Record<string, number>;
      mod._fb_free_result(ptr);
      return counts;
    };

    // Nothing posted yet: the baseline delivery is absorbed, as in the
    // threaded build.
    expect(poll().ping ?? 0).toBe(0);
    // Delivered inline at commit, so the very next poll sees it, with no wait.
    exec(db, 'INSERT INTO e VALUES (1)');
    expect(poll()).toEqual({ ping: 1 });
    // A delivery disarms the subscription until a poll re-arms it, as in the
    // threaded build: of two posts, the first poll reports the one delivered
    // and the re-arm delivers the other, for the next poll.
    exec(db, 'INSERT INTO e VALUES (2)');
    exec(db, 'INSERT INTO e VALUES (3)');
    expect([poll().ping ?? 0, poll().ping ?? 0]).toEqual([1, 1]);
    expect(poll().ping ?? 0).toBe(0);

    expect(mod._fb_events_cancel(sub)).toBe(0);
    expect(mod._fb_detach_database(db)).toBe(0);
  });

  it('runs FirebirdBrowser, listen() included', async () => {
    const db = new FirebirdBrowser('memory://st', { transport: new DirectTransport({ threads: false }) });
    try {
      await db.exec('CREATE TABLE notes (id INTEGER, body VARCHAR(100))');
      // query(), not exec(): exec() splits on ';', and the body has one.
      await db.query("CREATE TRIGGER notes_ai FOR notes AFTER INSERT AS BEGIN POST_EVENT 'notes'; END");
      const seen: number[] = [];
      const sub = await db.listen('notes', (counts) => seen.push(counts.notes ?? 0), { pollIntervalMs: 10 });
      await db.exec("INSERT INTO notes VALUES (1, 'one')");
      for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(seen).toEqual([1]);
      await sub.unsubscribe();
      const result = await db.query<{ ID: number; BODY: string }>('SELECT id, body FROM notes');
      expect(result.rows).toEqual([{ ID: 1, BODY: 'one' }]);
    } finally {
      await db.close();
    }
  });
});
