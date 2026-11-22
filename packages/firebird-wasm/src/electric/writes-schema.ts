/**
 * writes-schema.ts – DDL provisioning helper for `ELECTRIC_WRITES` / `FB_WRITE_QUEUE$`.
 */

import type { WritesDatabase } from './writes';

const MAX_VALUE = 3900;
const MAX_BEFORE_VALUE = 3900;

export async function ensureWritesTable(
  db: WritesDatabase,
  writesQuoted: string,
  writesRawName: string,
): Promise<boolean> {
  const relationCheckSql =
    writesRawName === 'ELECTRIC_WRITES'
      ? "SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_WRITES'"
      : 'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?';
  const relationCheckParams = writesRawName === 'ELECTRIC_WRITES' ? undefined : [writesRawName];

  for (let attempt = 1; ; attempt++) {
    try {
      let hasBeforeColumn = true;
      await db.transaction(async (tx) => {
        const { rows } = relationCheckParams
          ? await tx.query(relationCheckSql, relationCheckParams)
          : await tx.query(relationCheckSql);
        if (rows.length > 0) {
          try {
            const colCheck = await tx.query(
              'SELECT 1 AS X FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?',
              [writesRawName, 'BEFORE_JSON'],
            );
            if (colCheck.rows.length === 0) {
              await tx.exec(
                `ALTER TABLE ${writesQuoted} ADD BEFORE_JSON VARCHAR(${MAX_BEFORE_VALUE}) CHARACTER SET UTF8`,
              );
            }
          } catch {
            hasBeforeColumn = false;
          }
          return;
        }
        await tx.exec(
          `CREATE TABLE ${writesQuoted} (ID INTEGER NOT NULL PRIMARY KEY, TABLE_NAME VARCHAR(255) NOT NULL, ` +
            'OP CHAR(1) NOT NULL, KEY_JSON VARCHAR(2000) CHARACTER SET UTF8 NOT NULL, ' +
            `VALUE_JSON VARCHAR(${MAX_VALUE}) CHARACTER SET UTF8, ` +
            `BEFORE_JSON VARCHAR(${MAX_BEFORE_VALUE}) CHARACTER SET UTF8, ` +
            "STATE CHAR(1) DEFAULT 'P' NOT NULL, TXID VARCHAR(40), SENT_AT DOUBLE PRECISION)",
        );
      });
      return hasBeforeColumn;
    } catch (error) {
      const made = await db.transaction(async (tx) => {
        const res = relationCheckParams
          ? await tx.query(relationCheckSql, relationCheckParams)
          : await tx.query(relationCheckSql);
        return res.rows.length > 0;
      });
      if (made) return true;
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}
