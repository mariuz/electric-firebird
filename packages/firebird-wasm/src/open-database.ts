/**
 * Universal `openDatabase(uri, options?)` factory (`M18 Item 3`).
 *
 * Automatically selects `FirebirdBrowser` (WASM) or `FirebirdLite` (Node.js native)
 * based on the URI scheme:
 * - `'memory://'` / `'memory://scratch'` -> ephemeral WASM database (`FirebirdBrowser`)
 * - `'idb://mydb'` -> IndexedDB-persisted WASM database (`FirebirdBrowser`)
 * - `'opfs://mydb'` -> OPFS synchronous-access WASM database (`FirebirdBrowser`)
 * - `'wasm://...'` -> WASM database (`FirebirdBrowser`)
 * - `'file:///path/to/app.fdb'` -> local `.fdb` file (`FirebirdLite`)
 * - `'firebird://[user[:password]@]host[:port]/path'` -> remote Firebird server (`FirebirdLite`)
 * - `'/path/to/app.fdb'` / `'C:\\data\\app.fdb'` / `'localhost:/var/db/app.fdb'` -> `FirebirdLite`
 */

import { fileURLToPath } from 'url';
import type { FirebirdDatabase } from './database-core';
import type { FirebirdLiteOptions } from './types';
import { FirebirdLite } from './firebird';
import {
  FirebirdBrowser,
  type FirebirdBrowserOptions,
} from './browser/firebird-browser';

export type OpenDatabaseOptions = FirebirdBrowserOptions &
  FirebirdLiteOptions & {
    /**
     * Override automatic backend selection (`'wasm'` = `FirebirdBrowser`,
     * `'native'` = `FirebirdLite`).
     */
    backend?: 'auto' | 'wasm' | 'native';
    /**
     * When `true`, eagerly attaches/creates the database before resolving.
     * @default false
     */
    eager?: boolean;
  };

function parseFirebirdUrl(uri: string): {
  connectionString: string;
  username?: string;
  password?: string;
} {
  const parsed = new URL(uri);
  const host = parsed.hostname || 'localhost';
  const port = parsed.port ? `/${parsed.port}` : '';
  let dbPath = decodeURIComponent(parsed.pathname || '');
  // Handle Windows drive paths like `/C:/data/app.fdb` in URL pathname
  if (/^\/[A-Za-z]:\//.test(dbPath)) {
    dbPath = dbPath.slice(1);
  }
  const username = parsed.username
    ? decodeURIComponent(parsed.username)
    : undefined;
  const password = parsed.password
    ? decodeURIComponent(parsed.password)
    : undefined;
  return {
    connectionString: `${host}${port}:${dbPath}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function isWasmUri(uri: string): boolean {
  return (
    uri.startsWith('memory://') ||
    uri.startsWith('idb://') ||
    uri.startsWith('opfs://') ||
    uri.startsWith('wasm://')
  );
}

function isBrowserOnlyRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof process === 'undefined'
  );
}

/**
 * Open a Firebird database across WASM (`memory://`, `idb://`, `opfs://`) and
 * Node.js (`file://`, `firebird://`, `.fdb` paths, `host:path`) with a single
 * unified {@link FirebirdDatabase} interface (`M18 Item 3`).
 */
export async function openDatabase(
  uri = 'memory://',
  options: OpenDatabaseOptions = {},
): Promise<FirebirdDatabase> {
  const cleanUri = uri.trim() || 'memory://';
  const backend = options.backend ?? 'auto';

  if (
    backend === 'wasm' ||
    (backend === 'auto' &&
      (isWasmUri(cleanUri) ||
        (isBrowserOnlyRuntime() &&
          !cleanUri.startsWith('firebird://') &&
          !cleanUri.startsWith('file://'))))
  ) {
    const wasmTarget = cleanUri.startsWith('wasm://')
      ? cleanUri.slice('wasm://'.length) || 'memory://'
      : cleanUri;
    const db = new FirebirdBrowser(wasmTarget, options);
    if (options.eager) {
      await db.query('SELECT 1 FROM RDB$DATABASE');
    }
    return db;
  }

  let targetPath = cleanUri;
  let mergedOptions: FirebirdLiteOptions = { ...options };

  if (cleanUri.startsWith('file://')) {
    try {
      targetPath = fileURLToPath(cleanUri);
    } catch {
      targetPath = cleanUri.replace(/^file:\/\/\/?/, '/');
    }
  } else if (cleanUri.startsWith('firebird://')) {
    const parsed = parseFirebirdUrl(cleanUri);
    targetPath = parsed.connectionString;
    mergedOptions = {
      ...(parsed.username && !mergedOptions.username
        ? { username: parsed.username }
        : {}),
      ...(parsed.password && !mergedOptions.password
        ? { password: parsed.password }
        : {}),
      ...mergedOptions,
    };
  }

  const db = new FirebirdLite(targetPath, mergedOptions);
  if (options.eager) {
    await db.query('SELECT 1 FROM RDB$DATABASE');
  }
  return db;
}
