// Runs before the engine's Worker entry (engine-worker.js imports it first):
// load the Emscripten glue, and tell the engine where its .wasm is.
//
// The four engine files are copied to the site root by copy-engine.mjs.
// wasmGlueFile(true) is the threaded build, which a page can run only when it
// is cross-origin isolated; wasmGlueFile() alone is the build without threads,
// which runs anywhere. This example takes threads where the page allows them,
// so CI runs it on both builds.
import { wasmGlueFile } from 'firebird-wasm/browser';

const base = new URL('/', self.location.href).href;
importScripts(base + wasmGlueFile(self.crossOriginIsolated));
self.FIREBIRD_WORKER_OPTIONS = { locateFile: (file) => base + file };
