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
  BranchOptions,
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
  generateDrizzleSchema,
  generateDrizzleSchemaFromCatalog,
  generateKyselyTypes,
  generateKyselyTypesFromCatalog,
  resolveSchemaIntrospection,
} from './codegen';
export {
  UdrManager,
  invokeGlobalJsUdr,
  normalizeRoutineIdentifier,
  normalizeSqlTypeDeclaration,
  sqlTypeToFieldInfo,
  coerceValueToSqlType,
  buildFunctionExternalDdl,
  buildFunctionPsqlStubDdl,
  buildProcedureExternalDdl,
  buildProcedurePsqlStubDdl,
} from './udr';
export type { UdrSqlExecutor } from './udr';
export {
  encodeVector,
  decodeVector,
  formatVectorText,
  vectorColumnType,
  vectorNorm,
  normalizeVector,
  dotProduct,
  innerProductDistance,
  squaredL2Distance,
  l2Distance,
  cosineSimilarity,
  cosineDistance,
  registerVectorFunctions,
  vectorSearch,
} from '../vector';
export type {
  VectorDistanceMetric,
  VectorInput,
  VectorDatabaseExecutor,
  RegisterVectorFunctionsOptions,
  VectorSearchOptions,
  VectorSearchRow,
} from '../vector';
export type {
  CodegenIdentifierCase,
  DrizzleCodegenOptions,
  IntrospectableSource,
  KyselyCodegenOptions,
} from './codegen';
export {
  isBlobHandle,
  isBlobWritableStream,
  DEFAULT_BLOB_SEGMENT_SIZE,
  MAX_BLOB_SEGMENT_SIZE,
} from './blob-stream';
export {
  buildCopyToStream,
  executeCopyFromStream,
  encodeCsvRow,
  encodeJsonlRow,
  formatCopyIdentifier,
} from './copy-stream';
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
export {
  extractReferencedTables,
  extractMutatedTables,
  liveTableEventName,
  liveTableTriggerDDL,
  liveBroadcastChannelName,
  CrossTabLiveBridge,
} from './live-tables';
export type {
  CrossTabLiveMessage,
  CrossTabLiveBridgeOptions,
} from './live-tables';
export { CowSnapshotStore } from './snapshots';
export type {
  SnapshotOptions,
  DatabaseSnapshotInfo,
  DatabaseSnapshot,
} from './snapshots';
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
export {
  ENCRYPTED_PAGE_MAGIC,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
  ENCRYPTED_PAGE_OVERHEAD,
  isEncryptedPageBuffer,
  generateEncryptionKey,
  importRawEncryptionKey,
  exportRawEncryptionKey,
  deriveEncryptionKeyFromPassphrase,
  resolveCryptoKey,
  encryptPage,
  decryptPage,
} from './page-crypto';
export type { PageEncryptionKey } from './page-crypto';

export {
  OPFSVFS,
  mountOpfs,
  openDatabaseHandle,
  removeDatabaseFile,
  opfsAvailable,
  createMemorySyncAccessHandle,
  createOpfsMountStats,
} from './opfs-fs';
export type {
  OPFSVFSOptions,
  SyncAccessHandle,
  OpfsDirectoryHandle,
  OpfsFileHandle,
  MountOpfsOptions,
  OpfsMountStats,
  MemorySyncAccessHandle,
} from './opfs-fs';

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
  CopyFormat,
  CopyOptionsBase,
  CopyFromOptions,
  CopyToOptions,
  CopyResult,
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
  JsUdrArgDefinition,
  JsUdrOutputColumnDefinition,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
  JsFunctionHandler,
  JsProcedureHandler,
  RegisteredRoutine,
} from '../types';
