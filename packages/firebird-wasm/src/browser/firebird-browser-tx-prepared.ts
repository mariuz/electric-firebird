/**
 * firebird-browser-tx-prepared.ts – `PreparedStatement` Factory for
 * `FirebirdBrowserTransaction.prepare()` (`M30 Item 5`).
 */

import type { EngineHandle, EngineTransport } from './engine-transport';
import { applySerializers, applyTypes, type TypeOptions } from './value-types';
import { resolveBatchSize, type Statement } from '../sql-tag';
import { assertNotAborted, runWithCancellation, validateTimeoutMs } from '../database-core';
import type { StandardSchemaV1 } from '../schema-validation';
import {
  assertBatchParameterRows,
  assertPreparedParamCount,
  finalizeQueryResultWithSchema,
  resolvePreparedCallArgs,
} from '../shared-driver-ops';
import type {
  PreparedStatement,
  QueryDescription,
  QueryOptions,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
  Row,
  RowMode,
  StatementExecutionOptions,
} from '../types';

export interface BrowserTxPreparedHost {
  readonly engine: EngineTransport;
  readonly dbHandle: EngineHandle;
  readonly txHandle: EngineHandle;
  readonly types?: TypeOptions;
  isTxFinished(): boolean;
  assertUsable(): void;
  applyOneShotTimeout(timeoutMs?: number): Promise<void>;
  cancelOperation(): Promise<void>;
  queryFallback<T extends Row>(
    sql: string,
    params: QueryParams,
    options: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
  queryStreamFallback<T extends Row>(
    sql: string,
    params: QueryParams,
    options: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  streamWithHandle<T>(
    statement: Statement,
    rowMode: RowMode,
    batchSize: number,
    stmtHandle: EngineHandle,
    options: StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  execFallback(
    sql: string,
    params: QueryParams,
    options: StatementExecutionOptions,
  ): Promise<{ affectedRows: number }>;
  execBatchFallback(sql: string, rows: QueryParams[]): Promise<{ affectedRows: number }>;
}

export function buildBrowserTxPreparedStatement(
  host: BrowserTxPreparedHost,
  sqlText: string,
  desc: QueryDescription & { handle?: EngineHandle },
): PreparedStatement {
  const stmtHandle = desc.handle ?? 0;
  const params = desc.params.map((p) => ({ ...p }));
  const fields = desc.fields.map((f) => ({ ...f }));
  let isClosed = false;
  let currentTimeoutMs = 0;

  const assertOpen = (): void => {
    if (isClosed) throw new Error('PreparedStatement has been closed');
    host.assertUsable();
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
      return isClosed || host.isTxFinished();
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
        assertNotAborted(callOptions.signal);
        validateTimeoutMs(callOptions.timeoutMs);
        const rowMode = callOptions.rowMode ?? 'object';
        const raw = await runWithCancellation(
          async () => {
            await host.applyOneShotTimeout(callOptions.timeoutMs);
            return host.engine.queryStmt!<T>(
              host.dbHandle,
              host.txHandle,
              stmtHandle,
              applySerializers(callParams, host.types?.serializers),
              rowMode,
              host.types?.binary === true,
            );
          },
          callOptions,
          () => host.cancelOperation(),
        );
        return finalizeQueryResultWithSchema(
          applyTypes(raw, host.types, rowMode),
          callOptions.schema,
          rowMode,
        );
      }
      return host.queryFallback<T & Row>(sqlText, callParams, {
        rowMode: callOptions.rowMode,
        schema: callOptions.schema as StandardSchemaV1<unknown, T & Row> | undefined,
        signal: callOptions.signal,
        timeoutMs: callOptions.timeoutMs,
      });
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
          ? host.streamWithHandle(
              { sql: sqlText, params: callParams },
              callOptions.rowMode ?? 'object',
              batchSize,
              stmtHandle,
              callOptions,
            )
          : host.queryStreamFallback(sqlText, callParams, {
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
      if (stmtHandle > 0 && typeof host.engine.executeStmt === 'function') {
        assertNotAborted(effectiveOptions.signal);
        validateTimeoutMs(effectiveOptions.timeoutMs);
        const affectedRows = await runWithCancellation(
          async () => {
            await host.applyOneShotTimeout(effectiveOptions.timeoutMs);
            return host.engine.executeStmt!(
              host.dbHandle,
              host.txHandle,
              stmtHandle,
              applySerializers(callParams, host.types?.serializers),
            );
          },
          effectiveOptions,
          () => host.cancelOperation(),
        );
        return { affectedRows };
      }
      return host.execFallback(sqlText, callParams, effectiveOptions);
    },
    execBatch: async (rows: QueryParams[]) => {
      assertOpen();
      assertBatchParameterRows(rows, params.length);
      if (stmtHandle > 0 && typeof host.engine.executeBatchStmt === 'function') {
        const affectedRows = await host.engine.executeBatchStmt(
          host.dbHandle,
          host.txHandle,
          stmtHandle,
          rows.map((row) => applySerializers(row, host.types?.serializers)),
        );
        return { affectedRows };
      }
      return host.execBatchFallback(sqlText, rows);
    },
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      if (stmtHandle > 0 && typeof host.engine.stmtClose === 'function') {
        await host.engine.stmtClose(stmtHandle).catch(() => undefined);
      }
    },
    [Symbol.asyncDispose]: async () => {
      await stmt.close();
    },
  };

  return stmt;
}
