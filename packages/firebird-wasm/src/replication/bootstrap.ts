/**
 * Replica Snapshot Bootstrap (`needsBootstrap`, `bootstrapReplica`).
 */

import type { QueryParams, QueryResult, Row } from '../types';
import {
  DEFAULT_REPL_ROLE_CONTEXT_VAR,
  type BootstrapReplicaOptions,
  type BootstrapReplicaResult,
  type ReplicableDatabase,
  type ReplicationPublication,
  type ReplicationSubscription,
} from './types';
import {
  applyBatchedRowMutationsToTable,
  applyRowMutationToTable,
  ensureTableSafe,
  execStatement,
  extractKeyRecord,
  normalizeRowKeysUpper,
  normalizeTableName,
  quoteIdent,
} from './shared';
import { applyPageDiff } from '../browser/snapshots';

/** Drop any `FB_REPL_TRG*` capture triggers cloned onto a unidirectional replica `.fdb` image (`M20 Item 1`). */
export async function dropAllClonedReplicationTriggers(
  db: ReplicableDatabase,
): Promise<void> {
  try {
    const res = await db.query<Row>(
      `SELECT TRIM(RDB$TRIGGER_NAME) AS TRG FROM RDB$TRIGGERS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND TRIM(RDB$TRIGGER_NAME) STARTING WITH 'FB_REPL_TRG'`,
    );
    for (const r of res.rows) {
      const trg = String(r.TRG ?? r.trg ?? '').trim();
      if (trg) {
        await execStatement(db, `DROP TRIGGER ${quoteIdent(trg)}`).catch(() => undefined);
      }
    }
  } catch {
    // Ignore on lightweight mock databases without RDB$TRIGGERS
  }
}

/** Compress raw bytes with Web Streams `CompressionStream('gzip')` (`M20 Item 1`). */
export async function compressGzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    return input;
  }
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const writePromise = writer
    .write(new Uint8Array(input.buffer, input.byteOffset, input.byteLength) as unknown as BufferSource)
    .then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writePromise;
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Decompress gzip-compressed bytes with Web Streams `DecompressionStream('gzip')` (`M20 Item 1`). */
export async function decompressGzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (input.byteLength < 2 || input[0] !== 0x1f || input[1] !== 0x8b) {
    return input;
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream("gzip") is not available in this runtime');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const writePromise = writer
    .write(new Uint8Array(input.buffer, input.byteOffset, input.byteLength) as unknown as BufferSource)
    .then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writePromise;
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function* singleChunkStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Check whether a replica subscription needs an initial or catch-up snapshot
 * bootstrap (either because `watermark === 0` while the publication already has
 * changes, or because `watermark < minRetainedLsn - 1` after journal pruning).
 */
export async function needsBootstrap(
  publication: ReplicationPublication,
  subscription: ReplicationSubscription,
): Promise<{
  readonly needed: boolean;
  readonly reason: 'uninitialized' | 'behind-retained-journal' | 'up-to-date';
  readonly replicaWatermark: number;
  readonly minRetainedLsn: number | null;
  readonly currentLsn: number;
}> {
  const [replicaWatermark, minRetainedLsn, currentLsn] = await Promise.all([
    subscription.getWatermark(),
    publication.minRetainedLsn(),
    publication.currentLsn(),
  ]);

  if (minRetainedLsn !== null && replicaWatermark < minRetainedLsn - 1) {
    return {
      needed: true,
      reason: 'behind-retained-journal',
      replicaWatermark,
      minRetainedLsn,
      currentLsn,
    };
  }

  if (replicaWatermark === 0 && currentLsn > 0 && minRetainedLsn === null) {
    return {
      needed: true,
      reason: 'behind-retained-journal',
      replicaWatermark,
      minRetainedLsn,
      currentLsn,
    };
  }

  if (replicaWatermark === 0 && currentLsn > 0) {
    return {
      needed: true,
      reason: 'uninitialized',
      replicaWatermark,
      minRetainedLsn,
      currentLsn,
    };
  }

  return {
    needed: false,
    reason: 'up-to-date',
    replicaWatermark,
    minRetainedLsn,
    currentLsn,
  };
}

/**
 * Seed or re-seed a replica database from a consistent `PublicationSnapshot`
 * (either logical table rows + optional DDL or binary page diff `FBDF\x01`)
 * and align both the replica's LSN watermark and the primary's replication slot.
 */
export async function bootstrapReplica(
  options: BootstrapReplicaOptions,
): Promise<BootstrapReplicaResult> {
  const mode =
    options.bootstrapStrategy ?? options.mode ?? options.snapshot?.mode ?? 'logical';
  const truncateExisting = options.truncateExisting ?? true;

  const snapshot =
    options.snapshot ??
    (await options.publication.exportSnapshot({
      mode,
      bootstrapStrategy: mode,
      compressGzip: options.compressGzip,
      baseSnapshot: options.baseSnapshot,
      tableDdl: options.tableDdl,
      concurrency: options.concurrency,
    }));

  const hasLocalPublication = Boolean(
    (options.subscription as unknown as { _localPublication?: unknown })._localPublication,
  );

  let rowsCopied = 0;
  let bytesTransferred = 0;

  if (snapshot.mode === 'binary-image' && snapshot.databaseImageBytes) {
    bytesTransferred = snapshot.databaseImageBytes.byteLength;
    if (typeof options.targetDb.loadDataStream === 'function') {
      await options.targetDb.loadDataStream(
        singleChunkStream(snapshot.databaseImageBytes),
        { compression: snapshot.imageGzipped ? 'gzip' : 'none' },
      );
    } else {
      throw new Error(
        "bootstrapReplica({ bootstrapStrategy: 'binary-image' }) requires targetDb.loadDataStream()",
      );
    }
    if (!hasLocalPublication) {
      await dropAllClonedReplicationTriggers(options.targetDb);
    }
  } else if (snapshot.mode === 'page-diff' && snapshot.pageDiffBytes) {
    bytesTransferred = snapshot.pageDiffBytes.byteLength;
    if (typeof options.targetDb.applyDiff === 'function') {
      await options.targetDb.applyDiff(snapshot.pageDiffBytes, options.baseSnapshot);
    } else if (typeof options.targetDb.loadDataStream === 'function') {
      const baseBytes =
        options.baseSnapshot ??
        (typeof options.targetDb.dumpDataDir === 'function'
          ? await options.targetDb.dumpDataDir().catch(() => new Uint8Array(0))
          : new Uint8Array(0));
      const patched = applyPageDiff(baseBytes, snapshot.pageDiffBytes);
      await options.targetDb.loadDataStream(singleChunkStream(patched), {
        compression: 'none',
      });
    }
    if (!hasLocalPublication) {
      await dropAllClonedReplicationTriggers(options.targetDb);
    }
  } else {
    const syncLocalMirror = (
      table: string,
      op: 'INSERT' | 'UPDATE' | 'DELETE',
      key: Record<string, unknown>,
      after: Record<string, unknown> | null,
    ) => {
      const internalPub = (options.subscription as unknown as {
        _localPublication?: ReplicationPublication & {
          _syncMirrorFromRemote?: (
            t: string,
            o: 'INSERT' | 'UPDATE' | 'DELETE',
            k: Record<string, unknown>,
            a: Record<string, unknown> | null,
          ) => void;
        };
      })._localPublication;
      internalPub?._syncMirrorFromRemote?.(table, op, key, after);
    };

    const applySnapshotTables = async (runner: {
      query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
      execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
      execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
    }) => {
      try {
        await runner.query(
          `SELECT RDB$SET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}', 'REPLICA') FROM RDB$DATABASE`,
        );
      } catch {
        // Ignore on test doubles
      }

      const hasLocalMirror = Boolean(
        (options.subscription as unknown as { _localPublication?: unknown })._localPublication,
      );

      const seedConcurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
      const seedSingleTable = async (tbl: (typeof snapshot.tables)[number]) => {
        const tableUpper = normalizeTableName(tbl.table);
        const ddl =
          tbl.ddlSql ??
          options.tableDdl?.[tableUpper] ??
          options.tableDdl?.[tableUpper.toLowerCase()];
        if (ddl) {
          await ensureTableSafe(options.targetDb, ddl);
        }

        if (truncateExisting) {
          if (typeof runner.execBatch === 'function' && !hasLocalMirror) {
            try {
              await execStatement(runner, `DELETE FROM ${quoteIdent(tableUpper)}`);
            } catch {
              // Table may not exist yet or be empty
            }
          } else {
            try {
              const existing = await runner.query<Row>(
                `SELECT * FROM ${quoteIdent(tableUpper)}`,
              );
              for (const r of existing.rows) {
                const normR = normalizeRowKeysUpper(r);
                const keyRec = extractKeyRecord(normR, tbl.primaryKey);
                await applyRowMutationToTable(
                  runner,
                  tableUpper,
                  tbl.primaryKey,
                  'DELETE',
                  keyRec,
                  null,
                );
                syncLocalMirror(tableUpper, 'DELETE', keyRec, null);
              }
            } catch {
              // Table may not exist yet or be empty
            }
          }
        }

        if (typeof runner.execBatch === 'function' && tbl.rows.length > 0) {
          const batchItems = tbl.rows.map((row) => {
            const normRow = normalizeRowKeysUpper(row);
            const keyRec = extractKeyRecord(normRow, tbl.primaryKey);
            bytesTransferred += JSON.stringify(normRow).length;
            return { key: keyRec, rowValues: normRow };
          });
          await applyBatchedRowMutationsToTable(
            runner,
            tableUpper,
            tbl.primaryKey,
            'INSERT',
            batchItems,
          );
          if (hasLocalMirror) {
            for (const item of batchItems) {
              syncLocalMirror(tableUpper, 'INSERT', item.key, item.rowValues);
            }
          }
          rowsCopied += batchItems.length;
        } else {
          for (const row of tbl.rows) {
            const normRow = normalizeRowKeysUpper(row);
            const keyRec = extractKeyRecord(normRow, tbl.primaryKey);
            await applyRowMutationToTable(
              runner,
              tableUpper,
              tbl.primaryKey,
              'INSERT',
              keyRec,
              normRow,
            );
            syncLocalMirror(tableUpper, 'INSERT', keyRec, normRow);
            rowsCopied++;
            bytesTransferred += JSON.stringify(normRow).length;
          }
        }
      };

      try {
        if (seedConcurrency > 1 && snapshot.tables.length > 1) {
          let nextTblIdx = 0;
          const workerCount = Math.min(seedConcurrency, snapshot.tables.length);
          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              for (;;) {
                const idx = nextTblIdx++;
                if (idx >= snapshot.tables.length) break;
                await seedSingleTable(snapshot.tables[idx]!);
              }
            }),
          );
        } else {
          for (const tbl of snapshot.tables) {
            await seedSingleTable(tbl);
          }
        }
      } finally {
        try {
          await runner.query(
            `SELECT RDB$SET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}', 'PRIMARY') FROM RDB$DATABASE`,
          );
        } catch {
          // Ignore
        }
      }
    };

    if (
      typeof options.targetDb.transaction === 'function' &&
      Math.max(1, Math.floor(options.concurrency ?? 1)) <= 1
    ) {
      await options.targetDb.transaction(applySnapshotTables);
    } else {
      await applySnapshotTables(options.targetDb);
    }
  }

  await options.subscription.setWatermark(snapshot.watermarkLsn);
  if (typeof options.publication.advanceSlot === 'function') {
    await options.publication.advanceSlot(
      options.subscription.slotName,
      snapshot.watermarkLsn,
      { nodeId: options.subscription.nodeId },
    );
  }

  return {
    mode: snapshot.mode,
    watermarkLsn: snapshot.watermarkLsn,
    tablesBootstrapped: snapshot.tables.length,
    rowsCopied,
    bytesTransferred,
  };
}

