# Changelog

All notable changes to `firebird-wasm`. This project follows
[semantic versioning](https://semver.org/); while the major version is 0 the
API may still move between minor releases.

## Unreleased

### Added

- **Bytes as parameters.** A `Uint8Array` or `ArrayBuffer` binds as its own
  bytes into a `BLOB` or a `BINARY` / `VARBINARY` (`OCTETS`) column, on both
  backends and by every route (`exec`, `query`, transactions, `execBatch`).
  The browser engine marks the bytes as bytes, so any other column refuses
  them instead of reading them as text; `FirebirdLite` hands them to the
  driver as a `Buffer`. They used to throw.
- **`bytea` syncs.** `firebird-wasm/electric` decodes Electric's `\x…` hex
  into bytes, and `tableFromSchema` maps `bytea` to `BLOB SUB_TYPE BINARY`
  (`VARCHAR(255) CHARACTER SET OCTETS` in a key). The shape server serves a
  binary `BLOB`, `BINARY` and `VARBINARY` as `bytea`, byte for byte.
- **`syncShapesToTables`: several tables, one transaction per batch.** The
  shapes are followed together and each batch is applied to every table in
  one Firebird transaction with every shape's position, so a Postgres
  transaction that wrote to two tables never shows in one of them alone. A
  batch waits until every shape has reached up-to-date after its last change,
  and until all are at the same `global_last_seen_lsn` where the server sends
  it; a shape behind is refreshed. The shape server now sends
  `global_last_seen_lsn` (its log position) as Electric does.
  `syncShapeToTable` is the one-shape case of the same code.
- **A write path: `createWriteQueue`.** `insert`, `update` and `delete`
  apply to the synced table at once and are recorded in `ELECTRIC_WRITES`
  in the same transaction (so they survive a reload and an offline spell),
  then go to the app's API through `send`, in order, retried on failure. A
  sync given `writes` applies the pending writes again after every batch, so
  the source's older state never shows over them, and drops each write once
  its change comes back: by the transaction id `send` returned (Electric's
  `txids`, which the shape server now sends too), by the row changing, or
  after `confirmTimeoutMs`. A `WriteRejected` rolls the write back by
  fetching the table's shape again. Syncs and the queue now run their
  transactions on a database one at a time.
- **The shape server takes `where`, pages its snapshots, prunes its log,
  wakes on events, and runs beside others.**
  - `where` (and Electric's `params[n]`) is parsed and written as Firebird
    SQL with every value bound; functions, casts and subqueries are refused
    with a 400. Each `where` and `columns` is a shape with its own handle,
    and a row that stops matching leaves as a delete.
  - Snapshots are served `snapshotPageRows` (10 000) rows a response, by
    key.
  - The log is pruned of changes older than `retainLogMs` (7 days), or by
    `prune(before)`; a client further behind is sent back to a snapshot.
  - Commits wake live requests through the `ELECTRIC_CHANGES` event, with
    polling (now every 1 s) as the fallback.
  - Numbering takes a lock, so several servers can serve one database.
- **An example app that syncs from two servers:
  [`examples/electric`](./examples/electric).** Two lists of notes, each a
  table in the page's Firebird: one follows Postgres through Electric, the
  other a Firebird server through `firebird-wasm/electric-server`. Writes go
  to the source and come back down the shape; `db.live()` draws the lists;
  `<firebird-repl>` queries the local copy. A Node server and a
  `docker-compose.yml` run the sources. CI runs it in Chromium against real
  containers, with both engine builds.

### Fixed

- **The browser engine reads `BINARY` and `VARBINARY` (`OCTETS`) values as
  bytes**, as it reads a binary `BLOB`: base64 by default, a `Uint8Array`
  with `types: { binary: true }`. They were read as text, which turned bytes
  that are not UTF-8 into replacement characters (`GEN_UUID()` among them).
- **Two `syncShapeToTable` calls started together on a new database no
  longer stop one of them.** Both found no `ELECTRIC_SHAPES` table and both
  created it; the second creation failed ("unsuccessful metadata update")
  and that sync stopped before it began. The loser now looks again and goes
  on with the table the other made. Found by the example, which starts its
  two syncs at once.
- **Closing a shape server while a live request waits no longer crashes the
  process.** `close()` disconnected at once, and a waiting live request's next
  poll started a transaction on the closed connection, where the native
  client segfaults rather than throwing. `close()` now waits for whatever is
  running on the connection, and the requests still waiting end with a 503.
  Found as an intermittent crash of `browser-firebird-shapes.spec.ts`, which
  closes its server while the browser is still following it.

## 0.8.0 — 2026-10-18

### Security

- **Importing the library no longer starts an engine server, and a page's
  window is never served.** `firebird-wasm/browser` re-exported
  `serveEngine` from the Worker entry, which started serving as soon as it
  was loaded wherever `self.postMessage` existed, and a page's `window` has
  one. So every page that imported the library listened for engine requests
  on its window. With the engine on the page thread (the build without
  threads, new in 0.7.0) that listener shared the page's engine, and any
  window able to `postMessage` to the page, a frame or an opener of another
  origin, could run SQL against its databases. With the engine in a Worker it
  had no engine to reach. Now `serveEngine` lives in a module without side
  effects, the Worker entry starts only in a dedicated Worker, and
  `serveEngine` refuses a scope that has a `document`. Upgrade from 0.7.0 if
  you run the engine on the page thread.

### Added

- **`firebird-wasm/electric-server`: a Firebird server's tables over
  Electric's protocol.** `createShapeServer({ database, tables })` returns a
  Node HTTP handler that `syncShapeToTable` syncs from as it would from
  Electric, so a table on a Firebird server reaches Firebird in the browser
  with no Postgres. Triggers log each changed row's key; the server numbers
  the log in commit order before every read, so a transaction that wrote
  first and committed last is never skipped, and a connection opened before
  the capture was installed is captured too. Tested on Firebird 3, 4 and 5,
  and end to end into the engine in Chromium.
- **`firebird-wasm/electric`: sync a Postgres table through Electric.**
  `syncShapeToTable(db, { shape, table, shapeKey })` keeps a Firebird table in
  step with an Electric shape: each batch Electric marks up-to-date applied in
  one transaction with the sync position, a resume from that position after a
  reload, a full reload in one transaction on must-refetch, Postgres text
  converted exactly per column type (and unmapped types refused by name), and
  an event per batch for `live()` and the hooks. `tableFromSchema()` writes a
  `CREATE TABLE` from a shape's schema to review. Read-only, as Electric is.
  `@electric-sql/client` is an optional peer dependency. Tested against a real
  Postgres and Electric in CI. A Postgres `int8` is bound as its text, which
  converts into `BIGINT` exactly and which the Node driver can bind.
- **`firebird-wasm/repl`: a SQL console as a custom element.**
  `defineFirebirdRepl()` registers `<firebird-repl>`; give it a database
  through its `db` property. Ctrl+Enter runs a script statement by statement
  (`SET TERM` included) and stops at the first error; rows show as a table,
  other statements with the rows they changed; ArrowUp and ArrowDown walk the
  history. Values are drawn as text, never as HTML. A `db` set before the
  element was defined, as frameworks do, is kept.
- **`firebird-wasm/react` and `firebird-wasm/vue`.** `useQuery` runs a
  statement and re-runs it when its SQL or parameters change by value;
  `useLiveQuery` re-runs it each time one of its events fires (`live()`
  under a hook). Both give `rows`, `error`, `loading` and `refresh()`, keep
  the previous rows while the next ones load, drop results that arrive after
  the component moved on, and unsubscribe on unmount, StrictMode's double
  mount included. React through `FirebirdProvider`, Vue through
  `provideFirebird(db)` or `app.provide(FIREBIRD, db)`; the statement and
  parameters may be refs or getters in Vue. React 18+ and Vue 3.3+ are
  optional peer dependencies.
- **`examples/vite` and `examples/webpack`.** Minimal apps built by their own
  bundlers from the package, run by CI in Chromium with and without
  cross-origin isolation.

### Fixed

- **`FirebirdLite` binds a string into a DATE, TIME or TIMESTAMP parameter,
  exactly.** The native driver takes a JS `Date` there and failed on a string
  (`date.getFullYear is not a function`), so `firebird-wasm/electric`'s
  `syncShapeToTable`, which sends dates and times as text, could not write to
  a `FirebirdLite` database. Such a string is now sent as text and Firebird
  converts it, as the browser engine does: to 1/10000 s, with no detour
  through milliseconds or the process's time zone, and `WITH TIME ZONE` too
  (with a Firebird 4 or later client library). A `Date` binds as before.
- **`FirebirdLite` binds a string into an integer or NUMERIC parameter digit
  for digit.** The driver binds those as doubles: `'9007199254740993'` into
  a BIGINT arrived as 9007199254740992, and `syncShapeToTable` sends `int8`
  and `numeric` as text. Such a string is now sent as text too; a JS number
  is unchanged, and `execBatch` declares a block's parameter as the column's
  own type rather than DOUBLE PRECISION.
- **A bad parameter beside a BLOB no longer kills the process.** The driver
  wrote a BLOB parameter while encoding the others, under a `Promise.all`
  that rejected as soon as one failed, and the transaction was rolled back
  under the blob's native calls: a date as a string, or a string too long for
  its VARCHAR, beside a BLOB ended Node with a segmentation fault (seen in
  Jest syncing a shape into a `FirebirdLite` database). `FirebirdLite` now
  writes the blob before the driver encodes anything, so the failure is the
  error it should be.
- **An event posted right after subscribing is no longer lost.** A
  subscription's first delivery from the engine is a baseline, not news, and
  the bridge absorbed whatever it said. With threads that delivery comes from
  the engine's watcher thread some time after the subscription returns, so a
  `POST_EVENT` that committed first was folded into it and never reported: a
  `live()` query missed its first change in about one browser run in three.
  Subscribing now waits for the baseline before returning (the build without
  threads delivered it in time already).
- **`live()` no longer drops an event heard during a refresh.** It ran one
  refresh at a time by ignoring events while one ran, but that refresh may
  have read before the change committed, so the rows stayed stale until some
  later event. An event during a refresh now earns exactly one more. `live()`
  also subscribes before its first query rather than after, so a change
  committed between the two is no longer in neither, and releases the
  subscription if that query fails.
- **`FirebirdLite` binds a string into a BLOB parameter.** The native driver
  takes a `Buffer` there and refused a string ("Unrecognized type used as
  BLOB"); a string bound to a BLOB parameter is now passed as its UTF-8
  bytes, in `exec`, `query`, transactions and `execBatch`. The browser engine
  had the same gap, fixed above.
- **A string binds into a BLOB parameter.** `INSERT INTO notes (body) VALUES
  (?)` with a `BLOB SUB_TYPE TEXT` column failed in the browser engine ("BLOB
  and array data types are not supported for move operation"): a BLOB
  parameter takes a blob's id, and the bridge only converted values. It now
  writes the text as a blob in the statement's transaction and binds its id,
  through `exec`, `query`, transactions and `execBatch` alike, with no size
  limit of its own (text parameters were capped at 64 KB). A batch with a
  BLOB parameter runs as one execute per row, since Firebird's batch takes no
  blob written outside it.
- **`firebird-wasm/browser/worker-entry` can be imported.** The package's
  `exports` did not list it, so the import the integration guide showed failed
  in any bundler that honours `exports` (Vite and webpack both). It is now
  exported, and so is `./package.json`.
- **`firebird-wasm/browser/worker-entry` imported with a bundler.** In a
  Worker that imported the library before setting
  `FIREBIRD_WORKER_OPTIONS`, the side effect above started the engine without
  them, so its `.wasm` was looked for next to the Worker script.
- **A `CHAR(n)` in UTF-8 reads back as n characters.** Firebird pads a
  `CHAR` to its length in bytes, four a character in UTF-8, and the browser
  engine returned all of them: a `CHAR(36)` holding a uuid came back as the
  uuid and 108 spaces. It is now cut to n characters, its own padding kept
  (`'ab'` in a `CHAR(5)` is `'ab   '`, `'žš'` is `'žš   '`), as other
  Firebird drivers return it. `OCTETS` and `NONE` columns, one byte a
  character, are unchanged.

### Changed

- **A quoted column name keeps its case in results.** `query` upper-cased
  every column name, so `SELECT title AS "title"` gave `TITLE`, unlike what
  the integration guide said, and `SELECT "camelCase" FROM t` gave
  `CAMELCASE`. Names are now as Firebird reports them, in the browser engine
  and in `FirebirdLite` alike: unquoted names are still upper case (Firebird
  folds them), so only quoted names change. Code that read a quoted name by
  its upper-cased key (`row.CAMELCASE`) must use the name as written
  (`row.camelCase`), or drop the quotes from the alias.

## 0.7.0 — 2026-10-18

### Fixed

- **A second open of the same database in one page is refused at once.** It
  used to wait out `lockTimeoutMs` (5 s by default) for a tab that did not
  exist and then report the database "already open in another tab"; in Node,
  which has no Web Locks, it was not refused at all, and two instances shared
  one file. The page now records the names it holds:
  `DatabaseLockedError.heldBy` is `'this-page'` and the message says so. An
  instance that fails to open now releases its name, so a new one can try
  again without closing the broken one first.

### Added

- **`cdnArtifacts()` and `VERSION`.** The engine's URLs on jsDelivr (or
  unpkg, or any mirror) at this package's exact version: the glue to
  `importScripts()` and the `locateFile` that sends its `.wasm` to the same
  place, which a Worker needs because imported glue looks for the binary next
  to the Worker. Both builds load this way; jsDelivr and unpkg send the
  `Cross-Origin-Resource-Policy` an isolated page needs for the threaded one.
- **A size budget.** `npm run size` prints each artifact raw, gzipped and
  brotli-compressed (each `.wasm` is 8.7–8.8 MB, 2.9 MB and 2.05 MB) and fails
  past 9.5 MB raw or 3.2 MB gzipped; CI runs it after every WASM build.

- **A build without threads.** `dist/wasm/firebird-embedded-st.{js,wasm}`
  needs no `SharedArrayBuffer`, so no cross-origin isolation and no
  COOP/COEP service worker, and no Worker either: nothing in it blocks, so it
  can run on a page's own thread. It gives up statement and idle timeouts,
  which need the engine's timer thread. Pick it with
  `loadFirebirdWasm({ threads: false })` (also on `DirectTransport` and
  `FirebirdBrowser`) in Node, and in a browser by loading its glue:
  `wasmGlueFile()` names the build a page can run. `hasSharedHeap(mod)` tells
  them apart. The threaded build stays the default, and loading it in a page
  that is not isolated now fails with a message instead of hanging. Against
  the threaded build, alternating: start 0.33–0.43 s against 0.87–1.06 s,
  one row of ten columns 34–49 µs against 54–76, a one-row update 28–41 µs
  against 45–66.

### Changed

- **A kept statement's columns are described once.** Every query wrote every
  column's description again (name, type, scale, length, nullable) and
  decoded it again in JS, which was most of what a small query cost. A kept
  statement's columns cannot change, so the C bridge now works out their
  layout and their JSON once and keeps them with the statement, and the JS
  keeps the decoded field list by that JSON; each call still gets field
  objects of its own. `bench:calls`, alternating with 0.6.1, two rounds:
  one row of ten columns 48–59 µs a call before, 34–40 now; ten columns and
  no row 35–40 before, 22–24 now; one value 24–34 before, 19–26 now. Needs a
  rebuilt artifact.
- **…and then named by an id.** With the new `fb_query` flag
  `FB_QUERY_SHAPE_IDS` (2), which `DirectTransport` sets, a kept statement's
  result is `{"shape":N,"rows":[…]}`, the columns being sent no more; the
  transport keeps what each id means and asks the new `_fb_shape_columns(N)`
  once for an id it has not seen. Ids are never reused, so a remembered one is
  never wrong. Without the flag, or for a statement that is not kept, results
  describe their columns as before. Same machine, the flag off and on
  alternating: the decode of ten columns and no row 5.7–7.0 µs before,
  1.1–1.4 now (779 bytes of JSON to 21); the whole query 22–28 µs before,
  16–21 now. Needs a rebuilt artifact.
- **Values are written without `snprintf`.** The C bridge decodes DATE, TIME
  and TIMESTAMP with the engine's own calendar arithmetic and writes them,
  integers, NUMERICs and doubles straight into the result with
  `std::to_chars`, instead of `IUtil` calls, `snprintf`, a temporary string
  and an escaping pass. Per value written, alternating with the previous
  artifact: TIMESTAMP 1.9 µs to 0.7, DATE 1.1 to 0.55, DOUBLE PRECISION 0.95
  to 0.65, INTEGER, BIGINT and NUMERIC 0.75–0.85 to 0.55. A double is now
  its shortest round-trip text (`0.1`, not `0.10000000000000001`), the same
  number when parsed; 3000 doubles and 98 708 rows of dates, times and
  numbers across years 1 to 9999 parse identically before and after. Needs a
  rebuilt artifact.
- **Garbage is collected by the statements, not by a thread.** Every database
  is opened with `GCPolicy = cooperative` (in the DPB). Under the engine's
  default, `combined`, a statement and the garbage collector thread fought
  over the same pages, and every handoff between them was a futex wait and
  wake between Web Workers: updating and reading back 300 rows took
  16.0–16.3 ms a round, and now takes 2.1–2.3. Smaller updates, bulk
  inserts, deletes and updates, and scans over a deleted table's garbage cost
  the same as before, and each database starts one thread fewer.
  `RDB$CONFIG` reports the setting with the source `<DPB>`. Needs a rebuilt
  artifact.

## 0.6.1 — 2026-10-10

### Changed

- **`execBatch` on Node sends up to 200 rows per round trip.** The Node
  driver binds no `IBatch` (nor does upstream `master`), so `FirebirdLite`
  packed nothing: one execute and one round trip per row. It now runs the rows
  as `EXECUTE BLOCK`s of up to 200, each repeating the statement with its
  parameters declared as the types the driver binds, so the values and their
  conversions are the ones a row-by-row execute makes. Against a local
  Firebird 3 server, alternating with the old loop, three rounds: three
  columns 152–174 µs a row before, 18–35 µs now; ten columns with a text
  `BLOB` 504–585 before, 245–319 now (each `BLOB` value still costs a round
  trip of its own). `INSERT`, `UPDATE`, `DELETE` and `EXECUTE PROCEDURE`
  without `RETURNING`; anything else runs row by row as before. A block that
  will not prepare is halved until it does, and a failing block's rows run one
  by one, so the error is the failing row's own and the batch stays all or
  nothing. The parameter types are read from the driver's statement
  internals; if those ever change shape, `execBatch` falls back to the loop.

## 0.6.0 — 2026-10-10

### Added

- **`statementCache` on `FirebirdLite`: prepared statements kept on Node.**
  `new FirebirdLite(path, { statementCache: 64 })` keeps the connection's
  last 64 prepared statements by SQL text, as the browser engine has since
  0.5.0, so a repeated statement skips the prepare, a round trip to the
  server. Measured against a local Firebird 3 server, off and with the cache
  alternating, three rounds each: a primary-key `SELECT` 1.3–2.1 ms off,
  1.0–1.1 ms with it (0.25–0.43 ms with `sharedReads` as well); an `UPDATE`
  through `exec()` 2.2–2.3 ms off, 1.6–1.9 ms with it. DDL run through the
  connection empties the cache first, a failed statement is dropped, and
  concurrent calls with the same text each get their own statement. Off by
  default: on a server, another connection's `DROP TABLE` waits while a
  kept statement reads the table, and a kept statement keeps running a
  procedure's old body after another connection alters it.

- **`sharedReads`: autocommit reads in a shared read-only transaction.** An
  option on `new FirebirdBrowser(name, { sharedReads: true })` and
  `new FirebirdLite(path, { sharedReads: true })`, off by default; on the
  module it is `_fb_read_transaction(dbHandle, on)`, per database (an
  `EngineTransport` supports it through the optional `setSharedReads`). On
  Node against a local Firebird 3 server a primary-key `SELECT` went from
  1.4–1.8 to 0.9–1.0 ms; there the shared transaction lives across
  consecutive reads only, because an open transaction that has read a table
  makes a server refuse `DROP TABLE` and `exec()` does not know it is running
  DDL. In the browser engine, when on, an autocommit `SELECT` runs in a
  READ COMMITTED READ CONSISTENCY read-only transaction each database keeps
  open, instead of starting and committing one around the call; each
  statement still reads everything committed before it starts. Measured from
  Node on the `firebird-quake2` demo1 database, off and on alternating, three
  rounds each: a primary-key `SELECT` 44–45 µs a call off, 20–22 µs on; a
  trivial `SELECT` 37–41 µs off, 15–16 µs on. A `SELECT` that writes is run
  again in its own transaction and remembered (its non-transactional effects,
  such as `RDB$SET_CONTEXT`, happen twice on that first call), and rows left
  in an `ON COMMIT DELETE ROWS` table outlive the call: see `docs/api.md`.
  Needs a rebuilt artifact.

### Fixed

- **Closing one database no longer rolls back another's transactions.**
  `fb_detach_database` rolled back every open transaction in the engine,
  not only the closing database's: the transaction table did not record
  which database a transaction was started on. With two databases open in
  one engine (two `FirebirdBrowser`s sharing a worker or a transport, or two
  handles on the module), closing one lost the other's work still open in a
  `transaction()`, and its commit then failed with "unknown transaction
  handle". Needs a rebuilt artifact.
- **`query('EXECUTE PROCEDURE …')` returns the procedure's outputs.** A
  procedure with output parameters has columns but no cursor. The browser
  engine opened a cursor for any statement with columns, so the call failed
  with "Cannot open cursor for non-SELECT statement"; the Node backend ran it
  as a plain execute and returned no rows, and inside `transaction()` its
  `executeQuery` refused it. Both now run it once and return its outputs as
  one row, in autocommit and inside a transaction. The browser fix needs a
  rebuilt artifact.

## 0.5.0 — 2026-10-10

### Changed

- **Prepared statements are kept, per database, by their SQL text.** Each
  database keeps its last 64 prepared statements, most recently used first,
  and `query()`, `exec()` and their transaction forms take them from there
  instead of preparing on every call. Only `SELECT`, `INSERT`, `UPDATE`,
  `DELETE` and `EXECUTE PROCEDURE` / `EXECUTE BLOCK` are kept; DDL is never
  kept and empties the database's cache before it runs, a statement whose
  execution fails is dropped, and closing frees them all. Measured on a
  one-row primary-key `SELECT` from Node (two runs each, alternating with
  0.4.2): inside a transaction 45–47 µs a call before, 25–36 µs now; in
  autocommit, where starting and committing a transaction per call is now the
  larger cost, 60–63 µs before and 46–47 µs now. `_fb_statement_cache(size)`
  on the module sets the size (0 turns it off) and empties the caches, which
  is also how to drop statements made stale by DDL run inside an
  `EXECUTE STATEMENT`, which the cache cannot see. Needs a rebuilt artifact.

### Fixed

- **The root entry loads without the native driver.** `firebird-wasm` imported
  `node-firebird-driver-native` at the top of the module, so an install with
  `--omit=optional` (the one the README recommends for the browser engine)
  could not `require('firebird-wasm')` at all: `sql`, `statementKind` and
  `loadFirebirdWasm` failed with a bare `MODULE_NOT_FOUND` along with
  `FirebirdLite`. The driver is now loaded when a `FirebirdLite` first
  connects, and its absence there is an error that names the package and the
  `firebird-wasm/browser` alternative.

## 0.4.2 — 2026-10-10

A maintenance release: the published TypeScript and the engine artifact behave
exactly as in 0.4.1. What changed is building and checking the project.

### Fixed

- **`wasm/build.sh` survives a rebuild on a stock machine.** It checks for the
  host's ICU headers before the native bootstrap and names the package to
  install, where the build used to die minutes in with `unicode/ucnv.h: No such
  file`. An empty `dsql/parse.cpp` placeholder lets CMake 3.28's generate step
  pass (it stopped with no Makefile at all); the parse target overwrites it.
  And `autoconfig.h` is refreshed from the native build on every run, so a
  rebuild that has to make `gpre_boot` again no longer compiles that native
  tool against the 32-bit WASM edits (`conflicting declaration 'typedef int
  ISC_LONG'`).

### Internal

- **The linter runs.** `npm run lint` had a script and dependencies but no
  configuration; `.eslintrc.cjs` now applies `eslint:recommended` and
  `@typescript-eslint/recommended`, and CI runs it on every pull request. Its
  two findings are fixed: an unused type import, and a deliberate `require` in
  the Node test that now says why.
- **Roadmap** updated with what `firebird-quake2` measured, and live queries
  marked done.

## 0.4.1 — 2026-10-10

### Changed

- **`execBatch` runs on Firebird's `IBatch`.** The rows' messages are packed
  at the metadata's aligned stride into one buffer and handed to the engine as
  one batch request, where 0.4.0 executed the prepared statement once per row.
  Measured in Node on the same artifact build: 5,000 rows of five columns take
  41–55 ms (65–71 ms in 0.4.0; 127–136 ms as one `exec()` per row inside a
  transaction). In `firebird-quake2`'s map load, which 0.4.0's batch had left
  13 % slower than its PSQL chunk loaders (each row was still a statement
  execute inside the engine, while a procedure's `INSERT` is a node of one
  compiled request), the batch is now 5 % faster than those loaders, with
  the 37,000-row `face_verts` table a quarter faster. The row that fails is
  still named, the record count still covers the whole batch, and a statement
  without parameters still runs once per row. Needs a rebuilt artifact: the
  TypeScript is unchanged.

## 0.4.0 — 2026-10-10

### Added

- **Typed (binary) parameter binding in the browser.** A `number` or an
  in-range `bigint` now crosses to the engine with its binary form beside its
  text, and the engine binds the binary form where it is the exact one: a
  double for a `DOUBLE PRECISION`/`FLOAT` parameter, an `INT64` for a
  `SMALLINT`/`INTEGER`/`BIGINT` one. Everything else keeps the text, so a
  `NUMERIC`, `VARCHAR` or date destination is bound exactly as before. The
  reason: Firebird's text-to-double conversion is off by one ulp for about one
  value in six (490 of 3,000 measured), which a consumer had been working
  around by sending every double as mantissa and exponent. The packed
  buffer's per-parameter null byte became a flags byte: the new bridge still
  reads buffers from older TypeScript, but an older artifact cannot read the
  new buffer, so `dist/wasm` must be from this build or later.

- **`db.execBatch(sql, rows)` and `tx.execBatch(sql, rows)`.** One statement,
  prepared once, run for every row of parameters in one transaction, all or
  nothing, with a failing row named in the error. In the browser every row
  crosses to the engine in a single call (`fb_execute_batch`): 5,000 rows of
  five columns take 65 ms, against 130 ms as one `exec()` per row inside a
  transaction. On the Node backend it prepares once and loops.

### Documented

- [`docs/plans/sab-free-build.md`](docs/plans/sab-free-build.md): what a
  build without `SharedArrayBuffer` would take, why it is not a link flag, and
  the route to one. Such a build would free consumers from COOP/COEP headers
  and the service workers that exist only to supply them.

## 0.3.0 — 2026-08-12

### Added

- **`db.listen(names, cb)` and `db.notify(name)`.** The event pair on its own:
  `listen()` reports only the names that fired, each with a count — Firebird
  counts events rather than queueing them, so two posts in quick succession
  arrive as one call with a count of 2 — and `notify()` posts one without
  needing a trigger, binding the name rather than interpolating it. `live()` is
  now built on `listen()` rather than beside it, so the subscription, polling
  and teardown exist once.

- **Live queries — `db.live(sql, { events }, onChange)`.** Re-runs a statement
  when a named `POST_EVENT` fires, with `onChange` called once immediately so
  there is no separate initial-value path. Event names are the caller's to
  give: nothing in Firebird connects a posted event to the tables a query
  reads. Unblocked by fixing event delivery under Emscripten — the engine had
  delivered exactly one event per subscription and then stopped.

- **OPFS storage — `opfs://name`.** The engine's own page reads and writes land
  in an Origin Private File System file, through a custom Emscripten filesystem
  backed by `FileSystemSyncAccessHandle`. Unlike the IndexedDB path there is no
  image copy and no persist step: `persist()` is a no-op because the bytes were
  already written, and the database is not bounded by what fits in memory. Needs
  a Worker — sync access handles exist nowhere else — and says so plainly if it
  does not have one. No cross-tab Web Lock either: OPFS refuses a second handle
  on the same file itself, which is a stronger guarantee than the lock it
  replaces.

- **`dumpDataDir()` and `loadDataDir`.** `db.dumpDataDir()` returns the
  database as a `Uint8Array`, read from the live engine filesystem rather than
  from IndexedDB — so writes that have not been persisted are included, and a
  `memory://` database can be dumped at all. `new FirebirdBrowser(name, {
  loadDataDir })` seeds a database that does not exist yet. A stored database
  always wins: an application passes the option on every load, so a seed that
  replaced what was there would reset the user's data to the snapshot on every
  reload. To load a snapshot regardless, open it as `memory://`.

- **`memory://` databases.** `new FirebirdBrowser('memory://')` opens a
  database that is never stored: no IndexedDB store is created — not even an
  empty one — no cross-tab lock is taken, `persist()` is a no-op, and the file
  is discarded on `close()`. The engine has always run from memory, so this
  removes the durability copy rather than adding a mode. Two instances of one
  `memory://name` are two databases: every instance in a page shares one WASM
  filesystem, and a shared path would silently join two callers who each
  believe they own theirs. No equivalent on the Node backend, where Firebird
  has no in-memory engine.

- **Binary BLOBs travel beside the JSON, not inside it.** With
  `types: { binary: true }` the engine now publishes binary `BLOB` bytes in a
  side buffer and leaves a `{"$blob": N}` reference in the result, instead of
  base64 inside the JSON. Same `Uint8Array` values a caller already got; 6.3×
  faster to decode on a blob-heavy result set (11.3 ms → 1.8 ms on 500 rows of
  4 KB), with the JSON shrinking from 2.61 MB to 1.96 MB across both channels.
  Across a Worker the buffers are transferred rather than cloned, which a
  base64 string could never be. Nothing changes for callers who did not opt in:
  the side channel is a flag on the query, off by default, and they still get
  base64.

- **`describeQuery()`.** Reports a statement's shape without running it:
  result columns, parameters, and what kind of statement it is
  (`'SELECT' | 'INSERT' | 'DDL' | …`). The statement is prepared and dropped,
  so describing an `INSERT` inserts nothing — asserted against the real engine
  rather than assumed. Needed a new C entry point, `fb_describe`, which reads
  the input and output metadata Firebird already has after a prepare; both are
  encoded in the same per-field shape result sets use, so one decoder reads
  either. On the Node backend `params` is `undefined` rather than `[]`: the
  native driver exposes no input metadata, and an empty array would claim the
  statement takes no parameters, which is a different and wrong statement about
  `WHERE id = ?`.

- **`rowMode: 'object' | 'array'`.** A per-query option on both backends:
  `'array'` returns each row as its values in column order, with the names
  still in `fields`. Two reasons, and the smaller one is speed — 1.11× on
  10,000 rows, because the generated constructor had already cut object
  building to a tenth of a decode that `JSON.parse` dominates. The real reason
  is that `SELECT a.ID, b.ID` has two columns and one `ID` key in object mode,
  where the second value wins and the first is unreachable; positional rows
  keep both. The mode travels with the query rather than being applied to the
  result, because with a Worker transport the decode happens on the far side.

- **Custom `parsers` and `serializers`.** `types: { parsers, serializers }` on
  `FirebirdBrowser` opens both conversion paths to application code. A parser
  is keyed by Firebird SQL type code and **replaces** the built-in conversion
  for that type, which is how `dates` gets overridden — useful for `TIMESTAMP`,
  where the built-in truncates the 100 µs Firebird stores and a parser can keep
  it. Parsers receive the `FieldInfo`, because a type code alone does not
  separate `NUMERIC` from `BIGINT` or a text BLOB from a binary one.
  Serializers are a *list* rather than a map keyed by type: an outgoing
  parameter has no declared type to key on — every value crosses as text and
  Firebird converts it — so each serializer inspects the value and declines by
  returning `undefined`. Neither is called for `null`. Browser backend only;
  the Node driver reports no column type codes, so there is nothing to key a
  parser on.

- **The `` sql`…` `` template tag.** Values interpolated into a tagged
  template become `?` parameters rather than text, so a value can never be read
  as SQL. Accepted by `query()` and `exec()` on both backends and inside
  transactions, in place of a `(sql, params)` pair. Fragments nest, which is
  what makes a conditional `WHERE` bearable. What cannot be a parameter gets
  three named helpers instead of one permissive one: `sql.identifier()` quotes
  a name (doubling any `"`), `sql.join()` expands a list into placeholders, and
  `sql.unsafe()` escapes nothing and says so at the call site. Passing a
  fragment together with parameters throws rather than binding values that
  could not reach a placeholder.

  `FirebirdLite.exec()` gained a `params` argument along the way — it had none,
  so a tagged fragment would have had nowhere to bind.

- **Opt-in typed result values.** `types: { bigint, dates, binary }` on
  `FirebirdBrowser` converts values on the way out: `BIGINT` → `bigint`,
  binary `BLOB` → `Uint8Array`, and `DATE`/`TIMESTAMP` → `Date`. Off by
  default; each conversion trades something away and the defaults are
  unchanged. `dates` loses 100 µs of precision and anchors to UTC, which is
  documented rather than discovered. `TIME` and the time-zone-carrying types
  are never converted, because `Date` cannot represent them.

- **`tx.rollback()` on the Node backend.** The browser backend has had it since
  0.1.0; the Node one had only `exec` and `query`, so abandoning a transaction
  there meant throwing an error you did not mean and catching it again. Both
  now behave the same way: the enclosing `transaction()` does not commit
  afterwards, the callback's return value is still returned, statements issued
  after a rollback throw rather than running outside any transaction, and
  `tx.isFinished` reports the state.

### Fixed

- **`query()` silently discarded `INSERT`, `UPDATE`, `DELETE` and DDL on the
  browser backend.** `fb_query` prepared such a statement, serialised the empty
  result and committed — without ever executing it — so the call reported
  success and wrote nothing. The Node backend has always executed them, so the
  same code wrote the row there and lost it in the browser. Found by a test
  written against the real engine.

- **Only the first event of a subscription was ever delivered.** Firebird's
  event manager caches the process block from `mapObject`, which mmaps the
  shared-memory file a second time; under Emscripten a second mmap of one fd is
  a private copy rather than an alias, so the watcher thread waited on a counter
  no poster could reach. It now uses the primary mapping (patch 0005), and
  delivery continues for the life of a subscription. This unblocked live
  queries and `listen()`/`notify()`.

- **Subscribing reported a phantom event.** Registration produces one delivery
  before anything is posted, which reached callers as a spurious change at
  startup and left every subsequent count one behind. The first delivery is now
  absorbed as the baseline it is.

- **`FirebirdLite.query()` leaked its prepared statement and result set when a
  statement failed.** A retry loop — the usual response to a lock conflict —
  leaked one per attempt until the attachment refused new statements. Both are
  released in `finally` now, in the transaction class as well.

- **A custom parser could run twice on one value**, when a result set names two
  columns the same (`SELECT a.ID, b.ID`) and the row holds one `ID`.

- **A parser registered with the nullable bit set never fired.** `580` and
  `581` name the same type; registration keys are normalised now, and
  registering both throws rather than leaving one silently dead.

- **`toStatement()` sent a `{ sql, params }` look-alike to the engine as
  statement text**, which reached it as `[object Object]` with the values
  dropped. A fragment does not survive `structuredClone` or JSON — it carries a
  symbol brand — so one posted from a Worker arrived as exactly such an object.
  It throws now, and names the clone boundary.

- **`query('… WHERE id = ?', 5)` ran with no parameters at all**, because a
  non-array second argument was taken for transaction options. It throws now.

## 0.2.0

### Added

- **`multiTab: 'shared'` — many tabs, one engine.** Previously a second tab on
  the same database was refused; it can now be served. One tab wins the same
  Web Lock that already provided multi-tab safety and runs the engine; the
  others proxy their calls to it over a `BroadcastChannel` and never
  instantiate an engine at all. `worker` accepts a factory for this reason —
  a follower must not download and start a 9 MB engine it will never use.

  Chosen over a `SharedWorker` owning the engine: this reuses machinery already
  built and works anywhere Web Locks do, without depending on a SharedWorker
  being able to spawn the nested Workers that pthreads require.

- **`FirebirdBrowser.isLeader`** — whether this tab runs the engine. Useful for
  work that should happen once per application rather than once per tab, such
  as a migration.

### Unchanged

- The compiled engine is byte-identical to 0.1.1 — every change in this release
  is TypeScript. Nothing under `wasm/` was touched.

### Notes on failover

When the leading tab disappears the lock releases, a follower is promoted and
starts its own engine from the last persisted image, and every tab re-attaches
to it. A call in flight at that moment is treated according to what it is: a
read is re-issued, since running a query twice is indistinguishable from
running it once; a write is rejected with an error stating its outcome is
unknown, because the old leader may have committed it and died before replying.
Retrying it could apply it twice, and an error a caller can see beats a
duplicate row it cannot.

## 0.1.1

### Fixed

- **`TransactionOptions` are honoured by the browser backend.** They were
  accepted and silently dropped: `query()` and `transaction()` both named the
  parameter and never read it, the transport had no way to carry it, and the C
  side started every transaction with a null parameter buffer. Identical
  application code asking for `SNAPSHOT` therefore got it on Node and got the
  engine default in the browser, with nothing raised.

  ```ts
  // Now does what it says in both backends.
  await db.transaction(fn, { isolationLevel: 'SNAPSHOT' });
  await db.query('SELECT * FROM ledger', [], { readOnly: true });
  ```

  `READ_COMMITTED` is registered with `isc_tpb_rec_version` rather than left to
  the engine, because which version tag the engine chooses on its own has
  changed across releases.

  An unknown isolation level now throws instead of falling back to the default
  — the same bug in a different disguise, and reachable from JavaScript callers
  who have no compiler to stop them.

### Added

- `fb_start_transaction_ex(db, isolation, readOnly)` in the C ABI, building a
  transaction parameter buffer through `IXpbBuilder`. `fb_start_transaction`
  remains as a defaults-only wrapper, so a caller asking for nothing still gets
  a null buffer — which is not the same as an empty one.
- `isolationCode()` and `hasTransactionOptions()` are exported from
  `firebird-wasm/browser` for anyone driving the transport directly.

### Changed

- `query()` with transaction options now runs inside a transaction carrying
  them, matching the Node backend. Without options it still uses the engine's
  auto-commit path, which is one fewer round trip to the Worker.

### Documentation

- `architecture.md` documents the isolation mapping for both backends, with the
  TPB tags each level produces. It previously described the Node path as though
  it were the only one.
- `browser.md` and `integration.md` state that transaction options are applied,
  and what each isolation level actually does.
- The roadmap records why **live queries are blocked**, in detail: Firebird's
  event manager initialises and `queEvents` succeeds, but the watcher thread
  delivers exactly one event and then never wakes again. The C API is on the
  `events-wip` branch. Also recorded: the delivery baseline count is 1 rather
  than 0, and bounding the indefinite `pthread_cond_wait` — which looks like
  the `sem_timedwait` fix this port already carries — does not help.
- The package README's roadmap was four items, three of them already shipped
  and the fourth ("Firebird 4 & 5 support") never the actual gap: the build
  tracks `master` and the engine reports `ENGINE_VERSION 6.0.0`.

## 0.1.0

First working release. The Firebird 6.0 engine compiled to WebAssembly and
running in a browser tab, with IndexedDB persistence.

- The engine, compiled from source with Emscripten and shipped in the package
- Parameterised queries, transactions, and multi-statement scripts
- Typed column metadata; exact `BIGINT`/`NUMERIC`/`DECFLOAT` as decimal strings
- Atomic, incremental, automatic IndexedDB persistence
- Multi-tab safety — a cross-tab Web Lock refuses a second writer rather than
  letting it overwrite the first
- A [live demo](https://mariuz.github.io/electric-firebird/) on GitHub Pages

See [ANNOUNCEMENT.md](./ANNOUNCEMENT.md) for the full introduction, and
[docs/porting.md](./docs/porting.md) for how the engine was ported.
