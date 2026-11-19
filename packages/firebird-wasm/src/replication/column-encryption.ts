/**
 * column-encryption.ts – Client-Side Column-Level End-to-End Encryption (E2EE)
 * & Key Rotation (`createColumnEncryptionTransformer`) for Zero-Knowledge Sync Relays (`M25 Item 2`).
 */

import type {
  ReplicationLogEntry,
  RowTransformContext,
  RowTransformer,
} from './types';
import { base64ToBytes, bytesToBase64, normalizeTableName } from './shared';

export const COLUMN_E2EE_PREFIX = 'enc:v1:';
const IV_BYTE_LENGTH = 12;
const DEFAULT_HKDF_SALT = 'firebird-wasm-column-e2ee-salt-v1';
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export type ColumnEncryptionErrorReason =
  | 'missing-key-id'
  | 'invalid-envelope'
  | 'aad-mismatch-or-tampered'
  | 'strict-plaintext-rejected'
  | 'invalid-configuration';

/**
 * Error thrown when column-level E2EE encryption or decryption fails (e.g. missing
 * key ID during rotation, malformed envelope, or tampered ciphertext / AAD mismatch).
 */
export class ColumnEncryptionError extends Error {
  readonly code = 'COLUMN_ENCRYPTION_ERROR' as const;
  readonly reason: ColumnEncryptionErrorReason;
  readonly table?: string;
  readonly column?: string;
  readonly kid?: string;

  constructor(params: {
    message: string;
    reason: ColumnEncryptionErrorReason;
    table?: string;
    column?: string;
    kid?: string;
  }) {
    super(params.message);
    this.name = 'ColumnEncryptionError';
    this.reason = params.reason;
    this.table = params.table;
    this.column = params.column;
    this.kid = params.kid;
  }
}

export type ColumnKeyMaterial = string | Uint8Array | CryptoKey;

export interface ColumnEncryptionOptions {
  /**
   * Columns to encrypt/decrypt:
   * - `readonly string[]`: encrypts matching column names (case-insensitive) across all tables
   * - `Record<tableName, readonly string[]>`: per-table sensitive column lists
   */
  columns: readonly string[] | Readonly<Record<string, readonly string[]>>;
  /** Single key shorthand (used with `kid`, default `'k1'`). */
  key?: ColumnKeyMaterial;
  /** Key ID when `key` shorthand is used. @default 'k1' */
  kid?: string;
  /** Multi-key keyring mapping `<kid>` to passphrase, raw key bytes, or WebCrypto `CryptoKey`. */
  keys?: Readonly<Record<string, ColumnKeyMaterial>>;
  /** Active key ID used for outbound encryption when `keys` is provided. */
  activeKid?: string;
  /** Optional HKDF salt used when deriving AES-256-GCM keys from string passphrases or byte arrays. */
  salt?: string | Uint8Array;
  /**
   * Optional primary key column names per table (case-insensitive) used to construct
   * `(tableName, primaryKey, columnName)` Additional Authenticated Data (AAD).
   * Defaults to `ctx.key` columns or `['ID']`.
   */
  primaryKeys?: Readonly<Record<string, string | readonly string[]>>;
  /** Default direction when the returned transformer is called directly as a `RowTransformer`. @default 'encrypt' */
  mode?: 'encrypt' | 'decrypt';
  /** Re-encrypt values already wrapped in an older `'enc:v1:<oldKid>:...'` envelope to `activeKid` on outbound pass. @default false */
  reencryptOnRotate?: boolean;
  /** Reject non-null plaintext values on configured encrypted columns during inbound decryption. @default false */
  strictInbound?: boolean;
  /** Encrypt `null` values instead of preserving SQL `NULL`. @default false */
  encryptNulls?: boolean;
}

export interface ColumnEncryptionTransformer extends RowTransformer {
  /** Outbound `RowTransformer` encrypting configured columns with `activeKid`. */
  readonly encrypt: RowTransformer;
  /** Inbound `RowTransformer` decrypting configured columns using the keyring. */
  readonly decrypt: RowTransformer;
  /** Currently active key identifier for outbound encryption. */
  readonly activeKid: string;
  /** Registered key identifiers in this transformer's keyring. */
  readonly keyIds: readonly string[];
  /** Add or replace a key in the keyring and promote `newKid` to `activeKid` for zero-downtime key rotation. */
  rotateKey(newKid: string, newKey: ColumnKeyMaterial): void;
  /** Register an additional historical decryption key without changing `activeKid`. */
  addKey(kid: string, keyMaterial: ColumnKeyMaterial): void;
  /** Encrypt configured columns of a standalone row object. */
  encryptRow(
    table: string,
    row: Record<string, unknown>,
    key?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Decrypt configured columns of a standalone row object. */
  decryptRow(
    table: string,
    row: Record<string, unknown>,
    key?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Encrypt `after` / `before` payloads on a `ReplicationLogEntry` (preserving `key` and cleartext routing/tenant columns). */
  encryptEntry(entry: ReplicationLogEntry): Promise<ReplicationLogEntry>;
  /** Decrypt `after` / `before` payloads on a `ReplicationLogEntry`. */
  decryptEntry(entry: ReplicationLogEntry): Promise<ReplicationLogEntry>;
}

/** Return `true` if `value` is a `'enc:v1:<kid>:<base64>'` encrypted column envelope. */
export function isEncryptedColumnEnvelope(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(COLUMN_E2EE_PREFIX)) {
    return false;
  }
  const rest = value.slice(COLUMN_E2EE_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  return colonIdx > 0 && colonIdx < rest.length - 1;
}

/** Parse `'enc:v1:<kid>:<base64(iv || ciphertext)>'` into its constituent fields. */
export function parseEncryptedColumnEnvelope(envelope: string): {
  readonly kid: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
} {
  if (!isEncryptedColumnEnvelope(envelope)) {
    throw new ColumnEncryptionError({
      message: 'Malformed encrypted column envelope (expected enc:v1:<kid>:<base64>)',
      reason: 'invalid-envelope',
    });
  }
  const rest = envelope.slice(COLUMN_E2EE_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  const kid = rest.slice(0, colonIdx);
  const b64 = rest.slice(colonIdx + 1);
  let combined: Uint8Array;
  try {
    combined = base64ToBytes(b64);
  } catch {
    throw new ColumnEncryptionError({
      message: `Invalid base64 payload in encrypted column envelope for kid '${kid}'`,
      reason: 'invalid-envelope',
      kid,
    });
  }
  if (combined.byteLength <= IV_BYTE_LENGTH + 16) {
    throw new ColumnEncryptionError({
      message: `Truncated AES-256-GCM payload in encrypted column envelope for kid '${kid}'`,
      reason: 'invalid-envelope',
      kid,
    });
  }
  return {
    kid,
    iv: combined.subarray(0, IV_BYTE_LENGTH),
    ciphertext: combined.subarray(IV_BYTE_LENGTH),
  };
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API is required for column-level E2EE');
  }
  return subtle;
}

async function deriveAesGcmKey(
  rawMaterial: ColumnKeyMaterial,
  kid: string,
  saltBytes: Uint8Array,
): Promise<CryptoKey> {
  if (
    typeof rawMaterial === 'object' &&
    rawMaterial !== null &&
    !(rawMaterial instanceof Uint8Array) &&
    'type' in rawMaterial &&
    'algorithm' in rawMaterial
  ) {
    return rawMaterial;
  }
  const subtle = getSubtleCrypto();
  const ikmBytes =
    typeof rawMaterial === 'string'
      ? utf8Encoder.encode(rawMaterial)
      : new Uint8Array(rawMaterial.buffer, rawMaterial.byteOffset, rawMaterial.byteLength);

  const hkdfBase = await subtle.importKey(
    'raw',
    new Uint8Array(ikmBytes) as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  const infoBytes = utf8Encoder.encode(`firebird-wasm:column-e2ee:v1:${kid}`);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(saltBytes) as unknown as BufferSource,
      info: new Uint8Array(infoBytes) as unknown as BufferSource,
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function encodePlaintextValue(value: unknown): Uint8Array {
  if (typeof value === 'string') {
    return utf8Encoder.encode(`s:${value}`);
  }
  if (typeof value === 'bigint') {
    return utf8Encoder.encode(`n:${value.toString()}`);
  }
  if (value instanceof Uint8Array) {
    return utf8Encoder.encode(`b:${bytesToBase64(value)}`);
  }
  return utf8Encoder.encode(`j:${JSON.stringify(value)}`);
}

function decodePlaintextValue(bytes: Uint8Array): unknown {
  const text = utf8Decoder.decode(bytes);
  if (text.startsWith('s:')) return text.slice(2);
  if (text.startsWith('n:')) return BigInt(text.slice(2));
  if (text.startsWith('b:')) return base64ToBytes(text.slice(2));
  if (text.startsWith('j:')) return JSON.parse(text.slice(2)) as unknown;
  return text;
}

function readCaseInsensitive(
  obj: Record<string, unknown>,
  colUpper: string,
): { found: boolean; actualKey: string; value: unknown } {
  if (colUpper in obj) {
    return { found: true, actualKey: colUpper, value: obj[colUpper] };
  }
  const lower = colUpper.toLowerCase();
  if (lower in obj) {
    return { found: true, actualKey: lower, value: obj[lower] };
  }
  for (const k of Object.keys(obj)) {
    if (k.toUpperCase() === colUpper) {
      return { found: true, actualKey: k, value: obj[k] };
    }
  }
  return { found: false, actualKey: colUpper, value: undefined };
}

function buildCanonicalAad(
  tableUpper: string,
  colUpper: string,
  row: Record<string, unknown>,
  explicitKey: Record<string, unknown> | undefined,
  configuredPkMap: ReadonlyMap<string, readonly string[]>,
): Uint8Array {
  const configuredPk = configuredPkMap.get(tableUpper);
  let pkCols: string[];
  if (configuredPk && configuredPk.length > 0) {
    pkCols = [...configuredPk];
  } else if (explicitKey && Object.keys(explicitKey).length > 0) {
    pkCols = Object.keys(explicitKey).map((k) => k.toUpperCase());
  } else {
    pkCols = ['ID'];
  }
  pkCols.sort();

  const parts: string[] = [];
  for (const pkCol of pkCols) {
    const fromKey = explicitKey ? readCaseInsensitive(explicitKey, pkCol) : { found: false, value: undefined };
    const fromRow = readCaseInsensitive(row, pkCol);
    const rawVal = fromKey.found ? fromKey.value : fromRow.value;
    const normVal =
      rawVal === null || rawVal === undefined
        ? ''
        : typeof rawVal === 'string' || typeof rawVal === 'number' || typeof rawVal === 'bigint' || typeof rawVal === 'boolean'
          ? String(rawVal).trim()
          : JSON.stringify(rawVal);
    parts.push(`${pkCol}=${normVal}`);
  }

  return utf8Encoder.encode(`${tableUpper}\0${parts.join('\x1f')}\0${colUpper}`);
}

/**
 * Create a WebCrypto AES-256-GCM column-level E2EE `RowTransformer` with `(table, pk, column)`
 * AAD binding and multi-`kid` key rotation (`M25 Item 2`).
 */
export function createColumnEncryptionTransformer(
  options: ColumnEncryptionOptions,
): ColumnEncryptionTransformer {
  const keyMaterials = new Map<string, ColumnKeyMaterial>();
  const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

  let currentActiveKid = '';
  if (options.keys && Object.keys(options.keys).length > 0) {
    for (const [k, v] of Object.entries(options.keys)) {
      const cleanKid = k.trim();
      if (!cleanKid || cleanKid.includes(':')) {
        throw new ColumnEncryptionError({
          message: `Invalid key ID '${k}' (must be non-empty and must not contain ':')`,
          reason: 'invalid-configuration',
          kid: k,
        });
      }
      keyMaterials.set(cleanKid, v);
    }
    currentActiveKid = (options.activeKid ?? Object.keys(options.keys)[0]!).trim();
    if (!keyMaterials.has(currentActiveKid)) {
      throw new ColumnEncryptionError({
        message: `Active key ID '${currentActiveKid}' is not present in keys`,
        reason: 'missing-key-id',
        kid: currentActiveKid,
      });
    }
  } else if (options.key !== undefined) {
    const cleanKid = (options.kid ?? 'k1').trim();
    if (!cleanKid || cleanKid.includes(':')) {
      throw new ColumnEncryptionError({
        message: `Invalid key ID '${cleanKid}'`,
        reason: 'invalid-configuration',
        kid: cleanKid,
      });
    }
    keyMaterials.set(cleanKid, options.key);
    currentActiveKid = cleanKid;
  } else {
    throw new ColumnEncryptionError({
      message: 'createColumnEncryptionTransformer requires either `key` or `keys`',
      reason: 'invalid-configuration',
    });
  }

  const saltBytes =
    options.salt === undefined
      ? utf8Encoder.encode(DEFAULT_HKDF_SALT)
      : typeof options.salt === 'string'
        ? utf8Encoder.encode(options.salt)
        : options.salt;

  const globalColumns: Set<string> | null = Array.isArray(options.columns)
    ? new Set((options.columns as readonly string[]).map((c) => c.trim().toUpperCase()))
    : null;
  const perTableColumns = new Map<string, Set<string>>();
  if (!Array.isArray(options.columns)) {
    const colRecord = options.columns as Readonly<Record<string, readonly string[]>>;
    for (const [tbl, cols] of Object.entries(colRecord)) {
      perTableColumns.set(
        normalizeTableName(tbl),
        new Set(cols.map((c) => c.trim().toUpperCase())),
      );
    }
  }

  const configuredPkMap = new Map<string, readonly string[]>();
  if (options.primaryKeys) {
    for (const [tbl, pk] of Object.entries(options.primaryKeys)) {
      const list = typeof pk === 'string' ? [pk.toUpperCase()] : pk.map((c) => c.toUpperCase());
      configuredPkMap.set(normalizeTableName(tbl), list);
    }
  }

  const getTargetColumns = (tableUpper: string): Set<string> | undefined => {
    if (globalColumns) return globalColumns;
    return perTableColumns.get(tableUpper);
  };

  const resolveCryptoKey = (kid: string): Promise<CryptoKey> => {
    let cached = derivedKeyCache.get(kid);
    if (!cached) {
      const raw = keyMaterials.get(kid);
      if (raw === undefined) {
        return Promise.reject(
          new ColumnEncryptionError({
            message: `Unknown encryption key ID '${kid}'`,
            reason: 'missing-key-id',
            kid,
          }),
        );
      }
      cached = deriveAesGcmKey(raw, kid, saltBytes);
      derivedKeyCache.set(kid, cached);
    }
    return cached;
  };

  const encryptSingleValue = async (
    value: unknown,
    aad: Uint8Array,
    kid: string,
  ): Promise<string> => {
    const subtle = getSubtleCrypto();
    const cryptoKey = await resolveCryptoKey(kid);
    const iv = new Uint8Array(IV_BYTE_LENGTH);
    globalThis.crypto.getRandomValues(iv);
    const plaintext = encodePlaintextValue(value);
    const cipherBuf = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: new Uint8Array(aad) as unknown as BufferSource,
      },
      cryptoKey,
      new Uint8Array(plaintext) as unknown as BufferSource,
    );
    const cipherBytes = new Uint8Array(cipherBuf);
    const combined = new Uint8Array(IV_BYTE_LENGTH + cipherBytes.byteLength);
    combined.set(iv, 0);
    combined.set(cipherBytes, IV_BYTE_LENGTH);
    return `${COLUMN_E2EE_PREFIX}${kid}:${bytesToBase64(combined)}`;
  };

  const decryptSingleValue = async (
    envelope: string,
    aad: Uint8Array,
    tableUpper: string,
    colUpper: string,
  ): Promise<unknown> => {
    const parsed = parseEncryptedColumnEnvelope(envelope);
    const cryptoKey = await resolveCryptoKey(parsed.kid).catch((err) => {
      if (err instanceof ColumnEncryptionError) {
        throw new ColumnEncryptionError({
          message: err.message,
          reason: err.reason,
          table: tableUpper,
          column: colUpper,
          kid: parsed.kid,
        });
      }
      throw err;
    });

    const subtle = getSubtleCrypto();
    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(parsed.iv) as unknown as BufferSource,
          additionalData: new Uint8Array(aad) as unknown as BufferSource,
        },
        cryptoKey,
        new Uint8Array(parsed.ciphertext) as unknown as BufferSource,
      );
    } catch {
      throw new ColumnEncryptionError({
        message: `AES-256-GCM authentication failed for ${tableUpper}.${colUpper} (kid='${parsed.kid}'): tampered ciphertext, wrong key, or AAD row/column mismatch`,
        reason: 'aad-mismatch-or-tampered',
        table: tableUpper,
        column: colUpper,
        kid: parsed.kid,
      });
    }
    return decodePlaintextValue(new Uint8Array(plainBuf));
  };

  const encryptRowImpl = async (
    table: string,
    row: Record<string, unknown>,
    explicitKey?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tableUpper = normalizeTableName(table);
    const targetCols = getTargetColumns(tableUpper);
    if (!targetCols || targetCols.size === 0) {
      return { ...row };
    }

    const out: Record<string, unknown> = { ...row };
    for (const colUpper of targetCols) {
      const lookup = readCaseInsensitive(out, colUpper);
      if (!lookup.found) continue;
      if (lookup.value === undefined) continue;
      if (lookup.value === null && !options.encryptNulls) continue;

      const aad = buildCanonicalAad(tableUpper, colUpper, out, explicitKey, configuredPkMap);
      let plainToEncrypt: unknown = lookup.value;

      if (isEncryptedColumnEnvelope(lookup.value)) {
        const parsed = parseEncryptedColumnEnvelope(lookup.value);
        if (!options.reencryptOnRotate || parsed.kid === currentActiveKid) {
          continue;
        }
        plainToEncrypt = await decryptSingleValue(lookup.value, aad, tableUpper, colUpper);
      }

      out[lookup.actualKey] = await encryptSingleValue(plainToEncrypt, aad, currentActiveKid);
    }
    return out;
  };

  const decryptRowImpl = async (
    table: string,
    row: Record<string, unknown>,
    explicitKey?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tableUpper = normalizeTableName(table);
    const targetCols = getTargetColumns(tableUpper);
    if (!targetCols || targetCols.size === 0) {
      return { ...row };
    }

    const out: Record<string, unknown> = { ...row };
    for (const colUpper of targetCols) {
      const lookup = readCaseInsensitive(out, colUpper);
      if (!lookup.found || lookup.value === undefined || lookup.value === null) {
        continue;
      }
      if (!isEncryptedColumnEnvelope(lookup.value)) {
        if (options.strictInbound) {
          throw new ColumnEncryptionError({
            message: `Plaintext value rejected on strict E2EE column ${tableUpper}.${colUpper}`,
            reason: 'strict-plaintext-rejected',
            table: tableUpper,
            column: colUpper,
          });
        }
        continue;
      }
      const aad = buildCanonicalAad(tableUpper, colUpper, out, explicitKey, configuredPkMap);
      out[lookup.actualKey] = await decryptSingleValue(lookup.value, aad, tableUpper, colUpper);
    }
    return out;
  };

  const encryptTransformer: RowTransformer = (
    row: Record<string, unknown>,
    ctx: RowTransformContext,
  ) => encryptRowImpl(ctx.table, row, ctx.key);

  const decryptTransformer: RowTransformer = (
    row: Record<string, unknown>,
    ctx: RowTransformContext,
  ) => decryptRowImpl(ctx.table, row, ctx.key);

  const defaultMode = options.mode ?? 'encrypt';
  const callable = ((row: Record<string, unknown>, ctx: RowTransformContext) =>
    defaultMode === 'decrypt'
      ? decryptTransformer(row, ctx)
      : encryptTransformer(row, ctx)) as ColumnEncryptionTransformer;

  Object.defineProperties(callable, {
    encrypt: { value: encryptTransformer, enumerable: true },
    decrypt: { value: decryptTransformer, enumerable: true },
    activeKid: {
      get: () => currentActiveKid,
      enumerable: true,
    },
    keyIds: {
      get: () => [...keyMaterials.keys()],
      enumerable: true,
    },
    addKey: {
      value(kid: string, keyMaterial: ColumnKeyMaterial): void {
        const cleanKid = kid.trim();
        if (!cleanKid || cleanKid.includes(':')) {
          throw new ColumnEncryptionError({
            message: `Invalid key ID '${kid}'`,
            reason: 'invalid-configuration',
            kid,
          });
        }
        keyMaterials.set(cleanKid, keyMaterial);
        derivedKeyCache.delete(cleanKid);
      },
      enumerable: true,
    },
    rotateKey: {
      value(newKid: string, newKey: ColumnKeyMaterial): void {
        const cleanKid = newKid.trim();
        if (!cleanKid || cleanKid.includes(':')) {
          throw new ColumnEncryptionError({
            message: `Invalid key ID '${newKid}'`,
            reason: 'invalid-configuration',
            kid: newKid,
          });
        }
        keyMaterials.set(cleanKid, newKey);
        derivedKeyCache.delete(cleanKid);
        currentActiveKid = cleanKid;
      },
      enumerable: true,
    },
    encryptRow: { value: encryptRowImpl, enumerable: true },
    decryptRow: { value: decryptRowImpl, enumerable: true },
    encryptEntry: {
      async value(entry: ReplicationLogEntry): Promise<ReplicationLogEntry> {
        if (entry.operation === 'DDL') return entry;
        const encAfter = entry.after
          ? await encryptRowImpl(entry.table, entry.after, entry.key)
          : null;
        const encBefore = entry.before
          ? await encryptRowImpl(entry.table, entry.before, entry.key)
          : null;
        return {
          ...entry,
          after: encAfter,
          before: encBefore,
        };
      },
      enumerable: true,
    },
    decryptEntry: {
      async value(entry: ReplicationLogEntry): Promise<ReplicationLogEntry> {
        if (entry.operation === 'DDL') return entry;
        const decAfter = entry.after
          ? await decryptRowImpl(entry.table, entry.after, entry.key)
          : null;
        const decBefore = entry.before
          ? await decryptRowImpl(entry.table, entry.before, entry.key)
          : null;
        return {
          ...entry,
          after: decAfter,
          before: decBefore,
        };
      },
      enumerable: true,
    },
  });

  return callable;
}
