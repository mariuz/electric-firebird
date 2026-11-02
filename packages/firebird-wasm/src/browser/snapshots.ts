/**
 * snapshots.ts – Copy-on-Write (CoW) page-level point-in-time snapshots and
 * branching for `IndexedDBVFS`, `OPFSVFS`, `FirebirdBrowser`, and `FirebirdLite`.
 *
 * Instead of duplicating the entire `.fdb` byte image on every checkpoint,
 * `CowSnapshotStore` splits the database image into fixed-size 8 KB pages and
 * shares unchanged `Uint8Array` page buffers across snapshots. Taking a
 * snapshot after a small write allocates only the dirty pages while sharing all
 * unmodified pages with prior snapshots in O(changed pages) memory.
 */

const DEFAULT_SNAPSHOT_PAGE_SIZE = 8192;

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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

  /** Remove all stored snapshots. */
  clear(): void {
    this.snapshots.clear();
    this.lastSnapshotId = null;
  }
}
