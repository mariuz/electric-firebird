# Browser / WASM

electric-firebird runs entirely in the browser by compiling the Firebird
Embedded engine to WebAssembly via [Emscripten](https://emscripten.org).
Database pages can be persisted across page reloads using **IndexedDB**
(`IndexedDBVFS`), written directly to the **Origin Private File System**
(`opfs://`, `OPFSVFS`), or kept purely in **memory** (`memory://`).

---

## Overview

```
┌────────────────────────────────────────────┐
│  Your application code                     │
├────────────────────────────────────────────┤
│  FirebirdBrowser                           │
│  (TypeScript wrapper + Worker / Multi-tab) │
├────────────────────────────────────────────┤
│  firebird-embedded(-st).wasm               │
│  (Firebird 5.0 LTS / 6.0, Emscripten)      │
├────────────────────────────────────────────┤
│  Emscripten MEMFS / OPFS / Page Crypto     │
├────────────────────────────────────────────┤
│  IndexedDBVFS / OPFSVFS (durable pages)    │
└────────────────────────────────────────────┘
```

---

## Quick start

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query('SELECT * FROM items');
console.log(result.rows); // [{ ID: 1, NAME: 'hello' }]

await db.persist();
await db.close();
```

---

## Loading the WASM binary

The WASM artefacts (`firebird-embedded-st.wasm` + `firebird-embedded-st.js` for
the default single-threaded build, or `firebird-embedded.wasm` +
`firebird-embedded.js` for the threaded build) must be available to the browser
at runtime.

### Bundler (Vite / webpack)

Copy the artefacts to your public directory and specify their URL:

```ts
const db = new FirebirdBrowser('mydb', {
  locateFile: (filename) => `/wasm/${filename}`,
});
```

### Script tag

Load the Emscripten glue script before your application code:

```html
<script src="/wasm/firebird-embedded-st.js"></script>
<script type="module">
  import { FirebirdBrowser } from 'firebird-wasm/browser';
  const db = new FirebirdBrowser('mydb');
  // ...
</script>
```

### Inline WASM binary (e.g. for Service Workers)

```ts
const wasmResponse = await fetch('/wasm/firebird-embedded-st.wasm');
const wasmBinary = await wasmResponse.arrayBuffer();

const db = new FirebirdBrowser('mydb', { wasmBinary });
```

---

## Storage Backends & Persistence

### 1. IndexedDB (`IndexedDBVFS`, default)

By default, database I/O runs against an Emscripten in-memory filesystem
(`MEMFS`) and dirty pages are synchronised atomically to **IndexedDB** via
`IndexedDBVFS`.

- **Automatic persistence on close**: Calling `db.close()` automatically calls
  `db.persist()` before detaching.
- **Debounced auto-persist**: Enabled by default (`autoPersist: true`,
  `autoPersistDebounceMs: 500`), plus a best-effort flush on `visibilitychange`.
- **Manual persistence**: Set `autoPersist: false` and call `await db.persist()`.

Each logical database gets its own IndexedDB database named `firebird_<dbName>`
(configurable via `options.vfs.prefix`) with a `pages` object store:

| Key | Value |
|-----|-------|
| `0`, `1`, `2`, … | `{ data: ArrayBuffer }` (one Firebird page per record) |
| `__meta__` | `{ pageSize: number, pageCount: number, encrypted?: boolean }` |

### 2. Origin Private File System (`opfs://` and `OPFSVFS`)

Passing `'opfs://mydb'` writes directly to the Origin Private File System inside
a Web Worker (`FileSystemSyncAccessHandle`), requiring no `persist()` step and
no full-image memory copy.

For explicit page-level block I/O, snapshots, and page encryption over OPFS,
`OPFSVFS` (`import { OPFSVFS } from 'firebird-wasm/browser'`) provides the same
`readPage` / `writePage` / `syncWithEmscriptenFS` / `createSnapshot` /
`forkTo` interface as `IndexedDBVFS`.

### 3. Ephemeral In-Memory (`memory://`)

Passing `'memory://'` (or `'memory://scratch'`) opens an isolated in-memory
database that touches neither IndexedDB nor OPFS and is discarded on `close()`.

### 4. WebCrypto AES-256-GCM Encryption at Rest

Both `IndexedDBVFS` and `OPFSVFS` (and `FirebirdBrowser` via `options.encryptionKey`
or `options.vfs.encryptionKey`) support transparent per-page **AES-256-GCM**
encryption at rest using the WebCrypto API (`crypto.subtle`):

```ts
import {
  FirebirdBrowser,
  deriveEncryptionKeyFromPassphrase,
} from 'firebird-wasm/browser';

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await deriveEncryptionKeyFromPassphrase('correct horse battery staple', salt);

const db = new FirebirdBrowser('mydb', {
  worker,
  encryptionKey: key, // CryptoKey or 16/32-byte Uint8Array
});
```

Each encrypted page is stored in a `"FBE1"` envelope with a fresh 96-bit IV and
authenticated with `(pageNumber, pageSize)` as Additional Authenticated Data
(AAD), preventing page swapping, truncation, or tampering in browser storage.

### 5. Copy-on-Write Snapshots, Instant Branching & Binary Page Diffs

Take zero-copy in-memory page snapshots, export compact binary page deltas
(`FBDF\x01`), restore in-place, or fork isolated database branches in
milliseconds:

```ts
const snap1 = await db.snapshot('before-migration');
await db.exec('DELETE FROM items');
const snap2 = await db.snapshot('after-migration');

// Export or apply compact binary page diffs:
const delta = await db.exportDiff(snap1, snap2);

// Restore in-place:
await db.restoreSnapshot(snap1.id);

// Or fork an independent database branch:
const previewDb = await db.branch('preview-branch');
```

---

## Exporting and importing databases

You can export or stream a database image as a `Uint8Array` or `ReadableStream`:

```ts
// Complete Uint8Array dump from live database:
const bytes = await db.dumpDataDir();

// Or chunked ReadableStream<Uint8Array>:
const stream = db.dumpDataStream();
```

And restore it into a new or existing instance:

```ts
await db.loadDataStream(stream);
```

---

## Transactions & Savepoints

`FirebirdBrowser` exposes `transaction()` and nested `tx.savepoint()`:

```ts
await db.transaction(async (tx) => {
  await tx.exec("INSERT INTO items VALUES (2, 'world')");

  await tx.savepoint(async (sp) => {
    await sp.exec("INSERT INTO items VALUES (3, 'tentative')");
    // Throwing inside savepoint rolls back to the savepoint without aborting tx
  });
});
```

---

## JavaScript User-Defined Functions & Procedures (`ENGINE JS`)

Register custom JavaScript functions and selectable procedures directly on the
database connection:

```ts
await db.registerFunction(
  'SLUGIFY',
  { args: [{ name: 'TXT', type: 'VARCHAR(200)' }], returns: 'VARCHAR(200)' },
  (txt) => String(txt ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
);

const { rows } = await db.query("SELECT SLUGIFY('Hello Firebird WASM!') AS SLUG FROM RDB$DATABASE");
// [{ SLUG: 'hello-firebird-wasm-' }]
```

---

## Feature Summary

| Feature | Status |
|---------|--------|
| Pre-built WASM binary on npm | Published (`firebird-embedded-st.wasm` & `firebird-embedded.wasm`) |
| Parameterised queries (`?` placeholders) | Supported with typed binary (`INT64`, `DOUBLE`, `OCTETS`/`BLOB`) & text binding |
| Binary result wire format (`FBR\x01`) | Shipped — zero-`JSON.parse` binary row decoding from `HEAPU8` |
| Concurrent tabs | **Safe by default** (`multiTab: 'exclusive'`) and **shared leader election** (`multiTab: 'shared'`) with cross-tab `BroadcastChannel` live queries |
| Storage engines | `IndexedDBVFS`, `OPFSVFS` (`opfs://`), and `memory://`, plus AES-256-GCM encryption at rest |
| Copy-on-Write snapshots, branching & binary diffs | `db.snapshot()`, `db.restoreSnapshot()`, `db.branch()`, `db.exportDiff()`, `db.applyDiff()` |
| Prepared statements & streaming cursors | `db.prepare()`, `db.queryStream()`, `createBlobStream()`, `openBlobStream()`, `copyFromStream()`, `copyToStream()` |
| JavaScript UDRs, Vector HNSW & BM25 FTS | `db.registerFunction()`, `db.registerProcedure()`, `firebird-wasm/vector`, and `firebird-wasm/fts` |
| Database replication | `firebird-wasm/replication` — logical journal, CRDTs, mesh/hub, PITR archives, and native `"FBCHANGELOG\0"` / `IReplicator` |
| Observability & Cancellation | `db.onQuery()`, `db.monitorStats()`, `db.databaseInfo()`, `db.sweep()`, `AbortSignal` / `timeoutMs`, `db.cancelOperation()` |

### Concurrent tabs

Opening the same database in two tabs is safe by default (`multiTab: 'exclusive'`)
and supports transparent multi-tab sharing (`multiTab: 'shared'`).

| Option | Meaning |
|--------|---------|
| `multiTab: 'exclusive'` | Default. Refuse if another tab holds the database (`DatabaseLockedError`) |
| `multiTab: 'shared'` | Elect one tab to run the engine and serve the others from it over `BroadcastChannel`, including cross-tab `listen()` / `live()` event fan-out |
| `multiTab: 'allow-unsafe'` | Skip the lock. Only sound if at most one tab writes |
| `lockTimeoutMs` | How long to wait for the other tab, default `5000`. `Infinity` waits forever |

```ts
const db = new FirebirdBrowser('mydb', {
  multiTab: 'shared',
  worker: () => new Worker('/firebird-engine-worker.js'),
});

if (db.isLeader) {
  await runMigrations(db);
}
```

---

## Testing the browser layer

```bash
# Unit & WASM integration tests (Vitest)
npm test -w packages/firebird-wasm

# Browser e2e suite (Playwright + Chromium)
cd e2e
npx playwright install chromium
npm run test:browser
```

---

## Building the WASM module

See [Installation → Building the WASM module](./installation.md#building-the-wasm-module-optional)
for full instructions.

The build script (`packages/firebird-wasm/wasm/build.sh`) supports both
**Firebird 6.0 (`master`)** and **Firebird 5.0 LTS (`FB_TARGET_VERSION=5`)** and
produces:

```
packages/firebird-wasm/dist/wasm/
├── firebird-embedded.js       ← Threaded Emscripten glue (JS)
├── firebird-embedded.wasm     ← Threaded compiled engine
├── firebird-embedded-st.js    ← Single-threaded Emscripten glue (default)
└── firebird-embedded-st.wasm  ← Single-threaded compiled engine
```
