/**
 * serial.ts – one transaction at a time per database, among the syncs and
 * the write queue.
 *
 * A sync's batch and a local write can both change the same row.  Two such
 * transactions at once on one connection would wait on each other's lock in
 * the engine, and the browser engine answers one call at a time: the wait
 * would never end.  So every transaction this module runs on a database
 * waits for the one before it.
 */

const queues = new WeakMap<object, Promise<unknown>>();

/** Run `fn` once every earlier `serially(db, …)` call has finished. */
export function serially<T>(db: object, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(db) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  queues.set(db, result.catch(() => undefined));
  return result;
}

/** Anything with Firebird-style transactions. */
interface Transactional<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** `db` with its `transaction` queued behind every other one run through this module. */
export function serialDatabase<Tx>(db: Transactional<Tx>): Transactional<Tx> {
  return {
    transaction: <T>(fn: (tx: Tx) => Promise<T>) => serially(db, () => db.transaction(fn)),
  };
}
