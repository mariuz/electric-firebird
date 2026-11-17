/**
 * arrow-snapshot.ts – Zero-Copy Apache Arrow IPC V5 Filtered Replica Snapshot
 * Export, Binary Bundle Wire Codec & `"FBP\x02"` Replica Seeding (`M23 Item 3`).
 */

import type { QueryParams, Row } from '../types';
import {
  decodeArrowIpc,
  encodeArrowIpc,
  rowsToColumnarResult,
} from '../columnar';
import { collectArrowStreamBytes } from '../columnar-stream';
import {
  buildCreateTableDdlFromColumnar,
  loadArrowIpcIntoDatabase,
  type ArrowIngestHost,
} from '../arrow-ingest';
import {
  DEFAULT_REPL_ROLE_CONTEXT_VAR,
  type BootstrapReplicaResult,
  type ReplicableDatabase,
  type ReplicationPublication,
  type ReplicationSubscription,
} from './types';
import {
  ensureTableSafe,
  execStatement,
  gunzipBytes,
  gzipBytes,
  isGzipBytes,
  normalizeTableName,
  quoteIdent,
} from './shared';
import { readTenantField, valuesMatchTenantId } from './tenant-slice';

/** 8-byte wire magic `"FBARSNAP"` for multi-table Arrow IPC snapshot bundles (`M23 Item 3`). */
const ARROW_SNAPSHOT_MAGIC = new Uint8Array([
  0x46, 0x42, 0x41, 0x52, 0x53, 0x4e, 0x41, 0x50,
]);

export interface ArrowTableSnapshot {
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly ddlSql?: string | null;
  readonly rowCount: number;
  /** Raw Apache Arrow IPC V5 stream bytes for this table. */
  readonly arrowBytes: Uint8Array;
}

export interface ArrowPublicationSnapshot {
  readonly publication: string;
  readonly origin: string;
  readonly watermarkLsn: number;
  readonly timestamp: number;
  readonly tables: readonly ArrowTableSnapshot[];
}

export interface ExportArrowSnapshotOptions {
  /** Optional tenant column for SQL `WHERE <tenantColumn> = ?` slice pushdown. */
  tenantColumn?: string;
  /** Tenant ID paired with `tenantColumn`. */
  tenantId?: string | number;
  /** Shared reference tables exempt from `tenantColumn` filtering. */
  sharedTables?: readonly string[];
  /** Optional table whitelist (e.g. from JWT `tables` claim). */
  allowedTables?: ReadonlySet<string> | null;
  /** Explicit DDL overrides keyed by table name. */
  tableDdl?: Readonly<Record<string, string>>;
  /** Parallel table export concurrency. @default 1 */
  concurrency?: number;
}

export interface ApplyArrowSnapshotOptions {
  /** Optional replica subscription whose watermark should advance to `snapshot.watermarkLsn`. */
  subscription?: ReplicationSubscription;
  /** Optional primary publication whose slot should advance when `slotName` is set. */
  publication?: ReplicationPublication;
  slotName?: string;
  /** Truncate (`DELETE FROM`) existing rows in each table before Arrow ingestion. @default true */
  truncateExisting?: boolean;
  /** Parallel table seeding concurrency. @default 1 */
  concurrency?: number;
  /** Optional DDL overrides keyed by table name. */
  tableDdl?: Readonly<Record<string, string>>;
}

interface ArrowCapableDb extends ReplicableDatabase {
  queryArrow?(sql: string, params?: QueryParams): Promise<Uint8Array>;
  queryArrowStream?(sql: string, params?: QueryParams): ReadableStream<Uint8Array>;
  loadArrowIpc?: ArrowIngestHost['execWireBatch'] extends unknown
    ? (
        tableName: string,
        source: Uint8Array,
        opts?: {
          createTable?: boolean;
          primaryKey?: string | readonly string[];
          upsertMatching?: string | readonly string[];
        },
      ) => Promise<{ rowsIngested: number; batchesExecuted: number }>
    : never;
}

/**
 * Export a publication's tables directly as Apache Arrow IPC V5 streams,
 * pushing down `WHERE <tenantColumn> = ?` and table whitelists (`M23 Item 3`).
 */
export async function exportArrowSnapshot(
  publication: ReplicationPublication,
  options: ExportArrowSnapshotOptions = {},
): Promise<ArrowPublicationSnapshot> {
  await publication.refreshPublishedTables();
  await publication.captureTableChanges();
  const watermarkLsn = await publication.currentLsn();
  const timestamp = Date.now();

  const sharedSet = new Set(
    (options.sharedTables ?? []).map((t) => normalizeTableName(t)),
  );
  const internalDb = (publication as unknown as { _db?: ArrowCapableDb })._db;

  const entriesList = [...publication.tables.entries()].filter(([tblUpper]) => {
    if (!options.allowedTables) return true;
    return options.allowedTables.has(tblUpper);
  });

  if (!internalDb) {
    // Remote / abstract publication fallback via logical snapshot conversion
    const logical = await publication.exportSnapshot({
      mode: 'logical',
      tableDdl: options.tableDdl,
      concurrency: options.concurrency,
    });
    const tables: ArrowTableSnapshot[] = [];
    for (const tbl of logical.tables) {
      const tblUpper = normalizeTableName(tbl.table);
      if (options.allowedTables && !options.allowedTables.has(tblUpper)) continue;
      let rows = tbl.rows;
      if (
        options.tenantColumn &&
        options.tenantId !== undefined &&
        !sharedSet.has(tblUpper)
      ) {
        rows = rows.filter((r) => {
          const tf = readTenantField(r, options.tenantColumn!);
          return tf.present && valuesMatchTenantId(tf.value, options.tenantId!);
        });
      }
      const colNames =
        rows.length > 0
          ? Object.keys(rows[0]!)
          : [...tbl.primaryKey];
      const col = rowsToColumnarResult({
        fields: colNames.map((name) => ({ name, nullable: true })),
        rows: rows as Row[],
      });
      const ddlSql =
        tbl.ddlSql ??
        options.tableDdl?.[tblUpper] ??
        options.tableDdl?.[tblUpper.toLowerCase()] ??
        (col.fields.length > 0
          ? buildCreateTableDdlFromColumnar(tblUpper, col.fields, { primaryKey: tbl.primaryKey })
          : null);
      tables.push({
        table: tblUpper,
        primaryKey: tbl.primaryKey,
        ddlSql,
        rowCount: col.rowCount,
        arrowBytes: encodeArrowIpc(col),
      });
    }
    return {
      publication: logical.publication,
      origin: logical.origin,
      watermarkLsn: logical.watermarkLsn,
      timestamp: logical.timestamp,
      tables,
    };
  }

  const poolConcurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const tableSnapshots = new Array<ArrowTableSnapshot>(entriesList.length);
  let nextIdx = 0;

  const exportOne = async (
    idx: number,
    tableUpper: string,
    cfg: { primaryKey: readonly string[]; columns?: readonly string[]; excludeColumns?: readonly string[]; where?: string | ((row: Record<string, unknown>) => boolean) },
  ): Promise<void> => {
    const isTenantScoped =
      Boolean(options.tenantColumn) &&
      options.tenantId !== undefined &&
      !sharedSet.has(tableUpper);

    const whereClauses: string[] = [];
    const whereParams: QueryParams = [];
    if (isTenantScoped && options.tenantColumn) {
      whereClauses.push(`${quoteIdent(options.tenantColumn.toUpperCase())} = ?`);
      whereParams.push(options.tenantId as string | number);
    }
    if (typeof cfg.where === 'string' && cfg.where.trim()) {
      whereClauses.push(`(${cfg.where})`);
    }

    let selectProjection = '*';
    if (cfg.columns && cfg.columns.length > 0) {
      const mergedCols = new Set([
        ...cfg.primaryKey.map((c) => c.toUpperCase()),
        ...cfg.columns.map((c) => c.toUpperCase()),
      ]);
      selectProjection = [...mergedCols].map((c) => quoteIdent(c)).join(', ');
    }

    const sql =
      whereClauses.length > 0
        ? `SELECT ${selectProjection} FROM ${quoteIdent(tableUpper)} WHERE ${whereClauses.join(' AND ')}`
        : `SELECT ${selectProjection} FROM ${quoteIdent(tableUpper)}`;

    const hasJsFilterOrBlacklist =
      typeof cfg.where === 'function' ||
      Boolean(cfg.excludeColumns && cfg.excludeColumns.length > 0);

    let arrowBytes: Uint8Array;
    let rowCount = 0;
    let inferredDdl: string | null = null;

    if (!hasJsFilterOrBlacklist && typeof internalDb.queryArrowStream === 'function') {
      arrowBytes = await collectArrowStreamBytes(
        internalDb.queryArrowStream(sql, whereParams),
      );
      const decoded = decodeArrowIpc(arrowBytes);
      rowCount = decoded.rowCount;
      if (decoded.fields.length > 0) {
        inferredDdl = buildCreateTableDdlFromColumnar(tableUpper, decoded.fields, {
          primaryKey: cfg.primaryKey,
        });
      }
    } else if (!hasJsFilterOrBlacklist && typeof internalDb.queryArrow === 'function') {
      arrowBytes = await internalDb.queryArrow(sql, whereParams);
      const decoded = decodeArrowIpc(arrowBytes);
      rowCount = decoded.rowCount;
      if (decoded.fields.length > 0) {
        inferredDdl = buildCreateTableDdlFromColumnar(tableUpper, decoded.fields, {
          primaryKey: cfg.primaryKey,
        });
      }
    } else {
      const qRes = await internalDb.query<Row>(sql, whereParams);
      const excludeSet = new Set(
        (cfg.excludeColumns ?? []).map((c) => c.toUpperCase()),
      );
      const pkUpper = new Set(cfg.primaryKey.map((c) => c.toUpperCase()));
      const keptFields = qRes.fields.filter(
        (f) => pkUpper.has(f.name.toUpperCase()) || !excludeSet.has(f.name.toUpperCase()),
      );
      let rows = qRes.rows;
      if (typeof cfg.where === 'function') {
        const fn = cfg.where;
        rows = rows.filter((r) => fn(r));
      }
      const col = rowsToColumnarResult({ fields: keptFields, rows });
      rowCount = col.rowCount;
      arrowBytes = encodeArrowIpc(col);
      if (col.fields.length > 0) {
        inferredDdl = buildCreateTableDdlFromColumnar(tableUpper, col.fields, {
          primaryKey: cfg.primaryKey,
        });
      }
    }

    const explicitDdl =
      options.tableDdl?.[tableUpper] ??
      options.tableDdl?.[tableUpper.toLowerCase()] ??
      inferredDdl;

    tableSnapshots[idx] = {
      table: tableUpper,
      primaryKey: cfg.primaryKey,
      ddlSql: explicitDdl,
      rowCount,
      arrowBytes,
    };
  };

  const workerCount = Math.min(poolConcurrency, Math.max(1, entriesList.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const idx = nextIdx++;
        if (idx >= entriesList.length) break;
        const [tableUpper, cfg] = entriesList[idx]!;
        await exportOne(idx, tableUpper, cfg);
      }
    }),
  );

  return {
    publication: publication.name,
    origin: publication.nodeId,
    watermarkLsn,
    timestamp,
    tables: tableSnapshots,
  };
}

interface EncodedArrowSnapshotManifest {
  publication: string;
  origin: string;
  watermarkLsn: number;
  timestamp: number;
  tables: Array<{
    table: string;
    primaryKey: readonly string[];
    ddlSql?: string | null;
    rowCount: number;
    byteOffset: number;
    byteLength: number;
  }>;
}

/**
 * Pack an {@link ArrowPublicationSnapshot} into a single binary `"FBARSNAP"`
 * frame (optionally gzip-compressed) suitable for HTTP / WebSocket transport (`M23 Item 3`).
 */
export async function encodeArrowSnapshotBundle(
  snapshot: ArrowPublicationSnapshot,
  options: { compressGzip?: boolean } = {},
): Promise<Uint8Array> {
  let payloadCursor = 0;
  const manifestTables: EncodedArrowSnapshotManifest['tables'] = [];
  for (const tbl of snapshot.tables) {
    manifestTables.push({
      table: tbl.table,
      primaryKey: tbl.primaryKey,
      ddlSql: tbl.ddlSql ?? null,
      rowCount: tbl.rowCount,
      byteOffset: payloadCursor,
      byteLength: tbl.arrowBytes.byteLength,
    });
    payloadCursor += tbl.arrowBytes.byteLength;
  }

  const manifestObj: EncodedArrowSnapshotManifest = {
    publication: snapshot.publication,
    origin: snapshot.origin,
    watermarkLsn: snapshot.watermarkLsn,
    timestamp: snapshot.timestamp,
    tables: manifestTables,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestObj));
  const totalLen = 8 + 4 + manifestBytes.byteLength + payloadCursor;
  const out = new Uint8Array(totalLen);
  out.set(ARROW_SNAPSHOT_MAGIC, 0);
  new DataView(out.buffer).setUint32(8, manifestBytes.byteLength, true);
  out.set(manifestBytes, 12);

  let writePos = 12 + manifestBytes.byteLength;
  for (const tbl of snapshot.tables) {
    if (tbl.arrowBytes.byteLength > 0) {
      out.set(tbl.arrowBytes, writePos);
      writePos += tbl.arrowBytes.byteLength;
    }
  }

  return options.compressGzip ? gzipBytes(out) : out;
}

/**
 * Decode a binary `"FBARSNAP"` (or gzipped `"FBARSNAP"`) bundle back into an
 * {@link ArrowPublicationSnapshot} (`M23 Item 3`).
 */
export async function decodeArrowSnapshotBundle(
  bundleBytes: Uint8Array,
): Promise<ArrowPublicationSnapshot> {
  const raw = isGzipBytes(bundleBytes) ? await gunzipBytes(bundleBytes) : bundleBytes;
  if (raw.byteLength < 12) {
    throw new Error('decodeArrowSnapshotBundle: truncated FBARSNAP header');
  }
  for (let i = 0; i < 8; i++) {
    if (raw[i] !== ARROW_SNAPSHOT_MAGIC[i]) {
      throw new Error('decodeArrowSnapshotBundle: invalid FBARSNAP magic header');
    }
  }
  const manifestLen = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(
    8,
    true,
  );
  const payloadStart = 12 + manifestLen;
  if (payloadStart > raw.byteLength) {
    throw new Error('decodeArrowSnapshotBundle: truncated FBARSNAP manifest');
  }
  const manifestJson = new TextDecoder().decode(raw.subarray(12, payloadStart));
  const manifest = JSON.parse(manifestJson) as EncodedArrowSnapshotManifest;

  const tables: ArrowTableSnapshot[] = manifest.tables.map((t) => {
    const start = payloadStart + t.byteOffset;
    const end = start + t.byteLength;
    if (end > raw.byteLength) {
      throw new Error(
        `decodeArrowSnapshotBundle: truncated Arrow IPC payload for table ${t.table}`,
      );
    }
    return {
      table: t.table,
      primaryKey: t.primaryKey,
      ddlSql: t.ddlSql ?? null,
      rowCount: t.rowCount,
      arrowBytes: raw.slice(start, end),
    };
  });

  return {
    publication: manifest.publication,
    origin: manifest.origin,
    watermarkLsn: manifest.watermarkLsn,
    timestamp: manifest.timestamp,
    tables,
  };
}

/**
 * Seed a replica database directly from an {@link ArrowPublicationSnapshot}
 * using `"FBP\x02"` binary wire batches (`loadArrowIpcIntoDatabase`) without
 * intermediate JS row objects (`M23 Item 3`).
 */
export async function applyArrowSnapshot(
  targetDb: ReplicableDatabase,
  snapshot: ArrowPublicationSnapshot,
  options: ApplyArrowSnapshotOptions = {},
): Promise<BootstrapReplicaResult> {
  const truncateExisting = options.truncateExisting ?? true;
  const seedConcurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  let rowsCopied = 0;
  let bytesTransferred = 0;

  try {
    await targetDb.query(
      `SELECT RDB$SET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}', 'REPLICA') FROM RDB$DATABASE`,
    );
  } catch {
    // Ignore on mock databases without RDB$SET_CONTEXT
  }

  let nextIdx = 0;
  const seedOne = async (tbl: ArrowTableSnapshot): Promise<void> => {
    const tableUpper = normalizeTableName(tbl.table);
    bytesTransferred += tbl.arrowBytes.byteLength;

    const ddl =
      tbl.ddlSql ??
      options.tableDdl?.[tableUpper] ??
      options.tableDdl?.[tableUpper.toLowerCase()];
    if (ddl) {
      await ensureTableSafe(targetDb, ddl);
    }

    if (truncateExisting) {
      try {
        await execStatement(targetDb, `DELETE FROM ${quoteIdent(tableUpper)}`);
      } catch {
        // Table may not exist yet
      }
    }

    if (tbl.rowCount > 0 && tbl.arrowBytes.byteLength > 0) {
      const arrowCapable = targetDb as ArrowCapableDb;
      if (typeof arrowCapable.loadArrowIpc === 'function') {
        const res = await arrowCapable.loadArrowIpc(tableUpper, tbl.arrowBytes, {
          createTable: !ddl,
          primaryKey: tbl.primaryKey,
          upsertMatching: tbl.primaryKey,
        });
        rowsCopied += res.rowsIngested;
      } else {
        const res = await loadArrowIpcIntoDatabase(
          targetDb as unknown as ArrowIngestHost,
          tableUpper,
          tbl.arrowBytes,
          {
            createTable: !ddl,
            primaryKey: tbl.primaryKey,
            upsertMatching: tbl.primaryKey,
          },
        );
        rowsCopied += res.rowsIngested;
      }
    }
  };

  try {
    const workerCount = Math.min(seedConcurrency, Math.max(1, snapshot.tables.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const idx = nextIdx++;
          if (idx >= snapshot.tables.length) break;
          await seedOne(snapshot.tables[idx]!);
        }
      }),
    );
  } finally {
    try {
      await targetDb.query(
        `SELECT RDB$SET_CONTEXT('USER_SESSION', '${DEFAULT_REPL_ROLE_CONTEXT_VAR}', NULL) FROM RDB$DATABASE`,
      );
    } catch {
      // Ignore
    }
  }

  if (options.subscription) {
    await options.subscription.setWatermark(snapshot.watermarkLsn);
    // Sync internal bidirectional mirror if present so bootstrapped rows aren't re-emitted
    const internalPub = (options.subscription as unknown as {
      _localPublication?: ReplicationPublication & { refreshPublishedTables?: () => Promise<void> };
    })._localPublication;
    if (internalPub?.refreshPublishedTables) {
      await internalPub.refreshPublishedTables();
    }
  }

  const slotToAdvance = options.slotName ?? options.subscription?.slotName;
  if (slotToAdvance && options.publication) {
    await options.publication.advanceSlot(slotToAdvance, snapshot.watermarkLsn, {
      nodeId: options.subscription?.nodeId,
    });
  }

  return {
    mode: 'arrow-ipc',
    tablesBootstrapped: snapshot.tables.length,
    rowsCopied,
    watermarkLsn: snapshot.watermarkLsn,
    bytesTransferred,
  };
}
