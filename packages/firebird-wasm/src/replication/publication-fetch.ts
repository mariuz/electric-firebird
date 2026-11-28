/**
 * publication-fetch.ts – Filtered & Projected Journal Delta Reader for
 * `createPublication` (`M28 Item 5`).
 */

import type { QueryResult, Row } from '../types';
import type {
  CreatePublicationOptions,
  HybridLogicalClock,
  PublishedTableConfig,
  ReplicableDatabase,
  ReplicationLogEntry,
  ReplicationOperation,
} from './types';
import {
  decodeJson,
  extractKeyRecord,
  normalizeRowKeysUpper,
  quoteIdent,
  rowsEqual,
  serializeKeyRecord,
} from './shared';
import {
  formatHlc,
  matchesRowFilter,
  projectReplicatedRow,
} from './hlc-crdt';

export interface NormalizedPubTableCfg extends Omit<PublishedTableConfig, 'primaryKey'> {
  table: string;
  primaryKey: string[];
  columns?: string[];
  excludeColumns?: string[];
  references?: string[];
}

export async function fetchPublicationChangesSince(
  ctx: {
    db: ReplicableDatabase;
    journalTable: string;
    pubName: string;
    tablesMap: Map<string, NormalizedPubTableCfg>;
    options: CreatePublicationOptions;
    hlcByLsn: Map<number, string>;
  },
  sinceLsn: number,
  fetchOpts: { limit?: number; excludeOrigin?: string } = {},
): Promise<ReplicationLogEntry[]> {
  const { db, journalTable, pubName, tablesMap, options, hlcByLsn } = ctx;
  let hasRowFilters = Boolean(options.transformRow);
  if (!hasRowFilters) {
    for (const cfg of tablesMap.values()) {
      if (cfg.where || cfg.transformRow) {
        hasRowFilters = true;
        break;
      }
    }
  }

  const canPushdownLimit =
    typeof db.execBatch === 'function' &&
    !hasRowFilters &&
    !fetchOpts.excludeOrigin &&
    typeof fetchOpts.limit === 'number' &&
    fetchOpts.limit > 0;

  const res = canPushdownLimit
    ? await db.query<Row>(
        `SELECT LSN, TXID, ORIGIN, "PUBLICATION", TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS FROM ${journalTable} WHERE LSN > ? AND "PUBLICATION" = ? ORDER BY LSN ASC ROWS 1 TO ?`,
        [sinceLsn, pubName, Math.trunc(fetchOpts.limit!)],
      )
    : await db.query<Row>(
        `SELECT LSN, TXID, ORIGIN, "PUBLICATION", TABLE_NAME, OP, KEY_JSON, AFTER_JSON, BEFORE_JSON, DDL_SQL, TS FROM ${journalTable} WHERE LSN > ? ORDER BY LSN ASC`,
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
    const tableUpper = String(row.TABLE_NAME ?? row.table_name ?? '');
    let op = String(row.OP ?? row.op ?? 'INSERT') as ReplicationOperation;
    const rawKeyJson = row.KEY_JSON ?? row.key_json;
    const rawAfterJson = row.AFTER_JSON ?? row.after_json;
    const rawBeforeJson = row.BEFORE_JSON ?? row.before_json;
    const rawDdlSql =
      row.DDL_SQL !== null && row.DDL_SQL !== undefined
        ? String(row.DDL_SQL)
        : row.ddl_sql !== null && row.ddl_sql !== undefined
          ? String(row.ddl_sql)
          : null;

    const key = decodeJson(rawKeyJson) ?? {};
    let after = decodeJson(rawAfterJson);
    const cfg = tablesMap.get(tableUpper);

    const canLazyDecodeBefore =
      rawBeforeJson !== null &&
      rawBeforeJson !== undefined &&
      rawBeforeJson !== '' &&
      !cfg?.where &&
      !cfg?.columns &&
      !cfg?.excludeColumns &&
      !cfg?.transformRow &&
      !options.transformRow;

    let eagerBefore: Record<string, unknown> | null = canLazyDecodeBefore
      ? null
      : decodeJson(rawBeforeJson);

    if (cfg && op !== 'DDL') {
      if (cfg.where) {
        const afterMatches = after ? matchesRowFilter(after, cfg.where) : false;
        const beforeMatches = eagerBefore ? matchesRowFilter(eagerBefore, cfg.where) : false;

        if (op === 'INSERT' && !afterMatches) {
          continue;
        }
        if (op === 'DELETE' && eagerBefore && !beforeMatches) {
          continue;
        }
        if (op === 'UPDATE') {
          if (!beforeMatches && !afterMatches) {
            continue;
          }
          if (beforeMatches && !afterMatches) {
            op = 'DELETE';
            after = null;
          } else if (!beforeMatches && afterMatches) {
            op = 'INSERT';
            eagerBefore = null;
          }
        }
      }

      after = projectReplicatedRow(after, cfg.primaryKey, cfg.columns, cfg.excludeColumns);
      if (!canLazyDecodeBefore) {
        eagerBefore = projectReplicatedRow(
          eagerBefore,
          cfg.primaryKey,
          cfg.columns,
          cfg.excludeColumns,
        );
      }

      const rowTx = cfg.transformRow ?? options.transformRow;
      if (rowTx && op !== 'DELETE') {
        if (after) {
          after = await rowTx(after, {
            table: tableUpper,
            operation: op,
            key,
            origin,
          });
          if (!after) continue;
        }
        if (eagerBefore) {
          eagerBefore = await rowTx(eagerBefore, {
            table: tableUpper,
            operation: op,
            key,
            origin,
          });
        }
      }
    } else if (options.transformRow && op !== 'DDL' && op !== 'DELETE') {
      if (after) {
        after = await options.transformRow(after, {
          table: tableUpper,
          operation: op,
          key,
          origin,
        });
        if (!after) continue;
      }
      if (eagerBefore) {
        eagerBefore = await options.transformRow(eagerBefore, {
          table: tableUpper,
          operation: op,
          key,
          origin,
        });
      }
    }

    const lsnNum = Number(row.LSN ?? row.lsn ?? 0);
    const tsNum = Number(row.TS ?? row.ts ?? 0);
    const entryHlc =
      hlcByLsn.get(lsnNum) ??
      formatHlc({ wallMs: tsNum, counter: 0, nodeId: origin });

    const approxBytes =
      64 +
      tableUpper.length +
      (typeof rawKeyJson === 'string' ? rawKeyJson.length : 16) +
      (typeof rawAfterJson === 'string' ? rawAfterJson.length : 0) +
      (typeof rawBeforeJson === 'string' ? rawBeforeJson.length : 0) +
      (rawDdlSql ? rawDdlSql.length : 0);

    const entryObj: ReplicationLogEntry = {
      lsn: lsnNum,
      txid: String(row.TXID ?? row.txid ?? ''),
      origin,
      publication: pub,
      table: tableUpper,
      operation: op,
      key,
      after,
      before: eagerBefore,
      ddlSql: rawDdlSql,
      timestamp: tsNum,
      hlc: entryHlc,
    };

    if (canLazyDecodeBefore) {
      let decodedBefore: Record<string, unknown> | null | undefined;
      Object.defineProperty(entryObj, 'before', {
        enumerable: true,
        configurable: true,
        get(): Record<string, unknown> | null {
          if (decodedBefore === undefined) {
            decodedBefore = decodeJson(rawBeforeJson);
          }
          return decodedBefore;
        },
      });
    }

    Object.defineProperty(entryObj, '_approxBytes', {
      value: approxBytes,
      enumerable: false,
      configurable: true,
    });

    out.push(entryObj);
    if (fetchOpts.limit && out.length >= fetchOpts.limit) {
      break;
    }
  }
  return out;
}

export async function capturePublicationTableChanges(ctx: {
  db: ReplicableDatabase;
  pubName: string;
  nodeId: string;
  txid: string;
  ts: number;
  hlc: HybridLogicalClock;
  tablesMap: Map<string, NormalizedPubTableCfg>;
  tableMirrors: Map<string, Map<string, Record<string, unknown>>>;
  isTriggerCaptured: (
    tableUpper: string,
    rec: Record<string, unknown>,
    pkCols: readonly string[],
  ) => boolean;
  allocateLsn: () => Promise<number>;
  insertJournalEntry: (entry: ReplicationLogEntry) => Promise<void>;
}): Promise<ReplicationLogEntry[]> {
  const {
    db,
    pubName,
    nodeId,
    txid,
    ts,
    hlc,
    tablesMap,
    tableMirrors,
    isTriggerCaptured,
    allocateLsn,
    insertJournalEntry,
  } = ctx;
  const captured: ReplicationLogEntry[] = [];

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
      if (!matchesRowFilter(normRow, cfg.where)) continue;
      const projectedRow =
        projectReplicatedRow(normRow, pkCols, cfg.columns, cfg.excludeColumns) ?? normRow;
      const keyRec = extractKeyRecord(projectedRow, pkCols);
      const k = serializeKeyRecord(keyRec, pkCols);
      nextMirror.set(k, projectedRow);

      if (isTriggerCaptured(tableUpper, keyRec, pkCols)) continue;
      const prevRow = prevMirror.get(k);
      if (!prevRow) {
        const entry: ReplicationLogEntry = {
          lsn: await allocateLsn(),
          txid,
          origin: nodeId,
          publication: pubName,
          table: tableUpper,
          operation: 'INSERT',
          key: keyRec,
          after: projectedRow,
          before: null,
          ddlSql: null,
          timestamp: ts,
          hlc: hlc.now(ts),
        };
        await insertJournalEntry(entry);
        captured.push(entry);
      } else if (!rowsEqual(prevRow, projectedRow)) {
        const entry: ReplicationLogEntry = {
          lsn: await allocateLsn(),
          txid,
          origin: nodeId,
          publication: pubName,
          table: tableUpper,
          operation: 'UPDATE',
          key: keyRec,
          after: projectedRow,
          before: prevRow,
          ddlSql: null,
          timestamp: ts,
          hlc: hlc.now(ts),
        };
        await insertJournalEntry(entry);
        captured.push(entry);
      }
    }

    for (const [k, prevRow] of prevMirror.entries()) {
      if (
        !nextMirror.has(k) &&
        !isTriggerCaptured(tableUpper, extractKeyRecord(prevRow, pkCols), pkCols)
      ) {
        const keyRec = extractKeyRecord(prevRow, pkCols);
        const entry: ReplicationLogEntry = {
          lsn: await allocateLsn(),
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
          hlc: hlc.now(ts),
        };
        await insertJournalEntry(entry);
        captured.push(entry);
      }
    }

    tableMirrors.set(tableUpper, nextMirror);
  }

  return captured;
}
