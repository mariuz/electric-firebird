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
  isFbChangelogSegment,
  parseFbChangelogSegment,
  type ApplyFbChangelogResult,
  type JrdColumnDescriptor,
} from './native-changelog';

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
}

/** Options for {@link createHttpReplicationClient}. */
export interface HttpReplicationClientOptions {
  /** Base URL of the HTTP replication endpoint (e.g. `'https://api.example.com/replication'`). */
  baseUrl: string;
  /** Remote publication name. @default 'default' */
  name?: string;
  /** Custom `fetch` implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Optional API key sent as `Authorization: Bearer <apiKey>` and `x-replication-key`. */
  apiKey?: string;
}

/** Remote publication client returned by {@link createHttpReplicationClient}. */
export interface HttpReplicationClient {
  readonly name: string;
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

  return async (request: Request): Promise<Response> => {
    if (apiKey) {
      const auth = request.headers.get('authorization') ?? '';
      const keyHeader = request.headers.get('x-replication-key') ?? '';
      if (auth !== `Bearer ${apiKey}` && keyHeader !== apiKey) {
        return jsonResponse({ error: 'Unauthorized replication request' }, 401);
      }
    }

    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');

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

    if (!publication) {
      return jsonResponse({ error: `Not Found: ${request.method} ${url.pathname}` }, 404);
    }

    if (request.method === 'GET' && (path.endsWith('/changes') || path === '')) {
      const sinceLsn = Number(url.searchParams.get('sinceLsn') ?? '0');
      const limitParam = url.searchParams.get('limit');
      const excludeOrigin = url.searchParams.get('excludeOrigin') ?? undefined;
      const entries = await publication.fetchChangesSince(sinceLsn, {
        ...(limitParam ? { limit: Number(limitParam) } : {}),
        ...(excludeOrigin ? { excludeOrigin } : {}),
      });
      const currentLsn = await publication.currentLsn();
      return jsonResponse({
        name: publication.name,
        currentLsn,
        entries,
      });
    }

    if (request.method === 'GET' && path.endsWith('/snapshot')) {
      const snapshot = await publication.exportSnapshot({ mode: 'logical' });
      return jsonResponse({ snapshot });
    }

    if (request.method === 'GET' && path.endsWith('/events')) {
      const currentLsn = await publication.currentLsn();
      const ssePayload = `event: replication\ndata: ${JSON.stringify({
        publication: publication.name,
        currentLsn,
      })}\n\n`;
      return new Response(ssePayload, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
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
      if (subscription) {
        const result = await subscription.applyChanges(entries);
        return jsonResponse({ result });
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
      return jsonResponse({ result: { appliedCount } });
    }

    return jsonResponse({ error: `Not Found: ${request.method} ${url.pathname}` }, 404);
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
  const fetchFn = options.fetch ?? globalThis.fetch;
  const pubName = (options.name ?? 'default').trim();

  const buildHeaders = (extra?: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = {
      accept: 'application/json',
      ...extra,
    };
    if (options.apiKey) {
      h.authorization = `Bearer ${options.apiKey}`;
      h['x-replication-key'] = options.apiKey;
    }
    return h;
  };

  return {
    name: pubName,

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
        headers: buildHeaders(),
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
        headers: buildHeaders({ 'content-type': 'application/json' }),
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
        headers: buildHeaders({ 'content-type': 'application/json' }),
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
        headers: buildHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP replication fetchSnapshot failed with status ${res.status}`);
      }
      const data = (await res.json()) as { snapshot: PublicationSnapshot };
      return data.snapshot;
    },

    async pushChanges(entries) {
      const res = await fetchFn(`${baseUrl}/push`, {
        method: 'POST',
        headers: buildHeaders({ 'content-type': 'application/json' }),
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
      const params = new URLSearchParams({ sinceSequence: String(sinceSequence) });
      if (fetchOpts.compress) {
        params.set('compress', 'gzip');
      }
      const res = await fetchFn(`${baseUrl}/changelog?${params.toString()}`, {
        method: 'GET',
        headers: buildHeaders(),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP replication fetchChangelogSegments failed with status ${res.status}`,
        );
      }
      const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
      if (ctype.includes('application/octet-stream')) {
        const raw = new Uint8Array(await res.arrayBuffer());
        const decoded =
          res.headers.get('x-fb-changelog-encoding') === 'gzip' || isGzipBytes(raw)
            ? await gunzipBytes(raw)
            : raw;
        return decoded.byteLength > 0 ? [decoded] : [];
      }
      const data = (await res.json()) as {
        segments?: Array<{ sequence: number; encoding?: string; data: string }>;
      };
      const out: Uint8Array[] = [];
      for (const s of data.segments ?? []) {
        const raw = base64ToBytes(s.data);
        out.push(
          s.encoding === 'gzip+base64' || isGzipBytes(raw) ? await gunzipBytes(raw) : raw,
        );
      }
      return out;
    },

    async pushChangelogSegment(segments, pushOpts = {}) {
      const list = segments instanceof Uint8Array ? [segments] : segments;
      if (list.length === 1) {
        const single = list[0]!;
        const bodyBytes = pushOpts.compress ? await gzipBytes(single) : single;
        const res = await fetchFn(`${baseUrl}/changelog`, {
          method: 'POST',
          headers: buildHeaders({
            'content-type': 'application/octet-stream',
            ...(pushOpts.compress ? { 'x-fb-changelog-encoding': 'gzip' } : {}),
          }),
          body: new Uint8Array(bodyBytes),
        });
        if (!res.ok) {
          throw new Error(
            `HTTP replication pushChangelogSegment failed with status ${res.status}`,
          );
        }
        const data = (await res.json()) as { results?: ApplyFbChangelogResult[] };
        return data.results ?? [];
      }

      const encoded: Array<{ encoding: 'base64' | 'gzip+base64'; data: string }> = [];
      for (const seg of list) {
        if (pushOpts.compress) {
          const gz = await gzipBytes(seg);
          encoded.push({ encoding: 'gzip+base64', data: bytesToBase64(gz) });
        } else {
          encoded.push({ encoding: 'base64', data: bytesToBase64(seg) });
        }
      }
      const res = await fetchFn(`${baseUrl}/changelog`, {
        method: 'POST',
        headers: buildHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ segments: encoded }),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP replication pushChangelogSegment failed with status ${res.status}`,
        );
      }
      const data = (await res.json()) as { results?: ApplyFbChangelogResult[] };
      return data.results ?? [];
    },

    async pullAndApplyChangelog(targetDb, sinceSequence = 0, pullOpts = {}) {
      const segments = await this.fetchChangelogSegments(sinceSequence, {
        compress: pullOpts.compress,
      });
      const results: ApplyFbChangelogResult[] = [];
      for (const segBytes of segments) {
        results.push(
          await applyFbChangelogSegmentToDatabase(targetDb, segBytes, {
            preferLogicalFallback: pullOpts.preferLogicalFallback,
            ...(pullOpts.tableSchemas !== undefined
              ? { tableSchemas: pullOpts.tableSchemas }
              : {}),
          }),
        );
      }
      return results;
    },
  };
}

/** Structural interface for a browser `BroadcastChannel` or test double. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

const inProcessBroadcastBus = new Map<string, Set<(data: unknown) => void>>();

function createInProcessChannel(channelName: string): BroadcastChannelLike {
  let listeners = inProcessBroadcastBus.get(channelName);
  if (!listeners) {
    listeners = new Set();
    inProcessBroadcastBus.set(channelName, listeners);
  }
  const localListeners = new Set<(event: { data: unknown }) => void>();
  const dispatch = (data: unknown) => {
    for (const fn of localListeners) {
      fn({ data });
    }
    if (channel.onmessage) {
      channel.onmessage({ data });
    }
  };
  listeners.add(dispatch);

  const channel: BroadcastChannelLike = {
    postMessage(message: unknown) {
      const group = inProcessBroadcastBus.get(channelName);
      if (!group) return;
      for (const peerDispatch of group) {
        if (peerDispatch !== dispatch) {
          peerDispatch(message);
        }
      }
    },
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      localListeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      localListeners.delete(listener);
    },
    onmessage: null,
    close() {
      inProcessBroadcastBus.get(channelName)?.delete(dispatch);
      localListeners.clear();
    },
  };
  return channel;
}

/** Options for {@link createBroadcastChannelTransport}. */
export interface BroadcastChannelTransportOptions {
  /** BroadcastChannel name shared across tabs/workers. @default 'fb_repl_channel' */
  channelName?: string;
  /** Optional custom `BroadcastChannel` instance. */
  channel?: BroadcastChannelLike;
  /** Local publication whose changes are broadcast to peer tabs/workers. */
  publication?: ReplicationPublication;
  /** Local subscription that applies entries received from peer tabs/workers. */
  subscription?: ReplicationSubscription;
  /** Automatically call `subscription.pull()` when a peer announces a new LSN. @default true */
  autoPullOnAnnounce?: boolean;
}

/** Cross-tab / cross-worker transport returned by {@link createBroadcastChannelTransport}. */
export interface BroadcastChannelTransport {
  readonly channelName: string;
  /** Broadcast explicit journal entries to all peer tabs/workers on the channel. */
  publishEntries(entries: readonly ReplicationLogEntry[]): Promise<void>;
  /** Broadcast a lightweight LSN wakeup signal to peer tabs/workers. */
  announceChange(lsn?: number): Promise<void>;
  /** Capture new local table changes on `publication` and broadcast them to peers. */
  sync(): Promise<ReplicationLogEntry[]>;
  /** Close the underlying `BroadcastChannel` listener. */
  close(): void;
}

/**
 * Create a cross-tab / cross-worker replication transport backed by `BroadcastChannel`
 * (with an automatic in-process fallback when `BroadcastChannel` is unavailable).
 */
export function createBroadcastChannelTransport(
  options: BroadcastChannelTransportOptions = {},
): BroadcastChannelTransport {
  const channelName = (options.channelName ?? 'fb_repl_channel').trim();
  const autoPull = options.autoPullOnAnnounce ?? true;
  const ownsChannel = !options.channel;
  const channel: BroadcastChannelLike =
    options.channel ??
    (typeof globalThis.BroadcastChannel === 'function'
      ? (new globalThis.BroadcastChannel(channelName) as unknown as BroadcastChannelLike)
      : createInProcessChannel(channelName));

  let lastBroadcastLsn = 0;

  const onMessage = (event: { data: unknown }) => {
    const msg = event.data as
      | {
          type?: string;
          origin?: string;
          lsn?: number;
          entries?: ReplicationLogEntry[];
        }
      | undefined;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'entries' && Array.isArray(msg.entries) && options.subscription) {
      if (msg.origin && msg.origin === options.subscription.nodeId) return;
      void options.subscription.applyChanges(msg.entries);
    } else if (msg.type === 'announce' && autoPull && options.subscription) {
      if (msg.origin && msg.origin === options.subscription.nodeId) return;
      void options.subscription.pull();
    }
  };

  if (typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', onMessage);
  } else {
    channel.onmessage = onMessage;
  }

  return {
    channelName,

    async publishEntries(entries) {
      if (entries.length === 0) return;
      for (const e of entries) {
        if (e.lsn > lastBroadcastLsn) {
          lastBroadcastLsn = e.lsn;
        }
      }
      channel.postMessage({
        type: 'entries',
        origin: options.publication?.nodeId,
        entries: [...entries],
      });
    },

    async announceChange(lsn) {
      const effectiveLsn =
        lsn ?? (options.publication ? await options.publication.currentLsn() : 0);
      channel.postMessage({
        type: 'announce',
        origin: options.publication?.nodeId,
        lsn: effectiveLsn,
      });
    },

    async sync() {
      if (!options.publication) return [];
      await options.publication.captureTableChanges();
      const entries = await options.publication.fetchChangesSince(lastBroadcastLsn, {
        excludeOrigin: options.subscription?.nodeId,
      });
      if (entries.length > 0) {
        await this.publishEntries(entries);
      }
      return entries;
    },

    close() {
      if (typeof channel.removeEventListener === 'function') {
        channel.removeEventListener('message', onMessage);
      } else if (channel.onmessage === onMessage) {
        channel.onmessage = null;
      }
      if (ownsChannel) {
        channel.close?.();
      }
    },
  };
}

/** Structural interface for a standard `WebSocket` or duplex test socket. */
export interface WebSocketLike {
  send(data: string | Uint8Array): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

/** Options for {@link createWebSocketReplicationPeer}. */
export interface WebSocketReplicationPeerOptions {
  /** Duplex WebSocket connection. */
  socket: WebSocketLike;
  /** Local publication to stream changes from. */
  publication?: ReplicationPublication;
  /** Local subscription to apply incoming changes to. */
  subscription?: ReplicationSubscription;
  /** Optional replica database to automatically apply incoming `"FBCHANGELOG\0"` binary frames to (`M18 Item 1`). */
  changelogTargetDb?: ReplicableDatabase;
  /** Optional callback invoked when a binary `"FBCHANGELOG\0"` segment frame arrives (`M18 Item 1`). */
  onChangelogSegment?: (
    segment: Uint8Array,
    result?: ApplyFbChangelogResult,
  ) => void | Promise<void>;
}

/** Duplex WebSocket replication peer returned by {@link createWebSocketReplicationPeer}. */
export interface WebSocketReplicationPeer {
  /** Push local journal entries after `sinceLsn` (or last pushed LSN) over the WebSocket. */
  pushSince(sinceLsn?: number): Promise<number>;
  /** Request the remote peer to stream changes after `sinceLsn` (or current watermark). */
  requestPull(sinceLsn?: number): Promise<void>;
  /** Stream a binary `"FBCHANGELOG\0"` segment frame (optionally gzip-compressed) over the WebSocket (`M18 Item 1`). */
  sendChangelogSegment(
    segment: Uint8Array,
    options?: { compress?: boolean },
  ): Promise<void>;
  /** Detach message listeners from the WebSocket. */
  close(): void;
}

/**
 * Create a duplex WebSocket replication peer that streams `ReplicationLogEntry`
 * batches, pull requests, slot acknowledgements, and raw/gzipped `"FBCHANGELOG\0"`
 * binary frames over a `WebSocketLike` channel.
 */
export function createWebSocketReplicationPeer(
  options: WebSocketReplicationPeerOptions,
): WebSocketReplicationPeer {
  const {
    socket,
    publication,
    subscription,
    changelogTargetDb,
    onChangelogSegment,
  } = options;
  let lastPushedLsn = 0;

  const handleBinaryChangelog = async (bytes: Uint8Array): Promise<boolean> => {
    let candidate = bytes;
    if (isGzipBytes(bytes)) {
      try {
        candidate = await gunzipBytes(bytes);
      } catch {
        return false;
      }
    }
    if (!isFbChangelogSegment(candidate)) {
      return false;
    }
    let applyResult: ApplyFbChangelogResult | undefined;
    if (changelogTargetDb) {
      applyResult = await applyFbChangelogSegmentToDatabase(changelogTargetDb, candidate);
    }
    if (onChangelogSegment) {
      await onChangelogSegment(candidate, applyResult);
    }
    const seq = applyResult?.sequence ?? parseFbChangelogSegment(candidate).header.sequence;
    socket.send(
      JSON.stringify({
        type: 'repl_changelog_ack',
        sequence: seq,
      }),
    );
    return true;
  };

  const handleMessage = async (raw: unknown): Promise<void> => {
    let text: string;
    if (raw instanceof Uint8Array) {
      if (await handleBinaryChangelog(raw)) {
        return;
      }
      text = new TextDecoder().decode(raw);
    } else if (raw instanceof ArrayBuffer) {
      const bytes = new Uint8Array(raw);
      if (await handleBinaryChangelog(bytes)) {
        return;
      }
      text = new TextDecoder().decode(bytes);
    } else if (typeof raw === 'string') {
      text = raw;
    } else {
      return;
    }

    let msg: {
      type?: string;
      sinceLsn?: number;
      excludeOrigin?: string;
      entries?: ReplicationLogEntry[];
      slotName?: string;
      confirmedLsn?: number;
      nodeId?: string;
    };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }

    if (msg.type === 'repl_pull_request' && publication) {
      const entries = await publication.fetchChangesSince(msg.sinceLsn ?? 0, {
        excludeOrigin: msg.excludeOrigin,
      });
      socket.send(
        JSON.stringify({
          type: 'repl_entries',
          entries,
        }),
      );
    } else if (msg.type === 'repl_entries' && Array.isArray(msg.entries) && subscription) {
      const res = await subscription.applyChanges(msg.entries);
      socket.send(
        JSON.stringify({
          type: 'repl_ack',
          slotName: subscription.slotName,
          confirmedLsn: res.currentLsn,
          nodeId: subscription.nodeId,
        }),
      );
    } else if (
      msg.type === 'repl_ack' &&
      publication &&
      msg.slotName &&
      typeof msg.confirmedLsn === 'number'
    ) {
      await publication.advanceSlot(msg.slotName, msg.confirmedLsn, {
        nodeId: msg.nodeId,
      });
    }
  };

  const listener = (event: { data: unknown }) => {
    void handleMessage(event.data);
  };

  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('message', listener);
  } else {
    socket.onmessage = listener;
  }

  return {
    async pushSince(sinceLsn?: number): Promise<number> {
      if (!publication) return 0;
      const fromLsn = sinceLsn ?? lastPushedLsn;
      const entries = await publication.fetchChangesSince(fromLsn, {
        excludeOrigin: subscription?.nodeId,
      });
      if (entries.length > 0) {
        for (const e of entries) {
          if (e.lsn > lastPushedLsn) lastPushedLsn = e.lsn;
        }
        socket.send(
          JSON.stringify({
            type: 'repl_entries',
            entries,
          }),
        );
      }
      return entries.length;
    },

    async requestPull(sinceLsn?: number): Promise<void> {
      const wmk = sinceLsn ?? (subscription ? await subscription.getWatermark() : 0);
      socket.send(
        JSON.stringify({
          type: 'repl_pull_request',
          sinceLsn: wmk,
          excludeOrigin: subscription?.nodeId,
        }),
      );
    },

    async sendChangelogSegment(segment, sendOpts = {}): Promise<void> {
      const payload = sendOpts.compress ? await gzipBytes(segment) : segment;
      socket.send(payload);
    },

    close() {
      if (typeof socket.removeEventListener === 'function') {
        socket.removeEventListener('message', listener);
      } else if (socket.onmessage === listener) {
        socket.onmessage = null;
      }
    },
  };
}

