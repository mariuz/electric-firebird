/**
 * schema.ts – Backend-agnostic schema introspection & transactional migrations
 * for both `FirebirdBrowser` (WASM) and `FirebirdLite` (Node.js).
 */

import type {
  AppliedMigration,
  ColumnSchemaInfo,
  FirebirdTypeName,
  ForeignKeySchemaInfo,
  IndexSchemaInfo,
  IntrospectOptions,
  MigratableDatabase,
  MigrateOptions,
  MigrateResult,
  Migration,
  MigrationExecutor,
  MigrationStep,
  PrimaryKeySchemaInfo,
  Row,
  SchemaIntrospection,
  SequenceSchemaInfo,
  TableSchemaInfo,
  TriggerSchemaInfo,
  ViewSchemaInfo,
} from '../types';
import { splitStatements } from './sql-script';

/** Default table name used by `migrate()` to record applied versions. */
export const DEFAULT_MIGRATIONS_TABLE = 'FB_MIGRATIONS$';

const INTERNAL_TABLES = new Set([
  'FB_MIGRATIONS$',
  'FB_WRITE_QUEUE$',
  'ELECTRIC_SHAPES',
  'ELECTRIC_WRITES',
  'KYSELY_MIGRATION',
  'KYSELY_MIGRATION_LOCK',
]);

function isSystemName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith('RDB$') ||
    upper.startsWith('MON$') ||
    upper.startsWith('SEC$') ||
    upper.startsWith('PLG$')
  );
}

function isInternalTableName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    INTERNAL_TABLES.has(upper) ||
    upper.startsWith('ELECTRIC_SHADOW$') ||
    upper.startsWith('ELECTRIC_META$')
  );
}

function isInternalTriggerName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('FB$LIVE_') || upper.startsWith('ELECTRIC_TRIG$');
}

function isInternalSequenceName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('ELECTRIC_');
}

function matchesTableFilter(relationName: string, filter?: string): boolean {
  if (!filter) return true;
  const trimmedFilter = filter.trim();
  if (!trimmedFilter) return true;
  return relationName.toUpperCase() === trimmedFilter.toUpperCase();
}

/**
 * Map Firebird `RDB$FIELD_TYPE`, `RDB$FIELD_SUB_TYPE`, `RDB$FIELD_SCALE`,
 * `RDB$FIELD_PRECISION`, and character/byte length to both a canonical
 * {@link FirebirdTypeName} (`dataType`) and a formatted SQL type string
 * (`typeName`).
 */
export function formatFirebirdColumnType(
  fieldType: number,
  subType: number,
  scale: number,
  precision: number,
  length: number,
): { dataType: FirebirdTypeName; typeName: string } {
  if (
    (fieldType === 7 || fieldType === 8 || fieldType === 16 || fieldType === 26) &&
    (scale < 0 || subType === 1 || subType === 2)
  ) {
    const sqlLabel = subType === 2 ? 'DECIMAL' : 'NUMERIC';
    const defaultPrec =
      fieldType === 7 ? 4 : fieldType === 8 ? 9 : fieldType === 16 ? 18 : 38;
    const prec = precision > 0 ? precision : defaultPrec;
    const absScale = Math.abs(scale);
    return {
      dataType: 'NUMERIC',
      typeName: `${sqlLabel}(${prec},${absScale})`,
    };
  }

  switch (fieldType) {
    case 7:
      return { dataType: 'SMALLINT', typeName: 'SMALLINT' };
    case 8:
      return { dataType: 'INTEGER', typeName: 'INTEGER' };
    case 10:
      return { dataType: 'FLOAT', typeName: 'FLOAT' };
    case 12:
      return { dataType: 'DATE', typeName: 'DATE' };
    case 13:
      return { dataType: 'TIME', typeName: 'TIME' };
    case 14:
      return {
        dataType: 'TEXT',
        typeName: length > 0 ? `CHAR(${length})` : 'CHAR',
      };
    case 16:
      return { dataType: 'BIGINT', typeName: 'BIGINT' };
    case 23:
      return { dataType: 'BOOLEAN', typeName: 'BOOLEAN' };
    case 24:
      return { dataType: 'DECFLOAT16', typeName: 'DECFLOAT(16)' };
    case 25:
      return { dataType: 'DECFLOAT34', typeName: 'DECFLOAT(34)' };
    case 26:
      return { dataType: 'INT128', typeName: 'INT128' };
    case 27:
      return { dataType: 'DOUBLE', typeName: 'DOUBLE PRECISION' };
    case 28:
      return { dataType: 'TIME_TZ', typeName: 'TIME WITH TIME ZONE' };
    case 29:
      return { dataType: 'TIMESTAMP_TZ', typeName: 'TIMESTAMP WITH TIME ZONE' };
    case 35:
      return { dataType: 'TIMESTAMP', typeName: 'TIMESTAMP' };
    case 37:
      return {
        dataType: 'VARYING',
        typeName: length > 0 ? `VARCHAR(${length})` : 'VARCHAR',
      };
    case 261:
      return {
        dataType: 'BLOB',
        typeName: subType === 1 ? 'BLOB SUB_TYPE TEXT' : 'BLOB',
      };
    default:
      return { dataType: 'UNKNOWN', typeName: `TYPE_${fieldType}` };
  }
}

/**
 * Decode a Firebird `RDB$TRIGGER_TYPE` integer into human-readable `timing`
 * (`'BEFORE'`, `'AFTER'`, or `'ON ...'`) and `events` (`['INSERT', ...]`).
 */
export function decodeFirebirdTriggerType(triggerType: number): {
  timing: string;
  events: string[];
} {
  switch (triggerType) {
    case 8192:
      return { timing: 'ON CONNECT', events: ['CONNECT'] };
    case 8193:
      return { timing: 'ON DISCONNECT', events: ['DISCONNECT'] };
    case 8194:
      return { timing: 'ON TRANSACTION START', events: ['TRANSACTION START'] };
    case 8195:
      return { timing: 'ON TRANSACTION COMMIT', events: ['TRANSACTION COMMIT'] };
    case 8196:
      return { timing: 'ON TRANSACTION ROLLBACK', events: ['TRANSACTION ROLLBACK'] };
  }

  const val = triggerType + 1;
  const timing = (val & 1) === 0 ? 'BEFORE' : 'AFTER';
  const slotMap: Record<number, string> = {
    1: 'INSERT',
    2: 'UPDATE',
    3: 'DELETE',
  };
  const events: string[] = [];
  for (const shift of [1, 3, 5]) {
    const code = (val >> shift) & 3;
    const ev = slotMap[code];
    if (ev && !events.includes(ev)) {
      events.push(ev);
    }
  }
  return { timing, events };
}

function pickField(row: Row, key: string): unknown {
  if (key in row) return row[key];
  const lower = key.toLowerCase();
  if (lower in row) return row[lower];
  const upper = key.toUpperCase();
  if (upper in row) return row[upper];
  return undefined;
}

function asTrimmedString(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function asNullableString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const trimmed = String(val).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Introspect a Firebird database's catalog (`RDB$RELATIONS`,
 * `RDB$RELATION_FIELDS`, `RDB$FIELDS`, `RDB$RELATION_CONSTRAINTS`,
 * `RDB$REF_CONSTRAINTS`, `RDB$INDICES`, `RDB$GENERATORS`, and `RDB$TRIGGERS`)
 * and return structured metadata.
 */
export async function introspect(
  db: MigrationExecutor,
  options: IntrospectOptions = {},
): Promise<SchemaIntrospection> {
  const includeSystem = options.includeSystem === true;
  const includeInternal = options.includeInternal === true;
  const tableFilter = options.tableName;

  const shouldIncludeRelation = (name: string, sysFlag: number): boolean => {
    if (!matchesTableFilter(name, tableFilter)) return false;
    if (!includeSystem && (sysFlag !== 0 || isSystemName(name))) return false;
    if (!includeInternal && isInternalTableName(name)) return false;
    return true;
  };

  // 1. Relations (tables & views)
  const relRes = await db.query(
    'SELECT TRIM(RDB$RELATION_NAME) AS REL_NAME, ' +
      'CASE WHEN RDB$VIEW_BLR IS NULL THEN 0 ELSE 1 END AS IS_VIEW, ' +
      'TRIM(CAST(RDB$VIEW_SOURCE AS VARCHAR(4096))) AS VIEW_SOURCE, ' +
      'COALESCE(RDB$SYSTEM_FLAG, 0) AS SYS_FLAG ' +
      'FROM RDB$RELATIONS ' +
      'ORDER BY RDB$RELATION_NAME',
  );

  const includedTables = new Set<string>();
  const includedViews = new Map<string, string | null>();
  for (const row of relRes.rows) {
    const name = asTrimmedString(pickField(row, 'REL_NAME'));
    const sysFlag = Number(pickField(row, 'SYS_FLAG') ?? 0);
    if (!name || !shouldIncludeRelation(name, sysFlag)) continue;
    const isView = Number(pickField(row, 'IS_VIEW') ?? 0) === 1;
    if (isView) {
      includedViews.set(name, asNullableString(pickField(row, 'VIEW_SOURCE')));
    } else {
      includedTables.add(name);
    }
  }

  const isIncludedRelation = (name: string): boolean =>
    includedTables.has(name) || includedViews.has(name);

  // 2. Primary keys
  const pkRes = await db.query(
    'SELECT TRIM(c.RDB$RELATION_NAME) AS REL_NAME, ' +
      'TRIM(c.RDB$CONSTRAINT_NAME) AS CONST_NAME, ' +
      'TRIM(c.RDB$INDEX_NAME) AS IDX_NAME, ' +
      'TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME, ' +
      'COALESCE(s.RDB$FIELD_POSITION, 0) AS FIELD_POS ' +
      'FROM RDB$RELATION_CONSTRAINTS c ' +
      'JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = c.RDB$INDEX_NAME ' +
      "WHERE c.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY' " +
      'ORDER BY c.RDB$RELATION_NAME, s.RDB$FIELD_POSITION',
  );

  const pkByTable = new Map<string, PrimaryKeySchemaInfo>();
  for (const row of pkRes.rows) {
    const tableName = asTrimmedString(pickField(row, 'REL_NAME'));
    if (!isIncludedRelation(tableName)) continue;
    const constraintName = asTrimmedString(pickField(row, 'CONST_NAME'));
    const indexName = asTrimmedString(pickField(row, 'IDX_NAME'));
    const fieldName = asTrimmedString(pickField(row, 'FIELD_NAME'));
    let entry = pkByTable.get(tableName);
    if (!entry) {
      entry = {
        tableName,
        constraintName,
        indexName,
        columns: [],
      };
      pkByTable.set(tableName, entry);
    }
    if (fieldName && !entry.columns.includes(fieldName)) {
      entry.columns.push(fieldName);
    }
  }
  const primaryKeys = Array.from(pkByTable.values());

  // 3. Columns
  const colRes = await db.query(
    'SELECT TRIM(rf.RDB$RELATION_NAME) AS REL_NAME, ' +
      'TRIM(rf.RDB$FIELD_NAME) AS FIELD_NAME, ' +
      'COALESCE(rf.RDB$FIELD_POSITION, 0) AS FIELD_POS, ' +
      'f.RDB$FIELD_TYPE AS FIELD_TYPE, ' +
      'COALESCE(f.RDB$FIELD_SUB_TYPE, 0) AS FIELD_SUB_TYPE, ' +
      'COALESCE(f.RDB$FIELD_SCALE, 0) AS FIELD_SCALE, ' +
      'COALESCE(f.RDB$FIELD_PRECISION, 0) AS FIELD_PRECISION, ' +
      'COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH, 0) AS FIELD_LEN, ' +
      'COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG, 0) AS NULL_FLAG, ' +
      'TRIM(CAST(COALESCE(rf.RDB$DEFAULT_SOURCE, f.RDB$DEFAULT_SOURCE) AS VARCHAR(1024))) AS DEFAULT_SRC, ' +
      'CASE WHEN rf.RDB$IDENTITY_TYPE IS NOT NULL THEN 1 ELSE 0 END AS IS_IDENTITY, ' +
      'CASE WHEN f.RDB$COMPUTED_BLR IS NOT NULL THEN 1 ELSE 0 END AS IS_COMPUTED ' +
      'FROM RDB$RELATION_FIELDS rf ' +
      'JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE ' +
      'ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION, rf.RDB$FIELD_NAME',
  );

  const columns: ColumnSchemaInfo[] = [];
  const colsByRelation = new Map<string, ColumnSchemaInfo[]>();
  for (const row of colRes.rows) {
    const tableName = asTrimmedString(pickField(row, 'REL_NAME'));
    if (!isIncludedRelation(tableName)) continue;
    const name = asTrimmedString(pickField(row, 'FIELD_NAME'));
    const position = Number(pickField(row, 'FIELD_POS') ?? 0);
    const fieldType = Number(pickField(row, 'FIELD_TYPE') ?? 0);
    const subType = Number(pickField(row, 'FIELD_SUB_TYPE') ?? 0);
    const scale = Number(pickField(row, 'FIELD_SCALE') ?? 0);
    const precision = Number(pickField(row, 'FIELD_PRECISION') ?? 0);
    const length = Number(pickField(row, 'FIELD_LEN') ?? 0);
    const nullFlag = Number(pickField(row, 'NULL_FLAG') ?? 0);
    const defaultSource = asNullableString(pickField(row, 'DEFAULT_SRC'));
    const isIdentity = Number(pickField(row, 'IS_IDENTITY') ?? 0) === 1;
    const isComputed = Number(pickField(row, 'IS_COMPUTED') ?? 0) === 1;
    const pkCols = pkByTable.get(tableName)?.columns ?? [];
    const isPrimaryKey = pkCols.includes(name);
    const { dataType, typeName } = formatFirebirdColumnType(
      fieldType,
      subType,
      scale,
      precision,
      length,
    );

    const colInfo: ColumnSchemaInfo = {
      tableName,
      name,
      position,
      typeName,
      dataType,
      fieldType,
      subType,
      scale,
      precision,
      length,
      nullable: nullFlag === 0,
      defaultSource,
      isIdentity,
      isComputed,
      isPrimaryKey,
    };
    columns.push(colInfo);
    const list = colsByRelation.get(tableName) ?? [];
    list.push(colInfo);
    colsByRelation.set(tableName, list);
  }

  // 4. Foreign keys
  const fkRes = await db.query(
    'SELECT TRIM(c.RDB$CONSTRAINT_NAME) AS CONST_NAME, ' +
      'TRIM(c.RDB$RELATION_NAME) AS REL_NAME, ' +
      'TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME, ' +
      'TRIM(uq.RDB$RELATION_NAME) AS REF_REL_NAME, ' +
      'TRIM(uqs.RDB$FIELD_NAME) AS REF_FIELD_NAME, ' +
      "TRIM(COALESCE(ref.RDB$UPDATE_RULE, 'RESTRICT')) AS UPDATE_RULE, " +
      "TRIM(COALESCE(ref.RDB$DELETE_RULE, 'RESTRICT')) AS DELETE_RULE, " +
      'COALESCE(s.RDB$FIELD_POSITION, 0) AS FIELD_POS ' +
      'FROM RDB$RELATION_CONSTRAINTS c ' +
      'JOIN RDB$REF_CONSTRAINTS ref ON ref.RDB$CONSTRAINT_NAME = c.RDB$CONSTRAINT_NAME ' +
      'JOIN RDB$RELATION_CONSTRAINTS uq ON uq.RDB$CONSTRAINT_NAME = ref.RDB$CONST_NAME_UQ ' +
      'JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = c.RDB$INDEX_NAME ' +
      'JOIN RDB$INDEX_SEGMENTS uqs ON uqs.RDB$INDEX_NAME = uq.RDB$INDEX_NAME AND uqs.RDB$FIELD_POSITION = s.RDB$FIELD_POSITION ' +
      "WHERE c.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' " +
      'ORDER BY c.RDB$RELATION_NAME, c.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION',
  );

  const fkMap = new Map<string, ForeignKeySchemaInfo>();
  const fksByTable = new Map<string, ForeignKeySchemaInfo[]>();
  for (const row of fkRes.rows) {
    const tableName = asTrimmedString(pickField(row, 'REL_NAME'));
    if (!isIncludedRelation(tableName)) continue;
    const name = asTrimmedString(pickField(row, 'CONST_NAME'));
    const fieldName = asTrimmedString(pickField(row, 'FIELD_NAME'));
    const referencedTableName = asTrimmedString(pickField(row, 'REF_REL_NAME'));
    const referencedFieldName = asTrimmedString(pickField(row, 'REF_FIELD_NAME'));
    const onUpdate = asTrimmedString(pickField(row, 'UPDATE_RULE')) || 'RESTRICT';
    const onDelete = asTrimmedString(pickField(row, 'DELETE_RULE')) || 'RESTRICT';

    const key = `${tableName}::${name}`;
    let fk = fkMap.get(key);
    if (!fk) {
      fk = {
        name,
        tableName,
        columns: [],
        referencedTableName,
        referencedColumns: [],
        onUpdate,
        onDelete,
      };
      fkMap.set(key, fk);
      const list = fksByTable.get(tableName) ?? [];
      list.push(fk);
      fksByTable.set(tableName, list);
    }
    if (fieldName) fk.columns.push(fieldName);
    if (referencedFieldName) fk.referencedColumns.push(referencedFieldName);
  }
  const foreignKeys = Array.from(fkMap.values());

  // 5. Indexes
  const idxRes = await db.query(
    'SELECT TRIM(i.RDB$INDEX_NAME) AS IDX_NAME, ' +
      'TRIM(i.RDB$RELATION_NAME) AS REL_NAME, ' +
      'COALESCE(i.RDB$UNIQUE_FLAG, 0) AS UNIQUE_FLAG, ' +
      'COALESCE(i.RDB$INDEX_TYPE, 0) AS IDX_TYPE, ' +
      'COALESCE(i.RDB$INDEX_INACTIVE, 0) AS IDX_INACTIVE, ' +
      'COALESCE(i.RDB$SYSTEM_FLAG, 0) AS SYS_FLAG, ' +
      'TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME, ' +
      'COALESCE(s.RDB$FIELD_POSITION, 0) AS FIELD_POS ' +
      'FROM RDB$INDICES i ' +
      'LEFT JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME ' +
      'ORDER BY i.RDB$RELATION_NAME, i.RDB$INDEX_NAME, s.RDB$FIELD_POSITION',
  );

  const idxMap = new Map<string, IndexSchemaInfo>();
  const idxsByTable = new Map<string, IndexSchemaInfo[]>();
  for (const row of idxRes.rows) {
    const tableName = asTrimmedString(pickField(row, 'REL_NAME'));
    if (!isIncludedRelation(tableName)) continue;
    const sysFlag = Number(pickField(row, 'SYS_FLAG') ?? 0);
    if (!includeSystem && sysFlag !== 0) continue;
    const name = asTrimmedString(pickField(row, 'IDX_NAME'));
    if (!name) continue;
    const unique = Number(pickField(row, 'UNIQUE_FLAG') ?? 0) === 1;
    const descending = Number(pickField(row, 'IDX_TYPE') ?? 0) === 1;
    const inactive = Number(pickField(row, 'IDX_INACTIVE') ?? 0) === 1;
    const fieldName = asTrimmedString(pickField(row, 'FIELD_NAME'));

    let idx = idxMap.get(name);
    if (!idx) {
      idx = {
        name,
        tableName,
        columns: [],
        unique,
        descending,
        inactive,
      };
      idxMap.set(name, idx);
      const list = idxsByTable.get(tableName) ?? [];
      list.push(idx);
      idxsByTable.set(tableName, list);
    }
    if (fieldName && !idx.columns.includes(fieldName)) {
      idx.columns.push(fieldName);
    }
  }
  const indexes = Array.from(idxMap.values());

  // 6. Sequences / Generators
  const seqRes = await db.query(
    'SELECT TRIM(RDB$GENERATOR_NAME) AS GEN_NAME, ' +
      'COALESCE(RDB$INITIAL_VALUE, 0) AS INIT_VAL, ' +
      'COALESCE(RDB$GENERATOR_INCREMENT, 1) AS INC_VAL, ' +
      'COALESCE(RDB$SYSTEM_FLAG, 0) AS SYS_FLAG ' +
      'FROM RDB$GENERATORS ' +
      'ORDER BY RDB$GENERATOR_NAME',
  );

  const sequences: SequenceSchemaInfo[] = [];
  for (const row of seqRes.rows) {
    const name = asTrimmedString(pickField(row, 'GEN_NAME'));
    if (!name) continue;
    const sysFlag = Number(pickField(row, 'SYS_FLAG') ?? 0);
    if (!includeSystem && (sysFlag !== 0 || isSystemName(name))) continue;
    if (!includeInternal && isInternalSequenceName(name)) continue;
    sequences.push({
      name,
      initialValue: Number(pickField(row, 'INIT_VAL') ?? 0),
      increment: Number(pickField(row, 'INC_VAL') ?? 1),
    });
  }

  // 7. Triggers
  const trgRes = await db.query(
    'SELECT TRIM(RDB$TRIGGER_NAME) AS TRG_NAME, ' +
      'TRIM(RDB$RELATION_NAME) AS REL_NAME, ' +
      'COALESCE(RDB$TRIGGER_TYPE, 0) AS TRG_TYPE, ' +
      'COALESCE(RDB$TRIGGER_SEQUENCE, 0) AS TRG_SEQ, ' +
      'COALESCE(RDB$TRIGGER_INACTIVE, 0) AS TRG_INACTIVE, ' +
      'TRIM(CAST(RDB$TRIGGER_SOURCE AS VARCHAR(4096))) AS TRG_SOURCE, ' +
      'COALESCE(RDB$SYSTEM_FLAG, 0) AS SYS_FLAG ' +
      'FROM RDB$TRIGGERS ' +
      'ORDER BY RDB$RELATION_NAME, RDB$TRIGGER_SEQUENCE, RDB$TRIGGER_NAME',
  );

  const triggers: TriggerSchemaInfo[] = [];
  const trgsByTable = new Map<string, TriggerSchemaInfo[]>();
  for (const row of trgRes.rows) {
    const name = asTrimmedString(pickField(row, 'TRG_NAME'));
    if (!name) continue;
    const sysFlag = Number(pickField(row, 'SYS_FLAG') ?? 0);
    if (!includeSystem && (sysFlag !== 0 || isSystemName(name))) continue;
    if (!includeInternal && isInternalTriggerName(name)) continue;

    const rawRel = asTrimmedString(pickField(row, 'REL_NAME'));
    const tableName = rawRel.length > 0 ? rawRel : null;
    if (tableName !== null && !isIncludedRelation(tableName)) continue;
    if (tableFilter && tableName === null) continue;

    const triggerType = Number(pickField(row, 'TRG_TYPE') ?? 0);
    const sequence = Number(pickField(row, 'TRG_SEQ') ?? 0);
    const inactive = Number(pickField(row, 'TRG_INACTIVE') ?? 0) === 1;
    const source = asNullableString(pickField(row, 'TRG_SOURCE'));
    const { timing, events } = decodeFirebirdTriggerType(triggerType);

    const trg: TriggerSchemaInfo = {
      name,
      tableName,
      triggerType,
      timing,
      events,
      sequence,
      inactive,
      source,
    };
    triggers.push(trg);
    if (tableName) {
      const list = trgsByTable.get(tableName) ?? [];
      list.push(trg);
      trgsByTable.set(tableName, list);
    }
  }

  // 8. Assemble tables and views
  const tables: TableSchemaInfo[] = [];
  for (const name of includedTables) {
    tables.push({
      name,
      columns: colsByRelation.get(name) ?? [],
      primaryKey: pkByTable.get(name)?.columns ?? [],
      foreignKeys: fksByTable.get(name) ?? [],
      indexes: idxsByTable.get(name) ?? [],
      triggers: trgsByTable.get(name) ?? [],
    });
  }

  const views: ViewSchemaInfo[] = [];
  for (const [name, source] of includedViews.entries()) {
    views.push({
      name,
      columns: colsByRelation.get(name) ?? [],
      source,
    });
  }

  return {
    tables,
    views,
    columns,
    primaryKeys,
    foreignKeys,
    indexes,
    sequences,
    triggers,
  };
}

function normalizeMigrationsTableName(tableName?: string): {
  rawUpper: string;
  quoted: string;
} {
  const name = (tableName ?? DEFAULT_MIGRATIONS_TABLE).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(
      `Invalid migrations table name "${name}". Must match /^[A-Za-z_][A-Za-z0-9_$]*$/.`,
    );
  }
  const rawUpper = name.toUpperCase();
  return { rawUpper, quoted: `"${rawUpper}"` };
}

async function ensureMigrationsTable(
  db: MigratableDatabase,
  rawUpper: string,
  quoted: string,
): Promise<void> {
  const existing = await db.query(
    'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [rawUpper],
  );
  if (existing.rows.length > 0) return;

  const ddl =
    `CREATE TABLE ${quoted} (` +
    'SEQ INTEGER NOT NULL, ' +
    'VERSION VARCHAR(128) NOT NULL PRIMARY KEY, ' +
    'NAME VARCHAR(255), ' +
    'APPLIED_AT VARCHAR(64) NOT NULL' +
    ')';

  if (typeof db.transaction === 'function') {
    await db.transaction(async (tx) => {
      const check = await tx.query(
        'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
        [rawUpper],
      );
      if (check.rows.length === 0) {
        await tx.exec(ddl);
      }
    });
  } else {
    await db.exec(ddl);
  }
}

/**
 * Read the list of applied migrations from `FB_MIGRATIONS$` (or a custom
 * migration table). Returns `[]` if the migrations table has not been created
 * yet.
 */
export async function getAppliedMigrations(
  db: MigrationExecutor,
  options: Pick<MigrateOptions, 'tableName'> = {},
): Promise<AppliedMigration[]> {
  const { rawUpper, quoted } = normalizeMigrationsTableName(options.tableName);
  const exists = await db.query(
    'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [rawUpper],
  );
  if (exists.rows.length === 0) {
    return [];
  }

  const res = await db.query(
    `SELECT VERSION, NAME, APPLIED_AT FROM ${quoted} ORDER BY SEQ ASC, VERSION ASC`,
  );
  return res.rows.map((row) => ({
    version: asTrimmedString(pickField(row, 'VERSION')),
    name: asNullableString(pickField(row, 'NAME')),
    appliedAt: asTrimmedString(pickField(row, 'APPLIED_AT')),
  }));
}

async function runInTransaction<T>(
  db: MigratableDatabase,
  fn: (tx: MigrationExecutor) => Promise<T>,
): Promise<T> {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn);
  }
  return fn(db);
}

async function executeMigrationStep(
  tx: MigrationExecutor,
  step: MigrationStep,
): Promise<void> {
  if (typeof step === 'function') {
    await step(tx);
    return;
  }
  if (typeof step === 'string') {
    const statements = splitStatements(step);
    for (const stmt of statements) {
      await tx.exec(stmt.sql);
    }
    return;
  }
  for (const item of step) {
    const statements = splitStatements(item);
    for (const stmt of statements) {
      await tx.exec(stmt.sql);
    }
  }
}

function normalizeVersion(version: number | string): string {
  const s = String(version).trim();
  if (!s) {
    throw new Error('Migration version must not be empty');
  }
  return s;
}

/**
 * Run pending schema migrations (or revert applied migrations when
 * `options.direction === 'down'`) transactionally and record applied versions
 * in `FB_MIGRATIONS$`.
 */
export async function migrate(
  db: MigratableDatabase,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const { rawUpper, quoted } = normalizeMigrationsTableName(options.tableName);
  const direction = options.direction ?? 'up';

  // Validate migration list & check for duplicate versions
  const seenVersions = new Set<string>();
  const normalized = migrations.map((m) => {
    const version = normalizeVersion(m.version);
    if (seenVersions.has(version)) {
      throw new Error(`Duplicate migration version "${version}"`);
    }
    seenVersions.add(version);
    return {
      ...m,
      versionStr: version,
    };
  });

  await ensureMigrationsTable(db, rawUpper, quoted);
  const history = await getAppliedMigrations(db, { tableName: rawUpper });
  const appliedMap = new Map<string, AppliedMigration>();
  for (const item of history) {
    appliedMap.set(item.version, item);
  }

  const applied: AppliedMigration[] = [];
  const reverted: AppliedMigration[] = [];

  if (direction === 'up') {
    const targetStr =
      options.targetVersion !== undefined
        ? normalizeVersion(options.targetVersion)
        : undefined;
    if (targetStr !== undefined && !seenVersions.has(targetStr)) {
      throw new Error(`Target migration version "${targetStr}" not found in migrations list`);
    }

    let nextSeq = history.length + 1;
    for (const m of normalized) {
      if (!appliedMap.has(m.versionStr)) {
        const appliedAt = new Date().toISOString();
        const name = m.name ?? null;
        const seq = nextSeq++;

        await runInTransaction(db, async (tx) => {
          await executeMigrationStep(tx, m.up);
          await tx.exec(
            `INSERT INTO ${quoted} (SEQ, VERSION, NAME, APPLIED_AT) VALUES (?, ?, ?, ?)`,
            [seq, m.versionStr, name, appliedAt],
          );
        });

        const record: AppliedMigration = {
          version: m.versionStr,
          name,
          appliedAt,
        };
        applied.push(record);
        appliedMap.set(m.versionStr, record);
      }

      if (targetStr !== undefined && m.versionStr === targetStr) {
        break;
      }
    }
  } else {
    // direction === 'down'
    const byVersion = new Map(normalized.map((m) => [m.versionStr, m]));
    const reversedHistory = [...history].reverse();

    const hasExplicitTarget = options.targetVersion !== undefined;
    const targetStr = hasExplicitTarget ? String(options.targetVersion).trim() : undefined;
    const revertAll =
      hasExplicitTarget && (targetStr === '' || targetStr === '0');

    if (
      hasExplicitTarget &&
      !revertAll &&
      targetStr !== undefined &&
      !appliedMap.has(targetStr) &&
      !seenVersions.has(targetStr)
    ) {
      throw new Error(`Target migration version "${targetStr}" not found`);
    }

    for (let i = 0; i < reversedHistory.length; i++) {
      const current = reversedHistory[i]!;
      if (hasExplicitTarget && !revertAll && current.version === targetStr) {
        break;
      }

      const def = byVersion.get(current.version);
      if (!def) {
        throw new Error(
          `Cannot revert migration "${current.version}": definition not found in migrations list`,
        );
      }
      if (!def.down) {
        throw new Error(
          `Cannot revert migration "${current.version}": no "down" step defined`,
        );
      }

      await runInTransaction(db, async (tx) => {
        await executeMigrationStep(tx, def.down!);
        await tx.exec(`DELETE FROM ${quoted} WHERE VERSION = ?`, [
          current.version,
        ]);
      });

      reverted.push(current);

      if (!hasExplicitTarget) {
        // Default for direction: 'down' without targetVersion: revert the latest 1 migration
        break;
      }
    }
  }

  const updatedHistory = await getAppliedMigrations(db, { tableName: rawUpper });
  const currentVersion =
    updatedHistory.length > 0
      ? updatedHistory[updatedHistory.length - 1]!.version
      : null;

  return {
    applied,
    reverted,
    currentVersion,
    history: updatedHistory,
  };
}
