/**
 * changelog-logical.ts – Transaction & Savepoint State Machine Converting
 * Binary `"FBCHANGELOG\0"` Segments into Committed `ReplicationLogEntry[]` (`M28 Item 5`).
 */

import type { ReplicationLogEntry, SequenceWatermark } from './types';
import { decodeJrdRecordBuffer, type JrdColumnDescriptor } from './jrd-record-codec';
import {
  decodeFbChangelogOperations,
  type DecodedFbChangelogOperation,
  type ParsedFbChangelogSegment,
} from './changelog-parser';

/** Options for {@link fbChangelogToLogicalEntries} (`M17 Item 1`). */
export interface FbChangelogLogicalDecodeOptions {
  /** Per-table JRD column layouts (case-insensitive table name) for decoding record buffers. */
  tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
  /** Origin node label assigned to emitted `ReplicationLogEntry` items. @default 'fb_native' */
  origin?: string;
  /** Publication name assigned to emitted `ReplicationLogEntry` items. @default 'RDB$DEFAULT' */
  publication?: string;
  /** Starting LSN counter for emitted `ReplicationLogEntry` items. @default 1 */
  startLsn?: number;
  /** Epoch timestamp (`Date.now()`) assigned to emitted entries. */
  timestamp?: number;
}

/** Result returned by {@link fbChangelogToLogicalEntries} (`M17 Item 1`). */
export interface FbChangelogLogicalDecodeResult {
  /** Committed logical `INSERT`, `UPDATE`, `DELETE`, and `DDL` entries in commit order. */
  readonly entries: ReplicationLogEntry[];
  /** Latest generator/sequence watermarks (`opSetSequence`) emitted across the segment. */
  readonly sequences: SequenceWatermark[];
  /** Committed SQL DDL statements (`opExecuteSql` / `opExecuteSqlIntl`). */
  readonly ddlStatements: string[];
  /** Transaction numbers that committed (`opCommitTransaction`). */
  readonly committedTransactions: number[];
  /** Transaction numbers that rolled back or were cleaned up (`opRollbackTransaction` / `opCleanupTransaction`). */
  readonly rolledBackTransactions: number[];
}

export function fbChangelogToLogicalEntries(
  segmentOrBytes: Uint8Array | ParsedFbChangelogSegment,
  options: FbChangelogLogicalDecodeOptions = {},
): FbChangelogLogicalDecodeResult {
  const ops = decodeFbChangelogOperations(segmentOrBytes);
  const origin = options.origin ?? 'fb_native';
  const publication = options.publication ?? 'RDB$DEFAULT';
  const ts = options.timestamp ?? Date.now();
  let nextLsn = options.startLsn ?? 1;

  const normalizedSchemas = new Map<string, ReadonlyArray<JrdColumnDescriptor>>();
  if (options.tableSchemas) {
    for (const [tbl, cols] of Object.entries(options.tableSchemas)) {
      normalizedSchemas.set(tbl.trim().toUpperCase(), cols);
    }
  }

  interface PendingTxAction {
    readonly op: DecodedFbChangelogOperation;
  }
  interface TxState {
    actions: PendingTxAction[];
    savepointStack: number[];
    blobs: Map<string, Uint8Array>;
  }

  const activeTxs = new Map<number, TxState>();
  const getOrCreateTx = (traNum: number): TxState => {
    let tx = activeTxs.get(traNum);
    if (!tx) {
      tx = { actions: [], savepointStack: [], blobs: new Map() };
      activeTxs.set(traNum, tx);
    }
    return tx;
  };

  const entries: ReplicationLogEntry[] = [];
  const ddlStatements: string[] = [];
  const sequenceMap = new Map<string, number>();
  const committedTransactions: number[] = [];
  const rolledBackTransactions: number[] = [];

  const extractPrimaryKey = (
    cols: ReadonlyArray<JrdColumnDescriptor>,
    row: Record<string, unknown>,
  ): Record<string, unknown> => {
    const pkCols = cols.filter((c) => c.primaryKey);
    const chosen = pkCols.length > 0 ? pkCols : cols.slice(0, 1);
    const key: Record<string, unknown> = {};
    for (const c of chosen) {
      key[c.name] = row[c.name];
    }
    return key;
  };

  const flushCommittedTx = (traNumber: number, tx: TxState): void => {
    const txid = String(traNumber);
    for (const { op } of tx.actions) {
      if (op.kind === 'execute_sql') {
        ddlStatements.push(op.sql);
        entries.push({
          lsn: nextLsn++,
          txid,
          origin,
          publication,
          table: '$DDL',
          operation: 'DDL',
          key: {},
          after: null,
          before: null,
          ddlSql: op.sql,
          timestamp: ts,
        });
      } else if (op.kind === 'insert_record') {
        const tableUpper = op.tableName.trim().toUpperCase();
        const cols = normalizedSchemas.get(tableUpper);
        const after = cols ? decodeJrdRecordBuffer(op.recordData, cols, tx.blobs) : {};
        const key = cols ? extractPrimaryKey(cols, after) : {};
        entries.push({
          lsn: nextLsn++,
          txid,
          origin,
          publication,
          table: tableUpper,
          operation: 'INSERT',
          key,
          after,
          before: null,
          timestamp: ts,
        });
      } else if (op.kind === 'update_record') {
        const tableUpper = op.tableName.trim().toUpperCase();
        const cols = normalizedSchemas.get(tableUpper);
        const before = cols ? decodeJrdRecordBuffer(op.oldRecordData, cols, tx.blobs) : {};
        const after = cols ? decodeJrdRecordBuffer(op.newRecordData, cols, tx.blobs) : {};
        const key = cols ? extractPrimaryKey(cols, after) : {};
        entries.push({
          lsn: nextLsn++,
          txid,
          origin,
          publication,
          table: tableUpper,
          operation: 'UPDATE',
          key,
          after,
          before,
          timestamp: ts,
        });
      } else if (op.kind === 'delete_record') {
        const tableUpper = op.tableName.trim().toUpperCase();
        const cols = normalizedSchemas.get(tableUpper);
        const before = cols ? decodeJrdRecordBuffer(op.oldRecordData, cols, tx.blobs) : {};
        const key = cols ? extractPrimaryKey(cols, before) : {};
        entries.push({
          lsn: nextLsn++,
          txid,
          origin,
          publication,
          table: tableUpper,
          operation: 'DELETE',
          key,
          after: null,
          before,
          timestamp: ts,
        });
      }
    }
  };

  for (const op of ops) {
    if (op.kind === 'set_sequence') {
      const seqUpper = op.sequenceName.trim().toUpperCase();
      const prev = sequenceMap.get(seqUpper);
      if (prev === undefined || op.value >= prev) {
        sequenceMap.set(seqUpper, op.value);
      }
      continue;
    }

    switch (op.kind) {
      case 'start_transaction':
        activeTxs.set(op.traNumber, { actions: [], savepointStack: [], blobs: new Map() });
        break;
      case 'prepare_transaction':
      case 'define_atom':
        break;
      case 'start_savepoint': {
        const tx = getOrCreateTx(op.traNumber);
        tx.savepointStack.push(tx.actions.length);
        break;
      }
      case 'release_savepoint': {
        const tx = getOrCreateTx(op.traNumber);
        if (tx.savepointStack.length > 0) tx.savepointStack.pop();
        break;
      }
      case 'rollback_savepoint': {
        const tx = getOrCreateTx(op.traNumber);
        const targetLen = tx.savepointStack.pop();
        if (targetLen !== undefined) {
          tx.actions.length = targetLen;
        }
        break;
      }
      case 'store_blob': {
        const tx = getOrCreateTx(op.traNumber);
        tx.blobs.set(op.blobIdHex, op.data);
        break;
      }
      case 'insert_record':
      case 'update_record':
      case 'delete_record':
      case 'execute_sql': {
        const tx = getOrCreateTx(op.traNumber);
        tx.actions.push({ op });
        break;
      }
      case 'commit_transaction': {
        const tx = activeTxs.get(op.traNumber);
        if (tx) {
          flushCommittedTx(op.traNumber, tx);
          activeTxs.delete(op.traNumber);
        }
        committedTransactions.push(op.traNumber);
        break;
      }
      case 'rollback_transaction':
      case 'cleanup_transaction': {
        if (op.traNumber === 0 && op.kind === 'cleanup_transaction') {
          for (const k of activeTxs.keys()) rolledBackTransactions.push(k);
          activeTxs.clear();
        } else {
          activeTxs.delete(op.traNumber);
          rolledBackTransactions.push(op.traNumber);
        }
        break;
      }
    }
  }

  const sequences: SequenceWatermark[] = Array.from(sequenceMap.entries()).map(
    ([name, currentValue]) => ({ name, currentValue }),
  );

  return {
    entries,
    sequences,
    ddlStatements,
    committedTransactions,
    rolledBackTransactions,
  };
}
