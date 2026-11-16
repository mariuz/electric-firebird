/**
 * opfs-chunk-io.ts – Virtual filesystem & OPFS chunk I/O helpers for DirectTransport (`M22 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import {
  mountOpfs as mountOpfsFilesystem,
  openDatabaseHandle,
  opfsAvailable,
} from './opfs-fs';
import { OPFS_MOUNT } from './wasm-abi-types';

export interface OpfsSyncHandleLike {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export function fsMkdir(mod: FirebirdWasmModule, path: string): void {
  if (!mod.FS.analyzePath(path).exists) {
    mod.FS.mkdir(path);
  }
}

export function fsExists(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
): boolean {
  if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
    return opfsHandle.getSize() > 0;
  }
  return mod.FS.analyzePath(path).exists;
}

export function fsReadFile(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
): Uint8Array {
  if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
    const size = opfsHandle.getSize();
    const buf = new Uint8Array(size);
    if (size > 0) opfsHandle.read(buf, { at: 0 });
    return buf;
  }
  return mod.FS.readFile(path);
}

export function fsWriteFile(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
  data: Uint8Array,
): void {
  if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
    opfsHandle.truncate(data.byteLength);
    if (data.byteLength > 0) opfsHandle.write(data, { at: 0 });
    opfsHandle.flush();
    return;
  }
  mod.FS.writeFile(path, data);
}

export function fsFileSize(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
): number {
  if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
    return opfsHandle.getSize();
  }
  const fs = mod.FS;
  if (!fs.analyzePath(path).exists) {
    return 0;
  }
  return fs.stat(path).size;
}

export function fsReadFileChunk(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  if (length <= 0) return new Uint8Array(0);
  if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
    const size = opfsHandle.getSize();
    if (offset >= size) return new Uint8Array(0);
    const toRead = Math.min(length, size - offset);
    const buf = new Uint8Array(toRead);
    const n = opfsHandle.read(buf, { at: offset });
    return n === toRead ? buf : buf.slice(0, n);
  }

  const fs = mod.FS;
  if (
    typeof fs.open === 'function' &&
    typeof fs.read === 'function' &&
    typeof fs.close === 'function'
  ) {
    if (!fs.analyzePath(path).exists) return new Uint8Array(0);
    const size = fs.stat(path).size;
    if (offset >= size) return new Uint8Array(0);
    const toRead = Math.min(length, size - offset);
    const buf = new Uint8Array(toRead);
    const stream = fs.open(path, 'r');
    try {
      const n = fs.read(stream, buf, 0, toRead, offset);
      return n === toRead ? buf : buf.slice(0, n);
    } finally {
      fs.close(stream);
    }
  }

  const full = fs.readFile(path);
  if (offset >= full.byteLength) return new Uint8Array(0);
  return full.slice(offset, offset + length);
}

export function fsWriteFileChunk(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
  data: Uint8Array,
  offset: number,
  truncate = false,
): void {
  if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
    if (truncate) {
      opfsHandle.truncate(0);
    }
    if (data.byteLength > 0) {
      opfsHandle.write(data, { at: offset });
    }
    opfsHandle.flush();
    return;
  }

  const fs = mod.FS;
  if (
    typeof fs.open === 'function' &&
    typeof fs.write === 'function' &&
    typeof fs.close === 'function'
  ) {
    const exists = fs.analyzePath(path).exists;
    if (truncate && exists && typeof fs.truncate === 'function') {
      fs.truncate(path, 0);
    }
    const flags = !exists || truncate ? 'w+' : 'r+';
    const stream = fs.open(path, flags);
    try {
      if (data.byteLength > 0) {
        fs.write(stream, data, 0, data.byteLength, offset);
      }
    } finally {
      fs.close(stream);
    }
    return;
  }

  if (truncate || !fs.analyzePath(path).exists) {
    const out = new Uint8Array(offset + data.byteLength);
    out.set(data, offset);
    fs.writeFile(path, out);
    return;
  }

  const existing = fs.readFile(path);
  const nextLen = Math.max(existing.byteLength, offset + data.byteLength);
  const out =
    nextLen === existing.byteLength ? existing : new Uint8Array(nextLen);
  if (out !== existing) {
    out.set(existing, 0);
  }
  out.set(data, offset);
  fs.writeFile(path, out);
}

export function fsUnlink(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike | null,
  path: string,
): void {
  if (mod.FS.analyzePath(path).exists) {
    if (opfsHandle && path.startsWith(`${OPFS_MOUNT}/`)) {
      opfsHandle.truncate(0);
      opfsHandle.flush();
    }
    mod.FS.unlink(path);
  }
}

export async function mountOpfsDatabase(
  mod: FirebirdWasmModule,
  dbName: string,
): Promise<{ handle: OpfsSyncHandleLike; path: string }> {
  if (!opfsAvailable()) {
    throw new Error(
      'OPFS storage needs a Worker: FileSystemSyncAccessHandle is not ' +
        'available on a main thread, and Node has no OPFS at all. Pass a ' +
        '`worker` to FirebirdBrowser, or use an IndexedDB or memory:// database',
    );
  }

  const handle = await openDatabaseHandle(dbName);
  const fileName = `${dbName}.fdb`;
  mountOpfsFilesystem(mod, OPFS_MOUNT, new Map([[fileName, handle]]));
  return { handle, path: `${OPFS_MOUNT}/${fileName}` };
}

export function unmountOpfsDatabase(
  mod: FirebirdWasmModule,
  opfsHandle: OpfsSyncHandleLike,
): void {
  try {
    (mod.FS as unknown as { unmount(path: string): void }).unmount(OPFS_MOUNT);
  } catch {
    // not mounted any more
  }
  try {
    opfsHandle.close();
  } catch {
    // closed already
  }
}
