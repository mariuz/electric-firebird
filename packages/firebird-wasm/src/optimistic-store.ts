/**
 * optimistic-store.ts – Optimistic Local-First Mutation Queue with Automatic
 * Pre-Image Capture, Crash-Safe Durable Outbox (`FB_OPTIMISTIC_OUTBOX$`),
 * Field-Level Offline Rebase & Reactive Table Store (`M22 Item 3` / `M23 Item 2`).
 */

import type { QueryParams, QueryResult, Row } from './types';
import {
  createTableRepository,
  quoteTableIdent,
  type TableExecutionHost,
  type TableFindOptions,
  type TableOptions,
  type TableRepository,
} from './table-api';
import {
  IncrementalQueryStore,
  type IncrementalQueryableDatabase,
} from './frameworks/sync-store';
import type { LiveRowDelta } from './live-incremental';
import type { ReplicationLogEntry } from './replication/types';
import type { BroadcastChannelLike } from './replication/transports';

const inProcessOutboxChannels = new Map<string, Set<(data: unknown) => void>>();

export function openSharedBroadcastChannel(
  channelOrName: string | BroadcastChannelLike,
): { channel: BroadcastChannelLike; owned: boolean } {
  if (typeof channelOrName !== 'string') {
    return { channel: channelOrName, owned: false };
  }
  if (typeof globalThis.BroadcastChannel === 'function') {
    return {
      channel: new globalThis.BroadcastChannel(channelOrName) as unknown as BroadcastChannelLike,
      owned: true,
    };
  }
  let group = inProcessOutboxChannels.get(channelOrName);
  if (!group) {
    group = new Set();
    inProcessOutboxChannels.set(channelOrName, group);
  }
  const localHandlers = new Set<(ev: { data: unknown }) => void>();
  const dispatch = (data: unknown) => {
    for (const fn of localHandlers) fn({ data });
    channel.onmessage?.({ data });
  };
  group.add(dispatch);
  const channel: BroadcastChannelLike = {
    postMessage(msg: unknown) {
      const peers = inProcessOutboxChannels.get(channelOrName);
      if (!peers) return;
      for (const peer of peers) {
        if (peer !== dispatch) peer(msg);
      }
    },
    addEventListener(_type: 'message', fn: (ev: { data: unknown }) => void) {
      localHandlers.add(fn);
    },
    removeEventListener(_type: 'message', fn: (ev: { data: unknown }) => void) {
      localHandlers.delete(fn);
    },
    onmessage: null,
    close() {
      inProcessOutboxChannels.get(channelOrName)?.delete(dispatch);
      localHandlers.clear();
    },
  };
  return { channel, owned: true };
}

export const DEFAULT_OPTIMISTIC_OUTBOX_TABLE = 'FB_OPTIMISTIC_OUTBOX$';

export type OptimisticOperation = 'INSERT' | 'UPDATE' | 'UPSERT' | 'DELETE';
export type OptimisticConflictStrategy = 'revert' | 'rebase-fields';

export interface PendingOptimisticMutation {
  readonly id: string;
  readonly seqNo?: number;
  readonly tableName: string;
  readonly primaryKey: readonly string[];
  readonly operation: OptimisticOperation;
  readonly keyValue: unknown;
  /** Explicit column subset modified by this mutation (`null` for `DELETE`). */
  readonly patchColumns?: Record<string, unknown> | null;
  /** Row state before this optimistic mutation (`null` if row did not exist before). */
  readonly beforeRow: Row | null;
  /** Row state written optimistically (`null` for `DELETE`). */
  readonly afterRow: Row | null;
  readonly createdAt: number;
  readonly status: 'pending' | 'flushing' | 'reverted';
  readonly error?: Error;
}

export interface OptimisticStoreSnapshot {
  readonly pendingCount: number;
  readonly flushing: boolean;
  readonly hydrated: boolean;
  readonly pending: readonly PendingOptimisticMutation[];
  readonly confirmedCount: number;
  readonly revertedCount: number;
  readonly rebasedCount: number;
  readonly lastError: Error | undefined;
}

export interface OptimisticMutationStoreOptions {
  /**
   * Optional replication `SyncHandle` (e.g. from `db.syncWith()`, `syncDatabases()`,
   * or `createTenantReplicationSlice()`) invoked on `flush()`.
   */
  syncHandle?: { syncNow(): Promise<unknown> } | null;
  /**
   * Optional custom async remote commit handler invoked on `flush(mutations)`.
   * Takes precedence over `syncHandle` when both are supplied.
   */
  remoteSync?: (mutations: readonly PendingOptimisticMutation[]) => Promise<void>;
  /**
   * Automatically trigger `flush()` in the background after each optimistic write
   * when `syncHandle` or `remoteSync` is configured.
   *
   * @default false
   */
  autoFlush?: boolean;
  /**
   * Persist pending optimistic mutations and rollback pre-images in
   * `FB_OPTIMISTIC_OUTBOX$` so pending state survives page reloads / restarts (`M23 Item 2`).
   *
   * @default false
   */
  persist?: boolean;
  /** Custom outbox table name when `persist: true`. @default 'FB_OPTIMISTIC_OUTBOX$' */
  outboxTable?: string;
  /** Default conflict resolution strategy used by `rebase(remoteEntries)` (`M23 Item 2`). @default 'rebase-fields' */
  conflictStrategy?: OptimisticConflictStrategy;
  /** Optional `BroadcastChannel` name or instance synchronizing pending outbox state across sibling browser tabs (`M24 Item 4`). */
  broadcastChannel?: string | BroadcastChannelLike;
  /** Callback invoked whenever a mutation fails remote sync and is rolled back locally. */
  onMutationFailed?: (mutation: PendingOptimisticMutation, error: Error) => void;
}

export interface OptimisticFlushResult {
  readonly confirmed: number;
  readonly reverted: number;
  readonly errors: readonly Error[];
}

export interface OptimisticRebaseResult {
  readonly rebased: number;
  readonly reverted: number;
}

export interface OptimisticTableActions<T extends Row = Row, K = unknown> {
  insert(row: Partial<T> & Record<string, unknown>): Promise<{ mutationId: string; row: T }>;
  update(
    key: K,
    patch: Partial<T> & Record<string, unknown>,
  ): Promise<{ mutationId: string; affectedRows: number }>;
  upsert(
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<{ mutationId: string; row: T }>;
  delete(key: K): Promise<{ mutationId: string; affectedRows: number }>;
  revert(mutationId: string): Promise<boolean>;
  flush(): Promise<OptimisticFlushResult>;
}

export interface OptimisticMutationStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => OptimisticStoreSnapshot;
  /** Hydrate any crash/reload-persisted pending mutations from `FB_OPTIMISTIC_OUTBOX$` (`M23 Item 2`). */
  hydrate(): Promise<readonly PendingOptimisticMutation[]>;
  /** Rebase pending optimistic mutations on top of incoming remote `ReplicationLogEntry[]` (`M23 Item 2`). */
  rebase(
    remoteEntries: readonly ReplicationLogEntry[],
    options?: { strategy?: OptimisticConflictStrategy },
  ): Promise<OptimisticRebaseResult>;
  insert<T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    options?: { primaryKey?: string | readonly string[] },
  ): Promise<{ mutationId: string; row: T }>;
  update<T extends Row = Row, K = unknown>(
    tableName: string,
    key: K,
    patch: Partial<T> & Record<string, unknown>,
    options?: { primaryKey?: string | readonly string[] },
  ): Promise<{ mutationId: string; affectedRows: number }>;
  upsert<T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    options?: {
      primaryKey?: string | readonly string[];
      matchingColumns?: readonly string[];
    },
  ): Promise<{ mutationId: string; row: T }>;
  delete<K = unknown>(
    tableName: string,
    key: K,
    options?: { primaryKey?: string | readonly string[] },
  ): Promise<{ mutationId: string; affectedRows: number }>;
  /** Roll back a pending optimistic mutation in-place using its captured pre-image. */
  revert(mutationId: string): Promise<boolean>;
  /** Revert all currently pending optimistic mutations in reverse chronological order. */
  revertAll(): Promise<number>;
  /** Push pending optimistic mutations to `remoteSync` / `syncHandle`; rolls back locally on failure. */
  flush(): Promise<OptimisticFlushResult>;
  /** Return typed optimistic CRUD helpers bound to `tableName`. */
  table<T extends Row = Row, K = unknown>(
    tableName: string,
    options?: TableOptions<T>,
  ): OptimisticTableActions<T, K>;
  /** Detach cross-tab `BroadcastChannel` listeners if configured (`M24 Item 4`). */
  close(): void;
}

function normalizePkList(pk?: string | readonly string[]): string[] {
  if (!pk) return ['ID'];
  if (typeof pk === 'string') return [pk.toUpperCase()];
  return pk.length > 0 ? pk.map((c) => String(c).toUpperCase()) : ['ID'];
}

function normalizeUpperRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== undefined) {
      out[k.toUpperCase()] = v;
    }
  }
  return out;
}

function getFieldCI(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

function extractKeyFromRow(row: Record<string, unknown>, pkCols: readonly string[]): unknown {
  if (pkCols.length === 1) {
    return getFieldCI(row, pkCols[0]!);
  }
  const obj: Record<string, unknown> = {};
  for (const c of pkCols) {
    obj[c] = getFieldCI(row, c);
  }
  return obj;
}

function canonicalizeRowKey(keyVal: unknown, pkCols: readonly string[]): string {
  if (pkCols.length === 1) {
    if (keyVal && typeof keyVal === 'object' && !Array.isArray(keyVal)) {
      return JSON.stringify([String(getFieldCI(keyVal as Record<string, unknown>, pkCols[0]!))]);
    }
    return JSON.stringify([String(keyVal)]);
  }
  const rec =
    keyVal && typeof keyVal === 'object' ? (keyVal as Record<string, unknown>) : {};
  return JSON.stringify(pkCols.map((c) => String(getFieldCI(rec, c))));
}

function valuesEqualLoose(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function safeJsonStringify(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return JSON.stringify(val, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function safeJsonParse<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Create an optimistic local-first mutation store backed by a Firebird database
 * (`FirebirdBrowser`, `FirebirdLite`, or `ReplicaRouter`) (`M22 Item 3` / `M23 Item 2`).
 */
export function createOptimisticMutationStore(
  db: TableExecutionHost & { notify?(name: string): Promise<void> },
  options: OptimisticMutationStoreOptions = {},
): OptimisticMutationStore {
  const listeners = new Set<() => void>();
  const persistEnabled = options.persist === true;
  const outboxTable = (options.outboxTable ?? DEFAULT_OPTIMISTIC_OUTBOX_TABLE)
    .trim()
    .toUpperCase();
  const quotedOutbox = quoteTableIdent(outboxTable);
  const defaultConflictStrategy: OptimisticConflictStrategy =
    options.conflictStrategy ?? 'rebase-fields';

  let nextSeq = 1;
  let pendingList: PendingOptimisticMutation[] = [];
  let flushing = false;
  let hydrated = !persistEnabled;
  let outboxDdlEnsured = false;
  let hydratePromise: Promise<readonly PendingOptimisticMutation[]> | null = null;
  let confirmedCount = 0;
  let revertedCount = 0;
  let rebasedCount = 0;
  let lastError: Error | undefined = undefined;

  let snapshot: OptimisticStoreSnapshot = {
    pendingCount: 0,
    flushing: false,
    hydrated,
    pending: [],
    confirmedCount: 0,
    revertedCount: 0,
    rebasedCount: 0,
    lastError: undefined,
  };

  const tabOrigin = `opt_tab_${Math.random().toString(36).slice(2, 10)}`;
  const bcHandle = options.broadcastChannel
    ? openSharedBroadcastChannel(options.broadcastChannel)
    : null;

  const emit = (broadcast = true): void => {
    snapshot = {
      pendingCount: pendingList.length,
      flushing,
      hydrated,
      pending: [...pendingList],
      confirmedCount,
      revertedCount,
      rebasedCount,
      lastError,
    };
    for (const cb of [...listeners]) {
      cb();
    }
    if (broadcast && bcHandle) {
      bcHandle.channel.postMessage({
        type: 'fb_optimistic_outbox_sync',
        origin: tabOrigin,
        pending: persistEnabled ? undefined : snapshot.pending,
        confirmedCount,
        revertedCount,
        rebasedCount,
      });
    }
  };

  const onChannelMessage = (event: { data: unknown }) => {
    const msg = event.data as
      | {
          type?: string;
          origin?: string;
          pending?: PendingOptimisticMutation[];
          confirmedCount?: number;
          revertedCount?: number;
          rebasedCount?: number;
        }
      | undefined;
    if (!msg || msg.type !== 'fb_optimistic_outbox_sync' || msg.origin === tabOrigin) {
      return;
    }
    if (typeof msg.confirmedCount === 'number') {
      confirmedCount = Math.max(confirmedCount, msg.confirmedCount);
    }
    if (typeof msg.revertedCount === 'number') {
      revertedCount = Math.max(revertedCount, msg.revertedCount);
    }
    if (typeof msg.rebasedCount === 'number') {
      rebasedCount = Math.max(rebasedCount, msg.rebasedCount);
    }
    if (persistEnabled) {
      hydrated = false;
      void store.hydrate().catch(() => undefined);
    } else if (Array.isArray(msg.pending)) {
      pendingList = [...msg.pending];
      emit(false);
    }
  };

  if (bcHandle) {
    if (typeof bcHandle.channel.addEventListener === 'function') {
      bcHandle.channel.addEventListener('message', onChannelMessage);
    } else {
      bcHandle.channel.onmessage = onChannelMessage;
    }
  }

  const ensureOutboxTable = async (): Promise<void> => {
    if (!persistEnabled || outboxDdlEnsured) return;
    try {
      const check = await db.query<Row>(
        `SELECT 1 AS OK FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [outboxTable],
      );
      if (check.rows.length > 0) {
        outboxDdlEnsured = true;
        return;
      }
    } catch {
      // Proceed to CREATE TABLE attempt
    }
    try {
      await db.execute(
        `CREATE TABLE ${quotedOutbox} (
          "SEQ_NO" BIGINT NOT NULL PRIMARY KEY,
          "MUTATION_ID" VARCHAR(96) NOT NULL,
          "TABLE_NAME" VARCHAR(128) NOT NULL,
          "OP_KIND" VARCHAR(16) NOT NULL,
          "PK_COLS_JSON" BLOB SUB_TYPE TEXT,
          "KEY_JSON" BLOB SUB_TYPE TEXT,
          "PATCH_JSON" BLOB SUB_TYPE TEXT,
          "BEFORE_JSON" BLOB SUB_TYPE TEXT,
          "AFTER_JSON" BLOB SUB_TYPE TEXT,
          "CREATED_AT" BIGINT NOT NULL
        )`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|unsuccessful metadata update/i.test(msg)) {
        throw err;
      }
    }
    outboxDdlEnsured = true;
  };

  const persistMutationRow = async (m: PendingOptimisticMutation): Promise<void> => {
    if (!persistEnabled) return;
    await ensureOutboxTable();
    await db.execute(
      `UPDATE OR INSERT INTO ${quotedOutbox} (
        "SEQ_NO", "MUTATION_ID", "TABLE_NAME", "OP_KIND",
        "PK_COLS_JSON", "KEY_JSON", "PATCH_JSON", "BEFORE_JSON", "AFTER_JSON", "CREATED_AT"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) MATCHING ("SEQ_NO")`,
      [
        m.seqNo ?? nextSeq++,
        m.id,
        m.tableName,
        m.operation,
        JSON.stringify(m.primaryKey),
        safeJsonStringify({ v: m.keyValue }),
        safeJsonStringify(m.patchColumns ?? null),
        safeJsonStringify(m.beforeRow),
        safeJsonStringify(m.afterRow),
        m.createdAt,
      ],
    );
  };

  const removePersistedMutations = async (ids: readonly string[]): Promise<void> => {
    if (!persistEnabled || ids.length === 0) return;
    await ensureOutboxTable();
    for (const id of ids) {
      await db.execute(`DELETE FROM ${quotedOutbox} WHERE "MUTATION_ID" = ?`, [id]);
    }
  };

  const ensureHydrated = async (): Promise<void> => {
    if (!persistEnabled || hydrated) return;
    await store.hydrate();
  };

  const applyInverseMutation = async (m: PendingOptimisticMutation): Promise<void> => {
    const repo = createTableRepository<Row, unknown>(db, m.tableName, {
      primaryKey: m.primaryKey,
      cacheStatements: false,
    });

    if (m.beforeRow === null) {
      if (m.keyValue !== undefined && m.keyValue !== null) {
        await repo.delete(m.keyValue);
      }
      return;
    }

    await repo.upsert(m.beforeRow as Record<string, unknown>, m.primaryKey);
  };

  const maybeAutoFlush = (): void => {
    if (options.autoFlush && (options.remoteSync || options.syncHandle)) {
      void store.flush().catch(() => undefined);
    }
  };

  const store: OptimisticMutationStore = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => snapshot,

    async hydrate(): Promise<readonly PendingOptimisticMutation[]> {
      if (!persistEnabled) {
        hydrated = true;
        return pendingList;
      }
      if (hydratePromise) {
        return hydratePromise;
      }
      hydratePromise = (async () => {
        await ensureOutboxTable();
        const res = await db.query<Row>(
          `SELECT "SEQ_NO", "MUTATION_ID", "TABLE_NAME", "OP_KIND", "PK_COLS_JSON", "KEY_JSON", "PATCH_JSON", "BEFORE_JSON", "AFTER_JSON", "CREATED_AT" FROM ${quotedOutbox} ORDER BY "SEQ_NO" ASC`,
        );
        const loaded: PendingOptimisticMutation[] = [];
        let maxSeq = 0;
        for (const r of res.rows) {
          const seqNo = Number(getFieldCI(r, 'SEQ_NO') ?? 0);
          if (seqNo > maxSeq) maxSeq = seqNo;
          const id = String(getFieldCI(r, 'MUTATION_ID') ?? `opt_${seqNo}`);
          const tableName = String(getFieldCI(r, 'TABLE_NAME') ?? '').toUpperCase();
          const operation = String(
            getFieldCI(r, 'OP_KIND') ?? 'UPDATE',
          ).toUpperCase() as OptimisticOperation;
          const pkCols = safeJsonParse<string[]>(getFieldCI(r, 'PK_COLS_JSON')) ?? ['ID'];
          const keyWrap = safeJsonParse<{ v?: unknown }>(getFieldCI(r, 'KEY_JSON'));
          const patchColumns = safeJsonParse<Record<string, unknown>>(
            getFieldCI(r, 'PATCH_JSON'),
          );
          const beforeRow = safeJsonParse<Row>(getFieldCI(r, 'BEFORE_JSON'));
          const afterRow = safeJsonParse<Row>(getFieldCI(r, 'AFTER_JSON'));
          const createdAt = Number(getFieldCI(r, 'CREATED_AT') ?? Date.now());
          loaded.push({
            id,
            seqNo,
            tableName,
            primaryKey: pkCols,
            operation,
            keyValue: keyWrap ? keyWrap.v : undefined,
            patchColumns,
            beforeRow,
            afterRow,
            createdAt,
            status: 'pending',
          });
        }
        nextSeq = Math.max(nextSeq, maxSeq + 1);
        pendingList = loaded;
        hydrated = true;
        emit(false);
        return pendingList;
      })();

      try {
        return await hydratePromise;
      } finally {
        hydratePromise = null;
      }
    },

    async rebase(
      remoteEntries: readonly ReplicationLogEntry[],
      rebaseOpts = {},
    ): Promise<OptimisticRebaseResult> {
      await ensureHydrated();
      if (pendingList.length === 0 || remoteEntries.length === 0) {
        return { rebased: 0, reverted: 0 };
      }
      const strategy = rebaseOpts.strategy ?? defaultConflictStrategy;
      let rebased = 0;
      let reverted = 0;

      for (const entry of remoteEntries) {
        if (entry.operation === 'DDL') continue;
        const entryTable = entry.table.trim().toUpperCase();

        const matchingIndices: number[] = [];
        for (let i = 0; i < pendingList.length; i++) {
          const m = pendingList[i]!;
          if (m.tableName !== entryTable) continue;
          const mKeyStr = canonicalizeRowKey(m.keyValue, m.primaryKey);
          const eKeyStr = canonicalizeRowKey(entry.key, m.primaryKey);
          if (mKeyStr === eKeyStr) {
            matchingIndices.push(i);
          }
        }
        if (matchingIndices.length === 0) continue;

        if (strategy === 'revert' || entry.operation === 'DELETE' || !entry.after) {
          const idsToRemove = matchingIndices.map((idx) => pendingList[idx]!.id);
          const repo = createTableRepository<Row, unknown>(db, entryTable, {
            primaryKey: pendingList[matchingIndices[0]!]!.primaryKey,
            cacheStatements: false,
          });
          if (entry.operation === 'DELETE' || !entry.after) {
            await repo.delete(pendingList[matchingIndices[0]!]!.keyValue);
          } else {
            await repo.upsert(
              normalizeUpperRecord(entry.after as Record<string, unknown>),
              pendingList[matchingIndices[0]!]!.primaryKey,
            );
          }
          pendingList = pendingList.filter((m) => !idsToRemove.includes(m.id));
          await removePersistedMutations(idsToRemove);
          reverted += idsToRemove.length;
          revertedCount += idsToRemove.length;
          continue;
        }

        // Field-level rebase (`strategy === 'rebase-fields'`)
        const remoteAfter = normalizeUpperRecord(entry.after as Record<string, unknown>);
        const remoteBefore = entry.before
          ? normalizeUpperRecord(entry.before as Record<string, unknown>)
          : null;

        const workingRow: Record<string, unknown> = { ...remoteAfter };
        for (const idx of matchingIndices) {
          const m = pendingList[idx]!;
          if (m.operation === 'DELETE') {
            // Remote updated a row we optimistically deleted -> update pre-image to remoteAfter
            const updatedDelete: PendingOptimisticMutation = {
              ...m,
              beforeRow: { ...remoteAfter },
            };
            pendingList[idx] = updatedDelete;
            await persistMutationRow(updatedDelete);
            const repo = createTableRepository<Row, unknown>(db, entryTable, {
              primaryKey: m.primaryKey,
              cacheStatements: false,
            });
            await repo.delete(m.keyValue);
            rebased += 1;
            rebasedCount += 1;
            continue;
          }

          const localPatch = m.patchColumns ?? normalizeUpperRecord((m.afterRow ?? {}) as Record<string, unknown>);
          const pkSet = new Set(m.primaryKey.map((c) => c.toUpperCase()));
          const survivingPatch: Record<string, unknown> = {};

          for (const [col, localVal] of Object.entries(localPatch)) {
            if (pkSet.has(col)) continue;
            const remBeforeVal = remoteBefore ? getFieldCI(remoteBefore, col) : undefined;
            const remAfterVal = getFieldCI(remoteAfter, col);
            const remoteChangedCol =
              remoteBefore !== null
                ? !valuesEqualLoose(remBeforeVal, remAfterVal)
                : false;
            if (!remoteChangedCol) {
              workingRow[col] = localVal;
              survivingPatch[col] = localVal;
            }
          }

          const updatedMut: PendingOptimisticMutation = {
            ...m,
            patchColumns: survivingPatch,
            beforeRow: { ...remoteAfter },
            afterRow: { ...workingRow },
          };
          pendingList[idx] = updatedMut;
          await persistMutationRow(updatedMut);
          rebased += 1;
          rebasedCount += 1;
        }

        const pkCols = pendingList[matchingIndices[0]!]?.primaryKey ?? ['ID'];
        const repo = createTableRepository<Row, unknown>(db, entryTable, {
          primaryKey: pkCols,
          cacheStatements: false,
        });
        await repo.upsert(workingRow, pkCols);
      }

      emit();
      return { rebased, reverted };
    },

    async insert<T extends Row = Row>(
      tableName: string,
      row: Partial<T> & Record<string, unknown>,
      opts: { primaryKey?: string | readonly string[] } = {},
    ): Promise<{ mutationId: string; row: T }> {
      await ensureHydrated();
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<T, unknown>(db, tableName, {
        primaryKey: pkCols,
      });
      const inserted = await repo.insert(row);
      await repo.close();
      const keyVal = extractKeyFromRow(inserted as Record<string, unknown>, pkCols);
      const seqNo = nextSeq++;
      const mutationId = `opt_${seqNo}`;
      const entry: PendingOptimisticMutation = {
        id: mutationId,
        seqNo,
        tableName: tableName.toUpperCase(),
        primaryKey: pkCols,
        operation: 'INSERT',
        keyValue: keyVal,
        patchColumns: normalizeUpperRecord(row),
        beforeRow: null,
        afterRow: inserted,
        createdAt: Date.now(),
        status: 'pending',
      };
      await persistMutationRow(entry);
      pendingList = [...pendingList, entry];
      emit();
      maybeAutoFlush();
      return { mutationId, row: inserted };
    },

    async update<T extends Row = Row, K = unknown>(
      tableName: string,
      key: K,
      patch: Partial<T> & Record<string, unknown>,
      opts: { primaryKey?: string | readonly string[] } = {},
    ): Promise<{ mutationId: string; affectedRows: number }> {
      await ensureHydrated();
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<T, K>(db, tableName, {
        primaryKey: pkCols,
      });
      const beforeRow = await repo.get(key);
      const res = await repo.update(key, patch);
      const afterRow = res.affectedRows > 0 ? await repo.get(key) : beforeRow;
      await repo.close();
      const seqNo = nextSeq++;
      const mutationId = `opt_${seqNo}`;
      if (res.affectedRows > 0) {
        const entry: PendingOptimisticMutation = {
          id: mutationId,
          seqNo,
          tableName: tableName.toUpperCase(),
          primaryKey: pkCols,
          operation: 'UPDATE',
          keyValue: key,
          patchColumns: normalizeUpperRecord(patch),
          beforeRow,
          afterRow,
          createdAt: Date.now(),
          status: 'pending',
        };
        await persistMutationRow(entry);
        pendingList = [...pendingList, entry];
        emit();
        maybeAutoFlush();
      }
      return { mutationId, affectedRows: res.affectedRows };
    },

    async upsert<T extends Row = Row>(
      tableName: string,
      row: Partial<T> & Record<string, unknown>,
      opts: {
        primaryKey?: string | readonly string[];
        matchingColumns?: readonly string[];
      } = {},
    ): Promise<{ mutationId: string; row: T }> {
      await ensureHydrated();
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<T, unknown>(db, tableName, {
        primaryKey: pkCols,
      });
      const candidateKey = extractKeyFromRow(row, pkCols);
      const beforeRow =
        candidateKey !== undefined && candidateKey !== null
          ? await repo.get(candidateKey)
          : null;
      const upserted = await repo.upsert(row, opts.matchingColumns);
      await repo.close();
      const finalKey = extractKeyFromRow(upserted as Record<string, unknown>, pkCols);
      const seqNo = nextSeq++;
      const mutationId = `opt_${seqNo}`;
      const entry: PendingOptimisticMutation = {
        id: mutationId,
        seqNo,
        tableName: tableName.toUpperCase(),
        primaryKey: pkCols,
        operation: 'UPSERT',
        keyValue: finalKey,
        patchColumns: normalizeUpperRecord(row),
        beforeRow,
        afterRow: upserted,
        createdAt: Date.now(),
        status: 'pending',
      };
      await persistMutationRow(entry);
      pendingList = [...pendingList, entry];
      emit();
      maybeAutoFlush();
      return { mutationId, row: upserted };
    },

    async delete<K = unknown>(
      tableName: string,
      key: K,
      opts: { primaryKey?: string | readonly string[] } = {},
    ): Promise<{ mutationId: string; affectedRows: number }> {
      await ensureHydrated();
      const pkCols = normalizePkList(opts.primaryKey);
      const repo = createTableRepository<Row, K>(db, tableName, {
        primaryKey: pkCols,
      });
      const beforeRow = await repo.get(key);
      const res = await repo.delete(key);
      await repo.close();
      const seqNo = nextSeq++;
      const mutationId = `opt_${seqNo}`;
      if (res.affectedRows > 0 && beforeRow) {
        const entry: PendingOptimisticMutation = {
          id: mutationId,
          seqNo,
          tableName: tableName.toUpperCase(),
          primaryKey: pkCols,
          operation: 'DELETE',
          keyValue: key,
          patchColumns: null,
          beforeRow,
          afterRow: null,
          createdAt: Date.now(),
          status: 'pending',
        };
        await persistMutationRow(entry);
        pendingList = [...pendingList, entry];
        emit();
        maybeAutoFlush();
      }
      return { mutationId, affectedRows: res.affectedRows };
    },

    async revert(mutationId: string): Promise<boolean> {
      await ensureHydrated();
      const idx = pendingList.findIndex((m) => m.id === mutationId);
      if (idx < 0) return false;
      const target = pendingList[idx]!;
      pendingList = pendingList.filter((m) => m.id !== mutationId);
      await applyInverseMutation(target);
      await removePersistedMutations([mutationId]);
      revertedCount += 1;
      emit();
      return true;
    },

    async revertAll(): Promise<number> {
      await ensureHydrated();
      if (pendingList.length === 0) return 0;
      const toRevert = [...pendingList].reverse();
      const ids = toRevert.map((m) => m.id);
      pendingList = [];
      for (const m of toRevert) {
        await applyInverseMutation(m);
        revertedCount += 1;
      }
      await removePersistedMutations(ids);
      emit();
      return toRevert.length;
    },

    async flush(): Promise<OptimisticFlushResult> {
      await ensureHydrated();
      if (pendingList.length === 0 || flushing) {
        return { confirmed: 0, reverted: 0, errors: [] };
      }

      const batch = [...pendingList];
      const batchIds = new Set(batch.map((m) => m.id));
      flushing = true;
      lastError = undefined;
      pendingList = pendingList.map((m) =>
        batchIds.has(m.id) ? { ...m, status: 'flushing' } : m,
      );
      emit();

      try {
        if (options.remoteSync) {
          await options.remoteSync(batch);
        } else if (options.syncHandle) {
          await options.syncHandle.syncNow();
        }
        pendingList = pendingList.filter((m) => !batchIds.has(m.id));
        await removePersistedMutations([...batchIds]);
        confirmedCount += batch.length;
        flushing = false;
        emit();
        return { confirmed: batch.length, reverted: 0, errors: [] };
      } catch (err) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        lastError = errorObj;
        pendingList = pendingList.filter((m) => !batchIds.has(m.id));
        const reversed = [...batch].reverse();
        for (const m of reversed) {
          try {
            await applyInverseMutation(m);
          } catch {
            // Best-effort local rollback
          }
          revertedCount += 1;
          options.onMutationFailed?.(
            { ...m, status: 'reverted', error: errorObj },
            errorObj,
          );
        }
        await removePersistedMutations([...batchIds]);
        flushing = false;
        emit();
        return {
          confirmed: 0,
          reverted: batch.length,
          errors: [errorObj],
        };
      }
    },

    table<T extends Row = Row, K = unknown>(
      tableName: string,
      tableOpts: TableOptions<T> = {},
    ): OptimisticTableActions<T, K> {
      const pk = tableOpts.primaryKey as string | readonly string[] | undefined;
      return {
        insert: (row) => store.insert<T>(tableName, row, { primaryKey: pk }),
        update: (key, patch) =>
          store.update<T, K>(tableName, key, patch, { primaryKey: pk }),
        upsert: (row, matchingColumns) =>
          store.upsert<T>(tableName, row, {
            primaryKey: pk,
            matchingColumns: matchingColumns?.map((c) => String(c)),
          }),
        delete: (key) => store.delete<K>(tableName, key, { primaryKey: pk }),
        revert: (id) => store.revert(id),
        flush: () => store.flush(),
      };
    },

    close(): void {
      if (!bcHandle) return;
      if (typeof bcHandle.channel.removeEventListener === 'function') {
        bcHandle.channel.removeEventListener('message', onChannelMessage);
      } else if (bcHandle.channel.onmessage === onChannelMessage) {
        bcHandle.channel.onmessage = null;
      }
      if (bcHandle.owned) {
        bcHandle.channel.close?.();
      }
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Framework-Agnostic `ReactiveTableStore<T, K>` (`useTable` / `createTable`)
// ---------------------------------------------------------------------------

export type ReactiveTableDatabase = TableExecutionHost & IncrementalQueryableDatabase;

export interface ReactiveTableStoreOptions<T extends Row = Row>
  extends TableOptions<T>,
    Omit<TableFindOptions<T>, 'offset' | 'cursor'> {
  /** Optional `OptimisticMutationStore` enabling optimistic writes + pending telemetry. */
  optimisticStore?: OptimisticMutationStore;
  /** Live event polling interval in milliseconds. @default 250 */
  pollIntervalMs?: number;
  /** Optional explicit Firebird `POST_EVENT` names to watch. */
  events?: readonly string[];
}

export interface ReactiveTableState<T extends Row = Row> {
  readonly rows: T[] | undefined;
  readonly deltas: readonly LiveRowDelta<T>[];
  readonly version: number;
  readonly loading: boolean;
  readonly error: Error | undefined;
  readonly pendingCount: number;
  readonly flushing: boolean;
}

function buildReactiveTableQuery<T extends Row>(
  tableName: string,
  pkCols: readonly string[],
  options: ReactiveTableStoreOptions<T>,
): { sql: string; params: QueryParams } {
  const quotedTable = quoteTableIdent(tableName);
  const cols =
    options.columns && options.columns.length > 0
      ? options.columns.map((c) => quoteTableIdent(String(c))).join(', ')
      : '*';
  let sql = `SELECT ${cols} FROM ${quotedTable}`;
  const params: QueryParams = [];

  if (options.where && typeof options.where === 'object' && !('sql' in options.where)) {
    const preds: string[] = [];
    for (const [k, v] of Object.entries(options.where as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (v === null) {
        preds.push(`${quoteTableIdent(k)} IS NULL`);
      } else {
        preds.push(`${quoteTableIdent(k)} = ?`);
        params.push(v);
      }
    }
    if (preds.length > 0) {
      sql += ` WHERE ${preds.join(' AND ')}`;
    }
  }

  if (typeof options.orderBy === 'string' && options.orderBy.trim()) {
    const parts = options.orderBy.trim().split(/\s+/);
    const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${quoteTableIdent(parts[0]!)} ${dir}`;
  } else if (Array.isArray(options.orderBy) && options.orderBy.length > 0) {
    const items = options.orderBy.map((item) => {
      if (typeof item === 'string') {
        const parts = item.trim().split(/\s+/);
        const dir = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${quoteTableIdent(parts[0]!)} ${dir}`;
      }
      return `${quoteTableIdent(String(item.column))} ${item.direction === 'DESC' ? 'DESC' : 'ASC'}`;
    });
    sql += ` ORDER BY ${items.join(', ')}`;
  } else {
    sql += ` ORDER BY ${pkCols.map((c) => `${quoteTableIdent(c)} ASC`).join(', ')}`;
  }

  if (options.limit !== undefined && options.limit >= 0) {
    sql += ` FETCH FIRST ${Math.floor(options.limit)} ROWS ONLY`;
  }
  return { sql, params };
}

/**
 * Framework-agnostic reactive table store backing `useTable` (React / Vue) and
 * `createTable` (Svelte / Solid) (`M22 Item 3`).
 */
export class ReactiveTableStore<T extends Row = Row, K = unknown> {
  readonly repository: TableRepository<T, K>;
  private readonly queryStore: IncrementalQueryStore<T>;
  private readonly optStore: OptimisticMutationStore | undefined;
  private readonly pkCols: readonly string[];
  private readonly tableNameUpper: string;
  private readonly listeners = new Set<() => void>();
  private unsubQuery: (() => void) | null = null;
  private unsubOpt: (() => void) | null = null;
  private state: ReactiveTableState<T>;

  constructor(
    db: ReactiveTableDatabase,
    tableName: string,
    options: ReactiveTableStoreOptions<T> = {},
    initialRows?: T[],
  ) {
    this.tableNameUpper = tableName.toUpperCase();
    this.pkCols = normalizePkList(
      options.primaryKey as string | readonly string[] | undefined,
    );
    this.repository = createTableRepository<T, K>(db, tableName, options);
    this.optStore = options.optimisticStore;
    const { sql, params } = buildReactiveTableQuery(tableName, this.pkCols, options);
    const keyOpt = this.pkCols.length === 1 ? this.pkCols[0]! : this.pkCols;
    this.queryStore = new IncrementalQueryStore<T>(
      db as unknown as {
        query<R extends Row = Row>(s: string, p?: QueryParams): Promise<QueryResult<R>>;
      },
      sql,
      params,
      {
        key: keyOpt,
        events: options.events,
        pollIntervalMs: options.pollIntervalMs,
      },
      initialRows,
    );
    this.state = this.computeSnapshot();
  }

  private computeSnapshot(): ReactiveTableState<T> {
    const q = this.queryStore.getSnapshot();
    const o = this.optStore?.getSnapshot();
    return {
      rows: q.rows ? [...q.rows] : undefined,
      deltas: q.deltas,
      version: q.version,
      loading: q.loading,
      error: q.error ?? o?.lastError,
      pendingCount: o?.pendingCount ?? 0,
      flushing: o?.flushing ?? false,
    };
  }

  private syncSnapshot = (): void => {
    this.state = this.computeSnapshot();
    for (const cb of [...this.listeners]) {
      cb();
    }
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReactiveTableState<T> => this.state;

  start(): void {
    if (!this.unsubQuery) {
      this.unsubQuery = this.queryStore.subscribe(this.syncSnapshot);
    }
    if (this.optStore && !this.unsubOpt) {
      this.unsubOpt = this.optStore.subscribe(this.syncSnapshot);
    }
    this.queryStore.start();
    this.syncSnapshot();
  }

  stop(): void {
    this.unsubQuery?.();
    this.unsubQuery = null;
    this.unsubOpt?.();
    this.unsubOpt = null;
    this.queryStore.stop();
    void this.repository.close().catch(() => undefined);
  }

  readonly refresh = async (): Promise<void> => {
    await this.queryStore.refresh();
  };

  readonly insert = async (row: Partial<T> & Record<string, unknown>): Promise<T> => {
    if (this.optStore) {
      const res = await this.optStore.insert<T>(this.tableNameUpper, row, {
        primaryKey: this.pkCols,
      });
      await this.queryStore.refresh();
      return res.row;
    }
    const inserted = await this.repository.insert(row);
    await this.queryStore.refresh();
    return inserted;
  };

  readonly update = async (
    key: K,
    patch: Partial<T> & Record<string, unknown>,
  ): Promise<{ affectedRows: number }> => {
    const res = this.optStore
      ? await this.optStore.update<T, K>(this.tableNameUpper, key, patch, {
          primaryKey: this.pkCols,
        })
      : await this.repository.update(key, patch);
    await this.queryStore.refresh();
    return { affectedRows: res.affectedRows };
  };

  readonly upsert = async (
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
  ): Promise<T> => {
    if (this.optStore) {
      const res = await this.optStore.upsert<T>(this.tableNameUpper, row, {
        primaryKey: this.pkCols,
        matchingColumns: matchingColumns?.map((c) => String(c)),
      });
      await this.queryStore.refresh();
      return res.row;
    }
    const upserted = await this.repository.upsert(row, matchingColumns);
    await this.queryStore.refresh();
    return upserted;
  };

  readonly remove = async (key: K): Promise<{ affectedRows: number }> => {
    const res = this.optStore
      ? await this.optStore.delete<K>(this.tableNameUpper, key, {
          primaryKey: this.pkCols,
        })
      : await this.repository.delete(key);
    await this.queryStore.refresh();
    return { affectedRows: res.affectedRows };
  };
}
