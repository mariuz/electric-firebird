/**
 * presence-undo.ts – Svelte 5 Runes & Store adapters for Local-First Undo/Redo
 * (`createUndoRedo`) and Collaborative Presence (`createPresence`) (`M24`/`M26`).
 */

import type { TableExecutionHost } from '../table-api';
import {
  createUndoRedoManager,
  type UndoRedoEntry,
  type UndoRedoManager,
  type UndoRedoOptions,
  type UndoRedoSnapshot,
} from '../undo-redo';
import {
  createPresenceRoom,
  type PresenceCursor,
  type PresencePeerState,
  type PresenceRoom,
  type PresenceRoomOptions,
  type PresenceRoomSnapshot,
} from '../replication/presence';
import { resolveSveltePrimitives, useFirebird } from './index';

export type { UndoRedoEntry, UndoRedoManager, UndoRedoOptions, UndoRedoSnapshot };
export type {
  PresenceCursor,
  PresencePeerState,
  PresenceRoom,
  PresenceRoomOptions,
  PresenceRoomSnapshot,
};

export interface SvelteUndoRedoStore {
  readonly manager: UndoRedoManager;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly undoStack: readonly UndoRedoEntry[];
  readonly redoStack: readonly UndoRedoEntry[];
  readonly lastUndone: UndoRedoEntry | null;
  readonly lastRedone: UndoRedoEntry | null;
  readonly busy: boolean;
  readonly current: UndoRedoSnapshot;
  subscribe(run: (value: UndoRedoSnapshot) => void): () => void;
  undo: UndoRedoManager['undo'];
  redo: UndoRedoManager['redo'];
  run: UndoRedoManager['run'];
  clear: UndoRedoManager['clear'];
  insert: UndoRedoManager['insert'];
  update: UndoRedoManager['update'];
  upsert: UndoRedoManager['upsert'];
  delete: UndoRedoManager['delete'];
  table: UndoRedoManager['table'];
  destroy(): void;
}

function isSvelteUndoRedoManager(val: unknown): val is UndoRedoManager {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as UndoRedoManager).undo === 'function' &&
    typeof (val as UndoRedoManager).redo === 'function' &&
    typeof (val as UndoRedoManager).getSnapshot === 'function'
  );
}

export function createUndoRedo(
  managerOrOptions:
    | UndoRedoManager
    | (UndoRedoOptions & { db?: TableExecutionHost; manager?: UndoRedoManager }) = {},
): SvelteUndoRedoStore {
  const primitives = resolveSveltePrimitives();
  const manager = isSvelteUndoRedoManager(managerOrOptions)
    ? managerOrOptions
    : managerOrOptions.manager ??
      createUndoRedoManager(
        (managerOrOptions.db ?? useFirebird()) as unknown as TableExecutionHost,
        managerOrOptions,
      );
  const owned = !isSvelteUndoRedoManager(managerOrOptions) && !managerOrOptions.manager;

  const stateBox = primitives.createStateBox
    ? primitives.createStateBox<UndoRedoSnapshot>(manager.getSnapshot())
    : {
        value: manager.getSnapshot(),
        get() {
          return this.value;
        },
        set(next: UndoRedoSnapshot) {
          this.value = next;
        },
      };

  const subscribers = new Set<(v: UndoRedoSnapshot) => void>();
  const unsub = manager.subscribe(() => {
    const snap = manager.getSnapshot();
    stateBox.set(snap);
    for (const fn of [...subscribers]) fn(snap);
  });

  const destroy = () => {
    unsub();
    subscribers.clear();
    if (owned) manager.close();
  };
  if (typeof primitives.onDestroy === 'function') {
    try {
      primitives.onDestroy(destroy);
    } catch {
      // Ignore outside component init
    }
  }

  return {
    manager,
    get canUndo() {
      return stateBox.get().canUndo;
    },
    get canRedo() {
      return stateBox.get().canRedo;
    },
    get undoCount() {
      return stateBox.get().undoCount;
    },
    get redoCount() {
      return stateBox.get().redoCount;
    },
    get undoStack() {
      return stateBox.get().undoStack;
    },
    get redoStack() {
      return stateBox.get().redoStack;
    },
    get lastUndone() {
      return stateBox.get().lastUndone;
    },
    get lastRedone() {
      return stateBox.get().lastRedone;
    },
    get busy() {
      return stateBox.get().busy;
    },
    get current() {
      return stateBox.get();
    },
    subscribe(run) {
      subscribers.add(run);
      run(stateBox.get());
      return () => {
        subscribers.delete(run);
      };
    },
    undo: manager.undo,
    redo: manager.redo,
    run: manager.run,
    clear: manager.clear,
    insert: manager.insert,
    update: manager.update,
    upsert: manager.upsert,
    delete: manager.delete,
    table: manager.table,
    destroy,
  };
}

export interface SveltePresenceStore<TState = Record<string, unknown>> {
  readonly room: PresenceRoom<TState>;
  readonly self: PresencePeerState<TState>;
  readonly peers: readonly PresencePeerState<TState>[];
  readonly onlineCount: number;
  readonly current: PresenceRoomSnapshot<TState>;
  subscribe(run: (value: PresenceRoomSnapshot<TState>) => void): () => void;
  updateState: PresenceRoom<TState>['updateState'];
  setCursor: PresenceRoom<TState>['setCursor'];
  setTyping: PresenceRoom<TState>['setTyping'];
  leave: PresenceRoom<TState>['leave'];
  destroy(): void;
}

function isSveltePresenceRoom<TState>(val: unknown): val is PresenceRoom<TState> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as PresenceRoom<TState>).getSnapshot === 'function' &&
    typeof (val as PresenceRoom<TState>).setCursor === 'function' &&
    typeof (val as PresenceRoom<TState>).subscribe === 'function'
  );
}

export function createPresence<TState = Record<string, unknown>>(
  roomOrOptions: PresenceRoom<TState> | PresenceRoomOptions<TState>,
): SveltePresenceStore<TState> {
  const primitives = resolveSveltePrimitives();
  const owned = !isSveltePresenceRoom<TState>(roomOrOptions);
  const room = isSveltePresenceRoom<TState>(roomOrOptions)
    ? roomOrOptions
    : createPresenceRoom<TState>(roomOrOptions);

  const stateBox = primitives.createStateBox
    ? primitives.createStateBox<PresenceRoomSnapshot<TState>>(room.getSnapshot())
    : {
        value: room.getSnapshot(),
        get() {
          return this.value;
        },
        set(next: PresenceRoomSnapshot<TState>) {
          this.value = next;
        },
      };

  const subscribers = new Set<(v: PresenceRoomSnapshot<TState>) => void>();
  const unsub = room.subscribe((snap) => {
    stateBox.set(snap);
    for (const fn of [...subscribers]) fn(snap);
  });

  const destroy = () => {
    unsub();
    subscribers.clear();
    if (owned) void room.close();
  };
  if (typeof primitives.onDestroy === 'function') {
    try {
      primitives.onDestroy(destroy);
    } catch {
      // Ignore outside component init
    }
  }

  return {
    room,
    get self() {
      return stateBox.get().self;
    },
    get peers() {
      return stateBox.get().peers;
    },
    get onlineCount() {
      return stateBox.get().onlineCount;
    },
    get current() {
      return stateBox.get();
    },
    subscribe(run) {
      subscribers.add(run);
      run(stateBox.get());
      return () => {
        subscribers.delete(run);
      };
    },
    updateState: (p) => room.updateState(p),
    setCursor: (c) => room.setCursor(c),
    setTyping: (t) => room.setTyping(t),
    leave: () => room.leave(),
    destroy,
  };
}
