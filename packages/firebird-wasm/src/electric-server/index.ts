/**
 * firebird-wasm/electric-server – a Firebird server's tables, served over
 * Electric's HTTP shape protocol.
 *
 * ```ts
 * import * as http from 'node:http';
 * import { createShapeServer } from 'firebird-wasm/electric-server';
 *
 * const shapes = await createShapeServer({
 *   database: 'localhost:/data/app.fdb', username: 'SYSDBA', password: '…',
 *   tables: ['items'],
 * });
 * http.createServer(shapes.handler).listen(3000);
 * // in the browser: syncShapeToTable(db, { shape: { url: 'http://…:3000/v1/shape', params: { table: 'items' } }, … })
 * ```
 *
 * Electric itself reads only Postgres; this stands in its place for a
 * Firebird source.  It installs triggers that log each changed row's key,
 * numbers the log in commit order itself (see
 * docs/plans/firebird-shape-server.md), and serves a snapshot and then the
 * changes after it.  One server per database: two would number the log
 * against each other.  Node only: it uses the native client (`node-firebird-driver-
 * native`, an optional dependency of this package).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Attachment, Blob as FbBlob, Client, Transaction } from 'node-firebird-driver';
import { TransactionIsolation } from 'node-firebird-driver';
import { planTable, quote, relationName, renderValue } from './catalog';
import type { FirebirdColumn, TablePlan } from './catalog';
import { CHANGES, KEY_COLUMNS, META, installCapture, stampCommitted } from './capture';

export { triggerName, tableTrigger } from './capture';
export { planTable, planColumn, shapeName } from './catalog';
export type { TablePlan, ColumnPlan, FirebirdColumn } from './catalog';

/** Options of {@link createShapeServer}. */
export interface ShapeServerOptions {
  /** The database, as the native client takes it: `host:/path/db.fdb`. */
  database: string;
  username?: string;
  password?: string;
  /** Path to the Firebird client library.  Default: the system's. */
  libraryPath?: string;
  /** The tables served, as written in SQL (`items`, or `"Mixed"`).  Each needs a primary key. */
  tables: string[];
  /** Install the log and the triggers (idempotent).  Default true. */
  install?: boolean;
  /** How long a live request waits for a change.  Default 20 000 ms, as Electric. */
  liveTimeoutMs?: number;
  /** How often a waiting live request looks at the log.  Default 100 ms. */
  pollIntervalMs?: number;
}

/** A running shape server. */
export interface ShapeServer {
  /** The Node HTTP handler: `http.createServer(server.handler)`. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** The plans of the served tables, by Firebird name. */
  readonly tables: ReadonlyMap<string, TablePlan>;
  /** Stop answering and close the connection. */
  close(): Promise<void>;
}

type Message = Record<string, unknown>;

const EXPOSED = 'electric-cursor,electric-handle,electric-offset,electric-schema,electric-up-to-date';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Connect, install the capture, and return a handler serving `options.tables`. */
export async function createShapeServer(options: ShapeServerOptions): Promise<ShapeServer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const native = require('node-firebird-driver-native') as typeof import('node-firebird-driver-native');
  const client: Client = native.createNativeClient(options.libraryPath ?? native.getDefaultLibraryFilename());
  const attachment: Attachment = await client.connect(options.database, {
    username: options.username,
    password: options.password,
  });

  const liveTimeoutMs = options.liveTimeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;

  const tables = new Map<string, TablePlan>();
  try {
    for (const given of options.tables) {
      const name = relationName(given);
      tables.set(name, await describeTable(attachment, name));
    }
    if (options.install ?? true) await installCapture(attachment, [...tables.values()]);
  } catch (err) {
    await attachment.disconnect().catch(() => undefined);
    await client.dispose().catch(() => undefined);
    throw err;
  }

  const epoch = await readOnly(attachment, async (tx) => {
    const rs = await attachment.executeQuery(tx, `SELECT FIRST 1 EPOCH FROM ${META}`);
    const rows = await rs.fetch();
    await rs.close();
    return String(rows[0]?.[0] ?? 'none');
  });

  let closed = false;

  /** Number what has committed since, then read in a snapshot. */
  const stampedSnapshot = async <T>(fn: (tx: Transaction, top: number) => Promise<T>): Promise<T> => {
    await serialized(attachment, () => stampCommitted(attachment));
    return readOnly(attachment, async (tx) => {
      const rs = await attachment.executeQuery(tx, `SELECT MAX(COMMIT_SEQ) FROM ${CHANGES}`);
      const top = Number((await rs.fetch())[0]?.[0] ?? 0);
      await rs.close();
      return fn(tx, top);
    });
  };

  const handleOf = (table: TablePlan) => `${epoch}-${hashName(table.name)}`;

  // A snapshot may hold changes not numbered yet; they are numbered above
  // its offset and served again later, which re-applies them as no-ops.
  const snapshot = async (table: TablePlan, columns: TablePlan['columns']) => {
    return stampedSnapshot(async (tx, top) => {
      const rs = await attachment.executeQuery(
        tx, `SELECT ${columns.map((c) => c.select).join(', ')} FROM ${quote(table.name)}`);
      const messages: Message[] = [];
      for (const row of await rs.fetch()) {
        messages.push(await change('insert', table, columns, row, tx));
      }
      await rs.close();
      return { messages, offset: top };
    });
  };

  /** The changes to `table` after `after`, up to the watermark, one per key. */
  const changesAfter = async (table: TablePlan, columns: TablePlan['columns'], after: number) => {
    return stampedSnapshot(async (tx, top) => {
      if (top <= after) return { messages: [] as Message[], offset: after };
      const keys = Array.from({ length: KEY_COLUMNS }, (_, i) => `K${i + 1}`).join(', ');
      const rs = await attachment.executeQuery(
        tx,
        `SELECT OP, ${keys} FROM ${CHANGES} WHERE TABLE_NAME = ? AND COMMIT_SEQ > ? AND COMMIT_SEQ <= ? ` +
          'ORDER BY COMMIT_SEQ, CHANGE_ID',
        [table.name, after, top],
      );
      // The last operation per key wins; the row is read as it is now.
      const last = new Map<string, { op: string; key: unknown[] }>();
      for (const row of await rs.fetch()) {
        const key = row.slice(1, 1 + table.key.length);
        last.set(JSON.stringify(key), { op: String(row[0]), key });
      }
      await rs.close();

      const where = table.key.map((k) => `${quote(k)} = ?`).join(' AND ');
      const select = `SELECT ${columns.map((c) => c.select).join(', ')} FROM ${quote(table.name)} WHERE ${where}`;
      const messages: Message[] = [];
      for (const { op, key } of last.values()) {
        let current: unknown[] | null = null;
        if (op !== 'D') {
          const found = await attachment.executeQuery(tx, select, key);
          current = (await found.fetch({ fetchSize: 1 }))[0] ?? null;
          await found.close();
        }
        messages.push(current
          ? await change('insert', table, columns, current, tx)
          : deletion(table, key));
      }
      return { messages, offset: top };
    });
  };

  const change = async (
    operation: 'insert',
    table: TablePlan,
    columns: TablePlan['columns'],
    row: unknown[],
    tx: Transaction,
  ): Promise<Message> => {
    const value: Record<string, string | null> = {};
    for (let i = 0; i < columns.length; i++) {
      const plan = columns[i]!;
      let raw = row[i];
      if (plan.render === 'blob' && raw) raw = await readBlob(attachment, tx, raw as FbBlob);
      value[plan.shapeName] = renderValue(plan, raw);
    }
    return { key: keyOf(table, table.key.map((k) => value[shapeOf(table, k)])), value, headers: { operation } };
  };

  const deletion = (table: TablePlan, key: unknown[]): Message => {
    const value: Record<string, string | null> = {};
    table.key.forEach((k, i) => {
      const plan = table.columns.find((c) => c.name === k)!;
      const text = key[i] === null || key[i] === undefined ? null : String(key[i]);
      // The log keeps the key as Firebird's text; booleans as TRUE/FALSE.
      value[plan.shapeName] = plan.render === 'boolean' && text !== null ? text.toLowerCase() : text;
    });
    return { key: keyOf(table, Object.values(value)), value, headers: { operation: 'delete' } };
  };

  const respond = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': EXPOSED,
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': '*',
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://shape.server');
    if (req.method !== 'GET' || url.pathname !== '/v1/shape') {
      throw new HttpError(404, 'Only GET /v1/shape is served');
    }
    const params = url.searchParams;
    const given = params.get('table');
    if (!given) throw new HttpError(400, 'table is required');
    const table = tables.get(relationName(given));
    if (!table) throw new HttpError(404, `Table ${given} is not served`);
    if (params.get('where')) throw new HttpError(400, 'where is not supported by this server yet');
    const columns = selectColumns(table, params.get('columns'));
    const schema = Object.fromEntries(columns.map((c) => [c.shapeName, table.schema[c.shapeName]]));
    const handle = handleOf(table);
    const upToDate = { headers: { control: 'up-to-date' } };
    const offsetParam = params.get('offset') ?? '-1';

    if (offsetParam === '-1') {
      const { messages, offset } = await snapshot(table, columns);
      respond(res, 200, [...messages, upToDate], {
        'electric-handle': handle,
        'electric-offset': `${offset}_0`,
        'electric-schema': JSON.stringify(schema),
        'electric-up-to-date': '',
      });
      return;
    }

    if (params.get('handle') !== handle) {
      respond(res, 409, [{ headers: { control: 'must-refetch' } }], { 'electric-handle': handle });
      return;
    }
    const after = offsetParam === 'now'
      ? await stampedSnapshot(async (_tx, top) => top)
      : Number(offsetParam.split('_')[0]);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, `offset ${offsetParam} is not one this server gave`);

    const live = params.get('live') === 'true';
    const deadline = Date.now() + (live ? liveTimeoutMs : 0);
    let result = await changesAfter(table, columns, after);
    while (live && result.messages.length === 0 && Date.now() < deadline && !closed && !req.destroyed) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      if (closed) throw new HttpError(503, 'The shape server is closing');
      result = await changesAfter(table, columns, after);
    }
    const headers: Record<string, string> = {
      'electric-handle': handle,
      'electric-offset': `${result.offset}_0`,
      'electric-up-to-date': '',
    };
    if (live) headers['electric-cursor'] = String(Math.floor(Date.now() / 1000));
    else headers['electric-schema'] = JSON.stringify(schema);
    respond(res, 200, [...result.messages, upToDate], headers);
  };

  return {
    tables,
    handler: (req, res) => {
      if (closed) {
        respond(res, 503, { message: 'The shape server is closing' });
        return;
      }
      serve(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (!res.headersSent) respond(res, status, { message: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // In the connection's queue, after whatever is running on it: a live
      // request polls the log, and a native call on a disconnected
      // attachment crashes the process rather than throwing. Whatever is
      // queued after this is refused instead of run.
      await serialized(attachment, async () => {
        disconnected.add(attachment);
        await attachment.disconnect().catch(() => undefined);
      });
      await client.dispose().catch(() => undefined);
    },
  };
}

/**
 * One transaction at a time on the connection: the native client runs each
 * call on a worker thread, and two at once on one attachment (a live poll
 * beside a snapshot) crashed the process.
 */
const queues = new WeakMap<Attachment, Promise<unknown>>();

/** Connections `close()` has disconnected: nothing more may run on them. */
const disconnected = new WeakSet<Attachment>();

/** Run `fn` after whatever else this connection is running; refuse once it is closed. */
function serialized<T>(attachment: Attachment, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(attachment) ?? Promise.resolve();
  const run = () => {
    if (disconnected.has(attachment)) throw new HttpError(503, 'The shape server is closing');
    return fn();
  };
  const result = previous.then(run, run);
  queues.set(attachment, result.catch(() => undefined));
  return result;
}

/** Run `fn` in a read-only snapshot transaction, after any other on this connection. */
async function readOnly<T>(attachment: Attachment, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return serialized(attachment, async () => {
    // SNAPSHOT is Firebird's concurrency mode (CONSISTENCY would lock the tables).
    const tx = await attachment.startTransaction({ isolation: TransactionIsolation.SNAPSHOT, accessMode: 'READ_ONLY' });
    try {
      return await fn(tx);
    } finally {
      await tx.commit().catch(() => tx.rollback().catch(() => undefined));
    }
  });
}

async function readBlob(attachment: Attachment, tx: Transaction, blob: FbBlob): Promise<string> {
  const stream = await attachment.openBlob(tx, blob);
  try {
    const chunks: Buffer[] = [];
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const n = await stream.read(buffer);
      if (n < 0) break;
      chunks.push(buffer.subarray(0, n));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await stream.close();
  }
}

/** The columns and key of `name`, from the system tables. */
async function describeTable(attachment: Attachment, name: string): Promise<TablePlan> {
  return readOnly(attachment, async (tx) => {
    const rs = await attachment.executeQuery(
      tx,
      'SELECT TRIM(rf.RDB$FIELD_NAME), f.RDB$FIELD_TYPE, COALESCE(f.RDB$FIELD_SUB_TYPE, 0), ' +
        'COALESCE(f.RDB$FIELD_SCALE, 0), COALESCE(f.RDB$FIELD_PRECISION, 0), ' +
        'COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH, 0), ' +
        'COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG, 0) ' +
        'FROM RDB$RELATION_FIELDS rf JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE ' +
        'WHERE rf.RDB$RELATION_NAME = ? AND f.RDB$COMPUTED_BLR IS NULL ORDER BY rf.RDB$FIELD_POSITION',
      [name],
    );
    const columns: FirebirdColumn[] = (await rs.fetch()).map((r) => ({
      name: String(r[0]),
      type: Number(r[1]),
      subType: Number(r[2]),
      scale: Number(r[3]),
      precision: Number(r[4]),
      charLength: Number(r[5]),
      notNull: Number(r[6]) === 1,
    }));
    await rs.close();
    const keyRs = await attachment.executeQuery(
      tx,
      'SELECT TRIM(s.RDB$FIELD_NAME) FROM RDB$RELATION_CONSTRAINTS c ' +
        'JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = c.RDB$INDEX_NAME ' +
        "WHERE c.RDB$RELATION_NAME = ? AND c.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY s.RDB$FIELD_POSITION",
      [name],
    );
    const key = (await keyRs.fetch()).map((r) => String(r[0]));
    await keyRs.close();
    return planTable(name, columns, key);
  });
}

function selectColumns(table: TablePlan, list: string | null): TablePlan['columns'] {
  if (!list) return table.columns;
  const wanted = list.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const columns = table.columns.filter((c) => wanted.includes(c.shapeName) || wanted.includes(c.name));
  for (const k of table.key) {
    if (!columns.some((c) => c.name === k)) {
      throw new HttpError(400, `columns must include the key column ${shapeOf(table, k)}`);
    }
  }
  return columns;
}

function shapeOf(table: TablePlan, firebirdName: string): string {
  return table.columns.find((c) => c.name === firebirdName)!.shapeName;
}

function keyOf(table: TablePlan, values: unknown[]): string {
  return `"${table.name}"/${values.map((v) => `"${String(v)}"`).join('/')}`;
}

function hashName(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of name) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
