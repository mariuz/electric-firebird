/**
 * shared-driver-ops.ts – Isomorphic driver operations shared between
 * `FirebirdBrowser` (WASM) and `FirebirdLite` (Node.js) (`M19 Item 5`).
 *
 * Centralizes Standard Schema v1 validation (`M19 Item 4`), zero-copy columnar
 * and Apache Arrow IPC result encoding (`M19 Item 2`), prepared-statement
 * argument/timeout resolution, cooperative garbage-collection sweep scans,
 * copy-on-write snapshot page diffs, and statement row-count helpers without
 * pulling any Node.js built-ins into browser bundles.
 */

import type {
  ArrayRow,
  FieldInfo,
  QueryOptions,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
  StatementExecutionOptions,
} from './types';
import { toStatement, type SqlFragment } from './sql-tag';
import type { BinaryResultPayload } from './browser/binary-result';
import {
  decodeBinaryResultColumnar,
  encodeArrowIpc,
  rowsToColumnarResult,
  type ArrowIpcOptions,
  type ColumnarQueryResult,
} from './columnar';
import {
  isStandardSchema,
  validateRowsWithSchema,
  type StandardSchemaV1,
  type TypedSqlFragment,
} from './schema-validation';
import type {
  ApplyPageDiffOptions,
  CowSnapshotStore,
  DatabaseSnapshot,
  PageDiffOptions,
} from './browser/snapshots';

/** Options accepted by `queryArrow()`. */
export type QueryArrowOptions = StatementExecutionOptions & ArrowIpcOptions;

/**
 * Type guard checking whether `sql` is a `TypedSqlFragment<T>` carrying an
 * attached Standard Schema v1 validator.
 */
export function isTypedSqlFragment<T = unknown>(
  sql: unknown,
): sql is TypedSqlFragment<T> {
  return (
    typeof sql === 'object' &&
    sql !== null &&
    'schema' in sql &&
    isStandardSchema((sql as { schema?: unknown }).schema)
  );
}

/**
 * Extract any Standard Schema v1 validator attached to either `options.schema`
 * or a `TypedSqlFragment` passed as `sql`.
 */
export function extractEffectiveQuerySchema<T>(
  sql: string | SqlFragment | TypedSqlFragment<T>,
  options?: { schema?: StandardSchemaV1<unknown, T> },
): StandardSchemaV1<unknown, T> | undefined {
  if (options?.schema && isStandardSchema(options.schema)) {
    return options.schema;
  }
  if (isTypedSqlFragment<T>(sql)) {
    return sql.schema;
  }
  return undefined;
}

/**
 * Validate `result.rows` through `schema` (when provided and `rowMode !== 'array'`)
 * using Standard Schema v1 (`~standard.validate`).
 */
export async function finalizeQueryResultWithSchema<T>(
  result: QueryResult<T>,
  schema: StandardSchemaV1<unknown, T> | undefined,
  rowMode: RowMode = 'object',
): Promise<QueryResult<T>> {
  if (!schema || rowMode === 'array') {
    return result;
  }
  const validatedRows = await validateRowsWithSchema<T>(
    schema,
    result.rows as readonly unknown[],
  );
  return {
    rows: validatedRows,
    fields: result.fields,
  };
}

/**
 * Resolve `(sql, paramsOrOptions, maybeOptions)` for `queryColumnar()` /
 * `queryArrow()` calls.
 */
export function resolveColumnarQueryCall<
  O extends StatementExecutionOptions = StatementExecutionOptions,
>(
  sql: string | SqlFragment,
  paramsOrOptions: QueryParams | O = [] as unknown as QueryParams,
  maybeOptions: O = {} as O,
): { statement: { sql: string; params: QueryParams }; options: O } {
  if (Array.isArray(paramsOrOptions)) {
    return {
      statement: toStatement(sql, paramsOrOptions),
      options: maybeOptions ?? ({} as O),
    };
  }
  return {
    statement: toStatement(sql, []),
    options: (paramsOrOptions ?? ({} as O)) as O,
  };
}

/**
 * Decode a packed WASM `"FBR\x01"` {@link BinaryResultPayload} directly into
 * typed {@link ColumnarQueryResult} vectors without materializing JS row
 * objects, updating `shapeCache` when shape metadata accompanies `shapeId`.
 */
export function decodePayloadColumnar(
  payload: BinaryResultPayload,
  shapeCache: Map<number, readonly FieldInfo[]>,
): ColumnarQueryResult {
  if (
    payload.shapeId !== undefined &&
    payload.shapeId > 0 &&
    payload.shapeFields
  ) {
    if (shapeCache.size >= 512) {
      shapeCache.clear();
    }
    shapeCache.set(payload.shapeId, payload.shapeFields);
  }
  return decodeBinaryResultColumnar(payload.binaryResult, (id: number) => {
    const fields = shapeCache.get(id);
    if (!fields) {
      throw new Error(`Unknown binary result shape ID: ${id}`);
    }
    return fields;
  });
}

/**
 * Fallback/Node path converting a positional `rowMode: 'array'` query result
 * into typed {@link ColumnarQueryResult} vectors.
 */
export async function executeColumnarViaArrayQuery(
  runArrayQuery: () => Promise<QueryResult<ArrayRow>>,
): Promise<ColumnarQueryResult> {
  const res = await runArrayQuery();
  return rowsToColumnarResult(res);
}

/**
 * Execute a columnar query and serialize the result into an **Apache Arrow IPC V5**
 * stream (`Uint8Array`).
 */
export async function executeArrowFromColumnar(
  runColumnar: () => Promise<ColumnarQueryResult>,
  options?: ArrowIpcOptions,
): Promise<Uint8Array> {
  const columnar = await runColumnar();
  return encodeArrowIpc(columnar, options);
}

/**
 * Resolve `(paramsOrOptions, maybeOptions)` for `PreparedStatement.query()` /
 * `PreparedStatement.queryStream()`, inheriting `defaultTimeoutMs` when no
 * per-call `timeoutMs` is supplied.
 */
export function resolvePreparedCallArgs<
  O extends StatementExecutionOptions = QueryOptions,
>(
  paramsOrOptions: QueryParams | O | undefined,
  maybeOptions: O | undefined,
  defaultTimeoutMs: number,
): { callParams: QueryParams; rawOptions: O; callOptions: O } {
  const callParams: QueryParams = Array.isArray(paramsOrOptions)
    ? paramsOrOptions
    : [];
  const rawOptions: O = (
    Array.isArray(paramsOrOptions)
      ? (maybeOptions ?? {})
      : (paramsOrOptions ?? {})
  ) as O;
  const callOptions: O =
    rawOptions.timeoutMs === undefined && defaultTimeoutMs > 0
      ? ({ ...rawOptions, timeoutMs: defaultTimeoutMs } as O)
      : rawOptions;
  return { callParams, rawOptions, callOptions };
}

/** Validate that `actual` matches the prepared statement's expected `?` parameter count. */
export function assertPreparedParamCount(
  expected: number,
  actual: number,
): void {
  if (actual !== expected) {
    throw new Error(
      `PreparedStatement expects ${expected} parameter(s) but ${actual} were supplied`,
    );
  }
}

/** Validate an `execBatch` parameter matrix and optionally each row's parameter count. */
export function assertBatchParameterRows(
  rows: QueryParams[],
  expectedParamCount?: number,
): void {
  if (!Array.isArray(rows)) {
    throw new TypeError('execBatch takes an array of parameter rows');
  }
  if (expectedParamCount !== undefined) {
    for (const row of rows) {
      assertPreparedParamCount(expectedParamCount, row.length);
    }
  }
}

/** Return `true` when `sql` is a DDL / session statement that does not set `ROW_COUNT`. */
export function isNonCountingDdlStatement(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|RECREATE|SET|GRANT|REVOKE|COMMENT|DECLARE)\b/i.test(
    sql,
  );
}

/** Query Firebird's `RDB$GET_CONTEXT('SYSTEM', 'ROW_COUNT')` for unified `execute()`. */
export async function querySystemRowCount(
  queryFn: (sql: string) => Promise<QueryResult<Row>>,
): Promise<number> {
  try {
    const rcRes = await queryFn(
      `SELECT CAST(RDB$GET_CONTEXT('SYSTEM', 'ROW_COUNT') AS INTEGER) AS RC FROM RDB$DATABASE`,
    );
    return Math.max(
      0,
      Number(rcRes.rows[0]?.RC ?? rcRes.rows[0]?.rc ?? 0) || 0,
    );
  } catch {
    return 0;
  }
}

/**
 * Scan all non-system base tables (`SELECT COUNT(*)`) to trigger cooperative
 * Firebird record-version garbage collection when native `isc_Sweep` is not
 * available on the transport.
 */
export async function scanUserTablesForSweep(
  queryFn: (sql: string) => Promise<QueryResult<Row>>,
): Promise<number> {
  let tablesScanned = 0;
  try {
    const relRes = await queryFn(
      'SELECT TRIM(RDB$RELATION_NAME) AS REL FROM RDB$RELATIONS ' +
        'WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ' +
        'ORDER BY RDB$RELATION_NAME',
    );
    for (const row of relRes.rows) {
      const rel = String(row['REL'] ?? row['rel'] ?? '').trim();
      if (!rel) continue;
      const escaped = rel.replace(/"/g, '""');
      await queryFn(`SELECT COUNT(*) AS C FROM "${escaped}"`);
      tablesScanned += 1;
    }
  } catch {
    // Ignore scan errors if a relation is inaccessible.
  }
  return tablesScanned;
}

/** Validate that a UDR registration call received a handler function. */
export function assertUdrCallback(
  methodName: 'registerFunction' | 'registerProcedure',
  optionsOrFn: unknown,
  maybeFn: unknown,
): void {
  if (typeof optionsOrFn !== 'function' && typeof maybeFn !== 'function') {
    throw new TypeError(`${methodName} requires a callback function`);
  }
}

/** Shared copy-on-write binary page diff export (`FBDF\x01`). */
export async function runDriverExportDiff(
  snapshotStore: CowSnapshotStore,
  dumpCurrentBytes: () => Promise<Uint8Array>,
  fromSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
  toSnapshot?: DatabaseSnapshot | string | Uint8Array,
  options?: PageDiffOptions,
): Promise<Uint8Array> {
  const target =
    toSnapshot !== undefined ? toSnapshot : await dumpCurrentBytes();
  return snapshotStore.exportDiff(fromSnapshot ?? null, target, options);
}

/** Shared copy-on-write binary page diff application (`FBDF\x01`). */
export async function runDriverApplyDiff(
  snapshotStore: CowSnapshotStore,
  dumpCurrentBytes: () => Promise<Uint8Array>,
  restoreBytes: (bytes: Uint8Array) => Promise<void>,
  diffBytes: Uint8Array,
  baseSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
  options: ApplyPageDiffOptions = {},
): Promise<Uint8Array> {
  const effectiveBase =
    baseSnapshot !== undefined ? baseSnapshot : await dumpCurrentBytes();
  const nextBytes = snapshotStore.applyDiff(diffBytes, effectiveBase, options);
  await restoreBytes(nextBytes);
  return nextBytes;
}
