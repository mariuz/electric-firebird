# Changelog

All notable changes to `firebird-wasm`. This project follows
[semantic versioning](https://semver.org/); while the major version is 0 the
API may still move between minor releases.

## Unreleased

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
