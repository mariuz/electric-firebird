/**
 * firebird-browser-lifecycle.ts – Parameterized Query Execution & Shutdown
 * Helpers for `FirebirdBrowser` (`M26 Item 5`).
 */

import type {
  JsFunctionHandler,
  JsProcedureHandler,
  PageIoCounters,
  PreparedStatement,
  QueryOptions,
  QueryParams,
  QueryResult,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  RegisteredRoutine,
  Row,
} from '../types';
import { assertUdrCallback } from '../shared-driver-ops';
import type { DatabaseLock } from './db-lock';
import { acquireDatabaseLock } from './db-lock';
import type { IndexedDBVFS } from './indexeddb-vfs';
import { openBrowserDatabaseFile } from './firebird-browser-storage';
import type { FirebirdBrowserOptions } from './firebird-browser-types';
import type { EngineHandle, EngineTransport } from './engine-transport';
import { DirectTransport } from './engine-transport';
import { WorkerTransport } from './worker-transport';
import { SharedEngineTransport } from './shared-transport';
import { hasTransactionOptions } from './isolation';
import { applyTypes, type TypeOptions } from './value-types';
import type { QueryProfiler } from './profiler';
import type { UdrManager, UdrSqlExecutor } from './udr';
import {
  assertNotAborted,
  runWithCancellation,
  validateTimeoutMs,
} from '../database-core';
import type { TypedSqlFragment } from '../schema-validation';
import {
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
} from '../shared-driver-ops';
import { resolveQueryCall, type SqlFragment } from '../sql-tag';

export interface BrowserQueryRunnerHost {
  ensureReady: () => Promise<void>;
  getDbHandle: () => EngineHandle;
  engine: EngineTransport;
  types: TypeOptions | undefined;
  udr: UdrManager;
  createUdrExecutor: (txHandle: EngineHandle) => UdrSqlExecutor;
  profiler: QueryProfiler;
  captureIo: () => Promise<PageIoCounters | null>;
  applyOneShotTimeout: (timeoutMs?: number) => Promise<void>;
  cancelOperation: () => Promise<void>;
  serialize: (params: QueryParams) => QueryParams;
}

export async function executeBrowserQuery<T = Row>(
  host: BrowserQueryRunnerHost,
  sql: string | SqlFragment | TypedSqlFragment<T>,
  paramsOrOptions: QueryParams | QueryOptions<T> = [],
  maybeOptions: QueryOptions<T> = {},
): Promise<QueryResult<T>> {
  const { statement, options } = resolveQueryCall(sql, paramsOrOptions, maybeOptions);
  const queryOpts = options as QueryOptions<T>;
  const schema = extractEffectiveQuerySchema<T>(sql, queryOpts);
  assertNotAborted(queryOpts.signal);
  validateTimeoutMs(queryOpts.timeoutMs);

  await host.ensureReady();

  const rowMode = queryOpts.rowMode ?? 'object';
  const binaryBlobs = host.types?.binary === true;

  if (host.udr.hasBridgeRoutines) {
    const rewritten = await host.udr.rewriteStatement(statement.sql, statement.params);
    statement.sql = rewritten.sql;
    statement.params = rewritten.params;
    const intercepted = await host.udr.queryIfIntercepted<T>(
      statement.sql,
      statement.params,
      rowMode,
      host.createUdrExecutor(0),
    );
    if (intercepted) {
      const typedIntercepted = applyTypes(intercepted, host.types, rowMode);
      return finalizeQueryResultWithSchema(typedIntercepted, schema, rowMode);
    }
  }

  const dbHandle = host.getDbHandle();

  if (!hasTransactionOptions(queryOpts)) {
    const startedAt = host.profiler.begin();
    const ioBefore = await host.captureIo();
    try {
      const raw = await runWithCancellation(
        async () => {
          await host.applyOneShotTimeout(queryOpts.timeoutMs);
          return host.engine.query<T>(
            dbHandle,
            0,
            statement.sql,
            host.serialize(statement.params),
            rowMode,
            binaryBlobs,
          );
        },
        queryOpts,
        () => host.cancelOperation(),
      );
      const typed = await finalizeQueryResultWithSchema(
        applyTypes(raw, host.types, rowMode),
        schema,
        rowMode,
      );
      const ioAfter = await host.captureIo();
      host.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        rowCount: typed.rows.length,
        cacheHit: false,
        ioBefore,
        ioAfter,
      });
      return typed;
    } catch (err) {
      host.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        cacheHit: false,
        error: err,
      });
      throw err;
    }
  }

  const startedAt = host.profiler.begin();
  const ioBefore = await host.captureIo();
  const txHandle = await host.engine.startTransaction(dbHandle, queryOpts);
  try {
    const result = await runWithCancellation(
      async () => {
        await host.applyOneShotTimeout(queryOpts.timeoutMs);
        return host.engine.query<T>(
          dbHandle,
          txHandle,
          statement.sql,
          host.serialize(statement.params),
          rowMode,
          binaryBlobs,
        );
      },
      queryOpts,
      () => host.cancelOperation(),
    );
    await host.engine.commit(txHandle);
    const typed = await finalizeQueryResultWithSchema(
      applyTypes(result, host.types, rowMode),
      schema,
      rowMode,
    );
    const ioAfter = await host.captureIo();
    host.profiler.end({
      startedAt,
      sql: statement.sql,
      params: statement.params,
      kind: 'query',
      rowCount: typed.rows.length,
      cacheHit: false,
      ioBefore,
      ioAfter,
    });
    return typed;
  } catch (err) {
    await host.engine.rollback(txHandle).catch(() => undefined);
    host.profiler.end({
      startedAt,
      sql: statement.sql,
      params: statement.params,
      kind: 'query',
      cacheHit: false,
      error: err,
    });
    throw err;
  }
}

export async function teardownBrowserDatabase(ctx: {
  cancelScheduledPersist: () => void;
  detachLifecycleListeners: () => void;
  getPersistInFlight: () => Promise<void> | null;
  preparedStatements: Set<PreparedStatement>;
  liveQueries: Set<{ unsubscribe(): Promise<void> }>;
  markClosedAndClear: () => void;
  getDbHandle: () => EngineHandle;
  resetDbHandle: () => void;
  persist: () => Promise<void>;
  engine: EngineTransport;
  dbPath: string;
  opfs: boolean;
  ephemeral: boolean;
  closeVfs: () => Promise<void>;
  releaseLock: () => Promise<void>;
}): Promise<void> {
  ctx.cancelScheduledPersist();
  ctx.detachLifecycleListeners();

  const inFlight = ctx.getPersistInFlight();
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // Already reported through onPersistError.
    }
  }

  for (const stmt of [...ctx.preparedStatements]) {
    await stmt.close().catch(() => undefined);
  }
  for (const live of [...ctx.liveQueries]) {
    await live.unsubscribe().catch(() => undefined);
  }

  ctx.markClosedAndClear();

  const handle = ctx.getDbHandle();
  if (handle) {
    await ctx.persist();
    await ctx.engine.detachDatabase(handle);
    ctx.resetDbHandle();
  }

  try {
    if (!ctx.opfs) {
      if (ctx.ephemeral) {
        await ctx.engine.unlink(ctx.dbPath).catch(() => undefined);
      } else {
        await ctx.closeVfs();
      }
    }
    await ctx.engine.dispose();
  } finally {
    await ctx.releaseLock();
  }
}

export async function initializeBrowserDatabase(ctx: {
  multiTab: 'exclusive' | 'shared' | 'allow-unsafe';
  dbName: string;
  fileName: string;
  lockTimeoutMs: number;
  opfs: boolean;
  ephemeral: boolean;
  options: FirebirdBrowserOptions;
  engine: EngineTransport;
  vfs: IndexedDBVFS;
  getDbPath: () => string;
  getMayPersist: () => boolean;
  setLock: (lock: DatabaseLock | null) => void;
  releaseLock: () => Promise<void>;
  setOpfsPath: (p: string) => void;
  setDbHandle: (h: EngineHandle) => void;
  applyIcuLocaleData: (data: Uint8Array | ArrayBufferLike) => Promise<void>;
  attachLifecycleListeners: () => void;
}): Promise<void> {
  if (ctx.multiTab === 'exclusive') {
    ctx.setLock(
      await acquireDatabaseLock(ctx.dbName, {
        timeoutMs: ctx.lockTimeoutMs,
      }),
    );
  }
  try {
    await ctx.engine.init();
    if (ctx.options.icuLocaleData) {
      const localeBytes =
        typeof ctx.options.icuLocaleData === 'function'
          ? await ctx.options.icuLocaleData()
          : ctx.options.icuLocaleData;
      await ctx.applyIcuLocaleData(localeBytes);
    }
    if (ctx.opfs) {
      ctx.setOpfsPath(await ctx.engine.mountOpfs(ctx.fileName));
    } else if (!ctx.ephemeral) {
      await ctx.vfs.open(ctx.dbName);
    }
    const handle = await openBrowserDatabaseFile({
      engine: ctx.engine,
      dbPath: ctx.getDbPath(),
      mayPersist: ctx.getMayPersist(),
      exportStored: () => ctx.vfs.exportDatabase(),
      loadDataDir: ctx.options.loadDataDir,
      loadDataStream: ctx.options.loadDataStream,
      sharedReads: ctx.options.sharedReads,
    });
    ctx.setDbHandle(handle);
  } catch (err) {
    await ctx.releaseLock();
    throw err;
  }
  ctx.attachLifecycleListeners();
}

export async function registerBrowserFunction(
  ctx: {
    isClosed: () => boolean;
    ensureReady: () => Promise<void>;
    udr: UdrManager;
    createUdrExecutor: (tx: EngineHandle) => UdrSqlExecutor;
    markDirty: () => void;
  },
  name: string,
  optionsOrFn: RegisterFunctionOptions | JsFunctionHandler,
  maybeFn?: JsFunctionHandler,
): Promise<RegisteredRoutine> {
  if (ctx.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  assertUdrCallback('registerFunction', optionsOrFn, maybeFn);
  await ctx.ensureReady();
  const handle = await ctx.udr.registerFunction(
    name,
    optionsOrFn,
    maybeFn,
    ctx.createUdrExecutor(0),
  );
  ctx.markDirty();
  return handle;
}

export async function registerBrowserProcedure(
  ctx: {
    isClosed: () => boolean;
    ensureReady: () => Promise<void>;
    udr: UdrManager;
    createUdrExecutor: (tx: EngineHandle) => UdrSqlExecutor;
    markDirty: () => void;
  },
  name: string,
  optionsOrFn: RegisterProcedureOptions | JsProcedureHandler,
  maybeFn?: JsProcedureHandler,
): Promise<RegisteredRoutine> {
  if (ctx.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  assertUdrCallback('registerProcedure', optionsOrFn, maybeFn);
  await ctx.ensureReady();
  const handle = await ctx.udr.registerProcedure(
    name,
    optionsOrFn,
    maybeFn,
    ctx.createUdrExecutor(0),
  );
  ctx.markDirty();
  return handle;
}

export function createBrowserEngineTransport(ctx: {
  multiTab: 'exclusive' | 'shared' | 'allow-unsafe';
  dbName: string;
  options: FirebirdBrowserOptions;
  onServedMutation: () => void;
  onEngineReplaced: () => Promise<void>;
}): { engine: EngineTransport; shared: SharedEngineTransport | null } {
  const createLocal = (): EngineTransport => {
    const worker = ctx.options.worker;
    if (worker) {
      return new WorkerTransport(typeof worker === 'function' ? worker() : worker);
    }
    return new DirectTransport({
      wasmBinary: ctx.options.wasmBinary,
      locateFile: ctx.options.locateFile,
      threads: ctx.options.threads,
    });
  };

  if (ctx.multiTab !== 'shared') {
    return { engine: createLocal(), shared: null };
  }
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error(
      "multiTab: 'shared' needs BroadcastChannel, which this environment " +
        "does not have. Use 'exclusive' instead.",
    );
  }
  const shared = new SharedEngineTransport({
    dbName: ctx.dbName,
    createEngine: createLocal,
    onServedMutation: ctx.onServedMutation,
    onEngineReplaced: ctx.onEngineReplaced,
  });
  return { engine: shared, shared };
}

export class BrowserPersistScheduler {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistAgain = false;
  private lifecycleAttached = false;
  persistInFlight: Promise<void> | null = null;

  constructor(
    private readonly cfg: {
      autoPersist: boolean;
      debounceMs: number;
      onError: (err: Error) => void;
      isClosed: () => boolean;
      canPersistNow: () => boolean;
      readAndImport: () => Promise<void>;
    },
  ) {}

  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.cancelScheduled();
      void this.persistInBackground();
    }
  };

  private readonly onPageHide = (): void => {
    this.cancelScheduled();
    void this.persistInBackground();
  };

  async persist(): Promise<void> {
    if (!this.cfg.canPersistNow()) return;
    if (this.persistInFlight) {
      this.persistAgain = true;
      await this.persistInFlight;
      return;
    }
    this.cancelScheduled();
    const run = this.cfg.readAndImport();
    this.persistInFlight = run;
    try {
      await run;
    } finally {
      this.persistInFlight = null;
    }
    if (this.persistAgain) {
      this.persistAgain = false;
      await this.persist();
    }
  }

  markDirty(): void {
    if (!this.cfg.autoPersist || this.cfg.isClosed() || !this.cfg.canPersistNow()) {
      return;
    }
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistInBackground();
    }, this.cfg.debounceMs);
  }

  cancelScheduled(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  async persistInBackground(): Promise<void> {
    if (this.cfg.isClosed()) return;
    try {
      await this.persist();
    } catch (err) {
      this.cfg.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  attachLifecycle(): void {
    if (this.lifecycleAttached || !this.cfg.autoPersist) return;
    if (typeof document === 'undefined' || typeof addEventListener !== 'function') {
      return;
    }
    this.lifecycleAttached = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    addEventListener('pagehide', this.onPageHide);
  }

  detachLifecycle(): void {
    if (!this.lifecycleAttached) return;
    this.lifecycleAttached = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    removeEventListener('pagehide', this.onPageHide);
  }
}

export async function reopenBrowserDatabaseAfterEngineChange(ctx: {
  isClosed: () => boolean;
  setDbHandle: (h: EngineHandle) => void;
  engine: EngineTransport;
  dbPath: string;
  mayPersist: boolean;
  exportStored: () => Promise<Uint8Array>;
  options: FirebirdBrowserOptions;
  onError: (err: Error) => void;
}): Promise<void> {
  if (ctx.isClosed()) return;
  ctx.setDbHandle(0);
  try {
    const handle = await openBrowserDatabaseFile({
      engine: ctx.engine,
      dbPath: ctx.dbPath,
      mayPersist: ctx.mayPersist,
      exportStored: ctx.exportStored,
      loadDataDir: ctx.options.loadDataDir,
      loadDataStream: ctx.options.loadDataStream,
      sharedReads: ctx.options.sharedReads,
    });
    ctx.setDbHandle(handle);
  } catch (err) {
    ctx.onError(
      err instanceof Error
        ? err
        : new Error(`could not reopen after a leadership change: ${String(err)}`),
    );
  }
}

export async function closeBrowserDatabaseFull(ctx: {
  cancelScheduledPersist: () => void;
  detachLifecycle: () => void;
  getPersistInFlight: () => Promise<void> | null;
  preparedStatements: Set<PreparedStatement>;
  liveQueries: Set<{ unsubscribe(): Promise<void> }>;
  markClosedAndClear: () => void;
  getDbHandle: () => EngineHandle;
  resetDbHandle: () => void;
  persist: () => Promise<void>;
  engine: EngineTransport;
  dbPath: string;
  opfs: boolean;
  ephemeral: boolean;
  closeVfs: () => Promise<void>;
  releaseLock: () => Promise<void>;
}): Promise<void> {
  return teardownBrowserDatabase({
    cancelScheduledPersist: ctx.cancelScheduledPersist,
    detachLifecycleListeners: ctx.detachLifecycle,
    getPersistInFlight: ctx.getPersistInFlight,
    preparedStatements: ctx.preparedStatements,
    liveQueries: ctx.liveQueries,
    markClosedAndClear: ctx.markClosedAndClear,
    getDbHandle: ctx.getDbHandle,
    resetDbHandle: ctx.resetDbHandle,
    persist: ctx.persist,
    engine: ctx.engine,
    dbPath: ctx.dbPath,
    opfs: ctx.opfs,
    ephemeral: ctx.ephemeral,
    closeVfs: ctx.closeVfs,
    releaseLock: ctx.releaseLock,
  });
}
