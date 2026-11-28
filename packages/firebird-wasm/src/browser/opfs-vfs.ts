/**
 * opfs-vfs.ts – Direct Page-Level Origin Private File System (`OPFSVFS`)
 * Virtual File System (`M30 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import type { VFSMetadata } from './indexeddb-vfs';
import type { PageEncryptionKey } from './page-crypto';
import {
  ENCRYPTED_PAGE_OVERHEAD,
  decryptPage,
  encryptPage,
  isEncryptedPageBuffer,
  resolveCryptoKey,
} from './page-crypto';
import {
  CowSnapshotStore,
  type DatabaseSnapshot,
  type DatabaseSnapshotInfo,
  type SnapshotOptions,
} from './snapshots';
import {
  mountOpfs,
  openDatabaseHandle,
  removeDatabaseFile,
  type MountOpfsOptions,
  type OpfsDirectoryHandle,
  type OpfsMountStats,
  type SyncAccessHandle,
} from './opfs-fs';

const OPFS_DIRECTORY = 'firebird';
const DEFAULT_PAGE_SIZE = 8192;

function normalizeVfsFileName(name: string): string {
  const trimmed = name.trim().replace(/^opfs:\/\//i, '');
  return trimmed.endsWith('.fdb') ? trimmed : `${trimmed}.fdb`;
}

/** Configuration options for {@link OPFSVFS}. */
export interface OPFSVFSOptions {
  directoryName?: string;
  pageSize?: number;
  handle?: SyncAccessHandle;
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
  encryptionKey?: PageEncryptionKey;
}

/**
 * Direct page-level Origin Private File System (OPFS) Virtual File System.
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
  private readonly stats: OpfsMountStats = {
    reads: 0,
    writes: 0,
    flushes: 0,
    truncates: 0,
    bytesRead: 0,
    bytesWritten: 0,
  };
  private readonly snapshotStore: CowSnapshotStore;

  constructor(options: OPFSVFSOptions = {}) {
    this.directoryName = options.directoryName ?? OPFS_DIRECTORY;
    this.configuredPageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.providedHandle = options.handle;
    this.getDirectory = options.getDirectory;
    this.encryptionKey = options.encryptionKey;
    this.snapshotStore = new CowSnapshotStore(this.configuredPageSize);
  }

  get isEncrypted(): boolean {
    return this.encryptionKey !== undefined;
  }

  get isOpen(): boolean {
    return this.syncHandle !== null;
  }

  get pageSize(): number {
    return this.configuredPageSize;
  }

  get handle(): SyncAccessHandle | null {
    return this.syncHandle;
  }

  get dbName(): string | null {
    return this.currentDbName;
  }

  async open(dbName: string): Promise<VFSMetadata> {
    if (this.syncHandle) return (await this.getMetadata())!;
    if (this.encryptionKey) await resolveCryptoKey(this.encryptionKey);

    const cleanName = dbName.trim().replace(/^opfs:\/\//i, '').replace(/\.fdb$/i, '') || 'database';
    if (this.providedHandle) {
      this.syncHandle = this.providedHandle;
      this.ownsHandle = false;
    } else {
      this.syncHandle = await openDatabaseHandle(cleanName, this.directoryName, this.getDirectory);
      this.ownsHandle = true;
    }
    this.currentDbName = cleanName;
    return (await this.getMetadata())!;
  }

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
    if (!this.syncHandle || this.syncHandle.getSize() < ENCRYPTED_PAGE_OVERHEAD) return false;
    const probe = new Uint8Array(ENCRYPTED_PAGE_OVERHEAD);
    this.syncHandle.read(probe, { at: 0 });
    return isEncryptedPageBuffer(probe);
  }

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

  async readPage(pageNumber: number): Promise<Uint8Array | null> {
    const handle = this.requireHandle();
    if (!Number.isInteger(pageNumber) || pageNumber < 0) {
      throw new RangeError(`Invalid pageNumber: ${pageNumber}`);
    }
    const encrypted = Boolean(this.encryptionKey) || this.hasEncryptedHeader();
    if (encrypted) {
      const slotSize = this.configuredPageSize + ENCRYPTED_PAGE_OVERHEAD;
      const offset = pageNumber * slotSize;
      if (offset >= handle.getSize()) return null;

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
        return decryptPage(slot, this.encryptionKey, pageNumber, this.configuredPageSize);
      }

      let allZero = true;
      for (let i = 0; i < slot.byteLength; i++) {
        if (slot[i] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) return new Uint8Array(this.configuredPageSize);
      if (!this.encryptionKey) return slot.subarray(0, this.configuredPageSize);
      return decryptPage(slot, this.encryptionKey, pageNumber, this.configuredPageSize);
    }

    const offset = pageNumber * this.configuredPageSize;
    if (offset >= handle.getSize()) return null;

    const buf = new Uint8Array(this.configuredPageSize);
    const n = handle.read(buf, { at: offset });
    this.stats.reads += 1;
    if (n <= 0) return null;
    this.stats.bytesRead += n;
    return buf;
  }

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
      const envelope = await encryptPage(
        data,
        this.encryptionKey,
        pageNumber,
        this.configuredPageSize,
      );
      const written = handle.write(envelope, { at: pageNumber * slotSize });
      this.stats.writes += 1;
      if (written > 0) this.stats.bytesWritten += written;
      return;
    }
    const written = handle.write(data, { at: pageNumber * this.configuredPageSize });
    this.stats.writes += 1;
    if (written > 0) this.stats.bytesWritten += written;
  }

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

  async writeRange(offset: number, data: Uint8Array, truncate = false): Promise<void> {
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

  async exportDatabase(): Promise<Uint8Array> {
    const handle = this.requireHandle();
    const size = handle.getSize();
    if (size === 0) return new Uint8Array(0);
    if (this.encryptionKey || this.hasEncryptedHeader()) {
      const meta = (await this.getMetadata())!;
      const out = new Uint8Array(meta.pageCount * this.configuredPageSize);
      for (let i = 0; i < meta.pageCount; i++) {
        const page = await this.readPage(i);
        if (page) out.set(page, i * this.configuredPageSize);
      }
      return out;
    }
    const out = new Uint8Array(size);
    const n = handle.read(out, { at: 0 });
    this.stats.reads += 1;
    if (n > 0) this.stats.bytesRead += n;
    return n === size ? out : out.slice(0, Math.max(0, n));
  }

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

  async sync(): Promise<void> {
    this.requireHandle().flush();
    this.stats.flushes += 1;
  }

  async clear(): Promise<void> {
    const handle = this.requireHandle();
    handle.truncate(0);
    handle.flush();
    this.stats.truncates += 1;
    this.stats.flushes += 1;
  }

  async destroy(): Promise<void> {
    const dbName = this.currentDbName;
    const shouldRemove = this.ownsHandle;
    await this.close();
    if (dbName && shouldRemove) {
      await removeDatabaseFile(dbName, this.directoryName, this.getDirectory);
    }
  }

  mount(
    mod: FirebirdWasmModule,
    mountpoint = '/opfs',
    options: Omit<MountOpfsOptions, 'stats'> = {},
  ): { dbPath: string; stats: OpfsMountStats } {
    const handle = this.requireHandle();
    const fileName = normalizeVfsFileName(this.currentDbName ?? 'database');
    mountOpfs(mod, mountpoint, new Map([[fileName, handle]]), {
      ...options,
      stats: this.stats,
    });
    return {
      dbPath: `${mountpoint.replace(/\/+$/, '')}/${fileName}`,
      stats: this.stats,
    };
  }

  getStats(): OpfsMountStats {
    return { ...this.stats };
  }

  async snapshot(labelOrOptions?: string | SnapshotOptions): Promise<DatabaseSnapshot> {
    const image = await this.exportDatabase();
    return this.snapshotStore.createSnapshot(image, labelOrOptions);
  }

  async restoreSnapshot(snapshotOrId: DatabaseSnapshot | string | Uint8Array): Promise<void> {
    const bytes =
      snapshotOrId instanceof Uint8Array
        ? snapshotOrId
        : this.snapshotStore.getSnapshot(snapshotOrId).toUint8Array();
    await this.importDatabase(bytes);
  }

  listSnapshots(): DatabaseSnapshotInfo[] {
    return this.snapshotStore.listSnapshots();
  }

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
