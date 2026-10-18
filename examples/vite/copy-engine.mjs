// Copy the engine (both builds' glue and binary) out of node_modules, to be
// served verbatim from the site root.  Usage: node copy-engine.mjs <dir>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const target = process.argv[2];
const require = createRequire(import.meta.url);
const wasmDir = path.join(path.dirname(require.resolve('firebird-wasm/package.json')), 'dist/wasm');

fs.mkdirSync(target, { recursive: true });
for (const file of ['firebird-embedded.js', 'firebird-embedded.wasm', 'firebird-embedded-st.js', 'firebird-embedded-st.wasm']) {
  fs.copyFileSync(path.join(wasmDir, file), path.join(target, file));
}
console.log(`engine copied to ${target}/`);
