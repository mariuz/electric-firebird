/**
 * knowledge-graph.ts – Property Graph over Firebird `WITH RECURSIVE` SQL CTEs
 * & Hybrid Vector/BM25 Knowledge-GraphRAG (`createKnowledgeGraph`, `graphRagSearch`)
 * (`M28 Item 2`).
 */

import type { QueryParams, QueryResult, Row } from './types';
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  type VectorInput,
} from './vector';
import { tokenizeText } from './fts';
import {
  mmrRerank,
  packRagContext,
  type PackedRagContext,
} from './rag-cache';

export const DEFAULT_GRAPH_NODES_TABLE = 'FB_GRAPH_NODES';
export const DEFAULT_GRAPH_EDGES_TABLE = 'FB_GRAPH_EDGES';

/** Minimal database interface required by {@link createKnowledgeGraph} (`M28 Item 2`). */
export interface GraphDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<unknown>;
}

/** Property graph node input (`M28 Item 2`). */
export interface GraphNodeInput {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly summary?: string;
  readonly props?: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
  readonly embedding?: VectorInput | null;
}

/** Stored property graph node (`M28 Item 2`). */
export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly summary: string;
  readonly props: Record<string, unknown>;
  readonly embedding: Float32Array | null;
  readonly updatedAt: number;
}

/** Property graph edge input (`M28 Item 2`). */
export interface GraphEdgeInput {
  readonly id?: string;
  readonly src?: string;
  readonly srcId?: string;
  readonly rel?: string;
  readonly relType?: string;
  readonly dst?: string;
  readonly dstId?: string;
  readonly weight?: number;
  readonly props?: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

/** Stored property graph edge (`M28 Item 2`). */
export interface GraphEdge {
  readonly id: string;
  readonly src: string;
  readonly rel: string;
  readonly dst: string;
  readonly weight: number;
  readonly props: Record<string, unknown>;
  readonly updatedAt: number;
}

/** Multi-hop neighbor match returned by `WITH RECURSIVE` traversal (`M28 Item 2`). */
export interface GraphNeighborHit {
  readonly node: GraphNode;
  readonly hop: number;
  readonly pathIds: readonly string[];
  readonly viaRel: string;
  readonly totalWeight: number;
}

/** Shortest path between two graph entities (`M28 Item 2`). */
export interface GraphPathResult {
  readonly nodeIds: readonly string[];
  readonly relations: readonly string[];
  readonly hops: number;
  readonly totalWeight: number;
}

/** Compiled Cypher-lite `WITH RECURSIVE` SQL query (`M28 Item 2`). */
export interface CompiledGraphPattern {
  readonly sql: string;
  readonly params: QueryParams;
  readonly srcAlias: string;
  readonly dstAlias: string;
  readonly minHops: number;
  readonly maxHops: number;
}

/** Options for {@link createKnowledgeGraph} (`M28 Item 2`). */
export interface KnowledgeGraphOptions {
  readonly nodesTable?: string;
  readonly edgesTable?: string;
}

/** Handle returned by {@link createKnowledgeGraph} (`M28 Item 2`). */
export interface KnowledgeGraphHandle {
  readonly nodesTable: string;
  readonly edgesTable: string;
  ensureSchema(): Promise<void>;
  upsertNode(node: GraphNodeInput): Promise<GraphNode>;
  upsertEdge(edge: GraphEdgeInput): Promise<GraphEdge>;
  upsertSubgraph(subgraph: {
    nodes?: readonly GraphNodeInput[];
    edges?: readonly GraphEdgeInput[];
  }): Promise<{ nodesUpserted: number; edgesUpserted: number }>;
  getNode(id: string): Promise<GraphNode | null>;
  removeNode(id: string): Promise<void>;
  neighbors(
    startNodeId: string,
    options?: {
      maxHops?: number;
      relTypes?: readonly string[];
      direction?: 'out' | 'in' | 'both';
    },
  ): Promise<GraphNeighborHit[]>;
  shortestPath(
    srcId: string,
    dstId: string,
    options?: { maxHops?: number; weighted?: boolean },
  ): Promise<GraphPathResult | null>;
  pageRank(options?: {
    damping?: number;
    iterations?: number;
    personalizedSeeds?: Readonly<Record<string, number>>;
  }): Promise<Array<{ nodeId: string; score: number }>>;
  matchPattern(
    pattern: string,
  ): Promise<
    Array<{
      srcId: string;
      srcLabel: string;
      srcName: string;
      dstId: string;
      dstLabel: string;
      dstName: string;
      hops: number;
      pathIds: string[];
    }>
  >;
}

/** Options for {@link graphRagSearch} (`M28 Item 2`). */
export interface GraphRagSearchOptions {
  readonly query: string;
  readonly queryVector?: VectorInput | null;
  readonly embed?: (text: string) => Promise<VectorInput> | VectorInput;
  readonly seedLimit?: number;
  readonly maxHops?: number;
  readonly relTypes?: readonly string[];
  readonly tokenBudget?: number;
  readonly diversityLambda?: number;
  readonly nodesTable?: string;
  readonly edgesTable?: string;
}

export interface GraphRagPassage extends Record<string, unknown> {
  readonly ID: string;
  readonly TITLE: string;
  readonly CONTENT: string;
  readonly SIMILARITY: number;
  readonly HOP_COUNT: number;
  readonly RELATED_IDS: readonly string[];
}

// ---------------------------------------------------------------------------
// Cypher-Lite Pattern -> Firebird 5 `WITH RECURSIVE` SQL Compiler
// ---------------------------------------------------------------------------

const CYPHER_LITE_RE =
  /^\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?(?::([A-Za-z_][A-Za-z0-9_]*))?(?:\s*\{\s*id\s*:\s*['"]([^'"]+)['"]\s*\})?\s*\)\s*(<-|-)\[\s*(?::([A-Za-z_|][A-Za-z0-9_|]*))?(?:\*(\d+)(?:\.\.(\d+))?)?\s*\](->|-)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?(?::([A-Za-z_][A-Za-z0-9_]*))?\s*\)\s*$/;

function qGraphIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Compile a Cypher-lite relationship pattern such as
 * `'(u:Person)-[:WORKS_ON*1..2]->(p:Project)'` or `'(a:Doc)<-[:CITES]-(b:Doc)'`
 * into a cycle-safe parameterized Firebird 5 `WITH RECURSIVE` query (`M28 Item 2`).
 */
export function compileGraphPatternSql(
  pattern: string,
  options: { nodesTable?: string; edgesTable?: string } = {},
): CompiledGraphPattern {
  const m = CYPHER_LITE_RE.exec(pattern);
  if (!m) {
    throw new Error(
      `Invalid Cypher-lite graph pattern: "${pattern}". Expected "(a:Label)-[:REL*1..2]->(b:Label)".`,
    );
  }
  const srcAlias = m[1] || 'src';
  const srcLabel = m[2] || null;
  const srcFixedId = m[3] || null;
  const leftArrow = m[4]!;
  const relRaw = m[5] || null;
  const minHops = m[6] !== undefined ? Math.max(1, Number(m[6])) : 1;
  const maxHops = m[7] !== undefined ? Math.max(minHops, Number(m[7])) : minHops;
  const rightArrow = m[8]!;
  const dstAlias = m[9] || 'dst';
  const dstLabel = m[10] || null;

  const direction: 'out' | 'in' | 'both' =
    leftArrow === '<-' && rightArrow === '-'
      ? 'in'
      : leftArrow === '-' && rightArrow === '->'
        ? 'out'
        : 'both';

  const nodesTbl = qGraphIdent((options.nodesTable ?? DEFAULT_GRAPH_NODES_TABLE).toUpperCase());
  const edgesTbl = qGraphIdent((options.edgesTable ?? DEFAULT_GRAPH_EDGES_TABLE).toUpperCase());
  const relTypes = relRaw ? relRaw.split('|').map((s) => s.trim()).filter(Boolean) : [];

  const params: unknown[] = [];

  const buildEdgeStepCondition = (edgeAlias: string, fromExpr: string): { nextCol: string; cond: string; stepParams: unknown[] } => {
    const sp: unknown[] = [];
    let relCond = '';
    if (relTypes.length > 0) {
      relCond = ` AND ${edgeAlias}.REL_TYPE IN (${relTypes.map(() => '?').join(', ')})`;
      sp.push(...relTypes);
    }
    if (direction === 'in') {
      return {
        nextCol: `${edgeAlias}.SRC_ID`,
        cond: `${edgeAlias}.DST_ID = ${fromExpr}${relCond}`,
        stepParams: sp,
      };
    }
    return {
      nextCol: `${edgeAlias}.DST_ID`,
      cond: `${edgeAlias}.SRC_ID = ${fromExpr}${relCond}`,
      stepParams: sp,
    };
  };

  let srcFilter = '1=1';
  const anchorParams: unknown[] = [];
  if (srcLabel) {
    srcFilter += ' AND S.LABEL = ?';
    anchorParams.push(srcLabel);
  }
  if (srcFixedId) {
    srcFilter += ' AND S.NODE_ID = ?';
    anchorParams.push(srcFixedId);
  }

  let anchorSql: string;
  let recursiveSql: string;

  if (direction === 'both') {
    let relCond = '';
    const relP: unknown[] = [];
    if (relTypes.length > 0) {
      relCond = ` AND E.REL_TYPE IN (${relTypes.map(() => '?').join(', ')})`;
      relP.push(...relTypes);
    }
    anchorSql = `SELECT S.NODE_ID AS ROOT_ID,
       CASE WHEN E.SRC_ID = S.NODE_ID THEN E.DST_ID ELSE E.SRC_ID END AS CUR_ID,
       CAST(1 AS INTEGER) AS HOP,
       CAST('|' || TRIM(S.NODE_ID) || '|' || TRIM(CASE WHEN E.SRC_ID = S.NODE_ID THEN E.DST_ID ELSE E.SRC_ID END) || '|' AS VARCHAR(2048)) AS PATH_STR
     FROM ${nodesTbl} S
     JOIN ${edgesTbl} E ON (E.SRC_ID = S.NODE_ID OR E.DST_ID = S.NODE_ID)${relCond}
     WHERE ${srcFilter} AND (CASE WHEN E.SRC_ID = S.NODE_ID THEN E.DST_ID ELSE E.SRC_ID END) <> S.NODE_ID`;
    params.push(...relP, ...anchorParams);

    recursiveSql = `SELECT W.ROOT_ID,
       CASE WHEN E2.SRC_ID = W.CUR_ID THEN E2.DST_ID ELSE E2.SRC_ID END AS CUR_ID,
       W.HOP + 1,
       CAST(W.PATH_STR || TRIM(CASE WHEN E2.SRC_ID = W.CUR_ID THEN E2.DST_ID ELSE E2.SRC_ID END) || '|' AS VARCHAR(2048))
     FROM PATTERN_WALK W
     JOIN ${edgesTbl} E2 ON (E2.SRC_ID = W.CUR_ID OR E2.DST_ID = W.CUR_ID)${relCond.replace(/E\./g, 'E2.')}
     WHERE W.HOP < ?
       AND POSITION('|' || TRIM(CASE WHEN E2.SRC_ID = W.CUR_ID THEN E2.DST_ID ELSE E2.SRC_ID END) || '|' IN W.PATH_STR) = 0`;
    params.push(...relP, maxHops);
  } else {
    const aStep = buildEdgeStepCondition('E', 'S.NODE_ID');
    anchorSql = `SELECT S.NODE_ID AS ROOT_ID,
       ${aStep.nextCol} AS CUR_ID,
       CAST(1 AS INTEGER) AS HOP,
       CAST('|' || TRIM(S.NODE_ID) || '|' || TRIM(${aStep.nextCol}) || '|' AS VARCHAR(2048)) AS PATH_STR
     FROM ${nodesTbl} S
     JOIN ${edgesTbl} E ON ${aStep.cond}
     WHERE ${srcFilter} AND ${aStep.nextCol} <> S.NODE_ID`;
    params.push(...aStep.stepParams, ...anchorParams);

    const rStep = buildEdgeStepCondition('E2', 'W.CUR_ID');
    recursiveSql = `SELECT W.ROOT_ID,
       ${rStep.nextCol} AS CUR_ID,
       W.HOP + 1,
       CAST(W.PATH_STR || TRIM(${rStep.nextCol}) || '|' AS VARCHAR(2048))
     FROM PATTERN_WALK W
     JOIN ${edgesTbl} E2 ON ${rStep.cond}
     WHERE W.HOP < ?
       AND POSITION('|' || TRIM(${rStep.nextCol}) || '|' IN W.PATH_STR) = 0`;
    params.push(...rStep.stepParams, maxHops);
  }

  params.push(minHops);
  let dstWhere = 'W.HOP >= ?';
  if (dstLabel) {
    dstWhere += ' AND D.LABEL = ?';
    params.push(dstLabel);
  }

  const sql = `WITH RECURSIVE PATTERN_WALK (ROOT_ID, CUR_ID, HOP, PATH_STR) AS (
    ${anchorSql}
    UNION ALL
    ${recursiveSql}
  )
  SELECT
    SN.NODE_ID AS SRC_ID, SN.LABEL AS SRC_LABEL, SN.NAME AS SRC_NAME,
    D.NODE_ID AS DST_ID, D.LABEL AS DST_LABEL, D.NAME AS DST_NAME,
    W.HOP AS HOPS, W.PATH_STR AS PATH_STR
  FROM PATTERN_WALK W
  JOIN ${nodesTbl} SN ON SN.NODE_ID = W.ROOT_ID
  JOIN ${nodesTbl} D ON D.NODE_ID = W.CUR_ID
  WHERE ${dstWhere}
  ORDER BY W.HOP ASC, SN.NODE_ID ASC, D.NODE_ID ASC`;

  return { sql, params: params as QueryParams, srcAlias, dstAlias, minHops, maxHops };
}

// ---------------------------------------------------------------------------
// Knowledge Graph Implementation
// ---------------------------------------------------------------------------

async function execGraphSql(
  db: GraphDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

function gCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

function decodeNodeRow(row: Record<string, unknown>): GraphNode {
  const rawProps = gCol(row, 'PROPS_JSON');
  let props: Record<string, unknown> = {};
  if (typeof rawProps === 'string' && rawProps.trim()) {
    try {
      props = JSON.parse(rawProps) as Record<string, unknown>;
    } catch {
      props = {};
    }
  }
  const rawEmb = gCol(row, 'EMBEDDING');
  let embedding: Float32Array | null = null;
  if (rawEmb !== null && rawEmb !== undefined && rawEmb !== '') {
    try {
      embedding = decodeVector(rawEmb as VectorInput);
    } catch {
      embedding = null;
    }
  }
  return {
    id: String(gCol(row, 'NODE_ID') ?? '').trim(),
    label: String(gCol(row, 'LABEL') ?? '').trim(),
    name: String(gCol(row, 'NAME') ?? ''),
    summary: String(gCol(row, 'SUMMARY') ?? ''),
    props,
    embedding,
    updatedAt: Number(gCol(row, 'UPDATED_AT') ?? 0),
  };
}

/**
 * Create a property graph engine over Firebird `WITH RECURSIVE` SQL CTEs &
 * optional vector embeddings (`M28 Item 2`).
 */
export function createKnowledgeGraph(
  db: GraphDatabaseExecutor,
  options: KnowledgeGraphOptions = {},
): KnowledgeGraphHandle {
  const nodesTable = (options.nodesTable ?? DEFAULT_GRAPH_NODES_TABLE).toUpperCase();
  const edgesTable = (options.edgesTable ?? DEFAULT_GRAPH_EDGES_TABLE).toUpperCase();
  let schemaPromise: Promise<void> | null = null;

  const ensureSchema = (): Promise<void> => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        const nCheck = await db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
          [nodesTable],
        );
        if (Number(gCol(nCheck.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
          await execGraphSql(
            db,
            `CREATE TABLE ${qGraphIdent(nodesTable)} (
              NODE_ID VARCHAR(128) NOT NULL PRIMARY KEY,
              LABEL VARCHAR(64) NOT NULL,
              NAME VARCHAR(256) NOT NULL,
              SUMMARY BLOB SUB_TYPE TEXT,
              PROPS_JSON BLOB SUB_TYPE TEXT,
              EMBEDDING BLOB,
              UPDATED_AT BIGINT NOT NULL
            )`,
          );
        }
        const eCheck = await db.query<Record<string, unknown>>(
          `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
          [edgesTable],
        );
        if (Number(gCol(eCheck.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
          await execGraphSql(
            db,
            `CREATE TABLE ${qGraphIdent(edgesTable)} (
              EDGE_ID VARCHAR(192) NOT NULL PRIMARY KEY,
              SRC_ID VARCHAR(128) NOT NULL,
              REL_TYPE VARCHAR(64) NOT NULL,
              DST_ID VARCHAR(128) NOT NULL,
              WEIGHT DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
              PROPS_JSON BLOB SUB_TYPE TEXT,
              UPDATED_AT BIGINT NOT NULL
            )`,
          );
        }
      })();
    }
    return schemaPromise;
  };

  return {
    nodesTable,
    edgesTable,
    ensureSchema,

    async upsertNode(node: GraphNodeInput): Promise<GraphNode> {
      await ensureSchema();
      const now = Date.now();
      const embBytes =
        node.embedding !== null && node.embedding !== undefined
          ? encodeVector(node.embedding)
          : null;
      const resolvedProps = node.props ?? node.properties ?? {};
      const propsJson = JSON.stringify(resolvedProps);
      const summary = node.summary ?? '';
      await execGraphSql(
        db,
        `UPDATE OR INSERT INTO ${qGraphIdent(nodesTable)} (
          NODE_ID, LABEL, NAME, SUMMARY, PROPS_JSON, EMBEDDING, UPDATED_AT
        ) VALUES (?, ?, ?, ?, ?, ?, ?) MATCHING (NODE_ID)`,
        [node.id, node.label, node.name, summary, propsJson, embBytes, now],
      );
      return {
        id: node.id,
        label: node.label,
        name: node.name,
        summary,
        props: resolvedProps,
        embedding: embBytes ? decodeVector(embBytes) : null,
        updatedAt: now,
      };
    },

    async upsertEdge(edge: GraphEdgeInput): Promise<GraphEdge> {
      await ensureSchema();
      const now = Date.now();
      const src = (edge.src ?? edge.srcId ?? '').trim();
      const rel = (edge.rel ?? edge.relType ?? '').trim();
      const dst = (edge.dst ?? edge.dstId ?? '').trim();
      if (!src || !rel || !dst) {
        throw new Error('upsertEdge requires src/srcId, rel/relType, and dst/dstId.');
      }
      const edgeId = edge.id ?? `${src}::${rel}::${dst}`;
      const weight = edge.weight ?? 1.0;
      const resolvedProps = edge.props ?? edge.properties ?? {};
      const propsJson = JSON.stringify(resolvedProps);
      await execGraphSql(
        db,
        `UPDATE OR INSERT INTO ${qGraphIdent(edgesTable)} (
          EDGE_ID, SRC_ID, REL_TYPE, DST_ID, WEIGHT, PROPS_JSON, UPDATED_AT
        ) VALUES (?, ?, ?, ?, ?, ?, ?) MATCHING (EDGE_ID)`,
        [edgeId, src, rel, dst, weight, propsJson, now],
      );
      return {
        id: edgeId,
        src,
        rel,
        dst,
        weight,
        props: resolvedProps,
        updatedAt: now,
      };
    },

    async upsertSubgraph(subgraph) {
      await ensureSchema();
      const nodes = subgraph.nodes ?? [];
      const edges = subgraph.edges ?? [];
      for (const n of nodes) await this.upsertNode(n);
      for (const e of edges) await this.upsertEdge(e);
      return { nodesUpserted: nodes.length, edgesUpserted: edges.length };
    },

    async getNode(id: string): Promise<GraphNode | null> {
      await ensureSchema();
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qGraphIdent(nodesTable)} WHERE NODE_ID = ?`,
        [id],
      );
      return res.rows.length > 0 ? decodeNodeRow(res.rows[0]!) : null;
    },

    async removeNode(id: string): Promise<void> {
      await ensureSchema();
      await execGraphSql(
        db,
        `DELETE FROM ${qGraphIdent(edgesTable)} WHERE SRC_ID = ? OR DST_ID = ?`,
        [id, id],
      );
      await execGraphSql(db, `DELETE FROM ${qGraphIdent(nodesTable)} WHERE NODE_ID = ?`, [id]);
    },

    async neighbors(startNodeId, navOpts = {}): Promise<GraphNeighborHit[]> {
      await ensureSchema();
      const maxHops = Math.max(1, navOpts.maxHops ?? 2);
      const dir = navOpts.direction ?? 'out';
      const rels = navOpts.relTypes ?? [];
      const relCond =
        rels.length > 0 ? ` AND E.REL_TYPE IN (${rels.map(() => '?').join(', ')})` : '';
      const relCond2 = relCond.replace(/E\./g, 'E2.');

      let sql: string;
      const params: unknown[] = [];

      if (dir === 'both') {
        sql = `WITH RECURSIVE GRAPH_WALK (NODE_ID, HOP, PATH_STR, VIA_REL, TOTAL_WEIGHT) AS (
          SELECT
            CASE WHEN E.SRC_ID = ? THEN E.DST_ID ELSE E.SRC_ID END,
            CAST(1 AS INTEGER),
            CAST('|' || TRIM(CASE WHEN E.SRC_ID = ? THEN E.SRC_ID ELSE E.DST_ID END) || '|' || TRIM(CASE WHEN E.SRC_ID = ? THEN E.DST_ID ELSE E.SRC_ID END) || '|' AS VARCHAR(2048)),
            E.REL_TYPE,
            CAST(E.WEIGHT AS DOUBLE PRECISION)
          FROM ${qGraphIdent(edgesTable)} E
          WHERE (E.SRC_ID = ? OR E.DST_ID = ?)${relCond}
          UNION ALL
          SELECT
            CASE WHEN E2.SRC_ID = W.NODE_ID THEN E2.DST_ID ELSE E2.SRC_ID END,
            W.HOP + 1,
            CAST(W.PATH_STR || TRIM(CASE WHEN E2.SRC_ID = W.NODE_ID THEN E2.DST_ID ELSE E2.SRC_ID END) || '|' AS VARCHAR(2048)),
            E2.REL_TYPE,
            W.TOTAL_WEIGHT + E2.WEIGHT
          FROM GRAPH_WALK W
          JOIN ${qGraphIdent(edgesTable)} E2 ON (E2.SRC_ID = W.NODE_ID OR E2.DST_ID = W.NODE_ID)${relCond2}
          WHERE W.HOP < ?
            AND POSITION('|' || TRIM(CASE WHEN E2.SRC_ID = W.NODE_ID THEN E2.DST_ID ELSE E2.SRC_ID END) || '|' IN W.PATH_STR) = 0
        )
        SELECT N.*, W.HOP, W.PATH_STR, W.VIA_REL, W.TOTAL_WEIGHT
        FROM GRAPH_WALK W
        JOIN ${qGraphIdent(nodesTable)} N ON N.NODE_ID = W.NODE_ID
        ORDER BY W.HOP ASC, W.TOTAL_WEIGHT ASC`;
        params.push(
          startNodeId,
          startNodeId,
          startNodeId,
          startNodeId,
          startNodeId,
          ...rels,
          ...rels,
          maxHops,
        );
      } else {
        const srcCol = dir === 'in' ? 'DST_ID' : 'SRC_ID';
        const dstCol = dir === 'in' ? 'SRC_ID' : 'DST_ID';
        sql = `WITH RECURSIVE GRAPH_WALK (NODE_ID, HOP, PATH_STR, VIA_REL, TOTAL_WEIGHT) AS (
          SELECT
            E.${dstCol},
            CAST(1 AS INTEGER),
            CAST('|' || TRIM(E.${srcCol}) || '|' || TRIM(E.${dstCol}) || '|' AS VARCHAR(2048)),
            E.REL_TYPE,
            CAST(E.WEIGHT AS DOUBLE PRECISION)
          FROM ${qGraphIdent(edgesTable)} E
          WHERE E.${srcCol} = ?${relCond} AND E.${dstCol} <> E.${srcCol}
          UNION ALL
          SELECT
            E2.${dstCol},
            W.HOP + 1,
            CAST(W.PATH_STR || TRIM(E2.${dstCol}) || '|' AS VARCHAR(2048)),
            E2.REL_TYPE,
            W.TOTAL_WEIGHT + E2.WEIGHT
          FROM GRAPH_WALK W
          JOIN ${qGraphIdent(edgesTable)} E2 ON E2.${srcCol} = W.NODE_ID${relCond2}
          WHERE W.HOP < ?
            AND POSITION('|' || TRIM(E2.${dstCol}) || '|' IN W.PATH_STR) = 0
        )
        SELECT N.*, W.HOP, W.PATH_STR, W.VIA_REL, W.TOTAL_WEIGHT
        FROM GRAPH_WALK W
        JOIN ${qGraphIdent(nodesTable)} N ON N.NODE_ID = W.NODE_ID
        ORDER BY W.HOP ASC, W.TOTAL_WEIGHT ASC`;
        params.push(startNodeId, ...rels, ...rels, maxHops);
      }

      const res = await db.query<Record<string, unknown>>(sql, params as QueryParams);
      const bestByNode = new Map<string, GraphNeighborHit>();
      for (const r of res.rows) {
        const node = decodeNodeRow(r);
        const hop = Number(gCol(r, 'HOP') ?? 1);
        const totalWeight = Number(gCol(r, 'TOTAL_WEIGHT') ?? hop);
        const pathStr = String(gCol(r, 'PATH_STR') ?? '');
        const pathIds = pathStr.split('|').filter(Boolean);
        const viaRel = String(gCol(r, 'VIA_REL') ?? '');
        const prev = bestByNode.get(node.id);
        if (!prev || hop < prev.hop || (hop === prev.hop && totalWeight < prev.totalWeight)) {
          bestByNode.set(node.id, { node, hop, pathIds, viaRel, totalWeight });
        }
      }
      return [...bestByNode.values()];
    },

    async shortestPath(srcId, dstId, pathOpts = {}): Promise<GraphPathResult | null> {
      await ensureSchema();
      if (srcId === dstId) {
        return { nodeIds: [srcId], relations: [], hops: 0, totalWeight: 0 };
      }
      const maxHops = Math.max(1, pathOpts.maxHops ?? 8);
      const weighted = pathOpts.weighted ?? true;
      const edgeRes = await db.query<Record<string, unknown>>(
        `SELECT SRC_ID, REL_TYPE, DST_ID, WEIGHT FROM ${qGraphIdent(edgesTable)}`,
      );
      const adj = new Map<string, Array<{ dst: string; rel: string; weight: number }>>();
      for (const r of edgeRes.rows) {
        const s = String(gCol(r, 'SRC_ID') ?? '');
        const d = String(gCol(r, 'DST_ID') ?? '');
        const rel = String(gCol(r, 'REL_TYPE') ?? '');
        const w = weighted ? Math.max(0, Number(gCol(r, 'WEIGHT') ?? 1)) : 1;
        let list = adj.get(s);
        if (!list) {
          list = [];
          adj.set(s, list);
        }
        list.push({ dst: d, rel, weight: w });
      }

      const dist = new Map<string, number>([[srcId, 0]]);
      const prev = new Map<string, { from: string; rel: string; hops: number }>();
      const hopsMap = new Map<string, number>([[srcId, 0]]);
      const visited = new Set<string>();

      while (visited.size < dist.size) {
        let cur: string | null = null;
        let bestD = Infinity;
        for (const [k, dVal] of dist) {
          if (!visited.has(k) && dVal < bestD) {
            bestD = dVal;
            cur = k;
          }
        }
        if (cur === null) break;
        if (cur === dstId) break;
        visited.add(cur);

        const curHops = hopsMap.get(cur) ?? 0;
        if (curHops >= maxHops) continue;

        for (const edge of adj.get(cur) ?? []) {
          const candDist = bestD + edge.weight;
          if (candDist < (dist.get(edge.dst) ?? Infinity)) {
            dist.set(edge.dst, candDist);
            hopsMap.set(edge.dst, curHops + 1);
            prev.set(edge.dst, { from: cur, rel: edge.rel, hops: curHops + 1 });
          }
        }
      }

      if (!dist.has(dstId)) return null;
      const nodeIds: string[] = [dstId];
      const relations: string[] = [];
      let walk = dstId;
      while (walk !== srcId) {
        const step = prev.get(walk);
        if (!step) return null;
        relations.unshift(step.rel);
        nodeIds.unshift(step.from);
        walk = step.from;
      }
      return {
        nodeIds,
        relations,
        hops: relations.length,
        totalWeight: dist.get(dstId)!,
      };
    },

    async pageRank(prOpts = {}) {
      await ensureSchema();
      const damping = prOpts.damping ?? 0.85;
      const iterations = Math.max(1, prOpts.iterations ?? 20);
      const [nRes, eRes] = await Promise.all([
        db.query<Record<string, unknown>>(`SELECT NODE_ID FROM ${qGraphIdent(nodesTable)}`),
        db.query<Record<string, unknown>>(`SELECT SRC_ID, DST_ID, WEIGHT FROM ${qGraphIdent(edgesTable)}`),
      ]);
      const ids = nRes.rows.map((r) => String(gCol(r, 'NODE_ID') ?? '')).filter(Boolean);
      const N = ids.length;
      if (N === 0) return [];

      const outEdges = new Map<string, Array<{ dst: string; w: number }>>();
      const outWeightSum = new Map<string, number>();
      for (const id of ids) {
        outEdges.set(id, []);
        outWeightSum.set(id, 0);
      }
      for (const r of eRes.rows) {
        const s = String(gCol(r, 'SRC_ID') ?? '');
        const d = String(gCol(r, 'DST_ID') ?? '');
        const w = Math.max(0.0001, Number(gCol(r, 'WEIGHT') ?? 1));
        if (outEdges.has(s) && outWeightSum.has(d)) {
          outEdges.get(s)!.push({ dst: d, w });
          outWeightSum.set(s, (outWeightSum.get(s) ?? 0) + w);
        }
      }

      const teleport = new Map<string, number>();
      const seeds = prOpts.personalizedSeeds;
      if (seeds && Object.keys(seeds).length > 0) {
        let sum = 0;
        for (const id of ids) sum += Math.max(0, seeds[id] ?? 0);
        for (const id of ids) {
          teleport.set(id, sum > 0 ? Math.max(0, seeds[id] ?? 0) / sum : 1 / N);
        }
      } else {
        for (const id of ids) teleport.set(id, 1 / N);
      }

      let scores = new Map<string, number>(teleport);
      for (let iter = 0; iter < iterations; iter++) {
        const next = new Map<string, number>();
        let sinkMass = 0;
        for (const id of ids) {
          next.set(id, (1 - damping) * (teleport.get(id) ?? 1 / N));
          if ((outWeightSum.get(id) ?? 0) === 0) {
            sinkMass += scores.get(id) ?? 0;
          }
        }
        for (const id of ids) {
          const curScore = scores.get(id) ?? 0;
          const totalOut = outWeightSum.get(id) ?? 0;
          if (totalOut > 0) {
            for (const e of outEdges.get(id)!) {
              next.set(e.dst, (next.get(e.dst) ?? 0) + damping * curScore * (e.w / totalOut));
            }
          }
          if (sinkMass > 0) {
            next.set(id, (next.get(id) ?? 0) + damping * sinkMass * (teleport.get(id) ?? 1 / N));
          }
        }
        scores = next;
      }

      return ids
        .map((nodeId) => ({ nodeId, score: scores.get(nodeId) ?? 0 }))
        .sort((a, b) => b.score - a.score);
    },

    async matchPattern(pattern: string) {
      await ensureSchema();
      const compiled = compileGraphPatternSql(pattern, { nodesTable, edgesTable });
      const res = await db.query<Record<string, unknown>>(compiled.sql, compiled.params);
      return res.rows.map((r) => ({
        srcId: String(gCol(r, 'SRC_ID') ?? ''),
        srcLabel: String(gCol(r, 'SRC_LABEL') ?? ''),
        srcName: String(gCol(r, 'SRC_NAME') ?? ''),
        dstId: String(gCol(r, 'DST_ID') ?? ''),
        dstLabel: String(gCol(r, 'DST_LABEL') ?? ''),
        dstName: String(gCol(r, 'DST_NAME') ?? ''),
        hops: Number(gCol(r, 'HOPS') ?? 1),
        pathIds: String(gCol(r, 'PATH_STR') ?? '')
          .split('|')
          .filter(Boolean),
      }));
    },
  };
}

/**
 * Execute **GraphRAG** retrieval: score seed entities via hybrid BM25 + vector
 * cosine similarity, expand $k$-hop relational context via `WITH RECURSIVE`
 * graph traversal, rerank via MMR, and pack citations within `tokenBudget` (`M28 Item 2`).
 */
export async function graphRagSearch(
  db: GraphDatabaseExecutor,
  options: GraphRagSearchOptions,
): Promise<PackedRagContext<GraphRagPassage> & { seedNodeIds: string[]; expandedNodeIds: string[] }>;
export async function graphRagSearch(
  graph: KnowledgeGraphHandle,
  db: GraphDatabaseExecutor,
  options: GraphRagSearchOptions,
): Promise<PackedRagContext<GraphRagPassage> & { seedNodeIds: string[]; expandedNodeIds: string[] }>;
export async function graphRagSearch(
  dbOrGraph: GraphDatabaseExecutor | KnowledgeGraphHandle,
  dbOrOptions: GraphDatabaseExecutor | GraphRagSearchOptions,
  maybeOptions?: GraphRagSearchOptions,
): Promise<PackedRagContext<GraphRagPassage> & { seedNodeIds: string[]; expandedNodeIds: string[] }> {
  let graph: KnowledgeGraphHandle;
  let db: GraphDatabaseExecutor;
  let opts: GraphRagSearchOptions;

  if ('upsertNode' in dbOrGraph && maybeOptions) {
    graph = dbOrGraph;
    db = dbOrOptions as GraphDatabaseExecutor;
    opts = maybeOptions;
  } else {
    db = dbOrGraph as GraphDatabaseExecutor;
    opts = dbOrOptions as GraphRagSearchOptions;
    graph = createKnowledgeGraph(db, {
      nodesTable: opts.nodesTable,
      edgesTable: opts.edgesTable,
    });
  }

  await graph.ensureSchema();
  const qVecRaw =
    opts.queryVector ?? (opts.embed ? await opts.embed(opts.query) : null);
  const qVec = qVecRaw ? decodeVector(qVecRaw) : null;
  const qTokens = new Set(tokenizeText(opts.query));

  const [nodesRes, edgesRes] = await Promise.all([
    db.query<Record<string, unknown>>(`SELECT * FROM ${qGraphIdent(graph.nodesTable)}`),
    db.query<Record<string, unknown>>(`SELECT * FROM ${qGraphIdent(graph.edgesTable)}`),
  ]);

  const allNodes = nodesRes.rows.map(decodeNodeRow);
  const edgesByNode = new Map<string, Array<{ rel: string; otherId: string; dir: '->' | '<-' }>>();
  const nodesById = new Map<string, GraphNode>();
  for (const n of allNodes) {
    nodesById.set(n.id, n);
    edgesByNode.set(n.id, []);
  }
  for (const er of edgesRes.rows) {
    const s = String(gCol(er, 'SRC_ID') ?? '');
    const rel = String(gCol(er, 'REL_TYPE') ?? '');
    const d = String(gCol(er, 'DST_ID') ?? '');
    edgesByNode.get(s)?.push({ rel, otherId: d, dir: '->' });
    edgesByNode.get(d)?.push({ rel, otherId: s, dir: '<-' });
  }

  const scoredSeeds = allNodes
    .map((n) => {
      let vecSim = 0;
      if (qVec && n.embedding && n.embedding.length === qVec.length) {
        vecSim = Math.max(0, cosineSimilarity(qVec, n.embedding));
      }
      const docTokens = tokenizeText(`${n.name} ${n.label} ${n.summary}`);
      let overlap = 0;
      for (const t of docTokens) {
        if (qTokens.has(t)) overlap++;
      }
      const lexicalSim = qTokens.size > 0 ? overlap / Math.sqrt(qTokens.size * Math.max(1, docTokens.length)) : 0;
      const score = qVec ? vecSim * 0.7 + lexicalSim * 0.3 : lexicalSim;
      return { node: n, score };
    })
    .filter((s) => s.score > 0 || allNodes.length <= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, opts.seedLimit ?? 3));

  const seedNodeIds = scoredSeeds.map((s) => s.node.id);
  const candidatePassages = new Map<string, GraphRagPassage>();

  const formatNodePassage = (n: GraphNode, sim: number, hop: number): GraphRagPassage => {
    const rels = edgesByNode.get(n.id) ?? [];
    const relLines = rels.slice(0, 8).map((r) => {
      const targetName = nodesById.get(r.otherId)?.name ?? r.otherId;
      return r.dir === '->'
        ? `${n.name} -[${r.rel}]-> ${targetName}`
        : `${targetName} -[${r.rel}]-> ${n.name}`;
    });
    const relBlock = relLines.length > 0 ? `\nRelations: ${relLines.join('; ')}` : '';
    return {
      ID: n.id,
      TITLE: `${n.name} (${n.label})`,
      CONTENT: `${n.summary || n.name}${relBlock}`,
      SIMILARITY: Number(sim.toFixed(4)),
      HOP_COUNT: hop,
      RELATED_IDS: rels.map((r) => r.otherId),
    };
  };

  const maxHops = Math.max(1, opts.maxHops ?? 2);
  const expandedSet = new Set<string>();

  for (const seed of scoredSeeds) {
    candidatePassages.set(seed.node.id, formatNodePassage(seed.node, Math.max(0.01, seed.score), 0));
    const neigh = await graph.neighbors(seed.node.id, {
      maxHops,
      relTypes: opts.relTypes,
      direction: 'both',
    });
    for (const hit of neigh) {
      expandedSet.add(hit.node.id);
      const decayedSim = Math.max(0.005, seed.score * Math.pow(0.7, hit.hop));
      const existing = candidatePassages.get(hit.node.id);
      if (!existing || decayedSim > existing.SIMILARITY) {
        candidatePassages.set(hit.node.id, formatNodePassage(hit.node, decayedSim, hit.hop));
      }
    }
  }

  const reranked = mmrRerank([...candidatePassages.values()], {
    diversityLambda: opts.diversityLambda ?? 0.75,
  });
  const packed = packRagContext(reranked, {
    tokenBudget: opts.tokenBudget ?? 512,
    keyColumn: 'ID',
    titleColumn: 'TITLE',
    textColumn: 'CONTENT',
  });

  return {
    ...packed,
    seedNodeIds,
    expandedNodeIds: [...expandedSet],
  };
}
