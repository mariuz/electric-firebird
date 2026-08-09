# Publishing to npm

The package is `firebird-wasm`, at `packages/firebird-wasm`. The name is
unregistered, so the first publish claims it.

> **The one thing that makes this different from an ordinary npm package:**
> `npm run build` does *not* produce the engine. `firebird-embedded.wasm` comes
> from a separate hour-long Emscripten build, and a package published without
> it installs perfectly and then 404s the engine in every consumer's browser.
> `prepublishOnly` runs `scripts/check-publish.mjs` to make that impossible.

---

## 1. Before the first publish

```bash
npm adduser          # or: npm login
npm whoami           # confirm
```

Enable two-factor authentication on the npm account and set it to
**"Authorization and writes"**. Publishing then needs a one-time password,
which is what stops a stolen laptop from shipping a release.

---

## 2. Build a release

Order matters, because `clean` deletes `dist` and the artifact lives there:

```bash
npm run clean    -w packages/firebird-wasm
npm run build:wasm -w packages/firebird-wasm   # ~1 hour → dist/wasm/
npm run build    -w packages/firebird-wasm     # seconds  → dist/*.js
```

`build:wasm` needs the vendored Emscripten at the pinned version:

```bash
EMSDK_VERSION=$(cat packages/firebird-wasm/wasm/emsdk-version.txt)
(cd third_party/emsdk && ./emsdk install "$EMSDK_VERSION" \
  && ./emsdk activate "$EMSDK_VERSION")
source third_party/emsdk/emsdk_env.sh
```

If you already have a good artifact from CI, download it instead of spending
the hour:

```bash
gh run download --name firebird-wasm \
  --dir packages/firebird-wasm/dist/wasm
npm run build -w packages/firebird-wasm
```

---

## 3. Verify before publishing

```bash
npm test -w packages/firebird-wasm
(cd e2e && npx playwright test --config playwright.wasm.config.ts)
(cd e2e && npx playwright test --config playwright.demo.config.ts)
```

Then check what the tarball will actually contain:

```bash
cd packages/firebird-wasm
npm pack --dry-run
```

Expect roughly:

```
package size:  3.1 MB
unpacked size: 9.5 MB
total files:   66
```

If you see thousands of files or hundreds of megabytes, the `files` field in
`package.json` has been lost — without it npm falls back to walking the whole
directory and ships the entire Firebird source tree and every build directory
(measured: 13,545 files, 458 MB).

**Install the tarball somewhere else and use it.** This is the check that
catches everything the others miss:

```bash
npm pack --pack-destination /tmp
mkdir /tmp/smoke && cd /tmp/smoke && npm init -y
npm install /tmp/firebird-wasm-0.1.0.tgz --omit=optional
```

`--omit=optional` simulates a browser-only consumer with no Firebird client
library installed. Then confirm the engine actually runs from the installed
copy:

```js
import { DirectTransport } from 'firebird-wasm/browser';

const engine = new DirectTransport();
await engine.init();
const db = await engine.createDatabase('/tmp/smoke.fdb');
await engine.execute(db, 0, 'CREATE TABLE t (id INTEGER, price NUMERIC(10,2))');
await engine.execute(db, 0, 'INSERT INTO t VALUES (1, 20.25)');
console.log((await engine.query(db, 0, 'SELECT * FROM t')).rows);
// [{ ID: 1, PRICE: '20.25' }]
```

---

## 4. Version and publish

```bash
cd packages/firebird-wasm
npm version patch      # or minor / major — writes the tag commit
npm publish --otp=123456
```

`prepublishOnly` runs the publish check first and aborts on anything missing.

Then push the tag and cut a GitHub release:

```bash
git push --follow-tags
gh release create v0.1.0 --notes-file ../../ANNOUNCEMENT.md
```

### Releasing a pre-release first

Worth doing for `0.1.0`, since nothing has been installed from npm yet:

```bash
npm version 0.1.0-rc.1
npm publish --tag next --otp=123456
```

`--tag next` keeps it off `latest`, so `npm i firebird-wasm` still resolves to
the last stable version and only `npm i firebird-wasm@next` gets the candidate.

---

## 5. What the package contains

| Field | Value | Why |
|-------|-------|-----|
| `files` | `dist`, `README.md`, `LICENSE` | Everything else is source, submodules and build trees |
| `dependencies` | `node-firebird-driver` | Imported directly by `src/firebird.ts` |
| `optionalDependencies` | `node-firebird-driver-native` | Needs Firebird's client library; a browser consumer must not be blocked by it |
| `exports["."]` | Node backend | Native driver, talks to a Firebird server |
| `exports["./browser"]` | WASM backend | No native code, no server |

The native driver is **optional** deliberately. It was previously a hard
dependency, which meant anyone installing this for browser use was made to
install a native module they would never call. As an optional dependency the
install succeeds without it and the browser entry point works; only
`import 'firebird-wasm'` (the Node backend) needs it.

`node-firebird-driver` was imported but never declared — it resolved
transitively under npm's hoisting and would have failed under pnpm or Yarn
PnP. It is now a direct dependency.

---

## 6. Automating it

A release workflow triggered by publishing a GitHub Release:

```yaml
name: Publish to npm
on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write        # npm provenance

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: true }
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm install

      # Reuse the engine from Build WASM rather than spending an hour on it.
      - run: |
          gh run download --name firebird-wasm \
            --dir packages/firebird-wasm/dist/wasm
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - run: npm run build -w packages/firebird-wasm
      - run: npm publish -w packages/firebird-wasm --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

This needs an `NPM_TOKEN` secret — an **automation** token, since a publish
token subject to 2FA cannot be used unattended. `--provenance` records which
workflow and commit produced the tarball, which consumers can verify.

Consider [npm trusted publishing][trusted] instead: it uses the same OIDC
identity as `id-token: write` and removes the long-lived token entirely.

---

## 7. After publishing

```bash
npm view firebird-wasm
npm dist-tag ls firebird-wasm
```

Check the package page renders the README, and install it once from the real
registry in a clean directory.

Publishing is not reversible. `npm unpublish` is only permitted within 72
hours and only if nothing depends on the version; after that the fix is to
publish a new version and `npm deprecate` the bad one.

[trusted]: https://docs.npmjs.com/trusted-publishers
