/**
 * engine-direct-ops.ts – Sweep, Replica Mode, Changelog Replay & Pipeline
 * Helpers for `DirectTransport` (`M26 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import type {
  DatabaseInfo,
  FieldInfo,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
  SweepResult,
  TransactionOptions,
} from '../types';
import type {
  EnginePipelineStepRequest,
  EnginePipelineStepResponse,
  EnginePipelineWireOptions,
} from '../pipeline';
import {
  decodeBinaryResultSet,
  encodeBinaryResultSet,
  type BinaryResultPayload,
} from './binary-result';
import { encodeParamRows } from './params';
import { isWireParamRowsBuffer, wireParamRowsToCAbi } from './wire-params';
import type { EngineHandle } from './wasm-abi-types';
import {
  BLOB_SIDE_CHANNEL,
  SHAPE_IDS,
  attachBlobs,
  buildSweepResult,
  decodeResultSet,
  engineError,
  readBlobs,
} from './result-decoder';

export async function runDirectSweep(
  mod: FirebirdWasmModule,
  dbHandle: EngineHandle,
  readDbInfo: (h: EngineHandle) => Promise<DatabaseInfo>,
  queryFn: <T = Row>(
    db: EngineHandle,
    tx: EngineHandle,
    sql: string,
    params?: QueryParams,
  ) => Promise<QueryResult<T>>,
  startTx: (db: EngineHandle, opts?: TransactionOptions) => Promise<EngineHandle>,
  commitTx: (tx: EngineHandle) => Promise<void>,
): Promise<SweepResult> {
  const started = performance.now();
  const before = await readDbInfo(dbHandle);

  let tablesScanned = 0;
  try {
    const relRes = await queryFn<Record<string, unknown>>(
      dbHandle,
      0,
      'SELECT TRIM(RDB$RELATION_NAME) AS REL FROM RDB$RELATIONS ' +
        'WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ' +
        'ORDER BY RDB$RELATION_NAME',
    );
    for (const row of relRes.rows) {
      const rel = String(row['REL'] ?? row['rel'] ?? '').trim();
      if (!rel) continue;
      const escaped = rel.replace(/"/g, '""');
      await queryFn(dbHandle, 0, `SELECT COUNT(*) AS C FROM "${escaped}"`);
      tablesScanned += 1;
    }
  } catch {
    // Ignore table scan errors during sweep if a relation is inaccessible.
  }

  if (typeof mod._fb_sweep === 'function') {
    const rc = mod._fb_sweep(dbHandle);
    if (rc !== 0) {
      throw engineError(mod, 'Database sweep failed', rc);
    }
  } else {
    const tx = await startTx(dbHandle, { isolationLevel: 'READ_COMMITTED' });
    await commitTx(tx);
  }

  const after = await readDbInfo(dbHandle);
  return buildSweepResult(before, after, tablesScanned, performance.now() - started);
}

export function runDirectSetReplicaMode(
  mod: FirebirdWasmModule,
  dbHandle: EngineHandle,
  mode: 0 | 1 | 2 | 'none' | 'read_only' | 'read_write',
  preparedStatements: Map<EngineHandle, { dbHandle: EngineHandle }>,
): void {
  const modeCode: 0 | 1 | 2 =
    mode === 'none' || mode === 0
      ? 0
      : mode === 'read_only' || mode === 1
        ? 1
        : 2;

  for (const [stmtHandle, entry] of preparedStatements) {
    if (entry.dbHandle === dbHandle) {
      preparedStatements.delete(stmtHandle);
    }
  }

  if (typeof mod._fb_set_replica_mode === 'function') {
    const rc = mod._fb_set_replica_mode(dbHandle, modeCode);
    if (rc !== 0) {
      throw engineError(mod, 'Failed to set database replica mode', rc);
    }
    return;
  }

  throw new Error(
    'Native _fb_set_replica_mode is not exported by the loaded Firebird WASM module.',
  );
}

export function runDirectReplicateChangelog(
  mod: FirebirdWasmModule,
  dbHandle: EngineHandle,
  data: Uint8Array,
): number {
  if (typeof mod._fb_replicate_changelog !== 'function') {
    throw new Error(
      'Native _fb_replicate_changelog (IAttachment::createReplicator) is not exported by the loaded Firebird WASM module.',
    );
  }
  if (data.byteLength === 0) {
    return 0;
  }
  const ptr = mod._malloc(data.byteLength);
  let processed: number;
  try {
    mod.HEAPU8.set(data, ptr);
    processed = mod._fb_replicate_changelog(dbHandle, ptr, data.byteLength);
  } finally {
    mod._free(ptr);
  }
  if (processed < 0) {
    throw engineError(mod, 'Failed to apply Firebird changelog segment', processed);
  }
  return processed;
}

export interface DirectPipelineDriver {
  startTransaction(dbHandle: EngineHandle, options?: TransactionOptions): Promise<EngineHandle>;
  commit(txHandle: EngineHandle): Promise<void>;
  rollback(txHandle: EngineHandle): Promise<void>;
  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
  ): Promise<number>;
  executeStmt(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params?: QueryParams | Uint8Array,
  ): Promise<number>;
  executeBatch(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    rows: QueryParams[] | Uint8Array,
  ): Promise<number>;
  executeBatchStmt(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    rows: QueryParams[] | Uint8Array,
  ): Promise<number>;
  queryBinary(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
    binaryBlobs?: boolean,
  ): Promise<BinaryResultPayload>;
  queryStmtBinary(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params?: QueryParams | Uint8Array,
    binaryBlobs?: boolean,
  ): Promise<BinaryResultPayload>;
}

export async function runDirectPipeline(
  driver: DirectPipelineDriver,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  steps: readonly EnginePipelineStepRequest[],
  options: EnginePipelineWireOptions = {},
): Promise<EnginePipelineStepResponse[]> {
  let activeTx = txHandle;
  const ownsTx = activeTx === 0 && Boolean(options.transaction);
  if (ownsTx) {
    const txOpts =
      typeof options.transaction === 'object' && options.transaction !== null
        ? options.transaction
        : {};
    activeTx = await driver.startTransaction(dbHandle, txOpts);
  }

  const out: EnginePipelineStepResponse[] = new Array(steps.length);
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.op === 'execute') {
        const affectedRows =
          step.stmtHandle && step.stmtHandle > 0
            ? await driver.executeStmt(dbHandle, activeTx, step.stmtHandle, step.params)
            : await driver.execute(dbHandle, activeTx, step.sql, step.params);
        out[i] = { kind: 'affected', affectedRows };
      } else if (step.op === 'executeBatch') {
        const affectedRows =
          step.stmtHandle && step.stmtHandle > 0
            ? await driver.executeBatchStmt(dbHandle, activeTx, step.stmtHandle, step.rows)
            : await driver.executeBatch(dbHandle, activeTx, step.sql, step.rows);
        out[i] = { kind: 'affected', affectedRows };
      } else {
        const payload =
          step.stmtHandle && step.stmtHandle > 0
            ? await driver.queryStmtBinary(
                dbHandle,
                activeTx,
                step.stmtHandle,
                step.params,
                step.binaryBlobs,
              )
            : await driver.queryBinary(
                dbHandle,
                activeTx,
                step.sql,
                step.params,
                step.binaryBlobs,
              );
        out[i] = { kind: 'binary', payload };
      }
    }

    if (ownsTx) {
      await driver.commit(activeTx);
    }
    return out;
  } catch (err) {
    if (ownsTx && activeTx !== 0) {
      await driver.rollback(activeTx).catch(() => undefined);
    }
    throw err;
  }
}

export interface DirectStmtOpsHost {
  readonly module: FirebirdWasmModule;
  readonly preparedStatements: Map<
    EngineHandle,
    { dbHandle: EngineHandle; sql: string; native: boolean }
  >;
  readonly shapeColumns: (id: number) => readonly FieldInfo[];
  withParams<R>(params: QueryParams | Uint8Array, fn: (ptr: number, len: number) => R): R;
  resolveStagedBlobParams(params: QueryParams): QueryParams;
  extractBinaryPayload(mod: FirebirdWasmModule, binPtr: number, byteLen: number): BinaryResultPayload;
  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
  ): Promise<number>;
  executeBatch(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    rows: QueryParams[] | Uint8Array,
  ): Promise<number>;
  query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
    rowMode?: RowMode,
    binaryBlobs?: boolean,
  ): Promise<QueryResult<T>>;
  cursorOpen(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params?: QueryParams | Uint8Array,
  ): Promise<EngineHandle>;
}

function lookupPreparedEntry(
  host: DirectStmtOpsHost,
  dbHandle: EngineHandle,
  stmtHandle: EngineHandle,
  context: string,
): { dbHandle: EngineHandle; sql: string; native: boolean } {
  const entry = host.preparedStatements.get(stmtHandle);
  if (!entry || entry.dbHandle !== dbHandle) {
    throw new Error(`Firebird ${context} failed: unknown statement handle (${stmtHandle})`);
  }
  return entry;
}

export async function runDirectExecuteStmt(
  host: DirectStmtOpsHost,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  stmtHandle: EngineHandle,
  params: QueryParams | Uint8Array = [],
): Promise<number> {
  const mod = host.module;
  const entry = host.preparedStatements.get(stmtHandle);
  if (typeof mod._fb_execute_stmt === 'function' && (!entry || entry.native)) {
    const executeStmtFn = mod._fb_execute_stmt;
    const rc = host.withParams(params, (paramPtr, paramLen) =>
      executeStmtFn.call(mod, dbHandle, txHandle, stmtHandle, paramPtr, paramLen),
    );
    if (rc !== 0) {
      throw engineError(mod, `Firebird executeStmt failed for statement #${stmtHandle}`, rc);
    }
    return mod._fb_last_affected_rows();
  }
  const fallback = lookupPreparedEntry(host, dbHandle, stmtHandle, 'executeStmt');
  return host.execute(dbHandle, txHandle, fallback.sql, params);
}

export async function runDirectExecuteBatchStmt(
  host: DirectStmtOpsHost,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  stmtHandle: EngineHandle,
  rows: QueryParams[] | Uint8Array,
): Promise<number> {
  const mod = host.module;
  const entry = host.preparedStatements.get(stmtHandle);
  if (typeof mod._fb_execute_batch_stmt === 'function' && (!entry || entry.native)) {
    const executeBatchStmtFn = mod._fb_execute_batch_stmt;
    let packed: Uint8Array;
    if (isWireParamRowsBuffer(rows)) {
      const view = new DataView(rows.buffer, rows.byteOffset, rows.byteLength);
      if (view.getUint32(4, true) === 0) return 0;
      packed = wireParamRowsToCAbi(rows);
    } else {
      if (rows.length === 0) return 0;
      const resolvedRows = rows.map((row) => host.resolveStagedBlobParams(row));
      packed = encodeParamRows(resolvedRows);
    }
    const ptr = mod._malloc(packed.length);
    let rc: number;
    try {
      mod.HEAPU8.set(packed, ptr);
      rc = executeBatchStmtFn.call(mod, dbHandle, txHandle, stmtHandle, ptr, packed.length);
    } finally {
      mod._free(ptr);
    }
    if (rc !== 0) {
      throw engineError(mod, `Firebird executeBatchStmt failed for statement #${stmtHandle}`, rc);
    }
    return mod._fb_last_affected_rows();
  }
  const fallback = lookupPreparedEntry(host, dbHandle, stmtHandle, 'executeBatchStmt');
  return host.executeBatch(dbHandle, txHandle, fallback.sql, rows);
}

export async function runDirectQueryStmt<T = Row>(
  host: DirectStmtOpsHost,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  stmtHandle: EngineHandle,
  params: QueryParams | Uint8Array = [],
  rowMode: RowMode = 'object',
  binaryBlobs = false,
): Promise<QueryResult<T>> {
  const mod = host.module;
  const entry = host.preparedStatements.get(stmtHandle);
  const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;

  if (typeof mod._fb_query_stmt_binary === 'function' && (!entry || entry.native)) {
    const queryStmtBinaryFn = mod._fb_query_stmt_binary;
    return host.withParams(params, (paramPtr, paramLen) => {
      const lenPtr = mod._malloc(4);
      let binPtr = 0;
      try {
        binPtr = queryStmtBinaryFn.call(
          mod,
          dbHandle,
          txHandle,
          stmtHandle,
          paramPtr,
          paramLen,
          flags,
          lenPtr,
        );
        if (binPtr === 0) {
          throw engineError(mod, `Firebird queryStmt failed for statement #${stmtHandle}`);
        }
        const lenView = new DataView(
          mod.HEAPU8.buffer,
          mod.HEAPU8.byteOffset + lenPtr,
          4,
        );
        const byteLen = lenView.getUint32(0, true);
        const view = mod.HEAPU8.subarray(binPtr, binPtr + byteLen);
        return decodeBinaryResultSet<T>(view, rowMode, binaryBlobs, host.shapeColumns);
      } finally {
        if (binPtr !== 0) mod._fb_free_result(binPtr);
        mod._free(lenPtr);
      }
    });
  }

  if (typeof mod._fb_query_stmt === 'function' && (!entry || entry.native)) {
    const queryStmtFn = mod._fb_query_stmt;
    return host.withParams(params, (paramPtr, paramLen) => {
      const resultPtr = queryStmtFn.call(
        mod,
        dbHandle,
        txHandle,
        stmtHandle,
        paramPtr,
        paramLen,
        flags,
      );
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird queryStmt failed for statement #${stmtHandle}`);
      }
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);
      const blobs = binaryBlobs ? readBlobs(mod) : null;
      const result = decodeResultSet<T>(json, rowMode, host.shapeColumns);
      return blobs ? attachBlobs(result, blobs, rowMode) : result;
    });
  }

  const fallback = lookupPreparedEntry(host, dbHandle, stmtHandle, 'queryStmt');
  return host.query<T>(dbHandle, txHandle, fallback.sql, params, rowMode, binaryBlobs);
}

export async function runDirectQueryStmtBinary(
  host: DirectStmtOpsHost,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  stmtHandle: EngineHandle,
  params: QueryParams | Uint8Array = [],
  binaryBlobs = false,
): Promise<BinaryResultPayload> {
  const mod = host.module;
  const entry = host.preparedStatements.get(stmtHandle);
  if (typeof mod._fb_query_stmt_binary === 'function' && (!entry || entry.native)) {
    const queryStmtBinaryFn = mod._fb_query_stmt_binary;
    const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
    return host.withParams(params, (paramPtr, paramLen) => {
      const lenPtr = mod._malloc(4);
      let binPtr = 0;
      try {
        binPtr = queryStmtBinaryFn.call(
          mod,
          dbHandle,
          txHandle,
          stmtHandle,
          paramPtr,
          paramLen,
          flags,
          lenPtr,
        );
        if (binPtr === 0) {
          throw engineError(mod, `Firebird queryStmt failed for statement #${stmtHandle}`);
        }
        const lenView = new DataView(
          mod.HEAPU8.buffer,
          mod.HEAPU8.byteOffset + lenPtr,
          4,
        );
        const byteLen = lenView.getUint32(0, true);
        return host.extractBinaryPayload(mod, binPtr, byteLen);
      } finally {
        if (binPtr !== 0) mod._fb_free_result(binPtr);
        mod._free(lenPtr);
      }
    });
  }

  const decoded = await runDirectQueryStmt<unknown[]>(
    host,
    dbHandle,
    txHandle,
    stmtHandle,
    params,
    'array',
    binaryBlobs,
  );
  return {
    binaryResult: encodeBinaryResultSet(decoded, { rowMode: 'array' }),
  };
}

export async function runDirectCursorOpenStmt(
  host: DirectStmtOpsHost,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  stmtHandle: EngineHandle,
  params: QueryParams | Uint8Array = [],
): Promise<EngineHandle> {
  const mod = host.module;
  const entry = host.preparedStatements.get(stmtHandle);
  if (typeof mod._fb_cursor_open_stmt === 'function' && (!entry || entry.native)) {
    const openStmtFn = mod._fb_cursor_open_stmt;
    const handle = host.withParams(params, (paramPtr, paramLen) =>
      openStmtFn.call(mod, dbHandle, txHandle, stmtHandle, paramPtr, paramLen),
    );
    if (handle === 0) {
      throw engineError(mod, `Firebird cursorOpenStmt failed for statement #${stmtHandle}`);
    }
    return handle;
  }
  const fallback = lookupPreparedEntry(host, dbHandle, stmtHandle, 'cursorOpenStmt');
  return host.cursorOpen(dbHandle, txHandle, fallback.sql, params);
}

export function runDirectStmtSetTimeout(
  mod: FirebirdWasmModule,
  stmtHandle: EngineHandle,
  timeoutMs: number,
): void {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a non-negative finite number');
  }
  if (typeof mod._fb_stmt_set_timeout === 'function') {
    const rc = mod._fb_stmt_set_timeout(stmtHandle, Math.floor(timeoutMs) >>> 0);
    if (rc !== 0) {
      throw engineError(mod, `Firebird stmtSetTimeout failed for statement #${stmtHandle}`, rc);
    }
  }
}

export function runDirectEventsSubscribe(
  mod: FirebirdWasmModule,
  withString: <T>(s: string, fn: (ptr: number) => T) => T,
  dbHandle: EngineHandle,
  names: string[],
): number {
  return withString(names.join(','), (namesPtr) => {
    const handle = mod._fb_events_subscribe(dbHandle, namesPtr);
    if (handle === 0) {
      throw engineError(mod, `Could not subscribe to events: ${names.join(', ')}`);
    }
    return handle;
  });
}

export function runDirectEventsPoll(
  mod: FirebirdWasmModule,
  subscription: number,
): Record<string, number> {
  const ptr = mod._fb_events_poll(subscription);
  if (ptr === 0) {
    throw engineError(mod, 'Could not poll events');
  }
  const json = mod.UTF8ToString(ptr);
  mod._free(ptr);
  return JSON.parse(json) as Record<string, number>;
}
