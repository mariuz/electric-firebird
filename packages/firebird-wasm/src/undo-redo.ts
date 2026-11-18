/**
 * undo-redo.ts – Local-First Undo / Redo Stack with Selective Per-User Row
 * Checkpoints, Grouped Multi-Statement Actions & Cross-Tab Sync (`M24 Item 4`).
 */

import type { Row } from './types';
import {
  createTableRepository,
  type TableExecutionHost,
  type TableOptions,
} from './table-api';
import {
  openSharedBroadcastChannel,
  type OptimisticMutationStore,
} from './optimistic-store';
import type { BroadcastChannelLike } from './replication/transports';

export interface UndoRedoOperationRecord {
  readonly tableName: string;
  readonly primaryKey: readonly string[];
  readonly operation: 'INSERT' | 'UPDATE' | 'UPSERT' | 'DELETE';
  readonly keyValue: unknown;
  readonly beforeRow: Row | null;
  readonly afterRow: Row | null;
  readonly optimisticMutationId?: string;
}

export interface UndoRedoEntry {
  readonly id: string;
  readonly label: string;
  readonly operations: readonly UndoRedoOperationRecord[];
  readonly createdAt: number;
}

export interface UndoRedoSnapshot {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly undoStack: readonly UndoRedoEntry[];
  readonly redoStack: readonly UndoRedoEntry[];
  readonly lastUndone: UndoRedoEntry | null;
  readonly lastRedone: UndoRedoEntry | null;
  readonly busy: boolean;
}

export interface UndoRedoOptions {
  /** Optional `OptimisticMutationStore` paired with this undo/redo stack. */
  optimisticStore?: OptimisticMutationStore;
  /** Maximum number of undo entries retained in memory. @default 100 */
  maxHistory?: number;
  /** Optional `BroadcastChannel` name or instance synchronizing undo/redo stacks across sibling tabs. */
  broadcastChannel?: string | BroadcastChannelLike;
}

export interface UndoRedoMutationOptions {
  primaryKey?: string | readonly string[];
  matchingColumns?: readonly string[];
  label?: string;
}

export interface UndoRedoTableActions<T extends Row = Row, K = unknown> {
  insert(
    row: Partial<T> & Record<string, unknown>,
    label?: string,
  ): Promise<T>;
  update(
    key: K,
    patch: Partial<T> & Record<string, unknown>,
    label?: string,
  ): Promise<{ affectedRows: number }>;
  upsert(
    row: Partial<T> & Record<string, unknown>,
    matchingColumns?: ReadonlyArray<(keyof T & string) | string>,
    label?: string,
  ): Promise<T>;
  delete(key: K, label?: string): Promise<{ affectedRows: number }>;
}

export interface UndoRedoActionScope {
  insert<T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    options?: UndoRedoMutationOptions,
  ): Promise<T>;
  update<T extends Row = Row, K = unknown>(
    tableName: string,
    key: K,
    patch: Partial<T> & Record<string, unknown>,
    options?: UndoRedoMutationOptions,
  ): Promise<{ affectedRows: number }>;
  upsert<T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    options?: UndoRedoMutationOptions,
  ): Promise<T>;
  delete<K = unknown>(
    tableName: string,
    key: K,
    options?: UndoRedoMutationOptions,
  ): Promise<{ affectedRows: number }>;
  table<T extends Row = Row, K = unknown>(
    tableName: string,
    options?: TableOptions<T>,
  ): UndoRedoTableActions<T, K>;
}

export interface UndoRedoManager extends UndoRedoActionScope {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => UndoRedoSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Execute multiple mutations inside a single grouped undo/redo checkpoint. */
  run<R>(label: string, fn: (scope: UndoRedoActionScope) => Promise<R>): Promise<R>;
  /** Undo the most recent user action selectively without reverting unrelated peer replication rows. */
  undo(): Promise<UndoRedoEntry | null>;
  /** Redo the most recently undone user action selectively. */
  redo(): Promise<UndoRedoEntry | null>;
  /** Clear both undo and redo stacks. */
  clear(): void;
  /** Detach cross-tab `BroadcastChannel` listeners if configured. */
  close(): void;
}

function normalizePkCols(pk?: string | readonly string[]): string[] {
  if (!pk) return ['ID'];
  if (typeof pk === 'string') return [pk.trim().toUpperCase() || 'ID'];
  const list = pk.map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  return list.length > 0 ? list : ['ID'];
}

function readRowCaseInsensitive(row: Record<string, unknown>, col: string): unknown {
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

function extractRowKey(row: Record<string, unknown>, pkCols: readonly string[]): unknown {
  if (pkCols.length === 1) {
    return readRowCaseInsensitive(row, pkCols[0]!);
  }
  const keyObj: Record<string, unknown> = {};
  for (const col of pkCols) {
    keyObj[col] = readRowCaseInsensitive(row, col);
  }
  return keyObj;
}

/**
 * Create a local-first `UndoRedoManager` recording per-row pre/post images for
 * user actions (`insert`, `update`, `upsert`, `delete`, and grouped `run()`
 * checkpoints) so `undo()` and `redo()` selectively revert/reapply only the
 * user's own rows while leaving concurrent background replication untouched (`M24 Item 4`).
 */
export function createUndoRedoManager(
  db: TableExecutionHost,
  options: UndoRedoOptions = {},
): UndoRedoManager {
  const maxHistory = Math.max(1, Math.floor(options.maxHistory ?? 100));
  const optimisticStore = options.optimisticStore;
  const listeners = new Set<() => void>();

  let nextEntrySeq = 1;
  let undoStack: UndoRedoEntry[] = [];
  let redoStack: UndoRedoEntry[] = [];
  let lastUndone: UndoRedoEntry | null = null;
  let lastRedone: UndoRedoEntry | null = null;
  let busy = false;
  let activeGroupCollector: UndoRedoOperationRecord[] | null = null;

  const tabOrigin = `undo_tab_${Math.random().toString(36).slice(2, 10)}`;
  const bcHandle = options.broadcastChannel
    ? openSharedBroadcastChannel(options.broadcastChannel)
    : null;

  let snapshot: UndoRedoSnapshot = {
    canUndo: false,
    canRedo: false,
    undoCount: 0,
    redoCount: 0,
    undoStack: [],
    redoStack: [],
    lastUndone: null,
    lastRedone: null,
    busy: false,
  };

  const emit = (broadcast = true): void => {
    snapshot = {
      canUndo: undoStack.length > 0 && !busy,
      canRedo: redoStack.length > 0 && !busy,
      undoCount: undoStack.length,
      redoCount: redoStack.length,
      undoStack: [...undoStack],
      redoStack: [...redoStack],
      lastUndone,
      lastRedone,
      busy,
    };
    for (const cb of [...listeners]) {
      cb();
    }
    if (broadcast && bcHandle) {
      bcHandle.channel.postMessage({
        type: 'fb_undo_redo_sync',
        origin: tabOrigin,
        undoStack,
        redoStack,
        lastUndone,
        lastRedone,
      });
    }
  };

  const onChannelMessage = (event: { data: unknown }) => {
    const msg = event.data as
      | {
          type?: string;
          origin?: string;
          undoStack?: UndoRedoEntry[];
          redoStack?: UndoRedoEntry[];
          lastUndone?: UndoRedoEntry | null;
          lastRedone?: UndoRedoEntry | null;
        }
      | undefined;
    if (!msg || msg.type !== 'fb_undo_redo_sync' || msg.origin === tabOrigin) {
      return;
    }
    if (Array.isArray(msg.undoStack)) undoStack = [...msg.undoStack];
    if (Array.isArray(msg.redoStack)) redoStack = [...msg.redoStack];
    if (msg.lastUndone !== undefined) lastUndone = msg.lastUndone;
    if (msg.lastRedone !== undefined) lastRedone = msg.lastRedone;
    emit(false);
  };

  if (bcHandle) {
    if (typeof bcHandle.channel.addEventListener === 'function') {
      bcHandle.channel.addEventListener('message', onChannelMessage);
    } else {
      bcHandle.channel.onmessage = onChannelMessage;
    }
  }

  const pushEntry = (label: string, ops: readonly UndoRedoOperationRecord[]): void => {
    if (ops.length === 0) return;
    const entry: UndoRedoEntry = {
      id: `undo_${nextEntrySeq++}`,
      label,
      operations: [...ops],
      createdAt: Date.now(),
    };
    undoStack = [...undoStack, entry];
    if (undoStack.length > maxHistory) {
      undoStack = undoStack.slice(undoStack.length - maxHistory);
    }
    redoStack = [];
    emit();
  };

  const recordOp = (label: string, op: UndoRedoOperationRecord): void => {
    if (activeGroupCollector !== null) {
      activeGroupCollector.push(op);
      return;
    }
    pushEntry(label, [op]);
  };

  const executeInsert = async <T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    mutOpts: UndoRedoMutationOptions = {},
  ): Promise<T> => {
    const pkCols = normalizePkCols(mutOpts.primaryKey);
    const tableUpper = tableName.trim().toUpperCase();

    if (optimisticStore) {
      const res = await optimisticStore.insert<T>(tableUpper, row, { primaryKey: pkCols });
      const pendingMut = optimisticStore
        .getSnapshot()
        .pending.find((m) => m.id === res.mutationId);
      recordOp(mutOpts.label ?? `INSERT ${tableUpper}`, {
        tableName: tableUpper,
        primaryKey: pkCols,
        operation: 'INSERT',
        keyValue:
          pendingMut?.keyValue ??
          extractRowKey(res.row as Record<string, unknown>, pkCols),
        beforeRow: null,
        afterRow: { ...(res.row as Row) },
        optimisticMutationId: res.mutationId,
      });
      return res.row;
    }

    const repo = createTableRepository<T, unknown>(db, tableUpper, {
      primaryKey: pkCols,
      cacheStatements: false,
    });
    const inserted = await repo.insert(row);
    const keyValue = extractRowKey(inserted as Record<string, unknown>, pkCols);
    recordOp(mutOpts.label ?? `INSERT ${tableUpper}`, {
      tableName: tableUpper,
      primaryKey: pkCols,
      operation: 'INSERT',
      keyValue,
      beforeRow: null,
      afterRow: { ...(inserted as Row) },
    });
    return inserted;
  };

  const executeUpdate = async <T extends Row = Row, K = unknown>(
    tableName: string,
    key: K,
    patch: Partial<T> & Record<string, unknown>,
    mutOpts: UndoRedoMutationOptions = {},
  ): Promise<{ affectedRows: number }> => {
    const pkCols = normalizePkCols(mutOpts.primaryKey);
    const tableUpper = tableName.trim().toUpperCase();

    if (optimisticStore) {
      const repo = createTableRepository<T, K>(db, tableUpper, {
        primaryKey: pkCols,
        cacheStatements: false,
      });
      const beforeRow = await repo.get(key);
      const res = await optimisticStore.update<T, K>(tableUpper, key, patch, {
        primaryKey: pkCols,
      });
      const afterRow = await repo.get(key);
      if (res.affectedRows > 0) {
        recordOp(mutOpts.label ?? `UPDATE ${tableUpper}`, {
          tableName: tableUpper,
          primaryKey: pkCols,
          operation: 'UPDATE',
          keyValue: key,
          beforeRow: beforeRow ? { ...(beforeRow as Row) } : null,
          afterRow: afterRow ? { ...(afterRow as Row) } : null,
          optimisticMutationId: res.mutationId,
        });
      }
      return { affectedRows: res.affectedRows };
    }

    const repo = createTableRepository<T, K>(db, tableUpper, {
      primaryKey: pkCols,
      cacheStatements: false,
    });
    const beforeRow = await repo.get(key);
    const updRes = await repo.update(key, patch);
    const afterRow = await repo.get(key);
    if (updRes.affectedRows > 0) {
      recordOp(mutOpts.label ?? `UPDATE ${tableUpper}`, {
        tableName: tableUpper,
        primaryKey: pkCols,
        operation: 'UPDATE',
        keyValue: key,
        beforeRow: beforeRow ? { ...(beforeRow as Row) } : null,
        afterRow: afterRow ? { ...(afterRow as Row) } : null,
      });
    }
    return updRes;
  };

  const executeUpsert = async <T extends Row = Row>(
    tableName: string,
    row: Partial<T> & Record<string, unknown>,
    mutOpts: UndoRedoMutationOptions = {},
  ): Promise<T> => {
    const pkCols = normalizePkCols(mutOpts.primaryKey);
    const tableUpper = tableName.trim().toUpperCase();
    const keyValue = extractRowKey(row as Record<string, unknown>, pkCols);
    const repo = createTableRepository<T, unknown>(db, tableUpper, {
      primaryKey: pkCols,
      cacheStatements: false,
    });
    const beforeRow =
      keyValue !== undefined && keyValue !== null ? await repo.get(keyValue) : null;

    if (optimisticStore) {
      const res = await optimisticStore.upsert<T>(tableUpper, row, {
        primaryKey: pkCols,
        matchingColumns: mutOpts.matchingColumns,
      });
      recordOp(mutOpts.label ?? `UPSERT ${tableUpper}`, {
        tableName: tableUpper,
        primaryKey: pkCols,
        operation: 'UPSERT',
        keyValue: extractRowKey(res.row as Record<string, unknown>, pkCols),
        beforeRow: beforeRow ? { ...(beforeRow as Row) } : null,
        afterRow: { ...(res.row as Row) },
        optimisticMutationId: res.mutationId,
      });
      return res.row;
    }

    const upserted = await repo.upsert(row, mutOpts.matchingColumns ?? pkCols);
    recordOp(mutOpts.label ?? `UPSERT ${tableUpper}`, {
      tableName: tableUpper,
      primaryKey: pkCols,
      operation: 'UPSERT',
      keyValue: extractRowKey(upserted as Record<string, unknown>, pkCols),
      beforeRow: beforeRow ? { ...(beforeRow as Row) } : null,
      afterRow: { ...(upserted as Row) },
    });
    return upserted;
  };

  const executeDelete = async <K = unknown>(
    tableName: string,
    key: K,
    mutOpts: UndoRedoMutationOptions = {},
  ): Promise<{ affectedRows: number }> => {
    const pkCols = normalizePkCols(mutOpts.primaryKey);
    const tableUpper = tableName.trim().toUpperCase();
    const repo = createTableRepository<Row, K>(db, tableUpper, {
      primaryKey: pkCols,
      cacheStatements: false,
    });
    const beforeRow = await repo.get(key);

    if (optimisticStore) {
      const res = await optimisticStore.delete<K>(tableUpper, key, { primaryKey: pkCols });
      if (beforeRow) {
        recordOp(mutOpts.label ?? `DELETE ${tableUpper}`, {
          tableName: tableUpper,
          primaryKey: pkCols,
          operation: 'DELETE',
          keyValue: key,
          beforeRow: { ...beforeRow },
          afterRow: null,
          optimisticMutationId: res.mutationId,
        });
      }
      return { affectedRows: res.affectedRows };
    }

    const delRes = await repo.delete(key);
    if (beforeRow && delRes.affectedRows > 0) {
      recordOp(mutOpts.label ?? `DELETE ${tableUpper}`, {
        tableName: tableUpper,
        primaryKey: pkCols,
        operation: 'DELETE',
        keyValue: key,
        beforeRow: { ...beforeRow },
        afterRow: null,
      });
    }
    return delRes;
  };

  const buildTableActions = <T extends Row = Row, K = unknown>(
    tableName: string,
    tableOpts: TableOptions<T> = {},
  ): UndoRedoTableActions<T, K> => {
    const pk = tableOpts.primaryKey as string | readonly string[] | undefined;
    return {
      insert: (row, label) => executeInsert<T>(tableName, row, { primaryKey: pk, label }),
      update: (key, patch, label) =>
        executeUpdate<T, K>(tableName, key, patch, { primaryKey: pk, label }),
      upsert: (row, matchingColumns, label) =>
        executeUpsert<T>(tableName, row, {
          primaryKey: pk,
          matchingColumns: matchingColumns?.map((c) => String(c)),
          label,
        }),
      delete: (key, label) => executeDelete<K>(tableName, key, { primaryKey: pk, label }),
    };
  };

  const applyInverseOperation = async (op: UndoRedoOperationRecord): Promise<void> => {
    if (optimisticStore && op.optimisticMutationId) {
      const stillPending = optimisticStore
        .getSnapshot()
        .pending.some((m) => m.id === op.optimisticMutationId);
      if (stillPending) {
        const reverted = await optimisticStore.revert(op.optimisticMutationId);
        if (reverted) return;
      }
    }

    if (optimisticStore) {
      if (op.beforeRow === null) {
        await optimisticStore.delete(op.tableName, op.keyValue, {
          primaryKey: op.primaryKey,
        });
      } else {
        await optimisticStore.upsert(
          op.tableName,
          op.beforeRow as Record<string, unknown>,
          { primaryKey: op.primaryKey },
        );
      }
      return;
    }

    const repo = createTableRepository<Row, unknown>(db, op.tableName, {
      primaryKey: op.primaryKey,
      cacheStatements: false,
    });
    if (op.beforeRow === null) {
      await repo.delete(op.keyValue);
    } else {
      await repo.upsert(op.beforeRow as Record<string, unknown>, op.primaryKey);
    }
  };

  const reapplyForwardOperation = async (
    op: UndoRedoOperationRecord,
  ): Promise<UndoRedoOperationRecord> => {
    if (optimisticStore) {
      if (op.afterRow === null) {
        const res = await optimisticStore.delete(op.tableName, op.keyValue, {
          primaryKey: op.primaryKey,
        });
        return { ...op, optimisticMutationId: res.mutationId };
      }
      const res = await optimisticStore.upsert(
        op.tableName,
        op.afterRow as Record<string, unknown>,
        { primaryKey: op.primaryKey },
      );
      return { ...op, optimisticMutationId: res.mutationId };
    }

    const repo = createTableRepository<Row, unknown>(db, op.tableName, {
      primaryKey: op.primaryKey,
      cacheStatements: false,
    });
    if (op.afterRow === null) {
      await repo.delete(op.keyValue);
    } else {
      await repo.upsert(op.afterRow as Record<string, unknown>, op.primaryKey);
    }
    return op;
  };

  const scope: UndoRedoActionScope = {
    insert: executeInsert,
    update: executeUpdate,
    upsert: executeUpsert,
    delete: executeDelete,
    table: buildTableActions,
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    get canUndo() {
      return undoStack.length > 0 && !busy;
    },
    get canRedo() {
      return redoStack.length > 0 && !busy;
    },
    insert: executeInsert,
    update: executeUpdate,
    upsert: executeUpsert,
    delete: executeDelete,
    table: buildTableActions,

    async run<R>(label: string, fn: (ctx: UndoRedoActionScope) => Promise<R>): Promise<R> {
      const parentCollector = activeGroupCollector;
      const collector: UndoRedoOperationRecord[] = [];
      activeGroupCollector = collector;
      try {
        const result = await fn(scope);
        if (parentCollector !== null) {
          parentCollector.push(...collector);
        } else if (collector.length > 0) {
          pushEntry(label, collector);
        }
        return result;
      } finally {
        activeGroupCollector = parentCollector;
      }
    },

    async undo(): Promise<UndoRedoEntry | null> {
      if (busy || undoStack.length === 0) return null;
      const entry = undoStack[undoStack.length - 1]!;
      busy = true;
      emit(false);
      try {
        const reversed = [...entry.operations].reverse();
        for (const op of reversed) {
          await applyInverseOperation(op);
        }
        undoStack = undoStack.slice(0, -1);
        redoStack = [...redoStack, entry];
        lastUndone = entry;
        busy = false;
        emit();
        return entry;
      } catch (err) {
        busy = false;
        emit(false);
        throw err;
      }
    },

    async redo(): Promise<UndoRedoEntry | null> {
      if (busy || redoStack.length === 0) return null;
      const entry = redoStack[redoStack.length - 1]!;
      busy = true;
      emit(false);
      try {
        const refreshedOps: UndoRedoOperationRecord[] = [];
        for (const op of entry.operations) {
          refreshedOps.push(await reapplyForwardOperation(op));
        }
        const redoneEntry: UndoRedoEntry = {
          ...entry,
          operations: refreshedOps,
        };
        redoStack = redoStack.slice(0, -1);
        undoStack = [...undoStack, redoneEntry];
        lastRedone = redoneEntry;
        busy = false;
        emit();
        return redoneEntry;
      } catch (err) {
        busy = false;
        emit(false);
        throw err;
      }
    },

    clear(): void {
      undoStack = [];
      redoStack = [];
      lastUndone = null;
      lastRedone = null;
      emit();
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
}
