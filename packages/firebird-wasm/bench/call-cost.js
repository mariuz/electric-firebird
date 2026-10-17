#!/usr/bin/env node
'use strict';

/**
 * call-cost.js – where one `query()` call's time goes, layer by layer.
 *
 * `decode-bench.js` measures decoding a large result set. This measures the
 * other end: small and medium queries, the kind a consumer sends many of,
 * where fixed per-call costs dominate. Each shape is timed five ways, each
 * one layer thinner than the last:
 *
 *   browser    FirebirdBrowser.query(), what an application calls
 *   transport  DirectTransport.query(), without the FirebirdBrowser layer
 *   c-call     _fb_query_params() with the SQL and parameters already on the
 *              heap: the C bridge, the engine, and the JSON written in C
 *   decode     UTF8ToString + decodeResultSet on a result already returned
 *   engine     the same fetch looped inside one EXECUTE BLOCK: the engine's
 *              own work, with no call boundary at all
 *
 * So `transport − c-call − decode` is the JS around the call (encoding the
 * parameters, the heap copies), `browser − transport` is FirebirdBrowser's
 * own layer, and `c-call − engine` is the bridge: statement lookup, opening
 * and closing the cursor, and writing JSON.
 *
 * It runs the WASM engine in this process (DirectTransport), with the
 * statement cache on (the default) and sharedReads on, so neither the
 * prepare nor a per-call transaction is in the numbers: what is left is the
 * call itself. A Worker adds a postMessage round trip on top, not measured
 * here. Medians over many calls; numbers are µs per call.
 *
 *   npm run build && node bench/call-cost.js [rounds]
 */

const path = require('path');
const dist = path.resolve(__dirname, '../dist/browser');
const { FirebirdBrowser } = require(path.join(dist, 'firebird-browser.js'));
const { DirectTransport, decodeResultSet, SHAPE_IDS } = require(path.join(dist, 'engine-transport.js'));
const { encodeParams } = require(path.join(dist, 'params.js'));
const { allocString } = require(path.resolve(__dirname, '../dist/wasm-loader.js'));

const ROUNDS = Number(process.argv[2] ?? 3);

const SHAPES = [
  {
    name: 'one value',
    sql: 'SELECT v FROM t WHERE id = ?',
    params: (i) => [i % 1000],
    calls: 2000,
    // The engine side: the same lookup, looped in PSQL.
    block: (n) => `EXECUTE BLOCK RETURNS (s INTEGER) AS DECLARE i INTEGER = 0; DECLARE x INTEGER;
      BEGIN s = 0; WHILE (i < ${n}) DO BEGIN SELECT v FROM t WHERE id = MOD(:i, 1000) INTO x; s = s + x; i = i + 1; END SUSPEND; END`,
  },
  {
    name: 'one row, 10 columns',
    sql: 'SELECT id, v, name, d, n, ts, id + 1, v + 1, name, d * 2 FROM t WHERE id = ?',
    params: (i) => [i % 1000],
    calls: 2000,
    block: (n) => `EXECUTE BLOCK RETURNS (s INTEGER) AS DECLARE i INTEGER = 0;
      DECLARE a INTEGER; DECLARE b INTEGER; DECLARE c VARCHAR(40); DECLARE dd DOUBLE PRECISION;
      DECLARE nn NUMERIC(18,2); DECLARE tt TIMESTAMP; DECLARE e INTEGER; DECLARE f INTEGER;
      DECLARE g VARCHAR(40); DECLARE h DOUBLE PRECISION;
      BEGIN s = 0; WHILE (i < ${n}) DO BEGIN
        SELECT id, v, name, d, n, ts, id + 1, v + 1, name, d * 2 FROM t WHERE id = MOD(:i, 1000)
          INTO a, b, c, dd, nn, tt, e, f, g, h;
        s = s + a; i = i + 1; END SUSPEND; END`,
  },
  {
    // The same ten columns with no row: what a call costs before any value.
    name: 'no row, 10 columns',
    sql: 'SELECT id, v, name, d, n, ts, id + 1, v + 1, name, d * 2 FROM t WHERE id = ?',
    params: (i) => [-1 - i],
    calls: 2000,
    block: (n) => `EXECUTE BLOCK RETURNS (s INTEGER) AS DECLARE i INTEGER = 0;
      DECLARE a INTEGER; DECLARE b INTEGER; DECLARE c VARCHAR(40); DECLARE dd DOUBLE PRECISION;
      DECLARE nn NUMERIC(18,2); DECLARE tt TIMESTAMP; DECLARE e INTEGER; DECLARE f INTEGER;
      DECLARE g VARCHAR(40); DECLARE h DOUBLE PRECISION;
      BEGIN s = 0; WHILE (i < ${n}) DO BEGIN
        FOR SELECT id, v, name, d, n, ts, id + 1, v + 1, name, d * 2 FROM t WHERE id = -1 - :i
          INTO a, b, c, dd, nn, tt, e, f, g, h DO s = s + a;
        i = i + 1; END SUSPEND; END`,
  },
  {
    name: '100 rows, 5 columns',
    sql: 'SELECT id, v, name, d, ts FROM t WHERE id BETWEEN ? AND ?',
    params: (i) => [(i * 7) % 900, ((i * 7) % 900) + 99],
    calls: 300,
    block: (n) => `EXECUTE BLOCK RETURNS (s INTEGER) AS DECLARE i INTEGER = 0;
      DECLARE a INTEGER; DECLARE b INTEGER; DECLARE c VARCHAR(40); DECLARE dd DOUBLE PRECISION; DECLARE tt TIMESTAMP;
      BEGIN s = 0; WHILE (i < ${n}) DO BEGIN
        FOR SELECT id, v, name, d, ts FROM t WHERE id BETWEEN MOD(:i * 7, 900) AND MOD(:i * 7, 900) + 99
          INTO a, b, c, dd, tt DO s = s + a;
        i = i + 1; END SUSPEND; END`,
  },
  {
    name: '1000 rows, 5 columns',
    sql: 'SELECT id, v, name, d, ts FROM t WHERE id >= ?',
    params: () => [0],
    calls: 60,
    block: (n) => `EXECUTE BLOCK RETURNS (s INTEGER) AS DECLARE i INTEGER = 0;
      DECLARE a INTEGER; DECLARE b INTEGER; DECLARE c VARCHAR(40); DECLARE dd DOUBLE PRECISION; DECLARE tt TIMESTAMP;
      BEGIN s = 0; WHILE (i < ${n}) DO BEGIN
        FOR SELECT id, v, name, d, ts FROM t WHERE id >= 0 INTO a, b, c, dd, tt DO s = s + a;
        i = i + 1; END SUSPEND; END`,
  },
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** µs per call: the median of five batches of `calls` calls each. */
async function perCall(calls, fn) {
  const batches = [];
  for (let b = 0; b < 5; b++) {
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) await fn(i);
    batches.push(((performance.now() - t0) * 1000) / calls);
  }
  return median(batches);
}

async function main() {
  const transport = new DirectTransport();
  const db = new FirebirdBrowser('memory://call-cost', { transport, sharedReads: true });
  await db.exec(
    'CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY, v INTEGER, name VARCHAR(40), ' +
      'd DOUBLE PRECISION, n NUMERIC(18,2), ts TIMESTAMP)',
  );
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push([i, i * 3, `name number ${i}`, i / 7, i + 0.25, '2026-10-10 12:00:00']);
  await db.execBatch('INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)', rows);

  const mod = transport.mod;
  const dbHandle = db.dbHandle;
  const results = {};

  for (let round = 0; round < ROUNDS; round++) {
    for (const shape of SHAPES) {
      const { calls } = shape;
      const r = (results[shape.name] ??= { browser: [], transport: [], 'c-call': [], decode: [], engine: [] });

      // Warm: the statement is prepared and kept, the shared transaction open.
      for (let i = 0; i < 20; i++) await db.query(shape.sql, shape.params(i), { rowMode: 'array' });

      r.browser.push(await perCall(calls, (i) => db.query(shape.sql, shape.params(i), { rowMode: 'array' })));
      r.transport.push(
        await perCall(calls, (i) => transport.query(dbHandle, 0, shape.sql, shape.params(i), 'array')),
      );

      // The raw C call: SQL and parameters copied to the heap once, outside the timing.
      const sqlPtr = allocString(mod, shape.sql);
      const encoded = encodeParams(shape.params(0));
      const paramPtr = mod._malloc(encoded.length);
      mod.HEAPU8.set(encoded, paramPtr);
      let lastJson = '';
      r['c-call'].push(
        await perCall(calls, () => {
          const ptr = mod._fb_query_params(dbHandle, 0, sqlPtr, paramPtr, encoded.length, SHAPE_IDS);
          if (!ptr) throw new Error(`query failed: ${shape.sql}`);
          mod._fb_free_result(ptr);
        }),
      );
      const ptr = mod._fb_query_params(dbHandle, 0, sqlPtr, paramPtr, encoded.length, SHAPE_IDS);
      r.decode.push(
        await perCall(calls, () => {
          lastJson = mod.UTF8ToString(ptr);
          // As DirectTransport decodes: a kept statement's columns by shape id.
          decodeResultSet(lastJson, 'array', transport.shapeColumns);
        }),
      );
      mod._fb_free_result(ptr);
      mod._free(paramPtr);
      mod._free(sqlPtr);

      // The engine alone: `calls` iterations inside one block, divided out.
      const t0 = performance.now();
      await db.query(shape.block(calls));
      const once = performance.now() - t0;
      const t1 = performance.now();
      await db.query(shape.block(1));
      const empty = performance.now() - t1;
      r.engine.push(((once - empty) * 1000) / (calls - 1));
      r.bytes = lastJson.length;
    }
  }

  await db.close();

  const fmt = (xs) => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const f = (x) => (x < 10 ? x.toFixed(1) : x.toFixed(0));
    return lo === hi || ROUNDS === 1 ? f(lo) : `${f(lo)}–${f(hi)}`;
  };
  console.log('µs per call (range over rounds); JSON bytes per result\n');
  console.log(
    ['shape', 'browser', 'transport', 'c-call', 'decode', 'engine', 'JSON bytes'].map((s) => s.padEnd(22)).join(''),
  );
  for (const [name, r] of Object.entries(results)) {
    console.log(
      [name, fmt(r.browser), fmt(r.transport), fmt(r['c-call']), fmt(r.decode), fmt(r.engine), String(r.bytes)]
        .map((s) => s.padEnd(22))
        .join(''),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
