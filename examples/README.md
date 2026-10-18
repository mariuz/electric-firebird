# Example apps

Two minimal apps, each built by its own bundler from the `firebird-wasm`
package, and each run by CI in Chromium twice: served with COOP/COEP, where
the page is cross-origin isolated and loads the threaded engine, and without,
where it loads the build without threads.

| | Bundler | Worker built by |
|---|---|---|
| [`vite/`](./vite) | Vite 8 (Rolldown) | `new Worker(new URL('./engine-worker.js', import.meta.url))` |
| [`webpack/`](./webpack) | webpack 5 | the same |

Both are the same four files around the bundler's configuration:

- `src/main.js` — the page: open a database, create, insert, read back.
- `src/engine-worker.js` — the Worker: the prelude, then the library's
  `firebird-wasm/browser/worker-entry`, in that order.
- `src/engine-prelude.js` — loads the engine's glue (`wasmGlueFile()` picks the
  build the page can run) and sets `locateFile` for its `.wasm`.
- `copy-engine.mjs` — copies the four engine files out of `node_modules` to be
  served verbatim from the site root.

The bundler configuration keeps the library's Node-only `require` of the glue
out of the bundle (`external` in Vite, for the Worker too; `externals` in
webpack). See [docs/integration.md](../docs/integration.md) §3 and §4.

```sh
npm run build -w packages/firebird-wasm          # the package, from the repository root
(cd examples/vite && npm install --install-links && npm run build)
(cd examples/webpack && npm install --install-links && npm run build)
cd e2e && npx playwright test --config playwright.examples.config.ts
```

`--install-links` installs the package as a packed copy, the files npm would
publish, rather than a link into this repository: what an app gets from npm.
A link also made npm 10 in CI fail with `Cannot read properties of null
(reading 'edgesOut')`.  Run it again after rebuilding the package.

`node examples/serve.mjs <dist> <port> [--isolated]` serves a build by hand.
