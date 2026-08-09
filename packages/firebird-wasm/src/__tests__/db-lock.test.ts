/**
 * db-lock.test.ts – cross-tab exclusion logic.
 *
 * Node has no Web Locks API, so these drive a fake one.  The fake is written
 * to the spec's queueing rules rather than to what the code under test
 * happens to call: requests for a held name queue in arrival order, the
 * callback holds the lock until its returned promise settles, and aborting a
 * *pending* request removes it while aborting after the grant does nothing.
 * A fake that merely echoed the implementation would pass no matter what.
 *
 * The real API is exercised against two live tabs in
 * `e2e/tests/browser-multitab.spec.ts`; this file covers the timing and
 * failure paths that are impractical to stage in a browser.
 */

import {
  acquireDatabaseLock,
  databaseLockName,
  DatabaseLockedError,
} from '../browser/db-lock';

// ---------------------------------------------------------------------------
// A minimal, spec-shaped LockManager
// ---------------------------------------------------------------------------

interface Waiter {
  callback: () => Promise<unknown>;
  granted: () => void;
  failed: (reason: unknown) => void;
  signal?: AbortSignal;
}

class FakeLockManager {
  /** Waiters per lock name; index 0 is the current holder once running. */
  private readonly queues = new Map<string, Waiter[]>();
  /** Names currently held, so a grant cannot overlap another. */
  private readonly held = new Set<string>();

  request = (
    name: string,
    options: { mode?: string; signal?: AbortSignal; ifAvailable?: boolean },
    callback: () => Promise<unknown>,
  ): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        callback,
        granted: resolve,
        failed: reject,
        signal: options.signal,
      };

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          // Only a request still waiting can be abandoned.
          const queue = this.queues.get(name) ?? [];
          const at = queue.indexOf(waiter);
          if (at > 0 || (at === 0 && !this.held.has(name))) {
            queue.splice(at, 1);
            reject(new DOMException('The request was aborted.', 'AbortError'));
          }
        });
      }

      const queue = this.queues.get(name) ?? [];
      queue.push(waiter);
      this.queues.set(name, queue);
      this.pump(name);
    });
  };

  /** Grant the head of the queue if the name is free. */
  private pump(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name) ?? [];
    const next = queue[0];
    if (!next) return;

    this.held.add(name);
    // The grant is asynchronous in the real API; keep that so tests cannot
    // accidentally depend on synchronous acquisition.
    void Promise.resolve().then(async () => {
      try {
        await next.callback();
        next.granted();
      } catch (err) {
        next.failed(err);
      } finally {
        this.held.delete(name);
        (this.queues.get(name) ?? []).shift();
        this.pump(name);
      }
    });
  }

  /** Whether anything currently holds `name`.  Test-only. */
  isHeld(name: string): boolean {
    return this.held.has(name);
  }
}

let manager: FakeLockManager;

function installLocks(): void {
  manager = new FakeLockManager();
  (globalThis as { navigator?: unknown }).navigator = { locks: manager };
}

function removeLocks(): void {
  delete (globalThis as { navigator?: unknown }).navigator;
}

afterEach(() => {
  removeLocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('acquireDatabaseLock', () => {
  it('namespaces the lock so it cannot collide with an application lock', () => {
    expect(databaseLockName('mydb')).toBe('firebird-wasm:db:mydb');
  });

  it('grants the lock and reports that exclusion is enforced', async () => {
    installLocks();

    const lock = await acquireDatabaseLock('mydb');

    expect(lock.enforced).toBe(true);
    expect(manager.isHeld(databaseLockName('mydb'))).toBe(true);

    await lock.release();
    expect(manager.isHeld(databaseLockName('mydb'))).toBe(false);
  });

  it('holds the lock until released, blocking a second acquirer', async () => {
    installLocks();

    const first = await acquireDatabaseLock('mydb');

    let secondGranted = false;
    const second = acquireDatabaseLock('mydb', { timeoutMs: Infinity }).then(
      (lock) => {
        secondGranted = true;
        return lock;
      },
    );

    // Give the queue every chance to grant it early — it must not.
    await new Promise((r) => setTimeout(r, 20));
    expect(secondGranted).toBe(false);

    await first.release();

    const lock = await second;
    expect(secondGranted).toBe(true);
    await lock.release();
  });

  it('fails with DatabaseLockedError when the holder does not release in time', async () => {
    installLocks();

    const first = await acquireDatabaseLock('mydb');

    // The error names the database and says what to do about it: a bare
    // "AbortError" from the lock API would tell an application nothing.
    await expect(acquireDatabaseLock('mydb', { timeoutMs: 30 })).rejects.toThrow(
      DatabaseLockedError,
    );
    await expect(
      acquireDatabaseLock('mydb', { timeoutMs: 30 }),
    ).rejects.toThrow(/already open in another tab/);

    await first.release();
  });

  it('reports how long it waited, and for which database', async () => {
    installLocks();
    const first = await acquireDatabaseLock('reports');

    let error: unknown;
    try {
      await acquireDatabaseLock('reports', { timeoutMs: 40 });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(DatabaseLockedError);
    const locked = error as DatabaseLockedError;
    expect(locked.dbName).toBe('reports');
    expect(locked.waitedMs).toBeGreaterThanOrEqual(30);

    await first.release();
  });

  it('leaves the lock available after a timed-out attempt', async () => {
    installLocks();

    const first = await acquireDatabaseLock('mydb');
    await expect(acquireDatabaseLock('mydb', { timeoutMs: 20 })).rejects.toThrow(
      DatabaseLockedError,
    );
    await first.release();

    // The abandoned waiter must not still be queued, or it would take the lock
    // the moment the holder released and never give it back.
    expect(manager.isHeld(databaseLockName('mydb'))).toBe(false);

    const third = await acquireDatabaseLock('mydb', { timeoutMs: 50 });
    expect(third.enforced).toBe(true);
    await third.release();
  });

  it('does not block a different database', async () => {
    installLocks();

    const a = await acquireDatabaseLock('alpha');
    const b = await acquireDatabaseLock('beta', { timeoutMs: 50 });

    expect(b.enforced).toBe(true);
    await a.release();
    await b.release();
  });

  it('tolerates release() being called twice', async () => {
    installLocks();

    const lock = await acquireDatabaseLock('mydb');
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('proceeds with a warning where the Web Locks API is missing', async () => {
    // Node, jsdom, and non-secure contexts.  Refusing to run there would break
    // environments that never had the hazard, so this degrades loudly.
    removeLocks();

    const warnings: string[] = [];
    const lock = await acquireDatabaseLock('mydb', {
      onUnavailable: (m) => warnings.push(m),
    });

    expect(lock.enforced).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Web Locks API is unavailable/);

    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('surfaces a genuine lock failure instead of calling it contention', async () => {
    installLocks();

    // A LockManager that rejects for its own reasons — not an abort.
    (globalThis as { navigator?: unknown }).navigator = {
      locks: {
        request: () => Promise.reject(new Error('SecurityError: storage denied')),
      },
    };

    await expect(acquireDatabaseLock('mydb')).rejects.toThrow(/storage denied/);
    await expect(acquireDatabaseLock('mydb')).rejects.not.toThrow(
      DatabaseLockedError,
    );
  });
});
