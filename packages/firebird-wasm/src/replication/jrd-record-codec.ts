/**
 * jrd-record-codec.ts – Firebird JRD uncompressed record buffer encoder/decoder
 * and RDB$RELATION_FIELDS physical schema introspection (`M21 Item 5`).
 */

import type { Row } from '../types';
import type { ReplicableDatabase } from './types';
import { isInternalReplicationTable, normalizeTableName } from './shared';

export function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Column layout descriptor for decoding/encoding uncompressed Firebird JRD record buffers (`M17 Item 1`). */
export interface JrdColumnDescriptor {
  /** Column name (e.g. `'ID'`, `'TITLE'`). */
  readonly name: string;
  /** SQL column type in the Firebird relation format. */
  readonly type:
    | 'SMALLINT'
    | 'INTEGER'
    | 'INT'
    | 'BIGINT'
    | 'INT64'
    | 'FLOAT'
    | 'DOUBLE PRECISION'
    | 'DOUBLE'
    | 'BOOLEAN'
    | 'VARCHAR'
    | 'CHAR'
    | 'BLOB';
  /**
   * Storage byte length of the text buffer for `VARCHAR` / `CHAR`
   * (for UTF-8 `VARCHAR(N)`, `maxBytes = N * 4`; defaults to `charLength * 4` or `128`).
   */
  readonly maxBytes?: number;
  /** Declared character length `N` for `VARCHAR(N)` / `CHAR(N)`. */
  readonly charLength?: number;
  /** Optional negative decimal scale (e.g. `-2` for `NUMERIC(9, 2)`). */
  readonly scale?: number;
  /** Whether this column is part of the table's primary key. */
  readonly primaryKey?: boolean;
  /** For `BLOB`: `'TEXT'` (decoded as UTF-8 `string`) or `'BINARY'` (`Uint8Array`). @default 'TEXT' */
  readonly blobSubType?: 'TEXT' | 'BINARY';
}

function alignOffset(offset: number, alignment: number): number {
  if (alignment <= 1) return offset;
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
}

/**
 * Decode an uncompressed Firebird JRD record buffer (`opInsertRecord` /
 * `opUpdateRecord` / `opDeleteRecord`) into a typed JavaScript row object (`M17 Item 1`).
 */
export function decodeJrdRecordBuffer(
  recordData: Uint8Array,
  columns: ReadonlyArray<JrdColumnDescriptor>,
  blobs?: ReadonlyMap<string, Uint8Array>,
): Record<string, unknown> {
  const view = new DataView(recordData.buffer, recordData.byteOffset, recordData.byteLength);
  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const row: Record<string, unknown> = {};

  // Null bitmap at offset 0: 4-byte aligned array of bits (bit i == 1 => NULL, 0 => NOT NULL).
  const nullBitmapBytes = Math.max(4, Math.ceil(columns.length / 32) * 4);
  let offset = nullBitmapBytes;

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const byteIdx = i >> 3;
    const bitMask = 1 << (i & 7);
    const isNull = byteIdx < recordData.byteLength ? (recordData[byteIdx]! & bitMask) !== 0 : true;
    const upperType = col.type.toUpperCase();
    const scaleFactor = col.scale && col.scale < 0 ? Math.pow(10, col.scale) : 1;

    switch (upperType) {
      case 'SMALLINT': {
        offset = alignOffset(offset, 2);
        const raw = offset + 2 <= recordData.byteLength ? view.getInt16(offset, true) : 0;
        offset += 2;
        row[col.name] = isNull ? null : scaleFactor !== 1 ? raw * scaleFactor : raw;
        break;
      }
      case 'INTEGER':
      case 'INT': {
        offset = alignOffset(offset, 4);
        const raw = offset + 4 <= recordData.byteLength ? view.getInt32(offset, true) : 0;
        offset += 4;
        row[col.name] = isNull ? null : scaleFactor !== 1 ? raw * scaleFactor : raw;
        break;
      }
      case 'BIGINT':
      case 'INT64': {
        offset = alignOffset(offset, 8);
        const raw = offset + 8 <= recordData.byteLength ? view.getBigInt64(offset, true) : 0n;
        offset += 8;
        if (isNull) {
          row[col.name] = null;
        } else {
          const num = Number(raw);
          row[col.name] =
            scaleFactor !== 1
              ? num * scaleFactor
              : Number.isSafeInteger(num)
                ? num
                : raw;
        }
        break;
      }
      case 'FLOAT': {
        offset = alignOffset(offset, 4);
        const raw = offset + 4 <= recordData.byteLength ? view.getFloat32(offset, true) : 0;
        offset += 4;
        row[col.name] = isNull ? null : raw;
        break;
      }
      case 'DOUBLE PRECISION':
      case 'DOUBLE': {
        offset = alignOffset(offset, 8);
        const raw = offset + 8 <= recordData.byteLength ? view.getFloat64(offset, true) : 0;
        offset += 8;
        row[col.name] = isNull ? null : raw;
        break;
      }
      case 'BOOLEAN': {
        const raw = offset < recordData.byteLength ? recordData[offset]! : 0;
        offset += 1;
        row[col.name] = isNull ? null : raw !== 0;
        break;
      }
      case 'VARCHAR': {
        offset = alignOffset(offset, 2);
        const maxBytes = col.maxBytes ?? (col.charLength ?? 32) * 4;
        const actualLen =
          offset + 2 <= recordData.byteLength
            ? Math.min(maxBytes, view.getUint16(offset, true))
            : 0;
        const strStart = offset + 2;
        row[col.name] = isNull
          ? null
          : utf8.decode(
              recordData.subarray(strStart, Math.min(recordData.byteLength, strStart + actualLen)),
            );
        offset += 2 + maxBytes;
        break;
      }
      case 'CHAR': {
        const maxBytes = col.maxBytes ?? (col.charLength ?? 1) * 4;
        if (isNull) {
          row[col.name] = null;
        } else {
          const rawStr = utf8.decode(
            recordData.subarray(offset, Math.min(recordData.byteLength, offset + maxBytes)),
          );
          row[col.name] =
            col.charLength !== undefined ? rawStr.slice(0, col.charLength).trimEnd() : rawStr.trimEnd();
        }
        offset += maxBytes;
        break;
      }
      case 'BLOB': {
        offset = alignOffset(offset, 4);
        const quadSlice = recordData.slice(offset, Math.min(recordData.byteLength, offset + 8));
        offset += 8;
        if (isNull || quadSlice.every((b) => b === 0)) {
          row[col.name] = null;
        } else {
          const hex = bytesToHexLower(quadSlice);
          const blobBytes = blobs?.get(hex);
          if (!blobBytes) {
            row[col.name] = hex;
          } else if ((col.blobSubType ?? 'TEXT') === 'BINARY') {
            row[col.name] = blobBytes;
          } else {
            row[col.name] = utf8.decode(blobBytes);
          }
        }
        break;
      }
      default:
        row[col.name] = null;
        break;
    }
  }

  return row;
}

/**
 * Encode a JavaScript row object into Firebird's uncompressed JRD record buffer
 * format (`M17 Item 1` / `M17 Item 4`).
 */
export function encodeJrdRecordBuffer(
  row: Readonly<Record<string, unknown>>,
  columns: ReadonlyArray<JrdColumnDescriptor>,
): Uint8Array {
  const utf8Enc = new TextEncoder();
  const nullBitmapBytes = Math.max(4, Math.ceil(columns.length / 32) * 4);

  // First pass: calculate total byte length
  let totalLen = nullBitmapBytes;
  for (const col of columns) {
    const upperType = col.type.toUpperCase();
    switch (upperType) {
      case 'SMALLINT':
        totalLen = alignOffset(totalLen, 2) + 2;
        break;
      case 'INTEGER':
      case 'INT':
      case 'FLOAT':
        totalLen = alignOffset(totalLen, 4) + 4;
        break;
      case 'BIGINT':
      case 'INT64':
      case 'DOUBLE PRECISION':
      case 'DOUBLE':
        totalLen = alignOffset(totalLen, 8) + 8;
        break;
      case 'BOOLEAN':
        totalLen += 1;
        break;
      case 'VARCHAR':
        totalLen = alignOffset(totalLen, 2) + 2 + (col.maxBytes ?? (col.charLength ?? 32) * 4);
        break;
      case 'CHAR':
        totalLen += col.maxBytes ?? (col.charLength ?? 1) * 4;
        break;
      case 'BLOB':
        totalLen = alignOffset(totalLen, 4) + 8;
        break;
    }
  }

  const buf = new Uint8Array(totalLen);
  // Firebird initializes unused null-bitmap bits in the first 32-bit word to 1 (e.g. 0xFC for 2 NOT NULL cols)
  for (let b = 0; b < nullBitmapBytes; b++) {
    buf[b] = 0xff;
  }
  const view = new DataView(buf.buffer);
  let offset = nullBitmapBytes;

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const val = row[col.name] ?? row[col.name.toUpperCase()] ?? row[col.name.toLowerCase()];
    const isNull = val === null || val === undefined;
    if (!isNull) {
      buf[i >> 3]! &= ~(1 << (i & 7));
    }

    const upperType = col.type.toUpperCase();
    const invScale = col.scale && col.scale < 0 ? Math.pow(10, -col.scale) : 1;

    switch (upperType) {
      case 'SMALLINT':
        offset = alignOffset(offset, 2);
        if (!isNull) view.setInt16(offset, Math.round(Number(val) * invScale), true);
        offset += 2;
        break;
      case 'INTEGER':
      case 'INT':
        offset = alignOffset(offset, 4);
        if (!isNull) view.setInt32(offset, Math.round(Number(val) * invScale), true);
        offset += 4;
        break;
      case 'BIGINT':
      case 'INT64':
        offset = alignOffset(offset, 8);
        if (!isNull) {
          const bv =
            typeof val === 'bigint'
              ? val
              : typeof val === 'string' && (!col.scale || col.scale === 0) && /^-?\d+$/.test(val.trim())
                ? BigInt(val.trim())
                : BigInt(Math.round(Number(val) * invScale));
          view.setBigInt64(offset, bv, true);
        }
        offset += 8;
        break;
      case 'FLOAT':
        offset = alignOffset(offset, 4);
        if (!isNull) view.setFloat32(offset, Number(val), true);
        offset += 4;
        break;
      case 'DOUBLE PRECISION':
      case 'DOUBLE':
        offset = alignOffset(offset, 8);
        if (!isNull) view.setFloat64(offset, Number(val), true);
        offset += 8;
        break;
      case 'BOOLEAN':
        buf[offset] =
          !isNull &&
          (typeof val === 'string'
            ? /^(true|1|t|yes)$/i.test(val.trim())
            : Boolean(val))
            ? 1
            : 0;
        offset += 1;
        break;
      case 'VARCHAR': {
        offset = alignOffset(offset, 2);
        const maxBytes = col.maxBytes ?? (col.charLength ?? 32) * 4;
        if (!isNull) {
          const encoded = utf8Enc.encode(String(val));
          const copyLen = Math.min(maxBytes, encoded.byteLength);
          view.setUint16(offset, copyLen, true);
          buf.set(encoded.subarray(0, copyLen), offset + 2);
        }
        offset += 2 + maxBytes;
        break;
      }
      case 'CHAR': {
        const maxBytes = col.maxBytes ?? (col.charLength ?? 1) * 4;
        buf.fill(0x20, offset, offset + maxBytes);
        if (!isNull) {
          const encoded = utf8Enc.encode(String(val));
          buf.set(encoded.subarray(0, Math.min(maxBytes, encoded.byteLength)), offset);
        }
        offset += maxBytes;
        break;
      }
      case 'BLOB': {
        offset = alignOffset(offset, 4);
        if (!isNull && typeof val === 'string' && /^[0-9a-fA-F]{16}$/.test(val)) {
          for (let j = 0; j < 8; j++) {
            buf[offset + j] = parseInt(val.slice(j * 2, j * 2 + 2), 16);
          }
        } else if (!isNull && val instanceof Uint8Array && val.byteLength === 8) {
          buf.set(val, offset);
        }
        offset += 8;
        break;
      }
    }
  }

  return buf;
}


/**
 * Introspect Firebird's `RDB$RELATION_FIELDS`, `RDB$FIELDS`, and primary-key
 * constraints on `db` to derive physical {@link JrdColumnDescriptor} layouts
 * ordered by `RDB$FIELD_ID` for decoding uncompressed JRD record buffers in
 * `"FBCHANGELOG\0"` segments without manual schema configuration (`M18 Item 1`).
 */
export async function introspectJrdTableSchemas(
  db: ReplicableDatabase,
  options: { tables?: readonly string[] } = {},
): Promise<Record<string, JrdColumnDescriptor[]>> {
  const filterSet =
    options.tables && options.tables.length > 0
      ? new Set(options.tables.map((t) => normalizeTableName(t)).filter(Boolean))
      : null;

  const pkByTable = new Map<string, Set<string>>();
  try {
    const pkRes = await db.query<Row>(
      `SELECT TRIM(rc.RDB$RELATION_NAME) AS REL_NAME, ` +
        `TRIM(iseg.RDB$FIELD_NAME) AS COL_NAME ` +
        `FROM RDB$RELATION_CONSTRAINTS rc ` +
        `JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME ` +
        `WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'`,
    );
    for (const r of pkRes.rows) {
      const rel = String(r.REL_NAME ?? r.rel_name ?? '').trim().toUpperCase();
      const col = String(r.COL_NAME ?? r.col_name ?? '').trim().toUpperCase();
      if (!rel || !col) continue;
      let set = pkByTable.get(rel);
      if (!set) {
        set = new Set<string>();
        pkByTable.set(rel, set);
      }
      set.add(col);
    }
  } catch {
    // Ignore on mock databases without RDB$RELATION_CONSTRAINTS
  }

  const out: Record<string, JrdColumnDescriptor[]> = {};
  try {
    const colRes = await db.query<Row>(
      `SELECT TRIM(rf.RDB$RELATION_NAME) AS REL_NAME, ` +
        `TRIM(rf.RDB$FIELD_NAME) AS COL_NAME, ` +
        `COALESCE(rf.RDB$FIELD_ID, rf.RDB$FIELD_POSITION) AS FIELD_SLOT, ` +
        `f.RDB$FIELD_TYPE AS FIELD_TYPE, ` +
        `COALESCE(f.RDB$FIELD_SUB_TYPE, 0) AS SUB_TYPE, ` +
        `COALESCE(f.RDB$FIELD_SCALE, 0) AS FIELD_SCALE, ` +
        `COALESCE(f.RDB$FIELD_LENGTH, 0) AS BYTE_LEN, ` +
        `COALESCE(f.RDB$CHARACTER_LENGTH, 0) AS CHAR_LEN ` +
        `FROM RDB$RELATION_FIELDS rf ` +
        `JOIN RDB$RELATIONS rel ON rel.RDB$RELATION_NAME = rf.RDB$RELATION_NAME ` +
        `JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE ` +
        `WHERE COALESCE(rel.RDB$SYSTEM_FLAG, 0) = 0 ` +
        `AND rel.RDB$VIEW_BLR IS NULL ` +
        `ORDER BY rf.RDB$RELATION_NAME, COALESCE(rf.RDB$FIELD_ID, rf.RDB$FIELD_POSITION)`,
    );

    for (const r of colRes.rows) {
      const rel = String(r.REL_NAME ?? r.rel_name ?? '').trim().toUpperCase();
      const colName = String(r.COL_NAME ?? r.col_name ?? '').trim().toUpperCase();
      if (!rel || !colName || isInternalReplicationTable(rel)) continue;
      if (filterSet && !filterSet.has(rel)) continue;

      const fieldType = Number(r.FIELD_TYPE ?? r.field_type ?? 0);
      const subType = Number(r.SUB_TYPE ?? r.sub_type ?? 0);
      const scale = Number(r.FIELD_SCALE ?? r.field_scale ?? 0);
      const byteLen = Number(r.BYTE_LEN ?? r.byte_len ?? 0);
      const charLen = Number(r.CHAR_LEN ?? r.char_len ?? 0);
      const isPk = pkByTable.get(rel)?.has(colName) === true;

      let jrdType: JrdColumnDescriptor['type'] | null = null;
      switch (fieldType) {
        case 7:
          jrdType = 'SMALLINT';
          break;
        case 8:
          jrdType = 'INTEGER';
          break;
        case 10:
          jrdType = 'FLOAT';
          break;
        case 14:
          jrdType = 'CHAR';
          break;
        case 16:
          jrdType = 'BIGINT';
          break;
        case 23:
          jrdType = 'BOOLEAN';
          break;
        case 27:
          jrdType = 'DOUBLE PRECISION';
          break;
        case 37:
          jrdType = 'VARCHAR';
          break;
        case 261:
          jrdType = 'BLOB';
          break;
        default:
          jrdType = null;
          break;
      }

      if (!jrdType) continue;

      const desc: JrdColumnDescriptor = {
        name: colName,
        type: jrdType,
        ...(byteLen > 0 && (jrdType === 'VARCHAR' || jrdType === 'CHAR')
          ? { maxBytes: byteLen }
          : {}),
        ...(charLen > 0 && (jrdType === 'VARCHAR' || jrdType === 'CHAR')
          ? { charLength: charLen }
          : {}),
        ...(scale < 0 ? { scale } : {}),
        ...(isPk ? { primaryKey: true } : {}),
        ...(jrdType === 'BLOB'
          ? { blobSubType: subType === 1 ? 'TEXT' : 'BINARY' }
          : {}),
      };

      let list = out[rel];
      if (!list) {
        list = [];
        out[rel] = list;
      }
      list.push(desc);
    }
  } catch {
    // Ignore on mock databases without RDB$RELATION_FIELDS
  }

  return out;
}
