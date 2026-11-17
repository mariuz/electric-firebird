/**
 * node-native-batch.ts – Firebird 4+ native `IBatch` execution, connection
 * `StatementCache`, and row-fetching helpers (`M20 Item 5` / `M23 Item 5`).
 */

import { TransactionIsolation } from 'node-firebird-driver';
import type {
  Attachment,
  Statement,
  Transaction,
  TransactionOptions as NativeTransactionOptions,
} from 'node-firebird-driver';
import type {
  FieldInfo,
  QueryParams,
  QueryResult,
  RowMode,
  TransactionOptions,
} from './types';
import { applyTypes, type TypeOptions } from './browser/value-types';
import type { CharacterSet } from './batch-block';
import {
  bindParams,
  inputParams,
  outputFields,
  resolveOutputRows,
  SQL_BLOB,
  TEXT_TYPES,
  useMessage,
  type NativeBatch,
  type NativeStatement,
  type NativeXpbBuilder,
} from './node-native-bindings';

const XPB_BATCH = 5;
const BATCH_VERSION1 = 1;
const BATCH_TAG_RECORD_COUNTS = 2;
const BATCH_TAG_BUFFER_BYTES_SIZE = 3;
const BATCH_TAG_BLOB_POLICY = 4;
const BATCH_BLOB_ID_ENGINE = 1;
const BATCH_EXECUTE_FAILED = -1;

/**
 * Execute `rows` through Firebird 4+'s native `IBatch` interface
 * (`statementHandle.createBatchAsync`, added in
 * `asfernandes/node-firebird-drivers#178`).
 *
 * Returns `true` when the batch ran via `IBatch`, or `false` when the loaded
 * `node-firebird-native-api` build or the connected server (e.g. Firebird 3)
 * does not support `IBatch`, allowing `execBatch` to fall back to
 * `EXECUTE BLOCK`.
 */
export async function tryExecuteNativeBatch(
  stmt: Statement,
  transaction: Transaction,
  rows: QueryParams[],
): Promise<boolean> {
  const internal = stmt as unknown as NativeStatement;
  const createBatchAsync = internal.statementHandle?.createBatchAsync;
  const client = internal.attachment?.client;
  const txHandle = (transaction as unknown as { transactionHandle?: unknown }).transactionHandle;
  if (
    typeof createBatchAsync !== 'function' ||
    typeof client?.statusAction !== 'function' ||
    txHandle === undefined
  ) {
    return false;
  }
  if (stmt.hasResultSet || (await outputFields(stmt)).length > 0) {
    return false;
  }
  const described = await inputParams(stmt);
  if (!described || described.length === 0) {
    return false;
  }
  const paramCount = described.length;
  for (const row of rows) {
    if (row.length !== paramCount) return false;
  }

  const textSet = new Set<number>();
  const blobCols: number[] = [];
  for (let i = 0; i < paramCount; i++) {
    const type = (described[i]?.type ?? 0) & ~1;
    if (type === SQL_BLOB) {
      blobCols.push(i);
      continue;
    }
    if (!TEXT_TYPES.has(type)) continue;
    let sawString = false;
    let sawDate = false;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'bigint') {
        sawString = true;
      } else if (v instanceof Date || (typeof v === 'object' && v !== null && 'date' in v)) {
        sawDate = true;
      }
    }
    if (sawString && sawDate) return false;
    if (sawString) textSet.add(i);
  }

  const textPositions = [...textSet].sort((a, b) => a - b);
  if (!(await useMessage(stmt, textPositions))) {
    return false;
  }

  const inMetadata = internal.inMetadata;
  const inBuffer = internal.inBuffer;
  const dataWriter = internal.dataWriter as
    | ((attachment: unknown, transaction: unknown, buffer: Uint8Array, values: unknown[]) => Promise<void>)
    | undefined;
  if (
    !inMetadata ||
    !inBuffer ||
    typeof inMetadata.getAlignedLengthSync !== 'function' ||
    typeof dataWriter !== 'function'
  ) {
    return false;
  }

  const hasBlobs = blobCols.length > 0;
  let totalBlobBytes = 0;
  const normalizedRows: unknown[][] = new Array(rows.length);
  const rowBlobs: (Buffer | null)[][] | undefined = hasBlobs ? new Array(rows.length) : undefined;

  for (let r = 0; r < rows.length; r++) {
    const src = rows[r]!;
    const dst = new Array<unknown>(paramCount);
    const blobsForRow = hasBlobs ? new Array<Buffer | null>(paramCount).fill(null) : undefined;
    for (let i = 0; i < paramCount; i++) {
      let v = src[i];
      if (v === undefined || v === null) {
        dst[i] = null;
        continue;
      }
      if (v instanceof ArrayBuffer) {
        v = Buffer.from(v);
      } else if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
        v = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      } else if (typeof v === 'bigint') {
        v = v.toString();
      }
      if (hasBlobs && (described[i]!.type & ~1) === SQL_BLOB) {
        if (typeof v === 'string') {
          const buf = Buffer.from(v, 'utf8');
          blobsForRow![i] = buf;
          totalBlobBytes += buf.byteLength;
          dst[i] = null;
          continue;
        }
        if (Buffer.isBuffer(v)) {
          blobsForRow![i] = v;
          totalBlobBytes += v.byteLength;
          dst[i] = null;
          continue;
        }
        return false;
      }
      if (textSet.has(i) && typeof v !== 'string') {
        v = String(v);
      }
      dst[i] = v;
    }
    normalizedRows[r] = dst;
    if (rowBlobs && blobsForRow) rowBlobs[r] = blobsForRow;
  }

  return client.statusAction(async (status) => {
    const stride = inMetadata.getAlignedLengthSync!(status);
    const msgLen = inMetadata.getMessageLengthSync(status);
    if (stride <= 0 || msgLen <= 0) return false;

    const blobOffsets = hasBlobs
      ? blobCols.map((col) => ({
          col,
          offset: inMetadata.getOffsetSync(status, col),
          nullOffset: inMetadata.getNullOffsetSync(status, col),
        }))
      : [];

    if (hasBlobs && typeof internal.statementHandle?.createBatchAsync === 'function') {
      // Verify addBlobAsync will be present on the batch below.
    }

    const needed = stride * rows.length + totalBlobBytes + 4096;
    let pb: NativeXpbBuilder | undefined;
    let parLength = 0;
    let parBuffer: unknown;

    try {
      pb = client.util?.getXpbBuilderSync?.(status, XPB_BATCH, undefined, 0);
      if (pb) {
        pb.insertIntSync(status, BATCH_TAG_RECORD_COUNTS, 1);
        if (hasBlobs) {
          pb.insertIntSync(status, BATCH_TAG_BLOB_POLICY, BATCH_BLOB_ID_ENGINE);
        }
        if (needed > 16 * 1024 * 1024) {
          pb.insertIntSync(
            status,
            BATCH_TAG_BUFFER_BYTES_SIZE,
            Math.min(256 * 1024 * 1024, needed),
          );
        }
        parLength = pb.getBufferLengthSync(status);
        parBuffer = pb.getBufferSync(status);
      } else {
        const bytes: number[] = [BATCH_VERSION1, BATCH_TAG_RECORD_COUNTS, 4, 1, 0, 0, 0];
        if (hasBlobs) {
          bytes.push(BATCH_TAG_BLOB_POLICY, 4, BATCH_BLOB_ID_ENGINE, 0, 0, 0);
        }
        const raw = new Uint8Array(bytes);
        parLength = raw.byteLength;
        parBuffer = raw;
      }

      let batch: NativeBatch | undefined;
      try {
        batch = await createBatchAsync.call(
          internal.statementHandle,
          status,
          inMetadata,
          parLength,
          parBuffer,
        );
      } catch {
        // Unsupported by server (e.g. Firebird 3) or client library: fall back to EXECUTE BLOCK.
        return false;
      }
      if (!batch) return false;
      if (hasBlobs && typeof batch.addBlobAsync !== 'function') {
        await batch.closeAsync(status).catch(() => undefined);
        return false;
      }

      try {
        const messages = new Uint8Array(stride * rows.length);
        const blobIdBuf = hasBlobs ? new Uint8Array(8) : undefined;

        for (let r = 0; r < rows.length; r++) {
          inBuffer.fill(0);
          await dataWriter(internal.attachment, transaction, inBuffer, normalizedRows[r]!);
          if (hasBlobs) {
            const blobsForRow = rowBlobs![r]!;
            for (const { col, offset, nullOffset } of blobOffsets) {
              const blobBytes = blobsForRow[col];
              if (!blobBytes) continue;
              blobIdBuf!.fill(0);
              await batch.addBlobAsync!(
                status,
                blobBytes.byteLength,
                blobBytes,
                blobIdBuf!,
                0,
                undefined,
              );
              inBuffer[nullOffset] = 0;
              inBuffer[nullOffset + 1] = 0;
              inBuffer.set(blobIdBuf!, offset);
            }
          }
          messages.set(inBuffer.subarray(0, msgLen), r * stride);
        }

        await batch.addAsync(status, rows.length, messages);
        const completion = await batch.executeAsync(status, txHandle);
        if (!completion) {
          throw new Error('IBatch.executeAsync returned no completion state');
        }
        try {
          const reported = completion.getSizeSync(status);
          for (let i = 0; i < reported; i++) {
            const state = completion.getStateSync(status, i);
            if (state === BATCH_EXECUTE_FAILED) {
              completion.getStatusSync(status, status, i);
              throw new Error(`IBatch execution failed at row ${i}`);
            }
          }
        } finally {
          completion.disposeSync();
        }
      } finally {
        await batch.closeAsync(status).catch(() => undefined);
      }
    } finally {
      pb?.disposeSync();
    }
    return true;
  });
}


/** Character sets by id, read once per connection. */
const charsetCache = new WeakMap<Attachment, Map<number, CharacterSet>>();

export async function characterSets(
  attachment: Attachment,
  transaction: Transaction,
): Promise<Map<number, CharacterSet>> {
  let charsets = charsetCache.get(attachment);
  if (!charsets) {
    const resultSet = await attachment.executeQuery(
      transaction,
      'SELECT RDB$CHARACTER_SET_ID, TRIM(RDB$CHARACTER_SET_NAME), RDB$BYTES_PER_CHARACTER FROM RDB$CHARACTER_SETS',
    );
    try {
      charsets = new Map();
      for (const [id, name, bytes] of (await resultSet.fetch()) as [number, string, number][]) {
        charsets.set(id, { name, bytesPerCharacter: bytes });
      }
    } finally {
      await resultSet.close().catch(() => undefined);
    }
    charsetCache.set(attachment, charsets);
  }
  return charsets;
}

/** Statement types (`isc_info_sql_stmt_*`) the cache keeps: plain DML, SELECT, procedures. */
const CACHEABLE_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 8, 12]);
/** `isc_info_sql_stmt_ddl`. */
const STMT_DDL = 5;

/** A statement handed out by {@link StatementCache.acquire}; release it once, when done. */
export interface StatementLease {
  stmt: Statement;
  cacheHit: boolean;
  /** `failed` drops a kept statement, in case it went stale. */
  release(failed: boolean): Promise<void>;
}

interface KeptStatement {
  stmt: Statement;
  busy: boolean;
  /** False once evicted or flushed while busy: disposed on release instead. */
  kept: boolean;
}

/**
 * Prepared statements kept per connection, keyed by their SQL text, the most
 * recently used last: what the WASM bridge does in C (`fb_statement_cache`),
 * for the Node backend, where every prepare is a round trip to the server.
 *
 * A Firebird statement belongs to the attachment, not to the transaction it
 * was prepared in, so a kept one runs in whichever transaction comes next.
 * Only SELECT, INSERT, UPDATE, DELETE and EXECUTE PROCEDURE / BLOCK are kept.
 * DDL is never kept, and empties the cache before it runs: a kept statement
 * makes this connection's `DROP TABLE` fail with "object in use", and keeps
 * running a procedure's old body after it is altered. A statement whose
 * execution fails is dropped. One busy with a call still running is not
 * handed to a second, concurrent call, which prepares its own.
 *
 * Size 0, the default, keeps nothing: each statement is prepared and disposed
 * as before, and its type is never asked for.
 */
export class StatementCache {
  private readonly kept = new Map<string, KeptStatement>();

  constructor(
    private readonly attachment: Attachment,
    private readonly size: number,
  ) {}

  get enabled(): boolean {
    return this.size > 0;
  }

  async acquire(transaction: Transaction, sql: string): Promise<StatementLease> {
    const hit = this.kept.get(sql);
    if (hit && !hit.busy) {
      // Most recently used last: a Map iterates in insertion order.
      this.kept.delete(sql);
      this.kept.set(sql, hit);
      hit.busy = true;
      return this.lease(hit, true);
    }

    const stmt = await this.attachment.prepare(transaction, sql);
    if (!this.enabled) {
      return { stmt, cacheHit: false, release: () => stmt.dispose().catch(() => undefined) };
    }

    const type = await stmt.type;
    if (type === STMT_DDL) await this.flush();

    const entry: KeptStatement = { stmt, busy: true, kept: false };
    if (!hit && CACHEABLE_TYPES.has(type)) {
      entry.kept = true;
      this.kept.set(sql, entry);
      await this.evictBeyondSize();
    }
    return this.lease(entry, false);
  }

  /** Dispose every kept statement; those still busy go when released. */
  async flush(): Promise<void> {
    const entries = [...this.kept.values()];
    this.kept.clear();
    for (const entry of entries) {
      entry.kept = false;
      if (!entry.busy) await entry.stmt.dispose().catch(() => undefined);
    }
  }

  private lease(entry: KeptStatement, cacheHit: boolean): StatementLease {
    return {
      stmt: entry.stmt,
      cacheHit,
      release: async (failed: boolean) => {
        entry.busy = false;
        if (entry.kept && failed) {
          entry.kept = false;
          for (const [sql, e] of this.kept) {
            if (e === entry) {
              this.kept.delete(sql);
              break;
            }
          }
        }
        if (!entry.kept) await entry.stmt.dispose().catch(() => undefined);
      },
    };
  }

  private async evictBeyondSize(): Promise<void> {
    for (const [sql, entry] of this.kept) {
      if (this.kept.size <= this.size) return;
      if (entry.busy) continue;
      this.kept.delete(sql);
      entry.kept = false;
      await entry.stmt.dispose().catch(() => undefined);
    }
  }
}

/**
 * Run a prepared statement and return its rows, positionally.
 *
 * A SELECT has a cursor and is fetched. `EXECUTE PROCEDURE` has output
 * columns but no cursor: it runs once, and its outputs are one row — run as
 * a plain execute, they were dropped (`query()` returned no rows), and
 * `executeQuery` refused it outright inside a transaction. Anything else
 * runs and returns nothing.
 */
export async function fetchRows(
  stmt: Statement,
  transaction: Transaction,
  params: QueryParams,
  fields: FieldInfo[],
  types?: TypeOptions,
): Promise<unknown[][]> {
  params = await bindParams(stmt, transaction, params);
  let rawRows: unknown[][];
  if (stmt.hasResultSet) {
    const resultSet = await stmt.executeQuery(transaction, params);
    // A failing fetch must still close.
    try {
      rawRows = await resultSet.fetch();
    } finally {
      await resultSet.close().catch(() => undefined);
    }
  } else if (fields.length > 0) {
    rawRows = [await stmt.executeSingleton(transaction, params)];
  } else {
    await stmt.execute(transaction, params);
    return [];
  }
  await resolveOutputRows(stmt, transaction, fields, rawRows, types);
  return rawRows;
}

/**
 * Stream a prepared statement's result set in batches of up to `batchSize` rows.
 */
export async function* streamRows<T>(
  stmt: Statement,
  transaction: Transaction,
  params: QueryParams,
  fields: FieldInfo[],
  rowMode: RowMode,
  batchSize: number,
  types: TypeOptions | undefined,
  onEngineError: () => void,
): AsyncIterableIterator<QueryResult<T>> {
  let boundParams: QueryParams;
  try {
    boundParams = await bindParams(stmt, transaction, params);
  } catch (err) {
    onEngineError();
    throw err;
  }

  if (stmt.hasResultSet) {
    let resultSet;
    try {
      resultSet = await stmt.executeQuery(transaction, boundParams);
    } catch (err) {
      onEngineError();
      throw err;
    }
    try {
      while (true) {
        let rawRows: unknown[][];
        try {
          rawRows = await resultSet.fetch({ fetchSize: batchSize });
          await resolveOutputRows(stmt, transaction, fields, rawRows, types);
        } catch (err) {
          onEngineError();
          throw err;
        }
        if (rawRows.length === 0) break;
        const batchFields = fields.map((f) => ({ ...f }));
        yield applyTypes(
          {
            rows: shapeRows<T>(rawRows, batchFields, rowMode),
            fields: batchFields,
          },
          types,
          rowMode,
        );
      }
    } finally {
      await resultSet.close().catch(() => undefined);
    }
    return;
  }

  if (fields.length > 0) {
    let rawRows: unknown[][];
    try {
      rawRows = [await stmt.executeSingleton(transaction, boundParams)];
      await resolveOutputRows(stmt, transaction, fields, rawRows, types);
    } catch (err) {
      onEngineError();
      throw err;
    }
    const batchFields = fields.map((f) => ({ ...f }));
    yield applyTypes(
      {
        rows: shapeRows<T>(rawRows, batchFields, rowMode),
        fields: batchFields,
      },
      types,
      rowMode,
    );
    return;
  }

  try {
    await stmt.execute(transaction, boundParams);
  } catch (err) {
    onEngineError();
    throw err;
  }
}

/**
 * The driver hands back positional rows, so array mode is the shape that
 * costs nothing — object mode is the one that builds.
 */
export function shapeRows<T>(rawRows: unknown[][], fields: FieldInfo[], rowMode: RowMode): T[] {
  return (
    rowMode === 'array'
      ? rawRows
      : rawRows.map((cols) => Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])))
  ) as T[];
}

export function buildTransactionOptions(
  options: TransactionOptions,
): NativeTransactionOptions {
  const isolationMap: Record<
    NonNullable<TransactionOptions['isolationLevel']>,
    TransactionIsolation
  > = {
    READ_COMMITTED: TransactionIsolation.READ_COMMITTED,
    SNAPSHOT: TransactionIsolation.SNAPSHOT,
    SNAPSHOT_TABLE_STABILITY: TransactionIsolation.CONSISTENCY,
  };

  return {
    isolation: options.isolationLevel
      ? isolationMap[options.isolationLevel]
      : undefined,
    accessMode: options.readOnly ? 'READ_ONLY' : undefined,
  };
}
