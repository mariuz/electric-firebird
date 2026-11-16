/**
 * native-changelog.ts – `"FBCHANGELOG\0"` segment applier (`IReplicator` + SQL/JRD fallback),
 * replica header mode helper, continuous WASM changelog poller, and barrel re-exports (`M21 Item 5`).
 */

import type { ReplicableDatabase } from './types';
import { applyRowMutationToTable, execStatement } from './shared';
import { applySequences } from './catalog';
import {
  introspectJrdTableSchemas,
  type JrdColumnDescriptor,
} from './jrd-record-codec';
import {
  FB_CHANGELOG_HEADER_BYTES,
  fbChangelogToLogicalEntries,
  parseFbChangelogSegment,
  readWasmChangelogSegments,
  type FbChangelogLogicalDecodeResult,
  type ParsedFbChangelogSegment,
  type ReplicationEmscriptenFS,
} from './changelog-parser';

export * from './jrd-record-codec';
export * from './changelog-parser';
export * from './changelog-encoder';

/** Result returned by {@link applyFbChangelogSegmentToDatabase} (`M16 Item 3` / `M17 Item 1`). */
export interface ApplyFbChangelogResult {
  /** Segment sequence number from the `"FBCHANGELOG\0"` header. */
  readonly sequence: number;
  /** Number of `Replication::Block` records processed. */
  readonly blocksProcessed: number;
  /** SQL DDL statements replayed. */
  readonly ddlExecuted: readonly string[];
  /** Number of logical DML (`INSERT`/`UPDATE`/`DELETE`) row operations replayed in fallback mode. */
  readonly entriesApplied?: number;
  /** Number of `opSetSequence` watermarks replayed in fallback mode. */
  readonly sequencesApplied?: number;
  /** Whether the native C++ `_fb_replicate_changelog` (`IReplicator`) fast-path was used. */
  readonly usedNativeReplicator: boolean;
}

/**
 * Apply a parsed or raw `"FBCHANGELOG\0"` segment to a target database (`M16 Item 3` / `M17 Item 1` / `M18 Item 1`).
 *
 * - When `targetDb.applyChangelog` is available (e.g. `FirebirdBrowser` over
 *   `DirectTransport`, `WorkerTransport`, or `SharedEngineTransport`) and
 *   `options.preferLogicalFallback !== true`, invokes `targetDb.applyChangelog()`
 *   to replay blocks directly via C++ `IAttachment::createReplicator`.
 * - When `wasmModule` and `dbHandle` are provided and `wasmModule._fb_replicate_changelog`
 *   is compiled into the WASM binary, invokes Firebird's native `IAttachment::createReplicator`
 *   (`IReplicator::process` / `IReplicator::close`) directly in C++.
 * - Otherwise, decodes committed transactions via {@link fbChangelogToLogicalEntries}
 *   (automatically deriving `tableSchemas` from `RDB$RELATION_FIELDS` via
 *   {@link introspectJrdTableSchemas} when omitted) and replays DDL, sequence
 *   watermarks, and row mutations onto `targetDb`.
 */
export async function applyFbChangelogSegmentToDatabase(
  targetDb: ReplicableDatabase,
  segmentOrBytes: Uint8Array | ParsedFbChangelogSegment,
  options: {
    wasmModule?: {
      _fb_replicate_changelog?(dbHandle: number, dataPtr: number, byteLength: number): number;
      _malloc(size: number): number;
      _free(ptr: number): void;
      HEAPU8: Uint8Array;
    };
    dbHandle?: number;
    tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
    /** Force logical/SQL decode & replay even when `targetDb.applyChangelog` is present. @default false */
    preferLogicalFallback?: boolean;
    /** Automatically introspect `RDB$RELATION_FIELDS` when `tableSchemas` is omitted in fallback mode. @default true */
    autoIntrospectSchemas?: boolean;
    /** Allow zero-copy `Transferable` buffer handoff when `targetDb.applyChangelog` crosses a Worker. @default false */
    transfer?: boolean;
  } = {},
): Promise<ApplyFbChangelogResult> {
  const segment =
    segmentOrBytes instanceof Uint8Array
      ? parseFbChangelogSegment(segmentOrBytes)
      : segmentOrBytes;

  const effectiveLen =
    segment.header.length >= FB_CHANGELOG_HEADER_BYTES &&
    segment.header.length < segment.rawBytes.byteLength
      ? segment.header.length
      : segment.rawBytes.byteLength;
  const effectiveBytes = segment.rawBytes.subarray(0, effectiveLen);

  if (
    options.preferLogicalFallback !== true &&
    typeof targetDb.applyChangelog === 'function' &&
    !options.wasmModule
  ) {
    try {
      const rc = await targetDb.applyChangelog(
        options.transfer ? effectiveBytes.slice() : effectiveBytes,
        { transfer: options.transfer === true },
      );
      if (rc >= 0) {
        return {
          sequence: segment.header.sequence,
          blocksProcessed: rc,
          ddlExecuted: segment.executedSql,
          usedNativeReplicator: true,
        };
      }
    } catch {
      // Fall through to wasmModule or logical/SQL replay if replica mode is not enabled
    }
  }

  const mod = options.wasmModule;
  const dbHandle = options.dbHandle;
  if (
    options.preferLogicalFallback !== true &&
    mod &&
    typeof mod._fb_replicate_changelog === 'function' &&
    dbHandle &&
    dbHandle > 0
  ) {
    const ptr = mod._malloc(effectiveBytes.byteLength);
    try {
      mod.HEAPU8.set(effectiveBytes, ptr);
      const rc = mod._fb_replicate_changelog(dbHandle, ptr, effectiveBytes.byteLength);
      if (rc >= 0) {
        return {
          sequence: segment.header.sequence,
          blocksProcessed: rc,
          ddlExecuted: segment.executedSql,
          usedNativeReplicator: true,
        };
      }
    } finally {
      mod._free(ptr);
    }
  }

  let effectiveSchemas: Record<string, ReadonlyArray<JrdColumnDescriptor>> | undefined =
    options.tableSchemas ? { ...options.tableSchemas } : undefined;

  const preExecutedDdl = new Set<number>();
  const ddlExecuted: string[] = [];

  if (!effectiveSchemas && options.autoIntrospectSchemas !== false) {
    const introspected = await introspectJrdTableSchemas(targetDb);
    effectiveSchemas = { ...introspected };

    // If the segment both creates a table via committed `opExecuteSql` and inserts
    // rows into that new table in a later transaction, execute committed DDL first
    // and re-introspect missing tables so JRD record decoding succeeds immediately.
    try {
      const preDecode = fbChangelogToLogicalEntries(segment);
      const missingTables = new Set<string>();
      for (const e of preDecode.entries) {
        if (e.operation !== 'DDL' && !effectiveSchemas[e.table]) {
          missingTables.add(e.table);
        }
      }
      if (missingTables.size > 0 && preDecode.ddlStatements.length > 0) {
        for (let i = 0; i < preDecode.entries.length; i++) {
          const entry = preDecode.entries[i]!;
          if (entry.operation === 'DDL' && entry.ddlSql) {
            await execStatement(targetDb, entry.ddlSql);
            ddlExecuted.push(entry.ddlSql);
            preExecutedDdl.add(entry.lsn);
          }
        }
        const newlyIntrospected = await introspectJrdTableSchemas(targetDb, {
          tables: [...missingTables],
        });
        effectiveSchemas = { ...effectiveSchemas, ...newlyIntrospected };
      }
    } catch {
      // Ignore pre-decode errors and let standard fallback proceed
    }
  }

  let decoded: FbChangelogLogicalDecodeResult | null = null;
  try {
    decoded = fbChangelogToLogicalEntries(segment, {
      ...(effectiveSchemas !== undefined ? { tableSchemas: effectiveSchemas } : {}),
    });
  } catch {
    decoded = null;
  }

  let entriesApplied = 0;
  let sequencesApplied = 0;

  if (decoded && (decoded.entries.length > 0 || decoded.sequences.length > 0)) {
    for (const entry of decoded.entries) {
      if (entry.operation === 'DDL' && entry.ddlSql) {
        if (!preExecutedDdl.has(entry.lsn)) {
          await execStatement(targetDb, entry.ddlSql);
          ddlExecuted.push(entry.ddlSql);
        }
      } else if (
        entry.operation === 'INSERT' ||
        entry.operation === 'UPDATE' ||
        entry.operation === 'DELETE'
      ) {
        const pkCols = Object.keys(entry.key);
        if (pkCols.length > 0) {
          await applyRowMutationToTable(
            targetDb,
            entry.table,
            pkCols,
            entry.operation,
            entry.key,
            entry.after,
          );
          entriesApplied++;
        }
      }
    }
    if (decoded.sequences.length > 0) {
      sequencesApplied = await applySequences(targetDb, decoded.sequences);
    }
  } else if (ddlExecuted.length === 0) {
    for (const sql of segment.executedSql) {
      await execStatement(targetDb, sql);
      ddlExecuted.push(sql);
    }
  }

  return {
    sequence: segment.header.sequence,
    blocksProcessed: segment.blocks.length,
    ddlExecuted,
    entriesApplied,
    sequencesApplied,
    usedNativeReplicator: false,
  };
}


/** Replica mode flag stored in `Ods::header_page::hdr_replica_mode` (offset `26`) (`M17 Item 5`). */
export type WasmReplicaMode = 'none' | 'read_only' | 'read_write' | 0 | 1 | 2;

/**
 * Configure `Ods::header_page::hdr_replica_mode` (byte offset `26` on page `0`,
 * per Firebird `src/jrd/ods.h`) on an unattached `.fdb` database file in
 * Emscripten `MEMFS` so `IAttachment::createReplicator` (`_fb_replicate_changelog`)
 * accepts incoming `"FBCHANGELOG\0"` binary blocks (`M17 Item 5`).
 */
export function setWasmDatabaseReplicaMode(
  fs: ReplicationEmscriptenFS,
  dbPath: string,
  mode: WasmReplicaMode = 'read_write',
): { dbPath: string; mode: 'none' | 'read_only' | 'read_write'; modeCode: 0 | 1 | 2 } {
  const modeCode: 0 | 1 | 2 =
    mode === 0 || mode === 'none'
      ? 0
      : mode === 1 || mode === 'read_only'
        ? 1
        : 2;
  const modeName: 'none' | 'read_only' | 'read_write' =
    modeCode === 0 ? 'none' : modeCode === 1 ? 'read_only' : 'read_write';

  const raw = fs.readFile(dbPath);
  if (!(raw instanceof Uint8Array) || raw.byteLength < 152) {
    throw new Error(`Invalid Firebird database file at "${dbPath}": expected >= 152 header bytes.`);
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const pagType = raw[0];
  const pageSize = view.getUint16(16, true);
  if (pagType !== 1 || pageSize < 4096) {
    throw new Error(
      `Invalid Firebird ODS header page at "${dbPath}" (pag_type=${pagType}, hdr_page_size=${pageSize}).`,
    );
  }

  const copy = raw.slice();
  // Ods::header_page::hdr_replica_mode is at byte offset 26 (static_assert in src/jrd/ods.h).
  copy[26] = modeCode;
  fs.writeFile(dbPath, copy);
  return { dbPath, mode: modeName, modeCode };
}

/** Options for {@link createWasmChangelogPoller} (`M17 Item 2`). */
export interface WasmChangelogPollerOptions {
  /** Emscripten `MEMFS` (or Node.js FS adapter) containing changelog directories. */
  fs: ReplicationEmscriptenFS;
  /** Target replica database receiving `"FBCHANGELOG\0"` segments. */
  targetDb: ReplicableDatabase;
  /** Directory where sealed `"FBCHANGELOG\0"` segments are archived (`journal_archive_directory`). */
  journalArchiveDirectory: string;
  /** Optional active `journal_directory` fallback when segments have not yet rotated to archive. */
  journalDirectory?: string;
  /** Initial acknowledged changelog `sequence` watermark (`0` = apply from sequence `1`). @default 0 */
  initialSequence?: number;
  /** Unlink acknowledged archive segment files from `journalArchiveDirectory` after applying. @default false */
  unlinkArchivedSegments?: boolean;
  /** Default polling interval in milliseconds when `start()` is called. @default 100 */
  intervalMs?: number;
  /** Optional compiled WASM module for native C++ `_fb_replicate_changelog` (`IReplicator`) replay. */
  wasmModule?: {
    _fb_replicate_changelog?(dbHandle: number, dataPtr: number, byteLength: number): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPU8: Uint8Array;
  };
  /** Optional replica `dbHandle` inside `wasmModule` for native C++ `_fb_replicate_changelog`. */
  dbHandle?: number;
  /** Optional JRD column descriptors for SQL/logical fallback when `_fb_replicate_changelog` is absent. */
  tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
  /** Optional callback invoked for each newly applied segment. */
  onSegment?: (
    segment: ParsedFbChangelogSegment,
    result: ApplyFbChangelogResult,
  ) => void | Promise<void>;
  /** Optional error callback invoked if polling/applying throws during background timer execution. */
  onError?: (error: Error) => void;
}

/** Cumulative telemetry returned by `poller.stats()` (`M17 Item 2`). */
export interface WasmChangelogPollerStats {
  readonly running: boolean;
  readonly pollCount: number;
  readonly segmentsApplied: number;
  readonly blocksApplied: number;
  readonly filesUnlinked: number;
  readonly lastAppliedSequence: number;
}

/** Continuous native `"FBCHANGELOG\0"` poller & archiver handle returned by {@link createWasmChangelogPoller} (`M17 Item 2`). */
export interface WasmChangelogPoller {
  /** Scan `journalArchiveDirectory` (and `journalDirectory`), apply new segments in `sequence` order, and return results. */
  pollOnce(): Promise<ApplyFbChangelogResult[]>;
  /** Start background timer polling every `intervalMs` milliseconds. */
  start(intervalMs?: number): void;
  /** Stop background timer polling. */
  stop(): void;
  /** Highest segment `sequence` successfully applied so far. */
  lastAppliedSequence(): number;
  /** Inspect cumulative poller & archiver telemetry. */
  stats(): WasmChangelogPollerStats;
}

/**
 * Create a continuous poller and archiver transport for native Firebird
 * `"FBCHANGELOG\0"` segment files in Emscripten `MEMFS` (`M17 Item 2`).
 */
export function createWasmChangelogPoller(
  options: WasmChangelogPollerOptions,
): WasmChangelogPoller {
  let currentSeq = options.initialSequence ?? 0;
  let pollCount = 0;
  let segmentsApplied = 0;
  let blocksApplied = 0;
  let filesUnlinked = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<ApplyFbChangelogResult[]> | null = null;

  const cleanArchiveDir = options.journalArchiveDirectory.endsWith('/')
    ? options.journalArchiveDirectory.slice(0, -1)
    : options.journalArchiveDirectory;

  const runPoll = async (): Promise<ApplyFbChangelogResult[]> => {
    pollCount++;
    const bySeq = new Map<number, { seg: ParsedFbChangelogSegment; fromArchive: boolean }>();

    const archived = readWasmChangelogSegments(options.fs, options.journalArchiveDirectory, {
      sinceSequence: currentSeq,
    });
    for (const seg of archived) {
      bySeq.set(seg.header.sequence, { seg, fromArchive: true });
    }

    if (options.journalDirectory) {
      const active = readWasmChangelogSegments(options.fs, options.journalDirectory, {
        sinceSequence: currentSeq,
      });
      for (const seg of active) {
        if (!bySeq.has(seg.header.sequence)) {
          bySeq.set(seg.header.sequence, { seg, fromArchive: false });
        }
      }
    }

    const ordered = [...bySeq.values()].sort(
      (a, b) => a.seg.header.sequence - b.seg.header.sequence,
    );
    const results: ApplyFbChangelogResult[] = [];

    for (const { seg, fromArchive } of ordered) {
      if (seg.header.sequence <= currentSeq) continue;
      const res = await applyFbChangelogSegmentToDatabase(options.targetDb, seg, {
        ...(options.wasmModule !== undefined ? { wasmModule: options.wasmModule } : {}),
        ...(options.dbHandle !== undefined ? { dbHandle: options.dbHandle } : {}),
        ...(options.tableSchemas !== undefined ? { tableSchemas: options.tableSchemas } : {}),
      });
      currentSeq = seg.header.sequence;
      segmentsApplied++;
      blocksApplied += res.blocksProcessed;
      results.push(res);

      if (options.onSegment) {
        await options.onSegment(seg, res);
      }

      if (
        fromArchive &&
        options.unlinkArchivedSegments &&
        seg.filename &&
        typeof options.fs.unlink === 'function'
      ) {
        try {
          options.fs.unlink(`${cleanArchiveDir}/${seg.filename}`);
          filesUnlinked++;
        } catch {
          // Ignore if already unlinked
        }
      }
    }

    return results;
  };

  return {
    async pollOnce(): Promise<ApplyFbChangelogResult[]> {
      if (inFlight) return inFlight;
      inFlight = runPoll().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    start(intervalMs?: number): void {
      if (timer !== null) return;
      const ms = Math.max(10, intervalMs ?? options.intervalMs ?? 100);
      timer = setInterval(() => {
        void this.pollOnce().catch((err) => {
          if (options.onError) {
            options.onError(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }, ms);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    lastAppliedSequence(): number {
      return currentSeq;
    },
    stats(): WasmChangelogPollerStats {
      return {
        running: timer !== null,
        pollCount,
        segmentsApplied,
        blocksApplied,
        filesUnlinked,
        lastAppliedSequence: currentSeq,
      };
    },
  };
}




