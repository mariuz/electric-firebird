/**
 * rag-cache.ts – Persistent Semantic Query Cache (`"FB_SEMANTIC_CACHE$"`),
 * Maximal Marginal Relevance (`mmrRerank`) Diversity Reranking & Token-Budgeted
 * RAG Context Packer (`packRagContext`) (`M26 Item 3`).
 */

import type { QueryParams, QueryResult, Row } from './types';
import {
  HnswIndex,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  type VectorInput,
  type VectorQuantizationMode,
} from './vector';

/** Default system-excluded Firebird table backing {@link createSemanticCache} (`M26 Item 3`). */
export const DEFAULT_SEMANTIC_CACHE_TABLE = 'FB_SEMANTIC_CACHE$';

/** Options for Maximal Marginal Relevance ({@link mmrRerank}) (`M26 Item 3`). */
export interface MmrRerankOptions<T> {
  /** Trade-off $\lambda \in [0, 1]$ between query relevance (`1.0`) and inter-item diversity (`0.0`). @default 0.7 */
  diversityLambda?: number;
  /** Maximum number of reranked items to return. @default candidates.length */
  limit?: number;
  /** Extract relevance score for a candidate (defaults to `SIMILARITY`, `RRF_SCORE`, `BM25_SCORE`, or `1 / (1 + DISTANCE)`). */
  getRelevance?: (item: T, index: number) => number;
  /** Optional vector extractor for exact cosine diversity penalty. */
  getVector?: (item: T) => VectorInput | null | undefined;
  /** Optional text extractor used for token-Jaccard similarity when vectors are absent. */
  getText?: (item: T) => string;
}

function tokenizeLower(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]{2,}/g);
  return new Set(tokens ?? []);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const tok of small) {
    if (large.has(tok)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function inferRelevance(item: unknown, index: number): number {
  if (item && typeof item === 'object') {
    const rec = item as Record<string, unknown>;
    for (const k of ['SIMILARITY', 'similarity', 'RRF_SCORE', 'rrfScore', 'BM25_SCORE', 'bm25Score']) {
      if (typeof rec[k] === 'number' && Number.isFinite(rec[k] as number)) {
        return rec[k] as number;
      }
    }
    for (const k of ['DISTANCE', 'distance']) {
      if (typeof rec[k] === 'number' && Number.isFinite(rec[k] as number)) {
        return 1 / (1 + Math.max(0, rec[k] as number));
      }
    }
  }
  return 1 / (1 + index);
}

function inferText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const rec = item as Record<string, unknown>;
    for (const k of ['CONTENT', 'content', 'TEXT', 'text', 'BODY', 'body', 'CHUNK', 'chunk', 'TITLE', 'title']) {
      if (typeof rec[k] === 'string') return rec[k] as string;
    }
    return JSON.stringify(rec);
  }
  return String(item ?? '');
}

/**
 * Rerank search candidates via **Maximal Marginal Relevance (MMR)** (`M26 Item 3`):
 * $$\text{MMR} = \arg\max_{d_i \in R \setminus S} \left[\lambda \cdot \text{Rel}(d_i) - (1 - \lambda) \max_{d_j \in S} \text{Sim}(d_i, d_j)\right]$$
 */
export function mmrRerank<T>(
  candidates: readonly T[],
  options: MmrRerankOptions<T> = {},
): T[] {
  const n = candidates.length;
  const limit = Math.max(0, Math.min(n, options.limit ?? n));
  if (limit === 0 || n === 0) return [];
  if (n === 1) return [candidates[0]!];

  const lambda = Math.max(0, Math.min(1, options.diversityLambda ?? 0.7));
  const rawRel = candidates.map((item, idx) =>
    options.getRelevance ? options.getRelevance(item, idx) : inferRelevance(item, idx),
  );
  const maxR = Math.max(...rawRel);
  const minR = Math.min(...rawRel);
  const normRel =
    minR >= 0 && maxR > 1e-12
      ? rawRel.map((r) => r / maxR)
      : (() => {
          const span = maxR - minR;
          return rawRel.map((r) => (span > 1e-12 ? (r - minR) / span : 1));
        })();

  const vectors: Array<Float32Array | null> = candidates.map((item) => {
    if (options.getVector) {
      const v = options.getVector(item);
      if (v !== null && v !== undefined) {
        try {
          return decodeVector(v);
        } catch {
          return null;
        }
      }
    }
    return null;
  });

  const tokenSets: Array<Set<string> | null> = candidates.map((item, i) =>
    vectors[i] ? null : tokenizeLower(options.getText ? options.getText(item) : inferText(item)),
  );

  const pairSimilarity = (i: number, j: number): number => {
    const vi = vectors[i];
    const vj = vectors[j];
    if (vi && vj && vi.length === vj.length) {
      return Math.max(0, Math.min(1, cosineSimilarity(vi, vj)));
    }
    const ti = tokenSets[i] ?? tokenizeLower(inferText(candidates[i]));
    const tj = tokenSets[j] ?? tokenizeLower(inferText(candidates[j]));
    return jaccardSimilarity(ti, tj);
  };

  const selectedIndices: number[] = [];
  const remaining = new Set<number>();
  for (let i = 0; i < n; i++) remaining.add(i);

  while (selectedIndices.length < limit && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const candIdx of remaining) {
      const rel = normRel[candIdx]!;
      let maxSimToSelected = 0;
      for (const selIdx of selectedIndices) {
        const sim = pairSimilarity(candIdx, selIdx);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const mmrScore =
        selectedIndices.length === 0
          ? rel
          : lambda * rel - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = candIdx;
      }
    }

    if (bestIdx === -1) break;
    selectedIndices.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selectedIndices.map((idx) => candidates[idx]!);
}

/** Options for {@link packRagContext} (`M26 Item 3`). */
export interface PackRagContextOptions<T> {
  /** Maximum prompt token budget for the assembled context. */
  tokenBudget: number;
  /** Approximate characters per token used for deterministic token budgeting. @default 4 */
  charsPerToken?: number;
  /** Column/property holding the passage text (auto-detected if omitted). */
  textColumn?: string;
  /** Optional title column prepended to each formatted passage. */
  titleColumn?: string;
  /** Primary key / document ID column used in citation labels. @default 'ID' */
  keyColumn?: string;
  /** Jaccard token overlap threshold $[0, 1]$ above which near-duplicate chunks are skipped. @default 0.85 */
  dedupeOverlap?: number;
  /** Separator inserted between packed chunks. @default '\n\n' */
  separator?: string;
  /** Custom citation label formatter (defaults to `"[1] (id=<key>)"`). */
  formatCitation?: (hit: T, index: number, docId: string) => string;
}

/** Single included chunk inside {@link PackedRagContext} (`M26 Item 3`). */
export interface PackedRagChunk<T> {
  readonly index: number;
  readonly id: string;
  readonly citation: string;
  readonly text: string;
  readonly estimatedTokens: number;
  readonly source: T;
}

/** Assembled RAG prompt context returned by {@link packRagContext} (`M26 Item 3`). */
export interface PackedRagContext<T> {
  readonly promptContext: string;
  readonly includedChunks: readonly PackedRagChunk<T>[];
  readonly omittedCount: number;
  readonly duplicateCount: number;
  readonly estimatedTokens: number;
  readonly citations: readonly string[];
}

function readPropCI(obj: Record<string, unknown>, col: string): unknown {
  if (col in obj) return obj[col];
  const upper = col.toUpperCase();
  if (upper in obj) return obj[upper];
  const lower = col.toLowerCase();
  if (lower in obj) return obj[lower];
  for (const k of Object.keys(obj)) {
    if (k.toUpperCase() === upper) return obj[k];
  }
  return undefined;
}

/**
 * Pack retrieved vector / hybrid search hits into a deduplicated, citation-annotated
 * RAG context string strictly within `tokenBudget` (`M26 Item 3`).
 */
export function packRagContext<T extends Record<string, unknown>>(
  hits: readonly T[],
  options: PackRagContextOptions<T>,
): PackedRagContext<T> {
  const tokenBudget = Math.max(1, Math.floor(options.tokenBudget));
  const charsPerToken = Math.max(1, options.charsPerToken ?? 4);
  const dedupeOverlap = options.dedupeOverlap ?? 0.85;
  const separator = options.separator ?? '\n\n';
  const keyCol = options.keyColumn ?? 'ID';

  const estimateTokens = (s: string): number =>
    s.length === 0 ? 0 : Math.ceil(s.length / charsPerToken);

  const includedChunks: PackedRagChunk<T>[] = [];
  const acceptedTokenSets: Set<string>[] = [];
  const citations: string[] = [];
  const formattedBlocks: string[] = [];
  let duplicateCount = 0;
  let omittedCount = 0;
  let usedChars = 0;
  const maxBudgetChars = tokenBudget * charsPerToken;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const rawText = options.textColumn
      ? readPropCI(hit, options.textColumn)
      : (readPropCI(hit, 'CONTENT') ??
          readPropCI(hit, 'TEXT') ??
          readPropCI(hit, 'BODY') ??
          readPropCI(hit, 'CHUNK') ??
          readPropCI(hit, 'SUMMARY'));
    const bodyText = rawText != null ? String(rawText).trim() : '';
    if (!bodyText) {
      omittedCount += 1;
      continue;
    }

    const tokSet = tokenizeLower(bodyText);
    if (dedupeOverlap > 0 && dedupeOverlap < 1) {
      const isDup = acceptedTokenSets.some(
        (existing) => jaccardSimilarity(existing, tokSet) >= dedupeOverlap,
      );
      if (isDup) {
        duplicateCount += 1;
        omittedCount += 1;
        continue;
      }
    }

    const rawId = readPropCI(hit, keyCol);
    const docId = rawId != null ? String(rawId) : String(i + 1);
    const chunkNumber = includedChunks.length + 1;
    const citation = options.formatCitation
      ? options.formatCitation(hit, chunkNumber, docId)
      : `[${chunkNumber}] (id=${docId})`;
    const rawTitle = options.titleColumn
      ? readPropCI(hit, options.titleColumn)
      : readPropCI(hit, 'TITLE');
    const titlePrefix = rawTitle != null && String(rawTitle).trim() ? `${String(rawTitle).trim()}: ` : '';

    const sepOverhead = formattedBlocks.length > 0 ? separator.length : 0;
    const header = `${citation} ${titlePrefix}`;
    const fullBlock = `${header}${bodyText}`;

    if (usedChars + sepOverhead + fullBlock.length <= maxBudgetChars) {
      usedChars += sepOverhead + fullBlock.length;
      formattedBlocks.push(fullBlock);
      acceptedTokenSets.push(tokSet);
      citations.push(citation);
      includedChunks.push({
        index: chunkNumber,
        id: docId,
        citation,
        text: bodyText,
        estimatedTokens: estimateTokens(fullBlock),
        source: hit,
      });
    } else if (includedChunks.length === 0 && maxBudgetChars > header.length + 4) {
      // Truncate first oversized passage cleanly so caller gets useful context within budget
      const avail = maxBudgetChars - header.length - 1;
      const sliced = `${bodyText.slice(0, Math.max(1, avail)).trimEnd()}…`;
      const truncatedBlock = `${header}${sliced}`;
      usedChars += truncatedBlock.length;
      formattedBlocks.push(truncatedBlock);
      acceptedTokenSets.push(tokSet);
      citations.push(citation);
      includedChunks.push({
        index: chunkNumber,
        id: docId,
        citation,
        text: sliced,
        estimatedTokens: Math.min(tokenBudget, estimateTokens(truncatedBlock)),
        source: hit,
      });
    } else {
      omittedCount += 1;
    }
  }

  const promptContext = formattedBlocks.join(separator);
  return {
    promptContext,
    includedChunks,
    omittedCount,
    duplicateCount,
    estimatedTokens: Math.min(tokenBudget, estimateTokens(promptContext)),
    citations,
  };
}

// ---------------------------------------------------------------------------
// Persistent Semantic Query Cache (`"FB_SEMANTIC_CACHE$"`)
// ---------------------------------------------------------------------------

/** Minimal database executor required by {@link createSemanticCache} (`M26 Item 3`). */
export interface SemanticCacheDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<unknown>;
}

/** Options for {@link createSemanticCache} (`M26 Item 3`). */
export interface SemanticCacheOptions {
  /** Backing Firebird table name. @default 'FB_SEMANTIC_CACHE$' */
  tableName?: string;
  /** Minimum cosine similarity $\in (0, 1]$ required for a semantic cache hit. @default 0.92 */
  similarityThreshold?: number;
  /** Optional default entry TTL in milliseconds (`undefined` = no expiration). */
  ttlMs?: number;
  /** Optional maximum cached entries before oldest entries are evicted. @default 1000 */
  maxEntries?: number;
  /** HNSW scalar quantization mode for fast low-memory similarity lookup. @default 'int8' */
  quantization?: VectorQuantizationMode;
  /** Logical cache namespace (e.g. model ID or tenant ID). @default 'default' */
  namespace?: string;
  /** Custom clock for deterministic TTL testing. @default Date.now */
  now?: () => number;
}

/** Hit returned by {@link SemanticCacheHandle.get} (`M26 Item 3`). */
export interface SemanticCacheHit<T = unknown> {
  readonly key: string;
  readonly namespace: string;
  readonly prompt: string;
  readonly response: T;
  readonly metadata: Record<string, unknown> | null;
  readonly similarity: number;
  readonly distance: number;
  readonly createdAt: number;
  readonly hitCount: number;
}

/** Telemetry counters returned by {@link SemanticCacheHandle.stats} (`M26 Item 3`). */
export interface SemanticCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly entryCount: number;
  readonly namespace: string;
}

/** Persistent semantic query cache handle (`M26 Item 3`). */
export interface SemanticCacheHandle {
  readonly tableName: string;
  get<T = unknown>(
    queryEmbedding: VectorInput,
    options?: { namespace?: string; similarityThreshold?: number; now?: number },
  ): Promise<SemanticCacheHit<T> | null>;
  set<T = unknown>(entry: {
    key?: string;
    prompt: string;
    embedding: VectorInput;
    response: T;
    metadata?: Record<string, unknown>;
    namespace?: string;
    ttlMs?: number;
    now?: number;
  }): Promise<string>;
  invalidate(options?: {
    key?: string;
    namespace?: string;
    expiredBefore?: number;
  }): Promise<number>;
  clear(namespace?: string): Promise<number>;
  stats(namespace?: string): Promise<SemanticCacheStats>;
  close(): Promise<void>;
}

function quoteCacheIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function execCacheSql(
  db: SemanticCacheDatabaseExecutor,
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

/**
 * Create a persistent semantic LLM / tool query cache backed by `"FB_SEMANTIC_CACHE$"`
 * and an auto-synced quantized `HnswIndex` (`M26 Item 3`).
 */
export function createSemanticCache(
  db: SemanticCacheDatabaseExecutor,
  options: SemanticCacheOptions = {},
): SemanticCacheHandle {
  const tableName = (
    (options.tableName ?? DEFAULT_SEMANTIC_CACHE_TABLE).trim() ||
    DEFAULT_SEMANTIC_CACHE_TABLE
  ).toUpperCase();
  const defaultThreshold = options.similarityThreshold ?? 0.92;
  const defaultTtlMs = options.ttlMs;
  const maxEntries = Math.max(1, options.maxEntries ?? 1_000);
  const quantization: VectorQuantizationMode = options.quantization ?? 'int8';
  const defaultNamespace = (options.namespace ?? 'default').trim() || 'default';
  const nowFn = options.now ?? Date.now;

  let hits = 0;
  let misses = 0;
  let keySeq = 1;
  let initPromise: Promise<void> | null = null;
  let hnsw: HnswIndex<string> | null = null;

  const rebuildHnswFromTable = async (ts: number): Promise<void> => {
    await execCacheSql(
      db,
      `DELETE FROM ${quoteCacheIdent(tableName)} WHERE EXPIRES_AT IS NOT NULL AND EXPIRES_AT <= ?`,
      [ts],
    );
    const res = await db.query<Record<string, unknown>>(
      `SELECT CACHE_KEY, EMBEDDING FROM ${quoteCacheIdent(tableName)}`,
    );
    hnsw = null;
    for (const row of res.rows) {
      const k = String(row.CACHE_KEY ?? row.cache_key ?? '');
      const rawEmb = row.EMBEDDING ?? row.embedding;
      if (!k || rawEmb === null || rawEmb === undefined) continue;
      const vec = decodeVector(rawEmb);
      if (!hnsw) {
        hnsw = new HnswIndex<string>({
          dimensions: vec.length,
          metric: 'cosine',
          quantization,
        });
      }
      if (vec.length === hnsw.dimensions) {
        hnsw.add(k, vec);
      }
    }
  };

  const ensureReady = async (ts = nowFn()): Promise<void> => {
    if (!initPromise) {
      initPromise = (async () => {
        const check = await db.query<{ CNT: number }>(
          'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
          [tableName],
        );
        if (Number(check.rows[0]?.CNT ?? 0) === 0) {
          await execCacheSql(
            db,
            `CREATE TABLE ${quoteCacheIdent(tableName)} (` +
              `CACHE_KEY VARCHAR(128) NOT NULL PRIMARY KEY, ` +
              `NAMESPACE VARCHAR(64) NOT NULL, ` +
              `PROMPT BLOB SUB_TYPE TEXT NOT NULL, ` +
              `RESPONSE_JSON BLOB SUB_TYPE TEXT NOT NULL, ` +
              `METADATA_JSON BLOB SUB_TYPE TEXT, ` +
              `EMBEDDING BLOB SUB_TYPE BINARY NOT NULL, ` +
              `CREATED_AT BIGINT NOT NULL, ` +
              `EXPIRES_AT BIGINT, ` +
              `HIT_COUNT INTEGER DEFAULT 0 NOT NULL` +
              `)`,
          );
        }
        await rebuildHnswFromTable(ts);
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  };

  return {
    tableName,

    async get<T = unknown>(
      queryEmbedding: VectorInput,
      getOpts: { namespace?: string; similarityThreshold?: number; now?: number } = {},
    ): Promise<SemanticCacheHit<T> | null> {
      const ts = getOpts.now ?? nowFn();
      await ensureReady(ts);
      const ns = (getOpts.namespace ?? defaultNamespace).trim() || defaultNamespace;
      const threshold = getOpts.similarityThreshold ?? defaultThreshold;
      const qVec = decodeVector(queryEmbedding);

      if (!hnsw || hnsw.size === 0 || qVec.length !== hnsw.dimensions) {
        misses += 1;
        return null;
      }

      const candidates = hnsw.search(qVec, { k: Math.min(16, hnsw.size), efSearch: 48 });
      for (const cand of candidates) {
        if (cand.similarity < threshold) continue;
        const rowRes = await db.query<Record<string, unknown>>(
          `SELECT CACHE_KEY, NAMESPACE, PROMPT, RESPONSE_JSON, METADATA_JSON, EMBEDDING, CREATED_AT, EXPIRES_AT, HIT_COUNT ` +
            `FROM ${quoteCacheIdent(tableName)} WHERE CACHE_KEY = ?`,
          [cand.id],
        );
        const row = rowRes.rows[0];
        if (!row) {
          hnsw.remove(cand.id);
          continue;
        }
        const expiresAt = row.EXPIRES_AT ?? row.expires_at;
        if (expiresAt !== null && expiresAt !== undefined && Number(expiresAt) <= ts) {
          hnsw.remove(cand.id);
          await execCacheSql(
            db,
            `DELETE FROM ${quoteCacheIdent(tableName)} WHERE CACHE_KEY = ?`,
            [cand.id],
          );
          continue;
        }
        const rowNs = String(row.NAMESPACE ?? row.namespace ?? '');
        if (rowNs !== ns) continue;

        // Exact float32 verification when HNSW used quantized scoring
        const exactVec = decodeVector(row.EMBEDDING ?? row.embedding);
        const exactSim = cosineSimilarity(qVec, exactVec);
        if (exactSim < threshold) continue;

        const nextHitCount = Number(row.HIT_COUNT ?? row.hit_count ?? 0) + 1;
        await execCacheSql(
          db,
          `UPDATE ${quoteCacheIdent(tableName)} SET HIT_COUNT = ? WHERE CACHE_KEY = ?`,
          [nextHitCount, cand.id],
        );
        hits += 1;
        const metaStr = row.METADATA_JSON ?? row.metadata_json;
        return {
          key: cand.id,
          namespace: rowNs,
          prompt: String(row.PROMPT ?? row.prompt ?? ''),
          response: JSON.parse(String(row.RESPONSE_JSON ?? row.response_json ?? 'null')) as T,
          metadata:
            metaStr !== null && metaStr !== undefined
              ? (JSON.parse(String(metaStr)) as Record<string, unknown>)
              : null,
          similarity: exactSim,
          distance: 1 - exactSim,
          createdAt: Number(row.CREATED_AT ?? row.created_at ?? ts),
          hitCount: nextHitCount,
        };
      }

      misses += 1;
      return null;
    },

    async set<T = unknown>(entry: {
      key?: string;
      prompt: string;
      embedding: VectorInput;
      response: T;
      metadata?: Record<string, unknown>;
      namespace?: string;
      ttlMs?: number;
      now?: number;
    }): Promise<string> {
      const ts = entry.now ?? nowFn();
      await ensureReady(ts);
      const ns = (entry.namespace ?? defaultNamespace).trim() || defaultNamespace;
      const key =
        entry.key?.trim() ||
        `sc_${ts.toString(36)}_${(keySeq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const vec = decodeVector(entry.embedding);
      const encodedBytes = encodeVector(vec);
      const ttl = entry.ttlMs ?? defaultTtlMs;
      const expiresAt = ttl !== undefined && ttl > 0 ? ts + ttl : null;
      const respJson = JSON.stringify(entry.response);
      const metaJson = entry.metadata ? JSON.stringify(entry.metadata) : null;

      await execCacheSql(
        db,
        `UPDATE OR INSERT INTO ${quoteCacheIdent(tableName)} ` +
          `(CACHE_KEY, NAMESPACE, PROMPT, RESPONSE_JSON, METADATA_JSON, EMBEDDING, CREATED_AT, EXPIRES_AT, HIT_COUNT) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) MATCHING (CACHE_KEY)`,
        [key, ns, entry.prompt, respJson, metaJson, encodedBytes, ts, expiresAt],
      );

      if (!hnsw || hnsw.dimensions !== vec.length) {
        hnsw = new HnswIndex<string>({
          dimensions: vec.length,
          metric: 'cosine',
          quantization,
        });
      }
      hnsw.add(key, vec);

      // Enforce maxEntries cap by evicting oldest rows
      const cntRes = await db.query<{ CNT: number }>(
        `SELECT COUNT(*) AS CNT FROM ${quoteCacheIdent(tableName)}`,
      );
      const total = Number(cntRes.rows[0]?.CNT ?? 0);
      if (total > maxEntries) {
        const overflow = total - maxEntries;
        const oldest = await db.query<{ CACHE_KEY: string }>(
          `SELECT FIRST ${overflow} CACHE_KEY FROM ${quoteCacheIdent(tableName)} ORDER BY CREATED_AT ASC`,
        );
        for (const r of oldest.rows) {
          const evictKey = String(r.CACHE_KEY ?? (r as Record<string, unknown>).cache_key ?? '');
          if (evictKey) {
            hnsw.remove(evictKey);
            await execCacheSql(
              db,
              `DELETE FROM ${quoteCacheIdent(tableName)} WHERE CACHE_KEY = ?`,
              [evictKey],
            );
          }
        }
      }

      return key;
    },

    async invalidate(invOpts = {}): Promise<number> {
      const ts = nowFn();
      await ensureReady(ts);
      if (invOpts.key) {
        const before = await db.query<{ CNT: number }>(
          `SELECT COUNT(*) AS CNT FROM ${quoteCacheIdent(tableName)} WHERE CACHE_KEY = ?`,
          [invOpts.key],
        );
        const count = Number(before.rows[0]?.CNT ?? 0);
        if (count > 0) {
          hnsw?.remove(invOpts.key);
          await execCacheSql(
            db,
            `DELETE FROM ${quoteCacheIdent(tableName)} WHERE CACHE_KEY = ?`,
            [invOpts.key],
          );
        }
        return count;
      }
      if (invOpts.expiredBefore !== undefined) {
        const expRows = await db.query<{ CACHE_KEY: string }>(
          `SELECT CACHE_KEY FROM ${quoteCacheIdent(tableName)} WHERE EXPIRES_AT IS NOT NULL AND EXPIRES_AT <= ?`,
          [invOpts.expiredBefore],
        );
        for (const r of expRows.rows) {
          const k = String(r.CACHE_KEY ?? (r as Record<string, unknown>).cache_key ?? '');
          if (k) hnsw?.remove(k);
        }
        if (expRows.rows.length > 0) {
          await execCacheSql(
            db,
            `DELETE FROM ${quoteCacheIdent(tableName)} WHERE EXPIRES_AT IS NOT NULL AND EXPIRES_AT <= ?`,
            [invOpts.expiredBefore],
          );
        }
        return expRows.rows.length;
      }
      if (invOpts.namespace) {
        return this.clear(invOpts.namespace);
      }
      return 0;
    },

    async clear(namespace?: string): Promise<number> {
      await ensureReady();
      if (namespace) {
        const ns = namespace.trim();
        const rows = await db.query<{ CACHE_KEY: string }>(
          `SELECT CACHE_KEY FROM ${quoteCacheIdent(tableName)} WHERE NAMESPACE = ?`,
          [ns],
        );
        for (const r of rows.rows) {
          const k = String(r.CACHE_KEY ?? (r as Record<string, unknown>).cache_key ?? '');
          if (k) hnsw?.remove(k);
        }
        await execCacheSql(
          db,
          `DELETE FROM ${quoteCacheIdent(tableName)} WHERE NAMESPACE = ?`,
          [ns],
        );
        return rows.rows.length;
      }
      const cntRes = await db.query<{ CNT: number }>(
        `SELECT COUNT(*) AS CNT FROM ${quoteCacheIdent(tableName)}`,
      );
      const count = Number(cntRes.rows[0]?.CNT ?? 0);
      await execCacheSql(db, `DELETE FROM ${quoteCacheIdent(tableName)}`);
      hnsw = null;
      return count;
    },

    async stats(namespace?: string): Promise<SemanticCacheStats> {
      await ensureReady();
      const ns = (namespace ?? defaultNamespace).trim() || defaultNamespace;
      const cntRes = namespace
        ? await db.query<{ CNT: number }>(
            `SELECT COUNT(*) AS CNT FROM ${quoteCacheIdent(tableName)} WHERE NAMESPACE = ?`,
            [ns],
          )
        : await db.query<{ CNT: number }>(
            `SELECT COUNT(*) AS CNT FROM ${quoteCacheIdent(tableName)}`,
          );
      const entryCount = Number(cntRes.rows[0]?.CNT ?? 0);
      const totalLookups = hits + misses;
      return {
        hits,
        misses,
        hitRate: totalLookups > 0 ? hits / totalLookups : 0,
        entryCount,
        namespace: ns,
      };
    },

    async close(): Promise<void> {
      hnsw = null;
      initPromise = null;
    },
  };
}
