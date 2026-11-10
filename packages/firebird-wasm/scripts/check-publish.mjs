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
  [
    'dist/wasm/firebird-embedded-st.js',
    'Emscripten glue of the build without threads — run `npm run build:wasm`',
  ],
  [
    'dist/wasm/firebird-embedded-st.wasm',
    'the engine without threads — run `npm run build:wasm`',
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
for (const name of ['firebird-embedded.wasm', 'firebird-embedded-st.wasm']) {
  const wasm = path.join(pkgDir, 'dist/wasm', name);
  if (!fs.existsSync(wasm)) continue;
  const mb = fs.statSync(wasm).size / 1024 / 1024;
  if (mb < 1) {
    problems.push(
      `dist/wasm/${name} is only ${mb.toFixed(2)} MB; ` +
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

// The files being there is not the engine working: 0.20.1 shipped a pair of the
// right names and sizes that could not open a database (check-engine.mjs). With
// every file present, each build is run through a database's life before publish.
if (problems.length === 0) {
  const { checkEngine } = await import('./check-engine.mjs');
  for (const r of await checkEngine()) {
    if (r.skipped) console.log(`publish check: the ${r.name} build not run here (${r.skipped})`);
    else if (!r.ok) {
      problems.push(
        `dist/wasm/${r.file} (the ${r.name} build) does not work: ${r.problem}. ` +
          'Rebuild it (`npm run build:wasm`) or take the CI build from the release',
      );
    }
  }
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

console.log('publish check: all required files present, and the engine runs');
