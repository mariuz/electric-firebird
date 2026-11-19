/**
 * hybrid.ts – Reciprocal Rank Fusion (RRF), Hybrid BM25 + Vector Search,
 * MMR Diversity Reranking & Token-Budgeted RAG Context Packing (`M26 Item 3 & 5`).
 */

import type { QueryParams, Row } from '../types';
import {
  vectorSearch,
  type PersistentVectorIndex,
  type VectorDistanceMetric,
  type VectorInput,
  type VectorQuantizationMode,
} from '../vector';
import {
  createFtsIndex,
  highlightSnippet,
  type FtsDatabaseExecutor,
  type FtsSearchRow,
  type PersistentFtsIndex,
} from './index';

function getFieldCI(
  row: Record<string, unknown>,
  name: string,
): { key: string; value: unknown } | undefined {
  const clean = name.replace(/^"|"$/g, '');
  if (clean in row) return { key: clean, value: row[clean] };
  const upper = clean.toUpperCase();
  if (upper in row) return { key: upper, value: row[upper] };
  const lower = clean.toLowerCase();
  if (lower in row) return { key: lower, value: row[lower] };
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return { key: k, value: row[k] };
  }
  return undefined;
}

/**
 * Options for {@link reciprocalRankFusion}.
 */
export interface RrfOptions {
  /** RRF smoothing constant $k$ (default: `60`). */
  rrfK?: number;
  /** Maximum number of fused items to return (default: `10`). */
  limit?: number;
}

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion (RRF):
 * $$\text{RRF\_SCORE}(d) = \sum_{i} w_i \cdot \frac{1}{k + \text{rank}_i(d)}$$
 * where $\text{rank}_i(d) \ge 1$ is the 1-based position of document $d$ in list $i$.
 */
export function reciprocalRankFusion<ID = string | number>(
  lists: ReadonlyArray<{
    items: readonly ID[];
    weight?: number;
  }>,
  options: RrfOptions = {},
): Array<{ id: ID; rrfScore: number; ranks: Array<number | null> }> {
  const k = options.rrfK ?? 60;
  const limit = options.limit ?? 10;
  const fused = new Map<
    ID,
    { id: ID; rrfScore: number; ranks: Array<number | null> }
  >();

  lists.forEach((list, listIdx) => {
    const weight = list.weight ?? 1.0;
    list.items.forEach((id, idx) => {
      const rank = idx + 1;
      let entry = fused.get(id);
      if (!entry) {
        entry = {
          id,
          rrfScore: 0,
          ranks: new Array(lists.length).fill(null),
        };
        fused.set(id, entry);
      }
      if (entry.ranks[listIdx] === null) {
        entry.ranks[listIdx] = rank;
        entry.rrfScore += weight / (k + rank);
      }
    });
  });

  const sorted = Array.from(fused.values()).sort((a, b) => b.rrfScore - a.rrfScore);
  return sorted.slice(0, limit);
}

/**
 * Options for {@link hybridSearch} combining BM25 Full-Text Search with Vector
 * Similarity Search via Reciprocal Rank Fusion (RRF).
 */
export interface HybridSearchOptions {
  /** Target table name. */
  table: string;
  /** Primary-key column name on `table` (default: `'ID'`). */
  keyColumn?: string;
  /** Full-text keyword query string. */
  textQuery: string;
  /** Text columns to search when `ftsIndex` is not supplied. */
  ftsColumns?: readonly string[];
  /** Optional pre-built {@link PersistentFtsIndex}. */
  ftsIndex?: Pick<PersistentFtsIndex<never>, 'search'>;
  /** Vector column name on `table`. */
  vectorColumn: string;
  /** Query embedding vector. */
  vectorQuery: VectorInput;
  /** Vector distance metric (default: `'cosine'`). */
  metric?: VectorDistanceMetric;
  /** Optional pre-built {@link PersistentVectorIndex}. */
  vectorIndex?: Pick<PersistentVectorIndex<never>, 'search'>;
  /** Optional vector quantization pre-pass (`'none' | 'int8' | 'binary'`, `M25 Item 3`). */
  quantization?: VectorQuantizationMode;
  /** Optional SQL `WHERE` filter applied to both arms. */
  where?: string;
  /** Positional parameters for `where`. */
  params?: QueryParams;
  /** Optional column projection applied to both arms (`M25 Item 3`). */
  select?: readonly string[] | '*';
  /** Maximum number of fused results to return (default: `10`). */
  limit?: number;
  /** Candidate pool size fetched from each arm before RRF fusion (default: `limit * 3`). */
  candidateLimit?: number;
  /** RRF smoothing constant $k$ (default: `60`). */
  rrfK?: number;
  /** Weight for the FTS BM25 arm (default: `1.0`). */
  ftsWeight?: number;
  /** Weight for the vector similarity arm (default: `1.0`). */
  vectorWeight?: number;
  /** Optional column to generate a `<mark>`-highlighted snippet from. */
  highlightColumn?: string;
  /** Optional MMR diversity trade-off $\lambda \in [0, 1]$ (`1` = pure relevance, `0.5` = balanced diversity, `M26 Item 3`). */
  diversityLambda?: number;
}

export type HybridSearchRow<T extends Row = Row> = T & {
  RRF_SCORE: number;
  BM25_SCORE: number | null;
  FTS_RANK: number | null;
  VECTOR_DISTANCE: number | null;
  VECTOR_SIMILARITY: number | null;
  VECTOR_RANK: number | null;
  HIGHLIGHT?: string;
};

/**
 * Execute a Hybrid Full-Text (BM25) + Vector Similarity search against a
 * Firebird table and fuse both rankings with Reciprocal Rank Fusion (RRF).
 */
export async function hybridSearch<T extends Row = Row>(
  db: FtsDatabaseExecutor,
  options: HybridSearchOptions,
): Promise<Array<HybridSearchRow<T>>> {
  const limit = options.limit ?? 10;
  const candidateLimit = Math.max(limit, options.candidateLimit ?? limit * 3);
  const keyColRaw = options.keyColumn ?? 'ID';
  const cleanKey = keyColRaw.trim().replace(/^"|"$/g, '');
  const rrfK = options.rrfK ?? 60;
  const ftsWeight = options.ftsWeight ?? 1.0;
  const vectorWeight = options.vectorWeight ?? 1.0;
  const needVectorsForMmr =
    options.diversityLambda !== undefined && options.diversityLambda < 1;

  // 1. Run FTS arm
  let ftsRows: Array<FtsSearchRow<Record<string, unknown>>>;
  if (options.ftsIndex) {
    ftsRows = await options.ftsIndex.search<Record<string, unknown>>(options.textQuery, {
      limit: candidateLimit,
      where: options.where,
      params: options.params,
      select: options.select,
      highlightColumn: options.highlightColumn,
    });
  } else {
    if (!options.ftsColumns || options.ftsColumns.length === 0) {
      throw new RangeError('hybridSearch requires either ftsIndex or ftsColumns');
    }
    const tempFts = await createFtsIndex(db, {
      table: options.table,
      columns: options.ftsColumns,
      keyColumn: keyColRaw,
    });
    ftsRows = await tempFts.search<Record<string, unknown>>(options.textQuery, {
      limit: candidateLimit,
      where: options.where,
      params: options.params,
      select: options.select,
      highlightColumn: options.highlightColumn,
    });
  }

  // 2. Run Vector arm
  const vecRows = await vectorSearch<Record<string, unknown>>(db, {
    table: options.table,
    column: options.vectorColumn,
    query: options.vectorQuery,
    metric: options.metric,
    where: options.where,
    params: options.params,
    select: options.select,
    limit: candidateLimit,
    index: options.vectorIndex,
    quantization: options.quantization,
    includeVector: needVectorsForMmr,
  });

  // 3. Fuse via Reciprocal Rank Fusion
  const rowMap = new Map<string, Record<string, unknown>>();
  const ftsScoreMap = new Map<string, number>();
  const highlightMap = new Map<string, string>();
  const rawVecById = new Map<string, unknown>();
  const ftsIds: string[] = [];

  for (const r of ftsRows) {
    const kv = getFieldCI(r, cleanKey);
    if (!kv || kv.value === null || kv.value === undefined) continue;
    const idKey = String(kv.value);
    ftsIds.push(idKey);
    ftsScoreMap.set(idKey, r.BM25_SCORE);
    if (typeof r.HIGHLIGHT === 'string') {
      highlightMap.set(idKey, r.HIGHLIGHT);
    }
    const cleanRow: Record<string, unknown> = { ...r };
    delete cleanRow.BM25_SCORE;
    delete cleanRow.HIGHLIGHT;
    rowMap.set(idKey, cleanRow);
  }

  const vecDistMap = new Map<string, { distance: number; similarity: number }>();
  const vecIds: string[] = [];
  const rawVecColClean = options.vectorColumn.trim().replace(/^"|"$/g, '');

  for (const r of vecRows) {
    const kv = getFieldCI(r, cleanKey);
    if (!kv || kv.value === null || kv.value === undefined) continue;
    const idKey = String(kv.value);
    vecIds.push(idKey);
    vecDistMap.set(idKey, { distance: r.DISTANCE, similarity: r.SIMILARITY });
    const vf = getFieldCI(r, rawVecColClean);
    if (vf && vf.value !== undefined && vf.value !== null) {
      rawVecById.set(idKey, vf.value);
    }
    if (!rowMap.has(idKey)) {
      const cleanRow: Record<string, unknown> = { ...r };
      delete cleanRow.DISTANCE;
      delete cleanRow.SIMILARITY;
      if (vf) delete cleanRow[vf.key];
      rowMap.set(idKey, cleanRow);
    }
  }

  const fusedPoolLimit = needVectorsForMmr ? candidateLimit : limit;
  const fused = reciprocalRankFusion(
    [
      { items: ftsIds, weight: ftsWeight },
      { items: vecIds, weight: vectorWeight },
    ],
    { rrfK, limit: fusedPoolLimit },
  );

  const candidates: Array<HybridSearchRow<T> & { __idKey?: string }> = [];
  for (const item of fused) {
    const baseRow = rowMap.get(item.id);
    if (!baseRow) continue;
    const vecMeta = vecDistMap.get(item.id);
    const hl =
      highlightMap.get(item.id) ??
      (options.highlightColumn
        ? (() => {
            const f = getFieldCI(baseRow, options.highlightColumn);
            return f && f.value != null
              ? highlightSnippet(String(f.value), options.textQuery)
              : undefined;
          })()
        : undefined);

    const merged: Record<string, unknown> = {
      ...baseRow,
      RRF_SCORE: item.rrfScore,
      BM25_SCORE: ftsScoreMap.get(item.id) ?? null,
      FTS_RANK: item.ranks[0] ?? null,
      VECTOR_DISTANCE: vecMeta?.distance ?? null,
      VECTOR_SIMILARITY: vecMeta?.similarity ?? null,
      VECTOR_RANK: item.ranks[1] ?? null,
    };
    if (hl !== undefined) {
      merged.HIGHLIGHT = hl;
    }
    Object.defineProperty(merged, '__idKey', { value: item.id, enumerable: false });
    candidates.push(merged as HybridSearchRow<T> & { __idKey?: string });
  }

  if (needVectorsForMmr && candidates.length > 1) {
    const { mmrRerank } = await import('../rag-cache');
    return mmrRerank(candidates, {
      limit,
      diversityLambda: options.diversityLambda,
      getRelevance: (item) => item.RRF_SCORE,
      getVector: (item) =>
        (item.__idKey ? (rawVecById.get(item.__idKey) as VectorInput | undefined) : undefined),
      getText: (item) => {
        if (options.highlightColumn) {
          const f = getFieldCI(item as Record<string, unknown>, options.highlightColumn);
          if (f && f.value != null) return String(f.value);
        }
        return JSON.stringify(item);
      },
    });
  }

  return candidates.slice(0, limit);
}
