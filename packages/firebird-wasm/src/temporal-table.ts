/**
 * temporal-table.ts – System-Versioned Bitemporal History Tables (`createTemporalTable`)
 * & SQL:2011 `FOR SYSTEM_TIME AS OF` / `BETWEEN` Query Rewriter (`M30 Item 1`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_TEMPORAL_META_TABLE = 'FB_TEMPORAL_META$';
export const TEMPORAL_INFINITY_MS = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

export interface TemporalDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

export type TemporalTimestampInput = number | string | Date;

export interface TemporalTableInfo {
  readonly tableName: string;
  readonly primaryKey: string;
  readonly historyTable: string;
  readonly triggerName: string;
  readonly columns: readonly string[];
  readonly versionCount: number;
  readonly createdAtMs: number;
}

export interface TemporalHistoryRevision<T extends Row = Row> {
  readonly seq: number;
  readonly op: 'INSERT' | 'UPDATE' | 'DELETE';
  readonly pkKey: string;
  readonly sysStartMs: number;
  readonly sysEndMs: number;
  readonly row: T;
  readonly changedColumns: readonly string[];
}

export interface CreateTemporalTableOptions {
  readonly table: string;
  readonly primaryKey?: string;
  readonly historyTable?: string;
  readonly metaTable?: string;
  /** Optional initial system clock override in epoch ms (sets `FB_TEMPORAL_NOW_MS` context). */
  readonly initialNowMs?: TemporalTimestampInput;
}

export interface TemporalTableHandle<T extends Row = Row> {
  readonly table: string;
  readonly primaryKey: string;
  readonly historyTable: string;
  readonly triggerName: string;
  /** Enable system versioning: creates history table, seeds existing rows, and installs PSQL trigger. */
  enable(): Promise<TemporalTableInfo>;
  /** Disable system versioning: drops the PSQL trigger (preserving history unless `dropHistory` is true). */
  disable(options?: { dropHistory?: boolean }): Promise<void>;
  /** Pin or clear (`null`) the session's logical `FB_TEMPORAL_NOW_MS` clock for deterministic testing/replay. */
  setSystemTime(ts: TemporalTimestampInput | null): Promise<void>;
  /** Query exact table state as of `ts` (`SYS_START_MS <= ts AND SYS_END_MS > ts`). */
  queryAsOf<R extends Row = T>(
    ts: TemporalTimestampInput,
    options?: { where?: string; params?: QueryParams; orderBy?: string },
  ): Promise<R[]>;
  /** Query all row versions overlapping `[startTs, endTs]`. */
  queryBetween<R extends Row = T>(
    startTs: TemporalTimestampInput,
    endTs: TemporalTimestampInput,
    options?: { where?: string; params?: QueryParams },
  ): Promise<Array<R & { SYS_START_MS: number; SYS_END_MS: number; HIST_OP: string }>>;
  /** Inspect ordered revision timeline and per-revision changed columns for a single primary key. */
  diffRowHistory(pkValue: string | number): Promise<Array<TemporalHistoryRevision<T>>>;
  /** Restore a single row to its exact state at `ts` (upserting or deleting on the live table). */
  revertRowAsOf(
    pkValue: string | number,
    ts: TemporalTimestampInput,
  ): Promise<{ action: 'restored' | 'deleted' | 'noop'; row: T | null }>;
  /** Prune closed historical intervals whose `SYS_END_MS <= cutoffTs`. */
  pruneHistoryBefore(cutoffTs: TemporalTimestampInput): Promise<{ deletedVersions: number }>;
}

function qTmpIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function tmpCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execTmpSql(
  db: TemporalDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

/** Normalize epoch ms, ISO-8601 string, or `Date` into integer epoch milliseconds (`M30 Item 1`). */
export function parseTemporalTimestampMs(ts: TemporalTimestampInput): number {
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) throw new RangeError(`Invalid temporal timestamp: ${String(ts)}`);
    return Math.floor(ts);
  }
  if (ts instanceof Date) {
    const ms = ts.getTime();
    if (!Number.isFinite(ms)) throw new RangeError('Invalid Date passed to temporal query.');
    return ms;
  }
  const trimmed = String(ts).trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Cannot parse temporal timestamp "${trimmed}". Expected epoch ms or ISO-8601.`);
  }
  return parsed;
}

interface IntrospectedTmpColumn {
  readonly name: string;
  readonly ddlType: string;
}

async function introspectTableColumnsForHistory(
  db: TemporalDatabaseExecutor,
  tableUpper: string,
): Promise<IntrospectedTmpColumn[]> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT
       TRIM(rf.RDB$FIELD_NAME) AS COL_NAME,
       f.RDB$FIELD_TYPE AS F_TYPE,
       f.RDB$FIELD_SUB_TYPE AS F_SUB,
       f.RDB$FIELD_LENGTH AS F_LEN,
       f.RDB$CHARACTER_LENGTH AS CHAR_LEN,
       f.RDB$FIELD_PRECISION AS F_PREC,
       f.RDB$FIELD_SCALE AS F_SCALE
     FROM RDB$RELATION_FIELDS rf
     JOIN RDB$FIELDS f ON rf.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
     WHERE TRIM(rf.RDB$RELATION_NAME) = ?
     ORDER BY rf.RDB$FIELD_POSITION ASC`,
    [tableUpper],
  );
  if (res.rows.length === 0) {
    throw new Error(`Temporal target table "${tableUpper}" does not exist.`);
  }

  return res.rows.map((r) => {
    const name = String(tmpCol(r, 'COL_NAME') ?? '').toUpperCase();
    const fType = Number(tmpCol(r, 'F_TYPE') ?? 0);
    const fSub = Number(tmpCol(r, 'F_SUB') ?? 0);
    const charLen = Number(tmpCol(r, 'CHAR_LEN') ?? tmpCol(r, 'F_LEN') ?? 64);
    const prec = Number(tmpCol(r, 'F_PREC') ?? 18);
    const scale = Math.abs(Number(tmpCol(r, 'F_SCALE') ?? 0));

    let ddlType = 'VARCHAR(256)';
    switch (fType) {
      case 7:
        ddlType = scale > 0 ? `NUMERIC(${prec || 9}, ${scale})` : 'SMALLINT';
        break;
      case 8:
        ddlType = scale > 0 ? `NUMERIC(${prec || 9}, ${scale})` : 'INTEGER';
        break;
      case 16:
        ddlType = scale > 0 ? `NUMERIC(${prec || 18}, ${scale})` : 'BIGINT';
        break;
      case 10:
        ddlType = 'FLOAT';
        break;
      case 27:
        ddlType = 'DOUBLE PRECISION';
        break;
      case 12:
        ddlType = 'DATE';
        break;
      case 13:
        ddlType = 'TIME';
        break;
      case 35:
      case 29:
        ddlType = 'TIMESTAMP';
        break;
      case 23:
        ddlType = 'BOOLEAN';
        break;
      case 14:
        ddlType = `CHAR(${Math.max(1, charLen)})`;
        break;
      case 37:
        ddlType = `VARCHAR(${Math.max(1, charLen)})`;
        break;
      case 261:
        ddlType = fSub === 1 ? 'BLOB SUB_TYPE TEXT' : 'BLOB';
        break;
      default:
        ddlType = `VARCHAR(${Math.max(64, charLen)})`;
    }
    return { name, ddlType };
  });
}

/**
 * Rewrite SQL:2011 `FROM <table> [AS <alias>] FOR SYSTEM_TIME AS OF <lit>` or
 * `FOR SYSTEM_TIME BETWEEN <a> AND <b>` clauses into Firebird history-table queries (`M30 Item 1`).
 */
export function rewriteTemporalSql(
  sql: string,
  options: { historyPrefix?: string } = {},
): string {
  const prefix = options.historyPrefix ?? 'FB_THIST$';

  // 1. FOR SYSTEM_TIME BETWEEN <start> AND <end>
  const betweenRe =
    /\bFROM\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))(?:\s+(?:AS\s+)?(?!FOR\b|WHERE\b|ORDER\b|GROUP\b|JOIN\b|LEFT\b|INNER\b)([A-Za-z_][A-Za-z0-9_$]*))?\s+FOR\s+SYSTEM_TIME\s+BETWEEN\s+('[^']*'|\d+)\s+AND\s+('[^']*'|\d+)/gi;
  let rewritten = sql.replace(
    betweenRe,
    (_m, quotedTbl: string | undefined, bareTbl: string | undefined, alias: string | undefined, rawA: string, rawB: string) => {
      const tbl = (quotedTbl ?? bareTbl ?? '').toUpperCase();
      const histTbl = `"${prefix}${tbl}"`;
      const aMs = parseTemporalTimestampMs(rawA.replace(/^'|'$/g, ''));
      const bMs = parseTemporalTimestampMs(rawB.replace(/^'|'$/g, ''));
      const aliasSql = alias ? ` AS ${alias}` : ` AS "${tbl}"`;
      return `FROM (SELECT * FROM ${histTbl} WHERE "SYS_START_MS" <= ${bMs} AND "SYS_END_MS" > ${aMs})${aliasSql}`;
    },
  );

  // 2. FOR SYSTEM_TIME AS OF <ts>
  const asOfRe =
    /\bFROM\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))(?:\s+(?:AS\s+)?(?!FOR\b|WHERE\b|ORDER\b|GROUP\b|JOIN\b|LEFT\b|INNER\b)([A-Za-z_][A-Za-z0-9_$]*))?\s+FOR\s+SYSTEM_TIME\s+AS\s+OF\s+('[^']*'|\d+)/gi;
  rewritten = rewritten.replace(
    asOfRe,
    (_m, quotedTbl: string | undefined, bareTbl: string | undefined, alias: string | undefined, rawTs: string) => {
      const tbl = (quotedTbl ?? bareTbl ?? '').toUpperCase();
      const histTbl = `"${prefix}${tbl}"`;
      const tsMs = parseTemporalTimestampMs(rawTs.replace(/^'|'$/g, ''));
      const aliasSql = alias ? ` AS ${alias}` : ` AS "${tbl}"`;
      return `FROM (SELECT * FROM ${histTbl} WHERE "SYS_START_MS" <= ${tsMs} AND "SYS_END_MS" > ${tsMs} AND "HIST_OP" <> 'DELETE')${aliasSql}`;
    },
  );

  return rewritten;
}

/**
 * List all registered system-versioned bitemporal tables without mutating schema (`M30 Item 1`).
 */
export async function listTemporalTables(
  db: TemporalDatabaseExecutor,
  metaTable = DEFAULT_TEMPORAL_META_TABLE,
): Promise<TemporalTableInfo[]> {
  const metaUpper = metaTable.trim().toUpperCase();
  const chk = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [metaUpper],
  );
  if (Number(tmpCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];

  const res = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${qTmpIdent(metaUpper)} ORDER BY TABLE_NAME ASC`,
  );
  const out: TemporalTableInfo[] = [];
  for (const r of res.rows) {
    const histTable = String(tmpCol(r, 'HISTORY_TABLE') ?? '').trim();
    let versionCount = 0;
    try {
      const cntRes = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM ${qTmpIdent(histTable)}`,
      );
      versionCount = Number(tmpCol(cntRes.rows[0] ?? {}, 'CNT') ?? 0);
    } catch {
      versionCount = 0;
    }
    const colsJson = String(tmpCol(r, 'COLUMNS_JSON') ?? '[]');
    out.push({
      tableName: String(tmpCol(r, 'TABLE_NAME') ?? '').trim(),
      primaryKey: String(tmpCol(r, 'PRIMARY_KEY') ?? 'ID').trim(),
      historyTable: histTable,
      triggerName: String(tmpCol(r, 'TRIGGER_NAME') ?? '').trim(),
      columns: JSON.parse(colsJson) as string[],
      versionCount,
      createdAtMs: Number(tmpCol(r, 'CREATED_AT_MS') ?? 0),
    });
  }
  return out;
}

/**
 * Create and manage a SQL:2011-style system-versioned bitemporal history table (`M30 Item 1`).
 */
export function createTemporalTable<T extends Row = Row>(
  db: TemporalDatabaseExecutor,
  options: CreateTemporalTableOptions,
): TemporalTableHandle<T> {
  const tableUpper = options.table.trim().replace(/^"|"$/g, '').toUpperCase();
  const pkUpper = (options.primaryKey ?? 'ID').trim().replace(/^"|"$/g, '').toUpperCase();
  const historyUpper = (options.historyTable ?? `FB_THIST$${tableUpper}`).toUpperCase().slice(0, 60);
  const triggerUpper = `FB_TTRG$${tableUpper}`.toUpperCase().slice(0, 31);
  const metaUpper = (options.metaTable ?? DEFAULT_TEMPORAL_META_TABLE).toUpperCase();

  let cachedCols: IntrospectedTmpColumn[] | null = null;
  let pinnedNowMs: number | null =
    options.initialNowMs !== undefined ? parseTemporalTimestampMs(options.initialNowMs) : null;

  const getCols = async (): Promise<IntrospectedTmpColumn[]> => {
    if (!cachedCols) {
      cachedCols = await introspectTableColumnsForHistory(db, tableUpper);
    }
    return cachedCols;
  };

  const setSystemTime = async (ts: TemporalTimestampInput | null): Promise<void> => {
    pinnedNowMs = ts === null ? null : parseTemporalTimestampMs(ts);
    await db.query(
      `SELECT RDB$SET_CONTEXT('USER_SESSION', 'FB_TEMPORAL_NOW_MS', ?) AS CTX FROM RDB$DATABASE`,
      [pinnedNowMs === null ? null : String(pinnedNowMs)],
    );
  };

  const ensureMetaTable = async (): Promise<void> => {
    const chk = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [metaUpper],
    );
    if (Number(tmpCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execTmpSql(
        db,
        `CREATE TABLE ${qTmpIdent(metaUpper)} (
          TABLE_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
          PRIMARY_KEY VARCHAR(128) NOT NULL,
          HISTORY_TABLE VARCHAR(128) NOT NULL,
          TRIGGER_NAME VARCHAR(64) NOT NULL,
          COLUMNS_JSON BLOB SUB_TYPE TEXT NOT NULL,
          CREATED_AT_MS BIGINT NOT NULL
        )`,
      );
    }
  };

  const stripInternalCols = <R extends Row>(
    raw: Record<string, unknown>,
    cols: readonly IntrospectedTmpColumn[],
  ): R => {
    const out: Record<string, unknown> = {};
    for (const c of cols) {
      out[c.name] = tmpCol(raw, c.name) ?? null;
    }
    return out as R;
  };

  return {
    table: tableUpper,
    primaryKey: pkUpper,
    historyTable: historyUpper,
    triggerName: triggerUpper,
    setSystemTime,

    async enable(): Promise<TemporalTableInfo> {
      if (pinnedNowMs !== null) {
        await setSystemTime(pinnedNowMs);
      }
      const cols = await getCols();
      if (!cols.some((c) => c.name === pkUpper)) {
        throw new Error(`Primary key column "${pkUpper}" not found on table "${tableUpper}".`);
      }
      await ensureMetaTable();

      const histChk = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [historyUpper],
      );
      const nowSeed = pinnedNowMs ?? Date.now();
      if (Number(tmpCol(histChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
        const colDefs = cols.map((c) => `${qTmpIdent(c.name)} ${c.ddlType}`).join(',\n          ');
        await execTmpSql(
          db,
          `CREATE TABLE ${qTmpIdent(historyUpper)} (
            "HIST_SEQ" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "HIST_OP" VARCHAR(8) NOT NULL,
            "PK_KEY" VARCHAR(256) NOT NULL,
            "SYS_START_MS" BIGINT NOT NULL,
            "SYS_END_MS" BIGINT NOT NULL,
            ${colDefs}
          )`,
        );
        await execTmpSql(
          db,
          `CREATE INDEX ${qTmpIdent(`IDX_${historyUpper}_PK`.slice(0, 31))} ON ${qTmpIdent(historyUpper)} ("PK_KEY", "SYS_START_MS")`,
        );

        // Seed currently existing rows as open intervals [nowSeed, INF)
        const colList = cols.map((c) => qTmpIdent(c.name)).join(', ');
        await execTmpSql(
          db,
          `INSERT INTO ${qTmpIdent(historyUpper)} ("HIST_OP", "PK_KEY", "SYS_START_MS", "SYS_END_MS", ${colList})
           SELECT 'INSERT', CAST(${qTmpIdent(pkUpper)} AS VARCHAR(256)), ?, ${TEMPORAL_INFINITY_MS}, ${colList}
           FROM ${qTmpIdent(tableUpper)}`,
          [nowSeed],
        );
      }

      const colNamesSql = cols.map((c) => qTmpIdent(c.name)).join(', ');
      const newValsSql = cols.map((c) => `NEW.${qTmpIdent(c.name)}`).join(', ');
      const oldValsSql = cols.map((c) => `OLD.${qTmpIdent(c.name)}`).join(', ');

      const triggerDdl = [
        `CREATE OR ALTER TRIGGER ${qTmpIdent(triggerUpper)} FOR ${qTmpIdent(tableUpper)}`,
        `ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 90`,
        `AS`,
        `  DECLARE VARIABLE NOW_MS BIGINT;`,
        `  DECLARE VARIABLE PREV_START BIGINT;`,
        `  DECLARE VARIABLE CTX_RAW VARCHAR(64);`,
        `  DECLARE VARIABLE TARGET_PK VARCHAR(256);`,
        `BEGIN`,
        `  CTX_RAW = RDB$GET_CONTEXT('USER_SESSION', 'FB_TEMPORAL_NOW_MS');`,
        `  IF (CTX_RAW IS NOT NULL AND TRIM(CTX_RAW) <> '') THEN`,
        `    NOW_MS = CAST(TRIM(CTX_RAW) AS BIGINT);`,
        `  ELSE`,
        `    NOW_MS = DATEDIFF(MILLISECOND FROM TIMESTAMP '1970-01-01 00:00:00' TO CAST('NOW' AS TIMESTAMP));`,
        `  TARGET_PK = IIF(DELETING, CAST(OLD.${qTmpIdent(pkUpper)} AS VARCHAR(256)), CAST(NEW.${qTmpIdent(pkUpper)} AS VARCHAR(256)));`,
        `  SELECT MAX("SYS_START_MS") FROM ${qTmpIdent(historyUpper)} WHERE "PK_KEY" = :TARGET_PK INTO :PREV_START;`,
        `  IF (PREV_START IS NOT NULL AND NOW_MS <= PREV_START) THEN`,
        `    NOW_MS = PREV_START + 1;`,
        `  IF (UPDATING OR DELETING) THEN`,
        `  BEGIN`,
        `    UPDATE ${qTmpIdent(historyUpper)}`,
        `       SET "SYS_END_MS" = :NOW_MS`,
        `     WHERE "PK_KEY" = CAST(OLD.${qTmpIdent(pkUpper)} AS VARCHAR(256))`,
        `       AND "SYS_END_MS" = ${TEMPORAL_INFINITY_MS};`,
        `  END`,
        `  IF (INSERTING) THEN`,
        `  BEGIN`,
        `    INSERT INTO ${qTmpIdent(historyUpper)} ("HIST_OP", "PK_KEY", "SYS_START_MS", "SYS_END_MS", ${colNamesSql})`,
        `    VALUES ('INSERT', CAST(NEW.${qTmpIdent(pkUpper)} AS VARCHAR(256)), :NOW_MS, ${TEMPORAL_INFINITY_MS}, ${newValsSql});`,
        `  END`,
        `  ELSE IF (UPDATING) THEN`,
        `  BEGIN`,
        `    INSERT INTO ${qTmpIdent(historyUpper)} ("HIST_OP", "PK_KEY", "SYS_START_MS", "SYS_END_MS", ${colNamesSql})`,
        `    VALUES ('UPDATE', CAST(NEW.${qTmpIdent(pkUpper)} AS VARCHAR(256)), :NOW_MS, ${TEMPORAL_INFINITY_MS}, ${newValsSql});`,
        `  END`,
        `  ELSE IF (DELETING) THEN`,
        `  BEGIN`,
        `    INSERT INTO ${qTmpIdent(historyUpper)} ("HIST_OP", "PK_KEY", "SYS_START_MS", "SYS_END_MS", ${colNamesSql})`,
        `    VALUES ('DELETE', CAST(OLD.${qTmpIdent(pkUpper)} AS VARCHAR(256)), :NOW_MS, :NOW_MS, ${oldValsSql});`,
        `  END`,
        `END`,
      ].join('\n');

      await execTmpSql(db, `SET TERM ^ ;\n${triggerDdl}^\nSET TERM ; ^`);

      const colNames = cols.map((c) => c.name);
      await execTmpSql(
        db,
        `UPDATE OR INSERT INTO ${qTmpIdent(metaUpper)} (
          TABLE_NAME, PRIMARY_KEY, HISTORY_TABLE, TRIGGER_NAME, COLUMNS_JSON, CREATED_AT_MS
        ) VALUES (?, ?, ?, ?, ?, ?) MATCHING (TABLE_NAME)`,
        [tableUpper, pkUpper, historyUpper, triggerUpper, JSON.stringify(colNames), nowSeed],
      );

      const cntRes = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM ${qTmpIdent(historyUpper)}`,
      );
      return {
        tableName: tableUpper,
        primaryKey: pkUpper,
        historyTable: historyUpper,
        triggerName: triggerUpper,
        columns: colNames,
        versionCount: Number(tmpCol(cntRes.rows[0] ?? {}, 'CNT') ?? 0),
        createdAtMs: nowSeed,
      };
    },

    async disable(disOpts = {}): Promise<void> {
      const trgChk = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM RDB$TRIGGERS WHERE TRIM(RDB$TRIGGER_NAME) = ?`,
        [triggerUpper],
      );
      if (Number(tmpCol(trgChk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
        await execTmpSql(db, `DROP TRIGGER ${qTmpIdent(triggerUpper)}`);
      }
      if (disOpts.dropHistory) {
        const hChk = await db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
          [historyUpper],
        );
        if (Number(tmpCol(hChk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
          await execTmpSql(db, `DROP TABLE ${qTmpIdent(historyUpper)}`);
        }
        const mChk = await db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
          [metaUpper],
        );
        if (Number(tmpCol(mChk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
          await execTmpSql(db, `DELETE FROM ${qTmpIdent(metaUpper)} WHERE TABLE_NAME = ?`, [
            tableUpper,
          ]);
        }
      }
    },

    async queryAsOf<R extends Row = T>(
      ts: TemporalTimestampInput,
      qOpts: { where?: string; orderBy?: string; params?: QueryParams } = {},
    ): Promise<R[]> {
      const cols = await getCols();
      const tsMs = parseTemporalTimestampMs(ts);
      const extraWhere = qOpts.where?.trim() ? ` AND (${qOpts.where.trim()})` : '';
      const orderSql = qOpts.orderBy?.trim()
        ? ` ORDER BY ${qOpts.orderBy.trim()}`
        : ` ORDER BY ${qTmpIdent(pkUpper)} ASC`;
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qTmpIdent(historyUpper)}
         WHERE "SYS_START_MS" <= ? AND "SYS_END_MS" > ? AND "HIST_OP" <> 'DELETE'${extraWhere}${orderSql}`,
        [tsMs, tsMs, ...(qOpts.params ?? [])],
      );
      return res.rows.map((r) => stripInternalCols<R>(r, cols));
    },

    async queryBetween<R extends Row = T>(
      startTs: TemporalTimestampInput,
      endTs: TemporalTimestampInput,
      qOpts: { where?: string; params?: QueryParams } = {},
    ) {
      const cols = await getCols();
      const aMs = parseTemporalTimestampMs(startTs);
      const bMs = parseTemporalTimestampMs(endTs);
      const extraWhere = qOpts.where?.trim() ? ` AND (${qOpts.where.trim()})` : '';
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qTmpIdent(historyUpper)}
         WHERE "SYS_START_MS" <= ? AND "SYS_END_MS" > ? AND "HIST_OP" <> 'DELETE'${extraWhere}
         ORDER BY "SYS_START_MS" ASC, "HIST_SEQ" ASC`,
        [bMs, aMs, ...(qOpts.params ?? [])],
      );
      return res.rows.map((r) => ({
        ...stripInternalCols<R>(r, cols),
        SYS_START_MS: Number(tmpCol(r, 'SYS_START_MS') ?? 0),
        SYS_END_MS: Number(tmpCol(r, 'SYS_END_MS') ?? 0),
        HIST_OP: String(tmpCol(r, 'HIST_OP') ?? 'INSERT').trim(),
      }));
    },

    async diffRowHistory(pkValue: string | number): Promise<Array<TemporalHistoryRevision<T>>> {
      const cols = await getCols();
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qTmpIdent(historyUpper)}
         WHERE "PK_KEY" = ?
         ORDER BY "HIST_SEQ" ASC`,
        [String(pkValue)],
      );

      let prevRow: T | null = null;
      return res.rows.map((r) => {
        const op = String(tmpCol(r, 'HIST_OP') ?? 'INSERT').trim() as 'INSERT' | 'UPDATE' | 'DELETE';
        const cleanRow = stripInternalCols<T>(r, cols);
        const changedColumns: string[] = [];
        if (op === 'INSERT' || !prevRow) {
          for (const c of cols) changedColumns.push(c.name);
        } else if (op === 'UPDATE') {
          for (const c of cols) {
            if (cleanRow[c.name] !== prevRow[c.name]) {
              changedColumns.push(c.name);
            }
          }
        }
        prevRow = op === 'DELETE' ? null : cleanRow;
        return {
          seq: Number(tmpCol(r, 'HIST_SEQ') ?? 0),
          op,
          pkKey: String(tmpCol(r, 'PK_KEY') ?? ''),
          sysStartMs: Number(tmpCol(r, 'SYS_START_MS') ?? 0),
          sysEndMs: Number(tmpCol(r, 'SYS_END_MS') ?? 0),
          row: cleanRow,
          changedColumns,
        };
      });
    },

    async revertRowAsOf(pkValue: string | number, ts: TemporalTimestampInput) {
      const cols = await getCols();
      const tsMs = parseTemporalTimestampMs(ts);
      const snapRes = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qTmpIdent(historyUpper)}
         WHERE "PK_KEY" = ? AND "SYS_START_MS" <= ? AND "SYS_END_MS" > ? AND "HIST_OP" <> 'DELETE'
         ORDER BY "HIST_SEQ" DESC`,
        [String(pkValue), tsMs, tsMs],
      );

      if (snapRes.rows.length === 0) {
        const liveChk = await db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT FROM ${qTmpIdent(tableUpper)} WHERE ${qTmpIdent(pkUpper)} = ?`,
          [pkValue],
        );
        if (Number(tmpCol(liveChk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
          await execTmpSql(
            db,
            `DELETE FROM ${qTmpIdent(tableUpper)} WHERE ${qTmpIdent(pkUpper)} = ?`,
            [pkValue],
          );
          return { action: 'deleted' as const, row: null };
        }
        return { action: 'noop' as const, row: null };
      }

      const targetRow = stripInternalCols<T>(snapRes.rows[0]!, cols);
      const colIdents = cols.map((c) => qTmpIdent(c.name)).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const values = cols.map((c) => targetRow[c.name]) as QueryParams;

      await execTmpSql(
        db,
        `UPDATE OR INSERT INTO ${qTmpIdent(tableUpper)} (${colIdents})
         VALUES (${placeholders}) MATCHING (${qTmpIdent(pkUpper)})`,
        values,
      );
      return { action: 'restored' as const, row: targetRow };
    },

    async pruneHistoryBefore(cutoffTs: TemporalTimestampInput): Promise<{ deletedVersions: number }> {
      const cutoffMs = parseTemporalTimestampMs(cutoffTs);
      const cntRes = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM ${qTmpIdent(historyUpper)}
         WHERE "SYS_END_MS" <= ? AND "SYS_END_MS" < ${TEMPORAL_INFINITY_MS}`,
        [cutoffMs],
      );
      const toDelete = Number(tmpCol(cntRes.rows[0] ?? {}, 'CNT') ?? 0);
      if (toDelete > 0) {
        await execTmpSql(
          db,
          `DELETE FROM ${qTmpIdent(historyUpper)}
           WHERE "SYS_END_MS" <= ? AND "SYS_END_MS" < ${TEMPORAL_INFINITY_MS}`,
          [cutoffMs],
        );
      }
      return { deletedVersions: toDelete };
    },
  };
}
