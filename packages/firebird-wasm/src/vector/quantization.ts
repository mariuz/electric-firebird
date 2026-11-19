/**
 * quantization.ts – Scalar `int8` (`4×` smaller) and 1-bit Binary (`32×` smaller)
 * Vector Quantization & Fast Hamming / Int8 Distance Kernels (`M25 Item 3`).
 */

import { decodeVector, type VectorDistanceMetric, type VectorInput } from './index';

export type VectorQuantizationMode = 'none' | 'int8' | 'binary';

/**
 * Affine scalar-quantized `Int8Array` vector (`v_i ≈ q_i * scale + offset`).
 * Reduces embedding RAM footprint by ~`4×` relative to `Float32Array`.
 */
export interface QuantizedInt8Vector {
  readonly data: Int8Array;
  readonly scale: number;
  readonly offset: number;
  readonly dimensions: number;
}

const POPCOUNT_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let x = i;
    let c = 0;
    while (x !== 0) {
      x &= x - 1;
      c++;
    }
    table[i] = c;
  }
  return table;
})();

/**
 * Quantize any `VectorInput` into a compact `Int8Array` (`[-127, 127]`) with
 * per-vector affine `(scale, offset)` metadata (`M25 Item 3`).
 */
export function quantizeVectorInt8(input: VectorInput): QuantizedInt8Vector {
  const f32 = decodeVector(input);
  const len = f32.length;
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < len; i++) {
    const v = f32[i]!;
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  const data = new Int8Array(len);
  const span = maxVal - minVal;
  if (!Number.isFinite(span) || span === 0) {
    return {
      data,
      scale: 0,
      offset: Number.isFinite(minVal) ? minVal : 0,
      dimensions: len,
    };
  }

  const offset = (minVal + maxVal) * 0.5;
  const halfSpan = span * 0.5;
  const scale = halfSpan / 127;
  const invScale = 127 / halfSpan;

  for (let i = 0; i < len; i++) {
    const q = Math.round((f32[i]! - offset) * invScale);
    data[i] = q < -127 ? -127 : q > 127 ? 127 : q;
  }

  return {
    data,
    scale,
    offset,
    dimensions: len,
  };
}

/**
 * Reconstruct an approximate `Float32Array` from a {@link QuantizedInt8Vector}.
 */
export function dequantizeVectorInt8(quantized: QuantizedInt8Vector): Float32Array {
  const { data, scale, offset } = quantized;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! * scale + offset;
  }
  return out;
}

/**
 * Pack a {@link QuantizedInt8Vector} into a binary `Uint8Array` (`12`-byte header:
 * `uint32LE dimensions`, `float32LE scale`, `float32LE offset`, followed by `dimensions` int8 bytes).
 */
export function encodeQuantizedInt8(quantized: QuantizedInt8Vector): Uint8Array {
  const out = new Uint8Array(12 + quantized.data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, quantized.dimensions, true);
  view.setFloat32(4, quantized.scale, true);
  view.setFloat32(8, quantized.offset, true);
  out.set(
    new Uint8Array(quantized.data.buffer, quantized.data.byteOffset, quantized.data.byteLength),
    12,
  );
  return out;
}

/**
 * Unpack a binary `Uint8Array` produced by {@link encodeQuantizedInt8}.
 */
export function decodeQuantizedInt8(bytes: Uint8Array): QuantizedInt8Vector {
  if (bytes.byteLength < 13) {
    throw new RangeError(`Encoded int8 vector buffer too short (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = view.getUint32(0, true);
  if (bytes.byteLength !== 12 + dimensions) {
    throw new RangeError(
      `Encoded int8 vector length mismatch: header declares ${dimensions} dims, buffer has ${bytes.byteLength - 12} payload bytes`,
    );
  }
  const scale = view.getFloat32(4, true);
  const offset = view.getFloat32(8, true);
  const data = new Int8Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    data[i] = view.getInt8(12 + i);
  }
  return { data, scale, offset, dimensions };
}

/**
 * Fast approximate distance between two `QuantizedInt8Vector` embeddings using
 * integer accumulators before applying affine scale factors.
 */
export function int8ApproximateDistance(
  metric: VectorDistanceMetric,
  a: QuantizedInt8Vector,
  b: QuantizedInt8Vector,
): number {
  if (a.dimensions !== b.dimensions) {
    throw new RangeError(
      `Quantized int8 dimension mismatch: ${a.dimensions} vs ${b.dimensions}`,
    );
  }
  const len = a.dimensions;
  const da = a.data;
  const db = b.data;

  // Fast symmetric zero-offset path or general affine accumulator
  let sumQaQb = 0;
  let sumQa = 0;
  let sumQb = 0;
  let sumQa2 = 0;
  let sumQb2 = 0;

  for (let i = 0; i < len; i++) {
    const qa = da[i]!;
    const qb = db[i]!;
    sumQaQb += qa * qb;
    sumQa += qa;
    sumQb += qb;
    sumQa2 += qa * qa;
    sumQb2 += qb * qb;
  }

  const sa = a.scale;
  const sb = b.scale;
  const oa = a.offset;
  const ob = b.offset;

  const dot =
    sa * sb * sumQaQb +
    sa * ob * sumQa +
    sb * oa * sumQb +
    len * oa * ob;

  if (metric === 'dot') {
    return Object.is(-dot, -0) ? 0 : -dot;
  }

  const normA2 = Math.max(0, sa * sa * sumQa2 + 2 * sa * oa * sumQa + len * oa * oa);
  const normB2 = Math.max(0, sb * sb * sumQb2 + 2 * sb * ob * sumQb + len * ob * ob);

  if (metric === 'l2') {
    const sq = Math.max(0, normA2 + normB2 - 2 * dot);
    return Math.sqrt(sq);
  }

  const denom = Math.sqrt(normA2) * Math.sqrt(normB2);
  if (denom === 0) return 1;
  const sim = Math.max(-1, Math.min(1, dot / denom));
  const dist = 1 - sim;
  return Math.abs(dist) < 1e-7 ? 0 : dist;
}

/**
 * Quantize any `VectorInput` into a 1-bit-per-dimension packed `Uint8Array`
 * (`bit = 1` when `v[i] > 0`, `0` otherwise — `32×` smaller than `Float32Array`).
 */
export function quantizeVectorBinary(input: VectorInput): Uint8Array {
  const f32 = decodeVector(input);
  const byteLen = Math.ceil(f32.length / 8);
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < f32.length; i++) {
    if (f32[i]! > 0) {
      out[i >>> 3]! |= 1 << (i & 7);
    }
  }
  return out;
}

/**
 * Compute exact bit-level Hamming distance (`popcount(a XOR b)`) between two
 * packed binary vectors of equal byte length (`M25 Item 3`).
 */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.byteLength !== b.byteLength) {
    throw new RangeError(
      `Binary vector byte length mismatch: ${a.byteLength} vs ${b.byteLength}`,
    );
  }
  let dist = 0;
  for (let i = 0; i < a.byteLength; i++) {
    dist += POPCOUNT_TABLE[a[i]! ^ b[i]!]!;
  }
  return dist;
}
