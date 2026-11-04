import {
  stemWord,
  tokenizeText,
  highlightSnippet,
  Bm25Index,
  createFtsIndex,
  registerFtsFunctions,
  reciprocalRankFusion,
  hybridSearch,
} from '../fts';
import { encodeVector, createVectorIndex } from '../vector';
import type { RegisterFunctionOptions, JsFunctionHandler, RegisteredRoutine } from '../types';

describe('firebird-wasm/fts – Full-Text Search (BM25), Stemming & Hybrid RRF Search', () => {
  describe('Tokenization, Stemming & Highlighting', () => {
    it('stems English inflections, folds diacritics, and removes stopwords', () => {
      expect(stemWord('running')).toBe('run');
      expect(stemWord('databases')).toBe('databas');
      expect(stemWord('queries')).toBe('queri');
      expect(stemWord('relational')).toBe('relat');

      const tokens = tokenizeText('The running Café databases are querying fast!');
      expect(tokens).toEqual(['run', 'cafe', 'databas', 'queri', 'fast']);

      const unstemmed = tokenizeText('The running Café', {
        stem: false,
        stopwords: false,
      });
      expect(unstemmed).toEqual(['the', 'running', 'cafe']);
    });

    it('highlights matched query terms in snippets', () => {
      const snippet = highlightSnippet(
        'Firebird embedded database runs inside WebAssembly with IndexedDB and OPFS storage.',
        'running databases in WebAssembly',
      );
      expect(snippet).toBe(
        'Firebird embedded <mark>database</mark> <mark>runs</mark> inside <mark>WebAssembly</mark> with IndexedDB and OPFS storage.',
      );
    });
  });

  describe('Bm25Index – In-Memory Inverted Index', () => {
    it('indexes multi-field documents with field weights, ranks by BM25, supports removal, and round-trips serialize/deserialize', () => {
      const idx = new Bm25Index<number>({
        fieldWeights: { TITLE: 3.0, BODY: 1.0 },
      });

      idx.add(1, {
        TITLE: 'Firebird SQL Transactions',
        BODY: 'Multi-generational architecture and snapshot isolation in Firebird.',
      });
      idx.add(2, {
        TITLE: 'WebAssembly Browser Guide',
        BODY: 'Running compiled C++ engines in a Web Worker with Firebird.',
      });
      idx.add(3, {
        TITLE: 'Vector Similarity Search',
        BODY: 'HNSW approximate nearest neighbor graph and cosine distance.',
      });

      expect(idx.size).toBe(3);
      expect(idx.vocabularySize).toBeGreaterThan(10);

      // 'Firebird' appears in doc 1's TITLE (weight 3) + BODY (weight 1), and only in doc 2's BODY (weight 1)
      const hits = idx.search('firebird');
      expect(hits).toHaveLength(2);
      expect(hits[0]!.id).toBe(1);
      expect(hits[1]!.id).toBe(2);
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);

      // AND mode ('all')
      const allHits = idx.search('firebird snapshot', { matchMode: 'all' });
      expect(allHits).toHaveLength(1);
      expect(allHits[0]!.id).toBe(1);

      // Serialization round-trip
      const bytes = idx.serialize();
      const restored = Bm25Index.deserialize<number>(bytes);
      expect(restored.size).toBe(3);
      expect(restored.search('firebird').map((h) => h.id)).toEqual([1, 2]);

      // Removal
      expect(restored.remove(1)).toBe(true);
      expect(restored.size).toBe(2);
      expect(restored.search('firebird').map((h) => h.id)).toEqual([2]);
    });
  });

  describe('SQL UDRs (registerFtsFunctions), Persistent FTS Index & Hybrid RRF Search', () => {
    it('registers FTS_TOKENIZE, FTS_STEM, FTS_BM25, and FTS_HIGHLIGHT SQL functions', async () => {
      const registered = new Map<string, { opts: RegisterFunctionOptions; fn: JsFunctionHandler }>();
      const mockDb = {
        query: vi.fn(async () => ({ rows: [], fields: [] })),
        registerFunction: vi.fn(
          async (name: string, opts: RegisterFunctionOptions, fn: JsFunctionHandler): Promise<RegisteredRoutine> => {
            registered.set(name, { opts, fn });
            return {
              name,
              kind: 'function',
              entryPoint: name,
              engine: 'psql-bridge',
              unregister: async () => {
                registered.delete(name);
              },
              [Symbol.asyncDispose]: async () => {
                registered.delete(name);
              },
            };
          },
        ),
      };

      const routines = await registerFtsFunctions(mockDb);
      expect(routines).toHaveLength(4);
      expect(Array.from(registered.keys())).toEqual([
        'FTS_TOKENIZE',
        'FTS_STEM',
        'FTS_BM25',
        'FTS_HIGHLIGHT',
      ]);

      expect(registered.get('FTS_STEM')!.fn('indexing')).toBe('index');
      expect(JSON.parse(String(registered.get('FTS_TOKENIZE')!.fn('Hello Databases!')))).toEqual([
        'hello',
        'databas',
      ]);
      expect(Number(registered.get('FTS_BM25')!.fn('Firebird database engine', 'firebird'))).toBeGreaterThan(0);
      expect(registered.get('FTS_HIGHLIGHT')!.fn('Firebird database engine', 'database')).toBe(
        'Firebird <mark>database</mark> engine',
      );
    });

    it('creates a persistent FTS index and fuses BM25 + HNSW vector search via Reciprocal Rank Fusion (hybridSearch)', async () => {
      const articles = [
        {
          ID: 1,
          TITLE: 'Firebird Embedded WASM',
          BODY: 'Run the relational database inside the browser with IndexedDB.',
          CATEGORY: 'db',
          EMBEDDING: Buffer.from(encodeVector([1, 0, 0])).toString('base64'),
        },
        {
          ID: 2,
          TITLE: 'Semantic Vector Search & RAG',
          BODY: 'Approximate nearest neighbor HNSW graphs and embeddings.',
          CATEGORY: 'ai',
          EMBEDDING: Buffer.from(encodeVector([0, 1, 0])).toString('base64'),
        },
        {
          ID: 3,
          TITLE: 'Hybrid Search in Firebird',
          BODY: 'Combining full-text BM25 keyword ranking with vector embeddings in the browser.',
          CATEGORY: 'db',
          EMBEDDING: Buffer.from(encodeVector([0.7071, 0.7071, 0])).toString('base64'),
        },
      ];

      const ftsCatalog = new Map<string, string>();

      const mockDb = {
        exec: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('UPDATE OR INSERT INTO "FB_FTS_INDEX$"')) {
            ftsCatalog.set(String(params[0]), String(params[4]));
          }
        }),
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('RDB$RELATIONS')) {
            return { rows: [{ CNT: ftsCatalog.size > 0 ? 1 : 0 }] as never[], fields: [] };
          }
          if (sql.includes('SELECT INDEX_JSON FROM "FB_FTS_INDEX$"')) {
            const json = ftsCatalog.get(String(params[0]));
            return { rows: (json ? [{ INDEX_JSON: json }] : []) as never[], fields: [] };
          }
          if (sql.includes('SELECT "ID", "TITLE", "BODY" FROM "ARTICLES"')) {
            return { rows: articles as never[], fields: [] };
          }
          if (sql.includes('SELECT "ID", "EMBEDDING" FROM "ARTICLES"')) {
            return { rows: articles as never[], fields: [] };
          }
          if (sql.includes('WHERE "ID" IN')) {
            const ids = new Set(params.map(Number));
            return { rows: articles.filter((a) => ids.has(a.ID)) as never[], fields: [] };
          }
          return { rows: articles as never[], fields: [] };
        }),
      };

      const ftsIdx = await createFtsIndex<number>(mockDb, {
        table: 'articles',
        columns: ['title', 'body'],
        fieldWeights: { TITLE: 2.0, BODY: 1.0 },
        persist: true,
      });
      expect(ftsIdx.size).toBe(3);
      expect(ftsCatalog.has('IDX_ARTICLES_FTS')).toBe(true);

      const vecIdx = await createVectorIndex<number>(mockDb, {
        table: 'articles',
        column: 'embedding',
        seed: 11,
      });

      // Hybrid search combining keyword "browser firebird" and vector near [0.7, 0.7, 0]
      // Article 3 ranks high in both BM25 and Vector similarity, so RRF ranks it #1!
      const hybridResults = await hybridSearch<{ ID: number; TITLE: string; BODY: string }>(
        mockDb,
        {
          table: 'articles',
          textQuery: 'hybrid search embeddings',
          ftsIndex: ftsIdx,
          vectorColumn: 'embedding',
          vectorQuery: [0.7071, 0.7071, 0],
          vectorIndex: vecIdx,
          highlightColumn: 'body',
          limit: 3,
        },
      );

      expect(hybridResults).toHaveLength(3);
      expect(hybridResults[0]!.ID).toBe(3);
      expect(hybridResults[0]!.FTS_RANK).toBe(1);
      expect(hybridResults[0]!.VECTOR_RANK).toBe(1);
      expect(hybridResults[0]!.RRF_SCORE).toBeCloseTo(2 / 61, 6);
      expect(hybridResults[0]!.HIGHLIGHT).toContain('<mark>embeddings</mark>');

      // Direct unit check on reciprocalRankFusion
      const rrf = reciprocalRankFusion([
        { items: ['a', 'b', 'c'], weight: 1 },
        { items: ['b', 'c', 'a'], weight: 1 },
      ]);
      expect(rrf[0]!.id).toBe('b');
    });
  });
});
