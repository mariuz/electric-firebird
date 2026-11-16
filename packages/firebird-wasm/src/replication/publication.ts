/**
 * Logical & Engine-Backed Replication Publications (`publishAllTables`, `createPublication`).
 */

import type { QueryParams, QueryResult, Row } from '../types';
import { validateValueWithSchema } from '../schema-validation';
import {
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_LSN_SEQUENCE,
  DEFAULT_REPL_SLOTS_TABLE,
  DEFAULT_REPL_SLOT_TTL_MS,
  type CreatePublicationOptions,
  type InstalledReplicationTrigger,
  type JournalCompactionResult,
  type LogicalTableSnapshot,
  type PruneAckedResult,
  type PublicationSnapshot,
  type PublishedTableConfig,
  type RegisterReplicationSlotOptions,
  type ReplicableDatabase,
  type ReplicationLogEntry,
  type ReplicationOperation,
  type ReplicationPublication,
  type ReplicationSlot,
} from './types';
import {
  applyRowMutationToTable,
  decodeJson,
  encodeJson,
  ensureTableSafe,
  execStatement,
  extractKeyRecord,
  normalizeRowKeysUpper,
  normalizeTableName,
  quoteIdent,
  rowsEqual,
  serializeKeyRecord,
} from './shared';
import {
  createHlc,
  formatHlc,
  matchesRowFilter,
  projectReplicatedRow,
} from './hlc-crdt';
import {
  discoverUserTables,
  dropReplicationTriggers,
  installReplicationTriggers,
} from './catalog';
import { enableEnginePublication } from './native-changelog';
import { compactJournal } from './dlq-compaction';
import { exportPageDiff } from '../browser/snapshots';
import { compressGzipBytes } from './bootstrap';

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
        ...(item.validateSchema ? { validateSchema: item.validateSchema } : {}),
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
      const mode = snapOpts.bootstrapStrategy ?? snapOpts.mode ?? 'logical';
      const ts = Date.now();

      if (mode === 'binary-image') {
        const dumpCapable = db as ReplicableDatabase & {
          dumpDataDir?(): Promise<Uint8Array>;
          exportDatabase?(): Promise<Uint8Array>;
        };
        let rawBytes: Uint8Array | null = null;
        if (typeof dumpCapable.dumpDataDir === 'function') {
          rawBytes = await dumpCapable.dumpDataDir();
        } else if (typeof dumpCapable.exportDatabase === 'function') {
          rawBytes = await dumpCapable.exportDatabase();
        } else {
          throw new Error(
            "exportSnapshot({ mode: 'binary-image' }) requires a database supporting dumpDataDir()",
          );
        }
        const compress = Boolean(snapOpts.compressGzip);
        const databaseImageBytes =
          compress && rawBytes ? await compressGzipBytes(rawBytes) : rawBytes;
        return {
          publication: pubName,
          origin: nodeId,
          watermarkLsn,
          timestamp: ts,
          mode: 'binary-image',
          tables: [],
          databaseImageBytes,
          imageGzipped: compress,
          pageDiffBytes: null,
        };
      }

      if (mode === 'page-diff') {
        const diffCapable = db as ReplicableDatabase & {
          exportDiff?(baseSnapshot: unknown): Promise<Uint8Array>;
          dumpDataDir?(): Promise<Uint8Array>;
          exportDatabase?(): Promise<Uint8Array>;
        };
        let pageDiffBytes: Uint8Array | null = null;
        if (typeof diffCapable.exportDiff === 'function') {
          pageDiffBytes = await diffCapable.exportDiff(
            snapOpts.baseSnapshot ?? new Uint8Array(0),
          );
        } else if (typeof diffCapable.dumpDataDir === 'function') {
          const currentImage = await diffCapable.dumpDataDir();
          pageDiffBytes = exportPageDiff(
            snapOpts.baseSnapshot ?? new Uint8Array(0),
            currentImage,
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
          databaseImageBytes: null,
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

      let validatedFullAfter = fullAfter;
      if (tableCfg.validateSchema && validatedFullAfter) {
        const validated = await validateValueWithSchema(
          tableCfg.validateSchema,
          validatedFullAfter,
          { tableName: tableUpper },
        );
        validatedFullAfter = normalizeRowKeysUpper(validated as Record<string, unknown>);
      }

      if (applyLocally) {
        const lsnBeforeApply = triggerCapture ? await publication.currentLsn() : 0;
        await applyRowMutationToTable(
          db,
          tableUpper,
          pkCols,
          params.operation,
          keyRec,
          validatedFullAfter,
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
            updateMirrorRow(tableUpper, pkCols, params.operation, keyRec, validatedFullAfter);
            return last;
          }
        }
      }

      updateMirrorRow(tableUpper, pkCols, params.operation, keyRec, validatedFullAfter);

      const projectedAfter = projectReplicatedRow(
        validatedFullAfter,
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

