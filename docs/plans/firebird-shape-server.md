# Plan: a Firebird server as the source of a shape

**Status:** built as described (`firebird-wasm/electric-server`), and the
prototype's open items since: `where`, pages, pruning, events, and several
servers on one database (see the end).

[electric-sync.md](./electric-sync.md) syncs a Postgres table into Firebird in
the browser through Electric. Electric reads Postgres's logical replication
stream and nothing else, so a table on a **Firebird server** cannot be its
source. This plan puts a small server in Electric's place: it reads a
Firebird database and answers Electric's HTTP shape protocol, so the browser
side is `firebird-wasm/electric` unchanged, and no Postgres is involved.

```
Firebird server ──(triggers: a change log)──> shape server (Node) ──HTTP──> syncShapeToTable ──> Firebird in the browser
```

## What Electric's protocol needs from a source

- **A snapshot**: every row of the table, consistent, and the position in the
  change stream it corresponds to.
- **An ordered stream of changes after a position**, each a whole
  transaction, never one with a gap before it that fills in later: a client
  that has moved past a position never looks behind it again.
- **The column types**, in Postgres's names (`electric-schema`), and every
  value as Postgres-style text.

## Change capture

Firebird has no logical replication stream that a client can follow (its
replication journal is a server-side file in its own format), so changes are
captured by triggers, installed by `createShapeServer` (idempotently):

- **`ELECTRIC_CHANGES`**: one row per changed row: the table, the operation
  (`I`, `U`, `D`), the key's columns as text (up to four), the writing
  transaction's id, a change id from a sequence, and a commit number, empty
  until the server gives it one.
- **A trigger per synced table** (`AFTER INSERT OR UPDATE OR DELETE`) writes
  that row. An update that changes the key writes a delete of the old key and
  an insert of the new one.

Only the key is logged. The values are read from the table when a change is
served, so the triggers stay small and no row has to be turned into text
inside PSQL (Firebird 3 to 5 have no JSON functions). The cost: a change is
served with the row as it is at serving time, so a client can see a later
state of a row before the change that produced it reaches it. Every change
re-applies idempotently (an insert is an upsert, a missing row a delete), so
the copy converges on the same state; what it gives up is that each batch is
an exact past state of the server.

## Numbering in commit order

The stream must follow commits, and a client that has moved past a number
never looks behind it. Change ids follow writes, not commits: a transaction
that writes first can commit last. So before every read the server numbers
the log itself: one READ COMMITTED transaction gives every change that has
committed and has no number yet the next number from a sequence. A change
whose transaction is still open is invisible to that update and gets a later
number, after its commit. The server numbers one batch at a time, so no
number appears after a higher one was served, and a client's offset is
simply the highest number in its snapshot.

The first design numbered in a database trigger `ON TRANSACTION COMMIT`.
Testing it found why not: Firebird loads database triggers when a connection
attaches, so an application connected before the capture was installed
would never number its commits, and its changes would never be served. It
also cost every commit in the database a lookup. Numbering in the server has
neither problem; it means one shape server per database.

A snapshot is read in one snapshot transaction, and its offset is the
highest number in it. It may already contain changes not numbered yet; they
are numbered above that offset and served again later, as no-ops.

## The server

`createShapeServer({ database, username, password, tables })` returns a Node
HTTP handler for `GET /v1/shape`:

| Request | Answer |
|---|---|
| `offset=-1` | every row as an insert, `electric-schema`, `electric-handle`, `electric-offset` = the highest number in the snapshot, `up-to-date` |
| `handle`, `offset` | the changes numbered after `offset`, collapsed per key (the last operation wins), then `up-to-date` |
| `live=true` | the same, waiting up to 20 s for something to send: woken by the `ELECTRIC_CHANGES` event a commit posts, polling as the fallback |
| a handle it did not issue | `409` with `must-refetch` and the current handle |
| `where`, `params[n]` | a shape of the rows that match; see below |
| an offset older than the pruned log | `409` with `must-refetch` |

The handle is the capture's epoch (made when it is installed) and the table:
reinstalling the capture, which forgets the log, sends every client back to a
snapshot. Only the tables the server was given are served.

Types and their text, in Postgres's names so the client maps them as it maps
Postgres: `SMALLINT` int2, `INTEGER` int4, `BIGINT` int8, `NUMERIC`/`DECIMAL`
and `INT128` numeric (rendered by Firebird, exact), `FLOAT` float4, `DOUBLE
PRECISION` float8 (the shortest text that reads back as the same double),
`BOOLEAN` bool, `CHAR` bpchar, `VARCHAR` varchar, text `BLOB` text, `DATE`,
`TIME` and `TIMESTAMP` (Firebird's text), the `WITH TIME ZONE` types in UTC,
a binary `BLOB`, `BINARY` and `VARBINARY` bytea (Postgres's `\x` hex).
`DECFLOAT` is reported as a type the client refuses by name.

## Since the prototype

- **`where`.** Read by a small parser (`where.ts`) that takes comparisons,
  `AND` / `OR` / `NOT`, `IS [NOT] NULL`, `IN`, `LIKE` / `ILIKE`, `BETWEEN`,
  literals and Electric's `$n` parameters over the table's columns, and
  writes Firebird SQL with every value bound; anything else is a 400 naming
  it. The text comes from a client and the server runs what it writes, so
  nothing passes through unread. A changed row is read with the `where`: if
  it no longer matches, it is sent as a delete. The handle covers the table,
  the columns, the `where` and its values, so one table has as many shapes
  as clients ask for; the whole table keeps its old handle.
- **Pages.** A snapshot is read in key order, `snapshotPageRows` at a time
  (keyset, not `ROWS`: a delete between pages must not shift a row past the
  boundary). A page that is not the last answers with offset
  `<top>_<cursor>` and no up-to-date; the client asks for the next. Pages
  after the first are read in later transactions, which is safe for the
  same reason the log is: anything that changed after the first page's
  position is in the log above it and served again.
- **Pruning.** Each number is recorded with its time (`ELECTRIC_STAMPS`).
  `prune(before)` drops the changes numbered before it and records the
  highest dropped (`ELECTRIC_META.PRUNED_THROUGH`); a client whose offset is
  below that is answered `409 must-refetch`. By default the server prunes
  hourly what is older than 7 days (`retainLogMs`).
- **Events.** Each logging trigger posts `ELECTRIC_CHANGES`, which Firebird
  delivers once per committing transaction; the server listens on a second
  connection and wakes every waiting live request. Polling stays as the
  fallback, at 1 s by default.
- **Several servers.** Numbering takes the `ELECTRIC_META` row first (and
  retries if another server holds it), and only then a number, so numbers
  commit in order: a snapshot that sees a number sees every one below it.
  Without it, two servers numbering at once failed on each other's rows, or
  could commit a higher number before a lower one, and a client that had
  seen the higher would never be sent the lower.

Still out: writes from the browser back to the server (see the write path in
[electric-sync.md](./electric-sync.md)).

## Tests

Against a real Firebird server: `electric-server.test.ts` runs on Firebird
3, 4 and 5 in CI (`server-versions`), following the server with Electric's
own `ShapeStream` and `Shape`: the snapshot's exact text per type, live
changes, a transaction that wrote first and committed last, a composite and
a changed key, a resume, a foreign handle, and a connection opened before
the capture was installed. In Chromium (`browser-firebird-shapes.spec.ts`):
a Firebird server, the shape server, and `syncShapeToTable` into the real
engine.
