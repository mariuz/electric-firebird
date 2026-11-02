/**
 * opfs-fs.ts – an Emscripten filesystem and page-level VFS backed by OPFS
 * `FileSystemSyncAccessHandle`.
 *
 * The IndexedDB path keeps the whole database in memory and copies the image
 * out on every persist. That is a durability strategy bolted beside the engine.
 * This is the other shape: Firebird's own reads and writes land in a file, and
 * there is no persist step because there is nothing to copy.
 *
 * Three facts make it possible, and each was checked rather than assumed:
 *
 *   1. **Firebird's I/O reaches JavaScript.** A custom filesystem mounted in
 *      Emscripten's FS sees the engine's reads and writes — measured at 1,678
 *      writes and 14.1 MB for a create-plus-insert, all through `stream_ops`.
 *   2. **`FileSystemSyncAccessHandle` is synchronous**, which is what a
 *      filesystem callback needs: `read`, `write`, `truncate` and `getSize`
 *      return values rather than promises. It exists only in a Worker, and the
 *      engine already runs in one — a browser cannot run it anywhere else.
 *   3. **Handles are opened before the mount.** Opening one is async and a
 *      stream op cannot await, so the database's handle is acquired up front
 *      and the mount owns it from then on.
 *
 * What this deliberately does not do is host a general filesystem. One mount
 * holds one database, because that is what Firebird opens: the probe recorded
 * exactly one `open` for a create-and-query cycle. Temporary files, if the
 * engine ever wants them, stay on MEMFS where they belong — they are scratch,
 * and paying an OPFS round trip for them would be a cost with no durability to
 * show for it.
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import type { VFSMetadata } from './indexeddb-vfs';
import type { PageEncryptionKey } from './page-crypto';
import {
  ENCRYPTED_PAGE_OVERHEAD,
  encryptPage,
  decryptPage,
  isEncryptedPageBuffer,
  resolveCryptoKey,
} from './page-crypto';
import {
  CowSnapshotStore,
  type DatabaseSnapshot,
  type DatabaseSnapshotInfo,
  type SnapshotOptions,
} from './snapshots';

// ---------------------------------------------------------------------------
// The subset of OPFS this needs
// ---------------------------------------------------------------------------

/**
 * `FileSystemSyncAccessHandle`, as much of it as is used here.
 *
 * Declared rather than imported: the DOM lib in this project's TypeScript
 * target does not carry it, and a hand-written interface says exactly which
 * methods this depends on.
 */
export interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OpfsDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface OpfsFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

/** I/O counters recorded by an OPFS mount or {@link OPFSVFS} instance. */
export interface OpfsMountStats {
  reads: number;
  writes: number;
  flushes: number;
  truncates: number;
  bytesRead: number;
  bytesWritten: number;
}

/** Optional hooks and telemetry for {@link mountOpfs}. */
export interface MountOpfsOptions {
  /**
   * Optional synchronous transform applied in-place after reading bytes from
   * the underlying `SyncAccessHandle` (e.g., for page decryption or checksums).
   */
  transformRead?: (data: Uint8Array, offset: number, fileName: string) => void;
  /**
   * Optional synchronous transform applied before writing bytes to the
   * underlying `SyncAccessHandle` (e.g., for page encryption).
   */
  transformWrite?: (data: Uint8Array, offset: number, fileName: string) => Uint8Array;
  /** Optional stats object updated in-place on every read, write, flush, or truncate. */
  stats?: OpfsMountStats;
  /** Whether to invoke `handle.flush()` on every `stream_ops.close()`. @default false */
  flushOnClose?: boolean;
}

/** Configuration options for {@link OPFSVFS}. */
export interface OPFSVFSOptions {
  /** Directory under the OPFS root holding database files. @default 'firebird' */
  directoryName?: string;
  /** Database page size in bytes. @default 8192 */
  pageSize?: number;
  /** Optional pre-opened `SyncAccessHandle` (useful for tests or custom worker hosts). */
  handle?: SyncAccessHandle;
  /** Optional custom OPFS root directory provider (defaults to `navigator.storage.getDirectory()`). */
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
  /**
   * Optional WebCrypto AES-GCM key (`CryptoKey` or 16/32-byte `Uint8Array` /
   * `ArrayBuffer`) used to encrypt 8 KB database pages at rest in OPFS.
   */
  encryptionKey?: PageEncryptionKey;
}

/** In-memory `SyncAccessHandle` implementation for testing and non-OPFS environments. */
export interface MemorySyncAccessHandle extends SyncAccessHandle {
  /** Return a copy of the current file contents as a `Uint8Array`. */
  toUint8Array(): Uint8Array;
  /** True after `close()` has been called. */
  readonly closed: boolean;
  /** Number of times `flush()` has been called. */
  readonly flushCount: number;
}

/**
 * Create a growable, byte-accurate in-memory {@link SyncAccessHandle}.
 *
 * Useful for testing direct page-level PIO (`mountOpfs` and {@link OPFSVFS})
 * in Node.js or main-thread test environments where browser Worker OPFS is
 * not present.
 */
export function createMemorySyncAccessHandle(
  initialBytes?: Uint8Array,
): MemorySyncAccessHandle {
  let capacity = Math.max(65536, initialBytes ? initialBytes.byteLength * 2 : 65536);
  let storage = new Uint8Array(capacity);
  let size = initialBytes ? initialBytes.byteLength : 0;
  if (initialBytes && size > 0) {
    storage.set(initialBytes, 0);
  }
  let isClosed = false;
  let flushes = 0;

  const ensureCapacity = (required: number): void => {
    if (required <= capacity) return;
    while (capacity < required) {
      capacity *= 2;
    }
    const next = new Uint8Array(capacity);
    if (size > 0) {
      next.set(storage.subarray(0, size), 0);
    }
    storage = next;
  };

  return {
    get closed(): boolean {
      return isClosed;
    },
    get flushCount(): number {
      return flushes;
    },
    read(buffer: ArrayBufferView, options?: { at?: number }): number {
      const pos = Math.max(0, Math.floor(options?.at ?? 0));
      if (pos >= size || buffer.byteLength === 0) return 0;
      const available = Math.min(buffer.byteLength, size - pos);
      const target = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        available,
      );
      target.set(storage.subarray(pos, pos + available), 0);
      return available;
    },
    write(buffer: ArrayBufferView, options?: { at?: number }): number {
      const pos = Math.max(0, Math.floor(options?.at ?? 0));
      const len = buffer.byteLength;
      if (len === 0) return 0;
      const end = pos + len;
      ensureCapacity(end);
      if (pos > size) {
        storage.fill(0, size, pos);
      }
      const source = new Uint8Array(buffer.buffer, buffer.byteOffset, len);
      storage.set(source, pos);
      if (end > size) {
        size = end;
      }
      return len;
    },
    truncate(newSize: number): void {
      const targetSize = Math.max(0, Math.floor(newSize));
      ensureCapacity(targetSize);
      if (targetSize > size) {
        storage.fill(0, size, targetSize);
      } else if (targetSize < size) {
        storage.fill(0, targetSize, size);
      }
      size = targetSize;
    },
    getSize(): number {
      return size;
    },
    flush(): void {
      flushes += 1;
    },
    close(): void {
      isClosed = true;
    },
    toUint8Array(): Uint8Array {
      return storage.slice(0, size);
    },
  };
}

/** True where OPFS sync access handles can actually be used. */
export function opfsAvailable(): boolean {
  const scope = globalThis as {
    navigator?: { storage?: { getDirectory?: unknown } };
    WorkerGlobalScope?: unknown;
    importScripts?: unknown;
  };

  if (typeof scope.navigator?.storage?.getDirectory !== 'function') return false;

  // Sync access handles are Worker-only. On a main thread the API is present
  // and `createSyncAccessHandle` rejects, which would surface as a failure deep
  // inside a mount rather than as a refusal to start. `importScripts` is the
  // cheapest reliable marker of a worker scope and needs no DOM lib types.
  return (
    scope.WorkerGlobalScope !== undefined || typeof scope.importScripts === 'function'
  );
}

// ---------------------------------------------------------------------------
// Opening the file
// ---------------------------------------------------------------------------

/** Directory under the OPFS root holding this library's databases. */
const OPFS_DIRECTORY = 'firebird';

function normalizeOpfsFileName(name: string): string {
  const trimmed = name.trim().replace(/^opfs:\/\//i, '');
  return trimmed.endsWith('.fdb') ? trimmed : `${trimmed}.fdb`;
}

/**
 * Open — creating if needed — the sync access handle for one database.
 *
 * @throws if another handle on the same file is already open. OPFS enforces
 *   that exclusively, which is a stronger and more honest guarantee than the
 *   Web Lock the IndexedDB path uses: two tabs cannot both hold the file, and
 *   the second one is told so by the platform rather than by a convention.
 */
export async function openDatabaseHandle(
  name: string,
  directoryName = OPFS_DIRECTORY,
  getDirectory?: () => Promise<OpfsDirectoryHandle>,
): Promise<SyncAccessHandle> {
  const root = getDirectory
    ? await getDirectory()
    : ((await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle);
  const dir = await root.getDirectoryHandle(directoryName, { create: true });
  const file = await dir.getFileHandle(normalizeOpfsFileName(name), { create: true });
  return file.createSyncAccessHandle();
}

/** Delete a database's file.  Fails silently when there is nothing to delete. */
export async function removeDatabaseFile(
  name: string,
  directoryName = OPFS_DIRECTORY,
  getDirectory?: () => Promise<OpfsDirectoryHandle>,
): Promise<void> {
  const root = getDirectory
    ? await getDirectory()
    : ((await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle);
  const dir = await root.getDirectoryHandle(directoryName, { create: true });
  await dir.removeEntry(normalizeOpfsFileName(name)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The filesystem
// ---------------------------------------------------------------------------

/** Emscripten's `FS` object, in the shape a custom filesystem needs. */
interface EmscriptenFSInternals {
  createNode(parent: unknown, name: string, mode: number, dev: number): FSNode;
  isDir(mode: number): boolean;
  ErrnoError: new (errno: number) => Error;
  mount(type: unknown, opts: unknown, mountpoint: string): void;
  unmount?(mountpoint: string): void;
  mkdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

interface FSNode {
  id: number;
  mode: number;
  rdev: number;
  name: string;
  parent: FSNode;
  timestamp: number;
  node_ops: Record<string, unknown>;
  stream_ops: Record<string, unknown>;
  contents?: Record<string, FSNode>;
  handle?: SyncAccessHandle;
}

interface FSStream {
  node: FSNode;
  position: number;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const ENOENT = 44;
const EPERM = 63;

/** Create a zeroed {@link OpfsMountStats} counter object. */
export function createOpfsMountStats(): OpfsMountStats {
  return {
    reads: 0,
    writes: 0,
    flushes: 0,
    truncates: 0,
    bytesRead: 0,
    bytesWritten: 0,
  };
}

/**
 * Mount a filesystem at `mountpoint` whose files are OPFS sync access handles.
 *
 * `files` maps a name inside the mount to its already-open handle. Nothing
 * else can be created there: a filesystem that silently accepted a second file
 * would be one that silently lost it, since only the listed handles are backed
 * by anything.
 */
export function mountOpfs(
  mod: FirebirdWasmModule,
  mountpoint: string,
  files: Map<string, SyncAccessHandle>,
  options: MountOpfsOptions = {},
): OpfsMountStats {
  const FS = mod.FS as unknown as EmscriptenFSInternals;
  const stats = options.stats ?? createOpfsMountStats();
  const transformRead = options.transformRead;
  const transformWrite = options.transformWrite;
  const flushOnClose = options.flushOnClose === true;

  // A scratch buffer for the threaded build, whose WASM heap is a
  // SharedArrayBuffer that OPFS refuses views onto. Grown as needed and
  // reused, so the cost there is one copy per operation rather than one
  // allocation. The default build has no threads and a plain ArrayBuffer
  // heap, which OPFS reads into and writes from directly — so there `scratch`
  // is never allocated and no byte is copied twice.
  let scratch: Uint8Array | null = null;
  const scratchFor = (length: number): Uint8Array => {
    if (!scratch || scratch.byteLength < length) {
      scratch = new Uint8Array(Math.max(length, (scratch?.byteLength ?? 32768) * 2));
    }
    return scratch.subarray(0, length);
  };
  const isShared = (view: ArrayBufferView): boolean =>
    typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer;

  const attrs = (node: FSNode, size: number) => ({
    dev: 1,
    ino: node.id,
    mode: node.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: node.rdev,
    size,
    atime: new Date(node.timestamp),
    mtime: new Date(node.timestamp),
    ctime: new Date(node.timestamp),
    blksize: 4096,
    blocks: Math.ceil(size / 4096),
  });

  const streamOps = {
    open(): void {
      /* The handle is already open; there is nothing per-stream to do. */
    },
    close(stream?: FSStream): void {
      // Deliberately not closed here. The handle outlives any single open —
      // Firebird opens and closes the database repeatedly within one session,
      // and reopening a sync access handle is both async and exclusive, so a
      // close here would make the next open fail.
      if (flushOnClose && stream?.node?.handle) {
        stream.node.handle.flush();
        stats.flushes += 1;
      }
    },
    fsync(stream: FSStream): number {
      stream.node.handle!.flush();
      stats.flushes += 1;
      return 0;
    },
    msync(stream: FSStream): number {
      stream.node.handle!.flush();
      stats.flushes += 1;
      return 0;
    },
    llseek(stream: FSStream, offset: number, whence: number): number {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position += stream.node.handle!.getSize();
      if (position < 0) throw new FS.ErrnoError(28); // EINVAL
      return position;
    },
    read(
      stream: FSStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number {
      if (length <= 0) return 0;
      const handle = stream.node.handle!;
      let read: number;
      if (!isShared(buffer)) {
        const slice = buffer.subarray(offset, offset + length);
        read = handle.read(slice, { at: position });
        if (read > 0 && transformRead) {
          transformRead(slice.subarray(0, read), position, stream.node.name);
        }
      } else {
        const target = scratchFor(length);
        read = handle.read(target, { at: position });
        if (read > 0) {
          const readSlice = target.subarray(0, read);
          if (transformRead) {
            transformRead(readSlice, position, stream.node.name);
          }
          buffer.set(readSlice, offset);
        }
      }
      stats.reads += 1;
      if (read > 0) stats.bytesRead += read;
      return read;
    },
    write(
      stream: FSStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number {
      if (length <= 0) return 0;
      const handle = stream.node.handle!;
      const view = buffer.subarray(offset, offset + length);
      let written: number;
      if (transformWrite) {
        const transformed = transformWrite(view, position, stream.node.name);
        if (!isShared(transformed)) {
          written = handle.write(transformed, { at: position });
        } else {
          const source = scratchFor(transformed.byteLength);
          source.set(transformed);
          written = handle.write(source, { at: position });
        }
      } else if (!isShared(buffer)) {
        written = handle.write(view, { at: position });
      } else {
        const source = scratchFor(length);
        source.set(view);
        written = handle.write(source, { at: position });
      }
      stats.writes += 1;
      if (written > 0) stats.bytesWritten += written;
      nodeTouch(stream.node);
      return written;
    },
  };

  const nodeTouch = (node: FSNode): void => {
    node.timestamp = Date.now();
  };

  const fileOps = {
    getattr(node: FSNode) {
      return attrs(node, node.handle!.getSize());
    },
    setattr(node: FSNode, attr: { mode?: number; timestamp?: number; size?: number }) {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
      if (attr.size !== undefined) {
        node.handle!.truncate(attr.size);
        stats.truncates += 1;
      }
    },
  };

  /**
   * Bind a name to its pre-opened handle as a file node, once.
   *
   * Cached on the directory so `lookup` keeps returning the same node: the FS
   * treats node identity as file identity, and a fresh object each time would
   * make the same file look like a different one.
   */
  const materialise = (parent: FSNode, name: string): FSNode => {
    const existing = parent.contents?.[name];
    if (existing) return existing;

    const handle = files.get(name);
    if (!handle) throw new FS.ErrnoError(ENOENT);

    const node = FS.createNode(parent, name, S_IFREG | 0o666, 0);
    node.node_ops = fileOps;
    node.stream_ops = streamOps;
    node.handle = handle;
    node.timestamp = Date.now();
    parent.contents![name] = node;
    return node;
  };

  const dirOps = {
    getattr(node: FSNode) {
      return attrs(node, 4096);
    },
    setattr(node: FSNode, attr: { mode?: number; timestamp?: number }) {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    /**
     * A file exists here when its handle has bytes in it.
     *
     * Opening a sync access handle creates the underlying file, so the file is
     * always *there* — which would make every database look pre-existing and
     * Firebird's `O_CREAT | O_EXCL` fail with EEXIST on a database that has
     * never been written. Size is what actually distinguishes "not yet a
     * database" from "a database", so size is what existence means.
     */
    lookup(parent: FSNode, name: string): FSNode {
      const cached = parent.contents?.[name];
      if (cached) return cached;

      const handle = files.get(name);
      if (!handle || handle.getSize() === 0) throw new FS.ErrnoError(ENOENT);
      return materialise(parent, name);
    },
    mknod(parent: FSNode, name: string): FSNode {
      // Creating the database is the engine binding itself to the handle that
      // was opened for it. Any other name has no backing store, and a file
      // with none would read back empty later rather than failing now.
      if (!files.has(name)) throw new FS.ErrnoError(EPERM);
      return materialise(parent, name);
    },
    rename(): void {
      throw new FS.ErrnoError(EPERM);
    },
    unlink(parent: FSNode, name: string): void {
      const handle = files.get(name);
      if (!handle) throw new FS.ErrnoError(EPERM);
      handle.truncate(0);
      handle.flush();
      stats.truncates += 1;
      stats.flushes += 1;
      if (parent.contents) {
        delete parent.contents[name];
      }
    },
    rmdir(): void {
      throw new FS.ErrnoError(EPERM);
    },
    readdir(node: FSNode): string[] {
      const entries = new Set<string>(['.', '..']);
      for (const name of Object.keys(node.contents ?? {})) {
        entries.add(name);
      }
      for (const [name, handle] of files.entries()) {
        if (handle.getSize() > 0) {
          entries.add(name);
        }
      }
      return Array.from(entries);
    },
    symlink(): void {
      throw new FS.ErrnoError(EPERM);
    },
  };

  const filesystem = {
    mount(): FSNode {
      // Only the directory. Its files appear through `lookup`, which is what
      // lets an unwritten database be absent rather than empty.
      const root = FS.createNode(null, '/', S_IFDIR | 0o777, 0);
      root.node_ops = dirOps;
      root.stream_ops = {};
      root.contents = {};
      root.timestamp = Date.now();
      return root;
    },
  };

  if (!FS.analyzePath(mountpoint).exists) {
    FS.mkdir(mountpoint);
  } else if (typeof FS.unmount === 'function') {
    try {
      FS.unmount(mountpoint);
    } catch {
      // Not previously mounted; ignore.
    }
  }
  FS.mount(filesystem, {}, mountpoint);
  return stats;
}

// ---------------------------------------------------------------------------
// Direct Page-Level OPFSVFS
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 8192;

/**
 * Direct page-level Origin Private File System (OPFS) Virtual File System.
 *
 * Unlike `IndexedDBVFS` — which stores pages in IndexedDB object stores and
 * exports/imports the entire `.fdb` image into Emscripten `MEMFS` — `OPFSVFS`
 * wraps a synchronous `FileSystemSyncAccessHandle` so both Firebird's native
 * PIO (`mount()`) and page-level JavaScript operations (`readPage`, `writePage`,
 * `readRange`, `writeRange`, `exportDatabase`, `importDatabase`) read and write
 * directly at byte offset `pageNumber * pageSize` without holding the full
 * database in WASM RAM.
 */
export class OPFSVFS {
  private readonly directoryName: string;
  private readonly configuredPageSize: number;
  private readonly providedHandle?: SyncAccessHandle;
  private readonly getDirectory?: () => Promise<OpfsDirectoryHandle>;
  private readonly encryptionKey?: PageEncryptionKey;

  private syncHandle: SyncAccessHandle | null = null;
  private ownsHandle = false;
  private currentDbName: string | null = null;
  private readonly stats: OpfsMountStats = createOpfsMountStats();
  private readonly snapshotStore: CowSnapshotStore;

  constructor(options: OPFSVFSOptions = {}) {
    this.directoryName = options.directoryName ?? OPFS_DIRECTORY;
    this.configuredPageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.providedHandle = options.handle;
    this.getDirectory = options.getDirectory;
    this.encryptionKey = options.encryptionKey;
    this.snapshotStore = new CowSnapshotStore(this.configuredPageSize);
  }

  /** Whether this VFS instance is configured to encrypt pages at rest. */
  get isEncrypted(): boolean {
    return this.encryptionKey !== undefined;
  }

  /** Whether a `SyncAccessHandle` is currently open. */
  get isOpen(): boolean {
    return this.syncHandle !== null;
  }

  /** Configured database page size in bytes (default `8192`). */
  get pageSize(): number {
    return this.configuredPageSize;
  }

  /** The underlying `SyncAccessHandle`, or `null` if not yet opened. */
  get handle(): SyncAccessHandle | null {
    return this.syncHandle;
  }

  /** Logical database name passed to `open()`, or `null` if not yet opened. */
  get dbName(): string | null {
    return this.currentDbName;
  }

  /**
   * Open (or create) the OPFS file for `dbName` and acquire its exclusive
   * `FileSystemSyncAccessHandle`.
   */
  async open(dbName: string): Promise<VFSMetadata> {
    if (this.syncHandle) {
      return (await this.getMetadata())!;
    }

    if (this.encryptionKey) {
      await resolveCryptoKey(this.encryptionKey);
    }

    const cleanName = dbName.trim().replace(/^opfs:\/\//i, '').replace(/\.fdb$/i, '') || 'database';
    if (this.providedHandle) {
      this.syncHandle = this.providedHandle;
      this.ownsHandle = false;
    } else {
      this.syncHandle = await openDatabaseHandle(
        cleanName,
        this.directoryName,
        this.getDirectory,
      );
      this.ownsHandle = true;
    }

    this.currentDbName = cleanName;
    return (await this.getMetadata())!;
  }

  /** Flush and close the underlying `SyncAccessHandle`. */
  async close(): Promise<void> {
    const handle = this.syncHandle;
    this.syncHandle = null;
    if (!handle) return;
    try {
      handle.flush();
      this.stats.flushes += 1;
    } catch {
      // Ignore flush errors on close.
    }
    if (this.ownsHandle) {
      try {
        handle.close();
      } catch {
        // Ignore close errors if already closed.
      }
    }
  }

  private hasEncryptedHeader(): boolean {
    if (!this.syncHandle || this.syncHandle.getSize() < ENCRYPTED_PAGE_OVERHEAD) {
      return false;
    }
    const probe = new Uint8Array(ENCRYPTED_PAGE_OVERHEAD);
    this.syncHandle.read(probe, { at: 0 });
    return isEncryptedPageBuffer(probe);
  }

  /** Return metadata describing the currently open OPFS database file. */
  async getMetadata(): Promise<VFSMetadata | null> {
    if (!this.syncHandle || !this.currentDbName) return null;
    const size = this.syncHandle.getSize();
    const encrypted = Boolean(this.encryptionKey) || this.hasEncryptedHeader();
    const slotSize = encrypted
      ? this.configuredPageSize + ENCRYPTED_PAGE_OVERHEAD
      : this.configuredPageSize;
    return {
      pageSize: this.configuredPageSize,
      pageCount: Math.ceil(size / slotSize),
      ...(encrypted ? { encrypted: true } : {}),
    };
  }

  /**
   * Read a single database page (`pageNumber * pageSize`) directly from the
   * underlying `SyncAccessHandle`. Returns `null` if the page is beyond EOF.
   */
  async readPage(pageNumber: number): Promise<Uint8Array | null> {
    const handle = this.requireHandle();
    if (!Number.isInteger(pageNumber) || pageNumber < 0) {
      throw new RangeError(`Invalid pageNumber: ${pageNumber}`);
    }
    const encrypted = Boolean(this.encryptionKey) || this.hasEncryptedHeader();
    if (encrypted) {
      const slotSize = this.configuredPageSize + ENCRYPTED_PAGE_OVERHEAD;
      const offset = pageNumber * slotSize;
      const size = handle.getSize();
      if (offset >= size) return null;

      const slot = new Uint8Array(slotSize);
      const n = handle.read(slot, { at: offset });
      this.stats.reads += 1;
      if (n <= 0) return null;
      this.stats.bytesRead += n;

      if (isEncryptedPageBuffer(slot)) {
        if (!this.encryptionKey) {
          throw new Error(
            `Database page ${pageNumber} is encrypted at rest, but no encryptionKey was provided to OPFSVFS`,
          );
        }
        return decryptPage(
          slot,
          this.encryptionKey,
          pageNumber,
          this.configuredPageSize,
        );
      }

      // Sparse unwritten intermediate page (all zeros)
      let allZero = true;
      for (let i = 0; i < slot.byteLength; i++) {
        if (slot[i] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) {
        return new Uint8Array(this.configuredPageSize);
      }
      if (!this.encryptionKey) {
        return slot.subarray(0, this.configuredPageSize);
      }
      return decryptPage(
        slot,
        this.encryptionKey,
        pageNumber,
        this.configuredPageSize,
      );
    }

    const offset = pageNumber * this.configuredPageSize;
    const size = handle.getSize();
    if (offset >= size) return null;

    const buf = new Uint8Array(this.configuredPageSize);
    const n = handle.read(buf, { at: offset });
    this.stats.reads += 1;
    if (n <= 0) return null;
    this.stats.bytesRead += n;
    return buf;
  }

  /**
   * Read the raw physical bytes stored for `pageNumber` without decrypting.
   * Useful for diagnostics and verifying at-rest encryption.
   */
  async readRawPage(pageNumber: number): Promise<Uint8Array | null> {
    const handle = this.requireHandle();
    const encrypted = Boolean(this.encryptionKey) || this.hasEncryptedHeader();
    const slotSize = encrypted
      ? this.configuredPageSize + ENCRYPTED_PAGE_OVERHEAD
      : this.configuredPageSize;
    const offset = pageNumber * slotSize;
    if (offset >= handle.getSize()) return null;
    const buf = new Uint8Array(slotSize);
    const n = handle.read(buf, { at: offset });
    return n > 0 ? buf.subarray(0, n) : null;
  }

  /**
   * Write a single database page at byte offset `pageNumber * pageSize` (or
   * `pageNumber * (pageSize + 32)` when encrypted).
   */
  async writePage(pageNumber: number, data: Uint8Array): Promise<void> {
    const handle = this.requireHandle();
    if (!Number.isInteger(pageNumber) || pageNumber < 0) {
      throw new RangeError(`Invalid pageNumber: ${pageNumber}`);
    }
    if (data.byteLength !== this.configuredPageSize) {
      throw new RangeError(
        `Page data length (${data.byteLength}) does not match VFS pageSize (${this.configuredPageSize})`,
      );
    }
    if (this.encryptionKey) {
      const slotSize = this.configuredPageSize + ENCRYPTED_PAGE_OVERHEAD;
      const offset = pageNumber * slotSize;
      const envelope = await encryptPage(
        data,
        this.encryptionKey,
        pageNumber,
        this.configuredPageSize,
      );
      const written = handle.write(envelope, { at: offset });
      this.stats.writes += 1;
      if (written > 0) this.stats.bytesWritten += written;
      return;
    }
    const offset = pageNumber * this.configuredPageSize;
    const written = handle.write(data, { at: offset });
    this.stats.writes += 1;
    if (written > 0) this.stats.bytesWritten += written;
  }

  /** Read a byte range `[offset, offset + length)` directly from OPFS. */
  async readRange(offset: number, length: number): Promise<Uint8Array> {
    const handle = this.requireHandle();
    if (length <= 0) return new Uint8Array(0);
    const size = handle.getSize();
    if (offset >= size) return new Uint8Array(0);
    const toRead = Math.min(length, size - offset);
    const buf = new Uint8Array(toRead);
    const n = handle.read(buf, { at: offset });
    this.stats.reads += 1;
    if (n > 0) this.stats.bytesRead += n;
    return n === toRead ? buf : buf.slice(0, Math.max(0, n));
  }

  /** Write `data` at byte `offset` directly to OPFS, optionally truncating first. */
  async writeRange(
    offset: number,
    data: Uint8Array,
    truncate = false,
  ): Promise<void> {
    const handle = this.requireHandle();
    if (truncate) {
      handle.truncate(0);
      this.stats.truncates += 1;
    }
    if (data.byteLength > 0) {
      const written = handle.write(data, { at: offset });
      this.stats.writes += 1;
      if (written > 0) this.stats.bytesWritten += written;
    }
  }

  /** Export the entire database file as a `Uint8Array`. */
  async exportDatabase(): Promise<Uint8Array> {
    const handle = this.requireHandle();
    const size = handle.getSize();
    if (size === 0) return new Uint8Array(0);
    if (this.encryptionKey || this.hasEncryptedHeader()) {
      const meta = (await this.getMetadata())!;
      const out = new Uint8Array(meta.pageCount * this.configuredPageSize);
      for (let i = 0; i < meta.pageCount; i++) {
        const page = await this.readPage(i);
        if (page) {
          out.set(page, i * this.configuredPageSize);
        }
      }
      return out;
    }
    const out = new Uint8Array(size);
    const n = handle.read(out, { at: 0 });
    this.stats.reads += 1;
    if (n > 0) this.stats.bytesRead += n;
    return n === size ? out : out.slice(0, Math.max(0, n));
  }

  /** Replace the entire database file contents with `data` and flush to disk. */
  async importDatabase(data: Uint8Array): Promise<void> {
    const handle = this.requireHandle();
    if (this.encryptionKey) {
      if (data.byteLength % this.configuredPageSize !== 0) {
        throw new RangeError(
          `Database size (${data.byteLength}) is not a multiple of page size (${this.configuredPageSize})`,
        );
      }
      const pageCount = data.byteLength / this.configuredPageSize;
      const slotSize = this.configuredPageSize + ENCRYPTED_PAGE_OVERHEAD;
      handle.truncate(pageCount * slotSize);
      this.stats.truncates += 1;
      for (let i = 0; i < pageCount; i++) {
        const plainPage = data.subarray(
          i * this.configuredPageSize,
          (i + 1) * this.configuredPageSize,
        );
        const envelope = await encryptPage(
          plainPage,
          this.encryptionKey,
          i,
          this.configuredPageSize,
        );
        const written = handle.write(envelope, { at: i * slotSize });
        this.stats.writes += 1;
        if (written > 0) this.stats.bytesWritten += written;
      }
      handle.flush();
      this.stats.flushes += 1;
      return;
    }
    handle.truncate(data.byteLength);
    this.stats.truncates += 1;
    if (data.byteLength > 0) {
      const written = handle.write(data, { at: 0 });
      this.stats.writes += 1;
      if (written > 0) this.stats.bytesWritten += written;
    }
    handle.flush();
    this.stats.flushes += 1;
  }

  /** Flush all pending writes to the underlying OPFS file. */
  async sync(): Promise<void> {
    const handle = this.requireHandle();
    handle.flush();
    this.stats.flushes += 1;
  }

  /** Truncate the database file to `0` bytes and flush. */
  async clear(): Promise<void> {
    const handle = this.requireHandle();
    handle.truncate(0);
    handle.flush();
    this.stats.truncates += 1;
    this.stats.flushes += 1;
  }

  /** Close the handle and delete the underlying `.fdb` file from OPFS. */
  async destroy(): Promise<void> {
    const dbName = this.currentDbName;
    const shouldRemove = this.ownsHandle;
    await this.close();
    if (dbName && shouldRemove) {
      await removeDatabaseFile(dbName, this.directoryName, this.getDirectory);
    }
  }

  /**
   * Mount this `OPFSVFS` instance into an Emscripten module's filesystem at
   * `mountpoint` (default `'/opfs'`) and return the mounted database path.
   */
  mount(
    mod: FirebirdWasmModule,
    mountpoint = '/opfs',
    options: Omit<MountOpfsOptions, 'stats'> = {},
  ): { dbPath: string; stats: OpfsMountStats } {
    const handle = this.requireHandle();
    const fileName = normalizeOpfsFileName(this.currentDbName ?? 'database');
    mountOpfs(mod, mountpoint, new Map([[fileName, handle]]), {
      ...options,
      stats: this.stats,
    });
    return {
      dbPath: `${mountpoint.replace(/\/+$/, '')}/${fileName}`,
      stats: this.stats,
    };
  }

  /** Return a snapshot of cumulative I/O statistics for this VFS instance. */
  getStats(): OpfsMountStats {
    return { ...this.stats };
  }

  /**
   * Capture a lightweight copy-on-write page snapshot of the current database
   * state stored in OPFS.
   */
  async snapshot(
    labelOrOptions?: string | SnapshotOptions,
  ): Promise<DatabaseSnapshot> {
    const image = await this.exportDatabase();
    return this.snapshotStore.createSnapshot(image, labelOrOptions);
  }

  /**
   * Restore the OPFS database to a previously captured point-in-time
   * {@link DatabaseSnapshot} (by snapshot object, `id`, `label`, or raw bytes).
   */
  async restoreSnapshot(
    snapshotOrId: DatabaseSnapshot | string | Uint8Array,
  ): Promise<void> {
    const bytes =
      snapshotOrId instanceof Uint8Array
        ? snapshotOrId
        : this.snapshotStore.getSnapshot(snapshotOrId).toUint8Array();
    await this.importDatabase(bytes);
  }

  /** List metadata for all copy-on-write snapshots held by this VFS instance. */
  listSnapshots(): DatabaseSnapshotInfo[] {
    return this.snapshotStore.listSnapshots();
  }

  /** Delete a stored copy-on-write snapshot by `id`, `label`, or reference. */
  deleteSnapshot(snapshotOrId: DatabaseSnapshot | string): boolean {
    return this.snapshotStore.deleteSnapshot(snapshotOrId);
  }

  private requireHandle(): SyncAccessHandle {
    if (!this.syncHandle) {
      throw new Error('OPFSVFS is not open. Call open(dbName) first.');
    }
    return this.syncHandle;
  }
}
