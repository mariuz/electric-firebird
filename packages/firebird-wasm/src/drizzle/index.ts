/**
 * firebird-wasm/drizzle – a Drizzle ORM driver & dialect for `FirebirdBrowser`
 * and `FirebirdLite`.
 *
 * ```ts
 * import {
 *   drizzle,
 *   firebirdTable,
 *   integer,
 *   varchar,
 *   boolean,
 *   eq,
 * } from 'firebird-wasm/drizzle';
 *
 * const items = firebirdTable('items', {
 *   id: integer('id').primaryKey(),
 *   title: varchar('title', { length: 80 }).notNull(),
 *   done: boolean('done').default(false),
 * });
 *
 * const db = drizzle(fb, { schema: { items } });
 *
 * await db.insert(items).values({ id: 1, title: 'Ship Drizzle driver', done: false });
 * const open = await db.select().from(items).where(eq(items.done, false)).limit(10).offset(0);
 * ```
 *
 * Translates Drizzle's SQL AST to Firebird 3+ SQL:
 * - `?` positional parameter placeholders;
 * - `OFFSET ? ROWS FETCH NEXT ? ROWS ONLY` pagination;
 * - `INSERT / UPDATE / DELETE … RETURNING` (decoded positionally via `rowMode: 'array'`);
 * - multi-row `INSERT INTO … SELECT … FROM RDB$DATABASE UNION ALL …`;
 * - `UPDATE OR INSERT INTO … MATCHING (…)` on `.onConflictDoUpdate({ target })`;
 * - `db.$count(table, where)` with quoted `"COUNT"` alias;
 * - `db.transaction()` mapped onto Firebird isolation levels, plus nested savepoints;
 * - bijective identifier folding (`items` ↔ `"ITEMS"`, while `"camelCase"` stays `"camelCase"`).
 */

import {
  Column,
  DefaultLogger,
  NoopLogger,
  Param,
  SQL,
  Subquery,
  createTableRelationsHelpers,
  entityKind,
  extractTablesRelationalConfig,
  fillPlaceholders,
  getTableColumns,
  getTableName,
  is,
  sql,
} from 'drizzle-orm';
import type {
  Casing,
  DrizzleConfig,
  ExtractTablesWithRelations,
  Logger,
  Query,
  QueryWithTypings,
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from 'drizzle-orm';
import {
  PgDatabase,
  PgDialect,
  PgPreparedQuery,
  PgSession,
  PgTransaction,
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  date,
  doublePrecision,
  integer,
  json,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  smallint,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  PgInsertConfig,
  PgQueryResultHKT,
  PgSelectConfig,
  PgTransactionConfig,
  PreparedQueryConfig,
  SelectedFieldsOrdered,
} from 'drizzle-orm/pg-core';
import type {
  ArrayRow,
  FieldInfo,
  QueryParams,
  QueryResult as FbQueryResult,
  Row,
  TransactionOptions,
} from '../types';

export {
  pgTable,
  pgTable as firebirdTable,
  integer,
  smallint,
  bigint,
  serial,
  bigserial,
  text,
  varchar,
  char,
  boolean,
  real,
  doublePrecision,
  numeric,
  date,
  time,
  timestamp,
  json,
  jsonb,
  uuid,
  customType,
};

export {
  sql,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  like,
  ilike,
  between,
  asc,
  desc,
  count,
  sum,
  avg,
  min,
  max,
  relations,
} from 'drizzle-orm';

/**
 * How identifiers and raw result column keys are cased between Drizzle and Firebird.
 *
 * - `'lower'` (default): all-lowercase SQL identifiers (`items`, `user_id`) are folded to
 *   uppercase (`"ITEMS"`, `"USER_ID"`) to match Firebird's unquoted DDL, and all-uppercase
 *   raw result column names (`ID`, `USER_ID`) are folded back to lowercase (`id`, `user_id`).
 * - `'preserve'`: identifiers in SQL and raw result row keys are kept with their exact casing.
 */
export type FirebirdIdentifierCase = 'lower' | 'preserve';

/** Transaction handle accepted by {@link FirebirdDrizzleSession}. */
export interface FirebirdDrizzleTransactionClient {
  query(
    sql: string,
    params: QueryParams | undefined,
    options: { rowMode: 'array' },
  ): Promise<FbQueryResult<ArrayRow>>;
  query<T = Row>(
    sql: string,
    params?: QueryParams,
    options?: { rowMode?: 'object' | 'array' },
  ): Promise<FbQueryResult<T>>;
  exec(sql: string, params?: QueryParams): Promise<unknown>;
  rollback(): Promise<void>;
}

/** Database instance (`FirebirdBrowser` or `FirebirdLite`) accepted by {@link drizzle}. */
export interface FirebirdDrizzleClient extends Omit<FirebirdDrizzleTransactionClient, 'rollback'> {
  transaction<T>(
    fn: (tx: FirebirdDrizzleTransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

/** Configuration accepted by {@link drizzle}. */
export interface FirebirdDrizzleConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends DrizzleConfig<TSchema> {
  /**
   * Identifier casing strategy between Drizzle and Firebird.
   * @default 'lower'
   */
  identifierCase?: FirebirdIdentifierCase;
}

/** Result returned by raw `db.execute(sql\`...\`)` or non-returning DML. */
export interface FirebirdDrizzleQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  fields: FieldInfo[];
  affectedRows?: number;
}

export interface FirebirdDrizzleQueryResultHKT extends PgQueryResultHKT {
  type: FirebirdDrizzleQueryResult<this['row']>;
}

/** Options for {@link FirebirdDrizzleDialect}. */
export interface FirebirdDrizzleDialectConfig {
  casing?: Casing;
  identifierCase?: FirebirdIdentifierCase;
}

/**
 * Drizzle SQL dialect for Firebird 3+.
 *
 * Extends `PgDialect` (since both dialects share standard SQL quoting, `RETURNING`,
 * CTEs, window functions, and positional `rowMode: 'array'` result mapping) while
 * emitting `?` parameter placeholders, `OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
 * multi-row `INSERT INTO … SELECT … FROM RDB$DATABASE UNION ALL …`, and
 * `UPDATE OR INSERT INTO … MATCHING (…)`.
 */
export class FirebirdDrizzleDialect extends PgDialect {
  static override readonly [entityKind]: string = 'FirebirdDrizzleDialect';
  readonly identifierCase: FirebirdIdentifierCase;

  constructor(config?: FirebirdDrizzleDialectConfig) {
    super(config);
    this.identifierCase = config?.identifierCase ?? 'lower';
    this.escapeName = this.escapeName.bind(this);
    this.escapeParam = this.escapeParam.bind(this);
  }

  override escapeName(name: string): string {
    const mapped =
      this.identifierCase === 'lower' && /^[a-z_][a-z0-9_$]*$/.test(name)
        ? name.toUpperCase()
        : name;
    return `"${mapped.replace(/"/g, '""')}"`;
  }

  override escapeParam(_num: number): string {
    return '?';
  }

  override buildSelectQuery(config: PgSelectConfig): SQL {
    const { limit, offset, lockingClause, setOperators } = config;
    const hasLimit =
      typeof limit === 'object' || (typeof limit === 'number' && limit >= 0);
    const hasOffset = offset !== undefined;

    if (!hasLimit && !hasOffset) {
      return super.buildSelectQuery(config);
    }

    const base = super.buildSelectQuery({
      ...config,
      limit: undefined,
      offset: undefined,
      lockingClause: undefined,
      setOperators: [],
    });

    // Firebird SQL:2008 order: OFFSET <n> ROWS FETCH NEXT <m> ROWS ONLY
    if (hasOffset) {
      base.append(sql` offset ${offset} rows`);
    }
    if (hasLimit) {
      base.append(sql` fetch next ${limit} rows only`);
    }
    if (lockingClause) {
      base.append(sql` for ${sql.raw(lockingClause.strength)}`);
      if (lockingClause.config.noWait) {
        base.append(sql` with lock`);
      }
    }
    if (setOperators.length > 0) {
      return this.buildSetOperations(base, setOperators);
    }
    return base;
  }

  override buildSetOperationQuery({
    leftSelect,
    setOperator,
  }: {
    leftSelect: SQL;
    setOperator: PgSelectConfig['setOperators'][number];
  }): SQL {
    const { limit, offset } = setOperator;
    const hasLimit =
      typeof limit === 'object' || (typeof limit === 'number' && limit >= 0);
    const hasOffset = offset !== undefined;
    if (!hasLimit && !hasOffset) {
      return super.buildSetOperationQuery({ leftSelect, setOperator });
    }
    const base = super.buildSetOperationQuery({
      leftSelect,
      setOperator: { ...setOperator, limit: undefined, offset: undefined },
    });
    if (hasOffset) {
      base.append(sql` offset ${offset} rows`);
    }
    if (hasLimit) {
      base.append(sql` fetch next ${limit} rows only`);
    }
    return base;
  }

  override buildInsertQuery({
    table,
    values: valuesOrSelect,
    onConflict,
    returning,
    withList,
    select,
    overridingSystemValue_,
  }: PgInsertConfig): SQL {
    if (select) {
      return super.buildInsertQuery({
        table,
        values: valuesOrSelect,
        onConflict,
        returning,
        withList,
        select,
        overridingSystemValue_,
      });
    }

    const columns = getTableColumns(table) as Record<string, Column>;
    const allEntries = Object.entries(columns).filter(
      ([, col]) =>
        !(col as unknown as { shouldDisableInsert?: () => boolean })
          .shouldDisableInsert?.(),
    );
    const values = valuesOrSelect as Record<string, Param | SQL | undefined>[];

    // Keep only columns that are explicitly supplied in `values` or have a runtime
    // `defaultFn` / `onUpdateFn`. This lets omitted identity / default columns use
    // Firebird's column defaults cleanly in both single-row and multi-row inserts.
    const activeEntries = allEntries.filter(([fieldName, col]) => {
      if (col.defaultFn !== undefined) return true;
      if (!col.default && col.onUpdateFn !== undefined) return true;
      return values.some((row) => {
        const v = row[fieldName];
        return v !== undefined && !(is(v, Param) && v.value === undefined);
      });
    });

    const internal = this as unknown as {
      casing: { getColumnCasing(col: Column): string };
      buildWithCTE(w: unknown): SQL | undefined;
      buildSelection(
        r: SelectedFieldsOrdered,
        opts: { isSingleTable: boolean },
      ): SQL;
    };
    const withSql = internal.buildWithCTE(withList);
    const returningSql = returning
      ? sql` returning ${internal.buildSelection(returning, { isSingleTable: true })}`
      : undefined;

    if (activeEntries.length === 0) {
      return sql`${withSql}insert into ${table} default values${returningSql}`;
    }

    const insertOrder = activeEntries.map(([, column]) =>
      sql.identifier(internal.casing.getColumnCasing(column)),
    );

    const resolveCell = (
      row: Record<string, Param | SQL | undefined>,
      fieldName: string,
      col: Column,
    ): Param | SQL => {
      const colValue = row[fieldName];
      if (
        colValue === undefined ||
        (is(colValue, Param) && colValue.value === undefined)
      ) {
        if (col.defaultFn !== undefined) {
          const fnRes = col.defaultFn();
          return is(fnRes, SQL) ? fnRes : sql.param(fnRes, col);
        }
        if (!col.default && col.onUpdateFn !== undefined) {
          const fnRes = col.onUpdateFn();
          return is(fnRes, SQL) ? fnRes : sql.param(fnRes, col);
        }
        return sql.param(null, col);
      }
      return colValue;
    };

    // Check if onConflict is an upsert (`(<cols>) ... do update set ...`)
    if (onConflict) {
      const conflictQuery = this.sqlToQuery(onConflict);
      const match = /^\(([^)]+)\)\s+do\s+update\s+set\b/i.exec(
        conflictQuery.sql.trim(),
      );
      if (match && values.length === 1) {
        const targetCols = match[1]!;
        const rowCells = activeEntries.map(([fieldName, col]) =>
          resolveCell(values[0]!, fieldName, col),
        );
        return sql`${withSql}update or insert into ${table} ${insertOrder} values (${sql.join(rowCells, sql`, `)}) matching (${sql.raw(targetCols)})${returningSql}`;
      }
    }

    const overridingSql =
      overridingSystemValue_ === true ? sql`overriding system value ` : undefined;

    if (values.length === 1) {
      const rowCells = activeEntries.map(([fieldName, col]) =>
        resolveCell(values[0]!, fieldName, col),
      );
      const onConflictSql = onConflict ? sql` on conflict ${onConflict}` : undefined;
      return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}values (${sql.join(rowCells, sql`, `)})${onConflictSql}${returningSql}`;
    }

    // Multi-row insert via SELECT ... FROM RDB$DATABASE UNION ALL ...
    const selects = values.map((row) => {
      const rowCells = activeEntries.map(([fieldName, col]) =>
        resolveCell(row, fieldName, col),
      );
      return sql`select ${sql.join(rowCells, sql`, `)} from rdb$database`;
    });
    return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}${sql.join(selects, sql` union all `)}${returningSql}`;
  }

  override sqlToQuery(sqlNode: SQL, invokeSource?: 'indexes' | undefined): QueryWithTypings {
    const query = super.sqlToQuery(sqlNode, invokeSource);
    // PgCountBuilder generates `select count(*) as count from ...;`.
    // In Firebird, COUNT is a reserved word and must be quoted as an alias.
    if (/^select count\(\*\) as count from /i.test(query.sql)) {
      query.sql = query.sql
        .replace(/^select count\(\*\) as count from /i, 'select count(*) as "COUNT" from ')
        .replace(/;\s*$/, '');
    }
    return query;
  }
}

/**
 * Prepared query execution against `FirebirdBrowser` or `FirebirdLite`.
 */
export class FirebirdDrizzlePreparedQuery<
  T extends PreparedQueryConfig = PreparedQueryConfig,
> extends PgPreparedQuery<T> {
  static override readonly [entityKind]: string = 'FirebirdDrizzlePreparedQuery';

  readonly #client: FirebirdDrizzleClient | FirebirdDrizzleTransactionClient;
  readonly #queryString: string;
  readonly #params: unknown[];
  readonly #logger: Logger;
  readonly #fields: SelectedFieldsOrdered | undefined;
  readonly #isResponseInArrayMode: boolean;
  readonly #customResultMapper: ((rows: unknown[][]) => T['execute']) | undefined;
  readonly #queryMetadata:
    | { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }
    | undefined;
  readonly #identifierCase: FirebirdIdentifierCase;

  constructor(
    client: FirebirdDrizzleClient | FirebirdDrizzleTransactionClient,
    queryString: string,
    params: unknown[],
    logger: Logger,
    fields: SelectedFieldsOrdered | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper: ((rows: unknown[][]) => T['execute']) | undefined,
    queryMetadata:
      | { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }
      | undefined,
    identifierCase: FirebirdIdentifierCase,
  ) {
    super({ sql: queryString, params }, undefined, queryMetadata, undefined);
    this.#client = client;
    this.#queryString = queryString;
    this.#params = params;
    this.#logger = logger;
    this.#fields = fields;
    this.#isResponseInArrayMode = isResponseInArrayMode;
    this.#customResultMapper = customResultMapper;
    this.#queryMetadata = queryMetadata;
    this.#identifierCase = identifierCase;
  }

  async execute(
    placeholderValues: Record<string, unknown> = {},
  ): Promise<T['execute']> {
    const params = normalizeParams(fillPlaceholders(this.#params, placeholderValues));
    this.#logger.logQuery(this.#queryString, params);

    const fields = this.#fields;
    const customResultMapper = this.#customResultMapper;
    const joinsNotNullableMap = (
      this as unknown as { joinsNotNullableMap?: Record<string, boolean> }
    ).joinsNotNullableMap;

    if (!fields && !customResultMapper) {
      const isDmlWithoutReturning =
        this.#queryMetadata?.type === 'insert' ||
        this.#queryMetadata?.type === 'update' ||
        this.#queryMetadata?.type === 'delete' ||
        (/^\s*(insert|update|delete|create|alter|drop|recreate)\b/i.test(
          this.#queryString,
        ) &&
          !/\breturning\b/i.test(this.#queryString));

      if (isDmlWithoutReturning) {
        const res = await this.#client.exec(this.#queryString, params);
        return {
          rows: [],
          fields: [],
          affectedRows: extractAffectedRows(res),
        } as T['execute'];
      }

      const raw = await this.#client.query<Record<string, unknown>>(
        this.#queryString,
        params,
        { rowMode: 'object' },
      );
      return {
        rows: mapObjectRows(raw.rows, this.#identifierCase),
        fields: raw.fields,
      } as T['execute'];
    }

    const result = await this.#client.query(this.#queryString, params, {
      rowMode: 'array',
    });

    if (customResultMapper) {
      return customResultMapper(result.rows as unknown[][]);
    }

    return result.rows.map((row) =>
      mapDrizzleResultRow<T['execute']>(
        fields!,
        row as unknown[],
        joinsNotNullableMap,
      ),
    );
  }

  async all(placeholderValues: Record<string, unknown> = {}): Promise<T['all']> {
    const params = normalizeParams(fillPlaceholders(this.#params, placeholderValues));
    this.#logger.logQuery(this.#queryString, params);
    const result = await this.#client.query<Record<string, unknown>>(
      this.#queryString,
      params,
      { rowMode: 'object' },
    );
    return mapObjectRows(result.rows, this.#identifierCase) as T['all'];
  }

  /** @internal */
  isResponseInArrayMode(): boolean {
    return this.#isResponseInArrayMode;
  }
}

export interface FirebirdDrizzleSessionOptions {
  logger?: Logger;
  identifierCase?: FirebirdIdentifierCase;
}

/**
 * Drizzle session wrapping a `FirebirdBrowser`, `FirebirdLite`, or active transaction.
 */
export class FirebirdDrizzleSession<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends TablesRelationalConfig = Record<string, never>,
> extends PgSession<FirebirdDrizzleQueryResultHKT, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'FirebirdDrizzleSession';

  readonly #client: FirebirdDrizzleClient | FirebirdDrizzleTransactionClient;
  readonly #dialect: PgDialect;
  readonly #schema: RelationalSchemaConfig<TSchema> | undefined;
  readonly #options: FirebirdDrizzleSessionOptions;
  readonly #logger: Logger;
  readonly #identifierCase: FirebirdIdentifierCase;

  constructor(
    client: FirebirdDrizzleClient | FirebirdDrizzleTransactionClient,
    dialect: PgDialect,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: FirebirdDrizzleSessionOptions = {},
  ) {
    super(dialect);
    this.#client = client;
    this.#dialect = dialect;
    this.#schema = schema;
    this.#options = options;
    this.#logger = options.logger ?? new NoopLogger();
    this.#identifierCase = options.identifierCase ?? 'lower';
  }

  override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => T['execute'],
    queryMetadata?: {
      type: 'select' | 'update' | 'delete' | 'insert';
      tables: string[];
    },
  ): PgPreparedQuery<T> {
    return new FirebirdDrizzlePreparedQuery<T>(
      this.#client,
      query.sql,
      query.params,
      this.#logger,
      fields,
      isResponseInArrayMode,
      customResultMapper,
      queryMetadata,
      this.#identifierCase,
    );
  }

  override async transaction<T>(
    transaction: (tx: FirebirdDrizzleTransaction<TFullSchema, TSchema>) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    if (!('transaction' in this.#client)) {
      throw new Error('Cannot start a root transaction on a transaction client');
    }
    return this.#client.transaction(async (txClient) => {
      const session = new FirebirdDrizzleSession<TFullSchema, TSchema>(
        txClient,
        this.#dialect,
        this.#schema,
        this.#options,
      );
      const tx = new FirebirdDrizzleTransaction<TFullSchema, TSchema>(
        this.#dialect,
        session,
        this.#schema,
      );
      return transaction(tx);
    }, mapDrizzleTransactionConfig(config));
  }

  override async count(countSql: SQL): Promise<number> {
    const res = await this.execute<{ rows: Array<Record<string, unknown>> }>(countSql);
    const first = res.rows[0] ?? {};
    const val = first['count'] ?? first['COUNT'] ?? Object.values(first)[0] ?? 0;
    return Number(val);
  }
}

/**
 * Drizzle transaction over a Firebird transaction, with nested savepoints.
 */
export class FirebirdDrizzleTransaction<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends TablesRelationalConfig = Record<string, never>,
> extends PgTransaction<FirebirdDrizzleQueryResultHKT, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'FirebirdDrizzleTransaction';

  readonly #txDialect: PgDialect;
  readonly #txSession: PgSession<FirebirdDrizzleQueryResultHKT, TFullSchema, TSchema>;

  constructor(
    dialect: PgDialect,
    session: PgSession<FirebirdDrizzleQueryResultHKT, TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex = 0,
  ) {
    super(dialect, session, schema, nestedIndex);
    this.#txDialect = dialect;
    this.#txSession = session;
  }

  override async transaction<T>(
    transaction: (tx: FirebirdDrizzleTransaction<TFullSchema, TSchema>) => Promise<T>,
  ): Promise<T> {
    const savepointName = `sp${this.nestedIndex + 1}`;
    const tx = new FirebirdDrizzleTransaction<TFullSchema, TSchema>(
      this.#txDialect,
      this.#txSession,
      this.schema,
      this.nestedIndex + 1,
    );
    await tx.execute(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = await transaction(tx);
      await tx.execute(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (err) {
      await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
      throw err;
    }
  }
}

/**
 * Drizzle database instance backed by `FirebirdBrowser` or `FirebirdLite`.
 */
export class FirebirdDrizzleDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends PgDatabase<FirebirdDrizzleQueryResultHKT, TSchema> {
  static override readonly [entityKind]: string = 'FirebirdDrizzleDatabase';
}

/**
 * Create a Drizzle ORM database instance over a `FirebirdBrowser` or `FirebirdLite` client.
 */
export function drizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TClient extends FirebirdDrizzleClient = FirebirdDrizzleClient,
>(
  clientOrConfig:
    | TClient
    | (FirebirdDrizzleConfig<TSchema> & { client: TClient }),
  config?: FirebirdDrizzleConfig<TSchema>,
): FirebirdDrizzleDatabase<TSchema> & { $client: TClient } {
  let client: TClient;
  let resolvedConfig: FirebirdDrizzleConfig<TSchema>;

  if (
    typeof clientOrConfig === 'object' &&
    clientOrConfig !== null &&
    'client' in clientOrConfig &&
    typeof (clientOrConfig as { query?: unknown }).query !== 'function'
  ) {
    const { client: c, ...rest } = clientOrConfig;
    client = c;
    resolvedConfig = rest;
  } else {
    client = clientOrConfig as TClient;
    resolvedConfig = config ?? {};
  }

  const identifierCase = resolvedConfig.identifierCase ?? 'lower';
  const dialect = new FirebirdDrizzleDialect({
    casing: resolvedConfig.casing,
    identifierCase,
  });

  let logger: Logger | undefined;
  if (resolvedConfig.logger === true) {
    logger = new DefaultLogger();
  } else if (resolvedConfig.logger !== false) {
    logger = resolvedConfig.logger;
  }

  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  if (resolvedConfig.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      resolvedConfig.schema,
      createTableRelationsHelpers,
    );
    schema = {
      fullSchema: resolvedConfig.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const session = new FirebirdDrizzleSession(
    client,
    dialect,
    schema,
    { logger, identifierCase },
  );
  const db = new FirebirdDrizzleDatabase<TSchema>(
    dialect,
    session,
    schema as unknown as RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined,
  ) as FirebirdDrizzleDatabase<TSchema> & { $client: TClient };
  db.$client = client;
  return db;
}

/**
 * Map a positional row (`rowMode: 'array'`) into Drizzle's nested object shape
 * using each selected column/expression's `mapFromDriverValue` decoder.
 */
function mapDrizzleResultRow<TResult>(
  columns: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap?: Record<string, boolean>,
): TResult {
  const nullifyMap: Record<string, string | false> = {};
  const result = columns.reduce<Record<string, unknown>>(
    (acc, { path, field }, columnIndex) => {
      let decoder: { mapFromDriverValue(value: unknown): unknown };
      if (is(field, Column)) {
        decoder = field;
      } else if (is(field, SQL)) {
        decoder = (field as unknown as { decoder: typeof decoder }).decoder;
      } else if (is(field, Subquery)) {
        decoder = (
          field as unknown as { _: { sql: { decoder: typeof decoder } } }
        )._.sql.decoder;
      } else {
        decoder = (field as unknown as { sql: { decoder: typeof decoder } }).sql
          .decoder;
      }
      let node = acc;
      for (const [pathChunkIndex, pathChunk] of path.entries()) {
        if (pathChunkIndex < path.length - 1) {
          if (!(pathChunk in node)) {
            node[pathChunk] = {};
          }
          node = node[pathChunk] as Record<string, unknown>;
        } else {
          const rawValue = row[columnIndex];
          const value = (node[pathChunk] =
            rawValue === null || rawValue === undefined
              ? null
              : decoder.mapFromDriverValue(rawValue));
          if (joinsNotNullableMap && is(field, Column) && path.length === 2) {
            const objectName = path[0]!;
            if (!(objectName in nullifyMap)) {
              nullifyMap[objectName] =
                value === null ? getTableName(field.table) : false;
            } else if (
              typeof nullifyMap[objectName] === 'string' &&
              nullifyMap[objectName] !== getTableName(field.table)
            ) {
              nullifyMap[objectName] = false;
            }
          }
        }
      }
      return acc;
    },
    {},
  );
  if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
    for (const [objectName, tableName] of Object.entries(nullifyMap)) {
      if (typeof tableName === 'string' && !joinsNotNullableMap[tableName]) {
        result[objectName] = null;
      }
    }
  }
  return result as TResult;
}

/**
 * Convert Drizzle's `Date.toISOString()` (`YYYY-MM-DDTHH:mm:ss.sssZ`) parameter
 * strings to Firebird's `YYYY-MM-DD HH:mm:ss.sss` timestamp literal format.
 */
function normalizeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (
      typeof p === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(p)
    ) {
      return p.replace('T', ' ').replace(/Z$/, '');
    }
    return p;
  });
}

function mapObjectRows(
  rows: Record<string, unknown>[],
  mode: FirebirdIdentifierCase,
): Record<string, unknown>[] {
  if (mode === 'preserve' || rows.length === 0) {
    return rows;
  }
  const first = rows[0]!;
  const keys = Object.keys(first);
  const mappedKeys = keys.map((k) =>
    /^[A-Z_][A-Z0-9_$]*$/.test(k) ? k.toLowerCase() : k,
  );
  if (keys.every((k, i) => k === mappedKeys[i])) {
    return rows;
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      out[mappedKeys[i]!] = row[keys[i]!];
    }
    return out;
  });
}

function mapDrizzleTransactionConfig(
  config?: PgTransactionConfig,
): TransactionOptions | undefined {
  if (!config) return undefined;
  const options: TransactionOptions = {};
  if (config.accessMode === 'read only') {
    options.readOnly = true;
  }
  switch (config.isolationLevel) {
    case 'read uncommitted':
    case 'read committed':
      options.isolationLevel = 'READ_COMMITTED';
      break;
    case 'repeatable read':
      options.isolationLevel = 'SNAPSHOT';
      break;
    case 'serializable':
      options.isolationLevel = 'SNAPSHOT_TABLE_STABILITY';
      break;
  }
  return options;
}

function extractAffectedRows(res: unknown): number | undefined {
  if (typeof res === 'object' && res !== null && 'affectedRows' in res) {
    const n = (res as { affectedRows?: number }).affectedRows;
    return typeof n === 'number' ? n : undefined;
  }
  if (Array.isArray(res)) {
    let total = 0;
    for (const item of res) {
      if (typeof item === 'object' && item !== null && 'affectedRows' in item) {
        total += Number((item as { affectedRows?: number }).affectedRows ?? 0);
      }
    }
    return total;
  }
  return undefined;
}
