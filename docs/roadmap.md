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
ROWS: {"columns":[{"name":"ID","type":496,"subType":0,"scale":0,"length":4,"nullable":true},{"name":"NAME","type":448,"subType":0,"scale":0,"length":128,"nullable":true}],"rows":[[1,"alpha"],[2,"beta"]]}
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

Typed results, multi-statement `exec()`, `affectedRows`, `tx.rollback()` and
multi-tab safety have all landed since this list was written; what remains:

- Live queries (§M4). Firebird's `POST_EVENT` is the natural fit; the C API
  exists on `events-wip` and the engine delivers exactly one event and then
  stops — see §1 for where it stops.
- ~~Two tabs cannot *share* a database.~~ Done: `multiTab: 'shared'` elects one
  tab to run the engine and serves the rest over a `BroadcastChannel`. The
  default is still `'exclusive'`, so sharing is opt-in.
- A typed *binary* result encoding, so exact numerics need not travel as
  strings at all.
- `loadFirebirdWasm()` caches one module process-wide with no way to dispose
  it; `close()` does not release the WASM heap.
- Only the built-in character sets are compiled in, and the UNICODE collations
  do not work. Both are solved on `icu-collation` (§6, PR #12) and neither is
  merged.
- ElectricSQL sync (§M5) — the project's namesake.

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

### It is on npm

`firebird-wasm@0.1.0` is published, and `v0.1.0` is tagged on GitHub with the
engine attached as a release asset.

```bash
npm install firebird-wasm
```

The package ships the compiled engine, so nobody has to run Emscripten to try
it: 66 files, 3.1 MB packed, 9.0 MB unpacked, almost all of it
`firebird-embedded.wasm`.

Two things about the packaging are worth recording, because both would have
shipped broken.

Without a `files` field npm walks the package directory, and the first
`npm pack --dry-run` measured **13,545 files and 458 MB** — the entire Firebird
source submodule and every build tree. It is now restricted to `dist`, the
README and the licence.

More subtly, `npm run build` compiles TypeScript but does *not* produce
`firebird-embedded.wasm`, which comes from a separate hour-long Emscripten
build. Publishing after a plain build yields a package that installs perfectly
and then 404s the engine in every consumer's browser, with no signal at publish
time. `scripts/check-publish.mjs` runs from `prepublishOnly` and refuses that,
and it prints the build order — which is not the obvious one, since `clean`
deletes `dist` and so must run *before* `build:wasm`.

The native driver moved to `optionalDependencies` in the same pass. It was a
hard dependency, so anyone installing this for the *browser* engine was made to
install a native module needing Firebird's client library. `npm install
firebird-wasm --omit=optional` now pulls four packages, builds nothing, and the
browser entry point works.

Verified against the real registry rather than a local tarball: installed into
an empty project, created a database, and read back `NUMERIC(10,2)` as the
exact string `"20.25"`. The published shasum matches the tarball that was
tested before release.

### Live queries: what is actually blocking them

Attempted, and stopped at a specific engine-side wall.  The work is on the
`events-wip` branch (`fedbd8e`) rather than `main`, because the C API is
complete and correct and still cannot fire.

The intended design is unchanged and still right: Firebird posts events with
`POST_EVENT` from a trigger, delivered **after the posting transaction
commits**, so a subscriber only ever hears about data that survived.  A C API
of `fb_events_subscribe` / `fb_events_poll` / `fb_events_cancel` sits over
`IAttachment::queEvents`, with the callback doing the least work that is
correct on an engine thread — copy counts under a mutex, set a flag — and the
poll doing the re-arming, because re-arming from inside the callback means
calling into the engine from the engine's own callback thread.

What was measured, in order:

| Step | Result |
|------|--------|
| Event manager initialisation | **Works.** Creates its shared-memory region in MEMFS (`fb_event_0100…`, 64 KB) |
| `queEvents` registration | **Works.** The hand-built event block is accepted; layout verified byte by byte |
| Watcher thread start | **Works.** `EventManager::watcher_thread` starts |
| First delivery | **Works.** One loop iteration, `PRB_pending` seen, `deliver()` called, callback invoked |
| Every delivery after the first | **Never happens.** The watcher never iterates again |

The watcher is stuck inside `SharedMemoryBase::eventWait`, whose internal loop
exits only when the event counter changes.  The counter never changes, so
`eventPost` is not reaching the watcher's event after the first delivery.

Shared memory itself is not the problem: the watcher observed `PRB_pending`
set by a different thread, so the mapping is genuinely shared.  That narrows
the fault to the wakeup path rather than to Emscripten's `mmap`.

Two findings worth keeping even if the approach changes:

- **The baseline count is 1, not 0.**  An event that had never been posted
  reported a count of 1 on the first delivery.  Any implementation must treat
  the first delivery as a baseline and subtract it; reading it as a real event
  — which an earlier revision of this code did — reports a phantom event per
  subscription at startup.
- **Bounding the indefinite wait does not help.**  `eventWait` calls
  `pthread_cond_wait` with no timeout, which looks exactly like the
  `sem_timedwait` problem fix 6 solved during the port.  Giving it a 50 ms
  timeout instead changes nothing, because `eventWait` loops internally on the
  same condition: the timeout spins there rather than returning to the
  watcher.  Reverted.

#### To pick this up again

1. **The one open question:** why does `eventPost` not advance the counter that
   `eventWait` blocks on?  Everything above it is in place.  Start in
   `src/common/isc_sync.cpp` — `eventPost`, `eventClear` and `event_blocked` —
   and instrument the poster, not the waiter; the waiter's behaviour is
   already understood.
2. **The feedback loop is slow.**  Each hypothesis costs an incremental
   rebuild of the engine, a few minutes with a warm build tree and about an
   hour without one.  Batch the diagnostics: print from the poster and the
   waiter in one build rather than one question per rebuild.
3. **The JavaScript layer is unwritten but unblocked.**  Once delivery works,
   what remains is a Worker that polls `fb_events_poll` and pushes to the main
   thread, plus a `live()` API that re-runs a query when named events fire.
   None of it depends on the unknown above.
4. **There is a fallback that works today.**  Re-running registered queries on
   a timer, or after any local write, covers a single tab reacting to its own
   writes — the common case — without any engine event at all.  It is not
   `POST_EVENT` integration and would not see changes made by another
   connection, but nothing here blocks it.

---

## 2. Feature comparison with PGlite

Legend: ✅ shipped · 🟡 partial · ❌ missing · n/a not applicable

### Core query API

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| `query(sql, params)` | ✅ | ✅ | `?` placeholders on both backends |
| Template-literal `` sql`…` `` tag | ✅ | ✅ | Values bind as `?` parameters; fragments nest. `sql.identifier()` quotes names, `sql.join()` expands `IN` lists, `sql.unsafe()` is the named escape hatch |
| `exec(sql)` multi-statement script → array of results | ✅ | ✅ | Splitting respects strings, identifiers, comments and `SET TERM` |
| `rowMode: 'object' \| 'array'` | ✅ | ✅ | Per query, on both backends. Names stay in `fields`. Worth it less for speed (1.1× on 10k rows, since the generated constructor already made object building cheap) than for `SELECT a.ID, b.ID`, which object mode can only half-represent |
| Custom `parsers` / `serializers` | ✅ | 🟡 | `types: { parsers, serializers }` on the browser backend. Parsers key on the Firebird type code and replace the built-in conversion; serializers are a list, because an outgoing parameter has no declared type to key on. Not on the Node backend, whose driver reports no type codes |
| `describeQuery()` | ✅ | ✅ | Prepares and drops the statement, executing nothing. WASM reports parameter *and* column types plus the statement kind; Node reports column names and the kind, and `params` is `undefined` there because the native driver exposes no input metadata |
| Typed field metadata (`dataTypeID`) | ✅ | ✅ | `FieldInfo` carries type, typeName, subType, scale, length, nullable |
| Affected-row count | ✅ | ✅ | `exec()` returns `{ affectedRows }` |
| Binary / BLOB values | ✅ | ✅ | Text BLOBs as strings; binary as base64 by default, or `Uint8Array` with `types: { binary: true }`, which carries the bytes beside the JSON rather than through it — 6.3× faster to decode on a blob-heavy result set, and transferred rather than cloned across a Worker |

### Transactions

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| `transaction(cb)` with auto commit/rollback | ✅ | ✅ | Statements are bound to the transaction handle; commit/rollback paths tested |
| Explicit `tx.rollback()` | ✅ | ✅ | Abandons the transaction without throwing. Both backends since b6accb4 — the Node one had only `exec` and `query` before that, so this row was optimistic |
| Isolation levels | ✅ | ✅ | Honoured by both backends since 0.1.1. The browser path builds a TPB through `IXpbBuilder`; `READ_COMMITTED` includes `isc_tpb_rec_version` rather than leaving the choice to the engine |

### Storage & persistence

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| In-memory / ephemeral database | ✅ `memory://` | ✅ | `new FirebirdBrowser('memory://')` — no IndexedDB store is opened, no lock is taken, `persist()` is a no-op, and the file is discarded on `close()`. The engine already ran from memory; what this removes is the durability copy |
| Node filesystem | ✅ `file://` | ✅ | Via the native driver, not WASM |
| IndexedDB | ✅ `idb://` | ✅ | One transaction per persist, only changed pages written |
| OPFS | — | ✅ | `opfs://name`. The engine's own reads and writes land in an OPFS file through a custom Emscripten filesystem backed by sync access handles, so there is no image copy and no persist step at all |
| Incremental / dirty-page writes | ✅ | ✅ | Pages compared against what is stored |
| Durability tuning | ✅ `relaxedDurability` | ✅ | `autoPersist` + `autoPersistDebounceMs` |
| `dumpDataDir()` on the DB object | ✅ | ✅ | Returns the live image as a `Uint8Array` — read from the engine's filesystem, so unpersisted writes are included and a `memory://` database can be dumped at all |
| `loadDataDir` at construction | ✅ | ✅ | Seeds a database that does not exist yet; a stored one always wins, so passing it on every load seeds once instead of resetting the user's data every reload |

### Concurrency & reactivity

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| Multi-tab sharing (worker + leader election) | ✅ `PGliteWorker` | ✅ | `multiTab: 'shared'` elects one tab over the existing Web Lock and proxies the rest to it over `BroadcastChannel`. The default `'exclusive'` refuses the second tab rather than letting it overwrite the first, so neither mode corrupts anything |
| Web Worker offloading | ✅ | ✅ | Required rather than optional: the build uses pthreads and Firebird blocks on mutexes while opening a database, so an engine on the main thread deadlocks the page. `WorkerTransport` forwards to `serveEngine` |
| Live / reactive queries | ✅ `live` extension | ❌ | Attempted; blocked on event delivery, see §1. A polling fallback is possible without it |
| `listen()` / `notify()` | ✅ | ❌ | `POST_EVENT` is the right fit and the C API is written, but the engine delivers only the first event under Emscripten — see §1 |
| Sync with a server | ✅ (ElectricSQL) | ❌ | This is the "electric" in the project name |

### Packaging & ecosystem

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| Prebuilt WASM on npm | ✅ | ✅ | `npm install firebird-wasm` ships the engine |
| CDN distribution | ✅ | 🟡 | Reachable via unpkg/jsDelivr by virtue of being on npm, but untested and there is no `locateFile` default for it |
| Bundler guides (Vite/webpack) | ✅ | 🟡 | Vite, webpack, esbuild and Next.js in [integration.md](./integration.md); still not built by a real example app in CI |
| Framework hooks (React/Vue) | ✅ | ❌ | |
| ORM / query-builder support | ✅ | ❌ | |
| Extensions / plugin API | ✅ | n/a | Firebird UDRs are a different model; not a near-term goal |
| REPL component | ✅ | 🟡 | The [demo](https://mariuz.github.io/electric-firebird/) is one, but it is a page, not a reusable component |

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

By "how much damage does this do to a user who tries the README today".

### Resolved

Every gap this section originally listed as damaging has been closed, in the
order it was ranked:

| # | Gap | Resolution |
|---|-----|------------|
| 1 | The engine doesn't run | Seven porting fixes; see [porting.md](./porting.md) |
| 2 | Silently-ignored query parameters | `fb_query_params` / `fb_execute_params`, bound via the statement's declared metadata |
| 3 | Transactions that don't transact | `fb_start_transaction` / `commit` / `rollback`, with statements bound to the handle |
| 4 | Multi-tab data loss | An exclusive Web Lock refuses the second tab |
| 5 | Whole-image, non-atomic persistence | One IndexedDB transaction, changed pages only |
| 6 | Lossy JSON ABI | Still JSON, but every column is now described and exact numerics survive as strings |

### Current

Nothing here produces a wrong answer. Ranked by how much they limit what can
be built:

1. **No live queries.** An application has no way to learn that data changed
   except by polling. Not for want of trying: the C API exists on the
   `events-wip` branch and Firebird's event manager starts, but delivery stops
   after the first event under Emscripten. See §1 for exactly where it stops
   and what to try next.
2. ~~**Two tabs cannot share a database.**~~ Fixed: `multiTab: 'shared'` elects
   one tab to run the engine and serves the rest from it. What remains is that
   the default is still `'exclusive'`, so sharing is opt-in.
3. **9 MB artifact, unbudgeted.** Compresses to about a third, but it is the
   first thing anyone notices.
4. **The module cannot be disposed.** `loadFirebirdWasm()` caches one instance
   process-wide and `close()` does not release the heap.
5. **Only built-in character sets, and no working UNICODE collations.**
   Solved on a branch, not merged — see
   [PR #12](https://github.com/mariuz/electric-firebird/pull/12) and §6.
   Groundwork on `main`:

      `src/intl` **compiles and links cleanly under Emscripten** — all 29 files,
      no errors. Cost, measured rather than estimated: **+616 KB raw, +245 KB
      gzipped (+8.3%)** for all 47 charsets and their collations.
      `-DFB_WASM_FULL_INTL=ON` builds it; the option warns that it currently
      enables nothing.

      Measuring it took three attempts and the first two both reported *zero
      bytes*. Nothing references the module's entry points when it is linked in
      rather than `dlopen`ed, so the linker discarded the whole subsystem; and
      an anchor array holding their addresses is not itself a root, so that was
      discarded too, taking them with it. Only an exported function reaching
      the array made the code survive — `wasm/fb_wasm_intl_anchor.cpp`. A size
      measurement of dead-stripped code measures nothing.

      **Update — most of it now works.** `-DFB_WASM_FULL_INTL=ON` builds an
      engine with **48 character sets instead of 5**: WIN1251, the ISO8859
      family, the DOS codepages, SJIS, EUC-J and the rest, with their
      collations. `CREATE DATABASE` succeeds and `CREATE TABLE ... CHARACTER
      SET WIN1251` works. Three pieces made that happen:

      - `wasm/fb_wasm_mod_loader.cpp` replaces `common/os/posix/mod_loader.cpp`.
        `IntlManager` still looks its entry points up by name through
        `ModuleLoader`, and now gets back a module whose `findSymbol` knows the
        five `LD_*` symbols. The engine goes on believing it loaded something,
        so nothing in `jrd/` needs to know WebAssembly is different. Everything
        else stays unloadable, which is what it already was.
      - `fbintl.conf` is embedded into the artifact with `--embed-file` at
        `/firebird/intl/`, and `fb_init()` sets `FIREBIRD=/firebird` so the
        engine looks there. 181 charset/collation registrations succeed.
      - Patch 0004 became conditional on the build option instead of on
        `__EMSCRIPTEN__`, and is renamed to say what it now does.

      Four entries had to stay excluded either way. TIS620, GBK, CP943C and
      GB18030 are absent from `ld.cpp`'s own table, so `LD_lookup_charset()`
      falls through to `CSICU_charset_init()` — an ICU converter — and
      Emscripten's ICU port does not carry their converter data. The other 43
      are table-driven and work.

      **What still does not work, and why it cannot be wired.** `UNICODE`,
      `UNICODE_CI` and `UNICODE_CI_AI` on UTF8 remain "not installed", and
      chasing it down ended somewhere no amount of wiring reaches.

      They are not served by the module this fixed. They are registered as
      *builtin* collations — `IntlManager::initialize()` calls
      `registerCharSetCollation(UTF8, "UNICODE", ...)` explicitly — so the
      lookup goes to `INTL_builtin_lookup_texttype_status` and never touches
      `ModuleLoader`. Every step of that path works: the map lookup finds both
      entries, the dispatch finds `ttype_unicode8_init`, and it calls
      `IntlUtil::initUnicodeCollation`.

      It fails one level lower, in ICU itself:

      ```
      loadICU(icuVersion='68.2', collVersion='0.0', locale='')
      ucolOpen failed
      initUnicodeCollation: Utf16Collation::create returned null
      ```

      `ucol_open` on the root locale returns null. **Emscripten's ICU port
      (`-sUSE_ICU=1`) is built without collation data.** The engine is asking
      correctly and ICU has nothing to answer with.

      So this is not a Firebird integration problem and cannot be fixed by
      registering something differently. It needs an ICU built for wasm *with*
      collation data — either a custom build with a data filter that keeps
      `coll`, or shipping `icudt*.dat` and pointing ICU at it with
      `u_setDataDirectory`. Both mean owning an ICU build rather than using
      Emscripten's port, and collation data is not small: this is a comparable
      piece of work to everything above it, with its own size question.

      Until then: no case-insensitive comparison, no accent-insensitive search,
      and `ORDER BY` on UTF8 text sorts by code point.

      The option stays **off by default** for that reason: it costs 616 KB and
      buys legacy codepages, not the collations most applications would want it
      for.

      What remains was never the size problem:

      1. `IntlManager` reaches the module through
         `ModuleLoader::fixAndLoadModule` and `findSymbol`, both of which assume
         `dlopen`. Something must resolve `LD_lookup_charset`,
         `LD_lookup_texttype`, `LD_lookup_texttype_with_status`,
         `LD_setup_attributes` and `LD_version` to the statically linked
         definitions — a `ModuleLoader` shim for Emscripten, or an
         `IntlManager` patch registering a builtin module.
      2. `fbintl.conf` (`builds/install/misc/`) maps charsets to modules and
         has to exist in Emscripten's filesystem, or be compiled in.
      3. Patch 0004 trims `defaultCharSets` so `CREATE DATABASE` does not fail
         on a charset with no implementation; it would become conditional on
         the option rather than on `__EMSCRIPTEN__`.

      Whether 245 KB on every download is worth encodings most web applications
      never touch is a judgement, not an obstacle. `UTF8` is a built-in.

      **How PGlite handles the same problem, and why it does not transfer.**
      PGlite bundles no ICU data at all; locale support is a separate npm
      package, `@electric-sql/pglite-icu-full`, passed at startup as
      `icuDataDir`. Its own docs say that package "loads the entire locale set
      provided by libicu, which might be quite large", and point users at
      libicu's build tools to cut a smaller one.

      That works because ICU locale data is *data*, designed to be loaded from
      outside the binary, and it is large relative to the engine — large enough
      to be worth a second download and an API to opt into. Firebird's charsets
      are *code*: conversion routines and tables in a module the engine
      normally `dlopen`s, and they are **616 KB on a 9.1 MB artifact**. Paying
      for a separate package, a second artifact, or runtime dynamic linking to
      avoid 245 KB compressed is a worse trade than simply including it.

      Emscripten *can* do the PGlite-shaped thing: `dlopen` works for side
      modules. But `MAIN_MODULE=1` disables dead-code elimination outright and
      `MAIN_MODULE=2` needs every symbol maintained by hand, and Emscripten
      documents dynamic linking with pthreads as experimental — which this
      build is entirely built on. The cost of that route exceeds what it would
      save.

      So the realistic choice is between compiling the charsets in for everyone
      and leaving them out for everyone, not between bundling and lazy-loading.

      **And the cost of leaving them out is larger than "no SJIS".** Measured
      against the current build: `UNICODE`, `UNICODE_CI` and `UNICODE_CI_AI`
      are *listed* in `RDB$COLLATIONS` but fail on use —

      ```
      CREATE TABLE t (name VARCHAR(50) CHARACTER SET UTF8 COLLATE UNICODE_CI)
      -> COLLATION UNICODE for CHARACTER SET "SYSTEM"."UTF8" is not installed
      ```

      So today there is no case-insensitive comparison, no accent-insensitive
      search, and no locale-aware ordering — `ORDER BY` on UTF8 text sorts by
      code point. Those are ordinary requirements, not exotic ones, and being
      listed-but-broken is worse than being absent: it looks supported until it
      is used.

      Taking only the ICU collations and dropping the legacy codepages would be
      the ideal trade, and does not work: `ld.cpp` holds a single static table
      naming all 89 charsets, and a subset build leaves 175 undefined symbols.
      Trimming that table is possible but buys 616 KB in exchange for a new
      invasive patch to rebase onto every Firebird release.
6. **No sync.** The "electric" in the project name is still aspirational.
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

*Complete except the typed wire format.*

- [x] `fb_execute_params` / `fb_query_params`. Bound through the statement's
      *declared* metadata plus `IUtil::convert`, not `IMetadataBuilder` — the
      builder approach failed with a bare "internal error" and was abandoned.
- [x] Thread `txHandle` through `fb_execute`/`fb_query`.
- [x] Add an explicit `tx.rollback()`. Browser in `4380ce7`, Node in `b6accb4`.
- [ ] Replace the JSON ABI with a typed encoding. **Half done, and the other
      half should probably not be this.** `FieldInfo` carries `type`,
      `typeName`, `subType`, `scale`, `length` and `nullable`, so a caller can
      tell an exact `NUMERIC` from a `VARCHAR` of digits. Values still travel
      as decimal strings, ISO-8601 and base64.

      Measured before planning the rest, and the premise did not survive:
      `JSON.parse` is **8 ms of a 45 ms decode** on 10,000 rows. The dominant
      cost is **33 ms building row objects**, which a binary format would not
      change — and which a generated constructor cuts by 12× with no ABI change
      at all. See [plans/typed-results.md](./plans/typed-results.md) for the
      numbers and what to do instead: fast row construction, opt-in typed
      values, and a binary path for BLOBs only where base64 actually costs
      something. **Steps 1 and 2 are done**: row construction is 5.5x faster on
      large results and 17x on repeated small ones, and `types:` converts
      `BIGINT`, binary `BLOB` and `DATE`/`TIMESTAMP` on request. Only the
      binary BLOB side-channel remains, and only if a workload wants it.
- [x] `exec()` accepts multi-statement scripts and returns one result per
      statement. Splitting respects strings, quoted identifiers, comments and
      `SET TERM`.
- [x] Populate `affectedRows` on the browser path.

### M3 — Persistence you can trust

*Complete except two conveniences.*

- [x] Dirty-page tracking: only pages whose contents changed are written.
- [x] An interrupted persist cannot corrupt the database. Achieved with a
      single IndexedDB transaction rather than the write-then-flip scheme
      sketched here — IndexedDB is already all-or-nothing, so the flip was
      solving a problem the store does not have.
- [x] `dumpDataDir()` / `loadDataDir` on `FirebirdBrowser`. Not the convenience
      wrapper this entry expected: both read and write the *live* engine
      filesystem rather than the VFS's `exportDatabase()`/`importDatabase()`,
      which read and write IndexedDB. That is what makes an unpersisted write
      dumpable and a `memory://` database dumpable at all.
- [x] `memory://`-equivalent ephemeral mode (skip IndexedDB entirely).
- [x] Auto-persist policy: debounced after writes, plus a best-effort flush on
      `visibilitychange` and `pagehide`. On by default.

### M4 — Concurrency, distribution, reactivity

- [x] Run the engine in a Web Worker; keep the main thread free. Not an
      optimisation — Firebird blocks on mutexes while opening a database and a
      browser main thread may not block, so the main-thread path deadlocked.
- [x] Multi-tab *safety*: an exclusive Web Lock per database refuses a second
      tab rather than letting it overwrite the first.
- [x] Multi-tab *sharing*: leader election over the existing Web Lock, with
      followers proxying to the leader over `BroadcastChannel`. Chosen over a
      `SharedWorker` holding the engine because it reuses the lock already
      built and works anywhere Web Locks do, without depending on a
      SharedWorker being able to spawn the nested Workers pthreads needs.
- [x] OPFS backend with sync access handles. Not a VFS beside the engine but a
      filesystem *under* it: Firebird's `read`/`write` reach JavaScript through
      Emscripten's FS, which was measured before any of it was designed — 1,678
      writes and 14.1 MB for a create-and-insert. Two things the sketch did not
      anticipate: the WASM heap is a `SharedArrayBuffer` under pthreads and OPFS
      rejects views onto one, so every I/O copies through a scratch buffer; and
      a sync access handle creates its file on open, so "does this database
      exist" has to mean *has bytes* or the engine's `O_CREAT | O_EXCL` fails
      with EEXIST on a database that was never written.
- [x] Publish the prebuilt artifact to npm. Shipped in `firebird-wasm@0.1.0`.
- [ ] A size budget and a default `locateFile` for CDN use; the 9 MB artifact
      is currently unbudgeted and every consumer wires `locateFile` by hand.
- [ ] Live queries built on `POST_EVENT`; a `listen()` / `notify()` API.
      **Blocked**, not merely unstarted — the subscription C API is written
      (`events-wip`) and the engine delivers exactly one event and then stops.
      §1 records what was measured and where to resume. A polling
      implementation is unblocked if the push one stays stuck.
- [ ] Verified Vite and webpack example apps in CI.

### M5 — Ecosystem

- [ ] React/Vue hooks; REPL component.
- [ ] ElectricSQL sync integration (the project's namesake).
- [ ] A Firebird version build matrix. The submodule tracks `master` and the
      shipped engine reports `ENGINE_VERSION 6.0.0`, so the recurring "Firebird
      4 & 5 support" line was always mis-stated: what is missing is *testing
      across versions*, not initial support for them.

---

## 5. Test coverage added alongside this review

`src/browser/` was excluded from Jest and had no browser tests.  It now has 73
Playwright tests running in real Chromium against real IndexedDB
(`npm run test:browser -w e2e`), plus 16 driving the published demo site and 6
against a real Firebird server.

> Counts as of b6accb4: **73** browser (`playwright.wasm.config.ts`), **16**
> demo (`playwright.demo.config.ts`), **6** server-backed
> (`playwright.config.ts`), and **40** Jest across four suites. The narrative
> below describes the first pass, when there were 30; the coverage has grown
> with each feature rather than being rewritten each time.

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

---

## 6. ICU collation data — branch `icu-collation`, PR #12, not merged

`main` ships with `UNICODE`, `UNICODE_CI` and `UNICODE_CI_AI` listed in
`RDB$COLLATIONS` and failing on use, so there is no case-insensitive
comparison, no accent-insensitive search, and `ORDER BY` on UTF8 text sorts by
code point. The branch fixes that. It is recorded here because the two causes
are the sort of thing that costs a day to rediscover.

### Cause 1 — Emscripten's ICU port ships no data

`-sUSE_ICU=1` links `libicu_stubdata`: ICU's code with none of its data, so
`ucol_open()` returns `U_FILE_ACCESS_ERROR`. Stub data exists precisely so an
application can supply its own, so no ICU build is needed —
`tools/build-icu-data.sh` trims ICU 68.2's own `icudt68l.dat` with `icupkg`
(already in the port's download cache), and `fb_wasm_icu_data.cpp` hands it to
`udata_setCommonData()` from `fb_init()`.

### Cause 2 — a cast function pointer that traps only on WebAssembly

With data in place the first collation aborted with `null function or function
signature mismatch`. `emsymbolizer` on a debug build put it at
`unicode_util.cpp:1706`, beside `ucolGetContractionsAndExpansions`. Patch 0002
had already named the reason in a comment: *ICU returns `void` there; the
struct field declares `int32_t`.*

A function's type in WebAssembly includes its return type and indirect calls
are type-checked, so calling a `void` function through an `int32_t`-returning
pointer aborts. Native builds survive the same cast because the caller ignores
a return register nobody reads. A forwarding wrapper of the declared shape
fixes it.

### Result

```
CREATE with COLLATE UNICODE_CI      -> ok
case-insensitive match              -> [{"NAME":"Ähnlich"}]   ('ähnlich' matched)
accent-insensitive (UNICODE_CI_AI)  -> [{"V":"café"}]         ('CAFE' matched)
locale-aware ORDER BY               -> Apfel < Ärzte < Zebra
```

| Package | raw | gzipped |
|---|---|---|
| `coll/root.res` + `coll/ucadata.icu` | 800 KB | 270 KB |
| Whole collation tree, 170 locales | 3.3 MB | ~1.1 MB |

Open before it merges: which package to ship (the 800 KB one has not been
retested since the loading mechanism started working, so the minimum is
unknown), whether either flag defaults on, CI needing `icu-devtools`, the
unenforced coupling between the data file and the port's ICU `TAG`, and the
absence of any automated test — the evidence above is from a script run by
hand.
