/**
 * writes.ts – local writes to synced tables, sent to the app's own API.
 *
 * Electric is a read path: a write goes through the app's API to the source
 * and comes back down the shape.  This keeps the wait out of sight:
 *
 * - A write is applied to the synced table at once, and recorded in
 *   `ELECTRIC_WRITES` in the same transaction, so it survives a reload.
 * - A sender hands the recorded writes, in order, to `send` (the app's API).
 *   A failure is retried; a `WriteRejected` rolls the write back.
 * - Each batch the sync applies is followed, in its transaction, by every
 *   write still pending on that table, so the server's older state never
 *   shows over a local write.
 * - A sent write is dropped once the source's change has come back: when a
 *   change carries the transaction id `send` returned (Electric's `txids`,
 *   and the shape server's), or, without one, when the sync brings a change
 *   to the same row, or at the latest after `confirmTimeoutMs`.
 *
 * Values are what `exec` takes, keyed by the shape's column names (`title`
 * for the Firebird column `TITLE`): strings, numbers, booleans, `null`,
 * `Date` and `Uint8Array`.
 */

import type { ElectricTransaction } from './apply';
import { firebirdColumn, firebirdName } from './values';
import { serialDatabase } from './serial';

/** What a write queue needs of a database: `FirebirdBrowser` and `FirebirdLite` have it. */
export interface WritesDatabase {
  transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T>;
}

/** One write, as `send` receives it. */
export interface LocalWrite {
  /** Its number in this database, in the order it was made. */
  id: number;
  /** The table, as given to the queue. */
  table: string;
  operation: 'insert' | 'update' | 'delete';
  /** The primary key's values, by column name. */
  key: Record<string, unknown>;
  /** The values written (for a delete, none), by column name. */
  value: Record<string, unknown>;
}

/** What `send` may return: the source transaction that applied the write. */
export interface SendResult {
  /** The source's transaction id, as Electric reports it in `txids`. */
  txid?: string | number | bigint;
}

/** Thrown by `send` when the source refuses a write: it is rolled back, not retried. */
export class WriteRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRejected';
  }
}

/** Options of {@link createWriteQueue}. */
export interface WriteQueueOptions {
  /** Hand one write to the source (the app's API); throw `WriteRejected` to refuse it. */
  send: (write: LocalWrite) => Promise<SendResult | void>;
  /** Called when a write is rejected and rolled back, and on each failed send. */
  onError?: (error: Error, write: LocalWrite) => void;
  /** How long to wait before sending again after a failure.  Default 2000 ms. */
  retryMs?: number;
  /** Drop a sent write whose change has not come back after this long.  Default 60 000 ms. */
  confirmTimeoutMs?: number;
}

/** A running write queue.  Returned by {@link createWriteQueue}. */
export interface WriteQueue {
  /** Insert (or replace) a row, here at once and at the source in turn. */
  insert(table: string, value: Record<string, unknown>): Promise<LocalWrite>;
  /** Update the row with `key`, setting `value`'s columns. */
  update(table: string, key: Record<string, unknown>, value: Record<string, unknown>): Promise<LocalWrite>;
  /** Delete the row with `key`. */
  delete(table: string, key: Record<string, unknown>): Promise<LocalWrite>;
  /** Writes not yet confirmed by the sync: pending or sent. */
  pending(): Promise<LocalWrite[]>;
  /** Send whatever is pending now, rather than at the next retry. */
  flush(): Promise<void>;
  /** Stop sending.  Pending writes stay recorded, for the next queue. */
  close(): Promise<void>;
  /** @internal The sync's part: called inside each batch's transaction. */
  readonly sync: WriteSync;
}

/** @internal What the sync calls. */
export interface WriteSync {
  /**
   * After a batch was applied to `table` in `tx`: drop the writes it
   * confirms, and apply again the ones still pending.
   */
  reconcile(tx: ElectricTransaction, table: string, touched: Set<string> | 'all', txids: Set<string>): Promise<void>;
  /** A sync of `table` that can be asked to fetch its shape again (after a rejection). */
  register(table: string, refetch: () => void): () => void;
}

const WRITES = '"ELECTRIC_WRITES"';
/** Characters of JSON a write's values may take: the widest UTF-8 VARCHAR a row holds. */
const MAX_VALUE = 8191;

interface StoredWrite extends LocalWrite {
  state: 'P' | 'S';
  txid: string | null;
  sentAt: number | null;
}

/** Values to JSON and back, `Date` and `Uint8Array` included. */
function encode(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Uint8Array) return { $bytes: Array.from(v) };
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    return v;
  });
}
function decode(text: string): Record<string, unknown> {
  return JSON.parse(text, (_, v) => {
    if (v && typeof v === 'object' && Array.isArray(v.$bytes)) return new Uint8Array(v.$bytes);
    if (v && typeof v === 'object' && typeof v.$bigint === 'string') return BigInt(v.$bigint);
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return new Date(v);
    return v;
  }) as Record<string, unknown>;
}

/**
 * The key of a row as one string, for matching a write with what the sync
 * brings: Electric sends every value as text (`"1"` for the `1` written).
 */
function keyText(key: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(key).sort().map((k) => {
    const v = key[k];
    return [k, v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v)];
  }));
}

/**
 * Start a queue of local writes.  Pass it to `syncShapeToTable` /
 * `syncShapesToTables` as `writes`, so that the sync keeps the writes over
 * what it applies and drops them once confirmed.
 */
export async function createWriteQueue(given: WritesDatabase, options: WriteQueueOptions): Promise<WriteQueue> {
  // One transaction at a time with the syncs: see serial.ts.
  const db = serialDatabase(given);
  const retryMs = options.retryMs ?? 2_000;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;
  const report = options.onError ?? ((e: Error) => console.error('[firebird-wasm/electric] write', e));
  await ensureWritesTable(db);

  const keys = new Map<string, string[]>();
  /** The primary key of a local table, Firebird column names, from its constraint. */
  const keyOf = async (tx: ElectricTransaction, table: string): Promise<string[]> => {
    const name = firebirdName(table);
    const known = keys.get(name);
    if (known) return known;
    const { rows } = await tx.query(
      'SELECT TRIM(s.RDB$FIELD_NAME) AS F FROM RDB$RELATION_CONSTRAINTS c ' +
        'JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = c.RDB$INDEX_NAME ' +
        "WHERE c.RDB$RELATION_NAME = ? AND c.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY s.RDB$FIELD_POSITION",
      [name.slice(1, -1).replace(/""/g, '"')],
    );
    const found = rows.map((r) => String(r['F']));
    if (found.length === 0) throw new Error(`Table ${table} has no primary key; local writes need one`);
    keys.set(name, found);
    return found;
  };

  /** Apply one write to its table in `tx`. */
  const applyWrite = async (tx: ElectricTransaction, w: LocalWrite) => {
    const table = firebirdName(w.table);
    const keyColumns = Object.keys(w.key);
    const where = keyColumns.map((k) => `${firebirdColumn(k)} = ?`).join(' AND ');
    const keyValues = keyColumns.map((k) => w.key[k]);
    if (w.operation === 'delete') {
      await tx.exec(`DELETE FROM ${table} WHERE ${where}`, keyValues);
      return;
    }
    const columns = Object.keys(w.value);
    if (w.operation === 'insert') {
      const all = [...new Set([...keyColumns, ...columns])];
      const values = all.map((c) => (c in w.value ? w.value[c] : w.key[c]));
      await tx.exec(
        `UPDATE OR INSERT INTO ${table} (${all.map(firebirdColumn).join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
          `MATCHING (${keyColumns.map(firebirdColumn).join(', ')})`,
        values,
      );
      return;
    }
    if (columns.length === 0) return;
    await tx.exec(
      `UPDATE ${table} SET ${columns.map((c) => `${firebirdColumn(c)} = ?`).join(', ')} WHERE ${where}`,
      [...columns.map((c) => w.value[c]), ...keyValues],
    );
  };

  const load = async (tx: ElectricTransaction, table?: string): Promise<StoredWrite[]> => {
    const { rows } = await tx.query(
      `SELECT ID, TABLE_NAME, OP, KEY_JSON, VALUE_JSON, STATE, TXID, SENT_AT FROM ${WRITES}` +
        (table ? ' WHERE TABLE_NAME = ?' : '') + ' ORDER BY ID',
      table ? [table] : [],
    );
    return rows.map((r) => ({
      id: Number(r['ID']),
      table: String(r['TABLE_NAME']),
      operation: ({ I: 'insert', U: 'update', D: 'delete' } as const)[String(r['OP']).trim() as 'I' | 'U' | 'D'],
      key: decode(String(r['KEY_JSON'])),
      value: decode(String(r['VALUE_JSON'] ?? '{}')),
      state: String(r['STATE']).trim() as 'P' | 'S',
      txid: r['TXID'] === null || r['TXID'] === undefined ? null : String(r['TXID']).trim(),
      sentAt: r['SENT_AT'] === null || r['SENT_AT'] === undefined ? null : Number(r['SENT_AT']),
    }));
  };

  const write = async (
    operation: LocalWrite['operation'],
    table: string,
    keyGiven: Record<string, unknown> | null,
    value: Record<string, unknown>,
  ): Promise<LocalWrite> => {
    const made = await db.transaction(async (tx) => {
      const keyColumns = await keyOf(tx, table);
      // The key by the shape's names: TITLE is title, "camelCase" stays.
      const shapeName = (c: string) => (/^[A-Z][A-Z0-9_$]*$/.test(c) ? c.toLowerCase() : c);
      const source = keyGiven ?? value;
      const key: Record<string, unknown> = {};
      for (const c of keyColumns) {
        const name = shapeName(c);
        if (!(name in source)) throw new RangeError(`A write to ${table} needs its key column ${name}`);
        key[name] = source[name];
      }
      const json = encode(value);
      if (json.length > MAX_VALUE) {
        throw new RangeError(`A write's values may take ${MAX_VALUE} characters as JSON; this one takes ${json.length}`);
      }
      const { rows } = await tx.query(`SELECT COALESCE(MAX(ID), 0) + 1 AS N FROM ${WRITES}`);
      const w: LocalWrite = { id: Number(rows[0]!['N']), table, operation, key, value };
      await applyWrite(tx, w);
      await tx.exec(
        `INSERT INTO ${WRITES} (ID, TABLE_NAME, OP, KEY_JSON, VALUE_JSON, STATE) VALUES (?, ?, ?, ?, ?, 'P')`,
        [w.id, table, operation[0]!.toUpperCase(), encode(key), json],
      );
      return w;
    });
    kick();
    return made;
  };

  const refetchers = new Map<string, Set<() => void>>();
  let closed = false;
  let sending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Roll a rejected write back: forget it, and have its table fetched again. */
  const reject = async (w: StoredWrite, error: Error) => {
    await db.transaction((tx) => tx.exec(`DELETE FROM ${WRITES} WHERE ID = ?`, [w.id]).then(() => undefined));
    for (const refetch of refetchers.get(firebirdName(w.table)) ?? []) refetch();
    report(error, w);
  };

  /** Send every pending write, in order; stop at the first that fails. */
  const sendAll = async () => {
    for (;;) {
      if (closed) return;
      const next = (await db.transaction((tx) => load(tx))).find((w) => w.state === 'P');
      if (!next) return;
      let result: SendResult | void;
      try {
        result = await options.send({ id: next.id, table: next.table, operation: next.operation, key: next.key, value: next.value });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error instanceof WriteRejected || (error as { rejected?: boolean }).rejected) {
          await reject(next, error);
          continue;
        }
        report(error, next);
        if (!closed) {
          clearTimeout(timer);
          timer = setTimeout(kick, retryMs);
        }
        return;
      }
      const txid = result && result.txid !== undefined && result.txid !== null ? String(result.txid) : null;
      await db.transaction((tx) =>
        tx.exec(`UPDATE ${WRITES} SET STATE = 'S', TXID = ?, SENT_AT = ? WHERE ID = ?`, [txid, Date.now(), next.id])
          .then(() => undefined));
    }
  };

  function kick() {
    if (closed || sending) return;
    sending = sendAll()
      .catch((err) => report(err instanceof Error ? err : new Error(String(err)), undefined as never))
      .finally(() => { sending = null; });
  }

  const sync: WriteSync = {
    async reconcile(tx, table, touched, txids) {
      const name = firebirdName(table);
      const writes = (await load(tx)).filter((w) => firebirdName(w.table) === name);
      if (writes.length === 0) return;
      const now = Date.now();
      for (const w of writes) {
        // Sent, and its change is back: the source's row now holds it.
        const confirmed = w.state === 'S' && (
          (w.txid !== null && txids.has(w.txid)) ||
          (w.txid === null && (touched === 'all' || touched.has(keyText(w.key)))) ||
          (w.sentAt !== null && now - w.sentAt > confirmTimeoutMs));
        if (confirmed) {
          await tx.exec(`DELETE FROM ${WRITES} WHERE ID = ?`, [w.id]);
          continue;
        }
        await applyWrite(tx, w);
      }
    },
    register(table, refetch) {
      const name = firebirdName(table);
      const set = refetchers.get(name) ?? new Set();
      set.add(refetch);
      refetchers.set(name, set);
      return () => set.delete(refetch);
    },
  };

  // Writes left from before (a reload, offline) go out now.
  kick();

  return {
    insert: (table, value) => write('insert', table, null, value),
    update: (table, key, value) => write('update', table, key, value),
    delete: (table, key) => write('delete', table, key, {}),
    pending: () => db.transaction((tx) => load(tx)).then((ws) =>
      ws.map(({ id, table, operation, key, value }) => ({ id, table, operation, key, value }))),
    flush: async () => {
      clearTimeout(timer);
      kick();
      await sending;
    },
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await sending;
    },
    sync,
  };
}

async function ensureWritesTable(db: WritesDatabase): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        const { rows } = await tx.query("SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_WRITES'");
        if (rows.length > 0) return;
        await tx.exec(
          `CREATE TABLE ${WRITES} (ID INTEGER NOT NULL PRIMARY KEY, TABLE_NAME VARCHAR(255) NOT NULL, ` +
            // Not a BLOB: FirebirdLite reads a BLOB back as a handle, not text.
            'OP CHAR(1) NOT NULL, KEY_JSON VARCHAR(4000) CHARACTER SET UTF8 NOT NULL, ' +
            `VALUE_JSON VARCHAR(${MAX_VALUE}) CHARACTER SET UTF8, ` +
            "STATE CHAR(1) DEFAULT 'P' NOT NULL, TXID VARCHAR(40), SENT_AT DOUBLE PRECISION)",
        );
      });
      return;
    } catch (error) {
      const made = await db.transaction(async (tx) =>
        (await tx.query("SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_WRITES'")).rows.length > 0);
      if (made) return;
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

export { keyText as writeKeyText };
