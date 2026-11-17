/**
 * arrow-ingest.ts – Zero-Copy Apache Arrow IPC Ingestion (`db.loadArrowIpc()`,
 * `tx.loadArrowIpc()`, `table.insertArrow()`, `table.upsertArrow()`) (`M22 Item 2`).
 *
 * Streams or decodes Apache Arrow IPC V5 `Schema` + `RecordBatch` frames and packs
 * typed column vectors (`Int32Array`, `BigInt64Array`, `Float64Array`, bit-packed
 * booleans, and contiguous UTF-8 / binary offset buffers) directly into `"FBP\x02"`
 * binary wire batches (`IBatch`) without allocating intermediate JS row objects or
 * decoding UTF-8 strings.
 */

import type { FieldInfo, PreparedStatement, QueryParams, Row } from './types';
import {
  decodeArrowIpcBatches,
  isColumnValueValid,
  type ColumnarQueryResult,
  type ColumnVector,
} from './columnar';
import {
  WIRE_PARAMS_MAGIC_0,
  WIRE_PARAMS_MAGIC_1,
  WIRE_PARAMS_MAGIC_2,
  WIRE_PARAMS_VERSION_BATCH,
  WIRE_PARAM_TAG_BOOL_FALSE,
  WIRE_PARAM_TAG_BOOL_TRUE,
  WIRE_PARAM_TAG_BYTES,
  WIRE_PARAM_TAG_FLOAT64,
  WIRE_PARAM_TAG_INT32,
  WIRE_PARAM_TAG_INT64_BIGINT,
  WIRE_PARAM_TAG_NULL,
  WIRE_PARAM_TAG_UTF8,
} from './browser/wire-params';
import { quoteTableIdent } from './table-api';
import { assertNotAborted } from './database-core';

const ARROW_CONTINUATION = 0xffffffff;

export type ArrowIngestSource =
  | Uint8Array
  | ArrayBuffer
  | ColumnarQueryResult
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface LoadArrowIpcOptions {
  /**
   * Automatically execute `CREATE TABLE` derived from the Arrow `Schema` if
   * the target table does not already exist.
   *
   * @default false
   */
  createTable?: boolean;
  /**
   * Primary key column(s) included in generated `CREATE TABLE` DDL when
   * `createTable: true`.
   */
  primaryKey?: string | readonly string[];
  /**
   * When set, uses Firebird `UPDATE OR INSERT INTO ... MATCHING (...)` instead
   * of `INSERT INTO ...`. Pass `true` to match on `primaryKey` (or `'ID'`).
   */
  upsertMatching?: boolean | string | readonly string[];
  /** Optional subset of column names to ingest from the Arrow schema. */
  columns?: readonly string[];
  /** Maximum rows packed per `IBatch` execution (`"FBP\x02"`). @default 1000 */
  batchSize?: number;
  /**
   * Wrap multi-batch ingestion in an explicit database transaction when
   * supported by the target host.
   *
   * @default true
   */
  transaction?: boolean;
  /** Optional `AbortSignal` checked between batches. */
  signal?: AbortSignal;
}

export interface ArrowIngestResult {
  readonly tableName: string;
  readonly rowsIngested: number;
  readonly batchesExecuted: number;
  readonly bytesProcessed: number;
  readonly tableCreated: boolean;
  readonly columns: readonly string[];
}

export interface ArrowIngestHost {
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  execBatch(
    sql: string,
    rows: QueryParams[],
  ): Promise<{ affectedRows: number } | void>;
  /** Optional fast path accepting a pre-packed `"FBP\x02"` `Uint8Array` directly (`FirebirdBrowser` / `FirebirdBrowserTransaction`). */
  execWireBatch?(
    sql: string,
    wireRows: Uint8Array,
    rowCount: number,
  ): Promise<{ affectedRows: number }>;
  prepare?(sql: string): Promise<PreparedStatement>;
  query?<T extends Row = Row>(sql: string, params?: QueryParams): Promise<{ rows: T[] }>;
}

function isColumnarQueryResult(val: unknown): val is ColumnarQueryResult {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as ColumnarQueryResult).rowCount === 'number' &&
    Array.isArray((val as ColumnarQueryResult).vectors) &&
    Array.isArray((val as ColumnarQueryResult).fields)
  );
}

function isReadableStream(val: unknown): val is ReadableStream<Uint8Array> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as ReadableStream<Uint8Array>).getReader === 'function'
  );
}

function mapFieldToFirebirdSqlType(field: FieldInfo, isKeyColumn = false): string {
  const tn = (field.typeName ?? 'VARYING').toUpperCase();
  switch (tn) {
    case 'SMALLINT':
      return 'SMALLINT';
    case 'INTEGER':
      return 'INTEGER';
    case 'BIGINT':
      return 'BIGINT';
    case 'INT128':
      return 'INT128';
    case 'FLOAT':
      return 'FLOAT';
    case 'DOUBLE':
      return 'DOUBLE PRECISION';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'DATE':
      return 'DATE';
    case 'TIME':
      return 'TIME';
    case 'TIMESTAMP':
      return 'TIMESTAMP';
    case 'BLOB':
      if (isKeyColumn) return 'VARCHAR(255)';
      return field.subType === 1 ? 'BLOB SUB_TYPE TEXT' : 'BLOB SUB_TYPE BINARY';
    default: {
      const defaultLen = isKeyColumn ? 255 : 1024;
      const maxLen = isKeyColumn ? 255 : 8191;
      const len =
        field.length && field.length > 0 && field.length <= maxLen
          ? field.length
          : defaultLen;
      return `VARCHAR(${len})`;
    }
  }
}

/**
 * Generate a safe Firebird `CREATE TABLE` DDL statement from Arrow / `ColumnarQueryResult`
 * `FieldInfo` metadata (`M22 Item 2`).
 */
export function buildCreateTableDdlFromColumnar(
  tableName: string,
  fields: readonly FieldInfo[],
  options: { primaryKey?: string | readonly string[] } = {},
): string {
  if (fields.length === 0) {
    throw new Error(`Cannot generate CREATE TABLE for "${tableName}" from an empty Arrow schema`);
  }
  const pkSet = new Set<string>(
    options.primaryKey === undefined
      ? []
      : typeof options.primaryKey === 'string'
        ? [options.primaryKey.toUpperCase()]
        : options.primaryKey.map((k) => k.toUpperCase()),
  );

  const colDefs = fields.map((f) => {
    const colIdent = quoteTableIdent(f.name);
    const isPk = pkSet.has(f.name.toUpperCase());
    const sqlType = mapFieldToFirebirdSqlType(f, isPk);
    const notNull = isPk || f.nullable === false ? ' NOT NULL' : '';
    return `${colIdent} ${sqlType}${notNull}`;
  });

  if (pkSet.size > 0) {
    const pkCols = (
      typeof options.primaryKey === 'string'
        ? [options.primaryKey]
        : [...(options.primaryKey ?? [])]
    ).map((k) => quoteTableIdent(k));
    colDefs.push(`PRIMARY KEY (${pkCols.join(', ')})`);
  }

  return `CREATE TABLE ${quoteTableIdent(tableName)} (${colDefs.join(', ')})`;
}

/**
 * Pack a row range `[startRow, endRow)` of a `ColumnarQueryResult` directly into a
 * binary `"FBP\x02"` wire-batch `Uint8Array` without allocating JS row objects or
 * decoding UTF-8 strings (`M22 Item 2`).
 */
export function encodeColumnarBatchToWireRows(
  batch: ColumnarQueryResult,
  options: {
    startRow?: number;
    endRow?: number;
    columnIndices?: readonly number[];
  } = {},
): Uint8Array {
  const startRow = Math.max(0, options.startRow ?? 0);
  const endRow = Math.min(batch.rowCount, options.endRow ?? batch.rowCount);
  const rowCount = Math.max(0, endRow - startRow);
  const colIndices =
    options.columnIndices ?? batch.vectors.map((_, idx) => idx);
  const colCount = colIndices.length;
  const selectedVectors: ColumnVector[] = colIndices.map((idx) => {
    const v = batch.vectors[idx];
    if (!v) {
      throw new RangeError(`Column index ${idx} is out of bounds (${batch.vectors.length})`);
    }
    return v;
  });

  // Pass 1: exact byte size calculation directly over typed arrays / offset tables
  let totalBytes = 8 + rowCount * 4;
  for (let c = 0; c < colCount; c++) {
    const vec = selectedVectors[c]!;
    const hasNulls = vec.nullCount > 0 && vec.validity.byteLength > 0;
    switch (vec.kind) {
      case 'bool':
        totalBytes += rowCount; // 1 byte tag whether null, false, or true!
        break;
      case 'int32':
        if (!hasNulls) {
          totalBytes += rowCount * 5;
        } else {
          for (let r = startRow; r < endRow; r++) {
            totalBytes += isColumnValueValid(vec.validity, r) ? 5 : 1;
          }
        }
        break;
      case 'bigint64':
      case 'float64':
        if (!hasNulls) {
          totalBytes += rowCount * 9;
        } else {
          for (let r = startRow; r < endRow; r++) {
            totalBytes += isColumnValueValid(vec.validity, r) ? 9 : 1;
          }
        }
        break;
      case 'utf8':
      case 'bytes':
        for (let r = startRow; r < endRow; r++) {
          if (hasNulls && !isColumnValueValid(vec.validity, r)) {
            totalBytes += 1;
          } else {
            const len = vec.offsets[r + 1]! - vec.offsets[r]!;
            totalBytes += 5 + len;
          }
        }
        break;
    }
  }

  // Pass 2: write `"FBP\x02"` frame directly from typed vectors
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  out[0] = WIRE_PARAMS_MAGIC_0;
  out[1] = WIRE_PARAMS_MAGIC_1;
  out[2] = WIRE_PARAMS_MAGIC_2;
  out[3] = WIRE_PARAMS_VERSION_BATCH;
  view.setUint32(4, rowCount, true);

  let pos = 8;
  for (let r = startRow; r < endRow; r++) {
    view.setUint32(pos, colCount, true);
    pos += 4;
    for (let c = 0; c < colCount; c++) {
      const vec = selectedVectors[c]!;
      if (vec.nullCount > 0 && vec.validity.byteLength > 0 && !isColumnValueValid(vec.validity, r)) {
        out[pos++] = WIRE_PARAM_TAG_NULL;
        continue;
      }
      switch (vec.kind) {
        case 'bool': {
          const bit = (vec.data[r >> 3]! & (1 << (r & 7))) !== 0;
          out[pos++] = bit ? WIRE_PARAM_TAG_BOOL_TRUE : WIRE_PARAM_TAG_BOOL_FALSE;
          break;
        }
        case 'int32': {
          out[pos++] = WIRE_PARAM_TAG_INT32;
          view.setInt32(pos, vec.data[r]!, true);
          pos += 4;
          break;
        }
        case 'bigint64': {
          out[pos++] = WIRE_PARAM_TAG_INT64_BIGINT;
          view.setBigInt64(pos, vec.data[r]!, true);
          pos += 8;
          break;
        }
        case 'float64': {
          out[pos++] = WIRE_PARAM_TAG_FLOAT64;
          view.setFloat64(pos, vec.data[r]!, true);
          pos += 8;
          break;
        }
        case 'utf8': {
          const sOff = vec.offsets[r]!;
          const eOff = vec.offsets[r + 1]!;
          const byteLen = eOff - sOff;
          out[pos++] = WIRE_PARAM_TAG_UTF8;
          view.setUint32(pos, byteLen, true);
          pos += 4;
          if (byteLen > 0) {
            out.set(vec.data.subarray(sOff, eOff), pos);
            pos += byteLen;
          }
          break;
        }
        case 'bytes': {
          const sOff = vec.offsets[r]!;
          const eOff = vec.offsets[r + 1]!;
          const byteLen = eOff - sOff;
          out[pos++] = WIRE_PARAM_TAG_BYTES;
          view.setUint32(pos, byteLen, true);
          pos += 4;
          if (byteLen > 0) {
            out.set(vec.data.subarray(sOff, eOff), pos);
            pos += byteLen;
          }
          break;
        }
      }
    }
  }

  return out;
}

function extractColumnarParamMatrix(
  batch: ColumnarQueryResult,
  startRow: number,
  endRow: number,
  colIndices: readonly number[],
): QueryParams[] {
  const count = endRow - startRow;
  const rows: QueryParams[] = new Array(count);
  for (let r = startRow; r < endRow; r++) {
    const row: unknown[] = new Array(colIndices.length);
    for (let c = 0; c < colIndices.length; c++) {
      row[c] = batch.vectors[colIndices[c]!]!.get(r);
    }
    rows[r - startRow] = row;
  }
  return rows;
}

async function* readChunksFromStreamOrIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (isReadableStream(source)) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of source) {
    if (chunk && chunk.byteLength > 0) yield chunk;
  }
}

function appendBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function readMessageFrameLength(buf: Uint8Array, offset: number): {
  complete: boolean;
  isEos: boolean;
  totalFrameBytes: number;
  bodyBytes: number;
} {
  if (offset + 4 > buf.byteLength) {
    return { complete: false, isEos: false, totalFrameBytes: 0, bodyBytes: 0 };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = offset;
  let metaSize = view.getInt32(pos, true);
  pos += 4;
  if (metaSize === -1 || (metaSize >>> 0) === ARROW_CONTINUATION) {
    if (pos + 4 > buf.byteLength) {
      return { complete: false, isEos: false, totalFrameBytes: 0, bodyBytes: 0 };
    }
    metaSize = view.getInt32(pos, true);
    pos += 4;
  }
  if (metaSize === 0) {
    return { complete: true, isEos: true, totalFrameBytes: pos - offset, bodyBytes: 0 };
  }
  if (metaSize < 0) {
    throw new Error('Invalid negative Arrow IPC metadata length');
  }
  if (pos + metaSize > buf.byteLength) {
    return { complete: false, isEos: false, totalFrameBytes: 0, bodyBytes: 0 };
  }

  // Inspect FlatBuffer Message root table (`bodyLength` is vtable slot 3, i64)
  const metaSlice = buf.subarray(pos, pos + metaSize);
  const metaView = new DataView(
    metaSlice.buffer,
    metaSlice.byteOffset,
    metaSlice.byteLength,
  );
  const rootPos = metaView.getInt32(0, true);
  const vtablePos = rootPos - metaView.getInt32(rootPos, true);
  const vtableLen = metaView.getUint16(vtablePos, true);
  const bodyFieldOffset = 4 + 3 * 2;
  let bodyLength = 0;
  if (bodyFieldOffset < vtableLen) {
    const fieldRel = metaView.getUint16(vtablePos + bodyFieldOffset, true);
    if (fieldRel !== 0) {
      bodyLength = Number(metaView.getBigInt64(rootPos + fieldRel, true));
    }
  }

  const totalFrameBytes = pos - offset + metaSize + bodyLength;
  if (offset + totalFrameBytes > buf.byteLength) {
    return { complete: false, isEos: false, totalFrameBytes: 0, bodyBytes: 0 };
  }
  return {
    complete: true,
    isEos: false,
    totalFrameBytes,
    bodyBytes: bodyLength,
  };
}

/**
 * Incrementally yield `ColumnarQueryResult` batches from any `ArrowIngestSource`
 * (`Uint8Array`, `ArrayBuffer`, `ColumnarQueryResult`, `ReadableStream<Uint8Array>`,
 * or `AsyncIterable<Uint8Array>`) in bounded `O(batchSize)` memory (`M22 Item 2`).
 */
export async function* iterateArrowIpcBatches(
  source: ArrowIngestSource,
): AsyncGenerator<{ batch: ColumnarQueryResult; byteLength: number }> {
  if (isColumnarQueryResult(source)) {
    yield { batch: source, byteLength: 0 };
    return;
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const decoded = decodeArrowIpcBatches(bytes);
    let reportedBytes = bytes.byteLength;
    for (const batch of decoded) {
      yield { batch, byteLength: reportedBytes };
      reportedBytes = 0;
    }
    return;
  }

  // Incremental framing parser for `ReadableStream<Uint8Array>` / `AsyncIterable<Uint8Array>`:
  // Captures the leading `Schema` message frame once, then decodes each `RecordBatch`
  // frame immediately upon arrival by prepending `schemaFrameBytes` + `recordBatchFrameBytes`!
  let buffer: Uint8Array = new Uint8Array(0);
  let schemaFrame: Uint8Array | null = null;
  let yieldedAny = false;
  let totalStreamBytes = 0;

  for await (const chunk of readChunksFromStreamOrIterable(source)) {
    totalStreamBytes += chunk.byteLength;
    buffer = appendBytes(buffer, chunk);

    for (;;) {
      const frame = readMessageFrameLength(buffer, 0);
      if (!frame.complete) break;
      if (frame.isEos) {
        buffer = buffer.subarray(frame.totalFrameBytes);
        break;
      }
      const frameSlice = buffer.slice(0, frame.totalFrameBytes);
      buffer = buffer.subarray(frame.totalFrameBytes);

      if (schemaFrame === null) {
        schemaFrame = frameSlice;
      } else {
        const combined = appendBytes(schemaFrame, frameSlice);
        const batches = decodeArrowIpcBatches(combined);
        for (const b of batches) {
          yieldedAny = true;
          yield { batch: b, byteLength: frameSlice.byteLength };
        }
      }
    }
  }

  if (!yieldedAny && schemaFrame !== null) {
    const batches = decodeArrowIpcBatches(schemaFrame);
    for (const b of batches) {
      yield { batch: b, byteLength: totalStreamBytes };
    }
  }
}

async function tableExistsOnHost(
  host: ArrowIngestHost,
  tableName: string,
): Promise<boolean> {
  if (typeof host.query !== 'function') return false;
  const upper = tableName.replace(/^"+|"+$/g, '').toUpperCase();
  try {
    const res = await host.query<Row>(
      'SELECT FIRST 1 TRIM(RDB$RELATION_NAME) AS REL FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [upper],
    );
    if (res.rows.length > 0) return true;
  } catch {
    // Fallback probe for lightweight mock databases without RDB$RELATIONS
    try {
      await host.query<Row>(`SELECT FIRST 1 * FROM ${quoteTableIdent(tableName)}`);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Ingest an Apache Arrow IPC V5 payload, `ColumnarQueryResult`, `ReadableStream`,
 * or `AsyncIterable` into `tableName` via zero-copy `"FBP\x02"` `IBatch` frames (`M22 Item 2`).
 */
export async function loadArrowIpcIntoDatabase(
  host: ArrowIngestHost,
  tableName: string,
  source: ArrowIngestSource,
  options: LoadArrowIpcOptions = {},
): Promise<ArrowIngestResult> {
  assertNotAborted(options.signal);
  const quotedTable = quoteTableIdent(tableName);
  const maxBatchRows = Math.max(1, Math.floor(options.batchSize ?? 1000));
  const txStarter = (
    host as { transaction?: <R>(fn: (tx: ArrowIngestHost) => Promise<R>) => Promise<R> }
  ).transaction;
  const useTx = options.transaction !== false && typeof txStarter === 'function';

  let tableCreated = false;
  let schemaChecked = false;
  let targetColumns: string[] = [];
  let dmlSql = '';

  const ensureSchemaFromFirstBatch = async (
    runner: ArrowIngestHost,
    firstBatch: ColumnarQueryResult,
  ): Promise<number[]> => {
    const wantedSet = options.columns
      ? new Set(options.columns.map((c) => c.toUpperCase()))
      : null;

    const indices: number[] = [];
    const selectedFields: FieldInfo[] = [];
    for (let i = 0; i < firstBatch.fields.length; i++) {
      const f = firstBatch.fields[i]!;
      if (!wantedSet || wantedSet.has(f.name.toUpperCase())) {
        indices.push(i);
        selectedFields.push(f);
      }
    }
    if (selectedFields.length === 0) {
      throw new Error(
        `loadArrowIpc("${tableName}"): Arrow schema has no matching columns to ingest`,
      );
    }

    if (!schemaChecked) {
      schemaChecked = true;
      if (options.createTable) {
        const exists = await tableExistsOnHost(host, tableName);
        if (!exists) {
          const ddl = buildCreateTableDdlFromColumnar(tableName, selectedFields, {
            primaryKey: options.primaryKey,
          });
          if (typeof host.execute === 'function') {
            await host.execute(ddl);
          } else if (typeof host.exec === 'function') {
            await host.exec(ddl);
          } else if (typeof runner.execute === 'function') {
            await runner.execute(ddl);
          } else if (typeof runner.exec === 'function') {
            await runner.exec(ddl);
          }
          tableCreated = true;
        }
      }

      targetColumns = selectedFields.map((f) => f.name);
      const colsSql = targetColumns.map((c) => quoteTableIdent(c)).join(', ');
      const placeholders = targetColumns.map(() => '?').join(', ');

      if (options.upsertMatching) {
        const rawMatch =
          options.upsertMatching === true
            ? (options.primaryKey ?? 'ID')
            : options.upsertMatching;
        const matchList = (typeof rawMatch === 'string' ? [rawMatch] : rawMatch).map((c) =>
          quoteTableIdent(c),
        );
        dmlSql = `UPDATE OR INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders}) MATCHING (${matchList.join(', ')})`;
      } else {
        dmlSql = `INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders})`;
      }
    }

    return indices;
  };

  let rowsIngested = 0;
  let batchesExecuted = 0;
  let bytesProcessed =
    source instanceof Uint8Array
      ? source.byteLength
      : source instanceof ArrayBuffer
        ? source.byteLength
        : 0;

  const runIngestion = async (runner: ArrowIngestHost): Promise<void> => {
    for await (const { batch, byteLength } of iterateArrowIpcBatches(source)) {
      assertNotAborted(options.signal);
      if (
        !(source instanceof Uint8Array) &&
        !(source instanceof ArrayBuffer) &&
        byteLength > 0
      ) {
        bytesProcessed += byteLength;
      }
      const colIndices = await ensureSchemaFromFirstBatch(runner, batch);
      if (batch.rowCount === 0) continue;

      for (let start = 0; start < batch.rowCount; start += maxBatchRows) {
        assertNotAborted(options.signal);
        const end = Math.min(batch.rowCount, start + maxBatchRows);
        const sliceCount = end - start;
        if (typeof runner.execWireBatch === 'function') {
          const wireRows = encodeColumnarBatchToWireRows(batch, {
            startRow: start,
            endRow: end,
            columnIndices: colIndices,
          });
          await runner.execWireBatch(dmlSql, wireRows, sliceCount);
        } else {
          const matrix = extractColumnarParamMatrix(batch, start, end, colIndices);
          await runner.execBatch(dmlSql, matrix);
        }
        rowsIngested += sliceCount;
        batchesExecuted += 1;
      }
    }
  };

  // If `createTable: true` and `useTx` is enabled, Firebird requires DDL to be
  // committed in its own transaction before DML binds against the newly created
  // table! So when `createTable: true` on a stream/buffer, peek or create outside tx.
  if (options.createTable && (source instanceof Uint8Array || source instanceof ArrayBuffer || isColumnarQueryResult(source))) {
    const preview = isColumnarQueryResult(source)
      ? source
      : decodeArrowIpcBatches(source instanceof Uint8Array ? source : new Uint8Array(source))[0];
    if (preview) {
      await ensureSchemaFromFirstBatch(host, preview);
    }
  }

  if (useTx && !options.createTable) {
    await txStarter.call(host, runIngestion);
  } else if (useTx && schemaChecked) {
    await txStarter.call(host, runIngestion);
  } else {
    await runIngestion(host);
  }

  return {
    tableName: tableName.replace(/^"+|"+$/g, '').toUpperCase(),
    rowsIngested,
    batchesExecuted,
    bytesProcessed,
    tableCreated,
    columns: targetColumns,
  };
}
