/**
 * audit-log.ts – Tamper-Evident Cryptographic Audit Log & Binary Merkle
 * Hash-Chain Verification (`"FB_AUDIT_LOG$"`) (`M26 Item 2`).
 *
 * Records structured row-level & DDL mutations into `"FB_AUDIT_LOG$"` where
 * each entry links `ENTRY_HASH = SHA-256(PREV_HASH || SEQ || TS || ACTOR || TABLE || OP || KEY_JSON || DIFF_JSON)`
 * with optional WebCrypto detached signatures (`HMAC`, `ES256`, `EdDSA`) and
 * binary Merkle tree root checkpoints (`computeAuditMerkleRoot`).
 */

import type { QueryParams, QueryResult, Row } from './types';
import type { TableRepository } from './table-api';
import type { ReplicationIndexHook, ReplicationLogEntry } from './replication/types';

/** Default system-excluded Firebird table storing cryptographic audit entries (`M26 Item 2`). */
export const DEFAULT_AUDIT_LOG_TABLE = 'FB_AUDIT_LOG$';

/** 64-zero-hex genesis `PREV_HASH` anchoring sequence #1 (`M26 Item 2`). */
export const GENESIS_AUDIT_HASH = '0'.repeat(64);

/** Supported WebCrypto signature algorithms for audit log entries (`M26 Item 2`). */
export type AuditSignAlgorithm = 'HMAC' | 'ES256' | 'EdDSA';

/** Minimal database executor required by {@link createAuditLog} and {@link verifyAuditChain}. */
export interface AuditDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<unknown>;
}

/** Structured row diff stored inside `DIFF_JSON` (`M26 Item 2`). */
export interface AuditDiffPayload {
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly changedColumns: readonly string[];
  readonly ddlSql?: string;
}

/** Single persisted row in `"FB_AUDIT_LOG$"` (`M26 Item 2`). */
export interface AuditLogEntry {
  readonly seq: number;
  readonly ts: number;
  readonly actor: string;
  readonly tableName: string;
  readonly op: string;
  readonly key: unknown;
  readonly diff: AuditDiffPayload;
  readonly prevHash: string;
  readonly entryHash: string;
  readonly signature: string | null;
}

/** Input passed to {@link AuditLogHandle.record} (`M26 Item 2`). */
export interface RecordAuditInput {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | string;
  key?: unknown;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ddlSql?: string;
  actor?: string;
  timestamp?: number;
}

/** Verification report returned by {@link AuditLogHandle.verifyChain} (`M26 Item 2`). */
export interface AuditChainVerificationResult {
  readonly valid: boolean;
  readonly checkedCount: number;
  readonly headHash: string | null;
  readonly merkleRoot: string | null;
  readonly tamperedAtSeq?: number;
  readonly reason?: string;
}

/** Options for {@link createAuditLog} (`M26 Item 2`). */
export interface AuditLogOptions {
  /** Custom audit table name. @default 'FB_AUDIT_LOG$' */
  tableName?: string;
  /** Optional allow-list of user tables to record (records all tables when omitted). */
  tables?: readonly string[];
  /** Callback resolving the active user/service identity for each mutation. @default () => 'system' */
  actorResolver?: () => string | Promise<string>;
  /** Optional WebCrypto signing key or HMAC secret (`CryptoKey`, UTF-8 `string`, or `Uint8Array`). */
  signKey?: CryptoKey | string | Uint8Array;
  /** Optional public verification key (defaults to `signKey` for symmetric `HMAC`). */
  verifyKey?: CryptoKey | string | Uint8Array;
  /** Signature algorithm when `signKey` or `verifyKey` is supplied. @default 'HMAC' */
  signAlgorithm?: AuditSignAlgorithm;
  /** Custom clock for deterministic testing. @default Date.now */
  now?: () => number;
}

/** Handle returned by {@link createAuditLog} (`M26 Item 2`). */
export interface AuditLogHandle {
  readonly tableName: string;
  ensureTable(): Promise<void>;
  record(input: RecordAuditInput): Promise<AuditLogEntry>;
  listEntries(options?: { limit?: number; sinceSeq?: number; table?: string }): Promise<AuditLogEntry[]>;
  verifyChain(options?: {
    verifyKey?: CryptoKey | string | Uint8Array;
    signAlgorithm?: AuditSignAlgorithm;
  }): Promise<AuditChainVerificationResult>;
  merkleRoot(): Promise<string | null>;
  /** Wrap a `TableRepository` (`db.table('...')`) so `insert`, `update`, `upsert`, and `delete` automatically append audit records. */
  wrapTable<T extends Row = Row, K = unknown>(
    repo: TableRepository<T, K>,
    options?: { tableName?: string; primaryKey?: string },
  ): TableRepository<T, K>;
  /** Expose this audit log as a `ReplicationIndexHook` for `createSubscription({ secondaryIndexes })`. */
  asReplicationHook(table?: string): ReplicationIndexHook;
  /** Record a batch of `ReplicationLogEntry` journal records into `"FB_AUDIT_LOG$"`. */
  recordEntries(entries: readonly ReplicationLogEntry[]): Promise<void>;
}

const utf8Encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function canonicalizeValue(val: unknown): unknown {
  if (val === undefined) return null;
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'bigint') return val.toString();
    return val;
  }
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return { $hex: bytesToHex(val) };
  if (Array.isArray(val)) return val.map(canonicalizeValue);
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      out[k] = canonicalizeValue(obj[k]);
    }
  }
  return out;
}

export function canonicalAuditJson(val: unknown): string {
  return JSON.stringify(canonicalizeValue(val));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8Encoder.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Compute the canonical SHA-256 hash for a single `"FB_AUDIT_LOG$"` record (`M26 Item 2`).
 */
export async function computeAuditEntryHash(params: {
  prevHash: string;
  seq: number;
  ts: number;
  actor: string;
  tableName: string;
  op: string;
  keyJson: string;
  diffJson: string;
}): Promise<string> {
  const preimage = [
    params.prevHash,
    String(params.seq),
    String(params.ts),
    params.actor,
    params.tableName.toUpperCase(),
    params.op.toUpperCase(),
    params.keyJson,
    params.diffJson,
  ].join('|');
  return sha256Hex(preimage);
}

/**
 * Compute a domain-separated binary SHA-256 Merkle tree root over an ordered list
 * of entry hashes (`M26 Item 2`). Returns `null` when `entryHashes` is empty.
 */
export async function computeAuditMerkleRoot(
  entryHashes: readonly string[],
): Promise<string | null> {
  if (entryHashes.length === 0) return null;
  let level: string[] = [];
  for (const h of entryHashes) {
    level.push(await sha256Hex(`leaf:${h}`));
  }
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(`node:${left}:${right}`));
    }
    level = next;
  }
  return level[0]!;
}

async function importHmacKey(
  raw: CryptoKey | string | Uint8Array,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  if (typeof raw === 'object' && raw !== null && 'type' in raw && 'algorithm' in raw) {
    return raw as CryptoKey;
  }
  const bytes = typeof raw === 'string' ? utf8Encoder.encode(raw) : raw;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return globalThis.crypto.subtle.importKey(
    'raw',
    copy.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

async function signEntryHash(
  entryHash: string,
  keyInput: CryptoKey | string | Uint8Array,
  algorithm: AuditSignAlgorithm,
): Promise<string> {
  const data = utf8Encoder.encode(entryHash);
  if (algorithm === 'HMAC') {
    const key = await importHmacKey(keyInput, 'sign');
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, data);
    return bytesToBase64Url(new Uint8Array(sig));
  }
  const cryptoKey = keyInput as CryptoKey;
  const algParam =
    algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' };
  const sig = await globalThis.crypto.subtle.sign(algParam, cryptoKey, data);
  return bytesToBase64Url(new Uint8Array(sig));
}

async function verifyEntrySignature(
  entryHash: string,
  signatureB64: string,
  keyInput: CryptoKey | string | Uint8Array,
  algorithm: AuditSignAlgorithm,
): Promise<boolean> {
  try {
    const data = utf8Encoder.encode(entryHash);
    const sigBytes = base64UrlToBytes(signatureB64);
    const sigBuf = new Uint8Array(sigBytes.byteLength);
    sigBuf.set(sigBytes);
    if (algorithm === 'HMAC') {
      const key = await importHmacKey(keyInput, 'verify');
      return await globalThis.crypto.subtle.verify('HMAC', key, sigBuf.buffer, data);
    }
    const cryptoKey = keyInput as CryptoKey;
    const algParam =
      algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' };
    return await globalThis.crypto.subtle.verify(algParam, cryptoKey, sigBuf.buffer, data);
  } catch {
    return false;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function runExec(db: AuditDatabaseExecutor, sql: string, params: QueryParams = []): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
  } else if (typeof db.execute === 'function') {
    await db.execute(sql, params);
  } else {
    await db.query(sql, params);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function buildDiffPayload(input: RecordAuditInput): AuditDiffPayload {
  const before = input.before ?? null;
  const after = input.after ?? null;
  const colSet = new Set<string>();
  if (before && after) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonicalAuditJson(before[k]) !== canonicalAuditJson(after[k])) {
        colSet.add(k);
      }
    }
  } else if (after) {
    for (const k of Object.keys(after)) colSet.add(k);
  } else if (before) {
    for (const k of Object.keys(before)) colSet.add(k);
  }
  return {
    before,
    after,
    changedColumns: [...colSet].sort(),
    ...(input.ddlSql ? { ddlSql: input.ddlSql } : {}),
  };
}

/**
 * Verify the hash chain, sequence contiguity, Merkle root, and optional WebCrypto
 * signatures of `"FB_AUDIT_LOG$"` on `db` (`M26 Item 2`).
 */
export async function verifyAuditChain(
  db: AuditDatabaseExecutor,
  options: {
    tableName?: string;
    verifyKey?: CryptoKey | string | Uint8Array;
    signAlgorithm?: AuditSignAlgorithm;
  } = {},
): Promise<AuditChainVerificationResult> {
  const tableName = (options.tableName ?? DEFAULT_AUDIT_LOG_TABLE).trim() || DEFAULT_AUDIT_LOG_TABLE;
  const checkRes = await db.query<{ CNT: number }>(
    'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [tableName.toUpperCase()],
  );
  const exists = Number(checkRes.rows[0]?.CNT ?? 0) > 0;
  if (!exists) {
    return {
      valid: true,
      checkedCount: 0,
      headHash: null,
      merkleRoot: null,
    };
  }

  const res = await db.query<Record<string, unknown>>(
    `SELECT SEQ, TS, ACTOR, TABLE_NAME, OP, KEY_JSON, DIFF_JSON, PREV_HASH, ENTRY_HASH, SIGNATURE ` +
      `FROM ${quoteIdent(tableName.toUpperCase())} ORDER BY SEQ ASC`,
  );

  if (res.rows.length === 0) {
    return {
      valid: true,
      checkedCount: 0,
      headHash: null,
      merkleRoot: null,
    };
  }

  const alg: AuditSignAlgorithm = options.signAlgorithm ?? 'HMAC';
  let expectedPrev = GENESIS_AUDIT_HASH;
  let expectedSeq = 1;
  const entryHashes: string[] = [];

  for (const row of res.rows) {
    const seq = Number(row.SEQ ?? row.seq);
    const ts = Number(row.TS ?? row.ts);
    const actor = String(row.ACTOR ?? row.actor ?? '');
    const tbl = String(row.TABLE_NAME ?? row.table_name ?? '');
    const op = String(row.OP ?? row.op ?? '');
    const keyJson = String(row.KEY_JSON ?? row.key_json ?? '');
    const diffJson = String(row.DIFF_JSON ?? row.diff_json ?? '');
    const prevHash = String(row.PREV_HASH ?? row.prev_hash ?? '');
    const storedHash = String(row.ENTRY_HASH ?? row.entry_hash ?? '');
    const signatureRaw = row.SIGNATURE ?? row.signature;
    const signature =
      signatureRaw !== null && signatureRaw !== undefined && String(signatureRaw).length > 0
        ? String(signatureRaw)
        : null;

    if (seq !== expectedSeq) {
      return {
        valid: false,
        checkedCount: entryHashes.length,
        headHash: entryHashes[entryHashes.length - 1] ?? null,
        merkleRoot: await computeAuditMerkleRoot(entryHashes),
        tamperedAtSeq: seq,
        reason: `Audit sequence gap or reordering detected: expected SEQ ${expectedSeq}, found ${seq}`,
      };
    }

    if (!constantTimeEquals(prevHash, expectedPrev)) {
      return {
        valid: false,
        checkedCount: entryHashes.length,
        headHash: entryHashes[entryHashes.length - 1] ?? null,
        merkleRoot: await computeAuditMerkleRoot(entryHashes),
        tamperedAtSeq: seq,
        reason: `PREV_HASH mismatch at SEQ ${seq}: expected ${expectedPrev}, found ${prevHash}`,
      };
    }

    const recomputed = await computeAuditEntryHash({
      prevHash,
      seq,
      ts,
      actor,
      tableName: tbl,
      op,
      keyJson,
      diffJson,
    });

    if (!constantTimeEquals(recomputed, storedHash)) {
      return {
        valid: false,
        checkedCount: entryHashes.length,
        headHash: entryHashes[entryHashes.length - 1] ?? null,
        merkleRoot: await computeAuditMerkleRoot(entryHashes),
        tamperedAtSeq: seq,
        reason: `ENTRY_HASH tampering detected at SEQ ${seq}: recomputed ${recomputed} != stored ${storedHash}`,
      };
    }

    if (options.verifyKey !== undefined) {
      if (!signature) {
        return {
          valid: false,
          checkedCount: entryHashes.length,
          headHash: entryHashes[entryHashes.length - 1] ?? null,
          merkleRoot: await computeAuditMerkleRoot(entryHashes),
          tamperedAtSeq: seq,
          reason: `Missing cryptographic signature at SEQ ${seq}`,
        };
      }
      const sigOk = await verifyEntrySignature(storedHash, signature, options.verifyKey, alg);
      if (!sigOk) {
        return {
          valid: false,
          checkedCount: entryHashes.length,
          headHash: entryHashes[entryHashes.length - 1] ?? null,
          merkleRoot: await computeAuditMerkleRoot(entryHashes),
          tamperedAtSeq: seq,
          reason: `Invalid cryptographic ${alg} signature at SEQ ${seq}`,
        };
      }
    }

    entryHashes.push(storedHash);
    expectedPrev = storedHash;
    expectedSeq += 1;
  }

  return {
    valid: true,
    checkedCount: entryHashes.length,
    headHash: entryHashes[entryHashes.length - 1] ?? null,
    merkleRoot: await computeAuditMerkleRoot(entryHashes),
  };
}

/**
 * Create a tamper-evident cryptographic audit logger backed by `"FB_AUDIT_LOG$"` (`M26 Item 2`).
 */
export function createAuditLog(
  db: AuditDatabaseExecutor,
  options: AuditLogOptions = {},
): AuditLogHandle {
  const tableName = (
    (options.tableName ?? DEFAULT_AUDIT_LOG_TABLE).trim() || DEFAULT_AUDIT_LOG_TABLE
  ).toUpperCase();
  const allowedTables = options.tables
    ? new Set(options.tables.map((t) => t.trim().toUpperCase()))
    : null;
  const signAlgorithm: AuditSignAlgorithm = options.signAlgorithm ?? 'HMAC';
  const nowFn = options.now ?? Date.now;

  let tableReadyPromise: Promise<void> | null = null;
  let appendQueue: Promise<unknown> = Promise.resolve();

  const ensureTable = async (): Promise<void> => {
    if (!tableReadyPromise) {
      tableReadyPromise = (async () => {
        const check = await db.query<{ CNT: number }>(
          'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
          [tableName],
        );
        if (Number(check.rows[0]?.CNT ?? 0) === 0) {
          await runExec(
            db,
            `CREATE TABLE ${quoteIdent(tableName)} (` +
              `SEQ BIGINT NOT NULL PRIMARY KEY, ` +
              `TS BIGINT NOT NULL, ` +
              `ACTOR VARCHAR(255) NOT NULL, ` +
              `TABLE_NAME VARCHAR(128) NOT NULL, ` +
              `OP VARCHAR(16) NOT NULL, ` +
              `KEY_JSON BLOB SUB_TYPE TEXT NOT NULL, ` +
              `DIFF_JSON BLOB SUB_TYPE TEXT NOT NULL, ` +
              `PREV_HASH VARCHAR(64) NOT NULL, ` +
              `ENTRY_HASH VARCHAR(64) NOT NULL, ` +
              `SIGNATURE VARCHAR(512)` +
              `)`,
          );
        }
      })().catch((err) => {
        tableReadyPromise = null;
        throw err;
      });
    }
    return tableReadyPromise;
  };

  const recordInternal = async (input: RecordAuditInput): Promise<AuditLogEntry> => {
    await ensureTable();
    const upperTable = input.table.trim().toUpperCase();
    const op = input.op.trim().toUpperCase();
    const ts = input.timestamp ?? nowFn();
    const actor =
      input.actor ??
      (options.actorResolver ? await options.actorResolver() : 'system');

    const diffPayload = buildDiffPayload(input);
    const keyVal = input.key ?? null;
    const keyJson = canonicalAuditJson(keyVal);
    const diffJson = canonicalAuditJson(diffPayload);

    const headRes = await db.query<{ SEQ: number; ENTRY_HASH: string }>(
      `SELECT FIRST 1 SEQ, ENTRY_HASH FROM ${quoteIdent(tableName)} ORDER BY SEQ DESC`,
    );
    const headRow = headRes.rows[0];
    const seq = headRow ? Number(headRow.SEQ) + 1 : 1;
    const prevHash = headRow ? String(headRow.ENTRY_HASH) : GENESIS_AUDIT_HASH;

    const entryHash = await computeAuditEntryHash({
      prevHash,
      seq,
      ts,
      actor,
      tableName: upperTable,
      op,
      keyJson,
      diffJson,
    });

    const signature =
      options.signKey !== undefined
        ? await signEntryHash(entryHash, options.signKey, signAlgorithm)
        : null;

    await runExec(
      db,
      `INSERT INTO ${quoteIdent(tableName)} ` +
        `(SEQ, TS, ACTOR, TABLE_NAME, OP, KEY_JSON, DIFF_JSON, PREV_HASH, ENTRY_HASH, SIGNATURE) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [seq, ts, actor, upperTable, op, keyJson, diffJson, prevHash, entryHash, signature],
    );

    return {
      seq,
      ts,
      actor,
      tableName: upperTable,
      op,
      key: keyVal,
      diff: diffPayload,
      prevHash,
      entryHash,
      signature,
    };
  };

  const handle: AuditLogHandle = {
    tableName,
    ensureTable,

    record(input: RecordAuditInput): Promise<AuditLogEntry> {
      const next = appendQueue.then(() => recordInternal(input));
      appendQueue = next.catch(() => undefined);
      return next;
    },

    async listEntries(listOpts = {}): Promise<AuditLogEntry[]> {
      await ensureTable();
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (listOpts.sinceSeq !== undefined) {
        clauses.push('SEQ > ?');
        params.push(listOpts.sinceSeq);
      }
      if (listOpts.table) {
        clauses.push('TABLE_NAME = ?');
        params.push(listOpts.table.trim().toUpperCase());
      }
      const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const firstSql =
        listOpts.limit !== undefined && listOpts.limit > 0
          ? `FIRST ${Math.floor(listOpts.limit)} `
          : '';
      const res = await db.query<Record<string, unknown>>(
        `SELECT ${firstSql}SEQ, TS, ACTOR, TABLE_NAME, OP, KEY_JSON, DIFF_JSON, PREV_HASH, ENTRY_HASH, SIGNATURE ` +
          `FROM ${quoteIdent(tableName)}${whereSql} ORDER BY SEQ ASC`,
        params,
      );
      return res.rows.map((r) => ({
        seq: Number(r.SEQ ?? r.seq),
        ts: Number(r.TS ?? r.ts),
        actor: String(r.ACTOR ?? r.actor ?? ''),
        tableName: String(r.TABLE_NAME ?? r.table_name ?? ''),
        op: String(r.OP ?? r.op ?? ''),
        key: JSON.parse(String(r.KEY_JSON ?? r.key_json ?? 'null')),
        diff: JSON.parse(String(r.DIFF_JSON ?? r.diff_json ?? '{}')) as AuditDiffPayload,
        prevHash: String(r.PREV_HASH ?? r.prev_hash ?? ''),
        entryHash: String(r.ENTRY_HASH ?? r.entry_hash ?? ''),
        signature:
          r.SIGNATURE !== null && r.SIGNATURE !== undefined
            ? String(r.SIGNATURE)
            : null,
      }));
    },

    async verifyChain(verifyOpts = {}): Promise<AuditChainVerificationResult> {
      const effectiveVerifyKey =
        verifyOpts.verifyKey ??
        options.verifyKey ??
        (signAlgorithm === 'HMAC' ? options.signKey : undefined);
      return verifyAuditChain(db, {
        tableName,
        verifyKey: effectiveVerifyKey,
        signAlgorithm: verifyOpts.signAlgorithm ?? signAlgorithm,
      });
    },

    async merkleRoot(): Promise<string | null> {
      const entries = await this.listEntries();
      return computeAuditMerkleRoot(entries.map((e) => e.entryHash));
    },

    wrapTable<T extends Row = Row, K = unknown>(
      repo: TableRepository<T, K>,
      wrapOpts: { tableName?: string; primaryKey?: string } = {},
    ): TableRepository<T, K> {
      const tbl = (wrapOpts.tableName ?? repo.tableName).toUpperCase();
      const pk = wrapOpts.primaryKey ?? repo.primaryKey[0] ?? 'ID';
      const shouldAudit = !allowedTables || allowedTables.has(tbl);

      const extractKey = (rowOrKey: unknown): unknown => {
        if (rowOrKey && typeof rowOrKey === 'object') {
          const obj = rowOrKey as Record<string, unknown>;
          return obj[pk] ?? obj[pk.toUpperCase()] ?? obj[pk.toLowerCase()] ?? rowOrKey;
        }
        return rowOrKey;
      };

      return {
        ...repo,
        async insert(row) {
          const res = await repo.insert(row);
          if (shouldAudit) {
            await handle.record({
              table: tbl,
              op: 'INSERT',
              key: extractKey(row),
              before: null,
              after: row as Record<string, unknown>,
            });
          }
          return res;
        },
        async insertMany(rows) {
          const res = await repo.insertMany(rows);
          if (shouldAudit) {
            for (const row of rows) {
              await handle.record({
                table: tbl,
                op: 'INSERT',
                key: extractKey(row),
                before: null,
                after: row as Record<string, unknown>,
              });
            }
          }
          return res;
        },
        async update(id, patch) {
          const beforeRow = shouldAudit ? await repo.get(id) : null;
          const res = await repo.update(id, patch);
          if (shouldAudit && res.affectedRows > 0) {
            const afterRow = await repo.get(id);
            await handle.record({
              table: tbl,
              op: 'UPDATE',
              key: id,
              before: (beforeRow as Record<string, unknown> | null) ?? null,
              after:
                (afterRow as Record<string, unknown> | null) ??
                ({ ...(beforeRow ?? {}), ...(patch as Record<string, unknown>) }),
            });
          }
          return res;
        },
        async upsert(row) {
          const keyVal = extractKey(row) as K;
          const beforeRow =
            shouldAudit && keyVal !== undefined && keyVal !== null
              ? await repo.get(keyVal)
              : null;
          const res = await repo.upsert(row);
          if (shouldAudit) {
            await handle.record({
              table: tbl,
              op: beforeRow ? 'UPDATE' : 'INSERT',
              key: keyVal,
              before: (beforeRow as Record<string, unknown> | null) ?? null,
              after: row as Record<string, unknown>,
            });
          }
          return res;
        },
        async delete(id) {
          const beforeRow = shouldAudit ? await repo.get(id) : null;
          const res = await repo.delete(id);
          if (shouldAudit && res.affectedRows > 0) {
            await handle.record({
              table: tbl,
              op: 'DELETE',
              key: id,
              before: (beforeRow as Record<string, unknown> | null) ?? null,
              after: null,
            });
          }
          return res;
        },
      };
    },

    asReplicationHook(table = '*'): ReplicationIndexHook {
      const targetUpper = table.trim().toUpperCase();
      return {
        table: targetUpper,
        async onInsertOrUpdate(row, key) {
          const tblName = targetUpper === '*' ? 'REPLICATED' : targetUpper;
          if (allowedTables && targetUpper !== '*' && !allowedTables.has(tblName)) return;
          await handle.record({
            table: tblName,
            op: 'UPSERT',
            key,
            before: null,
            after: row,
          });
        },
        async onDelete(key, before) {
          const tblName = targetUpper === '*' ? 'REPLICATED' : targetUpper;
          if (allowedTables && targetUpper !== '*' && !allowedTables.has(tblName)) return;
          await handle.record({
            table: tblName,
            op: 'DELETE',
            key,
            before: before ?? null,
            after: null,
          });
        },
      };
    },

    async recordEntries(entries: readonly ReplicationLogEntry[]): Promise<void> {
      for (const e of entries) {
        const upper = e.table.trim().toUpperCase();
        if (allowedTables && !allowedTables.has(upper)) continue;
        await handle.record({
          table: upper,
          op: e.operation,
          key: e.key ?? null,
          before: e.before ?? null,
          after: e.after ?? null,
          ddlSql: e.ddlSql ?? undefined,
          actor: e.origin,
          timestamp: e.timestamp,
        });
      }
    },
  };

  return handle;
}
