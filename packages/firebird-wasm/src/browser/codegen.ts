/**
 * codegen.ts – TypeScript schema code generators powered by `db.introspect()`.
 *
 * Generates:
 * - Drizzle ORM `firebirdTable(...)` schema definitions (`generateDrizzleSchema`,
 *   `generateDrizzleSchemaFromCatalog`) for `firebird-wasm/drizzle`;
 * - Kysely `Database` TypeScript interfaces (`generateKyselyTypes`,
 *   `generateKyselyTypesFromCatalog`) for `firebird-wasm/kysely`.
 */

import type {
  ColumnSchemaInfo,
  ForeignKeySchemaInfo,
  IndexSchemaInfo,
  IntrospectOptions,
  MigrationExecutor,
  Row,
  SchemaIntrospection,
  TableSchemaInfo,
} from '../types';
import { introspect } from './schema';

/**
 * Identifier casing strategy between Drizzle / Kysely and Firebird.
 *
 * - `'lower'` (default): all-uppercase Firebird catalog names (`USERS`, `USER_ID`)
 *   are folded to lowercase (`'users'`, `'user_id'`) to match the bijective
 *   identifier folding in `FirebirdDrizzleDialect` and `FirebirdDialect`.
 * - `'preserve'`: catalog identifiers keep their exact casing (`'USERS'`, `'USER_ID'`).
 */
export type CodegenIdentifierCase = 'lower' | 'preserve';

/**
 * Any database client or catalog source accepted by {@link generateDrizzleSchema}
 * and {@link generateKyselyTypes}.
 */
export type IntrospectableSource =
  | SchemaIntrospection
  | { introspect(options?: IntrospectOptions): Promise<SchemaIntrospection> }
  | MigrationExecutor
  | { $client: MigrationExecutor | { introspect(options?: IntrospectOptions): Promise<SchemaIntrospection> } };

/**
 * Options for {@link generateDrizzleSchema} and {@link generateDrizzleSchemaFromCatalog}.
 */
export interface DrizzleCodegenOptions extends IntrospectOptions {
  /**
   * SQL identifier casing strategy emitted in `firebirdTable('<name>', ...)` and
   * column builders (`integer('<name>')`).
   * @default 'lower'
   */
  identifierCase?: CodegenIdentifierCase;
  /**
   * Convert table export names and column property keys to `camelCase`
   * (e.g. `ORDER_ITEMS` -> `orderItems`, `USER_ID` -> `userId`).
   * When `false`, uses the folded SQL identifier (`order_items`, `user_id`).
   * @default true
   */
  camelCase?: boolean;
  /**
   * Emit Drizzle `relations(...)` definitions for foreign keys.
   * @default true
   */
  includeRelations?: boolean;
  /**
   * Emit user-defined `index(...)` and `uniqueIndex(...)` builders in table extraConfig.
   * @default true
   */
  includeIndexes?: boolean;
  /**
   * Emit foreign key references (`.references(...)` and composite `foreignKey(...)`).
   * @default true
   */
  includeForeignKeys?: boolean;
  /**
   * Mode passed to Drizzle `bigint(..., { mode })` columns.
   * @default 'number'
   */
  bigintMode?: 'number' | 'bigint';
  /**
   * Module specifier used in the generated `import { ... } from '...'` statement.
   * @default 'firebird-wasm/drizzle'
   */
  importPath?: string;
  /**
   * Include the generated file header comment.
   * @default true
   */
  includeHeader?: boolean;
}

/**
 * Options for {@link generateKyselyTypes} and {@link generateKyselyTypesFromCatalog}.
 */
export interface KyselyCodegenOptions extends IntrospectOptions {
  /**
   * Identifier casing strategy for table keys in `Database` and column property names.
   * @default 'lower'
   */
  identifierCase?: CodegenIdentifierCase;
  /**
   * Name of the root Kysely database interface.
   * @default 'Database'
   */
  databaseInterfaceName?: string;
  /**
   * Include database views (`schema.views`) as read-only interfaces in `Database`.
   * @default true
   */
  includeViews?: boolean;
  /**
   * Export `Selectable<T>`, `Insertable<T>`, and `Updateable<T>` helper type aliases
   * for each table.
   * @default true
   */
  exportCrudTypes?: boolean;
  /**
   * TypeScript type emitted for `NUMERIC(p, s)` and `DECIMAL(p, s)` columns.
   * @default 'number'
   */
  numericType?: 'number' | 'string';
  /**
   * TypeScript type emitted for `BIGINT` and `INT128` columns.
   * @default 'number'
   */
  bigintType?: 'number' | 'bigint' | 'string';
  /**
   * TypeScript type emitted for `DATE`, `TIME`, and `TIMESTAMP` columns.
   * @default 'string'
   */
  dateType?: 'string' | 'Date';
  /**
   * Include the generated file header comment.
   * @default true
   */
  includeHeader?: boolean;
}

const JS_RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
]);

function isSchemaIntrospection(value: unknown): value is SchemaIntrospection {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as SchemaIntrospection).tables) &&
    Array.isArray((value as SchemaIntrospection).columns)
  );
}

/**
 * Resolve a {@link SchemaIntrospection} from either an already-introspected catalog
 * or a live database / ORM wrapper.
 */
export async function resolveSchemaIntrospection(
  source: IntrospectableSource,
  options?: IntrospectOptions,
): Promise<SchemaIntrospection> {
  if (isSchemaIntrospection(source)) {
    return source;
  }
  const unwrapped =
    typeof source === 'object' && source !== null && '$client' in source
      ? source.$client
      : source;

  if (
    typeof unwrapped === 'object' &&
    unwrapped !== null &&
    'introspect' in unwrapped &&
    typeof unwrapped.introspect === 'function'
  ) {
    return unwrapped.introspect(options);
  }

  if (
    typeof unwrapped === 'object' &&
    unwrapped !== null &&
    'query' in unwrapped &&
    typeof unwrapped.query === 'function'
  ) {
    const queryFn = unwrapped.query.bind(unwrapped) as MigrationExecutor['query'];
    const execFn: MigrationExecutor['exec'] =
      'exec' in unwrapped && typeof unwrapped.exec === 'function'
        ? unwrapped.exec.bind(unwrapped)
        : async (sqlText: string, params?: unknown[]) => {
            await queryFn<Row>(sqlText, params);
          };
    return introspect({ query: queryFn, exec: execFn }, options);
  }

  throw new TypeError(
    'Expected a SchemaIntrospection object or a database with introspect() / query()',
  );
}

function foldSqlIdentifier(name: string, mode: CodegenIdentifierCase): string {
  if (mode === 'lower' && /^[A-Z_][A-Z0-9_$]*$/.test(name)) {
    return name.toLowerCase();
  }
  return name;
}

function splitIdentifierWords(name: string): string[] {
  const cleaned = name.replace(/\$+/g, '_').replace(/[^A-Za-z0-9_]+/g, '_');
  if (/^[A-Z0-9_]+$/.test(cleaned) || /^[a-z0-9_]+$/.test(cleaned)) {
    return cleaned
      .split('_')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
  }
  return cleaned
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split('_')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function toCamelCase(name: string): string {
  const words = splitIdentifierWords(name);
  if (words.length === 0) return '_';
  const [first, ...rest] = words;
  const joined =
    first! +
    rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

function toPascalCase(name: string): string {
  const words = splitIdentifierWords(name);
  if (words.length === 0) return 'Unnamed';
  const joined = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

function toSafeVariableName(candidate: string): string {
  const sanitized = candidate.replace(/[^A-Za-z0-9_$]/g, '_');
  const prefixed = /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return JS_RESERVED_WORDS.has(prefixed) ? `${prefixed}_` : prefixed;
}

function formatObjectPropertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function quoteSingle(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function escapeTemplateLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function sortTablesTopologically(tables: TableSchemaInfo[]): TableSchemaInfo[] {
  const byName = new Map<string, TableSchemaInfo>();
  for (const t of tables) {
    byName.set(t.name, t);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: TableSchemaInfo[] = [];

  const visit = (table: TableSchemaInfo): void => {
    if (visited.has(table.name)) return;
    if (visiting.has(table.name)) return;
    visiting.add(table.name);
    for (const fk of table.foreignKeys) {
      if (fk.referencedTableName !== table.name) {
        const target = byName.get(fk.referencedTableName);
        if (target && !visited.has(target.name)) {
          visit(target);
        }
      }
    }
    visiting.delete(table.name);
    visited.add(table.name);
    ordered.push(table);
  };

  for (const t of tables) {
    visit(t);
  }
  return ordered;
}

function normalizeReferentialAction(
  rule: string,
): 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action' | undefined {
  switch (rule.trim().toUpperCase()) {
    case 'CASCADE':
      return 'cascade';
    case 'SET NULL':
      return 'set null';
    case 'SET DEFAULT':
      return 'set default';
    case 'NO ACTION':
      return undefined;
    case 'RESTRICT':
    default:
      return undefined;
  }
}

function isUserDefinedIndex(
  idx: IndexSchemaInfo,
  table: TableSchemaInfo,
  pkIndexNames: ReadonlySet<string>,
): boolean {
  if (idx.inactive) return false;
  const upper = idx.name.toUpperCase();
  if (
    pkIndexNames.has(idx.name) ||
    upper.startsWith('RDB$PRIMARY') ||
    upper.startsWith('RDB$FOREIGN')
  ) {
    return false;
  }
  if (
    idx.unique &&
    table.primaryKey.length > 0 &&
    idx.columns.length === table.primaryKey.length &&
    idx.columns.every((c, i) => c === table.primaryKey[i])
  ) {
    return false;
  }
  for (const fk of table.foreignKeys) {
    if (fk.name.toUpperCase() === upper) {
      return false;
    }
  }
  return idx.columns.length > 0;
}

function buildDrizzleDefaultModifier(
  col: ColumnSchemaInfo,
  bigintMode: 'number' | 'bigint',
  markNeedsSql: () => void,
): string {
  if (!col.defaultSource || col.isIdentity) return '';
  const raw = col.defaultSource.replace(/^default\s+/i, '').trim();
  if (!raw || /^null$/i.test(raw)) return '';

  if (col.dataType === 'BOOLEAN') {
    if (/^(true|1)$/i.test(raw)) return '.default(true)';
    if (/^(false|0)$/i.test(raw)) return '.default(false)';
  }

  if (
    col.dataType === 'SMALLINT' ||
    col.dataType === 'INTEGER' ||
    col.dataType === 'FLOAT' ||
    col.dataType === 'DOUBLE' ||
    col.dataType === 'DECFLOAT16' ||
    col.dataType === 'DECFLOAT34'
  ) {
    if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
      return `.default(${raw})`;
    }
  }

  if (col.dataType === 'BIGINT' || col.dataType === 'INT128') {
    if (/^[+-]?\d+$/.test(raw)) {
      return bigintMode === 'bigint'
        ? `.default(${raw}n)`
        : `.default(${raw})`;
    }
  }

  if (col.dataType === 'NUMERIC') {
    if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
      return `.default(${quoteSingle(raw)})`;
    }
  }

  const strMatch = /^'((?:[^']|'')*)'$/.exec(raw);
  if (strMatch) {
    const unescaped = strMatch[1]!.replace(/''/g, "'");
    if (col.dataType === 'BOOLEAN') {
      if (/^(true|1)$/i.test(unescaped)) return '.default(true)';
      if (/^(false|0)$/i.test(unescaped)) return '.default(false)';
    }
    return `.default(${quoteSingle(unescaped)})`;
  }

  markNeedsSql();
  return `.default(sql\`${escapeTemplateLiteral(raw)}\`)`;
}

/**
 * Synchronously generate TypeScript Drizzle ORM `firebirdTable(...)` schema
 * definitions from a {@link SchemaIntrospection} catalog.
 */
export function generateDrizzleSchemaFromCatalog(
  schema: SchemaIntrospection,
  options: DrizzleCodegenOptions = {},
): string {
  const identifierCase = options.identifierCase ?? 'lower';
  const useCamelCase = options.camelCase ?? true;
  const includeRelations = options.includeRelations ?? true;
  const includeIndexes = options.includeIndexes ?? true;
  const includeForeignKeys = options.includeForeignKeys ?? true;
  const bigintMode = options.bigintMode ?? 'number';
  const importPath = options.importPath ?? 'firebird-wasm/drizzle';
  const includeHeader = options.includeHeader ?? true;

  const sortedTables = sortTablesTopologically(schema.tables);
  const pkIndexNames = new Set(schema.primaryKeys.map((pk) => pk.indexName));

  // Map raw table name -> unique JS variable name
  const tableVarMap = new Map<string, string>();
  const usedTableVars = new Set<string>();
  for (const tbl of sortedTables) {
    const base = toSafeVariableName(
      useCamelCase
        ? toCamelCase(tbl.name)
        : foldSqlIdentifier(tbl.name, identifierCase),
    );
    let candidate = base;
    let suffix = 2;
    while (usedTableVars.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    usedTableVars.add(candidate);
    tableVarMap.set(tbl.name, candidate);
  }

  // Map (table.name, col.name) -> JS property key on the table
  const colPropMap = new Map<string, Map<string, string>>();
  for (const tbl of sortedTables) {
    const map = new Map<string, string>();
    const usedProps = new Set<string>();
    for (const col of tbl.columns) {
      const base = useCamelCase
        ? toCamelCase(col.name)
        : foldSqlIdentifier(col.name, identifierCase);
      let candidate = base;
      let suffix = 2;
      while (usedProps.has(candidate)) {
        candidate = `${base}_${suffix++}`;
      }
      usedProps.add(candidate);
      map.set(col.name, candidate);
    }
    colPropMap.set(tbl.name, map);
  }

  const imports = new Set<string>();
  let needsBinaryBlobHelper = false;
  let needsSqlTag = false;

  const tableBlocks: string[] = [];
  const emittedTables = new Set<string>();

  for (const tbl of sortedTables) {
    imports.add('firebirdTable');
    const tableVar = tableVarMap.get(tbl.name)!;
    const sqlTableName = foldSqlIdentifier(tbl.name, identifierCase);
    const props = colPropMap.get(tbl.name)!;

    // Identify single-column non-self foreign keys whose target table has already been emitted
    const inlineFkByCol = new Map<string, ForeignKeySchemaInfo>();
    const tableLevelFks: ForeignKeySchemaInfo[] = [];

    if (includeForeignKeys) {
      for (const fk of tbl.foreignKeys) {
        if (!tableVarMap.has(fk.referencedTableName)) continue;
        const isSingleCol =
          fk.columns.length === 1 && fk.referencedColumns.length === 1;
        const isNonSelfAndEmitted =
          fk.referencedTableName !== tbl.name &&
          emittedTables.has(fk.referencedTableName);
        if (
          isSingleCol &&
          isNonSelfAndEmitted &&
          !inlineFkByCol.has(fk.columns[0]!)
        ) {
          inlineFkByCol.set(fk.columns[0]!, fk);
        } else {
          tableLevelFks.push(fk);
        }
      }
    }

    const colLines: string[] = [];
    const isSinglePkTable = tbl.primaryKey.length === 1;

    for (const col of tbl.columns) {
      const propKey = formatObjectPropertyKey(props.get(col.name)!);
      const sqlColName = foldSqlIdentifier(col.name, identifierCase);
      let builderExpr: string;

      switch (col.dataType) {
        case 'SMALLINT':
          imports.add('smallint');
          builderExpr = `smallint(${quoteSingle(sqlColName)})`;
          break;
        case 'INTEGER':
          imports.add('integer');
          builderExpr = `integer(${quoteSingle(sqlColName)})`;
          break;
        case 'BIGINT':
        case 'INT128':
          imports.add('bigint');
          builderExpr = `bigint(${quoteSingle(sqlColName)}, { mode: ${quoteSingle(bigintMode)} })`;
          break;
        case 'NUMERIC': {
          imports.add('numeric');
          const defaultPrec =
            col.fieldType === 7
              ? 4
              : col.fieldType === 8
                ? 9
                : col.fieldType === 16
                  ? 18
                  : 38;
          const prec = col.precision > 0 ? col.precision : defaultPrec;
          const scale = Math.abs(col.scale);
          builderExpr = `numeric(${quoteSingle(sqlColName)}, { precision: ${prec}, scale: ${scale} })`;
          break;
        }
        case 'FLOAT':
          imports.add('real');
          builderExpr = `real(${quoteSingle(sqlColName)})`;
          break;
        case 'DOUBLE':
        case 'DECFLOAT16':
        case 'DECFLOAT34':
          imports.add('doublePrecision');
          builderExpr = `doublePrecision(${quoteSingle(sqlColName)})`;
          break;
        case 'BOOLEAN':
          imports.add('boolean');
          builderExpr = `boolean(${quoteSingle(sqlColName)})`;
          break;
        case 'VARYING':
          imports.add('varchar');
          builderExpr =
            col.length > 0
              ? `varchar(${quoteSingle(sqlColName)}, { length: ${col.length} })`
              : `varchar(${quoteSingle(sqlColName)})`;
          break;
        case 'TEXT':
          imports.add('char');
          builderExpr =
            col.length > 0
              ? `char(${quoteSingle(sqlColName)}, { length: ${col.length} })`
              : `char(${quoteSingle(sqlColName)})`;
          break;
        case 'BLOB':
          if (col.subType === 1) {
            imports.add('text');
            builderExpr = `text(${quoteSingle(sqlColName)})`;
          } else {
            imports.add('customType');
            needsBinaryBlobHelper = true;
            builderExpr = `blob(${quoteSingle(sqlColName)})`;
          }
          break;
        case 'DATE':
          imports.add('date');
          builderExpr = `date(${quoteSingle(sqlColName)})`;
          break;
        case 'TIME':
          imports.add('time');
          builderExpr = `time(${quoteSingle(sqlColName)})`;
          break;
        case 'TIME_TZ':
          imports.add('time');
          builderExpr = `time(${quoteSingle(sqlColName)}, { withTimezone: true })`;
          break;
        case 'TIMESTAMP':
          imports.add('timestamp');
          builderExpr = `timestamp(${quoteSingle(sqlColName)})`;
          break;
        case 'TIMESTAMP_TZ':
          imports.add('timestamp');
          builderExpr = `timestamp(${quoteSingle(sqlColName)}, { withTimezone: true })`;
          break;
        default:
          imports.add('text');
          builderExpr = `text(${quoteSingle(sqlColName)})`;
          break;
      }

      if (col.isIdentity) {
        builderExpr += '.generatedByDefaultAsIdentity()';
      }

      if (isSinglePkTable && tbl.primaryKey[0] === col.name) {
        builderExpr += '.primaryKey()';
      } else if (!col.nullable) {
        builderExpr += '.notNull()';
      }

      builderExpr += buildDrizzleDefaultModifier(col, bigintMode, () => {
        needsSqlTag = true;
        imports.add('sql');
      });

      const inlineFk = inlineFkByCol.get(col.name);
      if (inlineFk) {
        const refTableVar = tableVarMap.get(inlineFk.referencedTableName)!;
        const refColProp = colPropMap
          .get(inlineFk.referencedTableName)
          ?.get(inlineFk.referencedColumns[0]!);
        if (refColProp) {
          const onDelete = normalizeReferentialAction(inlineFk.onDelete);
          const onUpdate = normalizeReferentialAction(inlineFk.onUpdate);
          const actionParts: string[] = [];
          if (onDelete) actionParts.push(`onDelete: ${quoteSingle(onDelete)}`);
          if (onUpdate) actionParts.push(`onUpdate: ${quoteSingle(onUpdate)}`);
          const actionArg =
            actionParts.length > 0 ? `, { ${actionParts.join(', ')} }` : '';
          builderExpr += `.references(() => ${refTableVar}.${refColProp}${actionArg})`;
        }
      }

      colLines.push(`  ${propKey}: ${builderExpr},`);
    }

    const extraItems: string[] = [];

    // Composite primary key
    if (tbl.primaryKey.length > 1) {
      imports.add('primaryKey');
      const pkCols = tbl.primaryKey
        .map((colName) => `table.${props.get(colName) ?? colName}`)
        .join(', ');
      extraItems.push(`primaryKey({ columns: [${pkCols}] })`);
    }

    // Table-level foreign keys (composite, self-referencing, or forward-referencing)
    for (const fk of tableLevelFks) {
      const refTableVar =
        fk.referencedTableName === tbl.name
          ? 'table'
          : tableVarMap.get(fk.referencedTableName);
      const refProps = colPropMap.get(fk.referencedTableName);
      if (!refTableVar || !refProps) continue;

      imports.add('foreignKey');
      const localCols = fk.columns
        .map((c) => `table.${props.get(c) ?? c}`)
        .join(', ');
      const foreignCols = fk.referencedColumns
        .map((c) => `${refTableVar}.${refProps.get(c) ?? c}`)
        .join(', ');
      const fkName = foldSqlIdentifier(fk.name, identifierCase);
      let fkExpr = `foreignKey({ columns: [${localCols}], foreignColumns: [${foreignCols}], name: ${quoteSingle(fkName)} })`;
      const onDelete = normalizeReferentialAction(fk.onDelete);
      const onUpdate = normalizeReferentialAction(fk.onUpdate);
      if (onDelete) fkExpr += `.onDelete(${quoteSingle(onDelete)})`;
      if (onUpdate) fkExpr += `.onUpdate(${quoteSingle(onUpdate)})`;
      extraItems.push(fkExpr);
    }

    // User-defined indexes
    if (includeIndexes) {
      for (const idx of tbl.indexes) {
        if (!isUserDefinedIndex(idx, tbl, pkIndexNames)) continue;
        const builderName = idx.unique ? 'uniqueIndex' : 'index';
        imports.add(builderName);
        const idxName = foldSqlIdentifier(idx.name, identifierCase);
        const idxCols = idx.columns
          .map((c) => `table.${props.get(c) ?? c}`)
          .join(', ');
        extraItems.push(`${builderName}(${quoteSingle(idxName)}).on(${idxCols})`);
      }
    }

    if (extraItems.length === 0) {
      tableBlocks.push(
        `export const ${tableVar} = firebirdTable(${quoteSingle(sqlTableName)}, {\n${colLines.join('\n')}\n});`,
      );
    } else {
      const extraLines = extraItems.map((item) => `    ${item},`).join('\n');
      tableBlocks.push(
        `export const ${tableVar} = firebirdTable(\n  ${quoteSingle(sqlTableName)},\n  {\n${colLines.map((l) => `  ${l}`).join('\n')}\n  },\n  (table) => [\n${extraLines}\n  ],\n);`,
      );
    }

    emittedTables.add(tbl.name);
  }

  // Relations blocks
  const relationBlocks: string[] = [];
  if (includeRelations) {
    const incomingByTable = new Map<string, ForeignKeySchemaInfo[]>();
    for (const tbl of sortedTables) {
      for (const fk of tbl.foreignKeys) {
        if (!tableVarMap.has(fk.referencedTableName)) continue;
        const list = incomingByTable.get(fk.referencedTableName) ?? [];
        list.push(fk);
        incomingByTable.set(fk.referencedTableName, list);
      }
    }

    for (const tbl of sortedTables) {
      const outgoing = tbl.foreignKeys.filter((fk) =>
        tableVarMap.has(fk.referencedTableName),
      );
      const incoming = incomingByTable.get(tbl.name) ?? [];
      if (outgoing.length === 0 && incoming.length === 0) continue;

      imports.add('relations');
      const tableVar = tableVarMap.get(tbl.name)!;
      const props = colPropMap.get(tbl.name)!;
      const helpers: string[] = [];
      if (outgoing.length > 0) helpers.push('one');
      if (incoming.length > 0) helpers.push('many');

      const relEntries: string[] = [];
      const usedRelKeys = new Set<string>();

      const allocRelKey = (base: string): string => {
        let candidate = toSafeVariableName(base);
        let suffix = 2;
        while (usedRelKeys.has(candidate)) {
          candidate = `${base}_${suffix++}`;
        }
        usedRelKeys.add(candidate);
        return candidate;
      };

      for (const fk of outgoing) {
        const targetVar = tableVarMap.get(fk.referencedTableName)!;
        const targetProps = colPropMap.get(fk.referencedTableName)!;
        let baseName = targetVar;
        if (fk.columns.length === 1) {
          const stripped = fk.columns[0]!.replace(/_?ID$/i, '');
          if (stripped.length > 0 && stripped !== fk.columns[0]) {
            baseName = useCamelCase
              ? toCamelCase(stripped)
              : foldSqlIdentifier(stripped, identifierCase);
          }
        }
        const relKey = allocRelKey(baseName);
        const fieldsExpr = fk.columns
          .map((c) => `${tableVar}.${props.get(c) ?? c}`)
          .join(', ');
        const refsExpr = fk.referencedColumns
          .map((c) => `${targetVar}.${targetProps.get(c) ?? c}`)
          .join(', ');
        relEntries.push(
          `  ${relKey}: one(${targetVar}, {\n    fields: [${fieldsExpr}],\n    references: [${refsExpr}],\n  }),`,
        );
      }

      for (const fk of incoming) {
        const sourceVar = tableVarMap.get(fk.tableName)!;
        const relKey = allocRelKey(sourceVar);
        relEntries.push(`  ${relKey}: many(${sourceVar}),`);
      }

      relationBlocks.push(
        `export const ${tableVar}Relations = relations(${tableVar}, ({ ${helpers.join(', ')} }) => ({\n${relEntries.join('\n')}\n}));`,
      );
    }
  }

  void needsSqlTag;

  const sortedImports = Array.from(imports).sort();
  const lines: string[] = [];
  if (includeHeader) {
    lines.push(
      '// Generated by firebird-wasm/drizzle (generateDrizzleSchema) — do not edit manually.',
      '',
    );
  }
  if (sortedImports.length > 0) {
    lines.push(
      `import {\n  ${sortedImports.join(',\n  ')},\n} from ${quoteSingle(importPath)};`,
      '',
    );
  }
  if (needsBinaryBlobHelper) {
    lines.push(
      'const blob = customType<{ data: Uint8Array; driverData: Uint8Array }>({',
      "  dataType: () => 'blob',",
      '});',
      '',
    );
  }
  if (tableBlocks.length > 0) {
    lines.push(tableBlocks.join('\n\n'));
  }
  if (relationBlocks.length > 0) {
    if (tableBlocks.length > 0) lines.push('');
    lines.push(relationBlocks.join('\n\n'));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Introspect a Firebird database (or use an existing {@link SchemaIntrospection})
 * and generate TypeScript Drizzle ORM `firebirdTable(...)` schema definitions.
 */
export async function generateDrizzleSchema(
  source: IntrospectableSource,
  options: DrizzleCodegenOptions = {},
): Promise<string> {
  const schema = await resolveSchemaIntrospection(source, options);
  return generateDrizzleSchemaFromCatalog(schema, options);
}

function mapColumnToKyselyBaseType(
  col: ColumnSchemaInfo,
  options: Required<Pick<KyselyCodegenOptions, 'numericType' | 'bigintType' | 'dateType'>>,
): string {
  switch (col.dataType) {
    case 'SMALLINT':
    case 'INTEGER':
    case 'FLOAT':
    case 'DOUBLE':
    case 'DECFLOAT16':
    case 'DECFLOAT34':
      return 'number';
    case 'BIGINT':
    case 'INT128':
      return options.bigintType;
    case 'NUMERIC':
      return options.numericType;
    case 'BOOLEAN':
      return 'boolean';
    case 'TEXT':
    case 'VARYING':
      return 'string';
    case 'BLOB':
      return col.subType === 1 ? 'string' : 'Uint8Array';
    case 'DATE':
    case 'TIME':
    case 'TIME_TZ':
    case 'TIMESTAMP':
    case 'TIMESTAMP_TZ':
      return options.dateType;
    default:
      return 'unknown';
  }
}

/**
 * Synchronously generate Kysely TypeScript `Database` and table/view interfaces
 * from a {@link SchemaIntrospection} catalog.
 */
export function generateKyselyTypesFromCatalog(
  schema: SchemaIntrospection,
  options: KyselyCodegenOptions = {},
): string {
  const identifierCase = options.identifierCase ?? 'lower';
  const databaseInterfaceName = options.databaseInterfaceName ?? 'Database';
  const includeViews = options.includeViews ?? true;
  const exportCrudTypes = options.exportCrudTypes ?? true;
  const numericType = options.numericType ?? 'number';
  const bigintType = options.bigintType ?? 'number';
  const dateType = options.dateType ?? 'string';
  const includeHeader = options.includeHeader ?? true;

  const typeImports = new Set<string>();
  const interfaceBlocks: string[] = [];
  const dbEntries: string[] = [];
  const usedInterfaceNames = new Set<string>([databaseInterfaceName]);

  const allocInterfaceName = (base: string): string => {
    let candidate = base;
    let suffix = 2;
    while (usedInterfaceNames.has(candidate)) {
      candidate = `${base}${suffix++}`;
    }
    usedInterfaceNames.add(candidate);
    return candidate;
  };

  for (const tbl of schema.tables) {
    const pascalBase = toPascalCase(tbl.name);
    const ifaceName = allocInterfaceName(`${pascalBase}Table`);
    const dbKey = formatObjectPropertyKey(
      foldSqlIdentifier(tbl.name, identifierCase),
    );
    dbEntries.push(`  ${dbKey}: ${ifaceName};`);

    const colLines: string[] = [];
    for (const col of tbl.columns) {
      const colKey = formatObjectPropertyKey(
        foldSqlIdentifier(col.name, identifierCase),
      );
      const baseType = mapColumnToKyselyBaseType(col, {
        numericType,
        bigintType,
        dateType,
      });
      const selectType = col.nullable ? `${baseType} | null` : baseType;

      let typeExpr: string;
      if (col.isComputed) {
        typeImports.add('ColumnType');
        typeExpr = `ColumnType<${selectType}, never, never>`;
      } else if (col.isIdentity || col.defaultSource !== null) {
        typeImports.add('Generated');
        typeExpr = `Generated<${selectType}>`;
      } else {
        typeExpr = selectType;
      }

      colLines.push(`  ${colKey}: ${typeExpr};`);
    }

    const blockLines = [
      `export interface ${ifaceName} {`,
      ...colLines,
      '}',
    ];

    if (exportCrudTypes) {
      typeImports.add('Selectable');
      typeImports.add('Insertable');
      typeImports.add('Updateable');
      const selectAlias = allocInterfaceName(pascalBase);
      const insertAlias = allocInterfaceName(`New${pascalBase}`);
      const updateAlias = allocInterfaceName(`${pascalBase}Update`);
      blockLines.push(
        `export type ${selectAlias} = Selectable<${ifaceName}>;`,
        `export type ${insertAlias} = Insertable<${ifaceName}>;`,
        `export type ${updateAlias} = Updateable<${ifaceName}>;`,
      );
    }

    interfaceBlocks.push(blockLines.join('\n'));
  }

  if (includeViews) {
    for (const vw of schema.views) {
      const pascalBase = toPascalCase(vw.name);
      const ifaceName = allocInterfaceName(`${pascalBase}View`);
      const dbKey = formatObjectPropertyKey(
        foldSqlIdentifier(vw.name, identifierCase),
      );
      dbEntries.push(`  ${dbKey}: ${ifaceName};`);

      const colLines: string[] = [];
      for (const col of vw.columns) {
        typeImports.add('ColumnType');
        const colKey = formatObjectPropertyKey(
          foldSqlIdentifier(col.name, identifierCase),
        );
        const baseType = mapColumnToKyselyBaseType(col, {
          numericType,
          bigintType,
          dateType,
        });
        const selectType = col.nullable ? `${baseType} | null` : baseType;
        colLines.push(`  ${colKey}: ColumnType<${selectType}, never, never>;`);
      }

      const blockLines = [
        `export interface ${ifaceName} {`,
        ...colLines,
        '}',
      ];
      if (exportCrudTypes) {
        typeImports.add('Selectable');
        const selectAlias = allocInterfaceName(pascalBase);
        blockLines.push(`export type ${selectAlias} = Selectable<${ifaceName}>;`);
      }
      interfaceBlocks.push(blockLines.join('\n'));
    }
  }

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(
      '// Generated by firebird-wasm/kysely (generateKyselyTypes) — do not edit manually.',
      '',
    );
  }
  const sortedTypeImports = Array.from(typeImports).sort();
  if (sortedTypeImports.length > 0) {
    lines.push(
      `import type { ${sortedTypeImports.join(', ')} } from 'kysely';`,
      '',
    );
  }
  if (interfaceBlocks.length > 0) {
    lines.push(interfaceBlocks.join('\n\n'), '');
  }
  lines.push(
    `export interface ${databaseInterfaceName} {`,
    ...dbEntries,
    '}',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Introspect a Firebird database (or use an existing {@link SchemaIntrospection})
 * and generate Kysely TypeScript `Database` and table/view interfaces.
 */
export async function generateKyselyTypes(
  source: IntrospectableSource,
  options: KyselyCodegenOptions = {},
): Promise<string> {
  const schema = await resolveSchemaIntrospection(source, options);
  return generateKyselyTypesFromCatalog(schema, options);
}
