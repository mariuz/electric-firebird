/**
 * firebird-wasm – Firebird Embedded for Node.js / TypeScript
 *
 * Provides a PGlite-style async API backed by the Firebird embedded engine.
 *
 * @example
 * ```ts
 * import { FirebirdLite } from 'firebird-wasm';
 *
 * const db = new FirebirdLite('/tmp/my-app.fdb');
 * await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
 * await db.exec('INSERT INTO items VALUES (1, \'hello\')');
 * const result = await db.query('SELECT * FROM items');
 * console.log(result.rows); // [{ ID: 1, NAME: 'hello' }]
 * await db.close();
 * ```
 */

export { FirebirdLite, FirebirdTransaction } from './firebird';

export { sql, SqlFragment, RawSql, isSqlFragment, toStatement } from './sql-tag';
export { statementKind } from './statement-types';
export { firebirdTypeName } from './browser/field-types';
export { applyTypes, applySerializers, hasTypeOptions } from './browser/value-types';
export {
  buildIcuLocalePack,
  isValidIcuDataPackage,
  ICU_LOCALE_DATA_PATH,
  DEFAULT_ICU_TAILORING_LOCALES,
} from './browser/icu-locales';
export {
  introspect,
  migrate,
  getAppliedMigrations,
  formatFirebirdColumnType,
  decodeFirebirdTriggerType,
  DEFAULT_MIGRATIONS_TABLE,
  diffSchema,
  generateMigration,
} from './browser/schema';
export type {
  SchemaDiffSource,
  ColumnModification,
  SchemaDiff,
  GenerateMigrationOptions,
  GeneratedMigration,
} from './browser/schema';
export {
  generateDrizzleSchema,
  generateDrizzleSchemaFromCatalog,
  generateKyselyTypes,
  generateKyselyTypesFromCatalog,
  resolveSchemaIntrospection,
} from './browser/codegen';
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
} from './browser/udr';
export type { UdrSqlExecutor } from './browser/udr';
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
} from './vector';
export type {
  VectorDistanceMetric,
  VectorInput,
  VectorDatabaseExecutor,
  RegisterVectorFunctionsOptions,
  VectorSearchOptions,
  VectorSearchRow,
} from './vector';
export type {
  CodegenIdentifierCase,
  DrizzleCodegenOptions,
  IntrospectableSource,
  KyselyCodegenOptions,
} from './browser/codegen';
export {
  isBlobHandle,
  isBlobWritableStream,
  DEFAULT_BLOB_SEGMENT_SIZE,
  MAX_BLOB_SEGMENT_SIZE,
} from './browser/blob-stream';
export {
  buildCopyToStream,
  executeCopyFromStream,
  encodeCsvRow,
  encodeJsonlRow,
  formatCopyIdentifier,
} from './browser/copy-stream';
export type { TypeOptions, Parser, Serializer } from './browser/value-types';
export type { SqlTag, Statement } from './sql-tag';

export type {
  FirebirdLiteOptions,
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
  PageIoCounters,
  QueryProfileEvent,
  QueryProfileListener,
  MonitorStats,
} from './types';

// WASM loader (available on all platforms)
export { loadFirebirdWasm, disposeFirebirdWasm, allocString, wasmGlueFile, hasSharedHeap, cdnArtifacts } from './wasm-loader';
export type { CdnOptions, CdnArtifacts } from './wasm-loader';
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
} from './browser/binary-result';
export type {
  EncodeBinaryResultOptions,
  BinaryResultPayload,
} from './browser/binary-result';
export type { BranchOptions } from './browser/firebird-browser';
export { VERSION } from './version';
export {
  extractReferencedTables,
  extractMutatedTables,
  liveTableEventName,
  liveTableTriggerDDL,
  liveBroadcastChannelName,
  CrossTabLiveBridge,
} from './browser/live-tables';
export type {
  CrossTabLiveMessage,
  CrossTabLiveBridgeOptions,
} from './browser/live-tables';
export {
  CowSnapshotStore,
  PAGE_DIFF_MAGIC,
  PAGE_DIFF_HEADER_BYTES,
  computeCrc32,
  isPageDiffPayload,
  exportPageDiff,
  inspectPageDiff,
  applyPageDiff,
} from './browser/snapshots';
export type {
  SnapshotOptions,
  DatabaseSnapshotInfo,
  DatabaseSnapshot,
  SnapshotOrImageInput,
  PageDiffOptions,
  ApplyPageDiffOptions,
  PageDiffEntry,
  ParsedPageDiff,
} from './browser/snapshots';
export {
  QueryProfiler,
  DEFAULT_MAX_RECENT_QUERIES,
} from './browser/profiler';
export {
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_WATERMARK_TABLE,
  DEFAULT_REPL_MIRROR_TABLE,
  DEFAULT_REPL_LSN_SEQUENCE,
  DEFAULT_REPL_ROLE_CONTEXT_VAR,
  DEFAULT_REPL_ORIGIN_CONTEXT_VAR,
  DEFAULT_REPL_SLOTS_TABLE,
  DEFAULT_REPL_SLOT_TTL_MS,
  NATIVE_REPL_SEGMENT_MAGIC,
  NATIVE_REPL_PROTOCOL_VERSION,
  replicationTriggerName,
  replicationEventName,
  buildReplicationTriggerDdl,
  installReplicationTriggers,
  dropReplicationTriggers,
  mergeReplicatedRow,
  formatHlc,
  parseHlc,
  compareHlc,
  createHlc,
  mergeCrdtRow,
  createCrdtConflictResolver,
  projectReplicatedRow,
  matchesRowFilter,
  orderEntriesByTopology,
  discoverUserTables,
  publishAllTables,
  exportSequences,
  applySequences,
  syncCatalog,
  needsBootstrap,
  bootstrapReplica,
  createPublication,
  createSubscription,
  replicateDatabases,
  createHttpReplicationHandler,
  createHttpReplicationClient,
  createBroadcastChannelTransport,
  createWebSocketReplicationPeer,
  encodeNativeJournalSegment,
  decodeNativeJournalSegment,
} from './replication';
export type {
  ReplicableDatabase,
  ReplicationOperation,
  ReplicationLogEntry,
  HlcTimestamp,
  HybridLogicalClockOptions,
  HybridLogicalClock,
  ColumnCrdtStrategy,
  CrdtMergeConfig,
  ReplicationConflictContext,
  ReplicationConflictResolution,
  ReplicationConflictStrategy,
  PublishedTableConfig,
  NormalizedPublishedTableConfig,
  SequenceWatermark,
  SyncCatalogOptions,
  SyncCatalogResult,
  BuildReplicationTriggerDdlOptions,
  InstalledReplicationTrigger,
  InstallReplicationTriggersOptions,
  ReplicationSlot,
  RegisterReplicationSlotOptions,
  PruneAckedResult,
  LogicalTableSnapshot,
  PublicationSnapshot,
  BootstrapReplicaOptions,
  BootstrapReplicaResult,
  CreatePublicationOptions,
  ReplicationPublication,
  CreateSubscriptionOptions,
  ReplicationIndexHook,
  ReplicationStats,
  SubscriptionPullResult,
  ReplicationSubscription,
  ReplicateDatabasesOptions,
  ReplicationSyncCycleResult,
  DatabaseReplicator,
  HttpReplicationHandlerOptions,
  HttpReplicationClientOptions,
  HttpReplicationClient,
  BroadcastChannelLike,
  BroadcastChannelTransportOptions,
  BroadcastChannelTransport,
  WebSocketLike,
  WebSocketReplicationPeerOptions,
  WebSocketReplicationPeer,
  NativeJournalSegmentHeader,
  NativeJournalSegment,
} from './replication';
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
} from './browser/page-crypto';
export type { PageEncryptionKey } from './browser/page-crypto';
export {
  OPFSVFS,
  mountOpfs,
  openDatabaseHandle,
  removeDatabaseFile,
  opfsAvailable,
  createMemorySyncAccessHandle,
  createOpfsMountStats,
} from './browser/opfs-fs';
export type {
  OPFSVFSOptions,
  SyncAccessHandle,
  OpfsDirectoryHandle,
  OpfsFileHandle,
  MountOpfsOptions,
  OpfsMountStats,
  MemorySyncAccessHandle,
} from './browser/opfs-fs';
export type {
  FirebirdWasmModule,
  WasmLoadOptions,
  EmscriptenFS,
  FbHandle,
} from './wasm-loader';
