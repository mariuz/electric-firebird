/**
 * isolation.ts – mapping TransactionOptions onto the engine's TPB codes.
 *
 * These numbers are the contract with `fb_start_transaction_ex` in
 * `wasm/fb_wasm_api.cpp` and must not be reordered.  They are not Firebird's
 * own `isc_tpb_*` values — the C side translates — because those are an
 * engine-internal detail that has no business crossing into JavaScript.
 */

import type { IsolationLevel, TransactionOptions } from '../types';

/** Wire values for {@link IsolationLevel}, plus 0 for "engine default". */
export const enum IsolationCode {
  Default = 0,
  ReadCommitted = 1,
  Snapshot = 2,
  SnapshotTableStability = 3,
}

const CODES: Record<IsolationLevel, IsolationCode> = {
  READ_COMMITTED: IsolationCode.ReadCommitted,
  SNAPSHOT: IsolationCode.Snapshot,
  // Firebird calls this CONSISTENCY; the name here matches the Node backend,
  // which has always exposed SNAPSHOT_TABLE_STABILITY for the same thing.
  SNAPSHOT_TABLE_STABILITY: IsolationCode.SnapshotTableStability,
};

/** The isolation code for `options`, or Default when none was asked for. */
export function isolationCode(options: TransactionOptions): IsolationCode {
  const level = options.isolationLevel;
  if (level === undefined) return IsolationCode.Default;

  const code = CODES[level];
  if (code === undefined) {
    // Reachable from JavaScript callers, who have no compiler to stop them.
    throw new Error(
      `Unknown isolation level "${String(level)}"; expected one of ` +
        Object.keys(CODES).join(', '),
    );
  }
  return code;
}

/** Whether `options` asks for anything the engine default would not give. */
export function hasTransactionOptions(options: TransactionOptions): boolean {
  return options.isolationLevel !== undefined || options.readOnly === true;
}
