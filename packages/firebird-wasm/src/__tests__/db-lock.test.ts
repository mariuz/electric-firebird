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

/**
 * Another tab taking the database: the Web Lock held directly, as a second
 * tab's acquireDatabaseLock would hold it.  Not acquireDatabaseLock here: in
 * this process that is the same page, which is refused before any Web Lock.
 */
async function holdInOtherTab(dbName: string): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let granted!: () => void;
  const isGranted = new Promise<void>((r) => {
    granted = r;
  });
  const done = manager.request(databaseLockName(dbName), { mode: 'exclusive' }, () => {
    granted();
    return held;
  });
  await isGranted;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

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

  it('waits for another tab to release, then takes the lock', async () => {
    installLocks();

    const first = await holdInOtherTab('mydb');

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

    const first = await holdInOtherTab('mydb');

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
    const first = await holdInOtherTab('reports');

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

    const first = await holdInOtherTab('mydb');
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

  it('refuses a name this page already holds at once, and says so', async () => {
    installLocks();
    const first = await acquireDatabaseLock('page');

    let error: unknown;
    const startedAt = Date.now();
    try {
      // A long timeout: the refusal must not wait for it.
      await acquireDatabaseLock('page', { timeoutMs: 10_000 });
    } catch (e) {
      error = e;
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(DatabaseLockedError);
    const locked = error as DatabaseLockedError;
    expect(locked.heldBy).toBe('this-page');
    expect(locked.waitedMs).toBe(0);
    expect(locked.message).toMatch(/already open in this page/);
    expect(locked.message).not.toMatch(/another tab/);

    // Released, the name can be opened again.
    await first.release();
    const again = await acquireDatabaseLock('page');
    await again.release();
  });

  it('refuses the second of two instances racing for one name', async () => {
    installLocks();
    const [a, b] = await Promise.allSettled([
      acquireDatabaseLock('race'),
      acquireDatabaseLock('race'),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ heldBy: 'this-page' });
    await (a as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
  });

  it('refuses a second open in this page where the Web Locks API is missing too', async () => {
    // In Node there is no other tab, but two instances in one process share
    // one engine filesystem: the same name is the same file.
    removeLocks();
    const quiet = { onUnavailable: () => {} };
    const first = await acquireDatabaseLock('node', quiet);
    await expect(acquireDatabaseLock('node', quiet)).rejects.toMatchObject({ heldBy: 'this-page' });
    await first.release();
    const again = await acquireDatabaseLock('node', quiet);
    await again.release();
  });

  it('frees the name when the lock is not granted', async () => {
    installLocks();
    const other = await holdInOtherTab('freed');
    await expect(acquireDatabaseLock('freed', { timeoutMs: 20 })).rejects.toMatchObject({ heldBy: 'other' });
    await other.release();
    // Not left recorded as held here by the failed attempt.
    const lock = await acquireDatabaseLock('freed', { timeoutMs: 50 });
    await lock.release();
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
