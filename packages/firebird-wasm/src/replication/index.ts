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
  /** Optional explicit column list for trigger-based change capture (`installReplicationTriggers`). */
  columns?: readonly string[];
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

/** Options for {@link createPublication}. */
export interface CreatePublicationOptions {
  /** Logical name of the publication (e.g. `'main_pub'`). @default 'default' */
  name?: string;
  /** Unique node identifier for this database instance (used for loop prevention & LWW). */
  nodeId?: string;
  /** Tables published by this publication (names or `{ table, primaryKey, columns }` configs). */
  tables: ReadonlyArray<string | PublishedTableConfig>;
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
}

/** A logical replication publication on a source database. */
export interface ReplicationPublication {
  /** Publication name. */
  readonly name: string;
  /** Originating node identifier. */
  readonly nodeId: string;
  /** Published table configurations keyed by upper-case table name. */
  readonly tables: ReadonlyMap<
    string,
    { table: string; primaryKey: readonly string[]; columns?: readonly string[] }
  >;
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
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);
  const slotsTable = quoteIdent(options.slotsTable ?? DEFAULT_REPL_SLOTS_TABLE);
  const defaultSlotTtlMs = options.defaultSlotTtlMs ?? DEFAULT_REPL_SLOT_TTL_MS;

  const tablesMap = new Map<
    string,
    { table: string; primaryKey: readonly string[]; columns?: readonly string[] }
  >();
  for (const item of options.tables) {
    if (typeof item === 'string') {
      const upper = normalizeTableName(item);
      tablesMap.set(upper, { table: upper, primaryKey: ['ID'] });
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
      tablesMap.set(upper, {
        table: upper,
        primaryKey: pk,
        ...(columns ? { columns } : {}),
      });
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
    tables: tablesMap,

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
          rows = res.rows.map((r) => normalizeRowKeysUpper(r));
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

      const entry: ReplicationLogEntry = {
        lsn: ++lsnCounter,
        txid: params.txid ?? nextTxId(),
        origin: params.origin ?? nodeId,
        publication: pubName,
        table: tableUpper,
        operation: params.operation,
        key: keyRec,
        after: fullAfter,
        before: beforeNorm,
        ddlSql: null,
        timestamp: params.timestamp ?? Date.now(),
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
        timestamp: ddlOpts.timestamp ?? Date.now(),
      };

      await insertJournalEntry(entry);
      return entry;
    },

    async captureTableChanges(captureOpts = {}): Promise<ReplicationLogEntry[]> {
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
          const keyRec = extractKeyRecord(normRow, pkCols);
          const k = serializeKeyRecord(keyRec, pkCols);
          nextMirror.set(k, normRow);

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
              after: normRow,
              before: null,
              ddlSql: null,
              timestamp: ts,
            };
            await insertJournalEntry(entry);
            captured.push(entry);
          } else if (!rowsEqual(prevRow, normRow)) {
            const entry: ReplicationLogEntry = {
              lsn: ++lsnCounter,
              txid,
              origin: nodeId,
              publication: pubName,
              table: tableUpper,
              operation: 'UPDATE',
              key: keyRec,
              after: normRow,
              before: prevRow,
              ddlSql: null,
              timestamp: ts,
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
        out.push({
          lsn: Number(row.LSN ?? row.lsn ?? 0),
          txid: String(row.TXID ?? row.txid ?? ''),
          origin,
          publication: pub,
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
          timestamp: Number(row.TS ?? row.ts ?? 0),
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
      for (const entry of entries) {
        if (entry.lsn > highestLsn) {
          highestLsn = entry.lsn;
        }
        // Skip changes that originated on this replica node
        if (entry.origin === nodeId) {
          continue;
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
  /** Tables to replicate between `primary` and `replica`. */
  tables: ReadonlyArray<string | PublishedTableConfig>;
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
    installTriggers: options.installTriggers,
  });

  let replicaPublication: ReplicationPublication | undefined;
  let primarySubscription: ReplicationSubscription | undefined;

  if (direction === 'bidirectional') {
    replicaPublication = await createPublication(options.replica, {
      name: 'pub_replica',
      nodeId: replicaNodeId,
      tables: options.tables,
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
    async sync(): Promise<ReplicationSyncCycleResult> {
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
