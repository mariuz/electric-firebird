/**
 * schema-sync.ts – Declarative Schema Diff & Push (`syncDatabaseSchema`) (`M25 Item 4`).
 *
 * Compares a desired schema (a live `FirebirdBrowser`/`FirebirdLite`, a pre-captured
 * `SchemaIntrospection`, or a raw Firebird SQL DDL script string) against a target
 * database, generates ordered forward/rollback DDL via `diffSchema` + `generateMigration`,
 * guards against accidental `DROP TABLE` / column-drop statements unless
 * `allowDestructive: true`, and optionally applies the DDL in-place.
 */

import type {
  IntrospectOptions,
  MigrationExecutor,
  QueryParams,
  SchemaIntrospection,
} from './types';
import { FirebirdBrowser } from './browser/firebird-browser';
import { introspect } from './browser/schema';
import {
  generateMigration,
  type GeneratedMigration,
  type SchemaDiff,
  type SchemaDiffSource,
} from './browser/schema-diff';
import { splitStatements } from './browser/sql-script';

export type DeclarativeSchemaInput = SchemaDiffSource | SchemaSyncTarget | string;

export interface SchemaSyncTarget {
  query: MigrationExecutor['query'];
  introspect?(options?: IntrospectOptions): Promise<SchemaIntrospection>;
  execute?(sql: string, params?: QueryParams): Promise<unknown>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

export interface SyncDatabaseSchemaOptions {
  /** Compute the DDL diff & plan without executing any statements on `targetDb`. @default false */
  dryRun?: boolean;
  /** Allow destructive `DROP TABLE` and `ALTER TABLE ... DROP <column>` statements. @default false */
  allowDestructive?: boolean;
  /** Quote SQL identifiers in generated DDL. @default false */
  quoteIdentifiers?: boolean;
  /** Optional `introspect()` filter options. */
  introspectOptions?: IntrospectOptions;
  /** Optional custom migration name. */
  name?: string;
}

export interface SchemaSyncResult {
  /** `true` if DDL statements were executed on `targetDb` (`false` when `dryRun: true` or no changes). */
  readonly applied: boolean;
  /** `true` if `dryRun: true` was passed. */
  readonly dryRun: boolean;
  /** Number of DDL statements executed on `targetDb`. */
  readonly statementsExecuted: number;
  /** `true` if the computed diff removes any existing tables or columns. */
  readonly hasDestructiveChanges: boolean;
  /** Destructive DDL statements (`DROP TABLE` or column drops) detected in the forward plan. */
  readonly destructiveStatements: readonly string[];
  /** Ordered forward DDL statements transforming `targetDb` to match `desiredSource`. */
  readonly statements: readonly string[];
  /** Semicolon-delimited forward SQL script. */
  readonly sql: string;
  /** Structured `SchemaDiff` inspection object. */
  readonly diff: SchemaDiff;
  /** Full `GeneratedMigration` (`up`, `down`, `upSql`, `downSql`). */
  readonly migration: GeneratedMigration;
}

/**
 * Error thrown by {@link syncDatabaseSchema} when a schema push would drop tables or
 * columns on `targetDb` and `allowDestructive: true` was not explicitly supplied.
 */
export class DestructiveSchemaSyncError extends Error {
  readonly code = 'DESTRUCTIVE_SCHEMA_CHANGE' as const;
  readonly destructiveStatements: readonly string[];
  readonly diff: SchemaDiff;

  constructor(destructiveStatements: readonly string[], diff: SchemaDiff) {
    super(
      `Refusing to apply ${destructiveStatements.length} destructive DDL statement(s) ` +
        `(${destructiveStatements.join('; ')}) without allowDestructive: true`,
    );
    this.name = 'DestructiveSchemaSyncError';
    this.destructiveStatements = destructiveStatements;
    this.diff = diff;
  }
}

let scratchCounter = 0;

/**
 * Materialize a raw Firebird SQL DDL script inside an ephemeral in-memory WASM
 * database and return its introspected `SchemaIntrospection` (`M25 Item 4`).
 */
export async function introspectSqlScript(
  ddlScript: string,
  options?: IntrospectOptions,
): Promise<SchemaIntrospection> {
  scratchCounter += 1;
  const scratchDb = new FirebirdBrowser(
    `memory://fb_schema_scratch_${Date.now()}_${scratchCounter}`,
    { threads: false },
  );
  try {
    const stmts = splitStatements(ddlScript);
    for (const stmt of stmts) {
      const sql = stmt.sql.trim();
      if (!sql) continue;
      await scratchDb.execute(sql);
    }
    return await introspect(scratchDb, options);
  } finally {
    await scratchDb.close();
  }
}

async function resolveDeclarativeSchema(
  input: DeclarativeSchemaInput,
  options?: IntrospectOptions,
): Promise<SchemaIntrospection> {
  if (typeof input === 'string') {
    return introspectSqlScript(input, options);
  }
  if (
    Boolean(input) &&
    typeof input === 'object' &&
    Array.isArray((input as SchemaIntrospection).tables) &&
    Array.isArray((input as SchemaIntrospection).columns)
  ) {
    return input as SchemaIntrospection;
  }
  if (typeof (input as { introspect?: unknown }).introspect === 'function') {
    return (
      input as { introspect(opts?: IntrospectOptions): Promise<SchemaIntrospection> }
    ).introspect(options);
  }
  const qTarget = input as SchemaSyncTarget;
  return introspect(
    {
      query: (sql, params) => qTarget.query(sql, params),
      exec: async (sql, params) => {
        await runTargetDdl(qTarget, sql);
        return params;
      },
    },
    options,
  );
}

function collectDestructiveStatements(
  upStatements: readonly string[],
  diff: SchemaDiff,
): string[] {
  const out: string[] = [];
  const hasColumnDrops = diff.removedColumns.length > 0;
  const hasTableDrops = diff.removedTables.length > 0;

  for (const stmt of upStatements) {
    const trimmed = stmt.trim();
    if (/^DROP\s+TABLE\b/i.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    if (
      /^ALTER\s+TABLE\s+(?:"[^"]+"|[A-Za-z0-9_$]+)\s+DROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b)/i.test(
        trimmed,
      )
    ) {
      out.push(trimmed);
    }
  }

  if (out.length === 0 && (hasTableDrops || hasColumnDrops)) {
    for (const t of diff.removedTables) {
      out.push(`DROP TABLE ${t.name}`);
    }
    for (const c of diff.removedColumns) {
      out.push(`ALTER TABLE ${c.tableName} DROP ${c.name}`);
    }
  }

  return out;
}

async function runTargetDdl(targetDb: SchemaSyncTarget, sql: string): Promise<void> {
  if (typeof targetDb.execute === 'function') {
    await targetDb.execute(sql);
  } else if (typeof targetDb.exec === 'function') {
    await targetDb.exec(sql);
  } else {
    await targetDb.query(sql);
  }
}

/**
 * Compute (and optionally apply) the declarative DDL migration needed to bring
 * `targetDb` into alignment with `desiredSource` (`M25 Item 4`).
 *
 * - `desiredSource` may be a live `FirebirdDatabase`, a `SchemaIntrospection`, or
 *   a raw Firebird DDL SQL script string (`CREATE TABLE ...; CREATE INDEX ...;`).
 * - Rejects `DROP TABLE` and `ALTER TABLE ... DROP <col>` statements with
 *   {@link DestructiveSchemaSyncError} unless `options.allowDestructive === true`
 *   (or `options.dryRun === true`).
 */
export async function syncDatabaseSchema(
  desiredSource: DeclarativeSchemaInput,
  targetDb: SchemaSyncTarget,
  options: SyncDatabaseSchemaOptions = {},
): Promise<SchemaSyncResult> {
  const dryRun = options.dryRun === true;
  const allowDestructive = options.allowDestructive === true;

  const [desiredSchema, currentTargetSchema] = await Promise.all([
    resolveDeclarativeSchema(desiredSource, options.introspectOptions),
    resolveDeclarativeSchema(targetDb, options.introspectOptions),
  ]);

  const migration = await generateMigration(currentTargetSchema, desiredSchema, {
    name: options.name ?? 'declarative_schema_sync',
    quoteIdentifiers: options.quoteIdentifiers,
    introspectOptions: options.introspectOptions,
  });

  const destructiveStatements = collectDestructiveStatements(
    migration.up,
    migration.diff,
  );
  const hasDestructiveChanges = destructiveStatements.length > 0;

  if (dryRun || migration.up.length === 0) {
    return {
      applied: false,
      dryRun,
      statementsExecuted: 0,
      hasDestructiveChanges,
      destructiveStatements,
      statements: migration.up,
      sql: migration.upSql,
      diff: migration.diff,
      migration,
    };
  }

  if (hasDestructiveChanges && !allowDestructive) {
    throw new DestructiveSchemaSyncError(destructiveStatements, migration.diff);
  }

  let executed = 0;
  for (const stmt of migration.up) {
    await runTargetDdl(targetDb, stmt);
    executed++;
  }

  return {
    applied: true,
    dryRun: false,
    statementsExecuted: executed,
    hasDestructiveChanges,
    destructiveStatements,
    statements: migration.up,
    sql: migration.upSql,
    diff: migration.diff,
    migration,
  };
}
