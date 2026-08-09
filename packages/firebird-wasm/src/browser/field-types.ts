/**
 * field-types.ts – readable names for Firebird's SQL type codes.
 *
 * The engine reports numeric type codes.  Turning them into names is not
 * decoration: `NUMERIC` and `DECIMAL` are stored as scaled integers and arrive
 * as exact decimal strings, so a caller has to be able to tell them from a
 * `VARCHAR` to know whether `"20.25"` is a number or text.
 */

import type { FirebirdTypeName } from '../types';

// From firebird/impl/sqlda_pub.h. The nullable flag is the low bit, and is
// masked off before lookup.
const SQL_TEXT = 452;
const SQL_VARYING = 448;
const SQL_SHORT = 500;
const SQL_LONG = 496;
const SQL_FLOAT = 482;
const SQL_DOUBLE = 480;
const SQL_D_FLOAT = 530;
const SQL_TIMESTAMP = 510;
const SQL_BLOB = 520;
const SQL_ARRAY = 540;
const SQL_TYPE_TIME = 560;
const SQL_TYPE_DATE = 570;
const SQL_INT64 = 580;
const SQL_TIMESTAMP_TZ = 32754;
const SQL_TIME_TZ = 32756;
const SQL_INT128 = 32752;
const SQL_DEC16 = 32760;
const SQL_DEC34 = 32762;
const SQL_BOOLEAN = 32764;
const SQL_NULL = 32766;

const NAMES: Record<number, FirebirdTypeName> = {
  [SQL_TEXT]: 'TEXT',
  [SQL_VARYING]: 'VARYING',
  [SQL_SHORT]: 'SMALLINT',
  [SQL_LONG]: 'INTEGER',
  [SQL_FLOAT]: 'FLOAT',
  [SQL_DOUBLE]: 'DOUBLE',
  [SQL_D_FLOAT]: 'DOUBLE',
  [SQL_TIMESTAMP]: 'TIMESTAMP',
  [SQL_BLOB]: 'BLOB',
  [SQL_ARRAY]: 'ARRAY',
  [SQL_TYPE_TIME]: 'TIME',
  [SQL_TYPE_DATE]: 'DATE',
  [SQL_INT64]: 'BIGINT',
  [SQL_TIMESTAMP_TZ]: 'TIMESTAMP_TZ',
  [SQL_TIME_TZ]: 'TIME_TZ',
  [SQL_INT128]: 'INT128',
  [SQL_DEC16]: 'DECFLOAT16',
  [SQL_DEC34]: 'DECFLOAT34',
  [SQL_BOOLEAN]: 'BOOLEAN',
  [SQL_NULL]: 'NULL',
};

/**
 * Name a Firebird SQL type code.
 *
 * A non-zero `scale` reports `NUMERIC`: Firebird stores `NUMERIC` and
 * `DECIMAL` as scaled `SMALLINT`, `INTEGER`, `BIGINT` or `INT128`, so the type
 * code alone would call them integers and hide that the value is exact and
 * arrives as a string.
 */
export function firebirdTypeName(type: number, scale = 0): FirebirdTypeName {
  const base = type & ~1; // strip the nullable flag

  if (scale !== 0) {
    switch (base) {
      case SQL_SHORT:
      case SQL_LONG:
      case SQL_INT64:
      case SQL_INT128:
        return 'NUMERIC';
      default:
        break;
    }
  }

  return NAMES[base] ?? 'UNKNOWN';
}
