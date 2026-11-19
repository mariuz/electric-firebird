/**
 * tenant-slice.ts – Multi-Tenant Partitioned Replication Slices & Inbound Tenant
 * Isolation Guard (`M22 Item 1`).
 */

import {
  type BootstrapReplicaResult,
  type PublishedTableConfig,
  type ReplicableDatabase,
  type ReplicationConflictStrategy,
  type ReplicationLogEntry,
  type ReplicationPublication,
  type ReplicationSubscription,
  type SubscriptionPullResult,
} from './types';
import { normalizeRowKeysUpper, normalizeTableName, quoteIdent } from './shared';
import { matchesRowFilter } from './hlc-crdt';
import { discoverUserTables, syncCatalog } from './catalog';
import { createPublication } from './publication';
import { createSubscription } from './subscription';
import { bootstrapReplica, dropAllClonedReplicationTriggers, needsBootstrap } from './bootstrap';
import {
  createSseReplicationClient,
  type SseReplicationClient,
} from './sse-fanout';
import type { BackoffRetryOptions } from './webrtc-resilient';
import type { ReplicationTokenProvider } from './transports';
import type { SyncHandle } from './presets';
import type { ReplicationSyncCycleResult } from './orchestration';

export type TenantIsolationViolationReason =
  | 'cross-tenant-mutation'
  | 'missing-tenant-column'
  | 'shared-table-read-only'
  | 'ddl-disallowed';

/**
 * Error thrown (and translated to HTTP `403 Forbidden` by `createHttpReplicationHandler`)
 * when an inbound replication push violates tenant isolation or attempts to mutate a
 * read-only shared reference table (`M22 Item 1`).
 */
export class TenantIsolationError extends Error {
  readonly code = 'TENANT_ISOLATION_VIOLATION' as const;
  readonly status = 403 as const;
  readonly tenantColumn: string;
  readonly expectedTenantId: string | number;
  readonly actualTenantId: unknown;
  readonly table: string;
  readonly operation: string;
  readonly reason: TenantIsolationViolationReason;

  constructor(params: {
    message: string;
    tenantColumn: string;
    expectedTenantId: string | number;
    actualTenantId?: unknown;
    table: string;
    operation: string;
    reason: TenantIsolationViolationReason;
  }) {
    super(params.message);
    this.name = 'TenantIsolationError';
    this.tenantColumn = params.tenantColumn;
    this.expectedTenantId = params.expectedTenantId;
    this.actualTenantId = params.actualTenantId;
    this.table = params.table;
    this.operation = params.operation;
    this.reason = params.reason;
  }
}

export interface TenantIsolationGuardOptions {
  /** Column name identifying the owning tenant (e.g. `'TENANT_ID'` or `'WORKSPACE_ID'`). */
  tenantColumn: string;
  /** Default expected tenant identifier when not overridden per-call. */
  tenantId?: string | number;
  /** Read-only shared reference tables (inbound client writes to these tables are rejected). */
  sharedTables?: readonly string[];
  /** Whether inbound `DDL` entries are permitted. @default false */
  allowDdl?: boolean;
}

export interface TenantIsolationGuard {
  readonly tenantColumn: string;
  readonly defaultTenantId?: string | number;
  readonly sharedTables: ReadonlySet<string>;
  readonly allowDdl: boolean;
  /** Validate a single inbound `ReplicationLogEntry`, throwing {@link TenantIsolationError} on violation. */
  assertEntry(entry: ReplicationLogEntry, expectedTenantId?: string | number): void;
  /** Validate a batch of inbound `ReplicationLogEntry` items atomically before applying any. */
  assertBatch(entries: readonly ReplicationLogEntry[], expectedTenantId?: string | number): void;
  /** Filter outbound `ReplicationLogEntry` items to rows matching `tenantId` or `sharedTables`. */
  filterOutboundEntries(
    entries: readonly ReplicationLogEntry[],
    tenantId?: string | number,
  ): ReplicationLogEntry[];
}

export function valuesMatchTenantId(actual: unknown, expected: string | number): boolean {
  if (actual === null || actual === undefined) return false;
  if (actual === expected) return true;
  if (
    (typeof actual === 'string' || typeof actual === 'number' || typeof actual === 'bigint') &&
    String(actual).trim() === String(expected).trim()
  ) {
    return true;
  }
  return false;
}

export function readTenantField(
  record: Record<string, unknown> | null | undefined,
  tenantColumnUpper: string,
): { present: boolean; value: unknown } {
  if (!record) return { present: false, value: undefined };
  if (tenantColumnUpper in record) {
    return { present: true, value: record[tenantColumnUpper] };
  }
  const lower = tenantColumnUpper.toLowerCase();
  if (lower in record) {
    return { present: true, value: record[lower] };
  }
  for (const key of Object.keys(record)) {
    if (key.toUpperCase() === tenantColumnUpper) {
      return { present: true, value: record[key] };
    }
  }
  return { present: false, value: undefined };
}

/**
 * Create an inbound/outbound tenant isolation guard enforcing that replicated
 * client pushes only mutate rows belonging to `expectedTenantId` and never
 * mutate read-only `sharedTables` (`M22 Item 1`).
 */
export function createTenantIsolationGuard(
  options: TenantIsolationGuardOptions,
): TenantIsolationGuard {
  const tenantColumn = normalizeTableName(options.tenantColumn);
  if (!tenantColumn) {
    throw new RangeError('createTenantIsolationGuard requires a non-empty tenantColumn');
  }
  const sharedSet = new Set(
    (options.sharedTables ?? []).map((t) => normalizeTableName(t)),
  );
  const allowDdl = options.allowDdl === true;

  const resolveExpected = (override?: string | number): string | number => {
    const val = override !== undefined ? override : options.tenantId;
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new TenantIsolationError({
        message: `Missing tenant identifier for '${tenantColumn}' isolation check`,
        tenantColumn,
        expectedTenantId: '',
        table: '*',
        operation: 'PUSH',
        reason: 'missing-tenant-column',
      });
    }
    return val;
  };

  const assertEntry = (
    entry: ReplicationLogEntry,
    expectedOverride?: string | number,
  ): void => {
    const expected = resolveExpected(expectedOverride);

    if (entry.operation === 'DDL') {
      if (!allowDdl) {
        throw new TenantIsolationError({
          message: `Tenant '${String(expected)}' is not permitted to push DDL mutations`,
          tenantColumn,
          expectedTenantId: expected,
          table: entry.table || '<DDL>',
          operation: 'DDL',
          reason: 'ddl-disallowed',
        });
      }
      return;
    }

    const tableUpper = normalizeTableName(entry.table);
    if (sharedSet.has(tableUpper)) {
      throw new TenantIsolationError({
        message: `Shared reference table '${tableUpper}' is read-only for tenant '${String(expected)}'`,
        tenantColumn,
        expectedTenantId: expected,
        table: tableUpper,
        operation: entry.operation,
        reason: 'shared-table-read-only',
      });
    }

    if (entry.operation === 'INSERT' || entry.operation === 'UPDATE') {
      const afterField = readTenantField(entry.after ?? null, tenantColumn);
      const keyField = readTenantField(entry.key, tenantColumn);
      const candidate = afterField.present ? afterField : keyField;

      if (!candidate.present || candidate.value === null || candidate.value === undefined) {
        throw new TenantIsolationError({
          message: `Inbound ${entry.operation} on '${tableUpper}' is missing required tenant column '${tenantColumn}'`,
          tenantColumn,
          expectedTenantId: expected,
          actualTenantId: candidate.value,
          table: tableUpper,
          operation: entry.operation,
          reason: 'missing-tenant-column',
        });
      }
      if (!valuesMatchTenantId(candidate.value, expected)) {
        throw new TenantIsolationError({
          message: `Tenant isolation violation on '${tableUpper}': expected ${tenantColumn}=${String(expected)}, received ${String(candidate.value)}`,
          tenantColumn,
          expectedTenantId: expected,
          actualTenantId: candidate.value,
          table: tableUpper,
          operation: entry.operation,
          reason: 'cross-tenant-mutation',
        });
      }

      if (entry.operation === 'UPDATE' && entry.before) {
        const beforeField = readTenantField(entry.before, tenantColumn);
        if (beforeField.present && !valuesMatchTenantId(beforeField.value, expected)) {
          throw new TenantIsolationError({
            message: `Tenant isolation violation on '${tableUpper}': cannot update row owned by ${tenantColumn}=${String(beforeField.value)}`,
            tenantColumn,
            expectedTenantId: expected,
            actualTenantId: beforeField.value,
            table: tableUpper,
            operation: entry.operation,
            reason: 'cross-tenant-mutation',
          });
        }
      }
      return;
    }

    // DELETE
    const beforeField = readTenantField(entry.before ?? null, tenantColumn);
    const keyField = readTenantField(entry.key, tenantColumn);
    const delCandidate = beforeField.present ? beforeField : keyField;
    if (!delCandidate.present || delCandidate.value === null || delCandidate.value === undefined) {
      throw new TenantIsolationError({
        message: `Inbound DELETE on '${tableUpper}' is missing tenant column '${tenantColumn}' in before/key payload`,
        tenantColumn,
        expectedTenantId: expected,
        actualTenantId: delCandidate.value,
        table: tableUpper,
        operation: 'DELETE',
        reason: 'missing-tenant-column',
      });
    }
    if (!valuesMatchTenantId(delCandidate.value, expected)) {
      throw new TenantIsolationError({
        message: `Tenant isolation violation on '${tableUpper}': cannot delete row owned by ${tenantColumn}=${String(delCandidate.value)}`,
        tenantColumn,
        expectedTenantId: expected,
        actualTenantId: delCandidate.value,
        table: tableUpper,
        operation: 'DELETE',
        reason: 'cross-tenant-mutation',
      });
    }
  };

  return {
    tenantColumn,
    defaultTenantId: options.tenantId,
    sharedTables: sharedSet,
    allowDdl,
    assertEntry,
    assertBatch(entries, expectedOverride) {
      for (const entry of entries) {
        assertEntry(entry, expectedOverride);
      }
    },
    filterOutboundEntries(entries, tenantOverride) {
      const expected = resolveExpected(tenantOverride);
      return entries.filter((entry) => {
        if (entry.operation === 'DDL') return true;
        const tableUpper = normalizeTableName(entry.table);
        if (sharedSet.has(tableUpper)) return true;
        const afterField = readTenantField(entry.after ?? null, tenantColumn);
        if (afterField.present && valuesMatchTenantId(afterField.value, expected)) {
          return true;
        }
        const beforeField = readTenantField(entry.before ?? null, tenantColumn);
        if (beforeField.present && valuesMatchTenantId(beforeField.value, expected)) {
          return true;
        }
        const keyField = readTenantField(entry.key, tenantColumn);
        return keyField.present && valuesMatchTenantId(keyField.value, expected);
      });
    },
  };
}

function formatSqlTenantPredicate(tenantCol: string, tenantId: string | number): string {
  const colIdent = quoteIdent(tenantCol);
  if (typeof tenantId === 'number' && Number.isFinite(tenantId)) {
    return `${colIdent} = ${tenantId}`;
  }
  const escaped = String(tenantId).replace(/'/g, "''");
  return `${colIdent} = '${escaped}'`;
}

export interface CreateTenantReplicationSliceOptions {
  /** Authoritative multi-tenant primary database (`FirebirdLite` or `FirebirdBrowser`). */
  primary: ReplicableDatabase;
  /** Tenant-scoped edge or browser replica database (`FirebirdBrowser` or `FirebirdLite`). */
  replica: ReplicableDatabase;
  /** Column name partitioning tenant rows (e.g. `'TENANT_ID'` or `'ORG_ID'`). */
  tenantColumn: string;
  /** Tenant identifier bound to this replica slice (e.g. `'acme'` or `42`). */
  tenantId: string | number;
  /**
   * Tenant-partitioned tables to replicate (`'*'` discovers all user tables not in
   * `sharedTables` or `excludeTables` that contain `tenantColumn`).
   *
   * @default '*'
   */
  tables?: '*' | ReadonlyArray<string | PublishedTableConfig>;
  /**
   * Shared read-only reference tables (e.g. `['PLANS', 'COUNTRIES']`) replicated in
   * full from `primary -> replica`, excluded from `replica -> primary` pushes, and
   * protected by {@link TenantIsolationGuard}.
   */
  sharedTables?: ReadonlyArray<string | PublishedTableConfig>;
  /** Tables to exclude when `tables: '*'` is used. */
  excludeTables?: readonly string[];
  /** Sensitive columns stripped from outbound replication payloads (globally or per table). */
  excludeColumns?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  /** Sync direction (`'bidirectional'` enforces inbound `TenantIsolationGuard` on `replica -> primary` pushes). @default 'bidirectional' */
  direction?: 'primary-to-replica' | 'bidirectional';
  /** Conflict resolution strategy for bidirectional sync. @default 'last-write-wins' */
  onConflict?: ReplicationConflictStrategy;
  /** Automatically sync schema & bootstrap initial snapshot onto `replica`. @default true */
  bootstrap?: boolean;
  /** Snapshot wire strategy for initial slice bootstrap (`'logical'` or zero-copy `'arrow-ipc'`, `M23 Item 3`). @default 'logical' */
  bootstrapStrategy?: 'logical' | 'arrow-ipc';
  /** Parallel table concurrency for multi-table snapshot export & seeding (`M22 Item 1`). @default 4 */
  concurrency?: number;
  /** Start background polling immediately. @default false */
  live?: boolean;
  /** Poll interval in milliseconds when `live: true` or `start()` is called. @default 500 */
  pollIntervalMs?: number;
  /** Optional publication/slice name prefix. */
  name?: string;
  /** Install native Firebird PSQL capture triggers (`FB_REPL_TRG$<table>`) on primary & replica. @default true */
  installTriggers?: boolean;
  /** Optional SSE live wakeup endpoint for zero-polling tenant slice updates (`M25 Item 1`). */
  liveSse?: {
    baseUrl: string;
    authToken?: ReplicationTokenProvider;
    fetch?: typeof globalThis.fetch;
    retry?: BackoffRetryOptions;
  };
}

export interface TenantReplicationSliceHandle extends SyncHandle {
  readonly tenantColumn: string;
  readonly sseClient?: SseReplicationClient;
  readonly tenantId: string | number;
  readonly partitionedTables: readonly string[];
  readonly sharedTables: readonly string[];
  readonly guard: TenantIsolationGuard;
  readonly primaryPublication: ReplicationPublication;
  readonly replicaSubscription: ReplicationSubscription;
  readonly replicaPublication?: ReplicationPublication;
  readonly primaryInboundSubscription?: ReplicationSubscription;
  readonly bootstrapResult?: BootstrapReplicaResult;
  readonly isRunning: boolean;
  start(): void;
  close(): Promise<void>;
  /** Pull new tenant-scoped + shared-reference changes from `primary` into `replica`. */
  pullFromPrimary(): Promise<SubscriptionPullResult>;
  /**
   * Capture/validate local `replica` changes through {@link TenantIsolationGuard}
   * and push them to `primary` (throws {@link TenantIsolationError} on cross-tenant
   * or shared-table mutations).
   */
  pushToPrimary(explicitEntries?: readonly ReplicationLogEntry[]): Promise<SubscriptionPullResult>;
  syncNow(): Promise<
    ReplicationSyncCycleResult & {
      readonly pulled: number;
      readonly pushed: number;
      readonly conflicts: number;
    }
  >;
}

function resolveExcludeColumnsForTable(
  tableUpper: string,
  spec: CreateTenantReplicationSliceOptions['excludeColumns'],
): string[] | undefined {
  if (!spec) return undefined;
  if (Array.isArray(spec)) {
    return (spec as readonly string[]).map((c) => c.toUpperCase());
  }
  const rec = spec as Readonly<Record<string, readonly string[]>>;
  const match = rec[tableUpper] ?? rec[tableUpper.toLowerCase()];
  return match ? match.map((c) => c.toUpperCase()) : undefined;
}

/**
 * Provision a partitioned multi-tenant replication slice between `primary` and
 * `replica` with automatic schema sync, parallel multi-table snapshot bootstrap,
 * shared read-only reference tables, and bidirectional `TenantIsolationGuard`
 * enforcement (`M22 Item 1`).
 */
export async function createTenantReplicationSlice(
  options: CreateTenantReplicationSliceOptions,
): Promise<TenantReplicationSliceHandle> {
  const tenantCol = normalizeTableName(options.tenantColumn);
  if (!tenantCol) {
    throw new RangeError('createTenantReplicationSlice requires a non-empty tenantColumn');
  }
  const tenantId = options.tenantId;
  const safeSlug = String(tenantId)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 24) || 'tenant';
  const baseName = (options.name ?? `slice_${safeSlug}`).trim();
  const direction = options.direction ?? 'bidirectional';
  const onConflict = options.onConflict ?? 'last-write-wins';
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const installTriggers = options.installTriggers ?? true;

  // Normalize shared reference tables
  const sharedInput = options.sharedTables ?? [];
  const sharedNamesSet = new Set(
    sharedInput.map((item) =>
      normalizeTableName(typeof item === 'string' ? item : item.table),
    ),
  );

  // Discover catalog metadata on primary so PKs & columns are accurate
  const discoveredAll = await discoverUserTables(options.primary, {
    excludeTables: options.excludeTables,
  });
  const discoveredByTable = new Map<string, PublishedTableConfig>(
    discoveredAll.map((cfg) => [normalizeTableName(cfg.table), cfg]),
  );

  const sharedConfigs: PublishedTableConfig[] = sharedInput.map((item) => {
    const upper = normalizeTableName(typeof item === 'string' ? item : item.table);
    const disc = discoveredByTable.get(upper);
    const extraExclude = resolveExcludeColumnsForTable(upper, options.excludeColumns);
    if (typeof item === 'string') {
      return {
        table: upper,
        primaryKey: disc?.primaryKey ?? ['ID'],
        ...(disc?.columns ? { columns: disc.columns } : {}),
        ...(extraExclude ? { excludeColumns: extraExclude } : {}),
      };
    }
    return {
      ...disc,
      ...item,
      table: upper,
      primaryKey: item.primaryKey ?? disc?.primaryKey ?? ['ID'],
      ...(extraExclude || item.excludeColumns
        ? {
            excludeColumns: [
              ...(item.excludeColumns ?? []),
              ...(extraExclude ?? []),
            ],
          }
        : {}),
    };
  });

  // Resolve tenant-partitioned tables
  const rawTenantItems: ReadonlyArray<string | PublishedTableConfig> =
    options.tables === undefined || options.tables === '*'
      ? discoveredAll.filter((cfg) => {
          const upper = normalizeTableName(cfg.table);
          if (sharedNamesSet.has(upper)) return false;
          if (!cfg.columns || cfg.columns.length === 0) return true;
          return cfg.columns.some((c) => c.toUpperCase() === tenantCol);
        })
      : options.tables.filter((item) => {
          const upper = normalizeTableName(typeof item === 'string' ? item : item.table);
          return !sharedNamesSet.has(upper);
        });

  const sqlWhereClause = formatSqlTenantPredicate(tenantCol, tenantId);
  const partitionedConfigs: PublishedTableConfig[] = rawTenantItems.map((item) => {
    const upper = normalizeTableName(typeof item === 'string' ? item : item.table);
    const disc = discoveredByTable.get(upper);
    const extraExclude = resolveExcludeColumnsForTable(upper, options.excludeColumns);
    const userWhere = typeof item === 'string' ? undefined : item.where;

    const combinedPredicate = (row: Record<string, unknown>): boolean => {
      const norm = normalizeRowKeysUpper(row);
      const tf = readTenantField(norm, tenantCol);
      if (!tf.present || !valuesMatchTenantId(tf.value, tenantId)) {
        return false;
      }
      return userWhere ? matchesRowFilter(norm, userWhere) : true;
    };

    const baseCfg: PublishedTableConfig =
      typeof item === 'string'
        ? {
            table: upper,
            primaryKey: disc?.primaryKey ?? ['ID'],
            ...(disc?.columns ? { columns: disc.columns } : {}),
            ...(disc?.references ? { references: disc.references } : {}),
          }
        : {
            ...disc,
            ...item,
            table: upper,
            primaryKey: item.primaryKey ?? disc?.primaryKey ?? ['ID'],
          };

    const mergedExcludes = [
      ...(baseCfg.excludeColumns ?? []),
      ...(extraExclude ?? []),
    ];

    return {
      ...baseCfg,
      ...(mergedExcludes.length > 0 ? { excludeColumns: mergedExcludes } : {}),
      // If no custom JS predicate was supplied, keep `where` as SQL when safe OR
      // attach `sqlWhere` hint via predicate function with `.sqlClause` metadata
      // so both SQL snapshot pushdown and journal row filtering work seamlessly!
      where: Object.assign(combinedPredicate, {
        sqlClause:
          typeof userWhere === 'string'
            ? `(${sqlWhereClause}) AND (${userWhere})`
            : userWhere === undefined
              ? sqlWhereClause
              : undefined,
      }),
    };
  });

  const guard = createTenantIsolationGuard({
    tenantColumn: tenantCol,
    tenantId,
    sharedTables: sharedConfigs.map((c) => c.table),
    allowDdl: false,
  });

  // Sync missing table schemas onto `replica` before creating triggers/bootstrapping
  if (options.bootstrap !== false) {
    await syncCatalog({
      sourceDb: options.primary,
      targetDb: options.replica,
      excludeTables: options.excludeTables,
      syncSchema: true,
      syncSequences: false,
    });
    await dropAllClonedReplicationTriggers(options.replica);
  }

  const primaryPub = await createPublication(options.primary, {
    name: `${baseName}_pub`,
    nodeId: `primary_${baseName}`,
    tables: [...sharedConfigs, ...partitionedConfigs],
    installTriggers,
  });

  let replicaPub: ReplicationPublication | undefined;
  let primaryInboundSub: ReplicationSubscription | undefined;

  if (direction === 'bidirectional' && partitionedConfigs.length > 0) {
    // Instrument replica for tenant-partitioned tables (AND shared tables only if we want
    // illegal local writes to shared tables caught on pushToPrimary — yes! Including
    // shared tables in replica capture ensures an illegal local write on replica to a
    // shared table is caught and rejected by `guard.assertBatch` on `pushToPrimary()`!)
    const replicaCaptureTables: PublishedTableConfig[] = [
      ...partitionedConfigs.map((cfg) => ({
        table: cfg.table,
        primaryKey: cfg.primaryKey,
        ...(cfg.columns ? { columns: cfg.columns } : {}),
        ...(cfg.excludeColumns ? { excludeColumns: cfg.excludeColumns } : {}),
      })),
      ...sharedConfigs.map((cfg) => ({
        table: cfg.table,
        primaryKey: cfg.primaryKey,
        ...(cfg.columns ? { columns: cfg.columns } : {}),
      })),
    ];

    replicaPub = await createPublication(options.replica, {
      name: `${baseName}_replica_pub`,
      nodeId: `replica_${baseName}`,
      tables: replicaCaptureTables,
      installTriggers,
    });
  }

  const replicaSub = await createSubscription(options.replica, {
    name: `${baseName}_sub`,
    nodeId: `replica_${baseName}`,
    slotName: `slot_${baseName}`,
    publication: primaryPub,
    localPublication: replicaPub,
    onConflict,
    pollIntervalMs,
  });

  let bootstrapResult: BootstrapReplicaResult | undefined;
  if (options.bootstrap !== false) {
    const check = await needsBootstrap(primaryPub, replicaSub);
    const hasRowsToSeed =
      check.needed || (await replicaSub.getWatermark()) === 0;
    if (hasRowsToSeed) {
      bootstrapResult = await bootstrapReplica({
        targetDb: options.replica,
        publication: primaryPub,
        subscription: replicaSub,
        bootstrapStrategy: options.bootstrapStrategy ?? 'logical',
        concurrency,
      });
    }
  }

  if (replicaPub) {
    // Align replica journal baseline after bootstrap so seeded rows aren't echoed back
    const head = await replicaPub.currentLsn();
    primaryInboundSub = await createSubscription(options.primary, {
      name: `${baseName}_inbound`,
      nodeId: `primary_${baseName}`,
      slotName: `slot_${baseName}_inbound`,
      publication: replicaPub,
      localPublication: primaryPub,
      onConflict,
      tenantGuard: guard,
    });
    if (head > 0) {
      await primaryInboundSub.setWatermark(head);
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = !options.live;
  let closed = false;
  let syncing = false;
  let currentSyncPromise: Promise<
    ReplicationSyncCycleResult & { pulled: number; pushed: number; conflicts: number }
  > | null = null;

  const pullFromPrimary = async (
    explicitEntries?: readonly ReplicationLogEntry[],
  ): Promise<SubscriptionPullResult> => {
    if (explicitEntries) {
      return replicaSub.applyChanges(guard.filterOutboundEntries(explicitEntries, tenantId));
    }
    await primaryPub.captureTableChanges();
    return replicaSub.pull();
  };

  const pushToPrimary = async (
    explicitEntries?: readonly ReplicationLogEntry[],
  ): Promise<SubscriptionPullResult> => {
    if (explicitEntries) {
      guard.assertBatch(explicitEntries, tenantId);
      if (!primaryInboundSub) {
        throw new Error(
          `Slice '${baseName}' is configured with direction='primary-to-replica' and cannot push to primary`,
        );
      }
      return primaryInboundSub.applyChanges(explicitEntries);
    }
    if (!replicaPub || !primaryInboundSub) {
      return {
        fetchedCount: 0,
        appliedCount: 0,
        conflictCount: 0,
        previousLsn: 0,
        currentLsn: 0,
      };
    }
    await replicaPub.captureTableChanges();
    const wmk = await primaryInboundSub.getWatermark();
    const pending = await replicaPub.fetchChangesSince(wmk, {
      excludeOrigin: `primary_${baseName}`,
    });
    guard.assertBatch(pending, tenantId);
    return primaryInboundSub.pull();
  };

  const syncNow = async (): Promise<
    ReplicationSyncCycleResult & {
      readonly pulled: number;
      readonly pushed: number;
      readonly conflicts: number;
    }
  > => {
    if (syncing && currentSyncPromise) {
      return currentSyncPromise;
    }
    syncing = true;
    const runCycle = async () => {
      let replicaToPrimary: SubscriptionPullResult | undefined;
      let pushed = 0;
      let conflicts = 0;
      if (direction === 'bidirectional' && primaryInboundSub) {
        replicaToPrimary = await pushToPrimary();
        pushed += replicaToPrimary.appliedCount;
        conflicts += replicaToPrimary.conflictCount;
      }
      const primaryToReplica = await pullFromPrimary();
      conflicts += primaryToReplica.conflictCount;
      return {
        primaryToReplica,
        ...(replicaToPrimary ? { replicaToPrimary } : {}),
        pulled: primaryToReplica.appliedCount,
        pushed,
        conflicts,
      };
    };
    currentSyncPromise = runCycle();
    try {
      return await currentSyncPromise;
    } finally {
      syncing = false;
      currentSyncPromise = null;
    }
  };

  const start = (): void => {
    if (closed || timer !== null) return;
    paused = false;
    timer = setInterval(() => {
      if (!paused) {
        void syncNow().catch(() => undefined);
      }
    }, pollIntervalMs);
  };

  const pause = (): void => {
    paused = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const resume = (): void => {
    if (closed) return;
    paused = false;
    start();
  };

  const sseClient: SseReplicationClient | undefined = options.liveSse
    ? createSseReplicationClient({
        baseUrl: options.liveSse.baseUrl,
        authToken: options.liveSse.authToken,
        fetch: options.liveSse.fetch,
        retry: options.liveSse.retry,
        excludeOrigin: `replica_${baseName}`,
        onEntries: async (entries) => {
          if (closed || paused) return;
          await pullFromPrimary(entries);
        },
      })
    : undefined;

  const stop = async (): Promise<void> => {
    pause();
    if (sseClient) {
      await sseClient.close();
    }
    replicaSub.stop();
    primaryInboundSub?.stop();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await stop();
  };

  if (options.live && !sseClient) {
    start();
  }

  return {
    mode: 'logical',
    direction: direction === 'bidirectional' ? 'bidirectional' : 'one-way',
    get paused() {
      return paused;
    },
    tenantColumn: tenantCol,
    sseClient,
    tenantId,
    partitionedTables: partitionedConfigs.map((c) => c.table),
    sharedTables: sharedConfigs.map((c) => c.table),
    guard,
    primaryPublication: primaryPub,
    replicaSubscription: replicaSub,
    replicaPublication: replicaPub,
    primaryInboundSubscription: primaryInboundSub,
    bootstrapResult,
    get isRunning() {
      return timer !== null && !paused;
    },
    pullFromPrimary,
    pushToPrimary,
    syncNow,
    async waitForIdle() {
      if (currentSyncPromise) {
        await currentSyncPromise;
      } else {
        await syncNow();
      }
    },
    start,
    pause,
    resume,
    stop,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
    async stats() {
      const subStats = await replicaSub.stats();
      const primaryLsn = await primaryPub.currentLsn();
      return {
        ...subStats,
        primaryLsn,
        lagEntries: Math.max(0, primaryLsn - subStats.replicaWatermark),
      };
    },
  };
}
