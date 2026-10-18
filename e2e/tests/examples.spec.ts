/**
 * examples.spec.ts – the example apps, as their bundlers built them.
 *
 * Each runs the integration guide's first example (create a table, insert
 * with a parameter, read it back) in its engine Worker. Served with COOP/COEP
 * it must run on the threaded engine, without them on the build without
 * threads; either way the rows must come back.
 */

import { test, expect } from '@playwright/test';

const CASES = [
  { example: 'vite', port: 4180, isolated: true },
  { example: 'vite', port: 4181, isolated: false },
  { example: 'webpack', port: 4182, isolated: true },
  { example: 'webpack', port: 4183, isolated: false },
];

for (const { example, port, isolated } of CASES) {
  test(`${example}, ${isolated ? 'isolated: the threaded engine' : 'not isolated: the build without threads'}`, async ({ page }) => {
    test.setTimeout(120_000);
    const loaded: string[] = [];
    page.on('request', (r) => {
      const name = new URL(r.url()).pathname.slice(1);
      if (name.startsWith('firebird-embedded')) loaded.push(name);
    });

    await page.goto(`http://localhost:${port}/`);
    const result = page.locator('#result');
    await expect(result).toHaveAttribute('data-done', 'true', { timeout: 90_000 }).catch(async (e) => {
      throw new Error(`${await result.getAttribute('data-error') ?? 'no result'} (${(e as Error).message})`);
    });

    expect(JSON.parse((await result.getAttribute('data-rows'))!)).toEqual([{ ID: 1, TITLE: 'Hello' }]);
    expect(await result.getAttribute('data-engine')).toMatch(/^\d+\.\d+/);
    expect(await result.getAttribute('data-isolated')).toBe(String(isolated));
    expect(loaded).toContain(isolated ? 'firebird-embedded.wasm' : 'firebird-embedded-st.wasm');
    expect(loaded).not.toContain(isolated ? 'firebird-embedded-st.wasm' : 'firebird-embedded.wasm');
  });
}
