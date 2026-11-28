/**
 * resilient-ws-peer.ts – Auto-Reconnecting WebSocket Replication Peer with
 * Exponential Backoff + Jitter & Offline Changelog Buffering (`M30 Item 5`).
 */

import type {
  ReplicableDatabase,
  ReplicationPublication,
  ReplicationSubscription,
} from './types';
import type { ApplyFbChangelogResult } from './native-changelog';
import {
  createWebSocketReplicationPeer,
  type WebSocketLike,
  type WebSocketReplicationPeer,
} from './transports';
import {
  computeBackoffDelayMs,
  type BackoffRetryOptions,
  type ConnectionLifecycleState,
  type ConnectionStateChangeInfo,
} from './webrtc-resilient';

export interface ReconnectableWebSocketLike
  extends Omit<WebSocketLike, 'addEventListener' | 'removeEventListener'> {
  readyState?: number;
  addEventListener?: {
    (type: 'message', listener: (event: { data: unknown }) => void): void;
    (type: string, listener: (event?: unknown) => void): void;
  };
  removeEventListener?: {
    (type: 'message', listener: (event: { data: unknown }) => void): void;
    (type: string, listener: (event?: unknown) => void): void;
  };
  onopen?: (() => void) | null;
  onclose?: ((event?: unknown) => void) | null;
  onerror?: ((event?: unknown) => void) | null;
}

export interface ResilientWebSocketPeerOptions {
  createSocket?: () => ReconnectableWebSocketLike | Promise<ReconnectableWebSocketLike>;
  url?: string;
  publication?: ReplicationPublication;
  subscription?: ReplicationSubscription;
  changelogTargetDb?: ReplicableDatabase;
  backoff?: BackoffRetryOptions;
  autoCatchUpOnReconnect?: boolean;
  onStateChange?: (
    state: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ) => void;
  onChangelogSegment?: (
    segment: Uint8Array,
    result?: ApplyFbChangelogResult,
  ) => void | Promise<void>;
  authToken?: string | (() => string | undefined | Promise<string | undefined>);
}

export interface ResilientWebSocketPeer extends WebSocketReplicationPeer {
  readonly state: ConnectionLifecycleState;
  readonly reconnectAttempts: number;
  readonly totalReconnects: number;
  reconnectNow(): Promise<void>;
}

export function createResilientWebSocketPeer(
  options: ResilientWebSocketPeerOptions,
): ResilientWebSocketPeer {
  const backoffOpts: BackoffRetryOptions = {
    maxRetries: Infinity,
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    factor: 2,
    jitterRatio: 0.2,
    ...options.backoff,
  };
  const maxRetries = backoffOpts.maxRetries ?? Infinity;
  const autoCatchUp = options.autoCatchUpOnReconnect ?? true;

  let state: ConnectionLifecycleState = 'offline';
  let attempt = 0;
  let totalReconnects = 0;
  let hasConnectedOnce = false;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSocket: ReconnectableWebSocketLike | null = null;
  let activePeer: WebSocketReplicationPeer | null = null;
  let currentAuthToken = options.authToken;
  let detachSocketLifecycle: (() => void) | null = null;
  let lastKnownPushedLsn = 0;
  const pendingChangelogs: Array<{ segment: Uint8Array; compress?: boolean }> = [];

  const setState = (next: ConnectionLifecycleState, info?: ConnectionStateChangeInfo): void => {
    if (state === next && !info) return;
    state = next;
    options.onStateChange?.(next, info);
  };

  const makeSocket = async (): Promise<ReconnectableWebSocketLike> => {
    if (options.createSocket) return await options.createSocket();
    if (options.url && typeof globalThis.WebSocket === 'function') {
      return new globalThis.WebSocket(options.url) as unknown as ReconnectableWebSocketLike;
    }
    throw new Error(
      'createResilientWebSocketPeer requires either createSocket() or url with globalThis.WebSocket.',
    );
  };

  const cleanupCurrentSocket = (): void => {
    if (detachSocketLifecycle) {
      detachSocketLifecycle();
      detachSocketLifecycle = null;
    }
    if (activePeer) {
      activePeer.close();
      activePeer = null;
    }
    activeSocket = null;
  };

  const scheduleReconnect = (cause?: Error): void => {
    if (stopped || reconnectTimer !== null) return;
    if (attempt >= maxRetries) {
      setState('offline', { attempt, error: cause });
      return;
    }
    const delayMs = computeBackoffDelayMs(attempt, backoffOpts);
    const currentAttempt = ++attempt;
    setState('backoff', { attempt: currentAttempt, delayMs, error: cause });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) void connectInternal();
    }, delayMs);
  };

  const onSocketReady = async (): Promise<void> => {
    if (stopped || !activePeer) return;
    const isReconnect = hasConnectedOnce;
    hasConnectedOnce = true;
    if (isReconnect) totalReconnects++;
    attempt = 0;
    setState('online');

    while (pendingChangelogs.length > 0 && activePeer && state === 'online') {
      const item = pendingChangelogs.shift()!;
      await activePeer.sendChangelogSegment(item.segment, { compress: item.compress });
    }

    if (autoCatchUp && activePeer && state === 'online') {
      if (options.subscription) await activePeer.requestPull();
      if (options.publication) {
        const pushed = await activePeer.pushSince(lastKnownPushedLsn);
        if (pushed > 0) lastKnownPushedLsn = await options.publication.currentLsn();
      }
    }
  };

  const connectInternal = async (): Promise<void> => {
    if (stopped) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupCurrentSocket();
    setState('connecting', attempt > 0 ? { attempt } : undefined);

    let sock: ReconnectableWebSocketLike;
    try {
      sock = await makeSocket();
    } catch (err) {
      scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (stopped) {
      sock.close?.();
      return;
    }

    activeSocket = sock;
    activePeer = createWebSocketReplicationPeer({
      socket: sock,
      publication: options.publication,
      subscription: options.subscription,
      changelogTargetDb: options.changelogTargetDb,
      onChangelogSegment: options.onChangelogSegment,
      authToken: currentAuthToken,
    });

    const handleOpen = () => {
      if (activeSocket !== sock || stopped) return;
      void onSocketReady().catch(() => undefined);
    };
    const handleClose = () => {
      if (activeSocket !== sock || stopped) return;
      cleanupCurrentSocket();
      scheduleReconnect(new Error('WebSocket connection closed'));
    };
    const handleError = (ev?: unknown) => {
      if (activeSocket !== sock || stopped) return;
      cleanupCurrentSocket();
      scheduleReconnect(ev instanceof Error ? ev : new Error('WebSocket transport error'));
    };

    if (typeof sock.addEventListener === 'function') {
      sock.addEventListener('open', handleOpen);
      sock.addEventListener('close', handleClose);
      sock.addEventListener('error', handleError);
      detachSocketLifecycle = () => {
        sock.removeEventListener?.('open', handleOpen);
        sock.removeEventListener?.('close', handleClose);
        sock.removeEventListener?.('error', handleError);
      };
    } else {
      sock.onopen = handleOpen;
      sock.onclose = handleClose;
      sock.onerror = handleError;
      detachSocketLifecycle = () => {
        if (sock.onopen === handleOpen) sock.onopen = null;
        if (sock.onclose === handleClose) sock.onclose = null;
        if (sock.onerror === handleError) sock.onerror = null;
      };
    }

    if (sock.readyState === undefined || sock.readyState === 1) {
      await onSocketReady().catch(() => undefined);
    } else if (sock.readyState === 2 || sock.readyState === 3) {
      handleClose();
    }
  };

  void connectInternal();

  return {
    get state() { return state; },
    get reconnectAttempts() { return attempt; },
    get totalReconnects() { return totalReconnects; },
    async reconnectNow() {
      if (!stopped) await connectInternal();
    },
    async pushSince(sinceLsn) {
      if (sinceLsn !== undefined) lastKnownPushedLsn = sinceLsn;
      if (!activePeer || state !== 'online') return 0;
      const count = await activePeer.pushSince(sinceLsn ?? lastKnownPushedLsn);
      if (count > 0 && options.publication) {
        lastKnownPushedLsn = await options.publication.currentLsn();
      }
      return count;
    },
    async requestPull(sinceLsn) {
      if (activePeer && state === 'online') await activePeer.requestPull(sinceLsn);
    },
    async refreshAuth(tokenOrProvider) {
      if (tokenOrProvider !== undefined) currentAuthToken = tokenOrProvider;
      if (activePeer && state === 'online') await activePeer.refreshAuth(tokenOrProvider);
    },
    async sendChangelogSegment(segment, sendOpts = {}) {
      if (!activePeer || state !== 'online') {
        pendingChangelogs.push({ segment: segment.slice(), compress: sendOpts.compress });
        return;
      }
      await activePeer.sendChangelogSegment(segment, sendOpts);
    },
    close() {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupCurrentSocket();
      pendingChangelogs.length = 0;
      setState('offline');
    },
  };
}
