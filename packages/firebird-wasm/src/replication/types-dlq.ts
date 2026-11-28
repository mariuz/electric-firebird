/**
 * types-dlq.ts – Dead-Letter Queue (`FB_REPL_DLQ$`), RowTransformer & Journal
 * Compaction TypeScript Definitions (`M30 Item 5`).
 */

import type { ReplicationLogEntry, ReplicationSubscription } from './types';

export interface ReplicationDlqEntry {
  readonly lsn: number;
  readonly subscriptionName: string;
  readonly entry: ReplicationLogEntry;
  readonly errorMessage: string;
  readonly retryCount: number;
  readonly attempts: number;
  readonly quarantinedAt: number;
  readonly lastRetriedAt: number | null;
}

export interface ReplicationDlqOptions {
  subscriptionName?: string;
  dlqTable?: string;
}

export interface ReplicationDlq {
  recordFailure(
    entry: ReplicationLogEntry,
    error: unknown,
    subscriptionName?: string,
  ): Promise<ReplicationDlqEntry>;
  enqueue(input: {
    subscriptionName?: string;
    entry: ReplicationLogEntry;
    errorMessage: string;
  }): Promise<ReplicationDlqEntry>;
  listEntries(subscriptionName?: string): Promise<ReplicationDlqEntry[]>;
  list(subscriptionName?: string): Promise<ReplicationDlqEntry[]>;
  retryDlq(
    subscription: ReplicationSubscription,
    options?: {
      lsn?: number;
      transformEntry?: (
        entry: ReplicationLogEntry,
      ) => ReplicationLogEntry | Promise<ReplicationLogEntry>;
    },
  ): Promise<{ retried: number; succeeded: number; failed: number }>;
  discardDlq(lsn?: number, subscriptionName?: string): Promise<number>;
}

export interface RowTransformContext {
  readonly table: string;
  readonly operation: 'INSERT' | 'UPDATE' | 'DELETE';
  readonly key: Record<string, unknown>;
  readonly origin: string;
}

export type RowTransformer = (
  row: Record<string, unknown>,
  ctx: RowTransformContext,
) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

export type PiiColumnMaskStrategy =
  | 'redact'
  | 'email-mask'
  | 'card-last4'
  | 'hash-fnv1a'
  | 'hash-sha256'
  | 'null'
  | 'zero'
  | ((value: unknown, row: Record<string, unknown>) => unknown | Promise<unknown>);

export interface CompactJournalOptions {
  publication?: string;
  fromLsn?: number;
  upToLsn?: number;
  elideTransientInserts?: boolean;
  journalTable?: string;
}

export interface JournalCompactionResult {
  readonly entriesBefore: number;
  readonly entriesAfter: number;
  readonly entriesRemoved: number;
  readonly keysCompacted: number;
  readonly highestLsn: number;
}
