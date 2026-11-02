# Architecture

electric-firebird is structured as a monorepo with a single published package
(`firebird-wasm`) that exposes two distinct backends behind a shared async API,
along with subpath modules for reactive UI frameworks, ORMs/query builders,
ElectricSQL sync, vector search, and an interactive Web Component REPL.

---

## High-level diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Application code & Subpath Integrations                    │
│  (React / Vue / Svelte / Solid / Kysely / Drizzle / Vector) │
├────────────────────────────┬────────────────────────────────┤
│  FirebirdLite              │  FirebirdBrowser               │
│  packages/firebird-wasm/   │  packages/firebird-wasm/       │
│  src/firebird.ts           │  src/browser/firebird-browser.ts│
├────────────────────────────┼────────────────────────────────┤
│  node-firebird-driver-     │  firebird-embedded(-st).wasm   │
│  native (native bindings)  │  (Emscripten WASM build)       │
├────────────────────────────┼────────────────────────────────┤
│  libfbclient.so /          │  Emscripten MEMFS / OPFSVFS    │
│  fbclient.dll              │  + IndexedDBVFS + AES-256-GCM  │
└────────────────────────────┴────────────────────────────────┘
```

---

## Backend 1 — Node.js native driver

`FirebirdLite` (`src/firebird.ts`) wraps
[node-firebird-driver-native](https://github.com/asfernandes/node-firebird-drivers/tree/master/packages/node-firebird-driver-native),
a high-level async TypeScript API over the Firebird C client library.

Key design decisions:

- **Lazy initialisation** — the native client is not loaded and the database is
  not opened until the first `exec()` / `query()` / `transaction()` call.
- **Auto-create** — if the database file does not yet exist, `createDatabase()`
  is called instead of `connect()`.
- **Auto-committed helpers** — `exec()` and `query()` each manage their own
  transaction internally; use `transaction()` when you need atomicity across
  multiple statements.
- **Isolation mapping** — the `IsolationLevel` strings are mapped to the
  Firebird-specific `TransactionIsolation` enum values:

  | `IsolationLevel` | Firebird isolation | TPB tag (WASM backend) |
  |------------------|--------------------|------------------------|
  | `READ_COMMITTED` | `READ_COMMITTED` | `isc_tpb_read_committed` + `isc_tpb_rec_version` |
  | `SNAPSHOT` | `SNAPSHOT` | `isc_tpb_concurrency` |
  | `SNAPSHOT_TABLE_STABILITY` | `CONSISTENCY` | `isc_tpb_consistency` |

  Both backends honour the same options. The browser path builds a transaction
  parameter buffer through `IXpbBuilder` — see `fb_start_transaction_ex` in
  `wasm/fb_wasm_api.cpp`, and `src/browser/isolation.ts` for the codes that
  cross the WASM boundary.

---

## Backend 2 — Browser WASM engine

`FirebirdBrowser` (`src/browser/firebird-browser.ts`) runs the Firebird
Embedded engine entirely in the browser tab or Web Worker.

### Initialisation sequence

```
FirebirdBrowser.ensureReady()
  └─ loadFirebirdWasm()          ← src/wasm-loader.ts
       └─ createFirebirdModule() ← firebird-embedded(-st).js (Emscripten factory)
  └─ mod.FS.mkdir('/data')
  └─ IndexedDBVFS.open(dbName) or OPFSVFS.open(dbName)
  └─ syncWithEmscriptenFS('populate', ...)
       └─ reads pages (and decrypts if AES-256-GCM encryptionKey is set) → MEMFS
  └─ mod._fb_init()
  └─ mod._fb_attach_database() or _fb_create_database()
```

### Persistence sequence

```
FirebirdBrowser.persist()
  └─ IndexedDBVFS.syncWithEmscriptenFS('persist', ...) or OPFSVFS.importDatabase()
       └─ FS.readFile(dbPath)          ← database pages
       └─ writes dirty pages (optionally AES-256-GCM encrypted) to IndexedDB or OPFS
```

### WASM C API & Binary Result ABI

The TypeScript layer communicates with the compiled engine through a flat C
API exported from `wasm/fb_wasm_api.cpp`:

| C function | Purpose |
|------------|---------|
| `fb_init()` / `fb_shutdown()` | Initialise / shut down the embedded engine |
| `fb_create_database(path)` | Create a new `.fdb` file |
| `fb_attach_database(path)` | Open an existing `.fdb` file |
| `fb_detach_database(handle)` | Close a database |
| `fb_execute(handle, tx, sql)` | Execute DDL / DML |
| `fb_query_params_bin(handle, tx, sql, params)` | Execute SELECT, return `FBR\x01` binary buffer |
| `fb_prepare` / `fb_stmt_cursor_open` / `fb_cursor_fetch_bin` | Reusable prepared statements & streaming binary cursors |
| `fb_blob_create` / `fb_blob_open` / `fb_blob_read` / `fb_blob_write` | Chunked BLOB streaming |
| `fb_js_udr_set_dispatcher` | Register JavaScript callback for `ENGINE JS` UDR functions & procedures |
| `fb_start_transaction_ex(handle, isolation, readOnly)` | Begin a transaction |
| `fb_commit(txHandle)` / `fb_rollback(txHandle)` | Commit / Rollback |
| `fb_cancel_operation(handle, kind)` | Abort an in-flight statement |

Results from `fb_query_params_bin` and `fb_cursor_fetch_bin` use a compact
little-endian binary wire format (`FBR\x01`) decoded directly from `HEAPU8` by
`decodeBinaryResult()` (`src/browser/binary-result.ts`), avoiding `JSON.parse`
overhead and keeping `BIGINT`, `DOUBLE PRECISION`, `BOOLEAN`, and binary
`BLOB` / `OCTETS` payloads in native binary form.

### Storage engines (`IndexedDBVFS`, `OPFSVFS`, `memory://`)

- **`IndexedDBVFS`** (`src/browser/indexeddb-vfs.ts`) — stores each Firebird
  page (default 8 KiB) as a separate IndexedDB record keyed by page number,
  rewriting only dirty pages on `persist()`. Supports Copy-on-Write (CoW)
  in-memory page snapshots (`createSnapshot`, `restoreSnapshot`, `forkTo`) and
  optional WebCrypto AES-256-GCM per-page encryption (`src/browser/page-crypto.ts`).
- **`OPFSVFS`** (`src/browser/opfs-vfs.ts`) — direct block-level page I/O over
  the Origin Private File System (`FileSystemSyncAccessHandle` in Workers with
  async OPFS file fallback), plus the same CoW snapshot and AES-256-GCM page
  encryption capabilities.
- **`memory://`** — ephemeral in-memory database on Emscripten `MEMFS`.

---

## Repository layout

```
electric-firebird/
├── docs/                        ← this documentation
├── demo/                        ← interactive playground published to GitHub Pages
├── examples/                    ← Vite, webpack, and ElectricSQL example apps
├── e2e/                         ← Playwright end-to-end tests
├── packages/
│   └── firebird-wasm/
│       ├── bench/               ← decode benchmark & CI regression guard
│       ├── src/
│       │   ├── __tests__/       ← Vitest unit & WASM integration tests
│       │   ├── browser/         ← FirebirdBrowser, IndexedDBVFS, OPFSVFS, binary ABI
│       │   ├── drizzle/         ← Drizzle-style query builder & schema codegen
│       │   ├── electric/        ← ElectricSQL client shape sync & write queue
│       │   ├── electric-server/ ← Firebird-backed Electric shape server
│       │   ├── kysely/          ← Kysely dialect & TypeScript schema codegen
│       │   ├── react/           ← React hooks & provider
│       │   ├── repl/            ← <firebird-repl> Web Component + Inspector
│       │   ├── solid/           ← SolidJS hooks & context
│       │   ├── svelte/          ← Svelte 5 context & reactive stores
│       │   ├── vector/          ← Vector embeddings codec, UDRs & similarity search
│       │   ├── vue/             ← Vue 3 composables & provider
│       │   ├── firebird.ts      ← FirebirdLite (Node.js backend)
│       │   ├── index.ts         ← Node.js entry point
│       │   ├── types.ts         ← Shared TypeScript types
│       │   └── wasm-loader.ts   ← WASM module loader & ICU locale loader
│       └── wasm/
│           ├── build.sh         ← Emscripten build script (Firebird 5.0 LTS & 6.0)
│           ├── CMakeLists.txt   ← CMake build configuration
│           ├── fb_wasm_api.cpp  ← Exported C API & ENGINE JS IExternalEngine
│           └── fb_wasm_stubs.cpp ← Minimal browser platform stubs
├── package.json                 ← Workspace root
└── tsconfig.json
```

---

## CI

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | push / PR | TypeScript build, Vitest unit tests, decode benchmark, and Node driver tests against Firebird 3, 4 and 5 |
| `e2e.yml` | push / PR | Playwright browser tests and Node e2e tests against Firebird |
| `build-wasm.yml` | push / PR | Compiles Firebird to WASM (single-threaded & threaded) and runs the real-engine Vitest & Playwright suites |
| `deploy-demo.yml` | push to `main` | Builds and deploys the interactive playground to GitHub Pages |
