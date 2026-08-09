import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // An allow-list, not a deny-list.  This config's server is the one that
  // talks to a real Firebird server on :3000; the browser suites need the
  // COOP/COEP static server on :3001 and the demo needs its own on :4173.
  //
  // It used to name the suites to *exclude*, which meant every new browser
  // suite had to be added here or it would silently run against the wrong
  // server and fail.  Two of them were, and did.  With an allow-list the
  // worst case of forgetting is a suite that does not run, which
  // `npm run check:suites` then catches.
  testMatch: ['**/firebird.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: process.env['BASE_URL'] ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node -r ts-node/register server/index.ts',
    url: 'http://localhost:3000/health',
    reuseExistingServer: !process.env['CI'],
    // Allow up to 30s for the server to start; this includes the time Firebird
    // needs to create the database file on first connect.
    timeout: 30_000,
    env: {
      PORT: '3000',
      FIREBIRD_HOST: process.env['FIREBIRD_HOST'] ?? 'localhost',
      FIREBIRD_USER: process.env['FIREBIRD_USER'] ?? 'SYSDBA',
      FIREBIRD_PASSWORD: process.env['FIREBIRD_PASSWORD'] ?? '',
    },
  },
});
