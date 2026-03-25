# API Reference

This page documents every public symbol exported by the `firebird-wasm` package.

---

## `firebird-wasm` (Node.js entry point)

```ts
import { FirebirdLite, FirebirdTransaction } from 'firebird-wasm';
```

---

### `FirebirdLite`

A PGlite-style wrapper around the Firebird embedded engine for Node.js.

```ts
class FirebirdLite {
  constructor(dbPath: string, options?: FirebirdLiteOptions)

  exec(sql: string): Promise<void>
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: TransactionOptions,
  ): Promise<QueryResult<T>>
  transaction<T>(
    fn: (tx: FirebirdTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>
  close(): Promise<void>
}
```

#### `new FirebirdLite(dbPath, options?)`

Create a new database handle.  The connection is opened lazily on the first
call to `exec()`, `query()`, or `transaction()`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dbPath` | `string` | — | Database path.  For a Firebird server use `host:/path/to/db.fdb`.  For embedded mode use an absolute file path, e.g. `/tmp/my.fdb`. |
| `options.username` | `string` | `'SYSDBA'` | Firebird user name. |
| `options.password` | `string` | — | Firebird user password. |
| `options.libraryPath` | `string` | system default | Override the path to `libfbclient.so` / `fbclient.dll`. |
| `options.charset` | `string` | — | Character set for `NONE`-charset columns (passed as `charSetForNONE`). |

If the database file does not exist it is created automatically.

#### `db.exec(sql)`

Execute a DDL or DML statement in its own auto-committed transaction.  Returns
`Promise<void>`.

```ts
await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.exec("INSERT INTO items VALUES (1, 'hello')");
```

#### `db.query<T>(sql, params?, options?)`

Execute a (parameterised) SQL statement and return the result.

```ts
const result = await db.query<{ ID: number; NAME: string }>(
  'SELECT id, name FROM items WHERE id = ?',
  [1],
);
// result.rows  → [{ ID: 1, NAME: 'hello' }]
// result.fields → [{ name: 'ID' }, { name: 'NAME' }]
```

Row keys are always **upper-cased** column names (or aliases).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sql` | `string` | — | SQL statement. |
| `params` | `QueryParams` | `[]` | Positional bind parameters (`?` placeholders). |
| `options.isolationLevel` | `IsolationLevel` | engine default | Transaction isolation. |
| `options.readOnly` | `boolean` | `false` | Open a read-only transaction. |

Returns `Promise<QueryResult<T>>`.

#### `db.transaction(fn, options?)`

Run an async callback inside an explicit transaction.  The transaction is
committed on success and rolled back if `fn` throws.

```ts
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO items VALUES (?, ?)', [2, 'world']);
  const { rows } = await tx.query('SELECT COUNT(*) AS CNT FROM items');
  console.log(rows[0].CNT); // 2
});
```

Returns `Promise<T>` where `T` is the return value of `fn`.

#### `db.close()`

Disconnect from the database and release all resources.  Subsequent calls are
a no-op.  Returns `Promise<void>`.

---

### `FirebirdTransaction`

A handle to an active transaction, passed to the callback of
`FirebirdLite.transaction()`.

```ts
class FirebirdTransaction {
  exec(sql: string, params?: QueryParams): Promise<void>
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>
}
```

#### `tx.exec(sql, params?)`

Execute a DDL or DML statement inside the active transaction.

#### `tx.query<T>(sql, params?)`

Execute a SELECT statement inside the active transaction and return rows.

---

## `firebird-wasm/browser` (Browser entry point)

```ts
import { FirebirdBrowser, FirebirdBrowserTransaction } from 'firebird-wasm/browser';
```

---

### `FirebirdBrowser`

A browser-compatible Firebird database backed by the WASM engine and an
IndexedDB-based virtual filesystem.

```ts
class FirebirdBrowser {
  constructor(dbName: string, options?: FirebirdBrowserOptions)

  exec(sql: string): Promise<void>
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: TransactionOptions,
  ): Promise<QueryResult<T>>
  transaction<T>(
    fn: (tx: FirebirdBrowserTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>
  persist(): Promise<void>
  close(): Promise<void>
}
```

#### `new FirebirdBrowser(dbName, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dbName` | `string` | — | Logical database name.  Used as the IndexedDB store name and virtual FS filename. |
| `options.wasmBinary` | `ArrayBuffer \| string` | — | WASM binary or URL to `firebird-embedded.wasm`. |
| `options.locateFile` | `(filename: string) => string` | — | Emscripten `locateFile` callback for resolving WASM artefacts. |
| `options.vfs.pageSize` | `number` | `8192` | Firebird page size in bytes. Must match the database. |
| `options.vfs.prefix` | `string` | `'firebird_'` | IndexedDB database name prefix. |

#### `db.persist()`

Flush the in-memory Emscripten FS to IndexedDB.  Call this periodically or
before the page unloads to avoid data loss.

```ts
window.addEventListener('beforeunload', () => db.persist());
```

> **Note:** `FirebirdBrowser.query()` does not yet support parameterised
> queries.  Parameters will be supported once the C API wrapper exposes
> `_fb_query_params`.

---

### `FirebirdBrowserTransaction`

Returned by `FirebirdBrowser.transaction()`.  Mirrors `FirebirdTransaction`.

```ts
class FirebirdBrowserTransaction {
  exec(sql: string): Promise<void>
  query<T extends Row = Row>(sql: string): Promise<QueryResult<T>>
}
```

---

### `IndexedDBVFS`

Low-level IndexedDB virtual filesystem.  Normally you do not need to use this
directly — `FirebirdBrowser` manages it automatically.

```ts
class IndexedDBVFS {
  constructor(options?: IndexedDBVFSOptions)

  open(dbName: string): Promise<void>
  close(): Promise<void>

  readPage(pageNumber: number): Promise<ArrayBuffer>
  writePage(pageNumber: number, data: ArrayBuffer): Promise<void>
  getMetadata(): Promise<VFSMetadata>
  exportDatabase(): Promise<Uint8Array>
  importDatabase(data: Uint8Array): Promise<void>
  sync(): Promise<void>
  clear(): Promise<void>
  destroy(): Promise<void>

  syncWithEmscriptenFS(
    direction: 'persist' | 'populate',
    readFile: (path: string) => Uint8Array,
    writeFile: (path: string, data: Uint8Array) => void,
    dbPath: string,
  ): Promise<void>
}
```

---

### `loadFirebirdWasm(options?)`

Load and initialise the Firebird Embedded WASM module.  The result is cached —
subsequent calls return the same instance.

Both the Node.js and browser entry points export this function:

```ts
// From the browser entry point (most common usage)
import { loadFirebirdWasm, allocString } from 'firebird-wasm/browser';

// Also available from the main entry point
import { loadFirebirdWasm, allocString } from 'firebird-wasm';

const mod = await loadFirebirdWasm();
mod._fb_init();
const ptr = allocString(mod, '/data/test.fdb');
const handle = mod._fb_create_database(ptr);
mod._free(ptr);
```

### `allocString(mod, str)`

Allocate a null-terminated UTF-8 string on the WASM heap.  The caller must
call `mod._free(ptr)` to avoid a memory leak.

---

## Types

### `FirebirdLiteOptions`

```ts
interface FirebirdLiteOptions {
  libraryPath?: string;
  charset?: string;
  username?: string;
  password?: string;
}
```

### `QueryResult<T>`

```ts
interface QueryResult<T = Row> {
  rows: T[];
  fields: FieldInfo[];
  affectedRows?: number;
}
```

### `FieldInfo`

```ts
interface FieldInfo {
  /** Column name (upper-cased). */
  name: string;
}
```

### `Row`

```ts
type Row = Record<string, unknown>;
```

### `QueryParams`

```ts
type QueryParams = unknown[];
```

### `IsolationLevel`

```ts
type IsolationLevel =
  | 'READ_COMMITTED'        // Latest committed version, visible during transaction
  | 'SNAPSHOT'              // Point-in-time view from transaction start (Firebird default)
  | 'SNAPSHOT_TABLE_STABILITY'; // Shared table locks (mapped to Firebird CONSISTENCY)
```

### `TransactionOptions`

```ts
interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}
```

### `FirebirdBrowserOptions`

```ts
interface FirebirdBrowserOptions {
  vfs?: IndexedDBVFSOptions;
  wasmBinary?: ArrayBuffer | string;
  locateFile?: (filename: string) => string;
}
```

### `IndexedDBVFSOptions`

```ts
interface IndexedDBVFSOptions {
  pageSize?: number;  // default: 8192
  prefix?: string;    // default: 'firebird_'
}
```

### `VFSMetadata`

```ts
interface VFSMetadata {
  pageSize: number;
  pageCount: number;
}
```

### `FirebirdWasmModule`

The typed interface for the Emscripten-compiled Firebird module (returned by
`loadFirebirdWasm()`).

```ts
interface FirebirdWasmModule {
  _fb_init(): number;
  _fb_create_database(pathPtr: number): FbHandle;
  _fb_attach_database(pathPtr: number): FbHandle;
  _fb_detach_database(handle: FbHandle): number;
  _fb_execute(handle: FbHandle, sqlPtr: number): number;
  _fb_query(handle: FbHandle, sqlPtr: number): number;
  _fb_free_result(resultPtr: number): void;
  _fb_start_transaction(handle: FbHandle): FbHandle;
  _fb_commit(txHandle: FbHandle): number;
  _fb_rollback(txHandle: FbHandle): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  UTF8ToString(ptr: number, maxLength?: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
  lengthBytesUTF8(str: string): number;
  FS: EmscriptenFS;
  MEMFS: unknown;
}
```

### `WasmLoadOptions`

```ts
interface WasmLoadOptions {
  wasmBinary?: ArrayBuffer | string;
  locateFile?: (filename: string) => string;
}
```

### `FbHandle`

```ts
type FbHandle = number; // opaque integer pointer
```
