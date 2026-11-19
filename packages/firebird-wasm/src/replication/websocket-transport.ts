/**
 * websocket-transport.ts – Duplex WebSocket Replication Peer (`createWebSocketReplicationPeer`) (`M26 Item 5`).
 */

import type {
  ReplicableDatabase,
  ReplicationLogEntry,
  ReplicationPublication,
  ReplicationSubscription,
} from './types';
import { gunzipBytes, gzipBytes, isGzipBytes } from './shared';
import {
  applyFbChangelogSegmentToDatabase,
  isFbChangelogSegment,
  parseFbChangelogSegment,
  type ApplyFbChangelogResult,
} from './native-changelog';
import {
  TenantIsolationError,
  type TenantIsolationGuard,
} from './tenant-slice';
import {
  SyncJwtError,
  createJwtTenantAuthResolver,
  type JwtTenantAuthContext,
  type JwtTenantAuthOptions,
  type JwtTenantAuthResolver,
} from './jwt-auth';
import type { ReplicationTokenProvider } from './transports';
import type { PresenceHub, PresencePeerState, PresenceWireFrame } from './presence';

/** Structural interface for a standard `WebSocket` or duplex test socket. */
export interface WebSocketLike {
  readyState?: number;
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
  /** Optional inbound tenant isolation guard enforced on incoming `repl_entries` frames (`M22 Item 1`). */
  tenantGuard?: TenantIsolationGuard;
  /** Optional WebCrypto JWT verifier / claim resolver enforced on incoming WebSocket frames (`M23 Item 1`). */
  jwtAuth?: JwtTenantAuthResolver | JwtTenantAuthOptions;
  /** Optional Bearer JWT token or async provider attached to outbound `repl_pull_request` / `repl_entries` frames (`M23 Item 1` / `M24 Item 1`). */
  authToken?: ReplicationTokenProvider;
  /** Optional error callback invoked when an inbound frame violates `tenantGuard` or `jwtAuth` (`M22 Item 1` / `M23 Item 1`). */
  onError?: (error: Error) => void;
  /** Optional server-side ephemeral presence hub updated on `presence_update` / `presence_leave` frames (`M26 Item 1`). */
  presenceHub?: PresenceHub;
  /** Optional callback invoked when an authenticated `presence_update` / `presence_leave` frame arrives (`M26 Item 1`). */
  onPresenceFrame?: (
    frame: PresenceWireFrame,
    scope: { tenantId?: string | number },
  ) => void;
}

/** Duplex WebSocket replication peer returned by {@link createWebSocketReplicationPeer}. */
export interface WebSocketReplicationPeer {
  /** Push local journal entries after `sinceLsn` (or last pushed LSN) over the WebSocket. */
  pushSince(sinceLsn?: number): Promise<number>;
  /** Request the remote peer to stream changes after `sinceLsn` (or current watermark). */
  requestPull(sinceLsn?: number): Promise<void>;
  /** Rotate the outbound JWT token and immediately send a `repl_auth` frame over the live WebSocket (`M24 Item 1`). */
  refreshAuth(tokenOrProvider?: ReplicationTokenProvider): Promise<void>;
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
  let sessionJwtCtx: JwtTenantAuthContext | undefined;
  let activeWsTokenSource: ReplicationTokenProvider | undefined = options.authToken;

  const resolveWsToken = async (): Promise<string | undefined> => {
    if (typeof activeWsTokenSource === 'function') {
      return activeWsTokenSource();
    }
    return activeWsTokenSource;
  };

  const wsJwtResolver: JwtTenantAuthResolver | undefined = options.jwtAuth
    ? 'authenticateToken' in options.jwtAuth
      ? options.jwtAuth
      : createJwtTenantAuthResolver(options.jwtAuth)
    : undefined;

  const sendWsJwtError = (err: SyncJwtError): void => {
    options.onError?.(err);
    socket.send(
      JSON.stringify({
        type: 'repl_error',
        status: err.status,
        code: err.code,
        error: err.message,
      }),
    );
  };

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
      token?: string;
      sinceLsn?: number;
      excludeOrigin?: string;
      entries?: ReplicationLogEntry[];
      slotName?: string;
      confirmedLsn?: number;
      nodeId?: string;
      roomId?: string;
      peer?: PresencePeerState;
      peerId?: string;
      version?: number;
      requestReply?: boolean;
    };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }

    if (msg.type === 'repl_auth') {
      if (wsJwtResolver) {
        try {
          sessionJwtCtx = await wsJwtResolver.authenticateToken(msg.token);
          socket.send(
            JSON.stringify({
              type: 'repl_auth_ok',
              role: sessionJwtCtx.role,
              tenantId: sessionJwtCtx.tenantId ?? null,
            }),
          );
        } catch (err) {
          if (err instanceof SyncJwtError) sendWsJwtError(err);
        }
      }
      return;
    }

    let activeJwtCtx = sessionJwtCtx;
    if (wsJwtResolver && (!activeJwtCtx || msg.token)) {
      try {
        activeJwtCtx = await wsJwtResolver.authenticateToken(msg.token);
        sessionJwtCtx = activeJwtCtx;
      } catch (err) {
        if (err instanceof SyncJwtError) {
          sendWsJwtError(err);
          return;
        }
        throw err;
      }
    }

    if (msg.type === 'repl_pull_request' && publication) {
      const rawEntries = await publication.fetchChangesSince(msg.sinceLsn ?? 0, {
        excludeOrigin: msg.excludeOrigin,
      });
      const tenantEntries =
        options.tenantGuard && activeJwtCtx?.tenantId !== undefined
          ? options.tenantGuard.filterOutboundEntries(rawEntries, activeJwtCtx.tenantId)
          : rawEntries;
      const entries =
        wsJwtResolver && activeJwtCtx
          ? wsJwtResolver.filterEntriesForContext(tenantEntries, activeJwtCtx)
          : tenantEntries;
      socket.send(
        JSON.stringify({
          type: 'repl_entries',
          entries,
        }),
      );
    } else if (msg.type === 'repl_entries' && Array.isArray(msg.entries) && subscription) {
      try {
        if (wsJwtResolver && activeJwtCtx) {
          wsJwtResolver.assertWriteAllowed(activeJwtCtx);
          wsJwtResolver.assertBatchTablesAllowed(activeJwtCtx, msg.entries);
          wsJwtResolver.assertBatchRlsAllowed(activeJwtCtx, msg.entries);
        }
        if (options.tenantGuard) {
          options.tenantGuard.assertBatch(msg.entries, activeJwtCtx?.tenantId);
        }
        const res = await subscription.applyChanges(msg.entries);
        socket.send(
          JSON.stringify({
            type: 'repl_ack',
            slotName: subscription.slotName,
            confirmedLsn: res.currentLsn,
            nodeId: subscription.nodeId,
          }),
        );
      } catch (err) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        if (err instanceof SyncJwtError) {
          sendWsJwtError(err);
        } else {
          options.onError?.(errorObj);
          if (err instanceof TenantIsolationError) {
            socket.send(
              JSON.stringify({
                type: 'repl_error',
                status: 403,
                code: err.code,
                table: err.table,
                reason: err.reason,
                error: err.message,
              }),
            );
          }
        }
      }
    } else if (
      msg.type === 'repl_ack' &&
      publication &&
      msg.slotName &&
      typeof msg.confirmedLsn === 'number'
    ) {
      await publication.advanceSlot(msg.slotName, msg.confirmedLsn, {
        nodeId: msg.nodeId,
      });
    } else if (msg.type === 'presence_update' && msg.peer) {
      const roomId = msg.roomId ?? msg.peer.roomId ?? 'default';
      const updated = options.presenceHub
        ? options.presenceHub.upsertPeer(
            {
              roomId,
              peerId: msg.peer.peerId,
              version: msg.peer.version,
              cursor: msg.peer.cursor,
              typing: msg.peer.typing,
              state: msg.peer.state,
            },
            { tenantId: activeJwtCtx?.tenantId },
          )
        : msg.peer;
      options.onPresenceFrame?.(
        { type: 'presence_update', roomId, peer: updated, requestReply: msg.requestReply },
        { tenantId: activeJwtCtx?.tenantId },
      );
      if (options.presenceHub && msg.requestReply) {
        const peers = options.presenceHub.listPeers({
          roomId,
          tenantId: activeJwtCtx?.tenantId,
        });
        for (const p of peers) {
          if (p.peerId !== updated.peerId) {
            socket.send(
              JSON.stringify({ type: 'presence_update', roomId, peer: p }),
            );
          }
        }
      }
    } else if (msg.type === 'presence_leave' && msg.peerId) {
      const roomId = msg.roomId ?? 'default';
      options.presenceHub?.removePeer(msg.peerId, {
        roomId,
        tenantId: activeJwtCtx?.tenantId,
        version: msg.version,
      });
      options.onPresenceFrame?.(
        {
          type: 'presence_leave',
          roomId,
          peerId: msg.peerId,
          version: msg.version ?? 1,
        },
        { tenantId: activeJwtCtx?.tenantId },
      );
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
        const tok = await resolveWsToken();
        socket.send(
          JSON.stringify({
            type: 'repl_entries',
            entries,
            ...(tok ? { token: tok } : {}),
          }),
        );
      }
      return entries.length;
    },

    async requestPull(sinceLsn?: number): Promise<void> {
      const wmk = sinceLsn ?? (subscription ? await subscription.getWatermark() : 0);
      const tok = await resolveWsToken();
      socket.send(
        JSON.stringify({
          type: 'repl_pull_request',
          sinceLsn: wmk,
          excludeOrigin: subscription?.nodeId,
          ...(tok ? { token: tok } : {}),
        }),
      );
    },

    async refreshAuth(tokenOrProvider?: ReplicationTokenProvider): Promise<void> {
      if (tokenOrProvider !== undefined) {
        activeWsTokenSource = tokenOrProvider;
      }
      const tok = await resolveWsToken();
      socket.send(
        JSON.stringify({
          type: 'repl_auth',
          token: tok ?? '',
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
