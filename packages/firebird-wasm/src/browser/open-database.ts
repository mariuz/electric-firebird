/**
 * Browser-safe `openDatabase(uri, options?)` factory (`M18 Item 3`).
 *
 * Supports `memory://`, `idb://<name>`, `opfs://<name>`, and bare IndexedDB
 * store names without importing Node.js-only `FirebirdLite` dependencies.
 */

import { FirebirdBrowser, type FirebirdBrowserOptions } from './firebird-browser';

export interface OpenBrowserDatabaseOptions extends FirebirdBrowserOptions {
  /**
   * When `true`, eagerly attaches/creates the underlying WASM database before
   * resolving `openDatabase()`.
   * @default false
   */
  eager?: boolean;
}

/**
 * Open a browser/WASM Firebird database (`memory://`, `idb://`, `opfs://`, or store name).
 */
export async function openBrowserDatabase(
  uri = 'memory://',
  options: OpenBrowserDatabaseOptions = {},
): Promise<FirebirdBrowser> {
  const cleanUri = uri.trim() || 'memory://';
  const normalized = cleanUri.startsWith('wasm://')
    ? cleanUri.slice('wasm://'.length) || 'memory://'
    : cleanUri;
  const db = new FirebirdBrowser(normalized, options);
  if (options.eager) {
    await db.query('SELECT 1 FROM RDB$DATABASE');
  }
  return db;
}
