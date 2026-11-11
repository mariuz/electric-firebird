/**
 * Internal shared SQL, JSON, and row-mutation helpers for `firebird-wasm/replication`.
 */

import type { QueryParams, QueryResult, Row } from '../types';
import type { ReplicableDatabase } from './types';

export function encodeJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Uint8Array) return { $bytes: Array.from(v) };
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    return v;
  });
}

export function decodeJson(text: unknown): Record<string, unknown> | null {
  if (text === null || text === undefined || text === '') return null;
  return JSON.parse(String(text), (_, v) => {
    if (v && typeof v === 'object' && Array.isArray(v.$bytes)) {
      return new Uint8Array(v.$bytes);
    }
    if (v && typeof v === 'object' && typeof v.$bigint === 'string') {
      return BigInt(v.$bigint);
    }
    return v;
  }) as Record<string, unknown>;
}

export function quoteIdent(ident: string): string {
  const clean = ident.trim().replace(/^"+|"+$/g, '');
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(clean)) {
    return clean.toUpperCase();
  }
  return `"${clean.replace(/"/g, '""')}"`;
}

export function normalizeTableName(ident: string): string {
  return ident.trim().replace(/^"+|"+$/g, '').toUpperCase();
}

export function fnv1aHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (const ch of input) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').toUpperCase();
}

export function escapeSqlLiteral(val: string): string {
  return val.replace(/'/g, "''");
}

export function getFieldCaseInsensitive(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

export function normalizeRowKeysUpper(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.toUpperCase()] = v;
  }
  return out;
}

export function extractKeyRecord(
  row: Record<string, unknown>,
  pkCols: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of pkCols) {
    out[col.toUpperCase()] = getFieldCaseInsensitive(row, col);
  }
  return out;
}

export function serializeKeyRecord(
  keyRec: Record<string, unknown>,
  pkCols: readonly string[],
): string {
  return JSON.stringify(pkCols.map((c) => getFieldCaseInsensitive(keyRec, c)));
}

export function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const normA = normalizeRowKeysUpper(a);
  const normB = normalizeRowKeysUpper(b);
  const keysA = Object.keys(normA).sort();
  const keysB = Object.keys(normB).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    const valA = normA[keysA[i]!];
    const valB = normB[keysB[i]!];
    if (JSON.stringify(valA) !== JSON.stringify(valB)) return false;
  }
  return true;
}

export async function execStatement(
  db: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
  },
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (params.length > 0) {
    if (typeof db.execute === 'function') {
      await db.execute(sql, params);
    } else if (typeof db.exec === 'function') {
      await db.exec(sql, params);
    } else {
      await db.query(sql, params);
    }
    return;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql);
  } else if (typeof db.execute === 'function') {
    await db.execute(sql, []);
  } else {
    await db.query(sql, []);
  }
}

/**
 * Execute a single PSQL DDL statement (`CREATE OR ALTER TRIGGER ...`) whose body
 * contains `;` terminators.
 *
 * `FirebirdBrowser.exec()` treats its input as an isql-style script and splits
 * it on `;` (honouring `SET TERM`), which would truncate a trigger body at its
 * first `DECLARE VARIABLE`. A transaction's `exec()` runs exactly one statement
 * verbatim, so PSQL DDL is routed through `db.transaction()` when available.
 */
export async function execPsqlDdl(db: ReplicableDatabase, ddl: string): Promise<void> {
  if (typeof db.transaction === 'function') {
    await db.transaction(async (tx) => {
      await execStatement(tx, ddl);
    });
    return;
  }
  await execStatement(db, ddl);
}

export async function ensureTableSafe(
  db: ReplicableDatabase,
  createSql: string,
): Promise<void> {
  try {
    await execStatement(db, createSql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|SQLCODE = -607|unsuccessful metadata update/i.test(msg)) {
      throw err;
    }
  }
}

export async function applyRowMutationToTable(
  runner: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
    execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
  },
  table: string,
  pkCols: readonly string[],
  operation: 'INSERT' | 'UPDATE' | 'DELETE',
  key: Record<string, unknown>,
  rowValues: Record<string, unknown> | null,
): Promise<void> {
  const quotedTable = quoteIdent(table);
  const normKey = normalizeRowKeysUpper(key);

  if (operation === 'DELETE') {
    const whereClause = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
    const whereParams = pkCols.map((c) => normKey[c.toUpperCase()]) as QueryParams;
    await execStatement(
      runner,
      `DELETE FROM ${quotedTable} WHERE ${whereClause}`,
      whereParams,
    );
    return;
  }

  const normRow = normalizeRowKeysUpper({ ...(rowValues ?? {}), ...normKey });

  // Fast single-statement Firebird native `UPDATE OR INSERT ... MATCHING` when
  // running against a real Firebird engine (`execBatch` present on runner).
  if (typeof runner.execBatch === 'function' && pkCols.length > 0) {
    const cols = Object.keys(normRow);
    if (cols.length > 0) {
      const colList = cols.map(quoteIdent).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const matchingList = pkCols.map((c) => quoteIdent(c.toUpperCase())).join(', ');
      const upsertParams = cols.map((c) => normRow[c]) as QueryParams;
      await execStatement(
        runner,
        `UPDATE OR INSERT INTO ${quotedTable} (${colList}) VALUES (${placeholders}) MATCHING (${matchingList})`,
        upsertParams,
      );
      return;
    }
  }

  const whereClause = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
  const whereParams = pkCols.map((c) => normRow[c.toUpperCase()]) as QueryParams;

  const existing = await runner.query<Row>(
    `SELECT * FROM ${quotedTable} WHERE ${whereClause}`,
    whereParams,
  );

  if (existing.rows.length > 0) {
    const nonPkCols = Object.keys(normRow).filter(
      (c) => !pkCols.map((p) => p.toUpperCase()).includes(c.toUpperCase()),
    );
    if (nonPkCols.length === 0) return;
    const setClause = nonPkCols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
    const setParams = nonPkCols.map((c) => normRow[c]) as QueryParams;
    await execStatement(
      runner,
      `UPDATE ${quotedTable} SET ${setClause} WHERE ${whereClause}`,
      [...setParams, ...whereParams],
    );
  } else {
    const cols = Object.keys(normRow);
    const colList = cols.map(quoteIdent).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const insertParams = cols.map((c) => normRow[c]) as QueryParams;
    await execStatement(
      runner,
      `INSERT INTO ${quotedTable} (${colList}) VALUES (${placeholders})`,
      insertParams,
    );
  }
}

/**
 * Execute a contiguous batch of homogeneous (`INSERT`/`UPDATE` or `DELETE`) row
 * mutations on `table` via Firebird's `IBatch` (`execBatch`) + `UPDATE OR INSERT ... MATCHING`,
 * falling back to `applyRowMutationToTable` when `execBatch` is unavailable (`M18 Item 2`).
 */
export async function applyBatchedRowMutationsToTable(
  runner: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
    execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
  },
  table: string,
  pkCols: readonly string[],
  operation: 'INSERT' | 'UPDATE' | 'DELETE',
  items: ReadonlyArray<{
    key: Record<string, unknown>;
    rowValues: Record<string, unknown> | null;
  }>,
): Promise<void> {
  if (items.length === 0) return;

  if (typeof runner.execBatch !== 'function' || pkCols.length === 0) {
    for (const item of items) {
      await applyRowMutationToTable(runner, table, pkCols, operation, item.key, item.rowValues);
    }
    return;
  }

  const quotedTable = quoteIdent(table);
  const upperPkCols = pkCols.map((c) => c.toUpperCase());

  if (operation === 'DELETE') {
    const whereClause = upperPkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
    const sql = `DELETE FROM ${quotedTable} WHERE ${whereClause}`;
    const paramRows: QueryParams[] = items.map((item) => {
      const normKey = normalizeRowKeysUpper(item.key);
      return upperPkCols.map((c) => normKey[c]) as QueryParams;
    });
    await runner.execBatch(sql, paramRows);
    return;
  }

  // Group contiguous rows sharing the same column list so partial-column updates
  // never overwrite omitted columns with NULL.
  const matchingList = upperPkCols.map(quoteIdent).join(', ');
  let currentCols: string[] | null = null;
  let currentSig = '';
  let currentBatch: QueryParams[] = [];

  const flushSubBatch = async (): Promise<void> => {
    if (!currentCols || currentCols.length === 0 || currentBatch.length === 0) return;
    const colList = currentCols.map(quoteIdent).join(', ');
    const placeholders = currentCols.map(() => '?').join(', ');
    const sql = `UPDATE OR INSERT INTO ${quotedTable} (${colList}) VALUES (${placeholders}) MATCHING (${matchingList})`;
    await runner.execBatch!(sql, currentBatch);
    currentBatch = [];
  };

  for (const item of items) {
    const normKey = normalizeRowKeysUpper(item.key);
    const normRow = normalizeRowKeysUpper({ ...(item.rowValues ?? {}), ...normKey });
    const cols = Object.keys(normRow).sort();
    if (cols.length === 0) continue;
    const sig = cols.join('\0');
    if (sig !== currentSig) {
      await flushSubBatch();
      currentCols = cols;
      currentSig = sig;
    }
    currentBatch.push(cols.map((c) => normRow[c]) as QueryParams);
  }

  await flushSubBatch();
}

export function isInternalReplicationTable(name: string): boolean {
  const upper = normalizeTableName(name);
  return (
    upper.startsWith('FB_REPL_') ||
    upper.startsWith('FB_MIGRATIONS') ||
    upper.startsWith('RDB$') ||
    upper.startsWith('MON$') ||
    upper.startsWith('SEC$')
  );
}

export function toMigrationExecutor(db: ReplicableDatabase): {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec(sql: string, params?: QueryParams): Promise<unknown>;
} {
  return {
    query: <T extends Row = Row>(sql: string, params?: QueryParams) => db.query<T>(sql, params),
    exec: (sql: string, params?: QueryParams) => execStatement(db, sql, params),
  };
}

export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not available in this runtime');
  }
  const cs = new CompressionStream('gzip');
  // Consume the readable side concurrently: awaiting write()/close() first
  // deadlocks in browsers once the transform's queue applies backpressure.
  const output = new Response(cs.readable).arrayBuffer();
  const writer = cs.writable.getWriter();
  void writer.write(new Uint8Array(input)).catch(() => undefined);
  await writer.close();
  return new Uint8Array(await output);
}

export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not available in this runtime');
  }
  const ds = new DecompressionStream('gzip');
  const output = new Response(ds.readable).arrayBuffer();
  const writer = ds.writable.getWriter();
  void writer.write(new Uint8Array(input)).catch(() => undefined);
  await writer.close();
  return new Uint8Array(await output);
}

export function isGzipBytes(data: Uint8Array): boolean {
  return data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

