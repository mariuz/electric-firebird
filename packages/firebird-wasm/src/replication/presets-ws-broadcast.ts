/**
 * presets-ws-broadcast.ts – WebSocket (`ws://` / `WebSocketLike`) & Cross-Tab
 * `BroadcastChannel` (`broadcast://`) Peer Sync Helpers for `syncWithPeer` (`M30 Item 5`).
 */

import type { ReplicableDatabase, SubscriptionPullResult } from './types';
import {
  createBroadcastChannelTransport,
  createResilientWebSocketPeer,
  createWebSocketReplicationPeer,
  type WebSocketLike,
} from './transports';
import { createPublication, createSubscription } from './core';
import type { SyncHandle, SyncWithOptions } from './presets';

export async function connectWebSocketSyncPeer(
  db: ReplicableDatabase,
  peerOrUrl: WebSocketLike | string,
  options: SyncWithOptions,
): Promise<SyncHandle> {
  const direction = options.direction ?? 'bidirectional';
  const tables = options.tables ?? '*';
  const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 250);
  const installTriggers = options.installTriggers ?? typeof db.execBatch === 'function';

  const localPub = await createPublication(db, {
    name: 'pub_ws',
    tables,
    excludeTables: options.excludeTables,
    installTriggers,
  });
  const localSub = await createSubscription(db, {
    name: 'sub_ws',
    publication: localPub,
    localPublication: localPub,
    onConflict: options.onConflict ?? 'last-write-wins',
    onConflictResolved: options.onConflictResolved,
    indexHooks: options.indexHooks,
    onRowApplied: options.onRowApplied,
    tableSchemas: options.tableSchemas,
    onApplyError: options.onApplyError,
  });

  let nativeSegmentsApplied = 0;
  let usedNativeReplicator = false;
  const wsPeer =
    typeof peerOrUrl === 'string'
      ? createResilientWebSocketPeer({
          url: peerOrUrl.trim(),
          publication: localPub,
          subscription: localSub,
          changelogTargetDb: options.mode === 'native' ? db : undefined,
          backoff: options.retry,
          onStateChange: options.onStateChange,
          onChangelogSegment: async (seg, res) => {
            if (res) {
              nativeSegmentsApplied++;
              if (res.usedNativeReplicator) usedNativeReplicator = true;
              await options.onChangelogApplied?.(res, seg);
            }
          },
        })
      : createWebSocketReplicationPeer({
          socket: peerOrUrl,
          publication: localPub,
          subscription: localSub,
          changelogTargetDb: options.mode === 'native' ? db : undefined,
          onChangelogSegment: async (seg, res) => {
            if (res) {
              nativeSegmentsApplied++;
              if (res.usedNativeReplicator) usedNativeReplicator = true;
              await options.onChangelogApplied?.(res, seg);
            }
          },
        });

  let isPaused = options.live === false;
  let isStopped = false;
  let inFlight: Promise<SubscriptionPullResult> | null = null;

  const runWsCycle = async (): Promise<SubscriptionPullResult> => {
    const prevWmk = await localSub.getWatermark();
    const pushed = await wsPeer.pushSince();
    await wsPeer.requestPull();
    const curWmk = await localSub.getWatermark();
    return {
      fetchedCount: pushed,
      appliedCount: pushed,
      conflictCount: 0,
      previousLsn: prevWmk,
      currentLsn: curWmk,
    };
  };

  const runSerialized = (): Promise<SubscriptionPullResult> => {
    if (inFlight) return inFlight.then(() => runWsCycle());
    const p = runWsCycle().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };

  let timer: ReturnType<typeof setInterval> | null =
    options.live === false
      ? null
      : setInterval(() => {
          if (!isPaused && !isStopped && !inFlight) {
            void runSerialized().catch((err) => {
              options.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
          }
        }, pollIntervalMs);

  const handle: SyncHandle = {
    mode: 'websocket',
    direction,
    get nativeSegmentsApplied() {
      return nativeSegmentsApplied;
    },
    get usedNativeReplicator() {
      return usedNativeReplicator;
    },
    get paused() {
      return isPaused;
    },
    syncNow: runSerialized,
    async waitForIdle() {
      if (inFlight) await inFlight;
      await runSerialized();
    },
    pause() {
      isPaused = true;
    },
    resume() {
      if (!isStopped) isPaused = false;
    },
    stats: () => localSub.stats(),
    async stop() {
      if (isStopped) return;
      isStopped = true;
      isPaused = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      wsPeer.close();
      await localSub.stop();
    },
    async [Symbol.asyncDispose]() {
      await handle.stop();
    },
  };
  return handle;
}

export async function connectBroadcastSyncPeer(
  db: ReplicableDatabase,
  trimmedUri: string,
  options: SyncWithOptions,
): Promise<SyncHandle> {
  const channelName = trimmedUri.replace(/^broadcast:\/\//i, '').trim() || 'fb_repl_default';
  const tables = options.tables ?? '*';
  const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 250);
  const installTriggers = options.installTriggers ?? typeof db.execBatch === 'function';

  const localPub = await createPublication(db, {
    name: `pub_${channelName}`,
    tables,
    excludeTables: options.excludeTables,
    installTriggers,
  });
  const localSub = await createSubscription(db, {
    name: `sub_${channelName}`,
    publication: localPub,
    localPublication: localPub,
    onConflict: options.onConflict ?? 'last-write-wins',
    onConflictResolved: options.onConflictResolved,
    indexHooks: options.indexHooks,
    onRowApplied: options.onRowApplied,
    tableSchemas: options.tableSchemas,
    onApplyError: options.onApplyError,
  });
  const bc = createBroadcastChannelTransport({
    channelName,
    publication: localPub,
    subscription: localSub,
  });

  let isPaused = options.live === false;
  let isStopped = false;
  let inFlight: Promise<SubscriptionPullResult> | null = null;

  const pushLocalDelta = async (): Promise<SubscriptionPullResult> => {
    const entries = await bc.sync();
    const wmk = await localSub.getWatermark();
    return {
      fetchedCount: entries.length,
      appliedCount: entries.length,
      conflictCount: 0,
      previousLsn: wmk,
      currentLsn: wmk,
    };
  };

  const runCycle = (): Promise<SubscriptionPullResult> => {
    if (inFlight) return inFlight;
    const p = pushLocalDelta().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };

  let timer: ReturnType<typeof setInterval> | null =
    options.live === false
      ? null
      : setInterval(() => {
          if (!isPaused && !isStopped && !inFlight) {
            void runCycle().catch((err) => {
              options.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
          }
        }, pollIntervalMs);

  const handle: SyncHandle = {
    mode: 'broadcast',
    direction: 'bidirectional',
    get paused() {
      return isPaused;
    },
    syncNow: runCycle,
    async waitForIdle() {
      if (inFlight) await inFlight;
      await runCycle();
    },
    pause() {
      isPaused = true;
    },
    resume() {
      if (!isStopped) isPaused = false;
    },
    stats: () => localSub.stats(),
    async stop() {
      if (isStopped) return;
      isStopped = true;
      isPaused = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      bc.close();
      await localSub.stop();
    },
    async [Symbol.asyncDispose]() {
      await handle.stop();
    },
  };
  return handle;
}
