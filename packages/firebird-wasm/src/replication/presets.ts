/**
 * Progressive-disclosure one-liner replication presets (`syncDatabases`,
 * `syncWithPeer` / `db.syncWith`) with `Symbol.asyncDispose` (`M18 Item 5`).
 */

import { ensureAsyncDisposeSymbol } from '../database-core';
ensureAsyncDisposeSymbol();
import type {
  PublishedTableConfig,
  ReplicableDatabase,
  ReplicationConflictContext,
  ReplicationConflictStrategy,
  ReplicationIndexHook,
  ReplicationLogEntry,
  ReplicationStats,
  SubscriptionPullResult,
} from './types';
import { discoverUserTables, replicationEventName, syncCatalog } from './catalog';
import { enableEnginePublication } from './native-changelog';
import {
  createBroadcastChannelTransport,
  createHttpReplicationClient,
} from './transports';
import {
  bootstrapReplica,
  createPublication,
  createSubscription,
  replicateDatabases,
  type DatabaseReplicator,
  type ReplicationSyncCycleResult,
} from './core';

/** Options for {@link syncDatabases} (`M18 Item 5`). */
export interface SyncDatabasesOptions {
  /**
   * Tables to replicate, or `'*'` to auto-discover all user tables.
   * @default '*'
   */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Optional table names to exclude when `tables` is `'*'`. */
  excludeTables?: readonly string[];
  /**
   * Replication engine mode:
   * - `'auto'` (default): fast batched `IBatch` + PSQL trigger/journal replication.
   * - `'logical'`: explicit logical journal replication.
   * - `'native'`: also activates Firebird's `RDB$PUBLICATIONS` (`ALTER DATABASE ENABLE PUBLICATION`)
   *   and replica mode (`setReplicaMode('read_write')`) when supported by the engine.
   *
   * @default 'auto'
   */
  mode?: 'auto' | 'logical' | 'native';
  /**
   * Replication direction (`'one-way'` = `primary -> replica`, `'bidirectional'` = `primary <-> replica`).
   * @default 'one-way'
   */
  direction?: 'one-way' | 'bidirectional';
  /**
   * Automatically synchronize schema (`CREATE TABLE` / `ALTER TABLE` + sequences)
   * before initial bootstrap and sync cycles.
   * @default true
   */
  syncCatalog?: boolean;
  /**
   * Seed the replica from `primary`'s current table rows upon connection.
   * @default true
   */
  bootstrap?: boolean;
  /**
   * Start live continuous background synchronization (`POST_EVENT` wakeup + interval poll).
   * @default true
   */
  live?: boolean;
  /** Background polling interval in milliseconds when `live` is `true`. @default 250 */
  pollIntervalMs?: number;
  /** Install `AFTER INSERT OR UPDATE OR DELETE` capture triggers automatically on real Firebird engines. */
  installTriggers?: boolean;
  /** Automatically prune acknowledged journal rows after sync cycles. @default false */
  autoPrune?: boolean;
  /** Conflict resolution strategy. */
  onConflict?: ReplicationConflictStrategy;
  /** Callback invoked when a conflict is detected and resolved. */
  onConflictResolved?: (
    ctx: ReplicationConflictContext,
    resolution: 'remote-wins' | 'local-wins' | 'merge',
  ) => void;
  /** Incremental search index hooks (`HnswIndex`, `Bm25Index`, etc.). */
  indexHooks?: readonly ReplicationIndexHook[];
  /** Callback invoked after each replicated row is applied. */
  onRowApplied?: (entry: ReplicationLogEntry) => void | Promise<void>;
  /** Optional error callback for background live sync cycles. */
  onError?: (error: Error) => void;
}

/** Options for {@link syncWithPeer} and `db.syncWith(peerOrUrl, options?)` (`M18 Item 5`). */
export interface SyncWithOptions extends SyncDatabasesOptions {
  /**
   * Role of `db` when `direction === 'one-way'` against another database instance:
   * - `'auto'` (default): treats whichever database already has user tables as `primary`.
   * - `'primary'`: `db -> peer`
   * - `'replica'`: `peer -> db`
   *
   * @default 'auto'
   */
  role?: 'auto' | 'primary' | 'replica';
  /** Optional bearer token / `x-replication-key` when syncing against an HTTP(S) URL. */
  apiKey?: string;
  /** Custom `fetch` implementation when syncing against an HTTP(S) URL. */
  fetch?: typeof globalThis.fetch;
}

/** Active synchronization handle returned by {@link syncDatabases} and {@link syncWithPeer} (`M18 Item 5`). */
export interface SyncHandle {
  /** Resolved synchronization transport/engine mode. */
  readonly mode: 'logical' | 'native' | 'http' | 'broadcast';
  /** Resolved synchronization direction. */
  readonly direction: 'one-way' | 'bidirectional';
  /** Whether background live synchronization is currently paused. */
  readonly paused: boolean;
  /** Underlying `DatabaseReplicator` when syncing two local/in-process databases. */
  readonly replicator?: DatabaseReplicator;
  /** Trigger an immediate synchronization cycle and return its summary. */
  syncNow(): Promise<ReplicationSyncCycleResult | SubscriptionPullResult>;
  /** Wait until any in-flight sync finishes and all pending changes are caught up (`lagEntries === 0`). */
  waitForIdle(): Promise<void>;
  /** Pause background live polling / event-driven synchronization. */
  pause(): void;
  /** Resume background live polling / event-driven synchronization. */
  resume(): void;
  /** Inspect live replication lag, LSN watermarks, and throughput telemetry. */
  stats(): Promise<ReplicationStats>;
  /** Stop background synchronization and release event listeners / timers. */
  stop(): Promise<void>;
  /** Async resource disposal (`await using sync = await syncDatabases(...)`). */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Turn-key one-liner synchronization between a `primary` and `replica` database (`M18 Item 5`).
 *
 * Automatically discovers user tables (`tables: '*'`), synchronizes catalog DDL,
 * bootstraps existing rows via batched `IBatch` upserts, installs capture triggers,
 * and starts live synchronization.
 */
export async function syncDatabases(
  primary: ReplicableDatabase,
  replica: ReplicableDatabase,
  options: SyncDatabasesOptions = {},
): Promise<SyncHandle> {
  const tables = options.tables ?? '*';
  const direction = options.direction ?? 'one-way';
  const doSyncCatalog = options.syncCatalog ?? true;
  const doBootstrap = options.bootstrap ?? true;
  const doLive = options.live ?? true;
  const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 250);
  const installTriggers =
    options.installTriggers ?? typeof primary.execBatch === 'function';

  let resolvedMode: 'logical' | 'native' =
    options.mode === 'native' ? 'native' : 'logical';

  if (options.mode === 'native') {
    try {
      await enableEnginePublication(primary, {
        tables:
          tables === '*'
            ? '*'
            : tables.map((t) => (typeof t === 'string' ? t : t.table)),
      });
      if (direction === 'bidirectional') {
        await enableEnginePublication(replica, {
          tables:
            tables === '*'
              ? '*'
              : tables.map((t) => (typeof t === 'string' ? t : t.table)),
        });
      }
      if (typeof replica.setReplicaMode === 'function' && direction === 'one-way') {
        await replica.setReplicaMode('read_write');
      }
    } catch {
      resolvedMode = 'logical';
    }
  }

  if (doSyncCatalog) {
    await syncCatalog({
      sourceDb: primary,
      targetDb: replica,
      excludeTables: options.excludeTables,
    });
    if (direction === 'bidirectional') {
      await syncCatalog({
        sourceDb: replica,
        targetDb: primary,
        excludeTables: options.excludeTables,
      });
    }
  }

  const replicator = await replicateDatabases({
    primary,
    replica,
    tables,
    excludeTables: options.excludeTables,
    syncCatalog: doSyncCatalog,
    direction,
    installTriggers,
    autoPrune: options.autoPrune,
    autoBootstrap: doBootstrap,
    onConflict: options.onConflict,
    onConflictResolved: options.onConflictResolved,
    indexHooks: options.indexHooks,
    onRowApplied: options.onRowApplied,
  });

  if (doBootstrap) {
    await replicator.bootstrap({ truncateExisting: direction === 'one-way' });
    if (direction === 'bidirectional') {
      await replicator.sync();
    }
  }

  let isPaused = !doLive;
  let isStopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubPrimaryEvent: (() => Promise<void>) | null = null;
  let unsubReplicaEvent: (() => Promise<void>) | null = null;
  let inFlight: Promise<ReplicationSyncCycleResult> | null = null;

  const runSerializedSync = (): Promise<ReplicationSyncCycleResult> => {
    if (inFlight) {
      return inFlight.then(() => replicator.sync());
    }
    const p = replicator.sync().finally(() => {
      if (inFlight === p) {
        inFlight = null;
      }
    });
    inFlight = p;
    return p;
  };

  const startTimer = (): void => {
    if (timer || isStopped) return;
    timer = setInterval(() => {
      if (isPaused || isStopped || inFlight) return;
      void runSerializedSync().catch((err) => {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, pollIntervalMs);
  };

  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  if (typeof primary.onEvent === 'function') {
    try {
      unsubPrimaryEvent = await primary.onEvent(
        replicationEventName('pub_primary'),
        () => {
          if (!isPaused && !isStopped) {
            void runSerializedSync().catch((err) => {
              options.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
          }
        },
      );
    } catch {
      unsubPrimaryEvent = null;
    }
  }

  if (direction === 'bidirectional' && typeof replica.onEvent === 'function') {
    try {
      unsubReplicaEvent = await replica.onEvent(
        replicationEventName('pub_replica'),
        () => {
          if (!isPaused && !isStopped) {
            void runSerializedSync().catch((err) => {
              options.onError?.(err instanceof Error ? err : new Error(String(err)));
            });
          }
        },
      );
    } catch {
      unsubReplicaEvent = null;
    }
  }

  if (doLive) {
    startTimer();
  }

  const handle: SyncHandle = {
    mode: resolvedMode,
    direction,
    replicator,
    get paused() {
      return isPaused;
    },
    async syncNow() {
      return runSerializedSync();
    },
    async waitForIdle() {
      if (inFlight) {
        await inFlight;
      }
      await runSerializedSync();
    },
    pause() {
      isPaused = true;
      stopTimer();
    },
    resume() {
      if (isStopped) return;
      isPaused = false;
      startTimer();
    },
    stats() {
      return replicator.stats();
    },
    async stop() {
      if (isStopped) return;
      isStopped = true;
      isPaused = true;
      stopTimer();
      if (unsubPrimaryEvent) {
        await unsubPrimaryEvent().catch(() => undefined);
        unsubPrimaryEvent = null;
      }
      if (unsubReplicaEvent) {
        await unsubReplicaEvent().catch(() => undefined);
        unsubReplicaEvent = null;
      }
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
      await replicator.stop();
    },
    async [Symbol.asyncDispose]() {
      await handle.stop();
    },
  };

  return handle;
}

/**
 * Synchronize `db` with another `ReplicableDatabase`, an HTTP(S) replication
 * endpoint URL (`'https://...'`), or a cross-tab `BroadcastChannel` URI
 * (`'broadcast://<channel>'`) (`M18 Item 5`).
 */
export async function syncWithPeer(
  db: ReplicableDatabase,
  peerOrUrl: ReplicableDatabase | string,
  options: SyncWithOptions = {},
): Promise<SyncHandle> {
  if (typeof peerOrUrl !== 'string') {
    const direction = options.direction ?? 'bidirectional';
    const role = options.role ?? 'auto';

    if (role === 'primary') {
      return syncDatabases(db, peerOrUrl, { ...options, direction });
    }
    if (role === 'replica') {
      return syncDatabases(peerOrUrl, db, { ...options, direction });
    }

    // Auto-detect which side already has schema/tables so `replica.syncWith(primary)`
    // and `primary.syncWith(replica)` both bootstrap cleanly out of the box!
    const dbTables = await discoverUserTables(db, {
      excludeTables: options.excludeTables,
    });
    const peerTables = await discoverUserTables(peerOrUrl, {
      excludeTables: options.excludeTables,
    });
    if (dbTables.length === 0 && peerTables.length > 0) {
      return syncDatabases(peerOrUrl, db, { ...options, direction });
    }
    return syncDatabases(db, peerOrUrl, { ...options, direction });
  }

  const trimmed = peerOrUrl.trim();

  // Cross-tab BroadcastChannel URI: `broadcast://my-channel`
  if (/^broadcast:\/\//i.test(trimmed)) {
    const channelName = trimmed.replace(/^broadcast:\/\//i, '').trim() || 'fb_repl_default';
    const tables = options.tables ?? '*';
    const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 250);
    const installTriggers =
      options.installTriggers ?? typeof db.execBatch === 'function';

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

  // HTTP(S) replication endpoint URL
  const direction = options.direction ?? 'one-way';
  const doBootstrap = options.bootstrap ?? true;
  const doLive = options.live ?? true;
  const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 500);

  const client = createHttpReplicationClient({
    baseUrl: trimmed,
    apiKey: options.apiKey,
    fetch: options.fetch,
  });

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
  let isPaused = !doLive;
  let isStopped = false;
  let inFlight: Promise<SubscriptionPullResult> | null = null;

  const runHttpCycle = async (): Promise<SubscriptionPullResult> => {
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

  let timer: ReturnType<typeof setInterval> | null = doLive
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
      if (timer) {
        clearInterval(timer);
        timer = null;
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
