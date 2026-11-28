/**
 * jsonb-gin.ts – Postgres-Compatible `JSONB` SQL Functions & Persistent Inverted
 * `GIN` Path-Value Index (`FB_JSON_GIN$`) (`M31 Item 4`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_JSON_GIN_TABLE = 'FB_JSON_GIN$';

export interface JsonGinDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  onQuery?: (listener: (event: { sql: string; params?: unknown }) => void) => () => void;
  registerFunction?: (
    name: string,
    options: { args: string[]; returns: string; deterministic?: boolean },
    fn: (...args: unknown[]) => unknown,
  ) => Promise<unknown>;
}

export interface JsonGinIndexInfo {
  readonly indexName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly keyColumn: string;
  readonly docCount: number;
  readonly tokenCount: number;
  readonly updatedAtMs: number;
}

export interface CreateJsonGinIndexOptions {
  readonly name?: string;
  readonly table: string;
  readonly column: string;
  readonly keyColumn?: string;
  readonly persist?: boolean;
  readonly autoSync?: boolean;
  readonly ginTable?: string;
}

export interface JsonGinSearchHit<T extends Row = Row> {
  readonly key: string;
  readonly doc: unknown;
  readonly row?: T;
}

export interface JsonGinIndexHandle<T extends Row = Row> {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  readonly keyColumn: string;
  size(): Promise<number>;
  tokenCount(): Promise<number>;
  rebuild(): Promise<{ docCount: number; tokenCount: number }>;
  /** Postgres `@>` JSONB containment query accelerated by inverted GIN postings. */
  contains(
    candidate: Record<string, unknown> | unknown[] | string,
    options?: { includeRow?: boolean; limit?: number },
  ): Promise<Array<JsonGinSearchHit<T>>>;
  /** Postgres `?` JSONB key-existence query accelerated by GIN postings. */
  hasKey(
    key: string,
    options?: { pathPrefix?: string; includeRow?: boolean; limit?: number },
  ): Promise<Array<JsonGinSearchHit<T>>>;
  /** Exact JSONPath scalar lookup (`$.a.b` == `value`) via GIN postings. */
  pathEquals(
    path: string,
    value: string | number | boolean | null,
    options?: { includeRow?: boolean; limit?: number },
  ): Promise<Array<JsonGinSearchHit<T>>>;
  asReplicationIndexHook(): (entry: { table: string }) => Promise<void>;
  dispose(): void;
}

function qJgIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function jgCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execJgSql(db: JsonGinDatabase, sql: string, params: QueryParams = []): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

function tryParseJson(input: unknown): { ok: true; value: unknown } | { ok: false } {
  if (input === null || input === undefined) return { ok: false };
  if (typeof input === 'object') return { ok: true, value: input };
  if (typeof input !== 'string') return { ok: true, value: input };
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

/** Parse `$.a.b[0]`, `/a/b/0`, or `a.b.0` into path segments (`M31 Item 4`). */
export function parseJsonPath(path: string): Array<string | number> {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$' || trimmed === '/') return [];
  if (trimmed.startsWith('/')) {
    return trimmed
      .slice(1)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  }
  const body = trimmed.startsWith('$.')
    ? trimmed.slice(2)
    : trimmed.startsWith('$')
      ? trimmed.slice(1)
      : trimmed;
  const out: Array<string | number> = [];
  const tokenRe = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[1] !== undefined) out.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
  }
  return out;
}

function navigatePath(root: unknown, segs: ReadonlyArray<string | number>): unknown {
  let curr: unknown = root;
  for (const s of segs) {
    if (curr === null || curr === undefined) return undefined;
    if (Array.isArray(curr) && typeof s === 'number') {
      curr = curr[s];
    } else if (typeof curr === 'object' && !Array.isArray(curr)) {
      curr = (curr as Record<string, unknown>)[String(s)];
    } else {
      return undefined;
    }
  }
  return curr;
}

/** SQL `JSON_VALUE(doc, path)`: extracts a scalar value as text, or `null` (`M31 Item 4`). */
export function jsonExtractValue(docInput: unknown, path: string): string | null {
  const parsed = tryParseJson(docInput);
  if (!parsed.ok) return null;
  const val = navigatePath(parsed.value, parseJsonPath(path));
  if (val === undefined || val === null || typeof val === 'object') return null;
  return String(val);
}

/** SQL `JSON_QUERY(doc, path)`: extracts an object, array, or scalar as serialized JSON (`M31 Item 4`). */
export function jsonExtractQuery(docInput: unknown, path: string): string | null {
  const parsed = tryParseJson(docInput);
  if (!parsed.ok) return null;
  const val = navigatePath(parsed.value, parseJsonPath(path));
  if (val === undefined) return null;
  return JSON.stringify(val);
}

/** Postgres `@>` JSONB structural containment (`M31 Item 4`). */
export function jsonContains(docInput: unknown, candidateInput: unknown): boolean {
  const d = tryParseJson(docInput);
  const c = tryParseJson(candidateInput);
  if (!d.ok || !c.ok) return false;
  return containsRec(d.value, c.value);
}

function containsRec(target: unknown, candidate: unknown): boolean {
  if (candidate === target) return true;
  if (candidate === null || target === null || typeof candidate !== 'object' || typeof target !== 'object') {
    return false;
  }
  if (Array.isArray(candidate)) {
    if (!Array.isArray(target)) return false;
    return candidate.every((cElem) =>
      Array.isArray(cElem) || (cElem !== null && typeof cElem === 'object')
        ? target.some((tElem) => containsRec(tElem, cElem))
        : target.some((tElem) => tElem === cElem || containsRec(tElem, cElem)),
    );
  }
  if (Array.isArray(target)) return false;
  const tObj = target as Record<string, unknown>;
  const cObj = candidate as Record<string, unknown>;
  for (const [k, cVal] of Object.entries(cObj)) {
    if (!(k in tObj)) return false;
    if (!containsRec(tObj[k], cVal)) return false;
  }
  return true;
}

/** Postgres `?` operator: checks top-level object key or array string element (`M31 Item 4`). */
export function jsonHasKey(docInput: unknown, key: string): boolean {
  const parsed = tryParseJson(docInput);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return false;
  if (Array.isArray(parsed.value)) return parsed.value.includes(key);
  return Object.prototype.hasOwnProperty.call(parsed.value, key);
}

/** SQL `JSON_SET(doc, path, valueJson)`: immutably updates `path` and returns JSON text (`M31 Item 4`). */
export function jsonSetPath(docInput: unknown, path: string, rawNewVal: unknown): string | null {
  const parsed = tryParseJson(docInput);
  if (!parsed.ok) return null;
  const valParsed = tryParseJson(rawNewVal);
  const nextVal = valParsed.ok ? valParsed.value : rawNewVal;
  const segs = parseJsonPath(path);
  if (segs.length === 0) return JSON.stringify(nextVal);

  const cloneSet = (curr: unknown, idx: number): unknown => {
    const seg = segs[idx]!;
    const isLast = idx === segs.length - 1;
    if (typeof seg === 'number') {
      const arr = Array.isArray(curr) ? [...curr] : [];
      arr[seg] = isLast ? nextVal : cloneSet(arr[seg], idx + 1);
      return arr;
    }
    const obj =
      curr !== null && typeof curr === 'object' && !Array.isArray(curr)
        ? { ...(curr as Record<string, unknown>) }
        : {};
    obj[seg] = isLast ? nextVal : cloneSet(obj[seg], idx + 1);
    return obj;
  };
  return JSON.stringify(cloneSet(parsed.value, 0));
}

/** Postgres `jsonb_strip_nulls`: removes object keys with `null` values recursively (`M31 Item 4`). */
export function jsonStripNulls(docInput: unknown): string | null {
  const parsed = tryParseJson(docInput);
  if (!parsed.ok) return null;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (child !== null) out[k] = strip(child);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(parsed.value));
}

/** Postgres `jsonb_typeof`: returns `'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'` (`M31 Item 4`). */
export function jsonTypeof(docInput: unknown, path = '$'): string | null {
  const parsed = tryParseJson(docInput);
  if (!parsed.ok) return null;
  const v = navigatePath(parsed.value, parseJsonPath(path));
  if (v === undefined) return null;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Register Postgres-style `JSON_*` scalar SQL UDRs on `db` (`M31 Item 4`). */
export async function registerJsonbFunctions(db: JsonGinDatabase): Promise<void> {
  if (typeof db.registerFunction !== 'function') {
    throw new Error('Database instance does not support registerFunction().');
  }
  await db.registerFunction(
    'JSON_VALUE',
    { args: ['VARCHAR(8000)', 'VARCHAR(512)'], returns: 'VARCHAR(4096)', deterministic: true },
    (doc, p) => jsonExtractValue(doc, String(p ?? '$')),
  );
  await db.registerFunction(
    'JSON_QUERY',
    { args: ['VARCHAR(8000)', 'VARCHAR(512)'], returns: 'VARCHAR(8000)', deterministic: true },
    (doc, p) => jsonExtractQuery(doc, String(p ?? '$')),
  );
  await db.registerFunction(
    'JSON_CONTAINS',
    { args: ['VARCHAR(8000)', 'VARCHAR(8000)'], returns: 'SMALLINT', deterministic: true },
    (doc, cand) => (jsonContains(doc, cand) ? 1 : 0),
  );
  await db.registerFunction(
    'JSON_HAS_KEY',
    { args: ['VARCHAR(8000)', 'VARCHAR(256)'], returns: 'SMALLINT', deterministic: true },
    (doc, key) => (jsonHasKey(doc, String(key ?? '')) ? 1 : 0),
  );
  await db.registerFunction(
    'JSON_SET',
    {
      args: ['VARCHAR(8000)', 'VARCHAR(512)', 'VARCHAR(4096)'],
      returns: 'VARCHAR(8000)',
      deterministic: true,
    },
    (doc, p, val) => jsonSetPath(doc, String(p ?? '$'), val),
  );
  await db.registerFunction(
    'JSON_STRIP_NULLS',
    { args: ['VARCHAR(8000)'], returns: 'VARCHAR(8000)', deterministic: true },
    (doc) => jsonStripNulls(doc),
  );
  await db.registerFunction(
    'JSON_TYPEOF',
    { args: ['VARCHAR(8000)'], returns: 'VARCHAR(32)', deterministic: true },
    (doc) => jsonTypeof(doc, '$'),
  );
}

function collectGinTokens(val: unknown, prefix: string, out: Set<string>): void {
  if (val === null || typeof val !== 'object') {
    out.add(`v:${prefix}=${JSON.stringify(val)}`);
    return;
  }
  if (Array.isArray(val)) {
    for (const elem of val) {
      if (typeof elem === 'string') out.add(`k:${prefix}:${elem}`);
      collectGinTokens(elem, `${prefix}[*]`, out);
    }
    return;
  }
  for (const [k, child] of Object.entries(val as Record<string, unknown>)) {
    out.add(`k:${prefix}:${k}`);
    const nextPath = prefix === '$' ? `$.${k}` : `${prefix}.${k}`;
    collectGinTokens(child, nextPath, out);
  }
}

function collectCandidateTokens(cand: unknown, prefix: string, out: string[]): void {
  if (cand === null || typeof cand !== 'object') {
    out.push(`v:${prefix}=${JSON.stringify(cand)}`);
    return;
  }
  if (Array.isArray(cand)) {
    for (const elem of cand) collectCandidateTokens(elem, `${prefix}[*]`, out);
    return;
  }
  for (const [k, child] of Object.entries(cand as Record<string, unknown>)) {
    out.push(`k:${prefix}:${k}`);
    const nextPath = prefix === '$' ? `$.${k}` : `${prefix}.${k}`;
    collectCandidateTokens(child, nextPath, out);
  }
}

/** Read persisted `FB_JSON_GIN$` metadata without mutating schema (`M31 Item 5`). */
export async function fetchPersistedJsonGinIndexes(
  db: JsonGinDatabase,
  ginTable = DEFAULT_JSON_GIN_TABLE,
): Promise<JsonGinIndexInfo[]> {
  const tblUpper = ginTable.trim().toUpperCase();
  const chk = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [tblUpper],
  );
  if (Number(jgCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];
  const res = await db.query<Record<string, unknown>>(
    `SELECT INDEX_NAME, TABLE_NAME, COLUMN_NAME, KEY_COLUMN, DOC_COUNT, TOKEN_COUNT, UPDATED_AT_MS
     FROM ${qJgIdent(tblUpper)} ORDER BY INDEX_NAME ASC`,
  );
  return res.rows.map((r) => ({
    indexName: String(jgCol(r, 'INDEX_NAME') ?? '').trim(),
    tableName: String(jgCol(r, 'TABLE_NAME') ?? '').trim(),
    columnName: String(jgCol(r, 'COLUMN_NAME') ?? '').trim(),
    keyColumn: String(jgCol(r, 'KEY_COLUMN') ?? 'ID').trim(),
    docCount: Number(jgCol(r, 'DOC_COUNT') ?? 0),
    tokenCount: Number(jgCol(r, 'TOKEN_COUNT') ?? 0),
    updatedAtMs: Number(jgCol(r, 'UPDATED_AT_MS') ?? 0),
  }));
}

/** Create a persistent inverted `GIN` JSONB index over `table.column` (`M31 Item 4`). */
export async function createJsonGinIndex<T extends Row = Row>(
  db: JsonGinDatabase,
  options: CreateJsonGinIndexOptions,
): Promise<JsonGinIndexHandle<T>> {
  const tableUpper = options.table.trim().toUpperCase();
  const colUpper = options.column.trim().toUpperCase();
  const keyUpper = (options.keyColumn ?? 'ID').trim().toUpperCase();
  const indexName = options.name ?? `gin_${tableUpper.toLowerCase()}_${colUpper.toLowerCase()}`;
  const persist = options.persist !== false;
  const ginUpper = (options.ginTable ?? DEFAULT_JSON_GIN_TABLE).trim().toUpperCase();

  let postings = new Map<string, Set<string>>();
  let docsByKey = new Map<string, unknown>();
  let rowsByKey = new Map<string, T>();
  let unsubQuery: (() => void) | null = null;
  let dirty = false;
  let syncInFlight: Promise<void> | null = null;

  const ensureGinTable = async (): Promise<void> => {
    if (!persist) return;
    const chk = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [ginUpper],
    );
    if (Number(jgCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execJgSql(
        db,
        `CREATE TABLE ${qJgIdent(ginUpper)} (
          "INDEX_NAME" VARCHAR(128) NOT NULL PRIMARY KEY,
          "TABLE_NAME" VARCHAR(64) NOT NULL,
          "COLUMN_NAME" VARCHAR(64) NOT NULL,
          "KEY_COLUMN" VARCHAR(64) NOT NULL,
          "DOC_COUNT" INTEGER NOT NULL,
          "TOKEN_COUNT" INTEGER NOT NULL,
          "POSTINGS_JSON" BLOB SUB_TYPE TEXT,
          "UPDATED_AT_MS" BIGINT NOT NULL
        )`,
      );
    }
  };

  const rebuild = async (): Promise<{ docCount: number; tokenCount: number }> => {
    const nextPostings = new Map<string, Set<string>>();
    const nextDocs = new Map<string, unknown>();
    const nextRows = new Map<string, T>();

    const res = await db.query<Record<string, unknown>>(`SELECT * FROM ${qJgIdent(tableUpper)}`);
    for (const r of res.rows) {
      const kVal = jgCol(r, keyUpper);
      if (kVal === undefined || kVal === null) continue;
      const docKey = String(kVal);
      const parsed = tryParseJson(jgCol(r, colUpper));
      if (!parsed.ok) continue;

      nextDocs.set(docKey, parsed.value);
      nextRows.set(docKey, r as T);
      const tokens = new Set<string>();
      collectGinTokens(parsed.value, '$', tokens);
      for (const tok of tokens) {
        let bucket = nextPostings.get(tok);
        if (!bucket) {
          bucket = new Set();
          nextPostings.set(tok, bucket);
        }
        bucket.add(docKey);
      }
    }

    // Atomic swap after async query completes
    postings = nextPostings;
    docsByKey = nextDocs;
    rowsByKey = nextRows;

    if (persist) {
      await ensureGinTable();
      const serializedObj: Record<string, string[]> = {};
      for (const [t, s] of postings) serializedObj[t] = [...s];
      await execJgSql(
        db,
        `UPDATE OR INSERT INTO ${qJgIdent(ginUpper)} (
          "INDEX_NAME", "TABLE_NAME", "COLUMN_NAME", "KEY_COLUMN",
          "DOC_COUNT", "TOKEN_COUNT", "POSTINGS_JSON", "UPDATED_AT_MS"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) MATCHING ("INDEX_NAME")`,
        [
          indexName,
          tableUpper,
          colUpper,
          keyUpper,
          docsByKey.size,
          postings.size,
          JSON.stringify(serializedObj),
          Date.now(),
        ],
      );
    }
    return { docCount: docsByKey.size, tokenCount: postings.size };
  };

  const ensureSynced = async (): Promise<void> => {
    if (!dirty && !syncInFlight) return;
    if (syncInFlight) {
      await syncInFlight;
      return;
    }
    dirty = false;
    syncInFlight = rebuild()
      .then(() => undefined)
      .finally(() => {
        syncInFlight = null;
      });
    await syncInFlight;
  };

  await rebuild();

  if (options.autoSync && typeof db.onQuery === 'function') {
    const mutRe = new RegExp(
      `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|MERGE\\s+INTO)\\s+"?${tableUpper}"?\\b`,
      'i',
    );
    unsubQuery = db.onQuery((ev) => {
      if (mutRe.test(ev.sql)) dirty = true;
    });
  }

  const intersectTokens = (tokens: readonly string[]): Set<string> => {
    if (tokens.length === 0) return new Set(docsByKey.keys());
    const sets = tokens.map((t) => postings.get(t));
    if (sets.some((s) => !s || s.size === 0)) return new Set();
    const sorted = (sets as Array<Set<string>>).sort((a, b) => a.size - b.size);
    const out = new Set<string>(sorted[0]!);
    for (let i = 1; i < sorted.length; i++) {
      for (const k of out) {
        if (!sorted[i]!.has(k)) out.delete(k);
      }
    }
    return out;
  };

  const formatHits = (
    keys: Iterable<string>,
    includeRow?: boolean,
    limit?: number,
    predicate?: (doc: unknown) => boolean,
  ): Array<JsonGinSearchHit<T>> => {
    const out: Array<JsonGinSearchHit<T>> = [];
    const max = limit !== undefined ? Math.max(1, limit) : Infinity;
    for (const k of keys) {
      const doc = docsByKey.get(k);
      if (doc === undefined) continue;
      if (predicate && !predicate(doc)) continue;
      out.push({
        key: k,
        doc,
        ...(includeRow ? { row: rowsByKey.get(k) } : {}),
      });
      if (out.length >= max) break;
    }
    return out;
  };

  return {
    name: indexName,
    table: tableUpper,
    column: colUpper,
    keyColumn: keyUpper,
    async size() {
      await ensureSynced();
      return docsByKey.size;
    },
    async tokenCount() {
      await ensureSynced();
      return postings.size;
    },
    rebuild,
    async contains(candidate, qOpts = {}) {
      await ensureSynced();
      const parsed = tryParseJson(candidate);
      if (!parsed.ok) return [];
      const reqTokens: string[] = [];
      collectCandidateTokens(parsed.value, '$', reqTokens);
      const candidates = intersectTokens(reqTokens);
      return formatHits(candidates, qOpts.includeRow, qOpts.limit, (d) =>
        containsRec(d, parsed.value),
      );
    },
    async hasKey(key, qOpts = {}) {
      await ensureSynced();
      const prefix = qOpts.pathPrefix ?? '$';
      const candidates = postings.get(`k:${prefix}:${key}`) ?? new Set<string>();
      return formatHits(candidates, qOpts.includeRow, qOpts.limit);
    },
    async pathEquals(path, value, qOpts = {}) {
      await ensureSynced();
      const segs = parseJsonPath(path);
      const normPath =
        segs.length === 0
          ? '$'
          : '$' + segs.map((s) => (typeof s === 'number' ? '[*]' : `.${s}`)).join('');
      const tok = `v:${normPath}=${JSON.stringify(value)}`;
      const candidates = postings.get(tok) ?? new Set<string>();
      return formatHits(
        candidates,
        qOpts.includeRow,
        qOpts.limit,
        (d) => navigatePath(d, segs) === value,
      );
    },
    asReplicationIndexHook() {
      return async (entry: { table: string }) => {
        if (entry.table.trim().toUpperCase() === tableUpper) await rebuild();
      };
    },
    dispose() {
      if (unsubQuery) {
        unsubQuery();
        unsubQuery = null;
      }
    },
  };
}
