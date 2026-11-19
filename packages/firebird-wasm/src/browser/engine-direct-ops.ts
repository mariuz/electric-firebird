/**
 * engine-direct-ops.ts – Sweep, Replica Mode, Changelog Replay & Pipeline
 * Helpers for `DirectTransport` (`M26 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import type {
  DatabaseInfo,
  QueryParams,
  QueryResult,
  Row,
  SweepResult,
  TransactionOptions,
} from '../types';
import type {
  EnginePipelineStepRequest,
  EnginePipelineStepResponse,
  EnginePipelineWireOptions,
} from '../pipeline';
import type { BinaryResultPayload } from './binary-result';
import type { EngineHandle } from './wasm-abi-types';
import { buildSweepResult, engineError } from './result-decoder';

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
