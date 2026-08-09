/**
 * demo.spec.ts – the published demo site, served the way GitHub Pages serves it.
 *
 * The server behind this config sends no COOP/COEP headers, so the page is not
 * cross-origin isolated when it first loads and `SharedArrayBuffer` is
 * withheld.  Everything here therefore depends on the demo's service worker
 * re-issuing responses with the headers attached and the page reloading once
 * into isolation.  If that mechanism breaks, these tests fail — which is the
 * whole reason for testing the site rather than the library it uses.
 *
 * The engine is the real compiled artifact, so the suite skips without it.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const WASM_BIN = path.resolve(
  __dirname,
  '../../packages/firebird-wasm/dist/wasm/firebird-embedded.wasm',
);
const wasmAvailable = fs.existsSync(WASM_BIN);

/** Creating a database is slow: the engine writes the whole system catalogue. */
const BOOT_TIMEOUT = 180_000;

/**
 * Load the demo and wait for the engine to be ready.
 *
 * The first visit registers the service worker and reloads itself, so this
 * waits for the state the second load reaches rather than for navigation.
 */
async function openDemo(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', {
    timeout: BOOT_TIMEOUT,
  });
}

/** Click an example in the sidebar and run it. */
async function runExample(page: Page, id: string): Promise<void> {
  await page.locator(`.example[data-id="${id}"]`).click();
  await page.locator('#run').click();
  // The status returns to "ready" only after the run settles, whether it
  // succeeded or failed — so waiting on it cannot mask an error.
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', {
    timeout: BOOT_TIMEOUT,
  });
}

/** Fail loudly with the engine's message rather than a bare timeout. */
async function expectNoError(page: Page): Promise<void> {
  // allTextContents() resolves against whatever is there now.  textContent()
  // waits for the locator, so it can hang for the full timeout on an element
  // that was re-rendered between the count and the read.
  const messages = await page.locator('.message.error').allTextContents();
  if (messages.length > 0) {
    throw new Error(`demo reported an error: ${messages.join(' / ')}`);
  }
}

/** The rendered result table, as `{ columns, rows }`. */
async function readTable(
  page: Page,
): Promise<{ columns: string[]; rows: string[][] }> {
  await expectNoError(page);
  await expect(page.locator('#result table')).toBeVisible();

  return page.evaluate(() => {
    const table = document.querySelector('#result table')!;
    const columns = Array.from(table.querySelectorAll('thead th')).map(
      // The header carries a type caption in a child span; take only the name.
      (th) => (th.childNodes[0]?.textContent ?? '').trim(),
    );
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? ''),
    );
    return { columns, rows };
  });
}

test.describe('Demo site', () => {
  test.skip(!wasmAvailable, 'WASM binary not built – run npm run build:wasm first');

  test('becomes cross-origin isolated on a host that sends no COOP/COEP', async ({
    page,
  }) => {
    // Prove the premise before relying on it: if the test server started
    // sending the headers itself, every other test here would pass without
    // the service worker doing anything.
    const response = await page.request.get('/');
    expect(response.headers()['cross-origin-opener-policy']).toBeUndefined();
    expect(response.headers()['cross-origin-embedder-policy']).toBeUndefined();

    await openDemo(page);

    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
  });

  test('reports the engine version it is actually running', async ({ page }) => {
    await openDemo(page);

    // Not a fixed string: this reads whatever the compiled engine reports, so
    // it keeps working across Firebird versions while still proving the query
    // reached a real engine rather than a stub.
    const status = await page.locator('#status-text').textContent();
    expect(status).toMatch(/^Firebird \d+\.\d+/);
  });

  test('creates the schema and seeds it', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await expectNoError(page);

    // 2 RECREATEs + 3 departments + 8 employees.
    await expect(page.locator('.message.ok')).toContainText('13 statements');
    await expect(page.locator('.message.ok')).toContainText('11 rows affected');
  });

  test('runs the schema example twice without failing', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');

    // Visitors will click it again.  RECREATE rather than CREATE is what makes
    // that work, so pin it: a switch to CREATE TABLE breaks here, not in
    // someone's browser.
    await runExample(page, 'schema');
    await expectNoError(page);
  });

  test('filters and sorts', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await runExample(page, 'filter');

    const { columns, rows } = await readTable(page);
    expect(columns).toEqual(['NAME', 'SALARY', 'HIRED']);
    expect(rows.map((r) => r[0])).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Alan Turing',
      'Radia Perlman',
      'Susan Kare',
    ]);
    // Dates arrive as ISO-8601, salaries as exact decimals.
    expect(rows[0]![1]).toBe('148000.00');
    expect(rows[0]![2]).toContain('2016-03-01');
  });

  test('joins and aggregates', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await runExample(page, 'join');

    const { columns, rows } = await readTable(page);
    expect(columns).toEqual(['DEPARTMENT', 'HEADCOUNT', 'PAYROLL', 'AVERAGE']);

    // HAVING COUNT(*) > 1 drops nothing here — all three departments qualify.
    expect(rows).toHaveLength(3);
    expect(rows[0]![0]).toBe('Engineering');
    expect(rows[0]![1]).toBe('4');
    expect(rows[0]![2]).toBe('500250.75');
  });

  test('binds parameters instead of concatenating them', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await runExample(page, 'params');

    const { rows } = await readTable(page);
    expect(rows.map((r) => r[0])).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Alan Turing',
    ]);

    // Change a bound value and the result set changes with it — the query text
    // is untouched, which is the point of the example.
    await page.locator('#params').fill('[2, 0]');
    await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready');

    const second = await readTable(page);
    expect(second.rows.map((r) => r[0])).toEqual(['Susan Kare', 'Paul Rand']);
  });

  test('keeps numbers exact that a double could not hold', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'numbers');

    const { columns, rows } = await readTable(page);
    expect(columns).toEqual([
      'BEYOND_DOUBLE',
      'EXACT_DECIMAL',
      'ONE_THIRD',
      'TENTH_PLUS_FIFTH',
    ]);

    // 9007199254740993 is 2^53 + 1: a JavaScript number rounds it to
    // ...992.  Arriving as a string is what keeps it intact, and this
    // assertion is the reason the example exists.
    expect(rows[0]![0]).toBe('9007199254740993');
    expect(rows[0]![1]).toBe('123456789.12345678');
    expect(rows[0]![2]).toBe('0.33333333');
    // 0.1 + 0.2 in DECFLOAT is 0.3 exactly, unlike binary floating point.
    expect(rows[0]![3]).toBe('0.3');
  });

  test('shows the column type, not just the column name', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'numbers');

    // Without this caption an exact NUMERIC rendered as "123456789.12345678"
    // is indistinguishable from a VARCHAR holding the same characters.
    const captions = await page.locator('#result thead .coltype').allTextContents();
    expect(captions[0]).toBe('BIGINT');
    expect(captions[1]).toContain('NUMERIC');
  });

  test('walks a recursive CTE', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await runExample(page, 'recursive');

    const { rows } = await readTable(page);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual(['1', 'Ada Lovelace']); // the only one with no manager
    // Depth 3 is reached only by following the chain twice: each of these
    // reports to someone who reports to Ada.
    expect(rows.filter((r) => r[0] === '3').map((r) => r[1]).sort()).toEqual([
      'Katherine Johnson',
      'Paul Rand',
      'Radia Perlman',
    ]);
  });

  test('runs PSQL through EXECUTE BLOCK', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'psql');

    const { columns, rows } = await readTable(page);
    expect(columns).toEqual(['N', 'FIBONACCI']);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual(['0', '0']);
    expect(rows[19]).toEqual(['19', '4181']);
  });

  test('reads the system catalogue', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await runExample(page, 'catalogue');

    const { rows } = await readTable(page);
    const tables = rows.map((r) => r[0]);
    expect(tables).toContain('DEPARTMENTS');
    expect(tables).toContain('EMPLOYEES');
    expect(rows.find((r) => r[0] === 'EMPLOYEES')?.[1]).toBe('6');
  });

  test('rolls a transaction back', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await runExample(page, 'rollback');

    const { rows } = await readTable(page);
    const steps = Object.fromEntries(rows.map((r) => [r[0], r[1]]));

    // The delete is visible inside the transaction and gone after it: the
    // rollback undid real work rather than never having done any.
    expect(steps['inside the transaction']).toBe('0');
    expect(steps['before']).toBe('8');
    expect(steps['after rollback']).toBe('8');
  });

  test('reports a SQL error without breaking the page', async ({ page }) => {
    await openDemo(page);

    await page.locator('#sql').fill('SELECT * FROM no_such_table');
    await page.locator('#run').click();
    await expect(page.locator('.message.error')).toBeVisible();
    await expect(page.locator('.message.error')).toContainText(/NO_SUCH_TABLE/i);

    // Still usable afterwards — an error must not leave the engine wedged.
    await page.locator('#sql').fill("SELECT 1 AS one FROM RDB$DATABASE");
    await page.locator('#run').click();
    const { rows } = await readTable(page);
    expect(rows).toEqual([['1']]);
  });

  test('survives a reload, because the database is in IndexedDB', async ({
    page,
  }) => {
    await openDemo(page);
    await runExample(page, 'schema');

    // Auto-persist is on a debounce; a reload during that window would be
    // testing the timer rather than the persistence.
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', {
      timeout: BOOT_TIMEOUT,
    });

    // Not the schema example: the data has to have come from IndexedDB.
    await runExample(page, 'filter');
    const { rows } = await readTable(page);
    expect(rows).toHaveLength(5);
    expect(rows[0]![0]).toBe('Ada Lovelace');
  });

  test('deletes the database when asked', async ({ page }) => {
    await openDemo(page);
    await runExample(page, 'schema');
    await page.waitForTimeout(1500);

    await page.locator('#reset').click();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', {
      timeout: BOOT_TIMEOUT,
    });

    // The tables are gone, so the query that worked a moment ago now fails.
    await runExample(page, 'filter');
    await expect(page.locator('.message.error')).toContainText(/EMPLOYEES/i);
  });
});
