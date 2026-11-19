/**
 * broadcast-transport.ts – Cross-Tab / Cross-Worker `BroadcastChannel`
 * Replication Transport (`M25 Item 5` split from `transports.ts`).
 */

import type {
  ReplicationLogEntry,
  ReplicationPublication,
  ReplicationSubscription,
} from './types';

/** Structural interface for a browser `BroadcastChannel` or test double. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

const inProcessBroadcastBus = new Map<string, Set<(data: unknown) => void>>();

function createInProcessChannel(channelName: string): BroadcastChannelLike {
  let listeners = inProcessBroadcastBus.get(channelName);
  if (!listeners) {
    listeners = new Set();
    inProcessBroadcastBus.set(channelName, listeners);
  }
  const localListeners = new Set<(event: { data: unknown }) => void>();
  const dispatch = (data: unknown) => {
    for (const fn of localListeners) {
      fn({ data });
    }
    if (channel.onmessage) {
      channel.onmessage({ data });
    }
  };
  listeners.add(dispatch);

  const channel: BroadcastChannelLike = {
    postMessage(message: unknown) {
      const group = inProcessBroadcastBus.get(channelName);
      if (!group) return;
      for (const peerDispatch of group) {
        if (peerDispatch !== dispatch) {
          peerDispatch(message);
        }
      }
    },
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      localListeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
      localListeners.delete(listener);
    },
    onmessage: null,
    close() {
      inProcessBroadcastBus.get(channelName)?.delete(dispatch);
      localListeners.clear();
    },
  };
  return channel;
}

/** Options for {@link createBroadcastChannelTransport}. */
export interface BroadcastChannelTransportOptions {
  /** BroadcastChannel name shared across tabs/workers. @default 'fb_repl_channel' */
  channelName?: string;
  /** Optional custom `BroadcastChannel` instance. */
  channel?: BroadcastChannelLike;
  /** Local publication whose changes are broadcast to peer tabs/workers. */
  publication?: ReplicationPublication;
  /** Local subscription that applies entries received from peer tabs/workers. */
  subscription?: ReplicationSubscription;
  /** Automatically call `subscription.pull()` when a peer announces a new LSN. @default true */
  autoPullOnAnnounce?: boolean;
}

/** Cross-tab / cross-worker transport returned by {@link createBroadcastChannelTransport}. */
export interface BroadcastChannelTransport {
  readonly channelName: string;
  /** Broadcast explicit journal entries to all peer tabs/workers on the channel. */
  publishEntries(entries: readonly ReplicationLogEntry[]): Promise<void>;
  /** Broadcast a lightweight LSN wakeup signal to peer tabs/workers. */
  announceChange(lsn?: number): Promise<void>;
  /** Capture new local table changes on `publication` and broadcast them to peers. */
  sync(): Promise<ReplicationLogEntry[]>;
  /** Close the underlying `BroadcastChannel` listener. */
  close(): void;
}

/**
 * Create a cross-tab / cross-worker replication transport backed by `BroadcastChannel`
 * (with an automatic in-process fallback when `BroadcastChannel` is unavailable).
 */
export function createBroadcastChannelTransport(
  options: BroadcastChannelTransportOptions = {},
): BroadcastChannelTransport {
  const channelName = (options.channelName ?? 'fb_repl_channel').trim();
  const autoPull = options.autoPullOnAnnounce ?? true;
  const ownsChannel = !options.channel;
  const channel: BroadcastChannelLike =
    options.channel ??
    (typeof globalThis.BroadcastChannel === 'function'
      ? (new globalThis.BroadcastChannel(channelName) as unknown as BroadcastChannelLike)
      : createInProcessChannel(channelName));

  let lastBroadcastLsn = 0;

  const onMessage = (event: { data: unknown }) => {
    const msg = event.data as
      | {
          type?: string;
          origin?: string;
          lsn?: number;
          entries?: ReplicationLogEntry[];
        }
      | undefined;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'entries' && Array.isArray(msg.entries) && options.subscription) {
      if (msg.origin && msg.origin === options.subscription.nodeId) return;
      void options.subscription.applyChanges(msg.entries);
    } else if (msg.type === 'announce' && autoPull && options.subscription) {
      if (msg.origin && msg.origin === options.subscription.nodeId) return;
      void options.subscription.pull();
    }
  };

  if (typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', onMessage);
  } else {
    channel.onmessage = onMessage;
  }

  return {
    channelName,

    async publishEntries(entries) {
      if (entries.length === 0) return;
      for (const e of entries) {
        if (e.lsn > lastBroadcastLsn) {
          lastBroadcastLsn = e.lsn;
        }
      }
      channel.postMessage({
        type: 'entries',
        origin: options.publication?.nodeId,
        entries: [...entries],
      });
    },

    async announceChange(lsn) {
      const effectiveLsn =
        lsn ?? (options.publication ? await options.publication.currentLsn() : 0);
      channel.postMessage({
        type: 'announce',
        origin: options.publication?.nodeId,
        lsn: effectiveLsn,
      });
    },

    async sync() {
      if (!options.publication) return [];
      await options.publication.captureTableChanges();
      const entries = await options.publication.fetchChangesSince(lastBroadcastLsn, {
        excludeOrigin: options.subscription?.nodeId,
      });
      if (entries.length > 0) {
        await this.publishEntries(entries);
      }
      return entries;
    },

    close() {
      if (typeof channel.removeEventListener === 'function') {
        channel.removeEventListener('message', onMessage);
      } else if (channel.onmessage === onMessage) {
        channel.onmessage = null;
      }
      if (ownsChannel) {
        channel.close?.();
      }
    },
  };
}
