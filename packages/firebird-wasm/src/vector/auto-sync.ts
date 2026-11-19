/**
 * auto-sync.ts – Reactive Local DML (`db.onQuery`) & Replication Index Hook
 * Maintenance for `PersistentVectorIndex` & `PersistentFtsIndex` (`M25 Item 3`).
 */

import type { ReplicationIndexHook } from '../replication/types';

export interface QueryObservableExecutor {
  onQuery?: (listener: (event: { sql: string; params?: unknown }) => void) => () => void;
}

function sqlMutatesTargetTable(sql: string, cleanTableUpper: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;
  if (/^\s*(SELECT|WITH)\b/i.test(trimmed)) return false;
  if (/\b(FB_VECTOR_INDEX\$|FB_FTS_INDEX\$|FB_REPL_)/i.test(trimmed)) return false;
  if (
    !/^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|EXECUTE\s+BLOCK)\b/i.test(trimmed)
  ) {
    return false;
  }
  const escaped = cleanTableUpper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableRegex = new RegExp(`(?:"${escaped}"|\\b${escaped}\\b)`, 'i');
  return tableRegex.test(trimmed);
}

export interface AutoSyncController {
  /** Ensure any pending local DML changes have been synchronized into the index before searching. */
  ensureSynced(): Promise<void>;
  /** Unsubscribe the `db.onQuery` listener. */
  dispose(): void;
}

/**
 * Attach reactive `db.onQuery` tracking to keep a vector or BM25 FTS index
 * automatically synchronized with local `INSERT` / `UPDATE` / `DELETE` statements (`M25 Item 3`).
 */
export function attachIndexAutoSync(
  db: QueryObservableExecutor,
  cleanTableUpper: string,
  enabled: boolean,
  onSyncNeeded: () => Promise<void>,
): AutoSyncController {
  if (!enabled || typeof db.onQuery !== 'function') {
    return {
      async ensureSynced() {},
      dispose() {},
    };
  }

  let dirty = false;
  let syncInFlight: Promise<void> | null = null;
  let disposed = false;

  const scheduleFlush = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (syncInFlight) return syncInFlight;
    if (!dirty) return Promise.resolve();

    const run = (async () => {
      while (dirty && !disposed) {
        dirty = false;
        await onSyncNeeded();
      }
    })().finally(() => {
      if (syncInFlight === run) {
        syncInFlight = null;
      }
    });
    syncInFlight = run;
    return run;
  };

  const unsub = db.onQuery((ev) => {
    if (disposed) return;
    if (sqlMutatesTargetTable(ev.sql, cleanTableUpper)) {
      dirty = true;
      void scheduleFlush().catch(() => undefined);
    }
  });

  return {
    async ensureSynced(): Promise<void> {
      if (syncInFlight) {
        await syncInFlight;
      }
      if (dirty && !disposed) {
        await scheduleFlush();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      dirty = false;
      unsub();
    },
  };
}

function readFieldCI(
  obj: Record<string, unknown>,
  name: string,
): { found: boolean; value: unknown } {
  const clean = name.replace(/^"|"$/g, '');
  if (clean in obj) return { found: true, value: obj[clean] };
  const upper = clean.toUpperCase();
  if (upper in obj) return { found: true, value: obj[upper] };
  const lower = clean.toLowerCase();
  if (lower in obj) return { found: true, value: obj[lower] };
  for (const k of Object.keys(obj)) {
    if (k.toUpperCase() === upper) return { found: true, value: obj[k] };
  }
  return { found: false, value: undefined };
}

/**
 * Build a `ReplicationIndexHook` adapter for incremental replica maintenance (`M25 Item 3`).
 */
export function buildReplicationIndexHook<ID>(params: {
  cleanTableUpper: string;
  keyColumn: string;
  onUpsertRow: (id: ID, row: Record<string, unknown>) => Promise<void>;
  onDeleteId: (id: ID) => Promise<unknown>;
}): ReplicationIndexHook {
  const { cleanTableUpper, keyColumn, onUpsertRow, onDeleteId } = params;
  return {
    table: cleanTableUpper,
    async onInsertOrUpdate(row, key) {
      const fromKey = readFieldCI(key, keyColumn);
      const fromRow = readFieldCI(row, keyColumn);
      const idVal = fromKey.found ? fromKey.value : fromRow.value;
      if (idVal === null || idVal === undefined) return;
      await onUpsertRow(idVal as ID, row);
    },
    async onDelete(key, before) {
      const fromKey = readFieldCI(key, keyColumn);
      const fromBefore = before ? readFieldCI(before, keyColumn) : { found: false, value: undefined };
      const idVal = fromKey.found ? fromKey.value : fromBefore.value;
      if (idVal === null || idVal === undefined) return;
      await onDeleteId(idVal as ID);
    },
  };
}
