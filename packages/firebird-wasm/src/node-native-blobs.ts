/**
 * node-native-blobs.ts – Native Firebird ISC Value Formatting & Segmented BLOB
 * Stream Helpers for `node-firebird-driver` (`M28 Item 5`).
 */

import { Blob as FbBlob } from 'node-firebird-driver';
import type { Attachment, Statement, Transaction } from 'node-firebird-driver';
import type { BlobStreamOptions, FieldInfo, QueryParams } from './types';
import {
  buildBlobReadableStream,
  resolveBlobColumnIndex,
} from './browser/blob-stream';
import type { StatementCache } from './node-native-batch';

const CS_UNICODE_FSS = 3;
const CS_UTF8 = 4;

/**
 * How many bytes of a `CHAR(n)` buffer represent its `n` characters.
 * Mirrors `charTextLength` in `fb_wasm_api.cpp`.
 */
export function charTextLength(data: Uint8Array, length: number, charSet: number): number {
  const cs = charSet & 0xff;
  const bytesPerChar = cs === CS_UTF8 ? 4 : cs === CS_UNICODE_FSS ? 3 : 1;
  if (bytesPerChar === 1) return length;

  const chars = Math.floor(length / bytesPerChar);
  let pos = 0;
  for (let n = 0; n < chars && pos < length; n++) {
    const c = data[pos]!;
    pos += c < 0x80 ? 1 : (c >> 5) === 0x6 ? 2 : (c >> 4) === 0xe ? 3 : (c >> 3) === 0x1e ? 4 : 1;
  }
  return pos < length ? pos : length;
}

export function decodeText(bytes: Uint8Array, charSet: number, attachment: unknown): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if ((charSet & 0xff) === 0) {
    const noneCharset = (attachment as { charSetForNONE?: string } | undefined)?.charSetForNONE;
    if (noneCharset && noneCharset.toLowerCase() !== 'utf8' && noneCharset.toLowerCase() !== 'utf-8') {
      try {
        return new TextDecoder(noneCharset).decode(bytes);
      } catch {
        // fall through to utf8
      }
    }
  }
  return buf.toString('utf8');
}

/** Firebird `ISC_DATE` (days since 1858-11-17) to `'YYYY-MM-DD'`. */
export function formatDate(iscDate: number): string {
  let nday = (iscDate + 2400001 - 1721119) | 0;
  const century = ((4 * nday - 1) / 146097) | 0;
  nday = (4 * nday - 1 - 146097 * century) | 0;
  let d = (nday / 4) | 0;

  nday = ((4 * d + 3) / 1461) | 0;
  d = (4 * d + 3 - 1461 * nday) | 0;
  d = ((d + 4) / 4) | 0;

  let m = ((5 * d - 3) / 153) | 0;
  d = (5 * d - 3 - 153 * m) | 0;
  d = ((d + 5) / 5) | 0;

  let y = (100 * century + nday) | 0;
  if (m < 10) {
    m += 3;
  } else {
    m -= 9;
    y += 1;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Firebird `ISC_TIME` (1/10000 s since midnight) to `'HH:MM:SS.ffff'`. */
export function formatTime(iscTime: number): string {
  const hours = Math.floor(iscTime / 36_000_000);
  let rem = iscTime % 36_000_000;
  const minutes = Math.floor(rem / 600_000);
  rem %= 600_000;
  const seconds = Math.floor(rem / 10_000);
  const fractions = rem % 10_000;
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}.${String(fractions).padStart(4, '0')}`
  );
}

/** Scaled integer (`NUMERIC` / `DECIMAL`) to exact decimal string. */
export function formatScaledDecimal(value: bigint, scale: number): string {
  if (scale >= 0) {
    return value === 0n ? '0' : `${value}${'0'.repeat(scale)}`;
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const decimals = -scale;
  const padded = digits.length <= decimals ? digits.padStart(decimals + 1, '0') : digits;
  const dot = padded.length - decimals;
  return `${negative ? '-' : ''}${padded.slice(0, dot)}.${padded.slice(dot)}`;
}

export async function readNativeBlobBytes(
  attachment: Attachment,
  transaction: Transaction,
  blob: FbBlob,
): Promise<Buffer> {
  const stream = await attachment.openBlob(transaction, blob);
  try {
    const chunks: Buffer[] = [];
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const n = await stream.read(buffer);
      if (n < 0) break;
      if (n > 0) chunks.push(buffer.subarray(0, n));
    }
    return Buffer.concat(chunks);
  } finally {
    await stream.close().catch(() => undefined);
  }
}

export async function writeNativeBlob(
  stmt: Statement,
  transaction: Transaction,
  bytes: Buffer,
): Promise<unknown> {
  const attachment = (stmt as unknown as { attachment?: Attachment }).attachment;
  if (typeof attachment?.createBlob !== 'function') return bytes;
  const stream = await attachment.createBlob(transaction);
  try {
    await stream.write(bytes);
  } catch (err) {
    await stream.cancel().catch(() => undefined);
    throw err;
  }
  await stream.close();
  return stream.blob;
}

export async function runOpenNativeQueryBlobStream(
  deps: {
    outputFields: (stmt: Statement) => Promise<FieldInfo[]>;
    bindParams: (stmt: Statement, tx: Transaction, given: QueryParams) => Promise<QueryParams>;
  },
  attachment: Attachment,
  transaction: Transaction,
  statements: StatementCache,
  sql: string,
  serializedParams: QueryParams,
  options: BlobStreamOptions,
  ownsTransaction: boolean,
  assertUsable?: () => void,
): Promise<ReadableStream<Uint8Array>> {
  const lease = await statements.acquire(transaction, sql);
  const stmt = lease.stmt;
  let failed = true;
  let cell: unknown;

  try {
    const fields = await deps.outputFields(stmt);
    const colIndex = resolveBlobColumnIndex(
      options.column,
      fields.map((f) => f.name),
    );
    if (fields[colIndex]!.typeName !== 'BLOB') {
      throw new Error(
        `openBlobStream: column "${fields[colIndex]!.name}" is ${fields[colIndex]!.typeName}, not BLOB`,
      );
    }

    const bound = await deps.bindParams(stmt, transaction, serializedParams);
    const rs = await stmt.executeQuery(transaction, bound);
    try {
      const rawRows = (await rs.fetch({ fetchSize: 1 })) as unknown[][];
      if (rawRows.length === 0) {
        throw new Error('openBlobStream: query returned no rows');
      }
      cell = rawRows[0]![colIndex];
    } finally {
      await rs.close().catch(() => undefined);
    }
    failed = false;
  } finally {
    await lease.release(failed);
  }

  if (cell === null || cell === undefined) {
    throw new Error('openBlobStream: BLOB column value is NULL');
  }

  if (
    (cell instanceof FbBlob ||
      (typeof cell === 'object' &&
        !(cell instanceof Uint8Array) &&
        'id' in (cell as Record<string, unknown>))) &&
    typeof attachment.openBlob === 'function'
  ) {
    const stream = await attachment.openBlob(transaction, cell as FbBlob);
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          assertUsable?.();
          const buf = Buffer.alloc(maxBytes);
          const n = await stream.read(buf);
          if (n < 0) return null;
          return new Uint8Array(buf.buffer, buf.byteOffset, n);
        },
        close: async () => {
          await stream.close().catch(() => undefined);
          if (ownsTransaction) {
            await transaction
              .commit()
              .catch(() => transaction.rollback().catch(() => undefined));
          }
        },
      },
      options,
    );
  }

  const bytes = Buffer.isBuffer(cell)
    ? new Uint8Array(cell.buffer, cell.byteOffset, cell.byteLength)
    : cell instanceof Uint8Array
      ? cell
      : typeof cell === 'string'
        ? new TextEncoder().encode(cell)
        : new Uint8Array(0);

  if (ownsTransaction) {
    await transaction
      .commit()
      .catch(() => transaction.rollback().catch(() => undefined));
  }

  let offset = 0;
  return buildBlobReadableStream(
    {
      readSegment: async (maxBytes) => {
        assertUsable?.();
        if (offset >= bytes.byteLength) return null;
        const end = Math.min(offset + maxBytes, bytes.byteLength);
        const slice = bytes.slice(offset, end);
        offset = end;
        return slice;
      },
      close: async () => undefined,
    },
    options,
  );
}
