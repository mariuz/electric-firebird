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
 * A special metadata record with key `__meta__` stores the page size and the
 * total number of pages.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata record persisted alongside the page data. */
export interface VFSMetadata {
  /** Page size in bytes (Firebird default is usually 8 192). */
  pageSize: number;
  /** Total number of pages currently stored. */
  pageCount: number;
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 8192;
const DEFAULT_PREFIX = 'firebird_';
const STORE_NAME = 'pages';
const META_KEY = '__meta__';

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
  private db: IDBDatabase | null = null;
  private dbName = '';

  constructor(options: IndexedDBVFSOptions = {}) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
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

    this.dbName = dbName;
    const idbName = `${this.prefix}${dbName}`;

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(idbName, 1);

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
    if (record) return record.data;
    return new ArrayBuffer(this.pageSize);
  }

  /** Write a page (full page overwrite). */
  async writePage(pageNumber: number, data: ArrayBuffer): Promise<void> {
    if (data.byteLength !== this.pageSize) {
      throw new RangeError(
        `Page data must be exactly ${this.pageSize} bytes (got ${data.byteLength})`,
      );
    }
    await this.idbPut(pageNumber, { data });
    await this.updateMeta(pageNumber);
  }

  /** Read the stored metadata, or return defaults if none exists. */
  async getMetadata(): Promise<VFSMetadata> {
    const meta = await this.idbGet<VFSMetadata>(META_KEY);
    return meta ?? { pageSize: this.pageSize, pageCount: 0 };
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
   */
  async importDatabase(data: Uint8Array): Promise<void> {
    if (data.byteLength % this.pageSize !== 0) {
      throw new RangeError(
        `Database size (${data.byteLength}) is not a multiple of page size (${this.pageSize})`,
      );
    }

    const pageCount = data.byteLength / this.pageSize;

    // Clear existing data
    await this.clear();

    // Write pages
    for (let i = 0; i < pageCount; i++) {
      const offset = i * this.pageSize;
      const page = data.slice(offset, offset + this.pageSize).buffer;
      await this.idbPut(i, { data: page });
    }

    // Update metadata
    await this.idbPut(META_KEY, { pageSize: this.pageSize, pageCount });
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
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(idbName);
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
    if (newCount !== meta.pageCount) {
      await this.idbPut(META_KEY, { pageSize: this.pageSize, pageCount: newCount });
    }
  }
}
