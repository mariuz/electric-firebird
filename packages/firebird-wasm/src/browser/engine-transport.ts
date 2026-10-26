/**
 * engine-transport.ts – the boundary between `FirebirdBrowser` and the engine.
 *
 * There are two ways to reach the compiled engine, and they differ enough to
 * be worth naming:
 *
 *   • {@link DirectTransport} calls the WASM exports in this thread.  Simple,
 *     and what Node uses.
 *   • {@link WorkerTransport} (see `worker-transport.ts`) forwards to a Web
 *     Worker.  Browsers *must* use it: the build uses pthreads, Firebird
 *     blocks on mutexes while opening a database, and a browser main thread is
 *     not allowed to block — calling the engine directly from a page deadlocks.
 *
 * Both sides of that split need the same operations, including filesystem
 * access: persistence copies the database between Emscripten's in-memory FS
 * and IndexedDB, and in the Worker case that filesystem lives in the Worker.
 *
 * Every method is async so the two are interchangeable, even though the direct
 * one never actually suspends.
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import { acquireFirebirdWasm, releaseFirebirdWasm, allocString, lastError } from '../wasm-loader';
import type {
  Row,
  QueryResult,
  QueryDescription,
  DatabaseInfo,
  FieldInfo,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';
import { isolationCode } from './isolation';
import { encodeParams, encodeParamRows } from './params';
import { firebirdTypeName } from './field-types';
import { statementKind } from '../statement-types';
import { extractReferencedTables } from './live-tables';
import { applyIcuLocaleDataToModule } from './icu-locales';
import {
  mountOpfs as mountOpfsFilesystem,
  openDatabaseHandle,
  opfsAvailable,
} from './opfs-fs';

/** Where an OPFS-backed database is mounted inside the engine's filesystem. */
export const OPFS_MOUNT = '/opfs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque engine handle (database or transaction). 0 means "none". */
export type EngineHandle = number;

/**
 * The operations `FirebirdBrowser` needs from the engine, wherever it runs.
 *
 * `txHandle` of 0 means "run this statement in its own transaction", matching
 * the C API.
 */
export interface EngineTransport {
  /** Initialise the engine.  Safe to call more than once. */
  init(): Promise<void>;
  /**
   * Register an optional ICU `.dat` (or `.dat.gz`) locale tailoring bundle
   * (e.g., for `LOCALE=de_DE`, `es_ES`, `fr_FR`, `ja_JP`) in a second
   * `udata_setCommonData()` slot without increasing the default WASM binary
   * size.
   */
  loadIcuLocaleData?(data: Uint8Array): Promise<void>;

  createDatabase(path: string): Promise<EngineHandle>;
  attachDatabase(path: string): Promise<EngineHandle>;
  detachDatabase(dbHandle: EngineHandle): Promise<void>;

  /** Returns the number of rows the statement affected. */
  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
  ): Promise<number>;
  /**
   * Execute one statement once per row of parameters, prepared once: a
   * batch.  With no transaction the rows are all or nothing.  Returns the
   * rows affected over the batch.
   */
  executeBatch(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    rows: QueryParams[],
  ): Promise<number>;
  query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
    rowMode?: RowMode,
    binaryBlobs?: boolean,
  ): Promise<QueryResult<T>>;
  /**
   * Open a streaming cursor for `sql` (with optional `params`).
   * With `txHandle` of 0 the cursor runs in its own transaction, committed by
   * {@link EngineTransport.cursorClose}.
   */
  cursorOpen?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams,
  ): Promise<EngineHandle>;
  /**
   * Fetch up to `batchSize` rows from an open cursor.
   * An empty `rows` array signals end-of-cursor.
   */
  cursorFetch?<T = Row>(
    cursorHandle: EngineHandle,
    batchSize: number,
    rowMode?: RowMode,
    binaryBlobs?: boolean,
  ): Promise<QueryResult<T>>;
  /** Close an open cursor and finish any transaction it started for itself. */
  cursorClose?(cursorHandle: EngineHandle): Promise<void>;
  /**
   * Run this database's autocommit SELECTs in a read-only transaction it
   * keeps open (`true`), or each in one of its own (`false`, the default).
   * Optional, so a transport written before it still type-checks;
   * `FirebirdBrowser` refuses `sharedReads` on one without it.
   */
  setSharedReads?(dbHandle: EngineHandle, on: boolean): Promise<void>;
  /** Describe a statement's shape without executing it. */
  /** Return the execution plan for `sql` (`IStatement::getPlan`) without executing it. */
  /** Return database storage, ODS, memory pool, I/O, and OIT/OAT/OST transaction health diagnostics. */
  databaseInfo?(dbHandle: EngineHandle): Promise<DatabaseInfo>;
  prepare?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription & { handle?: EngineHandle }>;
  stmtClose?(stmtHandle: EngineHandle): Promise<void>;
  explain?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    detailed?: boolean,
  ): Promise<string>;
  describe(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription>;

  /**
   * Begin a transaction.
   *
   * `options` is honoured, not accepted and dropped: the Node backend has
   * always applied isolationLevel and readOnly, and a browser caller
   * writing the same code deserves the same transaction.
   */
  startTransaction(
    dbHandle: EngineHandle,
    options?: TransactionOptions,
  ): Promise<EngineHandle>;
  commit(txHandle: EngineHandle): Promise<void>;
  rollback(txHandle: EngineHandle): Promise<void>;

  // ── Filesystem, for the IndexedDB persistence layer ────────────────────
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Return the byte size of `path` (0 when absent) without reading its contents. */
  fileSize?(path: string): Promise<number>;
  /** Read at most `length` bytes from `path` starting at byte `offset`. */
  readFileChunk?(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Write `data` into `path` at byte `offset`, optionally truncating the file to 0 first. */
  writeFileChunk?(
    path: string,
    data: Uint8Array,
    offset: number,
    truncate?: boolean,
  ): Promise<void>;
  /** Remove a file.  Used to discard an ephemeral database on close. */
  unlink(path: string): Promise<void>;
  /** Subscribe to named events; returns a subscription handle. */
  eventsSubscribe(dbHandle: EngineHandle, names: string[]): Promise<number>;
  /**
   * Counts that have arrived since the last poll, keyed by event name.
   *
   * Empty when nothing fired, which is the common case. Polling re-arms the
   * subscription, so it has to keep being called for delivery to continue.
   */
  eventsPoll(subscription: number): Promise<Record<string, number>>;
  /** Cancel a subscription. */
  eventsCancel(subscription: number): Promise<void>;
  /**
   * Mount an OPFS-backed filesystem holding one database, and return the path
   * the engine should open.
   *
   * Runs wherever the engine runs: the sync access handle is opened on that
   * side and never crosses a boundary, because it is neither cloneable nor
   * transferable.
   */
  mountOpfs(dbName: string): Promise<string>;

  /** Release anything the transport owns.  Does not detach databases. */
  dispose(): Promise<void>;
}

/** Options accepted by {@link DirectTransport}. */
export interface DirectTransportOptions {
  wasmBinary?: ArrayBuffer | string;
  locateFile?: (filename: string) => string;
  /** Which build to load; see {@link import('../wasm-loader').WasmLoadOptions.threads}. */
  threads?: boolean | 'auto';
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build an Error carrying whatever the engine reported.
 *
 * The C API returns only a numeric code; the readable Firebird message lives
 * behind `_fb_last_error()` and is lost unless it is read immediately, before
 * another call overwrites it.
 */
function engineError(
  mod: FirebirdWasmModule,
  context: string,
  code?: number,
): Error {
  const detail = lastError(mod);
  const suffix = code === undefined ? '' : ` (code ${code})`;
  return new Error(detail ? `${context}${suffix}: ${detail}` : `${context}${suffix}`);
}

/** How the engine describes one column. */
interface EncodedColumn {
  name: string;
  type: number;
  subType: number;
  scale: number;
  length: number;
  nullable: boolean;
}

// ---------------------------------------------------------------------------
// Column descriptions
// ---------------------------------------------------------------------------

/**
 * Decoded field lists by the text of their columns' JSON.
 *
 * A kept statement describes the same columns on every call, in the same
 * bytes, so the description is parsed and turned into `FieldInfo`s once
 * (bench/call-cost.js measured the decode of ten columns' description at
 * about 7 µs a call). Bounded like `rowBuilders`, and for the same reason.
 */
const fieldLists = new Map<string, readonly FieldInfo[]>();
const MAX_FIELD_LISTS = 256;

const COLUMNS_PREFIX = '{"columns":';
const SHAPE_PREFIX = '{"shape":';
const ROWS_KEY = ',"rows":';
const ROWS_INFIX = '],"rows":';

/**
 * Split the engine's `{"columns":[…],"rows":[…]}` into its two parts,
 * parsing the rows and taking the columns from the cache when it has them.
 *
 * The first `],"rows":` is the boundary: it cannot occur inside a column
 * name, where every `"` is escaped. Anything else is parsed whole.
 */
function splitResultSet(
  json: string,
  shapes?: (id: number) => readonly FieldInfo[],
): { columns: readonly FieldInfo[]; rows: unknown[][] } {
  if (shapes && json.startsWith(SHAPE_PREFIX)) {
    const comma = json.indexOf(',', SHAPE_PREFIX.length);
    const id = Number(json.slice(SHAPE_PREFIX.length, comma));
    const rows = JSON.parse(json.slice(comma + ROWS_KEY.length, -1)) as unknown[][];
    return { columns: shapes(id), rows };
  }

  const split = json.startsWith(COLUMNS_PREFIX) && json.endsWith('}') ? json.indexOf(ROWS_INFIX) : -1;
  if (split < 0) {
    const parsed = JSON.parse(json) as { columns: EncodedColumn[]; rows: unknown[][] };
    return { columns: toFields(parsed.columns), rows: parsed.rows };
  }

  const columnsText = json.slice(COLUMNS_PREFIX.length, split + 1);
  let columns = fieldLists.get(columnsText);
  if (!columns) {
    columns = toFields(JSON.parse(columnsText) as EncodedColumn[]);
    if (fieldLists.size >= MAX_FIELD_LISTS) fieldLists.clear();
    fieldLists.set(columnsText, columns);
  }
  const rows = JSON.parse(json.slice(split + ROWS_INFIX.length, -1)) as unknown[][];
  return { columns, rows };
}

function toFields(columns: EncodedColumn[]): FieldInfo[] {
  return columns.map((c) => ({
    name: c.name,
    type: c.type,
    typeName: firebirdTypeName(c.type, c.scale),
    subType: c.subType,
    scale: c.scale,
    length: c.length,
    nullable: c.nullable,
  }));
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

/**
 * Row builders, keyed by the column-name signature.
 *
 * Building one costs more than it saves on a single small result, so a query
 * run repeatedly — which is most of them — has to reuse the builder. Measured
 * on 5 columns: rebuilding per call turns 2.5 ms into 5.5 ms across 2000
 * one-row queries, while reusing turns it into 1.1 ms.
 */
const rowBuilders = new Map<string, (cols: unknown[]) => Row>();

/**
 * Cap on distinct shapes remembered.  Cleared wholesale rather than evicted
 * one at a time: this exists to stop unbounded growth in a process issuing
 * endlessly varied `SELECT` lists, not to be a good cache.
 */
const MAX_ROW_BUILDERS = 64;

/** Set once `new Function` is known to be unavailable — see {@link rowBuilder}. */
let codeGenerationBlocked = false;

/**
 * A column name as a JavaScript string literal.
 *
 * `JSON.stringify` handles quotes, backslashes and control characters. U+2028
 * and U+2029 are legal in string literals from ES2019 and are escaped anyway,
 * because the cost is nothing and the failure would be a syntax error at
 * runtime on an older engine.
 */
function stringLiteral(name: string): string {
  return JSON.stringify(name)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build a function that turns one row of values into an object.
 *
 * Generated with literal keys, which is the whole point: every row then shares
 * one hidden class, and the engine can compile the construction. The obvious
 * safe alternative — computed keys, `{[name]: c[0]}` — forces dictionary-mode
 * objects and measured *no faster than `Object.fromEntries`* (14.7 ms against
 * 15.2 ms on 10,000 rows), so it is not a trade worth making.
 *
 * Returns null when the caller must fall back:
 *
 * - A column named `__proto__`. As a literal key that sets the prototype
 *   instead of defining a property, so the value would be silently lost.
 *   `Object.fromEntries` defines it correctly, so the slow path is also the
 *   right path here. A quoted alias keeps its case, so
 *   `SELECT 1 AS "__proto__"` reaches this.
 * - A Content-Security-Policy without `unsafe-eval`, where `new Function`
 *   throws. Remembered, so it is attempted once rather than per query.
 */
function rowBuilder(names: string[]): ((cols: unknown[]) => Row) | null {
  if (codeGenerationBlocked || names.includes('__proto__')) {
    return null;
  }

  // \u0000 cannot appear in a Firebird identifier, so it cannot make two
  // different column lists collide.
  const signature = names.join('\u0000');
  const cached = rowBuilders.get(signature);
  if (cached) return cached;

  let built: (cols: unknown[]) => Row;
  try {
    built = new Function(
      'c',
      'return {' + names.map((n, i) => `${stringLiteral(n)}:c[${i}]`).join(',') + '}',
    ) as (cols: unknown[]) => Row;
  } catch {
    // A strict CSP. Every later result set takes the fallback without
    // re-testing, and nothing about the returned rows changes.
    codeGenerationBlocked = true;
    return null;
  }

  if (rowBuilders.size >= MAX_ROW_BUILDERS) {
    rowBuilders.clear();
  }
  rowBuilders.set(signature, built);
  return built;
}

/**
 * Decode the engine's JSON result set.
 *
 * `rowMode: 'array'` returns the parsed rows as they arrive — the engine
 * already sends each row as an array of values, so this is the one shape that
 * costs nothing to produce. Object mode is what the row builder above exists
 * for, and what the decode benchmark measures.
 */
export function decodeResultSet<T = Row>(
  json: string,
  rowMode: RowMode = 'object',
  shapes?: (id: number) => readonly FieldInfo[],
): QueryResult<T> {
  const { columns, rows: encodedRows } = splitResultSet(json, shapes);
  // Copies: the cached list is shared by every call with these columns, and a
  // caller is free to change the fields it was given.
  const fields: FieldInfo[] = columns.map((f) => ({ ...f }));

  if (rowMode === 'array') {
    // Handed straight through: no builder, no per-row object, and nothing to
    // collide when two columns share a name.
    return { rows: encodedRows as T[], fields };
  }

  const names = fields.map((f) => f.name);
  const build = rowBuilder(names);

  const rows = (
    build
      ? encodedRows.map(build)
      : encodedRows.map((cols) =>
          Object.fromEntries(names.map((name, i) => [name, cols[i]])),
        )
  ) as T[];

  return { rows, fields };
}

/** One field of a description, as the engine encodes it. */
function decodeField(c: EncodedColumn): FieldInfo {
  return {
    name: c.name,
    type: c.type,
    typeName: firebirdTypeName(c.type, c.scale),
    subType: c.subType,
    scale: c.scale,
    length: c.length,
    nullable: c.nullable,
  };
}

/** `isc_info_*` tags requested by `databaseInfo()` (`IAttachment::getInfo`). */
export const DATABASE_INFO_REQUEST_ITEMS = new Uint8Array([
  14, // isc_info_page_size
  21, // isc_info_allocation
  32, // isc_info_ods_version
  33, // isc_info_ods_minor_version
  104, // isc_info_oldest_transaction
  105, // isc_info_oldest_active
  106, // isc_info_oldest_snapshot
  107, // isc_info_next_transaction
  17, // isc_info_current_memory
  18, // isc_info_max_memory
  15, // isc_info_num_buffers
  5, // isc_info_reads
  6, // isc_info_writes
  7, // isc_info_fetches
  8, // isc_info_marks
]);

function readPortableInt(buffer: Uint8Array, offset: number, length: number): number {
  let value = 0;
  let multiplier = 1;
  const n = Math.min(length, 8);
  for (let i = 0; i < n; i++) {
    value += (buffer[offset + i] ?? 0) * multiplier;
    multiplier *= 256;
  }
  return value;
}

/**
 * Parse a Firebird `IAttachment::getInfo` clumplet response buffer into a
 * {@link DatabaseInfo} object.
 */
export function parseDatabaseInfoBuffer(buffer: Uint8Array): DatabaseInfo {
  let pageSize = 0;
  let allocatedPages = 0;
  let odsVersion = 0;
  let odsMinorVersion = 0;
  let oldestTransaction = 0;
  let oldestActive = 0;
  let oldestSnapshot = 0;
  let nextTransaction = 0;
  let currentMemory = 0;
  let maxMemory = 0;
  let pageBuffers = 0;
  let reads = 0;
  let writes = 0;
  let fetches = 0;
  let marks = 0;

  let pos = 0;
  while (pos < buffer.length) {
    const tag = buffer[pos++]!;
    if (tag === 0 || tag === 1 || tag === 2) break; // end / truncated
    if (pos + 2 > buffer.length) break;
    const len = buffer[pos]! | (buffer[pos + 1]! << 8);
    pos += 2;
    if (pos + len > buffer.length) break;
    const val = readPortableInt(buffer, pos, len);
    pos += len;

    switch (tag) {
      case 14: pageSize = val; break;
      case 21: allocatedPages = val; break;
      case 32: odsVersion = val; break;
      case 33: odsMinorVersion = val; break;
      case 104: oldestTransaction = val; break;
      case 105: oldestActive = val; break;
      case 106: oldestSnapshot = val; break;
      case 107: nextTransaction = val; break;
      case 17: currentMemory = val; break;
      case 18: maxMemory = val; break;
      case 15: pageBuffers = val; break;
      case 5: reads = val; break;
      case 6: writes = val; break;
      case 7: fetches = val; break;
      case 8: marks = val; break;
      default: break;
    }
  }

  return normalizeDatabaseInfo({
    pageSize,
    allocatedPages,
    odsVersion,
    odsMinorVersion,
    oldestTransaction,
    oldestActive,
    oldestSnapshot,
    nextTransaction,
    currentMemory,
    maxMemory,
    pageBuffers,
    reads,
    writes,
    fetches,
    marks,
  });
}

/** Fill in derived fields (`databaseSizeBytes`, `transactionGap`) on partial info. */
export function normalizeDatabaseInfo(raw: Partial<DatabaseInfo>): DatabaseInfo {
  const pageSize = Number(raw.pageSize ?? 0);
  const allocatedPages = Number(raw.allocatedPages ?? 0);
  const databaseSizeBytes = Number(raw.databaseSizeBytes ?? pageSize * allocatedPages);
  const odsVersion = Number(raw.odsVersion ?? 0);
  const odsMinorVersion = Number(raw.odsMinorVersion ?? 0);
  const oldestTransaction = Number(raw.oldestTransaction ?? 0);
  const oldestActive = Number(raw.oldestActive ?? 0);
  const oldestSnapshot = Number(raw.oldestSnapshot ?? 0);
  const nextTransaction = Number(raw.nextTransaction ?? 0);
  const transactionGap = Number(
    raw.transactionGap ?? (nextTransaction >= oldestActive ? nextTransaction - oldestActive : 0),
  );
  const currentMemory = Number(raw.currentMemory ?? 0);
  const maxMemory = Number(raw.maxMemory ?? 0);
  const pageBuffers = Number(raw.pageBuffers ?? 0);
  const reads = Number(raw.reads ?? 0);
  const writes = Number(raw.writes ?? 0);
  const fetches = Number(raw.fetches ?? 0);
  const marks = Number(raw.marks ?? 0);
  return {
    pageSize,
    allocatedPages,
    databaseSizeBytes,
    odsVersion,
    odsMinorVersion,
    oldestTransaction,
    oldestActive,
    oldestSnapshot,
    nextTransaction,
    transactionGap,
    currentMemory,
    maxMemory,
    pageBuffers,
    reads,
    writes,
    fetches,
    marks,
  };
}

/** Decode what `fb_database_info` reports about a database. */
export function decodeDatabaseInfo(json: string): DatabaseInfo {
  return normalizeDatabaseInfo(JSON.parse(json) as Partial<DatabaseInfo>);
}

/** Decode what `fb_describe` reports about a statement. */
export function decodeDescription(json: string): QueryDescription {
  const parsed = JSON.parse(json) as {
    params: EncodedColumn[];
    columns: EncodedColumn[];
    statementType: number;
  };

  const fields = parsed.columns.map(decodeField);

  return {
    // Parameters are positional in Firebird and carry no name, so the engine
    // sends "" — they are described by type and position alone.
    params: parsed.params.map(decodeField),
    fields,
    statementType: statementKind(parsed.statementType),
    // Derived rather than reported separately: a statement yields rows exactly
    // when it describes some.
    hasResultSet: fields.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Binary BLOB side channel
// ---------------------------------------------------------------------------

/** `flags` bit asking the engine to send binary BLOBs beside the JSON. */
export const BLOB_SIDE_CHANNEL = 1;

/**
 * `fb_query` flag bit: a kept statement's result may name its columns by id,
 * `{"shape":N,"rows":[...]}`, rather than describe them again. The ids are
 * the engine module's own and never reused, so the transport that loaded the
 * module keeps what each one means.
 */
export const SHAPE_IDS = 2;

/** The placeholder a side-channelled BLOB leaves in the JSON. */
interface BlobRef {
  $blob: number;
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobRef).$blob === 'number'
  );
}

/**
 * Copy the side buffer out of the WASM heap into one JavaScript buffer.
 *
 * One copy, and it is not the "no copy" the plan hoped for. A `Uint8Array`
 * over `HEAPU8.buffer` is a view into memory the engine reuses on the next
 * query and that `ALLOW_MEMORY_GROWTH` can detach from underneath it, so
 * handing such a view to a caller would be handing them something that goes
 * wrong later and elsewhere. What the side channel actually removes is the
 * 33% base64 inflation, the JSON string for those bytes, and the `atob` plus
 * per-byte loop that decoded them — measured in the benchmark.
 *
 * The single buffer is deliberate: it is what a Worker can *transfer* rather
 * than clone, which is the other half of the win and impossible for a base64
 * string.
 */
function readBlobs(mod: FirebirdWasmModule): Uint8Array[] | null {
  const ptr = mod._fb_last_blobs();
  const size = mod._fb_last_blobs_size();
  if (ptr === 0 || size === 0) return null;

  // Re-read HEAPU8 rather than closing over it: the query may have grown the
  // heap, which replaces the buffer and detaches older views.
  const heap = mod.HEAPU8;
  const view = new DataView(heap.buffer, heap.byteOffset + ptr, size);

  const count = view.getUint32(0, true);
  const headerBytes = 4 * (1 + count);

  const blobs: Uint8Array[] = new Array(count);
  let offset = headerBytes;
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(4 * (1 + i), true);
    // slice() copies; subarray() would alias the heap.
    blobs[i] = heap.slice(ptr + offset, ptr + offset + length);
    offset += length;
  }

  return blobs;
}

/**
 * Replace every `{"$blob":N}` placeholder with its bytes.
 *
 * Walks the decoded rows rather than the JSON text: the values are already
 * parsed, and a placeholder is the only object a row can contain, so
 * recognising one is a type check rather than a search.
 */
export function attachBlobs<T>(
  result: QueryResult<T>,
  blobs: Uint8Array[],
  rowMode: RowMode,
): QueryResult<T> {
  for (const row of result.rows) {
    if (rowMode === 'array') {
      const values = row as unknown[];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (isBlobRef(value)) values[i] = blobs[value.$blob];
      }
      continue;
    }

    const target = row as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      const value = target[key];
      if (isBlobRef(value)) target[key] = blobs[value.$blob];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// DirectTransport
// ---------------------------------------------------------------------------

/**
 * Calls the engine in the current thread.
 *
 * Used by Node, by the Worker (which is where a browser's engine actually
 * runs), and by tests that install a stub `createFirebirdModule`.
 */
export class DirectTransport implements EngineTransport {
  private mod: FirebirdWasmModule | null = null;
  private initPromise: Promise<void> | null = null;
  /** The OPFS database this transport mounted, closed on dispose. */
  private opfsHandle: {
    read(buffer: ArrayBufferView, options?: { at?: number }): number;
    write(buffer: ArrayBufferView, options?: { at?: number }): number;
    truncate(size: number): void;
    getSize(): number;
    flush(): void;
    close(): void;
  } | null = null;
  /** What each shape id of this module's engine means (see SHAPE_IDS). */
  private readonly shapes = new Map<number, readonly FieldInfo[]>();
  /** Fallback cursor state when running against an older WASM artifact without `_fb_cursor_open`. */
  private readonly fallbackCursors = new Map<
    EngineHandle,
    { fields: FieldInfo[]; rows: unknown[][]; offset: number }
  >();
  private nextFallbackCursor = 1;

  /**
   * The fields of shape `id`: remembered, or asked of the engine once. Called
   * while decoding, right after the query that named the id and before any
   * other engine call, when the statement holding that shape is the cache's
   * most recently used and still kept.
   */
  private readonly shapeColumns = (id: number): readonly FieldInfo[] => {
    const known = this.shapes.get(id);
    if (known) return known;

    const mod = this.module;
    const ptr = mod._fb_shape_columns(id);
    if (ptr === 0) {
      throw engineError(mod, `Firebird returned rows of a shape it no longer has (${id})`);
    }
    let parsed: { columns: EncodedColumn[] };
    try {
      parsed = JSON.parse(mod.UTF8ToString(ptr)) as { columns: EncodedColumn[] };
    } finally {
      mod._fb_free_result(ptr);
    }
    const fields = toFields(parsed.columns);
    if (this.shapes.size >= MAX_FIELD_LISTS) this.shapes.clear();
    this.shapes.set(id, fields);
    return fields;
  };

  constructor(private readonly options: DirectTransportOptions = {}) {}

  async init(): Promise<void> {
    // Concurrent first calls must not each load the module.
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  async loadIcuLocaleData(data: Uint8Array): Promise<void> {
    await this.init();
    await applyIcuLocaleDataToModule(this.module, data);
  }

  private async doInit(): Promise<void> {
    this.mod = await acquireFirebirdWasm({
      wasmBinary: this.options.wasmBinary,
      locateFile: this.options.locateFile,
      threads: this.options.threads,
    });

    const rc = this.mod._fb_init();
    if (rc !== 0) {
      throw engineError(this.mod, 'Failed to initialise the Firebird engine', rc);
    }
  }

  private get module(): FirebirdWasmModule {
    if (!this.mod) {
      throw new Error('EngineTransport used before init()');
    }
    return this.mod;
  }

  /** Run `fn` with `str` allocated on the WASM heap, freeing it afterwards. */
  private withString<T>(str: string, fn: (ptr: number) => T): T {
    const mod = this.module;
    const ptr = allocString(mod, str);
    try {
      return fn(ptr);
    } finally {
      mod._free(ptr);
    }
  }

  async createDatabase(path: string): Promise<EngineHandle> {
    const mod = this.module;
    const handle = this.withString(path, (p) => mod._fb_create_database(p));
    if (handle === 0) {
      throw engineError(mod, `Failed to create database "${path}"`);
    }
    return handle;
  }

  async attachDatabase(path: string): Promise<EngineHandle> {
    const mod = this.module;
    const handle = this.withString(path, (p) => mod._fb_attach_database(p));
    if (handle === 0) {
      throw engineError(mod, `Failed to open database "${path}"`);
    }
    return handle;
  }

  async detachDatabase(dbHandle: EngineHandle): Promise<void> {
    this.module._fb_detach_database(dbHandle);
  }

  /**
   * Run `fn` with the packed parameters on the WASM heap.
   *
   * An empty list is passed as a null pointer rather than an empty buffer, so
   * the C side takes its "no parameters" path and skips preparing an input
   * message it would not use.
   */
  private withParams<T>(
    params: QueryParams,
    fn: (ptr: number, length: number) => T,
  ): T {
    if (!params || params.length === 0) {
      return fn(0, 0);
    }

    const mod = this.module;
    const packed = encodeParams(params);
    const ptr = mod._malloc(packed.length);
    try {
      mod.HEAPU8.set(packed, ptr);
      return fn(ptr, packed.length);
    } finally {
      mod._free(ptr);
    }
  }

  async execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
  ): Promise<number> {
    const mod = this.module;
    const rc = this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) =>
        params.length === 0
          ? mod._fb_execute(dbHandle, txHandle, sqlPtr)
          : mod._fb_execute_params(dbHandle, txHandle, sqlPtr, paramPtr, paramLen),
      ),
    );
    if (rc !== 0) {
      throw engineError(mod, `Firebird exec failed for: ${sql}`, rc);
    }
    return mod._fb_last_affected_rows();
  }

  async executeBatch(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    rows: QueryParams[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const mod = this.module;
    const packed = encodeParamRows(rows);
    const ptr = mod._malloc(packed.length);
    let rc: number;
    try {
      mod.HEAPU8.set(packed, ptr);
      rc = this.withString(sql, (sqlPtr) =>
        mod._fb_execute_batch(dbHandle, txHandle, sqlPtr, ptr, packed.length),
      );
    } finally {
      mod._free(ptr);
    }
    if (rc !== 0) {
      throw engineError(mod, `Firebird batch failed for: ${sql}`, rc);
    }
    return mod._fb_last_affected_rows();
  }

  async query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
    rowMode: RowMode = 'object',
    binaryBlobs = false,
  ): Promise<QueryResult<T>> {
    const mod = this.module;
    const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
    return this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) => {
      const resultPtr =
        params.length === 0
          ? mod._fb_query(dbHandle, txHandle, sqlPtr, flags)
          : mod._fb_query_params(
              dbHandle,
              txHandle,
              sqlPtr,
              paramPtr,
              paramLen,
              flags,
            );
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird query failed for: ${sql}`);
      }

      // The engine owns the buffer until fb_free_result.
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);

      // Read before anything else can run: the side buffer belongs to the
      // engine and the next query replaces it.
      const blobs = binaryBlobs ? readBlobs(mod) : null;

      const result = decodeResultSet<T>(json, rowMode, this.shapeColumns);
      return blobs ? attachBlobs(result, blobs, rowMode) : result;
      }),
    );
  }

  async cursorOpen(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
  ): Promise<EngineHandle> {
    const mod = this.module;
    if (typeof mod._fb_cursor_open !== 'function') {
      const full = await this.query<unknown[]>(
        dbHandle,
        txHandle,
        sql,
        params,
        'array',
        true,
      );
      const handle = this.nextFallbackCursor++;
      this.fallbackCursors.set(handle, {
        fields: full.fields,
        rows: full.rows,
        offset: 0,
      });
      return handle;
    }

    const openFn = mod._fb_cursor_open;
    const handle = this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) =>
        openFn.call(mod, dbHandle, txHandle, sqlPtr, paramPtr, paramLen),
      ),
    );
    if (handle === 0) {
      throw engineError(mod, `Firebird cursor open failed for: ${sql}`);
    }
    return handle;
  }

  async cursorFetch<T = Row>(
    cursorHandle: EngineHandle,
    batchSize: number,
    rowMode: RowMode = 'object',
    binaryBlobs = false,
  ): Promise<QueryResult<T>> {
    const mod = this.module;
    if (typeof mod._fb_cursor_fetch !== 'function') {
      const entry = this.fallbackCursors.get(cursorHandle);
      if (!entry) {
        throw new Error('Firebird cursor fetch failed: unknown cursor handle');
      }
      const fields = entry.fields.map((f) => ({ ...f }));
      const slice = entry.rows.slice(entry.offset, entry.offset + batchSize);
      entry.offset += slice.length;
      if (rowMode === 'array') {
        return { rows: slice.map((r) => [...r]) as T[], fields };
      }
      const names = fields.map((f) => f.name);
      const build = rowBuilder(names);
      const rows = (
        build
          ? slice.map(build)
          : slice.map((cols) =>
              Object.fromEntries(names.map((name, i) => [name, cols[i]])),
            )
      ) as T[];
      return { rows, fields };
    }

    const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
    const resultPtr = mod._fb_cursor_fetch(cursorHandle, batchSize, flags);
    if (resultPtr === 0) {
      throw engineError(mod, 'Firebird cursor fetch failed');
    }

    const json = mod.UTF8ToString(resultPtr);
    mod._fb_free_result(resultPtr);

    const blobs = binaryBlobs ? readBlobs(mod) : null;
    const result = decodeResultSet<T>(json, rowMode, this.shapeColumns);
    return blobs ? attachBlobs(result, blobs, rowMode) : result;
  }

  async cursorClose(cursorHandle: EngineHandle): Promise<void> {
    const mod = this.module;
    if (typeof mod._fb_cursor_close !== 'function') {
      if (!this.fallbackCursors.delete(cursorHandle)) {
        throw new Error('Firebird cursor close failed: unknown cursor handle');
      }
      return;
    }

    const rc = mod._fb_cursor_close(cursorHandle);
    if (rc !== 0) {
      throw engineError(mod, 'Firebird cursor close failed', rc);
    }
  }

  async setSharedReads(dbHandle: EngineHandle, on: boolean): Promise<void> {
    const mod = this.module;
    if (mod._fb_read_transaction(dbHandle, on ? 1 : 0) < 0) {
      throw engineError(mod, 'Firebird could not change shared reads');
    }
  }

  async describe(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription> {
    const mod = this.module;
    return this.withString(sql, (sqlPtr) => {
      const resultPtr = mod._fb_describe(dbHandle, txHandle, sqlPtr);
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird could not describe: ${sql}`);
      }

      // Same ownership rule as a result set: the engine owns it until freed.
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);

      return decodeDescription(json);
    });
  }

  async prepare(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription & { handle?: EngineHandle }> {
    const mod = this.module;
    if (typeof mod._fb_prepare !== 'function') {
      const desc = await this.describe(dbHandle, txHandle, sql);
      return { ...desc, handle: 0 };
    }
    const prepareFn = mod._fb_prepare;
    return this.withString(sql, (sqlPtr) => {
      const resultPtr = prepareFn.call(mod, dbHandle, txHandle, sqlPtr);
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird could not prepare: ${sql}`);
      }
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);
      const parsed = JSON.parse(json) as { handle?: number };
      return {
        ...decodeDescription(json),
        handle: typeof parsed.handle === 'number' ? parsed.handle : 0,
      };
    });
  }

  async stmtClose(stmtHandle: EngineHandle): Promise<void> {
    if (stmtHandle <= 0) return;
    const mod = this.module;
    if (typeof mod._fb_stmt_close === 'function') {
      mod._fb_stmt_close(stmtHandle);
    }
  }

  async explain(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    detailed = false,
  ): Promise<string> {
    const mod = this.module;
    if (typeof mod._fb_explain !== 'function') {
      return this.fallbackExplain(dbHandle, txHandle, sql, detailed);
    }

    const explainFn = mod._fb_explain;
    return this.withString(sql, (sqlPtr) => {
      const resultPtr = explainFn.call(
        mod,
        dbHandle,
        txHandle,
        sqlPtr,
        detailed ? 1 : 0,
      );
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird could not explain: ${sql}`);
      }

      const plan = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);
      return plan.replace(/^[\r\n]+|[\r\n]+$/g, '');
    });
  }

  private async fallbackExplain(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    detailed: boolean,
  ): Promise<string> {
    const desc = await this.describe(dbHandle, txHandle, sql);
    if (
      desc.statementType === 'DDL' ||
      desc.statementType === 'START_TRANS' ||
      desc.statementType === 'COMMIT' ||
      desc.statementType === 'ROLLBACK' ||
      desc.statementType === 'SAVEPOINT' ||
      desc.statementType === 'SET_GENERATOR'
    ) {
      return '';
    }

    const userTables = extractReferencedTables(sql);
    const tables = userTables.length > 0 ? userTables : ['RDB$DATABASE'];
    const hasWhere = /\bWHERE\b/i.test(sql);
    const indexByTable = new Map<string, string>();

    if (hasWhere && userTables.length > 0) {
      for (const table of userTables) {
        try {
          const res = await this.query<{ IDX: string }>(
            dbHandle,
            txHandle,
            'SELECT FIRST 1 TRIM(RDB$INDEX_NAME) AS IDX FROM RDB$INDICES WHERE TRIM(RDB$RELATION_NAME) = ? ORDER BY RDB$INDEX_ID',
            [table],
          );
          const idx = res.rows[0]?.IDX;
          if (idx) indexByTable.set(table, idx);
        } catch {
          // Ignore catalog lookup errors in fallback mode.
        }
      }
    }

    if (detailed) {
      const steps = tables.map((t) => {
        const idx = indexByTable.get(t);
        if (idx) {
          return (
            `    -> Filter\n` +
            `        -> Table "${t}" Access By ID\n` +
            `            -> Bitmap\n` +
            `                -> Index "${idx}" Range Scan (full match)`
          );
        }
        return `    -> Table "${t}" Full Scan`;
      });
      return `Select Expression\n${steps.join('\n')}`;
    }

    const parts = tables.map((t) => {
      const idx = indexByTable.get(t);
      return idx ? `${t} INDEX (${idx})` : `${t} NATURAL`;
    });
    return `PLAN (${parts.join(', ')})`;
  }

  async databaseInfo(dbHandle: EngineHandle): Promise<DatabaseInfo> {
    const mod = this.module;
    if (typeof mod._fb_database_info !== 'function') {
      return this.fallbackDatabaseInfo(dbHandle);
    }

    const resultPtr = mod._fb_database_info(dbHandle);
    if (resultPtr === 0) {
      throw engineError(mod, 'Firebird could not read database info');
    }

    const json = mod.UTF8ToString(resultPtr);
    mod._fb_free_result(resultPtr);
    return decodeDatabaseInfo(json);
  }

  private async fallbackDatabaseInfo(dbHandle: EngineHandle): Promise<DatabaseInfo> {
    const dbRes = await this.query<Record<string, unknown>>(
      dbHandle,
      0,
      'SELECT MON$PAGE_SIZE, MON$PAGES, MON$ODS_MAJOR, MON$ODS_MINOR, ' +
        'MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$OLDEST_SNAPSHOT, ' +
        'MON$NEXT_TRANSACTION, MON$PAGE_BUFFERS FROM MON$DATABASE',
    );
    const dbRow = dbRes.rows[0] ?? {};

    let currentMemory = 0;
    let maxMemory = 0;
    try {
      const memRes = await this.query<Record<string, unknown>>(
        dbHandle,
        0,
        'SELECT MON$MEMORY_USED, MON$MAX_MEMORY_USED FROM MON$MEMORY_USAGE WHERE MON$STAT_GROUP = 0',
      );
      const memRow = memRes.rows[0] ?? {};
      currentMemory = Number(memRow['MON$MEMORY_USED'] ?? 0);
      maxMemory = Number(memRow['MON$MAX_MEMORY_USED'] ?? 0);
    } catch {
      // Ignore if MON$MEMORY_USAGE is unavailable.
    }

    let reads = 0;
    let writes = 0;
    let fetches = 0;
    let marks = 0;
    try {
      const ioRes = await this.query<Record<string, unknown>>(
        dbHandle,
        0,
        'SELECT MON$PAGE_READS, MON$PAGE_WRITES, MON$PAGE_FETCHES, MON$PAGE_MARKS ' +
          'FROM MON$IO_STATS WHERE MON$STAT_GROUP = 0',
      );
      const ioRow = ioRes.rows[0] ?? {};
      reads = Number(ioRow['MON$PAGE_READS'] ?? 0);
      writes = Number(ioRow['MON$PAGE_WRITES'] ?? 0);
      fetches = Number(ioRow['MON$PAGE_FETCHES'] ?? 0);
      marks = Number(ioRow['MON$PAGE_MARKS'] ?? 0);
    } catch {
      // Ignore if MON$IO_STATS is unavailable.
    }

    return normalizeDatabaseInfo({
      pageSize: Number(dbRow['MON$PAGE_SIZE'] ?? 0),
      allocatedPages: Number(dbRow['MON$PAGES'] ?? 0),
      odsVersion: Number(dbRow['MON$ODS_MAJOR'] ?? 0),
      odsMinorVersion: Number(dbRow['MON$ODS_MINOR'] ?? 0),
      oldestTransaction: Number(dbRow['MON$OLDEST_TRANSACTION'] ?? 0),
      oldestActive: Number(dbRow['MON$OLDEST_ACTIVE'] ?? 0),
      oldestSnapshot: Number(dbRow['MON$OLDEST_SNAPSHOT'] ?? 0),
      nextTransaction: Number(dbRow['MON$NEXT_TRANSACTION'] ?? 0),
      pageBuffers: Number(dbRow['MON$PAGE_BUFFERS'] ?? 0),
      currentMemory,
      maxMemory,
      reads,
      writes,
      fetches,
      marks,
    });
  }

  async startTransaction(
    dbHandle: EngineHandle,
    options: TransactionOptions = {},
  ): Promise<EngineHandle> {
    const mod = this.module;
    const txHandle = mod._fb_start_transaction_ex(
      dbHandle,
      isolationCode(options),
      options.readOnly === true ? 1 : 0,
    );
    if (txHandle === 0) {
      throw engineError(mod, 'Failed to start transaction');
    }
    return txHandle;
  }

  async commit(txHandle: EngineHandle): Promise<void> {
    const mod = this.module;
    const rc = mod._fb_commit(txHandle);
    if (rc !== 0) {
      // fb_commit finishes the transaction whatever the outcome, so there is
      // nothing left to roll back here.
      throw engineError(mod, 'Transaction commit failed', rc);
    }
  }

  async rollback(txHandle: EngineHandle): Promise<void> {
    this.module._fb_rollback(txHandle);
  }

  // ── Filesystem ─────────────────────────────────────────────────────────

  async mkdir(path: string): Promise<void> {
    const mod = this.module;
    if (!mod.FS.analyzePath(path).exists) {
      mod.FS.mkdir(path);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.module.FS.analyzePath(path).exists;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.module.FS.readFile(path);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.module.FS.writeFile(path, data);
  }

  async fileSize(path: string): Promise<number> {
    if (this.opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
      return this.opfsHandle.getSize();
    }
    const fs = this.module.FS;
    if (!fs.analyzePath(path).exists) {
      return 0;
    }
    return fs.stat(path).size;
  }

  async readFileChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    if (this.opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
      const size = this.opfsHandle.getSize();
      if (offset >= size) return new Uint8Array(0);
      const toRead = Math.min(length, size - offset);
      const buf = new Uint8Array(toRead);
      const n = this.opfsHandle.read(buf, { at: offset });
      return n === toRead ? buf : buf.slice(0, n);
    }

    const fs = this.module.FS;
    if (
      typeof fs.open === 'function' &&
      typeof fs.read === 'function' &&
      typeof fs.close === 'function'
    ) {
      if (!fs.analyzePath(path).exists) return new Uint8Array(0);
      const size = fs.stat(path).size;
      if (offset >= size) return new Uint8Array(0);
      const toRead = Math.min(length, size - offset);
      const buf = new Uint8Array(toRead);
      const stream = fs.open(path, 'r');
      try {
        const n = fs.read(stream, buf, 0, toRead, offset);
        return n === toRead ? buf : buf.slice(0, n);
      } finally {
        fs.close(stream);
      }
    }

    const full = fs.readFile(path);
    if (offset >= full.byteLength) return new Uint8Array(0);
    return full.slice(offset, offset + length);
  }

  async writeFileChunk(
    path: string,
    data: Uint8Array,
    offset: number,
    truncate = false,
  ): Promise<void> {
    if (this.opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
      if (truncate) {
        this.opfsHandle.truncate(0);
      }
      if (data.byteLength > 0) {
        this.opfsHandle.write(data, { at: offset });
      }
      this.opfsHandle.flush();
      return;
    }

    const fs = this.module.FS;
    if (
      typeof fs.open === 'function' &&
      typeof fs.write === 'function' &&
      typeof fs.close === 'function'
    ) {
      const exists = fs.analyzePath(path).exists;
      if (truncate && exists && typeof fs.truncate === 'function') {
        fs.truncate(path, 0);
      }
      const flags = !exists || truncate ? 'w+' : 'r+';
      const stream = fs.open(path, flags);
      try {
        if (data.byteLength > 0) {
          fs.write(stream, data, 0, data.byteLength, offset);
        }
      } finally {
        fs.close(stream);
      }
      return;
    }

    if (truncate || !fs.analyzePath(path).exists) {
      const out = new Uint8Array(offset + data.byteLength);
      out.set(data, offset);
      fs.writeFile(path, out);
      return;
    }

    const existing = fs.readFile(path);
    const nextLen = Math.max(existing.byteLength, offset + data.byteLength);
    const out =
      nextLen === existing.byteLength ? existing : new Uint8Array(nextLen);
    if (out !== existing) {
      out.set(existing, 0);
    }
    out.set(data, offset);
    fs.writeFile(path, out);
  }

  async unlink(path: string): Promise<void> {
    if (this.module.FS.analyzePath(path).exists) {
      this.module.FS.unlink(path);
    }
  }

  async eventsSubscribe(dbHandle: EngineHandle, names: string[]): Promise<number> {
    const mod = this.module;
    return this.withString(names.join(','), (namesPtr) => {
      const handle = mod._fb_events_subscribe(dbHandle, namesPtr);
      if (handle === 0) {
        throw engineError(mod, `Could not subscribe to events: ${names.join(', ')}`);
      }
      return handle;
    });
  }

  async eventsPoll(subscription: number): Promise<Record<string, number>> {
    const mod = this.module;
    const ptr = mod._fb_events_poll(subscription);
    if (ptr === 0) {
      throw engineError(mod, 'Could not poll events');
    }

    const json = mod.UTF8ToString(ptr);
    mod._free(ptr);
    return JSON.parse(json) as Record<string, number>;
  }

  async eventsCancel(subscription: number): Promise<void> {
    // A subscription that is already gone is not an error worth raising: the
    // caller is unsubscribing, and it is unsubscribed.
    this.module._fb_events_cancel(subscription);
  }

  async mountOpfs(dbName: string): Promise<string> {
    if (!opfsAvailable()) {
      throw new Error(
        'OPFS storage needs a Worker: FileSystemSyncAccessHandle is not ' +
          'available on a main thread, and Node has no OPFS at all. Pass a ' +
          '`worker` to FirebirdBrowser, or use an IndexedDB or memory:// database',
      );
    }

    // Opened before the mount, because a filesystem callback cannot await.
    const handle = await openDatabaseHandle(dbName);
    const fileName = `${dbName}.fdb`;
    mountOpfsFilesystem(this.module, OPFS_MOUNT, new Map([[fileName, handle]]));
    this.opfsHandle = handle;
    return `${OPFS_MOUNT}/${fileName}`;
  }

  async dispose(): Promise<void> {
    // The module is shared with every other transport of the same build; the
    // last one to let it go disposes it (unless loadFirebirdWasm pinned it),
    // which ends the engine and frees its memory.
    const mod = this.mod;
    const init = this.initPromise;
    const opfs = this.opfsHandle;
    this.mod = null;
    this.initPromise = null;
    this.opfsHandle = null;
    this.fallbackCursors.clear();
    if (opfs && mod) {
      // The database is detached by now.  The handle is exclusive: left open,
      // it locked the file against the next open until the Worker went.
      try {
        (mod.FS as unknown as { unmount(path: string): void }).unmount(OPFS_MOUNT);
      } catch {
        // not mounted any more
      }
      try {
        opfs.close();
      } catch {
        // closed already
      }
    }
    if (mod) {
      await releaseFirebirdWasm(mod);
    } else if (init) {
      // Disposed while still loading: release what the load acquires.
      await init.then(() => undefined, () => undefined);
      const late = this.mod as FirebirdWasmModule | null;
      this.mod = null;
      if (late) await releaseFirebirdWasm(late);
    }
  }
}
