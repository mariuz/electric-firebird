/**
 * wasm.spec.ts – Playwright browser e2e tests for the Firebird WASM artifact.
 *
 * The tests are automatically skipped when the WASM binary has not been built
 * yet.  Run `npm run build:wasm` (from the `packages/firebird-wasm` package)
 * followed by `npm run build` before executing these tests.
 *
 * All tests navigate to the `/wasm-test` page served by `wasm-server.ts`,
 * which loads the Emscripten module and exercises the C API.  Results are
 * reported as `data-*` attributes on a DOM element so Playwright can assert
 * on them without relying on console output.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WASM_JS = path.resolve(
  __dirname,
  '../../../packages/firebird-wasm/dist/wasm/firebird-embedded.js',
);
const wasmAvailable = fs.existsSync(WASM_JS);

test.describe('Firebird WASM module (browser / Playwright)', () => {
  // Skip the entire suite when the WASM binary has not been built.
  test.skip(!wasmAvailable, 'WASM binary not built – run npm run build:wasm first');

  test('wasm-test page loads successfully', async ({ page }) => {
    const response = await page.goto('/wasm-test');
    expect(response?.status()).toBe(200);
  });

  test('WASM module initialises and _fb_init() returns 0', async ({ page }) => {
    await page.goto('/wasm-test');

    const resultEl = page.locator('#result');

    // Wait for the async WASM bootstrap to complete (up to 30 s).
    await expect(resultEl).toHaveAttribute('data-done', 'true', {
      timeout: 30_000,
    });

    // No exception should have been thrown.
    expect(await resultEl.getAttribute('data-error')).toBeNull();

    // _fb_init() must return 0 (success).
    expect(await resultEl.getAttribute('data-init-rc')).toBe('0');
  });

  test('_fb_query() returns valid JSON with columns and rows arrays', async ({
    page,
  }) => {
    await page.goto('/wasm-test');

    const resultEl = page.locator('#result');
    await expect(resultEl).toHaveAttribute('data-done', 'true', {
      timeout: 30_000,
    });
    expect(await resultEl.getAttribute('data-error')).toBeNull();

    const queryJsonStr = await resultEl.getAttribute('data-query-json');
    expect(queryJsonStr).not.toBeNull();

    const queryResult = JSON.parse(queryJsonStr as string) as {
      columns: string[];
      rows: unknown[][];
    };
    expect(Array.isArray(queryResult.columns)).toBe(true);
    expect(Array.isArray(queryResult.rows)).toBe(true);
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
