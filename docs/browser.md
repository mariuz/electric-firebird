# Browser / WASM

electric-firebird can run entirely in the browser by compiling the Firebird
Embedded engine to WebAssembly via [Emscripten](https://emscripten.org).
Database pages are persisted across page reloads using the browser's
built-in **IndexedDB** storage.

---

## Overview

```
┌────────────────────────────────────┐
│  Your application code             │
├────────────────────────────────────┤
│  FirebirdBrowser                   │
│  (TypeScript wrapper)              │
├────────────────────────────────────┤
│  firebird-embedded.wasm            │
│  (Firebird engine, Emscripten)     │
├────────────────────────────────────┤
│  Emscripten MEMFS                  │  ← in-memory virtual FS
├────────────────────────────────────┤
│  IndexedDBVFS                      │  ← durable page storage
└────────────────────────────────────┘
```

---

## Quick start

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb');

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.query("INSERT INTO items VALUES (1, 'hello')");

const result = await db.query('SELECT * FROM items');
console.log(result.rows); // [{ ID: 1, NAME: 'hello' }]

// Persist pages to IndexedDB before the page unloads
window.addEventListener('beforeunload', () => db.persist());

await db.close();
```

---

## Loading the WASM binary

The WASM artefacts (`firebird-embedded.wasm` + `firebird-embedded.js`) must be
available to the browser at runtime.

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
<script src="/wasm/firebird-embedded.js"></script>
<script type="module">
  import { FirebirdBrowser } from 'firebird-wasm/browser';
  const db = new FirebirdBrowser('mydb');
  // ...
</script>
```

### Inline WASM binary (e.g. for Service Workers)

```ts
const wasmResponse = await fetch('/wasm/firebird-embedded.wasm');
const wasmBinary = await wasmResponse.arrayBuffer();

const db = new FirebirdBrowser('mydb', { wasmBinary });
```

---

## Persistence

All database I/O runs against an **Emscripten in-memory filesystem** (MEMFS).
To survive page reloads, pages are synchronised to **IndexedDB** via
`IndexedDBVFS`.

### Automatic persistence on close

Calling `db.close()` automatically calls `db.persist()` before detaching:

```ts
await db.close(); // persists, then detaches
```

### Manual persistence

For long-running sessions you may want to persist more frequently:

```ts
// Every 30 seconds
setInterval(() => db.persist(), 30_000);

// Before page unload
window.addEventListener('beforeunload', () => db.persist());
```

### IndexedDB storage layout

Each logical database gets its own IndexedDB database named
`firebird_<dbName>` (the prefix is configurable via `options.vfs.prefix`).
Inside that database a single object store named `pages` is used:

| Key | Value |
|-----|-------|
| `0`, `1`, `2`, … | `{ data: ArrayBuffer }` (one Firebird page per record) |
| `__meta__` | `{ pageSize: number, pageCount: number }` |

---

## Exporting and importing databases

You can download a database snapshot as a `Uint8Array`:

```ts
import { IndexedDBVFS } from 'firebird-wasm/browser';

const vfs = new IndexedDBVFS();
await vfs.open('mydb');

const snapshot = await vfs.exportDatabase(); // Uint8Array
// e.g. trigger a download
const blob = new Blob([snapshot], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
```

And import it back:

```ts
const bytes = new Uint8Array(await file.arrayBuffer());
await vfs.importDatabase(bytes);
```

---

## Transactions

`FirebirdBrowser` exposes the same `transaction()` API as `FirebirdLite`:

```ts
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO items VALUES (2, \'world\')');
  const { rows } = await tx.query('SELECT COUNT(*) AS CNT FROM items');
  console.log(rows[0].CNT); // 2
  // automatically committed — rolled back on throw
});
```

---

## Current limitations

> **The browser backend does not execute SQL yet.**  Every export in
> `wasm/fb_wasm_api.cpp` is still a `TODO` stub — `fb_create_database()`
> returns a null handle, so the quick-start above throws
> `Failed to open database`.  The TypeScript layer documented on this page is
> implemented and covered by browser tests; the engine behind it is not wired
> up.  See [roadmap.md](./roadmap.md) §M1.

| Feature | Status |
|---------|--------|
| SQL execution (the engine itself) | **Stubbed** — see above |
| Parameterised queries (`?` placeholders) | Accepted by `query()` but **silently ignored**; do not pass parameters in the browser |
| Transaction-scoped statements | `tx.exec()` / `tx.query()` run against the database handle, not the transaction handle, so a rollback does not undo them |
| Concurrent tabs | **Unsafe** — two tabs open the same IndexedDB store and each `persist()` rewrites the whole image, so the last writer wins and the other tab's writes are lost |
| Incremental / atomic persistence | `persist()` rewrites every page; an interrupted persist can truncate the database |
| Typed values (BLOB, BIGINT, TIMESTAMP) | The result ABI is JSON, so binary is unsupported and 64-bit integers lose precision |
| Pre-built WASM binary on npm | Planned |
| Multi-tab / SharedWorker | Not yet supported |
| Web Worker offloading | Planned |

---

## Testing the browser layer

The browser build has its own Playwright suite that runs in real Chromium
against real IndexedDB, and needs neither a Firebird server nor the compiled
WASM artifact:

```bash
cd e2e
npx playwright install chromium
npm run test:browser
```

The C ABI is supplied by `e2e/fixtures/stub-engine.js` — a strict stub with a
real byte heap (so leaked or double-freed pointers are detected) and a real
in-memory filesystem (so `IndexedDBVFS` import/export is exercised for real).
The code under test is the actual bundled library, served by
`e2e/server/wasm-server.ts`, which bundles `src/browser` with esbuild on
demand.

Once the engine is wired up, the same server also serves
`/browser-harness-wasm`, which loads the real Emscripten glue instead of the
stub.

---

## Building the WASM module

See [Installation → Building the WASM module](./installation.md#building-the-wasm-module-optional)
for full instructions.

The build script (`packages/firebird-wasm/wasm/build.sh`) targets
**Firebird 5.0.3** and produces:

```
packages/firebird-wasm/dist/wasm/
├── firebird-embedded.js    ← Emscripten glue (JS)
└── firebird-embedded.wasm  ← Compiled engine
```
