/**
 * capture.ts – the change log a shape is served from, kept by triggers.
 *
 * See docs/plans/firebird-shape-server.md.  Per synced table, an AFTER
 * trigger logs each changed row's key.  The server numbers the log itself
 * (stampCommitted): a change is numbered once its transaction has committed,
 * which is the order the stream follows.
 */

import type { Attachment, Transaction } from 'node-firebird-driver';
import { TransactionIsolation } from 'node-firebird-driver';
import type { TablePlan } from './catalog';
import { quote } from './catalog';

export const CHANGES = 'ELECTRIC_CHANGES';
export const META = 'ELECTRIC_META';
/** When each commit number was given: what pruning goes by. */
export const STAMPS = 'ELECTRIC_STAMPS';
/** The event each logged change posts, delivered when its transaction commits. */
export const CHANGE_EVENT = 'ELECTRIC_CHANGES';
const CHANGE_SEQ = 'ELECTRIC_CHANGE_SEQ';
const COMMIT_SEQ = 'ELECTRIC_COMMIT_SEQ';

/** How many key columns the log has room for. */
export const KEY_COLUMNS = 4;

/** A short, stable trigger name for a table: Firebird 3 allows 31 characters. */
export function triggerName(table: string): string {
  let hash = 0x811c9dc5;
  for (const ch of table) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ELECTRIC$${hash.toString(16).padStart(8, '0').toUpperCase()}`;
}

async function exists(attachment: Attachment, tx: Transaction, sql: string, name: string): Promise<boolean> {
  // Not executeSingleton: it fails on a query that finds no row.
  const rs = await attachment.executeQuery(tx, sql, [name]);
  try {
    return (await rs.fetch({ fetchSize: 1 })).length > 0;
  } finally {
    await rs.close();
  }
}

/**
 * Create what the log needs (once) and a trigger for each of `tables`.
 * Safe to run again: existing objects are kept, triggers replaced.
 */
export async function installCapture(attachment: Attachment, tables: TablePlan[]): Promise<void> {
  // DDL commits before its objects are usable, so each step is its own
  // transaction.
  const ddl = async (sql: string) => {
    const tx = await attachment.startTransaction();
    try {
      await attachment.execute(tx, sql);
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  };
  const has = async (sql: string, name: string) => {
    const tx = await attachment.startTransaction();
    try {
      return await exists(attachment, tx, sql, name);
    } finally {
      await tx.commit();
    }
  };

  const generator = 'SELECT 1 FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = ?';
  const relation = 'SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ?';
  if (!(await has(generator, CHANGE_SEQ))) await ddl(`CREATE SEQUENCE ${CHANGE_SEQ}`);
  if (!(await has(generator, COMMIT_SEQ))) await ddl(`CREATE SEQUENCE ${COMMIT_SEQ}`);

  if (!(await has(relation, CHANGES))) {
    const keys = Array.from({ length: KEY_COLUMNS }, (_, i) => `K${i + 1} VARCHAR(255)`).join(', ');
    await ddl(
      `CREATE TABLE ${CHANGES} (CHANGE_ID BIGINT NOT NULL PRIMARY KEY, TX_ID BIGINT NOT NULL, ` +
        `COMMIT_SEQ BIGINT, TABLE_NAME VARCHAR(63) NOT NULL, OP CHAR(1) NOT NULL, ${keys})`,
    );
    await ddl(`CREATE INDEX ${CHANGES}_TX ON ${CHANGES} (TX_ID)`);
    await ddl(`CREATE INDEX ${CHANGES}_SEQ ON ${CHANGES} (COMMIT_SEQ)`);
  }
  if (!(await has(relation, META))) {
    await ddl(`CREATE TABLE ${META} (EPOCH VARCHAR(40) NOT NULL, PRUNED_THROUGH BIGINT DEFAULT 0 NOT NULL)`);
    const tx = await attachment.startTransaction();
    const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await attachment.execute(tx, `INSERT INTO ${META} (EPOCH) VALUES (?)`, [epoch]);
    await tx.commit();
  }
  // Installed by an earlier version: without pruning.
  const column = 'SELECT 1 FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = \'' + META + '\' AND RDB$FIELD_NAME = ?';
  if (!(await has(column, 'PRUNED_THROUGH'))) {
    await ddl(`ALTER TABLE ${META} ADD PRUNED_THROUGH BIGINT DEFAULT 0 NOT NULL`);
  }
  if (!(await has(relation, STAMPS))) {
    await ddl(`CREATE TABLE ${STAMPS} (COMMIT_SEQ BIGINT NOT NULL PRIMARY KEY, STAMPED_AT TIMESTAMP NOT NULL)`);
  }

  for (const table of tables) {
    await ddl(tableTrigger(table));
  }
}

/** The trigger that logs `table`'s changed keys. */
export function tableTrigger(table: TablePlan): string {
  const keys = table.key.map((_, i) => `K${i + 1}`).join(', ');
  const values = (row: 'OLD' | 'NEW') => table.key.map((k) => `${row}.${quote(k)}`).join(', ');
  const name = table.name.replace(/'/g, "''");
  const log = (op: string, row: 'OLD' | 'NEW') =>
    `INSERT INTO ${CHANGES} (CHANGE_ID, TX_ID, TABLE_NAME, OP, ${keys}) ` +
    `VALUES (GEN_ID(${CHANGE_SEQ}, 1), CURRENT_TRANSACTION, '${name}', '${op}', ${values(row)});`;
  const keyChanged = table.key.map((k) => `OLD.${quote(k)} IS DISTINCT FROM NEW.${quote(k)}`).join(' OR ');
  return (
    `CREATE OR ALTER TRIGGER ${triggerName(table.name)} FOR ${quote(table.name)}\n` +
    'ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 32767 AS\n' +
    'BEGIN\n' +
    // A changed key is the old row gone and a new one there.
    `  IF (DELETING OR (UPDATING AND (${keyChanged}))) THEN ${log('D', 'OLD')}\n` +
    `  IF (INSERTING) THEN ${log('I', 'NEW')}\n` +
    `  IF (UPDATING) THEN ${log('U', 'NEW')}\n` +
    // Wakes the servers' live requests when the transaction commits; Firebird
    // delivers one per transaction however many rows posted it.
    `  POST_EVENT '${CHANGE_EVENT}';\n` +
    'END'
  );
}

/**
 * Give every change committed since the last call one new number, and
 * return it (or 0 when there was nothing to number).
 *
 * Numbering after the commit, not in a commit trigger: a database trigger
 * is loaded when a connection attaches, so an application connected before
 * the capture was installed would never run it.  A change still being
 * written is invisible to this READ COMMITTED update and is numbered by a
 * later call, after its commit; so numbers follow commits.
 *
 * One numbering at a time, across every server on the database: each takes
 * the ELECTRIC_META row first, and a number is taken only under it.  So
 * numbers commit in order, and a snapshot that sees a number sees every
 * number below it.  Two servers numbering at once used to fail on each
 * other's rows, or commit a higher number before a lower one.
 */
export async function stampCommitted(attachment: Attachment): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const tx = await attachment.startTransaction({
      isolation: TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      waitMode: 'NO_WAIT',
    });
    try {
      const pending = await attachment.executeQuery(
        tx, `SELECT FIRST 1 1 FROM ${CHANGES} WHERE COMMIT_SEQ IS NULL`);
      const any = (await pending.fetch({ fetchSize: 1 })).length > 0;
      await pending.close();
      if (!any) {
        await tx.commit();
        return 0;
      }
      try {
        await attachment.execute(tx, `UPDATE ${META} SET EPOCH = EPOCH`);
      } catch (err) {
        // Another server is numbering: try again once it has.
        await tx.rollback().catch(() => undefined);
        if (attempt >= 100) throw err;
        await new Promise((r) => setTimeout(r, Math.min(5 * attempt, 50)));
        continue;
      }
      const seq = await attachment.executeQuery(tx, `SELECT GEN_ID(${COMMIT_SEQ}, 1) FROM RDB$DATABASE`);
      const n = Number((await seq.fetch())[0]![0]);
      await seq.close();
      await attachment.execute(tx, `UPDATE ${CHANGES} SET COMMIT_SEQ = ? WHERE COMMIT_SEQ IS NULL`, [n]);
      await attachment.execute(tx, `INSERT INTO ${STAMPS} (COMMIT_SEQ, STAMPED_AT) VALUES (?, CURRENT_TIMESTAMP)`, [n]);
      await tx.commit();
      return n;
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }
}

/**
 * Drop what was numbered before `before` from the log, and return the
 * highest number dropped (0 when nothing was).  A client whose position is
 * below it is sent back to a snapshot: what it would need is gone.
 */
export async function pruneLog(attachment: Attachment, before: Date): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const tx = await attachment.startTransaction({
      isolation: TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      waitMode: 'NO_WAIT',
    });
    try {
      try {
        // Not while a number is being given: the same lock as stampCommitted.
        await attachment.execute(tx, `UPDATE ${META} SET EPOCH = EPOCH`);
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        if (attempt >= 100) throw err;
        await new Promise((r) => setTimeout(r, Math.min(5 * attempt, 50)));
        continue;
      }
      const rs = await attachment.executeQuery(
        tx, `SELECT MAX(COMMIT_SEQ) FROM ${STAMPS} WHERE STAMPED_AT < ?`, [before]);
      const through = Number((await rs.fetch())[0]?.[0] ?? 0);
      await rs.close();
      if (through > 0) {
        await attachment.execute(tx, `DELETE FROM ${CHANGES} WHERE COMMIT_SEQ <= ?`, [through]);
        await attachment.execute(tx, `DELETE FROM ${STAMPS} WHERE COMMIT_SEQ <= ?`, [through]);
        await attachment.execute(tx, `UPDATE ${META} SET PRUNED_THROUGH = ? WHERE PRUNED_THROUGH < ?`, [through, through]);
      }
      await tx.commit();
      return through;
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }
}
