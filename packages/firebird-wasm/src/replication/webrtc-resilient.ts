/**
 * WebRTC `RTCDataChannel` Peer-to-Peer Replication Transport (with 16 KB SCTP
 * Chunking, CRC-32 Verification & `bufferedAmount` Backpressure) and Resilient
 * Auto-Reconnecting Transports (`M19 Item 3`).
 */

import type {
  PublicationSnapshot,
  ReplicableDatabase,
  ReplicationLogEntry,
  ReplicationPublication,
  ReplicationSubscription,
} from './types';
import { gunzipBytes, gzipBytes, isGzipBytes } from './shared';
import {
  applyFbChangelogSegmentToDatabase,
  type ApplyFbChangelogResult,
} from './native-changelog';
import {
  bootstrapReplica,
} from './core';
import {
  createWebSocketReplicationPeer,
  type WebSocketLike,
  type WebSocketReplicationPeer,
} from './transports';

// ---------------------------------------------------------------------------
// 1. Connection Lifecycle State & Exponential Backoff + Jitter (`M19 Item 3`)
// ---------------------------------------------------------------------------

/** Transport connection lifecycle state (`M19 Item 3`). */
export type ConnectionLifecycleState =
  | 'connecting'
  | 'online'
  | 'backoff'
  | 'offline';

/** State transition metadata emitted to `onStateChange` listeners (`M19 Item 3`). */
export interface ConnectionStateChangeInfo {
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly error?: Error;
}

/** Exponential backoff + jitter configuration (`M19 Item 3`). */
export interface BackoffRetryOptions {
  /** Maximum retry attempts before surfacing an error (`Infinity` for persistent sockets). @default 4 */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds for attempt `0`. @default 100 */
  baseDelayMs?: number;
  /** Upper bound on backoff delay in milliseconds. @default 10000 */
  maxDelayMs?: number;
  /** Exponential growth multiplier per attempt. @default 2 */
  factor?: number;
  /** Proportional random jitter in `[0, 1]` (`0` = deterministic). @default 0.2 */
  jitterRatio?: number;
  /** Optional custom RNG returning `[0, 1)` for deterministic testing. */
  random?: () => number;
}

/**
 * Compute an exponential backoff delay in milliseconds with bounded jitter (`M19 Item 3`).
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffRetryOptions = {},
): number {
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 100);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 10_000);
  const factor = Math.max(1, options.factor ?? 2);
  const jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? 0.2));
  const rng = options.random ?? Math.random;

  const exp = Math.min(
    maxDelayMs,
    baseDelayMs * Math.pow(factor, Math.max(0, attempt)),
  );
  if (jitterRatio === 0) {
    return Math.round(exp);
  }
  const jitterSpan = exp * jitterRatio;
  const jittered = exp - jitterSpan * 0.5 + rng() * jitterSpan;
  return Math.max(1, Math.min(maxDelayMs, Math.round(jittered)));
}

// ---------------------------------------------------------------------------
// 2. IEEE 802.3 CRC-32 & WebRTC 16 KB SCTP Frame Chunking (`M19 Item 3`)
// ---------------------------------------------------------------------------

/** 32-bit ASCII magic `'WRTC'` (`0x57525443`) prefixing every chunked WebRTC frame (`M19 Item 3`). */
export const WEBRTC_CHUNK_MAGIC = 0x57525443;

/** Fixed byte size of the WebRTC chunk frame header (`24` bytes). */
export const WEBRTC_CHUNK_HEADER_BYTES = 24;

/** Default maximum SCTP frame size (`16384` bytes = 16 KB, safe across all browsers). */
export const DEFAULT_WEBRTC_MAX_CHUNK_BYTES = 16 * 1024;

/** Payload kind codes carried in byte `5` of a WebRTC chunk header (`M19 Item 3`). */
export const WebRtcPayloadKind = {
  JsonControl: 1,
  ChangelogRaw: 2,
  ChangelogGzip: 3,
  SnapshotJson: 4,
} as const;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** Compute standard IEEE 802.3 CRC-32 checksum as an unsigned 32-bit integer (`M19 Item 3`). */
export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Alias for {@link computeCrc32} for WebRTC chunk verification (`M19 Item 3`). */
export const computeWebRtcCrc32 = computeCrc32;

/** Options for {@link chunkWebRtcPayload} (`M19 Item 3`). */
export interface ChunkWebRtcPayloadOptions {
  /** Monotonic 32-bit transfer identifier. @default 1 */
  transferId?: number;
  /** Payload kind discriminator (`WebRtcPayloadKind`). @default 1 */
  payloadKind?: number;
  /** Maximum total frame size in bytes (including the 24-byte header). @default 16384 */
  maxChunkBytes?: number;
}

/**
 * Split an arbitrary binary payload into SCTP-safe frames (`<= maxChunkBytes`,
 * default `16 KB`) with a 24-byte `'WRTC'` header and full-payload CRC-32 (`M19 Item 3`).
 */
export function chunkWebRtcPayload(
  payload: Uint8Array,
  options: ChunkWebRtcPayloadOptions = {},
): Uint8Array[] {
  const transferId = (options.transferId ?? 1) >>> 0;
  const payloadKind = (options.payloadKind ?? WebRtcPayloadKind.JsonControl) & 0xff;
  const maxChunkBytes = Math.max(
    WEBRTC_CHUNK_HEADER_BYTES + 16,
    options.maxChunkBytes ?? DEFAULT_WEBRTC_MAX_CHUNK_BYTES,
  );
  const maxBodyBytes = maxChunkBytes - WEBRTC_CHUNK_HEADER_BYTES;
  const totalChunks = Math.max(1, Math.ceil(payload.byteLength / maxBodyBytes));
  const crc32 = computeCrc32(payload);

  const frames: Uint8Array[] = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * maxBodyBytes;
    const end = Math.min(payload.byteLength, start + maxBodyBytes);
    const sliceLen = Math.max(0, end - start);

    const frame = new Uint8Array(WEBRTC_CHUNK_HEADER_BYTES + sliceLen);
    const view = new DataView(frame.buffer);
    view.setUint32(0, WEBRTC_CHUNK_MAGIC, false); // 'WRTC' big-endian
    frame[4] = 1; // version = 1
    frame[5] = payloadKind;
    view.setUint16(6, 0, true); // reserved
    view.setUint32(8, transferId, true);
    view.setUint32(12, chunkIndex, true);
    view.setUint32(16, totalChunks, true);
    view.setUint32(20, crc32, true);

    if (sliceLen > 0) {
      frame.set(payload.subarray(start, end), WEBRTC_CHUNK_HEADER_BYTES);
    }
    frames.push(frame);
  }

  return frames;
}

/** Reassembled payload returned by {@link WebRtcChunkAssembler} (`M19 Item 3`). */
export interface AssembledWebRtcPayload {
  readonly transferId: number;
  readonly payloadKind: number;
  readonly totalChunks: number;
  readonly crc32: number;
  readonly payload: Uint8Array;
}

interface PendingAssembly {
  readonly transferId: number;
  readonly payloadKind: number;
  readonly totalChunks: number;
  readonly expectedCrc32: number;
  readonly chunks: Array<Uint8Array | undefined>;
  receivedCount: number;
  byteLength: number;
  createdAt: number;
}

/**
 * Stateful reassembler for `'WRTC'` chunked SCTP frames supporting both ordered
 * and unordered `RTCDataChannel` delivery with end-to-end CRC-32 verification (`M19 Item 3`).
 */
export class WebRtcChunkAssembler {
  private readonly pending = new Map<number, PendingAssembly>();
  private readonly timeoutMs: number;

  constructor(options: { assemblyTimeoutMs?: number } = {}) {
    this.timeoutMs = Math.max(1_000, options.assemblyTimeoutMs ?? 60_000);
  }

  get pendingTransferCount(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }

  private evictExpired(now: number): void {
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > this.timeoutMs) {
        this.pending.delete(id);
      }
    }
  }

  /**
   * Push a single `'WRTC'` frame. Returns the reassembled payload once all
   * `totalChunks` have arrived and passed CRC-32 verification, or `null` while
   * awaiting remaining chunks.
   */
  pushChunk(frame: Uint8Array, now = Date.now()): AssembledWebRtcPayload | null {
    if (frame.byteLength < WEBRTC_CHUNK_HEADER_BYTES) {
      throw new Error(
        `Truncated WebRTC chunk frame (${frame.byteLength} < ${WEBRTC_CHUNK_HEADER_BYTES} bytes).`,
      );
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const magic = view.getUint32(0, false);
    if (magic !== WEBRTC_CHUNK_MAGIC) {
      throw new Error(
        `Invalid WebRTC chunk magic 0x${magic.toString(16)} (expected 0x57525443).`,
      );
    }
    const version = frame[4]!;
    if (version !== 1) {
      throw new Error(`Unsupported WebRTC chunk protocol version ${version}.`);
    }

    const payloadKind = frame[5]!;
    const transferId = view.getUint32(8, true);
    const chunkIndex = view.getUint32(12, true);
    const totalChunks = view.getUint32(16, true);
    const expectedCrc32 = view.getUint32(20, true);

    if (totalChunks === 0 || chunkIndex >= totalChunks) {
      throw new Error(
        `Invalid WebRTC chunk bounds (${chunkIndex}/${totalChunks}) for transfer ${transferId}.`,
      );
    }

    const body = frame.slice(WEBRTC_CHUNK_HEADER_BYTES);

    // Fast path for single-chunk messages
    if (totalChunks === 1) {
      const actualCrc = computeCrc32(body);
      if (actualCrc !== expectedCrc32) {
        throw new Error(
          `WebRTC payload CRC-32 mismatch for transfer ${transferId} (expected 0x${expectedCrc32.toString(16)}, got 0x${actualCrc.toString(16)}).`,
        );
      }
      return {
        transferId,
        payloadKind,
        totalChunks: 1,
        crc32: actualCrc,
        payload: body,
      };
    }

    this.evictExpired(now);

    let state = this.pending.get(transferId);
    if (!state) {
      state = {
        transferId,
        payloadKind,
        totalChunks,
        expectedCrc32,
        chunks: new Array<Uint8Array | undefined>(totalChunks),
        receivedCount: 0,
        byteLength: 0,
        createdAt: now,
      };
      this.pending.set(transferId, state);
    }

    if (state.chunks[chunkIndex] === undefined) {
      state.chunks[chunkIndex] = body;
      state.receivedCount++;
      state.byteLength += body.byteLength;
    }

    if (state.receivedCount < state.totalChunks) {
      return null;
    }

    this.pending.delete(transferId);
    const full = new Uint8Array(state.byteLength);
    let offset = 0;
    for (let i = 0; i < state.totalChunks; i++) {
      const part = state.chunks[i]!;
      full.set(part, offset);
      offset += part.byteLength;
    }

    const actualCrc = computeCrc32(full);
    if (actualCrc !== state.expectedCrc32) {
      throw new Error(
        `WebRTC reassembled CRC-32 mismatch for transfer ${transferId} (expected 0x${state.expectedCrc32.toString(16)}, got 0x${actualCrc.toString(16)}).`,
      );
    }

    return {
      transferId,
      payloadKind: state.payloadKind,
      totalChunks: state.totalChunks,
      crc32: actualCrc,
      payload: full,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. WebRTC `RTCDataChannel` Peer-to-Peer Sync (`createWebRtcReplicationPeer`)
// ---------------------------------------------------------------------------

/** Structural interface for a standard browser/Node `RTCDataChannel` (`M19 Item 3`). */
export interface RtcDataChannelLike {
  readonly label?: string;
  readyState?: 'connecting' | 'open' | 'closing' | 'closed' | string;
  binaryType?: string;
  bufferedAmount?: number;
  bufferedAmountLowThreshold?: number;
  ordered?: boolean;
  maxPacketLifeTime?: number | null;
  maxRetransmits?: number | null;
  send(data: Uint8Array | ArrayBuffer | string): void;
  addEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onbufferedamountlow?: (() => void) | null;
  onopen?: (() => void) | null;
  onclose?: (() => void) | null;
  onerror?: ((err: unknown) => void) | null;
  close?(): void;
}

/** Detect whether `value` is a WebRTC `RTCDataChannel`-like object (`M19 Item 3`). */
export function isRtcDataChannelLike(value: unknown): value is RtcDataChannelLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.send !== 'function') return false;
  return (
    'bufferedAmountLowThreshold' in candidate ||
    'ordered' in candidate ||
    'maxPacketLifeTime' in candidate ||
    'maxRetransmits' in candidate ||
    candidate.kind === 'rtc-datachannel'
  );
}

/** Detect whether `value` is a `WebSocket`-like duplex socket (`M19 Item 3`). */
export function isWebSocketLike(value: unknown): value is WebSocketLike {
  if (!value || typeof value !== 'object') return false;
  if (isRtcDataChannelLike(value)) return false;
  return typeof (value as Record<string, unknown>).send === 'function';
}

/** Options for {@link createWebRtcReplicationPeer} (`M19 Item 3`). */
export interface WebRtcReplicationPeerOptions {
  /** Underlying `RTCDataChannel` connecting two peers. */
  channel: RtcDataChannelLike;
  /** Local publication to stream logical changes and snapshots from. */
  publication?: ReplicationPublication;
  /** Local subscription to apply incoming logical changes and snapshots to. */
  subscription?: ReplicationSubscription;
  /** Optional replica database to apply incoming `"FBCHANGELOG\0"` segments to. */
  changelogTargetDb?: ReplicableDatabase;
  /** Optional target database for automatic snapshot bootstrap when `sendSnapshot()` arrives. */
  snapshotTargetDb?: ReplicableDatabase;
  /** Maximum SCTP frame size in bytes (including 24-byte header). @default 16384 */
  maxChunkBytes?: number;
  /** Pause sending chunks when `channel.bufferedAmount` exceeds this threshold (bytes). @default 262144 */
  maxBufferedAmount?: number;
  /** Stale incomplete transfer timeout in milliseconds. @default 60000 */
  assemblyTimeoutMs?: number;
  /** Callback invoked when a `"FBCHANGELOG\0"` segment is reassembled (and optionally applied). */
  onChangelogSegment?: (
    segment: Uint8Array,
    result?: ApplyFbChangelogResult,
  ) => void | Promise<void>;
  /** Callback invoked when a full `PublicationSnapshot` arrives over the DataChannel. */
  onSnapshot?: (snapshot: PublicationSnapshot) => void | Promise<void>;
  /** Error callback for background frame reassembly or apply failures. */
  onError?: (error: Error) => void;
}

/** Peer-to-peer WebRTC replication handle returned by {@link createWebRtcReplicationPeer} (`M19 Item 3`). */
export interface WebRtcReplicationPeer {
  /** Current connection lifecycle state. */
  readonly state: ConnectionLifecycleState;
  /** Total `'WRTC'` SCTP chunk frames transmitted. */
  readonly chunksSent: number;
  /** Total `'WRTC'` SCTP chunk frames received. */
  readonly chunksReceived: number;
  /** Push local journal entries strictly after `sinceLsn` (or last pushed LSN). */
  pushSince(sinceLsn?: number): Promise<number>;
  /** Request the remote peer to push changes strictly after `sinceLsn` (or local watermark). */
  requestPull(sinceLsn?: number): Promise<void>;
  /** Request a full snapshot bootstrap from the remote peer. */
  requestSnapshot(): Promise<void>;
  /** Stream a `PublicationSnapshot` (automatically chunked across 16 KB SCTP frames). */
  sendSnapshot(snapshot?: PublicationSnapshot): Promise<void>;
  /** Stream a native `"FBCHANGELOG\0"` binary segment (chunked + optional gzip). */
  sendChangelogSegment(
    segment: Uint8Array,
    options?: { compress?: boolean },
  ): Promise<void>;
  /** Close listeners and detach from the `RTCDataChannel`. */
  close(): void;
}

function toUint8ArraySync(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

/**
 * Create a peer-to-peer replication transport over WebRTC `RTCDataChannel` with
 * automatic 16 KB SCTP chunking, CRC-32 verification, and `bufferedAmount`
 * backpressure (`M19 Item 3`).
 */
export function createWebRtcReplicationPeer(
  options: WebRtcReplicationPeerOptions,
): WebRtcReplicationPeer {
  const { channel } = options;
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_WEBRTC_MAX_CHUNK_BYTES;
  const maxBufferedAmount = Math.max(
    maxChunkBytes,
    options.maxBufferedAmount ?? 256 * 1024,
  );
  const assembler = new WebRtcChunkAssembler({
    assemblyTimeoutMs: options.assemblyTimeoutMs,
  });
  const utf8Enc = new TextEncoder();
  const utf8Dec = new TextDecoder();

  if (channel.binaryType !== undefined) {
    channel.binaryType = 'arraybuffer';
  }
  if (channel.bufferedAmountLowThreshold !== undefined) {
    channel.bufferedAmountLowThreshold = Math.floor(maxBufferedAmount / 2);
  }

  let nextTransferId = 1;
  let lastPushedLsn = 0;
  let chunksSent = 0;
  let chunksReceived = 0;
  let closed = false;
  let currentState: ConnectionLifecycleState =
    channel.readyState === 'connecting' ? 'connecting' : 'online';

  const waitForBufferDrain = async (): Promise<void> => {
    if (
      typeof channel.bufferedAmount !== 'number' ||
      channel.bufferedAmount <= maxBufferedAmount
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        if (typeof channel.removeEventListener === 'function') {
          channel.removeEventListener('bufferedamountlow', done);
        } else if (channel.onbufferedamountlow === done) {
          channel.onbufferedamountlow = null;
        }
        resolve();
      };
      const fallbackTimer = setTimeout(done, 15);
      if (typeof channel.addEventListener === 'function') {
        channel.addEventListener('bufferedamountlow', done);
      } else if (!channel.onbufferedamountlow) {
        channel.onbufferedamountlow = done;
      }
    });
  };

  const sendChunkedPayload = async (
    payload: Uint8Array,
    payloadKind: number,
  ): Promise<void> => {
    if (closed) {
      throw new Error('WebRTC replication peer is closed.');
    }
    const transferId = nextTransferId++;
    const frames = chunkWebRtcPayload(payload, {
      transferId,
      payloadKind,
      maxChunkBytes,
    });
    for (const frame of frames) {
      await waitForBufferDrain();
      channel.send(frame);
      chunksSent++;
    }
  };

  const sendJsonControl = async (obj: unknown): Promise<void> => {
    const bytes = utf8Enc.encode(JSON.stringify(obj));
    await sendChunkedPayload(bytes, WebRtcPayloadKind.JsonControl);
  };

  const handleAssembled = async (assembled: AssembledWebRtcPayload): Promise<void> => {
    if (
      assembled.payloadKind === WebRtcPayloadKind.ChangelogRaw ||
      assembled.payloadKind === WebRtcPayloadKind.ChangelogGzip
    ) {
      const segBytes =
        assembled.payloadKind === WebRtcPayloadKind.ChangelogGzip ||
        isGzipBytes(assembled.payload)
          ? await gunzipBytes(assembled.payload)
          : assembled.payload;
      let applyRes: ApplyFbChangelogResult | undefined;
      if (options.changelogTargetDb) {
        applyRes = await applyFbChangelogSegmentToDatabase(
          options.changelogTargetDb,
          segBytes,
        );
      }
      if (options.onChangelogSegment) {
        await options.onChangelogSegment(segBytes, applyRes);
      }
      return;
    }

    if (assembled.payloadKind === WebRtcPayloadKind.SnapshotJson) {
      const snapshot = JSON.parse(
        utf8Dec.decode(assembled.payload),
      ) as PublicationSnapshot;
      if (options.snapshotTargetDb && options.subscription) {
        await bootstrapReplica({
          targetDb: options.snapshotTargetDb,
          publication: {
            exportSnapshot: async () => snapshot,
          },
          subscription: options.subscription,
          snapshot,
        });
      }
      if (options.onSnapshot) {
        await options.onSnapshot(snapshot);
      }
      return;
    }

    const msg = JSON.parse(utf8Dec.decode(assembled.payload)) as {
      type?: string;
      sinceLsn?: number;
      confirmedLsn?: number;
      slotName?: string;
      nodeId?: string;
      entries?: ReplicationLogEntry[];
    };

    if (msg.type === 'pull' && options.publication) {
      await options.publication.captureTableChanges();
      const entries = await options.publication.fetchChangesSince(
        msg.sinceLsn ?? 0,
        { excludeOrigin: msg.nodeId },
      );
      await sendJsonControl({ type: 'changes', entries });
    } else if (
      msg.type === 'changes' &&
      Array.isArray(msg.entries) &&
      options.subscription
    ) {
      if (msg.entries.length > 0) {
        const res = await options.subscription.applyChanges(msg.entries);
        await sendJsonControl({
          type: 'ack',
          slotName: options.subscription.slotName,
          confirmedLsn: res.currentLsn,
          nodeId: options.subscription.nodeId,
        });
      }
    } else if (
      msg.type === 'ack' &&
      options.publication &&
      msg.slotName &&
      typeof msg.confirmedLsn === 'number'
    ) {
      await options.publication.advanceSlot(msg.slotName, msg.confirmedLsn, {
        nodeId: msg.nodeId,
      });
    } else if (msg.type === 'request_snapshot' && options.publication) {
      const snap = await options.publication.exportSnapshot({ mode: 'logical' });
      const snapBytes = utf8Enc.encode(JSON.stringify(snap));
      await sendChunkedPayload(snapBytes, WebRtcPayloadKind.SnapshotJson);
    }
  };

  const onMessage = (event: { data?: unknown }): void => {
    void (async () => {
      try {
        let bin = toUint8ArraySync(event.data);
        if (
          !bin &&
          typeof Blob !== 'undefined' &&
          event.data instanceof Blob
        ) {
          bin = new Uint8Array(await event.data.arrayBuffer());
        }
        if (bin) {
          chunksReceived++;
          const assembled = assembler.pushChunk(bin);
          if (assembled) {
            await handleAssembled(assembled);
          }
        } else if (typeof event.data === 'string') {
          const fakePayload = utf8Enc.encode(event.data);
          await handleAssembled({
            transferId: 0,
            payloadKind: WebRtcPayloadKind.JsonControl,
            totalChunks: 1,
            crc32: computeCrc32(fakePayload),
            payload: fakePayload,
          });
        }
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  };

  const onOpen = () => {
    if (!closed) currentState = 'online';
  };
  const onClose = () => {
    currentState = 'offline';
  };

  if (typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', onMessage);
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
  } else {
    channel.onmessage = onMessage as (event: { data: unknown }) => void;
    channel.onopen = onOpen;
    channel.onclose = onClose;
  }

  return {
    get state() {
      return currentState;
    },
    get chunksSent() {
      return chunksSent;
    },
    get chunksReceived() {
      return chunksReceived;
    },

    async pushSince(sinceLsn) {
      if (!options.publication) return 0;
      await options.publication.captureTableChanges();
      const base = sinceLsn ?? lastPushedLsn;
      const entries = await options.publication.fetchChangesSince(base, {
        excludeOrigin: options.subscription?.nodeId,
      });
      if (entries.length > 0) {
        lastPushedLsn = entries[entries.length - 1]!.lsn;
        await sendJsonControl({ type: 'changes', entries });
      }
      return entries.length;
    },

    async requestPull(sinceLsn) {
      const base =
        sinceLsn ??
        (options.subscription ? await options.subscription.getWatermark() : 0);
      await sendJsonControl({
        type: 'pull',
        sinceLsn: base,
        nodeId: options.subscription?.nodeId,
      });
    },

    async requestSnapshot() {
      await sendJsonControl({ type: 'request_snapshot' });
    },

    async sendSnapshot(explicitSnapshot) {
      const snap =
        explicitSnapshot ??
        (options.publication
          ? await options.publication.exportSnapshot({ mode: 'logical' })
          : undefined);
      if (!snap) {
        throw new Error(
          'sendSnapshot requires either an explicit snapshot or a local publication.',
        );
      }
      const bytes = utf8Enc.encode(JSON.stringify(snap));
      await sendChunkedPayload(bytes, WebRtcPayloadKind.SnapshotJson);
    },

    async sendChangelogSegment(segment, sendOpts = {}) {
      if (sendOpts.compress) {
        const compressed = await gzipBytes(segment);
        await sendChunkedPayload(compressed, WebRtcPayloadKind.ChangelogGzip);
      } else {
        await sendChunkedPayload(segment, WebRtcPayloadKind.ChangelogRaw);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      currentState = 'offline';
      assembler.clear();
      if (typeof channel.removeEventListener === 'function') {
        channel.removeEventListener('message', onMessage);
        channel.removeEventListener('open', onOpen);
        channel.removeEventListener('close', onClose);
      } else {
        if (channel.onmessage === onMessage) channel.onmessage = null;
        if (channel.onopen === onOpen) channel.onopen = null;
        if (channel.onclose === onClose) channel.onclose = null;
      }
      channel.close?.();
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Auto-Reconnecting WebSocket Transport (`createResilientWebSocketPeer`)
// ---------------------------------------------------------------------------

/** Extended `WebSocketLike` supporting lifecycle close/open/error listeners (`M19 Item 3`). */
export interface ReconnectableWebSocketLike
  extends Omit<WebSocketLike, 'addEventListener' | 'removeEventListener'> {
  readyState?: number;
  addEventListener?: {
    (type: 'message', listener: (event: { data: unknown }) => void): void;
    (type: string, listener: (event?: unknown) => void): void;
  };
  removeEventListener?: {
    (type: 'message', listener: (event: { data: unknown }) => void): void;
    (type: string, listener: (event?: unknown) => void): void;
  };
  onopen?: (() => void) | null;
  onclose?: ((event?: unknown) => void) | null;
  onerror?: ((event?: unknown) => void) | null;
}

/** Options for {@link createResilientWebSocketPeer} (`M19 Item 3`). */
export interface ResilientWebSocketPeerOptions {
  /** Factory invoked on initial connect and every reconnect attempt. */
  createSocket?: () => ReconnectableWebSocketLike | Promise<ReconnectableWebSocketLike>;
  /** Optional `ws://` or `wss://` URL when `createSocket` is omitted (uses `globalThis.WebSocket`). */
  url?: string;
  /** Local publication to stream changes from. */
  publication?: ReplicationPublication;
  /** Local subscription to apply incoming changes to. */
  subscription?: ReplicationSubscription;
  /** Optional replica database to apply incoming `"FBCHANGELOG\0"` binary frames to. */
  changelogTargetDb?: ReplicableDatabase;
  /** Exponential backoff + jitter settings for automatic reconnection. */
  backoff?: BackoffRetryOptions;
  /** Automatically trigger `requestPull()` and `pushSince()` whenever a connection comes `'online'`. @default true */
  autoCatchUpOnReconnect?: boolean;
  /** Connection lifecycle state change callback (`'connecting' | 'online' | 'backoff' | 'offline'`). */
  onStateChange?: (
    state: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ) => void;
  /** Callback invoked when a binary `"FBCHANGELOG\0"` segment frame arrives. */
  onChangelogSegment?: (
    segment: Uint8Array,
    result?: ApplyFbChangelogResult,
  ) => void | Promise<void>;
}

/** Auto-reconnecting WebSocket replication peer returned by {@link createResilientWebSocketPeer} (`M19 Item 3`). */
export interface ResilientWebSocketPeer extends WebSocketReplicationPeer {
  /** Current connection lifecycle state. */
  readonly state: ConnectionLifecycleState;
  /** Consecutive reconnect attempts since last `'online'` state (`0` when `'online'`). */
  readonly reconnectAttempts: number;
  /** Total successful reconnections since creation. */
  readonly totalReconnects: number;
  /** Force an immediate reconnection cycle. */
  reconnectNow(): Promise<void>;
}

/**
 * Create an auto-reconnecting WebSocket replication peer with exponential
 * backoff + jitter, connection lifecycle events, outbound changelog buffering
 * while offline, and automatic watermark catch-up upon reconnect (`M19 Item 3`).
 */
export function createResilientWebSocketPeer(
  options: ResilientWebSocketPeerOptions,
): ResilientWebSocketPeer {
  const backoffOpts: BackoffRetryOptions = {
    maxRetries: Infinity,
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    factor: 2,
    jitterRatio: 0.2,
    ...options.backoff,
  };
  const maxRetries = backoffOpts.maxRetries ?? Infinity;
  const autoCatchUp = options.autoCatchUpOnReconnect ?? true;

  let state: ConnectionLifecycleState = 'offline';
  let attempt = 0;
  let totalReconnects = 0;
  let hasConnectedOnce = false;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSocket: ReconnectableWebSocketLike | null = null;
  let activePeer: WebSocketReplicationPeer | null = null;
  let detachSocketLifecycle: (() => void) | null = null;
  let lastKnownPushedLsn = 0;
  const pendingChangelogs: Array<{
    segment: Uint8Array;
    compress?: boolean;
  }> = [];

  const setState = (
    next: ConnectionLifecycleState,
    info?: ConnectionStateChangeInfo,
  ): void => {
    if (state === next && !info) return;
    state = next;
    options.onStateChange?.(next, info);
  };

  const makeSocket = async (): Promise<ReconnectableWebSocketLike> => {
    if (options.createSocket) {
      return await options.createSocket();
    }
    if (options.url && typeof globalThis.WebSocket === 'function') {
      return new globalThis.WebSocket(options.url) as unknown as ReconnectableWebSocketLike;
    }
    throw new Error(
      'createResilientWebSocketPeer requires either createSocket() or url with globalThis.WebSocket.',
    );
  };

  const cleanupCurrentSocket = (): void => {
    if (detachSocketLifecycle) {
      detachSocketLifecycle();
      detachSocketLifecycle = null;
    }
    if (activePeer) {
      activePeer.close();
      activePeer = null;
    }
    activeSocket = null;
  };

  const scheduleReconnect = (cause?: Error): void => {
    if (stopped) return;
    if (reconnectTimer !== null) return;
    if (attempt >= maxRetries) {
      setState('offline', { attempt, error: cause });
      return;
    }
    const delayMs = computeBackoffDelayMs(attempt, backoffOpts);
    const currentAttempt = ++attempt;
    setState('backoff', { attempt: currentAttempt, delayMs, error: cause });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        void connectInternal();
      }
    }, delayMs);
  };

  const onSocketReady = async (): Promise<void> => {
    if (stopped || !activePeer) return;
    const isReconnect = hasConnectedOnce;
    hasConnectedOnce = true;
    if (isReconnect) {
      totalReconnects++;
    }
    attempt = 0;
    setState('online');

    // Flush any changelog segments queued while offline/reconnecting
    while (pendingChangelogs.length > 0 && activePeer && state === 'online') {
      const item = pendingChangelogs.shift()!;
      await activePeer.sendChangelogSegment(item.segment, {
        compress: item.compress,
      });
    }

    if (autoCatchUp && activePeer && state === 'online') {
      if (options.subscription) {
        await activePeer.requestPull();
      }
      if (options.publication) {
        const pushed = await activePeer.pushSince(lastKnownPushedLsn);
        if (pushed > 0) {
          lastKnownPushedLsn = await options.publication.currentLsn();
        }
      }
    }
  };

  const connectInternal = async (): Promise<void> => {
    if (stopped) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupCurrentSocket();
    setState('connecting', attempt > 0 ? { attempt } : undefined);

    let sock: ReconnectableWebSocketLike;
    try {
      sock = await makeSocket();
    } catch (err) {
      scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (stopped) {
      sock.close?.();
      return;
    }

    activeSocket = sock;
    activePeer = createWebSocketReplicationPeer({
      socket: sock,
      publication: options.publication,
      subscription: options.subscription,
      changelogTargetDb: options.changelogTargetDb,
      onChangelogSegment: options.onChangelogSegment,
    });

    const handleOpen = () => {
      if (activeSocket !== sock || stopped) return;
      void onSocketReady().catch(() => undefined);
    };
    const handleClose = () => {
      if (activeSocket !== sock || stopped) return;
      cleanupCurrentSocket();
      scheduleReconnect(new Error('WebSocket connection closed'));
    };
    const handleError = (ev?: unknown) => {
      if (activeSocket !== sock || stopped) return;
      const err =
        ev instanceof Error ? ev : new Error('WebSocket transport error');
      cleanupCurrentSocket();
      scheduleReconnect(err);
    };

    if (typeof sock.addEventListener === 'function') {
      sock.addEventListener('open', handleOpen);
      sock.addEventListener('close', handleClose);
      sock.addEventListener('error', handleError);
      detachSocketLifecycle = () => {
        sock.removeEventListener?.('open', handleOpen);
        sock.removeEventListener?.('close', handleClose);
        sock.removeEventListener?.('error', handleError);
      };
    } else {
      sock.onopen = handleOpen;
      sock.onclose = handleClose;
      sock.onerror = handleError;
      detachSocketLifecycle = () => {
        if (sock.onopen === handleOpen) sock.onopen = null;
        if (sock.onclose === handleClose) sock.onclose = null;
        if (sock.onerror === handleError) sock.onerror = null;
      };
    }

    // Standard WebSocket OPEN === 1; custom test doubles without readyState are immediately open
    if (sock.readyState === undefined || sock.readyState === 1) {
      await onSocketReady().catch(() => undefined);
    } else if (sock.readyState === 2 || sock.readyState === 3) {
      handleClose();
    }
  };

  void connectInternal();

  return {
    get state() {
      return state;
    },
    get reconnectAttempts() {
      return attempt;
    },
    get totalReconnects() {
      return totalReconnects;
    },

    async reconnectNow() {
      if (stopped) return;
      await connectInternal();
    },

    async pushSince(sinceLsn) {
      if (sinceLsn !== undefined) {
        lastKnownPushedLsn = sinceLsn;
      }
      if (!activePeer || state !== 'online') {
        return 0;
      }
      const count = await activePeer.pushSince(sinceLsn ?? lastKnownPushedLsn);
      if (count > 0 && options.publication) {
        lastKnownPushedLsn = await options.publication.currentLsn();
      }
      return count;
    },

    async requestPull(sinceLsn) {
      if (!activePeer || state !== 'online') {
        return;
      }
      await activePeer.requestPull(sinceLsn);
    },

    async sendChangelogSegment(segment, sendOpts = {}) {
      if (!activePeer || state !== 'online') {
        pendingChangelogs.push({
          segment: segment.slice(),
          compress: sendOpts.compress,
        });
        return;
      }
      await activePeer.sendChangelogSegment(segment, sendOpts);
    },

    close() {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupCurrentSocket();
      pendingChangelogs.length = 0;
      setState('offline');
    },
  };
}
