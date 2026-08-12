# Firebird runs in the browser

**electric-firebird 0.3.0**

The [Firebird](https://firebirdsql.org) relational engine, compiled to
WebAssembly, running entirely inside a web page. No server, no network, no
extension. It creates real databases, executes real SQL, and keeps your data
between visits.

**New in 0.3.0:** live queries that re-run when the data changes, storage that
writes straight to the origin private filesystem, a `` sql`…` `` template tag,
and two fixes worth reading before upgrading — see
[what changed](#what-changed-in-030).

### → **[Try it now](https://mariuz.github.io/electric-firebird/)**

The demo is a SQL console with worked examples. Everything in it runs on your
own machine; nothing you type is uploaded anywhere.

---

## What this is

[PGlite](https://pglite.dev) put PostgreSQL in the browser. This does the same
for Firebird — an engine with a thirty-year lineage, `EXECUTE BLOCK`, exact
`DECFLOAT` and `INT128` arithmetic, and a genuinely small embedded footprint.

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';

const db = new FirebirdBrowser('mydb', {
  worker: new Worker('/firebird-engine-worker.js'),
});

await db.exec('CREATE TABLE notes (id INTEGER, title VARCHAR(200))');
await db.exec('INSERT INTO notes VALUES (?, ?)', [1, 'Hello']);

const { rows } = await db.query('SELECT * FROM notes');
// [{ ID: 1, TITLE: 'Hello' }]

// Re-runs whenever a trigger posts 'notes_changed':
await db.live('SELECT * FROM notes', { events: ['notes_changed'] }, render);
```

The database persists to IndexedDB — or to OPFS, or nowhere at all — and is
there when the user comes back.

## What works

**The engine, for real.** Not a subset, not a reimplementation: it is Firebird
6.0 compiled from source. DDL, DML, joins, aggregates, recursive CTEs,
`EXECUTE BLOCK` PSQL, the system catalogue — all of it, because it is all the
same engine.

**Parameterised queries.** `?` placeholders, bound rather than concatenated.

**Transactions.** `db.transaction(async tx => ...)`, committed on return,
rolled back on throw, with explicit `tx.rollback()` when you want to abandon
one deliberately.

**Multi-statement scripts.** `exec()` splits on statement boundaries while
respecting string literals, quoted identifiers, comments and `SET TERM`, so a
stored procedure body full of semicolons survives intact. Usable for
migrations.

**Numbers that stay exact.** A `NUMERIC(18,8)` or a `BIGINT` past 2⁵³ cannot
survive a JavaScript `double`, so it crosses as an exact decimal string — and
every column reports its real type, so you can tell an exact number from text
that looks like one.

**Persistence you can trust.** Each save writes the whole image in a single
IndexedDB transaction, so a tab closed mid-write leaves the previous database
intact rather than a corrupt half-update. Only changed pages are rewritten.
Writes are saved automatically after a short debounce, plus a best-effort
flush when the page is hidden.

**Multi-tab safety, and multi-tab sharing.** Opening the same database in two
tabs used to silently destroy data — each tab holds a full copy and writes the
whole image, so the second save discarded the first tab's work while both
reported success. A cross-tab Web Lock refuses the second tab by default; with
`multiTab: 'shared'` one tab runs the engine and the others proxy to it, so
they see one live database instead of two copies.

**Live queries.** `db.live(sql, { events }, onChange)` re-runs a statement when
a named `POST_EVENT` fires, and `db.listen()` / `db.notify()` expose the events
on their own. Delivery is after the posting transaction commits, so a
subscriber only ever sees data that survived. The event names are yours to
give: nothing in Firebird connects a posted event to the tables a query reads,
so inferring them would be guesswork.

**Three places to keep a database.** IndexedDB by default; `opfs://name` to let
the engine write its pages straight into an Origin Private File System file,
with no image copy and no persist step; `memory://` for a scratch database that
leaves nothing behind. `dumpDataDir()` and `loadDataDir` move one between them.

**A template tag that cannot be escaped.** `` sql`SELECT … WHERE id = ${id}` ``
binds every interpolation as a parameter, so a value is never read as SQL.
`sql.identifier()`, `sql.join()` and a deliberately-named `sql.unsafe()` cover
what cannot be a parameter.

**Values shaped the way you want them.** Off by default, because changing what
`rows` contains without being asked is not trustworthy: `types: { bigint,
dates, binary }` for richer types, `parsers` and `serializers` for your own,
`rowMode: 'array'` for positional rows, and `describeQuery()` to learn a
statement's shape without running it.

## The interesting part

Getting a database engine to run in a browser is mostly not a compilation
problem. It compiled and linked long before it worked. What took the time was
seven runtime failures, every one of which presented as a crash in code that
was not at fault.

The best of them: `fb_create_database()` aborted with a function-signature
trap, which an address sanitizer traced to a null vtable dereference on
Firebird's plugin configuration. Seven plausible theories about plugin
initialisation were tried and eliminated. The actual cause was that
`autoconfig.h` — generated by a *host* configure — recorded `SIZEOF_VOID_P 8`
while the target is 32-bit. Firebird sizes its allocator header from that
constant, so `MemHeader` came out 8 bytes instead of 16, every pool allocation
was returned 8 bytes off a 16-byte alignment, and the block arithmetic wrote
past the ends of live objects. One of those writes happened to land on the
plugin configuration.

A 30-line probe that allocated sixteen blocks from the pool with no engine
involved settled it in a second: sixteen misaligned returns out of sixteen,
seven live blocks clobbered. After the fix, zero and zero.

Two other bugs were stubs whose reasoning had quietly expired — a
`sem_timedwait` that refused to wait "because the build is single-threaded",
written before threads were enabled and left in place afterwards. **A stub
written for one set of constraints becomes a bug when the constraints change**,
and the stale comment explaining it is what makes it invisible.

The whole account is in [docs/porting.md](./docs/porting.md).

## What changed in 0.3.0

The same lesson arrived twice more, and both are worth stating plainly because
both cost data.

**`query()` was discarding writes.** On the browser backend, `query('INSERT
…')` prepared the statement, serialised an empty result, committed, and never
executed anything. It reported success and wrote nothing. The Node backend has
always executed such statements, so identical code wrote the row there and lost
it in the browser. `exec()` was never affected, which is why it survived this
long. Found by a test written against the real engine rather than the stub.

**Events stopped after the first one.** This had blocked live queries for
months, recorded as needing an open-ended debugging expedition into Firebird's
threading. It took two twenty-line programs instead. The first exonerated the
obvious suspect: a process-shared condvar under Emscripten wakes five times out
of five. The second found it — Firebird maps its shared-memory file a second
time to cache a pointer into it, and **under Emscripten a second `mmap` of one
file is a private copy rather than an alias**. Write 42 through the first
mapping and the second still reads 0. The event watcher was clearing and
testing the real block and then waiting on a counter in the copy, which no
poster could ever advance.

Every symptom in the record fitted once that was said out loud, including the
two that had made it look like a threading bug: the first delivery worked
because the flag was already set and it delivered before ever waiting, and
shared memory "was genuinely shared" because the observation proving it went
through the correct mapping.

Fixing delivery then exposed a third bug that had been invisible while only one
event ever arrived — registration produces a phantom event, which the C API's
own comment had explicitly ruled out on the strength of a measurement taken
while delivery was broken.

**The habit that found all three:** reproduce the primitive alone, in the
smallest program that can fail, before rebuilding a nine-megabyte engine to ask
it a question.

## What is not done

Stated plainly, because a release announcement is the wrong place to be coy:

- **The `.wasm` is 9 MB.** Compresses to roughly a third, but it is a real
  first-load cost.
- **Your page must be cross-origin isolated** (COOP/COEP), because the engine
  uses threads. On hosts where you cannot set headers, a service worker can
  supply them — that is how the demo works on GitHub Pages — at the cost of
  one reload on a first visit.
- **The engine must run in a Web Worker.** It blocks on mutexes, and a browser
  main thread may not block.
- **Only the built-in character sets** are available. Loadable ones need
  `dlopen`. ICU collations — `UNICODE_CI`, accent-insensitive search — work on
  a branch and are not merged.
- **No ElectricSQL sync** yet. It is the "electric" in the name and it is still
  the largest thing outstanding.
- **No framework hooks or ORM integration.** `live()` is the primitive a React
  hook would be built on, not the hook itself.
- **CDN use is untested.** The package is on npm and therefore reachable
  through unpkg and jsDelivr, but nothing verifies that path and there is no
  default `locateFile` for it.

## Try it

```bash
npm install firebird-wasm
```

The engine ships in the package, so nothing needs building. Your page must be
cross-origin isolated and the engine must run in a Worker — the
[integration guide](./docs/integration.md) covers both, per bundler.

To build it from source instead, including the engine:

```bash
git clone --recurse-submodules https://github.com/mariuz/electric-firebird
cd electric-firebird && npm install

EMSDK_VERSION=$(cat packages/firebird-wasm/wasm/emsdk-version.txt)
(cd third_party/emsdk && ./emsdk install "$EMSDK_VERSION" \
  && ./emsdk activate "$EMSDK_VERSION")
source third_party/emsdk/emsdk_env.sh

npm run build:wasm -w packages/firebird-wasm
npm run demo        # http://localhost:4173
```

- **[Integration guide](./docs/integration.md)** — Vite, webpack, Next.js,
  hosting, and the mistakes worth skipping
- **[How it was ported](./docs/porting.md)** — the engineering account
- **[Roadmap](./docs/roadmap.md)** — status, and a feature-by-feature
  comparison with PGlite

## Verification

238 automated tests: 125 in a real browser under Playwright, 16 more against
the demo as GitHub Pages actually serves it, and 97 in Node — the last
including a suite that runs against a real Firebird server through the native
driver.

They are built to be hard to satisfy accidentally. The browser suite runs
against a C-ABI stub with a real bump-allocator heap that tracks engine-owned
pointers and detects double frees, so memory ownership is exercised even
without the engine. The multi-tab tests drive two live pages in one browser
context, contending on the real Web Locks API — and one of them deliberately
opts out of the lock and asserts that four committed statements vanish, so
what the default prevents is written down as an executable fact. The demo
suite runs against a server that sends *no* COOP/COEP headers, because that is
what GitHub Pages does; a helpful test server would pass while the published
site failed.

Assertions are on data, not shapes. While the C API was still stubbed,
`fb_init()` returned 0 and `fb_query()` returned a well-formed empty result
set — a shape-only check could not tell a working engine from a stub.

That principle is what caught this release's worst bug: `query('INSERT …')`
returned a perfectly well-formed empty result while writing nothing, and only a
test that went back and looked for the row could tell the difference. Several
tests now assert an *absence* for the same reason — that describing a statement
executes nothing, that a live query stays silent for an event nobody posts,
that an ephemeral database leaves no IndexedDB store behind. A subscription
that is simply broken passes a test that only checks for delivery.

A decode benchmark runs in CI as well, and fails the build if row construction
stops being meaningfully faster than what it replaced. It compares two
measurements taken in the same process rather than against a wall-clock
threshold, because a shared runner varies enough to make any fixed limit either
useless or flaky.

---

Firebird is licensed under the IPL/IDPL. This project is Apache-2.0.
Issues and pull requests welcome at
[github.com/mariuz/electric-firebird](https://github.com/mariuz/electric-firebird).
