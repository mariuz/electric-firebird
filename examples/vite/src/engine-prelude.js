// Runs before the engine's Worker entry (engine-worker.js imports it first):
// load the Emscripten glue, and tell the engine where its .wasm is.
//
// The four engine files are copied to the site root by copy-engine.mjs.
// wasmGlueFile() picks the threaded build where the page is cross-origin
// isolated and the build without threads everywhere else.
import { wasmGlueFile } from 'firebird-wasm/browser';

const base = new URL('/', self.location.href).href;
importScripts(base + wasmGlueFile());
self.FIREBIRD_WORKER_OPTIONS = { locateFile: (file) => base + file };
