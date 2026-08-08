/**
 * wasm.spec.ts – Playwright browser e2e tests for the Firebird WASM artifact.
 *
 * Unlike `browser-api.spec.ts`, which exercises the TypeScript layer against a
 * stub C ABI, this suite drives the **real compiled engine**.  It is therefore
 * skipped until the artifact exists — run `npm run build:wasm` (from the
 * `packages/firebird-wasm` package) followed by `npm run build` to enable it.
 *
 * The engine runs inside a Web Worker.  That is not a testing convenience: the
 * build uses pthreads, Firebird blocks on mutexes while opening a database,
 * and a browser main thread is not allowed to block.  A main-thread harness
 * deadlocks, so the only meaningful browser configuration is the one tested
 * here.  Emscripten's pthreads also need SharedArrayBuffer, hence the
 * cross-origin isolation assertion and the COOP/COEP headers the test server
 * sets.
 *
 * The assertions deliberately check *data*, not just return codes: while the
 * C API was stubbed, `_fb_init()` returned 0 and `_fb_query()` returned a
 * well-formed empty result set, so a shape-only check could not tell a working
 * engine from a stub.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WASM_JS = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm/firebird-embedded.js',
);
const wasmAvailable = fs.existsSync(WASM_JS);

test.describe('Firebird WASM engine (browser / Playwright)', () => {
  // Skip the entire suite when the WASM binary has not been built.
  test.skip(!wasmAvailable, 'WASM binary not built – run npm run build:wasm first');

  // ── Engine inside a Web Worker ──────────────────────────────────────────
  //
  // This is the configuration a browser actually has to use, and unlike the
  // main-thread tests above it can pass: a Worker may block on a mutex.

  test('runs a full create → insert → select round-trip inside a Worker', async ({
    page,
  }) => {
    await page.goto('/wasm-worker-test');

    const resultEl = page.locator('#result');

    // Cross-origin isolation is a precondition for SharedArrayBuffer, which
    // Emscripten's pthreads need.  Assert it explicitly: without it the module
    // fails to instantiate and every later assertion would be a red herring.
    await expect(resultEl).toHaveAttribute('data-isolated', 'true');

    await expect(resultEl).toHaveAttribute('data-done', 'true', {
      timeout: 120_000,
    });

    expect(await resultEl.getAttribute('data-error')).toBeNull();

    // A real attachment handle from the engine.
    expect(Number(await resultEl.getAttribute('data-db-handle'))).toBeGreaterThan(0);

    const queryResult = JSON.parse(
      (await resultEl.getAttribute('data-query-json')) as string,
    ) as { columns: string[]; rows: unknown[][] };

    expect(queryResult.columns).toEqual(['ID', 'NAME']);
    expect(queryResult.rows).toEqual([
      [1, 'alpha'],
      [2, 'beta'],
    ]);

    // The engine wrote a real database into Emscripten's filesystem.
    expect(Number(await resultEl.getAttribute('data-db-bytes'))).toBeGreaterThan(0);
  });

  test('WASM JS and binary are served with correct MIME types', async ({
    page,
  }) => {
    // Verify the static files are reachable with expected content types.
    const jsResponse = await page.request.get('/wasm/firebird-embedded.js');
    expect(jsResponse.status()).toBe(200);
    expect(jsResponse.headers()['content-type']).toContain('javascript');

    const wasmResponse = await page.request.get('/wasm/firebird-embedded.wasm');
    expect(wasmResponse.status()).toBe(200);
    expect(wasmResponse.headers()['content-type']).toContain('wasm');
  });
});
