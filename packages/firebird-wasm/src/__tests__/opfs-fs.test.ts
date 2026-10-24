/**
 * opfs-fs.test.ts – zero-copy OPFS reads and writes on a plain ArrayBuffer
 * heap, and scratch-buffer fallback on a SharedArrayBuffer heap.
 */

import { mountOpfs } from '../browser/opfs-fs';
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
  };
  stream_ops: {
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
    mountOpfs(mod, '/opfs', new Map([['test.fdb', handle]]));

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
    expect( Array.from(fileBytes.subarray(8, 12)) ).toEqual([10, 20, 30, 40]);

    const readTarget = new Uint8Array(new ArrayBuffer(128));
    const read = fileNode.stream_ops.read!(stream, readTarget, 32, 4, 8);
    expect(read).toBe(4);
    // Zero-copy: the view handed to SyncAccessHandle.read is backed by the
    // caller's own ArrayBuffer, not a scratch buffer.
    expect(seenReadBuffers[0]).toBe(readTarget.buffer);
    expect(Array.from(readTarget.subarray(32, 36))).toEqual([10, 20, 30, 40]);
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
});
