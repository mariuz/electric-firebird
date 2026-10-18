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
 * changes after it, in pages for a snapshot, and with a `where` if asked.
 * Several servers can share a database: they number the log one at a time.
 * Node only: it uses the native client (`node-firebird-driver-
 * native`, an optional dependency of this package).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Attachment, Blob as FbBlob, Client, Transaction } from 'node-firebird-driver';
import { TransactionIsolation } from 'node-firebird-driver';
import { planTable, quote, relationName, renderValue } from './catalog';
import type { FirebirdColumn, TablePlan } from './catalog';
import { CHANGES, CHANGE_EVENT, KEY_COLUMNS, META, installCapture, pruneLog, stampCommitted } from './capture';
import { WhereError, translateWhere } from './where';
import type { FirebirdWhere } from './where';

export { triggerName, tableTrigger } from './capture';
export { translateWhere, WhereError } from './where';
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
  /**
   * How often a waiting live request looks at the log when no event woke it.
   * Default 1000 ms: a commit that logged a change wakes it at once.
   */
  pollIntervalMs?: number;
  /** Wake live requests on Firebird events (`ELECTRIC_CHANGES`), on a connection of its own.  Default true. */
  events?: boolean;
  /** Rows per response while serving a snapshot.  Default 10 000. */
  snapshotPageRows?: number;
  /**
   * How long the log keeps a change after numbering it, in ms; a client
   * further behind starts again from a snapshot.  Default 7 days; `null` or
   * 0 keeps everything (prune with {@link ShapeServer.prune}).
   */
  retainLogMs?: number | null;
}

/** A running shape server. */
export interface ShapeServer {
  /** The Node HTTP handler: `http.createServer(server.handler)`. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** The plans of the served tables, by Firebird name. */
  readonly tables: ReadonlyMap<string, TablePlan>;
  /**
   * Whether live requests are woken by Firebird events.  False when the
   * event connection could not be made (the server's `RemoteAuxPort` must
   * be reachable from here; a container usually needs it pinned and
   * published): live requests then poll every `pollIntervalMs`.
   */
  readonly events: boolean;
  /**
   * Drop what the log numbered before `before` (default: now less
   * `retainLogMs`), and return the highest number dropped, or 0.
   */
  prune(before?: Date): Promise<number>;
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
  const credentials = { username: options.username, password: options.password };
  const attachment: Attachment = await client.connect(options.database, credentials);

  const liveTimeoutMs = options.liveTimeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const pageRows = options.snapshotPageRows ?? 10_000;
  const retainLogMs = options.retainLogMs === undefined ? 7 * 24 * 60 * 60 * 1000 : options.retainLogMs;

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

  // A commit that logged a change posts ELECTRIC_CHANGES; it wakes every
  // waiting live request at once.  Polling stays, as the fallback.
  let wake: () => void = () => undefined;
  let woken = new Promise<void>((resolve) => { wake = resolve; });
  const signal = () => {
    const release = wake;
    woken = new Promise<void>((resolve) => { wake = resolve; });
    release();
  };
  let eventAttachment: Attachment | undefined;
  let events: { cancel(): Promise<void> } | undefined;
  if (options.events ?? true) {
    try {
      // A connection of its own: the main one runs one call at a time.
      eventAttachment = await client.connect(options.database, credentials);
      events = await eventAttachment.queueEvents([CHANGE_EVENT], async () => {
        signal();
      });
    } catch (err) {
      console.warn(
        `[firebird-wasm/electric-server] no Firebird events (${err instanceof Error ? err.message.split('\n').join(' ') : err}); ` +
          `live requests poll every ${pollIntervalMs} ms. Events need the server's RemoteAuxPort reachable from here.`);
      await eventAttachment?.disconnect().catch(() => undefined);
      eventAttachment = undefined;
    }
  }

  /** Number what has committed since, then read in a snapshot: `top` is the log's position in it. */
  const stampedSnapshot = async <T>(fn: (tx: Transaction, top: number, pruned: number) => Promise<T>): Promise<T> => {
    await serialized(attachment, () => stampCommitted(attachment));
    return readOnly(attachment, async (tx) => {
      const rs = await attachment.executeQuery(
        tx, `SELECT (SELECT MAX(COMMIT_SEQ) FROM ${CHANGES}), MAX(PRUNED_THROUGH) FROM ${META}`);
      const row = (await rs.fetch())[0];
      await rs.close();
      const pruned = Number(row?.[1] ?? 0);
      return fn(tx, Math.max(Number(row?.[0] ?? 0), pruned), pruned);
    });
  };

  // Pages of a snapshot being read, by the cursor number in their offset.
  const cursors = new Map<number, { handle: string; top: number; after: unknown[]; used: number }>();
  let nextCursor = 1;

  /** One page of a shape's rows, in key order, after the key `after`. */
  const page = async (shape: Shape, tx: Transaction, after: unknown[] | null) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (shape.where) {
      conditions.push(`(${shape.where.sql})`);
      params.push(...shape.where.params);
    }
    if (after) {
      const keyset = keysetAfter(shape.table.key.map(quote), after);
      conditions.push(keyset.sql);
      params.push(...keyset.params);
    }
    const rs = await attachment.executeQuery(
      tx,
      `SELECT FIRST ${pageRows + 1} ${shape.columns.map((c) => c.select).join(', ')} FROM ${quote(shape.table.name)}` +
        (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') +
        ` ORDER BY ${shape.table.key.map(quote).join(', ')}`,
      params,
    );
    const rows = await rs.fetch();
    await rs.close();
    const more = rows.length > pageRows;
    const kept = more ? rows.slice(0, pageRows) : rows;
    const messages: Message[] = [];
    for (const row of kept) messages.push(await change('insert', shape.table, shape.columns, row, tx));
    const last = kept[kept.length - 1];
    const keyIndexes = shape.table.key.map((k) => shape.columns.findIndex((c) => c.name === k));
    return { messages, more, last: last ? keyIndexes.map((i) => last[i]) : null };
  };

  /** The changes to a shape after `after`, up to the watermark, one per key. */
  const changesAfter = async (shape: Shape, after: number) => {
    return stampedSnapshot(async (tx, top, pruned) => {
      // What this client needs was pruned: it starts again from a snapshot.
      if (after < pruned) return { gone: true, messages: [] as Message[], offset: after, seen: top };
      if (top <= after) return { gone: false, messages: [] as Message[], offset: after, seen: top };
      const table = shape.table;
      const keys = Array.from({ length: KEY_COLUMNS }, (_, i) => `K${i + 1}`).join(', ');
      const rs = await attachment.executeQuery(
        tx,
        `SELECT OP, TX_ID, ${keys} FROM ${CHANGES} WHERE TABLE_NAME = ? AND COMMIT_SEQ > ? AND COMMIT_SEQ <= ? ` +
          'ORDER BY COMMIT_SEQ, CHANGE_ID',
        [table.name, after, top],
      );
      // The last operation per key wins; the row is read as it is now.  Every
      // transaction that changed it is named, as Electric's txids, so a
      // client can tell its own writes have come back.
      const last = new Map<string, { op: string; key: unknown[]; txids: Set<string> }>();
      for (const row of await rs.fetch()) {
        const key = row.slice(2, 2 + table.key.length);
        const id = JSON.stringify(key);
        const txids = last.get(id)?.txids ?? new Set<string>();
        txids.add(String(row[1]));
        last.set(id, { op: String(row[0]), key, txids });
      }
      await rs.close();

      // A row that no longer matches the shape's where has left it: a delete.
      const where = table.key.map((k) => `${quote(k)} = ?`).join(' AND ') + (shape.where ? ` AND (${shape.where.sql})` : '');
      const select = `SELECT ${shape.columns.map((c) => c.select).join(', ')} FROM ${quote(table.name)} WHERE ${where}`;
      const messages: Message[] = [];
      for (const { op, key, txids } of last.values()) {
        let current: unknown[] | null = null;
        if (op !== 'D') {
          const found = await attachment.executeQuery(tx, select, [...key, ...(shape.where?.params ?? [])]);
          current = (await found.fetch({ fetchSize: 1 }))[0] ?? null;
          await found.close();
        }
        const message = current
          ? await change('insert', table, shape.columns, current, tx)
          : deletion(table, key);
        (message['headers'] as Record<string, unknown>)['txids'] = [...txids].map(Number);
        messages.push(message);
      }
      return { gone: false, messages, offset: top, seen: top };
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
      if ((plan.render === 'blob' || plan.render === 'bytes') && raw) {
        const bytes = await readBlob(attachment, tx, raw as FbBlob);
        raw = plan.render === 'blob' ? bytes.toString('utf8') : bytes;
      }
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

  // As Electric's: the last position of the whole log this response has
  // seen, so a client of several shapes can tell when they are all at the
  // same one (syncShapesToTables).
  const upToDate = (seen: number) => ({ headers: { control: 'up-to-date', global_last_seen_lsn: String(seen) } });

  /** The rest of a snapshot, or all of it: a page, and where the next one starts. */
  const servePage = async (res: ServerResponse, shape: Shape, top: number, messages: Message[], more: boolean, last: unknown[] | null) => {
    const schema = JSON.stringify(shape.schema);
    if (!more) {
      respond(res, 200, [...messages, upToDate(top)], {
        'electric-handle': shape.handle,
        'electric-offset': `${top}_0`,
        'electric-schema': schema,
        'electric-up-to-date': '',
      });
      return;
    }
    // Forget cursors nobody came back for.
    const now = Date.now();
    for (const [id, c] of cursors) if (now - c.used > 10 * 60 * 1000) cursors.delete(id);
    const id = nextCursor++;
    cursors.set(id, { handle: shape.handle, top, after: last!, used: now });
    respond(res, 200, messages, {
      'electric-handle': shape.handle,
      'electric-offset': `${top}_${id}`,
      'electric-schema': schema,
    });
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
    const shape = shapeOfRequest(params, tables, epoch);
    const offsetParam = params.get('offset') ?? '-1';

    if (offsetParam === '-1') {
      await stampedSnapshot(async (tx, top) => {
        const first = await page(shape, tx, null);
        await servePage(res, shape, top, first.messages, first.more, first.last);
      });
      return;
    }

    if (params.get('handle') !== shape.handle) {
      respond(res, 409, [{ headers: { control: 'must-refetch' } }], { 'electric-handle': shape.handle });
      return;
    }
    const [position, part] = offsetParam === 'now' ? ['now', '0'] : offsetParam.split('_');
    if (part !== undefined && part !== '0') {
      // The next page of a snapshot.
      const cursor = cursors.get(Number(part));
      if (!cursor || cursor.handle !== shape.handle || String(cursor.top) !== position) {
        respond(res, 409, [{ headers: { control: 'must-refetch' } }], { 'electric-handle': shape.handle });
        return;
      }
      cursors.delete(Number(part));
      await readOnly(attachment, async (tx) => {
        const next = await page(shape, tx, cursor.after);
        await servePage(res, shape, cursor.top, next.messages, next.more, next.last);
      });
      return;
    }

    const after = position === 'now'
      ? await stampedSnapshot(async (_tx, top) => top)
      : Number(position);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, `offset ${offsetParam} is not one this server gave`);

    const live = params.get('live') === 'true';
    const deadline = Date.now() + (live ? liveTimeoutMs : 0);
    let result = await changesAfter(shape, after);
    while (!result.gone && live && result.messages.length === 0 && Date.now() < deadline && !closed && !req.destroyed) {
      const next = woken;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        next,
        new Promise((r) => { timer = setTimeout(r, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))); }),
      ]);
      clearTimeout(timer);
      if (closed) throw new HttpError(503, 'The shape server is closing');
      result = await changesAfter(shape, after);
    }
    if (result.gone) {
      respond(res, 409, [{ headers: { control: 'must-refetch' } }], { 'electric-handle': shape.handle });
      return;
    }
    const headers: Record<string, string> = {
      'electric-handle': shape.handle,
      'electric-offset': `${result.offset}_0`,
      'electric-up-to-date': '',
    };
    if (live) headers['electric-cursor'] = String(Math.floor(Date.now() / 1000));
    else headers['electric-schema'] = JSON.stringify(shape.schema);
    respond(res, 200, [...result.messages, upToDate(result.seen)], headers);
  };

  const prune = async (before?: Date): Promise<number> => {
    if (closed) return 0;
    return serialized(attachment, () => pruneLog(attachment, before ?? new Date(Date.now() - (retainLogMs ?? 0))));
  };
  const pruning = retainLogMs !== null && retainLogMs > 0
    ? setInterval(() => { void prune().catch(() => undefined); }, Math.min(retainLogMs, 60 * 60 * 1000))
    : undefined;
  pruning?.unref?.();

  return {
    tables,
    events: events !== undefined,
    handler: (req, res) => {
      if (closed) {
        respond(res, 503, { message: 'The shape server is closing' });
        return;
      }
      serve(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : err instanceof WhereError ? 400 : 500;
        if (!res.headersSent) respond(res, status, { message: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    },
    prune,
    close: async () => {
      if (closed) return;
      closed = true;
      if (pruning) clearInterval(pruning);
      signal();
      await events?.cancel().catch(() => undefined);
      await eventAttachment?.disconnect().catch(() => undefined);
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

/** One shape: a table, its columns, its where, and the handle that names them. */
interface Shape {
  table: TablePlan;
  columns: TablePlan['columns'];
  schema: Record<string, unknown>;
  where: FirebirdWhere | undefined;
  handle: string;
}

/** The shape a request asks for. */
function shapeOfRequest(params: URLSearchParams, tables: ReadonlyMap<string, TablePlan>, epoch: string): Shape {
  const given = params.get('table');
  if (!given) throw new HttpError(400, 'table is required');
  const table = tables.get(relationName(given));
  if (!table) throw new HttpError(404, `Table ${given} is not served`);
  const columnsParam = params.get('columns');
  const columns = selectColumns(table, columnsParam);
  const schema = Object.fromEntries(columns.map((c) => [c.shapeName, table.schema[c.shapeName]]));

  const whereText = params.get('where');
  // Electric's positional parameters: params[1]=…, params[2]=…
  const values = new Map<number, string>();
  for (const [name, value] of params) {
    const m = /^params\[(\d+)\]$/.exec(name);
    if (m) values.set(Number(m[1]), value);
  }
  let where: FirebirdWhere | undefined;
  if (whereText) {
    const names = new Map(table.columns.map((c) => [c.shapeName, quote(c.name)]));
    where = translateWhere(whereText, names, values);
  }
  // Each shape of a table its own handle: the table alone, as before, when
  // the shape is the whole table.
  const definition = whereText || columnsParam
    ? `${table.name}\u0000${columns.map((c) => c.name).join(',')}\u0000${whereText ?? ''}\u0000${JSON.stringify([...values].sort())}`
    : table.name;
  return { table, columns, schema, where, handle: `${epoch}-${hashName(definition)}` };
}

/** `(k1, k2, …) > (v1, v2, …)`, as Firebird 3 can write it. */
function keysetAfter(keys: string[], values: unknown[]): { sql: string; params: unknown[] } {
  const ors: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < keys.length; i++) {
    const ands = keys.slice(0, i).map((k) => `${k} = ?`);
    ands.push(`${keys[i]} > ?`);
    ors.push(`(${ands.join(' AND ')})`);
    params.push(...values.slice(0, i), values[i]);
  }
  return { sql: `(${ors.join(' OR ')})`, params };
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

async function readBlob(attachment: Attachment, tx: Transaction, blob: FbBlob): Promise<Buffer> {
  const stream = await attachment.openBlob(tx, blob);
  try {
    const chunks: Buffer[] = [];
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const n = await stream.read(buffer);
      if (n < 0) break;
      chunks.push(buffer.subarray(0, n));
    }
    return Buffer.concat(chunks);
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
        'COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG, 0), COALESCE(f.RDB$CHARACTER_SET_ID, 0) ' +
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
      charSet: Number(r[7]),
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
