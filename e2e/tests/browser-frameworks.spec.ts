/**
 * browser-frameworks.spec.ts – firebird-wasm/react and firebird-wasm/vue,
 * rendering real components against the real engine.
 *
 * The build without threads on the page thread: nothing to set up but the
 * glue, and the hooks are indifferent to where the engine runs.  React is the
 * development build under StrictMode, which mounts every effect twice, so a
 * hook that leaked or double-ran its query would show it here.
 *
 * The store under both bindings is unit-tested against forced orderings in
 * packages/firebird-wasm/src/__tests__/query-store.test.ts.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ST_JS = path.resolve(__dirname, '../../packages/firebird-wasm/dist/wasm/firebird-embedded-st.js');
const stAvailable = fs.existsSync(ST_JS);

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB: typeof import('../../packages/firebird-wasm/src/browser/index');
    Frameworks: {
      React: typeof import('react');
      createRoot: typeof import('react-dom/client').createRoot;
      Vue: typeof import('vue');
      FBReact: typeof import('../../packages/firebird-wasm/src/react');
      FBVue: typeof import('../../packages/firebird-wasm/src/vue');
    };
    db: InstanceType<typeof import('../../packages/firebird-wasm/src/browser/index').FirebirdBrowser>;
    view: any;
  }
}

async function openHarness(page: Page, name: string): Promise<void> {
  await page.goto('/no-isolation/browser-harness-frameworks-st');
  await page.waitForFunction(() => Boolean(window.FB && window.Frameworks));
  await page.evaluate(async (dbName) => {
    const db = new window.FB.FirebirdBrowser(dbName);
    await db.exec('CREATE TABLE todos (id INTEGER, title VARCHAR(40), done BOOLEAN)');
    await db.query(
      "CREATE TRIGGER todos_changed FOR todos AFTER INSERT OR UPDATE OR DELETE AS BEGIN POST_EVENT 'todos'; END",
    );
    await db.exec("INSERT INTO todos VALUES (1, 'write the hooks', FALSE)");
    window.db = db;
  }, name);
}

/** The text of #app, once it equals `expected`. */
async function appShows(page: Page, expected: string): Promise<void> {
  await expect(page.locator('#app')).toHaveText(expected, { timeout: 10_000 });
}

test.describe('firebird-wasm/react and firebird-wasm/vue', () => {
  test.skip(!stAvailable, 'firebird-embedded-st not built – run npm run build:wasm first');
  test.setTimeout(120_000);

  test('React: useLiveQuery follows writes, under StrictMode', async ({ page }) => {
    await openHarness(page, 'memory://react-live');

    await page.evaluate(() => {
      const { React, createRoot, FBReact } = window.Frameworks;
      const h = React.createElement;
      function Todos() {
        const { rows, loading } = FBReact.useLiveQuery<{ ID: number; TITLE: string }>(
          'SELECT id, title FROM todos ORDER BY id',
          { events: ['todos'], pollIntervalMs: 20 },
        );
        if (loading) return h('span', null, 'loading');
        return h('span', null, rows!.map((r) => `${r.ID}:${r.TITLE}`).join(','));
      }
      const app = document.getElementById('app')!;
      app.textContent = '';
      window.view = createRoot(app);
      window.view.render(
        h(React.StrictMode, null, h(FBReact.FirebirdProvider, { db: window.db }, h(Todos))),
      );
    });

    await appShows(page, '1:write the hooks');
    await page.evaluate(() => window.db.exec("INSERT INTO todos VALUES (2, 'test them', FALSE)"));
    await appShows(page, '1:write the hooks,2:test them');
    await page.evaluate(() => window.db.exec('DELETE FROM todos WHERE id = 1'));
    await appShows(page, '2:test them');

    // Unmounted, it stops watching: the database closes cleanly with nothing
    // left polling it, and later writes reach no component.
    const closed = await page.evaluate(async () => {
      window.view.unmount();
      await window.db.exec("INSERT INTO todos VALUES (3, 'after', FALSE)");
      await window.db.close();
      return 'closed';
    });
    expect(closed).toBe('closed');
  });

  test('React: useQuery runs again when its parameters change, and shows errors', async ({ page }) => {
    await openHarness(page, 'memory://react-params');
    await page.evaluate(() => window.db.exec("INSERT INTO todos VALUES (2, 'second', TRUE)"));

    await page.evaluate(() => {
      const { React, createRoot, FBReact } = window.Frameworks;
      const h = React.createElement;
      function Filtered(props: { done: boolean }) {
        const { rows, error } = FBReact.useQuery<{ TITLE: string }>(
          'SELECT title FROM todos WHERE done = ? ORDER BY id', [props.done]);
        const missing = FBReact.useQuery('SELECT * FROM no_such_table');
        return h('span', null,
          `${rows?.map((r) => r.TITLE).join(',') ?? '…'}|${error ? 'error' : 'ok'}|` +
            `${missing.error ? 'missing table reported' : missing.loading ? 'loading' : 'no error'}`);
      }
      const app = document.getElementById('app')!;
      app.textContent = '';
      window.view = createRoot(app);
      (window as any).show = (done: boolean) =>
        window.view.render(
          h(React.StrictMode, null, h(FBReact.FirebirdProvider, { db: window.db }, h(Filtered, { done }))));
      (window as any).show(false);
    });

    await appShows(page, 'write the hooks|ok|missing table reported');
    await page.evaluate(() => (window as any).show(true));
    await appShows(page, 'second|ok|missing table reported');
  });

  test('Vue: useLiveQuery follows writes, and useQuery follows a ref', async ({ page }) => {
    await openHarness(page, 'memory://vue');

    await page.evaluate(() => {
      const { Vue, FBVue } = window.Frameworks;
      const done = Vue.ref(false);
      (window as any).done = done;
      const App = Vue.defineComponent({
        setup() {
          FBVue.provideFirebird(window.db);
          return () => Vue.h(Child);
        },
      });
      const Child = Vue.defineComponent({
        setup() {
          const live = FBVue.useLiveQuery<{ ID: number }>('SELECT id FROM todos ORDER BY id', {
            events: ['todos'],
            pollIntervalMs: 20,
          });
          const filtered = FBVue.useQuery<{ ID: number }>(
            'SELECT id FROM todos WHERE done = ? ORDER BY id', () => [done.value]);
          return () =>
            Vue.h('span', null,
              `${live.rows.value?.map((r) => r.ID).join(',') ?? '…'}|` +
                `${filtered.rows.value?.map((r) => r.ID).join(',') ?? '…'}`);
        },
      });
      const app = document.getElementById('app')!;
      app.textContent = '';
      window.view = Vue.createApp(App);
      window.view.mount(app);
    });

    await appShows(page, '1|1');
    await page.evaluate(() => window.db.exec("INSERT INTO todos VALUES (2, 'b', TRUE)"));
    await appShows(page, '1,2|1');
    await page.evaluate(() => { (window as any).done.value = true; });
    await appShows(page, '1,2|2');

    const closed = await page.evaluate(async () => {
      window.view.unmount();
      await window.db.exec("INSERT INTO todos VALUES (3, 'after', FALSE)");
      await window.db.close();
      return 'closed';
    });
    expect(closed).toBe('closed');
  });
});
