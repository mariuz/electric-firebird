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
 */
export interface FieldInfo {
  /** Column name (alias if provided, otherwise the field name). */
  name: string;
}

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
