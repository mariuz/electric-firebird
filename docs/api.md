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

  exec(sql: string | SqlFragment, params?: QueryParams): Promise<void>
  query<T extends Row = Row>(sql: SqlFragment, options?: TransactionOptions): Promise<QueryResult<T>>
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

#### `db.exec(sql, params?)`

Execute a DDL or DML statement in its own auto-committed transaction.  Returns
`Promise<void>`.

```ts
await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.exec("INSERT INTO items VALUES (1, 'hello')");
await db.exec(sql`INSERT INTO items VALUES (${2}, ${'world'})`);
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
| `sql` | `string \| SqlFragment` | — | SQL statement, or a [`` sql`…` ``](#the-sql-template-tag) fragment. |
| `params` | `QueryParams` | `[]` | Positional bind parameters (`?` placeholders). |
| `options.isolationLevel` | `IsolationLevel` | engine default | Transaction isolation. |
| `options.readOnly` | `boolean` | `false` | Open a read-only transaction. |

Returns `Promise<QueryResult<T>>`.

Given a fragment, `options` moves into the second slot — the fragment already
carries its parameters, so there is nothing for that argument to hold:

```ts
await db.query(sql`SELECT * FROM items WHERE id = ${1}`, { readOnly: true });
```

Passing both a fragment and parameters throws, rather than binding values that
could not reach a placeholder.

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
  exec(sql: string | SqlFragment, params?: QueryParams): Promise<void>
  query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
  ): Promise<QueryResult<T>>
}
```

#### `tx.exec(sql, params?)`

Execute a DDL or DML statement inside the active transaction.

#### `tx.query<T>(sql, params?)`

Execute a SELECT statement inside the active transaction and return rows.

---

## The `sql` template tag

Exported from **both** entry points.  Builds a `SqlFragment` — statement text
plus the values bound to it — which `query()` and `exec()` accept anywhere a
string works, on either backend and inside transactions.

```ts
import { sql } from 'firebird-wasm';          // or 'firebird-wasm/browser'

await db.query(sql`SELECT * FROM items WHERE id = ${id} AND name = ${name}`);
// → 'SELECT * FROM items WHERE id = ? AND name = ?', params [id, name]
```

Every `${…}` becomes a `?` and its value is bound.  A value is therefore never
parsed as SQL, whatever it contains — which is the entire safety property, and
it does not depend on escaping anything.

Fragments nest, which is what makes conditional SQL bearable:

```ts
const active = onlyActive ? sql`AND active = ${true}` : sql``;
await db.query(sql`SELECT * FROM items WHERE owner = ${user} ${active}`);
```

Both `sql` and `params` are readable on a fragment, so a query can be logged
before it runs.

### What cannot be a parameter

Table names, column names and syntax are not values, and no amount of binding
will make them work.  Three named helpers produce text, so the unsafe one is
visible at the call site:

#### `sql.identifier(name)`

Quote a table or column name.  Any `"` in the name is doubled, so the quoting
cannot be ended.

```ts
await db.query(sql`SELECT * FROM ${sql.identifier('ITEMS')} WHERE id = ${id}`);
```

> **Firebird folds unquoted names to upper case, and quoting turns that off.**
> `CREATE TABLE items` stores `ITEMS`, so `sql.identifier('items')` produces
> `"items"` and will not find it.  Pass the name in its stored case — usually
> upper.  This does not upper-case for you, because names created *with* quotes
> keep whatever case they were given, and mangling those would break a name
> that was previously correct.

#### `sql.join(values, separator?)`

Expand a list into placeholders.  One placeholder binds one value, so
`WHERE id IN ${ids}` cannot work.

```ts
await db.query(sql`SELECT * FROM items WHERE id IN (${sql.join(ids)})`);
// → 'SELECT * FROM items WHERE id IN (?, ?, ?)'
```

Elements may themselves be fragments, which is how conditions compose:

```ts
sql`WHERE ${sql.join(conditions, ' AND ')}`
```

The parentheses above are the caller's — `join` cannot know whether it is
filling an `IN` list or an `AND` chain.  An **empty list throws**: `IN ()` is a
syntax error and an empty `AND` chain is an empty `WHERE`, so guard the case
with the condition you mean (`1 = 0` to match nothing, `1 = 1` for no filter).

#### `sql.unsafe(text)`

Splice text in literally, escaping nothing.  For syntax that is neither a value
nor an identifier:

```ts
const dir = ascending ? sql.unsafe('ASC') : sql.unsafe('DESC');
await db.query(sql`SELECT * FROM items ORDER BY name ${dir}`);
```

Anything reaching this from outside the program is an injection.  The name is
the warning.

### `SqlFragment`

```ts
class SqlFragment {
  readonly sql: string        // text, with a ? per bound value
  readonly params: QueryParams
}
```

`isSqlFragment(value)` tests for one.  `toStatement(sql, params?)` reduces
either calling convention to `{ sql, params }`, for code running statements
itself.

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

  exec(sql: string | SqlFragment, params?: QueryParams): Promise<ExecResult[]>
  query<T extends Row = Row>(sql: SqlFragment, options?: TransactionOptions): Promise<QueryResult<T>>
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
  exec(sql: string | SqlFragment, params?: QueryParams): Promise<ExecResult>
  query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
  ): Promise<QueryResult<T>>
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

#### `tx.rollback()`

Roll the transaction back and stop. The enclosing `transaction()` will not
commit afterwards, and the callback's return value is still returned — rolling
back deliberately is not a failure.

```ts
const outcome = await db.transaction(async (tx) => {
  await tx.exec('UPDATE ledger SET amount = ? WHERE id = ?', [999, 1]);

  if (!looksRight(await tx.query('SELECT * FROM ledger'))) {
    await tx.rollback();
    return 'abandoned';
  }
  return 'applied';
});
```

Use this rather than throwing an error you do not mean: throwing also rolls
back, but it propagates to the caller. Statements issued after a rollback throw
`Transaction has already been rolled back` rather than running outside any
transaction the caller believes in, and `tx.isFinished` reports the state.

Available on both backends.

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
