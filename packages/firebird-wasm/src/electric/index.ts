/**
 * firebird-wasm/electric – a Postgres table, through Electric, into Firebird.
 *
 * ```ts
 * import { syncShapeToTable } from 'firebird-wasm/electric';
 *
 * await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, title VARCHAR(100))');
 * const sync = await syncShapeToTable(db, {
 *   shape: { url: 'https://electric.example.com/v1/shape', params: { table: 'items' } },
 *   table: 'items',
 *   shapeKey: 'items',
 * });
 * await sync.upToDate;           // the first complete copy is in
 * await sync.unsubscribe();
 * ```
 *
 * Read-only: Electric streams changes out of Postgres and takes no writes,
 * which go through the app's own API and come back down the shape.  Each
 * batch Electric marks `up-to-date` is applied in one Firebird transaction
 * with the sync position, so a reload resumes exactly where the database is.
 * See docs/plans/electric-sync.md for the design and docs/integration.md for
 * use.
 *
 * `@electric-sql/client` is an optional peer dependency: install it to use
 * this module.
 */

import { ShapeStream, isChangeMessage, isControlMessage } from '@electric-sql/client';
import type { Message, Row as ElectricRow, ShapeStreamOptions } from '@electric-sql/client';
import { applyEntries, defaultColumn } from './apply';
import type { ElectricTransaction, LogEntry } from './apply';
import { checkSchema, firebirdName, primaryKeyOf } from './values';
import type { ElectricSchema } from './values';

export { tableFromSchema, checkSchema, toFirebird, firebirdColumn, firebirdName } from './values';
export type { ElectricSchema, ElectricColumn } from './values';
export type { ElectricTransaction } from './apply';

/** What the sync needs of a database: `FirebirdBrowser` has it. */
export interface ElectricDatabase {
  transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T>;
}

/** Options of {@link syncShapeToTable}. */
export interface SyncShapeToTableOptions {
  /**
   * The shape, as `ShapeStream` takes it: `url` of Electric's `/v1/shape`
   * (or a proxy in front of it), and `params` with at least `table`.
   */
  shape: ShapeOptions;
  /** The Firebird table the rows go to, as written in Firebird SQL. */
  table: string;
  /**
   * Where the sync position is kept, so that the next sync resumes rather
   * than starting over; `null` starts over every time (and empties the
   * table first).  One shape per key, and one shape per table.
   */
  shapeKey: string | null;
  /** The primary key, as Postgres column names.  Default: the shape's own. */
  primaryKey?: string[];
  /** Firebird column names for Postgres columns, where the default mapping does not fit. */
  columns?: Record<string, string>;
  /**
   * The event posted once per applied batch, delivered when it commits, so
   * `useLiveQuery` and `db.live()` can follow the sync without a trigger.
   * Default `electric_<shapeKey>`, or `electric_<table>` without a key.
   */
  event?: string | null;
  /** Called when the sync stops on an error.  Default: console.error. */
  onError?: (error: Error) => void;
  /** For tests: the ShapeStream class to use. */
  ShapeStream?: typeof ShapeStream;
}

/** The shape options a sync passes on to `ShapeStream`. */
export type ShapeOptions = Omit<ShapeStreamOptions, 'parser' | 'transformer' | 'columnMapper' | 'offset' | 'handle'>;

/** One shape of {@link syncShapesToTables}. */
export interface ShapeTableOptions {
  /** The shape, as {@link SyncShapeToTableOptions.shape}. */
  shape: ShapeOptions;
  /** The Firebird table its rows go to. */
  table: string;
  /** The primary key, as Postgres column names.  Default: the shape's own. */
  primaryKey?: string[];
  /** Firebird column names for Postgres columns. */
  columns?: Record<string, string>;
}

/** Options of {@link syncShapesToTables}. */
export interface SyncShapesToTablesOptions {
  /** The shapes, by a name of your choosing; one table each. */
  shapes: Record<string, ShapeTableOptions>;
  /**
   * Where the positions are kept (one per shape, under `<key>:<name>`), so
   * the next sync resumes; `null` starts over every time.
   */
  key: string | null;
  /** The event posted once per committed batch.  Default `electric_<key>`, or none without a key. */
  event?: string | null;
  /** Called when the sync stops on an error.  Default: console.error. */
  onError?: (error: Error) => void;
  /** For tests: the ShapeStream class to use. */
  ShapeStream?: typeof ShapeStream;
}

/** A running sync.  Returned by {@link syncShapeToTable} and {@link syncShapesToTables}. */
export interface ShapeSync {
  /** Resolves when the first complete copy of the shape is in; rejects if the sync stops before. */
  readonly upToDate: Promise<void>;
  /** True once a batch marked up-to-date has been applied. */
  readonly isUpToDate: boolean;
  /** Why the sync stopped, if it stopped on an error. */
  readonly error: Error | undefined;
  /** Stop syncing.  The rows and the position stay; a later sync resumes. */
  unsubscribe(): Promise<void>;
}

const METADATA = '"ELECTRIC_SHAPES"';

/** Electric's own parsing, turned off for the types it parses: values stay Postgres text. */
const IDENTITY = (value: string) => value;
const KEEP_TEXT = Object.fromEntries(
  ['int2', 'int4', 'int8', 'float4', 'float8', 'bool', 'json', 'jsonb'].map((t) => [t, IDENTITY]),
);

/**
 * Keep `options.table` in step with a shape: an initial copy, then every
 * change, until {@link ShapeSync.unsubscribe}.  The table must exist.
 */
export async function syncShapeToTable(
  db: ElectricDatabase,
  options: SyncShapeToTableOptions,
): Promise<ShapeSync> {
  return syncShapes(db, {
    shapes: [{
      shape: options.shape,
      table: options.table,
      primaryKey: options.primaryKey,
      columns: options.columns,
      positionKey: options.shapeKey,
    }],
    event: options.event === undefined ? `electric_${options.shapeKey ?? options.table}` : options.event,
    onError: options.onError,
    ShapeStream: options.ShapeStream,
  });
}

/**
 * Keep several tables in step with several shapes, together: every batch is
 * applied in one Firebird transaction with all the shapes' positions, so a
 * Postgres transaction that wrote to two of them never shows in one table
 * and not the other.
 *
 * A batch is applied once every shape has reached up-to-date after the last
 * change it received.  Electric marks each up-to-date with the last
 * Postgres position it has seen (`global_last_seen_lsn`); where it does, the
 * shapes must also be at the same one, and a shape behind is asked to
 * refresh, so the batch holds the whole of each transaction it holds any of.
 * The tables must exist.
 */
export async function syncShapesToTables(
  db: ElectricDatabase,
  options: SyncShapesToTablesOptions,
): Promise<ShapeSync> {
  const names = Object.keys(options.shapes);
  if (names.length === 0) throw new RangeError('syncShapesToTables needs at least one shape');
  const tables = names.map((n) => firebirdName(options.shapes[n]!.table));
  if (new Set(tables).size !== tables.length) throw new RangeError('Each shape needs a table of its own');
  return syncShapes(db, {
    shapes: names.map((name) => ({
      ...options.shapes[name]!,
      positionKey: options.key === null ? null : `${options.key}:${name}`,
    })),
    event: options.event === undefined ? (options.key === null ? null : `electric_${options.key}`) : options.event,
    onError: options.onError,
    ShapeStream: options.ShapeStream,
  });
}

interface ShapeSpec extends ShapeTableOptions {
  /** The ELECTRIC_SHAPES key of its position, or null to start over. */
  positionKey: string | null;
}

/** One shape's part of a running sync. */
interface ShapeState {
  spec: ShapeSpec;
  table: string;
  column: (name: string) => string;
  stream: ShapeStream;
  abort: AbortController;
  schema: ElectricSchema | undefined;
  checked: boolean;
  /** Operations received since the last commit. */
  pending: LogEntry[];
  /** A change came after the last up-to-date: the shape is mid-transaction. */
  dirty: boolean;
  /** Has reached up-to-date at least once. */
  seen: boolean;
  /** `global_last_seen_lsn` of the last up-to-date, where the server sends it. */
  lsn: bigint | undefined;
  /** Position at the last up-to-date: what a commit stores. */
  handle: string | undefined;
  offset: string | undefined;
  /** Asked to refresh to catch up with another shape; not again until it answers. */
  refreshing: boolean;
}

async function syncShapes(
  db: ElectricDatabase,
  options: {
    shapes: ShapeSpec[];
    event: string | null;
    onError?: (error: Error) => void;
    ShapeStream?: typeof ShapeStream;
  },
): Promise<ShapeSync> {
  const report = options.onError ?? ((e: Error) => console.error('[firebird-wasm/electric] sync stopped', e));
  const eventName = options.event;

  // Where a previous sync stopped.  Its own transaction first: Firebird
  // applies DDL at commit, so a table made in a transaction cannot be read
  // in that same transaction.
  await ensureMetadata(db);
  const positions = new Map<string, { handle: string; offset: string; schema: ElectricSchema }>();
  await db.transaction(async (tx) => {
    for (const spec of options.shapes) {
      if (spec.positionKey === null) continue;
      const { rows } = await tx.query(
        `SELECT SHAPE_HANDLE, SHAPE_OFFSET, SHAPE_SCHEMA FROM ${METADATA} WHERE SHAPE_KEY = ?`,
        [spec.positionKey],
      );
      const row = rows[0];
      if (row && row['SHAPE_HANDLE'] && row['SHAPE_OFFSET']) {
        positions.set(spec.positionKey, {
          handle: String(row['SHAPE_HANDLE']),
          offset: String(row['SHAPE_OFFSET']),
          schema: JSON.parse(String(row['SHAPE_SCHEMA'] ?? '{}')) as ElectricSchema,
        });
      }
    }
  });

  let upToDate = false;
  let failure: Error | undefined;
  let stopped = false;
  let committing: Promise<void> = Promise.resolve();

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  const Stream = options.ShapeStream ?? ShapeStream;
  const states: ShapeState[] = [];

  const stop = async (error?: Error) => {
    if (stopped) return;
    stopped = true;
    for (const s of states) {
      s.abort.abort();
      s.stream.unsubscribeAll();
    }
    if (error) {
      failure = error;
      rejectReady(error);
      report(error);
    }
  };

  /** Apply every shape's pending operations, and every position, in one transaction. */
  const commit = async () => {
    const batch = states.map((s) => ({ s, entries: s.pending, handle: s.handle, offset: s.offset }));
    for (const s of states) s.pending = [];
    const targets = batch.map(({ s }) => {
      const schema = s.schema;
      if (!schema) throw new Error('Electric sent rows before a schema; the sync cannot map them');
      if (!s.checked) {
        checkSchema(schema);
        s.checked = true;
      }
      const primaryKey = s.spec.primaryKey ?? primaryKeyOf(schema);
      if (primaryKey.length === 0) {
        throw new Error(`The shape of ${s.spec.table} has no primary key; pass primaryKey`);
      }
      return { table: s.table, column: s.column, schema, primaryKey };
    });
    await db.transaction(async (tx) => {
      for (let i = 0; i < batch.length; i++) {
        const { s, entries, handle, offset } = batch[i]!;
        await applyEntries(tx, targets[i]!, entries);
        if (s.spec.positionKey !== null && handle && offset) {
          await tx.exec(
            `UPDATE OR INSERT INTO ${METADATA} (SHAPE_KEY, SHAPE_HANDLE, SHAPE_OFFSET, SHAPE_SCHEMA) ` +
              'VALUES (?, ?, ?, ?) MATCHING (SHAPE_KEY)',
            [s.spec.positionKey, handle, offset, JSON.stringify(targets[i]!.schema)],
          );
        }
      }
      if (eventName) {
        await tx.exec(
          'EXECUTE BLOCK (event_name VARCHAR(127) = ?) AS BEGIN POST_EVENT :event_name; END',
          [eventName],
        );
      }
    });
    if (!upToDate) {
      upToDate = true;
      resolveReady();
    }
  };

  /** Commit if every shape is at a transaction boundary, and the same one where that is known. */
  const settle = async () => {
    if (stopped || states.some((s) => !s.seen || s.dirty)) return;
    const lsns = states.map((s) => s.lsn);
    if (lsns.every((l) => l !== undefined)) {
      const top = lsns.reduce((a, b) => (b! > a! ? b : a))!;
      const behind = states.filter((s) => s.lsn! < top);
      if (behind.length > 0) {
        // Idle in a long poll since an earlier position: ask for the current one.
        for (const s of behind) {
          if (s.refreshing) continue;
          s.refreshing = true;
          void s.stream.forceDisconnectAndRefresh?.().catch(() => undefined);
        }
        return;
      }
    }
    committing = committing.then(commit);
    await committing;
  };

  for (const spec of options.shapes) {
    const position = spec.positionKey === null ? undefined : positions.get(spec.positionKey);
    const abort = new AbortController();
    const userSignal = spec.shape.signal;
    if (userSignal) userSignal.addEventListener('abort', () => abort.abort(), { once: true });

    const state: ShapeState = {
      spec,
      table: firebirdName(spec.table),
      column: (name: string) =>
        spec.columns?.[name] !== undefined ? firebirdName(spec.columns[name]) : defaultColumn(name),
      stream: undefined as unknown as ShapeStream,
      abort,
      schema: position?.schema,
      checked: false,
      pending: position ? [] : [{ kind: 'reset' }],
      dirty: false,
      seen: false,
      lsn: undefined,
      handle: position?.handle,
      offset: position?.offset,
      refreshing: false,
    };

    // The schema arrives as a header, which the client does not hand on.
    const baseFetch: typeof fetch = spec.shape.fetchClient ?? ((...args) => fetch(...args));
    const fetchClient: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      const header = response.headers.get('electric-schema');
      if (header) {
        state.schema = JSON.parse(header) as ElectricSchema;
        state.checked = false;
      }
      return response;
    };

    state.stream = new Stream({
      ...spec.shape,
      signal: abort.signal,
      fetchClient,
      parser: KEEP_TEXT,
      ...(position ? { handle: position.handle, offset: position.offset as ShapeStreamOptions['offset'] } : {}),
      onError: (error: Error) => {
        // The client has already retried what it retries; this is final.
        void stop(error);
      },
    });
    states.push(state);
  }

  for (const state of states) {
    state.stream.subscribe(async (messages: Message<ElectricRow>[]) => {
      if (stopped) return;
      for (const message of messages) {
        if (isChangeMessage(message)) {
          state.pending.push({ kind: message.headers.operation, value: message.value as Record<string, unknown> });
          state.dirty = true;
        } else if (isControlMessage(message) && message.headers.control === 'must-refetch') {
          // What came before belongs to a shape that no longer exists.
          state.pending = [{ kind: 'reset' }];
          state.dirty = true;
        } else if (isControlMessage(message) && message.headers.control === 'up-to-date') {
          state.dirty = false;
          state.seen = true;
          state.refreshing = false;
          const lsn = (message.headers as { global_last_seen_lsn?: string }).global_last_seen_lsn;
          state.lsn = lsn !== undefined && /^\d+$/.test(lsn) ? BigInt(lsn) : undefined;
          state.handle = state.stream.shapeHandle ?? state.handle;
          state.offset = String(state.stream.lastOffset);
          try {
            await settle();
          } catch (err) {
            await stop(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      }
    });
  }

  return {
    upToDate: ready,
    get isUpToDate() {
      return upToDate;
    },
    get error() {
      return failure;
    },
    unsubscribe: async () => {
      await stop();
      await committing.catch(() => undefined);
      rejectReady(new Error('The sync was stopped before it was up to date'));
    },
  };
}

/** The table holding each shape's position, made on first use. */
async function hasMetadata(tx: ElectricTransaction): Promise<boolean> {
  const { rows } = await tx.query(
    "SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_SHAPES'",
  );
  return rows.length > 0;
}

/**
 * Create the metadata table unless it is there.  Two syncs started together
 * on a new database both find it missing and both create it; the one whose
 * creation fails looks again and goes on with the table the other made.
 */
async function ensureMetadata(db: ElectricDatabase): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        if (await hasMetadata(tx)) return;
        await tx.exec(
          `CREATE TABLE ${METADATA} (` +
            'SHAPE_KEY VARCHAR(255) NOT NULL PRIMARY KEY, ' +
            'SHAPE_HANDLE VARCHAR(255), SHAPE_OFFSET VARCHAR(64), SHAPE_SCHEMA BLOB SUB_TYPE TEXT)',
        );
      });
      return;
    } catch (error) {
      if (await db.transaction((tx) => hasMetadata(tx))) return;
      // The other creation may not have committed yet.
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}
