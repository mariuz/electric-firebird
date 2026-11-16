/**
 * udr.ts – JavaScript User-Defined Functions & Procedures (`db.registerFunction` / `db.registerProcedure`).
 *
 * Bridges JavaScript callbacks into Firebird SQL in two complementary ways:
 *
 *   1. **Native WASM `"JS"` `IExternalEngine` plugin** (`engine === 'wasm-js'`):
 *      When running in the same thread against a WASM binary compiled with the
 *      static `"JS"` `IExternalEngine` plugin (`fb_wasm_api.cpp`), routines are
 *      registered via `CREATE OR ALTER FUNCTION|PROCEDURE ... EXTERNAL NAME '...' ENGINE JS`
 *      and invoked synchronously from C++ via `globalThis.__fbJsUdrInvoke`.
 *
 *   2. **PSQL Catalog Stub + JS SQL Bridge** (`engine === 'psql-bridge'`):
 *      When running across a Web Worker (`WorkerTransport`), multi-tab channel
 *      (`SharedEngineTransport`), Node native Firebird (`FirebirdLite`), or a
 *      pre-built WASM binary without `ENGINE JS`, routines are cataloged in
 *      Firebird (`RDB$FUNCTIONS` / `RDB$PROCEDURES`) via PSQL stubs so DDL
 *      (including `COMPUTED BY` columns) validates natively, and expressions
 *      referencing registered JS functions or procedures in `SELECT`, `WHERE`,
 *      `COMPUTED BY`, and `EXECUTE PROCEDURE` are evaluated in JavaScript.
 */

import type {
  FieldInfo,
  FirebirdTypeName,
  JsFunctionHandler,
  JsProcedureHandler,
  JsUdrArgDefinition,
  JsUdrOutputColumnDefinition,
  QueryParams,
  QueryResult,
  Row,
  RowMode,
} from '../types';

// ---------------------------------------------------------------------------
// Global C++ `EM_JS` UDR dispatcher (`globalThis.__fbJsUdrInvoke`)
// ---------------------------------------------------------------------------

interface JsUdrWireResponse {
  ok: boolean;
  value?: unknown;
  rows?: unknown[][];
  error?: string;
}

export interface GlobalRoutineEntry {
  kind: 'function' | 'procedure';
  name: string;
  entryPoint: string;
  outputColumns: NormalizedColumnDef[];
  fn: JsFunctionHandler | JsProcedureHandler;
}

export const globalRoutineByEntryPoint = new Map<string, GlobalRoutineEntry>();
export const globalRoutineByName = new Map<string, GlobalRoutineEntry>();

export async function normalizeProcedureRowsAsync(
  rawResult: unknown,
  outputColumns: readonly NormalizedColumnDef[],
): Promise<unknown[][]> {
  if (rawResult === null || rawResult === undefined) {
    return [];
  }
  if (
    typeof rawResult === 'object' &&
    rawResult !== null &&
    Symbol.asyncIterator in rawResult
  ) {
    const collected: unknown[] = [];
    for await (const item of rawResult as AsyncIterable<unknown>) {
      collected.push(item);
    }
    return normalizeProcedureRowsForWire(collected, outputColumns);
  }
  return normalizeProcedureRowsForWire(rawResult, outputColumns);
}

function normalizeProcedureRowsForWire(
  rawResult: unknown,
  outputColumns: readonly NormalizedColumnDef[],
): unknown[][] {
  if (rawResult === null || rawResult === undefined) {
    return [];
  }
  const items: unknown[] = Array.isArray(rawResult)
    ? rawResult
    : typeof rawResult === 'object' &&
        rawResult !== null &&
        Symbol.iterator in rawResult
      ? Array.from(rawResult as Iterable<unknown>)
      : [rawResult];

  return items.map((item) => {
    if (Array.isArray(item)) {
      return outputColumns.map((col, idx) =>
        coerceValueToSqlType(item[idx], col.type),
      );
    }
    if (typeof item === 'object' && item !== null) {
      const rec = item as Record<string, unknown>;
      return outputColumns.map((col) => {
        const val = findRecordProperty(rec, col.name);
        return coerceValueToSqlType(val, col.type);
      });
    }
    if (outputColumns.length === 1) {
      return [coerceValueToSqlType(item, outputColumns[0]!.type)];
    }
    return outputColumns.map(() => null);
  });
}

/**
 * Invoked synchronously by `fb_wasm_invoke_js_udr` in `fb_wasm_api.cpp`.
 */
export function invokeGlobalJsUdr(
  isProcedure: number,
  entryPoint: string,
  routineName: string,
  argsJson: string,
): JsUdrWireResponse {
  const epKey = entryPoint.trim();
  const nameKey = routineName.trim().toUpperCase();
  const entry =
    globalRoutineByEntryPoint.get(epKey) ??
    globalRoutineByEntryPoint.get(epKey.toUpperCase()) ??
    globalRoutineByName.get(nameKey);

  if (!entry) {
    return {
      ok: false,
      error: `JavaScript UDR '${entryPoint || routineName}' is not registered`,
    };
  }

  let args: unknown[] = [];
  try {
    args = argsJson ? (JSON.parse(argsJson) as unknown[]) : [];
  } catch (err) {
    return {
      ok: false,
      error: `Failed to decode UDR arguments JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const out = entry.fn(...args);
    if (out instanceof Promise) {
      return {
        ok: false,
        error: `Async JavaScript UDR '${entry.name}' cannot be invoked synchronously inside ENGINE JS`,
      };
    }
    if (!isProcedure) {
      return { ok: true, value: out === undefined ? null : out };
    }
    const rows = normalizeProcedureRowsForWire(out, entry.outputColumns);
    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function ensureGlobalUdrHookInstalled(): void {
  const g = globalThis as unknown as {
    __fbJsUdrInvoke?: typeof invokeGlobalJsUdr;
  };
  if (typeof g.__fbJsUdrInvoke !== 'function') {
    g.__fbJsUdrInvoke = invokeGlobalJsUdr;
  }
}

// ---------------------------------------------------------------------------
// Normalization & SQL Type Helpers
// ---------------------------------------------------------------------------

export interface NormalizedColumnDef {
  name: string;
  type: string;
  fieldInfo: FieldInfo;
}

export interface RegisteredFunctionRecord {
  kind: 'function';
  name: string;
  entryPoint: string;
  args: NormalizedColumnDef[];
  returns: string;
  returnField: FieldInfo;
  deterministic: boolean;
  engine: 'wasm-js' | 'psql-bridge';
  fn: JsFunctionHandler;
}

export interface RegisteredProcedureRecord {
  kind: 'procedure';
  name: string;
  entryPoint: string;
  args: NormalizedColumnDef[];
  returns: NormalizedColumnDef[];
  engine: 'wasm-js' | 'psql-bridge';
  fn: JsProcedureHandler;
}

export interface ComputedColumnRecord {
  tableName: string;
  columnName: string;
  expression: string;
}

export interface UdrSqlExecutor {
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: { rowMode?: RowMode },
  ): Promise<QueryResult<T>>;
  exec(sql: string, params?: QueryParams): Promise<unknown>;
  /** Whether the underlying engine runs in the same JS thread (DirectTransport). */
  isDirect?: boolean;
}

export function normalizeRoutineIdentifier(
  rawName: string,
  label = 'routine name',
): string {
  if (typeof rawName !== 'string') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new RangeError(`${label} cannot be empty`);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1).replace(/""/g, '"').trim();
    if (!inner) {
      throw new RangeError(`${label} cannot be empty`);
    }
    return inner.toUpperCase();
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
    throw new RangeError(
      `Invalid ${label} '${rawName}': must be a valid SQL identifier`,
    );
  }
  return trimmed.toUpperCase();
}

export function normalizeSqlTypeDeclaration(
  rawType: string,
  label = 'SQL type',
): string {
  if (typeof rawType !== 'string' || !rawType.trim()) {
    throw new RangeError(`${label} must be a non-empty SQL type string`);
  }
  const cleaned = rawType.trim().replace(/\s+/g, ' ');
  if (cleaned.includes(';') || cleaned.includes('--')) {
    throw new RangeError(`Invalid ${label} '${rawType}'`);
  }
  return cleaned.toUpperCase();
}

export function sqlTypeToFieldInfo(name: string, sqlType: string): FieldInfo {
  const upper = sqlType.toUpperCase().trim();
  let type = 448;
  let typeName: FirebirdTypeName = 'VARYING';
  let scale = 0;
  let subType = 0;
  let length = 256;

  const parenMatch = /\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/.exec(upper);
  const firstNum = parenMatch?.[1] ? Number(parenMatch[1]) : undefined;
  const secondNum = parenMatch?.[2] ? Number(parenMatch[2]) : undefined;

  if (upper.startsWith('SMALLINT')) {
    type = 500;
    typeName = 'SMALLINT';
    length = 2;
  } else if (upper.startsWith('INTEGER') || upper === 'INT') {
    type = 496;
    typeName = 'INTEGER';
    length = 4;
  } else if (upper.startsWith('BIGINT')) {
    type = 580;
    typeName = 'BIGINT';
    length = 8;
  } else if (upper.startsWith('INT128')) {
    type = 32752;
    typeName = 'INT128';
    length = 16;
  } else if (upper.startsWith('NUMERIC') || upper.startsWith('DECIMAL')) {
    type = 580;
    typeName = 'NUMERIC';
    scale = secondNum ? -secondNum : 0;
    length = 8;
  } else if (upper.startsWith('FLOAT') || upper.startsWith('REAL')) {
    type = 482;
    typeName = 'FLOAT';
    length = 4;
  } else if (upper.startsWith('DOUBLE')) {
    type = 480;
    typeName = 'DOUBLE';
    length = 8;
  } else if (upper.startsWith('BOOLEAN') || upper === 'BOOL') {
    type = 32764;
    typeName = 'BOOLEAN';
    length = 1;
  } else if (upper.startsWith('TIMESTAMP WITH TIME ZONE')) {
    type = 32754;
    typeName = 'TIMESTAMP_TZ';
    length = 12;
  } else if (upper.startsWith('TIME WITH TIME ZONE')) {
    type = 32756;
    typeName = 'TIME_TZ';
    length = 8;
  } else if (upper.startsWith('TIMESTAMP')) {
    type = 510;
    typeName = 'TIMESTAMP';
    length = 8;
  } else if (upper.startsWith('DATE')) {
    type = 570;
    typeName = 'DATE';
    length = 4;
  } else if (upper.startsWith('TIME')) {
    type = 560;
    typeName = 'TIME';
    length = 4;
  } else if (upper.startsWith('BLOB')) {
    type = 520;
    typeName = 'BLOB';
    subType = upper.includes('TEXT') || upper.includes('SUB_TYPE 1') ? 1 : 0;
    length = 8;
  } else if (upper.startsWith('CHAR') || upper.startsWith('CHARACTER')) {
    type = 452;
    typeName = 'TEXT';
    length = firstNum ?? 1;
  } else {
    type = 448;
    typeName = 'VARYING';
    length = firstNum ?? 4096;
  }

  return {
    name,
    type,
    typeName,
    subType,
    scale,
    length,
    nullable: true,
  };
}

export function coerceValueToSqlType(
  value: unknown,
  sqlType: string,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const upper = sqlType.toUpperCase().trim();
  if (
    upper.startsWith('SMALLINT') ||
    upper.startsWith('INTEGER') ||
    upper === 'INT' ||
    upper.startsWith('BIGINT')
  ) {
    if (typeof value === 'bigint') {
      const num = Number(value);
      return Number.isSafeInteger(num) ? num : value.toString();
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
      throw new TypeError(`Cannot convert '${String(value)}' to ${upper}`);
    }
    return Math.trunc(n);
  }
  if (
    upper.startsWith('DOUBLE') ||
    upper.startsWith('FLOAT') ||
    upper.startsWith('REAL')
  ) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
      return null;
    }
    return n;
  }
  if (upper.startsWith('NUMERIC') || upper.startsWith('DECIMAL')) {
    const scaleMatch = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(upper);
    const scale = scaleMatch?.[1] ? Number(scaleMatch[1]) : 0;
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) {
      return scale > 0 ? n.toFixed(scale) : String(Math.trunc(n));
    }
    return String(value);
  }
  if (upper.startsWith('BOOLEAN') || upper === 'BOOL') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 't';
  }
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (upper.startsWith('DATE')) return iso.slice(0, 10);
    if (upper.startsWith('TIME') && !upper.startsWith('TIMESTAMP')) {
      return iso.slice(11, 23);
    }
    return iso.replace('Z', '');
  }
  return String(value);
}

export function normalizeArgDefinitions(
  args: readonly JsUdrArgDefinition[] | undefined,
  fnLength: number,
): NormalizedColumnDef[] {
  if (!args) {
    const count = Math.max(0, fnLength);
    const list: NormalizedColumnDef[] = [];
    for (let i = 0; i < count; i++) {
      const name = `P${i + 1}`;
      const type = 'VARCHAR(4096)';
      list.push({ name, type, fieldInfo: sqlTypeToFieldInfo(name, type) });
    }
    return list;
  }
  return args.map((item, idx) => {
    if (typeof item === 'string') {
      const name = `P${idx + 1}`;
      const type = normalizeSqlTypeDeclaration(item, `argument ${idx + 1} type`);
      return { name, type, fieldInfo: sqlTypeToFieldInfo(name, type) };
    }
    const name = item.name
      ? normalizeRoutineIdentifier(item.name, `argument ${idx + 1} name`)
      : `P${idx + 1}`;
    const type = normalizeSqlTypeDeclaration(
      item.type,
      `argument ${idx + 1} type`,
    );
    return { name, type, fieldInfo: sqlTypeToFieldInfo(name, type) };
  });
}

export function normalizeOutputDefinitions(
  returns: readonly JsUdrOutputColumnDefinition[] | undefined,
): NormalizedColumnDef[] {
  if (!returns || returns.length === 0) {
    return [];
  }
  return returns.map((item, idx) => {
    if (typeof item === 'string') {
      const name = `OUT${idx + 1}`;
      const type = normalizeSqlTypeDeclaration(
        item,
        `output column ${idx + 1} type`,
      );
      return { name, type, fieldInfo: sqlTypeToFieldInfo(name, type) };
    }
    const name = item.name
      ? normalizeRoutineIdentifier(item.name, `output column ${idx + 1} name`)
      : `OUT${idx + 1}`;
    const type = normalizeSqlTypeDeclaration(
      item.type,
      `output column ${idx + 1} type`,
    );
    return { name, type, fieldInfo: sqlTypeToFieldInfo(name, type) };
  });
}

export function findRecordProperty(
  record: Record<string, unknown>,
  columnName: string,
): unknown {
  if (columnName in record) {
    return record[columnName];
  }
  const upper = columnName.toUpperCase();
  const lower = columnName.toLowerCase();
  if (upper in record) return record[upper];
  if (lower in record) return record[lower];
  for (const key of Object.keys(record)) {
    if (key.toUpperCase() === upper) {
      return record[key];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// DDL Builders
// ---------------------------------------------------------------------------

export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export function buildFunctionExternalDdl(rec: RegisteredFunctionRecord, replace: boolean): string {
  const verb = replace ? 'CREATE OR ALTER FUNCTION' : 'CREATE FUNCTION';
  const argsClause =
    rec.args.length > 0
      ? `(${rec.args.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(', ')})`
      : '()';
  const det = rec.deterministic ? ' DETERMINISTIC' : '';
  const ep = rec.entryPoint.replace(/'/g, "''");
  return `${verb} ${quoteIdent(rec.name)} ${argsClause} RETURNS ${rec.returns}${det} EXTERNAL NAME '${ep}' ENGINE JS`;
}

export function buildFunctionPsqlStubDdl(rec: RegisteredFunctionRecord, replace: boolean): string {
  const verb = replace ? 'CREATE OR ALTER FUNCTION' : 'CREATE FUNCTION';
  const argsClause =
    rec.args.length > 0
      ? `(${rec.args.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(', ')})`
      : '()';
  const det = rec.deterministic ? ' DETERMINISTIC' : '';
  return `${verb} ${quoteIdent(rec.name)} ${argsClause} RETURNS ${rec.returns}${det} AS BEGIN RETURN NULL; END`;
}

export function buildProcedureExternalDdl(rec: RegisteredProcedureRecord, replace: boolean): string {
  const verb = replace ? 'CREATE OR ALTER PROCEDURE' : 'CREATE PROCEDURE';
  const argsClause =
    rec.args.length > 0
      ? ` (${rec.args.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(', ')})`
      : '';
  const returnsClause =
    rec.returns.length > 0
      ? ` RETURNS (${rec.returns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(', ')})`
      : '';
  const ep = rec.entryPoint.replace(/'/g, "''");
  return `${verb} ${quoteIdent(rec.name)}${argsClause}${returnsClause} EXTERNAL NAME '${ep}' ENGINE JS`;
}

export function buildProcedurePsqlStubDdl(rec: RegisteredProcedureRecord, replace: boolean): string {
  const verb = replace ? 'CREATE OR ALTER PROCEDURE' : 'CREATE PROCEDURE';
  const argsClause =
    rec.args.length > 0
      ? ` (${rec.args.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(', ')})`
      : '';
  const returnsClause =
    rec.returns.length > 0
      ? ` RETURNS (${rec.returns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(', ')})`
      : '';
  const body = rec.returns.length > 0 ? 'SUSPEND;' : '';
  return `${verb} ${quoteIdent(rec.name)}${argsClause}${returnsClause} AS BEGIN ${body} END`;
}

// ---------------------------------------------------------------------------
// SQL Expression Parser & Evaluator for `psql-bridge` Mode
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated SQL argument list at top-level commas (respecting
 * nested parentheses, single-quoted strings, and double-quoted identifiers).
 */
export function splitTopLevelCommaList(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (input[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') {
        if (input[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inDouble = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * Count `?` placeholders outside string literals and quoted identifiers in `sqlSlice`.
 */
export function countPlaceholders(sqlSlice: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sqlSlice.length; i++) {
    const ch = sqlSlice[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (sqlSlice[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (sqlSlice[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '?') {
      count++;
    }
  }
  return count;
}

export function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (inSingle) {
        if (ch === "'") {
          if (s[i + 1] === "'") i++;
          else inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          if (s[i + 1] === '"') i++;
          else inDouble = false;
        }
        continue;
      }
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (balanced) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return s;
}

export function parseFunctionCallExpr(
  expr: string,
): { funcName: string; argsRaw: string } | null {
  const trimmed = expr.trim();
  const match = /^("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*\(([\s\S]*)\)$/.exec(trimmed);
  if (!match) return null;
  const rawName = match[1]!;
  const inside = match[2]!;
  // Verify the opening paren at the start matches the closing paren at the end.
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (inside[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (inside[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return null;
    }
  }
  if (depth !== 0) return null;
  const funcName = rawName.startsWith('"')
    ? rawName.slice(1, -1).replace(/""/g, '"').toUpperCase()
    : rawName.toUpperCase();
  return { funcName, argsRaw: inside };
}

export function splitBinaryOperatorTopLevel(
  expr: string,
  operator: string,
): [string, string] | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const opLen = operator.length;

  for (let i = 0; i <= expr.length - opLen; i++) {
    const ch = expr[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (expr[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (expr[i + 1] === '"') i++;
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
    if (depth === 0 && expr.slice(i, i + opLen) === operator) {
      return [expr.slice(0, i).trim(), expr.slice(i + opLen).trim()];
    }
  }
  return null;
}

export function splitKeywordOperatorTopLevel(
  expr: string,
  keyword: 'AND' | 'OR',
): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let lastSplit = 0;
  const upper = expr.toUpperCase();
  const kwLen = keyword.length;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (expr[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (expr[i + 1] === '"') i++;
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
      upper.slice(i, i + kwLen) === keyword &&
      (i === 0 || /[\s)]/.test(expr[i - 1]!)) &&
      (i + kwLen === expr.length || /[\s(]/.test(expr[i + kwLen]!))
    ) {
      parts.push(expr.slice(lastSplit, i).trim());
      lastSplit = i + kwLen;
      i += kwLen - 1;
    }
  }

  if (parts.length === 0) return null;
  parts.push(expr.slice(lastSplit).trim());
  return parts;
}


// ---------------------------------------------------------------------------
// Select Statement Parser Helpers
// ---------------------------------------------------------------------------

export interface ParsedSelectStatement {
  selectRaw: string;
  fromName: string;
  fromIsCall: boolean;
  fromArgsRaw: string;
  whereRaw?: string;
  orderByRaw?: string;
}

export function findMatchingCloseParen(sql: string, openParenIdx: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = openParenIdx; i < sql.length; i++) {
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
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function isTopLevelSelectItemStart(beforeSql: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < beforeSql.length; i++) {
    const ch = beforeSql[i]!;
    if (inSingle) {
      if (ch === "'") {
        if (beforeSql[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (beforeSql[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
  }
  if (depth !== 0) return false;
  return /(?:^\s*SELECT(?:\s+FIRST\s+\d+)?(?:\s+SKIP\s+\d+)?(?:\s+DISTINCT)?|,\s*)$/i.test(
    beforeSql,
  );
}

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

  // Check if the FROM clause has a JOIN — if so, let Firebird handle it unless it's a single source
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

  // Parse `fromClause`: either `PROC_NAME(args) [AS alias]` or `TABLE_NAME [AS alias]`
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

  // Trailing bare identifier alias after a closing paren, e.g. `SLUGIFY(title) s`
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

