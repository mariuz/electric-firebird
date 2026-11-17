/**
 * arrow-ipc-codec.ts – Zero-dependency Apache Arrow IPC V5 stream FlatBuffers
 * encoder and decoder (`M19 Item 2` / `M21 Item 2` / `M23 Item 5`).
 */

import type { FieldInfo } from './types';
import {
  allocateAllValidBitmap,
  buildColumnarResult,
  concatColumnarResults,
  inferVectorKindForField,
  makeBigInt64Vector,
  makeBoolVector,
  makeBytesVector,
  makeFloat64Vector,
  makeInt32Vector,
  makeUtf8Vector,
  type ArrowIpcOptions,
  type ColumnVector,
  type ColumnarQueryResult,
} from './columnar';

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

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

function buildArrowSchemaMessageFromFields(
  fields: readonly FieldInfo[],
  vectorKinds?: ReadonlyArray<ColumnVector['kind']>,
  baseMetadata?: Readonly<Record<string, string>>,
  metadata?: Readonly<Record<string, string>>,
): Uint8Array {
  const fb = new MiniFlatBufferBuilder(1024);
  const fieldTableOffsets: number[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const kind = vectorKinds?.[i] ?? inferVectorKindForField(field);
    const nameOff = fb.createString(field.name);
    const emptyChildrenOff = fb.createOffsetVector([]);

    let typeEnum = ARROW_TYPE_UTF8;
    let typeTableOff = 0;
    switch (kind) {
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
  const mergedMeta = { ...baseMetadata, ...metadata };
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

function buildArrowSchemaMessage(
  columnar: ColumnarQueryResult,
  metadata?: Readonly<Record<string, string>>,
): Uint8Array {
  return buildArrowSchemaMessageFromFields(
    columnar.fields,
    columnar.vectors.map((v) => v.kind),
    columnar.metadata,
    metadata,
  );
}

/**
 * Encode only the framed Apache Arrow IPC V5 `Schema` message (`0xFFFFFFFF`
 * continuation + aligned FlatBuffer `Schema`) for streaming IPC writers (`M21 Item 2`).
 */
export function encodeArrowIpcSchemaFrame(
  source: ColumnarQueryResult | readonly FieldInfo[],
  options?: ArrowIpcOptions,
): Uint8Array {
  const schemaMeta = Array.isArray(source)
    ? buildArrowSchemaMessageFromFields(source, undefined, undefined, options?.metadata)
    : buildArrowSchemaMessage(source as ColumnarQueryResult, options?.metadata);
  const paddedLen = align8(schemaMeta.byteLength);
  const out = new Uint8Array(8 + paddedLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, ARROW_IPC_CONTINUATION, true);
  view.setInt32(4, paddedLen, true);
  out.set(schemaMeta, 8);
  return out;
}

/**
 * Encode a single framed Apache Arrow IPC V5 `RecordBatch` message (`0xFFFFFFFF`
 * continuation + aligned FlatBuffer `RecordBatch` + 8-byte aligned body buffers) (`M21 Item 2`).
 */
export function encodeArrowIpcRecordBatchFrame(
  columnar: ColumnarQueryResult,
): Uint8Array {
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

  const fb = new MiniFlatBufferBuilder(1024);
  fb.prep(8, bufferDescriptors.length * 16);
  for (let i = bufferDescriptors.length - 1; i >= 0; i--) {
    const b = bufferDescriptors[i]!;
    fb.writeI64(b.length);
    fb.writeI64(b.offset);
  }
  fb.prep(4, 0);
  fb.writeI32(bufferDescriptors.length);
  const buffersVecOff = fb.offset();

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

  const out = new Uint8Array(8 + paddedRbMetaLen + bodyOffset);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, ARROW_IPC_CONTINUATION, true);
  outView.setInt32(4, paddedRbMetaLen, true);
  out.set(rbMeta, 8);
  let p = 8 + paddedRbMetaLen;
  for (const chunk of bodyChunks) {
    if (chunk.byteLength > 0) {
      out.set(chunk, p);
      p += chunk.byteLength;
    }
  }
  return out;
}

/** Encode the 8-byte Apache Arrow IPC V5 End-Of-Stream (`0xFFFFFFFF, 0x00000000`) marker (`M21 Item 2`). */
export function encodeArrowIpcEosFrame(): Uint8Array {
  return new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
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
 * Decode an **Apache Arrow IPC Stream** (`Uint8Array`) into its constituent
 * `RecordBatch` chunks as {@link ColumnarQueryResult} objects (`M21 Item 2`).
 */
export function decodeArrowIpcBatches(ipcBytes: Uint8Array): ColumnarQueryResult[] {
  const view = new DataView(ipcBytes.buffer, ipcBytes.byteOffset, ipcBytes.byteLength);
  let pos = 0;

  interface ParsedArrowCol {
    field: FieldInfo;
    kind: ColumnVector['kind'];
  }
  const cols: ParsedArrowCol[] = [];
  const schemaMetadata: Record<string, string> = {};
  const batches: ColumnarQueryResult[] = [];

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
      const batchRowCount = Number(reader.readI64(headerTable, 0, 0n));
      const nodesVec = reader.readStructVectorPos(headerTable, 1);
      const bufsVec = reader.readStructVectorPos(headerTable, 2);

      const getBuf = (idx: number): Uint8Array => {
        if (idx >= bufsVec.length) return new Uint8Array(0);
        const off = Number(reader.i64At(bufsVec.start + idx * 16));
        const len = Number(reader.i64At(bufsVec.start + idx * 16 + 8));
        return len === 0 ? new Uint8Array(0) : body.slice(off, off + len);
      };

      let bufIdx = 0;
      const vectors: ColumnVector[] = new Array(cols.length);
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c]!;
        const len =
          c < nodesVec.length ? Number(reader.i64At(nodesVec.start + c * 16)) : batchRowCount;
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

      batches.push(
        buildColumnarResult(
          batchRowCount,
          cols.map((c) => c.field),
          vectors,
          schemaMetadata,
        ),
      );
    }

    pos += bodyLength;
  }

  if (batches.length === 0) {
    const emptyVectors = cols.map((col) => {
      const validity = new Uint8Array(0);
      switch (col.kind) {
        case 'int32':
          return makeInt32Vector(new Int32Array(0), validity, 0);
        case 'float64':
          return makeFloat64Vector(new Float64Array(0), validity, 0);
        case 'bigint64':
          return makeBigInt64Vector(new BigInt64Array(0), validity, 0);
        case 'bool':
          return makeBoolVector(0, new Uint8Array(0), validity, 0);
        case 'bytes':
          return makeBytesVector(0, new Int32Array(1), new Uint8Array(0), validity, 0);
        default:
          return makeUtf8Vector(0, new Int32Array(1), new Uint8Array(0), validity, 0);
      }
    });
    return [
      buildColumnarResult(
        0,
        cols.map((c) => c.field),
        emptyVectors,
        schemaMetadata,
      ),
    ];
  }

  return batches;
}

/**
 * Decode an **Apache Arrow IPC Stream** (`Uint8Array` with 1 or more `RecordBatch`
 * frames) back into a typed {@link ColumnarQueryResult} (`M19 Item 2` / `M21 Item 2`).
 */
export function decodeArrowIpc(ipcBytes: Uint8Array): ColumnarQueryResult {
  const batches = decodeArrowIpcBatches(ipcBytes);
  return batches.length === 1 ? batches[0]! : concatColumnarResults(batches);
}
