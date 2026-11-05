/**
 * snapshots.ts – Copy-on-Write (CoW) page-level point-in-time snapshots,
 * branching, and compact incremental binary page diffs (`exportDiff` /
 * `applyDiff`) for `IndexedDBVFS`, `OPFSVFS`, `FirebirdBrowser`, and
 * `FirebirdLite`.
 *
 * Instead of duplicating the entire `.fdb` byte image on every checkpoint,
 * `CowSnapshotStore` splits the database image into fixed-size 8 KB pages and
 * shares unchanged `Uint8Array` page buffers across snapshots. Taking a
 * snapshot after a small write allocates only the dirty pages while sharing all
 * unmodified pages with prior snapshots in O(changed pages) memory.
 *
 * Incremental binary page diffs (`exportPageDiff` / `applyPageDiff`) encode
 * only the modified or newly appended 8 KB pages between any two snapshots or
 * database images into a compact, CRC32-verified binary envelope (`FBDF\x01`).
 */

const DEFAULT_SNAPSHOT_PAGE_SIZE = 8192;

/** Magic header bytes for a Firebird incremental binary page diff (`"FBDF\x01"`). */
export const PAGE_DIFF_MAGIC = new Uint8Array([0x46, 0x42, 0x44, 0x46, 0x01]);

/** Fixed binary header size in bytes for `FBDF\x01` page diffs. */
export const PAGE_DIFF_HEADER_BYTES = 32;

/** Options for creating a point-in-time database snapshot. */
export interface SnapshotOptions {
  /** Optional human-readable label for the snapshot. */
  label?: string;
  /** Optional explicit snapshot identifier. */
  id?: string;
  /** Page size in bytes used for copy-on-write page deduplication. @default 8192 */
  pageSize?: number;
}

/** Metadata describing a point-in-time copy-on-write database snapshot. */
export interface DatabaseSnapshotInfo {
  /** Unique identifier for this snapshot. */
  readonly id: string;
  /** Optional human-readable label. */
  readonly label?: string;
  /** Unix timestamp (ms) when the snapshot was captured. */
  readonly createdAt: number;
  /** Page size in bytes (typically `8192`). */
  readonly pageSize: number;
  /** Total number of pages in the snapshot. */
  readonly pageCount: number;
  /** Total byte length of the database image at the snapshot point. */
  readonly byteLength: number;
  /** Number of pages newly allocated for this snapshot. */
  readonly uniquePages: number;
  /** Number of unchanged pages shared via copy-on-write with previous snapshots. */
  readonly sharedPages: number;
  /** Identifier of the preceding snapshot, or `null` if this is the first snapshot. */
  readonly parentId: string | null;
}

/** A point-in-time copy-on-write database snapshot. */
export interface DatabaseSnapshot extends DatabaseSnapshotInfo {
  /** Immutable copy-on-write page buffers (`pageSize` bytes each, except possibly a trailing partial page). */
  readonly pages: readonly Uint8Array[];
  /** Reassemble the full contiguous `.fdb` database byte image. */
  toUint8Array(): Uint8Array;
}

/** Input accepted by `exportPageDiff` / `applyPageDiff` (`DatabaseSnapshot`, raw `.fdb` bytes, or `null` for an empty base). */
export type SnapshotOrImageInput = DatabaseSnapshot | Uint8Array | null | undefined;

/** Options for {@link exportPageDiff} and `db.exportDiff()`. */
export interface PageDiffOptions {
  /** Page size in bytes when diffing raw `Uint8Array` images (defaults to snapshot `pageSize` or `8192`). */
  pageSize?: number;
}

/** Options for {@link applyPageDiff} and `db.applyDiff()`. */
export interface ApplyPageDiffOptions {
  /**
   * Verify that the base image's byte length and CRC32 checksum match the
   * `baseByteLength` and `baseChecksum` recorded in the diff header.
   *
   * @default true
   */
  verifyBaseChecksum?: boolean;
  /**
   * Verify that the resulting image's CRC32 checksum matches the
   * `targetChecksum` recorded in the diff header.
   *
   * @default true
   */
  verifyTargetChecksum?: boolean;
  /**
   * Automatically capture a new Copy-on-Write snapshot in `db`'s snapshot store
   * after applying the diff (`true` by default when a `snapshotLabel` is supplied).
   */
  createSnapshot?: boolean;
  /** Optional label for the snapshot created when `createSnapshot` is enabled. */
  snapshotLabel?: string;
}

/** A single modified or newly added page inside a {@link ParsedPageDiff}. */
export interface PageDiffEntry {
  /** 0-based page index in the target database image. */
  readonly pageIndex: number;
  /** Raw bytes of the page at `pageIndex`. */
  readonly data: Uint8Array;
}

/** Decoded header and page entries of a binary page diff (`FBDF\x01`). */
export interface ParsedPageDiff {
  /** Format version (`1`). */
  readonly version: number;
  /** Header flags (`bit 0 = hasBase`). */
  readonly flags: number;
  /** Whether the diff was computed against a non-empty base snapshot (`true`) or an empty base (`false`). */
  readonly hasBase: boolean;
  /** Page size in bytes (typically `8192`). */
  readonly pageSize: number;
  /** Byte length of the base image (`0` when `hasBase` is `false`). */
  readonly baseByteLength: number;
  /** Byte length of the target image after applying the diff. */
  readonly targetByteLength: number;
  /** Total page count of the target image (`Math.ceil(targetByteLength / pageSize)`). */
  readonly targetPageCount: number;
  /** Number of changed or added pages encoded in this diff. */
  readonly changedPageCount: number;
  /** CRC32 checksum of the base image (`0` when `hasBase` is `false`). */
  readonly baseChecksum: number;
  /** CRC32 checksum of the target image. */
  readonly targetChecksum: number;
  /** Changed page entries in ascending `pageIndex` order. */
  readonly entries: readonly PageDiffEntry[];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CRC32 Checksum Utility for Binary Page Diff Integrity
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Compute an unsigned 32-bit IEEE 802.3 CRC32 checksum over a `Uint8Array` or
 * an array of page `Uint8Array`s.
 */
export function computeCrc32(input: Uint8Array | readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  const chunks: readonly Uint8Array[] =
    input instanceof Uint8Array ? [input] : input;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.byteLength; i++) {
      crc = CRC32_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isDatabaseSnapshot(val: unknown): val is DatabaseSnapshot {
  return (
    typeof val === 'object' &&
    val !== null &&
    Array.isArray((val as DatabaseSnapshot).pages) &&
    typeof (val as DatabaseSnapshot).toUint8Array === 'function'
  );
}

function splitIntoPages(
  input: SnapshotOrImageInput,
  defaultPageSize: number,
): {
  pages: readonly Uint8Array[];
  pageSize: number;
  byteLength: number;
  hasBase: boolean;
} {
  if (!input) {
    return {
      pages: [],
      pageSize: defaultPageSize,
      byteLength: 0,
      hasBase: false,
    };
  }
  if (isDatabaseSnapshot(input)) {
    return {
      pages: input.pages,
      pageSize: input.pageSize,
      byteLength: input.byteLength,
      hasBase: true,
    };
  }
  const bytes = input;
  const pageCount = Math.ceil(bytes.byteLength / defaultPageSize);
  const pages: Uint8Array[] = new Array(pageCount);
  for (let i = 0; i < pageCount; i++) {
    const start = i * defaultPageSize;
    const end = Math.min(start + defaultPageSize, bytes.byteLength);
    pages[i] = bytes.subarray(start, end);
  }
  return {
    pages,
    pageSize: defaultPageSize,
    byteLength: bytes.byteLength,
    hasBase: true,
  };
}

/**
 * Return `true` if `bytes` starts with the `FBDF\x01` binary page diff magic header.
 */
export function isPageDiffPayload(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < PAGE_DIFF_HEADER_BYTES) {
    return false;
  }
  for (let i = 0; i < PAGE_DIFF_MAGIC.byteLength; i++) {
    if (bytes[i] !== PAGE_DIFF_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Export a compact binary page diff (`FBDF\x01`) containing only the pages that
 * changed between `base` (a `DatabaseSnapshot`, `Uint8Array`, or `null` for an
 * initial full checkpoint) and `target` (`DatabaseSnapshot` or `Uint8Array`).
 *
 * Binary layout (little-endian):
 * - `[0..3]`: Magic `"FBDF"` (`0x46 0x42 0x44 0x46`)
 * - `[4]`: Version (`0x01`)
 * - `[5]`: Flags (`bit 0 = hasBase`)
 * - `[6..7]`: Reserved (`0`)
 * - `[8..11]`: `pageSize` (`uint32`)
 * - `[12..15]`: `baseByteLength` (`uint32`)
 * - `[16..19]`: `targetByteLength` (`uint32`)
 * - `[20..23]`: `changedPageCount` (`uint32`)
 * - `[24..27]`: `baseChecksum` (`uint32` CRC32 of `base`)
 * - `[28..31]`: `targetChecksum` (`uint32` CRC32 of `target`)
 * - Followed by `changedPageCount` page entries:
 *   - `pageIndex` (`uint32`)
 *   - `pageByteLength` (`uint16`)
 *   - `pageBytes` (`Uint8Array(pageByteLength)`)
 */
export function exportPageDiff(
  base: SnapshotOrImageInput,
  target: DatabaseSnapshot | Uint8Array,
  options: PageDiffOptions = {},
): Uint8Array {
  const inferredPageSize =
    options.pageSize ??
    (isDatabaseSnapshot(target)
      ? target.pageSize
      : isDatabaseSnapshot(base)
        ? base.pageSize
        : DEFAULT_SNAPSHOT_PAGE_SIZE);

  if (!Number.isInteger(inferredPageSize) || inferredPageSize <= 0 || inferredPageSize > 65535) {
    throw new RangeError(
      `Invalid pageSize ${inferredPageSize}: must be an integer between 1 and 65535`,
    );
  }

  const baseSplit = splitIntoPages(base, inferredPageSize);
  const targetSplit = splitIntoPages(target, inferredPageSize);

  // If base was a snapshot with a different pageSize than target, re-slice base at target's pageSize
  const basePages =
    baseSplit.hasBase && baseSplit.pageSize !== inferredPageSize
      ? splitIntoPages(
          isDatabaseSnapshot(base) ? base.toUint8Array() : (base as Uint8Array),
          inferredPageSize,
        ).pages
      : baseSplit.pages;

  const changedEntries: PageDiffEntry[] = [];
  let payloadBytes = 0;

  for (let i = 0; i < targetSplit.pages.length; i++) {
    const targetPage = targetSplit.pages[i]!;
    const basePage = basePages[i];
    if (basePage && (basePage === targetPage || sameBytes(basePage, targetPage))) {
      continue;
    }
    changedEntries.push({ pageIndex: i, data: targetPage });
    payloadBytes += 6 + targetPage.byteLength;
  }

  const baseChecksum = baseSplit.hasBase ? computeCrc32(basePages) : 0;
  const targetChecksum = computeCrc32(targetSplit.pages);
  const flags = baseSplit.hasBase ? 1 : 0;

  const out = new Uint8Array(PAGE_DIFF_HEADER_BYTES + payloadBytes);
  out.set(PAGE_DIFF_MAGIC, 0);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(5, flags);
  view.setUint16(6, 0, true);
  view.setUint32(8, inferredPageSize, true);
  view.setUint32(12, baseSplit.byteLength, true);
  view.setUint32(16, targetSplit.byteLength, true);
  view.setUint32(20, changedEntries.length, true);
  view.setUint32(24, baseChecksum, true);
  view.setUint32(28, targetChecksum, true);

  let offset = PAGE_DIFF_HEADER_BYTES;
  for (const entry of changedEntries) {
    view.setUint32(offset, entry.pageIndex, true);
    view.setUint16(offset + 4, entry.data.byteLength, true);
    out.set(entry.data, offset + 6);
    offset += 6 + entry.data.byteLength;
  }

  return out;
}

/**
 * Decode and inspect a binary page diff (`FBDF\x01`) produced by
 * {@link exportPageDiff}.
 */
export function inspectPageDiff(diffBytes: Uint8Array): ParsedPageDiff {
  if (!isPageDiffPayload(diffBytes)) {
    throw new Error(
      'Invalid binary page diff: missing FBDF\\x01 magic header or truncated buffer',
    );
  }

  const view = new DataView(
    diffBytes.buffer,
    diffBytes.byteOffset,
    diffBytes.byteLength,
  );
  const version = view.getUint8(4);
  if (version !== 1) {
    throw new Error(`Unsupported binary page diff version: ${version}`);
  }
  const flags = view.getUint8(5);
  const hasBase = (flags & 1) !== 0;
  const pageSize = view.getUint32(8, true);
  const baseByteLength = view.getUint32(12, true);
  const targetByteLength = view.getUint32(16, true);
  const changedPageCount = view.getUint32(20, true);
  const baseChecksum = view.getUint32(24, true);
  const targetChecksum = view.getUint32(28, true);
  const targetPageCount = pageSize > 0 ? Math.ceil(targetByteLength / pageSize) : 0;

  const entries: PageDiffEntry[] = [];
  let offset = PAGE_DIFF_HEADER_BYTES;
  for (let i = 0; i < changedPageCount; i++) {
    if (offset + 6 > diffBytes.byteLength) {
      throw new Error(
        `Truncated binary page diff at entry ${i}: expected 6-byte entry header`,
      );
    }
    const pageIndex = view.getUint32(offset, true);
    const pageByteLength = view.getUint16(offset + 4, true);
    offset += 6;
    if (offset + pageByteLength > diffBytes.byteLength) {
      throw new Error(
        `Truncated binary page diff at page ${pageIndex}: expected ${pageByteLength} bytes`,
      );
    }
    const data = diffBytes.subarray(offset, offset + pageByteLength);
    entries.push({ pageIndex, data });
    offset += pageByteLength;
  }

  return {
    version,
    flags,
    hasBase,
    pageSize,
    baseByteLength,
    targetByteLength,
    targetPageCount,
    changedPageCount,
    baseChecksum,
    targetChecksum,
    entries,
  };
}

/**
 * Apply a compact binary page diff (`FBDF\x01`) onto `base` (`DatabaseSnapshot`,
 * `Uint8Array`, or `null`) and return the reconstructed target `.fdb` byte image.
 */
export function applyPageDiff(
  base: SnapshotOrImageInput,
  diffBytes: Uint8Array,
  options: ApplyPageDiffOptions = {},
): Uint8Array {
  const parsed = inspectPageDiff(diffBytes);
  const verifyBase = options.verifyBaseChecksum ?? true;
  const verifyTarget = options.verifyTargetChecksum ?? true;

  const baseSplit = splitIntoPages(base, parsed.pageSize);
  const basePages =
    baseSplit.hasBase && baseSplit.pageSize !== parsed.pageSize
      ? splitIntoPages(
          isDatabaseSnapshot(base) ? base.toUint8Array() : (base as Uint8Array),
          parsed.pageSize,
        ).pages
      : baseSplit.pages;

  if (parsed.hasBase && verifyBase) {
    if (baseSplit.byteLength !== parsed.baseByteLength) {
      throw new Error(
        `Page diff base length mismatch: diff expects ${parsed.baseByteLength} bytes, but base image has ${baseSplit.byteLength} bytes`,
      );
    }
    const actualBaseCrc = computeCrc32(basePages);
    if (actualBaseCrc !== parsed.baseChecksum) {
      throw new Error(
        `Page diff base checksum mismatch: expected 0x${parsed.baseChecksum.toString(16)}, got 0x${actualBaseCrc.toString(16)}`,
      );
    }
  }

  const out = new Uint8Array(parsed.targetByteLength);

  // 1. Copy unchanged pages from `base` up to `targetByteLength`
  for (let i = 0; i < basePages.length; i++) {
    const dstOffset = i * parsed.pageSize;
    if (dstOffset >= parsed.targetByteLength) break;
    const srcPage = basePages[i]!;
    const copyLen = Math.min(srcPage.byteLength, parsed.targetByteLength - dstOffset);
    out.set(srcPage.subarray(0, copyLen), dstOffset);
  }

  // 2. Overlay changed/added pages from the diff
  for (const entry of parsed.entries) {
    const dstOffset = entry.pageIndex * parsed.pageSize;
    if (dstOffset + entry.data.byteLength > parsed.targetByteLength) {
      throw new Error(
        `Page diff entry ${entry.pageIndex} exceeds targetByteLength (${parsed.targetByteLength})`,
      );
    }
    out.set(entry.data, dstOffset);
  }

  if (verifyTarget) {
    const actualTargetCrc = computeCrc32(out);
    if (actualTargetCrc !== parsed.targetChecksum) {
      throw new Error(
        `Page diff target checksum mismatch after apply: expected 0x${parsed.targetChecksum.toString(16)}, got 0x${actualTargetCrc.toString(16)}`,
      );
    }
  }

  return out;
}

/**
 * Copy-on-Write page-level snapshot manager.
 *
 * Compares each page against the most recent snapshot (and indexed page slots)
 * and reuses existing immutable `Uint8Array` page instances whenever a page's
 * bytes are unchanged.
 */
export class CowSnapshotStore {
  private readonly defaultPageSize: number;
  private readonly snapshots = new Map<string, DatabaseSnapshot>();
  private lastSnapshotId: string | null = null;
  private counter = 0;

  constructor(defaultPageSize = DEFAULT_SNAPSHOT_PAGE_SIZE) {
    this.defaultPageSize = defaultPageSize;
  }

  /** Number of snapshots currently held in the store. */
  get size(): number {
    return this.snapshots.size;
  }

  /**
   * Capture a new copy-on-write page snapshot from a database byte image.
   */
  createSnapshot(
    data: Uint8Array,
    labelOrOptions?: string | SnapshotOptions,
  ): DatabaseSnapshot {
    const opts: SnapshotOptions =
      typeof labelOrOptions === 'string'
        ? { label: labelOrOptions }
        : (labelOrOptions ?? {});
    const pageSize = opts.pageSize ?? this.defaultPageSize;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new RangeError(`Invalid snapshot pageSize: ${pageSize}`);
    }

    this.counter += 1;
    const label = opts.label?.trim() || undefined;
    const id =
      opts.id?.trim() ||
      (label && !this.snapshots.has(label) ? label : `snap_${this.counter}`);

    const parent = this.lastSnapshotId
      ? (this.snapshots.get(this.lastSnapshotId) ?? null)
      : null;

    const pageCount = Math.ceil(data.byteLength / pageSize);
    const pages: Uint8Array[] = new Array(pageCount);
    let uniquePages = 0;
    let sharedPages = 0;

    for (let i = 0; i < pageCount; i++) {
      const start = i * pageSize;
      const end = Math.min(start + pageSize, data.byteLength);
      const view = data.subarray(start, end);

      const parentPage =
        parent && parent.pageSize === pageSize ? parent.pages[i] : undefined;
      if (parentPage && sameBytes(parentPage, view)) {
        pages[i] = parentPage;
        sharedPages += 1;
      } else {
        // Also check if any other existing snapshot already holds the identical page at index i
        let reused: Uint8Array | undefined;
        for (const existing of this.snapshots.values()) {
          if (existing.pageSize === pageSize) {
            const candidate = existing.pages[i];
            if (candidate && sameBytes(candidate, view)) {
              reused = candidate;
              break;
            }
          }
        }
        if (reused) {
          pages[i] = reused;
          sharedPages += 1;
        } else {
          pages[i] = view.slice();
          uniquePages += 1;
        }
      }
    }

    const frozenPages = Object.freeze(pages);
    const byteLength = data.byteLength;
    const createdAt = Date.now();
    const parentId = parent ? parent.id : null;

    const snapshot: DatabaseSnapshot = {
      id,
      ...(label ? { label } : {}),
      createdAt,
      pageSize,
      pageCount,
      byteLength,
      uniquePages,
      sharedPages,
      parentId,
      pages: frozenPages,
      toUint8Array(): Uint8Array {
        const out = new Uint8Array(byteLength);
        let pos = 0;
        for (let i = 0; i < frozenPages.length; i++) {
          const p = frozenPages[i]!;
          out.set(p, pos);
          pos += p.byteLength;
        }
        return out;
      },
    };

    this.snapshots.set(id, snapshot);
    this.lastSnapshotId = id;
    return snapshot;
  }

  /**
   * Look up a stored snapshot by its `DatabaseSnapshot` object, `id`, or `label`.
   */
  getSnapshot(snapshotOrId: DatabaseSnapshot | string): DatabaseSnapshot {
    if (typeof snapshotOrId === 'object' && snapshotOrId !== null) {
      if (typeof snapshotOrId.toUint8Array === 'function') {
        return snapshotOrId;
      }
    }
    const key = String(snapshotOrId).trim();
    const byId = this.snapshots.get(key);
    if (byId) return byId;

    for (const snap of this.snapshots.values()) {
      if (snap.label === key) {
        return snap;
      }
    }
    throw new Error(`Snapshot "${key}" was not found`);
  }

  /** Return `true` if a snapshot with the given `id` or `label` exists. */
  hasSnapshot(idOrLabel: string): boolean {
    const key = idOrLabel.trim();
    if (this.snapshots.has(key)) return true;
    for (const snap of this.snapshots.values()) {
      if (snap.label === key) return true;
    }
    return false;
  }

  /** Return metadata for all stored snapshots in creation order. */
  listSnapshots(): DatabaseSnapshotInfo[] {
    return Array.from(this.snapshots.values()).map((s) => ({
      id: s.id,
      ...(s.label ? { label: s.label } : {}),
      createdAt: s.createdAt,
      pageSize: s.pageSize,
      pageCount: s.pageCount,
      byteLength: s.byteLength,
      uniquePages: s.uniquePages,
      sharedPages: s.sharedPages,
      parentId: s.parentId,
    }));
  }

  /** Delete a stored snapshot by `id`, `label`, or `DatabaseSnapshot` reference. */
  deleteSnapshot(snapshotOrId: DatabaseSnapshot | string): boolean {
    const key =
      typeof snapshotOrId === 'string' ? snapshotOrId.trim() : snapshotOrId.id;
    if (this.snapshots.delete(key)) {
      if (this.lastSnapshotId === key) {
        const remaining = Array.from(this.snapshots.keys());
        this.lastSnapshotId =
          remaining.length > 0 ? remaining[remaining.length - 1]! : null;
      }
      return true;
    }
    for (const [id, snap] of this.snapshots.entries()) {
      if (snap.label === key) {
        this.snapshots.delete(id);
        if (this.lastSnapshotId === id) {
          const remaining = Array.from(this.snapshots.keys());
          this.lastSnapshotId =
            remaining.length > 0 ? remaining[remaining.length - 1]! : null;
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Export a compact binary page diff (`FBDF\x01`) between two snapshots (or
   * raw `Uint8Array` images) managed by this store.
   */
  exportDiff(
    fromSnapshotOrId: DatabaseSnapshot | string | Uint8Array | null,
    toSnapshotOrId: DatabaseSnapshot | string | Uint8Array,
    options?: PageDiffOptions,
  ): Uint8Array {
    const resolvedFrom: SnapshotOrImageInput =
      typeof fromSnapshotOrId === 'string'
        ? this.getSnapshot(fromSnapshotOrId)
        : fromSnapshotOrId;
    const resolvedTo: DatabaseSnapshot | Uint8Array =
      typeof toSnapshotOrId === 'string'
        ? this.getSnapshot(toSnapshotOrId)
        : toSnapshotOrId;
    return exportPageDiff(resolvedFrom, resolvedTo, {
      pageSize: options?.pageSize ?? this.defaultPageSize,
    });
  }

  /**
   * Apply a compact binary page diff (`FBDF\x01`) onto `baseSnapshotOrId` (or
   * the most recent snapshot in the store when `baseSnapshotOrId` is omitted)
   * and optionally record the resulting image as a new snapshot.
   */
  applyDiff(
    diffBytes: Uint8Array,
    baseSnapshotOrId?: DatabaseSnapshot | string | Uint8Array | null,
    options: ApplyPageDiffOptions = {},
  ): Uint8Array {
    let resolvedBase: SnapshotOrImageInput;
    if (baseSnapshotOrId === undefined) {
      resolvedBase = this.lastSnapshotId
        ? (this.snapshots.get(this.lastSnapshotId) ?? null)
        : null;
    } else if (typeof baseSnapshotOrId === 'string') {
      resolvedBase = this.getSnapshot(baseSnapshotOrId);
    } else {
      resolvedBase = baseSnapshotOrId;
    }

    const nextBytes = applyPageDiff(resolvedBase, diffBytes, options);
    if (options.createSnapshot || options.snapshotLabel) {
      this.createSnapshot(nextBytes, options.snapshotLabel);
    }
    return nextBytes;
  }

  /** Remove all stored snapshots. */
  clear(): void {
    this.snapshots.clear();
    this.lastSnapshotId = null;
  }
}
