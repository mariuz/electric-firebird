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
});
