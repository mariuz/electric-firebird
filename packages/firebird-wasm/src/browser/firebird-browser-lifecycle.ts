/**
 * firebird-browser-lifecycle.ts – Parameterized Query Execution & Shutdown
 * Helpers for `FirebirdBrowser` (`M26 Item 5`).
 */

import type {
  PageIoCounters,
  PreparedStatement,
  QueryOptions,
  QueryParams,
  QueryResult,
  Row,
} from '../types';
import type { EngineHandle, EngineTransport } from './engine-transport';
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
