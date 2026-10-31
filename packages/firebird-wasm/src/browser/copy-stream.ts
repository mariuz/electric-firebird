/**
 * copy-stream.ts – Streaming CSV and JSONLines (NDJSON) bulk import & export
 * (`copyFromStream` / `copyToStream`) built on `execBatch()` and `queryStream()`.
 */

import type {
  ArrayRow,
  CopyFormat,
  CopyFromOptions,
  CopyResult,
  CopyToOptions,
  FieldInfo,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
} from '../types';
import { resolveBatchSize, resolveQueryCall, toStatement } from '../sql-tag';
import type { SqlFragment } from '../sql-tag';
import { compressGzipStream, readDatabaseStreamChunks } from './data-stream';

const UNQUOTED_IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const QUOTED_IDENT_PATTERN = /^"(?:[^"]|"")+"$/;

/**
 * Validate and format a SQL table or column identifier.
 *
 * Unquoted ASCII identifiers (`ITEMS`, `user_id`) are kept as-is so Firebird
 * folds them to upper-case as usual; quoted identifiers (`"my items"`) are
 * preserved; arbitrary column names with spaces or punctuation are safely
 * double-quoted.
 */
export function formatCopyIdentifier(
  ident: string,
  kind: 'table' | 'column' = 'column',
): string {
  const trimmed = ident.trim();
  if (!trimmed) {
    throw new Error(`Invalid empty ${kind} name`);
  }
  if (UNQUOTED_IDENT_PATTERN.test(trimmed) || QUOTED_IDENT_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (kind === 'table' && /[\0;\r\n]/.test(trimmed)) {
    throw new Error(`Invalid table name "${ident}"`);
  }
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function isSimpleTableIdentifier(sqlOrTable: string): boolean {
  const trimmed = sqlOrTable.trim();
  if (!trimmed) return false;
  if (QUOTED_IDENT_PATTERN.test(trimmed)) return true;
  if (!UNQUOTED_IDENT_PATTERN.test(trimmed)) return false;
  const upper = trimmed.toUpperCase();
  return (
    upper !== 'SELECT' &&
    upper !== 'WITH' &&
    upper !== 'EXECUTE' &&
    upper !== 'INSERT' &&
    upper !== 'UPDATE' &&
    upper !== 'DELETE'
  );
}

function validateFormat(format?: CopyFormat): CopyFormat {
  const resolved = format ?? 'csv';
  if (resolved !== 'csv' && resolved !== 'jsonl' && resolved !== 'ndjson') {
    throw new RangeError(
      `Unsupported copy format "${String(format)}"; expected 'csv', 'jsonl', or 'ndjson'`,
    );
  }
  return resolved;
}

function validateSingleCharOption(
  value: string | undefined,
  defaultChar: string,
  name: string,
): string {
  const ch = value ?? defaultChar;
  if (typeof ch !== 'string' || ch.length !== 1 || ch === '\r' || ch === '\n') {
    throw new RangeError(`${name} must be a single character (not CR or LF)`);
  }
  return ch;
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(
    reason !== undefined && reason !== null
      ? String(reason)
      : 'The operation was aborted',
  );
  err.name = 'AbortError';
  return err;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '\\x';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function formatCsvValue(
  value: unknown,
  delimiter: string,
  quote: string,
  nullString: string,
): string {
  if (value === null || value === undefined) {
    return nullString;
  }
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    text = String(value);
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (value instanceof Uint8Array) {
    text = bytesToHex(value);
  } else {
    text = JSON.stringify(value);
  }

  // Quote if the text is empty and nullString is '' (so '' round-trips as
  // empty string rather than NULL), or if it contains delimiter, quote, CR, or LF,
  // or if it equals nullString.
  const needsQuotes =
    (text === '' && nullString === '') ||
    text === nullString ||
    text.includes(delimiter) ||
    text.includes(quote) ||
    text.includes('\n') ||
    text.includes('\r');

  if (!needsQuotes) {
    return text;
  }
  const escaped = text.split(quote).join(quote + quote);
  return `${quote}${escaped}${quote}`;
}

export function encodeCsvRow(
  values: readonly unknown[],
  delimiter = ',',
  quote = '"',
  nullString = '',
): string {
  let line = '';
  for (let i = 0; i < values.length; i++) {
    if (i > 0) line += delimiter;
    line += formatCsvValue(values[i], delimiter, quote, nullString);
  }
  return `${line}\n`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (
      value >= -9007199254740991n &&
      value <= 9007199254740991n
    ) {
      return Number(value);
    }
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }
  return value;
}

export function encodeJsonlRow(
  fields: readonly FieldInfo[],
  values: readonly unknown[],
): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    const key = fields[i]?.name || `COL_${i + 1}`;
    obj[key] = values[i] === undefined ? null : values[i];
  }
  return `${JSON.stringify(obj, jsonReplacer)}\n`;
}

export interface CopyStreamQueryable {
  queryStream(
    sql: string,
    params: QueryParams | undefined,
    options: QueryStreamOptions & { rowMode: 'array' },
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  describeQuery?(sql: string): Promise<{ fields: FieldInfo[] }>;
}

/**
 * Build a `ReadableStream<Uint8Array>` exporting a table or `SELECT` query as
 * streaming CSV or JSONLines (`'jsonl'` / `'ndjson'`), optionally gzip-compressed.
 */
export function buildCopyToStream(
  target: CopyStreamQueryable,
  tableOrQuery: string | SqlFragment,
  paramsOrOptions: QueryParams | CopyToOptions = [],
  maybeOptions: CopyToOptions = {},
): ReadableStream<Uint8Array> {
  const { statement, options } =
    typeof tableOrQuery === 'string' && !Array.isArray(paramsOrOptions)
      ? {
          statement: toStatement(tableOrQuery, []),
          options: (paramsOrOptions ?? maybeOptions) as CopyToOptions,
        }
      : resolveQueryCall<CopyToOptions>(
          tableOrQuery,
          paramsOrOptions,
          maybeOptions,
        );

  const format = validateFormat(options.format);
  const delimiter = validateSingleCharOption(options.delimiter, ',', 'delimiter');
  const quote = validateSingleCharOption(options.quote, '"', 'quote');
  if (format === 'csv' && delimiter === quote) {
    throw new RangeError('delimiter and quote must be different characters');
  }
  const nullString = options.nullString ?? '';
  const includeHeader = options.header ?? true;
  const batchSize = resolveBatchSize(options.batchSize);

  let querySql = statement.sql;
  if (typeof tableOrQuery === 'string' && isSimpleTableIdentifier(tableOrQuery)) {
    const colList =
      options.columns && options.columns.length > 0
        ? options.columns.map((c) => formatCopyIdentifier(c, 'column')).join(', ')
        : '*';
    querySql = `SELECT ${colList} FROM ${formatCopyIdentifier(tableOrQuery, 'table')}`;
  }

  const encoder = new TextEncoder();
  let iterator: AsyncIterableIterator<QueryResult<ArrayRow>> | null = null;
  let emittedHeader = false;
  let finished = false;

  const raw = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        assertNotAborted(options.signal);
        if (finished) {
          controller.close();
          return;
        }
        if (!iterator) {
          iterator = target.queryStream(querySql, statement.params, {
            rowMode: 'array',
            batchSize,
            isolationLevel: options.isolationLevel,
            readOnly: options.readOnly ?? true,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          });
        }

        const next = await iterator.next();
        if (next.done || !next.value) {
          if (format === 'csv' && includeHeader && !emittedHeader) {
            emittedHeader = true;
            let headerFields: string[] = [];
            if (options.columns && options.columns.length > 0) {
              headerFields = [...options.columns];
            } else if (typeof target.describeQuery === 'function') {
              const desc = await target.describeQuery(querySql);
              headerFields = desc.fields.map((f) => f.name);
            }
            if (headerFields.length > 0) {
              controller.enqueue(
                encoder.encode(encodeCsvRow(headerFields, delimiter, quote, '')),
              );
            }
          }
          finished = true;
          controller.close();
          return;
        }

        const batch = next.value;
        let chunkText = '';
        if (format === 'csv') {
          if (includeHeader && !emittedHeader) {
            emittedHeader = true;
            const headerNames = batch.fields.map((f) => f.name);
            chunkText += encodeCsvRow(headerNames, delimiter, quote, '');
          }
          for (const row of batch.rows) {
            chunkText += encodeCsvRow(row, delimiter, quote, nullString);
          }
        } else {
          for (const row of batch.rows) {
            chunkText += encodeJsonlRow(batch.fields, row);
          }
        }

        if (chunkText.length > 0) {
          controller.enqueue(encoder.encode(chunkText));
        }
      } catch (err) {
        if (iterator) {
          const it = iterator;
          iterator = null;
          await it.return?.(undefined).catch(() => undefined);
        }
        throw err;
      }
    },
    cancel: async () => {
      finished = true;
      if (iterator) {
        const it = iterator;
        iterator = null;
        await it.return?.(undefined).catch(() => undefined);
      }
    },
  });

  return options.compression === 'gzip' ? compressGzipStream(raw) : raw;
}

// ---------------------------------------------------------------------------
// Streaming CSV / JSONLines import (`copyFromStream`)
// ---------------------------------------------------------------------------

interface ParsedCsvCell {
  value: string;
  quoted: boolean;
}

async function* iterateTextChunks(
  source:
    | ReadableStream<Uint8Array | string>
    | AsyncIterable<Uint8Array | string>,
  options: CopyFromOptions,
): AsyncGenerator<string> {
  // Check first item to see if source yields strings or Uint8Array
  const rawIter = (async function* (): AsyncGenerator<Uint8Array | string> {
    if (
      typeof (source as ReadableStream<Uint8Array | string>).getReader ===
      'function'
    ) {
      const reader = (
        source as ReadableStream<Uint8Array | string>
      ).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined && value !== null) yield value;
        }
      } finally {
        reader.releaseLock();
      }
      return;
    }
    for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
      if (chunk !== undefined && chunk !== null) yield chunk;
    }
  })();

  const first = await rawIter.next();
  if (first.done) return;

  if (typeof first.value === 'string') {
    if (first.value.length > 0) yield first.value;
    const decoder = new TextDecoder();
    for await (const item of rawIter) {
      if (typeof item === 'string') {
        if (item.length > 0) yield item;
      } else if (item.byteLength > 0) {
        yield decoder.decode(item, { stream: true });
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
    return;
  }

  // Byte stream: support automatic or explicit gzip decompression via readDatabaseStreamChunks
  const byteIterable: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      const firstBytes =
        first.value instanceof Uint8Array
          ? first.value
          : new TextEncoder().encode(String(first.value));
      if (firstBytes.byteLength > 0) yield firstBytes;
      for await (const item of rawIter) {
        const bytes =
          typeof item === 'string'
            ? new TextEncoder().encode(item)
            : item instanceof Uint8Array
              ? item
              : new Uint8Array(item);
        if (bytes.byteLength > 0) yield bytes;
      }
    },
  };

  const decoder = new TextDecoder();
  for await (const bytes of readDatabaseStreamChunks(byteIterable, {
    compression: options.compression,
  })) {
    const str = decoder.decode(bytes, { stream: true });
    if (str.length > 0) yield str;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

/**
 * Incremental RFC 4180 CSV parser yielding one record (`ParsedCsvCell[]`) at a
 * time from a stream of string chunks.
 */
async function* parseCsvRecords(
  textChunks: AsyncIterable<string>,
  delimiter: string,
  quote: string,
): AsyncGenerator<ParsedCsvCell[]> {
  let row: ParsedCsvCell[] = [];
  let field = '';
  let inQuotes = false;
  let quotePending = false;
  let fieldQuoted = false;
  let fieldStarted = false;

  const pushField = (): void => {
    row.push({ value: field, quoted: fieldQuoted });
    field = '';
    fieldQuoted = false;
    fieldStarted = false;
  };

  for await (const chunk of textChunks) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;

      if (quotePending) {
        quotePending = false;
        if (ch === quote) {
          field += quote;
          continue;
        }
        inQuotes = false;
      }

      if (inQuotes) {
        if (ch === quote) {
          quotePending = true;
        } else {
          field += ch;
        }
        continue;
      }

      if (!fieldStarted && ch === quote) {
        inQuotes = true;
        fieldQuoted = true;
        fieldStarted = true;
        continue;
      }

      if (ch === delimiter) {
        pushField();
        continue;
      }

      if (ch === '\r') {
        continue;
      }

      if (ch === '\n') {
        if (fieldStarted || field.length > 0 || row.length > 0) {
          pushField();
          yield row;
          row = [];
        }
        continue;
      }

      fieldStarted = true;
      field += ch;
    }
  }

  if (quotePending) {
    inQuotes = false;
  }
  if (inQuotes) {
    throw new Error('Unterminated quoted field in CSV stream');
  }
  if (fieldStarted || field.length > 0 || row.length > 0) {
    pushField();
    yield row;
  }
}

async function* parseJsonlRecords(
  textChunks: AsyncIterable<string>,
): AsyncGenerator<unknown> {
  let buffer = '';
  let lineNumber = 0;

  const parseLine = (rawLine: string): unknown | undefined => {
    lineNumber += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Invalid JSON on line ${lineNumber}: ${(err as Error).message}`,
      );
    }
  };

  for await (const chunk of textChunks) {
    buffer += chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const parsed = parseLine(line);
      if (parsed !== undefined) {
        yield parsed;
      }
      newlineIdx = buffer.indexOf('\n');
    }
  }

  if (buffer.trim().length > 0) {
    const parsed = parseLine(buffer);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

function decodeHexIfPrefixed(value: unknown): unknown {
  if (
    typeof value === 'string' &&
    value.startsWith('\\x') &&
    value.length >= 2 &&
    value.length % 2 === 0 &&
    /^\\x[0-9a-fA-F]*$/.test(value)
  ) {
    const byteLen = (value.length - 2) / 2;
    const out = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++) {
      out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
    }
    return out;
  }
  return value;
}

export interface CopyBatchExecutor {
  execBatch(sql: string, rows: QueryParams[]): Promise<unknown>;
}

/**
 * Stream rows from `source` (`ReadableStream` or `AsyncIterable` of `Uint8Array`
 * or `string`) and bulk-insert them into `tableName` in batches of `batchSize`
 * via `target.execBatch()`.
 */
export async function executeCopyFromStream(
  target: CopyBatchExecutor,
  tableName: string,
  source:
    | ReadableStream<Uint8Array | string>
    | AsyncIterable<Uint8Array | string>,
  options: CopyFromOptions = {},
): Promise<CopyResult> {
  assertNotAborted(options.signal);
  const format = validateFormat(options.format);
  const delimiter = validateSingleCharOption(options.delimiter, ',', 'delimiter');
  const quote = validateSingleCharOption(options.quote, '"', 'quote');
  if (format === 'csv' && delimiter === quote) {
    throw new RangeError('delimiter and quote must be different characters');
  }
  const nullString = options.nullString ?? '';
  const hasHeader = options.header ?? true;
  const batchSize = resolveBatchSize(options.batchSize);
  const formattedTable = formatCopyIdentifier(tableName, 'table');

  let columns: string[] | undefined = options.columns
    ? options.columns.map((c) => c.trim())
    : undefined;
  let insertSql: string | undefined;

  const ensureInsertSql = (cols: string[]): string => {
    if (!insertSql) {
      if (cols.length === 0) {
        throw new Error('copyFromStream requires at least one column');
      }
      const colSql = cols.map((c) => formatCopyIdentifier(c, 'column')).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      insertSql = `INSERT INTO ${formattedTable} (${colSql}) VALUES (${placeholders})`;
    }
    return insertSql;
  };

  const batch: QueryParams[] = [];
  let rowsCopied = 0;
  let batches = 0;
  let rowIndex = 0;

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    assertNotAborted(options.signal);
    const sql = ensureInsertSql(columns!);
    const toInsert = batch.splice(0, batch.length);
    await target.execBatch(sql, toInsert);
    rowsCopied += toInsert.length;
    batches += 1;
  };

  const normalizeRowOutput = (
    rawRow: Record<string, unknown> | unknown[],
    cols: string[],
  ): QueryParams | null => {
    const transformed = options.transform
      ? options.transform(rawRow, rowIndex++)
      : rawRow;
    if (transformed === null || transformed === undefined) {
      return null;
    }
    if (Array.isArray(transformed)) {
      if (transformed.length !== cols.length) {
        throw new Error(
          `Row has ${transformed.length} column(s) but expected ${cols.length} (${cols.join(', ')})`,
        );
      }
      return transformed.map(decodeHexIfPrefixed) as QueryParams;
    }
    return cols.map((col) => {
      const val = (transformed as Record<string, unknown>)[col];
      return (val === undefined ? null : decodeHexIfPrefixed(val)) as QueryParams[number];
    });
  };

  const textChunks = iterateTextChunks(source, options);

  if (format === 'csv') {
    let sawFirstRecord = false;
    for await (const cells of parseCsvRecords(textChunks, delimiter, quote)) {
      assertNotAborted(options.signal);
      if (!sawFirstRecord) {
        sawFirstRecord = true;
        if (hasHeader) {
          if (!columns || columns.length === 0) {
            columns = cells.map((c) => c.value.trim());
          }
          continue;
        }
      }

      if (!columns || columns.length === 0) {
        throw new Error(
          'copyFromStream with header: false requires options.columns to be specified',
        );
      }

      if (cells.length !== columns.length) {
        throw new Error(
          `CSV row has ${cells.length} field(s) but expected ${columns.length} (${columns.join(', ')})`,
        );
      }

      const values: unknown[] = cells.map((cell) => {
        if (!cell.quoted && cell.value === nullString) {
          return null;
        }
        return decodeHexIfPrefixed(cell.value);
      });

      const inputForTransform: Record<string, unknown> | unknown[] = options.transform
        ? Object.fromEntries(columns.map((c, idx) => [c, values[idx]]))
        : values;

      const bound = normalizeRowOutput(inputForTransform, columns);
      if (bound) {
        batch.push(bound);
        if (batch.length >= batchSize) {
          await flushBatch();
        }
      }
    }
  } else {
    for await (const item of parseJsonlRecords(textChunks)) {
      assertNotAborted(options.signal);
      if (Array.isArray(item)) {
        if (!columns || columns.length === 0) {
          throw new Error(
            'copyFromStream with JSON array lines requires options.columns to be specified',
          );
        }
        const bound = normalizeRowOutput(item, columns);
        if (bound) {
          batch.push(bound);
          if (batch.length >= batchSize) {
            await flushBatch();
          }
        }
      } else if (item !== null && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (!columns || columns.length === 0) {
          columns = Object.keys(record);
        }
        const bound = normalizeRowOutput(record, columns);
        if (bound) {
          batch.push(bound);
          if (batch.length >= batchSize) {
            await flushBatch();
          }
        }
      } else {
        throw new Error(
          `Expected JSON object or array per line in ${format} stream`,
        );
      }
    }
  }

  await flushBatch();

  return {
    rowsCopied,
    batches,
    columns: columns ?? [],
  };
}
