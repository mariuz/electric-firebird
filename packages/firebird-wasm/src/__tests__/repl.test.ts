/**
 * repl.test.ts – what can be checked of the REPL element without a DOM.
 *
 * The element itself runs in Chromium against the real engine
 * (e2e/tests/browser-repl.spec.ts).  Here: importing it where there is no
 * DOM defines nothing and throws nothing, and FirebirdBrowser fits the
 * database shape it asks for.
 */

import type { FirebirdBrowser } from '../browser/firebird-browser';
import type { ReplDatabase } from '../repl';

const fits: (db: FirebirdBrowser) => ReplDatabase = (db) => db;
void fits;

describe('firebird-wasm/repl', () => {
  it('imports where there is no DOM, and defines nothing until asked', async () => {
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe('undefined');
    const repl = await import('../repl');
    expect(typeof repl.defineFirebirdRepl).toBe('function');
  });
});
