/**
 * firebird-query-runner.ts – Parameterized Query Execution & Shared-Read
 * Helpers for `FirebirdLite` (`M26 Item 5`).
 */

import type { Attachment } from 'node-firebird-driver';
import type {
  FieldInfo,
  QueryOptions,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
} from './types';
import { applyTypes, type TypeOptions } from './browser/value-types';
import type { QueryProfiler } from './browser/profiler';
import type { UdrManager, UdrSqlExecutor } from './browser/udr';
import {
  assertNotAborted,
  runWithCancellation,
  validateTimeoutMs,
} from './database-core';
import type { TypedSqlFragment } from './schema-validation';
import {
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
} from './shared-driver-ops';
import { resolveQueryCall, type SqlFragment } from './sql-tag';
import {
  applyStatementHandleTimeout,
  buildTransactionOptions,
  fetchRows,
  outputFields,
  shapeRows,
  type StatementCache,
} from './node-native-bindings';

export interface NodeQueryRunnerHost {
  ensureReady: () => Promise<void>;
  getAttachment: () => Attachment;
  getStatements: () => StatementCache;
  types: TypeOptions | undefined;
  udr: UdrManager;
  createUdrExecutor: () => UdrSqlExecutor;
  profiler: QueryProfiler;
  sharedReads: boolean;
  ownTransaction: Set<string>;
  sharedRead: <T>(
    sqlText: string,
    params: QueryParams,
    rowMode: RowMode,
  ) => Promise<{ result: QueryResult<T>; cacheHit: boolean } | null | undefined>;
  endReadTransaction: () => Promise<void>;
  serialize: (params: QueryParams) => QueryParams;
  cancelOperation: () => Promise<void>;
}

export async function executeNodeQuery<T = Row>(
  host: NodeQueryRunnerHost,
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
  const rowMode: RowMode = queryOpts.rowMode ?? 'object';
  if (host.udr.hasBridgeRoutines) {
    const rewritten = await host.udr.rewriteStatement(
      statement.sql,
      host.serialize(statement.params),
    );
    statement.sql = rewritten.sql;
    statement.params = rewritten.params;
    const intercepted = await host.udr.queryIfIntercepted<T>(
      statement.sql,
      statement.params,
      rowMode,
      host.createUdrExecutor(),
    );
    if (intercepted) {
      return finalizeQueryResultWithSchema(
        applyTypes(intercepted, host.types, rowMode),
        schema,
        rowMode,
      );
    }
  }
  const attachment = host.getAttachment();

  const startedAt = host.profiler.begin();
  let cacheHit = false;
  try {
    if (
      host.sharedReads &&
      queryOpts.isolationLevel === undefined &&
      queryOpts.readOnly === undefined &&
      queryOpts.signal === undefined &&
      queryOpts.timeoutMs === undefined &&
      !host.ownTransaction.has(statement.sql)
    ) {
      const shared = await host.sharedRead<T>(statement.sql, statement.params, rowMode);
      if (shared) {
        const validatedShared = await finalizeQueryResultWithSchema(
          shared.result,
          schema,
          rowMode,
        );
        host.profiler.end({
          startedAt,
          sql: statement.sql,
          params: statement.params,
          kind: 'query',
          rowCount: validatedShared.rows.length,
          cacheHit: shared.cacheHit,
        });
        return validatedShared;
      }
    }
    await host.endReadTransaction();

    const serializedParams = host.serialize(statement.params);
    const txOptions = buildTransactionOptions(queryOpts);
    const transaction = await attachment.startTransaction(txOptions);

    let rows: T[];
    let fields: FieldInfo[];
    try {
      const lease = await host.getStatements().acquire(transaction, statement.sql);
      cacheHit = lease.cacheHit;
      const stmt = lease.stmt;

      let failed = true;
      try {
        fields = await outputFields(stmt);
        if (queryOpts.timeoutMs !== undefined && queryOpts.timeoutMs > 0) {
          await applyStatementHandleTimeout(stmt, queryOpts.timeoutMs);
        }

        const rawRows = await runWithCancellation(
          () => fetchRows(stmt, transaction, serializedParams, fields, host.types),
          queryOpts,
          () => host.cancelOperation(),
        );
        rows = shapeRows<T>(rawRows, fields, rowMode);
        failed = false;
      } finally {
        if (queryOpts.timeoutMs !== undefined && queryOpts.timeoutMs > 0 && !failed) {
          await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
        }
        await lease.release(failed);
      }

      try {
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }

    const typed = await finalizeQueryResultWithSchema(
      applyTypes({ rows, fields }, host.types, rowMode),
      schema,
      rowMode,
    );
    host.profiler.end({
      startedAt,
      sql: statement.sql,
      params: statement.params,
      kind: 'query',
      rowCount: typed.rows.length,
      cacheHit,
    });
    return typed;
  } catch (err) {
    host.profiler.end({
      startedAt,
      sql: statement.sql,
      params: statement.params,
      kind: 'query',
      cacheHit,
      error: err,
    });
    throw err;
  }
}
