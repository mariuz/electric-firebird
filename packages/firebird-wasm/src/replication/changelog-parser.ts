/**
 * changelog-parser.ts – Firebird `RDB$PUBLICATIONS` catalog helpers, `replication.conf`
 * generator, and `"FBCHANGELOG\0"` binary block/opcode parser (`M21 Item 5`).
 */

import type { Row } from '../types';
import type { ReplicableDatabase } from './types';
import {
  execStatement,
  isInternalReplicationTable,
  normalizeTableName,
  quoteIdent,
} from './shared';

/** Magic 12-byte signature (`"FBCHANGELOG\0"`). */
export const FB_CHANGELOG_MAGIC = 'FBCHANGELOG\0';
/** Byte size of Firebird's `Replication::ChangeLog::Header` (`48` bytes). */
export const FB_CHANGELOG_HEADER_BYTES = 48;
/** Byte size of Firebird's `Replication::Block` header (`16` bytes). */
export const FB_CHANGELOG_BLOCK_HEADER_BYTES = 16;
/** `Replication::Block` start-of-transaction flag (`1`). */
export const FB_CHANGELOG_BLOCK_BEGIN_TRANS = 1;
/** `Replication::Block` end-of-transaction flag (`2`). */
export const FB_CHANGELOG_BLOCK_END_TRANS = 2;

/**
 * Native Firebird replication protocol opcodes (`src/jrd/replication/Protocol.h`).
 */
export const FbChangelogOpcode = {
  opStartTransaction: 1,
  opPrepareTransaction: 2,
  opCommitTransaction: 3,
  opRollbackTransaction: 4,
  opCleanupTransaction: 5,
  opStartSavepoint: 6,
  opReleaseSavepoint: 7,
  opRollbackSavepoint: 8,
  opInsertRecord: 9,
  opUpdateRecord: 10,
  opDeleteRecord: 11,
  opStoreBlob: 12,
  opExecuteSql: 13,
  opSetSequence: 14,
  opExecuteSqlIntl: 15,
  opDefineAtom: 16,
} as const;

/** Status of Firebird's built-in `RDB$PUBLICATIONS` / `RDB$PUBLICATION_TABLES` catalog (`M16 Item 1`). */
export interface EnginePublicationStatus {
  /** Publication name in `RDB$PUBLICATIONS` (normally `'RDB$DEFAULT'`). */
  readonly name: string;
  /** Whether the native engine publication is currently enabled (`RDB$ACTIVE_FLAG = 1`). */
  readonly active: boolean;
  /** Whether newly created tables are automatically added (`RDB$AUTO_ENABLE = 1`, i.e. `INCLUDE ALL`). */
  readonly autoEnable: boolean;
  /** Upper-case table names currently listed in `RDB$PUBLICATION_TABLES`. */
  readonly publishedTables: readonly string[];
  /** Database replica mode reported by `MON$DATABASE` / `RDB$GET_CONTEXT('SYSTEM', 'REPLICA_MODE')`. */
  readonly replicaMode: string | null;
  /** Current native replication sequence number reported by `RDB$GET_CONTEXT('SYSTEM', 'REPLICATION_SEQUENCE')`. */
  readonly replicationSequence: number | null;
}

/** Options for {@link enableEnginePublication} (`M16 Item 1`). */
export interface EnableEnginePublicationOptions {
  /**
   * Tables to include in Firebird's native `RDB$DEFAULT` publication before enabling it:
   * - `'*'`: executes `ALTER DATABASE INCLUDE ALL TO PUBLICATION` (`RDB$AUTO_ENABLE = 1`).
   * - `string[]`: executes `ALTER DATABASE INCLUDE TABLE <t> TO PUBLICATION` for each table.
   * - `undefined`: enables the publication without altering its current table membership.
   */
  tables?: '*' | readonly string[];
}

/**
 * Include all user tables (`'*'`) or specific tables in Firebird's built-in
 * `RDB$PUBLICATIONS` / `RDB$PUBLICATION_TABLES` catalog (`M16 Item 1`).
 */
export async function includeTablesInPublication(
  db: ReplicableDatabase,
  tables: '*' | readonly string[],
): Promise<string[]> {
  const executedDdl: string[] = [];
  if (tables === '*') {
    const sql = 'ALTER DATABASE INCLUDE ALL TO PUBLICATION';
    await execStatement(db, sql);
    executedDdl.push(sql);
    return executedDdl;
  }

  for (const rawTable of tables) {
    const clean = normalizeTableName(rawTable);
    if (!clean || isInternalReplicationTable(clean)) continue;
    const sql = `ALTER DATABASE INCLUDE TABLE ${quoteIdent(clean)} TO PUBLICATION`;
    await execStatement(db, sql);
    executedDdl.push(sql);
  }
  return executedDdl;
}

/**
 * Exclude all tables (`'*'`) or specific tables from Firebird's built-in
 * `RDB$PUBLICATIONS` / `RDB$PUBLICATION_TABLES` catalog (`M16 Item 1`).
 */
export async function excludeTablesFromPublication(
  db: ReplicableDatabase,
  tables: '*' | readonly string[],
): Promise<string[]> {
  const executedDdl: string[] = [];
  if (tables === '*') {
    const sql = 'ALTER DATABASE EXCLUDE ALL FROM PUBLICATION';
    await execStatement(db, sql);
    executedDdl.push(sql);
    return executedDdl;
  }

  for (const rawTable of tables) {
    const clean = normalizeTableName(rawTable);
    if (!clean) continue;
    const sql = `ALTER DATABASE EXCLUDE TABLE ${quoteIdent(clean)} FROM PUBLICATION`;
    await execStatement(db, sql);
    executedDdl.push(sql);
  }
  return executedDdl;
}

/**
 * Enable Firebird's native engine publication (`ALTER DATABASE ENABLE PUBLICATION`),
 * optionally including `tables` (`'*'` or specific table names) first (`M16 Item 1`).
 */
export async function enableEnginePublication(
  db: ReplicableDatabase,
  options: EnableEnginePublicationOptions = {},
): Promise<EnginePublicationStatus> {
  if (options.tables !== undefined) {
    await includeTablesInPublication(db, options.tables);
  }
  await execStatement(db, 'ALTER DATABASE ENABLE PUBLICATION');
  return getEnginePublicationStatus(db);
}

/**
 * Disable Firebird's native engine publication (`ALTER DATABASE DISABLE PUBLICATION`) (`M16 Item 1`).
 */
export async function disableEnginePublication(
  db: ReplicableDatabase,
): Promise<EnginePublicationStatus> {
  await execStatement(db, 'ALTER DATABASE DISABLE PUBLICATION');
  return getEnginePublicationStatus(db);
}

/**
 * Inspect Firebird's built-in `RDB$PUBLICATIONS`, `RDB$PUBLICATION_TABLES`,
 * `MON$DATABASE`, and `SYSTEM` replication context variables (`M16 Item 1`).
 */
export async function getEnginePublicationStatus(
  db: ReplicableDatabase,
): Promise<EnginePublicationStatus> {
  let name = 'RDB$DEFAULT';
  let active = false;
  let autoEnable = false;

  try {
    const pubRes = await db.query<Row>(
      `SELECT TRIM(RDB$PUBLICATION_NAME) AS PUB_NAME, RDB$ACTIVE_FLAG AS ACTIVE_FLAG, RDB$AUTO_ENABLE AS AUTO_ENABLE FROM RDB$PUBLICATIONS`,
    );
    const row = pubRes.rows[0];
    if (row) {
      name = String(row.PUB_NAME ?? row.pub_name ?? 'RDB$DEFAULT').trim();
      active = Number(row.ACTIVE_FLAG ?? row.active_flag ?? 0) === 1;
      autoEnable = Number(row.AUTO_ENABLE ?? row.auto_enable ?? 0) === 1;
    }
  } catch {
    // Fallback for mock databases without RDB$PUBLICATIONS
  }

  const publishedTables: string[] = [];
  try {
    const tblRes = await db.query<Row>(
      `SELECT TRIM(RDB$TABLE_NAME) AS TABLE_NAME FROM RDB$PUBLICATION_TABLES ORDER BY RDB$TABLE_NAME`,
    );
    for (const r of tblRes.rows) {
      const tbl = String(r.TABLE_NAME ?? r.table_name ?? '').trim().toUpperCase();
      if (tbl) publishedTables.push(tbl);
    }
  } catch {
    // Ignore if RDB$PUBLICATION_TABLES is unavailable
  }

  let replicaMode: string | null = null;
  let replicationSequence: number | null = null;
  try {
    const ctxRes = await db.query<Row>(
      `SELECT RDB$GET_CONTEXT('SYSTEM', 'REPLICA_MODE') AS REPL_MODE, RDB$GET_CONTEXT('SYSTEM', 'REPLICATION_SEQUENCE') AS REPL_SEQ FROM RDB$DATABASE`,
    );
    const ctxRow = ctxRes.rows[0];
    if (ctxRow) {
      const rawMode = ctxRow.REPL_MODE ?? ctxRow.repl_mode;
      if (rawMode !== null && rawMode !== undefined) {
        replicaMode = String(rawMode).trim();
      }
      const rawSeq = ctxRow.REPL_SEQ ?? ctxRow.repl_seq;
      if (rawSeq !== null && rawSeq !== undefined) {
        const parsed = Number(rawSeq);
        if (Number.isFinite(parsed)) {
          replicationSequence = parsed;
        }
      }
    }
  } catch {
    // Ignore if SYSTEM context variables are unsupported on mock DB
  }

  return {
    name,
    active,
    autoEnable,
    publishedTables,
    replicaMode,
    replicationSequence,
  };
}

/** Per-database block entry for Firebird's `/usr/local/firebird/replication.conf` (`M16 Item 2`). */
export interface ReplicationConfEntry {
  /** Database path pattern in `MEMFS` (e.g. `'/data/primary.fdb'`). Omit for the global default section. */
  database?: string;
  /** Directory where active `"FBCHANGELOG\0"` segments are written (`journal_directory`). */
  journalDirectory?: string;
  /** Directory where completed `"FBCHANGELOG\0"` segments are archived (`journal_archive_directory`). */
  journalArchiveDirectory?: string;
  /** Archive timeout in seconds (`journal_archive_timeout`). @default 1 */
  journalArchiveTimeout?: number;
  /** Source directory polled by a replica (`journal_source_directory`). */
  journalSourceDirectory?: string;
  /** Maximum segment size in bytes (`journal_segment_size`). */
  journalSegmentSize?: number;
  /** Enable verbose logging to `/usr/local/firebird/replication.log` (`verbose_logging`). @default true */
  verboseLogging?: boolean;
}

/**
 * Format a valid Firebird `replication.conf` configuration file text (`M16 Item 2`).
 *
 * Uses the real Firebird `Replication::Config` keys (`journal_directory`,
 * `journal_archive_directory`, `journal_archive_timeout`, `journal_source_directory`,
 * `verbose_logging`).
 */
export function buildReplicationConf(
  entries: ReplicationConfEntry | ReadonlyArray<ReplicationConfEntry>,
): string {
  const list = Array.isArray(entries) ? entries : [entries];
  const blocks: string[] = [];

  for (const entry of list) {
    const header = entry.database ? `database = ${entry.database}` : 'database';
    const lines: string[] = [header, '{'];
    if (entry.journalDirectory) {
      lines.push(`  journal_directory = ${entry.journalDirectory}`);
    }
    if (entry.journalArchiveDirectory) {
      lines.push(`  journal_archive_directory = ${entry.journalArchiveDirectory}`);
    }
    if (entry.journalArchiveTimeout !== undefined) {
      lines.push(`  journal_archive_timeout = ${Math.max(1, Math.trunc(entry.journalArchiveTimeout))}`);
    }
    if (entry.journalSourceDirectory) {
      lines.push(`  journal_source_directory = ${entry.journalSourceDirectory}`);
    }
    if (entry.journalSegmentSize !== undefined) {
      lines.push(`  journal_segment_size = ${Math.max(4096, Math.trunc(entry.journalSegmentSize))}`);
    }
    if (entry.verboseLogging ?? true) {
      lines.push('  verbose_logging = true');
    }
    lines.push('}');
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n') + '\n';
}

/** Minimal Emscripten FS subset needed by {@link configureWasmReplicationConf} and {@link readWasmChangelogSegments}. */
export interface ReplicationEmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string }): void;
  readFile(path: string, opts?: { encoding?: string }): Uint8Array | string;
  readdir?(path: string): string[];
  unlink?(path: string): void;
  analyzePath?(path: string): { exists: boolean };
}

function mkdirRecursiveSafe(fs: ReplicationEmscriptenFS, fullPath: string): void {
  const parts = fullPath.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    try {
      if (fs.analyzePath && fs.analyzePath(cur).exists) continue;
      fs.mkdir(cur);
    } catch {
      // Directory already exists
    }
  }
}

/**
 * Provision `/usr/local/firebird/replication.conf` (and create all referenced
 * `journal_directory` / `journal_archive_directory` / `journal_source_directory`
 * folders) in the Emscripten `MEMFS` so Firebird's compiled-in `Replication::Manager`
 * writes native `"FBCHANGELOG\0"` binary segments (`M16 Item 2`).
 */
export function configureWasmReplicationConf(
  fs: ReplicationEmscriptenFS,
  config: string | ReplicationConfEntry | ReadonlyArray<ReplicationConfEntry>,
  confPath = '/usr/local/firebird/replication.conf',
): string {
  const parentDir = confPath.slice(0, Math.max(0, confPath.lastIndexOf('/'))) || '/usr/local/firebird';
  mkdirRecursiveSafe(fs, parentDir);

  if (typeof config !== 'string') {
    const list = Array.isArray(config) ? config : [config];
    for (const item of list) {
      if (item.journalDirectory) mkdirRecursiveSafe(fs, item.journalDirectory);
      if (item.journalArchiveDirectory) mkdirRecursiveSafe(fs, item.journalArchiveDirectory);
      if (item.journalSourceDirectory) mkdirRecursiveSafe(fs, item.journalSourceDirectory);
    }
  }

  const confText = typeof config === 'string' ? config : buildReplicationConf(config);
  fs.writeFile(confPath, confText);
  return confText;
}

/** Parsed 48-byte `ChangeLog::Header` from a native `"FBCHANGELOG\0"` segment file (`M16 Item 2`). */
export interface FbChangelogHeader {
  /** 12-byte magic signature (`"FBCHANGELOG\0"`). */
  readonly magic: string;
  /** Changelog format version (`1`). */
  readonly version: number;
  /** Segment state (`1` = `USED`, `2` = `FULL`, `3` = `ARCHIVABLE`, `0` = `FREE`). */
  readonly state: number;
  /** Database UUID formatted as `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. */
  readonly guid: string;
  /** Raw 16-byte binary database GUID. */
  readonly guidBytes: Uint8Array;
  /** Monotonic changelog segment sequence number (`1`, `2`, ...). */
  readonly sequence: number;
  /** Total byte length recorded in the segment header (`>= 48`). */
  readonly length: number;
}

/** Parsed 16-byte `Replication::Block` record inside a `"FBCHANGELOG\0"` segment (`M16 Item 2`). */
export interface FbChangelogBlock {
  /** Byte offset of this block inside the segment file (`>= 48`). */
  readonly offset: number;
  /** Firebird transaction number (`traNumber`). */
  readonly traNumber: number;
  /** Replication protocol version (`1` in Firebird 4/5, `2` in Firebird 6). */
  readonly protocol: number;
  /** Raw block flags bitmask (`BLOCK_BEGIN_TRANS = 1`, `BLOCK_END_TRANS = 2`). */
  readonly flags: number;
  /** `true` when `BLOCK_BEGIN_TRANS` (`1`) is set. */
  readonly beginTrans: boolean;
  /** `true` when `BLOCK_END_TRANS` (`2`) is set. */
  readonly endTrans: boolean;
  /** Payload byte length following the 16-byte block header. */
  readonly length: number;
  /** Raw payload bytes (`length` bytes). */
  readonly payload: Uint8Array;
  /** Leading opcode byte of the payload (or `null` if payload is empty). */
  readonly leadingOpcode: number | null;
  /** Atom names defined via `opDefineAtom` (`6`) inside this block. */
  readonly atoms: readonly string[];
  /** SQL DDL/DML statements executed via `opExecuteSql` (`13`) or `opExecuteSqlIntl` (`15`) inside this block. */
  readonly executedSql: readonly string[];
}

/** Parsed native Firebird `"FBCHANGELOG\0"` binary segment file (`M16 Item 2`). */
export interface ParsedFbChangelogSegment {
  /** Optional filename in `journal_directory` / `journal_archive_directory`. */
  readonly filename?: string;
  /** Parsed 48-byte `ChangeLog::Header`. */
  readonly header: FbChangelogHeader;
  /** Ordered list of transaction blocks inside the segment. */
  readonly blocks: readonly FbChangelogBlock[];
  /** Union of all atom names (`opDefineAtom`) defined across all blocks in this segment. */
  readonly atoms: readonly string[];
  /** Union of all SQL strings (`opExecuteSql` / `opExecuteSqlIntl`) recorded in this segment. */
  readonly executedSql: readonly string[];
  /** Raw segment bytes. */
  readonly rawBytes: Uint8Array;
}

function formatGuidBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase());
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

function extractAtomsAndSqlFromPayload(
  payload: Uint8Array,
  _protocol: number,
): { atoms: string[]; executedSql: string[] } {
  const atoms: string[] = [];
  const executedSql: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // Scan for opDefineAtom (opcode 6: 0x06 [uint8 len] [ASCII bytes] or 0x06 0x10 [uint8 len] [ASCII bytes])
  // or length-prefixed identifier atoms (`[uint8 len] [ASCII identifier]`),
  // and opExecuteSqlIntl (opcode 15) / opExecuteSql (opcode 13).
  let i = 0;
  while (i < payload.length) {
    const op = payload[i]!;
    if (op === FbChangelogOpcode.opDefineAtom || op === 0x10) {
      for (const offsetDelta of [1, 2]) {
        const lenPos = i + offsetDelta;
        if (lenPos < payload.length) {
          const len = payload[lenPos]!;
          if (len >= 2 && len <= 63 && lenPos + 1 + len <= payload.length) {
            const text = decoder.decode(payload.subarray(lenPos + 1, lenPos + 1 + len));
            if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(text)) {
              atoms.push(text);
            }
          }
        }
      }
    }
    if (
      (op === FbChangelogOpcode.opExecuteSqlIntl || op === FbChangelogOpcode.opExecuteSql) &&
      i + 8 <= payload.length
    ) {
      // Look for a 32-bit LE length followed by printable SQL text near the tail of the block
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let lenPos = i + 1; lenPos + 4 <= payload.length; lenPos++) {
        const sqlLen = view.getUint32(lenPos, true);
        if (
          sqlLen > 0 &&
          lenPos + 4 + sqlLen <= payload.length &&
          payload.length - (lenPos + 4 + sqlLen) <= 2
        ) {
          const sqlText = decoder.decode(payload.subarray(lenPos + 4, lenPos + 4 + sqlLen)).trim();
          if (sqlText.length >= 4 && /^[\x20-\x7E\r\n\t]+$/.test(sqlText)) {
            executedSql.push(sqlText);
            break;
          }
        }
      }
    }
    i++;
  }

  return { atoms, executedSql };
}

/**
 * Return `true` when `bytes` begins with Firebird's 12-byte `"FBCHANGELOG\0"`
 * binary changelog header (`M16 Item 2`).
 */
export function isFbChangelogSegment(bytes: Uint8Array): boolean {
  if (bytes.byteLength < FB_CHANGELOG_HEADER_BYTES) return false;
  for (let i = 0; i < FB_CHANGELOG_MAGIC.length; i++) {
    if (bytes[i] !== FB_CHANGELOG_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Parse a real Firebird `"FBCHANGELOG\0"` binary changelog segment file
 * (`ChangeLog::Header` + `Replication::Block` stream) (`M16 Item 2`).
 */
export function parseFbChangelogSegment(
  bytes: Uint8Array,
  filename?: string,
): ParsedFbChangelogSegment {
  if (!isFbChangelogSegment(bytes)) {
    throw new Error(
      'Invalid Firebird changelog segment: expected 48-byte header starting with "FBCHANGELOG\\0".',
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(12, true);
  const state = view.getUint16(14, true);
  const guidBytes = bytes.slice(16, 32);
  const guid = formatGuidBytes(guidBytes);
  const sequence = Number(view.getBigUint64(32, true));
  const length = Number(view.getBigUint64(40, true));

  const header: FbChangelogHeader = {
    magic: FB_CHANGELOG_MAGIC,
    version,
    state,
    guid,
    guidBytes,
    sequence,
    length,
  };

  const blocks: FbChangelogBlock[] = [];
  const allAtoms = new Set<string>();
  const allExecutedSql: string[] = [];

  const maxOffset = Math.min(bytes.byteLength, length > 0 ? length : bytes.byteLength);
  let offset = FB_CHANGELOG_HEADER_BYTES;

  while (offset + FB_CHANGELOG_BLOCK_HEADER_BYTES <= maxOffset) {
    const traNumber = Number(view.getBigUint64(offset, true));
    const protocol = view.getUint16(offset + 8, true);
    const flags = view.getUint16(offset + 10, true);
    const blockLen = view.getUint32(offset + 12, true);
    const payloadStart = offset + FB_CHANGELOG_BLOCK_HEADER_BYTES;
    const payloadEnd = payloadStart + blockLen;
    if (payloadEnd > bytes.byteLength) {
      break;
    }

    const payload = bytes.slice(payloadStart, payloadEnd);
    const leadingOpcode = payload.length > 0 ? payload[0]! : null;
    const tempBlock: FbChangelogBlock = {
      offset,
      traNumber,
      protocol,
      flags,
      beginTrans: (flags & FB_CHANGELOG_BLOCK_BEGIN_TRANS) !== 0,
      endTrans: (flags & FB_CHANGELOG_BLOCK_END_TRANS) !== 0,
      length: blockLen,
      payload,
      leadingOpcode,
      atoms: [],
      executedSql: [],
    };
    let atoms: string[];
    let executedSql: string[];
    try {
      const ops = decodeFbChangelogBlockOperationsStrict(tempBlock);
      atoms = [];
      executedSql = [];
      for (const op of ops) {
        if (op.kind === 'define_atom') atoms.push(op.name);
        else if (op.kind === 'execute_sql') executedSql.push(op.sql);
      }
    } catch {
      const fallback = extractAtomsAndSqlFromPayload(payload, protocol);
      atoms = fallback.atoms;
      executedSql = fallback.executedSql;
    }
    for (const a of atoms) allAtoms.add(a);
    for (const s of executedSql) allExecutedSql.push(s);

    blocks.push({
      ...tempBlock,
      atoms,
      executedSql,
    });

    offset = payloadEnd;
  }

  return {
    ...(filename !== undefined ? { filename } : {}),
    header,
    blocks,
    atoms: Array.from(allAtoms),
    executedSql: allExecutedSql,
    rawBytes: bytes,
  };
}

/**
 * Scan a directory in Emscripten `MEMFS` (e.g. `journal_archive_directory` or
 * `journal_directory`) and parse all native `"FBCHANGELOG\0"` segment files
 * (`*.journal-*`), sorted in ascending `sequence` order (`M16 Item 2`).
 */
export function readWasmChangelogSegments(
  fs: ReplicationEmscriptenFS,
  directory: string,
  options: { sinceSequence?: number } = {},
): ParsedFbChangelogSegment[] {
  if (typeof fs.readdir !== 'function') {
    return [];
  }
  let entries: string[];
  try {
    entries = fs.readdir(directory);
  } catch {
    return [];
  }

  const sinceSeq = options.sinceSequence ?? 0;
  const cleanDir = directory.endsWith('/') ? directory.slice(0, -1) : directory;
  const segments: ParsedFbChangelogSegment[] = [];

  for (const name of entries) {
    if (name === '.' || name === '..' || name.endsWith('.lock')) continue;
    const fullPath = `${cleanDir}/${name}`;
    try {
      const raw = fs.readFile(fullPath);
      if (raw instanceof Uint8Array && isFbChangelogSegment(raw)) {
        const parsed = parseFbChangelogSegment(raw, name);
        if (parsed.header.sequence > sinceSeq) {
          segments.push(parsed);
        }
      }
    } catch {
      // Skip unreadable or non-file entries
    }
  }

  segments.sort((a, b) => a.header.sequence - b.header.sequence);
  return segments;
}


// ---------------------------------------------------------------------------
// 17. Full "FBCHANGELOG\0" Binary Operation & Sequence Decoder, Replica Mode
//     Header Helper & Continuous Changelog Poller (M17 Items 1, 2 & 5)
// ---------------------------------------------------------------------------

/** Common fields shared by every decoded `Replication::Block` operation (`M17 Item 1`). */
export interface DecodedFbChangelogOpBase {
  /** Firebird transaction number (`traNumber`). */
  readonly traNumber: number;
  /** Replication protocol version (`1` in Firebird 4/5, `2` in Firebird 6). */
  readonly protocol: number;
  /** Byte offset of the enclosing `Replication::Block` inside the segment file. */
  readonly blockOffset: number;
  /** Raw numeric opcode from `src/jrd/replication/Protocol.h` (`1..16`). */
  readonly opcode: number;
}

/** Discriminated union of all 16 Firebird `Replication::Block` operations (`M17 Item 1`). */
export type DecodedFbChangelogOperation =
  | (DecodedFbChangelogOpBase & {
      readonly kind:
        | 'start_transaction'
        | 'prepare_transaction'
        | 'commit_transaction'
        | 'rollback_transaction'
        | 'cleanup_transaction'
        | 'start_savepoint'
        | 'release_savepoint'
        | 'rollback_savepoint';
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'define_atom';
      /** 0-based per-block atom index assigned to `name`. */
      readonly atomIndex: number;
      /** Identifier string stored in the block's local atom table. */
      readonly name: string;
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'insert_record';
      /** Schema name (`"PUBLIC"`, etc.) in `protocol >= 2`, or `null` in `protocol === 1`. */
      readonly schemaName: string | null;
      /** Relation/table name from the block atom table. */
      readonly tableName: string;
      /** Uncompressed JRD record byte length. */
      readonly recordLength: number;
      /** Uncompressed JRD record buffer (`recordLength` bytes). */
      readonly recordData: Uint8Array;
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'update_record';
      readonly schemaName: string | null;
      readonly tableName: string;
      readonly oldRecordLength: number;
      readonly oldRecordData: Uint8Array;
      readonly newRecordLength: number;
      readonly newRecordData: Uint8Array;
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'delete_record';
      readonly schemaName: string | null;
      readonly tableName: string;
      readonly oldRecordLength: number;
      readonly oldRecordData: Uint8Array;
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'store_blob';
      /** High 32-bit word (`bid_quad_high`) of the 8-byte `ISC_QUAD` BLOB ID. */
      readonly blobIdHigh: number;
      /** Low 32-bit word (`bid_quad_low`) of the 8-byte `ISC_QUAD` BLOB ID. */
      readonly blobIdLow: number;
      /** Canonical 16-hex-char representation of the 8-byte `ISC_QUAD` bytes in record order. */
      readonly blobIdHex: string;
      /** Reassembled BLOB payload across all segments before the `0x0000` terminator. */
      readonly data: Uint8Array;
      /** Number of non-empty chunks read for this BLOB. */
      readonly chunkCount: number;
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'execute_sql';
      /** User/owner atom name (e.g. `'SYSDBA'`). */
      readonly ownerName: string;
      /** Schema search path string in `protocol >= 2` for `opExecuteSqlIntl`, else `null`. */
      readonly schemaSearchPath: string | null;
      /** Firebird character set ID (`4` = `CS_UTF8`). */
      readonly charsetId: number;
      /** Executed SQL DDL/DML text. */
      readonly sql: string;
      /** `true` when encoded as `opExecuteSqlIntl` (`15`), `false` for `opExecuteSql` (`13`). */
      readonly intl: boolean;
    })
  | (DecodedFbChangelogOpBase & {
      readonly kind: 'set_sequence';
      readonly schemaName: string | null;
      readonly sequenceName: string;
      /** Sequence value as JS `number`. */
      readonly value: number;
      /** Exact 64-bit signed integer sequence value (`SINT64`). */
      readonly bigValue: bigint;
    });

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function decodeFbChangelogBlockOperationsStrict(
  block: FbChangelogBlock,
): DecodedFbChangelogOperation[] {
  const payload = block.payload;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const atoms: string[] = [];
  const ops: DecodedFbChangelogOperation[] = [];
  let pos = 0;

  const ensure = (n: number): void => {
    if (pos + n > payload.byteLength) {
      throw new Error(
        `Truncated Replication::Block at byte ${pos} (needed ${n}, remaining ${payload.byteLength - pos}).`,
      );
    }
  };
  const readU8 = (): number => {
    ensure(1);
    return payload[pos++]!;
  };
  const readU16 = (): number => {
    ensure(2);
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  };
  const readI32 = (): number => {
    ensure(4);
    const v = view.getInt32(pos, true);
    pos += 4;
    return v;
  };
  const readU32 = (): number => {
    ensure(4);
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const readI64 = (): bigint => {
    ensure(8);
    const v = view.getBigInt64(pos, true);
    pos += 8;
    return v;
  };
  const readBytes = (len: number): Uint8Array => {
    if (len < 0) throw new Error(`Negative binary length ${len} in Replication::Block.`);
    ensure(len);
    const slice = payload.slice(pos, pos + len);
    pos += len;
    return slice;
  };
  const readAtom = (): string => {
    const idx = readI32();
    if (idx < 0 || idx >= atoms.length) {
      throw new Error(`Invalid atom index ${idx} (atoms defined: ${atoms.length}).`);
    }
    return atoms[idx]!;
  };
  const readQualifiedAtom = (): { schemaName: string | null; objectName: string } => {
    if (block.protocol >= 2) {
      const schemaName = readAtom();
      const objectName = readAtom();
      return { schemaName, objectName };
    }
    return { schemaName: null, objectName: readAtom() };
  };

  while (pos < payload.byteLength) {
    const opcode = readU8();
    const base: DecodedFbChangelogOpBase = {
      traNumber: block.traNumber,
      protocol: block.protocol,
      blockOffset: block.offset,
      opcode,
    };

    switch (opcode) {
      case FbChangelogOpcode.opStartTransaction:
        ops.push({ ...base, kind: 'start_transaction' });
        break;
      case FbChangelogOpcode.opPrepareTransaction:
        ops.push({ ...base, kind: 'prepare_transaction' });
        break;
      case FbChangelogOpcode.opCommitTransaction:
        ops.push({ ...base, kind: 'commit_transaction' });
        break;
      case FbChangelogOpcode.opRollbackTransaction:
        ops.push({ ...base, kind: 'rollback_transaction' });
        break;
      case FbChangelogOpcode.opCleanupTransaction:
        ops.push({ ...base, kind: 'cleanup_transaction' });
        break;
      case FbChangelogOpcode.opStartSavepoint:
        ops.push({ ...base, kind: 'start_savepoint' });
        break;
      case FbChangelogOpcode.opReleaseSavepoint:
        ops.push({ ...base, kind: 'release_savepoint' });
        break;
      case FbChangelogOpcode.opRollbackSavepoint:
        ops.push({ ...base, kind: 'rollback_savepoint' });
        break;
      case FbChangelogOpcode.opDefineAtom: {
        const nameLen = readU8();
        const nameBytes = readBytes(nameLen);
        const name = utf8.decode(nameBytes);
        const atomIndex = atoms.length;
        atoms.push(name);
        ops.push({ ...base, kind: 'define_atom', atomIndex, name });
        break;
      }
      case FbChangelogOpcode.opInsertRecord: {
        const { schemaName, objectName } = readQualifiedAtom();
        const recordLength = readU32();
        const recordData = readBytes(recordLength);
        ops.push({
          ...base,
          kind: 'insert_record',
          schemaName,
          tableName: objectName,
          recordLength,
          recordData,
        });
        break;
      }
      case FbChangelogOpcode.opUpdateRecord: {
        const { schemaName, objectName } = readQualifiedAtom();
        const oldRecordLength = readU32();
        const oldRecordData = readBytes(oldRecordLength);
        const newRecordLength = readU32();
        const newRecordData = readBytes(newRecordLength);
        ops.push({
          ...base,
          kind: 'update_record',
          schemaName,
          tableName: objectName,
          oldRecordLength,
          oldRecordData,
          newRecordLength,
          newRecordData,
        });
        break;
      }
      case FbChangelogOpcode.opDeleteRecord: {
        const { schemaName, objectName } = readQualifiedAtom();
        const oldRecordLength = readU32();
        const oldRecordData = readBytes(oldRecordLength);
        ops.push({
          ...base,
          kind: 'delete_record',
          schemaName,
          tableName: objectName,
          oldRecordLength,
          oldRecordData,
        });
        break;
      }
      case FbChangelogOpcode.opStoreBlob: {
        ensure(8);
        const quadBytes = payload.slice(pos, pos + 8);
        const blobIdHigh = readU32();
        const blobIdLow = readU32();
        const blobIdHex = bytesToHexLower(quadBytes);
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (pos < payload.byteLength) {
          const chunkLen = readU16();
          if (chunkLen === 0) break;
          const chunk = readBytes(chunkLen);
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
        }
        const data = new Uint8Array(totalBytes);
        let writeOff = 0;
        for (const c of chunks) {
          data.set(c, writeOff);
          writeOff += c.byteLength;
        }
        ops.push({
          ...base,
          kind: 'store_blob',
          blobIdHigh,
          blobIdLow,
          blobIdHex,
          data,
          chunkCount: chunks.length,
        });
        break;
      }
      case FbChangelogOpcode.opExecuteSql:
      case FbChangelogOpcode.opExecuteSqlIntl: {
        const intl = opcode === FbChangelogOpcode.opExecuteSqlIntl;
        const ownerName = readAtom();
        const schemaSearchPath = intl && block.protocol >= 2 ? readAtom() : null;
        const charsetId = intl ? readU8() : 4;
        const sqlLen = readU32();
        const sqlBytes = readBytes(sqlLen);
        const sql = utf8.decode(sqlBytes);
        ops.push({
          ...base,
          kind: 'execute_sql',
          ownerName,
          schemaSearchPath,
          charsetId,
          sql,
          intl,
        });
        break;
      }
      case FbChangelogOpcode.opSetSequence: {
        const { schemaName, objectName } = readQualifiedAtom();
        const bigValue = readI64();
        ops.push({
          ...base,
          kind: 'set_sequence',
          schemaName,
          sequenceName: objectName,
          value: Number(bigValue),
          bigValue,
        });
        break;
      }
      default:
        throw new Error(`Unsupported Firebird replication opcode ${opcode} at byte ${pos - 1}.`);
    }
  }

  return ops;
}

/** Decode all binary `Replication::Block` opcodes inside a single {@link FbChangelogBlock}. */
export function decodeFbChangelogBlockOperations(
  block: FbChangelogBlock,
): DecodedFbChangelogOperation[] {
  return decodeFbChangelogBlockOperationsStrict(block);
}

/** Decode all binary `Replication::Block` operations across an entire `"FBCHANGELOG\0"` segment. */
export function decodeFbChangelogOperations(
  segmentOrBytes: Uint8Array | ParsedFbChangelogSegment,
): DecodedFbChangelogOperation[] {
  const segment =
    segmentOrBytes instanceof Uint8Array
      ? parseFbChangelogSegment(segmentOrBytes)
      : segmentOrBytes;
  const out: DecodedFbChangelogOperation[] = [];
  for (const block of segment.blocks) {
    out.push(...decodeFbChangelogBlockOperationsStrict(block));
  }
  return out;
}

export {
  fbChangelogToLogicalEntries,
  type FbChangelogLogicalDecodeOptions,
  type FbChangelogLogicalDecodeResult,
} from './changelog-logical';

