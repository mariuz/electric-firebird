/**
 * playwright.examples.config.ts – the example apps in examples/, built by
 * their own bundlers, in a real browser.
 *
 * Each example's dist is served twice: with COOP/COEP (the page is isolated
 * and loads the threaded engine) and without (it loads the build without
 * threads). Build them first:
 *
 *   (cd examples/vite && npm install && npm run build)
 *   (cd examples/webpack && npm install && npm run build)
 *   npx playwright test --config playwright.examples.config.ts
 */
import { defineConfig } from '@playwright/test';

const serve = (example: string, port: number, isolated: boolean) => ({
  command: `node ../examples/serve.mjs ../examples/${example}/dist ${port}${isolated ? ' --isolated' : ''}`,
  url: `http://localhost:${port}/`,
  reuseExistingServer: !process.env['CI'],
  timeout: 30_000,
});

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/examples.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-examples' }]],
  use: { trace: 'on-first-retry', screenshot: 'only-on-failure' },
  webServer: [
    serve('vite', 4180, true),
    serve('vite', 4181, false),
    serve('webpack', 4182, true),
    serve('webpack', 4183, false),
  ],
});
