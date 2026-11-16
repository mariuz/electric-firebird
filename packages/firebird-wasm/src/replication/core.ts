/**
 * Core Logical & Binary Replication Barrel.
 *
 * Decomposed into focused domain modules (`M20 Item 5`):
 * - `dlq-compaction.ts`: Dead-Letter Queue (`FB_REPL_DLQ$`), PII masking, journal compaction
 * - `publication.ts`: `publishAllTables`, `createPublication`
 * - `bootstrap.ts`: `needsBootstrap`, `bootstrapReplica` (`logical`, `binary-image`, `page-diff`)
 * - `subscription.ts`: `createSubscription` & conflict resolution
 * - `orchestration.ts`: `replicateDatabases`, `promoteReplica`, `asOfLsn`, `rewindToLsn`
 * - `mesh.ts`: `createReplicationMesh`, `createReplicationHub`
 * - `archive-retention.ts`: `exportJournalArchive`, `applyJournalArchive`, `applyRetentionPolicy`
 * - `object-store-wal.ts`: S3 / R2 / HTTP Object-Store WAL Shipping & Point-in-Time Restore
 */

export * from './dlq-compaction';
export * from './publication';
export * from './bootstrap';
export * from './subscription';
export * from './orchestration';
export * from './mesh';
export * from './archive-retention';
export * from './object-store-wal';
