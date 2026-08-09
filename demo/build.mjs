/**
 * build.mjs – assemble the static demo site into `demo/dist`.
 *
 * Everything is relative.  GitHub Pages serves a project site from
 * `/<repo>/`, not from the domain root, so an absolute `/firebird-embedded.wasm`
 * would 404 there while working perfectly in local testing — the classic way
 * to ship a broken Pages deploy.
 *
 * Usage:
 *   node demo/build.mjs            # build
 *   node demo/build.mjs --serve    # build, then serve it with NO COOP/COEP
 *                                  # headers, which is what Pages does
 */

import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const OUT = path.join(here, 'dist');
const PUBLIC = path.join(here, 'public');
const PKG = path.join(root, 'packages/firebird-wasm');
const WASM_DIR = path.join(PKG, 'dist/wasm');

const BROWSER_ENTRY = path.join(PKG, 'src/browser/index.ts');
const WORKER_ENTRY = path.join(PKG, 'src/browser/worker-entry.ts');

/**
 * wasm-loader.ts has a Node branch that require()s the Emscripten glue.  A
 * browser never takes it — it looks for `createFirebirdModule` on globalThis —
 * but esbuild resolves string-literal requires eagerly, which would drag the
 * glue's node:fs / node:crypto imports into the bundle and fail the build.
 */
const EXTERNAL = ['*firebird-embedded.js'];

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ── The library, as an ES module ────────────────────────────────────────
  await build({
    entryPoints: [BROWSER_ENTRY],
    outfile: path.join(OUT, 'firebird-browser.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    external: EXTERNAL,
  });

  // ── The engine Worker ───────────────────────────────────────────────────
  const workerBundle = await build({
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    external: EXTERNAL,
  });

  // `self.location` inside a Worker is the worker script's own URL, so
  // resolving against it keeps the site working under any path prefix —
  // including the `/<repo>/` one that Pages serves a project site from.
  const prelude = [
    "importScripts(new URL('./firebird-embedded.js', self.location.href).href);",
    'self.FIREBIRD_WORKER_OPTIONS = {',
    "  locateFile: (file) => new URL(file, self.location.href).href,",
    '};',
    '',
  ].join('\n');

  fs.writeFileSync(
    path.join(OUT, 'firebird-engine-worker.js'),
    prelude + workerBundle.outputFiles[0].text,
  );

  // ── The compiled engine ─────────────────────────────────────────────────
  const artifacts = ['firebird-embedded.js', 'firebird-embedded.wasm'];
  const missing = artifacts.filter((f) => !fs.existsSync(path.join(WASM_DIR, f)));
  if (missing.length > 0) {
    // Fail loudly.  A site that builds fine and then 404s the engine at
    // runtime is far harder to diagnose than a build that stops here.
    throw new Error(
      `Missing WASM artifact(s): ${missing.join(', ')}\n` +
        `Expected in ${WASM_DIR}\n` +
        `Build them first:  npm run build:wasm -w packages/firebird-wasm`,
    );
  }
  for (const file of artifacts) {
    fs.copyFileSync(path.join(WASM_DIR, file), path.join(OUT, file));
  }

  // ── Static files ────────────────────────────────────────────────────────
  for (const file of fs.readdirSync(PUBLIC)) {
    fs.copyFileSync(path.join(PUBLIC, file), path.join(OUT, file));
  }

  // Pages runs the site through Jekyll by default, which skips files and
  // directories beginning with an underscore.  Nothing here starts with one
  // today, but the failure mode is a silently missing asset, so opt out.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  const total = fs
    .readdirSync(OUT)
    .reduce((sum, f) => sum + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(
    `demo site → ${path.relative(process.cwd(), OUT)} ` +
      `(${(total / 1024 / 1024).toFixed(1)} MB)`,
  );
}

// ---------------------------------------------------------------------------
// Optional local server
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve `dist` the way GitHub Pages does — notably **without** COOP/COEP.
 *
 * That is the point of this server rather than any off-the-shelf one: it
 * proves the service worker is what supplies cross-origin isolation.  A dev
 * server that helpfully sets the headers would make the demo work locally and
 * fail on Pages, which is the bug worth catching.
 */
function serve(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let file = path.join(OUT, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname.endsWith('/')) {
      file = path.join(file, 'index.html');
    }

    // Refuse to serve outside the output directory.
    if (!path.resolve(file).startsWith(path.resolve(OUT))) {
      res.writeHead(403).end('forbidden');
      return;
    }

    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      // Service workers are only allowed to control a scope the server permits,
      // and Pages sets no restriction either.
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, () => {
    console.log(`demo on http://localhost:${port}/  (no COOP/COEP, as on Pages)`);
  });
}

await main();

if (process.argv.includes('--serve')) {
  serve(Number(process.env.PORT ?? 4173));
}
