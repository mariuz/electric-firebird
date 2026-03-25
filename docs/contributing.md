# Contributing

Thank you for your interest in contributing to electric-firebird!

---

## Development setup

### 1. Clone and install

```bash
git clone https://github.com/mariuz/electric-firebird.git
cd electric-firebird
npm install
```

### 2. Start a Firebird server

The unit tests and e2e tests require a running Firebird instance.  The easiest
way is Docker:

```bash
docker run -d \
  --name firebird \
  -e ISC_PASSWORD=masterkey \
  -p 3050:3050 \
  firebirdsql/firebird:latest
```

### 3. Build

```bash
npm run build -w packages/firebird-wasm
```

### 4. Run tests

```bash
# Unit tests
FIREBIRD_PASSWORD=masterkey npm test -w packages/firebird-wasm

# End-to-end tests
cd e2e
FIREBIRD_PASSWORD=masterkey npx playwright test
```

---

## Project structure

```
electric-firebird/
├── docs/                        ← documentation (Markdown)
├── e2e/                         ← Playwright end-to-end tests
├── packages/
│   └── firebird-wasm/
│       ├── src/
│       │   ├── __tests__/       ← Jest unit tests
│       │   ├── browser/         ← Browser/WASM entry point
│       │   ├── firebird.ts      ← Node.js backend
│       │   ├── index.ts         ← Node.js entry point
│       │   ├── types.ts         ← Shared types
│       │   └── wasm-loader.ts   ← WASM loader
│       └── wasm/                ← WASM build artefacts
│           ├── build.sh
│           ├── CMakeLists.txt
│           ├── fb_wasm_api.cpp
│           └── fb_wasm_stubs.cpp
└── package.json
```

---

## Coding guidelines

- **TypeScript** — all source files are TypeScript with strict mode enabled.
- **Async/await** — prefer async/await over raw Promises for readability.
- **JSDoc comments** — public API members should have JSDoc comments
  explaining their purpose and usage, with `@example` blocks where helpful.
- **No default exports** — use named exports for all public symbols.
- **Error handling** — always roll back transactions on error; never swallow
  exceptions silently.

---

## Adding features

### Adding a new public API method

1. Add the method to the appropriate class in `src/firebird.ts` (Node.js) or
   `src/browser/firebird-browser.ts` (browser).
2. Export any new types from `src/types.ts`.
3. Re-export from the appropriate entry point (`src/index.ts` or
   `src/browser/index.ts`).
4. Write unit tests in `src/__tests__/`.
5. Update [docs/api.md](./api.md).

### Extending the WASM C API

1. Add the new `extern "C"` function to `wasm/fb_wasm_api.cpp`.
2. Add the function signature to the `EXPORTED_FUNCTIONS` list in
   `wasm/CMakeLists.txt`.
3. Add the corresponding TypeScript declaration to the `FirebirdWasmModule`
   interface in `src/wasm-loader.ts`.
4. Update [docs/api.md](./api.md).

### Adding stubs for new Firebird internals

When the WASM build requires symbols from `.epp`-generated files (e.g.
`met.epp`, `scl.epp`) that are not compiled, add stub implementations to
`wasm/fb_wasm_stubs.cpp`.  Make sure all signatures match the **Firebird
5.0.3** headers (the build is pinned to that version).

---

## Running the linter

```bash
npm run lint -w packages/firebird-wasm
```

---

## Submitting a pull request

1. Fork the repository and create a feature branch.
2. Make your changes and add tests.
3. Run the linter and tests locally.
4. Open a pull request against the `main` branch with a clear description of
   what the change does and why.

---

## Reporting issues

Please open a GitHub issue with:
- A minimal reproducible example
- The Firebird version in use (`SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') FROM rdb$database`)
- Your OS and Node.js version (`node --version`)
- The full error message / stack trace
