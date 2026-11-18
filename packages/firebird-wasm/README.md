# firebird-wasm

**Firebird Embedded for the Browser (WebAssembly) & Node.js** — a [PGlite](https://pglite.dev)-inspired async TypeScript API around the [Firebird](https://firebirdsql.org) embedded SQL engine.

**[Live SQL Console Demo →](https://mariuz.github.io/electric-firebird/)** · **[Replication Simulator & Demo →](https://mariuz.github.io/electric-firebird/replication.html)** · **[Documentation →](https://github.com/mariuz/electric-firebird/tree/main/docs)**

> **Status:** Alpha (`0.x`) — all features below are implemented and tested in CI, though minor API details may evolve before `1.0`.

## Installation

```bash
npm install firebird-wasm
```

The package ships the compiled WebAssembly engine (`firebird-embedded-st.wasm` and `firebird-embedded.wasm`), so the browser backend needs nothing else — no Emscripten, no Firebird installation, and no server.

The **Node.js native backend** (`FirebirdLite`) connects to a Firebird server or native embedded engine through `node-firebird-driver-native`, which loads `libfbclient.so` / `libfbclient.dylib` / `fbclient.dll` on the host. Because it is declared in `optionalDependencies`, browser-only projects can skip it:

```bash
npm install firebird-wasm --omit=optional
```

See [Firebird server packages](https://firebirdsql.org/en/server-packages/) if you also want the native Node.js client.

## Backends & subpath exports

| Import | Engine / Module | Needs |
|--------|-----------------|-------|
| `firebird-wasm` | Native driver → Firebird server or embedded (`FirebirdLite`) + shared helpers | Firebird client library |
| `firebird-wasm/browser` | Firebird 5.0 LTS / 6.0 compiled to WebAssembly (`FirebirdBrowser`, `IndexedDBVFS`, `OPFSVFS`) | Browser or Node.js |
| `firebird-wasm/browser/worker-entry` | Dedicated Web Worker entry point for the WASM engine | Browser Worker |
| `firebird-wasm/react` | React `<FirebirdProvider>`, `useFirebird`, `useQuery`, `useLiveQuery`, `useSyncStatus`, `useColumnarQuery`, `useLiveIncrementalQuery` | React 18+ |
| `firebird-wasm/vue` | Vue 3 `provideFirebird`, `useFirebird`, `useQuery`, `useLiveQuery`, `useSyncStatus`, `useColumnarQuery`, `useLiveIncrementalQuery` | Vue 3.3+ |
| `firebird-wasm/svelte` | Svelte 5 `setFirebirdContext`, `getFirebirdContext`, `useFirebird`, `createQuery`, `createLiveQuery`, `createSyncStatus`, `createColumnarQuery`, `createLiveIncrementalQuery` | Svelte 4/5+ |
| `firebird-wasm/solid` | SolidJS `setFirebirdContext`, `useFirebird`, `createQuery`, `createLiveQuery`, `createSyncStatus`, `createColumnarQuery`, `createLiveIncrementalQuery` | SolidJS 1.7+ |
| `firebird-wasm/tanstack` | TanStack Query (`createFirebirdQueryOptions`, `connectFirebirdQueryClient`) & TanStack DB (`createFirebirdCollection`) | `@tanstack/query-core` / `@tanstack/db` (optional) |
| `firebird-wasm/rxdb` | RxDB storage adapter (`getRxStorageFirebird`) backed by Firebird SQL | RxDB 15+ (optional) |
| `firebird-wasm/repl` | `<firebird-repl>` interactive SQL console + Schema, Migrations, Profiler, Plan, Replication & Arrow/Sync inspector | Browser custom elements |
| `firebird-wasm/electric` | ElectricSQL client sync (`syncShapeToTable`, `syncShapesToTables`, `syncShapes`, `createWriteQueue`) | `FirebirdBrowser` / `FirebirdLite` |
| `firebird-wasm/electric-server` | Firebird-backed Electric shape feed & write ingestion (`createShapeServer`, `applyWrite`) | `FirebirdLite` / `FirebirdBrowser` |
| `firebird-wasm/kysely` | Kysely dialect (`FirebirdDialect`, `createKysely`) & TypeScript schema codegen (`generateKyselyTypes`) | Kysely 0.27+ (optional) |
| `firebird-wasm/drizzle` | Drizzle-style query builder (`drizzle`, `firebirdTable`) & schema codegen (`generateDrizzleSchema`) | Drizzle ORM 0.30+ (optional) |
| `firebird-wasm/vector` | Float32/Int8 vector codec, persistent HNSW ANN index (`HnswIndex`, `createVectorIndex`), SQL UDRs, and `vectorSearch` | `FirebirdBrowser` / `FirebirdLite` |
| `firebird-wasm/fts` | Okapi BM25 full-text search (`Bm25Index`, `createFtsIndex`), stemming/highlighting UDRs, and RRF `hybridSearch` | `FirebirdBrowser` / `FirebirdLite` |
| `firebird-wasm/columnar` | Standalone zero-copy columnar vector decoder (`decodeBinaryResultColumnar`) & Apache Arrow IPC V5 codec (`encodeArrowIpc`, `decodeArrowIpc`) | Browser or Node.js |
| `firebird-wasm/schema` | Standalone Standard Schema v1 row validator (`createRowSchema`, `validateRows`) & schema-aware SQL builder (`createTypedSql<DB>()`) | Browser or Node.js |
| `firebird-wasm/replication` | Logical, journal, `createReplicaRouter` (causal `read-your-writes`), binary `.fdb` / page-diff bootstrap, S3/R2/HTTP WAL PITR (`createObjectStoreReplicationTarget`), WebRTC/WS/HTTP, CRDTs, mesh/hub, DLQ & `"FBCHANGELOG\0"` | `FirebirdBrowser` / `FirebirdLite` |
| `firebird-wasm/cli` | `npx firebird-wasm` developer CLI (`query`, `repl`, `codegen --kysely\|--drizzle`, `migrate`, `dump`, `restore`, `inspect-changelog`, `sync`, `wal-ship`, `pitr-restore`, `bench`) | Node.js 18+ |

## Quick start — Browser (WASM)

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title VARCHAR(200))');
await db.exec('INSERT INTO notes VALUES (?, ?)', [1, 'Hello']);

const { rows } = await db.query('SELECT * FROM notes');
// [{ ID: 1, TITLE: 'Hello' }]

await db.persist();
await db.close();
```

Use `'mydb'` for incremental IndexedDB persistence, `'opfs://mydb'` for direct Origin Private File System block I/O inside a Worker, or `'memory://'` for an ephemeral in-memory database.

The default build (`firebird-embedded-st.js`) runs single-threaded without `SharedArrayBuffer` or COOP/COEP headers. The threaded build (`wasmGlueFile(true)`, `threads: true`) adds statement and idle timeouts and requires a [cross-origin isolated](https://github.com/mariuz/electric-firebird/blob/main/docs/integration.md#2-the-two-hard-requirements-and-the-build-without-them) page and a Worker. See the [Integration Guide](https://github.com/mariuz/electric-firebird/blob/main/docs/integration.md) and [Engine Builds](https://github.com/mariuz/electric-firebird/blob/main/docs/builds.md).

## Quick start — Node.js (`FirebirdLite`)

```ts
import { FirebirdLite } from 'firebird-wasm';

// Connect to a Firebird server (or pass '/tmp/my-app.fdb' for native embedded mode)
const db = new FirebirdLite('localhost:/tmp/my-app.fdb', {
  username: 'SYSDBA',
  password: 'masterkey',
});

await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(100))');
await db.query('INSERT INTO items VALUES (?, ?)', [1, 'hello']);

const result = await db.query('SELECT id, name FROM items ORDER BY id');
console.log(result.rows);   // [{ ID: 1, NAME: 'hello' }]
console.log(result.fields); // [{ name: 'ID' }, { name: 'NAME' }]

await db.transaction(async (tx) => {
  await tx.exec('UPDATE items SET name = ? WHERE id = ?', ['world', 1]);
  // committed on return, rolled back if an error is thrown (or via tx.rollback())
});

await db.close();
```

### Core API (`FirebirdBrowser` & `FirebirdLite`)

- **Unified, pipelined, streaming, Arrow, materialized-view, virtual-table & table APIs**: `openDatabase(uri, opts?)`, `db.createMaterializedView(name, selectSql, { primaryKey?, indexes?, refreshStrategy? })`, `db.listMaterializedViews()`, `db.registerVirtualTable(name, provider, { primaryKey?, ttlMs? })`, `db.table<T>(name, { primaryKey?, schema?, cacheStatements? })` (`insert`, `insertMany`, `insertArrow`, `upsert`, `upsertMany`, `upsertArrow`, `findMany`, keyset `findPage`, `close()`), `db.loadArrowIpc(table, source, { createTable?, upsertMatching? })`, `ndjsonToArrowStream()` / `csvToArrowStream()` / `arrowToNdjsonStream()` / `arrowToCsvStream()`, `db.pipeline()`, `db.preparePipeline()`, `db.queryColumnar()`, `db.queryColumnarStream()`, `db.queryArrow()`, `db.queryArrowStream()` (`decodeArrowIpcBatches`), `db.queryStream<T>()`, `db.prepare(sql)`, `` sql`...` `` & `createTypedSql<DB>(db)`
- **Standard Schema v1 & errors**: `Zod` / `Valibot` / `ArkType` / `createRowSchema` validation (`{ schema }`, `SchemaValidationError`), structured `FirebirdError` (`gdscode`, `sqlcode`, `sqlState`, `hint`), `[Symbol.asyncDispose]()` (`await using db = ...`)
- **Replication, JWKS/RLS Auth, Arrow Bootstrap, Read/Write Router, S3/R2 WAL PITR & CLI `serve-sync`**: `createJwksKeyProvider({ jwksUrl, cacheTtlMs? })` + `signSyncJwt()` / `verifySyncJwt()` / `createJwtTenantAuthResolver()` (with fine-grained per-table `rls` row predicates & live token rotation via `client.setAuthToken()` / `wsPeer.refreshAuth()`), `createTenantReplicationSlice({ primary, replica, tenantColumn, tenantId, bootstrapStrategy: 'arrow-ipc' })` (`TenantIsolationError`), `createReplicaRouter({ primary, replicas, consistency: 'read-your-writes', failover })`, `syncDatabases()`, `db.syncWith()`, `startCliReplicationServer()` (`npx firebird-wasm serve-sync --jwt-secret / --jwks-url`, `export-arrow`, `import-arrow`), `createObjectStoreReplicationTarget({ checkpointEverySegments, autoPruneBeforeCheckpoint })` + `restoreDatabaseToPointInTime()` (AWS SigV4), `createWebRtcReplicationPeer()`, `createResilientWebSocketPeer()`
- **Durable optimistic local-first outbox, Undo/Redo & reactive live queries**: `createUndoRedoManager(db, { optimisticStore?, broadcastChannel? })` (`useUndoRedo` / `createUndoRedo`), `createOptimisticMutationStore(db, { persist: true, broadcastChannel?, syncHandle? })` (`hydrate()`, `rebase()`), `useTable<T>()` / `createTable<T>()`, `useOptimisticMutation()` / `createOptimisticMutation()`, `db.live()`, `db.liveIncremental(sql, params?, { key, table? })` (structural row-reference sharing + `applyChanges()`), `db.liveColumnar(sql, params?)`, `db.listen()`, `db.notify()`
- **Transactions**: `db.transaction(fn, options?)`, `tx.savepoint(fn)`, `tx.rollback()`
- **Schema & migrations**: `db.describeQuery(sql)`, `db.explain(sql, options?)`, `db.introspect()`, `db.migrate(migrations)`, `diffSchema()`, `generateMigration()`
- **Bulk & BLOB streaming**: `db.copyFromStream()`, `db.copyToStream()`, `db.createBlobStream()`, `db.openBlobStream()`, `db.dumpDataDir()`, `db.dumpDataStream()`, `db.loadDataStream()`
- **Snapshots & encryption**: `db.snapshot()`, `db.restoreSnapshot()`, `db.branch()`, `db.exportDiff()`, `db.applyDiff()`, AES-256-GCM `encryptionKey`
- **Extensibility & observability**: `db.registerFunction()`, `db.registerProcedure()`, `db.live()`, `db.listen()`, `db.notify()`, `db.databaseInfo()`, `db.sweep()`, `db.onQuery()`, `db.monitorStats()`

Full documentation:

- [Integration Guide](https://github.com/mariuz/electric-firebird/blob/main/docs/integration.md)
- [API Reference](https://github.com/mariuz/electric-firebird/blob/main/docs/api.md)
- [Browser / WASM Storage & Encryption](https://github.com/mariuz/electric-firebird/blob/main/docs/browser.md)
- [Database Replication Guide](https://github.com/mariuz/electric-firebird/blob/main/docs/replication.md)
- [Roadmap & PGlite Comparison](https://github.com/mariuz/electric-firebird/blob/main/docs/roadmap.md)

## Testing

```bash
FIREBIRD_PASSWORD=masterkey npm test
```

## License

Apache-2.0
