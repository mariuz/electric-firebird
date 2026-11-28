/**
 * electric-proxy.ts – Electric Auth Proxy, Shape-Scoped Row-Level Security,
 * Token-Bucket Rate Limiting (`createElectricProxy`) & Signed HMAC-SHA256
 * Webhook Fan-Out Sink (`createShapeWebhookSink`, `FB_WEBHOOK_OUTBOX$`) (`M32 Item 4`).
 *
 * 100% WinterCG / Browser / Node safe (WebCrypto `crypto.subtle`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QueryParams, QueryResult, Row } from './types';
import {
  verifySyncJwt,
  type SyncJwtClaims,
  type SyncJwtKeySource,
} from './replication/jwt-auth';

export const DEFAULT_WEBHOOK_OUTBOX_TABLE = 'FB_WEBHOOK_OUTBOX$';

export interface ElectricUpstreamTarget {
  fetch(request: Request): Promise<Response>;
}

export interface ElectricAuthContext {
  readonly subject: string;
  readonly tenantId?: string | number;
  readonly role: 'reader' | 'writer' | 'admin';
  readonly claims: SyncJwtClaims;
}

export interface ShapeRlsInjection {
  readonly where: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly columns?: readonly string[];
}

export interface ElectricProxyOptions {
  /** Shared HMAC secret or JWKS key source for Bearer JWT verification (`verifySyncJwt`). */
  readonly jwtKey?: SyncJwtKeySource;
  /** Optional static API keys mapped to auth contexts (`x-api-key` or `Authorization: Bearer`). */
  readonly apiKeys?: Readonly<Record<string, Partial<ElectricAuthContext>>>;
  /** Optional custom async authorizer hook. */
  readonly authorize?: (request: Request) => Promise<ElectricAuthContext | null> | ElectricAuthContext | null;
  /** Optional table allow-list (case-insensitive). */
  readonly allowedTables?: readonly string[];
  /** Per-table allowed column list (`{ orders: ['id', 'tenant_id', 'total'] }`). */
  readonly columnAllowList?: Readonly<Record<string, readonly string[]>>;
  /** Automatic tenant column name injected when `ctx.tenantId` is present (e.g. `'tenant_id'`). */
  readonly tenantColumn?: string;
  /** Dynamic per-request shape RLS injector (`(ctx, table) => ({ where, params, columns })`). */
  readonly injectWhere?: (
    ctx: ElectricAuthContext,
    table: string,
  ) => ShapeRlsInjection | null | undefined | Promise<ShapeRlsInjection | null | undefined>;
  /** Per-tenant / per-subject sliding-window token bucket rate limiter (`429 Too Many Requests`). */
  readonly rateLimit?: {
    readonly maxRequests: number;
    readonly windowMs: number;
    readonly nowMs?: () => number;
  };
}

export interface ElectricProxyHandle {
  fetch(request: Request): Promise<Response>;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

function jsonErrorResponse(status: number, error: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * Merge a server-enforced `WHERE` clause and `$n` parameters with an untrusted client `WHERE`,
 * shifting client `$1..$k` indices so client parameters can never overwrite server RLS params!
 */
export function mergeServerAndClientWhere(
  serverWhere: string,
  serverParams: Readonly<Record<string, string | number | boolean>>,
  clientWhere: string | null,
  clientParams: Readonly<Record<string, string>>,
): { where: string; params: Record<string, string> } {
  const mergedParams: Record<string, string> = {};
  let maxServerIdx = 0;
  for (const [k, v] of Object.entries(serverParams)) {
    const idx = Number(k.replace(/^\$/, ''));
    if (Number.isFinite(idx) && idx > maxServerIdx) maxServerIdx = idx;
    mergedParams[String(idx)] = String(v);
  }

  if (!clientWhere || !clientWhere.trim()) {
    return { where: serverWhere, params: mergedParams };
  }

  // Shift client `$n` -> `$(n + maxServerIdx)` outside single-quoted literals
  const shiftedClientWhere = clientWhere.replace(
    /'(?:[^']|'')*'|\$(\d+)/g,
    (token, numStr: string | undefined) => {
      if (numStr === undefined) return token;
      return `$${Number(numStr) + maxServerIdx}`;
    },
  );
  for (const [k, v] of Object.entries(clientParams)) {
    const idx = Number(k.replace(/^\$/, ''));
    if (Number.isFinite(idx) && idx >= 1) {
      mergedParams[String(idx + maxServerIdx)] = v;
    }
  }

  return {
    where: `(${serverWhere}) AND (${shiftedClientWhere})`,
    params: mergedParams,
  };
}

function extractQueryParamsMap(sp: URLSearchParams, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const bracketPrefix = `${prefix}[`;
  for (const [k, v] of sp.entries()) {
    if (k.startsWith(bracketPrefix) && k.endsWith(']')) {
      const inner = k.slice(bracketPrefix.length, -1);
      out[inner] = v;
    }
  }
  const jsonForm = sp.get(prefix);
  if (jsonForm) {
    try {
      const parsed = JSON.parse(jsonForm) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        for (const [pk, pv] of Object.entries(parsed)) out[pk] = String(pv);
      }
    } catch {
      // ignore malformed client JSON; upstream shape validator will reject if needed
    }
  }
  return out;
}

/**
 * Create an authenticating, RLS-enforcing Electric `/v1/shape` proxy (`M32 Item 4`).
 */
export function createElectricProxy(
  upstream: ElectricUpstreamTarget | ((request: Request) => Promise<Response>),
  options: ElectricProxyOptions = {},
): ElectricProxyHandle {
  const callUpstream =
    typeof upstream === 'function' ? upstream : (req: Request) => upstream.fetch(req);
  const buckets = new Map<string, { count: number; windowStart: number }>();

  const resolveAuth = async (request: Request): Promise<ElectricAuthContext | Response> => {
    if (options.authorize) {
      const custom = await options.authorize(request);
      if (custom) return custom;
    }

    const apiKeyHeader = request.headers.get('x-api-key')?.trim();
    const authHeader = request.headers.get('authorization')?.trim() ?? '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : null;

    const candidateKey = apiKeyHeader ?? bearer;
    if (candidateKey && options.apiKeys && candidateKey in options.apiKeys) {
      const entry = options.apiKeys[candidateKey]!;
      return {
        subject: entry.subject ?? 'api-key',
        tenantId: entry.tenantId,
        role: entry.role ?? 'reader',
        claims: entry.claims ?? {},
      };
    }

    if (bearer && options.jwtKey) {
      try {
        const claims = await verifySyncJwt(bearer, options.jwtKey);
        return {
          subject: String(claims.sub ?? 'jwt-user'),
          tenantId: claims.tenant_id,
          role: claims.role ?? 'reader',
          claims,
        };
      } catch (err) {
        return jsonErrorResponse(
          401,
          err instanceof Error ? err.message : 'Invalid Bearer token',
        );
      }
    }

    if (options.jwtKey || options.apiKeys || options.authorize) {
      return jsonErrorResponse(401, 'Missing or invalid authentication credentials');
    }

    return { subject: 'anonymous', role: 'reader', claims: {} };
  };

  const fetchHandler = async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return callUpstream(request);
    }

    const authOrErr = await resolveAuth(request);
    if (authOrErr instanceof Response) return authOrErr;
    const ctx = authOrErr;

    // Rate limiting per tenantId / subject
    if (options.rateLimit) {
      const now = options.rateLimit.nowMs ? options.rateLimit.nowMs() : Date.now();
      const bucketKey = String(ctx.tenantId ?? ctx.subject);
      const cur = buckets.get(bucketKey);
      if (!cur || now - cur.windowStart >= options.rateLimit.windowMs) {
        buckets.set(bucketKey, { count: 1, windowStart: now });
      } else if (cur.count >= options.rateLimit.maxRequests) {
        const retrySec = Math.max(1, Math.ceil((options.rateLimit.windowMs - (now - cur.windowStart)) / 1000));
        return jsonErrorResponse(429, 'Rate limit exceeded', {
          'retry-after': String(retrySec),
        });
      } else {
        cur.count += 1;
      }
    }

    // DELETE /v1/shape requires admin or writer role
    if (request.method === 'DELETE' && ctx.role === 'reader') {
      return jsonErrorResponse(403, 'Role "reader" is not permitted to invalidate shapes');
    }

    const url = new URL(request.url);
    if (!url.pathname.endsWith('/v1/shape')) {
      return callUpstream(request);
    }

    const rawTable = url.searchParams.get('table')?.trim() ?? '';
    if (!rawTable) return callUpstream(request);
    const tableLower = rawTable.replace(/^"|"$/g, '').toLowerCase();

    if (options.allowedTables) {
      const allowedSet = new Set(options.allowedTables.map((t) => t.toLowerCase()));
      if (!allowedSet.has(tableLower)) {
        return jsonErrorResponse(403, `Access to table "${rawTable}" is forbidden`);
      }
    }
    if (ctx.claims.tables && ctx.claims.tables.length > 0) {
      const claimSet = new Set(ctx.claims.tables.map((t) => t.toLowerCase()));
      if (!claimSet.has(tableLower)) {
        return jsonErrorResponse(403, `Token is not authorized for table "${rawTable}"`);
      }
    }

    // Build server-side WHERE clauses + params
    const serverClauses: string[] = [];
    const serverParams: Record<string, string | number | boolean> = {};
    let pIdx = 0;

    if (options.tenantColumn && ctx.tenantId !== undefined) {
      pIdx += 1;
      serverClauses.push(`${options.tenantColumn} = $${pIdx}`);
      serverParams[String(pIdx)] = ctx.tenantId;
    }

    const rlsTablePreds =
      ctx.claims.rls?.[rawTable] ??
      ctx.claims.rls?.[tableLower] ??
      ctx.claims.rls?.[tableLower.toUpperCase()];
    if (rlsTablePreds) {
      for (const [col, val] of Object.entries(rlsTablePreds)) {
        if (Array.isArray(val)) {
          const ph = val.map((item) => {
            pIdx += 1;
            serverParams[String(pIdx)] = item as string | number | boolean;
            return `$${pIdx}`;
          });
          if (ph.length > 0) serverClauses.push(`${col} IN (${ph.join(', ')})`);
        } else if (val === null) {
          serverClauses.push(`${col} IS NULL`);
        } else {
          pIdx += 1;
          serverClauses.push(`${col} = $${pIdx}`);
          serverParams[String(pIdx)] = val as string | number | boolean;
        }
      }
    }

    const injected = options.injectWhere ? await options.injectWhere(ctx, rawTable) : null;
    if (injected?.where) {
      const shifted = mergeServerAndClientWhere(
        serverClauses.length > 0 ? serverClauses.join(' AND ') : '1 = 1',
        serverParams,
        injected.where,
        Object.fromEntries(
          Object.entries(injected.params ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      );
      serverClauses.length = 0;
      serverClauses.push(shifted.where);
      for (const k of Object.keys(serverParams)) delete serverParams[k];
      for (const [k, v] of Object.entries(shifted.params)) serverParams[k] = v;
    }

    // Enforce column allow-list
    const configuredCols =
      injected?.columns ??
      options.columnAllowList?.[rawTable] ??
      options.columnAllowList?.[tableLower] ??
      options.columnAllowList?.[tableLower.toUpperCase()];
    if (configuredCols && configuredCols.length > 0) {
      const allowLower = new Set(configuredCols.map((c) => c.toLowerCase()));
      const clientColsRaw = url.searchParams.get('columns');
      if (clientColsRaw) {
        const reqCols = clientColsRaw
          .split(',')
          .map((c) => c.trim().replace(/^"|"$/g, ''))
          .filter(Boolean);
        for (const rc of reqCols) {
          if (!allowLower.has(rc.toLowerCase())) {
            return jsonErrorResponse(403, `Column "${rc}" is not permitted on table "${rawTable}"`);
          }
        }
      } else {
        url.searchParams.set('columns', configuredCols.join(','));
      }
    }

    if (serverClauses.length > 0) {
      const clientWhere = url.searchParams.get('where');
      const clientParams = extractQueryParamsMap(url.searchParams, 'params');
      // Remove existing `params` & `params[*]` keys before setting canonical merged params
      for (const k of [...url.searchParams.keys()]) {
        if (k === 'params' || k.startsWith('params[')) url.searchParams.delete(k);
      }
      const merged = mergeServerAndClientWhere(
        serverClauses.join(' AND '),
        serverParams,
        clientWhere,
        clientParams,
      );
      url.searchParams.set('where', merged.where);
      for (const [k, v] of Object.entries(merged.params)) {
        url.searchParams.set(`params[${k}]`, v);
      }
    }

    const proxiedReq = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      // @ts-expect-error Node 20 undici streaming body duplex hint
      duplex: 'half',
    });
    const upstreamRes = await callUpstream(proxiedReq);
    // Authenticated responses must use `private` Cache-Control when tenant/user RLS is active
    if (serverClauses.length > 0 || configuredCols) {
      const headers = new Headers(upstreamRes.headers);
      const cc = headers.get('cache-control') ?? '';
      if (cc.includes('public')) {
        headers.set('cache-control', cc.replace(/\bpublic\b/g, 'private'));
      }
      headers.set('vary', 'Authorization, X-Api-Key');
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers,
      });
    }
    return upstreamRes;
  };

  const nodeHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const bodyBuf = Buffer.concat(chunks);
      const host = req.headers.host ?? '127.0.0.1';
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const webReq = new Request(`http://${host}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
      });
      const webRes = await fetchHandler(webReq);
      res.statusCode = webRes.status;
      webRes.headers.forEach((v, k) => res.setHeader(k, v));
      const ab = await webRes.arrayBuffer();
      res.end(Buffer.from(ab));
    })();
  };

  return { fetch: fetchHandler, handler: nodeHandler };
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 Signed Shape Webhook Fan-Out Sink (`FB_WEBHOOK_OUTBOX$`) (`M32 Item 4`)
// ---------------------------------------------------------------------------

export interface WebhookOutboxDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

export interface ShapeWebhookEvent {
  readonly id: string;
  readonly table: string;
  readonly handle?: string;
  readonly offset?: string;
  readonly timestamp: number;
  readonly changes: ReadonlyArray<Record<string, unknown>>;
}

export interface WebhookDeadLetterEntry {
  readonly id: string;
  readonly url: string;
  readonly payloadJson: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly createdAtMs: number;
}

export interface CreateShapeWebhookSinkOptions {
  readonly url: string;
  readonly secret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxRetries?: number;
  readonly baseBackoffMs?: number;
  readonly outboxTable?: string;
}

export interface ShapeWebhookSink {
  publish(event: Omit<ShapeWebhookEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): Promise<{
    delivered: boolean;
    attempts: number;
    signature: string;
    statusCode?: number;
  }>;
  listDeadLetters(): Promise<WebhookDeadLetterEntry[]>;
  retryDeadLetters(): Promise<{ retried: number; succeeded: number }>;
}

const utf8Enc = new TextEncoder();

export async function signShapeWebhookPayload(
  payloadJson: string,
  timestamp: number,
  secret: string,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8Enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    utf8Enc.encode(`${timestamp}.${payloadJson}`),
  );
  const bytes = new Uint8Array(mac);
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return `sha256=${hex}`;
}

export async function verifyShapeWebhookSignature(
  payloadJson: string,
  timestamp: number | string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const expected = await signShapeWebhookPayload(payloadJson, Number(timestamp), secret);
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

function whCol(row: Record<string, unknown>, col: string): unknown {
  const u = col.toUpperCase();
  if (u in row) return row[u];
  const l = col.toLowerCase();
  if (l in row) return row[l];
  return undefined;
}

async function execWhSql(
  db: WebhookOutboxDatabase,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

let webhookSeq = 0;

/**
 * Create a durable HMAC-SHA256-signed webhook sink for Electric shape batches (`M32 Item 4`).
 */
export function createShapeWebhookSink(
  db: WebhookOutboxDatabase,
  options: CreateShapeWebhookSinkOptions,
): ShapeWebhookSink {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 2;
  const baseBackoffMs = options.baseBackoffMs ?? 15;
  const outboxUpper = (options.outboxTable ?? DEFAULT_WEBHOOK_OUTBOX_TABLE).trim().toUpperCase();

  const ensureOutbox = async (): Promise<void> => {
    const chk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [outboxUpper],
    );
    if (Number(whCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execWhSql(
        db,
        `CREATE TABLE "${outboxUpper}" (
          "ID" VARCHAR(64) NOT NULL PRIMARY KEY,
          "TARGET_URL" VARCHAR(512) NOT NULL,
          "PAYLOAD_JSON" BLOB SUB_TYPE TEXT NOT NULL,
          "ATTEMPTS" INTEGER NOT NULL,
          "LAST_ERROR" VARCHAR(512) NOT NULL,
          "CREATED_AT_MS" BIGINT NOT NULL
        )`,
      );
    }
  };

  const deliverPayload = async (
    id: string,
    payloadJson: string,
    ts: number,
  ): Promise<{ delivered: boolean; attempts: number; signature: string; statusCode?: number; lastErr: string }> => {
    const signature = await signShapeWebhookPayload(payloadJson, ts, options.secret);
    let attempts = 0;
    let lastErr = '';
    let lastStatus: number | undefined;

    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        const res = await fetchFn(options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-electric-signature': signature,
            'x-electric-timestamp': String(ts),
            'x-electric-delivery-id': id,
          },
          body: payloadJson,
        });
        lastStatus = res.status;
        if (res.ok) {
          return { delivered: true, attempts, signature, statusCode: res.status, lastErr: '' };
        }
        lastErr = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempts <= maxRetries && baseBackoffMs > 0) {
        await new Promise((r) => setTimeout(r, baseBackoffMs * attempts));
      }
    }

    return { delivered: false, attempts, signature, statusCode: lastStatus, lastErr };
  };

  return {
    async publish(input) {
      const id = input.id ?? `wh_${Date.now().toString(36)}_${++webhookSeq}`;
      const ts = input.timestamp ?? Date.now();
      const event: ShapeWebhookEvent = {
        id,
        table: input.table,
        ...(input.handle !== undefined ? { handle: input.handle } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        timestamp: ts,
        changes: input.changes,
      };
      const payloadJson = JSON.stringify(event);
      const outcome = await deliverPayload(id, payloadJson, ts);

      if (!outcome.delivered) {
        await ensureOutbox();
        await execWhSql(
          db,
          `UPDATE OR INSERT INTO "${outboxUpper}" (
            "ID", "TARGET_URL", "PAYLOAD_JSON", "ATTEMPTS", "LAST_ERROR", "CREATED_AT_MS"
          ) VALUES (?, ?, ?, ?, ?, ?) MATCHING ("ID")`,
          [id, options.url, payloadJson, outcome.attempts, outcome.lastErr.slice(0, 500), ts],
        );
      }

      return {
        delivered: outcome.delivered,
        attempts: outcome.attempts,
        signature: outcome.signature,
        ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
      };
    },

    async listDeadLetters(): Promise<WebhookDeadLetterEntry[]> {
      const chk = await db.query<Record<string, unknown>>(
        'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
        [outboxUpper],
      );
      if (Number(whCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];
      const res = await db.query<Record<string, unknown>>(
        `SELECT "ID", "TARGET_URL", "PAYLOAD_JSON", "ATTEMPTS", "LAST_ERROR", "CREATED_AT_MS"
           FROM "${outboxUpper}" ORDER BY "CREATED_AT_MS" ASC`,
      );
      return res.rows.map((r) => ({
        id: String(whCol(r, 'ID') ?? ''),
        url: String(whCol(r, 'TARGET_URL') ?? ''),
        payloadJson: String(whCol(r, 'PAYLOAD_JSON') ?? ''),
        attempts: Number(whCol(r, 'ATTEMPTS') ?? 0),
        lastError: String(whCol(r, 'LAST_ERROR') ?? ''),
        createdAtMs: Number(whCol(r, 'CREATED_AT_MS') ?? 0),
      }));
    },

    async retryDeadLetters(): Promise<{ retried: number; succeeded: number }> {
      const entries = await this.listDeadLetters();
      let succeeded = 0;
      for (const e of entries) {
        const res = await deliverPayload(e.id, e.payloadJson, Date.now());
        if (res.delivered) {
          succeeded += 1;
          await execWhSql(db, `DELETE FROM "${outboxUpper}" WHERE "ID" = ?`, [e.id]);
        } else {
          await execWhSql(
            db,
            `UPDATE "${outboxUpper}" SET "ATTEMPTS" = "ATTEMPTS" + ?, "LAST_ERROR" = ? WHERE "ID" = ?`,
            [res.attempts, res.lastErr.slice(0, 500), e.id],
          );
        }
      }
      return { retried: entries.length, succeeded };
    },
  };
}
