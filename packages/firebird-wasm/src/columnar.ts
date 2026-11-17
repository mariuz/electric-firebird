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
import { encodeArrowIpc } from './arrow-ipc-codec';

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

export function allocateAllValidBitmap(rowCount: number): Uint8Array {
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

export function makeInt32Vector(
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

export function makeFloat64Vector(
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

export function makeBigInt64Vector(
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

export function makeBoolVector(
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

export function makeUtf8Vector(
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

export function makeBytesVector(
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

export function inferVectorKindForField(field: FieldInfo): ColumnVector['kind'] {
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


/**
 * Concatenate multiple {@link ColumnarQueryResult} batches with identical schemas
 * into a single contiguous {@link ColumnarQueryResult} (`M21 Item 2`).
 */
export function concatColumnarResults(
  batches: readonly ColumnarQueryResult[],
  metadataOverride?: Readonly<Record<string, string>>,
): ColumnarQueryResult {
  if (batches.length === 0) {
    return buildColumnarResult(0, [], [], metadataOverride);
  }
  if (batches.length === 1 && !metadataOverride) {
    return batches[0]!;
  }
  const first = batches[0]!;
  const fields = first.fields;
  const totalRows = batches.reduce((acc, b) => acc + b.rowCount, 0);
  const colCount = fields.length;
  const mergedVectors: ColumnVector[] = new Array(colCount);

  for (let c = 0; c < colCount; c++) {
    const kind = first.vectors[c]!.kind;
    const validity = allocateAllValidBitmap(totalRows);
    let nullCount = 0;

    let rowCursor = 0;
    for (const b of batches) {
      const vec = b.vectors[c]!;
      if (vec.nullCount > 0) {
        for (let r = 0; r < vec.length; r++) {
          if (vec.isNull(r)) {
            clearValidityBit(validity, rowCursor + r);
            nullCount++;
          }
        }
      }
      rowCursor += vec.length;
    }

    if (kind === 'int32') {
      const data = new Int32Array(totalRows);
      let off = 0;
      for (const b of batches) {
        const v = b.vectors[c] as Int32ColumnVector;
        data.set(v.data, off);
        off += v.length;
      }
      mergedVectors[c] = makeInt32Vector(data, validity, nullCount);
    } else if (kind === 'float64') {
      const data = new Float64Array(totalRows);
      let off = 0;
      for (const b of batches) {
        const v = b.vectors[c] as Float64ColumnVector;
        data.set(v.data, off);
        off += v.length;
      }
      mergedVectors[c] = makeFloat64Vector(data, validity, nullCount);
    } else if (kind === 'bigint64') {
      const data = new BigInt64Array(totalRows);
      let off = 0;
      for (const b of batches) {
        const v = b.vectors[c] as BigInt64ColumnVector;
        data.set(v.data, off);
        off += v.length;
      }
      mergedVectors[c] = makeBigInt64Vector(data, validity, nullCount);
    } else if (kind === 'bool') {
      const data = new Uint8Array((totalRows + 7) >> 3);
      let off = 0;
      for (const b of batches) {
        const v = b.vectors[c] as BoolColumnVector;
        for (let r = 0; r < v.length; r++) {
          if (v.get(r) === true) {
            const idx = off + r;
            data[idx >> 3]! |= 1 << (idx & 7);
          }
        }
        off += v.length;
      }
      mergedVectors[c] = makeBoolVector(totalRows, data, validity, nullCount);
    } else {
      let totalByteLen = 0;
      for (const b of batches) {
        const v = b.vectors[c] as Utf8ColumnVector | BytesColumnVector;
        totalByteLen += v.data.byteLength;
      }
      const offsets = new Int32Array(totalRows + 1);
      const data = new Uint8Array(totalByteLen);
      let rowOff = 0;
      let byteOff = 0;
      for (const b of batches) {
        const v = b.vectors[c] as Utf8ColumnVector | BytesColumnVector;
        for (let r = 0; r < v.length; r++) {
          offsets[rowOff + r] = byteOff + v.offsets[r]!;
        }
        data.set(v.data, byteOff);
        rowOff += v.length;
        byteOff += v.data.byteLength;
      }
      offsets[totalRows] = byteOff;
      mergedVectors[c] =
        kind === 'utf8'
          ? makeUtf8Vector(totalRows, offsets, data, validity, nullCount)
          : makeBytesVector(totalRows, offsets, data, validity, nullCount);
    }
  }

  return buildColumnarResult(
    totalRows,
    fields,
    mergedVectors,
    metadataOverride ?? first.metadata,
  );
}


export * from './arrow-ipc-codec';
