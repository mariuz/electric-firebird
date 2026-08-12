/**
 * statement-types.ts – names for Firebird's statement-type codes.
 *
 * The engine reports what a statement *is* as one of the `isc_info_sql_stmt_*`
 * constants. A caller asking `describeQuery()` what they have wants the name,
 * not the number — the number is only meaningful next to a copy of
 * `iberror.h`.
 *
 * Shared by both backends rather than per-backend: `node-firebird-driver`'s
 * `StatementType` enum is these same codes, so one table describes what either
 * one reports and the two cannot drift into naming the same statement
 * differently.
 */

import type { StatementKind } from './types';

// From firebird/impl/consts_pub.h (isc_info_sql_stmt_*).
const NAMES: Record<number, StatementKind> = {
  1: 'SELECT',
  2: 'INSERT',
  3: 'UPDATE',
  4: 'DELETE',
  5: 'DDL',
  6: 'GET_SEGMENT',
  7: 'PUT_SEGMENT',
  8: 'EXEC_PROCEDURE',
  9: 'START_TRANS',
  10: 'COMMIT',
  11: 'ROLLBACK',
  12: 'SELECT_FOR_UPD',
  13: 'SET_GENERATOR',
  14: 'SAVEPOINT',
};

/**
 * Name a statement-type code.
 *
 * An unrecognised code is `'UNKNOWN'` rather than an error: a Firebird release
 * may add one, and a name this library has not learned yet is no reason to
 * fail a description that is otherwise complete.
 */
export function statementKind(code: number): StatementKind {
  return NAMES[code] ?? 'UNKNOWN';
}
