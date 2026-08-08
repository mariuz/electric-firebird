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

export { encodeParams, encodeParamValue } from './params';

export { DirectTransport } from './engine-transport';
export type {
  EngineTransport,
  EngineHandle,
  DirectTransportOptions,
} from './engine-transport';

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
  TransactionOptions,
  IsolationLevel,
} from '../types';
