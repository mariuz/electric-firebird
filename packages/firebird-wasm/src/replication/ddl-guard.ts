/**
 * Schema-Aware Replication & DDL Compatibility / Conflict Guard.
 */

import { introspect } from '../browser/schema';
import type { ReplicableDatabase } from './types';
import {
  isInternalReplicationTable,
  normalizeTableName,
  quoteIdent,
  toMigrationExecutor,
} from './shared';
import { discoverUserTables } from './catalog';

// ---------------------------------------------------------------------------
// 15. Schema-Aware Replication & DDL Compatibility / Conflict Guard (M15 Item 5)
// ---------------------------------------------------------------------------

/** High-level DDL operation category returned by {@link classifyDdlStatement}. */
export type DdlChangeCategory =
  | 'create-table'
  | 'drop-table'
  | 'add-column'
  | 'drop-column'
  | 'alter-column'
  | 'create-index'
  | 'drop-index'
  | 'other';

/** Structured classification of a SQL DDL statement returned by {@link classifyDdlStatement}. */
export interface ClassifiedDdlStatement {
  /** High-level DDL change category. */
  readonly category: DdlChangeCategory;
  /** Target upper-case table name (or `''` if not applicable). */
  readonly table: string;
  /** Target upper-case column name for `add-column` / `drop-column` / `alter-column` (or `null`). */
  readonly column: string | null;
  /** Column SQL type definition for `add-column` / `alter-column` (or `null`). */
  readonly columnType: string | null;
  /** `true` if the DDL statement is purely additive (`CREATE TABLE`, `ALTER TABLE ADD`, `CREATE INDEX`). */
  readonly isAdditive: boolean;
  /** `true` if the DDL statement drops or narrows existing schema objects (`DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN`). */
  readonly isDestructive: boolean;
  /** Original SQL statement trimmed. */
  readonly sql: string;
}

/** Decision returned by {@link resolveDdlConflict}. */
export interface DdlConflictResolution {
  /** Whether to execute (`'apply'`), ignore idempotently (`'skip'`), or block (`'reject'`) the DDL statement. */
  readonly action: 'apply' | 'skip' | 'reject';
  /** Human-readable explanation for the decision. */
  readonly reason: string;
  /** SQL statement to execute when `action === 'apply'`. */
  readonly sql?: string;
  /** Parsed classification of the DDL statement. */
  readonly classified: ClassifiedDdlStatement;
}

/** A single schema drift / compatibility issue detected between source and replica catalogs. */
export interface SchemaColumnCompatibilityIssue {
  /** Upper-case table name. */
  readonly table: string;
  /** Upper-case column name (`null` for table-level issues). */
  readonly column: string | null;
  /** Severity (`'compatible-additive'` when safe to replicate or `'breaking'` when replica will fail to apply). */
  readonly severity: 'compatible-additive' | 'breaking';
  /** Machine-readable issue code. */
  readonly code:
    | 'missing-replica-table'
    | 'missing-replica-column'
    | 'extra-replica-nullable-column'
    | 'extra-replica-not-null-column'
    | 'column-type-mismatch';
  /** Human-readable explanation. */
  readonly message: string;
  /** Optional suggested remediation DDL statement on the replica. */
  readonly suggestedDdl?: string;
}

/** Report returned by {@link checkReplicationSchemaCompatibility}. */
export interface ReplicationSchemaCompatibilityReport {
  /** `true` when no `'breaking'` issues exist across the inspected tables. */
  readonly compatible: boolean;
  /** List of all compatibility issues (`'compatible-additive'` and `'breaking'`). */
  readonly issues: readonly SchemaColumnCompatibilityIssue[];
  /** Suggested additive DDL statements that can bring the replica schema into compatibility. */
  readonly remediationDdl: readonly string[];
}

/**
 * Classify a Firebird SQL DDL statement into additive vs. destructive schema categories (`M15 Item 5`).
 */
export function classifyDdlStatement(ddlSql: string): ClassifiedDdlStatement {
  const sql = ddlSql.trim();

  // CREATE TABLE <name>
  const createTableMatch = /^\s*CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z0-9_$]+))/i.exec(
    sql,
  );
  if (createTableMatch) {
    const table = (createTableMatch[1] ?? createTableMatch[2] ?? '').toUpperCase();
    return {
      category: 'create-table',
      table,
      column: null,
      columnType: null,
      isAdditive: true,
      isDestructive: false,
      sql,
    };
  }

  // DROP TABLE <name>
  const dropTableMatch = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z0-9_$]+))/i.exec(
    sql,
  );
  if (dropTableMatch) {
    const table = (dropTableMatch[1] ?? dropTableMatch[2] ?? '').toUpperCase();
    return {
      category: 'drop-table',
      table,
      column: null,
      columnType: null,
      isAdditive: false,
      isDestructive: true,
      sql,
    };
  }

  // ALTER TABLE <table> ADD [COLUMN] <col> <type>
  const alterAddMatch =
    /^\s*ALTER\s+TABLE\s+(?:"([^"]+)"|([A-Za-z0-9_$]+))\s+ADD\s+(?:COLUMN\s+)?(?:"([^"]+)"|([A-Za-z0-9_$]+))\s+(.+?)\s*;?\s*$/is.exec(
      sql,
    );
  if (alterAddMatch) {
    const table = (alterAddMatch[1] ?? alterAddMatch[2] ?? '').toUpperCase();
    const column = (alterAddMatch[3] ?? alterAddMatch[4] ?? '').toUpperCase();
    const columnType = (alterAddMatch[5] ?? '').trim();
    return {
      category: 'add-column',
      table,
      column,
      columnType,
      isAdditive: true,
      isDestructive: false,
      sql,
    };
  }

  // ALTER TABLE <table> DROP [COLUMN] <col>
  const alterDropMatch =
    /^\s*ALTER\s+TABLE\s+(?:"([^"]+)"|([A-Za-z0-9_$]+))\s+DROP\s+(?:COLUMN\s+)?(?:"([^"]+)"|([A-Za-z0-9_$]+))/i.exec(
      sql,
    );
  if (alterDropMatch) {
    const table = (alterDropMatch[1] ?? alterDropMatch[2] ?? '').toUpperCase();
    const column = (alterDropMatch[3] ?? alterDropMatch[4] ?? '').toUpperCase();
    return {
      category: 'drop-column',
      table,
      column,
      columnType: null,
      isAdditive: false,
      isDestructive: true,
      sql,
    };
  }

  // ALTER TABLE <table> ALTER [COLUMN] <col> ...
  const alterColMatch =
    /^\s*ALTER\s+TABLE\s+(?:"([^"]+)"|([A-Za-z0-9_$]+))\s+ALTER\s+(?:COLUMN\s+)?(?:"([^"]+)"|([A-Za-z0-9_$]+))\s*(.*)$/is.exec(
      sql,
    );
  if (alterColMatch) {
    const table = (alterColMatch[1] ?? alterColMatch[2] ?? '').toUpperCase();
    const column = (alterColMatch[3] ?? alterColMatch[4] ?? '').toUpperCase();
    const rest = (alterColMatch[5] ?? '').trim();
    return {
      category: 'alter-column',
      table,
      column,
      columnType: rest || null,
      isAdditive: false,
      isDestructive: true,
      sql,
    };
  }

  // CREATE [UNIQUE] [ASC|DESC] INDEX <idx> ON <table>
  const createIdxMatch =
    /^\s*CREATE\s+(?:UNIQUE\s+)?(?:ASC(?:ENDING)?\s+|DESC(?:ENDING)?\s+)?INDEX\s+(?:"[^"]+"|[A-Za-z0-9_$]+)\s+ON\s+(?:"([^"]+)"|([A-Za-z0-9_$]+))/i.exec(
      sql,
    );
  if (createIdxMatch) {
    const table = (createIdxMatch[1] ?? createIdxMatch[2] ?? '').toUpperCase();
    return {
      category: 'create-index',
      table,
      column: null,
      columnType: null,
      isAdditive: true,
      isDestructive: false,
      sql,
    };
  }

  // DROP INDEX <idx>
  if (/^\s*DROP\s+INDEX\s+/i.test(sql)) {
    return {
      category: 'drop-index',
      table: '',
      column: null,
      columnType: null,
      isAdditive: false,
      isDestructive: true,
      sql,
    };
  }

  return {
    category: 'other',
    table: '',
    column: null,
    columnType: null,
    isAdditive: false,
    isDestructive: false,
    sql,
  };
}

/**
 * Resolve how an incoming DDL statement should be handled on a replica given its current
 * table columns and DDL replay policy (`M15 Item 5`).
 */
export function resolveDdlConflict(
  ddlSql: string,
  replicaTableColumns: readonly string[],
  options: {
    policy?: 'apply' | 'idempotent' | 'additive-only';
    tableExists?: boolean;
  } = {},
): DdlConflictResolution {
  const policy = options.policy ?? 'idempotent';
  const classified = classifyDdlStatement(ddlSql);
  const existingColsUpper = new Set(replicaTableColumns.map((c) => c.trim().toUpperCase()));
  const tableExists = options.tableExists ?? existingColsUpper.size > 0;

  if (policy === 'apply') {
    return {
      action: 'apply',
      reason: 'Policy is apply; executing DDL statement directly.',
      sql: classified.sql,
      classified,
    };
  }

  if (policy === 'additive-only' && classified.isDestructive) {
    return {
      action: 'reject',
      reason: `Destructive DDL (${classified.category} on ${classified.table || 'schema'}) rejected by additive-only policy.`,
      classified,
    };
  }

  if (classified.category === 'create-table' && tableExists) {
    return {
      action: 'skip',
      reason: `Table ${classified.table} already exists on replica; skipping duplicate CREATE TABLE idempotently.`,
      classified,
    };
  }

  if (
    classified.category === 'add-column' &&
    classified.column &&
    existingColsUpper.has(classified.column)
  ) {
    return {
      action: 'skip',
      reason: `Column ${classified.table}.${classified.column} already exists on replica; skipping duplicate ALTER TABLE ADD idempotently.`,
      classified,
    };
  }

  if (
    classified.category === 'drop-column' &&
    classified.column &&
    tableExists &&
    !existingColsUpper.has(classified.column)
  ) {
    return {
      action: 'skip',
      reason: `Column ${classified.table}.${classified.column} is already absent on replica; skipping duplicate ALTER TABLE DROP idempotently.`,
      classified,
    };
  }

  if (classified.category === 'drop-table' && !tableExists) {
    return {
      action: 'skip',
      reason: `Table ${classified.table} is already absent on replica; skipping duplicate DROP TABLE idempotently.`,
      classified,
    };
  }

  return {
    action: 'apply',
    reason: 'DDL statement is compatible and not yet applied on replica.',
    sql: classified.sql,
    classified,
  };
}

/**
 * Inspect `sourceDb` and `targetDb` catalogs (`introspect`) and verify whether
 * published tables on `sourceDb` can replicate cleanly into `targetDb`, reporting both
 * breaking missing columns/tables and compatible additive columns (`M15 Item 5`).
 */
export async function checkReplicationSchemaCompatibility(options: {
  sourceDb: ReplicableDatabase;
  targetDb: ReplicableDatabase;
  tables?: readonly string[];
}): Promise<ReplicationSchemaCompatibilityReport> {
  interface NormColInfo {
    name: string;
    type: string;
    nullable: boolean;
    hasDefault: boolean;
  }
  interface NormTableInfo {
    table: string;
    primaryKey: readonly string[];
    columns: Map<string, NormColInfo>;
  }

  const loadNormalizedCatalog = async (
    db: ReplicableDatabase,
  ): Promise<Map<string, NormTableInfo>> => {
    const out = new Map<string, NormTableInfo>();
    try {
      const schema = await introspect(toMigrationExecutor(db));
      if (schema.tables.length > 0) {
        for (const tbl of schema.tables) {
          const upper = normalizeTableName(tbl.name);
          if (isInternalReplicationTable(upper)) continue;
          const cols = new Map<string, NormColInfo>();
          for (const c of tbl.columns) {
            cols.set(c.name.trim().toUpperCase(), {
              name: c.name.trim().toUpperCase(),
              type: c.typeName.trim().toUpperCase(),
              nullable: c.nullable,
              hasDefault: c.defaultSource !== null && c.defaultSource !== undefined,
            });
          }
          out.set(upper, {
            table: upper,
            primaryKey: tbl.primaryKey.map((k) => k.toUpperCase()),
            columns: cols,
          });
        }
        if (out.size > 0) return out;
      }
    } catch {
      // Fallback to discoverUserTables
    }

    const discovered = await discoverUserTables(db);
    for (const d of discovered) {
      const upper = normalizeTableName(d.table);
      if (isInternalReplicationTable(upper)) continue;
      const cols = new Map<string, NormColInfo>();
      for (const colName of d.columns ?? ['ID']) {
        const cUpper = colName.trim().toUpperCase();
        cols.set(cUpper, {
          name: cUpper,
          type: 'VARCHAR(255)',
          nullable: cUpper !== 'ID',
          hasDefault: false,
        });
      }
      out.set(upper, {
        table: upper,
        primaryKey: (d.primaryKey ? (Array.isArray(d.primaryKey) ? d.primaryKey : [d.primaryKey]) : ['ID']).map((k) =>
          String(k).toUpperCase(),
        ),
        columns: cols,
      });
    }
    return out;
  };

  const [sourceCatalog, targetCatalog] = await Promise.all([
    loadNormalizedCatalog(options.sourceDb),
    loadNormalizedCatalog(options.targetDb),
  ]);

  const filterTables = options.tables
    ? new Set(options.tables.map((t) => normalizeTableName(t)))
    : null;

  const issues: SchemaColumnCompatibilityIssue[] = [];
  const remediationDdl: string[] = [];

  for (const [tableUpper, srcTable] of sourceCatalog.entries()) {
    if (filterTables && !filterTables.has(tableUpper)) continue;

    const tgtTable = targetCatalog.get(tableUpper);
    if (!tgtTable) {
      const colDefs = Array.from(srcTable.columns.values()).map((c) => {
        const notNull = !c.nullable ? ' NOT NULL' : '';
        return `${quoteIdent(c.name)} ${c.type}${notNull}`;
      });
      const pkClause =
        srcTable.primaryKey.length > 0
          ? `, PRIMARY KEY (${srcTable.primaryKey.map((k) => quoteIdent(k)).join(', ')})`
          : '';
      const createDdl = `CREATE TABLE ${quoteIdent(tableUpper)} (${colDefs.join(', ')}${pkClause})`;
      issues.push({
        table: tableUpper,
        column: null,
        severity: 'breaking',
        code: 'missing-replica-table',
        message: `Published table ${tableUpper} exists on source but is missing on replica.`,
        suggestedDdl: createDdl,
      });
      remediationDdl.push(createDdl);
      continue;
    }

    // 1. Check every source column exists on replica with compatible type
    for (const [colName, srcCol] of srcTable.columns.entries()) {
      const tgtCol = tgtTable.columns.get(colName);
      if (!tgtCol) {
        const addDdl = `ALTER TABLE ${quoteIdent(tableUpper)} ADD ${quoteIdent(colName)} ${srcCol.type}`;
        issues.push({
          table: tableUpper,
          column: colName,
          severity: 'breaking',
          code: 'missing-replica-column',
          message: `Column ${tableUpper}.${colName} (${srcCol.type}) is published by source but missing on replica.`,
          suggestedDdl: addDdl,
        });
        remediationDdl.push(addDdl);
        continue;
      }

      const normType = (t: string) => t.trim().toUpperCase().replace(/\s+/g, ' ');
      if (normType(srcCol.type) !== normType(tgtCol.type)) {
        issues.push({
          table: tableUpper,
          column: colName,
          severity: 'breaking',
          code: 'column-type-mismatch',
          message: `Column ${tableUpper}.${colName} has type ${srcCol.type} on source vs ${tgtCol.type} on replica.`,
        });
      }
    }

    // 2. Check extra columns present on replica but absent on source
    for (const [colName, tgtCol] of tgtTable.columns.entries()) {
      if (srcTable.columns.has(colName)) continue;
      if (tgtCol.nullable || tgtCol.hasDefault) {
        issues.push({
          table: tableUpper,
          column: colName,
          severity: 'compatible-additive',
          code: 'extra-replica-nullable-column',
          message: `Replica table ${tableUpper} has extra nullable/defaulted column ${colName} (${tgtCol.type}); source rows will replicate cleanly.`,
        });
      } else {
        issues.push({
          table: tableUpper,
          column: colName,
          severity: 'breaking',
          code: 'extra-replica-not-null-column',
          message: `Replica table ${tableUpper} has extra NOT NULL column ${colName} without a default value; source INSERTs will fail.`,
        });
      }
    }
  }

  const compatible = !issues.some((i) => i.severity === 'breaking');
  return {
    compatible,
    issues,
    remediationDdl,
  };
}

