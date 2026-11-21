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
  parseSimpleSelectStatement,
  quoteIdent,
  splitSelectAlias,
  splitTopLevelCommaList,
  sqlTypeToFieldInfo,
  type ParsedSelectStatement,
  type RegisteredFunctionRecord,
  type RegisteredProcedureRecord,
} from './udr-parser';

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
