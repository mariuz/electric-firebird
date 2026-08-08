# electric-firebird

Run Firebird embedded in WASM, similar to [PGlite](https://pglite.dev) for PostgreSQL.

## Overview

This monorepo contains:

| Package | Description |
|---------|-------------|
| [`packages/firebird-wasm`](./packages/firebird-wasm) | TypeScript library — PGlite-style async API for Firebird |
| [`e2e`](./e2e) | Playwright end-to-end tests |

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

const db = new FirebirdBrowser('mydb');

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
const result = await db.query('SELECT * FROM items');
console.log(result.rows);

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

### Build the WASM module (optional)

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html):

```bash
source <emsdk>/emsdk_env.sh
npm run build:wasm -w packages/firebird-wasm
```

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

> **Status:** the Node.js backend works.  The browser backend **builds and
> starts**: `firebird-embedded.wasm` links cleanly, `fb_init()` succeeds in
> Chromium against the real engine, and errors now propagate properly with
> Firebird's own messages.  It does not create a database yet — the engine
> wants to start worker threads and the build has no pthreads:
> `pthread_create failed -Not supported`.

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
- [ ] **Threads: build with `-pthread`, or stop the engine spawning them** — the remaining blocker
- [ ] Parameterised queries in the browser (currently refused rather than ignored)
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
