// ESLint for the package's TypeScript. The dependencies were declared and `npm run lint` existed, but
// no configuration did, so the linter refused to start; this is the smallest one that runs it.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { es2022: true, node: true, browser: true, worker: true },
  ignorePatterns: ['dist/', 'wasm/', 'node_modules/'],
  rules: {
    // unused parameters are part of interfaces (transports, callbacks); a leading underscore says so
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
  overrides: [
    { files: ['src/**/__tests__/**/*.ts'], env: { jest: true } },
  ],
};
