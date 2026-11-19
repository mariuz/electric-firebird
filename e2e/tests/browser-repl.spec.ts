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

  test('explains queries with the Explain button and repl.explain() without executing them', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-explain');
    await runTyped(repl, [
      'CREATE TABLE items (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(20));',
      "INSERT INTO items VALUES (1, 'alpha');",
    ].join('\n'));
    await expect(repl.locator('.entry')).toHaveCount(2);

    const editor = repl.locator('textarea');
    await editor.fill("SELECT id, name FROM items WHERE id = 1;\nINSERT INTO items VALUES (2, 'beta');");
    await repl.locator('button.explain').click();

    await expect(repl.locator('.entry')).toHaveCount(4);
    await expect(repl.locator('.entry .plan').nth(0)).toContainText(/PLAN\s*\(.*ITEMS"?\s+INDEX/i);
    await expect(repl.locator('.entry .meta').nth(2)).toContainText('plan');

    // Detailed plan via repl.explain(script, { detailed: true })
    const detailed = await repl.evaluate(async (el: any) => {
      const entries = await el.explain('SELECT id, name FROM items', { detailed: true });
      return entries[0].plan;
    });
    expect(detailed).toMatch(/Select Expression/i);
    expect(detailed).toMatch(/ITEMS/i);

    // Explaining INSERT INTO items VALUES (2, 'beta') did not insert row 2
    const rows = await repl.evaluate(async (el: any) => (await el.run('SELECT COUNT(*) FROM items'))[0].rows);
    expect(rows).toEqual([[1]]);
  });

  test('inspects database diagnostics with the Info button and repl.info()', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-info');
    await runTyped(repl, 'CREATE TABLE info_test (id INTEGER)');
    await expect(repl.locator('.entry')).toHaveCount(1);

    await repl.locator('button.info').click();
    await expect(repl.locator('.entry')).toHaveCount(2);
    await expect(repl.locator('.entry .meta').nth(1)).toContainText('info');
    await expect(repl.locator('.entry').nth(1).locator('tbody')).toContainText('Page size');
    await expect(repl.locator('.entry').nth(1).locator('tbody')).toContainText('8192');
    await expect(repl.locator('.entry').nth(1).locator('tbody')).toContainText('Oldest active (OAT)');

    const info = await repl.evaluate(async (el: any) => (await el.info()).info);
    expect(info.pageSize).toBe(8192);
    expect(info.allocatedPages).toBeGreaterThan(0);
    expect(info.databaseSizeBytes).toBe(info.pageSize * info.allocatedPages);
  });

  test('sweeps the database with the Sweep button and repl.sweep()', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-sweep');
    await runTyped(repl, [
      'CREATE TABLE sweep_test (id INTEGER NOT NULL PRIMARY KEY, val VARCHAR(40));',
      "INSERT INTO sweep_test VALUES (1, 'v1');",
      "UPDATE sweep_test SET val = 'v2' WHERE id = 1;",
    ].join('\n'));
    await expect(repl.locator('.entry')).toHaveCount(3);

    await repl.locator('button.sweep').click();
    await expect(repl.locator('.entry')).toHaveCount(4);
    await expect(repl.locator('.entry .meta').nth(3)).toContainText('sweep');
    await expect(repl.locator('.entry').nth(3).locator('tbody')).toContainText('Tables scanned');
    await expect(repl.locator('.entry').nth(3).locator('tbody')).toContainText('OIT (before → after)');

    const sweep = await repl.evaluate(async (el: any) => (await el.sweep()).sweep);
    expect(sweep.tablesScanned).toBeGreaterThanOrEqual(1);
    expect(sweep.after.pageSize).toBe(8192);
    expect(sweep.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('opens the interactive Schema Inspector & Migration Viewer with Schema and Migrations buttons', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-schema-inspector');
    await repl.evaluate(async (el: any) => {
      await el.db.migrate([
        {
          version: 1,
          name: 'create_authors',
          up: 'CREATE TABLE authors (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(60) NOT NULL)',
        },
        {
          version: 2,
          name: 'add_author_idx',
          up: 'CREATE INDEX idx_authors_name ON authors (name)',
        },
      ]);
    });

    await repl.locator('button.schema').click();
    await expect(repl.locator('.inspector')).toBeVisible();
    await expect(repl.locator('.inspector .schema-table-name')).toHaveText(['AUTHORS']);
    await expect(repl.locator('.inspector .schema-indexes')).toContainText('IDX_AUTHORS_NAME');

    await repl.locator('.inspector button.schema-query-btn').click();
    await expect(repl.locator('textarea')).toHaveValue('SELECT * FROM AUTHORS;');

    await repl.locator('button.migrations').click();
    await expect(repl.locator('.inspector .inspector-migrations')).toContainText('Current version: 2 · 2 applied');
    await expect(repl.locator('.inspector .migration-item')).toHaveCount(2);
    await expect(repl.locator('.inspector .migration-item').nth(0)).toContainText('create_authors');
    await expect(repl.locator('.inspector .migration-item').nth(1)).toContainText('add_author_idx');
  });

  test('inspects Arrow IPC vector layouts and live sync status with the Arrow button, repl.inspectArrow(), and repl.syncHandle', async ({ page }) => {
    const repl = await openRepl(page, 'memory://repl-arrow-sync');
    await runTyped(repl, [
      'CREATE TABLE metrics (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(30), val DOUBLE PRECISION);',
      "INSERT INTO metrics VALUES (1, 'cpu', 42.5);",
      "INSERT INTO metrics VALUES (2, 'mem', NULL);",
    ].join('\n'));
    await expect(repl.locator('.entry')).toHaveCount(3);

    await repl.evaluate((el: any) => {
      el.syncHandle = {
        mode: 'native',
        stats: async () => ({
          primaryLsn: 18,
          replicaWatermark: 18,
          lagEntries: 0,
          conflictsResolved: 1,
        }),
      };
    });

    const editor = repl.locator('textarea');
    await editor.fill('SELECT id, label, val FROM metrics ORDER BY id');
    await repl.locator('button.arrow').click();

    await expect(repl.locator('.inspector')).toBeVisible();
    await expect(repl.locator('.inspector .inspector-arrow')).toContainText('Apache Arrow IPC V5 & Columnar Vectors');
    await expect(repl.locator('.inspector .inspector-arrow')).toContainText('2 rows · 3 vectors');
    await expect(repl.locator('.inspector .inspector-arrow')).toContainText('int32 (INTEGER)');
    await expect(repl.locator('.inspector .inspector-arrow')).toContainText('float64 (DOUBLE)');
    await expect(repl.locator('.inspector .inspector-arrow')).toContainText('ONLINE (native) · LSN 18/18 · lag 0');
    await expect(repl.locator('.inspector button.arrow-export-btn')).toBeVisible();
    await expect(repl.locator('.inspector button.arrow-import-btn')).toBeVisible();

    // Round-trip Arrow IPC V5 export & zero-copy import into a new table via repl.exportArrow() + repl.importArrow()
    const roundTrip = await repl.evaluate(async (el: any) => {
      const arrowBytes = await el.exportArrow('SELECT id, label, val FROM metrics ORDER BY id');
      const importRes = await el.importArrow('METRICS_COPY', arrowBytes, {
        createTable: true,
        primaryKey: 'ID',
      });
      const entries = await el.run('SELECT id, label, val FROM METRICS_COPY ORDER BY id');
      return {
        exportedBytes: arrowBytes.byteLength,
        rowsIngested: importRes.rowsIngested,
        tableCreated: importRes.tableCreated,
        copiedRows: entries[0].rows,
      };
    });

    expect(roundTrip.exportedBytes).toBeGreaterThan(64);
    expect(roundTrip.rowsIngested).toBe(2);
    expect(roundTrip.tableCreated).toBe(true);
    expect(roundTrip.copiedRows).toEqual([
      [1, 'cpu', 42.5],
      [2, 'mem', null],
    ]);
  });

  test('edits result cells optimistically, renders pending row badges, and inspects/reverts the Outbox', async ({
    page,
  }) => {
    const repl = await openRepl(page, 'memory://repl-outbox');

    await repl.evaluate(async (el: any) => {
      const w = window as any;
      await el.run(
        "CREATE TABLE tasks (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(64)); INSERT INTO tasks VALUES (1, 'Initial Title');",
      );
      el.optimisticStore = w.FB.createOptimisticMutationStore(el.db, {
        persist: true,
      });
      el.editableTable = { table: 'TASKS', primaryKey: 'ID' };
    });

    await repl.evaluate(async (el: any) => {
      await el.editCell('TASKS', 1, 'TITLE', 'Optimistic Edited Title', 'ID');
      await el.run('SELECT id, title FROM tasks ORDER BY id');
    });

    await expect(repl.locator('tr.fb-repl-row-optimistic')).toHaveCount(1);
    await expect(repl.locator('.fb-repl-optimistic-badge')).toContainText('pending');
    await expect(repl.locator('tr.fb-repl-row-optimistic')).toContainText('Optimistic Edited Title');

    await repl.locator('button.outbox').click();
    await expect(repl.locator('.inspector .inspector-outbox')).toContainText('1 pending');
    await expect(repl.locator('.inspector .outbox-item')).toContainText('UPDATE TASKS');

    await repl.locator('.inspector button.outbox-revert-all-btn').click();
    await expect(repl.locator('.inspector .inspector-outbox')).toContainText('0 pending');

    const afterRevert = await repl.evaluate(async (el: any) => {
      const entries = await el.run('SELECT id, title FROM tasks ORDER BY id');
      return entries[0].rows;
    });
    expect(afterRevert).toEqual([[1, 'Initial Title']]);
  });

  test('supports local-first Undo/Redo toolbar controls and inspects/refreshes Materialized Views', async ({
    page,
  }) => {
    const repl = await openRepl(page, 'memory://repl-m24');

    await repl.evaluate(async (el: any) => {
      const w = window as any;
      await el.run(
        "CREATE TABLE tasks (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(64)); INSERT INTO tasks VALUES (1, 'Original');",
      );
      await el.db.createMaterializedView(
        'MV_TASK_COUNT',
        'SELECT CAST(COUNT(*) AS INTEGER) AS TOTAL_TASKS FROM tasks',
        { refreshStrategy: 'manual' },
      );
      const opt = w.FB.createOptimisticMutationStore(el.db);
      el.optimisticStore = opt;
      el.undoRedoManager = w.FB.createUndoRedoManager(el.db, { optimisticStore: opt });
      el.editableTable = { table: 'TASKS', primaryKey: 'ID' };
    });

    await repl.evaluate(async (el: any) => {
      await el.editCell('TASKS', 1, 'TITLE', 'Edited Once', 'ID');
    });

    await expect(repl.locator('button.undo')).toBeEnabled();
    await repl.locator('button.undo').click();
    await expect(repl.locator('button.redo')).toBeEnabled();

    const afterUndo = await repl.evaluate(async (el: any) => {
      const res = await el.run('SELECT id, title FROM tasks WHERE id = 1');
      return res[0].rows;
    });
    expect(afterUndo).toEqual([[1, 'Original']]);

    await repl.locator('button.redo').click();
    const afterRedo = await repl.evaluate(async (el: any) => {
      const res = await el.run('SELECT id, title FROM tasks WHERE id = 1');
      return res[0].rows;
    });
    expect(afterRedo).toEqual([[1, 'Edited Once']]);

    // Insert a second row and refresh Materialized View from Schema Inspector
    await repl.evaluate(async (el: any) => {
      await el.run("INSERT INTO tasks VALUES (2, 'Second Task')");
    });
    await repl.locator('button.schema').click();
    await expect(repl.locator('.inspector .schema-matview')).toContainText('MV_TASK_COUNT');
    await repl.locator('.inspector button.matview-refresh-btn').click();
    await expect(repl.locator('.inspector .schema-matview')).toContainText('1 rows');

    const mvCount = await repl.evaluate(async (el: any) => {
      const res = await el.run('SELECT TOTAL_TASKS FROM MV_TASK_COUNT');
      return res[0].rows;
    });
    expect(mvCount).toEqual([[2]]);
  });

  test('M25: inspects persisted HNSW/BM25 search indexes and previews/applies declarative schema diff in <firebird-repl>', async ({
    page,
  }) => {
    await page.goto('/no-isolation/browser-harness-frameworks-st');
    await page.waitForFunction(() => Boolean((window as any).FB && (window as any).Frameworks));

    const outcome = await page.evaluate(async () => {
      const w = window as any;
      w.Frameworks.FBRepl.defineFirebirdRepl();
      const repl = document.createElement('firebird-repl') as any;
      const db = new w.FB.FirebirdBrowser('memory://repl-m25', { types: { binary: true } });
      repl.db = db;
      document.getElementById('app')!.replaceChildren(repl);

      await db.execute(
        'CREATE TABLE DOCS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(100), EMB VARBINARY(12))',
      );
      await db.execute('INSERT INTO DOCS VALUES (?, ?, ?)', [
        1,
        'Vector FTS Inspector Doc',
        w.FB.encodeVector([1, 0, 0]),
      ]);

      await w.FB.createVectorIndex(db, {
        table: 'DOCS',
        column: 'EMB',
        quantization: 'int8',
        persist: true,
      });
      await w.FB.createFtsIndex(db, {
        table: 'DOCS',
        columns: ['TITLE'],
        persist: true,
      });

      const indexes = await repl.searchIndexes();
      const diffPreview = await repl.previewSchemaDiff(
        'CREATE TABLE DOCS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(100), EMB VARBINARY(12), CATEGORY VARCHAR(32));',
      );
      const inspectorText = repl.shadowRoot?.querySelector('.inspector')?.textContent ?? '';
      await repl.applySchemaPush(
        'CREATE TABLE DOCS (ID INTEGER NOT NULL PRIMARY KEY, TITLE VARCHAR(100), EMB VARBINARY(12), CATEGORY VARCHAR(32));',
      );
      const afterCols = (await db.introspect()).tables[0]?.columns.map((c: any) => c.name);
      await db.close();

      return {
        indexCount: indexes.length,
        previewStatements: diffPreview?.statements ?? [],
        inspectorText,
        afterCols,
      };
    });

    expect(outcome.indexCount).toBe(2);
    expect(outcome.previewStatements.some((s: string) => /ADD CATEGORY/i.test(s))).toBe(true);
    expect(outcome.inspectorText).toContain('Search Indexes (Vector HNSW & BM25 FTS)');
    expect(outcome.inspectorText).toContain('int8');
    expect(outcome.afterCols).toEqual(['ID', 'TITLE', 'EMB', 'CATEGORY']);
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
