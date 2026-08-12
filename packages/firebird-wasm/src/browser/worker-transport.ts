/**
 * worker-transport.ts – reaches the engine running in a Web Worker.
 *
 * Browsers have to use this.  The build uses pthreads, Firebird blocks on
 * mutexes while opening a database, and a browser main thread is not allowed
 * to block, so calling the engine from a page deadlocks.  Inside a Worker
 * blocking is fine.
 *
 * The Worker also owns Emscripten's filesystem, which is why the filesystem
 * operations are part of the transport rather than being done by the caller.
 */

import type {
  Row,
  QueryResult,
  QueryDescription,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';
import type { EngineHandle, EngineTransport } from './engine-transport';
import type { EngineOp, EngineRequest, EngineResponse } from './worker-protocol';

/** Options accepted by {@link WorkerTransport}. */
export interface WorkerTransportOptions {
  /**
   * How long to wait for a single call before rejecting, in milliseconds.
   *
   * Creating a database is slow — the engine writes the whole system
   * catalogue — so this is generous by default.  Without a timeout a Worker
   * that dies mid-call would leave the caller waiting forever.
   *
   * @default 120000
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Forwards {@link EngineTransport} calls to a Worker over `postMessage`.
 *
 * @example
 * ```ts
 * const worker = new Worker('/firebird-engine-worker.js');
 * const db = new FirebirdBrowser('mydb', { worker });
 * ```
 */
export class WorkerTransport implements EngineTransport {
  private readonly worker: Worker;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;

  constructor(worker: Worker, options: WorkerTransportOptions = {}) {
    this.worker = worker;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onError);
  }

  private readonly onMessage = (event: MessageEvent<EngineResponse>): void => {
    const data = event.data;

    // id -1 is the Worker reporting that its own bootstrap failed; there is no
    // request to answer, so fail everything outstanding and everything later.
    if (data.id === -1) {
      this.fail(new Error(data.error ?? 'engine worker failed to start'));
      return;
    }

    const entry = this.pending.get(data.id);
    if (!entry) return; // already timed out, or a stray reply

    this.pending.delete(data.id);
    clearTimeout(entry.timer);

    if (data.ok) {
      entry.resolve(data.result as never);
    } else {
      entry.reject(new Error(data.error ?? 'engine worker returned an error'));
    }
  };

  private readonly onError = (event: ErrorEvent): void => {
    this.fail(new Error(`engine worker error: ${event.message}`));
  };

  /** Reject everything outstanding and refuse further calls. */
  private fail(error: Error): void {
    this.failure = error;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(op: EngineOp, ...args: unknown[]): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const id = this.nextId++;
    const request: EngineRequest = { id, op, args };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`engine worker timed out after ${this.timeoutMs}ms: ${op}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
      });

      this.worker.postMessage(request);
    });
  }

  init(): Promise<void> {
    return this.call<void>('init');
  }

  createDatabase(path: string): Promise<EngineHandle> {
    return this.call<EngineHandle>('createDatabase', path);
  }

  attachDatabase(path: string): Promise<EngineHandle> {
    return this.call<EngineHandle>('attachDatabase', path);
  }

  detachDatabase(dbHandle: EngineHandle): Promise<void> {
    return this.call<void>('detachDatabase', dbHandle);
  }

  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
  ): Promise<number> {
    return this.call<number>('execute', dbHandle, txHandle, sql, params);
  }

  query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
    rowMode: RowMode = 'object',
    binaryBlobs = false,
  ): Promise<QueryResult<T>> {
    // Decoding happens on the far side, so both of these have to travel with
    // the call rather than being applied to what comes back. They are a string
    // and a boolean, so they survive structured cloning like the rest of the
    // arguments — and the Uint8Arrays that come back from a side-channelled
    // BLOB survive it too, which is what made this placement possible.
    return this.call<QueryResult<T>>(
      'query',
      dbHandle,
      txHandle,
      sql,
      params,
      rowMode,
      binaryBlobs,
    );
  }

  describe(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription> {
    return this.call<QueryDescription>('describe', dbHandle, txHandle, sql);
  }

  startTransaction(
    dbHandle: EngineHandle,
    options: TransactionOptions = {},
  ): Promise<EngineHandle> {
    // Plain data, so it survives structured cloning to the Worker as-is.
    return this.call<EngineHandle>('startTransaction', dbHandle, options);
  }

  commit(txHandle: EngineHandle): Promise<void> {
    return this.call<void>('commit', txHandle);
  }

  rollback(txHandle: EngineHandle): Promise<void> {
    return this.call<void>('rollback', txHandle);
  }

  mkdir(path: string): Promise<void> {
    return this.call<void>('mkdir', path);
  }

  exists(path: string): Promise<boolean> {
    return this.call<boolean>('exists', path);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.call<Uint8Array>('readFile', path);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.call<void>('writeFile', path, data);
  }

  unlink(path: string): Promise<void> {
    return this.call<void>('unlink', path);
  }

  eventsSubscribe(dbHandle: EngineHandle, names: string[]): Promise<number> {
    return this.call<number>('eventsSubscribe', dbHandle, names);
  }

  eventsPoll(subscription: number): Promise<Record<string, number>> {
    return this.call<Record<string, number>>('eventsPoll', subscription);
  }

  eventsCancel(subscription: number): Promise<void> {
    return this.call<void>('eventsCancel', subscription);
  }

  mountOpfs(dbName: string): Promise<string> {
    // The mount happens on the far side; only the resulting path comes back.
    return this.call<string>('mountOpfs', dbName);
  }

  async dispose(): Promise<void> {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.fail(new Error('engine worker disposed'));
    this.worker.terminate();
  }
}
