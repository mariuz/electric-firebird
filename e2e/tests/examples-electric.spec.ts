/**
 * examples-electric.spec.ts – examples/electric, built by Vite, against a
 * real Postgres with Electric and a real Firebird server.
 *
 * The page syncs each server's `notes` into a table of its own in the
 * browser engine and writes only through the example server's API, so every
 * row on screen made the round trip: source, shape, local table, live query.
 * Needs the services (CI starts them; see build-wasm.yml):
 *   ELECTRIC_URL, PG_URL, FIREBIRD_SHAPES_HOST, FIREBIRD_SHAPES_PASSWORD
 * and skips without them. playwright.examples.config.ts starts the server.
 */

import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ELECTRIC_EXAMPLE_PORTS, electricExampleConfigured } from '../electric-example';

const SOURCES = ['pg', 'fb'] as const;

const section = (page: Page, source: string) => page.locator(`[data-source="${source}"]`);
const note = (list: Locator, title: string) => list.locator(`li[data-title="${title}"]`);

async function open(page: Page, port: number) {
  await page.goto(`http://localhost:${port}/`);
  await expect(page.locator('#engine')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 }).catch(async (e) => {
    throw new Error(`${await page.locator('#engine').getAttribute('data-error') ?? 'not ready'} (${(e as Error).message})`);
  });
  for (const source of SOURCES) {
    await expect(section(page, source).locator('[data-status]')).toHaveAttribute('data-state', 'live', { timeout: 30_000 });
  }
}

test.describe('examples/electric', () => {
  test.skip(!electricExampleConfigured, 'ELECTRIC_URL, PG_URL, FIREBIRD_SHAPES_HOST and FIREBIRD_SHAPES_PASSWORD not set');

  for (const { port, isolated } of ELECTRIC_EXAMPLE_PORTS) {
    test(`both sources round-trip through the local engine (${isolated ? 'threaded' : 'without threads'})`, async ({ page }) => {
      test.setTimeout(180_000);
      const stamp = `${isolated ? 'iso' : 'st'}-${Date.now()}`;
      await open(page, port);
      expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(isolated);

      for (const source of SOURCES) {
        const list = section(page, source).locator('[data-list]');

        // Through the page's form: the server writes, the shape brings it back.
        const typed = `typed ${source} ${stamp}`;
        await section(page, source).locator('input[name="title"]').fill(typed);
        await section(page, source).locator('button', { hasText: 'Add' }).click();
        await expect(note(list, typed)).toHaveCount(1, { timeout: 20_000 });

        // Written at the source by someone else: it arrives all the same.
        const other = `elsewhere ${source} ${stamp}`;
        const response = await page.request.post(`http://localhost:${port}/api/${source}/notes`, { data: { title: other } });
        expect(response.ok()).toBe(true);
        await expect(note(list, other)).toHaveCount(1, { timeout: 20_000 });

        await note(list, typed).locator('button[data-action="toggle"]').click();
        await expect(note(list, typed)).toHaveAttribute('data-done', 'true', { timeout: 20_000 });
        await note(list, other).locator('button[data-action="delete"]').click();
        await expect(note(list, other)).toHaveCount(0, { timeout: 20_000 });
      }

      // The local copy is persisted with its position: after a reload the
      // rows are there and the sync goes on from where it was.
      await page.reload();
      await open(page, port);
      for (const source of SOURCES) {
        const list = section(page, source).locator('[data-list]');
        await expect(note(list, `typed ${source} ${stamp}`)).toHaveAttribute('data-done', 'true');
        const after = `after reload ${source} ${stamp}`;
        await page.request.post(`http://localhost:${port}/api/${source}/notes`, { data: { title: after } });
        await expect(note(list, after)).toHaveCount(1, { timeout: 20_000 });
      }

      // And the REPL reads the same database.
      const repl = page.locator('firebird-repl');
      await repl.locator('textarea').fill(`SELECT COUNT(*) FROM fb_notes WHERE title = 'typed fb ${stamp}'`);
      await repl.locator('button', { hasText: 'Run' }).click();
      await expect(repl.locator('tbody td')).toHaveText(['1'], { timeout: 20_000 });
    });
  }
});
