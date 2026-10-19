/**
 * wasm-dispose.test.ts – letting a module go.
 *
 * Until 0.9.0 a loaded module stayed for the life of the process, and
 * `close()` released nothing: the threaded build's worker pool alone held
 * about 400 MB in Node.  Now `disposeFirebirdWasm` ends a module, and the
 * transports count their uses so the last `close()` disposes it, unless
 * whoever called `loadFirebirdWasm` still owns it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadFirebirdWasm,
  disposeFirebirdWasm,
  acquireFirebirdWasm,
  releaseFirebirdWasm,
  allocString,
  lastError,
} from '../wasm-loader';
import { FirebirdBrowser } from '../browser/firebird-browser';
import { DirectTransport } from '../browser/engine-transport';

const VARIANTS = [
  { name: 'with threads', threads: true, glue: 'firebird-embedded.js' },
  { name: 'without threads', threads: false, glue: 'firebird-embedded-st.js' },
].map((v) => ({ ...v, present: fs.existsSync(path.resolve(__dirname, '../../dist/wasm', v.glue)) }));

for (const variant of VARIANTS) {
  (variant.present ? describe : describe.skip)(`disposing a module, ${variant.name}`, () => {
    const options = { threads: variant.threads };

    it('ends the engine, detaches its databases, and leaves the cache', async () => {
      const mod = await loadFirebirdWasm(options);
      expect(mod._fb_init()).toBe(0);
      if (!mod.FS.analyzePath('/data').exists) mod.FS.mkdir('/data');
      const pathPtr = allocString(mod, '/data/dispose.fdb');
      const db = mod._fb_create_database(pathPtr);
      mod._free(pathPtr);
      expect(db).toBeGreaterThan(0);
      if (variant.threads) expect(typeof mod.fbTerminateThreads).toBe('function');

      await disposeFirebirdWasm(mod);
      expect(mod._fb_detach_database(db)).not.toBe(0);   // detached by the dispose
      expect(mod._fb_init()).not.toBe(0);
      expect(lastError(mod)).toMatch(/disposed/);

      const next = await loadFirebirdWasm(options);
      expect(next).not.toBe(mod);
      expect(next._fb_init()).toBe(0);
      await disposeFirebirdWasm(next);
      await disposeFirebirdWasm(next);   // idempotent
    });

    it('keeps a module while a transport uses it, and disposes it with the last', async () => {
      const a = await acquireFirebirdWasm(options);
      const b = await acquireFirebirdWasm(options);
      expect(b).toBe(a);
      await releaseFirebirdWasm(a);
      const c = await acquireFirebirdWasm(options);
      expect(c).toBe(a);   // still one user: kept
      await releaseFirebirdWasm(b);
      await releaseFirebirdWasm(c);
      expect(a._fb_init()).not.toBe(0);   // the last release disposed it
      const d = await acquireFirebirdWasm(options);
      expect(d).not.toBe(a);
      await releaseFirebirdWasm(d);
    });

    it('leaves a module loadFirebirdWasm returned to whoever loaded it', async () => {
      const owned = await loadFirebirdWasm(options);
      const used = await acquireFirebirdWasm(options);
      expect(used).toBe(owned);
      await releaseFirebirdWasm(used);
      expect(owned._fb_init()).toBe(0);   // not disposed: it is owned
      await disposeFirebirdWasm(owned);
    });

    it('closes databases one by one, and opens again after the last', async () => {
      const open = (name: string) =>
        new FirebirdBrowser(`memory://${name}`, { transport: new DirectTransport(options) });
      const first = open('dispose-first');
      const second = open('dispose-second');
      await first.exec('CREATE TABLE f (id INTEGER)');
      await second.exec('CREATE TABLE s (id INTEGER)');
      await first.close();
      // the module is shared: the other database goes on working
      await second.exec('INSERT INTO s VALUES (1)');
      expect((await second.query('SELECT id FROM s')).rows).toEqual([{ ID: 1 }]);
      await second.close();

      // the last close disposed it; the next database loads a new one
      const third = open('dispose-third');
      await third.exec('CREATE TABLE t (id INTEGER)');
      expect((await third.query('SELECT COUNT(*) AS N FROM t')).rows).toEqual([{ N: 0 }]);
      await third.close();
    });
  });
}
