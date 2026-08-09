# The demo site

A single static page that runs the Firebird engine in your browser: a SQL
console, a set of worked examples, and a database that survives a reload.
Published to GitHub Pages from `main`.

```
demo/
  public/     hand-written HTML, CSS, JS and the service worker
  build.mjs   assembles public/ + the compiled engine into dist/
  dist/       build output (git-ignored)
```

## Building and running it

The demo needs the compiled engine, which is not in the repository:

```sh
npm run build:wasm -w packages/firebird-wasm   # once; slow
npm run demo                                    # build, then serve on :4173
```

`npm run demo` deliberately serves the site **without** COOP/COEP headers,
because that is what GitHub Pages does. See below.

## Cross-origin isolation, and why a service worker

The engine is compiled with pthreads, so it needs `SharedArrayBuffer`, and a
browser only grants that to a [cross-origin isolated][coi] page. Isolation
requires two headers on the document:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

GitHub Pages serves a fixed header set and offers no way to add them. So
`public/coi-serviceworker.js` registers a service worker that re-issues every
response with the headers attached — the page becomes isolated even though the
server never said so.

The cost is inherent to service workers rather than to this implementation: a
worker cannot control the load that registered it. A first visit therefore
arrives un-isolated and reloads itself once. Subsequent visits are served
through the worker directly.

Because the demo depends on that mechanism, the local server does not set the
headers itself. A dev server that helpfully set them would make the demo work
locally and fail once published, which is precisely the bug worth catching
early.

## Tests

```sh
npm run test:demo
```

16 Playwright tests drive the built site against the real engine. The first
one asserts that the server is *not* sending COOP/COEP before checking that
the page is isolated anyway — otherwise every other test could pass without
the service worker doing anything at all.

The rest run each example and check the data: exact `BIGINT` and `NUMERIC`
values that a double could not represent, a recursive CTE, `EXECUTE BLOCK`,
parameter binding, a transaction rollback, a SQL error leaving the page
usable, and the database surviving a reload.

## Publishing

`.github/workflows/deploy-demo.yml` runs after **Build WASM** succeeds on
`main`, downloads the engine that workflow already produced, builds the site
and deploys it. It does not rebuild the engine — compiling Firebird with
Emscripten takes the better part of an hour, and doing it twice per push buys
nothing.

Enable it once, under **Settings → Pages → Source → GitHub Actions**.

[coi]: https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
