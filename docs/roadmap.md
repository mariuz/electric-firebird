# Roadmap & PGlite gap analysis

electric-firebird's stated goal is "Firebird embedded in WASM, similar to
[PGlite](https://pglite.dev) for PostgreSQL".  This document audits how far
that goal actually is, compares the API surface against PGlite feature by
feature, and proposes a staged roadmap.

Last reviewed: 2026-08-08.

---

## 1. Where the project actually stands

The previous roadmap read:

```
- [x] True WASM build infrastructure (Emscripten CMake + build script)
- [x] Browser support module (FirebirdBrowser)
- [x] IndexedDB persistence layer (IndexedDBVFS)
- [ ] Pre-built WASM binary published to npm
- [ ] Firebird 4 & 5 support
```

Those three ticks are accurate about the *TypeScript and build scaffolding*,
but they hide the load-bearing fact:

> **The WASM C API is a stub.  No Firebird code runs in the browser yet.**

Every function in [`wasm/fb_wasm_api.cpp`](../packages/firebird-wasm/wasm/fb_wasm_api.cpp)
is a `TODO` that ignores its arguments:

| Export | Current behaviour |
|--------|-------------------|
| `fb_init` | returns 0 without initialising a provider |
| `fb_create_database` | returns `0` — which the TS layer reads as *failure* |
| `fb_attach_database` | returns `0` — same |
| `fb_execute` | returns 0, executes nothing |
| `fb_query` | returns a constant `{"columns":[],"rows":[]}` |
| `fb_start_transaction` | returns `0` — the TS layer throws `Failed to start transaction` |

Consequences worth being explicit about:

1. **`FirebirdBrowser` cannot open a database today**, even with the WASM
   artifact built: `_fb_create_database` returning 0 makes `init()` throw
   `Failed to open database`.  The browser quick-start in the README and in
   [browser.md](./browser.md) does not yet work end to end.
2. **`e2e/tests/wasm.spec.ts` cannot detect this.**  It asserts `_fb_init()`
   returns 0 and that `_fb_query()` yields JSON with `columns`/`rows` arrays —
   both of which the stub satisfies by construction.  That suite is a build/
   packaging smoke test, not an engine test, and should be labelled as such.
3. `wasm/fb_wasm_stubs.cpp` is ~1 900 lines of link-time stubs.  Some are
   legitimately unreachable in an embedded browser build (services API,
   `NBACKUP`, `gsec`); the ones on the DSQL/JRD path have to be replaced with
   real code before anything executes.

So the honest status is: **build plumbing done, engine not wired up.**  The
roadmap below is ordered accordingly — everything else is downstream of §M1.

### Also found during this review

| # | Issue | Impact |
|---|-------|--------|
| 1 | `FirebirdBrowser.query(sql, params)` accepts `params` and **silently discards them** (the parameter is `_params`). | Same application code returns *different* results on Node and in the browser, with no error. The worst failure mode there is. |
| 2 | `FirebirdBrowserTransaction.exec/query` pass `dbHandle`, never `txHandle`. | Statements do not run inside the transaction they appear to belong to; `rollback()` cannot undo them. The C ABI has no transaction parameter on `fb_execute`/`fb_query`, so this cannot be fixed in TypeScript alone. |
| 3 | `persist()` rewrites the **whole** database: `importDatabase()` calls `clear()` and then writes every page. | O(db size) per persist, and non-atomic — a tab closed mid-persist leaves a truncated database with no recovery path. The page-keyed storage layout is already there; nothing tracks dirty pages. |
| 4 | Two tabs on the same origin both open `firebird_<name>` and both persist whole images. | Silent, unrecoverable data loss. Currently undocumented. |
| 5 | JSON is the result ABI. | No BLOBs; `BIGINT`/`DECFLOAT`/`NUMERIC` lose precision through the JSON number type; `DATE`/`TIMESTAMP` arrive as untyped strings. `FieldInfo` carries only `name`, so a client cannot correct for it. |
| 6 | `loadFirebirdWasm()` caches one module in a module-level variable with no way to dispose it. | `close()` does not release the WASM heap; per-instance isolation is impossible; test isolation requires a page reload. |
| 7 | Jest config sets `testPathIgnorePatterns: ["/src/browser/"]`, and there were no browser tests. | The entire browser layer was untested. **Addressed by this change** — see §5. |
| 8 | `e2e` resolved WASM artifact paths one directory too high (`../../../packages/...` from `e2e/server`). | The WASM suite would have skipped and the server 404'd *even after a successful build*. **Fixed in this change.** |

---

## 2. Feature comparison with PGlite

Legend: ✅ shipped · 🟡 partial · ❌ missing · n/a not applicable

### Core query API

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| `query(sql, params)` | ✅ | 🟡 | Works on Node; **params ignored in the browser** |
| Template-literal `` sql`…` `` tag | ✅ | ❌ | Ergonomics + injection safety |
| `exec(sql)` multi-statement script → array of results | ✅ | ❌ | `exec()` is single-statement and returns `void`; migrations are the use case |
| `rowMode: 'object' \| 'array'` | ✅ | ❌ | Always object mode |
| Custom `parsers` / `serializers` | ✅ | ❌ | |
| `describeQuery()` | ✅ | ❌ | |
| Typed field metadata (`dataTypeID`) | ✅ | ❌ | `FieldInfo` is `{ name }` only |
| Affected-row count | ✅ | 🟡 | `QueryResult.affectedRows` is optional and unset on the browser path |
| Binary / BLOB values | ✅ | ❌ | Blocked by the JSON ABI |

### Transactions

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| `transaction(cb)` with auto commit/rollback | ✅ | 🟡 | Control flow is correct and now tested; statements don't actually join the transaction (§1.2) |
| Explicit `tx.rollback()` | ✅ | ❌ | Rollback only via throwing |
| Isolation levels | ✅ | 🟡 | `TransactionOptions` is honoured on Node, ignored in the browser |

### Storage & persistence

| Capability | PGlite | electric-firebird | Notes |
|---|---|---|---|
| In-memory / ephemeral database | ✅ `memory://` | ❌ | Everything goes through IndexedDB |
| Node filesystem | ✅ `file://` | ✅ | Via the native driver, not WASM |
| IndexedDB | ✅ `idb://` | 🟡 | Whole-image, non-atomic (§1.3) |
| OPFS | — | ❌ | The natural fit for Firebird's page I/O; see M4 |
| Incremental / dirty-page writes | ✅ | ❌ | |
| Durability tuning (`relaxedDurability`) | ✅ | ❌ | |
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

- [ ] Make `FirebirdBrowser.query()` **throw** when passed parameters, until
      the parameterised C ABI exists.
- [ ] Document the multi-tab hazard in `browser.md` and refuse a second
      concurrent open of the same database name within a page.
- [ ] Relabel `wasm.spec.ts` as a packaging smoke test; state in the docs that
      the browser quick-start does not work yet.
- [x] Browser test coverage for the layer that *is* real (§5).
- [x] Fix the `e2e` WASM artifact path resolution.

### M1 — Make the engine actually run (the blocker)

- [ ] Wire `fb_init` to real provider initialisation (yvalve).
- [ ] Implement `fb_create_database` / `fb_attach_database` /
      `fb_detach_database` over `isc_*` or the OO API.
- [ ] Implement `fb_execute` via `isc_dsql_execute_immediate`.
- [ ] Implement `fb_query` with real cursor iteration.
- [ ] Replace the DSQL/JRD-path stubs in `fb_wasm_stubs.cpp`.
- **Acceptance:** in Chromium, `CREATE TABLE` → `INSERT` → `SELECT` returns the
  inserted row, asserted by a Playwright test that does *not* skip.

### M2 — A correct API surface

- [ ] `fb_execute_params` / `fb_query_params`: XSQLDA/message-buffer binding,
      then unignore `params`.
- [ ] Thread `txHandle` through `fb_execute`/`fb_query`; add `tx.rollback()`.
- [ ] Replace the JSON ABI with a typed encoding; carry Firebird type codes in
      `FieldInfo`; map `BIGINT`→`BigInt`, `TIMESTAMP`→`Date`, `BLOB`→
      `Uint8Array`.
- [ ] `exec()` accepts multi-statement scripts and returns one result per
      statement.
- [ ] Populate `affectedRows` on the browser path.

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

`src/browser/` was excluded from Jest and had no browser tests.  It now has 26
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

The suite was mutation-checked: reverting the column upper-casing and dropping
the `_fb_free_result` call each make it fail.

What it deliberately does **not** cover: whether Firebird itself produces
correct answers.  That needs M1.
