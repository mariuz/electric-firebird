# Installation

## Prerequisites

### Node.js

- **Node.js 20+**
- The Firebird **client library** installed on the host:
  - Linux: `libfbclient.so` (from the `firebird-dev` or `libfirebird3.0` package)
  - macOS: `libfbclient.dylib` (Homebrew: `brew install firebird`)
  - Windows: `fbclient.dll` (from the [official Firebird installer](https://firebirdsql.org/en/firebird-3-0/))

For **embedded mode** (single-process, no server) you also need the engine plugin:
- Linux: `libEngine12.so` (Firebird 3) or `libEngine13.so` (Firebird 4/5), placed in the Firebird plugin directory (`/usr/lib/x86_64-linux-gnu/firebird/plugins/` on Debian/Ubuntu)

See [Firebird server packages](https://firebirdsql.org/en/server-packages/) for platform-specific installation guides.

### Browser / WASM

No native libraries are required in the browser.  You only need the pre-built
`firebird-embedded.wasm` + `firebird-embedded.js` artefacts, which will be
bundled with the npm package once the WASM build pipeline is complete.

---

## Installing the npm package

```bash
npm install firebird-wasm node-firebird-driver-native
```

`node-firebird-driver-native` is the peer that provides the low-level Firebird
bindings used by the Node.js backend.

### Optional: browser sub-package

The browser entry point is included in the same package and is accessed via the
`firebird-wasm/browser` sub-path export:

```ts
import { FirebirdBrowser } from 'firebird-wasm/browser';
```

No additional install step is needed.

---

## Building from source

```bash
# Clone the monorepo
git clone https://github.com/mariuz/electric-firebird.git
cd electric-firebird

# Install all workspace dependencies
npm install

# Build the TypeScript library
npm run build -w packages/firebird-wasm
```

### Building the WASM module (optional)

Compiling Firebird to WebAssembly requires the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html):

```bash
# Activate Emscripten (adjust path to your emsdk installation)
source <emsdk>/emsdk_env.sh

# Build the WASM artefacts
npm run build:wasm -w packages/firebird-wasm
```

The build script (`packages/firebird-wasm/wasm/build.sh`) downloads the
Firebird 5.0.3 source tree, applies the necessary patches, and produces
`dist/wasm/firebird-embedded.js` and `dist/wasm/firebird-embedded.wasm`.

---

## Running tests

```bash
# Set the Firebird password for the test database
export FIREBIRD_PASSWORD=masterkey

# Run unit tests
npm test -w packages/firebird-wasm
```

### End-to-end tests

```bash
cd e2e
FIREBIRD_PASSWORD=masterkey npx playwright test
```

The e2e suite requires a running Firebird server.  The easiest way is to use
the official Docker image:

```bash
docker run -d \
  --name firebird \
  -e ISC_PASSWORD=masterkey \
  -p 3050:3050 \
  firebirdsql/firebird:latest
```
