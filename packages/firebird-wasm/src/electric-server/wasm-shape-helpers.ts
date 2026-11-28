/**
 * wasm-shape-helpers.ts – Schema Introspection, PSQL Capture Triggers, Write Execution,
 * Subquery Parent Evaluation & Node HTTP Adapter for `createWasmShapeServer` (`M31 Items 1–3`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QueryParams, QueryResult, Row } from '../types';
import { WriteRejected } from '../electric/writes';
import {
  planTable,
  quote,
  relationName,
  renderValue,
  type ColumnPlan,
  type FirebirdColumn,
  type TablePlan,
} from './catalog';
import { WhereError, type FirebirdWhere } from './where';
import type { ServerWrite } from './index';

export const WASM_SHAPE_CHANGES_TABLE = 'ELECTRIC_WASM_CHANGES$';
export const WASM_SHAPE_META_TABLE = 'ELECTRIC_WASM_META$';
export const WASM_SHAPE_SEQ = 'FB_EL_SEQ$';

export const EXPOSED_SHAPE_HEADERS =
  'electric-cursor,electric-handle,electric-offset,electric-schema,electric-up-to-date,etag,cache-control';

export interface WasmShapeDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  onQuery?: (listener: (event: { sql: string; params?: unknown }) => void) => () => void;
}

export interface WasmShapeServerOptions {
  /** Served table names (`['projects', 'tasks']`). */
  readonly tables: readonly string[];
  /** Install PSQL change-capture triggers automatically. @default true */
  readonly install?: boolean;
  /** Rows per snapshot page (`offset=-1` -> `${top}_1` -> ...). @default 1000 */
  readonly snapshotPageRows?: number;
  /** Maximum rows per historical delta chunk before marking immutable. @default 500 */
  readonly maxChunkRows?: number;
  /** Long-poll timeout for `live=true` requests in ms. @default 5000 */
  readonly liveTimeoutMs?: number;
  /** Poll interval when waiting on `live=true` / `live_sse=true` in ms. @default 50 */
  readonly pollIntervalMs?: number;
  /** Time bucket in ms for deterministic `electric-cursor` CDN collapsing. @default 5000 */
  readonly cursorBucketMs?: number;
  /** Allow safe scalar SQL functions (`LOWER`, `UPPER`, `COALESCE`, `TRIM`, `ABS`) in `where`. @default true */
  readonly allowFunctions?: boolean;
}

export interface WasmShapeServer {
  readonly tables: ReadonlyMap<string, TablePlan>;
  /** WinterCG Fetch handler (`fetch(Request): Promise<Response>`). */
  fetch(request: Request): Promise<Response>;
  /** Node `http.createServer(server.handler)` adapter. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Apply a client mutation (`insert` | `update` | `delete`) and return `{ txid }`. */
  applyWrite(write: ServerWrite): Promise<{ txid: number }>;
  /** Programmatically rotate/invalidate a table's shape handle (or all handles if omitted). */
  invalidateShape(table?: string): Promise<string>;
  /** Notify waiting `live=true` / `live_sse=true` subscribers immediately. */
  notifyChanges(): void;
  close(): Promise<void>;
}

export class HttpShapeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedWasmShape {
  readonly table: TablePlan;
  readonly columns: ColumnPlan[];
  readonly schema: Record<string, unknown>;
  readonly where?: FirebirdWhere;
  readonly replica: 'default' | 'full';
  readonly handle: string;
}

export function wsCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

export async function execWsSql(
  db: WasmShapeDatabase,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

export async function execWsTriggerDdl(db: WasmShapeDatabase, ddl: string): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(`SET TERM ^ ;\n${ddl}^\nSET TERM ; ^`);
  } else if (typeof db.execute === 'function') {
    await db.execute(ddl);
  } else {
    await db.query(ddl);
  }
}

export function hash36(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Deterministic CDN-collapsing `electric-cursor` bucket (`M31 Item 1`). */
export function computeElectricCursor(
  handle: string,
  offset: string,
  bucketMs = 5_000,
  nowMs = Date.now(),
): string {
  const bucket = Math.floor(Math.max(0, nowMs) / Math.max(100, bucketMs));
  return hash36(`${handle}:${offset}:${bucket}`);
}

/** Deterministic `ETag` for Electric `/v1/shape` responses (`M31 Item 1`). */
export function computeShapeEtag(
  handle: string,
  offset: string,
  headSeq: number,
  messageCount: number,
): string {
  return `"ef-${handle}-${offset}-${headSeq}-${messageCount}"`;
}

function wasmTriggerName(tableName: string): string {
  let h = 0x811c9dc5;
  for (const ch of tableName) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `FB_EL_TRG$${h.toString(16).padStart(8, '0').toUpperCase()}`;
}

function psqlJsonValueExpr(rowRef: 'OLD' | 'NEW', col: ColumnPlan): string {
  const ref = `${rowRef}.${quote(col.name)}`;
  if (col.render === 'bytes') return `'null'`;
  if (col.render === 'number') {
    return `CASE WHEN ${ref} IS NULL THEN 'null' ELSE TRIM(CAST(${ref} AS VARCHAR(64))) END`;
  }
  if (col.render === 'boolean') {
    return `CASE WHEN ${ref} IS NULL THEN 'null' WHEN ${ref} THEN '"true"' ELSE '"false"' END`;
  }
  const escaped =
    `REPLACE(REPLACE(REPLACE(REPLACE(CAST(${ref} AS BLOB SUB_TYPE TEXT), '\\', '\\\\'), '"', '\\"'), ` +
    `ASCII_CHAR(10), '\\n'), ASCII_CHAR(13), '\\r')`;
  return `CASE WHEN ${ref} IS NULL THEN 'null' ELSE '"' || ${escaped} || '"' END`;
}

function buildRowJsonPsqlExpr(rowRef: 'OLD' | 'NEW', plans: readonly ColumnPlan[]): string {
  const parts = plans.map(
    (p) => `'"${p.shapeName.replace(/"/g, '\\"')}":' || ${psqlJsonValueExpr(rowRef, p)}`,
  );
  return `CAST('{' AS BLOB SUB_TYPE TEXT) || ${parts.join(` || ',' || `)} || '}'`;
}

function buildPkJsonPsqlExpr(rowRef: 'OLD' | 'NEW', table: TablePlan): string {
  const keyPlans = table.key.map((k) => table.columns.find((c) => c.name === k)!);
  const parts = keyPlans.map((p) => psqlJsonValueExpr(rowRef, p));
  return `'[' || ${parts.join(` || ',' || `)} || ']'`;
}

export function buildWasmShapeTriggerDdl(table: TablePlan): string {
  const trig = wasmTriggerName(table.name);
  const tblLit = table.name.replace(/'/g, "''");
  const oldPk = buildPkJsonPsqlExpr('OLD', table);
  const newPk = buildPkJsonPsqlExpr('NEW', table);
  const oldJson = buildRowJsonPsqlExpr('OLD', table.columns);
  const newJson = buildRowJsonPsqlExpr('NEW', table.columns);
  const keyChanged = table.key
    .map((k) => `OLD.${quote(k)} IS DISTINCT FROM NEW.${quote(k)}`)
    .join(' OR ');

  return `CREATE OR ALTER TRIGGER "${trig}" FOR ${quote(table.name)}
ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 32760
AS
BEGIN
  IF (DELETING) THEN
  BEGIN
    INSERT INTO "${WASM_SHAPE_CHANGES_TABLE}" ("SEQ", "TX_ID", "TABLE_NAME", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON")
    VALUES (GEN_ID("${WASM_SHAPE_SEQ}", 1), CURRENT_TRANSACTION, '${tblLit}', 'D', ${oldPk}, ${oldJson}, NULL);
  END
  ELSE IF (INSERTING) THEN
  BEGIN
    INSERT INTO "${WASM_SHAPE_CHANGES_TABLE}" ("SEQ", "TX_ID", "TABLE_NAME", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON")
    VALUES (GEN_ID("${WASM_SHAPE_SEQ}", 1), CURRENT_TRANSACTION, '${tblLit}', 'I', ${newPk}, NULL, ${newJson});
  END
  ELSE IF (UPDATING) THEN
  BEGIN
    IF (${keyChanged}) THEN
    BEGIN
      INSERT INTO "${WASM_SHAPE_CHANGES_TABLE}" ("SEQ", "TX_ID", "TABLE_NAME", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON")
      VALUES (GEN_ID("${WASM_SHAPE_SEQ}", 1), CURRENT_TRANSACTION, '${tblLit}', 'D', ${oldPk}, ${oldJson}, NULL);
      INSERT INTO "${WASM_SHAPE_CHANGES_TABLE}" ("SEQ", "TX_ID", "TABLE_NAME", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON")
      VALUES (GEN_ID("${WASM_SHAPE_SEQ}", 1), CURRENT_TRANSACTION, '${tblLit}', 'I', ${newPk}, NULL, ${newJson});
    END
    ELSE
    BEGIN
      INSERT INTO "${WASM_SHAPE_CHANGES_TABLE}" ("SEQ", "TX_ID", "TABLE_NAME", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON")
      VALUES (GEN_ID("${WASM_SHAPE_SEQ}", 1), CURRENT_TRANSACTION, '${tblLit}', 'U', ${newPk}, ${oldJson}, ${newJson});
    END
  END
END`;
}

export async function describeWasmTable(db: WasmShapeDatabase, name: string): Promise<TablePlan> {
  const colRes = await db.query<Record<string, unknown>>(
    'SELECT TRIM(rf.RDB$FIELD_NAME) AS FNAME, f.RDB$FIELD_TYPE AS FTYPE, ' +
      'COALESCE(f.RDB$FIELD_SUB_TYPE, 0) AS FSUB, COALESCE(f.RDB$FIELD_SCALE, 0) AS FSCALE, ' +
      'COALESCE(f.RDB$FIELD_PRECISION, 0) AS FPREC, ' +
      'COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH, 0) AS FLEN, ' +
      'COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG, 0) AS FNULL, ' +
      'COALESCE(f.RDB$CHARACTER_SET_ID, 0) AS FCS ' +
      'FROM RDB$RELATION_FIELDS rf JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE ' +
      'WHERE TRIM(rf.RDB$RELATION_NAME) = ? AND f.RDB$COMPUTED_BLR IS NULL ' +
      'ORDER BY rf.RDB$FIELD_POSITION',
    [name],
  );
  const columns: FirebirdColumn[] = colRes.rows.map((r) => ({
    name: String(wsCol(r, 'FNAME') ?? ''),
    type: Number(wsCol(r, 'FTYPE') ?? 0),
    subType: Number(wsCol(r, 'FSUB') ?? 0),
    scale: Number(wsCol(r, 'FSCALE') ?? 0),
    precision: Number(wsCol(r, 'FPREC') ?? 0),
    charLength: Number(wsCol(r, 'FLEN') ?? 0),
    notNull: Number(wsCol(r, 'FNULL') ?? 0) === 1,
    charSet: Number(wsCol(r, 'FCS') ?? 0),
  }));

  const pkRes = await db.query<Record<string, unknown>>(
    'SELECT TRIM(s.RDB$FIELD_NAME) AS KNAME FROM RDB$RELATION_CONSTRAINTS c ' +
      'JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = c.RDB$INDEX_NAME ' +
      "WHERE TRIM(c.RDB$RELATION_NAME) = ? AND c.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY' " +
      'ORDER BY s.RDB$FIELD_POSITION',
    [name],
  );
  const key = pkRes.rows.map((r) => String(wsCol(r, 'KNAME') ?? ''));
  return planTable(name, columns, key);
}

export async function installWasmShapeSchema(
  db: WasmShapeDatabase,
  tables: Iterable<TablePlan>,
): Promise<void> {
  const seqChk = await db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS CNT FROM RDB$GENERATORS WHERE TRIM(RDB$GENERATOR_NAME) = ?',
    [WASM_SHAPE_SEQ],
  );
  if (Number(wsCol(seqChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
    await execWsSql(db, `CREATE SEQUENCE "${WASM_SHAPE_SEQ}"`);
  }

  const metaChk = await db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [WASM_SHAPE_META_TABLE],
  );
  if (Number(wsCol(metaChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
    await execWsSql(
      db,
      `CREATE TABLE "${WASM_SHAPE_META_TABLE}" (
        "EPOCH" VARCHAR(64) NOT NULL,
        "PRUNED_THROUGH" BIGINT DEFAULT 0 NOT NULL
      )`,
    );
    await execWsSql(db, `INSERT INTO "${WASM_SHAPE_META_TABLE}" ("EPOCH") VALUES (?)`, [
      `ep_${Date.now().toString(36)}`,
    ]);
  }

  const chgChk = await db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [WASM_SHAPE_CHANGES_TABLE],
  );
  if (Number(wsCol(chgChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
    await execWsSql(
      db,
      `CREATE TABLE "${WASM_SHAPE_CHANGES_TABLE}" (
        "SEQ" BIGINT NOT NULL PRIMARY KEY,
        "TX_ID" BIGINT NOT NULL,
        "TABLE_NAME" VARCHAR(63) NOT NULL,
        "OP" CHAR(1) NOT NULL,
        "PK_JSON" VARCHAR(1024) NOT NULL,
        "OLD_JSON" BLOB SUB_TYPE TEXT,
        "NEW_JSON" BLOB SUB_TYPE TEXT
      )`,
    );
  }

  for (const plan of tables) {
    await execWsTriggerDdl(db, buildWasmShapeTriggerDdl(plan));
  }
}

export function keyStringOf(table: TablePlan, vals: readonly unknown[]): string {
  return `"${table.name}"/${vals.map((v) => `"${String(v ?? '')}"`).join('/')}`;
}

export function renderRowObject(
  table: TablePlan,
  columns: readonly ColumnPlan[],
  rawRow: Record<string, unknown>,
): { key: string; value: Record<string, string | null> } {
  const value: Record<string, string | null> = {};
  for (let i = 0; i < columns.length; i++) {
    const plan = columns[i]!;
    const raw = wsCol(rawRow, `C${i}`) ?? wsCol(rawRow, plan.name);
    value[plan.shapeName] = renderValue(plan, raw);
  }
  const keyVals = table.key.map((k) => {
    const kPlan = table.columns.find((c) => c.name === k)!;
    if (kPlan.shapeName in value) return value[kPlan.shapeName];
    return renderValue(kPlan, wsCol(rawRow, k));
  });
  return { key: keyStringOf(table, keyVals), value };
}

export function parseParamsRecord(
  searchParams: URLSearchParams,
  jsonParamKey: string,
  prefixKey: string,
): Map<number, string> {
  const values = new Map<number, string>();
  const rawJson = searchParams.get(jsonParamKey);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          const idx = Number(k.replace(/^\$/, ''));
          if (Number.isInteger(idx) && idx > 0 && v !== undefined && v !== null) {
            values.set(idx, String(v));
          }
        }
      }
    } catch {
      throw new WhereError(`where: ${jsonParamKey} must be a valid JSON object`);
    }
  }
  const re = new RegExp(`^${prefixKey}(?:\\[(\\d+)\\]|\\.(\\d+))$`);
  for (const [k, v] of searchParams) {
    const m = re.exec(k);
    if (m) values.set(Number(m[1] ?? m[2]), v);
  }
  return values;
}

export async function evalParentOldMatch(
  db: WasmShapeDatabase,
  parentPlan: TablePlan,
  oldObj: Record<string, unknown> | null,
  parentWhere?: FirebirdWhere,
): Promise<boolean> {
  if (!oldObj) return false;
  if (!parentWhere) return true;
  const castSelects: string[] = [];
  const castParams: unknown[] = [];
  for (const c of parentPlan.columns) {
    const rawV = oldObj[c.shapeName] ?? oldObj[c.name] ?? null;
    let castType = 'VARCHAR(2048)';
    if (c.render === 'number') castType = 'DOUBLE PRECISION';
    else if (c.render === 'boolean') castType = 'BOOLEAN';
    castSelects.push(`CAST(? AS ${castType}) AS ${quote(c.name)}`);
    if (c.render === 'boolean' && typeof rawV === 'string') {
      castParams.push(rawV === 'true' || rawV === 't');
    } else {
      castParams.push(rawV);
    }
  }
  const probeSql = `SELECT 1 AS M FROM (SELECT ${castSelects.join(', ')} FROM RDB$DATABASE) p WHERE ${parentWhere.sql}`;
  const probeRes = await db.query<Record<string, unknown>>(probeSql, [
    ...castParams,
    ...parentWhere.params,
  ] as QueryParams);
  return probeRes.rows.length > 0;
}

export async function evalParentCurrentMatch(
  db: WasmShapeDatabase,
  parentPlan: TablePlan,
  pkVals: readonly unknown[],
  parentWhere?: FirebirdWhere,
): Promise<boolean> {
  const pkPred = parentPlan.key.map((k) => `${quote(k)} = ?`).join(' AND ');
  const whereSql = parentWhere ? `(${pkPred}) AND (${parentWhere.sql})` : pkPred;
  const res = await db.query<Record<string, unknown>>(
    `SELECT FIRST 1 1 AS M FROM ${quote(parentPlan.name)} WHERE ${whereSql}`,
    [...pkVals, ...(parentWhere?.params ?? [])] as QueryParams,
  );
  return res.rows.length > 0;
}

export async function executeWasmShapeWrite(
  db: WasmShapeDatabase,
  tables: ReadonlyMap<string, TablePlan>,
  write: ServerWrite,
  onCommitted: () => void,
): Promise<{ txid: number }> {
  const table = tables.get(relationName(write.table));
  if (!table) throw new WriteRejected(`Table ${write.table} is not served`);

  const byName = new Map<string, string>();
  for (const c of table.columns) {
    byName.set(c.shapeName, c.name);
    byName.set(c.name, c.name);
  }
  const resolveCol = (givenCol: string): string => {
    const fb = byName.get(givenCol);
    if (!fb) throw new WriteRejected(`Column ${givenCol} is not in table ${table.name}`);
    return fb;
  };

  const keySrc =
    write.operation === 'insert' ? { ...(write.value ?? {}), ...write.key } : write.key;
  const keyEntries = table.key.map((k) => {
    const plan = table.columns.find((c) => c.name === k)!;
    const val =
      plan.shapeName in keySrc
        ? keySrc[plan.shapeName]
        : k in keySrc
          ? keySrc[k]
          : undefined;
    if (val === undefined || val === null) {
      throw new WriteRejected(`Write to ${table.name} is missing primary key column ${plan.shapeName}`);
    }
    return [k, val] as const;
  });

  const valEntries = Object.entries(write.value ?? {}).map(
    ([k, v]) => [resolveCol(k), v ?? null] as const,
  );
  const whereSql = keyEntries.map(([k]) => `${quote(k)} = ?`).join(' AND ');
  const whereParams = keyEntries.map(([, v]) => v);

  if (write.operation === 'delete') {
    await execWsSql(db, `DELETE FROM ${quote(table.name)} WHERE ${whereSql}`, whereParams);
  } else if (write.operation === 'insert') {
    const merged = new Map<string, unknown>(keyEntries);
    for (const [k, v] of valEntries) merged.set(k, v);
    const cols = [...merged.keys()];
    const vals = [...merged.values()];
    await execWsSql(
      db,
      `UPDATE OR INSERT INTO ${quote(table.name)} (${cols.map(quote).join(', ')}) ` +
        `VALUES (${cols.map(() => '?').join(', ')}) MATCHING (${table.key.map(quote).join(', ')})`,
      vals,
    );
  } else if (write.operation === 'update') {
    const nonKey = valEntries.filter(([k]) => !table.key.includes(k));
    if (nonKey.length > 0) {
      await execWsSql(
        db,
        `UPDATE ${quote(table.name)} SET ${nonKey.map(([k]) => `${quote(k)} = ?`).join(', ')} WHERE ${whereSql}`,
        [...nonKey.map(([, v]) => v), ...whereParams],
      );
    }
  } else {
    throw new WriteRejected(`Unsupported write operation: ${String(write.operation)}`);
  }

  const txRes = await db.query<Record<string, unknown>>(
    `SELECT COALESCE((SELECT MAX("TX_ID") FROM "${WASM_SHAPE_CHANGES_TABLE}"), CURRENT_TRANSACTION) AS TX FROM RDB$DATABASE`,
  );
  const txid = Number(wsCol(txRes.rows[0] ?? {}, 'TX') ?? 0);
  onCommitted();
  return { txid };
}

export function createWasmNodeHttpHandler(
  fetchHandler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const bodyBuf = Buffer.concat(chunks);
        const fullUrl = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(', '));
        }
        const abortCtrl = new AbortController();
        req.on('close', () => abortCtrl.abort());

        const webReq = new Request(fullUrl, {
          method: req.method ?? 'GET',
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
          signal: abortCtrl.signal,
        });
        const webRes = await fetchHandler(webReq);
        res.statusCode = webRes.status;
        webRes.headers.forEach((val, key) => res.setHeader(key, val));
        if (!webRes.body) {
          res.end();
          return;
        }
        const reader = webRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
        } else {
          res.end();
        }
      }
    })();
  };
}
