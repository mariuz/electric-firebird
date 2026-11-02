import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/src/browser/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
  },
});
