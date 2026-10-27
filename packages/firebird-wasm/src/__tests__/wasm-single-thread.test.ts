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
import { buildIcuLocalePack, ICU_LOCALE_DATA_PATH } from '../browser/icu-locales';
import { compressGzipStream, createChunkedByteStream } from '../browser/data-stream';

const ST_JS_PATH = path.resolve(__dirname, '../../dist/wasm/firebird-embedded-st.js');
const hasSingleThread = fs.existsSync(ST_JS_PATH);

describe('wasmGlueFile', () => {
  it('names each build, and picks the one without threads by default', () => {
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

      // Zero-config live() without manual triggers or { events }:
      await db.exec('CREATE TABLE auto_items (id INTEGER, label VARCHAR(40))');
      const liveRows: Array<Array<{ ID: number; LABEL: string }>> = [];
      const live = await db.live<{ ID: number; LABEL: string }>(
        'SELECT id, label FROM auto_items ORDER BY id',
        { pollIntervalMs: 10 },
        (rows) => liveRows.push(rows),
      );
      expect(liveRows).toEqual([[]]);

      await db.exec("INSERT INTO auto_items VALUES (1, 'alpha')");
      for (let i = 0; i < 100 && live.rows.length < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(live.rows).toEqual([{ ID: 1, LABEL: 'alpha' }]);

      await db.exec("UPDATE auto_items SET label = 'updated' WHERE id = 1");
      for (let i = 0; i < 100 && live.rows[0]?.LABEL !== 'updated'; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(live.rows).toEqual([{ ID: 1, LABEL: 'updated' }]);

      await live.unsubscribe();
    } finally {
      await db.close();
    }
  });

  it('returns compact and detailed execution plans via explain() without executing the query', async () => {
    const db = new FirebirdBrowser('memory://st-explain', { transport: new DirectTransport({ threads: false }) });
    try {
      await db.exec('CREATE TABLE explain_items (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(20))');
      await db.exec("INSERT INTO explain_items VALUES (1, 'alpha')");

      const naturalPlan = await db.explain('SELECT id, label FROM explain_items');
      expect(naturalPlan).toMatch(/^PLAN\s*\(/i);
      expect(naturalPlan).toMatch(/EXPLAIN_ITEMS"?\s+NATURAL/i);

      const indexedPlan = await db.explain('SELECT id, label FROM explain_items WHERE id = ?');
      expect(indexedPlan).toMatch(/^PLAN\s*\(/i);
      expect(indexedPlan).toMatch(/EXPLAIN_ITEMS"?\s+INDEX/i);

      const detailedPlan = await db.explain(
        'SELECT id, label FROM explain_items WHERE id = ?',
        { detailed: true },
      );
      expect(detailedPlan).toMatch(/Select Expression/i);
      expect(detailedPlan).toMatch(/EXPLAIN_ITEMS/i);

      const ddlPlan = await db.explain('CREATE TABLE explain_unused (id INTEGER)');
      expect(ddlPlan).toBe('');

      // Explaining an INSERT prepares and drops the statement without executing it
      await db.explain("INSERT INTO explain_items VALUES (2, 'beta')");
      const rows = await db.query('SELECT id, label FROM explain_items');
      expect(rows.rows).toEqual([{ ID: 1, LABEL: 'alpha' }]);

      // Transaction explain() works inside db.transaction()
      await db.transaction(async (tx) => {
        const txPlan = await tx.explain('SELECT id FROM explain_items WHERE id = 1');
        expect(txPlan).toMatch(/EXPLAIN_ITEMS/i);
      });
    } finally {
      await db.close();
    }
  });

  it('reports database diagnostics and OIT/OAT transaction counters via databaseInfo()', async () => {
    const db = new FirebirdBrowser('memory://st-db-info', { transport: new DirectTransport({ threads: false }) });
    try {
      await db.exec('CREATE TABLE info_items (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(40))');
      await db.exec("INSERT INTO info_items VALUES (1, 'one')");

      const info = await db.databaseInfo();
      expect(info.pageSize).toBe(8192);
      expect(info.allocatedPages).toBeGreaterThan(0);
      expect(info.databaseSizeBytes).toBe(info.pageSize * info.allocatedPages);
      expect(info.odsVersion).toBeGreaterThanOrEqual(13);
      expect(info.oldestTransaction).toBeGreaterThan(0);
      expect(info.oldestActive).toBeGreaterThanOrEqual(info.oldestTransaction);
      expect(info.nextTransaction).toBeGreaterThanOrEqual(info.oldestActive);
      expect(info.transactionGap).toBe(Math.max(0, info.nextTransaction - info.oldestActive));
      expect(info.currentMemory).toBeGreaterThan(0);
      expect(info.maxMemory).toBeGreaterThanOrEqual(info.currentMemory);
      expect(info.fetches).toBeGreaterThan(0);

      // While an explicit transaction stays open and another transaction commits,
      // nextTransaction advances ahead of oldestActive.
      await db.transaction(async (tx) => {
        await tx.exec("INSERT INTO info_items VALUES (2, 'two')");
        // Execute an auto-commit statement to advance nextTransaction while tx is still active
        await db.exec("INSERT INTO info_items VALUES (3, 'three')");
        const during = await db.databaseInfo();
        expect(during.nextTransaction).toBeGreaterThan(info.nextTransaction);
        expect(during.transactionGap).toBeGreaterThanOrEqual(1);
      });
    } finally {
      await db.close();
    }
  });

  it('supports explicit prepared statement handles via db.prepare() and tx.prepare()', async () => {
    const db = new FirebirdBrowser('memory://st-prepare', { transport: new DirectTransport({ threads: false }) });
    try {
      await db.exec('CREATE TABLE prep_items (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(30))');

      const insertStmt = await db.prepare('INSERT INTO prep_items (id, label) VALUES (?, ?)');
      expect(insertStmt.sql).toBe('INSERT INTO prep_items (id, label) VALUES (?, ?)');
      expect(insertStmt.statementType).toBe('INSERT');
      expect(insertStmt.hasResultSet).toBe(false);
      expect(insertStmt.params).toHaveLength(2);
      expect(insertStmt.params[0]?.typeName).toBe('INTEGER');
      expect(insertStmt.params[1]?.typeName).toBe('VARYING');
      expect(insertStmt.fields).toEqual([]);
      expect(insertStmt.closed).toBe(false);

      const ins1 = await insertStmt.exec([1, 'alpha']);
      expect(ins1.affectedRows).toBe(1);

      const batchIns = await insertStmt.execBatch([
        [2, 'beta'],
        [3, 'gamma'],
      ]);
      expect(batchIns.affectedRows).toBe(2);

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

      // Batched cursor streaming via stmt.queryStream()
      const streamBatches: Array<Array<{ ID: number; LABEL: string }>> = [];
      for await (const batch of selectStmt.queryStream<{ ID: number; LABEL: string }>([1], { batchSize: 2 })) {
        streamBatches.push(batch.rows);
      }
      expect(streamBatches).toEqual([
        [
          { ID: 1, LABEL: 'alpha' },
          { ID: 2, LABEL: 'beta' },
        ],
        [{ ID: 3, LABEL: 'gamma' }],
      ]);

      // Early break in stmt.queryStream() closes the cursor cleanly
      const earlyRows: unknown[] = [];
      for await (const batch of selectStmt.queryStream([1], { rowMode: 'array', batchSize: 1 })) {
        earlyRows.push(...batch.rows);
        break;
      }
      expect(earlyRows).toEqual([[1, 'alpha']]);

      await selectStmt.close();
      expect(() => selectStmt.queryStream([1])).toThrow(/PreparedStatement has been closed/);

      await db.transaction(async (tx) => {
        const txSelect = await tx.prepare('SELECT id, label FROM prep_items WHERE id >= ? ORDER BY id');
        const txBatches: unknown[][] = [];
        for await (const batch of txSelect.queryStream([2], { rowMode: 'array', batchSize: 1 })) {
          txBatches.push(batch.rows);
        }
        expect(txBatches).toEqual([[[2, 'beta']], [[3, 'gamma']]]);
        await txSelect.close();

        const txStmt = await tx.prepare('UPDATE prep_items SET label = ? WHERE id = ?');
        expect(txStmt.params).toHaveLength(2);
        const upd = await txStmt.exec(['ALPHA', 1]);
        expect(upd.affectedRows).toBe(1);
        await txStmt.close();
      });

      const check = await db.query<{ LABEL: string }>('SELECT label FROM prep_items WHERE id = 1');
      expect(check.rows).toEqual([{ LABEL: 'ALPHA' }]);
    } finally {
      await db.close();
    }
  });

  it('dumps and restores databases via dumpDataStream() and loadDataStream() (raw and gzip)', async () => {
    const src = new FirebirdBrowser('memory://st-stream-src', { transport: new DirectTransport({ threads: false }) });
    const dstRaw = new FirebirdBrowser('memory://st-stream-dst-raw', { transport: new DirectTransport({ threads: false }) });
    try {
      await src.exec('CREATE TABLE stream_items (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(40))');
      await src.exec("INSERT INTO stream_items VALUES (1, 'streamed-one')");
      await src.exec("INSERT INTO stream_items VALUES (2, 'streamed-two')");

      // Raw chunked dump -> loadDataStream
      const rawStream = src.dumpDataStream({ chunkSize: 16384 });
      await dstRaw.loadDataStream(rawStream);
      const rawRows = await dstRaw.query<{ ID: number; LABEL: string }>(
        'SELECT id, label FROM stream_items ORDER BY id',
      );
      expect(rawRows.rows).toEqual([
        { ID: 1, LABEL: 'streamed-one' },
        { ID: 2, LABEL: 'streamed-two' },
      ]);

      // Gzip-compressed dump -> verify compressed size is much smaller -> loadDataStream (auto-detected gzip)
      const gzChunks: Uint8Array[] = [];
      let gzTotal = 0;
      const gzReader = src.dumpDataStream({ compression: 'gzip', chunkSize: 32768 }).getReader();
      let doneReading = false;
      while (!doneReading) {
        const { done, value } = await gzReader.read();
        if (done) {
          doneReading = true;
          break;
        }
        if (value) {
          gzChunks.push(value);
          gzTotal += value.byteLength;
        }
      }
      const rawInfo = await src.databaseInfo();
      expect(gzTotal).toBeGreaterThan(0);
      expect(gzTotal).toBeLessThan(rawInfo.databaseSizeBytes / 2);
      // Verify gzip magic header 0x1f 0x8b
      expect(gzChunks[0]?.[0]).toBe(0x1f);
      expect(gzChunks[0]?.[1]).toBe(0x8b);

      // Seed a new database via options.loadDataStream with the gzipped chunks
      const seeded = new FirebirdBrowser('memory://st-stream-seeded', {
        transport: new DirectTransport({ threads: false }),
        loadDataStream: (async function* () {
          for (const c of gzChunks) yield c;
        })(),
      });
      try {
        const seededRows = await seeded.query<{ ID: number; LABEL: string }>(
          'SELECT id, label FROM stream_items ORDER BY id',
        );
        expect(seededRows.rows).toEqual([
          { ID: 1, LABEL: 'streamed-one' },
          { ID: 2, LABEL: 'streamed-two' },
        ]);
      } finally {
        await seeded.close();
      }
    } finally {
      await dstRaw.close();
      await src.close();
    }
  });

  it('supports UNICODE, UNICODE_CI, and UNICODE_CI_AI collations when ICU data is embedded', async () => {
    if (!mod.FS.analyzePath('/firebird/icu/icudt68l.dat').exists) {
      return;
    }
    const db = new FirebirdBrowser('memory://st-icu', { transport: new DirectTransport({ threads: false }) });
    try {
      await db.exec(
        'CREATE TABLE words (' +
          'id INTEGER, ' +
          'ci VARCHAR(40) CHARACTER SET UTF8 COLLATE UNICODE_CI, ' +
          'ciai VARCHAR(40) CHARACTER SET UTF8 COLLATE UNICODE_CI_AI, ' +
          'u VARCHAR(40) CHARACTER SET UTF8 COLLATE UNICODE' +
          ')',
      );
      await db.exec("INSERT INTO words VALUES (1, 'Ähnlich', 'café', 'Zebra')");
      await db.exec("INSERT INTO words VALUES (2, 'Beta', 'plain', 'Apfel')");
      await db.exec("INSERT INTO words VALUES (3, 'Gamma', 'other', 'Ärzte')");

      const ciMatch = await db.query<{ CI: string }>("SELECT ci FROM words WHERE ci = 'ähnlich'");
      expect(ciMatch.rows).toEqual([{ CI: 'Ähnlich' }]);

      const ciaiMatch = await db.query<{ CIAI: string }>("SELECT ciai FROM words WHERE ciai = 'CAFE'");
      expect(ciaiMatch.rows).toEqual([{ CIAI: 'café' }]);

      const sorted = await db.query<{ U: string }>('SELECT u FROM words ORDER BY u');
      expect(sorted.rows.map((r) => r.U)).toEqual(['Apfel', 'Ärzte', 'Zebra']);
    } finally {
      await db.close();
    }
  });

  it('lazy-loads optional ICU locale tailoring packs for LOCALE=de_DE, es_ES, fr_FR, ja_JP', async () => {
    if (!mod.FS.analyzePath('/firebird/icu/icudt68l.dat').exists) {
      return;
    }
    const db = new FirebirdBrowser('memory://st-icu-locales', {
      transport: new DirectTransport({ threads: false }),
    });
    try {
      await expect(db.loadIcuLocaleData(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
        /Invalid ICU locale data package/,
      );

      const rawPack = buildIcuLocalePack(['de_DE', 'es_ES', 'fr_FR', 'ja_JP']);
      // Also exercise gzipped .dat.gz bundle auto-decompression
      const gzReader = compressGzipStream(createChunkedByteStream(rawPack)).getReader();
      const gzChunks: Uint8Array[] = [];
      let gzTotal = 0;
      let doneReading = false;
      while (!doneReading) {
        const { done, value } = await gzReader.read();
        if (done) {
          doneReading = true;
          break;
        }
        if (value) {
          gzChunks.push(value);
          gzTotal += value.byteLength;
        }
      }
      const gzPack = new Uint8Array(gzTotal);
      let off = 0;
      for (const c of gzChunks) {
        gzPack.set(c, off);
        off += c.byteLength;
      }

      await db.loadIcuLocaleData(gzPack);
      expect(mod.FS.analyzePath(ICU_LOCALE_DATA_PATH).exists).toBe(true);

      await db.exec("CREATE COLLATION unicode_de FOR UTF8 FROM UNICODE CASE INSENSITIVE 'LOCALE=de_DE'");
      await db.exec("CREATE COLLATION unicode_es FOR UTF8 FROM UNICODE CASE INSENSITIVE 'LOCALE=es_ES'");
      await db.exec("CREATE COLLATION unicode_fr FOR UTF8 FROM UNICODE CASE INSENSITIVE 'LOCALE=fr_FR'");
      await db.exec("CREATE COLLATION unicode_ja FOR UTF8 FROM UNICODE CASE INSENSITIVE 'LOCALE=ja_JP'");

      await db.exec(
        'CREATE TABLE locale_words (' +
          'id INTEGER NOT NULL PRIMARY KEY, ' +
          'de VARCHAR(40) CHARACTER SET UTF8 COLLATE unicode_de, ' +
          'es VARCHAR(40) CHARACTER SET UTF8 COLLATE unicode_es, ' +
          'fr VARCHAR(40) CHARACTER SET UTF8 COLLATE unicode_fr, ' +
          'ja VARCHAR(40) CHARACTER SET UTF8 COLLATE unicode_ja' +
          ')',
      );
      await db.exec("INSERT INTO locale_words VALUES (1, 'Äpfel', 'España', 'Français', '日本語')");

      const deMatch = await db.query<{ DE: string }>("SELECT de FROM locale_words WHERE de = 'äpfel'");
      expect(deMatch.rows).toEqual([{ DE: 'Äpfel' }]);

      const esMatch = await db.query<{ ES: string }>("SELECT es FROM locale_words WHERE es = 'españa'");
      expect(esMatch.rows).toEqual([{ ES: 'España' }]);

      const frMatch = await db.query<{ FR: string }>("SELECT fr FROM locale_words WHERE fr = 'français'");
      expect(frMatch.rows).toEqual([{ FR: 'Français' }]);

      const jaMatch = await db.query<{ JA: string }>("SELECT ja FROM locale_words WHERE ja = '日本語'");
      expect(jaMatch.rows).toEqual([{ JA: '日本語' }]);

      // Schema migrations & introspection against real Firebird WASM catalog
      const migResult = await db.migrate([
        {
          version: 1,
          name: 'create_authors',
          up: 'CREATE TABLE authors (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(80) NOT NULL)',
          down: 'DROP TABLE authors',
        },
        {
          version: 2,
          name: 'create_books_and_seq',
          up: [
            'CREATE TABLE books (id INTEGER NOT NULL PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE, title VARCHAR(120) NOT NULL)',
            'CREATE UNIQUE INDEX idx_books_title ON books (title)',
            'CREATE SEQUENCE seq_book_id',
            'CREATE VIEW v_books AS SELECT id, title FROM books',
          ],
          down: [
            'DROP VIEW v_books',
            'DROP SEQUENCE seq_book_id',
            'DROP TABLE books',
          ],
        },
      ]);
      expect(migResult.applied.map((m) => m.version)).toEqual(['1', '2']);
      expect(migResult.currentVersion).toBe('2');

      const schema = await db.introspect();
      const tableNames = schema.tables.map((t) => t.name);
      expect(tableNames).toContain('AUTHORS');
      expect(tableNames).toContain('BOOKS');
      expect(tableNames).not.toContain('FB_MIGRATIONS$');

      const booksTable = schema.tables.find((t) => t.name === 'BOOKS')!;
      expect(booksTable.primaryKey).toEqual(['ID']);
      expect(booksTable.foreignKeys).toEqual([
        expect.objectContaining({
          tableName: 'BOOKS',
          columns: ['AUTHOR_ID'],
          referencedTableName: 'AUTHORS',
          referencedColumns: ['ID'],
          onDelete: 'CASCADE',
        }),
      ]);
      expect(booksTable.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'IDX_BOOKS_TITLE',
            tableName: 'BOOKS',
            columns: ['TITLE'],
            unique: true,
          }),
        ]),
      );
      expect(schema.views).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'V_BOOKS',
          }),
        ]),
      );
      expect(schema.sequences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'SEQ_BOOK_ID',
          }),
        ]),
      );

      // Revert version 2 and verify BOOKS is dropped
      const downRes = await db.migrate(
        [
          {
            version: 1,
            name: 'create_authors',
            up: 'CREATE TABLE authors (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(80) NOT NULL)',
            down: 'DROP TABLE authors',
          },
          {
            version: 2,
            name: 'create_books_and_seq',
            up: [],
            down: [
              'DROP VIEW v_books',
              'DROP SEQUENCE seq_book_id',
              'DROP TABLE books',
            ],
          },
        ],
        { direction: 'down' },
      );
      expect(downRes.reverted.map((m) => m.version)).toEqual(['2']);
      expect(downRes.currentVersion).toBe('1');
      const afterDown = await db.introspect();
      expect(afterDown.tables.map((t) => t.name)).not.toContain('BOOKS');
    } finally {
      await db.close();
    }
  });
});
