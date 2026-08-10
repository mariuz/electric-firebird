# firebird-wasm

**Firebird Embedded for Node.js / TypeScript** — a [PGlite](https://pglite.dev)-inspired wrapper around the [Firebird](https://firebirdsql.org) embedded engine.

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

## Two backends

| Import | Engine | Needs |
|--------|--------|-------|
| `firebird-wasm` | Native driver → a real Firebird server | Firebird client library |
| `firebird-wasm/browser` | Firebird 6.0 compiled to WebAssembly | A browser, or Node |

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

Two constraints are structural rather than incidental: the page must be
[cross-origin isolated](../../docs/integration.md#2-the-two-hard-requirements),
and the engine must run in a Worker — it blocks on mutexes, and a browser main
thread may not block.

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
  rows: T[];       // result rows keyed by UPPER-CASE column name
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

Shipped in 0.1.0 — every item the previous roadmap listed as pending, except
the last:

- [x] True WASM build — Firebird 6.0 compiled with Emscripten
- [x] Browser support via the WASM bundle, with the engine in a Web Worker
- [x] IndexedDB-backed persistence — atomic, incremental, and automatic
- [x] Parameterised queries, transactions, and multi-statement scripts
- [x] Typed column metadata; exact `BIGINT`/`NUMERIC`/`DECFLOAT` as decimal strings
- [x] Multi-tab safety — a cross-tab lock refuses a second writer rather than
      letting it overwrite the first
- [x] The prebuilt engine on npm, so using it needs no Emscripten

Next:

- [ ] Live queries built on Firebird's `POST_EVENT`
- [ ] Multi-tab *sharing* — a `SharedWorker` leader, so a second tab is served
      rather than refused
- [ ] OPFS backend — a better match for page-oriented I/O than IndexedDB
- [ ] A typed binary result ABI, so exact numerics need not travel as strings
- [ ] Module disposal — `close()` does not currently release the WASM heap
- [ ] Loadable character sets. `src/intl` compiles under Emscripten and costs
      +245 KB gzipped, measured; what is missing is a way for `IntlManager`
      to reach it without `dlopen`. See
      [docs/roadmap.md](../../docs/roadmap.md)
- [ ] ElectricSQL sync

**"Firebird 4 & 5 support" is gone from this list because it was never the
gap.** The build tracks Firebird `master` and the shipped engine reports
`ENGINE_VERSION 6.0.0`. What is actually missing is a build *matrix* across
versions, not initial support for them.

Fuller status, and a feature-by-feature comparison with PGlite, in
[docs/roadmap.md](../../docs/roadmap.md).

## License

Apache-2.0
