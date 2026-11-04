/**
 * schema-diff.ts – Schema Diff & Automatic Migration Generator for Firebird.
 *
 * Compares two `SchemaIntrospection` snapshots (or live database connections)
 * and emits ordered, dependency-safe forward (`up`) and rollback (`down`)
 * Firebird DDL statements as well as a ready-to-run `Migration` object for
 * `migrate()`.
 */

import type {
  ColumnSchemaInfo,
  ForeignKeySchemaInfo,
  IndexSchemaInfo,
  IntrospectOptions,
  Migration,
  MigrationExecutor,
  PrimaryKeySchemaInfo,
  SchemaIntrospection,
  SequenceSchemaInfo,
  TableSchemaInfo,
  TriggerSchemaInfo,
  ViewSchemaInfo,
} from '../types';
import { introspect } from './schema';

/**
 * Any source that can be resolved to a {@link SchemaIntrospection}:
 * - An already-captured `SchemaIntrospection` object
 * - An object with an `.introspect(options?)` method (`FirebirdBrowser` / `FirebirdLite`)
 * - A `MigrationExecutor` with `.query(sql, params?)`
 */
export type SchemaDiffSource =
  | SchemaIntrospection
  | { introspect(options?: IntrospectOptions): Promise<SchemaIntrospection> }
  | MigrationExecutor;

/**
 * Describes how an existing column changed between two schemas.
 */
export interface ColumnModification {
  tableName: string;
  before: ColumnSchemaInfo;
  after: ColumnSchemaInfo;
  typeChanged: boolean;
  nullableChanged: boolean;
  defaultChanged: boolean;
}

/**
 * Structured diff between a source (`from`) and target (`to`) Firebird schema.
 */
export interface SchemaDiff {
  /** `true` if any DDL differences were detected. */
  hasChanges: boolean;
  addedSequences: SequenceSchemaInfo[];
  removedSequences: SequenceSchemaInfo[];
  modifiedSequences: Array<{ before: SequenceSchemaInfo; after: SequenceSchemaInfo }>;
  addedTables: TableSchemaInfo[];
  removedTables: TableSchemaInfo[];
  addedColumns: ColumnSchemaInfo[];
  removedColumns: ColumnSchemaInfo[];
  modifiedColumns: ColumnModification[];
  addedPrimaryKeys: PrimaryKeySchemaInfo[];
  removedPrimaryKeys: PrimaryKeySchemaInfo[];
  addedForeignKeys: ForeignKeySchemaInfo[];
  removedForeignKeys: ForeignKeySchemaInfo[];
  addedIndexes: IndexSchemaInfo[];
  removedIndexes: IndexSchemaInfo[];
  modifiedIndexes: Array<{ before: IndexSchemaInfo; after: IndexSchemaInfo }>;
  addedViews: ViewSchemaInfo[];
  removedViews: ViewSchemaInfo[];
  modifiedViews: Array<{ before: ViewSchemaInfo; after: ViewSchemaInfo }>;
  addedTriggers: TriggerSchemaInfo[];
  removedTriggers: TriggerSchemaInfo[];
  modifiedTriggers: Array<{ before: TriggerSchemaInfo; after: TriggerSchemaInfo }>;
  /** Ordered forward DDL statements transforming `from` into `to`. */
  upStatements: string[];
  /** Ordered rollback DDL statements transforming `to` back into `from`. */
  downStatements: string[];
}

/**
 * Options for {@link diffSchema} and {@link generateMigration}.
 */
export interface GenerateMigrationOptions {
  /** Migration version identifier (default: ISO timestamp or `'001'`). */
  version?: string | number;
  /** Human-readable migration name (default: `'auto_schema_migration'`). */
  name?: string;
  /** Quote SQL identifiers with `"..."` (default: `false` unless identifier requires quoting). */
  quoteIdentifiers?: boolean;
  /** Options forwarded to `introspect()` when a live DB is passed. */
  introspectOptions?: IntrospectOptions;
}

/**
 * A complete {@link Migration} object returned by {@link generateMigration},
 * ready to pass directly to `migrate(db, [migration])`.
 */
export interface GeneratedMigration extends Migration {
  version: string;
  name: string;
  up: string[];
  down: string[];
  /** Combined forward SQL script separated by `;\n`. */
  upSql: string;
  /** Combined rollback SQL script separated by `;\n`. */
  downSql: string;
  /** Underlying structured schema diff. */
  diff: SchemaDiff;
}

function isSchemaIntrospection(val: unknown): val is SchemaIntrospection {
  return (
    Boolean(val) &&
    typeof val === 'object' &&
    Array.isArray((val as SchemaIntrospection).tables) &&
    Array.isArray((val as SchemaIntrospection).columns)
  );
}

async function resolveSchema(
  source: SchemaDiffSource,
  options?: IntrospectOptions,
): Promise<SchemaIntrospection> {
  if (isSchemaIntrospection(source)) {
    return source;
  }
  if (typeof (source as { introspect?: unknown }).introspect === 'function') {
    return (
      source as { introspect(opts?: IntrospectOptions): Promise<SchemaIntrospection> }
    ).introspect(options);
  }
  return introspect(source as MigrationExecutor, options);
}

function fmtIdent(name: string, forceQuote = false): string {
  const trimmed = name.trim();
  if (forceQuote || !/^[A-Z_][A-Z0-9_$]*$/.test(trimmed)) {
    return `"${trimmed.replace(/"/g, '""')}"`;
  }
  return trimmed;
}

function normalizeDefaultExpr(defaultSource: string | null): string | null {
  if (!defaultSource) return null;
  const trimmed = defaultSource.trim();
  if (/^DEFAULT\s+/i.test(trimmed)) {
    return trimmed.replace(/^DEFAULT\s+/i, '').trim();
  }
  return trimmed;
}

function formatColumnDefinition(
  col: ColumnSchemaInfo,
  forceQuote = false,
): string {
  const parts: string[] = [fmtIdent(col.name, forceQuote), col.typeName];
  if (col.isIdentity) {
    parts.push('GENERATED BY DEFAULT AS IDENTITY');
  } else {
    const defExpr = normalizeDefaultExpr(col.defaultSource);
    if (defExpr !== null) {
      parts.push(`DEFAULT ${defExpr}`);
    }
  }
  if (!col.nullable) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
}

function buildCreateTableSql(
  table: TableSchemaInfo,
  forceQuote = false,
): string {
  const lines: string[] = [];
  for (const col of table.columns) {
    lines.push(`  ${formatColumnDefinition(col, forceQuote)}`);
  }
  if (table.primaryKey.length > 0) {
    const pkCols = table.primaryKey.map((c) => fmtIdent(c, forceQuote)).join(', ');
    lines.push(`  PRIMARY KEY (${pkCols})`);
  }
  return `CREATE TABLE ${fmtIdent(table.name, forceQuote)} (\n${lines.join(',\n')}\n)`;
}

function buildAddForeignKeySql(
  fk: ForeignKeySchemaInfo,
  forceQuote = false,
): string {
  const cols = fk.columns.map((c) => fmtIdent(c, forceQuote)).join(', ');
  const refCols = fk.referencedColumns.map((c) => fmtIdent(c, forceQuote)).join(', ');
  let sql =
    `ALTER TABLE ${fmtIdent(fk.tableName, forceQuote)} ` +
    `ADD CONSTRAINT ${fmtIdent(fk.name, forceQuote)} ` +
    `FOREIGN KEY (${cols}) REFERENCES ${fmtIdent(fk.referencedTableName, forceQuote)} (${refCols})`;
  if (fk.onDelete && fk.onDelete.toUpperCase() !== 'RESTRICT' && fk.onDelete.toUpperCase() !== 'NO ACTION') {
    sql += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
  }
  if (fk.onUpdate && fk.onUpdate.toUpperCase() !== 'RESTRICT' && fk.onUpdate.toUpperCase() !== 'NO ACTION') {
    sql += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
  }
  return sql;
}

function buildCreateIndexSql(
  idx: IndexSchemaInfo,
  forceQuote = false,
): string {
  const uniquePart = idx.unique ? 'UNIQUE ' : '';
  const dirPart = idx.descending ? 'DESCENDING ' : '';
  const cols = idx.columns.map((c) => fmtIdent(c, forceQuote)).join(', ');
  return `CREATE ${uniquePart}${dirPart}INDEX ${fmtIdent(idx.name, forceQuote)} ON ${fmtIdent(idx.tableName, forceQuote)} (${cols})`;
}

function buildCreateViewSql(
  view: ViewSchemaInfo,
  forceQuote = false,
): string {
  const cols =
    view.columns.length > 0
      ? ` (${view.columns.map((c) => fmtIdent(c.name, forceQuote)).join(', ')})`
      : '';
  const body = view.source?.trim() || 'SELECT 1 FROM RDB$DATABASE';
  return `CREATE OR ALTER VIEW ${fmtIdent(view.name, forceQuote)}${cols} AS\n${body}`;
}

function buildCreateTriggerSql(
  trg: TriggerSchemaInfo,
  forceQuote = false,
): string {
  const activeWord = trg.inactive ? 'INACTIVE' : 'ACTIVE';
  const eventClause = trg.tableName
    ? `FOR ${fmtIdent(trg.tableName, forceQuote)} ${activeWord} ${trg.timing} ${trg.events.join(' OR ')} POSITION ${trg.sequence}`
    : `${activeWord} ${trg.timing} POSITION ${trg.sequence}`;
  const src = trg.source?.trim() || 'AS BEGIN END';
  const body = /^AS\b/i.test(src) ? src : `AS\n${src}`;
  return `CREATE OR ALTER TRIGGER ${fmtIdent(trg.name, forceQuote)} ${eventClause}\n${body}`;
}

function getConstraintBackingIndexNames(schema: SchemaIntrospection): Set<string> {
  const set = new Set<string>();
  for (const pk of schema.primaryKeys) {
    if (pk.indexName) set.add(pk.indexName.toUpperCase());
    if (pk.constraintName) set.add(pk.constraintName.toUpperCase());
  }
  for (const fk of schema.foreignKeys) {
    if (fk.name) set.add(fk.name.toUpperCase());
  }
  return set;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.toUpperCase() !== b[i]!.toUpperCase()) return false;
  }
  return true;
}

/**
 * Compare two Firebird schemas (`from` and `to`) and return a structured
 * {@link SchemaDiff} containing all detected changes along with ordered
 * forward (`upStatements`) and rollback (`downStatements`) DDL statements.
 */
export async function diffSchema(
  from: SchemaDiffSource,
  to: SchemaDiffSource,
  options: Pick<GenerateMigrationOptions, 'quoteIdentifiers' | 'introspectOptions'> = {},
): Promise<SchemaDiff> {
  const [schemaA, schemaB] = await Promise.all([
    resolveSchema(from, options.introspectOptions),
    resolveSchema(to, options.introspectOptions),
  ]);
  const forceQuote = options.quoteIdentifiers === true;

  // 1. Sequences
  const seqA = new Map(schemaA.sequences.map((s) => [s.name.toUpperCase(), s]));
  const seqB = new Map(schemaB.sequences.map((s) => [s.name.toUpperCase(), s]));
  const addedSequences: SequenceSchemaInfo[] = [];
  const removedSequences: SequenceSchemaInfo[] = [];
  const modifiedSequences: Array<{ before: SequenceSchemaInfo; after: SequenceSchemaInfo }> = [];

  for (const [k, sB] of seqB.entries()) {
    const sA = seqA.get(k);
    if (!sA) {
      addedSequences.push(sB);
    } else if (sA.increment !== sB.increment) {
      modifiedSequences.push({ before: sA, after: sB });
    }
  }
  for (const [k, sA] of seqA.entries()) {
    if (!seqB.has(k)) {
      removedSequences.push(sA);
    }
  }

  // 2. Tables & Columns
  const tablesA = new Map(schemaA.tables.map((t) => [t.name.toUpperCase(), t]));
  const tablesB = new Map(schemaB.tables.map((t) => [t.name.toUpperCase(), t]));
  const addedTables: TableSchemaInfo[] = [];
  const removedTables: TableSchemaInfo[] = [];
  const addedColumns: ColumnSchemaInfo[] = [];
  const removedColumns: ColumnSchemaInfo[] = [];
  const modifiedColumns: ColumnModification[] = [];

  for (const [tKey, tB] of tablesB.entries()) {
    const tA = tablesA.get(tKey);
    if (!tA) {
      addedTables.push(tB);
      continue;
    }

    const colsA = new Map(tA.columns.map((c) => [c.name.toUpperCase(), c]));
    const colsB = new Map(tB.columns.map((c) => [c.name.toUpperCase(), c]));

    for (const [cKey, colB] of colsB.entries()) {
      const colA = colsA.get(cKey);
      if (!colA) {
        addedColumns.push(colB);
      } else {
        const typeChanged = colA.typeName.toUpperCase() !== colB.typeName.toUpperCase();
        const nullableChanged = colA.nullable !== colB.nullable;
        const defA = normalizeDefaultExpr(colA.defaultSource);
        const defB = normalizeDefaultExpr(colB.defaultSource);
        const defaultChanged = defA !== defB;

        if (typeChanged || nullableChanged || defaultChanged) {
          modifiedColumns.push({
            tableName: tB.name,
            before: colA,
            after: colB,
            typeChanged,
            nullableChanged,
            defaultChanged,
          });
        }
      }
    }

    for (const [cKey, colA] of colsA.entries()) {
      if (!colsB.has(cKey)) {
        removedColumns.push(colA);
      }
    }
  }

  for (const [tKey, tA] of tablesA.entries()) {
    if (!tablesB.has(tKey)) {
      removedTables.push(tA);
    }
  }

  // 3. Primary Keys on surviving tables
  const pkMapA = new Map(schemaA.primaryKeys.map((pk) => [pk.tableName.toUpperCase(), pk]));
  const pkMapB = new Map(schemaB.primaryKeys.map((pk) => [pk.tableName.toUpperCase(), pk]));
  const addedPrimaryKeys: PrimaryKeySchemaInfo[] = [];
  const removedPrimaryKeys: PrimaryKeySchemaInfo[] = [];

  for (const [tKey] of tablesB.entries()) {
    if (!tablesA.has(tKey)) continue;
    const pkA = pkMapA.get(tKey);
    const pkB = pkMapB.get(tKey);
    if (!pkA && pkB && pkB.columns.length > 0) {
      addedPrimaryKeys.push(pkB);
    } else if (pkA && (!pkB || pkB.columns.length === 0)) {
      removedPrimaryKeys.push(pkA);
    } else if (pkA && pkB && !sameStringArray(pkA.columns, pkB.columns)) {
      removedPrimaryKeys.push(pkA);
      addedPrimaryKeys.push(pkB);
    }
  }

  // 4. Foreign Keys
  const fkKey = (fk: ForeignKeySchemaInfo) =>
    `${fk.tableName.toUpperCase()}::${fk.name.toUpperCase()}`;
  const fksA = new Map(schemaA.foreignKeys.map((fk) => [fkKey(fk), fk]));
  const fksB = new Map(schemaB.foreignKeys.map((fk) => [fkKey(fk), fk]));
  const addedForeignKeys: ForeignKeySchemaInfo[] = [];
  const removedForeignKeys: ForeignKeySchemaInfo[] = [];

  for (const [k, fkB] of fksB.entries()) {
    const fkA = fksA.get(k);
    if (!fkA) {
      addedForeignKeys.push(fkB);
    } else if (
      fkA.referencedTableName.toUpperCase() !== fkB.referencedTableName.toUpperCase() ||
      !sameStringArray(fkA.columns, fkB.columns) ||
      !sameStringArray(fkA.referencedColumns, fkB.referencedColumns) ||
      fkA.onDelete.toUpperCase() !== fkB.onDelete.toUpperCase() ||
      fkA.onUpdate.toUpperCase() !== fkB.onUpdate.toUpperCase()
    ) {
      removedForeignKeys.push(fkA);
      addedForeignKeys.push(fkB);
    }
  }
  for (const [k, fkA] of fksA.entries()) {
    if (!fksB.has(k)) {
      removedForeignKeys.push(fkA);
    }
  }

  // 5. Standalone Indexes (skip constraint-backing indexes)
  const backingA = getConstraintBackingIndexNames(schemaA);
  const backingB = getConstraintBackingIndexNames(schemaB);
  const idxsA = new Map(
    schemaA.indexes
      .filter((i) => !backingA.has(i.name.toUpperCase()) && !i.name.toUpperCase().startsWith('RDB$'))
      .map((i) => [i.name.toUpperCase(), i]),
  );
  const idxsB = new Map(
    schemaB.indexes
      .filter((i) => !backingB.has(i.name.toUpperCase()) && !i.name.toUpperCase().startsWith('RDB$'))
      .map((i) => [i.name.toUpperCase(), i]),
  );

  const addedIndexes: IndexSchemaInfo[] = [];
  const removedIndexes: IndexSchemaInfo[] = [];
  const modifiedIndexes: Array<{ before: IndexSchemaInfo; after: IndexSchemaInfo }> = [];

  for (const [k, idxB] of idxsB.entries()) {
    const idxA = idxsA.get(k);
    if (!idxA) {
      addedIndexes.push(idxB);
    } else if (
      idxA.tableName.toUpperCase() !== idxB.tableName.toUpperCase() ||
      idxA.unique !== idxB.unique ||
      idxA.descending !== idxB.descending ||
      !sameStringArray(idxA.columns, idxB.columns)
    ) {
      removedIndexes.push(idxA);
      addedIndexes.push(idxB);
    } else if (idxA.inactive !== idxB.inactive) {
      modifiedIndexes.push({ before: idxA, after: idxB });
    }
  }
  for (const [k, idxA] of idxsA.entries()) {
    if (!idxsB.has(k) && tablesB.has(idxA.tableName.toUpperCase())) {
      removedIndexes.push(idxA);
    }
  }

  // 6. Views
  const viewsA = new Map(schemaA.views.map((v) => [v.name.toUpperCase(), v]));
  const viewsB = new Map(schemaB.views.map((v) => [v.name.toUpperCase(), v]));
  const addedViews: ViewSchemaInfo[] = [];
  const removedViews: ViewSchemaInfo[] = [];
  const modifiedViews: Array<{ before: ViewSchemaInfo; after: ViewSchemaInfo }> = [];

  for (const [k, vB] of viewsB.entries()) {
    const vA = viewsA.get(k);
    if (!vA) {
      addedViews.push(vB);
    } else if ((vA.source ?? '').trim() !== (vB.source ?? '').trim()) {
      modifiedViews.push({ before: vA, after: vB });
    }
  }
  for (const [k, vA] of viewsA.entries()) {
    if (!viewsB.has(k)) {
      removedViews.push(vA);
    }
  }

  // 7. Triggers
  const trgsA = new Map(schemaA.triggers.map((t) => [t.name.toUpperCase(), t]));
  const trgsB = new Map(schemaB.triggers.map((t) => [t.name.toUpperCase(), t]));
  const addedTriggers: TriggerSchemaInfo[] = [];
  const removedTriggers: TriggerSchemaInfo[] = [];
  const modifiedTriggers: Array<{ before: TriggerSchemaInfo; after: TriggerSchemaInfo }> = [];

  for (const [k, trB] of trgsB.entries()) {
    const trA = trgsA.get(k);
    if (!trA) {
      addedTriggers.push(trB);
    } else if (
      trA.triggerType !== trB.triggerType ||
      trA.sequence !== trB.sequence ||
      trA.inactive !== trB.inactive ||
      (trA.source ?? '').trim() !== (trB.source ?? '').trim()
    ) {
      modifiedTriggers.push({ before: trA, after: trB });
    }
  }
  for (const [k, trA] of trgsA.entries()) {
    if (
      !trgsB.has(k) &&
      (trA.tableName === null || tablesB.has(trA.tableName.toUpperCase()))
    ) {
      removedTriggers.push(trA);
    }
  }

  // -------------------------------------------------------------------------
  // Assemble ordered UP statements
  // -------------------------------------------------------------------------
  const upStatements: string[] = [];

  // 1. Drop removed triggers, views, FKs, indexes, PKs
  for (const tr of removedTriggers) {
    upStatements.push(`DROP TRIGGER ${fmtIdent(tr.name, forceQuote)}`);
  }
  for (const v of removedViews) {
    upStatements.push(`DROP VIEW ${fmtIdent(v.name, forceQuote)}`);
  }
  const droppedFkKeys = new Set<string>();
  for (const fk of removedForeignKeys) {
    droppedFkKeys.add(fkKey(fk));
    upStatements.push(
      `ALTER TABLE ${fmtIdent(fk.tableName, forceQuote)} DROP CONSTRAINT ${fmtIdent(fk.name, forceQuote)}`,
    );
  }
  for (const t of removedTables) {
    for (const fk of t.foreignKeys) {
      if (droppedFkKeys.has(fkKey(fk))) continue;
      droppedFkKeys.add(fkKey(fk));
      upStatements.push(
        `ALTER TABLE ${fmtIdent(t.name, forceQuote)} DROP CONSTRAINT ${fmtIdent(fk.name, forceQuote)}`,
      );
    }
  }
  for (const idx of removedIndexes) {
    upStatements.push(`DROP INDEX ${fmtIdent(idx.name, forceQuote)}`);
  }
  for (const pk of removedPrimaryKeys) {
    upStatements.push(
      `ALTER TABLE ${fmtIdent(pk.tableName, forceQuote)} DROP CONSTRAINT ${fmtIdent(pk.constraintName, forceQuote)}`,
    );
  }

  // 2. Drop removed columns & removed tables
  for (const col of removedColumns) {
    upStatements.push(
      `ALTER TABLE ${fmtIdent(col.tableName, forceQuote)} DROP ${fmtIdent(col.name, forceQuote)}`,
    );
  }
  for (const t of removedTables) {
    upStatements.push(`DROP TABLE ${fmtIdent(t.name, forceQuote)}`);
  }

  // 3. Create / alter sequences
  for (const seq of addedSequences) {
    let sql = `CREATE SEQUENCE ${fmtIdent(seq.name, forceQuote)}`;
    if (seq.initialValue !== 0) {
      sql += ` START WITH ${seq.initialValue}`;
    }
    if (seq.increment !== 1) {
      sql += ` INCREMENT BY ${seq.increment}`;
    }
    upStatements.push(sql);
  }
  for (const { after } of modifiedSequences) {
    upStatements.push(
      `ALTER SEQUENCE ${fmtIdent(after.name, forceQuote)} INCREMENT BY ${after.increment}`,
    );
  }

  // 4. Create added tables
  for (const t of addedTables) {
    upStatements.push(buildCreateTableSql(t, forceQuote));
  }

  // 5. Add & alter columns on surviving tables
  for (const col of addedColumns) {
    upStatements.push(
      `ALTER TABLE ${fmtIdent(col.tableName, forceQuote)} ADD ${formatColumnDefinition(col, forceQuote)}`,
    );
  }
  for (const mod of modifiedColumns) {
    const tbl = fmtIdent(mod.tableName, forceQuote);
    const col = fmtIdent(mod.after.name, forceQuote);
    if (mod.typeChanged) {
      upStatements.push(
        `ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${mod.after.typeName}`,
      );
    }
    if (mod.defaultChanged) {
      const defB = normalizeDefaultExpr(mod.after.defaultSource);
      if (defB !== null) {
        upStatements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${defB}`);
      } else {
        upStatements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT`);
      }
    }
    if (mod.nullableChanged) {
      if (mod.after.nullable) {
        upStatements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP NOT NULL`);
      } else {
        upStatements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET NOT NULL`);
      }
    }
  }

  // 6. Add PKs, indexes, FKs
  for (const pk of addedPrimaryKeys) {
    const cols = pk.columns.map((c) => fmtIdent(c, forceQuote)).join(', ');
    const constPart = pk.constraintName
      ? `CONSTRAINT ${fmtIdent(pk.constraintName, forceQuote)} `
      : '';
    upStatements.push(
      `ALTER TABLE ${fmtIdent(pk.tableName, forceQuote)} ADD ${constPart}PRIMARY KEY (${cols})`,
    );
  }
  for (const idx of addedIndexes) {
    upStatements.push(buildCreateIndexSql(idx, forceQuote));
    if (idx.inactive) {
      upStatements.push(`ALTER INDEX ${fmtIdent(idx.name, forceQuote)} INACTIVE`);
    }
  }
  for (const { after } of modifiedIndexes) {
    upStatements.push(
      `ALTER INDEX ${fmtIdent(after.name, forceQuote)} ${after.inactive ? 'INACTIVE' : 'ACTIVE'}`,
    );
  }
  for (const fk of addedForeignKeys) {
    upStatements.push(buildAddForeignKeySql(fk, forceQuote));
  }

  // 7. Create / alter views & triggers
  for (const v of addedViews) {
    upStatements.push(buildCreateViewSql(v, forceQuote));
  }
  for (const { after } of modifiedViews) {
    upStatements.push(buildCreateViewSql(after, forceQuote));
  }
  for (const tr of addedTriggers) {
    upStatements.push(buildCreateTriggerSql(tr, forceQuote));
  }
  for (const { after } of modifiedTriggers) {
    upStatements.push(buildCreateTriggerSql(after, forceQuote));
  }

  // 8. Drop removed sequences
  for (const seq of removedSequences) {
    upStatements.push(`DROP SEQUENCE ${fmtIdent(seq.name, forceQuote)}`);
  }

  // -------------------------------------------------------------------------
  // Assemble symmetric DOWN statements (by diffing `to` -> `from`)
  // -------------------------------------------------------------------------
  const downStatements = buildReverseStatements(schemaB, schemaA, forceQuote);

  const hasChanges = upStatements.length > 0;

  return {
    hasChanges,
    addedSequences,
    removedSequences,
    modifiedSequences,
    addedTables,
    removedTables,
    addedColumns,
    removedColumns,
    modifiedColumns,
    addedPrimaryKeys,
    removedPrimaryKeys,
    addedForeignKeys,
    removedForeignKeys,
    addedIndexes,
    removedIndexes,
    modifiedIndexes,
    addedViews,
    removedViews,
    modifiedViews,
    addedTriggers,
    removedTriggers,
    modifiedTriggers,
    upStatements,
    downStatements,
  };
}

function buildReverseStatements(
  fromSchema: SchemaIntrospection,
  toSchema: SchemaIntrospection,
  forceQuote: boolean,
): string[] {
  const seqA = new Map(fromSchema.sequences.map((s) => [s.name.toUpperCase(), s]));
  const seqB = new Map(toSchema.sequences.map((s) => [s.name.toUpperCase(), s]));
  const tablesA = new Map(fromSchema.tables.map((t) => [t.name.toUpperCase(), t]));
  const tablesB = new Map(toSchema.tables.map((t) => [t.name.toUpperCase(), t]));
  const pkMapA = new Map(fromSchema.primaryKeys.map((pk) => [pk.tableName.toUpperCase(), pk]));
  const pkMapB = new Map(toSchema.primaryKeys.map((pk) => [pk.tableName.toUpperCase(), pk]));
  const fkKey = (fk: ForeignKeySchemaInfo) =>
    `${fk.tableName.toUpperCase()}::${fk.name.toUpperCase()}`;
  const fksA = new Map(fromSchema.foreignKeys.map((fk) => [fkKey(fk), fk]));
  const fksB = new Map(toSchema.foreignKeys.map((fk) => [fkKey(fk), fk]));
  const backingA = getConstraintBackingIndexNames(fromSchema);
  const backingB = getConstraintBackingIndexNames(toSchema);
  const idxsA = new Map(
    fromSchema.indexes
      .filter((i) => !backingA.has(i.name.toUpperCase()) && !i.name.toUpperCase().startsWith('RDB$'))
      .map((i) => [i.name.toUpperCase(), i]),
  );
  const idxsB = new Map(
    toSchema.indexes
      .filter((i) => !backingB.has(i.name.toUpperCase()) && !i.name.toUpperCase().startsWith('RDB$'))
      .map((i) => [i.name.toUpperCase(), i]),
  );
  const viewsA = new Map(fromSchema.views.map((v) => [v.name.toUpperCase(), v]));
  const viewsB = new Map(toSchema.views.map((v) => [v.name.toUpperCase(), v]));
  const trgsA = new Map(fromSchema.triggers.map((t) => [t.name.toUpperCase(), t]));
  const trgsB = new Map(toSchema.triggers.map((t) => [t.name.toUpperCase(), t]));

  const stmts: string[] = [];

  for (const [k, trA] of trgsA.entries()) {
    if (!trgsB.has(k) && (trA.tableName === null || tablesB.has(trA.tableName.toUpperCase()))) {
      stmts.push(`DROP TRIGGER ${fmtIdent(trA.name, forceQuote)}`);
    }
  }
  for (const [k, vA] of viewsA.entries()) {
    if (!viewsB.has(k)) {
      stmts.push(`DROP VIEW ${fmtIdent(vA.name, forceQuote)}`);
    }
  }
  const revDroppedFkKeys = new Set<string>();
  for (const [k, fkA] of fksA.entries()) {
    const fkB = fksB.get(k);
    if (!fkB) {
      revDroppedFkKeys.add(k);
      stmts.push(
        `ALTER TABLE ${fmtIdent(fkA.tableName, forceQuote)} DROP CONSTRAINT ${fmtIdent(fkA.name, forceQuote)}`,
      );
    } else if (
      fkA.referencedTableName.toUpperCase() !== fkB.referencedTableName.toUpperCase() ||
      !sameStringArray(fkA.columns, fkB.columns) ||
      !sameStringArray(fkA.referencedColumns, fkB.referencedColumns) ||
      fkA.onDelete.toUpperCase() !== fkB.onDelete.toUpperCase() ||
      fkA.onUpdate.toUpperCase() !== fkB.onUpdate.toUpperCase()
    ) {
      revDroppedFkKeys.add(k);
      stmts.push(
        `ALTER TABLE ${fmtIdent(fkA.tableName, forceQuote)} DROP CONSTRAINT ${fmtIdent(fkA.name, forceQuote)}`,
      );
    }
  }
  for (const [tKey, tA] of tablesA.entries()) {
    if (!tablesB.has(tKey)) {
      for (const fk of tA.foreignKeys) {
        if (revDroppedFkKeys.has(fkKey(fk))) continue;
        revDroppedFkKeys.add(fkKey(fk));
        stmts.push(
          `ALTER TABLE ${fmtIdent(tA.name, forceQuote)} DROP CONSTRAINT ${fmtIdent(fk.name, forceQuote)}`,
        );
      }
    }
  }
  for (const [k, idxA] of idxsA.entries()) {
    const idxB = idxsB.get(k);
    if (!idxB && tablesB.has(idxA.tableName.toUpperCase())) {
      stmts.push(`DROP INDEX ${fmtIdent(idxA.name, forceQuote)}`);
    } else if (
      idxB &&
      (idxA.tableName.toUpperCase() !== idxB.tableName.toUpperCase() ||
        idxA.unique !== idxB.unique ||
        idxA.descending !== idxB.descending ||
        !sameStringArray(idxA.columns, idxB.columns))
    ) {
      stmts.push(`DROP INDEX ${fmtIdent(idxA.name, forceQuote)}`);
    }
  }
  for (const [tKey] of tablesB.entries()) {
    if (!tablesA.has(tKey)) continue;
    const pkA = pkMapA.get(tKey);
    const pkB = pkMapB.get(tKey);
    if (pkA && (!pkB || pkB.columns.length === 0 || !sameStringArray(pkA.columns, pkB.columns))) {
      stmts.push(
        `ALTER TABLE ${fmtIdent(pkA.tableName, forceQuote)} DROP CONSTRAINT ${fmtIdent(pkA.constraintName, forceQuote)}`,
      );
    }
  }

  for (const [tKey, tB] of tablesB.entries()) {
    const tA = tablesA.get(tKey);
    if (!tA) continue;
    const colsB = new Map(tB.columns.map((c) => [c.name.toUpperCase(), c]));
    for (const colA of tA.columns) {
      if (!colsB.has(colA.name.toUpperCase())) {
        stmts.push(
          `ALTER TABLE ${fmtIdent(colA.tableName, forceQuote)} DROP ${fmtIdent(colA.name, forceQuote)}`,
        );
      }
    }
  }
  for (const [tKey, tA] of tablesA.entries()) {
    if (!tablesB.has(tKey)) {
      stmts.push(`DROP TABLE ${fmtIdent(tA.name, forceQuote)}`);
    }
  }

  for (const [k, sB] of seqB.entries()) {
    const sA = seqA.get(k);
    if (!sA) {
      let sql = `CREATE SEQUENCE ${fmtIdent(sB.name, forceQuote)}`;
      if (sB.initialValue !== 0) sql += ` START WITH ${sB.initialValue}`;
      if (sB.increment !== 1) sql += ` INCREMENT BY ${sB.increment}`;
      stmts.push(sql);
    } else if (sA.increment !== sB.increment) {
      stmts.push(
        `ALTER SEQUENCE ${fmtIdent(sB.name, forceQuote)} INCREMENT BY ${sB.increment}`,
      );
    }
  }

  for (const [tKey, tB] of tablesB.entries()) {
    if (!tablesA.has(tKey)) {
      stmts.push(buildCreateTableSql(tB, forceQuote));
    }
  }

  for (const [tKey, tB] of tablesB.entries()) {
    const tA = tablesA.get(tKey);
    if (!tA) continue;
    const colsA = new Map(tA.columns.map((c) => [c.name.toUpperCase(), c]));
    for (const colB of tB.columns) {
      const colA = colsA.get(colB.name.toUpperCase());
      if (!colA) {
        stmts.push(
          `ALTER TABLE ${fmtIdent(colB.tableName, forceQuote)} ADD ${formatColumnDefinition(colB, forceQuote)}`,
        );
      } else {
        const tbl = fmtIdent(tB.name, forceQuote);
        const col = fmtIdent(colB.name, forceQuote);
        if (colA.typeName.toUpperCase() !== colB.typeName.toUpperCase()) {
          stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${colB.typeName}`);
        }
        const defA = normalizeDefaultExpr(colA.defaultSource);
        const defB = normalizeDefaultExpr(colB.defaultSource);
        if (defA !== defB) {
          if (defB !== null) {
            stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${defB}`);
          } else {
            stmts.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT`);
          }
        }
        if (colA.nullable !== colB.nullable) {
          stmts.push(
            `ALTER TABLE ${tbl} ALTER COLUMN ${col} ${colB.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`,
          );
        }
      }
    }
  }

  for (const [tKey] of tablesB.entries()) {
    if (!tablesA.has(tKey)) continue;
    const pkA = pkMapA.get(tKey);
    const pkB = pkMapB.get(tKey);
    if (pkB && pkB.columns.length > 0 && (!pkA || !sameStringArray(pkA.columns, pkB.columns))) {
      const cols = pkB.columns.map((c) => fmtIdent(c, forceQuote)).join(', ');
      const constPart = pkB.constraintName
        ? `CONSTRAINT ${fmtIdent(pkB.constraintName, forceQuote)} `
        : '';
      stmts.push(
        `ALTER TABLE ${fmtIdent(pkB.tableName, forceQuote)} ADD ${constPart}PRIMARY KEY (${cols})`,
      );
    }
  }

  for (const [k, idxB] of idxsB.entries()) {
    const idxA = idxsA.get(k);
    if (
      !idxA ||
      idxA.tableName.toUpperCase() !== idxB.tableName.toUpperCase() ||
      idxA.unique !== idxB.unique ||
      idxA.descending !== idxB.descending ||
      !sameStringArray(idxA.columns, idxB.columns)
    ) {
      stmts.push(buildCreateIndexSql(idxB, forceQuote));
      if (idxB.inactive) {
        stmts.push(`ALTER INDEX ${fmtIdent(idxB.name, forceQuote)} INACTIVE`);
      }
    } else if (idxA.inactive !== idxB.inactive) {
      stmts.push(
        `ALTER INDEX ${fmtIdent(idxB.name, forceQuote)} ${idxB.inactive ? 'INACTIVE' : 'ACTIVE'}`,
      );
    }
  }

  for (const [k, fkB] of fksB.entries()) {
    const fkA = fksA.get(k);
    if (
      !fkA ||
      fkA.referencedTableName.toUpperCase() !== fkB.referencedTableName.toUpperCase() ||
      !sameStringArray(fkA.columns, fkB.columns) ||
      !sameStringArray(fkA.referencedColumns, fkB.referencedColumns) ||
      fkA.onDelete.toUpperCase() !== fkB.onDelete.toUpperCase() ||
      fkA.onUpdate.toUpperCase() !== fkB.onUpdate.toUpperCase()
    ) {
      stmts.push(buildAddForeignKeySql(fkB, forceQuote));
    }
  }

  for (const [k, vB] of viewsB.entries()) {
    const vA = viewsA.get(k);
    if (!vA || (vA.source ?? '').trim() !== (vB.source ?? '').trim()) {
      stmts.push(buildCreateViewSql(vB, forceQuote));
    }
  }

  for (const [k, trB] of trgsB.entries()) {
    const trA = trgsA.get(k);
    if (
      !trA ||
      trA.triggerType !== trB.triggerType ||
      trA.sequence !== trB.sequence ||
      trA.inactive !== trB.inactive ||
      (trA.source ?? '').trim() !== (trB.source ?? '').trim()
    ) {
      stmts.push(buildCreateTriggerSql(trB, forceQuote));
    }
  }

  for (const [k, sA] of seqA.entries()) {
    if (!seqB.has(k)) {
      stmts.push(`DROP SEQUENCE ${fmtIdent(sA.name, forceQuote)}`);
    }
  }

  return stmts;
}

/**
 * Compare two Firebird schemas (`from` and `to`) and generate a complete
 * reversible {@link GeneratedMigration} object compatible with `migrate()`.
 */
export async function generateMigration(
  from: SchemaDiffSource,
  to: SchemaDiffSource,
  options: GenerateMigrationOptions = {},
): Promise<GeneratedMigration> {
  const diff = await diffSchema(from, to, options);
  const version = String(options.version ?? '001').trim();
  const name = options.name ?? 'auto_schema_migration';

  return {
    version,
    name,
    up: diff.upStatements,
    down: diff.downStatements,
    upSql: diff.upStatements.map((s) => `${s};`).join('\n'),
    downSql: diff.downStatements.map((s) => `${s};`).join('\n'),
    diff,
  };
}
