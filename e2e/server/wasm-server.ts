/**
 * wasm-server.ts – Minimal static HTTP server for Firebird browser tests.
 *
 * This server has NO dependency on Firebird or node-firebird-driver-native.
 * It serves two things to Playwright-controlled browsers:
 *
 *   1. The WASM build artifacts (when they have been built).
 *   2. An ESM bundle of `packages/firebird-wasm/src/browser`, so the real
 *      `FirebirdBrowser` / `IndexedDBVFS` code can be driven from a real
 *      browser — with the real IndexedDB — regardless of whether the WASM
 *      artifact exists.
 *
 * Routes:
 *   GET /health                        → { status: 'ok' }
 *   GET /wasm/firebird-embedded.js     → Emscripten JS glue (text/javascript)
 *   GET /wasm/firebird-embedded.wasm   → WASM binary (application/wasm)
 *   GET /wasm-test                     → HTML harness driving the raw C API
 *   GET /dist/firebird-browser.mjs     → esbuild bundle of src/browser (ESM)
 *   GET /browser-harness               → blank page exposing the bundle as
 *                                        `window.FB`; the engine comes from
 *                                        whatever installed
 *                                        `globalThis.createFirebirdModule`
 *   GET /browser-harness-wasm          → same, but also loads the real
 *                                        Emscripten glue via <script>
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { buildSync } from 'esbuild';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

// WASM artifacts produced by `npm run build:wasm` + `npm run build`
const WASM_DIR = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm',
);
const WASM_JS   = path.join(WASM_DIR, 'firebird-embedded.js');
const WASM_BIN  = path.join(WASM_DIR, 'firebird-embedded.wasm');

// TypeScript entry point of the browser build, bundled on demand.
const BROWSER_ENTRY = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/src/browser/index.ts',
);

// ---------------------------------------------------------------------------
// In-page test harness
// ---------------------------------------------------------------------------

/**
 * Minimal HTML page that loads the Emscripten module and drives the C API
 * through a full round-trip: initialise, create a database, run DDL and DML,
 * then read the rows back.  Results are written to element data attributes so
 * Playwright can read them with simple DOM assertions.
 *
 * This is deliberately an end-to-end exercise rather than a "does the function
 * exist" check — the API used to be stubbed, and a smoke test that only
 * asserted "returns 0" could not tell a working engine from a stub.
 *
 * Expected data attributes on #result when complete:
 *   data-done="true"         – all steps finished without exception
 *   data-init-rc="0"         – _fb_init() returned 0
 *   data-db-handle="…"       – handle from _fb_create_database() (>0)
 *   data-query-json="…"      – JSON string from _fb_query()
 *   data-error="…"           – set only if a step failed
 *   data-engine-error="…"    – _fb_last_error() text at the point of failure
 */
const WASM_TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Firebird WASM Browser Test</title>
  <script src="/wasm/firebird-embedded.js"></script>
</head>
<body>
  <pre id="result"></pre>
  <script>
    (async () => {
      const el = document.getElementById('result');
      let mod = null;

      const engineError = () => {
        if (!mod || typeof mod._fb_last_error !== 'function') return '';
        const ptr = mod._fb_last_error();
        return ptr ? mod.UTF8ToString(ptr) : '';
      };

      const withSql = (sql, fn) => {
        const len = mod.lengthBytesUTF8(sql) + 1;
        const ptr = mod._malloc(len);
        mod.stringToUTF8(sql, ptr, len);
        try {
          return fn(ptr);
        } finally {
          mod._free(ptr);
        }
      };

      try {
        if (typeof createFirebirdModule !== 'function') {
          throw new Error('createFirebirdModule is not defined');
        }

        mod = await createFirebirdModule();

        const initRc = mod._fb_init();
        el.dataset.initRc = String(initRc);
        if (initRc !== 0) {
          throw new Error('_fb_init() failed with code ' + initRc);
        }

        if (!mod.FS.analyzePath('/data').exists) {
          mod.FS.mkdir('/data');
        }
        const dbPath = '/data/wasm-test.fdb';
        if (mod.FS.analyzePath(dbPath).exists) {
          mod.FS.unlink(dbPath);
        }

        const dbHandle = withSql(dbPath, (p) => mod._fb_create_database(p));
        el.dataset.dbHandle = String(dbHandle);
        if (dbHandle === 0) {
          throw new Error('_fb_create_database() returned a null handle');
        }

        // 0 as the transaction handle means "run in your own transaction".
        const exec = (sql) => {
          const rc = withSql(sql, (p) => mod._fb_execute(dbHandle, 0, p));
          if (rc !== 0) {
            throw new Error('_fb_execute() failed with code ' + rc + ' for: ' + sql);
          }
        };

        exec('CREATE TABLE items (id INTEGER, name VARCHAR(32))');
        exec("INSERT INTO items VALUES (1, 'alpha')");
        exec("INSERT INTO items VALUES (2, 'beta')");

        const resultPtr = withSql(
          'SELECT id, name FROM items ORDER BY id',
          (p) => mod._fb_query(dbHandle, 0, p),
        );
        if (resultPtr === 0) {
          throw new Error('_fb_query() returned a null pointer');
        }
        el.dataset.queryJson = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);

        mod._fb_detach_database(dbHandle);

        el.dataset.done = 'true';
      } catch (err) {
        el.dataset.engineError = engineError();
        el.dataset.error = err instanceof Error ? err.message : String(err);
      }
    })();
  </script>
</body>
</html>`;


/**
 * Worker that drives the engine.
 *
 * The build uses pthreads, so Firebird blocks on mutexes while opening a
 * database — which a browser main thread is not allowed to do.  Running the
 * module inside a Worker removes that restriction; the Emscripten runtime
 * spawns its own pthread workers from here.
 */
const ENGINE_WORKER_JS = `
importScripts('/wasm/firebird-embedded.js');

const withSql = (mod, sql, fn) => {
  const len = mod.lengthBytesUTF8(sql) + 1;
  const ptr = mod._malloc(len);
  mod.stringToUTF8(sql, ptr, len);
  try { return fn(ptr); } finally { mod._free(ptr); }
};

const engineError = (mod) => {
  const p = mod._fb_last_error();
  return p ? mod.UTF8ToString(p) : '';
};

(async () => {
  try {
    // importScripts() leaves the worker's own URL as the base, so Emscripten
    // would look for firebird-embedded.wasm at the site root rather than under
    // /wasm/ and get the JSON 404 body instead of a module.
    const mod = await createFirebirdModule({
      locateFile: (file) => '/wasm/' + file,
    });

    const initRc = mod._fb_init();
    if (initRc !== 0) throw new Error('_fb_init() failed: ' + engineError(mod));

    if (!mod.FS.analyzePath('/data').exists) mod.FS.mkdir('/data');
    const dbPath = '/data/worker-test.fdb';
    if (mod.FS.analyzePath(dbPath).exists) mod.FS.unlink(dbPath);

    const db = withSql(mod, dbPath, (p) => mod._fb_create_database(p));
    if (!db) throw new Error('_fb_create_database() failed: ' + engineError(mod));

    for (const sql of [
      'CREATE TABLE items (id INTEGER, name VARCHAR(32))',
      "INSERT INTO items VALUES (1, 'alpha')",
      "INSERT INTO items VALUES (2, 'beta')",
    ]) {
      const rc = withSql(mod, sql, (p) => mod._fb_execute(db, 0, p));
      if (rc !== 0) throw new Error('exec failed (' + sql + '): ' + engineError(mod));
    }

    const resultPtr = withSql(mod, 'SELECT id, name FROM items ORDER BY id',
      (p) => mod._fb_query(db, 0, p));
    if (!resultPtr) throw new Error('query failed: ' + engineError(mod));

    const json = mod.UTF8ToString(resultPtr);
    mod._fb_free_result(resultPtr);

    const dbBytes = mod.FS.readFile(dbPath).length;
    mod._fb_detach_database(db);

    postMessage({ ok: true, dbHandle: db, json, dbBytes });
  } catch (err) {
    postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
})();
`;

/** Page that runs the engine worker and reports the outcome via data-*. */
const WASM_WORKER_TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Firebird WASM Worker Test</title></head>
<body>
  <pre id="result"></pre>
  <script>
    const el = document.getElementById('result');
    el.dataset.isolated = String(self.crossOriginIsolated);
    const w = new Worker('/wasm-engine-worker.js');
    w.onmessage = (e) => {
      const d = e.data;
      if (d.ok) {
        el.dataset.dbHandle = String(d.dbHandle);
        el.dataset.queryJson = d.json;
        el.dataset.dbBytes = String(d.dbBytes);
        el.dataset.done = 'true';
      } else {
        el.dataset.error = d.error;
      }
    };
    w.onerror = (e) => { el.dataset.error = 'worker error: ' + e.message; };
  </script>
</body>
</html>`;

/**
 * Blank harness page.  It only exposes the library on `window.FB`; every
 * assertion is driven from the test file via `page.evaluate()`, which keeps
 * the test logic in TypeScript instead of in a string of HTML.
 *
 * @param withWasmGlue - also load the real Emscripten glue script, so the
 *                       library talks to the actual engine instead of to a
 *                       stub installed by `page.addInitScript()`.
 */
function browserHarnessHtml(withWasmGlue: boolean): string {
  const glue = withWasmGlue
    ? '<script src="/wasm/firebird-embedded.js"></script>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>firebird-wasm browser harness</title>
  ${glue}
</head>
<body>
  <div id="app">firebird-wasm browser harness</div>
  <script type="module">
    import * as FB from '/dist/firebird-browser.mjs';
    window.FB = FB;
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Browser bundle
// ---------------------------------------------------------------------------

const BROWSER_SRC = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/src',
);

let browserBundle: string | null = null;
let browserBundleStamp = -1;

let workerBundle: string | null = null;
let workerBundleStamp = -1;

// The library's Worker entry point, bundled the way an application would.
const WORKER_ENTRY = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/src/browser/worker-entry.ts',
);

/** Most recent mtime across the library sources, used as a cache key. */
function sourceStamp(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, sourceStamp(full));
    } else if (entry.name.endsWith('.ts')) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * Bundle `src/browser/index.ts` into a single ES module.
 *
 * The result is cached — the tests hit this route on every navigation, and a
 * rebuild per request would dominate the suite runtime — but the cache is
 * keyed on source mtimes.  Playwright reuses a running dev server between
 * runs, so without that key an edit to the library would be invisible to the
 * next test run.
 */
function getBrowserBundle(): string {
  const stamp = sourceStamp(BROWSER_SRC);
  if (browserBundle !== null && stamp === browserBundleStamp) {
    return browserBundle;
  }

  const result = buildSync({
    entryPoints: [BROWSER_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    sourcemap: 'inline',
    // wasm-loader.ts has a Node branch that require()s the Emscripten glue.
    // The browser never takes it (it looks for createFirebirdModule on
    // globalThis instead), but esbuild resolves string-literal requires
    // eagerly — and once the artifact is actually built, that drags the glue's
    // node:fs / node:crypto / ws imports into a browser bundle and fails.
    external: ['*firebird-embedded.js'],
  });

  browserBundle = result.outputFiles[0]!.text;
  browserBundleStamp = stamp;
  return browserBundle;
}

/**
 * Build the engine Worker script.
 *
 * Three things have to happen before the bundled entry point runs:
 *   1. the Emscripten glue is loaded, since `loadFirebirdWasm()` looks for
 *      `createFirebirdModule` on the global scope;
 *   2. `locateFile` is set, because `importScripts()` leaves the worker's own
 *      URL as the base and the runtime would otherwise fetch the .wasm from
 *      the site root;
 *   3. only then the entry point, which starts answering messages.
 */
function getWorkerBundle(): string {
  const stamp = sourceStamp(BROWSER_SRC);
  if (workerBundle !== null && stamp === workerBundleStamp) {
    return workerBundle;
  }

  const result = buildSync({
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    sourcemap: 'inline',
    external: ['*firebird-embedded.js'],
  });

  workerBundle =
    "importScripts('/wasm/firebird-embedded.js');\n" +
    "self.FIREBIRD_WORKER_OPTIONS = { locateFile: (f) => '/wasm/' + f };\n" +
    result.outputFiles[0]!.text;
  workerBundleStamp = stamp;
  return workerBundle;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * The WASM build uses pthreads, which Emscripten implements over Web Workers
 * and SharedArrayBuffer.  Browsers only expose SharedArrayBuffer to
 * cross-origin isolated pages, so without these two headers the module fails
 * to instantiate at all — the harness page then reports nothing, rather than
 * an error.
 */
function setCrossOriginIsolation(res: http.ServerResponse): void {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // Same-origin subresources (the .wasm, the glue) must opt in to being
  // embedded by an isolated document.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  setCrossOriginIsolation(res);

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && url === '/dist/firebird-browser.mjs') {
    try {
      const bundle = getBrowserBundle();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(bundle);
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to bundle src/browser',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === 'GET' && url === '/firebird-engine-worker.js') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(getWorkerBundle());
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to bundle the engine worker',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === 'GET' && url === '/browser-harness') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(browserHarnessHtml(false));
    return;
  }

  if (req.method === 'GET' && url === '/browser-harness-wasm') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(browserHarnessHtml(true));
    return;
  }

  if (req.method === 'GET' && url === '/wasm-engine-worker.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(ENGINE_WORKER_JS);
    return;
  }

  if (req.method === 'GET' && url === '/wasm-worker-test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(WASM_WORKER_TEST_HTML);
    return;
  }

  if (req.method === 'GET' && url === '/wasm-test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(WASM_TEST_HTML);
    return;
  }

  if (req.method === 'GET' && url === '/wasm/firebird-embedded.js') {
    if (!fs.existsSync(WASM_JS)) {
      sendJson(res, 404, { error: 'WASM JS glue not found – run npm run build:wasm' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(WASM_JS));
    return;
  }

  if (req.method === 'GET' && url === '/wasm/firebird-embedded.wasm') {
    if (!fs.existsSync(WASM_BIN)) {
      sendJson(res, 404, { error: 'WASM binary not found – run npm run build:wasm' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/wasm' });
    res.end(fs.readFileSync(WASM_BIN));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`WASM test server listening on http://localhost:${PORT}`);
  console.log(`WASM JS  : ${WASM_JS}`);
  console.log(`WASM bin : ${WASM_BIN}`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
