/**
 * encrypted-backup.ts – Authenticated Encrypted `.fbkp` Backup Archives,
 * Per-Block SHA-256 Merkle Manifest, Incremental Page-Diff Chains &
 * `FB_AUDIT_LOG$` Attestation (`M27 Item 4`).
 *
 * Container binary layout:
 *   - Bytes 0..7   : Magic `"FBKP\x01\x00\x00\x00"` (8 bytes)
 *   - Bytes 8..11  : `headerByteLength` (uint32 little-endian)
 *   - Bytes 12..H  : UTF-8 JSON `BackupArchiveHeader`
 *   - Remaining    : Concatenated `[uint32 chunkCipherLen][12B IV][ciphertext+16B GCM tag]` blocks
 */

import { applyPageDiff, exportPageDiff } from './browser/snapshots';
import { gunzipBytes, gzipBytes } from './replication/shared';
import {
  computeAuditMerkleRoot,
  verifyAuditChain,
  type AuditDatabaseExecutor,
} from './audit-log';
import { sha256HexSync } from './rag-ingester';

export const FBKP_ARCHIVE_MAGIC = new Uint8Array([
  0x46, 0x42, 0x4b, 0x50, 0x01, 0x00, 0x00, 0x00,
]); // "FBKP\x01\0\0\0"

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

export type BackupKeyMaterial = string | Uint8Array | CryptoKey;

/** Audit chain checkpoint embedded inside `.fbkp` archive headers (`M27 Item 4`). */
export interface BackupAuditAttestation {
  readonly valid: boolean;
  readonly checkedCount: number;
  readonly headHash: string | null;
  readonly merkleRoot: string | null;
}

/** Cleartext metadata header authenticated via AES-256-GCM AAD (`M27 Item 4`). */
export interface BackupArchiveHeader {
  readonly formatVersion: 1;
  readonly backupId: string;
  readonly createdAt: number;
  readonly kind: 'full' | 'incremental';
  readonly baseBackupId: string | null;
  readonly compression: 'gzip' | 'none';
  readonly kdf: 'PBKDF2-SHA256' | 'HKDF-SHA256' | 'RAW-CRYPTOKEY';
  readonly kdfIterations: number;
  readonly saltHex: string;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly uncompressedBytes: number;
  readonly chunkHashes: readonly string[];
  readonly manifestMerkleRoot: string | null;
  readonly auditAttestation: BackupAuditAttestation | null;
}

/** Minimal database source accepted by {@link createEncryptedBackup} (`M27 Item 4`). */
export interface BackupSourceDatabase extends Partial<AuditDatabaseExecutor> {
  dumpDataDir(): Promise<Uint8Array>;
}

/** Minimal database target accepted by {@link restoreEncryptedBackup} (`M27 Item 4`). */
export interface BackupTargetDatabase extends Partial<AuditDatabaseExecutor> {
  restoreSnapshot(bytes: Uint8Array): Promise<void>;
}

/** Options for {@link createEncryptedBackup} (`M27 Item 4`). */
export interface CreateEncryptedBackupOptions {
  /** Passphrase string (PBKDF2-SHA256), raw `Uint8Array` secret (HKDF-SHA256), or `CryptoKey`. */
  key: BackupKeyMaterial;
  /** Custom backup identifier (auto-generated when omitted). */
  backupId?: string;
  /** Optional prior `.fdb` image for creating an incremental `"FBDF\x01"` page-diff backup. */
  baseImage?: Uint8Array | null;
  /** Identifier of the parent backup when `baseImage` is supplied. */
  baseBackupId?: string | null;
  /** Compress payload with gzip before AES-256-GCM encryption. @default true */
  compress?: boolean;
  /** Plaintext slice size per authenticated GCM block in bytes. @default 65536 */
  chunkSize?: number;
  /** PBKDF2 iteration count when `key` is a passphrase string. @default 100000 */
  pbkdf2Iterations?: number;
  /** Include `FB_AUDIT_LOG$` Merkle root attestation when `db.query` is available. @default true */
  includeAuditAttestation?: boolean;
  /** Page size used when computing incremental page diffs. @default 8192 */
  pageSize?: number;
}

/** Result returned by {@link createEncryptedBackup} (`M27 Item 4`). */
export interface CreatedEncryptedBackup {
  readonly archiveBytes: Uint8Array;
  readonly header: BackupArchiveHeader;
  readonly rawDatabaseBytes: Uint8Array;
}

/** Verification report returned by {@link verifyBackupArchive} (`M27 Item 4`). */
export interface BackupVerificationResult {
  readonly valid: boolean;
  readonly decrypted: boolean;
  readonly header: BackupArchiveHeader | null;
  readonly reason?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isCryptoKey(v: unknown): v is CryptoKey {
  return typeof v === 'object' && v !== null && 'type' in v && 'algorithm' in v;
}

async function deriveAesGcmKey(
  material: BackupKeyMaterial,
  salt: Uint8Array,
  kdf: BackupArchiveHeader['kdf'],
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  if (isCryptoKey(material)) {
    return material;
  }
  const saltBuf = new Uint8Array(salt.byteLength);
  saltBuf.set(salt);

  if (typeof material === 'string' || kdf === 'PBKDF2-SHA256') {
    const rawPass =
      typeof material === 'string' ? utf8Enc.encode(material) : material;
    const passBuf = new Uint8Array(rawPass.byteLength);
    passBuf.set(rawPass);
    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw',
      passBuf.buffer,
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return globalThis.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBuf.buffer,
        iterations: Math.max(1_000, iterations),
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage],
    );
  }

  const rawKey = new Uint8Array(material.byteLength);
  rawKey.set(material);
  const hkdfBase = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey.buffer,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      salt: saltBuf.buffer,
      info: utf8Enc.encode('firebird-wasm:fbkp:v1'),
      hash: 'SHA-256',
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

function buildChunkAad(
  meta: {
    backupId: string;
    kind: 'full' | 'incremental';
    baseBackupId: string | null;
    compression: 'gzip' | 'none';
    uncompressedBytes: number;
    chunkCount: number;
  },
  chunkIndex: number,
): Uint8Array {
  return utf8Enc.encode(
    `fbkp:v1|${meta.backupId}|${meta.kind}|${meta.baseBackupId ?? ''}|${meta.compression}|${meta.uncompressedBytes}|${chunkIndex}/${meta.chunkCount}`,
  );
}

/** Test whether `bytes` starts with the 8-byte `"FBKP\x01\0\0\0"` magic header (`M27 Item 4`). */
export function isEncryptedBackupArchive(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  for (let i = 0; i < FBKP_ARCHIVE_MAGIC.length; i++) {
    if (bytes[i] !== FBKP_ARCHIVE_MAGIC[i]) return false;
  }
  return true;
}

function parseArchiveFrame(archiveBytes: Uint8Array): {
  header: BackupArchiveHeader;
  blocks: Array<{ iv: Uint8Array; ciphertext: Uint8Array }>;
} {
  if (!isEncryptedBackupArchive(archiveBytes)) {
    throw new Error('Invalid .fbkp archive: missing FBKP\\x01 magic header.');
  }
  const dv = new DataView(
    archiveBytes.buffer,
    archiveBytes.byteOffset,
    archiveBytes.byteLength,
  );
  const headerLen = dv.getUint32(8, true);
  if (12 + headerLen > archiveBytes.byteLength) {
    throw new Error('Corrupt .fbkp archive: header length exceeds file size.');
  }
  const headerJson = utf8Dec.decode(archiveBytes.subarray(12, 12 + headerLen));
  const header = JSON.parse(headerJson) as BackupArchiveHeader;

  const blocks: Array<{ iv: Uint8Array; ciphertext: Uint8Array }> = [];
  let offset = 12 + headerLen;
  while (offset < archiveBytes.byteLength) {
    if (offset + 16 > archiveBytes.byteLength) {
      throw new Error('Corrupt .fbkp archive: truncated encrypted chunk header.');
    }
    const cipherLen = dv.getUint32(offset, true);
    offset += 4;
    const iv = archiveBytes.slice(offset, offset + 12);
    offset += 12;
    if (offset + cipherLen > archiveBytes.byteLength) {
      throw new Error('Corrupt .fbkp archive: truncated encrypted chunk payload.');
    }
    const ciphertext = archiveBytes.slice(offset, offset + cipherLen);
    offset += cipherLen;
    blocks.push({ iv, ciphertext });
  }
  return { header, blocks };
}

/**
 * Create an authenticated, gzip-compressed, AES-256-GCM encrypted `.fbkp` backup
 * archive (full or incremental page-diff) with SHA-256 Merkle manifest & optional
 * `FB_AUDIT_LOG$` attestation (`M27 Item 4`).
 */
export async function createEncryptedBackup(
  dbOrBytes: BackupSourceDatabase | Uint8Array,
  options: CreateEncryptedBackupOptions,
): Promise<CreatedEncryptedBackup> {
  const rawDbBytes =
    dbOrBytes instanceof Uint8Array ? dbOrBytes : await dbOrBytes.dumpDataDir();
  const isIncremental = Boolean(options.baseImage && options.baseImage.byteLength > 0);
  const kind: 'full' | 'incremental' = isIncremental ? 'incremental' : 'full';
  const baseBackupId = isIncremental ? (options.baseBackupId ?? 'base') : null;

  const payloadRaw = isIncremental
    ? exportPageDiff(options.baseImage!, rawDbBytes, { pageSize: options.pageSize ?? 8192 })
    : rawDbBytes;

  const compression: 'gzip' | 'none' = options.compress !== false ? 'gzip' : 'none';
  const compressedPayload =
    compression === 'gzip' ? await gzipBytes(payloadRaw) : payloadRaw;

  let auditAttestation: BackupAuditAttestation | null = null;
  if (
    options.includeAuditAttestation !== false &&
    !(dbOrBytes instanceof Uint8Array) &&
    typeof dbOrBytes.query === 'function'
  ) {
    const rep = await verifyAuditChain({ query: dbOrBytes.query.bind(dbOrBytes) });
    auditAttestation = {
      valid: rep.valid,
      checkedCount: rep.checkedCount,
      headHash: rep.headHash,
      merkleRoot: rep.merkleRoot,
    };
  }

  const createdAt = Date.now();
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const backupId =
    options.backupId?.trim() || `fbkp_${createdAt.toString(36)}_${bytesToHex(salt.subarray(0, 4))}`;
  const kdf: BackupArchiveHeader['kdf'] = isCryptoKey(options.key)
    ? 'RAW-CRYPTOKEY'
    : typeof options.key === 'string'
      ? 'PBKDF2-SHA256'
      : 'HKDF-SHA256';
  const kdfIterations = kdf === 'PBKDF2-SHA256' ? (options.pbkdf2Iterations ?? 100_000) : 0;

  const aesKey = await deriveAesGcmKey(options.key, salt, kdf, kdfIterations, 'encrypt');

  const chunkSize = Math.max(1024, options.chunkSize ?? 65_536);
  const chunkCount = Math.max(1, Math.ceil(compressedPayload.byteLength / chunkSize));
  const aadMeta = {
    backupId,
    kind,
    baseBackupId,
    compression,
    uncompressedBytes: payloadRaw.byteLength,
    chunkCount,
  };

  const encryptedBlocks: Array<{ iv: Uint8Array; ciphertext: Uint8Array }> = [];
  const chunkHashes: string[] = [];

  for (let idx = 0; idx < chunkCount; idx++) {
    const slice = compressedPayload.subarray(
      idx * chunkSize,
      Math.min(compressedPayload.byteLength, (idx + 1) * chunkSize),
    );
    const plainCopy = new Uint8Array(slice.byteLength);
    plainCopy.set(slice);

    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    const aad = buildChunkAad(aadMeta, idx);
    const aadBuf = new Uint8Array(aad.byteLength);
    aadBuf.set(aad);

    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadBuf.buffer },
      aesKey,
      plainCopy.buffer,
    );
    const ciphertext = new Uint8Array(cipherBuf);
    encryptedBlocks.push({ iv, ciphertext });
    chunkHashes.push(sha256HexSync(ciphertext));
  }

  const manifestMerkleRoot = await computeAuditMerkleRoot(chunkHashes);
  const header: BackupArchiveHeader = {
    formatVersion: 1,
    backupId,
    createdAt,
    kind,
    baseBackupId,
    compression,
    kdf,
    kdfIterations,
    saltHex: bytesToHex(salt),
    chunkSize,
    chunkCount,
    uncompressedBytes: payloadRaw.byteLength,
    chunkHashes,
    manifestMerkleRoot,
    auditAttestation,
  };

  const headerBytes = utf8Enc.encode(JSON.stringify(header));
  let totalSize = 12 + headerBytes.byteLength;
  for (const b of encryptedBlocks) {
    totalSize += 4 + 12 + b.ciphertext.byteLength;
  }

  const archiveBytes = new Uint8Array(totalSize);
  archiveBytes.set(FBKP_ARCHIVE_MAGIC, 0);
  const dv = new DataView(archiveBytes.buffer);
  dv.setUint32(8, headerBytes.byteLength, true);
  archiveBytes.set(headerBytes, 12);

  let pos = 12 + headerBytes.byteLength;
  for (const b of encryptedBlocks) {
    dv.setUint32(pos, b.ciphertext.byteLength, true);
    pos += 4;
    archiveBytes.set(b.iv, pos);
    pos += 12;
    archiveBytes.set(b.ciphertext, pos);
    pos += b.ciphertext.byteLength;
  }

  return {
    archiveBytes,
    header,
    rawDatabaseBytes: rawDbBytes,
  };
}

/**
 * Verify a `.fbkp` archive's magic header, per-chunk SHA-256 digests, Merkle root,
 * and (when `options.key` is provided) full AES-256-GCM decryption integrity (`M27 Item 4`).
 */
export async function verifyBackupArchive(
  archiveBytes: Uint8Array,
  options: { key?: BackupKeyMaterial } = {},
): Promise<BackupVerificationResult> {
  try {
    const { header, blocks } = parseArchiveFrame(archiveBytes);
    if (blocks.length !== header.chunkCount || header.chunkHashes.length !== header.chunkCount) {
      return {
        valid: false,
        decrypted: false,
        header,
        reason: `Chunk count mismatch: header expects ${header.chunkCount}, found ${blocks.length}`,
      };
    }

    const actualHashes: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const digest = sha256HexSync(blocks[i]!.ciphertext);
      if (digest !== header.chunkHashes[i]) {
        return {
          valid: false,
          decrypted: false,
          header,
          reason: `SHA-256 chunk hash mismatch at block #${i}`,
        };
      }
      actualHashes.push(digest);
    }

    const recomputedMerkle = await computeAuditMerkleRoot(actualHashes);
    if (recomputedMerkle !== header.manifestMerkleRoot) {
      return {
        valid: false,
        decrypted: false,
        header,
        reason: `Manifest Merkle root mismatch: expected ${header.manifestMerkleRoot}, got ${recomputedMerkle}`,
      };
    }

    if (options.key !== undefined) {
      const salt = hexToBytes(header.saltHex);
      const aesKey = await deriveAesGcmKey(
        options.key,
        salt,
        header.kdf,
        header.kdfIterations,
        'decrypt',
      );
      const aadMeta = {
        backupId: header.backupId,
        kind: header.kind,
        baseBackupId: header.baseBackupId,
        compression: header.compression,
        uncompressedBytes: header.uncompressedBytes,
        chunkCount: header.chunkCount,
      };
      for (let i = 0; i < blocks.length; i++) {
        const blk = blocks[i]!;
        const ivBuf = new Uint8Array(blk.iv.byteLength);
        ivBuf.set(blk.iv);
        const cipherBuf = new Uint8Array(blk.ciphertext.byteLength);
        cipherBuf.set(blk.ciphertext);
        const aad = buildChunkAad(aadMeta, i);
        const aadBuf = new Uint8Array(aad.byteLength);
        aadBuf.set(aad);
        await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivBuf.buffer, additionalData: aadBuf.buffer },
          aesKey,
          cipherBuf.buffer,
        );
      }
      return { valid: true, decrypted: true, header };
    }

    return { valid: true, decrypted: false, header };
  } catch (err) {
    return {
      valid: false,
      decrypted: false,
      header: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Decrypt, verify, decompress, and restore a `.fbkp` backup archive (full or
 * incremental page-diff) into `targetDb` or return the restored `.fdb` bytes (`M27 Item 4`).
 */
export async function restoreEncryptedBackup(
  archiveBytes: Uint8Array,
  targetDb: BackupTargetDatabase | null | undefined,
  options: {
    key: BackupKeyMaterial;
    baseImage?: Uint8Array | null;
    verifyAuditAfterRestore?: boolean;
  },
): Promise<{
  databaseBytes: Uint8Array;
  header: BackupArchiveHeader;
  auditVerified: boolean;
}> {
  const { header, blocks } = parseArchiveFrame(archiveBytes);
  const check = await verifyBackupArchive(archiveBytes);
  if (!check.valid) {
    throw new Error(`Backup archive integrity check failed: ${check.reason}`);
  }
  if (header.kind === 'incremental' && (!options.baseImage || options.baseImage.byteLength === 0)) {
    throw new Error(
      `Backup "${header.backupId}" is an incremental diff (base="${header.baseBackupId}") and requires options.baseImage.`,
    );
  }

  const salt = hexToBytes(header.saltHex);
  const aesKey = await deriveAesGcmKey(
    options.key,
    salt,
    header.kdf,
    header.kdfIterations,
    'decrypt',
  );
  const aadMeta = {
    backupId: header.backupId,
    kind: header.kind,
    baseBackupId: header.baseBackupId,
    compression: header.compression,
    uncompressedBytes: header.uncompressedBytes,
    chunkCount: header.chunkCount,
  };

  const plainChunks: Uint8Array[] = [];
  let totalCompressedLen = 0;
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i]!;
    const ivBuf = new Uint8Array(blk.iv.byteLength);
    ivBuf.set(blk.iv);
    const cipherBuf = new Uint8Array(blk.ciphertext.byteLength);
    cipherBuf.set(blk.ciphertext);
    const aad = buildChunkAad(aadMeta, i);
    const aadBuf = new Uint8Array(aad.byteLength);
    aadBuf.set(aad);

    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBuf.buffer, additionalData: aadBuf.buffer },
        aesKey,
        cipherBuf.buffer,
      );
    } catch {
      throw new Error(
        `AES-256-GCM authentication failed on chunk #${i} (invalid key or tampered archive).`,
      );
    }
    const arr = new Uint8Array(plainBuf);
    plainChunks.push(arr);
    totalCompressedLen += arr.byteLength;
  }

  const joinedCompressed = new Uint8Array(totalCompressedLen);
  let writeOff = 0;
  for (const c of plainChunks) {
    joinedCompressed.set(c, writeOff);
    writeOff += c.byteLength;
  }

  const uncompressed =
    header.compression === 'gzip'
      ? await gunzipBytes(joinedCompressed)
      : joinedCompressed;

  const databaseBytes =
    header.kind === 'incremental'
      ? applyPageDiff(options.baseImage!, uncompressed)
      : uncompressed;

  let auditVerified = false;
  if (targetDb) {
    await targetDb.restoreSnapshot(databaseBytes);
    if (options.verifyAuditAfterRestore !== false && typeof targetDb.query === 'function') {
      const rep = await verifyAuditChain({ query: targetDb.query.bind(targetDb) });
      if (!rep.valid) {
        throw new Error(`Post-restore audit chain verification failed: ${rep.reason}`);
      }
      if (
        header.auditAttestation?.merkleRoot &&
        rep.merkleRoot !== header.auditAttestation.merkleRoot
      ) {
        throw new Error(
          `Post-restore audit Merkle root mismatch: expected ${header.auditAttestation.merkleRoot}, got ${rep.merkleRoot}`,
        );
      }
      auditVerified = true;
    }
  }

  return {
    databaseBytes,
    header,
    auditVerified,
  };
}
