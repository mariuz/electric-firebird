# Installation

## Installing from npm

```bash
npm install firebird-wasm
```

`firebird-wasm` ships pre-built WebAssembly binaries (`firebird-embedded-st.wasm` and `firebird-embedded.wasm`) inside the npm package — **no Emscripten toolchain, no Firebird server, and no native compilation are needed** to run Firebird in the browser or via WASM in Node.js.

### Browser-only projects (`--omit=optional`)

The Node.js native backend (`FirebirdLite`) uses `node-firebird-driver-native`, which is declared in `optionalDependencies` because it loads the host's native Firebird client library (`libfbclient`). If you only use `firebird-wasm/browser` (or WASM in Node), you can skip optional dependencies cleanly:

```bash
npm install firebird-wasm --omit=optional
```

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';
```

See the [Integration Guide](./integration.md) for configuring Vite, webpack, esbuild, Next.js, or CDN loading (`cdnArtifacts()`).

---

## Native prerequisites (for `FirebirdLite` on Node.js)

If you use the native Node.js driver (`import { FirebirdLite } from 'firebird-wasm'`), you need:

- **Node.js 18+** (Node.js 20+ recommended for development in this monorepo)
- The Firebird **client library** installed on the host:
  - **Linux**: `libfbclient.so` (e.g. `apt install libfbclient2` / `firebird-dev`)
  - **macOS**: `libfbclient.dylib` (`brew install firebird`)
  - **Windows**: `fbclient.dll` (from the [official Firebird packages](https://firebirdsql.org/en/server-packages/))

For **native embedded mode** (passing a local file path like `'/tmp/my.fdb'` with no `host:` prefix and no running server), you also need the Firebird engine plugin alongside `libfbclient`:
- Linux: `libEngine12.so` (Firebird 3) or `libEngine13.so` (Firebird 4 / 5), placed in the Firebird `plugins/` directory.

> **Tip:** If you want an embedded database in Node.js *without* installing any native Firebird libraries, you can run `FirebirdBrowser` (or `DirectTransport`) from `firebird-wasm/browser` directly in Node.js using the bundled WASM engine.

---

## Building from source

```bash
# Clone the monorepo (include submodules if you plan to compile the WASM engine)
git clone --recurse-submodules https://github.com/mariuz/electric-firebird.git
cd electric-firebird

# Install all workspace dependencies
npm install

# Build the TypeScript library
npm run build -w packages/firebird-wasm
```

### Building the WASM module (optional)

You only need to run this if you are modifying the C++ engine or [`wasm/fb_wasm_api.cpp`](../packages/firebird-wasm/wasm/fb_wasm_api.cpp). Emscripten is vendored in `third_party/emsdk` and pinned via `packages/firebird-wasm/wasm/emsdk-version.txt`:

```bash
# Activate the pinned Emscripten version (the build refuses mismatched versions,
# which link cleanly and trap inside the engine at runtime).
EMSDK_VERSION=$(cat packages/firebird-wasm/wasm/emsdk-version.txt)
(cd third_party/emsdk && ./emsdk install "$EMSDK_VERSION" \
  && ./emsdk activate "$EMSDK_VERSION")
source third_party/emsdk/emsdk_env.sh

# Build both WASM variants (single-threaded & threaded)
npm run build:wasm -w packages/firebird-wasm
```

`packages/firebird-wasm/wasm/build.sh` compiles the Firebird source submodule (`packages/firebird-wasm/wasm/firebird-src`, targeting Firebird 6.0 `master` by default or Firebird 5.0 LTS with `FB_TARGET_VERSION=5`) and writes:

- `dist/wasm/firebird-embedded-st.js` + `dist/wasm/firebird-embedded-st.wasm` (single-threaded, default)
- `dist/wasm/firebird-embedded.js` + `dist/wasm/firebird-embedded.wasm` (pthreads + `SharedArrayBuffer`)

See [Engine Builds](./builds.md) for variant flags (`--variant single | threads | all`) and architectural details.

---

## Running tests

```bash
# Unit & WASM integration tests (Vitest)
FIREBIRD_PASSWORD=masterkey npm test -w packages/firebird-wasm
```

### End-to-end tests (Playwright)

```bash
cd e2e
npx playwright install chromium

# Browser suite (stub-ABI & bundler/framework tests — needs no Firebird server)
npm run test:browser

# Full Node.js + Firebird server suite
FIREBIRD_PASSWORD=masterkey npx playwright test
```

To start a local Firebird server for the server-backed test suites using Docker:

```bash
docker run -d \
  --name firebird \
  -e ISC_PASSWORD=masterkey \
  -p 3050:3050 \
  firebirdsql/firebird:latest
```
