/**
 * writes.ts – local writes to synced tables, sent to the app's own API.
 *
 * Electric is a read path: a write goes through the app's API to the source
 * and comes back down the shape.  This keeps the wait out of sight:
 *
 * - A write is applied to the synced table at once, and recorded in
 *   `ELECTRIC_WRITES` (or `FB_WRITE_QUEUE$`) together with the row's
 *   pre-mutation snapshot (`BEFORE_JSON`) in the same transaction, so it
 *   survives page reloads while offline.
 * - A sender hands the recorded writes, in order, to `send` (the app's API).
 *   A failure is retried (and flushed immediately when the browser fires an
 *   `online` event); a `WriteRejected` restores the local row from
 *   `BEFORE_JSON` and rolls the write back.
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

/** Standard durable write-queue table name (`FB_WRITE_QUEUE$`). */
export const DEFAULT_WRITE_QUEUE_TABLE = 'FB_WRITE_QUEUE$';

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
  /**
   * Pre-mutation snapshot of the local row before this write was applied
   * (`null` when inserting a new row or when unavailable).
   */
  before?: Record<string, unknown> | null;
  /**
   * Set to `true` when `send` is re-invoked after `onConflict` resolved a
   * conflict with `'client-wins'` or `'merge'`.
   */
  conflictResolved?: boolean;
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

/**
 * Thrown by `send` when the remote server reports a concurrency / version
 * conflict (e.g. HTTP 409) and optionally provides the current server row.
 * Handled according to {@link WriteQueueOptions.onConflict}.
 */
export class WriteConflict extends Error {
  readonly conflict = true;
  readonly server: Record<string, unknown> | null;

  constructor(
    message: string,
    serverOrOptions?:
      | { server?: Record<string, unknown> | null }
      | Record<string, unknown>
      | null,
  ) {
    super(message);
    this.name = 'WriteConflict';
    if (serverOrOptions === undefined || serverOrOptions === null) {
      this.server = null;
    } else if (
      typeof serverOrOptions === 'object' &&
      'server' in serverOrOptions &&
      Object.keys(serverOrOptions).every((k) => k === 'server')
    ) {
      this.server =
        (serverOrOptions as { server?: Record<string, unknown> | null }).server ??
        null;
    } else {
      this.server = serverOrOptions as Record<string, unknown>;
    }
  }
}

/** Context passed to a custom {@link WriteQueueOptions.onConflict} callback. */
export interface WriteConflictContext {
  /** The queued local mutation that conflicted. */
  write: LocalWrite;
  /**
   * The local row's snapshot before `write` was applied (`BEFORE_JSON`),
   * or `null` if the row did not exist locally before `write`.
   */
  before: Record<string, unknown> | null;
  /**
   * The current server row state (from `WriteConflict.server`, `getServerRow`,
   * or an incoming Electric sync batch), or `null` if the row does not exist
   * on the server.
   */
  server: Record<string, unknown> | null;
  /**
   * Where the conflict was detected:
   * - `'send'`: while flushing `write` to the remote backend
   * - `'sync'`: while reconciling an incoming Electric shape batch touching the same row
   */
  source: 'send' | 'sync';
  /** The `WriteConflict` error thrown by `send`, when applicable. */
  error?: Error;
  /** 1-based conflict resolution attempt count for this write. */
  attempt: number;
}

/** Normalized conflict resolution outcome. */
export type ResolvedConflictOutcome =
  | { action: 'client-wins' }
  | { action: 'server-wins' }
  | {
      action: 'merge';
      value: Record<string, unknown>;
      operation: LocalWrite['operation'];
    };

/**
 * Outcome returned by a custom `onConflict` resolver callback:
 * - `'client-wins'` or `{ action: 'client-wins' }`: keep the client's write over `server`.
 * - `'server-wins'` or `{ action: 'server-wins' }`: discard the client's write and adopt `server`.
 * - `'merge'`: perform a 3-way field-level merge using `before`, `server`, and `write.value`.
 * - `{ action: 'merge', value, operation? }` or a plain `Record<string, unknown>`: replace the
 *   queued write's `value` (and optionally `operation`) with the merged values.
 */
export type ConflictResolution =
  | 'client-wins'
  | 'server-wins'
  | 'merge'
  | { action: 'client-wins' }
  | { action: 'server-wins' }
  | {
      action: 'merge';
      value: Record<string, unknown>;
      operation?: LocalWrite['operation'];
    }
  | Record<string, unknown>;

/**
 * Pluggable conflict strategy or custom resolver callback for {@link createWriteQueue}.
 */
export type ConflictStrategy =
  | 'client-wins'
  | 'server-wins'
  | 'merge'
  | ((
      context: WriteConflictContext,
    ) => ConflictResolution | Promise<ConflictResolution>);

/** Options of {@link createWriteQueue}. */
export interface WriteQueueOptions {
  /** Hand one write to the source (the app's API); throw `WriteRejected` to refuse it or `WriteConflict` on conflict. */
  send: (write: LocalWrite) => Promise<SendResult | void>;
  /**
   * Pluggable conflict handler invoked when flushing offline mutations after
   * reconnect (`send` throws `WriteConflict` or `getServerRow` detects a
   * concurrent server change) or when an incoming Electric sync batch modifies
   * a row that has an unconfirmed pending local write.
   *
   * - `'client-wins'` (default): keep the client's mutation over the server state.
   * - `'server-wins'`: discard the client's mutation and adopt the server's row state.
   * - `'merge'`: 3-way field-level merge comparing `before`, `server`, and `write.value`.
   * - Custom callback `(ctx) => ...`: inspect `{ write, before, server, source }` and
   *   return `'client-wins'`, `'server-wins'`, `'merge'`, or a merged `value` object.
   *
   * @default 'client-wins'
   */
  onConflict?: ConflictStrategy;
  /**
   * Optional helper to fetch the current server row for a queued write during
   * `flush()` (for pre-send conflict detection against `write.before` or when
   * `WriteConflict` does not embed the server row).
   */
  getServerRow?: (write: LocalWrite) => Promise<Record<string, unknown> | null>;
  /**
   * Called whenever a conflict is resolved via `onConflict`.
   */
  onConflictResolved?: (
    context: WriteConflictContext,
    outcome: ResolvedConflictOutcome,
  ) => void;
  /** Called when a write is rejected and rolled back, and on each failed send. */
  onError?: (error: Error, write: LocalWrite) => void;
  /** Called whenever one or more queued writes finish sending in a flush pass. */
  onFlush?: (sent: LocalWrite[]) => void;
  /** How long to wait before sending again after a failure.  Default 2000 ms. */
  retryMs?: number;
  /** Drop a sent write whose change has not come back after this long.  Default 60 000 ms. */
  confirmTimeoutMs?: number;
  /**
   * Local Firebird table used to persist the write queue across page reloads.
   * Accepts `'FB_WRITE_QUEUE$'`, `'ELECTRIC_WRITES'`, or any valid Firebird
   * table identifier.
   *
   * @default 'ELECTRIC_WRITES'
   */
  tableName?: string;
  /**
   * Automatically flush pending writes when the browser fires an `online`
   * connectivity event.
   *
   * @default true
   */
  autoFlushOnOnline?: boolean;
  /**
   * Start the queue in a paused (offline) state where local mutations are
   * applied and persisted to disk without calling `send` until `resume()` or
   * `flush()` is called.
   *
   * @default false
   */
  paused?: boolean;
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
  /** Revert a specific pending write by `id`, restoring the local table row. */
  discard(id: number): Promise<boolean>;
  /** Revert and remove all unconfirmed writes in the queue, restoring local rows. */
  clear(): Promise<number>;
  /** Pause background sending (local writes still persist durably). */
  pause(): void;
  /** Resume background sending and trigger an immediate flush. */
  resume(): void;
  /** Whether background sending is currently paused. */
  readonly paused: boolean;
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

/** Characters of JSON a write's values may take: the widest UTF-8 VARCHAR a row holds. */
const MAX_VALUE = 8191;
/** Kept under 4000 UTF-8 chars (16 KB) so the row stays below Firebird 5's 65,535-byte max record size. */
const MAX_BEFORE_VALUE = 4000;

interface StoredWrite extends LocalWrite {
  before: Record<string, unknown> | null;
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

function shapeColumnName(firebirdCol: string): string {
  return /^[A-Z][A-Z0-9_$]*$/.test(firebirdCol)
    ? firebirdCol.toLowerCase()
    : firebirdCol;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return true;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return false;
}

function rowsEqual(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of allKeys) {
    if (!valuesEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Perform a 3-way field-level merge between a row's pre-mutation snapshot
 * (`before`), the current `server` row, and a queued local `write`.
 */
export function mergeWriteConflict(
  before: Record<string, unknown> | null,
  server: Record<string, unknown> | null,
  write: Pick<LocalWrite, 'operation' | 'key' | 'value'>,
): ResolvedConflictOutcome {
  if (server === null) {
    if (write.operation === 'delete') {
      return { action: 'server-wins' };
    }
    if (write.operation === 'insert') {
      return {
        action: 'merge',
        operation: 'insert',
        value: { ...write.key, ...write.value },
      };
    }
    return {
      action: 'merge',
      operation: 'insert',
      value: { ...(before ?? {}), ...write.key, ...write.value },
    };
  }

  if (write.operation === 'delete') {
    return { action: 'client-wins' };
  }

  const keyCols = new Set(Object.keys(write.key));
  const merged: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(server)) {
    if (!keyCols.has(col) || write.operation === 'insert') {
      merged[col] = val;
    }
  }
  for (const [col, clientVal] of Object.entries(write.value)) {
    const clientChanged =
      before === null ||
      !(col in before) ||
      !valuesEqual(before[col], clientVal);
    const serverChanged =
      before !== null &&
      col in before &&
      col in server &&
      !valuesEqual(before[col], server[col]);
    if (clientChanged || !serverChanged) {
      merged[col] = clientVal;
    }
  }
  return {
    action: 'merge',
    operation: write.operation,
    value: merged,
  };
}

async function evaluateConflictStrategy(
  strategy: ConflictStrategy | undefined,
  ctx: WriteConflictContext,
): Promise<ResolvedConflictOutcome> {
  const effective = strategy ?? 'client-wins';
  const raw: ConflictResolution =
    typeof effective === 'function' ? await effective(ctx) : effective;

  if (raw === 'client-wins') {
    return { action: 'client-wins' };
  }
  if (raw === 'server-wins') {
    return { action: 'server-wins' };
  }
  if (raw === 'merge') {
    return mergeWriteConflict(ctx.before, ctx.server, ctx.write);
  }
  if (typeof raw === 'object' && raw !== null) {
    if (raw.action === 'client-wins') {
      return { action: 'client-wins' };
    }
    if (raw.action === 'server-wins') {
      return { action: 'server-wins' };
    }
    if (
      raw.action === 'merge' &&
      typeof raw.value === 'object' &&
      raw.value !== null
    ) {
      return {
        action: 'merge',
        value: raw.value as Record<string, unknown>,
        operation:
          raw.operation === 'insert' ||
          raw.operation === 'update' ||
          raw.operation === 'delete'
            ? raw.operation
            : ctx.write.operation,
      };
    }
    return {
      action: 'merge',
      value: raw as Record<string, unknown>,
      operation: ctx.write.operation,
    };
  }
  return { action: 'client-wins' };
}

function isWriteConflictError(error: Error): boolean {
  return (
    error instanceof WriteConflict ||
    (error as { conflict?: boolean }).conflict === true
  );
}

function extractConflictServerRow(
  error: Error,
): Record<string, unknown> | null | undefined {
  if (error instanceof WriteConflict) {
    return error.server;
  }
  if ('server' in error) {
    const s = (error as { server?: Record<string, unknown> | null }).server;
    return s ?? null;
  }
  return undefined;
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
  const writesQuoted = firebirdName(options.tableName ?? 'ELECTRIC_WRITES');
  const writesRawName = writesQuoted.slice(1, -1).replace(/""/g, '"');
  const hasBeforeColumn = await ensureWritesTable(db, writesQuoted, writesRawName);

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

  /** Read the current row in `table` matching `key` before an optimistic mutation. */
  const snapshotRow = async (
    tx: ElectricTransaction,
    table: string,
    key: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    try {
      const tableIdent = firebirdName(table);
      const keyColumns = Object.keys(key);
      const where = keyColumns.map((k) => `${firebirdColumn(k)} = ?`).join(' AND ');
      const keyValues = keyColumns.map((k) => key[k]);
      const { rows } = await tx.query(
        `SELECT * FROM ${tableIdent} WHERE ${where}`,
        keyValues,
      );
      if (rows.length === 0) return null;
      const rawRow = rows[0]!;
      const normalized: Record<string, unknown> = {};
      for (const [col, val] of Object.entries(rawRow)) {
        normalized[shapeColumnName(col)] = val;
      }
      return normalized;
    } catch {
      return null;
    }
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

  /** Restore a row to its `before` snapshot (or delete it if `before === null`). */
  const restoreSnapshot = async (
    tx: ElectricTransaction,
    table: string,
    key: Record<string, unknown>,
    before: Record<string, unknown> | null,
  ) => {
    const tableIdent = firebirdName(table);
    const keyColumns = Object.keys(key);
    const where = keyColumns.map((k) => `${firebirdColumn(k)} = ?`).join(' AND ');
    const keyValues = keyColumns.map((k) => key[k]);
    if (before === null) {
      await tx.exec(`DELETE FROM ${tableIdent} WHERE ${where}`, keyValues);
      return;
    }
    const all = [...new Set([...keyColumns, ...Object.keys(before)])];
    const values = all.map((c) => (c in before ? before[c] : key[c]));
    await tx.exec(
      `UPDATE OR INSERT INTO ${tableIdent} (${all.map(firebirdColumn).join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
        `MATCHING (${keyColumns.map(firebirdColumn).join(', ')})`,
      values,
    );
  };

  const selectCols = hasBeforeColumn
    ? 'ID, TABLE_NAME, OP, KEY_JSON, VALUE_JSON, BEFORE_JSON, STATE, TXID, SENT_AT'
    : 'ID, TABLE_NAME, OP, KEY_JSON, VALUE_JSON, STATE, TXID, SENT_AT';

  const load = async (tx: ElectricTransaction, table?: string): Promise<StoredWrite[]> => {
    const { rows } = await tx.query(
      `SELECT ${selectCols} FROM ${writesQuoted}` +
        (table ? ' WHERE TABLE_NAME = ?' : '') + ' ORDER BY ID',
      table ? [table] : [],
    );
    return rows.map((r) => ({
      id: Number(r['ID']),
      table: String(r['TABLE_NAME']),
      operation: ({ I: 'insert', U: 'update', D: 'delete' } as const)[String(r['OP']).trim() as 'I' | 'U' | 'D'],
      key: decode(String(r['KEY_JSON'])),
      value: decode(String(r['VALUE_JSON'] ?? '{}')),
      before:
        r['BEFORE_JSON'] === null || r['BEFORE_JSON'] === undefined
          ? null
          : decode(String(r['BEFORE_JSON'])),
      state: String(r['STATE']).trim() as 'P' | 'S',
      txid: r['TXID'] === null || r['TXID'] === undefined ? null : String(r['TXID']).trim(),
      sentAt: r['SENT_AT'] === null || r['SENT_AT'] === undefined ? null : Number(r['SENT_AT']),
    }));
  };

  /**
   * Remove a write from the queue inside `tx`, restore its pre-image in the
   * local table, and re-apply any later writes still queued for the same row.
   */
  const revertWriteInTx = async (tx: ElectricTransaction, target: StoredWrite, allWrites?: StoredWrite[]) => {
    const queue = allWrites ?? (await load(tx));
    const targetTableIdent = firebirdName(target.table);
    const targetKeyStr = keyText(target.key);
    const sameRowWrites = queue.filter(
      (w) => firebirdName(w.table) === targetTableIdent && keyText(w.key) === targetKeyStr,
    );

    await tx.exec(`DELETE FROM ${writesQuoted} WHERE ID = ?`, [target.id]);

    if (hasBeforeColumn) {
      const idx = sameRowWrites.findIndex((w) => w.id === target.id);
      if (idx !== -1) {
        await restoreSnapshot(tx, target.table, target.key, target.before);
        const remainingAfter = sameRowWrites.slice(idx + 1);
        for (const later of remainingAfter) {
          const updatedBefore = await snapshotRow(tx, later.table, later.key);
          await applyWrite(tx, later);
          const beforeStr = updatedBefore ? encode(updatedBefore) : null;
          if (beforeStr === null || beforeStr.length <= MAX_BEFORE_VALUE) {
            await tx.exec(
              `UPDATE ${writesQuoted} SET BEFORE_JSON = ? WHERE ID = ?`,
              [beforeStr, later.id],
            );
          }
        }
      }
    }
  };

  const write = async (
    operation: LocalWrite['operation'],
    table: string,
    keyGiven: Record<string, unknown> | null,
    value: Record<string, unknown>,
  ): Promise<LocalWrite> => {
    const made = await db.transaction(async (tx) => {
      const keyColumns = await keyOf(tx, table);
      const source = keyGiven ?? value;
      const key: Record<string, unknown> = {};
      for (const c of keyColumns) {
        const name = shapeColumnName(c);
        if (!(name in source)) throw new RangeError(`A write to ${table} needs its key column ${name}`);
        key[name] = source[name];
      }
      const json = encode(value);
      if (json.length > MAX_VALUE) {
        throw new RangeError(`A write's values may take ${MAX_VALUE} characters as JSON; this one takes ${json.length}`);
      }
      const beforeRow = hasBeforeColumn ? await snapshotRow(tx, table, key) : null;
      const beforeJson = beforeRow ? encode(beforeRow) : null;
      const safeBeforeJson =
        beforeJson !== null && beforeJson.length <= MAX_BEFORE_VALUE ? beforeJson : null;

      const { rows } = await tx.query(`SELECT COALESCE(MAX(ID), 0) + 1 AS N FROM ${writesQuoted}`);
      const w: LocalWrite = { id: Number(rows[0]!['N']), table, operation, key, value };
      await applyWrite(tx, w);
      if (hasBeforeColumn) {
        await tx.exec(
          `INSERT INTO ${writesQuoted} (ID, TABLE_NAME, OP, KEY_JSON, VALUE_JSON, BEFORE_JSON, STATE) VALUES (?, ?, ?, ?, ?, ?, 'P')`,
          [w.id, table, operation[0]!.toUpperCase(), encode(key), json, safeBeforeJson],
        );
      } else {
        await tx.exec(
          `INSERT INTO ${writesQuoted} (ID, TABLE_NAME, OP, KEY_JSON, VALUE_JSON, STATE) VALUES (?, ?, ?, ?, ?, 'P')`,
          [w.id, table, operation[0]!.toUpperCase(), encode(key), json],
        );
      }
      return w;
    });
    kick();
    return made;
  };

  const refetchers = new Map<string, Set<() => void>>();
  let closed = false;
  let isPaused = options.paused === true;
  let sending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Roll a rejected write back: restore its local pre-image, forget it, and have its table fetched again. */
  const reject = async (w: StoredWrite, error: Error) => {
    await db.transaction(async (tx) => {
      await revertWriteInTx(tx, w);
    });
    for (const refetch of refetchers.get(firebirdName(w.table)) ?? []) refetch();
    report(error, w);
  };

  /** Apply a resolved conflict outcome to the local table and queue row in `tx`. */
  const applyResolvedOutcomeInTx = async (
    tx: ElectricTransaction,
    target: StoredWrite,
    serverRow: Record<string, unknown> | null | undefined,
    outcome: ResolvedConflictOutcome,
  ): Promise<LocalWrite | null> => {
    const effectiveBase = serverRow !== undefined ? serverRow : target.before;
    if (outcome.action === 'server-wins') {
      await revertWriteInTx(tx, { ...target, before: effectiveBase });
      return null;
    }

    const nextOp =
      outcome.action === 'merge' ? outcome.operation : target.operation;
    const nextValue =
      outcome.action === 'merge' ? outcome.value : target.value;
    const updatedWrite: LocalWrite = {
      id: target.id,
      table: target.table,
      operation: nextOp,
      key: target.key,
      value: nextValue,
      ...(hasBeforeColumn ? { before: effectiveBase } : {}),
      conflictResolved: true,
    };

    if (hasBeforeColumn && serverRow !== undefined) {
      await restoreSnapshot(tx, target.table, target.key, serverRow);
    }
    await applyWrite(tx, updatedWrite);

    const encodedVal = encode(nextValue);
    const encodedBefore =
      hasBeforeColumn && effectiveBase !== null ? encode(effectiveBase) : null;
    const safeBefore =
      encodedBefore !== null && encodedBefore.length <= MAX_BEFORE_VALUE
        ? encodedBefore
        : null;

    if (hasBeforeColumn) {
      await tx.exec(
        `UPDATE ${writesQuoted} SET OP = ?, VALUE_JSON = ?, BEFORE_JSON = ? WHERE ID = ?`,
        [nextOp[0]!.toUpperCase(), encodedVal, safeBefore, target.id],
      );
    } else {
      await tx.exec(
        `UPDATE ${writesQuoted} SET OP = ?, VALUE_JSON = ? WHERE ID = ?`,
        [nextOp[0]!.toUpperCase(), encodedVal, target.id],
      );
    }

    return updatedWrite;
  };

  /** Send every pending write, in order; stop at the first that fails. */
  const sendAll = async (ignorePaused = false) => {
    const flushedInPass: LocalWrite[] = [];
    for (;;) {
      if (closed || (isPaused && !ignorePaused)) break;
      const next = (await db.transaction((tx) => load(tx))).find((w) => w.state === 'P');
      if (!next) break;
      let result: SendResult | void;
      let payload: LocalWrite = {
        id: next.id,
        table: next.table,
        operation: next.operation,
        key: next.key,
        value: next.value,
        ...(hasBeforeColumn ? { before: next.before } : {}),
      };

      // Pre-send conflict check if `getServerRow` is configured
      if (options.getServerRow && hasBeforeColumn) {
        try {
          const liveServerRow = await options.getServerRow(payload);
          const hasPreSendConflict =
            next.operation === 'insert'
              ? liveServerRow !== null &&
                !rowsEqual({ ...next.key, ...next.value }, liveServerRow)
              : !rowsEqual(next.before, liveServerRow);

          if (hasPreSendConflict) {
            const ctx: WriteConflictContext = {
              write: payload,
              before: next.before,
              server: liveServerRow,
              source: 'send',
              attempt: 1,
            };
            const outcome = await evaluateConflictStrategy(options.onConflict, ctx);
            options.onConflictResolved?.(ctx, outcome);
            const updatedPayload = await db.transaction((tx) =>
              applyResolvedOutcomeInTx(tx, next, liveServerRow, outcome),
            );
            if (updatedPayload === null) {
              for (const refetch of refetchers.get(firebirdName(next.table)) ?? []) refetch();
              continue;
            }
            payload = updatedPayload;
          }
        } catch (preErr) {
          const error = preErr instanceof Error ? preErr : new Error(String(preErr));
          report(error, next);
          if (!closed && !isPaused) {
            clearTimeout(timer);
            timer = setTimeout(kick, retryMs);
          }
          break;
        }
      }

      try {
        result = await options.send(payload);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (isWriteConflictError(error)) {
          let serverRow = extractConflictServerRow(error);
          if ((serverRow === undefined || serverRow === null) && options.getServerRow) {
            try {
              serverRow = await options.getServerRow(payload);
            } catch {
              // Keep extracted serverRow if getServerRow fails
            }
          }
          const resolvedServer = serverRow === undefined ? null : serverRow;
          const ctx: WriteConflictContext = {
            write: payload,
            before: next.before,
            server: resolvedServer,
            source: 'send',
            error,
            attempt: 1,
          };
          const outcome = await evaluateConflictStrategy(options.onConflict, ctx);
          options.onConflictResolved?.(ctx, outcome);
          const updatedPayload = await db.transaction((tx) =>
            applyResolvedOutcomeInTx(tx, next, serverRow, outcome),
          );
          if (updatedPayload === null) {
            for (const refetch of refetchers.get(firebirdName(next.table)) ?? []) refetch();
            continue;
          }
          payload = updatedPayload;
          try {
            result = await options.send(payload);
          } catch (retryErr) {
            const retryError =
              retryErr instanceof Error ? retryErr : new Error(String(retryErr));
            if (
              retryError instanceof WriteRejected ||
              (retryError as { rejected?: boolean }).rejected ||
              isWriteConflictError(retryError)
            ) {
              await reject(next, retryError);
              continue;
            }
            report(retryError, next);
            if (!closed && !isPaused) {
              clearTimeout(timer);
              timer = setTimeout(kick, retryMs);
            }
            break;
          }
        } else if (error instanceof WriteRejected || (error as { rejected?: boolean }).rejected) {
          await reject(next, error);
          continue;
        } else {
          report(error, next);
          if (!closed && !isPaused) {
            clearTimeout(timer);
            timer = setTimeout(kick, retryMs);
          }
          break;
        }
      }
      const txid = result && result.txid !== undefined && result.txid !== null ? String(result.txid) : null;
      await db.transaction((tx) =>
        tx.exec(`UPDATE ${writesQuoted} SET STATE = 'S', TXID = ?, SENT_AT = ? WHERE ID = ?`, [txid, Date.now(), next.id])
          .then(() => undefined));
      flushedInPass.push(payload);
    }
    if (flushedInPass.length > 0) {
      options.onFlush?.(flushedInPass);
    }
  };

  function kick(ignorePaused = false) {
    if (closed || (isPaused && !ignorePaused) || sending) return;
    sending = sendAll(ignorePaused)
      .catch((err) => report(err instanceof Error ? err : new Error(String(err)), undefined as never))
      .finally(() => { sending = null; });
  }

  const onOnline = () => {
    if (closed || isPaused) return;
    clearTimeout(timer);
    kick();
  };

  const eventTarget = globalThis as unknown as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  if (options.autoFlushOnOnline !== false && typeof eventTarget.addEventListener === 'function') {
    eventTarget.addEventListener('online', onOnline);
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
          await tx.exec(`DELETE FROM ${writesQuoted} WHERE ID = ?`, [w.id]);
          continue;
        }

        const isTouched = touched === 'all' || touched.has(keyText(w.key));
        if (w.state === 'P' && hasBeforeColumn && isTouched) {
          const currentAfterSync = await snapshotRow(tx, w.table, w.key);
          let serverRow: Record<string, unknown> | null;
          if (currentAfterSync === null) {
            serverRow = null;
          } else if (w.operation === 'update' && w.before !== null) {
            serverRow = { ...w.before, ...currentAfterSync };
            for (const col of Object.keys(w.value)) {
              if (valuesEqual(currentAfterSync[col], w.value[col])) {
                serverRow[col] = w.before[col];
              }
            }
          } else {
            serverRow = currentAfterSync;
          }

          if (!rowsEqual(w.before, serverRow)) {
            const ctx: WriteConflictContext = {
              write: {
                id: w.id,
                table: w.table,
                operation: w.operation,
                key: w.key,
                value: w.value,
                before: w.before,
              },
              before: w.before,
              server: serverRow,
              source: 'sync',
              attempt: 1,
            };
            const outcome = await evaluateConflictStrategy(options.onConflict, ctx);
            options.onConflictResolved?.(ctx, outcome);
            await applyResolvedOutcomeInTx(tx, w, serverRow, outcome);
            continue;
          }
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

  // Writes left from before (a reload, offline) go out now unless started paused.
  kick();

  return {
    insert: (table, value) => write('insert', table, null, value),
    update: (table, key, value) => write('update', table, key, value),
    delete: (table, key) => write('delete', table, key, {}),
    pending: () => db.transaction((tx) => load(tx)).then((ws) =>
      ws.map(({ id, table, operation, key, value }) => ({ id, table, operation, key, value }))),
    discard: async (id: number) => {
      return db.transaction(async (tx) => {
        const all = await load(tx);
        const target = all.find((w) => w.id === id);
        if (!target) return false;
        await revertWriteInTx(tx, target, all);
        return true;
      });
    },
    clear: async () => {
      return db.transaction(async (tx) => {
        const all = await load(tx);
        for (let i = all.length - 1; i >= 0; i--) {
          await revertWriteInTx(tx, all[i]!);
        }
        return all.length;
      });
    },
    pause: () => {
      isPaused = true;
      clearTimeout(timer);
    },
    resume: () => {
      isPaused = false;
      clearTimeout(timer);
      kick();
    },
    get paused() {
      return isPaused;
    },
    flush: async () => {
      clearTimeout(timer);
      if (sending) {
        await sending;
      }
      kick(true);
      await sending;
    },
    close: async () => {
      closed = true;
      clearTimeout(timer);
      if (options.autoFlushOnOnline !== false && typeof eventTarget.removeEventListener === 'function') {
        eventTarget.removeEventListener('online', onOnline);
      }
      await sending;
    },
    sync,
  };
}

async function ensureWritesTable(
  db: WritesDatabase,
  writesQuoted: string,
  writesRawName: string,
): Promise<boolean> {
  const relationCheckSql =
    writesRawName === 'ELECTRIC_WRITES'
      ? "SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_WRITES'"
      : 'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?';
  const relationCheckParams = writesRawName === 'ELECTRIC_WRITES' ? undefined : [writesRawName];

  for (let attempt = 1; ; attempt++) {
    try {
      let hasBeforeColumn = true;
      await db.transaction(async (tx) => {
        const { rows } = relationCheckParams
          ? await tx.query(relationCheckSql, relationCheckParams)
          : await tx.query(relationCheckSql);
        if (rows.length > 0) {
          try {
            const colCheck = await tx.query(
              'SELECT 1 AS X FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?',
              [writesRawName, 'BEFORE_JSON'],
            );
            if (colCheck.rows.length === 0) {
              await tx.exec(
                `ALTER TABLE ${writesQuoted} ADD BEFORE_JSON VARCHAR(${MAX_BEFORE_VALUE}) CHARACTER SET UTF8`,
              );
            }
          } catch {
            hasBeforeColumn = false;
          }
          return;
        }
        await tx.exec(
          `CREATE TABLE ${writesQuoted} (ID INTEGER NOT NULL PRIMARY KEY, TABLE_NAME VARCHAR(255) NOT NULL, ` +
            // Not a BLOB: FirebirdLite reads a BLOB back as a handle, not text.
            'OP CHAR(1) NOT NULL, KEY_JSON VARCHAR(2000) CHARACTER SET UTF8 NOT NULL, ' +
            `VALUE_JSON VARCHAR(${MAX_VALUE}) CHARACTER SET UTF8, ` +
            `BEFORE_JSON VARCHAR(${MAX_BEFORE_VALUE}) CHARACTER SET UTF8, ` +
            "STATE CHAR(1) DEFAULT 'P' NOT NULL, TXID VARCHAR(40), SENT_AT DOUBLE PRECISION)",
        );
      });
      return hasBeforeColumn;
    } catch (error) {
      const made = await db.transaction(async (tx) => {
        const res = relationCheckParams
          ? await tx.query(relationCheckSql, relationCheckParams)
          : await tx.query(relationCheckSql);
        return res.rows.length > 0;
      });
      if (made) return true;
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

export { keyText as writeKeyText };
