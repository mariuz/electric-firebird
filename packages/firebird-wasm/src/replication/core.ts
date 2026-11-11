/**
 * Core Logical Publications, Subscriptions, Bidirectional Sync, Failover Promotion,
 * Time-Travel, Multi-Node Mesh/Hub, DLQ, PII Masking, PITR Archives & Journal Compaction.
 */

import type { QueryParams, QueryResult, Row } from '../types';
import {
  DEFAULT_REPL_DLQ_TABLE,
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_LSN_SEQUENCE,
  DEFAULT_REPL_MIRROR_TABLE,
  DEFAULT_REPL_ROLE_CONTEXT_VAR,
  DEFAULT_REPL_SLOTS_TABLE,
  DEFAULT_REPL_SLOT_TTL_MS,
  DEFAULT_REPL_WATERMARK_TABLE,
  type BootstrapReplicaOptions,
  type BootstrapReplicaResult,
  type CompactJournalOptions,
  type CreatePublicationOptions,
  type CreateSubscriptionOptions,
  type HlcTimestamp,
  type InstalledReplicationTrigger,
  type JournalCompactionResult,
  type LogicalTableSnapshot,
  type PiiColumnMaskStrategy,
  type PruneAckedResult,
  type PublicationSnapshot,
  type PublishedTableConfig,
  type RegisterReplicationSlotOptions,
  type ReplicableDatabase,
  type ReplicationConflictContext,
  type ReplicationConflictStrategy,
  type ReplicationDlq,
  type ReplicationDlqEntry,
  type ReplicationDlqOptions,
  type ReplicationIndexHook,
  type ReplicationLogEntry,
  type ReplicationOperation,
  type ReplicationPublication,
  type ReplicationSlot,
  type ReplicationStats,
  type ReplicationSubscription,
  type RowTransformer,
  type SubscriptionPullResult,
  type SyncCatalogOptions,
  type SyncCatalogResult,
} from './types';
import {
  applyBatchedRowMutationsToTable,
  applyRowMutationToTable,
  decodeJson,
  encodeJson,
  ensureTableSafe,
  escapeSqlLiteral,
  execStatement,
  extractKeyRecord,
  fnv1aHash8,
  normalizeRowKeysUpper,
  normalizeTableName,
  quoteIdent,
  rowsEqual,
  serializeKeyRecord,
} from './shared';
import {
  compareHlc,
  createHlc,
  formatHlc,
  matchesRowFilter,
  mergeReplicatedRow,
  orderEntriesByTopology,
  projectReplicatedRow,
} from './hlc-crdt';
import {
  applySequences,
  discoverUserTables,
  dropReplicationTriggers,
  exportSequences,
  installReplicationTriggers,
  syncCatalog,
} from './catalog';
import { classifyDdlStatement, resolveDdlConflict } from './ddl-guard';
import {
  decodeEncryptedJournalSegment,
  encodeEncryptedJournalSegment,
} from './segments';
import { enableEnginePublication } from './native-changelog';

interface NormalizedPublishedTableConfig extends Omit<PublishedTableConfig, 'primaryKey'> {
  table: string;
  primaryKey: string[];
  columns?: string[];
  excludeColumns?: string[];
  references?: string[];
}

/**
 * Create a whole-database publication (`tables: '*'`) that automatically discovers
 * and publishes all user tables on `db`.
 */
export async function publishAllTables(
  db: ReplicableDatabase,
  options: Omit<CreatePublicationOptions, 'tables'> = {},
): Promise<ReplicationPublication> {
  return createPublication(db, {
    ...options,
    tables: '*',
  });
}

// ---------------------------------------------------------------------------
// 1. `createPublication` Implementation
// ---------------------------------------------------------------------------

/**
 * Create a logical replication publication on `db`.
 */
export async function createPublication(
  db: ReplicableDatabase,
  options: CreatePublicationOptions,
): Promise<ReplicationPublication> {
  const pubName = (options.name ?? 'default').trim();
  const nodeId = (options.nodeId ?? `node_${pubName}`).trim();
  const hlc = options.hlc ?? createHlc(nodeId);
  const hlcByLsn = new Map<number, string>();
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);
  const slotsTable = quoteIdent(options.slotsTable ?? DEFAULT_REPL_SLOTS_TABLE);
  const defaultSlotTtlMs = options.defaultSlotTtlMs ?? DEFAULT_REPL_SLOT_TTL_MS;

  const tablesMap = new Map<string, NormalizedPublishedTableConfig>();
  const isWildcard = options.tables === '*';

  const registerTableItem = (item: string | PublishedTableConfig): void => {
    if (typeof item === 'string') {
      const upper = normalizeTableName(item);
      if (!tablesMap.has(upper)) {
        tablesMap.set(upper, { table: upper, primaryKey: ['ID'] });
      }
    } else {
      const upper = normalizeTableName(item.table);
      const pk =
        typeof item.primaryKey === 'string'
          ? [item.primaryKey.toUpperCase()]
          : item.primaryKey && item.primaryKey.length > 0
            ? item.primaryKey.map((k) => k.toUpperCase())
            : ['ID'];
      const columns =
        item.columns && item.columns.length > 0
          ? item.columns.map((c) => c.toUpperCase())
          : undefined;
      const excludeColumns =
        item.excludeColumns && item.excludeColumns.length > 0
          ? item.excludeColumns.map((c) => c.toUpperCase())
          : undefined;
      const references =
        item.references && item.references.length > 0
          ? item.references.map((r) => normalizeTableName(r))
          : undefined;
      tablesMap.set(upper, {
        table: upper,
        primaryKey: pk,
        ...(columns ? { columns } : {}),
        ...(excludeColumns ? { excludeColumns } : {}),
        ...(item.where ? { where: item.where } : {}),
        ...(references ? { references } : {}),
        ...(item.transformRow ? { transformRow: item.transformRow } : {}),
      });
    }
  };

  if (options.tables === '*') {
    const discovered = await discoverUserTables(db, {
      excludeTables: options.excludeTables,
    });
    for (const item of discovered) {
      registerTableItem(item);
    }
  } else {
    for (const item of options.tables) {
      registerTableItem(item);
    }
  }

  // Provision journal table
  await ensureTableSafe(
    db,
    `CREATE TABLE ${journalTable} (
      LSN BIGINT NOT NULL PRIMARY KEY,
      TXID VARCHAR(128) NOT NULL,
      ORIGIN VARCHAR(128) NOT NULL,
      "PUBLICATION" VARCHAR(128) NOT NULL,
      TABLE_NAME VARCHAR(128) NOT NULL,
      OP VARCHAR(16) NOT NULL,
      KEY_JSON VARCHAR(2000) NOT NULL,
      AFTER_JSON VARCHAR(8191),
      BEFORE_JSON VARCHAR(8191),
      DDL_SQL VARCHAR(8191),
      TS BIGINT NOT NULL
    )`,
  );

  // Provision replication slots table
  await ensureTableSafe(
    db,
    `CREATE TABLE ${slotsTable} (
      SLOT_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
      "PUBLICATION" VARCHAR(128) NOT NULL,
      NODE_ID VARCHAR(128) NOT NULL,
      CONFIRMED_LSN BIGINT NOT NULL,
      LAST_SEEN_AT BIGINT NOT NULL,
      TTL_MS BIGINT NOT NULL
    )`,
  );

  // In-memory mirror per table (`tableName -> Map<serializedKey, normalizedRow>`)
  // used by `captureTableChanges()` to detect direct SQL inserts/updates/deletes.
  const tableMirrors = new Map<string, Map<string, Record<string, unknown>>>();

  let lsnCounter = 0;
  try {
    const maxRes = await db.query<{ MAX_LSN?: number | bigint | null }>(
      `SELECT MAX(LSN) AS MAX_LSN FROM ${journalTable}`,
    );
    const rawMax = maxRes.rows[0]?.MAX_LSN;
    if (rawMax !== null && rawMax !== undefined) {
      lsnCounter = Number(rawMax);
    }
  } catch {
    // Ignore if journal table is empty or mock DB does not aggregate MAX(LSN)
  }

  // Once PSQL capture triggers are installed, the triggers take LSNs from
  // `FB_REPL_LSN_GEN$`. Every journal write made from JavaScript must then draw
  // from the same sequence, or the in-memory counter and the generator hand
  // out the same LSN twice and collide on the journal's primary key.
  const lsnSequence = quoteIdent(options.sequenceName ?? DEFAULT_REPL_LSN_SEQUENCE);
  let triggerCapture = false;
  // Journal head as of the last `captureTableChanges()` (trigger mode only):
  // rows the triggers journalled after this point are not re-captured by the diff.
  let captureWatermark = 0;

  const allocateLsn = async (): Promise<number> => {
    if (triggerCapture) {
      try {
        const res = await db.query<Row>(
          `SELECT NEXT VALUE FOR ${lsnSequence} AS NEXT_LSN FROM RDB$DATABASE`,
        );
        const v = Number(res.rows[0]?.NEXT_LSN ?? res.rows[0]?.next_lsn);
        if (Number.isFinite(v) && v > 0) {
          if (v > lsnCounter) lsnCounter = v;
          return v;
        }
      } catch {
        // Database without sequence support (test doubles): fall back below
      }
    }
    return ++lsnCounter;
  };

  /** Advance `FB_REPL_LSN_GEN$` past any LSN already present in the journal. */
  const alignLsnSequence = async (): Promise<void> => {
    try {
      const head = await publication.currentLsn();
      const cur = await db.query<Row>(
        `SELECT GEN_ID(${lsnSequence}, 0) AS CUR_LSN FROM RDB$DATABASE`,
      );
      const value = Number(cur.rows[0]?.CUR_LSN ?? cur.rows[0]?.cur_lsn ?? 0);
      if (Number.isFinite(value) && head > value) {
        await db.query<Row>(
          `SELECT GEN_ID(${lsnSequence}, ${Math.trunc(head - value)}) AS NEW_LSN FROM RDB$DATABASE`,
        );
      }
    } catch {
      // Test doubles without generators
    }
  };

  /**
   * Type-insensitive key for matching trigger-journalled rows against table
   * rows: PSQL triggers serialise key values into KEY_JSON as text (`"1"`)
   * while the table returns them as numbers (`1`).
   */
  const looseKey = (tableUpper: string, rec: Record<string, unknown>, pkCols: readonly string[]): string =>
    `${tableUpper}|${pkCols.map((c) => String(rec[c.toUpperCase()] ?? '')).join('\u0001')}`;

  /** Table + key pairs the capture triggers journalled with `LSN > sinceLsn`. */
  const triggerCapturedKeys = async (sinceLsn: number): Promise<Set<string>> => {
    const seen = new Set<string>();
    if (!triggerCapture) return seen;
    try {
      const entries = await publication.fetchChangesSince(sinceLsn);
      for (const e of entries) {
        const tableUpper = normalizeTableName(e.table);
        const cfg = tablesMap.get(tableUpper);
        if (!cfg) continue;
        seen.add(looseKey(tableUpper, normalizeRowKeysUpper(e.key), cfg.primaryKey));
      }
    } catch {
      // Ignore: fall back to journalling the full diff
    }
    return seen;
  };

  let txCounter = 0;
  const nextTxId = (): string => `${nodeId}-tx-${++txCounter}`;

  const updateMirrorRow = (
    tableUpper: string,
    pkCols: readonly string[],
    op: 'INSERT' | 'UPDATE' | 'DELETE',
    keyRec: Record<string, unknown>,
    afterRec: Record<string, unknown> | null,
  ): void => {
    let mirror = tableMirrors.get(tableUpper);
    if (!mirror) {
      mirror = new Map();
      tableMirrors.set(tableUpper, mirror);
    }
    const k = serializeKeyRecord(keyRec, pkCols);
    if (op === 'DELETE') {
      mirror.delete(k);
    } else if (afterRec) {
      mirror.set(k, normalizeRowKeysUpper({ ...afterRec, ...keyRec }));
    }
  };

  const insertJournalEntry = async (entry: ReplicationLogEntry): Promise<void> => {
    if (entry.hlc) {
      hlcByLsn.set(entry.lsn, entry.hlc);
    }
    await execStatement(
      db,
      `INSERT INTO ${journalTable} (LSN, TXID, ORIGIN, "PUBLICATION", TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.lsn,
        entry.txid,
        entry.origin,
        entry.publication,
        entry.table,
        entry.operation,
        encodeJson(entry.key) ?? '{}',
        encodeJson(entry.after),
        encodeJson(entry.before),
        entry.ddlSql ?? null,
        entry.timestamp,
      ],
    );
  };

  const publication: ReplicationPublication & {
    /** @internal Update internal mirror when a subscription applies a remote change. */
    _syncMirrorFromRemote(
      table: string,
      op: 'INSERT' | 'UPDATE' | 'DELETE',
      key: Record<string, unknown>,
      after: Record<string, unknown> | null,
    ): void;
  } = {
    name: pubName,
    nodeId,
    hlc,
    tables: tablesMap,

    async refreshPublishedTables(): Promise<ReadonlyMap<string, NormalizedPublishedTableConfig>> {
      const discovered = await discoverUserTables(db, {
        excludeTables: options.excludeTables,
      });
      for (const item of discovered) {
        const upper = normalizeTableName(item.table);
        if (!tablesMap.has(upper)) {
          registerTableItem(item);
        }
      }
      return tablesMap;
    },

    async currentLsn(): Promise<number> {
      try {
        const res = await db.query<Row>(
          `SELECT LSN FROM ${journalTable} ORDER BY LSN DESC`,
        );
        const top = res.rows[0];
        if (top) {
          const dbMax = Number(top.LSN ?? top.lsn ?? 0);
          if (dbMax > lsnCounter) {
            lsnCounter = dbMax;
          }
        }
      } catch {
        // Fallback to in-memory counter
      }
      return lsnCounter;
    },

    async minRetainedLsn(): Promise<number | null> {
      try {
        const res = await db.query<Row>(
          `SELECT LSN, "PUBLICATION" FROM ${journalTable} WHERE LSN > ? ORDER BY LSN ASC`,
          [0],
        );
        for (const r of res.rows) {
          const pub = String(r.PUBLICATION ?? r.publication ?? pubName);
          if (pub === pubName) {
            return Number(r.LSN ?? r.lsn ?? 0);
          }
        }
      } catch {
        // Ignore
      }
      return null;
    },

    async installTriggers(): Promise<InstalledReplicationTrigger[]> {
      const installed = await installReplicationTriggers(db, {
        tables: Array.from(tablesMap.values()),
        publication: pubName,
        nodeId,
        journalTable: options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE,
        sequenceName: options.sequenceName ?? DEFAULT_REPL_LSN_SEQUENCE,
      });
      triggerCapture = true;
      await alignLsnSequence();
      captureWatermark = await publication.currentLsn();
      return installed;
    },

    async dropTriggers(): Promise<string[]> {
      return dropReplicationTriggers(db, {
        tables: Array.from(tablesMap.values()),
        publication: pubName,
      });
    },

    async registerSlot(slotOpts): Promise<ReplicationSlot> {
      const cfg: RegisterReplicationSlotOptions =
        typeof slotOpts === 'string' ? { slotName: slotOpts } : slotOpts;
      const slotName = cfg.slotName.trim();
      const slotNodeId = (cfg.nodeId ?? slotName).trim();
      const initialLsn = cfg.initialLsn ?? 0;
      const ttlMs = cfg.ttlMs ?? defaultSlotTtlMs;
      const now = cfg.now ?? Date.now();

      const existing = await db.query<Row>(
        `SELECT * FROM ${slotsTable} WHERE SLOT_NAME = ?`,
        [slotName],
      );
      if (existing.rows.length > 0) {
        const prev = existing.rows[0]!;
        const prevLsn = Number(prev.CONFIRMED_LSN ?? prev.confirmed_lsn ?? 0);
        const nextLsn = Math.max(prevLsn, initialLsn);
        await execStatement(
          db,
          `UPDATE ${slotsTable} SET "PUBLICATION" = ?, NODE_ID = ?, CONFIRMED_LSN = ?, LAST_SEEN_AT = ?, TTL_MS = ? WHERE SLOT_NAME = ?`,
          [pubName, slotNodeId, nextLsn, now, ttlMs, slotName],
        );
        return {
          slotName,
          publication: pubName,
          nodeId: slotNodeId,
          confirmedFlushLsn: nextLsn,
          lastSeenAt: now,
          ttlMs,
        };
      }

      await execStatement(
        db,
        `INSERT INTO ${slotsTable} (SLOT_NAME, "PUBLICATION", NODE_ID, CONFIRMED_LSN, LAST_SEEN_AT, TTL_MS) VALUES (?, ?, ?, ?, ?, ?)`,
        [slotName, pubName, slotNodeId, initialLsn, now, ttlMs],
      );
      return {
        slotName,
        publication: pubName,
        nodeId: slotNodeId,
        confirmedFlushLsn: initialLsn,
        lastSeenAt: now,
        ttlMs,
      };
    },

    async advanceSlot(slotName, confirmedFlushLsn, advOpts = {}): Promise<ReplicationSlot> {
      const cleanName = slotName.trim();
      const now = advOpts.now ?? Date.now();
      const existing = await db.query<Row>(
        `SELECT * FROM ${slotsTable} WHERE SLOT_NAME = ?`,
        [cleanName],
      );
      if (existing.rows.length === 0) {
        return publication.registerSlot({
          slotName: cleanName,
          nodeId: advOpts.nodeId ?? cleanName,
          initialLsn: confirmedFlushLsn,
          ttlMs: advOpts.ttlMs ?? defaultSlotTtlMs,
          now,
        });
      }

      const prev = existing.rows[0]!;
      const prevLsn = Number(prev.CONFIRMED_LSN ?? prev.confirmed_lsn ?? 0);
      const nextLsn = Math.max(prevLsn, confirmedFlushLsn);
      const slotNodeId = String(advOpts.nodeId ?? prev.NODE_ID ?? prev.node_id ?? cleanName);
      const ttlMs = Number(advOpts.ttlMs ?? prev.TTL_MS ?? prev.ttl_ms ?? defaultSlotTtlMs);

      await execStatement(
        db,
        `UPDATE ${slotsTable} SET CONFIRMED_LSN = ?, LAST_SEEN_AT = ?, NODE_ID = ?, TTL_MS = ? WHERE SLOT_NAME = ?`,
        [nextLsn, now, slotNodeId, ttlMs, cleanName],
      );
      return {
        slotName: cleanName,
        publication: pubName,
        nodeId: slotNodeId,
        confirmedFlushLsn: nextLsn,
        lastSeenAt: now,
        ttlMs,
      };
    },

    async heartbeatSlot(slotName, hbOpts = {}): Promise<ReplicationSlot | null> {
      const cleanName = slotName.trim();
      const now = hbOpts.now ?? Date.now();
      const existing = await db.query<Row>(
        `SELECT * FROM ${slotsTable} WHERE SLOT_NAME = ?`,
        [cleanName],
      );
      if (existing.rows.length === 0) {
        return null;
      }
      const prev = existing.rows[0]!;
      await execStatement(
        db,
        `UPDATE ${slotsTable} SET LAST_SEEN_AT = ? WHERE SLOT_NAME = ?`,
        [now, cleanName],
      );
      return {
        slotName: cleanName,
        publication: String(prev.PUBLICATION ?? prev.publication ?? pubName),
        nodeId: String(prev.NODE_ID ?? prev.node_id ?? cleanName),
        confirmedFlushLsn: Number(prev.CONFIRMED_LSN ?? prev.confirmed_lsn ?? 0),
        lastSeenAt: now,
        ttlMs: Number(prev.TTL_MS ?? prev.ttl_ms ?? defaultSlotTtlMs),
      };
    },

    async dropSlot(slotName): Promise<boolean> {
      const cleanName = slotName.trim();
      const existing = await db.query<Row>(
        `SELECT * FROM ${slotsTable} WHERE SLOT_NAME = ?`,
        [cleanName],
      );
      if (existing.rows.length === 0) {
        return false;
      }
      await execStatement(
        db,
        `DELETE FROM ${slotsTable} WHERE SLOT_NAME = ?`,
        [cleanName],
      );
      return true;
    },

    async listSlots(): Promise<ReplicationSlot[]> {
      const res = await db.query<Row>(`SELECT * FROM ${slotsTable}`);
      const out: ReplicationSlot[] = [];
      for (const r of res.rows) {
        const pub = String(r.PUBLICATION ?? r.publication ?? pubName);
        if (pub !== pubName) continue;
        out.push({
          slotName: String(r.SLOT_NAME ?? r.slot_name ?? ''),
          publication: pub,
          nodeId: String(r.NODE_ID ?? r.node_id ?? ''),
          confirmedFlushLsn: Number(r.CONFIRMED_LSN ?? r.confirmed_lsn ?? 0),
          lastSeenAt: Number(r.LAST_SEEN_AT ?? r.last_seen_at ?? 0),
          ttlMs: Number(r.TTL_MS ?? r.ttl_ms ?? defaultSlotTtlMs),
        });
      }
      return out;
    },

    async pruneAcked(pruneOpts = {}): Promise<PruneAckedResult> {
      const now = pruneOpts.now ?? Date.now();
      const allSlots = await publication.listSlots();
      const expiredSlots: string[] = [];
      const activeSlots: ReplicationSlot[] = [];

      for (const slot of allSlots) {
        if (slot.ttlMs > 0 && now - slot.lastSeenAt > slot.ttlMs) {
          await publication.dropSlot(slot.slotName);
          expiredSlots.push(slot.slotName);
        } else {
          activeSlots.push(slot);
        }
      }

      if (activeSlots.length === 0) {
        if (pruneOpts.pruneWhenNoSlots) {
          const curLsn = await publication.currentLsn();
          const prunedEntries = curLsn > 0 ? await publication.pruneJournal(curLsn) : 0;
          return {
            expiredSlots,
            activeSlotCount: 0,
            safeLsn: curLsn,
            prunedEntries,
          };
        }
        return {
          expiredSlots,
          activeSlotCount: 0,
          safeLsn: null,
          prunedEntries: 0,
        };
      }

      const safeLsn = Math.min(...activeSlots.map((s) => s.confirmedFlushLsn));
      const prunedEntries = safeLsn > 0 ? await publication.pruneJournal(safeLsn) : 0;
      return {
        expiredSlots,
        activeSlotCount: activeSlots.length,
        safeLsn,
        prunedEntries,
      };
    },

    async compactJournal(compactOpts = {}): Promise<JournalCompactionResult> {
      return compactJournal(db, {
        ...compactOpts,
        publication: compactOpts.publication ?? pubName,
        journalTable: compactOpts.journalTable ?? options.journalTable,
      });
    },

    async exportSnapshot(snapOpts = {}): Promise<PublicationSnapshot> {
      await publication.captureTableChanges();
      const watermarkLsn = await publication.currentLsn();
      const mode = snapOpts.mode ?? 'logical';
      const ts = Date.now();

      if (mode === 'page-diff') {
        const diffCapable = db as ReplicableDatabase & {
          exportDiff?(baseSnapshot: unknown): Promise<Uint8Array>;
          exportDatabase?(): Promise<Uint8Array>;
        };
        let pageDiffBytes: Uint8Array | null = null;
        if (typeof diffCapable.exportDiff === 'function') {
          pageDiffBytes = await diffCapable.exportDiff(
            snapOpts.baseSnapshot ?? new Uint8Array(0),
          );
        } else if (typeof diffCapable.exportDatabase === 'function') {
          pageDiffBytes = await diffCapable.exportDatabase();
        }
        return {
          publication: pubName,
          origin: nodeId,
          watermarkLsn,
          timestamp: ts,
          mode: 'page-diff',
          tables: [],
          pageDiffBytes,
        };
      }

      const tableSnapshots: LogicalTableSnapshot[] = [];
      for (const [tableUpper, cfg] of tablesMap.entries()) {
        let rows: Row[] = [];
        try {
          const res = await db.query<Row>(`SELECT * FROM ${quoteIdent(tableUpper)}`);
          rows = res.rows
            .map((r) => normalizeRowKeysUpper(r))
            .filter((r) => matchesRowFilter(r, cfg.where))
            .map(
              (r) =>
                projectReplicatedRow(r, cfg.primaryKey, cfg.columns, cfg.excludeColumns) ?? r,
            );
        } catch {
          rows = [];
        }
        const ddlSql =
          snapOpts.tableDdl?.[tableUpper] ??
          snapOpts.tableDdl?.[tableUpper.toLowerCase()] ??
          null;
        tableSnapshots.push({
          table: tableUpper,
          primaryKey: cfg.primaryKey,
          ddlSql,
          rows,
        });
      }

      return {
        publication: pubName,
        origin: nodeId,
        watermarkLsn,
        timestamp: ts,
        mode: 'logical',
        tables: tableSnapshots,
        pageDiffBytes: null,
      };
    },

    async recordDml(params): Promise<ReplicationLogEntry> {
      const tableUpper = normalizeTableName(params.table);
      const tableCfg = tablesMap.get(tableUpper) ?? {
        table: tableUpper,
        primaryKey: ['ID'],
      };
      const pkCols = tableCfg.primaryKey;
      const applyLocally = params.applyLocally ?? true;

      const afterNorm = params.after ? normalizeRowKeysUpper(params.after) : null;
      const keyRec = normalizeRowKeysUpper(
        params.key ?? (afterNorm ? extractKeyRecord(afterNorm, pkCols) : {}),
      );

      // Read existing row for `before` snapshot if not explicitly supplied
      let beforeNorm = params.before ? normalizeRowKeysUpper(params.before) : null;
      if (!beforeNorm && params.operation !== 'INSERT') {
        const whereClause = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
        const whereParams = pkCols.map((c) => keyRec[c.toUpperCase()]) as QueryParams;
        const existing = await db.query<Row>(
          `SELECT * FROM ${quoteIdent(tableUpper)} WHERE ${whereClause}`,
          whereParams,
        );
        if (existing.rows[0]) {
          beforeNorm = normalizeRowKeysUpper(existing.rows[0]);
        }
      }

      const fullAfter =
        params.operation === 'DELETE'
          ? null
          : normalizeRowKeysUpper({ ...(beforeNorm ?? {}), ...(afterNorm ?? {}), ...keyRec });

      if (applyLocally) {
        const lsnBeforeApply = triggerCapture ? await publication.currentLsn() : 0;
        await applyRowMutationToTable(
          db,
          tableUpper,
          pkCols,
          params.operation,
          keyRec,
          fullAfter,
        );
        if (triggerCapture) {
          // The capture trigger already journalled this write; return its
          // entry instead of journalling the same change a second time.
          const wantKey = looseKey(tableUpper, keyRec, pkCols);
          const captured = (await publication.fetchChangesSince(lsnBeforeApply)).filter(
            (e) =>
              normalizeTableName(e.table) === tableUpper &&
              looseKey(tableUpper, normalizeRowKeysUpper(e.key), pkCols) === wantKey,
          );
          const last = captured[captured.length - 1];
          if (last) {
            updateMirrorRow(tableUpper, pkCols, params.operation, keyRec, fullAfter);
            return last;
          }
        }
      }

      updateMirrorRow(tableUpper, pkCols, params.operation, keyRec, fullAfter);

      const projectedAfter = projectReplicatedRow(
        fullAfter,
        pkCols,
        tableCfg.columns,
        tableCfg.excludeColumns,
      );
      const projectedBefore = projectReplicatedRow(
        beforeNorm,
        pkCols,
        tableCfg.columns,
        tableCfg.excludeColumns,
      );

      const ts = params.timestamp ?? Date.now();
      const entry: ReplicationLogEntry = {
        lsn: await allocateLsn(),
        txid: params.txid ?? nextTxId(),
        origin: params.origin ?? nodeId,
        publication: pubName,
        table: tableUpper,
        operation: params.operation,
        key: keyRec,
        after: projectedAfter,
        before: projectedBefore,
        ddlSql: null,
        timestamp: ts,
        hlc: hlc.now(ts),
      };

      await insertJournalEntry(entry);
      return entry;
    },

    async recordDdl(ddlSql, ddlOpts = {}): Promise<ReplicationLogEntry> {
      const applyLocally = ddlOpts.applyLocally ?? true;
      if (applyLocally) {
        await execStatement(db, ddlSql);
      }

      // Register newly created table if `CREATE TABLE <name>`
      const createMatch = /^\s*CREATE\s+TABLE\s+(?:"([^"]+)"|([A-Za-z0-9_$]+))/i.exec(ddlSql);
      if (createMatch) {
        const newTable = (createMatch[1] ?? createMatch[2] ?? '').toUpperCase();
        if (newTable && !tablesMap.has(newTable)) {
          tablesMap.set(newTable, { table: newTable, primaryKey: ['ID'] });
        }
      }

      const ts = ddlOpts.timestamp ?? Date.now();
      const entry: ReplicationLogEntry = {
        lsn: await allocateLsn(),
        txid: ddlOpts.txid ?? nextTxId(),
        origin: ddlOpts.origin ?? nodeId,
        publication: pubName,
        table: '$DDL',
        operation: 'DDL',
        key: {},
        after: null,
        before: null,
        ddlSql,
        timestamp: ts,
        hlc: hlc.now(ts),
      };

      await insertJournalEntry(entry);
      return entry;
    },

    async captureTableChanges(captureOpts = {}): Promise<ReplicationLogEntry[]> {
      if (isWildcard) {
        await publication.refreshPublishedTables();
      }
      const captured: ReplicationLogEntry[] = [];
      const txid = captureOpts.txid ?? nextTxId();
      const ts = captureOpts.timestamp ?? Date.now();
      // With capture triggers installed, writes made since the last capture are
      // already in the journal; the diff only refreshes the mirror for them.
      const alreadyJournalled = await triggerCapturedKeys(captureWatermark);
      const isTriggerCaptured = (
        tableUpper: string,
        rec: Record<string, unknown>,
        pkCols: readonly string[],
      ): boolean => alreadyJournalled.has(looseKey(tableUpper, rec, pkCols));

      for (const [tableUpper, cfg] of tablesMap.entries()) {
        const pkCols = cfg.primaryKey;
        let res: QueryResult<Row>;
        try {
          res = await db.query<Row>(`SELECT * FROM ${quoteIdent(tableUpper)}`);
        } catch {
          continue;
        }

        const prevMirror = tableMirrors.get(tableUpper) ?? new Map<string, Record<string, unknown>>();
        const nextMirror = new Map<string, Record<string, unknown>>();

        for (const rawRow of res.rows) {
          const normRow = normalizeRowKeysUpper(rawRow);
          if (!matchesRowFilter(normRow, cfg.where)) {
            continue;
          }
          const projectedRow =
            projectReplicatedRow(normRow, pkCols, cfg.columns, cfg.excludeColumns) ?? normRow;
          const keyRec = extractKeyRecord(projectedRow, pkCols);
          const k = serializeKeyRecord(keyRec, pkCols);
          nextMirror.set(k, projectedRow);

          const prevRow = prevMirror.get(k);
          if (isTriggerCaptured(tableUpper, keyRec, pkCols)) {
            continue;
          }
          if (!prevRow) {
            const entry: ReplicationLogEntry = {
              lsn: await allocateLsn(),
              txid,
              origin: nodeId,
              publication: pubName,
              table: tableUpper,
              operation: 'INSERT',
              key: keyRec,
              after: projectedRow,
              before: null,
              ddlSql: null,
              timestamp: ts,
              hlc: hlc.now(ts),
            };
            await insertJournalEntry(entry);
            captured.push(entry);
          } else if (!rowsEqual(prevRow, projectedRow)) {
            const entry: ReplicationLogEntry = {
              lsn: await allocateLsn(),
              txid,
              origin: nodeId,
              publication: pubName,
              table: tableUpper,
              operation: 'UPDATE',
              key: keyRec,
              after: projectedRow,
              before: prevRow,
              ddlSql: null,
              timestamp: ts,
              hlc: hlc.now(ts),
            };
            await insertJournalEntry(entry);
            captured.push(entry);
          }
        }

        for (const [k, prevRow] of prevMirror.entries()) {
          if (!nextMirror.has(k) && !isTriggerCaptured(tableUpper, extractKeyRecord(prevRow, pkCols), pkCols)) {
            const keyRec = extractKeyRecord(prevRow, pkCols);
            const entry: ReplicationLogEntry = {
              lsn: await allocateLsn(),
              txid,
              origin: nodeId,
              publication: pubName,
              table: tableUpper,
              operation: 'DELETE',
              key: keyRec,
              after: null,
              before: prevRow,
              ddlSql: null,
              timestamp: ts,
              hlc: hlc.now(ts),
            };
            await insertJournalEntry(entry);
            captured.push(entry);
          }
        }

        tableMirrors.set(tableUpper, nextMirror);
      }

      if (triggerCapture) {
        captureWatermark = await publication.currentLsn();
      }
      return captured;
    },

    async fetchChangesSince(
      sinceLsn: number,
      fetchOpts = {},
    ): Promise<ReplicationLogEntry[]> {
      let hasRowFilters = Boolean(options.transformRow);
      if (!hasRowFilters) {
        for (const cfg of tablesMap.values()) {
          if (cfg.where || cfg.transformRow) {
            hasRowFilters = true;
            break;
          }
        }
      }

      const canPushdownLimit =
        typeof db.execBatch === 'function' &&
        !hasRowFilters &&
        !fetchOpts.excludeOrigin &&
        typeof fetchOpts.limit === 'number' &&
        fetchOpts.limit > 0;

      const res = canPushdownLimit
        ? await db.query<Row>(
            `SELECT LSN, TXID, ORIGIN, "PUBLICATION", TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS FROM ${journalTable} WHERE LSN > ? AND "PUBLICATION" = ? ORDER BY LSN ASC ROWS 1 TO ?`,
            [sinceLsn, pubName, Math.trunc(fetchOpts.limit!)],
          )
        : await db.query<Row>(
            `SELECT LSN, TXID, ORIGIN, "PUBLICATION", TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS FROM ${journalTable} WHERE LSN > ? ORDER BY LSN ASC`,
            [sinceLsn],
          );

      const out: ReplicationLogEntry[] = [];
      for (const row of res.rows) {
        const origin = String(row.ORIGIN ?? row.origin ?? '');
        const pub = String(row.PUBLICATION ?? row.publication ?? pubName);
        if (pub !== pubName) continue;
        if (fetchOpts.excludeOrigin && origin === fetchOpts.excludeOrigin) {
          continue;
        }
        const tableUpper = String(row.TABLE_NAME ?? row.table_name ?? '');
        let op = String(row.OP ?? row.op ?? 'INSERT') as ReplicationOperation;
        const rawKeyJson = row.KEY_JSON ?? row.key_json;
        const rawAfterJson = row.AFTER_JSON ?? row.after_json;
        const rawBeforeJson = row.BEFORE_JSON ?? row.before_json;
        const rawDdlSql =
          row.DDL_SQL !== null && row.DDL_SQL !== undefined
            ? String(row.DDL_SQL)
            : row.ddl_sql !== null && row.ddl_sql !== undefined
              ? String(row.ddl_sql)
              : null;

        const key = decodeJson(rawKeyJson) ?? {};
        let after = decodeJson(rawAfterJson);
        const cfg = tablesMap.get(tableUpper);

        const canLazyDecodeBefore =
          rawBeforeJson !== null &&
          rawBeforeJson !== undefined &&
          rawBeforeJson !== '' &&
          !cfg?.where &&
          !cfg?.columns &&
          !cfg?.excludeColumns &&
          !cfg?.transformRow &&
          !options.transformRow;

        let eagerBefore: Record<string, unknown> | null = canLazyDecodeBefore
          ? null
          : decodeJson(rawBeforeJson);

        // Apply per-table row filter (`where`) and column projection (`columns` / `excludeColumns`)
        if (cfg && op !== 'DDL') {
          if (cfg.where) {
            const afterMatches = after ? matchesRowFilter(after, cfg.where) : false;
            const beforeMatches = eagerBefore ? matchesRowFilter(eagerBefore, cfg.where) : false;

            if (op === 'INSERT' && !afterMatches) {
              continue;
            }
            if (op === 'DELETE' && eagerBefore && !beforeMatches) {
              continue;
            }
            if (op === 'UPDATE') {
              if (!beforeMatches && !afterMatches) {
                continue;
              }
              if (beforeMatches && !afterMatches) {
                // Row moved out of this partial publication's scope -> emit synthetic DELETE
                op = 'DELETE';
                after = null;
              } else if (!beforeMatches && afterMatches) {
                // Row moved into this partial publication's scope -> emit synthetic INSERT
                op = 'INSERT';
                eagerBefore = null;
              }
            }
          }

          after = projectReplicatedRow(after, cfg.primaryKey, cfg.columns, cfg.excludeColumns);
          if (!canLazyDecodeBefore) {
            eagerBefore = projectReplicatedRow(
              eagerBefore,
              cfg.primaryKey,
              cfg.columns,
              cfg.excludeColumns,
            );
          }

          const rowTx = cfg.transformRow ?? options.transformRow;
          if (rowTx && op !== 'DELETE') {
            if (after) {
              after = await rowTx(after, {
                table: tableUpper,
                operation: op,
                key,
                origin,
              });
              if (!after) continue;
            }
            if (eagerBefore) {
              eagerBefore = await rowTx(eagerBefore, {
                table: tableUpper,
                operation: op,
                key,
                origin,
              });
            }
          }
        } else if (options.transformRow && op !== 'DDL' && op !== 'DELETE') {
          if (after) {
            after = await options.transformRow(after, {
              table: tableUpper,
              operation: op,
              key,
              origin,
            });
            if (!after) continue;
          }
          if (eagerBefore) {
            eagerBefore = await options.transformRow(eagerBefore, {
              table: tableUpper,
              operation: op,
              key,
              origin,
            });
          }
        }

        const lsnNum = Number(row.LSN ?? row.lsn ?? 0);
        const tsNum = Number(row.TS ?? row.ts ?? 0);
        const entryHlc =
          hlcByLsn.get(lsnNum) ??
          formatHlc({ wallMs: tsNum, counter: 0, nodeId: origin });

        const approxBytes =
          64 +
          tableUpper.length +
          (typeof rawKeyJson === 'string' ? rawKeyJson.length : 16) +
          (typeof rawAfterJson === 'string' ? rawAfterJson.length : 0) +
          (typeof rawBeforeJson === 'string' ? rawBeforeJson.length : 0) +
          (rawDdlSql ? rawDdlSql.length : 0);

        const entryObj: ReplicationLogEntry = {
          lsn: lsnNum,
          txid: String(row.TXID ?? row.txid ?? ''),
          origin,
          publication: pub,
          table: tableUpper,
          operation: op,
          key,
          after,
          before: eagerBefore,
          ddlSql: rawDdlSql,
          timestamp: tsNum,
          hlc: entryHlc,
        };

        if (canLazyDecodeBefore) {
          let decodedBefore: Record<string, unknown> | null | undefined;
          Object.defineProperty(entryObj, 'before', {
            enumerable: true,
            configurable: true,
            get(): Record<string, unknown> | null {
              if (decodedBefore === undefined) {
                decodedBefore = decodeJson(rawBeforeJson);
              }
              return decodedBefore;
            },
          });
        }

        Object.defineProperty(entryObj, '_approxBytes', {
          value: approxBytes,
          enumerable: false,
          configurable: true,
        });

        out.push(entryObj);
        if (fetchOpts.limit && out.length >= fetchOpts.limit) {
          break;
        }
      }
      return out;
    },

    async pruneJournal(upToLsn: number): Promise<number> {
      const beforeRes = await db.query<Row>(
        `SELECT LSN FROM ${journalTable} WHERE LSN <= ?`,
        [upToLsn],
      );
      const count = beforeRes.rows.length;
      if (count > 0) {
        await execStatement(
          db,
          `DELETE FROM ${journalTable} WHERE LSN <= ?`,
          [upToLsn],
        );
      }
      return count;
    },

    _syncMirrorFromRemote(table, op, key, after) {
      const tableUpper = normalizeTableName(table);
      const cfg = tablesMap.get(tableUpper) ?? {
        table: tableUpper,
        primaryKey: Object.keys(key).length > 0 ? Object.keys(key) : ['ID'],
      };
      updateMirrorRow(tableUpper, cfg.primaryKey, op, key, after);
    },
  };

  if (options.installTriggers) {
    await publication.installTriggers();
  }

  if (options.engineMode === 'native' || options.engineMode === 'auto') {
    try {
      await enableEnginePublication(db, {
        tables: isWildcard ? '*' : Array.from(tablesMap.keys()),
      });
    } catch (err) {
      if (options.engineMode === 'native') {
        throw err;
      }
    }
  }

  return publication;
}

// ---------------------------------------------------------------------------
// 2. `createSubscription` Implementation
// ---------------------------------------------------------------------------

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
  const mode = options.mode ?? options.snapshot?.mode ?? 'logical';
  const truncateExisting = options.truncateExisting ?? true;

  const snapshot =
    options.snapshot ??
    (await options.publication.exportSnapshot({
      mode,
      baseSnapshot: options.baseSnapshot,
      tableDdl: options.tableDdl,
    }));

  let rowsCopied = 0;
  let bytesTransferred = 0;

  if (snapshot.mode === 'page-diff' && snapshot.pageDiffBytes) {
    bytesTransferred = snapshot.pageDiffBytes.byteLength;
    if (typeof options.targetDb.applyDiff === 'function') {
      await options.targetDb.applyDiff(snapshot.pageDiffBytes);
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

      try {
        for (const tbl of snapshot.tables) {
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

    if (typeof options.targetDb.transaction === 'function') {
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

  await ensureTableSafe(
    targetDb,
    `CREATE TABLE ${watermarkTable} (
      SUB_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
      LAST_LSN BIGINT NOT NULL,
      UPDATED_AT BIGINT NOT NULL
    )`,
  );

  const dlqManager = await createReplicationDlq(targetDb, {
    subscriptionName: subName,
    dlqTable: options.dlqTable ?? DEFAULT_REPL_DLQ_TABLE,
  });

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
    const res = await targetDb.query<Row>(
      `SELECT LAST_LSN FROM ${watermarkTable} WHERE SUB_NAME = ?`,
      [subName],
    );
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
    const existing = await targetDb.query<Row>(
      `SELECT SUB_NAME FROM ${watermarkTable} WHERE SUB_NAME = ?`,
      [subName],
    );
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

// ---------------------------------------------------------------------------
// 3. High-Level Primary/Replica & Bidirectional Sync (`replicateDatabases`)
// ---------------------------------------------------------------------------

/** Options for {@link replicateDatabases}. */
export interface ReplicateDatabasesOptions {
  /** Primary database (`FirebirdLite` or `FirebirdBrowser`). */
  primary: ReplicableDatabase;
  /** Replica database (`FirebirdBrowser` or `FirebirdLite`). */
  replica: ReplicableDatabase;
  /**
   * Tables to replicate between `primary` and `replica`, or `'*'` to publish
   * all user tables discovered in the primary database.
   */
  tables: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /**
   * Optional table names to exclude when `tables` is `'*'`.
   */
  excludeTables?: readonly string[];
  /**
   * When `true`, synchronizes the catalog (schema migrations via `diffSchema()` +
   * `generateMigration()` and sequence/generator watermarks) before each `sync()` cycle.
   *
   * @default false
   */
  syncCatalog?: boolean;
  /**
   * Replication direction:
   * - `'one-way'` (default): `primary -> replica`
   * - `'bidirectional'`: `primary <-> replica`
   *
   * @default 'one-way'
   */
  direction?: 'one-way' | 'bidirectional';
  /** Conflict resolution strategy (default `'primary-wins'` for one-way, `'last-write-wins'` for bidirectional). */
  onConflict?: ReplicationConflictStrategy;
  /** Called whenever a conflict is detected and resolved. */
  onConflictResolved?: (
    ctx: ReplicationConflictContext,
    resolution: 'remote-wins' | 'local-wins' | 'merge',
  ) => void;
  /** Optional custom node identifier for `primary` (default `'primary'`). */
  primaryNodeId?: string;
  /** Optional custom node identifier for `replica` (default `'replica'`). */
  replicaNodeId?: string;
  /**
   * When `true`, automatically installs `AFTER INSERT OR UPDATE OR DELETE`
   * Firebird PSQL triggers on published tables.
   *
   * @default false
   */
  installTriggers?: boolean;
  /**
   * When `true`, automatically prunes acknowledged journal entries (`pruneAcked()`)
   * after each sync cycle.
   *
   * @default false
   */
  autoPrune?: boolean;
  /**
   * When `true`, automatically bootstraps a fallen-behind replica from a snapshot
   * if its watermark lags behind `minRetainedLsn()`.
   *
   * @default false
   */
  autoBootstrap?: boolean;
  /**
   * Optional incremental search index hooks (`HnswIndex`, `Bm25Index`, etc.)
   * invoked as replicated rows are applied on the replica.
   */
  indexHooks?: readonly ReplicationIndexHook[];
  /**
   * Optional callback invoked after each individual `ReplicationLogEntry` is
   * applied on the replica.
   */
  onRowApplied?: (entry: ReplicationLogEntry) => void | Promise<void>;
}

/** Result of `replicator.sync()`. */
export interface ReplicationSyncCycleResult {
  readonly primaryToReplica: SubscriptionPullResult;
  readonly replicaToPrimary?: SubscriptionPullResult;
  readonly catalogSync?: SyncCatalogResult;
}

/** Handle returned by {@link replicateDatabases}. */
export interface DatabaseReplicator {
  readonly primaryPublication: ReplicationPublication;
  readonly replicaSubscription: ReplicationSubscription;
  readonly replicaPublication?: ReplicationPublication;
  readonly primarySubscription?: ReplicationSubscription;
  /**
   * Seed or re-seed the replica from `primaryPublication` via {@link bootstrapReplica}.
   */
  bootstrap(options?: {
    mode?: 'logical' | 'page-diff';
    baseSnapshot?: Uint8Array;
    tableDdl?: Readonly<Record<string, string>>;
    truncateExisting?: boolean;
  }): Promise<BootstrapReplicaResult>;
  /**
   * Synchronize schema migrations and sequence watermarks from `primary` to `replica`
   * via {@link syncCatalog}.
   */
  syncCatalog(
    options?: Omit<SyncCatalogOptions, 'sourceDb' | 'targetDb'>,
  ): Promise<SyncCatalogResult>;
  /**
   * Inspect live replication lag, watermark, and throughput telemetry on `replicaSubscription`.
   */
  stats(): Promise<ReplicationStats>;
  /**
   * Capture any unlogged table changes on `primary` (and `replica` in
   * `'bidirectional'` mode) and run a full replication cycle.
   */
  sync(): Promise<ReplicationSyncCycleResult>;
  /** Start continuous background replication. */
  start(): void;
  /** Stop continuous background replication. */
  stop(): Promise<void>;
}

/**
 * Set up primary-to-replica (`'one-way'`) or peer-to-peer (`'bidirectional'`)
 * logical/journal replication between two Firebird database instances.
 */
export async function replicateDatabases(
  options: ReplicateDatabasesOptions,
): Promise<DatabaseReplicator> {
  const direction = options.direction ?? 'one-way';
  const primaryNodeId = options.primaryNodeId ?? 'primary';
  const replicaNodeId = options.replicaNodeId ?? 'replica';
  const defaultStrategy: ReplicationConflictStrategy =
    direction === 'bidirectional' ? 'last-write-wins' : 'primary-wins';
  const conflictStrategy = options.onConflict ?? defaultStrategy;

  const primaryPublication = await createPublication(options.primary, {
    name: 'pub_primary',
    nodeId: primaryNodeId,
    tables: options.tables,
    excludeTables: options.excludeTables,
    installTriggers: options.installTriggers,
  });

  let replicaPublication: ReplicationPublication | undefined;
  let primarySubscription: ReplicationSubscription | undefined;

  if (direction === 'bidirectional') {
    replicaPublication = await createPublication(options.replica, {
      name: 'pub_replica',
      nodeId: replicaNodeId,
      tables: options.tables,
      excludeTables: options.excludeTables,
      installTriggers: options.installTriggers,
    });
  }

  const replicaSubscription = await createSubscription(options.replica, {
    name: 'sub_from_primary',
    nodeId: replicaNodeId,
    publication: primaryPublication,
    localPublication: replicaPublication,
    onConflict: conflictStrategy,
    onConflictResolved: options.onConflictResolved,
    autoPrune: options.autoPrune,
    autoBootstrap: options.autoBootstrap,
    indexHooks: options.indexHooks,
    onRowApplied: options.onRowApplied,
  });

  if (direction === 'bidirectional' && replicaPublication) {
    // When resolving conflicts on `primary` during `replica -> primary` pull,
    // `'primary-wins'` means local (`primary`) wins, whereas `'replica-wins'`
    // means remote (`replica`) wins.
    const reverseStrategy: ReplicationConflictStrategy =
      conflictStrategy === 'primary-wins'
        ? 'local-wins'
        : conflictStrategy === 'replica-wins'
          ? 'remote-wins'
          : conflictStrategy;

    primarySubscription = await createSubscription(options.primary, {
      name: 'sub_from_replica',
      nodeId: primaryNodeId,
      publication: replicaPublication,
      localPublication: primaryPublication,
      onConflict: reverseStrategy,
      onConflictResolved: options.onConflictResolved,
      autoPrune: options.autoPrune,
      autoBootstrap: options.autoBootstrap,
    });
  }

  return {
    primaryPublication,
    replicaSubscription,
    ...(replicaPublication ? { replicaPublication } : {}),
    ...(primarySubscription ? { primarySubscription } : {}),
    async bootstrap(bootOpts = {}): Promise<BootstrapReplicaResult> {
      return bootstrapReplica({
        targetDb: options.replica,
        publication: primaryPublication,
        subscription: replicaSubscription,
        mode: bootOpts.mode,
        baseSnapshot: bootOpts.baseSnapshot,
        tableDdl: bootOpts.tableDdl,
        truncateExisting: bootOpts.truncateExisting,
      });
    },
    async syncCatalog(catOpts = {}): Promise<SyncCatalogResult> {
      const catRes = await syncCatalog({
        sourceDb: options.primary,
        targetDb: options.replica,
        excludeTables: options.excludeTables,
        ...catOpts,
      });
      if (options.tables === '*') {
        await primaryPublication.refreshPublishedTables();
        if (replicaPublication) {
          await replicaPublication.refreshPublishedTables();
        }
      }
      return catRes;
    },
    async stats(): Promise<ReplicationStats> {
      return replicaSubscription.stats();
    },
    async sync(): Promise<ReplicationSyncCycleResult> {
      let catalogSync: SyncCatalogResult | undefined;
      if (options.syncCatalog) {
        catalogSync = await syncCatalog({
          sourceDb: options.primary,
          targetDb: options.replica,
          excludeTables: options.excludeTables,
        });
      }
      if (options.tables === '*') {
        await primaryPublication.refreshPublishedTables();
        if (replicaPublication) {
          await replicaPublication.refreshPublishedTables();
        }
      }
      await primaryPublication.captureTableChanges();
      if (replicaPublication) {
        await replicaPublication.captureTableChanges();
      }
      const primaryToReplica = await replicaSubscription.pull();
      let replicaToPrimary: SubscriptionPullResult | undefined;
      if (primarySubscription) {
        replicaToPrimary = await primarySubscription.pull();
        // If replica->primary resolved a conflict with 'local-wins' or 'merge',
        // pull any merged updates back to replica so both nodes converge.
        if (replicaToPrimary.conflictCount > 0) {
          await primaryPublication.captureTableChanges();
          await replicaSubscription.pull();
        }
      }
      return {
        primaryToReplica,
        ...(replicaToPrimary ? { replicaToPrimary } : {}),
        ...(catalogSync ? { catalogSync } : {}),
      };
    },
    start() {
      replicaSubscription.start();
      primarySubscription?.start();
    },
    async stop() {
      await replicaSubscription.stop();
      if (primarySubscription) {
        await primarySubscription.stop();
      }
    },
  };
}


// ---------------------------------------------------------------------------
// 6. Automatic Failover & Replica-to-Primary Promotion (`promoteReplica`) (M13 Item 3)
// ---------------------------------------------------------------------------

/** Options for {@link promoteReplica}. */
export interface PromoteReplicaOptions {
  /** The replica database being promoted to the new primary. */
  replicaDb: ReplicableDatabase;
  /**
   * Optional active subscription on the replica. When provided, `promoteReplica`
   * attempts a final `pull()` to drain pending changes, validates replication
   * lag against `maxAllowedLagEntries`, and stops the subscription.
   */
  subscription?: ReplicationSubscription;
  /**
   * Optional reachable previous primary database. When provided, sequence
   * watermarks are synchronized from `previousPrimaryDb` to `replicaDb` before
   * promotion so new sequence values do not collide.
   */
  previousPrimaryDb?: ReplicableDatabase;
  /**
   * Maximum allowed unapplied journal entries (`lagEntries`) before promotion
   * is refused (unless `force: true`).
   */
  maxAllowedLagEntries?: number;
  /**
   * When `true`, proceeds with promotion even if the final `subscription.pull()`
   * fails (e.g. dead old primary) or lag exceeds `maxAllowedLagEntries`.
   *
   * @default false
   */
  force?: boolean;
  /**
   * Node identifier for the newly promoted primary publication.
   * Defaults to `subscription?.nodeId ?? 'promoted_primary'`.
   */
  promotedNodeId?: string;
  /**
   * Publication name created on the promoted primary.
   *
   * @default 'default'
   */
  publicationName?: string;
  /**
   * Tables to publish on the promoted primary. When omitted, discovers and
   * publishes all user tables via `publishAllTables: true`.
   */
  tables?: ReadonlyArray<string | PublishedTableConfig>;
  /**
   * When `true`, installs `FB_REPL_TRG$<table>` PSQL triggers on the promoted
   * primary and clears any `'REPLICA'` role context variable.
   *
   * @default false
   */
  installTriggers?: boolean;
  /**
   * Optional safety increment added to all sequences on the promoted primary
   * so newly allocated IDs never collide with in-flight IDs from the old primary.
   *
   * @default 0
   */
  sequenceBuffer?: number;
  /**
   * Optional peer subscriptions to re-seed (`peer.setWatermark(promotedStartingLsn)`)
   * so remaining replicas seamlessly follow the newly promoted primary.
   */
  peerSubscriptions?: readonly ReplicationSubscription[];
}

/** Result returned by {@link promoteReplica}. */
export interface PromoteReplicaResult {
  /** Node identifier assigned to the promoted primary. */
  readonly promotedNodeId: string;
  /** Active `ReplicationPublication` created on the promoted primary. */
  readonly publication: ReplicationPublication;
  /** Final replica LSN watermark from the old primary before promotion. */
  readonly finalReplicaWatermark: number;
  /** Starting LSN of the publication on the newly promoted primary. */
  readonly promotedStartingLsn: number;
  /** Result of the final `subscription.pull()` drain, or `null` if skipped/unreachable. */
  readonly finalPullResult: SubscriptionPullResult | null;
  /** Number of Firebird sequences synchronized / bumped on the promoted primary. */
  readonly sequencesSynced: number;
  /** Upper-case table names published on the promoted primary. */
  readonly publishedTables: readonly string[];
  /** Number of PSQL triggers installed on the promoted primary. */
  readonly triggersInstalled: number;
  /** Whether the `FB_REPL_ROLE` session context variable was reset to `'PRIMARY'`. */
  readonly roleContextCleared: boolean;
}

/**
 * Promote a replica database to a primary database (`M13 Item 3`):
 * 1. Drains any final changes from `subscription.pull()` (tolerating an unreachable
 *    old primary when `force: true`), checks `maxAllowedLagEntries`, and stops the subscription.
 * 2. Synchronizes sequence watermarks from `previousPrimaryDb` (or existing replica
 *    sequences) with an optional `sequenceBuffer` safety margin.
 * 3. Resets `RDB$SET_CONTEXT('USER_SESSION', 'FB_REPL_ROLE', 'PRIMARY')` so triggers
 *    capture local writes on the promoted node.
 * 4. Creates a `ReplicationPublication` on `replicaDb`, captures the baseline mirror
 *    snapshot, and optionally re-seeds `peerSubscriptions` watermarks.
 */
export async function promoteReplica(
  options: PromoteReplicaOptions,
): Promise<PromoteReplicaResult> {
  const {
    replicaDb,
    subscription,
    previousPrimaryDb,
    maxAllowedLagEntries,
    force = false,
    publicationName = 'default',
    tables,
    installTriggers = false,
    sequenceBuffer = 0,
    peerSubscriptions = [],
  } = options;

  const promotedNodeId =
    options.promotedNodeId?.trim() ||
    subscription?.nodeId ||
    'promoted_primary';

  let finalPullResult: SubscriptionPullResult | null = null;
  let finalReplicaWatermark = 0;

  if (subscription) {
    try {
      finalPullResult = await subscription.pull();
    } catch (err) {
      if (!force) {
        throw err;
      }
    }

    const st = await subscription.stats();
    finalReplicaWatermark = st.replicaWatermark;

    if (
      maxAllowedLagEntries !== undefined &&
      !force &&
      st.lagEntries > maxAllowedLagEntries
    ) {
      throw new Error(
        `Cannot promote replica "${promotedNodeId}": lagEntries (${st.lagEntries}) exceeds maxAllowedLagEntries (${maxAllowedLagEntries})`,
      );
    }

    await subscription.stop();
  }

  let sequencesSynced = 0;
  const seqSource = previousPrimaryDb ?? replicaDb;
  try {
    const seqs = await exportSequences(seqSource);
    if (seqs.length > 0) {
      const bumped =
        sequenceBuffer > 0
          ? seqs.map((s) => ({ ...s, currentValue: s.currentValue + sequenceBuffer }))
          : seqs;
      sequencesSynced = await applySequences(replicaDb, bumped);
    }
  } catch (err) {
    if (!force && previousPrimaryDb) {
      throw err;
    }
  }

  let roleContextCleared = false;
  try {
    await replicaDb.query(
      `SELECT RDB$SET_CONTEXT('USER_SESSION', '${escapeSqlLiteral(DEFAULT_REPL_ROLE_CONTEXT_VAR)}', 'PRIMARY') AS CTX FROM RDB$DATABASE`,
    );
    roleContextCleared = true;
  } catch {
    roleContextCleared = false;
  }

  const publication = await createPublication(replicaDb, {
    name: publicationName,
    nodeId: promotedNodeId,
    tables: tables && tables.length > 0 ? tables : '*',
    installTriggers,
  });

  // Prime the mirror table on the promoted primary so existing replicated rows
  // are treated as baseline state rather than re-emitted as new INSERTs, while
  // keeping the journal clean at promotedStartingLsn.
  const preCaptureLsn = await publication.currentLsn();
  const baselineEntries = await publication.captureTableChanges();
  if (baselineEntries.length > 0 && preCaptureLsn === 0) {
    const latestLsn = await publication.currentLsn();
    await publication.pruneJournal(latestLsn);
  }
  const promotedStartingLsn = await publication.currentLsn();

  for (const peer of peerSubscriptions) {
    await peer.setWatermark(promotedStartingLsn);
  }

  const pubTables = [...publication.tables.keys()];
  return {
    promotedNodeId,
    publication,
    finalReplicaWatermark,
    promotedStartingLsn,
    finalPullResult,
    sequencesSynced,
    publishedTables: pubTables,
    triggersInstalled: installTriggers ? pubTables.length : 0,
    roleContextCleared,
  };
}


// ---------------------------------------------------------------------------
// 8. Time-Travel & Point-in-Time Querying over the Replication Journal (`asOfLsn` / `rewindToLsn`) (M13 Item 5)
// ---------------------------------------------------------------------------

/** Point-in-time target specification for {@link asOfLsn} and {@link rewindToLsn}. */
export interface TimeTravelTarget {
  /** Reconstruct or rewind state as of `entry.lsn <= lsn`. */
  lsn?: number;
  /** Reconstruct or rewind state as of `entry.timestamp <= timestamp`. */
  timestamp?: number;
  /** Reconstruct or rewind state as of `compareHlc(entry.hlc, hlc) <= 0`. */
  hlc?: string | HlcTimestamp;
  /** Optional single table filter (case-insensitive). */
  table?: string;
  /** Custom replication journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
}

/** Point-in-time table snapshot returned by {@link asOfLsn}. */
export interface TimeTravelSnapshot {
  /** Highest journal LSN included in the reconstructed state (`0` if before all entries). */
  readonly targetLsn: number;
  /** Current head LSN in `FB_REPL_JOURNAL$`. */
  readonly currentLsn: number;
  /** Total journal entries evaluated to reconstruct this snapshot. */
  readonly entriesEvaluated: number;
  /** Map of upper-case table name -> reconstructed array of rows at the target point in time. */
  readonly tables: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

/** Options for {@link rewindToLsn}. */
export interface RewindToLsnOptions {
  /** Target LSN number or point-in-time target (`lsn`, `timestamp`, or `hlc`). */
  target: number | TimeTravelTarget;
  /** Optional subset of tables to rewind (defaults to all tables affected after the target point). */
  tables?: readonly string[];
  /**
   * When `true` (the default), deletes undone journal entries (`LSN > rewoundToLsn`)
   * from `FB_REPL_JOURNAL$` and updates `FB_REPL_MIRROR$` to match the rewound state.
   *
   * @default true
   */
  truncateJournal?: boolean;
  /** Custom replication journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
  /** Custom mirror table name. @default 'FB_REPL_MIRROR$' */
  mirrorTable?: string;
}

/** Result returned by {@link rewindToLsn}. */
export interface RewindToLsnResult {
  /** Head LSN in `FB_REPL_JOURNAL$` prior to rewinding. */
  readonly previousHeadLsn: number;
  /** Target LSN to which the database was rewound. */
  readonly rewoundToLsn: number;
  /** Number of DML operations inverted in reverse chronological order. */
  readonly entriesUndone: number;
  /** Number of journal entries removed from `FB_REPL_JOURNAL$`. */
  readonly journalEntriesRemoved: number;
  /** Upper-case table names modified during the rewind. */
  readonly tablesAffected: readonly string[];
}

function normalizeTimeTravelTarget(
  target: number | TimeTravelTarget,
): TimeTravelTarget {
  if (typeof target === 'number') {
    return { lsn: target };
  }
  return target;
}

function entryMatchesTimeTravelCutoff(
  entry: ReplicationLogEntry,
  spec: TimeTravelTarget,
): boolean {
  if (spec.lsn !== undefined && entry.lsn > spec.lsn) {
    return false;
  }
  if (spec.timestamp !== undefined && entry.timestamp > spec.timestamp) {
    return false;
  }
  if (spec.hlc !== undefined) {
    if (!entry.hlc) return false;
    if (compareHlc(entry.hlc, spec.hlc) > 0) {
      return false;
    }
  }
  return true;
}

async function loadAllJournalEntries(
  db: ReplicableDatabase,
  journalTableName = DEFAULT_REPL_JOURNAL_TABLE,
): Promise<ReplicationLogEntry[]> {
  const jTable = quoteIdent(journalTableName);
  const res = await db.query(
    `SELECT LSN, TXID, ORIGIN, "PUBLICATION", TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS FROM ${jTable} WHERE LSN > ? ORDER BY LSN ASC`,
    [0],
  );
  return res.rows.map((r) => {
    const row = r as Record<string, unknown>;
    const lsn = Number(row.LSN ?? row.lsn ?? 0);
    const origin = String(row.ORIGIN ?? row.origin ?? '');
    const timestamp = Number(row.TS ?? row.ts ?? 0);
    return {
      lsn,
      txid: String(row.TXID ?? row.txid ?? ''),
      origin,
      publication: String(row.PUBLICATION ?? row.publication ?? 'default'),
      table: String(row.TABLE_NAME ?? row.table_name ?? ''),
      operation: String(row.OP ?? row.op ?? 'INSERT') as ReplicationOperation,
      key: decodeJson(row.KEY_JSON ?? row.key_json) ?? {},
      after: decodeJson(row.AFTER_JSON ?? row.after_json),
      before: decodeJson(row.BEFORE_JSON ?? row.before_json),
      ddlSql:
        row.DDL_SQL !== null && row.DDL_SQL !== undefined
          ? String(row.DDL_SQL)
          : row.ddl_sql !== null && row.ddl_sql !== undefined
            ? String(row.ddl_sql)
            : null,
      timestamp,
      hlc: formatHlc({ wallMs: timestamp, counter: 0, nodeId: origin }),
    };
  });
}

function canonicalRowKeyString(keyObj: Record<string, unknown>): string {
  const norm = normalizeRowKeysUpper(keyObj);
  const sortedKeys = Object.keys(norm).sort();
  return JSON.stringify(sortedKeys.map((k) => [k, norm[k]]));
}

/**
 * Reconstruct historical table rows at any past LSN, timestamp, or HLC
 * (`M13 Item 5`) without mutating the live database.
 *
 * Uses the `AFTER_JSON` / `BEFORE_JSON` audit trail in `FB_REPL_JOURNAL$`
 * to compute the exact row state of one or all published tables as of `target`.
 */
export async function asOfLsn(
  db: ReplicableDatabase,
  target: number | TimeTravelTarget,
): Promise<TimeTravelSnapshot> {
  const spec = normalizeTimeTravelTarget(target);
  const allEntries = await loadAllJournalEntries(
    db,
    spec.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE,
  );
  const currentLsn =
    allEntries.length > 0 ? allEntries[allEntries.length - 1]!.lsn : 0;

  const filterTable = spec.table ? normalizeTableName(spec.table) : null;
  const tableRowMaps = new Map<string, Map<string, Record<string, unknown>>>();

  let targetLsn = 0;
  let entriesEvaluated = 0;

  for (const entry of allEntries) {
    if (!entryMatchesTimeTravelCutoff(entry, spec)) {
      continue;
    }
    if (entry.lsn > targetLsn) {
      targetLsn = entry.lsn;
    }
    if (entry.operation === 'DDL') {
      continue;
    }
    const tbl = normalizeTableName(entry.table);
    if (filterTable && tbl !== filterTable) {
      continue;
    }
    entriesEvaluated++;

    let rowMap = tableRowMaps.get(tbl);
    if (!rowMap) {
      rowMap = new Map();
      tableRowMaps.set(tbl, rowMap);
    }

    const rowKey = canonicalRowKeyString(entry.key);
    if (entry.operation === 'DELETE') {
      rowMap.delete(rowKey);
    } else if (entry.after) {
      rowMap.set(rowKey, { ...normalizeRowKeysUpper(entry.after) });
    }
  }

  const tables: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  if (filterTable && !tableRowMaps.has(filterTable)) {
    tables[filterTable] = [];
  }
  for (const [tbl, rowMap] of tableRowMaps.entries()) {
    tables[tbl] = [...rowMap.values()];
  }

  return {
    targetLsn,
    currentLsn,
    entriesEvaluated,
    tables,
  };
}

/**
 * Roll back a database to a historical LSN, timestamp, or HLC (`M13 Item 5`)
 * by applying inverse DML operations (`INSERT` -> `DELETE`, `UPDATE` -> restore
 * `BEFORE_JSON`, `DELETE` -> re-insert `BEFORE_JSON`) in reverse `LSN DESC` order.
 */
export async function rewindToLsn(
  db: ReplicableDatabase,
  targetOrOptions: number | RewindToLsnOptions,
): Promise<RewindToLsnResult> {
  const opts: RewindToLsnOptions =
    typeof targetOrOptions === 'number'
      ? { target: targetOrOptions }
      : targetOrOptions;
  const spec = normalizeTimeTravelTarget(opts.target);
  const journalTableName =
    opts.journalTable ?? spec.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE;
  const mirrorTableName = opts.mirrorTable ?? DEFAULT_REPL_MIRROR_TABLE;
  const truncateJournal = opts.truncateJournal !== false;

  const allowedTables =
    opts.tables && opts.tables.length > 0
      ? new Set(opts.tables.map((t) => normalizeTableName(t)))
      : spec.table
        ? new Set([normalizeTableName(spec.table)])
        : null;

  const allEntries = await loadAllJournalEntries(db, journalTableName);
  const previousHeadLsn =
    allEntries.length > 0 ? allEntries[allEntries.length - 1]!.lsn : 0;

  let rewoundToLsn = 0;
  const toUndo: ReplicationLogEntry[] = [];

  for (const entry of allEntries) {
    if (entryMatchesTimeTravelCutoff(entry, spec)) {
      if (entry.lsn > rewoundToLsn) {
        rewoundToLsn = entry.lsn;
      }
    } else {
      toUndo.push(entry);
    }
  }

  // Apply inverse operations in reverse chronological order (highest LSN first)
  toUndo.sort((a, b) => b.lsn - a.lsn);

  const affectedSet = new Set<string>();
  let entriesUndone = 0;

  const runUndo = async (tx: {
    query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
  }) => {
    try {
      await tx.query(
        `SELECT RDB$SET_CONTEXT('USER_SESSION', '${escapeSqlLiteral(DEFAULT_REPL_ROLE_CONTEXT_VAR)}', 'REPLICA') AS CTX FROM RDB$DATABASE`,
      );
    } catch {
      // Ignore if test double doesn't implement RDB$SET_CONTEXT
    }

    for (const entry of toUndo) {
      if (entry.operation === 'DDL') continue;
      const tbl = normalizeTableName(entry.table);
      if (allowedTables && !allowedTables.has(tbl)) continue;

      const quotedTbl = quoteIdent(tbl);
      const pkEntries = Object.entries(normalizeRowKeysUpper(entry.key));
      if (pkEntries.length === 0) continue;

      if (entry.operation === 'INSERT') {
        const whereClause = pkEntries
          .map(([col]) => `${quoteIdent(col)} = ?`)
          .join(' AND ');
        const whereParams = pkEntries.map(([, val]) => val);
        await execStatement(
          tx,
          `DELETE FROM ${quotedTbl} WHERE ${whereClause}`,
          whereParams as QueryParams,
        );
        affectedSet.add(tbl);
        entriesUndone++;
      } else if (entry.operation === 'UPDATE' && entry.before) {
        const beforeNorm = normalizeRowKeysUpper(entry.before);
        const setEntries = Object.entries(beforeNorm);
        if (setEntries.length > 0) {
          const setClause = setEntries
            .map(([col]) => `${quoteIdent(col)} = ?`)
            .join(', ');
          const whereClause = pkEntries
            .map(([col]) => `${quoteIdent(col)} = ?`)
            .join(' AND ');
          const params = [
            ...setEntries.map(([, val]) => val),
            ...pkEntries.map(([, val]) => val),
          ];
          await execStatement(
            tx,
            `UPDATE ${quotedTbl} SET ${setClause} WHERE ${whereClause}`,
            params as QueryParams,
          );
          affectedSet.add(tbl);
          entriesUndone++;
        }
      } else if (entry.operation === 'DELETE' && entry.before) {
        const beforeNorm = normalizeRowKeysUpper(entry.before);
        const colEntries = Object.entries(beforeNorm);
        if (colEntries.length > 0) {
          const colsSql = colEntries.map(([col]) => quoteIdent(col)).join(', ');
          const placeholders = colEntries.map(() => '?').join(', ');
          const params = colEntries.map(([, val]) => val);
          await execStatement(
            tx,
            `INSERT INTO ${quotedTbl} (${colsSql}) VALUES (${placeholders})`,
            params as QueryParams,
          );
          affectedSet.add(tbl);
          entriesUndone++;
        }
      }
    }
  };

  if (typeof db.transaction === 'function') {
    await db.transaction(runUndo);
  } else {
    await runUndo(db);
  }

  let journalEntriesRemoved = 0;
  if (truncateJournal && toUndo.length > 0) {
    const jTable = quoteIdent(journalTableName);
    const remaining = allEntries.filter((e) => e.lsn <= rewoundToLsn);
    journalEntriesRemoved = allEntries.length - remaining.length;

    // Delete entries with LSN <= previousHeadLsn and re-insert kept entries if
    // the underlying database double only supports `DELETE ... WHERE LSN <= ?`,
    // or use `DELETE FROM ... WHERE LSN > ?` directly.
    await execStatement(
      db,
      `DELETE FROM ${jTable} WHERE LSN > ?`,
      [rewoundToLsn],
    );

    // Sync FB_REPL_MIRROR$ for affected tables so future captureTableChanges() matches rewound state
    const mTable = quoteIdent(mirrorTableName);
    const snapshot = await asOfLsn(db, {
      lsn: rewoundToLsn,
      journalTable: journalTableName,
    });
    for (const tbl of affectedSet) {
      try {
        await execStatement(
          db,
          `DELETE FROM ${mTable} WHERE "PUBLICATION" = ? AND TABLE_NAME = ?`,
          ['default', tbl],
        );
        const rows = snapshot.tables[tbl] ?? [];
        for (const r of rows) {
          const idVal = r.ID ?? Object.values(r)[0];
          const rowKey = JSON.stringify([idVal]);
          await execStatement(
            db,
            `INSERT INTO ${mTable} ("PUBLICATION", TABLE_NAME, ROW_KEY, ROW_JSON) VALUES (?, ?, ?, ?)`,
            ['default', tbl, rowKey, encodeJson(r)],
          );
        }
      } catch {
        // Mirror table may not exist if triggers were used exclusively
      }
    }
  }

  return {
    previousHeadLsn,
    rewoundToLsn,
    entriesUndone,
    journalEntriesRemoved,
    tablesAffected: [...affectedSet],
  };
}

// ---------------------------------------------------------------------------
// 9. Multi-Node Mesh & Hub-and-Spoke Replication Coordinator (`createReplicationMesh` / `createReplicationHub`) (M14 Item 1)
// ---------------------------------------------------------------------------

/** Node configuration within a multi-node replication mesh or hub-and-spoke cluster. */
export interface ReplicationMeshNodeConfig {
  /** Unique node identifier (e.g. `'hub'`, `'edge-eu'`, `'browser-tab-1'`). */
  nodeId: string;
  /** Database instance for this node. */
  db: ReplicableDatabase;
  /** Optional node role (`'hub'`, `'spoke'`, or `'peer'`). */
  role?: 'hub' | 'spoke' | 'peer';
  /** Optional per-node published table override. */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Optional outbound row transformer for this node's publication. */
  transformRow?: RowTransformer;
  /** Optional inbound entry validator for subscriptions targeting this node (`M15 Item 1`). */
  validateEntry?: CreateSubscriptionOptions['validateEntry'];
  /** Optional error handling policy (`'throw' | 'dlq' | 'skip'`) for subscriptions targeting this node (`M15 Item 1`). */
  onApplyError?: CreateSubscriptionOptions['onApplyError'];
  /** Optional DDL replay policy (`'apply' | 'idempotent' | 'additive-only'`) for subscriptions targeting this node (`M15 Item 5`). */
  ddlPolicy?: CreateSubscriptionOptions['ddlPolicy'];
}

/** Options for {@link createReplicationMesh} and {@link createReplicationHub}. */
export interface CreateReplicationMeshOptions {
  /** Participating database nodes ($N \ge 2$). */
  nodes: readonly ReplicationMeshNodeConfig[];
  /**
   * Cluster topology:
   * - `'mesh'` / `'full-mesh'`: every node subscribes to every other node directly ($N(N-1)$ links).
   * - `'hub-and-spoke'`: spoke nodes sync bidirectionally through a central hub node with transitive origin forwarding.
   *
   * @default 'mesh'
   */
  topology?: 'mesh' | 'full-mesh' | 'hub-and-spoke';
  /** Explicit hub node ID when `topology === 'hub-and-spoke'`. Defaults to the node with `role: 'hub'` or `nodes[0].nodeId`. */
  hubNodeId?: string;
  /** Default tables published across all nodes unless overridden per node. @default '*' */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Conflict resolution strategy across mesh links. @default 'last-write-wins' */
  onConflict?: ReplicationConflictStrategy;
  /** Callback invoked when a conflict is detected and resolved on any mesh link. */
  onConflictResolved?: (
    ctx: ReplicationConflictContext,
    resolution: 'remote-wins' | 'local-wins' | 'merge',
  ) => void;
  /**
   * Default quorum count of peer slots that must acknowledge an LSN before
   * `pruneQuorum()` deletes journal entries on a publishing node.
   */
  quorumSize?: number;
  /** Background polling interval in milliseconds when `start()` is called. @default 1000 */
  pollIntervalMs?: number;
}

/** Result of a full `mesh.sync()` convergence pass. */
export interface ReplicationMeshSyncResult {
  /** Number of sync rounds executed (1 for `'mesh'`, 2 for `'hub-and-spoke'` spoke->hub->spoke fanout). */
  readonly rounds: number;
  /** Total journal entries fetched across all directed links. */
  readonly totalFetched: number;
  /** Total journal entries applied across all directed links. */
  readonly totalApplied: number;
  /** Total conflicts resolved across all directed links. */
  readonly totalConflicts: number;
  /** Watermark matrix: `watermarks[subscriberNodeId][publisherNodeId] = lastAppliedLsn`. */
  readonly watermarks: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Latest formatted HLC timestamp string on each node (`hlcState[nodeId]`). */
  readonly hlcState: Readonly<Record<string, string>>;
}

/** Multi-node replication mesh or hub-and-spoke coordinator returned by {@link createReplicationMesh}. */
export interface ReplicationMesh {
  /** Active topology (`'mesh'` or `'hub-and-spoke'`). */
  readonly topology: 'mesh' | 'hub-and-spoke';
  /** Hub node ID when `topology === 'hub-and-spoke'`, or `null`. */
  readonly hubNodeId: string | null;
  /** Publications keyed by `nodeId`. */
  readonly publications: ReadonlyMap<string, ReplicationPublication>;
  /** Directed subscriptions keyed by `${subscriberNodeId}<-${publisherNodeId}`. */
  readonly subscriptions: ReadonlyMap<string, ReplicationSubscription>;
  /** Capture table changes on all nodes and converge changes across the cluster. */
  sync(): Promise<ReplicationMeshSyncResult>;
  /**
   * Prune journal entries on each publishing node that have been acknowledged by
   * at least `quorumSize` peer slots (`M14 Item 1`).
   */
  pruneQuorum(options?: {
    quorumSize?: number;
  }): Promise<Readonly<Record<string, number>>>;
  /** Return the current watermark matrix `watermarks[subscriberNodeId][publisherNodeId]`. */
  watermarkMatrix(): Promise<
    Readonly<Record<string, Readonly<Record<string, number>>>>
  >;
  /** Start background polling on all subscriptions. */
  start(): void;
  /** Stop background polling on all subscriptions. */
  stop(): Promise<void>;
}

/**
 * Create a multi-node replication coordinator (`M14 Item 1`) supporting
 * full `'mesh'` ($N \times (N-1)$ peer links) and `'hub-and-spoke'` (1 hub $\leftrightarrow$ $N$ spokes
 * with transitive change forwarding, HLC watermark matrices, and quorum pruning).
 */
export async function createReplicationMesh(
  options: CreateReplicationMeshOptions,
): Promise<ReplicationMesh> {
  if (options.nodes.length < 2) {
    throw new Error('createReplicationMesh requires at least 2 nodes');
  }
  const topology: 'mesh' | 'hub-and-spoke' =
    options.topology === 'hub-and-spoke' ? 'hub-and-spoke' : 'mesh';
  const defaultTables = options.tables ?? '*';
  const conflictStrategy = options.onConflict ?? 'last-write-wins';
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  const hubNode =
    topology === 'hub-and-spoke'
      ? (options.nodes.find((n) => n.nodeId === options.hubNodeId) ??
        options.nodes.find((n) => n.role === 'hub') ??
        options.nodes[0]!)
      : null;
  const hubNodeId = hubNode ? hubNode.nodeId : null;

  const publications = new Map<string, ReplicationPublication>();
  for (const nodeCfg of options.nodes) {
    const pub = await createPublication(nodeCfg.db, {
      name: `pub_${nodeCfg.nodeId}`,
      nodeId: nodeCfg.nodeId,
      tables: nodeCfg.tables ?? defaultTables,
      transformRow: nodeCfg.transformRow,
    });
    publications.set(nodeCfg.nodeId, pub);
  }

  const subscriptions = new Map<string, ReplicationSubscription>();
  const spokeToHubSubs: ReplicationSubscription[] = [];
  const hubToSpokeSubs: ReplicationSubscription[] = [];

  for (const targetNode of options.nodes) {
    for (const sourceNode of options.nodes) {
      if (targetNode.nodeId === sourceNode.nodeId) continue;

      if (topology === 'hub-and-spoke') {
        const isSpokeToHub =
          targetNode.nodeId === hubNodeId && sourceNode.nodeId !== hubNodeId;
        const isHubToSpoke =
          sourceNode.nodeId === hubNodeId && targetNode.nodeId !== hubNodeId;
        if (!isSpokeToHub && !isHubToSpoke) {
          continue;
        }
      }

      const sourcePub = publications.get(sourceNode.nodeId)!;
      const targetPub = publications.get(targetNode.nodeId)!;
      const linkKey = `${targetNode.nodeId}<-${sourceNode.nodeId}`;

      const sub = await createSubscription(targetNode.db, {
        name: `sub_${targetNode.nodeId}_from_${sourceNode.nodeId}`,
        nodeId: targetNode.nodeId,
        slotName: `slot_${targetNode.nodeId}_on_${sourceNode.nodeId}`,
        publication: sourcePub,
        localPublication: targetPub,
        hlc: targetPub.hlc,
        onConflict: conflictStrategy,
        onConflictResolved: options.onConflictResolved,
        pollIntervalMs,
        validateEntry: targetNode.validateEntry,
        onApplyError: targetNode.onApplyError,
        ddlPolicy: targetNode.ddlPolicy,
        // In hub-and-spoke mode, when Hub applies a row from Spoke A, forward it
        // into Hub's own journal (preserving Spoke A's origin) so Spoke B..N receive it!
        onRowApplied:
          topology === 'hub-and-spoke' && targetNode.nodeId === hubNodeId
            ? async (appliedEntry) => {
                if (appliedEntry.operation === 'DDL' && appliedEntry.ddlSql) {
                  await targetPub.recordDdl(appliedEntry.ddlSql, {
                    txid: appliedEntry.txid,
                    origin: appliedEntry.origin,
                    timestamp: appliedEntry.timestamp,
                  });
                } else if (appliedEntry.operation !== 'DDL') {
                  await targetPub.recordDml({
                    table: appliedEntry.table,
                    operation: appliedEntry.operation,
                    key: appliedEntry.key,
                    after: appliedEntry.after,
                    before: appliedEntry.before,
                    txid: appliedEntry.txid,
                    origin: appliedEntry.origin,
                    timestamp: appliedEntry.timestamp,
                  });
                }
              }
            : undefined,
      });

      subscriptions.set(linkKey, sub);
      if (topology === 'hub-and-spoke') {
        if (targetNode.nodeId === hubNodeId) {
          spokeToHubSubs.push(sub);
        } else {
          hubToSpokeSubs.push(sub);
        }
      }
    }
  }

  const watermarkMatrix = async (): Promise<
    Readonly<Record<string, Readonly<Record<string, number>>>>
  > => {
    const matrix: Record<string, Record<string, number>> = {};
    for (const n of options.nodes) {
      matrix[n.nodeId] = {};
    }
    for (const [linkKey, sub] of subscriptions.entries()) {
      const [subId, pubId] = linkKey.split('<-');
      if (subId && pubId) {
        matrix[subId]![pubId] = await sub.getWatermark();
      }
    }
    return matrix;
  };

  return {
    topology,
    hubNodeId,
    publications,
    subscriptions,

    async sync(): Promise<ReplicationMeshSyncResult> {
      for (const pub of publications.values()) {
        await pub.captureTableChanges();
      }

      let totalFetched = 0;
      let totalApplied = 0;
      let totalConflicts = 0;
      let rounds = 1;

      if (topology === 'hub-and-spoke') {
        rounds = 2;
        // Round 1: Hub pulls from all Spokes (and forwards their entries into Hub's journal)
        for (const sub of spokeToHubSubs) {
          const r = await sub.pull();
          totalFetched += r.fetchedCount;
          totalApplied += r.appliedCount;
          totalConflicts += r.conflictCount;
        }
        // Also capture any direct SQL writes on Hub
        const hubPub = hubNodeId ? publications.get(hubNodeId) : undefined;
        if (hubPub) {
          await hubPub.captureTableChanges();
        }
        // Round 2: All Spokes pull from Hub
        for (const sub of hubToSpokeSubs) {
          const r = await sub.pull();
          totalFetched += r.fetchedCount;
          totalApplied += r.appliedCount;
          totalConflicts += r.conflictCount;
        }
      } else {
        for (const sub of subscriptions.values()) {
          const r = await sub.pull();
          totalFetched += r.fetchedCount;
          totalApplied += r.appliedCount;
          totalConflicts += r.conflictCount;
        }
      }

      // Advance slot watermarks past any tail entries that originated on the subscriber itself
      for (const [linkKey, sub] of subscriptions.entries()) {
        const [, pubId] = linkKey.split('<-');
        const sourcePub = pubId ? publications.get(pubId) : undefined;
        if (!sourcePub) continue;
        const wmk = await sub.getWatermark();
        const headLsn = await sourcePub.currentLsn();
        if (headLsn > wmk) {
          const remaining = await sourcePub.fetchChangesSince(wmk, {
            limit: 1,
            excludeOrigin: sub.nodeId,
          });
          if (remaining.length === 0) {
            await sub.setWatermark(headLsn);
            await sourcePub.advanceSlot(sub.slotName, headLsn, {
              nodeId: sub.nodeId,
            });
          }
        }
      }

      const watermarks = await watermarkMatrix();
      const hlcState: Record<string, string> = {};
      for (const [nId, pub] of publications.entries()) {
        hlcState[nId] = formatHlc(pub.hlc.last());
      }

      return {
        rounds,
        totalFetched,
        totalApplied,
        totalConflicts,
        watermarks,
        hlcState,
      };
    },

    async pruneQuorum(pruneOpts = {}): Promise<Readonly<Record<string, number>>> {
      const prunedByNode: Record<string, number> = {};
      for (const [nId, pub] of publications.entries()) {
        const slots = await pub.listSlots();
        if (slots.length === 0) {
          prunedByNode[nId] = 0;
          continue;
        }
        const qSize = Math.max(
          1,
          Math.min(
            slots.length,
            pruneOpts.quorumSize ?? options.quorumSize ?? slots.length,
          ),
        );
        // Sort slot confirmedFlushLsn descending; the (qSize - 1) index is the highest LSN
        // acknowledged by at least `qSize` subscribers.
        const sortedDesc = slots
          .map((s) => s.confirmedFlushLsn)
          .sort((a, b) => b - a);
        const quorumLsn = sortedDesc[qSize - 1] ?? 0;
        prunedByNode[nId] =
          quorumLsn > 0 ? await pub.pruneJournal(quorumLsn) : 0;
      }
      return prunedByNode;
    },

    watermarkMatrix,

    start() {
      for (const sub of subscriptions.values()) {
        sub.start();
      }
    },

    async stop() {
      for (const sub of subscriptions.values()) {
        await sub.stop();
      }
    },
  };
}

/**
 * Convenience helper to create a `'hub-and-spoke'` replication coordinator (`M14 Item 1`).
 */
export async function createReplicationHub(
  options: Omit<CreateReplicationMeshOptions, 'topology'>,
): Promise<ReplicationMesh> {
  return createReplicationMesh({ ...options, topology: 'hub-and-spoke' });
}

// ---------------------------------------------------------------------------
// 10. Dead-Letter Queue (`FB_REPL_DLQ$`) & Quarantine / Retry Policy (M14 Item 2)
// ---------------------------------------------------------------------------


/**
 * Provision and manage a Dead-Letter Queue (`FB_REPL_DLQ$`) for poison replication
 * journal entries (`M14 Item 2`).
 */
export async function createReplicationDlq(
  db: ReplicableDatabase,
  options: ReplicationDlqOptions = {},
): Promise<ReplicationDlq> {
  const defaultSubName = (options.subscriptionName ?? 'default_sub').trim();
  const dlqTable = quoteIdent(options.dlqTable ?? DEFAULT_REPL_DLQ_TABLE);

  await ensureTableSafe(
    db,
    `CREATE TABLE ${dlqTable} (
      LSN BIGINT NOT NULL PRIMARY KEY,
      SUB_NAME VARCHAR(128) NOT NULL,
      ENTRY_JSON VARCHAR(8191) NOT NULL,
      ERROR_MSG VARCHAR(2000) NOT NULL,
      RETRY_COUNT INTEGER NOT NULL,
      QUARANTINED_AT BIGINT NOT NULL,
      LAST_RETRIED_AT BIGINT
    )`,
  );

  const rowToDlqEntry = (r: Row): ReplicationDlqEntry => {
    const rawJson = String(r.ENTRY_JSON ?? r.entry_json ?? '{}');
    const parsedEntry = JSON.parse(rawJson) as ReplicationLogEntry;
    const lastRetriedRaw = r.LAST_RETRIED_AT ?? r.last_retried_at;
    const retryCount = Number(r.RETRY_COUNT ?? r.retry_count ?? 0);
    return {
      lsn: Number(r.LSN ?? r.lsn ?? 0),
      subscriptionName: String(r.SUB_NAME ?? r.sub_name ?? defaultSubName),
      entry: parsedEntry,
      errorMessage: String(r.ERROR_MSG ?? r.error_msg ?? ''),
      retryCount,
      attempts: retryCount + 1,
      quarantinedAt: Number(r.QUARANTINED_AT ?? r.quarantined_at ?? 0),
      lastRetriedAt:
        lastRetriedRaw !== null && lastRetriedRaw !== undefined
          ? Number(lastRetriedRaw)
          : null,
    };
  };

  const recordFailure = async (
    entry: ReplicationLogEntry,
    error: unknown,
    subscriptionName = defaultSubName,
  ): Promise<ReplicationDlqEntry> => {
    const errMsg =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const now = Date.now();
    const entryJson = JSON.stringify(entry);

    const existing = await db.query<Row>(
      `SELECT * FROM ${dlqTable} WHERE LSN = ?`,
      [entry.lsn],
    );
    if (existing.rows.length > 0) {
      const prev = rowToDlqEntry(existing.rows[0]!);
      const nextRetry = prev.retryCount + 1;
      await execStatement(
        db,
        `UPDATE ${dlqTable} SET ERROR_MSG = ?, RETRY_COUNT = ?, LAST_RETRIED_AT = ? WHERE LSN = ?`,
        [errMsg, nextRetry, now, entry.lsn],
      );
      return {
        ...prev,
        errorMessage: errMsg,
        retryCount: nextRetry,
        attempts: nextRetry + 1,
        lastRetriedAt: now,
      };
    }

    await execStatement(
      db,
      `INSERT INTO ${dlqTable} (LSN, SUB_NAME, ENTRY_JSON, ERROR_MSG, RETRY_COUNT, QUARANTINED_AT, LAST_RETRIED_AT) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.lsn, subscriptionName, entryJson, errMsg, 0, now, null],
    );
    return {
      lsn: entry.lsn,
      subscriptionName,
      entry,
      errorMessage: errMsg,
      retryCount: 0,
      attempts: 1,
      quarantinedAt: now,
      lastRetriedAt: null,
    };
  };

  const listEntries = async (
    subscriptionName?: string,
  ): Promise<ReplicationDlqEntry[]> => {
    const res = await db.query<Row>(`SELECT * FROM ${dlqTable}`);
    const items = res.rows.map(rowToDlqEntry);
    const filtered = subscriptionName
      ? items.filter((i) => i.subscriptionName === subscriptionName)
      : items;
    return filtered.sort((a, b) => a.lsn - b.lsn);
  };

  return {
    recordFailure,

    async enqueue(input) {
      return recordFailure(
        input.entry,
        input.errorMessage,
        input.subscriptionName ?? defaultSubName,
      );
    },

    listEntries,

    async list(subscriptionName?: string): Promise<ReplicationDlqEntry[]> {
      return listEntries(subscriptionName);
    },

    async retryDlq(
      subscription: ReplicationSubscription,
      retryOpts = {},
    ): Promise<{ retried: number; succeeded: number; failed: number }> {
      const all = await listEntries(subscription.name);
      const candidates =
        retryOpts.lsn !== undefined
          ? all.filter((e) => e.lsn === retryOpts.lsn)
          : all;

      let retried = 0;
      let succeeded = 0;
      let failed = 0;

      for (const item of candidates) {
        retried++;
        const candidateEntry = retryOpts.transformEntry
          ? await retryOpts.transformEntry(item.entry)
          : item.entry;
        try {
          const res = await subscription.applyChanges([candidateEntry]);
          if (res.appliedCount > 0 && !res.dlqCount) {
            await execStatement(db, `DELETE FROM ${dlqTable} WHERE LSN = ?`, [
              item.lsn,
            ]);
            succeeded++;
          } else {
            failed++;
          }
        } catch (err) {
          await recordFailure(candidateEntry, err, subscription.name);
          failed++;
        }
      }

      return { retried, succeeded, failed };
    },

    async discardDlq(lsn?: number, subscriptionName?: string): Promise<number> {
      const current = await listEntries(subscriptionName);
      if (lsn !== undefined) {
        const exists = current.some((i) => i.lsn === lsn);
        if (!exists) return 0;
        await execStatement(db, `DELETE FROM ${dlqTable} WHERE LSN = ?`, [lsn]);
        return 1;
      }
      for (const item of current) {
        await execStatement(db, `DELETE FROM ${dlqTable} WHERE LSN = ?`, [
          item.lsn,
        ]);
      }
      return current.length;
    },
  };
}

// ---------------------------------------------------------------------------
// 11. Data Masking, PII Redaction & Row Transformation Pipelines (`transformRow`) (M14 Item 3)
// ---------------------------------------------------------------------------

async function sha256HexString(input: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fnv1aHash8(input).toLowerCase().repeat(8);
}

function isPiiStrategyValue(val: unknown): val is PiiColumnMaskStrategy {
  return (
    typeof val === 'function' ||
    val === 'redact' ||
    val === 'email-mask' ||
    val === 'card-last4' ||
    val === 'hash-fnv1a' ||
    val === 'hash-sha256' ||
    val === 'null' ||
    val === 'zero'
  );
}

/**
 * Create a declarative per-column or per-table/per-column PII masking and row
 * transformation pipeline (`M14 Item 3`) usable in
 * `CreatePublicationOptions.transformRow`, `PublishedTableConfig.transformRow`,
 * or `CreateSubscriptionOptions.transformRow`.
 */
export function createPiiMaskingTransformer(
  rules:
    | Readonly<Record<string, PiiColumnMaskStrategy>>
    | Readonly<Record<string, Readonly<Record<string, PiiColumnMaskStrategy>>>>,
  options: { salt?: string; redactedText?: string } = {},
): RowTransformer {
  const salt = options.salt ?? '';
  const redactedText = options.redactedText ?? '[REDACTED]';

  // Normalize rule table & column names to upper-case.
  // Supports both flat `{ EMAIL: 'email-mask' }` (applied to '*') and nested `{ USERS: { EMAIL: 'email-mask' } }`.
  const normalizedRules = new Map<string, Map<string, PiiColumnMaskStrategy>>();
  const wildcardRules = new Map<string, PiiColumnMaskStrategy>();

  for (const [key, val] of Object.entries(rules)) {
    if (isPiiStrategyValue(val)) {
      wildcardRules.set(key.toUpperCase(), val);
    } else if (val && typeof val === 'object') {
      const colRules = new Map<string, PiiColumnMaskStrategy>();
      for (const [col, strategy] of Object.entries(
        val as Record<string, PiiColumnMaskStrategy>,
      )) {
        colRules.set(col.toUpperCase(), strategy);
      }
      normalizedRules.set(normalizeTableName(key), colRules);
    }
  }
  if (wildcardRules.size > 0) {
    const existingWildcard = normalizedRules.get('*');
    if (existingWildcard) {
      for (const [k, v] of wildcardRules.entries()) existingWildcard.set(k, v);
    } else {
      normalizedRules.set('*', wildcardRules);
    }
  }

  return async (row, ctx) => {
    const specificRules = normalizedRules.get(normalizeTableName(ctx.table));
    const starRules = normalizedRules.get('*');
    if (!specificRules && !starRules) {
      return row;
    }

    const out: Record<string, unknown> = { ...row };
    for (const [rawCol, val] of Object.entries(out)) {
      const upperCol = rawCol.toUpperCase();
      const strategy =
        specificRules?.get(upperCol) ?? starRules?.get(upperCol);
      if (!strategy) continue;

      if (typeof strategy === 'function') {
        out[rawCol] = await strategy(val, out);
      } else if (strategy === 'null') {
        out[rawCol] = null;
      } else if (strategy === 'zero') {
        out[rawCol] = 0;
      } else if (strategy === 'redact') {
        out[rawCol] = val === null || val === undefined ? val : redactedText;
      } else if (strategy === 'email-mask') {
        if (typeof val === 'string' && val.includes('@')) {
          const [local = '', domain = ''] = val.split('@');
          if (local.length >= 2) {
            out[rawCol] = `${local[0]}***${local[local.length - 1]}@${domain}`;
          } else {
            const first = local.length > 0 ? local[0] : '*';
            out[rawCol] = `${first}***@${domain}`;
          }
        } else if (val !== null && val !== undefined) {
          out[rawCol] = redactedText;
        }
      } else if (strategy === 'card-last4') {
        if (val !== null && val !== undefined) {
          const digits = String(val).replace(/\D/g, '');
          const last4 = digits.slice(-4).padStart(4, '*');
          const maskLen = Math.max(8, digits.length - 4);
          out[rawCol] = `${'*'.repeat(maskLen)}${last4}`;
        }
      } else if (strategy === 'hash-fnv1a') {
        if (val !== null && val !== undefined) {
          out[rawCol] = fnv1aHash8(`${salt}:${String(val)}`).toLowerCase();
        }
      } else if (strategy === 'hash-sha256') {
        if (val !== null && val !== undefined) {
          out[rawCol] = await sha256HexString(`${salt}:${String(val)}`);
        }
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// 12. Journal Archival & Point-in-Time Recovery (PITR) Bundles (`exportJournalArchive` / `applyJournalArchive`) (M14 Item 4)
// ---------------------------------------------------------------------------

/** A single encrypted/compressed segment inside a {@link ReplicationJournalArchive}. */
export interface JournalArchiveSegment {
  /** Monotonic 1-based segment sequence number. */
  readonly sequence: number;
  /** First LSN in this segment. */
  readonly startLsn: number;
  /** Last LSN in this segment. */
  readonly endLsn: number;
  /** Number of journal entries in this segment. */
  readonly entryCount: number;
  /** Minimum entry epoch timestamp (`Date.now()`) in this segment. */
  readonly minTimestamp: number;
  /** Maximum entry epoch timestamp (`Date.now()`) in this segment. */
  readonly maxTimestamp: number;
  /** Whether the segment payload is Gzip-compressed. */
  readonly compressed: boolean;
  /** Whether the segment payload is encrypted with AES-256-GCM. */
  readonly encrypted: boolean;
  /** Binary wire bytes produced by {@link encodeEncryptedJournalSegment}. */
  readonly bytes: Uint8Array;
}

/** Portable Point-in-Time Recovery (PITR) archive bundle returned by {@link exportJournalArchive}. */
export interface ReplicationJournalArchive {
  /** Archive format identifier. */
  readonly format: 'firebird-repl-archive-v1';
  /** Source publication name. */
  readonly publication: string;
  /** Epoch timestamp (`Date.now()`) when the archive was created. */
  readonly createdAt: number;
  /** Optional base snapshot (`PublicationSnapshot`) taken before the journal stream. */
  readonly baseSnapshot: PublicationSnapshot | null;
  /** Ordered chain of binary/encrypted journal segments. */
  readonly segments: readonly JournalArchiveSegment[];
  /** Total journal entries across all segments. */
  readonly entryCount: number;
  /** Alias for {@link entryCount}. */
  readonly totalEntries: number;
  /** Minimum LSN across all segments (`0` if empty). */
  readonly startLsn: number;
  /** Alias for {@link startLsn}. */
  readonly minLsn: number;
  /** Maximum LSN across all segments (`0` if empty). */
  readonly endLsn: number;
  /** Alias for {@link endLsn}. */
  readonly maxLsn: number;
}

/** Options for {@link exportJournalArchive}. */
export interface ExportJournalArchiveOptions {
  /** Source publication to export from (optional when passed as the first parameter). */
  publication?: ReplicationPublication;
  /**
   * When `true` (default when `sinceLsn === 0`), includes a logical `baseSnapshot`
   * of all published tables at LSN 0 / current state.
   *
   * @default false
   */
  includeBaseSnapshot?: boolean;
  /** Export journal entries with `LSN > sinceLsn`. @default 0 */
  sinceLsn?: number;
  /** Optional minimum LSN (inclusive) to export (`LSN >= fromLsn`). */
  fromLsn?: number;
  /** Optional maximum LSN (inclusive) to export (`LSN <= toLsn`). */
  toLsn?: number;
  /** Maximum number of journal entries packed into each binary segment. @default 100 */
  maxEntriesPerSegment?: number;
  /** Alias for `maxEntriesPerSegment`. */
  segmentMaxEntries?: number;
  /** Optional AES-256-GCM encryption key for the segment chain. */
  key?: Uint8Array | CryptoKey | string;
  /** Whether to Gzip-compress each segment. @default true */
  compress?: boolean;
  /** Optional Additional Authenticated Data (AAD) for AES-256-GCM. */
  aad?: Uint8Array | string;
}

/** Options for {@link applyJournalArchive}. */
export interface ApplyJournalArchiveOptions {
  /** Target database to restore into (optional when passed as the first parameter). */
  targetDb?: ReplicableDatabase;
  /** PITR archive bundle produced by {@link exportJournalArchive} (optional when passed as the second parameter). */
  archive?: ReplicationJournalArchive;
  /**
   * Optional Point-in-Time Recovery cutoff (`lsn`, `timestamp`, or `hlc`).
   * Only journal entries matching `<= target` are replayed onto `targetDb`.
   */
  target?: number | TimeTravelTarget;
  /** Decryption key if the archive segments were encrypted. */
  key?: Uint8Array | CryptoKey | string;
  /** Additional Authenticated Data (AAD) if the archive segments were encrypted with AAD. */
  aad?: Uint8Array | string;
}

/** Result returned by {@link applyJournalArchive}. */
export interface ApplyJournalArchiveResult {
  /** Number of rows seeded from `archive.baseSnapshot`. */
  readonly bootstrappedRows: number;
  /** Number of archive segments decoded and verified. */
  readonly segmentsDecoded: number;
  /** Number of journal entries replayed up to `target`. */
  readonly entriesApplied: number;
  /** Alias for {@link entriesApplied}. */
  readonly entriesReplayed: number;
  /** Highest LSN replayed during recovery. */
  readonly restoredToLsn: number;
  /** Alias for {@link restoredToLsn}. */
  readonly restoredUpToLsn: number;
}

function isPublicationLike(val: unknown): val is ReplicationPublication {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as ReplicationPublication).fetchChangesSince === 'function'
  );
}

/**
 * Package a publication's journal stream (and optional `baseSnapshot`) into a
 * chunked, compressed, and optionally AES-256-GCM encrypted Point-in-Time Recovery
 * archive (`M14 Item 4`).
 */
export async function exportJournalArchive(
  publicationOrOptions: ReplicationPublication | ExportJournalArchiveOptions,
  maybeOptions: ExportJournalArchiveOptions = {},
): Promise<ReplicationJournalArchive> {
  const options: ExportJournalArchiveOptions = isPublicationLike(publicationOrOptions)
    ? { ...maybeOptions, publication: publicationOrOptions }
    : publicationOrOptions;
  const pub = options.publication;
  if (!pub) {
    throw new Error('exportJournalArchive requires a publication');
  }

  const sinceLsn =
    options.fromLsn !== undefined ? Math.max(0, options.fromLsn - 1) : (options.sinceLsn ?? 0);
  const maxPerSeg = Math.max(
    1,
    options.maxEntriesPerSegment ?? options.segmentMaxEntries ?? 100,
  );
  const baseSnapshot = options.includeBaseSnapshot
    ? await pub.exportSnapshot({ mode: 'logical' })
    : null;

  const rawEntries = await pub.fetchChangesSince(sinceLsn);
  const entries = rawEntries.filter((e) => {
    if (options.fromLsn !== undefined && e.lsn < options.fromLsn) return false;
    if (options.toLsn !== undefined && e.lsn > options.toLsn) return false;
    return true;
  });
  const segments: JournalArchiveSegment[] = [];
  const compress = options.compress ?? true;
  const encrypted = options.key !== undefined;

  for (let i = 0; i < entries.length; i += maxPerSeg) {
    const chunk = entries.slice(i, i + maxPerSeg);
    const seq = segments.length + 1;
    const startLsn = chunk[0]!.lsn;
    const endLsn = chunk[chunk.length - 1]!.lsn;
    const minTimestamp = Math.min(...chunk.map((e) => e.timestamp));
    const maxTimestamp = Math.max(...chunk.map((e) => e.timestamp));

    const bytes = await encodeEncryptedJournalSegment(chunk, {
      sequence: seq,
      state: 'archivable',
      key: options.key,
      compress,
      aad: options.aad,
    });

    segments.push({
      sequence: seq,
      startLsn,
      endLsn,
      entryCount: chunk.length,
      minTimestamp,
      maxTimestamp,
      compressed: compress,
      encrypted,
      bytes,
    });
  }

  const minLsn = entries.length > 0 ? entries[0]!.lsn : 0;
  const maxLsn = entries.length > 0 ? entries[entries.length - 1]!.lsn : 0;

  return {
    format: 'firebird-repl-archive-v1',
    publication: pub.name,
    createdAt: Date.now(),
    baseSnapshot,
    segments,
    entryCount: entries.length,
    totalEntries: entries.length,
    startLsn: minLsn,
    minLsn,
    endLsn: maxLsn,
    maxLsn,
  };
}

/**
 * Restore a target database from a {@link ReplicationJournalArchive} up to an
 * optional Point-in-Time Recovery (`target` LSN, timestamp, or HLC) (`M14 Item 4`).
 */
export async function applyJournalArchive(
  targetDbOrOptions: ReplicableDatabase | ApplyJournalArchiveOptions,
  maybeArchive?: ReplicationJournalArchive,
  maybeOptions: ApplyJournalArchiveOptions = {},
): Promise<ApplyJournalArchiveResult> {
  const options: ApplyJournalArchiveOptions =
    maybeArchive !== undefined
      ? {
          ...maybeOptions,
          targetDb: targetDbOrOptions as ReplicableDatabase,
          archive: maybeArchive,
        }
      : (targetDbOrOptions as ApplyJournalArchiveOptions);

  const targetDb = options.targetDb;
  const archive = options.archive;
  if (!targetDb || !archive) {
    throw new Error('applyJournalArchive requires targetDb and archive');
  }

  const tempSub = await createSubscription(targetDb, {
    name: `pitr_restore_${archive.publication}`,
    nodeId: 'pitr_restore_node',
    publication: {
      name: archive.publication,
      fetchChangesSince: async () => [],
    },
  });

  let bootstrappedRows = 0;
  if (archive.baseSnapshot) {
    const dummyPub = {
      name: archive.publication,
      exportSnapshot: async () => archive.baseSnapshot!,
      registerSlot: async () => ({
        slotName: 'pitr',
        publication: archive.publication,
        nodeId: 'pitr',
        confirmedFlushLsn: 0,
        lastSeenAt: Date.now(),
        ttlMs: 0,
      }),
    } as unknown as ReplicationPublication;

    const bootRes = await bootstrapReplica({
      targetDb,
      publication: dummyPub,
      subscription: tempSub,
      snapshot: archive.baseSnapshot,
    });
    bootstrappedRows = bootRes.rowsCopied;
  }

  const cutoffSpec =
    options.target !== undefined
      ? normalizeTimeTravelTarget(options.target)
      : null;

  const decodedEntries: ReplicationLogEntry[] = [];
  let segmentsDecoded = 0;

  for (const seg of archive.segments) {
    const decoded = await decodeEncryptedJournalSegment(seg.bytes, {
      key: options.key,
      aad: options.aad,
    });
    segmentsDecoded++;
    for (const entry of decoded.segment.entries) {
      if (cutoffSpec && !entryMatchesTimeTravelCutoff(entry, cutoffSpec)) {
        continue;
      }
      decodedEntries.push(entry);
    }
  }

  const pullRes = await tempSub.applyChanges(decodedEntries);
  return {
    bootstrappedRows,
    segmentsDecoded,
    entriesApplied: pullRes.appliedCount,
    entriesReplayed: pullRes.appliedCount,
    restoredToLsn: pullRes.currentLsn,
    restoredUpToLsn: pullRes.currentLsn,
  };
}

// ---------------------------------------------------------------------------
// 13. Journal Retention, Compaction & Automated PITR Archival Policy (M15 Item 3)
// ---------------------------------------------------------------------------

/** Options for {@link applyRetentionPolicy}. */
export interface JournalRetentionPolicyOptions {
  /**
   * Maximum number of entries to retain in `FB_REPL_JOURNAL$` for this publication.
   * Entries older than the newest `maxEntries` are eligible for pruning (subject to active slot watermarks unless `ignoreSlotWatermarks` is `true`).
   */
  maxEntries?: number;
  /**
   * Maximum age in milliseconds for retained journal entries (`now - entry.timestamp > maxAgeMs`).
   */
  maxAgeMs?: number;
  /**
   * When `true`, runs {@link compactJournal} on the remaining unpruned journal entries.
   * @default true
   */
  compact?: boolean;
  /**
   * When `true`, exports pruned entries into a `ReplicationJournalArchive` bundle before deleting them from `FB_REPL_JOURNAL$`.
   * @default false
   */
  archiveBeforePrune?: boolean;
  /** Optional AES-256-GCM key used when `archiveBeforePrune` is `true`. */
  archiveKey?: CryptoKey | Uint8Array | string;
  /** Optional segment size when `archiveBeforePrune` is `true`. @default 200 */
  archiveSegmentMaxEntries?: number;
  /**
   * When `true`, allows `maxEntries` / `maxAgeMs` pruning even when no active slots exist
   * or beyond unacknowledged slot watermarks.
   * @default false
   */
  ignoreSlotWatermarks?: boolean;
  /** Override current timestamp (`Date.now()`) for deterministic testing. */
  now?: number;
  /** Custom journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
}

/** Result returned by {@link applyRetentionPolicy}. */
export interface JournalRetentionPolicyResult {
  /** Safe LSN watermark up to which entries were pruned (`null` if no entries were pruned). */
  readonly prunedUpToLsn: number | null;
  /** Number of journal entries deleted by the retention policy. */
  readonly prunedEntries: number;
  /** Expired replication slot names dropped during slot TTL cleanup. */
  readonly expiredSlots: readonly string[];
  /** Result of journal compaction if `compact !== false`, or `null`. */
  readonly compaction: JournalCompactionResult | null;
  /** Exported PITR archive of the pruned entries if `archiveBeforePrune` was `true` and entries were pruned, or `null`. */
  readonly archive: ReplicationJournalArchive | null;
}

/**
 * Collapse superseded per-row mutations in `FB_REPL_JOURNAL$` within the specified LSN window (`M15 Item 3`):
 * - `INSERT` + $N \times$ `UPDATE` $\rightarrow$ single `INSERT` at the latest LSN with the final `after` state.
 * - `UPDATE` + $N \times$ `UPDATE` $\rightarrow$ single `UPDATE` at the latest LSN with the earliest `before` and latest `after` state.
 * - `UPDATE` + `DELETE` $\rightarrow$ single `DELETE` at the latest LSN with the earliest `before` state.
 * - `INSERT` + ($\dots$) + `DELETE` $\rightarrow$ completely elided when `elideTransientInserts !== false` (since the row never existed before the window and is deleted by the end of the window).
 * - `DDL` entries act as per-table barriers (mutations before a DDL on the same table are not merged across the DDL boundary).
 */
export async function compactJournal(
  db: ReplicableDatabase,
  options: CompactJournalOptions = {},
): Promise<JournalCompactionResult> {
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);
  const elideTransientInserts = options.elideTransientInserts ?? true;

  let res: QueryResult<Row>;
  try {
    res = await db.query<Row>(
      `SELECT * FROM ${journalTable} ORDER BY LSN ASC`,
    );
  } catch {
    return {
      entriesBefore: 0,
      entriesAfter: 0,
      entriesRemoved: 0,
      keysCompacted: 0,
      highestLsn: 0,
    };
  }

  const pubFilter = options.publication ? options.publication.trim() : null;
  const entries: ReplicationLogEntry[] = res.rows
    .map((r) => ({
      lsn: Number(r.LSN ?? r.lsn ?? 0),
      txid: String(r.TXID ?? r.txid ?? ''),
      origin: String(r.ORIGIN ?? r.origin ?? ''),
      publication: String(r.PUBLICATION ?? r.publication ?? 'default'),
      table: String(r.TABLE_NAME ?? r.table_name ?? ''),
      operation: String(r.OP ?? r.op ?? 'INSERT').toUpperCase() as ReplicationOperation,
      key: decodeJson(r.KEY_JSON ?? r.key_json ?? r.ROW_KEY ?? r.row_key) ?? {},
      after: decodeJson(r.AFTER_JSON ?? r.after_json ?? r.AFTER_ROW ?? r.after_row),
      before: decodeJson(r.BEFORE_JSON ?? r.before_json ?? r.BEFORE_ROW ?? r.before_row),
      ddlSql:
        r.DDL_SQL !== null && r.DDL_SQL !== undefined
          ? String(r.DDL_SQL)
          : r.ddl_sql !== null && r.ddl_sql !== undefined
            ? String(r.ddl_sql)
            : null,
      timestamp: Number(r.TS ?? r.ts ?? 0),
      hlc:
        r.HLC !== null && r.HLC !== undefined && String(r.HLC).length > 0
          ? String(r.HLC)
          : r.hlc !== null && r.hlc !== undefined && String(r.hlc).length > 0
            ? String(r.hlc)
            : undefined,
    }))
    .filter((e) => {
      if (pubFilter && e.publication !== pubFilter) return false;
      if (options.fromLsn !== undefined && e.lsn < options.fromLsn) return false;
      if (options.upToLsn !== undefined && e.lsn > options.upToLsn) return false;
      return true;
    });

  if (entries.length === 0) {
    return {
      entriesBefore: 0,
      entriesAfter: 0,
      entriesRemoved: 0,
      keysCompacted: 0,
      highestLsn: 0,
    };
  }

  interface ChainState {
    entries: ReplicationLogEntry[];
    netOp: 'INSERT' | 'UPDATE' | 'DELETE' | 'ELIDED';
    firstBefore: Record<string, unknown> | null;
    latestAfter: Record<string, unknown> | null;
    latestEntry: ReplicationLogEntry;
  }

  let ddlEpoch = 0;
  const chains = new Map<string, ChainState>();
  const keptDdlEntries: ReplicationLogEntry[] = [];

  for (const entry of entries) {
    if (entry.operation === 'DDL' || entry.table === '$DDL') {
      ddlEpoch++;
      keptDdlEntries.push(entry);
      continue;
    }

    const tableUpper = normalizeTableName(entry.table);
    const normKey = normalizeRowKeysUpper(entry.key);
    const pkCols = Object.keys(normKey).sort();
    const chainId = `${entry.publication}|${ddlEpoch}|${tableUpper}|${serializeKeyRecord(normKey, pkCols)}`;

    const existing = chains.get(chainId);
    if (!existing) {
      chains.set(chainId, {
        entries: [entry],
        netOp: entry.operation,
        firstBefore: entry.before,
        latestAfter: entry.after,
        latestEntry: entry,
      });
      continue;
    }

    existing.entries.push(entry);
    existing.latestEntry = entry;

    if (existing.netOp === 'ELIDED') {
      // Re-inserted after an elided INSERT+DELETE cycle
      existing.netOp = entry.operation;
      existing.firstBefore = entry.before;
      existing.latestAfter = entry.after;
    } else if (existing.netOp === 'INSERT') {
      if (entry.operation === 'UPDATE') {
        existing.netOp = 'INSERT';
        existing.latestAfter = { ...(existing.latestAfter ?? {}), ...(entry.after ?? {}) };
      } else if (entry.operation === 'DELETE') {
        if (elideTransientInserts) {
          existing.netOp = 'ELIDED';
          existing.latestAfter = null;
        } else {
          existing.netOp = 'DELETE';
          existing.latestAfter = null;
        }
      } else if (entry.operation === 'INSERT') {
        existing.netOp = 'INSERT';
        existing.latestAfter = entry.after;
      }
    } else if (existing.netOp === 'UPDATE') {
      if (entry.operation === 'UPDATE') {
        existing.netOp = 'UPDATE';
        existing.latestAfter = { ...(existing.latestAfter ?? {}), ...(entry.after ?? {}) };
      } else if (entry.operation === 'DELETE') {
        existing.netOp = 'DELETE';
        existing.latestAfter = null;
      } else if (entry.operation === 'INSERT') {
        existing.netOp = 'UPDATE';
        existing.latestAfter = entry.after;
      }
    } else if (existing.netOp === 'DELETE') {
      if (entry.operation === 'INSERT') {
        existing.netOp = 'UPDATE';
        existing.latestAfter = entry.after;
      }
    }
  }

  const lsnsToDelete: number[] = [];
  const entriesToUpdate: ReplicationLogEntry[] = [];
  let keysCompacted = 0;

  for (const chain of chains.values()) {
    if (chain.entries.length <= 1) {
      continue;
    }
    keysCompacted++;
    if (chain.netOp === 'ELIDED') {
      for (const e of chain.entries) {
        lsnsToDelete.push(e.lsn);
      }
    } else {
      // Delete all earlier entries in the chain and update the latest entry in-place
      for (let i = 0; i < chain.entries.length - 1; i++) {
        lsnsToDelete.push(chain.entries[i]!.lsn);
      }
      const finalEntry: ReplicationLogEntry = {
        ...chain.latestEntry,
        operation: chain.netOp,
        before: chain.netOp === 'INSERT' ? null : chain.firstBefore,
        after: chain.netOp === 'DELETE' ? null : chain.latestAfter,
      };
      entriesToUpdate.push(finalEntry);
    }
  }

  for (const lsn of lsnsToDelete) {
    await execStatement(db, `DELETE FROM ${journalTable} WHERE LSN = ?`, [lsn]);
  }

  for (const upd of entriesToUpdate) {
    await execStatement(
      db,
      `UPDATE ${journalTable} SET OP = ?, AFTER_JSON = ?, BEFORE_JSON = ? WHERE LSN = ?`,
      [
        upd.operation,
        upd.after ? JSON.stringify(upd.after) : null,
        upd.before ? JSON.stringify(upd.before) : null,
        upd.lsn,
      ],
    );
  }

  const entriesBefore = entries.length;
  const entriesRemoved = lsnsToDelete.length;
  const entriesAfter = entriesBefore - entriesRemoved;

  let highestLsn = 0;
  for (const e of entries) {
    if (!lsnsToDelete.includes(e.lsn) && e.lsn > highestLsn) {
      highestLsn = e.lsn;
    }
  }
  for (const d of keptDdlEntries) {
    if (d.lsn > highestLsn) {
      highestLsn = d.lsn;
    }
  }

  return {
    entriesBefore,
    entriesAfter,
    entriesRemoved,
    keysCompacted,
    highestLsn,
  };
}

/**
 * Enforce an automated journal retention, PITR archival rotation, and row-compaction policy
 * on `FB_REPL_JOURNAL$` (`M15 Item 3`).
 */
export async function applyRetentionPolicy(
  db: ReplicableDatabase,
  publication: ReplicationPublication,
  options: JournalRetentionPolicyOptions = {},
): Promise<JournalRetentionPolicyResult> {
  const now = options.now ?? Date.now();
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);

  // 1. Expire stale slots and find active slot watermark ceiling
  const allSlots = await publication.listSlots();
  const expiredSlots: string[] = [];
  const activeSlots: ReplicationSlot[] = [];

  for (const slot of allSlots) {
    if (slot.ttlMs > 0 && now - slot.lastSeenAt > slot.ttlMs) {
      await publication.dropSlot(slot.slotName);
      expiredSlots.push(slot.slotName);
    } else {
      activeSlots.push(slot);
    }
  }

  const slotCeilingLsn =
    !options.ignoreSlotWatermarks && activeSlots.length > 0
      ? Math.min(...activeSlots.map((s) => s.confirmedFlushLsn))
      : Infinity;

  // 2. Determine candidate LSN cutoff from active slots, `maxEntries`, and `maxAgeMs`
  const allEntries = await publication.fetchChangesSince(0);
  let targetPruneLsn =
    activeSlots.length > 0 && !options.ignoreSlotWatermarks ? slotCeilingLsn : 0;

  if (options.maxEntries !== undefined && options.maxEntries >= 0) {
    if (allEntries.length > options.maxEntries) {
      const overflowCount = allEntries.length - options.maxEntries;
      const cutoffEntry = allEntries[overflowCount - 1];
      if (cutoffEntry && cutoffEntry.lsn > targetPruneLsn) {
        targetPruneLsn = Math.min(cutoffEntry.lsn, slotCeilingLsn);
      }
    }
  }

  if (options.maxAgeMs !== undefined && options.maxAgeMs >= 0) {
    const minTimestamp = now - options.maxAgeMs;
    for (const entry of allEntries) {
      if (entry.timestamp < minTimestamp && entry.lsn <= slotCeilingLsn) {
        if (entry.lsn > targetPruneLsn) {
          targetPruneLsn = entry.lsn;
        }
      }
    }
  }

  let archive: ReplicationJournalArchive | null = null;
  let prunedEntries = 0;
  let prunedUpToLsn: number | null = null;

  if (targetPruneLsn > 0 && Number.isFinite(targetPruneLsn)) {
    const prunable = allEntries.filter((e) => e.lsn <= targetPruneLsn);
    if (prunable.length > 0) {
      if (options.archiveBeforePrune) {
        archive = await exportJournalArchive(publication, {
          fromLsn: prunable[0]!.lsn,
          toLsn: targetPruneLsn,
          segmentMaxEntries: options.archiveSegmentMaxEntries ?? 200,
          key: options.archiveKey,
          includeBaseSnapshot: false,
        });
      }
      prunedEntries = await publication.pruneJournal(targetPruneLsn);
      prunedUpToLsn = targetPruneLsn;
    }
  }

  // 3. Optionally compact remaining unpruned journal entries
  let compaction: JournalCompactionResult | null = null;
  if (options.compact !== false) {
    compaction = await compactJournal(db, {
      publication: publication.name,
      fromLsn: prunedUpToLsn !== null ? prunedUpToLsn + 1 : undefined,
      journalTable: options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE,
    });
  }

  void journalTable;
  return {
    prunedUpToLsn,
    prunedEntries,
    expiredSlots,
    compaction,
    archive,
  };
}

