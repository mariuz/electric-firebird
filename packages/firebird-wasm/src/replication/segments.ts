/**
 * Firebird 4.0 / 5.0 Binary & Encrypted/Compressed Replication Journal Segments.
 */

import {
  NATIVE_REPL_PROTOCOL_VERSION,
  NATIVE_REPL_SEGMENT_MAGIC,
  type ReplicationLogEntry,
  type ReplicationOperation,
} from './types';
import { gunzipBytes, gzipBytes } from './shared';

// ---------------------------------------------------------------------------
// 5. Firebird 4.0 / 5.0 Native `fb_replication` Binary Journal Segment Bridge (M12 Item 8)
// ---------------------------------------------------------------------------

/** Header of a Firebird 4.0 / 5.0 binary replication journal segment. */
export interface NativeJournalSegmentHeader {
  /** Magic signature (`NATIVE_REPL_SEGMENT_MAGIC = 0x52444246`). */
  readonly magic: number;
  /** Replication protocol version (`NATIVE_REPL_PROTOCOL_VERSION = 2`). */
  readonly version: number;
  /** Segment lifecycle state (`'active'`, `'full'`, or `'archivable'`). */
  readonly state: 'active' | 'full' | 'archivable';
  /** Database replication GUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). */
  readonly guid: string;
  /** Monotonic journal file sequence number. */
  readonly sequence: number;
  /** First LSN contained in this segment (`0` if empty). */
  readonly startLsn: number;
  /** Last LSN contained in this segment (`0` if empty). */
  readonly endLsn: number;
  /** Number of logical change entries encoded in this segment. */
  readonly entryCount: number;
  /** Payload byte length following the 64-byte header. */
  readonly payloadBytes: number;
  /** 32-bit FNV-1a integrity checksum of the binary payload. */
  readonly checksum: number;
}

/** Decoded Firebird 4.0 / 5.0 binary replication journal segment. */
export interface NativeJournalSegment {
  readonly header: NativeJournalSegmentHeader;
  readonly entries: ReplicationLogEntry[];
}

function fnv1aBytes32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function guidToBytes16(guid: string): Uint8Array {
  const hex = guid.replace(/[^0-9a-fA-F]/g, '').padEnd(32, '0').slice(0, 32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function bytes16ToGuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const OP_CODE_TO_ENUM: Record<number, ReplicationOperation> = {
  1: 'INSERT',
  2: 'UPDATE',
  3: 'DELETE',
  4: 'DDL',
};

const ENUM_TO_OP_CODE: Record<ReplicationOperation, number> = {
  INSERT: 1,
  UPDATE: 2,
  DELETE: 3,
  DDL: 4,
};

/**
 * Encode a batch of {@link ReplicationLogEntry} items into a Firebird 4.0 / 5.0
 * compatible binary journal segment (`64-byte header + binary operation blocks`
 * with FNV-1a payload integrity verification).
 */
export function encodeNativeJournalSegment(
  entries: readonly ReplicationLogEntry[],
  options: {
    guid?: string;
    sequence?: number;
    state?: 'active' | 'full' | 'archivable';
  } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const stateCode =
    options.state === 'full' ? 1 : options.state === 'archivable' ? 2 : 0;
  const guidStr = options.guid ?? '00000000-0000-4000-8000-000000000001';
  const sequence = Math.max(0, Math.trunc(options.sequence ?? 1));

  let startLsn = 0;
  let endLsn = 0;
  for (const e of entries) {
    if (startLsn === 0 || e.lsn < startLsn) startLsn = e.lsn;
    if (e.lsn > endLsn) endLsn = e.lsn;
  }

  // Encode each entry as a binary block:
  // [opCode: u8, flags: u8, reserved: u16, lsn: u64, ts: u64, frameLen: u32, jsonBytes: frameLen]
  const blocks: Uint8Array[] = [];
  let totalPayloadBytes = 0;

  for (const entry of entries) {
    const jsonBytes = encoder.encode(
      JSON.stringify({
        txid: entry.txid,
        origin: entry.origin,
        publication: entry.publication,
        table: entry.table,
        key: entry.key,
        after: entry.after,
        before: entry.before,
        ddlSql: entry.ddlSql ?? null,
        hlc: entry.hlc,
      }),
    );
    const block = new Uint8Array(24 + jsonBytes.byteLength);
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    dv.setUint8(0, ENUM_TO_OP_CODE[entry.operation] ?? 1);
    dv.setUint8(1, entry.hlc ? 1 : 0);
    dv.setUint16(2, 0, true);
    dv.setBigUint64(4, BigInt(Math.max(0, Math.trunc(entry.lsn))), true);
    dv.setBigUint64(12, BigInt(Math.max(0, Math.trunc(entry.timestamp))), true);
    dv.setUint32(20, jsonBytes.byteLength, true);
    block.set(jsonBytes, 24);
    blocks.push(block);
    totalPayloadBytes += block.byteLength;
  }

  const payload = new Uint8Array(totalPayloadBytes);
  let offset = 0;
  for (const b of blocks) {
    payload.set(b, offset);
    offset += b.byteLength;
  }

  const checksum = fnv1aBytes32(payload);
  const segment = new Uint8Array(64 + totalPayloadBytes);
  const hdrView = new DataView(segment.buffer, segment.byteOffset, 64);

  hdrView.setUint32(0, NATIVE_REPL_SEGMENT_MAGIC, true);
  hdrView.setUint16(4, NATIVE_REPL_PROTOCOL_VERSION, true);
  hdrView.setUint16(6, stateCode, true);
  segment.set(guidToBytes16(guidStr), 8);
  hdrView.setBigUint64(24, BigInt(sequence), true);
  hdrView.setBigUint64(32, BigInt(startLsn), true);
  hdrView.setBigUint64(40, BigInt(endLsn), true);
  hdrView.setUint32(48, entries.length, true);
  hdrView.setUint32(52, totalPayloadBytes, true);
  hdrView.setUint32(56, checksum, true);
  hdrView.setUint32(60, 0, true);

  segment.set(payload, 64);
  return segment;
}

/**
 * Parse and validate a Firebird 4.0 / 5.0 binary replication journal segment
 * encoded by {@link encodeNativeJournalSegment}.
 */
export function decodeNativeJournalSegment(
  bytes: Uint8Array,
): NativeJournalSegment {
  if (bytes.byteLength < 64) {
    throw new Error(
      `Invalid native replication journal segment: expected at least 64 bytes, got ${bytes.byteLength}`,
    );
  }

  const hdrView = new DataView(bytes.buffer, bytes.byteOffset, 64);
  const magic = hdrView.getUint32(0, true);
  if (magic !== NATIVE_REPL_SEGMENT_MAGIC) {
    throw new Error(
      `Invalid native replication journal segment magic: 0x${magic.toString(16)}`,
    );
  }

  const version = hdrView.getUint16(4, true);
  if (version !== NATIVE_REPL_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported native replication protocol version: ${version}`,
    );
  }

  const stateCode = hdrView.getUint16(6, true);
  const state: 'active' | 'full' | 'archivable' =
    stateCode === 1 ? 'full' : stateCode === 2 ? 'archivable' : 'active';
  const guid = bytes16ToGuid(bytes.subarray(8, 24));
  const sequence = Number(hdrView.getBigUint64(24, true));
  const startLsn = Number(hdrView.getBigUint64(32, true));
  const endLsn = Number(hdrView.getBigUint64(40, true));
  const entryCount = hdrView.getUint32(48, true);
  const payloadBytes = hdrView.getUint32(52, true);
  const checksum = hdrView.getUint32(56, true);

  if (bytes.byteLength < 64 + payloadBytes) {
    throw new Error(
      `Truncated native replication journal segment: expected ${64 + payloadBytes} bytes, got ${bytes.byteLength}`,
    );
  }

  const payload = bytes.subarray(64, 64 + payloadBytes);
  const actualChecksum = fnv1aBytes32(payload);
  if (actualChecksum !== checksum) {
    throw new Error(
      `Native replication journal segment checksum mismatch: expected 0x${checksum.toString(16)}, got 0x${actualChecksum.toString(16)}`,
    );
  }

  const decoder = new TextDecoder();
  const entries: ReplicationLogEntry[] = [];
  let pos = 0;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 24 > payload.byteLength) {
      throw new Error('Truncated binary block inside native replication journal segment');
    }
    const dv = new DataView(payload.buffer, payload.byteOffset + pos, 24);
    const opCode = dv.getUint8(0);
    const lsn = Number(dv.getBigUint64(4, true));
    const timestamp = Number(dv.getBigUint64(12, true));
    const frameLen = dv.getUint32(20, true);
    pos += 24;

    if (pos + frameLen > payload.byteLength) {
      throw new Error('Truncated JSON frame inside native replication journal segment');
    }
    const meta = JSON.parse(
      decoder.decode(payload.subarray(pos, pos + frameLen)),
    ) as {
      txid: string;
      origin: string;
      publication: string;
      table: string;
      key: Record<string, unknown>;
      after: Record<string, unknown> | null;
      before: Record<string, unknown> | null;
      ddlSql?: string | null;
      hlc?: string;
    };
    pos += frameLen;

    entries.push({
      lsn,
      txid: meta.txid,
      origin: meta.origin,
      publication: meta.publication,
      table: meta.table,
      operation: OP_CODE_TO_ENUM[opCode] ?? 'INSERT',
      key: meta.key ?? {},
      after: meta.after ?? null,
      before: meta.before ?? null,
      ddlSql: meta.ddlSql ?? null,
      timestamp,
      ...(meta.hlc ? { hlc: meta.hlc } : {}),
    });
  }

  return {
    header: {
      magic,
      version,
      state,
      guid,
      sequence,
      startLsn,
      endLsn,
      entryCount,
      payloadBytes,
      checksum,
    },
    entries,
  };
}


// ---------------------------------------------------------------------------
// 7. Encrypted & Compressed Replication Journal Segments (AES-256-GCM + Gzip) (M13 Item 4)
// ---------------------------------------------------------------------------

/**
 * Magic signature for encrypted and/or Gzip-compressed replication journal segments
 * (`'FBDS'` little-endian `0x53444246`).
 */
export const NATIVE_REPL_ENCRYPTED_SEGMENT_MAGIC = 0x53444246;

/** Options for {@link encodeEncryptedJournalSegment}. */
export interface EncryptedJournalSegmentOptions {
  /**
   * Optional encryption key:
   * - 32-byte `Uint8Array` raw AES-256 key
   * - WebCrypto `CryptoKey` (`AES-GCM`)
   * - Passphrase `string` (derived via PBKDF2-HMAC-SHA256 with a 16-byte salt)
   */
  key?: Uint8Array | CryptoKey | string;
  /**
   * When `true` (the default), compresses the inner binary journal segment with
   * Gzip (`CompressionStream('gzip')`) prior to encryption.
   *
   * @default true
   */
  compress?: boolean;
  /** Optional explicit 12-byte AES-GCM initialization vector (generated randomly if omitted). */
  iv?: Uint8Array;
  /** Optional explicit 16-byte PBKDF2 salt when `key` is a passphrase string. */
  salt?: Uint8Array;
  /** Optional Additional Authenticated Data (AAD) bound to the AES-256-GCM authentication tag. */
  aad?: Uint8Array | string;
  /** Segment database replication GUID. */
  guid?: string;
  /** Monotonic journal segment sequence number. */
  sequence?: number;
  /** Segment lifecycle state. */
  state?: 'active' | 'full' | 'archivable';
}

/** Options for {@link decodeEncryptedJournalSegment}. */
export interface DecodeEncryptedJournalSegmentOptions {
  /** Decryption key (32-byte `Uint8Array`, WebCrypto `CryptoKey`, or passphrase `string`). */
  key?: Uint8Array | CryptoKey | string;
  /** Additional Authenticated Data (AAD) expected by AES-256-GCM. */
  aad?: Uint8Array | string;
}

/** Result returned by {@link decodeEncryptedJournalSegment}. */
export interface DecodedEncryptedJournalSegment {
  /** Decoded inner native journal segment (`header` + `entries`). */
  readonly segment: NativeJournalSegment;
  /** Whether the segment payload was Gzip-compressed on the wire. */
  readonly compressed: boolean;
  /** Whether the segment payload was encrypted with AES-256-GCM on the wire. */
  readonly encrypted: boolean;
  /** Uncompressed inner binary segment byte size. */
  readonly uncompressedBytes: number;
  /** Total wire envelope byte size. */
  readonly wireBytes: number;
}


async function resolveAesGcmCryptoKey(
  keyInput: Uint8Array | CryptoKey | string,
  salt: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto (crypto.subtle) is required for AES-256-GCM journal encryption');
  }
  if (typeof keyInput === 'string') {
    const enc = new TextEncoder();
    const baseKey = await subtle.importKey(
      'raw',
      enc.encode(keyInput),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new Uint8Array(salt),
        iterations: 100_000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage],
    );
  }
  if (keyInput instanceof Uint8Array) {
    if (keyInput.byteLength !== 32) {
      throw new Error(
        `Invalid AES-256-GCM key length: expected 32 bytes, got ${keyInput.byteLength}`,
      );
    }
    return subtle.importKey(
      'raw',
      new Uint8Array(keyInput),
      { name: 'AES-GCM', length: 256 },
      false,
      [usage],
    );
  }
  return keyInput;
}

/**
 * Encode a batch of {@link ReplicationLogEntry} items into an optionally
 * Gzip-compressed and WebCrypto AES-256-GCM encrypted binary journal segment
 * (`0x53444246` `'FBDS'` envelope).
 */
export async function encodeEncryptedJournalSegment(
  entries: readonly ReplicationLogEntry[],
  options: EncryptedJournalSegmentOptions = {},
): Promise<Uint8Array> {
  const rawSegment = encodeNativeJournalSegment(entries, {
    guid: options.guid,
    sequence: options.sequence,
    state: options.state,
  });
  const uncompressedBytes = rawSegment.byteLength;
  const shouldCompress = options.compress !== false;
  const shouldEncrypt = options.key !== undefined;
  const isPassphrase = typeof options.key === 'string';

  let payload: Uint8Array = shouldCompress
    ? await gzipBytes(rawSegment)
    : rawSegment;

  const iv =
    options.iv && options.iv.byteLength === 12
      ? new Uint8Array(options.iv)
      : shouldEncrypt
        ? globalThis.crypto.getRandomValues(new Uint8Array(12))
        : new Uint8Array(12);

  const salt =
    options.salt && options.salt.byteLength === 16
      ? new Uint8Array(options.salt)
      : isPassphrase
        ? globalThis.crypto.getRandomValues(new Uint8Array(16))
        : new Uint8Array(16);

  if (shouldEncrypt && options.key !== undefined) {
    const cryptoKey = await resolveAesGcmCryptoKey(options.key, salt, 'encrypt');
    const aadBytes =
      typeof options.aad === 'string'
        ? new TextEncoder().encode(options.aad)
        : options.aad;
    const encryptedBuf = await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        ...(aadBytes ? { additionalData: new Uint8Array(aadBytes) } : {}),
      },
      cryptoKey,
      new Uint8Array(payload),
    );
    payload = new Uint8Array(encryptedBuf);
  }

  let flags = 0;
  if (shouldCompress) flags |= 1;
  if (shouldEncrypt) flags |= 2;
  if (isPassphrase) flags |= 4;

  // 40-byte envelope header:
  // [0..4]   magic (0x53444246 'FBDS')
  // [4..6]   version (1)
  // [6..8]   flags (bit0=gzip, bit1=aes-256-gcm, bit2=pbkdf2-passphrase)
  // [8..20]  12-byte AES-GCM IV
  // [20..36] 16-byte PBKDF2 salt
  // [36..40] uncompressedBytes (u32)
  const out = new Uint8Array(40 + payload.byteLength);
  const dv = new DataView(out.buffer, out.byteOffset, 40);
  dv.setUint32(0, NATIVE_REPL_ENCRYPTED_SEGMENT_MAGIC, true);
  dv.setUint16(4, 1, true);
  dv.setUint16(6, flags, true);
  out.set(iv, 8);
  out.set(salt, 20);
  dv.setUint32(36, uncompressedBytes, true);
  out.set(payload, 40);
  return out;
}

/**
 * Decode and verify an encrypted and/or Gzip-compressed replication journal
 * segment (`0x53444246` `'FBDS'`), or transparently decode an unencrypted
 * native segment (`0x52444246` `'FBDR'`).
 */
export async function decodeEncryptedJournalSegment(
  wireBytes: Uint8Array,
  options: DecodeEncryptedJournalSegmentOptions = {},
): Promise<DecodedEncryptedJournalSegment> {
  if (wireBytes.byteLength >= 4) {
    const peekMagic = new DataView(
      wireBytes.buffer,
      wireBytes.byteOffset,
      4,
    ).getUint32(0, true);
    if (peekMagic === NATIVE_REPL_SEGMENT_MAGIC) {
      const segment = decodeNativeJournalSegment(wireBytes);
      return {
        segment,
        compressed: false,
        encrypted: false,
        uncompressedBytes: wireBytes.byteLength,
        wireBytes: wireBytes.byteLength,
      };
    }
  }

  if (wireBytes.byteLength < 40) {
    throw new Error(
      `Invalid encrypted replication journal segment: expected at least 40 bytes, got ${wireBytes.byteLength}`,
    );
  }

  const dv = new DataView(wireBytes.buffer, wireBytes.byteOffset, 40);
  const magic = dv.getUint32(0, true);
  if (magic !== NATIVE_REPL_ENCRYPTED_SEGMENT_MAGIC) {
    throw new Error(
      `Invalid encrypted replication journal segment magic: 0x${magic.toString(16)}`,
    );
  }
  const version = dv.getUint16(4, true);
  if (version !== 1) {
    throw new Error(
      `Unsupported encrypted replication segment version: ${version}`,
    );
  }
  const flags = dv.getUint16(6, true);
  const compressed = (flags & 1) !== 0;
  const encrypted = (flags & 2) !== 0;
  const iv = wireBytes.subarray(8, 20);
  const salt = wireBytes.subarray(20, 36);
  const uncompressedBytes = dv.getUint32(36, true);
  let payload: Uint8Array = wireBytes.subarray(40);

  if (encrypted) {
    if (options.key === undefined) {
      throw new Error(
        'Cannot decode encrypted replication journal segment: missing decryption key',
      );
    }
    const cryptoKey = await resolveAesGcmCryptoKey(options.key, salt, 'decrypt');
    const aadBytes =
      typeof options.aad === 'string'
        ? new TextEncoder().encode(options.aad)
        : options.aad;
    try {
      const plainBuf = await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(iv),
          ...(aadBytes ? { additionalData: new Uint8Array(aadBytes) } : {}),
        },
        cryptoKey,
        new Uint8Array(payload),
      );
      payload = new Uint8Array(plainBuf);
    } catch {
      throw new Error(
        'Failed to decrypt replication journal segment: invalid key, corrupted ciphertext, or AAD mismatch',
      );
    }
  }

  if (compressed) {
    payload = await gunzipBytes(payload);
  }

  const segment = decodeNativeJournalSegment(payload);
  return {
    segment,
    compressed,
    encrypted,
    uncompressedBytes,
    wireBytes: wireBytes.byteLength,
  };
}

