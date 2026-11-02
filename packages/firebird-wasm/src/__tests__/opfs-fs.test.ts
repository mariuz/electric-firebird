/**
 * opfs-fs.test.ts – zero-copy OPFS reads and writes on a plain ArrayBuffer
 * heap, scratch-buffer fallback on a SharedArrayBuffer heap, fsync/unlink
 * lifecycle, and direct page-level OPFSVFS operations.
 */

import {
  mountOpfs,
  OPFSVFS,
  createMemorySyncAccessHandle,
  openDatabaseHandle,
  removeDatabaseFile,
} from '../browser/opfs-fs';
import type { OpfsDirectoryHandle } from '../browser/opfs-fs';
import type { FirebirdWasmModule } from '../wasm-loader';

interface FakeNode {
  id: number;
  mode: number;
  rdev: number;
  name: string;
  parent: FakeNode | null;
  timestamp: number;
  node_ops: {
    mknod?: (parent: FakeNode, name: string) => FakeNode;
    lookup?: (parent: FakeNode, name: string) => FakeNode;
    unlink?: (parent: FakeNode, name: string) => void;
    readdir?: (node: FakeNode) => string[];
    getattr?: (node: FakeNode) => { size: number };
    setattr?: (
      node: FakeNode,
      attr: { mode?: number; timestamp?: number; size?: number },
    ) => void;
  };
  stream_ops: {
    open?: (stream?: { node: FakeNode; position: number }) => void;
    close?: (stream?: { node: FakeNode; position: number }) => void;
    fsync?: (stream: { node: FakeNode; position: number }) => number;
    msync?: (stream: { node: FakeNode; position: number }) => number;
    llseek?: (
      stream: { node: FakeNode; position: number },
      offset: number,
      whence: number,
    ) => number;
    read?: (
      stream: { node: FakeNode; position: number },
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => number;
    write?: (
      stream: { node: FakeNode; position: number },
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => number;
  };
  contents?: Record<string, FakeNode>;
}

function createFakeModule(): {
  mod: FirebirdWasmModule;
  root: () => FakeNode;
} {
  let mountedRoot: FakeNode | null = null;
  let nextId = 1;

  class ErrnoError extends Error {
    constructor(public errno: number) {
      super(`Errno ${errno}`);
    }
  }

  const FS = {
    ErrnoError,
    createNode(parent: FakeNode | null, name: string, mode: number, dev: number): FakeNode {
      return {
        id: nextId++,
        mode,
        rdev: dev,
        name,
        parent,
        timestamp: 0,
        node_ops: {},
        stream_ops: {},
      };
    },
    isDir(mode: number): boolean {
      return (mode & 0o040000) !== 0;
    },
    analyzePath(): { exists: boolean } {
      return { exists: true };
    },
    mkdir(): void {},
    mount(type: { mount: () => FakeNode }): void {
      mountedRoot = type.mount();
    },
  };

  return {
    mod: { FS } as unknown as FirebirdWasmModule,
    root: () => {
      if (!mountedRoot) throw new Error('Filesystem was not mounted');
      return mountedRoot;
    },
  };
}

describe('mountOpfs', () => {
  it('reads and writes directly into a plain ArrayBuffer heap without copying', () => {
    const fileBytes = new Uint8Array(64);
    const seenReadBuffers: ArrayBufferLike[] = [];
    const seenWriteBuffers: ArrayBufferLike[] = [];

    const handle = {
      read(target: ArrayBufferView, options?: { at?: number }): number {
        seenReadBuffers.push(target.buffer);
        const pos = options?.at ?? 0;
        const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
        view.set(fileBytes.subarray(pos, pos + view.byteLength));
        return view.byteLength;
      },
      write(source: ArrayBufferView, options?: { at?: number }): number {
        seenWriteBuffers.push(source.buffer);
        const pos = options?.at ?? 0;
        const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        fileBytes.set(view, pos);
        return view.byteLength;
      },
      truncate(): void {},
      getSize(): number {
        return fileBytes.byteLength;
      },
      flush(): void {},
      close(): void {},
    };

    const { mod, root } = createFakeModule();
    const stats = mountOpfs(mod, '/opfs', new Map([['test.fdb', handle]]));

    const fileNode = root().node_ops.mknod!(root(), 'test.fdb');
    const stream = { node: fileNode, position: 0 };

    // A plain ArrayBuffer — what firebird-embedded-st (the default build) uses.
    const heap = new Uint8Array(new ArrayBuffer(128));
    heap.set([10, 20, 30, 40], 16);

    const written = fileNode.stream_ops.write!(stream, heap, 16, 4, 8);
    expect(written).toBe(4);
    // Zero-copy: the view handed to SyncAccessHandle.write is backed by the
    // caller's own ArrayBuffer, not a scratch buffer.
    expect(seenWriteBuffers[0]).toBe(heap.buffer);
    expect(Array.from(fileBytes.subarray(8, 12))).toEqual([10, 20, 30, 40]);

    const readTarget = new Uint8Array(new ArrayBuffer(128));
    const read = fileNode.stream_ops.read!(stream, readTarget, 32, 4, 8);
    expect(read).toBe(4);
    // Zero-copy: the view handed to SyncAccessHandle.read is backed by the
    // caller's own ArrayBuffer, not a scratch buffer.
    expect(seenReadBuffers[0]).toBe(readTarget.buffer);
    expect(Array.from(readTarget.subarray(32, 36))).toEqual([10, 20, 30, 40]);

    expect(stats.writes).toBe(1);
    expect(stats.bytesWritten).toBe(4);
    expect(stats.reads).toBe(1);
    expect(stats.bytesRead).toBe(4);
  });

  it('copies through a scratch buffer when the heap is a SharedArrayBuffer', () => {
    const fileBytes = new Uint8Array(64);
    const seenReadBuffers: ArrayBufferLike[] = [];
    const seenWriteBuffers: ArrayBufferLike[] = [];

    // Simulates browser FileSystemSyncAccessHandle, which throws TypeError
    // if given a view backed by a SharedArrayBuffer.
    const rejectShared = (view: ArrayBufferView): void => {
      if (view.buffer instanceof SharedArrayBuffer) {
        throw new TypeError('The provided ArrayBufferView value must not be shared.');
      }
    };

    const handle = {
      read(target: ArrayBufferView, options?: { at?: number }): number {
        rejectShared(target);
        seenReadBuffers.push(target.buffer);
        const pos = options?.at ?? 0;
        const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
        view.set(fileBytes.subarray(pos, pos + view.byteLength));
        return view.byteLength;
      },
      write(source: ArrayBufferView, options?: { at?: number }): number {
        rejectShared(source);
        seenWriteBuffers.push(source.buffer);
        const pos = options?.at ?? 0;
        const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        fileBytes.set(view, pos);
        return view.byteLength;
      },
      truncate(): void {},
      getSize(): number {
        return fileBytes.byteLength;
      },
      flush(): void {},
      close(): void {},
    };

    const { mod, root } = createFakeModule();
    mountOpfs(mod, '/opfs', new Map([['test.fdb', handle]]));

    const fileNode = root().node_ops.mknod!(root(), 'test.fdb');
    const stream = { node: fileNode, position: 0 };

    const sharedHeap = new Uint8Array(new SharedArrayBuffer(128));
    sharedHeap.set([99, 88, 77, 66], 24);

    const written = fileNode.stream_ops.write!(stream, sharedHeap, 24, 4, 12);
    expect(written).toBe(4);
    expect(seenWriteBuffers[0]).not.toBe(sharedHeap.buffer);
    expect(seenWriteBuffers[0]).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(fileBytes.subarray(12, 16))).toEqual([99, 88, 77, 66]);

    const sharedReadTarget = new Uint8Array(new SharedArrayBuffer(128));
    const read = fileNode.stream_ops.read!(stream, sharedReadTarget, 40, 4, 12);
    expect(read).toBe(4);
    expect(seenReadBuffers[0]).not.toBe(sharedReadTarget.buffer);
    expect(seenReadBuffers[0]).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(sharedReadTarget.subarray(40, 44))).toEqual([99, 88, 77, 66]);
  });

  it('supports fsync, msync, unlink, setattr truncate, and transform hooks', () => {
    const handle = createMemorySyncAccessHandle();
    const { mod, root } = createFakeModule();

    const stats = mountOpfs(mod, '/opfs', new Map([['test.fdb', handle]]), {
      transformWrite: (data) => data.map((b) => (b ^ 0x5a) & 0xff),
      transformRead: (data) => {
        for (let i = 0; i < data.length; i++) {
          data[i] = (data[i]! ^ 0x5a) & 0xff;
        }
      },
      flushOnClose: true,
    });

    // Unwritten handle reports ENOENT on lookup
    expect(() => root().node_ops.lookup!(root(), 'test.fdb')).toThrow(/Errno 44/);

    const fileNode = root().node_ops.mknod!(root(), 'test.fdb');
    const stream = { node: fileNode, position: 0 };

    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fileNode.stream_ops.write!(stream, src, 0, src.length, 0);
    expect(handle.getSize()).toBe(8);
    // Stored bytes in the handle are XOR-transformed
    expect(Array.from(handle.toUint8Array())).toEqual(
      Array.from(src.map((b) => b ^ 0x5a)),
    );

    const dst = new Uint8Array(8);
    fileNode.stream_ops.read!(stream, dst, 0, 8, 0);
    expect(Array.from(dst)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // fsync & msync flush the underlying SyncAccessHandle
    expect(fileNode.stream_ops.fsync!(stream)).toBe(0);
    expect(fileNode.stream_ops.msync!(stream)).toBe(0);
    fileNode.stream_ops.close!(stream);
    expect(handle.flushCount).toBe(3);
    expect(stats.flushes).toBe(3);

    // unlink truncates handle to 0, flushes, and removes node from directory
    root().node_ops.unlink!(root(), 'test.fdb');
    expect(handle.getSize()).toBe(0);
    expect(() => root().node_ops.lookup!(root(), 'test.fdb')).toThrow(/Errno 44/);
    expect(() => root().node_ops.unlink!(root(), 'other.fdb')).toThrow(/Errno 63/);
  });
});

describe('OPFSVFS', () => {
  it('performs page-level readPage, writePage, readRange, writeRange, exportDatabase, and importDatabase', async () => {
    const handle = createMemorySyncAccessHandle();
    const vfs = new OPFSVFS({ pageSize: 8192, handle });

    const meta = await vfs.open('opfs://analytics');
    expect(vfs.isOpen).toBe(true);
    expect(vfs.dbName).toBe('analytics');
    expect(meta.pageSize).toBe(8192);
    expect(meta.pageCount).toBe(0);

    // Out-of-bounds read returns null
    expect(await vfs.readPage(0)).toBeNull();

    // Write page 0 and page 2 (leaving page 1 zero-filled)
    const page0 = new Uint8Array(8192);
    page0.fill(0x11);
    const page2 = new Uint8Array(8192);
    page2.fill(0x33);

    await vfs.writePage(0, page0);
    await vfs.writePage(2, page2);

    const updatedMeta = await vfs.getMetadata();
    expect(updatedMeta?.pageCount).toBe(3);

    const read0 = await vfs.readPage(0);
    const read1 = await vfs.readPage(1);
    const read2 = await vfs.readPage(2);
    expect(read0?.[0]).toBe(0x11);
    expect(read1?.[0]).toBe(0x00);
    expect(read2?.[0]).toBe(0x33);

    // Range read & write
    await vfs.writeRange(100, new Uint8Array([9, 8, 7, 6]));
    const range = await vfs.readRange(100, 4);
    expect(Array.from(range)).toEqual([9, 8, 7, 6]);

    // Export & import full database image
    const exported = await vfs.exportDatabase();
    expect(exported.byteLength).toBe(3 * 8192);

    await vfs.clear();
    expect((await vfs.getMetadata())?.pageCount).toBe(0);

    await vfs.importDatabase(exported);
    expect((await vfs.getMetadata())?.pageCount).toBe(3);
    expect(Array.from(await vfs.readRange(100, 4))).toEqual([9, 8, 7, 6]);

    await vfs.sync();
    const stats = vfs.getStats();
    expect(stats.writes).toBeGreaterThanOrEqual(4);
    expect(stats.reads).toBeGreaterThanOrEqual(5);
    expect(stats.flushes).toBeGreaterThanOrEqual(3);

    await vfs.close();
    expect(vfs.isOpen).toBe(false);
  });

  it('opens and removes database files through a custom OpfsDirectoryHandle provider', async () => {
    const files = new Map<string, ReturnType<typeof createMemorySyncAccessHandle>>();
    const removed: string[] = [];

    const fakeDir: OpfsDirectoryHandle = {
      async getFileHandle(name: string) {
        let h = files.get(name);
        if (!h) {
          h = createMemorySyncAccessHandle();
          files.set(name, h);
        }
        return {
          async createSyncAccessHandle() {
            return h!;
          },
        };
      },
      async getDirectoryHandle() {
        return fakeDir;
      },
      async removeEntry(name: string) {
        removed.push(name);
        files.delete(name);
      },
    };

    const handle = await openDatabaseHandle('custom_db', 'firebird', async () => fakeDir);
    handle.write(new Uint8Array([1, 2, 3, 4]), { at: 0 });
    expect(handle.getSize()).toBe(4);

    await removeDatabaseFile('custom_db', 'firebird', async () => fakeDir);
    expect(removed).toEqual(['custom_db.fdb']);

    const vfs = new OPFSVFS({
      directoryName: 'firebird',
      getDirectory: async () => fakeDir,
    });
    await vfs.open('opfs://vfs_managed');
    await vfs.writeRange(0, new Uint8Array([10, 20, 30]));
    await vfs.destroy();
    expect(removed).toContain('vfs_managed.fdb');
  });
});
