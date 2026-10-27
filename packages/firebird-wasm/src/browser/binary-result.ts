/**
 * binary-result.ts – Packed binary result-set wire format across the WASM C
 * bridge (`_fb_query_binary` / `_fb_cursor_fetch_binary`).
 *
 * Replaces `JSON.stringify` / `JSON.parse` + base64 BLOB encoding with a
 * single contiguous binary buffer in WASM linear memory:
 *
 * Header:
 *   - `u8[4]` magic: `0x46, 0x42, 0x52, 0x01` (`"FBR\x01"`)
 *   - `u8`    headerFlags:
 *               bit 0 (`0x01`): `hasShapeId` — when set, column metadata is
 *               replaced by a `u32` shape ID resolved via `shapes(id)`.
 *   - Column descriptors:
 *       - If `(headerFlags & 0x01) !== 0`: `u32` shapeId (LE)
 *       - Else: `u16` columnCount (LE), followed by `columnCount` descriptors:
 *           - `u16` nameByteLen (LE) + UTF-8 column name bytes
 *           - `u16` type (LE)
 *           - `i16` subType (LE)
 *           - `i16` scale (LE)
 *           - `u32` length (LE)
 *           - `u8`  nullable (`1` or `0`)
 *   - `u32`   rowCount (LE)
 *
 * Per row (`0 .. rowCount - 1`):
 *   - `u8[ceil(columnCount / 8)]` null bitmask (`bit (col & 7)` of byte
 *     `col >> 3` is `1` when column `col` is `NULL`)
 *   - For each non-null column `col`:
 *       - `u8` cellTag:
 *           - `1` (`BINARY_CELL_BOOL`):    `u8` (`0` = `false`, `1` = `true`)
 *           - `2` (`BINARY_CELL_INT32`):   `i32` LE (`number`)
 *           - `3` (`BINARY_CELL_FLOAT64`): `f64` LE (`number`)
 *           - `4` (`BINARY_CELL_UTF8`):    `u32` byteLength LE + UTF-8 bytes (`string`)
 *           - `5` (`BINARY_CELL_BYTES`):   `u32` byteLength LE + raw bytes
 *             (`Uint8Array` when `binaryBlobs` is `true`, or base64 `string`
 *             when `binaryBlobs` is `false`)
 */

import type { FieldInfo, QueryResult, Row, RowMode } from '../types';
import { firebirdTypeName } from './field-types';

/** 4-byte wire header magic `"FBR\x01"`. */
export const BINARY_RESULT_MAGIC_0 = 0x46; // 'F'
export const BINARY_RESULT_MAGIC_1 = 0x42; // 'B'
export const BINARY_RESULT_MAGIC_2 = 0x52; // 'R'
export const BINARY_RESULT_VERSION = 0x01;

/** Header flag bit: header carries `u32 shapeId` instead of inline columns. */
export const BINARY_HEADER_HAS_SHAPE_ID = 0x01;

/** Cell tag constants written after each row's null bitmask for non-null cells. */
export const BINARY_CELL_BOOL = 1;
export const BINARY_CELL_INT32 = 2;
export const BINARY_CELL_FLOAT64 = 3;
export const BINARY_CELL_UTF8 = 4;
export const BINARY_CELL_BYTES = 5;

const sharedDecoder = new TextDecoder();
const sharedEncoder = new TextEncoder();

function decodeUtf8(buffer: Uint8Array, start: number, end: number): string {
  if (start >= end) return '';
  const slice =
    typeof SharedArrayBuffer !== 'undefined' &&
    buffer.buffer instanceof SharedArrayBuffer
      ? buffer.slice(start, end)
      : buffer.subarray(start, end);
  return sharedDecoder.decode(slice);
}

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const len = bytes.byteLength;
  while (i + 2 < len) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_CHARS[(v >> 18) & 0x3f]! +
      BASE64_CHARS[(v >> 12) & 0x3f]! +
      BASE64_CHARS[(v >> 6) & 0x3f]! +
      BASE64_CHARS[v & 0x3f]!;
    i += 3;
  }
  const rem = len - i;
  if (rem === 1) {
    const v = bytes[i]! << 16;
    out +=
      BASE64_CHARS[(v >> 18) & 0x3f]! +
      BASE64_CHARS[(v >> 12) & 0x3f]! +
      '==';
  } else if (rem === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_CHARS[(v >> 18) & 0x3f]! +
      BASE64_CHARS[(v >> 12) & 0x3f]! +
      BASE64_CHARS[(v >> 6) & 0x3f]! +
      '=';
  }
  return out;
}

const rowBuilders = new Map<string, (cols: unknown[]) => Row>();
const MAX_ROW_BUILDERS = 64;
let codeGenerationBlocked = false;

function stringLiteral(name: string): string {
  return JSON.stringify(name)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getRowBuilder(names: string[]): ((cols: unknown[]) => Row) | null {
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
      'return {' +
        names.map((n, i) => `${stringLiteral(n)}:c[${i}]`).join(',') +
        '}',
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

/**
 * Decode a binary result buffer produced by `_fb_query_binary`,
 * `_fb_cursor_fetch_binary`, or {@link encodeBinaryResultSet} into a
 * {@link QueryResult}.
 */
export function decodeBinaryResultSet<T = Row>(
  buffer: Uint8Array,
  rowMode: RowMode = 'object',
  binaryBlobs = false,
  shapes?: (id: number) => readonly FieldInfo[],
): QueryResult<T> {
  if (
    buffer.byteLength < 9 ||
    buffer[0] !== BINARY_RESULT_MAGIC_0 ||
    buffer[1] !== BINARY_RESULT_MAGIC_1 ||
    buffer[2] !== BINARY_RESULT_MAGIC_2 ||
    buffer[3] !== BINARY_RESULT_VERSION
  ) {
    throw new Error('decodeBinaryResultSet: invalid binary result header');
  }

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const headerFlags = buffer[4]!;
  let pos = 5;

  let fields: FieldInfo[];
  if ((headerFlags & BINARY_HEADER_HAS_SHAPE_ID) !== 0) {
    if (!shapes) {
      throw new Error(
        'decodeBinaryResultSet: buffer references a shape ID but no shapes resolver was provided',
      );
    }
    const shapeId = view.getUint32(pos, true);
    pos += 4;
    fields = shapes(shapeId).map((f) => ({ ...f }));
  } else {
    const colCount = view.getUint16(pos, true);
    pos += 2;
    fields = new Array<FieldInfo>(colCount);
    for (let i = 0; i < colCount; i++) {
      const nameLen = view.getUint16(pos, true);
      pos += 2;
      const name =
        nameLen === 0
          ? ''
          : decodeUtf8(buffer, pos, pos + nameLen);
      pos += nameLen;
      const type = view.getUint16(pos, true);
      const subType = view.getInt16(pos + 2, true);
      const scale = view.getInt16(pos + 4, true);
      const length = view.getUint32(pos + 6, true);
      const nullable = buffer[pos + 10] !== 0;
      pos += 11;
      fields[i] = {
        name,
        type,
        typeName: firebirdTypeName(type, scale),
        subType,
        scale,
        length,
        nullable,
      };
    }
  }

  const colCount = fields.length;
  const rowCount = view.getUint32(pos, true);
  pos += 4;

  const maskByteLen = (colCount + 7) >> 3;
  const encodedRows: unknown[][] = new Array(rowCount);

  for (let r = 0; r < rowCount; r++) {
    const maskStart = pos;
    pos += maskByteLen;
    const row: unknown[] = new Array(colCount);

    for (let c = 0; c < colCount; c++) {
      const isNull =
        (buffer[maskStart + (c >> 3)]! & (1 << (c & 7))) !== 0;
      if (isNull) {
        row[c] = null;
        continue;
      }

      const tag = buffer[pos++]!;
      switch (tag) {
        case BINARY_CELL_BOOL:
          row[c] = buffer[pos++] !== 0;
          break;
        case BINARY_CELL_INT32:
          row[c] = view.getInt32(pos, true);
          pos += 4;
          break;
        case BINARY_CELL_FLOAT64:
          row[c] = view.getFloat64(pos, true);
          pos += 8;
          break;
        case BINARY_CELL_UTF8: {
          const byteLen = view.getUint32(pos, true);
          pos += 4;
          row[c] =
            byteLen === 0
              ? ''
              : decodeUtf8(buffer, pos, pos + byteLen);
          pos += byteLen;
          break;
        }
        case BINARY_CELL_BYTES: {
          const byteLen = view.getUint32(pos, true);
          pos += 4;
          const slice = buffer.subarray(pos, pos + byteLen);
          pos += byteLen;
          row[c] = binaryBlobs ? slice.slice() : bytesToBase64(slice);
          break;
        }
        default:
          throw new Error(
            `decodeBinaryResultSet: unknown cell tag ${tag} at offset ${pos - 1}`,
          );
      }
    }

    encodedRows[r] = row;
  }

  if (rowMode === 'array') {
    return { rows: encodedRows as T[], fields };
  }

  const names = fields.map((f) => f.name);
  const build = getRowBuilder(names);
  const rows = (
    build
      ? encodedRows.map(build)
      : encodedRows.map((cols) =>
          Object.fromEntries(names.map((name, i) => [name, cols[i]])),
        )
  ) as T[];

  return { rows, fields };
}

/**
 * Options for {@link encodeBinaryResultSet}.
 */
export interface EncodeBinaryResultOptions {
  /**
   * Optional cached shape ID. When positive, the header writes `shapeId`
   * instead of inline column descriptors.
   */
  shapeId?: number;
  /**
   * Row mode of `result.rows` (`'object'` by default, or `'array'` when each
   * row in `result.rows` is already a positional array).
   */
  rowMode?: RowMode;
}

/**
 * Envelope transferred across `WorkerTransport` (`postMessage` with transferable
 * `ArrayBuffer`) and `SharedEngineTransport` (`BroadcastChannel`) for `query`
 * and `cursorFetch` responses.
 */
export interface BinaryResultPayload {
  /**
   * Raw `"FBR\x01"` binary result buffer backed by a standalone, transferable
   * `ArrayBuffer`.
   */
  binaryResult: Uint8Array;
  /**
   * When `binaryResult` references a cached statement shape ID
   * (`BINARY_HEADER_HAS_SHAPE_ID`), `shapeId` identifies the shape and
   * `shapeFields` carries its column descriptors the first time a client sees
   * that shape ID.
   */
  shapeId?: number;
  shapeFields?: readonly FieldInfo[];
}

/** Type guard for {@link BinaryResultPayload}. */
export function isBinaryResultPayload(
  value: unknown,
): value is BinaryResultPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { binaryResult?: unknown }).binaryResult instanceof Uint8Array
  );
}

/**
 * Decode a {@link BinaryResultPayload} (or pass through a pre-decoded
 * {@link QueryResult}) into `rowMode`, updating `shapeCache` when new
 * `shapeFields` metadata accompanies a `shapeId`.
 */
export function decodeBinaryResultPayload<T = Row>(
  payload: BinaryResultPayload | QueryResult<T>,
  rowMode: RowMode = 'object',
  binaryBlobs = false,
  shapeCache?: Map<number, readonly FieldInfo[]>,
): QueryResult<T> {
  if (!isBinaryResultPayload(payload)) {
    return payload;
  }
  if (
    typeof payload.shapeId === 'number' &&
    payload.shapeFields &&
    shapeCache
  ) {
    if (shapeCache.size >= 256) shapeCache.clear();
    shapeCache.set(payload.shapeId, payload.shapeFields);
  }
  const resolveShape = (id: number): readonly FieldInfo[] => {
    if (payload.shapeId === id && payload.shapeFields) {
      return payload.shapeFields;
    }
    const cached = shapeCache?.get(id);
    if (cached) return cached;
    throw new Error(
      `decodeBinaryResultPayload: unknown shape ID ${id}`,
    );
  };
  return decodeBinaryResultSet<T>(
    payload.binaryResult,
    rowMode,
    binaryBlobs,
    resolveShape,
  );
}

/**
 * Encode a {@link QueryResult} into the binary wire format understood by
 * {@link decodeBinaryResultSet}. Useful for testing and Worker transfers.
 */
export function encodeBinaryResultSet<T = Row>(
  result: QueryResult<T>,
  options: EncodeBinaryResultOptions = {},
): Uint8Array {
  const { fields, rows } = result;
  const colCount = fields.length;
  const rowCount = rows.length;
  const shapeId = options.shapeId ?? 0;
  const rowMode = options.rowMode ?? 'object';

  const encodedNames: Uint8Array[] = [];
  let headerBytes = 5; // magic(4) + flags(1)
  if (shapeId > 0) {
    headerBytes += 4;
  } else {
    headerBytes += 2; // u16 colCount
    for (const f of fields) {
      const nameBytes = sharedEncoder.encode(f.name);
      encodedNames.push(nameBytes);
      headerBytes += 2 + nameBytes.byteLength + 11;
    }
  }
  headerBytes += 4; // u32 rowCount

  const chunks: number[] = [];
  const pushU8 = (v: number): void => {
    chunks.push(v & 0xff);
  };
  const pushU16 = (v: number): void => {
    chunks.push(v & 0xff, (v >>> 8) & 0xff);
  };
  const pushI16 = (v: number): void => {
    const u = v & 0xffff;
    chunks.push(u & 0xff, (u >>> 8) & 0xff);
  };
  const pushU32 = (v: number): void => {
    chunks.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
  };
  const scratchBuf = new ArrayBuffer(8);
  const scratchView = new DataView(scratchBuf);
  const scratchU8 = new Uint8Array(scratchBuf);

  const pushI32 = (v: number): void => {
    scratchView.setInt32(0, v, true);
    chunks.push(
      scratchU8[0]!,
      scratchU8[1]!,
      scratchU8[2]!,
      scratchU8[3]!,
    );
  };
  const pushF64 = (v: number): void => {
    scratchView.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) chunks.push(scratchU8[i]!);
  };
  const pushBytes = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.byteLength; i++) {
      chunks.push(bytes[i]!);
    }
  };

  // Header
  pushU8(BINARY_RESULT_MAGIC_0);
  pushU8(BINARY_RESULT_MAGIC_1);
  pushU8(BINARY_RESULT_MAGIC_2);
  pushU8(BINARY_RESULT_VERSION);

  if (shapeId > 0) {
    pushU8(BINARY_HEADER_HAS_SHAPE_ID);
    pushU32(shapeId);
  } else {
    pushU8(0);
    pushU16(colCount);
    for (let i = 0; i < colCount; i++) {
      const f = fields[i]!;
      const nameBytes = encodedNames[i]!;
      pushU16(nameBytes.byteLength);
      pushBytes(nameBytes);
      pushU16(f.type ?? 0);
      pushI16(f.subType ?? 0);
      pushI16(f.scale ?? 0);
      pushU32(f.length ?? 0);
      pushU8(f.nullable ? 1 : 0);
    }
  }

  pushU32(rowCount);

  const maskByteLen = (colCount + 7) >> 3;
  for (let r = 0; r < rowCount; r++) {
    const rawRow = rows[r] as unknown;
    const maskOffset = chunks.length;
    for (let m = 0; m < maskByteLen; m++) chunks.push(0);

    for (let c = 0; c < colCount; c++) {
      const cell =
        rowMode === 'array'
          ? (rawRow as unknown[])[c]
          : (rawRow as Record<string, unknown>)[fields[c]!.name];

      if (cell === null || cell === undefined) {
        chunks[maskOffset + (c >> 3)]! |= 1 << (c & 7);
        continue;
      }

      if (typeof cell === 'boolean') {
        pushU8(BINARY_CELL_BOOL);
        pushU8(cell ? 1 : 0);
      } else if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) {
          chunks[maskOffset + (c >> 3)]! |= 1 << (c & 7);
        } else if (
          Number.isInteger(cell) &&
          cell >= -2147483648 &&
          cell <= 2147483647 &&
          !Object.is(cell, -0)
        ) {
          pushU8(BINARY_CELL_INT32);
          pushI32(cell);
        } else {
          pushU8(BINARY_CELL_FLOAT64);
          pushF64(cell);
        }
      } else if (cell instanceof Uint8Array) {
        pushU8(BINARY_CELL_BYTES);
        pushU32(cell.byteLength);
        pushBytes(cell);
      } else {
        const strBytes = sharedEncoder.encode(String(cell));
        pushU8(BINARY_CELL_UTF8);
        pushU32(strBytes.byteLength);
        pushBytes(strBytes);
      }
    }
  }

  void headerBytes;
  return new Uint8Array(chunks);
}
