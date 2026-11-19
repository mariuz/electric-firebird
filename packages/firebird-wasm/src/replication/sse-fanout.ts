/**
 * sse-fanout.ts – Multi-Subscriber Server-Sent Events (`GET /events`) Pub/Sub
 * Fanout Hub, `Last-Event-ID` Resume & Streaming `createSseReplicationClient` (`M25 Item 1`).
 */

import type {
  ReplicationLogEntry,
  ReplicationPublication,
  ReplicationSubscription,
} from './types';
import { valuesMatchTenantId, type TenantIsolationGuard } from './tenant-slice';
import type { JwtTenantAuthContext, JwtTenantAuthResolver } from './jwt-auth';
import {
  computeBackoffDelayMs,
  type BackoffRetryOptions,
  type ConnectionLifecycleState,
  type ConnectionStateChangeInfo,
} from './webrtc-resilient';
import type { ReplicationTokenProvider } from './transports';

const utf8Encoder = new TextEncoder();

export interface SseSubscriberContext {
  readonly tenantId?: string | number;
  readonly jwtCtx?: JwtTenantAuthContext;
  readonly excludeOrigin?: string;
  readonly sinceLsn?: number;
  readonly once?: boolean;
  readonly signal?: AbortSignal;
}

export interface SseReplicationHubOptions {
  publication?: ReplicationPublication;
  tenantGuard?: TenantIsolationGuard;
  jwtResolver?: JwtTenantAuthResolver;
  /** Keep-alive comment interval in milliseconds (`0` disables heartbeats). @default 15000 */
  heartbeatIntervalMs?: number;
}

export interface SseReplicationHub {
  readonly subscriberCount: number;
  /** Open an SSE `Response` for an authenticated subscriber, replaying missed entries since `Last-Event-ID` / `sinceLsn`. */
  openStream(ctx?: SseSubscriberContext): Promise<Response>;
  /** Broadcast explicit journal entries to all connected SSE subscribers (filtered by each subscriber's tenant/table/RLS scope). */
  broadcastEntries(entries: readonly ReplicationLogEntry[], currentLsn?: number): void;
  /** Broadcast an ephemeral `event: presence` awareness frame scoped to matching tenant subscribers (`M26 Item 1`). */
  broadcastPresence(payload: unknown, scope?: { tenantId?: string | number }): void;
  /** Capture newly committed publication changes since the hub's last watermark and fan them out to all connected subscribers. */
  notifyChanges(): Promise<number>;
  /** Close all open SSE streams and timers cleanly. */
  close(): void;
}

interface ActiveSubscriber {
  readonly id: number;
  readonly tenantId?: string | number;
  readonly jwtCtx?: JwtTenantAuthContext;
  readonly excludeOrigin?: string;
  lastSentLsn: number;
  closed: boolean;
  enqueue: (text: string) => void;
  terminate: () => void;
}

function formatSseEvent(event: string, data: unknown, id?: number): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Create a multi-subscriber Server-Sent Events (`text/event-stream`) fanout hub
 * enforcing per-subscriber `TenantIsolationGuard` and JWT `tables` / `rls` claims (`M25 Item 1`).
 */
export function createSseReplicationHub(
  options: SseReplicationHubOptions = {},
): SseReplicationHub {
  const subscribers = new Map<number, ActiveSubscriber>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  let nextSubId = 1;
  let hubHighWaterLsn = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let hubClosed = false;

  const filterForSubscriber = (
    rawEntries: readonly ReplicationLogEntry[],
    sub: Pick<ActiveSubscriber, 'tenantId' | 'jwtCtx' | 'excludeOrigin' | 'lastSentLsn'>,
  ): ReplicationLogEntry[] => {
    let list = rawEntries.filter(
      (e) =>
        e.lsn > sub.lastSentLsn &&
        (!sub.excludeOrigin || e.origin !== sub.excludeOrigin),
    );
    if (list.length === 0) return [];
    if (options.tenantGuard && sub.tenantId !== undefined) {
      list = options.tenantGuard.filterOutboundEntries(list, sub.tenantId);
    }
    if (options.jwtResolver && sub.jwtCtx) {
      list = options.jwtResolver.filterEntriesForContext(list, sub.jwtCtx);
    }
    return list;
  };

  const ensureHeartbeatTimer = (): void => {
    if (heartbeatTimer !== null || heartbeatIntervalMs <= 0 || subscribers.size === 0) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (subscribers.size === 0) {
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        return;
      }
      for (const sub of [...subscribers.values()]) {
        sub.enqueue(`: keepalive ${Date.now()}\n\n`);
      }
    }, heartbeatIntervalMs);
    if (typeof (heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  };

  const removeSubscriber = (id: number): void => {
    subscribers.delete(id);
    if (subscribers.size === 0 && heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  return {
    get subscriberCount() {
      return subscribers.size;
    },

    async openStream(ctx: SseSubscriberContext = {}): Promise<Response> {
      const pub = options.publication;
      if (pub && subscribers.size > 0 && !ctx.once && !hubClosed) {
        await this.notifyChanges();
      }
      const currentLsn = pub ? await pub.currentLsn() : 0;
      if (subscribers.size === 0 && currentLsn > hubHighWaterLsn) {
        hubHighWaterLsn = currentLsn;
      }

      let missedEntries: ReplicationLogEntry[] = [];
      if (pub && ctx.sinceLsn !== undefined && Number.isFinite(ctx.sinceLsn) && ctx.sinceLsn >= 0) {
        const rawMissed = await pub.fetchChangesSince(ctx.sinceLsn, {
          excludeOrigin: ctx.excludeOrigin,
        });
        missedEntries = filterForSubscriber(rawMissed, {
          tenantId: ctx.tenantId,
          jwtCtx: ctx.jwtCtx,
          excludeOrigin: ctx.excludeOrigin,
          lastSentLsn: ctx.sinceLsn,
        });
      }

      // Single-shot mode (`?once=1` or when hub is already closed)
      if (ctx.once || hubClosed) {
        let payload = formatSseEvent(
          'replication',
          { publication: pub?.name ?? 'default', currentLsn },
          currentLsn,
        );
        if (missedEntries.length > 0) {
          const maxMissed = missedEntries[missedEntries.length - 1]!.lsn;
          payload += formatSseEvent(
            'changes',
            { publication: pub?.name ?? 'default', currentLsn: maxMissed, entries: missedEntries },
            maxMissed,
          );
        }
        return new Response(payload, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      const subId = nextSubId++;
      let subRef: ActiveSubscriber | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const cleanup = () => {
            if (!subRef || subRef.closed) return;
            subRef.closed = true;
            removeSubscriber(subId);
            if (ctx.signal) {
              ctx.signal.removeEventListener('abort', onAbort);
            }
            try {
              controller.close();
            } catch {
              // Controller already closed
            }
          };

          const onAbort = () => cleanup();
          if (ctx.signal) {
            if (ctx.signal.aborted) {
              cleanup();
              return;
            }
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          }

          const initialWatermark =
            missedEntries.length > 0
              ? missedEntries[missedEntries.length - 1]!.lsn
              : currentLsn;

          subRef = {
            id: subId,
            tenantId: ctx.tenantId,
            jwtCtx: ctx.jwtCtx,
            excludeOrigin: ctx.excludeOrigin,
            lastSentLsn: initialWatermark,
            closed: false,
            enqueue(text: string) {
              if (this.closed) return;
              try {
                controller.enqueue(utf8Encoder.encode(text));
              } catch {
                cleanup();
              }
            },
            terminate: cleanup,
          };

          subscribers.set(subId, subRef);
          ensureHeartbeatTimer();

          subRef.enqueue(
            formatSseEvent(
              'replication',
              { publication: pub?.name ?? 'default', currentLsn },
              currentLsn,
            ),
          );
          if (missedEntries.length > 0) {
            subRef.enqueue(
              formatSseEvent(
                'changes',
                {
                  publication: pub?.name ?? 'default',
                  currentLsn: initialWatermark,
                  entries: missedEntries,
                },
                initialWatermark,
              ),
            );
          }
        },
        cancel() {
          if (subRef && !subRef.closed) {
            subRef.closed = true;
            removeSubscriber(subId);
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    },

    broadcastEntries(entries: readonly ReplicationLogEntry[], explicitCurrentLsn?: number): void {
      if (entries.length === 0) return;
      const batchMaxLsn = entries.reduce(
        (max, e) => (e.lsn > max ? e.lsn : max),
        explicitCurrentLsn ?? 0,
      );
      if (batchMaxLsn > hubHighWaterLsn) {
        hubHighWaterLsn = batchMaxLsn;
      }
      if (subscribers.size === 0) return;

      const pubName = options.publication?.name ?? 'default';
      for (const sub of [...subscribers.values()]) {
        if (sub.closed) continue;
        const allowed = filterForSubscriber(entries, sub);
        if (allowed.length === 0) continue;
        const subMaxLsn = allowed[allowed.length - 1]!.lsn;
        sub.lastSentLsn = Math.max(sub.lastSentLsn, subMaxLsn);
        sub.enqueue(
          formatSseEvent(
            'changes',
            {
              publication: pubName,
              currentLsn: Math.max(batchMaxLsn, subMaxLsn),
              entries: allowed,
            },
            subMaxLsn,
          ),
        );
      }
    },

    async notifyChanges(): Promise<number> {
      const pub = options.publication;
      if (!pub) return 0;
      await pub.refreshPublishedTables();
      await pub.captureTableChanges();
      const newEntries = await pub.fetchChangesSince(hubHighWaterLsn);
      if (newEntries.length === 0) return 0;
      const maxLsn = newEntries[newEntries.length - 1]!.lsn;
      hubHighWaterLsn = Math.max(hubHighWaterLsn, maxLsn);
      this.broadcastEntries(newEntries, maxLsn);
      return newEntries.length;
    },

    broadcastPresence(payload: unknown, scope: { tenantId?: string | number } = {}): void {
      if (subscribers.size === 0) return;
      const enforceTenant =
        scope.tenantId !== undefined ||
        Boolean(options.tenantGuard) ||
        Boolean(options.jwtResolver);
      const frame = formatSseEvent('presence', payload);
      for (const sub of [...subscribers.values()]) {
        if (sub.closed) continue;
        if (enforceTenant) {
          if (scope.tenantId === undefined && sub.tenantId === undefined) {
            // Both un-scoped: allow
          } else if (
            scope.tenantId !== undefined &&
            sub.tenantId !== undefined &&
            valuesMatchTenantId(sub.tenantId, scope.tenantId)
          ) {
            // Matching tenant: allow
          } else {
            continue;
          }
        }
        sub.enqueue(frame);
      }
    },

    close(): void {
      hubClosed = true;
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const sub of [...subscribers.values()]) {
        sub.terminate();
      }
      subscribers.clear();
    },
  };
}

export interface SseReplicationClientOptions {
  /** Base URL of the HTTP replication endpoint (e.g. `'http://127.0.0.1:8787'`). */
  baseUrl: string;
  /** Custom `fetch` implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Static Bearer token / API key or async dynamic provider (`Authorization: Bearer <token>`). */
  apiKey?: ReplicationTokenProvider;
  /** Alias for `apiKey` accepting a static JWT or async provider. */
  authToken?: ReplicationTokenProvider;
  /** Initial LSN to resume from via `Last-Event-ID` & `?sinceLsn=`. */
  sinceLsn?: number;
  /** Origin node ID excluded from echoed delta frames. */
  excludeOrigin?: string;
  /** Optional local `ReplicationSubscription` to automatically apply incoming SSE `changes` batches to. */
  subscription?: ReplicationSubscription;
  /** Callback invoked when an SSE `changes` frame arrives. */
  onEntries?: (
    entries: ReplicationLogEntry[],
    currentLsn: number,
  ) => void | Promise<void>;
  /** Callback invoked when the initial or periodic `replication` status frame arrives. */
  onSyncEvent?: (info: { publication: string; currentLsn: number }) => void;
  /** Callback invoked when an ephemeral `event: presence` frame arrives (`M26 Item 1`). */
  onPresence?: (payload: Record<string, unknown>) => void;
  /** Lifecycle callback (`'connecting' | 'online' | 'backoff' | 'offline'`). */
  onStateChange?: (
    state: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ) => void;
  /** Error callback for stream or apply errors. */
  onError?: (error: Error) => void;
  /** Exponential backoff + jitter reconnection policy. */
  retry?: BackoffRetryOptions;
  /** Start streaming immediately on creation. @default true */
  autoStart?: boolean;
}

export interface SseReplicationClient {
  readonly state: ConnectionLifecycleState;
  readonly lastEventId: number;
  setAuthToken(tokenOrProvider: ReplicationTokenProvider | undefined): void;
  start(): void;
  waitForConnected(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Create a streaming Server-Sent Events (`GET /events`) replication client with
 * `Authorization: Bearer <jwt>` support, `Last-Event-ID` catch-up on reconnect,
 * live token rotation, and automatic `ReplicationSubscription.applyChanges()` (`M25 Item 1`).
 */
export function createSseReplicationClient(
  options: SseReplicationClientOptions,
): SseReplicationClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const backoffOpts: BackoffRetryOptions = {
    maxRetries: 5,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    factor: 2,
    jitterRatio: 0.15,
    ...options.retry,
  };

  let tokenSource: ReplicationTokenProvider | undefined =
    options.authToken ?? options.apiKey;
  let state: ConnectionLifecycleState = 'offline';
  let lastEventId = options.sinceLsn ?? 0;
  let running = false;
  let closed = false;
  let abortCtrl: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let loopPromise: Promise<void> | null = null;
  const connectedWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();

  const setState = (
    next: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ): void => {
    if (state === next && !info) return;
    state = next;
    options.onStateChange?.(next, info);
    if (next === 'online') {
      for (const w of [...connectedWaiters]) {
        connectedWaiters.delete(w);
        w.resolve();
      }
    }
  };

  const resolveToken = async (): Promise<string | undefined> => {
    if (typeof tokenSource === 'function') return tokenSource();
    return tokenSource;
  };

  const dispatchParsedFrame = async (
    eventType: string,
    rawData: string,
    frameId?: number,
  ): Promise<void> => {
    if (frameId !== undefined && Number.isFinite(frameId) && frameId > lastEventId) {
      lastEventId = frameId;
    }
    if (!rawData) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return;
    }

    if (eventType === 'replication') {
      const lsn = Number(parsed.currentLsn ?? 0);
      if (Number.isFinite(lsn) && lsn > lastEventId && options.sinceLsn === undefined && lastEventId === 0) {
        // Keep lastEventId at 0 only until actual changes or initial watermark if no prior state
        lastEventId = lsn;
      }
      options.onSyncEvent?.({
        publication: String(parsed.publication ?? 'default'),
        currentLsn: Number.isFinite(lsn) ? lsn : 0,
      });
      return;
    }

    if (eventType === 'presence') {
      options.onPresence?.(parsed);
      return;
    }

    if (eventType === 'changes' && Array.isArray(parsed.entries)) {
      const entries = parsed.entries as ReplicationLogEntry[];
      const currentLsn = Number(
        parsed.currentLsn ??
          (entries.length > 0 ? entries[entries.length - 1]!.lsn : lastEventId),
      );
      if (entries.length > 0) {
        if (options.subscription) {
          await options.subscription.applyChanges(entries);
        }
        await options.onEntries?.(entries, currentLsn);
        const maxEntryLsn = entries[entries.length - 1]!.lsn;
        if (maxEntryLsn > lastEventId) {
          lastEventId = maxEntryLsn;
        }
      }
    }
  };

  const runStreamLoop = async (): Promise<void> => {
    let attempt = 0;
    const maxRetries = backoffOpts.maxRetries ?? 5;

    if (options.subscription && options.sinceLsn === undefined && lastEventId === 0) {
      try {
        lastEventId = await options.subscription.getWatermark();
      } catch {
        // Ignore
      }
    }

    while (running && !closed) {
      abortCtrl = new AbortController();
      setState('connecting', attempt > 0 ? { attempt } : undefined);

      try {
        const params = new URLSearchParams();
        if (lastEventId > 0 || options.sinceLsn !== undefined) {
          params.set('sinceLsn', String(lastEventId));
        }
        if (options.excludeOrigin) {
          params.set('excludeOrigin', options.excludeOrigin);
        }
        const qs = params.toString();
        const url = `${baseUrl}/events${qs ? `?${qs}` : ''}`;

        const headers: Record<string, string> = {
          accept: 'text/event-stream',
        };
        if (lastEventId > 0) {
          headers['last-event-id'] = String(lastEventId);
        }
        const tok = await resolveToken();
        if (tok) {
          headers.authorization = `Bearer ${tok}`;
          headers['x-replication-key'] = tok;
        }

        const res = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: abortCtrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE /events failed with status ${res.status}`);
        }

        attempt = 0;
        setState('online');

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !running || closed) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

            let sepIdx = buffer.indexOf('\n\n');
            while (sepIdx !== -1) {
              const rawBlock = buffer.slice(0, sepIdx);
              buffer = buffer.slice(sepIdx + 2);

              let eventName = 'message';
              let frameId: number | undefined;
              const dataLines: string[] = [];

              for (const line of rawBlock.split('\n')) {
                if (!line || line.startsWith(':')) continue;
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('id:')) {
                  const parsedId = Number(line.slice(3).trim());
                  if (Number.isFinite(parsedId)) frameId = parsedId;
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trimStart());
                }
              }

              if (dataLines.length > 0) {
                await dispatchParsedFrame(eventName, dataLines.join('\n'), frameId);
              }
              sepIdx = buffer.indexOf('\n\n');
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }

        if (!running || closed) break;
      } catch (err) {
        if (!running || closed || abortCtrl?.signal.aborted) {
          break;
        }
        const errorObj = err instanceof Error ? err : new Error(String(err));
        options.onError?.(errorObj);
        if (attempt >= maxRetries) {
          setState('offline', { attempt, error: errorObj });
          for (const w of [...connectedWaiters]) {
            connectedWaiters.delete(w);
            w.reject(errorObj);
          }
          running = false;
          break;
        }
        const delayMs = computeBackoffDelayMs(attempt, backoffOpts);
        attempt++;
        setState('backoff', { attempt, delayMs, error: errorObj });
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            resolve();
          }, delayMs);
        });
      }
    }

    if (closed || !running) {
      setState('offline');
    }
  };

  const client: SseReplicationClient = {
    get state() {
      return state;
    },
    get lastEventId() {
      return lastEventId;
    },
    setAuthToken(tokenOrProvider) {
      tokenSource = tokenOrProvider;
    },
    start() {
      if (closed || running) return;
      running = true;
      loopPromise = runStreamLoop();
    },
    waitForConnected(timeoutMs = 5_000): Promise<void> {
      if (state === 'online') return Promise.resolve();
      if (!running && !closed) {
        client.start();
      }
      return new Promise<void>((resolve, reject) => {
        const entry = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          connectedWaiters.delete(entry);
          reject(new Error(`SSE connection timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        connectedWaiters.add(entry);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      running = false;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      abortCtrl?.abort();
      if (loopPromise) {
        await loopPromise.catch(() => undefined);
        loopPromise = null;
      }
      for (const w of [...connectedWaiters]) {
        connectedWaiters.delete(w);
        w.reject(new Error('SSE client closed'));
      }
      setState('offline');
    },
    async [Symbol.asyncDispose]() {
      await client.close();
    },
  };

  if (options.autoStart !== false) {
    client.start();
  }

  return client;
}
