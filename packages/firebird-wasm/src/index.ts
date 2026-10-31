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
} from './browser/schema';
export {
  isBlobHandle,
  isBlobWritableStream,
  DEFAULT_BLOB_SEGMENT_SIZE,
  MAX_BLOB_SEGMENT_SIZE,
} from './browser/blob-stream';
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
export { VERSION } from './version';
export type {
  FirebirdWasmModule,
  WasmLoadOptions,
  EmscriptenFS,
  FbHandle,
} from './wasm-loader';
