/**
 * db-lock.ts – cross-tab exclusion for a single logical database.
 *
 * ## The hazard
 *
 * Every tab runs its own engine with its own complete copy of the database in
 * Emscripten's in-memory filesystem, and `persist()` writes that **whole
 * image** to IndexedDB.  So two tabs on one database is not a
 * write-interleaving problem that finer-grained locking would fix — it is
 * last-writer-wins over the entire file:
 *
 *   tab A: open (image v1) ─── write x ─────────────── persist (v1+x)
 *   tab B: open (image v1) ─── write y ─── persist (v1+y)
 *
 * B's `y` is gone.  Not corrupted, not conflicted — silently absent, with both
 * tabs showing a successful commit.  `importDatabase()` being atomic does not
 * help: each write is individually perfect and still wrong.
 *
 * ## Why the Web Locks API
 *
 * The property that matters is release-on-death.  A lock built out of a flag
 * in IndexedDB has to answer "the holder set this 40 seconds ago and stopped —
 * crashed, or just busy?", and every answer is either a deadlock or a
 * corruption window.  Web Locks are held by the *agent*, so a closed tab, a
 * crashed renderer or a killed background process releases immediately and
 * exactly.  There is no stale state to recover and no heartbeat to tune.
 *
 * Queueing is also free: a second tab waits for the first rather than
 * spinning, and is granted the moment the first closes.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A held lock.  Release it to let a waiting tab proceed. */
export interface DatabaseLock {
  /**
   * Whether exclusion is actually being enforced.
   *
   * `false` means the Web Locks API was unavailable and the caller was let
   * through unprotected — see {@link acquireDatabaseLock}.
   */
  readonly enforced: boolean;
  /** Release the lock.  Safe to call more than once. */
  release(): Promise<void>;
}

/** Options for {@link acquireDatabaseLock}. */
export interface DatabaseLockOptions {
  /**
   * How long to wait for another tab to release the database, in
   * milliseconds.  Pass `Infinity` to wait indefinitely.
   *
   * The default is deliberately short.  A tab blocked on this is showing the
   * user nothing, so failing with an explanation beats waiting silently for a
   * tab the user may never return to.
   *
   * @default 5000
   */
  timeoutMs?: number;
  /**
   * Called when the Web Locks API is missing, just before proceeding without
   * protection.  Defaults to `console.warn`.
   */
  onUnavailable?: (message: string) => void;
}

/** Thrown when another tab holds the database and did not release in time. */
export class DatabaseLockedError extends Error {
  constructor(
    /** The logical database name that is held elsewhere. */
    readonly dbName: string,
    /** How long we waited, in milliseconds. */
    readonly waitedMs: number,
  ) {
    super(
      `Database "${dbName}" is already open in another tab or worker ` +
        `(waited ${waitedMs}ms).  Each tab keeps its own full copy of the ` +
        `database, so allowing both would silently discard one tab's writes.  ` +
        `Close the other tab, or pass multiTab: 'allow-unsafe' if you are ` +
        `certain only one of them writes.`,
    );
    this.name = 'DatabaseLockedError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;

/** Lock names are namespaced so they cannot collide with an app's own locks. */
export function databaseLockName(dbName: string): string {
  return `firebird-wasm:db:${dbName}`;
}

/** Whether this environment can enforce cross-tab exclusion at all. */
function locksAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
  );
}

/**
 * Take the exclusive lock for `dbName`, waiting up to `timeoutMs`.
 *
 * Call this *before* reading the stored image.  A tab that loads the database
 * and then waits for the lock resumes with a snapshot that the departing tab
 * has since replaced, which is the very overwrite the lock exists to prevent.
 *
 * Where the Web Locks API is missing — Node, jsdom, a non-secure context —
 * there is nothing to enforce exclusion with.  Rather than refuse to run, this
 * warns and returns a lock with `enforced: false`: the single-tab case that
 * covers Node and tests is safe on its own, and failing there would break
 * environments that never had the hazard.
 *
 * @throws {DatabaseLockedError} if another tab holds it past the timeout.
 */
export async function acquireDatabaseLock(
  dbName: string,
  options: DatabaseLockOptions = {},
): Promise<DatabaseLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!locksAvailable()) {
    const warn = options.onUnavailable ?? ((m: string) => console.warn(m));
    warn(
      '[firebird-wasm] the Web Locks API is unavailable, so concurrent tabs ' +
        'cannot be detected.  Opening the same database in two places will ' +
        'silently lose writes.',
    );
    return { enforced: false, release: async () => {} };
  }

  const name = databaseLockName(dbName);
  const startedAt = nowMs();

  // Two promises, because "granted" and "released" are different moments and
  // the caller needs both.  The lock is held for exactly as long as the
  // callback's returned promise is pending, so `release` is what settles it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  let onGranted!: () => void;
  let onFailed!: (reason: unknown) => void;
  const granted = new Promise<void>((resolve, reject) => {
    onGranted = resolve;
    onFailed = reject;
  });

  // Aborting the signal cancels a *pending* request.  Once granted it has no
  // further effect, which is what makes it usable as an acquisition timeout.
  const controller = new AbortController();
  const timer =
    timeoutMs === Infinity
      ? null
      : setTimeout(() => controller.abort(), timeoutMs);

  const done = navigator.locks.request(
    name,
    { mode: 'exclusive', signal: controller.signal },
    () => {
      onGranted();
      return held;
    },
  );

  // Rejects only if the request was abandoned before the callback ran; after a
  // grant `granted` has already settled and this is a no-op.
  done.catch(onFailed);

  try {
    await granted;
  } catch (err) {
    if (timer !== null) clearTimeout(timer);
    // AbortError is our own timeout firing; anything else is a real fault and
    // should not be dressed up as contention.
    if (isAbortError(err)) {
      throw new DatabaseLockedError(dbName, Math.round(nowMs() - startedAt));
    }
    throw err;
  }

  if (timer !== null) clearTimeout(timer);

  let released = false;
  return {
    enforced: true,
    release: async () => {
      if (released) return;
      released = true;
      release();
      // Await the request promise, so the lock is provably gone once this
      // resolves: a caller that reopens immediately must not race itself.
      await done.catch(() => {});
    },
  };
}

/**
 * Checked by `name`, not `instanceof`.  The abort arrives as a `DOMException`,
 * which inherits from `Error` in a browser but not in Node, and not across
 * realms even in a browser — a Worker's exception reaching the main thread
 * fails an `instanceof Error` test that has nothing wrong with it.
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/** Monotonic where available; only ever used for a human-facing duration. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
