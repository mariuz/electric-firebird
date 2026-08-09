# How Firebird was ported to WebAssembly

This is the engineering account: what had to be solved, in what order, and how
each problem was found. It is written for anyone who wants to modify the
build, debug the engine, or port a comparable C++ codebase to WASM.

For *using* the result, see [integration.md](./integration.md). For current
status and what remains, see [roadmap.md](./roadmap.md).

- **Engine:** Firebird 6.0.0 (`master`, vendored as a submodule)
- **Toolchain:** Emscripten 6.0.6, vendored at `third_party/emsdk`
- **Output:** `firebird-embedded.wasm` (~9.1 MB) + `firebird-embedded.js` (~108 KB)
- **Changes to Firebird's own source:** four patches, ~200 lines

---

## 1. The shape of the problem

Firebird Embedded is not a library that happens to write files. It is a full
relational engine: a page cache, a lock manager, a metadata cache built on
hazard-pointer garbage collection, a PSQL virtual machine, an optimiser, an
international text subsystem, and a plugin architecture that loads its own
providers at runtime. All of it assumes a POSIX host with threads, shared
memory, semaphores, dynamic loading and a real filesystem.

WebAssembly offers a 32-bit address space, no `dlopen`, cooperative threads
that are really Web Workers over `SharedArrayBuffer`, and a filesystem that
exists only because Emscripten emulates one.

The work divides into three parts, and it is worth naming them separately
because they fail in completely different ways:

| Part | Failure mode |
|------|--------------|
| **Getting it to compile** | Loud. Missing headers, unknown types, absent syscalls |
| **Getting it to link** | Loud. Undefined symbols, duplicate symbols |
| **Getting it to *run*** | Silent. It links, starts, and then aborts somewhere unrelated |

The third part took the overwhelming majority of the effort, and every one of
its bugs presented as a crash in code that was not at fault.

### The design constraint

**Minimal changes to Firebird's source.** Every line patched into the engine
is a line that must be rebased onto every future Firebird release. The
strategy that made this practical:

1. Build the ABI on Firebird's **public OO API** (the `cloop`-generated
   `IMaster` / `IProvider` / `IAttachment` interfaces), not on internal
   headers. That interface is stable across releases by design.
2. Push platform differences into **link-time overrides** — a separate
   translation unit that redefines a handful of POSIX functions — rather than
   `#ifdef`s scattered through the engine.
3. Patch the source only where neither of those can reach.

The result is four patches:

| Patch | What it does |
|-------|--------------|
| `0001-cmake-icu-emscripten-support` | Lets the CMake build find ICU when cross-compiling |
| `0002-unicode-util-static-icu-wasm` | Links ICU statically instead of `dlopen`-ing it |
| `0003-threadstart-emscripten-no-lwp-thread-id` | Drops a Linux-specific thread-ID syscall |
| `0004-intl-builtin-charsets-only-wasm` | Registers only the built-in character sets |

Everything else is external.

---

## 2. Building it at all

Firebird cannot be compiled by pointing a compiler at its sources. It
bootstraps itself, and three of those bootstrap steps need to run as **native
host binaries** before any cross-compilation can begin.

```
native cmake configure ──► autoconfig.h        (host feature detection)
                       ──► btyacc ──► parse.cpp (the SQL grammar)
                       ──► gpre_boot ──► *.epp → *.cpp
                                          (embedded SQL preprocessing)
                                   │
                                   ▼
                          emcmake + emmake ──► firebird-embedded.wasm
```

`.epp` files are C++ with SQL statements embedded in them. Firebird's own
preprocessor, `gpre`, turns them into plain C++ — and `gpre` is itself written
partly in `.epp`, so a bootstrap `gpre_boot` has to be built for the host
first. `build.sh` orchestrates all of this, then preprocesses every `.epp`
under `src/jrd` and `src/dsql`.

### autoconfig.h describes the wrong machine

The native configure step writes `autoconfig.h`, which records what the
compiler found — on the **host**. The host is x86-64. The target is wasm32.
Several of those answers are then wrong in ways that compile perfectly:

```c
#define SIZEOF_LONG   8   /* wasm32: 4 */
#define SIZEOF_VOID_P 8   /* wasm32: 4 */
#define SIZEOF_SIZE_T 8   /* wasm32: 4 */
```

`build.sh` rewrites these, and also clears feature flags for facilities
Emscripten does not have (`HAVE_ZLIB_H`, `HAVE_AIO_H`,
`HAVE_LINUX_FALLOC_H`, `SUPPORT_RAW_DEVICES`) and fixes the `gettimeofday`
arity.

Section 4 explains why `SIZEOF_VOID_P` in particular was worth two days.

### Compile and link settings that matter

```
-std=c++20          Firebird master uses concepts in common/classes/init.h
-fno-rtti           matches upstream
-fwasm-exceptions   see §3, fix 2
-pthread            see §3, fix 4
```

```
-s PTHREAD_POOL_SIZE=32          the engine starts threads eagerly
-s STACK_SIZE=8388608            database creation is deeply recursive
-s DEFAULT_PTHREAD_STACK_SIZE=4194304
-s INITIAL_MEMORY=67108864
-s ALLOW_MEMORY_GROWTH=1
-s ENVIRONMENT='web,worker,node'
```

---

## 3. The seven runtime fixes

Each of these was found only by running the engine. In the order they
surfaced:

| # | Fix | Symptom it produced |
|---|-----|---------------------|
| 1 | `SIZEOF_VOID_P` / `SIZEOF_SIZE_T` for wasm32 | `null function or function signature mismatch` inside `fb_create_database` |
| 2 | `-fwasm-exceptions` | first `throw` aborted at `___cxa_throw` |
| 3 | Override `pthread_mutexattr_setpshared` | `PTHREAD_PROCESS_SHARED` unsupported, treated as fatal |
| 4 | `-pthread` + a worker pool | `pthread_create failed` |
| 5 | Compile the real libcds | `INI_init` read the relation vector out of bounds |
| 6 | Implement `sem_timedwait` properly | `sem_wait() failed - Operation timed out` |
| 7 | Built-in character sets only | `CHARACTER SET "SYSTEM"."SJIS_0208" is not installed` |

Fix 1 is the subject of the next section. Three of the others are worth
drawing out.

### Fix 3 — a supported feature is not the same as a working one

Emscripten *provides* `pthread_mutexattr_setpshared`; it returns `EINVAL` for
`PTHREAD_PROCESS_SHARED`, which is honest — there are no processes to share
with. Firebird checks the return value and treats failure as fatal, which is
also correct on a real host.

Both sides are right and the program still dies. The fix is a link-time
override that accepts the flag and ignores it, which is safe *here* precisely
because the single-process assumption that makes it a lie on POSIX is
guaranteed true in WASM.

### Fixes 5 and 6 — stubs whose reasoning had expired

These two are the most transferable lesson in the whole port.

**libcds.** Firebird's metadata cache is built on hazard-pointer garbage
collection: `CacheVector`'s storage is a `SharedReadVector`, and reading it
hands out a `HazardPtr` that is only valid on a thread *attached* to the GC.
An early stub replaced `ThreadData::init()` on the grounds that the real one
drags in URCU. It does not — and more to the point, skipping the attachment
meant every metadata read was reading through an unregistered hazard pointer.
The symptom was `INI_init` walking off the end of the relation vector during
database creation, which looks like a bounds bug in the initialiser and is
not.

**`sem_timedwait`.** An early stub returned `ETIMEDOUT` immediately, with the
comment that the build is single-threaded so nothing could ever be waited on.
That was true when it was written. It stopped being true at fix 4, when
`-pthread` landed — and the stub kept the comment, so it read as deliberate
long after it had become a bug.

> **A stub written for one set of constraints becomes a bug when the
> constraints change.** Both of these were correct when written and wrong when
> they fired, and in both cases the stale justification in the comment was
> what made them hard to see. When a stub's premise changes, the stub is a
> defect even though nothing about it was edited.

`fb_wasm_stubs.cpp` shrank from 1934 lines to 447 over the port, mostly by
deleting stubs in favour of compiling the real thing.

### Fix 7 — a trade-off, not a repair

Firebird's `IntlManager` loads character-set and collation modules
dynamically. Without `dlopen` there is nothing to load, so patch 0004
registers only the built-in sets under `__EMSCRIPTEN__`.

This is a genuine limitation rather than a fix: `NONE`, `ASCII`, `UTF8`,
`OCTETS` and the other built-ins work; `SJIS_0208` and the rest of the
loadable sets do not. Statically linking every collation would inflate the
artifact substantially for a capability most browser applications will never
use. It is recorded here because a user hitting
`CHARACTER SET ... is not installed` deserves to find the reason.

---

## 4. The alignment bug, in full

This one is worth reading even if you never touch this project, because the
distance between cause and symptom is instructive.

**Symptom.** `fb_create_database()` aborted with WASM's
`null function or function signature mismatch` — the trap you get when an
indirect call lands on a function of the wrong type. Nothing in the C ABI
layer does indirect calls of that kind.

**Locating it.** `emsymbolizer` against the trap address pointed at
`Database.cpp:886`. An ASan build reported a read at address `0x8` — a null
pointer plus an 8-byte offset, i.e. a vtable dispatch through a null object.
The object was `JProvider::pluginConfig`.

That is *plausible* as a plugin-configuration bug, and seven hypotheses along
those lines were tried and eliminated. All of them were wrong, because the
plugin configuration was not corrupt when it was written — something else
overwrote it afterwards.

**The cause.** `common/classes/alloc.cpp` sizes its allocator header from
`autoconfig.h`:

```cpp
#elif (SIZEOF_VOID_P == 4)
    FB_UINT64 dummyAlign;      // padding so MemHeader is 16 bytes
#endif
```

With the host's `SIZEOF_VOID_P 8`, that padding is omitted and `MemHeader` is
8 bytes instead of 16. `ALLOC_ALIGNMENT` is 16. Every allocation from a
Firebird memory pool therefore came back 8 bytes off alignment, and the
block-arithmetic that walks the pool wrote past the ends of live blocks. One
of those writes happened to land on `JProvider::pluginConfig`, whose vtable
pointer the engine then dereferenced.

**Confirming it.** Reasoning was not enough — the earlier hypotheses had also
sounded convincing. `wasm/fb_pool_probe.cpp` (build with
`-DFB_WASM_POOL_PROBE=ON`) allocates sixteen blocks from the default pool with
no engine involved at all:

| | before | after |
|---|---|---|
| Misaligned returns | 16 of 16 (every `ptr % 16 == 8`) | 0 |
| Blocks clobbered while live | 7 | 0 |

Sixteen out of sixteen is not a hypothesis, and the probe runs in about a
second.

**The lesson.** A cross-compile inherits its host's answers to questions about
the target. `build.sh` already patched `SIZEOF_LONG` — the class of bug was
known — and stopped one line short. Where a build fixes up one such value,
check whether its neighbours need the same treatment.

---

## 5. Techniques that actually worked

Ordered by how much time they saved.

**Isolate the mechanism, not the symptom.** The pool probe settled in one
second what a week of reasoning about plugin configuration had not. If a
subsystem can be exercised without the rest of the program, do that before
forming a theory.

**Bisect by removing inputs.** Parameter binding failed with a bare "internal
error". Running the same code path with an *empty* parameter list still failed,
which cleared the encoding, the marshalling and the value conversion in one
step and pointed at how the input message was being described. The fix was to
use the statement's declared metadata with `IUtil::convert` rather than
building metadata with `IMetadataBuilder`.

**Get real stack traces.** `emsymbolizer` turns a WASM trap address into a
file and line. Build with `-DFB_WASM_DEBUG=ON` and `-DFB_WASM_DEBUG_SOURCES=ON`
to keep names. Without this you are guessing.

**Use the sanitizers, but know what they cost.** `-DFB_WASM_SANITIZE=address`
found the read at `0x8` that made the corruption concrete. ASan builds need
`INITIAL_MEMORY=1GB` and `ALLOW_MEMORY_GROWTH=0`, and they are slow — but they
turn "it crashes somewhere" into an address.

**Prefer deleting a stub to keeping it.** Nearly every stub that survived past
its first purpose became a bug. Compiling the real source — even when it drags
in dependencies — was consistently cheaper than maintaining a fake.

**Pin the toolchain.** CI once built against Emscripten 3.1.64 while every
local build used the vendored 6.0.6. The artifact compiled, linked, and passed
every check that did not touch the engine, then aborted inside
`fb_create_database`. The version is now pinned in
`packages/firebird-wasm/wasm/emsdk-version.txt` and `build.sh` refuses to run
against anything else. A toolchain mismatch produces no build-time signal at
all, so build time is the only place it can be caught.

### What could not be used

`-sEMULATE_FUNCTION_POINTER_CASTS` is the usual answer to signature-mismatch
traps. It fails Binaryen validation on the UDF `invoke()` path generated from
`fun.epp`, so it is not available here. This is worth knowing before spending
an afternoon on it.

---

## 6. The C ABI

`wasm/fb_wasm_api.cpp` (~1760 lines) is the entire surface between JavaScript
and the engine. Fifteen exported functions:

```c
int      fb_init(void);
const char* fb_last_error(void);
int      fb_last_affected_rows(void);

FbHandle fb_create_database(const char* path);
FbHandle fb_attach_database(const char* path);
int      fb_detach_database(FbHandle db);

int      fb_execute(FbHandle db, FbHandle tx, const char* sql);
int      fb_execute_params(FbHandle db, FbHandle tx, const char* sql,
                           const uint8_t* params, int len);
char*    fb_query(FbHandle db, FbHandle tx, const char* sql);
char*    fb_query_params(FbHandle db, FbHandle tx, const char* sql,
                         const uint8_t* params, int len);
void     fb_free_result(char* result);

FbHandle fb_start_transaction(FbHandle db);
int      fb_commit(FbHandle tx);
int      fb_rollback(FbHandle tx);
```

Three decisions in there are load-bearing:

**Handles, not pointers.** JavaScript holds opaque integers that index a table
on the C side. A stale handle produces a clean error instead of a wild
dereference.

**Errors are retrieved, not returned.** The functions return a code; the
readable Firebird message lives behind `fb_last_error()` and must be read
before the next call overwrites it. This keeps the ABI narrow without
discarding the diagnostics.

**Results are JSON, and the engine owns the buffer** until `fb_free_result`.
JSON is a compromise — a typed binary encoding would be faster — but it made
the type mapping in §7 tractable, and result decoding has never been the
bottleneck.

### Parameters

Parameters are packed into one buffer rather than being passed individually:

```
u32 count
  ├─ u8  isNull
  ├─ u32 byteLength
  └─ UTF-8 bytes
  (repeated)
```

Values cross as text and are converted by the engine using the statement's
**declared** parameter metadata:

```cpp
g_util->convert(status.ptr(),
    SQL_VARYING, 0, source.size(), source.data(),
    type & ~1u, scale, length, buffer.data() + offset);
```

Sending text and letting the engine convert means the engine's own coercion
rules apply — a date is parsed the way Firebird parses dates. It is also why
`Uint8Array` parameters throw rather than being silently mangled: binary has
no text form, and guessing would corrupt data.

---

## 7. Types that do not fit in a JavaScript number

Firebird has exact numerics; JavaScript has doubles. Anything that cannot
survive a `double` crosses the boundary as an **exact decimal string**:

| Firebird type | JavaScript |
|---------------|------------|
| `SMALLINT`, `INTEGER` | `number` |
| `BIGINT` within ±2^53 | `number` |
| `BIGINT` beyond ±2^53 | `string` |
| `NUMERIC`, `DECIMAL` | `string` |
| `DECFLOAT`, `INT128` | `string` |
| `DATE`, `TIME`, `TIMESTAMP` | ISO-8601 `string` |
| `BLOB SUB_TYPE TEXT` | `string` |
| `BLOB SUB_TYPE BINARY` | base64 `string` |

This creates an ambiguity that had to be closed: a `NUMERIC(10,2)` arriving as
`"20.25"` is indistinguishable from a `VARCHAR` containing those characters.
So every column is *described*, not just named:

```ts
{ name: 'PRICE', type: 32752, typeName: 'NUMERIC',
  subType: 0, scale: -2, length: 8, nullable: true }
```

`typeName` is not a lookup table. Firebird stores `NUMERIC` and `DECIMAL` as
scaled `SMALLINT`/`INTEGER`/`BIGINT`/`INT128`, so the raw type code for a
`NUMERIC(10,2)` says BIGINT. Reporting `NUMERIC` when the scale is non-zero is
what actually tells a caller that `"20.25"` is an exact number rather than
text.

---

## 8. Threads, and why a browser needs a Worker

The build uses pthreads, which Emscripten implements with Web Workers over
`SharedArrayBuffer`. Two consequences:

**The page must be cross-origin isolated.** Browsers withhold
`SharedArrayBuffer` unless the document is served with:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**The engine cannot run on the main thread.** Firebird blocks on mutexes while
opening a database, and a browser main thread is not permitted to block. A
main-thread harness deadlocks — reliably, not intermittently. So the browser
API is transport-based: `WorkerTransport` forwards every call to a Worker that
owns the engine and Emscripten's filesystem. `DirectTransport` calls the
exports in-process and is what Node uses.

Because the filesystem lives in the Worker, filesystem operations are part of
the transport interface rather than something the caller does — persistence
copies the database between that filesystem and IndexedDB, and only the Worker
side can read it.

---

## 9. Persistence, and the multi-tab hazard

The database lives in Emscripten's in-memory filesystem. Durability means
copying the image into IndexedDB, page by page, in **one** transaction:
IndexedDB guarantees all-or-nothing, so an interrupted persist leaves the
previous image intact rather than a half-written file. Only pages that
actually changed are rewritten, which turns the common case from
O(database) into O(changes).

That design has a consequence that cannot be locked away: each tab holds a
*complete* copy and writes the *whole image*. Two tabs are therefore not two
writers to be interleaved — the later persist replaces everything the other
did, with both tabs reporting success.

So a tab takes an exclusive [Web Lock][weblocks] on the database before it
reads the stored image, and a second tab is refused with `DatabaseLockedError`
rather than allowed to overwrite. Web Locks specifically, for one property: a
lock is released when the holding context dies, so a crashed or closed tab
frees the database immediately. A lease record in IndexedDB would have to
guess whether a holder that went quiet 40 seconds ago is dead or busy, and
every possible answer is either a deadlock or a corruption window.

The lock is taken *before* the image is read, because a tab that loaded the
database and then waited would resume from a snapshot the departing tab had
already replaced — the very overwrite the lock exists to prevent.

---

## 10. Building it yourself

```bash
git clone --recurse-submodules https://github.com/mariuz/electric-firebird
cd electric-firebird
npm install

EMSDK_VERSION=$(cat packages/firebird-wasm/wasm/emsdk-version.txt)
(cd third_party/emsdk && ./emsdk install "$EMSDK_VERSION" \
  && ./emsdk activate "$EMSDK_VERSION")
source third_party/emsdk/emsdk_env.sh

npm run build:wasm -w packages/firebird-wasm
```

Expect the better part of an hour on a first build. Useful options:

| Option | Effect |
|--------|--------|
| `-DFB_WASM_DEBUG=ON` | debug info, assertions |
| `-DFB_WASM_DEBUG_SOURCES=ON` | keep source names for `emsymbolizer` |
| `-DFB_WASM_SANITIZE=address` | ASan (needs `INITIAL_MEMORY=1GB`) |
| `-DFB_WASM_POOL_PROBE=ON` | build the allocator probe from §4 |

See [`wasm/README-debugging.md`](../packages/firebird-wasm/wasm/README-debugging.md)
for the debugging workflow.

---

## 11. What is verified

| Suite | Count | What it covers |
|-------|-------|----------------|
| `wasm-integration` (Jest) | 13 | The C ABI directly, against the real engine |
| `db-lock` (Jest) | 10 | Cross-tab locking, timing and failure paths |
| `wasm-loader` (Jest) | 4 | Module loading (one skipped without the artifact) |
| `browser-api` (Playwright) | 43 | The TypeScript layer against a strict C-ABI stub |
| `browser-engine` (Playwright) | 11 | The public API against the real engine |
| `browser-multitab` (Playwright) | 7 | Two live tabs contending for one database |
| `wasm` (Playwright) | 2 | Engine inside a Worker, cross-origin isolated |
| `demo` (Playwright) | 16 | The published site, on a host sending no COOP/COEP |

The `browser-api` stub deserves a note: it is not a mock that returns fixed
answers. It implements the C ABI with a real bump-allocator heap, tracks
engine-owned pointers, detects double frees, and supports fault injection — so
pointer marshalling, memory ownership and error paths are exercised for real,
and only the SQL engine itself is absent.

The demo suite is deliberately run against a server that sends **no**
COOP/COEP headers, because that is what GitHub Pages does. A test server that
helpfully set them would pass while the published site failed.

---

## 12. What is not done

- **Loadable character sets are unavailable** (§3, fix 7).
- **Two tabs cannot share one database** — the second is refused, not served.
  Sharing needs a SharedWorker leader with the other tabs as clients.
- **No live queries** — no `POST_EVENT`-driven subscriptions yet.
- **`loadFirebirdWasm()` caches one module process-wide** with no way to
  dispose it; `close()` does not release the WASM heap.
- **No ElectricSQL sync.**

[weblocks]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
