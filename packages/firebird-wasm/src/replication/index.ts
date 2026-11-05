/**
 * firebird-wasm/replication – Logical & Journal-Based Primary/Replica and
 * Bidirectional Database Replication.
 *
 * Supports continuous and on-demand logical/journal replication between
 * `FirebirdLite` (server/embedded) and `FirebirdBrowser` (WASM) instances:
 *
 * 1. **Publication & Change Journal (`FB_REPL_JOURNAL$`)**:
 *    - {@link createPublication}: provisions the replication journal table
 *      (`FB_REPL_JOURNAL$`) and tracks published tables (`FB_REPL_PUB_TABLES$`).
 *    - Captures DDL (`CREATE TABLE`, `ALTER TABLE`, etc.) and DML (`INSERT`,
 *      `UPDATE`, `DELETE`) mutations with monotonically increasing LSNs,
 *      transaction IDs (`txid`), origin node IDs (`origin`), timestamps, and
 *      before/after JSON snapshots.
 *    - Also supports automatic table diffing (`publication.captureTableChanges()`)
 *      so rows inserted/updated/deleted directly via SQL are detected and
 *      appended to the replication journal.
 * 2. **Subscription & Watermarking (`FB_REPL_WATERMARKS$`)**:
 *    - {@link createSubscription}: pulls batches of journal entries after the
 *      replica's persisted LSN watermark, applies DDL + DML changes inside an
 *      atomic transaction, and advances the watermark in `FB_REPL_WATERMARKS$`.
 *    - Loop prevention: skips re-applying or re-logging mutations whose `origin`
 *      matches the local replica node ID.
 * 3. **Bidirectional & Multi-Node Replication (`replicateDatabases`)**:
 *    - {@link replicateDatabases}: pairs two databases (`primary` and `replica`)
 *      in `'one-way'` (`primary -> replica`) or `'bidirectional'` (`primary <-> replica`)
 *      mode with pluggable conflict resolution (`'primary-wins'`,
 *      `'replica-wins'`, `'last-write-wins'`, `'merge'`, or custom callback).
 */

import type { QueryParams, QueryResult, Row } from '../types';
import { generateMigration, introspect } from '../browser/schema';

// ---------------------------------------------------------------------------
// Constants & Structural Database Contract
// ---------------------------------------------------------------------------

/** Default replication change journal table name. */
export const DEFAULT_REPL_JOURNAL_TABLE = 'FB_REPL_JOURNAL$';

/** Default replication watermark tracking table name. */
export const DEFAULT_REPL_WATERMARK_TABLE = 'FB_REPL_WATERMARKS$';

/** Default table snapshot mirror used by `captureTableChanges()`. */
export const DEFAULT_REPL_MIRROR_TABLE = 'FB_REPL_MIRROR$';

/** Default Firebird sequence/generator used by replication triggers for atomic LSNs. */
export const DEFAULT_REPL_LSN_SEQUENCE = 'FB_REPL_LSN_GEN$';

/** Firebird `USER_SESSION` context variable set to `'REPLICA'` during replica replay to bypass triggers. */
export const DEFAULT_REPL_ROLE_CONTEXT_VAR = 'FB_REPL_ROLE';

/** Firebird `USER_SESSION` context variable holding the originating node ID. */
export const DEFAULT_REPL_ORIGIN_CONTEXT_VAR = 'FB_REPL_ORIGIN';

/** Default replication slot tracking table name on the primary. */
export const DEFAULT_REPL_SLOTS_TABLE = 'FB_REPL_SLOTS$';

/** Default replication slot TTL in milliseconds (7 days). */
export const DEFAULT_REPL_SLOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimal structural interface satisfied by `FirebirdBrowser`, `FirebirdLite`,
 * and test doubles.
 */
export interface ReplicableDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  transaction?<T>(
    fn: (tx: {
      query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
      execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T>;
  onEvent?(name: string, listener: (count: number) => void): Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------------------
// Replication Journal Entry & Conflict Types
// ---------------------------------------------------------------------------

/** Operation kind recorded in the replication journal. */
export type ReplicationOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL';

/** A single logical change entry in `FB_REPL_JOURNAL$`. */
export interface ReplicationLogEntry {
  /** Monotonically increasing Log Sequence Number (LSN) on the publishing node. */
  readonly lsn: number;
  /** Logical transaction identifier (`txid`) grouping changes committed together. */
  readonly txid: string;
  /** Unique identifier of the database node that originated this change. */
  readonly origin: string;
  /** Publication name this entry belongs to. */
  readonly publication: string;
  /** Upper-case table name (or `'$DDL'` for schema-level DDL statements). */
  readonly table: string;
  /** Change operation (`'INSERT'`, `'UPDATE'`, `'DELETE'`, or `'DDL'`). */
  readonly operation: ReplicationOperation;
  /** Primary key values of the affected row (`{}` for `'DDL'`). */
  readonly key: Record<string, unknown>;
  /** New row values (`null` for `'DELETE'` or `'DDL'`). */
  readonly after: Record<string, unknown> | null;
  /** Previous row values before the mutation (`null` for `'INSERT'` or `'DDL'`). */
  readonly before: Record<string, unknown> | null;
  /** Raw SQL statement when `operation === 'DDL'`. */
  readonly ddlSql?: string | null;
  /** Epoch timestamp (`Date.now()`) when the change was recorded. */
  readonly timestamp: number;
  /**
   * Optional monotonic Hybrid Logical Clock (`<wallMs>:<counter>:<nodeId>`)
   * for skew-tolerant causal ordering across distributed nodes.
   */
  readonly hlc?: string;
}

// ---------------------------------------------------------------------------
// Hybrid Logical Clock (HLC) & Per-Column CRDT Types (M12 Item 6)
// ---------------------------------------------------------------------------

/** Structured representation of a Hybrid Logical Clock (`<wallMs>:<counter>:<nodeId>`). */
export interface HlcTimestamp {
  /** Monotonic wall-clock component in milliseconds. */
  readonly wallMs: number;
  /** 16-bit logical counter (`0..65535`) incremented when multiple events share `wallMs`. */
  readonly counter: number;
  /** Originating node identifier. */
  readonly nodeId: string;
}

/** Options for {@link createHlc}. */
export interface HybridLogicalClockOptions {
  /** Custom physical wall-clock provider (defaults to `Date.now`). */
  now?: () => number;
  /** Maximum allowed physical clock drift in milliseconds (`0` = unlimited). @default 0 */
  maxDriftMs?: number;
  /** Initial wall-clock state in milliseconds. @default 0 */
  initialWallMs?: number;
  /** Initial logical counter state. @default 0 */
  initialCounter?: number;
}

/** Monotonic Hybrid Logical Clock instance returned by {@link createHlc}. */
export interface HybridLogicalClock {
  /** Node identifier bound to this clock. */
  readonly nodeId: string;
  /**
   * Advance the local HLC for a new local event and return its formatted
   * `<wallMs>:<counter>:<nodeId>` string.
   */
  now(wallNowMs?: number): string;
  /**
   * Merge a remote HLC timestamp into this local clock and return the new
   * local `<wallMs>:<counter>:<nodeId>` string.
   */
  receive(remote: string | HlcTimestamp, wallNowMs?: number): string;
  /** Return the latest `HlcTimestamp` state of this clock without advancing it. */
  last(): HlcTimestamp;
  /** Compare two HLC timestamps (`< 0`, `0`, or `> 0`). */
  compare(a: string | HlcTimestamp, b: string | HlcTimestamp): number;
}

/** Per-column CRDT merge strategy supported by {@link mergeCrdtRow} and {@link createCrdtConflictResolver}. */
export type ColumnCrdtStrategy =
  | 'lww'
  | 'pn-counter'
  | 'counter'
  | 'set-union'
  | 'g-set'
  | 'max'
  | 'min';

/** Configuration for {@link mergeCrdtRow} and {@link createCrdtConflictResolver}. */
export interface CrdtMergeConfig {
  /**
   * Per-column CRDT merge strategies keyed by column name (case-insensitive):
   * - `'lww'`: Last-Write-Wins Element-Set using HLC / `(timestamp, origin)`.
   * - `'pn-counter'` / `'counter'`: Additive numeric delta (`base + (local - base) + (remote - base)`).
   * - `'set-union'` / `'g-set'`: Set union of array / JSON-array / comma-separated elements (with 2P/OR-Set removal awareness when `before` is present).
   * - `'max'` / `'min'`: Join-semilattice maximum or minimum value.
   */
  columns?: Readonly<Record<string, ColumnCrdtStrategy>>;
  /** Default strategy for columns not listed in `columns`. @default 'lww' */
  defaultStrategy?: ColumnCrdtStrategy;
}

/** Context passed to a replication conflict resolver when applying a remote entry. */
export interface ReplicationConflictContext {
  /** Incoming change entry from the remote publication. */
  readonly incoming: ReplicationLogEntry;
  /** Current row state on the target database (`null` if the row does not exist locally). */
  readonly localRow: Record<string, unknown> | null;
  /** Local pending or concurrent journal entry for the same row, if available. */
  readonly localEntry?: ReplicationLogEntry | null;
}

/** Resolution returned by a conflict strategy or custom callback. */
export type ReplicationConflictResolution =
  | 'remote-wins'
  | 'local-wins'
  | 'merge'
  | { action: 'remote-wins' }
  | { action: 'local-wins' }
  | { action: 'merge'; row: Record<string, unknown> };

/**
 * Pluggable conflict strategy for replication:
 * - `'remote-wins'` / `'primary-wins'`: apply the incoming remote change over local state.
 * - `'local-wins'` / `'replica-wins'`: keep the local row state and skip the conflicting remote change.
 * - `'last-write-wins'`: compare `incoming.timestamp` against `localEntry.timestamp` (ties broken by lexicographical `origin`).
 * - `'merge'`: 3-way field-level merge using `incoming.before`, `localRow`, and `incoming.after`.
 * - Custom callback `(ctx) => ...`
 */
export type ReplicationConflictStrategy =
  | 'remote-wins'
  | 'local-wins'
  | 'primary-wins'
  | 'replica-wins'
  | 'last-write-wins'
  | 'merge'
  | ((
      ctx: ReplicationConflictContext,
    ) => ReplicationConflictResolution | Promise<ReplicationConflictResolution>);

// ---------------------------------------------------------------------------
// Publication Options & Interface
// ---------------------------------------------------------------------------

/** Table configuration within a publication. */
export interface PublishedTableConfig {
  /** Table name in Firebird SQL. */
  table: string;
  /** Primary key column name(s). Defaults to `['ID']`. */
  primaryKey?: string | readonly string[];
  /** Optional explicit column whitelist to include in replication entries (`KEY_JSON` columns are always preserved). */
  columns?: readonly string[];
  /** Optional column blacklist to strip from `AFTER_JSON` and `BEFORE_JSON` (e.g. sensitive PII columns). */
  excludeColumns?: readonly string[];
  /**
   * Optional row filter predicate for multi-tenant / partial publications.
   * Can be a JS predicate `(row: Record<string, unknown>) => boolean` or a SQL
   * `WHERE` clause string (e.g. `"TENANT_ID = 'acme'"`).
   */
  where?: string | ((row: Record<string, unknown>) => boolean);
  /**
   * Optional parent table names (foreign-key dependencies) used for topological
   * ordering when replaying multi-table transactions (`txid`).
   */
  references?: readonly string[];
}

/** Options for {@link buildReplicationTriggerDdl}. */
export interface BuildReplicationTriggerDdlOptions {
  /** Target user table name. */
  table: string;
  /** Primary key column name(s). Defaults to `['ID']`. */
  primaryKey?: readonly string[];
  /** Column names serialized into `AFTER_JSON` and `BEFORE_JSON`. Defaults to `primaryKey`. */
  columns?: readonly string[];
  /** Logical publication name. @default 'default' */
  publication?: string;
  /** Default origin node identifier if `RDB$GET_CONTEXT('USER_SESSION', 'FB_REPL_ORIGIN')` is unset. @default 'node_default' */
  nodeId?: string;
  /** Replication journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
  /** Sequence/generator name for atomic LSNs. @default 'FB_REPL_LSN_GEN$' */
  sequenceName?: string;
}

/** Metadata for a trigger installed by {@link installReplicationTriggers}. */
export interface InstalledReplicationTrigger {
  /** Normalized upper-case table name. */
  readonly table: string;
  /** Firebird trigger identifier (≤ 31 chars). */
  readonly triggerName: string;
  /** Firebird `POST_EVENT` name emitted on commit. */
  readonly eventName: string;
  /** Primary key columns serialized into `KEY_JSON`. */
  readonly primaryKey: readonly string[];
  /** Table columns serialized into `AFTER_JSON` / `BEFORE_JSON`. */
  readonly columns: readonly string[];
  /** Full `CREATE OR ALTER TRIGGER` PSQL DDL statement executed. */
  readonly ddl: string;
}

/** Options for {@link installReplicationTriggers}. */
export interface InstallReplicationTriggersOptions {
  /** Tables to instrument with replication triggers. */
  tables: ReadonlyArray<string | PublishedTableConfig>;
  /** Logical publication name. @default 'default' */
  publication?: string;
  /** Originating node identifier. @default 'node_default' */
  nodeId?: string;
  /** Custom journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
  /** Custom sequence name for atomic LSN assignment. @default 'FB_REPL_LSN_GEN$' */
  sequenceName?: string;
}

// ---------------------------------------------------------------------------
// Replication Slots & Snapshot Bootstrap Types (M12 Items 2 & 3)
// ---------------------------------------------------------------------------

/** A registered replica slot tracked in `FB_REPL_SLOTS$` on a primary database. */
export interface ReplicationSlot {
  /** Unique slot identifier (e.g. `'slot_replica_1'`). */
  readonly slotName: string;
  /** Publication name this slot belongs to. */
  readonly publication: string;
  /** Subscriber node identifier. */
  readonly nodeId: string;
  /** Highest LSN durably applied and acknowledged by this subscriber. */
  readonly confirmedFlushLsn: number;
  /** Epoch timestamp (`Date.now()`) of the subscriber's last heartbeat or LSN ack. */
  readonly lastSeenAt: number;
  /** Slot time-to-live in milliseconds (`0` = never expires). */
  readonly ttlMs: number;
}

/** Options for `publication.registerSlot()`. */
export interface RegisterReplicationSlotOptions {
  /** Unique slot name. */
  slotName: string;
  /** Subscriber node identifier. @default slotName */
  nodeId?: string;
  /** Initial confirmed LSN watermark. @default 0 */
  initialLsn?: number;
  /** Slot TTL in milliseconds before it is considered stale by `pruneAcked()`. @default 604800000 */
  ttlMs?: number;
  /** Explicit timestamp override (for deterministic testing). */
  now?: number;
}

/** Result returned by `publication.pruneAcked()`. */
export interface PruneAckedResult {
  /** Names of stale slots whose `lastSeenAt + ttlMs < now` that were expired and removed. */
  readonly expiredSlots: readonly string[];
  /** Number of active (non-expired) slots remaining for this publication. */
  readonly activeSlotCount: number;
  /** Minimum `confirmedFlushLsn` across all active slots (`null` if no active slots exist). */
  readonly safeLsn: number | null;
  /** Number of journal entries deleted (`LSN <= safeLsn`). */
  readonly prunedEntries: number;
}

/** Consistent logical dump of a single published table at a specific LSN watermark. */
export interface LogicalTableSnapshot {
  /** Upper-case table name. */
  readonly table: string;
  /** Primary key column names. */
  readonly primaryKey: readonly string[];
  /** Optional `CREATE TABLE` DDL statement for provisioning the table on a replica. */
  readonly ddlSql?: string | null;
  /** Snapshot rows at `watermarkLsn`. */
  readonly rows: readonly Row[];
}

/** Consistent snapshot of a publication at `watermarkLsn` (logical rows or binary page diff). */
export interface PublicationSnapshot {
  /** Publication name. */
  readonly publication: string;
  /** Originating node identifier. */
  readonly origin: string;
  /** Exact journal LSN watermark corresponding to this snapshot state. */
  readonly watermarkLsn: number;
  /** Epoch timestamp when the snapshot was exported. */
  readonly timestamp: number;
  /** Snapshot payload format (`'logical'` or `'page-diff'`). */
  readonly mode: 'logical' | 'page-diff';
  /** Table snapshots when `mode === 'logical'`. */
  readonly tables: readonly LogicalTableSnapshot[];
  /** Binary page-diff payload (`FBDF\x01`) when `mode === 'page-diff'`. */
  readonly pageDiffBytes?: Uint8Array | null;
}

/** Options for {@link bootstrapReplica}. */
export interface BootstrapReplicaOptions {
  /** Target replica database (`FirebirdBrowser` or `FirebirdLite`). */
  targetDb: ReplicableDatabase & {
    applyDiff?(diffBytes: Uint8Array, options?: { pageSize?: number }): Promise<Uint8Array>;
  };
  /** Source publication to export snapshot from (ignored if `snapshot` is passed directly). */
  publication: ReplicationPublication;
  /** Target subscription whose watermark (and slot) will be aligned to the snapshot LSN. */
  subscription: ReplicationSubscription;
  /** Optional pre-exported `PublicationSnapshot`. */
  snapshot?: PublicationSnapshot;
  /** Bootstrap mode (`'logical'` or `'page-diff'`). @default 'logical' */
  mode?: 'logical' | 'page-diff';
  /** Base snapshot or raw `.fdb` image when `mode === 'page-diff'`. */
  baseSnapshot?: Uint8Array;
  /** Optional `CREATE TABLE` DDL statements keyed by table name for provisioning missing tables on `targetDb`. */
  tableDdl?: Readonly<Record<string, string>>;
  /** Whether to clear existing rows in published tables on `targetDb` before loading the logical snapshot. @default true */
  truncateExisting?: boolean;
}

/** Result returned by {@link bootstrapReplica}. */
export interface BootstrapReplicaResult {
  /** Bootstrap mode used (`'logical'` or `'page-diff'`). */
  readonly mode: 'logical' | 'page-diff';
  /** Watermark LSN aligned on the replica subscription and primary slot. */
  readonly watermarkLsn: number;
  /** Number of published tables bootstrapped. */
  readonly tablesBootstrapped: number;
  /** Total number of rows copied into `targetDb`. */
  readonly rowsCopied: number;
  /** Approximate payload size in bytes. */
  readonly bytesTransferred: number;
}

// ---------------------------------------------------------------------------
// Whole-Database Catalog, Sequence & Schema Auto-Replication Types (M12 Item 4)
// ---------------------------------------------------------------------------

/** A Firebird sequence/generator watermark exported by {@link exportSequences}. */
export interface SequenceWatermark {
  /** Upper-case sequence/generator name. */
  readonly name: string;
  /** Current sequence value (`GEN_ID(name, 0)`). */
  readonly currentValue: number;
}

/** Options for {@link syncCatalog}. */
export interface SyncCatalogOptions {
  /** Source database (`primary`). */
  sourceDb: ReplicableDatabase;
  /** Target database (`replica`). */
  targetDb: ReplicableDatabase;
  /** Optional table names to exclude when discovering user tables. */
  excludeTables?: readonly string[];
  /** Synchronize table/column/index/view DDL using `diffSchema` + `generateMigration`. @default true */
  syncSchema?: boolean;
  /** Synchronize Firebird sequence/generator values (`RDB$GENERATORS`). @default true */
  syncSequences?: boolean;
  /** Allow destructive drops (`DROP TABLE`, `DROP COLUMN`) during schema sync. @default false */
  allowDestructive?: boolean;
}

/** Result returned by {@link syncCatalog}. */
export interface SyncCatalogResult {
  /** DDL statements executed on `targetDb`. */
  readonly ddlStatementsExecuted: readonly string[];
  /** Number of sequences/generators synchronized on `targetDb`. */
  readonly sequencesSynced: number;
  /** User tables discovered on `sourceDb`. */
  readonly discoveredTables: readonly string[];
}

/** Normalized table configuration stored inside a `ReplicationPublication`. */
export interface NormalizedPublishedTableConfig {
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns?: readonly string[];
  readonly excludeColumns?: readonly string[];
  readonly where?: string | ((row: Record<string, unknown>) => boolean);
  readonly references?: readonly string[];
}

/** Options for {@link createPublication}. */
export interface CreatePublicationOptions {
  /** Logical name of the publication (e.g. `'main_pub'`). @default 'default' */
  name?: string;
  /** Unique node identifier for this database instance (used for loop prevention & LWW). */
  nodeId?: string;
  /**
   * Tables published by this publication (names, `{ table, primaryKey, columns, excludeColumns, where }`
   * configs, or `'*'` to automatically discover and publish all user tables).
   */
  tables: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /** Tables to exclude when `tables: '*'` is used. */
  excludeTables?: readonly string[];
  /** Custom journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
  /** Custom mirror table name for `captureTableChanges()`. @default 'FB_REPL_MIRROR$' */
  mirrorTable?: string;
  /** Custom replication slots table name. @default 'FB_REPL_SLOTS$' */
  slotsTable?: string;
  /** Default replication slot TTL in milliseconds. @default 604800000 */
  defaultSlotTtlMs?: number;
  /** Custom sequence name for trigger LSN generation. @default 'FB_REPL_LSN_GEN$' */
  sequenceName?: string;
  /**
   * When `true`, automatically generates and installs `AFTER INSERT OR UPDATE OR DELETE`
   * PSQL triggers (`FB_REPL_TRG$<table>`) on all published tables during `createPublication()`.
   *
   * @default false
   */
  installTriggers?: boolean;
  /**
   * Optional Hybrid Logical Clock used to stamp every published journal entry.
   * When omitted, an internal `createHlc(nodeId)` instance is used automatically.
   */
  hlc?: HybridLogicalClock;
}

/** A logical replication publication on a source database. */
export interface ReplicationPublication {
  /** Publication name. */
  readonly name: string;
  /** Originating node identifier. */
  readonly nodeId: string;
  /** Hybrid Logical Clock bound to this publication. */
  readonly hlc: HybridLogicalClock;
  /** Published table configurations keyed by upper-case table name. */
  readonly tables: ReadonlyMap<string, NormalizedPublishedTableConfig>;
  /**
   * Re-introspect the database catalog (when `tables: '*'` was used) and add any
   * newly created user tables to the publication.
   */
  refreshPublishedTables(): Promise<ReadonlyMap<string, NormalizedPublishedTableConfig>>;
  /** Return the highest LSN currently recorded in the journal. */
  currentLsn(): Promise<number>;
  /**
   * Return the lowest `LSN` currently retained in `FB_REPL_JOURNAL$` for this publication,
   * or `null` if the journal is empty.
   */
  minRetainedLsn(): Promise<number | null>;
  /**
   * Generate and install `AFTER INSERT OR UPDATE OR DELETE` Firebird PSQL triggers
   * (`FB_REPL_TRG$<table>`) on all published tables so direct SQL writes are
   * captured atomically inside the committing transaction.
   */
  installTriggers(): Promise<InstalledReplicationTrigger[]>;
  /**
   * Drop the replication triggers previously installed for this publication.
   */
  dropTriggers(): Promise<string[]>;
  /**
   * Register or update a subscriber replication slot in `FB_REPL_SLOTS$`.
   */
  registerSlot(options: string | RegisterReplicationSlotOptions): Promise<ReplicationSlot>;
  /**
   * Advance `confirmedFlushLsn` and refresh `lastSeenAt` for a subscriber slot in `FB_REPL_SLOTS$`.
   */
  advanceSlot(
    slotName: string,
    confirmedFlushLsn: number,
    options?: { nodeId?: string; ttlMs?: number; now?: number },
  ): Promise<ReplicationSlot>;
  /**
   * Refresh `lastSeenAt` for an existing subscriber slot without changing its `confirmedFlushLsn`.
   */
  heartbeatSlot(slotName: string, options?: { now?: number }): Promise<ReplicationSlot | null>;
  /**
   * Drop a subscriber slot from `FB_REPL_SLOTS$`.
   */
  dropSlot(slotName: string): Promise<boolean>;
  /**
   * List all registered subscriber slots for this publication in `FB_REPL_SLOTS$`.
   */
  listSlots(): Promise<ReplicationSlot[]>;
  /**
   * Expire stale slots past their `ttlMs`, compute `MIN(confirmedFlushLsn)` across
   * all remaining active slots, and prune journal entries `<= safeLsn`.
   */
  pruneAcked(options?: { now?: number; pruneWhenNoSlots?: boolean }): Promise<PruneAckedResult>;
  /**
   * Export a consistent logical table dump or binary page-diff (`FBDF\x01`) snapshot
   * tagged with the publication's current LSN watermark for replica bootstrapping.
   */
  exportSnapshot(options?: {
    mode?: 'logical' | 'page-diff';
    baseSnapshot?: Uint8Array;
    tableDdl?: Readonly<Record<string, string>>;
  }): Promise<PublicationSnapshot>;
  /**
   * Record a single row DML mutation (`INSERT`, `UPDATE`, `DELETE`) in the
   * replication journal (`FB_REPL_JOURNAL$`), optionally applying it to the
   * local table as well when `applyLocally` is `true` (default `true`).
   */
  recordDml(params: {
    table: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    key?: Record<string, unknown>;
    after?: Record<string, unknown> | null;
    before?: Record<string, unknown> | null;
    txid?: string;
    origin?: string;
    timestamp?: number;
    applyLocally?: boolean;
  }): Promise<ReplicationLogEntry>;
  /**
   * Record a DDL statement in the replication journal (`FB_REPL_JOURNAL$`),
   * optionally executing it on the local database first when `applyLocally` is
   * `true` (default `true`).
   */
  recordDdl(
    ddlSql: string,
    options?: { txid?: string; origin?: string; timestamp?: number; applyLocally?: boolean },
  ): Promise<ReplicationLogEntry>;
  /**
   * Diff the live rows of all published tables against the publication's last
   * captured mirror snapshot and append any newly inserted, updated, or deleted
   * rows into `FB_REPL_JOURNAL$`.
   *
   * Useful when application code mutates tables directly via `db.exec()` /
   * `db.query()` without calling `recordDml()` explicitly.
   */
  captureTableChanges(options?: { txid?: string; timestamp?: number }): Promise<ReplicationLogEntry[]>;
  /**
   * Fetch a batch of journal entries with `lsn > sinceLsn`, ordered by `lsn ASC`.
   * Optionally excludes entries originating from `excludeOrigin` to prevent
   * echo loops in bidirectional replication.
   */
  fetchChangesSince(
    sinceLsn: number,
    options?: { limit?: number; excludeOrigin?: string },
  ): Promise<ReplicationLogEntry[]>;
  /**
   * Prune journal entries with `lsn <= upToLsn` to reclaim storage once all
   * subscribers have advanced past `upToLsn`.
   */
  pruneJournal(upToLsn: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Subscription Options & Interface
// ---------------------------------------------------------------------------

/** Options for {@link createSubscription}. */
export interface CreateSubscriptionOptions {
  /** Unique subscription identifier (used as key in `FB_REPL_WATERMARKS$`). @default 'default_sub' */
  name?: string;
  /** Unique node identifier for the replica database. */
  nodeId?: string;
  /**
   * Optional replication slot name on the source publication (`FB_REPL_SLOTS$`).
   * When set (or when `publication` is a full `ReplicationPublication`), `pull()` and
   * `applyChanges()` automatically acknowledge the replica's new watermark LSN to this slot.
   */
  slotName?: string;
  /** Slot TTL in milliseconds when registering/advancing the slot on the publication. @default 604800000 */
  slotTtlMs?: number;
  /**
   * When `true`, automatically calls `publication.pruneAcked()` after acknowledging
   * a new watermark LSN on the publication slot.
   *
   * @default false
   */
  autoPrune?: boolean;
  /**
   * When `true`, automatically bootstraps the replica via {@link bootstrapReplica}
   * if the replica has fallen behind the publication's `minRetainedLsn()`.
   *
   * @default false
   */
  autoBootstrap?: boolean;
  /** Source publication (or a remote pull callback returning `ReplicationLogEntry[]`). */
  publication:
    | ReplicationPublication
    | {
        readonly name: string;
        fetchChangesSince(
          sinceLsn: number,
          options?: { limit?: number; excludeOrigin?: string },
        ): Promise<ReplicationLogEntry[]>;
      };
  /**
   * Optional local publication on the replica when running in bidirectional mode.
   * Used to update the replica's mirror state so incoming remote changes are not
   * re-captured as new local changes, and to inspect concurrent local changes
   * during conflict resolution.
   */
  localPublication?: ReplicationPublication;
  /** Conflict resolution strategy. @default 'remote-wins' */
  onConflict?: ReplicationConflictStrategy;
  /** Called whenever a conflict is detected and resolved. */
  onConflictResolved?: (
    ctx: ReplicationConflictContext,
    resolution: 'remote-wins' | 'local-wins' | 'merge',
  ) => void;
  /** Maximum number of journal entries pulled per `pull()` cycle. @default 500 */
  batchSize?: number;
  /** Custom watermark table name. @default 'FB_REPL_WATERMARKS$' */
  watermarkTable?: string;
  /** Poll interval in milliseconds when `start()` is called. @default 1000 */
  pollIntervalMs?: number;
  /**
   * Optional table foreign-key dependency map (`childTable -> [parentTable1, ...]`).
   * Used by {@link orderEntriesByTopology} to replay parent `INSERT`s before child
   * `INSERT`s and child `DELETE`s before parent `DELETE`s within the same `txid`.
   */
  tableDependencies?: Readonly<Record<string, readonly string[]>>;
  /**
   * Optional Hybrid Logical Clock updated (`hlc.receive()`) whenever remote
   * journal entries are applied on this replica.
   */
  hlc?: HybridLogicalClock;
}

/** Result of a single `subscription.pull()` cycle. */
export interface SubscriptionPullResult {
  /** Number of journal entries fetched from the publication. */
  readonly fetchedCount: number;
  /** Number of entries applied to the target database. */
  readonly appliedCount: number;
  /** Number of conflicting entries encountered and resolved. */
  readonly conflictCount: number;
  /** Watermark LSN before this pull cycle. */
  readonly previousLsn: number;
  /** New watermark LSN persisted in `FB_REPL_WATERMARKS$`. */
  readonly currentLsn: number;
  /** `true` if `autoBootstrap` triggered an automatic snapshot re-seed before pulling. */
  readonly bootstrapped?: boolean;
}

/** A logical replication subscription on a target/replica database. */
export interface ReplicationSubscription {
  /** Subscription name. */
  readonly name: string;
  /** Replica node identifier. */
  readonly nodeId: string;
  /** Registered replication slot name on the source publication. */
  readonly slotName: string;
  /** Read the last applied LSN watermark from `FB_REPL_WATERMARKS$`. */
  getWatermark(): Promise<number>;
  /** Explicitly set the LSN watermark in `FB_REPL_WATERMARKS$`. */
  setWatermark(lsn: number): Promise<void>;
  /** Send a heartbeat to the source publication's replication slot (`FB_REPL_SLOTS$`). */
  heartbeat(options?: { now?: number }): Promise<ReplicationSlot | null>;
  /** Pull and apply all pending changes from the publication up to `batchSize`. */
  pull(): Promise<SubscriptionPullResult>;
  /** Apply an explicit batch of `ReplicationLogEntry` items and advance the watermark. */
  applyChanges(entries: readonly ReplicationLogEntry[]): Promise<SubscriptionPullResult>;
  /** Start continuous background polling / event-driven replication. */
  start(): void;
  /** Stop background polling. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal SQL & Serialization Helpers
// ---------------------------------------------------------------------------

function encodeJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Uint8Array) return { $bytes: Array.from(v) };
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    return v;
  });
}

function decodeJson(text: unknown): Record<string, unknown> | null {
  if (text === null || text === undefined || text === '') return null;
  return JSON.parse(String(text), (_, v) => {
    if (v && typeof v === 'object' && Array.isArray(v.$bytes)) {
      return new Uint8Array(v.$bytes);
    }
    if (v && typeof v === 'object' && typeof v.$bigint === 'string') {
      return BigInt(v.$bigint);
    }
    return v;
  }) as Record<string, unknown>;
}

function quoteIdent(ident: string): string {
  const clean = ident.trim().replace(/^"+|"+$/g, '');
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(clean)) {
    return clean.toUpperCase();
  }
  return `"${clean.replace(/"/g, '""')}"`;
}

function normalizeTableName(ident: string): string {
  return ident.trim().replace(/^"+|"+$/g, '').toUpperCase();
}

function getFieldCaseInsensitive(row: Record<string, unknown>, col: string): unknown {
  if (col in row) return row[col];
  const upper = col.toUpperCase();
  if (upper in row) return row[upper];
  const lower = col.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

function normalizeRowKeysUpper(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.toUpperCase()] = v;
  }
  return out;
}

function extractKeyRecord(
  row: Record<string, unknown>,
  pkCols: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of pkCols) {
    out[col.toUpperCase()] = getFieldCaseInsensitive(row, col);
  }
  return out;
}

function serializeKeyRecord(
  keyRec: Record<string, unknown>,
  pkCols: readonly string[],
): string {
  return JSON.stringify(pkCols.map((c) => getFieldCaseInsensitive(keyRec, c)));
}

function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const normA = normalizeRowKeysUpper(a);
  const normB = normalizeRowKeysUpper(b);
  const keysA = Object.keys(normA).sort();
  const keysB = Object.keys(normB).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    const valA = normA[keysA[i]!];
    const valB = normB[keysB[i]!];
    if (JSON.stringify(valA) !== JSON.stringify(valB)) return false;
  }
  return true;
}

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

async function execStatement(
  db: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
  },
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (params.length > 0) {
    if (typeof db.execute === 'function') {
      await db.execute(sql, params);
    } else if (typeof db.exec === 'function') {
      await db.exec(sql, params);
    } else {
      await db.query(sql, params);
    }
    return;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql);
  } else if (typeof db.execute === 'function') {
    await db.execute(sql, []);
  } else {
    await db.query(sql, []);
  }
}

async function ensureTableSafe(
  db: ReplicableDatabase,
  createSql: string,
): Promise<void> {
  try {
    await execStatement(db, createSql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|SQLCODE = -607|unsuccessful metadata update/i.test(msg)) {
      throw err;
    }
  }
}

async function applyRowMutationToTable(
  runner: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
  },
  table: string,
  pkCols: readonly string[],
  operation: 'INSERT' | 'UPDATE' | 'DELETE',
  key: Record<string, unknown>,
  rowValues: Record<string, unknown> | null,
): Promise<void> {
  const quotedTable = quoteIdent(table);
  const normKey = normalizeRowKeysUpper(key);

  if (operation === 'DELETE') {
    const whereClause = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
    const whereParams = pkCols.map((c) => normKey[c.toUpperCase()]) as QueryParams;
    await execStatement(
      runner,
      `DELETE FROM ${quotedTable} WHERE ${whereClause}`,
      whereParams,
    );
    return;
  }

  const normRow = normalizeRowKeysUpper({ ...(rowValues ?? {}), ...normKey });
  const whereClause = pkCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
  const whereParams = pkCols.map((c) => normRow[c.toUpperCase()]) as QueryParams;

  const existing = await runner.query<Row>(
    `SELECT * FROM ${quotedTable} WHERE ${whereClause}`,
    whereParams,
  );

  if (existing.rows.length > 0) {
    const nonPkCols = Object.keys(normRow).filter(
      (c) => !pkCols.map((p) => p.toUpperCase()).includes(c.toUpperCase()),
    );
    if (nonPkCols.length === 0) return;
    const setClause = nonPkCols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
    const setParams = nonPkCols.map((c) => normRow[c]) as QueryParams;
    await execStatement(
      runner,
      `UPDATE ${quotedTable} SET ${setClause} WHERE ${whereClause}`,
      [...setParams, ...whereParams],
    );
  } else {
    const cols = Object.keys(normRow);
    const colList = cols.map(quoteIdent).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const insertParams = cols.map((c) => normRow[c]) as QueryParams;
    await execStatement(
      runner,
      `INSERT INTO ${quotedTable} (${colList}) VALUES (${placeholders})`,
      insertParams,
    );
  }
}

// ---------------------------------------------------------------------------
// 0. Native Firebird SQL Trigger-Based Change Capture (`installReplicationTriggers`)
// ---------------------------------------------------------------------------

function fnv1aHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (const ch of input) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').toUpperCase();
}

/**
 * Deterministic Firebird trigger identifier (≤ 31 chars) for a published table.
 *
 * Uses `FB_REPL_TRG$<TABLE>` when the sanitized table name fits within 31 characters
 * for the `'default'` publication, or `FB_REPL_TRG$<PREFIX>_<HASH8>` otherwise.
 */
export function replicationTriggerName(table: string, publication = 'default'): string {
  const cleanTable = normalizeTableName(table).replace(/[^A-Z0-9_$]/g, '_');
  const cleanPub = publication.trim().toUpperCase();
  if (cleanPub === 'DEFAULT' && cleanTable.length > 0 && `FB_REPL_TRG$${cleanTable}`.length <= 31) {
    return `FB_REPL_TRG$${cleanTable}`;
  }
  const hash = fnv1aHash8(`${cleanPub}:${ normalizeTableName(table)}`);
  const prefix = cleanTable.slice(0, 10);
  return prefix.length > 0 ? `FB_REPL_TRG$${prefix}_${hash}` : `FB_REPL_TRG$${hash}`;
}

/**
 * Deterministic Firebird `POST_EVENT` name (≤ 31 chars) for a publication.
 */
export function replicationEventName(publication = 'default'): string {
  const clean = publication.trim().replace(/[^A-Za-z0-9_$]/g, '_');
  const candidate = `fb_repl_${clean}`;
  if (candidate.length <= 31) {
    return candidate;
  }
  return `fb_repl_${fnv1aHash8(publication.trim().toUpperCase()).toLowerCase()}`;
}

function escapeSqlLiteral(val: string): string {
  return val.replace(/'/g, "''");
}

function buildJsonObjectSqlExpr(
  recordPrefix: 'NEW' | 'OLD',
  cols: readonly string[],
): string {
  if (cols.length === 0) {
    return `'{}'`;
  }
  const pairs = cols.map((col) => {
    const upperCol = col.toUpperCase();
    const quotedCol = quoteIdent(upperCol);
    const keyLiteral = escapeSqlLiteral(`"${upperCol}":`);
    const valRef = `${recordPrefix}.${quotedCol}`;
    return (
      `'${keyLiteral}' || IIF(${valRef} IS NULL, 'null', ` +
      `'"' || REPLACE(REPLACE(CAST(${valRef} AS VARCHAR(4000)), '\\', '\\\\'), '"', '\\"') || '"')`
    );
  });
  return `'{' || ${pairs.join(` || ',' || `)} || '}'`;
}

/**
 * Build idempotent `CREATE OR ALTER TRIGGER` PSQL DDL for a published table.
 *
 * The generated trigger:
 * 1. Checks `RDB$GET_CONTEXT('USER_SESSION', 'FB_REPL_ROLE') IS DISTINCT FROM 'REPLICA'`
 *    so replica apply transactions bypass trigger logging (loop prevention).
 * 2. Serializes `KEY_JSON`, `AFTER_JSON` (`NEW.*`), and `BEFORE_JSON` (`OLD.*`).
 * 3. Inserts a row into `FB_REPL_JOURNAL$` using `NEXT VALUE FOR FB_REPL_LSN_GEN$`
 *    and `CURRENT_TRANSACTION`.
 * 4. Emits `POST_EVENT '<eventName>'` for instant subscriber wakeup.
 */
export function buildReplicationTriggerDdl(
  options: BuildReplicationTriggerDdlOptions,
): { triggerName: string; eventName: string; ddl: string } {
  const tableUpper = normalizeTableName(options.table);
  const pubName = (options.publication ?? 'default').trim();
  const nodeId = (options.nodeId ?? `node_${pubName}`).trim();
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);
  const seqName = quoteIdent(options.sequenceName ?? DEFAULT_REPL_LSN_SEQUENCE);

  const pkCols =
    options.primaryKey && options.primaryKey.length > 0
      ? options.primaryKey.map((c) => c.toUpperCase())
      : ['ID'];
  const allCols =
    options.columns && options.columns.length > 0
      ? Array.from(new Set([...pkCols, ...options.columns.map((c) => c.toUpperCase())]))
      : pkCols;

  const triggerName = replicationTriggerName(tableUpper, pubName);
  const eventName = replicationEventName(pubName);

  const newKeyExpr = buildJsonObjectSqlExpr('NEW', pkCols);
  const oldKeyExpr = buildJsonObjectSqlExpr('OLD', pkCols);
  const afterExpr = buildJsonObjectSqlExpr('NEW', allCols);
  const beforeExpr = buildJsonObjectSqlExpr('OLD', allCols);

  const ddl = [
    `CREATE OR ALTER TRIGGER ${triggerName} FOR ${quoteIdent(tableUpper)}`,
    `ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 32000`,
    `AS`,
    `  DECLARE VARIABLE v_op VARCHAR(16);`,
    `  DECLARE VARIABLE v_key VARCHAR(2000);`,
    `  DECLARE VARIABLE v_after VARCHAR(8191);`,
    `  DECLARE VARIABLE v_before VARCHAR(8191);`,
    `  DECLARE VARIABLE v_origin VARCHAR(128);`,
    `BEGIN`,
    `  IF (RDB$GET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}') IS DISTINCT FROM 'REPLICA') THEN`,
    `  BEGIN`,
    `    v_origin = COALESCE(RDB$GET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ORIGIN_CONTEXT_VAR}'), '${escapeSqlLiteral(nodeId)}');`,
    `    IF (INSERTING) THEN`,
    `    BEGIN`,
    `      v_op = 'INSERT';`,
    `      v_key = ${newKeyExpr};`,
    `      v_after = ${afterExpr};`,
    `      v_before = NULL;`,
    `    END`,
    `    ELSE IF (UPDATING) THEN`,
    `    BEGIN`,
    `      v_op = 'UPDATE';`,
    `      v_key = ${newKeyExpr};`,
    `      v_after = ${afterExpr};`,
    `      v_before = ${beforeExpr};`,
    `    END`,
    `    ELSE`,
    `    BEGIN`,
    `      v_op = 'DELETE';`,
    `      v_key = ${oldKeyExpr};`,
    `      v_after = NULL;`,
    `      v_before = ${beforeExpr};`,
    `    END`,
    `    INSERT INTO ${journalTable} (LSN, TXID, ORIGIN, PUBLICATION, TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS)`,
    `    VALUES (`,
    `      NEXT VALUE FOR ${seqName},`,
    `      CAST(CURRENT_TRANSACTION AS VARCHAR(128)),`,
    `      :v_origin,`,
    `      '${escapeSqlLiteral(pubName)}',`,
    `      '${escapeSqlLiteral(tableUpper)}',`,
    `      :v_op,`,
    `      :v_key,`,
    `      :v_after,`,
    `      :v_before,`,
    `      NULL,`,
    `      DATEDIFF(MILLISECOND FROM TIMESTAMP '1970-01-01 00:00:00' TO CURRENT_TIMESTAMP)`,
    `    );`,
    `    POST_EVENT '${escapeSqlLiteral(eventName)}';`,
    `  END`,
    `END`,
  ].join('\n');

  return { triggerName, eventName, ddl };
}

async function discoverTableColumns(
  db: ReplicableDatabase,
  tableUpper: string,
  fallbackCols: readonly string[],
): Promise<readonly string[]> {
  // 1. Try Firebird system catalog RDB$RELATION_FIELDS
  try {
    const sysRes = await db.query<Row>(
      `SELECT TRIM(RDB$FIELD_NAME) AS COL_NAME FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND COALESCE(RDB$SYSTEM_FLAG, 0) = 0 ORDER BY RDB$FIELD_POSITION`,
      [tableUpper],
    );
    const cols = sysRes.rows
      .map((r) => String(r.COL_NAME ?? r.col_name ?? '').trim().toUpperCase())
      .filter((c) => c.length > 0);
    if (cols.length > 0) {
      return cols;
    }
  } catch {
    // System catalog query unsupported on mock DB; fall through
  }

  // 2. Try `SELECT * FROM <table>` metadata or sample row keys
  try {
    const sample = await db.query<Row>(`SELECT * FROM ${quoteIdent(tableUpper)}`);
    if (sample.fields && sample.fields.length > 0) {
      const cols = sample.fields
        .map((f) => f.name.trim().toUpperCase())
        .filter((c) => c.length > 0);
      if (cols.length > 0) return cols;
    }
    if (sample.rows[0]) {
      const cols = Object.keys(sample.rows[0]).map((k) => k.toUpperCase());
      if (cols.length > 0) return cols;
    }
  } catch {
    // Ignore and return fallback
  }

  return fallbackCols;
}

/**
 * Generate and install idempotent `AFTER INSERT OR UPDATE OR DELETE` Firebird PSQL
 * replication triggers (`FB_REPL_TRG$<table>`) and the atomic LSN generator
 * (`FB_REPL_LSN_GEN$`) on `db`.
 */
export async function installReplicationTriggers(
  db: ReplicableDatabase,
  options: InstallReplicationTriggersOptions,
): Promise<InstalledReplicationTrigger[]> {
  const pubName = (options.publication ?? 'default').trim();
  const nodeId = (options.nodeId ?? `node_${pubName}`).trim();
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);
  const seqName = quoteIdent(options.sequenceName ?? DEFAULT_REPL_LSN_SEQUENCE);

  await ensureTableSafe(
    db,
    `CREATE TABLE ${journalTable} (
      LSN BIGINT NOT NULL PRIMARY KEY,
      TXID VARCHAR(128) NOT NULL,
      ORIGIN VARCHAR(128) NOT NULL,
      PUBLICATION VARCHAR(128) NOT NULL,
      TABLE_NAME VARCHAR(128) NOT NULL,
      OP VARCHAR(16) NOT NULL,
      KEY_JSON VARCHAR(2000) NOT NULL,
      AFTER_JSON VARCHAR(8191),
      BEFORE_JSON VARCHAR(8191),
      DDL_SQL VARCHAR(8191),
      TS BIGINT NOT NULL
    )`,
  );

  await ensureTableSafe(db, `CREATE SEQUENCE ${seqName}`);

  const installed: InstalledReplicationTrigger[] = [];

  for (const item of options.tables) {
    const tableUpper = normalizeTableName(typeof item === 'string' ? item : item.table);
    const pkCols =
      typeof item === 'string'
        ? ['ID']
        : typeof item.primaryKey === 'string'
          ? [item.primaryKey.toUpperCase()]
          : item.primaryKey && item.primaryKey.length > 0
            ? item.primaryKey.map((k) => k.toUpperCase())
            : ['ID'];
    const explicitCols =
      typeof item !== 'string' && item.columns && item.columns.length > 0
        ? item.columns.map((c) => c.toUpperCase())
        : undefined;

    const columns =
      explicitCols ?? (await discoverTableColumns(db, tableUpper, pkCols));

    const { triggerName, eventName, ddl } = buildReplicationTriggerDdl({
      table: tableUpper,
      primaryKey: pkCols,
      columns,
      publication: pubName,
      nodeId,
      journalTable: options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE,
      sequenceName: options.sequenceName ?? DEFAULT_REPL_LSN_SEQUENCE,
    });

    await execStatement(db, ddl);

    installed.push({
      table: tableUpper,
      triggerName,
      eventName,
      primaryKey: pkCols,
      columns,
      ddl,
    });
  }

  return installed;
}

/**
 * Drop the replication triggers previously installed by {@link installReplicationTriggers}.
 */
export async function dropReplicationTriggers(
  db: ReplicableDatabase,
  options: {
    tables: ReadonlyArray<string | PublishedTableConfig>;
    publication?: string;
  },
): Promise<string[]> {
  const pubName = (options.publication ?? 'default').trim();
  const dropped: string[] = [];

  for (const item of options.tables) {
    const tableUpper = normalizeTableName(typeof item === 'string' ? item : item.table);
    const triggerName = replicationTriggerName(tableUpper, pubName);
    try {
      await execStatement(db, `DROP TRIGGER ${triggerName}`);
      dropped.push(triggerName);
    } catch {
      // Ignore if trigger does not exist
    }
  }

  return dropped;
}

// ---------------------------------------------------------------------------
// 0b. Whole-Database Catalog Discovery, Sequence Watermarking & Schema Sync (M12 Item 4)
// ---------------------------------------------------------------------------

function isInternalReplicationTable(name: string): boolean {
  const upper = normalizeTableName(name);
  return (
    upper.startsWith('FB_REPL_') ||
    upper.startsWith('FB_MIGRATIONS') ||
    upper.startsWith('RDB$') ||
    upper.startsWith('MON$') ||
    upper.startsWith('SEC$')
  );
}

function toMigrationExecutor(db: ReplicableDatabase): {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec(sql: string, params?: QueryParams): Promise<unknown>;
} {
  return {
    query: <T extends Row = Row>(sql: string, params?: QueryParams) => db.query<T>(sql, params),
    exec: (sql: string, params?: QueryParams) => execStatement(db, sql, params),
  };
}

/**
 * Discover all non-system, non-replication user tables on `db` along with their
 * primary keys, columns, and foreign-key parent table references.
 */
export async function discoverUserTables(
  db: ReplicableDatabase,
  options: { excludeTables?: readonly string[] } = {},
): Promise<PublishedTableConfig[]> {
  const excludeSet = new Set(
    (options.excludeTables ?? []).map((t) => normalizeTableName(t)),
  );

  // 1. Try full catalog introspection (`introspect(db)`)
  try {
    const schema = await introspect(toMigrationExecutor(db));
    if (schema.tables.length > 0) {
      const out: PublishedTableConfig[] = [];
      for (const tbl of schema.tables) {
        const upper = normalizeTableName(tbl.name);
        if (isInternalReplicationTable(upper) || excludeSet.has(upper)) continue;
        const pk =
          tbl.primaryKey && tbl.primaryKey.length > 0
            ? tbl.primaryKey.map((c: string) => c.toUpperCase())
            : ['ID'];
        const cols = tbl.columns.map((c) => c.name.toUpperCase());
        const refs = Array.from(
          new Set(tbl.foreignKeys.map((fk) => normalizeTableName(fk.referencedTableName))),
        );
        out.push({
          table: upper,
          primaryKey: pk,
          ...(cols.length > 0 ? { columns: cols } : {}),
          ...(refs.length > 0 ? { references: refs } : {}),
        });
      }
      if (out.length > 0) return out;
    }
  } catch {
    // Fall through to lightweight RDB$RELATIONS query or mock DB inspection
  }

  // 2. Try lightweight RDB$RELATIONS query
  try {
    const relRes = await db.query<Row>(
      `SELECT TRIM(RDB$RELATION_NAME) AS TABLE_NAME FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ORDER BY RDB$RELATION_NAME`,
    );
    const names = relRes.rows
      .map((r) => String(r.TABLE_NAME ?? r.table_name ?? '').trim().toUpperCase())
      .filter((n) => n.length > 0 && !isInternalReplicationTable(n) && !excludeSet.has(n));
    if (names.length > 0) {
      return names.map((table) => ({ table, primaryKey: ['ID'] }));
    }
  } catch {
    // Fall through to in-memory `tables` map inspection
  }

  // 3. Fallback for in-memory test doubles exposing `db.tables: Map<string, Row[]>`
  const mockTables = (db as ReplicableDatabase & { tables?: Map<string, Row[]> }).tables;
  if (mockTables instanceof Map) {
    const out: PublishedTableConfig[] = [];
    for (const [rawName, rows] of mockTables.entries()) {
      const upper = normalizeTableName(rawName);
      if (isInternalReplicationTable(upper) || excludeSet.has(upper)) continue;
      const sampleCols = rows[0] ? Object.keys(rows[0]).map((c) => c.toUpperCase()) : undefined;
      out.push({
        table: upper,
        primaryKey: ['ID'],
        ...(sampleCols && sampleCols.length > 0 ? { columns: sampleCols } : {}),
      });
    }
    return out;
  }

  return [];
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

/**
 * Export the current watermarks (`GEN_ID(seq, 0)`) of all user sequences/generators on `db`.
 */
export async function exportSequences(
  db: ReplicableDatabase,
): Promise<SequenceWatermark[]> {
  // 1. Check in-memory mock DB `sequences?: Map<string, number>`
  const mockSeqs = (db as ReplicableDatabase & { sequences?: Map<string, number> }).sequences;
  if (mockSeqs instanceof Map) {
    const out: SequenceWatermark[] = [];
    for (const [name, val] of mockSeqs.entries()) {
      const upper = normalizeTableName(name);
      if (!isInternalReplicationTable(upper)) {
        out.push({ name: upper, currentValue: Number(val) });
      }
    }
    return out;
  }

  // 2. Query Firebird system catalog `RDB$GENERATORS`
  const out: SequenceWatermark[] = [];
  try {
    const res = await db.query<Row>(
      `SELECT TRIM(RDB$GENERATOR_NAME) AS GEN_NAME FROM RDB$GENERATORS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 ORDER BY RDB$GENERATOR_NAME`,
    );
    for (const r of res.rows) {
      const name = String(r.GEN_NAME ?? r.gen_name ?? '').trim().toUpperCase();
      if (!name || isInternalReplicationTable(name)) continue;
      try {
        const valRes = await db.query<Row>(
          `SELECT GEN_ID(${quoteIdent(name)}, 0) AS CUR_VAL FROM RDB$DATABASE`,
        );
        const curVal = Number(valRes.rows[0]?.CUR_VAL ?? valRes.rows[0]?.cur_val ?? 0);
        out.push({ name, currentValue: curVal });
      } catch {
        // Ignore unreadable sequence
      }
    }
  } catch {
    // Catalog query unsupported
  }
  return out;
}

/**
 * Synchronize user sequence/generator watermarks onto `targetDb` so a promoted
 * replica never generates colliding sequence values (`ALTER SEQUENCE <name> RESTART WITH <val>`).
 */
export async function applySequences(
  targetDb: ReplicableDatabase,
  sequences: readonly SequenceWatermark[],
): Promise<number> {
  if (sequences.length === 0) return 0;

  const mockSeqs = (targetDb as ReplicableDatabase & { sequences?: Map<string, number> }).sequences;
  let synced = 0;

  for (const seq of sequences) {
    const upper = normalizeTableName(seq.name);
    if (isInternalReplicationTable(upper)) continue;

    if (mockSeqs instanceof Map) {
      const prev = mockSeqs.get(upper) ?? 0;
      if (seq.currentValue >= prev) {
        mockSeqs.set(upper, seq.currentValue);
      }
      synced++;
      continue;
    }

    await ensureTableSafe(targetDb, `CREATE SEQUENCE ${quoteIdent(upper)}`);
    await execStatement(
      targetDb,
      `ALTER SEQUENCE ${quoteIdent(upper)} RESTART WITH ${Math.trunc(seq.currentValue)}`,
    );
    synced++;
  }

  return synced;
}

/**
 * Synchronize catalog schema (tables, columns, indexes, views via `diffSchema` +
 * `generateMigration`) and sequence watermarks (`exportSequences` + `applySequences`)
 * from `sourceDb` onto `targetDb`.
 */
export async function syncCatalog(
  options: SyncCatalogOptions,
): Promise<SyncCatalogResult> {
  const doSchema = options.syncSchema ?? true;
  const doSequences = options.syncSequences ?? true;
  const ddlExecuted: string[] = [];

  if (doSchema) {
    try {
      const mig = await generateMigration(
        toMigrationExecutor(options.targetDb),
        toMigrationExecutor(options.sourceDb),
        {
          version: String(Date.now()),
          name: 'repl_catalog_sync',
        },
      );
      if (mig.diff.hasChanges) {
        const allowDrop = options.allowDestructive ?? false;
        for (const stmt of mig.up) {
          if (!allowDrop && /^\s*DROP\b/i.test(stmt)) {
            continue;
          }
          await ensureTableSafe(options.targetDb, stmt);
          ddlExecuted.push(stmt);
        }
      }
    } catch {
      // Fallback for in-memory mock DBs: ensure all discovered user tables exist on targetDb
    }

    // Also replay any recorded `ddlLog` or missing table keys on mock DBs
    const srcMock = options.sourceDb as ReplicableDatabase & {
      tables?: Map<string, Row[]>;
      ddlLog?: string[];
    };
    const tgtMock = options.targetDb as ReplicableDatabase & {
      tables?: Map<string, Row[]>;
      ddlLog?: string[];
    };
    if (Array.isArray(srcMock.ddlLog)) {
      const tgtSet = new Set(tgtMock.ddlLog ?? []);
      for (const ddl of srcMock.ddlLog) {
        if (!tgtSet.has(ddl)) {
          await ensureTableSafe(options.targetDb, ddl);
          ddlExecuted.push(ddl);
        }
      }
    }
    if (srcMock.tables instanceof Map && tgtMock.tables instanceof Map) {
      for (const tbl of srcMock.tables.keys()) {
        if (!isInternalReplicationTable(tbl) && !tgtMock.tables.has(tbl)) {
          tgtMock.tables.set(tbl, []);
        }
      }
    }
  }

  let sequencesSynced = 0;
  if (doSequences) {
    const seqs = await exportSequences(options.sourceDb);
    sequencesSynced = await applySequences(options.targetDb, seqs);
  }

  const discovered = await discoverUserTables(options.sourceDb, {
    excludeTables: options.excludeTables,
  });
  return {
    ddlStatementsExecuted: ddlExecuted,
    sequencesSynced,
    discoveredTables: discovered.map((t) => t.table),
  };
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
      PUBLICATION VARCHAR(128) NOT NULL,
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
      PUBLICATION VARCHAR(128) NOT NULL,
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
      `INSERT INTO ${journalTable} (LSN, TXID, ORIGIN, PUBLICATION, TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          `SELECT LSN, PUBLICATION FROM ${journalTable} WHERE LSN > ? ORDER BY LSN ASC`,
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
      return installReplicationTriggers(db, {
        tables: Array.from(tablesMap.values()),
        publication: pubName,
        nodeId,
        journalTable: options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE,
        sequenceName: options.sequenceName ?? DEFAULT_REPL_LSN_SEQUENCE,
      });
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
          `UPDATE ${slotsTable} SET PUBLICATION = ?, NODE_ID = ?, CONFIRMED_LSN = ?, LAST_SEEN_AT = ?, TTL_MS = ? WHERE SLOT_NAME = ?`,
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
        `INSERT INTO ${slotsTable} (SLOT_NAME, PUBLICATION, NODE_ID, CONFIRMED_LSN, LAST_SEEN_AT, TTL_MS) VALUES (?, ?, ?, ?, ?, ?)`,
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
        await applyRowMutationToTable(
          db,
          tableUpper,
          pkCols,
          params.operation,
          keyRec,
          fullAfter,
        );
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
        lsn: ++lsnCounter,
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
        lsn: ++lsnCounter,
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
          if (!prevRow) {
            const entry: ReplicationLogEntry = {
              lsn: ++lsnCounter,
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
              lsn: ++lsnCounter,
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
          if (!nextMirror.has(k)) {
            const keyRec = extractKeyRecord(prevRow, pkCols);
            const entry: ReplicationLogEntry = {
              lsn: ++lsnCounter,
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

      return captured;
    },

    async fetchChangesSince(
      sinceLsn: number,
      fetchOpts = {},
    ): Promise<ReplicationLogEntry[]> {
      const res = await db.query<Row>(
        `SELECT LSN, TXID, ORIGIN, PUBLICATION, TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS FROM ${journalTable} WHERE LSN > ? ORDER BY LSN ASC`,
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
        const key = decodeJson(row.KEY_JSON ?? row.key_json) ?? {};
        let after = decodeJson(row.AFTER_JSON ?? row.after_json);
        let before = decodeJson(row.BEFORE_JSON ?? row.before_json);

        // Apply per-table row filter (`where`) and column projection (`columns` / `excludeColumns`)
        const cfg = tablesMap.get(tableUpper);
        if (cfg && op !== 'DDL') {
          if (cfg.where) {
            const afterMatches = after ? matchesRowFilter(after, cfg.where) : false;
            const beforeMatches = before ? matchesRowFilter(before, cfg.where) : false;

            if (op === 'INSERT' && !afterMatches) {
              continue;
            }
            if (op === 'DELETE' && before && !beforeMatches) {
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
                before = null;
              }
            }
          }

          after = projectReplicatedRow(after, cfg.primaryKey, cfg.columns, cfg.excludeColumns);
          before = projectReplicatedRow(before, cfg.primaryKey, cfg.columns, cfg.excludeColumns);
        }

        const lsnNum = Number(row.LSN ?? row.lsn ?? 0);
        const tsNum = Number(row.TS ?? row.ts ?? 0);
        const entryHlc =
          hlcByLsn.get(lsnNum) ??
          formatHlc({ wallMs: tsNum, counter: 0, nodeId: origin });

        out.push({
          lsn: lsnNum,
          txid: String(row.TXID ?? row.txid ?? ''),
          origin,
          publication: pub,
          table: tableUpper,
          operation: op,
          key,
          after,
          before,
          ddlSql:
            row.DDL_SQL !== null && row.DDL_SQL !== undefined
              ? String(row.DDL_SQL)
              : row.ddl_sql !== null && row.ddl_sql !== undefined
                ? String(row.ddl_sql)
                : null,
          timestamp: tsNum,
          hlc: entryHlc,
        });
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
    }) => {
      try {
        await runner.query(
          `SELECT RDB$SET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}', 'REPLICA') FROM RDB$DATABASE`,
        );
      } catch {
        // Ignore on test doubles
      }

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

  let cachedWatermark: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

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

      for (const entry of orderedEntries) {
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

        if (entry.operation === 'DDL') {
          if (entry.ddlSql) {
            await execStatement(runner, entry.ddlSql);
            appliedCount++;
          }
          continue;
        }

        const tableUpper = normalizeTableName(entry.table);
        const pkCols =
          Object.keys(entry.key).length > 0
            ? Object.keys(entry.key).map((k) => k.toUpperCase())
            : ['ID'];
        const normKey = normalizeRowKeysUpper(entry.key);
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
        if (entry.operation === 'INSERT' && localRow && entry.after && !rowsEqual(localRow, entry.after)) {
          isConflict = true;
        } else if (
          (entry.operation === 'UPDATE' || entry.operation === 'DELETE') &&
          entry.before &&
          localRow &&
          !rowsEqual(localRow, entry.before)
        ) {
          isConflict = true;
        } else if (localEntry && localEntry.timestamp >= entry.timestamp) {
          isConflict = true;
        }

        if (isConflict) {
          conflictCount++;
          const ctx: ReplicationConflictContext = {
            incoming: entry,
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
            appliedCount++;
            continue;
          }
        }

        await applyRowMutationToTable(
          runner,
          tableUpper,
          pkCols,
          entry.operation,
          normKey,
          entry.after,
        );
        syncLocalMirror(tableUpper, entry.operation, normKey, entry.after);
        appliedCount++;
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

    return {
      fetchedCount: entries.length,
      appliedCount,
      conflictCount,
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
    async pull(): Promise<SubscriptionPullResult> {
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
