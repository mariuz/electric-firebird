# electric-firebird Documentation

**electric-firebird** is a TypeScript library that brings the [Firebird](https://firebirdsql.org) embedded database engine to both Node.js and the browser — inspired by [PGlite](https://pglite.dev) for PostgreSQL.

## Contents

| Document | Description |
|----------|-------------|
| [Installation](./installation.md) | Installing the library and its native prerequisites |
| [API Reference](./api.md) | Full API reference for `FirebirdLite`, `FirebirdBrowser`, and all types |
| [Browser / WASM](./browser.md) | Running Firebird in the browser with IndexedDB persistence |
| [Architecture](./architecture.md) | How the two backends (native driver & WASM) are structured |
| [Contributing](./contributing.md) | How to build, test, and contribute to the project |

## At a glance

```ts
import { FirebirdLite } from 'firebird-wasm';

const db = new FirebirdLite('/tmp/my-app.fdb', {
  username: 'SYSDBA',
  password: 'masterkey',
});

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query('SELECT * FROM items');
console.log(result.rows); // [{ ID: 1, NAME: 'hello' }]

await db.close();
```

## Packages

| Package | Description |
|---------|-------------|
| [`firebird-wasm`](../packages/firebird-wasm) | Main library — Node.js native driver + browser WASM wrapper |

## License

Apache-2.0
