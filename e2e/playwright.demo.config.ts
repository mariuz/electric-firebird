/**
 * playwright.demo.config.ts – drives the built demo site.
 *
 * Separate from `playwright.wasm.config.ts` for one reason that matters: this
 * server sends **no** COOP/COEP headers, exactly like GitHub Pages.  The other
 * config's server sets them, so it could never catch a site that only works
 * because the server was being helpful.  Here, cross-origin isolation has to
 * come from the demo's own service worker or the engine does not start.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Point the suite at an already-deployed site, e.g. to verify a Pages release:
 *
 *   DEMO_BASE_URL=https://mariuz.github.io/electric-firebird/ npm run test:demo
 *
 * The local server is not started in that case — the deployed host is the
 * thing under test, and standing a second one up alongside it would only
 * invite the tests to hit the wrong one.
 */
const DEPLOYED = process.env['DEMO_BASE_URL'];

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/demo.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-demo' }],
  ],
  use: {
    baseURL: DEPLOYED ?? `http://localhost:${PORT}/`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: DEPLOYED
    ? undefined
    : {
        // Builds the site, then serves it bare.  Building here keeps the test
        // honest about what is actually deployed rather than a stale dist.
        command: 'node ../demo/build.mjs --serve',
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: !process.env['CI'],
        timeout: 120_000,
        env: { PORT: String(PORT) },
      },
});
