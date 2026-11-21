/**
 * Hierarchical Navigable Small World (HNSW) Approximate Nearest Neighbor (ANN)
 * index for `firebird-wasm/vector`, with optional persistence into Firebird
 * system-managed storage (`FB_VECTOR_INDEX$`).
 */

import {
  cosineDistance,
  decodeVector,
  dotProduct,
  encodeVector,
  l2Distance,
  type VectorDistanceMetric,
  type VectorInput,
} from './index';
import {
  hammingDistance,
  int8ApproximateDistance,
  quantizeVectorBinary,
  quantizeVectorInt8,
  type QuantizedInt8Vector,
  type VectorQuantizationMode,
} from './quantization';
export * from './persistent-index';

/**
 * Configuration options for an in-memory or persistent {@link HnswIndex}.
 */
export interface HnswIndexOptions {
  /**
   * Vector dimensionality. If omitted, inferred automatically from the first
   * inserted vector.
   */
  dimensions?: number;
  /**
   * Distance metric used for graph construction and search.
   * Defaults to `'cosine'`.
   */
  metric?: VectorDistanceMetric;
  /**
   * Maximum number of bidirectional links per node on layers `>= 1`
   * (layer `0` uses `2 * M`). Defaults to `16`.
   */
  M?: number;
  /**
   * Dynamic candidate list size during index construction. Higher values
   * improve recall at the cost of slower inserts. Defaults to `64`.
   */
  efConstruction?: number;
  /**
   * Default dynamic candidate list size during `search()`. Can also be
   * overridden per query. Defaults to `50`.
   */
  efSearch?: number;
  /**
   * Optional deterministic PRNG seed for reproducible level sampling.
   */
  seed?: number;
  /**
   * Optional vector quantization mode (`'none'`, `'int8'`, or `'binary'`) for
   * fast quantized beam traversal followed by exact `float32` top-$k$ rescoring (`M25 Item 3`).
   * @default 'none'
   */
  quantization?: VectorQuantizationMode;
  /**
   * Candidate oversampling multiplier before exact `float32` rescoring when
   * `quantization` is `'int8'` or `'binary'` (`M25 Item 3`). @default 3
   */
  rescoreOversample?: number;
}

/**
 * Options for {@link HnswIndex.search}.
 */
export interface HnswSearchOptions<ID = string | number> {
  /** Number of nearest neighbors to return (default: `10`). */
  k?: number;
  /** Candidate list size for greedy beam search (default: `index.efSearch`). */
  efSearch?: number;
  /** Optional predicate to filter candidate IDs during graph traversal. */
  filter?: (id: ID) => boolean;
  /** Optional maximum distance cutoff. */
  maxDistance?: number;
  /** Optional minimum similarity cutoff. */
  minSimilarity?: number;
  /** Candidate oversampling factor when quantized search + exact rescoring is active (`M25 Item 3`). */
  rescoreOversample?: number;
}

/**
 * A single nearest-neighbor match returned by {@link HnswIndex.search}.
 */
export interface HnswSearchResult<ID = string | number> {
  id: ID;
  distance: number;
  similarity: number;
}

/**
 * JSON-serializable snapshot of an {@link HnswIndex}.
 */
export interface SerializedHnswGraph<ID = string | number> {
  version: 1;
  metric: VectorDistanceMetric;
  dimensions: number | null;
  M: number;
  efConstruction: number;
  efSearch: number;
  entryPointId: ID | null;
  maxLevel: number;
  quantization?: VectorQuantizationMode;
  nodes: Array<{
    id: ID;
    level: number;
    /** Base64-encoded packed little-endian Float32Array bytes. */
    vectorBase64: string;
    /** Adjacency lists per layer (`0 .. level`). */
    connections: ID[][];
  }>;
}

interface InternalHnswNode<ID> {
  id: ID;
  vector: Float32Array;
  qInt8?: QuantizedInt8Vector;
  qBin?: Uint8Array;
  level: number;
  /** `connections[layer]` holds neighbor internal indices. */
  connections: number[][];
  deleted: boolean;
}

interface Candidate {
  nodeIdx: number;
  distance: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function createPrng(seed?: number): () => number {
  let state = (seed !== undefined ? seed >>> 0 : 0x9e3779b9) || 0x9e3779b9;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function computeDistanceAndSimilarity(
  metric: VectorDistanceMetric,
  a: Float32Array,
  b: Float32Array,
): { distance: number; similarity: number } {
  if (metric === 'cosine') {
    const distance = cosineDistance(a, b);
    return { distance, similarity: 1 - distance };
  }
  if (metric === 'l2') {
    const distance = l2Distance(a, b);
    return { distance, similarity: 1 / (1 + distance) };
  }
  const dot = dotProduct(a, b);
  const distance = Object.is(-dot, -0) ? 0 : -dot;
  return { distance, similarity: dot };
}

/**
 * In-memory Hierarchical Navigable Small World (HNSW) graph index for fast
 * Approximate Nearest Neighbor (ANN) vector search.
 */
export class HnswIndex<ID = string | number> {
  readonly metric: VectorDistanceMetric;
  readonly M: number;
  readonly maxM0: number;
  readonly efConstruction: number;
  readonly efSearch: number;
  readonly quantization: VectorQuantizationMode;
  readonly rescoreOversample: number;
  private readonly levelMult: number;
  private readonly rng: () => number;

  private _dimensions: number | null;
  private _nodes: Array<InternalHnswNode<ID>> = [];
  private _idToIdx = new Map<ID, number>();
  private _entryPointIdx: number = -1;
  private _maxLevel: number = -1;
  private _activeCount: number = 0;

  constructor(options: HnswIndexOptions = {}) {
    const M = options.M ?? 16;
    if (!Number.isInteger(M) || M < 2) {
      throw new RangeError(`HNSW M must be an integer >= 2 (got ${String(M)})`);
    }
    const efConstruction = options.efConstruction ?? 64;
    if (!Number.isInteger(efConstruction) || efConstruction < 1) {
      throw new RangeError(
        `HNSW efConstruction must be a positive integer (got ${String(efConstruction)})`,
      );
    }
    const efSearch = options.efSearch ?? 50;
    if (!Number.isInteger(efSearch) || efSearch < 1) {
      throw new RangeError(
        `HNSW efSearch must be a positive integer (got ${String(efSearch)})`,
      );
    }
    if (
      options.dimensions !== undefined &&
      (!Number.isInteger(options.dimensions) || options.dimensions < 1)
    ) {
      throw new RangeError(
        `HNSW dimensions must be a positive integer (got ${String(options.dimensions)})`,
      );
    }

    this.metric = options.metric ?? 'cosine';
    this.M = M;
    this.maxM0 = M * 2;
    this.efConstruction = Math.max(efConstruction, M);
    this.efSearch = efSearch;
    this.quantization = options.quantization ?? 'none';
    this.rescoreOversample = Math.max(1, Math.floor(options.rescoreOversample ?? 3));
    this.levelMult = 1 / Math.log(M);
    this.rng = createPrng(options.seed);
    this._dimensions = options.dimensions ?? null;
  }

  /** Number of active (non-deleted) vectors in the index. */
  get size(): number {
    return this._activeCount;
  }

  /** Vector dimensionality, or `null` if empty and not pre-configured. */
  get dimensions(): number | null {
    return this._dimensions;
  }

  /** Quantized vector representation byte footprint across active nodes (`M25 Item 3`). */
  get quantizedVectorBytes(): number {
    const dims = this._dimensions ?? 0;
    if (dims === 0 || this._activeCount === 0) return 0;
    if (this.quantization === 'int8') {
      return this._activeCount * (dims + 12);
    }
    if (this.quantization === 'binary') {
      return this._activeCount * Math.ceil(dims / 8);
    }
    return this._activeCount * dims * 4;
  }

  /** Highest layer currently present in the HNSW graph (`-1` when empty). */
  get maxLevel(): number {
    return this._maxLevel;
  }

  /** Return `true` if `id` is present in the index. */
  has(id: ID): boolean {
    const idx = this._idToIdx.get(id);
    return idx !== undefined && !this._nodes[idx]!.deleted;
  }

  /** Return the stored `Float32Array` vector for `id`, or `undefined` if not found. */
  get(id: ID): Float32Array | undefined {
    const idx = this._idToIdx.get(id);
    if (idx === undefined) return undefined;
    const node = this._nodes[idx]!;
    return node.deleted ? undefined : node.vector;
  }

  private sampleLevel(): number {
    const r = Math.max(1e-12, this.rng());
    return Math.floor(-Math.log(r) * this.levelMult);
  }

  private dist(a: Float32Array, b: Float32Array): number {
    return computeDistanceAndSimilarity(this.metric, a, b).distance;
  }

  /**
   * Insert or update a single vector by `id`.
   */
  add(id: ID, vectorInput: VectorInput): void {
    const raw = decodeVector(vectorInput);
    const vec = new Float32Array(raw);
    if (this._dimensions === null) {
      this._dimensions = vec.length;
    } else if (vec.length !== this._dimensions) {
      throw new RangeError(
        `Vector dimension mismatch: index expects ${this._dimensions}, got ${vec.length}`,
      );
    }

    if (this.has(id)) {
      this.remove(id);
    }

    const level = this.sampleLevel();
    const nodeIdx = this._nodes.length;
    const connections: number[][] = Array.from({ length: level + 1 }, () => []);
    const newNode: InternalHnswNode<ID> = {
      id,
      vector: vec,
      qInt8: this.quantization === 'int8' ? quantizeVectorInt8(vec) : undefined,
      qBin: this.quantization === 'binary' ? quantizeVectorBinary(vec) : undefined,
      level,
      connections,
      deleted: false,
    };
    this._nodes.push(newNode);
    this._idToIdx.set(id, nodeIdx);
    this._activeCount++;

    if (this._entryPointIdx === -1) {
      this._entryPointIdx = nodeIdx;
      this._maxLevel = level;
      return;
    }

    let currObj = this._entryPointIdx;
    let currDist = this.dist(vec, this._nodes[currObj]!.vector);

    // 1. Zoom down from maxLevel down to level + 1 using greedy 1-NN search
    for (let lc = this._maxLevel; lc > level; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const neighbors = this._nodes[currObj]!.connections[lc];
        if (!neighbors) break;
        for (let i = 0; i < neighbors.length; i++) {
          const nbIdx = neighbors[i]!;
          const nbNode = this._nodes[nbIdx]!;
          const d = this.dist(vec, nbNode.vector);
          if (d < currDist) {
            currDist = d;
            currObj = nbIdx;
            changed = true;
          }
        }
      }
    }

    // 2. From min(level, maxLevel) down to 0, search layer with efConstruction and connect
    const topConnectLevel = Math.min(level, this._maxLevel);
    let epCandidates: Candidate[] = [{ nodeIdx: currObj, distance: currDist }];

    for (let lc = topConnectLevel; lc >= 0; lc--) {
      const candidates = this.searchLayer(vec, epCandidates, this.efConstruction, lc);
      const maxM = lc === 0 ? this.maxM0 : this.M;
      const selected = this.selectNeighborsHeuristic(vec, candidates, maxM);

      newNode.connections[lc] = selected.map((c) => c.nodeIdx);

      // Add bidirectional connections and prune if a neighbor exceeds maxM
      for (const sel of selected) {
        const nbNode = this._nodes[sel.nodeIdx]!;
        let nbConns = nbNode.connections[lc];
        if (!nbConns) {
          nbConns = [];
          nbNode.connections[lc] = nbConns;
        }
        if (!nbConns.includes(nodeIdx)) {
          nbConns.push(nodeIdx);
        }
        if (nbConns.length > maxM) {
          const nbCandidates: Candidate[] = nbConns.map((nIdx) => ({
            nodeIdx: nIdx,
            distance: this.dist(nbNode.vector, this._nodes[nIdx]!.vector),
          }));
          const pruned = this.selectNeighborsHeuristic(nbNode.vector, nbCandidates, maxM);
          nbNode.connections[lc] = pruned.map((c) => c.nodeIdx);
        }
      }

      epCandidates = candidates;
    }

    if (level > this._maxLevel) {
      this._entryPointIdx = nodeIdx;
      this._maxLevel = level;
    }
  }

  /**
   * Insert or update multiple vectors in batch.
   */
  addMany(items: ReadonlyArray<{ id: ID; vector: VectorInput }>): void {
    for (const item of items) {
      this.add(item.id, item.vector);
    }
  }

  /**
   * Remove a vector by `id` and repair its neighborhood links.
   * Returns `true` if the vector existed and was removed.
   */
  remove(id: ID): boolean {
    const targetIdx = this._idToIdx.get(id);
    if (targetIdx === undefined) return false;
    const targetNode = this._nodes[targetIdx]!;
    if (targetNode.deleted) return false;

    targetNode.deleted = true;
    this._idToIdx.delete(id);
    this._activeCount--;

    // Repair each layer where targetNode participated
    for (let lc = 0; lc <= targetNode.level; lc++) {
      const neighbors = targetNode.connections[lc] ?? [];
      const maxM = lc === 0 ? this.maxM0 : this.M;

      for (const nbIdx of neighbors) {
        const nbNode = this._nodes[nbIdx]!;
        const nbConns = nbNode.connections[lc];
        if (!nbConns) continue;
        // Remove targetIdx from neighbor's list
        const filtered = nbConns.filter((idx) => idx !== targetIdx);
        // Offer other neighbors of targetNode as replacement candidates
        for (const otherIdx of neighbors) {
          if (
            otherIdx !== nbIdx &&
            !this._nodes[otherIdx]!.deleted &&
            !filtered.includes(otherIdx)
          ) {
            filtered.push(otherIdx);
          }
        }
        if (filtered.length > maxM) {
          const cand: Candidate[] = filtered.map((idx) => ({
            nodeIdx: idx,
            distance: this.dist(nbNode.vector, this._nodes[idx]!.vector),
          }));
          nbNode.connections[lc] = this.selectNeighborsHeuristic(
            nbNode.vector,
            cand,
            maxM,
          ).map((c) => c.nodeIdx);
        } else {
          nbNode.connections[lc] = filtered;
        }
      }
      targetNode.connections[lc] = [];
    }

    // Update entry point if we removed the current entry point
    if (this._entryPointIdx === targetIdx) {
      let nextEp = -1;
      let nextMaxLevel = -1;
      for (let i = 0; i < this._nodes.length; i++) {
        const n = this._nodes[i]!;
        if (!n.deleted && n.level > nextMaxLevel) {
          nextMaxLevel = n.level;
          nextEp = i;
        }
      }
      this._entryPointIdx = nextEp;
      this._maxLevel = nextMaxLevel;
    }

    return true;
  }

  /**
   * Perform HNSW diversity-aware heuristic neighbor selection (Algorithm 4 from
   * Malkov & Yashunin 2018) so graph connections span multiple directions.
   */
  private selectNeighborsHeuristic(
    baseVec: Float32Array,
    candidates: Candidate[],
    M: number,
  ): Candidate[] {
    if (candidates.length <= M) {
      return [...candidates].sort((a, b) => a.distance - b.distance);
    }
    const sorted = [...candidates].sort((a, b) => a.distance - b.distance);
    const result: Candidate[] = [];
    const discarded: Candidate[] = [];

    for (const e of sorted) {
      if (result.length >= M) break;
      const eVec = this._nodes[e.nodeIdx]!.vector;
      let closerToResult = false;
      for (const r of result) {
        const dER = this.dist(eVec, this._nodes[r.nodeIdx]!.vector);
        if (dER < e.distance) {
          closerToResult = true;
          break;
        }
      }
      if (!closerToResult) {
        result.push(e);
      } else {
        discarded.push(e);
      }
    }

    for (const d of discarded) {
      if (result.length >= M) break;
      result.push(d);
    }

    return result;
  }

  /**
   * Greedy beam search within a single layer `lc`.
   */
  private searchLayer(
    queryVec: Float32Array,
    entryPoints: Candidate[],
    ef: number,
    lc: number,
    customDistFn?: (node: InternalHnswNode<ID>) => number,
  ): Candidate[] {
    const visited = new Set<number>();
    const candidates: Candidate[] = [];
    const results: Candidate[] = [];

    for (const ep of entryPoints) {
      visited.add(ep.nodeIdx);
      candidates.push(ep);
      results.push(ep);
    }

    candidates.sort((a, b) => a.distance - b.distance);
    results.sort((a, b) => a.distance - b.distance);

    while (candidates.length > 0) {
      const closest = candidates.shift()!;
      const furthestResult = results[results.length - 1]!;
      if (closest.distance > furthestResult.distance && results.length >= ef) {
        break;
      }

      const node = this._nodes[closest.nodeIdx]!;
      const neighbors = node.connections[lc];
      if (!neighbors) continue;

      for (let i = 0; i < neighbors.length; i++) {
        const nbIdx = neighbors[i]!;
        if (visited.has(nbIdx)) continue;
        visited.add(nbIdx);

        const nbNode = this._nodes[nbIdx]!;
        const d = customDistFn ? customDistFn(nbNode) : this.dist(queryVec, nbNode.vector);
        const currentFurthest = results[results.length - 1]!;

        if (results.length < ef || d < currentFurthest.distance) {
          const item: Candidate = { nodeIdx: nbIdx, distance: d };
          // Binary insert into candidates and results
          insertSortedCandidate(candidates, item);
          insertSortedCandidate(results, item);
          if (results.length > ef) {
            results.pop();
          }
        }
      }
    }

    return results;
  }

  /**
   * Query the HNSW graph for the top `k` approximate nearest neighbors of `queryInput`.
   */
  search(
    queryInput: VectorInput,
    options: HnswSearchOptions<ID> = {},
  ): Array<HnswSearchResult<ID>> {
    if (this._activeCount === 0 || this._entryPointIdx === -1) {
      return [];
    }
    const queryVec = decodeVector(queryInput);
    if (this._dimensions !== null && queryVec.length !== this._dimensions) {
      throw new RangeError(
        `Query vector dimension mismatch: index has ${this._dimensions}, got ${queryVec.length}`,
      );
    }

    const k = options.k ?? 10;
    if (!Number.isInteger(k) || k < 1) {
      throw new RangeError(`HNSW search k must be a positive integer (got ${String(k)})`);
    }
    const oversample =
      this.quantization !== 'none'
        ? Math.max(1, Math.floor(options.rescoreOversample ?? this.rescoreOversample))
        : 1;
    const ef = Math.max(options.efSearch ?? this.efSearch, k * oversample);

    const qInt8Query = this.quantization === 'int8' ? quantizeVectorInt8(queryVec) : undefined;
    const qBinQuery = this.quantization === 'binary' ? quantizeVectorBinary(queryVec) : undefined;
    const approxDistFn: ((node: InternalHnswNode<ID>) => number) | undefined =
      qInt8Query
        ? (node) =>
            node.qInt8
              ? int8ApproximateDistance(this.metric, qInt8Query, node.qInt8)
              : this.dist(queryVec, node.vector)
        : qBinQuery
          ? (node) =>
              node.qBin
                ? hammingDistance(qBinQuery, node.qBin)
                : this.dist(queryVec, node.vector)
          : undefined;

    let currObj = this._entryPointIdx;
    let currDist = approxDistFn
      ? approxDistFn(this._nodes[currObj]!)
      : this.dist(queryVec, this._nodes[currObj]!.vector);

    for (let lc = this._maxLevel; lc > 0; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const neighbors = this._nodes[currObj]!.connections[lc];
        if (!neighbors) break;
        for (let i = 0; i < neighbors.length; i++) {
          const nbIdx = neighbors[i]!;
          const nbNode = this._nodes[nbIdx]!;
          const d = approxDistFn ? approxDistFn(nbNode) : this.dist(queryVec, nbNode.vector);
          if (d < currDist) {
            currDist = d;
            currObj = nbIdx;
            changed = true;
          }
        }
      }
    }

    const layer0Candidates = this.searchLayer(
      queryVec,
      [{ nodeIdx: currObj, distance: currDist }],
      ef,
      0,
      approxDistFn,
    );

    const out: Array<HnswSearchResult<ID>> = [];
    for (const cand of layer0Candidates) {
      const node = this._nodes[cand.nodeIdx]!;
      if (node.deleted) continue;
      if (options.filter && !options.filter(node.id)) continue;

      // Exact float32 rescoring on top candidates (`M25 Item 3`)
      const { distance, similarity } = computeDistanceAndSimilarity(
        this.metric,
        queryVec,
        node.vector,
      );
      if (options.maxDistance !== undefined && distance > options.maxDistance) {
        continue;
      }
      if (options.minSimilarity !== undefined && similarity < options.minSimilarity) {
        continue;
      }
      out.push({ id: node.id, distance, similarity });
      if (!approxDistFn && out.length >= k) break;
    }

    if (approxDistFn && out.length > 1) {
      out.sort((a, b) => a.distance - b.distance);
      if (out.length > k) {
        out.length = k;
      }
    }

    // If a selective filter or high deletion ratio left fewer than `k` results
    // from the initial beam, scan remaining active nodes that pass the filter.
    if (options.filter && out.length < k) {
      const seenIds = new Set(out.map((r) => r.id));
      const fallback: Array<HnswSearchResult<ID>> = [];
      for (const node of this._nodes) {
        if (node.deleted || seenIds.has(node.id)) continue;
        if (!options.filter(node.id)) continue;
        const { distance, similarity } = computeDistanceAndSimilarity(
          this.metric,
          queryVec,
          node.vector,
        );
        if (options.maxDistance !== undefined && distance > options.maxDistance) continue;
        if (options.minSimilarity !== undefined && similarity < options.minSimilarity) continue;
        fallback.push({ id: node.id, distance, similarity });
      }
      fallback.sort((a, b) => a.distance - b.distance);
      for (const item of fallback) {
        if (out.length >= k) break;
        out.push(item);
      }
      out.sort((a, b) => a.distance - b.distance);
    }

    return out;
  }

  /**
   * Export the compacted HNSW graph as a JSON-serializable structure.
   */
  toJSON(): SerializedHnswGraph<ID> {
    // Compact deleted nodes out on export
    const oldToNewId = new Map<number, ID>();
    for (let i = 0; i < this._nodes.length; i++) {
      const n = this._nodes[i]!;
      if (!n.deleted) {
        oldToNewId.set(i, n.id);
      }
    }

    const nodes: SerializedHnswGraph<ID>['nodes'] = [];
    for (let i = 0; i < this._nodes.length; i++) {
      const n = this._nodes[i]!;
      if (n.deleted) continue;
      const connections: ID[][] = n.connections.map((layer) =>
        layer
          .filter((nbIdx) => oldToNewId.has(nbIdx))
          .map((nbIdx) => oldToNewId.get(nbIdx)!),
      );
      nodes.push({
        id: n.id,
        level: n.level,
        vectorBase64: bytesToBase64(encodeVector(n.vector)),
        connections,
      });
    }

    const entryPointId =
      this._entryPointIdx >= 0 && oldToNewId.has(this._entryPointIdx)
        ? oldToNewId.get(this._entryPointIdx)!
        : null;

    return {
      version: 1,
      metric: this.metric,
      dimensions: this._dimensions,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      entryPointId,
      maxLevel: entryPointId !== null ? this._maxLevel : -1,
      ...(this.quantization !== 'none' ? { quantization: this.quantization } : {}),
      nodes,
    };
  }

  /**
   * Serialize the HNSW graph to UTF-8 JSON bytes (`Uint8Array`).
   */
  serialize(): Uint8Array {
    const json = JSON.stringify(this.toJSON());
    return new TextEncoder().encode(json);
  }

  /**
   * Reconstruct an {@link HnswIndex} from {@link serialize} or {@link toJSON} output.
   */
  static deserialize<ID = string | number>(
    input: Uint8Array | SerializedHnswGraph<ID> | string,
    options?: { seed?: number; quantization?: VectorQuantizationMode },
  ): HnswIndex<ID> {
    let data: SerializedHnswGraph<ID>;
    if (input instanceof Uint8Array) {
      data = JSON.parse(new TextDecoder().decode(input)) as SerializedHnswGraph<ID>;
    } else if (typeof input === 'string') {
      data = JSON.parse(input) as SerializedHnswGraph<ID>;
    } else {
      data = input;
    }

    if (!data || data.version !== 1) {
      throw new Error(
        `Unsupported HNSW serialized graph version: ${String((data as { version?: unknown })?.version)}`,
      );
    }

    const qMode = options?.quantization ?? data.quantization ?? 'none';
    const index = new HnswIndex<ID>({
      dimensions: data.dimensions ?? undefined,
      metric: data.metric,
      M: data.M,
      efConstruction: data.efConstruction,
      efSearch: data.efSearch,
      seed: options?.seed,
      quantization: qMode,
    });

    const idToIdx = new Map<ID, number>();
    for (let i = 0; i < data.nodes.length; i++) {
      idToIdx.set(data.nodes[i]!.id, i);
    }

    index._nodes = data.nodes.map((n) => {
      const vec = new Float32Array(decodeVector(n.vectorBase64));
      return {
        id: n.id,
        vector: vec,
        qInt8: qMode === 'int8' ? quantizeVectorInt8(vec) : undefined,
        qBin: qMode === 'binary' ? quantizeVectorBinary(vec) : undefined,
        level: n.level,
        connections: n.connections.map((layer) =>
          layer
            .map((nbId) => idToIdx.get(nbId))
            .filter((idx): idx is number => idx !== undefined),
        ),
        deleted: false,
      };
    });
    index._idToIdx = idToIdx;
    index._activeCount = data.nodes.length;
    index._entryPointIdx =
      data.entryPointId !== null ? (idToIdx.get(data.entryPointId) ?? -1) : -1;
    index._maxLevel = index._entryPointIdx >= 0 ? data.maxLevel : -1;

    return index;
  }
}

function insertSortedCandidate(arr: Candidate[], item: Candidate): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.distance <= item.distance) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  arr.splice(lo, 0, item);
}
