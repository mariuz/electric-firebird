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
import { syncShapeToTable } from '../electric';
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
  function follow(table: string, from?: { offset: string; handle: string }) {
    const abort = new AbortController();
    aborts.push(abort);
    const stream = new ShapeStream({
      url,
      params: { table },
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
        `day_ DATE, at_ TIME, ts TIMESTAMP${zoned})`);
    await source.exec('CREATE TABLE pairs (a INTEGER NOT NULL, b VARCHAR(10) NOT NULL, v VARCHAR(20), PRIMARY KEY (a, b))');
    await source.exec(
      'INSERT INTO items (id, small, big, price, ratio, title, code, done, note, day_, at_, ts) VALUES ' +
        "(1, -2, 9007199254740993, 12.5, 0.1, 'it''s', 'ab', TRUE, 'a note longer than nothing', '2024-02-29', " +
        "'13:45:01.5', '2024-05-01 12:00:00.1234')");
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

  it('serves only the tables it was given, and refuses where', async () => {
    expect((await fetch(`${url}?table=rdb$database&offset=-1`)).status).toBe(404);
    expect((await fetch(`${url}?table=items&offset=-1&where=id%3D1`)).status).toBe(400);
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
});
