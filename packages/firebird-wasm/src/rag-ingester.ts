/**
 * rag-ingester.ts – Markdown/Code-Aware Document Chunker (`chunkDocument`) &
 * Incremental SHA-256 Diffing RAG Ingestion Pipeline (`createRagIngester`) (`M27 Item 2`).
 */

import type { QueryParams, QueryResult, Row } from './types';
import {
  createVectorIndex,
  decodeVector,
  encodeVector,
  type PersistentVectorIndex,
  type VectorInput,
  type VectorQuantizationMode,
} from './vector';
import {
  createFtsIndex,
  hybridSearch,
  type PersistentFtsIndex,
} from './fts';
import {
  createSemanticCache,
  packRagContext,
  type PackedRagContext,
  type SemanticCacheHandle,
} from './rag-cache';

// ---------------------------------------------------------------------------
// Synchronous FIPS 180-4 SHA-256 for Deterministic Chunk Content Hashing
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const utf8Enc = new TextEncoder();

/** Compute standard FIPS 180-4 SHA-256 lowercase hex digest synchronously (`M27 Item 2`). */
export function sha256HexSync(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8Enc.encode(input) : input;
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const y = w[i - 2]!;
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Document Chunker (`chunkDocument`)
// ---------------------------------------------------------------------------

export type ChunkingStrategy = 'markdown' | 'recursive' | 'sentence';

/** Options for {@link chunkDocument} (`M27 Item 2`). */
export interface ChunkDocumentOptions {
  /** Maximum approximate tokens per chunk. @default 256 */
  maxTokens?: number;
  /** Overlap tokens carried into the next chunk within a section. @default 32 */
  overlapTokens?: number;
  /** Approximate characters per token. @default 4 */
  charsPerToken?: number;
  /** Splitting strategy. @default 'markdown' */
  strategy?: ChunkingStrategy;
}

/** Single semantic chunk produced by {@link chunkDocument} (`M27 Item 2`). */
export interface DocumentChunk {
  readonly index: number;
  readonly text: string;
  readonly headingPath: readonly string[];
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly estimatedTokens: number;
  readonly contentHash: string;
}

interface AtomicSegment {
  readonly text: string;
  readonly headingPath: readonly string[];
  readonly startOffset: number;
  readonly endOffset: number;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine1Based(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid]! <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, lo);
}

function splitLongTextIntoUnits(
  raw: string,
  baseOffset: number,
  maxChars: number,
  strategy: ChunkingStrategy,
): Array<{ text: string; startOffset: number; endOffset: number }> {
  if (raw.length <= maxChars) {
    return [{ text: raw, startOffset: baseOffset, endOffset: baseOffset + raw.length }];
  }

  // Split by sentences first, then fallback to words/slices
  const unitRegex =
    strategy === 'sentence'
      ? /[^.!?\n]+[.!?\n]+\s*|[^.!?\n]+$/g
      : /\n\n+|\n|[^.!?\n]+[.!?]+\s*|[^\s]+\s*/g;

  const out: Array<{ text: string; startOffset: number; endOffset: number }> = [];
  if (strategy === 'sentence') {
    let m: RegExpExecArray | null;
    while ((m = unitRegex.exec(raw)) !== null) {
      const piece = m[0]!;
      if (piece.length <= maxChars) {
        out.push({
          text: piece,
          startOffset: baseOffset + m.index,
          endOffset: baseOffset + m.index + piece.length,
        });
      } else {
        for (let pos = 0; pos < piece.length; pos += maxChars) {
          const sl = piece.slice(pos, pos + maxChars);
          out.push({
            text: sl,
            startOffset: baseOffset + m.index + pos,
            endOffset: baseOffset + m.index + pos + sl.length,
          });
        }
      }
    }
    return out;
  }

  // Recursive: paragraph -> line -> sentence -> word -> char slice
  const splitHierarchy = (text: string, offset: number, depth: number): void => {
    if (text.length <= maxChars) {
      if (text.trim().length > 0) {
        out.push({ text, startOffset: offset, endOffset: offset + text.length });
      }
      return;
    }
    const seps = ['\n\n', '\n', '. ', ' '];
    if (depth >= seps.length) {
      for (let p = 0; p < text.length; p += maxChars) {
        const sl = text.slice(p, p + maxChars);
        if (sl.trim().length > 0) {
          out.push({ text: sl, startOffset: offset + p, endOffset: offset + p + sl.length });
        }
      }
      return;
    }
    const sep = seps[depth]!;
    const parts = text.split(sep);
    if (parts.length <= 1) {
      splitHierarchy(text, offset, depth + 1);
      return;
    }
    let cursor = offset;
    for (let i = 0; i < parts.length; i++) {
      const partWithSep = i < parts.length - 1 ? `${parts[i]!}${sep}` : parts[i]!;
      splitHierarchy(partWithSep, cursor, depth + 1);
      cursor += partWithSep.length;
    }
  };

  splitHierarchy(raw, baseOffset, 0);
  return out;
}

function parseMarkdownSegments(
  text: string,
  maxChars: number,
  strategy: ChunkingStrategy,
): AtomicSegment[] {
  if (strategy !== 'markdown') {
    return splitLongTextIntoUnits(text, 0, maxChars, strategy).map((u) => ({
      ...u,
      headingPath: [],
    }));
  }

  const segments: AtomicSegment[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  const lines = text.split('\n');
  let offset = 0;
  let blockStart = 0;
  let blockText = '';
  let blockHasBody = false;
  let blockPath: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flushBlock = (): void => {
    if (blockText.trim().length > 0) {
      const subUnits = splitLongTextIntoUnits(blockText, blockStart, maxChars, 'recursive');
      for (const u of subUnits) {
        segments.push({
          text: u.text,
          headingPath: [...blockPath],
          startOffset: u.startOffset,
          endOffset: u.endOffset,
        });
      }
    }
    blockText = '';
    blockHasBody = false;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = idx < lines.length - 1 ? `${lines[idx]!}\n` : lines[idx]!;
    const trimmed = lines[idx]!.trim();

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      if (!inFence) {
        if (blockHasBody) {
          flushBlock();
          blockStart = offset;
          blockPath = headingStack.map((h) => h.title);
        } else if (blockText.length === 0) {
          blockStart = offset;
          blockPath = headingStack.map((h) => h.title);
        }
        inFence = true;
        blockHasBody = true;
        fenceMarker = fenceMatch[1]![0]!.repeat(fenceMatch[1]!.length);
        blockText += rawLine;
        offset += rawLine.length;
        continue;
      } else if (trimmed.startsWith(fenceMarker)) {
        blockText += rawLine;
        offset += rawLine.length;
        inFence = false;
        fenceMarker = '';
        flushBlock();
        blockStart = offset;
        blockPath = headingStack.map((h) => h.title);
        continue;
      }
    }

    if (!inFence) {
      const hMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
      if (hMatch) {
        const level = hMatch[1]!.length;
        const prevLevel =
          headingStack.length > 0 ? headingStack[headingStack.length - 1]!.level : 0;
        if (blockHasBody || (blockText.trim().length > 0 && level <= prevLevel)) {
          flushBlock();
        }
        const title = hMatch[2]!.replace(/\s+#+\s*$/, '').trim();
        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, title });
        if (blockText.length === 0) {
          blockStart = offset;
        }
        blockPath = headingStack.map((h) => h.title);
        blockText += rawLine;
        offset += rawLine.length;
        continue;
      }

      if (trimmed === '') {
        if (blockHasBody) {
          blockText += rawLine;
          offset += rawLine.length;
          flushBlock();
          blockStart = offset;
          blockPath = headingStack.map((h) => h.title);
        } else if (blockText.length > 0) {
          blockText += rawLine;
          offset += rawLine.length;
        } else {
          offset += rawLine.length;
        }
        continue;
      }
    }

    if (blockText.length === 0) {
      blockStart = offset;
      blockPath = headingStack.map((h) => h.title);
    }
    blockHasBody = true;
    blockText += rawLine;
    offset += rawLine.length;
  }

  flushBlock();
  return segments;
}

/**
 * Split Markdown, source code, or prose into heading-aware, overlap-windowed
 * chunks with character/line offsets and FIPS 180-4 SHA-256 content hashes (`M27 Item 2`).
 */
export function chunkDocument(
  text: string,
  options: ChunkDocumentOptions = {},
): DocumentChunk[] {
  if (!text || text.trim().length === 0) return [];
  const maxTokens = Math.max(8, Math.floor(options.maxTokens ?? 256));
  const charsPerToken = Math.max(1, options.charsPerToken ?? 4);
  const overlapTokens = Math.max(
    0,
    Math.min(Math.floor(maxTokens / 2), options.overlapTokens ?? Math.min(32, Math.floor(maxTokens * 0.15))),
  );
  const maxChars = maxTokens * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;
  const strategy: ChunkingStrategy = options.strategy ?? 'markdown';

  const lineStarts = buildLineStarts(text);
  const atomic = parseMarkdownSegments(text, maxChars, strategy);
  if (atomic.length === 0) return [];

  const chunks: DocumentChunk[] = [];
  let acc: AtomicSegment[] = [];
  let accLen = 0;

  const emitAcc = (): void => {
    if (acc.length === 0) return;
    const rawJoined = acc.map((s) => s.text).join('');
    const trimmedLeading = rawJoined.length - rawJoined.trimStart().length;
    const trimmedTrailing = rawJoined.length - rawJoined.trimEnd().length;
    const cleanText = rawJoined.trim();
    if (!cleanText) {
      acc = [];
      accLen = 0;
      return;
    }
    const startOffset = acc[0]!.startOffset + trimmedLeading;
    const endOffset = Math.max(startOffset, acc[acc.length - 1]!.endOffset - trimmedTrailing);
    const headingPath = acc[acc.length - 1]!.headingPath;
    const idx = chunks.length;
    const hashInput = `${headingPath.join(' > ')}\n${cleanText}`;
    chunks.push({
      index: idx,
      text: cleanText,
      headingPath,
      startOffset,
      endOffset,
      startLine: offsetToLine1Based(lineStarts, startOffset),
      endLine: offsetToLine1Based(lineStarts, Math.max(0, endOffset - 1)),
      estimatedTokens: Math.max(1, Math.ceil(cleanText.length / charsPerToken)),
      contentHash: sha256HexSync(hashInput),
    });

    if (overlapChars > 0) {
      const kept: AtomicSegment[] = [];
      let keptLen = 0;
      for (let i = acc.length - 1; i >= 0; i--) {
        const seg = acc[i]!;
        if (keptLen + seg.text.length > overlapChars && kept.length > 0) break;
        if (seg.text.length <= overlapChars) {
          kept.unshift(seg);
          keptLen += seg.text.length;
        }
      }
      acc = kept;
      accLen = keptLen;
    } else {
      acc = [];
      accLen = 0;
    }
  };

  for (const seg of atomic) {
    const sameSection =
      acc.length === 0 ||
      acc[acc.length - 1]!.headingPath.join('\0') === seg.headingPath.join('\0');
    if (!sameSection) {
      // Flush cleanly at major section boundary without carrying stale heading overlap
      const savedOverlap = overlapChars;
      if (savedOverlap >= 0) {
        emitAcc();
        acc = [];
        accLen = 0;
      }
    }
    if (accLen + seg.text.length > maxChars && acc.length > 0) {
      emitAcc();
      // Ensure progress even if overlap + seg exceeds maxChars
      if (accLen + seg.text.length > maxChars) {
        acc = [];
        accLen = 0;
      }
    }
    acc.push(seg);
    accLen += seg.text.length;
  }
  if (acc.length > 0) {
    // Only emit trailing accumulator if it contains content beyond overlap from previous chunk
    const candidateClean = acc.map((s) => s.text).join('').trim();
    const prevText = chunks[chunks.length - 1]?.text ?? '';
    if (candidateClean && !prevText.endsWith(candidateClean)) {
      emitAcc();
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Incremental RAG Ingestion Pipeline (`createRagIngester`)
// ---------------------------------------------------------------------------

export const DEFAULT_RAG_CHUNKS_TABLE = 'FB_RAG_CHUNKS';

/** Minimal database interface required by {@link createRagIngester} (`M27 Item 2`). */
export interface RagIngesterDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<unknown>;
  execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
}

/** Input document passed to {@link RagIngesterHandle.ingestDocument} (`M27 Item 2`). */
export interface RagDocumentInput {
  readonly docId: string;
  readonly text: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Per-document ingestion telemetry (`M27 Item 2`). */
export interface RagIngestResult {
  readonly docId: string;
  readonly totalChunks: number;
  readonly embeddedChunks: number;
  readonly skippedChunks: number;
  readonly deletedChunks: number;
}

/** Options for {@link createRagIngester} (`M27 Item 2`). */
export interface RagIngesterOptions {
  /** Target Firebird table storing chunk rows and embeddings. @default 'FB_RAG_CHUNKS' */
  table?: string;
  /** Embedding callback mapping batch of chunk strings -> `VectorInput[]`. */
  embed: (texts: readonly string[]) => Promise<readonly VectorInput[]> | readonly VectorInput[];
  /** Chunking options passed to {@link chunkDocument}. */
  chunkOptions?: ChunkDocumentOptions;
  /** HNSW scalar quantization mode. @default 'int8' */
  quantization?: VectorQuantizationMode;
  /** Persist HNSW & BM25 indexes in `FB_VECTOR_INDEX$` / `FB_FTS_INDEX$`. @default true */
  persistIndexes?: boolean;
  /** Optional `SemanticCacheHandle` or `true` to cache `askContext()` query embeddings. */
  semanticCache?: SemanticCacheHandle | boolean;
}

/** Handle returned by {@link createRagIngester} (`M27 Item 2`). */
export interface RagIngesterHandle {
  readonly tableName: string;
  ingestDocument(doc: RagDocumentInput): Promise<RagIngestResult>;
  ingestMany(docs: readonly RagDocumentInput[]): Promise<{
    documentsProcessed: number;
    totalChunks: number;
    embeddedChunks: number;
    skippedChunks: number;
    deletedChunks: number;
  }>;
  deleteDocument(docId: string): Promise<number>;
  askContext(
    queryText: string,
    options?: {
      tokenBudget?: number;
      limit?: number;
      diversityLambda?: number;
      dedupeOverlap?: number;
      where?: string;
      params?: QueryParams;
    },
  ): Promise<PackedRagContext<Record<string, unknown>> & { fromCache: boolean }>;
  close(): Promise<void>;
}

function quoteRagIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function execRagSql(
  db: RagIngesterDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.exec === 'function') await db.exec(sql, params);
  else if (typeof db.execute === 'function') await db.execute(sql, params);
  else await db.query(sql, params);
}

/**
 * Create an end-to-end incremental RAG document ingester backed by Firebird `IBatch`,
 * SHA-256 chunk content-hash diffing, quantized HNSW + BM25 hybrid search, and
 * `packRagContext` (`M27 Item 2`).
 */
export function createRagIngester(
  db: RagIngesterDatabaseExecutor,
  options: RagIngesterOptions,
): RagIngesterHandle {
  const tableName = (
    (options.table ?? DEFAULT_RAG_CHUNKS_TABLE).trim() || DEFAULT_RAG_CHUNKS_TABLE
  ).toUpperCase();
  const quantization: VectorQuantizationMode = options.quantization ?? 'int8';
  const persistIndexes = options.persistIndexes !== false;

  const ownedCache =
    options.semanticCache === true
      ? createSemanticCache(db, { quantization, namespace: `rag:${tableName}` })
      : null;
  const semCache: SemanticCacheHandle | null =
    typeof options.semanticCache === 'object' && options.semanticCache !== null
      ? options.semanticCache
      : ownedCache;

  let readyPromise: Promise<void> | null = null;
  let vecIndex: PersistentVectorIndex<string> | null = null;
  let ftsIndex: PersistentFtsIndex<string> | null = null;

  const ensureTable = async (): Promise<void> => {
    if (!readyPromise) {
      readyPromise = (async () => {
        const check = await db.query<{ CNT: number }>(
          'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
          [tableName],
        );
        if (Number(check.rows[0]?.CNT ?? 0) === 0) {
          await execRagSql(
            db,
            `CREATE TABLE ${quoteRagIdent(tableName)} (` +
              `CHUNK_ID VARCHAR(160) NOT NULL PRIMARY KEY, ` +
              `DOC_ID VARCHAR(128) NOT NULL, ` +
              `CHUNK_INDEX INTEGER NOT NULL, ` +
              `TITLE VARCHAR(255), ` +
              `HEADING_PATH VARCHAR(512), ` +
              `START_LINE INTEGER NOT NULL, ` +
              `END_LINE INTEGER NOT NULL, ` +
              `CONTENT BLOB SUB_TYPE TEXT NOT NULL, ` +
              `CONTENT_HASH VARCHAR(64) NOT NULL, ` +
              `METADATA_JSON BLOB SUB_TYPE TEXT, ` +
              `EMBEDDING BLOB SUB_TYPE BINARY NOT NULL` +
              `)`,
          );
        }
      })().catch((err) => {
        readyPromise = null;
        throw err;
      });
    }
    return readyPromise;
  };

  const syncSearchIndexes = async (): Promise<void> => {
    const cntRes = await db.query<{ CNT: number }>(
      `SELECT COUNT(*) AS CNT FROM ${quoteRagIdent(tableName)}`,
    );
    if (Number(cntRes.rows[0]?.CNT ?? 0) === 0) {
      vecIndex = null;
      ftsIndex = null;
      return;
    }
    if (!vecIndex) {
      vecIndex = await createVectorIndex<string>(db, {
        name: `IDX_VEC_${tableName}`,
        table: tableName,
        keyColumn: 'CHUNK_ID',
        column: 'EMBEDDING',
        metric: 'cosine',
        quantization,
        persist: persistIndexes,
        forceRebuild: true,
      });
    } else {
      await vecIndex.rebuild();
    }
    if (!ftsIndex) {
      ftsIndex = await createFtsIndex<string>(db, {
        name: `IDX_FTS_${tableName}`,
        table: tableName,
        keyColumn: 'CHUNK_ID',
        columns: ['TITLE', 'HEADING_PATH', 'CONTENT'],
        persist: persistIndexes,
        forceRebuild: true,
      });
    } else {
      await ftsIndex.rebuild();
    }
  };

  return {
    tableName,

    async ingestDocument(doc: RagDocumentInput): Promise<RagIngestResult> {
      await ensureTable();
      const chunks = chunkDocument(doc.text, options.chunkOptions);

      const existingRes = await db.query<{ CHUNK_ID: string; CONTENT_HASH: string }>(
        `SELECT CHUNK_ID, CONTENT_HASH FROM ${quoteRagIdent(tableName)} WHERE DOC_ID = ?`,
        [doc.docId],
      );
      const existingHashes = new Map<string, string>();
      for (const r of existingRes.rows) {
        const cid = String(r.CHUNK_ID ?? (r as Record<string, unknown>).chunk_id ?? '');
        const ch = String(r.CONTENT_HASH ?? (r as Record<string, unknown>).content_hash ?? '');
        if (cid) existingHashes.set(cid, ch);
      }

      const activeChunkIds = new Set<string>();
      const changed: Array<{ chunkId: string; chunk: DocumentChunk }> = [];
      let skippedChunks = 0;

      for (const ch of chunks) {
        const chunkId = `${doc.docId}#${ch.index}`;
        activeChunkIds.add(chunkId);
        if (existingHashes.get(chunkId) === ch.contentHash) {
          skippedChunks += 1;
        } else {
          changed.push({ chunkId, chunk: ch });
        }
      }

      if (changed.length > 0) {
        const textsToEmbed = changed.map(({ chunk }) =>
          chunk.headingPath.length > 0
            ? `${chunk.headingPath.join(' > ')}\n${chunk.text}`
            : chunk.text,
        );
        const embeddings = await options.embed(textsToEmbed);
        if (embeddings.length !== changed.length) {
          throw new Error(
            `embed() returned ${embeddings.length} vectors for ${changed.length} chunks`,
          );
        }

        const metaJson = doc.metadata ? JSON.stringify(doc.metadata) : null;
        const upsertSql =
          `UPDATE OR INSERT INTO ${quoteRagIdent(tableName)} ` +
          `(CHUNK_ID, DOC_ID, CHUNK_INDEX, TITLE, HEADING_PATH, START_LINE, END_LINE, CONTENT, CONTENT_HASH, METADATA_JSON, EMBEDDING) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) MATCHING (CHUNK_ID)`;

        const batchRows: QueryParams[] = changed.map(({ chunkId, chunk }, idx) => [
          chunkId,
          doc.docId,
          chunk.index,
          doc.title ?? null,
          chunk.headingPath.join(' > '),
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.contentHash,
          metaJson,
          encodeVector(embeddings[idx]!),
        ]);

        if (typeof db.execBatch === 'function') {
          await db.execBatch(upsertSql, batchRows);
        } else {
          for (const r of batchRows) await execRagSql(db, upsertSql, r);
        }
      }

      // Delete stale trailing chunks when a document shrank
      let deletedChunks = 0;
      for (const oldId of existingHashes.keys()) {
        if (!activeChunkIds.has(oldId)) {
          await execRagSql(
            db,
            `DELETE FROM ${quoteRagIdent(tableName)} WHERE CHUNK_ID = ?`,
            [oldId],
          );
          deletedChunks += 1;
        }
      }

      if (changed.length > 0 || deletedChunks > 0) {
        await syncSearchIndexes();
      }

      return {
        docId: doc.docId,
        totalChunks: chunks.length,
        embeddedChunks: changed.length,
        skippedChunks,
        deletedChunks,
      };
    },

    async ingestMany(docs: readonly RagDocumentInput[]) {
      let totalChunks = 0;
      let embeddedChunks = 0;
      let skippedChunks = 0;
      let deletedChunks = 0;
      for (const d of docs) {
        const res = await this.ingestDocument(d);
        totalChunks += res.totalChunks;
        embeddedChunks += res.embeddedChunks;
        skippedChunks += res.skippedChunks;
        deletedChunks += res.deletedChunks;
      }
      return {
        documentsProcessed: docs.length,
        totalChunks,
        embeddedChunks,
        skippedChunks,
        deletedChunks,
      };
    },

    async deleteDocument(docId: string): Promise<number> {
      await ensureTable();
      const cntRes = await db.query<{ CNT: number }>(
        `SELECT COUNT(*) AS CNT FROM ${quoteRagIdent(tableName)} WHERE DOC_ID = ?`,
        [docId],
      );
      const count = Number(cntRes.rows[0]?.CNT ?? 0);
      if (count > 0) {
        await execRagSql(
          db,
          `DELETE FROM ${quoteRagIdent(tableName)} WHERE DOC_ID = ?`,
          [docId],
        );
        await syncSearchIndexes();
      }
      return count;
    },

    async askContext(queryText, askOpts = {}) {
      await ensureTable();
      const tokenBudget = askOpts.tokenBudget ?? 512;
      const limit = askOpts.limit ?? 8;

      const qVecs = await options.embed([queryText]);
      const qVec = decodeVector(qVecs[0]!);

      if (semCache && !askOpts.where) {
        const cached = await semCache.get<PackedRagContext<Record<string, unknown>>>(qVec);
        if (cached) {
          return { ...cached.response, fromCache: true };
        }
      }

      if (!vecIndex || !ftsIndex) {
        await syncSearchIndexes();
      }

      const hits = await hybridSearch(db, {
        table: tableName,
        keyColumn: 'CHUNK_ID',
        ftsColumns: ['TITLE', 'HEADING_PATH', 'CONTENT'],
        vectorColumn: 'EMBEDDING',
        textQuery: queryText,
        vectorQuery: qVec,
        ftsIndex: ftsIndex ?? undefined,
        vectorIndex: vecIndex ?? undefined,
        where: askOpts.where,
        params: askOpts.params,
        limit,
        diversityLambda: askOpts.diversityLambda ?? 0.65,
      });

      const packed = packRagContext(hits as Array<Record<string, unknown>>, {
        tokenBudget,
        keyColumn: 'CHUNK_ID',
        textColumn: 'CONTENT',
        titleColumn: 'TITLE',
        dedupeOverlap: askOpts.dedupeOverlap ?? 0.85,
      });

      if (semCache && !askOpts.where) {
        await semCache.set({
          prompt: queryText,
          embedding: qVec,
          response: packed,
        });
      }

      return { ...packed, fromCache: false };
    },

    async close(): Promise<void> {
      vecIndex?.dispose?.();
      ftsIndex?.dispose?.();
      vecIndex = null;
      ftsIndex = null;
      if (ownedCache) {
        await ownedCache.close();
      }
    },
  };
}
