/**
 * firebird-wasm/browser – Browser entry point.
 *
 * Re-exports the browser-specific FirebirdBrowser class together with the
 * shared types so that browser consumers can import from a single path:
 *
 * ```ts
 * import { FirebirdBrowser } from 'firebird-wasm/browser';
 * ```
 */

export { FirebirdBrowser, FirebirdBrowserTransaction } from './firebird-browser';
export type { FirebirdBrowserOptions, ExecResult } from './firebird-browser';

export { sql, SqlFragment, RawSql, isSqlFragment, toStatement } from '../sql-tag';
export type { SqlTag, Statement } from '../sql-tag';

export { encodeParams, encodeParamValue } from './params';

export { firebirdTypeName } from './field-types';

export { isolationCode, hasTransactionOptions } from './isolation';

export { applyTypes, hasTypeOptions } from './value-types';
export type { TypeOptions } from './value-types';

export {
  acquireDatabaseLock,
  databaseLockName,
  DatabaseLockedError,
} from './db-lock';
export type { DatabaseLock, DatabaseLockOptions } from './db-lock';

export { splitStatements } from './sql-script';
export type { ScriptStatement } from './sql-script';

export { DirectTransport } from './engine-transport';
export type {
  EngineTransport,
  EngineHandle,
  DirectTransportOptions,
} from './engine-transport';

export { SharedEngineTransport } from './shared-transport';
export type { SharedEngineTransportOptions } from './shared-transport';

export { electLeader } from './leader-election';
export type { LeaderElection, LeaderElectionOptions } from './leader-election';

export { WorkerTransport } from './worker-transport';
export type { WorkerTransportOptions } from './worker-transport';

export { serveEngine } from './worker-entry';
export type { EngineWorkerScope } from './worker-entry';
export type {
  EngineOp,
  EngineRequest,
  EngineResponse,
} from './worker-protocol';

export { IndexedDBVFS } from './indexeddb-vfs';
export type { IndexedDBVFSOptions, VFSMetadata } from './indexeddb-vfs';

export { loadFirebirdWasm, allocString } from '../wasm-loader';
export type {
  FirebirdWasmModule,
  WasmLoadOptions,
  EmscriptenFS,
  FbHandle,
} from '../wasm-loader';

// Re-export shared types for convenience
export type {
  QueryResult,
  QueryParams,
  Row,
  FieldInfo,
  FirebirdTypeName,
  TransactionOptions,
  IsolationLevel,
} from '../types';
