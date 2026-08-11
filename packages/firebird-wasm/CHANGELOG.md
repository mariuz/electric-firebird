# Changelog

All notable changes to `firebird-wasm`. This project follows
[semantic versioning](https://semver.org/); while the major version is 0 the
API may still move between minor releases.

## Unreleased

### Added

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
