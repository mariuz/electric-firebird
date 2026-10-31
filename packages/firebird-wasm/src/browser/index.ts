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
export type {
  FirebirdBrowserOptions,
  ExecResult,
  LiveQuery,
  LiveQueryOptions,
  EventSubscription,
  ListenOptions,
} from './firebird-browser';

export { sql, SqlFragment, RawSql, isSqlFragment, toStatement } from '../sql-tag';
export type { SqlTag, Statement } from '../sql-tag';

export { encodeParams, encodeParamValue } from './params';

export { firebirdTypeName } from './field-types';
export { statementKind } from '../statement-types';
export { wasmGlueFile, hasSharedHeap, cdnArtifacts } from '../wasm-loader';
export type { CdnOptions, CdnArtifacts } from '../wasm-loader';
export { VERSION } from '../version';
export { decodeDescription, attachBlobs, buildSweepResult, BLOB_SIDE_CHANNEL } from './engine-transport';

export { isolationCode, hasTransactionOptions } from './isolation';

export { applyTypes, applySerializers, hasTypeOptions } from './value-types';
export type { TypeOptions, Parser, Serializer } from './value-types';

export {
  acquireDatabaseLock,
  databaseLockName,
  DatabaseLockedError,
} from './db-lock';
export type { DatabaseLock, DatabaseLockOptions } from './db-lock';

export { splitStatements } from './sql-script';
export {
  buildIcuLocalePack,
  isValidIcuDataPackage,
  ICU_LOCALE_DATA_PATH,
  DEFAULT_ICU_TAILORING_LOCALES,
} from './icu-locales';
export {
  introspect,
  migrate,
  getAppliedMigrations,
  formatFirebirdColumnType,
  decodeFirebirdTriggerType,
  DEFAULT_MIGRATIONS_TABLE,
} from './schema';
export {
  isBlobHandle,
  isBlobWritableStream,
  DEFAULT_BLOB_SEGMENT_SIZE,
  MAX_BLOB_SEGMENT_SIZE,
} from './blob-stream';
export {
  decodeBinaryResultSet,
  encodeBinaryResultSet,
  decodeBinaryResultPayload,
  isBinaryResultPayload,
  BINARY_RESULT_MAGIC_0,
  BINARY_RESULT_MAGIC_1,
  BINARY_RESULT_MAGIC_2,
  BINARY_RESULT_VERSION,
  BINARY_HEADER_HAS_SHAPE_ID,
  BINARY_CELL_BOOL,
  BINARY_CELL_INT32,
  BINARY_CELL_FLOAT64,
  BINARY_CELL_UTF8,
  BINARY_CELL_BYTES,
} from './binary-result';
export type {
  EncodeBinaryResultOptions,
  BinaryResultPayload,
} from './binary-result';
export { extractReferencedTables, liveTableEventName, liveTableTriggerDDL } from './live-tables';
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

// From serve-engine, not worker-entry: importing the library must not start an
// engine server (worker-entry starts one when it is loaded).
export { serveEngine } from './serve-engine';
export type { EngineWorkerScope } from './serve-engine';
export type {
  EngineOp,
  EngineRequest,
  EngineResponse,
} from './worker-protocol';

export { IndexedDBVFS } from './indexeddb-vfs';
export type { IndexedDBVFSOptions, VFSMetadata } from './indexeddb-vfs';

export { loadFirebirdWasm, disposeFirebirdWasm, allocString } from '../wasm-loader';
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
  QueryOptions,
  QueryStreamOptions,
  StatementExecutionOptions,
  QueryDescription,
  ExplainOptions,
  DatabaseInfo,
  SweepResult,
  PreparedStatement,
  DataStreamOptions,
  IntrospectOptions,
  ColumnSchemaInfo,
  PrimaryKeySchemaInfo,
  ForeignKeySchemaInfo,
  IndexSchemaInfo,
  SequenceSchemaInfo,
  TriggerSchemaInfo,
  TableSchemaInfo,
  ViewSchemaInfo,
  SchemaIntrospection,
  MigrationExecutor,
  MigratableDatabase,
  MigrationStep,
  Migration,
  AppliedMigration,
  MigrateOptions,
  BlobStreamOptions,
  BlobHandle,
  BlobWritableStream,
  MigrateResult,
  StatementKind,
  RowMode,
  ArrayRow,
  TransactionOptions,
  IsolationLevel,
} from '../types';
