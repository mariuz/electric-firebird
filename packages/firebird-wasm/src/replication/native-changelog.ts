/**
 * Native Firebird Engine Replication (`RDB$PUBLICATIONS`, `replication.conf`,
 * `"FBCHANGELOG\0"` Binary Parser/Decoder & `IAttachment::createReplicator` Bridge).
 */

import type { Row } from '../types';
import type {
  ReplicableDatabase,
  ReplicationLogEntry,
  ReplicationPublication,
  SequenceWatermark,
} from './types';
import {
  applyRowMutationToTable,
  escapeSqlLiteral,
  execStatement,
  isInternalReplicationTable,
  normalizeTableName,
  quoteIdent,
} from './shared';
import { applySequences, exportSequences } from './catalog';

// ---------------------------------------------------------------------------
// 16. Native Firebird Engine Replication (M16 Items 1–4)
//     (`RDB$PUBLICATIONS`, `replication.conf`, `"FBCHANGELOG\0"` Parser & `IReplicator` Bridge)
// ---------------------------------------------------------------------------

/**
 * Magic 12-byte signature at the start of every native Firebird binary
 * changelog segment file (`ChangeLog::Header::magic = "FBCHANGELOG\0"`).
 */
export const FB_CHANGELOG_MAGIC = 'FBCHANGELOG\0';

/** Byte size of Firebird's `Replication::ChangeLog::Header` (`48` bytes). */
export const FB_CHANGELOG_HEADER_BYTES = 48;

/** Byte size of Firebird's `Replication::Block` header (`16` bytes). */
export const FB_CHANGELOG_BLOCK_HEADER_BYTES = 16;

/** `Replication::Block` flag indicating the start of a replicated transaction (`1`). */
export const FB_CHANGELOG_BLOCK_BEGIN_TRANS = 1;

/** `Replication::Block` flag indicating the end (commit/rollback) of a replicated transaction (`2`). */
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

/** Result returned by {@link applyFbChangelogSegmentToDatabase} (`M16 Item 3` / `M17 Item 1`). */
export interface ApplyFbChangelogResult {
  /** Segment sequence number from the `"FBCHANGELOG\0"` header. */
  readonly sequence: number;
  /** Number of `Replication::Block` records processed. */
  readonly blocksProcessed: number;
  /** SQL DDL statements replayed. */
  readonly ddlExecuted: readonly string[];
  /** Number of logical DML (`INSERT`/`UPDATE`/`DELETE`) row operations replayed in fallback mode. */
  readonly entriesApplied?: number;
  /** Number of `opSetSequence` watermarks replayed in fallback mode. */
  readonly sequencesApplied?: number;
  /** Whether the native C++ `_fb_replicate_changelog` (`IReplicator`) fast-path was used. */
  readonly usedNativeReplicator: boolean;
}

/**
 * Introspect Firebird's `RDB$RELATION_FIELDS`, `RDB$FIELDS`, and primary-key
 * constraints on `db` to derive physical {@link JrdColumnDescriptor} layouts
 * ordered by `RDB$FIELD_ID` for decoding uncompressed JRD record buffers in
 * `"FBCHANGELOG\0"` segments without manual schema configuration (`M18 Item 1`).
 */
export async function introspectJrdTableSchemas(
  db: ReplicableDatabase,
  options: { tables?: readonly string[] } = {},
): Promise<Record<string, JrdColumnDescriptor[]>> {
  const filterSet =
    options.tables && options.tables.length > 0
      ? new Set(options.tables.map((t) => normalizeTableName(t)).filter(Boolean))
      : null;

  const pkByTable = new Map<string, Set<string>>();
  try {
    const pkRes = await db.query<Row>(
      `SELECT TRIM(rc.RDB$RELATION_NAME) AS REL_NAME, ` +
        `TRIM(iseg.RDB$FIELD_NAME) AS COL_NAME ` +
        `FROM RDB$RELATION_CONSTRAINTS rc ` +
        `JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME ` +
        `WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'`,
    );
    for (const r of pkRes.rows) {
      const rel = String(r.REL_NAME ?? r.rel_name ?? '').trim().toUpperCase();
      const col = String(r.COL_NAME ?? r.col_name ?? '').trim().toUpperCase();
      if (!rel || !col) continue;
      let set = pkByTable.get(rel);
      if (!set) {
        set = new Set<string>();
        pkByTable.set(rel, set);
      }
      set.add(col);
    }
  } catch {
    // Ignore on mock databases without RDB$RELATION_CONSTRAINTS
  }

  const out: Record<string, JrdColumnDescriptor[]> = {};
  try {
    const colRes = await db.query<Row>(
      `SELECT TRIM(rf.RDB$RELATION_NAME) AS REL_NAME, ` +
        `TRIM(rf.RDB$FIELD_NAME) AS COL_NAME, ` +
        `COALESCE(rf.RDB$FIELD_ID, rf.RDB$FIELD_POSITION) AS FIELD_SLOT, ` +
        `f.RDB$FIELD_TYPE AS FIELD_TYPE, ` +
        `COALESCE(f.RDB$FIELD_SUB_TYPE, 0) AS SUB_TYPE, ` +
        `COALESCE(f.RDB$FIELD_SCALE, 0) AS FIELD_SCALE, ` +
        `COALESCE(f.RDB$FIELD_LENGTH, 0) AS BYTE_LEN, ` +
        `COALESCE(f.RDB$CHARACTER_LENGTH, 0) AS CHAR_LEN ` +
        `FROM RDB$RELATION_FIELDS rf ` +
        `JOIN RDB$RELATIONS rel ON rel.RDB$RELATION_NAME = rf.RDB$RELATION_NAME ` +
        `JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE ` +
        `WHERE COALESCE(rel.RDB$SYSTEM_FLAG, 0) = 0 ` +
        `AND rel.RDB$VIEW_BLR IS NULL ` +
        `ORDER BY rf.RDB$RELATION_NAME, COALESCE(rf.RDB$FIELD_ID, rf.RDB$FIELD_POSITION)`,
    );

    for (const r of colRes.rows) {
      const rel = String(r.REL_NAME ?? r.rel_name ?? '').trim().toUpperCase();
      const colName = String(r.COL_NAME ?? r.col_name ?? '').trim().toUpperCase();
      if (!rel || !colName || isInternalReplicationTable(rel)) continue;
      if (filterSet && !filterSet.has(rel)) continue;

      const fieldType = Number(r.FIELD_TYPE ?? r.field_type ?? 0);
      const subType = Number(r.SUB_TYPE ?? r.sub_type ?? 0);
      const scale = Number(r.FIELD_SCALE ?? r.field_scale ?? 0);
      const byteLen = Number(r.BYTE_LEN ?? r.byte_len ?? 0);
      const charLen = Number(r.CHAR_LEN ?? r.char_len ?? 0);
      const isPk = pkByTable.get(rel)?.has(colName) === true;

      let jrdType: JrdColumnDescriptor['type'] | null = null;
      switch (fieldType) {
        case 7:
          jrdType = 'SMALLINT';
          break;
        case 8:
          jrdType = 'INTEGER';
          break;
        case 10:
          jrdType = 'FLOAT';
          break;
        case 14:
          jrdType = 'CHAR';
          break;
        case 16:
          jrdType = 'BIGINT';
          break;
        case 23:
          jrdType = 'BOOLEAN';
          break;
        case 27:
          jrdType = 'DOUBLE PRECISION';
          break;
        case 37:
          jrdType = 'VARCHAR';
          break;
        case 261:
          jrdType = 'BLOB';
          break;
        default:
          jrdType = null;
          break;
      }

      if (!jrdType) continue;

      const desc: JrdColumnDescriptor = {
        name: colName,
        type: jrdType,
        ...(byteLen > 0 && (jrdType === 'VARCHAR' || jrdType === 'CHAR')
          ? { maxBytes: byteLen }
          : {}),
        ...(charLen > 0 && (jrdType === 'VARCHAR' || jrdType === 'CHAR')
          ? { charLength: charLen }
          : {}),
        ...(scale < 0 ? { scale } : {}),
        ...(isPk ? { primaryKey: true } : {}),
        ...(jrdType === 'BLOB'
          ? { blobSubType: subType === 1 ? 'TEXT' : 'BINARY' }
          : {}),
      };

      let list = out[rel];
      if (!list) {
        list = [];
        out[rel] = list;
      }
      list.push(desc);
    }
  } catch {
    // Ignore on mock databases without RDB$RELATION_FIELDS
  }

  return out;
}

/**
 * Apply a parsed or raw `"FBCHANGELOG\0"` segment to a target database (`M16 Item 3` / `M17 Item 1` / `M18 Item 1`).
 *
 * - When `targetDb.applyChangelog` is available (e.g. `FirebirdBrowser` over
 *   `DirectTransport`, `WorkerTransport`, or `SharedEngineTransport`) and
 *   `options.preferLogicalFallback !== true`, invokes `targetDb.applyChangelog()`
 *   to replay blocks directly via C++ `IAttachment::createReplicator`.
 * - When `wasmModule` and `dbHandle` are provided and `wasmModule._fb_replicate_changelog`
 *   is compiled into the WASM binary, invokes Firebird's native `IAttachment::createReplicator`
 *   (`IReplicator::process` / `IReplicator::close`) directly in C++.
 * - Otherwise, decodes committed transactions via {@link fbChangelogToLogicalEntries}
 *   (automatically deriving `tableSchemas` from `RDB$RELATION_FIELDS` via
 *   {@link introspectJrdTableSchemas} when omitted) and replays DDL, sequence
 *   watermarks, and row mutations onto `targetDb`.
 */
export async function applyFbChangelogSegmentToDatabase(
  targetDb: ReplicableDatabase,
  segmentOrBytes: Uint8Array | ParsedFbChangelogSegment,
  options: {
    wasmModule?: {
      _fb_replicate_changelog?(dbHandle: number, dataPtr: number, byteLength: number): number;
      _malloc(size: number): number;
      _free(ptr: number): void;
      HEAPU8: Uint8Array;
    };
    dbHandle?: number;
    tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
    /** Force logical/SQL decode & replay even when `targetDb.applyChangelog` is present. @default false */
    preferLogicalFallback?: boolean;
    /** Automatically introspect `RDB$RELATION_FIELDS` when `tableSchemas` is omitted in fallback mode. @default true */
    autoIntrospectSchemas?: boolean;
    /** Allow zero-copy `Transferable` buffer handoff when `targetDb.applyChangelog` crosses a Worker. @default false */
    transfer?: boolean;
  } = {},
): Promise<ApplyFbChangelogResult> {
  const segment =
    segmentOrBytes instanceof Uint8Array
      ? parseFbChangelogSegment(segmentOrBytes)
      : segmentOrBytes;

  const effectiveLen =
    segment.header.length >= FB_CHANGELOG_HEADER_BYTES &&
    segment.header.length < segment.rawBytes.byteLength
      ? segment.header.length
      : segment.rawBytes.byteLength;
  const effectiveBytes = segment.rawBytes.subarray(0, effectiveLen);

  if (
    options.preferLogicalFallback !== true &&
    typeof targetDb.applyChangelog === 'function' &&
    !options.wasmModule
  ) {
    try {
      const rc = await targetDb.applyChangelog(
        options.transfer ? effectiveBytes.slice() : effectiveBytes,
        { transfer: options.transfer === true },
      );
      if (rc >= 0) {
        return {
          sequence: segment.header.sequence,
          blocksProcessed: rc,
          ddlExecuted: segment.executedSql,
          usedNativeReplicator: true,
        };
      }
    } catch {
      // Fall through to wasmModule or logical/SQL replay if replica mode is not enabled
    }
  }

  const mod = options.wasmModule;
  const dbHandle = options.dbHandle;
  if (
    options.preferLogicalFallback !== true &&
    mod &&
    typeof mod._fb_replicate_changelog === 'function' &&
    dbHandle &&
    dbHandle > 0
  ) {
    const ptr = mod._malloc(effectiveBytes.byteLength);
    try {
      mod.HEAPU8.set(effectiveBytes, ptr);
      const rc = mod._fb_replicate_changelog(dbHandle, ptr, effectiveBytes.byteLength);
      if (rc >= 0) {
        return {
          sequence: segment.header.sequence,
          blocksProcessed: rc,
          ddlExecuted: segment.executedSql,
          usedNativeReplicator: true,
        };
      }
    } finally {
      mod._free(ptr);
    }
  }

  let effectiveSchemas: Record<string, ReadonlyArray<JrdColumnDescriptor>> | undefined =
    options.tableSchemas ? { ...options.tableSchemas } : undefined;

  const preExecutedDdl = new Set<number>();
  const ddlExecuted: string[] = [];

  if (!effectiveSchemas && options.autoIntrospectSchemas !== false) {
    const introspected = await introspectJrdTableSchemas(targetDb);
    effectiveSchemas = { ...introspected };

    // If the segment both creates a table via committed `opExecuteSql` and inserts
    // rows into that new table in a later transaction, execute committed DDL first
    // and re-introspect missing tables so JRD record decoding succeeds immediately.
    try {
      const preDecode = fbChangelogToLogicalEntries(segment);
      const missingTables = new Set<string>();
      for (const e of preDecode.entries) {
        if (e.operation !== 'DDL' && !effectiveSchemas[e.table]) {
          missingTables.add(e.table);
        }
      }
      if (missingTables.size > 0 && preDecode.ddlStatements.length > 0) {
        for (let i = 0; i < preDecode.entries.length; i++) {
          const entry = preDecode.entries[i]!;
          if (entry.operation === 'DDL' && entry.ddlSql) {
            await execStatement(targetDb, entry.ddlSql);
            ddlExecuted.push(entry.ddlSql);
            preExecutedDdl.add(entry.lsn);
          }
        }
        const newlyIntrospected = await introspectJrdTableSchemas(targetDb, {
          tables: [...missingTables],
        });
        effectiveSchemas = { ...effectiveSchemas, ...newlyIntrospected };
      }
    } catch {
      // Ignore pre-decode errors and let standard fallback proceed
    }
  }

  let decoded: FbChangelogLogicalDecodeResult | null = null;
  try {
    decoded = fbChangelogToLogicalEntries(segment, {
      ...(effectiveSchemas !== undefined ? { tableSchemas: effectiveSchemas } : {}),
    });
  } catch {
    decoded = null;
  }

  let entriesApplied = 0;
  let sequencesApplied = 0;

  if (decoded && (decoded.entries.length > 0 || decoded.sequences.length > 0)) {
    for (const entry of decoded.entries) {
      if (entry.operation === 'DDL' && entry.ddlSql) {
        if (!preExecutedDdl.has(entry.lsn)) {
          await execStatement(targetDb, entry.ddlSql);
          ddlExecuted.push(entry.ddlSql);
        }
      } else if (
        entry.operation === 'INSERT' ||
        entry.operation === 'UPDATE' ||
        entry.operation === 'DELETE'
      ) {
        const pkCols = Object.keys(entry.key);
        if (pkCols.length > 0) {
          await applyRowMutationToTable(
            targetDb,
            entry.table,
            pkCols,
            entry.operation,
            entry.key,
            entry.after,
          );
          entriesApplied++;
        }
      }
    }
    if (decoded.sequences.length > 0) {
      sequencesApplied = await applySequences(targetDb, decoded.sequences);
    }
  } else if (ddlExecuted.length === 0) {
    for (const sql of segment.executedSql) {
      await execStatement(targetDb, sql);
      ddlExecuted.push(sql);
    }
  }

  return {
    sequence: segment.header.sequence,
    blocksProcessed: segment.blocks.length,
    ddlExecuted,
    entriesApplied,
    sequencesApplied,
    usedNativeReplicator: false,
  };
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

/**
 * Decode all binary `Replication::Block` opcodes inside a single {@link FbChangelogBlock}
 * according to Firebird's `BlockReader` (`src/jrd/replication/Applier.cpp`) (`M17 Item 1`).
 */
export function decodeFbChangelogBlockOperations(
  block: FbChangelogBlock,
): DecodedFbChangelogOperation[] {
  return decodeFbChangelogBlockOperationsStrict(block);
}

/**
 * Decode all binary `Replication::Block` operations across an entire `"FBCHANGELOG\0"`
 * segment (`opStartTransaction`, `opCommitTransaction`, `opRollbackTransaction`,
 * `opStartSavepoint`, `opReleaseSavepoint`, `opRollbackSavepoint`, `opDefineAtom`,
 * `opInsertRecord`, `opUpdateRecord`, `opDeleteRecord`, `opStoreBlob`,
 * `opExecuteSql`, `opSetSequence`, `opExecuteSqlIntl`) (`M17 Item 1`).
 */
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

/** Column layout descriptor for decoding/encoding uncompressed Firebird JRD record buffers (`M17 Item 1`). */
export interface JrdColumnDescriptor {
  /** Column name (e.g. `'ID'`, `'TITLE'`). */
  readonly name: string;
  /** SQL column type in the Firebird relation format. */
  readonly type:
    | 'SMALLINT'
    | 'INTEGER'
    | 'INT'
    | 'BIGINT'
    | 'INT64'
    | 'FLOAT'
    | 'DOUBLE PRECISION'
    | 'DOUBLE'
    | 'BOOLEAN'
    | 'VARCHAR'
    | 'CHAR'
    | 'BLOB';
  /**
   * Storage byte length of the text buffer for `VARCHAR` / `CHAR`
   * (for UTF-8 `VARCHAR(N)`, `maxBytes = N * 4`; defaults to `charLength * 4` or `128`).
   */
  readonly maxBytes?: number;
  /** Declared character length `N` for `VARCHAR(N)` / `CHAR(N)`. */
  readonly charLength?: number;
  /** Optional negative decimal scale (e.g. `-2` for `NUMERIC(9, 2)`). */
  readonly scale?: number;
  /** Whether this column is part of the table's primary key. */
  readonly primaryKey?: boolean;
  /** For `BLOB`: `'TEXT'` (decoded as UTF-8 `string`) or `'BINARY'` (`Uint8Array`). @default 'TEXT' */
  readonly blobSubType?: 'TEXT' | 'BINARY';
}

function alignOffset(offset: number, alignment: number): number {
  if (alignment <= 1) return offset;
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
}

/**
 * Decode an uncompressed Firebird JRD record buffer (`opInsertRecord` /
 * `opUpdateRecord` / `opDeleteRecord`) into a typed JavaScript row object (`M17 Item 1`).
 */
export function decodeJrdRecordBuffer(
  recordData: Uint8Array,
  columns: ReadonlyArray<JrdColumnDescriptor>,
  blobs?: ReadonlyMap<string, Uint8Array>,
): Record<string, unknown> {
  const view = new DataView(recordData.buffer, recordData.byteOffset, recordData.byteLength);
  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const row: Record<string, unknown> = {};

  // Null bitmap at offset 0: 4-byte aligned array of bits (bit i == 1 => NULL, 0 => NOT NULL).
  const nullBitmapBytes = Math.max(4, Math.ceil(columns.length / 32) * 4);
  let offset = nullBitmapBytes;

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const byteIdx = i >> 3;
    const bitMask = 1 << (i & 7);
    const isNull = byteIdx < recordData.byteLength ? (recordData[byteIdx]! & bitMask) !== 0 : true;
    const upperType = col.type.toUpperCase();
    const scaleFactor = col.scale && col.scale < 0 ? Math.pow(10, col.scale) : 1;

    switch (upperType) {
      case 'SMALLINT': {
        offset = alignOffset(offset, 2);
        const raw = offset + 2 <= recordData.byteLength ? view.getInt16(offset, true) : 0;
        offset += 2;
        row[col.name] = isNull ? null : scaleFactor !== 1 ? raw * scaleFactor : raw;
        break;
      }
      case 'INTEGER':
      case 'INT': {
        offset = alignOffset(offset, 4);
        const raw = offset + 4 <= recordData.byteLength ? view.getInt32(offset, true) : 0;
        offset += 4;
        row[col.name] = isNull ? null : scaleFactor !== 1 ? raw * scaleFactor : raw;
        break;
      }
      case 'BIGINT':
      case 'INT64': {
        offset = alignOffset(offset, 8);
        const raw = offset + 8 <= recordData.byteLength ? view.getBigInt64(offset, true) : 0n;
        offset += 8;
        if (isNull) {
          row[col.name] = null;
        } else {
          const num = Number(raw);
          row[col.name] =
            scaleFactor !== 1
              ? num * scaleFactor
              : Number.isSafeInteger(num)
                ? num
                : raw;
        }
        break;
      }
      case 'FLOAT': {
        offset = alignOffset(offset, 4);
        const raw = offset + 4 <= recordData.byteLength ? view.getFloat32(offset, true) : 0;
        offset += 4;
        row[col.name] = isNull ? null : raw;
        break;
      }
      case 'DOUBLE PRECISION':
      case 'DOUBLE': {
        offset = alignOffset(offset, 8);
        const raw = offset + 8 <= recordData.byteLength ? view.getFloat64(offset, true) : 0;
        offset += 8;
        row[col.name] = isNull ? null : raw;
        break;
      }
      case 'BOOLEAN': {
        const raw = offset < recordData.byteLength ? recordData[offset]! : 0;
        offset += 1;
        row[col.name] = isNull ? null : raw !== 0;
        break;
      }
      case 'VARCHAR': {
        offset = alignOffset(offset, 2);
        const maxBytes = col.maxBytes ?? (col.charLength ?? 32) * 4;
        const actualLen =
          offset + 2 <= recordData.byteLength
            ? Math.min(maxBytes, view.getUint16(offset, true))
            : 0;
        const strStart = offset + 2;
        row[col.name] = isNull
          ? null
          : utf8.decode(
              recordData.subarray(strStart, Math.min(recordData.byteLength, strStart + actualLen)),
            );
        offset += 2 + maxBytes;
        break;
      }
      case 'CHAR': {
        const maxBytes = col.maxBytes ?? (col.charLength ?? 1) * 4;
        if (isNull) {
          row[col.name] = null;
        } else {
          const rawStr = utf8.decode(
            recordData.subarray(offset, Math.min(recordData.byteLength, offset + maxBytes)),
          );
          row[col.name] =
            col.charLength !== undefined ? rawStr.slice(0, col.charLength).trimEnd() : rawStr.trimEnd();
        }
        offset += maxBytes;
        break;
      }
      case 'BLOB': {
        offset = alignOffset(offset, 4);
        const quadSlice = recordData.slice(offset, Math.min(recordData.byteLength, offset + 8));
        offset += 8;
        if (isNull || quadSlice.every((b) => b === 0)) {
          row[col.name] = null;
        } else {
          const hex = bytesToHexLower(quadSlice);
          const blobBytes = blobs?.get(hex);
          if (!blobBytes) {
            row[col.name] = hex;
          } else if ((col.blobSubType ?? 'TEXT') === 'BINARY') {
            row[col.name] = blobBytes;
          } else {
            row[col.name] = utf8.decode(blobBytes);
          }
        }
        break;
      }
      default:
        row[col.name] = null;
        break;
    }
  }

  return row;
}

/**
 * Encode a JavaScript row object into Firebird's uncompressed JRD record buffer
 * format (`M17 Item 1` / `M17 Item 4`).
 */
export function encodeJrdRecordBuffer(
  row: Readonly<Record<string, unknown>>,
  columns: ReadonlyArray<JrdColumnDescriptor>,
): Uint8Array {
  const utf8Enc = new TextEncoder();
  const nullBitmapBytes = Math.max(4, Math.ceil(columns.length / 32) * 4);

  // First pass: calculate total byte length
  let totalLen = nullBitmapBytes;
  for (const col of columns) {
    const upperType = col.type.toUpperCase();
    switch (upperType) {
      case 'SMALLINT':
        totalLen = alignOffset(totalLen, 2) + 2;
        break;
      case 'INTEGER':
      case 'INT':
      case 'FLOAT':
        totalLen = alignOffset(totalLen, 4) + 4;
        break;
      case 'BIGINT':
      case 'INT64':
      case 'DOUBLE PRECISION':
      case 'DOUBLE':
        totalLen = alignOffset(totalLen, 8) + 8;
        break;
      case 'BOOLEAN':
        totalLen += 1;
        break;
      case 'VARCHAR':
        totalLen = alignOffset(totalLen, 2) + 2 + (col.maxBytes ?? (col.charLength ?? 32) * 4);
        break;
      case 'CHAR':
        totalLen += col.maxBytes ?? (col.charLength ?? 1) * 4;
        break;
      case 'BLOB':
        totalLen = alignOffset(totalLen, 4) + 8;
        break;
    }
  }

  const buf = new Uint8Array(totalLen);
  // Firebird initializes unused null-bitmap bits in the first 32-bit word to 1 (e.g. 0xFC for 2 NOT NULL cols)
  for (let b = 0; b < nullBitmapBytes; b++) {
    buf[b] = 0xff;
  }
  const view = new DataView(buf.buffer);
  let offset = nullBitmapBytes;

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const val = row[col.name] ?? row[col.name.toUpperCase()] ?? row[col.name.toLowerCase()];
    const isNull = val === null || val === undefined;
    if (!isNull) {
      buf[i >> 3]! &= ~(1 << (i & 7));
    }

    const upperType = col.type.toUpperCase();
    const invScale = col.scale && col.scale < 0 ? Math.pow(10, -col.scale) : 1;

    switch (upperType) {
      case 'SMALLINT':
        offset = alignOffset(offset, 2);
        if (!isNull) view.setInt16(offset, Math.round(Number(val) * invScale), true);
        offset += 2;
        break;
      case 'INTEGER':
      case 'INT':
        offset = alignOffset(offset, 4);
        if (!isNull) view.setInt32(offset, Math.round(Number(val) * invScale), true);
        offset += 4;
        break;
      case 'BIGINT':
      case 'INT64':
        offset = alignOffset(offset, 8);
        if (!isNull) {
          const bv =
            typeof val === 'bigint'
              ? val
              : typeof val === 'string' && (!col.scale || col.scale === 0) && /^-?\d+$/.test(val.trim())
                ? BigInt(val.trim())
                : BigInt(Math.round(Number(val) * invScale));
          view.setBigInt64(offset, bv, true);
        }
        offset += 8;
        break;
      case 'FLOAT':
        offset = alignOffset(offset, 4);
        if (!isNull) view.setFloat32(offset, Number(val), true);
        offset += 4;
        break;
      case 'DOUBLE PRECISION':
      case 'DOUBLE':
        offset = alignOffset(offset, 8);
        if (!isNull) view.setFloat64(offset, Number(val), true);
        offset += 8;
        break;
      case 'BOOLEAN':
        buf[offset] =
          !isNull &&
          (typeof val === 'string'
            ? /^(true|1|t|yes)$/i.test(val.trim())
            : Boolean(val))
            ? 1
            : 0;
        offset += 1;
        break;
      case 'VARCHAR': {
        offset = alignOffset(offset, 2);
        const maxBytes = col.maxBytes ?? (col.charLength ?? 32) * 4;
        if (!isNull) {
          const encoded = utf8Enc.encode(String(val));
          const copyLen = Math.min(maxBytes, encoded.byteLength);
          view.setUint16(offset, copyLen, true);
          buf.set(encoded.subarray(0, copyLen), offset + 2);
        }
        offset += 2 + maxBytes;
        break;
      }
      case 'CHAR': {
        const maxBytes = col.maxBytes ?? (col.charLength ?? 1) * 4;
        buf.fill(0x20, offset, offset + maxBytes);
        if (!isNull) {
          const encoded = utf8Enc.encode(String(val));
          buf.set(encoded.subarray(0, Math.min(maxBytes, encoded.byteLength)), offset);
        }
        offset += maxBytes;
        break;
      }
      case 'BLOB': {
        offset = alignOffset(offset, 4);
        if (!isNull && typeof val === 'string' && /^[0-9a-fA-F]{16}$/.test(val)) {
          for (let j = 0; j < 8; j++) {
            buf[offset + j] = parseInt(val.slice(j * 2, j * 2 + 2), 16);
          }
        } else if (!isNull && val instanceof Uint8Array && val.byteLength === 8) {
          buf.set(val, offset);
        }
        offset += 8;
        break;
      }
    }
  }

  return buf;
}

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

/**
 * Convert a binary Firebird `"FBCHANGELOG\0"` segment into committed logical
 * {@link ReplicationLogEntry} items and {@link SequenceWatermark} updates (`M17 Item 1`).
 *
 * Honors transaction boundaries (`opCommitTransaction` vs `opRollbackTransaction` /
 * `opCleanupTransaction`), nested savepoint rollbacks (`opStartSavepoint` /
 * `opReleaseSavepoint` / `opRollbackSavepoint`), `opStoreBlob` payloads, and
 * non-transactional `opSetSequence` watermarks (`traNumber === 0` or inside a tx).
 */
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
    // Sequences in Firebird are non-transactional and replicate immediately!
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

/** Replica mode flag stored in `Ods::header_page::hdr_replica_mode` (offset `26`) (`M17 Item 5`). */
export type WasmReplicaMode = 'none' | 'read_only' | 'read_write' | 0 | 1 | 2;

/**
 * Configure `Ods::header_page::hdr_replica_mode` (byte offset `26` on page `0`,
 * per Firebird `src/jrd/ods.h`) on an unattached `.fdb` database file in
 * Emscripten `MEMFS` so `IAttachment::createReplicator` (`_fb_replicate_changelog`)
 * accepts incoming `"FBCHANGELOG\0"` binary blocks (`M17 Item 5`).
 */
export function setWasmDatabaseReplicaMode(
  fs: ReplicationEmscriptenFS,
  dbPath: string,
  mode: WasmReplicaMode = 'read_write',
): { dbPath: string; mode: 'none' | 'read_only' | 'read_write'; modeCode: 0 | 1 | 2 } {
  const modeCode: 0 | 1 | 2 =
    mode === 0 || mode === 'none'
      ? 0
      : mode === 1 || mode === 'read_only'
        ? 1
        : 2;
  const modeName: 'none' | 'read_only' | 'read_write' =
    modeCode === 0 ? 'none' : modeCode === 1 ? 'read_only' : 'read_write';

  const raw = fs.readFile(dbPath);
  if (!(raw instanceof Uint8Array) || raw.byteLength < 152) {
    throw new Error(`Invalid Firebird database file at "${dbPath}": expected >= 152 header bytes.`);
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const pagType = raw[0];
  const pageSize = view.getUint16(16, true);
  if (pagType !== 1 || pageSize < 4096) {
    throw new Error(
      `Invalid Firebird ODS header page at "${dbPath}" (pag_type=${pagType}, hdr_page_size=${pageSize}).`,
    );
  }

  const copy = raw.slice();
  // Ods::header_page::hdr_replica_mode is at byte offset 26 (static_assert in src/jrd/ods.h).
  copy[26] = modeCode;
  fs.writeFile(dbPath, copy);
  return { dbPath, mode: modeName, modeCode };
}

/** Options for {@link createWasmChangelogPoller} (`M17 Item 2`). */
export interface WasmChangelogPollerOptions {
  /** Emscripten `MEMFS` (or Node.js FS adapter) containing changelog directories. */
  fs: ReplicationEmscriptenFS;
  /** Target replica database receiving `"FBCHANGELOG\0"` segments. */
  targetDb: ReplicableDatabase;
  /** Directory where sealed `"FBCHANGELOG\0"` segments are archived (`journal_archive_directory`). */
  journalArchiveDirectory: string;
  /** Optional active `journal_directory` fallback when segments have not yet rotated to archive. */
  journalDirectory?: string;
  /** Initial acknowledged changelog `sequence` watermark (`0` = apply from sequence `1`). @default 0 */
  initialSequence?: number;
  /** Unlink acknowledged archive segment files from `journalArchiveDirectory` after applying. @default false */
  unlinkArchivedSegments?: boolean;
  /** Default polling interval in milliseconds when `start()` is called. @default 100 */
  intervalMs?: number;
  /** Optional compiled WASM module for native C++ `_fb_replicate_changelog` (`IReplicator`) replay. */
  wasmModule?: {
    _fb_replicate_changelog?(dbHandle: number, dataPtr: number, byteLength: number): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPU8: Uint8Array;
  };
  /** Optional replica `dbHandle` inside `wasmModule` for native C++ `_fb_replicate_changelog`. */
  dbHandle?: number;
  /** Optional JRD column descriptors for SQL/logical fallback when `_fb_replicate_changelog` is absent. */
  tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
  /** Optional callback invoked for each newly applied segment. */
  onSegment?: (
    segment: ParsedFbChangelogSegment,
    result: ApplyFbChangelogResult,
  ) => void | Promise<void>;
  /** Optional error callback invoked if polling/applying throws during background timer execution. */
  onError?: (error: Error) => void;
}

/** Cumulative telemetry returned by `poller.stats()` (`M17 Item 2`). */
export interface WasmChangelogPollerStats {
  readonly running: boolean;
  readonly pollCount: number;
  readonly segmentsApplied: number;
  readonly blocksApplied: number;
  readonly filesUnlinked: number;
  readonly lastAppliedSequence: number;
}

/** Continuous native `"FBCHANGELOG\0"` poller & archiver handle returned by {@link createWasmChangelogPoller} (`M17 Item 2`). */
export interface WasmChangelogPoller {
  /** Scan `journalArchiveDirectory` (and `journalDirectory`), apply new segments in `sequence` order, and return results. */
  pollOnce(): Promise<ApplyFbChangelogResult[]>;
  /** Start background timer polling every `intervalMs` milliseconds. */
  start(intervalMs?: number): void;
  /** Stop background timer polling. */
  stop(): void;
  /** Highest segment `sequence` successfully applied so far. */
  lastAppliedSequence(): number;
  /** Inspect cumulative poller & archiver telemetry. */
  stats(): WasmChangelogPollerStats;
}

/**
 * Create a continuous poller and archiver transport for native Firebird
 * `"FBCHANGELOG\0"` segment files in Emscripten `MEMFS` (`M17 Item 2`).
 */
export function createWasmChangelogPoller(
  options: WasmChangelogPollerOptions,
): WasmChangelogPoller {
  let currentSeq = options.initialSequence ?? 0;
  let pollCount = 0;
  let segmentsApplied = 0;
  let blocksApplied = 0;
  let filesUnlinked = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<ApplyFbChangelogResult[]> | null = null;

  const cleanArchiveDir = options.journalArchiveDirectory.endsWith('/')
    ? options.journalArchiveDirectory.slice(0, -1)
    : options.journalArchiveDirectory;

  const runPoll = async (): Promise<ApplyFbChangelogResult[]> => {
    pollCount++;
    const bySeq = new Map<number, { seg: ParsedFbChangelogSegment; fromArchive: boolean }>();

    const archived = readWasmChangelogSegments(options.fs, options.journalArchiveDirectory, {
      sinceSequence: currentSeq,
    });
    for (const seg of archived) {
      bySeq.set(seg.header.sequence, { seg, fromArchive: true });
    }

    if (options.journalDirectory) {
      const active = readWasmChangelogSegments(options.fs, options.journalDirectory, {
        sinceSequence: currentSeq,
      });
      for (const seg of active) {
        if (!bySeq.has(seg.header.sequence)) {
          bySeq.set(seg.header.sequence, { seg, fromArchive: false });
        }
      }
    }

    const ordered = [...bySeq.values()].sort(
      (a, b) => a.seg.header.sequence - b.seg.header.sequence,
    );
    const results: ApplyFbChangelogResult[] = [];

    for (const { seg, fromArchive } of ordered) {
      if (seg.header.sequence <= currentSeq) continue;
      const res = await applyFbChangelogSegmentToDatabase(options.targetDb, seg, {
        ...(options.wasmModule !== undefined ? { wasmModule: options.wasmModule } : {}),
        ...(options.dbHandle !== undefined ? { dbHandle: options.dbHandle } : {}),
        ...(options.tableSchemas !== undefined ? { tableSchemas: options.tableSchemas } : {}),
      });
      currentSeq = seg.header.sequence;
      segmentsApplied++;
      blocksApplied += res.blocksProcessed;
      results.push(res);

      if (options.onSegment) {
        await options.onSegment(seg, res);
      }

      if (
        fromArchive &&
        options.unlinkArchivedSegments &&
        seg.filename &&
        typeof options.fs.unlink === 'function'
      ) {
        try {
          options.fs.unlink(`${cleanArchiveDir}/${seg.filename}`);
          filesUnlinked++;
        } catch {
          // Ignore if already unlinked
        }
      }
    }

    return results;
  };

  return {
    async pollOnce(): Promise<ApplyFbChangelogResult[]> {
      if (inFlight) return inFlight;
      inFlight = runPoll().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    start(intervalMs?: number): void {
      if (timer !== null) return;
      const ms = Math.max(10, intervalMs ?? options.intervalMs ?? 100);
      timer = setInterval(() => {
        void this.pollOnce().catch((err) => {
          if (options.onError) {
            options.onError(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }, ms);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    lastAppliedSequence(): number {
      return currentSeq;
    },
    stats(): WasmChangelogPollerStats {
      return {
        running: timer !== null,
        pollCount,
        segmentsApplied,
        blocksApplied,
        filesUnlinked,
        lastAppliedSequence: currentSeq,
      };
    },
  };
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
