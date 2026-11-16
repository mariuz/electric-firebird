/**
 * pipeline.ts – Batched Multi-Statement Pipeline Execution (`db.pipeline()` / `tx.pipeline()`) (`M20 Item 2`).
 *
 * Batches heterogeneous `query`, `queryColumnar`, `queryArrow`, `execute`, and `execBatch`
 * operations into a single Worker / leader-tab round-trip (with `"FBP\x01"` / `"FBP\x02"`
 * binary parameter frames and zero-copy `Transferable` `"FBR\x02"` result buffers),
 * optionally wrapped in a single atomic transaction inside the engine Worker.
 */

import type {
  FieldInfo,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
  TransactionOptions,
} from './types';
import { isSqlFragment, type SqlFragment } from './sql-tag';
import {
  decodeArrowIpc,
  decodeBinaryResultColumnar,
  encodeArrowIpc,
  rowsToColumnarResult,
  type ArrowIpcOptions,
  type ColumnarQueryResult,
} from './columnar';
import {
  TypedSqlFragment,
  validateRowsWithSchema,
  type StandardSchemaV1,
} from './schema-validation';
import {
  decodeBinaryResultPayload,
  type BinaryResultPayload,
} from './browser/binary-result';
import {
  decodeWireParamRows,
  decodeWireParams,
  encodeWireParamRows,
  encodeWireParams,
  isWireParamRowsBuffer,
  isWireParamsBuffer,
} from './browser/wire-params';

void decodeArrowIpc;

/** Single query operation inside `db.pipeline([...])` (`M20 Item 2`). */
export interface PipelineQueryOp<T = Row> {
  readonly kind?: 'query';
  readonly sql: string | SqlFragment;
  readonly params?: QueryParams | Uint8Array;
  readonly rowMode?: RowMode;
  readonly binaryBlobs?: boolean;
  readonly schema?: StandardSchemaV1<unknown, T>;
}

/** Single columnar query operation inside `db.pipeline([...])` (`M20 Item 2`). */
export interface PipelineColumnarOp {
  readonly kind: 'queryColumnar';
  readonly sql: string | SqlFragment;
  readonly params?: QueryParams | Uint8Array;
  readonly binaryBlobs?: boolean;
}

/** Single Apache Arrow IPC query operation inside `db.pipeline([...])` (`M20 Item 2`). */
export interface PipelineArrowOp {
  readonly kind: 'queryArrow';
  readonly sql: string | SqlFragment;
  readonly params?: QueryParams | Uint8Array;
  readonly arrowOptions?: ArrowIpcOptions;
  readonly binaryBlobs?: boolean;
}

/** Single DML / DDL execution operation inside `db.pipeline([...])` (`M20 Item 2`). */
export interface PipelineExecuteOp {
  readonly kind: 'execute';
  readonly sql: string | SqlFragment;
  readonly params?: QueryParams | Uint8Array;
}

/** Single batched parameter DML operation inside `db.pipeline([...])` (`M20 Item 2`). */
export interface PipelineBatchOp {
  readonly kind: 'execBatch';
  readonly sql: string | SqlFragment;
  readonly rows: QueryParams[] | Uint8Array;
}

/** Any step accepted by `db.pipeline(ops)` or `tx.pipeline(ops)` (`M20 Item 2`). */
export type PipelineOperation =
  | PipelineQueryOp<Row>
  | PipelineColumnarOp
  | PipelineArrowOp
  | PipelineExecuteOp
  | PipelineBatchOp
  | SqlFragment;

/** Result shape of `execute` / `execBatch` pipeline steps. */
export interface PipelineExecuteStepResult {
  readonly affectedRows: number;
}

/** Union of step result values returned by `pipeline()`. */
export type PipelineStepResult =
  | QueryResult<Row>
  | ColumnarQueryResult
  | Uint8Array
  | PipelineExecuteStepResult;

/** Compile-time mapped tuple type for `db.pipeline(ops)` (`M20 Item 2`). */
export type PipelineResults<TOps extends readonly PipelineOperation[]> = {
  [K in keyof TOps]: TOps[K] extends PipelineColumnarOp
    ? ColumnarQueryResult
    : TOps[K] extends PipelineArrowOp
      ? Uint8Array
      : TOps[K] extends PipelineExecuteOp | PipelineBatchOp
        ? PipelineExecuteStepResult
        : TOps[K] extends TypedSqlFragment<infer TRow>
          ? QueryResult<TRow>
          : TOps[K] extends PipelineQueryOp<infer TRow>
            ? QueryResult<TRow>
            : TOps[K] extends SqlFragment
              ? QueryResult<Row>
              : PipelineStepResult;
};

/** Options for `db.pipeline(ops, options)` (`M20 Item 2`). */
export interface PipelineOptions {
  /**
   * Wrap all pipeline operations in a single atomic transaction (`true` or `TransactionOptions`).
   * On `WorkerTransport`, `BEGIN` + all steps + `COMMIT` execute in **one** Worker round-trip.
   *
   * @default false
   */
  transaction?: boolean | TransactionOptions;
  /** Optional `AbortSignal` checked before launching and after completion. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Wire-level EngineTransport pipeline types
// ---------------------------------------------------------------------------

export type EnginePipelineStepRequest =
  | {
      readonly op: 'execute';
      readonly sql: string;
      readonly stmtHandle?: number;
      readonly params: Uint8Array | QueryParams;
    }
  | {
      readonly op: 'executeBatch';
      readonly sql: string;
      readonly stmtHandle?: number;
      readonly rows: Uint8Array | QueryParams[];
    }
  | {
      readonly op: 'queryBinary';
      readonly sql: string;
      readonly stmtHandle?: number;
      readonly params: Uint8Array | QueryParams;
      readonly binaryBlobs?: boolean;
    };

export interface EnginePipelineWireOptions {
  readonly transaction?: boolean | TransactionOptions;
}

export type EnginePipelineStepResponse =
  | { readonly kind: 'affected'; readonly affectedRows: number }
  | { readonly kind: 'binary'; readonly payload: BinaryResultPayload };

export function isEnginePipelineResponseArray(
  value: unknown,
): value is EnginePipelineStepResponse[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === 'object' &&
    value[0] !== null &&
    ('kind' in value[0])
  );
}

/** Guess whether an untagged SQL statement returns rows (`SELECT` / `WITH` / `RETURNING`). */
export function isRowReturningSql(sqlText: string): boolean {
  const trimmed = sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();
  if (/^(SELECT|WITH)\b/i.test(trimmed)) {
    return true;
  }
  return /\bRETURNING\b/i.test(trimmed);
}

export interface NormalizedPipelineStep {
  readonly clientKind: 'query' | 'queryColumnar' | 'queryArrow' | 'execute' | 'execBatch';
  readonly sql: string;
  readonly params: QueryParams | Uint8Array;
  readonly batchRows?: QueryParams[] | Uint8Array;
  readonly rowMode: RowMode;
  readonly binaryBlobs: boolean;
  readonly schema?: StandardSchemaV1<unknown, unknown>;
  readonly arrowOptions?: ArrowIpcOptions;
}

/** Normalize user-supplied `PipelineOperation[]` into uniform steps. */
export function normalizePipelineOperations(
  ops: readonly PipelineOperation[],
  serializeParams?: (params: QueryParams) => QueryParams,
): NormalizedPipelineStep[] {
  return ops.map((rawOp, idx) => {
    if (isSqlFragment(rawOp)) {
      const schema =
        rawOp instanceof TypedSqlFragment ? rawOp.schema : undefined;
      const clientKind = isRowReturningSql(rawOp.sql) ? 'query' : 'execute';
      const serialized =
        serializeParams && rawOp.params.length > 0
          ? serializeParams(rawOp.params)
          : rawOp.params;
      return {
        clientKind,
        sql: rawOp.sql,
        params: serialized,
        rowMode: 'object',
        binaryBlobs: false,
        schema,
      };
    }

    if (!rawOp || typeof rawOp !== 'object') {
      throw new TypeError(`Pipeline operation at index ${idx} must be an object or SqlFragment`);
    }

    let sqlText: string;
    let baseParams: QueryParams | Uint8Array = [];
    let inferredSchema: StandardSchemaV1<unknown, unknown> | undefined;

    if (isSqlFragment(rawOp.sql)) {
      sqlText = rawOp.sql.sql;
      baseParams = rawOp.sql.params;
      if (rawOp.sql instanceof TypedSqlFragment && rawOp.sql.schema) {
        inferredSchema = rawOp.sql.schema;
      }
      if ('params' in rawOp && rawOp.params !== undefined) {
        const extra = rawOp.params;
        const hasExtra = Array.isArray(extra)
          ? extra.length > 0
          : extra.byteLength > 8;
        if (hasExtra) {
          throw new Error(
            `Pipeline step ${idx}: SqlFragment carries its own parameters; do not also pass params`,
          );
        }
      }
    } else if (typeof rawOp.sql === 'string') {
      sqlText = rawOp.sql;
      if ('params' in rawOp && rawOp.params !== undefined) {
        baseParams = rawOp.params;
      }
    } else {
      throw new TypeError(`Pipeline step ${idx} is missing a SQL string or SqlFragment`);
    }

    if (Array.isArray(baseParams) && serializeParams && baseParams.length > 0) {
      baseParams = serializeParams(baseParams);
    }

    if (rawOp.kind === 'execBatch') {
      const batchRows =
        Array.isArray(rawOp.rows) && serializeParams
          ? rawOp.rows.map((r) => serializeParams(r))
          : rawOp.rows;
      return {
        clientKind: 'execBatch',
        sql: sqlText,
        params: [],
        batchRows,
        rowMode: 'object',
        binaryBlobs: false,
      };
    }

    const resolvedKind =
      rawOp.kind ?? (isRowReturningSql(sqlText) ? 'query' : 'execute');

    return {
      clientKind: resolvedKind,
      sql: sqlText,
      params: baseParams,
      rowMode: resolvedKind === 'query' && 'rowMode' in rawOp && rawOp.rowMode ? rawOp.rowMode : 'object',
      binaryBlobs: 'binaryBlobs' in rawOp && Boolean(rawOp.binaryBlobs),
      schema:
        resolvedKind === 'query' && 'schema' in rawOp && rawOp.schema
          ? rawOp.schema
          : inferredSchema,
      arrowOptions:
        resolvedKind === 'queryArrow' && 'arrowOptions' in rawOp
          ? rawOp.arrowOptions
          : undefined,
    };
  });
}

/** Build transport-level `EnginePipelineStepRequest[]` (packing `"FBP\x01"` / `"FBP\x02"` frames). */
export function buildEnginePipelineRequests(
  steps: readonly NormalizedPipelineStep[],
  packWireBinary = true,
): { requests: EnginePipelineStepRequest[]; transferables: Transferable[] } {
  const requests: EnginePipelineStepRequest[] = new Array(steps.length);
  const seenBuffers = new Set<ArrayBufferLike>();
  const transferables: Transferable[] = [];

  const maybeTrackTransfer = (buf: Uint8Array): void => {
    if (
      buf.byteLength > 0 &&
      (typeof SharedArrayBuffer === 'undefined' || !(buf.buffer instanceof SharedArrayBuffer)) &&
      !seenBuffers.has(buf.buffer)
    ) {
      seenBuffers.add(buf.buffer);
      transferables.push(buf.buffer);
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.clientKind === 'execBatch') {
      const rawRows = s.batchRows ?? [];
      if (packWireBinary) {
        // Clone if caller passed a pre-encoded buffer they might reuse, else transfer newly allocated wire frame
        const wire = isWireParamRowsBuffer(rawRows)
          ? rawRows.slice()
          : encodeWireParamRows(rawRows);
        maybeTrackTransfer(wire);
        requests[i] = { op: 'executeBatch', sql: s.sql, rows: wire };
      } else {
        requests[i] = {
          op: 'executeBatch',
          sql: s.sql,
          rows: isWireParamRowsBuffer(rawRows) ? decodeWireParamRows(rawRows) : rawRows,
        };
      }
      continue;
    }

    const packedParams = packWireBinary
      ? isWireParamsBuffer(s.params)
        ? s.params.slice()
        : Array.isArray(s.params) && s.params.length === 0
          ? []
          : encodeWireParams(s.params)
      : isWireParamsBuffer(s.params)
        ? decodeWireParams(s.params)
        : s.params;

    if (packedParams instanceof Uint8Array) {
      maybeTrackTransfer(packedParams);
    }

    if (s.clientKind === 'execute') {
      requests[i] = { op: 'execute', sql: s.sql, params: packedParams };
    } else {
      requests[i] = {
        op: 'queryBinary',
        sql: s.sql,
        params: packedParams,
        binaryBlobs: s.binaryBlobs || s.clientKind === 'queryColumnar' || s.clientKind === 'queryArrow',
      };
    }
  }

  return { requests, transferables };
}

/** Decode `EnginePipelineStepResponse[]` into caller-facing `PipelineStepResult[]`. */
export async function decodeEnginePipelineResponses(
  steps: readonly NormalizedPipelineStep[],
  responses: readonly EnginePipelineStepResponse[],
  shapeCache: Map<number, readonly FieldInfo[]>,
  applyTypeParsers?: <T>(result: QueryResult<T>, rowMode: RowMode) => QueryResult<T>,
): Promise<PipelineStepResult[]> {
  if (responses.length !== steps.length) {
    throw new Error(
      `Pipeline response count (${responses.length}) did not match request count (${steps.length})`,
    );
  }

  const results: PipelineStepResult[] = new Array(steps.length);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const resp = responses[i]!;

    if (resp.kind === 'affected') {
      results[i] = { affectedRows: resp.affectedRows };
      continue;
    }

    const payload = resp.payload;
    if (typeof payload.shapeId === 'number' && payload.shapeFields) {
      shapeCache.set(payload.shapeId, payload.shapeFields);
    }

    if (step.clientKind === 'queryColumnar') {
      results[i] = decodeBinaryResultColumnar(
        payload.binaryResult,
        (id: number) => shapeCache.get(id) ?? [],
      );
      continue;
    }

    if (step.clientKind === 'queryArrow') {
      const col = decodeBinaryResultColumnar(
        payload.binaryResult,
        (id: number) => shapeCache.get(id) ?? [],
      );
      results[i] = encodeArrowIpc(col, step.arrowOptions);
      continue;
    }

    let decoded = decodeBinaryResultPayload<Row>(
      payload,
      step.rowMode,
      step.binaryBlobs,
      shapeCache,
    );
    if (applyTypeParsers) {
      decoded = applyTypeParsers(decoded, step.rowMode);
    }
    if (step.schema) {
      const validated = await validateRowsWithSchema(step.schema, decoded.rows);
      decoded = { fields: decoded.fields, rows: validated as Row[] };
    }
    results[i] = decoded;
  }

  return results;
}

/** Fallback sequential executor used on Node (`FirebirdLite`) or transports without native `pipeline`. */
export async function executePipelineFallback(
  steps: readonly NormalizedPipelineStep[],
  runner: {
    query<T = Row>(
      sql: string,
      params?: QueryParams,
      options?: { rowMode?: RowMode; schema?: StandardSchemaV1<unknown, T> },
    ): Promise<QueryResult<T>>;
    queryColumnar?(sql: string, params?: QueryParams): Promise<ColumnarQueryResult>;
    queryArrow?(
      sql: string,
      params?: QueryParams,
      options?: ArrowIpcOptions,
    ): Promise<Uint8Array>;
    execute(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
    execBatch(sql: string, rows: QueryParams[]): Promise<{ affectedRows: number } | void>;
  },
): Promise<PipelineStepResult[]> {
  const out: PipelineStepResult[] = new Array(steps.length);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.clientKind === 'execBatch') {
      const rows = isWireParamRowsBuffer(s.batchRows)
        ? decodeWireParamRows(s.batchRows)
        : (s.batchRows ?? []);
      const res = await runner.execBatch(s.sql, rows);
      out[i] = {
        affectedRows:
          typeof res === 'object' && res !== null && typeof res.affectedRows === 'number'
            ? res.affectedRows
            : rows.length,
      };
      continue;
    }

    const jsParams = isWireParamsBuffer(s.params)
      ? decodeWireParams(s.params)
      : s.params;

    if (s.clientKind === 'execute') {
      const res = await runner.execute(s.sql, jsParams);
      out[i] = { affectedRows: res.affectedRows };
    } else if (s.clientKind === 'queryColumnar') {
      if (typeof runner.queryColumnar === 'function') {
        out[i] = await runner.queryColumnar(s.sql, jsParams);
      } else {
        const qr = await runner.query(s.sql, jsParams);
        out[i] = rowsToColumnarResult(qr);
      }
    } else if (s.clientKind === 'queryArrow') {
      if (typeof runner.queryArrow === 'function') {
        out[i] = await runner.queryArrow(s.sql, jsParams, s.arrowOptions);
      } else {
        const qr = await runner.query(s.sql, jsParams);
        out[i] = encodeArrowIpc(rowsToColumnarResult(qr), s.arrowOptions);
      }
    } else {
      out[i] = await runner.query<Row>(s.sql, jsParams, {
        rowMode: s.rowMode,
        ...(s.schema ? { schema: s.schema as StandardSchemaV1<unknown, Row> } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prepared Pipeline (`db.preparePipeline()`) (`M21 Item 2`)
// ---------------------------------------------------------------------------

/** Step template accepted by `db.preparePipeline(templates)` (`M21 Item 2`). */
export type PreparedPipelineStepTemplate =
  | {
      readonly kind?: 'query';
      readonly sql: string;
      readonly rowMode?: RowMode;
      readonly binaryBlobs?: boolean;
      readonly schema?: StandardSchemaV1<unknown, Row>;
    }
  | {
      readonly kind: 'queryColumnar';
      readonly sql: string;
      readonly binaryBlobs?: boolean;
    }
  | {
      readonly kind: 'queryArrow';
      readonly sql: string;
      readonly arrowOptions?: ArrowIpcOptions;
      readonly binaryBlobs?: boolean;
    }
  | {
      readonly kind: 'execute';
      readonly sql: string;
    }
  | {
      readonly kind: 'execBatch';
      readonly sql: string;
    };

/** Per-step runtime arguments passed to `preparedPipeline.run(stepInputs)` (`M21 Item 2`). */
export type PreparedPipelineStepInputs<
  TTemplates extends readonly PreparedPipelineStepTemplate[],
> = {
  [K in keyof TTemplates]: TTemplates[K] extends { readonly kind: 'execBatch' }
    ? QueryParams[] | Uint8Array
    : QueryParams | Uint8Array | undefined;
};

/** Mapped tuple result type for `preparedPipeline.run(stepInputs)` (`M21 Item 2`). */
export type PreparedPipelineResults<
  TTemplates extends readonly PreparedPipelineStepTemplate[],
> = {
  [K in keyof TTemplates]: TTemplates[K] extends { readonly kind: 'queryColumnar' }
    ? ColumnarQueryResult
    : TTemplates[K] extends { readonly kind: 'queryArrow' }
      ? Uint8Array
      : TTemplates[K] extends { readonly kind: 'execute' } | { readonly kind: 'execBatch' }
        ? PipelineExecuteStepResult
        : TTemplates[K] extends { readonly schema: StandardSchemaV1<unknown, infer TRow> }
          ? QueryResult<TRow>
          : QueryResult<Row>;
};

/** Reusable pre-compiled multi-statement pipeline (`db.preparePipeline()`) (`M21 Item 2`). */
export interface PreparedPipeline<
  TTemplates extends readonly PreparedPipelineStepTemplate[] = readonly PreparedPipelineStepTemplate[],
> {
  /** Number of steps in this prepared pipeline. */
  readonly length: number;
  /** Whether `close()` has been called. */
  readonly closed: boolean;
  /**
   * Execute all pre-compiled steps in a single round-trip using integer `stmtHandle`s
   * and `"FBP\x01"` / `"FBP\x02"` binary parameter frames without re-parsing SQL.
   */
  run(
    inputs?: PreparedPipelineStepInputs<TTemplates>,
    options?: PipelineOptions,
  ): Promise<PreparedPipelineResults<TTemplates>>;
  /** Release all underlying prepared statement handles. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Build wire-level requests for a `PreparedPipeline` using pre-compiled `stmtHandles`. */
export function buildPreparedEnginePipelineRequests(
  templates: readonly PreparedPipelineStepTemplate[],
  stmtHandles: readonly (number | undefined)[],
  inputs: readonly unknown[] | undefined,
  serializeParams?: (params: QueryParams) => QueryParams,
  packWireBinary = true,
): {
  steps: NormalizedPipelineStep[];
  requests: EnginePipelineStepRequest[];
  transferables: Transferable[];
} {
  const ops: PipelineOperation[] = templates.map((tpl, i) => {
    const arg = inputs?.[i];
    if (tpl.kind === 'execBatch') {
      return {
        kind: 'execBatch',
        sql: tpl.sql,
        rows: (arg as QueryParams[] | Uint8Array | undefined) ?? [],
      };
    }
    return {
      ...tpl,
      params: (arg as QueryParams | Uint8Array | undefined) ?? [],
    } as PipelineOperation;
  });

  const steps = normalizePipelineOperations(ops, serializeParams);
  const { requests, transferables } = buildEnginePipelineRequests(steps, packWireBinary);

  const handleRequests = requests.map((req, idx) => {
    const h = stmtHandles[idx];
    if (h !== undefined && h > 0) {
      return { ...req, sql: '', stmtHandle: h };
    }
    return req;
  });

  return { steps, requests: handleRequests, transferables };
}

/** Shared host adapter used by `FirebirdBrowser.pipeline()` and `FirebirdBrowser.preparePipeline()`. */
export interface BrowserPipelineDriverHost {
  readonly dbHandle: number;
  readonly packWireParams: boolean;
  readonly shapeCache: Map<number, readonly FieldInfo[]>;
  serialize(params: QueryParams): QueryParams;
  applyTypes<T>(result: QueryResult<T>, rowMode: RowMode): QueryResult<T>;
  prepareHandle?(sql: string): Promise<number | undefined>;
  closeHandle?(stmtHandle: number): Promise<void>;
  runEnginePipeline?(
    requests: readonly EnginePipelineStepRequest[],
    options: EnginePipelineWireOptions,
  ): Promise<EnginePipelineStepResponse[]>;
  runFallback(
    steps: readonly NormalizedPipelineStep[],
    transaction?: boolean | TransactionOptions,
  ): Promise<PipelineStepResult[]>;
  onMutatedSql(sqlStatements: readonly string[]): void;
  assertNotAborted(signal?: AbortSignal): void;
}

/** Execute `db.pipeline()` via `BrowserPipelineDriverHost`. */
export async function executeBrowserPipeline<
  const TOps extends readonly PipelineOperation[],
>(
  host: BrowserPipelineDriverHost,
  ops: TOps,
  options: PipelineOptions = {},
): Promise<PipelineResults<TOps>> {
  host.assertNotAborted(options.signal);
  if (ops.length === 0) {
    return [] as unknown as PipelineResults<TOps>;
  }
  const steps = normalizePipelineOperations(ops, (p) => host.serialize(p));

  let results: unknown[];
  if (typeof host.runEnginePipeline === 'function') {
    const { requests } = buildEnginePipelineRequests(steps, host.packWireParams);
    const responses = await host.runEnginePipeline(requests, {
      transaction: options.transaction,
    });
    results = await decodeEnginePipelineResponses(
      steps,
      responses,
      host.shapeCache,
      (res, rm) => host.applyTypes(res, rm),
    );
  } else {
    results = await host.runFallback(steps, options.transaction);
  }

  host.assertNotAborted(options.signal);
  const mutatedSqls = steps
    .filter((s) => s.clientKind === 'execute' || s.clientKind === 'execBatch')
    .map((s) => s.sql);
  if (mutatedSqls.length > 0) {
    host.onMutatedSql(mutatedSqls);
  }
  return results as PipelineResults<TOps>;
}

/** Create a pre-compiled `PreparedPipeline` via `BrowserPipelineDriverHost`. */
export async function createBrowserPreparedPipeline<
  const TTemplates extends readonly PreparedPipelineStepTemplate[],
>(
  host: BrowserPipelineDriverHost,
  templates: TTemplates,
): Promise<PreparedPipeline<TTemplates>> {
  const stmtHandles: Array<number | undefined> = new Array(templates.length);
  const preparedHandlesToClose: number[] = [];

  if (typeof host.prepareHandle === 'function') {
    try {
      for (let i = 0; i < templates.length; i++) {
        const h = await host.prepareHandle(templates[i]!.sql);
        if (typeof h === 'number' && h > 0) {
          stmtHandles[i] = h;
          preparedHandlesToClose.push(h);
        }
      }
    } catch (err) {
      if (typeof host.closeHandle === 'function') {
        for (const h of preparedHandlesToClose) {
          await host.closeHandle(h).catch(() => undefined);
        }
      }
      throw err;
    }
  }

  let isClosed = false;
  const mutatedSqls = templates
    .filter((t) => t.kind === 'execute' || t.kind === 'execBatch')
    .map((t) => t.sql);

  const handle: PreparedPipeline<TTemplates> = {
    length: templates.length,
    get closed() {
      return isClosed;
    },
    run: async (
      inputs?: PreparedPipelineStepInputs<TTemplates>,
      options: PipelineOptions = {},
    ): Promise<PreparedPipelineResults<TTemplates>> => {
      if (isClosed) {
        throw new Error('PreparedPipeline has already been closed');
      }
      host.assertNotAborted(options.signal);
      if (templates.length === 0) {
        return [] as unknown as PreparedPipelineResults<TTemplates>;
      }
      const { steps, requests } = buildPreparedEnginePipelineRequests(
        templates,
        stmtHandles,
        inputs as readonly unknown[] | undefined,
        (p) => host.serialize(p),
        host.packWireParams,
      );

      let results: unknown[];
      if (typeof host.runEnginePipeline === 'function') {
        const responses = await host.runEnginePipeline(requests, {
          transaction: options.transaction,
        });
        results = await decodeEnginePipelineResponses(
          steps,
          responses,
          host.shapeCache,
          (res, rm) => host.applyTypes(res, rm),
        );
      } else {
        results = await host.runFallback(steps, options.transaction);
      }

      host.assertNotAborted(options.signal);
      if (mutatedSqls.length > 0) {
        host.onMutatedSql(mutatedSqls);
      }
      return results as PreparedPipelineResults<TTemplates>;
    },
    close: async (): Promise<void> => {
      if (isClosed) return;
      isClosed = true;
      if (typeof host.closeHandle === 'function') {
        for (const h of preparedHandlesToClose) {
          await host.closeHandle(h).catch(() => undefined);
        }
      }
    },
    [Symbol.asyncDispose]: async (): Promise<void> => {
      await handle.close();
    },
  };

  return handle;
}
