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

- [x] True WASM build infrastructure (Emscripten CMake + build script)
- [x] Browser support module (`FirebirdBrowser`)
- [x] IndexedDB persistence layer (`IndexedDBVFS`)
- [x] Pre-built WASM binary published as a CI artifact
- [ ] Pre-built WASM binary published to npm
- [ ] Firebird 4 & 5 support

## CI

Both CI workflows use the official
[firebirdsql/firebird](https://hub.docker.com/r/firebirdsql/firebird) Docker image.

| Workflow | Trigger |
|----------|---------|
| [CI](.github/workflows/ci.yml) | push / PR — build + unit tests |
| [E2E](.github/workflows/e2e.yml) | push / PR — Playwright e2e tests |
| [Build WASM](.github/workflows/build-wasm.yml) | push / PR — compile Firebird to WASM + publish artifact |

## License

Apache-2.0
