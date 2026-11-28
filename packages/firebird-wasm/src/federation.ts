/**
 * federation.ts – Multi-Database `ATTACH` Cross-DB SQL Federation (`createDatabaseFederation`)
 * & Deterministic Hash / Range Horizontal Sharding with Scatter-Gather Aggregation
 * (`createShardedPool`) (`M30 Item 4`).
 */

import { FirebirdBrowser } from './browser/firebird-browser';
import type { FieldInfo, QueryParams, QueryResult, Row } from './types';

export interface FederatableDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  close?(): Promise<void>;
}

export interface AttachedDatabaseEntry {
  readonly alias: string;
  readonly uri?: string;
  readonly owned: boolean;
}

export interface DatabaseFederationHandle {
  attach(alias: string, dbOrUri: FederatableDatabase | string): Promise<void>;
  detach(alias: string): Promise<boolean>;
  listAttached(): AttachedDatabaseEntry[];
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  close(): Promise<void>;
}

function qFedIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function fedCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execFedSql(
  db: FederatableDatabase,
  sql: string,
  params: QueryParams = [],
): Promise<number> {
  if (typeof db.execute === 'function') {
    const r = await db.execute(sql, params);
    return r.affectedRows;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
    return 1;
  }
  await db.query(sql, params);
  return 0;
}

function fieldInfoToDdl(f: FieldInfo): string {
  const t = (f.typeName ?? '').toUpperCase();
  if (t.includes('BIGINT') || t === 'INT64') return 'BIGINT';
  if (t.includes('SMALLINT') || t === 'SHORT') return 'SMALLINT';
  if (t.includes('INT') || t === 'LONG') return 'INTEGER';
  if (t.includes('DOUBLE') || t.includes('FLOAT') || t.includes('NUMERIC') || t.includes('DECIMAL')) {
    return 'DOUBLE PRECISION';
  }
  if (t.includes('BOOL')) return 'BOOLEAN';
  if (t.includes('TIMESTAMP')) return 'TIMESTAMP';
  if (t === 'DATE') return 'DATE';
  if (t.includes('BLOB')) return 'BLOB SUB_TYPE TEXT';
  return 'VARCHAR(1024)';
}

async function stageTableIntoCoordinator(
  sourceDb: FederatableDatabase,
  sourceTable: string,
  coordDb: FirebirdBrowser,
  stagedName: string,
): Promise<void> {
  const srcRes = await sourceDb.query<Record<string, unknown>>(
    `SELECT * FROM ${qFedIdent(sourceTable)}`,
  );

  let colDefs: Array<{ name: string; ddl: string }>;
  if (srcRes.fields.length > 0) {
    colDefs = srcRes.fields.map((f) => ({
      name: f.name.toUpperCase(),
      ddl: fieldInfoToDdl(f),
    }));
  } else {
    const catRes = await sourceDb.query<Record<string, unknown>>(
      `SELECT TRIM(RDB$FIELD_NAME) AS C FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? ORDER BY RDB$FIELD_POSITION`,
      [sourceTable.toUpperCase()],
    );
    colDefs = catRes.rows.map((r) => ({
      name: String(fedCol(r, 'C') ?? '').toUpperCase(),
      ddl: 'VARCHAR(1024)',
    }));
  }

  const dropChk = await coordDb.query<{ CNT: number }>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [stagedName],
  );
  if (Number(dropChk.rows[0]?.CNT ?? 0) > 0) {
    await coordDb.execute(`DROP TABLE ${qFedIdent(stagedName)}`);
  }

  const createSql = `CREATE TABLE ${qFedIdent(stagedName)} (${colDefs
    .map((c) => `${qFedIdent(c.name)} ${c.ddl}`)
    .join(', ')})`;
  await coordDb.execute(createSql);

  if (srcRes.rows.length > 0) {
    const colList = colDefs.map((c) => qFedIdent(c.name)).join(', ');
    const ph = colDefs.map(() => '?').join(', ');
    const insSql = `INSERT INTO ${qFedIdent(stagedName)} (${colList}) VALUES (${ph})`;
    const batchRows = srcRes.rows.map((r) => colDefs.map((c) => fedCol(r, c.name) ?? null));
    await coordDb.execBatch(insSql, batchRows);
  }
}

/**
 * Create a multi-database SQL federation engine supporting `ATTACH '<uri>' AS <alias>`,
 * `DETACH <alias>`, single-DB pushdown, and full cross-DB SQL `JOIN` / `GROUP BY` / CTEs (`M30 Item 4`).
 */
export function createDatabaseFederation(
  primaryDb: FederatableDatabase,
): DatabaseFederationHandle {
  const attached = new Map<
    string,
    { alias: string; db: FederatableDatabase; uri?: string; owned: boolean }
  >();
  let scratchCoord: FirebirdBrowser | null = null;
  let scratchSeq = 0;

  const getScratchCoord = (): FirebirdBrowser => {
    if (!scratchCoord) {
      scratchSeq += 1;
      scratchCoord = new FirebirdBrowser(`memory://fb_fed_coord_${Date.now()}_${scratchSeq}`, {
        autoPersist: false,
      });
    }
    return scratchCoord;
  };

  const attach = async (alias: string, dbOrUri: FederatableDatabase | string): Promise<void> => {
    const key = alias.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_$]*$/.test(key) || key === 'PUBLIC' || key === 'MAIN') {
      throw new Error(`Invalid attach alias "${alias}".`);
    }
    if (attached.has(key)) {
      await detach(key);
    }
    if (typeof dbOrUri === 'string') {
      const opened = new FirebirdBrowser(dbOrUri, { autoPersist: !dbOrUri.startsWith('memory://') });
      attached.set(key, { alias: key, db: opened, uri: dbOrUri, owned: true });
    } else {
      attached.set(key, { alias: key, db: dbOrUri, owned: false });
    }
  };

  const detach = async (alias: string): Promise<boolean> => {
    const key = alias.trim().toUpperCase();
    const ent = attached.get(key);
    if (!ent) return false;
    attached.delete(key);
    if (ent.owned && typeof ent.db.close === 'function') {
      await ent.db.close();
    }
    return true;
  };

  const tryHandleAttachDetachSql = async (sql: string): Promise<boolean> => {
    const attMatch = /^\s*ATTACH\s+(?:DATABASE\s+)?'([^']+)'\s+AS\s+([A-Za-z_][A-Za-z0-9_$]*)\s*;?\s*$/i.exec(
      sql,
    );
    if (attMatch) {
      await attach(attMatch[2]!, attMatch[1]!);
      return true;
    }
    const detMatch = /^\s*DETACH\s+(?:DATABASE\s+)?([A-Za-z_][A-Za-z0-9_$]*)\s*;?\s*$/i.exec(sql);
    if (detMatch) {
      await detach(detMatch[1]!);
      return true;
    }
    return false;
  };

  const extractFederatedRefs = (
    sql: string,
  ): {
    remoteRefs: Array<{ alias: string; table: string }>;
    unqualifiedTables: string[];
  } => {
    const remoteRefs: Array<{ alias: string; table: string }> = [];
    const seenRemote = new Set<string>();
    const qualRe = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_$]*)\.(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
    let m: RegExpExecArray | null;
    while ((m = qualRe.exec(sql)) !== null) {
      const al = m[1]!.toUpperCase();
      const tbl = (m[2] ?? m[3] ?? '').toUpperCase();
      if (attached.has(al)) {
        const k = `${al}.${tbl}`;
        if (!seenRemote.has(k)) {
          seenRemote.add(k);
          remoteRefs.push({ alias: al, table: tbl });
        }
      }
    }

    const unqualifiedTables: string[] = [];
    const bareRe =
      /\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))(?!\s*\.|[A-Za-z0-9_$])/gi;
    while ((m = bareRe.exec(sql)) !== null) {
      const tbl = (m[1] ?? m[2] ?? '').toUpperCase();
      if (tbl && tbl !== 'RDB$DATABASE' && !attached.has(tbl) && !unqualifiedTables.includes(tbl)) {
        unqualifiedTables.push(tbl);
      }
    }
    return { remoteRefs, unqualifiedTables };
  };

  return {
    attach,
    detach,

    listAttached(): AttachedDatabaseEntry[] {
      return [...attached.values()].map((e) => ({
        alias: e.alias,
        uri: e.uri,
        owned: e.owned,
      }));
    },

    async execute(sql: string, params: QueryParams = []): Promise<{ affectedRows: number }> {
      if (await tryHandleAttachDetachSql(sql)) return { affectedRows: 0 };
      const { remoteRefs, unqualifiedTables } = extractFederatedRefs(sql);
      if (remoteRefs.length === 1 && unqualifiedTables.length === 0) {
        const target = attached.get(remoteRefs[0]!.alias)!;
        const stripped = sql.replace(
          new RegExp(`\\b${remoteRefs[0]!.alias}\\.`, 'gi'),
          '',
        );
        const affected = await execFedSql(target.db, stripped, params);
        return { affectedRows: affected };
      }
      const affected = await execFedSql(primaryDb, sql, params);
      return { affectedRows: affected };
    },

    async query<T extends Row = Row>(
      sql: string,
      params: QueryParams = [],
    ): Promise<QueryResult<T>> {
      if (await tryHandleAttachDetachSql(sql)) {
        return { fields: [], rows: [] };
      }
      const { remoteRefs, unqualifiedTables } = extractFederatedRefs(sql);
      if (remoteRefs.length === 0) {
        return primaryDb.query<T>(sql, params);
      }

      // Single attached DB pushdown (no cross-DB join needed)
      const uniqueRemoteAliases = [...new Set(remoteRefs.map((r) => r.alias))];
      if (uniqueRemoteAliases.length === 1 && unqualifiedTables.length === 0) {
        const onlyAlias = uniqueRemoteAliases[0]!;
        const target = attached.get(onlyAlias)!;
        const pushedSql = sql.replace(new RegExp(`\\b${onlyAlias}\\.`, 'gi'), '');
        return target.db.query<T>(pushedSql, params);
      }

      // Cross-database SQL join / aggregation via isolated in-memory Firebird coordinator
      const coord = getScratchCoord();
      let rewrittenSql = sql;

      for (const ref of remoteRefs) {
        const staged = `FED_${ref.alias}_${ref.table}`.slice(0, 60);
        const ent = attached.get(ref.alias)!;
        await stageTableIntoCoordinator(ent.db, ref.table, coord, staged);
        const refPattern = new RegExp(
          `\\b${ref.alias}\\.(?:"${ref.table}"|${ref.table}\\b)`,
          'gi',
        );
        rewrittenSql = rewrittenSql.replace(refPattern, qFedIdent(staged));
      }

      for (const localTbl of unqualifiedTables) {
        await stageTableIntoCoordinator(primaryDb, localTbl, coord, localTbl);
      }

      return coord.query<T>(rewrittenSql, params);
    },

    async close(): Promise<void> {
      for (const k of [...attached.keys()]) {
        await detach(k);
      }
      if (scratchCoord) {
        await scratchCoord.close();
        scratchCoord = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Deterministic Hash / Range Horizontal Sharding (`createShardedPool`)
// ---------------------------------------------------------------------------

export interface ShardNodeConfig {
  readonly id: string;
  readonly db: FederatableDatabase;
  /** Inclusive min / exclusive max numeric key bounds when `strategy === 'range'`. */
  readonly minKey?: number;
  readonly maxKey?: number;
}

export interface ShardedPoolOptions {
  readonly shardKeyColumn: string;
  readonly strategy?: 'hash' | 'range';
}

export interface ShardedPoolHandle {
  readonly shards: readonly ShardNodeConfig[];
  readonly shardKeyColumn: string;
  shardForKey(key: string | number): ShardNodeConfig;
  dbForKey(key: string | number): FederatableDatabase;
  insert(table: string, row: Record<string, unknown>): Promise<{ shardId: string }>;
  execAll(sql: string, params?: QueryParams): Promise<void>;
  /** Scatter-gather `SELECT` with cross-shard `COUNT`/`SUM`/`MIN`/`MAX`/`AVG`, `ORDER BY` & `LIMIT`. */
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  /** Rebalance misplaced rows across a new or expanded shard topology. */
  rebalanceTable(
    table: string,
    nextShards: readonly ShardNodeConfig[],
    options?: { primaryKey?: string },
  ): Promise<{ movedRows: number; perShardCounts: Record<string, number> }>;
}

/** Deterministic 32-bit FNV-1a hash (`M30 Item 4`). */
export function fnv1aHash32(input: string | number): number {
  const s = String(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Create a horizontal sharding & scatter-gather query pool across multiple Firebird nodes (`M30 Item 4`).
 */
export function createShardedPool(
  shards: readonly ShardNodeConfig[],
  options: ShardedPoolOptions,
): ShardedPoolHandle {
  if (shards.length === 0) throw new Error('createShardedPool requires at least 1 shard.');
  const shardKeyUpper = options.shardKeyColumn.trim().toUpperCase();
  const strategy = options.strategy ?? 'hash';

  const pickShard = (
    pool: readonly ShardNodeConfig[],
    key: string | number,
  ): ShardNodeConfig => {
    if (strategy === 'range') {
      const n = Number(key);
      for (const s of pool) {
        const lo = s.minKey ?? -Infinity;
        const hi = s.maxKey ?? Infinity;
        if (n >= lo && n < hi) return s;
      }
      return pool[pool.length - 1]!;
    }
    const idx = fnv1aHash32(key) % pool.length;
    return pool[idx]!;
  };

  return {
    shards,
    shardKeyColumn: shardKeyUpper,

    shardForKey(key: string | number): ShardNodeConfig {
      return pickShard(shards, key);
    },

    dbForKey(key: string | number): FederatableDatabase {
      return pickShard(shards, key).db;
    },

    async insert(table: string, row: Record<string, unknown>): Promise<{ shardId: string }> {
      const skVal = fedCol(row, shardKeyUpper);
      if (skVal === undefined || skVal === null) {
        throw new Error(`Row is missing shardKeyColumn "${shardKeyUpper}".`);
      }
      const target = pickShard(shards, skVal as string | number);
      const keys = Object.keys(row);
      const colsSql = keys.map((k) => qFedIdent(k)).join(', ');
      const ph = keys.map(() => '?').join(', ');
      await execFedSql(
        target.db,
        `INSERT INTO ${qFedIdent(table)} (${colsSql}) VALUES (${ph})`,
        keys.map((k) => row[k]) as QueryParams,
      );
      return { shardId: target.id };
    },

    async execAll(sql: string, params: QueryParams = []): Promise<void> {
      await Promise.all(shards.map((s) => execFedSql(s.db, sql, params)));
    },

    async query<T extends Row = Row>(
      sql: string,
      params: QueryParams = [],
    ): Promise<QueryResult<T>> {
      // Strip outer LIMIT / FIRST <n> before fanning out so global top-N across shards is accurate
      let limitCount: number | null = null;
      let shardSql = sql;
      const firstMatch = /^\s*SELECT\s+FIRST\s+(\d+)\s+/i.exec(shardSql);
      if (firstMatch) {
        limitCount = Number(firstMatch[1]);
        shardSql = shardSql.replace(/^\s*SELECT\s+FIRST\s+\d+\s+/i, 'SELECT ');
      }
      const rowsLimitMatch = /\s+ROWS\s+(\d+)\s*;?\s*$/i.exec(shardSql);
      if (rowsLimitMatch) {
        limitCount = Number(rowsLimitMatch[1]);
        shardSql = shardSql.replace(/\s+ROWS\s+\d+\s*;?\s*$/i, '');
      }

      // Check for global scalar aggregates without GROUP BY: COUNT/SUM/MIN/MAX/AVG
      const hasGroupBy = /\bGROUP\s+BY\b/i.test(shardSql);
      const selectBodyMatch = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([\s\S]+)$/i.exec(shardSql);
      if (!hasGroupBy && selectBodyMatch && /\b(COUNT|SUM|MIN|MAX|AVG)\s*\(/i.test(selectBodyMatch[1]!)) {
        const exprs = selectBodyMatch[1]!.split(',').map((s) => s.trim());
        const fromRest = selectBodyMatch[2]!;
        const aggSpecs = exprs.map((ex, idx) => {
          const m = /^(COUNT|SUM|MIN|MAX|AVG)\s*\(\s*([^)]+)\s*\)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_$]*))?$/i.exec(
            ex,
          );
          if (!m) return null;
          return {
            fn: m[1]!.toUpperCase(),
            arg: m[2]!.trim(),
            alias: (m[3] ?? m[1]!).toUpperCase(),
            idx,
          };
        });

        if (aggSpecs.every((s) => s !== null)) {
          const validSpecs = aggSpecs.filter((s): s is NonNullable<typeof s> => s !== null);
          const subParts: string[] = [];
          for (const sp of validSpecs) {
            if (sp.fn === 'AVG') {
              subParts.push(
                `SUM(${sp.arg}) AS "__AVG_SUM_${sp.idx}"`,
                `COUNT(${sp.arg}) AS "__AVG_CNT_${sp.idx}"`,
              );
            } else {
              subParts.push(`${sp.fn}(${sp.arg}) AS "${sp.alias}"`);
            }
          }
          const subSql = `SELECT ${subParts.join(', ')} FROM ${fromRest}`;
          const shardResults = await Promise.all(
            shards.map((s) => s.db.query<Record<string, unknown>>(subSql, params)),
          );

          const mergedRow: Record<string, unknown> = {};
          for (const sp of validSpecs) {
            if (sp.fn === 'COUNT' || sp.fn === 'SUM') {
              let total = 0;
              let anyNonNull = sp.fn === 'COUNT';
              for (const sr of shardResults) {
                const v = fedCol(sr.rows[0] ?? {}, sp.alias);
                if (v !== null && v !== undefined) {
                  total += Number(v);
                  anyNonNull = true;
                }
              }
              mergedRow[sp.alias] = anyNonNull ? total : null;
            } else if (sp.fn === 'MIN' || sp.fn === 'MAX') {
              let best: number | string | null = null;
              for (const sr of shardResults) {
                const v = fedCol(sr.rows[0] ?? {}, sp.alias) as number | string | null | undefined;
                if (v === null || v === undefined) continue;
                const cmpVal = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
                if (
                  best === null ||
                  (sp.fn === 'MIN' && cmpVal < best) ||
                  (sp.fn === 'MAX' && cmpVal > best)
                ) {
                  best = cmpVal;
                }
              }
              mergedRow[sp.alias] = best;
            } else if (sp.fn === 'AVG') {
              let sum = 0;
              let cnt = 0;
              for (const sr of shardResults) {
                const sv = fedCol(sr.rows[0] ?? {}, `__AVG_SUM_${sp.idx}`);
                const cv = fedCol(sr.rows[0] ?? {}, `__AVG_CNT_${sp.idx}`);
                if (sv !== null && sv !== undefined) sum += Number(sv);
                if (cv !== null && cv !== undefined) cnt += Number(cv);
              }
              mergedRow[sp.alias] = cnt > 0 ? sum / cnt : null;
            }
          }

          return {
            fields: validSpecs.map((sp) => ({
              name: sp.alias,
              type: 27,
              typeName: 'DOUBLE',
              nullable: true,
            })),
            rows: [mergedRow as T],
          };
        }
      }

      const results = await Promise.all(shards.map((s) => s.db.query<T>(shardSql, params)));
      const fields = results[0]?.fields ?? [];
      let merged = results.flatMap((r) => r.rows);

      // Global ORDER BY merge sort
      const orderMatch = /\bORDER\s+BY\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))(?:\s+(ASC|DESC))?\s*;?\s*$/i.exec(
        shardSql,
      );
      if (orderMatch) {
        const orderCol = (orderMatch[1] ?? orderMatch[2] ?? '').toUpperCase();
        const desc = orderMatch[3]?.toUpperCase() === 'DESC';
        merged = [...merged].sort((a, b) => {
          const va = fedCol(a as Record<string, unknown>, orderCol);
          const vb = fedCol(b as Record<string, unknown>, orderCol);
          if (va === vb) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp = va < vb ? -1 : 1;
          return desc ? -cmp : cmp;
        });
      }

      if (limitCount !== null) {
        merged = merged.slice(0, limitCount);
      }

      return { fields, rows: merged };
    },

    async rebalanceTable(table, nextShards, rebOpts = {}) {
      const pkUpper = (rebOpts.primaryKey ?? 'ID').trim().toUpperCase();
      const allMap = new Map<string, ShardNodeConfig>();
      for (const s of [...shards, ...nextShards]) allMap.set(s.id, s);

      let movedRows = 0;
      for (const srcShard of shards) {
        const res = await srcShard.db.query<Record<string, unknown>>(
          `SELECT * FROM ${qFedIdent(table)}`,
        );
        for (const row of res.rows) {
          const skVal = fedCol(row, shardKeyUpper) as string | number | undefined;
          const pkVal = fedCol(row, pkUpper);
          if (skVal === undefined || skVal === null || pkVal === undefined) continue;
          const destShard = pickShard(nextShards, skVal);
          if (destShard.id !== srcShard.id) {
            const cols = Object.keys(row);
            const colsSql = cols.map((c) => qFedIdent(c)).join(', ');
            const ph = cols.map(() => '?').join(', ');
            await execFedSql(
              destShard.db,
              `UPDATE OR INSERT INTO ${qFedIdent(table)} (${colsSql}) VALUES (${ph}) MATCHING (${qFedIdent(pkUpper)})`,
              cols.map((c) => row[c]) as QueryParams,
            );
            await execFedSql(
              srcShard.db,
              `DELETE FROM ${qFedIdent(table)} WHERE ${qFedIdent(pkUpper)} = ?`,
              [pkVal],
            );
            movedRows += 1;
          }
        }
      }

      const perShardCounts: Record<string, number> = {};
      for (const s of allMap.values()) {
        const cRes = await s.db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT FROM ${qFedIdent(table)}`,
        );
        perShardCounts[s.id] = Number(fedCol(cRes.rows[0] ?? {}, 'CNT') ?? 0);
      }

      return { movedRows, perShardCounts };
    },
  };
}
