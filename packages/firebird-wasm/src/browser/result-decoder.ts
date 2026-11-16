/**
 * result-decoder.ts – Result-set JSON/shape decoding, hidden-class row builders,
 * BLOB side-channel attachment, and `IAttachment::getInfo` diagnostics (`M21 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import { lastError } from '../wasm-loader';
import type {
  Row,
  QueryResult,
  QueryDescription,
  DatabaseInfo,
  SweepResult,
  FieldInfo,
  QueryParams,
  RowMode,
} from '../types';
import { firebirdTypeName } from './field-types';
import { extractReferencedTables } from './live-tables';
import { statementKind } from '../statement-types';

/**
 * Build an Error carrying whatever the engine reported.
 */
export function engineError(
  mod: FirebirdWasmModule,
  context: string,
  code?: number,
): Error {
  const detail = lastError(mod);
  const suffix = code === undefined ? '' : ` (code ${code})`;
  return new Error(detail ? `${context}${suffix}: ${detail}` : `${context}${suffix}`);
}

/** How the engine describes one column. */
export interface EncodedColumn {
  name: string;
  type: number;
  subType: number;
  scale: number;
  length: number;
  nullable: boolean;
}

const fieldLists = new Map<string, readonly FieldInfo[]>();
export const MAX_FIELD_LISTS = 256;

const COLUMNS_PREFIX = '{"columns":';
const SHAPE_PREFIX = '{"shape":';
const ROWS_KEY = ',"rows":';
const ROWS_INFIX = '],"rows":';

function splitResultSet(
  json: string,
  shapes?: (id: number) => readonly FieldInfo[],
): { columns: readonly FieldInfo[]; rows: unknown[][] } {
  if (shapes && json.startsWith(SHAPE_PREFIX)) {
    const comma = json.indexOf(',', SHAPE_PREFIX.length);
    const id = Number(json.slice(SHAPE_PREFIX.length, comma));
    const rows = JSON.parse(json.slice(comma + ROWS_KEY.length, -1)) as unknown[][];
    return { columns: shapes(id), rows };
  }

  const split = json.startsWith(COLUMNS_PREFIX) && json.endsWith('}') ? json.indexOf(ROWS_INFIX) : -1;
  if (split < 0) {
    const parsed = JSON.parse(json) as { columns: EncodedColumn[]; rows: unknown[][] };
    return { columns: toFields(parsed.columns), rows: parsed.rows };
  }

  const columnsText = json.slice(COLUMNS_PREFIX.length, split + 1);
  let columns = fieldLists.get(columnsText);
  if (!columns) {
    columns = toFields(JSON.parse(columnsText) as EncodedColumn[]);
    if (fieldLists.size >= MAX_FIELD_LISTS) fieldLists.clear();
    fieldLists.set(columnsText, columns);
  }
  const rows = JSON.parse(json.slice(split + ROWS_INFIX.length, -1)) as unknown[][];
  return { columns, rows };
}

export function toFields(columns: EncodedColumn[]): FieldInfo[] {
  return columns.map((c) => ({
    name: c.name,
    type: c.type,
    typeName: firebirdTypeName(c.type, c.scale),
    subType: c.subType,
    scale: c.scale,
    length: c.length,
    nullable: c.nullable,
  }));
}

const rowBuilders = new Map<string, (cols: unknown[]) => Row>();
const MAX_ROW_BUILDERS = 64;
let codeGenerationBlocked = false;

function stringLiteral(name: string): string {
  return JSON.stringify(name)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function rowBuilder(names: string[]): ((cols: unknown[]) => Row) | null {
  if (codeGenerationBlocked || names.includes('__proto__')) {
    return null;
  }

  const signature = names.join('\u0000');
  const cached = rowBuilders.get(signature);
  if (cached) return cached;

  let built: (cols: unknown[]) => Row;
  try {
    built = new Function(
      'c',
      'return {' + names.map((n, i) => `${stringLiteral(n)}:c[${i}]`).join(',') + '}',
    ) as (cols: unknown[]) => Row;
  } catch {
    codeGenerationBlocked = true;
    return null;
  }

  if (rowBuilders.size >= MAX_ROW_BUILDERS) {
    rowBuilders.clear();
  }
  rowBuilders.set(signature, built);
  return built;
}

export function decodeResultSet<T = Row>(
  json: string,
  rowMode: RowMode = 'object',
  shapes?: (id: number) => readonly FieldInfo[],
): QueryResult<T> {
  const { columns, rows: encodedRows } = splitResultSet(json, shapes);
  const fields: FieldInfo[] = columns.map((f) => ({ ...f }));

  if (rowMode === 'array') {
    return { rows: encodedRows as T[], fields };
  }

  const names = fields.map((f) => f.name);
  const build = rowBuilder(names);

  const rows = (
    build
      ? encodedRows.map(build)
      : encodedRows.map((cols) =>
          Object.fromEntries(names.map((name, i) => [name, cols[i]])),
        )
  ) as T[];

  return { rows, fields };
}

export function decodeField(c: EncodedColumn): FieldInfo {
  return {
    name: c.name,
    type: c.type,
    typeName: firebirdTypeName(c.type, c.scale),
    subType: c.subType,
    scale: c.scale,
    length: c.length,
    nullable: c.nullable,
  };
}

/** `isc_info_*` tags requested by `databaseInfo()` (`IAttachment::getInfo`). */
export const DATABASE_INFO_REQUEST_ITEMS = new Uint8Array([
  14, // isc_info_page_size
  21, // isc_info_allocation
  32, // isc_info_ods_version
  33, // isc_info_ods_minor_version
  104, // isc_info_oldest_transaction
  105, // isc_info_oldest_active
  106, // isc_info_oldest_snapshot
  107, // isc_info_next_transaction
  17, // isc_info_current_memory
  18, // isc_info_max_memory
  15, // isc_info_num_buffers
  5, // isc_info_reads
  6, // isc_info_writes
  7, // isc_info_fetches
  8, // isc_info_marks
]);

function readPortableInt(buffer: Uint8Array, offset: number, length: number): number {
  let value = 0;
  let multiplier = 1;
  const n = Math.min(length, 8);
  for (let i = 0; i < n; i++) {
    value += (buffer[offset + i] ?? 0) * multiplier;
    multiplier *= 256;
  }
  return value;
}

export function parseDatabaseInfoBuffer(buffer: Uint8Array): DatabaseInfo {
  let pageSize = 0;
  let allocatedPages = 0;
  let odsVersion = 0;
  let odsMinorVersion = 0;
  let oldestTransaction = 0;
  let oldestActive = 0;
  let oldestSnapshot = 0;
  let nextTransaction = 0;
  let currentMemory = 0;
  let maxMemory = 0;
  let pageBuffers = 0;
  let reads = 0;
  let writes = 0;
  let fetches = 0;
  let marks = 0;

  let pos = 0;
  while (pos < buffer.length) {
    const tag = buffer[pos++]!;
    if (tag === 0 || tag === 1 || tag === 2) break;
    if (pos + 2 > buffer.length) break;
    const len = buffer[pos]! | (buffer[pos + 1]! << 8);
    pos += 2;
    if (pos + len > buffer.length) break;
    const val = readPortableInt(buffer, pos, len);
    pos += len;

    switch (tag) {
      case 14: pageSize = val; break;
      case 21: allocatedPages = val; break;
      case 32: odsVersion = val; break;
      case 33: odsMinorVersion = val; break;
      case 104: oldestTransaction = val; break;
      case 105: oldestActive = val; break;
      case 106: oldestSnapshot = val; break;
      case 107: nextTransaction = val; break;
      case 17: currentMemory = val; break;
      case 18: maxMemory = val; break;
      case 15: pageBuffers = val; break;
      case 5: reads = val; break;
      case 6: writes = val; break;
      case 7: fetches = val; break;
      case 8: marks = val; break;
      default: break;
    }
  }

  return normalizeDatabaseInfo({
    pageSize,
    allocatedPages,
    odsVersion,
    odsMinorVersion,
    oldestTransaction,
    oldestActive,
    oldestSnapshot,
    nextTransaction,
    currentMemory,
    maxMemory,
    pageBuffers,
    reads,
    writes,
    fetches,
    marks,
  });
}

export function normalizeDatabaseInfo(raw: Partial<DatabaseInfo>): DatabaseInfo {
  const pageSize = Number(raw.pageSize ?? 0);
  const allocatedPages = Number(raw.allocatedPages ?? 0);
  const databaseSizeBytes = Number(raw.databaseSizeBytes ?? pageSize * allocatedPages);
  const odsVersion = Number(raw.odsVersion ?? 0);
  const odsMinorVersion = Number(raw.odsMinorVersion ?? 0);
  const oldestTransaction = Number(raw.oldestTransaction ?? 0);
  const rawOldestActive = Number(raw.oldestActive ?? 0);
  const oldestActive = rawOldestActive > 0 ? rawOldestActive : oldestTransaction;
  const rawOldestSnapshot = Number(raw.oldestSnapshot ?? 0);
  const oldestSnapshot = rawOldestSnapshot > 0 ? rawOldestSnapshot : oldestActive;
  const rawNextTransaction = Number(raw.nextTransaction ?? 0);
  const nextTransaction = rawNextTransaction > 0 ? rawNextTransaction : oldestActive;
  const transactionGap = Number(
    raw.transactionGap ?? (nextTransaction >= oldestActive ? nextTransaction - oldestActive : 0),
  );
  const currentMemory = Number(raw.currentMemory ?? 0);
  const maxMemory = Number(raw.maxMemory ?? 0);
  const pageBuffers = Number(raw.pageBuffers ?? 0);
  const reads = Number(raw.reads ?? 0);
  const writes = Number(raw.writes ?? 0);
  const fetches = Number(raw.fetches ?? 0);
  const marks = Number(raw.marks ?? 0);
  return {
    pageSize,
    allocatedPages,
    databaseSizeBytes,
    odsVersion,
    odsMinorVersion,
    oldestTransaction,
    oldestActive,
    oldestSnapshot,
    nextTransaction,
    transactionGap,
    currentMemory,
    maxMemory,
    pageBuffers,
    reads,
    writes,
    fetches,
    marks,
  };
}

export function decodeDatabaseInfo(json: string): DatabaseInfo {
  return normalizeDatabaseInfo(JSON.parse(json) as Partial<DatabaseInfo>);
}

export function buildSweepResult(
  before: DatabaseInfo,
  after: DatabaseInfo,
  tablesScanned: number,
  durationMs: number,
): SweepResult {
  const oitAdvanced = Math.max(0, after.oldestTransaction - before.oldestTransaction);
  const gapReduced = Math.max(0, before.transactionGap - after.transactionGap);
  return {
    before,
    after,
    tablesScanned,
    oitAdvanced,
    gapReduced,
    durationMs: Math.max(0, durationMs),
  };
}

export function decodeDescription(json: string): QueryDescription {
  const parsed = JSON.parse(json) as {
    params: EncodedColumn[];
    columns: EncodedColumn[];
    statementType: number;
  };

  const fields = parsed.columns.map(decodeField);

  return {
    params: parsed.params.map(decodeField),
    fields,
    statementType: statementKind(parsed.statementType),
    hasResultSet: fields.length > 0,
  };
}

export const BLOB_SIDE_CHANNEL = 1;
export const SHAPE_IDS = 2;

interface BlobRef {
  $blob: number;
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobRef).$blob === 'number'
  );
}

export function readBlobs(mod: FirebirdWasmModule): Uint8Array[] | null {
  const ptr = mod._fb_last_blobs();
  const size = mod._fb_last_blobs_size();
  if (ptr === 0 || size === 0) return null;

  const heap = mod.HEAPU8;
  const view = new DataView(heap.buffer, heap.byteOffset + ptr, size);

  const count = view.getUint32(0, true);
  const headerBytes = 4 * (1 + count);

  const blobs: Uint8Array[] = new Array(count);
  let offset = headerBytes;
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(4 * (1 + i), true);
    blobs[i] = heap.slice(ptr + offset, ptr + offset + length);
    offset += length;
  }

  return blobs;
}

export function attachBlobs<T>(
  result: QueryResult<T>,
  blobs: Uint8Array[],
  rowMode: RowMode,
): QueryResult<T> {
  for (const row of result.rows) {
    if (rowMode === 'array') {
      const values = row as unknown[];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (isBlobRef(value)) values[i] = blobs[value.$blob];
      }
      continue;
    }

    const target = row as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      const value = target[key];
      if (isBlobRef(value)) target[key] = blobs[value.$blob];
    }
  }

  return result;
}

export async function fallbackExplainQuery(
  describeFn: (sql: string) => Promise<QueryDescription>,
  queryFn: <T extends Row = Row>(sql: string, params?: QueryParams) => Promise<QueryResult<T>>,
  sql: string,
  detailed: boolean,
): Promise<string> {
  const desc = await describeFn(sql);
  if (
    desc.statementType === 'DDL' ||
    desc.statementType === 'START_TRANS' ||
    desc.statementType === 'COMMIT' ||
    desc.statementType === 'ROLLBACK' ||
    desc.statementType === 'SAVEPOINT' ||
    desc.statementType === 'SET_GENERATOR'
  ) {
    return '';
  }

  const userTables = extractReferencedTables(sql);
  const tables = userTables.length > 0 ? userTables : ['RDB$DATABASE'];
  const hasWhere = /\bWHERE\b/i.test(sql);
  const indexByTable = new Map<string, string>();

  if (hasWhere && userTables.length > 0) {
    for (const table of userTables) {
      try {
        const res = await queryFn<{ IDX: string }>(
          'SELECT FIRST 1 TRIM(RDB$INDEX_NAME) AS IDX FROM RDB$INDICES WHERE TRIM(RDB$RELATION_NAME) = ? ORDER BY RDB$INDEX_ID',
          [table],
        );
        const idx = res.rows[0]?.IDX;
        if (idx) indexByTable.set(table, idx);
      } catch {
        // Ignore catalog lookup errors in fallback mode.
      }
    }
  }

  if (detailed) {
    const steps = tables.map((t) => {
      const idx = indexByTable.get(t);
      if (idx) {
        return (
          `    -> Filter\n` +
          `        -> Table "${t}" Access By ID\n` +
          `            -> Bitmap\n` +
          `                -> Index "${idx}" Range Scan (full match)`
        );
      }
      return `    -> Table "${t}" Full Scan`;
    });
    return `Select Expression\n${steps.join('\n')}`;
  }

  const parts = tables.map((t) => {
    const idx = indexByTable.get(t);
    return idx ? `${t} INDEX (${idx})` : `${t} NATURAL`;
  });
  return `PLAN (${parts.join(', ')})`;
}

export async function fallbackReadDatabaseInfo(
  queryFn: <T extends Row = Row>(sql: string) => Promise<QueryResult<T>>,
): Promise<DatabaseInfo> {
  const dbRes = await queryFn<Record<string, unknown>>(
    'SELECT MON$PAGE_SIZE, MON$PAGES, MON$ODS_MAJOR, MON$ODS_MINOR, ' +
      'MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$OLDEST_SNAPSHOT, ' +
      'MON$NEXT_TRANSACTION, MON$PAGE_BUFFERS FROM MON$DATABASE',
  );
  const dbRow = dbRes.rows[0] ?? {};

  let currentMemory = 0;
  let maxMemory = 0;
  try {
    const memRes = await queryFn<Record<string, unknown>>(
      'SELECT MON$MEMORY_USED, MON$MAX_MEMORY_USED FROM MON$MEMORY_USAGE WHERE MON$STAT_GROUP = 0',
    );
    const memRow = memRes.rows[0] ?? {};
    currentMemory = Number(memRow['MON$MEMORY_USED'] ?? 0);
    maxMemory = Number(memRow['MON$MAX_MEMORY_USED'] ?? 0);
  } catch {
    // Ignore if MON$MEMORY_USAGE is unavailable.
  }

  let reads = 0;
  let writes = 0;
  let fetches = 0;
  let marks = 0;
  try {
    const ioRes = await queryFn<Record<string, unknown>>(
      'SELECT MON$PAGE_READS, MON$PAGE_WRITES, MON$PAGE_FETCHES, MON$PAGE_MARKS ' +
        'FROM MON$IO_STATS WHERE MON$STAT_GROUP = 0',
    );
    const ioRow = ioRes.rows[0] ?? {};
    reads = Number(ioRow['MON$PAGE_READS'] ?? 0);
    writes = Number(ioRow['MON$PAGE_WRITES'] ?? 0);
    fetches = Number(ioRow['MON$PAGE_FETCHES'] ?? 0);
    marks = Number(ioRow['MON$PAGE_MARKS'] ?? 0);
  } catch {
    // Ignore if MON$IO_STATS is unavailable.
  }

  return normalizeDatabaseInfo({
    pageSize: Number(dbRow['MON$PAGE_SIZE'] ?? 0),
    allocatedPages: Number(dbRow['MON$PAGES'] ?? 0),
    odsVersion: Number(dbRow['MON$ODS_MAJOR'] ?? 0),
    odsMinorVersion: Number(dbRow['MON$ODS_MINOR'] ?? 0),
    oldestTransaction: Number(dbRow['MON$OLDEST_TRANSACTION'] ?? 0),
    oldestActive: Number(dbRow['MON$OLDEST_ACTIVE'] ?? 0),
    oldestSnapshot: Number(dbRow['MON$OLDEST_SNAPSHOT'] ?? 0),
    nextTransaction: Number(dbRow['MON$NEXT_TRANSACTION'] ?? 0),
    pageBuffers: Number(dbRow['MON$PAGE_BUFFERS'] ?? 0),
    currentMemory,
    maxMemory,
    reads,
    writes,
    fetches,
    marks,
  });
}
