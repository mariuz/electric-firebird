# electric-firebird

Run Firebird embedded in WASM, similar to [PGlite](https://pglite.dev) for PostgreSQL.

## Overview

This monorepo contains:

| Package | Description |
|---------|-------------|
| [`packages/firebird-wasm`](./packages/firebird-wasm) | TypeScript library — PGlite-style async API for Firebird |
| [`e2e`](./e2e) | Playwright end-to-end tests |

## Quick start

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

## Setup

### Requirements

- Node.js 20+
- Firebird 3.0 client library (`libfbclient.so` / `fbclient.dll`)

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

## Architecture

The library uses the Firebird **Embedded Server** (single-process mode) via the
[node-firebird-driver-native](https://github.com/asfernandes/node-firebird-drivers/tree/master/packages/node-firebird-driver-native)
high-level TypeScript client. In embedded mode only one application process
accesses the database file, providing an effective single-user context —
analogous to how PGlite uses PostgreSQL's single-user mode.

### Roadmap

- [ ] True WASM build compiled with Emscripten
- [ ] Browser support via the WASM bundle
- [ ] IndexedDB persistence layer for browsers

## CI

| Workflow | Trigger |
|----------|---------|
| [CI](.github/workflows/ci.yml) | push / PR — build + unit tests |
| [E2E](.github/workflows/e2e.yml) | push / PR — Playwright e2e tests |

## License

Apache-2.0
