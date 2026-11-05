/**
 * plan-tree.ts – Firebird execution plan parser & flamegraph cost analyzer.
 *
 * Parses both:
 * 1. **Legacy Firebird `PLAN (...)` expressions**, e.g.:
 *    - `PLAN (USERS NATURAL)`
 *    - `PLAN (O INDEX (IDX_ORDERS_USER, IDX_ORDERS_DATE))`
 *    - `PLAN JOIN (U INDEX (PK_USERS), O INDEX (FK_ORDERS_USER))`
 *    - `PLAN SORT (MERGE (SORT (A NATURAL), SORT (B NATURAL)))`
 * 2. **Firebird 3.0+ / 5.0 explained indentation trees** (`isc_info_sql_explain_plan`), e.g.:
 *    ```
 *    Select Expression
 *        -> Filter
 *            -> Nested Loop Join (inner)
 *                -> Table "USERS" as "U" Access By ID
 *                    -> Bitmap
 *                        -> Index "PK_USERS" Unique Scan
 *                -> Filter
 *                    -> Table "ORDERS" as "O" Full Scan
 *    ```
 *
 * Produces a hierarchical {@link PlanTreeNode} tree annotated with operator
 * classifications (`accessMethod`, `tableName`, `alias`, `indexNames`,
 * `estimatedWeight`, `weightFraction`, `warnings`) and per-table I/O attribution
 * (`reads`, `writes`, `fetches`, `marks`) for rendering interactive trees and
 * horizontal flamegraphs inside `<firebird-repl>`.
 */

import type { MonitorStats, PageIoCounters } from '../types';

/** High-level operator classification in a Firebird query plan. */
export type PlanOperatorKind =
  | 'root'
  | 'select'
  | 'join'
  | 'sort'
  | 'merge'
  | 'filter'
  | 'aggregate'
  | 'union'
  | 'table-scan'
  | 'index-scan'
  | 'bitmap'
  | 'operation';

/** Table access strategy detected on a plan node. */
export type PlanAccessMethod =
  | 'NATURAL'
  | 'INDEX'
  | 'UNIQUE'
  | 'PRIMARY'
  | 'FIRST'
  | 'ORDER'
  | null;

/** Per-table page I/O statistics attributed to a plan node or table. */
export interface TableIoStats extends PageIoCounters {
  readonly tableName: string;
  /** Number of profiled queries referencing this table. */
  readonly queryCount: number;
  /** Total execution duration in milliseconds across queries touching this table. */
  readonly totalDurationMs: number;
  /** Share of total page I/O (`fetches + reads`) in `[0, 1]`. */
  readonly ioShare: number;
}

/** A single node in a parsed Firebird query execution plan tree. */
export interface PlanTreeNode {
  /** Unique node identifier within the tree (`'node-0'`, `'node-1'`, ...). */
  readonly id: string;
  /** Operator display label (e.g. `'JOIN'`, `'USERS (NATURAL)'`, `'Table "USERS" Full Scan'`). */
  readonly label: string;
  /** Raw source line or sub-expression from Firebird's plan output. */
  readonly rawText: string;
  /** Classified operator kind. */
  readonly kind: PlanOperatorKind;
  /** Access strategy when this node accesses a relation or index. */
  readonly accessMethod: PlanAccessMethod;
  /** Referenced SQL table/relation name (upper-case), if any. */
  readonly tableName: string | null;
  /** Optional query alias for the relation, if present. */
  readonly alias: string | null;
  /** Referenced index name(s), if any. */
  readonly indexNames: readonly string[];
  /** 0-based depth in the plan tree. */
  readonly depth: number;
  /** Heuristic relative cost weight (`>= 1`) used for flamegraph bar sizing. */
  readonly estimatedWeight: number;
  /** Normalized share of root weight in `[0, 1]` for flamegraph width rendering. */
  readonly weightFraction: number;
  /** Optional attributed table I/O stats when `MonitorStats` is provided. */
  readonly tableIo?: TableIoStats;
  /** Performance warnings (e.g. `'Full table scan (NATURAL)'`). */
  readonly warnings: readonly string[];
  /** Child execution steps. */
  readonly children: readonly PlanTreeNode[];
}

/** Summary of a parsed Firebird execution plan. */
export interface ParsedQueryPlan {
  /** Original raw plan string returned by `db.explain()`. */
  readonly raw: string;
  /** Format detected (`'legacy'` `PLAN (...)` or `'explained'` `->` tree). */
  readonly format: 'legacy' | 'explained' | 'empty';
  /** Root node of the execution plan tree. */
  readonly root: PlanTreeNode;
  /** Flat list of all nodes in pre-order traversal. */
  readonly nodes: readonly PlanTreeNode[];
  /** Distinct upper-case table names referenced across the plan. */
  readonly tables: readonly string[];
  /** Distinct upper-case index names referenced across the plan. */
  readonly indexes: readonly string[];
  /** Number of `NATURAL` / Full Scan table accesses in the plan. */
  readonly naturalScanCount: number;
  /** Number of index-backed accesses in the plan. */
  readonly indexScanCount: number;
}

// ---------------------------------------------------------------------------
// 1. Explained Plan (`->` Indentation Format) Parser
// ---------------------------------------------------------------------------

interface RawIndentedLine {
  indent: number;
  text: string;
}

function classifyExplainedLine(text: string): {
  kind: PlanOperatorKind;
  accessMethod: PlanAccessMethod;
  tableName: string | null;
  alias: string | null;
  indexNames: string[];
  selfWeight: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const indexNames: string[] = [];
  let tableName: string | null = null;
  let alias: string | null = null;
  let kind: PlanOperatorKind = 'operation';
  let accessMethod: PlanAccessMethod = null;
  let selfWeight = 1;

  // Match `Table "USERS" as "U" Full Scan` or `Table "USERS" Access By ID`
  const tableMatch =
    /\bTable\s+"([^"]+)"(?:\s+as\s+"([^"]+)")?\s*(.*)$/i.exec(text) ??
    /\bTable\s+([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?\s*(.*)$/i.exec(text);
  if (tableMatch) {
    tableName = tableMatch[1].toUpperCase();
    if (tableMatch[2]) alias = tableMatch[2].toUpperCase();
    const tail = (tableMatch[3] ?? '').trim();
    if (/Full\s+Scan|Natural/i.test(tail)) {
      kind = 'table-scan';
      accessMethod = 'NATURAL';
      selfWeight = 10;
      warnings.push(`Full table scan (NATURAL) on ${tableName}`);
    } else {
      kind = 'index-scan';
      accessMethod = 'INDEX';
      selfWeight = 3;
    }
    return { kind, accessMethod, tableName, alias, indexNames, selfWeight, warnings };
  }

  // Match `Index "IDX_USERS_EMAIL" Unique Scan` or `Index "IDX_1" Range Scan`
  const indexMatch =
    /\bIndex\s+"([^"]+)"\s*(.*)$/i.exec(text) ??
    /\bIndex\s+([A-Za-z0-9_$]+)\s*(.*)$/i.exec(text);
  if (indexMatch) {
    const idxName = indexMatch[1].toUpperCase();
    indexNames.push(idxName);
    const tail = (indexMatch[2] ?? '').trim();
    kind = 'index-scan';
    accessMethod = /Unique/i.test(tail) ? 'UNIQUE' : 'INDEX';
    selfWeight = accessMethod === 'UNIQUE' ? 1 : 2;
    return { kind, accessMethod, tableName, alias, indexNames, selfWeight, warnings };
  }

  if (/^Select\b/i.test(text)) {
    kind = 'select';
  } else if (/\bJoin\b/i.test(text)) {
    kind = 'join';
    selfWeight = 3;
  } else if (/\bSort\b|\bOrder\b/i.test(text)) {
    kind = 'sort';
    selfWeight = 4;
  } else if (/\bMerge\b/i.test(text)) {
    kind = 'merge';
    selfWeight = 3;
  } else if (/\bFilter\b/i.test(text)) {
    kind = 'filter';
    selfWeight = 1;
  } else if (/\bAggregate\b|\bGroup\b/i.test(text)) {
    kind = 'aggregate';
    selfWeight = 3;
  } else if (/\bUnion\b/i.test(text)) {
    kind = 'union';
    selfWeight = 2;
  } else if (/\bBitmap\b/i.test(text)) {
    kind = 'bitmap';
    selfWeight = 1;
  }

  return { kind, accessMethod, tableName, alias, indexNames, selfWeight, warnings };
}

// ---------------------------------------------------------------------------
// 2. Legacy `PLAN (...)` Expression Parser
// ---------------------------------------------------------------------------

interface LegacyAstNode {
  header: string;
  children: LegacyAstNode[];
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      const slice = input.slice(start, i).trim();
      if (slice) parts.push(slice);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function parseLegacyPlanExpr(expr: string): LegacyAstNode {
  const trimmed = expr.trim();
  const withoutPlanPrefix = trimmed.replace(/^PLAN\s+/i, '').trim();

  // Check if the expression is `<OPERATOR> (<inner>)` or `(<inner>)`
  const firstOpen = withoutPlanPrefix.indexOf('(');
  if (firstOpen === -1) {
    return { header: withoutPlanPrefix, children: [] };
  }

  const closeIdx = findMatchingParen(withoutPlanPrefix, firstOpen);
  const prefix = withoutPlanPrefix.slice(0, firstOpen).trim();
  const inside = withoutPlanPrefix.slice(firstOpen + 1, closeIdx).trim();
  const suffix = withoutPlanPrefix.slice(closeIdx + 1).trim();

  // If this is a leaf relation access like `O INDEX (IDX_1, IDX_2)` or `USERS ORDER IDX_U INDEX (IDX_2)`,
  // keep it as a single leaf node rather than splitting the index list into child operators.
  if (
    /\b(?:INDEX|ORDER|PRIMARY|KEY)\b/i.test(prefix) &&
    !/^(?:JOIN|SORT|MERGE|HASH|UNION)\b/i.test(prefix)
  ) {
    return { header: withoutPlanPrefix, children: [] };
  }

  if (suffix.length > 0) {
    return { header: withoutPlanPrefix, children: [] };
  }

  const commaParts = splitTopLevelCommas(inside);
  if (commaParts.length === 1 && prefix === '') {
    return parseLegacyPlanExpr(commaParts[0]);
  }

  return {
    header: prefix || 'PLAN',
    children: commaParts.map(parseLegacyPlanExpr),
  };
}

function classifyLegacyLeaf(header: string): {
  label: string;
  kind: PlanOperatorKind;
  accessMethod: PlanAccessMethod;
  tableName: string | null;
  alias: string | null;
  indexNames: string[];
  selfWeight: number;
  warnings: string[];
} {
  const text = header.trim();
  const warnings: string[] = [];
  const indexNames: string[] = [];

  // Extract index lists inside `INDEX (idx1, idx2)` or `ORDER idx1`
  const indexParenRegex = /\bINDEX\s*\(([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = indexParenRegex.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const clean = part.trim().replace(/^"+|"+$/g, '').toUpperCase();
      if (clean) indexNames.push(clean);
    }
  }
  const orderMatch = /\bORDER\s+([A-Za-z0-9_$"]+)/i.exec(text);
  if (orderMatch) {
    const clean = orderMatch[1].replace(/^"+|"+$/g, '').toUpperCase();
    if (clean && !indexNames.includes(clean)) {
      indexNames.push(clean);
    }
  }

  // Relation + optional alias before `NATURAL` / `INDEX` / `ORDER`
  const accessKeywordIdx = text.search(/\b(?:NATURAL|INDEX|ORDER)\b/i);
  let tableName: string | null = null;
  let alias: string | null = null;
  if (accessKeywordIdx > 0) {
    const relTokens = text
      .slice(0, accessKeywordIdx)
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^"+|"+$/g, '').toUpperCase())
      .filter(Boolean);
    if (relTokens.length === 1) {
      tableName = relTokens[0];
    } else if (relTokens.length >= 2) {
      tableName = relTokens[0];
      alias = relTokens[1];
    }
  }

  if (/\bNATURAL\b/i.test(text)) {
    const target = tableName ?? text;
    warnings.push(`Full table scan (NATURAL) on ${target}`);
    return {
      label: tableName
        ? `${tableName}${alias ? ` (${alias})` : ''} · NATURAL`
        : text,
      kind: 'table-scan',
      accessMethod: 'NATURAL',
      tableName,
      alias,
      indexNames,
      selfWeight: 10,
      warnings,
    };
  }

  if (indexNames.length > 0 || /\bINDEX\b|\bORDER\b/i.test(text)) {
    const method: PlanAccessMethod = /\bORDER\b/i.test(text) ? 'ORDER' : 'INDEX';
    return {
      label: tableName
        ? `${tableName}${alias ? ` (${alias})` : ''} · ${method} (${indexNames.join(', ')})`
        : text,
      kind: 'index-scan',
      accessMethod: method,
      tableName,
      alias,
      indexNames,
      selfWeight: 2,
      warnings,
    };
  }

  const upper = text.toUpperCase();
  if (upper === 'JOIN') {
    return {
      label: 'JOIN',
      kind: 'join',
      accessMethod: null,
      tableName: null,
      alias: null,
      indexNames: [],
      selfWeight: 2,
      warnings: [],
    };
  }
  if (upper === 'SORT') {
    return {
      label: 'SORT',
      kind: 'sort',
      accessMethod: null,
      tableName: null,
      alias: null,
      indexNames: [],
      selfWeight: 3,
      warnings: [],
    };
  }
  if (upper === 'MERGE' || upper === 'HASH') {
    return {
      label: upper,
      kind: 'merge',
      accessMethod: null,
      tableName: null,
      alias: null,
      indexNames: [],
      selfWeight: 3,
      warnings: [],
    };
  }

  return {
    label: text || 'PLAN',
    kind: text.toUpperCase() === 'PLAN' ? 'root' : 'operation',
    accessMethod: null,
    tableName,
    alias,
    indexNames,
    selfWeight: 1,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Per-Table Page I/O Attribution (`computeTableIoBreakdown`)
// ---------------------------------------------------------------------------

/**
 * Extract upper-case SQL table names referenced in a SQL statement.
 */
function extractTablesFromSql(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = (m[1] ?? m[2] ?? '').trim().toUpperCase();
    if (name && !name.startsWith('RDB$') && !name.startsWith('MON$')) {
      out.add(name);
    }
  }
  return [...out];
}

/**
 * Aggregate per-table page reads, writes, fetches, marks, and query durations
 * from a {@link MonitorStats} snapshot (`stats.recentQueries` + `stats.io`).
 */
export function computeTableIoBreakdown(
  stats: MonitorStats | null | undefined,
  knownTables: readonly string[] = [],
): Map<string, TableIoStats> {
  const accum = new Map<
    string,
    {
      reads: number;
      writes: number;
      fetches: number;
      marks: number;
      queryCount: number;
      totalDurationMs: number;
    }
  >();

  for (const t of knownTables) {
    const upper = t.toUpperCase();
    if (!accum.has(upper)) {
      accum.set(upper, {
        reads: 0,
        writes: 0,
        fetches: 0,
        marks: 0,
        queryCount: 0,
        totalDurationMs: 0,
      });
    }
  }

  if (stats?.recentQueries) {
    for (const q of stats.recentQueries) {
      const tables = extractTablesFromSql(q.sql);
      if (tables.length === 0) continue;
      const share = 1 / tables.length;
      for (const tbl of tables) {
        const cur = accum.get(tbl) ?? {
          reads: 0,
          writes: 0,
          fetches: 0,
          marks: 0,
          queryCount: 0,
          totalDurationMs: 0,
        };
        cur.queryCount += 1;
        cur.totalDurationMs += q.durationMs * share;
        if (q.io) {
          cur.reads += Math.round(q.io.reads * share);
          cur.writes += Math.round(q.io.writes * share);
          cur.fetches += Math.round(q.io.fetches * share);
          cur.marks += Math.round(q.io.marks * share);
        }
        accum.set(tbl, cur);
      }
    }
  }

  let totalIo = 0;
  for (const entry of accum.values()) {
    totalIo += entry.fetches + entry.reads + entry.writes + entry.marks;
  }

  const result = new Map<string, TableIoStats>();
  for (const [tableName, entry] of accum.entries()) {
    const nodeIo = entry.fetches + entry.reads + entry.writes + entry.marks;
    result.set(tableName, {
      tableName,
      reads: entry.reads,
      writes: entry.writes,
      fetches: entry.fetches,
      marks: entry.marks,
      queryCount: entry.queryCount,
      totalDurationMs: entry.totalDurationMs,
      ioShare: totalIo > 0 ? nodeIo / totalIo : 0,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. Unified `parseQueryPlan(planText, stats?)` Entry Point
// ---------------------------------------------------------------------------

interface MutablePlanNode {
  id: string;
  label: string;
  rawText: string;
  kind: PlanOperatorKind;
  accessMethod: PlanAccessMethod;
  tableName: string | null;
  alias: string | null;
  indexNames: string[];
  depth: number;
  selfWeight: number;
  estimatedWeight: number;
  weightFraction: number;
  tableIo?: TableIoStats;
  warnings: string[];
  children: MutablePlanNode[];
}

/**
 * Parse a Firebird `explain()` string (either legacy `PLAN (...)` or detailed
 * `->` explained tree) into a structured {@link ParsedQueryPlan} with cost
 * weights and optional per-table I/O attribution.
 */
export function parseQueryPlan(
  planText: string,
  stats?: MonitorStats | null,
): ParsedQueryPlan {
  const raw = (planText ?? '').trim();
  const tableIoMap = computeTableIoBreakdown(stats);
  let nodeCounter = 0;

  if (!raw) {
    const emptyRoot: PlanTreeNode = {
      id: 'node-0',
      label: '(empty plan)',
      rawText: '',
      kind: 'root',
      accessMethod: null,
      tableName: null,
      alias: null,
      indexNames: [],
      depth: 0,
      estimatedWeight: 1,
      weightFraction: 1,
      warnings: [],
      children: [],
    };
    return {
      raw: '',
      format: 'empty',
      root: emptyRoot,
      nodes: [emptyRoot],
      tables: [],
      indexes: [],
      naturalScanCount: 0,
      indexScanCount: 0,
    };
  }

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);

  const isExplained = lines.some((l) => /^\s*->\s+/.test(l) || /^Select\s+Expression/i.test(l.trim()));

  let mutableRoot: MutablePlanNode;

  if (isExplained) {
    const parsedLines: RawIndentedLine[] = lines.map((line) => {
      const arrowMatch = /^(\s*)->\s*(.+)$/.exec(line);
      if (arrowMatch) {
        return {
          indent: arrowMatch[1].length + 2,
          text: arrowMatch[2].trim(),
        };
      }
      const leadMatch = /^(\s*)(.+)$/.exec(line)!;
      return {
        indent: leadMatch[1].length,
        text: leadMatch[2].trim(),
      };
    });

    const buildExplainedNodes = (): MutablePlanNode => {
      const rootNode: MutablePlanNode = {
        id: `node-${nodeCounter++}`,
        label: 'Query Execution Plan',
        rawText: raw,
        kind: 'root',
        accessMethod: null,
        tableName: null,
        alias: null,
        indexNames: [],
        depth: 0,
        selfWeight: 0,
        estimatedWeight: 1,
        weightFraction: 1,
        warnings: [],
        children: [],
      };

      const stack: Array<{ indent: number; node: MutablePlanNode }> = [
        { indent: -1, node: rootNode },
      ];

      for (const item of parsedLines) {
        while (stack.length > 1 && stack[stack.length - 1]!.indent >= item.indent) {
          stack.pop();
        }
        const parent = stack[stack.length - 1]!.node;
        const info = classifyExplainedLine(item.text);
        const io = info.tableName ? tableIoMap.get(info.tableName) : undefined;
        const ioBoost = io ? Math.min(20, Math.round((io.fetches + io.reads * 4) / 10)) : 0;

        const child: MutablePlanNode = {
          id: `node-${nodeCounter++}`,
          label: item.text,
          rawText: item.text,
          kind: info.kind,
          accessMethod: info.accessMethod,
          tableName: info.tableName,
          alias: info.alias,
          indexNames: info.indexNames,
          depth: parent.depth + 1,
          selfWeight: info.selfWeight + ioBoost,
          estimatedWeight: info.selfWeight + ioBoost,
          weightFraction: 1,
          ...(io ? { tableIo: io } : {}),
          warnings: info.warnings,
          children: [],
        };
        parent.children.push(child);
        stack.push({ indent: item.indent, node: child });
      }

      if (rootNode.children.length === 1) {
        return rootNode.children[0]!;
      }
      return rootNode;
    };

    mutableRoot = buildExplainedNodes();
  } else {
    // Legacy `PLAN (...)` format (may span multiple `PLAN ...` lines)
    const astRoots = lines.map(parseLegacyPlanExpr);

    const convertAst = (ast: LegacyAstNode, depth: number): MutablePlanNode => {
      const info = classifyLegacyLeaf(ast.header);
      const io = info.tableName ? tableIoMap.get(info.tableName) : undefined;
      const ioBoost = io ? Math.min(20, Math.round((io.fetches + io.reads * 4) / 10)) : 0;
      const children = ast.children.map((c) => convertAst(c, depth + 1));

      return {
        id: `node-${nodeCounter++}`,
        label: info.label,
        rawText: ast.header,
        kind: info.kind,
        accessMethod: info.accessMethod,
        tableName: info.tableName,
        alias: info.alias,
        indexNames: info.indexNames,
        depth,
        selfWeight: info.selfWeight + ioBoost,
        estimatedWeight: info.selfWeight + ioBoost,
        weightFraction: 1,
        ...(io ? { tableIo: io } : {}),
        warnings: info.warnings,
        children,
      };
    };

    if (astRoots.length === 1) {
      mutableRoot = convertAst(astRoots[0]!, 0);
    } else {
      mutableRoot = {
        id: `node-${nodeCounter++}`,
        label: 'PLAN',
        rawText: raw,
        kind: 'root',
        accessMethod: null,
        tableName: null,
        alias: null,
        indexNames: [],
        depth: 0,
        selfWeight: 0,
        estimatedWeight: 1,
        weightFraction: 1,
        warnings: [],
        children: astRoots.map((r) => convertAst(r, 1)),
      };
    }
  }

  // Recompute depths, bottom-up weights, and normalized flamegraph fractions
  const computeWeights = (node: MutablePlanNode, depth: number): number => {
    node.depth = depth;
    if (node.children.length === 0) {
      node.estimatedWeight = Math.max(1, node.selfWeight);
      return node.estimatedWeight;
    }
    let childSum = 0;
    for (const c of node.children) {
      childSum += computeWeights(c, depth + 1);
    }
    node.estimatedWeight = Math.max(1, childSum + (node.kind === 'sort' ? 2 : 0));
    return node.estimatedWeight;
  };

  const totalWeight = computeWeights(mutableRoot, 0);

  const flatNodes: PlanTreeNode[] = [];
  const tableSet = new Set<string>();
  const indexSet = new Set<string>();
  let naturalScanCount = 0;
  let indexScanCount = 0;

  const assignFractions = (node: MutablePlanNode): PlanTreeNode => {
    node.weightFraction = totalWeight > 0 ? node.estimatedWeight / totalWeight : 1;
    if (node.tableName) tableSet.add(node.tableName);
    for (const idx of node.indexNames) indexSet.add(idx);
    if (node.accessMethod === 'NATURAL') naturalScanCount++;
    else if (node.accessMethod !== null) indexScanCount++;

    // Propagate child index names up to parent `Table "..." Access By ID` in explained plans
    if (
      isExplained &&
      node.tableName &&
      node.indexNames.length === 0 &&
      node.children.length > 0
    ) {
      const inherited: string[] = [];
      const collectChildIndexes = (n: MutablePlanNode) => {
        for (const ix of n.indexNames) {
          if (!inherited.includes(ix)) inherited.push(ix);
        }
        for (const ch of n.children) collectChildIndexes(ch);
      };
      collectChildIndexes(node);
      if (inherited.length > 0) {
        node.indexNames = inherited;
      }
    }

    flatNodes.push(node);
    for (const c of node.children) {
      assignFractions(c);
    }
    return node;
  };

  const root = assignFractions(mutableRoot);

  return {
    raw,
    format: isExplained ? 'explained' : 'legacy',
    root,
    nodes: flatNodes,
    tables: [...tableSet],
    indexes: [...indexSet],
    naturalScanCount,
    indexScanCount,
  };
}
