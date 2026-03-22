import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
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
