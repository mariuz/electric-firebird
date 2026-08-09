/**
 * check-suite-coverage.mjs – every spec belongs to exactly one config.
 *
 * There are three Playwright configs because there are three incompatible
 * servers: one that talks to a real Firebird server, one that serves the WASM
 * artifact with COOP/COEP, and one that serves the built demo *without* those
 * headers on purpose. A spec run under the wrong one fails confusingly, and a
 * spec run under none of them passes by not existing.
 *
 * Both mistakes are silent, and both have happened. This makes them loud.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(e2eDir, 'tests');

const CONFIGS = [
  'playwright.config.ts',
  'playwright.wasm.config.ts',
  'playwright.demo.config.ts',
];

/**
 * Pull the `testMatch` entries out of a config.
 *
 * Deliberately narrow: it accepts only `'**​/<name>.spec.ts'`, the form every
 * config uses today. Anything cleverer would need this parser to be cleverer
 * too, so it fails loudly rather than quietly under-matching and reporting a
 * spec as unclaimed.
 */
function patternsOf(configFile) {
  const source = fs.readFileSync(path.join(e2eDir, configFile), 'utf8');
  const block = source.match(/testMatch:\s*\[([^\]]*)\]/s);

  if (!block) {
    throw new Error(
      `${configFile} has no testMatch array. Every config needs one — a ` +
        `config without it runs every spec in tests/, including the ones ` +
        `belonging to the other two.`,
    );
  }

  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => {
    const pattern = m[1];
    if (!pattern.startsWith('**/') || pattern.slice(3).includes('/')) {
      throw new Error(
        `${configFile}: testMatch entry ${pattern} is not of the form ` +
          `'**/<name>.spec.ts'. Update this checker to understand it.`,
      );
    }
    return pattern.slice(3);
  });
}

const claims = new Map(); // spec basename -> configs claiming it
for (const config of CONFIGS) {
  for (const name of patternsOf(config)) {
    claims.set(name, [...(claims.get(name) ?? []), config]);
  }
}

const specs = fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.ts'));
const problems = [];

for (const spec of specs) {
  const owners = claims.get(spec) ?? [];
  if (owners.length === 0) {
    problems.push(
      `${spec} is not run by any config — add it to the testMatch of ` +
        `whichever config serves what it needs`,
    );
  } else if (owners.length > 1) {
    problems.push(
      `${spec} is claimed by ${owners.join(' and ')} — it would run twice, ` +
        `against different servers`,
    );
  }
}

for (const [name, owners] of claims) {
  if (!specs.includes(name)) {
    problems.push(`${owners.join(' and ')} matches ${name}, which no longer exists`);
  }
}

if (problems.length > 0) {
  console.error('\nPlaywright suite coverage is wrong:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`suite coverage: ${specs.length} specs, each claimed once`);
