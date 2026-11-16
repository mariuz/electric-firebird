/**
 * Multi-Node Mesh & Hub-and-Spoke Replication Coordinator (`createReplicationMesh`, `createReplicationHub`).
 */

import {
  type CreateSubscriptionOptions,
  type PublishedTableConfig,
  type ReplicableDatabase,
  type ReplicationConflictContext,
  type ReplicationConflictStrategy,
  type ReplicationPublication,
  type ReplicationSubscription,
  type RowTransformer,
} from './types';
import { formatHlc } from './hlc-crdt';
import { createPublication } from './publication';
import { createSubscription } from './subscription';

// ---------------------------------------------------------------------------
// 9. Multi-Node Mesh & Hub-and-Spoke Replication Coordinator (`createReplicationMesh` / `createReplicationHub`) (M14 Item 1)
// ---------------------------------------------------------------------------

/** Node configuration within a multi-node replication mesh or hub-and-spoke cluster. */
export interface ReplicationMeshNodeConfig {
  /** Unique node identifier (e.g. `'hub'`, `'edge-eu'`, `'browser-tab-1'`). */
  nodeId: string;
  /** Database instance for this node. */
  db: ReplicableDatabase;
  /** Optional node role (`'hub'`, `'spoke'`, or `'peer'`). */
  role?: 'hub' | 'spoke' | 'peer';
  /** Optional per-node published table override. */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Optional outbound row transformer for this node's publication. */
  transformRow?: RowTransformer;
  /** Optional inbound entry validator for subscriptions targeting this node (`M15 Item 1`). */
  validateEntry?: CreateSubscriptionOptions['validateEntry'];
  /** Optional error handling policy (`'throw' | 'dlq' | 'skip'`) for subscriptions targeting this node (`M15 Item 1`). */
  onApplyError?: CreateSubscriptionOptions['onApplyError'];
  /** Optional DDL replay policy (`'apply' | 'idempotent' | 'additive-only'`) for subscriptions targeting this node (`M15 Item 5`). */
  ddlPolicy?: CreateSubscriptionOptions['ddlPolicy'];
}

/** Options for {@link createReplicationMesh} and {@link createReplicationHub}. */
export interface CreateReplicationMeshOptions {
  /** Participating database nodes ($N \ge 2$). */
  nodes: readonly ReplicationMeshNodeConfig[];
  /**
   * Cluster topology:
   * - `'mesh'` / `'full-mesh'`: every node subscribes to every other node directly ($N(N-1)$ links).
   * - `'hub-and-spoke'`: spoke nodes sync bidirectionally through a central hub node with transitive origin forwarding.
   *
   * @default 'mesh'
   */
  topology?: 'mesh' | 'full-mesh' | 'hub-and-spoke';
  /** Explicit hub node ID when `topology === 'hub-and-spoke'`. Defaults to the node with `role: 'hub'` or `nodes[0].nodeId`. */
  hubNodeId?: string;
  /** Default tables published across all nodes unless overridden per node. @default '*' */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Conflict resolution strategy across mesh links. @default 'last-write-wins' */
  onConflict?: ReplicationConflictStrategy;
  /** Callback invoked when a conflict is detected and resolved on any mesh link. */
  onConflictResolved?: (
    ctx: ReplicationConflictContext,
    resolution: 'remote-wins' | 'local-wins' | 'merge',
  ) => void;
  /**
   * Default quorum count of peer slots that must acknowledge an LSN before
   * `pruneQuorum()` deletes journal entries on a publishing node.
   */
  quorumSize?: number;
  /** Background polling interval in milliseconds when `start()` is called. @default 1000 */
  pollIntervalMs?: number;
}

/** Result of a full `mesh.sync()` convergence pass. */
export interface ReplicationMeshSyncResult {
  /** Number of sync rounds executed (1 for `'mesh'`, 2 for `'hub-and-spoke'` spoke->hub->spoke fanout). */
  readonly rounds: number;
  /** Total journal entries fetched across all directed links. */
  readonly totalFetched: number;
  /** Total journal entries applied across all directed links. */
  readonly totalApplied: number;
  /** Total conflicts resolved across all directed links. */
  readonly totalConflicts: number;
  /** Watermark matrix: `watermarks[subscriberNodeId][publisherNodeId] = lastAppliedLsn`. */
  readonly watermarks: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Latest formatted HLC timestamp string on each node (`hlcState[nodeId]`). */
  readonly hlcState: Readonly<Record<string, string>>;
}

/** Multi-node replication mesh or hub-and-spoke coordinator returned by {@link createReplicationMesh}. */
export interface ReplicationMesh {
  /** Active topology (`'mesh'` or `'hub-and-spoke'`). */
  readonly topology: 'mesh' | 'hub-and-spoke';
  /** Hub node ID when `topology === 'hub-and-spoke'`, or `null`. */
  readonly hubNodeId: string | null;
  /** Publications keyed by `nodeId`. */
  readonly publications: ReadonlyMap<string, ReplicationPublication>;
  /** Directed subscriptions keyed by `${subscriberNodeId}<-${publisherNodeId}`. */
  readonly subscriptions: ReadonlyMap<string, ReplicationSubscription>;
  /** Capture table changes on all nodes and converge changes across the cluster. */
  sync(): Promise<ReplicationMeshSyncResult>;
  /**
   * Prune journal entries on each publishing node that have been acknowledged by
   * at least `quorumSize` peer slots (`M14 Item 1`).
   */
  pruneQuorum(options?: {
    quorumSize?: number;
  }): Promise<Readonly<Record<string, number>>>;
  /** Return the current watermark matrix `watermarks[subscriberNodeId][publisherNodeId]`. */
  watermarkMatrix(): Promise<
    Readonly<Record<string, Readonly<Record<string, number>>>>
  >;
  /** Start background polling on all subscriptions. */
  start(): void;
  /** Stop background polling on all subscriptions. */
  stop(): Promise<void>;
}

/**
 * Create a multi-node replication coordinator (`M14 Item 1`) supporting
 * full `'mesh'` ($N \times (N-1)$ peer links) and `'hub-and-spoke'` (1 hub $\leftrightarrow$ $N$ spokes
 * with transitive change forwarding, HLC watermark matrices, and quorum pruning).
 */
export async function createReplicationMesh(
  options: CreateReplicationMeshOptions,
): Promise<ReplicationMesh> {
  if (options.nodes.length < 2) {
    throw new Error('createReplicationMesh requires at least 2 nodes');
  }
  const topology: 'mesh' | 'hub-and-spoke' =
    options.topology === 'hub-and-spoke' ? 'hub-and-spoke' : 'mesh';
  const defaultTables = options.tables ?? '*';
  const conflictStrategy = options.onConflict ?? 'last-write-wins';
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  const hubNode =
    topology === 'hub-and-spoke'
      ? (options.nodes.find((n) => n.nodeId === options.hubNodeId) ??
        options.nodes.find((n) => n.role === 'hub') ??
        options.nodes[0]!)
      : null;
  const hubNodeId = hubNode ? hubNode.nodeId : null;

  const publications = new Map<string, ReplicationPublication>();
  for (const nodeCfg of options.nodes) {
    const pub = await createPublication(nodeCfg.db, {
      name: `pub_${nodeCfg.nodeId}`,
      nodeId: nodeCfg.nodeId,
      tables: nodeCfg.tables ?? defaultTables,
      transformRow: nodeCfg.transformRow,
    });
    publications.set(nodeCfg.nodeId, pub);
  }

  const subscriptions = new Map<string, ReplicationSubscription>();
  const spokeToHubSubs: ReplicationSubscription[] = [];
  const hubToSpokeSubs: ReplicationSubscription[] = [];

  for (const targetNode of options.nodes) {
    for (const sourceNode of options.nodes) {
      if (targetNode.nodeId === sourceNode.nodeId) continue;

      if (topology === 'hub-and-spoke') {
        const isSpokeToHub =
          targetNode.nodeId === hubNodeId && sourceNode.nodeId !== hubNodeId;
        const isHubToSpoke =
          sourceNode.nodeId === hubNodeId && targetNode.nodeId !== hubNodeId;
        if (!isSpokeToHub && !isHubToSpoke) {
          continue;
        }
      }

      const sourcePub = publications.get(sourceNode.nodeId)!;
      const targetPub = publications.get(targetNode.nodeId)!;
      const linkKey = `${targetNode.nodeId}<-${sourceNode.nodeId}`;

      const sub = await createSubscription(targetNode.db, {
        name: `sub_${targetNode.nodeId}_from_${sourceNode.nodeId}`,
        nodeId: targetNode.nodeId,
        slotName: `slot_${targetNode.nodeId}_on_${sourceNode.nodeId}`,
        publication: sourcePub,
        localPublication: targetPub,
        hlc: targetPub.hlc,
        onConflict: conflictStrategy,
        onConflictResolved: options.onConflictResolved,
        pollIntervalMs,
        validateEntry: targetNode.validateEntry,
        onApplyError: targetNode.onApplyError,
        ddlPolicy: targetNode.ddlPolicy,
        // In hub-and-spoke mode, when Hub applies a row from Spoke A, forward it
        // into Hub's own journal (preserving Spoke A's origin) so Spoke B..N receive it!
        onRowApplied:
          topology === 'hub-and-spoke' && targetNode.nodeId === hubNodeId
            ? async (appliedEntry) => {
                if (appliedEntry.operation === 'DDL' && appliedEntry.ddlSql) {
                  await targetPub.recordDdl(appliedEntry.ddlSql, {
                    txid: appliedEntry.txid,
                    origin: appliedEntry.origin,
                    timestamp: appliedEntry.timestamp,
                  });
                } else if (appliedEntry.operation !== 'DDL') {
                  await targetPub.recordDml({
                    table: appliedEntry.table,
                    operation: appliedEntry.operation,
                    key: appliedEntry.key,
                    after: appliedEntry.after,
                    before: appliedEntry.before,
                    txid: appliedEntry.txid,
                    origin: appliedEntry.origin,
                    timestamp: appliedEntry.timestamp,
                  });
                }
              }
            : undefined,
      });

      subscriptions.set(linkKey, sub);
      if (topology === 'hub-and-spoke') {
        if (targetNode.nodeId === hubNodeId) {
          spokeToHubSubs.push(sub);
        } else {
          hubToSpokeSubs.push(sub);
        }
      }
    }
  }

  const watermarkMatrix = async (): Promise<
    Readonly<Record<string, Readonly<Record<string, number>>>>
  > => {
    const matrix: Record<string, Record<string, number>> = {};
    for (const n of options.nodes) {
      matrix[n.nodeId] = {};
    }
    for (const [linkKey, sub] of subscriptions.entries()) {
      const [subId, pubId] = linkKey.split('<-');
      if (subId && pubId) {
        matrix[subId]![pubId] = await sub.getWatermark();
      }
    }
    return matrix;
  };

  return {
    topology,
    hubNodeId,
    publications,
    subscriptions,

    async sync(): Promise<ReplicationMeshSyncResult> {
      for (const pub of publications.values()) {
        await pub.captureTableChanges();
      }

      let totalFetched = 0;
      let totalApplied = 0;
      let totalConflicts = 0;
      let rounds = 1;

      if (topology === 'hub-and-spoke') {
        rounds = 2;
        // Round 1: Hub pulls from all Spokes (and forwards their entries into Hub's journal)
        for (const sub of spokeToHubSubs) {
          const r = await sub.pull();
          totalFetched += r.fetchedCount;
          totalApplied += r.appliedCount;
          totalConflicts += r.conflictCount;
        }
        // Also capture any direct SQL writes on Hub
        const hubPub = hubNodeId ? publications.get(hubNodeId) : undefined;
        if (hubPub) {
          await hubPub.captureTableChanges();
        }
        // Round 2: All Spokes pull from Hub
        for (const sub of hubToSpokeSubs) {
          const r = await sub.pull();
          totalFetched += r.fetchedCount;
          totalApplied += r.appliedCount;
          totalConflicts += r.conflictCount;
        }
      } else {
        for (const sub of subscriptions.values()) {
          const r = await sub.pull();
          totalFetched += r.fetchedCount;
          totalApplied += r.appliedCount;
          totalConflicts += r.conflictCount;
        }
      }

      // Advance slot watermarks past any tail entries that originated on the subscriber itself
      for (const [linkKey, sub] of subscriptions.entries()) {
        const [, pubId] = linkKey.split('<-');
        const sourcePub = pubId ? publications.get(pubId) : undefined;
        if (!sourcePub) continue;
        const wmk = await sub.getWatermark();
        const headLsn = await sourcePub.currentLsn();
        if (headLsn > wmk) {
          const remaining = await sourcePub.fetchChangesSince(wmk, {
            limit: 1,
            excludeOrigin: sub.nodeId,
          });
          if (remaining.length === 0) {
            await sub.setWatermark(headLsn);
            await sourcePub.advanceSlot(sub.slotName, headLsn, {
              nodeId: sub.nodeId,
            });
          }
        }
      }

      const watermarks = await watermarkMatrix();
      const hlcState: Record<string, string> = {};
      for (const [nId, pub] of publications.entries()) {
        hlcState[nId] = formatHlc(pub.hlc.last());
      }

      return {
        rounds,
        totalFetched,
        totalApplied,
        totalConflicts,
        watermarks,
        hlcState,
      };
    },

    async pruneQuorum(pruneOpts = {}): Promise<Readonly<Record<string, number>>> {
      const prunedByNode: Record<string, number> = {};
      for (const [nId, pub] of publications.entries()) {
        const slots = await pub.listSlots();
        if (slots.length === 0) {
          prunedByNode[nId] = 0;
          continue;
        }
        const qSize = Math.max(
          1,
          Math.min(
            slots.length,
            pruneOpts.quorumSize ?? options.quorumSize ?? slots.length,
          ),
        );
        // Sort slot confirmedFlushLsn descending; the (qSize - 1) index is the highest LSN
        // acknowledged by at least `qSize` subscribers.
        const sortedDesc = slots
          .map((s) => s.confirmedFlushLsn)
          .sort((a, b) => b - a);
        const quorumLsn = sortedDesc[qSize - 1] ?? 0;
        prunedByNode[nId] =
          quorumLsn > 0 ? await pub.pruneJournal(quorumLsn) : 0;
      }
      return prunedByNode;
    },

    watermarkMatrix,

    start() {
      for (const sub of subscriptions.values()) {
        sub.start();
      }
    },

    async stop() {
      for (const sub of subscriptions.values()) {
        await sub.stop();
      }
    },
  };
}

/**
 * Convenience helper to create a `'hub-and-spoke'` replication coordinator (`M14 Item 1`).
 */
export async function createReplicationHub(
  options: Omit<CreateReplicationMeshOptions, 'topology'>,
): Promise<ReplicationMesh> {
  return createReplicationMesh({ ...options, topology: 'hub-and-spoke' });
}

