/**
 * object-store-wal.ts – Zero-Server S3 / Cloudflare R2 / MinIO / HTTP Object-Store
 * WAL Shipping, Read-Replica Following & Point-in-Time Restore (`M20 Item 1`).
 *
 * Uses standard `fetch` + WebCrypto `crypto.subtle` (`AWS4-HMAC-SHA256`) with zero
 * external SDK dependencies so both Browser WASM and Node.js databases can ship
 * `.fdb` checkpoints and compressed/encrypted WAL segments directly to object storage.
 */

import {
  type BootstrapReplicaResult,
  type HlcTimestamp,
  type PublicationSnapshot,
  type PublishedTableConfig,
  type ReplicableDatabase,
  type ReplicationLogEntry,
  type ReplicationPublication,
} from './types';
import { compareHlc } from './hlc-crdt';
import {
  decodeEncryptedJournalSegment,
  encodeEncryptedJournalSegment,
} from './segments';
import {
  applyFbChangelogSegmentToDatabase,
  fbChangelogToLogicalEntries,
  logicalEntriesToFbChangelogSegment,
} from './native-changelog';
import {
  bootstrapReplica,
  compressGzipBytes,
  decompressGzipBytes,
  dropAllClonedReplicationTriggers,
} from './bootstrap';
import { createPublication } from './publication';
import { createSubscription } from './subscription';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// 1. Minimal Object-Store Adapter Interface & In-Memory Implementation
// ---------------------------------------------------------------------------

/** Pluggable object storage backend (S3, R2, MinIO, HTTP PUT/GET, or in-memory). */
export interface ObjectStoreAdapter {
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
  listObjects?(prefix?: string): Promise<string[]>;
  deleteObject?(key: string): Promise<void>;
}

/** Extended in-memory object store adapter for deterministic tests and demos (`M20 Item 1`). */
export interface MemoryObjectStoreAdapter extends ObjectStoreAdapter {
  readonly objects: ReadonlyMap<string, Uint8Array>;
  clear(): void;
}

/** Create an in-memory {@link ObjectStoreAdapter} (`M20 Item 1`). */
export function createMemoryObjectStoreAdapter(): MemoryObjectStoreAdapter {
  const map = new Map<string, Uint8Array>();
  return {
    objects: map,
    async putObject(key: string, body: Uint8Array): Promise<void> {
      map.set(normalizeKey(key), body.slice());
    },
    async getObject(key: string): Promise<Uint8Array | null> {
      const found = map.get(normalizeKey(key));
      return found ? found.slice() : null;
    },
    async listObjects(prefix = ''): Promise<string[]> {
      const norm = normalizeKey(prefix);
      return [...map.keys()].filter((k) => k.startsWith(norm)).sort();
    },
    async deleteObject(key: string): Promise<void> {
      map.delete(normalizeKey(key));
    },
    clear(): void {
      map.clear();
    },
  };
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, '');
}

function joinKey(prefix: string | undefined, key: string): string {
  const cleanPrefix = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  const cleanKey = normalizeKey(key);
  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

// ---------------------------------------------------------------------------
// 2. WebCrypto AWS Signature Version 4 (`AWS4-HMAC-SHA256`) & HTTP Adapter
// ---------------------------------------------------------------------------

/** S3 / Cloudflare R2 / MinIO credentials & endpoint configuration (`M20 Item 1`). */
export interface S3CompatibleStoreConfig {
  /** Endpoint origin (e.g. `'https://s3.us-east-1.amazonaws.com'` or `'https://<acct>.r2.cloudflarestorage.com'`). */
  endpoint: string;
  /** Bucket name. */
  bucket: string;
  /** Region name (use `'auto'` for Cloudflare R2, `'us-east-1'` for MinIO). @default 'auto' */
  region?: string;
  /** Access key ID. */
  accessKeyId: string;
  /** Secret access key. */
  secretAccessKey: string;
  /** Optional temporary STS session token (`x-amz-security-token`). */
  sessionToken?: string;
  /** Use path-style URLs (`<endpoint>/<bucket>/<key>`). @default true */
  forcePathStyle?: boolean;
}

/** Options for {@link createHttpObjectStoreAdapter} (`M20 Item 1`). */
export interface HttpObjectStoreAdapterOptions {
  /** Optional S3/R2/MinIO configuration signed via `AWS4-HMAC-SHA256`. */
  s3?: S3CompatibleStoreConfig;
  /** Plain HTTP base URL (`PUT <baseUrl>/<key>`, `GET <baseUrl>/<key>`) when not using `s3` or `resolveUrl`. */
  baseUrl?: string;
  /** Custom presigned URL resolver (`(method, key) => url | Promise<url>`). */
  resolveUrl?: (
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
  ) => string | Promise<string>;
  /** Static extra headers (e.g. `Authorization: Bearer ...`). */
  headers?: Readonly<Record<string, string>>;
  /** Custom `fetch` implementation. @default globalThis.fetch */
  fetch?: typeof globalThis.fetch;
}

function toHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as unknown as BufferSource,
  );
  return toHexLower(new Uint8Array(buf));
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const msgBytes = utf8Encoder.encode(message);
  const sig = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    msgBytes as unknown as BufferSource,
  );
  return new Uint8Array(sig);
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

/** Build a path-style or virtual-hosted-style S3/R2 object URL (`M20 Item 1`). */
export function buildS3ObjectUrl(config: S3CompatibleStoreConfig, key: string): string {
  const cleanKey = normalizeKey(key)
    .split('/')
    .map((seg) => encodeRfc3986(seg))
    .join('/');
  const parsed = new URL(config.endpoint);
  const forcePath = config.forcePathStyle ?? true;
  const basePath = parsed.pathname.replace(/\/+$/, '');
  if (forcePath) {
    parsed.pathname = `${basePath}/${encodeRfc3986(config.bucket)}/${cleanKey}`;
  } else {
    parsed.hostname = `${config.bucket}.${parsed.hostname}`;
    parsed.pathname = `${basePath}/${cleanKey}`;
  }
  return parsed.toString();
}

/** Input options for {@link signAwsSigV4Headers} (`M20 Item 1`). */
export interface SignAwsSigV4Options {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  url: string;
  region?: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  body?: Uint8Array;
  headers?: Readonly<Record<string, string>>;
  now?: Date;
}

/**
 * Compute `AWS4-HMAC-SHA256` request headers using WebCrypto `crypto.subtle` (`M20 Item 1`).
 */
export async function signAwsSigV4Headers(
  options: SignAwsSigV4Options,
): Promise<Record<string, string>> {
  const parsedUrl = new URL(options.url);
  const region = options.region ?? 'auto';
  const service = options.service ?? 's3';
  const { amzDate, dateStamp } = formatAmzDate(options.now ?? new Date());
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array(0));

  const headerMap = new Map<string, string>();
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headerMap.set(k.toLowerCase().trim(), v.trim());
    }
  }
  headerMap.set('host', parsedUrl.host);
  headerMap.set('x-amz-content-sha256', payloadHash);
  headerMap.set('x-amz-date', amzDate);
  if (options.sessionToken) {
    headerMap.set('x-amz-security-token', options.sessionToken);
  }

  const sortedHeaderNames = [...headerMap.keys()].sort();
  const canonicalHeaders = sortedHeaderNames
    .map((k) => `${k}:${headerMap.get(k)!}\n`)
    .join('');
  const signedHeaders = sortedHeaderNames.join(';');

  const queryPairs: Array<[string, string]> = [];
  parsedUrl.searchParams.forEach((v, k) => {
    queryPairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  });
  queryPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    options.method,
    parsedUrl.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256Hex(utf8Encoder.encode(canonicalRequest));
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  const kDate = await hmacSha256(utf8Encoder.encode(`AWS4${options.secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHexLower(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = {};
  for (const [k, v] of headerMap.entries()) {
    if (k === 'host') continue;
    outHeaders[k] = v;
  }
  outHeaders.Authorization = authorization;
  return outHeaders;
}

/**
 * Create an HTTP / S3 / Cloudflare R2 / MinIO {@link ObjectStoreAdapter} (`M20 Item 1`).
 */
export function createHttpObjectStoreAdapter(
  options: HttpObjectStoreAdapterOptions,
): ObjectStoreAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createHttpObjectStoreAdapter requires a fetch implementation');
  }

  const resolveRequest = async (
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    body?: Uint8Array,
    contentType?: string,
  ): Promise<{ url: string; headers: Record<string, string> }> => {
    const baseHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    if (contentType) {
      baseHeaders['content-type'] = contentType;
    }

    if (options.s3) {
      const url = buildS3ObjectUrl(options.s3, key);
      const signed = await signAwsSigV4Headers({
        method,
        url,
        region: options.s3.region ?? 'auto',
        accessKeyId: options.s3.accessKeyId,
        secretAccessKey: options.s3.secretAccessKey,
        sessionToken: options.s3.sessionToken,
        body,
        headers: baseHeaders,
      });
      return { url, headers: signed };
    }

    if (options.resolveUrl) {
      const url = await options.resolveUrl(method, key);
      return { url, headers: baseHeaders };
    }

    if (options.baseUrl) {
      const base = options.baseUrl.replace(/\/+$/, '');
      const cleanKey = normalizeKey(key)
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/');
      return { url: `${base}/${cleanKey}`, headers: baseHeaders };
    }

    throw new Error(
      'createHttpObjectStoreAdapter requires one of `s3`, `resolveUrl`, or `baseUrl`',
    );
  };

  return {
    async putObject(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
      const { url, headers } = await resolveRequest('PUT', key, body, contentType);
      const resp = await fetchImpl(url, {
        method: 'PUT',
        headers,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit,
      });
      if (!resp.ok) {
        throw new Error(`Object store PUT "${key}" failed with HTTP ${resp.status}`);
      }
    },

    async getObject(key: string): Promise<Uint8Array | null> {
      const { url, headers } = await resolveRequest('GET', key);
      const resp = await fetchImpl(url, { method: 'GET', headers });
      if (resp.status === 404) {
        return null;
      }
      if (!resp.ok) {
        throw new Error(`Object store GET "${key}" failed with HTTP ${resp.status}`);
      }
      return new Uint8Array(await resp.arrayBuffer());
    },

    async deleteObject(key: string): Promise<void> {
      const { url, headers } = await resolveRequest('DELETE', key);
      const resp = await fetchImpl(url, { method: 'DELETE', headers });
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`Object store DELETE "${key}" failed with HTTP ${resp.status}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Object-Store WAL Manifest, Checkpoint Shipping & PITR Restore
// ---------------------------------------------------------------------------

/** Metadata for a base `.fdb` or logical checkpoint stored in object storage (`M20 Item 1`). */
export interface ObjectStoreCheckpointDescriptor {
  readonly id: string;
  readonly key: string;
  readonly lsn: number;
  readonly timestamp: number;
  readonly mode: 'binary-image' | 'logical';
  readonly compressed: boolean;
  readonly byteLength: number;
}

/** Metadata for a shipped WAL segment stored in object storage (`M20 Item 1`). */
export interface ObjectStoreWalSegmentDescriptor {
  readonly sequence: number;
  readonly key: string;
  readonly format: 'fbchangelog' | 'encrypted-journal';
  readonly startLsn: number;
  readonly endLsn: number;
  readonly minTimestamp: number;
  readonly maxTimestamp: number;
  readonly minHlc?: string;
  readonly maxHlc?: string;
  readonly entryCount: number;
  readonly compressed: boolean;
  readonly encrypted: boolean;
  readonly byteLength: number;
}

/** Root `manifest.json` maintained by {@link createObjectStoreReplicationTarget} (`M20 Item 1`). */
export interface ObjectStoreWalManifest {
  readonly format: 'firebird-wal-v1';
  readonly publication: string;
  readonly updatedAt: number;
  readonly latestLsn: number;
  readonly latestSequence: number;
  readonly checkpoints: readonly ObjectStoreCheckpointDescriptor[];
  readonly segments: readonly ObjectStoreWalSegmentDescriptor[];
}

/** Options for {@link createObjectStoreReplicationTarget} (`M20 Item 1`). */
export interface ObjectStoreReplicationTargetOptions {
  /** Source database (`FirebirdBrowser` or `FirebirdLite`). */
  db: ReplicableDatabase & {
    dumpDataDir?(): Promise<Uint8Array>;
  };
  /** Object store adapter (or pass `http` to build one automatically). */
  store?: ObjectStoreAdapter;
  /** Convenience HTTP/S3/R2 configuration when `store` is omitted. */
  http?: HttpObjectStoreAdapterOptions;
  /** Optional key prefix inside the bucket (e.g. `'tenants/acme'`). */
  prefix?: string;
  /** Existing publication (or pass `tables` to provision one automatically). */
  publication?: ReplicationPublication;
  /** Tables to publish when `publication` is omitted. @default '*' */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Install capture triggers when creating a publication automatically. @default false */
  installTriggers?: boolean;
  /** WAL segment wire format (`'encrypted-journal'` supports AES-256-GCM + exact LSN/HLC PITR; `'fbchangelog'` emits native Firebird `"FBCHANGELOG\0"`). @default 'encrypted-journal' */
  segmentFormat?: 'encrypted-journal' | 'fbchangelog';
  /** Checkpoint format (`'auto'` uses `'binary-image'` when `db.dumpDataDir` exists, else `'logical'`). @default 'auto' */
  checkpointMode?: 'auto' | 'binary-image' | 'logical';
  /** Compress checkpoints and WAL segments with Gzip. @default true */
  compress?: boolean;
  /** Optional AES-256-GCM encryption key for `'encrypted-journal'` WAL segments. */
  encryptionKey?: Uint8Array | CryptoKey | string;
  /** Optional Additional Authenticated Data (AAD) for AES-256-GCM WAL encryption. */
  aad?: Uint8Array | string;
  /** Maximum journal entries per shipped WAL segment. @default 250 */
  maxEntriesPerSegment?: number;
  /** Background shipping interval in milliseconds when `start()` is called. @default 1000 */
  pollIntervalMs?: number;
}

/** Handle for a read-replica tailing an object-store WAL bucket (`M20 Item 1`). */
export interface ObjectStoreReplicaFollower {
  /** Check `manifest.json`, bootstrap if needed, and replay any new WAL segments once. */
  followOnce(): Promise<{
    bootstrapped: boolean;
    segmentsApplied: number;
    entriesApplied: number;
    currentLsn: number;
  }>;
  /** Start periodic polling (`pollIntervalMs`). */
  start(intervalMs?: number): void;
  /** Stop periodic polling. */
  stop(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Active object-store WAL shipping target returned by {@link createObjectStoreReplicationTarget} (`M20 Item 1`). */
export interface ObjectStoreReplicationTarget {
  readonly store: ObjectStoreAdapter;
  readonly publication: ReplicationPublication;
  /** Fetch the current `manifest.json` from object storage (or an empty initial manifest). */
  getManifest(): Promise<ObjectStoreWalManifest>;
  /** Upload a new base `.fdb` (`'binary-image'`) or `'logical'` checkpoint and update `manifest.json`. */
  createCheckpoint(options?: {
    mode?: 'binary-image' | 'logical';
  }): Promise<ObjectStoreCheckpointDescriptor>;
  /** Capture & upload all unshipped journal changes (`> manifest.latestLsn`) as WAL segment(s). */
  shipWalOnce(): Promise<readonly ObjectStoreWalSegmentDescriptor[]>;
  /** Tail this object-store WAL target into `replicaDb` with zero custom sync server. */
  followInto(
    replicaDb: ReplicableDatabase & {
      loadDataStream?(
        stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
        options?: { compression?: 'gzip' | 'none' },
      ): Promise<void>;
    },
    options?: {
      pollIntervalMs?: number;
      decryptionKey?: Uint8Array | CryptoKey | string;
      aad?: Uint8Array | string;
    },
  ): Promise<ObjectStoreReplicaFollower>;
  /** Start continuous background WAL shipping. */
  start(intervalMs?: number): void;
  /** Stop continuous background WAL shipping. */
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Provision an object-store WAL archiver & replication target (`M20 Item 1`).
 */
export async function createObjectStoreReplicationTarget(
  options: ObjectStoreReplicationTargetOptions,
): Promise<ObjectStoreReplicationTarget> {
  const store =
    options.store ??
    (options.http ? createHttpObjectStoreAdapter(options.http) : undefined);
  if (!store) {
    throw new Error(
      'createObjectStoreReplicationTarget requires either `store` or `http` options',
    );
  }

  const publication =
    options.publication ??
    (await createPublication(options.db, {
      name: 'pub_object_store',
      tables: options.tables ?? '*',
      installTriggers: options.installTriggers ?? false,
    }));

  const manifestKey = joinKey(options.prefix, 'manifest.json');
  const segmentFormat = options.segmentFormat ?? 'encrypted-journal';
  const compress = options.compress ?? true;
  const maxPerSeg = Math.max(1, options.maxEntriesPerSegment ?? 250);
  let timer: ReturnType<typeof setInterval> | null = null;
  let shippingPromise: Promise<unknown> | null = null;

  const readManifest = async (): Promise<ObjectStoreWalManifest> => {
    const raw = await store.getObject(manifestKey);
    if (!raw) {
      return {
        format: 'firebird-wal-v1',
        publication: publication.name,
        updatedAt: Date.now(),
        latestLsn: 0,
        latestSequence: 0,
        checkpoints: [],
        segments: [],
      };
    }
    return JSON.parse(utf8Decoder.decode(raw)) as ObjectStoreWalManifest;
  };

  const writeManifest = async (manifest: ObjectStoreWalManifest): Promise<void> => {
    const bytes = utf8Encoder.encode(JSON.stringify(manifest, null, 2));
    await store.putObject(manifestKey, bytes, 'application/json');
  };

  const target: ObjectStoreReplicationTarget = {
    store,
    publication,

    getManifest: readManifest,

    async createCheckpoint(ckptOpts = {}): Promise<ObjectStoreCheckpointDescriptor> {
      const manifest = await readManifest();
      const canDumpBinary = typeof options.db.dumpDataDir === 'function';
      const resolvedMode: 'binary-image' | 'logical' =
        ckptOpts.mode ??
        (options.checkpointMode === 'binary-image'
          ? 'binary-image'
          : options.checkpointMode === 'logical'
            ? 'logical'
            : canDumpBinary
              ? 'binary-image'
              : 'logical');

      const snapshot = await publication.exportSnapshot({
        bootstrapStrategy: resolvedMode,
        mode: resolvedMode,
        compressGzip: resolvedMode === 'binary-image' ? compress : false,
      });

      const ts = Date.now();
      const id = `ckpt-${manifest.checkpoints.length + 1}-lsn-${snapshot.watermarkLsn}`;
      let bodyBytes: Uint8Array;
      let isCompressed = false;

      if (resolvedMode === 'binary-image' && snapshot.databaseImageBytes) {
        bodyBytes = snapshot.databaseImageBytes;
        isCompressed = Boolean(snapshot.imageGzipped);
      } else {
        const jsonBytes = utf8Encoder.encode(JSON.stringify(snapshot));
        bodyBytes = compress ? await compressGzipBytes(jsonBytes) : jsonBytes;
        isCompressed = compress && bodyBytes !== jsonBytes;
      }

      const ext = resolvedMode === 'binary-image' ? 'fdb' : 'snapshot.json';
      const key = joinKey(
        options.prefix,
        `checkpoints/${id}.${ext}${isCompressed ? '.gz' : ''}`,
      );
      await store.putObject(key, bodyBytes, 'application/octet-stream');

      const descriptor: ObjectStoreCheckpointDescriptor = {
        id,
        key,
        lsn: snapshot.watermarkLsn,
        timestamp: ts,
        mode: resolvedMode,
        compressed: isCompressed,
        byteLength: bodyBytes.byteLength,
      };

      await writeManifest({
        ...manifest,
        updatedAt: ts,
        latestLsn: Math.max(manifest.latestLsn, snapshot.watermarkLsn),
        checkpoints: [...manifest.checkpoints, descriptor],
      });

      return descriptor;
    },

    async shipWalOnce(): Promise<readonly ObjectStoreWalSegmentDescriptor[]> {
      await publication.captureTableChanges();
      const manifest = await readManifest();
      const pending = await publication.fetchChangesSince(manifest.latestLsn);
      if (pending.length === 0) {
        return [];
      }

      const uploaded: ObjectStoreWalSegmentDescriptor[] = [];
      let nextSeq = manifest.latestSequence;
      let highestLsn = manifest.latestLsn;

      for (let i = 0; i < pending.length; i += maxPerSeg) {
        const chunk = pending.slice(i, i + maxPerSeg);
        nextSeq++;
        const startLsn = chunk[0]!.lsn;
        const endLsn = chunk[chunk.length - 1]!.lsn;
        const minTimestamp = Math.min(...chunk.map((e) => e.timestamp));
        const maxTimestamp = Math.max(...chunk.map((e) => e.timestamp));
        const hlcs = chunk
          .map((e) => e.hlc)
          .filter((h): h is string => typeof h === 'string' && h.length > 0)
          .sort((a, b) => compareHlc(a, b));

        let segBytes: Uint8Array;
        let isCompressed = false;
        let isEncrypted = false;

        if (segmentFormat === 'fbchangelog' && !options.encryptionKey) {
          const rawChangelog = logicalEntriesToFbChangelogSegment(chunk, {
            sequence: nextSeq,
            recordEncoding: 'sql',
          });
          segBytes = compress ? await compressGzipBytes(rawChangelog) : rawChangelog;
          isCompressed = compress && segBytes !== rawChangelog;
        } else {
          segBytes = await encodeEncryptedJournalSegment(chunk, {
            sequence: nextSeq,
            state: 'archivable',
            compress,
            key: options.encryptionKey,
            aad: options.aad,
          });
          isCompressed = compress;
          isEncrypted = options.encryptionKey !== undefined;
        }

        const ext =
          segmentFormat === 'fbchangelog' && !options.encryptionKey
            ? `fbchangelog${isCompressed ? '.gz' : ''}`
            : 'fbrseg';
        const key = joinKey(
          options.prefix,
          `wal/seg-${String(nextSeq).padStart(6, '0')}-lsn-${startLsn}-${endLsn}.${ext}`,
        );
        await store.putObject(key, segBytes, 'application/octet-stream');

        highestLsn = Math.max(highestLsn, endLsn);
        uploaded.push({
          sequence: nextSeq,
          key,
          format:
            segmentFormat === 'fbchangelog' && !options.encryptionKey
              ? 'fbchangelog'
              : 'encrypted-journal',
          startLsn,
          endLsn,
          minTimestamp,
          maxTimestamp,
          ...(hlcs.length > 0
            ? { minHlc: hlcs[0]!, maxHlc: hlcs[hlcs.length - 1]! }
            : {}),
          entryCount: chunk.length,
          compressed: isCompressed,
          encrypted: isEncrypted,
          byteLength: segBytes.byteLength,
        });
      }

      await writeManifest({
        ...manifest,
        updatedAt: Date.now(),
        latestLsn: highestLsn,
        latestSequence: nextSeq,
        segments: [...manifest.segments, ...uploaded],
      });

      return uploaded;
    },

    async followInto(replicaDb, followOpts = {}): Promise<ObjectStoreReplicaFollower> {
      let sub = await createSubscription(replicaDb, {
        name: `obj_follow_${publication.name}`,
        nodeId: 'object_store_follower',
        publication: {
          name: publication.name,
          fetchChangesSince: async () => [],
        },
      });
      let followTimer: ReturnType<typeof setInterval> | null = null;
      let initialized = (await sub.getWatermark()) > 0;

      const follower: ObjectStoreReplicaFollower = {
        async followOnce() {
          const manifest = await readManifest();
          let bootstrapped = false;
          let currentLsn = await sub.getWatermark();

          if (!initialized && manifest.checkpoints.length > 0) {
            const latestCkpt = manifest.checkpoints[manifest.checkpoints.length - 1]!;
            await applyCheckpointToDatabase(store, latestCkpt, replicaDb, manifest.publication);
            sub = await createSubscription(replicaDb, {
              name: `obj_follow_${publication.name}`,
              nodeId: 'object_store_follower',
              publication: {
                name: publication.name,
                fetchChangesSince: async () => [],
              },
            });
            await sub.setWatermark(latestCkpt.lsn);
            currentLsn = latestCkpt.lsn;
            initialized = true;
            bootstrapped = true;
          } else {
            initialized = true;
          }

          let segmentsApplied = 0;
          let entriesApplied = 0;
          for (const segDesc of manifest.segments) {
            if (segDesc.endLsn <= currentLsn) continue;
            const raw = await store.getObject(segDesc.key);
            if (!raw) continue;

            if (segDesc.format === 'fbchangelog') {
              const changelogBytes = segDesc.compressed
                ? await decompressGzipBytes(raw)
                : raw;
              const res = await applyFbChangelogSegmentToDatabase(replicaDb, changelogBytes);
              entriesApplied += res.entriesApplied || res.ddlExecuted.length || segDesc.entryCount;
              currentLsn = segDesc.endLsn;
              await sub.setWatermark(currentLsn);
            } else {
              const decoded = await decodeEncryptedJournalSegment(raw, {
                key: followOpts.decryptionKey ?? options.encryptionKey,
                aad: followOpts.aad ?? options.aad,
              });
              const unseen = decoded.segment.entries.filter((e) => e.lsn > currentLsn);
              if (unseen.length > 0) {
                const res = await sub.applyChanges(unseen);
                entriesApplied += res.appliedCount;
                currentLsn = Math.max(currentLsn, segDesc.endLsn);
                await sub.setWatermark(currentLsn);
              }
            }
            segmentsApplied++;
          }

          return {
            bootstrapped,
            segmentsApplied,
            entriesApplied,
            currentLsn,
          };
        },

        start(intervalMs = followOpts.pollIntervalMs ?? 1000) {
          if (followTimer) return;
          followTimer = setInterval(() => {
            void follower.followOnce().catch(() => undefined);
          }, intervalMs);
        },

        stop() {
          if (followTimer) {
            clearInterval(followTimer);
            followTimer = null;
          }
        },

        async [Symbol.asyncDispose]() {
          follower.stop();
        },
      };

      return follower;
    },

    start(intervalMs = options.pollIntervalMs ?? 1000) {
      if (timer) return;
      timer = setInterval(() => {
        if (!shippingPromise) {
          shippingPromise = target
            .shipWalOnce()
            .catch(() => undefined)
            .finally(() => {
              shippingPromise = null;
            });
        }
      }, intervalMs);
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (shippingPromise) {
        await shippingPromise;
      }
    },

    async [Symbol.asyncDispose]() {
      await target.stop();
    },
  };

  return target;
}

async function applyCheckpointToDatabase(
  store: ObjectStoreAdapter,
  ckpt: ObjectStoreCheckpointDescriptor,
  targetDb: ReplicableDatabase & {
    loadDataStream?(
      stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
      options?: { compression?: 'gzip' | 'none' },
    ): Promise<void>;
  },
  publicationName: string,
): Promise<BootstrapReplicaResult> {
  const bytes = await store.getObject(ckpt.key);
  if (!bytes) {
    throw new Error(`Checkpoint object "${ckpt.key}" was not found in object store`);
  }

  if (ckpt.mode === 'binary-image') {
    if (typeof targetDb.loadDataStream !== 'function') {
      throw new Error(
        `Restoring binary checkpoint "${ckpt.id}" requires targetDb.loadDataStream()`,
      );
    }
    await targetDb.loadDataStream(singleChunk(bytes), {
      compression: ckpt.compressed ? 'gzip' : 'none',
    });
    await dropAllClonedReplicationTriggers(targetDb);
    return {
      mode: 'binary-image',
      watermarkLsn: ckpt.lsn,
      tablesBootstrapped: 0,
      rowsCopied: 0,
      bytesTransferred: bytes.byteLength,
    };
  }

  const rawJson = ckpt.compressed ? await decompressGzipBytes(bytes) : bytes;
  const snapshot = JSON.parse(utf8Decoder.decode(rawJson)) as PublicationSnapshot;
  const tempSub = await createSubscription(targetDb, {
    name: `ckpt_restore_${publicationName}`,
    nodeId: 'ckpt_restore_node',
    publication: {
      name: publicationName,
      fetchChangesSince: async () => [],
    },
  });
  return bootstrapReplica({
    targetDb,
    publication: { exportSnapshot: async () => snapshot },
    subscription: tempSub,
    snapshot,
  });
}

/** Cutoff specification for {@link restoreDatabaseToPointInTime} (`M20 Item 1`). */
export interface ObjectStorePitrTarget {
  /** Replay WAL entries with `lsn <= lsn`. */
  lsn?: number;
  /** Replay WAL entries with `timestamp <= timestamp`. */
  timestamp?: number;
  /** Replay WAL entries with `compareHlc(entry.hlc, hlc) <= 0`. */
  hlc?: string | HlcTimestamp;
  /** Replay WAL segments with `sequence <= sequence`. */
  sequence?: number;
}

/** Options for {@link restoreDatabaseToPointInTime} (`M20 Item 1`). */
export interface RestoreDatabaseToPointInTimeOptions {
  /** Target database to restore into (`FirebirdBrowser` or `FirebirdLite`). */
  targetDb: ReplicableDatabase & {
    loadDataStream?(
      stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
      options?: { compression?: 'gzip' | 'none' },
    ): Promise<void>;
  };
  /** Object store adapter (or pass `http`). */
  store?: ObjectStoreAdapter;
  /** Convenience HTTP/S3/R2 configuration when `store` is omitted. */
  http?: HttpObjectStoreAdapterOptions;
  /** Bucket key prefix matching {@link createObjectStoreReplicationTarget}. */
  prefix?: string;
  /** Optional Point-in-Time Recovery cutoff (restores to latest head when omitted). */
  target?: number | ObjectStorePitrTarget;
  /** Decryption key when WAL segments were AES-256-GCM encrypted. */
  decryptionKey?: Uint8Array | CryptoKey | string;
  /** Optional AAD when WAL segments were encrypted with AAD. */
  aad?: Uint8Array | string;
}

/** Result returned by {@link restoreDatabaseToPointInTime} (`M20 Item 1`). */
export interface RestoreDatabaseToPointInTimeResult {
  readonly checkpointUsed: string | null;
  readonly checkpointLsn: number;
  readonly segmentsReplayed: number;
  readonly entriesApplied: number;
  readonly restoredToLsn: number;
}

function matchesPitrTarget(
  entry: ReplicationLogEntry,
  target: ObjectStorePitrTarget | null,
): boolean {
  if (!target) return true;
  if (target.lsn !== undefined && entry.lsn > target.lsn) return false;
  if (target.timestamp !== undefined && entry.timestamp > target.timestamp) return false;
  if (target.hlc !== undefined) {
    if (!entry.hlc) return false;
    if (compareHlc(entry.hlc, target.hlc) > 0) return false;
  }
  return true;
}

/**
 * Restore a database from an object-store checkpoint + WAL segment chain up to an
 * exact LSN, epoch timestamp, HLC, or segment sequence (`M20 Item 1`).
 */
export async function restoreDatabaseToPointInTime(
  options: RestoreDatabaseToPointInTimeOptions,
): Promise<RestoreDatabaseToPointInTimeResult> {
  const store =
    options.store ??
    (options.http ? createHttpObjectStoreAdapter(options.http) : undefined);
  if (!store) {
    throw new Error('restoreDatabaseToPointInTime requires either `store` or `http`');
  }

  const manifestRaw = await store.getObject(joinKey(options.prefix, 'manifest.json'));
  if (!manifestRaw) {
    throw new Error('Object store WAL manifest.json not found');
  }
  const manifest = JSON.parse(utf8Decoder.decode(manifestRaw)) as ObjectStoreWalManifest;
  const spec: ObjectStorePitrTarget | null =
    options.target === undefined
      ? null
      : typeof options.target === 'number'
        ? { lsn: options.target }
        : options.target;

  // Pick the highest-LSN checkpoint eligible for the requested PITR cutoff
  let chosenCkpt: ObjectStoreCheckpointDescriptor | null = null;
  for (const ckpt of manifest.checkpoints) {
    if (spec?.lsn !== undefined && ckpt.lsn > spec.lsn) continue;
    if (spec?.timestamp !== undefined && ckpt.timestamp > spec.timestamp) continue;
    if (!chosenCkpt || ckpt.lsn >= chosenCkpt.lsn) {
      chosenCkpt = ckpt;
    }
  }

  let currentLsn = 0;
  if (chosenCkpt) {
    await applyCheckpointToDatabase(
      store,
      chosenCkpt,
      options.targetDb,
      manifest.publication,
    );
    currentLsn = chosenCkpt.lsn;
  }

  const sub = await createSubscription(options.targetDb, {
    name: `pitr_wal_${manifest.publication}`,
    nodeId: 'pitr_wal_restore',
    publication: {
      name: manifest.publication,
      fetchChangesSince: async () => [],
    },
  });
  await sub.setWatermark(currentLsn);

  let segmentsReplayed = 0;
  let entriesApplied = 0;

  for (const segDesc of manifest.segments) {
    if (segDesc.endLsn <= currentLsn) continue;
    if (spec?.sequence !== undefined && segDesc.sequence > spec.sequence) break;
    if (spec?.lsn !== undefined && segDesc.startLsn > spec.lsn) break;

    const raw = await store.getObject(segDesc.key);
    if (!raw) {
      throw new Error(`Missing WAL segment "${segDesc.key}" in object store`);
    }

    if (segDesc.format === 'fbchangelog') {
      const changelogBytes = segDesc.compressed ? await decompressGzipBytes(raw) : raw;
      if (!spec || (spec.lsn === undefined && spec.timestamp === undefined && spec.hlc === undefined)) {
        const res = await applyFbChangelogSegmentToDatabase(options.targetDb, changelogBytes);
        entriesApplied += res.entriesApplied || res.ddlExecuted.length || segDesc.entryCount;
        currentLsn = Math.max(currentLsn, segDesc.endLsn);
        segmentsReplayed++;
      } else {
        const logical = fbChangelogToLogicalEntries(changelogBytes);
        const eligible = logical.entries
          .map((e, idx) => ({
            ...e,
            lsn: segDesc.startLsn + idx,
            timestamp: segDesc.minTimestamp,
          }))
          .filter((e) => e.lsn > currentLsn && matchesPitrTarget(e, spec));
        if (eligible.length > 0) {
          const pullRes = await sub.applyChanges(eligible);
          entriesApplied += pullRes.appliedCount;
          currentLsn = Math.max(currentLsn, eligible[eligible.length - 1]!.lsn);
          segmentsReplayed++;
        }
      }
    } else {
      const decoded = await decodeEncryptedJournalSegment(raw, {
        key: options.decryptionKey,
        aad: options.aad,
      });
      const eligible = decoded.segment.entries.filter(
        (e) => e.lsn > currentLsn && matchesPitrTarget(e, spec),
      );
      if (eligible.length > 0) {
        const pullRes = await sub.applyChanges(eligible);
        entriesApplied += pullRes.appliedCount;
        currentLsn = Math.max(currentLsn, eligible[eligible.length - 1]!.lsn);
        segmentsReplayed++;
      }
    }
  }

  await sub.setWatermark(currentLsn);
  return {
    checkpointUsed: chosenCkpt?.id ?? null,
    checkpointLsn: chosenCkpt?.lsn ?? 0,
    segmentsReplayed,
    entriesApplied,
    restoredToLsn: currentLsn,
  };
}
