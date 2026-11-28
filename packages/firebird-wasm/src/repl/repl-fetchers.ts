/**
 * repl-fetchers.ts – Schema, Migration, Profiler & Replication Catalog Fetchers
 * for `<firebird-repl>` (`M30 Item 5`).
 */

import {
  DEFAULT_MIGRATIONS_TABLE,
  introspect as introspectCatalog,
} from '../browser/schema';
import type {
  AppliedMigration,
  IntrospectOptions,
  MigrateOptions,
  MonitorStats,
  Row,
  SchemaIntrospection,
} from '../types';
import {
  DEFAULT_REPL_DLQ_TABLE,
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_SLOTS_TABLE,
  DEFAULT_REPL_WATERMARK_TABLE,
  type ReplicationStats,
} from '../replication';
import type {
  ReplDatabase,
  ReplEnginePublicationInfo,
  ReplReplicationDlqEntrySummary,
  ReplReplicationInfo,
  ReplReplicationJournalEntrySummary,
  ReplReplicationSlotInfo,
  ReplReplicationWatermarkInfo,
} from './repl-types';

export async function fetchReplSchema(
  db: ReplDatabase,
  options?: IntrospectOptions,
): Promise<SchemaIntrospection> {
  if (typeof db.introspect === 'function') {
    return db.introspect(options);
  }
  return introspectCatalog(
    {
      query: async <T = Row>(sqlText: string, params: unknown[] = []) => {
        const res = await db.query(sqlText, params, { rowMode: 'array' });
        const objRows = res.rows.map((cols) =>
          Object.fromEntries(res.fields.map((f, idx) => [f.name, cols[idx]])),
        ) as unknown as T[];
        return { fields: res.fields, rows: objRows };
      },
      exec: async () => undefined,
    },
    options,
  );
}

export async function fetchReplMigrations(
  db: ReplDatabase,
  options: Pick<MigrateOptions, 'tableName'> = {},
): Promise<AppliedMigration[]> {
  const rawName = (options.tableName ?? DEFAULT_MIGRATIONS_TABLE).trim();
  const rawUpper = rawName.toUpperCase();
  const quoted = `"${rawUpper.replace(/"/g, '""')}"`;

  const exists = await db.query(
    'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [rawUpper],
    { rowMode: 'array' },
  );
  if (exists.rows.length === 0) return [];

  const res = await db.query(
    `SELECT VERSION, NAME, APPLIED_AT FROM ${quoted} ORDER BY SEQ ASC, VERSION ASC`,
    [],
    { rowMode: 'array' },
  );
  return res.rows.map((row) => ({
    version: String(row[0] ?? '').trim(),
    name:
      row[1] !== null && row[1] !== undefined && String(row[1]).trim() !== ''
        ? String(row[1]).trim()
        : null,
    appliedAt: String(row[2] ?? '').trim(),
  }));
}

export async function fetchReplStats(db: ReplDatabase): Promise<MonitorStats | null> {
  if (typeof db.monitorStats === 'function') {
    return db.monitorStats();
  }
  if (typeof db.databaseInfo === 'function') {
    const info = await db.databaseInfo();
    return {
      totalQueries: 0,
      totalExecs: 0,
      totalErrors: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      maxDurationMs: 0,
      slowestSql: null,
      prepareCacheHits: 0,
      prepareCacheMisses: 0,
      prepareCacheHitRate: 0,
      io: {
        reads: info.reads,
        writes: info.writes,
        fetches: info.fetches,
        marks: info.marks,
        pageBuffers: info.pageBuffers,
        currentMemory: info.currentMemory,
        maxMemory: info.maxMemory,
      },
      transactions: {
        oldestTransaction: info.oldestTransaction,
        oldestActive: info.oldestActive,
        oldestSnapshot: info.oldestSnapshot,
        nextTransaction: info.nextTransaction,
        transactionGap: info.transactionGap,
      },
      activeStatements: 0,
      recentQueries: [],
    };
  }
  return null;
}

export async function fetchReplReplication(
  db: ReplDatabase,
  replicatorHandle: { stats(): Promise<ReplicationStats> } | null,
): Promise<ReplReplicationInfo> {
  const relRes = await db.query(
    `SELECT TRIM(RDB$RELATION_NAME) AS REL_NAME
     FROM RDB$RELATIONS
     WHERE TRIM(RDB$RELATION_NAME) IN (?, ?, ?, ?)`,
    [
      DEFAULT_REPL_JOURNAL_TABLE,
      DEFAULT_REPL_SLOTS_TABLE,
      DEFAULT_REPL_WATERMARK_TABLE,
      DEFAULT_REPL_DLQ_TABLE,
    ],
    { rowMode: 'array' },
  );
  const existingTables = new Set(relRes.rows.map((r) => String(r[0] ?? '').trim().toUpperCase()));

  let journalEntryCount = 0;
  let minJournalLsn = 0;
  let maxJournalLsn = 0;
  const recentEntries: ReplReplicationJournalEntrySummary[] = [];

  if (existingTables.has(DEFAULT_REPL_JOURNAL_TABLE)) {
    const jQuoted = `"${DEFAULT_REPL_JOURNAL_TABLE}"`;
    const statsRes = await db.query(
      `SELECT COUNT(*), COALESCE(MIN(LSN), 0), COALESCE(MAX(LSN), 0) FROM ${jQuoted}`,
      [],
      { rowMode: 'array' },
    );
    const sRow = statsRes.rows[0];
    if (sRow) {
      journalEntryCount = Number(sRow[0] ?? 0);
      minJournalLsn = Number(sRow[1] ?? 0);
      maxJournalLsn = Number(sRow[2] ?? 0);
    }

    const recentRes = await db.query(
      `SELECT LSN, ORIGIN_NODE, TABLE_NAME, OP, PK_JSON, CREATED_AT
       FROM ${jQuoted}
       ORDER BY LSN DESC
       ROWS 20`,
      [],
      { rowMode: 'array' },
    );
    for (const r of recentRes.rows) {
      recentEntries.push({
        lsn: Number(r[0] ?? 0),
        originNode: String(r[1] ?? '').trim(),
        tableName: String(r[2] ?? '').trim(),
        op: String(r[3] ?? '').trim(),
        pkJson: String(r[4] ?? '').trim(),
        createdAt: String(r[5] ?? '').trim(),
      });
    }
  }

  const slots: ReplReplicationSlotInfo[] = [];
  if (existingTables.has(DEFAULT_REPL_SLOTS_TABLE)) {
    const slotRes = await db.query(
      `SELECT SLOT_NAME, NODE_ID, CONFIRMED_FLUSH_LSN, UPDATED_AT
       FROM "${DEFAULT_REPL_SLOTS_TABLE}"
       ORDER BY SLOT_NAME ASC`,
      [],
      { rowMode: 'array' },
    );
    for (const r of slotRes.rows) {
      slots.push({
        slotName: String(r[0] ?? '').trim(),
        nodeId: String(r[1] ?? '').trim(),
        confirmedFlushLsn: Number(r[2] ?? 0),
        updatedAt: String(r[3] ?? '').trim(),
      });
    }
  }

  const watermarks: ReplReplicationWatermarkInfo[] = [];
  if (existingTables.has(DEFAULT_REPL_WATERMARK_TABLE)) {
    const wmRes = await db.query(
      `SELECT PEER_ID, LAST_LSN, UPDATED_AT
       FROM "${DEFAULT_REPL_WATERMARK_TABLE}"
       ORDER BY PEER_ID ASC`,
      [],
      { rowMode: 'array' },
    );
    for (const r of wmRes.rows) {
      watermarks.push({
        peerId: String(r[0] ?? '').trim(),
        lastLsn: Number(r[1] ?? 0),
        updatedAt: String(r[2] ?? '').trim(),
      });
    }
  }

  const dlqEntries: ReplReplicationDlqEntrySummary[] = [];
  if (existingTables.has(DEFAULT_REPL_DLQ_TABLE)) {
    const dlqRes = await db.query(
      `SELECT LSN, SUB_NAME, ERROR_MSG, RETRY_COUNT, QUARANTINED_AT
       FROM "${DEFAULT_REPL_DLQ_TABLE}"
       ORDER BY LSN ASC`,
      [],
      { rowMode: 'array' },
    );
    for (const r of dlqRes.rows) {
      dlqEntries.push({
        lsn: Number(r[0] ?? 0),
        subName: String(r[1] ?? '').trim(),
        errorMessage: String(r[2] ?? '').trim(),
        retryCount: Number(r[3] ?? 0),
        quarantinedAt: String(r[4] ?? '').trim(),
      });
    }
  }

  let enginePublication: ReplEnginePublicationInfo | null = null;
  try {
    const pubRes = await db.query(
      `SELECT TRIM(RDB$PUBLICATION_NAME), RDB$ACTIVE_FLAG, RDB$AUTO_ENABLE FROM RDB$PUBLICATIONS`,
      [],
      { rowMode: 'array' },
    );
    const pubRow = pubRes.rows[0];
    if (pubRow) {
      const pubName = String(pubRow[0] ?? 'RDB$DEFAULT').trim() || 'RDB$DEFAULT';
      const active = Number(pubRow[1] ?? 0) === 1;
      const autoEnable = Number(pubRow[2] ?? 0) === 1;
      const publishedTables: string[] = [];
      try {
        const tblRes = await db.query(
          `SELECT TRIM(RDB$TABLE_NAME) FROM RDB$PUBLICATION_TABLES ORDER BY RDB$TABLE_NAME`,
          [],
          { rowMode: 'array' },
        );
        for (const tr of tblRes.rows) {
          const tName = String(tr[0] ?? '').trim().toUpperCase();
          if (tName) publishedTables.push(tName);
        }
      } catch {
        // Ignore if RDB$PUBLICATION_TABLES is unavailable
      }
      let replicaMode: string | null = null;
      let replicationSequence: number | null = null;
      try {
        const ctxRes = await db.query(
          `SELECT RDB$GET_CONTEXT('SYSTEM', 'REPLICA_MODE'),
                  RDB$GET_CONTEXT('SYSTEM', 'REPLICATION_SEQUENCE')
           FROM RDB$DATABASE`,
          [],
          { rowMode: 'array' },
        );
        const ctxRow = ctxRes.rows[0];
        if (ctxRow) {
          if (ctxRow[0] != null) replicaMode = String(ctxRow[0]).trim();
          if (ctxRow[1] != null && Number.isFinite(Number(ctxRow[1]))) {
            replicationSequence = Number(ctxRow[1]);
          }
        }
      } catch {
        // Ignore if SYSTEM context variables are unavailable
      }
      enginePublication = {
        name: pubName,
        active,
        autoEnable,
        publishedTables,
        replicaMode,
        replicationSequence,
      };
    }
  } catch {
    enginePublication = null;
  }

  let liveStats: ReplicationStats | null = null;
  if (replicatorHandle && typeof replicatorHandle.stats === 'function') {
    try {
      liveStats = await replicatorHandle.stats();
    } catch {
      liveStats = null;
    }
  }

  return {
    journalTableExists: existingTables.has(DEFAULT_REPL_JOURNAL_TABLE),
    journalEntryCount,
    minJournalLsn,
    maxJournalLsn,
    slots,
    watermarks,
    recentEntries,
    dlqTableExists: existingTables.has(DEFAULT_REPL_DLQ_TABLE),
    dlqEntryCount: dlqEntries.length,
    dlqEntries,
    enginePublication,
    liveStats,
  };
}
