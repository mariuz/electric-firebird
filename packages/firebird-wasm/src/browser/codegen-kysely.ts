/**
 * codegen-kysely.ts – Kysely `Database` TypeScript Interface Generator
 * powered by `db.introspect()` (`M30 Item 5`).
 */

import type {
  ColumnSchemaInfo,
  IntrospectOptions,
  SchemaIntrospection,
} from '../types';
import {
  foldSqlIdentifier,
  formatObjectPropertyKey,
  resolveSchemaIntrospection,
  toPascalCase,
  type CodegenIdentifierCase,
  type IntrospectableSource,
} from './codegen';

/**
 * Options for {@link generateKyselyTypes} and {@link generateKyselyTypesFromCatalog}.
 */
export interface KyselyCodegenOptions extends IntrospectOptions {
  identifierCase?: CodegenIdentifierCase;
  databaseInterfaceName?: string;
  includeViews?: boolean;
  exportCrudTypes?: boolean;
  numericType?: 'number' | 'string';
  bigintType?: 'number' | 'bigint' | 'string';
  dateType?: 'string' | 'Date';
  includeHeader?: boolean;
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
    const dbKey = formatObjectPropertyKey(foldSqlIdentifier(tbl.name, identifierCase));
    dbEntries.push(`  ${dbKey}: ${ifaceName};`);

    const colLines: string[] = [];
    for (const col of tbl.columns) {
      const colKey = formatObjectPropertyKey(foldSqlIdentifier(col.name, identifierCase));
      const baseType = mapColumnToKyselyBaseType(col, { numericType, bigintType, dateType });
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

    const blockLines = [`export interface ${ifaceName} {`, ...colLines, '}'];
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
      const dbKey = formatObjectPropertyKey(foldSqlIdentifier(vw.name, identifierCase));
      dbEntries.push(`  ${dbKey}: ${ifaceName};`);

      const colLines: string[] = [];
      for (const col of vw.columns) {
        typeImports.add('ColumnType');
        const colKey = formatObjectPropertyKey(foldSqlIdentifier(col.name, identifierCase));
        const baseType = mapColumnToKyselyBaseType(col, { numericType, bigintType, dateType });
        const selectType = col.nullable ? `${baseType} | null` : baseType;
        colLines.push(`  ${colKey}: ColumnType<${selectType}, never, never>;`);
      }

      const blockLines = [`export interface ${ifaceName} {`, ...colLines, '}'];
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
    lines.push(`import type { ${sortedTypeImports.join(', ')} } from 'kysely';`, '');
  }
  if (interfaceBlocks.length > 0) {
    lines.push(interfaceBlocks.join('\n\n'), '');
  }
  lines.push(`export interface ${databaseInterfaceName} {`, ...dbEntries, '}');
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function generateKyselyTypes(
  source: IntrospectableSource,
  options: KyselyCodegenOptions = {},
): Promise<string> {
  const schema = await resolveSchemaIntrospection(source, options);
  return generateKyselyTypesFromCatalog(schema, options);
}
