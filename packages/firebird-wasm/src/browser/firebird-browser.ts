/**
 * firebird-browser.ts – Browser-compatible FirebirdLite backed by WASM + IndexedDB.
 *
 * Provides the same PGlite-style async API as the Node.js `FirebirdLite` class,
 * but runs entirely in the browser using:
 *
 *   1. The Firebird Embedded engine compiled to WebAssembly (see `wasm/`).
 *   2. An IndexedDB-backed virtual filesystem for durable page storage.
 *
 * @example
 * ```ts
 * import { FirebirdBrowser } from 'firebird-wasm/browser';
 *
 * // A browser must run the engine in a Worker — see the `worker` option.
 * const db = new FirebirdBrowser('mydb', {
 *   worker: new Worker('/firebird-engine-worker.js'),
 * });
 *
 * await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR(100))');
 * const result = await db.query('SELECT * FROM t');
 * await db.close();
 * ```
 */

import { IndexedDBVFS } from './indexeddb-vfs';
import type { IndexedDBVFSOptions } from './indexeddb-vfs';
import { DirectTransport, buildSweepResult } from './engine-transport';
import type { EngineHandle, EngineTransport } from './engine-transport';
import { WorkerTransport } from './worker-transport';
import { splitStatements } from './sql-script';
import {
  compressGzipStream,
  readDatabaseStreamChunks,
  resolveStreamChunkSize,
} from './data-stream';
import { extractReferencedTables, liveTableTriggerDDL } from './live-tables';
import { ICU_LOCALE_DATA_PATH, isValidIcuDataPackage } from './icu-locales';
import { introspect as introspectSchema, migrate as runMigrations } from './schema';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobColumnIndex,
  resolveBlobSegmentSize,
} from './blob-stream';
import { buildCopyToStream, executeCopyFromStream } from './copy-stream';
import { hasTransactionOptions } from './isolation';
import { applyTypes, applySerializers } from './value-types';
import type { TypeOptions } from './value-types';
import { acquireDatabaseLock } from './db-lock';
import { SharedEngineTransport } from './shared-transport';
import type { DatabaseLock } from './db-lock';
import { toStatement, resolveQueryCall, resolveBatchSize } from '../sql-tag';
import type { SqlFragment, Statement } from '../sql-tag';
import type {
  ArrayRow,
  QueryResult,
  QueryDescription,
  ExplainOptions,
  DatabaseInfo,
  SweepResult,
  PreparedStatement,
  DataStreamOptions,
  CopyFromOptions,
  CopyToOptions,
  CopyResult,
  IntrospectOptions,
  SchemaIntrospection,
  Migration,
  MigrateOptions,
  BlobStreamOptions,
  BlobHandle,
  BlobWritableStream,
  MigrateResult,
  QueryOptions,
  QueryStreamOptions,
  StatementExecutionOptions,
  Row,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';

/** `QueryOptions` with the array mode pinned, for the overloads below. */
type ArrayModeOptions = QueryOptions & { rowMode: 'array' };
/** `QueryStreamOptions` with the array mode pinned, for the overloads below. */
type ArrayStreamOptions = QueryStreamOptions & { rowMode: 'array' };

function validateTimeoutMs(timeoutMs?: number): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new RangeError('timeoutMs must be a non-negative finite number');
  }
  return Math.floor(timeoutMs);
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(
    reason !== undefined && reason !== null
      ? String(reason)
      : 'The operation was aborted',
  );
  err.name = 'AbortError';
  return err;
}

function createTimeoutError(timeoutMs: number): Error {
  const err = new Error(`Statement timed out after ${timeoutMs}ms`);
  err.name = 'TimeoutError';
  return err;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}

async function runWithCancellation<T>(
  work: () => Promise<T>,
  options: StatementExecutionOptions | undefined,
  onCancel: () => Promise<void>,
): Promise<T> {
  const signal = options?.signal;
  const timeoutMs = validateTimeoutMs(options?.timeoutMs);
  assertNotAborted(signal);

  if (!signal && (!timeoutMs || timeoutMs <= 0)) {
    return work();
  }

  let cleanup = (): void => undefined;
  const cancelPromise = new Promise<never>((_resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      void onCancel().catch(() => undefined);
      reject(toAbortError(signal?.reason));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        void onCancel().catch(() => undefined);
        reject(createTimeoutError(timeoutMs));
      }, timeoutMs);
    }
    cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  });

  try {
    const workPromise = work();
    workPromise.catch(() => undefined);
    return await Promise.race([workPromise, cancelPromise]);
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A running subscription.  Returned by {@link FirebirdBrowser.listen}. */
export interface EventSubscription {
  /** Stop listening and release the subscription.  Safe to call twice. */
  unsubscribe(): Promise<void>;
}

/** Options for {@link FirebirdBrowser.listen}. */
export interface ListenOptions {
  /**
   * How often to ask the engine whether anything fired, in milliseconds.
   *
   * This is a poll because the engine's callback runs on an engine thread and
   * re-arming has to happen off it — see `fb_events_poll`. The cost of a tick
   * that finds nothing is one round trip to the Worker.
   *
   * @default 250
   */
  pollIntervalMs?: number;
  /**
   * Called when a poll or a handler throws.
   *
   * A subscription outlives the call that created it, so an error has nowhere
   * else to go. Defaults to `console.error`; polling continues, because one
   * failure does not mean the next will fail.
   */
  onError?: (error: Error) => void;
}

/** Options for {@link FirebirdBrowser.live}. */
export interface LiveQueryOptions {
  /**
   * Event names to watch, as posted by `POST_EVENT`.
   *
   * When omitted (`undefined`), `live()` extracts the user tables referenced
   * by the statement, installs an idempotent `AFTER INSERT OR UPDATE OR DELETE`
   * `POST_EVENT` trigger (`FB_LIVE$<hash>`) on each table, and watches those
   * events automatically.
   *
   * Pass an explicit non-empty array when watching custom application events
   * posted by your own triggers or `db.notify()`. Passing an empty array `[]`
   * throws a `RangeError`.
   */
  events?: readonly string[];
  /** Parameters for the statement, as `query()` takes them. */
  params?: QueryParams;
  /**
   * How often to ask the engine whether anything fired, in milliseconds.
   *
   * This is a poll because the engine's callback runs on an engine thread and
   * re-arming has to happen off it — see `fb_events_poll`. The cost of a tick
   * that finds nothing is one round trip to the Worker.
   *
   * @default 250
   */
  pollIntervalMs?: number;
  /**
   * Called when a refresh fails.
   *
   * A live query outlives the call that created it, so an error has nowhere
   * else to go. Defaults to `console.error`; polling continues, because one
   * failed refresh — a lock conflict, say — does not mean the next will fail.
   */
  onError?: (error: Error) => void;
}

/** A running live query.  Returned by {@link FirebirdBrowser.live}. */
export interface LiveQuery<T> {
  /** The most recent rows.  Replaced, not mutated, on each refresh. */
  readonly rows: T[];
  /** Re-run the statement now, without waiting for an event. */
  refresh(): Promise<void>;
  /** Stop watching and release the subscription.  Safe to call twice. */
  unsubscribe(): Promise<void>;
}

/** What a statement did.  Returned by `exec()`. */
export interface ExecResult {
  /** Rows affected — for INSERT, UPDATE and DELETE.  0 for DDL. */
  affectedRows: number;
}

/** Options for creating a {@link FirebirdBrowser} instance. */
export interface FirebirdBrowserOptions {
  /** Options forwarded to the IndexedDB VFS layer. */
  vfs?: IndexedDBVFSOptions;
  /**
   * URL or `ArrayBuffer` of the `firebird-embedded.wasm` binary.
   * Passed through to the engine loader.
   */
  wasmBinary?: ArrayBuffer | string;
  /**
   * Custom `locateFile` callback for Emscripten.
   * @see {@link import('../wasm-loader').WasmLoadOptions.locateFile}
   */
  locateFile?: (filename: string) => string;
  /**
   * Which build the engine loads in Node; see
   * {@link import('../wasm-loader').WasmLoadOptions.threads}.  In a browser
   * the page chooses by the glue script it loads ({@link wasmGlueFile}).
   */
  threads?: boolean | 'auto';
  /**
   * Worker running the engine.
   *
   * **Browsers need this with the threaded build.**  It uses pthreads, so
   * Firebird blocks on mutexes while opening a database, and a browser main
   * thread is not allowed to block — without a Worker the page deadlocks.
   * Build the Worker script from `firebird-wasm/browser/worker-entry`.
   *
   * Omit it where blocking the calling thread is acceptable, such as Node or
   * a test harness driving a stub engine, or with `firebird-embedded-st.js`,
   * the build without threads, which never blocks and can run on the page
   * thread (though a Worker still keeps long statements off it).
   *
   * With `multiTab: 'shared'` this must be a **factory**.  It is called only
   * if this tab wins the election, so a follower never downloads and
   * instantiates a 9 MB engine to sit idle beside the one already running.
   */
  worker?: Worker | (() => Worker);
  /**
   * Use a transport of your own.  Takes precedence over `worker`; mainly a
   * seam for tests.
   */
  transport?: EngineTransport;
  /**
   * Persist to IndexedDB automatically after writes.
   *
   * Without this, a tab closed without `close()` loses everything written in
   * that session — the common way to leave a page.  Enabled by default:
   * silently losing committed data is a worse default than the cost of
   * writing it.
   *
   * Set `false` to persist only on `close()` and explicit `persist()` calls.
   *
   * @default true
   */
  autoPersist?: boolean;
  /**
   * How long to wait after the last write before persisting, in
   * milliseconds.  Bursts of statements coalesce into one persist.
   *
   * @default 500
   */
  autoPersistDebounceMs?: number;
  /**
   * Called when a background persist fails.
   *
   * Background persists cannot reject into caller code, and swallowing the
   * error would hide data loss, so it is reported here.  Defaults to
   * `console.error`.
   */
  onPersistError?: (error: Error) => void;
  /**
   * What to do when the same database is already open in another tab.
   *
   * Every tab keeps its own complete copy of the database and persists the
   * whole image, so two writers do not interleave — the later persist discards
   * the earlier tab's work entirely, with both tabs reporting success.
   *
   * - `'exclusive'` (default) takes a cross-tab lock and fails with
   *   {@link DatabaseLockedError} if another tab will not release it in time.
   * - `'shared'` elects one tab to run the engine and serves the others from
   *   it, so every tab sees the same live database.  Needs `worker` to be a
   *   factory rather than an instance — a follower must not build an engine it
   *   will never use.
   * - `'allow-unsafe'` skips the lock.  Only sound when at most one of the
   *   tabs writes.
   *
   * @default 'exclusive'
   */
  multiTab?: 'exclusive' | 'shared' | 'allow-unsafe';
  /**
   * Run `query()` calls made outside `transaction()` that are a `SELECT` in
   * one read-only transaction the engine keeps open, instead of starting and
   * committing a transaction around each.
   *
   * Every statement still reads everything committed before it starts. It
   * halves a cheap query (a primary-key `SELECT` from 44–45 to 20–22 µs in
   * Node). Off by default because two things differ: a `SELECT` that writes (a
   * selectable procedure that updates a table) is tried there first, fails,
   * and is run again in its own transaction — once per SQL text, after which
   * it goes there directly — so what it did outside transaction control before
   * the failed write (a sequence, `RDB$SET_CONTEXT`) happens twice on that
   * first call; and rows a `SELECT` leaves in an `ON COMMIT DELETE ROWS`
   * temporary table stay until the shared transaction ends.
   *
   * @default false
   */
  sharedReads?: boolean;
  /**
   * How long to wait for another tab to release the database, in
   * milliseconds.  `Infinity` waits indefinitely.
   *
   * @default 5000
   */
  lockTimeoutMs?: number;
  /**
   * Convert result values to richer JavaScript types.
   *
   * Off by default: every conversion trades something away, and values as
   * returned today are correct, just awkward. See {@link TypeOptions} for what
   * each one costs — `dates` in particular loses precision and has to choose a
   * time zone Firebird did not store.
   *
   * @example
   * ```ts
   * new FirebirdBrowser('mydb', { worker, types: { bigint: true, binary: true } })
   * ```
   */
  types?: TypeOptions;
  /**
   * Initial contents for the database, as the bytes {@link
   * FirebirdBrowser.dumpDataDir} produced.
   *
   * Used **only when there is no database yet** — a stored one always wins.
   * That is deliberate and is the difference between seeding and destroying:
   * an application passes this on every load, so a seed that replaced what was
   * there would reset the user's data to the snapshot on every page reload.
   *
   * To load a snapshot regardless of what is stored, open it as an ephemeral
   * database: `new FirebirdBrowser('memory://', { loadDataDir: bytes })`.
   */
  loadDataDir?: Uint8Array;
  /**
   * Initial contents for the database as a stream of bytes produced by
   * {@link FirebirdBrowser.dumpDataStream} (raw or gzip-compressed), or a
   * factory returning one.
   *
   * Used **only when there is no database yet** — a stored one always wins.
   */
  loadDataStream?:
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array>
    | (() =>
        | ReadableStream<Uint8Array>
        | AsyncIterable<Uint8Array>
        | Promise<ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>);
  /**
   * Optional lazy-loaded ICU `.dat` (or gzip-compressed `.dat.gz`) locale
   * tailoring bundle (e.g., built via `wasm/tools/build-icu-data.sh --locales`
   * or {@link buildIcuLocalePack}) for locale-specific collations such as
   * `LOCALE=de_DE`, `es_ES`, `fr_FR`, `ja_JP`, registered via a second
   * `udata_setCommonData()` slot without increasing the default WASM binary
   * size.
   */
  icuLocaleData?:
    | Uint8Array
    | ArrayBuffer
    | ArrayBufferLike
    | (() => Uint8Array | ArrayBufferLike | Promise<Uint8Array | ArrayBufferLike>);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Prefix marking a database that is never stored.  Matches PGlite's. */
const MEMORY_PREFIX = 'memory://';

/** Prefix marking a database whose pages live in OPFS rather than IndexedDB. */
const OPFS_PREFIX = 'opfs://';

/**
 * Distinguishes ephemeral databases opened in one page.
 *
 * A counter rather than randomness: every instance in a tab shares one WASM
 * module and therefore one filesystem, so all this has to do is not repeat.
 */
let ephemeralCounter = 0;

/**
 * A filesystem name for `memory://` or `memory://label`.
 *
 * The label is kept for readability when looking at the engine's filesystem,
 * and made unique regardless: two `memory://scratch` databases are two
 * databases, not one shared by two owners. Nothing addresses this path from
 * outside, so uniqueness costs nothing and a collision would silently join two
 * callers who each believe they have their own.
 */
function ephemeralFileName(dbName: string): string {
  const label = dbName.slice(MEMORY_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '') || 'memory';
  ephemeralCounter += 1;
  return `${label}-${ephemeralCounter}`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Browser-side Firebird database backed by WASM + IndexedDB.
 *
 * Mirrors the `FirebirdLite` API so application code can switch between the
 * Node.js native driver and the in-browser WASM engine with minimal changes.
 */
export class FirebirdBrowser {
  private readonly dbName: string;
  /** True for a `memory://` database: never stored, discarded on close. */
  private readonly ephemeral: boolean;
  /** True for an `opfs://` database: the engine writes its pages straight to a file. */
  private readonly opfs: boolean;
  /** Path the engine opens.  Set by the OPFS mount, which chooses it. */
  private opfsPath: string | null = null;
  /**
   * Name of the file inside the engine's own filesystem.
   *
   * The same as `dbName` for a stored database. For an ephemeral one it is
   * made unique per instance, so two `memory://` databases in one page cannot
   * land on the same path — the WASM module, and therefore its filesystem, is
   * shared by every instance in a tab.
   */
  private readonly fileName: string;
  private readonly options: FirebirdBrowserOptions;
  private readonly vfs: IndexedDBVFS;
  private readonly engine: EngineTransport;
  private dbHandle: EngineHandle = 0;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  private readonly autoPersist: boolean;
  private readonly autoPersistDebounceMs: number;
  private readonly onPersistError: (error: Error) => void;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight persist, so two never overlap. */
  private persistInFlight: Promise<void> | null = null;
  /** A write arrived while a persist was running; persist again after it. */
  private persistAgain = false;
  private lifecycleAttached = false;

  private readonly multiTab: 'exclusive' | 'shared' | 'allow-unsafe';
  private readonly lockTimeoutMs: number;
  /** Held for the connection's lifetime; released by close(). */
  private lock: DatabaseLock | null = null;
  /** Live queries to tear down with the connection. */
  private readonly liveQueries = new Set<{ unsubscribe(): Promise<void> }>();
  private readonly preparedStatements = new Set<PreparedStatement>();
  /** Per-table auto-installed live trigger promises (table -> event name). */
  private readonly liveTriggerPromises = new Map<string, Promise<string>>();
  /** Set only in shared mode; owns the election and the channel. */
  private shared: SharedEngineTransport | null = null;

  /**
   * @param dbName  Logical database name.  Used as the IndexedDB store name
   *                and the filename inside Emscripten's virtual FS.
   * @param options Optional configuration.
   */
  constructor(dbName: string, options: FirebirdBrowserOptions = {}) {
    this.dbName = dbName;
    this.ephemeral = dbName.startsWith(MEMORY_PREFIX);
    this.opfs = dbName.startsWith(OPFS_PREFIX);
    this.fileName = this.ephemeral
      ? ephemeralFileName(dbName)
      : this.opfs
        ? dbName.slice(OPFS_PREFIX.length)
        : dbName;
    this.options = options;
    this.vfs = new IndexedDBVFS(options.vfs);

    // An ephemeral database is private to this instance and never stored, so
    // there is nothing for another tab to overwrite and nothing to lock
    // against. Taking the lock anyway would make two tabs queue for a database
    // neither of them shares.
    // OPFS holds the file exclusively itself — a second sync access handle on
    // the same file is refused by the platform — so the Web Lock would be a
    // second, weaker copy of a guarantee already made.
    this.multiTab =
      this.ephemeral || this.opfs ? 'allow-unsafe' : options.multiTab ?? 'exclusive';
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;

    this.autoPersist = options.autoPersist ?? true;
    this.autoPersistDebounceMs = options.autoPersistDebounceMs ?? 500;
    this.onPersistError =
      options.onPersistError ??
      ((error) => console.error('[firebird-wasm] background persist failed', error));

    this.engine = options.transport ?? this.createEngine();
    // Refused here, before anything is opened, rather than after an attach.
    if (options.sharedReads && !this.engine.setSharedReads) {
      throw new Error('sharedReads needs a transport with setSharedReads; this one has none');
    }
  }

  /** Build the real engine for this tab: a Worker if given one, else direct. */
  private createLocalEngine(): EngineTransport {
    const worker = this.options.worker;
    if (worker) {
      return new WorkerTransport(typeof worker === 'function' ? worker() : worker);
    }
    return new DirectTransport({
      wasmBinary: this.options.wasmBinary,
      locateFile: this.options.locateFile,
      threads: this.options.threads,
    });
  }

  private createEngine(): EngineTransport {
    if (this.multiTab !== 'shared') {
      return this.createLocalEngine();
    }

    if (typeof BroadcastChannel === 'undefined') {
      throw new Error(
        "multiTab: 'shared' needs BroadcastChannel, which this environment " +
          "does not have. Use 'exclusive' instead.",
      );
    }

    const shared = new SharedEngineTransport({
      dbName: this.dbName,
      createEngine: () => this.createLocalEngine(),
      // A follower's writes run on the leader's engine, so the leader is the
      // only one that can know its image went stale.
      onServedMutation: () => this.markDirty(),
      onEngineReplaced: () => this.reopenAfterEngineChange(),
    });
    this.shared = shared;
    return shared;
  }

  /**
   * Whether this tab is the one actually running the engine.
   *
   * Always true unless `multiTab: 'shared'`, where exactly one tab owns the
   * engine and the rest are served by it. Useful for deciding which tab should
   * do work that must happen once — an import, a migration, a scheduled
   * cleanup — rather than once per open tab.
   */
  get isLeader(): boolean {
    return this.shared === null || this.shared.isLeader;
  }

  /** Path of the database inside Emscripten's filesystem. */
  private get dbPath(): string {
    return this.opfsPath ?? `/data/${this.fileName}.fdb`;
  }

  /**
   * Run any configured serializers over outgoing parameters.
   *
   * Here rather than in the encoder because the encoder may be on the far side
   * of a Worker, where the serializer functions cannot follow — see
   * {@link applySerializers}.
   */
  private serialize(params: QueryParams): QueryParams {
    return applySerializers(params, this.options.types?.serializers);
  }

  // ── Public API (mirrors FirebirdLite) ─────────────────────────────────

  /**
   * Execute one or more statements that do not return rows.
   *
   * A script may contain several statements, which is what makes this usable
   * for migrations.  Statement boundaries respect string literals, quoted
   * identifiers, comments and `SET TERM`, so a stored procedure body full of
   * semicolons survives intact.  Each statement runs in its own transaction,
   * committed on success — a failure part-way leaves the statements before it
   * committed, as it would in `isql`.
   *
   * Parameters may only be supplied for a single statement: there is no way to
   * say which statement a value belongs to otherwise.  Use `query()` for
   * parameterised statements that return rows.
   *
   * @returns one result per statement, in order.
   */
  /**
   * Cancel the currently running statement on this database attachment via
   * `IAttachment::cancelOperation(status, fb_cancel_raise)`.
   */
  async cancelOperation(): Promise<void> {
    await this.ensureReady();
    if (typeof this.engine.cancelOperation === 'function') {
      await this.engine.cancelOperation(this.dbHandle);
    }
  }

  private async applyOneShotTimeout(timeoutMs?: number): Promise<void> {
    const validated = validateTimeoutMs(timeoutMs);
    if (
      validated !== undefined &&
      validated > 0 &&
      typeof this.engine.stmtSetTimeout === 'function'
    ) {
      await this.engine.stmtSetTimeout(0, validated);
    }
  }

  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ExecResult[]> {
    const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
    const options = Array.isArray(paramsOrOptions)
      ? maybeOptions
      : (paramsOrOptions ?? {});
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);

    await this.ensureReady();

    const script = toStatement(sql, params);
    const statements = splitStatements(script.sql);

    if (script.params.length > 0 && statements.length > 1) {
      throw new Error(
        `Parameters cannot be used with a multi-statement script ` +
          `(${statements.length} statements found); run the statements separately`,
      );
    }

    const results: ExecResult[] = [];

    for (const statement of statements) {
      assertNotAborted(options.signal);
      if (/^\s*(DROP|RECREATE)\b/i.test(statement.sql)) {
        this.liveTriggerPromises.clear();
      }
      const affectedRows = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(options.timeoutMs);
          return this.engine.execute(
            this.dbHandle,
            0,
            statement.sql,
            this.serialize(script.params),
          );
        },
        options,
        () => this.cancelOperation(),
      );
      results.push({ affectedRows });
    }

    if (results.length > 0) {
      this.markDirty();
    }

    return results;
  }

  /**
   * Execute one statement once per row of parameters: a batch.
   *
   * The statement is prepared once and executed for each row, in one
   * transaction that commits when every row went in and rolls back when any
   * failed — a batch is all or nothing.  Loading 100,000 rows this way costs
   * the inserts, not 100,000 prepares and transactions; a failure names the
   * row.  One statement only: a script cannot say which rows belong to which.
   *
   * ```ts
   * await db.execBatch('INSERT INTO t (id, name) VALUES (?, ?)', [[1, 'a'], [2, 'b']]);
   * ```
   *
   * @returns the rows affected over the whole batch.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<ExecResult> {
    await this.ensureReady();

    if (!Array.isArray(rows)) {
      throw new TypeError('execBatch takes an array of parameter rows');
    }
    const statements = splitStatements(sql);
    if (statements.length !== 1) {
      throw new Error(
        `A batch runs one statement, not a script (${statements.length} statements found)`,
      );
    }

    const affectedRows = await this.engine.executeBatch(
      this.dbHandle,
      0,
      statements[0].sql,
      rows.map((row) => this.serialize(row)),
    );

    if (rows.length > 0) {
      this.markDirty();
    }

    return { affectedRows };
  }

  /**
   * Execute a SQL query and return the result rows.
   *
   * Parameters are bound with `?` placeholders, as in the Node.js backend, or
   * interpolated into a `` sql`…` `` fragment:
   *
   * ```ts
   * await db.query('SELECT * FROM items WHERE id = ?', [1]);
   * await db.query(sql`SELECT * FROM items WHERE id = ${1}`);
   * ```
   */
  // `rowMode: 'array'` first, so the literal in the options object picks these
  // and the return type follows the mode rather than the caller's hope.
  async query(
    sql: SqlFragment,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  async query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  // Both shapes at once, so a caller holding a `string | SqlFragment` — one
  // built conditionally — can call this without casting. Last, so the two
  // specific overloads still win where they apply.
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryOptions = [],
    maybeOptions: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    const { statement, options } = resolveQueryCall(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    const queryOpts = options as QueryOptions;
    assertNotAborted(queryOpts.signal);
    validateTimeoutMs(queryOpts.timeoutMs);

    await this.ensureReady();

    // Without options the engine's own auto-commit transaction is used, which
    // is one fewer round trip to the Worker.  With them, the statement has to
    // run inside a transaction that carries them — matching the Node backend,
    // which starts one for every query.
    const rowMode = queryOpts.rowMode ?? 'object';
    // `types.binary` asks for Uint8Array values; the side channel is how they
    // travel. Same result for the caller, without the base64 round trip.
    const binaryBlobs = this.options.types?.binary === true;

    if (!hasTransactionOptions(queryOpts)) {
      const raw = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(queryOpts.timeoutMs);
          return this.engine.query<T>(
            this.dbHandle,
            0,
            statement.sql,
            this.serialize(statement.params),
            rowMode,
            binaryBlobs,
          );
        },
        queryOpts,
        () => this.cancelOperation(),
      );
      return applyTypes(raw, this.options.types, rowMode);
    }

    const txHandle = await this.engine.startTransaction(this.dbHandle, queryOpts);
    try {
      const result = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(queryOpts.timeoutMs);
          return this.engine.query<T>(
            this.dbHandle,
            txHandle,
            statement.sql,
            this.serialize(statement.params),
            rowMode,
            binaryBlobs,
          );
        },
        queryOpts,
        () => this.cancelOperation(),
      );
      await this.engine.commit(txHandle);
      return applyTypes(result, this.options.types, rowMode);
    } catch (err) {
      // A failed commit finishes the transaction itself, so only a failure
      // from the query leaves anything to roll back.
      await this.engine.rollback(txHandle).catch(() => undefined);
      throw err;
    }
  }

  private async queryPreparedHandle<T = Row>(
    stmtHandle: EngineHandle,
    params: QueryParams,
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    await this.ensureReady();

    const rowMode = options.rowMode ?? 'object';
    const binaryBlobs = this.options.types?.binary === true;
    const serialized = this.serialize(params);

    if (!hasTransactionOptions(options)) {
      const raw = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(options.timeoutMs);
          return this.engine.queryStmt!<T>(
            this.dbHandle,
            0,
            stmtHandle,
            serialized,
            rowMode,
            binaryBlobs,
          );
        },
        options,
        () => this.cancelOperation(),
      );
      return applyTypes(raw, this.options.types, rowMode);
    }

    const txHandle = await this.engine.startTransaction(this.dbHandle, options);
    try {
      const result = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(options.timeoutMs);
          return this.engine.queryStmt!<T>(
            this.dbHandle,
            txHandle,
            stmtHandle,
            serialized,
            rowMode,
            binaryBlobs,
          );
        },
        options,
        () => this.cancelOperation(),
      );
      await this.engine.commit(txHandle);
      return applyTypes(result, this.options.types, rowMode);
    } catch (err) {
      await this.engine.rollback(txHandle).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Stream a SQL query's result set in batches of `batchSize` rows (default 500).
   *
   * Yields one `QueryResult<T>` batch per cursor fetch instead of materialising
   * the entire result set into memory at once.  Breaking out of the `for await`
   * loop early closes the cursor and finishes the transaction immediately.
   *
   * ```ts
   * for await (const batch of db.queryStream('SELECT * FROM items', [], { batchSize: 100 })) {
   *   for (const row of batch.rows) {
   *     // process row
   *   }
   * }
   * ```
   */
  queryStream(
    sql: SqlFragment,
    options: ArrayStreamOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayStreamOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryStreamOptions = [],
    maybeOptions: QueryStreamOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    const { statement, options } = resolveQueryCall<QueryStreamOptions>(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    validateTimeoutMs(options.timeoutMs);
    const batchSize = resolveBatchSize(options.batchSize);
    return this.streamQuery<T>(statement, options, batchSize);
  }

  private async *streamQuery<T>(
    statement: Statement,
    options: QueryStreamOptions,
    batchSize: number,
    stmtHandle: EngineHandle = 0,
  ): AsyncIterableIterator<QueryResult<T>> {
    assertNotAborted(options.signal);
    const totalTimeoutMs = validateTimeoutMs(options.timeoutMs);
    const deadline =
      totalTimeoutMs && totalTimeoutMs > 0
        ? Date.now() + totalTimeoutMs
        : undefined;
    const stepOptions = (): StatementExecutionOptions => ({
      signal: options.signal,
      timeoutMs:
        deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined,
    });

    await this.ensureReady();

    const rowMode = options.rowMode ?? 'object';
    const binaryBlobs = this.options.types?.binary === true;
    const serializedParams = this.serialize(statement.params);
    const useStmtCursor =
      stmtHandle > 0 && typeof this.engine.cursorOpenStmt === 'function';

    if (
      (!useStmtCursor && typeof this.engine.cursorOpen !== 'function') ||
      typeof this.engine.cursorFetch !== 'function' ||
      typeof this.engine.cursorClose !== 'function'
    ) {
      const full = (
        stmtHandle > 0 && typeof this.engine.queryStmt === 'function'
          ? await this.queryPreparedHandle<T>(
              stmtHandle,
              statement.params,
              options,
            )
          : await this.query(statement.sql, statement.params, options)
      ) as QueryResult<T>;
      for (let i = 0; i < full.rows.length; i += batchSize) {
        assertNotAborted(options.signal);
        if (deadline !== undefined && Date.now() >= deadline) {
          throw createTimeoutError(totalTimeoutMs!);
        }
        yield {
          rows: full.rows.slice(i, i + batchSize),
          fields: full.fields.map((f) => ({ ...f })),
        };
      }
      return;
    }

    let txHandle: EngineHandle = 0;
    let ownsTxHandle = false;
    let cursorHandle: EngineHandle = 0;
    let engineFailed = false;

    try {
      if (hasTransactionOptions(options)) {
        txHandle = await this.engine.startTransaction(this.dbHandle, options);
        ownsTxHandle = true;
      }

      try {
        cursorHandle = await runWithCancellation(
          async () => {
            await this.applyOneShotTimeout(totalTimeoutMs);
            return useStmtCursor
              ? this.engine.cursorOpenStmt!(
                  this.dbHandle,
                  txHandle,
                  stmtHandle,
                  serializedParams,
                )
              : this.engine.cursorOpen!(
                  this.dbHandle,
                  txHandle,
                  statement.sql,
                  serializedParams,
                );
          },
          stepOptions(),
          () => this.cancelOperation(),
        );
      } catch (err) {
        engineFailed = true;
        throw err;
      }

      while (true) {
        assertNotAborted(options.signal);
        if (deadline !== undefined && Date.now() >= deadline) {
          engineFailed = true;
          throw createTimeoutError(totalTimeoutMs!);
        }
        let batch: QueryResult<T>;
        try {
          batch = await runWithCancellation(
            () =>
              this.engine.cursorFetch!<T>(
                cursorHandle,
                batchSize,
                rowMode,
                binaryBlobs,
              ),
            stepOptions(),
            () => this.cancelOperation(),
          );
        } catch (err) {
          engineFailed = true;
          throw err;
        }

        if (batch.rows.length === 0) {
          break;
        }

        yield applyTypes(batch, this.options.types, rowMode);
      }

      const toClose = cursorHandle;
      cursorHandle = 0;
      await this.engine.cursorClose(toClose);

      if (ownsTxHandle && txHandle !== 0) {
        const toCommit = txHandle;
        txHandle = 0;
        ownsTxHandle = false;
        await this.engine.commit(toCommit);
      }
    } finally {
      if (cursorHandle !== 0) {
        await this.engine.cursorClose(cursorHandle).catch(() => undefined);
      }
      if (ownsTxHandle && txHandle !== 0) {
        if (engineFailed) {
          await this.engine.rollback(txHandle).catch(() => undefined);
        } else {
          await this.engine
            .commit(txHandle)
            .catch(() => this.engine.rollback(txHandle).catch(() => undefined));
        }
      }
    }
  }

  /**
   * Re-run a query whenever named events fire.
   *
   * ```ts
   * // A trigger does the posting:
   * //   CREATE TRIGGER items_ai FOR items AFTER INSERT
   * //   AS BEGIN POST_EVENT 'items_changed'; END
   *
   * const live = await db.live(
   *   'SELECT id, name FROM items ORDER BY id',
   *   { events: ['items_changed'] },
   *   (rows) => render(rows),
   * );
   * // …later
   * await live.unsubscribe();
   * ```
   *
   * `onChange` is called once immediately with the current rows, so it is the
   * only place results need handling — there is no separate "initial value" to
   * deal with differently.
   *
   * Firebird delivers events **after the posting transaction commits**, so a
   * refresh only ever sees data that survived. That is worth more than
   * immediacy: a live query that showed uncommitted rows would show rows that
   * can vanish.
   *
   * The event names are the caller's to supply. Nothing in Firebird connects a
   * posted event to the tables a statement reads, so inferring them would be
   * guesswork dressed as convenience.
   */
  async listen(
    names: string | string[],
    onEvent: (counts: Record<string, number>) => void,
    options: ListenOptions = {},
  ): Promise<EventSubscription> {
    await this.ensureReady();

    const watched = typeof names === 'string' ? [names] : names;
    if (watched.length === 0) {
      throw new RangeError('listen() needs at least one event name');
    }

    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const onError =
      options.onError ??
      ((error: Error) => console.error('[firebird-wasm] event listener failed', error));

    const handle = await this.engine.eventsSubscribe(this.dbHandle, watched);

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // One tick at a time: a handler slower than the interval would otherwise
    // pile up, and a later poll could re-arm before an earlier handler had
    // finished with what it delivered.
    let running = false;

    const tick = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      try {
        const counts = await this.engine.eventsPoll(handle);
        // Polling re-arms whether or not anything fired, so the empty case
        // still has to reach the engine — it is not a wasted call.
        const fired = Object.fromEntries(
          Object.entries(counts).filter(([, count]) => count > 0),
        );
        if (Object.keys(fired).length > 0 && !stopped) onEvent(fired);
      } catch (err) {
        if (!stopped) onError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        running = false;
      }
    };

    const subscription: EventSubscription = {
      unsubscribe: async () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) clearInterval(timer);
        this.liveQueries.delete(subscription);
        // Best effort: the engine may already be gone if the database was
        // closed first, and a subscription on a closed database is not
        // something a caller can act on.
        await this.engine.eventsCancel(handle).catch(() => undefined);
      },
    };

    timer = setInterval(() => void tick(), pollIntervalMs);
    this.liveQueries.add(subscription);

    return subscription;
  }

  /**
   * Post an event, without writing a trigger to do it.
   *
   * ```ts
   * await db.notify('items_changed');
   * ```
   *
   * The event is delivered **after the transaction posting it commits**, which
   * here is the statement's own auto-commit — so listeners hear about it only
   * once it has actually happened.
   *
   * A trigger remains the better place for anything tied to data changing:
   * `POST_EVENT` in an `AFTER INSERT` fires however the row arrived, including
   * from another connection, while this fires only where it is called.
   */
  async notify(name: string): Promise<void> {
    // The name is bound, not interpolated: EXECUTE BLOCK's body is SQL text
    // like any other, and a name reaching it unchecked would be an injection
    // with a trigger's privileges.
    await this.query(
      'EXECUTE BLOCK (event_name VARCHAR(31) = ?) AS BEGIN POST_EVENT :event_name; END',
      [name],
    );
  }

  async live<T extends Row = Row>(
    sql: string | SqlFragment,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>>;
  async live<T extends Row = Row>(
    sql: string | SqlFragment,
    options: LiveQueryOptions,
    onChange: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>>;
  async live<T extends Row = Row>(
    sql: string | SqlFragment,
    optionsOrOnChange: LiveQueryOptions | ((rows: T[], result: QueryResult<T>) => void),
    maybeOnChange?: (rows: T[], result: QueryResult<T>) => void,
  ): Promise<LiveQuery<T>> {
    await this.ensureReady();

    const options: LiveQueryOptions =
      typeof optionsOrOnChange === 'function' ? {} : optionsOrOnChange;
    const onChange =
      typeof optionsOrOnChange === 'function' ? optionsOrOnChange : maybeOnChange!;

    if (options.events !== undefined && options.events.length === 0) {
      throw new RangeError(
        'live() needs at least one event name to watch; without one it would ' +
          'never refresh, which a plain query() already does better',
      );
    }

    const statement = toStatement(sql, options.params ?? []);
    const watchedEvents =
      options.events !== undefined
        ? [...options.events]
        : await this.ensureLiveTableEvents(statement.sql);

    const onError =
      options.onError ??
      ((error: Error) => console.error('[firebird-wasm] live query failed', error));

    let rows: T[] = [];
    let stopped = false;
    // One refresh at a time: a statement slower than the interval would
    // otherwise pile up, and the last to finish would win rather than the
    // latest to start.  But an event that arrives *during* a refresh is not
    // covered by it — that refresh may have read before the change committed —
    // so it is remembered in `again` and earns exactly one more run.  Dropping
    // it, as this once did, left the rows stale until some later event.
    let refreshing = false;
    let again = false;

    const run = async (): Promise<void> => {
      const result = await this.query<T>(statement.sql, statement.params);
      rows = result.rows;
      onChange(rows, result);
    };

    const drain = async (): Promise<void> => {
      refreshing = true;
      try {
        while (again && !stopped) {
          again = false;
          try {
            await run();
          } catch (err) {
            if (!stopped) onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      } finally {
        refreshing = false;
      }
    };

    const requestRefresh = (): void => {
      if (stopped) return;
      again = true;
      if (!refreshing) void drain();
    };

    // Subscribed before the first query, not after: a change committed between
    // the two would otherwise be in neither — too late for the query, too early
    // for the subscription.  This way it can only be in both, which costs one
    // redundant refresh.
    //
    // Built on listen() rather than beside it: the subscription, the polling
    // and the teardown are the same problem, and a second copy would be a
    // second thing to keep correct.
    const subscription = await this.listen(watchedEvents, requestRefresh, {
      pollIntervalMs: options.pollIntervalMs,
      onError,
    });

    // The first results before returning, so a caller that awaits live() has
    // rendered once by the time it continues.  Marked as a refresh in progress
    // so an event heard meanwhile queues behind it instead of racing it.
    refreshing = true;
    try {
      await run();
    } catch (err) {
      stopped = true;
      await subscription.unsubscribe();
      throw err;
    } finally {
      refreshing = false;
    }
    if (again) void drain();

    const live: LiveQuery<T> = {
      get rows() {
        return rows;
      },
      refresh: async () => {
        if (!stopped) await run();
      },
      unsubscribe: async () => {
        if (stopped) return;
        stopped = true;
        await subscription.unsubscribe();
      },
    };

    return live;
  }

  /**
   * Ensure an idempotent `AFTER INSERT OR UPDATE OR DELETE` `POST_EVENT`
   * trigger exists on each user table referenced by `sqlText`, returning the
   * event names to subscribe to.
   */
  private async ensureLiveTableEvents(sqlText: string): Promise<string[]> {
    const tables = extractReferencedTables(sqlText);
    if (tables.length === 0) {
      throw new RangeError(
        'live() could not find any user tables in the statement to watch automatically; ' +
          'pass { events: [...] } explicitly',
      );
    }
    const events: string[] = [];
    for (const table of tables) {
      let pending = this.liveTriggerPromises.get(table);
      if (!pending) {
        const { eventName, ddl } = liveTableTriggerDDL(table);
        pending = this.engine
          .execute(this.dbHandle, 0, ddl, [])
          .then(() => {
            this.markDirty();
            return eventName;
          })
          .catch((err) => {
            this.liveTriggerPromises.delete(table);
            throw err;
          });
        this.liveTriggerPromises.set(table, pending);
      }
      events.push(await pending);
    }
    return events;
  }

  /**
   * Describe a statement's shape without running it.
   *
   * ```ts
   * const shape = await db.describeQuery('SELECT id, name FROM items WHERE id = ?');
   * // shape.params        → [{ type: 496, typeName: 'INTEGER', … }]
   * // shape.fields        → [{ name: 'ID', … }, { name: 'NAME', … }]
   * // shape.statementType → 'SELECT'
   * ```
   *
   * The statement is prepared and dropped, so nothing happens: describing an
   * `INSERT` inserts nothing. Preparing is not free — the engine parses and
   * plans — but it is the only way to learn a shape, and the alternative,
   * running the statement to see what comes back, is not one.
   *
   * A `` sql`…` `` fragment is accepted and its values ignored; only the text
   * decides the shape, and a fragment is often what a caller has to hand.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    return this.engine.describe(this.dbHandle, 0, toStatement(sql).sql);
  }

  /**
   * Run a function inside an explicit transaction.
   */
  /**
   * Return Firebird's execution plan for `sql` (`IStatement::getPlan`) without
   * executing the statement.
   *
   * ```ts
   * const plan = await db.explain('SELECT * FROM items WHERE id = ?');
   * // → 'PLAN (ITEMS INDEX (RDB$PRIMARY1))'
   *
   * const detailed = await db.explain('SELECT * FROM items WHERE id = ?', { detailed: true });
   * // → 'Select Expression\n    -> Filter\n        -> Table "ITEMS" Access By ID\n...'
   * ```
   *
   * Statements that carry no execution plan (such as DDL) return `""`.
   */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    await this.ensureReady();
    if (typeof this.engine.explain !== 'function') {
      throw new Error('The configured EngineTransport does not support explain()');
    }
    return this.engine.explain(
      this.dbHandle,
      0,
      toStatement(sql).sql,
      options.detailed === true,
    );
  }

  /**
   * Inspect database size, page utilization, ODS version, transaction counters
   * (OIT/OAT/OST/Next), memory pool usage, and page I/O statistics
   * (`IAttachment::getInfo`).
   *
   * ```ts
   * const info = await db.databaseInfo();
   * // info.pageSize          → 8192
   * // info.allocatedPages    → 280
   * // info.databaseSizeBytes → 2293760
   * // info.transactionGap    → info.nextTransaction - info.oldestActive
   * ```
   */
  async databaseInfo(): Promise<DatabaseInfo> {
    await this.ensureReady();
    if (typeof this.engine.databaseInfo !== 'function') {
      throw new Error('The configured EngineTransport does not support databaseInfo()');
    }
    return this.engine.databaseInfo(this.dbHandle);
  }

  /**
   * Trigger an immediate database garbage-collection sweep (`isc_dpb_sweep =
   * isc_dpb_records` and cooperative user-table scan), advancing OIT and
   * returning before/after {@link DatabaseInfo} diagnostics.
   */
  async sweep(): Promise<SweepResult> {
    await this.ensureReady();
    if (typeof this.engine.sweep === 'function') {
      const result = await this.engine.sweep(this.dbHandle);
      this.markDirty();
      return result;
    }

    const started = performance.now();
    const before = await this.databaseInfo();
    let tablesScanned = 0;
    try {
      const relRes = await this.query<Record<string, unknown>>(
        'SELECT TRIM(RDB$RELATION_NAME) AS REL FROM RDB$RELATIONS ' +
          'WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ' +
          'ORDER BY RDB$RELATION_NAME',
      );
      for (const row of relRes.rows) {
        const rel = String(row['REL'] ?? row['rel'] ?? '').trim();
        if (!rel) continue;
        const escaped = rel.replace(/"/g, '""');
        await this.query(`SELECT COUNT(*) AS C FROM "${escaped}"`);
        tablesScanned += 1;
      }
    } catch {
      // Ignore table scan errors on mock transports.
    }
    const after = await this.databaseInfo();
    this.markDirty();
    return buildSweepResult(before, after, tablesScanned, performance.now() - started);
  }

  /**
   * Introspect the database catalog (`RDB$RELATIONS`, `RDB$RELATION_FIELDS`,
   * `RDB$FIELDS`, `RDB$RELATION_CONSTRAINTS`, `RDB$REF_CONSTRAINTS`,
   * `RDB$INDICES`, `RDB$GENERATORS`, and `RDB$TRIGGERS`) and return typed
   * metadata (`tables`, `views`, `columns`, `primaryKeys`, `foreignKeys`,
   * `indexes`, `sequences`, and `triggers`).
   */
  async introspect(options: IntrospectOptions = {}): Promise<SchemaIntrospection> {
    await this.ensureReady();
    return introspectSchema(this, options);
  }

  /**
   * Apply (or revert with `direction: 'down'`) versioned schema migrations
   * transactionally, recording applied versions in `FB_MIGRATIONS$`.
   */
  async migrate(
    migrations: readonly Migration[],
    options: MigrateOptions = {},
  ): Promise<MigrateResult> {
    await this.ensureReady();
    return runMigrations(this, migrations, options);
  }

  /**
   * Prepare a SQL statement explicitly and return a reusable
   * {@link PreparedStatement} handle exposing `fields`, `params`, `query()`,
   * `exec()`, `execBatch()`, and `close()`.
   *
   * ```ts
   * const stmt = await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)');
   * // stmt.params → [{ type: 496, typeName: 'INTEGER', … }, { type: 448, typeName: 'VARCHAR', … }]
   * await stmt.exec([1, 'alpha']);
   * await stmt.execBatch([[2, 'beta'], [3, 'gamma']]);
   * await stmt.close();
   * ```
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    await this.ensureReady();
    const sqlText = toStatement(sql).sql;
    const desc: QueryDescription & { handle?: EngineHandle } =
      typeof this.engine.prepare === 'function'
        ? await this.engine.prepare(this.dbHandle, 0, sqlText)
        : await this.engine.describe(this.dbHandle, 0, sqlText);

    const params = desc.params.map((p) => ({ ...p }));
    const fields = desc.fields.map((f) => ({ ...f }));
    const stmtHandle = desc.handle ?? 0;
    let isClosed = false;
    let currentTimeoutMs = 0;

    const assertOpen = (): void => {
      if (isClosed || this.closed) {
        throw new Error('PreparedStatement has been closed');
      }
    };

    const checkParamCount = (actual: number): void => {
      if (actual !== params.length) {
        throw new Error(
          `PreparedStatement expects ${params.length} parameter(s) but ${actual} were supplied`,
        );
      }
    };

    const isDbClosed = () => this.closed;

    const stmt: PreparedStatement = {
      sql: sqlText,
      get params() {
        return params.map((p) => ({ ...p }));
      },
      get fields() {
        return fields.map((f) => ({ ...f }));
      },
      statementType: desc.statementType,
      hasResultSet: desc.hasResultSet,
      get closed() {
        return isClosed || isDbClosed();
      },
      get timeoutMs() {
        return currentTimeoutMs;
      },
      setTimeout: async (timeoutMs: number) => {
        assertOpen();
        const validated = validateTimeoutMs(timeoutMs) ?? 0;
        currentTimeoutMs = validated;
        if (stmtHandle > 0 && typeof this.engine.stmtSetTimeout === 'function') {
          await this.engine.stmtSetTimeout(stmtHandle, validated);
        }
      },
      query: (async (
        paramsOrOptions: QueryParams | QueryOptions = [],
        maybeOptions: QueryOptions = {},
      ) => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const rawOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        const callOptions: QueryOptions =
          rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...rawOptions, timeoutMs: currentTimeoutMs }
            : rawOptions;
        checkParamCount(callParams.length);
        if (stmtHandle > 0 && typeof this.engine.queryStmt === 'function') {
          return this.queryPreparedHandle(stmtHandle, callParams, callOptions);
        }
        return this.query(sqlText, callParams, callOptions);
      }) as PreparedStatement['query'],
      queryStream: ((
        paramsOrOptions: QueryParams | QueryStreamOptions = [],
        maybeOptions: QueryStreamOptions = {},
      ) => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const rawOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        const callOptions: QueryStreamOptions =
          rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...rawOptions, timeoutMs: currentTimeoutMs }
            : rawOptions;
        checkParamCount(callParams.length);
        validateTimeoutMs(callOptions.timeoutMs);
        const batchSize = resolveBatchSize(callOptions.batchSize);
        const openStream = () =>
          stmtHandle > 0
            ? this.streamQuery(
                { sql: sqlText, params: callParams },
                callOptions,
                batchSize,
                stmtHandle,
              )
            : this.queryStream(sqlText, callParams, callOptions);
        return (async function* () {
          assertOpen();
          yield* openStream();
        })();
      }) as PreparedStatement['queryStream'],
      exec: async (
        callParams: QueryParams = [],
        execOptions: StatementExecutionOptions = {},
      ) => {
        assertOpen();
        checkParamCount(callParams.length);
        const effectiveOptions: StatementExecutionOptions =
          execOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...execOptions, timeoutMs: currentTimeoutMs }
            : execOptions;
        assertNotAborted(effectiveOptions.signal);
        validateTimeoutMs(effectiveOptions.timeoutMs);
        await this.ensureReady();
        const serialized = this.serialize(callParams);
        const affectedRows = await runWithCancellation(
          async () => {
            await this.applyOneShotTimeout(effectiveOptions.timeoutMs);
            return stmtHandle > 0 && typeof this.engine.executeStmt === 'function'
              ? this.engine.executeStmt(
                  this.dbHandle,
                  0,
                  stmtHandle,
                  serialized,
                )
              : this.engine.execute(
                  this.dbHandle,
                  0,
                  sqlText,
                  serialized,
                );
          },
          effectiveOptions,
          () => this.cancelOperation(),
        );
        this.markDirty();
        return { affectedRows };
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        if (!Array.isArray(rows)) {
          throw new TypeError('execBatch takes an array of parameter rows');
        }
        for (const row of rows) {
          checkParamCount(row.length);
        }
        if (
          stmtHandle > 0 &&
          typeof this.engine.executeBatchStmt === 'function'
        ) {
          await this.ensureReady();
          const affectedRows = await this.engine.executeBatchStmt(
            this.dbHandle,
            0,
            stmtHandle,
            rows.map((row) => this.serialize(row)),
          );
          if (rows.length > 0) {
            this.markDirty();
          }
          return { affectedRows };
        }
        return this.execBatch(sqlText, rows);
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        this.preparedStatements.delete(stmt);
        if (
          stmtHandle > 0 &&
          !this.closed &&
          typeof this.engine.stmtClose === 'function'
        ) {
          await this.engine.stmtClose(stmtHandle).catch(() => undefined);
        }
      },
      [Symbol.asyncDispose]: async () => {
        await stmt.close();
      },
    };

    this.preparedStatements.add(stmt);
    return stmt;
  }

  async transaction<T>(
    fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    const txHandle = await this.engine.startTransaction(this.dbHandle, options);

    const tx = new FirebirdBrowserTransaction(
      this.engine,
      this.dbHandle,
      txHandle,
      this.options.types,
    );

    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      if (!tx.isFinished) {
        await this.engine.rollback(txHandle);
      }
      throw err;
    }

    // The callback may have rolled back explicitly; committing after that
    // would target a handle the engine has already finished with.
    if (tx.isFinished) {
      this.markDirty();
      return result;
    }

    // A failed commit finishes the transaction too, so there is nothing left
    // to roll back here.
    await this.engine.commit(txHandle);
    this.markDirty();
    return result;
  }

  /**
   * Persist the in-memory database pages to IndexedDB.
   * Call this periodically or before the page unloads to avoid data loss.
   */
  /**
   * The database as bytes, ready to be stored, sent, or handed to
   * {@link FirebirdBrowserOptions.loadDataDir}.
   *
   * ```ts
   * const bytes = await db.dumpDataDir();
   * const url = URL.createObjectURL(new Blob([bytes]));
   * ```
   *
   * Read from the **live** database rather than from IndexedDB, which matters
   * twice over: writes that have not been persisted yet are included, and an
   * ephemeral `memory://` database has no stored copy to read at all. It is
   * the same image `persist()` writes, taken the same way.
   *
   * A `Uint8Array` rather than a `Blob` — a `Blob` is one constructor away and
   * exists only in a browser, while this class also runs in Node against a
   * direct transport.
   */
  /**
   * Create a segmented writable BLOB stream (`WritableStream<Uint8Array>`)
   * backed by Firebird `IBlob::putSegment`.
   *
   * Once closed (via `pipeTo()`, `writer.close()`, or `finish()`), the stream
   * or its `.handle` can be bound directly as a parameter in `exec()` or
   * `query()`.
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    await this.ensureReady();
    resolveBlobSegmentSize(options.segmentSize, true);

    if (
      typeof this.engine.blobCreate === 'function' &&
      typeof this.engine.blobPutSegment === 'function' &&
      typeof this.engine.blobClose === 'function'
    ) {
      const { blobHandle, blobId } = await this.engine.blobCreate(
        this.dbHandle,
        0,
      );
      return buildBlobWritableStream(
        {
          writeSegment: async (segment) => {
            await this.engine.blobPutSegment!(blobHandle, segment);
          },
          close: async (totalBytes) => {
            const finalId = await this.engine.blobClose!(blobHandle, false);
            return createBlobHandle(
              finalId.byteLength === 8 ? finalId : blobId,
              totalBytes,
            );
          },
          abort: async () => {
            await this.engine
              .blobClose!(blobHandle, true)
              .catch(() => undefined);
          },
        },
        options,
      );
    }

    const chunks: Uint8Array[] = [];
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          chunks.push(segment.slice());
        },
        close: async (totalBytes) => {
          const stagedBytes = new Uint8Array(totalBytes);
          let pos = 0;
          for (const c of chunks) {
            stagedBytes.set(c, pos);
            pos += c.byteLength;
          }
          return createBlobHandle(new Uint8Array(8), totalBytes, {
            stagedBytes,
          });
        },
        abort: async () => {
          chunks.length = 0;
        },
      },
      options,
    );
  }

  /**
   * Open a Firebird `BLOB` column (from a `SELECT` query or a {@link BlobHandle})
   * as a segmented Web `ReadableStream<Uint8Array>` backed by `IBlob::getSegment`.
   */
  async openBlobStream(
    handle: BlobHandle,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: SqlFragment,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: string | SqlFragment,
    params?: QueryParams | BlobStreamOptions,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions: QueryParams | BlobStreamOptions = [],
    maybeOptions: BlobStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    await this.ensureReady();

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
    const stagingId = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      const staged = stagingId;
      if (staged || typeof this.engine.blobOpenId !== 'function') {
        const bytes = staged ?? new Uint8Array(0);
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              if (offset >= bytes.byteLength) return null;
              const end = Math.min(offset + maxBytes, bytes.byteLength);
              const slice = bytes.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      const blobHandle = await this.engine.blobOpenId(
        this.dbHandle,
        0,
        sqlOrHandle.blobId,
      );
      return buildBlobReadableStream(
        {
          readSegment: (maxBytes) =>
            this.engine.blobGetSegment!(blobHandle, maxBytes),
          close: async () => {
            await this.engine.blobClose!(blobHandle, false);
          },
        },
        opts,
      );
    }

    const { statement, options } = resolveQueryCall<BlobStreamOptions>(
      sqlOrHandle,
      paramsOrOptions,
      maybeOptions,
    );
    resolveBlobSegmentSize(options.segmentSize, false);

    let colIndex = 0;
    if (options.column !== undefined) {
      const desc = await this.describeQuery(statement.sql);
      colIndex = resolveBlobColumnIndex(
        options.column,
        desc.fields.map((f) => f.name),
      );
    }

    if (
      typeof this.engine.blobOpenQuery === 'function' &&
      typeof this.engine.blobGetSegment === 'function' &&
      typeof this.engine.blobClose === 'function'
    ) {
      const blobHandle = await this.engine.blobOpenQuery(
        this.dbHandle,
        0,
        statement.sql,
        this.serialize(statement.params),
        colIndex,
      );
      return buildBlobReadableStream(
        {
          readSegment: (maxBytes) =>
            this.engine.blobGetSegment!(blobHandle, maxBytes),
          close: async () => {
            await this.engine.blobClose!(blobHandle, false);
          },
        },
        options,
      );
    }

    const res = await this.query(statement.sql, statement.params, {
      rowMode: 'array',
    });
    if (res.rows.length === 0) {
      throw new Error('openBlobStream: query returned no rows');
    }
    const cell = res.rows[0]![colIndex];
    if (cell === null || cell === undefined) {
      throw new Error('openBlobStream: BLOB column value is NULL');
    }
    const bytes =
      cell instanceof Uint8Array
        ? cell
        : typeof cell === 'string'
          ? new TextEncoder().encode(cell)
          : new Uint8Array(0);
    let offset = 0;
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          if (offset >= bytes.byteLength) return null;
          const end = Math.min(offset + maxBytes, bytes.byteLength);
          const slice = bytes.slice(offset, end);
          offset = end;
          return slice;
        },
        close: async () => undefined,
      },
      options,
    );
  }

  async dumpDataDir(): Promise<Uint8Array> {
    await this.ensureReady();
    return this.engine.readFile(this.dbPath);
  }

  /**
   * Stream the live `.fdb` database file in fixed-size chunks
   * (`ReadableStream<Uint8Array>`) without allocating a single contiguous
   * `Uint8Array` of the entire database in memory.
   *
   * Pass `{ compression: 'gzip' }` to compress on the fly via
   * `CompressionStream('gzip')`.
   *
   * ```ts
   * const stream = db.dumpDataStream({ compression: 'gzip' });
   * ```
   */
  dumpDataStream(options: DataStreamOptions = {}): ReadableStream<Uint8Array> {
    const chunkSize = resolveStreamChunkSize(options.chunkSize);
    let offset = 0;
    let totalSize: number | null = null;
    let fallbackBytes: Uint8Array | null = null;

    const raw = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        await this.ensureReady();
        if (totalSize === null) {
          if (
            typeof this.engine.fileSize === 'function' &&
            typeof this.engine.readFileChunk === 'function'
          ) {
            totalSize = await this.engine.fileSize(this.dbPath);
          } else {
            fallbackBytes = await this.engine.readFile(this.dbPath);
            totalSize = fallbackBytes.byteLength;
          }
        }
        if (offset >= totalSize) {
          controller.close();
          return;
        }
        const length = Math.min(chunkSize, totalSize - offset);
        const chunk = fallbackBytes
          ? fallbackBytes.slice(offset, offset + length)
          : await this.engine.readFileChunk!(this.dbPath, offset, length);
        if (chunk.byteLength === 0) {
          controller.close();
          return;
        }
        offset += chunk.byteLength;
        controller.enqueue(chunk);
        if (offset >= totalSize) {
          controller.close();
        }
      },
    });

    return options.compression === 'gzip' ? compressGzipStream(raw) : raw;
  }

  /**
   * Replace the database with a raw or gzip-compressed `.fdb` byte stream
   * produced by {@link dumpDataStream} without buffering the entire database
   * in a single `Uint8Array`.
   *
   * ```ts
   * await db.loadDataStream(stream);
   * ```
   */
  async loadDataStream(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options: DataStreamOptions = {},
  ): Promise<void> {
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }
    await this.ensureReady();
    this.cancelScheduledPersist();

    for (const stmt of [...this.preparedStatements]) {
      await stmt.close().catch(() => undefined);
    }
    this.liveTriggerPromises.clear();

    if (this.dbHandle) {
      await this.engine.detachDatabase(this.dbHandle);
      this.dbHandle = 0;
    }

    await this.writeStreamToDbPath(stream, options);

    this.dbHandle = await this.engine.attachDatabase(this.dbPath);
    if (this.options.sharedReads) {
      await this.engine.setSharedReads!(this.dbHandle, true);
    }
    this.markDirty();
  }

  /**
   * Bulk-import CSV or JSONLines (`'jsonl'` / `'ndjson'`) records from a
   * `ReadableStream` or `AsyncIterable` into `tableName` in bounded-memory
   * batches of `options.batchSize` (default 500) inside a single transaction.
   */
  async copyFromStream(
    tableName: string,
    stream:
      | ReadableStream<Uint8Array | string>
      | AsyncIterable<Uint8Array | string>,
    options: CopyFromOptions = {},
  ): Promise<CopyResult> {
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    await this.ensureReady();
    return this.transaction((tx) =>
      tx.copyFromStream(tableName, stream, options),
    );
  }

  /**
   * Stream a table or `SELECT` query as UTF-8 CSV or JSONLines (`'jsonl'` /
   * `'ndjson'`) in bounded-memory cursor batches of `options.batchSize`
   * (default 500).
   */
  copyToStream(
    sql: SqlFragment,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string | SqlFragment,
    paramsOrOptions: QueryParams | CopyToOptions = [],
    maybeOptions: CopyToOptions = {},
  ): ReadableStream<Uint8Array> {
    return buildCopyToStream(this, tableOrQuery, paramsOrOptions, maybeOptions);
  }

  private async writeStreamToDbPath(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options: DataStreamOptions = {},
  ): Promise<void> {
    let offset = 0;
    let first = true;
    if (typeof this.engine.writeFileChunk === 'function') {
      for await (const chunk of readDatabaseStreamChunks(stream, options)) {
        await this.engine.writeFileChunk(this.dbPath, chunk, offset, first);
        first = false;
        offset += chunk.byteLength;
      }
    } else {
      const chunks: Uint8Array[] = [];
      for await (const chunk of readDatabaseStreamChunks(stream, options)) {
        chunks.push(chunk);
        offset += chunk.byteLength;
      }
      if (offset > 0) {
        const merged = new Uint8Array(offset);
        let pos = 0;
        for (const c of chunks) {
          merged.set(c, pos);
          pos += c.byteLength;
        }
        await this.engine.writeFile(this.dbPath, merged);
      }
    }
    if (offset === 0) {
      throw new RangeError(
        'loadDataStream received an empty stream; pass a stream from dumpDataStream()',
      );
    }
  }

  /**
   * Register an optional ICU `.dat` (or gzip-compressed `.dat.gz`) locale
   * tailoring bundle at runtime via a second `udata_setCommonData()` slot so
   * `CREATE COLLATION ... FOR UTF8 FROM UNICODE 'LOCALE=de_DE'` (`es_ES`,
   * `fr_FR`, `ja_JP`, etc.) can be used without increasing the default WASM
   * binary size.
   */
  async loadIcuLocaleData(data: Uint8Array | ArrayBufferLike): Promise<void> {
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }
    await this.ensureReady();
    await this.applyIcuLocaleData(data);
  }

  private async applyIcuLocaleData(data: Uint8Array | ArrayBufferLike): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.engine.loadIcuLocaleData) {
      await this.engine.loadIcuLocaleData(bytes);
      return;
    }
    if (!isValidIcuDataPackage(bytes)) {
      throw new Error(
        'Invalid ICU locale data package: expected an ICU CmnD (.dat) header (magic 0xda 0x27)',
      );
    }
    await this.engine.mkdir('/firebird');
    await this.engine.mkdir('/firebird/icu');
    await this.engine.writeFile(ICU_LOCALE_DATA_PATH, bytes);
  }

  async persist(): Promise<void> {
    if (!this.dbHandle || !this.mayPersist) return;

    // Two persists must not interleave: both read the image and write the
    // same store, and the later one could finish first and roll the database
    // back to an older state.
    if (this.persistInFlight) {
      this.persistAgain = true;
      await this.persistInFlight;
      return;
    }

    this.cancelScheduledPersist();

    const run = (async () => {
      const image = await this.engine.readFile(this.dbPath);
      await this.vfs.importDatabase(image);
    })();

    this.persistInFlight = run;
    try {
      await run;
    } finally {
      this.persistInFlight = null;
    }

    // Writes that arrived mid-persist are not covered by the image just
    // written, so go again.
    if (this.persistAgain) {
      this.persistAgain = false;
      await this.persist();
    }
  }

  /**
   * Close the database and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    // Stop scheduling before marking closed, so nothing fires mid-teardown.
    this.cancelScheduledPersist();
    this.detachLifecycleListeners();

    // A background persist may still be running; let it finish so it cannot
    // write after the engine has gone.
    if (this.persistInFlight) {
      try {
        await this.persistInFlight;
      } catch {
        // Already reported through onPersistError.
      }
    }

    // Before the handle goes: each one holds a subscription on it, and a
    // timer that would otherwise keep firing at a closed database.
    for (const stmt of [...this.preparedStatements]) {
      await stmt.close().catch(() => undefined);
    }
    for (const live of [...this.liveQueries]) {
      await live.unsubscribe().catch(() => undefined);
    }

    this.closed = true;
    this.liveTriggerPromises.clear();

    if (this.dbHandle) {
      // Persist before closing.
      await this.persist();
      await this.engine.detachDatabase(this.dbHandle);
      this.dbHandle = 0;
    }

    try {
      if (this.opfs) {
        // The mount owns the sync access handle and releases it with the
        // module; nothing here writes, because nothing was ever buffered.
      } else if (this.ephemeral) {
        // Reclaim it: the engine's filesystem outlives this instance — the
        // module is cached for the whole page — so a long-lived tab that
        // opened many scratch databases would hold every one of them.
        await this.engine.unlink(this.dbPath).catch(() => undefined);
      } else {
        await this.vfs.close();
      }
      await this.engine.dispose();
    } finally {
      // Last, and unconditionally: a lock still held after a failed teardown
      // locks the database out of every future tab until the page is gone.
      await this.releaseLock();
    }
  }

  /** Release the cross-tab lock, if this instance holds one. */
  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    await lock?.release();
  }

  // ── Automatic persistence ─────────────────────────────────────────────

  /**
   * Whether this tab may write the database image to IndexedDB.
   *
   * In shared mode only the leader may: a follower has no engine, and its
   * `readFile` would fetch the image across the channel only to race the
   * leader writing the same store — reintroducing the whole-image overwrite
   * that multi-tab safety exists to prevent.
   */
  private get mayPersist(): boolean {
    // Ephemeral first: there is nowhere to persist to, so persist() is a
    // no-op and markDirty() schedules nothing. A caller who writes code that
    // works for both kinds should not have to branch.
    //
    // OPFS for the opposite reason: the engine's writes already went to the
    // file, so there is nothing left to copy and a persist would be pure cost.
    if (this.ephemeral || this.opfs) return false;
    return this.shared === null || this.shared.isLeader;
  }

  /** Note that the database has changed and schedule a persist. */
  private markDirty(): void {
    if (!this.autoPersist || this.closed || !this.mayPersist) return;

    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistInBackground();
    }, this.autoPersistDebounceMs);
  }

  private cancelScheduledPersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /**
   * Persist without a caller to reject into.
   *
   * Failures are reported through `onPersistError`; letting them become
   * unhandled rejections would hide data loss.
   */
  private async persistInBackground(): Promise<void> {
    if (this.closed) return;
    try {
      await this.persist();
    } catch (err) {
      this.onPersistError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Flush when the page is being hidden or unloaded.
   *
   * `visibilitychange` to hidden is the event to rely on: it fires on mobile
   * when an app is backgrounded, where `beforeunload` and `unload` often do
   * not fire at all.  `pagehide` covers the bfcache case.  Neither can await
   * an async write, so this is best-effort — which is why writes are also
   * persisted on a debounce rather than only here.
   */
  private attachLifecycleListeners(): void {
    if (this.lifecycleAttached || !this.autoPersist) return;
    if (typeof document === 'undefined' || typeof addEventListener !== 'function') {
      return; // not a browser
    }

    this.lifecycleAttached = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    addEventListener('pagehide', this.onPageHide);
  }

  private detachLifecycleListeners(): void {
    if (!this.lifecycleAttached) return;
    this.lifecycleAttached = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    removeEventListener('pagehide', this.onPageHide);
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.cancelScheduledPersist();
      void this.persistInBackground();
    }
  };

  private readonly onPageHide = (): void => {
    this.cancelScheduledPersist();
    void this.persistInBackground();
  };

  // ── Initialisation ────────────────────────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (this.dbHandle) return;
    if (this.closed) {
      throw new Error('FirebirdBrowser instance has been closed');
    }

    // Prevent concurrent initialisation
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    await this.initPromise;
  }

  private async init(): Promise<void> {
    // Before anything reads the stored image.  A tab that loaded the database
    // and then waited for the lock would resume with a snapshot the departing
    // tab has since replaced — the very overwrite the lock prevents.
    if (this.multiTab === 'exclusive') {
      this.lock = await acquireDatabaseLock(this.dbName, {
        timeoutMs: this.lockTimeoutMs,
      });
    }
    // 'shared' deliberately takes no lock here: the transport's election holds
    // it, and a second request from the same tab would queue behind itself.

    try {
      await this.engine.init();
      if (this.options.icuLocaleData) {
        const localeBytes =
          typeof this.options.icuLocaleData === 'function'
            ? await this.options.icuLocaleData()
            : this.options.icuLocaleData;
        await this.applyIcuLocaleData(localeBytes);
      }
      if (this.opfs) {
        // The mount both opens the file and decides where it lives, so the path
        // comes back rather than being assumed on this side.
        this.opfsPath = await this.engine.mountOpfs(this.fileName);
      } else if (!this.ephemeral) {
        // An ephemeral database never touches IndexedDB, so the store is not
        // opened at all — opening it would create an empty one on disk for a
        // database whose whole point is leaving nothing behind.
        await this.vfs.open(this.dbName);
      }
      await this.openDatabase();
    } catch (err) {
      // An instance that failed to open never opens: every later call
      // rethrows this.  Holding the name past that would keep a fresh
      // instance, in this page or another tab, from trying again.
      await this.releaseLock();
      throw err;
    }
    this.attachLifecycleListeners();
  }

  /**
   * Restore the stored image if this tab owns the engine, then attach.
   *
   * Separate from init() because it has to run again whenever the engine
   * changes underneath us — in shared mode a leadership change replaces the
   * engine, and every handle it issued dies with it.
   *
   * The restore is guarded by {@link mayPersist} for the same reason
   * persistence is: a follower writing its IndexedDB snapshot into the
   * filesystem would be overwriting the leader's *live* database with a
   * possibly older image.
   */
  private async openDatabase(): Promise<void> {
    await this.engine.mkdir('/data');

    if (this.mayPersist) {
      const stored = await this.vfs.exportDatabase();
      if (stored.byteLength > 0) {
        await this.engine.writeFile(this.dbPath, stored);
      }
    }

    // After the stored image, never before it: `loadDataDir` is what to start
    // from when there is nothing, not what to overwrite with.
    const seed = this.options.loadDataDir;
    if (seed && !(await this.engine.exists(this.dbPath))) {
      if (seed.byteLength === 0) {
        throw new RangeError(
          'loadDataDir is empty; pass the bytes from dumpDataDir() or omit it',
        );
      }
      await this.engine.writeFile(this.dbPath, seed);
    }

    const seedStreamOpt = this.options.loadDataStream;
    if (seedStreamOpt && !(await this.engine.exists(this.dbPath))) {
      const seedStream =
        typeof seedStreamOpt === 'function'
          ? await seedStreamOpt()
          : seedStreamOpt;
      await this.writeStreamToDbPath(seedStream);
    }

    // Works unchanged for OPFS: that filesystem reports a file as existing
    // only once it has bytes, so a database that has never been written is
    // absent here rather than present and empty.
    this.dbHandle = (await this.engine.exists(this.dbPath))
      ? await this.engine.attachDatabase(this.dbPath)
      : await this.engine.createDatabase(this.dbPath);

    // On every open, so a tab re-attaching after a leadership change gets it
    // again: the switch belongs to the handle, which the old engine took with it.
    if (this.options.sharedReads) {
      await this.engine.setSharedReads!(this.dbHandle, true);
    }
  }

  /**
   * The engine behind this connection was replaced; attach to the new one.
   *
   * Called on every tab after a leadership change, promoted or not. Silence
   * here would leave the caller holding a handle from an engine that no longer
   * exists, and writes through it would go nowhere — visibly succeeding.
   */
  private async reopenAfterEngineChange(): Promise<void> {
    if (this.closed) return;
    this.dbHandle = 0;
    try {
      await this.openDatabase();
    } catch (err) {
      this.onPersistError(
        err instanceof Error
          ? err
          : new Error(`could not reopen after a leadership change: ${String(err)}`),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Transaction handle
// ---------------------------------------------------------------------------

const SAVEPOINT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function validateSavepointName(name: string): string {
  if (typeof name !== 'string' || !SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid savepoint name "${String(name)}": must be a valid SQL identifier (1-63 ASCII letters, digits, '_', or '$', starting with a letter or '_')`,
    );
  }
  return name;
}

/**
 * A handle to an active transaction (or nested savepoint) in the browser WASM engine.
 *
 * Statements issued here are bound to the transaction handle, so a rollback
 * really does undo them.
 */
export class FirebirdBrowserTransaction {
  private finished = false;
  private readonly nextSavepointId: () => number;

  constructor(
    private readonly engine: EngineTransport,
    private readonly dbHandle: EngineHandle,
    private readonly txHandle: EngineHandle,
    private readonly types?: TypeOptions,
    readonly savepointName?: string,
    private readonly parent?: FirebirdBrowserTransaction,
    nextSavepointId?: () => number,
  ) {
    if (nextSavepointId) {
      this.nextSavepointId = nextSavepointId;
    } else {
      let counter = 0;
      this.nextSavepointId = () => {
        counter += 1;
        return counter;
      };
    }
  }

  /** Whether this transaction (or savepoint) has already finished or been rolled back. */
  get isFinished(): boolean {
    return this.finished || (this.parent ? this.parent.isFinished : false);
  }

  private markFinished(): void {
    this.finished = true;
  }

  /**
   * Roll this transaction (or savepoint) back and stop.
   *
   * When called on the root transaction, the enclosing `transaction()` will not
   * commit afterwards. When called on a savepoint handle inside `tx.savepoint()`,
   * only the work since the savepoint is undone (`ROLLBACK TO SAVEPOINT` +
   * `RELEASE SAVEPOINT ... ONLY`) and the enclosing transaction remains active.
   */
  async rollback(): Promise<void> {
    if (this.isFinished) return;
    this.finished = true;
    if (this.savepointName) {
      await this.engine.execute(
        this.dbHandle,
        this.txHandle,
        `ROLLBACK TO SAVEPOINT ${this.savepointName}`,
        [],
      );
      await this.engine.execute(
        this.dbHandle,
        this.txHandle,
        `RELEASE SAVEPOINT ${this.savepointName} ONLY`,
        [],
      );
      return;
    }
    await this.engine.rollback(this.txHandle);
  }

  private assertUsable(): void {
    if (this.isFinished) {
      throw new Error(
        this.savepointName
          ? `Savepoint "${this.savepointName}" has already finished`
          : 'Transaction has already been rolled back',
      );
    }
  }

  /**
   * Run `fn` inside a SQL `SAVEPOINT` within this transaction.
   *
   * - If `fn` resolves (and `sp.rollback()` was not called), the savepoint is
   *   released via `RELEASE SAVEPOINT <name> ONLY`.
   * - If `fn` throws an error, the work inside the savepoint is undone via
   *   `ROLLBACK TO SAVEPOINT <name>` + `RELEASE SAVEPOINT <name> ONLY` and the
   *   error is re-thrown while the outer transaction stays active.
   * - If `await sp.rollback()` is called inside `fn`, the savepoint is rolled
   *   back and released without throwing, and `fn`'s return value is returned.
   * - Savepoints can be nested arbitrarily; when `name` is omitted, unique
   *   names (`sp_1`, `sp_2`, ...) are generated automatically.
   */
  savepoint<T>(fn: (sp: FirebirdBrowserTransaction) => Promise<T>): Promise<T>;
  savepoint<T>(
    name: string,
    fn: (sp: FirebirdBrowserTransaction) => Promise<T>,
  ): Promise<T>;
  async savepoint<T>(
    nameOrFn: string | ((sp: FirebirdBrowserTransaction) => Promise<T>),
    maybeFn?: (sp: FirebirdBrowserTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    const name =
      typeof nameOrFn === 'string'
        ? validateSavepointName(nameOrFn)
        : `sp_${this.nextSavepointId()}`;
    const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn;
    if (typeof fn !== 'function') {
      throw new TypeError('savepoint requires a callback function');
    }

    await this.engine.execute(
      this.dbHandle,
      this.txHandle,
      `SAVEPOINT ${name}`,
      [],
    );

    const sp = new FirebirdBrowserTransaction(
      this.engine,
      this.dbHandle,
      this.txHandle,
      this.types,
      name,
      this,
      this.nextSavepointId,
    );

    let result: T;
    try {
      result = await fn(sp);
    } catch (err) {
      if (!sp.isFinished) {
        sp.markFinished();
        await this.engine
          .execute(
            this.dbHandle,
            this.txHandle,
            `ROLLBACK TO SAVEPOINT ${name}`,
            [],
          )
          .catch(() => undefined);
        await this.engine
          .execute(
            this.dbHandle,
            this.txHandle,
            `RELEASE SAVEPOINT ${name} ONLY`,
            [],
          )
          .catch(() => undefined);
      }
      throw err;
    }

    if (!sp.isFinished) {
      sp.markFinished();
      await this.engine.execute(
        this.dbHandle,
        this.txHandle,
        `RELEASE SAVEPOINT ${name} ONLY`,
        [],
      );
    }

    return result;
  }

  /**
   * Cancel the currently running statement on this transaction's database
   * attachment via `IAttachment::cancelOperation(status, fb_cancel_raise)`.
   */
  async cancelOperation(): Promise<void> {
    if (typeof this.engine.cancelOperation === 'function') {
      await this.engine.cancelOperation(this.dbHandle);
    }
  }

  private async applyOneShotTimeout(timeoutMs?: number): Promise<void> {
    const validated = validateTimeoutMs(timeoutMs);
    if (
      validated !== undefined &&
      validated > 0 &&
      typeof this.engine.stmtSetTimeout === 'function'
    ) {
      await this.engine.stmtSetTimeout(0, validated);
    }
  }

  /**
   * Execute a DDL/DML statement inside this transaction.
   *
   * @returns the number of rows affected.
   */
  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ExecResult> {
    this.assertUsable();
    const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
    const options = Array.isArray(paramsOrOptions)
      ? maybeOptions
      : (paramsOrOptions ?? {});
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    const statement = toStatement(sql, params);
    const affectedRows = await runWithCancellation(
      async () => {
        await this.applyOneShotTimeout(options.timeoutMs);
        return this.engine.execute(
          this.dbHandle,
          this.txHandle,
          statement.sql,
          applySerializers(statement.params, this.types?.serializers),
        );
      },
      options,
      () => this.cancelOperation(),
    );
    return { affectedRows };
  }

  /**
   * Execute one statement once per row of parameters inside this
   * transaction: prepared once, executed per row.  The rows before a failure
   * stay, as statements run one by one would; the transaction decides.
   *
   * @returns the rows affected over the whole batch.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<ExecResult> {
    this.assertUsable();
    if (!Array.isArray(rows)) {
      throw new TypeError('execBatch takes an array of parameter rows');
    }
    const affectedRows = await this.engine.executeBatch(
      this.dbHandle,
      this.txHandle,
      sql,
      rows.map((row) => applySerializers(row, this.types?.serializers)),
    );
    return { affectedRows };
  }

  /** Execute a SELECT inside this transaction and return rows. */
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode } & StatementExecutionOptions,
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: { rowMode?: RowMode } & StatementExecutionOptions = {},
  ): Promise<QueryResult<T>> {
    this.assertUsable();
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    const statement = toStatement(sql, params);
    const rowMode = options.rowMode ?? 'object';
    const raw = await runWithCancellation(
      async () => {
        await this.applyOneShotTimeout(options.timeoutMs);
        return this.engine.query<T>(
          this.dbHandle,
          this.txHandle,
          statement.sql,
          applySerializers(statement.params, this.types?.serializers),
          rowMode,
          this.types?.binary === true,
        );
      },
      options,
      () => this.cancelOperation(),
    );
    return applyTypes(raw, this.types, rowMode);
  }

  /**
   * Return Firebird's execution plan for `sql` (`IStatement::getPlan`) inside
   * this transaction without executing the statement.
   */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    this.assertUsable();
    if (typeof this.engine.explain !== 'function') {
      throw new Error('The configured EngineTransport does not support explain()');
    }
    return this.engine.explain(
      this.dbHandle,
      this.txHandle,
      toStatement(sql).sql,
      options.detailed === true,
    );
  }

  /**
   * Prepare a SQL statement inside this transaction and return a reusable
   * {@link PreparedStatement} handle.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    this.assertUsable();
    const sqlText = toStatement(sql).sql;
    const desc: QueryDescription & { handle?: EngineHandle } =
      typeof this.engine.prepare === 'function'
        ? await this.engine.prepare(this.dbHandle, this.txHandle, sqlText)
        : await this.engine.describe(this.dbHandle, this.txHandle, sqlText);

    const params = desc.params.map((p) => ({ ...p }));
    const fields = desc.fields.map((f) => ({ ...f }));
    const stmtHandle = desc.handle ?? 0;
    let isClosed = false;
    let currentTimeoutMs = 0;

    const assertOpen = (): void => {
      if (isClosed) {
        throw new Error('PreparedStatement has been closed');
      }
      this.assertUsable();
    };

    const checkParamCount = (actual: number): void => {
      if (actual !== params.length) {
        throw new Error(
          `PreparedStatement expects ${params.length} parameter(s) but ${actual} were supplied`,
        );
      }
    };

    const isTxFinished = () => this.isFinished;

    const stmt: PreparedStatement = {
      sql: sqlText,
      get params() {
        return params.map((p) => ({ ...p }));
      },
      get fields() {
        return fields.map((f) => ({ ...f }));
      },
      statementType: desc.statementType,
      hasResultSet: desc.hasResultSet,
      get closed() {
        return isClosed || isTxFinished();
      },
      get timeoutMs() {
        return currentTimeoutMs;
      },
      setTimeout: async (timeoutMs: number) => {
        assertOpen();
        const validated = validateTimeoutMs(timeoutMs) ?? 0;
        currentTimeoutMs = validated;
        if (stmtHandle > 0 && typeof this.engine.stmtSetTimeout === 'function') {
          await this.engine.stmtSetTimeout(stmtHandle, validated);
        }
      },
      query: (async (
        paramsOrOptions: QueryParams | QueryOptions = [],
        maybeOptions: QueryOptions = {},
      ) => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const rawOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        const callOptions: QueryOptions =
          rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...rawOptions, timeoutMs: currentTimeoutMs }
            : rawOptions;
        checkParamCount(callParams.length);
        if (stmtHandle > 0 && typeof this.engine.queryStmt === 'function') {
          assertNotAborted(callOptions.signal);
          validateTimeoutMs(callOptions.timeoutMs);
          const rowMode = callOptions.rowMode ?? 'object';
          const raw = await runWithCancellation(
            async () => {
              await this.applyOneShotTimeout(callOptions.timeoutMs);
              return this.engine.queryStmt!(
                this.dbHandle,
                this.txHandle,
                stmtHandle,
                applySerializers(callParams, this.types?.serializers),
                rowMode,
                this.types?.binary === true,
              );
            },
            callOptions,
            () => this.cancelOperation(),
          );
          return applyTypes(raw, this.types, rowMode);
        }
        return this.query(sqlText, callParams, {
          rowMode: callOptions.rowMode,
          signal: callOptions.signal,
          timeoutMs: callOptions.timeoutMs,
        });
      }) as PreparedStatement['query'],
      queryStream: ((
        paramsOrOptions: QueryParams | QueryStreamOptions = [],
        maybeOptions: QueryStreamOptions = {},
      ) => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const rawOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        const callOptions: QueryStreamOptions =
          rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...rawOptions, timeoutMs: currentTimeoutMs }
            : rawOptions;
        checkParamCount(callParams.length);
        validateTimeoutMs(callOptions.timeoutMs);
        const batchSize = resolveBatchSize(callOptions.batchSize);
        const openStream = () =>
          stmtHandle > 0
            ? this.streamQuery(
                { sql: sqlText, params: callParams },
                callOptions.rowMode ?? 'object',
                batchSize,
                stmtHandle,
                callOptions,
              )
            : this.queryStream(sqlText, callParams, {
                rowMode: callOptions.rowMode,
                batchSize: callOptions.batchSize,
                signal: callOptions.signal,
                timeoutMs: callOptions.timeoutMs,
              });
        return (async function* () {
          assertOpen();
          yield* openStream();
        })();
      }) as PreparedStatement['queryStream'],
      exec: async (
        callParams: QueryParams = [],
        execOptions: StatementExecutionOptions = {},
      ) => {
        assertOpen();
        checkParamCount(callParams.length);
        const effectiveOptions: StatementExecutionOptions =
          execOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...execOptions, timeoutMs: currentTimeoutMs }
            : execOptions;
        if (stmtHandle > 0 && typeof this.engine.executeStmt === 'function') {
          assertNotAborted(effectiveOptions.signal);
          validateTimeoutMs(effectiveOptions.timeoutMs);
          const affectedRows = await runWithCancellation(
            async () => {
              await this.applyOneShotTimeout(effectiveOptions.timeoutMs);
              return this.engine.executeStmt!(
                this.dbHandle,
                this.txHandle,
                stmtHandle,
                applySerializers(callParams, this.types?.serializers),
              );
            },
            effectiveOptions,
            () => this.cancelOperation(),
          );
          return { affectedRows };
        }
        return this.exec(sqlText, callParams, effectiveOptions);
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        if (!Array.isArray(rows)) {
          throw new TypeError('execBatch takes an array of parameter rows');
        }
        for (const row of rows) {
          checkParamCount(row.length);
        }
        if (
          stmtHandle > 0 &&
          typeof this.engine.executeBatchStmt === 'function'
        ) {
          const affectedRows = await this.engine.executeBatchStmt(
            this.dbHandle,
            this.txHandle,
            stmtHandle,
            rows.map((row) => applySerializers(row, this.types?.serializers)),
          );
          return { affectedRows };
        }
        return this.execBatch(sqlText, rows);
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        if (stmtHandle > 0 && typeof this.engine.stmtClose === 'function') {
          await this.engine.stmtClose(stmtHandle).catch(() => undefined);
        }
      },
      [Symbol.asyncDispose]: async () => {
        await stmt.close();
      },
    };

    return stmt;
  }

  /**
   * Describe a statement's shape inside this transaction without running it.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    this.assertUsable();
    return this.engine.describe(this.dbHandle, this.txHandle, toStatement(sql).sql);
  }

  /**
   * Bulk-import CSV or JSONLines (`'jsonl'` / `'ndjson'`) records from a
   * `ReadableStream` or `AsyncIterable` into `tableName` inside this transaction.
   */
  async copyFromStream(
    tableName: string,
    stream:
      | ReadableStream<Uint8Array | string>
      | AsyncIterable<Uint8Array | string>,
    options: CopyFromOptions = {},
  ): Promise<CopyResult> {
    this.assertUsable();
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    return executeCopyFromStream(this, tableName, stream, options);
  }

  /**
   * Stream a table or `SELECT` query inside this transaction as UTF-8 CSV or
   * JSONLines (`'jsonl'` / `'ndjson'`).
   */
  copyToStream(
    sql: SqlFragment,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string | SqlFragment,
    paramsOrOptions: QueryParams | CopyToOptions = [],
    maybeOptions: CopyToOptions = {},
  ): ReadableStream<Uint8Array> {
    this.assertUsable();
    return buildCopyToStream(this, tableOrQuery, paramsOrOptions, maybeOptions);
  }

  /**
   * Create a segmented writable BLOB stream (`WritableStream<Uint8Array>`)
   * inside this transaction backed by Firebird `IBlob::putSegment`.
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    this.assertUsable();
    resolveBlobSegmentSize(options.segmentSize, true);

    if (
      typeof this.engine.blobCreate === 'function' &&
      typeof this.engine.blobPutSegment === 'function' &&
      typeof this.engine.blobClose === 'function'
    ) {
      const { blobHandle, blobId } = await this.engine.blobCreate(
        this.dbHandle,
        this.txHandle,
      );
      return buildBlobWritableStream(
        {
          writeSegment: async (segment) => {
            this.assertUsable();
            await this.engine.blobPutSegment!(blobHandle, segment);
          },
          close: async (totalBytes) => {
            this.assertUsable();
            const finalId = await this.engine.blobClose!(blobHandle, false);
            return createBlobHandle(
              finalId.byteLength === 8 ? finalId : blobId,
              totalBytes,
            );
          },
          abort: async () => {
            if (!this.finished) {
              await this.engine
                .blobClose!(blobHandle, true)
                .catch(() => undefined);
            }
          },
        },
        options,
      );
    }

    const chunks: Uint8Array[] = [];
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          this.assertUsable();
          chunks.push(segment.slice());
        },
        close: async (totalBytes) => {
          this.assertUsable();
          const stagedBytes = new Uint8Array(totalBytes);
          let pos = 0;
          for (const c of chunks) {
            stagedBytes.set(c, pos);
            pos += c.byteLength;
          }
          return createBlobHandle(new Uint8Array(8), totalBytes, {
            stagedBytes,
          });
        },
        abort: async () => {
          chunks.length = 0;
        },
      },
      options,
    );
  }

  /**
   * Open a Firebird `BLOB` column (from a `SELECT` query or a {@link BlobHandle})
   * inside this transaction as a segmented Web `ReadableStream<Uint8Array>`
   * backed by `IBlob::getSegment`.
   */
  async openBlobStream(
    handle: BlobHandle,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: SqlFragment,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: string | SqlFragment,
    params?: QueryParams | BlobStreamOptions,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions: QueryParams | BlobStreamOptions = [],
    maybeOptions: BlobStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertUsable();

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
    const stagingId = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      const staged = stagingId;
      if (staged || typeof this.engine.blobOpenId !== 'function') {
        const bytes = staged ?? new Uint8Array(0);
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              this.assertUsable();
              if (offset >= bytes.byteLength) return null;
              const end = Math.min(offset + maxBytes, bytes.byteLength);
              const slice = bytes.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      const blobHandle = await this.engine.blobOpenId(
        this.dbHandle,
        this.txHandle,
        sqlOrHandle.blobId,
      );
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            this.assertUsable();
            return this.engine.blobGetSegment!(blobHandle, maxBytes);
          },
          close: async () => {
            if (!this.finished) {
              await this.engine.blobClose!(blobHandle, false);
            }
          },
        },
        opts,
      );
    }

    const { statement, options } = resolveQueryCall<BlobStreamOptions>(
      sqlOrHandle,
      paramsOrOptions,
      maybeOptions,
    );
    resolveBlobSegmentSize(options.segmentSize, false);

    let colIndex = 0;
    if (options.column !== undefined) {
      const desc = await this.describeQuery(statement.sql);
      colIndex = resolveBlobColumnIndex(
        options.column,
        desc.fields.map((f) => f.name),
      );
    }

    if (
      typeof this.engine.blobOpenQuery === 'function' &&
      typeof this.engine.blobGetSegment === 'function' &&
      typeof this.engine.blobClose === 'function'
    ) {
      const blobHandle = await this.engine.blobOpenQuery(
        this.dbHandle,
        this.txHandle,
        statement.sql,
        applySerializers(statement.params, this.types?.serializers),
        colIndex,
      );
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            this.assertUsable();
            return this.engine.blobGetSegment!(blobHandle, maxBytes);
          },
          close: async () => {
            if (!this.finished) {
              await this.engine.blobClose!(blobHandle, false);
            }
          },
        },
        options,
      );
    }

    const res = await this.query(statement.sql, statement.params, {
      rowMode: 'array',
    });
    if (res.rows.length === 0) {
      throw new Error('openBlobStream: query returned no rows');
    }
    const cell = res.rows[0]![colIndex];
    if (cell === null || cell === undefined) {
      throw new Error('openBlobStream: BLOB column value is NULL');
    }
    const bytes =
      cell instanceof Uint8Array
        ? cell
        : typeof cell === 'string'
          ? new TextEncoder().encode(cell)
          : new Uint8Array(0);
    let offset = 0;
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          this.assertUsable();
          if (offset >= bytes.byteLength) return null;
          const end = Math.min(offset + maxBytes, bytes.byteLength);
          const slice = bytes.slice(offset, end);
          offset = end;
          return slice;
        },
        close: async () => undefined,
      },
      options,
    );
  }

  /** Stream a SELECT inside this transaction in batches of `batchSize` rows. */
  queryStream(
    sql: SqlFragment,
    options: { rowMode: 'array'; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: { rowMode: 'array'; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    sql: SqlFragment,
    options?: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | ({ rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions) = [],
    maybeOptions: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    const { statement, options } = resolveQueryCall<
      { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions
    >(sql, paramsOrOptions, maybeOptions);
    validateTimeoutMs(options.timeoutMs);
    const batchSize = resolveBatchSize(options.batchSize);
    return this.streamQuery<T>(
      statement,
      options.rowMode ?? 'object',
      batchSize,
      undefined,
      options,
    );
  }

  private async *streamQuery<T>(
    statement: Statement,
    rowMode: RowMode,
    batchSize: number,
    stmtHandle?: EngineHandle,
    execOptions: StatementExecutionOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    assertNotAborted(execOptions.signal);
    const totalTimeoutMs = validateTimeoutMs(execOptions.timeoutMs);
    const deadline =
      totalTimeoutMs && totalTimeoutMs > 0
        ? Date.now() + totalTimeoutMs
        : undefined;
    const stepOptions = (): StatementExecutionOptions => ({
      signal: execOptions.signal,
      timeoutMs:
        deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined,
    });

    if (
      typeof this.engine.cursorOpen !== 'function' ||
      typeof this.engine.cursorFetch !== 'function' ||
      typeof this.engine.cursorClose !== 'function'
    ) {
      const full = (await this.query(statement.sql, statement.params, {
        rowMode,
        signal: execOptions.signal,
        timeoutMs: execOptions.timeoutMs,
      })) as QueryResult<T>;
      for (let i = 0; i < full.rows.length; i += batchSize) {
        assertNotAborted(execOptions.signal);
        if (deadline !== undefined && Date.now() >= deadline) {
          throw createTimeoutError(totalTimeoutMs!);
        }
        yield {
          rows: full.rows.slice(i, i + batchSize),
          fields: full.fields.map((f) => ({ ...f })),
        };
      }
      return;
    }

    const binaryBlobs = this.types?.binary === true;
    const serialized = applySerializers(statement.params, this.types?.serializers);
    let cursorHandle = await runWithCancellation(
      async () => {
        await this.applyOneShotTimeout(totalTimeoutMs);
        return stmtHandle &&
          stmtHandle > 0 &&
          typeof this.engine.cursorOpenStmt === 'function'
          ? this.engine.cursorOpenStmt(
              this.dbHandle,
              this.txHandle,
              stmtHandle,
              serialized,
            )
          : this.engine.cursorOpen!(
              this.dbHandle,
              this.txHandle,
              statement.sql,
              serialized,
            );
      },
      stepOptions(),
      () => this.cancelOperation(),
    );

    try {
      while (true) {
        this.assertUsable();
        assertNotAborted(execOptions.signal);
        if (deadline !== undefined && Date.now() >= deadline) {
          throw createTimeoutError(totalTimeoutMs!);
        }
        const batch = await runWithCancellation(
          () =>
            this.engine.cursorFetch!<T>(
              cursorHandle,
              batchSize,
              rowMode,
              binaryBlobs,
            ),
          stepOptions(),
          () => this.cancelOperation(),
        );
        if (batch.rows.length === 0) {
          break;
        }
        yield applyTypes(batch, this.types, rowMode);
      }

      const toClose = cursorHandle;
      cursorHandle = 0;
      if (!this.isFinished) {
        await this.engine.cursorClose(toClose);
      }
    } finally {
      if (cursorHandle !== 0) {
        await this.engine.cursorClose(cursorHandle).catch(() => undefined);
      }
    }
  }
}
