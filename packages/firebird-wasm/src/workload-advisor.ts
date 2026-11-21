/**
 * workload-advisor.ts – Adaptive Index Advisor, Workload Analyzer & Slow-Query
 * Plan Diagnostics (`createWorkloadAdvisor`) (`M28 Item 4`).
 */

import { introspect as introspectCatalog } from './browser/schema';
import { parseQueryPlan } from './repl/plan-tree';
import type {
  ExplainOptions,
  MonitorStats,
  QueryParams,
  QueryProfileEvent,
  QueryProfileListener,
  QueryResult,
  Row,
  SchemaIntrospection,
} from './types';

export type WorkloadAdviceKind =
  | 'MISSING_FILTER_INDEX'
  | 'UNINDEXED_FOREIGN_KEY'
  | 'REDUNDANT_PREFIX_INDEX'
  | 'INACTIVE_OR_STALE_INDEX';

export type WorkloadAdviceSeverity = 'high' | 'medium' | 'low';

/** Single ranked DBA / index recommendation (`M28 Item 4`). */
export interface WorkloadAdvice {
  readonly id: string;
  readonly kind: WorkloadAdviceKind;
  readonly severity: WorkloadAdviceSeverity;
  readonly table: string;
  readonly columns: readonly string[];
  readonly sql: string;
  readonly rationale: string;
  readonly sampleQuery?: string;
}

/** Complete diagnostic report returned by {@link WorkloadAdvisorHandle.analyze} (`M28 Item 4`). */
export interface WorkloadAdvisorReport {
  readonly analyzedQueries: number;
  readonly naturalScanQueries: number;
  readonly unindexedForeignKeys: number;
  readonly redundantIndexes: number;
  readonly recommendations: readonly WorkloadAdvice[];
  readonly applySql: string;
}

/** Minimal database interface required by {@link createWorkloadAdvisor} (`M28 Item 4`). */
export interface WorkloadAdvisorDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  explain?(sql: string, options?: ExplainOptions): Promise<string>;
  introspect?(): Promise<SchemaIntrospection>;
  monitorStats?(): Promise<MonitorStats>;
  onQuery?(listener: QueryProfileListener): () => void;
}

/** Options for {@link createWorkloadAdvisor} (`M28 Item 4`). */
export interface WorkloadAdvisorOptions {
  /** Subscribe automatically to `db.onQuery()` when available. @default true */
  readonly captureLiveQueries?: boolean;
  /** Maximum distinct normalized SQL statements retained in memory. @default 150 */
  readonly maxTrackedQueries?: number;
}

/** Handle returned by {@link createWorkloadAdvisor} (`M28 Item 4`). */
export interface WorkloadAdvisorHandle {
  recordSql(sql: string, metrics?: { durationMs?: number; fetches?: number; rowCount?: number }): void;
  analyze(extraQueries?: readonly string[]): Promise<WorkloadAdvisorReport>;
  applyRecommendations(options?: {
    kinds?: readonly WorkloadAdviceKind[];
    severities?: readonly WorkloadAdviceSeverity[];
    dryRun?: boolean;
  }): Promise<{ statements: string[]; applied: boolean }>;
  clear(): void;
  dispose(): void;
}

interface CatalogIndexRecord {
  readonly indexName: string;
  readonly tableName: string;
  readonly columns: string[];
  readonly unique: boolean;
  readonly descending: boolean;
  readonly inactive: boolean;
  readonly statistics: number;
  readonly isConstraintBacked: boolean;
}

function qAdvIdent(name: string): string {
  return /^[A-Z][A-Z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function advCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

function normalizeSqlKey(sql: string): string {
  return sql
    .trim()
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ');
}

function extractAliasMap(sql: string, knownTables: ReadonlySet<string>): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_$]*))?/gi;
  const reserved = new Set([
    'WHERE',
    'JOIN',
    'LEFT',
    'INNER',
    'RIGHT',
    'FULL',
    'CROSS',
    'ON',
    'ORDER',
    'GROUP',
    'HAVING',
    'SET',
    'VALUES',
    'ROWS',
    'FETCH',
  ]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tbl = (m[1] ?? m[2] ?? '').toUpperCase();
    if (!knownTables.has(tbl)) continue;
    map.set(tbl, tbl);
    const alias = (m[3] ?? '').toUpperCase();
    if (alias && !reserved.has(alias)) {
      map.set(alias, tbl);
    }
  }
  return map;
}

function extractFilterAndOrderColumns(
  sql: string,
  tableName: string,
  tableColumns: ReadonlySet<string>,
  aliasMap: ReadonlyMap<string, string>,
): string[] {
  const found: string[] = [];
  const pushCol = (colRaw: string): void => {
    const col = colRaw.toUpperCase();
    if (tableColumns.has(col) && !found.includes(col)) {
      found.push(col);
    }
  };

  // Extract WHERE / ON / ORDER BY tail
  const clauseMatch = /\b(?:WHERE|ON|ORDER\s+BY)\b([\s\S]*)$/i.exec(sql);
  if (!clauseMatch) return found;
  const tail = clauseMatch[1]!;

  // 1. Qualified `alias.COL` references belonging to `tableName`
  const qualRe = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/g;
  let qm: RegExpExecArray | null;
  while ((qm = qualRe.exec(tail)) !== null) {
    const prefix = qm[1]!.toUpperCase();
    const col = (qm[2] ?? qm[3] ?? '').toUpperCase();
    const resolvedTbl = aliasMap.get(prefix);
    if (resolvedTbl === tableName) {
      pushCol(col);
    }
  }

  // 2. Unqualified column predicates (`COL =`, `COL IN`, `COL >`, `COL <`, `COL BETWEEN`, `ORDER BY COL`)
  const unqualPredRe =
    /(?<![A-Za-z0-9_$.])(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*(?:=|>|<|>=|<=|\bIN\b|\bBETWEEN\b|\bSTARTING\s+WITH\b)/gi;
  let um: RegExpExecArray | null;
  while ((um = unqualPredRe.exec(tail)) !== null) {
    pushCol(um[1] ?? um[2] ?? '');
  }

  const orderRe = /\bORDER\s+BY\s+([\s\S]+?)(?:\bROWS\b|\bFETCH\b|$)/i.exec(tail);
  if (orderRe) {
    const parts = orderRe[1]!.split(',');
    for (const p of parts) {
      const tok = p
        .trim()
        .replace(/\b(?:ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)\b/gi, '')
        .trim();
      const dotIdx = tok.indexOf('.');
      if (dotIdx !== -1) {
        const al = tok.slice(0, dotIdx).trim().toUpperCase();
        const col = tok.slice(dotIdx + 1).replace(/"/g, '').trim();
        if (aliasMap.get(al) === tableName) pushCol(col);
      } else {
        pushCol(tok.replace(/"/g, ''));
      }
    }
  }

  return found.slice(0, 3);
}

function isPrefixCoveredByIndex(
  cols: readonly string[],
  indexes: readonly CatalogIndexRecord[],
): boolean {
  if (cols.length === 0) return true;
  for (const idx of indexes) {
    if (idx.inactive) continue;
    if (idx.columns.length < cols.length) continue;
    let match = true;
    for (let i = 0; i < cols.length; i++) {
      if (idx.columns[i] !== cols[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Create an adaptive Firebird workload & index advisor (`M28 Item 4`).
 */
export function createWorkloadAdvisor(
  db: WorkloadAdvisorDatabase,
  options: WorkloadAdvisorOptions = {},
): WorkloadAdvisorHandle {
  const maxTracked = Math.max(10, options.maxTrackedQueries ?? 150);
  const trackedSql = new Map<
    string,
    { sampleSql: string; executions: number; totalFetches: number; totalRows: number; totalMs: number }
  >();

  const recordSql: WorkloadAdvisorHandle['recordSql'] = (sql, metrics = {}) => {
    const trimmed = sql.trim();
    if (!trimmed || /\b(?:RDB\$|MON\$|FB_)/i.test(trimmed)) return;
    if (!/^\s*(?:SELECT|WITH|UPDATE|DELETE)\b/i.test(trimmed)) return;
    const key = normalizeSqlKey(trimmed);
    const prev = trackedSql.get(key);
    if (prev) {
      prev.executions += 1;
      prev.totalFetches += metrics.fetches ?? 0;
      prev.totalRows += metrics.rowCount ?? 0;
      prev.totalMs += metrics.durationMs ?? 0;
      return;
    }
    if (trackedSql.size >= maxTracked) {
      const oldest = trackedSql.keys().next().value;
      if (oldest !== undefined) trackedSql.delete(oldest);
    }
    trackedSql.set(key, {
      sampleSql: trimmed,
      executions: 1,
      totalFetches: metrics.fetches ?? 0,
      totalRows: metrics.rowCount ?? 0,
      totalMs: metrics.durationMs ?? 0,
    });
  };

  const unsub =
    options.captureLiveQueries !== false && typeof db.onQuery === 'function'
      ? db.onQuery((ev: QueryProfileEvent) => {
          if (ev.error) return;
          recordSql(ev.sql, {
            durationMs: ev.durationMs,
            fetches: ev.io?.fetches ?? 0,
            rowCount: ev.rowCount,
          });
        })
      : null;

  const loadCatalogIndexes = async (): Promise<CatalogIndexRecord[]> => {
    const res = await db.query<Record<string, unknown>>(
      `SELECT
         TRIM(I.RDB$INDEX_NAME) AS IDX_NAME,
         TRIM(I.RDB$RELATION_NAME) AS REL_NAME,
         COALESCE(I.RDB$UNIQUE_FLAG, 0) AS UNIQ,
         COALESCE(I.RDB$INDEX_TYPE, 0) AS IDX_TYPE,
         COALESCE(I.RDB$INDEX_INACTIVE, 0) AS INACTIVE,
         COALESCE(I.RDB$STATISTICS, -1) AS STATS,
         TRIM(S.RDB$FIELD_NAME) AS COL_NAME,
         S.RDB$FIELD_POSITION AS POS,
         (SELECT COUNT(*) FROM RDB$RELATION_CONSTRAINTS RC WHERE RC.RDB$INDEX_NAME = I.RDB$INDEX_NAME) AS IS_CONSTR
       FROM RDB$INDICES I
       JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME = I.RDB$INDEX_NAME
       WHERE COALESCE(I.RDB$SYSTEM_FLAG, 0) = 0
         AND TRIM(I.RDB$RELATION_NAME) NOT STARTING WITH 'FB_'
       ORDER BY I.RDB$INDEX_NAME, S.RDB$FIELD_POSITION`,
    );

    const byName = new Map<string, CatalogIndexRecord>();
    for (const r of res.rows) {
      const idxName = String(advCol(r, 'IDX_NAME') ?? '');
      const relName = String(advCol(r, 'REL_NAME') ?? '').toUpperCase();
      const colName = String(advCol(r, 'COL_NAME') ?? '').toUpperCase();
      if (!idxName || !relName || !colName) continue;
      let rec = byName.get(idxName);
      if (!rec) {
        rec = {
          indexName: idxName,
          tableName: relName,
          columns: [],
          unique: Number(advCol(r, 'UNIQ') ?? 0) === 1,
          descending: Number(advCol(r, 'IDX_TYPE') ?? 0) === 1,
          inactive: Number(advCol(r, 'INACTIVE') ?? 0) === 1,
          statistics: Number(advCol(r, 'STATS') ?? -1),
          isConstraintBacked: Number(advCol(r, 'IS_CONSTR') ?? 0) > 0,
        };
        byName.set(idxName, rec);
      }
      rec.columns.push(colName);
    }
    return [...byName.values()];
  };

  return {
    recordSql,

    async analyze(extraQueries: readonly string[] = []): Promise<WorkloadAdvisorReport> {
      for (const q of extraQueries) recordSql(q);
      if (typeof db.monitorStats === 'function') {
        const mon = await db.monitorStats().catch(() => null);
        for (const rq of mon?.recentQueries ?? []) {
          recordSql(rq.sql, {
            durationMs: rq.durationMs,
            fetches: rq.io?.fetches ?? 0,
            rowCount: rq.rowCount,
          });
        }
      }

      const schema =
        typeof db.introspect === 'function'
          ? await db.introspect()
          : await introspectCatalog({
              query: (s, p) => db.query(s, p),
              exec: async (s, p) => {
                if (typeof db.exec === 'function') await db.exec(s, p);
                else if (typeof db.execute === 'function') await db.execute(s, p);
                else await db.query(s, p);
              },
            });

      const userTables = schema.tables.filter((t) => !t.name.toUpperCase().startsWith('FB_'));
      const knownTableSet = new Set(userTables.map((t) => t.name.toUpperCase()));
      const colsByTable = new Map<string, Set<string>>();
      for (const t of userTables) {
        colsByTable.set(
          t.name.toUpperCase(),
          new Set(t.columns.map((c) => c.name.toUpperCase())),
        );
      }

      const allIndexes = await loadCatalogIndexes();
      const indexesByTable = new Map<string, CatalogIndexRecord[]>();
      for (const idx of allIndexes) {
        let list = indexesByTable.get(idx.tableName);
        if (!list) {
          list = [];
          indexesByTable.set(idx.tableName, list);
        }
        list.push(idx);
      }

      const recommendations: WorkloadAdvice[] = [];
      const seenAdviceKeys = new Set<string>();
      const pushAdvice = (adv: WorkloadAdvice): void => {
        const dedupe = `${adv.kind}:${adv.table}:${adv.columns.join(',')}:${adv.sql}`;
        if (seenAdviceKeys.has(dedupe)) return;
        seenAdviceKeys.add(dedupe);
        recommendations.push(adv);
      };

      // 1. Query Plan Analysis (NATURAL full-table scans on filtered/joined/ordered columns)
      let analyzedQueries = 0;
      let naturalScanQueries = 0;

      if (typeof db.explain === 'function') {
        for (const entry of trackedSql.values()) {
          analyzedQueries++;
          const planText = await db.explain(entry.sampleSql).catch(() => '');
          if (!planText) continue;
          const parsed = parseQueryPlan(planText);
          if (parsed.naturalScanCount > 0) {
            naturalScanQueries++;
            const aliasMap = extractAliasMap(entry.sampleSql, knownTableSet);
            const naturalTables = new Set<string>();
            for (const node of parsed.nodes) {
              if (node.accessMethod === 'NATURAL' && node.tableName) {
                const rel = node.tableName.toUpperCase();
                const resolved = aliasMap.get(rel) ?? (knownTableSet.has(rel) ? rel : null);
                if (resolved) naturalTables.add(resolved);
              }
            }
            for (const tbl of naturalTables) {
              const tblCols = colsByTable.get(tbl) ?? new Set<string>();
              const candCols = extractFilterAndOrderColumns(
                entry.sampleSql,
                tbl,
                tblCols,
                aliasMap,
              );
              const tblIndexes = indexesByTable.get(tbl) ?? [];
              if (candCols.length > 0 && !isPrefixCoveredByIndex(candCols, tblIndexes)) {
                const idxName = `IDX_${tbl}_${candCols.join('_')}`.slice(0, 31);
                const colsDdl = candCols.map(qAdvIdent).join(', ');
                pushAdvice({
                  id: `missing_${tbl}_${candCols.join('_').toLowerCase()}`,
                  kind: 'MISSING_FILTER_INDEX',
                  severity: 'high',
                  table: tbl,
                  columns: candCols,
                  sql: `CREATE INDEX ${qAdvIdent(idxName)} ON ${qAdvIdent(tbl)} (${colsDdl});`,
                  rationale: `Eliminate NATURAL full-table scan on ${tbl} for predicate/sort columns (${candCols.join(', ')}) (${entry.executions} execution(s)).`,
                  sampleQuery: entry.sampleSql,
                });
              }
            }
          }
        }
      }

      // 2. Unindexed Foreign Keys & Logical `*_ID` Reference Columns
      let unindexedForeignKeys = 0;
      for (const tbl of userTables) {
        const tUpper = tbl.name.toUpperCase();
        const tblIndexes = indexesByTable.get(tUpper) ?? [];

        for (const fk of tbl.foreignKeys) {
          const fkCols = fk.columns.map((c) => c.toUpperCase());
          if (!isPrefixCoveredByIndex(fkCols, tblIndexes)) {
            unindexedForeignKeys++;
            const idxName = `IDX_FK_${tUpper}_${fkCols.join('_')}`.slice(0, 31);
            pushAdvice({
              id: `fk_${tUpper}_${fkCols.join('_').toLowerCase()}`,
              kind: 'UNINDEXED_FOREIGN_KEY',
              severity: 'high',
              table: tUpper,
              columns: fkCols,
              sql: `CREATE INDEX ${qAdvIdent(idxName)} ON ${qAdvIdent(tUpper)} (${fkCols.map(qAdvIdent).join(', ')});`,
              rationale: `Foreign key ${fk.name} (${fkCols.join(', ')} -> ${fk.referencedTableName}) has no active supporting prefix index.`,
            });
          }
        }

        // Also detect unindexed `*_ID` reference columns matching another user table (e.g. `USER_ID` -> `USERS`)
        for (const col of tbl.columns) {
          const cUpper = col.name.toUpperCase();
          if (!cUpper.endsWith('_ID') || tbl.primaryKey.map((p) => p.toUpperCase())[0] === cUpper) {
            continue;
          }
          const stem = cUpper.slice(0, -3);
          const matchesTargetTable =
            knownTableSet.has(stem) ||
            knownTableSet.has(`${stem}S`) ||
            knownTableSet.has(`${stem}ES`);
          if (matchesTargetTable && !isPrefixCoveredByIndex([cUpper], tblIndexes)) {
            unindexedForeignKeys++;
            const idxName = `IDX_REF_${tUpper}_${cUpper}`.slice(0, 31);
            pushAdvice({
              id: `ref_${tUpper}_${cUpper.toLowerCase()}`,
              kind: 'UNINDEXED_FOREIGN_KEY',
              severity: 'medium',
              table: tUpper,
              columns: [cUpper],
              sql: `CREATE INDEX ${qAdvIdent(idxName)} ON ${qAdvIdent(tUpper)} (${qAdvIdent(cUpper)});`,
              rationale: `Reference column ${tUpper}.${cUpper} lacks a supporting index for joins and cascading lookups.`,
            });
          }
        }
      }

      // 3. Redundant Left-Prefix Indexes & Inactive/Stale Statistics
      let redundantIndexes = 0;
      for (const [tbl, list] of indexesByTable) {
        for (const idxA of list) {
          if (idxA.inactive) {
            pushAdvice({
              id: `inactive_${idxA.indexName.toLowerCase()}`,
              kind: 'INACTIVE_OR_STALE_INDEX',
              severity: 'low',
              table: tbl,
              columns: idxA.columns,
              sql: `ALTER INDEX ${qAdvIdent(idxA.indexName)} ACTIVE;`,
              rationale: `Index ${idxA.indexName} on ${tbl} is currently INACTIVE and ignored by the Firebird optimizer.`,
            });
            continue;
          }
          if (idxA.isConstraintBacked || idxA.unique) continue;

          const coveringSuper = list.find(
            (idxB) =>
              idxB.indexName !== idxA.indexName &&
              !idxB.inactive &&
              idxB.descending === idxA.descending &&
              idxB.columns.length > idxA.columns.length &&
              idxA.columns.every((col, pos) => idxB.columns[pos] === col),
          );
          if (coveringSuper) {
            redundantIndexes++;
            pushAdvice({
              id: `redundant_${idxA.indexName.toLowerCase()}`,
              kind: 'REDUNDANT_PREFIX_INDEX',
              severity: 'medium',
              table: tbl,
              columns: idxA.columns,
              sql: `DROP INDEX ${qAdvIdent(idxA.indexName)};`,
              rationale: `Non-unique index ${idxA.indexName} (${idxA.columns.join(', ')}) is a redundant left-prefix of ${coveringSuper.indexName} (${coveringSuper.columns.join(', ')}).`,
            });
          }
        }
      }

      const sevRank: Record<WorkloadAdviceSeverity, number> = { high: 0, medium: 1, low: 2 };
      recommendations.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

      return {
        analyzedQueries,
        naturalScanQueries,
        unindexedForeignKeys,
        redundantIndexes,
        recommendations,
        applySql: recommendations.map((r) => r.sql).join('\n'),
      };
    },

    async applyRecommendations(applyOpts = {}) {
      const report = await this.analyze();
      const allowedKinds = applyOpts.kinds ? new Set(applyOpts.kinds) : null;
      const allowedSev = applyOpts.severities ? new Set(applyOpts.severities) : null;

      const statements = report.recommendations
        .filter(
          (r) =>
            (!allowedKinds || allowedKinds.has(r.kind)) &&
            (!allowedSev || allowedSev.has(r.severity)),
        )
        .map((r) => r.sql);

      if (!applyOpts.dryRun) {
        for (const stmt of statements) {
          const clean = stmt.replace(/;\s*$/, '');
          if (typeof db.execute === 'function') await db.execute(clean);
          else if (typeof db.exec === 'function') await db.exec(clean);
          else await db.query(clean);
        }
      }
      return { statements, applied: !applyOpts.dryRun };
    },

    clear() {
      trackedSql.clear();
    },

    dispose() {
      unsub?.();
    },
  };
}
