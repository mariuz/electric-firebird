/**
 * Logical Replication Subscriptions (`createSubscription`) & Conflict Evaluation.
 */

import type { QueryParams, QueryResult, Row } from '../types';
import {
  validateValueWithSchema,
  type StandardSchemaV1,
} from '../schema-validation';
import {
  DEFAULT_REPL_DLQ_TABLE,
  DEFAULT_REPL_ROLE_CONTEXT_VAR,
  DEFAULT_REPL_SLOT_TTL_MS,
  DEFAULT_REPL_WATERMARK_TABLE,
  type CreateSubscriptionOptions,
  type ReplicationConflictContext,
  type ReplicationConflictStrategy,
  type ReplicationLogEntry,
  type ReplicationPublication,
  type ReplicationStats,
  type ReplicationSubscription,
  type SubscriptionPullResult,
  type ReplicableDatabase,
} from './types';
import {
  applyBatchedRowMutationsToTable,
  applyRowMutationToTable,
  execStatement,
  ensureTableSafe,
  normalizeRowKeysUpper,
  normalizeTableName,
  quoteIdent,
  rowsEqual,
  serializeKeyRecord,
} from './shared';
import {
  compareHlc,
  mergeReplicatedRow,
  orderEntriesByTopology,
} from './hlc-crdt';
import { classifyDdlStatement, resolveDdlConflict } from './ddl-guard';
import { createReplicationDlq } from './dlq-compaction';
import { bootstrapReplica, needsBootstrap } from './bootstrap';

async function evaluateConflictResolution(
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
        mergedRow: mergeReplicatedRow(
          ctx.incoming.before,
          ctx.localRow,
          ctx.incoming.after,
        ),
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
      // Deterministic tie-breaker on origin node ID
      return ctx.incoming.origin >= (ctx.localEntry?.origin ?? '')
        ? { outcome: 'remote-wins' }
        : { outcome: 'local-wins' };
    }
    case 'merge':
      return {
        outcome: 'merge',
        mergedRow: mergeReplicatedRow(
          ctx.incoming.before,
          ctx.localRow,
          ctx.incoming.after,
        ),
      };
  }
}


/**
 * Create a logical replication subscription on `targetDb`.
 */
export async function createSubscription(
  targetDb: ReplicableDatabase,
  options: CreateSubscriptionOptions,
): Promise<ReplicationSubscription> {
  const subName = (options.name ?? `sub_${options.publication.name}`).trim();
  const nodeId = (options.nodeId ?? `replica_${subName}`).trim();
  const slotName = (options.slotName ?? `slot_${subName}`).trim();
  const slotTtlMs = options.slotTtlMs ?? DEFAULT_REPL_SLOT_TTL_MS;
  const watermarkTable = quoteIdent(options.watermarkTable ?? DEFAULT_REPL_WATERMARK_TABLE);
  const batchSize = options.batchSize ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const conflictStrategy = options.onConflict ?? 'remote-wins';

  const fullPub =
    'registerSlot' in options.publication &&
    typeof options.publication.registerSlot === 'function'
      ? (options.publication as ReplicationPublication)
      : undefined;

  const ensureSubscriberTables = async (): Promise<void> => {
    await ensureTableSafe(
      targetDb,
      `CREATE TABLE ${watermarkTable} (
        SUB_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
        LAST_LSN BIGINT NOT NULL,
        UPDATED_AT BIGINT NOT NULL
      )`,
    );
  };

  await ensureSubscriberTables();

  let dlqManager = await createReplicationDlq(targetDb, {
    subscriptionName: subName,
    dlqTable: options.dlqTable ?? DEFAULT_REPL_DLQ_TABLE,
  });

  const normalizedTableSchemas = new Map<
    string,
    StandardSchemaV1<unknown, Record<string, unknown>>
  >();
  if (fullPub) {
    for (const [tbl, cfg] of fullPub.tables) {
      if (cfg.validateSchema) {
        normalizedTableSchemas.set(normalizeTableName(tbl), cfg.validateSchema);
      }
    }
  }
  if (options.tableSchemas) {
    for (const [tbl, schema] of Object.entries(options.tableSchemas)) {
      normalizedTableSchemas.set(normalizeTableName(tbl), schema);
    }
  }

  let cachedWatermark: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let isSyncing = false;
  let totalFetched = 0;
  let totalApplied = 0;
  let totalConflicts = 0;
  let bytesTransferred = 0;
  let lastSyncedAt: number | null = null;

  const notifyIndexHooks = async (
    tableUpper: string,
    op: 'INSERT' | 'UPDATE' | 'DELETE',
    key: Record<string, unknown>,
    after: Record<string, unknown> | null,
    before: Record<string, unknown> | null,
    entry: ReplicationLogEntry,
  ): Promise<void> => {
    if (options.indexHooks && options.indexHooks.length > 0) {
      for (const hook of options.indexHooks) {
        const hookTable = normalizeTableName(hook.table);
        if (hookTable !== '*' && hookTable !== tableUpper) continue;
        if (op === 'DELETE') {
          await hook.onDelete?.(key, before, entry);
        } else if (after) {
          await hook.onInsertOrUpdate?.(after, key, entry);
        }
      }
    }
    if (options.onRowApplied) {
      await options.onRowApplied(entry);
    }
  };

  const getWatermark = async (): Promise<number> => {
    let res: QueryResult<Row>;
    try {
      res = await targetDb.query<Row>(
        `SELECT LAST_LSN FROM ${watermarkTable} WHERE SUB_NAME = ?`,
        [subName],
      );
    } catch {
      await ensureSubscriberTables();
      dlqManager = await createReplicationDlq(targetDb, {
        subscriptionName: subName,
        dlqTable: options.dlqTable ?? DEFAULT_REPL_DLQ_TABLE,
      });
      return cachedWatermark ?? 0;
    }
    const row = res.rows[0];
    if (!row) {
      return cachedWatermark ?? 0;
    }
    const lsn = Number(row.LAST_LSN ?? row.last_lsn ?? 0);
    cachedWatermark = lsn;
    return lsn;
  };

  const setWatermark = async (lsn: number): Promise<void> => {
    cachedWatermark = lsn;
    const now = Date.now();
    let existing: QueryResult<Row>;
    try {
      existing = await targetDb.query<Row>(
        `SELECT SUB_NAME FROM ${watermarkTable} WHERE SUB_NAME = ?`,
        [subName],
      );
    } catch {
      await ensureSubscriberTables();
      dlqManager = await createReplicationDlq(targetDb, {
        subscriptionName: subName,
        dlqTable: options.dlqTable ?? DEFAULT_REPL_DLQ_TABLE,
      });
      existing = await targetDb.query<Row>(
        `SELECT SUB_NAME FROM ${watermarkTable} WHERE SUB_NAME = ?`,
        [subName],
      );
    }
    if (existing.rows.length > 0) {
      await execStatement(
        targetDb,
        `UPDATE ${watermarkTable} SET LAST_LSN = ?, UPDATED_AT = ? WHERE SUB_NAME = ?`,
        [lsn, now, subName],
      );
    } else {
      await execStatement(
        targetDb,
        `INSERT INTO ${watermarkTable} (SUB_NAME, LAST_LSN, UPDATED_AT) VALUES (?, ?, ?)`,
        [subName, lsn, now],
      );
    }
  };

  const applyChanges = async (
    entries: readonly ReplicationLogEntry[],
  ): Promise<SubscriptionPullResult> => {
    if (
      options.tenantGuard &&
      ('defaultTenantId' in options.tenantGuard
        ? (options.tenantGuard as { defaultTenantId?: unknown }).defaultTenantId !== undefined
        : true) &&
      entries.length > 0
    ) {
      options.tenantGuard.assertBatch(entries);
    }
    const previousLsn = await getWatermark();
    if (entries.length === 0) {
      return {
        fetchedCount: 0,
        appliedCount: 0,
        conflictCount: 0,
        previousLsn,
        currentLsn: previousLsn,
      };
    }

    let appliedCount = 0;
    let conflictCount = 0;
    let dlqCount = 0;
    let highestLsn = previousLsn;

    // Fetch any local journal entries if a bidirectional `localPublication` is attached
    const localEntriesByKey = new Map<string, ReplicationLogEntry>();
    if (options.localPublication) {
      const localChanges = await options.localPublication.fetchChangesSince(0);
      for (const le of localChanges) {
        if (le.origin === nodeId && le.operation !== 'DDL') {
          const pkCols = Object.keys(le.key);
          const k = `${le.table}:${serializeKeyRecord(le.key, pkCols)}`;
          localEntriesByKey.set(k, le);
        }
      }
    }

    const syncLocalMirror = (
      table: string,
      op: 'INSERT' | 'UPDATE' | 'DELETE',
      key: Record<string, unknown>,
      after: Record<string, unknown> | null,
    ) => {
      const internalPub = options.localPublication as
        | (ReplicationPublication & {
            _syncMirrorFromRemote?: (
              t: string,
              o: 'INSERT' | 'UPDATE' | 'DELETE',
              k: Record<string, unknown>,
              a: Record<string, unknown> | null,
            ) => void;
          })
        | undefined;
      internalPub?._syncMirrorFromRemote?.(table, op, key, after);
    };

    const runBatch = async (runner: {
      query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
      execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
      execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
      savepoint?<U>(name: string, fn: (sp: {
        query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
        execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
        exec?(sql: string, params?: QueryParams): Promise<unknown>;
        execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
      }) => Promise<U>): Promise<U>;
    }) => {
      const depMap: Record<string, readonly string[]> = {};
      if (fullPub) {
        for (const t of fullPub.tables.values()) {
          if (t.references && t.references.length > 0) {
            depMap[t.table] = t.references;
          }
        }
      }
      if (options.tableDependencies) {
        for (const [child, parents] of Object.entries(options.tableDependencies)) {
          depMap[normalizeTableName(child)] = parents.map(normalizeTableName);
        }
      }
      const orderedEntries = orderEntriesByTopology(entries, depMap);

      // Fast batched `UPDATE OR INSERT ... MATCHING` + `IBatch` (`execBatch`) path
      // when running conflict-free catch-up (`remote-wins`, no bidirectional local journal,
      // no per-row validator) against a real Firebird engine (`M18 Item 2`).
      const canFastBatchDml =
        typeof runner.execBatch === 'function' &&
        !options.localPublication &&
        conflictStrategy === 'remote-wins' &&
        !options.onConflictResolved &&
        !options.validateEntry;

      for (let idx = 0; idx < orderedEntries.length; idx++) {
        const entry = orderedEntries[idx]!;
        if (entry.lsn > highestLsn) {
          highestLsn = entry.lsn;
        }
        // Skip changes that originated on this replica node
        if (entry.origin === nodeId) {
          continue;
        }
        if (entry.hlc) {
          (options.hlc ?? options.localPublication?.hlc)?.receive(entry.hlc);
        }

        if (canFastBatchDml && entry.operation !== 'DDL') {
          const runTable = normalizeTableName(entry.table);
          const runPkCols =
            Object.keys(entry.key).length > 0
              ? Object.keys(entry.key).map((k) => k.toUpperCase())
              : ['ID'];
          const runPkSig = runPkCols.join('\0');
          const runIsDelete = entry.operation === 'DELETE';

          interface PreparedBatchItem {
            effectiveEntry: ReplicationLogEntry;
            normKey: Record<string, unknown>;
          }
          const runItems: PreparedBatchItem[] = [];

          let scanIdx = idx;
          while (scanIdx < orderedEntries.length) {
            const cand = orderedEntries[scanIdx]!;
            if (cand.operation === 'DDL') break;
            if (cand.origin === nodeId) {
              if (cand.lsn > highestLsn) highestLsn = cand.lsn;
              scanIdx++;
              continue;
            }
            const candTable = normalizeTableName(cand.table);
            const candPkCols =
              Object.keys(cand.key).length > 0
                ? Object.keys(cand.key).map((k) => k.toUpperCase())
                : ['ID'];
            const candIsDelete = cand.operation === 'DELETE';
            if (
              candTable !== runTable ||
              candPkCols.join('\0') !== runPkSig ||
              candIsDelete !== runIsDelete
            ) {
              break;
            }
            if (cand.lsn > highestLsn) highestLsn = cand.lsn;
            if (cand.hlc) {
              (options.hlc ?? options.localPublication?.hlc)?.receive(cand.hlc);
            }
            const candNormKey = normalizeRowKeysUpper(cand.key);
            let eff = cand;
            if (options.transformRow && cand.operation !== 'DELETE' && cand.after) {
              const transformed = await options.transformRow(cand.after, {
                table: runTable,
                operation: cand.operation,
                key: candNormKey,
                origin: cand.origin,
              });
              if (!transformed) {
                scanIdx++;
                continue;
              }
              eff = { ...cand, after: transformed };
            }
            const tableSchema = normalizedTableSchemas.get(runTable);
            if (tableSchema && !candIsDelete && eff.after) {
              try {
                const validated = await validateValueWithSchema(
                  tableSchema,
                  eff.after,
                  { tableName: runTable },
                );
                eff = { ...eff, after: normalizeRowKeysUpper(validated as Record<string, unknown>) };
              } catch (schemaErr) {
                const errorObj =
                  schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr));
                const policy = options.onApplyError ?? 'throw';
                const action =
                  typeof policy === 'function'
                    ? await policy(eff, errorObj)
                    : policy;
                if (action === 'dlq') {
                  await dlqManager.recordFailure(eff, errorObj, subName);
                  dlqCount++;
                  scanIdx++;
                  continue;
                }
                if (action === 'skip') {
                  scanIdx++;
                  continue;
                }
                throw errorObj;
              }
            }
            runItems.push({ effectiveEntry: eff, normKey: candNormKey });
            scanIdx++;
          }

          idx = scanIdx - 1;
          if (runItems.length === 0) {
            continue;
          }

          const batchOp: 'INSERT' | 'DELETE' = runIsDelete ? 'DELETE' : 'INSERT';
          const batchPayload = runItems.map((it) => ({
            key: it.normKey,
            rowValues: it.effectiveEntry.after,
          }));

          let batchSucceeded = false;
          try {
            if (typeof runner.savepoint === 'function' && (options.onApplyError ?? 'throw') !== 'throw') {
              await runner.savepoint('sp_repl_batch', async (sp) => {
                await applyBatchedRowMutationsToTable(
                  sp,
                  runTable,
                  runPkCols,
                  batchOp,
                  batchPayload,
                );
              });
            } else {
              await applyBatchedRowMutationsToTable(
                runner,
                runTable,
                runPkCols,
                batchOp,
                batchPayload,
              );
            }
            batchSucceeded = true;
          } catch (batchErr) {
            if ((options.onApplyError ?? 'throw') === 'throw' && runItems.length === 1) {
              throw batchErr instanceof Error ? batchErr : new Error(String(batchErr));
            }
            // Fall back to row-by-row isolation so `onApplyError: 'dlq' | 'skip'`
            // quarantines only the failing poison row(s).
            for (const item of runItems) {
              const effEntry = item.effectiveEntry;
              const dmlOp = effEntry.operation as 'INSERT' | 'UPDATE' | 'DELETE';
              try {
                if (typeof runner.savepoint === 'function') {
                  await runner.savepoint('sp_repl_row', async (sp) => {
                    await applyRowMutationToTable(
                      sp,
                      runTable,
                      runPkCols,
                      dmlOp,
                      item.normKey,
                      effEntry.after,
                    );
                  });
                } else {
                  await applyRowMutationToTable(
                    runner,
                    runTable,
                    runPkCols,
                    dmlOp,
                    item.normKey,
                    effEntry.after,
                  );
                }
                syncLocalMirror(runTable, dmlOp, item.normKey, effEntry.after);
                await notifyIndexHooks(
                  runTable,
                  dmlOp,
                  item.normKey,
                  effEntry.after
                    ? normalizeRowKeysUpper({ ...effEntry.after, ...item.normKey })
                    : null,
                  effEntry.before,
                  effEntry,
                );
                appliedCount++;
              } catch (rowErr) {
                const errorObj = rowErr instanceof Error ? rowErr : new Error(String(rowErr));
                const policy = options.onApplyError ?? 'throw';
                const action =
                  typeof policy === 'function'
                    ? await policy(effEntry, errorObj)
                    : policy;
                if (action === 'dlq') {
                  await dlqManager.recordFailure(effEntry, errorObj, subName);
                  dlqCount++;
                } else if (action !== 'skip') {
                  throw errorObj;
                }
              }
            }
          }

          if (batchSucceeded) {
            for (const item of runItems) {
              const effEntry = item.effectiveEntry;
              const dmlOp = effEntry.operation as 'INSERT' | 'UPDATE' | 'DELETE';
              syncLocalMirror(runTable, dmlOp, item.normKey, effEntry.after);
              await notifyIndexHooks(
                runTable,
                dmlOp,
                item.normKey,
                effEntry.after
                  ? normalizeRowKeysUpper({ ...effEntry.after, ...item.normKey })
                  : null,
                effEntry.before,
                effEntry,
              );
              appliedCount++;
            }
          }
          continue;
        }

        if (entry.operation === 'DDL') {
          if (entry.ddlSql) {
            const ddlPolicy = options.ddlPolicy ?? 'apply';
            const handleDdlFailure = async (err: unknown): Promise<boolean> => {
              const errorObj = err instanceof Error ? err : new Error(String(err));
              const policy = options.onApplyError ?? 'throw';
              const action =
                typeof policy === 'function' ? await policy(entry, errorObj) : policy;
              if (action === 'dlq') {
                await dlqManager.recordFailure(entry, errorObj, subName);
                dlqCount++;
                return true;
              }
              if (action === 'skip') {
                return true;
              }
              throw errorObj;
            };

            if (ddlPolicy !== 'apply') {
              const classified = classifyDdlStatement(entry.ddlSql);
              let existingCols: string[] = [];
              let tableExists = false;
              if (classified.table) {
                try {
                  const colRes = await runner.query<Row>(
                    `SELECT TRIM(RDB$FIELD_NAME) AS COL_NAME FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ?`,
                    [classified.table],
                  );
                  existingCols = colRes.rows
                    .map((r) => String(r.COL_NAME ?? r.col_name ?? '').trim().toUpperCase())
                    .filter(Boolean);
                  tableExists = existingCols.length > 0;
                } catch {
                  // Fallback: probe via SELECT
                }
                if (!tableExists) {
                  try {
                    const probe = await runner.query<Row>(
                      `SELECT * FROM ${quoteIdent(classified.table)}`,
                    );
                    if (probe.fields && probe.fields.length > 0) {
                      tableExists = true;
                      existingCols = probe.fields.map((f) => f.name.toUpperCase());
                    } else if (probe.rows.length > 0 && probe.rows[0]) {
                      tableExists = true;
                      existingCols = Object.keys(probe.rows[0]).map((c) => c.toUpperCase());
                    }
                  } catch {
                    tableExists = false;
                  }
                }
              }

              const resolution = resolveDdlConflict(entry.ddlSql, existingCols, {
                policy: ddlPolicy,
                tableExists,
              });
              if (resolution.action === 'skip') {
                continue;
              }
              if (resolution.action === 'reject') {
                const handled = await handleDdlFailure(new Error(resolution.reason));
                if (handled) continue;
              }
              try {
                await execStatement(runner, resolution.sql ?? entry.ddlSql);
                appliedCount++;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (
                  /already exists|duplicate|unsuccessful metadata update/i.test(msg)
                ) {
                  continue;
                }
                const handled = await handleDdlFailure(err);
                if (handled) continue;
              }
            } else {
              try {
                await execStatement(runner, entry.ddlSql);
                appliedCount++;
              } catch (err) {
                const handled = await handleDdlFailure(err);
                if (handled) continue;
              }
            }
          }
          continue;
        }

        const tableUpper = normalizeTableName(entry.table);
        const pkCols =
          Object.keys(entry.key).length > 0
            ? Object.keys(entry.key).map((k) => k.toUpperCase())
            : ['ID'];
        const normKey = normalizeRowKeysUpper(entry.key);

        let effectiveEntry = entry;
        if (options.transformRow && entry.operation !== 'DELETE' && entry.after) {
          const transformedAfter = await options.transformRow(entry.after, {
            table: tableUpper,
            operation: entry.operation,
            key: normKey,
            origin: entry.origin,
          });
          if (!transformedAfter) {
            continue;
          }
          effectiveEntry = { ...entry, after: transformedAfter };
        }

        const handleEntryFailure = async (err: unknown): Promise<boolean> => {
          const errorObj = err instanceof Error ? err : new Error(String(err));
          const policy = options.onApplyError ?? 'throw';
          const action =
            typeof policy === 'function'
              ? await policy(effectiveEntry, errorObj)
              : policy;
          if (action === 'dlq') {
            await dlqManager.recordFailure(effectiveEntry, errorObj, subName);
            dlqCount++;
            return true;
          }
          if (action === 'skip') {
            return true;
          }
          throw errorObj;
        };

        const singleTableSchema = normalizedTableSchemas.get(tableUpper);
        if (singleTableSchema && effectiveEntry.operation !== 'DELETE' && effectiveEntry.after) {
          try {
            const validated = await validateValueWithSchema(
              singleTableSchema,
              effectiveEntry.after,
              { tableName: tableUpper },
            );
            effectiveEntry = {
              ...effectiveEntry,
              after: normalizeRowKeysUpper(validated as Record<string, unknown>),
            };
          } catch (schemaErr) {
            const handled = await handleEntryFailure(schemaErr);
            if (handled) continue;
          }
        }

        if (options.validateEntry) {
          try {
            const valid = await options.validateEntry(effectiveEntry);
            if (valid === false) {
              throw new Error(
                `Replication entry LSN ${effectiveEntry.lsn} on ${tableUpper} rejected by validateEntry`,
              );
            }
          } catch (err) {
            const handled = await handleEntryFailure(err);
            if (handled) continue;
          }
        }

        const whereClause = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
        const whereParams = pkCols.map((c) => normKey[c]) as QueryParams;

        const existingRes = await runner.query<Row>(
          `SELECT * FROM ${quoteIdent(tableUpper)} WHERE ${whereClause}`,
          whereParams,
        );
        const localRow = existingRes.rows[0]
          ? normalizeRowKeysUpper(existingRes.rows[0])
          : null;

        // Detect conflict:
        // 1. Incoming INSERT, but row already exists locally with different values
        // 2. Incoming UPDATE/DELETE, and `entry.before` exists but differs from `localRow`
        const lookupKey = `${tableUpper}:${serializeKeyRecord(normKey, pkCols)}`;
        const localEntry = localEntriesByKey.get(lookupKey) ?? null;

        let isConflict = false;
        if (
          effectiveEntry.operation === 'INSERT' &&
          localRow &&
          effectiveEntry.after &&
          !rowsEqual(localRow, effectiveEntry.after)
        ) {
          isConflict = true;
        } else if (
          (effectiveEntry.operation === 'UPDATE' || effectiveEntry.operation === 'DELETE') &&
          effectiveEntry.before &&
          localRow &&
          !rowsEqual(localRow, effectiveEntry.before)
        ) {
          isConflict = true;
        } else if (localEntry && localEntry.timestamp >= effectiveEntry.timestamp) {
          isConflict = true;
        }

        try {
          if (isConflict) {
            conflictCount++;
            const ctx: ReplicationConflictContext = {
              incoming: effectiveEntry,
              localRow,
              localEntry,
            };
            const decision = await evaluateConflictResolution(conflictStrategy, ctx);
            options.onConflictResolved?.(ctx, decision.outcome);

            if (decision.outcome === 'local-wins') {
              continue;
            }
            if (decision.outcome === 'merge' && decision.mergedRow) {
              await applyRowMutationToTable(
                runner,
                tableUpper,
                pkCols,
                'UPDATE',
                normKey,
                decision.mergedRow,
              );
              syncLocalMirror(tableUpper, 'UPDATE', normKey, decision.mergedRow);
              await notifyIndexHooks(
                tableUpper,
                'UPDATE',
                normKey,
                decision.mergedRow,
                effectiveEntry.before,
                { ...effectiveEntry, operation: 'UPDATE', after: decision.mergedRow },
              );
              appliedCount++;
              continue;
            }
          }

          const dmlOp = effectiveEntry.operation as 'INSERT' | 'UPDATE' | 'DELETE';
          await applyRowMutationToTable(
            runner,
            tableUpper,
            pkCols,
            dmlOp,
            normKey,
            effectiveEntry.after,
          );
          syncLocalMirror(
            tableUpper,
            dmlOp,
            normKey,
            effectiveEntry.after,
          );
          await notifyIndexHooks(
            tableUpper,
            dmlOp,
            normKey,
            effectiveEntry.after
              ? normalizeRowKeysUpper({ ...effectiveEntry.after, ...normKey })
              : null,
            effectiveEntry.before,
            effectiveEntry,
          );
          appliedCount++;
        } catch (err) {
          await handleEntryFailure(err);
        }
      }
    };

    const setReplicaRoleContext = async (
      runner: {
        query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
      },
      role: 'REPLICA' | 'PRIMARY',
    ) => {
      try {
        await runner.query(
          `SELECT RDB$SET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}', '${role}') FROM RDB$DATABASE`,
        );
      } catch {
        // Ignore on test doubles that do not implement RDB$SET_CONTEXT
      }
    };

    if (typeof targetDb.transaction === 'function') {
      await targetDb.transaction(async (tx) => {
        await setReplicaRoleContext(tx, 'REPLICA');
        try {
          await runBatch(tx);
        } finally {
          await setReplicaRoleContext(tx, 'PRIMARY');
        }
      });
    } else {
      await setReplicaRoleContext(targetDb, 'REPLICA');
      try {
        await runBatch(targetDb);
      } finally {
        await setReplicaRoleContext(targetDb, 'PRIMARY');
      }
    }

    if (highestLsn > previousLsn) {
      await setWatermark(highestLsn);
      if (fullPub) {
        await fullPub.advanceSlot(slotName, highestLsn, {
          nodeId,
          ttlMs: slotTtlMs,
        });
        if (options.autoPrune) {
          await fullPub.pruneAcked();
        }
      }
    }

    totalFetched += entries.length;
    totalApplied += appliedCount;
    totalConflicts += conflictCount;
    for (const e of entries) {
      const approx = (e as ReplicationLogEntry & { _approxBytes?: number })._approxBytes;
      bytesTransferred += typeof approx === 'number' ? approx : JSON.stringify(e).length;
    }
    lastSyncedAt = Date.now();

    return {
      fetchedCount: entries.length,
      appliedCount,
      conflictCount,
      ...(dlqCount > 0 ? { dlqCount } : {}),
      previousLsn,
      currentLsn: highestLsn,
    };
  };

  if (fullPub) {
    const initialWmk = await getWatermark();
    await fullPub.registerSlot({
      slotName,
      nodeId,
      initialLsn: initialWmk,
      ttlMs: slotTtlMs,
    });
  }

  const subscriptionObj: ReplicationSubscription & {
    _localPublication?: ReplicationPublication;
  } = {
    name: subName,
    nodeId,
    slotName,
    _localPublication: options.localPublication,
    getWatermark,
    setWatermark,
    async heartbeat(hbOpts) {
      if (!fullPub) return null;
      return fullPub.heartbeatSlot(slotName, hbOpts);
    },
    listDlq: () => dlqManager.listEntries(subName),
    retryDlq: (retryOpts) => dlqManager.retryDlq(subscriptionObj, retryOpts),
    discardDlq: (lsn) => dlqManager.discardDlq(lsn, subName),
    async stats(): Promise<ReplicationStats> {
      const replicaWatermark = await getWatermark();
      const primaryLsn = fullPub ? await fullPub.currentLsn() : replicaWatermark;
      const lagEntries = Math.max(0, primaryLsn - replicaWatermark);
      let lagMs = 0;
      if (lagEntries > 0 && fullPub) {
        const pending = await fullPub.fetchChangesSince(replicaWatermark, {
          limit: 1,
          excludeOrigin: nodeId,
        });
        if (pending[0] && pending[0].timestamp > 0) {
          lagMs = Math.max(0, Date.now() - pending[0].timestamp);
        }
      }
      return {
        status: isSyncing ? 'syncing' : timer ? 'running' : 'idle',
        primaryLsn,
        replicaWatermark,
        lagEntries,
        lagMs,
        totalFetched,
        totalApplied,
        totalConflicts,
        bytesTransferred,
        lastSyncedAt,
      };
    },
    async pull(): Promise<SubscriptionPullResult> {
      isSyncing = true;
      try {
        let bootstrapped = false;
        if (options.autoBootstrap && fullPub) {
          const check = await needsBootstrap(fullPub, subscriptionObj);
          if (check.needed && check.reason === 'behind-retained-journal') {
            const prev = await getWatermark();
            const bootRes = await bootstrapReplica({
              targetDb,
              publication: fullPub,
              subscription: subscriptionObj,
            });
            bootstrapped = true;
            totalFetched += bootRes.rowsCopied;
            totalApplied += bootRes.rowsCopied;
            bytesTransferred += bootRes.bytesTransferred;
            lastSyncedAt = Date.now();
            if (bootRes.watermarkLsn >= (await fullPub.currentLsn())) {
              return {
                fetchedCount: bootRes.rowsCopied,
                appliedCount: bootRes.rowsCopied,
                conflictCount: 0,
                previousLsn: prev,
                currentLsn: bootRes.watermarkLsn,
                bootstrapped: true,
              };
            }
          }
        }

        const sinceLsn = await getWatermark();
        const entries = await options.publication.fetchChangesSince(sinceLsn, {
          limit: batchSize,
          excludeOrigin: nodeId,
        });
        const res = await applyChanges(entries);
        return bootstrapped ? { ...res, bootstrapped: true } : res;
      } finally {
        isSyncing = false;
      }
    },
    applyChanges,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void subscriptionObj.pull().catch(() => undefined);
      }, pollIntervalMs);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  return subscriptionObj;
}

