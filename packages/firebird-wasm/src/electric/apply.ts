/**
 * apply.ts – one batch of Electric's shape log, applied in one transaction.
 *
 * Electric's rule is to apply operations only at `up-to-date`, as a whole:
 * the store then always matches some state Postgres was in.  The caller runs
 * this inside a Firebird transaction that also records the sync position, so
 * the rows and the position commit together or not at all.
 */

import { firebirdColumn, toFirebird } from './values';
import type { ElectricSchema } from './values';

/** What applying needs of a transaction: `FirebirdBrowserTransaction` has it. */
export interface ElectricTransaction {
  exec(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
  execBatch(sql: string, rows: unknown[][]): Promise<{ affectedRows: number }>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** An operation, or the reset a `must-refetch` asks for, in log order. */
export type LogEntry =
  | {
      kind: 'insert' | 'update' | 'delete';
      value: Record<string, unknown>;
      oldValue?: Record<string, unknown>;
    }
  | { kind: 'reset' };

/** Where the rows go. */
export interface ApplyTarget {
  /** The Firebird table, quoted. */
  table: string;
  /** Primary key columns, Postgres names, in key order. */
  primaryKey: string[];
  /** The Firebird column for a Postgres column, quoted. */
  column: (postgresName: string) => string;
  schema: ElectricSchema;
}

/** The default column mapping. */
export const defaultColumn = firebirdColumn;

/**
 * Apply `entries` through `tx`.
 *
 * - an insert is `UPDATE OR INSERT … MATCHING (key)`, so one seen twice (a
 *   replayed batch, a resync over rows already there) does no harm; a run of
 *   inserts with the same columns goes through one prepared batch;
 * - an update carries the key and the changed columns, and sets those;
 * - a delete carries the key;
 * - a reset empties the table, for the snapshot that follows to refill it.
 */
export async function applyEntries(
  tx: ElectricTransaction,
  target: ApplyTarget,
  entries: LogEntry[],
): Promise<void> {
  const key = target.primaryKey;
  const keyWhere = key.map((c) => `${target.column(c)} = ?`).join(' AND ');
  const keyValues = (value: Record<string, unknown>) =>
    key.map((c) => {
      if (!(c in value)) {
        throw new Error(`A message for ${target.table} has no value for its key column ${c}`);
      }
      return convert(target, c, value[c]);
    });

  let pending: { columns: string[]; rows: unknown[][] } | null = null;
  const flush = async () => {
    if (!pending) return;
    const { columns, rows } = pending;
    pending = null;
    const sql =
      `UPDATE OR INSERT INTO ${target.table} (${columns.map(target.column).join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')}) ` +
      `MATCHING (${key.map(target.column).join(', ')})`;
    if (rows.length === 1) await tx.exec(sql, rows[0]);
    else await tx.execBatch(sql, rows);
  };

  const schemaColumns = Object.keys(target.schema);
  const queueUpsert = async (value: Record<string, unknown>) => {
    const columns = Object.keys(value);
    const row = columns.map((c) => convert(target, c, value[c]));
    if (pending && sameColumns(pending.columns, columns)) {
      pending.rows.push(row);
    } else {
      await flush();
      pending = { columns, rows: [row] };
    }
  };

  for (const entry of entries) {
    if (entry.kind === 'insert') {
      await queueUpsert(entry.value);
      continue;
    }

    if (entry.kind === 'update' && entry.oldValue !== undefined) {
      const oldKey = entry.oldValue;
      const keyChanged = key.some((c) => c in oldKey && oldKey[c] !== entry.value[c]);
      const fullRow = schemaColumns.length > 0 && schemaColumns.every((c) => c in entry.value);
      if (keyChanged) {
        await flush();
        const mergedOldKey = Object.fromEntries(
          key.map((c) => [c, c in oldKey ? oldKey[c] : entry.value[c]]),
        );
        await tx.exec(`DELETE FROM ${target.table} WHERE ${keyWhere}`, keyValues(mergedOldKey));
        await queueUpsert(entry.value);
        continue;
      }
      if (fullRow) {
        await queueUpsert(entry.value);
        continue;
      }
    }

    await flush();

    if (entry.kind === 'reset') {
      await tx.exec(`DELETE FROM ${target.table}`);
    } else if (entry.kind === 'update') {
      const changed = Object.keys(entry.value).filter((c) => !key.includes(c));
      if (changed.length === 0) continue;
      await tx.exec(
        `UPDATE ${target.table} SET ${changed.map((c) => `${target.column(c)} = ?`).join(', ')} WHERE ${keyWhere}`,
        [...changed.map((c) => convert(target, c, entry.value[c])), ...keyValues(entry.value)],
      );
    } else {
      await tx.exec(`DELETE FROM ${target.table} WHERE ${keyWhere}`, keyValues(entry.value));
    }
  }
  await flush();
}

function convert(target: ApplyTarget, column: string, value: unknown): unknown {
  const info = target.schema[column];
  if (!info) {
    throw new Error(`Column ${column} is not in the shape's schema`);
  }
  return toFirebird(value, column, info);
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}
