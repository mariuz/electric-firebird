/**
 * wasm-server.ts – Minimal static HTTP server for Firebird WASM browser tests.
 *
 * This server has NO dependency on Firebird or node-firebird-driver-native.
 * It exists solely to serve the WASM build artifacts to Playwright-controlled
 * browsers during e2e testing.
 *
 * Routes:
 *   GET /health                        → { status: 'ok' }
 *   GET /wasm/firebird-embedded.js     → Emscripten JS glue (text/javascript)
 *   GET /wasm/firebird-embedded.wasm   → WASM binary (application/wasm)
 *   GET /wasm-test                     → HTML test harness page
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

// WASM artifacts produced by `npm run build:wasm` + `npm run build`
const WASM_DIR = path.resolve(
  __dirname,
  '../../../packages/firebird-wasm/dist/wasm',
);
const WASM_JS   = path.join(WASM_DIR, 'firebird-embedded.js');
const WASM_BIN  = path.join(WASM_DIR, 'firebird-embedded.wasm');

// ---------------------------------------------------------------------------
// In-page test harness
// ---------------------------------------------------------------------------

/**
 * Minimal HTML page that loads the Emscripten module and exercises the C API.
 * Results are written to element data attributes so Playwright can read them
 * with simple DOM assertions.
 *
 * Expected data attributes on #result when complete:
 *   data-done="true"         – all steps finished without exception
 *   data-init-rc="0"         – _fb_init() returned 0
 *   data-query-json="…"      – JSON string from _fb_query()
 *   data-error="…"           – set only if an exception was thrown
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
      try {
        if (typeof createFirebirdModule !== 'function') {
          throw new Error('createFirebirdModule is not defined');
        }

        const mod = await createFirebirdModule();

        // _fb_init
        const initRc = mod._fb_init();
        el.dataset.initRc = String(initRc);

        // _fb_query — allocate a SQL string on the WASM heap
        const sql = 'SELECT 1 FROM RDB\\$DATABASE';
        const len = mod.lengthBytesUTF8(sql) + 1;
        const sqlPtr = mod._malloc(len);
        mod.stringToUTF8(sql, sqlPtr, len);
        const resultPtr = mod._fb_query(0, sqlPtr);
        mod._free(sqlPtr);

        if (resultPtr === 0) {
          throw new Error('_fb_query returned null pointer');
        }
        const queryJson = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);
        el.dataset.queryJson = queryJson;

        // Mark success
        el.dataset.done = 'true';
      } catch (err) {
        el.dataset.error = err instanceof Error ? err.message : String(err);
      }
    })();
  </script>
</body>
</html>`;

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

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { status: 'ok' });
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
