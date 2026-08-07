/**
 * stub-engine.js – A faithful in-browser stub of the Firebird Emscripten module.
 *
 * The real `firebird-embedded.wasm` artifact takes a full Emscripten toolchain
 * to build and is not published yet (see docs/roadmap.md).  Without it the
 * entire `src/browser` layer — pointer marshalling, JSON result decoding,
 * transaction control flow, MEMFS ⇄ IndexedDB persistence — would have zero
 * coverage, because the Jest suite explicitly ignores `/src/browser/`.
 *
 * This file installs a `globalThis.createFirebirdModule` factory with the same
 * shape the Emscripten glue exports, so `loadFirebirdWasm()` picks it up in a
 * real browser.  It is deliberately *not* a mock of `FirebirdBrowser`: the code
 * under test is the real, bundled library.  What is stubbed is only the C ABI
 * boundary, and it is stubbed strictly:
 *
 *   • a real byte heap with a bump allocator, so `_malloc`/`_free`/
 *     `stringToUTF8`/`UTF8ToString` round-trip actual UTF-8 bytes and leaked
 *     or double-freed pointers are detectable;
 *   • a real in-memory filesystem whose database files are exact multiples of
 *     the page size, so `IndexedDBVFS.importDatabase()` is exercised for real;
 *   • fault injection for every C call, so error paths are reachable.
 *
 * Injected into the page with `page.addInitScript()` before navigation, so it
 * is present before the module bundle runs.
 *
 * Test-facing control surface: `globalThis.__stub`.
 */
(() => {
  const PAGE_SIZE = 8192;
  const INITIAL_PAGES = 2;
  const HEAP_SIZE = 4 * 1024 * 1024;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ── Control surface read/written by the Playwright tests ─────────────────
  const stub = {
    /** Number of times the Emscripten factory was invoked (module caching). */
    factoryCalls: 0,
    /** Ordered log of every C-ABI call: `{ fn, args }`. */
    calls: [],

    // Fault injection / canned responses.
    /** Return code of `_fb_init` (non-zero = failure). */
    initRc: 0,
    /** Return code of `_fb_execute` (non-zero = failure). */
    execRc: 0,
    /** Payload `_fb_query` serialises to the heap. */
    queryResult: { columns: [], rows: [] },
    /** When true, `_fb_query` returns a NULL pointer. */
    queryReturnsNull: false,
    /** When true, `_fb_create_database` returns a NULL handle. */
    createFails: false,
    /** When true, `_fb_start_transaction` returns a NULL handle. */
    startTxFails: false,
    /** Return code of `_fb_commit` (non-zero = failure). */
    commitRc: 0,
    /** Text `_fb_last_error()` reports; the real engine puts Firebird's own message here. */
    lastError: '',

    // Inspection helpers (defined once the module is built).
    /** Names of the logged calls, in order. */
    callNames: () => stub.calls.map((c) => c.fn),
    /** Arguments of the first logged call named `fn`. */
    firstCall: (fn) => stub.calls.find((c) => c.fn === fn) ?? null,
    /** Number of logged calls named `fn`. */
    countCalls: (fn) => stub.calls.filter((c) => c.fn === fn).length,
    /** Reset the call log without rebuilding the module. */
    resetCalls: () => {
      stub.calls.length = 0;
    },
  };

  globalThis.__stub = stub;

  // ── Emscripten-compatible module factory ────────────────────────────────
  globalThis.createFirebirdModule = async function createFirebirdModule(opts = {}) {
    stub.factoryCalls += 1;
    stub.moduleOptions = opts;

    // ── Heap + bump allocator ────────────────────────────────────────────
    const heap = new Uint8Array(HEAP_SIZE);
    const live = new Map(); // ptr -> size
    // Buffers the engine allocated for itself (query results, error text).
    // They are tracked separately so that `liveAllocations` stays a clean
    // signal for pointers the *caller* was supposed to release.
    const engineOwned = new Set();
    let brk = 8; // never hand out 0: NULL must stay distinguishable
    let doubleFrees = 0;

    function malloc(size) {
      const ptr = brk;
      brk += (size + 7) & ~7;
      if (brk >= HEAP_SIZE) throw new Error('stub heap exhausted');
      live.set(ptr, size);
      return ptr;
    }

    function free(ptr) {
      engineOwned.delete(ptr);
      if (!live.delete(ptr)) doubleFrees += 1;
    }

    function lengthBytesUTF8(str) {
      return encoder.encode(str).length;
    }

    function stringToUTF8(str, outPtr, maxBytesToWrite) {
      const bytes = encoder.encode(str);
      if (bytes.length + 1 > maxBytesToWrite) {
        throw new RangeError('stringToUTF8: buffer too small');
      }
      heap.set(bytes, outPtr);
      heap[outPtr + bytes.length] = 0;
    }

    function UTF8ToString(ptr) {
      if (ptr === 0) return '';
      let end = ptr;
      while (heap[end] !== 0) end += 1;
      return decoder.decode(heap.subarray(ptr, end));
    }

    /** Copy a JS string onto the heap and return the pointer (engine-owned). */
    function heapString(str) {
      const len = lengthBytesUTF8(str) + 1;
      const ptr = malloc(len);
      stringToUTF8(str, ptr, len);
      engineOwned.add(ptr);
      return ptr;
    }

    // ── In-memory filesystem (stands in for Emscripten MEMFS) ────────────
    const files = new Map(); // path -> Uint8Array
    const dirs = new Set(['/']);

    const FS = {
      mkdir(path) {
        stub.calls.push({ fn: 'FS.mkdir', args: [path] });
        dirs.add(path);
      },
      analyzePath(path) {
        return { exists: files.has(path) || dirs.has(path) };
      },
      readFile(path) {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
      },
      writeFile(path, data) {
        stub.calls.push({ fn: 'FS.writeFile', args: [path, data.byteLength] });
        files.set(path, new Uint8Array(data));
      },
      unlink(path) {
        files.delete(path);
      },
      stat(path) {
        return { size: files.get(path)?.byteLength ?? 0, mtime: new Date(0) };
      },
      mount() {},
      unmount() {},
      syncfs(_populate, cb) {
        cb(null);
      },
    };

    // ── Engine state ─────────────────────────────────────────────────────
    const attachments = new Map(); // handle -> path
    const liveResults = new Set(); // result pointers not yet freed
    let nextDbHandle = 1000;
    let nextTxHandle = 5000;
    let initialised = false;

    /**
     * Databases are byte-exact multiples of PAGE_SIZE so the IndexedDB VFS
     * (which rejects anything else) is exercised as it would be for real.
     * Byte 0 is a magic marker; byte 1 counts committed statements, giving
     * tests a durable value to assert on after a reload.
     */
    function newDatabaseImage() {
      const img = new Uint8Array(PAGE_SIZE * INITIAL_PAGES);
      img[0] = 0xfb;
      img[1] = 0;
      return img;
    }

    const mod = {
      _fb_init() {
        stub.calls.push({ fn: '_fb_init', args: [] });
        if (stub.initRc !== 0) return stub.initRc;
        initialised = true;
        return 0;
      },

      _fb_create_database(pathPtr) {
        const path = UTF8ToString(pathPtr);
        stub.calls.push({ fn: '_fb_create_database', args: [path] });
        if (stub.createFails) return 0;
        files.set(path, newDatabaseImage());
        const handle = nextDbHandle++;
        attachments.set(handle, path);
        return handle;
      },

      _fb_attach_database(pathPtr) {
        const path = UTF8ToString(pathPtr);
        stub.calls.push({ fn: '_fb_attach_database', args: [path] });
        if (!files.has(path)) return 0;
        const handle = nextDbHandle++;
        attachments.set(handle, path);
        return handle;
      },

      _fb_detach_database(handle) {
        stub.calls.push({ fn: '_fb_detach_database', args: [handle] });
        attachments.delete(handle);
        return 0;
      },

      _fb_execute(handle, txHandle, sqlPtr) {
        const sql = UTF8ToString(sqlPtr);
        stub.calls.push({ fn: '_fb_execute', args: [handle, txHandle, sql] });
        if (stub.execRc !== 0) return stub.execRc;
        // Record the write in the database image so persistence is observable.
        const path = attachments.get(handle);
        const img = path ? files.get(path) : undefined;
        if (img) img[1] = (img[1] + 1) & 0xff;
        return 0;
      },

      _fb_query(handle, txHandle, sqlPtr) {
        const sql = UTF8ToString(sqlPtr);
        stub.calls.push({ fn: '_fb_query', args: [handle, txHandle, sql] });
        if (stub.queryReturnsNull) return 0;
        const ptr = heapString(JSON.stringify(stub.queryResult));
        liveResults.add(ptr);
        return ptr;
      },

      _fb_free_result(resultPtr) {
        stub.calls.push({ fn: '_fb_free_result', args: [resultPtr] });
        liveResults.delete(resultPtr);
        free(resultPtr);
      },

      _fb_start_transaction(handle) {
        stub.calls.push({ fn: '_fb_start_transaction', args: [handle] });
        if (stub.startTxFails) return 0;
        return nextTxHandle++;
      },

      _fb_commit(txHandle) {
        stub.calls.push({ fn: '_fb_commit', args: [txHandle] });
        return stub.commitRc;
      },

      _fb_rollback(txHandle) {
        stub.calls.push({ fn: '_fb_rollback', args: [txHandle] });
        return 0;
      },

      /**
       * Engine-owned message buffer.  The real implementation returns a
       * pointer into a std::string that the next call overwrites, so the
       * stub allocates a fresh buffer each time and never expects a free()
       * from the caller — a caller that frees it would be double-freeing.
       */
      _fb_last_error() {
        return heapString(stub.lastError);
      },

      _malloc: malloc,
      _free: free,
      UTF8ToString,
      stringToUTF8,
      lengthBytesUTF8,
      FS,
      MEMFS: {},
    };

    // ── Inspection helpers bound to this module instance ──────────────────
    stub.stats = () => ({
      // Only caller-owned pointers count as leaks: the engine's own buffers
      // (fb_last_error text) are never handed back for the caller to free.
      liveAllocations: [...live.keys()].filter((p) => !engineOwned.has(p)).length,
      liveResults: liveResults.size,
      doubleFrees,
      initialised,
      openAttachments: attachments.size,
    });
    stub.fileBytes = (path) => Array.from(files.get(path) ?? []);
    stub.fileSize = (path) => files.get(path)?.byteLength ?? 0;
    stub.fileExists = (path) => files.has(path);
    stub.statementCount = (path) => files.get(path)?.[1] ?? -1;
    stub.pageSize = PAGE_SIZE;

    return mod;
  };
})();
