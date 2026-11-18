/**
 * jwt-auth.ts – Zero-Dependency WebCrypto JWT Signing, Verification &
 * Multi-Tenant / Role-Based Replication Auth (`M23 Item 1`).
 */

import type { ReplicationLogEntry } from './types';

export type SyncJwtAlgorithm = 'HS256' | 'ES256' | 'EdDSA';
export type SyncJwtRole = 'reader' | 'writer' | 'admin';

export type SyncJwtErrorCode =
  | 'JWT_MISSING'
  | 'JWT_INVALID'
  | 'JWT_EXPIRED'
  | 'JWT_ROLE_FORBIDDEN'
  | 'JWT_TABLE_FORBIDDEN'
  | 'JWT_TENANT_FORBIDDEN'
  | 'JWT_RLS_FORBIDDEN';

export type SyncRlsScalar = string | number | boolean | null;
export type SyncRlsClaimValue = SyncRlsScalar | readonly SyncRlsScalar[];
export type SyncRlsTablePredicates = Readonly<Record<string, SyncRlsClaimValue>>;
export type SyncRlsClaims = Readonly<Record<string, SyncRlsTablePredicates>>;

export class SyncJwtError extends Error {
  readonly code: SyncJwtErrorCode;
  readonly status: 401 | 403;

  constructor(message: string, code: SyncJwtErrorCode, status: 401 | 403) {
    super(message);
    this.name = 'SyncJwtError';
    this.code = code;
    this.status = status;
  }
}

export interface SyncJwtClaims {
  sub?: string;
  tenant_id?: string | number;
  role?: SyncJwtRole;
  tables?: readonly string[];
  /** Per-table fine-grained row-level security predicates (`M24 Item 1`). */
  rls?: SyncRlsClaims;
  iss?: string;
  aud?: string | readonly string[];
  iat?: number;
  nbf?: number;
  exp?: number;
  [claim: string]: unknown;
}

export type SyncJwtKeyInput = string | Uint8Array | CryptoKey | JsonWebKey;

export interface JwksKeyEntry extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export interface JwksDocument {
  keys: readonly JwksKeyEntry[];
}

export interface JwksKeyProviderOptions {
  /** Remote JWKS endpoint URL (e.g. `'https://auth.example.com/.well-known/jwks.json'`). */
  jwksUrl?: string;
  /** Optional static or initial JWKS keys. */
  keys?: readonly JwksKeyEntry[];
  /** Custom `fetch` implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Cache TTL in milliseconds before refreshing from `jwksUrl`. @default 300_000 */
  cacheTtlMs?: number;
  /** Custom clock returning milliseconds for deterministic cache TTL tests. */
  nowMs?: () => number;
}

export interface JwksKeyProvider {
  resolveKey(header: { kid?: string; alg?: string }): Promise<JsonWebKey>;
  refresh(): Promise<JwksDocument>;
  readonly cachedKeysCount: number;
}

export type SyncJwtKeySource =
  | SyncJwtKeyInput
  | JwksKeyProvider
  | ((header: { alg: SyncJwtAlgorithm; kid?: string }) => SyncJwtKeyInput | Promise<SyncJwtKeyInput>);

export interface SignSyncJwtOptions {
  /** Signing algorithm. @default 'HS256' */
  algorithm?: SyncJwtAlgorithm;
  /** Relative expiration in seconds from `nowSec` (sets `exp` if not already in `claims`). */
  expiresInSec?: number;
  /** Issuer (`iss`) claim override. */
  issuer?: string;
  /** Audience (`aud`) claim override. */
  audience?: string | readonly string[];
  /** Optional `kid` header parameter. */
  kid?: string;
  /** Override current UNIX epoch seconds for deterministic testing. */
  nowSec?: number;
}

export interface VerifySyncJwtOptions {
  /** Permitted signing algorithms (`'none'` is always rejected). @default ['HS256', 'ES256', 'EdDSA'] */
  algorithms?: readonly SyncJwtAlgorithm[];
  /** Expected `iss` claim when set. */
  issuer?: string;
  /** Expected `aud` claim when set. */
  audience?: string;
  /** Allowed clock skew in seconds for `exp` and `nbf`. @default 5 */
  clockToleranceSec?: number;
  /** Override current UNIX epoch seconds for deterministic testing. */
  nowSec?: number;
}

export interface JwtTenantAuthOptions extends VerifySyncJwtOptions {
  /** Shared HMAC secret, asymmetric verification key, `JwksKeyProvider`, or async key resolver (`M23 Item 1` / `M24 Item 1`). */
  secretOrPublicKey?: SyncJwtKeySource;
  /** Optional JWKS key provider or JWKS options when `secretOrPublicKey` is omitted (`M24 Item 1`). */
  jwks?: JwksKeyProvider | JwksKeyProviderOptions;
  /** Claim name carrying the tenant identifier. @default 'tenant_id' */
  tenantClaim?: string;
  /** Default role when the token omits `role`. @default 'writer' */
  defaultRole?: SyncJwtRole;
  /** Allow `role: 'admin'` tokens to query/push across tenants via `x-tenant-id` / `?tenantId=`. @default true */
  allowAdminAllTenants?: boolean;
}

export interface JwtTenantAuthContext {
  readonly claims: SyncJwtClaims;
  readonly tenantId: string | number | undefined;
  readonly role: SyncJwtRole;
  readonly allowedTables: ReadonlySet<string> | null;
  /** Normalized per-table (`TABLE_UPPER -> COL_UPPER -> expected`) RLS predicates (`M24 Item 1`). */
  readonly rls: ReadonlyMap<string, ReadonlyMap<string, SyncRlsClaimValue>> | null;
  readonly canWrite: boolean;
  readonly isAdmin: boolean;
}

export interface JwtTenantAuthResolver {
  readonly tenantClaim: string;
  authenticateToken(token: string | null | undefined): Promise<JwtTenantAuthContext>;
  authenticateRequest(request: Request): Promise<JwtTenantAuthContext>;
  assertWriteAllowed(ctx: JwtTenantAuthContext): void;
  assertTableAllowed(ctx: JwtTenantAuthContext, tableName: string): void;
  assertBatchTablesAllowed(
    ctx: JwtTenantAuthContext,
    entries: readonly ReplicationLogEntry[],
  ): void;
  assertEntryRlsAllowed(ctx: JwtTenantAuthContext, entry: ReplicationLogEntry): void;
  assertBatchRlsAllowed(
    ctx: JwtTenantAuthContext,
    entries: readonly ReplicationLogEntry[],
  ): void;
  filterRowsForTable<T extends Record<string, unknown>>(
    tableName: string,
    rows: readonly T[],
    ctx: JwtTenantAuthContext,
  ): T[];
  filterEntriesForContext(
    entries: readonly ReplicationLogEntry[],
    ctx: JwtTenantAuthContext,
  ): ReplicationLogEntry[];
  resolveEffectiveTenantId(
    ctx: JwtTenantAuthContext,
    requestedTenantId?: string | number | null,
  ): string | number | undefined;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API (globalThis.crypto.subtle) is required for Sync JWT auth');
  }
  return subtle;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let base64: string;
  if (typeof Buffer !== 'undefined') {
    base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  } else {
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      bin += String.fromCharCode(bytes[i]!);
    }
    base64 = btoa(bin);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new SyncJwtError('Malformed base64url segment in JWT', 'JWT_INVALID', 401);
  }
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const full = padded + '='.repeat(padLen);
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(full, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(full);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function isCryptoKey(val: unknown): val is CryptoKey {
  return (
    typeof val === 'object' &&
    val !== null &&
    'type' in val &&
    'algorithm' in val &&
    'usages' in val
  );
}

async function importJwtCryptoKey(
  keyInput: SyncJwtKeyInput,
  alg: SyncJwtAlgorithm,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  if (isCryptoKey(keyInput)) {
    return keyInput;
  }
  const subtle = getSubtleCrypto();

  if (typeof keyInput === 'string' || keyInput instanceof Uint8Array) {
    if (alg !== 'HS256') {
      throw new SyncJwtError(
        `Raw string/Uint8Array secret is only valid for HS256 (received ${alg})`,
        'JWT_INVALID',
        401,
      );
    }
    const rawBytes =
      typeof keyInput === 'string' ? utf8Encoder.encode(keyInput) : keyInput;
    if (rawBytes.byteLength === 0) {
      throw new SyncJwtError('JWT HMAC secret must not be empty', 'JWT_INVALID', 401);
    }
    return subtle.importKey(
      'raw',
      new Uint8Array(rawBytes),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      [usage],
    );
  }

  // JsonWebKey
  const jwk = keyInput;
  if (alg === 'HS256') {
    return subtle.importKey('jwk', jwk, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  }
  if (alg === 'ES256') {
    return subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      [usage],
    );
  }
  return subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, [usage]);
}

function subtleSignVerifyParams(
  alg: SyncJwtAlgorithm,
): AlgorithmIdentifier | EcdsaParams {
  if (alg === 'HS256') return 'HMAC';
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' };
  return { name: 'Ed25519' };
}

/**
 * Sign a replication JWT using WebCrypto (`HS256`, `ES256`, or `EdDSA`) (`M23 Item 1`).
 */
export async function signSyncJwt(
  claims: SyncJwtClaims,
  key: SyncJwtKeyInput,
  options: SignSyncJwtOptions = {},
): Promise<string> {
  const alg: SyncJwtAlgorithm = options.algorithm ?? 'HS256';
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = {
    alg,
    typ: 'JWT',
    ...(options.kid ? { kid: options.kid } : {}),
  };
  const payload: SyncJwtClaims = {
    iat: claims.iat ?? nowSec,
    ...claims,
    ...(options.issuer !== undefined ? { iss: options.issuer } : {}),
    ...(options.audience !== undefined ? { aud: options.audience } : {}),
    ...(options.expiresInSec !== undefined && claims.exp === undefined
      ? { exp: nowSec + options.expiresInSec }
      : {}),
  };

  const encodedHeader = encodeBase64Url(utf8Encoder.encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(utf8Encoder.encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importJwtCryptoKey(key, alg, 'sign');
  const sigBuf = await getSubtleCrypto().sign(
    subtleSignVerifyParams(alg),
    cryptoKey,
    utf8Encoder.encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(sigBuf))}`;
}

function isJwksKeyProvider(val: unknown): val is JwksKeyProvider {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as JwksKeyProvider).resolveKey === 'function' &&
    typeof (val as JwksKeyProvider).refresh === 'function'
  );
}

/**
 * Create a JWKS (`/.well-known/jwks.json` or static key set) verification key
 * provider with `kid` lookup, TTL caching, and automatic force-refresh on
 * unknown `kid` during key rotation (`M24 Item 1`).
 */
export function createJwksKeyProvider(
  options: JwksKeyProviderOptions,
): JwksKeyProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 300_000);
  const nowFn = options.nowMs ?? (() => Date.now());

  let cachedKeys: JwksKeyEntry[] = options.keys ? [...options.keys] : [];
  let lastFetchedAt = cachedKeys.length > 0 ? nowFn() : -Infinity;
  let inflightRefresh: Promise<JwksDocument> | null = null;

  const findMatchingJwk = (header: { kid?: string; alg?: string }): JwksKeyEntry | undefined => {
    if (header.kid) {
      return cachedKeys.find((k) => k.kid === header.kid && k.use !== 'enc');
    }
    return cachedKeys.find((k) => {
      if (k.use === 'enc') return false;
      if (k.alg && header.alg && k.alg !== header.alg) return false;
      return true;
    });
  };

  const refresh = async (): Promise<JwksDocument> => {
    if (!options.jwksUrl) {
      return { keys: cachedKeys };
    }
    if (inflightRefresh) {
      return inflightRefresh;
    }
    inflightRefresh = (async () => {
      try {
        if (typeof fetchImpl !== 'function') {
          throw new SyncJwtError('No fetch implementation available for JWKS', 'JWT_INVALID', 401);
        }
        const res = await fetchImpl(options.jwksUrl!);
        if (!res.ok) {
          throw new SyncJwtError(
            `JWKS endpoint returned HTTP ${res.status}`,
            'JWT_INVALID',
            401,
          );
        }
        const doc = (await res.json()) as Partial<JwksDocument>;
        if (!doc || !Array.isArray(doc.keys)) {
          throw new SyncJwtError('Invalid JWKS payload: expected { keys: [...] }', 'JWT_INVALID', 401);
        }
        cachedKeys = [...doc.keys];
        lastFetchedAt = nowFn();
        return { keys: cachedKeys };
      } finally {
        inflightRefresh = null;
      }
    })();
    return inflightRefresh;
  };

  return {
    get cachedKeysCount() {
      return cachedKeys.length;
    },
    refresh,
    async resolveKey(header) {
      const now = nowFn();
      let refreshedThisTurn = false;
      if (
        options.jwksUrl &&
        (cachedKeys.length === 0 || now - lastFetchedAt >= cacheTtlMs)
      ) {
        await refresh();
        refreshedThisTurn = true;
      }
      let match = findMatchingJwk(header);
      if (!match && header.kid && options.jwksUrl && !refreshedThisTurn) {
        await refresh();
        match = findMatchingJwk(header);
      }
      if (!match) {
        throw new SyncJwtError(
          header.kid
            ? `No matching JWK found in JWKS for kid '${header.kid}'`
            : 'No matching verification JWK found in JWKS',
          'JWT_INVALID',
          401,
        );
      }
      return match;
    },
  };
}

/**
 * Verify a replication JWT signature and standard temporal/issuer/audience claims
 * using WebCrypto (`M23 Item 1` / `M24 Item 1`).
 */
export async function verifySyncJwt(
  token: string,
  key: SyncJwtKeySource,
  options: VerifySyncJwtOptions = {},
): Promise<SyncJwtClaims> {
  const trimmed = token.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new SyncJwtError('Malformed JWT structure (expected 3 segments)', 'JWT_INVALID', 401);
  }

  let header: { alg?: string; typ?: string; kid?: string };
  let claims: SyncJwtClaims;
  try {
    header = JSON.parse(utf8Decoder.decode(decodeBase64Url(parts[0]))) as {
      alg?: string;
      typ?: string;
      kid?: string;
    };
    claims = JSON.parse(utf8Decoder.decode(decodeBase64Url(parts[1]))) as SyncJwtClaims;
  } catch (err) {
    if (err instanceof SyncJwtError) throw err;
    throw new SyncJwtError('Invalid JSON in JWT header or payload', 'JWT_INVALID', 401);
  }

  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new SyncJwtError('JWT payload must be a JSON object', 'JWT_INVALID', 401);
  }

  const permittedAlgs: readonly SyncJwtAlgorithm[] = options.algorithms ?? [
    'HS256',
    'ES256',
    'EdDSA',
  ];
  const alg = header.alg as SyncJwtAlgorithm | undefined;
  if (!alg || (alg as string) === 'none' || !permittedAlgs.includes(alg)) {
    throw new SyncJwtError(
      `Unsupported or disallowed JWT algorithm: ${String(header.alg)}`,
      'JWT_INVALID',
      401,
    );
  }

  const resolvedKeyInput: SyncJwtKeyInput = isJwksKeyProvider(key)
    ? await key.resolveKey({ kid: header.kid, alg })
    : typeof key === 'function'
      ? await key({ alg, kid: header.kid })
      : key;

  const signatureBytes = decodeBase64Url(parts[2]);
  const signingInputBytes = utf8Encoder.encode(`${parts[0]}.${parts[1]}`);
  let validSig = false;
  try {
    const cryptoKey = await importJwtCryptoKey(resolvedKeyInput, alg, 'verify');
    validSig = await getSubtleCrypto().verify(
      subtleSignVerifyParams(alg),
      cryptoKey,
      new Uint8Array(signatureBytes),
      new Uint8Array(signingInputBytes),
    );
  } catch (err) {
    if (err instanceof SyncJwtError) throw err;
    validSig = false;
  }

  if (!validSig) {
    throw new SyncJwtError('JWT signature verification failed', 'JWT_INVALID', 401);
  }

  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = Math.max(0, options.clockToleranceSec ?? 5);

  if (typeof claims.exp === 'number' && nowSec > claims.exp + skew) {
    throw new SyncJwtError('JWT has expired', 'JWT_EXPIRED', 401);
  }
  if (typeof claims.nbf === 'number' && nowSec + skew < claims.nbf) {
    throw new SyncJwtError('JWT is not yet valid (nbf)', 'JWT_INVALID', 401);
  }
  if (options.issuer !== undefined && claims.iss !== options.issuer) {
    throw new SyncJwtError(
      `JWT issuer mismatch (expected '${options.issuer}')`,
      'JWT_INVALID',
      401,
    );
  }
  if (options.audience !== undefined) {
    const audList = Array.isArray(claims.aud)
      ? claims.aud
      : typeof claims.aud === 'string'
        ? [claims.aud]
        : [];
    if (!audList.includes(options.audience)) {
      throw new SyncJwtError(
        `JWT audience mismatch (expected '${options.audience}')`,
        'JWT_INVALID',
        401,
      );
    }
  }

  return claims;
}

export function extractBearerJwtFromRequest(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  if (/^Bearer\s+/i.test(auth)) {
    const tok = auth.replace(/^Bearer\s+/i, '').trim();
    if (tok) return tok;
  }
  const url = new URL(request.url, 'http://localhost');
  const queryTok = url.searchParams.get('token')?.trim();
  return queryTok || null;
}

function normalizeRlsClaims(
  rawRls: unknown,
): ReadonlyMap<string, ReadonlyMap<string, SyncRlsClaimValue>> | null {
  if (!rawRls || typeof rawRls !== 'object' || Array.isArray(rawRls)) {
    return null;
  }
  const outer = new Map<string, ReadonlyMap<string, SyncRlsClaimValue>>();
  for (const [rawTable, rawPreds] of Object.entries(rawRls as Record<string, unknown>)) {
    const tableKey = rawTable.trim().toUpperCase();
    if (!tableKey || !rawPreds || typeof rawPreds !== 'object' || Array.isArray(rawPreds)) {
      continue;
    }
    const colMap = new Map<string, SyncRlsClaimValue>();
    for (const [rawCol, val] of Object.entries(rawPreds as Record<string, unknown>)) {
      const colKey = rawCol.trim().toUpperCase();
      if (!colKey) continue;
      if (
        val === null ||
        typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean' ||
        Array.isArray(val)
      ) {
        colMap.set(colKey, val as SyncRlsClaimValue);
      }
    }
    if (colMap.size > 0) {
      outer.set(tableKey, colMap);
    }
  }
  return outer.size > 0 ? outer : null;
}

function readRowFieldCaseInsensitive(
  row: Record<string, unknown> | null | undefined,
  colUpper: string,
): { present: boolean; value: unknown } {
  if (!row || typeof row !== 'object') {
    return { present: false, value: undefined };
  }
  if (colUpper in row) {
    return { present: true, value: row[colUpper] };
  }
  const lower = colUpper.toLowerCase();
  if (lower in row) {
    return { present: true, value: row[lower] };
  }
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase() === colUpper) {
      return { present: true, value: v };
    }
  }
  return { present: false, value: undefined };
}

function rlsScalarEquals(actual: unknown, expected: SyncRlsScalar): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  if (actual === null || actual === undefined) {
    return false;
  }
  if (actual === expected) return true;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.trim() === expected.trim();
  }
  return String(actual).trim() === String(expected).trim();
}

export function getEffectiveTableRlsPredicates(
  rls: ReadonlyMap<string, ReadonlyMap<string, SyncRlsClaimValue>> | null | undefined,
  tableName: string,
): ReadonlyMap<string, SyncRlsClaimValue> | null {
  if (!rls) return null;
  const norm = tableName.trim().toUpperCase();
  const wildcard = rls.get('*');
  const specific = rls.get(norm);
  if (!wildcard && !specific) return null;
  if (wildcard && !specific) return wildcard;
  if (!wildcard && specific) return specific;
  const merged = new Map<string, SyncRlsClaimValue>(wildcard!);
  for (const [col, val] of specific!) {
    merged.set(col, val);
  }
  return merged;
}

export function rowMatchesRlsPredicates(
  row: Record<string, unknown> | null | undefined,
  predicates: ReadonlyMap<string, SyncRlsClaimValue>,
): boolean {
  for (const [colUpper, expected] of predicates) {
    const field = readRowFieldCaseInsensitive(row, colUpper);
    if (!field.present) return false;
    if (Array.isArray(expected)) {
      if (!expected.some((item) => rlsScalarEquals(field.value, item as SyncRlsScalar))) {
        return false;
      }
    } else if (!rlsScalarEquals(field.value, expected as SyncRlsScalar)) {
      return false;
    }
  }
  return true;
}

/**
 * Create a reusable JWT tenant, role & row-level security (`rls`) authorization
 * resolver for HTTP/SSE and WebSocket replication endpoints (`M23 Item 1` / `M24 Item 1`).
 */
export function createJwtTenantAuthResolver(
  options: JwtTenantAuthOptions,
): JwtTenantAuthResolver {
  const tenantClaim = options.tenantClaim ?? 'tenant_id';
  const defaultRole: SyncJwtRole = options.defaultRole ?? 'writer';
  const allowAdminAllTenants = options.allowAdminAllTenants ?? true;

  const keySource: SyncJwtKeySource | undefined =
    options.secretOrPublicKey ??
    (options.jwks
      ? isJwksKeyProvider(options.jwks)
        ? options.jwks
        : createJwksKeyProvider(options.jwks)
      : undefined);

  if (!keySource) {
    throw new Error(
      'createJwtTenantAuthResolver requires either secretOrPublicKey or jwks options',
    );
  }

  const buildContext = (claims: SyncJwtClaims): JwtTenantAuthContext => {
    const rawRole = claims.role;
    const role: SyncJwtRole =
      rawRole === 'reader' || rawRole === 'writer' || rawRole === 'admin'
        ? rawRole
        : defaultRole;
    const rawTenant = claims[tenantClaim];
    const tenantId =
      typeof rawTenant === 'string' || typeof rawTenant === 'number'
        ? rawTenant
        : undefined;
    const allowedTables = Array.isArray(claims.tables)
      ? new Set(claims.tables.map((t) => String(t).trim().toUpperCase()).filter(Boolean))
      : null;
    const rls = normalizeRlsClaims(claims.rls);

    return {
      claims,
      tenantId,
      role,
      allowedTables,
      rls,
      canWrite: role === 'writer' || role === 'admin',
      isAdmin: role === 'admin',
    };
  };

  return {
    tenantClaim,

    async authenticateToken(token) {
      if (!token || !token.trim()) {
        throw new SyncJwtError('Missing Bearer JWT token', 'JWT_MISSING', 401);
      }
      const claims = await verifySyncJwt(token, keySource, options);
      return buildContext(claims);
    },

    async authenticateRequest(request) {
      const token = extractBearerJwtFromRequest(request);
      if (!token) {
        throw new SyncJwtError(
          'Missing Authorization: Bearer <jwt> header',
          'JWT_MISSING',
          401,
        );
      }
      const claims = await verifySyncJwt(token, keySource, options);
      return buildContext(claims);
    },

    assertWriteAllowed(ctx) {
      if (!ctx.canWrite) {
        throw new SyncJwtError(
          `JWT role '${ctx.role}' is read-only and cannot push mutations`,
          'JWT_ROLE_FORBIDDEN',
          403,
        );
      }
    },

    assertTableAllowed(ctx, tableName) {
      if (!ctx.allowedTables) return;
      const norm = tableName.trim().toUpperCase();
      if (!ctx.allowedTables.has(norm)) {
        throw new SyncJwtError(
          `JWT is not authorized for table '${norm}'`,
          'JWT_TABLE_FORBIDDEN',
          403,
        );
      }
    },

    assertBatchTablesAllowed(ctx, entries) {
      if (!ctx.allowedTables) return;
      for (const e of entries) {
        if (e.table) {
          this.assertTableAllowed(ctx, e.table);
        }
      }
    },

    assertEntryRlsAllowed(ctx, entry) {
      if (!ctx.rls || entry.operation === 'DDL' || !entry.table) return;
      const preds = getEffectiveTableRlsPredicates(ctx.rls, entry.table);
      if (!preds) return;
      const normTable = entry.table.trim().toUpperCase();

      if (entry.operation === 'INSERT') {
        if (!rowMatchesRlsPredicates(entry.after, preds)) {
          throw new SyncJwtError(
            `JWT RLS policy forbids INSERT on table '${normTable}'`,
            'JWT_RLS_FORBIDDEN',
            403,
          );
        }
        return;
      }

      if (entry.operation === 'UPDATE') {
        if (!rowMatchesRlsPredicates(entry.after, preds)) {
          throw new SyncJwtError(
            `JWT RLS policy forbids UPDATE after-image on table '${normTable}'`,
            'JWT_RLS_FORBIDDEN',
            403,
          );
        }
        if (entry.before && Object.keys(entry.before).length > 0) {
          // If before-image carries any RLS column, ensure it also matched
          for (const colUpper of preds.keys()) {
            const bf = readRowFieldCaseInsensitive(entry.before, colUpper);
            if (bf.present && !rowMatchesRlsPredicates(entry.before, new Map([[colUpper, preds.get(colUpper)!]]))) {
              throw new SyncJwtError(
                `JWT RLS policy forbids UPDATE before-image on table '${normTable}'`,
                'JWT_RLS_FORBIDDEN',
                403,
              );
            }
          }
        }
        return;
      }

      if (entry.operation === 'DELETE') {
        const candidate = entry.before && Object.keys(entry.before).length > 0 ? entry.before : entry.key;
        if (!rowMatchesRlsPredicates(candidate, preds)) {
          throw new SyncJwtError(
            `JWT RLS policy forbids DELETE on table '${normTable}'`,
            'JWT_RLS_FORBIDDEN',
            403,
          );
        }
      }
    },

    assertBatchRlsAllowed(ctx, entries) {
      if (!ctx.rls) return;
      for (const entry of entries) {
        this.assertEntryRlsAllowed(ctx, entry);
      }
    },

    filterRowsForTable(tableName, rows, ctx) {
      const preds = getEffectiveTableRlsPredicates(ctx.rls, tableName);
      if (!preds) return [...rows];
      return rows.filter((row) => rowMatchesRlsPredicates(row, preds));
    },

    filterEntriesForContext(entries, ctx) {
      if (!ctx.allowedTables && !ctx.rls) return [...entries];
      return entries.filter((e) => {
        if (!e.table) return true;
        const normTable = e.table.trim().toUpperCase();
        if (ctx.allowedTables && !ctx.allowedTables.has(normTable)) {
          return false;
        }
        if (ctx.rls && e.operation !== 'DDL') {
          const preds = getEffectiveTableRlsPredicates(ctx.rls, normTable);
          if (preds) {
            const candidate = e.after ?? e.before ?? e.key;
            if (!rowMatchesRlsPredicates(candidate, preds)) {
              return false;
            }
          }
        }
        return true;
      });
    },

    resolveEffectiveTenantId(ctx, requestedTenantId) {
      if (ctx.isAdmin && allowAdminAllTenants) {
        if (
          requestedTenantId !== undefined &&
          requestedTenantId !== null &&
          requestedTenantId !== ''
        ) {
          return requestedTenantId;
        }
        return ctx.tenantId;
      }
      if (
        requestedTenantId !== undefined &&
        requestedTenantId !== null &&
        requestedTenantId !== '' &&
        ctx.tenantId !== undefined &&
        String(requestedTenantId) !== String(ctx.tenantId)
      ) {
        throw new SyncJwtError(
          `JWT tenant '${String(ctx.tenantId)}' cannot access requested tenant '${String(requestedTenantId)}'`,
          'JWT_TENANT_FORBIDDEN',
          403,
        );
      }
      return ctx.tenantId;
    },
  };
}
