/**
 * object-store-pitr.ts – Point-in-Time Database Restore (`restoreDatabaseToPointInTime`)
 * from S3 / Cloudflare R2 / HTTP Object-Store Checkpoints & WAL Segments (`M20 Item 1`).
 */

import type {
  BootstrapReplicaResult,
  HlcTimestamp,
  PublicationSnapshot,
  ReplicableDatabase,
  ReplicationLogEntry,
} from './types';
import { compareHlc } from './hlc-crdt';
import { decodeEncryptedJournalSegment } from './segments';
import {
  applyFbChangelogSegmentToDatabase,
  fbChangelogToLogicalEntries,
} from './native-changelog';
import {
  bootstrapReplica,
  decompressGzipBytes,
  dropAllClonedReplicationTriggers,
} from './bootstrap';
import { createSubscription } from './subscription';
import {
  createHttpObjectStoreAdapter,
  type HttpObjectStoreAdapterOptions,
  type ObjectStoreAdapter,
  type ObjectStoreCheckpointDescriptor,
  type ObjectStoreWalManifest,
} from './object-store-wal';

const utf8Decoder = new TextDecoder();

function joinPitrKey(prefix: string | undefined, key: string): string {
  const cleanKey = key.replace(/^\/+/, '');
  if (!prefix) return cleanKey;
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

async function* singleChunkStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export async function applyCheckpointToDatabase(
  store: ObjectStoreAdapter,
  ckpt: ObjectStoreCheckpointDescriptor,
  targetDb: ReplicableDatabase & {
    loadDataStream?(
      stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
      options?: { compression?: 'gzip' | 'none' },
    ): Promise<void>;
  },
  publicationName: string,
): Promise<BootstrapReplicaResult> {
  const bytes = await store.getObject(ckpt.key);
  if (!bytes) {
    throw new Error(`Checkpoint object "${ckpt.key}" was not found in object store`);
  }

  if (ckpt.mode === 'binary-image') {
    if (typeof targetDb.loadDataStream !== 'function') {
      throw new Error(
        `Restoring binary checkpoint "${ckpt.id}" requires targetDb.loadDataStream()`,
      );
    }
    await targetDb.loadDataStream(singleChunkStream(bytes), {
      compression: ckpt.compressed ? 'gzip' : 'none',
    });
    await dropAllClonedReplicationTriggers(targetDb);
    return {
      mode: 'binary-image',
      watermarkLsn: ckpt.lsn,
      tablesBootstrapped: 0,
      rowsCopied: 0,
      bytesTransferred: bytes.byteLength,
    };
  }

  const rawJson = ckpt.compressed ? await decompressGzipBytes(bytes) : bytes;
  const snapshot = JSON.parse(utf8Decoder.decode(rawJson)) as PublicationSnapshot;
  const tempSub = await createSubscription(targetDb, {
    name: `ckpt_restore_${publicationName}`,
    nodeId: 'ckpt_restore_node',
    publication: {
      name: publicationName,
      fetchChangesSince: async () => [],
    },
  });
  return bootstrapReplica({
    targetDb,
    publication: { exportSnapshot: async () => snapshot },
    subscription: tempSub,
    snapshot,
  });
}

/** Cutoff specification for {@link restoreDatabaseToPointInTime} (`M20 Item 1`). */
export interface ObjectStorePitrTarget {
  lsn?: number;
  timestamp?: number;
  hlc?: string | HlcTimestamp;
  sequence?: number;
}

/** Options for {@link restoreDatabaseToPointInTime} (`M20 Item 1`). */
export interface RestoreDatabaseToPointInTimeOptions {
  targetDb: ReplicableDatabase & {
    loadDataStream?(
      stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
      options?: { compression?: 'gzip' | 'none' },
    ): Promise<void>;
  };
  store?: ObjectStoreAdapter;
  http?: HttpObjectStoreAdapterOptions;
  prefix?: string;
  target?: number | ObjectStorePitrTarget;
  decryptionKey?: Uint8Array | CryptoKey | string;
  aad?: Uint8Array | string;
}

/** Result returned by {@link restoreDatabaseToPointInTime} (`M20 Item 1`). */
export interface RestoreDatabaseToPointInTimeResult {
  readonly checkpointUsed: string | null;
  readonly checkpointLsn: number;
  readonly segmentsReplayed: number;
  readonly entriesApplied: number;
  readonly restoredToLsn: number;
}

function matchesPitrTarget(
  entry: ReplicationLogEntry,
  target: ObjectStorePitrTarget | null,
): boolean {
  if (!target) return true;
  if (target.lsn !== undefined && entry.lsn > target.lsn) return false;
  if (target.timestamp !== undefined && entry.timestamp > target.timestamp) return false;
  if (target.hlc !== undefined) {
    if (!entry.hlc) return false;
    if (compareHlc(entry.hlc, target.hlc) > 0) return false;
  }
  return true;
}

/**
 * Restore a database from an object-store checkpoint + WAL segment chain up to an
 * exact LSN, epoch timestamp, HLC, or segment sequence (`M20 Item 1`).
 */
export async function restoreDatabaseToPointInTime(
  options: RestoreDatabaseToPointInTimeOptions,
): Promise<RestoreDatabaseToPointInTimeResult> {
  const store =
    options.store ??
    (options.http ? createHttpObjectStoreAdapter(options.http) : undefined);
  if (!store) {
    throw new Error('restoreDatabaseToPointInTime requires either `store` or `http`');
  }

  const manifestRaw = await store.getObject(joinPitrKey(options.prefix, 'manifest.json'));
  if (!manifestRaw) {
    throw new Error('Object store WAL manifest.json not found');
  }
  const manifest = JSON.parse(utf8Decoder.decode(manifestRaw)) as ObjectStoreWalManifest;
  const spec: ObjectStorePitrTarget | null =
    options.target === undefined
      ? null
      : typeof options.target === 'number'
        ? { lsn: options.target }
        : options.target;

  let chosenCkpt: ObjectStoreCheckpointDescriptor | null = null;
  for (const ckpt of manifest.checkpoints) {
    if (spec?.lsn !== undefined && ckpt.lsn > spec.lsn) continue;
    if (spec?.timestamp !== undefined && ckpt.timestamp > spec.timestamp) continue;
    if (!chosenCkpt || ckpt.lsn >= chosenCkpt.lsn) {
      chosenCkpt = ckpt;
    }
  }

  let currentLsn = 0;
  if (chosenCkpt) {
    await applyCheckpointToDatabase(
      store,
      chosenCkpt,
      options.targetDb,
      manifest.publication,
    );
    currentLsn = chosenCkpt.lsn;
  }

  const sub = await createSubscription(options.targetDb, {
    name: `pitr_wal_${manifest.publication}`,
    nodeId: 'pitr_wal_restore',
    publication: {
      name: manifest.publication,
      fetchChangesSince: async () => [],
    },
  });
  await sub.setWatermark(currentLsn);

  let segmentsReplayed = 0;
  let entriesApplied = 0;

  for (const segDesc of manifest.segments) {
    if (segDesc.endLsn <= currentLsn) continue;
    if (spec?.sequence !== undefined && segDesc.sequence > spec.sequence) break;
    if (spec?.lsn !== undefined && segDesc.startLsn > spec.lsn) break;

    const raw = await store.getObject(segDesc.key);
    if (!raw) {
      throw new Error(`Missing WAL segment "${segDesc.key}" in object store`);
    }

    if (segDesc.format === 'fbchangelog') {
      const changelogBytes = segDesc.compressed ? await decompressGzipBytes(raw) : raw;
      if (!spec || (spec.lsn === undefined && spec.timestamp === undefined && spec.hlc === undefined)) {
        const res = await applyFbChangelogSegmentToDatabase(options.targetDb, changelogBytes);
        entriesApplied += res.entriesApplied || res.ddlExecuted.length || segDesc.entryCount;
        currentLsn = Math.max(currentLsn, segDesc.endLsn);
        segmentsReplayed++;
      } else {
        const logical = fbChangelogToLogicalEntries(changelogBytes);
        const eligible = logical.entries
          .map((e, idx) => ({
            ...e,
            lsn: segDesc.startLsn + idx,
            timestamp: segDesc.minTimestamp,
          }))
          .filter((e) => e.lsn > currentLsn && matchesPitrTarget(e, spec));
        if (eligible.length > 0) {
          const pullRes = await sub.applyChanges(eligible);
          entriesApplied += pullRes.appliedCount;
          currentLsn = Math.max(currentLsn, eligible[eligible.length - 1]!.lsn);
          segmentsReplayed++;
        }
      }
    } else {
      const decoded = await decodeEncryptedJournalSegment(raw, {
        key: options.decryptionKey,
        aad: options.aad,
      });
      const eligible = decoded.segment.entries.filter(
        (e) => e.lsn > currentLsn && matchesPitrTarget(e, spec),
      );
      if (eligible.length > 0) {
        const pullRes = await sub.applyChanges(eligible);
        entriesApplied += pullRes.appliedCount;
        currentLsn = Math.max(currentLsn, eligible[eligible.length - 1]!.lsn);
        segmentsReplayed++;
      }
    }
  }

  await sub.setWatermark(currentLsn);
  return {
    checkpointUsed: chosenCkpt?.id ?? null,
    checkpointLsn: chosenCkpt?.lsn ?? 0,
    segmentsReplayed,
    entriesApplied,
    restoredToLsn: currentLsn,
  };
}
