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

import type { FieldInfo, QueryParams, QueryResult, Row } from '../types';

// Firebird type codes, from firebird/impl/sqlda_pub.h.
const SQL_TIMESTAMP = 510;
const SQL_BLOB = 520;
const SQL_TYPE_DATE = 570;
const SQL_INT64 = 580;

/** Binary BLOBs are sub-type 0; 1 is text, and the engine already decodes it. */
const BLOB_SUBTYPE_BINARY = 0;

/**
 * Convert one incoming column value.
 *
 * Called once per cell of a column it is registered for, never for `null` —
 * see {@link TypeOptions.parsers}. `field` carries the column's `subType`,
 * `scale` and `length`, which is what separates a `NUMERIC` from a `BIGINT`
 * or a text BLOB from a binary one when the type code alone does not.
 */
export type Parser = (value: unknown, field: FieldInfo) => unknown;

/**
 * Convert one outgoing parameter to the text Firebird will parse.
 *
 * Return `undefined` to decline, leaving the value to the next serializer and
 * finally to the built-in encoder. Return a string to bind that text, or
 * `null` to bind SQL NULL.
 */
export type Serializer = (value: unknown) => string | null | undefined;

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

  /**
   * Convert incoming values yourself, keyed by Firebird SQL type code.
   *
   * ```ts
   * const SQL_TIMESTAMP = 510;
   * new FirebirdBrowser('mydb', {
   *   worker,
   *   types: { parsers: { [SQL_TIMESTAMP]: (v) => Temporal.PlainDateTime.from(v as string) } },
   * });
   * ```
   *
   * The code is the one {@link FieldInfo.type} reports — `firebirdTypeName()`
   * names them, and they are listed in `field-types.ts`.
   *
   * A parser **replaces** the built-in conversion for its type rather than
   * running alongside it, so `parsers` is also how `bigint` or `dates` gets
   * overridden. Two conversions for one column would otherwise need an order,
   * and no order is obviously right.
   *
   * **Never called for `null`.** A parser that had to guard every value would
   * be all guard, and the alternative — every parser crashing on the first
   * nullable column — is worse. A column's nulls stay null.
   *
   * The type code alone does not always identify a type: `NUMERIC` and
   * `BIGINT` share `SQL_INT64` (580) and differ by `scale`, and BLOBs differ
   * by `subType`. Both reach the parser on `field`, so a parser registered for
   * a shared code has to check — the built-in conversions do exactly that.
   */
  parsers?: Record<number, Parser>;

  /**
   * Convert outgoing parameters yourself.
   *
   * ```ts
   * new FirebirdBrowser('mydb', {
   *   worker,
   *   types: { serializers: [(v) => (v instanceof Decimal ? v.toFixed() : undefined)] },
   * });
   * ```
   *
   * A list rather than a map keyed by type, because there is no type to key
   * on: parameters carry no declared type on the way out. Every value crosses
   * as text and Firebird converts it to whatever the column actually is, which
   * is what lets one path serve integers, dates and strings alike. So a
   * serializer is selected by looking at the *value*, and each one declines by
   * returning `undefined`.
   *
   * Consulted **before** the built-in encoder, so these also override how a
   * `Date` or a `number` is rendered. Like {@link TypeOptions.parsers}, they
   * are never called for `null` or `undefined`, both of which are already SQL
   * NULL.
   */
  serializers?: Serializer[];
}

/**
 * True if any incoming conversion is switched on.
 *
 * Serializers are deliberately not counted: they apply to parameters going
 * out, and this gates {@link applyTypes}, which only ever looks at rows
 * coming back.
 */
export function hasTypeOptions(options: TypeOptions | undefined): boolean {
  return Boolean(
    options &&
      (options.bigint ||
        options.dates ||
        options.binary ||
        (options.parsers && Object.keys(options.parsers).length > 0)),
  );
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

  // The nullable flag is the low bit. The engine reports it clear — Firebird
  // ORs it in only when filling a legacy XSQLDA — but masking costs one
  // operation and means a caller who keys a parser off a code they read
  // somewhere with the bit set still matches.
  const parser = options.parsers?.[type & ~1];
  if (parser) {
    // Wins over the built-ins below, which is what makes `parsers` the way to
    // override `dates` rather than a second conversion fighting it.
    return (value) =>
      value === null || value === undefined ? value : parser(value, field);
  }

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

/**
 * Run {@link TypeOptions.serializers} over a parameter list.
 *
 * Returns a new array — the caller's is not theirs to modify — or the original
 * when there is nothing to do, so the common case allocates nothing.
 *
 * This has to happen here rather than in the parameter encoder, for the same
 * reason {@link applyTypes} does: with a Worker transport the encoder runs on
 * the other side of `postMessage`, and a function cannot be structured-cloned.
 * Serializing before the values cross means the Worker only ever receives
 * strings, which clone fine.
 */
export function applySerializers(
  params: QueryParams,
  serializers: Serializer[] | undefined,
): QueryParams {
  if (!serializers || serializers.length === 0 || params.length === 0) {
    return params;
  }

  return params.map((value) => {
    // null and undefined are already SQL NULL; a serializer that had to
    // recognise them would be writing the encoder's job out again.
    if (value === null || value === undefined) return value;

    for (const serialize of serializers) {
      const serialized = serialize(value);
      if (serialized !== undefined) return serialized;
    }
    return value;
  });
}
