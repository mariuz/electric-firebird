/**
 * Hybrid Logical Clocks (HLC), Per-Column CRDT Merging, Row Filtering & Topological Ordering.
 */

import type {
  ColumnCrdtStrategy,
  CrdtMergeConfig,
  HlcTimestamp,
  HybridLogicalClock,
  HybridLogicalClockOptions,
  ReplicationConflictContext,
  ReplicationConflictResolution,
  ReplicationLogEntry,
} from './types';
import { normalizeRowKeysUpper, normalizeTableName } from './shared';

/**
 * 3-way field-level merge of `before`, `localRow`, and `remoteAfter`.
 */
export function mergeReplicatedRow(
  before: Record<string, unknown> | null,
  localRow: Record<string, unknown> | null,
  remoteAfter: Record<string, unknown> | null,
): Record<string, unknown> {
  const normBefore = before ? normalizeRowKeysUpper(before) : {};
  const normLocal = localRow ? normalizeRowKeysUpper(localRow) : {};
  const normRemote = remoteAfter ? normalizeRowKeysUpper(remoteAfter) : {};

  const allKeys = new Set<string>([
    ...Object.keys(normBefore),
    ...Object.keys(normLocal),
    ...Object.keys(normRemote),
  ]);

  const merged: Record<string, unknown> = { ...normLocal };
  for (const k of allKeys) {
    const bVal = normBefore[k];
    const rVal = normRemote[k];
    // If remote modified field k relative to before (or if before had no value), adopt remote's value
    if (JSON.stringify(rVal) !== JSON.stringify(bVal)) {
      if (rVal !== undefined) {
        merged[k] = rVal;
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Hybrid Logical Clock (HLC) & Per-Column CRDT Merge Helpers (M12 Item 6)
// ---------------------------------------------------------------------------

/**
 * Format an {@link HlcTimestamp} into a zero-padded `<wallMs>:<counter>:<nodeId>` string
 * whose lexicographical order matches causal order.
 */
export function formatHlc(ts: HlcTimestamp): string {
  const wall = String(Math.max(0, Math.trunc(ts.wallMs))).padStart(15, '0');
  const counter = String(Math.max(0, Math.trunc(ts.counter))).padStart(5, '0');
  return `${wall}:${counter}:${ts.nodeId}`;
}

/**
 * Parse a `<wallMs>:<counter>:<nodeId>` string (or return an existing `HlcTimestamp` object).
 */
export function parseHlc(raw: string | HlcTimestamp): HlcTimestamp {
  if (typeof raw !== 'string') {
    return {
      wallMs: Math.max(0, Math.trunc(raw.wallMs)),
      counter: Math.max(0, Math.trunc(raw.counter)),
      nodeId: raw.nodeId,
    };
  }
  const firstColon = raw.indexOf(':');
  const secondColon = firstColon >= 0 ? raw.indexOf(':', firstColon + 1) : -1;
  if (firstColon < 0 || secondColon < 0) {
    throw new Error(`Invalid HLC timestamp string: "${raw}"`);
  }
  const wallMs = Number.parseInt(raw.slice(0, firstColon), 10);
  const counter = Number.parseInt(raw.slice(firstColon + 1, secondColon), 10);
  const nodeId = raw.slice(secondColon + 1);
  if (Number.isNaN(wallMs) || Number.isNaN(counter)) {
    throw new Error(`Invalid numeric components in HLC timestamp: "${raw}"`);
  }
  return { wallMs, counter, nodeId };
}

/**
 * Compare two Hybrid Logical Clock timestamps (`< 0` if `a < b`, `0` if equal, `> 0` if `a > b`).
 */
export function compareHlc(
  a: string | HlcTimestamp,
  b: string | HlcTimestamp,
): number {
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (pa.wallMs !== pb.wallMs) {
    return pa.wallMs - pb.wallMs;
  }
  if (pa.counter !== pb.counter) {
    return pa.counter - pb.counter;
  }
  if (pa.nodeId === pb.nodeId) return 0;
  return pa.nodeId < pb.nodeId ? -1 : 1;
}

/**
 * Create a monotonic Hybrid Logical Clock (`<wallMs>:<counter>:<nodeId>`)
 * for skew-tolerant causal ordering across distributed primary/replica nodes.
 */
export function createHlc(
  nodeId: string,
  options: HybridLogicalClockOptions = {},
): HybridLogicalClock {
  const cleanNode = nodeId.trim() || 'node';
  const nowFn = options.now ?? Date.now;
  const maxDriftMs = options.maxDriftMs ?? 0;

  let lastWallMs = Math.max(0, Math.trunc(options.initialWallMs ?? 0));
  let lastCounter = Math.max(0, Math.trunc(options.initialCounter ?? 0));

  return {
    nodeId: cleanNode,

    now(wallNowMs?: number): string {
      const physicalNow = Math.max(0, Math.trunc(wallNowMs ?? nowFn()));
      if (physicalNow > lastWallMs) {
        lastWallMs = physicalNow;
        lastCounter = 0;
      } else {
        lastCounter += 1;
      }
      return formatHlc({
        wallMs: lastWallMs,
        counter: lastCounter,
        nodeId: cleanNode,
      });
    },

    receive(remote: string | HlcTimestamp, wallNowMs?: number): string {
      const physicalNow = Math.max(0, Math.trunc(wallNowMs ?? nowFn()));
      const rem = parseHlc(remote);

      if (maxDriftMs > 0 && rem.wallMs - physicalNow > maxDriftMs) {
        throw new Error(
          `Remote HLC timestamp (${rem.wallMs}) exceeds maximum allowed clock drift (${maxDriftMs}ms) from local physical clock (${physicalNow})`,
        );
      }

      if (physicalNow > lastWallMs && physicalNow > rem.wallMs) {
        lastWallMs = physicalNow;
        lastCounter = 0;
      } else if (lastWallMs === rem.wallMs) {
        lastCounter = Math.max(lastCounter, rem.counter) + 1;
      } else if (rem.wallMs > lastWallMs) {
        lastWallMs = rem.wallMs;
        lastCounter = rem.counter + 1;
      } else {
        lastCounter += 1;
      }

      return formatHlc({
        wallMs: lastWallMs,
        counter: lastCounter,
        nodeId: cleanNode,
      });
    },

    last(): HlcTimestamp {
      return {
        wallMs: lastWallMs,
        counter: lastCounter,
        nodeId: cleanNode,
      };
    },

    compare: compareHlc,
  };
}

function parseSetElements(val: unknown): {
  kind: 'array' | 'json' | 'csv';
  items: unknown[];
} {
  if (Array.isArray(val)) {
    return { kind: 'array', items: [...val] };
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return { kind: 'json', items: parsed };
        }
      } catch {
        // Fall through to CSV
      }
    }
    if (!trimmed) {
      return { kind: 'csv', items: [] };
    }
    return {
      kind: 'csv',
      items: trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    };
  }
  if (val === null || val === undefined) {
    return { kind: 'json', items: [] };
  }
  return { kind: 'array', items: [val] };
}

function formatSetElements(
  kind: 'array' | 'json' | 'csv',
  items: readonly unknown[],
): unknown {
  if (kind === 'array') return [...items];
  if (kind === 'csv') return items.map(String).join(',');
  return JSON.stringify(items);
}

/**
 * Per-column CRDT conflict merger supporting:
 * - `'lww'`: Last-Write-Wins Element-Set ordered by HLC (`compareHlc`) or `(timestamp, origin)`.
 * - `'pn-counter'` / `'counter'`: Additive numeric counter deltas (`base + (local - base) + (remote - base)`).
 * - `'set-union'` / `'g-set'`: Set union with 2P/OR-Set add/remove delta semantics when `before` is available.
 * - `'max'` / `'min'`: Join-semilattice maximum or minimum value.
 */
export function mergeCrdtRow(
  ctx: ReplicationConflictContext,
  config: CrdtMergeConfig = {},
): Record<string, unknown> {
  const normBefore = ctx.incoming.before ? normalizeRowKeysUpper(ctx.incoming.before) : {};
  const normLocal = ctx.localRow ? normalizeRowKeysUpper(ctx.localRow) : {};
  const normRemote = ctx.incoming.after ? normalizeRowKeysUpper(ctx.incoming.after) : {};

  const strategyByCol = new Map<string, ColumnCrdtStrategy>();
  if (config.columns) {
    for (const [col, strat] of Object.entries(config.columns)) {
      strategyByCol.set(col.toUpperCase(), strat);
    }
  }
  const defaultStrategy: ColumnCrdtStrategy = config.defaultStrategy ?? 'lww';

  const remoteHlc =
    ctx.incoming.hlc ??
    formatHlc({
      wallMs: ctx.incoming.timestamp,
      counter: 0,
      nodeId: ctx.incoming.origin,
    });
  const localHlc =
    ctx.localEntry?.hlc ??
    formatHlc({
      wallMs: ctx.localEntry?.timestamp ?? 0,
      counter: 0,
      nodeId: ctx.localEntry?.origin ?? '',
    });
  const remoteIsNewerOrEqual = compareHlc(remoteHlc, localHlc) >= 0;

  const allKeys = new Set<string>([
    ...Object.keys(normBefore),
    ...Object.keys(normLocal),
    ...Object.keys(normRemote),
  ]);

  const merged: Record<string, unknown> = { ...normLocal };

  for (const col of allKeys) {
    const strat = strategyByCol.get(col) ?? defaultStrategy;
    const bVal = normBefore[col];
    const lVal = normLocal[col];
    const rVal = normRemote[col];

    switch (strat) {
      case 'pn-counter':
      case 'counter': {
        const baseNum = Number(bVal ?? 0);
        const localNum = Number(lVal ?? baseNum);
        const remoteNum = Number(rVal ?? baseNum);
        const localDelta = localNum - baseNum;
        const remoteDelta = remoteNum - baseNum;
        merged[col] = baseNum + localDelta + remoteDelta;
        break;
      }

      case 'set-union':
      case 'g-set': {
        const bSet = parseSetElements(bVal);
        const lSet = parseSetElements(lVal);
        const rSet = parseSetElements(rVal);
        const outKind =
          lVal !== undefined ? lSet.kind : rVal !== undefined ? rSet.kind : bSet.kind;

        if (strat === 'g-set' || bVal === undefined) {
          const seen = new Set<string>();
          const unioned: unknown[] = [];
          for (const item of [...lSet.items, ...rSet.items]) {
            const key = JSON.stringify(item);
            if (!seen.has(key)) {
              seen.add(key);
              unioned.push(item);
            }
          }
          merged[col] = formatSetElements(outKind, unioned);
        } else {
          // 2P / OR-Set delta: keep items present in both or added by either side,
          // and drop items that were in `before` and removed by one side without change on the other
          const bKeys = new Set(bSet.items.map((x) => JSON.stringify(x)));
          const lKeys = new Set(lSet.items.map((x) => JSON.stringify(x)));
          const rKeys = new Set(rSet.items.map((x) => JSON.stringify(x)));

          const seen = new Set<string>();
          const result: unknown[] = [];
          for (const item of [...lSet.items, ...rSet.items]) {
            const k = JSON.stringify(item);
            if (seen.has(k)) continue;
            const wasInBefore = bKeys.has(k);
            const removedByLocal = wasInBefore && !lKeys.has(k);
            const removedByRemote = wasInBefore && !rKeys.has(k);
            if (removedByLocal || removedByRemote) {
              continue;
            }
            seen.add(k);
            result.push(item);
          }
          merged[col] = formatSetElements(outKind, result);
        }
        break;
      }

      case 'max': {
        if (typeof lVal === 'number' && typeof rVal === 'number') {
          merged[col] = Math.max(lVal, rVal);
        } else if (lVal === undefined || lVal === null) {
          merged[col] = rVal;
        } else if (rVal === undefined || rVal === null) {
          merged[col] = lVal;
        } else {
          merged[col] = String(rVal) >= String(lVal) ? rVal : lVal;
        }
        break;
      }

      case 'min': {
        if (typeof lVal === 'number' && typeof rVal === 'number') {
          merged[col] = Math.min(lVal, rVal);
        } else if (lVal === undefined || lVal === null) {
          merged[col] = rVal;
        } else if (rVal === undefined || rVal === null) {
          merged[col] = lVal;
        } else {
          merged[col] = String(rVal) <= String(lVal) ? rVal : lVal;
        }
        break;
      }

      case 'lww':
      default: {
        const remoteChanged = JSON.stringify(rVal) !== JSON.stringify(bVal);
        const localChanged =
          bVal !== undefined && JSON.stringify(lVal) !== JSON.stringify(bVal);

        if (remoteChanged && !localChanged) {
          if (rVal !== undefined) merged[col] = rVal;
        } else if (!remoteChanged && localChanged) {
          merged[col] = lVal;
        } else if (remoteChanged && localChanged) {
          merged[col] = remoteIsNewerOrEqual && rVal !== undefined ? rVal : lVal;
        } else if (remoteIsNewerOrEqual && rVal !== undefined) {
          merged[col] = rVal;
        }
        break;
      }
    }
  }

  return merged;
}

/**
 * Create a pluggable conflict resolver callback for `onConflict` in
 * {@link createSubscription} or {@link replicateDatabases} backed by {@link mergeCrdtRow}.
 */
export function createCrdtConflictResolver(
  config: CrdtMergeConfig = {},
): (ctx: ReplicationConflictContext) => ReplicationConflictResolution {
  return (ctx: ReplicationConflictContext): ReplicationConflictResolution => ({
    action: 'merge',
    row: mergeCrdtRow(ctx, config),
  });
}

/**
 * Project a replicated row according to optional `columns` whitelist and
 * `excludeColumns` blacklist while always preserving `pkCols`.
 */
export function projectReplicatedRow(
  row: Record<string, unknown> | null,
  pkCols: readonly string[],
  columns?: readonly string[],
  excludeColumns?: readonly string[],
): Record<string, unknown> | null {
  if (!row) return null;
  const norm = normalizeRowKeysUpper(row);
  if ((!columns || columns.length === 0) && (!excludeColumns || excludeColumns.length === 0)) {
    return norm;
  }

  const pkSet = new Set(pkCols.map((c) => c.toUpperCase()));
  const allowSet =
    columns && columns.length > 0
      ? new Set([...pkSet, ...columns.map((c) => c.toUpperCase())])
      : null;
  const excludeSet =
    excludeColumns && excludeColumns.length > 0
      ? new Set(excludeColumns.map((c) => c.toUpperCase()))
      : null;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(norm)) {
    if (pkSet.has(k)) {
      out[k] = v;
      continue;
    }
    if (excludeSet && excludeSet.has(k)) {
      continue;
    }
    if (allowSet && !allowSet.has(k)) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function parseSqlLiteralValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (/^null$/i.test(trimmed)) return null;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function evaluateSingleSqlPredicate(row: Record<string, unknown>, expr: string): boolean {
  const clean = expr.trim().replace(/^\(+|\)+$/g, '').trim();
  if (!clean) return true;

  const isNotNullMatch = /^([A-Za-z0-9_$"]+)\s+IS\s+NOT\s+NULL$/i.exec(clean);
  if (isNotNullMatch) {
    const col = isNotNullMatch[1]!.replace(/"/g, '').toUpperCase();
    return row[col] !== null && row[col] !== undefined;
  }

  const isNullMatch = /^([A-Za-z0-9_$"]+)\s+IS\s+NULL$/i.exec(clean);
  if (isNullMatch) {
    const col = isNullMatch[1]!.replace(/"/g, '').toUpperCase();
    return row[col] === null || row[col] === undefined;
  }

  const inMatch = /^([A-Za-z0-9_$"]+)\s+IN\s*\(([^)]+)\)$/i.exec(clean);
  if (inMatch) {
    const col = inMatch[1]!.replace(/"/g, '').toUpperCase();
    const candidates = inMatch[2]!.split(',').map(parseSqlLiteralValue);
    return candidates.some((c) => row[col] === c || String(row[col]) === String(c));
  }

  const cmpMatch = /^([A-Za-z0-9_$"]+)\s*(!=|<>|<=|>=|=|<|>)\s*(.+)$/.exec(clean);
  if (cmpMatch) {
    const col = cmpMatch[1]!.replace(/"/g, '').toUpperCase();
    const op = cmpMatch[2]!;
    const rhs = parseSqlLiteralValue(cmpMatch[3]!);
    const lhs = row[col];

    switch (op) {
      case '=':
        return lhs === rhs || (lhs !== null && lhs !== undefined && String(lhs) === String(rhs));
      case '!=':
      case '<>':
        return lhs !== rhs && String(lhs) !== String(rhs);
      case '<':
        return Number(lhs) < Number(rhs);
      case '<=':
        return Number(lhs) <= Number(rhs);
      case '>':
        return Number(lhs) > Number(rhs);
      case '>=':
        return Number(lhs) >= Number(rhs);
    }
  }

  return true;
}

/**
 * Evaluate whether `row` satisfies a table's row filter (`where` callback or SQL `WHERE` predicate).
 */
export function matchesRowFilter(
  row: Record<string, unknown> | null,
  where?: string | ((row: Record<string, unknown>) => boolean),
): boolean {
  if (!where) return true;
  if (!row) return false;
  const norm = normalizeRowKeysUpper(row);
  if (typeof where === 'function') {
    return Boolean(where(norm));
  }
  const orParts = where.split(/\s+OR\s+/i);
  return orParts.some((orBranch) => {
    const andParts = orBranch.split(/\s+AND\s+/i);
    return andParts.every((atom) => evaluateSingleSqlPredicate(norm, atom));
  });
}

/**
 * Group replication journal entries by transaction (`txid`) while preserving
 * commit order across transactions, and topologically order entries within each
 * transaction according to foreign-key `dependencies` (`childTable -> [parentTables]`):
 * - `'INSERT'` and `'UPDATE'` entries run **parent tables before child tables**.
 * - `'DELETE'` entries run **child tables before parent tables**.
 */
export function orderEntriesByTopology(
  entries: readonly ReplicationLogEntry[],
  dependencies?: Readonly<Record<string, readonly string[]>>,
): ReplicationLogEntry[] {
  if (entries.length <= 1 || !dependencies || Object.keys(dependencies).length === 0) {
    return [...entries];
  }

  // Normalize dependency map: CHILD -> [PARENT1, PARENT2]
  const depMap = new Map<string, readonly string[]>();
  for (const [child, parents] of Object.entries(dependencies)) {
    depMap.set(
      normalizeTableName(child),
      parents.map((p) => normalizeTableName(p)),
    );
  }

  // Compute topological depth for each table (0 = root parent, higher = deeper child)
  const depthCache = new Map<string, number>();
  const getDepth = (table: string, visiting = new Set<string>()): number => {
    const upper = normalizeTableName(table);
    if (depthCache.has(upper)) return depthCache.get(upper)!;
    if (visiting.has(upper)) return 0; // cycle guard
    visiting.add(upper);
    const parents = depMap.get(upper) ?? [];
    let maxParentDepth = -1;
    for (const p of parents) {
      const d = getDepth(p, visiting);
      if (d > maxParentDepth) maxParentDepth = d;
    }
    visiting.delete(upper);
    const depth = maxParentDepth + 1;
    depthCache.set(upper, depth);
    return depth;
  };

  // Group contiguous or same-txid entries in order of first appearance
  const txGroups: ReplicationLogEntry[][] = [];
  const groupByTx = new Map<string, ReplicationLogEntry[]>();

  for (const entry of entries) {
    const txKey = entry.txid || `lsn_${entry.lsn}`;
    let group = groupByTx.get(txKey);
    if (!group) {
      group = [];
      groupByTx.set(txKey, group);
      txGroups.push(group);
    }
    group.push(entry);
  }

  const ordered: ReplicationLogEntry[] = [];
  for (const group of txGroups) {
    if (group.length <= 1) {
      ordered.push(...group);
      continue;
    }
    const indexed = group.map((item, idx) => ({ item, idx }));
    indexed.sort((a, b) => {
      // DDL always comes first within a transaction
      if (a.item.operation === 'DDL' && b.item.operation !== 'DDL') return -1;
      if (b.item.operation === 'DDL' && a.item.operation !== 'DDL') return 1;

      // Non-DELETE (INSERT/UPDATE) comes before DELETE so parent creations precede child cleanups
      const aIsDel = a.item.operation === 'DELETE';
      const bIsDel = b.item.operation === 'DELETE';
      if (aIsDel !== bIsDel) {
        return aIsDel ? 1 : -1;
      }

      const depthA = getDepth(a.item.table);
      const depthB = getDepth(b.item.table);
      if (depthA !== depthB) {
        // For DELETE: deeper child first (depthB - depthA); for INSERT/UPDATE: parent first (depthA - depthB)
        return aIsDel ? depthB - depthA : depthA - depthB;
      }
      return a.idx - b.idx;
    });
    for (const { item } of indexed) {
      ordered.push(item);
    }
  }

  return ordered;
}
