/**
 * sql-tag.ts – the `` sql`…` `` template tag.
 *
 * Interpolation in a SQL string is the classic injection bug, and the usual
 * advice — "use parameters" — is awkward enough that people don't:
 *
 * ```ts
 * await db.query('SELECT * FROM items WHERE id = ? AND name = ?', [id, name]);
 * ```
 *
 * The values sit far from the holes they fill, and adding a condition means
 * editing two places and keeping them in the same order. The tag closes that
 * distance without giving up parameter binding:
 *
 * ```ts
 * await db.query(sql`SELECT * FROM items WHERE id = ${id} AND name = ${name}`);
 * ```
 *
 * Every `${…}` becomes a `?` and its value is bound, so a value can never be
 * read as SQL. That is the whole safety property, and it holds no matter what
 * the value contains — `"'; DROP TABLE items --"` is a five-word string, not a
 * statement.
 *
 * What a tagged template cannot do is parameterise the parts of a statement
 * that are not values: table and column names, `ORDER BY` direction, whole
 * conditions. Those need text, and text is where injection lives again, so the
 * three ways to produce it are named and separate — {@link SqlTag.identifier},
 * {@link SqlTag.join}, and {@link SqlTag.unsafe}. Only the last is a loaded
 * gun, and it says so at the call site.
 *
 * Fragments nest, which is what makes conditional SQL bearable:
 *
 * ```ts
 * const active = onlyActive ? sql`AND active = ${true}` : sql``;
 * await db.query(sql`SELECT * FROM items WHERE owner = ${user} ${active}`);
 * ```
 *
 * Placeholders renumber themselves because Firebird's are positional `?`
 * rather than `$1` — splicing a fragment is concatenation on both the text and
 * the parameter list, with no renumbering to get wrong.
 */

import type { QueryParams, TransactionOptions } from './types';

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/**
 * Brands, registered globally rather than per module instance.
 *
 * `instanceof` would be the obvious check and is wrong here: this package has
 * two entry points, and an application that reaches both — or that ends up
 * with two installed copies — gets two `SqlFragment` classes whose instances
 * fail each other's `instanceof`. A `Symbol.for` key is the same symbol in
 * every copy, so the check survives that.
 */
const FRAGMENT = Symbol.for('firebird-wasm.SqlFragment');
const RAW = Symbol.for('firebird-wasm.RawSql');

/**
 * A piece of SQL and the values bound to its placeholders.
 *
 * Produced by {@link sql}, accepted anywhere `(sql, params)` is. Both fields
 * are readable, which is what makes a query loggable before it runs.
 */
export class SqlFragment {
  constructor(
    /** Statement text, with a `?` for every bound value. */
    readonly sql: string,
    /** Values for the placeholders, in order. */
    readonly params: QueryParams,
  ) {
    // Non-enumerable so the brand stays out of spreads, `JSON.stringify` and
    // anything else that walks own keys.
    Object.defineProperty(this, FRAGMENT, { value: true });
  }
}

/**
 * SQL text that is spliced in literally, with nothing bound.
 *
 * There is no way to make this safe in general — that is the point of keeping
 * it a distinct type rather than letting any string through. It exists because
 * identifiers and syntax cannot be parameters.
 */
export class RawSql {
  constructor(readonly sql: string) {
    Object.defineProperty(this, RAW, { value: true });
  }
}

/** True if `value` came from {@link sql}. */
export function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[FRAGMENT] === true
  );
}

function isRawSql(value: unknown): value is RawSql {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[RAW] === true
  );
}

// ---------------------------------------------------------------------------
// The tag
// ---------------------------------------------------------------------------

/** The shape of {@link sql}: callable as a tag, with helpers hanging off it. */
export interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): SqlFragment;

  /**
   * Quote a table or column name so it can be interpolated as text.
   *
   * ```ts
   * await db.query(sql`SELECT * FROM ${sql.identifier(table)} WHERE id = ${id}`);
   * ```
   *
   * The name is quoted verbatim, with any `"` doubled, so it cannot end the
   * quoting and start a statement.
   *
   * **Firebird folds unquoted names to upper case, and quoting turns that
   * off.** A table created as `CREATE TABLE items` is stored as `ITEMS`, and
   * `sql.identifier('items')` produces `"items"`, which will not find it. Pass
   * the name in its stored case — usually upper. This helper deliberately does
   * not upper-case for you: names created *with* quotes keep whatever case
   * they were given, and mangling those would be the worse failure of the two,
   * because it would corrupt a name that was previously correct.
   */
  identifier(name: string): RawSql;

  /**
   * Join values or fragments with a separator, as one fragment.
   *
   * The `IN` list problem: `WHERE id IN ${ids}` cannot work, because one
   * placeholder binds one value.
   *
   * ```ts
   * await db.query(sql`SELECT * FROM items WHERE id IN (${sql.join(ids)})`);
   * // SELECT * FROM items WHERE id IN (?, ?, ?)
   * ```
   *
   * Elements may be fragments, which is how a list of conditions is built:
   *
   * ```ts
   * sql`WHERE ${sql.join(conditions, ' AND ')}`
   * ```
   *
   * Note the parentheses above are written by the caller, not added here —
   * `join` has no way to know whether it is filling an `IN` list or an
   * `AND` chain.
   *
   * @throws if `values` is empty. `IN ()` is a syntax error in Firebird and an
   *   empty `AND` chain is an empty `WHERE`, so there is no text this could
   *   return that is not a bug somewhere later. An empty list usually means
   *   the caller wants "match nothing" (`1 = 0`) or "no filter" (`1 = 1`), and
   *   only the caller knows which.
   */
  join(values: readonly unknown[], separator?: string): SqlFragment;

  /**
   * Splice text in literally, escaping nothing.
   *
   * For syntax that cannot be a parameter and is not an identifier — a sort
   * direction, a `FIRST`/`SKIP` clause built by hand.
   *
   * ```ts
   * const dir = ascending ? sql.unsafe('ASC') : sql.unsafe('DESC');
   * await db.query(sql`SELECT * FROM items ORDER BY name ${dir}`);
   * ```
   *
   * Named `unsafe` because it is: anything reaching it from outside the
   * program is an injection. The name is the warning, and it shows up at the
   * call site during review rather than in this file.
   */
  unsafe(text: string): RawSql;
}

function tag(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = '';
  const params: unknown[] = [];

  for (let i = 0; i < strings.length; i++) {
    const chunk = strings[i];
    // Cooked strings are `undefined` for an invalid escape sequence — legal in
    // a tagged template since ES2018, where it hands the tag a hole rather
    // than a syntax error. Concatenating it would put the text "undefined"
    // into the statement, which fails later and somewhere else.
    if (chunk === undefined) {
      throw new SyntaxError(
        `sql\`…\` contains an invalid escape sequence in segment ${i}; ` +
          'use sql.unsafe() if the text is meant to be literal',
      );
    }
    text += chunk;

    if (i < values.length) {
      text += interpolate(values[i], params, i);
    }
  }

  return new SqlFragment(text, params);
}

/**
 * Render one `${…}`, appending to `params` when it binds.
 *
 * @returns the text this value contributes.
 */
function interpolate(value: unknown, params: unknown[], index: number): string {
  if (isSqlFragment(value)) {
    params.push(...value.params);
    return value.sql;
  }

  if (isRawSql(value)) {
    return value.sql;
  }

  if (Array.isArray(value)) {
    // One placeholder binds one value, so an array here is always a mistake —
    // and always the same mistake, which is worth naming precisely. Left to
    // the parameter encoder it surfaces as "unsupported type object" at bind
    // time, which does not suggest the fix.
    throw new TypeError(
      `Value ${index} in sql\`…\` is an array, which cannot bind to a single ` +
        'placeholder; use sql.join(values) to expand it into a list',
    );
  }

  params.push(value);
  return '?';
}

function identifier(name: string): RawSql {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('sql.identifier() needs a non-empty name');
  }
  if (name.includes('\0')) {
    // Firebird would reject it, but not before the NUL had truncated the
    // statement in whatever handled it first.
    throw new TypeError('sql.identifier() cannot contain a NUL character');
  }
  return new RawSql(`"${name.replace(/"/g, '""')}"`);
}

function join(values: readonly unknown[], separator = ', '): SqlFragment {
  if (values.length === 0) {
    throw new RangeError(
      'sql.join() needs at least one value: an empty list has no valid SQL ' +
        'form (IN () is a syntax error). Guard the empty case with the ' +
        'condition you actually mean — 1 = 0 to match nothing, 1 = 1 to ' +
        'match everything',
    );
  }

  let text = '';
  const params: unknown[] = [];

  values.forEach((value, index) => {
    if (index > 0) text += separator;
    text += interpolate(value, params, index);
  });

  return new SqlFragment(text, params);
}

function unsafe(text: string): RawSql {
  if (typeof text !== 'string') {
    throw new TypeError('sql.unsafe() needs a string');
  }
  return new RawSql(text);
}

/**
 * Build a {@link SqlFragment} from a template literal.
 *
 * See the module comment for what this is for and what it cannot do.
 */
export const sql: SqlTag = Object.assign(tag, { identifier, join, unsafe });

// ---------------------------------------------------------------------------
// Accepting fragments where (sql, params) is expected
// ---------------------------------------------------------------------------

/** A statement in the form the backends bind: text plus positional values. */
export interface Statement {
  sql: string;
  params: QueryParams;
}

/**
 * Normalise the two calling conventions into one.
 *
 * `query()` and `exec()` take either a string with its parameters or a
 * fragment carrying its own, and every backend needs the same reduction.
 *
 * @throws if a fragment is given alongside parameters. It reads as though the
 *   two combine, and they cannot: the fragment's placeholders are already
 *   filled, so the extra values would bind to nothing. Silently ignoring them
 *   would run a query the caller did not write.
 */
export function toStatement(
  sql: string | SqlFragment,
  params: QueryParams = [],
): Statement {
  if (!isSqlFragment(sql)) {
    return { sql, params };
  }

  if (params.length > 0) {
    throw new TypeError(
      'A sql`…` fragment already carries its parameters; passing more would ' +
        'bind them to nothing. Interpolate the values into the template ' +
        'instead',
    );
  }

  return { sql: sql.sql, params: sql.params };
}

/**
 * Resolve `query()`'s two shapes: `(sql, params, options)` and
 * `(fragment, options)`.
 *
 * A fragment carries its own parameters, so the slot that would have held them
 * is free — and making the caller write `query(fragment, undefined, options)`
 * to reach the third argument would be a poor trade for the tag's ergonomics.
 * The two are told apart by whether the argument is an array, which is
 * unambiguous: parameters are always one, options never are.
 */
export function resolveQueryCall(
  sql: string | SqlFragment,
  paramsOrOptions: QueryParams | TransactionOptions = [],
  maybeOptions: TransactionOptions = {},
): { statement: Statement; options: TransactionOptions } {
  const params = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
  const options = Array.isArray(paramsOrOptions)
    ? maybeOptions
    : (paramsOrOptions as TransactionOptions);

  return { statement: toStatement(sql, params), options };
}
