# Plan: a Firebird server as the source of a shape

**Status:** built as described (`firebird-wasm/electric-server`).

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
| `live=true` | the same, waiting (polling the log) up to 20 s for something to send |
| a handle it did not issue | `409` with `must-refetch` and the current handle |
| `where` | `400`: not in the prototype |

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

## Out of the prototype

- Paging a large snapshot (it is one response).
- Pruning the log (it grows until truncated by hand).
- `where` and several shapes of one table.
- Waking on Firebird events instead of polling the log.
- More than one shape server per database (each numbers the log).
- Writes from the browser back to the server.

## Tests

Against a real Firebird server: `electric-server.test.ts` runs on Firebird
3, 4 and 5 in CI (`server-versions`), following the server with Electric's
own `ShapeStream` and `Shape`: the snapshot's exact text per type, live
changes, a transaction that wrote first and committed last, a composite and
a changed key, a resume, a foreign handle, and a connection opened before
the capture was installed. In Chromium (`browser-firebird-shapes.spec.ts`):
a Firebird server, the shape server, and `syncShapeToTable` into the real
engine.
