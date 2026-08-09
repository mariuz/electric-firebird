/**
 * demo.js – the Firebird WASM playground.
 *
 * Drives the real `FirebirdBrowser` against the real engine.  The engine runs
 * in a Web Worker because it is built with pthreads and blocks on mutexes
 * while opening a database — doing that on the main thread deadlocks the page.
 */

import { FirebirdBrowser } from './firebird-browser.mjs';

const DB_NAME = 'demo';

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

/**
 * `mode` is declared rather than inferred.  The heuristic further down is fine
 * for whatever a visitor types, but these are the examples — `EXECUTE BLOCK`
 * returns rows while looking nothing like a SELECT, and guessing wrong on a
 * curated example is a self-inflicted bug.
 */
const EXAMPLES = [
  {
    id: 'schema',
    title: 'Create the schema',
    blurb: 'Tables and seed data. Run this first.',
    mode: 'exec',
    // RECREATE rather than CREATE, so the example can be run twice without
    // failing on the second attempt — which visitors will do.
    sql: `RECREATE TABLE departments (
  id    INTEGER     NOT NULL PRIMARY KEY,
  name  VARCHAR(40) NOT NULL
);

RECREATE TABLE employees (
  id          INTEGER     NOT NULL PRIMARY KEY,
  name        VARCHAR(60) NOT NULL,
  dept_id     INTEGER,
  manager_id  INTEGER,
  salary      NUMERIC(10,2),
  hired       DATE
);

INSERT INTO departments VALUES (1, 'Engineering');
INSERT INTO departments VALUES (2, 'Design');
INSERT INTO departments VALUES (3, 'Support');

INSERT INTO employees VALUES (1, 'Ada Lovelace',     1, NULL, 148000.00, '2016-03-01');
INSERT INTO employees VALUES (2, 'Grace Hopper',     1, 1,    132500.50, '2017-07-15');
INSERT INTO employees VALUES (3, 'Alan Turing',      1, 1,    121000.00, '2018-01-09');
INSERT INTO employees VALUES (4, 'Radia Perlman',    1, 2,     98750.25, '2020-05-04');
INSERT INTO employees VALUES (5, 'Susan Kare',       2, 1,     94000.00, '2019-11-18');
INSERT INTO employees VALUES (6, 'Paul Rand',        2, 5,     87300.75, '2021-02-22');
INSERT INTO employees VALUES (7, 'Mary Jackson',     3, 1,     76200.00, '2022-09-30');
INSERT INTO employees VALUES (8, 'Katherine Johnson',3, 7,     71500.00, '2023-04-11');`,
  },
  {
    id: 'filter',
    title: 'Filter and sort',
    blurb: 'The everyday SELECT.',
    mode: 'query',
    sql: `SELECT name, salary, hired
FROM employees
WHERE salary > 90000
ORDER BY salary DESC`,
  },
  {
    id: 'join',
    title: 'Join and aggregate',
    blurb: 'GROUP BY, HAVING and a JOIN.',
    mode: 'query',
    sql: `SELECT d.name          AS department,
       COUNT(*)         AS headcount,
       SUM(e.salary)    AS payroll,
       AVG(e.salary)    AS average
FROM employees e
JOIN departments d ON d.id = e.dept_id
GROUP BY d.name
HAVING COUNT(*) > 1
ORDER BY payroll DESC`,
  },
  {
    id: 'params',
    title: 'Parameterised query',
    blurb: 'Values bound to ? — never string-concatenated.',
    mode: 'query',
    sql: `SELECT name, salary
FROM employees
WHERE dept_id = ?
  AND salary >= ?
ORDER BY salary DESC`,
    params: '[1, 100000]',
  },
  {
    id: 'numbers',
    title: 'Exact numbers',
    blurb: 'Values JavaScript cannot hold, kept exact.',
    mode: 'query',
    // The point of this one: a double cannot represent either of the first two
    // values, so they cross into JavaScript as exact decimal *strings*.  The
    // column types above them are what tells you they are numbers.
    sql: `SELECT
  CAST(9007199254740993 AS BIGINT)          AS beyond_double,
  CAST(123456789.12345678 AS NUMERIC(18,8)) AS exact_decimal,
  CAST(1 AS NUMERIC(18,8)) / 3              AS one_third,
  CAST(0.1 AS DECFLOAT(34))
    + CAST(0.2 AS DECFLOAT(34))             AS tenth_plus_fifth
FROM RDB$DATABASE`,
  },
  {
    id: 'recursive',
    title: 'Recursive CTE',
    blurb: 'Walk the reporting chain.',
    mode: 'query',
    sql: `WITH RECURSIVE chain AS (
  SELECT id, name, manager_id, 1 AS depth
  FROM employees
  WHERE manager_id IS NULL

  UNION ALL

  SELECT e.id, e.name, e.manager_id, c.depth + 1
  FROM employees e
  JOIN chain c ON e.manager_id = c.id
)
SELECT depth, name
FROM chain
ORDER BY depth, name`,
  },
  {
    id: 'psql',
    title: 'EXECUTE BLOCK',
    blurb: "Firebird's procedural SQL, run ad hoc.",
    mode: 'query',
    sql: `EXECUTE BLOCK RETURNS (n INTEGER, fibonacci BIGINT)
AS
  DECLARE a BIGINT = 0;
  DECLARE b BIGINT = 1;
  DECLARE t BIGINT;
BEGIN
  n = 0;
  WHILE (n < 20) DO
  BEGIN
    fibonacci = a;
    SUSPEND;
    t = a + b;
    a = b;
    b = t;
    n = n + 1;
  END
END`,
  },
  {
    id: 'catalogue',
    title: 'System catalogue',
    blurb: 'Firebird describes itself in ordinary tables.',
    mode: 'query',
    sql: `SELECT TRIM(r.RDB$RELATION_NAME) AS table_name,
       COUNT(f.RDB$FIELD_NAME)    AS columns
FROM RDB$RELATIONS r
JOIN RDB$RELATION_FIELDS f
  ON f.RDB$RELATION_NAME = r.RDB$RELATION_NAME
WHERE COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0
GROUP BY r.RDB$RELATION_NAME
ORDER BY 1`,
  },
  {
    id: 'rollback',
    title: 'Transaction rollback',
    blurb: 'JavaScript, not SQL — undo a set of writes.',
    mode: 'js',
    // Shown in the editor and executed as written, so what you read is what
    // runs.  Anything else would be a diagram pretending to be a program.
    sql: `// Delete everyone, count the damage, then change our mind.
const before = await db.query('SELECT COUNT(*) AS n FROM employees');

await db.transaction(async (tx) => {
  await tx.exec('DELETE FROM employees');
  const inside = await tx.query('SELECT COUNT(*) AS n FROM employees');
  report('inside the transaction', inside.rows[0].N);
  await tx.rollback();
});

const after = await db.query('SELECT COUNT(*) AS n FROM employees');
report('before', before.rows[0].N);
report('after rollback', after.rows[0].N);`,
  },
];

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  list: document.getElementById('example-list'),
  sql: document.getElementById('sql'),
  params: document.getElementById('params'),
  run: document.getElementById('run'),
  timing: document.getElementById('timing'),
  result: document.getElementById('result'),
  reset: document.getElementById('reset'),
  isolation: document.getElementById('isolation-note'),
};

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let db = null;
let currentExample = null;

async function boot() {
  if (!globalThis.crossOriginIsolated) {
    setStatus('error', 'Not cross-origin isolated');
    showError(
      'This page is not cross-origin isolated, so the browser withholds ' +
        'SharedArrayBuffer and the engine cannot start.\n\n' +
        'On GitHub Pages a service worker supplies the COOP/COEP headers, ' +
        'which needs one reload on a first visit. If this message persists, ' +
        'the page is probably being served over plain HTTP — service workers ' +
        'require HTTPS or localhost.',
    );
    return;
  }

  setStatus('booting', 'Loading the engine…');

  try {
    const worker = new Worker(new URL('./firebird-engine-worker.js', import.meta.url));
    db = new FirebirdBrowser(DB_NAME, { worker });

    // Opening is lazy, so this is the first call that actually starts the
    // engine, restores any saved database and attaches to it.
    const hello = await db.query(
      "SELECT TRIM(rdb$get_context('SYSTEM', 'ENGINE_VERSION')) AS v FROM RDB$DATABASE",
    );

    setStatus('ready', `Firebird ${hello.rows[0].V} ready`);
    els.run.disabled = false;
  } catch (err) {
    setStatus('error', 'Engine failed to start');
    showError(String(err && err.message ? err.message : err));
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Decide how to run whatever is in the editor.
 *
 * Only used for hand-typed SQL: the examples say what they are.  A statement
 * returns rows if it starts with SELECT or WITH, or is an EXECUTE BLOCK that
 * declares RETURNS — the last of which is why this cannot just look at the
 * first word.
 */
function looksLikeQuery(sql) {
  const text = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').trim();
  if (/^(select|with)\b/i.test(text)) return true;
  if (/^execute\s+block\b/i.test(text) && /\breturns\b/i.test(text)) return true;
  return false;
}

function parseParams(raw) {
  const text = raw.trim();
  if (text === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Parameters are not valid JSON: ${text}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Parameters must be a JSON array, e.g. [1, "text"]');
  }
  return parsed;
}

async function run() {
  if (!db) return;

  els.run.disabled = true;
  setStatus('busy', 'Running…');
  els.timing.textContent = '';

  const sql = els.sql.value;
  const started = performance.now();

  try {
    const mode =
      currentExample?.mode ?? (looksLikeQuery(sql) ? 'query' : 'exec');

    if (mode === 'js') {
      await runScript(sql);
    } else if (mode === 'query') {
      renderRows(await db.query(sql, parseParams(els.params.value)));
    } else {
      renderExec(await db.exec(sql, parseParams(els.params.value)));
    }

    els.timing.textContent = `${Math.round(performance.now() - started)} ms`;
    setStatus('ready', 'Ready');
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
    els.timing.textContent = `failed after ${Math.round(performance.now() - started)} ms`;
    setStatus('ready', 'Ready');
  } finally {
    els.run.disabled = false;
  }
}

/**
 * Run the JavaScript examples.
 *
 * `AsyncFunction` rather than `eval`, so the snippet gets exactly two names —
 * `db` and `report` — and cannot quietly reach for anything else in this
 * module.  The page is a sandbox with nothing to steal, but a demo that
 * teaches sloppy evaluation is still teaching it.
 */
async function runScript(source) {
  const lines = [];
  const report = (label, value) => lines.push({ label, value });

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('db', 'report', source);
  await fn(db, report);

  renderRows({
    fields: [{ name: 'STEP' }, { name: 'VALUE' }],
    rows: lines.map((l) => ({ STEP: l.label, VALUE: l.value })),
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function clearResult() {
  els.result.replaceChildren();
}

function showError(message) {
  clearResult();
  const p = document.createElement('p');
  p.className = 'message error';
  p.textContent = message;
  els.result.append(p);
}

function renderExec(results) {
  clearResult();

  const total = results.reduce((sum, r) => sum + r.affectedRows, 0);
  const p = document.createElement('p');
  p.className = 'message ok';
  p.textContent =
    `${results.length} statement${results.length === 1 ? '' : 's'} executed` +
    (total > 0 ? `, ${total} row${total === 1 ? '' : 's'} affected` : '');
  els.result.append(p);
}

function renderRows(result) {
  clearResult();

  const { fields, rows } = result;

  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'message';
    p.textContent = 'No rows.';
    els.result.append(p);
    return;
  }

  const table = document.createElement('table');

  const head = document.createElement('tr');
  for (const field of fields) {
    const th = document.createElement('th');
    th.append(document.createTextNode(field.name));
    // The engine describes each column, so say what the type actually is —
    // it is the only thing distinguishing an exact NUMERIC arriving as
    // "20.25" from a VARCHAR that happens to hold digits.
    if (field.typeName) {
      const type = document.createElement('span');
      type.className = 'coltype';
      type.textContent = describeType(field);
      th.append(type);
    }
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const field of fields) {
      const td = document.createElement('td');
      const value = row[field.name];
      if (value === null || value === undefined) {
        td.className = 'null';
        td.textContent = 'NULL';
      } else {
        td.textContent = String(value);
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  scroll.append(table);

  const meta = document.createElement('p');
  meta.className = 'result-meta';
  meta.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}`;

  els.result.append(scroll, meta);
}

/** `NUMERIC(10,2)` reads better than `NUMERIC` with a scale of -2 elsewhere. */
function describeType(field) {
  if (field.scale) {
    return `${field.typeName}(${field.length ?? ''},${Math.abs(field.scale)})`;
  }
  return field.typeName;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function selectExample(example) {
  currentExample = example;
  els.sql.value = example.sql;
  els.params.value = example.params ?? '';

  for (const button of els.list.querySelectorAll('.example')) {
    button.setAttribute('aria-current', String(button.dataset.id === example.id));
  }
}

function buildExampleList() {
  for (const example of EXAMPLES) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example';
    button.dataset.id = example.id;
    button.setAttribute('aria-current', 'false');

    const title = document.createElement('strong');
    title.textContent = example.title;
    const blurb = document.createElement('span');
    blurb.textContent = example.blurb;

    button.append(title, blurb);
    button.addEventListener('click', () => selectExample(example));
    li.append(button);
    els.list.append(li);
  }
}

// Editing by hand means the example's declared mode no longer applies.
els.sql.addEventListener('input', () => {
  if (currentExample && els.sql.value !== currentExample.sql) {
    currentExample = null;
    for (const button of els.list.querySelectorAll('.example')) {
      button.setAttribute('aria-current', 'false');
    }
  }
});

els.run.addEventListener('click', () => void run());

els.sql.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!els.run.disabled) void run();
  }
});

els.reset.addEventListener('click', async () => {
  els.reset.disabled = true;
  try {
    // Close first: the connection holds the cross-tab lock and an open
    // IndexedDB handle, and deleting a database with a live connection blocks
    // until every one of them is gone.
    if (db) await db.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`firebird_${DB_NAME}`);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve(); // gone on the next reload regardless
    });
  } finally {
    location.reload();
  }
});

els.isolation.textContent = globalThis.crossOriginIsolated
  ? 'Cross-origin isolated, so SharedArrayBuffer and the engine’s threads are available.'
  : 'Waiting for cross-origin isolation…';

buildExampleList();
selectExample(EXAMPLES[0]);
void boot();
