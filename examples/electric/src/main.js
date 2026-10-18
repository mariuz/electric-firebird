import { FirebirdBrowser } from 'firebird-wasm/browser';
import { syncShapeToTable, tableFromSchema } from 'firebird-wasm/electric';
import { defineFirebirdRepl } from 'firebird-wasm/repl';

// The two sources: each a shape of the server's `notes`, synced into a
// table of its own in one local database.
const SOURCES = [
  { key: 'pg', table: 'pg_notes', shape: '/electric/v1/shape' },
  { key: 'fb', table: 'fb_notes', shape: '/firebird/v1/shape' },
];

const engineLine = document.getElementById('engine');

(async () => {
  // Persisted in IndexedDB: a reload finds the rows and the sync position,
  // and the sync resumes from there instead of copying everything again.
  const db = new FirebirdBrowser('electric-example', {
    worker: new Worker(new URL('./engine-worker.js', import.meta.url)),
  });
  const { rows } = await db.query("SELECT TRIM(rdb$get_context('SYSTEM', 'ENGINE_VERSION')) AS V FROM rdb$database");
  engineLine.textContent = `Firebird ${rows[0].V} in a Worker, ` +
    (globalThis.crossOriginIsolated ? 'the threaded build (cross-origin isolated page).' : 'the build without threads.');
  engineLine.dataset.ready = 'true';

  defineFirebirdRepl();
  document.querySelector('firebird-repl').db = db;

  await Promise.all(SOURCES.map((source) => follow(db, source)));
})().catch((err) => {
  engineLine.textContent = `Could not start: ${err.message ?? err}`;
  engineLine.dataset.error = engineLine.textContent;
});

async function follow(db, { key, table, shape }) {
  const section = document.querySelector(`[data-source="${key}"]`);
  const status = section.querySelector('[data-status]');
  const list = section.querySelector('[data-list]');
  const shapeUrl = new URL(shape, location.href).href;
  const setStatus = (state, text) => {
    status.dataset.state = state;
    status.textContent = text;
  };

  try {
    // The app makes the table; tableFromSchema writes its DDL from the
    // types the shape reports, which the first response carries.
    const exists = await db.query('SELECT COUNT(*) AS N FROM rdb$relations WHERE rdb$relation_name = ?', [table.toUpperCase()]);
    if (Number(exists.rows[0].N) === 0) {
      const response = await fetch(`${shapeUrl}?table=notes&offset=-1`);
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const schema = JSON.parse(response.headers.get('electric-schema'));
      await response.body?.cancel();
      await db.exec(tableFromSchema(table, schema));
    }

    setStatus('copying', 'copying…');
    const sync = await syncShapeToTable(db, {
      shape: { url: shapeUrl, params: { table: 'notes' } },
      table,
      shapeKey: table,
      onError: (err) => setStatus('error', `stopped: ${err.message}`),
    });

    // Every batch the sync applies posts electric_<shapeKey> when it commits.
    const notes = await db.live(`SELECT id, title, done FROM ${table} ORDER BY id`, { events: [`electric_${table}`] }, (rows) => {
      list.replaceChildren(...(rows.length ? rows.map(item) : [empty()]));
    });

    await sync.upToDate;
    // The batch's event reaches live() at its next poll; read now, so the
    // list is the complete copy by the time the status says so.
    await notes.refresh();
    if (!sync.error) setStatus('live', 'live: following every change');
  } catch (err) {
    setStatus('error', `error: ${err.message ?? err}`);
  }

  // Writes go to the source; what the list shows is only what came back.
  const api = (method, rest = '', body) => fetch(`/api/${key}/notes${rest}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  }).catch((err) => setStatus('error', `write failed: ${err.message}`));

  section.querySelector('[data-add]').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.elements.title;
    api('POST', '', { title: input.value });
    input.value = '';
  });
  list.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const id = button.closest('li').dataset.id;
    if (button.dataset.action === 'toggle') api('POST', `/${id}/toggle`);
    else api('DELETE', `/${id}`);
  });
}

function item(row) {
  const li = document.createElement('li');
  li.dataset.id = String(row.ID);
  li.dataset.title = row.TITLE;
  li.dataset.done = String(Boolean(row.DONE));
  const title = document.createElement('span');
  title.textContent = row.TITLE;
  li.append(title, button('toggle', row.DONE ? 'Undo' : 'Done'), button('delete', 'Delete'));
  return li;
}

function button(action, text) {
  const b = document.createElement('button');
  b.dataset.action = action;
  b.textContent = text;
  return b;
}

function empty() {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = 'No notes yet.';
  return li;
}
