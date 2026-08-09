# electric-firebird

Run Firebird embedded in WASM, similar to [PGlite](https://pglite.dev) for PostgreSQL.

## Overview

This monorepo contains:

| Package | Description |
|---------|-------------|
| [`packages/firebird-wasm`](./packages/firebird-wasm) | TypeScript library — PGlite-style async API for Firebird |
| [`e2e`](./e2e) | Playwright end-to-end tests |
| [`demo`](./demo) | The playground published to GitHub Pages |

## Try it

**[Open the demo →](https://mariuz.github.io/electric-firebird/)**

A SQL console running the real engine in your browser — no server, nothing
uploaded. It ships worked examples for joins and aggregates, bound parameters,
a recursive CTE, `EXECUTE BLOCK`, transaction rollback, and exact `BIGINT` and
`NUMERIC` values that a JavaScript number could not hold. The database lives in
IndexedDB, so it is still there after a reload.

To run it locally, see [`demo/`](./demo) — you will need the WASM artifact
first.

## Quick start

### Node.js (native driver)

```ts
import { FirebirdLite } from 'firebird-wasm';

const db = new FirebirdLite('localhost:/tmp/my-app.fdb', {
  username: 'SYSDBA',
  password: 'masterkey',
});

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query("SELECT * FROM items");
console.log(result.rows); // [ { ID: 1, NAME: 'hello' } ]

await db.close();
```

### Browser (WASM + IndexedDB)

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

// The engine runs in a Worker: the build uses pthreads and a browser main
// thread cannot block.  Build the worker script from
// `firebird-wasm/browser/worker-entry`.  The page must be cross-origin
// isolated (COOP/COEP) for SharedArrayBuffer.
const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.exec('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query('SELECT * FROM items WHERE id = ?', [1]);
console.log(result.rows); // [ { ID: 1, NAME: 'hello' } ]

// Persist to IndexedDB before page unload
await db.persist();
await db.close();
```

## Setup

### Requirements

- Node.js 20+
- Firebird client library (`libfbclient.so` / `fbclient.dll`)

### Install

```bash
# Install dependencies for all workspaces
npm install

# Build the library
npm run build -w packages/firebird-wasm
```

### Run unit tests

```bash
FIREBIRD_PASSWORD=<password> npm test -w packages/firebird-wasm
```

### Run e2e tests

```bash
cd e2e

# Browser suite — needs no Firebird server and no WASM artifact
npx playwright install chromium
npm run test:browser

# Node.js suite — needs a running Firebird server
FIREBIRD_PASSWORD=<password> npx playwright test
```

### Run the demo site

```bash
npm run build:wasm -w packages/firebird-wasm   # once; slow
npm run demo                                    # http://localhost:4173
npm run test:demo                               # 16 Playwright tests
```

The local server sends no COOP/COEP headers, exactly like GitHub Pages, so the
demo's service worker has to supply cross-origin isolation itself. See
[`demo/README.md`](./demo/README.md).

### Build the WASM module (optional)

The Emscripten SDK is vendored at `third_party/emsdk`, and the version is
pinned in `packages/firebird-wasm/wasm/emsdk-version.txt`:

```bash
cd third_party/emsdk
./emsdk install $(cat ../../packages/firebird-wasm/wasm/emsdk-version.txt)
./emsdk activate $(cat ../../packages/firebird-wasm/wasm/emsdk-version.txt)
source ./emsdk_env.sh
cd ../..

npm run build:wasm -w packages/firebird-wasm
```

The build refuses to run against a different Emscripten. That is not
fussiness: a mismatched toolchain compiles and links this engine perfectly
well and then aborts inside `fb_create_database` at runtime, so the check has
to happen at build time. Override with `FB_WASM_ALLOW_EMSDK_MISMATCH=1` if you
are deliberately testing another version.

## Architecture

The library provides two execution backends:

1. **Node.js** – Uses the Firebird **Embedded Server** (single-process mode) via
   [node-firebird-driver-native](https://github.com/asfernandes/node-firebird-drivers/tree/master/packages/node-firebird-driver-native).

2. **Browser (WASM)** – Compiles the Firebird embedded engine (`libfbembed`) to
   WebAssembly via [Emscripten](https://emscripten.org).  Database pages are
   persisted to **IndexedDB** so data survives page reloads.

```
┌─────────────────────────────────────────────────┐
│  Application code (shared QueryResult/Row types) │
├────────────────────┬────────────────────────────┤
│  FirebirdLite      │  FirebirdBrowser           │
│  (Node.js native)  │  (WASM + IndexedDB)        │
├────────────────────┼────────────────────────────┤
│  libfbclient.so    │  firebird-embedded.wasm    │
│                    │  + IndexedDB VFS            │
└────────────────────┴────────────────────────────┘
```

### Roadmap

> **Status: Firebird runs in WebAssembly.**  The engine creates a database,
> executes DDL and DML, and returns rows:
>
> ```
> create_database  -> 1
> exec             -> CREATE TABLE items (id INTEGER, name VARCHAR(32))
> exec             -> INSERT INTO items VALUES (1, 'alpha')
> ROWS: {"columns":["ID","NAME"],"rows":[[1,"alpha"],[2,"beta"]]}
> ```
>
> Verified in Node (13 integration tests) **and in Chromium** through the
> public `FirebirdBrowser` API — including transactions and data surviving a
> page reload via IndexedDB.  The engine runs inside a Web Worker, which is
> required because the build uses pthreads and a browser main thread cannot
> block.  Databases created by this build define only the built-in character
> sets, UTF8 among them — see [docs/roadmap.md](./docs/roadmap.md).

- [x] WASM build infrastructure (Emscripten CMake + build script, tracks Firebird `master`)
- [x] Browser support module (`FirebirdBrowser`)
- [x] IndexedDB persistence layer (`IndexedDBVFS`)
- [x] Browser test suite (Playwright, real Chromium + real IndexedDB)
- [x] C API implemented over the Firebird OO API — attach/create, transactions, cursors, typed values, engine error text
- [x] Transactions that bind statements to the transaction handle
- [x] Link the WASM build (Emscripten vendored at `third_party/emsdk`)
- [x] Compile Firebird's metadata layer for real (gpre boot pass) instead of stubbing it
- [x] Fix the memory-pool corruption (`autoconfig.h` described the 64-bit host: `SIZEOF_VOID_P`/`SIZEOF_SIZE_T`)
- [x] Enable C++ exceptions (`-fwasm-exceptions`) — Firebird reports every error by throwing
- [x] Threads (`-pthread` + a pre-spawned worker pool), real `sem_timedwait`, realistic stack sizes
- [x] Attach threads to the libcds hazard-pointer GC, which the metadata cache requires
- [x] **The engine runs: create database, DDL, DML, SELECT** (13 Node integration tests)
- [x] Run the engine in a Web Worker (verified in Chromium end to end)
- [x] Point `FirebirdBrowser` at the Worker (real SQL through the public API, verified in Chromium)
- [x] Parameterised queries (`?` placeholders) on both backends
- [ ] Incremental, atomic IndexedDB persistence
- [ ] Web Worker + multi-tab safety
- [ ] Pre-built WASM binary published to npm
- [ ] Live queries / `POST_EVENT`-based notifications

See [docs/roadmap.md](./docs/roadmap.md) for the full status audit, a
feature-by-feature comparison with PGlite, and the staged plan.

## CI

Both CI workflows use the official
[firebirdsql/firebird](https://hub.docker.com/r/firebirdsql/firebird) Docker image.

| Workflow | Job | Trigger |
|----------|-----|---------|
| [CI](.github/workflows/ci.yml) | Build & unit tests | push / PR |
| [E2E](.github/workflows/e2e.yml) | Playwright browser tests (no Firebird needed) | push / PR |
| [E2E](.github/workflows/e2e.yml) | Playwright e2e tests (against Firebird) | push / PR |

## License

Apache-2.0
