# firebird-wasm

**Firebird Embedded for Node.js / TypeScript** — a [PGlite](https://pglite.dev)-inspired wrapper around the [Firebird](https://firebirdsql.org) embedded engine.

> **Status:** Alpha — API may change before 1.0.

## Installation

```bash
npm install firebird-wasm node-firebird-driver-native
```

`node-firebird-driver-native` requires the Firebird client library (`libfbclient.so` on Linux / `fbclient.dll` on Windows) to be installed on the host. See [Firebird installation](https://firebirdsql.org/en/server-packages/) for details.

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

Requires `libEngine12.so` (Firebird 3) to be present alongside `libfbclient.so`.

## Testing

```bash
FIREBIRD_PASSWORD=masterkey npm test
```

## Roadmap

- [ ] True WASM build (Emscripten compilation of `libfbembed`)
- [ ] Browser support via the WASM bundle
- [ ] IndexedDB-backed persistence in the browser
- [ ] Firebird 4 & 5 support

## License

Apache-2.0
