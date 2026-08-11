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

/**
 * What each row is.
 *
 * - `'object'` (default) keys every value by its upper-cased column name.
 * - `'array'` gives the values in column order, positionally.
 *
 * Names live in `fields` either way, so `'array'` loses nothing — it trades
 * the convenience of `row.NAME` for `row[1]`, and for that it skips building
 * one object per row.
 */
export type RowMode = 'object' | 'array';

/**
 * Options accepted by `query()`.
 *
 * A superset of {@link TransactionOptions}: a query may start a transaction of
 * its own, and it decides the shape of what comes back.
 */
export interface QueryOptions extends TransactionOptions {
  /**
   * How to shape each row.
   *
   * `'array'` is worth reaching for on large result sets and on columns whose
   * names collide: `SELECT a.ID, b.ID` has two columns and, in object mode,
   * one `ID` key — the second value wins and the first is unreachable.
   * Positional rows keep both.
   *
   * @default 'object'
   */
  rowMode?: RowMode;
}

/** A row in `rowMode: 'array'` — values in column order. */
export type ArrayRow = unknown[];

/**
 * What a statement is, from Firebird's `isc_info_sql_stmt_*` codes.
 *
 * `'UNKNOWN'` covers a code this library does not name rather than a failure
 * to describe the statement.
 */
export type StatementKind =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'DDL'
  | 'GET_SEGMENT'
  | 'PUT_SEGMENT'
  | 'EXEC_PROCEDURE'
  | 'START_TRANS'
  | 'COMMIT'
  | 'ROLLBACK'
  | 'SELECT_FOR_UPD'
  | 'SET_GENERATOR'
  | 'SAVEPOINT'
  | 'UNKNOWN';

/**
 * The shape of a statement, without running it.
 *
 * Returned by `describeQuery()`. Parameters are positional `?` in Firebird and
 * carry no names, so a `ParamInfo` has everything a {@link FieldInfo} has
 * except a meaningful one.
 */
export interface QueryDescription {
  /**
   * One entry per `?`, in order.
   *
   * `undefined` where the backend cannot report them — the Node driver
   * exposes no input metadata, and an empty array there would claim the
   * statement takes no parameters.
   */
  params?: FieldInfo[];
  /** One entry per result column, in order.  Empty for a statement returning none. */
  fields: FieldInfo[];
  /** What kind of statement it is. */
  statementType: StatementKind;
  /** Whether executing it yields rows. */
  hasResultSet: boolean;
}
