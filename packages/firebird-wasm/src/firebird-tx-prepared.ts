/**
 * firebird-tx-prepared.ts – `PreparedStatement` Factory for Node.js
 * `FirebirdTransaction.prepare()` (`M30 Item 5`).
 */

import type { Attachment, Statement, Transaction } from 'node-firebird-driver';
import type {
  FieldInfo,
  PreparedStatement,
  QueryOptions,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
  Row,
  RowMode,
  StatementExecutionOptions,
} from './types';
import { statementKind } from './statement-types';
import { applyTypes, type TypeOptions } from './browser/value-types';
import {
  assertNotAborted,
  createTimeoutError,
  runWithCancellation,
  validateTimeoutMs,
} from './database-core';
import {
  assertPreparedParamCount,
  finalizeQueryResultWithSchema,
  resolvePreparedCallArgs,
} from './shared-driver-ops';
import { resolveBatchSize } from './sql-tag';
import {
  applyStatementHandleTimeout,
  bindParams,
  cancelAttachmentOperation,
  describeInputFields,
  fetchRows,
  outputFields,
  readAffectedRecords,
  shapeRows,
  streamRows,
  tryExecuteNativeBatch,
} from './node-native-bindings';

export interface NodeTxPreparedHost {
  readonly attachment: Attachment;
  readonly transaction: Transaction;
  readonly types?: TypeOptions;
  isTxFinished(): boolean;
  assertUsable(): void;
  beforeStatement(): Promise<void>;
  serialize(params: QueryParams): QueryParams;
}

export async function buildNodeTxPreparedStatement(
  host: NodeTxPreparedHost,
  sqlText: string,
  nativeStmt: Statement,
): Promise<PreparedStatement> {
  let params: FieldInfo[];
  let fields: FieldInfo[];
  let type: number;
  try {
    params = await describeInputFields(nativeStmt);
    fields = await outputFields(nativeStmt);
    type = await nativeStmt.type;
  } catch (err) {
    await nativeStmt.dispose().catch(() => undefined);
    throw err;
  }

  const statementType = statementKind(type);
  const hasResultSet = nativeStmt.hasResultSet;
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
    statementType,
    hasResultSet,
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
      await applyStatementHandleTimeout(nativeStmt, validated);
    },
    query: (async <T = Row>(
      paramsOrOptions: QueryParams | QueryOptions<T> = [],
      maybeOptions: QueryOptions<T> = {},
    ): Promise<QueryResult<T>> => {
      assertOpen();
      const { callParams, rawOptions, callOptions } = resolvePreparedCallArgs<QueryOptions<T>>(
        paramsOrOptions,
        maybeOptions,
        currentTimeoutMs,
      );
      checkParamCount(callParams.length);
      assertNotAborted(callOptions.signal);
      validateTimeoutMs(callOptions.timeoutMs);
      await host.beforeStatement();
      const rowMode: RowMode = callOptions.rowMode ?? 'object';
      const hasPerCallTimeout =
        rawOptions.timeoutMs !== undefined && rawOptions.timeoutMs !== currentTimeoutMs;
      if (hasPerCallTimeout) {
        await applyStatementHandleTimeout(nativeStmt, rawOptions.timeoutMs);
      }
      let rawRows: unknown[][];
      try {
        rawRows = await runWithCancellation(
          () =>
            fetchRows(
              nativeStmt,
              host.transaction,
              host.serialize(callParams),
              fields,
              host.types,
            ),
          callOptions,
          () => cancelAttachmentOperation(host.attachment),
        );
      } finally {
        if (hasPerCallTimeout) {
          await applyStatementHandleTimeout(nativeStmt, currentTimeoutMs).catch(() => undefined);
        }
      }
      const outFields = fields.map((f) => ({ ...f }));
      return finalizeQueryResultWithSchema(
        applyTypes(
          { rows: shapeRows<T>(rawRows, outFields, rowMode), fields: outFields },
          host.types,
          rowMode,
        ),
        callOptions.schema,
        rowMode,
      );
    }) as PreparedStatement['query'],
    queryStream: (<T = Row>(
      paramsOrOptions: QueryParams | QueryStreamOptions = [],
      maybeOptions: QueryStreamOptions = {},
    ): AsyncIterableIterator<QueryResult<T>> => {
      assertOpen();
      const callParams = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
      const rawOptions = Array.isArray(paramsOrOptions) ? maybeOptions : (paramsOrOptions ?? {});
      const callOptions: QueryStreamOptions =
        rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
          ? { ...rawOptions, timeoutMs: currentTimeoutMs }
          : rawOptions;
      checkParamCount(callParams.length);
      validateTimeoutMs(callOptions.timeoutMs);
      const batchSize = resolveBatchSize(callOptions.batchSize);
      const rowMode: RowMode = callOptions.rowMode ?? 'object';

      return (async function* (): AsyncIterableIterator<QueryResult<T>> {
        assertOpen();
        assertNotAborted(callOptions.signal);
        const totalTimeoutMs = validateTimeoutMs(callOptions.timeoutMs);
        const deadline =
          totalTimeoutMs && totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
        const checkStreamDeadline = (): void => {
          assertNotAborted(callOptions.signal);
          if (deadline !== undefined && Date.now() >= deadline) {
            throw createTimeoutError(totalTimeoutMs!);
          }
        };
        await host.beforeStatement();
        const serializedParams = host.serialize(callParams);
        const hasPerCallTimeout =
          rawOptions.timeoutMs !== undefined && rawOptions.timeoutMs !== currentTimeoutMs;
        if (hasPerCallTimeout) {
          await applyStatementHandleTimeout(nativeStmt, rawOptions.timeoutMs);
        }
        try {
          for await (const batch of streamRows<T>(
            nativeStmt,
            host.transaction,
            serializedParams,
            fields,
            rowMode,
            batchSize,
            host.types,
            () => undefined,
          )) {
            checkStreamDeadline();
            yield batch;
            checkStreamDeadline();
          }
        } finally {
          if (hasPerCallTimeout) {
            await applyStatementHandleTimeout(nativeStmt, currentTimeoutMs).catch(() => undefined);
          }
        }
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
      await host.beforeStatement();
      const hasPerCallTimeout =
        execOptions.timeoutMs !== undefined && execOptions.timeoutMs !== currentTimeoutMs;
      if (hasPerCallTimeout) {
        await applyStatementHandleTimeout(nativeStmt, execOptions.timeoutMs);
      }
      try {
        await runWithCancellation(
          async () => {
            await nativeStmt.execute(
              host.transaction,
              await bindParams(nativeStmt, host.transaction, host.serialize(callParams)),
            );
          },
          effectiveOptions,
          () => cancelAttachmentOperation(host.attachment),
        );
        return { affectedRows: await readAffectedRecords(nativeStmt) };
      } finally {
        if (hasPerCallTimeout) {
          await applyStatementHandleTimeout(nativeStmt, currentTimeoutMs).catch(() => undefined);
        }
      }
    },
    execBatch: async (rows: QueryParams[]) => {
      assertOpen();
      await host.beforeStatement();
      if (!Array.isArray(rows)) {
        throw new TypeError('execBatch takes an array of parameter rows');
      }
      for (const row of rows) checkParamCount(row.length);
      if (rows.length === 0) return { affectedRows: 0 };
      const serializedRows = host.types?.serializers?.length
        ? rows.map((row) => host.serialize(row))
        : rows;
      if (
        serializedRows.length > 1 &&
        (await tryExecuteNativeBatch(nativeStmt, host.transaction, serializedRows))
      ) {
        return { affectedRows: serializedRows.length };
      }
      let total = 0;
      for (const row of serializedRows) {
        await nativeStmt.execute(
          host.transaction,
          await bindParams(nativeStmt, host.transaction, row),
        );
        total += (await readAffectedRecords(nativeStmt)) || 1;
      }
      return { affectedRows: total };
    },
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      await nativeStmt.dispose().catch(() => undefined);
    },
    [Symbol.asyncDispose]: async () => {
      await stmt.close();
    },
  };

  return stmt;
}
