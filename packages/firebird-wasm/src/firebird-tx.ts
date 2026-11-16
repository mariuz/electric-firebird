/**
 * firebird-tx.ts – `FirebirdTransaction` implementation for Node.js `FirebirdLite` (`M20 Item 5`).
 */

import { Blob as FbBlob } from 'node-firebird-driver';
import type { Attachment, Statement, Transaction } from 'node-firebird-driver';
import type {
  ArrayRow,
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  CopyFromOptions,
  CopyResult,
  CopyToOptions,
  ExplainOptions,
  FieldInfo,
  PreparedStatement,
  QueryDescription,
  QueryOptions,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
  Row,
  RowMode,
  StatementExecutionOptions,
} from './types';
import { statementKind } from './statement-types';
import { applyTypes, applySerializers, type TypeOptions } from './browser/value-types';
import { buildCopyToStream, executeCopyFromStream } from './browser/copy-stream';
import type { UdrManager } from './browser/udr';
import {
  type ArrayModeOptions,
  assertNotAborted,
  createTimeoutError,
  type FirebirdTransactionClient,
  runWithCancellation,
  type UnifiedExecuteResult,
  validateSavepointName,
  validateTimeoutMs,
} from './database-core';
import type { ColumnarQueryResult } from './columnar';
import type { StandardSchemaV1, TypedSqlFragment } from './schema-validation';
import { extractMutatedTables } from './browser/live-tables';
import {
  executePipelineFallback,
  normalizePipelineOperations,
  type PipelineOperation,
  type PipelineOptions,
  type PipelineResults,
} from './pipeline';
import {
  assertPreparedParamCount,
  executeArrowFromColumnar,
  executeColumnarViaArrayQuery,
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
  isNonCountingDdlStatement,
  querySystemRowCount,
  resolveColumnarQueryCall,
  resolvePreparedCallArgs,
  type QueryArrowOptions,
} from './shared-driver-ops';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobSegmentSize,
} from './browser/blob-stream';
import { toStatement, resolveQueryCall, resolveBatchSize } from './sql-tag';
import type { SqlFragment, Statement as ParsedStatement } from './sql-tag';
import { blockParamType, buildBlock, placeholderOffsets } from './batch-block';
import {
  BLOCK_ROWS,
  StatementCache,
  type StatementLease,
  applyStatementHandleTimeout,
  bindParams,
  cancelAttachmentOperation,
  characterSets,
  describeInputFields,
  explainStatement,
  fetchRows,
  inputParams,
  openNativeQueryBlobStream,
  outputFields,
  readAffectedRecords,
  shapeRows,
  streamRows,
  tryExecuteNativeBatch,
} from './node-native-bindings';

/**
 * A handle to an active Firebird transaction (or nested savepoint), exposed to
 * callers of `FirebirdLite.transaction()`.
 */
export class FirebirdTransaction implements FirebirdTransactionClient {
  private finished = false;
  private readonly nextSavepointId: () => number;
  private readonly mutatedTablesSet = new Set<string>();

  /** Tables modified inside this transaction (and released savepoints). */
  get committedTables(): string[] {
    return Array.from(this.mutatedTablesSet);
  }

  private recordMutatedTables(sqlText: string): void {
    for (const table of extractMutatedTables(sqlText)) {
      this.mutatedTablesSet.add(table);
    }
  }

  constructor(
    private readonly attachment: Attachment,
    private readonly transaction: Transaction,
    private readonly beforeStatement: () => Promise<void> = async () => undefined,
    private readonly statements: StatementCache = new StatementCache(attachment, 0),
    private readonly types?: TypeOptions,
    readonly savepointName?: string,
    private readonly parent?: FirebirdTransaction,
    private readonly udr?: UdrManager,
    nextSavepointId?: () => number,
  ) {
    if (nextSavepointId) {
      this.nextSavepointId = nextSavepointId;
    } else {
      let counter = 0;
      this.nextSavepointId = () => {
        counter += 1;
        return counter;
      };
    }
  }

  private serialize(params: QueryParams): QueryParams {
    return applySerializers(params, this.types?.serializers);
  }

  /** Whether this transaction (or savepoint) has already finished or been rolled back. */
  get isFinished(): boolean {
    return this.finished || (this.parent ? this.parent.isFinished : false);
  }

  private markFinished(): void {
    this.finished = true;
  }

  /**
   * Roll this transaction (or savepoint) back and stop.
   *
   * When called on the root transaction, the enclosing `transaction()` will not
   * commit afterwards. When called on a savepoint handle inside `tx.savepoint()`,
   * only the work since the savepoint is undone (`ROLLBACK TO SAVEPOINT` +
   * `RELEASE SAVEPOINT ... ONLY`) and the enclosing transaction remains active.
   */
  async rollback(): Promise<void> {
    if (this.isFinished) return;
    this.finished = true;
    if (this.savepointName) {
      await this.beforeStatement();
      await this.attachment.execute(
        this.transaction,
        `ROLLBACK TO SAVEPOINT ${this.savepointName}`,
      );
      await this.attachment.execute(
        this.transaction,
        `RELEASE SAVEPOINT ${this.savepointName} ONLY`,
      );
      return;
    }
    await this.transaction.rollback();
  }

  private assertUsable(): void {
    if (this.isFinished) {
      throw new Error(
        this.savepointName
          ? `Savepoint "${this.savepointName}" has already finished`
          : 'Transaction has already been rolled back',
      );
    }
  }

  /**
   * Run `fn` inside a SQL `SAVEPOINT` within this transaction.
   *
   * - If `fn` resolves (and `sp.rollback()` was not called), the savepoint is
   *   released via `RELEASE SAVEPOINT <name> ONLY`.
   * - If `fn` throws an error, the work inside the savepoint is undone via
   *   `ROLLBACK TO SAVEPOINT <name>` + `RELEASE SAVEPOINT <name> ONLY` and the
   *   error is re-thrown while the outer transaction stays active.
   * - If `await sp.rollback()` is called inside `fn`, the savepoint is rolled
   *   back and released without throwing, and `fn`'s return value is returned.
   * - Savepoints can be nested arbitrarily; when `name` is omitted, unique
   *   names (`sp_1`, `sp_2`, ...) are generated automatically.
   */
  savepoint<T>(fn: (sp: FirebirdTransaction) => Promise<T>): Promise<T>;
  savepoint<T>(
    name: string,
    fn: (sp: FirebirdTransaction) => Promise<T>,
  ): Promise<T>;
  async savepoint<T>(
    nameOrFn: string | ((sp: FirebirdTransaction) => Promise<T>),
    maybeFn?: (sp: FirebirdTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    const name =
      typeof nameOrFn === 'string'
        ? validateSavepointName(nameOrFn)
        : `sp_${this.nextSavepointId()}`;
    const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn;
    if (typeof fn !== 'function') {
      throw new TypeError('savepoint requires a callback function');
    }

    await this.beforeStatement();
    await this.attachment.execute(this.transaction, `SAVEPOINT ${name}`);

    const sp = new FirebirdTransaction(
      this.attachment,
      this.transaction,
      this.beforeStatement,
      this.statements,
      this.types,
      name,
      this,
      this.udr,
      this.nextSavepointId,
    );

    let result: T;
    try {
      result = await fn(sp);
    } catch (err) {
      if (!sp.isFinished) {
        sp.markFinished();
        await this.beforeStatement().catch(() => undefined);
        await this.attachment
          .execute(this.transaction, `ROLLBACK TO SAVEPOINT ${name}`)
          .catch(() => undefined);
        await this.attachment
          .execute(this.transaction, `RELEASE SAVEPOINT ${name} ONLY`)
          .catch(() => undefined);
      }
      throw err;
    }

    if (!sp.isFinished) {
      sp.markFinished();
      await this.beforeStatement();
      await this.attachment.execute(
        this.transaction,
        `RELEASE SAVEPOINT ${name} ONLY`,
      );
      for (const tbl of sp.committedTables) {
        this.mutatedTablesSet.add(tbl);
      }
    }

    return result;
  }

  /**
   * Cancel the currently running statement on this database attachment via
   * `IAttachment::cancelOperation(status, fb_cancel_raise)`.
   */
  async cancelOperation(): Promise<void> {
    this.assertUsable();
    await cancelAttachmentOperation(this.attachment);
  }

  /**
   * Execute a DDL or DML statement inside this transaction.
   */
  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<void> {
    this.assertUsable();
    const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
    const options = Array.isArray(paramsOrOptions)
      ? maybeOptions
      : (paramsOrOptions ?? {});
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    await this.beforeStatement();
    const statement = toStatement(sql, params);
    const serialized = this.serialize(statement.params);
    const hasTimeout = options.timeoutMs !== undefined && options.timeoutMs > 0;
    this.udr?.inspectDdl(statement.sql);
    if (this.udr?.hasBridgeRoutines) {
      const intercepted = await this.udr.executeIfIntercepted(statement.sql, serialized);
      if (intercepted.intercepted) {
        return;
      }
      const rewritten = await this.udr.rewriteStatement(statement.sql, serialized);
      statement.sql = rewritten.sql;
      serialized.splice(0, serialized.length, ...rewritten.params);
    }
    // With the cache off, a statement without parameters runs as it always
    // did. With it on, every statement goes through the cache, which is also
    // what sees DDL coming and empties itself first.
    if (serialized.length > 0 || this.statements.enabled || hasTimeout) {
      const lease = await this.statements.acquire(this.transaction, statement.sql);
      let failed = true;
      try {
        if (hasTimeout) {
          await applyStatementHandleTimeout(lease.stmt, options.timeoutMs);
        }
        await runWithCancellation(
          async () => {
            await lease.stmt.execute(
              this.transaction,
              await bindParams(lease.stmt, this.transaction, serialized),
            );
          },
          options,
          () => cancelAttachmentOperation(this.attachment),
        );
        failed = false;
      } finally {
        if (hasTimeout && !failed) {
          await applyStatementHandleTimeout(lease.stmt, 0).catch(() => undefined);
        }
        await lease.release(failed);
      }
    } else {
      await runWithCancellation(
        () => this.attachment.execute(this.transaction, statement.sql),
        options,
        () => cancelAttachmentOperation(this.attachment),
      );
    }
    this.recordMutatedTables(statement.sql);
  }

  /**
   * Execute a DDL or DML statement inside this transaction and return `{ affectedRows, changes }` (`M18 Item 3`).
   */
  async execute(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: StatementExecutionOptions = {},
  ): Promise<UnifiedExecuteResult> {
    const stmtText = toStatement(sql, params).sql;
    await this.exec(sql, params, options);
    if (isNonCountingDdlStatement(stmtText)) {
      return { affectedRows: 0, changes: 0 };
    }
    const affectedRows = await querySystemRowCount((s) => this.query<Row>(s));
    return { affectedRows, changes: affectedRows };
  }

  /**
   * Execute one statement once per row of parameters inside this
   * transaction: prepared once, executed per row.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<void> {
    this.assertUsable();
    await this.beforeStatement();
    if (!Array.isArray(rows)) {
      throw new TypeError('execBatch takes an array of parameter rows');
    }
    if (rows.length === 0) return;
    const serializedRows = this.types?.serializers?.length
      ? rows.map((row) => this.serialize(row))
      : rows;
    const lease = await this.statements.acquire(this.transaction, sql);
    let failed = true;
    try {
      if (
        serializedRows.length > 1 &&
        (await tryExecuteNativeBatch(lease.stmt, this.transaction, serializedRows))
      ) {
        failed = false;
        return;
      }
      const plan = serializedRows.length > 1 ? await this.blockPlan(sql, lease.stmt) : undefined;
      if (plan) {
        await this.executeInBlocks(lease.stmt, plan, serializedRows);
      } else {
        for (const row of serializedRows) {
          await lease.stmt.execute(this.transaction, await bindParams(lease.stmt, this.transaction, row));
        }
      }
      failed = false;
    } finally {
      await lease.release(failed);
    }
    this.recordMutatedTables(sql);
  }

  /**
   * Execute multiple heterogeneous `query`, `queryColumnar`, `queryArrow`,
   * `execute`, and `execBatch` operations inside this transaction (`M20 Item 2`).
   */
  async pipeline<const TOps extends readonly PipelineOperation[]>(
    ops: TOps,
    options: Omit<PipelineOptions, 'transaction'> = {},
  ): Promise<PipelineResults<TOps>> {
    this.assertUsable();
    assertNotAborted(options.signal);
    if (ops.length === 0) {
      return [] as unknown as PipelineResults<TOps>;
    }
    const steps = normalizePipelineOperations(ops, (p) => this.serialize(p));
    const results = await executePipelineFallback(steps, this);
    assertNotAborted(options.signal);
    return results as PipelineResults<TOps>;
  }

  /**
   * How to run `sql` as an `EXECUTE BLOCK` over many rows, or `undefined` to
   * run it row by row: it is not plain DML or a procedure call, it returns
   * something, or a parameter's type cannot be declared. See batch-block.ts.
   */
  private async blockPlan(
    sql: string,
    stmt: Statement,
  ): Promise<{ build: (rows: number) => string } | undefined> {
    const type = await stmt.type;
    // INSERT, UPDATE, DELETE, EXECUTE PROCEDURE; nothing with a result.
    if (![2, 3, 4, 8].includes(type) || stmt.hasResultSet) return undefined;
    if ((await outputFields(stmt)).length > 0) return undefined;

    const params = await inputParams(stmt);
    const offsets = placeholderOffsets(sql);
    if (!params || params.length === 0 || !offsets || offsets.length !== params.length) {
      return undefined;
    }
    const charsets = await characterSets(this.attachment, this.transaction);
    const types = params.map((p) => blockParamType(p, charsets));
    if (types.some((t) => t === undefined)) return undefined;
    return { build: (rows) => buildBlock(sql, offsets, types as string[], rows) };
  }

  /**
   * Run `rows` through blocks of up to {@link BLOCK_ROWS} rows each.
   *
   * A block that will not prepare (more contexts than the engine's 256,
   * a message or BLR too long) is halved until it does; at one row the
   * statement itself runs. A block that fails while running was undone as
   * one statement, so its rows run again one by one: the failing row then
   * throws exactly the error the row-by-row loop would have thrown.
   */
  private async executeInBlocks(
    single: Statement,
    plan: { build: (rows: number) => string },
    rows: QueryParams[],
  ): Promise<void> {
    let size = Math.min(BLOCK_ROWS, rows.length);
    let current: { rows: number; lease: StatementLease } | undefined;
    try {
      for (let at = 0; at < rows.length; ) {
        const chunk = rows.slice(at, at + size);
        if (chunk.length === 1) {
          await single.execute(this.transaction, await bindParams(single, this.transaction, chunk[0]!));
          at += 1;
          continue;
        }
        if (current?.rows !== chunk.length) {
          await current?.lease.release(false);
          current = undefined;
          try {
            current = {
              rows: chunk.length,
              lease: await this.statements.acquire(this.transaction, plan.build(chunk.length)),
            };
          } catch {
            size = Math.max(1, chunk.length >> 1);
            continue;
          }
        }
        try {
          await current.lease.stmt.execute(this.transaction, await bindParams(current.lease.stmt, this.transaction, chunk.flat()));
        } catch {
          for (const row of chunk) {
            await single.execute(this.transaction, await bindParams(single, this.transaction, row));
          }
        }
        at += chunk.length;
      }
    } finally {
      await current?.lease.release(false);
    }
  }

  /**
   * Execute a SELECT statement inside this transaction and return rows.
   */
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: TypedSqlFragment<T>,
    options?: { rowMode?: RowMode; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions,
  ): Promise<QueryResult<T>>;
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions,
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment | TypedSqlFragment<T>,
    paramsOrOptions:
      | QueryParams
      | ({ rowMode?: RowMode; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions) = [],
    maybeOptions: { rowMode?: RowMode; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions = {},
  ): Promise<QueryResult<T>> {
    this.assertUsable();
    const { statement, options } = resolveQueryCall<
      { rowMode?: RowMode; schema?: StandardSchemaV1<unknown, T> } & StatementExecutionOptions
    >(sql, paramsOrOptions, maybeOptions);
    const schema = extractEffectiveQuerySchema<T>(sql, options);
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    await this.beforeStatement();
    const serialized = this.serialize(statement.params);
    const rowMode = options.rowMode ?? 'object';
    if (this.udr?.hasBridgeRoutines) {
      const rewritten = await this.udr.rewriteStatement(statement.sql, serialized);
      statement.sql = rewritten.sql;
      serialized.splice(0, serialized.length, ...rewritten.params);
      const intercepted = await this.udr.queryIfIntercepted<T>(
        statement.sql,
        serialized,
        rowMode,
        {
          isDirect: false,
          exec: (s: string, p: QueryParams = []) => this.exec(s, p),
          query: <R extends Row = Row>(
            s: string,
            p: QueryParams = [],
            o?: { rowMode?: RowMode },
          ) => this.query<R>(s, p, { ...options, schema: undefined, rowMode: o?.rowMode ?? 'object' }),
        },
      );
      if (intercepted) {
        return finalizeQueryResultWithSchema(
          applyTypes(intercepted, this.types, rowMode),
          schema,
          rowMode,
        );
      }
    }

    const lease = await this.statements.acquire(this.transaction, statement.sql);
    const stmt = lease.stmt;
    // Same leak as FirebirdLite.query had: a statement or result set that
    // throws must still be released. More so here, because a transaction
    // callback that catches its own errors goes on using the same attachment.
    let failed = true;
    let fields: FieldInfo[];
    let rawRows: unknown[][];
    try {
      fields = await outputFields(stmt);
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        await applyStatementHandleTimeout(stmt, options.timeoutMs);
      }
      rawRows = await runWithCancellation(
        () => fetchRows(stmt, this.transaction, serialized, fields, this.types),
        options,
        () => cancelAttachmentOperation(this.attachment),
      );
      failed = false;
    } finally {
      if (options.timeoutMs !== undefined && options.timeoutMs > 0 && !failed) {
        await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
      }
      await lease.release(failed);
    }
    return finalizeQueryResultWithSchema(
      applyTypes({ rows: shapeRows<T>(rawRows, fields, rowMode), fields }, this.types, rowMode),
      schema,
      rowMode,
    );
  }

  /**
   * Execute a `SELECT` query inside this transaction and return typed columnar
   * buffers (`M19 Item 2`).
   */
  async queryColumnar(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ColumnarQueryResult> {
    this.assertUsable();
    const { statement, options } = resolveColumnarQueryCall(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    return executeColumnarViaArrayQuery(() =>
      this.query(statement.sql, statement.params, {
        ...options,
        rowMode: 'array',
      }),
    );
  }

  /**
   * Execute a `SELECT` query inside this transaction and return an **Apache Arrow IPC V5**
   * stream (`Uint8Array`) (`M19 Item 2`).
   */
  async queryArrow(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryArrowOptions = [],
    maybeOptions: QueryArrowOptions = {},
  ): Promise<Uint8Array> {
    const { statement, options } = resolveColumnarQueryCall<QueryArrowOptions>(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    return executeArrowFromColumnar(
      () => this.queryColumnar(statement.sql, statement.params, options),
      options,
    );
  }

  /**
   * Stream a SELECT statement inside this transaction in batches of `batchSize` rows.
   */
  queryStream(
    sql: SqlFragment,
    options: { rowMode: 'array'; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: { rowMode: 'array'; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    sql: SqlFragment,
    options?: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions:
      | QueryParams
      | ({ rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions) = [],
    maybeOptions: { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    const { statement, options } = resolveQueryCall<
      { rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions
    >(sql, paramsOrOptions, maybeOptions);
    validateTimeoutMs(options.timeoutMs);
    const batchSize = resolveBatchSize(options.batchSize);
    return this.streamQuery<T>(
      statement,
      options.rowMode ?? 'object',
      batchSize,
      options,
    );
  }

  /**
   * Prepare a SQL statement inside this transaction and return a reusable
   * {@link PreparedStatement} handle.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    this.assertUsable();
    await this.beforeStatement();
    const sqlText = toStatement(sql).sql;
    const nativeStmt = await this.attachment.prepare(this.transaction, sqlText);

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
    const isTxFinished = () => this.isFinished;

    const assertOpen = (): void => {
      if (isClosed) {
        throw new Error('PreparedStatement has been closed');
      }
      this.assertUsable();
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
        return isClosed || isTxFinished();
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
        await this.beforeStatement();
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
                this.transaction,
                this.serialize(callParams),
                fields,
                this.types,
              ),
            callOptions,
            () => cancelAttachmentOperation(this.attachment),
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
            this.types,
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
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const rawOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        const callOptions: QueryStreamOptions =
          rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
            ? { ...rawOptions, timeoutMs: currentTimeoutMs }
            : rawOptions;
        checkParamCount(callParams.length);
        validateTimeoutMs(callOptions.timeoutMs);
        const batchSize = resolveBatchSize(callOptions.batchSize);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const beforeStmt = () => this.beforeStatement();
        const serializeParams = () => this.serialize(callParams);
        const tx = this.transaction;
        const customTypes = this.types;

        return (async function* (): AsyncIterableIterator<QueryResult<T>> {
          assertOpen();
          assertNotAborted(callOptions.signal);
          const totalTimeoutMs = validateTimeoutMs(callOptions.timeoutMs);
          const deadline =
            totalTimeoutMs && totalTimeoutMs > 0
              ? Date.now() + totalTimeoutMs
              : undefined;
          const checkStreamDeadline = (): void => {
            assertNotAborted(callOptions.signal);
            if (deadline !== undefined && Date.now() >= deadline) {
              throw createTimeoutError(totalTimeoutMs!);
            }
          };
          await beforeStmt();
          const serializedParams = serializeParams();
          const hasPerCallTimeout =
            rawOptions.timeoutMs !== undefined && rawOptions.timeoutMs !== currentTimeoutMs;
          if (hasPerCallTimeout) {
            await applyStatementHandleTimeout(nativeStmt, rawOptions.timeoutMs);
          }
          try {
            for await (const batch of streamRows<T>(
              nativeStmt,
              tx,
              serializedParams,
              fields,
              rowMode,
              batchSize,
              customTypes,
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
        await this.beforeStatement();
        const hasPerCallTimeout =
          execOptions.timeoutMs !== undefined && execOptions.timeoutMs !== currentTimeoutMs;
        if (hasPerCallTimeout) {
          await applyStatementHandleTimeout(nativeStmt, execOptions.timeoutMs);
        }
        try {
          await runWithCancellation(
            async () => {
              await nativeStmt.execute(
                this.transaction,
                await bindParams(nativeStmt, this.transaction, this.serialize(callParams)),
              );
            },
            effectiveOptions,
            () => cancelAttachmentOperation(this.attachment),
          );
          const affectedRows = await readAffectedRecords(nativeStmt);
          return { affectedRows };
        } finally {
          if (hasPerCallTimeout) {
            await applyStatementHandleTimeout(nativeStmt, currentTimeoutMs).catch(() => undefined);
          }
        }
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        await this.beforeStatement();
        if (!Array.isArray(rows)) {
          throw new TypeError('execBatch takes an array of parameter rows');
        }
        for (const row of rows) {
          checkParamCount(row.length);
        }
        if (rows.length === 0) return { affectedRows: 0 };
        const serializedRows = this.types?.serializers?.length
          ? rows.map((row) => this.serialize(row))
          : rows;
        if (
          serializedRows.length > 1 &&
          (await tryExecuteNativeBatch(nativeStmt, this.transaction, serializedRows))
        ) {
          return { affectedRows: serializedRows.length };
        }
        let total = 0;
        for (const row of serializedRows) {
          await nativeStmt.execute(
            this.transaction,
            await bindParams(nativeStmt, this.transaction, row),
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

  /**
   * Describe a statement's shape inside this transaction without running it.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    this.assertUsable();
    await this.beforeStatement();
    const text = toStatement(sql).sql;

    const stmt = await this.attachment.prepare(this.transaction, text);
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
  }

  /**
   * Bulk-import CSV or JSONLines (`'jsonl'` / `'ndjson'`) records from a
   * `ReadableStream` or `AsyncIterable` into `tableName` inside this transaction.
   */
  async copyFromStream(
    tableName: string,
    stream:
      | ReadableStream<Uint8Array | string>
      | AsyncIterable<Uint8Array | string>,
    options: CopyFromOptions = {},
  ): Promise<CopyResult> {
    this.assertUsable();
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    return executeCopyFromStream(this, tableName, stream, options);
  }

  /**
   * Stream a table or `SELECT` query inside this transaction as UTF-8 CSV or
   * JSONLines (`'jsonl'` / `'ndjson'`).
   */
  copyToStream(
    sql: SqlFragment,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: CopyToOptions,
  ): ReadableStream<Uint8Array>;
  copyToStream(
    tableOrQuery: string | SqlFragment,
    paramsOrOptions: QueryParams | CopyToOptions = [],
    maybeOptions: CopyToOptions = {},
  ): ReadableStream<Uint8Array> {
    this.assertUsable();
    return buildCopyToStream(this, tableOrQuery, paramsOrOptions, maybeOptions);
  }

  /**
    * Create a segmented writable BLOB stream (`WritableStream<Uint8Array>`)
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    this.assertUsable();
    await this.beforeStatement();
    resolveBlobSegmentSize(options.segmentSize, true);

    if (typeof this.attachment.createBlob === 'function') {
      const stream = await this.attachment.createBlob(this.transaction);
      return buildBlobWritableStream(
        {
          writeSegment: async (segment) => {
            this.assertUsable();
            const buf = Buffer.from(
              segment.buffer,
              segment.byteOffset,
              segment.byteLength,
            );
            await stream.write(buf);
          },
          close: async (totalBytes) => {
            this.assertUsable();
            await stream.close();
            const nativeBlob = stream.blob;
            const idBytes =
              nativeBlob?.id instanceof Uint8Array
                ? new Uint8Array(
                    nativeBlob.id.buffer,
                    nativeBlob.id.byteOffset,
                    nativeBlob.id.byteLength,
                  )
                : new Uint8Array(8);
            return createBlobHandle(idBytes, totalBytes, { nativeBlob });
          },
          abort: async () => {
            await stream.cancel().catch(() => undefined);
          },
        },
        options,
      );
    }

    const chunks: Uint8Array[] = [];
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          this.assertUsable();
          chunks.push(segment.slice());
        },
        close: async (totalBytes) => {
          this.assertUsable();
          const stagedBytes = new Uint8Array(totalBytes);
          let pos = 0;
          for (const c of chunks) {
            stagedBytes.set(c, pos);
            pos += c.byteLength;
          }
          return createBlobHandle(new Uint8Array(8), totalBytes, {
            stagedBytes,
          });
        },
        abort: async () => {
          chunks.length = 0;
        },
      },
      options,
    );
  }

  /**
   * Open a Firebird `BLOB` column (from a `SELECT` query or a {@link BlobHandle})
   * inside this transaction as a segmented Web `ReadableStream<Uint8Array>`
   * backed by `IBlob::getSegment`.
   */
  async openBlobStream(
    handle: BlobHandle,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: SqlFragment,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: string | SqlFragment,
    params?: QueryParams | BlobStreamOptions,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions: QueryParams | BlobStreamOptions = [],
    maybeOptions: BlobStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertUsable();
    await this.beforeStatement();

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
      const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      if (staged) {
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              this.assertUsable();
              if (offset >= staged.byteLength) return null;
              const end = Math.min(offset + maxBytes, staged.byteLength);
              const slice = staged.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      const fbBlob =
        ((sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.nativeBlob as FbBlob | undefined) ??
        new FbBlob(this.attachment, sqlOrHandle.blobId);
      const stream = await this.attachment.openBlob(this.transaction, fbBlob);
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            this.assertUsable();
            const buf = Buffer.alloc(maxBytes);
            const n = await stream.read(buf);
            if (n < 0) return null;
            return new Uint8Array(buf.buffer, buf.byteOffset, n);
          },
          close: async () => {
            await stream.close().catch(() => undefined);
          },
        },
        opts,
      );
    }

    const { statement, options } = resolveQueryCall<BlobStreamOptions>(
      sqlOrHandle,
      paramsOrOptions,
      maybeOptions,
    );
    resolveBlobSegmentSize(options.segmentSize, false);

    return openNativeQueryBlobStream(
      this.attachment,
      this.transaction,
      this.statements,
      statement.sql,
      this.serialize(statement.params),
      options,
      false,
      () => this.assertUsable(),
    );
  }

  /**
   * Return Firebird's execution plan for `sql` (`IStatement::getPlan`) inside
   * this transaction without executing the statement.
   */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    this.assertUsable();
    await this.beforeStatement();
    const text = toStatement(sql).sql;
    const detailed = options.detailed === true;

    const stmt = await this.attachment.prepare(this.transaction, text);
    try {
      return await explainStatement(stmt, detailed);
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
  }

  private async *streamQuery<T>(
    statement: ParsedStatement,
    rowMode: RowMode,
    batchSize: number,
    options: StatementExecutionOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    assertNotAborted(options.signal);
    const totalTimeoutMs = validateTimeoutMs(options.timeoutMs);
    const deadline =
      totalTimeoutMs && totalTimeoutMs > 0
        ? Date.now() + totalTimeoutMs
        : undefined;
    const checkStreamDeadline = (): void => {
      assertNotAborted(options.signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw createTimeoutError(totalTimeoutMs!);
      }
    };
    await this.beforeStatement();

    const serialized = this.serialize(statement.params);
    let engineFailed = false;
    const lease = await this.statements.acquire(this.transaction, statement.sql);
    const stmt = lease.stmt;

    try {
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
        this.transaction,
        serialized,
        fields,
        rowMode,
        batchSize,
        this.types,
        () => {
          engineFailed = true;
        },
      )) {
        checkStreamDeadline();
        yield batch;
        checkStreamDeadline();
      }
    } finally {
      if (totalTimeoutMs !== undefined && totalTimeoutMs > 0 && !engineFailed) {
        await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
      }
      await lease.release(engineFailed);
    }
  }
}
