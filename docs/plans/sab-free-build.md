# Plan: a build without SharedArrayBuffer

The artifact is built with `-pthread`, so its memory is a `SharedArrayBuffer`
and a browser only hands one out to a cross-origin isolated page: one served
with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Every consumer inherits that.
Static hosts that cannot set headers (GitHub Pages among them) get a service
worker whose only job is to add the two headers to its own responses and
reload the page once; this repository's demo does exactly that, and so does
`firebird-quake2`. The headers also shut the page off from any cross-origin
resource that does not opt in with CORP, which has cost consumers embedded
images and fonts.

A build that did not need `SharedArrayBuffer` would drop all of it. This plan
says why that is not a link flag, what it would take, and how to find out how
much.

---

## Why the engine needs threads today

`wasm/CMakeLists.txt` passes `-pthread` and `-s PTHREAD_POOL_SIZE=32` for one
reason, recorded there: Firebird starts worker threads and treats a failed
`pthread_create` as fatal. Without `-pthread`, Emscripten's libc has no thread
support and `pthread_create` fails; the engine then dies in
`fb_create_database` with `operating system directive pthread_create failed`,
which is how the port began (see [roadmap.md](../roadmap.md), "The engine
runs").

The pool size is there because a thread created on demand while its creator
blocks waiting for it is a deadlock on the Web Worker model: the worker that
would run the new thread cannot start until the creating thread yields. So the
build pre-spawns 32 workers at load, and the engine must never have more than
that many threads alive at once.

The thread start sites in the engine as built (`Thread::start` and its
wrappers, under `src/jrd` and `src/common`):

| Site | Thread | When it starts |
|---|---|---|
| `jrd/cch.cpp` | cache writer | shared cache (SuperServer-style) attachments |
| `jrd/vio.cpp` | garbage collector | per database, unless `GCPolicy = cooperative` |
| `jrd/event.cpp` | event watcher | first `POST_EVENT` subscription (`listen()`/`live()`) |
| `jrd/CryptoManager.cpp` | crypt thread | an encrypted database |
| `jrd/jrd.cpp` | shutdown, attachment shutdown | `fb_shutdown`, attachment cancel |
| `jrd/tra.cpp`, `jrd/Mapping.cpp`, `jrd/DbCreators.cpp` | helpers | transaction sweep, auth mapping cache, database creators |
| `common/Task.cpp` | parallel workers | `ParallelWorkers > 1` (sweep, index build, backup) |
| `common/classes/Synchronize.cpp`, `common/isc_sync.cpp`, `common/classes/locks.cpp` | primitives | waiting on another thread |
| `jrd/svc.cpp` | services | `gbak`/`gfix` style services, unused here |

Not all of these run in an embedded single-process engine, and not all of the
ones that run are needed: Firebird's Classic architecture runs with no cache
writer and cooperative garbage collection, which is a configuration, not a
patch. But the list has never been measured against *this* build, and that is
step 1.

Two other things lean on threads without starting one:

- **Blocking.** Emscripten implements a mutex wait with `Atomics.wait`, which
  a browser main thread may not call. That is why the engine runs in a Worker
  in the browser. Without threads there is nothing to wait for, and the engine
  could run on the main thread like sql.js does, synchronously; the Worker
  would become a choice rather than a requirement.
- **Memory.** The WASM heap is a `SharedArrayBuffer`, and OPFS sync access
  handles refuse views onto one, so every page read and write through the
  OPFS backend copies through a scratch buffer (noted under M4 in the
  roadmap). A plain `ArrayBuffer` heap would let those calls take the heap
  view directly.

## What it is not

- **Not Asyncify or JSPI.** Those make a synchronous C call yield to the
  event loop; they do not give one thread of WASM another thread to wait on.
  They would be the tool if the engine needed to *await* something (OPFS's
  async API, say), which it does not: the sync access handles are synchronous
  on a worker.
- **Not `-s PROXY_TO_PTHREAD`.** That moves `main` off the browser thread and
  still needs pthreads.
- **Not a smaller pool.** `PTHREAD_POOL_SIZE` only sizes the pool; a pool of
  zero is a build that deadlocks on the first thread.

## The route

1. **Measure which threads this build actually starts.** Build once with a
   `pthread_create` wrapper (`-Wl,--wrap=pthread_create`) that logs the entry
   point and the calling site and then calls through. Run the Node integration
   suite and the e2e suite against it. The log is the list of threads an
   embedded attachment needs, by API call: create, attach, DDL, DML, commit,
   `listen()`, detach. Expect a short list; the table above is the ceiling,
   not the floor. One day.

2. **Classify each one.**
   - *Configuration.* `GCPolicy = cooperative` and the Classic (non-shared
     cache) mode remove the garbage collector and cache writer threads. The
     bridge ships no `firebird.conf` today (it avoids the Y-valve's
     `Providers` lookup for that reason), so this is either a minimal one
     written into MEMFS before `fb_init`, or the same settings compiled in as
     defaults under the build flag. No engine code change; may already be the
     case for some.
   - *Inline.* A thread that exists to do deferred work (sweep, cache
     flushing) can do it on the caller's thread at the point it would have
     signalled the worker, under `#ifdef FB_WASM_NO_THREADS`, as a
     `wasm/patches/` entry like the five already there. Latency moves into
     the statement that triggers it; for an in-browser database that is the
     right trade.
   - *Essential.* The event watcher is the hard one: `listen()` is built on a
     thread that waits on a shared-memory counter. Without threads it becomes a
     poll from `fb_events_poll`, which the browser side already calls on an
     interval (`pollIntervalMs`); the C side checks the counter when asked
     instead of being woken. That is a small change to `event.cpp` under the
     same `#ifdef`, and `live()` keeps its semantics.
   - *Fatal.* Anything that cannot be made inline or polled ends the plan at
     "threads stay, and here is why", which is also a result.

3. **A second artifact, not a replacement.** `wasm/CMakeLists.txt` grows a
   `FB_WASM_THREADS` option (default ON). OFF drops `-pthread`, the pool and
   stack flags for workers, and defines `FB_WASM_NO_THREADS` for the patches;
   `build.sh` builds both into `dist/wasm/firebird-embedded.{js,wasm}` and
   `dist/wasm/firebird-embedded-st.{js,wasm}`. The threaded build stays the
   default until the single-threaded one has run every suite for a release.

4. **Loading.** `loadFirebirdWasm()` gains a `threads: boolean | 'auto'`
   option; `'auto'` in the browser is `crossOriginIsolated`, in Node `true`.
   `locateFile` sees the chosen basename. The browser entry's engine transport
   does not change: the engine still lives in a Worker by default, and the
   single-threaded build makes a main-thread transport possible later.

5. **Tests.** The Node integration suite and the e2e suites run against both
   artifacts; the e2e server grows a mode that sends no COOP/COEP headers, in
   which the threaded artifact must fail to load with a clear message and the
   single-threaded one must pass the whole suite. `wasm-integration.test.ts`
   asserts that the single-threaded module's memory is not a
   `SharedArrayBuffer`.

6. **Consumers.** The demo's service worker and the README's cross-origin
   isolation section become optional, with the headers documented as the
   faster path if the threaded build is wanted. `firebird-quake2` drops its
   service worker and the COOP/COEP lines from its dev server.

## Cost and risk

Step 1 is a day and decides the rest. If the list is garbage collector, cache
writer and event watcher, steps 2 to 5 are about a week: two configuration
lines, one inline patch, one polling patch, a CMake option, a loader option and
the test matrix. If `Task.cpp` workers or the lock manager turn out to be on
the path of an ordinary statement, the inline work is larger and should be
re-costed before continuing.

The risk to carry is a second artifact to build, publish and test, with the
patched code paths exercised only by it. Keeping the threaded build the
default limits that to the consumers who choose the other one; the suites
running against both keep them from drifting apart.

Nothing here changes the API, the wire formats or the storage backends.
