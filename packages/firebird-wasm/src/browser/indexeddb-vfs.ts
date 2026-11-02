/**
 * indexeddb-vfs.ts – IndexedDB-backed virtual filesystem for Firebird WASM.
 *
 * Provides page-level persistence so that a Firebird database running inside
 * the browser WASM sandbox can survive page reloads.  The API mirrors the
 * operations that Emscripten's IDBFS performs, but is designed to be used
 * directly as a persistence layer plugged into the Firebird WASM wrapper.
 *
 * ## Storage model
 *
 * Each database is stored in its own IndexedDB database and a single object
 * store named `pages`.  Every record stores a fixed-size page of the database
 * file, keyed by zero-based page number.
 *
 *   key (pageNumber: number) → value ({ data: ArrayBuffer })
 *
 * When `encryptionKey` is configured, each page is encrypted with WebCrypto
 * AES-GCM (`"FBE1"` envelope with 96-bit random IV, 128-bit authentication tag,
 * and `(pageNumber, pageSize)` AAD) before being stored in IndexedDB.
 *
 * A special metadata record with key `__meta__` stores the page size and the
 * total number of pages.
 */

import type { PageEncryptionKey } from './page-crypto';
import {
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
// Public types
// ---------------------------------------------------------------------------

/** Metadata record persisted alongside the page data. */
export interface VFSMetadata {
  /** Page size in bytes (Firebird default is usually 8 192). */
  pageSize: number;
  /** Total number of pages currently stored. */
  pageCount: number;
  /** Whether pages are encrypted at rest with AES-GCM. */
  encrypted?: boolean;
}

/** Options for creating an {@link IndexedDBVFS} instance. */
export interface IndexedDBVFSOptions {
  /**
   * Page size in bytes.  Must match the Firebird database page size.
   * @default 8192
   */
  pageSize?: number;
  /**
   * IndexedDB database name prefix.  The actual database name is
   * `${prefix}${dbName}`.
   * @default 'firebird_'
   */
  prefix?: string;
  /**
   * Optional WebCrypto AES-GCM key (`CryptoKey` or 16/32-byte `Uint8Array` /
   * `ArrayBuffer`) used to encrypt 8 KB database pages at rest in IndexedDB.
   */
  encryptionKey?: PageEncryptionKey;
  /**
   * Optional custom `IDBFactory` (defaults to global `indexedDB`), useful for
   * testing or custom IndexedDB implementations.
   */
  indexedDB?: IDBFactory;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 8192;
const DEFAULT_PREFIX = 'firebird_';
const STORE_NAME = 'pages';
const META_KEY = '__meta__';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exact byte equality.  Used to decide whether a page needs rewriting. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * IndexedDB-backed virtual filesystem for a single Firebird database.
 *
 * @example
 * ```ts
 * const vfs = new IndexedDBVFS({ pageSize: 8192 });
 * await vfs.open('mydb');
 *
 * // Write the first page
 * await vfs.writePage(0, someArrayBuffer);
 *
 * // Read it back
 * const page = await vfs.readPage(0);
 *
 * // Persist all pending writes
 * await vfs.sync();
 *
 * await vfs.close();
 * ```
 */
export class IndexedDBVFS {
  private readonly pageSize: number;
  private readonly prefix: string;
  private readonly encryptionKey?: PageEncryptionKey;
  private readonly idbFactory?: IDBFactory;
  private db: IDBDatabase | null = null;
  private dbName = '';
  /** Cached plaintext pages for encrypted mode so unchanged pages are not re-encrypted on persist. */
  private readonly plainPageCache = new Map<number, Uint8Array>();
  /** Copy-on-write page snapshot store for this VFS. */
  private readonly snapshotStore: CowSnapshotStore;

  constructor(options: IndexedDBVFSOptions = {}) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.encryptionKey = options.encryptionKey;
    this.idbFactory = options.indexedDB;
    this.snapshotStore = new CowSnapshotStore(this.pageSize);
  }

  /** Whether this VFS instance is configured to encrypt pages at rest. */
  get isEncrypted(): boolean {
    return this.encryptionKey !== undefined;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Open (or create) the IndexedDB store for `dbName`.
   * Must be called before any read/write operations.
   */
  async open(dbName: string): Promise<void> {
    if (this.db) {
      throw new Error(`IndexedDBVFS already open for "${this.dbName}"`);
    }

    if (this.encryptionKey) {
      // Validate key upfront on open() rather than failing mid-write.
      await resolveCryptoKey(this.encryptionKey);
    }

    this.dbName = dbName;
    const idbName = `${this.prefix}${dbName}`;
    const factory = this.idbFactory ?? indexedDB;

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(idbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Close the underlying IndexedDB connection. */
  async close(): Promise<void> {
    this.plainPageCache.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── Page I/O ──────────────────────────────────────────────────────────

  /**
   * Read a page by its zero-based number.
   * Returns a zero-filled buffer if the page has not been written yet.
   */
  async readPage(pageNumber: number): Promise<ArrayBuffer> {
    const record = await this.idbGet<{ data: ArrayBuffer }>(pageNumber);
    if (!record) {
      return new ArrayBuffer(this.pageSize);
    }

    const storedBytes = new Uint8Array(record.data);
    if (isEncryptedPageBuffer(storedBytes)) {
      if (!this.encryptionKey) {
        throw new Error(
          `Database page ${pageNumber} is encrypted at rest, but no encryptionKey was provided to IndexedDBVFS`,
        );
      }
      const decrypted = await decryptPage(
        storedBytes,
        this.encryptionKey,
        pageNumber,
        this.pageSize,
      );
      this.plainPageCache.set(pageNumber, decrypted.slice());
      return decrypted.slice().buffer as ArrayBuffer;
    }

    if (this.encryptionKey) {
      this.plainPageCache.set(pageNumber, storedBytes.slice());
    }
    return record.data;
  }

  /** Write a page (full page overwrite). */
  async writePage(pageNumber: number, data: ArrayBuffer | Uint8Array): Promise<void> {
    const plain =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
    if (plain.byteLength !== this.pageSize) {
      throw new RangeError(
        `Page data must be exactly ${this.pageSize} bytes (got ${plain.byteLength})`,
      );
    }

    if (this.encryptionKey) {
      const envelope = await encryptPage(
        plain,
        this.encryptionKey,
        pageNumber,
        this.pageSize,
      );
      this.plainPageCache.set(pageNumber, plain.slice());
      await this.idbPut(pageNumber, {
        data: envelope.slice().buffer as ArrayBuffer,
        encrypted: true,
      });
    } else {
      await this.idbPut(pageNumber, {
        data: plain.slice().buffer as ArrayBuffer,
      });
    }
    await this.updateMeta(pageNumber);
  }

  /** Read the stored metadata, or return defaults if none exists. */
  async getMetadata(): Promise<VFSMetadata> {
    const meta = await this.idbGet<VFSMetadata>(META_KEY);
    return (
      meta ?? {
        pageSize: this.pageSize,
        pageCount: 0,
        ...(this.encryptionKey ? { encrypted: true } : {}),
      }
    );
  }

  /**
   * Read the full database as a contiguous `Uint8Array`.
   * Useful for exporting/downloading a database snapshot.
   */
  async exportDatabase(): Promise<Uint8Array> {
    const meta = await this.getMetadata();
    const totalBytes = meta.pageCount * meta.pageSize;
    const output = new Uint8Array(totalBytes);

    for (let i = 0; i < meta.pageCount; i++) {
      const page = await this.readPage(i);
      output.set(new Uint8Array(page), i * meta.pageSize);
    }

    return output;
  }

  /**
   * Import a full database image, replacing any existing content.
   * The `data` length must be a multiple of `pageSize`.
   *
   * The whole import runs in **one** IndexedDB transaction, and only pages
   * whose contents actually changed are written.
   *
   * Both matter.  A transaction per page — which is what this used to do — is
   * not atomic: a tab closed midway through leaves some pages new and some
   * old, which is a corrupt database with no way back.  IndexedDB guarantees a
   * transaction is all-or-nothing, so an interrupted persist now leaves the
   * previous image intact.  Skipping unchanged pages then turns the common
   * case (a few pages dirty in a large database) from O(database) into
   * O(changes).
   *
   * Pages are compared against what is already stored rather than against an
   * in-memory copy: the comparison is exact, and it costs no extra memory
   * proportional to the database.
   */
  async importDatabase(data: Uint8Array): Promise<void> {
    if (data.byteLength % this.pageSize !== 0) {
      throw new RangeError(
        `Database size (${data.byteLength}) is not a multiple of page size (${this.pageSize})`,
      );
    }

    const pageCount = data.byteLength / this.pageSize;
    const db = this.requireDb();

    if (this.encryptionKey) {
      // Pre-encrypt dirty pages outside the IDB transaction so async WebCrypto
      // calls never cause IndexedDB to auto-commit an open transaction.
      const dirtyEncrypted = new Map<number, ArrayBuffer>();
      for (let i = 0; i < pageCount; i++) {
        const offset = i * this.pageSize;
        const page = data.subarray(offset, offset + this.pageSize);
        const cached = this.plainPageCache.get(i);
        if (cached && sameBytes(cached, page)) {
          continue;
        }
        const envelope = await encryptPage(
          page,
          this.encryptionKey,
          i,
          this.pageSize,
        );
        dirtyEncrypted.set(i, envelope.slice().buffer as ArrayBuffer);
        this.plainPageCache.set(i, page.slice());
      }
      for (const k of [...this.plainPageCache.keys()]) {
        if (k >= pageCount) this.plainPageCache.delete(k);
      }

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));

        const metaRequest = store.get(META_KEY);
        metaRequest.onsuccess = () => {
          const previous =
            (metaRequest.result as VFSMetadata | undefined)?.pageCount ?? 0;
          for (let i = pageCount; i < previous; i++) {
            store.delete(i);
          }
        };

        for (const [pageNumber, encryptedBuffer] of dirtyEncrypted) {
          store.put({ data: encryptedBuffer, encrypted: true }, pageNumber);
        }

        store.put(
          { pageSize: this.pageSize, pageCount, encrypted: true },
          META_KEY,
        );
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // Resolve on the transaction, not on the last request: only completion
      // means the changes are durable.
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted'));

      // Previous size, so pages past the new end can be removed.
      const metaRequest = store.get(META_KEY);
      metaRequest.onsuccess = () => {
        const previous = (metaRequest.result as VFSMetadata | undefined)?.pageCount ?? 0;
        for (let i = pageCount; i < previous; i++) {
          store.delete(i);
        }
      };

      for (let i = 0; i < pageCount; i++) {
        const offset = i * this.pageSize;
        const page = data.subarray(offset, offset + this.pageSize);

        const existing = store.get(i);
        existing.onsuccess = () => {
          const stored = (existing.result as { data: ArrayBuffer } | undefined)?.data;
          if (stored && sameBytes(new Uint8Array(stored), page)) {
            return; // unchanged
          }
          // slice() copies: `page` is a view onto the caller's buffer, which
          // must not be captured by the store.
          store.put({ data: page.slice().buffer }, i);
        };
      }

      store.put({ pageSize: this.pageSize, pageCount }, META_KEY);
    });
  }

  /**
   * Inspect the raw stored bytes for a page in IndexedDB without decrypting.
   * Useful for diagnostics and verifying at-rest encryption.
   */
  async readRawPage(pageNumber: number): Promise<Uint8Array | null> {
    const record = await this.idbGet<{ data: ArrayBuffer }>(pageNumber);
    if (!record) return null;
    return new Uint8Array(record.data.slice(0));
  }

  /**
   * Capture a lightweight copy-on-write page snapshot of the current database
   * state stored in IndexedDB.
   */
  async snapshot(
    labelOrOptions?: string | SnapshotOptions,
  ): Promise<DatabaseSnapshot> {
    const image = await this.exportDatabase();
    return this.snapshotStore.createSnapshot(image, labelOrOptions);
  }

  /**
   * Restore the IndexedDB store to a previously captured point-in-time
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

  /**
   * Flush – a no-op for IndexedDB since each `put` is already durable once
   * the transaction completes.  Provided for API symmetry.
   */
  async sync(): Promise<void> {
    // IndexedDB writes are durable after the transaction completes.
  }

  /** Delete all stored pages and metadata for this database. */
  async clear(): Promise<void> {
    this.plainPageCache.clear();
    const db = this.requireDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /** Delete the entire IndexedDB database. */
  async destroy(): Promise<void> {
    const idbName = `${this.prefix}${this.dbName}`;
    const factory = this.idbFactory ?? indexedDB;
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(idbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ── Emscripten FS integration ─────────────────────────────────────────

  /**
   * Synchronise pages between Emscripten's in-memory FS and IndexedDB.
   *
   * @param direction - `'persist'` writes MEMFS → IndexedDB,
   *                    `'populate'` reads IndexedDB → MEMFS.
   * @param readFile  - Callback to read a file from Emscripten's FS.
   * @param writeFile - Callback to write a file into Emscripten's FS.
   * @param dbPath    - The virtual path of the database in Emscripten's FS.
   */
  async syncWithEmscriptenFS(
    direction: 'persist' | 'populate',
    readFile: (path: string) => Uint8Array,
    writeFile: (path: string, data: Uint8Array) => void,
    dbPath: string,
  ): Promise<void> {
    if (direction === 'persist') {
      const data = readFile(dbPath);
      await this.importDatabase(data);
    } else {
      const data = await this.exportDatabase();
      if (data.byteLength > 0) {
        writeFile(dbPath, data);
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private requireDb(): IDBDatabase {
    if (!this.db) {
      throw new Error('IndexedDBVFS is not open. Call open() first.');
    }
    return this.db;
  }

  private idbGet<T>(key: IDBValidKey): Promise<T | undefined> {
    const db = this.requireDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  private idbPut(key: IDBValidKey, value: unknown): Promise<void> {
    const db = this.requireDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async updateMeta(latestPageNumber: number): Promise<void> {
    const meta = await this.getMetadata();
    const newCount = Math.max(meta.pageCount, latestPageNumber + 1);
    if (newCount !== meta.pageCount || (this.encryptionKey && !meta.encrypted)) {
      await this.idbPut(META_KEY, {
        pageSize: this.pageSize,
        pageCount: newCount,
        ...(this.encryptionKey ? { encrypted: true } : {}),
      });
    }
  }
}
