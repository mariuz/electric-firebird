import {
  encodeVector,
  decodeVector,
  formatVectorText,
  vectorColumnType,
  vectorNorm,
  normalizeVector,
  dotProduct,
  innerProductDistance,
  squaredL2Distance,
  l2Distance,
  cosineSimilarity,
  cosineDistance,
  registerVectorFunctions,
  vectorSearch,
  HnswIndex,
  createVectorIndex,
} from '../vector';
import type { RegisterFunctionOptions, JsFunctionHandler, RegisteredRoutine } from '../types';

describe('firebird-wasm/vector – Client-Side Vector Similarity & Hybrid Search', () => {
  describe('Encoding, Decoding & Column Helpers', () => {
    it('encodes and decodes Float32Array, number[], Uint8Array, base64, hex, and bracketed text', () => {
      const original = [1.0, -0.5, 0.25, 4.0];
      const packed = encodeVector(original);
      expect(packed).toBeInstanceOf(Uint8Array);
      expect(packed.byteLength).toBe(16);

      const fromBytes = decodeVector(packed);
      expect(Array.from(fromBytes)).toEqual(original);

      const fromArrayBuffer = decodeVector(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength));
      expect(Array.from(fromArrayBuffer)).toEqual(original);

      const fromBase64 = decodeVector(Buffer.from(packed).toString('base64'));
      expect(Array.from(fromBase64)).toEqual(original);

      const hexStr = Buffer.from(packed).toString('hex');
      expect(Array.from(decodeVector(`x'${hexStr}'`))).toEqual(original);
      expect(Array.from(decodeVector(`0x${hexStr}`))).toEqual(original);

      const textLiteral = formatVectorText(original);
      expect(textLiteral).toBe('[1,-0.5,0.25,4]');
      expect(Array.from(decodeVector(textLiteral))).toEqual(original);

      // Base64-wrapped ASCII text literals (how ENGINE JS serializes string literals passed to VARBINARY parameters)
      const base64Text3 = Buffer.from('[1,0,0]', 'utf8').toString('base64');
      expect(Array.from(decodeVector(base64Text3))).toEqual([1, 0, 0]);
      const base64Text4 = Buffer.from('[1, 0, 0, 0]', 'utf8').toString('base64');
      expect(Array.from(decodeVector(base64Text4))).toEqual([1, 0, 0, 0]);
      const base64Hex = Buffer.from(`x'${hexStr}'`, 'utf8').toString('base64');
      expect(Array.from(decodeVector(base64Hex))).toEqual(original);
    });

    it('validates vector dimensions and rejects malformed inputs', () => {
      expect(vectorColumnType(384)).toBe('VARBINARY(1536)');
      expect(vectorColumnType(384, { fixed: true })).toBe('BINARY(1536)');
      expect(vectorColumnType(10000)).toBe('BLOB SUB_TYPE BINARY');
      expect(() => vectorColumnType(0)).toThrow(/positive integer/);

      expect(() => decodeVector([])).toThrow(/cannot be empty/);
      expect(() => decodeVector(new Uint8Array(3))).toThrow(/multiple of 4/);
      expect(() => decodeVector('[1, 2, bad]')).toThrow(/Invalid number/);
      expect(() => decodeVector(null)).toThrow(/Unsupported/);
    });
  });

  describe('Distance & Similarity Metrics', () => {
    it('computes cosineDistance, cosineSimilarity, l2Distance, squaredL2Distance, dotProduct, and innerProductDistance', () => {
      const a = [1, 0, 0, 0, 0];
      const b = [1, 0, 0, 0, 0];
      const ortho = [0, 1, 0, 0, 0];
      const opposite = [-1, 0, 0, 0, 0];

      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
      expect(cosineDistance(a, b)).toBe(0);

      expect(cosineSimilarity(a, ortho)).toBeCloseTo(0, 6);
      expect(cosineDistance(a, ortho)).toBeCloseTo(1, 6);

      expect(cosineSimilarity(a, opposite)).toBeCloseTo(-1, 6);
      expect(cosineDistance(a, opposite)).toBeCloseTo(2, 6);

      // Zero vector edge case
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(cosineDistance([0, 0, 0], [1, 2, 3])).toBe(1);

      // 3-4-5 triangle for L2 distance
      expect(squaredL2Distance([0, 0], [3, 4])).toBe(25);
      expect(l2Distance([0, 0], [3, 4])).toBe(5);

      // Dot product & innerProductDistance (with >4 dims to exercise 4-way loop unrolling + tail)
      const v1 = [1, 2, 3, 4, 5, 6];
      const v2 = [2, 1, 0, -1, 2, 3];
      // 2 + 2 + 0 - 4 + 10 + 18 = 28
      expect(dotProduct(v1, v2)).toBe(28);
      expect(innerProductDistance(v1, v2)).toBe(-28);

      // Normalization
      expect(vectorNorm([3, 4])).toBe(5);
      const unit = normalizeVector([3, 4]);
      expect(unit[0]).toBeCloseTo(0.6, 6);
      expect(unit[1]).toBeCloseTo(0.8, 6);
      expect(vectorNorm(unit)).toBeCloseTo(1, 6);

      // Dimension mismatch throws RangeError
      expect(() => cosineDistance([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
    });
  });

  describe('SQL UDR Registration (registerVectorFunctions) & Hybrid Search (vectorSearch)', () => {
    it('registers all 7 SQL vector functions via db.registerFunction', async () => {
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

      const routines = await registerVectorFunctions(mockDb);
      expect(routines).toHaveLength(7);
      expect(Array.from(registered.keys())).toEqual([
        'COSINE_DISTANCE',
        'COSINE_SIMILARITY',
        'L2_DISTANCE',
        'DOT_PRODUCT',
        'VECTOR_DIMS',
        'VECTOR_NORM',
        'VECTOR_TO_TEXT',
      ]);

      const cosDistFn = registered.get('COSINE_DISTANCE')!.fn;
      expect(cosDistFn('[1, 0, 0]', '[0, 1, 0]')).toBeCloseTo(1, 6);
      expect(cosDistFn(null, '[0, 1, 0]')).toBeNull();

      const dimsFn = registered.get('VECTOR_DIMS')!.fn;
      expect(dimsFn(Buffer.from(encodeVector([0.1, 0.2, 0.3])).toString('base64'))).toBe(3);

      const toTextFn = registered.get('VECTOR_TO_TEXT')!.fn;
      expect(toTextFn(Buffer.from(encodeVector([1, 2, 3])).toString('base64'))).toBe('[1,2,3]');
    });

    it('performs hybrid SQL WHERE filtering and KNN ranking in vectorSearch()', async () => {
      const docs = [
        {
          ID: 1,
          TITLE: 'Firebird SQL Reference',
          CATEGORY: 'db',
          EMBEDDING: Buffer.from(encodeVector([1, 0, 0])).toString('base64'),
        },
        {
          ID: 2,
          TITLE: 'WebAssembly Memory Model',
          CATEGORY: 'wasm',
          EMBEDDING: Buffer.from(encodeVector([0.8, 0.6, 0])).toString('base64'),
        },
        {
          ID: 3,
          TITLE: 'Unrelated Gardening Guide',
          CATEGORY: 'hobby',
          EMBEDDING: Buffer.from(encodeVector([0, 0, 1])).toString('base64'),
        },
      ];

      const executedQueries: Array<{ sql: string; params: unknown[] }> = [];
      const mockDb = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          executedQueries.push({ sql, params });
          const rows =
            params.length > 0
              ? docs.filter((d) => d.CATEGORY !== params[0])
              : docs;
          return { rows: rows as never[], fields: [] };
        }),
      };

      const results = await vectorSearch<{ ID: number; TITLE: string; CATEGORY: string }>(mockDb, {
        table: 'documents',
        column: 'embedding',
        query: [1, 0, 0],
        metric: 'cosine',
        where: 'category <> ?',
        params: ['hobby'],
        maxDistance: 0.5,
        limit: 2,
      });

      expect(executedQueries[0]).toEqual({
        sql: 'SELECT * FROM "DOCUMENTS" WHERE (category <> ?) AND "EMBEDDING" IS NOT NULL',
        params: ['hobby'],
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.ID).toBe(1);
      expect(results[0]!.DISTANCE).toBe(0);
      expect(results[0]!.SIMILARITY).toBe(1);
      expect('EMBEDDING' in results[0]!).toBe(false);

      expect(results[1]!.ID).toBe(2);
      expect(results[1]!.DISTANCE).toBeCloseTo(0.2, 5);
      expect(results[1]!.SIMILARITY).toBeCloseTo(0.8, 5);
    });
  });

  describe('HNSW Approximate Nearest Neighbor Index (HnswIndex & createVectorIndex)', () => {
    it('builds a multi-layer HNSW graph, searches with high recall, supports removal, and round-trips serialize/deserialize', () => {
      const index = new HnswIndex<number>({
        dimensions: 4,
        metric: 'cosine',
        M: 8,
        efConstruction: 32,
        efSearch: 32,
        seed: 42,
      });

      // Add 120 vectors around the unit circle in 4D
      for (let i = 0; i < 120; i++) {
        const angle = (i / 120) * Math.PI * 2;
        index.add(i, [
          Math.cos(angle),
          Math.sin(angle),
          Math.cos(angle * 2) * 0.2,
          Math.sin(angle * 2) * 0.2,
        ]);
      }

      expect(index.size).toBe(120);
      expect(index.dimensions).toBe(4);
      expect(index.has(0)).toBe(true);

      // Query near angle = 0 (vector id 0)
      const hits = index.search([1, 0, 0.2, 0], { k: 5 });
      expect(hits).toHaveLength(5);
      expect(hits[0]!.id).toBe(0);
      expect(hits[0]!.distance).toBeCloseTo(0, 6);

      // Remove vector 0 and verify next closest neighbor becomes top hit
      expect(index.remove(0)).toBe(true);
      expect(index.has(0)).toBe(false);
      expect(index.size).toBe(119);

      const afterRemove = index.search([1, 0, 0.2, 0], { k: 3 });
      expect(afterRemove[0]!.id).not.toBe(0);
      expect([1, 119]).toContain(afterRemove[0]!.id);

      // Serialize and deserialize
      const bytes = index.serialize();
      const restored = HnswIndex.deserialize<number>(bytes);
      expect(restored.size).toBe(119);
      const restoredHits = restored.search([1, 0, 0.2, 0], { k: 3 });
      expect(restoredHits.map((h) => h.id)).toEqual(afterRemove.map((h) => h.id));
    });

    it('creates a persistent database-backed HNSW index (createVectorIndex) and accelerates vectorSearch()', async () => {
      const tableRows = new Map<number, { ID: number; TITLE: string; TAG: string; EMBEDDING: string }>([
        [1, { ID: 1, TITLE: 'Alpha', TAG: 'a', EMBEDDING: Buffer.from(encodeVector([1, 0, 0])).toString('base64') }],
        [2, { ID: 2, TITLE: 'Beta', TAG: 'b', EMBEDDING: Buffer.from(encodeVector([0.9, 0.43589, 0])).toString('base64') }],
        [3, { ID: 3, TITLE: 'Gamma', TAG: 'a', EMBEDDING: Buffer.from(encodeVector([0, 1, 0])).toString('base64') }],
        [4, { ID: 4, TITLE: 'Delta', TAG: 'b', EMBEDDING: Buffer.from(encodeVector([0, 0, 1])).toString('base64') }],
      ]);

      const catalogStore = new Map<string, string>();

      const mockDb = {
        exec: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('UPDATE OR INSERT INTO "FB_VECTOR_INDEX$"')) {
            catalogStore.set(String(params[0]), String(params[5]));
          } else if (sql.includes('DELETE FROM "FB_VECTOR_INDEX$"')) {
            catalogStore.delete(String(params[0]));
          }
        }),
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('RDB$RELATIONS')) {
            return { rows: [{ CNT: catalogStore.size > 0 ? 1 : 0 }] as never[], fields: [] };
          }
          if (sql.includes('SELECT GRAPH_JSON FROM "FB_VECTOR_INDEX$"')) {
            const json = catalogStore.get(String(params[0]));
            return { rows: (json ? [{ GRAPH_JSON: json }] : []) as never[], fields: [] };
          }
          if (sql.includes('SELECT "ID", "EMBEDDING" FROM "DOCS"')) {
            return { rows: Array.from(tableRows.values()) as never[], fields: [] };
          }
          if (sql.includes('SELECT "ID" FROM "DOCS" WHERE (TAG = ?)')) {
            const matching = Array.from(tableRows.values()).filter((r) => r.TAG === params[0]);
            return { rows: matching.map((r) => ({ ID: r.ID })) as never[], fields: [] };
          }
          if (sql.includes('WHERE "ID" IN')) {
            const ids = new Set(params.map(Number));
            const matching = Array.from(tableRows.values()).filter((r) => ids.has(r.ID));
            return { rows: matching as never[], fields: [] };
          }
          return { rows: [], fields: [] };
        }),
      };

      const vIndex = await createVectorIndex<number>(mockDb, {
        table: 'docs',
        column: 'embedding',
        keyColumn: 'id',
        metric: 'cosine',
        persist: true,
        seed: 7,
      });

      expect(vIndex.size).toBe(4);
      expect(catalogStore.has('IDX_DOCS_EMBEDDING_HNSW')).toBe(true);

      // Search through vectorSearch({ ..., index: vIndex })
      const hits = await vectorSearch<{ ID: number; TITLE: string; TAG: string }>(mockDb, {
        table: 'docs',
        column: 'embedding',
        query: [1, 0, 0],
        limit: 2,
        index: vIndex,
      });

      expect(hits).toHaveLength(2);
      expect(hits[0]!.ID).toBe(1);
      expect(hits[0]!.TITLE).toBe('Alpha');
      expect(hits[1]!.ID).toBe(2);

      // Filtered search via index
      const filtered = await vIndex.search<{ ID: number; TITLE: string; TAG: string }>([1, 0, 0], {
        where: 'TAG = ?',
        params: ['b'],
        limit: 2,
      });
      expect(filtered.map((r) => r.ID)).toEqual([2, 4]);

      // Upsert a new row and reload from persisted catalog
      tableRows.set(5, {
        ID: 5,
        TITLE: 'Epsilon',
        TAG: 'a',
        EMBEDDING: Buffer.from(encodeVector([0.99, 0.141, 0])).toString('base64'),
      });
      await vIndex.upsert(5, [0.99, 0.141, 0]);
      expect(vIndex.size).toBe(5);

      const reloaded = await createVectorIndex<number>(mockDb, {
        table: 'docs',
        column: 'embedding',
        keyColumn: 'id',
        persist: true,
      });
      expect(reloaded.size).toBe(5);
      const topAfterReload = await reloaded.search([1, 0, 0], { limit: 2 });
      expect(topAfterReload.map((r) => r.ID)).toEqual([1, 5]);
    });
  });
});
