/**
 * firebird-wasm/vector – Client-Side Vector Similarity & Hybrid Search.
 *
 * Provides pure TypeScript vector encoding, normalization, distance metrics
 * (`cosineDistance`, `cosineSimilarity`, `l2Distance`, `squaredL2Distance`,
 * `dotProduct`, `innerProductDistance`), SQL UDR registration (`registerVectorFunctions`),
 * and hybrid vector + SQL search (`vectorSearch`) over packed IEEE-754
 * little-endian `Float32Array` embeddings stored in `BINARY(N)`, `VARBINARY(N)`,
 * `CHAR(N) CHARACTER SET OCTETS`, `VARCHAR(N) CHARACTER SET OCTETS`, or `BLOB`
 * columns in Firebird.
 *
 * @example
 * ```ts
 * import {
 *   encodeVector,
 *   cosineDistance,
 *   registerVectorFunctions,
 *   vectorSearch,
 * } from 'firebird-wasm/vector';
 *
 * await registerVectorFunctions(db);
 * await db.exec('CREATE TABLE docs (id INT PRIMARY KEY, title VARCHAR(200), embedding VARBINARY(12))');
 * await db.exec('INSERT INTO docs VALUES (?, ?, ?)', [1, 'Firebird WASM', encodeVector([1, 0, 0])]);
 *
 * const hits = await vectorSearch(db, {
 *   table: 'docs',
 *   column: 'embedding',
 *   query: [0.9, 0.1, 0],
 *   metric: 'cosine',
 *   limit: 5,
 * });
 * ```
 */

import type { QueryParams, QueryResult, RegisteredRoutine, Row } from '../types';
import type { RegisterFunctionOptions, JsFunctionHandler } from '../types';

/**
 * Supported vector similarity/distance metrics.
 *
 * - `'cosine'`: Cosine distance ($1 - \cos(\theta)$), range $[0, 2]$. Smaller is more similar.
 * - `'l2'`: Euclidean ($L_2$) distance ($\sqrt{\sum (a_i - b_i)^2}$), range $[0, \infty)$. Smaller is more similar.
 * - `'dot'`: Negative dot product ($-\sum a_i b_i$) for distance ordering, or raw dot product via {@link dotProduct}.
 */
export type VectorDistanceMetric = 'cosine' | 'l2' | 'dot';

/**
 * Accepted input representations for a vector embedding:
 * - `Float32Array` or `Float64Array`
 * - `number[]` (or `readonly number[]`)
 * - `Uint8Array` / `ArrayBuffer` (packed little-endian IEEE-754 float32 bytes)
 * - `string`:
 *   - Bracketed JSON / pgvector literal: `"[0.1, 0.2, 0.3]"`
 *   - Base64-encoded little-endian float32 bytes (as returned by Firebird JSON query encoding for binary columns)
 *   - Hex-encoded float32 bytes (`"x'0000803f...'"` or `"0x0000803f..."`)
 */
export type VectorInput =
  | Float32Array
  | Float64Array
  | readonly number[]
  | Uint8Array
  | ArrayBuffer
  | string;

/**
 * Minimal database interface required by {@link registerVectorFunctions} and {@link vectorSearch}.
 * Satisfied by both `FirebirdBrowser`, `FirebirdBrowserTransaction`, `FirebirdLite`, and `FirebirdTransaction`.
 */
export interface VectorDatabaseExecutor {
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;
  registerFunction?(
    name: string,
    options: RegisterFunctionOptions,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
}

/**
 * Options for {@link registerVectorFunctions}.
 */
export interface RegisterVectorFunctionsOptions {
  /**
   * Maximum character/byte length for `VARCHAR(...)` arguments in the SQL
   * function declarations.
   *
   * Defaults to `8191` (the maximum UTF-8 `VARCHAR` length in Firebird).
   */
  maxArgLength?: number;
  /**
   * Whether to replace existing SQL function definitions (`CREATE OR ALTER FUNCTION`).
   * Defaults to `true`.
   */
  replace?: boolean;
}

/**
 * Options for {@link vectorSearch} hybrid SQL + vector similarity search.
 */
export interface VectorSearchOptions {
  /** Target table or view name containing the vector column. */
  table: string;
  /** Column name storing the vector (e.g. `'embedding'`). */
  column: string;
  /** Query vector to compare against. */
  query: VectorInput;
  /**
   * Distance metric used to rank rows.
   * - `'cosine'` (default): ascending by `cosineDistance(row, query)`
   * - `'l2'`: ascending by `l2Distance(row, query)`
   * - `'dot'`: ascending by `-dotProduct(row, query)` (so highest dot product ranks first)
   */
  metric?: VectorDistanceMetric;
  /** Maximum number of nearest neighbors to return (default: `10`). */
  limit?: number;
  /**
   * Optional maximum distance threshold. Rows with `distance > maxDistance` are
   * excluded from the results.
   */
  maxDistance?: number;
  /**
   * Optional minimum similarity threshold (only rows with `similarity >= minSimilarity`
   * are kept).
   */
  minSimilarity?: number;
  /**
   * Columns to select from `table` (default: `['*']`).
   * May be an array of column names/expressions or `'*'`.
   */
  select?: readonly string[] | '*';
  /**
   * Optional SQL `WHERE` predicate for hybrid pre-filtering (without the leading `WHERE` keyword),
   * e.g. `'category = ? AND published = TRUE'`.
   */
  where?: string;
  /** Positional parameter values bound to `?` placeholders in {@link where}. */
  params?: QueryParams;
  /**
   * Property name added to each returned row for the computed distance
   * (default: `'DISTANCE'`).
   */
  distanceColumn?: string;
  /**
   * Property name added to each returned row for the computed similarity score
   * (default: `'SIMILARITY'`).
   */
  similarityColumn?: string;
  /**
   * Whether to include the raw embedding column in the returned objects
   * (default: `false` so result payloads stay compact).
   */
  includeVector?: boolean;
}

/**
 * A single nearest-neighbor result row returned by {@link vectorSearch}.
 */
export type VectorSearchRow<T extends Row = Row> = T & {
  DISTANCE: number;
  SIMILARITY: number;
};

// ---------------------------------------------------------------------------
// Encoding & Decoding
// ---------------------------------------------------------------------------

const IS_LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, 256, true);
  return new Int16Array(buf)[0] === 256;
})();

/**
 * Encode a numeric vector (`Float32Array`, `Float64Array`, or `number[]`) into
 * a packed little-endian IEEE-754 float32 `Uint8Array` suitable for binding to
 * Firebird `BINARY(N)`, `VARBINARY(N)`, `OCTETS`, or `BLOB` columns.
 *
 * Each dimension occupies exactly 4 bytes (`N = dims * 4`).
 */
export function encodeVector(input: VectorInput): Uint8Array {
  const f32 = decodeVector(input);
  if (
    IS_LITTLE_ENDIAN &&
    f32.byteOffset % 4 === 0
  ) {
    const out = new Uint8Array(f32.byteLength);
    out.set(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
    return out;
  }
  const buf = new ArrayBuffer(f32.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    view.setFloat32(i * 4, f32[i]!, true);
  }
  return new Uint8Array(buf);
}

/**
 * Format a vector as a bracketed string literal (`"[0.1,0.2,0.3]"`), compatible
 * with pgvector text syntax and human-readable SQL literals.
 */
export function formatVectorText(input: VectorInput): string {
  const f32 = decodeVector(input);
  const parts: string[] = new Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i]!;
    parts[i] = Number.isFinite(v) ? String(Number(v.toPrecision(7))) : '0';
  }
  return `[${parts.join(',')}]`;
}

/**
 * Return the SQL column type declaration for a fixed-dimension float32 vector,
 * e.g. `vectorColumnType(384)` -> `'VARBINARY(1536)'` (or `'BLOB SUB_TYPE BINARY'`
 * when `dimensions * 4 > 32765`).
 */
export function vectorColumnType(
  dimensions: number,
  options?: { fixed?: boolean },
): string {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new RangeError(
      `Vector dimensions must be a positive integer (got ${String(dimensions)})`,
    );
  }
  const byteLength = dimensions * 4;
  if (byteLength > 32765) {
    return 'BLOB SUB_TYPE BINARY';
  }
  return options?.fixed ? `BINARY(${byteLength})` : `VARBINARY(${byteLength})`;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function decodeHexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new RangeError(`Invalid hex vector byte string length (${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new RangeError(`Invalid hex byte in vector string: '${hex.slice(i * 2, i * 2 + 2)}'`);
    }
    out[i] = byte;
  }
  return out;
}

function bytesToFloat32Array(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength === 0) {
    throw new RangeError('Vector byte buffer cannot be empty');
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new RangeError(
      `Packed Float32 vector byte length must be a multiple of 4 (got ${bytes.byteLength} bytes)`,
    );
  }
  const dims = bytes.byteLength / 4;
  if (IS_LITTLE_ENDIAN && bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, dims);
  }
  const out = new Float32Array(dims);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dims; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/**
 * When a SQL string literal (e.g. `'[1,0,0]'` or `"x'0000803f'"`) is passed
 * into a `VARBINARY` (`CHARACTER SET OCTETS`) UDR parameter, Firebird's C++
 * JSON bridge serializes the parameter bytes as base64. Check whether a
 * base64-decoded byte buffer is actually an ASCII text vector literal before
 * interpreting it as raw IEEE-754 float32 bytes.
 */
function tryDecodeAsciiVectorBytes(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength < 3) return null;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    if (!((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d)) {
      return null;
    }
  }
  let text = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    text += String.fromCharCode(bytes[i]!);
  }
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('[') &&
      trimmed.endsWith(']') &&
      /^\[\s*[-+]?(?:\d|\.\d)/.test(trimmed)) ||
    /^[xX]'[0-9a-fA-F]+'$/.test(trimmed) ||
    /^0[xX][0-9a-fA-F]+$/.test(trimmed)
  ) {
    try {
      return decodeVector(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decode any supported {@link VectorInput} (`Float32Array`, `number[]`,
 * `Uint8Array`, `ArrayBuffer`, bracketed `"[0.1, 0.2]"` text, hex string, or
 * base64-encoded binary column value) into a `Float32Array`.
 */
export function decodeVector(input: unknown): Float32Array {
  if (input instanceof Float32Array) {
    if (input.length === 0) {
      throw new RangeError('Vector cannot be empty');
    }
    return input;
  }

  if (input instanceof Float64Array) {
    if (input.length === 0) {
      throw new RangeError('Vector cannot be empty');
    }
    return new Float32Array(input);
  }

  if (input instanceof Uint8Array) {
    return bytesToFloat32Array(input);
  }

  if (input instanceof ArrayBuffer) {
    return bytesToFloat32Array(new Uint8Array(input));
  }

  if (ArrayBuffer.isView(input)) {
    return bytesToFloat32Array(
      new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    );
  }

  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new RangeError('Vector array cannot be empty');
    }
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const n = Number(input[i]);
      if (!Number.isFinite(n)) {
        throw new TypeError(`Invalid non-finite vector element at index ${i}: ${String(input[i])}`);
      }
      out[i] = n;
    }
    return out;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new RangeError('Vector string cannot be empty');
    }

    // 1. Bracketed array literal: `[0.1, 0.2, -0.3]`
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) {
        throw new RangeError('Vector array literal cannot be empty');
      }
      const parts = inner.split(',');
      const out = new Float32Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i]!.trim());
        if (!Number.isFinite(n)) {
          throw new TypeError(`Invalid number in vector literal at index ${i}: '${parts[i]}'`);
        }
        out[i] = n;
      }
      return out;
    }

    // 2. Hex literal: `x'...'`, `X'...'`, or `0x...`
    const sqlHexMatch = /^[xX]'([0-9a-fA-F]+)'$/.exec(trimmed);
    if (sqlHexMatch) {
      return bytesToFloat32Array(decodeHexToBytes(sqlHexMatch[1]!));
    }
    if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) {
      return bytesToFloat32Array(decodeHexToBytes(trimmed.slice(2)));
    }

    // 3. Base64-encoded float32 bytes (how Firebird's JSON bridge serializes OCTETS / BINARY / BLOB)
    if (
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      const bytes = decodeBase64ToBytes(trimmed);
      const fromAsciiLiteral = tryDecodeAsciiVectorBytes(bytes);
      if (fromAsciiLiteral) {
        return fromAsciiLiteral;
      }
      if (bytes.byteLength > 0 && bytes.byteLength % 4 === 0) {
        return bytesToFloat32Array(bytes);
      }
    }

    // 4. Raw UTF-8 / binary string fallback (if 4-byte aligned)
    if (input.length > 0 && input.length % 4 === 0) {
      const bytes = new Uint8Array(input.length);
      let allByteRange = true;
      for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (code > 255) {
          allByteRange = false;
          break;
        }
        bytes[i] = code;
      }
      if (allByteRange) {
        return bytesToFloat32Array(bytes);
      }
    }

    throw new TypeError(
      `Cannot decode vector from string '${trimmed.slice(0, 40)}${trimmed.length > 40 ? '...' : ''}'`,
    );
  }

  throw new TypeError(
    `Unsupported vector input type: ${input === null ? 'null' : typeof input}`,
  );
}

// ---------------------------------------------------------------------------
// Vector Math & Distance Metrics
// ---------------------------------------------------------------------------

function resolveVectorPair(
  a: VectorInput,
  b: VectorInput,
): [Float32Array, Float32Array] {
  const va = decodeVector(a);
  const vb = decodeVector(b);
  if (va.length !== vb.length) {
    throw new RangeError(
      `Vector dimension mismatch: ${va.length} vs ${vb.length}`,
    );
  }
  return [va, vb];
}

/**
 * Compute the $L_2$ (Euclidean) norm $\|\mathbf{v}\|_2 = \sqrt{\sum v_i^2}$ of a vector.
 */
export function vectorNorm(input: VectorInput): number {
  const v = decodeVector(input);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/**
 * Return a new unit-length ($L_2$-normalized) `Float32Array` in the same direction as `input`.
 * If `input` is the zero vector, returns a zero-filled `Float32Array` of the same length.
 */
export function normalizeVector(input: VectorInput): Float32Array {
  const v = decodeVector(input);
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return out;
  }
  const inv = 1 / norm;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i]! * inv;
  }
  return out;
}

/**
 * Compute the dot product (inner product) $\mathbf{a} \cdot \mathbf{b} = \sum_{i=0}^{n-1} a_i b_i$.
 *
 * Uses 4-way loop unrolling for low-overhead SIMD-friendly execution in V8/SpiderMonkey/JavaScriptCore.
 */
export function dotProduct(a: VectorInput, b: VectorInput): number {
  const [va, vb] = resolveVectorPair(a, b);
  const len = va.length;
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  let i = 0;
  const limit = len - (len % 4);
  for (; i < limit; i += 4) {
    sum0 += va[i]! * vb[i]!;
    sum1 += va[i + 1]! * vb[i + 1]!;
    sum2 += va[i + 2]! * vb[i + 2]!;
    sum3 += va[i + 3]! * vb[i + 3]!;
  }
  let total = sum0 + sum1 + sum2 + sum3;
  for (; i < len; i++) {
    total += va[i]! * vb[i]!;
  }
  return total;
}

/**
 * Compute the negative inner product distance $-\mathbf{a} \cdot \mathbf{b}$
 * (mirrors pgvector's `<#>` operator so `ORDER BY distance ASC` ranks highest inner product first).
 */
export function innerProductDistance(a: VectorInput, b: VectorInput): number {
  const d = -dotProduct(a, b);
  return Object.is(d, -0) ? 0 : d;
}

/**
 * Compute the squared Euclidean ($L_2^2$) distance $\sum_{i=0}^{n-1} (a_i - b_i)^2$.
 */
export function squaredL2Distance(a: VectorInput, b: VectorInput): number {
  const [va, vb] = resolveVectorPair(a, b);
  const len = va.length;
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  let i = 0;
  const limit = len - (len % 4);
  for (; i < limit; i += 4) {
    const d0 = va[i]! - vb[i]!;
    const d1 = va[i + 1]! - vb[i + 1]!;
    const d2 = va[i + 2]! - vb[i + 2]!;
    const d3 = va[i + 3]! - vb[i + 3]!;
    sum0 += d0 * d0;
    sum1 += d1 * d1;
    sum2 += d2 * d2;
    sum3 += d3 * d3;
  }
  let total = sum0 + sum1 + sum2 + sum3;
  for (; i < len; i++) {
    const d = va[i]! - vb[i]!;
    total += d * d;
  }
  return total;
}

/**
 * Compute the Euclidean ($L_2$) distance $\sqrt{\sum_{i=0}^{n-1} (a_i - b_i)^2}$
 * (mirrors pgvector's `<->` operator).
 */
export function l2Distance(a: VectorInput, b: VectorInput): number {
  return Math.sqrt(squaredL2Distance(a, b));
}

/**
 * Compute the cosine similarity $\frac{\mathbf{a} \cdot \mathbf{b}}{\|\mathbf{a}\|_2 \|\mathbf{b}\|_2} \in [-1, 1]$.
 *
 * Returns `0` if either vector has zero magnitude.
 */
export function cosineSimilarity(a: VectorInput, b: VectorInput): number {
  const [va, vb] = resolveVectorPair(a, b);
  const len = va.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = va[i]!;
    const y = vb[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  const sim = dot / denom;
  return Math.max(-1, Math.min(1, sim));
}

/**
 * Compute the cosine distance $1 - \text{cosineSimilarity}(\mathbf{a}, \mathbf{b}) \in [0, 2]$
 * (mirrors pgvector's `<=>` operator).
 *
 * Returns `1` if either vector has zero magnitude.
 */
export function cosineDistance(a: VectorInput, b: VectorInput): number {
  const [va, vb] = resolveVectorPair(a, b);
  const len = va.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = va[i]!;
    const y = vb[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 1;
  }
  const sim = Math.max(-1, Math.min(1, dot / denom));
  const dist = 1 - sim;
  return Math.abs(dist) < 1e-7 ? 0 : dist;
}

// ---------------------------------------------------------------------------
// SQL UDR Registration (`registerVectorFunctions`)
// ---------------------------------------------------------------------------

/**
 * Register the built-in vector similarity and utility functions on `db` via
 * `db.registerFunction(...)` so they can be called directly inside Firebird
 * SQL `SELECT`, `WHERE`, and `ORDER BY` clauses:
 *
 * - `COSINE_DISTANCE(a, b)` -> `DOUBLE PRECISION`
 * - `COSINE_SIMILARITY(a, b)` -> `DOUBLE PRECISION`
 * - `L2_DISTANCE(a, b)` -> `DOUBLE PRECISION`
 * - `DOT_PRODUCT(a, b)` -> `DOUBLE PRECISION`
 * - `VECTOR_DIMS(v)` -> `INTEGER`
 * - `VECTOR_NORM(v)` -> `DOUBLE PRECISION`
 * - `VECTOR_TO_TEXT(v)` -> `VARCHAR(4096)`
 */
export async function registerVectorFunctions(
  db: VectorDatabaseExecutor,
  options: RegisterVectorFunctionsOptions = {},
): Promise<RegisteredRoutine[]> {
  if (typeof db.registerFunction !== 'function') {
    throw new TypeError(
      'Database instance does not support db.registerFunction()',
    );
  }

  const maxLen = Math.max(64, Math.min(8191, options.maxArgLength ?? 8191));
  const replace = options.replace !== false;
  const vecArgType = `VARBINARY(${maxLen})`;

  const routines: RegisteredRoutine[] = [];

  routines.push(
    await db.registerFunction(
      'COSINE_DISTANCE',
      {
        args: [vecArgType, vecArgType],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (a: unknown, b: unknown) => {
        if (a == null || b == null) return null;
        return cosineDistance(a as VectorInput, b as VectorInput);
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'COSINE_SIMILARITY',
      {
        args: [vecArgType, vecArgType],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (a: unknown, b: unknown) => {
        if (a == null || b == null) return null;
        return cosineSimilarity(a as VectorInput, b as VectorInput);
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'L2_DISTANCE',
      {
        args: [vecArgType, vecArgType],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (a: unknown, b: unknown) => {
        if (a == null || b == null) return null;
        return l2Distance(a as VectorInput, b as VectorInput);
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'DOT_PRODUCT',
      {
        args: [vecArgType, vecArgType],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (a: unknown, b: unknown) => {
        if (a == null || b == null) return null;
        return dotProduct(a as VectorInput, b as VectorInput);
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'VECTOR_DIMS',
      {
        args: [vecArgType],
        returns: 'INTEGER',
        deterministic: true,
        replace,
      },
      (v: unknown) => {
        if (v == null) return null;
        return decodeVector(v).length;
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'VECTOR_NORM',
      {
        args: [vecArgType],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (v: unknown) => {
        if (v == null) return null;
        return vectorNorm(v as VectorInput);
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'VECTOR_TO_TEXT',
      {
        args: [vecArgType],
        returns: 'VARCHAR(4096)',
        deterministic: true,
        replace,
      },
      (v: unknown) => {
        if (v == null) return null;
        return formatVectorText(v as VectorInput);
      },
    ),
  );

  return routines;
}

// ---------------------------------------------------------------------------
// Hybrid SQL + Vector Nearest-Neighbor Search (`vectorSearch`)
// ---------------------------------------------------------------------------

function quoteSqlIdentifier(ident: string, label: string): string {
  const trimmed = ident.trim();
  if (!trimmed) {
    throw new RangeError(`${label} cannot be empty`);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
    throw new RangeError(
      `Invalid ${label} '${ident}': must be a valid SQL identifier`,
    );
  }
  return `"${trimmed.toUpperCase()}"`;
}

function getRowCaseInsensitive(
  row: Record<string, unknown>,
  columnName: string,
): { key: string; value: unknown } | undefined {
  const clean = columnName.replace(/^"|"$/g, '');
  if (clean in row) {
    return { key: clean, value: row[clean] };
  }
  const upper = clean.toUpperCase();
  if (upper in row) {
    return { key: upper, value: row[upper] };
  }
  const lower = clean.toLowerCase();
  if (lower in row) {
    return { key: lower, value: row[lower] };
  }
  for (const key of Object.keys(row)) {
    if (key.toUpperCase() === upper) {
      return { key, value: row[key] };
    }
  }
  return undefined;
}

/**
 * Execute a hybrid SQL + vector K-Nearest-Neighbors (KNN) search against a
 * Firebird table or view.
 *
 * 1. Pushes down any SQL `WHERE` filter and column projection to Firebird.
 * 2. Decodes each candidate row's packed `Float32Array` embedding (`BINARY(N)`,
 *    `VARBINARY(N)`, `OCTETS`, `BLOB`, or bracketed text).
 * 3. Computes exact `distance` and `similarity` using the chosen metric
 *    (`'cosine'`, `'l2'`, or `'dot'`), applies optional `maxDistance` /
 *    `minSimilarity` cutoffs, and returns the top `limit` rows sorted by
 *    ascending distance.
 */
export async function vectorSearch<T extends Row = Row>(
  db: VectorDatabaseExecutor,
  options: VectorSearchOptions,
): Promise<Array<VectorSearchRow<T>>> {
  const tableIdent = quoteSqlIdentifier(options.table, 'table name');
  const colIdent = quoteSqlIdentifier(options.column, 'vector column name');
  const rawColName = options.column.trim().replace(/^"|"$/g, '');
  const queryVec = decodeVector(options.query);
  const metric: VectorDistanceMetric = options.metric ?? 'cosine';
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`vectorSearch limit must be a positive integer (got ${String(limit)})`);
  }

  const distanceCol = options.distanceColumn ?? 'DISTANCE';
  const similarityCol = options.similarityColumn ?? 'SIMILARITY';
  const includeVector = options.includeVector === true;

  let selectClause = '*';
  if (Array.isArray(options.select) && options.select.length > 0) {
    const requested = [...options.select];
    const hasVecCol = requested.some(
      (s) =>
        s.trim() === '*' ||
        s.trim().replace(/^"|"$/g, '').toUpperCase() === rawColName.toUpperCase(),
    );
    if (!hasVecCol) {
      requested.push(colIdent);
    }
    selectClause = requested.join(', ');
  }

  const whereClause = options.where?.trim()
    ? ` WHERE (${options.where.trim()}) AND ${colIdent} IS NOT NULL`
    : ` WHERE ${colIdent} IS NOT NULL`;

  const sql = `SELECT ${selectClause} FROM ${tableIdent}${whereClause}`;
  const res = await db.query<Record<string, unknown>>(sql, options.params ?? []);

  const scored: Array<VectorSearchRow<T>> = [];

  for (const row of res.rows) {
    const found = getRowCaseInsensitive(row, rawColName);
    if (!found || found.value === null || found.value === undefined) {
      continue;
    }

    const rowVec = decodeVector(found.value);
    let distance: number;
    let similarity: number;

    if (metric === 'cosine') {
      distance = cosineDistance(queryVec, rowVec);
      similarity = 1 - distance;
    } else if (metric === 'l2') {
      distance = l2Distance(queryVec, rowVec);
      similarity = 1 / (1 + distance);
    } else {
      const dot = dotProduct(queryVec, rowVec);
      distance = Object.is(-dot, -0) ? 0 : -dot;
      similarity = dot;
    }

    if (options.maxDistance !== undefined && distance > options.maxDistance) {
      continue;
    }
    if (options.minSimilarity !== undefined && similarity < options.minSimilarity) {
      continue;
    }

    const outRow: Record<string, unknown> = { ...row };
    if (!includeVector) {
      delete outRow[found.key];
    }
    outRow[distanceCol] = distance;
    outRow[similarityCol] = similarity;
    scored.push(outRow as VectorSearchRow<T>);
  }

  scored.sort(
    (a, b) =>
      (a[distanceCol] as number) - (b[distanceCol] as number),
  );

  return scored.slice(0, limit);
}
