/**
 * TypeScript types for FirebirdLite
 */

/**
 * Options for creating a FirebirdLite instance.
 */
export interface FirebirdLiteOptions {
  /** Path to the Firebird client library. Defaults to the system default. */
  libraryPath?: string;
  /**
   * Character set for `NONE`-charset columns/parameters.
   * Passed as `charSetForNONE` to the underlying driver.
   */
  charset?: string;
  /** Firebird user name. Defaults to 'SYSDBA'. */
  username?: string;
  /** Firebird user password. */
  password?: string;
}

/**
 * Result returned from a query execution.
 */
export interface QueryResult<T = Row> {
  /** Array of result rows. */
  rows: T[];
  /** Column names in the result set (in order). */
  fields: FieldInfo[];
  /** Number of rows affected (for INSERT/UPDATE/DELETE). */
  affectedRows?: number;
}

/**
 * Information about a result set column.
 *
 * Everything beyond `name` is optional because the Node.js native driver does
 * not expose it; the WASM backend fills it in.
 */
export interface FieldInfo {
  /** Column name (alias if provided, otherwise the field name). */
  name: string;
  /**
   * Firebird SQL type code — `SQL_LONG` (496), `SQL_VARYING` (448) and so on.
   *
   * Worth having because the JSON encoding is lossy about types: a
   * `NUMERIC(10,2)` arrives as the string `"20.25"` to preserve its exactness,
   * and without this it is indistinguishable from a `VARCHAR` containing
   * digits.
   */
  type?: number;
  /** A readable form of {@link FieldInfo.type}, e.g. `'NUMERIC'`. */
  typeName?: FirebirdTypeName;
  /** Type-specific subtype; for BLOBs, 1 means text. */
  subType?: number;
  /** Decimal scale.  Non-zero means the value is exact and arrives as a string. */
  scale?: number;
  /** Declared length in bytes. */
  length?: number;
  /** Whether the column may be NULL. */
  nullable?: boolean;
}

/** Readable names for the Firebird SQL type codes this library reports. */
export type FirebirdTypeName =
  | 'TEXT'
  | 'VARYING'
  | 'SMALLINT'
  | 'INTEGER'
  | 'BIGINT'
  | 'INT128'
  | 'FLOAT'
  | 'DOUBLE'
  | 'DECFLOAT16'
  | 'DECFLOAT34'
  | 'NUMERIC'
  | 'DATE'
  | 'TIME'
  | 'TIMESTAMP'
  | 'TIME_TZ'
  | 'TIMESTAMP_TZ'
  | 'BOOLEAN'
  | 'BLOB'
  | 'ARRAY'
  | 'NULL'
  | 'UNKNOWN';

/**
 * A single row from a query result, keyed by column name.
 */
export type Row = Record<string, unknown>;

/**
 * Parameters passed to a parameterized query.
 */
export type QueryParams = unknown[];

/**
 * Transaction isolation level.
 *
 * - `READ_COMMITTED` – reads the latest committed version of each row;
 *   other transactions' commits become visible during the transaction.
 * - `SNAPSHOT` – provides a stable, point-in-time view of the database
 *   from the moment the transaction started (Firebird's default).
 * - `SNAPSHOT_TABLE_STABILITY` – acquires shared table locks to prevent
 *   concurrent writes; mapped to Firebird `CONSISTENCY` isolation.
 */
export type IsolationLevel =
  | 'READ_COMMITTED'
  | 'SNAPSHOT'
  | 'SNAPSHOT_TABLE_STABILITY';

/**
 * Options for beginning a transaction.
 */
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}
