/**
 * opfs-fs.ts – an Emscripten filesystem backed by OPFS sync access handles.
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

// ---------------------------------------------------------------------------
// The subset of OPFS this needs
// ---------------------------------------------------------------------------

/**
 * `FileSystemSyncAccessHandle`, as much of it as is used here.
 *
 * Declared rather than imported: the DOM lib in this project's TypeScript
 * target does not carry it, and a hand-written interface says exactly which
 * four methods this depends on.
 */
interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface OpfsDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface OpfsFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
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

/**
 * Open — creating if needed — the sync access handle for one database.
 *
 * @throws if another handle on the same file is already open. OPFS enforces
 *   that exclusively, which is a stronger and more honest guarantee than the
 *   Web Lock the IndexedDB path uses: two tabs cannot both hold the file, and
 *   the second one is told so by the platform rather than by a convention.
 */
export async function openDatabaseHandle(name: string): Promise<SyncAccessHandle> {
  const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle;
  const dir = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
  const file = await dir.getFileHandle(`${name}.fdb`, { create: true });
  return file.createSyncAccessHandle();
}

/** Delete a database's file.  Fails silently when there is nothing to delete. */
export async function removeDatabaseFile(name: string): Promise<void> {
  const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle;
  const dir = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
  await dir.removeEntry(`${name}.fdb`).catch(() => undefined);
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
): void {
  const FS = mod.FS as unknown as EmscriptenFSInternals;

  // A scratch buffer, because the WASM heap is a SharedArrayBuffer under
  // pthreads and OPFS rejects views onto one. Grown as needed and reused, so
  // the cost is one copy per operation rather than one allocation.
  let scratch = new Uint8Array(65536);
  const scratchFor = (length: number): Uint8Array => {
    if (scratch.byteLength < length) {
      scratch = new Uint8Array(Math.max(length, scratch.byteLength * 2));
    }
    return scratch.subarray(0, length);
  };

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
    close(): void {
      // Deliberately not closed here. The handle outlives any single open —
      // Firebird opens and closes the database repeatedly within one session,
      // and reopening a sync access handle is both async and exclusive, so a
      // close here would make the next open fail.
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
      const handle = stream.node.handle!;
      const target = scratchFor(length);
      const read = handle.read(target, { at: position });
      if (read > 0) buffer.set(target.subarray(0, read), offset);
      return read;
    },
    write(
      stream: FSStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number {
      const handle = stream.node.handle!;
      const source = scratchFor(length);
      source.set(buffer.subarray(offset, offset + length));
      return handle.write(source, { at: position });
    },
  };

  const fileOps = {
    getattr(node: FSNode) {
      return attrs(node, node.handle!.getSize());
    },
    setattr(node: FSNode, attr: { mode?: number; timestamp?: number; size?: number }) {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
      if (attr.size !== undefined) node.handle!.truncate(attr.size);
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
    unlink(): void {
      throw new FS.ErrnoError(EPERM);
    },
    rmdir(): void {
      throw new FS.ErrnoError(EPERM);
    },
    readdir(node: FSNode): string[] {
      return ['.', '..', ...Object.keys(node.contents ?? {})];
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
  }
  FS.mount(filesystem, {}, mountpoint);
}
