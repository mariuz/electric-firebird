# electric-firebird

Run Firebird embedded in WASM, similar to [PGlite](https://pglite.dev) for PostgreSQL.

## Overview

This monorepo contains:

| Package | Description |
|---------|-------------|
| [`packages/firebird-wasm`](./packages/firebird-wasm) | TypeScript library — PGlite-style async API for Firebird |
| [`e2e`](./e2e) | Playwright end-to-end tests |
| [`demo`](./demo) | The playground published to GitHub Pages |

## Try it

**[Open the SQL Console Demo →](https://mariuz.github.io/electric-firebird/)** · **[Open the Replication Simulator & Demo →](https://mariuz.github.io/electric-firebird/replication.html)**

A SQL console running the real engine in your browser — no server, nothing
uploaded. It ships worked examples for joins and aggregates, bound parameters,
a recursive CTE, `EXECUTE BLOCK`, transaction rollback, and exact `BIGINT` and
`NUMERIC` values that a JavaScript number could not hold. The database lives in
IndexedDB, so it is still there after a reload.

To run it locally, see [`demo/`](./demo) — you will need the WASM artifact
first. For the release notes, see [ANNOUNCEMENT.md](./ANNOUNCEMENT.md); to
put the engine in your own app, see the
[integration guide](./docs/integration.md).

## Quick start

```bash
npm install firebird-wasm
```

The compiled engine ships in the package, so nothing needs building.

### Node.js (native driver)

```ts
import { FirebirdLite } from 'firebird-wasm';

const db = new FirebirdLite('localhost:/tmp/my-app.fdb', {
  username: 'SYSDBA',
  password: 'masterkey',
});

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query("SELECT * FROM items");
console.log(result.rows); // [ { ID: 1, NAME: 'hello' } ]

await db.close();
```

### Browser (WASM + IndexedDB / OPFS / Memory)

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

// The engine runs in a Worker, which keeps long statements off the page.
// Build the worker script from `firebird-wasm/browser/worker-entry`.  The
// default build, firebird-embedded-st.js, has no threads and needs no
// cross-origin isolation; the threaded build (wasmGlueFile(true)) adds
// statement and idle timeouts, and needs COOP/COEP and the Worker
// (docs/integration.md §2).
const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
await db.exec('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query('SELECT * FROM items WHERE id = ?', [1]);
console.log(result.rows); // [ { ID: 1, NAME: 'hello' } ]

// Writes are saved automatically after a short debounce; persist() forces one.
await db.persist();
await db.close();
```

### Isomorphic `openDatabase(uri)` + Explicit Resource Management & One-Liner Sync

`openDatabase(uri)` opens `memory://`, `opfs://`, `idb://` (browser WASM) or `.fdb` / `host:/path.fdb` (Node.js) behind one `FirebirdDatabase` interface with `db.execute()`, `await using` (`Symbol.asyncDispose`), structured `FirebirdError` codes, and zero-boilerplate replication:

```ts
import { openDatabase, syncDatabases, isFirebirdError } from 'firebird-wasm/browser'; // or 'firebird-wasm' in Node.js

await using primary = await openDatabase('memory://primary');
await using replica = await openDatabase('memory://replica');

await primary.execute('CREATE TABLE todos (id INT NOT NULL PRIMARY KEY, title VARCHAR(100))');
const { affectedRows } = await primary.execute('INSERT INTO todos VALUES (?, ?)', [1, 'Ship M18']);

// Auto-bootstraps schema + initial rows, installs triggers, and keeps peers in sync:
await using sync = await syncDatabases(primary, replica); // or: await primary.syncWith(replica)

try {
  await primary.execute('INSERT INTO todos VALUES (?, ?)', [1, 'Duplicate PK']);
} catch (err) {
  if (isFirebirdError(err)) {
    console.error(err.gdscode, err.sqlState, err.constraint, err.hint); // 335544665, '23000', ...
  }
}
```

Two other names change where the database lives — `opfs://mydb` writes through
to a file with no persist step at all, and `memory://` keeps nothing — and a
statement can re-run itself when the data changes:

```ts
// Automatically watches referenced tables via generated FB_LIVE$ triggers,
// or pass explicit { events: ['items_changed'] } for custom POST_EVENT names:
const live = await db.live(
  'SELECT id, name FROM items ORDER BY id',
  (rows) => render(rows),
);

await live.unsubscribe();
```

In React, Vue, Svelte 5, or SolidJS, the same as a reactive hook or store:

```tsx
import { FirebirdProvider, useLiveQuery } from 'firebird-wasm/react'; // or /vue, /svelte, /solid

function Items() {
  const { rows } = useLiveQuery('SELECT id, name FROM items ORDER BY id');
  return <ul>{rows?.map((r) => <li key={r.ID}>{r.NAME}</li>)}</ul>;
}
```

### Subpath exports

| Import | Description |
|--------|-------------|
| `firebird-wasm` | `openDatabase`, `FirebirdLite`, `FirebirdError` — Node.js native/embedded driver + shared schema, vector, and replication helpers |
| `firebird-wasm/browser` | `openDatabase`, `FirebirdBrowser`, `FirebirdError`, `IndexedDBVFS`, `OPFSVFS`, snapshots/page diffs, and AES-256-GCM encryption helpers |
| `firebird-wasm/browser/worker-entry` | Dedicated Web Worker entry point for the WASM engine |
| `firebird-wasm/react` | React `<FirebirdProvider>`, `useFirebird`, `useQuery`, `useLiveQuery`, `useSyncStatus`, `useColumnarQuery`, `useLiveIncrementalQuery`, `useTable`, `useOptimisticMutation`, `useUndoRedo`, `usePresence` |
| `firebird-wasm/vue` | Vue 3 `provideFirebird`, `useFirebird`, `useQuery`, `useLiveQuery`, `useSyncStatus`, `useColumnarQuery`, `useLiveIncrementalQuery`, `useTable`, `useOptimisticMutation`, `useUndoRedo`, `usePresence` |
| `firebird-wasm/svelte` | Svelte 5 `setFirebirdContext`, `getFirebirdContext`, `useFirebird`, `createQuery`, `createLiveQuery`, `createSyncStatus`, `createColumnarQuery`, `createLiveIncrementalQuery`, `createTable`, `createOptimisticMutation`, `createUndoRedo`, `createPresence` |
| `firebird-wasm/solid` | SolidJS `setFirebirdContext`, `useFirebird`, `createQuery`, `createLiveQuery`, `createSyncStatus`, `createColumnarQuery`, `createLiveIncrementalQuery`, `createTable`, `createOptimisticMutation`, `createUndoRedo`, `createPresence` |
| `firebird-wasm/tanstack` | TanStack Query (`createFirebirdQueryOptions`, `connectFirebirdQueryClient`) & TanStack DB (`createFirebirdCollection`) adapters |
| `firebird-wasm/rxdb` | RxDB storage adapter (`getRxStorageFirebird`) backed by Firebird SQL |
| `firebird-wasm/repl` | `<firebird-repl>` custom element with Schema, Migrations, Profiler, Query Plan, Replication, and Arrow / Sync inspector tabs |
| `firebird-wasm/electric` | ElectricSQL Postgres shape sync (`syncShapeToTable`, `syncShapesToTables`, `syncShapes`, `createWriteQueue`) |
| `firebird-wasm/electric-server` | Firebird-backed shape server & HTTP handler (`createShapeServer`, `applyWrite`) |
| `firebird-wasm/kysely` | Kysely dialect (`FirebirdDialect`, `createKysely`) & TypeScript schema codegen (`generateKyselyTypes`) |
| `firebird-wasm/drizzle` | Drizzle-style query builder (`drizzle`, `firebirdTable`) & schema codegen (`generateDrizzleSchema`) |
| `firebird-wasm/vector` | Float32/Int8 vector codec, persistent HNSW ANN index (`HnswIndex`, `createVectorIndex`), semantic LLM cache (`createSemanticCache`), MMR diversity reranking (`mmrRerank`), `packRagContext`, and `vectorSearch` |
| `firebird-wasm/fts` | Okapi BM25 full-text search (`Bm25Index`, `createFtsIndex`), stemming/highlighting SQL UDRs, RRF + MMR `hybridSearch`, and `packRagContext` |
| `firebird-wasm/columnar` | Standalone zero-copy columnar vector decoder (`decodeBinaryResultColumnar`) & Apache Arrow IPC V5 codec (`encodeArrowIpc`, `decodeArrowIpc`) |
| `firebird-wasm/schema` | Standalone Standard Schema v1 row validator (`createRowSchema`, `validateRows`) & schema-aware SQL builder (`createTypedSql<DB>()`) |
| `firebird-wasm/replication` | One-liner (`syncDatabases`, `db.syncWith`), binary `.fdb` / page-diff bootstrap, S3/R2/HTTP object-store WAL shipping (`createObjectStoreReplicationTarget`, `restoreDatabaseToPointInTime`), CRDTs, mesh/hub, DLQ, PITR, `"FBCHANGELOG\0"` & `IReplicator` |

See [docs/integration.md](./docs/integration.md), [docs/replication.md](./docs/replication.md), and [docs/api.md](./docs/api.md) for full details and usage examples.

The two engine builds, with threads and without, are compared (with
diagrams) in [docs/builds.md](./docs/builds.md).

## Setup

### Requirements

- Node.js 20+
- Firebird client library (`libfbclient.so` / `fbclient.dll`)
- For the Node.js driver, a Firebird 3, 4 or 5 server: CI runs its tests
  against each

### Install

```bash
# Install dependencies for all workspaces
npm install

# Build the library
npm run build -w packages/firebird-wasm
```

### Run unit tests

```bash
FIREBIRD_PASSWORD=<password> npm test -w packages/firebird-wasm
```

### Run the decode benchmark

```bash
npm run bench                              # print the table
npm run bench -- bench-results/decode.json # …and record it
```

CI runs this and **fails on a regression**. It asserts ratios against the row
construction it replaced rather than wall-clock limits, so a slow runner
changes the numbers without changing the verdict. Needs `npm run build` first.

### Run e2e tests

```bash
cd e2e

# Browser suite — needs no Firebird server and no WASM artifact
npx playwright install chromium
npm run test:browser

# Node.js suite — needs a running Firebird server
FIREBIRD_PASSWORD=<password> npx playwright test
```

### Run the demo site

```bash
npm run build:wasm -w packages/firebird-wasm   # once; slow
npm run demo                                    # http://localhost:4173
npm run test:demo                               # 21 Playwright tests
```

The local server sends no COOP/COEP headers, exactly like GitHub Pages, so the
page is not cross-origin isolated and the demo runs the engine's build without
threads, which needs no `SharedArrayBuffer`. See
[`demo/README.md`](./demo/README.md).

### Example apps

[`examples/vite`](./examples/vite) and [`examples/webpack`](./examples/webpack)
are minimal apps built by their own bundlers; CI builds them and runs each with
and without cross-origin isolation. See [`examples/README.md`](./examples/README.md).

### Build the WASM module (optional)

The Emscripten SDK is vendored at `third_party/emsdk`, and the version is
pinned in `packages/firebird-wasm/wasm/emsdk-version.txt`:

```bash
cd third_party/emsdk
./emsdk install $(cat ../../packages/firebird-wasm/wasm/emsdk-version.txt)
./emsdk activate $(cat ../../packages/firebird-wasm/wasm/emsdk-version.txt)
source ./emsdk_env.sh
cd ../..

npm run build:wasm -w packages/firebird-wasm
```

The build refuses to run against a different Emscripten. That is not
fussiness: a mismatched toolchain compiles and links this engine perfectly
well and then aborts inside `fb_create_database` at runtime, so the check has
to happen at build time. Override with `FB_WASM_ALLOW_EMSDK_MISMATCH=1` if you
are deliberately testing another version.

## Architecture

The library provides two execution backends:

1. **Node.js** – Uses the Firebird **Embedded Server** (single-process mode) via
   [node-firebird-driver-native](https://github.com/asfernandes/node-firebird-drivers/tree/master/packages/node-firebird-driver-native).

2. **Browser (WASM)** – Compiles the Firebird embedded engine (`libfbembed`) to
   WebAssembly via [Emscripten](https://emscripten.org).  Three places to keep
   the database: **IndexedDB** by default, **OPFS** (`opfs://name`) where the
   engine writes its pages straight to a file with no image copy, and
   **memory** (`memory://`) for a scratch database that leaves nothing behind.

```
┌─────────────────────────────────────────────────┐
│  Application code (shared QueryResult/Row types) │
├────────────────────┬────────────────────────────┤
│  FirebirdLite      │  FirebirdBrowser           │
│  (Node.js native)  │  (WASM + IndexedDB / OPFS) │
├────────────────────┼────────────────────────────┤
│  libfbclient.so    │  firebird-embedded.wasm    │
│                    │  + IndexedDB / OPFS / memory│
└────────────────────┴────────────────────────────┘
```

### Roadmap

> **Status: Firebird runs in WebAssembly.**  The engine creates a database,
> executes DDL and DML, and returns rows:
>
> ```
> create_database  -> 1
> exec             -> CREATE TABLE items (id INTEGER, name VARCHAR(32))
> exec             -> INSERT INTO items VALUES (1, 'alpha')
> ROWS: {"columns":[{"name":"ID","type":496,"subType":0,"scale":0,"length":4,"nullable":true},{"name":"NAME","type":448,"subType":0,"scale":0,"length":128,"nullable":true}],"rows":[[1,"alpha"],[2,"beta"]]}
> ```
>
> Verified in Node (integration tests) **and in Chromium** through the
> public `FirebirdBrowser` API — including transactions and data surviving a
> page reload via IndexedDB and OPFS.  Databases created by this build define
> the built-in character sets (UTF8 among them) and support optional on-demand
> ICU locale collation packs — see [docs/roadmap.md](./docs/roadmap.md).

- [x] WASM build infrastructure (Emscripten CMake + build script, targeting Firebird 5.0 LTS & 6.0)
- [x] Browser support module (`FirebirdBrowser`)
- [x] IndexedDB persistence layer (`IndexedDBVFS`) & direct block-level OPFS page PIO (`OPFSVFS`)
- [x] Browser test suite (Playwright, real Chromium + real IndexedDB)
- [x] C API implemented over the Firebird OO API — attach/create, transactions, cursors, typed values, engine error text
- [x] Transactions that bind statements to the transaction handle
- [x] Link the WASM build (Emscripten vendored at `third_party/emsdk`)
- [x] Compile Firebird's metadata layer for real (gpre boot pass) instead of stubbing it
- [x] Fix the memory-pool corruption (`autoconfig.h` described the 64-bit host: `SIZEOF_VOID_P`/`SIZEOF_SIZE_T`)
- [x] Enable C++ exceptions (`-fwasm-exceptions`) — Firebird reports every error by throwing
- [x] Threads (`-pthread` + a pre-spawned worker pool), real `sem_timedwait`, realistic stack sizes
- [x] Attach threads to the libcds hazard-pointer GC, which the metadata cache requires
- [x] **The engine runs: create database, DDL, DML, SELECT**
- [x] Run the engine in a Web Worker (verified in Chromium end to end)
- [x] Point `FirebirdBrowser` at the Worker (real SQL through the public API, verified in Chromium)
- [x] Parameterised queries (`?` placeholders) on both backends
- [x] Incremental, atomic IndexedDB persistence (one transaction, changed pages only)
- [x] Web Worker + multi-tab safety, and multi-tab *sharing* (`multiTab: 'shared'`)
- [x] Pre-built WASM binary published to npm — `npm install firebird-wasm`
- [x] Live queries / `POST_EVENT`-based notifications (`live()`, `listen()`, `notify()`), including cross-tab `BroadcastChannel` fan-out
- [x] React, Vue, Svelte 5, and SolidJS hooks (`firebird-wasm/react`, `/vue`, `/svelte`, `/solid`)
- [x] A REPL component: `<firebird-repl>` (`firebird-wasm/repl`) with Schema, Migrations, Query Profiler, Plan Explorer, and Replication inspector tabs
- [x] Sync a Postgres table through ElectricSQL (`firebird-wasm/electric`) with relational `syncShapes` and conflict-aware `createWriteQueue`
- [x] Sync a Firebird server's table the same way (`firebird-wasm/electric-server`), with `where`, join pushdown, `replica=full`, and `applyWrite`
- [x] Reusable prepared statements (`db.prepare()`), streaming cursors (`queryStream()`), BLOB streams (`createBlobStream()` / `openBlobStream()`), and `COPY`-style bulk CSV/JSONL streams (`copyFromStream()` / `copyToStream()`)
- [x] Database dump/restore (`dumpDataDir()` / `loadDataDir`, `dumpDataStream()` / `loadDataStream()`), schema introspection (`introspect()`), schema diffing (`diffSchema()` / `generateMigration()`), and declarative migrations (`migrate()`)
- [x] Nested savepoints (`tx.savepoint()`), `AbortSignal` / `timeoutMs` statement cancellation, and query observability (`db.onQuery()` / `db.monitorStats()`)
- [x] WebCrypto AES-256-GCM page encryption at rest, Copy-on-Write snapshots & branching (`db.snapshot()`, `db.restoreSnapshot()`, `db.branch()`), and incremental binary page diffs (`db.exportDiff()` / `db.applyDiff()`)
- [x] JavaScript User-Defined Functions & Procedures (`db.registerFunction()` / `db.registerProcedure()`) via a native C++ `IExternalEngine` (`ENGINE JS`) bridge
- [x] Vector embeddings, HNSW ANN index (`firebird-wasm/vector`), BM25 full-text & RRF hybrid search (`firebird-wasm/fts`), Kysely / Drizzle adapters + schema codegen (`firebird-wasm/kysely`, `firebird-wasm/drizzle`), and TanStack Query/DB & RxDB adapters (`firebird-wasm/tanstack`, `firebird-wasm/rxdb`)
- [x] Full database replication (`firebird-wasm/replication`) — PSQL trigger capture, replication slots, HLC/CRDT conflict resolution, multi-node mesh/hub coordinator, DLQ (`FB_REPL_DLQ$`), AES-256-GCM PITR journal archives, time-travel (`asOfLsn`/`rewindToLsn`), and native Firebird `"FBCHANGELOG\0"` / `IReplicator` engine replication
- [x] Typed binary result wire format (`FBR\x01`), on-demand ICU locale collation packs (`loadIcuLocaleData`), and Firebird 5.0 LTS + 6.0 WASM build targets
- [x] Unified isomorphic `openDatabase(uri)` + `FirebirdDatabase` (`db.execute()`, `Symbol.asyncDispose`), structured `FirebirdError` (`gdscode`/`sqlState`/`hint`), one-liner `syncDatabases()` / `db.syncWith()`, `IBatch` `UPDATE OR INSERT` catch-up, Worker-safe `db.setReplicaMode()` / `db.applyChangelog()`, and HTTP/WebSocket `"FBCHANGELOG\0"` gzip streaming
- [x] End-to-end `mode: 'native'` sync preset & single-thread inline `"FBCHANGELOG\0"` emission, zero-copy `db.queryColumnar()` & Apache Arrow IPC (`db.queryArrow()`, `encodeArrowIpc`, `decodeArrowIpc`), WebRTC `RTCDataChannel` P2P sync (`createWebRtcReplicationPeer`) + resilient auto-reconnecting HTTP/WebSocket transports & resumable snapshots, Standard Schema v1 validation (`Zod`/`Valibot`/`ArkType` + `createTypedSql<DB>()`), and the `npx firebird-wasm` developer CLI (`query`, `repl`, `codegen`, `migrate`, `dump`, `restore`, `inspect-changelog`)
- [x] Binary `.fdb` / page-diff replica bootstrap (`bootstrapStrategy: 'binary-image' | 'page-diff'`) + S3/R2/HTTP object-store WAL shipping (`createObjectStoreReplicationTarget`, `restoreDatabaseToPointInTime`, AWS SigV4), pipelined multi-statement execution (`db.pipeline()`) + `"FBP\x01"` / `"FBP\x02"` binary parameter wire frames, incremental & columnar live queries (`db.liveIncremental()`, `db.liveColumnar()`), reactive framework sync/columnar hooks (`useSyncStatus`, `useColumnarQuery`, `useLiveIncrementalQuery`), and standalone `firebird-wasm/columnar` & `firebird-wasm/schema` subpaths
- [x] Read/write splitting replica router with causal `read-your-writes` LSN fencing & automatic failover (`createReplicaRouter`), object-store checkpoint rotation & segment pruning (`checkpointEverySegments`, `pruneArchivedSegments`), bounded-memory streaming columnar & Apache Arrow IPC V5 cursors (`db.queryColumnarStream()`, `db.queryArrowStream()`), pre-compiled `stmtHandle` pipelines (`db.preparePipeline()`), zero-boilerplate typed `db.table<T>()` CRUD/upsert/keyset-pagination API, and CLI `sync`, `wal-ship`, `pitr-restore`, & `bench` commands
- [x] Multi-tenant partitioned replication slices & HTTP `403` / WS inbound tenant isolation guards (`createTenantReplicationSlice`, `TenantIsolationError`), zero-copy Apache Arrow IPC ingestion (`db.loadArrowIpc()`, `table.insertArrow()` / `upsertArrow()`) & LRU `PreparedStatement` caching in `db.table<T>()`, optimistic local-first mutation store (`createOptimisticMutationStore`) + reactive `useTable`/`createTable` hooks across React/Vue/Svelte/Solid, and the zero-config `npx firebird-wasm serve-sync` HTTP/SSE + `/arrow` server & `<firebird-repl>` Arrow import/export actions
- [x] WebCrypto JWT tenant claims & role-based sync auth (`signSyncJwt`, `verifySyncJwt`, `createJwtTenantAuthResolver`, `serve-sync --jwt-secret`), crash-safe durable optimistic outbox (`FB_OPTIMISTIC_OUTBOX$`) with offline field-level `rebase()`, zero-copy Apache Arrow IPC filtered replica bootstrap (`bootstrapStrategy: 'arrow-ipc'`, `GET /snapshot?format=arrow`), declarative virtual tables & remote `/arrow` SQL federation (`db.registerVirtualTable()`), and inline editable `<firebird-repl>` result grids + `Outbox` inspector
- [x] JWKS asymmetric key rotation (`createJwksKeyProvider`, `serve-sync --jwks-url`) + row-level `rls` JWT claims, persistent & auto-refreshing materialized views (`db.createMaterializedView()`, `"FB_MATVIEWS$"`), streaming CSV/NDJSON <-> Apache Arrow IPC V5 converters & CLI `export-arrow` / `import-arrow`, and local-first Undo/Redo (`createUndoRedoManager`, `useUndoRedo` / `createUndoRedo`)
- [x] Real-time multi-subscriber SSE fanout hub & zero-polling `liveSse: true` sync (`createSseReplicationHub`, `createSseReplicationClient`, `Last-Event-ID` catch-up), WebCrypto AES-256-GCM column-level E2EE & key rotation (`createColumnEncryptionTransformer`, `enc:v1:<kid>:...`), auto-synced `int8`/binary-quantized HNSW + BM25 `hybridSearch()` (`autoSync: true`, `asReplicationIndexHook()`), declarative `syncDatabaseSchema()` + CLI `schema-diff` / `schema-push`, and `<firebird-repl>` Search Index & Schema-Diff inspector
- [x] Collaborative presence rooms & framework hooks (`createPresenceRoom`, `createPresenceHub`, `usePresence`/`createPresence`), tamper-evident SHA-256 Merkle audit chains (`createAuditLog`, `verifyAuditChain`, `FB_AUDIT_LOG$`, CLI `verify-audit`), persistent semantic query cache + MMR reranking & token-budgeted RAG context packer (`createSemanticCache`, `mmrRerank`, `packRagContext`), and deterministic PII anonymizer & FK-aware database seeder (`anonymizeDatabase`, `seedDatabase`, CLI `anonymize` / `seed`)
- [x] Guarded Model Context Protocol (MCP) JSON-RPC 2.0 server (`createFirebirdMcpServer`, `npx firebird-wasm mcp`), Markdown/code-aware document chunker & incremental SHA-256 diffing RAG ingester (`chunkDocument`, `createRagIngester`), OpenTelemetry tracing + W3C `traceparent` propagation & Prometheus `GET /metrics` (`createOtelInstrumentation`, `formatPrometheusMetrics`), and authenticated AES-256-GCM encrypted `.fbkp` backup archives with incremental page-diff chains & Merkle verification (`createEncryptedBackup`, `verifyBackupArchive`, `restoreEncryptedBackup`, CLI `backup` / `verify-backup`)
- [x] Durable transactional job queue, 5-field cron scheduler & crash-safe checkpointed workflows (`createJobQueue`, `FB_JOB_QUEUE$`, CLI `worker`), cycle-safe `WITH RECURSIVE` property graphs & multi-hop Knowledge-GraphRAG (`createKnowledgeGraph`, `compileGraphPatternSql`, `graphRagSearch`, MCP `graph_search`), zero-downtime Expand/Backfill/Contract online schema migrations with PSQL dual-write triggers (`createOnlineMigrator`, CLI `migrate-online`), and adaptive workload & index advisor (`createWorkloadAdvisor`, MCP `advise_workload`, CLI `advise`, `<firebird-repl>` `adviseWorkload()`)
- [x] Time-series hypertable policies, `locf`/linear gap-filling & LTTB peak-preserving downsampling (`createTimeSeriesStore`, `lttbDownsample`, `TS_BUCKET`), persistent 2D spatial R-Tree & GeoJSON/WKT geodesic engine (`createSpatialIndex`, `RTreeIndex`, `ST_DISTANCE_M`/`ST_DWITHIN`/`ST_CONTAINS`/`ST_INTERSECTS`/`ST_AREA_M2`/`ST_ASGEOJSON`), CNCF CloudEvents v1.0 & `HMAC-SHA256`-signed CDC webhook sink (`createChangeStreamSink`, `createHttpWebhookSink`, CLI `cdc-sink`), and WinterCG Edge HTTP SQL / transactional `/batch` gateway + chunked `KeyValuePageVFS` (`createEdgeSqlGateway`, `<firebird-repl>` `spatialIndexes()` & `timeSeriesPolicies()`)
- [x] SQL:2011 system-versioned bitemporal history tables (`createTemporalTable`, `rewriteTemporalSql` `FOR SYSTEM_TIME AS OF` / `BETWEEN`, `diffRowHistory`, `revertRowAsOf`), append-only Event Sourcing store & checkpointed CQRS projections (`createEventStore`, `ConcurrencyConflictError`, `loadAggregate`, CLI `projections`), zero-code introspected GraphQL (DataLoader FK batching) + REST CRUD + OpenAPI 3.1 gateway (`createAutoApiGateway`, CLI `serve-api`), and multi-database `ATTACH` cross-DB SQL federation + sharded scatter-gather pool (`createDatabaseFederation`, `createShardedPool`, `<firebird-repl>` `temporalTables()` & `eventProjections()`)

See [docs/roadmap.md](./docs/roadmap.md) for the full status audit, a
feature-by-feature comparison with PGlite, and the staged plan.

## CI

Both CI workflows use the official
[firebirdsql/firebird](https://hub.docker.com/r/firebirdsql/firebird) Docker image.

| Workflow | Job | Trigger |
|----------|-----|---------|
| [CI](.github/workflows/ci.yml) | Build, unit tests, decode benchmark | push / PR |
| [CI](.github/workflows/ci.yml) | The Node driver's tests against Firebird 3, 4 and 5 servers | push / PR |
| [E2E](.github/workflows/e2e.yml) | Playwright browser tests (no Firebird needed) | push / PR |
| [E2E](.github/workflows/e2e.yml) | Playwright e2e tests (against Firebird) | push / PR |
| [Build WASM](.github/workflows/build-wasm.yml) | Compiles the engine from source, then runs every suite that needs the artifact — including the real-engine browser tests | push / PR |
| [Deploy demo](.github/workflows/deploy-demo.yml) | Publishes the playground to GitHub Pages | push to `main` |

## License

Apache-2.0
