/**
 * firebird-browser-tx.ts – `FirebirdBrowserTransaction` implementation (`M20 Item 5`).
 */

import { DirectTransport, type EngineHandle, type EngineTransport } from './engine-transport';
import { extractMutatedTables } from './live-tables';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobColumnIndex,
  resolveBlobSegmentSize,
} from './blob-stream';
import { buildCopyToStream, executeCopyFromStream } from './copy-stream';
import { applyTypes, applySerializers, type TypeOptions } from './value-types';
import { toStatement, resolveQueryCall, resolveBatchSize } from '../sql-tag';
import type { SqlFragment, Statement } from '../sql-tag';
import type { UdrManager } from './udr';
import {
  type ArrayModeOptions,
  assertNotAborted,
  createTimeoutError,
  type FirebirdTransactionClient,
  runWithCancellation,
  type UnifiedExecuteResult,
  validateSavepointName,
  validateTimeoutMs,
} from '../database-core';
import type { ColumnarQueryResult } from '../columnar';
import type { StandardSchemaV1, TypedSqlFragment } from '../schema-validation';
import {
  buildEnginePipelineRequests,
  decodeEnginePipelineResponses,
  executePipelineFallback,
  normalizePipelineOperations,
  type PipelineOperation,
  type PipelineOptions,
  type PipelineResults,
} from '../pipeline';
import {
  createArrowIpcReadableStream,
  createColumnarStreamFromRowStream,
  resolveColumnarStreamArgs,
  type ArrowStreamOptions,
  type ColumnarStreamOptions,
} from '../columnar-stream';
import {
  createTableRepository,
  type TableOptions,
  type TableRepository,
} from '../table-api';
import {
  assertBatchParameterRows,
  assertPreparedParamCount,
  decodePayloadColumnar,
  executeArrowFromColumnar,
  executeColumnarViaArrayQuery,
  extractEffectiveQuerySchema,
  finalizeQueryResultWithSchema,
  resolveColumnarQueryCall,
  resolvePreparedCallArgs,
  type QueryArrowOptions,
} from '../shared-driver-ops';
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
} from '../types';

/** Result returned by `FirebirdBrowser.exec()` and `FirebirdBrowser.execBatch()`. */
export interface ExecResult {
  affectedRows: number;
}

// ---------------------------------------------------------------------------
// Transaction handle
// ---------------------------------------------------------------------------

/**
 * A handle to an active transaction (or nested savepoint) in the browser WASM engine.
 *
 * Statements issued here are bound to the transaction handle, so a rollback
 * really does undo them.
 */
export class FirebirdBrowserTransaction implements FirebirdTransactionClient {
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
    private readonly engine: EngineTransport,
    private readonly dbHandle: EngineHandle,
    private readonly txHandle: EngineHandle,
    private readonly types?: TypeOptions,
    readonly savepointName?: string,
    private readonly parent?: FirebirdBrowserTransaction,
    nextSavepointId?: () => number,
    private readonly udr?: UdrManager,
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
      await this.engine.execute(
        this.dbHandle,
        this.txHandle,
        `ROLLBACK TO SAVEPOINT ${this.savepointName}`,
        [],
      );
      await this.engine.execute(
        this.dbHandle,
        this.txHandle,
        `RELEASE SAVEPOINT ${this.savepointName} ONLY`,
        [],
      );
      return;
    }
    await this.engine.rollback(this.txHandle);
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
  savepoint<T>(fn: (sp: FirebirdBrowserTransaction) => Promise<T>): Promise<T>;
  savepoint<T>(
    name: string,
    fn: (sp: FirebirdBrowserTransaction) => Promise<T>,
  ): Promise<T>;
  async savepoint<T>(
    nameOrFn: string | ((sp: FirebirdBrowserTransaction) => Promise<T>),
    maybeFn?: (sp: FirebirdBrowserTransaction) => Promise<T>,
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

    await this.engine.execute(
      this.dbHandle,
      this.txHandle,
      `SAVEPOINT ${name}`,
      [],
    );

    const sp = new FirebirdBrowserTransaction(
      this.engine,
      this.dbHandle,
      this.txHandle,
      this.types,
      name,
      this,
      this.nextSavepointId,
      this.udr,
    );

    let result: T;
    try {
      result = await fn(sp);
    } catch (err) {
      if (!sp.isFinished) {
        sp.markFinished();
        await this.engine
          .execute(
            this.dbHandle,
            this.txHandle,
            `ROLLBACK TO SAVEPOINT ${name}`,
            [],
          )
          .catch(() => undefined);
        await this.engine
          .execute(
            this.dbHandle,
            this.txHandle,
            `RELEASE SAVEPOINT ${name} ONLY`,
            [],
          )
          .catch(() => undefined);
      }
      throw err;
    }

    if (!sp.isFinished) {
      sp.markFinished();
      for (const table of sp.committedTables) {
        this.mutatedTablesSet.add(table);
      }
      await this.engine.execute(
        this.dbHandle,
        this.txHandle,
        `RELEASE SAVEPOINT ${name} ONLY`,
        [],
      );
    }

    return result;
  }

  /**
   * Cancel the currently running statement on this transaction's database
   * attachment via `IAttachment::cancelOperation(status, fb_cancel_raise)`.
   */
  async cancelOperation(): Promise<void> {
    if (typeof this.engine.cancelOperation === 'function') {
      await this.engine.cancelOperation(this.dbHandle);
    }
  }

  private async applyOneShotTimeout(timeoutMs?: number): Promise<void> {
    const validated = validateTimeoutMs(timeoutMs);
    if (
      validated !== undefined &&
      validated > 0 &&
      typeof this.engine.stmtSetTimeout === 'function'
    ) {
      await this.engine.stmtSetTimeout(0, validated);
    }
  }

  /**
   * Execute a DDL/DML statement inside this transaction.
   *
   * @returns the number of rows affected.
   */
  async exec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ExecResult> {
    this.assertUsable();
    const rawParams = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
    const execOpts = Array.isArray(paramsOrOptions)
      ? maybeOptions
      : (paramsOrOptions ?? {});
    const stmt = toStatement(sql, rawParams);
    if (this.udr) {
      this.udr.inspectDdl(stmt.sql);
      if (this.udr.hasBridgeRoutines) {
        const intercepted = await this.udr.executeIfIntercepted(
          stmt.sql,
          stmt.params,
        );
        if (intercepted.intercepted) {
          return { affectedRows: intercepted.affectedRows };
        }
        const rewritten = await this.udr.rewriteStatement(
          stmt.sql,
          stmt.params,
        );
        return this.finishTxExec(rewritten.sql, rewritten.params, execOpts);
      }
    }
    return this.finishTxExec(stmt.sql, stmt.params, execOpts);
  }

  /**
   * Execute a DDL/DML statement inside this transaction and return `{ affectedRows, changes }` (`M18 Item 3`).
   */
  async execute(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: StatementExecutionOptions = {},
  ): Promise<UnifiedExecuteResult> {
    const res = await this.exec(sql, params, options);
    return { affectedRows: res.affectedRows, changes: res.affectedRows };
  }

  private async finishTxExec(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | StatementExecutionOptions = [],
    maybeOptions: StatementExecutionOptions = {},
  ): Promise<ExecResult> {
    this.assertUsable();
    const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
    const options = Array.isArray(paramsOrOptions)
      ? maybeOptions
      : (paramsOrOptions ?? {});
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    const statement = toStatement(sql, params);
    const affectedRows = await runWithCancellation(
      async () => {
        await this.applyOneShotTimeout(options.timeoutMs);
        return this.engine.execute(
          this.dbHandle,
          this.txHandle,
          statement.sql,
          applySerializers(statement.params, this.types?.serializers),
        );
      },
      options,
      () => this.cancelOperation(),
    );
    this.recordMutatedTables(statement.sql);
    return { affectedRows };
  }

  /**
   * Execute one statement once per row of parameters inside this
   * transaction: prepared once, executed per row.  The rows before a failure
   * stay, as statements run one by one would; the transaction decides.
   *
   * @returns the rows affected over the whole batch.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<ExecResult> {
    this.assertUsable();
    if (!Array.isArray(rows)) {
      throw new TypeError('execBatch takes an array of parameter rows');
    }
    const affectedRows = await this.engine.executeBatch(
      this.dbHandle,
      this.txHandle,
      sql,
      rows.map((row) => applySerializers(row, this.types?.serializers)),
    );
    if (rows.length > 0) {
      this.recordMutatedTables(sql);
    }
    return { affectedRows };
  }

  /**
   * Execute multiple heterogeneous `query`, `queryColumnar`, `queryArrow`,
   * `execute`, and `execBatch` operations bound to this transaction handle in a
   * single cross-worker round-trip (`M20 Item 2`).
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
    const steps = normalizePipelineOperations(ops, (p) =>
      applySerializers(p, this.types?.serializers),
    );

    let results: unknown[];
    if (typeof this.engine.pipeline === 'function') {
      const { requests } = buildEnginePipelineRequests(steps, true);
      const responses = await this.engine.pipeline(
        this.dbHandle,
        this.txHandle,
        requests,
      );
      results = await decodeEnginePipelineResponses(
        steps,
        responses,
        this.columnarShapeCache,
        (res, rm) => applyTypes(res, this.types, rm),
      );
    } else {
      results = await executePipelineFallback(steps, this);
    }

    assertNotAborted(options.signal);
    for (const s of steps) {
      if (s.clientKind === 'execute' || s.clientKind === 'execBatch') {
        this.recordMutatedTables(s.sql);
      }
    }
    return results as PipelineResults<TOps>;
  }

  private readonly columnarShapeCache = new Map<number, readonly FieldInfo[]>();

  /** Execute a SELECT inside this transaction and return rows. */
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
    const rowMode = options.rowMode ?? 'object';
    if (this.udr && this.udr.hasBridgeRoutines) {
      const rewritten = await this.udr.rewriteStatement(
        statement.sql,
        statement.params,
      );
      statement.sql = rewritten.sql;
      statement.params = rewritten.params;
      const intercepted = await this.udr.queryIfIntercepted<T>(
        statement.sql,
        statement.params,
        rowMode,
        {
          isDirect: this.engine instanceof DirectTransport,
          query: <R extends Row = Row>(
            s: string,
            p: QueryParams = [],
            o?: { rowMode?: RowMode },
          ) =>
            this.engine.query<R>(
              this.dbHandle,
              this.txHandle,
              s,
              applySerializers(p, this.types?.serializers),
              o?.rowMode ?? 'object',
              this.types?.binary === true,
            ),
          exec: (s: string, p: QueryParams = []) =>
            this.engine.execute(
              this.dbHandle,
              this.txHandle,
              s,
              applySerializers(p, this.types?.serializers),
            ),
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
    const rawResult = await this.finishTxQuery<T>(statement.sql, statement.params, options);
    return finalizeQueryResultWithSchema(rawResult, schema, rowMode);
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
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    if (
      typeof this.engine.queryBinary === 'function' &&
      !(this.udr && this.udr.hasBridgeRoutines)
    ) {
      const payload = await runWithCancellation(
        async () => {
          await this.applyOneShotTimeout(options.timeoutMs);
          return this.engine.queryBinary!(
            this.dbHandle,
            this.txHandle,
            statement.sql,
            applySerializers(statement.params, this.types?.serializers),
            true,
          );
        },
        options,
        () => this.cancelOperation(),
      );
      return decodePayloadColumnar(payload, this.columnarShapeCache);
    }
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

  queryColumnarStream(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | ColumnarStreamOptions,
    maybeOptions?: ColumnarStreamOptions,
  ): AsyncIterableIterator<ColumnarQueryResult> {
    this.assertUsable();
    return createColumnarStreamFromRowStream(
      (s, p, o) => this.queryStream<Row>(s, p ?? [], o),
      sql,
      paramsOrOptions,
      maybeOptions,
    );
  }

  queryArrowStream(
    sql: string | SqlFragment,
    paramsOrOptions?: QueryParams | ArrowStreamOptions,
    maybeOptions?: ArrowStreamOptions,
  ): ReadableStream<Uint8Array> {
    this.assertUsable();
    const { options } = resolveColumnarStreamArgs(paramsOrOptions, maybeOptions);
    return createArrowIpcReadableStream(
      () => this.queryColumnarStream(sql, paramsOrOptions, maybeOptions),
      async () => (await this.describeQuery(sql)).fields,
      options,
    );
  }

  table<T extends Row = Row, K = unknown>(
    tableName: string,
    options?: TableOptions<T>,
  ): TableRepository<T, K> {
    this.assertUsable();
    return createTableRepository<T, K>(this, tableName, options);
  }

  private async finishTxQuery<T = Row>(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: { rowMode?: RowMode } & StatementExecutionOptions = {},
  ): Promise<QueryResult<T>> {
    this.assertUsable();
    assertNotAborted(options.signal);
    validateTimeoutMs(options.timeoutMs);
    const statement = toStatement(sql, params);
    const rowMode = options.rowMode ?? 'object';
    const raw = await runWithCancellation(
      async () => {
        await this.applyOneShotTimeout(options.timeoutMs);
        return this.engine.query<T>(
          this.dbHandle,
          this.txHandle,
          statement.sql,
          applySerializers(statement.params, this.types?.serializers),
          rowMode,
          this.types?.binary === true,
        );
      },
      options,
      () => this.cancelOperation(),
    );
    return applyTypes(raw, this.types, rowMode);
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
    if (typeof this.engine.explain !== 'function') {
      throw new Error('The configured EngineTransport does not support explain()');
    }
    return this.engine.explain(
      this.dbHandle,
      this.txHandle,
      toStatement(sql).sql,
      options.detailed === true,
    );
  }

  /**
   * Prepare a SQL statement inside this transaction and return a reusable
   * {@link PreparedStatement} handle.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    this.assertUsable();
    const sqlText = toStatement(sql).sql;
    const desc: QueryDescription & { handle?: EngineHandle } =
      typeof this.engine.prepare === 'function'
        ? await this.engine.prepare(this.dbHandle, this.txHandle, sqlText)
        : await this.engine.describe(this.dbHandle, this.txHandle, sqlText);

    const params = desc.params.map((p) => ({ ...p }));
    const fields = desc.fields.map((f) => ({ ...f }));
    const stmtHandle = desc.handle ?? 0;
    let isClosed = false;
    let currentTimeoutMs = 0;

    const assertOpen = (): void => {
      if (isClosed) {
        throw new Error('PreparedStatement has been closed');
      }
      this.assertUsable();
    };

    const checkParamCount = (actual: number): void => {
      assertPreparedParamCount(params.length, actual);
    };

    const isTxFinished = () => this.isFinished;

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
        return isClosed || isTxFinished();
      },
      get timeoutMs() {
        return currentTimeoutMs;
      },
      setTimeout: async (timeoutMs: number) => {
        assertOpen();
        const validated = validateTimeoutMs(timeoutMs) ?? 0;
        currentTimeoutMs = validated;
        if (stmtHandle > 0 && typeof this.engine.stmtSetTimeout === 'function') {
          await this.engine.stmtSetTimeout(stmtHandle, validated);
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
        if (stmtHandle > 0 && typeof this.engine.queryStmt === 'function') {
          assertNotAborted(callOptions.signal);
          validateTimeoutMs(callOptions.timeoutMs);
          const rowMode = callOptions.rowMode ?? 'object';
          const raw = await runWithCancellation(
            async () => {
              await this.applyOneShotTimeout(callOptions.timeoutMs);
              return this.engine.queryStmt!<T>(
                this.dbHandle,
                this.txHandle,
                stmtHandle,
                applySerializers(callParams, this.types?.serializers),
                rowMode,
                this.types?.binary === true,
              );
            },
            callOptions,
            () => this.cancelOperation(),
          );
          return finalizeQueryResultWithSchema(
            applyTypes(raw, this.types, rowMode),
            callOptions.schema,
            rowMode,
          );
        }
        return this.query<T & Row>(sqlText, callParams, {
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
            ? this.streamQuery(
                { sql: sqlText, params: callParams },
                callOptions.rowMode ?? 'object',
                batchSize,
                stmtHandle,
                callOptions,
              )
            : this.queryStream(sqlText, callParams, {
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
        if (stmtHandle > 0 && typeof this.engine.executeStmt === 'function') {
          assertNotAborted(effectiveOptions.signal);
          validateTimeoutMs(effectiveOptions.timeoutMs);
          const affectedRows = await runWithCancellation(
            async () => {
              await this.applyOneShotTimeout(effectiveOptions.timeoutMs);
              return this.engine.executeStmt!(
                this.dbHandle,
                this.txHandle,
                stmtHandle,
                applySerializers(callParams, this.types?.serializers),
              );
            },
            effectiveOptions,
            () => this.cancelOperation(),
          );
          return { affectedRows };
        }
        return this.exec(sqlText, callParams, effectiveOptions);
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        assertBatchParameterRows(rows, params.length);
        if (
          stmtHandle > 0 &&
          typeof this.engine.executeBatchStmt === 'function'
        ) {
          const affectedRows = await this.engine.executeBatchStmt(
            this.dbHandle,
            this.txHandle,
            stmtHandle,
            rows.map((row) => applySerializers(row, this.types?.serializers)),
          );
          return { affectedRows };
        }
        return this.execBatch(sqlText, rows);
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        if (stmtHandle > 0 && typeof this.engine.stmtClose === 'function') {
          await this.engine.stmtClose(stmtHandle).catch(() => undefined);
        }
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
    return this.engine.describe(this.dbHandle, this.txHandle, toStatement(sql).sql);
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
   * inside this transaction backed by Firebird `IBlob::putSegment`.
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    this.assertUsable();
    resolveBlobSegmentSize(options.segmentSize, true);

    if (
      typeof this.engine.blobCreate === 'function' &&
      typeof this.engine.blobPutSegment === 'function' &&
      typeof this.engine.blobClose === 'function'
    ) {
      const { blobHandle, blobId } = await this.engine.blobCreate(
        this.dbHandle,
        this.txHandle,
      );
      return buildBlobWritableStream(
        {
          writeSegment: async (segment) => {
            this.assertUsable();
            await this.engine.blobPutSegment!(blobHandle, segment);
          },
          close: async (totalBytes) => {
            this.assertUsable();
            const finalId = await this.engine.blobClose!(blobHandle, false);
            return createBlobHandle(
              finalId.byteLength === 8 ? finalId : blobId,
              totalBytes,
            );
          },
          abort: async () => {
            if (!this.finished) {
              await this.engine
                .blobClose!(blobHandle, true)
                .catch(() => undefined);
            }
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

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
    const stagingId = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      const staged = stagingId;
      if (staged || typeof this.engine.blobOpenId !== 'function') {
        const bytes = staged ?? new Uint8Array(0);
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              this.assertUsable();
              if (offset >= bytes.byteLength) return null;
              const end = Math.min(offset + maxBytes, bytes.byteLength);
              const slice = bytes.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      const blobHandle = await this.engine.blobOpenId(
        this.dbHandle,
        this.txHandle,
        sqlOrHandle.blobId,
      );
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            this.assertUsable();
            return this.engine.blobGetSegment!(blobHandle, maxBytes);
          },
          close: async () => {
            if (!this.finished) {
              await this.engine.blobClose!(blobHandle, false);
            }
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

    let colIndex = 0;
    if (options.column !== undefined) {
      const desc = await this.describeQuery(statement.sql);
      colIndex = resolveBlobColumnIndex(
        options.column,
        desc.fields.map((f) => f.name),
      );
    }

    if (
      typeof this.engine.blobOpenQuery === 'function' &&
      typeof this.engine.blobGetSegment === 'function' &&
      typeof this.engine.blobClose === 'function'
    ) {
      const blobHandle = await this.engine.blobOpenQuery(
        this.dbHandle,
        this.txHandle,
        statement.sql,
        applySerializers(statement.params, this.types?.serializers),
        colIndex,
      );
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            this.assertUsable();
            return this.engine.blobGetSegment!(blobHandle, maxBytes);
          },
          close: async () => {
            if (!this.finished) {
              await this.engine.blobClose!(blobHandle, false);
            }
          },
        },
        options,
      );
    }

    const res = await this.query(statement.sql, statement.params, {
      rowMode: 'array',
    });
    if (res.rows.length === 0) {
      throw new Error('openBlobStream: query returned no rows');
    }
    const cell = res.rows[0]![colIndex];
    if (cell === null || cell === undefined) {
      throw new Error('openBlobStream: BLOB column value is NULL');
    }
    const bytes =
      cell instanceof Uint8Array
        ? cell
        : typeof cell === 'string'
          ? new TextEncoder().encode(cell)
          : new Uint8Array(0);
    let offset = 0;
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          this.assertUsable();
          if (offset >= bytes.byteLength) return null;
          const end = Math.min(offset + maxBytes, bytes.byteLength);
          const slice = bytes.slice(offset, end);
          offset = end;
          return slice;
        },
        close: async () => undefined,
      },
      options,
    );
  }

  /** Stream a SELECT inside this transaction in batches of `batchSize` rows. */
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
    paramsOrOptions: QueryParams | ({ rowMode?: RowMode; batchSize?: number } & StatementExecutionOptions) = [],
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
      undefined,
      options,
    );
  }

  private async *streamQuery<T>(
    statement: Statement,
    rowMode: RowMode,
    batchSize: number,
    stmtHandle?: EngineHandle,
    execOptions: StatementExecutionOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    assertNotAborted(execOptions.signal);
    const totalTimeoutMs = validateTimeoutMs(execOptions.timeoutMs);
    const deadline =
      totalTimeoutMs && totalTimeoutMs > 0
        ? Date.now() + totalTimeoutMs
        : undefined;
    const stepOptions = (): StatementExecutionOptions => ({
      signal: execOptions.signal,
      timeoutMs:
        deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined,
    });

    if (
      typeof this.engine.cursorOpen !== 'function' ||
      typeof this.engine.cursorFetch !== 'function' ||
      typeof this.engine.cursorClose !== 'function'
    ) {
      const full = (await this.query(statement.sql, statement.params, {
        rowMode,
        signal: execOptions.signal,
        timeoutMs: execOptions.timeoutMs,
      })) as QueryResult<T>;
      for (let i = 0; i < full.rows.length; i += batchSize) {
        assertNotAborted(execOptions.signal);
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

    const binaryBlobs = this.types?.binary === true;
    const serialized = applySerializers(statement.params, this.types?.serializers);
    let cursorHandle = await runWithCancellation(
      async () => {
        await this.applyOneShotTimeout(totalTimeoutMs);
        return stmtHandle &&
          stmtHandle > 0 &&
          typeof this.engine.cursorOpenStmt === 'function'
          ? this.engine.cursorOpenStmt(
              this.dbHandle,
              this.txHandle,
              stmtHandle,
              serialized,
            )
          : this.engine.cursorOpen!(
              this.dbHandle,
              this.txHandle,
              statement.sql,
              serialized,
            );
      },
      stepOptions(),
      () => this.cancelOperation(),
    );

    try {
      while (true) {
        this.assertUsable();
        assertNotAborted(execOptions.signal);
        if (deadline !== undefined && Date.now() >= deadline) {
          throw createTimeoutError(totalTimeoutMs!);
        }
        const batch = await runWithCancellation(
          () =>
            this.engine.cursorFetch!<T>(
              cursorHandle,
              batchSize,
              rowMode,
              binaryBlobs,
            ),
          stepOptions(),
          () => this.cancelOperation(),
        );
        if (batch.rows.length === 0) {
          break;
        }
        yield applyTypes(batch, this.types, rowMode);
      }

      const toClose = cursorHandle;
      cursorHandle = 0;
      if (!this.isFinished) {
        await this.engine.cursorClose(toClose);
      }
    } finally {
      if (cursorHandle !== 0) {
        await this.engine.cursorClose(cursorHandle).catch(() => undefined);
      }
    }
  }
}
