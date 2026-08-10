# Using Firebird WASM in your project

A practical guide to putting the browser engine into a real application:
setup, hosting, bundlers, persistence, and the failure modes worth knowing
before you meet them.

- New to the project? Start with [README](../README.md), or
  **[try the demo](https://mariuz.github.io/electric-firebird/)**.
- Want to know how the port works? See [porting.md](./porting.md).
- Full type-by-type reference: [api.md](./api.md).

> **Status.** `firebird-wasm@0.1.0` is on npm and ships the compiled engine.
> Everything described here works and is covered by tests, but it is a 0.x
> release — the API may still move.

---

## 1. Installing

```bash
npm install firebird-wasm
```

The package ships the compiled engine, so there is nothing to build:

```
node_modules/firebird-wasm/dist/wasm/firebird-embedded.js     ~108 KB
node_modules/firebird-wasm/dist/wasm/firebird-embedded.wasm   ~9.1 MB
```

Copy those two next to your Worker script, or point `locateFile` at them —
see §3. Serve the `.wasm` compressed; Brotli takes it to roughly a third, and
expect it to dominate first load. It caches normally afterwards.

The Node backend needs `node-firebird-driver-native`, which is an
**optional** dependency because it wants Firebird's client library installed.
If you only use the browser engine, skip it:

```bash
npm install firebird-wasm --omit=optional
```

You can also take the engine straight from a [GitHub release][releases] if you
would rather not add a dependency at all.

### Building it yourself

Only needed to modify the engine. Expect about an hour.

```bash
git clone --recurse-submodules https://github.com/mariuz/electric-firebird
cd electric-firebird && npm install

EMSDK_VERSION=$(cat packages/firebird-wasm/wasm/emsdk-version.txt)
(cd third_party/emsdk && ./emsdk install "$EMSDK_VERSION" \
  && ./emsdk activate "$EMSDK_VERSION")
source third_party/emsdk/emsdk_env.sh

npm run build:wasm -w packages/firebird-wasm
npm run build -w packages/firebird-wasm
```

The build refuses to run against an Emscripten other than the pinned one. A
mismatched toolchain links cleanly and then aborts inside the engine at
runtime, so the check has to happen at build time.

[releases]: https://github.com/mariuz/electric-firebird/releases

---

## 2. The two hard requirements

Both of these are structural. Neither can be worked around in application
code, so it is worth confirming them before writing any.

### Your page must be cross-origin isolated

The engine uses pthreads, which need `SharedArrayBuffer`, which browsers
withhold unless the document is served with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check at runtime before doing anything else:

```ts
if (!crossOriginIsolated) {
  throw new Error('not cross-origin isolated; the engine cannot start');
}
```

`require-corp` also constrains everything else your page loads: cross-origin
subresources need `Cross-Origin-Resource-Policy: cross-origin` or a CORS
response, or they will be blocked. If your app embeds third-party images,
fonts, analytics or iframes, verify them before committing to this.

If you cannot set headers — GitHub Pages, most static CDNs — see §7.

### The engine must run in a Worker

Firebird blocks on mutexes while opening a database, and a browser main thread
is not allowed to block. Running the engine on the main thread deadlocks
reliably, not intermittently.

```ts
const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});
```

Omitting `worker` is only appropriate in Node or a test harness driving a stub.

---

## 3. Wiring it up

Three files: the Worker entry, the engine assets, and your application code.

**`src/firebird-engine-worker.ts`** — bundle this as a *classic* worker script:

```ts
import 'firebird-wasm/browser/worker-entry';
```

The bundled output needs two lines in front of it, so the Worker loads the
Emscripten glue and can find the `.wasm` next to itself:

```js
importScripts(new URL('./firebird-embedded.js', self.location.href).href);
self.FIREBIRD_WORKER_OPTIONS = {
  locateFile: (file) => new URL(file, self.location.href).href,
};
```

Resolving against `self.location.href` rather than an absolute path keeps the
app working under any path prefix — including the `/<repo>/` prefix a GitHub
project site is served from. `demo/build.mjs` in this repository does exactly
this and is a working reference.

**Your code:**

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec(`
  CREATE TABLE notes (
    id      INTEGER NOT NULL PRIMARY KEY,
    title   VARCHAR(200) NOT NULL,
    body    BLOB SUB_TYPE TEXT,
    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

await db.exec('INSERT INTO notes (id, title) VALUES (?, ?)', [1, 'Hello']);

const { rows } = await db.query('SELECT id, title FROM notes WHERE id = ?', [1]);
console.log(rows); // [{ ID: 1, TITLE: 'Hello' }]

await db.close();
```

Nothing needs initialising. The first call opens the database — restoring it
from IndexedDB if it exists, creating it if not.

> **Column names come back uppercase.** Firebird folds unquoted identifiers to
> upper case, so `SELECT title` yields `TITLE`. Use `SELECT title AS "title"`
> if you want it lowercase, and be consistent — quoted identifiers are
> case-sensitive from then on.

---

## 4. Bundlers

The Worker must be a real, separately-built file. The awkward part is that
`wasm-loader.ts` contains a Node branch that `require()`s the Emscripten glue;
browsers never take it, but bundlers resolve string-literal requires eagerly
and will drag `node:fs` into your bundle. Mark it external.

### Vite

```ts
// vite.config.ts
export default defineConfig({
  build: { rollupOptions: { external: [/firebird-embedded\.js$/] } },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

Set the headers on `preview` as well as `server`. Getting them only on the dev
server is a good way to ship a build that fails the moment it is deployed.

Copy `firebird-embedded.{js,wasm}` into `public/` so they are served verbatim.

### webpack

```js
module.exports = {
  externals: { './firebird-embedded.js': 'commonjs ./firebird-embedded.js' },
  devServer: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
};
```

### esbuild

```js
await build({
  entryPoints: ['src/app.ts'],
  bundle: true,
  format: 'esm',
  external: ['*firebird-embedded.js'],
});
```

### Next.js

```js
// next.config.js
module.exports = {
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
      ],
    }];
  },
};
```

Keep the engine out of server rendering — it is browser-only. Load it from an
effect, or `dynamic(..., { ssr: false })`.

---

## 5. Parameters and types

Bind values; never concatenate them into SQL.

```ts
await db.query('SELECT * FROM notes WHERE title = ?', [userInput]);
```

| JavaScript | Sent as |
|------------|---------|
| `number`, `string` | text, converted by the engine |
| `boolean` | `TRUE` / `FALSE` |
| `Date` | ISO-8601 |
| `null`, `undefined` | SQL `NULL` |
| `Uint8Array` | **throws** — binary parameters are not supported |
| `NaN`, `Infinity`, plain objects | **throws** |

Values cross as text and are converted using the statement's declared
parameter metadata, so the engine's own coercion rules apply. Binary throws
rather than being silently mangled.

### Reading values back

Anything a `double` cannot hold arrives as an **exact decimal string**:

| Firebird type | JavaScript |
|---------------|------------|
| `SMALLINT`, `INTEGER`, in-range `BIGINT` | `number` |
| `BIGINT` beyond ±2^53 | `string` |
| `NUMERIC`, `DECIMAL`, `DECFLOAT`, `INT128` | `string` |
| `DATE`, `TIME`, `TIMESTAMP` | ISO-8601 `string` |
| `BLOB SUB_TYPE TEXT` | `string` |
| `BLOB SUB_TYPE BINARY` | base64 `string` |

Which means a money column is a string, and `+` will concatenate it:

```ts
const { rows } = await db.query('SELECT price FROM items');
rows[0].PRICE + 1;              // "20.251"  ← string concatenation
Number(rows[0].PRICE) + 1;      // 21.25     ← loses exactness for big values
```

Use a decimal library, or do the arithmetic in SQL where it stays exact.

To tell an exact number from text, read the column description:

```ts
const { fields } = await db.query('SELECT price FROM items');
// { name: 'PRICE', typeName: 'NUMERIC', scale: -2, length: 8, nullable: true }
```

`typeName` reports `NUMERIC` whenever the scale is non-zero, because Firebird
stores `NUMERIC` as a scaled integer — the raw type code alone would say
`BIGINT`.

---

## 6. Transactions, scripts, persistence

### Transactions

```ts
await db.transaction(async (tx) => {
  await tx.exec('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 1]);
  await tx.exec('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 2]);
});
```

Committed when the callback returns, rolled back if it throws. To abandon a
transaction without raising an error, call `tx.rollback()` — the wrapper will
not then try to commit.

Statements issued on `tx` are bound to that transaction. Statements on `db`
are not, so a rollback will not undo them.

`isolationLevel` and `readOnly` are honoured:

```ts
await db.transaction(async (tx) => {
  const { rows } = await tx.query('SELECT SUM(amount) AS total FROM ledger');
  await tx.exec('INSERT INTO audit (total) VALUES (?)', [rows[0].TOTAL]);
}, { isolationLevel: 'SNAPSHOT' });

// A read-only transaction is enforced by the engine, not merely advisory.
await db.query('SELECT * FROM ledger', [], { readOnly: true });
```

`SNAPSHOT` gives the transaction a stable view: work another transaction
commits after it starts is invisible to it. `READ_COMMITTED` sees such commits.
`SNAPSHOT_TABLE_STABILITY` maps to Firebird's `CONSISTENCY`.

Passing options to `query()` runs the statement inside its own transaction
carrying them, which costs one extra round trip to the Worker. Without options
the engine's auto-commit transaction is used instead.

### Multi-statement scripts

`exec()` splits on statement boundaries, respecting string literals, quoted
identifiers, comments and `SET TERM` — so a stored procedure body full of
semicolons survives:

```ts
const results = await db.exec(`
  CREATE TABLE a (id INTEGER);
  CREATE TABLE b (id INTEGER);
  INSERT INTO a VALUES (1);
`);
results.map((r) => r.affectedRows);  // [0, 0, 1]
```

Each statement runs in its own transaction and commits on success, so a
failure part-way leaves the earlier statements committed — as in `isql`. For
all-or-nothing migrations use `transaction()`.

Parameters are rejected for multi-statement scripts: there is no way to say
which statement a value belongs to.

### Persistence

The database is written to IndexedDB automatically, 500 ms after the last
write, plus a best-effort flush when the page is hidden.

```ts
const db = new FirebirdBrowser('mydb', {
  worker,
  autoPersist: true,          // default
  autoPersistDebounceMs: 500, // default
  onPersistError: (err) => report(err),
});

await db.persist();  // force one now
```

Each persist writes the whole image in a single IndexedDB transaction, and
only pages that changed are rewritten. All-or-nothing matters: a tab closed
mid-write leaves the previous image intact rather than a half-updated file.

Handle `onPersistError`. Background persists have no caller to reject into,
and the default merely logs — which is silent data loss in production.

Import and export whole databases through the VFS:

```ts
import { IndexedDBVFS } from 'firebird-wasm/browser';

const vfs = new IndexedDBVFS();
await vfs.open('mydb');
const snapshot = await vfs.exportDatabase();  // Uint8Array
await vfs.importDatabase(snapshot);
await vfs.close();
```

### Two tabs

Opening the same database in two tabs is refused by default:

```ts
import { DatabaseLockedError } from 'firebird-wasm/browser';

try {
  await db.query('SELECT 1 FROM RDB$DATABASE');
} catch (err) {
  if (err instanceof DatabaseLockedError) {
    showBanner('This app is already open in another tab.');
  }
}
```

This is not conservatism. Each tab holds a complete copy and writes the whole
image, so the later persist discards the other tab's work entirely — with both
tabs reporting success. Options:

| Option | Meaning |
|--------|---------|
| `multiTab: 'exclusive'` | Default. Refuse the second tab |
| `multiTab: 'allow-unsafe'` | Skip the lock. Only sound if at most one tab writes |
| `lockTimeoutMs` | How long to wait, default `5000`; `Infinity` waits |

Two tabs *sharing* one database is not supported yet — see
[roadmap.md](./roadmap.md) §M4.

---

## 7. Hosting without control of headers

Static hosts — GitHub Pages, most CDNs — will not send COOP/COEP. A service
worker can supply them, because it sits in front of the network for its own
scope and can re-issue every response with the headers attached.

`demo/public/coi-serviceworker.js` in this repository is a working
implementation, tested against the live GitHub Pages deployment. The essential
part:

```js
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).then((response) => {
    if (response.status === 0) return response;      // opaque
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers,
    });
  }));
});
```

Two caveats, both inherent to service workers rather than to this
implementation:

- **A service worker cannot control the load that registered it.** The first
  visit arrives un-isolated and must reload once. Show something during that
  moment rather than a blank page.
- **It needs a secure context** — HTTPS or `localhost`. Over plain HTTP there
  is no service worker and therefore no isolation.

When you test this, serve the site *without* COOP/COEP locally. A dev server
that helpfully sets the headers will make your app work locally and fail once
deployed, which is precisely the bug this arrangement exists to survive.

---

## 8. Node.js

Two backends share one API shape. The native driver talks to a real Firebird
server:

```ts
import { FirebirdLite } from 'firebird-wasm';

const db = new FirebirdLite('/var/lib/firebird/app.fdb', {
  username: 'SYSDBA',
  password: process.env.FIREBIRD_PASSWORD,
});
```

It requires Firebird's client library and a running server. For an embedded
engine in Node with no server at all, use `DirectTransport` — the same
transport the Worker uses, calling the exports in-process:

```ts
import { DirectTransport } from 'firebird-wasm/browser';

const engine = new DirectTransport();
await engine.init();
const dbh = await engine.createDatabase('/tmp/app.fdb');
const result = await engine.query(dbh, 0, 'SELECT 1 AS n FROM RDB$DATABASE');
```

Blocking the calling thread is fine in Node, so no Worker is needed.

---

## 9. Things that will bite you

**`crossOriginIsolated` is `false` and nothing works.** The headers are
missing, or a subresource is being blocked by `require-corp`. Check the
Network panel for blocked requests, and remember that headers set on a dev
server do not apply to a preview build.

**The page freezes on the first query.** The engine is on the main thread.
Pass a `worker`.

**`CHARACTER SET "SYSTEM"."SJIS_0208" is not installed`.** Only the built-in
character sets are compiled in. Use `UTF8`, which is.

**Arithmetic on a money column produces string concatenation.** See §5.

**Writes vanish after closing the tab.** Either `autoPersist` was disabled, or
the tab closed inside the debounce window. Call `persist()` at meaningful
points; the automatic flush on `visibilitychange` is best-effort because the
event cannot await an async write.

**A second tab throws `DatabaseLockedError`.** Working as intended — see §6.

**The build aborts inside `fb_create_database`.** Almost certainly a toolchain
mismatch. Build with the pinned Emscripten from
`packages/firebird-wasm/wasm/emsdk-version.txt`; the build script now refuses
anything else, but an artifact produced before that check may still be lying
around.

**`node:fs` ends up in your browser bundle.** Mark `*firebird-embedded.js`
external — see §4.

---

## 10. Verifying your integration

The suites in this repository are worth copying the *shape* of, whatever your
stack:

- Assert `crossOriginIsolated` is true before anything else. Every later
  failure is a red herring otherwise.
- Assert on **data**, not shapes. While the C API was stubbed, `fb_init()`
  returned 0 and `fb_query()` returned a well-formed empty result set — a
  shape-only check could not tell a working engine from a stub.
- Test against a server that does **not** set COOP/COEP if you rely on the
  service worker.
- If your app can be opened twice, test it with two pages in one browser
  context. They share an origin, so they contend for real.

To point the demo suite at your own deployment:

```bash
DEMO_BASE_URL=https://example.com/app/ npm run test:demo
```

---

## See also

- [porting.md](./porting.md) — how the engine was compiled, and what broke
- [browser.md](./browser.md) — the browser backend in detail
- [api.md](./api.md) — full API reference
- [roadmap.md](./roadmap.md) — status and what is planned
