/**
 * data-seeder.ts – Deterministic PII Anonymizer (`anonymizeDatabase`) &
 * Foreign-Key-Aware Synthetic Database Seeder (`seedDatabase`) (`M26 Item 4`).
 */

import { introspect as introspectCatalog, generateMigration } from './browser/schema';
import type {
  ColumnSchemaInfo,
  ForeignKeySchemaInfo,
  QueryParams,
  QueryResult,
  Row,
  SchemaIntrospection,
} from './types';

/** Minimal database executor required by {@link seedDatabase} and {@link anonymizeDatabase} (`M26 Item 4`). */
export interface SeederDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<unknown>;
  execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
  introspect?(): Promise<SchemaIntrospection>;
}

/** Built-in deterministic PII scrubbing strategies (`M26 Item 4`). */
export type BuiltinAnonymizeKind =
  | 'email'
  | 'name'
  | 'full-name'
  | 'first-name'
  | 'last-name'
  | 'phone'
  | 'uuid'
  | 'ip'
  | 'redact'
  | 'hash'
  | 'number-jitter'
  | 'null';

/** Context passed to a custom column anonymizer callback (`M26 Item 4`). */
export interface AnonymizeRuleContext {
  readonly table: string;
  readonly column: string;
  readonly row: Record<string, unknown>;
  readonly rowIndex: number;
  readonly seed: number;
}

/** Rule specification for a single column (`M26 Item 4`). */
export type AnonymizeColumnRule =
  | BuiltinAnonymizeKind
  | ((value: unknown, ctx: AnonymizeRuleContext) => unknown | Promise<unknown>);

/**
 * Rules map accepted by {@link anonymizeDatabase}: either flat `'TABLE.COLUMN'` / `'*.COLUMN'`
 * keys or nested `{ [table]: { [column]: rule } }` (`M26 Item 4`).
 */
export type AnonymizeRulesMap = Readonly<
  Record<string, AnonymizeColumnRule | Readonly<Record<string, AnonymizeColumnRule>>>
>;

/** Options for {@link anonymizeDatabase} (`M26 Item 4`). */
export interface AnonymizeDatabaseOptions {
  /** Column scrubbing rules keyed by `'TABLE.COLUMN'`, `'*.COLUMN'`, or `{ TABLE: { COLUMN: rule } }`. */
  rules: AnonymizeRulesMap;
  /** Deterministic PRNG / hash seed (`equal seed + equal input -> equal scrubbed output`). @default 42 */
  seed?: number;
  /** Optional subset of tables to process. */
  tables?: readonly string[];
  /** Batch size for bulk `execBatch` writes. @default 250 */
  batchSize?: number;
}

/** Summary returned by {@link anonymizeDatabase} (`M26 Item 4`). */
export interface AnonymizeDatabaseResult {
  readonly tablesProcessed: readonly string[];
  readonly rowsProcessed: number;
  readonly columnsScrubbed: number;
  readonly inPlace: boolean;
}

/** Generator context passed to custom `seedDatabase` column overrides (`M26 Item 4`). */
export interface SeedColumnContext {
  readonly table: string;
  readonly column: string;
  readonly rowIndex: number;
  readonly seed: number;
  readonly rng: () => number;
  readonly row: Readonly<Record<string, unknown>>;
}

export type SeedColumnOverride =
  | unknown
  | ((ctx: SeedColumnContext) => unknown | Promise<unknown>);

/** Options for {@link seedDatabase} (`M26 Item 4`). */
export interface SeedDatabaseOptions {
  /** Optional subset of user tables to seed (defaults to all user tables in FK order). */
  tables?: readonly string[];
  /** Number of synthetic rows to insert per table (or `{ TABLE: count }`). @default 10 */
  rowsPerTable?: number | Readonly<Record<string, number>>;
  /** Deterministic PRNG seed for reproducible fixtures. @default 42 */
  seed?: number;
  /** Optional per-table/column custom value or generator overrides. */
  overrides?: Readonly<Record<string, Readonly<Record<string, SeedColumnOverride>>>>;
  /** Delete existing rows in reverse FK order before seeding. @default false */
  truncateFirst?: boolean;
  /** Batch size for `execBatch` inserts. @default 250 */
  batchSize?: number;
}

/** Summary returned by {@link seedDatabase} (`M26 Item 4`). */
export interface SeedDatabaseResult {
  readonly insertionOrder: readonly string[];
  readonly rowsInsertedByTable: Readonly<Record<string, number>>;
  readonly totalRowsInserted: number;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG & Hashing Primitives
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery',
  'Quinn', 'Dana', 'Sam', 'Robin', 'Cameron', 'Drew', 'Hayden', 'logan',
];

const LAST_NAMES = [
  'Rivera', 'Patel', 'Chen', 'Kim', 'Nguyen', 'Silva', 'Kowalski', 'Hansen',
  'Moreau', 'Okafor', 'berg', 'Reyes', 'Lindqvist', 'Navarro', 'Sato', 'Costa',
];

const SAMPLE_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
];

function createSeededRng(seed: number): () => number {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function deterministicHex(input: string, seed: number, hexChars: number): string {
  let out = '';
  let round = 0;
  while (out.length < hexChars) {
    const h1 = fnv1a32(`${round}:a:${input}`, seed + round * 31);
    const h2 = fnv1a32(`${round}:b:${input}`, (seed ^ 0x9e3779b9) + round * 97);
    out += h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    round += 1;
  }
  return out.slice(0, hexChars);
}

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function execSql(
  db: SeederDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
  } else if (typeof db.execute === 'function') {
    await db.execute(sql, params);
  } else {
    await db.query(sql, params);
  }
}

async function execBatchSql(
  db: SeederDatabaseExecutor,
  sql: string,
  rows: QueryParams[],
  batchSize: number,
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    if (typeof db.execBatch === 'function') {
      await db.execBatch(sql, slice);
    } else {
      for (const r of slice) {
        await execSql(db, sql, r);
      }
    }
  }
}

async function getSchema(db: SeederDatabaseExecutor): Promise<SchemaIntrospection> {
  if (typeof db.introspect === 'function') {
    return db.introspect();
  }
  return introspectCatalog({
    query: (s, p) => db.query(s, p),
    exec: (s, p) => execSql(db, s, p),
  });
}

/**
 * Topologically sort table names so referenced parent tables precede referencing
 * child tables (`M26 Item 4`). Self-references are ignored for ordering.
 */
export function sortTablesByForeignKeys(
  tableNames: readonly string[],
  foreignKeys: readonly ForeignKeySchemaInfo[],
): string[] {
  const upperSet = new Set(tableNames.map((t) => t.toUpperCase()));
  const origByUpper = new Map<string, string>();
  for (const t of tableNames) origByUpper.set(t.toUpperCase(), t);

  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const u of upperSet) {
    deps.set(u, new Set());
    dependents.set(u, new Set());
  }

  for (const fk of foreignKeys) {
    const child = fk.tableName.toUpperCase();
    const parent = fk.referencedTableName.toUpperCase();
    if (child === parent || !upperSet.has(child) || !upperSet.has(parent)) {
      continue;
    }
    deps.get(child)!.add(parent);
    dependents.get(parent)!.add(child);
  }

  const inDegree = new Map<string, number>();
  for (const [u, d] of deps.entries()) {
    inDegree.set(u, d.size);
  }

  const ready = [...upperSet].filter((u) => (inDegree.get(u) ?? 0) === 0).sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const curr = ready.shift()!;
    ordered.push(origByUpper.get(curr)!);
    for (const child of dependents.get(curr) ?? []) {
      const nextDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, nextDeg);
      if (nextDeg === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  // Fallback for cyclic FKs: append remaining deterministically
  if (ordered.length < upperSet.size) {
    const seen = new Set(ordered.map((t) => t.toUpperCase()));
    for (const u of [...upperSet].sort()) {
      if (!seen.has(u)) ordered.push(origByUpper.get(u)!);
    }
  }

  return ordered;
}

function fitLength(val: string, col?: ColumnSchemaInfo): string {
  if (!col || col.length <= 0) return val;
  if (
    col.dataType === 'VARYING' ||
    col.dataType === 'TEXT' ||
    col.typeName.toUpperCase().startsWith('VARCHAR') ||
    col.typeName.toUpperCase().startsWith('CHAR')
  ) {
    return val.length > col.length ? val.slice(0, col.length) : val;
  }
  return val;
}

function applyBuiltinRule(
  kind: BuiltinAnonymizeKind,
  value: unknown,
  seed: number,
  col?: ColumnSchemaInfo,
): unknown {
  if (kind === 'null') return null;
  if (value === null || value === undefined) return value;

  const raw = String(value);
  const h = fnv1a32(raw, seed);

  switch (kind) {
    case 'email': {
      const tag = deterministicHex(raw, seed, 8);
      return fitLength(`user_${tag}@example.invalid`, col);
    }
    case 'first-name': {
      const first = FIRST_NAMES[h % FIRST_NAMES.length]!;
      return fitLength(first.charAt(0).toUpperCase() + first.slice(1), col);
    }
    case 'last-name': {
      const last = LAST_NAMES[(h >>> 4) % LAST_NAMES.length]!;
      return fitLength(last.charAt(0).toUpperCase() + last.slice(1), col);
    }
    case 'name':
    case 'full-name': {
      const f = FIRST_NAMES[h % FIRST_NAMES.length]!;
      const l = LAST_NAMES[(h >>> 5) % LAST_NAMES.length]!;
      const full = `${f.charAt(0).toUpperCase()}${f.slice(1)} ${l.charAt(0).toUpperCase()}${l.slice(1)}`;
      return fitLength(full, col);
    }
    case 'phone': {
      const d1 = String(100 + (h % 900));
      const d2 = String(1000 + ((h >>> 10) % 9000));
      return fitLength(`+1-555-${d1}-${d2}`, col);
    }
    case 'uuid': {
      const hex = deterministicHex(raw, seed, 32);
      const uuid =
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
        `a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      return fitLength(uuid, col);
    }
    case 'ip': {
      const host = 1 + (h % 254);
      return fitLength(`198.51.100.${host}`, col);
    }
    case 'redact':
      return fitLength('[REDACTED]', col);
    case 'hash':
      return fitLength(deterministicHex(raw, seed, 32), col);
    case 'number-jitter': {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) return value;
      const factor = 0.85 + ((h % 3001) / 3000) * 0.3; // [0.85, 1.15]
      const jittered = num * factor;
      if (col && col.scale < 0) {
        const decimals = Math.min(8, -col.scale);
        return Number(jittered.toFixed(decimals));
      }
      return Number.isInteger(num) ? Math.round(jittered) : Number(jittered.toFixed(4));
    }
  }
}

function normalizeRulesLookup(
  rules: AnonymizeRulesMap,
): (table: string, column: string) => AnonymizeColumnRule | undefined {
  const exact = new Map<string, AnonymizeColumnRule>();
  const wildcard = new Map<string, AnonymizeColumnRule>();

  for (const [k, v] of Object.entries(rules)) {
    if (typeof v === 'string' || typeof v === 'function') {
      const dot = k.indexOf('.');
      if (dot !== -1) {
        const tbl = k.slice(0, dot).trim().toUpperCase();
        const col = k.slice(dot + 1).trim().toUpperCase();
        if (tbl === '*') wildcard.set(col, v);
        else exact.set(`${tbl}.${col}`, v);
      } else {
        wildcard.set(k.trim().toUpperCase(), v);
      }
    } else if (v && typeof v === 'object') {
      const tbl = k.trim().toUpperCase();
      for (const [colKey, colRule] of Object.entries(v)) {
        const col = colKey.trim().toUpperCase();
        if (tbl === '*') wildcard.set(col, colRule);
        else exact.set(`${tbl}.${col}`, colRule);
      }
    }
  }

  return (table: string, column: string) => {
    const t = table.toUpperCase();
    const c = column.toUpperCase();
    return exact.get(`${t}.${c}`) ?? wildcard.get(c);
  };
}

function readRowFieldCI(row: Record<string, unknown>, col: string): unknown {
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

/**
 * Scrub PII columns deterministically either in-place or from `sourceDb` into `targetDb`,
 * preserving relational integrity (`M26 Item 4`).
 */
export async function anonymizeDatabase(
  sourceDb: SeederDatabaseExecutor,
  targetDbOrInPlace: SeederDatabaseExecutor | 'in-place' | null | undefined,
  options: AnonymizeDatabaseOptions,
): Promise<AnonymizeDatabaseResult> {
  const inPlace =
    !targetDbOrInPlace ||
    targetDbOrInPlace === 'in-place' ||
    targetDbOrInPlace === sourceDb;
  const targetDb = inPlace ? sourceDb : targetDbOrInPlace;
  const seed = options.seed ?? 42;
  const batchSize = Math.max(1, options.batchSize ?? 250);
  const lookupRule = normalizeRulesLookup(options.rules);

  const sourceSchema = await getSchema(sourceDb);
  if (!inPlace) {
    const targetSchema = await getSchema(targetDb);
    const mig = await generateMigration(targetSchema, sourceSchema, {
      quoteIdentifiers: true,
    });
    for (const rawDdl of mig.up) {
      const ddl = rawDdl.replace(/\bCONSTRAINT\s+(?:"INTEG_\d+"|INTEG_\d+)\s+/gi, '');
      await execSql(targetDb, ddl);
    }
  }

  const requestedSet = options.tables
    ? new Set(options.tables.map((t) => t.trim().toUpperCase()))
    : null;
  const candidateTables = sourceSchema.tables
    .map((t) => t.name)
    .filter((name) => !requestedSet || requestedSet.has(name.toUpperCase()));

  const orderedTables = sortTablesByForeignKeys(candidateTables, sourceSchema.foreignKeys);

  let rowsProcessed = 0;
  let columnsScrubbed = 0;
  const tablesProcessed: string[] = [];

  for (const tblName of orderedTables) {
    const upperTbl = tblName.toUpperCase();
    const cols = sourceSchema.columns
      .filter((c) => c.tableName.toUpperCase() === upperTbl && !c.isComputed)
      .sort((a, b) => a.position - b.position);
    if (cols.length === 0) continue;

    const pkInfo = sourceSchema.primaryKeys.find(
      (pk) => pk.tableName.toUpperCase() === upperTbl,
    );
    const pkCols = pkInfo?.columns ?? [];
    const ruleCols = cols.filter((c) => lookupRule(upperTbl, c.name) !== undefined);

    if (inPlace && ruleCols.length === 0) {
      continue;
    }

    const selectSql = inPlace && pkCols.length === 0
      ? `SELECT RDB$DB_KEY AS "__FB_DB_KEY__", ${cols.map((c) => quoteId(c.name)).join(', ')} FROM ${quoteId(tblName)}`
      : `SELECT ${cols.map((c) => quoteId(c.name)).join(', ')} FROM ${quoteId(tblName)}`;

    const res = await sourceDb.query<Record<string, unknown>>(selectSql);
    tablesProcessed.push(tblName);
    if (res.rows.length === 0) continue;

    if (inPlace) {
      const setClause = ruleCols.map((c) => `${quoteId(c.name)} = ?`).join(', ');
      const whereClause =
        pkCols.length > 0
          ? pkCols.map((pk) => `${quoteId(pk)} = ?`).join(' AND ')
          : `RDB$DB_KEY = ?`;
      const updateSql = `UPDATE ${quoteId(tblName)} SET ${setClause} WHERE ${whereClause}`;
      const paramRows: QueryParams[] = [];

      for (let rIdx = 0; rIdx < res.rows.length; rIdx++) {
        const row = res.rows[rIdx]!;
        const setParams: unknown[] = [];
        for (const c of ruleCols) {
          const rule = lookupRule(upperTbl, c.name)!;
          const origVal = readRowFieldCI(row, c.name);
          const scrubbed =
            typeof rule === 'function'
              ? await rule(origVal, {
                  table: upperTbl,
                  column: c.name,
                  row,
                  rowIndex: rIdx,
                  seed,
                })
              : applyBuiltinRule(rule, origVal, seed, c);
          setParams.push(scrubbed);
          columnsScrubbed += 1;
        }
        const whereParams =
          pkCols.length > 0
            ? pkCols.map((pk) => readRowFieldCI(row, pk))
            : [row.__FB_DB_KEY__ ?? row.__fb_db_key__];
        paramRows.push([...setParams, ...whereParams]);
        rowsProcessed += 1;
      }

      await execBatchSql(targetDb, updateSql, paramRows, batchSize);
    } else {
      const insertCols = cols;
      const hasIdentityAlways = insertCols.some(
        (c) => c.isIdentity && !(c.defaultSource ?? '').toUpperCase().includes('BY DEFAULT'),
      );
      const overridingClause = hasIdentityAlways ? ' OVERRIDING SYSTEM VALUE' : '';
      const insertSql =
        `INSERT INTO ${quoteId(tblName)} (${insertCols.map((c) => quoteId(c.name)).join(', ')})` +
        `${overridingClause} VALUES (${insertCols.map(() => '?').join(', ')})`;

      const paramRows: QueryParams[] = [];
      for (let rIdx = 0; rIdx < res.rows.length; rIdx++) {
        const row = res.rows[rIdx]!;
        const vals: unknown[] = [];
        for (const c of insertCols) {
          const rule = lookupRule(upperTbl, c.name);
          const origVal = readRowFieldCI(row, c.name);
          if (rule !== undefined) {
            const scrubbed =
              typeof rule === 'function'
                ? await rule(origVal, {
                    table: upperTbl,
                    column: c.name,
                    row,
                    rowIndex: rIdx,
                    seed,
                  })
                : applyBuiltinRule(rule, origVal, seed, c);
            vals.push(scrubbed);
            columnsScrubbed += 1;
          } else {
            vals.push(origVal);
          }
        }
        paramRows.push(vals);
        rowsProcessed += 1;
      }

      await execBatchSql(targetDb, insertSql, paramRows, batchSize);
    }
  }

  return {
    tablesProcessed,
    rowsProcessed,
    columnsScrubbed,
    inPlace,
  };
}

// ---------------------------------------------------------------------------
// Foreign-Key-Aware Synthetic Database Seeder
// ---------------------------------------------------------------------------

function generateColumnValue(
  col: ColumnSchemaInfo,
  seqNum: number,
  isUniqueOrPk: boolean,
  rng: () => number,
): unknown {
  // Optional nullable values (~12% NULL rate) when not PK/Unique
  if (col.nullable && !isUniqueOrPk && rng() < 0.12) {
    return null;
  }

  const upperCol = col.name.toUpperCase();
  const upperType = col.typeName.toUpperCase();
  const dt = col.dataType;

  if (upperType.includes('BOOLEAN')) {
    return seqNum % 2 === 1;
  }

  if (
    dt === 'SMALLINT' ||
    dt === 'INTEGER' ||
    dt === 'BIGINT' ||
    dt === 'INT128' ||
    dt === 'NUMERIC' ||
    dt === 'DECFLOAT16' ||
    dt === 'DECFLOAT34' ||
    upperType.startsWith('SMALLINT') ||
    upperType.startsWith('INTEGER') ||
    upperType.startsWith('INT') ||
    upperType.startsWith('BIGINT') ||
    upperType.startsWith('NUMERIC') ||
    upperType.startsWith('DECIMAL')
  ) {
    if (col.scale < 0) {
      const decimals = Math.min(6, -col.scale);
      const base = isUniqueOrPk ? seqNum : Math.floor(rng() * 9000) + 10;
      return Number((base + rng()).toFixed(decimals));
    }
    if (isUniqueOrPk) {
      return seqNum;
    }
    const maxRange = dt === 'SMALLINT' ? 1_000 : 10_000;
    return Math.floor(rng() * maxRange) + 1;
  }

  if (
    dt === 'FLOAT' ||
    dt === 'DOUBLE' ||
    upperType.startsWith('FLOAT') ||
    upperType.startsWith('DOUBLE')
  ) {
    return isUniqueOrPk ? seqNum : Number((rng() * 1000).toFixed(4));
  }

  if (dt === 'DATE' || upperType === 'DATE') {
    const baseMs = Date.UTC(2025, 0, 1) + (seqNum - 1) * 86_400_000;
    return new Date(baseMs).toISOString().slice(0, 10);
  }

  if (dt === 'TIME' || dt === 'TIME_TZ' || upperType.startsWith('TIME ')) {
    const hh = String(seqNum % 24).padStart(2, '0');
    const mm = String((seqNum * 7) % 60).padStart(2, '0');
    return `${hh}:${mm}:00`;
  }

  if (
    dt === 'TIMESTAMP' ||
    dt === 'TIMESTAMP_TZ' ||
    upperType.startsWith('TIMESTAMP')
  ) {
    const baseMs = Date.UTC(2025, 0, 1, 9, 0, 0) + (seqNum - 1) * 60_000;
    return new Date(baseMs).toISOString().replace('T', ' ').slice(0, 19);
  }

  if (
    upperType.includes('OCTETS') ||
    upperType.includes('BINARY') ||
    (dt === 'BLOB' && col.subType === 0)
  ) {
    const byteLen = Math.max(4, Math.min(col.length > 0 ? col.length : 16, 64));
    const buf = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++) {
      buf[i] = Math.floor(rng() * 256);
    }
    return buf;
  }

  // String / Text columns with semantic column-name awareness
  let strVal: string;
  if (upperCol.includes('EMAIL')) {
    strVal = `user${seqNum}@example.test`;
  } else if (upperCol === 'FIRST_NAME' || upperCol === 'FIRSTNAME') {
    const f = FIRST_NAMES[(seqNum - 1) % FIRST_NAMES.length]!;
    strVal = f.charAt(0).toUpperCase() + f.slice(1);
  } else if (upperCol === 'LAST_NAME' || upperCol === 'LASTNAME') {
    const l = LAST_NAMES[(seqNum - 1) % LAST_NAMES.length]!;
    strVal = l.charAt(0).toUpperCase() + l.slice(1);
  } else if (upperCol.includes('NAME')) {
    const f = FIRST_NAMES[(seqNum - 1) % FIRST_NAMES.length]!;
    const l = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]!;
    strVal = isUniqueOrPk
      ? `${f.charAt(0).toUpperCase()}${f.slice(1)}_${seqNum}`
      : `${f.charAt(0).toUpperCase()}${f.slice(1)} ${l.charAt(0).toUpperCase()}${l.slice(1)}`;
  } else if (upperCol.includes('PHONE')) {
    strVal = `+1-555-01${String(seqNum % 100).padStart(2, '0')}-${String(1000 + (seqNum % 9000))}`;
  } else if (upperCol.includes('UUID') || (isUniqueOrPk && col.length >= 36)) {
    const hex = deterministicHex(`${col.tableName}:${col.name}:${seqNum}`, seqNum, 32);
    strVal = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  } else {
    const w1 = SAMPLE_WORDS[(seqNum - 1) % SAMPLE_WORDS.length]!;
    const w2 = SAMPLE_WORDS[Math.floor(rng() * SAMPLE_WORDS.length)]!;
    strVal = isUniqueOrPk ? `${col.name.toLowerCase()}_${seqNum}` : `${w1} ${w2} ${seqNum}`;
  }

  return fitLength(strVal, col);
}

/**
 * Populate a Firebird database with deterministic, constraint-valid synthetic rows
 * respecting `NOT NULL`, `PRIMARY KEY`, `IDENTITY`, `UNIQUE` indexes, and topological
 * foreign-key parent-first insertion order (`M26 Item 4`).
 */
export async function seedDatabase(
  db: SeederDatabaseExecutor,
  options: SeedDatabaseOptions = {},
): Promise<SeedDatabaseResult> {
  const seed = options.seed ?? 42;
  const rng = createSeededRng(seed);
  const batchSize = Math.max(1, options.batchSize ?? 250);

  const schema = await getSchema(db);
  const requestedSet = options.tables
    ? new Set(options.tables.map((t) => t.trim().toUpperCase()))
    : null;
  const targetTableNames = schema.tables
    .map((t) => t.name)
    .filter((n) => !requestedSet || requestedSet.has(n.toUpperCase()));

  const insertionOrder = sortTablesByForeignKeys(targetTableNames, schema.foreignKeys);

  if (options.truncateFirst) {
    for (const tbl of [...insertionOrder].reverse()) {
      await execSql(db, `DELETE FROM ${quoteId(tbl)}`);
    }
  }

  // Cache parent table key tuples for foreign key resolution: `${UPPER_TABLE}::${COL1,COL2}` -> Array<unknown[]>
  const parentPoolCache = new Map<string, unknown[][]>();

  const loadParentPool = async (
    refTable: string,
    refCols: readonly string[],
  ): Promise<unknown[][]> => {
    const cacheKey = `${refTable.toUpperCase()}::${refCols.map((c) => c.toUpperCase()).join(',')}`;
    const cached = parentPoolCache.get(cacheKey);
    if (cached && cached.length > 0) return cached;

    const realTable =
      schema.tables.find((t) => t.name.toUpperCase() === refTable.toUpperCase())?.name ??
      refTable;
    const res = await db.query<Record<string, unknown>>(
      `SELECT ${refCols.map((c) => quoteId(c)).join(', ')} FROM ${quoteId(realTable)}`,
    );
    const tuples = res.rows
      .map((r) => refCols.map((c) => readRowFieldCI(r, c)))
      .filter((tuple) => tuple.every((v) => v !== null && v !== undefined));
    parentPoolCache.set(cacheKey, tuples);
    return tuples;
  };

  const rowsInsertedByTable: Record<string, number> = {};
  let totalRowsInserted = 0;

  for (const tblName of insertionOrder) {
    const upperTbl = tblName.toUpperCase();
    const rowCount =
      typeof options.rowsPerTable === 'number'
        ? options.rowsPerTable
        : options.rowsPerTable
          ? (options.rowsPerTable[tblName] ??
              options.rowsPerTable[upperTbl] ??
              options.rowsPerTable[tblName.toLowerCase()] ??
              10)
          : 10;

    if (rowCount <= 0) {
      rowsInsertedByTable[tblName] = 0;
      continue;
    }

    const tableOverrides =
      options.overrides?.[tblName] ??
      options.overrides?.[upperTbl] ??
      options.overrides?.[tblName.toLowerCase()] ??
      {};

    const allCols = schema.columns
      .filter((c) => c.tableName.toUpperCase() === upperTbl && !c.isComputed)
      .sort((a, b) => a.position - b.position);

    const insertCols = allCols.filter((c) => {
      const hasOverride =
        c.name in tableOverrides ||
        c.name.toUpperCase() in tableOverrides ||
        c.name.toLowerCase() in tableOverrides;
      if (hasOverride) return true;
      // Let Firebird populate GENERATED AS IDENTITY columns automatically
      if (c.isIdentity) return false;
      return true;
    });

    if (insertCols.length === 0) {
      rowsInsertedByTable[tblName] = 0;
      continue;
    }

    // Identify unique columns & starting sequence offset from existing table rows
    const uniqueColSet = new Set<string>();
    for (const c of insertCols) {
      if (c.isPrimaryKey) uniqueColSet.add(c.name.toUpperCase());
    }
    for (const idx of schema.indexes) {
      if (idx.tableName.toUpperCase() === upperTbl && idx.unique) {
        for (const ic of idx.columns) uniqueColSet.add(ic.toUpperCase());
      }
    }

    const cntRes = await db.query<{ CNT: number }>(
      `SELECT COUNT(*) AS CNT FROM ${quoteId(tblName)}`,
    );
    let seqBase = Number(cntRes.rows[0]?.CNT ?? 0);
    // Also check max numeric PK if non-empty so new PKs never collide
    if (seqBase > 0) {
      const numPk = insertCols.find(
        (c) =>
          c.isPrimaryKey &&
          (c.dataType === 'INTEGER' || c.dataType === 'BIGINT' || c.dataType === 'SMALLINT'),
      );
      if (numPk) {
        const maxRes = await db.query<{ M: number | null }>(
          `SELECT MAX(${quoteId(numPk.name)}) AS M FROM ${quoteId(tblName)}`,
        );
        const maxVal = Number(maxRes.rows[0]?.M ?? 0);
        if (Number.isFinite(maxVal) && maxVal > seqBase) seqBase = maxVal;
      }
    }

    // Foreign keys on this table
    const tableFks = schema.foreignKeys.filter(
      (fk) => fk.tableName.toUpperCase() === upperTbl,
    );
    const fkPools = new Map<ForeignKeySchemaInfo, unknown[][]>();
    for (const fk of tableFks) {
      if (fk.referencedTableName.toUpperCase() !== upperTbl) {
        fkPools.set(fk, await loadParentPool(fk.referencedTableName, fk.referencedColumns));
      }
    }

    const paramRows: QueryParams[] = [];
    for (let i = 0; i < rowCount; i++) {
      const seqNum = seqBase + i + 1;
      const rowObj: Record<string, unknown> = {};

      // 1. Populate foreign-key columns first from parent pools
      for (const fk of tableFks) {
        if (fk.referencedTableName.toUpperCase() === upperTbl) {
          // Self-referencing FK: leave NULL when nullable
          for (const fc of fk.columns) {
            rowObj[fc.toUpperCase()] = null;
          }
          continue;
        }
        const pool = fkPools.get(fk) ?? [];
        if (pool.length > 0) {
          const picked = pool[i % pool.length]!;
          for (let k = 0; k < fk.columns.length; k++) {
            rowObj[fk.columns[k]!.toUpperCase()] = picked[k];
          }
        }
      }

      // 2. Populate remaining columns & explicit overrides
      const rowParams: unknown[] = [];
      for (const col of insertCols) {
        const upperCol = col.name.toUpperCase();
        const overrideSpec =
          tableOverrides[col.name] ??
          tableOverrides[upperCol] ??
          tableOverrides[col.name.toLowerCase()];

        let val: unknown;
        if (overrideSpec !== undefined) {
          val =
            typeof overrideSpec === 'function'
              ? await (overrideSpec as (ctx: SeedColumnContext) => unknown)({
                  table: upperTbl,
                  column: col.name,
                  rowIndex: i,
                  seed,
                  rng,
                  row: rowObj,
                })
              : overrideSpec;
        } else if (upperCol in rowObj) {
          val = rowObj[upperCol];
        } else {
          val = generateColumnValue(col, seqNum, uniqueColSet.has(upperCol), rng);
        }
        rowObj[upperCol] = val;
        rowParams.push(val);
      }
      paramRows.push(rowParams);
    }

    const insertSql =
      `INSERT INTO ${quoteId(tblName)} (${insertCols.map((c) => quoteId(c.name)).join(', ')}) ` +
      `VALUES (${insertCols.map(() => '?').join(', ')})`;

    await execBatchSql(db, insertSql, paramRows, batchSize);
    // Invalidate any cached pools for this table so downstream children see fresh rows
    for (const k of [...parentPoolCache.keys()]) {
      if (k.startsWith(`${upperTbl}::`)) parentPoolCache.delete(k);
    }

    rowsInsertedByTable[tblName] = rowCount;
    totalRowsInserted += rowCount;
  }

  return {
    insertionOrder,
    rowsInsertedByTable,
    totalRowsInserted,
  };
}
