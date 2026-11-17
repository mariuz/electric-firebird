/**
 * virtual-table.ts – Declarative Virtual Tables & Remote `/arrow` Federation
 * (`db.registerVirtualTable()`) (`M23 Item 4`).
 *
 * Mounts Apache Arrow IPC V5 buffers/streams, remote `serve-sync` `/arrow` or
 * JSON/JSONL/CSV HTTP endpoints, inline CSV/JSONL data, or async JS iterables
 * as SQL-queryable Firebird relations (`SELECT ... JOIN`, `GROUP BY`, indexes,
 * CTEs, prepared statements) backed by zero-copy `"FBP\x02"` Arrow ingestion.
 */

import type { FieldInfo, QueryParams, QueryResult, Row } from './types';
import {
  decodeArrowIpc,
  rowsToColumnarResult,
  type ColumnarQueryResult,
} from './columnar';
import { collectArrowStreamBytes } from './columnar-stream';
import {
  buildCreateTableDdlFromColumnar,
  loadArrowIpcIntoDatabase,
  type ArrowIngestHost,
  type ArrowIngestResult,
  type ArrowIngestSource,
} from './arrow-ingest';
import { quoteTableIdent } from './table-api';

export interface VirtualTableColumnDef {
  readonly name: string;
  readonly sqlType: string;
  readonly nullable?: boolean;
}

export interface VirtualTableUrlSource {
  /** HTTP(S) URL returning Apache Arrow IPC (`GET /arrow?sql=...`), JSON, JSONL, or CSV. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly format?: 'arrow' | 'json' | 'jsonl' | 'csv';
  readonly fetch?: typeof globalThis.fetch;
  readonly delimiter?: string;
}

export interface VirtualTableTextSource {
  readonly format: 'csv' | 'jsonl' | 'json';
  readonly data: string | Uint8Array | ReadableStream<Uint8Array>;
  readonly delimiter?: string;
  readonly header?: boolean;
}

export type VirtualTableResolvedData =
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | ColumnarQueryResult
  | ReadonlyArray<Row>
  | AsyncIterable<Row>
  | VirtualTableUrlSource
  | VirtualTableTextSource;

export type VirtualTableProvider =
  | VirtualTableResolvedData
  | (() => VirtualTableResolvedData | Promise<VirtualTableResolvedData>);

export interface VirtualTableOptions {
  /** Optional primary key column(s) (`PRIMARY KEY (...)` + `UPDATE OR INSERT ... MATCHING`). */
  primaryKey?: string | readonly string[];
  /** Explicit column definitions overriding automatic Arrow / sample-row schema inference. */
  columns?: readonly VirtualTableColumnDef[];
  /** Optional time-to-live in milliseconds used by `isStale()` and `ensureFresh()`. */
  ttlMs?: number;
  /** Optional secondary index definitions (column name or composite column list). */
  indexes?: ReadonlyArray<string | readonly string[]>;
  /** Drop and recreate the backing table if it already exists on registration. @default true */
  replaceExisting?: boolean;
}

export interface VirtualTableRefreshResult {
  readonly rowCount: number;
  readonly batchesExecuted: number;
  readonly refreshedAt: number;
}

export interface VirtualTableHandle {
  readonly tableName: string;
  readonly fields: readonly FieldInfo[];
  readonly rowCount: number;
  readonly lastRefreshedAt: number;
  /** Returns `true` when `ttlMs` is configured and elapsed since `lastRefreshedAt`. */
  isStale(nowMs?: number): boolean;
  /** Re-fetches from `provider` only when `isStale()` is `true`; returns `true` if refreshed. */
  ensureFresh(): Promise<boolean>;
  /** Unconditionally re-evaluates `provider` and replaces/upserts the virtual table contents. */
  refresh(): Promise<VirtualTableRefreshResult>;
  /** Drops the virtual table from the database catalog (`DROP TABLE`). */
  drop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface VirtualTableDatabaseHost extends ArrowIngestHost {
  query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
  execute(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  loadArrowIpc?(
    tableName: string,
    source: ArrowIngestSource,
    options?: {
      createTable?: boolean;
      primaryKey?: string | readonly string[];
      upsertMatching?: string | readonly string[];
    },
  ): Promise<ArrowIngestResult>;
}

function isReadableByteStream(val: unknown): val is ReadableStream<Uint8Array> {
  return (
    typeof val === 'object' &&
    val !== null &&
    'getReader' in val &&
    typeof (val as ReadableStream<Uint8Array>).getReader === 'function'
  );
}

function isAsyncIterableRows(val: unknown): val is AsyncIterable<Row> {
  return (
    typeof val === 'object' &&
    val !== null &&
    Symbol.asyncIterator in val &&
    !isReadableByteStream(val)
  );
}

function isColumnarResult(val: unknown): val is ColumnarQueryResult {
  return (
    typeof val === 'object' &&
    val !== null &&
    'rowCount' in val &&
    'fields' in val &&
    'vectors' in val &&
    typeof (val as ColumnarQueryResult).toArrowIpc === 'function'
  );
}

function isUrlSource(val: unknown): val is VirtualTableUrlSource {
  return (
    typeof val === 'object' &&
    val !== null &&
    'url' in val &&
    typeof (val as VirtualTableUrlSource).url === 'string'
  );
}

function isTextSource(val: unknown): val is VirtualTableTextSource {
  return (
    typeof val === 'object' &&
    val !== null &&
    'format' in val &&
    'data' in val &&
    ((val as VirtualTableTextSource).format === 'csv' ||
      (val as VirtualTableTextSource).format === 'jsonl' ||
      (val as VirtualTableTextSource).format === 'json')
  );
}

async function readTextData(
  data: string | Uint8Array | ReadableStream<Uint8Array>,
): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  const bytes = await collectArrowStreamBytes(data);
  return new TextDecoder().decode(bytes);
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function coerceCsvCell(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const f = Number(trimmed);
    if (Number.isFinite(f)) return f;
  }
  return raw;
}

function parseTextRows(
  text: string,
  format: 'csv' | 'jsonl' | 'json',
  delimiter = ',',
  hasHeader = true,
): Row[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (format === 'json') {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as Row[];
    if (parsed && typeof parsed === 'object' && 'rows' in parsed && Array.isArray((parsed as { rows: unknown }).rows)) {
      return (parsed as { rows: Row[] }).rows;
    }
    return [parsed as Row];
  }
  if (format === 'jsonl') {
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);
  }
  // CSV
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const firstCells = parseCsvLine(lines[0]!, delimiter);
  const headers = hasHeader
    ? firstCells.map((h, i) => h.trim().toUpperCase() || `COL_${i + 1}`)
    : firstCells.map((_, i) => `COL_${i + 1}`);
  const startRow = hasHeader ? 1 : 0;
  const rows: Row[] = [];
  for (let r = startRow; r < lines.length; r++) {
    const cells = parseCsvLine(lines[r]!, delimiter);
    const obj: Row = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]!] = coerceCsvCell(cells[c] ?? '');
    }
    rows.push(obj);
  }
  return rows;
}

function inferFieldsFromRows(
  rows: readonly Row[],
  explicitColumns?: readonly VirtualTableColumnDef[],
): FieldInfo[] {
  if (explicitColumns && explicitColumns.length > 0) {
    return explicitColumns.map((c) => {
      const upperType = c.sqlType.toUpperCase();
      let typeName: FieldInfo['typeName'] = 'VARYING';
      if (upperType.includes('BIGINT')) typeName = 'BIGINT';
      else if (upperType.includes('INT')) typeName = 'INTEGER';
      else if (upperType.includes('DOUBLE') || upperType.includes('FLOAT')) typeName = 'DOUBLE';
      else if (upperType.includes('BOOL')) typeName = 'BOOLEAN';
      else if (upperType.includes('BLOB')) typeName = 'BLOB';
      return {
        name: c.name.toUpperCase(),
        typeName,
        nullable: c.nullable ?? true,
      };
    });
  }

  const colNames: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      const upper = k.toUpperCase();
      if (!seen.has(upper)) {
        seen.add(upper);
        colNames.push(upper);
      }
    }
  }

  return colNames.map((col) => {
    let inferredType: FieldInfo['typeName'] = 'VARYING';
    for (const r of rows) {
      const val = r[col] ?? r[col.toLowerCase()];
      if (val === null || val === undefined) continue;
      if (typeof val === 'boolean') inferredType = 'BOOLEAN';
      else if (typeof val === 'bigint') inferredType = 'BIGINT';
      else if (val instanceof Uint8Array) inferredType = 'BLOB';
      else if (typeof val === 'number') {
        inferredType =
          Number.isInteger(val) && val >= -2147483648 && val <= 2147483647
            ? 'INTEGER'
            : 'DOUBLE';
      } else {
        inferredType = 'VARYING';
      }
      break;
    }
    if (inferredType === 'INTEGER') {
      for (const r of rows) {
        const val = r[col] ?? r[col.toLowerCase()];
        if (typeof val === 'number' && (!Number.isInteger(val) || val < -2147483648 || val > 2147483647)) {
          inferredType = 'DOUBLE';
          break;
        }
      }
    }
    return { name: col, typeName: inferredType, nullable: true };
  });
}

function buildExplicitCreateTableDdl(
  tableUpper: string,
  columns: readonly VirtualTableColumnDef[],
  primaryKey?: string | readonly string[],
): string {
  const pkCols = !primaryKey
    ? []
    : typeof primaryKey === 'string'
      ? [primaryKey.toUpperCase()]
      : primaryKey.map((k) => k.toUpperCase());
  const pkSet = new Set(pkCols);
  const defs = columns.map((c) => {
    const colUpper = c.name.toUpperCase();
    const notNull = pkSet.has(colUpper) || c.nullable === false ? ' NOT NULL' : '';
    return `${quoteTableIdent(colUpper)} ${c.sqlType}${notNull}`;
  });
  if (pkCols.length > 0) {
    defs.push(`PRIMARY KEY (${pkCols.map((k) => quoteTableIdent(k)).join(', ')})`);
  }
  return `CREATE TABLE ${quoteTableIdent(tableUpper)} (${defs.join(', ')})`;
}

async function resolveProviderToColumnar(
  provider: VirtualTableProvider,
  explicitColumns?: readonly VirtualTableColumnDef[],
): Promise<ColumnarQueryResult> {
  const raw = typeof provider === 'function' ? await provider() : provider;

  if (isColumnarResult(raw)) {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return decodeArrowIpc(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return decodeArrowIpc(new Uint8Array(raw));
  }
  if (isReadableByteStream(raw)) {
    const bytes = await collectArrowStreamBytes(raw);
    return decodeArrowIpc(bytes);
  }
  if (isUrlSource(raw)) {
    const fetchFn = raw.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      throw new Error('registerVirtualTable({ url }) requires globalThis.fetch or options.fetch');
    }
    const acceptHeader =
      raw.format === 'arrow'
        ? 'application/vnd.apache.arrow.stream, application/octet-stream'
        : raw.format === 'csv'
          ? 'text/csv'
          : 'application/vnd.apache.arrow.stream, application/json';
    const res = await fetchFn(raw.url, {
      method: 'GET',
      headers: {
        accept: acceptHeader,
        ...(raw.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(
        `Virtual table fetch('${raw.url}') failed with HTTP ${res.status}`,
      );
    }
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    const effectiveFormat =
      raw.format ??
      (ctype.includes('arrow') || ctype.includes('octet-stream')
        ? 'arrow'
        : ctype.includes('csv')
          ? 'csv'
          : ctype.includes('jsonl') || ctype.includes('ndjson')
            ? 'jsonl'
            : 'json');

    if (effectiveFormat === 'arrow') {
      const buf = new Uint8Array(await res.arrayBuffer());
      return decodeArrowIpc(buf);
    }
    const text = await res.text();
    const rows = parseTextRows(text, effectiveFormat, raw.delimiter ?? ',', true);
    const normalized = rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r)) o[k.toUpperCase()] = v;
      return o;
    });
    const fields = inferFieldsFromRows(normalized, explicitColumns);
    return rowsToColumnarResult({ fields, rows: normalized });
  }
  if (isTextSource(raw)) {
    const text = await readTextData(raw.data);
    const rows = parseTextRows(
      text,
      raw.format,
      raw.delimiter ?? ',',
      raw.header ?? true,
    );
    const normalized = rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r)) o[k.toUpperCase()] = v;
      return o;
    });
    const fields = inferFieldsFromRows(normalized, explicitColumns);
    return rowsToColumnarResult({ fields, rows: normalized });
  }
  if (isAsyncIterableRows(raw)) {
    const rows: Row[] = [];
    for await (const item of raw) {
      const o: Row = {};
      for (const [k, v] of Object.entries(item)) o[k.toUpperCase()] = v;
      rows.push(o);
    }
    const fields = inferFieldsFromRows(rows, explicitColumns);
    return rowsToColumnarResult({ fields, rows });
  }
  if (Array.isArray(raw)) {
    const rows = raw.map((item) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(item as Row)) o[k.toUpperCase()] = v;
      return o;
    });
    const fields = inferFieldsFromRows(rows, explicitColumns);
    return rowsToColumnarResult({ fields, rows });
  }

  throw new TypeError('Unsupported VirtualTableProvider source');
}

/**
 * Mount a declarative virtual table on `db` backed by Apache Arrow IPC, remote
 * HTTP `/arrow` / JSON / CSV endpoints, or JS iterables (`M23 Item 4`).
 */
export async function registerVirtualTableOnDatabase(
  db: VirtualTableDatabaseHost,
  name: string,
  provider: VirtualTableProvider,
  options: VirtualTableOptions = {},
): Promise<VirtualTableHandle> {
  const tableUpper = name.trim().toUpperCase();
  if (!tableUpper) {
    throw new Error('registerVirtualTable requires a non-empty table name');
  }
  const quotedTable = quoteTableIdent(tableUpper);
  const replaceExisting = options.replaceExisting ?? true;

  if (replaceExisting) {
    try {
      const existing = await db.query<Row>(
        `SELECT 1 AS OK FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [tableUpper],
      );
      if (existing.rows.length > 0) {
        await db.execute(`DROP TABLE ${quotedTable}`);
      }
    } catch {
      // Ignore if table does not exist
    }
  }

  let tableCreated = false;
  let currentFields: FieldInfo[] = [];
  let currentRowCount = 0;
  let lastRefreshedAt = 0;
  let dropped = false;

  const ensureCreatedAndIndexes = async (colResult: ColumnarQueryResult): Promise<boolean> => {
    if (tableCreated) return false;
    currentFields = colResult.fields;
    if (currentFields.length === 0) {
      throw new Error(
        `registerVirtualTable('${tableUpper}'): cannot infer schema from empty source without options.columns`,
      );
    }

    let alreadyExists = false;
    try {
      const chk = await db.query<Row>(
        `SELECT 1 AS OK FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [tableUpper],
      );
      alreadyExists = chk.rows.length > 0;
    } catch {
      alreadyExists = false;
    }

    if (!alreadyExists) {
      const createDdl =
        options.columns && options.columns.length > 0
          ? buildExplicitCreateTableDdl(tableUpper, options.columns, options.primaryKey)
          : buildCreateTableDdlFromColumnar(tableUpper, currentFields, {
              primaryKey: options.primaryKey,
            });
      await db.execute(createDdl);
    }

    if (options.indexes && options.indexes.length > 0) {
      for (let i = 0; i < options.indexes.length; i++) {
        const idxSpec = options.indexes[i]!;
        const cols = typeof idxSpec === 'string' ? [idxSpec] : idxSpec;
        const idxName = `IDX_VT_${tableUpper}_${i + 1}`.slice(0, 31);
        const colList = cols.map((c) => quoteTableIdent(c.toUpperCase())).join(', ');
        await db
          .execute(`CREATE INDEX ${quoteTableIdent(idxName)} ON ${quotedTable} (${colList})`)
          .catch(() => undefined);
      }
    }
    tableCreated = true;
    return !alreadyExists;
  };

  const doRefresh = async (): Promise<VirtualTableRefreshResult> => {
    if (dropped) {
      throw new Error(`Virtual table '${tableUpper}' has been dropped`);
    }
    const colResult = await resolveProviderToColumnar(provider, options.columns);
    const justCreated = await ensureCreatedAndIndexes(colResult);

    if (!justCreated) {
      await db.execute(`DELETE FROM ${quotedTable}`);
    }

    let rowsIngested = 0;
    let batchesExecuted = 0;
    if (colResult.rowCount > 0) {
      const ingestRes =
        typeof db.loadArrowIpc === 'function'
          ? await db.loadArrowIpc(tableUpper, colResult, {
              primaryKey: options.primaryKey,
            })
          : await loadArrowIpcIntoDatabase(db, tableUpper, colResult, {
              primaryKey: options.primaryKey,
            });
      rowsIngested = ingestRes.rowsIngested;
      batchesExecuted = ingestRes.batchesExecuted;
    }

    currentRowCount = rowsIngested;
    lastRefreshedAt = Date.now();
    return {
      rowCount: currentRowCount,
      batchesExecuted,
      refreshedAt: lastRefreshedAt,
    };
  };

  await doRefresh();

  const handle: VirtualTableHandle = {
    tableName: tableUpper,
    get fields() {
      return currentFields;
    },
    get rowCount() {
      return currentRowCount;
    },
    get lastRefreshedAt() {
      return lastRefreshedAt;
    },

    isStale(nowMs = Date.now()): boolean {
      if (options.ttlMs === undefined || options.ttlMs <= 0) return false;
      return nowMs - lastRefreshedAt >= options.ttlMs;
    },

    async ensureFresh(): Promise<boolean> {
      if (!handle.isStale()) return false;
      await doRefresh();
      return true;
    },

    refresh: doRefresh,

    async drop(): Promise<void> {
      if (dropped) return;
      dropped = true;
      await db.execute(`DROP TABLE ${quotedTable}`).catch(() => undefined);
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await handle.drop();
    },
  };

  return handle;
}
