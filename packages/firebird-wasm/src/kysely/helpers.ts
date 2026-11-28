/**
 * helpers.ts – SQL Node Classification, Row Casing, Transaction Mapping &
 * Multi-Row `INSERT ... UNION ALL` Rewriter for `firebird-wasm/kysely` (`M30 Item 5`).
 */

import type {
  DeleteQueryNode,
  InsertQueryNode,
  RootOperationNode,
  TransactionSettings,
  UpdateQueryNode,
} from 'kysely';
import type { QueryParams, TransactionOptions } from '../types';
import type { FirebirdIdentifierCase } from './index';

export function shouldUseExec(node: RootOperationNode | undefined, sql: string): boolean {
  if (!node) {
    return !/^\s*(select|with|execute\s+procedure)\b/i.test(sql) && !/\breturning\b/i.test(sql);
  }
  switch (node.kind) {
    case 'SelectQueryNode':
      return false;
    case 'InsertQueryNode':
    case 'UpdateQueryNode':
    case 'DeleteQueryNode':
      return !(node as InsertQueryNode | UpdateQueryNode | DeleteQueryNode).returning;
    case 'CreateTableNode':
    case 'DropTableNode':
    case 'AlterTableNode':
    case 'CreateIndexNode':
    case 'DropIndexNode':
    case 'CreateViewNode':
    case 'DropViewNode':
    case 'CreateSchemaNode':
    case 'DropSchemaNode':
      return true;
    default:
      return (
        !/^\s*(select|with|execute\s+procedure)\b/i.test(sql) &&
        !/\b(returning|returns)\b/i.test(sql)
      );
  }
}

export function formatOutputIdentifier(name: string, mode: FirebirdIdentifierCase): string {
  if (mode === 'lower' && /^[A-Z_][A-Z0-9_$]*$/.test(name)) {
    return name.toLowerCase();
  }
  return name;
}

export function mapRows<R>(
  rows: Record<string, unknown>[],
  mode: FirebirdIdentifierCase,
): R[] {
  if (mode === 'preserve' || rows.length === 0) {
    return rows as unknown as R[];
  }
  const first = rows[0]!;
  const keys = Object.keys(first);
  const mappedKeys = keys.map((k) => formatOutputIdentifier(k, mode));
  if (keys.every((k, i) => k === mappedKeys[i])) {
    return rows as unknown as R[];
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      out[mappedKeys[i]!] = row[keys[i]!];
    }
    return out as unknown as R;
  });
}

export function mapTransactionSettings(settings: TransactionSettings): TransactionOptions {
  const options: TransactionOptions = {};
  if (settings.accessMode === 'read only') {
    options.readOnly = true;
  }
  switch (settings.isolationLevel) {
    case 'read uncommitted':
    case 'read committed':
      options.isolationLevel = 'READ_COMMITTED';
      break;
    case 'repeatable read':
    case 'snapshot':
      options.isolationLevel = 'SNAPSHOT';
      break;
    case 'serializable':
      options.isolationLevel = 'SNAPSHOT_TABLE_STABILITY';
      break;
  }
  return options;
}

export function quoteSavepoint(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`Invalid savepoint name: ${name}`);
  }
  return name;
}

export function firebirdFieldTypeName(type: number, subType: number, scale: number): string {
  if ((type === 7 || type === 8 || type === 16 || type === 26) && (scale < 0 || subType === 1 || subType === 2)) {
    return subType === 2 ? 'decimal' : 'numeric';
  }
  switch (type) {
    case 7:
      return 'smallint';
    case 8:
      return 'integer';
    case 10:
      return 'float';
    case 12:
      return 'date';
    case 13:
      return 'time';
    case 14:
      return 'char';
    case 16:
      return 'bigint';
    case 23:
      return 'boolean';
    case 24:
    case 25:
      return 'decfloat';
    case 26:
      return 'int128';
    case 27:
      return 'double precision';
    case 28:
      return 'time with time zone';
    case 29:
      return 'timestamp with time zone';
    case 35:
      return 'timestamp';
    case 37:
      return 'varchar';
    case 261:
      return subType === 1 ? 'text' : 'blob';
    default:
      return `type_${type}`;
  }
}

export function extractAffectedRows(res: unknown): number | undefined {
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

const MULTI_ROW_INSERT_RE =
  /^((?:with\b[\s\S]+?\s+)?insert\s+into\s+[\s\S]+?\)\s+(?:overriding\s+system\s+value\s+)?)(select\s+[\s\S]+?\s+from\s+rdb\$database(?:\s+union\s+all\s+select\s+[\s\S]+?\s+from\s+rdb\$database)+)(\s+returning\s+[\s\S]+)?$/i;

function countPlaceholders(sqlFragment: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sqlFragment.length; i++) {
    const ch = sqlFragment[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '?' && !inSingle && !inDouble) count++;
  }
  return count;
}

/** @internal */
export interface ParsedMultiRowInsert {
  rows: { sql: string; params: QueryParams }[];
  uniformSql: string | undefined;
  hasReturning: boolean;
}

/** @internal */
export function parseMultiRowInsert(
  sql: string,
  params: unknown[],
): ParsedMultiRowInsert | undefined {
  const m = MULTI_ROW_INSERT_RE.exec(sql.trim());
  if (!m) return undefined;
  const prefix = m[1]!;
  const selectsBody = m[2]!;
  const returningSuffix = m[3] ?? '';
  const branches = selectsBody.split(/\s+union\s+all\s+/i);
  if (branches.length < 2) return undefined;

  const rows: { sql: string; params: QueryParams }[] = [];
  let paramOffset = 0;
  for (const branch of branches) {
    const bm = /^select\s+([\s\S]+?)\s+from\s+rdb\$database$/i.exec(branch.trim());
    if (!bm) return undefined;
    const exprs = bm[1]!;
    const pCount = countPlaceholders(exprs);
    if (paramOffset + pCount > params.length) return undefined;
    const rowParams = params.slice(paramOffset, paramOffset + pCount) as QueryParams;
    paramOffset += pCount;
    rows.push({
      sql: `${prefix}values (${exprs})${returningSuffix}`,
      params: rowParams,
    });
  }
  if (paramOffset !== params.length) return undefined;

  const firstSql = rows[0]!.sql;
  const uniformSql = rows.every((r) => r.sql === firstSql) ? firstSql : undefined;
  return {
    rows,
    uniformSql,
    hasReturning: returningSuffix.length > 0,
  };
}
