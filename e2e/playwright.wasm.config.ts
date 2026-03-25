/**
 * playwright.wasm.config.ts – Playwright configuration for WASM browser tests.
 *
 * Uses the minimal `wasm-server.ts` (no Firebird dependency) so these tests
 * can run directly after the WASM artifact is built, without needing a
 * running Firebird server.
 *
 * Run with:
 *   npx playwright test --config playwright.wasm.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/wasm.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-wasm' }],
  ],
  use: {
    baseURL: process.env['WASM_BASE_URL'] ?? 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node -r ts-node/register server/wasm-server.ts',
    url: 'http://localhost:3001/health',
    reuseExistingServer: !process.env['CI'],
    // Allow up to 15 s for the static server to start.
    timeout: 15_000,
    env: {
      PORT: '3001',
    },
  },
});
