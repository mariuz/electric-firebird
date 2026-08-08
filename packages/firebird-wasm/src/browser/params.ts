/**
 * params.ts – encode query parameters for the WASM engine.
 *
 * Parameters cross the boundary as one packed buffer rather than JSON, so the
 * C side needs no parser and there is no escaping to get wrong:
 *
 *     u32  count
 *     per parameter:
 *       u8   isNull
 *       u32  byteLength    (absent when isNull)
 *       ...  UTF-8 bytes   (absent when isNull)
 *
 * Every value is sent as text.  The engine describes the input message as
 * VARCHAR UTF-8 and converts to each column's actual type, which is why one
 * path handles integers, dates and strings alike — the alternative is
 * reimplementing Firebird's conversion rules here and getting them subtly
 * wrong.
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

/**
 * Pack parameters into the buffer the C API expects.
 *
 * `null` and `undefined` both become SQL NULL — JavaScript uses them
 * interchangeably for "absent", and rejecting one would be a trap.
 */
export function encodeParams(params: QueryParams): Uint8Array {
  const encoder = new TextEncoder();

  const encoded = params.map((value, index) =>
    value === null || value === undefined
      ? null
      : encoder.encode(encodeParamValue(value, index)),
  );

  let size = 4;
  for (const bytes of encoded) {
    size += 1 + (bytes ? 4 + bytes.length : 0);
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;

  view.setUint32(pos, encoded.length, true);
  pos += 4;

  for (const bytes of encoded) {
    if (!bytes) {
      out[pos++] = 1; // isNull
      continue;
    }
    out[pos++] = 0;
    view.setUint32(pos, bytes.length, true);
    pos += 4;
    out.set(bytes, pos);
    pos += bytes.length;
  }

  return out;
}
