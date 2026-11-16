/**
 * wasm-abi-types.ts – Core `EngineHandle`, `EngineTransport`, and `DirectTransportOptions`
 * types for the WASM engine boundary (`M21 Item 5`).
 */

import type {
  Row,
  QueryResult,
  QueryDescription,
  DatabaseInfo,
  SweepResult,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';
import type {
  EnginePipelineStepRequest,
  EnginePipelineStepResponse,
  EnginePipelineWireOptions,
} from '../pipeline';
import type { BinaryResultPayload } from './binary-result';

/** Where an OPFS-backed database is mounted inside the engine's filesystem. */
export const OPFS_MOUNT = '/opfs';

/** Opaque engine handle (database or transaction). 0 means "none". */
export type EngineHandle = number;

/**
 * The operations `FirebirdBrowser` needs from the engine, wherever it runs.
 *
 * `txHandle` of 0 means "run this statement in its own transaction", matching
 * the C API.
 */
export interface EngineTransport {
  /** When `true`, `serveEngine` forwards `"FBP\x01"` / `"FBP\x02"` wire parameter buffers directly without decoding JS arrays (`M20 Item 2`). */
  readonly acceptsWireParams?: boolean;
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
    params?: QueryParams | Uint8Array,
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
    rows: QueryParams[] | Uint8Array,
  ): Promise<number>;
  query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
    rowMode?: RowMode,
    binaryBlobs?: boolean,
  ): Promise<QueryResult<T>>;
  queryBinary?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
    binaryBlobs?: boolean,
  ): Promise<BinaryResultPayload>;
  /**
   * Open a streaming cursor for `sql` (with optional `params`).
   * With `txHandle` of 0 the cursor runs in its own transaction, committed by
   * {@link EngineTransport.cursorClose}.
   */
  cursorOpen?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
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
  cursorFetchBinary?(
    cursorHandle: EngineHandle,
    batchSize: number,
    binaryBlobs?: boolean,
  ): Promise<BinaryResultPayload>;
  /** Close an open cursor and finish any transaction it started for itself. */
  cursorClose?(cursorHandle: EngineHandle): Promise<void>;
  /** Create a new writable BLOB handle in `(dbHandle, txHandle)`. */
  blobCreate?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
  ): Promise<{ blobHandle: EngineHandle; blobId: Uint8Array }>;
  /** Write a segment of bytes to an open writable BLOB handle. */
  blobPutSegment?(blobHandle: EngineHandle, segment: Uint8Array): Promise<void>;
  /** Open an existing BLOB by its 8-byte `ISC_QUAD` ID for segmented reading. */
  blobOpenId?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    blobId: Uint8Array,
  ): Promise<EngineHandle>;
  /** Execute `sql` and open column `colIndex` of the first row as a readable BLOB handle. */
  blobOpenQuery?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams | undefined,
    colIndex: number,
  ): Promise<EngineHandle>;
  /** Read up to `maxLength` bytes from an open readable BLOB handle (`null` at EOF). */
  blobGetSegment?(
    blobHandle: EngineHandle,
    maxLength: number,
  ): Promise<Uint8Array | null>;
  /** Close (or cancel) an open BLOB handle and return its 8-byte `ISC_QUAD` ID. */
  blobClose?(blobHandle: EngineHandle, cancel?: boolean): Promise<Uint8Array>;
  /**
   * Run this database's autocommit SELECTs in a read-only transaction it
   * keeps open (`true`), or each in one of its own (`false`, the default).
   */
  setSharedReads?(dbHandle: EngineHandle, on: boolean): Promise<void>;
  /** Return database storage, ODS, memory pool, I/O, and OIT/OAT/OST transaction health diagnostics. */
  databaseInfo?(dbHandle: EngineHandle): Promise<DatabaseInfo>;
  /** Trigger an immediate garbage-collection sweep and return before/after diagnostics. */
  sweep?(dbHandle: EngineHandle): Promise<SweepResult>;
  /**
   * Configure Firebird's native database replica mode (`0 | 'none'`,
   * `1 | 'read_only'`, or `2 | 'read_write'`) on the database header page.
   */
  setReplicaMode?(
    dbHandle: EngineHandle,
    mode: 0 | 1 | 2 | 'none' | 'read_only' | 'read_write',
  ): Promise<void>;
  /**
   * Apply a native Firebird `"FBCHANGELOG\0"` binary changelog segment to
   * `dbHandle` via `IAttachment::createReplicator`, returning the number of
   * changelog blocks processed.
   */
  replicateChangelog?(
    dbHandle: EngineHandle,
    data: Uint8Array,
    transfer?: boolean,
  ): Promise<number>;
  prepare?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription & { handle?: EngineHandle }>;
  stmtClose?(stmtHandle: EngineHandle): Promise<void>;
  /** Set the statement execution timeout in milliseconds (`IStatement::setTimeout`). `0` disables the timeout. */
  stmtSetTimeout?(stmtHandle: EngineHandle, timeoutMs: number): Promise<void>;
  /** Cancel the currently running operation on `dbHandle` (`IAttachment::cancelOperation`). */
  cancelOperation?(dbHandle: EngineHandle, option?: number): Promise<void>;
  /** Execute a prepared statement handle by integer ID without marshalling SQL text. */
  executeStmt?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params?: QueryParams | Uint8Array,
  ): Promise<number>;
  /** Execute a prepared statement handle once per row of parameters as a single batch. */
  executeBatchStmt?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    rows: QueryParams[] | Uint8Array,
  ): Promise<number>;
  /** Query a prepared statement handle by integer ID without marshalling SQL text. */
  queryStmt?<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params?: QueryParams | Uint8Array,
    rowMode?: RowMode,
    binaryBlobs?: boolean,
  ): Promise<QueryResult<T>>;
  /** Query a prepared statement handle and return a packed `FBR\x01` binary result buffer. */
  queryStmtBinary?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params?: QueryParams | Uint8Array,
    binaryBlobs?: boolean,
  ): Promise<BinaryResultPayload>;
  /** Open a streaming cursor for a prepared statement handle by integer ID. */
  cursorOpenStmt?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params?: QueryParams | Uint8Array,
  ): Promise<EngineHandle>;
  explain?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    detailed?: boolean,
  ): Promise<string>;
  /** Execute a heterogeneous multi-statement pipeline in a single transport round-trip (`M20 Item 2` / `M21 Item 2`). */
  pipeline?(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    steps: readonly EnginePipelineStepRequest[],
    options?: EnginePipelineWireOptions,
  ): Promise<EnginePipelineStepResponse[]>;
  describe(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription>;

  /** Begin a transaction. */
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
  writeFile(path: string, data: Uint8Array, transfer?: boolean): Promise<void>;
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
    transfer?: boolean,
  ): Promise<void>;
  /** Remove a file.  Used to discard an ephemeral database on close. */
  unlink(path: string): Promise<void>;
  /** Subscribe to named events; returns a subscription handle. */
  eventsSubscribe(dbHandle: EngineHandle, names: string[]): Promise<number>;
  /** Counts that have arrived since the last poll, keyed by event name. */
  eventsPoll(subscription: number): Promise<Record<string, number>>;
  /** Cancel a subscription. */
  eventsCancel(subscription: number): Promise<void>;
  /** Mount an OPFS-backed filesystem holding one database, and return the path the engine should open. */
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
