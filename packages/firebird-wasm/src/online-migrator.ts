/**
 * online-migrator.ts – Zero-Downtime Online Schema Migrations
 * (Expand -> PSQL Dual-Write Trigger -> Throttled Keyset Backfill -> Parity Check -> Contract)
 * (`createOnlineMigrator`) (`M28 Item 3`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_ONLINE_MIGRATIONS_TABLE = 'FB_ONLINE_MIGRATIONS$';

export type OnlineMigrationPhase = 'planned' | 'expanded' | 'backfilled' | 'contracted' | 'rolled_back';

/** Declarative column migration rule (`M28 Item 3`). */
export type OnlineColumnRule =
  | {
      readonly kind: 'renameColumn';
      readonly from: string;
      readonly to: string;
      readonly sqlType?: string;
      readonly type?: string;
    }
  | {
      readonly kind: 'transformColumn';
      readonly from: string;
      readonly to: string;
      readonly sqlType?: string;
      readonly type?: string;
      /** SQL expression referencing `"<FROM>"` / `NEW."<FROM>"` / `{from}`. */
      readonly forwardExpr?: string;
      readonly forwardSql?: string;
      /** Optional inverse SQL expression referencing `{to}` / `NEW."<TO>"` for bidirectional dual-writes. */
      readonly reverseExpr?: string;
      readonly reverseSql?: string;
    }
  | {
      readonly kind: 'computeColumn';
      readonly to: string;
      readonly sqlType?: string;
      readonly type?: string;
      /** SQL expression using column identifiers or `NEW."COL"`. */
      readonly sqlExpr?: string;
      readonly expressionSql?: string;
      /** Optional columns referenced by `sqlExpr` so trigger rewrites `COL` -> `NEW."COL"`. */
      readonly sourceColumns?: readonly string[];
    };

/** Declarative online migration plan (`M28 Item 3`). */
export interface OnlineMigrationPlan {
  readonly id: string;
  readonly table: string;
  readonly primaryKey?: string;
  readonly rules: readonly OnlineColumnRule[];
}

/** Minimal database interface required by {@link createOnlineMigrator} (`M28 Item 3`). */
export interface OnlineMigratorDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
}

/** Progress snapshot emitted during batched keyset backfill (`M28 Item 3`). */
export interface OnlineBackfillProgress {
  readonly batchesCompleted: number;
  readonly rowsUpdated: number;
  readonly lastKey: string | number | null;
}

/** Parity check result returned by {@link OnlineMigratorHandle.verifyParity} (`M28 Item 3`). */
export interface OnlineParityReport {
  readonly valid: boolean;
  readonly totalRows: number;
  readonly mismatchedRows: number;
  readonly details: ReadonlyArray<{ readonly column: string; readonly mismatched: number }>;
}

/** Handle returned by {@link createOnlineMigrator} (`M28 Item 3`). */
export interface OnlineMigratorHandle {
  readonly plan: OnlineMigrationPlan;
  readonly triggerName: string;
  getPhase(): Promise<OnlineMigrationPhase>;
  expand(): Promise<{ addedColumns: string[]; triggerName: string; ddlExecuted: string[] }>;
  backfill(options?: {
    batchSize?: number;
    yieldMs?: number;
    onProgress?: (progress: OnlineBackfillProgress) => void;
  }): Promise<OnlineBackfillProgress>;
  verifyParity(): Promise<OnlineParityReport>;
  contract(options?: { dropSourceColumns?: boolean }): Promise<{
    droppedTrigger: string;
    droppedColumns: string[];
    ddlExecuted: string[];
  }>;
  rollback(): Promise<{ droppedTrigger: string; droppedColumns: string[] }>;
  runAll(options?: {
    batchSize?: number;
    yieldMs?: number;
    dropSourceColumns?: boolean;
  }): Promise<{
    addedColumns: string[];
    backfill: OnlineBackfillProgress;
    parity: OnlineParityReport;
    droppedColumns: string[];
  }>;
}

function qOmIdent(name: string): string {
  return `"${name.toUpperCase().replace(/"/g, '""')}"`;
}

function omCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execOmSql(
  db: OnlineMigratorDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<number> {
  if (typeof db.execute === 'function') {
    const r = await db.execute(sql, params);
    return r.affectedRows;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
    return 0;
  }
  await db.query(sql, params);
  return 0;
}

function rewriteTableExprForTriggerNew(expr: string, cols: readonly string[]): string {
  let out = expr;
  for (const rawCol of cols) {
    const col = rawCol.toUpperCase();
    const quotedRe = new RegExp(`(?<!NEW\\.)"${col}"`, 'gi');
    out = out.replace(quotedRe, `NEW."${col}"`);
    const bareRe = new RegExp(`(?<!NEW\\.|")\\b${col}\\b(?!")`, 'gi');
    out = out.replace(bareRe, `NEW."${col}"`);
  }
  return out;
}

function resolveRuleSqlType(rule: OnlineColumnRule): string {
  const t = (rule.sqlType ?? rule.type ?? '').trim();
  if (!t) throw new Error(`Online migration rule for "${rule.to}" requires sqlType or type.`);
  return t;
}

function stripTriggerNewPrefix(expr: string): string {
  return expr.replace(/\bNEW\.\s*/gi, '');
}

function buildRuleRowSqlExpr(rule: OnlineColumnRule): string {
  if (rule.kind === 'renameColumn') {
    return qOmIdent(rule.from);
  }
  if (rule.kind === 'transformColumn') {
    const fwd = rule.forwardExpr ?? rule.forwardSql ?? '';
    return stripTriggerNewPrefix(fwd.replace(/\{from\}/gi, qOmIdent(rule.from)));
  }
  return stripTriggerNewPrefix(rule.sqlExpr ?? rule.expressionSql ?? 'NULL');
}

function buildRuleTriggerPsqlSnippet(rule: OnlineColumnRule): string {
  const toCol = rule.to.toUpperCase();
  if (rule.kind === 'renameColumn') {
    const fromCol = rule.from.toUpperCase();
    return [
      `  IF (INSERTING) THEN`,
      `  BEGIN`,
      `    IF (NEW."${toCol}" IS NULL AND NEW."${fromCol}" IS NOT NULL) THEN NEW."${toCol}" = NEW."${fromCol}";`,
      `    ELSE IF (NEW."${fromCol}" IS NULL AND NEW."${toCol}" IS NOT NULL) THEN NEW."${fromCol}" = NEW."${toCol}";`,
      `  END`,
      `  ELSE IF (UPDATING) THEN`,
      `  BEGIN`,
      `    IF (NEW."${toCol}" IS DISTINCT FROM OLD."${toCol}" AND NEW."${fromCol}" IS NOT DISTINCT FROM OLD."${fromCol}") THEN`,
      `      NEW."${fromCol}" = NEW."${toCol}";`,
      `    ELSE`,
      `      NEW."${toCol}" = NEW."${fromCol}";`,
      `  END`,
    ].join('\n');
  }

  if (rule.kind === 'transformColumn') {
    const fromCol = rule.from.toUpperCase();
    const rawFwd = rule.forwardExpr ?? rule.forwardSql ?? `"${fromCol}"`;
    const rawRev = rule.reverseExpr ?? rule.reverseSql;
    const fwdNew = rewriteTableExprForTriggerNew(
      rawFwd.replace(/\{from\}/gi, `"${fromCol}"`),
      [fromCol],
    );
    const revNew = rawRev
      ? rewriteTableExprForTriggerNew(
          rawRev.replace(/\{to\}/gi, `"${toCol}"`),
          [toCol],
        )
      : null;

    const lines = [
      `  IF (INSERTING) THEN`,
      `  BEGIN`,
      `    IF (NEW."${toCol}" IS NULL AND NEW."${fromCol}" IS NOT NULL) THEN NEW."${toCol}" = ${fwdNew};`,
    ];
    if (revNew) {
      lines.push(
        `    ELSE IF (NEW."${fromCol}" IS NULL AND NEW."${toCol}" IS NOT NULL) THEN NEW."${fromCol}" = ${revNew};`,
      );
    }
    lines.push(
      `  END`,
      `  ELSE IF (UPDATING) THEN`,
      `  BEGIN`,
    );
    if (revNew) {
      lines.push(
        `    IF (NEW."${toCol}" IS DISTINCT FROM OLD."${toCol}" AND NEW."${fromCol}" IS NOT DISTINCT FROM OLD."${fromCol}") THEN`,
        `      NEW."${fromCol}" = ${revNew};`,
        `    ELSE`,
        `      NEW."${toCol}" = ${fwdNew};`,
      );
    } else {
      lines.push(`    NEW."${toCol}" = ${fwdNew};`);
    }
    lines.push(`  END`);
    return lines.join('\n');
  }

  const rawExpr = rule.sqlExpr ?? rule.expressionSql ?? 'NULL';
  const exprNew = rewriteTableExprForTriggerNew(rawExpr, rule.sourceColumns ?? []);
  return `  NEW."${toCol}" = ${exprNew};`;
}

/**
 * Create a zero-downtime Expand / Backfill / Contract online schema migrator
 * backed by Firebird PSQL dual-write triggers & keyset batching (`M28 Item 3`).
 */
export function createOnlineMigrator(
  db: OnlineMigratorDatabaseExecutor,
  plan: OnlineMigrationPlan,
  options: { metaTable?: string } = {},
): OnlineMigratorHandle {
  const metaTable = (options.metaTable ?? DEFAULT_ONLINE_MIGRATIONS_TABLE).toUpperCase();
  const tableName = plan.table.trim().toUpperCase();
  const pkCol = (plan.primaryKey ?? 'ID').trim().toUpperCase();
  const triggerName = `FB_OMIG_TRG$${tableName}`.slice(0, 31);

  const ensureMetaTable = async (): Promise<void> => {
    const chk = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [metaTable],
    );
    if (Number(omCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execOmSql(
        db,
        `CREATE TABLE ${qOmIdent(metaTable)} (
          MIGRATION_ID VARCHAR(128) NOT NULL PRIMARY KEY,
          TABLE_NAME VARCHAR(64) NOT NULL,
          PHASE VARCHAR(24) NOT NULL,
          PLAN_JSON BLOB SUB_TYPE TEXT NOT NULL,
          UPDATED_AT BIGINT NOT NULL
        )`,
      );
    }
  };

  const setPhase = async (phase: OnlineMigrationPhase): Promise<void> => {
    await ensureMetaTable();
    await execOmSql(
      db,
      `UPDATE OR INSERT INTO ${qOmIdent(metaTable)} (
        MIGRATION_ID, TABLE_NAME, PHASE, PLAN_JSON, UPDATED_AT
      ) VALUES (?, ?, ?, ?, ?) MATCHING (MIGRATION_ID)`,
      [plan.id, tableName, phase, JSON.stringify(plan), Date.now()],
    );
  };

  const getExistingColumns = async (): Promise<Set<string>> => {
    const res = await db.query<Record<string, unknown>>(
      `SELECT TRIM(RDB$FIELD_NAME) AS COL_NAME FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [tableName],
    );
    return new Set(res.rows.map((r) => String(omCol(r, 'COL_NAME') ?? '').toUpperCase()));
  };

  const dropDualWriteTriggerIfExists = async (ddlExecuted?: string[]): Promise<boolean> => {
    const trgChk = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$TRIGGERS WHERE TRIM(RDB$TRIGGER_NAME) = ?`,
      [triggerName],
    );
    if (Number(omCol(trgChk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
      const dropSql = `DROP TRIGGER ${qOmIdent(triggerName)}`;
      await execOmSql(db, dropSql);
      ddlExecuted?.push(dropSql);
      return true;
    }
    return false;
  };

  return {
    plan,
    triggerName,

    async getPhase(): Promise<OnlineMigrationPhase> {
      await ensureMetaTable();
      const res = await db.query<Record<string, unknown>>(
        `SELECT PHASE FROM ${qOmIdent(metaTable)} WHERE MIGRATION_ID = ?`,
        [plan.id],
      );
      if (res.rows.length === 0) return 'planned';
      return String(omCol(res.rows[0]!, 'PHASE') ?? 'planned') as OnlineMigrationPhase;
    },

    async expand() {
      const existingCols = await getExistingColumns();
      const addedColumns: string[] = [];
      const ddlExecuted: string[] = [];

      for (const rule of plan.rules) {
        const targetUpper = rule.to.toUpperCase();
        if (!existingCols.has(targetUpper)) {
          // Strip NOT NULL during online expand phase so existing un-backfilled rows remain valid
          const nullableType = resolveRuleSqlType(rule).replace(/\bNOT\s+NULL\b/gi, '').trim();
          const alterSql = `ALTER TABLE ${qOmIdent(tableName)} ADD ${qOmIdent(targetUpper)} ${nullableType}`;
          await execOmSql(db, alterSql);
          addedColumns.push(targetUpper);
          ddlExecuted.push(alterSql);
          existingCols.add(targetUpper);
        }
        // Also ensure legacy `from` column is nullable during expand so new-only inserts succeed!
        if (rule.kind === 'renameColumn' || rule.kind === 'transformColumn') {
          const fromUpper = rule.from.toUpperCase();
          const nullChk = await db.query<Record<string, unknown>>(
            `SELECT COALESCE(RDB$NULL_FLAG, 0) AS NF
             FROM RDB$RELATION_FIELDS
             WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?`,
            [tableName, fromUpper],
          );
          if (Number(omCol(nullChk.rows[0] ?? {}, 'NF') ?? 0) === 1) {
            const dropNn = `ALTER TABLE ${qOmIdent(tableName)} ALTER COLUMN ${qOmIdent(fromUpper)} DROP NOT NULL`;
            await execOmSql(db, dropNn).catch(() => undefined);
          }
        }
      }

      const bodySnippets = plan.rules.map(buildRuleTriggerPsqlSnippet).join('\n');
      const triggerSql = [
        `CREATE OR ALTER TRIGGER ${qOmIdent(triggerName)} FOR ${qOmIdent(tableName)}`,
        `ACTIVE BEFORE INSERT OR UPDATE POSITION 0`,
        `AS`,
        `BEGIN`,
        bodySnippets,
        `END`,
      ].join('\n');

      await execOmSql(db, `SET TERM ^ ;\n${triggerSql}^\nSET TERM ; ^`);
      ddlExecuted.push(triggerSql);
      await setPhase('expanded');

      return { addedColumns, triggerName, ddlExecuted };
    },

    async backfill(bfOpts = {}) {
      const batchSize = Math.max(1, bfOpts.batchSize ?? 200);
      const yieldMs = Math.max(0, bfOpts.yieldMs ?? 0);
      let lastKey: string | number | null = null;
      let batchesCompleted = 0;
      let rowsUpdated = 0;

      const setAssignments = plan.rules
        .map((r) => `${qOmIdent(r.to)} = ${buildRuleRowSqlExpr(r)}`)
        .join(', ');

      for (;;) {
        const pageSql: string =
          lastKey === null
            ? `SELECT FIRST ${batchSize} ${qOmIdent(pkCol)} AS PK_VAL
               FROM ${qOmIdent(tableName)}
               ORDER BY ${qOmIdent(pkCol)} ASC`
            : `SELECT FIRST ${batchSize} ${qOmIdent(pkCol)} AS PK_VAL
               FROM ${qOmIdent(tableName)}
               WHERE ${qOmIdent(pkCol)} > ?
               ORDER BY ${qOmIdent(pkCol)} ASC`;
        const pageRes: QueryResult<Record<string, unknown>> = await db.query<Record<string, unknown>>(
          pageSql,
          lastKey === null ? [] : [lastKey],
        );
        if (pageRes.rows.length === 0) break;

        const keys: Array<string | number> = pageRes.rows.map(
          (r: Record<string, unknown>) => omCol(r, 'PK_VAL') as string | number,
        );
        const firstK: string | number = keys[0]!;
        const lastK: string | number = keys[keys.length - 1]!;

        const updSql = `UPDATE ${qOmIdent(tableName)}
          SET ${setAssignments}
          WHERE ${qOmIdent(pkCol)} >= ? AND ${qOmIdent(pkCol)} <= ?`;
        await execOmSql(db, updSql, [firstK, lastK]);

        lastKey = lastK;
        batchesCompleted += 1;
        rowsUpdated += keys.length;
        bfOpts.onProgress?.({ batchesCompleted, rowsUpdated, lastKey });

        if (pageRes.rows.length < batchSize) break;
        if (yieldMs > 0) {
          await new Promise((r) => setTimeout(r, yieldMs));
        }
      }

      await setPhase('backfilled');
      return { batchesCompleted, rowsUpdated, lastKey };
    },

    async verifyParity(): Promise<OnlineParityReport> {
      const totRes = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM ${qOmIdent(tableName)}`,
      );
      const totalRows = Number(omCol(totRes.rows[0] ?? {}, 'CNT') ?? 0);
      const details: Array<{ column: string; mismatched: number }> = [];
      let mismatchedRows = 0;

      for (const rule of plan.rules) {
        const expectedExpr = buildRuleRowSqlExpr(rule);
        const misRes = await db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT
           FROM ${qOmIdent(tableName)}
           WHERE ${qOmIdent(rule.to)} IS DISTINCT FROM (${expectedExpr})`,
        );
        const mis = Number(omCol(misRes.rows[0] ?? {}, 'CNT') ?? 0);
        details.push({ column: rule.to.toUpperCase(), mismatched: mis });
        mismatchedRows += mis;
      }

      return {
        valid: mismatchedRows === 0,
        totalRows,
        mismatchedRows,
        details,
      };
    },

    async contract(conOpts = {}) {
      const ddlExecuted: string[] = [];
      await dropDualWriteTriggerIfExists(ddlExecuted);

      const droppedColumns: string[] = [];
      if (conOpts.dropSourceColumns) {
        const existingCols = await getExistingColumns();
        for (const rule of plan.rules) {
          if (rule.kind === 'renameColumn' || rule.kind === 'transformColumn') {
            const fromUpper = rule.from.toUpperCase();
            if (existingCols.has(fromUpper) && fromUpper !== rule.to.toUpperCase()) {
              const dropColSql = `ALTER TABLE ${qOmIdent(tableName)} DROP ${qOmIdent(fromUpper)}`;
              await execOmSql(db, dropColSql);
              droppedColumns.push(fromUpper);
              ddlExecuted.push(dropColSql);
              existingCols.delete(fromUpper);
            }
          }
        }
      }

      await setPhase('contracted');
      return { droppedTrigger: triggerName, droppedColumns, ddlExecuted };
    },

    async rollback() {
      await dropDualWriteTriggerIfExists();
      const existingCols = await getExistingColumns();
      const droppedColumns: string[] = [];

      for (const rule of plan.rules) {
        const toUpper = rule.to.toUpperCase();
        if (existingCols.has(toUpper)) {
          await execOmSql(db, `ALTER TABLE ${qOmIdent(tableName)} DROP ${qOmIdent(toUpper)}`);
          droppedColumns.push(toUpper);
          existingCols.delete(toUpper);
        }
      }

      await setPhase('rolled_back');
      return { droppedTrigger: triggerName, droppedColumns };
    },

    async runAll(allOpts = {}) {
      const exp = await this.expand();
      const backfill = await this.backfill({
        batchSize: allOpts.batchSize,
        yieldMs: allOpts.yieldMs,
      });
      const parity = await this.verifyParity();
      if (!parity.valid) {
        throw new Error(
          `Online migration "${plan.id}" parity verification failed (${parity.mismatchedRows} mismatched rows). Aborting contract phase.`,
        );
      }
      const con = await this.contract({ dropSourceColumns: allOpts.dropSourceColumns });
      return {
        addedColumns: exp.addedColumns,
        backfill,
        parity,
        droppedColumns: con.droppedColumns,
      };
    },
  };
}
