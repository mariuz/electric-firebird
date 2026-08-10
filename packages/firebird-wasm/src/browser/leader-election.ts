/**
 * leader-election.ts – exactly one tab owns the engine; the rest wait.
 *
 * Built on the same Web Lock that {@link acquireDatabaseLock} already uses for
 * multi-tab *safety*, because election is the same problem viewed from the
 * other side.  Refusing the second tab and serving it from the first differ
 * only in what the loser does after losing.
 *
 * Every participant requests the lock and never gives it back voluntarily.
 * Whoever holds it is the leader; everyone else is queued behind it. When the
 * leader's context dies — closed, crashed, killed while backgrounded — the
 * browser releases the lock and the next waiter is granted it and promoted.
 * There is no heartbeat, no lease to expire, and no way to observe two leaders
 * at once, because the browser will not grant an exclusive lock twice.
 */

import { acquireDatabaseLock } from './db-lock';
import type { DatabaseLock } from './db-lock';

/** A participant in the election for one database. */
export interface LeaderElection {
  /** Whether this context currently holds the lock. */
  readonly isLeader: boolean;
  /**
   * Resolves the moment this context becomes leader.
   *
   * Already-resolved if it is the leader; otherwise pending until the current
   * leader goes away.  Never rejects on losing — losing is the normal case.
   */
  readonly promoted: Promise<void>;
  /**
   * Whether exclusion is actually enforced.
   *
   * `false` where the Web Locks API is missing, in which case every
   * participant believes it is the leader.  See {@link acquireDatabaseLock}.
   */
  readonly enforced: boolean;
  /** Stop participating, releasing the lock if this context holds it. */
  resign(): Promise<void>;
}

/** Options for {@link electLeader}. */
export interface LeaderElectionOptions {
  /**
   * Called once when this context is promoted.
   *
   * Runs before {@link LeaderElection.promoted} resolves, so a leader can
   * finish standing up its engine before anyone is told it exists.
   */
  onPromoted?: () => void | Promise<void>;
}

/**
 * Join the election for `dbName`.
 *
 * Returns as soon as participation has *started*, not when it is won — a
 * follower must be usable immediately, and the first thing it does is proxy
 * to whoever is already leading.
 */
export function electLeader(
  dbName: string,
  options: LeaderElectionOptions = {},
): LeaderElection {
  let leader = false;
  let enforced = true;
  let lock: DatabaseLock | null = null;
  let resigned = false;

  const promoted = (async () => {
    // Infinity, deliberately: a follower is not waiting on a timeout, it is
    // waiting for the leader to go away, which may be never.
    const held = await acquireDatabaseLock(dbName, { timeoutMs: Infinity });

    if (resigned) {
      // resign() ran while this was queued.  Release immediately rather than
      // silently becoming a leader nobody is going to use.
      await held.release();
      return;
    }

    lock = held;
    enforced = held.enforced;
    leader = true;

    await options.onPromoted?.();
  })();

  return {
    get isLeader() {
      return leader;
    },
    get enforced() {
      return enforced;
    },
    promoted,
    resign: async () => {
      resigned = true;
      const held = lock;
      lock = null;
      leader = false;
      await held?.release();
    },
  };
}
