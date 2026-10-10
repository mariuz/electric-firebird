/**
 * params.ts – encode query parameters for the WASM engine.
 *
 * Parameters cross the boundary as one packed buffer rather than JSON, so the
 * C side needs no parser and there is no escaping to get wrong:
 *
 *     u32  count
 *     per parameter:
 *       u8   flags         bit 0: SQL NULL; bit 1: a binary form follows the text
 *       u32  byteLength    (absent when NULL)
 *       ...  UTF-8 bytes   (absent when NULL)
 *       u8   kind          (only with bit 1) 1: INT64, 2: DOUBLE
 *       8    the value     (only with bit 1) little-endian
 *
 * Every value is sent as text.  The engine describes the input message as
 * VARCHAR UTF-8 and converts to each column's actual type, which is why one
 * path handles integers, dates and strings alike — the alternative is
 * reimplementing Firebird's conversion rules here and getting them subtly
 * wrong.
 *
 * A number or bigint also travels as the 64-bit value it is, beside its text.
 * The engine uses that form where the column is floating-point or a whole
 * number: no text is parsed, and a double arrives bit for bit (Firebird's
 * text-to-double conversion is off by an ulp for about one value in six).
 * Every other column — NUMERIC and DECIMAL with their exact decimal
 * conversion, VARCHAR, dates — gets the text, so `1.1` into a NUMERIC(18,2)
 * is still 1.10 and into a VARCHAR still '1.1'.
 */

import type { QueryParams } from '../types';

/**
 * Render one parameter the way Firebird's string-to-type conversion expects.
 *
 * @throws if the value has no unambiguous SQL text form.
 */
export function encodeParamValue(value: unknown, index: number): string {
  switch (typeof value) {
    case 'string':
      return value;

    case 'number':
      if (!Number.isFinite(value)) {
        throw new RangeError(
          `Parameter ${index} is ${value}, which SQL has no representation for`,
        );
      }
      return String(value);

    case 'bigint':
      return value.toString();

    case 'boolean':
      // Firebird's BOOLEAN literals.
      return value ? 'TRUE' : 'FALSE';

    default:
      break;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`Parameter ${index} is an invalid Date`);
    }
    // Firebird's TIMESTAMP literal format. toISOString() is always UTC, and
    // its 'T'/'Z' are not accepted, so the pieces are reassembled.
    return value.toISOString().replace('T', ' ').replace('Z', '');
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new TypeError(
      `Parameter ${index} is binary, which the WASM build cannot bind yet — ` +
        'the parameter encoding is text-based (see docs/roadmap.md, M2)',
    );
  }

  throw new TypeError(
    `Parameter ${index} has unsupported type ${
      value === null ? 'null' : typeof value
    }; pass a string, number, bigint, boolean, Date, null or undefined`,
  );
}

/** The binary form of a parameter, when it has one. */
export const BINARY_INT64 = 1;
export const BINARY_DOUBLE = 2;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * A number's or bigint's binary form: a safe integer and a bigint within
 * INT64 go as INT64, any other finite number as DOUBLE.  Anything else — a
 * bigint beyond 64 bits included, which only the text can carry — has none.
 */
export function binaryParamForm(value: unknown): { kind: number; value: bigint | number } | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isSafeInteger(value)
      ? { kind: BINARY_INT64, value: BigInt(value) }
      : { kind: BINARY_DOUBLE, value };
  }
  if (typeof value === 'bigint' && value >= INT64_MIN && value <= INT64_MAX) {
    return { kind: BINARY_INT64, value };
  }
  return null;
}

interface EncodedParam {
  text: Uint8Array | null;
  binary: { kind: number; value: bigint | number } | null;
}

function encodeOne(value: unknown, index: number, encoder: TextEncoder): EncodedParam {
  if (value === null || value === undefined) return { text: null, binary: null };
  return { text: encoder.encode(encodeParamValue(value, index)), binary: binaryParamForm(value) };
}

function sizeOf(p: EncodedParam): number {
  return 1 + (p.text ? 4 + p.text.length : 0) + (p.binary ? 9 : 0);
}

function writeParams(out: Uint8Array, view: DataView, pos: number, encoded: EncodedParam[]): number {
  view.setUint32(pos, encoded.length, true);
  pos += 4;

  for (const p of encoded) {
    out[pos++] = (p.text ? 0 : 1) | (p.binary ? 2 : 0);
    if (p.text) {
      view.setUint32(pos, p.text.length, true);
      pos += 4;
      out.set(p.text, pos);
      pos += p.text.length;
    }
    if (p.binary) {
      out[pos++] = p.binary.kind;
      if (p.binary.kind === BINARY_INT64) view.setBigInt64(pos, p.binary.value as bigint, true);
      else view.setFloat64(pos, p.binary.value as number, true);
      pos += 8;
    }
  }

  return pos;
}

/**
 * Pack parameters into the buffer the C API expects.
 *
 * `null` and `undefined` both become SQL NULL — JavaScript uses them
 * interchangeably for "absent", and rejecting one would be a trap.
 */
export function encodeParams(params: QueryParams): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = params.map((value, index) => encodeOne(value, index, encoder));

  let size = 4;
  for (const p of encoded) size += sizeOf(p);

  const out = new Uint8Array(size);
  writeParams(out, new DataView(out.buffer), 0, encoded);
  return out;
}

/**
 * Pack the parameter sets of a batch: a u32 row count, then each row's
 * parameters exactly as encodeParams lays one set out, back to back.
 */
export function encodeParamRows(rows: QueryParams[]): Uint8Array {
  const encoder = new TextEncoder();
  const encodedRows = rows.map((row, r) => {
    if (!Array.isArray(row)) {
      throw new TypeError(`Row ${r} of the batch is not an array of parameters`);
    }
    return row.map((value, index) => encodeOne(value, index, encoder));
  });

  let size = 4;
  for (const row of encodedRows) {
    size += 4;
    for (const p of row) size += sizeOf(p);
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, encodedRows.length, true);
  let pos = 4;
  for (const row of encodedRows) pos = writeParams(out, view, pos, row);
  return out;
}
