/**
 * browser-repl.spec.ts – the <firebird-repl> element (firebird-wasm/repl)
 * driven by the keyboard, against the real engine.
 *
 * The build without threads on the page thread, as in
 * browser-frameworks.spec.ts, whose harness and bundle this shares.
 */

import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ST_JS = path.resolve(__dirname, '../../packages/firebird-wasm/dist/wasm/firebird-embedded-st.js');
const stAvailable = fs.existsSync(ST_JS);

/* eslint-disable @typescript-eslint/no-explicit-any */

async function openRepl(page: Page, name: string): Promise<Locator> {
  await page.goto('/no-isolation/browser-harness-frameworks-st');
  await page.waitForFunction(() => Boolean((window as any).FB && (window as any).Frameworks));
  await page.evaluate((dbName) => {
    const w = window as any;
    w.Frameworks.FBRepl.defineFirebirdRepl();
    const repl = document.createElement('firebird-repl') as any;
    repl.db = new w.FB.FirebirdBrowser(dbName);
    w.runs = [];
    repl.addEventListener('firebird-repl-run', (e: CustomEvent) => w.runs.push(e.detail.length));
    document.getElementById('app')!.replaceChildren(repl);
  }, name);
  return page.locator('firebird-repl');
}

/** Type `sql` into the editor and run it with Ctrl+Enter. */
async function runTyped(repl: Locator, sql: string): Promise<void> {
  const editor = repl.locator('textarea');
  await editor.fill(sql);
  await editor.press('Control+Enter');
}

test.describe('<firebird-repl>', () => {
  test.skip(!stAvailable, 'firebird-embedded-st not built – run npm run build:wasm first');
  test.setTimeout(120_000);

  test('runs a script statement by statement, and shows rows as a table', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-script');
    await runTyped(repl, [
      'CREATE TABLE t (id INTEGER, name VARCHAR(20), note VARCHAR(20));',
      "INSERT INTO t VALUES (1, 'alpha', NULL);",
      "INSERT INTO t VALUES (2, 'beta', 'b');",
      'SELECT id, name, note FROM t ORDER BY id;',
    ].join('\n'));

    await expect(repl.locator('.entry')).toHaveCount(4);
    await expect(repl.locator('.entry .meta').nth(0)).toContainText('done');
    await expect(repl.locator('.entry .meta').nth(1)).toContainText('1 row affected');
    await expect(repl.locator('.entry .meta').nth(3)).toContainText('2 rows');
    await expect(repl.locator('th')).toHaveText(['ID', 'NAME', 'NOTE']);
    await expect(repl.locator('tbody tr')).toHaveCount(2);
    await expect(repl.locator('tbody tr').nth(0).locator('td')).toHaveText(['1', 'alpha', 'NULL']);
    await expect(repl.locator('td.null')).toHaveCount(1);
    // The editor empties once its text has run.
    await expect(repl.locator('textarea')).toHaveValue('');
  });

  test('stops a script at its first error, and shows it', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-error');
    await runTyped(repl, 'CREATE TABLE t (id INTEGER);\nSELECT * FROM missing;\nINSERT INTO t VALUES (1);');

    await expect(repl.locator('.entry')).toHaveCount(2);
    await expect(repl.locator('.error')).toContainText(/MISSING/i);

    // The INSERT after the error never ran.
    const rows = await repl.evaluate(async (el: any) => (await el.run('SELECT COUNT(*) FROM t'))[0].rows);
    expect(rows).toEqual([[0]]);
  });

  test('runs PSQL written with SET TERM', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-psql');
    await runTyped(repl, [
      'SET TERM ^ ;',
      'CREATE PROCEDURE twice (n INTEGER) RETURNS (r INTEGER) AS',
      'BEGIN',
      '  r = n * 2;',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
      'SELECT r FROM twice(21);',
    ].join('\n'));

    await expect(repl.locator('.entry')).toHaveCount(2);
    await expect(repl.locator('tbody td')).toHaveText(['42']);
  });

  test('walks the history with ArrowUp and ArrowDown', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-history');
    const editor = repl.locator('textarea');
    // Each run finished before the next is typed: a Ctrl+Enter while one is
    // running is ignored, and its text stays in the editor.
    await runTyped(repl, 'SELECT 1 FROM RDB$DATABASE');
    await expect(repl.locator('.entry')).toHaveCount(1);
    await runTyped(repl, 'SELECT 2 FROM RDB$DATABASE');
    await expect(repl.locator('.entry')).toHaveCount(2);

    await editor.fill('draft');
    await editor.press('ArrowUp');
    await expect(editor).toHaveValue('SELECT 2 FROM RDB$DATABASE');
    await editor.press('ArrowUp');
    await expect(editor).toHaveValue('SELECT 1 FROM RDB$DATABASE');
    await editor.press('ArrowDown');
    await editor.press('ArrowDown');
    await expect(editor).toHaveValue('draft');
  });

  test('writes values as text: markup in a row stays markup', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-markup');
    const payload = '<img src=x onerror="window.injected=1">';
    await repl.evaluate(async (el: any, value) => {
      await el.db.exec('CREATE TABLE t (v VARCHAR(100))');
      await el.db.exec('INSERT INTO t VALUES (?)', [value]);
    }, payload);
    await runTyped(repl, 'SELECT v FROM t');

    await expect(repl.locator('tbody td')).toHaveText([payload]);
    await expect(repl.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  });

  test('takes a db property set before it was defined, and reports runs', async ({ page }) => {
    await page.goto('/no-isolation/browser-harness-frameworks-st');
    await page.waitForFunction(() => Boolean((window as any).FB && (window as any).Frameworks));
    const outcome = await page.evaluate(async () => {
      const w = window as any;
      // As a framework renders: the element, then its property, then the definition.
      const repl = document.createElement('firebird-early') as any;
      repl.db = new w.FB.FirebirdBrowser('memory://repl-early');
      document.getElementById('app')!.replaceChildren(repl);
      w.Frameworks.FBRepl.defineFirebirdRepl('firebird-early');
      let reported = 0;
      repl.addEventListener('firebird-repl-run', (e: CustomEvent) => { reported = e.detail.length; });
      const entries = await repl.run('SELECT 1 AS one FROM RDB$DATABASE');
      return { rows: entries[0].rows, error: entries[0].error?.message, reported };
    });
    expect(outcome).toEqual({ rows: [[1]], error: undefined, reported: 1 });
  });
});
