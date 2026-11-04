/**
 * firebird-wasm/fts – Full-Text Search (BM25), Stemming, Highlighting &
 * Hybrid Reciprocal Rank Fusion (RRF) Search.
 *
 * Provides:
 * - Unicode tokenization, diacritic folding, stopword filtering, and Porter stemming (`tokenizeText`, `stemWord`)
 * - Snippet extraction & term highlighting (`highlightSnippet`)
 * - In-memory and database-persisted Okapi BM25 inverted index (`Bm25Index`, `createFtsIndex`)
 * - SQL UDR registration (`registerFtsFunctions`: `FTS_TOKENIZE`, `FTS_STEM`, `FTS_BM25`, `FTS_HIGHLIGHT`)
 * - Reciprocal Rank Fusion (`reciprocalRankFusion`, `hybridSearch`) combining BM25 keyword search with `vectorSearch`
 */

import type {
  JsFunctionHandler,
  QueryParams,
  QueryResult,
  RegisterFunctionOptions,
  RegisteredRoutine,
  Row,
} from '../types';
import {
  vectorSearch,
  type PersistentVectorIndex,
  type VectorDistanceMetric,
  type VectorInput,
} from '../vector';

// ---------------------------------------------------------------------------
// Stopwords & Porter Stemmer
// ---------------------------------------------------------------------------

/**
 * Default English stopword set filtered out during tokenization unless
 * `stopwords: false` or a custom set is passed.
 */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off',
  'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

/**
 * Options for {@link tokenizeText}.
 */
export interface TokenizeOptions {
  /** Apply Porter stemming to each token (default: `true`). */
  stem?: boolean;
  /** Fold Unicode diacritics, e.g. `'café'` -> `'cafe'` (default: `true`). */
  foldDiacritics?: boolean;
  /**
   * Stopword list to exclude, or `false` to keep all words.
   * Defaults to {@link DEFAULT_STOPWORDS}.
   */
  stopwords?: Iterable<string> | false;
  /** Minimum character length for a token (default: `2`). */
  minTokenLength?: number;
}

function isConsonant(word: string, i: number): boolean {
  const ch = word[i];
  if (ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u') {
    return false;
  }
  if (ch === 'y') {
    return i === 0 ? true : !isConsonant(word, i - 1);
  }
  return true;
}

function measureConsonantSeq(stem: string): number {
  let m = 0;
  let i = 0;
  const len = stem.length;
  while (i < len && isConsonant(stem, i)) i++;
  while (i < len) {
    while (i < len && !isConsonant(stem, i)) i++;
    if (i >= len) break;
    m++;
    while (i < len && isConsonant(stem, i)) i++;
  }
  return m;
}

function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) {
    if (!isConsonant(stem, i)) return true;
  }
  return false;
}

function endsWithDoubleConsonant(word: string): boolean {
  if (word.length < 2) return false;
  if (word[word.length - 1] !== word[word.length - 2]) return false;
  return isConsonant(word, word.length - 1);
}

function isCvc(word: string): boolean {
  const len = word.length;
  if (len < 3) return false;
  if (
    !isConsonant(word, len - 1) ||
    isConsonant(word, len - 2) ||
    !isConsonant(word, len - 3)
  ) {
    return false;
  }
  const last = word[len - 1];
  return last !== 'w' && last !== 'x' && last !== 'y';
}

/**
 * Lightweight English Porter stemmer reducing inflected words to their root
 * stem (e.g. `'running'` -> `'run'`, `'databases'` -> `'databas'`, `'queries'` -> `'queri'`).
 */
export function stemWord(raw: string): string {
  let w = raw.toLowerCase().trim();
  if (w.length < 3 || !/^[a-z]+$/.test(w)) {
    return w;
  }

  // Step 1a
  if (w.endsWith('sses')) {
    w = w.slice(0, -2);
  } else if (w.endsWith('ies')) {
    w = w.slice(0, -2);
  } else if (!w.endsWith('ss') && w.endsWith('s')) {
    w = w.slice(0, -1);
  }

  // Step 1b
  let step1bSecond = false;
  if (w.endsWith('eed')) {
    const stem = w.slice(0, -3);
    if (measureConsonantSeq(stem) > 0) {
      w = w.slice(0, -1);
    }
  } else if (w.endsWith('ed')) {
    const stem = w.slice(0, -2);
    if (hasVowel(stem)) {
      w = stem;
      step1bSecond = true;
    }
  } else if (w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    if (hasVowel(stem)) {
      w = stem;
      step1bSecond = true;
    }
  }

  if (step1bSecond) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (
      endsWithDoubleConsonant(w) &&
      !w.endsWith('l') &&
      !w.endsWith('s') &&
      !w.endsWith('z')
    ) {
      w = w.slice(0, -1);
    } else if (measureConsonantSeq(w) === 1 && isCvc(w)) {
      w += 'e';
    }
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) {
    w = w.slice(0, -1) + 'i';
  }

  // Step 2
  const step2Suffixes: ReadonlyArray<[string, string]> = [
    ['ational', 'ate'],
    ['tional', 'tion'],
    ['enci', 'ence'],
    ['anci', 'ance'],
    ['izer', 'ize'],
    ['abli', 'able'],
    ['alli', 'al'],
    ['entli', 'ent'],
    ['eli', 'e'],
    ['ousli', 'ous'],
    ['ization', 'ize'],
    ['ation', 'ate'],
    ['ator', 'ate'],
    ['alism', 'al'],
    ['iveness', 'ive'],
    ['fulness', 'ful'],
    ['ousness', 'ous'],
    ['aliti', 'al'],
    ['iviti', 'ive'],
    ['biliti', 'ble'],
    ['logi', 'log'],
  ];
  for (const [suffix, replacement] of step2Suffixes) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (measureConsonantSeq(stem) > 0) {
        w = stem + replacement;
      }
      break;
    }
  }

  // Step 3
  const step3Suffixes: ReadonlyArray<[string, string]> = [
    ['icate', 'ic'],
    ['ative', ''],
    ['alize', 'al'],
    ['iciti', 'ic'],
    ['ical', 'ic'],
    ['ful', ''],
    ['ness', ''],
  ];
  for (const [suffix, replacement] of step3Suffixes) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (measureConsonantSeq(stem) > 0) {
        w = stem + replacement;
      }
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement',
    'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
  ];
  for (const suffix of step4Suffixes) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (suffix === 'ion') {
        if ((stem.endsWith('s') || stem.endsWith('t')) && measureConsonantSeq(stem) > 1) {
          w = stem;
        }
      } else if (measureConsonantSeq(stem) > 1) {
        w = stem;
      }
      break;
    }
  }

  // Step 5a & 5b
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    const m = measureConsonantSeq(stem);
    if (m > 1 || (m === 1 && !isCvc(stem))) {
      w = stem;
    }
  }
  if (w.endsWith('ll') && measureConsonantSeq(w) > 1) {
    w = w.slice(0, -1);
  }

  return w;
}

function foldAccents(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Tokenize text into normalized, stopword-filtered, and optionally stemmed terms.
 */
export function tokenizeText(
  text: string,
  options: TokenizeOptions = {},
): string[] {
  if (!text) return [];
  const fold = options.foldDiacritics !== false;
  const doStem = options.stem !== false;
  const minLen = options.minTokenLength ?? 2;
  const stopSet: ReadonlySet<string> | null =
    options.stopwords === false
      ? null
      : options.stopwords === undefined
        ? DEFAULT_STOPWORDS
        : options.stopwords instanceof Set
          ? (options.stopwords as ReadonlySet<string>)
          : new Set(Array.from(options.stopwords, (s) => s.toLowerCase()));

  const normalized = (fold ? foldAccents(text) : text).toLowerCase();
  const rawTokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];

  for (const raw of rawTokens) {
    if (raw.length < minLen) continue;
    if (stopSet && stopSet.has(raw)) continue;
    const token = doStem ? stemWord(raw) : raw;
    if (token.length >= minLen) {
      out.push(token);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Snippet Extraction & Term Highlighting
// ---------------------------------------------------------------------------

/**
 * Options for {@link highlightSnippet}.
 */
export interface HighlightSnippetOptions extends TokenizeOptions {
  /** Opening tag around matched words (default: `'<mark>'`). */
  openTag?: string;
  /** Closing tag around matched words (default: `'</mark>'`). */
  closeTag?: string;
  /** Maximum character window before ellipsis truncation (default: `200`). */
  maxLength?: number;
}

/**
 * Extract the most relevant snippet from `text` matching `query` and wrap
 * matching terms in `openTag` / `closeTag` (`<mark>...</mark>` by default).
 */
export function highlightSnippet(
  text: string,
  query: string,
  options: HighlightSnippetOptions = {},
): string {
  if (!text) return '';
  const openTag = options.openTag ?? '<mark>';
  const closeTag = options.closeTag ?? '</mark>';
  const maxLength = options.maxLength ?? 200;
  const queryTerms = new Set(tokenizeText(query, options));
  if (queryTerms.size === 0) {
    return text.length > maxLength ? text.slice(0, maxLength).trimEnd() + '…' : text;
  }

  const fold = options.foldDiacritics !== false;
  const doStem = options.stem !== false;
  const wordRegex = /[\p{L}\p{N}]+/gu;
  const matches: Array<{ start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0];
    const norm = (fold ? foldAccents(word) : word).toLowerCase();
    const stem = doStem ? stemWord(norm) : norm;
    if (queryTerms.has(stem) || queryTerms.has(norm)) {
      matches.push({ start: match.index, end: match.index + word.length });
    }
  }

  let windowStart = 0;
  let windowEnd = text.length;
  if (text.length > maxLength) {
    const anchor = matches[0]?.start ?? 0;
    const half = Math.floor(maxLength / 2);
    windowStart = Math.max(0, anchor - half);
    windowEnd = Math.min(text.length, windowStart + maxLength);
    if (windowStart > 0) {
      const nextSpace = text.indexOf(' ', windowStart);
      if (nextSpace !== -1 && nextSpace < windowStart + 20) {
        windowStart = nextSpace + 1;
      }
    }
    if (windowEnd < text.length) {
      const prevSpace = text.lastIndexOf(' ', windowEnd);
      if (prevSpace > windowEnd - 20) {
        windowEnd = prevSpace;
      }
    }
  }

  let result = windowStart > 0 ? '…' : '';
  let cursor = windowStart;
  for (const m of matches) {
    if (m.end <= windowStart || m.start >= windowEnd) continue;
    const s = Math.max(windowStart, m.start);
    const e = Math.min(windowEnd, m.end);
    result += text.slice(cursor, s) + openTag + text.slice(s, e) + closeTag;
    cursor = e;
  }
  result += text.slice(cursor, windowEnd);
  if (windowEnd < text.length) {
    result += '…';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Okapi BM25 Inverted Index (`Bm25Index`)
// ---------------------------------------------------------------------------

/**
 * Configuration options for {@link Bm25Index}.
 */
export interface Bm25IndexOptions extends TokenizeOptions {
  /**
   * BM25 term-frequency saturation parameter $k_1$ (default: `1.2`).
   */
  k1?: number;
  /**
   * BM25 document-length normalization parameter $b \in [0, 1]$ (default: `0.75`).
   */
  b?: number;
  /**
   * Optional per-field weight multipliers when indexing multi-field objects
   * (e.g. `{ TITLE: 2.0, BODY: 1.0 }`).
   */
  fieldWeights?: Record<string, number>;
}

/**
 * Options for {@link Bm25Index.search}.
 */
export interface Bm25SearchOptions<ID = string | number> {
  /** Maximum number of results to return (default: `10`). */
  limit?: number;
  /**
   * Whether a document must match `'any'` query term (OR, default) or `'all'`
   * query terms (AND).
   */
  matchMode?: 'any' | 'all';
  /** Optional predicate to filter candidate document IDs. */
  filter?: (id: ID) => boolean;
  /** Minimum BM25 score cutoff. */
  minScore?: number;
}

/**
 * A single document match returned by {@link Bm25Index.search}.
 */
export interface Bm25SearchResult<ID = string | number> {
  id: ID;
  score: number;
  matchedTerms: string[];
}

/**
 * JSON-serializable snapshot of a {@link Bm25Index}.
 */
export interface SerializedBm25Index<ID = string | number> {
  version: 1;
  k1: number;
  b: number;
  stem: boolean;
  foldDiacritics: boolean;
  minTokenLength: number;
  fieldWeights: Record<string, number>;
  docs: Array<{
    id: ID;
    length: number;
    termFreqs: Record<string, number>;
  }>;
}

interface DocEntry<ID> {
  id: ID;
  length: number;
  termFreqs: Map<string, number>;
}

/**
 * In-memory Okapi BM25 inverted index supporting multi-field boosting,
 * incremental document updates/removals, and JSON serialization.
 */
export class Bm25Index<ID = string | number> {
  readonly k1: number;
  readonly b: number;
  readonly fieldWeights: Record<string, number>;
  private readonly tokenizeOpts: TokenizeOptions;

  private _docs = new Map<ID, DocEntry<ID>>();
  /** `term -> Map<docId, weightedTermFreq>` */
  private _postings = new Map<string, Map<ID, number>>();
  private _totalLength = 0;

  constructor(options: Bm25IndexOptions = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.fieldWeights = {};
    if (options.fieldWeights) {
      for (const [k, v] of Object.entries(options.fieldWeights)) {
        this.fieldWeights[k.toUpperCase()] = v;
      }
    }
    this.tokenizeOpts = {
      stem: options.stem,
      foldDiacritics: options.foldDiacritics,
      stopwords: options.stopwords,
      minTokenLength: options.minTokenLength,
    };
  }

  /** Number of documents in the index. */
  get size(): number {
    return this._docs.size;
  }

  /** Number of unique terms in the inverted index. */
  get vocabularySize(): number {
    return this._postings.size;
  }

  /** Average weighted document length across all indexed documents. */
  get averageDocumentLength(): number {
    return this._docs.size === 0 ? 0 : this._totalLength / this._docs.size;
  }

  /** Return `true` if document `id` is indexed. */
  has(id: ID): boolean {
    return this._docs.has(id);
  }

  /**
   * Add or update a document in the BM25 index.
   * `content` may be a plain string or an object mapping column names to text values.
   */
  add(id: ID, content: string | Record<string, unknown>): void {
    if (this._docs.has(id)) {
      this.remove(id);
    }

    const termFreqs = new Map<string, number>();
    let docLength = 0;

    if (typeof content === 'string') {
      const tokens = tokenizeText(content, this.tokenizeOpts);
      docLength = tokens.length;
      for (const tok of tokens) {
        termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + 1);
      }
    } else if (content && typeof content === 'object') {
      for (const [field, val] of Object.entries(content)) {
        if (val === null || val === undefined) continue;
        const weight = this.fieldWeights[field.toUpperCase()] ?? 1;
        if (weight <= 0) continue;
        const tokens = tokenizeText(String(val), this.tokenizeOpts);
        docLength += tokens.length * weight;
        for (const tok of tokens) {
          termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + weight);
        }
      }
    }

    const entry: DocEntry<ID> = { id, length: docLength, termFreqs };
    this._docs.set(id, entry);
    this._totalLength += docLength;

    for (const [term, tf] of termFreqs.entries()) {
      let posting = this._postings.get(term);
      if (!posting) {
        posting = new Map<ID, number>();
        this._postings.set(term, posting);
      }
      posting.set(id, tf);
    }
  }

  /**
   * Remove a document by `id`. Returns `true` if the document was present.
   */
  remove(id: ID): boolean {
    const entry = this._docs.get(id);
    if (!entry) return false;

    this._docs.delete(id);
    this._totalLength = Math.max(0, this._totalLength - entry.length);

    for (const term of entry.termFreqs.keys()) {
      const posting = this._postings.get(term);
      if (posting) {
        posting.delete(id);
        if (posting.size === 0) {
          this._postings.delete(term);
        }
      }
    }
    return true;
  }

  /**
   * Search the index using Okapi BM25 ranking:
   * $$\text{IDF}(q_i) = \ln\!\left(1 + \frac{N - n(q_i) + 0.5}{n(q_i) + 0.5}\right)$$
   * $$\text{Score}(D, Q) = \sum_{q_i \in Q} \text{IDF}(q_i) \cdot \frac{f(q_i, D)\cdot(k_1 + 1)}{f(q_i, D) + k_1\cdot\left(1 - b + b\cdot\frac{|D|}{\text{avgdl}}\right)}$$
   */
  search(
    query: string,
    options: Bm25SearchOptions<ID> = {},
  ): Array<Bm25SearchResult<ID>> {
    const N = this._docs.size;
    if (N === 0) return [];

    const queryTokens = Array.from(new Set(tokenizeText(query, this.tokenizeOpts)));
    if (queryTokens.length === 0) return [];

    const limit = options.limit ?? 10;
    const matchMode = options.matchMode ?? 'any';
    const avgdl = this.averageDocumentLength || 1;
    const k1 = this.k1;
    const b = this.b;

    const scores = new Map<ID, { score: number; matchedTerms: string[] }>();

    for (const term of queryTokens) {
      const posting = this._postings.get(term);
      if (!posting || posting.size === 0) {
        if (matchMode === 'all') {
          return [];
        }
        continue;
      }

      const df = posting.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const [docId, tf] of posting.entries()) {
        if (options.filter && !options.filter(docId)) continue;
        const doc = this._docs.get(docId);
        if (!doc) continue;

        const normLen = 1 - b + b * (doc.length / avgdl);
        const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * normLen));

        let acc = scores.get(docId);
        if (!acc) {
          acc = { score: 0, matchedTerms: [] };
          scores.set(docId, acc);
        }
        acc.score += termScore;
        acc.matchedTerms.push(term);
      }
    }

    const out: Array<Bm25SearchResult<ID>> = [];
    for (const [id, entry] of scores.entries()) {
      if (matchMode === 'all' && entry.matchedTerms.length < queryTokens.length) {
        continue;
      }
      if (options.minScore !== undefined && entry.score < options.minScore) {
        continue;
      }
      out.push({ id, score: entry.score, matchedTerms: entry.matchedTerms });
    }

    out.sort((a, bItem) => bItem.score - a.score);
    return out.slice(0, limit);
  }

  /**
   * Export the BM25 index to a JSON-serializable structure.
   */
  toJSON(): SerializedBm25Index<ID> {
    const docs: SerializedBm25Index<ID>['docs'] = [];
    for (const entry of this._docs.values()) {
      const termFreqs: Record<string, number> = {};
      for (const [t, f] of entry.termFreqs.entries()) {
        termFreqs[t] = f;
      }
      docs.push({ id: entry.id, length: entry.length, termFreqs });
    }
    return {
      version: 1,
      k1: this.k1,
      b: this.b,
      stem: this.tokenizeOpts.stem !== false,
      foldDiacritics: this.tokenizeOpts.foldDiacritics !== false,
      minTokenLength: this.tokenizeOpts.minTokenLength ?? 2,
      fieldWeights: { ...this.fieldWeights },
      docs,
    };
  }

  /**
   * Serialize the BM25 index to UTF-8 JSON bytes (`Uint8Array`).
   */
  serialize(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.toJSON()));
  }

  /**
   * Reconstruct a {@link Bm25Index} from {@link serialize} or {@link toJSON} output.
   */
  static deserialize<ID = string | number>(
    input: Uint8Array | SerializedBm25Index<ID> | string,
  ): Bm25Index<ID> {
    let data: SerializedBm25Index<ID>;
    if (input instanceof Uint8Array) {
      data = JSON.parse(new TextDecoder().decode(input)) as SerializedBm25Index<ID>;
    } else if (typeof input === 'string') {
      data = JSON.parse(input) as SerializedBm25Index<ID>;
    } else {
      data = input;
    }

    if (!data || data.version !== 1) {
      throw new Error(
        `Unsupported BM25 serialized index version: ${String((data as { version?: unknown })?.version)}`,
      );
    }

    const index = new Bm25Index<ID>({
      k1: data.k1,
      b: data.b,
      stem: data.stem,
      foldDiacritics: data.foldDiacritics,
      minTokenLength: data.minTokenLength,
      fieldWeights: data.fieldWeights,
    });

    for (const d of data.docs) {
      const termFreqs = new Map<string, number>();
      for (const [term, tf] of Object.entries(d.termFreqs)) {
        termFreqs.set(term, tf);
        let posting = index._postings.get(term);
        if (!posting) {
          posting = new Map<ID, number>();
          index._postings.set(term, posting);
        }
        posting.set(d.id, tf);
      }
      index._docs.set(d.id, { id: d.id, length: d.length, termFreqs });
      index._totalLength += d.length;
    }

    return index;
  }
}

// ---------------------------------------------------------------------------
// Database-Backed Persistent Full-Text Index (`createFtsIndex`)
// ---------------------------------------------------------------------------

export interface FtsDatabaseExecutor {
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
  ): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  registerFunction?(
    name: string,
    options: RegisterFunctionOptions,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
}

/**
 * Options for {@link createFtsIndex}.
 */
export interface CreateFtsIndexOptions extends Bm25IndexOptions {
  /** Target table name. */
  table: string;
  /** One or more text columns to index (e.g. `['title', 'body']`). */
  columns: readonly string[];
  /** Primary-key column on `table` (default: `'ID'`). */
  keyColumn?: string;
  /** Optional explicit index name (default: `'IDX_<TABLE>_FTS'`). */
  name?: string;
  /**
   * Persist the inverted index inside `FB_FTS_INDEX$` and reload it if present
   * (default: `false`).
   */
  persist?: boolean;
  /** Force a full rebuild from `table` even if `FB_FTS_INDEX$` has a snapshot. */
  forceRebuild?: boolean;
}

/**
 * Options for {@link PersistentFtsIndex.search}.
 */
export interface PersistentFtsSearchOptions {
  /** Maximum number of rows to return (default: `10`). */
  limit?: number;
  /** Match `'any'` query term (default) or `'all'` query terms. */
  matchMode?: 'any' | 'all';
  /** Optional SQL `WHERE` clause for pre-filtering candidate rows. */
  where?: string;
  /** Positional parameters for `where`. */
  params?: QueryParams;
  /** Columns to select from `table` (default: `'*'`). */
  select?: readonly string[] | '*';
  /** Minimum BM25 score cutoff. */
  minScore?: number;
  /** Property name for the BM25 score on each returned row (default: `'BM25_SCORE'`). */
  scoreColumn?: string;
  /**
   * Optional column name from `table` to generate a highlighted snippet for
   * (added as `highlightTargetColumn`, default `'HIGHLIGHT'`).
   */
  highlightColumn?: string;
  /** Property name for the generated snippet (default: `'HIGHLIGHT'`). */
  highlightTargetColumn?: string;
}

export type FtsSearchRow<T extends Row = Row> = T & {
  BM25_SCORE: number;
  HIGHLIGHT?: string;
};

/**
 * Handle to a table-bound BM25 Full-Text Search index created by {@link createFtsIndex}.
 */
export interface PersistentFtsIndex<ID = string | number> {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly keyColumn: string;
  readonly bm25: Bm25Index<ID>;
  readonly size: number;

  upsert(id: ID, content: string | Record<string, unknown>): Promise<void>;
  remove(id: ID): Promise<boolean>;
  rebuild(): Promise<void>;
  save(): Promise<void>;
  drop(): Promise<void>;
  search<T extends Row = Row>(
    query: string,
    options?: PersistentFtsSearchOptions,
  ): Promise<Array<FtsSearchRow<T>>>;
}

const FTS_INDEX_TABLE = 'FB_FTS_INDEX$';

function quoteIdent(ident: string, label: string): string {
  const trimmed = ident.trim();
  if (!trimmed) {
    throw new RangeError(`${label} cannot be empty`);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
    throw new RangeError(`Invalid ${label} '${ident}'`);
  }
  return `"${trimmed.toUpperCase()}"`;
}

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

async function runSql(
  db: FtsDatabaseExecutor,
  sql: string,
  params?: QueryParams,
): Promise<void> {
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
  } else {
    await db.query(sql, params);
  }
}

async function ensureFtsCatalogTable(db: FtsDatabaseExecutor): Promise<void> {
  const check = await db.query<{ CNT: number }>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = '${FTS_INDEX_TABLE}'`,
  );
  if (Number(check.rows[0]?.CNT ?? 0) > 0) return;

  await runSql(
    db,
    `CREATE TABLE "${FTS_INDEX_TABLE}" (
      INDEX_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
      TABLE_NAME VARCHAR(128) NOT NULL,
      COLUMNS_CSV VARCHAR(512) NOT NULL,
      KEY_COLUMN VARCHAR(128) NOT NULL,
      INDEX_JSON BLOB SUB_TYPE TEXT NOT NULL,
      UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

/**
 * Create (or load) an Okapi BM25 Full-Text Search index over one or more text
 * columns of a Firebird table.
 */
export async function createFtsIndex<ID = number | string>(
  db: FtsDatabaseExecutor,
  options: CreateFtsIndexOptions,
): Promise<PersistentFtsIndex<ID>> {
  if (!options.columns || options.columns.length === 0) {
    throw new RangeError('createFtsIndex requires at least one column');
  }
  const tableIdent = quoteIdent(options.table, 'table name');
  const keyColRaw = options.keyColumn ?? 'ID';
  const keyIdent = quoteIdent(keyColRaw, 'key column name');
  const colIdents = options.columns.map((c) => quoteIdent(c, 'column name'));
  const cleanTable = options.table.trim().replace(/^"|"$/g, '').toUpperCase();
  const cleanKey = keyColRaw.trim().replace(/^"|"$/g, '');
  const cleanCols = options.columns.map((c) => c.trim().replace(/^"|"$/g, ''));
  const indexName = (options.name ?? `IDX_${cleanTable}_FTS`).toUpperCase();
  const persist = options.persist === true;

  let bm25 = new Bm25Index<ID>(options);

  const populateFromTable = async (): Promise<void> => {
    bm25 = new Bm25Index<ID>(options);
    const res = await db.query<Record<string, unknown>>(
      `SELECT ${keyIdent}, ${colIdents.join(', ')} FROM ${tableIdent}`,
    );
    for (const row of res.rows) {
      const kEntry = getFieldCI(row, cleanKey);
      if (!kEntry || kEntry.value === null || kEntry.value === undefined) continue;
      const fieldsObj: Record<string, unknown> = {};
      for (const col of cleanCols) {
        const cEntry = getFieldCI(row, col);
        if (cEntry && cEntry.value !== null && cEntry.value !== undefined) {
          fieldsObj[col.toUpperCase()] = cEntry.value;
        }
      }
      bm25.add(kEntry.value as ID, fieldsObj);
    }
  };

  const saveToCatalog = async (): Promise<void> => {
    await ensureFtsCatalogTable(db);
    const json = JSON.stringify(bm25.toJSON());
    await runSql(
      db,
      `UPDATE OR INSERT INTO "${FTS_INDEX_TABLE}" (INDEX_NAME, TABLE_NAME, COLUMNS_CSV, KEY_COLUMN, INDEX_JSON, UPDATED_AT)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (INDEX_NAME)`,
      [
        indexName,
        cleanTable,
        cleanCols.map((c) => c.toUpperCase()).join(','),
        cleanKey.toUpperCase(),
        json,
      ],
    );
  };

  if (persist) {
    await ensureFtsCatalogTable(db);
    if (!options.forceRebuild) {
      const saved = await db.query<{ INDEX_JSON: string }>(
        `SELECT INDEX_JSON FROM "${FTS_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
        [indexName],
      );
      const indexJson = saved.rows[0]?.INDEX_JSON;
      if (typeof indexJson === 'string' && indexJson.length > 0) {
        bm25 = Bm25Index.deserialize<ID>(indexJson);
      } else {
        await populateFromTable();
        await saveToCatalog();
      }
    } else {
      await populateFromTable();
      await saveToCatalog();
    }
  } else {
    await populateFromTable();
  }

  return {
    name: indexName,
    table: options.table,
    columns: options.columns,
    keyColumn: keyColRaw,
    get bm25(): Bm25Index<ID> {
      return bm25;
    },
    get size(): number {
      return bm25.size;
    },
    async upsert(id: ID, content: string | Record<string, unknown>): Promise<void> {
      bm25.add(id, content);
      if (persist) {
        await saveToCatalog();
      }
    },
    async remove(id: ID): Promise<boolean> {
      const removed = bm25.remove(id);
      if (removed && persist) {
        await saveToCatalog();
      }
      return removed;
    },
    async rebuild(): Promise<void> {
      await populateFromTable();
      if (persist) {
        await saveToCatalog();
      }
    },
    async save(): Promise<void> {
      await saveToCatalog();
    },
    async drop(): Promise<void> {
      for (const d of bm25.toJSON().docs) {
        bm25.remove(d.id);
      }
      if (persist) {
        await ensureFtsCatalogTable(db);
        await runSql(
          db,
          `DELETE FROM "${FTS_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
          [indexName],
        );
      }
    },
    async search<T extends Row = Row>(
      query: string,
      searchOpts: PersistentFtsSearchOptions = {},
    ): Promise<Array<FtsSearchRow<T>>> {
      const limit = searchOpts.limit ?? 10;
      const scoreCol = searchOpts.scoreColumn ?? 'BM25_SCORE';
      const highlightTargetCol = searchOpts.highlightTargetColumn ?? 'HIGHLIGHT';

      let allowedIds: Set<string> | null = null;
      if (searchOpts.where?.trim()) {
        const filterRes = await db.query<Record<string, unknown>>(
          `SELECT ${keyIdent} FROM ${tableIdent} WHERE ${searchOpts.where.trim()}`,
          searchOpts.params ?? [],
        );
        allowedIds = new Set<string>();
        for (const r of filterRes.rows) {
          const kv = getFieldCI(r, cleanKey);
          if (kv && kv.value !== null && kv.value !== undefined) {
            allowedIds.add(String(kv.value));
          }
        }
        if (allowedIds.size === 0) return [];
      }

      const hits = bm25.search(query, {
        limit,
        matchMode: searchOpts.matchMode,
        filter: allowedIds ? (id) => allowedIds!.has(String(id)) : undefined,
        minScore: searchOpts.minScore,
      });

      if (hits.length === 0) return [];

      let selectClause = '*';
      if (Array.isArray(searchOpts.select) && searchOpts.select.length > 0) {
        const requested = [...searchOpts.select];
        const hasKeyCol = requested.some(
          (s) =>
            s.trim() === '*' ||
            s.trim().replace(/^"|"$/g, '').toUpperCase() === cleanKey.toUpperCase(),
        );
        if (!hasKeyCol) {
          requested.push(keyIdent);
        }
        selectClause = requested.join(', ');
      }

      const placeholders = hits.map(() => '?').join(', ');
      const rowRes = await db.query<Record<string, unknown>>(
        `SELECT ${selectClause} FROM ${tableIdent} WHERE ${keyIdent} IN (${placeholders})`,
        hits.map((h) => h.id),
      );

      const rowById = new Map<string, Record<string, unknown>>();
      for (const r of rowRes.rows) {
        const kv = getFieldCI(r, cleanKey);
        if (kv && kv.value !== null && kv.value !== undefined) {
          rowById.set(String(kv.value), r);
        }
      }

      const out: Array<FtsSearchRow<T>> = [];
      for (const hit of hits) {
        const row = rowById.get(String(hit.id));
        if (!row) continue;
        const copy: Record<string, unknown> = { ...row, [scoreCol]: hit.score };
        if (searchOpts.highlightColumn) {
          const hlField = getFieldCI(row, searchOpts.highlightColumn);
          if (hlField && hlField.value !== null && hlField.value !== undefined) {
            copy[highlightTargetCol] = highlightSnippet(String(hlField.value), query, options);
          }
        }
        out.push(copy as FtsSearchRow<T>);
      }

      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// SQL UDR Registration (`registerFtsFunctions`)
// ---------------------------------------------------------------------------

/**
 * Register Full-Text Search utility functions on `db` via `db.registerFunction()`:
 * - `FTS_TOKENIZE(text)` -> JSON array of stemmed tokens (`VARCHAR(4096)`)
 * - `FTS_STEM(word)` -> Porter-stemmed token (`VARCHAR(256)`)
 * - `FTS_BM25(doc_text, query_text)` -> single-document BM25 relevance score (`DOUBLE PRECISION`)
 * - `FTS_HIGHLIGHT(doc_text, query_text)` -> `<mark>`-highlighted snippet (`VARCHAR(4096)`)
 */
export async function registerFtsFunctions(
  db: FtsDatabaseExecutor,
  options: { replace?: boolean } = {},
): Promise<RegisteredRoutine[]> {
  if (typeof db.registerFunction !== 'function') {
    throw new TypeError('Database instance does not support db.registerFunction()');
  }
  const replace = options.replace !== false;
  const routines: RegisteredRoutine[] = [];

  routines.push(
    await db.registerFunction(
      'FTS_TOKENIZE',
      {
        args: ['VARCHAR(8191)'],
        returns: 'VARCHAR(4096)',
        deterministic: true,
        replace,
      },
      (text: unknown) => {
        if (text == null) return null;
        return JSON.stringify(tokenizeText(String(text)));
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'FTS_STEM',
      {
        args: ['VARCHAR(256)'],
        returns: 'VARCHAR(256)',
        deterministic: true,
        replace,
      },
      (word: unknown) => {
        if (word == null) return null;
        return stemWord(String(word));
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'FTS_BM25',
      {
        args: ['VARCHAR(8191)', 'VARCHAR(1024)'],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (docText: unknown, queryText: unknown) => {
        if (docText == null || queryText == null) return null;
        const docTokens = tokenizeText(String(docText));
        const qTokens = tokenizeText(String(queryText));
        if (docTokens.length === 0 || qTokens.length === 0) return 0;
        const tfMap = new Map<string, number>();
        for (const t of docTokens) {
          tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
        }
        const k1 = 1.2;
        const b = 0.75;
        const avgdl = 50;
        const normLen = 1 - b + b * (docTokens.length / avgdl);
        let score = 0;
        for (const q of new Set(qTokens)) {
          const tf = tfMap.get(q) ?? 0;
          if (tf > 0) {
            score += (tf * (k1 + 1)) / (tf + k1 * normLen);
          }
        }
        return score;
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'FTS_HIGHLIGHT',
      {
        args: ['VARCHAR(8191)', 'VARCHAR(1024)'],
        returns: 'VARCHAR(4096)',
        deterministic: true,
        replace,
      },
      (docText: unknown, queryText: unknown) => {
        if (docText == null || queryText == null) return null;
        return highlightSnippet(String(docText), String(queryText));
      },
    ),
  );

  return routines;
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF) & Hybrid Search (`hybridSearch`)
// ---------------------------------------------------------------------------

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
  /** Optional SQL `WHERE` filter applied to both arms. */
  where?: string;
  /** Positional parameters for `where`. */
  params?: QueryParams;
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

  // 1. Run FTS arm
  let ftsRows: Array<FtsSearchRow<Record<string, unknown>>>;
  if (options.ftsIndex) {
    ftsRows = await options.ftsIndex.search<Record<string, unknown>>(options.textQuery, {
      limit: candidateLimit,
      where: options.where,
      params: options.params,
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
    limit: candidateLimit,
    index: options.vectorIndex,
  });

  // 3. Fuse via Reciprocal Rank Fusion
  const rowMap = new Map<string, Record<string, unknown>>();
  const ftsScoreMap = new Map<string, number>();
  const highlightMap = new Map<string, string>();
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

  for (const r of vecRows) {
    const kv = getFieldCI(r, cleanKey);
    if (!kv || kv.value === null || kv.value === undefined) continue;
    const idKey = String(kv.value);
    vecIds.push(idKey);
    vecDistMap.set(idKey, { distance: r.DISTANCE, similarity: r.SIMILARITY });
    if (!rowMap.has(idKey)) {
      const cleanRow: Record<string, unknown> = { ...r };
      delete cleanRow.DISTANCE;
      delete cleanRow.SIMILARITY;
      rowMap.set(idKey, cleanRow);
    }
  }

  const fused = reciprocalRankFusion(
    [
      { items: ftsIds, weight: ftsWeight },
      { items: vecIds, weight: vectorWeight },
    ],
    { rrfK, limit },
  );

  const out: Array<HybridSearchRow<T>> = [];
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
    out.push(merged as HybridSearchRow<T>);
  }

  return out;
}
