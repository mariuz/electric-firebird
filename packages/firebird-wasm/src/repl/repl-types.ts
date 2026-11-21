/**
 * repl-types.ts – Public TypeScript Interfaces for `<firebird-repl>` (`M28 Item 5`).
 */

import type { ParsedQueryPlan } from './plan-tree';
import type {
  AppliedMigration,
  ArrayRow,
  DatabaseInfo,
  ExplainOptions,
  FieldInfo,
  IntrospectOptions,
  MonitorStats,
  QueryResult,
  SchemaIntrospection,
  SweepResult,
} from '../types';
import type { ReplicationStats } from '../replication';
import type { ColumnarQueryResult } from '../columnar';
import type { OptimisticStoreSnapshot } from '../optimistic-store';
import type { MaterializedViewInfo } from '../materialized-view';
import type {
  ArrowIngestResult,
  ArrowIngestSource,
  LoadArrowIpcOptions,
} from '../arrow-ingest';
import type { WorkloadAdvisorReport } from '../workload-advisor';
import type { JobQueueStats } from '../job-queue';

export type { WorkloadAdvisorReport, JobQueueStats };

/** Active tab in the `<firebird-repl>` Schema Inspector, Migration Viewer, Profiler, Query Plan Explorer, Replication & Sync/Arrow Inspector sidebar. */
export type ReplInspectorTab =
  | 'schema'
  | 'migrations'
  | 'profiler'
  | 'plan'
  | 'replication'
  | 'arrow'
  | 'outbox';

export interface ReplEditableTableConfig {
  readonly table: string;
  readonly primaryKey?: string;
}

/** Columnar vector & Apache Arrow IPC stream summary displayed in `<firebird-repl>` (`M20 Item 4`). */
export interface ReplArrowInspectorInfo {
  readonly sql: string;
  readonly rowCount: number;
  readonly arrowIpcBytes: number;
  readonly vectors: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly sqlType: string;
    readonly nullCount: number;
    readonly bufferBytes: number;
  }>;
  readonly syncState?: {
    readonly state: string;
    readonly mode: string;
    readonly paused: boolean;
    readonly lagEntries: number;
    readonly replicaLsn: number;
    readonly primaryLsn: number;
  } | null;
}

/** Replication slot summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationSlotInfo {
  readonly slotName: string;
  readonly nodeId: string;
  readonly confirmedFlushLsn: number;
  readonly updatedAt: string;
}

/** Subscriber watermark summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationWatermarkInfo {
  readonly peerId: string;
  readonly lastLsn: number;
  readonly updatedAt: string;
}

/** Recent journal entry summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationJournalEntrySummary {
  readonly lsn: number;
  readonly originNode: string;
  readonly tableName: string;
  readonly op: string;
  readonly pkJson: string;
  readonly createdAt: string;
}

/** Quarantined Dead-Letter Queue (`FB_REPL_DLQ$`) entry summary displayed in the `<firebird-repl>` Replication Inspector. */
export interface ReplReplicationDlqEntrySummary {
  readonly lsn: number;
  readonly subName: string;
  readonly errorMessage: string;
  readonly retryCount: number;
  readonly quarantinedAt: string;
}

/** Native Firebird engine `RDB$PUBLICATIONS` / `RDB$PUBLICATION_TABLES` catalog summary displayed in `<firebird-repl>`. */
export interface ReplEnginePublicationInfo {
  readonly name: string;
  readonly active: boolean;
  readonly autoEnable: boolean;
  readonly publishedTables: readonly string[];
  readonly replicaMode: string | null;
  readonly replicationSequence: number | null;
}

/** Structured replication state returned by `el.replication()` in `<firebird-repl>`. */
export interface ReplReplicationInfo {
  readonly journalTableExists: boolean;
  readonly journalEntryCount: number;
  readonly minJournalLsn: number;
  readonly maxJournalLsn: number;
  readonly slots: ReplReplicationSlotInfo[];
  readonly watermarks: ReplReplicationWatermarkInfo[];
  readonly recentEntries: ReplReplicationJournalEntrySummary[];
  readonly dlqTableExists?: boolean;
  readonly dlqEntryCount?: number;
  readonly dlqEntries?: ReplReplicationDlqEntrySummary[];
  readonly enginePublication?: ReplEnginePublicationInfo | null;
  readonly liveStats?: ReplicationStats | null;
}

/** What the console needs of a database: `FirebirdBrowser` has it. */
export interface ReplDatabase {
  query(
    sql: string,
    params: unknown[],
    options: { rowMode: 'array' },
  ): Promise<QueryResult<ArrayRow>>;
  describeQuery(sql: string): Promise<{ hasResultSet: boolean }>;
  explain?(sql: string, options?: ExplainOptions): Promise<string>;
  databaseInfo?(): Promise<DatabaseInfo>;
  sweep?(): Promise<SweepResult>;
  introspect?(options?: IntrospectOptions): Promise<SchemaIntrospection>;
  monitorStats?(): Promise<MonitorStats>;
  resetMonitorStats?(): void;
  queryColumnar?(sql: string, params?: unknown[]): Promise<ColumnarQueryResult>;
  queryArrow?(sql: string, params?: unknown[]): Promise<Uint8Array>;
  loadArrowIpc?(
    tableName: string,
    source: ArrowIngestSource,
    options?: LoadArrowIpcOptions,
  ): Promise<ArrowIngestResult>;
  execBatch?(sql: string, rows: unknown[][]): Promise<{ affectedRows: number } | void>;
  execute?(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
  listMaterializedViews?(): Promise<MaterializedViewInfo[]>;
  transaction<T>(
    fn: (tx: { exec(sql: string): Promise<{ affectedRows: number }> }) => Promise<T>,
  ): Promise<T>;
}

/** One statement the console ran, as it reports it in `firebird-repl-run`. */
export interface ReplEntry {
  sql: string;
  line: number;
  ms: number;
  fields?: FieldInfo[];
  rows?: ArrayRow[];
  affectedRows?: number;
  plan?: string;
  planTree?: ParsedQueryPlan;
  info?: DatabaseInfo;
  sweep?: SweepResult;
  schema?: SchemaIntrospection;
  migrations?: AppliedMigration[];
  stats?: MonitorStats;
  replication?: ReplReplicationInfo;
  arrow?: ReplArrowInspectorInfo;
  outbox?: OptimisticStoreSnapshot;
  error?: Error;
}
