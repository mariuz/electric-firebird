/**
 * replication-demo.spec.ts – Playwright E2E suite for `replication.html`
 * (Firebird Database Replication Simulator v2 & Demo).
 *
 * The simulator is fully in-browser and needs no engine, but is served by the
 * same bare (no COOP/COEP) demo server as `demo.spec.ts`.
 *
 * Assertions are written against what `demo/public/replication.js` really
 * renders: seed rows, scenario titles/tags, and inspector headers.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openReplicationSim(page: Page): Promise<void> {
  await page.goto('./replication.html');
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#primary-rows tr')).toHaveCount(3);
  await expect(page.locator('#replica-rows tr')).toHaveCount(3);
}

test.describe('Replication Simulator v2 (replication.html)', () => {
  test('boots with 3 seeded tasks on Primary and Replica and renders Setup TS', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await expect(page.locator('#primary-lsn-badge')).toContainText('Journal LSN: 3');
    await expect(page.locator('#replica-watermark-badge')).toContainText(
      'Watermark LSN: 3',
    );
    await expect(page.locator('#code-inspector')).toContainText('replicateDatabases');
  });

  test('replicates Primary inserts and updates to Replica in Scenario 1 (stream)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="stream"]').click();
    await expect(page.locator('#primary-rows tr')).toHaveCount(4);
    await expect(page.locator('#replica-rows tr')).toHaveCount(4);
    await expect(page.locator('#primary-rows')).toContainText('Streamed Task #4');
    await expect(page.locator('#replica-rows')).toContainText('Streamed Task #4');
  });

  test('converges concurrent PN-Counter and Set-Union edits in Scenario 2 (crdt)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="crdt"]').click();
    // Row #1 STOCK starts at 10; Primary +5 and Replica +3 converge to 18 on both nodes.
    for (const rows of ['#primary-rows', '#replica-rows']) {
      const row1 = page.locator(`${rows} tr`).first();
      await expect(row1).toContainText('18');
      await expect(row1).toContainText('crdt');
      await expect(row1).toContainText('hlc');
    }
  });

  test('merges non-overlapping concurrent edits in Scenario 3 (merge)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="merge"]').click();
    // TITLE changed on Primary and PRIORITY on Replica: both survive on both nodes.
    for (const rows of ['#primary-rows', '#replica-rows']) {
      const row1 = page.locator(`${rows} tr`).first();
      await expect(row1).toContainText('Merged Title (from Primary)');
      await expect(row1).toContainText('URGENT (from Replica)');
    }
  });

  test('applies multi-tenant WHERE filter and SECRET_HASH column projection in Scenario 4 (filter)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="filter"]').click();
    // Primary holds acme and globex rows; Replica only receives acme rows, minus SECRET_HASH.
    await expect(page.locator('#primary-rows')).toContainText('Globex Filtered Out');
    await expect(page.locator('#replica-rows')).toContainText('ACME Filtered Task');
    await expect(page.locator('#replica-rows')).not.toContainText('Globex Filtered Out');
    await expect(page.locator('#replica-rows')).toContainText('excluded');
  });

  test('respects lagging replication slot holdback and prunes after slot advance in Scenario 5 (slots)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="slots"]').click();
    await expect(page.locator('#slots-list')).toContainText('analytics_dr');

    // Advancing the lagging slot and pruning removes acknowledged journal entries
    await page.locator('#advance-lagging-slot').click();
    await page.locator('#prune-journal').click();
    await expect(page.locator('#journal-count-badge')).toContainText('0 entries');
  });

  test('promotes Replica to Primary in Scenario 7 (promoteReplica)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="promote"]').click();
    await expect(page.locator('#topology-badge')).toContainText('PROMOTED');
    await expect(page.locator('#event-feed')).toContainText('promoteReplica()');
    await expect(page.locator('#event-feed')).toContainText('next ID 104');
  });

  test('rewinds accidental delete via rewindToLsn in Scenario 8 (timetravel)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="timetravel"]').click();
    await expect(page.locator('#event-feed')).toContainText('rewindToLsn(');
    await expect(page.locator('#primary-rows tr')).toHaveCount(3);
    await expect(page.locator('#primary-rows')).not.toContainText(
      'ACCIDENTAL CORRUPTED TITLE',
    );
  });

  test('switches Replication Inspector tabs between Setup TS, PSQL Trigger DDL, Binary Segment, and Encrypted Segment', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('#show-trigger-ddl').click();
    await expect(page.locator('#code-inspector')).toContainText(
      'CREATE OR ALTER TRIGGER',
    );

    await page.locator('#show-binary-hex').click();
    await expect(page.locator('#code-inspector')).toContainText('Native Binary Replication Segment');

    await page.locator('#show-fbchangelog').click();
    await expect(page.locator('#code-inspector')).toContainText('ChangeLog::Header (48 bytes)');
    await expect(page.locator('#code-inspector')).toContainText('FBCHANGELOG');

    await page.locator('#show-encrypted-hex').click();
    await expect(page.locator('#code-inspector')).toContainText('0x53444246');
    await expect(page.locator('#code-inspector')).toContainText('AES-256-GCM');
  });

  test('Scenario 9 & 10: 3-Node Hub & Spoke Mesh Watermark Matrix, Dead-Letter Queue (FB_REPL_DLQ$) and Journal Compaction', async ({
    page,
  }) => {
    await openReplicationSim(page);
    await page.locator('.scenario-card[data-scenario="mesh"]').click();

    await expect(page.locator('#primary-rows')).toContainText('Edge-EU Mesh Task');
    await expect(page.locator('#replica-rows')).toContainText('Edge-US Spoke Task');
    await expect(page.locator('#slots-list')).toContainText('slot_edge_eu');
    await expect(page.locator('#slots-list')).toContainText('slot_edge_us');
    await expect(page.locator('#code-inspector')).toContainText('Watermark Matrix');
    await expect(page.locator('#code-inspector')).toContainText('firebird_replication_primary_lsn');

    await page.locator('.scenario-card[data-scenario="dlq"]').click();

    await expect(page.locator('#primary-rows')).toContainText('Compacted Final v3');
    await expect(page.locator('#replica-rows')).toContainText('Compacted Final v3');
    await expect(page.locator('#code-inspector')).toContainText('Dead-Letter Queue (FB_REPL_DLQ$)');
    await expect(page.locator('#code-inspector')).toContainText('validateEntry rejected row');
    await expect(page.locator('#event-feed')).toContainText('Scenario 10');
  });

  test('Scenario 11: Native Engine Replication (RDB$PUBLICATIONS + FBCHANGELOG\\0 48B Header & Replication::Block Inspector)', async ({
    page,
  }) => {
    await openReplicationSim(page);
    await expect(page.locator('#engine-pub-badge')).toContainText('RDB$PUBLICATIONS: RDB$DEFAULT');

    await page.locator('.scenario-card[data-scenario="fbchangelog"]').click();

    await expect(page.locator('#primary-rows')).toContainText('Native FBCHANGELOG Task');
    await expect(page.locator('#replica-rows')).toContainText('Native FBCHANGELOG Task');
    await expect(page.locator('#engine-pub-badge')).toContainText('seq 2');
    await expect(page.locator('#code-inspector')).toContainText('ChangeLog::Header (48 bytes)');
    await expect(page.locator('#code-inspector')).toContainText('opSetSequence');
    await expect(page.locator('#code-inspector')).toContainText('opInsertRecord');
    await expect(page.locator('#event-feed')).toContainText('Scenario 11');
  });

  test('Scenario 12: One-Liner syncDatabases() + Batched IBatch Replay & WebSocket FBCHANGELOG\\0 Streaming', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="oneliner-batch"]').click();

    await expect(page.locator('#primary-rows tr')).toHaveCount(6);
    await expect(page.locator('#replica-rows tr')).toHaveCount(6);
    await expect(page.locator('#primary-rows')).toContainText('IBatch Sync Task #4');
    await expect(page.locator('#replica-rows')).toContainText('IBatch Sync Task #6');
    await expect(page.locator('#code-inspector')).toContainText('openDatabase');
    await expect(page.locator('#code-inspector')).toContainText('syncDatabases');
    await expect(page.locator('#event-feed')).toContainText('Scenario 12');
    await expect(page.locator('#event-feed')).toContainText('UPDATE OR INSERT');
    await expect(page.locator('#event-feed')).toContainText('sendChangelogSegment()');
  });

  test('Scenario 13: Native mode: "native" + WebRTC 16 KB P2P Chunking & Standard Schema v1 DLQ Quarantine', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="webrtc-arrow-schema"]').click();

    await expect(page.locator('#primary-rows')).toContainText('WebRTC P2P Native Task #4');
    await expect(page.locator('#replica-rows')).toContainText('WebRTC P2P Native Task #5');
    await expect(page.locator('#code-inspector')).toContainText('SchemaValidationError');
    await expect(page.locator('#code-inspector')).toContainText('StandardSchemaV1');
    await expect(page.locator('#event-feed')).toContainText('Scenario 13');
    await expect(page.locator('#event-feed')).toContainText('createWebRtcReplicationPeer');
    await expect(page.locator('#event-feed')).toContainText('CRC-32');
  });

  test('Scenario 14: Binary .fdb Bootstrap + S3/R2 WAL Shipping PITR & db.pipeline()', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="object-store-pitr-pipeline"]').click();

    await expect(page.locator('#primary-rows')).toContainText('S3 WAL PITR Pipeline Task #4');
    await expect(page.locator('#replica-rows')).toContainText('S3 WAL PITR Pipeline Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createObjectStoreReplicationTarget');
    await expect(page.locator('#code-inspector')).toContainText("bootstrapStrategy: 'binary-image'");
    await expect(page.locator('#event-feed')).toContainText('Scenario 14');
    await expect(page.locator('#event-feed')).toContainText('restoreDatabaseToPointInTime');
    await expect(page.locator('#event-feed')).toContainText('db.pipeline()');
    await expect(page.locator('#event-feed')).toContainText('db.liveIncremental()');
  });

  test('Scenario 15: Causal createReplicaRouter() + db.table() & queryArrowStream()', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="replica-router-arrow-stream"]').click();

    await expect(page.locator('#primary-rows')).toContainText('ReplicaRouter Table Task #4');
    await expect(page.locator('#replica-rows')).toContainText('ReplicaRouter Table Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createReplicaRouter');
    await expect(page.locator('#event-feed')).toContainText('Scenario 15');
    await expect(page.locator('#event-feed')).toContainText('read-your-writes');
    await expect(page.locator('#event-feed')).toContainText('queryArrowStream()');
    await expect(page.locator('#event-feed')).toContainText('preparePipeline()');
  });

  test('Scenario 16: Multi-Tenant createTenantReplicationSlice() + db.loadArrowIpc() & Optimistic Rollback', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="tenant-slice-arrow-ingest"]').click();

    await expect(page.locator('#primary-rows')).toContainText('Arrow IPC Slice Task #4');
    await expect(page.locator('#replica-rows')).toContainText('Arrow IPC Slice Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createTenantReplicationSlice');
    await expect(page.locator('#code-inspector')).toContainText('createOptimisticMutationStore');
    await expect(page.locator('#event-feed')).toContainText('Scenario 16');
    await expect(page.locator('#event-feed')).toContainText('db.loadArrowIpc()');
    await expect(page.locator('#event-feed')).toContainText('TenantIsolationError');
    await expect(page.locator('#event-feed')).toContainText('403');
  });

  test('Scenario 17: WebCrypto JWT Claims + bootstrapStrategy: "arrow-ipc" & Durable Outbox Rebase', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="jwt-arrow-outbox"]').click();

    await expect(page.locator('#primary-rows')).toContainText('JWT Arrow Outbox Task #4');
    await expect(page.locator('#replica-rows')).toContainText('JWT Arrow Outbox Task #5');
    await expect(page.locator('#code-inspector')).toContainText('signSyncJwt');
    await expect(page.locator('#code-inspector')).toContainText('createJwtTenantAuthResolver');
    await expect(page.locator('#event-feed')).toContainText('Scenario 17');
    await expect(page.locator('#event-feed')).toContainText('JWT_ROLE_FORBIDDEN');
    await expect(page.locator('#event-feed')).toContainText('FBARSNAP');
    await expect(page.locator('#event-feed')).toContainText('FB_OPTIMISTIC_OUTBOX$');
    await expect(page.locator('#event-feed')).toContainText('db.registerVirtualTable');
  });

  test('Scenario 18: JWKS Key Rotation + Row-Level rls Claims, db.createMaterializedView() & Undo/Redo', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="jwks-rls-matview-undo"]').click();

    await expect(page.locator('#primary-rows')).toContainText('JWKS RLS MatView Task #4');
    await expect(page.locator('#replica-rows')).toContainText('JWKS RLS MatView Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createJwksKeyProvider');
    await expect(page.locator('#code-inspector')).toContainText('createUndoRedoManager');
    await expect(page.locator('#event-feed')).toContainText('Scenario 18');
    await expect(page.locator('#event-feed')).toContainText('JWT_RLS_FORBIDDEN');
    await expect(page.locator('#event-feed')).toContainText('FB_MATVIEWS$');
    await expect(page.locator('#event-feed')).toContainText('db.createMaterializedView()');
    await expect(page.locator('#event-feed')).toContainText('undo()');
  });

  test('Scenario 19: SSE Fanout Hub + Column E2EE (enc:v1:), Auto-Synced Quantized Hybrid RAG & syncDatabaseSchema()', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="sse-fanout-e2ee-hybrid-rag"]').click();

    await expect(page.locator('#primary-rows')).toContainText('SSE E2EE Hybrid RAG Task #4');
    await expect(page.locator('#replica-rows')).toContainText('SSE E2EE Hybrid RAG Task #5');
    await expect(page.locator('#replica-rows')).toContainText('enc:v1:k2:');
    await expect(page.locator('#code-inspector')).toContainText('createSseReplicationHub');
    await expect(page.locator('#code-inspector')).toContainText('createColumnEncryptionTransformer');
    await expect(page.locator('#code-inspector')).toContainText('syncDatabaseSchema');
    await expect(page.locator('#event-feed')).toContainText('Scenario 19');
    await expect(page.locator('#event-feed')).toContainText('Last-Event-ID');
    await expect(page.locator('#event-feed')).toContainText('enc:v1:k2:');
    await expect(page.locator('#event-feed')).toContainText('hybridSearch()');
    await expect(page.locator('#event-feed')).toContainText('syncDatabaseSchema()');
  });

  test('Scenario 20: Collaborative Presence + Merkle Audit Chain (FB_AUDIT_LOG$), Semantic RAG Cache & PII Anonymizer', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="presence-audit-chain-rag-cache"]').click();

    await expect(page.locator('#primary-rows')).toContainText('Presence Audit RAG Task #4');
    await expect(page.locator('#replica-rows')).toContainText('Presence Audit RAG Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createPresenceRoom');
    await expect(page.locator('#code-inspector')).toContainText('createAuditLog');
    await expect(page.locator('#code-inspector')).toContainText('createSemanticCache');
    await expect(page.locator('#code-inspector')).toContainText('anonymizeDatabase');
    await expect(page.locator('#event-feed')).toContainText('Scenario 20');
    await expect(page.locator('#event-feed')).toContainText('FB_AUDIT_LOG$');
    await expect(page.locator('#event-feed')).toContainText('verifyChain()');
    await expect(page.locator('#event-feed')).toContainText('packRagContext()');
    await expect(page.locator('#event-feed')).toContainText('anonymizeDatabase()');
  });

  test('Scenario 21: Guarded MCP Agent Server + Incremental RAG Ingester, OTel /metrics & Encrypted .fbkp Backup', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="mcp-agent-rag-ingest-otel-backup"]').click();

    await expect(page.locator('#primary-rows')).toContainText('MCP OTel Backup Task #4');
    await expect(page.locator('#replica-rows')).toContainText('MCP OTel Backup Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createFirebirdMcpServer');
    await expect(page.locator('#code-inspector')).toContainText('createRagIngester');
    await expect(page.locator('#code-inspector')).toContainText('createOtelInstrumentation');
    await expect(page.locator('#code-inspector')).toContainText('createEncryptedBackup');
    await expect(page.locator('#event-feed')).toContainText('Scenario 21');
    await expect(page.locator('#event-feed')).toContainText('read_query');
    await expect(page.locator('#event-feed')).toContainText('chunkDocument()');
    await expect(page.locator('#event-feed')).toContainText('traceparent');
    await expect(page.locator('#event-feed')).toContainText('verifyBackupArchive()');
  });

  test('Scenario 22: Durable Job Queue & Workflows + WITH RECURSIVE GraphRAG, Online Migrator & Index Advisor', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page
      .locator('.scenario-card[data-scenario="job-queue-graphrag-online-migrate-advisor"]')
      .click();

    await expect(page.locator('#primary-rows')).toContainText('JobQueue GraphRAG OnlineMig Task #4');
    await expect(page.locator('#replica-rows')).toContainText('JobQueue GraphRAG OnlineMig Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createJobQueue');
    await expect(page.locator('#code-inspector')).toContainText('graphRagSearch');
    await expect(page.locator('#code-inspector')).toContainText('createOnlineMigrator');
    await expect(page.locator('#code-inspector')).toContainText('createWorkloadAdvisor');
    await expect(page.locator('#event-feed')).toContainText('Scenario 22');
    await expect(page.locator('#event-feed')).toContainText('FB_JOB_QUEUE$');
    await expect(page.locator('#event-feed')).toContainText('runWorkflow()');
    await expect(page.locator('#event-feed')).toContainText('graphRagSearch()');
    await expect(page.locator('#event-feed')).toContainText('verifyParity()');
    await expect(page.locator('#event-feed')).toContainText('createWorkloadAdvisor()');
  });

  test('Scenario 23: Time-Series LTTB + 2D Spatial R-Tree, CloudEvents v1.0 CDC Sink & WinterCG Edge SQL Gateway', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page
      .locator('.scenario-card[data-scenario="timeseries-spatial-cdc-edge-gateway"]')
      .click();

    await expect(page.locator('#primary-rows')).toContainText('TimeSeries Spatial CDC Edge Task #4');
    await expect(page.locator('#replica-rows')).toContainText('TimeSeries Spatial CDC Edge Task #5');
    await expect(page.locator('#code-inspector')).toContainText('createTimeSeriesStore');
    await expect(page.locator('#code-inspector')).toContainText('createSpatialIndex');
    await expect(page.locator('#code-inspector')).toContainText('createChangeStreamSink');
    await expect(page.locator('#code-inspector')).toContainText('createEdgeSqlGateway');
    await expect(page.locator('#event-feed')).toContainText('Scenario 23');
    await expect(page.locator('#event-feed')).toContainText('lttbDownsample()');
    await expect(page.locator('#event-feed')).toContainText('FB_SPATIAL_INDEX$');
    await expect(page.locator('#event-feed')).toContainText('FB_CDC_OFFSETS$');
    await expect(page.locator('#event-feed')).toContainText('KeyValuePageVFS');
  });

  test('Scenario 24: Bitemporal FOR SYSTEM_TIME AS OF + Event Sourcing CQRS, Auto GraphQL/REST Gateway & Sharded Federation', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page
      .locator('.scenario-card[data-scenario="temporal-eventstore-graphql-federation"]')
      .click();

    await expect(page.locator('#primary-rows')).toContainText(
      'Temporal EventStore GraphQL Fed Task #4',
    );
    await expect(page.locator('#replica-rows')).toContainText(
      'Temporal EventStore GraphQL Fed Task #5',
    );
    await expect(page.locator('#code-inspector')).toContainText('createTemporalTable');
    await expect(page.locator('#code-inspector')).toContainText('createEventStore');
    await expect(page.locator('#code-inspector')).toContainText('createAutoApiGateway');
    await expect(page.locator('#code-inspector')).toContainText('createDatabaseFederation');
    await expect(page.locator('#code-inspector')).toContainText('createShardedPool');
    await expect(page.locator('#event-feed')).toContainText('Scenario 24');
    await expect(page.locator('#event-feed')).toContainText('FOR SYSTEM_TIME AS OF');
    await expect(page.locator('#event-feed')).toContainText('FB_EVENT_STORE$');
    await expect(page.locator('#event-feed')).toContainText('FB_EVENT_PROJECTIONS$');
    await expect(page.locator('#event-feed')).toContainText('createShardedPool()');
  });

  test('Scenario 25: Electric Postgres Parity — CDN /v1/shape + SSE, subset__* & Subquery move-in/move-out, JSONB GIN & pg_trgm', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page
      .locator('.scenario-card[data-scenario="electric-cdn-subset-subquery-jsonb-trgm"]')
      .click();

    await expect(page.locator('#primary-rows')).toContainText(
      'Electric CDN Subset JSONB Trgm Task #4',
    );
    await expect(page.locator('#replica-rows')).toContainText(
      'Electric CDN Subset JSONB Trgm Task #5',
    );
    await expect(page.locator('#code-inspector')).toContainText('createWasmShapeServer');
    await expect(page.locator('#code-inspector')).toContainText('createJsonGinIndex');
    await expect(page.locator('#code-inspector')).toContainText('createTrigramIndex');
    await expect(page.locator('#code-inspector')).toContainText('createFirebirdPrismaAdapter');
    await expect(page.locator('#event-feed')).toContainText('Scenario 25');
    await expect(page.locator('#event-feed')).toContainText('live_sse=true');
    await expect(page.locator('#event-feed')).toContainText('subset__where');
    await expect(page.locator('#event-feed')).toContainText('FB_JSON_GIN$');
    await expect(page.locator('#event-feed')).toContainText('FB_TRGM_INDEX$');
  });
});
