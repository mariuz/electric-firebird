// Which threads does the engine start, and on which C call?
//
// Drives the C API of an artifact built by trace-threads.sh (function names
// kept, a stack logged at every pthread_create) through the calls a database
// makes in its life, and prints the threads each call started, named by the
// function that started them.
//
// Usage: node trace-threads.cjs <traced artifact dir> [firebird.conf text]
//   The conf text, with \n between lines, is written where this build reads
//   firebird.conf (FB_PREFIX, /usr/local/firebird: the engine fixes its root
//   before fb_init sets FIREBIRD) before fb_init runs.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const [dir, conf = ''] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node trace-threads.cjs <traced artifact dir> [firebird.conf text]');
  process.exit(2);
}
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-threads-')), 'threads.log');
process.env.FB_THREAD_LOG = log;

// The function that called Thread::start, and what it is.
const KNOWN = {
  'Why::TimerImplementation::start': 'timer (yvalve; first user: the trace config storage)',
  'MappingIpc::setup': 'auth mapping cache listener (Mapping.cpp)',
  CCH_init2: 'cache writer (cch.cpp, Super only)',
  VIO_init: 'garbage collector (vio.cpp, GCPolicy combined/background)',
  'Jrd::EventManager::init': 'event watcher (event.cpp)',
  LCK_init: 'lock manager blocking thread (lock.cpp, not Super)',
};

const phase = (name) => fs.appendFileSync(log, JSON.stringify({ phase: name }) + '\n');

(async () => {
  const createFirebirdModule = require(path.resolve(dir, 'firebird-embedded.js'));
  const mod = await createFirebirdModule({ locateFile: (p) => path.resolve(dir, p) });
  const str = (s) => {
    const n = mod.lengthBytesUTF8(s) + 1;
    const p = mod._malloc(n);
    mod.stringToUTF8(s, p, n);
    return p;
  };
  const err = () => mod.UTF8ToString(mod._fb_last_error());
  const check = (ok, what) => {
    if (!ok) throw new Error(`${what}: ${err()}`);
  };

  if (conf) {
    mod.FS.mkdirTree('/usr/local/firebird');
    mod.FS.writeFile('/usr/local/firebird/firebird.conf', conf.replace(/\\n/g, '\n') + '\n');
  }

  phase('fb_init');
  check(mod._fb_init() === 0, 'fb_init');
  mod.FS.mkdirTree('/data');

  phase('fb_create_database');
  let db = mod._fb_create_database(str('/data/trace.fdb'));
  check(db > 0, 'fb_create_database');
  const exec = (sql, tx = 0) => check(mod._fb_execute(db, tx, str(sql)) === 0, sql);
  const query = (sql) => {
    const p = mod._fb_query(db, 0, str(sql), 0);
    check(p, sql);
    const json = mod.UTF8ToString(p);
    mod._fb_free_result(p);
    return JSON.parse(json).rows;
  };

  phase('DDL');
  exec('CREATE TABLE t (id INTEGER PRIMARY KEY, s VARCHAR(40), n INTEGER)');
  exec('CREATE INDEX t_s ON t (s)');
  exec('CREATE PROCEDURE p (x INTEGER) RETURNS (y INTEGER) AS BEGIN y = x * 2; SUSPEND; END');
  exec("CREATE TRIGGER t_ai FOR t AFTER INSERT AS BEGIN POST_EVENT 'ping'; END");

  phase('DML (a trigger posts)');
  exec(`EXECUTE BLOCK AS DECLARE i INTEGER = 0; BEGIN
    WHILE (i < 5000) DO BEGIN INSERT INTO t VALUES (:i, 's' || :i, 0); i = i + 1; END END`);
  for (let i = 0; i < 20; i++) exec('UPDATE t SET n = n + 1 WHERE id < 1000');
  exec('DELETE FROM t WHERE id >= 4000');
  phase('SELECT, procedure');
  query('SELECT COUNT(*), SUM(n) FROM t');
  query('SELECT * FROM p(21)');

  phase('explicit transaction');
  const tx = mod._fb_start_transaction(db);
  check(tx > 0, 'fb_start_transaction');
  exec("INSERT INTO t VALUES (99999, 'tx', 0)", tx);
  check(mod._fb_commit(tx) === 0, 'fb_commit');

  phase('fb_events_subscribe');
  const ev = mod._fb_events_subscribe(db, str('ping'));
  check(ev > 0, 'fb_events_subscribe');
  phase('POST_EVENT, fb_events_poll');
  exec("INSERT INTO t VALUES (100000, 'ev', 0)");
  let fired = 0;
  for (let i = 0; i < 100 && !fired; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const p = mod._fb_events_poll(ev);
    fired = (JSON.parse(mod.UTF8ToString(p)).ping ?? 0);
    mod._fb_free_result(p);
  }
  check(fired > 0, 'event never arrived');
  phase('fb_events_cancel');
  check(mod._fb_events_cancel(ev) === 0, 'fb_events_cancel');

  phase('fb_detach_database');
  check(mod._fb_detach_database(db) === 0, 'fb_detach_database');
  phase('fb_attach_database');
  db = mod._fb_attach_database(str('/data/trace.fdb'));
  check(db > 0, 'fb_attach_database');
  query('SELECT COUNT(*) FROM t');
  const settings = query(`SELECT TRIM(RDB$CONFIG_NAME) || ' = ' || TRIM(COALESCE(RDB$CONFIG_VALUE, ''))
    FROM RDB$CONFIG WHERE RDB$CONFIG_NAME IN ('ServerMode', 'GCPolicy') ORDER BY 1`).map((r) => r[0]);
  phase('second fb_detach_database');
  check(mod._fb_detach_database(db) === 0, 'fb_detach_database');

  // Report.
  let current = '';
  const byPhase = new Map();
  for (const line of fs.readFileSync(log, 'utf8').trim().split('\n')) {
    const entry = JSON.parse(line);
    if (entry.phase) {
      current = entry.phase;
      byPhase.set(current, []);
      continue;
    }
    const caller = (entry.stack[1] ?? '?')
      .replace(/^firebird-embedded\.wasm\./, '')
      .replace(/\(anonymous namespace\)::/g, '')
      .replace(/\(.*$/, '');
    byPhase.get(current).push(`${KNOWN[caller] ?? caller}${entry.pthread ? ' [started by another thread]' : ''}`);
  }
  console.log(`settings: ${settings.join(', ')}`);
  let total = 0;
  for (const [name, threads] of byPhase) {
    total += threads.length;
    console.log(`  ${name.padEnd(28)} ${threads.length ? threads.join('; ') : '-'}`);
  }
  console.log(`  threads started: ${total}`);
  process.exit(0);
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
