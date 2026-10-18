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
  shape: Omit<ShapeStreamOptions, 'parser' | 'transformer' | 'columnMapper' | 'offset' | 'handle'>;
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

/** A running sync.  Returned by {@link syncShapeToTable}. */
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
  const table = firebirdName(options.table);
  const column = (name: string) =>
    options.columns?.[name] !== undefined ? firebirdName(options.columns[name]) : defaultColumn(name);
  const eventName = options.event === undefined
    ? `electric_${options.shapeKey ?? options.table}`
    : options.event;
  const report = options.onError ?? ((e: Error) => console.error('[firebird-wasm/electric] sync stopped', e));

  // Where a previous sync stopped.
  let position: { handle: string; offset: string; schema: ElectricSchema } | undefined;
  // Its own transaction: Firebird applies DDL at commit, so a table made in
  // a transaction cannot be read in that same transaction.
  await db.transaction((tx) => ensureMetadata(tx));
  await db.transaction(async (tx) => {
    if (options.shapeKey !== null) {
      const { rows } = await tx.query(
        `SELECT SHAPE_HANDLE, SHAPE_OFFSET, SHAPE_SCHEMA FROM ${METADATA} WHERE SHAPE_KEY = ?`,
        [options.shapeKey],
      );
      const row = rows[0];
      if (row && row['SHAPE_HANDLE'] && row['SHAPE_OFFSET']) {
        position = {
          handle: String(row['SHAPE_HANDLE']),
          offset: String(row['SHAPE_OFFSET']),
          schema: JSON.parse(String(row['SHAPE_SCHEMA'] ?? '{}')) as ElectricSchema,
        };
      }
    }
  });

  let schema: ElectricSchema | undefined = position?.schema;
  let checked = false;
  // Operations received since the last up-to-date; applied together at the next.
  let pending: LogEntry[] = options.shapeKey === null || !position ? [{ kind: 'reset' }] : [];
  let upToDate = false;
  let failure: Error | undefined;
  let stopped = false;
  let applying: Promise<void> = Promise.resolve();

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  const abort = new AbortController();
  const userSignal = options.shape.signal;
  if (userSignal) userSignal.addEventListener('abort', () => abort.abort(), { once: true });

  // The schema arrives as a header, which the client does not hand on.
  const baseFetch: typeof fetch = options.shape.fetchClient ?? ((...args) => fetch(...args));
  const fetchClient: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    const header = response.headers.get('electric-schema');
    if (header) {
      schema = JSON.parse(header) as ElectricSchema;
      checked = false;
    }
    return response;
  };

  const Stream = options.ShapeStream ?? ShapeStream;
  const stream = new Stream({
    ...options.shape,
    signal: abort.signal,
    fetchClient,
    parser: KEEP_TEXT,
    ...(position ? { handle: position.handle, offset: position.offset as ShapeStreamOptions['offset'] } : {}),
    onError: (error: Error) => {
      // The client has already retried what it retries; this is final.
      void stop(error);
    },
  });

  const stop = async (error?: Error) => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    stream.unsubscribeAll();
    if (error) {
      failure = error;
      rejectReady(error);
      report(error);
    }
  };

  const apply = async (entries: LogEntry[]) => {
    if (!schema) throw new Error('Electric sent rows before a schema; the sync cannot map them');
    if (!checked) {
      checkSchema(schema);
      checked = true;
    }
    const target = {
      table,
      column,
      schema,
      primaryKey: options.primaryKey ?? primaryKeyOf(schema),
    };
    if (target.primaryKey.length === 0) {
      throw new Error(`The shape of ${options.table} has no primary key; pass primaryKey`);
    }
    const handle = stream.shapeHandle;
    const offset = String(stream.lastOffset);
    const schemaText = JSON.stringify(schema);
    await db.transaction(async (tx) => {
      await applyEntries(tx, target, entries);
      if (options.shapeKey !== null && handle) {
        await tx.exec(
          `UPDATE OR INSERT INTO ${METADATA} (SHAPE_KEY, SHAPE_HANDLE, SHAPE_OFFSET, SHAPE_SCHEMA) ` +
            'VALUES (?, ?, ?, ?) MATCHING (SHAPE_KEY)',
          [options.shapeKey, handle, offset, schemaText],
        );
      }
      if (eventName) {
        await tx.exec(
          'EXECUTE BLOCK (event_name VARCHAR(127) = ?) AS BEGIN POST_EVENT :event_name; END',
          [eventName],
        );
      }
    });
  };

  stream.subscribe(async (messages: Message<ElectricRow>[]) => {
    if (stopped) return;
    for (const message of messages) {
      if (isChangeMessage(message)) {
        pending.push({ kind: message.headers.operation, value: message.value as Record<string, unknown> });
      } else if (isControlMessage(message) && message.headers.control === 'must-refetch') {
        // What came before belongs to a shape that no longer exists.
        pending = [{ kind: 'reset' }];
      } else if (isControlMessage(message) && message.headers.control === 'up-to-date') {
        const entries = pending;
        pending = [];
        applying = applying.then(() => apply(entries));
        try {
          await applying;
        } catch (err) {
          await stop(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (!upToDate) {
          upToDate = true;
          resolveReady();
        }
      }
    }
  });

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
      await applying.catch(() => undefined);
      rejectReady(new Error('The sync was stopped before it was up to date'));
    },
  };
}

/** The table holding each shape's position, made on first use. */
async function ensureMetadata(tx: ElectricTransaction): Promise<void> {
  const { rows } = await tx.query(
    "SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_SHAPES'",
  );
  if (rows.length > 0) return;
  await tx.exec(
    `CREATE TABLE ${METADATA} (` +
      'SHAPE_KEY VARCHAR(255) NOT NULL PRIMARY KEY, ' +
      'SHAPE_HANDLE VARCHAR(255), SHAPE_OFFSET VARCHAR(64), SHAPE_SCHEMA BLOB SUB_TYPE TEXT)',
  );
}
