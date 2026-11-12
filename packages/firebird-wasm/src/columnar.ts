/**
 * columnar.ts – Zero-copy columnar result vectors (`ColumnarQueryResult`) and
 * spec-compliant Apache Arrow IPC V5 stream serializer/deserializer (`M19 Item 2`).
 */

import type { FieldInfo, QueryResult, Row } from './types';
import {
  BINARY_CELL_BOOL,
  BINARY_CELL_BYTES,
  BINARY_CELL_FLOAT64,
  BINARY_CELL_INT32,
  BINARY_CELL_UTF8,
  BINARY_HEADER_HAS_SHAPE_ID,
  BINARY_RESULT_MAGIC_0,
  BINARY_RESULT_MAGIC_1,
  BINARY_RESULT_MAGIC_2,
  BINARY_RESULT_VERSION,
} from './browser/binary-result';
import { firebirdTypeName } from './browser/field-types';

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/**
 * Test whether `rowIndex` is valid (non-null) in an Arrow-convention validity
 * bitmap (`bit 1 = valid / non-null`, `bit 0 = null`).
 */
export function isColumnValueValid(validity: Uint8Array, rowIndex: number): boolean {
  if (validity.byteLength === 0) return true;
  return (validity[rowIndex >> 3]! & (1 << (rowIndex & 7))) !== 0;
}

function allocateAllValidBitmap(rowCount: number): Uint8Array {
  const byteLen = (rowCount + 7) >> 3;
  const buf = new Uint8Array(byteLen);
  if (byteLen > 0) {
    buf.fill(0xff);
    const trailingBits = rowCount & 7;
    if (trailingBits !== 0) {
      buf[byteLen - 1] = (1 << trailingBits) - 1;
    }
  }
  return buf;
}

function clearValidityBit(validity: Uint8Array, rowIndex: number): void {
  validity[rowIndex >> 3]! &= ~(1 << (rowIndex & 7));
}

export interface ColumnVectorBase<K extends string, T> {
  readonly kind: K;
  readonly length: number;
  /** Arrow-convention validity bitmap (`bit 1 = non-null`, `bit 0 = null`). */
  readonly validity: Uint8Array;
  readonly nullCount: number;
  isNull(rowIndex: number): boolean;
  get(rowIndex: number): T | null;
}

export interface Int32ColumnVector extends ColumnVectorBase<'int32', number> {
  readonly data: Int32Array;
}

export interface Float64ColumnVector extends ColumnVectorBase<'float64', number> {
  readonly data: Float64Array;
}

export interface BigInt64ColumnVector extends ColumnVectorBase<'bigint64', bigint> {
  readonly data: BigInt64Array;
}

export interface BoolColumnVector extends ColumnVectorBase<'bool', boolean> {
  /** Bit-packed boolean values (`bit (i & 7)` of `data[i >> 3]`). */
  readonly data: Uint8Array;
}

export interface Utf8ColumnVector extends ColumnVectorBase<'utf8', string> {
  /** Arrow-layout offsets of length `length + 1` into `data`. */
  readonly offsets: Int32Array;
  /** Contiguous UTF-8 encoded string bytes. */
  readonly data: Uint8Array;
}

export interface BytesColumnVector extends ColumnVectorBase<'bytes', Uint8Array> {
  /** Arrow-layout offsets of length `length + 1` into `data`. */
  readonly offsets: Int32Array;
  /** Contiguous raw binary bytes. */
  readonly data: Uint8Array;
}

export type ColumnVector =
  | Int32ColumnVector
  | Float64ColumnVector
  | BigInt64ColumnVector
  | BoolColumnVector
  | Utf8ColumnVector
  | BytesColumnVector;

/** Options accepted by {@link encodeArrowIpc} and `db.queryArrow()` (`M19 Item 2`). */
export interface ArrowIpcOptions {
  /** Optional custom schema metadata entries. */
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Typed columnar query result avoiding per-row JS object allocation (`M19 Item 2`).
 */
export interface ColumnarQueryResult {
  readonly rowCount: number;
  readonly fields: FieldInfo[];
  readonly vectors: readonly ColumnVector[];
  readonly columns: Readonly<Record<string, ColumnVector>>;
  /** Custom key-value metadata attached to the Arrow IPC schema (`{}` when none). */
  readonly metadata: Readonly<Record<string, string>>;
  getColumn(nameOrIndex: string | number): ColumnVector | undefined;
  getValue(rowIndex: number, columnNameOrIndex: string | number): unknown;
  toRows<T = Row>(): T[];
  toArrowIpc(options?: ArrowIpcOptions): Uint8Array;
}

function makeInt32Vector(
  data: Int32Array,
  validity: Uint8Array,
  nullCount: number,
): Int32ColumnVector {
  const length = data.length;
  return {
    kind: 'int32',
    length,
    data,
    validity,
    nullCount,
    isNull(i) {
      return nullCount > 0 && !isColumnValueValid(validity, i);
    },
    get(i) {
      if (i < 0 || i >= length) return null;
      if (nullCount > 0 && !isColumnValueValid(validity, i)) return null;
      return data[i]!;
    },
  };
}

function makeFloat64Vector(
  data: Float64Array,
  validity: Uint8Array,
  nullCount: number,
): Float64ColumnVector {
  const length = data.length;
  return {
    kind: 'float64',
    length,
    data,
    validity,
    nullCount,
    isNull(i) {
      return nullCount > 0 && !isColumnValueValid(validity, i);
    },
    get(i) {
      if (i < 0 || i >= length) return null;
      if (nullCount > 0 && !isColumnValueValid(validity, i)) return null;
      return data[i]!;
    },
  };
}

function makeBigInt64Vector(
  data: BigInt64Array,
  validity: Uint8Array,
  nullCount: number,
): BigInt64ColumnVector {
  const length = data.length;
  return {
    kind: 'bigint64',
    length,
    data,
    validity,
    nullCount,
    isNull(i) {
      return nullCount > 0 && !isColumnValueValid(validity, i);
    },
    get(i) {
      if (i < 0 || i >= length) return null;
      if (nullCount > 0 && !isColumnValueValid(validity, i)) return null;
      return data[i]!;
    },
  };
}

function makeBoolVector(
  length: number,
  data: Uint8Array,
  validity: Uint8Array,
  nullCount: number,
): BoolColumnVector {
  return {
    kind: 'bool',
    length,
    data,
    validity,
    nullCount,
    isNull(i) {
      return nullCount > 0 && !isColumnValueValid(validity, i);
    },
    get(i) {
      if (i < 0 || i >= length) return null;
      if (nullCount > 0 && !isColumnValueValid(validity, i)) return null;
      return (data[i >> 3]! & (1 << (i & 7))) !== 0;
    },
  };
}

function makeUtf8Vector(
  length: number,
  offsets: Int32Array,
  data: Uint8Array,
  validity: Uint8Array,
  nullCount: number,
): Utf8ColumnVector {
  return {
    kind: 'utf8',
    length,
    offsets,
    data,
    validity,
    nullCount,
    isNull(i) {
      return nullCount > 0 && !isColumnValueValid(validity, i);
    },
    get(i) {
      if (i < 0 || i >= length) return null;
      if (nullCount > 0 && !isColumnValueValid(validity, i)) return null;
      const start = offsets[i]!;
      const end = offsets[i + 1]!;
      if (start >= end) return '';
      return utf8Decoder.decode(data.subarray(start, end));
    },
  };
}

function makeBytesVector(
  length: number,
  offsets: Int32Array,
  data: Uint8Array,
  validity: Uint8Array,
  nullCount: number,
): BytesColumnVector {
  return {
    kind: 'bytes',
    length,
    offsets,
    data,
    validity,
    nullCount,
    isNull(i) {
      return nullCount > 0 && !isColumnValueValid(validity, i);
    },
    get(i) {
      if (i < 0 || i >= length) return null;
      if (nullCount > 0 && !isColumnValueValid(validity, i)) return null;
      const start = offsets[i]!;
      const end = offsets[i + 1]!;
      return data.slice(start, end);
    },
  };
}

export function buildColumnarResult(
  rowCount: number,
  fields: FieldInfo[],
  vectors: readonly ColumnVector[],
  metadata: Readonly<Record<string, string>> = {},
): ColumnarQueryResult {
  const columns: Record<string, ColumnVector> = {};
  for (let i = 0; i < fields.length; i++) {
    columns[fields[i]!.name] = vectors[i]!;
  }

  return {
    rowCount,
    fields,
    vectors,
    columns,
    metadata,
    getColumn(nameOrIndex) {
      if (typeof nameOrIndex === 'number') {
        return vectors[nameOrIndex];
      }
      return columns[nameOrIndex] ?? columns[nameOrIndex.toUpperCase()];
    },
    getValue(rowIndex, columnNameOrIndex) {
      const vec = this.getColumn(columnNameOrIndex);
      return vec ? vec.get(rowIndex) : undefined;
    },
    toRows<T = Row>(): T[] {
      const rows = new Array<T>(rowCount);
      const colCount = fields.length;
      for (let r = 0; r < rowCount; r++) {
        const obj: Row = {};
        for (let c = 0; c < colCount; c++) {
          obj[fields[c]!.name] = vectors[c]!.get(r);
        }
        rows[r] = obj as T;
      }
      return rows;
    },
    toArrowIpc(options?: ArrowIpcOptions): Uint8Array {
      return encodeArrowIpc(this, options);
    },
  };
}

function inferVectorKindForField(field: FieldInfo): ColumnVector['kind'] {
  const scale = field.scale ?? 0;
  if (scale !== 0) return 'utf8';
  switch (field.typeName) {
    case 'SMALLINT':
    case 'INTEGER':
      return 'int32';
    case 'BIGINT':
      return 'bigint64';
    case 'FLOAT':
    case 'DOUBLE':
      return 'float64';
    case 'BOOLEAN':
      return 'bool';
    case 'BLOB':
      return field.subType === 1 ? 'utf8' : 'bytes';
    default:
      return 'utf8';
  }
}

function decodeUtf8Slice(buffer: Uint8Array, start: number, end: number): string {
  if (start >= end) return '';
  const slice =
    typeof SharedArrayBuffer !== 'undefined' &&
    buffer.buffer instanceof SharedArrayBuffer
      ? buffer.slice(start, end)
      : buffer.subarray(start, end);
  return utf8Decoder.decode(slice);
}

/**
 * Decode a packed `FBR\x01` binary result buffer directly into typed columnar
 * vectors (`Int32Array`, `Float64Array`, `BigInt64Array`, UTF-8 offset buffers)
 * without allocating per-row JS objects (`M19 Item 2`).
 */
export function decodeBinaryResultColumnar(
  buffer: Uint8Array,
  shapes?: (id: number) => readonly FieldInfo[],
): ColumnarQueryResult {
  if (
    buffer.byteLength < 9 ||
    buffer[0] !== BINARY_RESULT_MAGIC_0 ||
    buffer[1] !== BINARY_RESULT_MAGIC_1 ||
    buffer[2] !== BINARY_RESULT_MAGIC_2 ||
    buffer[3] !== BINARY_RESULT_VERSION
  ) {
    throw new Error('decodeBinaryResultColumnar: invalid binary result header');
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const headerFlags = buffer[4]!;
  let pos = 5;

  let fields: FieldInfo[];
  if ((headerFlags & BINARY_HEADER_HAS_SHAPE_ID) !== 0) {
    if (!shapes) {
      throw new Error(
        'decodeBinaryResultColumnar: buffer references a shape ID but no shapes resolver was provided',
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
      const name = nameLen === 0 ? '' : decodeUtf8Slice(buffer, pos, pos + nameLen);
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
  const bodyStart = pos;
  const maskByteLen = (colCount + 7) >> 3;

  // Pass 1: inspect cell tags & exact byte lengths for variable-width columns
  const kinds: Array<ColumnVector['kind']> = fields.map(inferVectorKindForField);
  const varByteTotals = new Uint32Array(colCount);

  for (let r = 0; r < rowCount; r++) {
    const maskStart = pos;
    pos += maskByteLen;
    for (let c = 0; c < colCount; c++) {
      const isNull = (buffer[maskStart + (c >> 3)]! & (1 << (c & 7))) !== 0;
      if (isNull) continue;
      const tag = buffer[pos++]!;
      switch (tag) {
        case BINARY_CELL_BOOL:
          pos += 1;
          break;
        case BINARY_CELL_INT32:
          pos += 4;
          break;
        case BINARY_CELL_FLOAT64:
          if (kinds[c] === 'int32') kinds[c] = 'float64';
          pos += 8;
          break;
        case BINARY_CELL_UTF8: {
          const byteLen = view.getUint32(pos, true);
          pos += 4 + byteLen;
          if (kinds[c] !== 'bigint64') {
            kinds[c] = 'utf8';
            varByteTotals[c] += byteLen;
          }
          break;
        }
        case BINARY_CELL_BYTES: {
          const byteLen = view.getUint32(pos, true);
          pos += 4 + byteLen;
          kinds[c] = 'bytes';
          varByteTotals[c] += byteLen;
          break;
        }
        default:
          throw new Error(`decodeBinaryResultColumnar: unknown cell tag ${tag}`);
      }
    }
  }

  // Allocate exact typed arrays once per column
  const validities = Array.from({ length: colCount }, () => allocateAllValidBitmap(rowCount));
  const nullCounts = new Uint32Array(colCount);
  const i32Cols = new Array<Int32Array | null>(colCount).fill(null);
  const f64Cols = new Array<Float64Array | null>(colCount).fill(null);
  const i64Cols = new Array<BigInt64Array | null>(colCount).fill(null);
  const boolCols = new Array<Uint8Array | null>(colCount).fill(null);
  const varOffsets = new Array<Int32Array | null>(colCount).fill(null);
  const varData = new Array<Uint8Array | null>(colCount).fill(null);
  const varWritePos = new Uint32Array(colCount);

  for (let c = 0; c < colCount; c++) {
    switch (kinds[c]) {
      case 'int32':
        i32Cols[c] = new Int32Array(rowCount);
        break;
      case 'float64':
        f64Cols[c] = new Float64Array(rowCount);
        break;
      case 'bigint64':
        i64Cols[c] = new BigInt64Array(rowCount);
        break;
      case 'bool':
        boolCols[c] = new Uint8Array((rowCount + 7) >> 3);
        break;
      case 'utf8':
      case 'bytes':
        varOffsets[c] = new Int32Array(rowCount + 1);
        varData[c] = new Uint8Array(varByteTotals[c]!);
        break;
    }
  }

  // Pass 2: populate columnar buffers directly from `buffer`
  pos = bodyStart;
  for (let r = 0; r < rowCount; r++) {
    const maskStart = pos;
    pos += maskByteLen;
    for (let c = 0; c < colCount; c++) {
      const kind = kinds[c]!;
      const isNull = (buffer[maskStart + (c >> 3)]! & (1 << (c & 7))) !== 0;
      if (isNull) {
        clearValidityBit(validities[c]!, r);
        nullCounts[c]++;
        if (kind === 'utf8' || kind === 'bytes') {
          varOffsets[c]![r + 1] = varWritePos[c]!;
        }
        continue;
      }

      const tag = buffer[pos++]!;
      switch (tag) {
        case BINARY_CELL_BOOL: {
          const b = buffer[pos++] !== 0;
          if (b && boolCols[c]) {
            boolCols[c]![r >> 3]! |= 1 << (r & 7);
          }
          break;
        }
        case BINARY_CELL_INT32: {
          const v = view.getInt32(pos, true);
          pos += 4;
          if (kind === 'int32') i32Cols[c]![r] = v;
          else if (kind === 'float64') f64Cols[c]![r] = v;
          else if (kind === 'bigint64') i64Cols[c]![r] = BigInt(v);
          break;
        }
        case BINARY_CELL_FLOAT64: {
          const v = view.getFloat64(pos, true);
          pos += 8;
          if (kind === 'float64') f64Cols[c]![r] = v;
          else if (kind === 'bigint64') i64Cols[c]![r] = BigInt(Math.trunc(v));
          break;
        }
        case BINARY_CELL_UTF8: {
          const byteLen = view.getUint32(pos, true);
          pos += 4;
          if (kind === 'bigint64') {
            const text = decodeUtf8Slice(buffer, pos, pos + byteLen);
            i64Cols[c]![r] = BigInt(text || '0');
          } else {
            const dst = varData[c]!;
            const w = varWritePos[c]!;
            if (byteLen > 0) {
              dst.set(buffer.subarray(pos, pos + byteLen), w);
            }
            varWritePos[c] = w + byteLen;
            varOffsets[c]![r + 1] = w + byteLen;
          }
          pos += byteLen;
          break;
        }
        case BINARY_CELL_BYTES: {
          const byteLen = view.getUint32(pos, true);
          pos += 4;
          const dst = varData[c]!;
          const w = varWritePos[c]!;
          if (byteLen > 0) {
            dst.set(buffer.subarray(pos, pos + byteLen), w);
          }
          varWritePos[c] = w + byteLen;
          varOffsets[c]![r + 1] = w + byteLen;
          pos += byteLen;
          break;
        }
      }
    }
  }

  const vectors: ColumnVector[] = new Array(colCount);
  for (let c = 0; c < colCount; c++) {
    const nc = nullCounts[c]!;
    const val = validities[c]!;
    switch (kinds[c]) {
      case 'int32':
        vectors[c] = makeInt32Vector(i32Cols[c]!, val, nc);
        break;
      case 'float64':
        vectors[c] = makeFloat64Vector(f64Cols[c]!, val, nc);
        break;
      case 'bigint64':
        vectors[c] = makeBigInt64Vector(i64Cols[c]!, val, nc);
        break;
      case 'bool':
        vectors[c] = makeBoolVector(rowCount, boolCols[c]!, val, nc);
        break;
      case 'utf8':
        vectors[c] = makeUtf8Vector(rowCount, varOffsets[c]!, varData[c]!, val, nc);
        break;
      case 'bytes':
        vectors[c] = makeBytesVector(rowCount, varOffsets[c]!, varData[c]!, val, nc);
        break;
    }
  }

  return buildColumnarResult(rowCount, fields, vectors);
}

/**
 * Convert a row-oriented {@link QueryResult} (either `'object'` or `'array'`
 * mode) into a typed {@link ColumnarQueryResult} (`M19 Item 2`).
 */
export function rowsToColumnarResult(result: QueryResult<unknown>): ColumnarQueryResult {
  const fields = result.fields;
  const rows = result.rows;
  const rowCount = rows.length;
  const colCount = fields.length;
  const isArrayMode = rowCount > 0 && Array.isArray(rows[0]);

  const vectors: ColumnVector[] = new Array(colCount);

  for (let c = 0; c < colCount; c++) {
    const field = fields[c]!;
    const colName = field.name;
    let kind = inferVectorKindForField(field);

    // Inspect first non-null sample value when type metadata is absent (e.g. mocks)
    if (!field.typeName && rowCount > 0) {
      for (let r = 0; r < rowCount; r++) {
        const raw = isArrayMode
          ? (rows[r] as unknown[])[c]
          : (rows[r] as Row)[colName];
        if (raw === null || raw === undefined) continue;
        if (typeof raw === 'boolean') kind = 'bool';
        else if (typeof raw === 'bigint') kind = 'bigint64';
        else if (raw instanceof Uint8Array) kind = 'bytes';
        else if (typeof raw === 'number') {
          kind = Number.isInteger(raw) && raw >= -2147483648 && raw <= 2147483647 ? 'int32' : 'float64';
        } else {
          kind = 'utf8';
        }
        break;
      }
      // Upgrade int32 -> float64 if any row holds a non-int32 number
      if (kind === 'int32') {
        for (let r = 0; r < rowCount; r++) {
          const raw = isArrayMode
            ? (rows[r] as unknown[])[c]
            : (rows[r] as Row)[colName];
          if (typeof raw === 'number' && (!Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647)) {
            kind = 'float64';
            break;
          }
        }
      }
    }

    const validity = allocateAllValidBitmap(rowCount);
    let nullCount = 0;

    if (kind === 'int32') {
      const data = new Int32Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const v = isArrayMode ? (rows[r] as unknown[])[c] : (rows[r] as Row)[colName];
        if (v === null || v === undefined) {
          clearValidityBit(validity, r);
          nullCount++;
        } else {
          data[r] = Number(v);
        }
      }
      vectors[c] = makeInt32Vector(data, validity, nullCount);
    } else if (kind === 'float64') {
      const data = new Float64Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const v = isArrayMode ? (rows[r] as unknown[])[c] : (rows[r] as Row)[colName];
        if (v === null || v === undefined) {
          clearValidityBit(validity, r);
          nullCount++;
        } else {
          data[r] = Number(v);
        }
      }
      vectors[c] = makeFloat64Vector(data, validity, nullCount);
    } else if (kind === 'bigint64') {
      const data = new BigInt64Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const v = isArrayMode ? (rows[r] as unknown[])[c] : (rows[r] as Row)[colName];
        if (v === null || v === undefined) {
          clearValidityBit(validity, r);
          nullCount++;
        } else {
          data[r] = typeof v === 'bigint' ? v : BigInt(String(v));
        }
      }
      vectors[c] = makeBigInt64Vector(data, validity, nullCount);
    } else if (kind === 'bool') {
      const data = new Uint8Array((rowCount + 7) >> 3);
      for (let r = 0; r < rowCount; r++) {
        const v = isArrayMode ? (rows[r] as unknown[])[c] : (rows[r] as Row)[colName];
        if (v === null || v === undefined) {
          clearValidityBit(validity, r);
          nullCount++;
        } else if (v) {
          data[r >> 3]! |= 1 << (r & 7);
        }
      }
      vectors[c] = makeBoolVector(rowCount, data, validity, nullCount);
    } else if (kind === 'bytes') {
      const chunks = new Array<Uint8Array | null>(rowCount);
      let total = 0;
      for (let r = 0; r < rowCount; r++) {
        const v = isArrayMode ? (rows[r] as unknown[])[c] : (rows[r] as Row)[colName];
        if (v === null || v === undefined) {
          clearValidityBit(validity, r);
          nullCount++;
          chunks[r] = null;
        } else {
          const bytes =
            v instanceof Uint8Array
              ? v
              : typeof v === 'string'
                ? utf8Encoder.encode(v)
                : new Uint8Array(0);
          chunks[r] = bytes;
          total += bytes.byteLength;
        }
      }
      const offsets = new Int32Array(rowCount + 1);
      const data = new Uint8Array(total);
      let w = 0;
      for (let r = 0; r < rowCount; r++) {
        const ch = chunks[r];
        if (ch && ch.byteLength > 0) {
          data.set(ch, w);
          w += ch.byteLength;
        }
        offsets[r + 1] = w;
      }
      vectors[c] = makeBytesVector(rowCount, offsets, data, validity, nullCount);
    } else {
      const chunks = new Array<Uint8Array | null>(rowCount);
      let total = 0;
      for (let r = 0; r < rowCount; r++) {
        const v = isArrayMode ? (rows[r] as unknown[])[c] : (rows[r] as Row)[colName];
        if (v === null || v === undefined) {
          clearValidityBit(validity, r);
          nullCount++;
          chunks[r] = null;
        } else {
          const str = v instanceof Date ? v.toISOString() : String(v);
          const bytes = str.length === 0 ? new Uint8Array(0) : utf8Encoder.encode(str);
          chunks[r] = bytes;
          total += bytes.byteLength;
        }
      }
      const offsets = new Int32Array(rowCount + 1);
      const data = new Uint8Array(total);
      let w = 0;
      for (let r = 0; r < rowCount; r++) {
        const ch = chunks[r];
        if (ch && ch.byteLength > 0) {
          data.set(ch, w);
          w += ch.byteLength;
        }
        offsets[r + 1] = w;
      }
      vectors[c] = makeUtf8Vector(rowCount, offsets, data, validity, nullCount);
    }
  }

  return buildColumnarResult(rowCount, fields, vectors);
}

// ===========================================================================
// Apache Arrow IPC V5 Stream Encoder & Decoder (Zero-Dependency FlatBuffers)
// ===========================================================================

const ARROW_IPC_CONTINUATION = 0xffffffff;
const ARROW_METADATA_VERSION_V5 = 4;

// Arrow MessageHeader union tags (`Message.fbs`)
const ARROW_HEADER_SCHEMA = 1;
const ARROW_HEADER_RECORD_BATCH = 3;

// Arrow Type union tags (`Schema.fbs`)
const ARROW_TYPE_INT = 2;
const ARROW_TYPE_FLOATING_POINT = 3;
const ARROW_TYPE_BINARY = 4;
const ARROW_TYPE_UTF8 = 5;
const ARROW_TYPE_BOOL = 6;

const ARROW_PRECISION_DOUBLE = 2;

function align8(n: number): number {
  return (n + 7) & ~7;
}

/**
 * Minimal bottom-up FlatBuffer builder tailored for Apache Arrow `Schema` and
 * `RecordBatch` `Message` headers.
 */
class MiniFlatBufferBuilder {
  private buf: Uint8Array;
  private view: DataView;
  private space: number;
  private vtables: Array<{ offset: number; bytes: Uint8Array }> = [];
  private fieldOffsets: Int32Array = new Int32Array(0);
  private objectStart = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
    this.space = initialCapacity;
  }

  offset(): number {
    return this.buf.byteLength - this.space;
  }

  private grow(minAdditional: number): void {
    const needed = this.buf.byteLength - this.space + minAdditional;
    if (needed <= this.buf.byteLength) return;
    let nextCap = this.buf.byteLength * 2;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    const used = this.buf.byteLength - this.space;
    next.set(this.buf.subarray(this.space), nextCap - used);
    this.space = nextCap - used;
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  prep(size: number, additionalBytes: number): void {
    const alignSize =
      (~(this.buf.byteLength - this.space + additionalBytes) + 1) & (size - 1);
    this.grow(alignSize + size + additionalBytes);
    this.space -= alignSize;
  }

  writeU8(v: number): void {
    this.space -= 1;
    this.buf[this.space] = v & 0xff;
  }

  writeI16(v: number): void {
    this.space -= 2;
    this.view.setInt16(this.space, v, true);
  }

  writeU16(v: number): void {
    this.space -= 2;
    this.view.setUint16(this.space, v, true);
  }

  writeI32(v: number): void {
    this.space -= 4;
    this.view.setInt32(this.space, v, true);
  }

  writeI64(v: bigint): void {
    this.space -= 8;
    this.view.setBigInt64(this.space, v, true);
  }

  addU8(v: number): void {
    this.prep(1, 0);
    this.writeU8(v);
  }

  addI16(v: number): void {
    this.prep(2, 0);
    this.writeI16(v);
  }

  addI32(v: number): void {
    this.prep(4, 0);
    this.writeI32(v);
  }

  addI64(v: bigint): void {
    this.prep(8, 0);
    this.writeI64(v);
  }

  addOffset(off: number): void {
    this.prep(4, 0);
    const rel = this.offset() - off + 4;
    this.writeI32(rel);
  }

  createString(str: string): number {
    const bytes = utf8Encoder.encode(str);
    this.addU8(0); // null terminator
    this.prep(4, bytes.byteLength);
    this.space -= bytes.byteLength;
    this.buf.set(bytes, this.space);
    this.writeI32(bytes.byteLength);
    return this.offset();
  }

  createOffsetVector(offsets: readonly number[]): number {
    this.prep(4, offsets.length * 4);
    for (let i = offsets.length - 1; i >= 0; i--) {
      this.addOffset(offsets[i]!);
    }
    this.writeI32(offsets.length);
    return this.offset();
  }

  startObject(numFields: number): void {
    this.fieldOffsets = new Int32Array(numFields);
    this.objectStart = this.offset();
  }

  addFieldU8(slot: number, v: number, defaultValue = 0): void {
    if (v === defaultValue) return;
    this.addU8(v);
    this.fieldOffsets[slot] = this.offset();
  }

  addFieldI16(slot: number, v: number, defaultValue = 0): void {
    if (v === defaultValue) return;
    this.addI16(v);
    this.fieldOffsets[slot] = this.offset();
  }

  addFieldI32(slot: number, v: number, defaultValue = 0): void {
    if (v === defaultValue) return;
    this.addI32(v);
    this.fieldOffsets[slot] = this.offset();
  }

  addFieldI64(slot: number, v: bigint, defaultValue = 0n): void {
    if (v === defaultValue) return;
    this.addI64(v);
    this.fieldOffsets[slot] = this.offset();
  }

  addFieldOffset(slot: number, off: number): void {
    if (off === 0) return;
    this.addOffset(off);
    this.fieldOffsets[slot] = this.offset();
  }

  endObject(): number {
    this.addI32(0); // placeholder for vtable soffset
    const tableOff = this.offset();
    const objectSize = tableOff - this.objectStart;
    const vtableByteLen = (this.fieldOffsets.length + 2) * 2;
    const vt = new Uint8Array(vtableByteLen);
    const vtView = new DataView(vt.buffer);
    vtView.setUint16(0, vtableByteLen, true);
    vtView.setUint16(2, objectSize, true);
    for (let i = 0; i < this.fieldOffsets.length; i++) {
      const fOff = this.fieldOffsets[i]!;
      vtView.setUint16(4 + i * 2, fOff !== 0 ? tableOff - fOff : 0, true);
    }

    let existingVtOff = 0;
    for (const prev of this.vtables) {
      if (prev.bytes.byteLength === vt.byteLength) {
        let same = true;
        for (let j = 0; j < vt.byteLength; j++) {
          if (prev.bytes[j] !== vt[j]) {
            same = false;
            break;
          }
        }
        if (same) {
          existingVtOff = prev.offset;
          break;
        }
      }
    }

    if (existingVtOff !== 0) {
      this.view.setInt32(this.buf.byteLength - tableOff, existingVtOff - tableOff, true);
    } else {
      for (let i = vt.byteLength - 2; i >= 0; i -= 2) {
        this.addI16(vtView.getInt16(i, true));
      }
      const newVtOff = this.offset();
      this.vtables.push({ offset: newVtOff, bytes: vt });
      this.view.setInt32(this.buf.byteLength - tableOff, newVtOff - tableOff, true);
    }
    return tableOff;
  }

  finish(rootTable: number): Uint8Array {
    this.prep(8, 4);
    this.addOffset(rootTable);
    return this.buf.slice(this.space);
  }
}

function buildArrowEmptyTypeTable(fb: MiniFlatBufferBuilder): number {
  fb.startObject(0);
  return fb.endObject();
}

function buildArrowSchemaMessage(
  columnar: ColumnarQueryResult,
  metadata?: Readonly<Record<string, string>>,
): Uint8Array {
  const fb = new MiniFlatBufferBuilder(1024);
  const fieldTableOffsets: number[] = [];

  for (let i = 0; i < columnar.fields.length; i++) {
    const field = columnar.fields[i]!;
    const vec = columnar.vectors[i]!;
    const nameOff = fb.createString(field.name);
    const emptyChildrenOff = fb.createOffsetVector([]);

    let typeEnum = ARROW_TYPE_UTF8;
    let typeTableOff = 0;
    switch (vec.kind) {
      case 'int32':
        typeEnum = ARROW_TYPE_INT;
        fb.startObject(2);
        fb.addFieldI32(0, 32, 0);
        fb.addFieldU8(1, 1, 0);
        typeTableOff = fb.endObject();
        break;
      case 'bigint64':
        typeEnum = ARROW_TYPE_INT;
        fb.startObject(2);
        fb.addFieldI32(0, 64, 0);
        fb.addFieldU8(1, 1, 0);
        typeTableOff = fb.endObject();
        break;
      case 'float64':
        typeEnum = ARROW_TYPE_FLOATING_POINT;
        fb.startObject(1);
        fb.addFieldI16(0, ARROW_PRECISION_DOUBLE, 0);
        typeTableOff = fb.endObject();
        break;
      case 'bool':
        typeEnum = ARROW_TYPE_BOOL;
        typeTableOff = buildArrowEmptyTypeTable(fb);
        break;
      case 'bytes':
        typeEnum = ARROW_TYPE_BINARY;
        typeTableOff = buildArrowEmptyTypeTable(fb);
        break;
      case 'utf8':
        typeEnum = ARROW_TYPE_UTF8;
        typeTableOff = buildArrowEmptyTypeTable(fb);
        break;
    }

    fb.startObject(7);
    fb.addFieldOffset(0, nameOff);
    fb.addFieldU8(1, field.nullable === false ? 0 : 1, 0);
    fb.addFieldU8(2, typeEnum, 0);
    fb.addFieldOffset(3, typeTableOff);
    fb.addFieldOffset(5, emptyChildrenOff);
    fieldTableOffsets.push(fb.endObject());
  }

  const fieldsVecOff = fb.createOffsetVector(fieldTableOffsets);
  const mergedMeta = { ...columnar.metadata, ...metadata };
  const metaEntries = Object.entries(mergedMeta);
  let customMetaVecOff = 0;
  if (metaEntries.length > 0) {
    const kvOffsets: number[] = [];
    for (const [k, v] of metaEntries) {
      const kOff = fb.createString(k);
      const vOff = fb.createString(String(v));
      fb.startObject(2);
      fb.addFieldOffset(0, kOff);
      fb.addFieldOffset(1, vOff);
      kvOffsets.push(fb.endObject());
    }
    customMetaVecOff = fb.createOffsetVector(kvOffsets);
  }

  fb.startObject(4);
  fb.addFieldI16(0, 0, 0); // Little endian
  fb.addFieldOffset(1, fieldsVecOff);
  if (customMetaVecOff !== 0) {
    fb.addFieldOffset(2, customMetaVecOff);
  }
  const schemaOff = fb.endObject();

  fb.startObject(4);
  fb.addFieldI16(0, ARROW_METADATA_VERSION_V5, 0);
  fb.addFieldU8(1, ARROW_HEADER_SCHEMA, 0);
  fb.addFieldOffset(2, schemaOff);
  fb.addFieldI64(3, 0n, 0n);
  const msgOff = fb.endObject();

  return fb.finish(msgOff);
}

function asBytes(typed: ArrayBufferView): Uint8Array {
  return new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
}

/**
 * Serialize a {@link ColumnarQueryResult} into a standard **Apache Arrow IPC V5
 * Stream** (`0xFFFFFFFF` continuation + FlatBuffers `Schema` + `RecordBatch` +
 * EOS marker) (`M19 Item 2`).
 */
export function encodeArrowIpc(
  columnar: ColumnarQueryResult,
  options?: ArrowIpcOptions,
): Uint8Array {
  const schemaMeta = buildArrowSchemaMessage(columnar, options?.metadata);
  const paddedSchemaMetaLen = align8(schemaMeta.byteLength);

  // Collect 8-byte aligned RecordBatch body buffers
  const bodyChunks: Uint8Array[] = [];
  const bufferDescriptors: Array<{ offset: bigint; length: bigint }> = [];
  const fieldNodes: Array<{ length: bigint; nullCount: bigint }> = [];
  let bodyOffset = 0;

  const pushBodyBuffer = (raw: Uint8Array): void => {
    const start = bodyOffset;
    const len = raw.byteLength;
    bufferDescriptors.push({ offset: BigInt(start), length: BigInt(len) });
    const padded = align8(len);
    bodyChunks.push(raw);
    if (padded > len) {
      bodyChunks.push(new Uint8Array(padded - len));
    }
    bodyOffset += padded;
  };

  for (const vec of columnar.vectors) {
    fieldNodes.push({
      length: BigInt(vec.length),
      nullCount: BigInt(vec.nullCount),
    });
    pushBodyBuffer(vec.nullCount === 0 ? new Uint8Array(0) : vec.validity);
    switch (vec.kind) {
      case 'int32':
      case 'float64':
      case 'bigint64':
      case 'bool':
        pushBodyBuffer(asBytes(vec.data));
        break;
      case 'utf8':
      case 'bytes':
        pushBodyBuffer(asBytes(vec.offsets));
        pushBodyBuffer(vec.data);
        break;
    }
  }

  // Build RecordBatch FlatBuffer Message
  const fb = new MiniFlatBufferBuilder(1024);

  // `buffers: [Buffer]` struct vector (16 bytes each: offset:i64, length:i64)
  fb.prep(8, bufferDescriptors.length * 16);
  for (let i = bufferDescriptors.length - 1; i >= 0; i--) {
    const b = bufferDescriptors[i]!;
    fb.writeI64(b.length);
    fb.writeI64(b.offset);
  }
  fb.prep(4, 0);
  fb.writeI32(bufferDescriptors.length);
  const buffersVecOff = fb.offset();

  // `nodes: [FieldNode]` struct vector (16 bytes each: length:i64, null_count:i64)
  fb.prep(8, fieldNodes.length * 16);
  for (let i = fieldNodes.length - 1; i >= 0; i--) {
    const n = fieldNodes[i]!;
    fb.writeI64(n.nullCount);
    fb.writeI64(n.length);
  }
  fb.prep(4, 0);
  fb.writeI32(fieldNodes.length);
  const nodesVecOff = fb.offset();

  fb.startObject(3);
  fb.addFieldI64(0, BigInt(columnar.rowCount), 0n);
  fb.addFieldOffset(1, nodesVecOff);
  fb.addFieldOffset(2, buffersVecOff);
  const rbOff = fb.endObject();

  fb.startObject(4);
  fb.addFieldI16(0, ARROW_METADATA_VERSION_V5, 0);
  fb.addFieldU8(1, ARROW_HEADER_RECORD_BATCH, 0);
  fb.addFieldOffset(2, rbOff);
  fb.addFieldI64(3, BigInt(bodyOffset), 0n);
  const rbMsgOff = fb.endObject();

  const rbMeta = fb.finish(rbMsgOff);
  const paddedRbMetaLen = align8(rbMeta.byteLength);

  // Total IPC stream size:
  // [cont(4) + schemaLen(4) + schemaMeta(padded)] + [cont(4) + rbLen(4) + rbMeta(padded) + body] + [EOS(8)]
  const totalBytes =
    8 + paddedSchemaMetaLen + 8 + paddedRbMetaLen + bodyOffset + 8;
  const out = new Uint8Array(totalBytes);
  const outView = new DataView(out.buffer);
  let p = 0;

  // 1. Schema frame
  outView.setUint32(p, ARROW_IPC_CONTINUATION, true);
  outView.setInt32(p + 4, paddedSchemaMetaLen, true);
  p += 8;
  out.set(schemaMeta, p);
  p += paddedSchemaMetaLen;

  // 2. RecordBatch frame
  outView.setUint32(p, ARROW_IPC_CONTINUATION, true);
  outView.setInt32(p + 4, paddedRbMetaLen, true);
  p += 8;
  out.set(rbMeta, p);
  p += paddedRbMetaLen;
  for (const chunk of bodyChunks) {
    if (chunk.byteLength > 0) {
      out.set(chunk, p);
      p += chunk.byteLength;
    }
  }

  // 3. EOS marker (0xFFFFFFFF, 0x00000000)
  outView.setUint32(p, ARROW_IPC_CONTINUATION, true);
  outView.setInt32(p + 4, 0, true);
  return out;
}

class MiniFlatBufferReader {
  private readonly view: DataView;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  rootTable(): number {
    return this.view.getInt32(0, true);
  }

  private fieldPos(tablePos: number, slot: number): number {
    const vtableSOffset = this.view.getInt32(tablePos, true);
    const vtablePos = tablePos - vtableSOffset;
    const vtableLen = this.view.getUint16(vtablePos, true);
    const entryOffset = 4 + slot * 2;
    if (entryOffset >= vtableLen) return 0;
    const rel = this.view.getUint16(vtablePos + entryOffset, true);
    return rel === 0 ? 0 : tablePos + rel;
  }

  readU8(tablePos: number, slot: number, def = 0): number {
    const fp = this.fieldPos(tablePos, slot);
    return fp === 0 ? def : this.buf[fp]!;
  }

  readI16(tablePos: number, slot: number, def = 0): number {
    const fp = this.fieldPos(tablePos, slot);
    return fp === 0 ? def : this.view.getInt16(fp, true);
  }

  readI32(tablePos: number, slot: number, def = 0): number {
    const fp = this.fieldPos(tablePos, slot);
    return fp === 0 ? def : this.view.getInt32(fp, true);
  }

  readI64(tablePos: number, slot: number, def = 0n): bigint {
    const fp = this.fieldPos(tablePos, slot);
    return fp === 0 ? def : this.view.getBigInt64(fp, true);
  }

  readTable(tablePos: number, slot: number): number {
    const fp = this.fieldPos(tablePos, slot);
    if (fp === 0) return 0;
    return fp + this.view.getInt32(fp, true);
  }

  readString(tablePos: number, slot: number): string {
    const fp = this.fieldPos(tablePos, slot);
    if (fp === 0) return '';
    const strPos = fp + this.view.getInt32(fp, true);
    const byteLen = this.view.getInt32(strPos, true);
    return utf8Decoder.decode(this.buf.subarray(strPos + 4, strPos + 4 + byteLen));
  }

  readTableVector(tablePos: number, slot: number): number[] {
    const fp = this.fieldPos(tablePos, slot);
    if (fp === 0) return [];
    const vecPos = fp + this.view.getInt32(fp, true);
    const len = this.view.getInt32(vecPos, true);
    const out = new Array<number>(len);
    for (let i = 0; i < len; i++) {
      const elemPos = vecPos + 4 + i * 4;
      out[i] = elemPos + this.view.getInt32(elemPos, true);
    }
    return out;
  }

  readStructVectorPos(tablePos: number, slot: number): { start: number; length: number } {
    const fp = this.fieldPos(tablePos, slot);
    if (fp === 0) return { start: 0, length: 0 };
    const vecPos = fp + this.view.getInt32(fp, true);
    const length = this.view.getInt32(vecPos, true);
    return { start: vecPos + 4, length };
  }

  i64At(pos: number): bigint {
    return this.view.getBigInt64(pos, true);
  }
}

/**
 * Decode an **Apache Arrow IPC Stream** (`Uint8Array`) back into a typed
 * {@link ColumnarQueryResult} (`M19 Item 2`).
 */
export function decodeArrowIpc(ipcBytes: Uint8Array): ColumnarQueryResult {
  const view = new DataView(ipcBytes.buffer, ipcBytes.byteOffset, ipcBytes.byteLength);
  let pos = 0;

  interface ParsedArrowCol {
    field: FieldInfo;
    kind: ColumnVector['kind'];
  }
  const cols: ParsedArrowCol[] = [];
  const schemaMetadata: Record<string, string> = {};
  let rowCount = 0;
  let vectors: ColumnVector[] = [];

  while (pos + 4 <= ipcBytes.byteLength) {
    let metaSize = view.getInt32(pos, true);
    pos += 4;
    if (metaSize === -1 || (metaSize >>> 0) === ARROW_IPC_CONTINUATION) {
      if (pos + 4 > ipcBytes.byteLength) break;
      metaSize = view.getInt32(pos, true);
      pos += 4;
    }
    if (metaSize === 0) {
      break; // EOS
    }
    if (metaSize < 0 || pos + metaSize > ipcBytes.byteLength) {
      throw new Error('decodeArrowIpc: truncated Arrow IPC metadata frame');
    }

    const metaSlice = ipcBytes.subarray(pos, pos + metaSize);
    pos += metaSize;

    const reader = new MiniFlatBufferReader(metaSlice);
    const msgRoot = reader.rootTable();
    const headerType = reader.readU8(msgRoot, 1, 0);
    const headerTable = reader.readTable(msgRoot, 2);
    const bodyLength = Number(reader.readI64(msgRoot, 3, 0n));

    if (headerType === ARROW_HEADER_SCHEMA && headerTable !== 0) {
      const metaTables = reader.readTableVector(headerTable, 2);
      for (const kv of metaTables) {
        const k = reader.readString(kv, 0);
        const v = reader.readString(kv, 1);
        schemaMetadata[k] = v;
      }
      const fieldTables = reader.readTableVector(headerTable, 1);
      for (const ft of fieldTables) {
        const name = reader.readString(ft, 0);
        const nullable = reader.readU8(ft, 1, 0) !== 0;
        const typeEnum = reader.readU8(ft, 2, ARROW_TYPE_UTF8);
        const typeTable = reader.readTable(ft, 3);

        let kind: ColumnVector['kind'] = 'utf8';
        let typeName: FieldInfo['typeName'] = 'VARYING';
        if (typeEnum === ARROW_TYPE_INT && typeTable !== 0) {
          const bitWidth = reader.readI32(typeTable, 0, 32);
          kind = bitWidth === 64 ? 'bigint64' : 'int32';
          typeName = bitWidth === 64 ? 'BIGINT' : 'INTEGER';
        } else if (typeEnum === ARROW_TYPE_FLOATING_POINT) {
          kind = 'float64';
          typeName = 'DOUBLE';
        } else if (typeEnum === ARROW_TYPE_BOOL) {
          kind = 'bool';
          typeName = 'BOOLEAN';
        } else if (typeEnum === ARROW_TYPE_BINARY) {
          kind = 'bytes';
          typeName = 'BLOB';
        }
        cols.push({
          field: { name, nullable, typeName },
          kind,
        });
      }
    } else if (headerType === ARROW_HEADER_RECORD_BATCH && headerTable !== 0) {
      if (pos + bodyLength > ipcBytes.byteLength) {
        throw new Error('decodeArrowIpc: truncated Arrow IPC RecordBatch body');
      }
      const body = ipcBytes.subarray(pos, pos + bodyLength);
      rowCount = Number(reader.readI64(headerTable, 0, 0n));
      const nodesVec = reader.readStructVectorPos(headerTable, 1);
      const bufsVec = reader.readStructVectorPos(headerTable, 2);

      const getBuf = (idx: number): Uint8Array => {
        if (idx >= bufsVec.length) return new Uint8Array(0);
        const off = Number(reader.i64At(bufsVec.start + idx * 16));
        const len = Number(reader.i64At(bufsVec.start + idx * 16 + 8));
        return len === 0 ? new Uint8Array(0) : body.slice(off, off + len);
      };

      let bufIdx = 0;
      vectors = new Array(cols.length);
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c]!;
        const len =
          c < nodesVec.length ? Number(reader.i64At(nodesVec.start + c * 16)) : rowCount;
        const nullCount =
          c < nodesVec.length ? Number(reader.i64At(nodesVec.start + c * 16 + 8)) : 0;

        const rawValidity = getBuf(bufIdx++);
        const validity =
          rawValidity.byteLength > 0 ? rawValidity : allocateAllValidBitmap(len);

        if (col.kind === 'int32') {
          const valBytes = getBuf(bufIdx++);
          const aligned = valBytes.slice();
          vectors[c] = makeInt32Vector(
            new Int32Array(aligned.buffer, aligned.byteOffset, len),
            validity,
            nullCount,
          );
        } else if (col.kind === 'float64') {
          const valBytes = getBuf(bufIdx++);
          const aligned = valBytes.slice();
          vectors[c] = makeFloat64Vector(
            new Float64Array(aligned.buffer, aligned.byteOffset, len),
            validity,
            nullCount,
          );
        } else if (col.kind === 'bigint64') {
          const valBytes = getBuf(bufIdx++);
          const aligned = valBytes.slice();
          vectors[c] = makeBigInt64Vector(
            new BigInt64Array(aligned.buffer, aligned.byteOffset, len),
            validity,
            nullCount,
          );
        } else if (col.kind === 'bool') {
          const valBytes = getBuf(bufIdx++);
          vectors[c] = makeBoolVector(len, valBytes, validity, nullCount);
        } else if (col.kind === 'utf8') {
          const offBytes = getBuf(bufIdx++).slice();
          const dataBytes = getBuf(bufIdx++);
          const offsets =
            offBytes.byteLength > 0
              ? new Int32Array(offBytes.buffer, offBytes.byteOffset, len + 1)
              : new Int32Array(len + 1);
          vectors[c] = makeUtf8Vector(len, offsets, dataBytes, validity, nullCount);
        } else {
          const offBytes = getBuf(bufIdx++).slice();
          const dataBytes = getBuf(bufIdx++);
          const offsets =
            offBytes.byteLength > 0
              ? new Int32Array(offBytes.buffer, offBytes.byteOffset, len + 1)
              : new Int32Array(len + 1);
          vectors[c] = makeBytesVector(len, offsets, dataBytes, validity, nullCount);
        }
      }
    }

    pos += bodyLength;
  }

  return buildColumnarResult(
    rowCount,
    cols.map((c) => c.field),
    vectors,
    schemaMetadata,
  );
}
