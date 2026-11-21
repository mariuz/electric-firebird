/**
 * firebird-query-runner.ts – Parameterized Query Execution & Shared-Read
 * Helpers for `FirebirdLite` (`M26 Item 5`).
 */

import { TransactionIsolation } from 'node-firebird-driver';
import type { Attachment, Transaction } from 'node-firebird-driver';
import type {
  DatabaseInfo,
  ExplainOptions,
  FieldInfo,
  QueryDescription,
  QueryOptions,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
  Row,
  RowMode,
  StatementExecutionOptions,
  SweepResult,
} from './types';
import { statementKind } from './statement-types';
import { applyTypes, type TypeOptions } from './browser/value-types';
import type { QueryProfiler } from './browser/profiler';
import type { UdrManager, UdrSqlExecutor } from './browser/udr';
import {
  assertNotAborted,
  createTimeoutError,
  runWithCancellation,
  type UnifiedExecuteResult,
  validateTimeoutMs,
} from './database-core';
import type { TypedSqlFragment } from './schema-validation';
import {
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
  scanUserTablesForSweep,
} from './shared-driver-ops';
import { buildSweepResult } from './browser/engine-transport';
import {
  extractReferencedTables,
  liveTableEventName,
} from './browser/live-tables';
import {
  resolveQueryCall,
  toStatement,
  type SqlFragment,
  type Statement as ParsedStatement,
} from './sql-tag';
import {
  STMT_SELECT,
  applyStatementHandleTimeout,
  buildTransactionOptions,
  describeInputFields,
  explainStatement,
  fetchRows,
  outputFields,
  shapeRows,
  streamRows,
  type StatementCache,
  type StatementLease,
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

export async function* streamNodeQuery<T>(
  host: {
    ensureReady: () => Promise<void>;
    getAttachment: () => Attachment;
    getStatements: () => StatementCache;
    endReadTransaction: () => Promise<void>;
    serialize: (params: QueryParams) => QueryParams;
    types: TypeOptions | undefined;
  },
  statement: ParsedStatement,
  options: QueryStreamOptions,
  batchSize: number,
): AsyncIterableIterator<QueryResult<T>> {
  assertNotAborted(options.signal);
  const totalTimeoutMs = validateTimeoutMs(options.timeoutMs);
  const deadline =
    totalTimeoutMs && totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
  const checkStreamDeadline = (): void => {
    assertNotAborted(options.signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw createTimeoutError(totalTimeoutMs!);
    }
  };

  await host.ensureReady();
  const rowMode: RowMode = options.rowMode ?? 'object';
  const attachment = host.getAttachment();
  await host.endReadTransaction();

  const serializedParams = host.serialize(statement.params);
  const txOptions = buildTransactionOptions(options);
  const transaction = await attachment.startTransaction(txOptions);

  let engineFailed = false;
  let lease: StatementLease | undefined;
  let txFinished = false;

  try {
    try {
      lease = await host.getStatements().acquire(transaction, statement.sql);
    } catch (err) {
      engineFailed = true;
      throw err;
    }
    const stmt = lease.stmt;

    let fields: FieldInfo[];
    try {
      fields = await outputFields(stmt);
      if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
        await applyStatementHandleTimeout(stmt, totalTimeoutMs);
      }
    } catch (err) {
      engineFailed = true;
      throw err;
    }

    for await (const batch of streamRows<T>(
      stmt,
      transaction,
      serializedParams,
      fields,
      rowMode,
      batchSize,
      host.types,
      () => {
        engineFailed = true;
      },
    )) {
      checkStreamDeadline();
      yield batch;
      checkStreamDeadline();
    }

    if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
      await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
    }
    const toRelease = lease;
    lease = undefined;
    await toRelease.release(false);

    txFinished = true;
    try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
  } finally {
    if (lease) {
      await lease.release(engineFailed);
    }
    if (!txFinished) {
      if (engineFailed) {
        await transaction.rollback().catch(() => undefined);
      } else {
        await transaction
          .commit()
          .catch(() => transaction.rollback().catch(() => undefined));
      }
    }
  }
}

export async function runSharedNodeRead<T>(
  host: {
    getAttachment: () => Attachment;
    getStatements: () => StatementCache;
    getReadTransaction: () => Transaction | null;
    setReadTransaction: (tx: Transaction | null) => void;
    endReadTransaction: () => Promise<void>;
    rememberOwnTx: (sql: string) => void;
    serialize: (params: QueryParams) => QueryParams;
    types: TypeOptions | undefined;
  },
  sql: string,
  params: QueryParams,
  rowMode: RowMode,
): Promise<{ result: QueryResult<T>; cacheHit: boolean } | undefined> {
  const serializedParams = host.serialize(params);
  const attachment = host.getAttachment();
  let transaction = host.getReadTransaction();
  if (!transaction) {
    transaction = await attachment.startTransaction({
      isolation: TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      accessMode: 'READ_ONLY',
    });
    host.setReadTransaction(transaction);
  }

  let lease: StatementLease;
  try {
    lease = await host.getStatements().acquire(transaction, sql);
  } catch (err) {
    await host.endReadTransaction();
    throw err;
  }
  const stmt = lease.stmt;
  let failed = false;
  let fields: FieldInfo[];
  let rawRows: unknown[][];
  try {
    if ((await stmt.type) !== STMT_SELECT) {
      host.rememberOwnTx(sql);
      return undefined;
    }
    fields = await outputFields(stmt);
    rawRows = await fetchRows(stmt, transaction, serializedParams, fields, host.types);
  } catch (err) {
    if (/attempted update during read-only transaction/.test(String((err as Error)?.message))) {
      host.rememberOwnTx(sql);
      return undefined;
    }
    failed = true;
    await host.endReadTransaction();
    throw err;
  } finally {
    await lease.release(failed);
  }
  return {
    result: applyTypes(
      { rows: shapeRows<T>(rawRows, fields, rowMode), fields },
      host.types,
      rowMode,
    ),
    cacheHit: lease.cacheHit,
  };
}

export async function describeNodeQuery(
  attachment: Attachment,
  sql: string | SqlFragment,
): Promise<QueryDescription> {
  const text = toStatement(sql).sql;
  const transaction = await attachment.startTransaction();
  try {
    const stmt = await attachment.prepare(transaction, text);
    try {
      const params = await describeInputFields(stmt);
      const fields = await outputFields(stmt);
      const type = await stmt.type;
      return {
        params,
        fields,
        statementType: statementKind(type),
        hasResultSet: stmt.hasResultSet,
      };
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
  } finally {
    await transaction.commit().catch(() => undefined);
  }
}

export async function explainNodeQuery(
  attachment: Attachment,
  sql: string | SqlFragment,
  options: ExplainOptions = {},
): Promise<string> {
  const text = toStatement(sql).sql;
  const detailed = options.detailed === true;
  const transaction = await attachment.startTransaction();
  try {
    const stmt = await attachment.prepare(transaction, text);
    try {
      return await explainStatement(stmt, detailed);
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
  } finally {
    await transaction.commit().catch(() => undefined);
  }
}

export async function runNodeProfiledExec(
  profiler: QueryProfiler,
  runTxExec: (sql: string | SqlFragment, params: QueryParams, options: StatementExecutionOptions) => Promise<void>,
  sql: string | SqlFragment,
  paramsOrOptions: QueryParams | StatementExecutionOptions = [],
  maybeOptions: StatementExecutionOptions = {},
): Promise<void> {
  const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
  const options = Array.isArray(paramsOrOptions) ? maybeOptions : (paramsOrOptions ?? {});
  assertNotAborted(options.signal);
  validateTimeoutMs(options.timeoutMs);
  const script = toStatement(sql, params);
  const startedAt = profiler.begin();
  try {
    await runTxExec(sql, params, options);
    profiler.end({
      startedAt,
      sql: script.sql,
      params: script.params,
      kind: 'exec',
      rowCount: 0,
      cacheHit: false,
    });
  } catch (err) {
    profiler.end({
      startedAt,
      sql: script.sql,
      params: script.params,
      kind: 'exec',
      cacheHit: false,
      error: err,
    });
    throw err;
  }
}

export async function runNodeProfiledExecute(
  profiler: QueryProfiler,
  runTxExecute: (
    sql: string | SqlFragment,
    params: QueryParams,
    options: StatementExecutionOptions,
  ) => Promise<UnifiedExecuteResult>,
  sql: string | SqlFragment,
  params: QueryParams = [],
  options: StatementExecutionOptions = {},
): Promise<UnifiedExecuteResult> {
  assertNotAborted(options.signal);
  validateTimeoutMs(options.timeoutMs);
  const script = toStatement(sql, params);
  const startedAt = profiler.begin();
  try {
    const res = await runTxExecute(sql, params, options);
    profiler.end({
      startedAt,
      sql: script.sql,
      params: script.params,
      kind: 'exec',
      rowCount: res.affectedRows,
      cacheHit: false,
    });
    return res;
  } catch (err) {
    profiler.end({
      startedAt,
      sql: script.sql,
      params: script.params,
      kind: 'exec',
      cacheHit: false,
      error: err,
    });
    throw err;
  }
}

export async function runNodeProfiledExecBatch(
  profiler: QueryProfiler,
  runTxBatch: (sql: string, rows: QueryParams[]) => Promise<void>,
  sql: string,
  rows: QueryParams[],
): Promise<void> {
  const startedAt = profiler.begin();
  try {
    await runTxBatch(sql, rows);
    profiler.end({
      startedAt,
      sql,
      params: rows[0] ?? [],
      kind: 'execBatch',
      rowCount: rows.length,
      cacheHit: rows.length > 1,
    });
  } catch (err) {
    profiler.end({
      startedAt,
      sql,
      params: rows[0] ?? [],
      kind: 'execBatch',
      cacheHit: rows.length > 1,
      error: err,
    });
    throw err;
  }
}

export function watchNodeLocalSqlEvents(
  liveEventListeners: Map<string, Set<() => void>>,
  sqlText: string,
  explicitEvents: readonly string[] | undefined,
  onWakeup: () => void,
  options: { pollIntervalMs?: number },
): () => Promise<void> {
  const events: string[] =
    explicitEvents !== undefined
      ? [...explicitEvents]
      : (() => {
          const tables = extractReferencedTables(sqlText);
          if (tables.length === 0) {
            throw new RangeError(
              'liveIncremental() / liveColumnar() could not infer any user tables from SQL; pass { events: [...] } explicitly',
            );
          }
          return tables.map((t) => liveTableEventName(t));
        })();

  for (const ev of events) {
    let set = liveEventListeners.get(ev);
    if (!set) {
      set = new Set();
      liveEventListeners.set(ev, set);
    }
    set.add(onWakeup);
  }

  const intervalMs = options.pollIntervalMs ?? 250;
  const pollTimer = intervalMs > 0 ? setInterval(() => onWakeup(), intervalMs) : null;
  if (pollTimer && typeof (pollTimer as { unref?: () => void }).unref === 'function') {
    (pollTimer as { unref: () => void }).unref();
  }

  return async () => {
    if (pollTimer) clearInterval(pollTimer);
    for (const ev of events) {
      const set = liveEventListeners.get(ev);
      if (set) {
        set.delete(onWakeup);
        if (set.size === 0) liveEventListeners.delete(ev);
      }
    }
  };
}

export async function runNodeSweep(host: {
  ensureReady: () => Promise<void>;
  endReadTransaction: () => Promise<void>;
  databaseInfo: () => Promise<DatabaseInfo>;
  query: (sql: string) => Promise<QueryResult<Row>>;
  getAttachment: () => Attachment;
}): Promise<SweepResult> {
  await host.ensureReady();
  const started = performance.now();
  await host.endReadTransaction();
  const before = await host.databaseInfo();
  const tablesScanned = await scanUserTablesForSweep(host.query);

  await host.endReadTransaction();
  const tx = await host.getAttachment().startTransaction();
  await tx.commit().catch(() => tx.rollback().catch(() => undefined));

  const after = await host.databaseInfo();
  return buildSweepResult(before, after, tablesScanned, performance.now() - started);
}
