/**
 * changelog-encoder.ts – `"FBCHANGELOG\0"` binary segment encoder and inline
 * logical-to-native changelog emitter (`M21 Item 5`).
 */

import type {
  ReplicableDatabase,
  ReplicationLogEntry,
  ReplicationPublication,
  SequenceWatermark,
} from './types';
import { exportSequences } from './catalog';
import {
  escapeSqlLiteral,
  normalizeTableName,
  quoteIdent,
} from './shared';
import {
  bytesToHexLower,
  encodeJrdRecordBuffer,
  introspectJrdTableSchemas,
  type JrdColumnDescriptor,
} from './jrd-record-codec';
import {
  FB_CHANGELOG_BLOCK_BEGIN_TRANS,
  FB_CHANGELOG_BLOCK_END_TRANS,
  FB_CHANGELOG_BLOCK_HEADER_BYTES,
  FB_CHANGELOG_HEADER_BYTES,
  FB_CHANGELOG_MAGIC,
  FbChangelogOpcode,
  type ReplicationEmscriptenFS,
} from './changelog-parser';

/** Input specification for encoding a `"FBCHANGELOG\0"` binary segment (`M17 Item 1` / `M17 Item 4`). */
export interface EncodeFbChangelogSegmentOptions {
  /** Changelog segment sequence number (`1`, `2`, ...). @default 1 */
  sequence?: number;
  /** Segment state (`1` = `USED`, `2` = `FULL`, `3` = `ARCHIVABLE`). @default 3 */
  state?: number;
  /** 16-byte database GUID or formatted UUID (`XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`). */
  guid?: Uint8Array | string;
  /** Replication protocol version (`2` for Firebird 6, `1` for Firebird 4/5). @default 2 */
  protocol?: number;
  /** Ordered `Replication::Block` definitions to pack into the segment. */
  blocks: ReadonlyArray<{
    traNumber: number;
    flags?: number;
    protocol?: number;
    payload: Uint8Array;
  }>;
}

/**
 * Pack a 48-byte `"FBCHANGELOG\0"` `ChangeLog::Header` and a sequence of 16-byte
 * `Replication::Block` records into a valid Firebird binary changelog segment (`M17 Item 1`).
 */
export function encodeFbChangelogSegment(options: EncodeFbChangelogSegmentOptions): Uint8Array {
  const defaultProtocol = options.protocol ?? 2;
  let totalLen = FB_CHANGELOG_HEADER_BYTES;
  for (const b of options.blocks) {
    totalLen += FB_CHANGELOG_BLOCK_HEADER_BYTES + b.payload.byteLength;
  }

  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  for (let i = 0; i < FB_CHANGELOG_MAGIC.length; i++) {
    out[i] = FB_CHANGELOG_MAGIC.charCodeAt(i);
  }
  view.setUint16(12, 1, true); // version = 1
  view.setUint16(14, options.state ?? 3, true); // state = ARCHIVABLE (3)

  if (options.guid instanceof Uint8Array && options.guid.byteLength === 16) {
    out.set(options.guid, 16);
  } else if (typeof options.guid === 'string') {
    const cleanHex = options.guid.replace(/-/g, '');
    for (let i = 0; i < 16 && i * 2 + 2 <= cleanHex.length; i++) {
      out[16 + i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16) || 0;
    }
  } else {
    for (let i = 0; i < 16; i++) out[16 + i] = (i + 1) & 0xff;
  }

  view.setBigUint64(32, BigInt(options.sequence ?? 1), true);
  view.setBigUint64(40, BigInt(totalLen), true);

  let offset = FB_CHANGELOG_HEADER_BYTES;
  for (const b of options.blocks) {
    view.setBigUint64(offset, BigInt(b.traNumber), true);
    view.setUint16(offset + 8, b.protocol ?? defaultProtocol, true);
    view.setUint16(
      offset + 10,
      b.flags ?? (FB_CHANGELOG_BLOCK_BEGIN_TRANS | FB_CHANGELOG_BLOCK_END_TRANS),
      true,
    );
    view.setUint32(offset + 12, b.payload.byteLength, true);
    out.set(b.payload, offset + FB_CHANGELOG_BLOCK_HEADER_BYTES);
    offset += FB_CHANGELOG_BLOCK_HEADER_BYTES + b.payload.byteLength;
  }

  return out;
}


// ---------------------------------------------------------------------------
// 18. Inline Single-Thread "FBCHANGELOG\0" Segment Emitter (`M19 Item 1`)
// ---------------------------------------------------------------------------

/** Options for {@link logicalEntriesToFbChangelogSegment} (`M19 Item 1`). */
export interface LogicalToFbChangelogOptions {
  /** Monotonic segment sequence number (`>= 1`). @default 1 */
  sequence?: number;
  /** Segment state (`1` = `USED`, `2` = `FULL`, `3` = `ARCHIVABLE`). @default 3 */
  state?: number;
  /** 16-byte database GUID or formatted UUID (`XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`). */
  guid?: Uint8Array | string;
  /** Replication protocol version (`2` for Firebird 6, `1` for Firebird 4/5). @default 2 */
  protocol?: 1 | 2;
  /** SQL schema name emitted in `protocol === 2` qualified atoms. @default 'PUBLIC' */
  schemaName?: string;
  /** Owner/user atom emitted for `opExecuteSqlIntl`. @default 'SYSDBA' */
  ownerName?: string;
  /** Per-table physical JRD column descriptors (e.g. from {@link introspectJrdTableSchemas}). */
  tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
  /** Optional generator/sequence watermarks to emit via `opSetSequence` (`traNumber = 0`). */
  sequences?: ReadonlyArray<SequenceWatermark>;
  /** Starting synthetic transaction number when entry `txid` is non-numeric. @default 1 */
  startingTraNumber?: number;
  /**
   * Row mutation encoding strategy:
   * - `'auto'` (default): uses binary JRD `opInsertRecord` / `opUpdateRecord` /
   *   `opDeleteRecord` (+ `opStoreBlob`) whenever `tableSchemas` defines the table
   *   and `before` images are available for `UPDATE`/`DELETE`; otherwise emits
   *   `opExecuteSqlIntl` SQL DML inside the replicated transaction block.
   * - `'jrd'`: forces binary JRD record opcodes (inferring descriptors from row values
   *   if `tableSchemas` omits the table).
   * - `'sql'`: encodes row mutations via `opExecuteSqlIntl` (`UPDATE OR INSERT` / `DELETE`),
   *   executed natively by C++ `IAttachment::createReplicator` (`TDBB_replicator`)
   *   without requiring identical physical `RDB$FIELD_ID` slot layouts.
   *
   * @default 'auto'
   */
  recordEncoding?: 'auto' | 'jrd' | 'sql';
}

function pushU32LEBytes(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function pushI64LEBytes(out: number[], v: bigint): void {
  const tmp = new Uint8Array(8);
  new DataView(tmp.buffer).setBigInt64(0, v, true);
  for (let i = 0; i < 8; i++) out.push(tmp[i]!);
}

function inferJrdColumnsFromRow(
  row: Readonly<Record<string, unknown>>,
  key: Readonly<Record<string, unknown>>,
): JrdColumnDescriptor[] {
  const keyNames = new Set(Object.keys(key).map((k) => k.toUpperCase()));
  const allKeys = new Set<string>([...Object.keys(key), ...Object.keys(row)]);
  const cols: JrdColumnDescriptor[] = [];
  for (const rawName of allKeys) {
    const name = rawName.toUpperCase();
    const sample = row[rawName] ?? row[name] ?? key[rawName] ?? key[name];
    let type: JrdColumnDescriptor['type'] = 'VARCHAR';
    let charLength: number | undefined = 64;
    if (typeof sample === 'boolean') {
      type = 'BOOLEAN';
      charLength = undefined;
    } else if (typeof sample === 'bigint') {
      type = 'BIGINT';
      charLength = undefined;
    } else if (typeof sample === 'number') {
      type = Number.isInteger(sample) ? 'INTEGER' : 'DOUBLE PRECISION';
      charLength = undefined;
    } else if (sample instanceof Uint8Array) {
      type = 'BLOB';
      charLength = undefined;
    } else if (typeof sample === 'string') {
      charLength = Math.max(32, sample.length);
    }
    cols.push({
      name,
      type,
      ...(charLength !== undefined ? { charLength, maxBytes: charLength * 4 } : {}),
      ...(type === 'BLOB' ? { blobSubType: 'BINARY' as const } : {}),
      ...(keyNames.has(name) ? { primaryKey: true } : {}),
    });
  }
  return cols;
}

function formatSqlValueForChangelog(
  val: unknown,
  colDesc?: JrdColumnDescriptor,
): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  const upperType = colDesc?.type.toUpperCase();
  if (upperType === 'BOOLEAN') {
    const b =
      typeof val === 'string' ? /^(true|1|t|yes)$/i.test(val.trim()) : Boolean(val);
    return b ? 'TRUE' : 'FALSE';
  }
  if (
    upperType === 'SMALLINT' ||
    upperType === 'INTEGER' ||
    upperType === 'INT' ||
    upperType === 'BIGINT' ||
    upperType === 'INT64' ||
    upperType === 'FLOAT' ||
    upperType === 'DOUBLE PRECISION' ||
    upperType === 'DOUBLE'
  ) {
    if (typeof val === 'bigint') return String(val);
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
    if (typeof val === 'string' && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(val.trim())) {
      return val.trim();
    }
  }
  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE';
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : 'NULL';
  }
  if (typeof val === 'bigint') {
    return String(val);
  }
  if (val instanceof Uint8Array) {
    let hex = '';
    for (let i = 0; i < val.byteLength; i++) {
      hex += val[i]!.toString(16).padStart(2, '0');
    }
    return `X'${hex}'`;
  }
  if (val instanceof Date) {
    return `'${escapeSqlLiteral(val.toISOString().replace('T', ' ').replace('Z', ''))}'`;
  }
  return `'${escapeSqlLiteral(String(val))}'`;
}

function buildDmlSqlForChangelogEntry(
  entry: ReplicationLogEntry,
  cols?: ReadonlyArray<JrdColumnDescriptor>,
): string | null {
  const tableIdent = quoteIdent(normalizeTableName(entry.table));
  const colMap = new Map<string, JrdColumnDescriptor>();
  if (cols) {
    for (const c of cols) {
      colMap.set(c.name.toUpperCase(), c);
    }
  }

  if (entry.operation === 'DELETE') {
    const keySource =
      Object.keys(entry.key).length > 0 ? entry.key : (entry.before ?? {});
    const keyEntries = Object.entries(keySource);
    if (keyEntries.length === 0) return null;
    const whereSql = keyEntries
      .map(([k, v]) => {
        const desc = colMap.get(k.toUpperCase());
        return v === null || v === undefined
          ? `${quoteIdent(k.toUpperCase())} IS NULL`
          : `${quoteIdent(k.toUpperCase())} = ${formatSqlValueForChangelog(v, desc)}`;
      })
      .join(' AND ');
    return `DELETE FROM ${tableIdent} WHERE ${whereSql}`;
  }

  if (entry.operation === 'INSERT' || entry.operation === 'UPDATE') {
    const after = entry.after ?? {};
    const rowKeys = Object.keys(after);
    if (rowKeys.length === 0) return null;
    const colList = rowKeys.map((k) => quoteIdent(k.toUpperCase())).join(', ');
    const valList = rowKeys
      .map((k) => formatSqlValueForChangelog(after[k], colMap.get(k.toUpperCase())))
      .join(', ');
    const pkCols = Object.keys(entry.key);
    if (pkCols.length > 0) {
      const matchList = pkCols.map((k) => quoteIdent(k.toUpperCase())).join(', ');
      return `UPDATE OR INSERT INTO ${tableIdent} (${colList}) VALUES (${valList}) MATCHING (${matchList})`;
    }
    return `INSERT INTO ${tableIdent} (${colList}) VALUES (${valList})`;
  }

  return null;
}

/**
 * Encode committed logical {@link ReplicationLogEntry} items and optional
 * {@link SequenceWatermark} values into a genuine Firebird `"FBCHANGELOG\0"`
 * binary segment (`48`-byte `ChangeLog::Header` + `16`-byte `Replication::Block`s) (`M19 Item 1`).
 *
 * Enables single-threaded WASM builds (`firebird-embedded-st.wasm`, where
 * `Replication::Manager` background archiver `pthread`s are absent) and logical
 * publications to stream compact binary `"FBCHANGELOG\0"` segments directly into
 * C++ `IAttachment::createReplicator` (`replica.applyChangelog()`).
 */
export function logicalEntriesToFbChangelogSegment(
  entries: readonly ReplicationLogEntry[],
  options: LogicalToFbChangelogOptions = {},
): Uint8Array {
  const protocol = options.protocol ?? 2;
  const schemaName = options.schemaName ?? 'PUBLIC';
  const ownerName = options.ownerName ?? 'SYSDBA';
  const recordEncoding = options.recordEncoding ?? 'auto';
  const utf8Enc = new TextEncoder();

  const schemaLookup = new Map<string, ReadonlyArray<JrdColumnDescriptor>>();
  if (options.tableSchemas) {
    for (const [k, v] of Object.entries(options.tableSchemas)) {
      schemaLookup.set(normalizeTableName(k), v);
    }
  }

  const blocks: Array<{
    traNumber: number;
    flags: number;
    protocol: number;
    payload: Uint8Array;
  }> = [];

  // 1. Non-transactional generator/sequence watermarks (`traNumber = 0`, `flags = 0`)
  if (options.sequences && options.sequences.length > 0) {
    const seqPayload: number[] = [];
    const seqAtoms = new Map<string, number>();
    const ensureSeqAtom = (name: string): number => {
      const existing = seqAtoms.get(name);
      if (existing !== undefined) return existing;
      const nb = utf8Enc.encode(name);
      const idx = seqAtoms.size;
      seqAtoms.set(name, idx);
      seqPayload.push(FbChangelogOpcode.opDefineAtom, nb.byteLength, ...nb);
      return idx;
    };

    const schemaIdx = protocol >= 2 ? ensureSeqAtom(schemaName) : -1;
    for (const seq of options.sequences) {
      const seqName = seq.name.trim().toUpperCase();
      if (!seqName) continue;
      const seqIdx = ensureSeqAtom(seqName);
      seqPayload.push(FbChangelogOpcode.opSetSequence);
      if (protocol >= 2) {
        pushU32LEBytes(seqPayload, schemaIdx);
      }
      pushU32LEBytes(seqPayload, seqIdx);
      pushI64LEBytes(seqPayload, BigInt(Math.trunc(seq.currentValue)));
    }

    if (seqPayload.length > 0) {
      blocks.push({
        traNumber: 0,
        flags: 0,
        protocol,
        payload: new Uint8Array(seqPayload),
      });
    }
  }

  // 2. Group consecutive entries by `txid` into atomic `Replication::Block`s
  const groups: ReplicationLogEntry[][] = [];
  for (const entry of entries) {
    const prevGroup = groups[groups.length - 1];
    if (prevGroup && prevGroup[0]!.txid && prevGroup[0]!.txid === entry.txid) {
      prevGroup.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  let nextSyntheticTra = Math.max(1, options.startingTraNumber ?? 1);
  let syntheticBlobCounter = 1;

  for (const group of groups) {
    const rawTxId = Number(group[0]!.txid);
    const traNumber =
      Number.isInteger(rawTxId) && rawTxId > 0 ? rawTxId : nextSyntheticTra++;
    if (traNumber >= nextSyntheticTra) {
      nextSyntheticTra = traNumber + 1;
    }

    const payload: number[] = [FbChangelogOpcode.opStartTransaction];
    const atoms = new Map<string, number>();
    const ensureAtom = (name: string): number => {
      const existing = atoms.get(name);
      if (existing !== undefined) return existing;
      const nb = utf8Enc.encode(name);
      const idx = atoms.size;
      atoms.set(name, idx);
      payload.push(FbChangelogOpcode.opDefineAtom, nb.byteLength, ...nb);
      return idx;
    };

    const emitExecuteSql = (sql: string): void => {
      const ownerIdx = ensureAtom(ownerName);
      const searchIdx = protocol >= 2 ? ensureAtom(schemaName) : -1;
      const sqlBytes = utf8Enc.encode(sql);
      payload.push(FbChangelogOpcode.opExecuteSqlIntl);
      pushU32LEBytes(payload, ownerIdx);
      if (protocol >= 2) {
        pushU32LEBytes(payload, searchIdx);
      }
      payload.push(4); // CS_UTF8
      pushU32LEBytes(payload, sqlBytes.byteLength);
      for (let i = 0; i < sqlBytes.byteLength; i++) {
        payload.push(sqlBytes[i]!);
      }
    };

    const prepareRowWithBlobs = (
      row: Readonly<Record<string, unknown>>,
      cols: ReadonlyArray<JrdColumnDescriptor>,
    ): Record<string, unknown> => {
      let cloned: Record<string, unknown> | null = null;
      for (const col of cols) {
        if (col.type.toUpperCase() !== 'BLOB') continue;
        const val = row[col.name] ?? row[col.name.toUpperCase()] ?? row[col.name.toLowerCase()];
        if (val === null || val === undefined) continue;
        if (typeof val === 'string' && /^[0-9a-fA-F]{16}$/.test(val)) continue;
        if (val instanceof Uint8Array && val.byteLength === 8 && col.blobSubType !== 'BINARY') {
          continue;
        }
        const blobBytes =
          val instanceof Uint8Array ? val : utf8Enc.encode(String(val));
        const lowId = syntheticBlobCounter++;
        const quad = new Uint8Array(8);
        const qv = new DataView(quad.buffer);
        qv.setUint32(0, 0x80000000, true);
        qv.setUint32(4, lowId, true);

        // Emit `opStoreBlob` in 16 KB chunks followed by 0x0000 terminator
        payload.push(FbChangelogOpcode.opStoreBlob, ...quad);
        let bOff = 0;
        if (blobBytes.byteLength === 0) {
          payload.push(0, 0);
        } else {
          while (bOff < blobBytes.byteLength) {
            const chunkLen = Math.min(16384, blobBytes.byteLength - bOff);
            payload.push(chunkLen & 0xff, (chunkLen >>> 8) & 0xff);
            for (let k = 0; k < chunkLen; k++) {
              payload.push(blobBytes[bOff + k]!);
            }
            bOff += chunkLen;
          }
          payload.push(0, 0);
        }

        if (!cloned) cloned = { ...row };
        cloned[col.name] = bytesToHexLower(quad);
      }
      return cloned ?? { ...row };
    };

    for (const entry of group) {
      if (entry.operation === 'DDL') {
        if (entry.ddlSql) {
          emitExecuteSql(entry.ddlSql);
        }
        continue;
      }

      const normTable = normalizeTableName(entry.table);
      let cols = schemaLookup.get(normTable);
      if (!cols && recordEncoding === 'jrd') {
        cols = inferJrdColumnsFromRow(entry.after ?? entry.before ?? {}, entry.key);
      }

      const hasCompleteBefore =
        entry.before !== null &&
        entry.before !== undefined &&
        Object.keys(entry.before).length > 0;

      const useJrd =
        recordEncoding === 'jrd' ||
        (recordEncoding === 'auto' &&
          cols !== undefined &&
          cols.length > 0 &&
          (entry.operation === 'INSERT' || hasCompleteBefore));

      if (!useJrd || !cols || cols.length === 0) {
        const dmlSql = buildDmlSqlForChangelogEntry(entry, cols);
        if (dmlSql) {
          emitExecuteSql(dmlSql);
        }
        continue;
      }

      const schemaIdx = protocol >= 2 ? ensureAtom(schemaName) : -1;
      const tableIdx = ensureAtom(normTable);

      if (entry.operation === 'INSERT') {
        const preparedAfter = prepareRowWithBlobs(entry.after ?? {}, cols);
        const rec = encodeJrdRecordBuffer(preparedAfter, cols);
        payload.push(FbChangelogOpcode.opInsertRecord);
        if (protocol >= 2) pushU32LEBytes(payload, schemaIdx);
        pushU32LEBytes(payload, tableIdx);
        pushU32LEBytes(payload, rec.byteLength);
        for (let i = 0; i < rec.byteLength; i++) payload.push(rec[i]!);
      } else if (entry.operation === 'UPDATE') {
        const beforeRow = entry.before ?? entry.after ?? {};
        const afterRow = entry.after ?? {};
        const preparedBefore = prepareRowWithBlobs(beforeRow, cols);
        const preparedAfter = prepareRowWithBlobs(afterRow, cols);
        const oldRec = encodeJrdRecordBuffer(preparedBefore, cols);
        const newRec = encodeJrdRecordBuffer(preparedAfter, cols);
        payload.push(FbChangelogOpcode.opUpdateRecord);
        if (protocol >= 2) pushU32LEBytes(payload, schemaIdx);
        pushU32LEBytes(payload, tableIdx);
        pushU32LEBytes(payload, oldRec.byteLength);
        for (let i = 0; i < oldRec.byteLength; i++) payload.push(oldRec[i]!);
        pushU32LEBytes(payload, newRec.byteLength);
        for (let i = 0; i < newRec.byteLength; i++) payload.push(newRec[i]!);
      } else if (entry.operation === 'DELETE') {
        const beforeRow =
          entry.before && Object.keys(entry.before).length > 0
            ? entry.before
            : entry.key;
        const preparedBefore = prepareRowWithBlobs(beforeRow, cols);
        const oldRec = encodeJrdRecordBuffer(preparedBefore, cols);
        payload.push(FbChangelogOpcode.opDeleteRecord);
        if (protocol >= 2) pushU32LEBytes(payload, schemaIdx);
        pushU32LEBytes(payload, tableIdx);
        pushU32LEBytes(payload, oldRec.byteLength);
        for (let i = 0; i < oldRec.byteLength; i++) payload.push(oldRec[i]!);
      }
    }

    payload.push(
      FbChangelogOpcode.opPrepareTransaction,
      FbChangelogOpcode.opCommitTransaction,
    );
    blocks.push({
      traNumber,
      flags: FB_CHANGELOG_BLOCK_BEGIN_TRANS | FB_CHANGELOG_BLOCK_END_TRANS,
      protocol,
      payload: new Uint8Array(payload),
    });
  }

  return encodeFbChangelogSegment({
    sequence: options.sequence ?? 1,
    state: options.state ?? 3,
    guid: options.guid,
    protocol,
    blocks,
  });
}

/** Options for {@link flushDatabaseFbChangelogSegment} (`M19 Item 1`). */
export interface FlushDatabaseFbChangelogOptions extends LogicalToFbChangelogOptions {
  /** Source `ReplicationPublication` to capture & fetch changes from when `entries` is omitted. */
  publication?: ReplicationPublication;
  /** Fetch publication changes strictly after `sinceLsn`. @default 0 */
  sinceLsn?: number;
  /** Optional origin node ID to exclude when fetching from `publication` (bidirectional loop prevention). */
  excludeOrigin?: string;
  /** Maximum entries to include in a single flushed segment. */
  limit?: number;
  /** Also snapshot generator/sequence values from `db` into `opSetSequence` blocks. @default false */
  includeSequences?: boolean;
  /** Optional Emscripten `MEMFS` (or Node FS adapter) to persist the archived `.journal-NNNNNNNNN` file into. */
  fs?: ReplicationEmscriptenFS;
  /** Archive directory inside `fs` where `<prefix>.journal-NNNNNNNNN` is written when `fs` is provided. */
  journalArchiveDirectory?: string;
  /** Filename prefix when writing to `journalArchiveDirectory`. @default 'fb_inline' */
  journalFilePrefix?: string;
}

/** Result returned by {@link flushDatabaseFbChangelogSegment} (`M19 Item 1`). */
export interface FlushDatabaseFbChangelogResult {
  /** Binary `"FBCHANGELOG\0"` segment bytes (`null` when 0 new entries & 0 sequences were pending). */
  readonly segment: Uint8Array | null;
  /** Segment sequence number assigned (`options.sequence ?? 1`). */
  readonly sequence: number;
  /** Number of logical entries encoded into `segment`. */
  readonly entryCount: number;
  /** Highest LSN across the flushed entries (or `sinceLsn` when `entryCount === 0`). */
  readonly lastLsn: number;
  /** Archive file path written inside `options.fs` when `journalArchiveDirectory` was supplied. */
  readonly archivePath?: string;
}

/**
 * Flush pending changes on `db` (from an explicit `entries` list or a
 * {@link ReplicationPublication}) into a genuine `"FBCHANGELOG\0"` binary segment,
 * automatically introspecting `RDB$RELATION_FIELDS` via {@link introspectJrdTableSchemas}
 * when `tableSchemas` is omitted (`M19 Item 1`).
 */
export async function flushDatabaseFbChangelogSegment(
  db: ReplicableDatabase,
  options: FlushDatabaseFbChangelogOptions & {
    entries?: readonly ReplicationLogEntry[];
  } = {},
): Promise<FlushDatabaseFbChangelogResult> {
  const sinceLsn = options.sinceLsn ?? 0;
  let entries: readonly ReplicationLogEntry[] = options.entries ?? [];

  if (!options.entries && options.publication) {
    await options.publication.captureTableChanges();
    entries = await options.publication.fetchChangesSince(sinceLsn, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.excludeOrigin !== undefined
        ? { excludeOrigin: options.excludeOrigin }
        : {}),
    });
  }

  const sequences =
    options.sequences ??
    (options.includeSequences ? await exportSequences(db) : undefined);

  const seqNum = Math.max(1, options.sequence ?? 1);
  if (entries.length === 0 && (!sequences || sequences.length === 0)) {
    return {
      segment: null,
      sequence: seqNum,
      entryCount: 0,
      lastLsn: sinceLsn,
    };
  }

  let tableSchemas = options.tableSchemas;
  if (!tableSchemas && options.recordEncoding !== 'sql') {
    const touchedTables = Array.from(
      new Set(
        entries
          .filter((e) => e.operation !== 'DDL')
          .map((e) => normalizeTableName(e.table))
          .filter(Boolean),
      ),
    );
    if (touchedTables.length > 0) {
      const introspected = await introspectJrdTableSchemas(db, {
        tables: touchedTables,
      });
      if (Object.keys(introspected).length > 0) {
        tableSchemas = introspected;
      }
    }
  }

  const segment = logicalEntriesToFbChangelogSegment(entries, {
    ...options,
    sequence: seqNum,
    ...(tableSchemas !== undefined ? { tableSchemas } : {}),
    ...(sequences !== undefined ? { sequences } : {}),
  });

  let lastLsn = sinceLsn;
  for (const e of entries) {
    if (e.lsn > lastLsn) lastLsn = e.lsn;
  }

  let archivePath: string | undefined;
  if (options.fs && options.journalArchiveDirectory) {
    const cleanDir = options.journalArchiveDirectory.endsWith('/')
      ? options.journalArchiveDirectory.slice(0, -1)
      : options.journalArchiveDirectory;
    if (typeof options.fs.mkdir === 'function') {
      try {
        options.fs.mkdir(cleanDir);
      } catch {
        // Directory may already exist
      }
    }
    const prefix = options.journalFilePrefix ?? 'fb_inline';
    const padded = String(seqNum).padStart(9, '0');
    archivePath = `${cleanDir}/${prefix}.journal-${padded}`;
    options.fs.writeFile(archivePath, segment);
  }

  return {
    segment,
    sequence: seqNum,
    entryCount: entries.length,
    lastLsn,
    ...(archivePath !== undefined ? { archivePath } : {}),
  };
}

