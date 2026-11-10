# The demo site

Interactive static pages that run the real Firebird WASM engine in your browser,
published to GitHub Pages from `main`:

- **`index.html`** ([live SQL Console →](https://mariuz.github.io/electric-firebird/)):
  interactive `<firebird-repl>` SQL console, worked examples (joins, bound
  parameters, recursive CTEs, `EXECUTE BLOCK`, transaction rollback, exact
  `BIGINT`/`NUMERIC`), and IndexedDB persistence across reloads.
- **`replication.html`** ([Replication Simulator & Live Demo →](https://mariuz.github.io/electric-firebird/replication.html)):
  multi-node primary/replica, hub-and-spoke, and mesh replication simulator with
  live `FB_REPL_JOURNAL$` LSN streams, HLC + CRDT conflict merges, slots &
  auto-pruning, `FB_REPL_DLQ$` quarantine/retry, AES-256-GCM encrypted segment
  hex inspection, failover promotion, and time-travel `rewindToLsn`.

```
demo/
  public/     hand-written HTML, CSS, JS and the retired service worker
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

The threaded engine build (`firebird-embedded`) uses pthreads, which need
`SharedArrayBuffer` — only exposed by browsers to a [cross-origin isolated][coi]
page served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot send those.

So the demo ships both builds, and its engine Worker loads the threaded one
only where the page is isolated; on GitHub Pages (and `npm run demo`) it loads
the default single-threaded build (`firebird-embedded-st`), which needs no
`SharedArrayBuffer` at all. The one thing that build gives up, statement
timeouts, the demo does not use.

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

Playwright tests (`e2e/tests/demo.spec.ts` and
`e2e/tests/replication-demo.spec.ts`) drive both the SQL Console and the
Replication Simulator against the real WASM engine. The suite asserts that the
server is *not* sending COOP/COEP, that the page runs un-isolated with no
service worker, and that the retired service worker unregisters itself when an
earlier visit had it registered.

The remaining tests exercise every SQL Console example (`BIGINT`/`NUMERIC`
precision, recursive CTEs, `EXECUTE BLOCK`, parameter binding, transaction
rollback, error recovery, and IndexedDB durability across reloads) and every
Replication Simulator scenario (CRDT convergence, slot holdback/pruning,
multi-node mesh/DLQ, failover promotion, and time-travel rewind).

## Publishing

`.github/workflows/deploy-demo.yml` runs after **Build WASM** succeeds on
`main`, downloads the engine that workflow already produced, builds the site
and deploys it. It does not rebuild the engine — compiling Firebird with
Emscripten takes the better part of an hour, and doing it twice per push buys
nothing.

Enable it once, under **Settings → Pages → Source → GitHub Actions**.

[coi]: https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
