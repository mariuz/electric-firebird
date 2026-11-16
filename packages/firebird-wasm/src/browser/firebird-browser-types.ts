/**
 * firebird-browser-types.ts – Public interfaces, options, and URI prefix helpers
 * for `FirebirdBrowser` (`M22 Item 5`).
 */

import type { IndexedDBVFSOptions } from './indexeddb-vfs';
import type { PageEncryptionKey } from './page-crypto';
import type { EngineTransport } from './engine-transport';
import type { DatabaseSnapshot } from './snapshots';
import type { TypeOptions } from './value-types';
import type {
  QueryOptions,
  QueryParams,
  QueryStreamOptions,
} from '../types';

/** `QueryOptions` with the array mode pinned, for the overloads in `FirebirdBrowser`. */
export type ArrayModeOptions = QueryOptions & { rowMode: 'array' };
/** `QueryStreamOptions` with the array mode pinned, for the overloads in `FirebirdBrowser`. */
export type ArrayStreamOptions = QueryStreamOptions & { rowMode: 'array' };

/** A running subscription. Returned by {@link import('./firebird-browser').FirebirdBrowser.listen}. */
export interface EventSubscription {
  /** Stop listening and release the subscription. Safe to call twice. */
  unsubscribe(): Promise<void>;
}

/** Options for {@link import('./firebird-browser').FirebirdBrowser.listen}. */
export interface ListenOptions {
  /**
   * How often to ask the engine whether anything fired, in milliseconds.
   *
   * @default 250
   */
  pollIntervalMs?: number;
  /**
   * Called when a poll or a handler throws. Defaults to `console.error`.
   */
  onError?: (error: Error) => void;
}

/** Options for {@link import('./firebird-browser').FirebirdBrowser.live}. */
export interface LiveQueryOptions {
  /**
   * Event names to watch, as posted by `POST_EVENT`.
   *
   * When omitted (`undefined`), `live()` extracts the user tables referenced
   * by the statement, installs an idempotent `AFTER INSERT OR UPDATE OR DELETE`
   * `POST_EVENT` trigger (`FB_LIVE$<hash>`) on each table, and watches those
   * events automatically.
   */
  events?: readonly string[];
  /** Parameters for the statement, as `query()` takes them. */
  params?: QueryParams;
  /**
   * How often to ask the engine whether anything fired, in milliseconds.
   *
   * @default 250
   */
  pollIntervalMs?: number;
  /**
   * Called when a refresh fails. Defaults to `console.error`.
   */
  onError?: (error: Error) => void;
}

/** A running live query. Returned by {@link import('./firebird-browser').FirebirdBrowser.live}. */
export interface LiveQuery<T> {
  /** The most recent rows. Replaced, not mutated, on each refresh. */
  readonly rows: T[];
  /** Re-run the statement now, without waiting for an event. */
  refresh(): Promise<void>;
  /** Stop watching and release the subscription. Safe to call twice. */
  unsubscribe(): Promise<void>;
}

export interface BranchOptions extends Partial<FirebirdBrowserOptions> {
  /** Optional snapshot (or snapshot ID/label) to branch from. Defaults to taking a fresh snapshot of current state. */
  fromSnapshot?: DatabaseSnapshot | string;
}

/** Options for creating a {@link import('./firebird-browser').FirebirdBrowser} instance. */
export interface FirebirdBrowserOptions {
  /** Options forwarded to the IndexedDB VFS layer. */
  vfs?: IndexedDBVFSOptions;
  /** Optional WebCrypto AES-GCM key (`CryptoKey` or 16/32-byte `Uint8Array` / `ArrayBuffer`) used to encrypt 8 KB database pages at rest. */
  encryptionKey?: PageEncryptionKey;
  /**
   * Broadcast table-level `FB_LIVE$<table>` and `POST_EVENT` invalidations across
   * same-origin browser tabs via `BroadcastChannel`.
   */
  crossTabLive?: boolean;
  /** URL or `ArrayBuffer` of the `firebird-embedded.wasm` binary. */
  wasmBinary?: ArrayBuffer | string;
  /** Custom `locateFile` callback for Emscripten. */
  locateFile?: (filename: string) => string;
  /** Which build the engine loads in Node (`threads`). */
  threads?: boolean | 'auto';
  /** Worker running the engine (or factory for `multiTab: 'shared'`). */
  worker?: Worker | (() => Worker);
  /** Custom transport seam (takes precedence over `worker`). */
  transport?: EngineTransport;
  /** Persist to IndexedDB automatically after writes. @default true */
  autoPersist?: boolean;
  /** How long to wait after the last write before persisting (ms). @default 500 */
  autoPersistDebounceMs?: number;
  /** Called when a background persist fails. */
  onPersistError?: (error: Error) => void;
  /** Cross-tab coordination mode. @default 'exclusive' */
  multiTab?: 'exclusive' | 'shared' | 'allow-unsafe';
  /** Share one read-only transaction across non-writing `SELECT` `query()` calls. @default false */
  sharedReads?: boolean;
  /** How long to wait for another tab to release the database (ms). @default 5000 */
  lockTimeoutMs?: number;
  /** Convert result values to richer JavaScript types. */
  types?: TypeOptions;
  /** Initial seed image bytes (used only when no database exists yet). */
  loadDataDir?: Uint8Array;
  /** Initial seed stream (raw or gzip-compressed), used only when no database exists yet. */
  loadDataStream?:
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array>
    | (() =>
        | ReadableStream<Uint8Array>
        | AsyncIterable<Uint8Array>
        | Promise<ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>);
  /** Optional lazy-loaded ICU `.dat` (or `.dat.gz`) locale tailoring bundle. */
  icuLocaleData?:
    | Uint8Array
    | ArrayBuffer
    | ArrayBufferLike
    | (() => Uint8Array | ArrayBufferLike | Promise<Uint8Array | ArrayBufferLike>);
}

/** Prefix marking a database that is never stored. Matches PGlite's. */
export const MEMORY_PREFIX = 'memory://';

/** Prefix marking a database whose pages live in OPFS rather than IndexedDB. */
export const OPFS_PREFIX = 'opfs://';

/** Explicit prefix alias for an IndexedDB-backed database (`idb://mydb` === `'mydb'`). */
export const IDB_PREFIX = 'idb://';

let ephemeralCounter = 0;

export function ephemeralFileName(dbName: string): string {
  const label = dbName.slice(MEMORY_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '') || 'memory';
  ephemeralCounter += 1;
  return `${label}-${ephemeralCounter}`;
}
