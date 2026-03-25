# Architecture

electric-firebird is structured as a monorepo with a single published package
(`firebird-wasm`) that exposes two distinct backends behind a shared async API.

---

## High-level diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Application code                                           │
│  (shared QueryResult / Row / FieldInfo types)               │
├────────────────────────────┬────────────────────────────────┤
│  FirebirdLite              │  FirebirdBrowser               │
│  packages/firebird-wasm/   │  packages/firebird-wasm/       │
│  src/firebird.ts           │  src/browser/firebird-browser.ts│
├────────────────────────────┼────────────────────────────────┤
│  node-firebird-driver-     │  firebird-embedded.wasm        │
│  native (native bindings)  │  (Emscripten WASM build)       │
├────────────────────────────┼────────────────────────────────┤
│  libfbclient.so /          │  Emscripten MEMFS              │
│  fbclient.dll              │  + IndexedDBVFS                 │
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

  | `IsolationLevel` | Firebird isolation |
  |------------------|--------------------|
  | `READ_COMMITTED` | `READ_COMMITTED` |
  | `SNAPSHOT` | `SNAPSHOT` |
  | `SNAPSHOT_TABLE_STABILITY` | `CONSISTENCY` |

---

## Backend 2 — Browser WASM engine

`FirebirdBrowser` (`src/browser/firebird-browser.ts`) runs the Firebird
Embedded engine entirely in the browser tab.

### Initialisation sequence

```
FirebirdBrowser.ensureReady()
  └─ loadFirebirdWasm()          ← src/wasm-loader.ts
       └─ createFirebirdModule() ← firebird-embedded.js (Emscripten factory)
  └─ mod.FS.mkdir('/data')
  └─ IndexedDBVFS.open(dbName)
  └─ IndexedDBVFS.syncWithEmscriptenFS('populate', ...)
       └─ reads all pages from IndexedDB → MEMFS
  └─ mod._fb_init()
  └─ mod._fb_attach_database() or _fb_create_database()
```

### Persistence sequence

```
FirebirdBrowser.persist()
  └─ IndexedDBVFS.syncWithEmscriptenFS('persist', ...)
       └─ FS.readFile(dbPath)          ← entire DB as Uint8Array
       └─ IndexedDBVFS.importDatabase()
            └─ writes pages to IndexedDB
```

### WASM C API

The TypeScript layer communicates with the compiled engine through a flat C
API exported from `wasm/fb_wasm_api.cpp`:

| C function | Purpose |
|------------|---------|
| `fb_init()` | Initialise the embedded engine |
| `fb_create_database(path)` | Create a new `.fdb` file |
| `fb_attach_database(path)` | Open an existing `.fdb` file |
| `fb_detach_database(handle)` | Close a database |
| `fb_execute(handle, sql)` | Execute DDL / DML |
| `fb_query(handle, sql)` | Execute SELECT, return JSON result |
| `fb_free_result(ptr)` | Free a result buffer |
| `fb_start_transaction(handle)` | Begin a transaction |
| `fb_commit(txHandle)` | Commit |
| `fb_rollback(txHandle)` | Rollback |

Results from `fb_query` are serialised as JSON:

```json
{
  "columns": ["ID", "NAME"],
  "rows": [[1, "hello"], [2, "world"]]
}
```

### IndexedDB storage

`IndexedDBVFS` (`src/browser/indexeddb-vfs.ts`) provides page-level
persistence.  Each Firebird page (default 8 KiB) is stored as a separate
IndexedDB record, keyed by its zero-based page number.  A special `__meta__`
record tracks `pageSize` and `pageCount`.

---

## Repository layout

```
electric-firebird/
├── docs/                        ← this documentation
├── e2e/                         ← Playwright end-to-end tests
├── packages/
│   └── firebird-wasm/
│       ├── src/
│       │   ├── firebird.ts      ← FirebirdLite (Node.js backend)
│       │   ├── index.ts         ← Node.js entry point
│       │   ├── types.ts         ← Shared TypeScript types
│       │   ├── wasm-loader.ts   ← WASM module loader
│       │   └── browser/
│       │       ├── firebird-browser.ts  ← FirebirdBrowser
│       │       ├── indexeddb-vfs.ts     ← IndexedDB VFS
│       │       └── index.ts             ← Browser entry point
│       └── wasm/
│           ├── build.sh         ← Emscripten build script
│           ├── CMakeLists.txt   ← CMake build configuration
│           ├── fb_wasm_api.cpp  ← Exported C API
│           └── fb_wasm_stubs.cpp ← Stubs for .epp-generated code
├── package.json                 ← Workspace root
└── tsconfig.json
```

---

## CI

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | push / PR | TypeScript build + unit tests (Firebird Docker) |
| `e2e.yml` | push / PR | Playwright browser tests (Firebird Docker) |

Both workflows use the official
[firebirdsql/firebird](https://hub.docker.com/r/firebirdsql/firebird) Docker image.
