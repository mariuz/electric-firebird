/**
 * types-udr-profiler.ts – JavaScript UDR (`registerFunction` / `registerProcedure`)
 * & Query Profiler (`onQuery` / `monitorStats`) TypeScript Interfaces (`M29 Item 5`).
 */

/**
 * Input parameter definition for a JavaScript UDR function or procedure
 * (`db.registerFunction` / `db.registerProcedure`).
 */
export type JsUdrArgDefinition =
  | string
  | {
      /** Parameter name in DDL (defaults to `P1`, `P2`, ...). */
      name?: string;
      /** SQL type declaration (e.g. `'VARCHAR(200)'`, `'INTEGER'`, `'DOUBLE PRECISION'`). */
      type: string;
    };

/**
 * Output column definition for a JavaScript UDR procedure (`RETURNS (...)`).
 */
export type JsUdrOutputColumnDefinition =
  | string
  | {
      /** Output column name in DDL (defaults to `OUT1`, `OUT2`, ...). */
      name?: string;
      /** SQL type declaration (e.g. `'VARCHAR(200)'`, `'INTEGER'`). */
      type: string;
    };

/**
 * Options for `db.registerFunction(name, options, fn)`.
 */
export interface RegisterFunctionOptions {
  args?: readonly JsUdrArgDefinition[];
  returns?: string;
  deterministic?: boolean;
  replace?: boolean;
  entryPoint?: string;
}

/**
 * Options for `db.registerProcedure(name, options, fn)`.
 */
export interface RegisterProcedureOptions {
  args?: readonly JsUdrArgDefinition[];
  returns?: readonly JsUdrOutputColumnDefinition[];
  replace?: boolean;
  entryPoint?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsFunctionHandler = (...args: any[]) => unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsProcedureHandler = (...args: any[]) => unknown;

/**
 * Handle returned by `db.registerFunction()` and `db.registerProcedure()`.
 */
export interface RegisteredRoutine {
  readonly name: string;
  readonly kind: 'function' | 'procedure';
  readonly entryPoint: string;
  readonly engine: 'wasm-js' | 'psql-bridge';
  unregister(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Page-level I/O deltas or cumulative counters (`isc_info_reads`,
 * `isc_info_writes`, `isc_info_fetches`, `isc_info_marks`).
 */
export interface PageIoCounters {
  reads: number;
  writes: number;
  fetches: number;
  marks: number;
}

/**
 * Structured telemetry event emitted to listeners registered with `db.onQuery(listener)`.
 */
export interface QueryProfileEvent {
  sql: string;
  params: unknown[];
  kind: 'query' | 'exec' | 'execBatch' | 'prepared';
  durationMs: number;
  rowCount: number;
  cacheHit: boolean;
  timestamp: number;
  io?: PageIoCounters;
  error?: Error;
}

export type QueryProfileListener = (event: QueryProfileEvent) => void;

/**
 * Aggregated query profiler, statement cache, `MON$`, and `IAttachment::getInfo`
 * telemetry snapshot returned by `db.monitorStats()`.
 */
export interface MonitorStats {
  totalQueries: number;
  totalExecs: number;
  totalErrors: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  slowestSql: string | null;
  prepareCacheHits: number;
  prepareCacheMisses: number;
  prepareCacheHitRate: number;
  io: PageIoCounters & {
    pageBuffers: number;
    currentMemory: number;
    maxMemory: number;
  };
  transactions: {
    oldestTransaction: number;
    oldestActive: number;
    oldestSnapshot: number;
    nextTransaction: number;
    transactionGap: number;
  };
  activeStatements: number;
  recentQueries: QueryProfileEvent[];
}
