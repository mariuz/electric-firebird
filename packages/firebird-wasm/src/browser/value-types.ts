/**
 * value-types.ts – opt-in conversion of result values to richer JavaScript types.
 *
 * The wire format hands back values that are always *correct* and sometimes
 * awkward: a `BIGINT` past 2⁵³ is an exact decimal string, a binary `BLOB` is
 * base64, a `TIMESTAMP` is ISO-8601 text. Nothing is lost, but nothing is
 * directly usable either.
 *
 * These conversions are opt-in rather than default because each one trades
 * something away, and a database library that quietly changes what `rows`
 * contains is not one to trust. See {@link TypeOptions} for what each costs.
 */

import type { FieldInfo, QueryResult, Row } from '../types';

// Firebird type codes, from firebird/impl/sqlda_pub.h.
const SQL_TIMESTAMP = 510;
const SQL_BLOB = 520;
const SQL_TYPE_DATE = 570;
const SQL_INT64 = 580;

/** Binary BLOBs are sub-type 0; 1 is text, and the engine already decodes it. */
const BLOB_SUBTYPE_BINARY = 0;

/**
 * Which values to convert.  Everything defaults to off.
 *
 * @example
 * ```ts
 * const db = new FirebirdBrowser('mydb', {
 *   worker,
 *   types: { bigint: true, binary: true },
 * });
 * ```
 */
export interface TypeOptions {
  /**
   * `BIGINT` as `bigint`.
   *
   * Applies to every `BIGINT`, not only those past 2⁵³. The default rule —
   * `number` when it fits, `string` when it does not — means `typeof row.ID`
   * depends on how large the id happens to be, which is worse than either type
   * on its own.
   *
   * Does **not** apply to `NUMERIC`/`DECIMAL`, which Firebird also stores as a
   * scaled 64-bit integer: those keep their exact decimal string, because a
   * `bigint` would silently drop the scale.
   */
  bigint?: boolean;

  /**
   * `DATE` and `TIMESTAMP` as `Date`.
   *
   * Two costs, both unavoidable rather than incidental:
   *
   * - **Precision.** Firebird keeps 100 µs; `Date` keeps 1 ms. `11:22:33.4567`
   *   becomes `11:22:33.456`. The fourth digit is gone.
   * - **Time zone.** Firebird's `DATE` and `TIMESTAMP` carry no zone — they are
   *   wall-clock values — while `Date` is an absolute instant, so a zone has to
   *   be chosen. **UTC** is used, so the same stored value yields the same
   *   `Date` on every machine. Left to JavaScript's own parsing it would be
   *   local for `TIMESTAMP` and UTC for `DATE`, which is both machine-dependent
   *   and inconsistent between the two types.
   *
   * `TIME`, `TIME WITH TIME ZONE` and `TIMESTAMP WITH TIME ZONE` are **never**
   * converted: `new Date('11:22:33')` is `Invalid Date`, and `Date` has nowhere
   * to keep a named zone like `Europe/Bucharest`. They stay strings.
   */
  dates?: boolean;

  /**
   * Binary `BLOB` as `Uint8Array` rather than base64.
   *
   * The one conversion with no downside: base64 is 33% larger than the bytes it
   * encodes and has to be decoded before use. Text BLOBs are unaffected — the
   * engine already returns those as strings.
   */
  binary?: boolean;
}

/** True if any conversion is switched on. */
export function hasTypeOptions(options: TypeOptions | undefined): boolean {
  return Boolean(options && (options.bigint || options.dates || options.binary));
}

/** Decode base64 to bytes, in either a browser or Node. */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * A converter for one column, or null when the column needs none.
 *
 * Chosen once per result set from {@link FieldInfo} rather than per value: the
 * type of a column does not vary row to row, and deciding per value would put
 * a branch in the hot path for every cell.
 */
function converterFor(
  field: FieldInfo,
  options: TypeOptions,
): ((value: unknown) => unknown) | null {
  const type = field.type;
  if (type === undefined) return null;

  if (options.bigint && type === SQL_INT64 && field.scale === 0) {
    // scale 0 is what separates a BIGINT from a NUMERIC stored in the same
    // 64-bit integer. A scaled value converted to bigint would lose its
    // decimal point without saying so.
    return (value) =>
      value === null || value === undefined ? value : BigInt(value as string | number);
  }

  if (options.dates && (type === SQL_TIMESTAMP || type === SQL_TYPE_DATE)) {
    return (value) => {
      if (typeof value !== 'string') return value;
      // 'Z' makes the interpretation UTC and explicit. Without it a bare
      // date-time is local and a bare date is UTC — see TypeOptions.dates.
      const parsed = new Date(`${value}Z`);
      // A value the engine produced should always parse; if it somehow does
      // not, the string is more useful to a caller than an Invalid Date.
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    };
  }

  if (options.binary && type === SQL_BLOB && field.subType === BLOB_SUBTYPE_BINARY) {
    return (value) => (typeof value === 'string' ? base64ToBytes(value) : value);
  }

  return null;
}

/**
 * Apply {@link TypeOptions} to a result set, in place.
 *
 * Returns the same object. Columns needing no conversion are never visited, so
 * a result set with nothing convertible costs one pass over the field list and
 * nothing per row.
 */
export function applyTypes<T extends Row>(
  result: QueryResult<T>,
  options: TypeOptions | undefined,
): QueryResult<T> {
  if (!hasTypeOptions(options) || result.rows.length === 0) {
    return result;
  }

  const converters: Array<[string, (value: unknown) => unknown]> = [];
  for (const field of result.fields) {
    const convert = converterFor(field, options!);
    if (convert) converters.push([field.name, convert]);
  }

  if (converters.length === 0) return result;

  for (const row of result.rows) {
    const target = row as Record<string, unknown>;
    for (const [name, convert] of converters) {
      target[name] = convert(target[name]);
    }
  }

  return result;
}
