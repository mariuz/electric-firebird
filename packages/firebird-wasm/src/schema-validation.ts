/**
 * schema-validation.ts – Standard Schema v1 (`Zod` / `Valibot` / `ArkType`)
 * runtime validation & compile-time Typed SQL helpers (`createTypedSql<DB>()`)
 * (`M19 Item 4`).
 */

import type { QueryOptions, QueryResult, Row, StatementExecutionOptions } from './types';
import { RawSql, SqlFragment, sql as sqlTag } from './sql-tag';
import type { FirebirdDatabase, UnifiedExecuteResult } from './database-core';

// ===========================================================================
// 1. Standard Schema v1 (`https://standardschema.dev`)
// ===========================================================================

/** A single validation issue emitted by a Standard Schema v1 validator. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** Result returned by `schema['~standard'].validate(value)`. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/**
 * Official Standard Schema v1 structural contract implemented natively by
 * `zod` (`>= 3.24`), `valibot` (`>= 1.0`), `arktype` (`>= 2.0`), and
 * {@link createRowSchema}.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

/** Infer the validated output type of a {@link StandardSchemaV1} validator. */
export type InferStandardSchemaOutput<S> =
  S extends StandardSchemaV1<unknown, infer Out> ? Out : never;

/** Type guard checking whether `value` implements {@link StandardSchemaV1}. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null) return false;
  const std = (value as { '~standard'?: unknown })['~standard'];
  return (
    typeof std === 'object' &&
    std !== null &&
    (std as { version?: unknown }).version === 1 &&
    typeof (std as { validate?: unknown }).validate === 'function'
  );
}

function formatIssuePath(
  path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>,
): string {
  if (!path || path.length === 0) return '<root>';
  return path
    .map((seg) =>
      typeof seg === 'object' && seg !== null && 'key' in seg
        ? String(seg.key)
        : String(seg),
    )
    .join('.');
}

/**
 * Structured error thrown when a query row or replicated row fails
 * {@link StandardSchemaV1} validation (`M19 Item 4`).
 */
export class SchemaValidationError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
  readonly rowIndex?: number;
  readonly tableName?: string;

  constructor(
    issues: ReadonlyArray<StandardSchemaIssue>,
    context?: { rowIndex?: number; tableName?: string },
  ) {
    const summary = issues
      .map((i) => `${formatIssuePath(i.path)}: ${i.message}`)
      .join('; ');
    const prefixParts: string[] = ['Schema validation failed'];
    if (context?.tableName) prefixParts.push(`on table "${context.tableName}"`);
    if (context?.rowIndex !== undefined) prefixParts.push(`at row ${context.rowIndex}`);
    super(`${prefixParts.join(' ')}: ${summary}`);
    this.name = 'SchemaValidationError';
    this.issues = issues;
    this.rowIndex = context?.rowIndex;
    this.tableName = context?.tableName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isPromiseLike<T>(val: unknown): val is PromiseLike<T> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as { then?: unknown }).then === 'function'
  );
}

/**
 * Validate a single value against a {@link StandardSchemaV1} schema.
 * Runs synchronously without microtask overhead whenever the underlying
 * validator is synchronous, or awaits async validators transparently.
 */
export async function validateValueWithSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
  context?: { rowIndex?: number; tableName?: string },
): Promise<T> {
  const rawResult = schema['~standard'].validate(value);
  const resolved = isPromiseLike<StandardSchemaResult<T>>(rawResult)
    ? await rawResult
    : rawResult;
  if (resolved.issues) {
    throw new SchemaValidationError(resolved.issues, context);
  }
  return resolved.value;
}

/**
 * Validate an array of rows against a {@link StandardSchemaV1} schema,
 * returning the transformed/typed output rows (`M19 Item 4`).
 */
export async function validateRowsWithSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  rows: readonly unknown[],
  context?: { tableName?: string },
): Promise<T[]> {
  const out = new Array<T>(rows.length);
  const validateFn = schema['~standard'].validate;
  for (let i = 0; i < rows.length; i++) {
    const raw = validateFn(rows[i]);
    const res = isPromiseLike<StandardSchemaResult<T>>(raw) ? await raw : raw;
    if (res.issues) {
      throw new SchemaValidationError(res.issues, {
        rowIndex: i,
        tableName: context?.tableName,
      });
    }
    out[i] = res.value;
  }
  return out;
}

/** Declarative field validator descriptor for zero-dependency {@link createRowSchema}. */
export type RowFieldRule<T = unknown> =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | ((value: unknown, row: Record<string, unknown>) => T);

/**
 * Lightweight built-in {@link StandardSchemaV1} row validator factory for use
 * without external validation libraries (`M19 Item 4`).
 */
export function createRowSchema<T extends Row>(
  rules: { readonly [K in keyof T]: RowFieldRule<T[K]> },
  options?: {
    allowNull?: ReadonlyArray<keyof T>;
    caseInsensitiveKeys?: boolean;
    passthrough?: boolean;
  },
): StandardSchemaV1<unknown, T> {
  const nullableSet = new Set<string>(
    (options?.allowNull ?? []).map((k) => String(k)),
  );
  const caseInsensitive = options?.caseInsensitiveKeys ?? true;
  const passthrough = options?.passthrough ?? false;
  const ruleEntries = Object.entries(rules) as Array<[string, RowFieldRule]>;

  return {
    '~standard': {
      version: 1,
      vendor: 'firebird-wasm',
      validate(input: unknown): StandardSchemaResult<T> {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          return {
            issues: [{ message: 'Expected a row object' }],
          };
        }
        const record = input as Record<string, unknown>;
        let upperLookup: Map<string, unknown> | null = null;
        if (caseInsensitive) {
          upperLookup = new Map();
          for (const [k, v] of Object.entries(record)) {
            upperLookup.set(k.toUpperCase(), v);
          }
        }

        const issues: StandardSchemaIssue[] = [];
        const output: Record<string, unknown> = passthrough ? { ...record } : {};

        for (const [key, rule] of ruleEntries) {
          const rawVal =
            key in record
              ? record[key]
              : upperLookup?.get(key.toUpperCase());

          if (typeof rule === 'function') {
            if (rawVal === null && nullableSet.has(key)) {
              output[key] = null;
              continue;
            }
            try {
              output[key] = rule(rawVal, record);
            } catch (err) {
              issues.push({
                path: [key],
                message: err instanceof Error ? err.message : String(err),
              });
            }
            continue;
          }

          if (rawVal === null || rawVal === undefined) {
            if (nullableSet.has(key)) {
              output[key] = null;
              continue;
            }
            issues.push({
              path: [key],
              message: `Expected non-null value for "${key}"`,
            });
            continue;
          }

          if (rule === 'bigint') {
            if (typeof rawVal === 'bigint') {
              output[key] = rawVal;
            } else if (typeof rawVal === 'number' && Number.isInteger(rawVal)) {
              output[key] = BigInt(rawVal);
            } else if (typeof rawVal === 'string' && /^-?\d+$/.test(rawVal.trim())) {
              output[key] = BigInt(rawVal.trim());
            } else {
              issues.push({
                path: [key],
                message: `Expected bigint, got ${typeof rawVal}`,
              });
            }
          } else if (typeof rawVal !== rule) {
            issues.push({
              path: [key],
              message: `Expected ${rule}, got ${typeof rawVal}`,
            });
          } else {
            output[key] = rawVal;
          }
        }

        if (issues.length > 0) {
          return { issues };
        }
        return { value: output as T };
      },
    },
  };
}

// ===========================================================================
// 2. Compile-Time Typed SQL Helpers (`createTypedSql<DB>()`)
// ===========================================================================

/**
 * A {@link SqlFragment} carrying compile-time row type `TRow` and an optional
 * runtime {@link StandardSchemaV1} validator (`M19 Item 4`).
 */
export class TypedSqlFragment<TRow = Row> extends SqlFragment {
  /** Phantom type brand for compile-time row inference. */
  readonly __rowType?: TRow;
  readonly schema?: StandardSchemaV1<unknown, TRow>;

  constructor(
    sqlText: string,
    params: unknown[],
    schema?: StandardSchemaV1<unknown, TRow>,
  ) {
    super(sqlText, params);
    this.schema = schema;
  }

  /** Attach a {@link StandardSchemaV1} validator to this typed SQL fragment. */
  withSchema<TNext = Row>(
    nextSchema: StandardSchemaV1<unknown, TNext>,
  ): TypedSqlFragment<TNext> {
    return new TypedSqlFragment<TNext>(this.sql, [...this.params], nextSchema);
  }
}

/**
 * Schema-typed SQL helper returned by {@link createTypedSql} (`M19 Item 4`).
 *
 * Pair with TypeScript interfaces generated by `generateKyselyTypes(db)` or
 * `generateDrizzleSchema(db)` for compile-time checked table/column names and
 * typed `SELECT` / `INSERT` / `UPDATE OR INSERT` fragments without ORM runtime weight.
 */
export interface TypedSqlBuilder<DB extends Record<string, Row>> {
  /** Build an arbitrary `TypedSqlFragment<TRow>` from a tagged template literal. */
  <TRow extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TypedSqlFragment<TRow>;

  /** Safely quote a compile-time checked table name (`K extends keyof DB`). */
  table<K extends keyof DB & string>(tableName: K): RawSql;

  /** Safely quote a compile-time checked column name (`C extends keyof DB[K]`). */
  col<K extends keyof DB & string, C extends keyof DB[K] & string>(
    tableName: K,
    column: C,
    options?: { qualified?: boolean },
  ): RawSql;

  /** Safely quote a list of compile-time checked columns for `SELECT` projections. */
  cols<K extends keyof DB & string, C extends keyof DB[K] & string>(
    tableName: K,
    columns: readonly C[],
    options?: { qualified?: boolean },
  ): RawSql;

  /**
   * Build a typed `SELECT <columns> FROM "<table>" [tail]` fragment whose
   * inferred row type is `DB[K]` (for `'*'`) or `Pick<DB[K], C>`.
   */
  selectFrom<K extends keyof DB & string>(
    tableName: K,
    columns?: '*',
    tail?: SqlFragment,
  ): TypedSqlFragment<DB[K]>;
  selectFrom<K extends keyof DB & string, C extends keyof DB[K] & string>(
    tableName: K,
    columns: readonly C[],
    tail?: SqlFragment,
  ): TypedSqlFragment<Pick<DB[K], C>>;

  /** Build a parameterized `INSERT INTO "<table>" (...) VALUES (?, ...)` fragment. */
  insertInto<K extends keyof DB & string>(
    tableName: K,
    row: Partial<DB[K]>,
  ): TypedSqlFragment<never>;

  /** Build a parameterized Firebird `UPDATE OR INSERT INTO "<table>" (...) VALUES (...) MATCHING (...)` fragment. */
  upsertInto<K extends keyof DB & string>(
    tableName: K,
    row: Partial<DB[K]>,
    matching: ReadonlyArray<keyof DB[K] & string>,
  ): TypedSqlFragment<never>;

  /** Execute a `TypedSqlFragment<TRow>` against the bound database (validating with `fragment.schema` if attached). */
  query<TRow extends Row>(
    fragment: TypedSqlFragment<TRow>,
    options?: QueryOptions<TRow>,
  ): Promise<QueryResult<TRow>>;

  /** Execute a DML/DDL `SqlFragment` against the bound database and return `{ affectedRows, changes }`. */
  execute(
    fragment: SqlFragment,
    options?: StatementExecutionOptions,
  ): Promise<UnifiedExecuteResult>;
}

/**
 * Create a compile-time schema-checked SQL helper (`M19 Item 4`).
 */
export function createTypedSql<DB extends Record<string, Row>>(
  db?: Pick<FirebirdDatabase, 'query' | 'execute'>,
): TypedSqlBuilder<DB> {
  const fn = (<TRow extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TypedSqlFragment<TRow> => {
    const base = sqlTag(strings, ...values);
    return new TypedSqlFragment<TRow>(base.sql, [...base.params]);
  }) as TypedSqlBuilder<DB>;

  fn.table = <K extends keyof DB & string>(tableName: K): RawSql =>
    sqlTag.identifier(tableName);

  fn.col = <K extends keyof DB & string, C extends keyof DB[K] & string>(
    tableName: K,
    column: C,
    options?: { qualified?: boolean },
  ): RawSql => {
    if (options?.qualified) {
      return new RawSql(
        `${sqlTag.identifier(tableName).sql}.${sqlTag.identifier(column).sql}`,
      );
    }
    return sqlTag.identifier(column);
  };

  fn.cols = <K extends keyof DB & string, C extends keyof DB[K] & string>(
    tableName: K,
    columns: readonly C[],
    options?: { qualified?: boolean },
  ): RawSql => {
    if (columns.length === 0) {
      throw new RangeError('cols() requires at least one column name');
    }
    const parts = columns.map((c) => fn.col(tableName, c, options).sql);
    return new RawSql(parts.join(', '));
  };

  fn.selectFrom = (<
    K extends keyof DB & string,
    C extends keyof DB[K] & string,
  >(
    tableName: K,
    columns: '*' | readonly C[] = '*',
    tail?: SqlFragment,
  ): TypedSqlFragment<DB[K] | Pick<DB[K], C>> => {
    const projection =
      columns === '*' ? new RawSql('*') : fn.cols(tableName, columns);
    const base = tail
      ? sqlTag`SELECT ${projection} FROM ${fn.table(tableName)} ${tail}`
      : sqlTag`SELECT ${projection} FROM ${fn.table(tableName)}`;
    return new TypedSqlFragment(base.sql, [...base.params]);
  }) as TypedSqlBuilder<DB>['selectFrom'];

  fn.insertInto = <K extends keyof DB & string>(
    tableName: K,
    row: Partial<DB[K]>,
  ): TypedSqlFragment<never> => {
    const keys = Object.keys(row).filter((k) => row[k as keyof DB[K]] !== undefined);
    if (keys.length === 0) {
      throw new RangeError(`insertInto("${tableName}") requires at least one column`);
    }
    const colList = new RawSql(keys.map((k) => sqlTag.identifier(k).sql).join(', '));
    const vals = keys.map((k) => row[k as keyof DB[K]]);
    const base = sqlTag`INSERT INTO ${fn.table(tableName)} (${colList}) VALUES (${sqlTag.join(vals)})`;
    return new TypedSqlFragment<never>(base.sql, [...base.params]);
  };

  fn.upsertInto = <K extends keyof DB & string>(
    tableName: K,
    row: Partial<DB[K]>,
    matching: ReadonlyArray<keyof DB[K] & string>,
  ): TypedSqlFragment<never> => {
    const keys = Object.keys(row).filter((k) => row[k as keyof DB[K]] !== undefined);
    if (keys.length === 0) {
      throw new RangeError(`upsertInto("${tableName}") requires at least one column`);
    }
    if (matching.length === 0) {
      throw new RangeError(`upsertInto("${tableName}") requires at least one MATCHING key`);
    }
    const colList = new RawSql(keys.map((k) => sqlTag.identifier(k).sql).join(', '));
    const matchList = new RawSql(matching.map((k) => sqlTag.identifier(k).sql).join(', '));
    const vals = keys.map((k) => row[k as keyof DB[K]]);
    const base = sqlTag`UPDATE OR INSERT INTO ${fn.table(tableName)} (${colList}) VALUES (${sqlTag.join(vals)}) MATCHING (${matchList})`;
    return new TypedSqlFragment<never>(base.sql, [...base.params]);
  };

  fn.query = async <TRow extends Row>(
    fragment: TypedSqlFragment<TRow>,
    options?: QueryOptions<TRow>,
  ): Promise<QueryResult<TRow>> => {
    if (!db) {
      throw new Error(
        'createTypedSql() was created without a bound `db` instance; pass `fragment` to `db.query(fragment)` or pass `db` to `createTypedSql(db)`',
      );
    }
    const mergedOptions: QueryOptions<TRow> = {
      ...options,
      ...(options?.schema === undefined && fragment.schema !== undefined
        ? { schema: fragment.schema }
        : {}),
    };
    return db.query<TRow>(fragment, mergedOptions);
  };

  fn.execute = async (
    fragment: SqlFragment,
    options?: StatementExecutionOptions,
  ): Promise<UnifiedExecuteResult> => {
    if (!db) {
      throw new Error(
        'createTypedSql() was created without a bound `db` instance; pass `fragment` to `db.execute(fragment)` or pass `db` to `createTypedSql(db)`',
      );
    }
    return db.execute(fragment, undefined, options);
  };

  return fn;
}
