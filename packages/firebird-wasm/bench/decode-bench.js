#!/usr/bin/env node
'use strict';

/**
 * decode-bench.js – decode-time benchmark and regression guard.
 *
 * Step 2 of `docs/plans/typed-results.md`: the plan argues from a measurement
 * taken once, on one machine, and step 1 was chosen because building row
 * objects was 33 ms of a 45 ms decode. Nothing re-measures that, so nothing
 * would notice if it came back.
 *
 * Two jobs, deliberately in one script:
 *
 *   1. **Report.** Print — and optionally record — the stage breakdown for a
 *      fixed result set, so the plan's table has a running counterpart.
 *   2. **Guard.** Fail when a decode stops being meaningfully faster than the
 *      `Object.fromEntries` construction it replaced.
 *
 * Every check is a *ratio between two measurements taken in the same process*,
 * never a wall-clock threshold. A shared CI runner is several times slower than
 * a developer machine and varies run to run, so an absolute millisecond limit
 * is either too loose to catch anything or too tight to survive a noisy
 * neighbour. A ratio moves when the code does.
 *
 * Step 1 can be undone in two distinct ways, and it takes two different
 * measurements to see them — a single scenario would miss one:
 *
 *   • **The generated constructor stops being used** — removed, or `new
 *     Function` starts throwing under a policy so every result set silently
 *     takes the fallback. Visible as `large` and `page` collapsing to ~1.0×.
 *   • **The builder cache is lost**, so a constructor is compiled per query.
 *     This made small queries *slower* than the code it replaced. It is
 *     invisible in `large` and `page` — one compile amortised over a whole
 *     result set costs nothing — so `cache` measures it directly.
 *
 * Absolute times are recorded and never asserted on. They are for reading a
 * trend; use the JSON, not the exit code, for that.
 *
 *   node bench/decode-bench.js
 *   node bench/decode-bench.js bench-results/decode.json
 *   npm run bench -- bench-results/decode.json
 *
 * The optional path is positional rather than a `--flag` because npm does not
 * forward flags reliably through `npm run`: it claims `--json` outright, and
 * the root package's `bench` script hops through a second `npm run` that drops
 * others. A bare path survives both hops unchanged.
 *
 * Requires `npm run build` first: it measures the built package, so what it
 * reports is what a caller actually runs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let decodeResultSet;
let applyTypes;
let firebirdTypeName;
try {
  ({ decodeResultSet } = require('../dist/browser/engine-transport.js'));
  ({ applyTypes } = require('../dist/browser/value-types.js'));
  ({ firebirdTypeName } = require('../dist/browser/field-types.js'));
} catch (err) {
  process.stderr.write(
    `Cannot load the built package: ${err && err.message}\n` +
      'Run `npm run build -w packages/firebird-wasm` first.\n',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The fixed result set
// ---------------------------------------------------------------------------

// From firebird/impl/sqlda_pub.h, matching src/browser/field-types.ts.
const SQL_VARYING = 448;
const SQL_LONG = 496;
const SQL_TIMESTAMP = 510;
const SQL_INT64 = 580;

/**
 * The five columns the plan measured: `INTEGER`, `VARCHAR(40)`,
 * `NUMERIC(18,4)`, `BIGINT`, `TIMESTAMP`.
 *
 * `NUMERIC` and `BIGINT` are both `SQL_INT64` and differ only by scale, which
 * is the one distinction the `bigint` conversion has to get right — so the
 * typed measurement below exercises a real decision rather than a uniform pass.
 *
 * `suffix` exists only for the cache scenario, which needs column lists that
 * differ in name while staying identical in size and shape.
 */
function columns(suffix = '') {
  return [
    { name: `ID${suffix}`, type: SQL_LONG, subType: 0, scale: 0, length: 4, nullable: false },
    { name: `NAME${suffix}`, type: SQL_VARYING, subType: 0, scale: 0, length: 40, nullable: true },
    { name: `AMOUNT${suffix}`, type: SQL_INT64, subType: 1, scale: -4, length: 8, nullable: true },
    { name: `ACCOUNT${suffix}`, type: SQL_INT64, subType: 0, scale: 0, length: 8, nullable: true },
    { name: `CREATED${suffix}`, type: SQL_TIMESTAMP, subType: 0, scale: 0, length: 8, nullable: true },
  ];
}

/**
 * Serialise a result set exactly as the engine does.
 *
 * Values are derived from the row index rather than random, so two runs on one
 * machine are comparable and any difference is the code's. The shapes are the
 * ones the engine really emits: an exact decimal string for `NUMERIC`, a string
 * for a `BIGINT` past 2⁵³, ISO-8601 with Firebird's fourth fractional digit for
 * `TIMESTAMP`.
 */
function makeResultSet(rowCount, suffix = '') {
  const rows = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const cents = (i * 7919) % 1000000;
    rows[i] = [
      i + 1,
      `Customer ${i} of ${rowCount}`,
      `${Math.floor(cents / 10000)}.${String(cents % 10000).padStart(4, '0')}`,
      String(9007199254740993n + BigInt(i)),
      `2026-08-11T${String(i % 24).padStart(2, '0')}:22:33.4567`,
    ];
  }
  return JSON.stringify({ columns: columns(suffix), rows });
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/**
 * `decodeResultSet` as it stood before the generated constructor.
 *
 * Copied rather than imported, because the point is to keep measuring the thing
 * that was replaced: this must not change when the real decoder does. It is
 * also what the fallback path still does today, so a decoder that stops using
 * the generated constructor measures 1.0× against it — which is exactly the
 * signal the guard reads.
 */
function decodeLegacy(json) {
  const parsed = JSON.parse(json);

  const fields = parsed.columns.map((c) => ({
    name: c.name.toUpperCase(),
    type: c.type,
    typeName: firebirdTypeName(c.type, c.scale),
    subType: c.subType,
    scale: c.scale,
    length: c.length,
    nullable: c.nullable,
  }));

  const names = fields.map((f) => f.name);
  const rows = parsed.rows.map((cols) =>
    Object.fromEntries(names.map((name, i) => [name, cols[i]])),
  );

  return { rows, fields };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const WARMUP = 3;
const SAMPLES = 7;

/**
 * The fastest of several runs, in milliseconds.
 *
 * Minimum rather than mean or median: noise only ever adds time — a scheduler
 * preemption, a GC pause, another job on the same host — so the smallest sample
 * is the closest look at what the code costs. It is also the estimator that
 * makes the guard hardest to trip by accident, which matters more here than
 * knowing the average.
 */
function fastest(fn) {
  for (let i = 0; i < WARMUP; i++) fn();

  let best = Infinity;
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    fn();
    const elapsed = performance.now() - started;
    samples.push(Number(elapsed.toFixed(3)));
    if (elapsed < best) best = elapsed;
  }
  return { best, samples };
}

/** Keep the last result reachable so the work cannot be optimised away. */
let sink = null;

// ---------------------------------------------------------------------------
// Scenarios: current decoder against the construction it replaced
// ---------------------------------------------------------------------------

/**
 * `floor` is the speedup a decode must keep over the baseline, or null for
 * report-only.
 *
 * The floors sit well under what the change actually delivers — measured
 * around 2.1–2.7× where a floor is 1.4× — because the failure being guarded
 * against is a *collapse* to ~1.0×, not a few percent of drift. A floor tight
 * enough to catch drift would fail on runner noise instead, and a benchmark
 * that cries wolf gets deleted rather than fixed.
 */
const SCENARIOS = [
  {
    name: 'large',
    description: '10,000 rows × 5 columns, decoded once',
    rowCount: 10000,
    decodes: 1,
    floor: 1.4,
  },
  {
    name: 'page',
    description: '100-row page × 5 columns, decoded 200 times',
    rowCount: 100,
    decodes: 200,
    floor: 1.4,
  },
  {
    name: 'single',
    description: 'single row × 5 columns, decoded 2,000 times',
    rowCount: 1,
    decodes: 2000,
    // Report-only, and the reason is worth keeping: at one row, `JSON.parse`
    // of the column metadata is around three quarters of the decode, so even
    // making row construction free would move the total by little. The
    // measured ratio sits at 0.99–1.10× — indistinguishable from no change,
    // and impossible to set a floor under without flagging noise as a
    // regression. It stays because it answers the question the plan raised
    // about small queries: the change must not make them *worse*, and a number
    // near 1.0 is that answer. What guards the cache is `cache`, below.
    floor: null,
  },
];

function runScenario(scenario) {
  const json = makeResultSet(scenario.rowCount);
  const { decodes } = scenario;

  const current = fastest(() => {
    for (let i = 0; i < decodes; i++) sink = decodeResultSet(json);
  });
  const legacy = fastest(() => {
    for (let i = 0; i < decodes; i++) sink = decodeLegacy(json);
  });
  // Neither row construction nor anything else this library controls — the
  // floor any future change to the wire format would have to beat.
  const parse = fastest(() => {
    for (let i = 0; i < decodes; i++) sink = JSON.parse(json);
  });

  const speedup = legacy.best / current.best;

  return {
    name: scenario.name,
    description: scenario.description,
    rowCount: scenario.rowCount,
    decodes,
    jsonBytes: Buffer.byteLength(json),
    currentMs: current.best,
    legacyMs: legacy.best,
    parseMs: parse.best,
    speedup,
    floor: scenario.floor,
    passed: scenario.floor === null ? null : speedup >= scenario.floor,
    samples: { current: current.samples, legacy: legacy.samples },
  };
}

// ---------------------------------------------------------------------------
// Scenario: the builder cache
// ---------------------------------------------------------------------------

/** Distinct column signatures to cycle through — more than MAX_ROW_BUILDERS. */
const DISTINCT_SIGNATURES = 200;

/** The speedup reusing a signature must keep over meeting a fresh one. */
const CACHE_FLOOR = 1.5;

/**
 * Whether a builder is reused across queries with the same column list.
 *
 * Measured as the same signature 2,000 times against 2,000 decodes cycling
 * through {@link DISTINCT_SIGNATURES} different ones — more than the cache
 * holds, so nearly every one is a miss that has to compile. The column lists
 * are the same size and shape and differ only in name, so parsing costs the
 * same on both sides and the difference is compilation.
 *
 * Healthy this is a stable ~2.0×. If the cache were removed both sides would
 * compile per decode and it would fall to ~1.0×, which is the failure the
 * plan calls out: building a constructor per result set turned 2.5 ms into
 * 5.5 ms across 2,000 one-row queries, a regression for the commonest query
 * shape there is.
 */
function runCacheScenario() {
  const decodes = 2000;
  const same = makeResultSet(1);
  const fresh = Array.from({ length: DISTINCT_SIGNATURES }, (_, i) =>
    makeResultSet(1, String(i).padStart(3, '0')),
  );

  const reused = fastest(() => {
    for (let i = 0; i < decodes; i++) sink = decodeResultSet(same);
  });
  const compiled = fastest(() => {
    for (let i = 0; i < decodes; i++) sink = decodeResultSet(fresh[i % fresh.length]);
  });

  const speedup = compiled.best / reused.best;

  return {
    name: 'cache',
    description: `1 row, 2,000 decodes: one signature vs ${DISTINCT_SIGNATURES} of them`,
    decodes,
    reusedMs: reused.best,
    compiledMs: compiled.best,
    speedup,
    floor: CACHE_FLOOR,
    passed: speedup >= CACHE_FLOOR,
    samples: { reused: reused.samples, compiled: compiled.samples },
  };
}

// ---------------------------------------------------------------------------
// Scenario: opt-in typed values
// ---------------------------------------------------------------------------

/**
 * What the opt-in conversions cost on top of a decode.
 *
 * Reported, never asserted on: there is no earlier implementation to compare
 * against, so there is no ratio to hold. The number is here for step 4 of the
 * plan — whether these become the defaults in the next major — and that
 * decision wants a measurement, not an intuition.
 *
 * Two of the five columns convert: `ACCOUNT` to `bigint` and `CREATED` to
 * `Date`. `AMOUNT` deliberately does not, being a scaled `NUMERIC` in the same
 * 64-bit type, so this also measures the skip working.
 */
function runTypedScenario() {
  const json = makeResultSet(10000);
  const options = { bigint: true, dates: true };

  const plain = fastest(() => {
    sink = decodeResultSet(json);
  });
  const typed = fastest(() => {
    sink = applyTypes(decodeResultSet(json), options);
  });

  return {
    name: 'typed',
    description: '10,000 rows, bigint + dates conversion',
    rowCount: 10000,
    jsonBytes: Buffer.byteLength(json),
    decodeMs: plain.best,
    decodeAndConvertMs: typed.best,
    conversionMs: typed.best - plain.best,
    overheadPercent: ((typed.best - plain.best) / plain.best) * 100,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ms = (value) => `${value.toFixed(2)} ms`;
const times = (value) => `${value.toFixed(2)}×`;

function verdict(passed) {
  if (passed === null) return 'report';
  return passed ? 'ok' : 'REGRESSED';
}

function report(results, cache, typed) {
  const rows = [
    ['scenario', 'current', 'baseline', 'JSON.parse', 'speedup', 'floor', ''],
    ...results.map((r) => [
      r.name,
      ms(r.currentMs),
      ms(r.legacyMs),
      ms(r.parseMs),
      times(r.speedup),
      r.floor === null ? '—' : times(r.floor),
      verdict(r.passed),
    ]),
    [
      cache.name,
      ms(cache.reusedMs),
      ms(cache.compiledMs),
      '—',
      times(cache.speedup),
      times(cache.floor),
      verdict(cache.passed),
    ],
  ];

  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) =>
    r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');

  process.stdout.write(
    `\nDecode benchmark — fastest of ${SAMPLES} runs after ${WARMUP} warmups, `
      + `Node ${process.version} on ${os.cpus().length}× ${process.platform}-${process.arch}\n\n`,
  );
  process.stdout.write(`${line(rows[0])}\n`);
  process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows.slice(1)) process.stdout.write(`${line(row)}\n`);

  process.stdout.write('\n');
  for (const r of results) {
    process.stdout.write(
      `${r.name}: ${r.description} — ${(r.jsonBytes / 1048576).toFixed(2)} MB of JSON\n`,
    );
  }
  // "baseline" means something different in this row, so it is spelled out
  // rather than left to the column header.
  process.stdout.write(`${cache.name}: ${cache.description}, baseline column is the fresh ones\n`);
  process.stdout.write(
    `typed: ${typed.description} — ${ms(typed.decodeMs)} to decode, `
      + `${ms(typed.conversionMs)} to convert, ${typed.overheadPercent.toFixed(0)}% on top\n`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse the command line: at most one path, and nothing else.
 *
 * Strict rather than lenient because the lenient version was wrong in a way
 * that looked fine — an argument it did not recognise was ignored, so a run
 * meant to record its results reported success having written no file.
 */
function parseArgs(argv) {
  if (argv.length === 0) return { jsonPath: null };
  if (argv.length > 1 || argv[0].startsWith('-')) {
    return { error: `usage: decode-bench.js [output.json] (got: ${argv.join(' ')})` };
  }
  return { jsonPath: argv[0] };
}

function main(argv) {
  const { jsonPath, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`${error}\n`);
    return 2;
  }

  const results = SCENARIOS.map(runScenario);
  const cache = runCacheScenario();
  const typed = runTypedScenario();
  report(results, cache, typed);

  if (jsonPath) {
    // Timings are rounded on the way out. Full float precision in a file meant
    // for reading a trend suggests a resolution the measurement does not have.
    const round = (value) =>
      typeof value === 'number' && !Number.isInteger(value)
        ? Number(value.toFixed(3))
        : value;
    const record = {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: os.cpus().length,
      warmup: WARMUP,
      samples: SAMPLES,
      scenarios: results,
      cache,
      typed,
    };
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(record, (_key, value) => round(value), 2)}\n`);
    process.stdout.write(`\nWrote ${jsonPath}\n`);
  }

  const regressed = [...results, cache].filter((r) => r.passed === false);
  if (regressed.length === 0) return 0;

  const detail = regressed
    .map((r) => `${r.name} at ${times(r.speedup)} (floor ${times(r.floor)})`)
    .join(', ');
  // Losing the constructor entirely drags `cache` down with it, so the wider
  // failure is named first — otherwise the message sends a reader after the
  // cache when it is the whole fast path that is gone.
  const cause = regressed.some((r) => r.name !== 'cache')
    ? 'Row construction is no longer meaningfully faster than Object.fromEntries,\n'
      + 'so the generated constructor is probably not being used at all.\n'
    : 'Row builders are no longer being reused across queries with the same\n'
      + 'column list, so one is compiled per query. That is a regression for\n'
      + 'small queries, which are most queries.\n';
  process.stderr.write(
    `\nDecode regressed: ${detail}\n${cause}See docs/plans/typed-results.md §1.\n`,
  );
  return 1;
}

process.exitCode = main(process.argv.slice(2));
