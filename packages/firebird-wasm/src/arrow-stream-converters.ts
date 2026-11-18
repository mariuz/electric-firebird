/**
 * arrow-stream-converters.ts – Bounded-Memory Streaming CSV / NDJSON <-> Apache
 * Arrow IPC V5 Transcoders (`M24 Item 3`).
 */

import type { FieldInfo, FirebirdTypeName, Row } from './types';
import {
  encodeArrowIpcEosFrame,
  encodeArrowIpcRecordBatchFrame,
  encodeArrowIpcSchemaFrame,
  rowsToColumnarResult,
  type ArrowIpcOptions,
} from './columnar';
import { iterateArrowIpcBatches, type ArrowIngestSource } from './arrow-ingest';
import { assertNotAborted } from './database-core';

export type TextStreamSource =
  | string
  | Uint8Array
  | ReadableStream<Uint8Array | string>
  | AsyncIterable<Uint8Array | string>;

export interface NdjsonToArrowStreamOptions extends ArrowIpcOptions {
  /** Number of rows packed per emitted Arrow `RecordBatch` frame. @default 1000 */
  batchSize?: number;
  /** Explicit column schema overriding automatic first-batch type inference. */
  fields?: readonly FieldInfo[];
  /** Optional `AbortSignal` checked between batches. */
  signal?: AbortSignal;
}

export interface CsvToArrowStreamOptions extends ArrowIpcOptions {
  /** Number of rows packed per emitted Arrow `RecordBatch` frame. @default 1000 */
  batchSize?: number;
  /** Field delimiter character. @default ',' */
  delimiter?: string;
  /** Whether the first CSV record is a header row. @default true */
  header?: boolean;
  /** Explicit column names when `header === false`. */
  columns?: readonly string[];
  /** Explicit column schema overriding automatic type inference. */
  fields?: readonly FieldInfo[];
  /** Infer numeric (`INTEGER` / `BIGINT` / `DOUBLE`) and `BOOLEAN` columns from string values. @default true */
  inferTypes?: boolean;
  /** String token interpreted as SQL `NULL`. @default '' */
  nullValue?: string;
  /** Optional `AbortSignal` checked between batches. */
  signal?: AbortSignal;
}

export interface ArrowToNdjsonStreamOptions {
  /** Serialize `bigint` values as JSON strings (`true`) or numbers when safe (`false`). @default false */
  bigintAsString?: boolean;
  /** Optional `AbortSignal` checked between batches. */
  signal?: AbortSignal;
}

export interface ArrowToCsvStreamOptions {
  /** Field delimiter character. @default ',' */
  delimiter?: string;
  /** Emit header line before the first data row. @default true */
  header?: boolean;
  /** String emitted for `null` values. @default '' */
  nullValue?: string;
  /** Optional `AbortSignal` checked between batches. */
  signal?: AbortSignal;
}

const utf8Encoder = new TextEncoder();

function isWebReadableStream(
  val: unknown,
): val is ReadableStream<Uint8Array | string> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as ReadableStream<unknown>).getReader === 'function'
  );
}

async function* iterateTextChunks(source: TextStreamSource): AsyncGenerator<string> {
  if (typeof source === 'string') {
    if (source.length > 0) yield source;
    return;
  }
  const decoder = new TextDecoder('utf-8');
  if (source instanceof Uint8Array) {
    const str = decoder.decode(source);
    if (str.length > 0) yield str;
    return;
  }
  if (isWebReadableStream(source)) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text =
          typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        if (text.length > 0) yield text;
      }
      const tail = decoder.decode();
      if (tail.length > 0) yield tail;
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of source) {
    const text =
      typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

function inferFieldsFromSampleRows(rows: readonly Row[]): FieldInfo[] {
  const colOrder: string[] = [];
  const colSeen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!colSeen.has(k)) {
        colSeen.add(k);
        colOrder.push(k);
      }
    }
  }

  return colOrder.map((name) => {
    let sawBool = false;
    let sawInt32 = false;
    let sawBigInt = false;
    let sawFloat = false;
    let sawString = false;
    let sawBytes = false;

    for (const r of rows) {
      const v = r[name];
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') {
        sawBool = true;
      } else if (typeof v === 'bigint') {
        sawBigInt = true;
      } else if (typeof v === 'number') {
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
          sawInt32 = true;
        } else if (Number.isInteger(v) && Number.isSafeInteger(v)) {
          sawBigInt = true;
        } else {
          sawFloat = true;
        }
      } else if (v instanceof Uint8Array) {
        sawBytes = true;
      } else {
        sawString = true;
      }
    }

    let typeName: FirebirdTypeName = 'VARYING';
    if (sawString) {
      typeName = 'VARYING';
    } else if (sawBytes) {
      typeName = 'BLOB';
    } else if (sawFloat) {
      typeName = 'DOUBLE';
    } else if (sawBigInt) {
      typeName = 'BIGINT';
    } else if (sawInt32) {
      typeName = 'INTEGER';
    } else if (sawBool) {
      typeName = 'BOOLEAN';
    }

    return {
      name,
      typeName,
      nullable: true,
    };
  });
}

function coerceValueToField(value: unknown, field: FieldInfo): unknown {
  if (value === null || value === undefined) return null;
  const tn = (field.typeName ?? 'VARYING').toUpperCase();
  switch (tn) {
    case 'BOOLEAN':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const low = value.trim().toLowerCase();
        if (low === 'true' || low === '1') return true;
        if (low === 'false' || low === '0') return false;
      }
      return Boolean(value);
    case 'SMALLINT':
    case 'INTEGER': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'BIGINT': {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return BigInt(Math.trunc(value));
      }
      if (typeof value === 'string' && value.trim() !== '') {
        try {
          return BigInt(value.trim());
        } catch {
          const n = Number(value);
          return Number.isFinite(n) ? BigInt(Math.trunc(n)) : null;
        }
      }
      return null;
    }
    case 'FLOAT':
    case 'DOUBLE': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    default:
      if (typeof value === 'string' || value instanceof Uint8Array) return value;
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
  }
}

function normalizeRowsToSchema(
  rows: readonly Row[],
  fields: readonly FieldInfo[],
): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const f of fields) {
      out[f.name] = coerceValueToField(r[f.name], f);
    }
    return out;
  });
}

/**
 * Convert an NDJSON / JSONL stream into a chunked **Apache Arrow IPC V5** byte
 * stream (`Schema` + `RecordBatch`es + `EOS`) in bounded `O(batchSize)` memory (`M24 Item 3`).
 */
export function ndjsonToArrowStream(
  source: TextStreamSource,
  options: NdjsonToArrowStreamOptions = {},
): ReadableStream<Uint8Array> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 1000));

  async function* produceFrames(): AsyncGenerator<Uint8Array> {
    assertNotAborted(options.signal);
    let schemaFields: FieldInfo[] | null = options.fields ? [...options.fields] : null;
    let schemaEmitted = false;
    let pendingRows: Row[] = [];
    let leftover = '';

    const flushBatch = function* (rows: Row[]): Generator<Uint8Array> {
      if (rows.length === 0) return;
      if (!schemaFields) {
        schemaFields = inferFieldsFromSampleRows(rows);
      }
      const normalized = normalizeRowsToSchema(rows, schemaFields);
      const col = rowsToColumnarResult({ fields: schemaFields, rows: normalized });
      if (!schemaEmitted) {
        schemaEmitted = true;
        yield encodeArrowIpcSchemaFrame(col, options);
      }
      yield encodeArrowIpcRecordBatchFrame(col);
    };

    for await (const chunk of iterateTextChunks(source)) {
      assertNotAborted(options.signal);
      leftover += chunk;
      let nl = leftover.indexOf('\n');
      while (nl !== -1) {
        const line = leftover.slice(0, nl).trim();
        leftover = leftover.slice(nl + 1);
        if (line.length > 0) {
          const parsed = JSON.parse(line) as Row;
          pendingRows.push(parsed);
          if (pendingRows.length >= batchSize) {
            yield* flushBatch(pendingRows);
            pendingRows = [];
          }
        }
        nl = leftover.indexOf('\n');
      }
    }

    const finalLine = leftover.trim();
    if (finalLine.length > 0) {
      pendingRows.push(JSON.parse(finalLine) as Row);
    }
    if (pendingRows.length > 0) {
      yield* flushBatch(pendingRows);
      pendingRows = [];
    }

    if (!schemaEmitted) {
      yield encodeArrowIpcSchemaFrame(schemaFields ?? [], options);
    }
    yield encodeArrowIpcEosFrame();
  }

  return asyncGeneratorToReadableStream(produceFrames());
}

/**
 * Incrementally parse RFC-4180 CSV records across arbitrary stream chunk boundaries
 * (including embedded newlines and escaped `""` inside quoted cells).
 */
async function* iterateCsvRecords(
  source: TextStreamSource,
  delimiter: string,
): AsyncGenerator<string[]> {
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let pendingQuote = false;
  let sawAnyCharInRecord = false;

  for await (const chunk of iterateTextChunks(source)) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          cell += '"';
          continue;
        }
        inQuotes = false;
      }

      if (inQuotes) {
        if (ch === '"') {
          pendingQuote = true;
        } else {
          cell += ch;
        }
        continue;
      }

      if (ch === '"' && cell.length === 0) {
        inQuotes = true;
        sawAnyCharInRecord = true;
      } else if (ch === delimiter) {
        row.push(cell);
        cell = '';
        sawAnyCharInRecord = true;
      } else if (ch === '\r') {
        // Ignore CR before LF or treat lone CR at next char
      } else if (ch === '\n') {
        if (sawAnyCharInRecord || cell.length > 0 || row.length > 0) {
          row.push(cell);
          yield row;
          row = [];
          cell = '';
          sawAnyCharInRecord = false;
        }
      } else {
        cell += ch;
        sawAnyCharInRecord = true;
      }
    }
  }

  if (pendingQuote) {
    inQuotes = false;
  }
  if (sawAnyCharInRecord || cell.length > 0 || row.length > 0) {
    row.push(cell);
    yield row;
  }
}

function inferCsvColumnFields(
  colNames: readonly string[],
  rawRows: ReadonlyArray<readonly string[]>,
  nullToken: string,
  inferTypes: boolean,
): FieldInfo[] {
  if (!inferTypes) {
    return colNames.map((name) => ({ name, typeName: 'VARYING', nullable: true }));
  }

  return colNames.map((name, colIdx) => {
    let nonNullCount = 0;
    let allBool = true;
    let allInt32 = true;
    let allBigInt = true;
    let allFloat = true;

    for (const r of rawRows) {
      const raw = r[colIdx] ?? '';
      if (raw === nullToken) continue;
      nonNullCount++;
      const trimmed = raw.trim();
      if (trimmed === '') {
        allBool = false;
        allInt32 = false;
        allBigInt = false;
        allFloat = false;
        break;
      }
      const low = trimmed.toLowerCase();
      if (low !== 'true' && low !== 'false') {
        allBool = false;
      }
      if (/^[+-]?\d+$/.test(trimmed)) {
        try {
          const bi = BigInt(trimmed);
          if (bi < -2147483648n || bi > 2147483647n) {
            allInt32 = false;
          }
        } catch {
          allInt32 = false;
          allBigInt = false;
        }
      } else {
        allInt32 = false;
        allBigInt = false;
      }
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        allFloat = false;
      }
    }

    let typeName: FirebirdTypeName = 'VARYING';
    if (nonNullCount > 0) {
      if (allBool) typeName = 'BOOLEAN';
      else if (allInt32) typeName = 'INTEGER';
      else if (allBigInt) typeName = 'BIGINT';
      else if (allFloat) typeName = 'DOUBLE';
    }
    return { name, typeName, nullable: true };
  });
}

/**
 * Convert an RFC-4180 CSV stream into a chunked **Apache Arrow IPC V5** byte
 * stream (`Schema` + `RecordBatch`es + `EOS`) in bounded `O(batchSize)` memory (`M24 Item 3`).
 */
export function csvToArrowStream(
  source: TextStreamSource,
  options: CsvToArrowStreamOptions = {},
): ReadableStream<Uint8Array> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 1000));
  const delimiter = options.delimiter ?? ',';
  const hasHeader = options.header ?? true;
  const inferTypes = options.inferTypes ?? true;
  const nullToken = options.nullValue ?? '';

  async function* produceFrames(): AsyncGenerator<Uint8Array> {
    assertNotAborted(options.signal);
    let colNames: string[] | null = options.columns
      ? [...options.columns]
      : options.fields
        ? options.fields.map((f) => f.name)
        : null;
    let schemaFields: FieldInfo[] | null = options.fields ? [...options.fields] : null;
    let schemaEmitted = false;
    let headerConsumed = !hasHeader;
    let pendingRawRows: string[][] = [];

    const flushCsvBatch = function* (rawBatch: string[][]): Generator<Uint8Array> {
      if (rawBatch.length === 0) return;
      if (!colNames) {
        const width = rawBatch[0]!.length;
        colNames = Array.from({ length: width }, (_, idx) => `COL_${idx + 1}`);
      }
      if (!schemaFields) {
        schemaFields = inferCsvColumnFields(colNames, rawBatch, nullToken, inferTypes);
      }
      const typedRows: Row[] = rawBatch.map((cells) => {
        const obj: Row = {};
        for (let c = 0; c < schemaFields!.length; c++) {
          const f = schemaFields![c]!;
          const cell = cells[c] ?? '';
          obj[f.name] = cell === nullToken ? null : coerceValueToField(cell, f);
        }
        return obj;
      });
      const col = rowsToColumnarResult({ fields: schemaFields, rows: typedRows });
      if (!schemaEmitted) {
        schemaEmitted = true;
        yield encodeArrowIpcSchemaFrame(col, options);
      }
      yield encodeArrowIpcRecordBatchFrame(col);
    };

    for await (const record of iterateCsvRecords(source, delimiter)) {
      assertNotAborted(options.signal);
      if (!headerConsumed) {
        headerConsumed = true;
        if (!colNames) {
          colNames = record.map((h, idx) => h.trim() || `COL_${idx + 1}`);
        }
        continue;
      }
      pendingRawRows.push(record);
      if (pendingRawRows.length >= batchSize) {
        yield* flushCsvBatch(pendingRawRows);
        pendingRawRows = [];
      }
    }

    if (pendingRawRows.length > 0) {
      yield* flushCsvBatch(pendingRawRows);
      pendingRawRows = [];
    }

    if (!schemaEmitted) {
      const emptyFields =
        schemaFields ??
        (colNames
          ? colNames.map((name) => ({ name, typeName: 'VARYING', nullable: true }))
          : []);
      yield encodeArrowIpcSchemaFrame(emptyFields, options);
    }
    yield encodeArrowIpcEosFrame();
  }

  return asyncGeneratorToReadableStream(produceFrames());
}

function serializeNdjsonValue(val: unknown, bigintAsString: boolean): unknown {
  if (typeof val === 'bigint') {
    if (!bigintAsString && val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(val);
    }
    return val.toString();
  }
  if (val instanceof Uint8Array) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64');
    }
    let bin = '';
    for (let i = 0; i < val.byteLength; i++) bin += String.fromCharCode(val[i]!);
    return btoa(bin);
  }
  return val;
}

/**
 * Convert an **Apache Arrow IPC V5** buffer or stream into a UTF-8 NDJSON
 * `ReadableStream<Uint8Array>` in bounded `O(batchSize)` memory (`M24 Item 3`).
 */
export function arrowToNdjsonStream(
  source: ArrowIngestSource,
  options: ArrowToNdjsonStreamOptions = {},
): ReadableStream<Uint8Array> {
  const bigintAsString = options.bigintAsString ?? false;

  async function* produceChunks(): AsyncGenerator<Uint8Array> {
    assertNotAborted(options.signal);
    for await (const { batch } of iterateArrowIpcBatches(source)) {
      assertNotAborted(options.signal);
      if (batch.rowCount === 0) continue;
      const rows = batch.toRows();
      const lines: string[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i]!;
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          clean[k] = serializeNdjsonValue(v, bigintAsString);
        }
        lines[i] = JSON.stringify(clean);
      }
      yield utf8Encoder.encode(`${lines.join('\n')}\n`);
    }
  }

  return asyncGeneratorToReadableStream(produceChunks());
}

function escapeCsvCell(val: unknown, delimiter: string, nullValue: string): string {
  if (val === null || val === undefined) return nullValue;
  let text: string;
  if (val instanceof Uint8Array) {
    text =
      typeof Buffer !== 'undefined'
        ? Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64')
        : Array.from(val, (b) => b.toString(16).padStart(2, '0')).join('');
  } else if (val instanceof Date) {
    text = val.toISOString();
  } else {
    text = String(val);
  }
  if (
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.includes(delimiter)
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Convert an **Apache Arrow IPC V5** buffer or stream into an RFC-4180 UTF-8 CSV
 * `ReadableStream<Uint8Array>` in bounded `O(batchSize)` memory (`M24 Item 3`).
 */
export function arrowToCsvStream(
  source: ArrowIngestSource,
  options: ArrowToCsvStreamOptions = {},
): ReadableStream<Uint8Array> {
  const delimiter = options.delimiter ?? ',';
  const emitHeader = options.header ?? true;
  const nullValue = options.nullValue ?? '';

  async function* produceChunks(): AsyncGenerator<Uint8Array> {
    assertNotAborted(options.signal);
    let headerWritten = false;
    for await (const { batch } of iterateArrowIpcBatches(source)) {
      assertNotAborted(options.signal);
      const lines: string[] = [];
      if (emitHeader && !headerWritten && batch.fields.length > 0) {
        headerWritten = true;
        lines.push(
          batch.fields
            .map((f) => escapeCsvCell(f.name, delimiter, nullValue))
            .join(delimiter),
        );
      }
      if (batch.rowCount > 0) {
        const colCount = batch.vectors.length;
        for (let r = 0; r < batch.rowCount; r++) {
          const cells: string[] = new Array(colCount);
          for (let c = 0; c < colCount; c++) {
            cells[c] = escapeCsvCell(batch.vectors[c]!.get(r), delimiter, nullValue);
          }
          lines.push(cells.join(delimiter));
        }
      }
      if (lines.length > 0) {
        yield utf8Encoder.encode(`${lines.join('\n')}\n`);
      }
    }
  }

  return asyncGeneratorToReadableStream(produceChunks());
}

function asyncGeneratorToReadableStream(
  gen: AsyncGenerator<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      if (typeof gen.return === 'function') {
        await gen.return(undefined);
      }
    },
  });
}
