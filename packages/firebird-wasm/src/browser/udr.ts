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
  RegisteredRoutine,
  RegisterFunctionOptions,
  RegisterProcedureOptions,
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

interface GlobalRoutineEntry {
  kind: 'function' | 'procedure';
  name: string;
  entryPoint: string;
  outputColumns: NormalizedColumnDef[];
  fn: JsFunctionHandler | JsProcedureHandler;
}

const globalRoutineByEntryPoint = new Map<string, GlobalRoutineEntry>();
const globalRoutineByName = new Map<string, GlobalRoutineEntry>();

async function normalizeProcedureRowsAsync(
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

function ensureGlobalUdrHookInstalled(): void {
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

function normalizeArgDefinitions(
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

function normalizeOutputDefinitions(
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

function findRecordProperty(
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

function quoteIdent(ident: string): string {
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

function stripOuterParens(expr: string): string {
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

function parseFunctionCallExpr(
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

function splitBinaryOperatorTopLevel(
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

function splitKeywordOperatorTopLevel(
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
// UdrManager
// ---------------------------------------------------------------------------

export class UdrManager {
  private readonly functions = new Map<string, RegisteredFunctionRecord>();
  private readonly procedures = new Map<string, RegisteredProcedureRecord>();
  private readonly computedColumns = new Map<string, Map<string, ComputedColumnRecord>>();
  private nativeEngineSupported: boolean | null = null;

  get hasRoutines(): boolean {
    return this.functions.size > 0 || this.procedures.size > 0;
  }

  get hasBridgeRoutines(): boolean {
    for (const fn of this.functions.values()) {
      if (fn.engine === 'psql-bridge') return true;
    }
    for (const proc of this.procedures.values()) {
      if (proc.engine === 'psql-bridge') return true;
    }
    return false;
  }

  getFunction(name: string): RegisteredFunctionRecord | undefined {
    return this.functions.get(name.trim().toUpperCase());
  }

  getProcedure(name: string): RegisteredProcedureRecord | undefined {
    return this.procedures.get(name.trim().toUpperCase());
  }

  clear(): void {
    for (const fn of this.functions.values()) {
      globalRoutineByEntryPoint.delete(fn.entryPoint);
      globalRoutineByName.delete(fn.name);
    }
    for (const proc of this.procedures.values()) {
      globalRoutineByEntryPoint.delete(proc.entryPoint);
      globalRoutineByName.delete(proc.name);
    }
    this.functions.clear();
    this.procedures.clear();
    this.computedColumns.clear();
  }

  /**
   * Register a JavaScript scalar function callable from Firebird SQL.
   */
  async registerFunction(
    name: string,
    optionsOrFn: RegisterFunctionOptions | JsFunctionHandler,
    maybeFn: JsFunctionHandler | undefined,
    executor: UdrSqlExecutor,
  ): Promise<RegisteredRoutine> {
    const options: RegisterFunctionOptions =
      typeof optionsOrFn === 'function' ? {} : (optionsOrFn ?? {});
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;

    if (typeof fn !== 'function') {
      throw new TypeError(
        'registerFunction requires a JavaScript callback function',
      );
    }

    const normalizedName = normalizeRoutineIdentifier(name, 'function name');
    const args = normalizeArgDefinitions(options.args, fn.length);
    const returns = normalizeSqlTypeDeclaration(
      options.returns ?? 'VARCHAR(4096)',
      'return type',
    );
    const returnField = sqlTypeToFieldInfo(normalizedName, returns);
    const deterministic = options.deterministic === true;
    const replace = options.replace !== false;
    const entryPoint = (options.entryPoint ?? normalizedName).trim();

    const record: RegisteredFunctionRecord = {
      kind: 'function',
      name: normalizedName,
      entryPoint,
      args,
      returns,
      returnField,
      deterministic,
      engine: 'psql-bridge',
      fn,
    };

    ensureGlobalUdrHookInstalled();
    const isAsyncFn = fn.constructor?.name === 'AsyncFunction';
    let useNativeEngine = false;

    if (executor.isDirect && !isAsyncFn && this.nativeEngineSupported !== false) {
      const probeEntry: GlobalRoutineEntry = {
        kind: 'function',
        name: normalizedName,
        entryPoint,
        outputColumns: [{ name: normalizedName, type: returns, fieldInfo: returnField }],
        fn: () => null,
      };
      globalRoutineByEntryPoint.set(entryPoint, probeEntry);
      globalRoutineByName.set(normalizedName, probeEntry);

      try {
        await executor.exec(buildFunctionExternalDdl(record, replace));
        const nullArgs = args.map(() => 'NULL').join(', ');
        await executor.query(
          `SELECT ${quoteIdent(normalizedName)}(${nullArgs}) FROM RDB$DATABASE`,
        );
        useNativeEngine = true;
        this.nativeEngineSupported = true;
      } catch {
        this.nativeEngineSupported = false;
        useNativeEngine = false;
      }
    }

    const liveEntry: GlobalRoutineEntry = {
      kind: 'function',
      name: normalizedName,
      entryPoint,
      outputColumns: [{ name: normalizedName, type: returns, fieldInfo: returnField }],
      fn: (...rawArgs: unknown[]) => {
        const out = fn(...rawArgs);
        if (out instanceof Promise) return out;
        return coerceValueToSqlType(out, returns);
      },
    };
    globalRoutineByEntryPoint.set(entryPoint, liveEntry);
    globalRoutineByName.set(normalizedName, liveEntry);

    if (useNativeEngine) {
      record.engine = 'wasm-js';
    } else {
      record.engine = 'psql-bridge';
      await executor.exec(buildFunctionPsqlStubDdl(record, replace));
    }

    this.functions.set(normalizedName, record);

    let unregistered = false;
    const unregister = async (): Promise<void> => {
      if (unregistered) return;
      unregistered = true;
      await this.unregisterFunction(normalizedName, executor);
    };

    return {
      name: normalizedName,
      kind: 'function',
      entryPoint,
      engine: record.engine,
      unregister,
      [Symbol.asyncDispose]: unregister,
    };
  }

  /**
   * Register a JavaScript table-valued or executable procedure callable from Firebird SQL.
   */
  async registerProcedure(
    name: string,
    optionsOrFn: RegisterProcedureOptions | JsProcedureHandler,
    maybeFn: JsProcedureHandler | undefined,
    executor: UdrSqlExecutor,
  ): Promise<RegisteredRoutine> {
    const options: RegisterProcedureOptions =
      typeof optionsOrFn === 'function' ? {} : (optionsOrFn ?? {});
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;

    if (typeof fn !== 'function') {
      throw new TypeError(
        'registerProcedure requires a JavaScript callback function',
      );
    }

    const normalizedName = normalizeRoutineIdentifier(name, 'procedure name');
    const args = normalizeArgDefinitions(options.args, fn.length);
    const returns = normalizeOutputDefinitions(options.returns);
    const replace = options.replace !== false;
    const entryPoint = (options.entryPoint ?? normalizedName).trim();

    const record: RegisteredProcedureRecord = {
      kind: 'procedure',
      name: normalizedName,
      entryPoint,
      args,
      returns,
      engine: 'psql-bridge',
      fn,
    };

    ensureGlobalUdrHookInstalled();
    const isAsyncFn = fn.constructor?.name === 'AsyncFunction';
    let useNativeEngine = false;

    if (executor.isDirect && !isAsyncFn && this.nativeEngineSupported !== false) {
      const probeEntry: GlobalRoutineEntry = {
        kind: 'procedure',
        name: normalizedName,
        entryPoint,
        outputColumns: returns,
        fn: () => [],
      };
      globalRoutineByEntryPoint.set(entryPoint, probeEntry);
      globalRoutineByName.set(normalizedName, probeEntry);

      try {
        await executor.exec(buildProcedureExternalDdl(record, replace));
        if (returns.length > 0) {
          const nullArgs =
            args.length > 0 ? `(${args.map(() => 'NULL').join(', ')})` : '';
          await executor.query(
            `SELECT * FROM ${quoteIdent(normalizedName)}${nullArgs}`,
          );
        } else {
          const nullArgs =
            args.length > 0 ? `(${args.map(() => 'NULL').join(', ')})` : '';
          await executor.exec(
            `EXECUTE PROCEDURE ${quoteIdent(normalizedName)}${nullArgs}`,
          );
        }
        useNativeEngine = true;
        this.nativeEngineSupported = true;
      } catch {
        this.nativeEngineSupported = false;
        useNativeEngine = false;
      }
    }

    const liveEntry: GlobalRoutineEntry = {
      kind: 'procedure',
      name: normalizedName,
      entryPoint,
      outputColumns: returns,
      fn,
    };
    globalRoutineByEntryPoint.set(entryPoint, liveEntry);
    globalRoutineByName.set(normalizedName, liveEntry);

    if (useNativeEngine) {
      record.engine = 'wasm-js';
    } else {
      record.engine = 'psql-bridge';
      await executor.exec(buildProcedurePsqlStubDdl(record, replace));
    }

    this.procedures.set(normalizedName, record);

    let unregistered = false;
    const unregister = async (): Promise<void> => {
      if (unregistered) return;
      unregistered = true;
      await this.unregisterProcedure(normalizedName, executor);
    };

    return {
      name: normalizedName,
      kind: 'procedure',
      entryPoint,
      engine: record.engine,
      unregister,
      [Symbol.asyncDispose]: unregister,
    };
  }

  async unregisterFunction(
    name: string,
    executor: UdrSqlExecutor,
  ): Promise<void> {
    const normalizedName = normalizeRoutineIdentifier(name, 'function name');
    const existing = this.functions.get(normalizedName);
    this.functions.delete(normalizedName);
    if (existing) {
      globalRoutineByEntryPoint.delete(existing.entryPoint);
      globalRoutineByName.delete(existing.name);
    }
    await executor
      .exec(`DROP FUNCTION ${quoteIdent(normalizedName)}`)
      .catch(() => undefined);
  }

  async unregisterProcedure(
    name: string,
    executor: UdrSqlExecutor,
  ): Promise<void> {
    const normalizedName = normalizeRoutineIdentifier(name, 'procedure name');
    const existing = this.procedures.get(normalizedName);
    this.procedures.delete(normalizedName);
    if (existing) {
      globalRoutineByEntryPoint.delete(existing.entryPoint);
      globalRoutineByName.delete(existing.name);
    }
    await executor
      .exec(`DROP PROCEDURE ${quoteIdent(normalizedName)}`)
      .catch(() => undefined);
  }

  /**
   * Inspect DDL statements (`CREATE TABLE`, `RECREATE TABLE`, `ALTER TABLE`,
   * `DROP TABLE`) to track `COMPUTED BY` columns that reference registered
   * JavaScript functions.
   */
  inspectDdl(sql: string): void {
    const dropMatch = /^\s*DROP\s+TABLE\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)/i.exec(
      sql,
    );
    if (dropMatch) {
      const table = normalizeRoutineIdentifier(dropMatch[1]!, 'table name');
      this.computedColumns.delete(table);
      return;
    }

    const createMatch =
      /^\s*(?:CREATE|RECREATE)\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(
        sql,
      );
    if (createMatch) {
      const tableName = normalizeRoutineIdentifier(
        createMatch[1]!,
        'table name',
      );
      const body = createMatch[2]!;
      const cols = splitTopLevelCommaList(body);
      const tableMap = new Map<string, ComputedColumnRecord>();

      for (const colDef of cols) {
        const compMatch =
          /^("?[A-Za-z_][A-Za-z0-9_$]*"?)\s+(?:[A-Za-z0-9_() ,]+?\s+)?(?:COMPUTED\s+(?:BY\s+)?|GENERATED\s+ALWAYS\s+AS\s*)\(([\s\S]+)\)\s*$/i.exec(
            colDef.trim(),
          );
        if (compMatch) {
          const columnName = normalizeRoutineIdentifier(
            compMatch[1]!,
            'column name',
          );
          const expression = compMatch[2]!.trim();
          tableMap.set(columnName, { tableName, columnName, expression });
        }
      }

      if (tableMap.size > 0) {
        this.computedColumns.set(tableName, tableMap);
      } else {
        this.computedColumns.delete(tableName);
      }
      return;
    }

    const alterMatch =
      /^\s*ALTER\s+TABLE\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)\s+ADD\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)\s+(?:[A-Za-z0-9_() ,]+?\s+)?(?:COMPUTED\s+(?:BY\s+)?|GENERATED\s+ALWAYS\s+AS\s*)\(([\s\S]+)\)\s*;?\s*$/i.exec(
        sql,
      );
    if (alterMatch) {
      const tableName = normalizeRoutineIdentifier(
        alterMatch[1]!,
        'table name',
      );
      const columnName = normalizeRoutineIdentifier(
        alterMatch[2]!,
        'column name',
      );
      const expression = alterMatch[3]!.trim();
      let tableMap = this.computedColumns.get(tableName);
      if (!tableMap) {
        tableMap = new Map();
        this.computedColumns.set(tableName, tableMap);
      }
      tableMap.set(columnName, { tableName, columnName, expression });
    }
  }

  /**
   * Evaluate an expression against an optional row context and parameter cursor.
   */
  private async evalExpression(
    rawExpr: string,
    params: readonly unknown[],
    paramCursor: { index: number },
    rowContext?: Record<string, unknown>,
  ): Promise<{ supported: boolean; value: unknown }> {
    const expr = stripOuterParens(rawExpr);

    if (!expr) {
      return { supported: false, value: undefined };
    }

    // Parameter placeholder `?`
    if (expr === '?') {
      const val = params[paramCursor.index++];
      return { supported: true, value: val ?? null };
    }

    // String literal `'...'`
    if (expr.startsWith("'") && expr.endsWith("'") && expr.length >= 2) {
      return {
        supported: true,
        value: expr.slice(1, -1).replace(/''/g, "'"),
      };
    }

    const upper = expr.toUpperCase();
    if (upper === 'NULL') {
      return { supported: true, value: null };
    }
    if (upper === 'TRUE') {
      return { supported: true, value: true };
    }
    if (upper === 'FALSE') {
      return { supported: true, value: false };
    }

    // Numeric literal
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(expr)) {
      return { supported: true, value: Number(expr) };
    }

    // String concatenation `||`
    const concatSplit = splitBinaryOperatorTopLevel(expr, '||');
    if (concatSplit) {
      const left = await this.evalExpression(
        concatSplit[0],
        params,
        paramCursor,
        rowContext,
      );
      if (!left.supported) return { supported: false, value: undefined };
      const right = await this.evalExpression(
        concatSplit[1],
        params,
        paramCursor,
        rowContext,
      );
      if (!right.supported) return { supported: false, value: undefined };
      if (left.value === null || right.value === null) {
        return { supported: true, value: null };
      }
      return {
        supported: true,
        value: String(left.value) + String(right.value),
      };
    }

    // CAST(x AS type)
    const castMatch = /^CAST\s*\(\s*([\s\S]+?)\s+AS\s+([A-Za-z0-9_() ,]+)\)$/i.exec(
      expr,
    );
    if (castMatch) {
      const inner = await this.evalExpression(
        castMatch[1]!,
        params,
        paramCursor,
        rowContext,
      );
      if (!inner.supported) return { supported: false, value: undefined };
      return {
        supported: true,
        value: coerceValueToSqlType(inner.value, castMatch[2]!),
      };
    }

    // COALESCE(a, b, ...)
    const fnCall = parseFunctionCallExpr(expr);
    if (fnCall) {
      const argExprs = fnCall.argsRaw.trim()
        ? splitTopLevelCommaList(fnCall.argsRaw)
        : [];

      if (fnCall.funcName === 'COALESCE') {
        let result: unknown = null;
        for (const a of argExprs) {
          const ev = await this.evalExpression(a, params, paramCursor, rowContext);
          if (!ev.supported) return { supported: false, value: undefined };
          if (ev.value !== null && ev.value !== undefined && result === null) {
            result = ev.value;
          }
        }
        return { supported: true, value: result };
      }

      if (fnCall.funcName === 'UPPER' && argExprs.length === 1) {
        const ev = await this.evalExpression(argExprs[0]!, params, paramCursor, rowContext);
        if (!ev.supported) return { supported: false, value: undefined };
        return {
          supported: true,
          value: ev.value == null ? null : String(ev.value).toUpperCase(),
        };
      }

      if (fnCall.funcName === 'LOWER' && argExprs.length === 1) {
        const ev = await this.evalExpression(argExprs[0]!, params, paramCursor, rowContext);
        if (!ev.supported) return { supported: false, value: undefined };
        return {
          supported: true,
          value: ev.value == null ? null : String(ev.value).toLowerCase(),
        };
      }

      if (fnCall.funcName === 'TRIM' && argExprs.length === 1) {
        const ev = await this.evalExpression(argExprs[0]!, params, paramCursor, rowContext);
        if (!ev.supported) return { supported: false, value: undefined };
        return {
          supported: true,
          value: ev.value == null ? null : String(ev.value).trim(),
        };
      }

      const regFn = this.functions.get(fnCall.funcName);
      if (regFn && regFn.engine === 'psql-bridge') {
        const argVals: unknown[] = [];
        for (const a of argExprs) {
          const ev = await this.evalExpression(a, params, paramCursor, rowContext);
          if (!ev.supported) return { supported: false, value: undefined };
          argVals.push(ev.value);
        }
        const rawOut = await regFn.fn(...argVals);
        const coerced = coerceValueToSqlType(rawOut, regFn.returns);
        return { supported: true, value: coerced };
      }

      return { supported: false, value: undefined };
    }

    // Column identifier lookup when `rowContext` is provided
    if (rowContext) {
      const colMatch =
        /^(?:("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*\.\s*)?("?[A-Za-z_][A-Za-z0-9_$]*"?)$/.exec(
          expr,
        );
      if (colMatch) {
        const rawCol = colMatch[2]!;
        const colName = rawCol.startsWith('"')
          ? rawCol.slice(1, -1).replace(/""/g, '"')
          : rawCol;
        const val = findRecordProperty(rowContext, colName);
        if (val !== undefined) {
          return { supported: true, value: val };
        }
      }
    }

    return { supported: false, value: undefined };
  }

  /**
   * Evaluate a boolean `WHERE` condition against `rowContext`.
   */
  private async evalCondition(
    rawCond: string,
    params: readonly unknown[],
    paramCursor: { index: number },
    rowContext: Record<string, unknown>,
  ): Promise<boolean> {
    const cond = stripOuterParens(rawCond);
    if (!cond) return true;

    const orParts = splitKeywordOperatorTopLevel(cond, 'OR');
    if (orParts) {
      let anyTrue = false;
      for (const part of orParts) {
        const ok = await this.evalCondition(part, params, paramCursor, rowContext);
        if (ok) anyTrue = true;
      }
      return anyTrue;
    }

    const andParts = splitKeywordOperatorTopLevel(cond, 'AND');
    if (andParts) {
      let allTrue = true;
      for (const part of andParts) {
        const ok = await this.evalCondition(part, params, paramCursor, rowContext);
        if (!ok) allTrue = false;
      }
      return allTrue;
    }

    const notMatch = /^NOT\s+([\s\S]+)$/i.exec(cond);
    if (notMatch) {
      return !(await this.evalCondition(
        notMatch[1]!,
        params,
        paramCursor,
        rowContext,
      ));
    }

    const isNotNullMatch = /^([\s\S]+?)\s+IS\s+NOT\s+NULL$/i.exec(cond);
    if (isNotNullMatch) {
      const ev = await this.evalExpression(
        isNotNullMatch[1]!,
        params,
        paramCursor,
        rowContext,
      );
      return ev.supported && ev.value !== null && ev.value !== undefined;
    }

    const isNullMatch = /^([\s\S]+?)\s+IS\s+NULL$/i.exec(cond);
    if (isNullMatch) {
      const ev = await this.evalExpression(
        isNullMatch[1]!,
        params,
        paramCursor,
        rowContext,
      );
      return ev.supported && (ev.value === null || ev.value === undefined);
    }

    const operators = ['<>', '!=', '<=', '>=', '=', '<', '>'] as const;
    for (const op of operators) {
      const split = splitBinaryOperatorTopLevel(cond, op);
      if (split) {
        const left = await this.evalExpression(
          split[0],
          params,
          paramCursor,
          rowContext,
        );
        const right = await this.evalExpression(
          split[1],
          params,
          paramCursor,
          rowContext,
        );
        if (!left.supported || !right.supported) {
          return false;
        }
        if (
          left.value === null ||
          left.value === undefined ||
          right.value === null ||
          right.value === undefined
        ) {
          return false;
        }
        const lv = left.value as number | string | boolean;
        const rv = right.value as number | string | boolean;
        switch (op) {
          case '=':
            return lv === rv || String(lv) === String(rv);
          case '<>':
          case '!=':
            return lv !== rv && String(lv) !== String(rv);
          case '<':
            return lv < rv;
          case '<=':
            return lv <= rv;
          case '>':
            return lv > rv;
          case '>=':
            return lv >= rv;
        }
      }
    }

    const likeMatch = /^([\s\S]+?)\s+(NOT\s+)?(LIKE|CONTAINING|STARTING\s+WITH)\s+([\s\S]+)$/i.exec(
      cond,
    );
    if (likeMatch) {
      const left = await this.evalExpression(
        likeMatch[1]!,
        params,
        paramCursor,
        rowContext,
      );
      const right = await this.evalExpression(
        likeMatch[4]!,
        params,
        paramCursor,
        rowContext,
      );
      if (
        !left.supported ||
        !right.supported ||
        left.value == null ||
        right.value == null
      ) {
        return false;
      }
      const negated = Boolean(likeMatch[2]);
      const mode = likeMatch[3]!.toUpperCase().replace(/\s+/g, ' ');
      const s = String(left.value);
      const pat = String(right.value);
      let matched = false;
      if (mode === 'CONTAINING') {
        matched = s.toLowerCase().includes(pat.toLowerCase());
      } else if (mode === 'STARTING WITH') {
        matched = s.startsWith(pat);
      } else {
        const regexSrc =
          '^' +
          pat
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.') +
          '$';
        matched = new RegExp(regexSrc, 's').test(s);
      }
      return negated ? !matched : matched;
    }

    const single = await this.evalExpression(cond, params, paramCursor, rowContext);
    return single.supported && Boolean(single.value);
  }

  /**
   * Rewrite any constant/parameter calls to registered `'psql-bridge'` scalar
   * functions in `sql` before sending the statement to Firebird.
   */
  async rewriteStatement(
    sql: string,
    params: QueryParams,
  ): Promise<{ sql: string; params: QueryParams }> {
    if (!this.hasBridgeRoutines) {
      return { sql, params };
    }

    let currentSql = sql;
    let currentParams = [...params];

    // Iteratively evaluate innermost constant/parameter calls to registered functions.
    for (let pass = 0; pass < 8; pass++) {
      const match = await this.findAndEvalOneConstantFunctionCall(
        currentSql,
        currentParams,
      );
      if (!match) break;
      currentSql = match.sql;
      currentParams = match.params;
    }

    return { sql: currentSql, params: currentParams };
  }

  private async findAndEvalOneConstantFunctionCall(
    sql: string,
    params: QueryParams,
  ): Promise<{ sql: string; params: QueryParams } | null> {
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < sql.length; i++) {
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

      // Match an identifier followed by `(`
      const prevChar = i > 0 ? sql[i - 1]! : ' ';
      if (/[A-Za-z0-9_$."]/.test(prevChar)) {
        continue;
      }

      const identMatch = /^("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*\(/.exec(
        sql.slice(i),
      );
      if (!identMatch) continue;

      const rawIdent = identMatch[1]!;
      const normName = rawIdent.startsWith('"')
        ? rawIdent.slice(1, -1).replace(/""/g, '"').toUpperCase()
        : rawIdent.toUpperCase();

      const regFn = this.functions.get(normName);
      if (!regFn || regFn.engine !== 'psql-bridge') {
        continue;
      }

      // Skip DDL statements (`CREATE/ALTER/DROP FUNCTION`)
      if (/^\s*(?:CREATE|RECREATE|ALTER|DROP)\s+(?:OR\s+ALTER\s+)?FUNCTION\b/i.test(sql)) {
        return null;
      }
      // Skip `COMPUTED BY (...)` definitions inside `CREATE/ALTER TABLE`
      if (/^\s*(?:CREATE|RECREATE|ALTER)\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\b/i.test(sql)) {
        return null;
      }

      const openParenIdx = i + identMatch[0].length - 1;
      const closeParenIdx = findMatchingCloseParen(sql, openParenIdx);
      if (closeParenIdx === -1) continue;

      const argsRaw = sql.slice(openParenIdx + 1, closeParenIdx);
      const argExprs = argsRaw.trim() ? splitTopLevelCommaList(argsRaw) : [];

      const paramsBefore = countPlaceholders(sql.slice(0, i));
      const paramsInside = countPlaceholders(argsRaw);
      const cursor = { index: paramsBefore };

      const argValues: unknown[] = [];
      let allSupported = true;
      for (const argExpr of argExprs) {
        const ev = await this.evalExpression(argExpr, params, cursor, undefined);
        if (!ev.supported) {
          allSupported = false;
          break;
        }
        argValues.push(ev.value);
      }

      if (!allSupported) {
        continue;
      }

      const rawReturn = await regFn.fn(...argValues);
      const coercedReturn = coerceValueToSqlType(rawReturn, regFn.returns);

      // Check whether this call sits directly in a SELECT list without an alias,
      // so `SELECT SLUGIFY('a') FROM RDB$DATABASE` keeps column name `SLUGIFY`.
      const beforeCall = sql.slice(0, i);
      const afterCall = sql.slice(closeParenIdx + 1);
      const needsSelectAlias =
        isTopLevelSelectItemStart(beforeCall) &&
        /^\s*(?:,|\bFROM\b)/i.test(afterCall);

      const replacementExpr =
        `CAST(? AS ${regFn.returns})` +
        (needsSelectAlias ? ` AS ${quoteIdent(regFn.name)}` : '');

      const newParams = [
        ...params.slice(0, paramsBefore),
        coercedReturn as QueryParams[number],
        ...params.slice(paramsBefore + paramsInside),
      ];
      const newSql = beforeCall + replacementExpr + afterCall;
      return { sql: newSql, params: newParams };
    }

    return null;
  }

  /**
   * Intercept `EXECUTE PROCEDURE` in `db.exec()` when targeting a `'psql-bridge'` procedure.
   */
  async executeIfIntercepted(
    sql: string,
    params: QueryParams,
  ): Promise<{ intercepted: boolean; affectedRows: number }> {
    if (!this.hasBridgeRoutines) {
      return { intercepted: false, affectedRows: 0 };
    }
    const execProc = await this.tryExecuteProcedure(sql, params, 'object');
    if (execProc) {
      return { intercepted: true, affectedRows: 0 };
    }
    return { intercepted: false, affectedRows: 0 };
  }

  /**
   * Intercept `SELECT` or `EXECUTE PROCEDURE` in `db.query()` when targeting
   * a `'psql-bridge'` procedure, a scalar function with column arguments, or a
   * `COMPUTED BY` column backed by a registered JS function.
   */
  async queryIfIntercepted<T = Row>(
    sql: string,
    params: QueryParams,
    rowMode: RowMode,
    executor: UdrSqlExecutor,
  ): Promise<QueryResult<T> | null> {
    if (!this.hasBridgeRoutines) {
      return null;
    }

    // 1. `EXECUTE PROCEDURE <procName>(...)`
    const execProc = await this.tryExecuteProcedure<T>(sql, params, rowMode);
    if (execProc) {
      return execProc;
    }

    // 2. `SELECT ... FROM <procName>(...) ...`
    const selectProc = await this.trySelectFromProcedure<T>(sql, params, rowMode);
    if (selectProc) {
      return selectProc;
    }

    // 3. `SELECT ... FROM <tableName> ...` referencing a bridge function on columns
    //    or a tracked `COMPUTED BY` column.
    const selectTable = await this.trySelectWithBridgeColumns<T>(
      sql,
      params,
      rowMode,
      executor,
    );
    if (selectTable) {
      return selectTable;
    }

    return null;
  }

  private async tryExecuteProcedure<T = Row>(
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
    const proc = this.procedures.get(procName);
    if (!proc || proc.engine !== 'psql-bridge') {
      return null;
    }

    const argsRaw = match[2] ?? '';
    const argExprs = argsRaw.trim() ? splitTopLevelCommaList(argsRaw) : [];
    const cursor = { index: 0 };
    const argValues: unknown[] = [];
    for (const expr of argExprs) {
      const ev = await this.evalExpression(expr, params, cursor, undefined);
      argValues.push(ev.supported ? ev.value : null);
    }

    const rawResult = await proc.fn(...argValues);
    if (proc.returns.length === 0) {
      return { rows: [], fields: [] };
    }

    const wireRows = await normalizeProcedureRowsAsync(rawResult, proc.returns);
    const firstRow = wireRows[0] ?? proc.returns.map(() => null);
    const fields = proc.returns.map((c) => ({ ...c.fieldInfo }));
    const row =
      rowMode === 'array'
        ? (firstRow as unknown as T)
        : (Object.fromEntries(
            proc.returns.map((c, idx) => [c.name, firstRow[idx]]),
          ) as unknown as T);
    return { rows: [row], fields };
  }

  private async trySelectFromProcedure<T = Row>(
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
    const proc = this.procedures.get(procName);
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
      const ev = await this.evalExpression(expr, params, fromCursor, undefined);
      procArgValues.push(ev.supported ? ev.value : null);
    }

    const rawResult = await proc.fn(...procArgValues);
    const wireRows = await normalizeProcedureRowsAsync(rawResult, proc.returns);
    const objectRows: Record<string, unknown>[] = wireRows.map((tuple) =>
      Object.fromEntries(proc.returns.map((c, idx) => [c.name, tuple[idx]])),
    );

    const paramsBeforeWhere =
      paramsBeforeFrom + countPlaceholders(parsed.fromArgsRaw);

    return this.filterSortAndProjectRows<T>(
      objectRows,
      proc.returns.map((c) => ({ ...c.fieldInfo })),
      parsed,
      params,
      paramsBeforeWhere,
      rowMode,
    );
  }

  private async trySelectWithBridgeColumns<T = Row>(
    sql: string,
    params: QueryParams,
    rowMode: RowMode,
    executor: UdrSqlExecutor,
  ): Promise<QueryResult<T> | null> {
    const parsed = parseSimpleSelectStatement(sql);
    if (!parsed || parsed.fromIsCall) return null;

    const tableName = normalizeRoutineIdentifier(parsed.fromName, 'table name');
    if (tableName === 'RDB$DATABASE') return null;

    const computedForTable = this.computedColumns.get(tableName);
    const mentionsBridgeFn = this.sqlMentionsBridgeFunction(sql);
    const hasComputedCols = Boolean(
      computedForTable && computedForTable.size > 0,
    );

    if (!mentionsBridgeFn && !hasComputedCols) {
      return null;
    }

    // Fetch base rows from the table
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
          const ev = await this.evalExpression(
            comp.expression,
            [],
            { index: 0 },
            rowCopy,
          );
          if (ev.supported) {
            rowCopy[comp.columnName] = ev.value;
          }
        }
      }
      enrichedRows.push(rowCopy);
    }

    const paramsBeforeWhere = countPlaceholders(parsed.selectRaw);
    return this.filterSortAndProjectRows<T>(
      enrichedRows,
      baseResult.fields,
      parsed,
      params,
      paramsBeforeWhere,
      rowMode,
    );
  }

  private sqlMentionsBridgeFunction(sql: string): boolean {
    const upper = sql.toUpperCase();
    for (const fn of this.functions.values()) {
      if (fn.engine === 'psql-bridge' && upper.includes(fn.name)) {
        return true;
      }
    }
    return false;
  }

  private async filterSortAndProjectRows<T = Row>(
    sourceRows: Record<string, unknown>[],
    sourceFields: FieldInfo[],
    parsed: ParsedSelectStatement,
    params: QueryParams,
    paramsBeforeWhere: number,
    rowMode: RowMode,
  ): Promise<QueryResult<T>> {
    // 1. Filter by WHERE clause
    let filtered = sourceRows;
    if (parsed.whereRaw) {
      const next: Record<string, unknown>[] = [];
      for (const row of sourceRows) {
        const cursor = { index: paramsBeforeWhere };
        const matched = await this.evalCondition(
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

    // 2. Sort by ORDER BY clause
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
            const ev = await this.evalExpression(
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

    // 3. Project SELECT list
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
      const regFn = fnCall ? this.functions.get(fnCall.funcName) : undefined;
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
        const ev = await this.evalExpression(plan.expr, params, cursor, row);
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
}

// ---------------------------------------------------------------------------
// Select Statement Parser Helpers
// ---------------------------------------------------------------------------

interface ParsedSelectStatement {
  selectRaw: string;
  fromName: string;
  fromIsCall: boolean;
  fromArgsRaw: string;
  whereRaw?: string;
  orderByRaw?: string;
}

function findMatchingCloseParen(sql: string, openParenIdx: number): number {
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

function isTopLevelSelectItemStart(beforeSql: string): boolean {
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

function findTopLevelKeyword(
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

function parseSimpleSelectStatement(sql: string): ParsedSelectStatement | null {
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

function splitSelectAlias(item: string): { expr: string; alias: string } {
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
