/**
 * Dead-Letter Queue (`FB_REPL_DLQ$`), Outbound PII Masking & Journal Compaction.
 */

import type { QueryResult, Row } from '../types';
import {
  DEFAULT_REPL_DLQ_TABLE,
  DEFAULT_REPL_JOURNAL_TABLE,
  type CompactJournalOptions,
  type JournalCompactionResult,
  type PiiColumnMaskStrategy,
  type ReplicableDatabase,
  type ReplicationDlq,
  type ReplicationDlqEntry,
  type ReplicationDlqOptions,
  type ReplicationLogEntry,
  type ReplicationOperation,
  type ReplicationSubscription,
  type RowTransformer,
} from './types';
import {
  decodeJson,
  ensureTableSafe,
  execStatement,
  fnv1aHash8,
  normalizeRowKeysUpper,
  normalizeTableName,
  quoteIdent,
  serializeKeyRecord,
} from './shared';

// ---------------------------------------------------------------------------
// 10. Dead-Letter Queue (`FB_REPL_DLQ$`) & Quarantine / Retry Policy (M14 Item 2)
// ---------------------------------------------------------------------------


/**
 * Provision and manage a Dead-Letter Queue (`FB_REPL_DLQ$`) for poison replication
 * journal entries (`M14 Item 2`).
 */
export async function createReplicationDlq(
  db: ReplicableDatabase,
  options: ReplicationDlqOptions = {},
): Promise<ReplicationDlq> {
  const defaultSubName = (options.subscriptionName ?? 'default_sub').trim();
  const dlqTable = quoteIdent(options.dlqTable ?? DEFAULT_REPL_DLQ_TABLE);

  await ensureTableSafe(
    db,
    `CREATE TABLE ${dlqTable} (
      LSN BIGINT NOT NULL PRIMARY KEY,
      SUB_NAME VARCHAR(128) NOT NULL,
      ENTRY_JSON VARCHAR(8191) NOT NULL,
      ERROR_MSG VARCHAR(2000) NOT NULL,
      RETRY_COUNT INTEGER NOT NULL,
      QUARANTINED_AT BIGINT NOT NULL,
      LAST_RETRIED_AT BIGINT
    )`,
  );

  const rowToDlqEntry = (r: Row): ReplicationDlqEntry => {
    const rawJson = String(r.ENTRY_JSON ?? r.entry_json ?? '{}');
    const parsedEntry = JSON.parse(rawJson) as ReplicationLogEntry;
    const lastRetriedRaw = r.LAST_RETRIED_AT ?? r.last_retried_at;
    const retryCount = Number(r.RETRY_COUNT ?? r.retry_count ?? 0);
    return {
      lsn: Number(r.LSN ?? r.lsn ?? 0),
      subscriptionName: String(r.SUB_NAME ?? r.sub_name ?? defaultSubName),
      entry: parsedEntry,
      errorMessage: String(r.ERROR_MSG ?? r.error_msg ?? ''),
      retryCount,
      attempts: retryCount + 1,
      quarantinedAt: Number(r.QUARANTINED_AT ?? r.quarantined_at ?? 0),
      lastRetriedAt:
        lastRetriedRaw !== null && lastRetriedRaw !== undefined
          ? Number(lastRetriedRaw)
          : null,
    };
  };

  const recordFailure = async (
    entry: ReplicationLogEntry,
    error: unknown,
    subscriptionName = defaultSubName,
  ): Promise<ReplicationDlqEntry> => {
    const errMsg =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const now = Date.now();
    const entryJson = JSON.stringify(entry);

    const existing = await db.query<Row>(
      `SELECT * FROM ${dlqTable} WHERE LSN = ?`,
      [entry.lsn],
    );
    if (existing.rows.length > 0) {
      const prev = rowToDlqEntry(existing.rows[0]!);
      const nextRetry = prev.retryCount + 1;
      await execStatement(
        db,
        `UPDATE ${dlqTable} SET ERROR_MSG = ?, RETRY_COUNT = ?, LAST_RETRIED_AT = ? WHERE LSN = ?`,
        [errMsg, nextRetry, now, entry.lsn],
      );
      return {
        ...prev,
        errorMessage: errMsg,
        retryCount: nextRetry,
        attempts: nextRetry + 1,
        lastRetriedAt: now,
      };
    }

    await execStatement(
      db,
      `INSERT INTO ${dlqTable} (LSN, SUB_NAME, ENTRY_JSON, ERROR_MSG, RETRY_COUNT, QUARANTINED_AT, LAST_RETRIED_AT) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.lsn, subscriptionName, entryJson, errMsg, 0, now, null],
    );
    return {
      lsn: entry.lsn,
      subscriptionName,
      entry,
      errorMessage: errMsg,
      retryCount: 0,
      attempts: 1,
      quarantinedAt: now,
      lastRetriedAt: null,
    };
  };

  const listEntries = async (
    subscriptionName?: string,
  ): Promise<ReplicationDlqEntry[]> => {
    const res = await db.query<Row>(`SELECT * FROM ${dlqTable}`);
    const items = res.rows.map(rowToDlqEntry);
    const filtered = subscriptionName
      ? items.filter((i) => i.subscriptionName === subscriptionName)
      : items;
    return filtered.sort((a, b) => a.lsn - b.lsn);
  };

  return {
    recordFailure,

    async enqueue(input) {
      return recordFailure(
        input.entry,
        input.errorMessage,
        input.subscriptionName ?? defaultSubName,
      );
    },

    listEntries,

    async list(subscriptionName?: string): Promise<ReplicationDlqEntry[]> {
      return listEntries(subscriptionName);
    },

    async retryDlq(
      subscription: ReplicationSubscription,
      retryOpts = {},
    ): Promise<{ retried: number; succeeded: number; failed: number }> {
      const all = await listEntries(subscription.name);
      const candidates =
        retryOpts.lsn !== undefined
          ? all.filter((e) => e.lsn === retryOpts.lsn)
          : all;

      let retried = 0;
      let succeeded = 0;
      let failed = 0;

      for (const item of candidates) {
        retried++;
        const candidateEntry = retryOpts.transformEntry
          ? await retryOpts.transformEntry(item.entry)
          : item.entry;
        try {
          const res = await subscription.applyChanges([candidateEntry]);
          if (res.appliedCount > 0 && !res.dlqCount) {
            await execStatement(db, `DELETE FROM ${dlqTable} WHERE LSN = ?`, [
              item.lsn,
            ]);
            succeeded++;
          } else {
            failed++;
          }
        } catch (err) {
          await recordFailure(candidateEntry, err, subscription.name);
          failed++;
        }
      }

      return { retried, succeeded, failed };
    },

    async discardDlq(lsn?: number, subscriptionName?: string): Promise<number> {
      const current = await listEntries(subscriptionName);
      if (lsn !== undefined) {
        const exists = current.some((i) => i.lsn === lsn);
        if (!exists) return 0;
        await execStatement(db, `DELETE FROM ${dlqTable} WHERE LSN = ?`, [lsn]);
        return 1;
      }
      for (const item of current) {
        await execStatement(db, `DELETE FROM ${dlqTable} WHERE LSN = ?`, [
          item.lsn,
        ]);
      }
      return current.length;
    },
  };
}

// ---------------------------------------------------------------------------
// 11. Data Masking, PII Redaction & Row Transformation Pipelines (`transformRow`) (M14 Item 3)
// ---------------------------------------------------------------------------

async function sha256HexString(input: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fnv1aHash8(input).toLowerCase().repeat(8);
}

function isPiiStrategyValue(val: unknown): val is PiiColumnMaskStrategy {
  return (
    typeof val === 'function' ||
    val === 'redact' ||
    val === 'email-mask' ||
    val === 'card-last4' ||
    val === 'hash-fnv1a' ||
    val === 'hash-sha256' ||
    val === 'null' ||
    val === 'zero'
  );
}

/**
 * Create a declarative per-column or per-table/per-column PII masking and row
 * transformation pipeline (`M14 Item 3`) usable in
 * `CreatePublicationOptions.transformRow`, `PublishedTableConfig.transformRow`,
 * or `CreateSubscriptionOptions.transformRow`.
 */
export function createPiiMaskingTransformer(
  rules:
    | Readonly<Record<string, PiiColumnMaskStrategy>>
    | Readonly<Record<string, Readonly<Record<string, PiiColumnMaskStrategy>>>>,
  options: { salt?: string; redactedText?: string } = {},
): RowTransformer {
  const salt = options.salt ?? '';
  const redactedText = options.redactedText ?? '[REDACTED]';

  // Normalize rule table & column names to upper-case.
  // Supports both flat `{ EMAIL: 'email-mask' }` (applied to '*') and nested `{ USERS: { EMAIL: 'email-mask' } }`.
  const normalizedRules = new Map<string, Map<string, PiiColumnMaskStrategy>>();
  const wildcardRules = new Map<string, PiiColumnMaskStrategy>();

  for (const [key, val] of Object.entries(rules)) {
    if (isPiiStrategyValue(val)) {
      wildcardRules.set(key.toUpperCase(), val);
    } else if (val && typeof val === 'object') {
      const colRules = new Map<string, PiiColumnMaskStrategy>();
      for (const [col, strategy] of Object.entries(
        val as Record<string, PiiColumnMaskStrategy>,
      )) {
        colRules.set(col.toUpperCase(), strategy);
      }
      normalizedRules.set(normalizeTableName(key), colRules);
    }
  }
  if (wildcardRules.size > 0) {
    const existingWildcard = normalizedRules.get('*');
    if (existingWildcard) {
      for (const [k, v] of wildcardRules.entries()) existingWildcard.set(k, v);
    } else {
      normalizedRules.set('*', wildcardRules);
    }
  }

  return async (row, ctx) => {
    const specificRules = normalizedRules.get(normalizeTableName(ctx.table));
    const starRules = normalizedRules.get('*');
    if (!specificRules && !starRules) {
      return row;
    }

    const out: Record<string, unknown> = { ...row };
    for (const [rawCol, val] of Object.entries(out)) {
      const upperCol = rawCol.toUpperCase();
      const strategy =
        specificRules?.get(upperCol) ?? starRules?.get(upperCol);
      if (!strategy) continue;

      if (typeof strategy === 'function') {
        out[rawCol] = await strategy(val, out);
      } else if (strategy === 'null') {
        out[rawCol] = null;
      } else if (strategy === 'zero') {
        out[rawCol] = 0;
      } else if (strategy === 'redact') {
        out[rawCol] = val === null || val === undefined ? val : redactedText;
      } else if (strategy === 'email-mask') {
        if (typeof val === 'string' && val.includes('@')) {
          const [local = '', domain = ''] = val.split('@');
          if (local.length >= 2) {
            out[rawCol] = `${local[0]}***${local[local.length - 1]}@${domain}`;
          } else {
            const first = local.length > 0 ? local[0] : '*';
            out[rawCol] = `${first}***@${domain}`;
          }
        } else if (val !== null && val !== undefined) {
          out[rawCol] = redactedText;
        }
      } else if (strategy === 'card-last4') {
        if (val !== null && val !== undefined) {
          const digits = String(val).replace(/\D/g, '');
          const last4 = digits.slice(-4).padStart(4, '*');
          const maskLen = Math.max(8, digits.length - 4);
          out[rawCol] = `${'*'.repeat(maskLen)}${last4}`;
        }
      } else if (strategy === 'hash-fnv1a') {
        if (val !== null && val !== undefined) {
          out[rawCol] = fnv1aHash8(`${salt}:${String(val)}`).toLowerCase();
        }
      } else if (strategy === 'hash-sha256') {
        if (val !== null && val !== undefined) {
          out[rawCol] = await sha256HexString(`${salt}:${String(val)}`);
        }
      }
    }
    return out;
  };
}


/**
 * Collapse superseded per-row mutations in `FB_REPL_JOURNAL$` within the specified LSN window (`M15 Item 3`):
 * - `INSERT` + $N \times$ `UPDATE` $\rightarrow$ single `INSERT` at the latest LSN with the final `after` state.
 * - `UPDATE` + $N \times$ `UPDATE` $\rightarrow$ single `UPDATE` at the latest LSN with the earliest `before` and latest `after` state.
 * - `UPDATE` + `DELETE` $\rightarrow$ single `DELETE` at the latest LSN with the earliest `before` state.
 * - `INSERT` + ($\dots$) + `DELETE` $\rightarrow$ completely elided when `elideTransientInserts !== false` (since the row never existed before the window and is deleted by the end of the window).
 * - `DDL` entries act as per-table barriers (mutations before a DDL on the same table are not merged across the DDL boundary).
 */
export async function compactJournal(
  db: ReplicableDatabase,
  options: CompactJournalOptions = {},
): Promise<JournalCompactionResult> {
  const journalTable = quoteIdent(options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE);
  const elideTransientInserts = options.elideTransientInserts ?? true;

  let res: QueryResult<Row>;
  try {
    res = await db.query<Row>(
      `SELECT * FROM ${journalTable} ORDER BY LSN ASC`,
    );
  } catch {
    return {
      entriesBefore: 0,
      entriesAfter: 0,
      entriesRemoved: 0,
      keysCompacted: 0,
      highestLsn: 0,
    };
  }

  const pubFilter = options.publication ? options.publication.trim() : null;
  const entries: ReplicationLogEntry[] = res.rows
    .map((r) => ({
      lsn: Number(r.LSN ?? r.lsn ?? 0),
      txid: String(r.TXID ?? r.txid ?? ''),
      origin: String(r.ORIGIN ?? r.origin ?? ''),
      publication: String(r.PUBLICATION ?? r.publication ?? 'default'),
      table: String(r.TABLE_NAME ?? r.table_name ?? ''),
      operation: String(r.OP ?? r.op ?? 'INSERT').toUpperCase() as ReplicationOperation,
      key: decodeJson(r.KEY_JSON ?? r.key_json ?? r.ROW_KEY ?? r.row_key) ?? {},
      after: decodeJson(r.AFTER_JSON ?? r.after_json ?? r.AFTER_ROW ?? r.after_row),
      before: decodeJson(r.BEFORE_JSON ?? r.before_json ?? r.BEFORE_ROW ?? r.before_row),
      ddlSql:
        r.DDL_SQL !== null && r.DDL_SQL !== undefined
          ? String(r.DDL_SQL)
          : r.ddl_sql !== null && r.ddl_sql !== undefined
            ? String(r.ddl_sql)
            : null,
      timestamp: Number(r.TS ?? r.ts ?? 0),
      hlc:
        r.HLC !== null && r.HLC !== undefined && String(r.HLC).length > 0
          ? String(r.HLC)
          : r.hlc !== null && r.hlc !== undefined && String(r.hlc).length > 0
            ? String(r.hlc)
            : undefined,
    }))
    .filter((e) => {
      if (pubFilter && e.publication !== pubFilter) return false;
      if (options.fromLsn !== undefined && e.lsn < options.fromLsn) return false;
      if (options.upToLsn !== undefined && e.lsn > options.upToLsn) return false;
      return true;
    });

  if (entries.length === 0) {
    return {
      entriesBefore: 0,
      entriesAfter: 0,
      entriesRemoved: 0,
      keysCompacted: 0,
      highestLsn: 0,
    };
  }

  interface ChainState {
    entries: ReplicationLogEntry[];
    netOp: 'INSERT' | 'UPDATE' | 'DELETE' | 'ELIDED';
    firstBefore: Record<string, unknown> | null;
    latestAfter: Record<string, unknown> | null;
    latestEntry: ReplicationLogEntry;
  }

  let ddlEpoch = 0;
  const chains = new Map<string, ChainState>();
  const keptDdlEntries: ReplicationLogEntry[] = [];

  for (const entry of entries) {
    if (entry.operation === 'DDL' || entry.table === '$DDL') {
      ddlEpoch++;
      keptDdlEntries.push(entry);
      continue;
    }

    const tableUpper = normalizeTableName(entry.table);
    const normKey = normalizeRowKeysUpper(entry.key);
    const pkCols = Object.keys(normKey).sort();
    const chainId = `${entry.publication}|${ddlEpoch}|${tableUpper}|${serializeKeyRecord(normKey, pkCols)}`;

    const existing = chains.get(chainId);
    if (!existing) {
      chains.set(chainId, {
        entries: [entry],
        netOp: entry.operation,
        firstBefore: entry.before,
        latestAfter: entry.after,
        latestEntry: entry,
      });
      continue;
    }

    existing.entries.push(entry);
    existing.latestEntry = entry;

    if (existing.netOp === 'ELIDED') {
      // Re-inserted after an elided INSERT+DELETE cycle
      existing.netOp = entry.operation;
      existing.firstBefore = entry.before;
      existing.latestAfter = entry.after;
    } else if (existing.netOp === 'INSERT') {
      if (entry.operation === 'UPDATE') {
        existing.netOp = 'INSERT';
        existing.latestAfter = { ...(existing.latestAfter ?? {}), ...(entry.after ?? {}) };
      } else if (entry.operation === 'DELETE') {
        if (elideTransientInserts) {
          existing.netOp = 'ELIDED';
          existing.latestAfter = null;
        } else {
          existing.netOp = 'DELETE';
          existing.latestAfter = null;
        }
      } else if (entry.operation === 'INSERT') {
        existing.netOp = 'INSERT';
        existing.latestAfter = entry.after;
      }
    } else if (existing.netOp === 'UPDATE') {
      if (entry.operation === 'UPDATE') {
        existing.netOp = 'UPDATE';
        existing.latestAfter = { ...(existing.latestAfter ?? {}), ...(entry.after ?? {}) };
      } else if (entry.operation === 'DELETE') {
        existing.netOp = 'DELETE';
        existing.latestAfter = null;
      } else if (entry.operation === 'INSERT') {
        existing.netOp = 'UPDATE';
        existing.latestAfter = entry.after;
      }
    } else if (existing.netOp === 'DELETE') {
      if (entry.operation === 'INSERT') {
        existing.netOp = 'UPDATE';
        existing.latestAfter = entry.after;
      }
    }
  }

  const lsnsToDelete: number[] = [];
  const entriesToUpdate: ReplicationLogEntry[] = [];
  let keysCompacted = 0;

  for (const chain of chains.values()) {
    if (chain.entries.length <= 1) {
      continue;
    }
    keysCompacted++;
    if (chain.netOp === 'ELIDED') {
      for (const e of chain.entries) {
        lsnsToDelete.push(e.lsn);
      }
    } else {
      // Delete all earlier entries in the chain and update the latest entry in-place
      for (let i = 0; i < chain.entries.length - 1; i++) {
        lsnsToDelete.push(chain.entries[i]!.lsn);
      }
      const finalEntry: ReplicationLogEntry = {
        ...chain.latestEntry,
        operation: chain.netOp,
        before: chain.netOp === 'INSERT' ? null : chain.firstBefore,
        after: chain.netOp === 'DELETE' ? null : chain.latestAfter,
      };
      entriesToUpdate.push(finalEntry);
    }
  }

  for (const lsn of lsnsToDelete) {
    await execStatement(db, `DELETE FROM ${journalTable} WHERE LSN = ?`, [lsn]);
  }

  for (const upd of entriesToUpdate) {
    await execStatement(
      db,
      `UPDATE ${journalTable} SET OP = ?, AFTER_JSON = ?, BEFORE_JSON = ? WHERE LSN = ?`,
      [
        upd.operation,
        upd.after ? JSON.stringify(upd.after) : null,
        upd.before ? JSON.stringify(upd.before) : null,
        upd.lsn,
      ],
    );
  }

  const entriesBefore = entries.length;
  const entriesRemoved = lsnsToDelete.length;
  const entriesAfter = entriesBefore - entriesRemoved;

  let highestLsn = 0;
  for (const e of entries) {
    if (!lsnsToDelete.includes(e.lsn) && e.lsn > highestLsn) {
      highestLsn = e.lsn;
    }
  }
  for (const d of keptDdlEntries) {
    if (d.lsn > highestLsn) {
      highestLsn = d.lsn;
    }
  }

  return {
    entriesBefore,
    entriesAfter,
    entriesRemoved,
    keysCompacted,
    highestLsn,
  };
}
