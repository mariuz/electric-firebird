/**
 * subscription-conflict.ts – Replication Conflict Strategy Evaluator (`M30 Item 5`).
 */

import type {
  ReplicationConflictContext,
  ReplicationConflictStrategy,
} from './types';
import { normalizeRowKeysUpper } from './shared';
import { compareHlc, mergeReplicatedRow } from './hlc-crdt';

export async function evaluateConflictResolution(
  strategy: ReplicationConflictStrategy,
  ctx: ReplicationConflictContext,
): Promise<{
  outcome: 'remote-wins' | 'local-wins' | 'merge';
  mergedRow?: Record<string, unknown>;
}> {
  if (typeof strategy === 'function') {
    const res = await strategy(ctx);
    if (res === 'remote-wins' || (typeof res === 'object' && res.action === 'remote-wins')) {
      return { outcome: 'remote-wins' };
    }
    if (res === 'local-wins' || (typeof res === 'object' && res.action === 'local-wins')) {
      return { outcome: 'local-wins' };
    }
    if (res === 'merge') {
      return {
        outcome: 'merge',
        mergedRow: mergeReplicatedRow(ctx.incoming.before, ctx.localRow, ctx.incoming.after),
      };
    }
    return {
      outcome: 'merge',
      mergedRow: normalizeRowKeysUpper(res.row),
    };
  }

  switch (strategy) {
    case 'remote-wins':
    case 'primary-wins':
      return { outcome: 'remote-wins' };
    case 'local-wins':
    case 'replica-wins':
      return { outcome: 'local-wins' };
    case 'last-write-wins': {
      if (ctx.incoming.hlc && ctx.localEntry?.hlc) {
        return compareHlc(ctx.incoming.hlc, ctx.localEntry.hlc) >= 0
          ? { outcome: 'remote-wins' }
          : { outcome: 'local-wins' };
      }
      const remoteTs = ctx.incoming.timestamp;
      const localTs = ctx.localEntry?.timestamp ?? 0;
      if (remoteTs > localTs) return { outcome: 'remote-wins' };
      if (remoteTs < localTs) return { outcome: 'local-wins' };
      return ctx.incoming.origin >= (ctx.localEntry?.origin ?? '')
        ? { outcome: 'remote-wins' }
        : { outcome: 'local-wins' };
    }
    case 'merge':
      return {
        outcome: 'merge',
        mergedRow: mergeReplicatedRow(ctx.incoming.before, ctx.localRow, ctx.incoming.after),
      };
  }
}
