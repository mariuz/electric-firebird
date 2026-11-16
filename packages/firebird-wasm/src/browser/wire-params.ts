/**
 * wire-params.ts – Compact `"FBP\x01"` / `"FBP\x02"` binary parameter wire frame (`M20 Item 2`).
 *
 * Eliminates JSON stringification and multi-array structured-cloning overhead
 * when marshalling query/DML parameters and `execBatch` / `pipeline` parameter
 * sets across `WorkerTransport` and `SharedEngineTransport`.
 *
 * Wire layout (`"FBP\x01"` single-statement parameter vector):
 *   bytes 0..3 : ASCII `"FBP"` + version `0x01` (`0x46 0x42 0x50 0x01`)
 *   bytes 4..7 : u32 parameter count (little-endian)
 *   per param  :
 *     u8 tag:
 *       0x00 = SQL NULL
 *       0x01 = boolean false
 *       0x02 = boolean true
 *       0x03 = int32 (i32 LE, 4 bytes) — JS safe integer in [-2^31, 2^31-1]
 *       0x04 = int64 number (i64 LE, 8 bytes) — JS safe integer outside int32
 *       0x84 = int64 bigint (i64 LE, 8 bytes) — JS bigint in [-2^63, 2^63-1]
 *       0x05 = float64 (f64 LE, 8 bytes) — non-integer finite JS number (incl. -0)
 *       0x06 = Date UTC epoch ms (f64 LE, 8 bytes)
 *       0x07 = UTF-8 string (u32 len LE + UTF-8 bytes)
 *       0x87 = BigInt decimal text outside int64 (u32 len LE + ASCII bytes)
 *       0x08 = raw binary bytes (u32 len LE + bytes)
 *       0x09 = Firebird 8-byte `ISC_QUAD` BLOB ID (8 bytes)
 *
 * Batch layout (`"FBP\x02"` multi-row parameter matrix):
 *   bytes 0..3 : ASCII `"FBP"` + version `0x02` (`0x46 0x42 0x50 0x02`)
 *   bytes 4..7 : u32 row count (little-endian)
 *   per row    : u32 param count (LE) followed by `paramCount` tagged cells
 */

import type { QueryParams } from '../types';
import { BLOB_INTERNAL_DATA, extractBlobHandle } from './blob-stream';
import { BINARY_DOUBLE, BINARY_INT64, encodeParams, encodeParamRows } from './params';

export const WIRE_PARAMS_MAGIC_0 = 0x46; // 'F'
export const WIRE_PARAMS_MAGIC_1 = 0x42; // 'B'
export const WIRE_PARAMS_MAGIC_2 = 0x50; // 'P'
export const WIRE_PARAMS_VERSION_SINGLE = 0x01;
export const WIRE_PARAMS_VERSION_BATCH = 0x02;

export const WIRE_PARAM_TAG_NULL = 0x00;
export const WIRE_PARAM_TAG_BOOL_FALSE = 0x01;
export const WIRE_PARAM_TAG_BOOL_TRUE = 0x02;
export const WIRE_PARAM_TAG_INT32 = 0x03;
export const WIRE_PARAM_TAG_INT64_NUM = 0x04;
export const WIRE_PARAM_TAG_INT64_BIGINT = 0x84;
export const WIRE_PARAM_TAG_FLOAT64 = 0x05;
export const WIRE_PARAM_TAG_DATE = 0x06;
export const WIRE_PARAM_TAG_UTF8 = 0x07;
export const WIRE_PARAM_TAG_BIGINT_TEXT = 0x87;
export const WIRE_PARAM_TAG_BYTES = 0x08;
export const WIRE_PARAM_TAG_BLOB_ID = 0x09;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const sharedUtf8Encoder = new TextEncoder();
const sharedUtf8Decoder = new TextDecoder();

/** Check whether `value` is a `"FBP\x01"` single-statement binary parameter frame. */
export function isWireParamsBuffer(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    value.byteLength >= 8 &&
    value[0] === WIRE_PARAMS_MAGIC_0 &&
    value[1] === WIRE_PARAMS_MAGIC_1 &&
    value[2] === WIRE_PARAMS_MAGIC_2 &&
    value[3] === WIRE_PARAMS_VERSION_SINGLE
  );
}

/** Check whether `value` is a `"FBP\x02"` batched multi-row binary parameter frame. */
export function isWireParamRowsBuffer(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    value.byteLength >= 8 &&
    value[0] === WIRE_PARAMS_MAGIC_0 &&
    value[1] === WIRE_PARAMS_MAGIC_1 &&
    value[2] === WIRE_PARAMS_MAGIC_2 &&
    value[3] === WIRE_PARAMS_VERSION_BATCH
  );
}

type PreparedCell =
  | { readonly tag: typeof WIRE_PARAM_TAG_NULL; readonly size: 1 }
  | { readonly tag: typeof WIRE_PARAM_TAG_BOOL_FALSE | typeof WIRE_PARAM_TAG_BOOL_TRUE; readonly size: 1 }
  | { readonly tag: typeof WIRE_PARAM_TAG_INT32; readonly i32: number; readonly size: 5 }
  | {
      readonly tag: typeof WIRE_PARAM_TAG_INT64_NUM | typeof WIRE_PARAM_TAG_INT64_BIGINT;
      readonly i64: bigint;
      readonly size: 9;
    }
  | {
      readonly tag: typeof WIRE_PARAM_TAG_FLOAT64 | typeof WIRE_PARAM_TAG_DATE;
      readonly f64: number;
      readonly size: 9;
    }
  | {
      readonly tag:
        | typeof WIRE_PARAM_TAG_UTF8
        | typeof WIRE_PARAM_TAG_BIGINT_TEXT
        | typeof WIRE_PARAM_TAG_BYTES;
      readonly bytes: Uint8Array;
      readonly size: number;
    }
  | { readonly tag: typeof WIRE_PARAM_TAG_BLOB_ID; readonly quad: Uint8Array; readonly size: 9 };

function prepareWireCell(value: unknown, index: number): PreparedCell {
  if (value === null || value === undefined) {
    return { tag: WIRE_PARAM_TAG_NULL, size: 1 };
  }

  switch (typeof value) {
    case 'boolean':
      return {
        tag: value ? WIRE_PARAM_TAG_BOOL_TRUE : WIRE_PARAM_TAG_BOOL_FALSE,
        size: 1,
      };

    case 'number': {
      if (!Number.isFinite(value)) {
        throw new RangeError(
          `Parameter ${index} is ${value}, which SQL has no representation for`,
        );
      }
      // Preserve -0 as float64 rather than int32 0
      if (Number.isInteger(value) && !Object.is(value, -0)) {
        if (value >= INT32_MIN && value <= INT32_MAX) {
          return { tag: WIRE_PARAM_TAG_INT32, i32: value | 0, size: 5 };
        }
        if (Number.isSafeInteger(value)) {
          return { tag: WIRE_PARAM_TAG_INT64_NUM, i64: BigInt(value), size: 9 };
        }
      }
      return { tag: WIRE_PARAM_TAG_FLOAT64, f64: value, size: 9 };
    }

    case 'bigint': {
      if (value >= INT64_MIN && value <= INT64_MAX) {
        return { tag: WIRE_PARAM_TAG_INT64_BIGINT, i64: value, size: 9 };
      }
      const bytes = sharedUtf8Encoder.encode(value.toString());
      return { tag: WIRE_PARAM_TAG_BIGINT_TEXT, bytes, size: 5 + bytes.byteLength };
    }

    case 'string': {
      const bytes = sharedUtf8Encoder.encode(value);
      return { tag: WIRE_PARAM_TAG_UTF8, bytes, size: 5 + bytes.byteLength };
    }

    default:
      break;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new RangeError(`Parameter ${index} is an invalid Date`);
    }
    return { tag: WIRE_PARAM_TAG_DATE, f64: ms, size: 9 };
  }

  const blobHandle = extractBlobHandle(value, index);
  if (blobHandle) {
    const staged = blobHandle[BLOB_INTERNAL_DATA]?.stagedBytes;
    if (staged) {
      return { tag: WIRE_PARAM_TAG_BYTES, bytes: staged, size: 5 + staged.byteLength };
    }
    return { tag: WIRE_PARAM_TAG_BLOB_ID, quad: blobHandle.blobId, size: 9 };
  }

  if (value instanceof Uint8Array) {
    return { tag: WIRE_PARAM_TAG_BYTES, bytes: value, size: 5 + value.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return { tag: WIRE_PARAM_TAG_BYTES, bytes, size: 5 + bytes.byteLength };
  }

  throw new TypeError(
    `Parameter ${index} has unsupported type ${typeof value}; pass a string, number, bigint, boolean, Date, Uint8Array, null or undefined`,
  );
}

function writePreparedRow(
  out: Uint8Array,
  view: DataView,
  pos: number,
  cells: readonly PreparedCell[],
): number {
  view.setUint32(pos, cells.length, true);
  pos += 4;
  for (const c of cells) {
    out[pos++] = c.tag;
    switch (c.tag) {
      case WIRE_PARAM_TAG_NULL:
      case WIRE_PARAM_TAG_BOOL_FALSE:
      case WIRE_PARAM_TAG_BOOL_TRUE:
        break;
      case WIRE_PARAM_TAG_INT32:
        view.setInt32(pos, c.i32, true);
        pos += 4;
        break;
      case WIRE_PARAM_TAG_INT64_NUM:
      case WIRE_PARAM_TAG_INT64_BIGINT:
        view.setBigInt64(pos, c.i64, true);
        pos += 8;
        break;
      case WIRE_PARAM_TAG_FLOAT64:
      case WIRE_PARAM_TAG_DATE:
        view.setFloat64(pos, c.f64, true);
        pos += 8;
        break;
      case WIRE_PARAM_TAG_UTF8:
      case WIRE_PARAM_TAG_BIGINT_TEXT:
      case WIRE_PARAM_TAG_BYTES:
        view.setUint32(pos, c.bytes.byteLength, true);
        pos += 4;
        out.set(c.bytes, pos);
        pos += c.bytes.byteLength;
        break;
      case WIRE_PARAM_TAG_BLOB_ID:
        out.set(c.quad.subarray(0, 8), pos);
        pos += 8;
        break;
    }
  }
  return pos;
}

/**
 * Encode a `QueryParams` array into a compact `"FBP\x01"` binary wire buffer (`M20 Item 2`).
 * If `params` is already a `"FBP\x01"` buffer, returns it unchanged.
 */
export function encodeWireParams(params: QueryParams | Uint8Array): Uint8Array {
  if (isWireParamsBuffer(params)) {
    return params;
  }
  if (!Array.isArray(params)) {
    throw new TypeError('Parameters must be an array or an FBP\\x01 Uint8Array');
  }
  const cells = params.map((v, i) => prepareWireCell(v, i));
  let totalSize = 8;
  for (const c of cells) totalSize += c.size;

  const out = new Uint8Array(totalSize);
  out[0] = WIRE_PARAMS_MAGIC_0;
  out[1] = WIRE_PARAMS_MAGIC_1;
  out[2] = WIRE_PARAMS_MAGIC_2;
  out[3] = WIRE_PARAMS_VERSION_SINGLE;
  writePreparedRow(out, new DataView(out.buffer), 4, cells);
  return out;
}

/**
 * Encode a batch of `QueryParams[]` rows into a single `"FBP\x02"` binary wire buffer (`M20 Item 2`).
 * If `rows` is already a `"FBP\x02"` buffer, returns it unchanged.
 */
export function encodeWireParamRows(rows: QueryParams[] | Uint8Array): Uint8Array {
  if (isWireParamRowsBuffer(rows)) {
    return rows;
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('Batch rows must be an array of parameter arrays or an FBP\\x02 Uint8Array');
  }
  let totalSize = 8;
  const preparedRows: PreparedCell[][] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) {
      throw new TypeError(`Row ${r} of the batch is not an array of parameters`);
    }
    const cells = row.map((v, i) => prepareWireCell(v, i));
    preparedRows[r] = cells;
    totalSize += 4;
    for (const c of cells) totalSize += c.size;
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  out[0] = WIRE_PARAMS_MAGIC_0;
  out[1] = WIRE_PARAMS_MAGIC_1;
  out[2] = WIRE_PARAMS_MAGIC_2;
  out[3] = WIRE_PARAMS_VERSION_BATCH;
  view.setUint32(4, preparedRows.length, true);
  let pos = 8;
  for (const cells of preparedRows) {
    pos = writePreparedRow(out, view, pos, cells);
  }
  return out;
}

function readWireRowValues(
  buf: Uint8Array,
  view: DataView,
  startPos: number,
): { values: unknown[]; nextPos: number } {
  if (startPos + 4 > buf.byteLength) {
    throw new RangeError('Truncated FBP parameter row header');
  }
  const count = view.getUint32(startPos, true);
  let pos = startPos + 4;
  const values: unknown[] = new Array(count);

  for (let i = 0; i < count; i++) {
    if (pos >= buf.byteLength) {
      throw new RangeError(`Truncated FBP parameter tag at index ${i}`);
    }
    const tag = buf[pos++]!;
    switch (tag) {
      case WIRE_PARAM_TAG_NULL:
        values[i] = null;
        break;
      case WIRE_PARAM_TAG_BOOL_FALSE:
        values[i] = false;
        break;
      case WIRE_PARAM_TAG_BOOL_TRUE:
        values[i] = true;
        break;
      case WIRE_PARAM_TAG_INT32:
        values[i] = view.getInt32(pos, true);
        pos += 4;
        break;
      case WIRE_PARAM_TAG_INT64_NUM:
        values[i] = Number(view.getBigInt64(pos, true));
        pos += 8;
        break;
      case WIRE_PARAM_TAG_INT64_BIGINT:
        values[i] = view.getBigInt64(pos, true);
        pos += 8;
        break;
      case WIRE_PARAM_TAG_FLOAT64:
        values[i] = view.getFloat64(pos, true);
        pos += 8;
        break;
      case WIRE_PARAM_TAG_DATE:
        values[i] = new Date(view.getFloat64(pos, true));
        pos += 8;
        break;
      case WIRE_PARAM_TAG_UTF8: {
        const len = view.getUint32(pos, true);
        pos += 4;
        values[i] = sharedUtf8Decoder.decode(buf.subarray(pos, pos + len));
        pos += len;
        break;
      }
      case WIRE_PARAM_TAG_BIGINT_TEXT: {
        const len = view.getUint32(pos, true);
        pos += 4;
        values[i] = BigInt(sharedUtf8Decoder.decode(buf.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case WIRE_PARAM_TAG_BYTES: {
        const len = view.getUint32(pos, true);
        pos += 4;
        values[i] = buf.slice(pos, pos + len);
        pos += len;
        break;
      }
      case WIRE_PARAM_TAG_BLOB_ID: {
        // Wrap as synthetic 8-byte ISC_QUAD BLOB reference compatible with extractBlobHandle / raw bytes
        const quad = buf.slice(pos, pos + 8);
        pos += 8;
        values[i] = quad;
        break;
      }
      default:
        throw new RangeError(`Unknown FBP parameter tag 0x${tag.toString(16)} at index ${i}`);
    }
  }

  return { values, nextPos: pos };
}

/** Decode a `"FBP\x01"` binary parameter buffer back into `QueryParams` (`M20 Item 2`). */
export function decodeWireParams(input: Uint8Array | QueryParams): QueryParams {
  if (!isWireParamsBuffer(input)) {
    if (Array.isArray(input)) return input;
    throw new TypeError('Expected an FBP\\x01 parameter buffer or QueryParams array');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  return readWireRowValues(input, view, 4).values;
}

/** Decode a `"FBP\x02"` batched binary parameter buffer back into `QueryParams[]` (`M20 Item 2`). */
export function decodeWireParamRows(input: Uint8Array | QueryParams[]): QueryParams[] {
  if (!isWireParamRowsBuffer(input)) {
    if (Array.isArray(input)) return input;
    throw new TypeError('Expected an FBP\\x02 batch parameter buffer or QueryParams[]');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const rowCount = view.getUint32(4, true);
  let pos = 8;
  const rows: QueryParams[] = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const parsed = readWireRowValues(input, view, pos);
    rows[r] = parsed.values;
    pos = parsed.nextPos;
  }
  return rows;
}

const ASCII_TRUE = new Uint8Array([0x54, 0x52, 0x55, 0x45]); // "TRUE"
const ASCII_FALSE = new Uint8Array([0x46, 0x41, 0x4c, 0x53, 0x45]); // "FALSE"

interface CAbiCell {
  flags: number;
  text: Uint8Array | null;
  binaryKind: number;
  binaryI64: bigint;
  binaryF64: number;
}

function readWireRowAsCAbi(
  buf: Uint8Array,
  view: DataView,
  startPos: number,
): { cells: CAbiCell[]; byteSize: number; nextPos: number } {
  const count = view.getUint32(startPos, true);
  let pos = startPos + 4;
  const cells: CAbiCell[] = new Array(count);
  let byteSize = 4;

  for (let i = 0; i < count; i++) {
    const tag = buf[pos++]!;
    switch (tag) {
      case WIRE_PARAM_TAG_NULL:
        cells[i] = { flags: 1, text: null, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1;
        break;
      case WIRE_PARAM_TAG_BOOL_FALSE:
        cells[i] = { flags: 0, text: ASCII_FALSE, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1 + 4 + 5;
        break;
      case WIRE_PARAM_TAG_BOOL_TRUE:
        cells[i] = { flags: 0, text: ASCII_TRUE, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1 + 4 + 4;
        break;
      case WIRE_PARAM_TAG_INT32: {
        const v = view.getInt32(pos, true);
        pos += 4;
        const text = sharedUtf8Encoder.encode(String(v));
        cells[i] = {
          flags: 2,
          text,
          binaryKind: BINARY_INT64,
          binaryI64: BigInt(v),
          binaryF64: 0,
        };
        byteSize += 1 + 4 + text.byteLength + 9;
        break;
      }
      case WIRE_PARAM_TAG_INT64_NUM:
      case WIRE_PARAM_TAG_INT64_BIGINT: {
        const v = view.getBigInt64(pos, true);
        pos += 8;
        const text = sharedUtf8Encoder.encode(v.toString());
        cells[i] = {
          flags: 2,
          text,
          binaryKind: BINARY_INT64,
          binaryI64: v,
          binaryF64: 0,
        };
        byteSize += 1 + 4 + text.byteLength + 9;
        break;
      }
      case WIRE_PARAM_TAG_FLOAT64: {
        const v = view.getFloat64(pos, true);
        pos += 8;
        const text = sharedUtf8Encoder.encode(String(v));
        cells[i] = {
          flags: 2,
          text,
          binaryKind: BINARY_DOUBLE,
          binaryI64: 0n,
          binaryF64: v,
        };
        byteSize += 1 + 4 + text.byteLength + 9;
        break;
      }
      case WIRE_PARAM_TAG_DATE: {
        const ms = view.getFloat64(pos, true);
        pos += 8;
        const iso = new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
        const text = sharedUtf8Encoder.encode(iso);
        cells[i] = { flags: 0, text, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1 + 4 + text.byteLength;
        break;
      }
      case WIRE_PARAM_TAG_UTF8:
      case WIRE_PARAM_TAG_BIGINT_TEXT: {
        const len = view.getUint32(pos, true);
        pos += 4;
        const text = buf.subarray(pos, pos + len);
        pos += len;
        cells[i] = { flags: 0, text, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1 + 4 + text.byteLength;
        break;
      }
      case WIRE_PARAM_TAG_BYTES: {
        const len = view.getUint32(pos, true);
        pos += 4;
        const bytes = buf.subarray(pos, pos + len);
        pos += len;
        cells[i] = { flags: 4, text: bytes, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1 + 4 + bytes.byteLength;
        break;
      }
      case WIRE_PARAM_TAG_BLOB_ID: {
        const quad = buf.subarray(pos, pos + 8);
        pos += 8;
        cells[i] = { flags: 8, text: quad, binaryKind: 0, binaryI64: 0n, binaryF64: 0 };
        byteSize += 1 + 4 + 8;
        break;
      }
      default:
        throw new RangeError(`Unknown FBP parameter tag 0x${tag.toString(16)}`);
    }
  }

  return { cells, byteSize, nextPos: pos };
}

function writeCAbiRow(out: Uint8Array, view: DataView, pos: number, cells: readonly CAbiCell[]): number {
  view.setUint32(pos, cells.length, true);
  pos += 4;
  for (const c of cells) {
    out[pos++] = c.flags;
    if (c.text) {
      view.setUint32(pos, c.text.byteLength, true);
      pos += 4;
      out.set(c.text, pos);
      pos += c.text.byteLength;
    }
    if ((c.flags & 2) !== 0) {
      out[pos++] = c.binaryKind;
      if (c.binaryKind === BINARY_INT64) {
        view.setBigInt64(pos, c.binaryI64, true);
      } else {
        view.setFloat64(pos, c.binaryF64, true);
      }
      pos += 8;
    }
  }
  return pos;
}

/**
 * Convert either `QueryParams` or a `"FBP\x01"` wire buffer directly into the
 * WASM C-ABI parameter buffer without allocating intermediate JS arrays (`M20 Item 2`).
 */
export function wireParamsToCAbi(params: QueryParams | Uint8Array): Uint8Array {
  if (!isWireParamsBuffer(params)) {
    return encodeParams(params as QueryParams);
  }
  const view = new DataView(params.buffer, params.byteOffset, params.byteLength);
  const { cells, byteSize } = readWireRowAsCAbi(params, view, 4);
  const out = new Uint8Array(byteSize);
  writeCAbiRow(out, new DataView(out.buffer), 0, cells);
  return out;
}

/**
 * Convert either `QueryParams[]` or a `"FBP\x02"` batch wire buffer directly into
 * the WASM C-ABI batch parameter buffer (`M20 Item 2`).
 */
export function wireParamRowsToCAbi(rows: QueryParams[] | Uint8Array): Uint8Array {
  if (!isWireParamRowsBuffer(rows)) {
    return encodeParamRows(rows as QueryParams[]);
  }
  const view = new DataView(rows.buffer, rows.byteOffset, rows.byteLength);
  const rowCount = view.getUint32(4, true);
  let pos = 8;
  let totalSize = 4;
  const parsedRows: CAbiCell[][] = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const parsed = readWireRowAsCAbi(paramsSlice(rows), view, pos);
    parsedRows[r] = parsed.cells;
    totalSize += parsed.byteSize;
    pos = parsed.nextPos;
  }
  const out = new Uint8Array(totalSize);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, rowCount, true);
  let outPos = 4;
  for (const cells of parsedRows) {
    outPos = writeCAbiRow(out, outView, outPos, cells);
  }
  return out;
}

function paramsSlice(buf: Uint8Array): Uint8Array {
  return buf;
}
