/**
 * Shared types and constants for `firebird-wasm/replication`.
 */

import type { QueryParams, QueryResult, Row } from '../types';
import type { StandardSchemaV1 } from '../schema-validation';

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

/** Default dead-letter queue table name on replicas (`M14 Item 2`). */
export const DEFAULT_REPL_DLQ_TABLE = 'FB_REPL_DLQ$';

/** Default replication slot TTL in milliseconds (7 days). */
export const DEFAULT_REPL_SLOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Firebird 4.0 / 5.0 native binary replication journal segment magic (`'FBDR'` little-endian `0x52444246`). */
export const NATIVE_REPL_SEGMENT_MAGIC = 0x52444246;

/** Firebird 4.0 / 5.0 native binary replication protocol version (`2`). */
export const NATIVE_REPL_PROTOCOL_VERSION = 2;

/**
 * Transaction runner contract passed to `ReplicableDatabase.transaction()`.
 */
export interface ReplicableTransactionRunner {
  query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
  execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
  savepoint?<U>(name: string, fn: (sp: ReplicableTransactionRunner) => Promise<U>): Promise<U>;
}

/**
 * Minimal structural interface satisfied by `FirebirdBrowser`, `FirebirdLite`,
 * and test doubles.
 */
export interface ReplicableDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execBatch?(sql: string, rows: QueryParams[]): Promise<unknown>;
  transaction?<T>(fn: (tx: ReplicableTransactionRunner) => Promise<T>): Promise<T>;
  onEvent?(name: string, listener: (count: number) => void): Promise<() => Promise<void>>;
  /**
   * Configure Firebird's ODS header `hdr_replica_mode` (`'none'`, `'read_only'`,
   * or `'read_write'`) on a WASM database so native `IReplicator` accepts
   * incoming `"FBCHANGELOG\0"` segments (`M18 Item 1`).
   */
  setReplicaMode?(mode: 'none' | 'read_only' | 'read_write'): Promise<void>;
  /**
   * Apply a raw `"FBCHANGELOG\0"` binary segment via Firebird's native C++
   * `IAttachment::createReplicator` (`_fb_replicate_changelog`) (`M18 Item 1`).
   */
  applyChangelog?(segment: Uint8Array, options?: { transfer?: boolean }): Promise<number>;
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
  /**
   * Optional outbound row transformation / PII masking callback applied before
   * rows are emitted from this published table (`M14 Item 3`).
   */
  transformRow?: RowTransformer;
  /**
   * Optional Standard Schema v1 (`Zod` / `Valibot` / `ArkType`) validator applied
   * to published/replicated rows on this table (`M19 Item 4`).
   */
  validateSchema?: StandardSchemaV1<unknown, Record<string, unknown>>;
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
  publication: Pick<ReplicationPublication, 'exportSnapshot'> &
    Partial<Pick<ReplicationPublication, 'advanceSlot'>>;
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
  readonly transformRow?: RowTransformer;
  readonly validateSchema?: StandardSchemaV1<unknown, Record<string, unknown>>;
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
  /**
   * Optional publication-wide outbound row transformer / PII masking function (`M14 Item 3`).
   */
  transformRow?: RowTransformer;
  /**
   * Native Firebird engine publication mode (`M16 Item 4`):
   * - `'native'`: also registers the published tables in Firebird's built-in
   *   `RDB$PUBLICATIONS` / `RDB$PUBLICATION_TABLES` catalog (`ALTER DATABASE INCLUDE ... TO PUBLICATION`
   *   + `ALTER DATABASE ENABLE PUBLICATION`).
   * - `'auto'`: attempts to synchronize `RDB$PUBLICATIONS` when the database supports it,
   *   ignoring gracefully on lightweight mock databases.
   * - `'trigger'`: uses only logical journal / PSQL trigger capture without altering `RDB$PUBLICATIONS`.
   *
   * @default 'trigger'
   */
  engineMode?: 'native' | 'trigger' | 'auto';
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
   * Collapse superseded per-row mutations in `FB_REPL_JOURNAL$` (`INSERT` + `UPDATE` -> `INSERT`,
   * `UPDATE` + `UPDATE` -> `UPDATE`, `INSERT` + `DELETE` -> elided) while preserving the final LSN watermark (`M15 Item 3`).
   */
  compactJournal(options?: CompactJournalOptions): Promise<JournalCompactionResult>;
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
  /**
   * Optional incremental search index hooks (`HnswIndex`, `Bm25Index`, etc.)
   * invoked as replicated rows are inserted, updated, or deleted on this replica.
   */
  indexHooks?: readonly ReplicationIndexHook[];
  /**
   * Optional callback invoked after each individual `ReplicationLogEntry` is
   * applied on this replica.
   */
  onRowApplied?: (entry: ReplicationLogEntry) => void | Promise<void>;
  /**
   * Optional inbound row transformation / PII masking pipeline applied on the
   * replica before writing incoming rows (`M14 Item 3`).
   */
  transformRow?: RowTransformer;
  /**
   * Optional entry validator invoked before applying a DML entry on the replica.
   * Returning `false` or throwing an `Error` rejects the entry (`M14 Item 2`).
   */
  validateEntry?: (entry: ReplicationLogEntry) => boolean | void | Promise<boolean | void>;
  /**
   * Optional per-table Standard Schema v1 (`Zod` / `Valibot` / `ArkType`) row
   * validators keyed by table name (case-insensitive). Invalid rows are routed
   * through `onApplyError` (e.g. `'dlq'` quarantines them into `FB_REPL_DLQ$`) (`M19 Item 4`).
   */
  tableSchemas?: Readonly<Record<string, StandardSchemaV1<unknown, Record<string, unknown>>>>;
  /**
   * Error handling policy when applying an entry fails or `validateEntry` rejects:
   * - `'throw'` (default): abort the batch with the error.
   * - `'dlq'`: quarantine the failed entry in `FB_REPL_DLQ$` and continue applying subsequent entries.
   * - `'skip'`: skip the failed entry without recording in `FB_REPL_DLQ$`.
   * - Custom callback `(entry, error) => 'dlq' | 'skip' | 'throw'`.
   */
  onApplyError?:
    | 'throw'
    | 'dlq'
    | 'skip'
    | ((
        entry: ReplicationLogEntry,
        error: Error,
      ) => 'dlq' | 'skip' | 'throw' | Promise<'dlq' | 'skip' | 'throw'>);
  /** Custom dead-letter queue table name. @default 'FB_REPL_DLQ$' */
  dlqTable?: string;
  /**
   * Schema/DDL replay policy on the subscriber (`M15 Item 5`):
   * - `'apply'` (default): execute every incoming `DDL` journal entry as-is.
   * - `'idempotent'`: skip `CREATE TABLE` / `ALTER TABLE ADD` statements whose table or column already exists on the replica.
   * - `'additive-only'`: allow additive DDL (`CREATE TABLE`, `ALTER TABLE ADD`, `CREATE INDEX`), skip already-applied additive DDL idempotently, and reject destructive DDL (`DROP TABLE`, `ALTER TABLE DROP`, `ALTER TABLE ALTER`).
   */
  ddlPolicy?: 'apply' | 'idempotent' | 'additive-only';
}

/**
 * Incremental index maintenance hook (e.g. for `HnswIndex` vector search or
 * `Bm25Index` full-text search) invoked when a subscription applies DML changes.
 */
export interface ReplicationIndexHook {
  /** Target table name (case-insensitive, or `'*'` for all tables). */
  readonly table: string;
  /** Called when a row is inserted or updated on the replica. */
  onInsertOrUpdate?(
    row: Record<string, unknown>,
    key: Record<string, unknown>,
    entry: ReplicationLogEntry,
  ): void | Promise<void>;
  /** Called when a row is deleted on the replica. */
  onDelete?(
    key: Record<string, unknown>,
    before: Record<string, unknown> | null,
    entry: ReplicationLogEntry,
  ): void | Promise<void>;
}

/** Live lag and throughput telemetry returned by `subscription.stats()` and `replicator.stats()`. */
export interface ReplicationStats {
  /** Current replication state (`'idle'`, `'running'`, or `'syncing'`). */
  readonly status: 'idle' | 'running' | 'syncing';
  /** Highest LSN currently recorded on the source publication (`0` if unknown). */
  readonly primaryLsn: number;
  /** Last applied LSN watermark on the replica. */
  readonly replicaWatermark: number;
  /** Unapplied journal entries (`Math.max(0, primaryLsn - replicaWatermark)`). */
  readonly lagEntries: number;
  /** Age in milliseconds of the oldest unapplied journal entry on the primary (`0` when caught up). */
  readonly lagMs: number;
  /** Cumulative number of journal entries fetched by this subscriber. */
  readonly totalFetched: number;
  /** Cumulative number of journal entries applied by this subscriber. */
  readonly totalApplied: number;
  /** Cumulative number of conflicts detected and resolved. */
  readonly totalConflicts: number;
  /** Cumulative payload bytes transferred and applied. */
  readonly bytesTransferred: number;
  /** Epoch timestamp (`Date.now()`) of the last completed sync cycle, or `null`. */
  readonly lastSyncedAt: number | null;
}

/** Result of a single `subscription.pull()` cycle. */
export interface SubscriptionPullResult {
  /** Number of journal entries fetched from the publication. */
  readonly fetchedCount: number;
  /** Number of entries applied to the target database. */
  readonly appliedCount: number;
  /** Number of conflicting entries encountered and resolved. */
  readonly conflictCount: number;
  /** Number of poison entries quarantined in `FB_REPL_DLQ$` during this cycle (`M14 Item 2`). */
  readonly dlqCount?: number;
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
  /** Inspect live replication lag, watermark, and throughput telemetry. */
  stats(): Promise<ReplicationStats>;
  /** Pull and apply all pending changes from the publication up to `batchSize`. */
  pull(): Promise<SubscriptionPullResult>;
  /** Apply an explicit batch of `ReplicationLogEntry` items and advance the watermark. */
  applyChanges(entries: readonly ReplicationLogEntry[]): Promise<SubscriptionPullResult>;
  /** List quarantined poison entries in `FB_REPL_DLQ$` for this subscription (`M14 Item 2`). */
  listDlq(): Promise<ReplicationDlqEntry[]>;
  /** Retry quarantined entries from `FB_REPL_DLQ$` (`M14 Item 2`). */
  retryDlq(options?: {
    lsn?: number;
    transformEntry?: (entry: ReplicationLogEntry) => ReplicationLogEntry | Promise<ReplicationLogEntry>;
  }): Promise<{ retried: number; succeeded: number; failed: number }>;
  /** Discard quarantined entries from `FB_REPL_DLQ$` (`M14 Item 2`). */
  discardDlq(lsn?: number): Promise<number>;
  /** Start continuous background polling / event-driven replication. */
  start(): void;
  /** Stop background polling. */
  stop(): Promise<void>;
}


/** A quarantined replication journal entry stored in `FB_REPL_DLQ$`. */
export interface ReplicationDlqEntry {
  /** Journal LSN of the quarantined entry. */
  readonly lsn: number;
  /** Subscription name that encountered the failure. */
  readonly subscriptionName: string;
  /** Original `ReplicationLogEntry` payload. */
  readonly entry: ReplicationLogEntry;
  /** Error message explaining why the entry was quarantined. */
  readonly errorMessage: string;
  /** Number of retry attempts made so far (`0` on initial failure). */
  readonly retryCount: number;
  /** Total apply attempts made so far (`1` on initial failure, `retryCount + 1`). */
  readonly attempts: number;
  /** Epoch timestamp (`Date.now()`) when the entry was first quarantined. */
  readonly quarantinedAt: number;
  /** Epoch timestamp (`Date.now()`) of the most recent retry attempt, or `null`. */
  readonly lastRetriedAt: number | null;
}

/** Options for {@link createReplicationDlq}. */
export interface ReplicationDlqOptions {
  /** Default subscription name. @default 'default_sub' */
  subscriptionName?: string;
  /** Custom dead-letter queue table name. @default 'FB_REPL_DLQ$' */
  dlqTable?: string;
}

/** Dead-Letter Queue manager returned by {@link createReplicationDlq}. */
export interface ReplicationDlq {
  /** Record a failed `ReplicationLogEntry` into `FB_REPL_DLQ$`. */
  recordFailure(
    entry: ReplicationLogEntry,
    error: unknown,
    subscriptionName?: string,
  ): Promise<ReplicationDlqEntry>;
  /** Enqueue a failed `ReplicationLogEntry` into `FB_REPL_DLQ$`. */
  enqueue(input: {
    subscriptionName?: string;
    entry: ReplicationLogEntry;
    errorMessage: string;
  }): Promise<ReplicationDlqEntry>;
  /** List all quarantined entries (optionally filtered by `subscriptionName`). */
  listEntries(subscriptionName?: string): Promise<ReplicationDlqEntry[]>;
  /** Alias for {@link listEntries}. */
  list(subscriptionName?: string): Promise<ReplicationDlqEntry[]>;
  /**
   * Retry applying quarantined entries through `subscription.applyChanges()`,
   * removing entries that succeed and incrementing `RETRY_COUNT` on entries that fail.
   */
  retryDlq(
    subscription: ReplicationSubscription,
    options?: {
      lsn?: number;
      transformEntry?: (
        entry: ReplicationLogEntry,
      ) => ReplicationLogEntry | Promise<ReplicationLogEntry>;
    },
  ): Promise<{ retried: number; succeeded: number; failed: number }>;
  /** Discard quarantined entry/entries from `FB_REPL_DLQ$`. */
  discardDlq(lsn?: number, subscriptionName?: string): Promise<number>;
}

/** Context passed to a {@link RowTransformer} callback. */
export interface RowTransformContext {
  /** Upper-case table name. */
  readonly table: string;
  /** DML operation (`'INSERT'`, `'UPDATE'`, or `'DELETE'`). */
  readonly operation: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Primary key values of the row. */
  readonly key: Record<string, unknown>;
  /** Originating node identifier. */
  readonly origin: string;
}

/**
 * Pluggable outbound or inbound row transformation callback (`M14 Item 3`).
 * Returning `null` filters/drops the row from the replication stream.
 */
export type RowTransformer = (
  row: Record<string, unknown>,
  ctx: RowTransformContext,
) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

/** Built-in column masking strategy supported by {@link createPiiMaskingTransformer}. */
export type PiiColumnMaskStrategy =
  | 'redact'
  | 'email-mask'
  | 'card-last4'
  | 'hash-fnv1a'
  | 'hash-sha256'
  | 'null'
  | 'zero'
  | ((value: unknown, row: Record<string, unknown>) => unknown | Promise<unknown>);

/** Options for {@link compactJournal}. */
export interface CompactJournalOptions {
  /** Filter by publication name (optional; when omitted, compacts each publication independently). */
  publication?: string;
  /** Minimum LSN (inclusive) of the compaction window. */
  fromLsn?: number;
  /** Maximum LSN (inclusive) of the compaction window. */
  upToLsn?: number;
  /**
   * When `true` (default), an `INSERT` followed by a `DELETE` for the same
   * `(publication, table, key)` within the compaction window cancels out completely
   * unless it holds the highest LSN in the journal (in which case a tombstone is kept
   * if needed to preserve `currentLsn()`).
   *
   * @default true
   */
  elideTransientInserts?: boolean;
  /** Custom journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
}

/** Result returned by {@link compactJournal}. */
export interface JournalCompactionResult {
  /** Number of journal entries scanned in the compaction window. */
  readonly entriesBefore: number;
  /** Number of journal entries remaining in the compaction window after coalescing. */
  readonly entriesAfter: number;
  /** Number of superseded journal entries removed (`entriesBefore - entriesAfter`). */
  readonly entriesRemoved: number;
  /** Number of distinct `(table, key)` row chains that were coalesced. */
  readonly keysCompacted: number;
  /** Highest LSN in the journal after compaction. */
  readonly highestLsn: number;
}
