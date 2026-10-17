/**
 * size-budget.mjs – what the engine costs to download, and a ceiling on it.
 *
 * Prints each artifact's size raw, gzipped and brotli-compressed (a CDN
 * serves one of the last two), and fails when one is over its budget.  The
 * budgets sit about 10 % above the sizes measured when they were set, so the
 * engine growing is a decision someone makes here, in review, rather than
 * something consumers discover.
 *
 * Usage: node scripts/size-budget.mjs        (after npm run build:wasm)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const WASM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/wasm');
const MB = 1024 * 1024;

/**
 * Bytes, raw and gzipped.  Set in October 2026 from 8.82 / 8.72 MB raw and
 * 2.90 / 2.88 MB gzipped (2.06 / 2.05 MB brotli) for the threaded and the
 * single-threaded engine.
 */
const BUDGETS = {
  'firebird-embedded.wasm': { raw: 9.5 * MB, gzip: 3.2 * MB },
  'firebird-embedded-st.wasm': { raw: 9.5 * MB, gzip: 3.2 * MB },
  'firebird-embedded.js': { raw: 0.15 * MB, gzip: 0.05 * MB },
  'firebird-embedded-st.js': { raw: 0.15 * MB, gzip: 0.05 * MB },
};

const fmt = (bytes) => `${(bytes / MB).toFixed(2)} MB`;
const problems = [];

console.log('artifact                     raw        gzip       brotli     budget (raw / gzip)');
for (const [file, budget] of Object.entries(BUDGETS)) {
  const full = path.join(WASM_DIR, file);
  if (!fs.existsSync(full)) {
    problems.push(`${file} is missing: run npm run build:wasm`);
    continue;
  }
  const bytes = fs.readFileSync(full);
  const gzip = zlib.gzipSync(bytes, { level: 9 }).length;
  const brotli = zlib.brotliCompressSync(bytes, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  console.log(
    `${file.padEnd(28)} ${fmt(bytes.length).padEnd(10)} ${fmt(gzip).padEnd(10)} ` +
      `${fmt(brotli).padEnd(10)} ${fmt(budget.raw)} / ${fmt(budget.gzip)}`,
  );
  if (bytes.length > budget.raw) {
    problems.push(`${file} is ${fmt(bytes.length)} raw, over its ${fmt(budget.raw)} budget`);
  }
  if (gzip > budget.gzip) {
    problems.push(`${file} is ${fmt(gzip)} gzipped, over its ${fmt(budget.gzip)} budget`);
  }
}

if (problems.length > 0) {
  console.error('\nOver budget:\n  ' + problems.join('\n  '));
  console.error('\nIf the growth is intended, raise the budget in scripts/size-budget.mjs and say why.');
  process.exit(1);
}
console.log('\nWithin budget.');
