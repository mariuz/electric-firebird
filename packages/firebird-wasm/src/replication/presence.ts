/**
 * presence.ts – Real-Time Collaborative Presence, Ephemeral Awareness &
 * Multi-Transport Room Synchronization (`BroadcastChannel`, `WebSocket`, `HTTP/SSE`) (`M26 Item 1`).
 *
 * Ephemeral, non-WAL collaborative awareness layer tracking online peers, active
 * table/row/cell cursors, selection ranges, and typing indicators with monotonic
 * per-peer versions and automatic TTL expiration on peer disconnect.
 */

import type { BroadcastChannelLike } from './broadcast-transport';
import type { ReplicationTokenProvider } from './transports';
import type { WebSocketLike } from './websocket-transport';

/** Active table / row / column cursor or text selection reported by a peer (`M26 Item 1`). */
export interface PresenceCursor {
  readonly table?: string | null;
  readonly rowKey?: string | number | null;
  readonly column?: string | null;
  readonly selection?: { readonly start: number; readonly end: number } | null;
}

/** Ephemeral awareness state of a single peer inside a {@link PresenceRoom} (`M26 Item 1`). */
export interface PresencePeerState<TState = Record<string, unknown>> {
  readonly peerId: string;
  readonly roomId: string;
  readonly version: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly cursor: PresenceCursor | null;
  readonly typing: boolean;
  readonly state: TState;
  readonly tenantId?: string | number | null;
}

/** Immutable snapshot emitted to subscribers of a {@link PresenceRoom} (`M26 Item 1`). */
export interface PresenceRoomSnapshot<TState = Record<string, unknown>> {
  readonly roomId: string;
  readonly self: PresencePeerState<TState>;
  /** Online remote peers (excluding `self`), sorted deterministically by `peerId`. */
  readonly peers: readonly PresencePeerState<TState>[];
  /** Total online peers including `self` (`peers.length + 1` while active, `peers.length` after `leave()`). */
  readonly onlineCount: number;
  readonly updatedAt: number;
}

/** HTTP + SSE awareness transport configuration for {@link createPresenceRoom} (`M26 Item 1`). */
export interface PresenceHttpSseTransportOptions {
  /** Base URL of `createHttpReplicationHandler` or `npx firebird-wasm serve-sync`. */
  baseUrl: string;
  fetchFn?: typeof fetch;
  authToken?: ReplicationTokenProvider;
  /** Open a streaming `GET /events` connection to receive live `event: presence` frames. @default true */
  subscribeSse?: boolean;
}

/** Options for {@link createPresenceRoom} (`M26 Item 1`). */
export interface PresenceRoomOptions<TState = Record<string, unknown>> {
  /** Logical room identifier. @default 'default' */
  roomId?: string;
  /** Unique identifier of the local peer/tab/session. */
  peerId: string;
  /** Initial custom user awareness metadata (e.g. `{ name, color, avatar }`). */
  initialState?: TState;
  /** Initial active table/row/column cursor. */
  initialCursor?: PresenceCursor | null;
  /** Peer lease TTL in milliseconds before an un-refreshed peer expires. @default 30000 */
  ttlMs?: number;
  /** Automatic heartbeat broadcast interval in milliseconds (`0` disables timer). @default 10000 */
  heartbeatIntervalMs?: number;
  /**
   * Cross-tab `BroadcastChannel` transport (`true` uses `fb-presence:<roomId>`,
   * `string` opens `new BroadcastChannel(name)`, or pass a `BroadcastChannelLike`).
   */
  broadcastChannel?: boolean | string | BroadcastChannelLike;
  /** Optional `WebSocket` transport exchanging `presence_update` / `presence_leave` frames. */
  websocket?: WebSocketLike | null;
  /** Optional HTTP + SSE transport (`POST /presence`, `GET /presence`, `event: presence`). */
  httpSse?: PresenceHttpSseTransportOptions | null;
  /** Custom clock for deterministic TTL testing. @default Date.now */
  now?: () => number;
}

/** Wire frame exchanged across `BroadcastChannel`, `WebSocket`, and SSE (`M26 Item 1`). */
export type PresenceWireFrame<TState = Record<string, unknown>> =
  | {
      readonly type: 'presence_update';
      readonly roomId: string;
      readonly peer: PresencePeerState<TState>;
      readonly requestReply?: boolean;
      readonly token?: string;
    }
  | {
      readonly type: 'presence_leave';
      readonly roomId: string;
      readonly peerId: string;
      readonly version: number;
      readonly token?: string;
    };

/** Live collaborative presence room handle (`M26 Item 1`). */
export interface PresenceRoom<TState = Record<string, unknown>> {
  readonly roomId: string;
  readonly peerId: string;
  getSnapshot(): PresenceRoomSnapshot<TState>;
  getPeers(options?: { includeSelf?: boolean }): readonly PresencePeerState<TState>[];
  updateState(
    patchOrUpdater: Partial<TState> | ((prev: TState) => TState),
  ): PresencePeerState<TState>;
  setCursor(cursor: PresenceCursor | null): PresencePeerState<TState>;
  setTyping(typing: boolean): PresencePeerState<TState>;
  applyRemoteUpdate(peer: PresencePeerState<TState>): boolean;
  applyRemoteLeave(peerId: string, version?: number): boolean;
  pruneExpired(nowMs?: number): number;
  heartbeat(): Promise<void>;
  subscribe(listener: (snapshot: PresenceRoomSnapshot<TState>) => void): () => void;
  leave(): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Input payload accepted by server-side {@link PresenceHub.upsertPeer} (`M26 Item 1`). */
export interface PresenceHubUpsertInput<TState = Record<string, unknown>> {
  roomId?: string;
  peerId: string;
  version?: number;
  cursor?: PresenceCursor | null;
  typing?: boolean;
  state?: TState;
  ttlMs?: number;
}

/** Server-side ephemeral awareness hub isolated by `(tenantId, roomId)` (`M26 Item 1`). */
export interface PresenceHub {
  upsertPeer(
    input: PresenceHubUpsertInput,
    scope?: { tenantId?: string | number },
  ): PresencePeerState;
  removePeer(
    peerId: string,
    scope?: { roomId?: string; tenantId?: string | number; version?: number },
  ): boolean;
  listPeers(scope?: { roomId?: string; tenantId?: string | number }): PresencePeerState[];
  pruneExpired(nowMs?: number): number;
  clear(): void;
}

function normalizeTenantScopeKey(tenantId?: string | number | null): string {
  if (tenantId === undefined || tenantId === null) return '__global__';
  return `t:${String(tenantId).trim()}`;
}

/**
 * Create a server-side ephemeral awareness hub for HTTP/SSE and WebSocket sync
 * endpoints (`M26 Item 1`). Strictly isolates rooms per tenant when `tenantId` is supplied.
 */
export function createPresenceHub(
  options: { ttlMs?: number; now?: () => number } = {},
): PresenceHub {
  const defaultTtlMs = Math.max(500, options.ttlMs ?? 30_000);
  const nowFn = options.now ?? Date.now;
  // Key: `${tenantKey}::${roomId}` -> Map<peerId, PresencePeerState>
  const rooms = new Map<string, Map<string, PresencePeerState>>();
  const tombstones = new Map<string, Map<string, { version: number; expiresAt: number }>>();

  const bucketKey = (roomId = 'default', tenantId?: string | number): string =>
    `${normalizeTenantScopeKey(tenantId)}::${roomId}`;

  const pruneInternal = (ts: number): number => {
    let pruned = 0;
    for (const [key, map] of rooms.entries()) {
      for (const [pid, peer] of map.entries()) {
        if (peer.expiresAt <= ts) {
          map.delete(pid);
          pruned++;
        }
      }
      if (map.size === 0) rooms.delete(key);
    }
    for (const [key, tmap] of tombstones.entries()) {
      for (const [pid, tomb] of tmap.entries()) {
        if (tomb.expiresAt <= ts) tmap.delete(pid);
      }
      if (tmap.size === 0) tombstones.delete(key);
    }
    return pruned;
  };

  return {
    upsertPeer(input, scope = {}) {
      const ts = nowFn();
      pruneInternal(ts);
      const roomId = (input.roomId ?? 'default').trim() || 'default';
      const key = bucketKey(roomId, scope.tenantId);
      let room = rooms.get(key);
      if (!room) {
        room = new Map();
        rooms.set(key, room);
      }
      const existing = room.get(input.peerId);
      const tomb = tombstones.get(key)?.get(input.peerId);
      const incomingVersion =
        typeof input.version === 'number' && Number.isFinite(input.version)
          ? Math.max(1, Math.floor(input.version))
          : (existing?.version ?? tomb?.version ?? 0) + 1;

      if (existing && incomingVersion < existing.version) {
        return existing;
      }
      if (tomb && incomingVersion <= tomb.version) {
        return (
          existing ?? {
            peerId: input.peerId,
            roomId,
            version: tomb.version,
            updatedAt: ts,
            expiresAt: ts,
            cursor: null,
            typing: false,
            state: (input.state ?? {}) as Record<string, unknown>,
            tenantId: scope.tenantId ?? null,
          }
        );
      }

      const ttl = Math.max(500, input.ttlMs ?? defaultTtlMs);
      const next: PresencePeerState = {
        peerId: input.peerId,
        roomId,
        version: incomingVersion,
        updatedAt: ts,
        expiresAt: ts + ttl,
        cursor: input.cursor !== undefined ? input.cursor : (existing?.cursor ?? null),
        typing: input.typing !== undefined ? Boolean(input.typing) : (existing?.typing ?? false),
        state: ((input.state ?? existing?.state ?? {}) as Record<string, unknown>),
        tenantId: scope.tenantId ?? null,
      };
      room.set(input.peerId, next);
      return next;
    },

    removePeer(peerId, scope = {}) {
      const ts = nowFn();
      pruneInternal(ts);
      const roomId = (scope.roomId ?? 'default').trim() || 'default';
      const key = bucketKey(roomId, scope.tenantId);
      const room = rooms.get(key);
      const existing = room?.get(peerId);
      const leaveVersion =
        typeof scope.version === 'number' && Number.isFinite(scope.version)
          ? Math.floor(scope.version)
          : (existing?.version ?? 0) + 1;
      if (existing && leaveVersion < existing.version) {
        return false;
      }
      let tmap = tombstones.get(key);
      if (!tmap) {
        tmap = new Map();
        tombstones.set(key, tmap);
      }
      tmap.set(peerId, { version: leaveVersion, expiresAt: ts + defaultTtlMs });
      if (!room) return false;
      const deleted = room.delete(peerId);
      if (room.size === 0) rooms.delete(key);
      return deleted;
    },

    listPeers(scope = {}) {
      const ts = nowFn();
      pruneInternal(ts);
      const roomId = (scope.roomId ?? 'default').trim() || 'default';
      const key = bucketKey(roomId, scope.tenantId);
      const room = rooms.get(key);
      if (!room) return [];
      return [...room.values()].sort((a, b) => a.peerId.localeCompare(b.peerId));
    },

    pruneExpired(nowMs) {
      return pruneInternal(nowMs ?? nowFn());
    },

    clear() {
      rooms.clear();
      tombstones.clear();
    },
  };
}

async function resolveToken(provider?: ReplicationTokenProvider): Promise<string | undefined> {
  if (!provider) return undefined;
  return typeof provider === 'function' ? provider() : provider;
}

/**
 * Create an ephemeral, non-WAL collaborative awareness room over `BroadcastChannel`,
 * `WebSocket`, and/or `HTTP + SSE` (`M26 Item 1`).
 */
export function createPresenceRoom<TState = Record<string, unknown>>(
  options: PresenceRoomOptions<TState>,
): PresenceRoom<TState> {
  const roomId = (options.roomId ?? 'default').trim() || 'default';
  const peerId = options.peerId.trim();
  if (!peerId) {
    throw new Error('createPresenceRoom requires a non-empty peerId.');
  }
  const ttlMs = Math.max(500, options.ttlMs ?? 30_000);
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs === undefined
      ? Math.min(10_000, Math.max(250, Math.floor(ttlMs / 3)))
      : options.heartbeatIntervalMs;
  const nowFn = options.now ?? Date.now;

  let version = 1;
  let left = false;
  let closed = false;
  const remotePeers = new Map<string, PresencePeerState<TState>>();
  const remoteTombstones = new Map<string, { version: number; expiresAt: number }>();
  const listeners = new Set<(snap: PresenceRoomSnapshot<TState>) => void>();

  const initTs = nowFn();
  let selfState: PresencePeerState<TState> = {
    peerId,
    roomId,
    version,
    updatedAt: initTs,
    expiresAt: initTs + ttlMs,
    cursor: options.initialCursor ?? null,
    typing: false,
    state: (options.initialState ?? ({} as TState)),
  };

  let cachedSnapshot: PresenceRoomSnapshot<TState> | null = null;

  const buildSnapshot = (): PresenceRoomSnapshot<TState> => {
    const peers = [...remotePeers.values()].sort((a, b) =>
      a.peerId.localeCompare(b.peerId),
    );
    return {
      roomId,
      self: selfState,
      peers,
      onlineCount: peers.length + (left || closed ? 0 : 1),
      updatedAt: nowFn(),
    };
  };

  const emitChange = (): void => {
    cachedSnapshot = buildSnapshot();
    for (const fn of [...listeners]) {
      fn(cachedSnapshot);
    }
  };

  const pruneExpiredInternal = (ts = nowFn(), notify = true): number => {
    let removed = 0;
    for (const [id, peer] of remotePeers.entries()) {
      if (peer.expiresAt <= ts) {
        remotePeers.delete(id);
        removed++;
      }
    }
    for (const [id, tomb] of remoteTombstones.entries()) {
      if (tomb.expiresAt <= ts) {
        remoteTombstones.delete(id);
      }
    }
    if (removed > 0) {
      if (notify) emitChange();
      else cachedSnapshot = null;
    }
    return removed;
  };

  // --- Transport Setup ---
  let ownedChannel: BroadcastChannelLike | null = null;
  let channel: BroadcastChannelLike | null = null;
  if (options.broadcastChannel) {
    if (typeof options.broadcastChannel === 'object') {
      channel = options.broadcastChannel;
    } else if (typeof BroadcastChannel !== 'undefined') {
      const chName =
        typeof options.broadcastChannel === 'string'
          ? options.broadcastChannel
          : `fb-presence:${roomId}`;
      ownedChannel = new BroadcastChannel(chName) as unknown as BroadcastChannelLike;
      channel = ownedChannel;
    }
  }

  const ws = options.websocket ?? null;
  const httpCfg = options.httpSse ?? null;
  const httpFetch = httpCfg?.fetchFn ?? globalThis.fetch.bind(globalThis);
  const httpBaseUrl = httpCfg ? httpCfg.baseUrl.replace(/\/+$/, '') : '';
  let sseAbort: AbortController | null = null;

  const sendUpdateOverTransports = async (requestReply = false): Promise<void> => {
    if (closed || left) return;
    const frame: PresenceWireFrame<TState> = {
      type: 'presence_update',
      roomId,
      peer: selfState,
      ...(requestReply ? { requestReply: true } : {}),
    };
    if (channel) {
      try {
        channel.postMessage(frame);
      } catch {
        // Ignore closed channel errors
      }
    }
    if (ws && (ws.readyState === undefined || ws.readyState === 1)) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // Ignore transient WS send error
      }
    }
    if (httpCfg) {
      try {
        const tok = await resolveToken(httpCfg.authToken);
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(tok ? { authorization: `Bearer ${tok}`, 'x-replication-key': tok } : {}),
        };
        const res = await httpFetch(`${httpBaseUrl}/presence`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'update',
            roomId,
            peerId: selfState.peerId,
            version: selfState.version,
            cursor: selfState.cursor,
            typing: selfState.typing,
            state: selfState.state,
            ttlMs,
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as { peers?: PresencePeerState<TState>[] };
          if (Array.isArray(json.peers)) {
            for (const p of json.peers) {
              if (p.peerId !== peerId) applyRemoteUpdate(p);
            }
          }
        }
      } catch {
        // Ephemeral awareness tolerates transient offline errors
      }
    }
  };

  const sendLeaveOverTransports = async (leaveVer: number): Promise<void> => {
    const frame: PresenceWireFrame<TState> = {
      type: 'presence_leave',
      roomId,
      peerId,
      version: leaveVer,
    };
    if (channel) {
      try {
        channel.postMessage(frame);
      } catch {
        // Ignore
      }
    }
    if (ws && (ws.readyState === undefined || ws.readyState === 1)) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // Ignore
      }
    }
    if (httpCfg) {
      try {
        const tok = await resolveToken(httpCfg.authToken);
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(tok ? { authorization: `Bearer ${tok}`, 'x-replication-key': tok } : {}),
        };
        await httpFetch(`${httpBaseUrl}/presence`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'leave',
            roomId,
            peerId,
            version: leaveVer,
          }),
        });
      } catch {
        // Ignore on leave
      }
    }
  };

  const applyRemoteUpdate = (incoming: PresencePeerState<TState>): boolean => {
    if (!incoming || incoming.peerId === peerId || incoming.roomId !== roomId) {
      return false;
    }
    const ts = nowFn();
    pruneExpiredInternal(ts, false);
    const tomb = remoteTombstones.get(incoming.peerId);
    if (tomb && incoming.version <= tomb.version) {
      return false;
    }
    const current = remotePeers.get(incoming.peerId);
    if (current && incoming.version < current.version) {
      return false;
    }
    const remainingMs =
      incoming.expiresAt > incoming.updatedAt
        ? incoming.expiresAt - incoming.updatedAt
        : ttlMs;
    const normalized: PresencePeerState<TState> = {
      ...incoming,
      updatedAt: ts,
      expiresAt: ts + Math.max(500, remainingMs),
    };
    remotePeers.set(incoming.peerId, normalized);
    emitChange();
    return true;
  };

  const applyRemoteLeave = (targetPeerId: string, leaveVersion?: number): boolean => {
    if (!targetPeerId || targetPeerId === peerId) return false;
    const ts = nowFn();
    const current = remotePeers.get(targetPeerId);
    const ver =
      typeof leaveVersion === 'number' && Number.isFinite(leaveVersion)
        ? Math.floor(leaveVersion)
        : (current?.version ?? 0) + 1;
    if (current && ver < current.version) {
      return false;
    }
    remoteTombstones.set(targetPeerId, { version: ver, expiresAt: ts + ttlMs });
    const existed = remotePeers.delete(targetPeerId);
    if (existed) emitChange();
    return existed;
  };

  const handleIncomingFrame = (raw: unknown): void => {
    if (closed) return;
    let frame: PresenceWireFrame<TState> | null = null;
    if (typeof raw === 'string') {
      try {
        frame = JSON.parse(raw) as PresenceWireFrame<TState>;
      } catch {
        return;
      }
    } else if (raw && typeof raw === 'object') {
      frame = raw as PresenceWireFrame<TState>;
    }
    if (!frame || frame.roomId !== roomId) return;

    if (frame.type === 'presence_update' && frame.peer) {
      const changed = applyRemoteUpdate(frame.peer);
      if (frame.requestReply && frame.peer.peerId !== peerId && !left && !closed && changed) {
        void sendUpdateOverTransports(false);
      }
    } else if (frame.type === 'presence_leave' && frame.peerId) {
      applyRemoteLeave(frame.peerId, frame.version);
    }
  };

  const onChannelMessage = (ev: { data: unknown }) => handleIncomingFrame(ev.data);
  if (channel) {
    if (typeof channel.addEventListener === 'function') {
      channel.addEventListener('message', onChannelMessage);
    } else {
      channel.onmessage = onChannelMessage;
    }
  }

  let prevWsOnMessage: ((ev: { data: unknown }) => void) | null = null;
  const onWsMessage = (ev: { data: unknown }) => {
    handleIncomingFrame(ev.data);
    prevWsOnMessage?.(ev);
  };
  if (ws) {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', onWsMessage);
    } else {
      prevWsOnMessage = ws.onmessage ?? null;
      ws.onmessage = onWsMessage;
    }
  }

  // Optional background SSE listener for `event: presence` frames
  if (httpCfg && httpCfg.subscribeSse !== false) {
    sseAbort = new AbortController();
    const signal = sseAbort.signal;
    void (async () => {
      try {
        const tok = await resolveToken(httpCfg.authToken);
        const headers: Record<string, string> = {
          accept: 'text/event-stream',
          ...(tok ? { authorization: `Bearer ${tok}`, 'x-replication-key': tok } : {}),
        };
        const res = await httpFetch(`${httpBaseUrl}/events`, {
          method: 'GET',
          headers,
          signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted && !closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const rawBlock = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            let eventType = 'message';
            const dataLines: string[] = [];
            for (const line of rawBlock.split(/\r?\n/)) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (eventType === 'presence' && dataLines.length > 0) {
              try {
                const payload = JSON.parse(dataLines.join('\n')) as {
                  action?: 'update' | 'leave';
                  roomId?: string;
                  peer?: PresencePeerState<TState>;
                  peerId?: string;
                  version?: number;
                };
                if ((payload.roomId ?? 'default') !== roomId) continue;
                if (payload.action === 'leave' && payload.peerId) {
                  applyRemoteLeave(payload.peerId, payload.version);
                } else if (payload.peer) {
                  applyRemoteUpdate(payload.peer);
                }
              } catch {
                // Malformed SSE frame
              }
            }
          }
        }
      } catch {
        // Aborted or stream closed
      }
    })();
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (closed || left) return;
      pruneExpiredInternal(nowFn(), true);
      void room.heartbeat();
    }, heartbeatIntervalMs);
    if (typeof (heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  }

  const bumpSelf = (
    patch: Partial<Pick<PresencePeerState<TState>, 'state' | 'cursor' | 'typing'>>,
  ): PresencePeerState<TState> => {
    left = false;
    version += 1;
    const ts = nowFn();
    selfState = {
      ...selfState,
      ...patch,
      version,
      updatedAt: ts,
      expiresAt: ts + ttlMs,
    };
    emitChange();
    void sendUpdateOverTransports(false);
    return selfState;
  };

  // Announce initial presence immediately
  void sendUpdateOverTransports(true);

  const room: PresenceRoom<TState> = {
    roomId,
    peerId,

    getSnapshot() {
      pruneExpiredInternal(nowFn(), false);
      if (!cachedSnapshot) {
        cachedSnapshot = buildSnapshot();
      }
      return cachedSnapshot;
    },

    getPeers(peerOpts = {}) {
      const snap = this.getSnapshot();
      if (peerOpts.includeSelf && !left && !closed) {
        return [...snap.peers, snap.self].sort((a, b) => a.peerId.localeCompare(b.peerId));
      }
      return snap.peers;
    },

    updateState(patchOrUpdater) {
      const nextState =
        typeof patchOrUpdater === 'function'
          ? (patchOrUpdater as (prev: TState) => TState)(selfState.state)
          : ({ ...(selfState.state as Record<string, unknown>), ...(patchOrUpdater as Record<string, unknown>) } as TState);
      return bumpSelf({ state: nextState });
    },

    setCursor(cursor) {
      return bumpSelf({ cursor });
    },

    setTyping(typing) {
      return bumpSelf({ typing: Boolean(typing) });
    },

    applyRemoteUpdate,
    applyRemoteLeave,

    pruneExpired(nowMs) {
      return pruneExpiredInternal(nowMs ?? nowFn(), true);
    },

    async heartbeat() {
      if (closed || left) return;
      version += 1;
      const ts = nowFn();
      selfState = {
        ...selfState,
        version,
        updatedAt: ts,
        expiresAt: ts + ttlMs,
      };
      cachedSnapshot = buildSnapshot();
      await sendUpdateOverTransports(false);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async leave() {
      if (left || closed) return;
      left = true;
      version += 1;
      emitChange();
      await sendLeaveOverTransports(version);
    },

    async close() {
      if (closed) return;
      if (!left) {
        await this.leave();
      }
      closed = true;
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (sseAbort) {
        sseAbort.abort();
        sseAbort = null;
      }
      if (channel) {
        if (typeof channel.removeEventListener === 'function') {
          channel.removeEventListener('message', onChannelMessage);
        } else if (channel.onmessage === onChannelMessage) {
          channel.onmessage = null;
        }
      }
      if (ownedChannel) {
        ownedChannel.close?.();
        ownedChannel = null;
      }
      if (ws) {
        if (typeof ws.removeEventListener === 'function') {
          ws.removeEventListener('message', onWsMessage);
        } else if (ws.onmessage === onWsMessage) {
          ws.onmessage = prevWsOnMessage;
        }
      }
      listeners.clear();
    },

    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };

  return room;
}
