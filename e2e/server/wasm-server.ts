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
 *   GET /browser-harness-wasm-st       → same, with the glue of the build
 *                                        without threads
 *   GET /firebird-engine-worker-st.js  → the engine Worker on that build
 *   GET /dist/firebird-frameworks.mjs  → React, Vue and firebird-wasm/react
 *                                        and /vue, as `window.Frameworks`
 *   GET /browser-harness-frameworks-st → the -st harness, with that bundle
 *   GET /wasm/firebird-embedded-st.*   → that build's glue and binary
 *
 *   GET /firebird-engine-worker-cdn.js?glue=<file>
 *                                      → the engine Worker, loading the engine
 *                                        from the CDN origin below
 *   GET /browser-harness-cdn-st        → the harness, with the glue of the
 *                                        build without threads loaded straight
 *                                        from the CDN origin by <script src>
 *
 * Every route is also served under /no-isolation/, without the COOP/COEP
 * headers: a page there is not cross-origin isolated and gets no
 * SharedArrayBuffer, as on a static host that cannot send them.
 *
 * A second listener on CDN_PORT (3002) stands in for a CDN: another origin
 * serving GET /wasm/<artifact> with the headers jsDelivr and unpkg send
 * (Access-Control-Allow-Origin: *, Cross-Origin-Resource-Policy:
 * cross-origin), and GET /hits counting what it served.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { buildSync } from 'esbuild';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const CDN_PORT = parseInt(process.env['CDN_PORT'] ?? '3002', 10);
const CDN_BASE = `http://localhost:${CDN_PORT}/wasm/`;

// WASM artifacts produced by `npm run build:wasm` + `npm run build`
const WASM_DIR = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm',
);
const WASM_JS   = path.join(WASM_DIR, 'firebird-embedded.js');
const WASM_BIN  = path.join(WASM_DIR, 'firebird-embedded.wasm');
/** The artifacts served under /wasm/: both builds' glue and binary. */
const WASM_FILES = new Set([
  'firebird-embedded.js', 'firebird-embedded.wasm',
  'firebird-embedded-st.js', 'firebird-embedded-st.wasm',
]);

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
          (p) => mod._fb_query(dbHandle, 0, p, 0),
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
      (p) => mod._fb_query(db, 0, p, 0));
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
function browserHarnessHtml(
  withWasmGlue: boolean,
  glueFile = 'firebird-embedded.js',
  withFrameworks = false,
): string {
  const glue = withWasmGlue
    ? `<script src="/wasm/${glueFile}"></script>`
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
  ${withFrameworks ? '<script type="module" src="/dist/firebird-frameworks.mjs"></script>' : ''}
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

const workerBundles = new Map<string, { stamp: number; text: string }>();

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
    external: ['*firebird-embedded.js', '*firebird-embedded-st.js'],
  });

  browserBundle = result.outputFiles[0]!.text;
  browserBundleStamp = stamp;
  return browserBundle;
}

const FRAMEWORKS_ENTRY = path.resolve(__dirname, 'frameworks-entry.ts');
let frameworksBundle: { stamp: number; text: string } | null = null;

/**
 * React, Vue and the bindings (`firebird-wasm/react`, `/vue`) in one module,
 * for browser-frameworks.spec.ts.  Development builds of both, so React's
 * StrictMode runs every effect twice, as it does in an app being developed.
 */
function getFrameworksBundle(): string {
  const stamp = sourceStamp(BROWSER_SRC);
  if (frameworksBundle && frameworksBundle.stamp === stamp) return frameworksBundle.text;

  const result = buildSync({
    entryPoints: [FRAMEWORKS_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    sourcemap: 'inline',
    define: {
      'process.env.NODE_ENV': '"development"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    external: ['*firebird-embedded.js', '*firebird-embedded-st.js'],
  });
  frameworksBundle = { stamp, text: result.outputFiles[0]!.text };
  return frameworksBundle.text;
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
function getWorkerBundle(glueFile = 'firebird-embedded.js', base = '/wasm/'): string {
  const stamp = sourceStamp(BROWSER_SRC);
  const key = base + glueFile;
  const cached = workerBundles.get(key);
  if (cached && cached.stamp === stamp) {
    return cached.text;
  }

  const result = buildSync({
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    sourcemap: 'inline',
    external: ['*firebird-embedded.js', '*firebird-embedded-st.js'],
  });

  // The prelude cdnArtifacts() describes: the glue from `base`, and a
  // locateFile pointing there too.
  const text =
    `importScripts('${base}${glueFile}');\n` +
    `self.FIREBIRD_WORKER_OPTIONS = { locateFile: (f) => '${base}' + f };\n` +
    result.outputFiles[0]!.text;
  workerBundles.set(key, { stamp, text });
  return text;
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

const NO_ISOLATION = '/no-isolation';

const server = http.createServer((req, res) => {
  let url = req.url ?? '/';
  if (url.startsWith(`${NO_ISOLATION}/`)) {
    url = url.slice(NO_ISOLATION.length);
  } else {
    setCrossOriginIsolation(res);
  }

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

  if (req.method === 'GET'
    && (url === '/firebird-engine-worker.js' || url === '/firebird-engine-worker-st.js')) {
    try {
      const glueFile = url.endsWith('-st.js') ? 'firebird-embedded-st.js' : 'firebird-embedded.js';
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(getWorkerBundle(glueFile));
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

  if (req.method === 'GET' && url.startsWith('/firebird-engine-worker-cdn.js?glue=')) {
    const glueFile = url.slice('/firebird-engine-worker-cdn.js?glue='.length);
    if (!WASM_FILES.has(glueFile) || !glueFile.endsWith('.js')) {
      sendJson(res, 400, { error: `unknown glue ${glueFile}` });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(getWorkerBundle(glueFile, CDN_BASE));
    return;
  }

  if (req.method === 'GET' && url === '/browser-harness-cdn-st') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(browserHarnessHtml(true, 'firebird-embedded-st.js').replace(
      '<script src="/wasm/firebird-embedded-st.js">',
      `<script src="${CDN_BASE}firebird-embedded-st.js">`,
    ));
    return;
  }

  if (req.method === 'GET' && url === '/dist/firebird-frameworks.mjs') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(getFrameworksBundle());
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to bundle React, Vue and the bindings',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (req.method === 'GET' && url === '/browser-harness-frameworks-st') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(browserHarnessHtml(true, 'firebird-embedded-st.js', true));
    return;
  }

  if (req.method === 'GET' && url === '/browser-harness-wasm-st') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(browserHarnessHtml(true, 'firebird-embedded-st.js'));
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

  const wasmFile = url.startsWith('/wasm/') ? url.slice('/wasm/'.length) : '';
  if (req.method === 'GET' && WASM_FILES.has(wasmFile)) {
    const file = path.join(WASM_DIR, wasmFile);
    if (!fs.existsSync(file)) {
      sendJson(res, 404, { error: `${wasmFile} not found – run npm run build:wasm` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': wasmFile.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
    });
    res.end(fs.readFileSync(file));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

/** What the stand-in CDN served, by file, since the server started. */
const cdnHits: Record<string, number> = {};

const cdn = http.createServer((req, res) => {
  const url = req.url ?? '/';
  // The headers jsDelivr and unpkg send, and nothing else: no COOP/COEP.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'GET' && url === '/hits') {
    sendJson(res, 200, cdnHits);
    return;
  }
  const file = url.startsWith('/wasm/') ? url.slice('/wasm/'.length) : '';
  if (req.method === 'GET' && WASM_FILES.has(file) && fs.existsSync(path.join(WASM_DIR, file))) {
    cdnHits[file] = (cdnHits[file] ?? 0) + 1;
    res.writeHead(200, {
      'Content-Type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
    });
    res.end(fs.readFileSync(path.join(WASM_DIR, file)));
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});
cdn.listen(CDN_PORT);

server.listen(PORT, () => {
  console.log(`WASM test server listening on http://localhost:${PORT}`);
  console.log(`WASM JS  : ${WASM_JS}`);
  console.log(`WASM bin : ${WASM_BIN}`);
});

process.on('SIGTERM', () => {
  cdn.close();
  server.close();
  process.exit(0);
});
