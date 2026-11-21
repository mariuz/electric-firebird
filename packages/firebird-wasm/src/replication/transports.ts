/**
 * Network Replication Transports (HTTP/SSE, WebSocket & BroadcastChannel).
 */

import type {
  PublicationSnapshot,
  ReplicableDatabase,
  ReplicationLogEntry,
  ReplicationPublication,
  ReplicationSlot,
  ReplicationSubscription,
  SubscriptionPullResult,
} from './types';
import {
  base64ToBytes,
  bytesToBase64,
  gunzipBytes,
  gzipBytes,
  isGzipBytes,
} from './shared';
import {
  applyFbChangelogSegmentToDatabase,
  parseFbChangelogSegment,
  type ApplyFbChangelogResult,
  type JrdColumnDescriptor,
} from './native-changelog';
import {
  computeBackoffDelayMs,
  type BackoffRetryOptions,
  type ConnectionLifecycleState,
  type ConnectionStateChangeInfo,
} from './webrtc-resilient';
import {
  TenantIsolationError,
  readTenantField,
  valuesMatchTenantId,
  type TenantIsolationGuard,
} from './tenant-slice';
import {
  SyncJwtError,
  createJwtTenantAuthResolver,
  type JwtTenantAuthContext,
  type JwtTenantAuthOptions,
  type JwtTenantAuthResolver,
} from './jwt-auth';
import {
  decodeArrowSnapshotBundle,
  encodeArrowSnapshotBundle,
  exportArrowSnapshot,
  type ArrowPublicationSnapshot,
} from './arrow-snapshot';
import {
  createSseReplicationHub,
  type SseReplicationHub,
} from './sse-fanout';
import {
  createPresenceHub,
  type PresenceCursor,
  type PresenceHub,
} from './presence';
import {
  formatPrometheusMetrics,
  generateTraceparent,
  type OtelInstrumentationHandle,
  type OtelObservableDatabase,
} from '../otel-metrics';
import {
  runHttpFetchChangelogSegments,
  runHttpFetchSnapshotResumable,
  runHttpPullAndApplyChangelog,
  runHttpPushChangelogSegment,
} from './http-client-ops';

export * from './webrtc-resilient';
export * from './broadcast-transport';
export * from './sse-fanout';
export * from './presence';
export * from './websocket-transport';

// ---------------------------------------------------------------------------
// 4. Network Replication Transports (HTTP/SSE, WebSocket & BroadcastChannel — M12 Item 7 / M18 Item 1)
// ---------------------------------------------------------------------------

/** Source provider of native `"FBCHANGELOG\0"` binary segments for HTTP/WS transports (`M18 Item 1`). */
export interface ChangelogSegmentSource {
  readSegmentsSince(
    sinceSequence: number,
  ):
    | ReadonlyArray<Uint8Array | { sequence: number; rawBytes: Uint8Array }>
    | Promise<ReadonlyArray<Uint8Array | { sequence: number; rawBytes: Uint8Array }>>;
}

/** Options for {@link createHttpReplicationHandler}. */
export interface HttpReplicationHandlerOptions {
  /** Primary publication served over HTTP. */
  publication?: ReplicationPublication;
  /**
   * Optional subscription on the server to apply incoming client changes
   * when running in bidirectional mode (`POST /push`).
   */
  subscription?: ReplicationSubscription;
  /** Optional bearer token or `x-replication-key` required on requests. */
  apiKey?: string;
  /**
   * Optional source of native `"FBCHANGELOG\0"` binary segments served at
   * `GET /changelog?sinceSequence=<N>` (`M18 Item 1`).
   */
  changelogSource?: ChangelogSegmentSource | ReadonlyArray<Uint8Array>;
  /**
   * Optional target database on the server that receives incoming
   * `"FBCHANGELOG\0"` segments pushed via `POST /changelog` (`M18 Item 1`).
   */
  changelogTargetDb?: ReplicableDatabase;
  /**
   * Optional custom callback invoked when a `"FBCHANGELOG\0"` segment arrives
   * at `POST /changelog` (`M18 Item 1`).
   */
  onChangelogSegment?: (
    segmentBytes: Uint8Array,
  ) => ApplyFbChangelogResult | Promise<ApplyFbChangelogResult>;
  /**
   * Optional multi-tenant isolation guard (`M22 Item 1`).
   * Validates inbound `POST /push` mutations (returning HTTP `403 Forbidden` on
   * cross-tenant or shared-table violations) and optionally filters outbound
   * `/changes` and `/snapshot` rows when a tenant ID is resolved for the request.
   */
  tenantGuard?: TenantIsolationGuard;
  /**
   * Optional resolver extracting the authenticated tenant ID from an incoming
   * HTTP `Request` (defaults to `x-tenant-id` header or `?tenantId=` query param
   * or `tenantGuard.defaultTenantId`).
   */
  resolveTenantId?: (
    request: Request,
  ) => string | number | undefined | Promise<string | number | undefined>;
  /**
   * Optional WebCrypto JWT verifier / claim resolver (`M23 Item 1`).
   * Enforces `Authorization: Bearer <jwt>` (or `?token=<jwt>` for SSE), binds
   * `tenantId` from JWT claims, restricts `role: 'reader'` from `/push`, and
   * scopes allowed `tables`.
   */
  jwtAuth?: JwtTenantAuthResolver | JwtTenantAuthOptions;
  /** Optional external SSE fanout hub shared across server hooks (`M25 Item 1`). */
  sseHub?: SseReplicationHub;
  /** Keep-alive comment interval in ms for `GET /events` SSE streams (`M25 Item 1`). @default 15000 */
  sseHeartbeatIntervalMs?: number;
  /** Optional ephemeral collaborative presence hub (`M26 Item 1`). */
  presenceHub?: PresenceHub;
  /** Optional database handle providing `monitorStats()` / `databaseInfo()` for `GET /metrics` (`M27 Item 3`). */
  metricsDb?: OtelObservableDatabase;
  /** Optional OpenTelemetry instrumentation handle linked to this replication handler (`M27 Item 3`). */
  otel?: OtelInstrumentationHandle;
}

export type ReplicationTokenProvider =
  | string
  | (() => string | undefined | Promise<string | undefined>);

/** Options for {@link createHttpReplicationClient}. */
export interface HttpReplicationClientOptions {
  /** Base URL of the HTTP replication endpoint (e.g. `'https://api.example.com/replication'`). */
  baseUrl: string;
  /** Remote publication name. @default 'default' */
  name?: string;
  /** Custom `fetch` implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Optional API key / JWT token or dynamic async provider sent as `Authorization: Bearer <token>` and `x-replication-key` (`M24 Item 1`). */
  apiKey?: ReplicationTokenProvider;
  /** Optional alias for `apiKey` accepting a static JWT or dynamic async token provider (`M24 Item 1`). */
  authToken?: ReplicationTokenProvider;
  /** Optional W3C `traceparent` header string or dynamic provider propagated on outbound HTTP requests (`M27 Item 3`). */
  traceparent?: string | (() => string | undefined);
  /** Optional exponential backoff + jitter retry policy for transient network / 5xx / 429 failures (`M19 Item 3`). */
  retry?: BackoffRetryOptions;
  /** Optional connection lifecycle callback (`'connecting' | 'online' | 'backoff' | 'offline'`) (`M19 Item 3`). */
  onStateChange?: (
    state: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ) => void;
}

/** Manifest returned by `GET /snapshot/manifest` for resumable chunked bootstrap (`M19 Item 3`). */
export interface ResumableSnapshotManifest {
  readonly snapshotId: string;
  readonly publication: string;
  readonly origin: string;
  readonly watermarkLsn: number;
  readonly timestamp: number;
  readonly tables: ReadonlyArray<{
    readonly table: string;
    readonly primaryKey: readonly string[];
    readonly ddlSql?: string | null;
    readonly totalRows: number;
  }>;
}

/** Mutable checkpoint object passed to `client.fetchSnapshotResumable({ checkpoint })` (`M19 Item 3`). */
export interface ResumableSnapshotCheckpoint {
  manifest?: ResumableSnapshotManifest;
  currentTableIndex: number;
  currentRowOffset: number;
  completedTables: Array<{
    table: string;
    primaryKey: readonly string[];
    ddlSql?: string | null;
    rows: Record<string, unknown>[];
  }>;
  partialRows: Record<string, unknown>[];
}

/** Options for `client.fetchSnapshotResumable()` (`M19 Item 3`). */
export interface FetchSnapshotResumableOptions {
  /** Number of rows fetched per `/snapshot/chunk` HTTP request. @default 500 */
  chunkSize?: number;
  /** Mutable checkpoint updated after each chunk so interrupted downloads resume without re-fetching completed chunks. */
  checkpoint?: ResumableSnapshotCheckpoint;
  /** Progress callback invoked after each chunk completes. */
  onProgress?: (progress: {
    readonly table: string;
    readonly tableLoadedRows: number;
    readonly tableTotalRows: number;
    readonly totalLoadedRows: number;
    readonly totalRows: number;
  }) => void;
}

/** Remote publication client returned by {@link createHttpReplicationClient}. */
export interface HttpReplicationClient {
  readonly name: string;
  /** Current HTTP transport lifecycle state (`M19 Item 3`). */
  readonly state: ConnectionLifecycleState;
  /** Dynamically rotate or update the Bearer token or async token provider without tearing down the client (`M24 Item 1`). */
  setAuthToken(tokenOrProvider: ReplicationTokenProvider | undefined): void;
  fetchChangesSince(
    sinceLsn: number,
    options?: { limit?: number; excludeOrigin?: string },
  ): Promise<ReplicationLogEntry[]>;
  ackSlot(
    slotName: string,
    confirmedLsn: number,
    options?: { nodeId?: string; ttlMs?: number },
  ): Promise<ReplicationSlot>;
  heartbeatSlot(
    slotName: string,
    options?: { nodeId?: string; ttlMs?: number },
  ): Promise<ReplicationSlot | null>;
  fetchSnapshot(): Promise<PublicationSnapshot>;
  /** Fetch a binary multi-table Apache Arrow IPC V5 snapshot (`"FBARSNAP"`, `M23 Item 3`). */
  fetchArrowSnapshot(options?: { compressGzip?: boolean }): Promise<ArrowPublicationSnapshot>;
  /** Fetch a `PublicationSnapshot` in resumable paginated chunks via `/snapshot/manifest` + `/snapshot/chunk` (`M19 Item 3`). */
  fetchSnapshotResumable(
    options?: FetchSnapshotResumableOptions,
  ): Promise<PublicationSnapshot>;
  pushChanges(
    entries: readonly ReplicationLogEntry[],
  ): Promise<SubscriptionPullResult | { appliedCount: number }>;
  /** Fetch native `"FBCHANGELOG\0"` binary segments after `sinceSequence` (`M18 Item 1`). */
  fetchChangelogSegments(
    sinceSequence?: number,
    options?: { compress?: boolean },
  ): Promise<Uint8Array[]>;
  /** Push one or more native `"FBCHANGELOG\0"` binary segments to `POST /changelog` (`M18 Item 1`). */
  pushChangelogSegment(
    segments: Uint8Array | ReadonlyArray<Uint8Array>,
    options?: { compress?: boolean },
  ): Promise<ApplyFbChangelogResult[]>;
  /** Fetch native `"FBCHANGELOG\0"` segments since `sinceSequence` and apply them to `targetDb` (`M18 Item 1`). */
  pullAndApplyChangelog(
    targetDb: ReplicableDatabase,
    sinceSequence?: number,
    options?: {
      compress?: boolean;
      preferLogicalFallback?: boolean;
      tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
    },
  ): Promise<ApplyFbChangelogResult[]>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Create a standard Web Fetch API `(request: Request) => Promise<Response>`
 * handler exposing a `ReplicationPublication` (and optional `ReplicationSubscription`)
 * over HTTP/JSON and Server-Sent Events (`GET /events`).
 */
export function createHttpReplicationHandler(
  options: HttpReplicationHandlerOptions,
): (request: Request) => Promise<Response> {
  const {
    publication,
    subscription,
    apiKey,
    changelogSource,
    changelogTargetDb,
    onChangelogSegment,
  } = options;

  // Bounded point-in-time snapshot cache for resumable chunked downloads (`M19 Item 3`)
  const snapshotCache = new Map<string, PublicationSnapshot>();
  let snapshotCounter = 1;

  const jwtResolver: JwtTenantAuthResolver | undefined = options.jwtAuth
    ? 'authenticateRequest' in options.jwtAuth
      ? options.jwtAuth
      : createJwtTenantAuthResolver(options.jwtAuth)
    : undefined;

  const sseHub: SseReplicationHub =
    options.sseHub ??
    createSseReplicationHub({
      publication,
      tenantGuard: options.tenantGuard,
      jwtResolver,
      heartbeatIntervalMs: options.sseHeartbeatIntervalMs,
    });
  const presenceHub: PresenceHub = options.presenceHub ?? createPresenceHub();

  const innerHandle = async (
    request: Request,
    activeTraceparent: string,
  ): Promise<Response> => {
    if (apiKey && !jwtResolver) {
      const auth = request.headers.get('authorization') ?? '';
      const keyHeader = request.headers.get('x-replication-key') ?? '';
      if (auth !== `Bearer ${apiKey}` && keyHeader !== apiKey) {
        return jsonResponse({ error: 'Unauthorized replication request' }, 401);
      }
    }

    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method === 'GET' && path.endsWith('/metrics')) {
      const [monitor, dbInfo, primaryLsn, replicaWatermark] = await Promise.all([
        options.metricsDb?.monitorStats
          ? options.metricsDb.monitorStats().catch(() => null)
          : null,
        options.metricsDb?.databaseInfo
          ? options.metricsDb.databaseInfo().catch(() => null)
          : null,
        publication ? publication.currentLsn().catch(() => undefined) : undefined,
        subscription ? subscription.getWatermark().catch(() => undefined) : undefined,
      ]);
      const lagEntries =
        typeof primaryLsn === 'number' && typeof replicaWatermark === 'number'
          ? Math.max(0, primaryLsn - replicaWatermark)
          : undefined;
      const bodyText = formatPrometheusMetrics({
        monitor,
        dbInfo,
        replication:
          primaryLsn !== undefined || replicaWatermark !== undefined
            ? { primaryLsn, replicaWatermark, lagEntries }
            : null,
        sseSubscribers: sseHub.subscriberCount,
        presencePeers: presenceHub.listPeers().length,
      });
      return new Response(bodyText, {
        status: 200,
        headers: {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          traceparent: activeTraceparent,
        },
      });
    }

    const explicitRequestedTenant =
      request.headers.get('x-tenant-id') ?? url.searchParams.get('tenantId');

    let jwtCtx: JwtTenantAuthContext | undefined;
    if (jwtResolver) {
      try {
        jwtCtx = await jwtResolver.authenticateRequest(request);
      } catch (err) {
        if (err instanceof SyncJwtError) {
          return jsonResponse({ error: err.message, code: err.code }, err.status);
        }
        throw err;
      }
    }

    let requestTenantId: string | number | undefined;
    try {
      if (jwtResolver && jwtCtx) {
        requestTenantId = jwtResolver.resolveEffectiveTenantId(
          jwtCtx,
          explicitRequestedTenant,
        );
      } else if (options.resolveTenantId) {
        requestTenantId = await options.resolveTenantId(request);
      } else {
        requestTenantId = explicitRequestedTenant ?? options.tenantGuard?.defaultTenantId;
      }
    } catch (err) {
      if (err instanceof SyncJwtError) {
        return jsonResponse({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }

    if (request.method === 'GET' && path.endsWith('/changelog')) {
      const sinceSequence = Number(url.searchParams.get('sinceSequence') ?? '0');
      const wantCompress =
        url.searchParams.get('compress') === '1' ||
        url.searchParams.get('compress') === 'true' ||
        url.searchParams.get('compress') === 'gzip';
      const wantRaw = url.searchParams.get('format') === 'raw';

      let rawItems: ReadonlyArray<Uint8Array | { sequence: number; rawBytes: Uint8Array }> = [];
      if (Array.isArray(changelogSource)) {
        rawItems = changelogSource;
      } else if (
        changelogSource &&
        typeof (changelogSource as ChangelogSegmentSource).readSegmentsSince === 'function'
      ) {
        rawItems = await (changelogSource as ChangelogSegmentSource).readSegmentsSince(
          sinceSequence,
        );
      }

      const matched: Array<{ sequence: number; bytes: Uint8Array }> = [];
      for (const item of rawItems) {
        const bytes = item instanceof Uint8Array ? item : item.rawBytes;
        const seq =
          item instanceof Uint8Array
            ? parseFbChangelogSegment(bytes).header.sequence
            : item.sequence;
        if (seq > sinceSequence) {
          matched.push({ sequence: seq, bytes });
        }
      }
      matched.sort((a, b) => a.sequence - b.sequence);

      if (wantRaw && matched.length === 1) {
        const single = matched[0]!;
        const payload = wantCompress ? await gzipBytes(single.bytes) : single.bytes;
        return new Response(new Uint8Array(payload), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-fb-changelog-sequence': String(single.sequence),
            ...(wantCompress ? { 'x-fb-changelog-encoding': 'gzip' } : {}),
          },
        });
      }

      const encodedSegments: Array<{
        sequence: number;
        encoding: 'base64' | 'gzip+base64';
        data: string;
      }> = [];
      for (const m of matched) {
        if (wantCompress) {
          const gz = await gzipBytes(m.bytes);
          encodedSegments.push({
            sequence: m.sequence,
            encoding: 'gzip+base64',
            data: bytesToBase64(gz),
          });
        } else {
          encodedSegments.push({
            sequence: m.sequence,
            encoding: 'base64',
            data: bytesToBase64(m.bytes),
          });
        }
      }
      return jsonResponse({ segments: encodedSegments });
    }

    if (request.method === 'POST' && path.endsWith('/changelog')) {
      if (jwtResolver && jwtCtx) {
        try {
          jwtResolver.assertWriteAllowed(jwtCtx);
        } catch (err) {
          if (err instanceof SyncJwtError) {
            return jsonResponse({ error: err.message, code: err.code }, err.status);
          }
          throw err;
        }
      }
      const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
      const incomingBytes: Uint8Array[] = [];

      if (contentType.includes('application/json')) {
        const body = (await request.json()) as {
          segments?: Array<{ encoding?: string; data: string } | string>;
        };
        for (const item of body.segments ?? []) {
          const b64 = typeof item === 'string' ? item : item.data;
          const enc = typeof item === 'string' ? 'base64' : (item.encoding ?? 'base64');
          const raw = base64ToBytes(b64);
          incomingBytes.push(
            enc === 'gzip+base64' || isGzipBytes(raw) ? await gunzipBytes(raw) : raw,
          );
        }
      } else {
        const rawBuf = new Uint8Array(await request.arrayBuffer());
        if (rawBuf.byteLength > 0) {
          const decoded =
            request.headers.get('x-fb-changelog-encoding') === 'gzip' ||
            request.headers.get('content-encoding') === 'gzip' ||
            isGzipBytes(rawBuf)
              ? await gunzipBytes(rawBuf)
              : rawBuf;
          incomingBytes.push(decoded);
        }
      }

      const results: ApplyFbChangelogResult[] = [];
      for (const segBytes of incomingBytes) {
        if (onChangelogSegment) {
          results.push(await onChangelogSegment(segBytes));
        } else if (changelogTargetDb) {
          results.push(await applyFbChangelogSegmentToDatabase(changelogTargetDb, segBytes));
        } else {
          const parsed = parseFbChangelogSegment(segBytes);
          results.push({
            sequence: parsed.header.sequence,
            blocksProcessed: parsed.blocks.length,
            ddlExecuted: parsed.executedSql,
            usedNativeReplicator: false,
          });
        }
      }
      return jsonResponse({ results });
    }

    if (request.method === 'GET' && path.endsWith('/presence')) {
      const roomId = url.searchParams.get('roomId') ?? 'default';
      return jsonResponse({
        roomId,
        peers: presenceHub.listPeers({ roomId, tenantId: requestTenantId }),
      });
    }

    if (request.method === 'POST' && path.endsWith('/presence')) {
      const body = (await request.json()) as {
        action?: 'update' | 'leave';
        roomId?: string;
        peerId?: string;
        version?: number;
        cursor?: PresenceCursor | null;
        typing?: boolean;
        state?: Record<string, unknown>;
        ttlMs?: number;
      };
      const roomId = (body.roomId ?? 'default').trim() || 'default';
      const peerId = (body.peerId ?? '').trim();
      if (!peerId) {
        return jsonResponse({ error: 'POST /presence requires peerId' }, 400);
      }
      if (body.action === 'leave') {
        presenceHub.removePeer(peerId, {
          roomId,
          tenantId: requestTenantId,
          version: body.version,
        });
        sseHub.broadcastPresence(
          { action: 'leave', roomId, peerId, version: body.version },
          { tenantId: requestTenantId },
        );
      } else {
        const peer = presenceHub.upsertPeer(
          {
            roomId,
            peerId,
            version: body.version,
            cursor: body.cursor,
            typing: body.typing,
            state: body.state,
            ttlMs: body.ttlMs,
          },
          { tenantId: requestTenantId },
        );
        sseHub.broadcastPresence(
          { action: 'update', roomId: peer.roomId, peer },
          { tenantId: requestTenantId },
        );
      }
      return jsonResponse({
        ok: true,
        roomId,
        peers: presenceHub.listPeers({ roomId, tenantId: requestTenantId }),
      });
    }

    if (request.method === 'GET' && path.endsWith('/events')) {
      const rawLastEventId =
        request.headers.get('last-event-id') ?? url.searchParams.get('sinceLsn');
      const parsedSinceLsn =
        rawLastEventId !== null && rawLastEventId.trim() !== ''
          ? Number(rawLastEventId)
          : undefined;
      const once =
        url.searchParams.get('once') === '1' ||
        url.searchParams.get('once') === 'true' ||
        url.searchParams.get('stream') === '0';
      return sseHub.openStream({
        tenantId: requestTenantId,
        jwtCtx,
        excludeOrigin: url.searchParams.get('excludeOrigin') ?? undefined,
        sinceLsn:
          parsedSinceLsn !== undefined && Number.isFinite(parsedSinceLsn)
            ? parsedSinceLsn
            : undefined,
        once,
        signal: request.signal,
      });
    }

    if (!publication) {
      return jsonResponse({ error: `Not Found: ${request.method} ${url.pathname}` }, 404);
    }

    if (request.method === 'GET' && (path.endsWith('/changes') || path === '')) {
      const sinceLsn = Number(url.searchParams.get('sinceLsn') ?? '0');
      const limitParam = url.searchParams.get('limit');
      const excludeOrigin = url.searchParams.get('excludeOrigin') ?? undefined;
      const rawEntries = await publication.fetchChangesSince(sinceLsn, {
        ...(limitParam ? { limit: Number(limitParam) } : {}),
        ...(excludeOrigin ? { excludeOrigin } : {}),
      });
      const tenantFiltered =
        options.tenantGuard && requestTenantId !== undefined
          ? options.tenantGuard.filterOutboundEntries(rawEntries, requestTenantId)
          : rawEntries;
      const entries =
        jwtResolver && jwtCtx
          ? jwtResolver.filterEntriesForContext(tenantFiltered, jwtCtx)
          : tenantFiltered;
      const currentLsn = await publication.currentLsn();
      return jsonResponse({
        name: publication.name,
        currentLsn,
        entries,
      });
    }

    if (request.method === 'GET' && path.endsWith('/snapshot/manifest')) {
      const snapshot = await publication.exportSnapshot({ mode: 'logical' });
      const snapshotId = `snap_${snapshot.watermarkLsn}_${snapshot.timestamp}_${snapshotCounter++}`;
      snapshotCache.set(snapshotId, snapshot);
      if (snapshotCache.size > 4) {
        const oldestKey = snapshotCache.keys().next().value;
        if (oldestKey !== undefined) snapshotCache.delete(oldestKey);
      }
      const manifest: ResumableSnapshotManifest = {
        snapshotId,
        publication: snapshot.publication,
        origin: snapshot.origin,
        watermarkLsn: snapshot.watermarkLsn,
        timestamp: snapshot.timestamp,
        tables: snapshot.tables.map((t) => ({
          table: t.table,
          primaryKey: t.primaryKey,
          ddlSql: t.ddlSql,
          totalRows: t.rows.length,
        })),
      };
      return jsonResponse({ manifest });
    }

    if (request.method === 'GET' && path.endsWith('/snapshot/chunk')) {
      const snapshotId = url.searchParams.get('snapshotId') ?? '';
      const tableName = (url.searchParams.get('table') ?? '').trim().toUpperCase();
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));
      const limit = Math.max(1, Number(url.searchParams.get('limit') ?? '500'));

      let snap = snapshotId ? snapshotCache.get(snapshotId) : undefined;
      if (!snap) {
        snap = await publication.exportSnapshot({ mode: 'logical' });
        if (snapshotId) {
          snapshotCache.set(snapshotId, snap);
        }
      }
      const tbl = snap.tables.find((t) => t.table.toUpperCase() === tableName);
      if (!tbl) {
        return jsonResponse({ error: `Unknown snapshot table: ${tableName}` }, 404);
      }
      const rows = tbl.rows.slice(offset, offset + limit);
      const hasMore = offset + rows.length < tbl.rows.length;
      return jsonResponse({
        snapshotId,
        table: tbl.table,
        offset,
        rows,
        totalRows: tbl.rows.length,
        hasMore,
      });
    }

    if (request.method === 'GET' && path.endsWith('/snapshot')) {
      const accept = (request.headers.get('accept') ?? '').toLowerCase();
      const formatParam = (url.searchParams.get('format') ?? '').toLowerCase();
      const wantArrow =
        formatParam === 'arrow' ||
        formatParam === 'arrow-ipc' ||
        accept.includes('application/vnd.apache.arrow.stream') ||
        accept.includes('application/x-firebird-arrow-snapshot');

      if (wantArrow) {
        const wantGzip =
          url.searchParams.get('compress') === '1' ||
          url.searchParams.get('compress') === 'true' ||
          url.searchParams.get('compress') === 'gzip' ||
          url.searchParams.get('gzip') === '1';
        const arrowSnap = await exportArrowSnapshot(publication, {
          tenantColumn: options.tenantGuard?.tenantColumn,
          tenantId: requestTenantId,
          sharedTables: options.tenantGuard ? [...options.tenantGuard.sharedTables] : undefined,
          allowedTables: jwtCtx?.allowedTables ?? null,
          rls: jwtCtx?.rls ?? null,
        });
        const bundle = await encodeArrowSnapshotBundle(arrowSnap, {
          compressGzip: wantGzip,
        });
        return new Response(new Uint8Array(bundle), {
          status: 200,
          headers: {
            'content-type': 'application/x-firebird-arrow-snapshot',
            'x-fb-snapshot-lsn': String(arrowSnap.watermarkLsn),
            ...(wantGzip ? { 'x-fb-snapshot-encoding': 'gzip' } : {}),
          },
        });
      }

      const rawSnap = await publication.exportSnapshot({ mode: 'logical' });
      const tenantSnap =
        options.tenantGuard && requestTenantId !== undefined
          ? {
              ...rawSnap,
              tables: rawSnap.tables.map((tbl) =>
                options.tenantGuard!.sharedTables.has(tbl.table.toUpperCase())
                  ? tbl
                  : {
                      ...tbl,
                      rows: tbl.rows.filter((r) => {
                        const tf = readTenantField(r, options.tenantGuard!.tenantColumn);
                        return tf.present && valuesMatchTenantId(tf.value, requestTenantId);
                      }),
                    },
              ),
            }
          : rawSnap;
      const tableFilteredSnap =
        jwtCtx?.allowedTables
          ? {
              ...tenantSnap,
              tables: tenantSnap.tables.filter((t) =>
                jwtCtx.allowedTables!.has(t.table.toUpperCase()),
              ),
            }
          : tenantSnap;
      const snapshot =
        jwtResolver && jwtCtx?.rls
          ? {
              ...tableFilteredSnap,
              tables: tableFilteredSnap.tables.map((t) => ({
                ...t,
                rows: jwtResolver.filterRowsForTable(t.table, t.rows, jwtCtx),
              })),
            }
          : tableFilteredSnap;
      return jsonResponse({ snapshot });
    }

    if (request.method === 'POST' && path.endsWith('/ack')) {
      const body = (await request.json()) as {
        slotName: string;
        confirmedLsn: number;
        nodeId?: string;
        ttlMs?: number;
      };
      const slot = await publication.advanceSlot(body.slotName, body.confirmedLsn, {
        nodeId: body.nodeId,
        ttlMs: body.ttlMs,
      });
      return jsonResponse({ slot });
    }

    if (request.method === 'POST' && path.endsWith('/heartbeat')) {
      const body = (await request.json()) as {
        slotName: string;
        now?: number;
      };
      const slot = await publication.heartbeatSlot(body.slotName, {
        now: body.now,
      });
      return jsonResponse({ slot });
    }

    if (request.method === 'POST' && path.endsWith('/push')) {
      const body = (await request.json()) as { entries: ReplicationLogEntry[] };
      const entries = body.entries ?? [];
      if (jwtResolver && jwtCtx) {
        try {
          jwtResolver.assertWriteAllowed(jwtCtx);
          jwtResolver.assertBatchTablesAllowed(jwtCtx, entries);
          jwtResolver.assertBatchRlsAllowed(jwtCtx, entries);
        } catch (err) {
          if (err instanceof SyncJwtError) {
            return jsonResponse({ error: err.message, code: err.code }, err.status);
          }
          throw err;
        }
      }
      if (options.tenantGuard) {
        try {
          options.tenantGuard.assertBatch(entries, requestTenantId);
        } catch (err) {
          if (err instanceof TenantIsolationError) {
            return jsonResponse(
              {
                error: err.message,
                code: err.code,
                table: err.table,
                reason: err.reason,
              },
              403,
            );
          }
          throw err;
        }
      }
      if (subscription) {
        try {
          const result = await subscription.applyChanges(entries);
          const notified = await sseHub.notifyChanges();
          if (notified === 0 && entries.length > 0 && result.appliedCount > 0) {
            sseHub.broadcastEntries(entries, result.currentLsn);
          }
          return jsonResponse({ result });
        } catch (err) {
          if (err instanceof TenantIsolationError) {
            return jsonResponse(
              {
                error: err.message,
                code: err.code,
                table: err.table,
                reason: err.reason,
              },
              403,
            );
          }
          throw err;
        }
      }
      let appliedCount = 0;
      for (const entry of entries) {
        if (entry.operation === 'DDL' && entry.ddlSql) {
          await publication.recordDdl(entry.ddlSql, {
            txid: entry.txid,
            origin: entry.origin,
            timestamp: entry.timestamp,
          });
          appliedCount++;
        } else if (entry.operation !== 'DDL') {
          await publication.recordDml({
            table: entry.table,
            operation: entry.operation,
            key: entry.key,
            after: entry.after,
            before: entry.before,
            txid: entry.txid,
            origin: entry.origin,
            timestamp: entry.timestamp,
          });
          appliedCount++;
        }
      }
      if (appliedCount > 0) {
        await sseHub.notifyChanges();
      }
      return jsonResponse({ result: { appliedCount } });
    }

    return jsonResponse({ error: `Not Found: ${request.method} ${url.pathname}` }, 404);
  };

  return async (request: Request): Promise<Response> => {
    const incomingTp = request.headers.get('traceparent');
    const runReq = async (tp: string): Promise<Response> => {
      const res = await innerHandle(request, tp);
      try {
        if (!res.headers.has('traceparent')) {
          res.headers.set('traceparent', tp);
        }
      } catch {
        // Ignore immutable response headers
      }
      return res;
    };
    if (options.otel) {
      const u = new URL(request.url, 'http://localhost');
      return options.otel.withSpan(
        `firebird.replication.http.${request.method.toLowerCase()}`,
        { 'http.request.method': request.method, 'url.path': u.pathname },
        ({ traceparent }) => runReq(traceparent),
        incomingTp,
      );
    }
    const { traceparent } = generateTraceparent({ parent: incomingTp });
    return runReq(traceparent);
  };
}

/**
 * Create an HTTP replication client that satisfies the `publication` contract
 * of {@link createSubscription} and supports slot acknowledgement, heartbeats,
 * snapshot bootstrap, and bidirectional change push.
 */
export function createHttpReplicationClient(
  options: HttpReplicationClientOptions,
): HttpReplicationClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const rawFetchFn = options.fetch ?? globalThis.fetch;
  const pubName = (options.name ?? 'default').trim();
  let clientState: ConnectionLifecycleState = 'online';

  const setClientState = (
    next: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ): void => {
    if (clientState === next && !info) return;
    clientState = next;
    options.onStateChange?.(next, info);
  };

  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const maxRetries = options.retry ? (options.retry.maxRetries ?? 4) : 0;
    let attempt = 0;
    for (;;) {
      try {
        if (attempt > 0) {
          setClientState('connecting', { attempt });
        }
        const res = await rawFetchFn(input, init);
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          const delayMs = computeBackoffDelayMs(attempt, options.retry);
          attempt++;
          setClientState('backoff', {
            attempt,
            delayMs,
            error: new Error(`HTTP ${res.status}`),
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        if (res.ok) {
          setClientState('online');
        }
        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delayMs = computeBackoffDelayMs(attempt, options.retry);
          attempt++;
          setClientState('backoff', { attempt, delayMs, error });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        setClientState('offline', { attempt, error });
        throw error;
      }
    }
  };

  let activeTokenSource: ReplicationTokenProvider | undefined =
    options.authToken ?? options.apiKey;

  const resolveCurrentToken = async (): Promise<string | undefined> => {
    if (typeof activeTokenSource === 'function') {
      return activeTokenSource();
    }
    return activeTokenSource;
  };

  const buildHeaders = async (
    extra?: Record<string, string>,
  ): Promise<Record<string, string>> => {
    const h: Record<string, string> = {
      accept: 'application/json',
      ...extra,
    };
    const tok = await resolveCurrentToken();
    if (tok) {
      h.authorization = `Bearer ${tok}`;
      h['x-replication-key'] = tok;
    }
    const tp =
      typeof options.traceparent === 'function'
        ? options.traceparent()
        : options.traceparent;
    if (tp && !h.traceparent) {
      h.traceparent = tp;
    }
    return h;
  };

  return {
    name: pubName,
    get state() {
      return clientState;
    },
    setAuthToken(tokenOrProvider) {
      activeTokenSource = tokenOrProvider;
    },

    async fetchChangesSince(sinceLsn, fetchOpts = {}) {
      const params = new URLSearchParams({ sinceLsn: String(sinceLsn) });
      if (fetchOpts.limit !== undefined) {
        params.set('limit', String(fetchOpts.limit));
      }
      if (fetchOpts.excludeOrigin) {
        params.set('excludeOrigin', fetchOpts.excludeOrigin);
      }
      const res = await fetchFn(`${baseUrl}/changes?${params.toString()}`, {
        method: 'GET',
        headers: await buildHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP replication fetchChangesSince failed with status ${res.status}`);
      }
      const data = (await res.json()) as { entries?: ReplicationLogEntry[] };
      return data.entries ?? [];
    },

    async ackSlot(slotName, confirmedLsn, slotOpts = {}) {
      const res = await fetchFn(`${baseUrl}/ack`, {
        method: 'POST',
        headers: await buildHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          slotName,
          confirmedLsn,
          ...slotOpts,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP replication ackSlot failed with status ${res.status}`);
      }
      const data = (await res.json()) as { slot: ReplicationSlot };
      return data.slot;
    },

    async heartbeatSlot(slotName, hbOpts = {}) {
      const res = await fetchFn(`${baseUrl}/heartbeat`, {
        method: 'POST',
        headers: await buildHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          slotName,
          ...hbOpts,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP replication heartbeatSlot failed with status ${res.status}`);
      }
      const data = (await res.json()) as { slot: ReplicationSlot | null };
      return data.slot;
    },

    async fetchSnapshot() {
      const res = await fetchFn(`${baseUrl}/snapshot`, {
        method: 'GET',
        headers: await buildHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP replication fetchSnapshot failed with status ${res.status}`);
      }
      const data = (await res.json()) as { snapshot: PublicationSnapshot };
      return data.snapshot;
    },

    async fetchArrowSnapshot(arrowOpts = {}) {
      const params = new URLSearchParams({ format: 'arrow' });
      if (arrowOpts.compressGzip) {
        params.set('compress', 'gzip');
      }
      const res = await fetchFn(`${baseUrl}/snapshot?${params.toString()}`, {
        method: 'GET',
        headers: await buildHeaders({
          accept: 'application/x-firebird-arrow-snapshot, application/vnd.apache.arrow.stream',
        }),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP replication fetchArrowSnapshot failed with status ${res.status}`,
        );
      }
      const raw = new Uint8Array(await res.arrayBuffer());
      return decodeArrowSnapshotBundle(raw);
    },

    async fetchSnapshotResumable(resumableOpts = {}) {
      return runHttpFetchSnapshotResumable(
        { baseUrl, fetchFn, buildHeaders },
        resumableOpts,
      );
    },

    async pushChanges(entries) {
      const res = await fetchFn(`${baseUrl}/push`, {
        method: 'POST',
        headers: await buildHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) {
        throw new Error(`HTTP replication pushChanges failed with status ${res.status}`);
      }
      const data = (await res.json()) as {
        result: SubscriptionPullResult | { appliedCount: number };
      };
      return data.result;
    },

    async fetchChangelogSegments(sinceSequence = 0, fetchOpts = {}) {
      return runHttpFetchChangelogSegments(
        { baseUrl, fetchFn, buildHeaders },
        sinceSequence,
        fetchOpts,
      );
    },

    async pushChangelogSegment(segments, pushOpts = {}) {
      return runHttpPushChangelogSegment(
        { baseUrl, fetchFn, buildHeaders },
        segments,
        pushOpts,
      );
    },

    async pullAndApplyChangelog(targetDb, sinceSequence = 0, pullOpts = {}) {
      return runHttpPullAndApplyChangelog(
        { baseUrl, fetchFn, buildHeaders },
        targetDb,
        sinceSequence,
        pullOpts,
      );
    },
  };
}

