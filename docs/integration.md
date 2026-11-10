# Using Firebird WASM in your project

A practical guide to putting the browser engine into a real application:
setup, hosting, bundlers, persistence, and the failure modes worth knowing
before you meet them.

- New to the project? Start with [README](../README.md), or
  **[try the demo](https://mariuz.github.io/electric-firebird/)**.
- Want to know how the port works? See [porting.md](./porting.md).
- Full type-by-type reference: [api.md](./api.md).

> **Status.** `firebird-wasm` is on npm and ships the compiled engine.
> Everything described here works and is covered by tests, but it is a 0.x
> release — the API may still move.

---

## 1. Installing

```bash
npm install firebird-wasm
```

The package ships the compiled engine, in two builds (§2), so there is
nothing to build:

```
node_modules/firebird-wasm/dist/wasm/firebird-embedded.js        ~100 KB
node_modules/firebird-wasm/dist/wasm/firebird-embedded.wasm      ~8.8 MB  (2.9 MB gzip, 2.1 MB brotli)
node_modules/firebird-wasm/dist/wasm/firebird-embedded-st.js     ~90 KB
node_modules/firebird-wasm/dist/wasm/firebird-embedded-st.wasm   ~8.7 MB  (2.9 MB gzip, 2.1 MB brotli)
```

Copy the build you load next to your Worker script, or point `locateFile` at
it — see §3. Serve the `.wasm` compressed, and expect it to dominate first
load; it caches normally afterwards. `npm run size -w packages/firebird-wasm`
prints these sizes, and CI fails a build that grows past the budget in
`scripts/size-budget.mjs`.

### From a CDN

Or copy nothing: jsDelivr and unpkg serve the published package, with the
headers a cross-origin isolated page needs (`Cross-Origin-Resource-Policy:
cross-origin`). `cdnArtifacts()` names the glue and gives the `locateFile` that
sends its `.wasm` there too, at this package's exact version:

```js
// the engine Worker, served from your own origin
import { cdnArtifacts } from 'firebird-wasm/browser';
const { glueUrl, locateFile } = cdnArtifacts();   // { cdn: 'unpkg' }, or a mirror's URL
importScripts(glueUrl);
self.FIREBIRD_WORKER_OPTIONS = { locateFile };
```

The `locateFile` is what a Worker needs: glue pulled in with `importScripts()`
looks for its `.wasm` next to the *Worker*. Glue loaded by `<script src>` from
the CDN finds it on its own. The Worker script itself must be on your origin:
the threaded build starts its own workers from it.

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

## 2. The two hard requirements, and the build without them

The package ships two builds of the engine (compared in full, with diagrams,
in [builds.md](./builds.md)):

| | `firebird-embedded.js` (threads) | `firebird-embedded-st.js` (no threads) |
|---|---|---|
| Needs a cross-origin isolated page | yes | no |
| Needs a Worker | yes | no: it can run on the page thread |
| Statement and idle timeouts | yes | no (they need the timer thread) |

The build without threads is the default (since 0.9.0): it runs anywhere,
starts in about a third of the time, and was not slower in anything measured.
The threaded build is the one to ask for when statement or idle timeouts
matter and the page can be isolated. Both requirements below are structural
for it; the build without threads has neither. `wasmGlueFile()` names the glue
to load:

```ts
import { wasmGlueFile } from 'firebird-wasm/browser';
// in the engine's Worker, or in the page:
importScripts(`/wasm/${wasmGlueFile()}`);                        // 'firebird-embedded-st.js'
importScripts(`/wasm/${wasmGlueFile(self.crossOriginIsolated)}`); // threads where allowed
```

In Node, `loadFirebirdWasm({ threads: true })` and
`new DirectTransport({ threads: true })` ask for the threaded build. Until
0.9.0 the default was the threaded build wherever it could run: in Node and in
an isolated page.

Loading the threaded build in a page that is not isolated fails at once, with
a message naming the other build, rather than hanging.

### Your page must be cross-origin isolated (threaded build)

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

### The engine must run in a Worker (threaded build)

Firebird blocks on mutexes while opening a database, and a browser main thread
is not allowed to block. Running the engine on the main thread deadlocks
reliably, not intermittently. The build without threads never blocks, so it
can run on the page thread, though a Worker still keeps long statements off
it.

```ts
const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});
```

Omitting `worker` is only appropriate in Node or a test harness driving a stub.

---

## 3. Wiring it up

Three files: the Worker entry, the engine assets, and your application code.
[`examples/vite`](../examples/vite) and [`examples/webpack`](../examples/webpack)
are complete apps built this way, and CI builds and runs both.

**The Worker** — two modules, bundled as a *classic* worker script. The first
loads the Emscripten glue and says where the `.wasm` is; the second starts the
engine, and must come second, because it reads those settings as it loads:

```js
// engine-prelude.js
import { wasmGlueFile } from 'firebird-wasm/browser';

const base = new URL('/', self.location.href).href;   // where the engine files are served
importScripts(base + wasmGlueFile());                  // threaded if isolated, else the build without threads
self.FIREBIRD_WORKER_OPTIONS = { locateFile: (file) => base + file };
```

```js
// engine-worker.js
import './engine-prelude.js';
import 'firebird-wasm/browser/worker-entry';
```

The `locateFile` matters: glue pulled in with `importScripts()` looks for its
`.wasm` next to the *Worker script*, which a bundler puts somewhere like
`/assets/`. Resolve against your site's base instead, including a path prefix
such as the `/<repo>/` a GitHub project site is served from. With a bundler
that does not process the Worker (`demo/build.mjs` uses esbuild), the same two
settings can be prepended to the bundled entry as plain lines.

**Your code:**

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker(new URL('./engine-worker.js', import.meta.url)),
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

> **Column names come back uppercase unless quoted.** Firebird folds unquoted
> identifiers to upper case, so `SELECT title` yields `TITLE`. Use
> `SELECT title AS "title"` if you want it lowercase, and be consistent —
> quoted identifiers are case-sensitive from then on.

### React, Vue, Svelte 5, and SolidJS

`firebird-wasm/react`, `firebird-wasm/vue`, `firebird-wasm/svelte`, and
`firebird-wasm/solid` keep a component's rows in step with a query. All four
framework packages are optional peer dependencies: install the one you use.

```tsx
import { FirebirdProvider, useQuery, useLiveQuery } from 'firebird-wasm/react';

<FirebirdProvider db={db}><Notes /></FirebirdProvider>;

function Notes() {
  // Re-runs whenever a trigger posts 'notes' (POST_EVENT), or db.notify('notes').
  const { rows, error, loading } = useLiveQuery<{ ID: number; TITLE: string }>(
    'SELECT id, title FROM notes ORDER BY id',
    { events: ['notes'] },
  );
  if (error) return <p>{error.message}</p>;
  if (loading) return <p>Loading…</p>;
  return <ul>{rows!.map((n) => <li key={n.ID}>{n.TITLE}</li>)}</ul>;
}

function Note({ id }: { id: number }) {
  // Runs once, and again when `id` changes.
  const { rows } = useQuery('SELECT title FROM notes WHERE id = ?', [id]);
  return <h1>{rows?.[0]?.TITLE}</h1>;
}
```

```ts
import { FIREBIRD, useLiveQuery, useQuery } from 'firebird-wasm/vue';

app.provide(FIREBIRD, db); // or provideFirebird(db) in a parent's setup()

// in setup(): refs, and the statement or parameters may be refs or getters
const { rows } = useLiveQuery('SELECT id, title FROM notes ORDER BY id', { events: ['notes'] });
const { rows: note } = useQuery('SELECT title FROM notes WHERE id = ?', () => [props.id]);
```

Svelte 5 (`setFirebirdContext`, `createQuery`, `createLiveQuery` from
`firebird-wasm/svelte`) and SolidJS (`setFirebirdContext`, `useFirebird`,
`createQuery`, `createLiveQuery` from `firebird-wasm/solid`) follow the same
pattern.

All four return `rows` (`undefined` until the first result), `error`, `loading`
and `refresh()`. Other SQL or parameters run the query again; equal
parameters in a new array do not. While the new result loads, the previous
rows stay, so a list does not blank out. A result that arrives after the
component moved on, or unmounted, is dropped, and an unmounted component's
live query is unsubscribed. Pass `{ db }` to a hook to use a database other
than the provided one.

`events` is optional on `db.live()` and `useLiveQuery()` / `createLiveQuery()`:
when omitted, `extractReferencedTables()` detects user tables read by the SQL
statement and installs an idempotent `FB_LIVE$<hash>` trigger once per table.
You can also pass explicit `{ events: ['notes'] }` for custom `POST_EVENT`
triggers or `db.notify('notes')`:

```sql
CREATE TRIGGER notes_changed FOR notes AFTER INSERT OR UPDATE OR DELETE
AS BEGIN POST_EVENT 'notes'; END
```

### ORMs, State Adapters, Vector HNSW, Full-Text Search & Replication

- **`firebird-wasm/kysely`**: Provides `FirebirdDialect` (`createKysely(db)`),
  translating `LIMIT`/`OFFSET` to `OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`, plus
  `generateKyselyTypes(db)` to emit a TypeScript `Database` interface from live
  `db.introspect()` metadata.
- **`firebird-wasm/drizzle`**: Provides `drizzle(db)` and `firebirdTable(...)`
  plus `generateDrizzleSchema(db)` for code-generating table definitions.
- **`firebird-wasm/tanstack` & `firebird-wasm/rxdb`**: Official adapters for
  TanStack Query (`createFirebirdQueryOptions`, `connectFirebirdQueryClient`),
  TanStack DB (`createFirebirdCollection`), and RxDB (`getRxStorageFirebird`).
- **`firebird-wasm/vector` & `firebird-wasm/fts`**: Float32/Int8 vector codec,
  persistent HNSW ANN index (`HnswIndex`, `createVectorIndex`), SQL UDRs
  (`registerVectorFunctions`, `registerFtsFunctions`), Okapi BM25 inverted index
  (`Bm25Index`, `createFtsIndex`), and RRF `hybridSearch` combining BM25 +
  `vectorSearch`.
- **`firebird-wasm/replication`**: Logical/journal & native Firebird engine
  replication (`replicateDatabases`, CRDTs, multi-node mesh/hub, DLQ, PITR
  archives, time-travel) — see [replication.md](./replication.md).

### A SQL console & Inspector (`<firebird-repl>`)

`firebird-wasm/repl` is an interactive console and database inspector as a
custom element, so it works the same in a plain page, React, Vue, Svelte, or
Solid:

```js
import { defineFirebirdRepl } from 'firebird-wasm/repl';

defineFirebirdRepl();                    // registers <firebird-repl>; pass a name for another tag
const repl = document.createElement('firebird-repl');
repl.db = db;                            // in React: <firebird-repl ref={(el) => el && (el.db = db)} />
document.body.append(repl);
```

Ctrl+Enter (⌘+Enter) or the Run button runs what is typed. A script runs
statement by statement, `SET TERM` and PSQL included, and stops at the first
error. Rows come back as a table (the first 500 of a result), other
statements with what they changed, each with its time; ArrowUp on the first
line and ArrowDown on the last walk the history. `repl.run(sql)` runs SQL from
code and resolves with what each statement did, the same list the
`firebird-repl-run` event carries.

Click **Inspector** in the toolbar (or call `repl.toggleInspector()`,
`await repl.schema()`, `await repl.migrations()`, `await repl.profiler()`,
`await repl.replication()`) to browse tables, columns, indexes, triggers,
applied migrations, query latency/I/O metrics, visual query execution plan
trees, and replication journal/slot/DLQ status.

Values are written as text, never as HTML: a row cannot put markup in the
page. Colours follow the page's `color-scheme` and can be set through
`--firebird-repl-bg`, `-fg`, `-muted`, `-border`, `-error`, `-accent` and
`-font`. Nothing is defined on import, so the module is safe to import where
there is no DOM.

### Syncing from Postgres with Electric

`firebird-wasm/electric` keeps a Firebird table in step with a Postgres table
through [Electric](https://electric-sql.com), which streams Postgres changes
over HTTP. Install `@electric-sql/client` beside the package (an optional
peer dependency).

```js
import { syncShapeToTable, tableFromSchema } from 'firebird-wasm/electric';

// The app creates the table. tableFromSchema() writes a CREATE TABLE from the
// shape's schema (Electric's electric-schema header) to review and adjust.
await db.exec('CREATE TABLE items (id INTEGER NOT NULL PRIMARY KEY, title BLOB SUB_TYPE TEXT, done BOOLEAN)');

const sync = await syncShapeToTable(db, {
  shape: { url: 'https://electric.example.com/v1/shape', params: { table: 'items' } },
  table: 'items',
  shapeKey: 'items',     // where the position is kept; null starts over every time
});
await sync.upToDate;     // the first complete copy is in
// ... rows follow every Postgres commit until:
await sync.unsubscribe();
```

- **Writes go through your API.** Electric takes no writes: write through
  your own API to Postgres, and the change comes back down the shape.
  `createWriteQueue` (below) shows the write at once while it does, and
  supports custom conflict resolution via `onConflict`.
- **Consistent.** Each batch Electric marks complete is applied in one Firebird
  transaction together with the sync position (kept in a table
  `ELECTRIC_SHAPES`), so after a reload the next sync with the same
  `shapeKey` resumes exactly where the stored database is. When Electric
  says the shape must be fetched again (a `TRUNCATE`, an expired shape), the
  table is emptied and refilled in one transaction.
- **Several tables & relational FK order.** `syncShapesToTables` and
  `syncShapes` keep several tables in step in one sync and apply each batch to
  all of them in one Firebird transaction; `syncShapes` also orders parent and
  child tables by their declared `relations` so foreign-key constraints are
  never violated during inserts or deletes.

### Syncing from a Firebird server

Electric reads only Postgres. For a table on a **Firebird server**,
`firebird-wasm/electric-server` stands in its place: a Node handler that
serves the server's tables over Electric's protocol, so the browser side is
the same `syncShapeToTable`.

```js
// Node, next to the Firebird server (needs node-firebird-driver-native)
import * as http from 'node:http';
import { createShapeServer } from 'firebird-wasm/electric-server';

const shapes = await createShapeServer({
  database: 'localhost:/data/app.fdb',
  username: 'SYSDBA',
  password: process.env.FIREBIRD_PASSWORD,
  tables: ['items'],           // each needs a primary key
});
http.createServer(shapes.handler).listen(3000);

// the browser: as with Electric
await syncShapeToTable(db, {
  shape: { url: 'http://localhost:3000/v1/shape', params: { table: 'items' } },
  table: 'items',
  shapeKey: 'items',
});
```

Supports `where` pushdown (joined directly into the snapshot and incremental
log SQL), `replica=full` old-row images on updates/deletes, and
`shapes.applyWrite(mutation)` (also exposed via `POST /v1/shape?table=...`) for
conflict-checked optimistic write ingestion.

---

## 4. Bundlers

The Worker must be a real, separately-built file; `new Worker(new URL(...,
import.meta.url))` gets Vite and webpack to build it. The awkward part is that
the loader has a Node branch that `require()`s the Emscripten glue
(`../dist/wasm/firebird-embedded.js` and `-st.js`); browsers never take it, but
bundlers resolve string-literal requires eagerly and drag `node:fs` into your
bundle. Mark both external — in the Worker's bundle too. Either way, copy the
four engine files out of `node_modules/firebird-wasm/dist/wasm/` to be served
verbatim (the examples' `copy-engine.mjs` does it).

### Vite

```js
// vite.config.js — Vite 8, which bundles with Rolldown (rollupOptions before it)
const GLUE = [/firebird-embedded(-st)?\.js$/];
export default defineConfig({
  build: { rolldownOptions: { external: GLUE } },
  worker: { rolldownOptions: { external: GLUE } },   // the Worker is a bundle of its own
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

Copy the engine files into `public/` so they are served verbatim.

### webpack

```js
// webpack.config.js — the keys are the require strings inside the package
export default {
  externals: {
    '../dist/wasm/firebird-embedded.js': 'commonjs ../dist/wasm/firebird-embedded.js',
    '../dist/wasm/firebird-embedded-st.js': 'commonjs ../dist/wasm/firebird-embedded-st.js',
  },
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
| `number`, `string` | text, converted by the engine (plus exact binary `INT64` / `DOUBLE` alongside) |
| `boolean` | `TRUE` / `FALSE` |
| `Date` | ISO-8601 |
| `null`, `undefined` | SQL `NULL` |
| `Uint8Array`, `ArrayBuffer` | the bytes themselves, into a `BLOB` or a `BINARY` / `VARBINARY` (`OCTETS`) column; any other column refuses them |
| `NaN`, `Infinity`, plain objects | **throws** |

### Reading values back

Anything a `double` cannot hold arrives as an **exact decimal string**:

| Firebird type | JavaScript |
|---------------|------------|
| `SMALLINT`, `INTEGER`, in-range `BIGINT` | `number` |
| `BIGINT` beyond ±2^53 | `string` |
| `NUMERIC`, `DECIMAL`, `DECFLOAT`, `INT128` | `string` |
| `DATE`, `TIME`, `TIMESTAMP` | ISO-8601 `string` |
| `BLOB SUB_TYPE TEXT` | `string` |
| `BLOB SUB_TYPE BINARY`, `BINARY`, `VARBINARY` (`OCTETS`) | base64 `string` (or `Uint8Array` with `types: { binary: true }`) |

### Richer types, opt-in

`types` converts values on the way out. Off by default, because each conversion
gives something up:

```ts
const db = new FirebirdBrowser('mydb', {
  worker,
  types: { bigint: true, binary: true, dates: true },
});
```

| Option | Effect | What it costs |
|--------|--------|---------------|
| `bigint` | `BIGINT` → `bigint`, always | Nothing, but `NUMERIC` keeps its string — it shares `BIGINT`'s storage and a `bigint` would drop the scale |
| `binary` | Binary `BLOB` → `Uint8Array` | Nothing. Base64 is 33% larger than the bytes and has to be decoded anyway |
| `dates` | `DATE`, `TIMESTAMP` → `Date` | **Precision and zone** — 100 µs truncated to 1 ms, interpreted as UTC |

---

## 6. Transactions, scripts, persistence

### Transactions & Savepoints

```ts
await db.transaction(async (tx) => {
  await tx.exec('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 1]);
  await tx.exec('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 2]);
});
```

Committed when the callback returns, rolled back if it throws. To abandon a
transaction without raising an error, call `tx.rollback()` — the wrapper will
not then try to commit. Use `tx.savepoint(fn)` for nested savepoints inside an
active transaction.

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

### Two tabs

Opening the same database in two tabs is refused by default (`multiTab: 'exclusive'`),
or transparently shared across tabs with `multiTab: 'shared'`:

| Option | Meaning |
|--------|---------|
| `multiTab: 'exclusive'` | Default. Refuse the second tab with `DatabaseLockedError` |
| `multiTab: 'shared'` | Elect one leader tab to run the engine and serve follower tabs over `BroadcastChannel`, with automatic failover and cross-tab `live()` event notifications |
| `multiTab: 'allow-unsafe'` | Skip the lock. Only sound if at most one tab writes |
| `lockTimeoutMs` | How long to wait, default `5000`; `Infinity` waits |

---

## 7. Hosting without control of headers

Static hosts — GitHub Pages, most CDNs — will not send COOP/COEP. The simplest
answer is the build without threads (§2): it needs no isolation, so there is
nothing to supply. What it gives up is statement and idle timeouts.

To keep the threaded build, a service worker can supply the headers, because
it sits in front of the network for its own scope and can re-issue every
response with the headers attached.

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
engine in Node with no server at all, use `FirebirdBrowser` (which falls back
to in-memory storage when `indexedDB` is absent) or `DirectTransport`:

```ts
import { DirectTransport } from 'firebird-wasm/browser';

const engine = new DirectTransport();
await engine.init();
const dbh = await engine.createDatabase('/tmp/app.fdb');
const result = await engine.query(dbh, 0, 'SELECT 1 AS n FROM RDB$DATABASE');
```

---

## 9. Things that will bite you

**`crossOriginIsolated` is `false` and nothing works.** The headers are
missing, or a subresource is being blocked by `require-corp`. Check the
Network panel for blocked requests, or use the default single-threaded build
(`firebird-embedded-st.js`).

**The page freezes on the first query.** The engine is on the main thread.
Pass a `worker`.

**`CHARACTER SET "SYSTEM"."SJIS_0208" is not installed`.** Only the built-in
character sets are compiled in by default. Use `UTF8`, or load an ICU locale
collation pack via `loadIcuLocaleData()`.

**Arithmetic on a money column produces string concatenation.** See §5.

**Writes vanish after closing the tab.** Either `autoPersist` was disabled, or
the tab closed inside the debounce window. Call `persist()` at meaningful
points, or use `opfs://mydb`.

**A second tab throws `DatabaseLockedError`.** Working as intended — see §6, or
enable `multiTab: 'shared'`.

**`node:fs` ends up in your browser bundle.** Mark `*firebird-embedded*.js`
external — see §4.

---

## 10. Verifying your integration

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
