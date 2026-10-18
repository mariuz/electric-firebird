# Two servers, one Firebird in the browser

A page with two lists of notes. Each list is a table in a Firebird database
running in the page, kept in step with a server by `firebird-wasm/electric`:

- **`PG_NOTES`** follows a Postgres table through
  [Electric](https://electric-sql.com).
- **`FB_NOTES`** follows a table on a Firebird server through
  `firebird-wasm/electric-server`, which speaks Electric's protocol. No
  Postgres is involved.

Adding, ticking or deleting a note asks the server. The change comes back down
the shape into the local table, and `db.live()` redraws the list. The page
never writes to its own copy: the sync is read-only, so writes go through the
app's API, as with Electric itself. Reload, and the sync resumes from the
position stored with the rows (they are kept in IndexedDB). Below the lists,
`<firebird-repl>` queries the local copy.

```
Postgres ──> Electric ──────────────┐
                                    ├──> server.mjs ──HTTP──> syncShapeToTable ──> Firebird in the page
Firebird server ──> electric-server ┘        ^
                                             └── POST /api/… (the page's writes, to the source)
```

## Run it

You need Docker and Node 20 or later. The Firebird client library comes with
`node-firebird-driver-native`'s requirements: `libfbclient` installed on the
machine (on Debian or Ubuntu, `apt install libfbclient2`).

```sh
npm run build -w packages/firebird-wasm      # the package, from the repository root
cd examples/electric
docker compose up -d                         # Postgres, Electric, a Firebird server
npm install
npm run build
npm start                                    # http://localhost:4190/
```

`npm start -- --isolated` serves the page cross-origin isolated, so it loads
the threaded engine instead of the build without threads.

Write at a source from anywhere else and the page follows:

```sh
docker compose exec postgres psql -U postgres -c "INSERT INTO notes (title) VALUES ('from psql')"
```

## The files

- `server.mjs`: serves the page, proxies Electric's `/v1/shape` to
  `/electric/v1/shape`, serves the Firebird server's shapes at
  `/firebird/v1/shape` with `createShapeServer`, and takes the page's writes
  at `/api/{pg|fb}/notes`. It creates both `notes` tables if they are
  missing. Its settings are environment variables, listed at its top; the
  defaults match `docker-compose.yml`.
- `src/main.js`: the page. For each source it makes the local table with
  `tableFromSchema` (from the types the shape reports), starts
  `syncShapeToTable`, and draws the list with `db.live()` on the event each
  applied batch posts.
- `src/engine-worker.js`, `src/engine-prelude.js`, `copy-engine.mjs`: the
  engine in a Worker, as in [`../vite`](../vite).

CI runs it against real containers in Chromium, with both engine builds:
[`e2e/tests/examples-electric.spec.ts`](../../e2e/tests/examples-electric.spec.ts).
