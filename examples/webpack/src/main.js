import { FirebirdBrowser } from 'firebird-wasm/browser';

const out = document.getElementById('result');

(async () => {
  try {
    const db = new FirebirdBrowser('example', {
      worker: new Worker(new URL('./engine-worker.js', import.meta.url)),
    });

    await db.exec('RECREATE TABLE notes (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(200) NOT NULL)');
    await db.exec('INSERT INTO notes (id, title) VALUES (?, ?)', [1, 'Hello']);
    const { rows } = await db.query('SELECT id, title FROM notes WHERE id = ?', [1]);
    const engine = await db.query("SELECT TRIM(rdb$get_context('SYSTEM', 'ENGINE_VERSION')) AS v FROM RDB$DATABASE");
    await db.close();

    out.textContent = JSON.stringify(rows);
    out.dataset.rows = JSON.stringify(rows);
    out.dataset.engine = engine.rows[0].V;
    out.dataset.isolated = String(globalThis.crossOriginIsolated);
    out.dataset.done = 'true';
  } catch (err) {
    out.textContent = String(err && err.message ? err.message : err);
    out.dataset.error = out.textContent;
  }
})();
