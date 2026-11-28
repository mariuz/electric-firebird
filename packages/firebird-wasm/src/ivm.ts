/**
 * ivm.ts – Algebraic Incremental View Maintenance (`createIncrementalView` —
 * Differential Dataflow `Z-Set` `+1` / `-1` Multiplicity Engine) (`M32 Item 2`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_IVM_VIEWS_TABLE = 'FB_IVM_VIEWS$';
export const DEFAULT_IVM_LOG_TABLE = 'FB_IVM_LOG$';
export const DEFAULT_IVM_SEQ = 'FB_IVM_SEQ$';

export interface IvmDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

/** Weighted `Z-Set` entry (`weight > 0` = insertion multiplicity, `weight < 0` = retraction). */
export interface ZSetEntry<T> {
  readonly key: string;
  readonly row: T;
  readonly weight: number;
}

/** Algebraic `Z-Set` multiset where weights sum and `0`-weight entries cancel (`M32 Item 2`). */
export class ZSet<T extends Row = Row> {
  private readonly entries = new Map<string, { row: T; weight: number }>();

  constructor(initial?: Iterable<ZSetEntry<T>>) {
    if (initial) {
      for (const e of initial) this.add(e.key, e.row, e.weight);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  add(key: string, row: T, weight: number): void {
    if (weight === 0) return;
    const cur = this.entries.get(key);
    const nextW = (cur?.weight ?? 0) + weight;
    if (nextW === 0) {
      this.entries.delete(key);
    } else {
      this.entries.set(key, { row: nextW > 0 ? row : cur?.row ?? row, weight: nextW });
    }
  }

  weightOf(key: string): number {
    return this.entries.get(key)?.weight ?? 0;
  }

  rowOf(key: string): T | undefined {
    return this.entries.get(key)?.row;
  }

  filter(predicate: (row: T) => boolean): ZSet<T> {
    const out = new ZSet<T>();
    for (const [k, v] of this.entries) {
      if (predicate(v.row)) out.add(k, v.row, v.weight);
    }
    return out;
  }

  map<U extends Row>(projectKey: (row: T, srcKey: string) => string, projectRow: (row: T) => U): ZSet<U> {
    const out = new ZSet<U>();
    for (const [k, v] of this.entries) {
      out.add(projectKey(v.row, k), projectRow(v.row), v.weight);
    }
    return out;
  }

  distinct(): ZSet<T> {
    const out = new ZSet<T>();
    for (const [k, v] of this.entries) {
      if (v.weight > 0) out.add(k, v.row, 1);
    }
    return out;
  }

  toArray(): ZSetEntry<T>[] {
    const arr: ZSetEntry<T>[] = [];
    for (const [key, v] of this.entries) {
      arr.push({ key, row: v.row, weight: v.weight });
    }
    return arr;
  }

  positiveRows(): T[] {
    const rows: T[] = [];
    for (const v of this.entries.values()) {
      if (v.weight > 0) rows.push(v.row);
    }
    return rows;
  }
}

export type IvmAggregateOp = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export interface IvmAggregateSpec {
  readonly alias: string;
  readonly op: IvmAggregateOp;
  readonly column?: string;
}

export interface IvmJoinSpec {
  readonly table: string;
  readonly rightPrimaryKey?: string;
  readonly leftKey: string;
  readonly rightKey: string;
  readonly type?: 'inner' | 'left';
  /** Right-table columns to include (`{ rightCol: 'OUT_ALIAS' }` or `['NAME', 'TIER']`). */
  readonly selectColumns?: readonly string[] | Readonly<Record<string, string>>;
}

export interface IvmColumnDef {
  readonly name: string;
  readonly sqlType: string;
}

export interface CreateIncrementalViewOptions {
  /** Logical view name persisted in `FB_IVM_VIEWS$`. */
  readonly name: string;
  /** Materialized destination Firebird table name (defaults to `IVM_<NAME>`). */
  readonly viewTable?: string;
  /** Primary base table name. */
  readonly sourceTable: string;
  /** Primary key column on `sourceTable`. @default 'ID' */
  readonly sourceKey?: string;
  /** Optional row filter predicate evaluated on base rows (`FILTER` operator). */
  readonly filter?: (row: Row) => boolean;
  /** Optional projected base columns (`PROJECT` operator). */
  readonly selectColumns?: readonly string[];
  /** Optional incremental equi-join (`INNER` or `LEFT JOIN` operator). */
  readonly join?: IvmJoinSpec;
  /** Optional `GROUP BY` columns + incremental aggregates (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`). */
  readonly groupBy?: {
    readonly columns: readonly string[];
    readonly aggregates: readonly IvmAggregateSpec[];
  };
  /** Deduplicate output rows by projected key (`DISTINCT` operator). @default false */
  readonly distinct?: boolean;
  /** Explicit output table schema (`CREATE TABLE <viewTable> (...)`). Inferred if omitted. */
  readonly outputColumns?: readonly IvmColumnDef[];
  /** Install PSQL change-capture triggers on `sourceTable` (and `join.table`) for `syncDeltas()`. @default false */
  readonly installTriggers?: boolean;
  /** Metadata catalog table name. @default 'FB_IVM_VIEWS$' */
  readonly metaTable?: string;
}

export interface IvmRowMutation {
  readonly table?: string;
  readonly op: 'insert' | 'update' | 'delete';
  readonly oldRow?: Row;
  readonly newRow?: Row;
}

export interface IncrementalViewInfo {
  readonly name: string;
  readonly viewTable: string;
  readonly sourceTable: string;
  readonly joinTable: string | null;
  readonly operators: string;
  readonly rowCount: number;
  readonly deltaAppliedCount: number;
  readonly updatedAtMs: number;
}

export interface IvmApplyResult {
  readonly viewUpserts: number;
  readonly viewDeletes: number;
  readonly deltaInputCount: number;
  readonly rowCount: number;
}

export interface IncrementalViewHandle<T extends Row = Row> {
  readonly name: string;
  readonly viewTable: string;
  readonly sourceTable: string;
  /** Apply explicit row mutations in `O(Δ)` without scanning base tables. */
  applyDelta(mutations: readonly IvmRowMutation[]): Promise<IvmApplyResult>;
  /** Drain PSQL trigger-captured mutations (`FB_IVM_LOG$`) in `O(Δ)` without scanning base tables. */
  syncDeltas(): Promise<IvmApplyResult>;
  /** Query the pre-computed materialized view table in Firebird. */
  queryView(orderBy?: string): Promise<T[]>;
  /** Return current view metadata summary. */
  info(): IncrementalViewInfo;
  dispose(): Promise<void>;
}

function qIvm(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function ivmCol(row: Record<string, unknown>, col: string): unknown {
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

function normalizeUpperRow(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.toUpperCase()] = v;
  }
  return out;
}

async function execIvmSql(
  db: IvmDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

async function execIvmTrigger(db: IvmDatabaseExecutor, ddl: string): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(`SET TERM ^ ;\n${ddl}^\nSET TERM ; ^`);
  } else if (typeof db.execute === 'function') {
    await db.execute(ddl);
  } else {
    await db.query(ddl);
  }
}

function inferSqlType(val: unknown): string {
  if (typeof val === 'number') {
    return Number.isInteger(val) ? 'BIGINT' : 'DOUBLE PRECISION';
  }
  if (typeof val === 'boolean') return 'BOOLEAN';
  return 'VARCHAR(512)';
}

interface GroupAccumulator {
  count: number;
  colCounts: Map<string, number>;
  colSums: Map<string, number>;
  /** Sorted numeric/string multisets for exact O(log n) `MIN` / `MAX` under retractions (`-1`). */
  colValues: Map<string, Array<number | string>>;
  groupCols: Record<string, unknown>;
}

function insertOrdered(arr: Array<number | string>, val: number | string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < val) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, val);
}

function removeOrdered(arr: Array<number | string>, val: number | string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < val) lo = mid + 1;
    else hi = mid;
  }
  if (lo < arr.length && arr[lo] === val) {
    arr.splice(lo, 1);
  }
}

async function buildIvmCaptureTrigger(
  db: IvmDatabaseExecutor,
  tableUpper: string,
): Promise<string> {
  const colsRes = await db.query<Record<string, unknown>>(
    `SELECT TRIM(rf.RDB$FIELD_NAME) AS FNAME, f.RDB$FIELD_TYPE AS FTYPE
       FROM RDB$RELATION_FIELDS rf
       JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
      WHERE TRIM(rf.RDB$RELATION_NAME) = ? AND f.RDB$COMPUTED_BLR IS NULL
      ORDER BY rf.RDB$FIELD_POSITION`,
    [tableUpper],
  );
  const cols = colsRes.rows.map((r) => ({
    name: String(ivmCol(r, 'FNAME') ?? '').trim(),
    ftype: Number(ivmCol(r, 'FTYPE') ?? 37),
  }));

  const rowExpr = (ref: 'OLD' | 'NEW') => {
    const parts = cols.map((c) => {
      const colRef = `${ref}.${qIvm(c.name)}`;
      const isNum = [7, 8, 10, 16, 27].includes(c.ftype);
      const valSql = isNum
        ? `CASE WHEN ${colRef} IS NULL THEN 'null' ELSE TRIM(CAST(${colRef} AS VARCHAR(64))) END`
        : c.ftype === 23
          ? `CASE WHEN ${colRef} IS NULL THEN 'null' WHEN ${colRef} THEN 'true' ELSE 'false' END`
          : `CASE WHEN ${colRef} IS NULL THEN 'null' ELSE '"' || REPLACE(REPLACE(CAST(${colRef} AS BLOB SUB_TYPE TEXT), '\\', '\\\\'), '"', '\\"') || '"' END`;
      return `'"${c.name}":' || ${valSql}`;
    });
    return `CAST('{' AS BLOB SUB_TYPE TEXT) || ${parts.join(` || ',' || `)} || '}'`;
  };

  let h = 0x811c9dc5;
  for (let i = 0; i < tableUpper.length; i++) {
    h ^= tableUpper.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const trigName = `FB_IVM_TRG$${h.toString(16).padStart(8, '0').toUpperCase()}`;

  return [
    `CREATE OR ALTER TRIGGER "${trigName}" FOR ${qIvm(tableUpper)}`,
    `ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 32755`,
    `AS`,
    `BEGIN`,
    `  IF (INSERTING) THEN`,
    `    INSERT INTO "${DEFAULT_IVM_LOG_TABLE}" ("SEQ", "TABLE_NAME", "OP", "OLD_JSON", "NEW_JSON")`,
    `    VALUES (GEN_ID("${DEFAULT_IVM_SEQ}", 1), '${tableUpper}', 'I', NULL, ${rowExpr('NEW')});`,
    `  ELSE IF (UPDATING) THEN`,
    `    INSERT INTO "${DEFAULT_IVM_LOG_TABLE}" ("SEQ", "TABLE_NAME", "OP", "OLD_JSON", "NEW_JSON")`,
    `    VALUES (GEN_ID("${DEFAULT_IVM_SEQ}", 1), '${tableUpper}', 'U', ${rowExpr('OLD')}, ${rowExpr('NEW')});`,
    `  ELSE IF (DELETING) THEN`,
    `    INSERT INTO "${DEFAULT_IVM_LOG_TABLE}" ("SEQ", "TABLE_NAME", "OP", "OLD_JSON", "NEW_JSON")`,
    `    VALUES (GEN_ID("${DEFAULT_IVM_SEQ}", 1), '${tableUpper}', 'D', ${rowExpr('OLD')}, NULL);`,
    `END`,
  ].join('\n');
}

/** Read persisted `FB_IVM_VIEWS$` metadata without mutating schema (`M32 Item 5`). */
export async function fetchPersistedIncrementalViews(
  db: IvmDatabaseExecutor,
  metaTable = DEFAULT_IVM_VIEWS_TABLE,
): Promise<IncrementalViewInfo[]> {
  const metaUpper = metaTable.trim().toUpperCase();
  const chk = await db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [metaUpper],
  );
  if (Number(ivmCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];
  const res = await db.query<Record<string, unknown>>(
    `SELECT "VIEW_NAME", "VIEW_TABLE", "SOURCE_TABLE", "JOIN_TABLE", "OPERATORS", "ROW_COUNT", "DELTA_COUNT", "UPDATED_AT_MS"
       FROM ${qIvm(metaUpper)} ORDER BY "VIEW_NAME" ASC`,
  );
  return res.rows.map((r) => ({
    name: String(ivmCol(r, 'VIEW_NAME') ?? '').trim(),
    viewTable: String(ivmCol(r, 'VIEW_TABLE') ?? '').trim(),
    sourceTable: String(ivmCol(r, 'SOURCE_TABLE') ?? '').trim(),
    joinTable: ivmCol(r, 'JOIN_TABLE') ? String(ivmCol(r, 'JOIN_TABLE')).trim() : null,
    operators: String(ivmCol(r, 'OPERATORS') ?? '').trim(),
    rowCount: Number(ivmCol(r, 'ROW_COUNT') ?? 0),
    deltaAppliedCount: Number(ivmCol(r, 'DELTA_COUNT') ?? 0),
    updatedAtMs: Number(ivmCol(r, 'UPDATED_AT_MS') ?? 0),
  }));
}

/**
 * Create an algebraic `Z-Set` Incremental View (`createIncrementalView`) that maintains
 * pre-joined / pre-aggregated Firebird view tables in `O(Δ)` per row mutation (`M32 Item 2`).
 */
export async function createIncrementalView<T extends Row = Row>(
  db: IvmDatabaseExecutor,
  options: CreateIncrementalViewOptions,
): Promise<IncrementalViewHandle<T>> {
  const viewName = options.name.trim();
  const viewTableUpper = (options.viewTable ?? `IVM_${viewName}`).trim().toUpperCase();
  const srcTableUpper = options.sourceTable.trim().toUpperCase();
  const srcKeyUpper = (options.sourceKey ?? 'ID').trim().toUpperCase();
  const joinSpec = options.join;
  const joinTableUpper = joinSpec ? joinSpec.table.trim().toUpperCase() : null;
  const joinRightPkUpper = joinSpec ? (joinSpec.rightPrimaryKey ?? joinSpec.rightKey).trim().toUpperCase() : null;
  const joinLeftKeyUpper = joinSpec ? joinSpec.leftKey.trim().toUpperCase() : null;
  const joinRightKeyUpper = joinSpec ? joinSpec.rightKey.trim().toUpperCase() : null;
  const joinType = joinSpec?.type ?? 'inner';
  const metaUpper = (options.metaTable ?? DEFAULT_IVM_VIEWS_TABLE).trim().toUpperCase();

  const opLabels: string[] = [];
  if (options.filter) opLabels.push('FILTER');
  if (options.selectColumns) opLabels.push('PROJECT');
  if (joinSpec) opLabels.push(`${joinType.toUpperCase()}_JOIN`);
  if (options.groupBy) opLabels.push('GROUP_BY');
  if (options.distinct) opLabels.push('DISTINCT');
  if (opLabels.length === 0) opLabels.push('SCAN');
  const operatorsStr = opLabels.join(' -> ');

  // Hash indexes for O(1) incremental join probing (`leftByJoinKey` & `rightByJoinKey`)
  const leftByPk = new Map<string, Record<string, unknown>>();
  const leftByJoinKey = new Map<string, Map<string, Record<string, unknown>>>();
  const rightByPk = new Map<string, Record<string, unknown>>();
  const rightByJoinKey = new Map<string, Map<string, Record<string, unknown>>>();

  // Pre-group Z-Set (`joinedZSet`) + post-group accumulators + materialized output map
  const joinedZSet = new ZSet<Record<string, unknown>>();
  const groups = new Map<string, GroupAccumulator>();
  const materializedRows = new Map<string, Record<string, unknown>>();
  let outPkCol = 'IVM_KEY';
  let outColumns: IvmColumnDef[] = options.outputColumns ? [...options.outputColumns] : [];
  let viewTableCreated = false;
  let lastDrainedSeq = 0;
  let totalDeltasApplied = 0;
  let updatedAtMs = Date.now();

  const indexSetPut = (
    byJoinKey: Map<string, Map<string, Record<string, unknown>>>,
    jk: string,
    pk: string,
    row: Record<string, unknown>,
  ) => {
    let bucket = byJoinKey.get(jk);
    if (!bucket) {
      bucket = new Map();
      byJoinKey.set(jk, bucket);
    }
    bucket.set(pk, row);
  };

  const indexSetDel = (
    byJoinKey: Map<string, Map<string, Record<string, unknown>>>,
    jk: string,
    pk: string,
  ) => {
    const bucket = byJoinKey.get(jk);
    if (!bucket) return;
    bucket.delete(pk);
    if (bucket.size === 0) byJoinKey.delete(jk);
  };

  const projectJoinedTuple = (
    lRow: Record<string, unknown>,
    rRow: Record<string, unknown> | null,
  ): Record<string, unknown> => {
    const baseCols = options.selectColumns
      ? options.selectColumns.map((c) => c.toUpperCase())
      : Object.keys(lRow);
    const out: Record<string, unknown> = {};
    for (const c of baseCols) {
      out[c] = lRow[c] ?? null;
    }
    if (joinSpec) {
      if (Array.isArray(joinSpec.selectColumns)) {
        for (const rc of joinSpec.selectColumns) {
          const ru = rc.toUpperCase();
          const outName = ru in out ? `${joinTableUpper}_${ru}` : ru;
          out[outName] = rRow ? (rRow[ru] ?? null) : null;
        }
      } else if (joinSpec.selectColumns) {
        for (const [rc, alias] of Object.entries(joinSpec.selectColumns)) {
          out[alias.toUpperCase()] = rRow ? (rRow[rc.toUpperCase()] ?? null) : null;
        }
      }
    }
    return out;
  };

  const tupleKeyForNonGrouped = (tuple: Record<string, unknown>, fallbackId: string): string => {
    if (options.distinct) {
      return JSON.stringify(Object.entries(tuple).sort(([a], [b]) => a.localeCompare(b)));
    }
    return fallbackId;
  };

  const ensureMetaCatalog = async (): Promise<void> => {
    const chk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [metaUpper],
    );
    if (Number(ivmCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execIvmSql(
        db,
        `CREATE TABLE ${qIvm(metaUpper)} (
          "VIEW_NAME" VARCHAR(128) NOT NULL PRIMARY KEY,
          "VIEW_TABLE" VARCHAR(64) NOT NULL,
          "SOURCE_TABLE" VARCHAR(64) NOT NULL,
          "JOIN_TABLE" VARCHAR(64),
          "OPERATORS" VARCHAR(256) NOT NULL,
          "ROW_COUNT" INTEGER NOT NULL,
          "DELTA_COUNT" INTEGER NOT NULL,
          "UPDATED_AT_MS" BIGINT NOT NULL
        )`,
      );
    }
  };

  const persistMeta = async (): Promise<void> => {
    updatedAtMs = Date.now();
    await ensureMetaCatalog();
    await execIvmSql(
      db,
      `UPDATE OR INSERT INTO ${qIvm(metaUpper)} (
        "VIEW_NAME", "VIEW_TABLE", "SOURCE_TABLE", "JOIN_TABLE", "OPERATORS",
        "ROW_COUNT", "DELTA_COUNT", "UPDATED_AT_MS"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) MATCHING ("VIEW_NAME")`,
      [
        viewName,
        viewTableUpper,
        srcTableUpper,
        joinTableUpper,
        operatorsStr,
        materializedRows.size,
        totalDeltasApplied,
        updatedAtMs,
      ],
    );
  };

  const ensureViewTable = async (sampleRow?: Record<string, unknown>): Promise<void> => {
    if (viewTableCreated) return;
    const chk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [viewTableUpper],
    );
    if (Number(ivmCol(chk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
      viewTableCreated = true;
      if (outColumns.length === 0 && sampleRow) {
        outColumns = Object.entries(sampleRow).map(([k, v]) => ({
          name: k.toUpperCase(),
          sqlType: inferSqlType(v),
        }));
      }
      return;
    }

    if (outColumns.length === 0) {
      if (options.groupBy) {
        const gCols = options.groupBy.columns.map((c) => ({
          name: c.toUpperCase(),
          sqlType: sampleRow ? inferSqlType(sampleRow[c.toUpperCase()]) : 'VARCHAR(256)',
        }));
        const aCols = options.groupBy.aggregates.map((a) => ({
          name: a.alias.toUpperCase(),
          sqlType:
            a.op === 'COUNT'
              ? 'BIGINT'
              : a.op === 'AVG'
                ? 'DOUBLE PRECISION'
                : sampleRow
                  ? inferSqlType(sampleRow[a.alias.toUpperCase()])
                  : 'DOUBLE PRECISION',
        }));
        outColumns = [{ name: 'IVM_KEY', sqlType: 'VARCHAR(256)' }, ...gCols, ...aCols];
        outPkCol = 'IVM_KEY';
      } else if (sampleRow) {
        outColumns = [
          { name: 'IVM_KEY', sqlType: 'VARCHAR(256)' },
          ...Object.entries(sampleRow).map(([k, v]) => ({
            name: k.toUpperCase(),
            sqlType: inferSqlType(v),
          })),
        ];
        outPkCol = 'IVM_KEY';
      } else {
        // Empty initial table — defer DDL until first tuple arrives, or create minimal key table
        return;
      }
    } else {
      outPkCol = outColumns[0]!.name.toUpperCase();
    }

    const ddlCols = outColumns
      .map((c, idx) =>
        idx === 0 && c.name.toUpperCase() === outPkCol
          ? `${qIvm(c.name.toUpperCase())} ${c.sqlType} NOT NULL PRIMARY KEY`
          : `${qIvm(c.name.toUpperCase())} ${c.sqlType}`,
      )
      .join(', ');
    await execIvmSql(db, `CREATE TABLE ${qIvm(viewTableUpper)} (${ddlCols})`);
    viewTableCreated = true;
  };

  const flushViewDiff = async (
    upserts: Map<string, Record<string, unknown>>,
    deletes: Set<string>,
  ): Promise<{ viewUpserts: number; viewDeletes: number }> => {
    let uCount = 0;
    let dCount = 0;

    for (const delKey of deletes) {
      materializedRows.delete(delKey);
      if (viewTableCreated) {
        await execIvmSql(
          db,
          `DELETE FROM ${qIvm(viewTableUpper)} WHERE ${qIvm(outPkCol)} = ?`,
          [delKey],
        );
        dCount++;
      }
    }

    for (const [k, row] of upserts) {
      materializedRows.set(k, row);
      await ensureViewTable(row);
      if (viewTableCreated) {
        const hasSyntheticPk = outPkCol === 'IVM_KEY' && !('IVM_KEY' in row);
        const writeObj: Record<string, unknown> = hasSyntheticPk ? { IVM_KEY: k, ...row } : row;
        const cols = outColumns.map((c) => c.name.toUpperCase());
        const quotedCols = cols.map((c) => qIvm(c)).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const vals = cols.map((c) => writeObj[c] ?? null);
        await execIvmSql(
          db,
          `UPDATE OR INSERT INTO ${qIvm(viewTableUpper)} (${quotedCols}) VALUES (${placeholders}) MATCHING (${qIvm(outPkCol)})`,
          vals,
        );
        uCount++;
      }
    }
    return { viewUpserts: uCount, viewDeletes: dCount };
  };

  const applyJoinedZDelta = (
    zDelta: ZSet<Record<string, unknown>>,
    dirtyUpserts: Map<string, Record<string, unknown>>,
    dirtyDeletes: Set<string>,
  ): void => {
    if (!options.groupBy) {
      for (const entry of zDelta.toArray()) {
        const prevWeight = joinedZSet.weightOf(entry.key);
        joinedZSet.add(entry.key, entry.row, entry.weight);
        const nextWeight = joinedZSet.weightOf(entry.key);
        if (nextWeight > 0) {
          if (prevWeight <= 0 || entry.weight > 0) {
            dirtyDeletes.delete(entry.key);
            dirtyUpserts.set(entry.key, joinedZSet.rowOf(entry.key)!);
          }
        } else if (prevWeight > 0 && nextWeight <= 0) {
          dirtyUpserts.delete(entry.key);
          dirtyDeletes.add(entry.key);
        }
      }
      return;
    }

    // Incremental GROUP BY (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`) over Z-Set multiplicities
    const aggSpecs: readonly IvmAggregateSpec[] = options.groupBy.aggregates;
    const gColsUpper = options.groupBy.columns.map((c) => c.toUpperCase());
    const touchedGroups = new Set<string>();

    for (const entry of zDelta.toArray()) {
      const sign = entry.weight > 0 ? 1 : -1;
      const steps = Math.abs(entry.weight);
      const gKeyParts = gColsUpper.map((c) => String(entry.row[c] ?? 'NULL'));
      const gKey = gKeyParts.join('|');
      touchedGroups.add(gKey);

      let acc = groups.get(gKey);
      if (!acc) {
        const gc: Record<string, unknown> = {};
        for (const c of gColsUpper) gc[c] = entry.row[c] ?? null;
        acc = {
          count: 0,
          colCounts: new Map(),
          colSums: new Map(),
          colValues: new Map(),
          groupCols: gc,
        };
        groups.set(gKey, acc);
      }

      for (let s = 0; s < steps; s++) {
        acc.count += sign;
        const seenCols = new Set<string>();
        const seenOrdCols = new Set<string>();
        for (const spec of aggSpecs) {
          if (!spec.column) continue;
          const cu = spec.column.toUpperCase();
          const rawVal = entry.row[cu];
          if (rawVal === null || rawVal === undefined) continue;
          const numVal = Number(rawVal);
          if (!seenCols.has(cu)) {
            seenCols.add(cu);
            acc.colCounts.set(cu, (acc.colCounts.get(cu) ?? 0) + sign);
            if (!Number.isNaN(numVal)) {
              acc.colSums.set(cu, (acc.colSums.get(cu) ?? 0) + sign * numVal);
            }
          }
          if ((spec.op === 'MIN' || spec.op === 'MAX') && !seenOrdCols.has(cu)) {
            seenOrdCols.add(cu);
            let ordArr = acc.colValues.get(cu);
            if (!ordArr) {
              ordArr = [];
              acc.colValues.set(cu, ordArr);
            }
            const comparable = !Number.isNaN(numVal) && typeof rawVal !== 'boolean' ? numVal : String(rawVal);
            if (sign > 0) insertOrdered(ordArr, comparable);
            else removeOrdered(ordArr, comparable);
          }
        }
      }
    }

    for (const gKey of touchedGroups) {
      const acc = groups.get(gKey);
      if (!acc || acc.count <= 0) {
        groups.delete(gKey);
        dirtyUpserts.delete(gKey);
        dirtyDeletes.add(gKey);
        continue;
      }
      const outRow: Record<string, unknown> = { ...acc.groupCols };
      for (const spec of aggSpecs) {
        const aliasU = spec.alias.toUpperCase();
        const cu = spec.column?.toUpperCase() ?? '';
        switch (spec.op) {
          case 'COUNT':
            outRow[aliasU] = spec.column ? (acc.colCounts.get(cu) ?? 0) : acc.count;
            break;
          case 'SUM':
            outRow[aliasU] = (acc.colCounts.get(cu) ?? 0) > 0 ? (acc.colSums.get(cu) ?? 0) : null;
            break;
          case 'AVG': {
            const cnt = acc.colCounts.get(cu) ?? 0;
            outRow[aliasU] = cnt > 0 ? (acc.colSums.get(cu) ?? 0) / cnt : null;
            break;
          }
          case 'MIN': {
            const arr = acc.colValues.get(cu) ?? [];
            outRow[aliasU] = arr.length > 0 ? arr[0]! : null;
            break;
          }
          case 'MAX': {
            const arr = acc.colValues.get(cu) ?? [];
            outRow[aliasU] = arr.length > 0 ? arr[arr.length - 1]! : null;
            break;
          }
        }
      }
      dirtyDeletes.delete(gKey);
      dirtyUpserts.set(gKey, outRow);
    }
  };

  const emitLeftRowWeight = (
    lPk: string,
    lRow: Record<string, unknown>,
    weight: 1 | -1,
    zDelta: ZSet<Record<string, unknown>>,
  ): void => {
    if (options.filter && !options.filter(lRow)) return;
    if (!joinSpec) {
      const proj = projectJoinedTuple(lRow, null);
      zDelta.add(tupleKeyForNonGrouped(proj, lPk), proj, weight);
      return;
    }
    const jkVal = lRow[joinLeftKeyUpper!];
    const rMatches =
      jkVal !== null && jkVal !== undefined ? rightByJoinKey.get(String(jkVal)) : undefined;
    if (rMatches && rMatches.size > 0) {
      for (const [rPk, rRow] of rMatches) {
        const proj = projectJoinedTuple(lRow, rRow);
        zDelta.add(tupleKeyForNonGrouped(proj, `${lPk}::${rPk}`), proj, weight);
      }
    } else if (joinType === 'left') {
      const proj = projectJoinedTuple(lRow, null);
      zDelta.add(tupleKeyForNonGrouped(proj, `${lPk}::$null`), proj, weight);
    }
  };

  const applyDelta = async (mutations: readonly IvmRowMutation[]): Promise<IvmApplyResult> => {
    const zDelta = new ZSet<Record<string, unknown>>();
    let deltaCount = 0;

    for (const m of mutations) {
      const targetTable = (m.table ?? srcTableUpper).trim().toUpperCase();
      if (targetTable === srcTableUpper) {
        deltaCount++;
        if ((m.op === 'delete' || m.op === 'update') && m.oldRow) {
          const oldNorm = normalizeUpperRow(m.oldRow);
          const lPk = String(oldNorm[srcKeyUpper] ?? '');
          const storedOld = leftByPk.get(lPk) ?? oldNorm;
          leftByPk.delete(lPk);
          if (joinSpec) {
            const jk = storedOld[joinLeftKeyUpper!];
            if (jk !== null && jk !== undefined) indexSetDel(leftByJoinKey, String(jk), lPk);
          }
          emitLeftRowWeight(lPk, storedOld, -1, zDelta);
        }
        if ((m.op === 'insert' || m.op === 'update') && m.newRow) {
          const newNorm = normalizeUpperRow(m.newRow);
          const lPk = String(newNorm[srcKeyUpper] ?? '');
          leftByPk.set(lPk, newNorm);
          if (joinSpec) {
            const jk = newNorm[joinLeftKeyUpper!];
            if (jk !== null && jk !== undefined) indexSetPut(leftByJoinKey, String(jk), lPk, newNorm);
          }
          emitLeftRowWeight(lPk, newNorm, 1, zDelta);
        }
      } else if (joinTableUpper && targetTable === joinTableUpper) {
        deltaCount++;
        if ((m.op === 'delete' || m.op === 'update') && m.oldRow) {
          const oldR = normalizeUpperRow(m.oldRow);
          const rPk = String(oldR[joinRightPkUpper!] ?? '');
          const storedOldR = rightByPk.get(rPk) ?? oldR;
          rightByPk.delete(rPk);
          const rJk = storedOldR[joinRightKeyUpper!];
          if (rJk !== null && rJk !== undefined) {
            const jkStr = String(rJk);
            indexSetDel(rightByJoinKey, jkStr, rPk);
            const matchingLefts = leftByJoinKey.get(jkStr);
            if (matchingLefts) {
              const remainingRights = rightByJoinKey.get(jkStr);
              for (const [lPk, lRow] of matchingLefts) {
                if (options.filter && !options.filter(lRow)) continue;
                const oldProj = projectJoinedTuple(lRow, storedOldR);
                zDelta.add(tupleKeyForNonGrouped(oldProj, `${lPk}::${rPk}`), oldProj, -1);
                if (joinType === 'left' && (!remainingRights || remainingRights.size === 0)) {
                  const nullProj = projectJoinedTuple(lRow, null);
                  zDelta.add(tupleKeyForNonGrouped(nullProj, `${lPk}::$null`), nullProj, 1);
                }
              }
            }
          }
        }
        if ((m.op === 'insert' || m.op === 'update') && m.newRow) {
          const newR = normalizeUpperRow(m.newRow);
          const rPk = String(newR[joinRightPkUpper!] ?? '');
          rightByPk.set(rPk, newR);
          const rJk = newR[joinRightKeyUpper!];
          if (rJk !== null && rJk !== undefined) {
            const jkStr = String(rJk);
            const hadAnyRightBefore = (rightByJoinKey.get(jkStr)?.size ?? 0) > 0;
            indexSetPut(rightByJoinKey, jkStr, rPk, newR);
            const matchingLefts = leftByJoinKey.get(jkStr);
            if (matchingLefts) {
              for (const [lPk, lRow] of matchingLefts) {
                if (options.filter && !options.filter(lRow)) continue;
                if (joinType === 'left' && !hadAnyRightBefore) {
                  const nullProj = projectJoinedTuple(lRow, null);
                  zDelta.add(tupleKeyForNonGrouped(nullProj, `${lPk}::$null`), nullProj, -1);
                }
                const newProj = projectJoinedTuple(lRow, newR);
                zDelta.add(tupleKeyForNonGrouped(newProj, `${lPk}::${rPk}`), newProj, 1);
              }
            }
          }
        }
      }
    }

    const dirtyUpserts = new Map<string, Record<string, unknown>>();
    const dirtyDeletes = new Set<string>();
    applyJoinedZDelta(zDelta, dirtyUpserts, dirtyDeletes);

    const ioRes = await flushViewDiff(dirtyUpserts, dirtyDeletes);
    totalDeltasApplied += deltaCount;
    await persistMeta();
    return {
      ...ioRes,
      deltaInputCount: deltaCount,
      rowCount: materializedRows.size,
    };
  };

  // Initial hydration from base table(s)
  const initialMuts: IvmRowMutation[] = [];
  if (joinTableUpper) {
    const rRes = await db.query<Row>(`SELECT * FROM ${qIvm(joinTableUpper)}`);
    for (const r of rRes.rows) {
      initialMuts.push({ table: joinTableUpper, op: 'insert', newRow: r });
    }
  }
  const lRes = await db.query<Row>(`SELECT * FROM ${qIvm(srcTableUpper)}`);
  for (const r of lRes.rows) {
    initialMuts.push({ table: srcTableUpper, op: 'insert', newRow: r });
  }
  if (initialMuts.length > 0) {
    await applyDelta(initialMuts);
    totalDeltasApplied = 0; // Reset counter after initial bootstrap so deltaAppliedCount tracks incremental updates
    await persistMeta();
  } else {
    await ensureViewTable();
    await persistMeta();
  }

  // Optional PSQL change-capture triggers for raw SQL mutations (`syncDeltas()`)
  if (options.installTriggers) {
    const seqChk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$GENERATORS WHERE TRIM(RDB$GENERATOR_NAME) = ?',
      [DEFAULT_IVM_SEQ],
    );
    if (Number(ivmCol(seqChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execIvmSql(db, `CREATE SEQUENCE "${DEFAULT_IVM_SEQ}"`);
    }
    const logChk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [DEFAULT_IVM_LOG_TABLE],
    );
    if (Number(ivmCol(logChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execIvmSql(
        db,
        `CREATE TABLE "${DEFAULT_IVM_LOG_TABLE}" (
          "SEQ" BIGINT NOT NULL PRIMARY KEY,
          "TABLE_NAME" VARCHAR(64) NOT NULL,
          "OP" CHAR(1) NOT NULL,
          "OLD_JSON" BLOB SUB_TYPE TEXT,
          "NEW_JSON" BLOB SUB_TYPE TEXT
        )`,
      );
    }
    const headRes = await db.query<Record<string, unknown>>(
      `SELECT COALESCE(MAX("SEQ"), 0) AS HEAD_SEQ FROM "${DEFAULT_IVM_LOG_TABLE}"`,
    );
    lastDrainedSeq = Number(ivmCol(headRes.rows[0] ?? {}, 'HEAD_SEQ') ?? 0);

    await execIvmTrigger(db, await buildIvmCaptureTrigger(db, srcTableUpper));
    if (joinTableUpper && joinTableUpper !== srcTableUpper) {
      await execIvmTrigger(db, await buildIvmCaptureTrigger(db, joinTableUpper));
    }
  }

  return {
    name: viewName,
    viewTable: viewTableUpper,
    sourceTable: srcTableUpper,
    applyDelta,
    async syncDeltas(): Promise<IvmApplyResult> {
      const logChk = await db.query<Record<string, unknown>>(
        'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
        [DEFAULT_IVM_LOG_TABLE],
      );
      if (Number(ivmCol(logChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
        return { viewUpserts: 0, viewDeletes: 0, deltaInputCount: 0, rowCount: materializedRows.size };
      }
      const tables = joinTableUpper ? [srcTableUpper, joinTableUpper] : [srcTableUpper];
      const inPlaceholders = tables.map(() => '?').join(', ');
      const logRes = await db.query<Record<string, unknown>>(
        `SELECT "SEQ", TRIM("TABLE_NAME") AS TNAME, TRIM("OP") AS OP_CODE, "OLD_JSON", "NEW_JSON"
           FROM "${DEFAULT_IVM_LOG_TABLE}"
          WHERE "SEQ" > ? AND TRIM("TABLE_NAME") IN (${inPlaceholders})
          ORDER BY "SEQ" ASC`,
        [lastDrainedSeq, ...tables],
      );
      if (logRes.rows.length === 0) {
        return { viewUpserts: 0, viewDeletes: 0, deltaInputCount: 0, rowCount: materializedRows.size };
      }
      const muts: IvmRowMutation[] = [];
      for (const r of logRes.rows) {
        const seq = Number(ivmCol(r, 'SEQ') ?? 0);
        if (seq > lastDrainedSeq) lastDrainedSeq = seq;
        const opCode = String(ivmCol(r, 'OP_CODE') ?? 'I').trim();
        const oldRaw = ivmCol(r, 'OLD_JSON');
        const newRaw = ivmCol(r, 'NEW_JSON');
        muts.push({
          table: String(ivmCol(r, 'TNAME') ?? srcTableUpper),
          op: opCode === 'D' ? 'delete' : opCode === 'U' ? 'update' : 'insert',
          oldRow: typeof oldRaw === 'string' && oldRaw ? (JSON.parse(oldRaw) as Row) : undefined,
          newRow: typeof newRaw === 'string' && newRaw ? (JSON.parse(newRaw) as Row) : undefined,
        });
      }
      return applyDelta(muts);
    },
    async queryView(orderBy?: string): Promise<T[]> {
      if (!viewTableCreated) return [];
      const orderSql = orderBy ? ` ORDER BY ${orderBy}` : '';
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qIvm(viewTableUpper)}${orderSql}`,
      );
      return res.rows.map((r) => {
        const copy = { ...r };
        if (outPkCol === 'IVM_KEY' && !options.outputColumns) {
          delete copy['IVM_KEY'];
          delete copy['ivm_key'];
        }
        return copy as T;
      });
    },
    info(): IncrementalViewInfo {
      return {
        name: viewName,
        viewTable: viewTableUpper,
        sourceTable: srcTableUpper,
        joinTable: joinTableUpper,
        operators: operatorsStr,
        rowCount: materializedRows.size,
        deltaAppliedCount: totalDeltasApplied,
        updatedAtMs,
      };
    },
    async dispose(): Promise<void> {
      // Metadata & materialized table remain persisted unless dropped by user
    },
  };
}
