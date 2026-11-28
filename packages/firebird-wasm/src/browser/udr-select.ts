/**
 * Extracted `SELECT` filtering, sorting, and projection helpers for `UdrManager` (`M28 Item 5`).
 */

import type { FieldInfo, QueryParams, QueryResult, Row, RowMode } from '../types';
import {
  countPlaceholders,
  findRecordProperty,
  normalizeProcedureRowsAsync,
  normalizeRoutineIdentifier,
  parseFunctionCallExpr,
  quoteIdent,
  splitTopLevelCommaList,
  sqlTypeToFieldInfo,
  type ComputedColumnRecord,
  type ParsedSelectStatement,
  type RegisteredFunctionRecord,
  type RegisteredProcedureRecord,
  type UdrSqlExecutor,
} from './udr-parser';

export function findTopLevelKeyword(
  sql: string,
  keyword: string,
  startFrom = 0,
): { start: number; end: number } | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const upper = sql.toUpperCase();
  const kw = keyword.toUpperCase();

  for (let i = startFrom; i <= sql.length - kw.length; i++) {
    const ch = sql[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (sql[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (sql[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (
      depth === 0 &&
      upper.slice(i, i + kw.length) === kw &&
      (i === 0 || /[\s)]/.test(sql[i - 1]!)) &&
      (i + kw.length === sql.length || /[\s(]/.test(sql[i + kw.length]!))
    ) {
      return { start: i, end: i + kw.length };
    }
  }
  return null;
}

export function parseSimpleSelectStatement(sql: string): ParsedSelectStatement | null {
  const cleaned = sql.trim().replace(/;\s*$/, '');
  const selectMatch = /^\s*SELECT\s+/i.exec(cleaned);
  if (!selectMatch) return null;

  const afterSelectIdx = selectMatch[0].length;
  const fromLoc = findTopLevelKeyword(cleaned, 'FROM', afterSelectIdx);
  if (!fromLoc) return null;

  const selectRaw = cleaned.slice(afterSelectIdx, fromLoc.start).trim();
  const afterFrom = cleaned.slice(fromLoc.end).trim();

  const whereLoc = findTopLevelKeyword(afterFrom, 'WHERE', 0);
  const orderLoc = findTopLevelKeyword(
    afterFrom,
    'ORDER BY',
    whereLoc ? whereLoc.end : 0,
  );

  const fromEnd = whereLoc
    ? whereLoc.start
    : orderLoc
      ? orderLoc.start
      : afterFrom.length;
  const fromClause = afterFrom.slice(0, fromEnd).trim();

  if (findTopLevelKeyword(fromClause, 'JOIN', 0)) {
    return null;
  }

  let whereRaw: string | undefined;
  let orderByRaw: string | undefined;

  if (whereLoc) {
    const whereEnd = orderLoc ? orderLoc.start : afterFrom.length;
    whereRaw = afterFrom.slice(whereLoc.end, whereEnd).trim();
  }
  if (orderLoc) {
    orderByRaw = afterFrom.slice(orderLoc.end).trim();
  }

  const procMatch =
    /^("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*\(([\s\S]*)\)(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_$]*)?$/i.exec(
      fromClause,
    );
  if (procMatch) {
    return {
      selectRaw,
      fromName: procMatch[1]!,
      fromIsCall: true,
      fromArgsRaw: procMatch[2]!,
      whereRaw,
      orderByRaw,
    };
  }

  const tableMatch =
    /^("?[A-Za-z_][A-Za-z0-9_$]*"?)(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_$]*)?$/i.exec(
      fromClause,
    );
  if (tableMatch) {
    return {
      selectRaw,
      fromName: tableMatch[1]!,
      fromIsCall: false,
      fromArgsRaw: '',
      whereRaw,
      orderByRaw,
    };
  }

  return null;
}

export function splitSelectAlias(item: string): { expr: string; alias: string } {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const upper = item.toUpperCase();

  for (let i = 0; i < item.length; i++) {
    const ch = item[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (item[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (item[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (
      depth === 0 &&
      upper.slice(i, i + 4) === ' AS ' &&
      i > 0 &&
      i + 4 < item.length
    ) {
      const expr = item.slice(0, i).trim();
      const rawAlias = item.slice(i + 4).trim();
      const alias = rawAlias.startsWith('"')
        ? rawAlias.slice(1, -1).replace(/""/g, '"')
        : rawAlias.toUpperCase();
      return { expr, alias };
    }
  }

  const trailingMatch = /^([\s\S]+\))\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)$/.exec(
    item,
  );
  if (trailingMatch) {
    const rawAlias = trailingMatch[2]!;
    const alias = rawAlias.startsWith('"')
      ? rawAlias.slice(1, -1).replace(/""/g, '"')
      : rawAlias.toUpperCase();
    return { expr: trailingMatch[1]!.trim(), alias };
  }

  const fnCall = parseFunctionCallExpr(item);
  if (fnCall) {
    return { expr: item, alias: fnCall.funcName };
  }

  const colMatch =
    /^(?:[A-Za-z_][A-Za-z0-9_$]*\.)?("?[A-Za-z_][A-Za-z0-9_$]*"?)$/.exec(item);
  if (colMatch) {
    const rawCol = colMatch[1]!;
    const alias = rawCol.startsWith('"')
      ? rawCol.slice(1, -1).replace(/""/g, '"')
      : rawCol.toUpperCase();
    return { expr: item, alias };
  }

  return { expr: item, alias: 'CONSTANT' };
}

export interface UdrSelectEvalHost {
  readonly functions: ReadonlyMap<string, RegisteredFunctionRecord>;
  readonly procedures: ReadonlyMap<string, RegisteredProcedureRecord>;
  evalExpression(
    expr: string,
    params: QueryParams,
    cursor: { index: number },
    row: Record<string, unknown> | undefined,
  ): Promise<{ supported: boolean; value: unknown }>;
  evalCondition(
    condSql: string,
    params: QueryParams,
    cursor: { index: number },
    row: Record<string, unknown>,
  ): Promise<boolean>;
}

export async function selectFromUdrProcedure<T = Row>(
  host: UdrSelectEvalHost,
  sql: string,
  params: QueryParams,
  rowMode: RowMode,
): Promise<QueryResult<T> | null> {
  const parsed = parseSimpleSelectStatement(sql);
  if (!parsed || !parsed.fromIsCall) return null;

  const procName = normalizeRoutineIdentifier(
    parsed.fromName,
    'procedure name',
  );
  const proc = host.procedures.get(procName);
  if (!proc || proc.engine !== 'psql-bridge') {
    return null;
  }

  const paramsBeforeFrom = countPlaceholders(parsed.selectRaw);
  const fromArgExprs = parsed.fromArgsRaw.trim()
    ? splitTopLevelCommaList(parsed.fromArgsRaw)
    : [];
  const fromCursor = { index: paramsBeforeFrom };
  const procArgValues: unknown[] = [];
  for (const expr of fromArgExprs) {
    const ev = await host.evalExpression(expr, params, fromCursor, undefined);
    procArgValues.push(ev.supported ? ev.value : null);
  }

  const rawResult = await proc.fn(...procArgValues);
  const wireRows = await normalizeProcedureRowsAsync(rawResult, proc.returns);
  const objectRows: Record<string, unknown>[] = wireRows.map((tuple) =>
    Object.fromEntries(proc.returns.map((c, idx) => [c.name, tuple[idx]])),
  );

  const paramsBeforeWhere =
    paramsBeforeFrom + countPlaceholders(parsed.fromArgsRaw);

  return filterSortAndProjectUdrRows<T>(
    host,
    objectRows,
    proc.returns.map((c) => ({ ...c.fieldInfo })),
    parsed,
    params,
    paramsBeforeWhere,
    rowMode,
  );
}

export async function filterSortAndProjectUdrRows<T = Row>(
  host: UdrSelectEvalHost,
  sourceRows: Record<string, unknown>[],
  sourceFields: FieldInfo[],
  parsed: ParsedSelectStatement,
  params: QueryParams,
  paramsBeforeWhere: number,
  rowMode: RowMode,
): Promise<QueryResult<T>> {
  let filtered = sourceRows;
  if (parsed.whereRaw) {
    const next: Record<string, unknown>[] = [];
    for (const row of sourceRows) {
      const cursor = { index: paramsBeforeWhere };
      const matched = await host.evalCondition(
        parsed.whereRaw,
        params,
        cursor,
        row,
      );
      if (matched) {
        next.push(row);
      }
    }
    filtered = next;
  }

  if (parsed.orderByRaw) {
    const orderSpecs = splitTopLevelCommaList(parsed.orderByRaw).map((s) => {
      const m = /^([\s\S]+?)(?:\s+(ASC|DESC))?$/i.exec(s.trim());
      return {
        expr: (m?.[1] ?? s).trim(),
        desc: m?.[2]?.toUpperCase() === 'DESC',
      };
    });

    const decorated = await Promise.all(
      filtered.map(async (row) => {
        const keys: unknown[] = [];
        for (const spec of orderSpecs) {
          const ev = await host.evalExpression(
            spec.expr,
            params,
            { index: 0 },
            row,
          );
          keys.push(ev.supported ? ev.value : findRecordProperty(row, spec.expr));
        }
        return { row, keys };
      }),
    );

    decorated.sort((a, b) => {
      for (let i = 0; i < orderSpecs.length; i++) {
        const av = a.keys[i];
        const bv = b.keys[i];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
        return orderSpecs[i]!.desc ? -cmp : cmp;
      }
      return 0;
    });
    filtered = decorated.map((d) => d.row);
  }

  const selectItems = splitTopLevelCommaList(parsed.selectRaw);
  if (
    selectItems.length === 1 &&
    /^COUNT\s*\(\s*\*\s*\)(?:\s+(?:AS\s+)?("?[A-Za-z_][A-Za-z0-9_$]*"?))?$/i.test(
      selectItems[0]!,
    )
  ) {
    const m =
      /^COUNT\s*\(\s*\*\s*\)(?:\s+(?:AS\s+)?("?[A-Za-z_][A-Za-z0-9_$]*"?))?$/i.exec(
        selectItems[0]!,
      )!;
    const alias = m[1]
      ? normalizeRoutineIdentifier(m[1], 'alias')
      : 'COUNT';
    const countField = sqlTypeToFieldInfo(alias, 'BIGINT');
    const countVal = filtered.length;
    const outRow =
      rowMode === 'array'
        ? ([countVal] as unknown as T)
        : ({ [alias]: countVal } as unknown as T);
    return { rows: [outRow], fields: [countField] };
  }

  const projectedFields: FieldInfo[] = [];
  const itemPlans: Array<{
    isStar: boolean;
    expr: string;
    alias: string;
    fieldInfo: FieldInfo;
  }> = [];

  for (const item of selectItems) {
    const trimmed = item.trim();
    if (trimmed === '*' || /^[A-Za-z_][A-Za-z0-9_$]*\.\*$/.test(trimmed)) {
      for (const sf of sourceFields) {
        projectedFields.push({ ...sf });
        itemPlans.push({
          isStar: false,
          expr: quoteIdent(sf.name),
          alias: sf.name,
          fieldInfo: { ...sf },
        });
      }
      continue;
    }

    const { expr, alias } = splitSelectAlias(trimmed);
    const fnCall = parseFunctionCallExpr(expr);
    const regFn = fnCall ? host.functions.get(fnCall.funcName) : undefined;
    const sourceField = sourceFields.find(
      (f) => f.name.toUpperCase() === alias.toUpperCase(),
    );
    const fieldInfo: FieldInfo = regFn
      ? { ...regFn.returnField, name: alias }
      : sourceField
        ? { ...sourceField, name: alias }
        : sqlTypeToFieldInfo(alias, 'VARCHAR(4096)');

    projectedFields.push(fieldInfo);
    itemPlans.push({ isStar: false, expr, alias, fieldInfo });
  }

  const outRows: T[] = [];
  for (const row of filtered) {
    const cursor = { index: 0 };
    const values: unknown[] = [];
    for (const plan of itemPlans) {
      const ev = await host.evalExpression(plan.expr, params, cursor, row);
      values.push(ev.supported ? ev.value : null);
    }
    if (rowMode === 'array') {
      outRows.push(values as unknown as T);
    } else {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < itemPlans.length; i++) {
        obj[itemPlans[i]!.alias] = values[i];
      }
      outRows.push(obj as unknown as T);
    }
  }

  return { rows: outRows, fields: projectedFields };
}

export async function executeUdrProcedureCall<T = Row>(
  host: UdrSelectEvalHost,
  sql: string,
  params: QueryParams,
  rowMode: RowMode,
): Promise<QueryResult<T> | null> {
  const match =
    /^\s*EXECUTE\s+PROCEDURE\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*(?:\(([\s\S]*)\))?\s*;?\s*$/i.exec(
      sql,
    );
  if (!match) return null;

  const procName = normalizeRoutineIdentifier(match[1]!, 'procedure name');
  const proc = host.procedures.get(procName);
  if (!proc || proc.engine !== 'psql-bridge') return null;

  const argsRaw = match[2] ?? '';
  const argExprs = argsRaw.trim() ? splitTopLevelCommaList(argsRaw) : [];
  const cursor = { index: 0 };
  const argValues: unknown[] = [];
  for (const expr of argExprs) {
    const ev = await host.evalExpression(expr, params, cursor, undefined);
    argValues.push(ev.supported ? ev.value : null);
  }

  const rawResult = await proc.fn(...argValues);
  if (proc.returns.length === 0) return { rows: [], fields: [] };

  const wireRows = await normalizeProcedureRowsAsync(rawResult, proc.returns);
  const firstRow = wireRows[0] ?? proc.returns.map(() => null);
  const fields = proc.returns.map((c) => ({ ...c.fieldInfo }));
  const row =
    rowMode === 'array'
      ? (firstRow as unknown as T)
      : (Object.fromEntries(proc.returns.map((c, idx) => [c.name, firstRow[idx]])) as unknown as T);
  return { rows: [row], fields };
}

export async function selectTableWithUdrBridgeColumns<T = Row>(
  host: UdrSelectEvalHost,
  computedColumns: Map<string, Map<string, ComputedColumnRecord>>,
  sql: string,
  params: QueryParams,
  rowMode: RowMode,
  executor: UdrSqlExecutor,
): Promise<QueryResult<T> | null> {
  const parsed = parseSimpleSelectStatement(sql);
  if (!parsed || parsed.fromIsCall) return null;

  const tableName = normalizeRoutineIdentifier(parsed.fromName, 'table name');
  if (tableName === 'RDB$DATABASE') return null;

  const computedForTable = computedColumns.get(tableName);
  const upper = sql.toUpperCase();
  let mentionsBridgeFn = false;
  for (const fn of host.functions.values()) {
    if (fn.engine === 'psql-bridge' && upper.includes(fn.name)) {
      mentionsBridgeFn = true;
      break;
    }
  }
  const hasComputedCols = Boolean(computedForTable && computedForTable.size > 0);
  if (!mentionsBridgeFn && !hasComputedCols) return null;

  const baseResult = await executor.query<Record<string, unknown>>(
    `SELECT * FROM ${quoteIdent(tableName)}`,
    [],
    { rowMode: 'object' },
  );

  const enrichedRows: Record<string, unknown>[] = [];
  for (const rawRow of baseResult.rows) {
    const rowCopy: Record<string, unknown> = { ...rawRow };
    if (computedForTable) {
      for (const comp of computedForTable.values()) {
        const ev = await host.evalExpression(comp.expression, [], { index: 0 }, rowCopy);
        if (ev.supported) rowCopy[comp.columnName] = ev.value;
      }
    }
    enrichedRows.push(rowCopy);
  }

  return filterSortAndProjectUdrRows<T>(
    host,
    enrichedRows,
    baseResult.fields,
    parsed,
    params,
    countPlaceholders(parsed.selectRaw),
    rowMode,
  );
}
