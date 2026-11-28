/**
 * age-graph.ts – `Apache AGE`-Style Named Multi-Label Property Graph Engine
 * (`createGraphStore`, Cypher Pattern Matching, Weighted Dijkstra / BFS Shortest Path,
 * PageRank & Connected Components) (`M32 Item 5`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_AGE_GRAPHS_TABLE = 'FB_AGE_GRAPHS$';
export const DEFAULT_AGE_NODES_TABLE = 'FB_AGE_NODES$';
export const DEFAULT_AGE_EDGES_TABLE = 'FB_AGE_EDGES$';

export interface AgeGraphDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

export interface PropertyGraphNodeInput {
  readonly id: string;
  /** Single label or multi-label array (`'User'` or `['User', 'Admin']`). */
  readonly labels: string | readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface PropertyGraphNode {
  readonly graphName: string;
  readonly id: string;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown>;
  readonly updatedAtMs: number;
}

export interface PropertyGraphEdgeInput {
  readonly id?: string;
  readonly srcId: string;
  readonly dstId: string;
  readonly label: string;
  readonly weight?: number;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface PropertyGraphEdge {
  readonly graphName: string;
  readonly id: string;
  readonly srcId: string;
  readonly dstId: string;
  readonly label: string;
  readonly weight: number;
  readonly properties: Record<string, unknown>;
  readonly updatedAtMs: number;
}

export interface PropertyGraphMatchRow {
  readonly bindings: Record<string, PropertyGraphNode | PropertyGraphEdge | readonly PropertyGraphEdge[]>;
  readonly pathNodes: readonly PropertyGraphNode[];
  readonly pathEdges: readonly PropertyGraphEdge[];
  readonly hops: number;
  readonly totalWeight: number;
}

export interface PropertyGraphShortestPath {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly labels: readonly string[];
  readonly hops: number;
  readonly totalCost: number;
}

export interface PropertyGraphSummary {
  readonly graphName: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly updatedAtMs: number;
}

export interface CreateGraphStoreOptions {
  /** Named property graph namespace. @default 'default' */
  readonly graphName?: string;
  readonly graphsTable?: string;
  readonly nodesTable?: string;
  readonly edgesTable?: string;
}

export interface PropertyGraphStore {
  readonly graphName: string;
  upsertNode(input: PropertyGraphNodeInput): Promise<PropertyGraphNode>;
  upsertEdge(input: PropertyGraphEdgeInput): Promise<PropertyGraphEdge>;
  upsertBatch(batch: {
    nodes?: readonly PropertyGraphNodeInput[];
    edges?: readonly PropertyGraphEdgeInput[];
  }): Promise<{ nodes: number; edges: number }>;
  getNode(id: string): PropertyGraphNode | undefined;
  deleteNode(id: string): Promise<void>;
  /**
   * Evaluate Cypher/AGE path patterns such as:
   *   `(a:User {tier: 'pro'})-[r:FOLLOWS*1..3]->(b:User)`
   *   `(a:User)-[:MEMBER_OF]->(o:Org)-[:OWNS]->(p:Project)`
   */
  match(
    pattern: string,
    params?: Readonly<Record<string, unknown>>,
  ): PropertyGraphMatchRow[];
  /** Weighted Dijkstra (`weighted: true` / `weightProperty`) or unweighted BFS shortest path. */
  shortestPath(
    srcId: string,
    dstId: string,
    options?: {
      weighted?: boolean;
      weightProperty?: string;
      relLabels?: readonly string[];
      direction?: 'out' | 'in' | 'both';
      maxHops?: number;
    },
  ): PropertyGraphShortestPath | null;
  /** Iterative PageRank centrality over the named graph. */
  pageRank(options?: {
    damping?: number;
    iterations?: number;
  }): Array<{ nodeId: string; score: number }>;
  /** Weakly connected components (`componentId`, `nodeIds`, `size`). */
  connectedComponents(): Array<{ componentId: number; nodeIds: string[]; size: number }>;
  summary(): PropertyGraphSummary;
}

function qAge(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function ageCol(row: Record<string, unknown>, col: string): unknown {
  const u = col.toUpperCase();
  if (u in row) return row[u];
  const l = col.toLowerCase();
  if (l in row) return row[l];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === u) return row[k];
  }
  return undefined;
}

async function execAgeSql(
  db: AgeGraphDatabase,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

interface ParsedNodeSpec {
  readonly alias: string | null;
  readonly labels: string[];
  readonly props: Record<string, unknown>;
}

interface ParsedHopSpec {
  readonly edgeAlias: string | null;
  readonly relLabels: string[];
  readonly minHops: number;
  readonly maxHops: number;
  readonly direction: 'out' | 'in' | 'both';
  readonly edgeProps: Record<string, unknown>;
  readonly targetNode: ParsedNodeSpec;
}

function parseInlineProps(
  raw: string | undefined,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || !raw.trim()) return out;
  const inner = raw.trim().replace(/^\{|\}$/g, '').trim();
  if (!inner) return out;
  // Match `key: 'str' | "str" | $param | true | false | 123`
  const pairRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|\$([A-Za-z0-9_]+)|(true|false|null)|(-?\d+(?:\.\d+)?))/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(inner)) !== null) {
    const key = m[1]!;
    if (m[2] !== undefined) out[key] = m[2];
    else if (m[3] !== undefined) out[key] = m[3];
    else if (m[4] !== undefined) out[key] = params[m[4]];
    else if (m[5] !== undefined) {
      out[key] = m[5] === 'true' ? true : m[5] === 'false' ? false : null;
    } else if (m[6] !== undefined) out[key] = Number(m[6]);
  }
  return out;
}

function parseNodeToken(
  body: string,
  params: Readonly<Record<string, unknown>>,
): ParsedNodeSpec {
  const propIdx = body.indexOf('{');
  const head = (propIdx >= 0 ? body.slice(0, propIdx) : body).trim();
  const propRaw = propIdx >= 0 ? body.slice(propIdx) : undefined;
  const parts = head.split(':').map((s) => s.trim());
  const alias = parts[0] ? parts[0] : null;
  const labels = parts.slice(1).filter(Boolean);
  return {
    alias,
    labels,
    props: parseInlineProps(propRaw, params),
  };
}

function parseCypherPatternChain(
  pattern: string,
  params: Readonly<Record<string, unknown>>,
): { start: ParsedNodeSpec; hops: ParsedHopSpec[] } {
  const cleaned = pattern.replace(/^\s*MATCH\s+/i, '').trim();
  const firstOpen = cleaned.indexOf('(');
  if (firstOpen < 0) throw new Error(`Invalid Cypher graph pattern: "${pattern}"`);

  const findBalancedClose = (str: string, openPos: number, openCh: string, closeCh: string): number => {
    let depth = 0;
    let inQuote: string | null = null;
    for (let i = openPos; i < str.length; i++) {
      const ch = str[i]!;
      if (inQuote) {
        if (ch === inQuote && str[i - 1] !== '\\') inQuote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inQuote = ch;
        continue;
      }
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }
    throw new Error(`Unclosed '${openCh}' in graph pattern: "${pattern}"`);
  };

  const firstClose = findBalancedClose(cleaned, firstOpen, '(', ')');
  const start = parseNodeToken(cleaned.slice(firstOpen + 1, firstClose), params);
  const hops: ParsedHopSpec[] = [];

  let cursor = firstClose + 1;
  while (cursor < cleaned.length) {
    while (cursor < cleaned.length && /\s/.test(cleaned[cursor]!)) cursor++;
    if (cursor >= cleaned.length) break;

    let leftArrow = false;
    if (cleaned.startsWith('<-', cursor)) {
      leftArrow = true;
      cursor += 2;
    } else if (cleaned[cursor] === '-') {
      cursor += 1;
    } else {
      throw new Error(`Expected relationship connector at "${cleaned.slice(cursor)}"`);
    }

    let edgeBody = '';
    if (cleaned[cursor] === '[') {
      const closeBr = findBalancedClose(cleaned, cursor, '[', ']');
      edgeBody = cleaned.slice(cursor + 1, closeBr).trim();
      cursor = closeBr + 1;
    }

    let rightArrow = false;
    if (cleaned.startsWith('->', cursor)) {
      rightArrow = true;
      cursor += 2;
    } else if (cleaned[cursor] === '-') {
      cursor += 1;
    } else {
      throw new Error(`Expected '-' or '->' after relationship in "${pattern}"`);
    }

    while (cursor < cleaned.length && /\s/.test(cleaned[cursor]!)) cursor++;
    if (cleaned[cursor] !== '(') {
      throw new Error(`Expected target '(' in graph pattern "${pattern}"`);
    }
    const nextNodeClose = findBalancedClose(cleaned, cursor, '(', ')');
    const targetNode = parseNodeToken(cleaned.slice(cursor + 1, nextNodeClose), params);
    cursor = nextNodeClose + 1;

    // Parse `edgeBody` -> `alias:REL1|REL2*min..max {props}`
    const ePropIdx = edgeBody.indexOf('{');
    const eHead = (ePropIdx >= 0 ? edgeBody.slice(0, ePropIdx) : edgeBody).trim();
    const eProps = parseInlineProps(ePropIdx >= 0 ? edgeBody.slice(ePropIdx) : undefined, params);

    let minHops = 1;
    let maxHops = 1;
    let headNoRange = eHead;
    const starMatch = /\*(\d+)?(?:\.\.(\d+)?)?\s*$/.exec(eHead);
    if (starMatch) {
      headNoRange = eHead.slice(0, starMatch.index).trim();
      if (eHead.slice(starMatch.index).includes('..')) {
        minHops = starMatch[1] !== undefined ? Math.max(1, Number(starMatch[1])) : 1;
        maxHops = starMatch[2] !== undefined ? Math.max(minHops, Number(starMatch[2])) : 6;
      } else if (starMatch[1] !== undefined) {
        minHops = Math.max(1, Number(starMatch[1]));
        maxHops = minHops;
      } else {
        minHops = 1;
        maxHops = 6;
      }
    }

    const colonIdx = headNoRange.indexOf(':');
    const edgeAlias =
      colonIdx >= 0 ? (headNoRange.slice(0, colonIdx).trim() || null) : (headNoRange || null);
    const relRaw = colonIdx >= 0 ? headNoRange.slice(colonIdx + 1).trim() : '';
    const relLabels = relRaw
      ? relRaw
          .split('|')
          .map((s) => s.trim().replace(/^:/, ''))
          .filter(Boolean)
      : [];

    const direction: 'out' | 'in' | 'both' =
      leftArrow && !rightArrow ? 'in' : !leftArrow && rightArrow ? 'out' : 'both';

    hops.push({
      edgeAlias,
      relLabels,
      minHops,
      maxHops,
      direction,
      edgeProps: eProps,
      targetNode,
    });
  }

  return { start, hops };
}

function matchesProps(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) return false;
  }
  return true;
}

function matchesNodeSpec(node: PropertyGraphNode, spec: ParsedNodeSpec): boolean {
  for (const reqLabel of spec.labels) {
    if (!node.labels.includes(reqLabel)) return false;
  }
  return matchesProps(node.properties, spec.props);
}

/** Read persisted `FB_AGE_GRAPHS$` summaries without mutating schema (`M32 Item 5`). */
export async function fetchPersistedGraphs(
  db: AgeGraphDatabase,
  graphsTable = DEFAULT_AGE_GRAPHS_TABLE,
): Promise<PropertyGraphSummary[]> {
  const tblUpper = graphsTable.trim().toUpperCase();
  const chk = await db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [tblUpper],
  );
  if (Number(ageCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];
  const res = await db.query<Record<string, unknown>>(
    `SELECT "GRAPH_NAME", "NODE_COUNT", "EDGE_COUNT", "UPDATED_AT_MS"
       FROM ${qAge(tblUpper)} ORDER BY "GRAPH_NAME" ASC`,
  );
  return res.rows.map((r) => ({
    graphName: String(ageCol(r, 'GRAPH_NAME') ?? '').trim(),
    nodeCount: Number(ageCol(r, 'NODE_COUNT') ?? 0),
    edgeCount: Number(ageCol(r, 'EDGE_COUNT') ?? 0),
    updatedAtMs: Number(ageCol(r, 'UPDATED_AT_MS') ?? 0),
  }));
}

let edgeAutoSeq = 0;

/**
 * Create or open an `Apache AGE`-style labeled property graph backed by Firebird (`M32 Item 5`).
 */
export async function createGraphStore(
  db: AgeGraphDatabase,
  options: CreateGraphStoreOptions = {},
): Promise<PropertyGraphStore> {
  const graphName = (options.graphName ?? 'default').trim();
  const graphsTbl = (options.graphsTable ?? DEFAULT_AGE_GRAPHS_TABLE).trim().toUpperCase();
  const nodesTbl = (options.nodesTable ?? DEFAULT_AGE_NODES_TABLE).trim().toUpperCase();
  const edgesTbl = (options.edgesTable ?? DEFAULT_AGE_EDGES_TABLE).trim().toUpperCase();

  const nodes = new Map<string, PropertyGraphNode>();
  const edges = new Map<string, PropertyGraphEdge>();
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  let updatedAtMs = Date.now();

  const ensureTables = async (): Promise<void> => {
    const gChk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [graphsTbl],
    );
    if (Number(ageCol(gChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execAgeSql(
        db,
        `CREATE TABLE ${qAge(graphsTbl)} (
          "GRAPH_NAME" VARCHAR(128) NOT NULL PRIMARY KEY,
          "NODE_COUNT" INTEGER NOT NULL,
          "EDGE_COUNT" INTEGER NOT NULL,
          "UPDATED_AT_MS" BIGINT NOT NULL
        )`,
      );
    }

    const nChk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [nodesTbl],
    );
    if (Number(ageCol(nChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execAgeSql(
        db,
        `CREATE TABLE ${qAge(nodesTbl)} (
          "GRAPH_NAME" VARCHAR(128) NOT NULL,
          "NODE_ID" VARCHAR(128) NOT NULL,
          "LABELS_JSON" VARCHAR(1024) NOT NULL,
          "PROPS_JSON" BLOB SUB_TYPE TEXT NOT NULL,
          "UPDATED_AT_MS" BIGINT NOT NULL,
          PRIMARY KEY ("GRAPH_NAME", "NODE_ID")
        )`,
      );
    }

    const eChk = await db.query<Record<string, unknown>>(
      'SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [edgesTbl],
    );
    if (Number(ageCol(eChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execAgeSql(
        db,
        `CREATE TABLE ${qAge(edgesTbl)} (
          "GRAPH_NAME" VARCHAR(128) NOT NULL,
          "EDGE_ID" VARCHAR(128) NOT NULL,
          "SRC_ID" VARCHAR(128) NOT NULL,
          "DST_ID" VARCHAR(128) NOT NULL,
          "REL_LABEL" VARCHAR(128) NOT NULL,
          "WEIGHT" DOUBLE PRECISION NOT NULL,
          "PROPS_JSON" BLOB SUB_TYPE TEXT NOT NULL,
          "UPDATED_AT_MS" BIGINT NOT NULL,
          PRIMARY KEY ("GRAPH_NAME", "EDGE_ID")
        )`,
      );
    }
  };

  const persistSummary = async (): Promise<void> => {
    updatedAtMs = Date.now();
    await execAgeSql(
      db,
      `UPDATE OR INSERT INTO ${qAge(graphsTbl)} (
        "GRAPH_NAME", "NODE_COUNT", "EDGE_COUNT", "UPDATED_AT_MS"
      ) VALUES (?, ?, ?, ?) MATCHING ("GRAPH_NAME")`,
      [graphName, nodes.size, edges.size, updatedAtMs],
    );
  };

  const indexEdge = (e: PropertyGraphEdge): void => {
    let oSet = outAdj.get(e.srcId);
    if (!oSet) {
      oSet = new Set();
      outAdj.set(e.srcId, oSet);
    }
    oSet.add(e.id);

    let iSet = inAdj.get(e.dstId);
    if (!iSet) {
      iSet = new Set();
      inAdj.set(e.dstId, iSet);
    }
    iSet.add(e.id);
  };

  const unindexEdge = (e: PropertyGraphEdge): void => {
    outAdj.get(e.srcId)?.delete(e.id);
    inAdj.get(e.dstId)?.delete(e.id);
  };

  await ensureTables();

  // Hydrate existing nodes & edges for `graphName`
  const nRows = await db.query<Record<string, unknown>>(
    `SELECT "NODE_ID", "LABELS_JSON", "PROPS_JSON", "UPDATED_AT_MS"
       FROM ${qAge(nodesTbl)} WHERE "GRAPH_NAME" = ?`,
    [graphName],
  );
  for (const r of nRows.rows) {
    const id = String(ageCol(r, 'NODE_ID') ?? '');
    const labels = JSON.parse(String(ageCol(r, 'LABELS_JSON') ?? '[]')) as string[];
    const properties = JSON.parse(String(ageCol(r, 'PROPS_JSON') ?? '{}')) as Record<string, unknown>;
    nodes.set(id, {
      graphName,
      id,
      labels,
      properties,
      updatedAtMs: Number(ageCol(r, 'UPDATED_AT_MS') ?? 0),
    });
  }

  const eRows = await db.query<Record<string, unknown>>(
    `SELECT "EDGE_ID", "SRC_ID", "DST_ID", "REL_LABEL", "WEIGHT", "PROPS_JSON", "UPDATED_AT_MS"
       FROM ${qAge(edgesTbl)} WHERE "GRAPH_NAME" = ?`,
    [graphName],
  );
  for (const r of eRows.rows) {
    const edge: PropertyGraphEdge = {
      graphName,
      id: String(ageCol(r, 'EDGE_ID') ?? ''),
      srcId: String(ageCol(r, 'SRC_ID') ?? ''),
      dstId: String(ageCol(r, 'DST_ID') ?? ''),
      label: String(ageCol(r, 'REL_LABEL') ?? ''),
      weight: Number(ageCol(r, 'WEIGHT') ?? 1),
      properties: JSON.parse(String(ageCol(r, 'PROPS_JSON') ?? '{}')) as Record<string, unknown>,
      updatedAtMs: Number(ageCol(r, 'UPDATED_AT_MS') ?? 0),
    };
    edges.set(edge.id, edge);
    indexEdge(edge);
  }
  await persistSummary();

  const incidentEdges = (
    nodeId: string,
    dir: 'out' | 'in' | 'both',
  ): Array<{ edge: PropertyGraphEdge; neighborId: string }> => {
    const out: Array<{ edge: PropertyGraphEdge; neighborId: string }> = [];
    if (dir === 'out' || dir === 'both') {
      for (const eid of outAdj.get(nodeId) ?? []) {
        const e = edges.get(eid);
        if (e) out.push({ edge: e, neighborId: e.dstId });
      }
    }
    if (dir === 'in' || dir === 'both') {
      for (const eid of inAdj.get(nodeId) ?? []) {
        const e = edges.get(eid);
        if (e && !(dir === 'both' && e.srcId === e.dstId)) {
          out.push({ edge: e, neighborId: e.srcId });
        }
      }
    }
    return out;
  };

  const upsertNodeInternal = async (
    input: PropertyGraphNodeInput,
    updateSummary: boolean,
  ): Promise<PropertyGraphNode> => {
    const now = Date.now();
    const lbls = Array.isArray(input.labels) ? [...input.labels] : [input.labels];
    const props = { ...(input.properties ?? {}) };
    const node: PropertyGraphNode = {
      graphName,
      id: input.id,
      labels: lbls,
      properties: props,
      updatedAtMs: now,
    };
    nodes.set(node.id, node);
    await execAgeSql(
      db,
      `UPDATE OR INSERT INTO ${qAge(nodesTbl)} (
        "GRAPH_NAME", "NODE_ID", "LABELS_JSON", "PROPS_JSON", "UPDATED_AT_MS"
      ) VALUES (?, ?, ?, ?, ?) MATCHING ("GRAPH_NAME", "NODE_ID")`,
      [graphName, node.id, JSON.stringify(lbls), JSON.stringify(props), now],
    );
    if (updateSummary) await persistSummary();
    return node;
  };

  const upsertEdgeInternal = async (
    input: PropertyGraphEdgeInput,
    updateSummary: boolean,
  ): Promise<PropertyGraphEdge> => {
    const now = Date.now();
    const id = input.id ?? `e_${input.srcId}_${input.label}_${input.dstId}_${++edgeAutoSeq}`;
    const prev = edges.get(id);
    if (prev) unindexEdge(prev);
    const props = { ...(input.properties ?? {}) };
    const weight = input.weight ?? 1;
    const edge: PropertyGraphEdge = {
      graphName,
      id,
      srcId: input.srcId,
      dstId: input.dstId,
      label: input.label,
      weight,
      properties: props,
      updatedAtMs: now,
    };
    edges.set(id, edge);
    indexEdge(edge);
    await execAgeSql(
      db,
      `UPDATE OR INSERT INTO ${qAge(edgesTbl)} (
        "GRAPH_NAME", "EDGE_ID", "SRC_ID", "DST_ID", "REL_LABEL", "WEIGHT", "PROPS_JSON", "UPDATED_AT_MS"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) MATCHING ("GRAPH_NAME", "EDGE_ID")`,
      [graphName, id, edge.srcId, edge.dstId, edge.label, weight, JSON.stringify(props), now],
    );
    if (updateSummary) await persistSummary();
    return edge;
  };

  return {
    graphName,
    upsertNode: (input) => upsertNodeInternal(input, true),
    upsertEdge: (input) => upsertEdgeInternal(input, true),
    async upsertBatch(batch) {
      let nCount = 0;
      let eCount = 0;
      for (const n of batch.nodes ?? []) {
        await upsertNodeInternal(n, false);
        nCount++;
      }
      for (const e of batch.edges ?? []) {
        await upsertEdgeInternal(e, false);
        eCount++;
      }
      await persistSummary();
      return { nodes: nCount, edges: eCount };
    },
    getNode(id: string) {
      return nodes.get(id);
    },
    async deleteNode(id: string) {
      nodes.delete(id);
      const toRemove: PropertyGraphEdge[] = [];
      for (const e of edges.values()) {
        if (e.srcId === id || e.dstId === id) toRemove.push(e);
      }
      for (const e of toRemove) {
        unindexEdge(e);
        edges.delete(e.id);
      }
      await execAgeSql(
        db,
        `DELETE FROM ${qAge(edgesTbl)} WHERE "GRAPH_NAME" = ? AND ("SRC_ID" = ? OR "DST_ID" = ?)`,
        [graphName, id, id],
      );
      await execAgeSql(
        db,
        `DELETE FROM ${qAge(nodesTbl)} WHERE "GRAPH_NAME" = ? AND "NODE_ID" = ?`,
        [graphName, id],
      );
      await persistSummary();
    },

    match(pattern: string, params: Readonly<Record<string, unknown>> = {}): PropertyGraphMatchRow[] {
      const parsed = parseCypherPatternChain(pattern, params);
      const results: PropertyGraphMatchRow[] = [];

      const expandHop = (
        hopIdx: number,
        currentNode: PropertyGraphNode,
        bindings: Record<string, PropertyGraphNode | PropertyGraphEdge | readonly PropertyGraphEdge[]>,
        pathNodes: PropertyGraphNode[],
        pathEdges: PropertyGraphEdge[],
        usedEdgeIds: Set<string>,
        totalWeight: number,
      ): void => {
        if (hopIdx >= parsed.hops.length) {
          results.push({
            bindings: { ...bindings },
            pathNodes: [...pathNodes],
            pathEdges: [...pathEdges],
            hops: pathEdges.length,
            totalWeight,
          });
          return;
        }

        const hop = parsed.hops[hopIdx]!;

        // Variable-length DFS from `currentNode` (`minHops..maxHops`)
        const walkVarLen = (
          curr: PropertyGraphNode,
          depth: number,
          hopEdges: PropertyGraphEdge[],
          hopNodes: PropertyGraphNode[],
          visitedNodesInHop: Set<string>,
          hopWeight: number,
        ): void => {
          if (depth >= hop.minHops) {
            if (matchesNodeSpec(curr, hop.targetNode)) {
              const existingAliasNode = hop.targetNode.alias ? bindings[hop.targetNode.alias] : undefined;
              const aliasOk =
                !existingAliasNode ||
                ('id' in (existingAliasNode as PropertyGraphNode) &&
                  (existingAliasNode as PropertyGraphNode).id === curr.id);
              if (aliasOk) {
                const nextBindings = { ...bindings };
                if (hop.targetNode.alias) nextBindings[hop.targetNode.alias] = curr;
                if (hop.edgeAlias) {
                  nextBindings[hop.edgeAlias] =
                    hop.maxHops === 1 && hopEdges.length === 1 ? hopEdges[0]! : [...hopEdges];
                }
                expandHop(
                  hopIdx + 1,
                  curr,
                  nextBindings,
                  [...pathNodes, ...hopNodes],
                  [...pathEdges, ...hopEdges],
                  usedEdgeIds,
                  totalWeight + hopWeight,
                );
              }
            }
          }

          if (depth >= hop.maxHops) return;

          for (const { edge, neighborId } of incidentEdges(curr.id, hop.direction)) {
            if (usedEdgeIds.has(edge.id)) continue;
            if (hop.relLabels.length > 0 && !hop.relLabels.includes(edge.label)) continue;
            if (!matchesProps(edge.properties, hop.edgeProps)) continue;
            if (visitedNodesInHop.has(neighborId)) continue;
            const neighbor = nodes.get(neighborId);
            if (!neighbor) continue;

            usedEdgeIds.add(edge.id);
            visitedNodesInHop.add(neighborId);
            walkVarLen(
              neighbor,
              depth + 1,
              [...hopEdges, edge],
              [...hopNodes, neighbor],
              visitedNodesInHop,
              hopWeight + edge.weight,
            );
            visitedNodesInHop.delete(neighborId);
            usedEdgeIds.delete(edge.id);
          }
        };

        walkVarLen(currentNode, 0, [], [], new Set([currentNode.id]), 0);
      };

      for (const startNode of nodes.values()) {
        if (!matchesNodeSpec(startNode, parsed.start)) continue;
        const initBindings: Record<string, PropertyGraphNode | PropertyGraphEdge | readonly PropertyGraphEdge[]> = {};
        if (parsed.start.alias) initBindings[parsed.start.alias] = startNode;
        expandHop(0, startNode, initBindings, [startNode], [], new Set(), 0);
      }

      return results;
    },

    shortestPath(
      srcId: string,
      dstId: string,
      spOpts = {},
    ): PropertyGraphShortestPath | null {
      if (!nodes.has(srcId) || !nodes.has(dstId)) return null;
      if (srcId === dstId) {
        return { nodeIds: [srcId], edgeIds: [], labels: [], hops: 0, totalCost: 0 };
      }

      const dir = spOpts.direction ?? 'out';
      const maxHops = spOpts.maxHops ?? 32;
      const weighted = spOpts.weighted ?? Boolean(spOpts.weightProperty);
      const relSet = spOpts.relLabels ? new Set(spOpts.relLabels) : null;

      // Dijkstra (also covers unweighted BFS when edge cost = 1)
      const dist = new Map<string, number>([[srcId, 0]]);
      const hopsMap = new Map<string, number>([[srcId, 0]]);
      const prev = new Map<string, { prevNode: string; edge: PropertyGraphEdge }>();
      const visited = new Set<string>();

      while (visited.size < nodes.size) {
        let bestNode: string | null = null;
        let bestDist = Infinity;
        for (const [nid, d] of dist) {
          if (!visited.has(nid) && d < bestDist) {
            bestDist = d;
            bestNode = nid;
          }
        }
        if (bestNode === null) break;
        if (bestNode === dstId) break;
        visited.add(bestNode);

        const curHops = hopsMap.get(bestNode) ?? 0;
        if (curHops >= maxHops) continue;

        for (const { edge, neighborId } of incidentEdges(bestNode, dir)) {
          if (relSet && !relSet.has(edge.label)) continue;
          const stepCost = weighted
            ? spOpts.weightProperty
              ? Number(edge.properties[spOpts.weightProperty] ?? edge.weight)
              : Math.max(0, edge.weight)
            : 1;
          const cand = bestDist + stepCost;
          if (cand < (dist.get(neighborId) ?? Infinity)) {
            dist.set(neighborId, cand);
            hopsMap.set(neighborId, curHops + 1);
            prev.set(neighborId, { prevNode: bestNode, edge });
          }
        }
      }

      if (!dist.has(dstId)) return null;
      const nodeIds: string[] = [dstId];
      const edgeIds: string[] = [];
      const labels: string[] = [];
      let cur = dstId;
      while (cur !== srcId) {
        const step = prev.get(cur)!;
        edgeIds.unshift(step.edge.id);
        labels.unshift(step.edge.label);
        nodeIds.unshift(step.prevNode);
        cur = step.prevNode;
      }

      return {
        nodeIds,
        edgeIds,
        labels,
        hops: edgeIds.length,
        totalCost: dist.get(dstId)!,
      };
    },

    pageRank(prOpts = {}): Array<{ nodeId: string; score: number }> {
      const damping = prOpts.damping ?? 0.85;
      const iterations = prOpts.iterations ?? 25;
      const ids = [...nodes.keys()];
      const n = ids.length;
      if (n === 0) return [];

      let scores = new Map<string, number>();
      for (const id of ids) scores.set(id, 1 / n);

      for (let iter = 0; iter < iterations; iter++) {
        const next = new Map<string, number>();
        let sinkMass = 0;
        for (const id of ids) {
          next.set(id, (1 - damping) / n);
          const outs = outAdj.get(id);
          if (!outs || outs.size === 0) {
            sinkMass += scores.get(id)!;
          }
        }
        const sinkShare = (damping * sinkMass) / n;
        for (const id of ids) {
          next.set(id, next.get(id)! + sinkShare);
          const outs = outAdj.get(id);
          if (outs && outs.size > 0) {
            const share = (damping * scores.get(id)!) / outs.size;
            for (const eid of outs) {
              const e = edges.get(eid);
              if (e && next.has(e.dstId)) {
                next.set(e.dstId, next.get(e.dstId)! + share);
              }
            }
          }
        }
        scores = next;
      }

      return [...scores.entries()]
        .map(([nodeId, score]) => ({ nodeId, score }))
        .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
    },

    connectedComponents(): Array<{ componentId: number; nodeIds: string[]; size: number }> {
      const visited = new Set<string>();
      const comps: Array<{ componentId: number; nodeIds: string[]; size: number }> = [];
      let compSeq = 0;

      for (const startId of [...nodes.keys()].sort()) {
        if (visited.has(startId)) continue;
        const memberIds: string[] = [];
        const queue: string[] = [startId];
        visited.add(startId);
        while (queue.length > 0) {
          const cur = queue.shift()!;
          memberIds.push(cur);
          for (const { neighborId } of incidentEdges(cur, 'both')) {
            if (!visited.has(neighborId) && nodes.has(neighborId)) {
              visited.add(neighborId);
              queue.push(neighborId);
            }
          }
        }
        memberIds.sort();
        comps.push({
          componentId: ++compSeq,
          nodeIds: memberIds,
          size: memberIds.length,
        });
      }

      return comps.sort((a, b) => b.size - a.size || a.componentId - b.componentId);
    },

    summary(): PropertyGraphSummary {
      return {
        graphName,
        nodeCount: nodes.size,
        edgeCount: edges.size,
        updatedAtMs,
      };
    },
  };
}
