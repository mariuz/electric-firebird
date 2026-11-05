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
}

/** Options for {@link createPublication}. */
export interface CreatePublicationOptions {
  /** Logical name of the publication (e.g. `'main_pub'`). @default 'default' */
  name?: string;
  /** Unique node identifier for this database instance (used for loop prevention & LWW). */
  nodeId?: string;
  /** Tables published by this publication (names or `{ table, primaryKey }` configs). */
  tables: ReadonlyArray<string | PublishedTableConfig>;
  /** Custom journal table name. @default 'FB_REPL_JOURNAL$' */
  journalTable?: string;
  /** Custom mirror table name for `captureTableChanges()`. @default 'FB_REPL_MIRROR$' */
  mirrorTable?: string;
}

/** A logical replication publication on a source database. */
export interface ReplicationPublication {
  /** Publication name. */
  readonly name: string;
  /** Originating node identifier. */
  readonly nodeId: string;
  /** Published table configurations keyed by upper-case table name. */
  readonly tables: ReadonlyMap<string, { table: string; primaryKey: readonly string[] }>;
  /** Return the highest LSN currently recorded in the journal. */
  currentLsn(): Promise<number>;
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
}

/** A logical replication subscription on a target/replica database. */
export interface ReplicationSubscription {
  /** Subscription name. */
  readonly name: string;
  /** Replica node identifier. */
  readonly nodeId: string;
  /** Read the last applied LSN watermark from `FB_REPL_WATERMARKS$`. */
  getWatermark(): Promise<number>;
  /** Explicitly set the LSN watermark in `FB_REPL_WATERMARKS$`. */
  setWatermark(lsn: number): Promise<void>;
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

  const tablesMap = new Map<string, { table: string; primaryKey: readonly string[] }>();
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
      tablesMap.set(upper, { table: upper, primaryKey: pk });
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
      return lsnCounter;
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
 * Create a logical replication subscription on `targetDb`.
 */
export async function createSubscription(
  targetDb: ReplicableDatabase,
  options: CreateSubscriptionOptions,
): Promise<ReplicationSubscription> {
  const subName = (options.name ?? `sub_${options.publication.name}`).trim();
  const nodeId = (options.nodeId ?? `replica_${subName}`).trim();
  const watermarkTable = quoteIdent(options.watermarkTable ?? DEFAULT_REPL_WATERMARK_TABLE);
  const batchSize = options.batchSize ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const conflictStrategy = options.onConflict ?? 'remote-wins';

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

    if (typeof targetDb.transaction === 'function') {
      await targetDb.transaction(runBatch);
    } else {
      await runBatch(targetDb);
    }

    if (highestLsn > previousLsn) {
      await setWatermark(highestLsn);
    }

    return {
      fetchedCount: entries.length,
      appliedCount,
      conflictCount,
      previousLsn,
      currentLsn: highestLsn,
    };
  };

  const pull = async (): Promise<SubscriptionPullResult> => {
    const sinceLsn = await getWatermark();
    const entries = await options.publication.fetchChangesSince(sinceLsn, {
      limit: batchSize,
      excludeOrigin: nodeId,
    });
    return applyChanges(entries);
  };

  return {
    name: subName,
    nodeId,
    getWatermark,
    setWatermark,
    pull,
    applyChanges,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void pull().catch(() => undefined);
      }, pollIntervalMs);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
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
  });

  let replicaPublication: ReplicationPublication | undefined;
  let primarySubscription: ReplicationSubscription | undefined;

  if (direction === 'bidirectional') {
    replicaPublication = await createPublication(options.replica, {
      name: 'pub_replica',
      nodeId: replicaNodeId,
      tables: options.tables,
    });
  }

  const replicaSubscription = await createSubscription(options.replica, {
    name: 'sub_from_primary',
    nodeId: replicaNodeId,
    publication: primaryPublication,
    localPublication: replicaPublication,
    onConflict: conflictStrategy,
    onConflictResolved: options.onConflictResolved,
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
    });
  }

  return {
    primaryPublication,
    replicaSubscription,
    ...(replicaPublication ? { replicaPublication } : {}),
    ...(primarySubscription ? { primarySubscription } : {}),
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
