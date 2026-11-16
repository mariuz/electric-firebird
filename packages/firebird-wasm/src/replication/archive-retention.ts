/**
 * PITR Journal Archival (`exportJournalArchive`, `applyJournalArchive`) &
 * Automated Retention Policies (`applyRetentionPolicy`).
 */

import {
  DEFAULT_REPL_JOURNAL_TABLE,
  type JournalCompactionResult,
  type PublicationSnapshot,
  type ReplicableDatabase,
  type ReplicationLogEntry,
  type ReplicationPublication,
  type ReplicationSlot,
} from './types';
import { quoteIdent } from './shared';
import {
  decodeEncryptedJournalSegment,
  encodeEncryptedJournalSegment,
} from './segments';
import { compactJournal } from './dlq-compaction';
import { bootstrapReplica } from './bootstrap';
import { createSubscription } from './subscription';
import {
  entryMatchesTimeTravelCutoff,
  normalizeTimeTravelTarget,
  type TimeTravelTarget,
} from './orchestration';

// ---------------------------------------------------------------------------
// 12. Journal Archival & Point-in-Time Recovery (PITR) Bundles (`exportJournalArchive` / `applyJournalArchive`) (M14 Item 4)
// ---------------------------------------------------------------------------

/** A single encrypted/compressed segment inside a {@link ReplicationJournalArchive}. */
export interface JournalArchiveSegment {
  /** Monotonic 1-based segment sequence number. */
  readonly sequence: number;
  /** First LSN in this segment. */
  readonly startLsn: number;
  /** Last LSN in this segment. */
  readonly endLsn: number;
  /** Number of journal entries in this segment. */
  readonly entryCount: number;
  /** Minimum entry epoch timestamp (`Date.now()`) in this segment. */
  readonly minTimestamp: number;
  /** Maximum entry epoch timestamp (`Date.now()`) in this segment. */
  readonly maxTimestamp: number;
  /** Whether the segment payload is Gzip-compressed. */
  readonly compressed: boolean;
  /** Whether the segment payload is encrypted with AES-256-GCM. */
  readonly encrypted: boolean;
  /** Binary wire bytes produced by {@link encodeEncryptedJournalSegment}. */
  readonly bytes: Uint8Array;
}

/** Portable Point-in-Time Recovery (PITR) archive bundle returned by {@link exportJournalArchive}. */
export interface ReplicationJournalArchive {
  /** Archive format identifier. */
  readonly format: 'firebird-repl-archive-v1';
  /** Source publication name. */
  readonly publication: string;
  /** Epoch timestamp (`Date.now()`) when the archive was created. */
  readonly createdAt: number;
  /** Optional base snapshot (`PublicationSnapshot`) taken before the journal stream. */
  readonly baseSnapshot: PublicationSnapshot | null;
  /** Ordered chain of binary/encrypted journal segments. */
  readonly segments: readonly JournalArchiveSegment[];
  /** Total journal entries across all segments. */
  readonly entryCount: number;
  /** Alias for {@link entryCount}. */
  readonly totalEntries: number;
  /** Minimum LSN across all segments (`0` if empty). */
  readonly startLsn: number;
  /** Alias for {@link startLsn}. */
  readonly minLsn: number;
  /** Maximum LSN across all segments (`0` if empty). */
  readonly endLsn: number;
  /** Alias for {@link endLsn}. */
  readonly maxLsn: number;
}

/** Options for {@link exportJournalArchive}. */
export interface ExportJournalArchiveOptions {
  /** Source publication to export from (optional when passed as the first parameter). */
  publication?: ReplicationPublication;
  /**
   * When `true` (default when `sinceLsn === 0`), includes a logical `baseSnapshot`
   * of all published tables at LSN 0 / current state.
   *
   * @default false
   */
  includeBaseSnapshot?: boolean;
  /** Export journal entries with `LSN > sinceLsn`. @default 0 */
  sinceLsn?: number;
  /** Optional minimum LSN (inclusive) to export (`LSN >= fromLsn`). */
  fromLsn?: number;
  /** Optional maximum LSN (inclusive) to export (`LSN <= toLsn`). */
  toLsn?: number;
  /** Maximum number of journal entries packed into each binary segment. @default 100 */
  maxEntriesPerSegment?: number;
  /** Alias for `maxEntriesPerSegment`. */
  segmentMaxEntries?: number;
  /** Optional AES-256-GCM encryption key for the segment chain. */
  key?: Uint8Array | CryptoKey | string;
  /** Whether to Gzip-compress each segment. @default true */
  compress?: boolean;
  /** Optional Additional Authenticated Data (AAD) for AES-256-GCM. */
  aad?: Uint8Array | string;
}

/** Options for {@link applyJournalArchive}. */
export interface ApplyJournalArchiveOptions {
  /** Target database to restore into (optional when passed as the first parameter). */
  targetDb?: ReplicableDatabase;
  /** PITR archive bundle produced by {@link exportJournalArchive} (optional when passed as the second parameter). */
  archive?: ReplicationJournalArchive;
  /**
   * Optional Point-in-Time Recovery cutoff (`lsn`, `timestamp`, or `hlc`).
   * Only journal entries matching `<= target` are replayed onto `targetDb`.
   */
  target?: number | TimeTravelTarget;
  /** Decryption key if the archive segments were encrypted. */
  key?: Uint8Array | CryptoKey | string;
  /** Additional Authenticated Data (AAD) if the archive segments were encrypted with AAD. */
  aad?: Uint8Array | string;
}

/** Result returned by {@link applyJournalArchive}. */
export interface ApplyJournalArchiveResult {
  /** Number of rows seeded from `archive.baseSnapshot`. */
  readonly bootstrappedRows: number;
  /** Number of archive segments decoded and verified. */
  readonly segmentsDecoded: number;
  /** Number of journal entries replayed up to `target`. */
  readonly entriesApplied: number;
  /** Alias for {@link entriesApplied}. */
  readonly entriesReplayed: number;
  /** Highest LSN replayed during recovery. */
  readonly restoredToLsn: number;
  /** Alias for {@link restoredToLsn}. */
  readonly restoredUpToLsn: number;
}

function isPublicationLike(val: unknown): val is ReplicationPublication {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as ReplicationPublication).fetchChangesSince === 'function'
  );
}

/**
 * Package a publication's journal stream (and optional `baseSnapshot`) into a
 * chunked, compressed, and optionally AES-256-GCM encrypted Point-in-Time Recovery
 * archive (`M14 Item 4`).
 */
export async function exportJournalArchive(
  publicationOrOptions: ReplicationPublication | ExportJournalArchiveOptions,
  maybeOptions: ExportJournalArchiveOptions = {},
): Promise<ReplicationJournalArchive> {
  const options: ExportJournalArchiveOptions = isPublicationLike(publicationOrOptions)
    ? { ...maybeOptions, publication: publicationOrOptions }
    : publicationOrOptions;
  const pub = options.publication;
  if (!pub) {
    throw new Error('exportJournalArchive requires a publication');
  }

  const sinceLsn =
    options.fromLsn !== undefined ? Math.max(0, options.fromLsn - 1) : (options.sinceLsn ?? 0);
  const maxPerSeg = Math.max(
    1,
    options.maxEntriesPerSegment ?? options.segmentMaxEntries ?? 100,
  );
  const baseSnapshot = options.includeBaseSnapshot
    ? await pub.exportSnapshot({ mode: 'logical' })
    : null;

  const rawEntries = await pub.fetchChangesSince(sinceLsn);
  const entries = rawEntries.filter((e) => {
    if (options.fromLsn !== undefined && e.lsn < options.fromLsn) return false;
    if (options.toLsn !== undefined && e.lsn > options.toLsn) return false;
    return true;
  });
  const segments: JournalArchiveSegment[] = [];
  const compress = options.compress ?? true;
  const encrypted = options.key !== undefined;

  for (let i = 0; i < entries.length; i += maxPerSeg) {
    const chunk = entries.slice(i, i + maxPerSeg);
    const seq = segments.length + 1;
    const startLsn = chunk[0]!.lsn;
    const endLsn = chunk[chunk.length - 1]!.lsn;
    const minTimestamp = Math.min(...chunk.map((e) => e.timestamp));
    const maxTimestamp = Math.max(...chunk.map((e) => e.timestamp));

    const bytes = await encodeEncryptedJournalSegment(chunk, {
      sequence: seq,
      state: 'archivable',
      key: options.key,
      compress,
      aad: options.aad,
    });

    segments.push({
      sequence: seq,
      startLsn,
      endLsn,
      entryCount: chunk.length,
      minTimestamp,
      maxTimestamp,
      compressed: compress,
      encrypted,
      bytes,
    });
  }

  const minLsn = entries.length > 0 ? entries[0]!.lsn : 0;
  const maxLsn = entries.length > 0 ? entries[entries.length - 1]!.lsn : 0;

  return {
    format: 'firebird-repl-archive-v1',
    publication: pub.name,
    createdAt: Date.now(),
    baseSnapshot,
    segments,
    entryCount: entries.length,
    totalEntries: entries.length,
    startLsn: minLsn,
    minLsn,
    endLsn: maxLsn,
    maxLsn,
  };
}

/**
 * Restore a target database from a {@link ReplicationJournalArchive} up to an
 * optional Point-in-Time Recovery (`target` LSN, timestamp, or HLC) (`M14 Item 4`).
 */
export async function applyJournalArchive(
  targetDbOrOptions: ReplicableDatabase | ApplyJournalArchiveOptions,
  maybeArchive?: ReplicationJournalArchive,
  maybeOptions: ApplyJournalArchiveOptions = {},
): Promise<ApplyJournalArchiveResult> {
  const options: ApplyJournalArchiveOptions =
    maybeArchive !== undefined
      ? {
          ...maybeOptions,
          targetDb: targetDbOrOptions as ReplicableDatabase,
          archive: maybeArchive,
        }
      : (targetDbOrOptions as ApplyJournalArchiveOptions);

  const targetDb = options.targetDb;
  const archive = options.archive;
  if (!targetDb || !archive) {
    throw new Error('applyJournalArchive requires targetDb and archive');
  }

  const tempSub = await createSubscription(targetDb, {
    name: `pitr_restore_${archive.publication}`,
    nodeId: 'pitr_restore_node',
    publication: {
      name: archive.publication,
      fetchChangesSince: async () => [],
    },
  });

  let bootstrappedRows = 0;
  if (archive.baseSnapshot) {
    const dummyPub = {
      name: archive.publication,
      exportSnapshot: async () => archive.baseSnapshot!,
      registerSlot: async () => ({
        slotName: 'pitr',
        publication: archive.publication,
        nodeId: 'pitr',
        confirmedFlushLsn: 0,
        lastSeenAt: Date.now(),
        ttlMs: 0,
      }),
    } as unknown as ReplicationPublication;

    const bootRes = await bootstrapReplica({
      targetDb,
      publication: dummyPub,
      subscription: tempSub,
      snapshot: archive.baseSnapshot,
    });
    bootstrappedRows = bootRes.rowsCopied;
  }

  const cutoffSpec =
    options.target !== undefined
      ? normalizeTimeTravelTarget(options.target)
      : null;

  const decodedEntries: ReplicationLogEntry[] = [];
  let segmentsDecoded = 0;

  for (const seg of archive.segments) {
    const decoded = await decodeEncryptedJournalSegment(seg.bytes, {
      key: options.key,
      aad: options.aad,
    });
    segmentsDecoded++;
    for (const entry of decoded.segment.entries) {
      if (cutoffSpec && !entryMatchesTimeTravelCutoff(entry, cutoffSpec)) {
        continue;
      }
      decodedEntries.push(entry);
    }
  }

  const pullRes = await tempSub.applyChanges(decodedEntries);
  return {
    bootstrappedRows,
    segmentsDecoded,
    entriesApplied: pullRes.appliedCount,
    entriesReplayed: pullRes.appliedCount,
    restoredToLsn: pullRes.currentLsn,
    restoredUpToLsn: pullRes.currentLsn,
  };
}

// ---------------------------------------------------------------------------
// 13. Journal Retention, Compaction & Automated PITR Archival Policy (M15 Item 3)
// ---------------------------------------------------------------------------

/** Options for {@link applyRetentionPolicy}. */
export interface JournalRetentionPolicyOptions {
  /**
   * Maximum number of entries to retain in `FB_REPL_JOURNAL$` for this publication.
   * Entries older than the newest `maxEntries` are eligible for pruning (subject to active slot watermarks unless `ignoreSlotWatermarks` is `true`).
   */
  maxEntries?: number;
  /**
   * Maximum age in milliseconds for retained journal entries (`now - entry.timestamp > maxAgeMs`).
   */
  maxAgeMs?: number;
  /**
   * When `true`, runs {@link compactJournal} on the remaining unpruned journal entries.
   * @default true
   */
  compact?: boolean;
  /**
   * When `true`, exports pruned entries into a `ReplicationJournalArchive` bundle before deleting them from `FB_REPL_JOURNAL$`.
   * @default false
   */
  archiveBeforePrune?: boolean;
  /** Optional AES-256-GCM key used when `archiveBeforePrune` is `true`. */
  archiveKey?: CryptoKey | Uint8Array | string;
  /** Optional segment size when `archiveBeforePrune` is `true`. @default 200 */
  archiveSegmentMaxEntries?: number;
  /**
   * When `true`, allows `maxEntries` / `maxAgeMs` pruning even when no active slots exist
   * or beyond unacknowledged slot watermarks.
   * @default false
   */
  ignoreSlotWatermarks?: boolean;
  /** Override current timestamp (`Date.now()`) for deterministic testing. */
  now?: number;
  /** Custom journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
}

/** Result returned by {@link applyRetentionPolicy}. */
export interface JournalRetentionPolicyResult {
  /** Safe LSN watermark up to which entries were pruned (`null` if no entries were pruned). */
  readonly prunedUpToLsn: number | null;
  /** Number of journal entries deleted by the retention policy. */
  readonly prunedEntries: number;
  /** Expired replication slot names dropped during slot TTL cleanup. */
  readonly expiredSlots: readonly string[];
  /** Result of journal compaction if `compact !== false`, or `null`. */
  readonly compaction: JournalCompactionResult | null;
  /** Exported PITR archive of the pruned entries if `archiveBeforePrune` was `true` and entries were pruned, or `null`. */
  readonly archive: ReplicationJournalArchive | null;
}


/**
 * Enforce an automated journal retention, PITR archival rotation, and row-compaction policy
 * on `FB_REPL_JOURNAL$` (`M15 Item 3`).
 */
export async function applyRetentionPolicy(
  db: ReplicableDatabase,
  publication: ReplicationPublication,
  options: JournalRetentionPolicyOptions = {},
): Promise<JournalRetentionPolicyResult> {
  const now = options.now ?? Date.now();
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);

  // 1. Expire stale slots and find active slot watermark ceiling
  const allSlots = await publication.listSlots();
  const expiredSlots: string[] = [];
  const activeSlots: ReplicationSlot[] = [];

  for (const slot of allSlots) {
    if (slot.ttlMs > 0 && now - slot.lastSeenAt > slot.ttlMs) {
      await publication.dropSlot(slot.slotName);
      expiredSlots.push(slot.slotName);
    } else {
      activeSlots.push(slot);
    }
  }

  const slotCeilingLsn =
    !options.ignoreSlotWatermarks && activeSlots.length > 0
      ? Math.min(...activeSlots.map((s) => s.confirmedFlushLsn))
      : Infinity;

  // 2. Determine candidate LSN cutoff from active slots, `maxEntries`, and `maxAgeMs`
  const allEntries = await publication.fetchChangesSince(0);
  let targetPruneLsn =
    activeSlots.length > 0 && !options.ignoreSlotWatermarks ? slotCeilingLsn : 0;

  if (options.maxEntries !== undefined && options.maxEntries >= 0) {
    if (allEntries.length > options.maxEntries) {
      const overflowCount = allEntries.length - options.maxEntries;
      const cutoffEntry = allEntries[overflowCount - 1];
      if (cutoffEntry && cutoffEntry.lsn > targetPruneLsn) {
        targetPruneLsn = Math.min(cutoffEntry.lsn, slotCeilingLsn);
      }
    }
  }

  if (options.maxAgeMs !== undefined && options.maxAgeMs >= 0) {
    const minTimestamp = now - options.maxAgeMs;
    for (const entry of allEntries) {
      if (entry.timestamp < minTimestamp && entry.lsn <= slotCeilingLsn) {
        if (entry.lsn > targetPruneLsn) {
          targetPruneLsn = entry.lsn;
        }
      }
    }
  }

  let archive: ReplicationJournalArchive | null = null;
  let prunedEntries = 0;
  let prunedUpToLsn: number | null = null;

  if (targetPruneLsn > 0 && Number.isFinite(targetPruneLsn)) {
    const prunable = allEntries.filter((e) => e.lsn <= targetPruneLsn);
    if (prunable.length > 0) {
      if (options.archiveBeforePrune) {
        archive = await exportJournalArchive(publication, {
          fromLsn: prunable[0]!.lsn,
          toLsn: targetPruneLsn,
          segmentMaxEntries: options.archiveSegmentMaxEntries ?? 200,
          key: options.archiveKey,
          includeBaseSnapshot: false,
        });
      }
      prunedEntries = await publication.pruneJournal(targetPruneLsn);
      prunedUpToLsn = targetPruneLsn;
    }
  }

  // 3. Optionally compact remaining unpruned journal entries
  let compaction: JournalCompactionResult | null = null;
  if (options.compact !== false) {
    compaction = await compactJournal(db, {
      publication: publication.name,
      fromLsn: prunedUpToLsn !== null ? prunedUpToLsn + 1 : undefined,
      journalTable: options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE,
    });
  }

  void journalTable;
  return {
    prunedUpToLsn,
    prunedEntries,
    expiredSlots,
    compaction,
    archive,
  };
}

