/**
 * firebird-browser-diagnostics.ts – Diagnostics, Sweep, UDR Executor & Branching
 * Helpers for `FirebirdBrowser` (`M24 Item 5`).
 */

import type {
  DatabaseInfo,
  ExplainOptions,
  FieldInfo,
  MonitorStats,
  PageIoCounters,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
  StatementExecutionOptions,
  SweepResult,
  TransactionOptions,
} from '../types';
import { toStatement, type SqlFragment } from '../sql-tag';
import { buildSweepResult, DirectTransport, type EngineHandle, type EngineTransport } from './engine-transport';
import { WorkerTransport } from './worker-transport';
import type { QueryProfiler } from './profiler';
import { scanUserTablesForSweep } from '../shared-driver-ops';
import type { CowSnapshotStore } from './snapshots';
import type { BranchOptions, FirebirdBrowserOptions } from './firebird-browser-types';
import { splitStatements } from './sql-script';
import { extractMutatedTables, type CrossTabLiveBridge } from './live-tables';
import { applyTypes, type TypeOptions } from './value-types';
import { assertNotAborted, runWithCancellation, validateTimeoutMs, type FirebirdDatabase } from '../database-core';
import { executePipelineFallback, type BrowserPipelineDriverHost } from '../pipeline';
import { FirebirdBrowserTransaction, type ExecResult } from './firebird-browser-tx';
import type { UdrManager } from './udr';

export async function explainBrowserQuery(
  engine: EngineTransport,
  dbHandle: EngineHandle,
  sql: string | SqlFragment,
  options: ExplainOptions = {},
): Promise<string> {
  if (typeof engine.explain !== 'function') {
    throw new Error('The configured EngineTransport does not support explain()');
  }
  return engine.explain(dbHandle, 0, toStatement(sql).sql, options.detailed === true);
}

export async function readBrowserDatabaseInfo(
  engine: EngineTransport,
  dbHandle: EngineHandle,
): Promise<DatabaseInfo> {
  if (typeof engine.databaseInfo !== 'function') {
    throw new Error('The configured EngineTransport does not support databaseInfo()');
  }
  return engine.databaseInfo(dbHandle);
}

export async function captureBrowserMonitorStats(
  profiler: QueryProfiler,
  engine: EngineTransport,
  dbHandle: EngineHandle,
): Promise<MonitorStats> {
  return profiler.snapshot(async () => {
    if (typeof engine.databaseInfo === 'function') {
      return engine.databaseInfo(dbHandle);
    }
    return null;
  });
}

export async function captureBrowserPageIo(
  profiler: QueryProfiler,
  engine: EngineTransport,
  dbHandle: EngineHandle,
): Promise<PageIoCounters | null> {
  if (!profiler.hasListeners || typeof engine.databaseInfo !== 'function') {
    return null;
  }
  try {
    const info = await engine.databaseInfo(dbHandle);
    return {
      reads: info.reads,
      writes: info.writes,
      fetches: info.fetches,
      marks: info.marks,
    };
  } catch {
    return null;
  }
}

export async function runBrowserSweep(
  engine: EngineTransport,
  dbHandle: EngineHandle,
  queryFn: (sql: string) => Promise<QueryResult<Row>>,
  markDirty: () => void,
): Promise<SweepResult> {
  if (typeof engine.sweep === 'function') {
    const result = await engine.sweep(dbHandle);
    markDirty();
    return result;
  }
  const started = performance.now();
  const before = await readBrowserDatabaseInfo(engine, dbHandle);
  const tablesScanned = await scanUserTablesForSweep(queryFn);
  const after = await readBrowserDatabaseInfo(engine, dbHandle);
  markDirty();
  return buildSweepResult(before, after, tablesScanned, performance.now() - started);
}

export function buildBrowserUdrExecutor(
  engine: EngineTransport,
  dbHandle: EngineHandle,
  txHandle: EngineHandle,
  binaryBlobs: boolean,
  serialize: (params: QueryParams) => QueryParams,
) {
  return {
    isDirect: engine instanceof DirectTransport,
    query: <T extends Row = Row>(
      sql: string,
      params: QueryParams = [],
      opts?: { rowMode?: RowMode },
    ) =>
      engine.query<T>(
        dbHandle,
        txHandle,
        sql,
        serialize(params),
        opts?.rowMode ?? 'object',
        binaryBlobs,
      ),
    exec: (sql: string, params: QueryParams = []) =>
      engine.execute(dbHandle, txHandle, sql, serialize(params)),
  };
}

export async function prepareBrowserBranchArgs(
  fileName: string,
  baseOptions: FirebirdBrowserOptions,
  snapshotStore: CowSnapshotStore,
  captureSnapshot: () => Promise<{ id: string; toUint8Array(): Uint8Array }>,
  branchName?: string,
  options: BranchOptions = {},
): Promise<{ targetName: string; mergedOptions: FirebirdBrowserOptions }> {
  const { fromSnapshot, ...browserOpts } = options;
  const snap = fromSnapshot
    ? snapshotStore.getSnapshot(fromSnapshot)
    : await captureSnapshot();
  const targetName =
    branchName?.trim() || `memory://branch-${fileName}-${snap.id}`;
  const branchTransport =
    browserOpts.transport !== undefined
      ? browserOpts.transport
      : baseOptions.transport
        ? new Proxy(baseOptions.transport, {
            get(target, prop, receiver) {
              if (prop === 'dispose') return async () => undefined;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        : undefined;
  return {
    targetName,
    mergedOptions: {
      ...baseOptions,
      ...browserOpts,
      ...(branchTransport ? { transport: branchTransport } : {}),
      loadDataDir: snap.toUint8Array(),
    },
  };
}

export async function runBrowserExecBatch(
  engine: EngineTransport,
  dbHandle: EngineHandle,
  profiler: QueryProfiler,
  liveBridge: CrossTabLiveBridge,
  captureIo: () => Promise<PageIoCounters | null>,
  serialize: (params: QueryParams) => QueryParams,
  markDirty: () => void,
  sql: string,
  rows: QueryParams[],
): Promise<ExecResult> {
  if (!Array.isArray(rows)) {
    throw new TypeError('execBatch takes an array of parameter rows');
  }
  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    throw new Error(
      `A batch runs one statement, not a script (${statements.length} statements found)`,
    );
  }

  const startedAt = profiler.begin();
  const ioBefore = await captureIo();
  let affectedRows = 0;
  try {
    affectedRows = await engine.executeBatch(
      dbHandle,
      0,
      statements[0].sql,
      rows.map((row) => serialize(row)),
    );
    const ioAfter = await captureIo();
    profiler.end({
      startedAt,
      sql: statements[0].sql,
      params: rows[0] ?? [],
      kind: 'execBatch',
      rowCount: affectedRows,
      cacheHit: rows.length > 1,
      ioBefore,
      ioAfter,
    });
  } catch (err) {
    profiler.end({
      startedAt,
      sql: statements[0].sql,
      params: rows[0] ?? [],
      kind: 'execBatch',
      cacheHit: rows.length > 1,
      error: err,
    });
    throw err;
  }

  if (rows.length > 0) {
    markDirty();
    liveBridge.broadcastTables(extractMutatedTables(statements[0].sql));
  }
  return { affectedRows };
}

export function buildBrowserPipelineHost(
  db: FirebirdDatabase & {
    transaction<T>(
      fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T>;
  },
  engine: EngineTransport,
  dbHandle: EngineHandle,
  shapeCache: Map<number, readonly FieldInfo[]>,
  types: TypeOptions | undefined,
  liveBridge: CrossTabLiveBridge,
  serialize: (params: QueryParams) => QueryParams,
  markDirty: () => void,
): BrowserPipelineDriverHost {
  return {
    dbHandle,
    packWireParams:
      Boolean(engine.acceptsWireParams) || engine instanceof WorkerTransport,
    shapeCache,
    serialize,
    applyTypes: (res, rm) => applyTypes(res, types, rm),
    prepareHandle:
      typeof engine.prepare === 'function'
        ? async (s) => (await engine.prepare!(dbHandle, 0, s)).handle
        : undefined,
    closeHandle:
      typeof engine.stmtClose === 'function' ? (h) => engine.stmtClose!(h) : undefined,
    runEnginePipeline:
      typeof engine.pipeline === 'function'
        ? (reqs, opts) => engine.pipeline!(dbHandle, 0, reqs, opts)
        : undefined,
    runFallback: (steps, txOpt) =>
      txOpt
        ? db.transaction(
            (tx) => executePipelineFallback(steps, tx),
            typeof txOpt === 'object' ? txOpt : {},
          )
        : executePipelineFallback(steps, db),
    onMutatedSql: (sqls) => {
      markDirty();
      const mutated = new Set<string>();
      for (const s of sqls) {
        for (const tbl of extractMutatedTables(s)) mutated.add(tbl);
      }
      if (mutated.size > 0) liveBridge.broadcastTables([...mutated]);
    },
    assertNotAborted,
  };
}

export async function runBrowserTransaction<T>(
  engine: EngineTransport,
  dbHandle: EngineHandle,
  types: TypeOptions | undefined,
  udr: UdrManager,
  liveBridge: CrossTabLiveBridge,
  markDirty: () => void,
  fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const txHandle = await engine.startTransaction(dbHandle, options);
  const tx = new FirebirdBrowserTransaction(
    engine,
    dbHandle,
    txHandle,
    types,
    undefined,
    undefined,
    undefined,
    udr,
  );

  let result: T;
  try {
    result = await fn(tx);
  } catch (err) {
    if (!tx.isFinished) {
      await engine.rollback(txHandle);
    }
    throw err;
  }

  if (tx.isFinished) {
    markDirty();
    return result;
  }

  await engine.commit(txHandle);
  markDirty();
  if (tx.committedTables.length > 0) {
    liveBridge.broadcastTables(tx.committedTables);
  }
  return result;
}

export async function runBrowserExecScript(
  host: {
    engine: EngineTransport;
    getDbHandle: () => EngineHandle;
    udr: UdrManager;
    profiler: QueryProfiler;
    liveBridge: CrossTabLiveBridge;
    liveTriggerPromises: Map<string, Promise<string>>;
    captureIo: () => Promise<PageIoCounters | null>;
    applyOneShotTimeout: (timeoutMs?: number) => Promise<void>;
    cancelOperation: () => Promise<void>;
    serialize: (params: QueryParams) => QueryParams;
    markDirty: () => void;
    ensureReady: () => Promise<void>;
  },
  sql: string | SqlFragment,
  paramsOrOptions: QueryParams | StatementExecutionOptions = [],
  maybeOptions: StatementExecutionOptions = {},
): Promise<ExecResult[]> {
  const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
  const options = Array.isArray(paramsOrOptions) ? maybeOptions : (paramsOrOptions ?? {});
  assertNotAborted(options.signal);
  validateTimeoutMs(options.timeoutMs);

  await host.ensureReady();

  const script = toStatement(sql, params);
  const statements = splitStatements(script.sql);

  if (script.params.length > 0 && statements.length > 1) {
    throw new Error(
      `Parameters cannot be used with a multi-statement script ` +
        `(${statements.length} statements found); run the statements separately`,
    );
  }

  const results: ExecResult[] = [];
  for (const statement of statements) {
    host.udr.inspectDdl(statement.sql);
    if (host.udr.hasBridgeRoutines) {
      const intercepted = await host.udr.executeIfIntercepted(
        statement.sql,
        script.params,
      );
      if (intercepted.intercepted) {
        results.push({ affectedRows: intercepted.affectedRows });
        continue;
      }
      const rewritten = await host.udr.rewriteStatement(statement.sql, script.params);
      statement.sql = rewritten.sql;
      script.params = rewritten.params;
    }
    assertNotAborted(options.signal);
    if (/^\s*(DROP|RECREATE)\b/i.test(statement.sql)) {
      host.liveTriggerPromises.clear();
    }
    const startedAt = host.profiler.begin();
    const ioBefore = await host.captureIo();
    try {
      const affectedRows = await runWithCancellation(
        async () => {
          await host.applyOneShotTimeout(options.timeoutMs);
          return host.engine.execute(
            host.getDbHandle(),
            0,
            statement.sql,
            host.serialize(script.params),
          );
        },
        options,
        () => host.cancelOperation(),
      );
      const ioAfter = await host.captureIo();
      host.profiler.end({
        startedAt,
        sql: statement.sql,
        params: script.params,
        kind: 'exec',
        rowCount: affectedRows,
        cacheHit: false,
        ioBefore,
        ioAfter,
      });
      host.liveBridge.broadcastTables(extractMutatedTables(statement.sql));
      results.push({ affectedRows });
    } catch (err) {
      host.profiler.end({
        startedAt,
        sql: statement.sql,
        params: script.params,
        kind: 'exec',
        cacheHit: false,
        error: err,
      });
      throw err;
    }
  }

  if (results.length > 0) {
    host.markDirty();
  }
  return results;
}
