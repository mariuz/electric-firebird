# firebird-wasm

**Firebird Embedded for Node.js & the Browser (WebAssembly)** — a [PGlite](https://pglite.dev)-inspired wrapper around the [Firebird](https://firebirdsql.org) embedded engine.

> **Status:** Alpha — API may change before 1.0.

## Installation

```bash
npm install firebird-wasm
```

The package ships the compiled WASM engine, so the browser backend needs
nothing else — no Emscripten, no Firebird installation, no server.

The **Node backend** (`FirebirdLite`, below) is different: it talks to a real
Firebird through `node-firebird-driver-native`, which needs the Firebird client
library (`libfbclient.so` / `fbclient.dll`) on the host. That is an *optional*
dependency, so if you only want the browser engine, skip it:

```bash
npm install firebird-wasm --omit=optional
```

See [Firebird installation](https://firebirdsql.org/en/server-packages/) if you
do want the native path.

## Two backends & subpath exports

| Import | Engine / Module | Needs |
|--------|-----------------|-------|
| `firebird-wasm` | Native driver → a real Firebird server (`FirebirdLite`) | Firebird client library |
| `firebird-wasm/browser` | Firebird 5.0 LTS / 6.0 compiled to WebAssembly (`FirebirdBrowser`, `IndexedDBVFS`, `OPFSVFS`) | A browser, or Node |
| `firebird-wasm/browser/worker-entry` | Dedicated Web Worker entry point for the WASM engine | Browser / Worker |
| `firebird-wasm/react` | React `<FirebirdProvider>`, `useFirebird`, `useQuery`, `useLiveQuery` | React 18+ |
| `firebird-wasm/vue` | Vue 3 `provideFirebird`, `useFirebird`, `useQuery`, `useLiveQuery` | Vue 3+ |
| `firebird-wasm/svelte` | Svelte 5 `setFirebirdContext`, `getFirebirdContext`, `createQuery`, `createLiveQuery` | Svelte 5+ |
| `firebird-wasm/solid` | SolidJS `FirebirdContext`, `useFirebird`, `createQuery`, `createLiveQuery` | SolidJS 1.8+ |
| `firebird-wasm/repl` | `<firebird-repl>` interactive SQL console + Schema/Migrations/Profiler inspector | Browser custom elements |
| `firebird-wasm/electric` | ElectricSQL client sync (`syncShapeToTable`, `syncShapesToTables`, `syncShapes`, `createWriteQueue`) | `FirebirdBrowser` / `FirebirdLite` |
| `firebird-wasm/electric-server` | Firebird-backed Electric shape feed & write ingestion (`createShapeServer`, `applyWrite`) | `FirebirdLite` / `FirebirdBrowser` |
| `firebird-wasm/kysely` | Kysely dialect (`FirebirdBrowserDialect`) & TypeScript schema codegen (`generateKyselyTypes`) | Kysely (optional) |
| `firebird-wasm/drizzle` | Drizzle-style query builder (`drizzle`) & schema codegen (`generateDrizzleSchema`) | `FirebirdBrowser` / `FirebirdLite` |
| `firebird-wasm/vector` | Float32/Int8 vector codec, SQL UDR registration (`COSINE_DISTANCE`, `L2_DISTANCE`, `DOT_PRODUCT`), and `vectorSearch` | `FirebirdBrowser` / `FirebirdLite` |

The rest of this file documents the Node backend. For the browser engine —
which is what the package is named after — see
**[the integration guide](../../docs/integration.md)**, or try
**[the live demo](https://mariuz.github.io/electric-firebird/)**.

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec('CREATE TABLE notes (id INTEGER, title VARCHAR(200))');
await db.exec('INSERT INTO notes VALUES (?, ?)', [1, 'Hello']);

const { rows } = await db.query('SELECT * FROM notes');
// [{ ID: 1, TITLE: 'Hello' }]
```

The default build, `firebird-embedded-st.js`, has no threads: it needs no
`SharedArrayBuffer`, so no cross-origin isolation, and can run without a
Worker. The threaded build (`wasmGlueFile(true)`, `threads: true`) adds
statement and idle timeouts, and has two structural constraints: the page must
be [cross-origin isolated](../../docs/integration.md#2-the-two-hard-requirements-and-the-build-without-them),
and the engine must run in a Worker — it blocks on mutexes, and a browser main
thread may not block. Until 0.9.0 the threaded build was the default.

## Quick start

```ts
import { FirebirdLite } from 'firebird-wasm';

// Connect to a Firebird server (embedded or remote)
const db = new FirebirdLite('localhost:/tmp/my-app.fdb', {
  username: 'SYSDBA',
  password: 'masterkey',
});

// DDL
await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');

// Parameterised INSERT
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

// SELECT
const result = await db.query('SELECT id, name FROM items ORDER BY id');
console.log(result.rows);
// → [ { ID: 1, NAME: 'hello' } ]

// Column metadata
console.log(result.fields);
// → [ { name: 'ID' }, { name: 'NAME' } ]

// Transactions
await db.transaction(async (tx) => {
  await tx.exec('UPDATE items SET name = ? WHERE id = ?', ['world', 1]);
  // automatically committed on success, rolled back on error
});

await db.close();
```

## API

### `new FirebirdLite(uri, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `uri` | `string` | Database URI — e.g. `localhost:/path/to/db.fdb` or just `/path/to/db.fdb` for embedded mode |
| `options.username` | `string?` | Firebird user name (default: `'SYSDBA'`) |
| `options.password` | `string?` | Firebird password |
| `options.libraryPath` | `string?` | Override the path to `libfbclient.so` |
| `options.charset` | `string?` | `charSetForNONE` encoding for NONE-charset columns |

### `db.exec(sql)`

Execute a DDL or DML statement in its own auto-committed transaction.

### `db.query<T>(sql, params?, options?)`

Execute a query and return a `QueryResult<T>`:

```ts
interface QueryResult<T> {
  rows: T[];       // result rows keyed by column name (upper case unless quoted)
  fields: FieldInfo[];  // column metadata
}
```

### `db.transaction(fn, options?)`

Run an async function inside a transaction. Automatically committed on success; rolled back on error.

```ts
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO t VALUES (?)', [1]);
  await tx.query('SELECT cnt FROM t');
});
```

### `db.close()`

Disconnect from the database and release all resources.

## Embedded mode

Using the Firebird embedded engine provides a single-process, single-user database without needing a Firebird server. Pass a plain file path (no `host:` prefix):

```ts
const db = new FirebirdLite('/tmp/my.fdb', {
  username: 'SYSDBA',
  password: '',
});
```

Requires the engine plugin alongside `libfbclient.so` — `libEngine12.so` on Firebird 3, `libEngine13.so` on Firebird 4 and 5. This is the *native* embedded engine; for the WASM one, no Firebird install is involved at all.

## Testing

```bash
FIREBIRD_PASSWORD=masterkey npm test
```

## Roadmap

Shipped in 0.1.0:

- [x] True WASM build — Firebird 6.0 compiled with Emscripten
- [x] Browser support via the WASM bundle, with the engine in a Web Worker
- [x] IndexedDB-backed persistence — atomic, incremental, and automatic
- [x] Parameterised queries, transactions, and multi-statement scripts
- [x] Typed column metadata; exact `BIGINT`/`NUMERIC`/`DECFLOAT` as decimal strings
- [x] Multi-tab safety — a cross-tab lock refuses a second writer rather than
      letting it overwrite the first
- [x] The prebuilt engine on npm, so using it needs no Emscripten

Shipped since:

- [x] Live queries built on Firebird's `POST_EVENT` (`live()`, `listen()`,
      `notify()`), including cross-tab `BroadcastChannel` notifications
- [x] Multi-tab *sharing* (`multiTab: 'shared'`): one tab runs the engine,
      the others are served by it
- [x] OPFS backend (`opfs://name`) and direct block-level page PIO (`OPFSVFS`)
      with WebCrypto AES-256-GCM page encryption at rest
- [x] Copy-on-Write (CoW) page snapshots and instant database branching
      (`db.snapshot()`, `db.restoreSnapshot()`, `db.branch()`)
- [x] A build without `SharedArrayBuffer` (`firebird-embedded-st`), for pages
      served without COOP/COEP headers, plus Firebird 5.0 LTS (`v5`) and 6.0
      (`v6`) WASM build targets
- [x] Typed binary result wire format (`FBR\x01`) for zero-JSON-parse cursor
      fetches, and on-demand ICU locale collation packs (`loadIcuLocaleData`)
- [x] Reusable prepared statements (`db.prepare()`), streaming cursors
      (`queryStream()`), BLOB streams (`createBlobStream()` / `openBlobStream()`),
      and `COPY`-style bulk CSV/JSONL streaming (`copyFromStream()` / `copyToStream()`)
- [x] Nested savepoints (`tx.savepoint()`), `AbortSignal` / `timeoutMs` statement
      cancellation, and query observability (`db.onQuery()` / `db.monitorStats()`)
- [x] JavaScript User-Defined Functions & Procedures (`db.registerFunction()`,
      `db.registerProcedure()`) via a C++ `IExternalEngine` (`ENGINE JS`) bridge
- [x] Vector embeddings & similarity search (`firebird-wasm/vector`)
- [x] React, Vue, Svelte 5, and SolidJS integrations (`firebird-wasm/react`,
      `/vue`, `/svelte`, `/solid`), Kysely & Drizzle adapters + schema codegen
      (`firebird-wasm/kysely`, `firebird-wasm/drizzle`), and `<firebird-repl>`
      (`firebird-wasm/repl`) with Schema, Migrations, and Profiler tabs
- [x] ElectricSQL sync, read & write paths: Postgres shapes (`firebird-wasm/electric`),
      relational multi-shape sync (`syncShapes`), conflict-aware `createWriteQueue`,
      and Firebird shape server (`firebird-wasm/electric-server`) with `where` join
      pushdown, `replica=full`, and `applyWrite`
- [x] Module disposal: `disposeFirebirdWasm()`, and closing the last
      database frees the engine's memory

Fuller status, and a feature-by-feature comparison with PGlite, in
[docs/roadmap.md](../../docs/roadmap.md).

## License

Apache-2.0
