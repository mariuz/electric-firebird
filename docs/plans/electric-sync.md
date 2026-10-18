# Plan: syncing from Electric

ElectricSQL is the project's namesake and the one row of the PGlite
comparison still marked ❌ ([roadmap.md](../roadmap.md) §M5). This plan says
what Electric is today, what syncing it into Firebird would mean, what it
would not, and the smallest piece that proves the rest.

**Status:** the four questions at the end were decided as proposed, and the
first step's read path is built (`firebird-wasm/electric`; see
[integration.md](../integration.md) §3). Building it found that the
engine could not bind a string into a BLOB parameter, now fixed, and that
`bytea` waits for binary parameters.

---

## What Electric is now

Electric (the sync service, 1.x) is a read path out of **Postgres**. A client
asks it for a *shape*, a table with an optional `WHERE` and column list, and
gets the shape's rows as a log of operations over HTTP, then keeps following
that log as Postgres changes. It does not take writes: an app writes through
its own API to Postgres, and the change comes back down the shape like any
other.

The protocol, from the HTTP API documentation and its OpenAPI spec:

- **`GET /v1/shape?table=items&offset=-1`** starts a shape. The body is a
  JSON array of messages; the response carries `electric-handle` (which shape
  log this is), `electric-offset` (where to continue), and, on non-live
  responses, `electric-schema`, a JSON map of column to Postgres type
  (`{"id":{"type":"int4","dimensions":0},"title":{"type":"text",…}}`, with
  `max_length`, `precision`, `scale` where they apply).
- **Messages** are either operations,
  `{"headers":{"operation":"insert"},"key":"…","value":{"id":"1","title":"Hello"}}`
  with `insert`, `update` or `delete`, or control messages:
  `up-to-date` (everything the server knew is in), `must-refetch` (throw the
  shape away and start again), `snapshot-end` (subset snapshots only).
- **Values are strings** in Postgres's text output format: `"1"`, `"t"`,
  `"2024-05-01 12:00:00+00"`, `"\\x0a0b"`. The `electric-schema` header says
  how to read each one.
- **Updates carry only what changed** by default (the primary key and the
  changed columns); `replica=full` sends whole rows and the old values.
  Deletes carry the key.
- **Paging and live mode**: requests repeat with the last `handle` and
  `offset` until `up-to-date`, then continue with `live=true` (a long poll the
  server holds up to about 20 s, or Server-Sent Events with `live_sse=true`).
  `electric-cursor`, when present, goes back as `cursor`.
- **A `409`** means the offset no longer exists; its body is `must-refetch`
  and its `electric-handle` is the shape to use from then on.
- **Apply operations only at `up-to-date`**, as one batch: that is what keeps
  a client's store consistent with some Postgres state rather than half of
  two.

`@electric-sql/client` implements all of that (`ShapeStream`: paging, live
mode, SSE with a fallback, `409`, backoff) and parses values by the schema
header into numbers, booleans, JSON and so on; what it does not parse stays a
string.

## What "Electric for Firebird" can and cannot mean

**Can:** a Postgres server, an Electric service in front of it, and Firebird
in the browser (`FirebirdBrowser`, or `FirebirdLite` in Node) holding a
synced, queryable copy of chosen shapes. That is exactly what PGlite does with
`@electric-sql/pglite-sync`, with Firebird SQL on the client instead of
Postgres SQL.

**Cannot:** a *Firebird server* as the source. Electric reads Postgres's
logical replication stream; nothing about it reads Firebird. Syncing out of a
Firebird server would be a different system (change capture by triggers or
Firebird's replication log, plus a service to serve it) and is not this plan.

So the client side is the whole of the work here, and the server side is
Electric's, unchanged.

## The shape of the API

Modelled on PGlite's `syncShapeToTable`, which Electric users already know,
in a new subpath, `firebird-wasm/electric`:

```ts
import { syncShapeToTable } from 'firebird-wasm/electric';

const sync = await syncShapeToTable(db, {
  shape: { url: 'https://api.example.com/v1/shape', params: { table: 'items' } },
  table: 'ITEMS',            // a Firebird table the app created
  primaryKey: ['ID'],
  shapeKey: 'items',         // where the sync position is kept, to resume
});

sync.isUpToDate;             // true once the first up-to-date batch is in
await sync.unsubscribe();
```

`db` is anything with `query` and `transaction`, so `FirebirdBrowser` and
`FirebirdLite` both work. `@electric-sql/client` would be an optional peer
dependency, as React and Vue are for their bindings: re-implementing paging,
`409` handling, SSE fallback and backoff would be a second copy of code
Electric maintains.

### Applying the log

One Firebird transaction per `up-to-date` batch, holding:

| Message | Firebird |
|---|---|
| `insert` | `UPDATE OR INSERT INTO t (cols) VALUES (?…) MATCHING (pk)`: an insert seen twice (a resync, a replay) is harmless |
| `update` | `UPDATE t SET <changed columns> WHERE pk = ?` |
| `delete` | `DELETE FROM t WHERE pk = ?` |
| `must-refetch` | `DELETE FROM t` (or only this shape's rows, below), forget the position, start from `offset=-1` |

and, in the same transaction, the new `handle` and `offset` written to a
metadata table (`ELECTRIC_SHAPES`: shape key, handle, offset). The rows and
the position commit together or not at all, so a reload resumes exactly where
the database is: neither replaying a batch it holds nor skipping one it lost.
In the browser the database (that table included) persists through the
IndexedDB VFS already; nothing new is needed for resume.

A batch of inserts goes through `execBatch`, one prepared statement for the
lot, which is what made the initial load of 100 000 rows cost the inserts and
not 100 000 prepares.

### Values

Postgres text in, Firebird parameters out. Electric's parser covers numbers,
booleans and JSON; the rest is a mapping this package owns:

| Postgres (`electric-schema` type) | Firebird column | Value |
|---|---|---|
| `int2`, `int4`, `int8` | `SMALLINT`, `INTEGER`, `BIGINT` | number / bigint |
| `numeric(p,s)` | `NUMERIC(p,s)` (to 38 digits: `INT128` underneath) | the string, exact |
| `float4`, `float8` | `FLOAT`, `DOUBLE PRECISION` | number |
| `bool` | `BOOLEAN` | boolean |
| `text`, `varchar(n)`, `bpchar(n)` | `VARCHAR(n)`, or `BLOB SUB_TYPE TEXT` for unbounded text | string |
| `uuid` | `VARCHAR(36)` (`BINARY(16)` an option) | string |
| `date`, `time`, `timestamp` | `DATE`, `TIME`, `TIMESTAMP` | parsed, no zone |
| `timestamptz`, `timetz` | `TIMESTAMP WITH TIME ZONE`, `TIME WITH TIME ZONE` | parsed with its offset |
| `json`, `jsonb` | `BLOB SUB_TYPE TEXT` | the JSON text |
| `bytea` | `BLOB SUB_TYPE BINARY` | `\x…` hex decoded to bytes |
| arrays (`dimensions` > 0) | `BLOB SUB_TYPE TEXT` holding JSON | Firebird's own arrays are not reachable from DSQL in a useful way |
| `interval`, ranges, geometric, `money` | not mapped in a first version: refused by name, never guessed |

Identifiers: Postgres folds unquoted names to lower case, Firebird to upper.
A Postgres column `title` maps to the Firebird column `TITLE`, which is what
`SELECT title` finds; a column that was quoted in Postgres (`"createdAt"`)
stays quoted. A `columns` option overrides the mapping per column.

### The table

The app creates the table, as with PGlite. Generating `CREATE TABLE` from
`electric-schema` is tempting and is offered only as a helper
(`tableFromSchema(schema)` returning the DDL to review), because the choices
in the table above (`VARCHAR(n)` or a text blob, `CHAR(36)` or `BINARY(16)`)
are the app's, and a schema that changes in Postgres does not migrate a
Firebird table by itself.

### Changes the app can watch

Rows arrive through ordinary statements, so `AFTER INSERT/UPDATE/DELETE`
triggers fire and `POST_EVENT` works: a trigger posting `'items'` makes
`useLiveQuery(…, { events: ['items'] })` (#38) and `db.live()` follow the sync
with nothing added. The sync also posts `electric_<shapeKey>` once per applied
batch, for an app without triggers.

### Several tabs

Two tabs syncing the same shape into one database would apply every batch
twice and race on the position. With `multiTab: 'shared'` only the leader
(`electLeader`, already used for the shared engine) runs the sync; a follower
reads the leader's database and sees the changes like any other write.

## Writes

Electric has no write path, and this plan adds none in its first version: the
app writes through its own API to Postgres, and the change comes back down the
shape. Two patterns are known to work on top, both left to the app at first:

1. **Online writes**: call the API, show the change when the shape brings it
   back. Nothing local to reconcile.
2. **Optimistic writes**: a local table of pending changes, a view that lays
   them over the synced table, and a step that drops a pending change once the
   shape shows it applied (or rolls it back when the API refuses it). PGlite's
   examples do this with a view and triggers; Firebird has updatable views and
   triggers to do the same.

A built-in write path (a queue of local changes sent to an endpoint, with
conflict rules) is the second step, once the read path is in use.

## The first step

A prototype that proves the read path end to end:

1. `syncShapeToTable` for one shape into one table: initial sync, live mode,
   resume after a reload, `must-refetch`, the transactional position.
2. The type mapping for the common types (integers, numeric, text, boolean,
   dates and timestamps with and without zone, uuid, json); everything else
   refused by name.
3. Tests at two levels:
   - **A scripted Electric in the e2e server**: a Node route that speaks the
     protocol from fixtures (pages, `up-to-date`, a live response, a `409`),
     so every ordering can be forced in Chromium against the real engine;
   - **The real thing in CI**: a job with `postgres` and `electricsql/electric`
     service containers, writing in Postgres and asserting the rows in
     Firebird, so the fixtures cannot drift from Electric.
4. A demo page: a Postgres table synced into the browser, queried with
   Firebird SQL in `<firebird-repl>` (#39).

Out of the first step: several shapes in one transaction
(`syncShapesToTables` in PGlite's terms), writes, `replica=full`, subset
snapshots, and the Node side beyond what the tests need.

## Questions to decide first

1. **Read-only first.** Proposed: yes, as above. A write path is a design of
   its own and benefits from a read path people use.
2. **Depend on `@electric-sql/client`.** Proposed: yes, as an optional peer
   dependency; the alternative is maintaining a second client.
3. **Who creates the table.** Proposed: the app, with
   `tableFromSchema()` as a helper that returns DDL rather than running it.
4. **Where it lives.** Proposed: `firebird-wasm/electric` in this package,
   as `/react`, `/vue` and `/repl` do, rather than a package of its own,
   until it needs a release schedule of its own.
