/**
 * presets-http.ts – HTTP(S) & Live SSE Sync Preset Helper for `syncWithPeer` (`M28 Item 5`).
 */

import type { ReplicableDatabase, SubscriptionPullResult } from './types';
import { flushDatabaseFbChangelogSegment } from './native-changelog';
import {
  createHttpReplicationClient,
  createSseReplicationClient,
  type SseReplicationClient,
} from './transports';
import {
  bootstrapReplica,
  createPublication,
  createSubscription,
} from './core';
import type { SyncHandle, SyncWithOptions } from './presets';

export async function connectHttpSyncPeer(
  db: ReplicableDatabase,
  trimmedUrl: string,
  options: SyncWithOptions,
): Promise<SyncHandle> {
  const direction = options.direction ?? 'one-way';
  const doBootstrap = options.bootstrap ?? true;
  const doLive = options.live ?? true;
  const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 500);

  const client = createHttpReplicationClient({
    baseUrl: trimmedUrl,
    apiKey: options.apiKey,
    fetch: options.fetch,
    retry: options.retry,
    onStateChange: options.onStateChange,
  });

  if (options.mode === 'native' && typeof db.setReplicaMode === 'function') {
    try {
      await db.setReplicaMode('read_write');
    } catch {
      // Ignore if unsupported
    }
  }

  const localPub =
    direction === 'bidirectional'
      ? await createPublication(db, {
          name: 'pub_local_http',
          tables: options.tables ?? '*',
          excludeTables: options.excludeTables,
          installTriggers:
            options.installTriggers ?? typeof db.execBatch === 'function',
        })
      : undefined;

  const sub = await createSubscription(db, {
    name: 'sub_remote_http',
    publication: client,
    localPublication: localPub,
    onConflict:
      options.onConflict ??
      (direction === 'bidirectional' ? 'last-write-wins' : 'remote-wins'),
    onConflictResolved: options.onConflictResolved,
    indexHooks: options.indexHooks,
    onRowApplied: options.onRowApplied,
    tableSchemas: options.tableSchemas,
    onApplyError: options.onApplyError,
  });

  if (doBootstrap && (await sub.getWatermark()) === 0) {
    try {
      const snapshot = await client.fetchSnapshot();
      await bootstrapReplica({
        targetDb: db,
        publication: {
          exportSnapshot: async () => snapshot,
          advanceSlot: (slotName, confirmedLsn, slotOpts) =>
            client.ackSlot(slotName, confirmedLsn, slotOpts),
        },
        subscription: sub,
        snapshot,
      });
    } catch {
      // Remote endpoint may not expose /snapshot; proceed with incremental pull
    }
  }

  let lastPushedLsn = localPub ? await localPub.currentLsn() : 0;
  let lastChangelogSeq = 0;
  let nextOutChangelogSeq = 1;
  let nativeSegmentsApplied = 0;
  let usedNativeReplicator = false;
  let isPaused = !doLive;
  let isStopped = false;
  let inFlight: Promise<SubscriptionPullResult> | null = null;

  const runHttpCycle = async (): Promise<SubscriptionPullResult> => {
    if (options.mode === 'native') {
      const prevWmk = await sub.getWatermark();
      if (localPub) {
        const flushed = await flushDatabaseFbChangelogSegment(db, {
          publication: localPub,
          sinceLsn: lastPushedLsn,
          excludeOrigin: sub.nodeId,
          sequence: nextOutChangelogSeq,
          recordEncoding: options.nativeRecordEncoding ?? 'sql',
        });
        if (flushed.segment) {
          nextOutChangelogSeq++;
          lastPushedLsn = flushed.lastLsn;
          await client.pushChangelogSegment(flushed.segment, { compress: true });
        }
      }
      const results = await client.pullAndApplyChangelog(db, lastChangelogSeq, {
        compress: true,
      });
      for (const r of results) {
        nativeSegmentsApplied++;
        if (r.usedNativeReplicator) usedNativeReplicator = true;
        if (r.sequence > lastChangelogSeq) lastChangelogSeq = r.sequence;
      }
      return {
        fetchedCount: results.length,
        appliedCount: results.length,
        conflictCount: 0,
        previousLsn: prevWmk,
        currentLsn: prevWmk + results.length,
      };
    }

    if (localPub) {
      await localPub.captureTableChanges();
      const localEntries = await localPub.fetchChangesSince(lastPushedLsn, {
        excludeOrigin: sub.nodeId,
      });
      if (localEntries.length > 0) {
        await client.pushChanges(localEntries);
        lastPushedLsn = localEntries[localEntries.length - 1]!.lsn;
      }
    }
    const pullRes = await sub.pull();
    if (pullRes.currentLsn > pullRes.previousLsn) {
      await client
        .ackSlot(sub.slotName, pullRes.currentLsn, { nodeId: sub.nodeId })
        .catch(() => undefined);
    }
    return pullRes;
  };

  const runSerialized = (): Promise<SubscriptionPullResult> => {
    if (inFlight) return inFlight.then(() => runHttpCycle());
    const p = runHttpCycle().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };

  await runSerialized();

  const sseClient: SseReplicationClient | null =
    doLive && options.liveSse
      ? createSseReplicationClient({
          baseUrl: trimmedUrl,
          apiKey: options.apiKey,
          fetch: options.sseFetch ?? options.fetch,
          excludeOrigin: sub.nodeId,
          subscription: options.mode === 'native' ? undefined : sub,
          retry: options.retry,
          onStateChange: options.onStateChange,
          onError: options.onError,
          onEntries: async (_entries, currentLsn) => {
            if (isPaused || isStopped) return;
            if (options.mode === 'native') {
              await runSerialized();
            } else if (currentLsn > 0) {
              await client
                .ackSlot(sub.slotName, currentLsn, { nodeId: sub.nodeId })
                .catch(() => undefined);
            }
          },
        })
      : null;

  const dbWithOnQuery = db as ReplicableDatabase & {
    onQuery?: (cb: (ev: { sql: string }) => void) => () => void;
  };
  const unsubLocalQuery =
    sseClient && direction === 'bidirectional' && typeof dbWithOnQuery.onQuery === 'function'
      ? dbWithOnQuery.onQuery((ev) => {
          if (isPaused || isStopped) return;
          if (/\bFB_REPL_/i.test(ev.sql)) return;
          if (!/^\s*(INSERT|UPDATE|DELETE|MERGE|RECREATE|CREATE|ALTER|DROP)\b/i.test(ev.sql)) {
            return;
          }
          void runSerialized().catch((err) => {
            options.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        })
      : undefined;

  const needsPollingTimer =
    doLive &&
    (!sseClient || (direction === 'bidirectional' && !unsubLocalQuery));

  let timer: ReturnType<typeof setInterval> | null = needsPollingTimer
    ? setInterval(() => {
        if (!isPaused && !isStopped && !inFlight) {
          void runSerialized().catch((err) => {
            options.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        }
      }, pollIntervalMs)
    : null;

  const handle: SyncHandle = {
    mode: 'http',
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
    stats: () => sub.stats(),
    async stop() {
      if (isStopped) return;
      isStopped = true;
      isPaused = true;
      unsubLocalQuery?.();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (sseClient) {
        await sseClient.close();
      }
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
      await sub.stop();
    },
    async [Symbol.asyncDispose]() {
      await handle.stop();
    },
  };

  return handle;
}
