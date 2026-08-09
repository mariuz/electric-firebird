/**
 * check-publish.mjs – refuse to publish a package that cannot work.
 *
 * Runs from `prepublishOnly`, so it fires on `npm publish` and `npm pack`.
 *
 * The failure it exists to prevent is specific: `npm run build` compiles the
 * TypeScript but does not produce `firebird-embedded.wasm`, which comes from a
 * separate hour-long Emscripten build. Publish after a plain `build` and the
 * tarball looks complete, installs cleanly, and then 404s the engine in every
 * consumer's browser. Nothing about that is visible at publish time, so it is
 * checked here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

/** Every file a consumer needs, and why. */
const REQUIRED = [
  ['dist/index.js', 'Node entry point — run `npm run build`'],
  ['dist/index.d.ts', 'Node type declarations — run `npm run build`'],
  ['dist/browser/index.js', 'browser entry point — run `npm run build`'],
  ['dist/browser/index.d.ts', 'browser type declarations — run `npm run build`'],
  [
    'dist/wasm/firebird-embedded.js',
    'Emscripten glue — run `npm run build:wasm`',
  ],
  [
    'dist/wasm/firebird-embedded.wasm',
    'the engine itself — run `npm run build:wasm`',
  ],
  ['LICENSE', 'required by the declared licence'],
  ['README.md', 'shown on the npm package page'],
];

for (const [file, why] of REQUIRED) {
  if (!fs.existsSync(path.join(pkgDir, file))) {
    problems.push(`missing ${file}  (${why})`);
  }
}

// A zero-length or truncated artifact would satisfy an existence check and
// fail at instantiation. The real binary is around 9 MB.
const wasm = path.join(pkgDir, 'dist/wasm/firebird-embedded.wasm');
if (fs.existsSync(wasm)) {
  const mb = fs.statSync(wasm).size / 1024 / 1024;
  if (mb < 1) {
    problems.push(
      `dist/wasm/firebird-embedded.wasm is only ${mb.toFixed(2)} MB; ` +
        'expected roughly 9 MB — the build looks truncated',
    );
  }
}

// Compiled tests in the tarball are dead weight and confuse consumers reading
// the package. tsconfig.build.json should have excluded them.
const shippedTests = path.join(pkgDir, 'dist/__tests__');
if (fs.existsSync(shippedTests)) {
  problems.push(
    'dist/__tests__ exists — build with tsconfig.build.json so tests stay ' +
      'out of the published package',
  );
}

if (problems.length > 0) {
  console.error('\nRefusing to publish:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(
    '\nA full release build is:\n' +
      '  npm run clean -w packages/firebird-wasm\n' +
      '  npm run build:wasm -w packages/firebird-wasm   # writes dist/wasm\n' +
      '  npm run build -w packages/firebird-wasm        # writes dist/*.js\n' +
      '\nThat order matters: `clean` removes dist, including the artifact.\n',
  );
  process.exit(1);
}

console.log('publish check: all required files present');
