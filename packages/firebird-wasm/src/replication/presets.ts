/**
 * Progressive-disclosure one-liner replication presets (`syncDatabases`,
 * `syncWithPeer` / `db.syncWith`) with `Symbol.asyncDispose`, end-to-end
 * native `"FBCHANGELOG\0"` C++ `IReplicator` replay (`mode: 'native'`),
 * WebRTC `RTCDataChannel` P2P sync, and resilient auto-reconnecting transports
 * (`M18 Item 5` / `M19 Items 1, 3 & 4`).
 */

import { ensureAsyncDisposeSymbol } from '../database-core';
ensureAsyncDisposeSymbol();
import type { StandardSchemaV1 } from '../schema-validation';
import type {
  CreateSubscriptionOptions,
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
import { normalizeRowKeysUpper, normalizeTableName } from './shared';
import {
  applyFbChangelogSegmentToDatabase,
  createWasmChangelogPoller,
  enableEnginePublication,
  flushDatabaseFbChangelogSegment,
  type ApplyFbChangelogResult,
  type ReplicationEmscriptenFS,
} from './native-changelog';
import {
  createBroadcastChannelTransport,
  createHttpReplicationClient,
  createResilientWebSocketPeer,
  createWebRtcReplicationPeer,
  createWebSocketReplicationPeer,
  isRtcDataChannelLike,
  isWebSocketLike,
  type BackoffRetryOptions,
  type ConnectionLifecycleState,
  type ConnectionStateChangeInfo,
  type RtcDataChannelLike,
  type WebSocketLike,
} from './transports';
import {
  bootstrapReplica,
  createPublication,
  createSubscription,
  replicateDatabases,
  type DatabaseReplicator,
  type ReplicationSyncCycleResult,
} from './core';

/** Options for {@link syncDatabases} (`M18 Item 5` / `M19 Items 1 & 4`). */
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
   * - `'auto'` (default): fast batched `IBatch` + PSQL trigger/journal replication
   *   (automatically upgrades to `'native'` when `wasmFs` + `journalArchiveDirectory` are supplied).
   * - `'logical'`: explicit logical journal replication.
   * - `'native'`: end-to-end `"FBCHANGELOG\0"` binary segment sync replayed onto `replica`
   *   via C++ `IAttachment::createReplicator` (`replica.applyChangelog()`), harvesting
   *   Emscripten `MEMFS` segments when `wasmFs` has archived journals or generating
   *   inline `"FBCHANGELOG\0"` segments on single-threaded WASM (`firebird-embedded-st.wasm`) (`M19 Item 1`).
   *
   * @default 'auto'
   */
  mode?: 'auto' | 'logical' | 'native';
  /**
   * Row encoding inside inline `"FBCHANGELOG\0"` segments when `mode === 'native'`:
   * - `'sql'` (default): deterministic `opExecuteSqlIntl` inside replicated C++ `TDBB_replicator` transactions.
   * - `'jrd'`: binary uncompressed JRD record buffers (`opInsertRecord` / `opUpdateRecord` / `opDeleteRecord`).
   * - `'auto'`: binary JRD record buffers when full schemas & `before` images are present, else `opExecuteSqlIntl`.
   *
   * @default 'sql'
   */
  nativeRecordEncoding?: 'auto' | 'jrd' | 'sql';
  /** Optional Emscripten `MEMFS` (or Node FS adapter) for native `"FBCHANGELOG\0"` segment harvesting/archiving (`M19 Item 1`). */
  wasmFs?: ReplicationEmscriptenFS;
  /** Optional `journal_archive_directory` path inside `wasmFs` (`M19 Item 1`). */
  journalArchiveDirectory?: string;
  /** Optional active `journal_directory` path inside `wasmFs` (`M19 Item 1`). */
  journalDirectory?: string;
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
  /** Optional per-table Standard Schema v1 (`Zod` / `Valibot` / `ArkType`) row validators (`M19 Item 4`). */
  tableSchemas?: Readonly<Record<string, StandardSchemaV1<unknown, Record<string, unknown>>>>;
  /** Error policy when row validation or SQL replay fails (`'throw' | 'dlq' | 'skip'`). */
  onApplyError?: CreateSubscriptionOptions['onApplyError'];
  /** Callback invoked after each `"FBCHANGELOG\0"` segment is applied in `mode: 'native'` (`M19 Item 1`). */
  onChangelogApplied?: (
    result: ApplyFbChangelogResult,
    segment: Uint8Array,
  ) => void | Promise<void>;
  /** Optional error callback for background live sync cycles. */
  onError?: (error: Error) => void;
}

/** Options for {@link syncWithPeer} and `db.syncWith(peerOrUrl, options?)` (`M18 Item 5` / `M19 Items 1 & 3`). */
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
  /** Optional exponential backoff + jitter retry / reconnect settings for HTTP or WebSocket peers (`M19 Item 3`). */
  retry?: BackoffRetryOptions;
  /** Connection lifecycle state change listener for network peers (`M19 Item 3`). */
  onStateChange?: (
    state: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ) => void;
}

/** Active synchronization handle returned by {@link syncDatabases} and {@link syncWithPeer} (`M18 Item 5` / `M19 Items 1 & 3`). */
export interface SyncHandle {
  /** Resolved synchronization transport/engine mode. */
  readonly mode: 'logical' | 'native' | 'http' | 'broadcast' | 'websocket' | 'webrtc';
  /** Resolved synchronization direction. */
  readonly direction: 'one-way' | 'bidirectional';
  /** Whether background live synchronization is currently paused. */
  readonly paused: boolean;
  /** Underlying `DatabaseReplicator` when syncing two local/in-process databases. */
  readonly replicator?: DatabaseReplicator;
  /** Number of `"FBCHANGELOG\0"` segments replayed when `mode === 'native'` (`M19 Item 1`). */
  readonly nativeSegmentsApplied?: number;
  /** Whether the C++ `IAttachment::createReplicator` fast-path executed on `replica` (`M19 Item 1`). */
  readonly usedNativeReplicator?: boolean;
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
 * Turn-key one-liner synchronization between a `primary` and `replica` database (`M18 Item 5` / `M19 Item 1`).
 *
 * Automatically discovers user tables (`tables: '*'`), synchronizes catalog DDL,
 * bootstraps existing rows via batched `IBatch` upserts, installs capture triggers,
 * and starts live synchronization (either batched logical DML or native `"FBCHANGELOG\0"`
 * C++ `IAttachment::createReplicator` replay when `mode: 'native'`).
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

  const requestedNative =
    options.mode === 'native' ||
    (options.mode !== 'logical' &&
      Boolean(options.wasmFs && options.journalArchiveDirectory));

  const resolvedMode: 'logical' | 'native' = requestedNative ? 'native' : 'logical';

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
    tableSchemas: options.tableSchemas,
    onApplyError: options.onApplyError,
  });

  if (doBootstrap) {
    await replicator.bootstrap({ truncateExisting: direction === 'one-way' });
    if (direction === 'bidirectional') {
      await replicator.sync();
    }
  }

  if (requestedNative) {
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
    } catch {
      // Lightweight mock databases may not expose RDB$PUBLICATIONS; inline FBCHANGELOG emission still works!
    }
    if (typeof replica.setReplicaMode === 'function' && direction === 'one-way') {
      try {
        await replica.setReplicaMode('read_write');
      } catch {
        // Ignore if replica does not implement native ODS header mode
      }
    }
  }

  let nativeSegmentsApplied = 0;
  let usedNativeReplicator = false;
  let nextInlineChangelogSeq = 1;

  const wasmPoller =
    resolvedMode === 'native' &&
    direction === 'one-way' &&
    options.wasmFs &&
    options.journalArchiveDirectory
      ? createWasmChangelogPoller({
          fs: options.wasmFs,
          targetDb: replica,
          journalArchiveDirectory: options.journalArchiveDirectory,
          journalDirectory: options.journalDirectory,
          onSegment: async (seg, res) => {
            nativeSegmentsApplied++;
            if (res.usedNativeReplicator) usedNativeReplicator = true;
            if (seg.header.sequence >= nextInlineChangelogSeq) {
              nextInlineChangelogSeq = seg.header.sequence + 1;
            }
            await options.onChangelogApplied?.(res, seg.rawBytes);
          },
        })
      : null;

  const executeOneSyncCycle = async (): Promise<ReplicationSyncCycleResult> => {
    if (resolvedMode !== 'native' || direction !== 'one-way' || options.tableSchemas) {
      return replicator.sync();
    }

    const pub = replicator.primaryPublication;
    const sub = replicator.replicaSubscription;
    const previousLsn = await sub.getWatermark();

    if (tables === '*') {
      await pub.refreshPublishedTables();
    }
    if (doSyncCatalog) {
      await syncCatalog({
        sourceDb: primary,
        targetDb: replica,
        excludeTables: options.excludeTables,
      });
    }

    // 1. Harvest any C++ engine-emitted segments from MEMFS first (multi-threaded WASM)
    if (wasmPoller) {
      const polled = await wasmPoller.pollOnce();
      if (polled.length > 0) {
        await pub.captureTableChanges();
        const headLsn = await pub.currentLsn();
        if (headLsn > previousLsn) {
          await sub.setWatermark(headLsn);
          await pub.advanceSlot(sub.slotName, headLsn, { nodeId: sub.nodeId });
          if (options.autoPrune) {
            await pub.pruneAcked();
          }
        }
        const totalBlocks = polled.reduce((acc, r) => acc + r.blocksProcessed, 0);
        return {
          primaryToReplica: {
            fetchedCount: totalBlocks,
            appliedCount: totalBlocks,
            conflictCount: 0,
            previousLsn,
            currentLsn: Math.max(previousLsn, headLsn),
          },
        };
      }
    }

    // 2. Single-thread / inline "FBCHANGELOG\0" emission -> C++ IReplicator replay!
    await pub.captureTableChanges();
    const pendingEntries = await pub.fetchChangesSince(previousLsn, {
      excludeOrigin: sub.nodeId,
    });
    if (pendingEntries.length === 0) {
      return {
        primaryToReplica: {
          fetchedCount: 0,
          appliedCount: 0,
          conflictCount: 0,
          previousLsn,
          currentLsn: previousLsn,
        },
      };
    }

    const seqNum = nextInlineChangelogSeq++;
    const flushed = await flushDatabaseFbChangelogSegment(primary, {
      entries: pendingEntries,
      sequence: seqNum,
      recordEncoding: options.nativeRecordEncoding ?? 'sql',
      fs: options.wasmFs,
      journalArchiveDirectory: options.journalArchiveDirectory,
    });

    if (!flushed.segment) {
      return replicator.sync();
    }

    const applyRes = await applyFbChangelogSegmentToDatabase(replica, flushed.segment);
    nativeSegmentsApplied++;
    if (applyRes.usedNativeReplicator) {
      usedNativeReplicator = true;
    }
    await options.onChangelogApplied?.(applyRes, flushed.segment);

    // Notify search index hooks and row listeners
    for (const entry of pendingEntries) {
      if (entry.operation !== 'DDL') {
        const tblUpper = normalizeTableName(entry.table);
        const normKey = normalizeRowKeysUpper(entry.key);
        if (options.indexHooks) {
          for (const hook of options.indexHooks) {
            const hookTbl = normalizeTableName(hook.table);
            if (hookTbl !== '*' && hookTbl !== tblUpper) continue;
            if (entry.operation === 'DELETE') {
              await hook.onDelete?.(normKey, entry.before, entry);
            } else if (entry.after) {
              await hook.onInsertOrUpdate?.(
                normalizeRowKeysUpper({ ...entry.after, ...normKey }),
                normKey,
                entry,
              );
            }
          }
        }
      }
      if (options.onRowApplied) {
        await options.onRowApplied(entry);
      }
    }

    await sub.setWatermark(flushed.lastLsn);
    await pub.advanceSlot(sub.slotName, flushed.lastLsn, { nodeId: sub.nodeId });
    if (options.autoPrune) {
      await pub.pruneAcked();
    }

    return {
      primaryToReplica: {
        fetchedCount: pendingEntries.length,
        appliedCount: pendingEntries.length,
        conflictCount: 0,
        previousLsn,
        currentLsn: flushed.lastLsn,
      },
    };
  };

  let isPaused = !doLive;
  let isStopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubPrimaryEvent: (() => Promise<void>) | null = null;
  let unsubReplicaEvent: (() => Promise<void>) | null = null;
  let inFlight: Promise<ReplicationSyncCycleResult> | null = null;

  const runSerializedSync = (): Promise<ReplicationSyncCycleResult> => {
    if (inFlight) {
      return inFlight.then(() => executeOneSyncCycle());
    }
    const p = executeOneSyncCycle().finally(() => {
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
    get nativeSegmentsApplied() {
      return nativeSegmentsApplied;
    },
    get usedNativeReplicator() {
      return usedNativeReplicator;
    },
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
      wasmPoller?.stop();
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
 * Synchronize `db` with another `ReplicableDatabase`, a WebRTC `RTCDataChannel`,
 * a `WebSocket`, an HTTP(S) replication URL (`'https://...'`), a WebSocket URL
 * (`'wss://...'`), or a cross-tab `BroadcastChannel` URI (`'broadcast://<channel>'`)
 * (`M18 Item 5` / `M19 Items 1 & 3`).
 */
export async function syncWithPeer(
  db: ReplicableDatabase,
  peerOrUrl: ReplicableDatabase | string | RtcDataChannelLike | WebSocketLike,
  options: SyncWithOptions = {},
): Promise<SyncHandle> {
  // 1. WebRTC `RTCDataChannel` peer-to-peer sync (`M19 Item 3`)
  if (typeof peerOrUrl !== 'string' && isRtcDataChannelLike(peerOrUrl)) {
    const direction = options.direction ?? 'bidirectional';
    const tables = options.tables ?? '*';
    const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 250);
    const installTriggers =
      options.installTriggers ?? typeof db.execBatch === 'function';

    const localPub = await createPublication(db, {
      name: 'pub_webrtc',
      tables,
      excludeTables: options.excludeTables,
      installTriggers,
    });
    const localSub = await createSubscription(db, {
      name: 'sub_webrtc',
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
    const rtcPeer = createWebRtcReplicationPeer({
      channel: peerOrUrl,
      publication: localPub,
      subscription: localSub,
      snapshotTargetDb: db,
      changelogTargetDb: options.mode === 'native' ? db : undefined,
      onChangelogSegment: async (seg, res) => {
        if (res) {
          nativeSegmentsApplied++;
          if (res.usedNativeReplicator) usedNativeReplicator = true;
          await options.onChangelogApplied?.(res, seg);
        }
      },
      onError: options.onError,
    });

    if (options.mode === 'native' && typeof db.setReplicaMode === 'function') {
      try {
        await db.setReplicaMode('read_write');
      } catch {
        // Ignore if unsupported
      }
    }

    let isPaused = options.live === false;
    let isStopped = false;
    let inFlight: Promise<SubscriptionPullResult> | null = null;
    let lastNativeLsn = 0;
    let nextSeq = 1;

    const runRtcCycle = async (): Promise<SubscriptionPullResult> => {
      const prevWmk = await localSub.getWatermark();
      if (options.mode === 'native') {
        const flushed = await flushDatabaseFbChangelogSegment(db, {
          publication: localPub,
          sinceLsn: lastNativeLsn,
          excludeOrigin: localSub.nodeId,
          sequence: nextSeq,
          recordEncoding: options.nativeRecordEncoding ?? 'sql',
        });
        if (flushed.segment) {
          nextSeq++;
          lastNativeLsn = flushed.lastLsn;
          await rtcPeer.sendChangelogSegment(flushed.segment, { compress: true });
        }
        return {
          fetchedCount: flushed.entryCount,
          appliedCount: flushed.entryCount,
          conflictCount: 0,
          previousLsn: prevWmk,
          currentLsn: Math.max(prevWmk, flushed.lastLsn),
        };
      }

      const pushed = await rtcPeer.pushSince();
      await rtcPeer.requestPull();
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
      if (inFlight) return inFlight.then(() => runRtcCycle());
      const p = runRtcCycle().finally(() => {
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
      mode: 'webrtc',
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
        rtcPeer.close();
        await localSub.stop();
      },
      async [Symbol.asyncDispose]() {
        await handle.stop();
      },
    };
    return handle;
  }

  // 2. Direct `WebSocketLike` object or `ws://` / `wss://` resilient WebSocket URL (`M19 Item 3`)
  if (
    (typeof peerOrUrl !== 'string' && isWebSocketLike(peerOrUrl)) ||
    (typeof peerOrUrl === 'string' && /^wss?:\/\//i.test(peerOrUrl.trim()))
  ) {
    const direction = options.direction ?? 'bidirectional';
    const tables = options.tables ?? '*';
    const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 250);
    const installTriggers =
      options.installTriggers ?? typeof db.execBatch === 'function';

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

  // 3. In-process ReplicableDatabase peer
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

  // 4. Cross-tab BroadcastChannel URI: `broadcast://my-channel`
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

  // 5. HTTP(S) replication endpoint URL
  const direction = options.direction ?? 'one-way';
  const doBootstrap = options.bootstrap ?? true;
  const doLive = options.live ?? true;
  const pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 500);

  const client = createHttpReplicationClient({
    baseUrl: trimmed,
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
