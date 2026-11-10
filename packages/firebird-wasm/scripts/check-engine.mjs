/**
 * check-engine.mjs – run the engine in dist/wasm before it is published.
 *
 * Run by check-publish.mjs (`prepublishOnly`), and on its own with
 * `npm run check:engine` after `npm run build` and a WASM build.
 *
 * The file checks in check-publish.mjs pass for any `.wasm` of the right name and
 * size, and 0.20.1 shipped such a pair: present, about 10 MB, its glue agreeing
 * with it on every export, and unable to open a database. Under Node every call
 * that attaches (`createDatabase` on a new file, `attachDatabase` on a database
 * another build made) trapped with `RuntimeError: null function or function
 * signature mismatch`, so no statement ran at all. The CI build of the same
 * sources was fine; the published binaries were not CI's. Nothing short of
 * running the engine shows that, so this script runs it: each build creates a
 * database, answers `SELECT 1 FROM rdb$database`, and keeps a row it is given.
 *
 * Each build runs in a child process with CHECK_ENGINE_TIMEOUT_MS (60 s) to answer: a build that traps inside
 * a worker thread can block the main thread for good, and a check that hangs would hold the publish, so the
 * child is killed and silence counts as a failure.
 *
 * Exit code 0 when every build that can run here passes, 1 otherwise. The threaded
 * build needs SharedArrayBuffer and worker threads; where Node cannot start it,
 * it is reported as not checked rather than failed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(pkgDir, 'dist/browser/index.js');

const TIMEOUT_MS = Number(process.env.CHECK_ENGINE_TIMEOUT_MS) || 60_000;
const SILENT = 'no answer within';

/**
 * Run one build through a database's life in a child process; returns what went wrong, or null. A child, because
 * a trap in the threaded build's worker can block the main thread itself (its proxied calls wait synchronously),
 * and then no timer in this process would ever fire: the child is killed when its time is up.
 */
export function checkBuild(threads) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--one', threads ? 'threads' : 'single'], {
    encoding: 'utf8', timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGKILL') {
    return `${SILENT} ${TIMEOUT_MS / 1000} s (a trap in a worker thread can leave the engine silent)`;
  }
  const line = child.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
  if (!line) return `the check's process ended without a result (exit ${child.status}): ${child.stderr.trim().split('\n')[0] ?? ''}`;
  return JSON.parse(line).problem;
}

async function runBuild(threads) {
  const { FirebirdBrowser, DirectTransport } = await import(pathToFileURL(entry).href);
  const db = new FirebirdBrowser(`memory://check-engine-${threads ? 'mt' : 'st'}`, {
    transport: new DirectTransport({ threads }),
  });
  try {
    const one = await db.query('SELECT 1 AS X FROM rdb$database');
    if (one.rows?.[0]?.X !== 1) return `SELECT 1 answered ${JSON.stringify(one.rows)}`;
    await db.exec('CREATE TABLE check_engine (id INTEGER NOT NULL PRIMARY KEY, label VARCHAR(20))');
    await db.query('INSERT INTO check_engine (id, label) VALUES (?, ?)', [7, 'kept']);
    const back = await db.query('SELECT id, label FROM check_engine');
    const row = back.rows?.[0];
    if (back.rows?.length !== 1 || row?.ID !== 7 || row?.LABEL !== 'kept') {
      return `a row written came back as ${JSON.stringify(back.rows)}`;
    }
    return null;
  } catch (err) {
    return `${err?.name ?? 'Error'}: ${String(err?.message ?? err).split('\n')[0]}`;
  } finally {
    await db.close().catch(() => {});
  }
}

/** Every build's result: { name, file, ok, skipped, problem }. */
export async function checkEngine(report = () => {}) {
  const builds = [
    { name: 'without threads', file: 'firebird-embedded-st.wasm', threads: false },
    { name: 'threaded', file: 'firebird-embedded.wasm', threads: true },
  ];
  const results = [];
  const done = (r) => { results.push(r); report(r); };
  for (const build of builds) {
    if (!fs.existsSync(path.join(pkgDir, 'dist/wasm', build.file))) {
      done({ ...build, ok: false, problem: `dist/wasm/${build.file} is missing` });
      continue;
    }
    if (build.threads && typeof SharedArrayBuffer === 'undefined') {
      done({ ...build, ok: true, skipped: 'SharedArrayBuffer is not available here' });
      continue;
    }
    const problem = checkBuild(build.threads);
    // (a threaded build Node cannot start at all is not this check's business, so it is reported as not
    // checked; a build that starts and then fails or falls silent is a failure)
    const cannotStart = problem && !problem.startsWith(SILENT) && build.threads
      && /Worker is not defined|SharedArrayBuffer is not defined|crossOriginIsolated/.test(problem);
    if (cannotStart) done({ ...build, ok: true, skipped: problem });
    else done({ ...build, ok: !problem, problem });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // (the child: one build, its result as a line of JSON)
  const one = process.argv.indexOf('--one');
  if (one > 0) {
    const problem = await runBuild(process.argv[one + 1] === 'threads');
    console.log(JSON.stringify({ problem }));
    process.exit(0);
  }
  if (!fs.existsSync(entry)) {
    console.error('check-engine: dist/browser/index.js is missing; run `npm run build` first');
    process.exit(1);
  }
  const print = (r) => {
    if (r.skipped) console.log(`engine check: the ${r.name} build not checked here (${r.skipped})`);
    else if (r.ok) console.log(`engine check: the ${r.name} build creates a database, answers SELECT 1 and keeps a row`);
    else console.error(`engine check: the ${r.name} build (dist/wasm/${r.file}) fails: ${r.problem}`);
  };
  const results = await checkEngine(print);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
