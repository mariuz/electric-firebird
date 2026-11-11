/**
 * Structured Firebird error diagnostics (`FirebirdError`).
 *
 * Parses raw Firebird engine / status-vector messages (from both the WASM C++
 * bridge and `node-firebird-driver`) into typed `sqlcode`, `gdscode`, `symbol`,
 * `table`, `column`, `constraint`, and actionable `hint` fields.
 */

export interface FirebirdErrorDetails {
  /** Original error message text. */
  message: string;
  /** Numeric Firebird SQLCODE (negative integer, e.g. `-803`, `-530`, `-104`). */
  sqlcode?: number;
  /** Numeric Firebird ISC/GDS status code when identifiable (e.g. `335544665`). */
  gdscode?: number;
  /** Symbolic error category identifier (e.g. `'unique_key_violation'`). */
  symbol?: string;
  /** Standard 5-character SQLSTATE class when derivable (e.g. `'23000'`, `'42000'`). */
  sqlState?: string;
  /** Referenced table/relation name when present in the engine message. */
  table?: string;
  /** Referenced column/field name when present in the engine message. */
  column?: string;
  /** Violated constraint or index name when present in the engine message. */
  constraint?: string;
  /** SQL statement that triggered the error, when supplied by the caller. */
  sql?: string;
  /** Actionable developer remediation hint. */
  hint?: string;
}

/**
 * Structured Error subclass carrying parsed Firebird engine diagnostics.
 */
export class FirebirdError extends Error {
  readonly sqlcode?: number;
  readonly gdscode?: number;
  readonly symbol?: string;
  readonly sqlState?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  readonly sql?: string;
  readonly hint?: string;
  readonly cause?: unknown;

  constructor(details: FirebirdErrorDetails, options?: { cause?: unknown }) {
    super(details.message);
    this.name = 'FirebirdError';
    this.sqlcode = details.sqlcode;
    this.gdscode = details.gdscode;
    this.symbol = details.symbol;
    this.sqlState = details.sqlState;
    this.table = details.table;
    this.column = details.column;
    this.constraint = details.constraint;
    this.sql = details.sql;
    this.hint = details.hint;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialize structured fields for logging and JSON error responses. */
  toJSON(): FirebirdErrorDetails {
    const out: FirebirdErrorDetails = { message: this.message };
    if (this.sqlcode !== undefined) out.sqlcode = this.sqlcode;
    if (this.gdscode !== undefined) out.gdscode = this.gdscode;
    if (this.symbol !== undefined) out.symbol = this.symbol;
    if (this.sqlState !== undefined) out.sqlState = this.sqlState;
    if (this.table !== undefined) out.table = this.table;
    if (this.column !== undefined) out.column = this.column;
    if (this.constraint !== undefined) out.constraint = this.constraint;
    if (this.sql !== undefined) out.sql = this.sql;
    if (this.hint !== undefined) out.hint = this.hint;
    return out;
  }
}

/** Type guard for {@link FirebirdError}. */
export function isFirebirdError(value: unknown): value is FirebirdError {
  return value instanceof FirebirdError;
}

function unquoteName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed || undefined;
}

/**
 * Parse a Firebird engine error string or `Error` object into structured
 * {@link FirebirdErrorDetails} with remediation hints.
 */
export function parseFirebirdError(
  errorOrMessage: unknown,
  sql?: string,
): FirebirdErrorDetails {
  const message =
    errorOrMessage instanceof Error
      ? errorOrMessage.message
      : String(errorOrMessage ?? 'Unknown Firebird error');

  const details: FirebirdErrorDetails = { message };
  if (sql !== undefined) {
    details.sql = sql;
  }

  // Extract explicit SQL error code / SQLCODE if present in message
  const sqlcodeMatch =
    message.match(/SQL(?:\s+error)?\s+code\s*=\s*(-?\d+)/i) ??
    message.match(/\bSQLCODE\s*[=:]?\s*(-?\d+)/i);
  if (sqlcodeMatch) {
    details.sqlcode = Number.parseInt(sqlcodeMatch[1], 10);
  }

  // Extract explicit GDS code if present on Error object or message
  if (
    typeof errorOrMessage === 'object' &&
    errorOrMessage !== null &&
    typeof (errorOrMessage as { gdscode?: unknown }).gdscode === 'number'
  ) {
    details.gdscode = (errorOrMessage as { gdscode: number }).gdscode;
  }
  if (
    details.sqlcode === undefined &&
    typeof errorOrMessage === 'object' &&
    errorOrMessage !== null &&
    typeof (errorOrMessage as { sqlcode?: unknown }).sqlcode === 'number'
  ) {
    details.sqlcode = (errorOrMessage as { sqlcode: number }).sqlcode;
  }

  // 1. Unique / Primary Key Violation (-803 / isc_unique_key_violation = 335544665)
  const uniqueMatch = message.match(
    /violation of PRIMARY or UNIQUE KEY constraint\s+"([^"]+)"\s+on table\s+"([^"]+)"/i,
  );
  if (uniqueMatch || /attempt to store duplicate value/i.test(message)) {
    details.sqlcode ??= -803;
    details.gdscode ??= 335544665;
    details.symbol = 'unique_key_violation';
    details.sqlState = '23000';
    if (uniqueMatch) {
      details.constraint = uniqueMatch[1];
      details.table = uniqueMatch[2];
    }
    details.hint =
      'Use `UPDATE OR INSERT INTO <table> (...) VALUES (...) MATCHING (<pk>)` for idempotent upserts, or ensure primary/unique key values do not collide.';
    return details;
  }

  // 2. Foreign Key Violation (-530 / isc_foreign_key = 335544466)
  const fkMatch = message.match(
    /violation of FOREIGN KEY constraint\s+"([^"]+)"\s+on table\s+"([^"]+)"/i,
  );
  if (fkMatch) {
    details.sqlcode ??= -530;
    details.gdscode ??= 335544466;
    details.symbol = 'foreign_key_violation';
    details.sqlState = '23000';
    details.constraint = fkMatch[1];
    details.table = fkMatch[2];
    details.hint =
      'Insert referenced parent rows before child rows, or delete/update dependent child rows before removing the parent row.';
    return details;
  }

  // 3. NOT NULL / CHECK Validation Error (-625 / isc_not_valid = 335544347)
  const notNullMatch = message.match(
    /validation error for column\s+(?:"([^"]+)"\.)?"([^"]+)"/i,
  );
  const checkMatch = message.match(
    /Operation violates CHECK constraint\s+"?([^"\s]+)"?\s+on view or table\s+"?([^"\s]+)"?/i,
  );
  if (notNullMatch || checkMatch) {
    details.sqlcode ??= -625;
    details.gdscode ??= 335544347;
    details.symbol = checkMatch ? 'check_constraint_violation' : 'not_null_violation';
    details.sqlState = '23000';
    if (notNullMatch) {
      if (notNullMatch[1]) details.table = notNullMatch[1];
      details.column = notNullMatch[2];
      details.hint = `Supply a non-null value for column "${details.column}" or declare a DEFAULT on the column.`;
    } else if (checkMatch) {
      details.constraint = unquoteName(checkMatch[1]);
      details.table = unquoteName(checkMatch[2]);
      details.hint = `Ensure row values satisfy CHECK constraint "${details.constraint}".`;
    }
    return details;
  }

  // 4. Table / View Unknown (-204 / isc_dsql_relation_err = 335544580)
  const tableUnknownMatch = message.match(/Table unknown[\s:-]+(["A-Za-z0-9_$]+)/i);
  if (tableUnknownMatch) {
    details.sqlcode ??= -204;
    details.gdscode ??= 335544580;
    details.symbol = 'table_unknown';
    details.sqlState = '42S02';
    details.table = unquoteName(tableUnknownMatch[1]);
    details.hint = `Verify that table "${details.table}" has been created (and committed if queried from another transaction) and check quoted identifier casing.`;
    return details;
  }

  // 5. Column Unknown (-206 / isc_dsql_field_err = 335544578)
  const colUnknownMatch = message.match(/Column unknown[\s:-]+(["A-Za-z0-9_$.]+)/i);
  if (colUnknownMatch) {
    details.sqlcode ??= -206;
    details.gdscode ??= 335544578;
    details.symbol = 'column_unknown';
    details.sqlState = '42S22';
    details.column = unquoteName(colUnknownMatch[1]);
    details.hint = `Check column spelling/casing via \`db.introspect()\` (unquoted Firebird identifiers fold to UPPERCASE; double-quoted identifiers are case-sensitive).`;
    return details;
  }

  // 6. SQL Syntax / Token Unknown (-104 / isc_dsql_token_err = 335544634)
  if (/Token unknown/i.test(message) || details.sqlcode === -104) {
    details.sqlcode ??= -104;
    details.gdscode ??= 335544634;
    details.symbol = 'syntax_error';
    details.sqlState = '42000';
    details.hint =
      'Check Firebird SQL syntax (e.g., use `ROWS m TO n` or `FIRST n SKIP m` instead of `LIMIT`, and `SET TERM` or `db.exec()` for multi-statement PSQL triggers/procedures).';
    return details;
  }

  // 7. Permission / Read-Only Replica Violation (-551 / -817)
  if (/attempted update on read-only database/i.test(message)) {
    details.sqlcode ??= -817;
    details.gdscode ??= 335544362;
    details.symbol = 'read_only_database';
    details.sqlState = '25006';
    details.hint =
      'This database is in `read_only` replica or attachment mode. Switch to `db.setReplicaMode("read_write")` or `db.setReplicaMode("none")` (or `promoteReplica()`) before executing direct writes.';
    return details;
  }
  const permMatch = message.match(
    /no permission for\s+\w+\s+access to\s+(?:TABLE|VIEW|PROCEDURE)\s+([A-Za-z0-9_$"']+)/i,
  );
  if (permMatch || details.sqlcode === -551) {
    details.sqlcode ??= -551;
    details.gdscode ??= 335544352;
    details.symbol = 'permission_denied';
    details.sqlState = '42000';
    if (permMatch) details.table = unquoteName(permMatch[1]);
    details.hint = 'Check SQL `GRANT` privileges or connect as `SYSDBA` / table owner.';
    return details;
  }

  // 8. Native Engine Replica Mode Mismatch
  if (/Database is not in (?:the )?replica mode/i.test(message)) {
    details.sqlcode ??= -901;
    details.symbol = 'replica_mode_required';
    details.sqlState = 'HY000';
    details.hint =
      'Call `await db.setReplicaMode("read_write")` (or `"read_only"`) before applying native `"FBCHANGELOG\\0"` segments via `applyChangelog()`.';
    return details;
  }

  // 9. Unsuccessful Metadata Update / Object in Use (-607 / isc_no_meta_update = 335544351)
  if (/unsuccessful metadata update/i.test(message) || details.sqlcode === -607) {
    details.sqlcode ??= -607;
    details.gdscode ??= 335544351;
    details.symbol = 'unsuccessful_metadata_update';
    details.sqlState = '42000';
    if (/object .* is in use/i.test(message)) {
      details.hint =
        'Close open cursors/transactions or disable `statementCache` / `sharedReads` before running `DROP` or `ALTER` DDL on an active object.';
    } else if (/already exists/i.test(message)) {
      details.hint =
        'Use `RECREATE TABLE` / `CREATE OR ALTER` or check `db.introspect()` before issuing duplicate `CREATE` DDL.';
    } else {
      details.hint = 'Verify DDL object dependencies and ensure no concurrent transaction holds locks on the target metadata object.';
    }
    return details;
  }

  // 10. Deadlock / Concurrent Update Conflict (-913 / isc_deadlock = 335544336)
  if (
    /deadlock|update conflicts with concurrent update|lock conflict on no wait transaction/i.test(
      message,
    ) ||
    details.sqlcode === -913
  ) {
    details.sqlcode ??= -913;
    details.gdscode ??= 335544336;
    details.symbol = 'deadlock_or_conflict';
    details.sqlState = '40001';
    details.hint =
      'Retry the `db.transaction(...)` unit of work or configure `wait` / `lockTimeout` in `TransactionOptions`.';
    return details;
  }

  return details;
}

/**
 * Convert any caught error into a {@link FirebirdError} (returning `error` as-is
 * if it is already a `FirebirdError`).
 */
export function toFirebirdError(error: unknown, sql?: string): FirebirdError {
  if (error instanceof FirebirdError) {
    if (sql !== undefined && error.sql === undefined) {
      return new FirebirdError({ ...error.toJSON(), sql }, { cause: error.cause ?? error });
    }
    return error;
  }
  const parsed = parseFirebirdError(error, sql);
  return new FirebirdError(parsed, { cause: error });
}
