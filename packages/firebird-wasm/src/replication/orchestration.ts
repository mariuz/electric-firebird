/**
 * Bidirectional Sync (`replicateDatabases`), Failover Promotion (`promoteReplica`),
 * and Time-Travel / Rewind (`asOfLsn`, `rewindToLsn`).
 */

import type { QueryParams, QueryResult, Row } from '../types';
import type { StandardSchemaV1 } from '../schema-validation';
import {
  DEFAULT_REPL_JOURNAL_TABLE,
  DEFAULT_REPL_MIRROR_TABLE,
  DEFAULT_REPL_ROLE_CONTEXT_VAR,
  type BootstrapReplicaResult,
  type BootstrapStrategy,
  type CreateSubscriptionOptions,
  type HlcTimestamp,
  type PublishedTableConfig,
  type ReplicableDatabase,
  type ReplicationConflictContext,
  type ReplicationConflictStrategy,
  type ReplicationIndexHook,
  type ReplicationLogEntry,
  type ReplicationOperation,
  type ReplicationPublication,
  type ReplicationStats,
  type ReplicationSubscription,
  type SubscriptionPullResult,
  type SyncCatalogOptions,
  type SyncCatalogResult,
} from './types';
import {
  decodeJson,
  encodeJson,
  escapeSqlLiteral,
  execStatement,
  normalizeRowKeysUpper,
  normalizeTableName,
  quoteIdent,
} from './shared';
import { compareHlc, formatHlc } from './hlc-crdt';
import {
  applySequences,
  exportSequences,
  syncCatalog,
} from './catalog';
import { createPublication } from './publication';
import { bootstrapReplica } from './bootstrap';
import { createSubscription } from './subscription';

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
  /** Optional per-table Standard Schema v1 row validators (`M19 Item 4`). */
  tableSchemas?: Readonly<Record<string, StandardSchemaV1<unknown, Record<string, unknown>>>>;
  /** Error policy when row validation or SQL replay fails (`'throw' | 'dlq' | 'skip'`). */
  onApplyError?: CreateSubscriptionOptions['onApplyError'];
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
    bootstrapStrategy?: BootstrapStrategy;
    mode?: BootstrapStrategy;
    compressGzip?: boolean;
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
    tableSchemas: options.tableSchemas,
    onApplyError: options.onApplyError,
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
        bootstrapStrategy: bootOpts.bootstrapStrategy ?? bootOpts.mode,
        mode: bootOpts.mode ?? bootOpts.bootstrapStrategy,
        compressGzip: bootOpts.compressGzip,
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

export function normalizeTimeTravelTarget(
  target: number | TimeTravelTarget,
): TimeTravelTarget {
  if (typeof target === 'number') {
    return { lsn: target };
  }
  return target;
}

export function entryMatchesTimeTravelCutoff(
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

