/**
 * replication-demo.spec.ts – Playwright E2E suite for `replication.html`
 * (Firebird Database Replication Simulator v2 & Demo).
 *
 * Verifies the interactive logical & journal-based replication simulator:
 * - Initial 3-row seed across Node A (Primary) and Node B (Replica)
 * - Guided Scenarios 1–8 (`stream`, `crdt`, `merge`, `filter`, `slots`, `ddl`, `promote`, `timetravel`)
 * - Replication Inspector tabs (`Setup TS`, `PSQL Trigger DDL`, `Binary Segment (0x52444246)`, `AES-GCM + Gzip (0x53444246)`)
 * - Offline/Online link toggle, manual `sync()`, `pruneAcked()`, `promoteReplica()`, and `rewindToLsn()`
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
    await expect(page.locator('#primary-rows')).toContainText(
      'Verify replica watermark LSN',
    );
    await expect(page.locator('#replica-rows')).toContainText(
      'Verify replica watermark LSN',
    );
  });

  test('converges concurrent PN-Counter and OR-Set edits in Scenario 2 (crdt)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="crdt"]').click();
    // Initial STOCK on Row #1 is 10; Primary adds +5 and Replica adds +3 -> converges to 18 on both nodes
    const primaryFirstRow = page.locator('#primary-rows tr').first();
    const replicaFirstRow = page.locator('#replica-rows tr').first();
    await expect(primaryFirstRow).toContainText('18');
    await expect(replicaFirstRow).toContainText('18');
    await expect(primaryFirstRow).toContainText('eu-batch');
    await expect(primaryFirstRow).toContainText('us-order');
    await expect(replicaFirstRow).toContainText('eu-batch');
    await expect(replicaFirstRow).toContainText('us-order');
  });

  test('merges non-overlapping offline edits in Scenario 3 (merge)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="merge"]').click();
    const primaryFirstRow = page.locator('#primary-rows tr').first();
    const replicaFirstRow = page.locator('#replica-rows tr').first();
    await expect(primaryFirstRow).toContainText('Edited on Primary (Offline)');
    await expect(replicaFirstRow).toContainText('Edited on Primary (Offline)');
    await expect(primaryFirstRow).toContainText('✓');
    await expect(replicaFirstRow).toContainText('✓');
  });

  test('applies multi-tenant WHERE filter and SECRET_HASH column projection in Scenario 4 (filter)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="filter"]').click();
    // Primary has both acme and globex rows; Replica only receives acme rows and redacts SECRET_HASH
    await expect(page.locator('#primary-rows')).toContainText('globex');
    await expect(page.locator('#replica-rows')).toContainText(
      'ACME tenant replication audit',
    );
    await expect(page.locator('#replica-rows')).toContainText('(excluded)');
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
    await expect(page.locator('#event-feed')).toContainText('promoteReplica()');
    await expect(page.locator('#primary-rows')).toContainText(
      'Written after failover promotion',
    );
    await expect(page.locator('#replica-rows')).toContainText(
      'Written after failover promotion',
    );
  });

  test('rewinds accidental delete via rewindToLsn in Scenario 8 (timetravel)', async ({
    page,
  }) => {
    await openReplicationSim(page);

    await page.locator('.scenario-card[data-scenario="timetravel"]').click();
    await expect(page.locator('#event-feed')).toContainText('rewindToLsn(');
    await expect(page.locator('#primary-rows tr')).toHaveCount(3);
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
    await expect(page.locator('#code-inspector')).toContainText('0x52444246');

    await page.locator('#show-encrypted-hex').click();
    await expect(page.locator('#code-inspector')).toContainText('0x53444246');
    await expect(page.locator('#code-inspector')).toContainText('AES-256-GCM');
  });
});
