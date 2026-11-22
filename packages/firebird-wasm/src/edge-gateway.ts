/**
 * edge-gateway.ts – WinterCG Edge HTTP SQL / Transactional Batch Gateway
 * (`createEdgeSqlGateway`) & Chunked Key-Value Page VFS (`KeyValuePageVFS`) (`M29 Item 4`).
 *
 * Compatible with Cloudflare Workers / Durable Objects, Deno Deploy, Bun, and Node.js.
 */

import { encodeArrowIpc, rowsToColumnarResult } from './columnar';
import { sha256HexSync } from './rag-ingester';
import { verifySyncJwt, type JwksKeyProvider } from './replication/jwt-auth';
import type {
  ArrayRow,
  FieldInfo,
  QueryParams,
  QueryResult,
  Row,
  TransactionOptions,
} from './types';

// ---------------------------------------------------------------------------
// 1. Chunked Key-Value Page VFS (`KeyValuePageVFS`) for Durable Objects / KV
// ---------------------------------------------------------------------------

/** Minimal async KV storage interface (matches Cloudflare Durable Object `ctx.storage` & WinterCG KV). */
export interface AsyncKeyValueStore {
  get(key: string): Promise<Uint8Array | ArrayBuffer | null | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  putBatch?(entries: Readonly<Record<string, Uint8Array>>): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export interface KeyValuePageVFSOptions {
  /** Firebird page size in bytes. @default 8192 */
  readonly pageSize?: number;
  /** Number of pages packed into one KV entry (`4 * 8192 = 32 KB` <= Cloudflare DO 128 KB limit). @default 4 */
  readonly pagesPerChunk?: number;
  /** Key namespace prefix. @default 'fb_vfs:' */
  readonly keyPrefix?: string;
}

/**
 * Chunked page-level Virtual File System adapter mapping fixed-size Firebird `.fdb`
 * pages onto an {@link AsyncKeyValueStore} (such as Cloudflare Durable Objects
 * `state.storage` or Deno KV) with dirty-chunk coalescing (`M29 Item 4`).
 */
export class KeyValuePageVFS {
  readonly pageSize: number;
  readonly pagesPerChunk: number;
  readonly chunkSize: number;
  readonly keyPrefix: string;
  private readonly store: AsyncKeyValueStore;
  private pageCountVal = 0;
  private readonly chunkCache = new Map<number, Uint8Array>();
  private readonly dirtyChunks = new Set<number>();
  private metaDirty = false;

  constructor(store: AsyncKeyValueStore, options: KeyValuePageVFSOptions = {}) {
    this.store = store;
    this.pageSize = options.pageSize ?? 8192;
    this.pagesPerChunk = Math.max(1, options.pagesPerChunk ?? 4);
    this.chunkSize = this.pageSize * this.pagesPerChunk;
    this.keyPrefix = options.keyPrefix ?? 'fb_vfs:';
  }

  get pageCount(): number {
    return this.pageCountVal;
  }

  get dirtyChunkCount(): number {
    return this.dirtyChunks.size;
  }

  private metaKey(): string {
    return `${this.keyPrefix}meta`;
  }

  private chunkKey(chunkIdx: number): string {
    return `${this.keyPrefix}chunk:${String(chunkIdx).padStart(8, '0')}`;
  }

  async open(): Promise<void> {
    const rawMeta = await this.store.get(this.metaKey());
    if (!rawMeta) {
      this.pageCountVal = 0;
      return;
    }
    const bytes = rawMeta instanceof Uint8Array ? rawMeta : new Uint8Array(rawMeta);
    if (bytes.byteLength >= 4) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pageCountVal = dv.getUint32(0, true);
    }
  }

  private async loadChunk(chunkIdx: number): Promise<Uint8Array> {
    const cached = this.chunkCache.get(chunkIdx);
    if (cached) return cached;
    const raw = await this.store.get(this.chunkKey(chunkIdx));
    const buf = new Uint8Array(this.chunkSize);
    if (raw) {
      const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      buf.set(src.subarray(0, Math.min(src.byteLength, this.chunkSize)));
    }
    this.chunkCache.set(chunkIdx, buf);
    return buf;
  }

  async readPage(pageNo: number): Promise<Uint8Array> {
    if (pageNo < 0) throw new RangeError(`Invalid pageNo: ${pageNo}`);
    const out = new Uint8Array(this.pageSize);
    if (pageNo >= this.pageCountVal) return out;
    const chunkIdx = Math.floor(pageNo / this.pagesPerChunk);
    const slotOffset = (pageNo % this.pagesPerChunk) * this.pageSize;
    const chunk = await this.loadChunk(chunkIdx);
    out.set(chunk.subarray(slotOffset, slotOffset + this.pageSize));
    return out;
  }

  async writePage(pageNo: number, pageBytes: Uint8Array): Promise<void> {
    if (pageBytes.byteLength !== this.pageSize) {
      throw new RangeError(
        `Page byteLength (${pageBytes.byteLength}) must match pageSize (${this.pageSize})`,
      );
    }
    const chunkIdx = Math.floor(pageNo / this.pagesPerChunk);
    const slotOffset = (pageNo % this.pagesPerChunk) * this.pageSize;
    const chunk = await this.loadChunk(chunkIdx);
    chunk.set(pageBytes, slotOffset);
    this.dirtyChunks.add(chunkIdx);
    if (pageNo + 1 > this.pageCountVal) {
      this.pageCountVal = pageNo + 1;
      this.metaDirty = true;
    }
  }

  async flushDirtyPages(): Promise<{ chunksWritten: number }> {
    const entries: Record<string, Uint8Array> = {};
    let chunksWritten = 0;

    for (const chunkIdx of this.dirtyChunks) {
      const chunk = this.chunkCache.get(chunkIdx);
      if (!chunk) continue;
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      entries[this.chunkKey(chunkIdx)] = copy;
      chunksWritten++;
    }

    if (this.metaDirty || chunksWritten > 0) {
      const meta = new Uint8Array(8);
      const dv = new DataView(meta.buffer);
      dv.setUint32(0, this.pageCountVal, true);
      dv.setUint32(4, this.pageSize, true);
      entries[this.metaKey()] = meta;
    }

    const keys = Object.keys(entries);
    if (keys.length > 0) {
      if (typeof this.store.putBatch === 'function') {
        await this.store.putBatch(entries);
      } else {
        for (const k of keys) {
          await this.store.put(k, entries[k]!);
        }
      }
    }

    this.dirtyChunks.clear();
    this.metaDirty = false;
    return { chunksWritten };
  }

  async importDatabase(image: Uint8Array): Promise<void> {
    if (image.byteLength % this.pageSize !== 0) {
      throw new RangeError(
        `Database image (${image.byteLength} B) is not a multiple of pageSize (${this.pageSize} B)`,
      );
    }
    const oldChunkCount = Math.ceil(this.pageCountVal / this.pagesPerChunk);
    const nextPages = image.byteLength / this.pageSize;
    const nextChunks = Math.ceil(nextPages / this.pagesPerChunk);

    this.chunkCache.clear();
    this.dirtyChunks.clear();
    for (let p = 0; p < nextPages; p++) {
      await this.writePage(p, image.subarray(p * this.pageSize, (p + 1) * this.pageSize));
    }
    this.pageCountVal = nextPages;
    this.metaDirty = true;
    await this.flushDirtyPages();

    for (let c = nextChunks; c < oldChunkCount; c++) {
      await this.store.delete(this.chunkKey(c));
    }
  }

  async exportDatabase(): Promise<Uint8Array> {
    const total = this.pageCountVal * this.pageSize;
    const out = new Uint8Array(total);
    for (let p = 0; p < this.pageCountVal; p++) {
      const page = await this.readPage(p);
      out.set(page, p * this.pageSize);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 2. WinterCG Edge SQL & Batch Pipeline Gateway (`createEdgeSqlGateway`)
// ---------------------------------------------------------------------------

export interface EdgeGatewayDatabase {
  query<T = Row>(
    sql: string,
    params?: QueryParams,
    options?: { rowMode?: 'object' | 'array' },
  ): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<Array<{ affectedRows: number }>>;
  queryArrow?(sql: string, params?: QueryParams): Promise<Uint8Array>;
  transaction?<T>(
    fn: (tx: {
      query<R = Row>(
        sql: string,
        params?: QueryParams,
        options?: { rowMode?: 'object' | 'array' },
      ): Promise<QueryResult<R>>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
      exec?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
    }) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export interface EdgeSqlGatewayOptions {
  /** Static Bearer API key (`Authorization: Bearer <apiKey>` or `X-Api-Key`). */
  readonly apiKey?: string;
  /** Optional HS256 JWT secret for Bearer token verification. */
  readonly jwtSecret?: string | Uint8Array;
  /** Optional JWKS provider for asymmetric `ES256` / `EdDSA` JWT verification. */
  readonly jwksProvider?: JwksKeyProvider;
  /** Reject mutating DML & DDL statements when `true`. @default false */
  readonly readOnly?: boolean;
  /** Allow `CREATE` / `ALTER` / `DROP` DDL when `readOnly` is `false`. @default false */
  readonly allowDdl?: boolean;
  /** Optional allow-list of SQL table names callers may touch. */
  readonly allowedTables?: readonly string[];
  /** Maximum rows returned per `SELECT` statement. @default 1000 */
  readonly maxRows?: number;
  /** `Cache-Control: private, max-age=<n>` + `ETag` (`304 Not Modified`) on `SELECT`. @default 0 */
  readonly cacheMaxAgeSec?: number;
  /** CORS `Access-Control-Allow-Origin` header value. @default '*' */
  readonly corsOrigin?: string;
}

export interface EdgeSqlGatewayHandle {
  fetch(request: Request): Promise<Response>;
}

function isReadOnlyStatement(sql: string): boolean {
  const s = sql.trim();
  if (!/^(?:SELECT|WITH|EXPLAIN|SHOW)\b/i.test(s)) return false;
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|RECREATE|TRUNCATE|EXECUTE\s+BLOCK|EXECUTE\s+PROCEDURE)\b/i.test(s)) {
    return false;
  }
  return true;
}

function isDdlStatement(sql: string): boolean {
  return /^\s*(?:CREATE|ALTER|DROP|RECREATE|COMMENT)\b/i.test(sql);
}

function extractReferencedTables(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tbl = (m[1] ?? m[2] ?? '').toUpperCase();
    if (tbl && tbl !== 'RDB$DATABASE' && !out.includes(tbl)) out.push(tbl);
  }
  return out;
}

function jsonSafeReplacer(_k: string, val: unknown): unknown {
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Uint8Array) return Array.from(val);
  return val;
}

/**
 * Create a WinterCG `fetch(Request) -> Promise<Response>` HTTP SQL & atomic batch
 * pipeline gateway for Edge / Serverless deployments (`M29 Item 4`).
 */
export function createEdgeSqlGateway(
  db: EdgeGatewayDatabase,
  options: EdgeSqlGatewayOptions = {},
): EdgeSqlGatewayHandle {
  const readOnly = options.readOnly ?? false;
  const allowDdl = options.allowDdl ?? false;
  const maxRows = Math.max(1, options.maxRows ?? 1_000);
  const cacheMaxAgeSec = Math.max(0, options.cacheMaxAgeSec ?? 0);
  const corsOrigin = options.corsOrigin ?? '*';
  const allowedSet = options.allowedTables?.length
    ? new Set(options.allowedTables.map((t) => t.trim().toUpperCase()))
    : null;

  const baseHeaders = (): Record<string, string> => ({
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Api-Key, Content-Type, Accept, If-None-Match',
  });

  const jsonResp = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body, jsonSafeReplacer), {
      status,
      headers: {
        ...baseHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        ...extra,
      },
    });

  const authorize = async (req: Request): Promise<{ ok: boolean; role?: string; error?: string }> => {
    const needsAuth = Boolean(options.apiKey || options.jwtSecret || options.jwksProvider);
    if (!needsAuth) return { ok: true };

    const xApiKey = req.headers.get('x-api-key')?.trim();
    const authHdr = req.headers.get('authorization')?.trim() ?? '';
    const bearer = authHdr.toLowerCase().startsWith('bearer ') ? authHdr.slice(7).trim() : '';
    const token = bearer || xApiKey || '';
    if (!token) return { ok: false, error: 'Missing Authorization Bearer token or X-Api-Key.' };

    if (options.apiKey && token === options.apiKey) {
      return { ok: true };
    }

    if (options.jwksProvider) {
      try {
        const claims = await verifySyncJwt(token, options.jwksProvider);
        return { ok: true, role: claims.role };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Invalid JWT' };
      }
    }

    if (options.jwtSecret) {
      try {
        const claims = await verifySyncJwt(token, options.jwtSecret);
        return { ok: true, role: claims.role };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Invalid JWT' };
      }
    }

    return { ok: false, error: 'Invalid credentials.' };
  };

  const enforceFirewall = (sql: string, jwtRole?: string): string | null => {
    const trimmed = sql.trim();
    if (!trimmed) return 'SQL statement cannot be empty.';
    const effectiveReadOnly = readOnly || jwtRole === 'readonly' || jwtRole === 'reader';
    if (effectiveReadOnly && !isReadOnlyStatement(trimmed)) {
      return 'Gateway is in read-only mode; mutating DML/DDL statements are forbidden.';
    }
    if (!allowDdl && isDdlStatement(trimmed)) {
      return 'DDL statements are disabled on this Edge SQL gateway (allowDdl: false).';
    }
    if (allowedSet) {
      for (const tbl of extractReferencedTables(trimmed)) {
        if (!allowedSet.has(tbl)) {
          return `Table "${tbl}" is not in allowedTables.`;
        }
      }
    }
    return null;
  };

  const runSingleStatement = async (
    executor: {
      query<T = Row>(
        sql: string,
        params?: QueryParams,
        options?: { rowMode?: 'object' | 'array' },
      ): Promise<QueryResult<T>>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
    },
    sql: string,
    params: QueryParams,
    rowMode: 'object' | 'array',
  ) => {
    if (isReadOnlyStatement(sql) || /\bRETURNING\b/i.test(sql)) {
      const res = await executor.query<Row | ArrayRow>(sql, params, { rowMode });
      const truncated = res.rows.length > maxRows;
      const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
      return {
        fields: res.fields.map((f: FieldInfo) => ({ name: f.name, typeName: f.typeName, nullable: f.nullable })),
        rows,
        rowCount: rows.length,
        truncated,
      };
    }
    if (typeof executor.execute === 'function') {
      const r = await executor.execute(sql, params);
      return { affectedRows: r.affectedRows, rows: [], fields: [], rowCount: 0, truncated: false };
    }
    if (typeof executor.exec === 'function') {
      const r = await executor.exec(sql, params);
      const affected = Array.isArray(r)
        ? r.reduce((s, x) => s + Number((x as { affectedRows?: number }).affectedRows ?? 0), 0)
        : Number((r as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
      return { affectedRows: affected, rows: [], fields: [], rowCount: 0, truncated: false };
    }
    await executor.query(sql, params);
    return { affectedRows: 0, rows: [], fields: [], rowCount: 0, truncated: false };
  };

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: baseHeaders() });
      }

      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (request.method === 'GET' && pathname.endsWith('/health')) {
        return jsonResp(200, { ok: true, status: 'ok', engine: 'firebird-wasm', readOnly });
      }

      const auth = await authorize(request);
      if (!auth.ok) {
        return jsonResp(401, { error: auth.error ?? 'Unauthorized' });
      }

      try {
        if (request.method === 'POST' && (pathname === '/query' || pathname.endsWith('/query'))) {
          const payload = (await request.json()) as {
            sql?: string;
            params?: QueryParams;
            rowMode?: 'object' | 'array';
            format?: 'json' | 'arrow';
          };
          const sql = String(payload.sql ?? '');
          const fwErr = enforceFirewall(sql, auth.role);
          if (fwErr) return jsonResp(403, { error: fwErr });

          const params = payload.params ?? [];
          const wantsArrow =
            payload.format === 'arrow' ||
            (request.headers.get('accept') ?? '').includes('application/vnd.apache.arrow.stream');

          if (wantsArrow && isReadOnlyStatement(sql)) {
            let arrowBytes: Uint8Array;
            if (typeof db.queryArrow === 'function') {
              arrowBytes = await db.queryArrow(sql, params);
            } else {
              const res = await db.query<Row>(sql, params, { rowMode: 'object' });
              arrowBytes = encodeArrowIpc(
                rowsToColumnarResult({ fields: res.fields, rows: res.rows.slice(0, maxRows) }),
              );
            }
            return new Response(
              new Uint8Array(arrowBytes.buffer, arrowBytes.byteOffset, arrowBytes.byteLength) as unknown as BodyInit,
              {
                status: 200,
                headers: {
                  ...baseHeaders(),
                  'Content-Type': 'application/vnd.apache.arrow.stream',
                },
              },
            );
          }

          const out = await runSingleStatement(db, sql, params, payload.rowMode ?? 'object');
          if (isReadOnlyStatement(sql)) {
            const bodyJson = JSON.stringify(out, jsonSafeReplacer);
            const etag = `"${sha256HexSync(bodyJson).slice(0, 24)}"`;
            if (request.headers.get('if-none-match') === etag) {
              return new Response(null, {
                status: 304,
                headers: { ...baseHeaders(), ETag: etag },
              });
            }
            return new Response(bodyJson, {
              status: 200,
              headers: {
                ...baseHeaders(),
                'Content-Type': 'application/json; charset=utf-8',
                ETag: etag,
                ...(cacheMaxAgeSec > 0
                  ? { 'Cache-Control': `private, max-age=${cacheMaxAgeSec}` }
                  : {}),
              },
            });
          }

          return jsonResp(200, out);
        }

        if (request.method === 'POST' && (pathname === '/batch' || pathname.endsWith('/batch'))) {
          const payload = (await request.json()) as {
            statements?: ReadonlyArray<{ sql: string; params?: QueryParams; rowMode?: 'object' | 'array' }>;
          };
          const stmts = payload.statements ?? [];
          if (!Array.isArray(stmts) || stmts.length === 0) {
            return jsonResp(400, { error: 'POST /batch requires a non-empty "statements" array.' });
          }
          for (const st of stmts) {
            const fwErr = enforceFirewall(String(st.sql ?? ''), auth.role);
            if (fwErr) return jsonResp(403, { error: fwErr });
          }

          if (typeof db.transaction === 'function') {
            const results = await db.transaction(async (tx) => {
              const stepOut = [];
              for (const st of stmts) {
                stepOut.push(
                  await runSingleStatement(tx, st.sql, st.params ?? [], st.rowMode ?? 'object'),
                );
              }
              return stepOut;
            });
            return jsonResp(200, { results });
          }

          const results = [];
          for (const st of stmts) {
            results.push(
              await runSingleStatement(db, st.sql, st.params ?? [], st.rowMode ?? 'object'),
            );
          }
          return jsonResp(200, { results });
        }

        return jsonResp(404, { error: `Unknown Edge SQL gateway route: ${request.method} ${pathname}` });
      } catch (err) {
        return jsonResp(400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
