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
export { createWriteQueue, WriteRejected, WriteConflict, mergeWriteConflict, DEFAULT_WRITE_QUEUE_TABLE } from './writes';
export type { WriteQueue, WriteQueueOptions, LocalWrite, SendResult, WritesDatabase, ConflictStrategy, ConflictResolution, WriteConflictContext, ResolvedConflictOutcome } from './writes';
import type { WriteQueue } from './writes';
import { writeKeyText } from './writes';
import { serialDatabase } from './serial';

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
  /** Local writes to keep over what the sync applies, and to drop once confirmed: {@link createWriteQueue}. */
  writes?: WriteQueue;
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
  /**
   * Optional names of parent shapes or parent Firebird tables that this
   * shape's table depends on (foreign keys). When present (or discovered
   * automatically from `RDB$REF_CONSTRAINTS`), resets and deletes run
   * child-before-parent while inserts and updates run parent-before-child
   * inside each atomic batch transaction.
   */
  dependencies?: string[];
}

/** Metadata passed to {@link SyncShapesToTablesOptions.onBatchCommitted}. */
export interface SyncBatchCommitInfo {
  /** Firebird table names (quoted) touched in the committed atomic batch. */
  tables: string[];
  /** Source transaction IDs (`txids`) included in the committed batch. */
  txids: string[];
  /** Aligned `global_last_seen_lsn` across shapes when reported by the server. */
  lsn?: bigint;
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
  /** Called after each atomic multi-shape batch commits. */
  onBatchCommitted?: (info: SyncBatchCommitInfo) => void;
  /** Local writes to keep over what the sync applies, and to drop once confirmed: {@link createWriteQueue}. */
  writes?: WriteQueue;
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
  return syncShapesInternal(db, {
    shapes: [{
      shape: options.shape,
      table: options.table,
      primaryKey: options.primaryKey,
      columns: options.columns,
      positionKey: options.shapeKey,
    }],
    event: options.event === undefined ? `electric_${options.shapeKey ?? options.table}` : options.event,
    onError: options.onError,
    writes: options.writes,
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
  return syncShapesInternal(db, {
    shapes: names.map((name) => ({
      ...options.shapes[name]!,
      shapeName: name,
      positionKey: options.key === null ? null : `${options.key}:${name}`,
    })),
    event: options.event === undefined ? (options.key === null ? null : `electric_${options.key}`) : options.event,
    onError: options.onError,
    onBatchCommitted: options.onBatchCommitted,
    writes: options.writes,
    ShapeStream: options.ShapeStream,
  });
}

/**
 * Alias for {@link syncShapesToTables} for multi-table transactional sync.
 */
export const syncShapes = syncShapesToTables;

interface ShapeSpec extends ShapeTableOptions {
  /** Logical shape key in `options.shapes`, if provided. */
  shapeName?: string;
  /** The ELECTRIC_SHAPES key of its position, or null to start over. */
  positionKey: string | null;
}

/**
 * Topologically sort shape indices from parent tables to child tables so
 * foreign-key dependencies are satisfied. Throws a `RangeError` on cycles.
 */
export function topologicalSortShapes(
  specs: ReadonlyArray<{ shapeName?: string; table: string; dependencies?: string[] }>,
  catalogFkEdges: ReadonlyArray<{ childTable: string; parentTable: string }> = [],
): { parentOrder: number[]; childOrder: number[]; hasDependencies: boolean } {
  const n = specs.length;
  const byShapeName = new Map<string, number>();
  const byQuotedTable = new Map<string, number>();
  const byUnquotedUpper = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const spec = specs[i]!;
    if (spec.shapeName) {
      byShapeName.set(spec.shapeName, i);
      byShapeName.set(spec.shapeName.toUpperCase(), i);
    }
    const q = firebirdName(spec.table);
    byQuotedTable.set(q, i);
    const unquoted = q.slice(1, -1).replace(/""/g, '"');
    byUnquotedUpper.set(unquoted.toUpperCase(), i);
  }

  const resolveIndex = (ref: string): number | undefined => {
    const trimmed = ref.trim();
    if (byShapeName.has(trimmed)) return byShapeName.get(trimmed);
    if (byShapeName.has(trimmed.toUpperCase())) return byShapeName.get(trimmed.toUpperCase());
    try {
      const q = firebirdName(trimmed);
      if (byQuotedTable.has(q)) return byQuotedTable.get(q);
    } catch {
      // Ignore invalid Firebird identifier when looking up by shape name.
    }
    return byUnquotedUpper.get(trimmed.replace(/^"(.*)"$/, '$1').toUpperCase());
  };

  // parentsOf[childIdx] = Set of parentIdx
  const parentsOf: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
  let edgeCount = 0;

  for (let childIdx = 0; childIdx < n; childIdx++) {
    const deps = specs[childIdx]!.dependencies ?? [];
    for (const dep of deps) {
      const parentIdx = resolveIndex(dep);
      if (parentIdx === undefined) {
        throw new RangeError(
          `Shape "${specs[childIdx]!.shapeName ?? specs[childIdx]!.table}" depends on unknown shape or table "${dep}"`,
        );
      }
      if (parentIdx !== childIdx && !parentsOf[childIdx]!.has(parentIdx)) {
        parentsOf[childIdx]!.add(parentIdx);
        edgeCount++;
      }
    }
  }

  for (const edge of catalogFkEdges) {
    const childIdx = resolveIndex(edge.childTable);
    const parentIdx = resolveIndex(edge.parentTable);
    if (
      childIdx !== undefined &&
      parentIdx !== undefined &&
      childIdx !== parentIdx &&
      !parentsOf[childIdx]!.has(parentIdx)
    ) {
      parentsOf[childIdx]!.add(parentIdx);
      edgeCount++;
    }
  }

  if (edgeCount === 0) {
    const identity = Array.from({ length: n }, (_, i) => i);
    return { parentOrder: identity, childOrder: [...identity].reverse(), hasDependencies: false };
  }

  const inDegree = parentsOf.map((s) => s.size);
  const childrenOf: Array<number[]> = Array.from({ length: n }, () => []);
  for (let child = 0; child < n; child++) {
    for (const parent of parentsOf[child]!) {
      childrenOf[parent]!.push(child);
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const parentOrder: number[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    parentOrder.push(curr);
    for (const child of childrenOf[curr]!) {
      inDegree[child]!--;
      if (inDegree[child] === 0) {
        queue.push(child);
      }
    }
  }

  if (parentOrder.length !== n) {
    throw new RangeError('Cyclic foreign-key dependency detected across synced shapes');
  }

  return {
    parentOrder,
    childOrder: [...parentOrder].reverse(),
    hasDependencies: true,
  };
}

/**
 * Split a shape's pending `LogEntry[]` into:
 * - `deleteEntries`: resets (`DELETE FROM <table>`) and net deletes (`DELETE FROM <table> WHERE ...`)
 *   that must run in child-before-parent order, and
 * - `upsertEntries`: inserts and updates that must run in parent-before-child order.
 */
function splitEntriesForFkPhases(
  entries: LogEntry[],
  primaryKey: string[],
): { deleteEntries: LogEntry[]; upsertEntries: LogEntry[] } {
  let lastResetIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === 'reset') lastResetIdx = i;
  }

  const deleteEntries: LogEntry[] = lastResetIdx >= 0 ? [{ kind: 'reset' }] : [];
  const afterReset = lastResetIdx >= 0 ? entries.slice(lastResetIdx + 1) : entries;

  const keyId = (value: Record<string, unknown>): string =>
    JSON.stringify(primaryKey.map((k) => value[k]));

  // Find the final operation for each primary key after any reset.
  const finalKindByKey = new Map<string, 'insert' | 'update' | 'delete'>();
  for (const entry of afterReset) {
    if (entry.kind === 'reset') continue;
    finalKindByKey.set(keyId(entry.value), entry.kind);
  }

  const emittedDeletes = new Set<string>();
  const upsertEntries: LogEntry[] = [];

  for (const entry of afterReset) {
    if (entry.kind === 'reset') continue;
    const id = keyId(entry.value);
    const finalKind = finalKindByKey.get(id);
    if (finalKind === 'delete') {
      // Only emit the delete in Phase 1 if the table wasn't already emptied by a reset.
      if (lastResetIdx < 0 && entry.kind === 'delete' && !emittedDeletes.has(id)) {
        emittedDeletes.add(id);
        deleteEntries.push(entry);
      }
    } else if (entry.kind !== 'delete') {
      upsertEntries.push(entry);
    }
  }

  return { deleteEntries, upsertEntries };
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
  /** Source transactions whose changes arrived since the last commit (Electric's `txids`). */
  txids: Set<string>;
}

async function syncShapesInternal(
  given: ElectricDatabase,
  options: {
    shapes: ShapeSpec[];
    event: string | null;
    onError?: (error: Error) => void;
    onBatchCommitted?: (info: SyncBatchCommitInfo) => void;
    writes?: WriteQueue;
    ShapeStream?: typeof ShapeStream;
  },
): Promise<ShapeSync> {
  const report = options.onError ?? ((e: Error) => console.error('[firebird-wasm/electric] sync stopped', e));
  const eventName = options.event;
  // One transaction at a time with the other syncs and the write queue.
  const db = serialDatabase(given);

  // Where a previous sync stopped.  Its own transaction first: Firebird
  // applies DDL at commit, so a table made in a transaction cannot be read
  // in that same transaction.
  await ensureMetadata(db);
  const positions = new Map<string, { handle: string; offset: string; schema: ElectricSchema }>();
  const catalogFkEdges: Array<{ childTable: string; parentTable: string }> = [];
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
    if (options.shapes.length > 1) {
      try {
        const fkRes = await tx.query(
          'SELECT TRIM(rc_child.RDB$RELATION_NAME) AS CHILD_TABLE, ' +
            'TRIM(rc_parent.RDB$RELATION_NAME) AS PARENT_TABLE ' +
            'FROM RDB$RELATION_CONSTRAINTS rc_child ' +
            'JOIN RDB$REF_CONSTRAINTS refc ON refc.RDB$CONSTRAINT_NAME = rc_child.RDB$CONSTRAINT_NAME ' +
            'JOIN RDB$RELATION_CONSTRAINTS rc_parent ON rc_parent.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ ' +
            "WHERE rc_child.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY'",
        );
        for (const r of fkRes.rows) {
          if (r['CHILD_TABLE'] && r['PARENT_TABLE']) {
            catalogFkEdges.push({
              childTable: String(r['CHILD_TABLE']).trim(),
              parentTable: String(r['PARENT_TABLE']).trim(),
            });
          }
        }
      } catch {
        // Ignore if the test double does not implement system FK catalog queries.
      }
    }
  });

  const { parentOrder, childOrder, hasDependencies } = topologicalSortShapes(
    options.shapes,
    catalogFkEdges,
  );

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
    const txids = new Set<string>();
    for (const s of states) {
      s.pending = [];
      for (const t of s.txids) txids.add(t);
      s.txids = new Set();
    }
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
      if (hasDependencies) {
        const split = batch.map(({ entries }, i) =>
          splitEntriesForFkPhases(entries, targets[i]!.primaryKey),
        );
        // Phase 1: Resets and deletes in child-before-parent order so foreign-key
        // references from child tables are removed before parent rows are deleted.
        for (const i of childOrder) {
          const { deleteEntries } = split[i]!;
          if (deleteEntries.length > 0) {
            await applyEntries(tx, targets[i]!, deleteEntries);
          }
        }
        // Phase 2: Inserts and updates in parent-before-child order so parent rows
        // exist before child rows reference them.
        for (const i of parentOrder) {
          const { upsertEntries } = split[i]!;
          if (upsertEntries.length > 0) {
            await applyEntries(tx, targets[i]!, upsertEntries);
          }
        }
        for (const i of parentOrder) {
          const { s, entries, handle, offset } = batch[i]!;
          if (options.writes) {
            const keys = targets[i]!.primaryKey;
            const touched = entries.some((e) => e.kind === 'reset')
              ? ('all' as const)
              : new Set(
                  entries.map((e) =>
                    writeKeyText(
                      Object.fromEntries(
                        keys.map((k) => [k, (e as { value: Record<string, unknown> }).value[k]]),
                      ),
                    ),
                  ),
                );
            await options.writes.sync.reconcile(tx, s.spec.table, touched, txids);
          }
          if (s.spec.positionKey !== null && handle && offset) {
            await tx.exec(
              `UPDATE OR INSERT INTO ${METADATA} (SHAPE_KEY, SHAPE_HANDLE, SHAPE_OFFSET, SHAPE_SCHEMA) ` +
                'VALUES (?, ?, ?, ?) MATCHING (SHAPE_KEY)',
              [s.spec.positionKey, handle, offset, JSON.stringify(targets[i]!.schema)],
            );
          }
        }
      } else {
        for (let i = 0; i < batch.length; i++) {
          const { s, entries, handle, offset } = batch[i]!;
          await applyEntries(tx, targets[i]!, entries);
          if (options.writes) {
            // Local writes stay over what the source sent, until it sends them back.
            const keys = targets[i]!.primaryKey;
            const touched = entries.some((e) => e.kind === 'reset')
              ? 'all' as const
              : new Set(entries.map((e) => writeKeyText(Object.fromEntries(
                keys.map((k) => [k, (e as { value: Record<string, unknown> }).value[k]])))));
            await options.writes.sync.reconcile(tx, s.spec.table, touched, txids);
          }
          if (s.spec.positionKey !== null && handle && offset) {
            await tx.exec(
              `UPDATE OR INSERT INTO ${METADATA} (SHAPE_KEY, SHAPE_HANDLE, SHAPE_OFFSET, SHAPE_SCHEMA) ` +
                'VALUES (?, ?, ?, ?) MATCHING (SHAPE_KEY)',
              [s.spec.positionKey, handle, offset, JSON.stringify(targets[i]!.schema)],
            );
          }
        }
      }
      if (eventName) {
        await tx.exec(
          'EXECUTE BLOCK (event_name VARCHAR(127) = ?) AS BEGIN POST_EVENT :event_name; END',
          [eventName],
        );
      }
    });
    if (options.onBatchCommitted) {
      const knownLsns = states.map((s) => s.lsn).filter((l): l is bigint => l !== undefined);
      const alignedLsn =
        knownLsns.length > 0 ? knownLsns.reduce((a, b) => (b > a ? b : a)) : undefined;
      options.onBatchCommitted({
        tables: targets.map((t) => t.table),
        txids: [...txids],
        ...(alignedLsn !== undefined ? { lsn: alignedLsn } : {}),
      });
    }
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

  /** Start (or start again) following one shape, from `position` or from scratch. */
  const open = (state: ShapeState, position: { handle: string; offset: string } | undefined) => {
    const spec = state.spec;
    const abort = new AbortController();
    const userSignal = spec.shape.signal;
    if (userSignal) userSignal.addEventListener('abort', () => abort.abort(), { once: true });
    state.abort = abort;

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

    const stream = new Stream({
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
    state.stream = stream;
    stream.subscribe(async (messages: Message<ElectricRow>[]) => {
      if (stopped || state.stream !== stream) return;
      for (const message of messages) {
        if (isChangeMessage(message)) {
          const oldValue = (message as { old_value?: Record<string, unknown> }).old_value;
          state.pending.push({
            kind: message.headers.operation,
            value: message.value as Record<string, unknown>,
            ...(oldValue !== undefined ? { oldValue } : {}),
          });
          state.dirty = true;
          const txids = (message.headers as { txids?: Array<number | string> }).txids;
          if (txids) for (const t of txids) state.txids.add(String(t));
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
          state.handle = stream.shapeHandle ?? state.handle;
          state.offset = String(stream.lastOffset);
          try {
            await settle();
          } catch (err) {
            await stop(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      }
    });
  };

  const unregister: Array<() => void> = [];
  for (const spec of options.shapes) {
    const position = spec.positionKey === null ? undefined : positions.get(spec.positionKey);
    const state: ShapeState = {
      spec,
      table: firebirdName(spec.table),
      column: (name: string) =>
        spec.columns?.[name] !== undefined ? firebirdName(spec.columns[name]) : defaultColumn(name),
      stream: undefined as unknown as ShapeStream,
      abort: new AbortController(),
      schema: position?.schema,
      checked: false,
      pending: position ? [] : [{ kind: 'reset' }],
      dirty: false,
      seen: false,
      lsn: undefined,
      handle: position?.handle,
      offset: position?.offset,
      refreshing: false,
      txids: new Set(),
    };
    states.push(state);
    open(state, position);
    if (options.writes) {
      // A rejected write is rolled back by fetching the table's shape again:
      // the source's rows, then the writes still pending over them.
      unregister.push(options.writes.sync.register(spec.table, () => {
        if (stopped) return;
        state.abort.abort();
        state.stream.unsubscribeAll();
        state.pending = [{ kind: 'reset' }];
        state.dirty = true;
        state.seen = false;
        state.lsn = undefined;
        open(state, undefined);
      }));
    }
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
      for (const u of unregister) u();
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
