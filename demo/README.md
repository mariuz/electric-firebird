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

## No cross-origin isolation needed

The default engine build uses pthreads, so it needs `SharedArrayBuffer`, which
a browser only grants to a [cross-origin isolated][coi] page, served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot send those.

So the demo ships both builds, and its engine Worker loads the threaded one
only where the page is isolated; on Pages it loads `firebird-embedded-st`, the
build without threads, which needs no `SharedArrayBuffer` at all. The one
thing that build gives up, statement timeouts, the demo does not use.

It used to synthesise isolation with a service worker that re-issued every
response with the headers attached, at the price of a reload on every first
visit. `public/coi-serviceworker.js` is now a retired version of it: visitors
who still have the old worker registered get this one on its next update
check, and it unregisters itself. The page registers nothing.

The local server still sends no headers, so a demo that only worked behind a
helpful dev server would fail here rather than once published.

## Tests

```sh
npm run test:demo
```

21 Playwright tests drive the built site against the real engine. The first
one asserts that the server is *not* sending COOP/COEP, and that the page runs
un-isolated with no service worker; the second, that the retired service
worker unregisters itself when an earlier visit had it registered.

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
