# Roadmap & PGlite gap analysis

electric-firebird's stated goal is "Firebird embedded in WASM, similar to
[PGlite](https://pglite.dev) for PostgreSQL".  This document audits how far
that goal actually is, compares the API surface against PGlite feature by
feature, and proposes a staged roadmap.

Last reviewed: 2026-08-08.

---

## 1. Where the project actually stands

The engine submodule tracks **Firebird `master` (6.0.0)**; it was previously
pinned to a 5.0.3 commit.

### What changed in this pass

The C API used to be a stub — every function in
[`wasm/fb_wasm_api.cpp`](../packages/firebird-wasm/wasm/fb_wasm_api.cpp) was a
`TODO` that ignored its arguments, `fb_create_database()` returned a null
handle, and `fb_query()` returned a constant `{"columns":[],"rows":[]}`.  It is
now a real implementation written against Firebird's **public OO API**
(`IMaster`, `IProvider`, `IAttachment`, `ITransaction`, `IStatement`,
`IResultSet`, `IMessageMetadata`), which is the interface Firebird supports for
embedding — so the bridge needs **no changes to the Firebird source tree**:

| Export | Now |
|--------|-----|
| `fb_init` | acquires `IMaster`/`IUtil`, registers the statically linked engine with the plugin manager, resolves an `IProvider` |
| `fb_create_database` / `fb_attach_database` | real `IProvider` calls with a DPB (UTF8, dialect 3, 8 KiB pages) |
| `fb_execute(db, tx, sql)` | `IAttachment::execute` — **takes a transaction handle**; 0 means "run in your own, committed on success" |
| `fb_query(db, tx, sql)` | `prepare` → `openCursor` → `fetchNext`, decoding every column by its real Firebird type |
| `fb_start_transaction` / `fb_commit` / `fb_rollback` | real `ITransaction` calls; a failed commit rolls back so the handle is never left in limbo |
| `fb_last_error` | **new** — the engine's own message, via `IUtil::formatStatus` |
| `fb_detach_database` | rolls back anything still open, then detaches |

### What is verified, and what is not

Being precise about this matters, because the previous roadmap's ticks were
not:

- ✅ `fb_wasm_api.cpp` compiles clean (`-Wall -Wextra`) against the Firebird
  master headers, and exports all 11 entry points.
- ✅ All three WASM patches apply cleanly to master again (two did not — see
  below), and `build.sh` now fails loudly instead of skipping them.
- ✅ The TypeScript layer, its 30 browser tests, and the type definitions match
  the new ABI.
- ✅ **The WASM artifact builds.**  `firebird-embedded.wasm` (8.2 MB) +
  `firebird-embedded.js` (90 KB), linked with zero undefined and zero
  duplicate symbols.  Emscripten is vendored at `third_party/emsdk`.
- ✅ **The engine initialises in the browser.**  `_fb_init()` returns 0 against
  the real artifact: `IMaster` acquired, the statically linked engine
  registered with the plugin manager, an `IProvider` resolved.
- ✅ **The metadata layer is real code, not stubs.**  `build.sh` builds
  `gpre_boot` and preprocesses all 14 `.epp` sources under `src/jrd` and
  `src/dsql`; `fb_wasm_stubs.cpp` shrank from 1934 to ~470 lines.
- ❌ **`_fb_create_database()` traps.**  The call aborts with WASM's
  `function signature mismatch` — an indirect call whose signature does not
  match its function-table entry.  Native builds tolerate function-pointer
  casts that WASM rejects, so this is the expected next class of problem.

So: the engine is built and starts; it does not execute SQL yet.  M1's
acceptance test — `wasm.spec.ts` completing a create → insert → select — now
fails on a concrete, locatable defect rather than on absence.

### Also found during this review

| # | Issue | Status |
|---|-------|--------|
| 1 | `FirebirdBrowser.query(sql, params)` accepted `params` and **silently discarded them**, so the same code returned different results on Node and in the browser. | **Fixed** — it now throws until the C API can bind parameters. Refusing is the only honest option while the capability is missing. |
| 2 | `FirebirdBrowserTransaction.exec/query` passed `dbHandle`, never `txHandle`, so statements did not run in the transaction they appeared to belong to and `rollback()` could not undo them. | **Fixed** — `fb_execute`/`fb_query` take a transaction handle and the TS layer threads it through. Covered by a test. |
| 3 | `persist()` rewrote the **whole** database, one IndexedDB transaction per page. | **Fixed.** One transaction for the whole import, and only changed pages are written. An interrupted persist now rolls back instead of leaving a half-written database. |
| 4 | Two tabs on the same origin both open `firebird_<name>` and both persist whole images. | **Fixed** — a Web Lock per database refuses the second tab instead of letting it overwrite the first. Sharing one engine between tabs remains M4. |
| 5 | JSON is the result ABI. | Improved, still lossy. Values are now decoded by real type: BLOBs read (text as string, binary as base64), `NUMERIC`/`DECFLOAT`/`INT128` as exact decimal strings, `BIGINT` as a string once it exceeds `Number.MAX_SAFE_INTEGER`, dates as ISO-8601. `FieldInfo` still carries only `name` — a typed ABI is M2. |
| 6 | `loadFirebirdWasm()` caches one module in a module-level variable with no way to dispose it. | Open. `close()` does not release the WASM heap. |
| 7 | Jest config sets `testPathIgnorePatterns: ["/src/browser/"]`, and there were no browser tests. | **Fixed** — 30 Playwright tests, see §5. |
| 8 | `e2e` resolved WASM artifact paths one directory too high (`../../../packages/...` from `e2e/server`). | **Fixed.** The WASM suite would have skipped and the server 404'd *even after a successful build*. |
| 9 | `build.sh` applied patches with `\|\| echo "(already applied or not applicable – skipping)"`. Patch 0002 was structurally corrupt (bad hunk headers) and 0003 had drifted, so **neither had ever been applied** to the tree being compiled. | **Fixed** — both regenerated against master, and the loop now distinguishes "already applied" from "does not apply" and exits non-zero on the latter. |
| 10 | `wasm.spec.ts` asserted `_fb_init()` returns 0 and that `_fb_query()` yields `columns`/`rows` arrays — both of which the *stub* satisfied by construction, so it could not tell a working engine from a stub. | **Fixed** — it now drives a create → insert → select round-trip and asserts the actual rows. |

### The create-database trap — root cause found and fixed

`_fb_create_database()` used to abort with WASM's `null function or function
signature mismatch`.  **Cause: `autoconfig.h` described the 64-bit host, not
the 32-bit target, and Firebird's memory pool sized its allocator header from
that.**

`autoconfig.h` is produced by a native x86-64 configure, so it recorded
`SIZEOF_VOID_P 8` and `SIZEOF_SIZE_T 8`.  The artifact targets wasm32, where
both are 4.  `build.sh` already knew this class of problem existed — it patched
`SIZEOF_LONG` 8 → 4 — but stopped there.

That is not cosmetic.  `common/classes/alloc.cpp` sizes its allocator header:

```cpp
#elif (SIZEOF_VOID_P == 4)
    FB_UINT64 dummyAlign;      // padding so MemHeader is 16 bytes
#endif
```

With the host's 8, the padding is omitted and `MemHeader` is 8 bytes instead of
16.  Every pool allocation then came back 8 bytes off a 16-byte boundary
(`ALLOC_ALIGNMENT` is 16) and the block arithmetic wrote past the ends of live
blocks.  One of those writes landed on `JProvider::pluginConfig`, whose vtable
pointer the engine then dereferenced.

A standalone probe (`wasm/fb_pool_probe.cpp`, `-DFB_WASM_POOL_PROBE=ON`)
allocates 16 blocks from the default pool with no engine involved:

| | before fix | after fix |
|---|---|---|
| Misaligned returns | 16 of 16 (all `ptr % 16 == 8`) | 0 |
| Blocks clobbered while live | 7 | 0 |
| Total problems | 23 | 0 |

Two further porting defects surfaced immediately behind it, both fixed:

- **C++ exceptions were disabled.**  Firebird signals every error by throwing
  (`Arg::Gds(...).raise()`) and catches internally to build status vectors.
  Emscripten disables exception support by default, so the first `throw`
  aborted at `___cxa_throw` — the engine could not report an error at all.
  Built with `-fwasm-exceptions` (native WASM EH: smaller and faster than the
  JS emulation, supported by all browsers since ~2022).
- **`PTHREAD_PROCESS_SHARED` is unsupported.**  Firebird requests it when
  setting up the shared memory its lock manager uses for inter-process access,
  and treats failure as fatal.  A single-process WASM instance has no second
  process to coordinate with, so `pthread_mutexattr_setpshared` and
  `pthread_condattr_setpshared` are overridden to succeed.  A macro cannot be
  used here (unlike `pthread_rwlockattr_setkind_np`) because `<pthread.h>`
  declares these and the macro would mangle the declaration.

With those three fixed, `fb_create_database()` no longer traps and reports
errors properly through `fb_last_error()`.  The next barrier is real:

```
fb_create_database: operating system directive pthread_create failed
-Not supported
```

Fixed by building with `-pthread` (Emscripten implements pthreads over Web
Workers and SharedArrayBuffer) plus `PTHREAD_POOL_SIZE=8`, so a thread is never
created on demand while its creator blocks waiting for it.

Two browser consequences to design around, neither affecting Node:
SharedArrayBuffer requires cross-origin isolation (COOP/COEP headers, which
`e2e/server/wasm-server.ts` can set), and a browser main thread cannot block on
a mutex — so in a browser the engine has to run inside a Worker.  That is
already on the roadmap as M4.

### The engine runs

`fb_create_database()` works, and so does a full round-trip through the C API:

```
fb_init          -> 0
create_database  -> 1
exec             -> 0  | CREATE TABLE items (id INTEGER, name VARCHAR(32))
exec             -> 0  | INSERT INTO items VALUES (1, 'alpha')
exec             -> 0  | INSERT INTO items VALUES (2, 'beta')
ROWS: {"columns":["ID","NAME"],"rows":[[1,"alpha"],[2,"beta"]]}
detach           -> 0
db file bytes    -> 2367488
```

Firebird creates a real database in Emscripten's filesystem, executes DDL and
DML, and returns rows decoded by the typed value mapping.

Getting here took seven porting fixes, in this order:

| # | Fix | Symptom |
|---|-----|---------|
| 1 | `SIZEOF_VOID_P`/`SIZEOF_SIZE_T` patched for wasm32 | pool handed out misaligned, overlapping blocks; corrupted `JProvider` |
| 2 | `-fwasm-exceptions` | first `throw` aborted at `___cxa_throw` |
| 3 | `pthread_mutexattr_setpshared` overridden | `PTHREAD_PROCESS_SHARED` unsupported, treated as fatal |
| 4 | `-pthread` + worker pool | `pthread_create failed` |
| 5 | Real libcds thread attachment | `INI_init` read the relation vector out of bounds |
| 6 | Real `sem_timedwait` | `sem_wait() failed -Operation timed out` |
| 7 | Builtin-only character sets (patch 0004) | `CHARACTER SET "SYSTEM"."SJIS_0208" is not installed` |
| — | `STACK_SIZE=8MB` | stack overflow during creation |

Two of these — 5 and 6 — were stubs whose stated reasoning had quietly
expired.  `ThreadData::init()` skipped attaching to the hazard-pointer GC that
the metadata cache depends on; `sem_timedwait` refused to wait because the
build "is single-threaded", which stopped being true at fix 4.  A stub written
for one set of constraints becomes a bug when the constraints change, and it
keeps working just well enough to hide where the real failure is.  Worth
re-reading the remaining stubs in that light.

Fix 7 is a deliberate trade-off, not a workaround.  Creating a database
instantiates every entry of `IntlManager::defaultCharSets` (see `ini.epp`),
but only the eight sets in `INTL_builtin_lookup_charset` are compiled into the
engine; the rest live in the separately loaded `fbintl` module, and Emscripten
has no dlopen.  Linking `src/intl` statically would be 29 files of mostly
codepage tables added to an artifact a browser must download, for encodings a
web app is unlikely to need.  Databases created by this build therefore define
only the builtin character sets — UTF8 among them.

### It runs in the browser too

The engine executes the same round-trip inside a Web Worker in Chromium,
asserted by Playwright against the real rows — `wasm.spec.ts`, "runs a full
create → insert → select round-trip inside a Worker".

A Worker is not a testing convenience, it is the only workable browser
configuration: `-pthread` means Firebird blocks on mutexes while opening a
database, and a browser main thread may not block, so a main-thread harness
deadlocks.  The main-thread engine tests were removed rather than left skipped
— they described a configuration that cannot work.  Two things follow from
this and are already in place:

- The test server sets COOP/COEP, because Emscripten's pthreads need
  SharedArrayBuffer, which browsers only expose to cross-origin isolated
  pages.  The Worker test asserts `crossOriginIsolated` explicitly, so a
  regression there fails on its own terms instead of as a confusing
  instantiation error.
- The Emscripten module needs `locateFile` inside a Worker: `importScripts()`
  leaves the worker's own URL as the base, so the runtime would fetch
  `firebird-embedded.wasm` from the site root and try to instantiate a JSON
  404 body.

### The public API drives the real engine

`FirebirdBrowser` now reaches the engine through an `EngineTransport`, with two
implementations:

- `DirectTransport` calls the WASM exports in the current thread.  Node uses
  it, the Worker uses it internally, and the stub-ABI tests use it.
- `WorkerTransport` forwards over `postMessage` to a Worker built from
  `browser/worker-entry`.  Browsers must use it, so `FirebirdBrowser` takes a
  `worker` option.

The Worker owns Emscripten's filesystem, which is why filesystem access is part
of the transport rather than something the caller does — persistence copies the
database image between that filesystem and IndexedDB, and only the Worker can
read it.

Five tests exercise the public API against the real engine
(`browser-engine.spec.ts`): a `CREATE TABLE`/`INSERT`/`SELECT` round-trip,
transaction commit, transaction rollback actually undoing a write, Firebird's
own diagnostic reaching the caller for invalid SQL, and — the one that matters
for a browser database — **data surviving a page reload** via IndexedDB, read
back on a fresh WASM instance with an empty filesystem.

The 30 stub-ABI tests kept passing through the refactor unchanged, which is
what makes them worth having: they pin marshalling, pointer ownership and
error handling independently of whether an artifact exists.

### Parameterised queries

`query(sql, params)` and `exec(sql, params)` bind `?` placeholders on both
backends, closing the gap that made the browser build refuse parameters.

Two decisions shape the implementation:

- **Parameters cross as one packed binary buffer**, not JSON — a count, then
  per parameter a null flag, a length and UTF-8 bytes.  The C side needs no
  parser and there is no escaping to get wrong.  Every length is checked
  against the remaining bytes, because this data crosses the JS/WASM boundary
  and a malformed buffer must produce an error rather than an out-of-bounds
  read.
- **Values are sent as text and converted by the engine.**  The statement's
  own input metadata is used unchanged and each value is passed through
  `IUtil::convert` from VARCHAR to the declared type — the same conversion a
  SQL string literal gets.  One code path therefore serves integers, decimals,
  booleans and dates, and the rules are Firebird's rather than a
  reimplementation of them.

  The first attempt instead rebuilt the input metadata as all-VARCHAR with
  `IMetadataBuilder`, which many drivers do.  The engine rejected the result
  with a bare "internal error".  Bisecting with an empty parameter list showed
  `prepare` + `IStatement::execute` was fine, so the fault was the fabricated
  message.  Describing the message is the engine's business; converting the
  values is ours.

Consequences worth knowing:

- `null` and `undefined` both bind SQL NULL — JavaScript uses them
  interchangeably for "absent", and accepting only one would be a trap.
- Binary parameters (`Uint8Array`) throw a clear error naming the limitation
  rather than corrupting data: the encoding is text-based.
- A parameter-count mismatch is reported against the prepared statement
  ("expects 1 parameter but 2 were supplied") instead of surfacing as an
  obscure engine failure.

### What is still open

- Typed result encoding (§M2): `FieldInfo` still carries only `name`, and
  BIGINT/NUMERIC/DECFLOAT arrive as exact decimal *strings* to avoid silent
  precision loss.
- Multi-statement `exec()`, `affectedRows`, `tx.rollback()`.
- Multi-tab safety and live queries (§M4).
- A typed *binary* result encoding, so exact numerics need not travel as
  strings at all.
- Multi-tab safety (§M4) and live queries (§M4).

### Persistence is atomic and incremental

`importDatabase()` used one IndexedDB transaction *per page*, after a `clear()`.
For a 2.3 MB database that is roughly 289 transactions, and it is not atomic:
a tab closed midway leaves some pages new and some old, which is a corrupt
database with no way back.

It now runs as a single transaction, which IndexedDB guarantees is
all-or-nothing, and writes only pages whose bytes actually changed — comparing
against what is stored rather than an in-memory copy, so the comparison is
exact and costs no memory proportional to the database.  The common case, a
few dirty pages in a large database, goes from O(database) to O(changes).

Three tests pin the behaviour, and they measure rather than assume:

- write counting instruments `IDBObjectStore.prototype.put`, so it observes
  what reaches IndexedDB.  Re-importing an identical image performs one write
  (the metadata record); changing one page of three performs two.
- shrinking an image removes the pages past the new end.
- aborting the transaction partway — standing in for a tab closing
  mid-persist — leaves the *previous* image completely intact, with no page of
  the failed write visible.

### Writes persist without being asked

`persist()` used to run only on `close()` and when called explicitly, so
closing a tab — the usual way to leave a page — lost everything written that
session.  It now runs automatically after writes, debounced (500 ms by
default) so a burst of statements costs one persist.

`autoPersist` defaults to **on**: silently losing committed data is a worse
default than the cost of writing it.  `autoPersist: false` restores the old
behaviour.

The flush also hooks `visibilitychange` → hidden and `pagehide`.
`visibilitychange` is the one to rely on — it fires when a mobile browser
backgrounds an app, where `beforeunload` and `unload` frequently do not fire
at all.  Neither event can await an async write, so that path is best-effort;
that is precisely why writes are *also* persisted on a debounce rather than
only at the end.

Two details that would otherwise bite:

- Persists are serialised.  Two overlapping runs both read the image and write
  the same store, and the later one finishing first would roll the database
  back to an older state.  A write arriving mid-persist sets a flag so another
  persist follows, since the image already written does not contain it.
- Background persists have no caller to reject into.  Failures go to
  `onPersistError` (default `console.error`) rather than becoming unhandled
  rejections, because a silent failure here *is* data loss.

`close()` cancels the pending timer, detaches the listeners and waits for any
persist already running, so nothing can write after the engine has gone.

### exec() runs scripts

`exec()` takes a script and returns one result per statement, which is what
makes it usable for migrations.  Each statement runs in its own transaction,
so a failure part-way leaves earlier statements committed — the same as
`isql`.

Splitting is the whole problem.  Cutting on `;` corrupts scripts rather than
merely failing them, so the splitter tracks string literals (including `''`
escapes), quoted identifiers, line and block comments, and `SET TERM`.

`SET TERM` matters more than it looks: it is how Firebird lets a PSQL body
contain its own semicolons, so a splitter that ignores it cuts every stored
procedure and trigger in half — which is most of what a real migration
contains.  A test creates a procedure through `exec()` and then calls it, so
the body is proven to have survived rather than merely looking intact.

Parameters are rejected for a multi-statement script.  It is not that binding
would be hard; it is that there is no way to say which statement a value
belongs to, and guessing would be worse than refusing.

`exec()` returning an array is a change from the single `ExecResult` added a
commit earlier.  It matches PGlite, where `.exec()` is the script runner and
`.query()` is the parameterised one; callers that ignore the return value are
unaffected.

### Result columns are described

`FieldInfo` used to carry only `name`, which left a real ambiguity: a
`NUMERIC(10,2)` arrives as the string `"20.25"` — deliberately, to keep it
exact — and that is indistinguishable from a `VARCHAR` containing digits.  The
engine knew the difference and threw it away.

Each column now reports `type`, `typeName`, `subType`, `scale`, `length` and
`nullable`.

`typeName` is not just a lookup table.  Firebird stores `NUMERIC` and `DECIMAL`
as scaled `SMALLINT`/`INTEGER`/`BIGINT`/`INT128`, so the raw type code for a
`NUMERIC(10,2)` says BIGINT.  Reporting `NUMERIC` when the scale is non-zero is
what actually tells a caller that `"20.25"` is an exact number rather than
text.  The engine test asserts exactly that distinction: `PRICE` is `NUMERIC`
with scale −2, while a `BIGINT` past 2^53 — which also arrives as a string —
is `BIGINT` with scale 0.

The fields on `FieldInfo` are optional because the Node.js native driver does
not expose them; the WASM backend fills them in.

---

## 2. Feature comparison with PGlite

Legend: ✅ shipped · 🟡 partial · ❌ missing · n/a not applicable

### Core query API

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| `query(sql, params)` | ✅ | ✅ | `?` placeholders on both backends |
| Template-literal `` sql`…` `` tag | ✅ | ❌ | Ergonomics + injection safety |
| `exec(sql)` multi-statement script → array of results | ✅ | ✅ | Splitting respects strings, identifiers, comments and `SET TERM` |
| `rowMode: 'object' \| 'array'` | ✅ | ❌ | Always object mode |
| Custom `parsers` / `serializers` | ✅ | ❌ | |
| `describeQuery()` | ✅ | ❌ | |
| Typed field metadata (`dataTypeID`) | ✅ | ✅ | `FieldInfo` carries type, typeName, subType, scale, length, nullable |
| Affected-row count | ✅ | ✅ | `exec()` returns `{ affectedRows }` |
| Binary / BLOB values | ✅ | 🟡 | BLOBs are read and returned (text as string, binary as base64); a `Uint8Array` needs the typed ABI |

### Transactions

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| `transaction(cb)` with auto commit/rollback | ✅ | ✅ | Statements are bound to the transaction handle; commit/rollback paths tested |
| Explicit `tx.rollback()` | ✅ | ✅ | Abandons the transaction without throwing |
| Isolation levels | ✅ | 🟡 | `TransactionOptions` is honoured on Node, ignored in the browser |

### Storage & persistence

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| In-memory / ephemeral database | ✅ `memory://` | ❌ | Everything goes through IndexedDB |
| Node filesystem | ✅ `file://` | ✅ | Via the native driver, not WASM |
| IndexedDB | ✅ `idb://` | ✅ | One transaction per persist, only changed pages written |
| OPFS | — | ❌ | The natural fit for Firebird's page I/O; see M4 |
| Incremental / dirty-page writes | ✅ | ✅ | Pages compared against what is stored |
| Durability tuning | ✅ `relaxedDurability` | ✅ | `autoPersist` + `autoPersistDebounceMs` |
| `dumpDataDir()` on the DB object | ✅ | 🟡 | `IndexedDBVFS.exportDatabase()` exists but is unreachable from `FirebirdBrowser` |
| `loadDataDir` at construction | ✅ | 🟡 | Same: `importDatabase()` is VFS-only |

### Concurrency & reactivity

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| Multi-tab sharing (worker + leader election) | ✅ `PGliteWorker` | ❌ | Two tabs corrupt each other today (§1.4) |
| Web Worker offloading | ✅ | ❌ | The engine runs on the main thread and blocks it |
| Live / reactive queries | ✅ `live` extension | ❌ | |
| `listen()` / `notify()` | ✅ | ❌ | Firebird has a native fit here: `POST_EVENT` + event alerts |
| Sync with a server | ✅ (ElectricSQL) | ❌ | This is the "electric" in the project name |

### Packaging & ecosystem

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| Prebuilt WASM on npm | ✅ | ❌ | Users must run Emscripten themselves |
| CDN distribution | ✅ | ❌ | |
| Bundler guides (Vite/webpack) | ✅ | 🟡 | Documented in `browser.md`, unverified against a real bundler |
| Framework hooks (React/Vue) | ✅ | ❌ | |
| ORM / query-builder support | ✅ | ❌ | |
| Extensions / plugin API | ✅ | n/a | Firebird UDRs are a different model; not a near-term goal |
| REPL component | ✅ | ❌ | Cheap and very good for demos |

### Where Firebird can beat the comparison

Worth stating, because "catch up with PGlite" is not the only axis:

- **Events.** Firebird's `POST_EVENT` is a server-side push primitive with no
  Postgres-in-WASM equivalent constraint — a natural, cheap base for live
  queries.
- **Multi-generational architecture.** Readers never block writers, which maps
  well onto a browser where a background persist must not stall the UI.
- **Single-file databases** with no `initdb` step: a Firebird database *is* the
  file, so `loadDataDir`-style import is just writing bytes — no template
  cluster to ship. This should make the artifact meaningfully smaller than a
  Postgres build.

---

## 3. Gaps ranked

By "how much damage does this do to a user who tries the README today":

1. **The engine doesn't run** (§1). Everything else is theoretical until this
   lands.
2. **Silently-ignored query parameters** (§1.1). Wrong answers with no error.
   Until `fb_query_params` exists, `query()` should *throw* when handed
   parameters rather than pretend.
3. **Transactions that don't transact** (§1.2). Needs a C ABI change.
4. **Multi-tab data loss** (§1.4). At minimum document it; properly, needs a
   worker + leader election.
5. **Whole-image, non-atomic persistence** (§1.3). Fine for a demo, not for a
   database.
6. **Lossy JSON ABI** (§1.5). Caps the maximum achievable correctness.
7. Everything in §2 marked ❌ — real gaps, but none of them mislead a user.

---

## 4. Proposed roadmap

### M0 — Honesty & safety (no engine work required)

- [x] Make `FirebirdBrowser.query()` **throw** when passed parameters, until
      the parameterised C ABI exists.
- [x] Document the multi-tab hazard in `browser.md`.
- [ ] Refuse a second concurrent open of the same database name within a page.
- [x] Make `wasm.spec.ts` assert real data instead of stub-satisfiable shapes.
- [x] Browser test coverage for the layer that *is* real (§5).
- [x] Fix the `e2e` WASM artifact path resolution.
- [x] Stop `build.sh` silently skipping patches that fail to apply.

### M1 — Make the engine actually run (the blocker)

- [x] Sync the Firebird submodule to upstream `master` and regenerate the WASM
      patches against it.
- [x] Wire `fb_init` to real provider initialisation: acquire `IMaster`,
      register the statically linked engine, resolve an `IProvider`.
- [x] Implement `fb_create_database` / `fb_attach_database` /
      `fb_detach_database` over the OO API, with a DPB.
- [x] Implement `fb_execute` via `IAttachment::execute`.
- [x] Implement `fb_query` with real cursor iteration and typed value decoding.
- [x] Surface engine error text (`fb_last_error`) instead of bare integers.
- [x] Add `src/yvalve/` to the CMake build (minus `gds.cpp`, whose `gds__*`
      helpers stay stubbed) so the OO API entry points link.
- [x] Vendor the Emscripten SDK (`third_party/emsdk`, subtree) and link the
      build: zero undefined, zero duplicate symbols.
- [x] Compile the metadata layer for real via the boot gpre pass instead of
      stubbing it out.
- [ ] **Fix the `_fb_create_database()` trap.**  Diagnosed down to the exact
      member; see "The create-database trap" below.
- [ ] Re-check the remaining stubs in `fb_wasm_stubs.cpp` once the engine
      executes a statement.
- **Acceptance:** in Chromium, `CREATE TABLE` → `INSERT` → `SELECT` returns the
  inserted rows — i.e. `wasm.spec.ts` runs instead of skipping.

### M2 — A correct API surface

- [ ] `fb_execute_params` / `fb_query_params`: message-buffer binding via
      `IMessageMetadata`/`IMetadataBuilder`, then accept `params` instead of
      throwing.
- [x] Thread `txHandle` through `fb_execute`/`fb_query`.
- [ ] Add an explicit `tx.rollback()`.
- [ ] Replace the JSON ABI with a typed encoding; carry Firebird type codes in
      `FieldInfo`; map `BIGINT`→`BigInt`, `TIMESTAMP`→`Date`, `BLOB`→
      `Uint8Array`.  (The JSON path already decodes these correctly but has to
      flatten them to strings — see the type table in `fb_wasm_api.cpp`.)
- [ ] `exec()` accepts multi-statement scripts and returns one result per
      statement.
- [ ] Populate `affectedRows` on the browser path
      (`IStatement::getAffectedRecords`).

### M3 — Persistence you can trust

- [ ] Dirty-page tracking: persist only changed pages instead of `clear()` +
      full rewrite.
- [ ] Atomic swap (write-then-flip metadata) so an interrupted persist cannot
      truncate the database.
- [ ] `db.dump()` / `loadDataDir`-style constructor option on `FirebirdBrowser`,
      wrapping the VFS export/import that already exists.
- [ ] `memory://`-equivalent ephemeral mode (skip IndexedDB entirely).
- [ ] Auto-persist policy (debounced, on `visibilitychange`) instead of asking
      users to wire `beforeunload` themselves.

### M4 — Concurrency, distribution, reactivity

- [ ] Run the engine in a Web Worker; keep the main thread free.
- [ ] `SharedWorker` + leader election for multi-tab safety.
- [ ] OPFS backend with sync access handles — a much better match for
      page-oriented I/O than IndexedDB.
- [ ] Publish the prebuilt artifact to npm (+ CDN), with a size budget and a
      default `locateFile`.
- [ ] Live queries built on `POST_EVENT`; a `listen()` / `notify()` API.
- [ ] Verified Vite and webpack example apps in CI.

### M5 — Ecosystem

- [ ] React/Vue hooks; REPL component.
- [ ] ElectricSQL sync integration (the project's namesake).
- [ ] Firebird 4 vs 5 build matrix — note that the build script already targets
      **5.0.3**, so the old roadmap line was stale; what is actually missing is
      *testing across versions*, not initial support.

---

## 5. Test coverage added alongside this review

`src/browser/` was excluded from Jest and had no browser tests.  It now has 30
Playwright tests running in real Chromium against real IndexedDB
(`e2e/tests/browser-api.spec.ts`, run via `npm run test:browser -w e2e`).

They do not need the WASM artifact: `e2e/fixtures/stub-engine.js` supplies the
C ABI with a real byte heap and a real in-memory filesystem, so the code under
test is the actual bundled library — only the SQL engine is stubbed.  Covered:

- **`IndexedDBVFS`** — page round-trip, zero-fill of unwritten pages, page-size
  validation, sparse `pageCount` metadata, ordered export, import-replaces-all,
  `clear()`, `destroy()`, prefix isolation, use-before-`open()`, double-`open()`,
  and **durability across a real page reload**.
- **`FirebirdBrowser`** — lazy module load, single initialisation under
  concurrent first calls, UTF-8 pointer marshalling, heap-pointer release on
  both success and error paths (leak and double-free counters), result decoding
  to upper-cased column keys, NULL-result handling, commit/rollback/commit-
  failure/start-failure paths, `close()` idempotence and
  use-after-close, `persist()` landing a byte-identical image in IndexedDB, and
  **create-then-attach across a reload** (session 2 restores the file from
  IndexedDB rather than creating a new database).
- **The fixes from this pass** — parameters refused rather than dropped (and
  not reaching the engine), statements bound to the transaction handle they
  were issued under, engine error text reaching the thrown `Error`, and a
  failed `fb_init` reported with its reason.

The suite was mutation-checked: reverting the column upper-casing and dropping
the `_fb_free_result` call each make it fail.

What it deliberately does **not** cover: whether Firebird itself produces
correct answers.  That needs a linked WASM build (M1's remaining item), after
which `e2e/tests/wasm.spec.ts` and
`packages/firebird-wasm/src/__tests__/wasm-integration.test.ts` stop skipping —
both now assert real rows rather than shapes a stub could satisfy.
