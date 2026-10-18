/**
 * electric-server.test.ts – the shape server against a real Firebird server,
 * followed by Electric's own client.
 *
 * Source: a database on the Firebird server, written with FirebirdLite.
 * Server: createShapeServer over HTTP on a free port.  Client: Electric's
 * ShapeStream and Shape, with its value parsing off, so what is compared is
 * the exact text the server sends (what syncShapeToTable then converts is
 * unit-tested in electric.test.ts).  CI runs this on Firebird 3, 4 and 5
 * (`server-versions`); the types only Firebird 4 has are tested where the
 * server has them.  The whole chain into the browser engine is
 * e2e/tests/browser-firebird-shapes.spec.ts.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Shape, ShapeStream } from '@electric-sql/client';
import type { Message, Row } from '@electric-sql/client';
import { FirebirdLite } from '../firebird';
import { createShapeServer } from '../electric-server';
import { createWriteQueue, syncShapeToTable, syncShapesToTables, WriteRejected } from '../electric';
import type { LocalWrite } from '../electric';
import type { ElectricDatabase } from '../electric';
import type { ShapeServer } from '../electric-server';

const hasFirebirdLib = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createNativeClient, getDefaultLibraryFilename } = require('node-firebird-driver-native');
    void createNativeClient(getDefaultLibraryFilename());
    return true;
  } catch {
    return false;
  }
})();

if (process.env['FIREBIRD_REQUIRE_SERVER'] === '1' && !hasFirebirdLib) {
  describe('Firebird server required', () => {
    it('loads the Firebird client library', () => {
      throw new Error('FIREBIRD_REQUIRE_SERVER=1 but libfbclient could not be loaded');
    });
  });
}

const host = process.env['FIREBIRD_HOST'] ?? 'localhost';
const credentials = {
  username: process.env['FIREBIRD_USER'] ?? 'SYSDBA',
  password: process.env['FIREBIRD_PASSWORD'] ?? '',
};

/** Electric's parsing off: every value as the text the server sent. */
const TEXT = Object.fromEntries(
  ['int2', 'int4', 'int8', 'float4', 'float8', 'bool', 'json', 'jsonb'].map((t) => [t, (v: string) => v]),
);

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 50));
    last = await read();
  }
  return last;
}

/** A BLOB beside the dates: a failing date beside a blob used to kill the process. */
const DATED =
  '(id INTEGER NOT NULL PRIMARY KEY, note BLOB SUB_TYPE TEXT, day_ DATE, at_ TIME, ts TIMESTAMP, big BIGINT, price NUMERIC(10,2))';

const byId = (rows: Row[]) => [...rows].sort((a, b) => Number(a['id']) - Number(b['id']));

const describeIfFirebird = hasFirebirdLib ? describe : describe.skip;

describeIfFirebird('createShapeServer against a Firebird server', () => {
  jest.setTimeout(60_000);

  let source: FirebirdLite;
  let server: ShapeServer;
  let httpServer: http.Server;
  let url: string;
  let major = 3;
  let database: string;
  const aborts: AbortController[] = [];

  /** A live Shape of `table`, the way a client follows it. */
  function follow(
    table: string,
    from?: { offset: string; handle: string },
    at: string = url,
    extra: Record<string, unknown> = {},
  ) {
    const abort = new AbortController();
    aborts.push(abort);
    const stream = new ShapeStream({
      url: at,
      params: { table, ...extra } as never,
      parser: TEXT,
      signal: abort.signal,
      ...(from ? { offset: from.offset as never, handle: from.handle } : {}),
    });
    return { stream, shape: new Shape(stream) };
  }

  beforeAll(async () => {
    database = `${host}:${path.join(os.tmpdir(), `shape-source-${Date.now()}.fdb`)}`;
    source = new FirebirdLite(database, credentials);
    const version = await source.query<{ V: string }>(
      "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS v FROM rdb$database");
    major = Number(version.rows[0]!.V.split('.')[0]);
    const zoned = major >= 4 ? ', tstz TIMESTAMP WITH TIME ZONE, huge INT128' : '';
    await source.exec(
      'CREATE TABLE items (id INTEGER NOT NULL PRIMARY KEY, small SMALLINT, big BIGINT, price NUMERIC(10,2), ' +
        'ratio DOUBLE PRECISION, title VARCHAR(40), code CHAR(3), done BOOLEAN, note BLOB SUB_TYPE TEXT, ' +
        `day_ DATE, at_ TIME, ts TIMESTAMP, raw BLOB SUB_TYPE BINARY, bin VARCHAR(4) CHARACTER SET OCTETS${zoned})`);
    await source.exec('CREATE TABLE pairs (a INTEGER NOT NULL, b VARCHAR(10) NOT NULL, v VARCHAR(20), PRIMARY KEY (a, b))');
    await source.exec(
      'INSERT INTO items (id, small, big, price, ratio, title, code, done, note, day_, at_, ts, raw, bin) VALUES ' +
        "(1, -2, 9007199254740993, 12.5, 0.1, 'it''s', 'ab', TRUE, 'a note longer than nothing', '2024-02-29', " +
        "'13:45:01.5', '2024-05-01 12:00:00.1234', x'00ff800a', x'ff0080')");
    if (major >= 4) {
      await source.exec(
        "UPDATE items SET tstz = TIMESTAMP '2024-05-01 12:00:00 +02:00', huge = 170141183460469231731687303715884105727 WHERE id = 1");
    }
    await source.exec("INSERT INTO pairs VALUES (1, 'x', 'one-x')");
    await source.exec(`CREATE TABLE dated ${DATED}`);
    await source.exec(
      "INSERT INTO dated VALUES (1, 'a note', '2024-02-29', '13:45:01.5', '2024-05-01 12:00:00.1234', 9007199254740993, 12.5)");
    await source.exec('INSERT INTO dated (id) VALUES (2)');

    server = await createShapeServer({
      database,
      ...credentials,
      tables: ['items', 'pairs', 'dated'],
      pollIntervalMs: 50,
      liveTimeoutMs: 2_000,
    });
    httpServer = http.createServer(server.handler);
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/v1/shape`;
  });

  afterAll(async () => {
    for (const a of aborts) a.abort();
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => httpServer?.close(r));
    await server?.close();
    await source?.close();
  });

  it('describes the table in the types the client maps', async () => {
    const response = await fetch(`${url}?table=items&offset=-1`);
    const schema = JSON.parse(response.headers.get('electric-schema')!);
    expect(schema).toMatchObject({
      id: { type: 'int4', pk_index: 0, not_null: true },
      small: { type: 'int2' },
      big: { type: 'int8' },
      price: { type: 'numeric', precision: 10, scale: 2 },
      ratio: { type: 'float8' },
      title: { type: 'varchar', max_length: 40 },
      code: { type: 'bpchar', length: 3 },
      done: { type: 'bool' },
      note: { type: 'text' },
      day_: { type: 'date' },
      at_: { type: 'time' },
      ts: { type: 'timestamp' },
      raw: { type: 'bytea' },
      bin: { type: 'bytea' },
    });
    if (major >= 4) expect(schema).toMatchObject({ tstz: { type: 'timestamptz' }, huge: { type: 'numeric' } });
  });

  it('serves the snapshot as the exact text the client converts', async () => {
    const { shape } = follow('items');
    const rows = await shape.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '1', small: '-2', big: '9007199254740993', price: '12.50', ratio: '0.1', title: "it's",
      code: 'ab ', done: 'true', note: 'a note longer than nothing', day_: '2024-02-29',
      at_: '13:45:01.5000', ts: '2024-05-01 12:00:00.1234',
      // Postgres's hex form, byte for byte: a binary BLOB and a VARBINARY.
      raw: '\\x00ff800a', bin: '\\xff0080',
    });
    if (major >= 4) {
      expect(rows[0]).toMatchObject({
        tstz: '2024-05-01 10:00:00.0000+00',
        huge: '170141183460469231731687303715884105727',
      });
    }
  });

  it('follows inserts, updates and deletes as transactions commit', async () => {
    const { shape } = follow('items');
    await shape.rows;
    await source.transaction(async (tx) => {
      await tx.exec("INSERT INTO items (id, title, done) VALUES (2, 'two', FALSE)");
      await tx.exec("UPDATE items SET title = 'ONE', note = 'edited' WHERE id = 1");
    });
    await source.exec("INSERT INTO items (id, title) VALUES (3, 'three')");
    await source.exec('DELETE FROM items WHERE id = 3');

    const rows = await until(
      () => byId(shape.currentRows).map((r) => [r['id'], r['title'], r['note']]),
      (r) => r.length === 2 && r[0]![1] === 'ONE',
      'the changes',
    );
    expect(rows).toEqual([['1', 'ONE', 'edited'], ['2', 'two', null]]);
  });

  it('orders by commit, not by write: an earlier writer committing later is not lost', async () => {
    const { shape } = follow('items');
    await shape.rows;
    // A writes first and commits last; B commits in between.
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((r) => { releaseA = r; });
    const a = source.transaction(async (tx) => {
      await tx.exec("INSERT INTO items (id, title) VALUES (10, 'written first')");
      await aMayCommit;
    });
    await new Promise((r) => setTimeout(r, 200));
    await source.exec("INSERT INTO items (id, title) VALUES (11, 'committed first')");
    // The server serves 11 while 10 is still uncommitted...
    await until(() => shape.currentRows.some((r) => r['id'] === '11'), Boolean, 'the first commit');
    releaseA();
    await a;
    // ...and 10 still arrives after it, not skipped.
    await until(() => shape.currentRows.some((r) => r['id'] === '10'), Boolean, 'the later commit');
  });

  it('serves a composite key, and a changed key as a delete and an insert', async () => {
    const { shape } = follow('pairs');
    await shape.rows;
    await source.exec("UPDATE pairs SET b = 'y', v = 'one-y' WHERE a = 1 AND b = 'x'");
    await source.exec("INSERT INTO pairs VALUES (2, 'x', 'two-x')");
    const rows = await until(
      () => [...shape.currentRows].map((r) => `${r['a']}/${r['b']}=${r['v']}`).sort(),
      (r) => r.length === 2 && r[0] === '1/y=one-y',
      'the key change',
    );
    expect(rows).toEqual(['1/y=one-y', '2/x=two-x']);
  });

  it('resumes from a position: only what changed after it', async () => {
    const first = follow('items');
    await first.shape.rows;
    const position = { offset: String(first.stream.lastOffset), handle: first.stream.shapeHandle! };

    await source.exec("INSERT INTO items (id, title) VALUES (20, 'after the position')");
    const resumed = follow('items', position);
    const seen: Message<Row>[] = [];
    resumed.stream.subscribe((messages) => { seen.push(...messages); });
    await until(() => seen.some((m) => 'value' in m && m.value['id'] === '20'), Boolean, 'the change');
    const rowsSeen = seen.filter((m) => 'value' in m).map((m) => (m as { value: Row }).value['id']);
    expect(rowsSeen).toEqual(['20']);
  });

  it('sends a client with a handle it did not issue back to a snapshot', async () => {
    const response = await fetch(`${url}?table=items&offset=3_0&handle=someone-elses`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual([{ headers: { control: 'must-refetch' } }]);
    expect(response.headers.get('electric-handle')).toBeTruthy();
  });

  it('serves only the tables it was given, and refuses a where it does not take', async () => {
    expect((await fetch(`${url}?table=rdb$database&offset=-1`)).status).toBe(404);
    const refused = await fetch(`${url}?table=items&offset=-1&where=${encodeURIComponent('lower(title) = 1')}`);
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toMatch(/functions \(lower\) are not supported/);
  });

  /** Another server on the same database, with its own options. */
  async function another(extra: Partial<Parameters<typeof createShapeServer>[0]> = {}) {
    const other = await createShapeServer({ database, ...credentials, tables: ['items', 'pairs'], pollIntervalMs: 50, liveTimeoutMs: 2_000, ...extra });
    const otherHttp = http.createServer(other.handler);
    await new Promise<void>((r) => otherHttp.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${(otherHttp.address() as AddressInfo).port}/v1/shape`;
    return {
      server: other,
      url: at,
      close: async () => {
        otherHttp.closeAllConnections();
        await new Promise((r) => otherHttp.close(r));
        await other.close();
      },
    };
  }

  it('serves a where: only matching rows, and rows moving in and out of it', async () => {
    await source.exec("INSERT INTO items (id, title) VALUES (50, 'w-in')");
    await source.exec("INSERT INTO items (id, title) VALUES (51, 'w-out')");
    const { shape, stream } = follow('items', undefined, url, { where: "id >= $1 AND title LIKE 'w-%' AND title <> $2", params: { 1: '50', 2: 'w-out' } });
    const ids = async () => byId(await shape.rows).map((r) => r['id']);
    expect(await ids()).toEqual(['50']);
    // A shape of its own: not the whole table's handle.
    const whole = await fetch(`${url}?table=items&offset=-1`);
    await whole.arrayBuffer();
    expect(stream.shapeHandle).not.toBe(whole.headers.get('electric-handle'));

    await source.exec("UPDATE items SET title = 'w-in-now' WHERE id = 51");   // moves in
    await source.exec("UPDATE items SET title = 'w-out' WHERE id = 50");      // moves out
    await source.exec("INSERT INTO items (id, title) VALUES (52, 'x-never')"); // never in
    const rows = await until(() => byId(shape.currentRows).map((r) => r['id']), (r) => r.length === 1 && r[0] === '51', 'the moves');
    expect(rows).toEqual(['51']);
  });

  it('serves a large snapshot in pages, keyed, and the client reads them all', async () => {
    for (let id = 100; id < 107; id++) await source.exec('INSERT INTO items (id, title) VALUES (?, ?)', [id, `p${id}`]);
    const paged = await another({ snapshotPageRows: 3 });
    try {
      const first = await fetch(`${paged.url}?table=items&offset=-1&where=${encodeURIComponent('id >= 100 AND id < 107')}`);
      const body = await first.json() as Array<{ headers: Record<string, string> }>;
      // A page: three rows, no up-to-date, an offset naming where the next starts.
      expect(body).toHaveLength(3);
      expect(body.some((m) => m.headers['control'] === 'up-to-date')).toBe(false);
      expect(first.headers.get('electric-offset')).toMatch(/^\d+_[1-9]\d*$/);

      const { shape } = follow('items', undefined, paged.url, { where: 'id >= 100 AND id < 107' });
      expect(byId(await shape.rows).map((r) => r['id'])).toEqual(['100', '101', '102', '103', '104', '105', '106']);
      // A page cursor the server does not know sends the client back to the start.
      const lost = await fetch(`${paged.url}?table=items&offset=1_999&handle=${first.headers.get('electric-handle')}&where=${encodeURIComponent('id >= 100 AND id < 107')}`);
      expect(lost.status).toBe(409);
    } finally {
      await paged.close();
    }
  });

  it('prunes the log, and sends a client older than it back to a snapshot', async () => {
    const pruned = await another({ retainLogMs: null });
    try {
      const first = follow('items', undefined, pruned.url);
      await first.shape.rows;
      const old = { offset: String(first.stream.lastOffset), handle: first.stream.shapeHandle! };
      await source.exec("INSERT INTO items (id, title) VALUES (60, 'before pruning')");
      await until(() => first.shape.currentRows.some((r) => r['id'] === '60'), Boolean, 'the change');

      expect(await pruned.server.prune(new Date(Date.now() + 1_000))).toBeGreaterThan(0);
      const { rows } = await source.query<{ N: number }>('SELECT COUNT(*) AS n FROM electric_changes WHERE commit_seq IS NOT NULL');
      expect(Number(rows[0]!.N)).toBe(0);

      // Behind the pruning: 409, then a snapshot, which has the row.
      const behind = await fetch(`${pruned.url}?table=items&offset=${old.offset}&handle=${old.handle}`);
      expect(behind.status).toBe(409);
      const resumed = follow('items', old, pruned.url);
      await until(() => resumed.shape.currentRows.some((r) => r['id'] === '60'), Boolean, 'the snapshot after pruning');
      // And a client at the head goes on as before.
      await source.exec("INSERT INTO items (id, title) VALUES (61, 'after pruning')");
      await until(() => first.shape.currentRows.some((r) => r['id'] === '61'), Boolean, 'a change after pruning');
    } finally {
      await pruned.close();
    }
  });

  it('wakes a live request on the commit, not the next poll', async () => {
    // Polling every minute: only the event can bring the change in time.
    const eventful = await another({ pollIntervalMs: 60_000, liveTimeoutMs: 30_000 });
    try {
      const { shape } = follow('items', undefined, eventful.url);
      await shape.rows;
      await new Promise((r) => setTimeout(r, 300)); // the client is waiting in a live request
      const wrote = Date.now();
      await source.exec("INSERT INTO items (id, title) VALUES (70, 'by event')");
      await until(() => shape.currentRows.some((r) => r['id'] === '70'), Boolean, 'the change');
      expect(Date.now() - wrote).toBeLessThan(5_000);
    } finally {
      await eventful.close();
    }
  });

  it('numbers only under the lock every server takes, so numbers commit in order', async () => {
    // Another server mid-numbering holds the ELECTRIC_META row.  Numbering
    // past it could commit a higher number before its lower one, and a
    // client that saw the higher would never be sent the lower.
    const { shape } = follow('items');
    await shape.rows;
    const holder = new FirebirdLite(database, credentials);
    try {
      await holder.transaction(async (tx) => {
        await tx.exec('UPDATE electric_meta SET epoch = epoch');
        await source.exec("INSERT INTO items (id, title) VALUES (80, 'held')");
        await new Promise((r) => setTimeout(r, 800));
        expect(shape.currentRows.some((r) => r['id'] === '80')).toBe(false);
      });
      await until(() => shape.currentRows.some((r) => r['id'] === '80'), Boolean, 'the change once the lock is free');
    } finally {
      await holder.close();
    }
  });

  it('runs two servers on one database: each serves every commit, in order', async () => {
    const second = await another();
    try {
      const a = follow('items');
      const b = follow('items', undefined, second.url);
      await Promise.all([a.shape.rows, b.shape.rows]);
      // Writers committing while both servers number the log.
      await Promise.all(Array.from({ length: 12 }, (_, i) =>
        source.exec('INSERT INTO items (id, title) VALUES (?, ?)', [200 + i, `two-${i}`])));
      const want = Array.from({ length: 12 }, (_, i) => String(200 + i));
      for (const { shape } of [a, b]) {
        await until(() => want.every((id) => shape.currentRows.some((r) => r['id'] === id)), Boolean, 'every row on both');
      }
      // Numbers given once each: no change numbered twice or skipped.
      const { rows } = await source.query<{ N: number }>('SELECT COUNT(*) AS n FROM electric_changes WHERE commit_seq IS NULL');
      expect(Number(rows[0]!.N)).toBe(0);
    } finally {
      await second.close();
    }
  });

  it('closes while live requests are waiting, without touching the closed connection', async () => {
    // A live request polls the log every pollIntervalMs. Closing used to
    // disconnect at once, and the next poll started a transaction on the
    // closed connection: the native client crashed the process.
    for (let round = 0; round < 10; round++) {
      const other = await createShapeServer({
        database,
        ...credentials,
        tables: ['items'],
        pollIntervalMs: 5,
        liveTimeoutMs: 5_000,
      });
      const otherHttp = http.createServer(other.handler);
      await new Promise<void>((r) => otherHttp.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(otherHttp.address() as AddressInfo).port}/v1/shape`;
      const first = await fetch(`${base}?table=items&offset=-1`);
      await first.arrayBuffer();
      const at = `table=items&offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`;
      const waiting = [1, 2, 3].map(() => fetch(`${base}?${at}&live=true`).then((r) => r.status, () => 0));

      await new Promise((r) => setTimeout(r, 20 + round * 3));
      await other.close();
      // Each ends, with the 503 a closing server gives or a 500, instead of
      // polling on; and the process is still here to see it.
      for (const status of await Promise.all(waiting)) expect([200, 500, 503, 0]).toContain(status);
      otherHttp.closeAllConnections();
      await new Promise((r) => otherHttp.close(r));
    }
  });

  it('writes locally at once, sends to the source, and drops each write once its transaction comes back', async () => {
    await source.exec('CREATE TABLE todos (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(40), done BOOLEAN)');
    await source.exec("INSERT INTO todos VALUES (1, 'from the server', FALSE)");
    const served = await another({ tables: ['todos'] });
    const target = new FirebirdLite(`${host}:${path.join(os.tmpdir(), `writes-target-${Date.now()}.fdb`)}`, credentials);
    let online = true;
    const sent: LocalWrite[] = [];
    const errors: string[] = [];
    try {
      await target.exec('CREATE TABLE todos (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(40), done BOOLEAN)');
      const db = target as unknown as ElectricDatabase;
      // The app's API: writes to the source, says which transaction did it.
      const writes = await createWriteQueue(db, {
        retryMs: 100,
        onError: (e) => errors.push(e.message),
        send: async (w) => {
          if (!online) throw new Error('offline');
          if (w.value['title'] === 'refused') throw new WriteRejected('the server says no');
          sent.push(w);
          return source.transaction(async (tx) => {
            if (w.operation === 'insert') {
              await tx.exec('UPDATE OR INSERT INTO todos (id, title, done) VALUES (?, ?, ?) MATCHING (id)',
                [w.key['id'], w.value['title'] ?? null, w.value['done'] ?? null]);
            } else if (w.operation === 'update') {
              await tx.exec('UPDATE todos SET title = COALESCE(?, title), done = COALESCE(?, done) WHERE id = ?',
                [w.value['title'] ?? null, w.value['done'] ?? null, w.key['id']]);
            } else {
              await tx.exec('DELETE FROM todos WHERE id = ?', [w.key['id']]);
            }
            const { rows } = await tx.query<{ T: number }>('SELECT CURRENT_TRANSACTION AS t FROM rdb$database');
            return { txid: rows[0]!.T };
          });
        },
      });
      const sync = await syncShapeToTable(db, {
        shape: { url: served.url, params: { table: 'todos' } },
        table: 'todos',
        shapeKey: 'todos',
        writes,
        onError: (e) => errors.push(`sync: ${e.message}`),
      });
      const local = async () => (await target.query<{ ID: number; TITLE: string; DONE: boolean }>(
        'SELECT id, title, done FROM todos ORDER BY id')).rows.map((r) => `${r.ID}:${r.TITLE}:${r.DONE}`);
      try {
        await sync.upToDate;
        expect(await local()).toEqual(['1:from the server:false']);

        // Seen here before the source has it; gone from the queue once its
        // transaction has come back down the shape.
        await writes.insert('todos', { id: 2, title: 'mine', done: false });
        expect(await local()).toEqual(['1:from the server:false', '2:mine:false']);
        await until(() => writes.pending(), (p) => p.length === 0, 'the write confirmed');
        expect((await source.query('SELECT title FROM todos WHERE id = 2')).rows).toEqual([{ TITLE: 'mine' }]);

        // Offline: kept, and kept over the server's own change to the row.
        online = false;
        await writes.update('todos', { id: 1 }, { title: 'edited offline' });
        await source.exec('UPDATE todos SET done = TRUE WHERE id = 1');
        await until(local, (r) => r[0] === '1:edited offline:true', 'the server change under the local one');
        expect((await writes.pending()).map((w) => w.operation)).toEqual(['update']);

        // Online again: sent, confirmed, and the source agrees.
        online = true;
        await writes.flush();
        await until(() => writes.pending(), (p) => p.length === 0, 'the offline write confirmed');
        expect((await source.query('SELECT title, done FROM todos WHERE id = 1')).rows)
          .toEqual([{ TITLE: 'edited offline', DONE: true }]);

        // Refused: rolled back to what the source has.
        await writes.insert('todos', { id: 3, title: 'refused', done: false });
        await until(local, (r) => !r.some((x) => x.startsWith('3:')), 'the rejected write rolled back');
        expect(errors).toContain('the server says no');
        expect(await writes.pending()).toEqual([]);
        expect(sent.map((w) => w.value['title'])).toEqual(['mine', 'edited offline']);
      } finally {
        await sync.unsubscribe();
        await writes.close();
      }
    } finally {
      await target.close();
      await served.close();
    }
  });

  it('picks up changes from a connection opened before the capture was installed', async () => {
    // `source` attached before createShapeServer installed the triggers; its
    // writes are numbered all the same (a commit trigger would have missed
    // them: database triggers load when a connection attaches).
    const { shape } = follow('items');
    await shape.rows;
    await source.exec("INSERT INTO items (id, title) VALUES (30, 'old connection')");
    await until(() => shape.currentRows.some((r) => r['id'] === '30'), Boolean, 'the change');
  });
  it('syncs into a FirebirdLite database in the same process, dates and times exact', async () => {
    // The source, the shape server and the target all in this one process,
    // on one client library: the case that died with SIGSEGV when the target
    // could not take a date as text.
    const target = new FirebirdLite(`${host}:${path.join(os.tmpdir(), `shape-target-${Date.now()}.fdb`)}`, credentials);
    try {
      await target.exec(`CREATE TABLE dated ${DATED}`);
      const sync = await syncShapeToTable(target as unknown as ElectricDatabase, {
        shape: { url, params: { table: 'dated' } },
        table: 'dated',
        shapeKey: null,
        onError: () => undefined,
      });
      try {
        await sync.upToDate;
        const columns =
          'id, CAST(note AS VARCHAR(40)), CAST(day_ AS VARCHAR(10)), CAST(at_ AS VARCHAR(13)), ' +
          'CAST(ts AS VARCHAR(24)), CAST(big AS VARCHAR(20)), CAST(price AS VARCHAR(12))';
        const read = async (db: FirebirdLite) =>
          (await db.query(`SELECT ${columns} FROM dated ORDER BY id`, [], { rowMode: 'array' })).rows;
        expect(await read(target)).toEqual([
          [1, 'a note', '2024-02-29', '13:45:01.5000', '2024-05-01 12:00:00.1234', '9007199254740993', '12.50'],
          [2, null, null, null, null, null, null],
        ]);

        await source.exec("UPDATE dated SET ts = '1999-12-31 23:59:59.9999', at_ = '00:00:00.0001' WHERE id = 2");
        await until(() => read(target), (rows) => rows[1]?.[4] !== null, 'the update');
        expect(await read(target)).toEqual(await read(source));
      } finally {
        await sync.unsubscribe();
      }
    } finally {
      await target.close();
    }
  });

  it('syncs two shapes into a FirebirdLite database together: a transaction lands in both or neither', async () => {
    const targetPath = `${host}:${path.join(os.tmpdir(), `shapes-target-${Date.now()}.fdb`)}`;
    const target = new FirebirdLite(targetPath, credentials);
    let reader: FirebirdLite | undefined;
    try {
      await target.exec('CREATE TABLE items (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(40))');
      await target.exec('CREATE TABLE pairs (a INTEGER NOT NULL, b VARCHAR(10) NOT NULL, v VARCHAR(20), PRIMARY KEY (a, b))');
      const sync = await syncShapesToTables(target as unknown as ElectricDatabase, {
        shapes: {
          items: { shape: { url, params: { table: 'items', columns: ['id', 'title'] } }, table: 'items' },
          pairs: { shape: { url, params: { table: 'pairs' } }, table: 'pairs' },
        },
        key: 'both',
        onError: () => undefined,
      });
      try {
        await sync.upToDate;
        // Each commit of the target holds the whole of each source transaction:
        // a reader (on a connection of its own) never sees item 40 without its
        // pair, or the other way round.
        reader = new FirebirdLite(targetPath, credentials);
        const seen: string[] = [];
        let watching = true;
        const watch = (async () => {
          while (watching) {
            const { rows } = await reader!.query<{ I: number; P: number }>(
              "SELECT (SELECT COUNT(*) FROM items WHERE id = 40) AS i, (SELECT COUNT(*) FROM pairs WHERE a = 40) AS p FROM rdb$database");
            seen.push(`${rows[0]!.I}${rows[0]!.P}`);
            await new Promise((r) => setTimeout(r, 5));
          }
        })();
        await source.transaction(async (tx) => {
          await tx.exec("INSERT INTO items (id, title) VALUES (40, 'with a pair')");
          await tx.exec("INSERT INTO pairs VALUES (40, 'z', 'pair of 40')");
        });
        await until(() => seen[seen.length - 1], (v) => v === '11', 'both rows');
        watching = false;
        await watch;
        expect(seen.filter((v) => v === '10' || v === '01')).toEqual([]);
      } finally {
        await sync.unsubscribe();
      }
    } finally {
      await reader?.close();
      await target.close();
    }
  });
});
