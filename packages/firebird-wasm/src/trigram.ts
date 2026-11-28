/**
 * trigram.ts – Postgres `pg_trgm`-Compatible Fuzzy Trigram Similarity,
 * Substring Acceleration (`FB_TRGM_INDEX$`) & Levenshtein Edit Distance (`M31 Item 4`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_TRIGRAM_INDEX_TABLE = 'FB_TRGM_INDEX$';

export interface TrigramDatabase {
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

export interface TrigramIndexInfo {
  readonly indexName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly keyColumn: string;
  readonly docCount: number;
  readonly trigramCount: number;
  readonly updatedAtMs: number;
}

export interface CreateTrigramIndexOptions {
  readonly name?: string;
  readonly table: string;
  readonly column: string;
  readonly keyColumn?: string;
  readonly persist?: boolean;
  readonly autoSync?: boolean;
  readonly threshold?: number;
  readonly trigramTable?: string;
}

export interface TrigramSearchHit<T extends Row = Row> {
  readonly key: string;
  readonly text: string;
  readonly score: number;
  readonly row?: T;
}

export interface TrigramIndexHandle<T extends Row = Row> {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  readonly keyColumn: string;
  size(): Promise<number>;
  trigramCount(): Promise<number>;
  rebuild(): Promise<{ docCount: number; trigramCount: number }>;
  search(
    query: string,
    options?: {
      limit?: number;
      threshold?: number;
      mode?: 'similarity' | 'word_similarity' | 'substring';
      includeRow?: boolean;
    },
  ): Promise<Array<TrigramSearchHit<T>>>;
  asReplicationIndexHook(): (entry: { table: string }) => Promise<void>;
  dispose(): void;
}

function qTgIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function tgCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execTgSql(db: TrigramDatabase, sql: string, params: QueryParams = []): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

/**
 * Extract sorted unique 3-grams using PostgreSQL `pg_trgm` word padding (`"  " + word + " "`) (`M31 Item 4`).
 */
export function extractTrigrams(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .filter(Boolean);
  const set = new Set<string>();
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i <= padded.length - 3; i++) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return [...set].sort();
}

function extractRawSubstringTrigrams(sub: string): string[] {
  const norm = sub.toLowerCase();
  if (norm.length < 3) return [];
  const set = new Set<string>();
  for (let i = 0; i <= norm.length - 3; i++) {
    const tri = norm.slice(i, i + 3);
    if (/^[a-z0-9\u00c0-\u024f]{3}$/i.test(tri)) set.add(tri);
  }
  return [...set];
}

function sortedSetJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++;
      i++;
      j++;
    } else if (a[i]! < b[j]!) {
      i++;
    } else {
      j++;
    }
  }
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/** Postgres `similarity(a, b)` (`pg_trgm` Jaccard coefficient in `[0, 1]`) (`M31 Item 4`). */
export function trigramSimilarity(a: string, b: string): number {
  return sortedSetJaccard(extractTrigrams(a), extractTrigrams(b));
}

/** Postgres `word_similarity(needle, haystack)` across contiguous word windows (`M31 Item 4`). */
export function wordSimilarity(needle: string, haystack: string): number {
  const needleTris = extractTrigrams(needle);
  if (needleTris.length === 0) return 0;
  const words = haystack
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .filter(Boolean);
  if (words.length === 0) return 0;

  let best = 0;
  for (let start = 0; start < words.length; start++) {
    for (let end = start; end < Math.min(words.length, start + 6); end++) {
      const windowTris = extractTrigrams(words.slice(start, end + 1).join(' '));
      const sim = sortedSetJaccard(needleTris, windowTris);
      if (sim > best) best = sim;
    }
  }
  return best;
}

/** Wagner-Fischer Levenshtein edit distance in $O(\min(n, m))$ space (`M31 Item 4`). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const [shortStr, longStr] = a.length <= b.length ? [a, b] : [b, a];
  let prev = Array.from({ length: shortStr.length + 1 }, (_, i) => i);
  for (let i = 1; i <= longStr.length; i++) {
    const curr = [i];
    for (let j = 1; j <= shortStr.length; j++) {
      const cost = longStr[i - 1] === shortStr[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[shortStr.length]!;
}

/** Register Postgres `pg_trgm` & `fuzzystrmatch` SQL functions (`SIMILARITY`, `WORD_SIMILARITY`, `LEVENSHTEIN`) (`M31 Item 4`). */
export async function registerTrigramFunctions(db: TrigramDatabase): Promise<void> {
  if (typeof db.registerFunction !== 'function') {
    throw new Error('Database instance does not support registerFunction().');
  }
  await db.registerFunction(
    'SIMILARITY',
    { args: ['VARCHAR(4096)', 'VARCHAR(4096)'], returns: 'DOUBLE PRECISION', deterministic: true },
    (a, b) => trigramSimilarity(String(a ?? ''), String(b ?? '')),
  );
  await db.registerFunction(
    'WORD_SIMILARITY',
    { args: ['VARCHAR(4096)', 'VARCHAR(4096)'], returns: 'DOUBLE PRECISION', deterministic: true },
    (a, b) => wordSimilarity(String(a ?? ''), String(b ?? '')),
  );
  await db.registerFunction(
    'LEVENSHTEIN',
    { args: ['VARCHAR(4096)', 'VARCHAR(4096)'], returns: 'INTEGER', deterministic: true },
    (a, b) => levenshteinDistance(String(a ?? ''), String(b ?? '')),
  );
}

/** Read persisted `FB_TRGM_INDEX$` metadata without mutating schema (`M31 Item 5`). */
export async function fetchPersistedTrigramIndexes(
  db: TrigramDatabase,
  trigramTable = DEFAULT_TRIGRAM_INDEX_TABLE,
): Promise<TrigramIndexInfo[]> {
  const tblUpper = trigramTable.trim().toUpperCase();
  const chk = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [tblUpper],
  );
  if (Number(tgCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];
  const res = await db.query<Record<string, unknown>>(
    `SELECT INDEX_NAME, TABLE_NAME, COLUMN_NAME, KEY_COLUMN, DOC_COUNT, TRIGRAM_COUNT, UPDATED_AT_MS
     FROM ${qTgIdent(tblUpper)} ORDER BY INDEX_NAME ASC`,
  );
  return res.rows.map((r) => ({
    indexName: String(tgCol(r, 'INDEX_NAME') ?? '').trim(),
    tableName: String(tgCol(r, 'TABLE_NAME') ?? '').trim(),
    columnName: String(tgCol(r, 'COLUMN_NAME') ?? '').trim(),
    keyColumn: String(tgCol(r, 'KEY_COLUMN') ?? 'ID').trim(),
    docCount: Number(tgCol(r, 'DOC_COUNT') ?? 0),
    trigramCount: Number(tgCol(r, 'TRIGRAM_COUNT') ?? 0),
    updatedAtMs: Number(tgCol(r, 'UPDATED_AT_MS') ?? 0),
  }));
}

/** Create a persistent `pg_trgm`-style fuzzy trigram & substring index (`M31 Item 4`). */
export async function createTrigramIndex<T extends Row = Row>(
  db: TrigramDatabase,
  options: CreateTrigramIndexOptions,
): Promise<TrigramIndexHandle<T>> {
  const tableUpper = options.table.trim().toUpperCase();
  const colUpper = options.column.trim().toUpperCase();
  const keyUpper = (options.keyColumn ?? 'ID').trim().toUpperCase();
  const indexName = options.name ?? `trgm_${tableUpper.toLowerCase()}_${colUpper.toLowerCase()}`;
  const defaultThreshold = options.threshold ?? 0.25;
  const persist = options.persist !== false;
  const trgmUpper = (options.trigramTable ?? DEFAULT_TRIGRAM_INDEX_TABLE).trim().toUpperCase();

  let postings = new Map<string, Set<string>>();
  let docTrigrams = new Map<string, string[]>();
  let docText = new Map<string, string>();
  let rowsByKey = new Map<string, T>();
  let unsubQuery: (() => void) | null = null;
  let dirty = false;
  let syncInFlight: Promise<void> | null = null;

  const ensureTrgmTable = async (): Promise<void> => {
    if (!persist) return;
    const chk = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [trgmUpper],
    );
    if (Number(tgCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execTgSql(
        db,
        `CREATE TABLE ${qTgIdent(trgmUpper)} (
          "INDEX_NAME" VARCHAR(128) NOT NULL PRIMARY KEY,
          "TABLE_NAME" VARCHAR(64) NOT NULL,
          "COLUMN_NAME" VARCHAR(64) NOT NULL,
          "KEY_COLUMN" VARCHAR(64) NOT NULL,
          "DOC_COUNT" INTEGER NOT NULL,
          "TRIGRAM_COUNT" INTEGER NOT NULL,
          "POSTINGS_JSON" BLOB SUB_TYPE TEXT,
          "UPDATED_AT_MS" BIGINT NOT NULL
        )`,
      );
    }
  };

  const rebuild = async (): Promise<{ docCount: number; trigramCount: number }> => {
    const nextPostings = new Map<string, Set<string>>();
    const nextDocTris = new Map<string, string[]>();
    const nextDocText = new Map<string, string>();
    const nextRows = new Map<string, T>();

    const res = await db.query<Record<string, unknown>>(`SELECT * FROM ${qTgIdent(tableUpper)}`);
    for (const r of res.rows) {
      const kVal = tgCol(r, keyUpper);
      if (kVal === undefined || kVal === null) continue;
      const key = String(kVal);
      const text = String(tgCol(r, colUpper) ?? '');
      const tris = extractTrigrams(text);

      nextDocTris.set(key, tris);
      nextDocText.set(key, text);
      nextRows.set(key, r as T);
      for (const tri of tris) {
        let bucket = nextPostings.get(tri);
        if (!bucket) {
          bucket = new Set();
          nextPostings.set(tri, bucket);
        }
        bucket.add(key);
      }
    }

    postings = nextPostings;
    docTrigrams = nextDocTris;
    docText = nextDocText;
    rowsByKey = nextRows;

    if (persist) {
      await ensureTrgmTable();
      const serialized: Record<string, string[]> = {};
      for (const [tri, s] of postings) serialized[tri] = [...s];
      await execTgSql(
        db,
        `UPDATE OR INSERT INTO ${qTgIdent(trgmUpper)} (
          "INDEX_NAME", "TABLE_NAME", "COLUMN_NAME", "KEY_COLUMN",
          "DOC_COUNT", "TRIGRAM_COUNT", "POSTINGS_JSON", "UPDATED_AT_MS"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) MATCHING ("INDEX_NAME")`,
        [
          indexName,
          tableUpper,
          colUpper,
          keyUpper,
          docText.size,
          postings.size,
          JSON.stringify(serialized),
          Date.now(),
        ],
      );
    }

    return { docCount: docText.size, trigramCount: postings.size };
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

  return {
    name: indexName,
    table: tableUpper,
    column: colUpper,
    keyColumn: keyUpper,
    async size() {
      await ensureSynced();
      return docText.size;
    },
    async trigramCount() {
      await ensureSynced();
      return postings.size;
    },
    rebuild,
    async search(query, sOpts = {}) {
      await ensureSynced();
      const mode = sOpts.mode ?? 'similarity';
      const limit = Math.max(1, sOpts.limit ?? 20);
      const threshold = sOpts.threshold ?? defaultThreshold;

      if (mode === 'substring') {
        const subTris = extractRawSubstringTrigrams(query);
        let candidates: Iterable<string>;
        if (subTris.length === 0) {
          candidates = docText.keys();
        } else {
          const sets = subTris.map((t) => postings.get(t));
          if (sets.some((s) => !s || s.size === 0)) return [];
          const sorted = (sets as Array<Set<string>>).sort((a, b) => a.size - b.size);
          const inter = new Set<string>(sorted[0]!);
          for (let i = 1; i < sorted.length; i++) {
            for (const k of inter) if (!sorted[i]!.has(k)) inter.delete(k);
          }
          candidates = inter;
        }
        const needleLower = query.toLowerCase();
        const hits: Array<TrigramSearchHit<T>> = [];
        for (const k of candidates) {
          const txt = docText.get(k) ?? '';
          if (txt.toLowerCase().includes(needleLower)) {
            hits.push({
              key: k,
              text: txt,
              score: 1,
              ...(sOpts.includeRow ? { row: rowsByKey.get(k) } : {}),
            });
            if (hits.length >= limit) break;
          }
        }
        return hits;
      }

      const qTris = extractTrigrams(query);
      if (qTris.length === 0) return [];
      const candidateKeys = new Set<string>();
      for (const tri of qTris) {
        const bucket = postings.get(tri);
        if (bucket) for (const k of bucket) candidateKeys.add(k);
      }

      const hits: Array<TrigramSearchHit<T>> = [];
      for (const k of candidateKeys) {
        const txt = docText.get(k) ?? '';
        const score =
          mode === 'word_similarity'
            ? wordSimilarity(query, txt)
            : sortedSetJaccard(qTris, docTrigrams.get(k) ?? []);
        if (score >= threshold) {
          hits.push({
            key: k,
            text: txt,
            score,
            ...(sOpts.includeRow ? { row: rowsByKey.get(k) } : {}),
          });
        }
      }
      hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
      return hits.slice(0, limit);
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
