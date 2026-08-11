/**
 * shared-transport.ts – one engine, many tabs.
 *
 * `multiTab: 'exclusive'` keeps a second tab safe by refusing it. This serves
 * it instead: one tab wins the election, runs the engine, and answers for
 * everyone else over a `BroadcastChannel`.
 *
 * ## Why only one tab may run the engine
 *
 * Not because concurrent access needs coordinating — because each tab holds
 * its own complete copy of the database in memory and persists the whole
 * image. Two engines on one database is not a race to be locked around; the
 * later persist discards the other's work entirely. So the engine is
 * singular by construction, and the other tabs are clients of it.
 *
 * ## What happens when the leader disappears
 *
 * The lock releases, a follower is promoted, and it starts its own engine from
 * the last persisted image. Writes made in the departed leader's final
 * debounce window are lost — the same exposure a single tab has always had,
 * and no worse.
 *
 * In-flight calls at that moment are handled by what they are, not uniformly:
 * a read is re-issued to the new leader, because running a query twice is
 * indistinguishable from running it once; a write is **rejected**. The old
 * leader may have committed it and died before the reply, so re-issuing could
 * apply it twice. An error a caller can see beats a duplicate row it cannot.
 */

import type {
  Row,
  QueryResult,
  QueryDescription,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';
import type { EngineHandle, EngineTransport } from './engine-transport';
import { electLeader } from './leader-election';
import type { LeaderElection } from './leader-election';

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Operations a follower may ask the leader to perform. */
type SharedOp = keyof Omit<EngineTransport, 'dispose'>;

interface CallMessage {
  kind: 'call';
  /** Sender, so replies can be addressed on a channel everyone hears. */
  from: string;
  id: number;
  op: SharedOp;
  args: unknown[];
}

interface ReplyMessage {
  kind: 'reply';
  to: string;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Announced on promotion, so waiting followers stop waiting. */
interface LeaderMessage {
  kind: 'leader';
  /**
   * Increments with each leadership change, so a follower can tell a new
   * leader from a re-announcement by the one it is already talking to.
   */
  epoch: number;
}

/** Sent by a follower that has not heard from a leader yet. */
interface QueryLeaderMessage {
  kind: 'who-leads';
}

type SharedMessage = CallMessage | ReplyMessage | LeaderMessage | QueryLeaderMessage;

/**
 * Operations safe to re-issue to a new leader after the old one vanished.
 *
 * Reads and existence checks only. Every mutation is absent deliberately: its
 * outcome is unknown once the leader dies mid-call, and "unknown" must not be
 * quietly resolved as "did not happen".
 */
const REPLAYABLE: ReadonlySet<SharedOp> = new Set<SharedOp>([
  'init',
  'query',
  // Prepares a statement and drops it, executing nothing, so re-issuing it is
  // indistinguishable from issuing it once.
  'describe',
  'exists',
  'readFile',
]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link SharedEngineTransport}. */
export interface SharedEngineTransportOptions {
  /** Logical database name; scopes both the lock and the channel. */
  dbName: string;
  /**
   * Builds the engine.  Called **only** if this tab becomes leader, so a
   * follower never loads the 9 MB artifact it would not use.
   */
  createEngine: () => EngineTransport;
  /**
   * How long a follower waits for the leader to answer, in milliseconds.
   *
   * Generous by default because creating a database is slow and the follower
   * cannot tell a slow leader from a dead one.
   *
   * @default 120000
   */
  timeoutMs?: number;
  /**
   * Called on the leader when it serves an operation that changed data.
   *
   * Persistence lives with whoever owns the engine, and a follower's writes
   * are executed by the leader — so without this the leader would never learn
   * that anything needs saving.
   */
  onServedMutation?: () => void;
  /**
   * Called when the engine behind this transport has been replaced.
   *
   * Handles are issued by whichever engine is running, so a leadership change
   * voids every one of them — in every tab, not just the promoted one. The
   * owner must re-open the database before using it again, and it must happen
   * on the leader before any follower is told there is a leader to talk to.
   */
  onEngineReplaced?: () => Promise<void>;
}

/** Ops that change the database, and so make the leader's image dirty. */
const MUTATING: ReadonlySet<SharedOp> = new Set<SharedOp>([
  'execute',
  'commit',
  'createDatabase',
  'writeFile',
]);

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Pending {
  op: SharedOp;
  args: unknown[];
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * An {@link EngineTransport} backed by whichever tab currently owns the engine.
 *
 * @example
 * ```ts
 * const db = new FirebirdBrowser('mydb', {
 *   multiTab: 'shared',
 *   worker: () => new Worker('/firebird-engine-worker.js'),
 * });
 * ```
 */
export class SharedEngineTransport implements EngineTransport {
  private readonly dbName: string;
  private readonly createEngine: () => EngineTransport;
  private readonly timeoutMs: number;
  private readonly onServedMutation?: () => void;
  private readonly onEngineReplaced?: () => Promise<void>;

  private readonly channel: BroadcastChannel;
  private readonly clientId: string;
  private readonly election: LeaderElection;

  /** The real engine.  Non-null exactly when this tab is the leader. */
  private engine: EngineTransport | null = null;

  private readonly pending = new Map<number, Pending>();
  private nextCallId = 1;
  private disposed = false;

  /** Highest leadership generation seen; guards against stale announcements. */
  private epoch = 0;
  /** True while this tab is standing its engine up, so calls stay local. */
  private promoting = false;
  /** Resolves once a leader is known to exist, so calls do not go nowhere. */
  private leaderKnown: Promise<void>;
  private announceLeaderKnown!: () => void;

  constructor(options: SharedEngineTransportOptions) {
    this.dbName = options.dbName;
    this.createEngine = options.createEngine;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onServedMutation = options.onServedMutation;
    this.onEngineReplaced = options.onEngineReplaced;

    this.clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.channel = new BroadcastChannel(`firebird-wasm:shared:${this.dbName}`);
    this.channel.addEventListener('message', this.onMessage);

    this.leaderKnown = new Promise<void>((resolve) => {
      this.announceLeaderKnown = resolve;
    });

    this.election = electLeader(this.dbName, {
      onPromoted: () => this.assumeLeadership(),
    });

    // A follower that starts while a leader already exists hears nothing until
    // it asks; the leader's announcement happened before this tab existed.
    this.channel.postMessage({ kind: 'who-leads' } satisfies SharedMessage);
  }

  /** Whether this tab currently runs the engine. */
  get isLeader(): boolean {
    return this.election.isLeader;
  }

  // ── Leadership ─────────────────────────────────────────────────────────

  private async assumeLeadership(): Promise<void> {
    if (this.disposed) return;

    this.engine = this.createEngine();
    await this.engine.init();

    // Re-open before announcing.  A follower that heard "leader" and attached
    // straight away would be attaching to an engine with no database in it.
    this.promoting = true;
    try {
      await this.onEngineReplaced?.();
    } finally {
      this.promoting = false;
    }

    this.announceLeaderKnown();
    this.channel.postMessage({ kind: 'leader', epoch: ++this.epoch } satisfies SharedMessage);

    // Anything still outstanding was addressed to a leader that no longer
    // exists.  Replay what is safe to replay; fail the rest loudly.
    this.recoverPending();
  }

  private recoverPending(): void {
    const outstanding = [...this.pending.entries()];
    this.pending.clear();

    for (const [, call] of outstanding) {
      clearTimeout(call.timer);

      if (REPLAYABLE.has(call.op)) {
        this.runLocally(call.op, call.args).then(
          (value) => call.resolve(value as never),
          (err: unknown) => call.reject(err instanceof Error ? err : new Error(String(err))),
        );
        continue;
      }

      call.reject(
        new Error(
          `The tab running the database closed while "${call.op}" was in ` +
            `flight, and this tab has taken over. The operation may or may ` +
            `not have been applied, so it was not retried — re-check the ` +
            `data before repeating it.`,
        ),
      );
    }
  }

  /** Follower side: the leader changed, so re-open against the new one. */
  private async reopenAfterLeaderChange(): Promise<void> {
    if (this.disposed || this.engine) return;
    try {
      await this.onEngineReplaced?.();
    } catch {
      // Reported through the owner's own error handling; a throw here would
      // become an unhandled rejection in a channel event listener.
    }
  }

  // ── Channel ────────────────────────────────────────────────────────────

  private readonly onMessage = (event: MessageEvent<SharedMessage>): void => {
    const message = event.data;

    switch (message.kind) {
      case 'who-leads':
        // Only a leader answers, and only if it has an engine standing.
        if (this.engine) {
          this.channel.postMessage({
            kind: 'leader',
            epoch: this.epoch,
          } satisfies SharedMessage);
        }
        return;

      case 'leader':
        this.announceLeaderKnown();
        // A *new* leader, not the one this tab already knew about: its engine
        // is a different engine, so this tab's handles mean nothing to it.
        if (message.epoch > this.epoch) {
          this.epoch = message.epoch;
          if (!this.engine) void this.reopenAfterLeaderChange();
        }
        return;

      case 'call':
        if (this.engine) void this.serve(message);
        return;

      case 'reply':
        if (message.to === this.clientId) this.settle(message);
        return;
    }
  };

  /** Leader side: run the operation and reply to the caller. */
  private async serve(message: CallMessage): Promise<void> {
    let reply: ReplyMessage;

    try {
      const result = await this.runLocally(message.op, message.args);
      reply = {
        kind: 'reply',
        to: message.from,
        id: message.id,
        ok: true,
        result: result ?? null,
      };

      if (MUTATING.has(message.op)) {
        // The write happened here, but the caller that wanted it is in
        // another tab and will never mark this engine dirty.
        this.onServedMutation?.();
      }
    } catch (err) {
      reply = {
        kind: 'reply',
        to: message.from,
        id: message.id,
        ok: false,
        // A string, not an Error: structured cloning drops the prototype and
        // the stack belongs to a tab the caller cannot see anyway.
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.channel.postMessage(reply);
  }

  private settle(message: ReplyMessage): void {
    const call = this.pending.get(message.id);
    if (!call) return; // already timed out, or replayed after a promotion

    this.pending.delete(message.id);
    clearTimeout(call.timer);

    if (message.ok) {
      call.resolve(message.result as never);
    } else {
      call.reject(new Error(message.error ?? 'the database tab reported an error'));
    }
  }

  private runLocally(op: SharedOp, args: unknown[]): Promise<unknown> {
    const engine = this.engine;
    if (!engine) {
      return Promise.reject(new Error('not the leader'));
    }

    const fn = (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`unknown engine operation: ${op}`));
    }
    return fn.apply(engine, args);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  /** Run `op` here if this tab leads, otherwise ask whoever does. */
  private async call<T>(op: SharedOp, ...args: unknown[]): Promise<T> {
    if (this.disposed) {
      throw new Error('SharedEngineTransport has been disposed');
    }

    if (this.engine) {
      return (await this.runLocally(op, args)) as T;
    }

    // Do not shout into an empty channel: on a cold start every tab is a
    // follower for the moment it takes the winner to stand its engine up.
    await this.leaderKnown;

    // Promotion can happen while waiting, in which case this is now local.
    if (this.engine) {
      return (await this.runLocally(op, args)) as T;
    }

    const id = this.nextCallId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `the tab running database "${this.dbName}" did not answer ` +
              `"${op}" within ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        op,
        args,
        resolve: resolve as (value: never) => void,
        reject,
        timer,
      });

      this.channel.postMessage({
        kind: 'call',
        from: this.clientId,
        id,
        op,
        args,
      } satisfies SharedMessage);
    });
  }

  // ── EngineTransport ────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Whoever wins the election calls the engine's own init(); a follower has
    // nothing to initialise and must not wait for an engine it will not build.
    await Promise.race([this.election.promoted, this.leaderKnown]);
  }

  createDatabase(path: string): Promise<EngineHandle> {
    return this.call<EngineHandle>('createDatabase', path);
  }

  attachDatabase(path: string): Promise<EngineHandle> {
    return this.call<EngineHandle>('attachDatabase', path);
  }

  detachDatabase(dbHandle: EngineHandle): Promise<void> {
    // Followers share the leader's attachment; detaching it because one tab
    // closed would pull the database out from under every other tab.
    if (!this.engine) return Promise.resolve();
    return this.call<void>('detachDatabase', dbHandle);
  }

  execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
  ): Promise<number> {
    return this.call<number>('execute', dbHandle, txHandle, sql, params);
  }

  query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
    rowMode: RowMode = 'object',
  ): Promise<QueryResult<T>> {
    // Decoding happens on the far side, so the mode has to travel with the
    // call rather than being applied to what comes back. It is a string, so
    // it survives structured cloning like the rest of the arguments.
    return this.call<QueryResult<T>>('query', dbHandle, txHandle, sql, params, rowMode);
  }

  describe(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription> {
    return this.call<QueryDescription>('describe', dbHandle, txHandle, sql);
  }

  startTransaction(
    dbHandle: EngineHandle,
    options: TransactionOptions = {},
  ): Promise<EngineHandle> {
    return this.call<EngineHandle>('startTransaction', dbHandle, options);
  }

  commit(txHandle: EngineHandle): Promise<void> {
    return this.call<void>('commit', txHandle);
  }

  rollback(txHandle: EngineHandle): Promise<void> {
    return this.call<void>('rollback', txHandle);
  }

  mkdir(path: string): Promise<void> {
    return this.call<void>('mkdir', path);
  }

  exists(path: string): Promise<boolean> {
    return this.call<boolean>('exists', path);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.call<Uint8Array>('readFile', path);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.call<void>('writeFile', path, data);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error('SharedEngineTransport has been disposed'));
    }
    this.pending.clear();

    this.channel.removeEventListener('message', this.onMessage);
    this.channel.close();

    const engine = this.engine;
    this.engine = null;

    // Resign last: releasing the lock promotes another tab, which will build
    // its own engine, and this one should be gone before that happens.
    await engine?.dispose();
    await this.election.resign();
  }
}
