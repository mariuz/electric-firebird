/**
 * page-crypto.ts – WebCrypto AES-256-GCM page-level encryption for
 * `IndexedDBVFS`, `OPFSVFS`, and `FirebirdBrowser`.
 *
 * Each encrypted database page is stored in a self-contained binary envelope:
 *
 *   ┌──────────────┬──────────────┬────────────────────────┬──────────────┐
 *   │ Magic "FBE1" │ 12-byte IV   │ Ciphertext (pageSize)  │ 16-byte Tag  │
 *   │   (4 bytes)  │  (96 bits)   │                        │  (128 bits)  │
 *   └──────────────┴──────────────┴────────────────────────┴──────────────┘
 *
 * Total envelope size: `pageSize + 32` bytes.
 *
 * Additional Authenticated Data (AAD) binds each page's `(pageNumber, pageSize)`
 * (8-byte little-endian `Uint32Array`) into the GCM authentication tag so pages
 * cannot be reordered, truncated, or transplanted across page slots undetected.
 */

/** Accepted key representations for VFS page encryption at rest. */
export type PageEncryptionKey = CryptoKey | Uint8Array | ArrayBuffer;

/** 4-byte magic prefix (`"FBE1"`) identifying an AES-GCM encrypted page envelope. */
export const ENCRYPTED_PAGE_MAGIC = new Uint8Array([0x46, 0x42, 0x45, 0x31]);

/** Byte length of the IV (12 bytes / 96 bits) used for AES-GCM. */
export const AES_GCM_IV_LENGTH = 12;

/** Byte length of the AES-GCM authentication tag (16 bytes / 128 bits). */
export const AES_GCM_TAG_LENGTH = 16;

/** Total byte overhead added to each encrypted page (`4 + 12 + 16 = 32` bytes). */
export const ENCRYPTED_PAGE_OVERHEAD =
  ENCRYPTED_PAGE_MAGIC.byteLength + AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH;

function getWebCrypto(): Crypto {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.subtle !== 'undefined') {
    return g.crypto;
  }
  throw new Error('WebCrypto API (globalThis.crypto.subtle) is not available in this environment');
}

/**
 * Return `true` when `data` begins with the 4-byte `"FBE1"` encrypted-page
 * magic header and is at least `ENCRYPTED_PAGE_OVERHEAD` bytes long.
 */
export function isEncryptedPageBuffer(data: Uint8Array | ArrayBuffer): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < ENCRYPTED_PAGE_OVERHEAD) return false;
  return (
    bytes[0] === ENCRYPTED_PAGE_MAGIC[0] &&
    bytes[1] === ENCRYPTED_PAGE_MAGIC[1] &&
    bytes[2] === ENCRYPTED_PAGE_MAGIC[2] &&
    bytes[3] === ENCRYPTED_PAGE_MAGIC[3]
  );
}

/**
 * Generate a new extractable 256-bit AES-GCM `CryptoKey` via WebCrypto.
 */
export async function generateEncryptionKey(extractable = true): Promise<CryptoKey> {
  const webcrypto = getWebCrypto();
  return (await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  )) as CryptoKey;
}

/**
 * Import a raw 16-byte (AES-128-GCM) or 32-byte (AES-256-GCM) key into a
 * WebCrypto `CryptoKey`.
 */
export async function importRawEncryptionKey(
  rawKey: Uint8Array | ArrayBuffer,
  extractable = false,
): Promise<CryptoKey> {
  const bytes = rawKey instanceof Uint8Array ? rawKey : new Uint8Array(rawKey);
  if (bytes.byteLength !== 16 && bytes.byteLength !== 32) {
    throw new RangeError(
      `AES-GCM encryption key must be 16 or 32 bytes (received ${bytes.byteLength} bytes)`,
    );
  }
  const webcrypto = getWebCrypto();
  const keyData = bytes.slice().buffer as ArrayBuffer;
  return webcrypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM', length: bytes.byteLength * 8 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Export an extractable WebCrypto `CryptoKey` to raw key bytes.
 */
export async function exportRawEncryptionKey(key: CryptoKey): Promise<Uint8Array> {
  const webcrypto = getWebCrypto();
  const raw = await webcrypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/**
 * Derive a 256-bit AES-GCM `CryptoKey` from a UTF-8 passphrase and salt using
 * PBKDF2-HMAC-SHA256.
 */
export async function deriveEncryptionKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations = 100_000,
  extractable = false,
): Promise<CryptoKey> {
  if (salt.byteLength < 8) {
    throw new RangeError('PBKDF2 salt must be at least 8 bytes');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError('PBKDF2 iterations must be a positive integer');
  }
  const webcrypto = getWebCrypto();
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    passphraseBytes.slice().buffer as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.slice().buffer as ArrayBuffer,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

const resolvedKeyCache = new WeakMap<object, Promise<CryptoKey>>();

/**
 * Resolve a {@link PageEncryptionKey} (`CryptoKey`, `Uint8Array`, or
 * `ArrayBuffer`) into a WebCrypto `CryptoKey`, caching imported keys.
 */
export async function resolveCryptoKey(key: PageEncryptionKey): Promise<CryptoKey> {
  if (
    typeof key === 'object' &&
    key !== null &&
    'type' in key &&
    'algorithm' in key &&
    'usages' in key
  ) {
    return key as CryptoKey;
  }
  const objKey = key as unknown as object;
  const cached = resolvedKeyCache.get(objKey);
  if (cached) return cached;
  const promise = importRawEncryptionKey(key as Uint8Array | ArrayBuffer);
  resolvedKeyCache.set(objKey, promise);
  return promise;
}

function buildPageAad(pageNumber: number, pageSize: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, pageNumber >>> 0, true);
  view.setUint32(4, pageSize >>> 0, true);
  return buf;
}

/**
 * Encrypt a single database page using AES-GCM and return its `FBE1` envelope
 * (`pageSize + 32` bytes).
 */
export async function encryptPage(
  plaintext: Uint8Array,
  key: PageEncryptionKey,
  pageNumber: number,
  pageSize = plaintext.byteLength,
): Promise<Uint8Array> {
  const webcrypto = getWebCrypto();
  const cryptoKey = await resolveCryptoKey(key);
  const iv = new Uint8Array(AES_GCM_IV_LENGTH);
  webcrypto.getRandomValues(iv);
  const additionalData = buildPageAad(pageNumber, pageSize);
  const plainBuffer = plaintext.slice().buffer as ArrayBuffer;

  const cipherBuffer = await webcrypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer as ArrayBuffer,
      additionalData,
      tagLength: AES_GCM_TAG_LENGTH * 8,
    },
    cryptoKey,
    plainBuffer,
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const envelope = new Uint8Array(
    ENCRYPTED_PAGE_MAGIC.byteLength + AES_GCM_IV_LENGTH + cipherBytes.byteLength,
  );
  envelope.set(ENCRYPTED_PAGE_MAGIC, 0);
  envelope.set(iv, ENCRYPTED_PAGE_MAGIC.byteLength);
  envelope.set(cipherBytes, ENCRYPTED_PAGE_MAGIC.byteLength + AES_GCM_IV_LENGTH);
  return envelope;
}

/**
 * Decrypt and authenticate an `FBE1` encrypted page envelope using AES-GCM.
 *
 * @throws if `envelope` is not a valid `FBE1` page, or if authentication fails
 *   (wrong key, tampered ciphertext, or mismatched `pageNumber` / `pageSize`).
 */
export async function decryptPage(
  envelope: Uint8Array,
  key: PageEncryptionKey,
  pageNumber: number,
  pageSize?: number,
): Promise<Uint8Array> {
  if (!isEncryptedPageBuffer(envelope)) {
    throw new Error(
      `Invalid encrypted page envelope at page ${pageNumber}: missing FBE1 header`,
    );
  }
  const expectedPlainSize =
    pageSize ?? envelope.byteLength - ENCRYPTED_PAGE_OVERHEAD;
  if (envelope.byteLength !== expectedPlainSize + ENCRYPTED_PAGE_OVERHEAD) {
    throw new Error(
      `Invalid encrypted page envelope length at page ${pageNumber}: expected ${
        expectedPlainSize + ENCRYPTED_PAGE_OVERHEAD
      } bytes, got ${envelope.byteLength}`,
    );
  }

  const webcrypto = getWebCrypto();
  const cryptoKey = await resolveCryptoKey(key);
  const iv = envelope.slice(
    ENCRYPTED_PAGE_MAGIC.byteLength,
    ENCRYPTED_PAGE_MAGIC.byteLength + AES_GCM_IV_LENGTH,
  );
  const cipherAndTag = envelope.slice(
    ENCRYPTED_PAGE_MAGIC.byteLength + AES_GCM_IV_LENGTH,
  );
  const additionalData = buildPageAad(pageNumber, expectedPlainSize);

  try {
    const plainBuffer = await webcrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer as ArrayBuffer,
        additionalData,
        tagLength: AES_GCM_TAG_LENGTH * 8,
      },
      cryptoKey,
      cipherAndTag.buffer as ArrayBuffer,
    );
    return new Uint8Array(plainBuffer);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to decrypt database page ${pageNumber}: invalid encryption key or corrupted ciphertext (${detail})`,
    );
  }
}
