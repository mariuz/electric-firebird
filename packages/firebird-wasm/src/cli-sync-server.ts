/**
 * cli-sync-server.ts – Zero-Config HTTP/SSE Replication & Apache Arrow IPC Server
 * (`npx firebird-wasm serve-sync` & programmatic `startCliReplicationServer`) (`M22 Item 4`).
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import type { FirebirdDatabase } from './database-core';
import type { ReplicableDatabase, ReplicationPublication, ReplicationSubscription } from './replication/types';
import { publishAllTables } from './replication/publication';
import { createSubscription } from './replication/subscription';
import { createHttpReplicationHandler } from './replication/transports';
import { createTenantIsolationGuard, type TenantIsolationGuard } from './replication/tenant-slice';
import {
  SyncJwtError,
  createJwksKeyProvider,
  createJwtTenantAuthResolver,
  type JwtTenantAuthContext,
  type JwtTenantAuthOptions,
  type JwtTenantAuthResolver,
} from './replication/jwt-auth';
import { encodeArrowIpc, rowsToColumnarResult } from './columnar';
import { loadArrowIpcIntoDatabase, type ArrowIngestHost } from './arrow-ingest';

export interface StartCliReplicationServerOptions {
  /** Authoritative Firebird database (`FirebirdBrowser` or `FirebirdLite`). */
  db: FirebirdDatabase | ReplicableDatabase;
  /** TCP port to listen on (`0` selects an available OS ephemeral port). @default 8787 */
  port?: number;
  /** Host interface to bind. @default '127.0.0.1' */
  host?: string;
  /** Optional Bearer token / `x-replication-key` required on requests. */
  apiKey?: string;
  /** Optional HMAC-SHA256 JWT secret enabling cryptographic claim & role auth (`M23 Item 1`). */
  jwtSecret?: string;
  /** Optional remote JWKS URL (`/.well-known/jwks.json`) enabling asymmetric key rotation (`M24 Item 1`). */
  jwksUrl?: string;
  /** Claim name carrying the tenant ID when `jwtSecret`, `jwksUrl`, or `jwtAuth` is configured. @default 'tenant_id' */
  jwtTenantClaim?: string;
  /** Optional full WebCrypto JWT resolver or options (`M23 Item 1`). */
  jwtAuth?: JwtTenantAuthResolver | JwtTenantAuthOptions;
  /** Optional tenant column name enabling inbound/outbound multi-tenant isolation (`M22 Item 1`). */
  tenantColumn?: string;
  /** Optional read-only shared reference tables when `tenantColumn` is configured. */
  sharedTables?: readonly string[];
  /** Enable permissive CORS headers (`Access-Control-Allow-Origin: *`). @default true */
  cors?: boolean;
  /** Publication name. @default 'default' */
  publicationName?: string;
  /** Install Firebird PSQL capture triggers on published user tables. @default true */
  installTriggers?: boolean;
}

export interface CliReplicationServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly publication: ReplicationPublication;
  readonly subscription: ReplicationSubscription;
  readonly tenantGuard?: TenantIsolationGuard;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, authorization, x-replication-key, x-tenant-id, x-fb-changelog-encoding',
};

function readIncomingBody(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | Uint8Array) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.byteLength;
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(new Uint8Array(0));
        return;
      }
      const merged = Buffer.concat(chunks, total);
      resolve(new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength));
    });
    req.on('error', reject);
  });
}

function checkApiKeyAuth(
  req: http.IncomingMessage,
  apiKey: string | undefined,
): boolean {
  if (!apiKey) return true;
  const auth = String(req.headers['authorization'] ?? '');
  const replKey = String(req.headers['x-replication-key'] ?? '');
  return auth === `Bearer ${apiKey}` || replKey === apiKey;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  enableCors: boolean,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(enableCors ? CORS_HEADERS : {}),
  });
  res.end(body);
}

/**
 * Start a standalone Node HTTP/SSE replication + Apache Arrow IPC server backed
 * by `options.db` (`M22 Item 4`).
 */
export async function startCliReplicationServer(
  options: StartCliReplicationServerOptions,
): Promise<CliReplicationServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 8787;
  const enableCors = options.cors ?? true;
  const pubName = options.publicationName ?? 'default';

  const replDb = options.db as ReplicableDatabase;
  const publication = await publishAllTables(replDb, {
    name: pubName,
    nodeId: `server_${pubName}`,
    installTriggers: options.installTriggers ?? true,
  });

  const tenantGuard = options.tenantColumn
    ? createTenantIsolationGuard({
        tenantColumn: options.tenantColumn,
        sharedTables: options.sharedTables,
      })
    : undefined;

  const subscription = await createSubscription(replDb, {
    name: `${pubName}_inbound_sub`,
    nodeId: `server_${pubName}`,
    publication,
    localPublication: publication,
    onConflict: 'last-write-wins',
    tenantGuard,
  });

  const jwtResolver: JwtTenantAuthResolver | undefined = options.jwtAuth
    ? 'authenticateRequest' in options.jwtAuth
      ? options.jwtAuth
      : createJwtTenantAuthResolver(options.jwtAuth)
    : options.jwksUrl
      ? createJwtTenantAuthResolver({
          secretOrPublicKey: createJwksKeyProvider({ jwksUrl: options.jwksUrl }),
          tenantClaim: options.jwtTenantClaim,
        })
      : options.jwtSecret
        ? createJwtTenantAuthResolver({
            secretOrPublicKey: options.jwtSecret,
            tenantClaim: options.jwtTenantClaim,
          })
        : undefined;

  const fetchHandler = createHttpReplicationHandler({
    publication,
    subscription,
    apiKey: options.apiKey,
    tenantGuard,
    jwtAuth: jwtResolver,
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (enableCors && req.method === 'OPTIONS') {
          res.writeHead(204, CORS_HEADERS);
          res.end();
          return;
        }

        const rawUrl = req.url ?? '/';
        const parsedUrl = new URL(rawUrl, `http://${host}`);
        const cleanPath = parsedUrl.pathname.replace(/\/+$/, '') || '/';

        if (req.method === 'GET' && cleanPath === '/health') {
          await publication.refreshPublishedTables();
          await publication.captureTableChanges();
          const currentLsn = await publication.currentLsn();
          sendJson(
            res,
            200,
            {
              ok: true,
              publication: publication.name,
              currentLsn,
              tables: [...publication.tables.keys()],
              tenantIsolation: Boolean(tenantGuard),
            },
            enableCors,
          );
          return;
        }

        if (cleanPath === '/arrow') {
          let arrowJwtCtx: JwtTenantAuthContext | undefined;
          if (jwtResolver) {
            const authHeader = String(req.headers['authorization'] ?? '');
            const tok = /^Bearer\s+/i.test(authHeader)
              ? authHeader.replace(/^Bearer\s+/i, '').trim()
              : parsedUrl.searchParams.get('token');
            try {
              arrowJwtCtx = await jwtResolver.authenticateToken(tok);
            } catch (err) {
              if (err instanceof SyncJwtError) {
                sendJson(res, err.status, { error: err.message, code: err.code }, enableCors);
                return;
              }
              throw err;
            }
          } else if (!checkApiKeyAuth(req, options.apiKey)) {
            sendJson(res, 401, { error: 'Unauthorized request' }, enableCors);
            return;
          }

          if (req.method === 'GET') {
            const sql = (parsedUrl.searchParams.get('sql') ?? '').trim();
            if (!sql || !/^\s*(SELECT|WITH)\b/i.test(sql)) {
              sendJson(
                res,
                400,
                { error: 'GET /arrow requires a read-only ?sql=SELECT ... query parameter' },
                enableCors,
              );
              return;
            }
            const fullDb = options.db as Partial<FirebirdDatabase>;
            let arrowBytes: Uint8Array;
            if (typeof fullDb.queryArrow === 'function') {
              arrowBytes = await fullDb.queryArrow(sql);
            } else {
              const qRes = await replDb.query(sql);
              arrowBytes = encodeArrowIpc(rowsToColumnarResult(qRes));
            }
            res.writeHead(200, {
              'content-type': 'application/vnd.apache.arrow.stream',
              'content-length': String(arrowBytes.byteLength),
              ...(enableCors ? CORS_HEADERS : {}),
            });
            res.end(Buffer.from(arrowBytes.buffer, arrowBytes.byteOffset, arrowBytes.byteLength));
            return;
          }

          if (req.method === 'POST') {
            if (jwtResolver && arrowJwtCtx) {
              try {
                jwtResolver.assertWriteAllowed(arrowJwtCtx);
              } catch (err) {
                if (err instanceof SyncJwtError) {
                  sendJson(res, err.status, { error: err.message, code: err.code }, enableCors);
                  return;
                }
                throw err;
              }
            }
            const tableName = (parsedUrl.searchParams.get('table') ?? '').trim();
            if (!tableName) {
              sendJson(
                res,
                400,
                { error: 'POST /arrow requires a ?table=<TABLE_NAME> query parameter' },
                enableCors,
              );
              return;
            }
            if (jwtResolver && arrowJwtCtx) {
              try {
                jwtResolver.assertTableAllowed(arrowJwtCtx, tableName);
              } catch (err) {
                if (err instanceof SyncJwtError) {
                  sendJson(res, err.status, { error: err.message, code: err.code }, enableCors);
                  return;
                }
                throw err;
              }
            }
            const createTable =
              parsedUrl.searchParams.get('createTable') === '1' ||
              parsedUrl.searchParams.get('createTable') === 'true';
            const pk = parsedUrl.searchParams.get('primaryKey') ?? undefined;
            const bodyBytes = await readIncomingBody(req);
            const fullDb = options.db as Partial<FirebirdDatabase>;
            const ingestRes =
              typeof fullDb.loadArrowIpc === 'function'
                ? await fullDb.loadArrowIpc(tableName, bodyBytes, {
                    createTable,
                    primaryKey: pk,
                  })
                : await loadArrowIpcIntoDatabase(
                    options.db as unknown as ArrowIngestHost,
                    tableName,
                    bodyBytes,
                    { createTable, primaryKey: pk },
                  );
            await publication.refreshPublishedTables();
            await publication.captureTableChanges();
            sendJson(res, 200, { result: ingestRes }, enableCors);
            return;
          }
        }

        // Refresh / capture any direct SQL mutations before serving replication pulls
        if (req.method === 'GET') {
          await publication.refreshPublishedTables();
          await publication.captureTableChanges();
        }

        const bodyBytes =
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : await readIncomingBody(req);

        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') {
            headers.set(k, v);
          } else if (Array.isArray(v)) {
            headers.set(k, v.join(', '));
          }
        }

        const webReq = new Request(`http://${host}${rawUrl}`, {
          method: req.method ?? 'GET',
          headers,
          ...(bodyBytes && bodyBytes.byteLength > 0
            ? { body: new Uint8Array(bodyBytes) }
            : {}),
        });

        const webRes = await fetchHandler(webReq);
        const outHeaders: Record<string, string> = enableCors ? { ...CORS_HEADERS } : {};
        webRes.headers.forEach((v, k) => {
          outHeaders[k] = v;
        });
        const respBuf = Buffer.from(await webRes.arrayBuffer());
        res.writeHead(webRes.status, outHeaders);
        res.end(respBuf);
      } catch (err) {
        sendJson(
          res,
          500,
          { error: err instanceof Error ? err.message : String(err) },
          enableCors,
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundPort = addr.port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const baseUrl = `http://${displayHost}:${boundPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    subscription.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    host,
    port: boundPort,
    url: baseUrl,
    publication,
    subscription,
    tenantGuard,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
