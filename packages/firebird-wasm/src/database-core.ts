/**
 * Shared database core helpers & unified `FirebirdDatabase` client interface
 * shared across `FirebirdBrowser` (WASM) and `FirebirdLite` (Node.js).
 */

import type {
  ArrayRow,
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  CopyFromOptions,
  CopyResult,
  CopyToOptions,
  DatabaseInfo,
  DataStreamOptions,
  ExplainOptions,
  IntrospectOptions,
  JsFunctionHandler,
  JsProcedureHandler,
  MigrateOptions,
  MigrateResult,
  Migration,
  MonitorStats,
  PreparedStatement,
  QueryDescription,
  QueryOptions,
  QueryParams,
  QueryProfileListener,
  QueryResult,
  QueryStreamOptions,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  RegisteredRoutine,
  Row,
  SchemaIntrospection,
  StatementExecutionOptions,
  SweepResult,
  TransactionOptions,
} from './types';
import type { SqlFragment } from './sql-tag';
import type { ArrowIpcOptions, ColumnarQueryResult } from './columnar';
import type { StandardSchemaV1, TypedSqlFragment } from './schema-validation';
import { UdrManager } from './browser/udr';
import {
  CowSnapshotStore,
  type ApplyPageDiffOptions,
  type DatabaseSnapshot,
  type DatabaseSnapshotInfo,
  type PageDiffOptions,
  type SnapshotOptions,
} from './browser/snapshots';
import { QueryProfiler } from './browser/profiler';

/** `QueryOptions` with `rowMode: 'array'` pinned for overload resolution. */
export type ArrayModeOptions = QueryOptions & { rowMode: 'array' };
/** `QueryStreamOptions` with `rowMode: 'array'` pinned for overload resolution. */
export type ArrayStreamOptions = QueryStreamOptions & { rowMode: 'array' };

/** Valid SQL savepoint identifier pattern (1-63 ASCII identifier chars). */
export const SAVEPOINT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** Validate a SQL savepoint identifier before interpolating into `SAVEPOINT <name>`. */
export function validateSavepointName(name: string): string {
  if (typeof name !== 'string' || !SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid savepoint name "${String(name)}": must be a valid SQL identifier (1-63 ASCII letters, digits, '_', or '$', starting with a letter or '_')`,
    );
  }
  return name;
}

/** Validate an optional `timeoutMs` execution option. */
export function validateTimeoutMs(timeoutMs?: number): number | undefined {
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

/** Convert an `AbortSignal.reason` value into an `Error` (`AbortError`). */
export function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(
    reason !== undefined && reason !== null
      ? String(reason)
      : 'The operation was aborted',
  );
  err.name = 'AbortError';
  return err;
}

/** Create a standardized `TimeoutError` for statement execution timeouts. */
export function createTimeoutError(timeoutMs: number): Error {
  const err = new Error(`Statement timed out after ${timeoutMs}ms`);
  err.name = 'TimeoutError';
  return err;
}

/** Throw immediately if `signal` has already been aborted. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}

/**
 * Race `work()` against an optional `AbortSignal` and/or `timeoutMs` timer,
 * invoking `onCancel()` to cancel the underlying Firebird engine attachment
 * operation if aborted or timed out.
 */
export async function runWithCancellation<T>(
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

/**
 * Shared higher-level database subsystem state (`UdrManager`,
 * `CowSnapshotStore`, `QueryProfiler`) composed into both `FirebirdBrowser`
 * and `FirebirdLite`.
 */
export class DatabaseCoreSubsystems {
  readonly udr = new UdrManager();
  readonly snapshotStore: CowSnapshotStore;
  readonly profiler = new QueryProfiler();

  constructor(pageSize = 8192) {
    this.snapshotStore = new CowSnapshotStore(pageSize);
  }

  /** Clear all in-memory subsystem caches on `db.close()`. */
  clear(): void {
    this.udr.clear();
    this.snapshotStore.clear();
    this.profiler.clear();
  }
}

/** Result returned by the unified single-statement `execute()` method. */
export interface UnifiedExecuteResult {
  /** Number of rows affected by the statement (`INSERT` / `UPDATE` / `DELETE`). */
  affectedRows: number;
  /** Alias for `affectedRows` for compatibility with SQLite / generic SQL adapters. */
  changes: number;
}

/**
 * Unified transaction client contract implemented by both
 * `FirebirdBrowserTransaction` and `FirebirdTransaction`.
 */
export interface FirebirdTransactionClient {
  readonly isFinished: boolean;
  readonly savepointName?: string;
  rollback(): Promise<void>;
  savepoint<T>(fn: (sp: FirebirdTransactionClient) => Promise<T>): Promise<T>;
  savepoint<T>(
    name: string,
    fn: (sp: FirebirdTransactionClient) => Promise<T>,
  ): Promise<T>;
  cancelOperation(): Promise<void>;
  exec(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | StatementExecutionOptions,
    maybeOptions?: StatementExecutionOptions,
  ): Promise<{ affectedRows: number } | void>;
  execute(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: StatementExecutionOptions,
  ): Promise<UnifiedExecuteResult>;
  execBatch(
    sql: string,
    rows: QueryParams[],
  ): Promise<{ affectedRows: number } | void>;
  query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  query<T extends Row = Row>(
    sql: TypedSqlFragment<T>,
    options?: { rowMode?: 'object' | 'array'; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions,
  ): Promise<QueryResult<T>>;
  query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: 'object' | 'array'; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions,
  ): Promise<QueryResult<T>>;
  queryColumnar(
    sql: string | SqlFragment,
    params?: QueryParams | StatementExecutionOptions,
    options?: StatementExecutionOptions,
  ): Promise<ColumnarQueryResult>;
  queryArrow(
    sql: string | SqlFragment,
    params?: QueryParams | (StatementExecutionOptions & ArrowIpcOptions),
    options?: StatementExecutionOptions & ArrowIpcOptions,
  ): Promise<Uint8Array>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | QueryStreamOptions,
    maybeOptions?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  prepare(sql: string | SqlFragment): Promise<PreparedStatement>;
  describeQuery(sql: string | SqlFragment): Promise<QueryDescription>;
  copyFromStream(
    tableName: string,
    stream: ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
    options?: CopyFromOptions,
  ): Promise<CopyResult>;
  copyToStream(
    sql: string | SqlFragment,
    params?: QueryParams | CopyToOptions,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  createBlobStream(options?: BlobStreamOptions): Promise<BlobWritableStream>;
  openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions?: QueryParams | BlobStreamOptions,
    maybeOptions?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Ensure `Symbol.asyncDispose` exists in older ES2020 runtimes so
 * `[Symbol.asyncDispose]()` never binds to `"undefined"`.
 */
export function ensureAsyncDisposeSymbol(): symbol {
  if (typeof (Symbol as { asyncDispose?: symbol }).asyncDispose !== 'symbol') {
    const fallback = Symbol.for('Symbol.asyncDispose');
    try {
      Object.defineProperty(Symbol, 'asyncDispose', {
        value: fallback,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    } catch {
      return fallback;
    }
  }
  return Symbol.asyncDispose;
}
ensureAsyncDisposeSymbol();

/**
 * Unified isomorphic database client contract implemented by both
 * `FirebirdBrowser` (WASM: `memory://`, `idb://`, `opfs://`) and
 * `FirebirdLite` (Node.js native embedded / remote Firebird server).
 */
export interface FirebirdDatabase {
  query(
    sql: SqlFragment,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  query<T extends Row = Row>(
    sql: TypedSqlFragment<T>,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  query<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  /**
   * Execute a `SELECT` query and return typed columnar buffers (`Int32Array`,
   * `Float64Array`, `BigInt64Array`, UTF-8 offset buffers) without allocating
   * per-row JS objects (`M19 Item 2`).
   */
  queryColumnar(
    sql: string | SqlFragment,
    params?: QueryParams | StatementExecutionOptions,
    options?: StatementExecutionOptions,
  ): Promise<ColumnarQueryResult>;
  /**
   * Execute a `SELECT` query and return a standard **Apache Arrow IPC V5**
   * stream (`Uint8Array`) (`M19 Item 2`).
   */
  queryArrow(
    sql: string | SqlFragment,
    params?: QueryParams | (StatementExecutionOptions & ArrowIpcOptions),
    options?: StatementExecutionOptions & ArrowIpcOptions,
  ): Promise<Uint8Array>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | QueryStreamOptions,
    maybeOptions?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  exec(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | StatementExecutionOptions,
    maybeOptions?: StatementExecutionOptions,
  ): Promise<Array<{ affectedRows: number }> | void>;
  /**
   * Unified single-statement execution returning `{ affectedRows, changes }`
   * identically across `FirebirdBrowser` and `FirebirdLite`.
   */
  execute(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: StatementExecutionOptions,
  ): Promise<UnifiedExecuteResult>;
  execBatch(
    sql: string,
    rows: QueryParams[],
  ): Promise<{ affectedRows: number } | void>;
  prepare(sql: string | SqlFragment): Promise<PreparedStatement>;
  transaction<T>(
    fn: (tx: FirebirdTransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  cancelOperation(): Promise<void>;
  describeQuery(sql: string | SqlFragment): Promise<QueryDescription>;
  explain(sql: string | SqlFragment, options?: ExplainOptions): Promise<string>;
  databaseInfo(): Promise<DatabaseInfo>;
  sweep(): Promise<SweepResult>;
  introspect(options?: IntrospectOptions): Promise<SchemaIntrospection>;
  migrate(
    migrations: readonly Migration[],
    options?: MigrateOptions,
  ): Promise<MigrateResult>;
  registerFunction(
    name: string,
    optionsOrFn: RegisterFunctionOptions | JsFunctionHandler,
    maybeFn?: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
  unregisterFunction(name: string): Promise<void>;
  registerProcedure(
    name: string,
    optionsOrFn: RegisterProcedureOptions | JsProcedureHandler,
    maybeFn?: JsProcedureHandler,
  ): Promise<RegisteredRoutine>;
  unregisterProcedure(name: string): Promise<void>;
  snapshot(labelOrOptions?: string | SnapshotOptions): Promise<DatabaseSnapshot>;
  restoreSnapshot(
    snapshotOrId: DatabaseSnapshot | string | Uint8Array,
  ): Promise<void>;
  listSnapshots(): DatabaseSnapshotInfo[];
  deleteSnapshot(snapshotOrId: DatabaseSnapshot | string): boolean;
  exportDiff(
    fromSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
    toSnapshot?: DatabaseSnapshot | string | Uint8Array,
    options?: PageDiffOptions,
  ): Promise<Uint8Array>;
  applyDiff(
    diffBytes: Uint8Array,
    baseSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
    options?: ApplyPageDiffOptions,
  ): Promise<Uint8Array>;
  dumpDataDir(): Promise<Uint8Array>;
  dumpDataStream(options?: DataStreamOptions): ReadableStream<Uint8Array>;
  loadDataStream(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: DataStreamOptions,
  ): Promise<void>;
  copyFromStream(
    tableName: string,
    stream: ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
    options?: CopyFromOptions,
  ): Promise<CopyResult>;
  copyToStream(
    sql: string | SqlFragment,
    params?: QueryParams | CopyToOptions,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  createBlobStream(options?: BlobStreamOptions): Promise<BlobWritableStream>;
  openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions?: QueryParams | BlobStreamOptions,
    maybeOptions?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  onQuery(listener: QueryProfileListener): () => void;
  monitorStats(): Promise<MonitorStats>;
  resetMonitorStats(): void;
  /** Configure Firebird native replica mode when supported by the backend. */
  setReplicaMode?(mode: 'none' | 'read_only' | 'read_write'): Promise<void>;
  /** Apply a native Firebird `"FBCHANGELOG\0"` binary changelog segment when supported. */
  applyChangelog?(
    segment: Uint8Array,
    options?: { transfer?: boolean },
  ): Promise<number>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
