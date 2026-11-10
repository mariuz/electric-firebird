# electric-firebird Documentation

**electric-firebird** (`firebird-wasm`) brings the [Firebird](https://firebirdsql.org) embedded SQL database engine to both the browser (via WebAssembly) and Node.js — inspired by [PGlite](https://pglite.dev) for PostgreSQL.

## Contents

| Document | Description |
|----------|-------------|
| [Installation](./installation.md) | Installing `firebird-wasm` for browser-only or Node.js projects, and building from source |
| [Integration Guide](./integration.md) | Putting the engine into your app: Workers, Vite/webpack/Next.js, frameworks, ORMs, and pitfalls |
| [API Reference](./api.md) | Full reference for `FirebirdBrowser`, `FirebirdLite`, streams, snapshots, UDRs, and all subpath modules |
| [Browser / WASM](./browser.md) | Storage backends (`IndexedDBVFS`, `opfs://`, `memory://`), AES-256-GCM encryption, CoW branching, and multi-tab sharing |
| [Engine Builds](./builds.md) | Comparing the default single-threaded build (`firebird-embedded-st`) and the threaded build (`firebird-embedded`) |
| [Database Replication](./replication.md) | Logical/journal & native Firebird engine replication, CRDTs, multi-node mesh/hub, DLQ, PITR archives, and time-travel |
| [Architecture](./architecture.md) | How the WASM C++ bridge, binary wire protocol (`FBR\x01`), VFS layers, and Node.js driver fit together |
| [How It Was Ported](./porting.md) | Engineering deep dive: porting Firebird C++ to 32-bit WebAssembly with Emscripten |
| [Roadmap](./roadmap.md) | Milestone history (M0–M17), PGlite feature comparison, and architecture notes |
| [Contributing](./contributing.md) | Development setup, testing suites, benchmarks, and coding guidelines |
| [Releasing](./releasing.md) | Pre-publish engine verification and npm release workflow |
| [Changelog](../CHANGELOG.md) | Release history |

## At a glance

### Browser (WebAssembly + IndexedDB / OPFS / Memory)

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker(new URL('./engine-worker.js', import.meta.url)),
});

await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(100))');
await db.exec('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const { rows } = await db.query('SELECT * FROM items WHERE id = ?', [1]);
console.log(rows); // [{ ID: 1, NAME: 'hello' }]

await db.close();
```

### Node.js (Native Firebird client / Embedded)

```ts
import { FirebirdLite } from 'firebird-wasm';

const db = new FirebirdLite('/tmp/my-app.fdb', {
  username: 'SYSDBA',
  password: 'masterkey',
});

await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(100))');
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query('SELECT * FROM items');
console.log(result.rows); // [{ ID: 1, NAME: 'hello' }]

await db.close();
```

## Packages

| Package | Description |
|---------|-------------|
| [`firebird-wasm`](../packages/firebird-wasm) | Published npm package — WebAssembly browser engine, Node.js native driver, and ecosystem adapters |

## License

Apache-2.0
