/**
 * params.test.ts – the packed parameter buffer, byte for byte.
 *
 * The layout is a contract with wasm/fb_wasm_api.cpp's parseParams, so it is
 * asserted here rather than only exercised: a change on one side that the
 * other does not know about would otherwise show up as a wrong value bound
 * somewhere far from the cause.
 */

import {
  encodeParams,
  encodeParamRows,
  binaryParamForm,
  BINARY_INT64,
  BINARY_DOUBLE,
} from '../browser/params';

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('encodeParams', () => {
  it('lays a text-only parameter out as count, flags, length, bytes', () => {
    const out = encodeParams(['ab']);
    const v = view(out);
    expect(v.getUint32(0, true)).toBe(1);
    expect(out[4]).toBe(0); // not null, no binary form
    expect(v.getUint32(5, true)).toBe(2);
    expect(Array.from(out.subarray(9, 11))).toEqual([0x61, 0x62]);
    expect(out.length).toBe(11);
  });

  it('marks SQL NULL with bit 0 and nothing else', () => {
    const out = encodeParams([null, undefined]);
    expect(Array.from(out)).toEqual([2, 0, 0, 0, 1, 1]);
  });

  it('sends a safe integer as its text and an INT64', () => {
    const out = encodeParams([7]);
    const v = view(out);
    expect(out[4]).toBe(2); // binary form follows the text
    expect(v.getUint32(5, true)).toBe(1);
    expect(out[9]).toBe(0x37); // '7'
    expect(out[10]).toBe(BINARY_INT64);
    expect(v.getBigInt64(11, true)).toBe(7n);
    expect(out.length).toBe(19);
  });

  it('sends any other number as its text and a DOUBLE, bit for bit', () => {
    // 2^53 is past Number.isSafeInteger: a double, not an INT64
    const values = [0.1, -1.5e300, 2 ** 53];
    const out = encodeParams(values);
    const v = view(out);
    let pos = 4;
    for (const value of values) {
      expect(out[pos]).toBe(2); // binary form follows the text
      const len = v.getUint32(pos + 1, true);
      const text = new TextDecoder().decode(out.subarray(pos + 5, pos + 5 + len));
      expect(text).toBe(String(value));
      pos += 5 + len;
      expect(out[pos]).toBe(BINARY_DOUBLE);
      expect(v.getFloat64(pos + 1, true)).toBe(value);
      pos += 9;
    }
    expect(pos).toBe(out.length);
  });

  it('sends a bigint within INT64 as an INT64, beyond it as text only', () => {
    const inRange = encodeParams([-(2n ** 63n)]);
    expect(inRange[inRange.length - 9]).toBe(BINARY_INT64);
    expect(view(inRange).getBigInt64(inRange.length - 8, true)).toBe(-(2n ** 63n));

    const beyond = encodeParams([2n ** 63n]);
    expect(beyond[4]).toBe(0);
    expect(beyond.length).toBe(4 + 1 + 4 + '9223372036854775808'.length);
  });

  it('keeps booleans, dates and strings as text alone', () => {
    const out = encodeParams([true, new Date(Date.UTC(2026, 0, 2)), 'x']);
    const v = view(out);
    let pos = 4;
    for (let i = 0; i < 3; i++) {
      expect(out[pos]).toBe(0);
      pos += 1 + 4 + v.getUint32(pos + 1, true);
    }
    expect(pos).toBe(out.length);
  });

  it('refuses what has no SQL text form', () => {
    expect(() => encodeParams([NaN])).toThrow(RangeError);
    expect(() => encodeParams([new Uint8Array(2)])).toThrow(TypeError);
    expect(() => encodeParams([{}])).toThrow(TypeError);
  });
});

describe('binaryParamForm', () => {
  it('classifies as the encoder does', () => {
    expect(binaryParamForm(3)).toEqual({ kind: BINARY_INT64, value: 3n });
    expect(binaryParamForm(3.5)).toEqual({ kind: BINARY_DOUBLE, value: 3.5 });
    expect(binaryParamForm(Infinity)).toBeNull();
    expect(binaryParamForm(5n)).toEqual({ kind: BINARY_INT64, value: 5n });
    expect(binaryParamForm(2n ** 64n)).toBeNull();
    expect(binaryParamForm('3')).toBeNull();
  });
});

describe('encodeParamRows', () => {
  it('is a row count followed by each row as encodeParams lays it out', () => {
    const rows = [[1, 'a'], [null, 'b']];
    const out = encodeParamRows(rows);
    const v = view(out);
    expect(v.getUint32(0, true)).toBe(2);
    const one = encodeParams(rows[0]);
    const two = encodeParams(rows[1]);
    expect(Array.from(out.subarray(4, 4 + one.length))).toEqual(Array.from(one));
    expect(Array.from(out.subarray(4 + one.length))).toEqual(Array.from(two));
  });

  it('allows an empty batch and refuses a row that is not an array', () => {
    expect(Array.from(encodeParamRows([]))).toEqual([0, 0, 0, 0]);
    expect(() => encodeParamRows([5 as unknown as unknown[]])).toThrow(TypeError);
  });
});
