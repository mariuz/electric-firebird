/**
 * firebird-browser-streams.ts – Prepared statement handles, cursor streaming,
 * Firebird event listening, and reactive live query helpers for `FirebirdBrowser` (`M22 Item 5`).
 */

import type { EngineHandle, EngineTransport } from './engine-transport';
import {
  extractMutatedTables,
  extractReferencedTables,
  liveTableTriggerDDL,
  type CrossTabLiveBridge,
} from './live-tables';
import { hasTransactionOptions } from './isolation';
import { applyTypes, type TypeOptions } from './value-types';
import { resolveBatchSize, toStatement, type SqlFragment, type Statement } from '../sql-tag';
import {
  assertNotAborted,
  createTimeoutError,
  runWithCancellation,
  validateTimeoutMs,
} from '../database-core';
import type { ColumnarQueryResult } from '../columnar';
import {
  createLiveColumnarQuery,
  createLiveIncrementalQuery,
  type IncrementalLiveSnapshot,
  type LiveColumnarOptions,
  type LiveColumnarQuery,
  type LiveIncrementalOptions,
  type LiveIncrementalQuery,
} from '../live-incremental';
import {
  assertBatchParameterRows,
  assertPreparedParamCount,
  decodePayloadColumnar,
  executeColumnarViaArrayQuery,
  finalizeQueryResultWithSchema,
  resolveColumnarQueryCall,
  resolvePreparedCallArgs,
} from '../shared-driver-ops';
import {
  createColumnarStreamFromRowStream,
  resolveColumnarStreamArgs,
  streamBinaryColumnarCursor,
  type ColumnarStreamOptions,
} from '../columnar-stream';
import type { QueryProfiler } from './profiler';
import type {
  ArrayRow,
  FieldInfo,
  PageIoCounters,
  PreparedStatement,
  QueryDescription,
  QueryOptions,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
  Row,
  StatementExecutionOptions,
} from '../types';
import type {
  EventSubscription,
  ListenOptions,
  LiveQuery,
  LiveQueryOptions,
} from './firebird-browser-types';

export interface BrowserStreamsHost {
  ensureReady(): Promise<void>;
  isClosed(): boolean;
  readonly engine: EngineTransport;
  getDbHandle(): EngineHandle;
  readonly types: TypeOptions | undefined;
  readonly profiler: QueryProfiler;
  readonly liveBridge: CrossTabLiveBridge;
  readonly liveQueries: Set<{ unsubscribe(): Promise<void> }>;
  readonly liveTriggerPromises: Map<string, Promise<string>>;
  readonly preparedStatements: Set<PreparedStatement>;
  readonly columnarShapeCache: Map<number, readonly FieldInfo[]>;
  hasBridgeRoutines(): boolean;
  serialize(params: QueryParams): QueryParams;
  applyOneShotTimeout(timeoutMs: number | undefined): Promise<void>;
  cancelOperation(): Promise<void>;
  captureIoIfListening(): Promise<PageIoCounters | null>;
  markDirty(): void;
  query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  queryColumnar(sql: string | SqlFragment, params?: QueryParams): Promise<ColumnarQueryResult>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  execBatch(sql: string, rows: QueryParams[]): Promise<{ affectedRows: number }>;
}

export async function queryBrowserPreparedHandle<T = Row>(
  host: BrowserStreamsHost,
  stmtHandle: EngineHandle,
  params: QueryParams,
  options: QueryOptions<T> = {},
  sqlText = '<prepared>',
): Promise<QueryResult<T>> {
  assertNotAborted(options.signal);
  validateTimeoutMs(options.timeoutMs);
  await host.ensureReady();

  const rowMode = options.rowMode ?? 'object';
  const binaryBlobs = host.types?.binary === true;
  const serialized = host.serialize(params);
  const startedAt = host.profiler.begin();
  const ioBefore = await host.captureIoIfListening();

  if (!hasTransactionOptions(options)) {
    try {
      const raw = await runWithCancellation(
        async () => {
          await host.applyOneShotTimeout(options.timeoutMs);
          return host.engine.queryStmt!<T>(
            host.getDbHandle(),
            0,
            stmtHandle,
            serialized,
            rowMode,
            binaryBlobs,
          );
        },
        options,
        () => host.cancelOperation(),
      );
      const typed = await finalizeQueryResultWithSchema(
        applyTypes(raw, host.types, rowMode),
        options.schema,
        rowMode,
      );
      const ioAfter = await host.captureIoIfListening();
      host.profiler.end({
        startedAt,
        sql: sqlText,
        params,
        kind: 'prepared',
        rowCount: typed.rows.length,
        cacheHit: true,
        ioBefore,
        ioAfter,
      });
      return typed;
    } catch (err) {
      host.profiler.end({
        startedAt,
        sql: sqlText,
        params,
        kind: 'prepared',
        cacheHit: true,
        error: err,
      });
      throw err;
    }
  }

  const txHandle = await host.engine.startTransaction(host.getDbHandle(), options);
  try {
    const result = await runWithCancellation(
      async () => {
        await host.applyOneShotTimeout(options.timeoutMs);
        return host.engine.queryStmt!<T>(
          host.getDbHandle(),
          txHandle,
          stmtHandle,
          serialized,
          rowMode,
          binaryBlobs,
        );
      },
      options,
      () => host.cancelOperation(),
    );
    await host.engine.commit(txHandle);
    const typed = await finalizeQueryResultWithSchema(
      applyTypes(result, host.types, rowMode),
      options.schema,
      rowMode,
    );
    const ioAfter = await host.captureIoIfListening();
    host.profiler.end({
      startedAt,
      sql: sqlText,
      params,
      kind: 'prepared',
      rowCount: typed.rows.length,
      cacheHit: true,
      ioBefore,
      ioAfter,
    });
    return typed;
  } catch (err) {
    await host.engine.rollback(txHandle).catch(() => undefined);
    host.profiler.end({
      startedAt,
      sql: sqlText,
      params,
      kind: 'prepared',
      cacheHit: true,
      error: err,
    });
    throw err;
  }
}

export async function* streamBrowserQuery<T>(
  host: BrowserStreamsHost,
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

  await host.ensureReady();

  const rowMode = options.rowMode ?? 'object';
  const binaryBlobs = host.types?.binary === true;
  const serializedParams = host.serialize(statement.params);
  const useStmtCursor =
    stmtHandle > 0 && typeof host.engine.cursorOpenStmt === 'function';

  if (
    (!useStmtCursor && typeof host.engine.cursorOpen !== 'function') ||
    typeof host.engine.cursorFetch !== 'function' ||
    typeof host.engine.cursorClose !== 'function'
  ) {
    const full = (
      stmtHandle > 0 && typeof host.engine.queryStmt === 'function'
        ? await queryBrowserPreparedHandle<T>(
            host,
            stmtHandle,
            statement.params,
            options as QueryOptions<T>,
          )
        : await host.query(
            statement.sql,
            statement.params,
            options as QueryOptions<Row>,
          )
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
      txHandle = await host.engine.startTransaction(host.getDbHandle(), options);
      ownsTxHandle = true;
    }

    try {
      cursorHandle = await runWithCancellation(
        async () => {
          await host.applyOneShotTimeout(totalTimeoutMs);
          return useStmtCursor
            ? host.engine.cursorOpenStmt!(
                host.getDbHandle(),
                txHandle,
                stmtHandle,
                serializedParams,
              )
            : host.engine.cursorOpen!(
                host.getDbHandle(),
                txHandle,
                statement.sql,
                serializedParams,
              );
        },
        stepOptions(),
        () => host.cancelOperation(),
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
            host.engine.cursorFetch!<T>(
              cursorHandle,
              batchSize,
              rowMode,
              binaryBlobs,
            ),
          stepOptions(),
          () => host.cancelOperation(),
        );
      } catch (err) {
        engineFailed = true;
        throw err;
      }

      if (batch.rows.length === 0) {
        break;
      }

      yield applyTypes(batch, host.types, rowMode);
    }

    const toClose = cursorHandle;
    cursorHandle = 0;
    await host.engine.cursorClose(toClose);

    if (ownsTxHandle && txHandle !== 0) {
      const toCommit = txHandle;
      txHandle = 0;
      ownsTxHandle = false;
      await host.engine.commit(toCommit);
    }
  } finally {
    if (cursorHandle !== 0) {
      await host.engine.cursorClose(cursorHandle).catch(() => undefined);
    }
    if (ownsTxHandle && txHandle !== 0) {
      if (engineFailed) {
        await host.engine.rollback(txHandle).catch(() => undefined);
      } else {
        await host.engine
          .commit(txHandle)
          .catch(() => host.engine.rollback(txHandle).catch(() => undefined));
      }
    }
  }
}

export async function ensureBrowserLiveTableEvents(
  host: BrowserStreamsHost,
  sqlText: string,
): Promise<string[]> {
  const tables = extractReferencedTables(sqlText);
  if (tables.length === 0) {
    throw new RangeError(
      'live() could not find any user tables in the statement to watch automatically; ' +
        'pass { events: [...] } explicitly',
    );
  }
  const events: string[] = [];
  for (const table of tables) {
    let pending = host.liveTriggerPromises.get(table);
    if (!pending) {
      const { eventName, ddl } = liveTableTriggerDDL(table);
      pending = host.engine
        .execute(host.getDbHandle(), 0, ddl, [])
        .then(() => {
          host.markDirty();
          return eventName;
        })
        .catch((err) => {
          host.liveTriggerPromises.delete(table);
          throw err;
        });
      host.liveTriggerPromises.set(table, pending);
    }
    events.push(await pending);
  }
  return events;
}

export async function listenBrowserEvents(
  host: BrowserStreamsHost,
  names: string | string[],
  onEvent: (counts: Record<string, number>) => void,
  options: ListenOptions = {},
): Promise<EventSubscription> {
  await host.ensureReady();

  const watched = typeof names === 'string' ? [names] : names;
  if (watched.length === 0) {
    throw new RangeError('listen() needs at least one event name');
  }

  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const onError =
    options.onError ??
    ((error: Error) => console.error('[firebird-wasm] event listener failed', error));

  const handle = await host.engine.eventsSubscribe(host.getDbHandle(), watched);

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const counts = await host.engine.eventsPoll(handle);
      const fired = Object.fromEntries(
        Object.entries(counts).filter(([, count]) => count > 0),
      );
      if (Object.keys(fired).length > 0 && !stopped) {
        host.liveBridge.broadcastEvents(fired);
        onEvent(fired);
      }
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
      unsubCrossTab();
      if (timer !== null) clearInterval(timer);
      host.liveQueries.delete(subscription);
      await host.engine.eventsCancel(handle).catch(() => undefined);
    },
  };

  const unsubCrossTab = host.liveBridge.subscribe(watched, (fired) => {
    if (!stopped) onEvent(fired);
  });
  timer = setInterval(() => void tick(), pollIntervalMs);
  host.liveQueries.add(subscription);

  return subscription;
}

export async function runBrowserLiveQuery<T extends Row = Row>(
  host: BrowserStreamsHost,
  sql: string | SqlFragment,
  optionsOrOnChange: LiveQueryOptions | ((rows: T[], result: QueryResult<T>) => void),
  maybeOnChange?: (rows: T[], result: QueryResult<T>) => void,
): Promise<LiveQuery<T>> {
  await host.ensureReady();

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
      : await ensureBrowserLiveTableEvents(host, statement.sql);

  const onError =
    options.onError ??
    ((error: Error) => console.error('[firebird-wasm] live query failed', error));

  let rows: T[] = [];
  let stopped = false;
  let refreshing = false;
  let again = false;

  const run = async (): Promise<void> => {
    const result = await host.query<T>(statement.sql, statement.params);
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

  const subscription = await listenBrowserEvents(host, watchedEvents, requestRefresh, {
    pollIntervalMs: options.pollIntervalMs,
    onError,
  });

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

  return {
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
}

export async function runBrowserLiveIncremental<T extends Row = Row>(
  host: BrowserStreamsHost,
  sql: string | SqlFragment,
  optionsOrListener?:
    | LiveIncrementalOptions<T>
    | ((snapshot: IncrementalLiveSnapshot<T>) => void),
  maybeListener?: (snapshot: IncrementalLiveSnapshot<T>) => void,
): Promise<LiveIncrementalQuery<T>> {
  await host.ensureReady();
  const opts: LiveIncrementalOptions<T> =
    typeof optionsOrListener === 'function' ? {} : (optionsOrListener ?? {});
  const listener =
    typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener;

  return createLiveIncrementalQuery<T>(
    {
      query: (qSql, qParams, qOpts) => host.query<T>(qSql, qParams, qOpts),
      queryColumnar: (qSql, qParams) => host.queryColumnar(qSql, qParams),
      watchSqlEvents: async (sqlText, explicitEvents, onWakeup, watchOpts) => {
        const watched =
          explicitEvents !== undefined
            ? [...explicitEvents]
            : await ensureBrowserLiveTableEvents(host, sqlText);
        const sub = await listenBrowserEvents(host, watched, onWakeup, watchOpts);
        return () => sub.unsubscribe();
      },
    },
    sql,
    opts,
    listener,
  );
}

export async function runBrowserLiveColumnar(
  host: BrowserStreamsHost,
  sql: string | SqlFragment,
  optionsOrListener?:
    | LiveColumnarOptions
    | ((result: ColumnarQueryResult, version: number) => void),
  maybeListener?: (result: ColumnarQueryResult, version: number) => void,
): Promise<LiveColumnarQuery> {
  await host.ensureReady();
  const opts: LiveColumnarOptions =
    typeof optionsOrListener === 'function' ? {} : (optionsOrListener ?? {});
  const listener =
    typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener;

  return createLiveColumnarQuery(
    {
      queryColumnar: (qSql, qParams) => host.queryColumnar(qSql, qParams),
      watchSqlEvents: async (sqlText, explicitEvents, onWakeup, watchOpts) => {
        const watched =
          explicitEvents !== undefined
            ? [...explicitEvents]
            : await ensureBrowserLiveTableEvents(host, sqlText);
        const sub = await listenBrowserEvents(host, watched, onWakeup, watchOpts);
        return () => sub.unsubscribe();
      },
    },
    sql,
    opts,
    listener,
  );
}

export async function createBrowserPreparedStatement(
  host: BrowserStreamsHost,
  sql: string | SqlFragment,
): Promise<PreparedStatement> {
  await host.ensureReady();
  const sqlText = toStatement(sql).sql;
  const desc: QueryDescription & { handle?: EngineHandle } =
    typeof host.engine.prepare === 'function'
      ? await host.engine.prepare(host.getDbHandle(), 0, sqlText)
      : await host.engine.describe(host.getDbHandle(), 0, sqlText);

  const params = desc.params.map((p) => ({ ...p }));
  const fields = desc.fields.map((f) => ({ ...f }));
  const stmtHandle = desc.handle ?? 0;
  let isClosed = false;
  let currentTimeoutMs = 0;

  const assertOpen = (): void => {
    if (isClosed || host.isClosed()) {
      throw new Error('PreparedStatement has been closed');
    }
  };

  const checkParamCount = (actual: number): void => {
    assertPreparedParamCount(params.length, actual);
  };

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
      return isClosed || host.isClosed();
    },
    get timeoutMs() {
      return currentTimeoutMs;
    },
    setTimeout: async (timeoutMs: number) => {
      assertOpen();
      const validated = validateTimeoutMs(timeoutMs) ?? 0;
      currentTimeoutMs = validated;
      if (stmtHandle > 0 && typeof host.engine.stmtSetTimeout === 'function') {
        await host.engine.stmtSetTimeout(stmtHandle, validated);
      }
    },
    query: (async <T = Row>(
      paramsOrOptions: QueryParams | QueryOptions<T> = [],
      maybeOptions: QueryOptions<T> = {},
    ) => {
      assertOpen();
      const { callParams, callOptions } = resolvePreparedCallArgs<QueryOptions<T>>(
        paramsOrOptions,
        maybeOptions,
        currentTimeoutMs,
      );
      checkParamCount(callParams.length);
      if (stmtHandle > 0 && typeof host.engine.queryStmt === 'function') {
        return queryBrowserPreparedHandle<T>(host, stmtHandle, callParams, callOptions, sqlText);
      }
      return host.query<T & Row>(sqlText, callParams, callOptions as QueryOptions<T & Row>);
    }) as PreparedStatement['query'],
    queryStream: ((
      paramsOrOptions: QueryParams | QueryStreamOptions = [],
      maybeOptions: QueryStreamOptions = {},
    ) => {
      assertOpen();
      const { callParams, callOptions } = resolvePreparedCallArgs<QueryStreamOptions>(
        paramsOrOptions,
        maybeOptions,
        currentTimeoutMs,
      );
      checkParamCount(callParams.length);
      validateTimeoutMs(callOptions.timeoutMs);
      const batchSize = resolveBatchSize(callOptions.batchSize);
      const openStream = () =>
        stmtHandle > 0
          ? streamBrowserQuery(
              host,
              { sql: sqlText, params: callParams },
              callOptions,
              batchSize,
              stmtHandle,
            )
          : host.queryStream(sqlText, callParams, callOptions);
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
      await host.ensureReady();
      const serialized = host.serialize(callParams);
      const affectedRows = await runWithCancellation(
        async () => {
          await host.applyOneShotTimeout(effectiveOptions.timeoutMs);
          return stmtHandle > 0 && typeof host.engine.executeStmt === 'function'
            ? host.engine.executeStmt(
                host.getDbHandle(),
                0,
                stmtHandle,
                serialized,
              )
            : host.engine.execute(
                host.getDbHandle(),
                0,
                sqlText,
                serialized,
              );
        },
        effectiveOptions,
        () => host.cancelOperation(),
      );
      host.markDirty();
      host.liveBridge.broadcastTables(extractMutatedTables(sqlText));
      return { affectedRows };
    },
    execBatch: async (rows: QueryParams[]) => {
      assertOpen();
      assertBatchParameterRows(rows, params.length);
      if (
        stmtHandle > 0 &&
        typeof host.engine.executeBatchStmt === 'function'
      ) {
        await host.ensureReady();
        const affectedRows = await host.engine.executeBatchStmt(
          host.getDbHandle(),
          0,
          stmtHandle,
          rows.map((row) => host.serialize(row)),
        );
        if (rows.length > 0) {
          host.markDirty();
          host.liveBridge.broadcastTables(extractMutatedTables(sqlText));
        }
        return { affectedRows };
      }
      return host.execBatch(sqlText, rows);
    },
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      host.preparedStatements.delete(stmt);
      if (
        stmtHandle > 0 &&
        !host.isClosed() &&
        typeof host.engine.stmtClose === 'function'
      ) {
        await host.engine.stmtClose(stmtHandle).catch(() => undefined);
      }
    },
    [Symbol.asyncDispose]: async () => {
      await stmt.close();
    },
  };

  host.preparedStatements.add(stmt);
  return stmt;
}

export async function executeBrowserQueryColumnar(
  host: BrowserStreamsHost,
  queryArray: (sql: string, params: QueryParams, opts: StatementExecutionOptions) => Promise<QueryResult<ArrayRow>>,
  sql: string | SqlFragment,
  paramsOrOptions: QueryParams | StatementExecutionOptions = [],
  maybeOptions: StatementExecutionOptions = {},
): Promise<ColumnarQueryResult> {
  const { statement, options } = resolveColumnarQueryCall(
    sql,
    paramsOrOptions,
    maybeOptions,
  );
  assertNotAborted(options.signal);
  validateTimeoutMs(options.timeoutMs);
  await host.ensureReady();

  if (
    typeof host.engine.queryBinary === 'function' &&
    !host.hasBridgeRoutines()
  ) {
    const startedAt = host.profiler.begin();
    const ioBefore = await host.captureIoIfListening();
    try {
      const payload = await runWithCancellation(
        async () => {
          await host.applyOneShotTimeout(options.timeoutMs);
          return host.engine.queryBinary!(
            host.getDbHandle(),
            0,
            statement.sql,
            host.serialize(statement.params),
            true,
          );
        },
        options,
        () => host.cancelOperation(),
      );
      const columnar = decodePayloadColumnar(payload, host.columnarShapeCache);
      const ioAfter = await host.captureIoIfListening();
      host.profiler.end({
        startedAt,
        sql: statement.sql,
        params: statement.params,
        kind: 'query',
        rowCount: columnar.rowCount,
        cacheHit: false,
        ioBefore,
        ioAfter,
      });
      return columnar;
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

  return executeColumnarViaArrayQuery(() =>
    queryArray(statement.sql, statement.params, options),
  );
}

export function executeBrowserQueryColumnarStream(
  host: BrowserStreamsHost,
  sql: string | SqlFragment,
  paramsOrOptions?: QueryParams | ColumnarStreamOptions,
  maybeOptions?: ColumnarStreamOptions,
): AsyncIterableIterator<ColumnarQueryResult> {
  const { params, options } = resolveColumnarStreamArgs(paramsOrOptions, maybeOptions);
  const statement = toStatement(sql, params ?? []);
  const batchSize = Math.max(1, Math.floor(options?.batchSize ?? 1024));

  if (
    typeof host.engine.cursorOpen === 'function' &&
    typeof host.engine.cursorFetchBinary === 'function' &&
    typeof host.engine.cursorClose === 'function' &&
    !host.hasBridgeRoutines()
  ) {
    return streamBinaryColumnarCursor({
      ensureReady: () => host.ensureReady(),
      openCursor: () =>
        host.engine.cursorOpen!(
          host.getDbHandle(),
          0,
          statement.sql,
          host.serialize(statement.params),
        ),
      fetchBatch: async (h, sz) =>
        decodePayloadColumnar(
          await host.engine.cursorFetchBinary!(h, sz, true),
          host.columnarShapeCache,
        ),
      closeCursor: (h) => host.engine.cursorClose!(h),
      batchSize,
      signal: options?.signal,
    });
  }

  return createColumnarStreamFromRowStream(
    (s, p, o) => host.queryStream<Row>(s, p ?? [], o),
    sql,
    paramsOrOptions,
    maybeOptions,
  );
}
