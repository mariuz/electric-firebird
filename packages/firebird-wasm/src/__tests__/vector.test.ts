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
        query: jest.fn(async () => ({ rows: [], fields: [] })),
        registerFunction: jest.fn(
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
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
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
});
