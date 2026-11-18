/**
 * firebird-streams.ts – Prepared statements, BLOB streams, copy-on-write snapshots,
 * and file streaming helpers for Node.js `FirebirdLite` (`M22 Item 5`).
 */

import * as fs from 'fs';
import { Blob as FbBlob } from 'node-firebird-driver';
import type { Attachment, Client, Statement, Transaction } from 'node-firebird-driver';
import type {
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  DatabaseInfo,
  DataStreamOptions,
  FieldInfo,
  PreparedStatement,
  QueryOptions,
  QueryParams,
  QueryResult,
  QueryStreamOptions,
  Row,
  RowMode,
  StatementExecutionOptions,
} from './types';
import {
  DATABASE_INFO_REQUEST_ITEMS,
  normalizeDatabaseInfo,
  parseDatabaseInfoBuffer,
} from './browser/engine-transport';
import { statementKind } from './statement-types';
import {
  compressGzipStream,
  readDatabaseStreamChunks,
  resolveStreamChunkSize,
} from './browser/data-stream';
import { applyTypes, type TypeOptions } from './browser/value-types';
import {
  type DatabaseSnapshot,
  type SnapshotOptions,
  CowSnapshotStore,
} from './browser/snapshots';
import {
  assertNotAborted,
  createTimeoutError,
  runWithCancellation,
  validateTimeoutMs,
} from './database-core';
import {
  assertBatchParameterRows,
  assertPreparedParamCount,
  finalizeQueryResultWithSchema,
  resolvePreparedCallArgs,
} from './shared-driver-ops';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobSegmentSize,
} from './browser/blob-stream';
import { resolveBatchSize, resolveQueryCall, toStatement, type SqlFragment } from './sql-tag';
import {
  StatementCache,
  applyStatementHandleTimeout,
  bindParams,
  buildTransactionOptions,
  describeInputFields,
  fetchRows,
  openNativeQueryBlobStream,
  outputFields,
  readAffectedRecords,
  shapeRows,
  streamRows,
  tryExecuteNativeBatch,
} from './node-native-bindings';

export interface NodeStreamHost {
  ensureReady(): Promise<void>;
  isClosed(): boolean;
  readonly dbPath: string;
  getClient(): Client | null;
  readonly connectOptions: { username?: string; password?: string; charSetForNONE?: string };
  readonly statementCacheSize: number;
  readonly types: TypeOptions | undefined;
  readonly snapshotStore: CowSnapshotStore;
  readonly preparedStatements: Set<PreparedStatement>;
  getAttachment(): Attachment;
  setAttachmentAndCache(attachment: Attachment | null, statements: StatementCache | null): void;
  getStatements(): StatementCache | null;
  endReadTransaction(): Promise<void>;
  serialize(params: QueryParams): QueryParams;
  cancelOperation(): Promise<void>;
}

export async function createNodePreparedStatement(
  host: NodeStreamHost,
  sql: string | SqlFragment,
): Promise<PreparedStatement> {
  await host.ensureReady();
  const attachment = host.getAttachment();
  const sqlText = toStatement(sql).sql;

  const prepareTx = await attachment.startTransaction();
  let nativeStmt: Statement;
  let params: FieldInfo[];
  let fields: FieldInfo[];
  let type: number;
  try {
    nativeStmt = await attachment.prepare(prepareTx, sqlText);
    try {
      params = await describeInputFields(nativeStmt);
      fields = await outputFields(nativeStmt);
      type = await nativeStmt.type;
    } catch (err) {
      await nativeStmt.dispose().catch(() => undefined);
      throw err;
    }
  } finally {
    await prepareTx.commit().catch(() => undefined);
  }

  const statementType = statementKind(type);
  const hasResultSet = nativeStmt.hasResultSet;
  let isClosed = false;
  let busy = false;
  let currentTimeoutMs = 0;

  const assertOpen = (): void => {
    if (isClosed || host.isClosed()) {
      throw new Error('PreparedStatement has been closed');
    }
  };

  const checkParamCount = (actual: number): void => {
    assertPreparedParamCount(params.length, actual);
  };

  const withStatement = async <R>(
    transaction: Transaction,
    fn: (target: Statement) => Promise<R>,
  ): Promise<R> => {
    if (!busy) {
      busy = true;
      try {
        return await fn(nativeStmt);
      } finally {
        busy = false;
        if (isClosed) {
          await nativeStmt.dispose().catch(() => undefined);
        }
      }
    }
    const tempStmt = await attachment.prepare(transaction, sqlText);
    try {
      if (currentTimeoutMs > 0) {
        await applyStatementHandleTimeout(tempStmt, currentTimeoutMs);
      }
      return await fn(tempStmt);
    } finally {
      await tempStmt.dispose().catch(() => undefined);
    }
  };

  const stmt: PreparedStatement = {
    sql: sqlText,
    get params() {
      return params.map((p) => ({ ...p }));
    },
    get fields() {
      return fields.map((f) => ({ ...f }));
    },
    statementType,
    hasResultSet,
    get closed() {
      return isClosed || host.isClosed();
    },
    get timeoutMs() {
      return currentTimeoutMs;
    },
    setTimeout: async (timeoutMs: number) => {
      assertOpen();
      const validated = validateTimeoutMs(timeoutMs) ?? 0;
      currentTimeoutMs = validated;
      await applyStatementHandleTimeout(nativeStmt, validated);
    },
    query: (async <T = Row>(
      paramsOrOptions: QueryParams | QueryOptions<T> = [],
      maybeOptions: QueryOptions<T> = {},
    ): Promise<QueryResult<T>> => {
      assertOpen();
      const { callParams, rawOptions, callOptions } = resolvePreparedCallArgs<QueryOptions<T>>(
        paramsOrOptions,
        maybeOptions,
        currentTimeoutMs,
      );
      checkParamCount(callParams.length);
      assertNotAborted(callOptions.signal);
      validateTimeoutMs(callOptions.timeoutMs);
      const rowMode: RowMode = callOptions.rowMode ?? 'object';
      const serializedParams = host.serialize(callParams);
      await host.endReadTransaction();
      const txOptions = buildTransactionOptions(callOptions);
      const transaction = await attachment.startTransaction(txOptions);
      try {
        const rawRows = await withStatement(transaction, async (target) => {
          const hasPerCallTimeout =
            rawOptions.timeoutMs !== undefined && rawOptions.timeoutMs !== currentTimeoutMs;
          if (hasPerCallTimeout) {
            await applyStatementHandleTimeout(target, rawOptions.timeoutMs);
          }
          try {
            return await runWithCancellation(
              () => fetchRows(target, transaction, serializedParams, fields, host.types),
              callOptions,
              () => host.cancelOperation(),
            );
          } finally {
            if (hasPerCallTimeout && target === nativeStmt) {
              await applyStatementHandleTimeout(target, currentTimeoutMs).catch(() => undefined);
            }
          }
        });
        try {
          await transaction.commit();
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
        const outFields = fields.map((f) => ({ ...f }));
        return finalizeQueryResultWithSchema(
          applyTypes(
            { rows: shapeRows<T>(rawRows, outFields, rowMode), fields: outFields },
            host.types,
            rowMode,
          ),
          callOptions.schema,
          rowMode,
        );
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    }) as PreparedStatement['query'],
    queryStream: (<T = Row>(
      paramsOrOptions: QueryParams | QueryStreamOptions = [],
      maybeOptions: QueryStreamOptions = {},
    ): AsyncIterableIterator<QueryResult<T>> => {
      assertOpen();
      const callParams = Array.isArray(paramsOrOptions) ? paramsOrOptions : [];
      const rawOptions = Array.isArray(paramsOrOptions)
        ? maybeOptions
        : (paramsOrOptions ?? {});
      const callOptions: QueryStreamOptions =
        rawOptions.timeoutMs === undefined && currentTimeoutMs > 0
          ? { ...rawOptions, timeoutMs: currentTimeoutMs }
          : rawOptions;
      checkParamCount(callParams.length);
      validateTimeoutMs(callOptions.timeoutMs);
      const batchSize = resolveBatchSize(callOptions.batchSize);
      const rowMode: RowMode = callOptions.rowMode ?? 'object';

      return (async function* (): AsyncIterableIterator<QueryResult<T>> {
        assertOpen();
        assertNotAborted(callOptions.signal);
        const totalTimeoutMs = validateTimeoutMs(callOptions.timeoutMs);
        const deadline =
          totalTimeoutMs && totalTimeoutMs > 0
            ? Date.now() + totalTimeoutMs
            : undefined;
        const checkStreamDeadline = (): void => {
          assertNotAborted(callOptions.signal);
          if (deadline !== undefined && Date.now() >= deadline) {
            throw createTimeoutError(totalTimeoutMs!);
          }
        };

        const serializedParams = host.serialize(callParams);
        await host.endReadTransaction();
        const txOptions = buildTransactionOptions(callOptions);
        const transaction = await attachment.startTransaction(txOptions);

        let engineFailed = false;
        let txFinished = false;
        let claimedPrimary = false;
        let tempStmt: Statement | undefined;

        try {
          let target: Statement;
          if (!busy) {
            busy = true;
            claimedPrimary = true;
            target = nativeStmt;
          } else {
            try {
              tempStmt = await attachment.prepare(transaction, sqlText);
            } catch (err) {
              engineFailed = true;
              throw err;
            }
            target = tempStmt;
          }

          if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
            await applyStatementHandleTimeout(target, totalTimeoutMs);
          }

          for await (const batch of streamRows<T>(
            target,
            transaction,
            serializedParams,
            fields,
            rowMode,
            batchSize,
            host.types,
            () => {
              engineFailed = true;
            },
          )) {
            checkStreamDeadline();
            yield batch;
            checkStreamDeadline();
          }

          if (claimedPrimary && totalTimeoutMs !== undefined && totalTimeoutMs !== currentTimeoutMs) {
            await applyStatementHandleTimeout(nativeStmt, currentTimeoutMs).catch(() => undefined);
          }

          if (tempStmt) {
            const toDispose = tempStmt;
            tempStmt = undefined;
            await toDispose.dispose().catch(() => undefined);
          }
          if (claimedPrimary) {
            claimedPrimary = false;
            busy = false;
            if (isClosed) {
              await nativeStmt.dispose().catch(() => undefined);
            }
          }

          txFinished = true;
          try {
            await transaction.commit();
          } catch (err) {
            await transaction.rollback().catch(() => undefined);
            throw err;
          }
        } finally {
          if (tempStmt) {
            await tempStmt.dispose().catch(() => undefined);
          }
          if (claimedPrimary) {
            busy = false;
            if (isClosed) {
              await nativeStmt.dispose().catch(() => undefined);
            }
          }
          if (!txFinished) {
            if (engineFailed) {
              await transaction.rollback().catch(() => undefined);
            } else {
              await transaction
                .commit()
                .catch(() => transaction.rollback().catch(() => undefined));
            }
          }
        }
      })();
    }) as PreparedStatement['queryStream'],
    exec: async (
      callParams: QueryParams = [],
      execOptions: StatementExecutionOptions = {},
    ) => {
      assertOpen();
      checkParamCount(callParams.length);
      const effectiveOptions: StatementExecutionOptions =
        execOptions.timeoutMs === undefined && currentTimeoutMs > 0
          ? { ...execOptions, timeoutMs: currentTimeoutMs }
          : execOptions;
      assertNotAborted(effectiveOptions.signal);
      validateTimeoutMs(effectiveOptions.timeoutMs);
      const serializedParams = host.serialize(callParams);
      await host.endReadTransaction();
      const transaction = await attachment.startTransaction();
      try {
        const affectedRows = await withStatement(transaction, async (target) => {
          const hasPerCallTimeout =
            execOptions.timeoutMs !== undefined && execOptions.timeoutMs !== currentTimeoutMs;
          if (hasPerCallTimeout) {
            await applyStatementHandleTimeout(target, execOptions.timeoutMs);
          }
          try {
            await runWithCancellation(
              async () => {
                await target.execute(
                  transaction,
                  await bindParams(target, transaction, serializedParams),
                );
              },
              effectiveOptions,
              () => host.cancelOperation(),
            );
            return readAffectedRecords(target);
          } finally {
            if (hasPerCallTimeout && target === nativeStmt) {
              await applyStatementHandleTimeout(target, currentTimeoutMs).catch(() => undefined);
            }
          }
        });
        try {
          await transaction.commit();
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
        return { affectedRows };
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    },
    execBatch: async (rows: QueryParams[]) => {
      assertOpen();
      assertBatchParameterRows(rows, params.length);
      if (rows.length === 0) return { affectedRows: 0 };
      const serializedRows = host.types?.serializers?.length
        ? rows.map((row) => host.serialize(row))
        : rows;
      await host.endReadTransaction();
      const transaction = await attachment.startTransaction();
      try {
        const affectedRows = await withStatement(transaction, async (target) => {
          if (
            serializedRows.length > 1 &&
            (await tryExecuteNativeBatch(target, transaction, serializedRows))
          ) {
            return serializedRows.length;
          }
          let total = 0;
          for (const row of serializedRows) {
            await target.execute(
              transaction,
              await bindParams(target, transaction, row),
            );
            total += (await readAffectedRecords(target)) || 1;
          }
          return total;
        });
        try {
          await transaction.commit();
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
        return { affectedRows };
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    },
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      host.preparedStatements.delete(stmt);
      if (!busy) {
        await nativeStmt.dispose().catch(() => undefined);
      }
    },
    [Symbol.asyncDispose]: async () => {
      await stmt.close();
    },
  };

  host.preparedStatements.add(stmt);
  return stmt;
}

export async function createNodeBlobStream(
  ensureReady: () => Promise<void>,
  options: BlobStreamOptions = {},
): Promise<BlobWritableStream> {
  await ensureReady();
  resolveBlobSegmentSize(options.segmentSize, true);

  const chunks: Uint8Array[] = [];
  return buildBlobWritableStream(
    {
      writeSegment: async (segment) => {
        chunks.push(segment.slice());
      },
      close: async (totalBytes) => {
        const stagedBytes = new Uint8Array(totalBytes);
        let pos = 0;
        for (const c of chunks) {
          stagedBytes.set(c, pos);
          pos += c.byteLength;
        }
        return createBlobHandle(new Uint8Array(8), totalBytes, {
          stagedBytes,
        });
      },
      abort: async () => {
        chunks.length = 0;
      },
    },
    options,
  );
}

export async function openNodeBlobStream(
  host: NodeStreamHost,
  sqlOrHandle: string | SqlFragment | BlobHandle,
  paramsOrOptions: QueryParams | BlobStreamOptions = [],
  maybeOptions: BlobStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  await host.ensureReady();
  const attachment = host.getAttachment();

  if (isBlobHandle(sqlOrHandle)) {
    const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
    resolveBlobSegmentSize(opts.segmentSize, false);
    const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
    if (staged) {
      let offset = 0;
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            if (offset >= staged.byteLength) return null;
            const end = Math.min(offset + maxBytes, staged.byteLength);
            const slice = staged.slice(offset, end);
            offset = end;
            return slice;
          },
          close: async () => undefined,
        },
        opts,
      );
    }

    await host.endReadTransaction();
    const tx = await attachment.startTransaction(
      buildTransactionOptions({ isolationLevel: 'READ_COMMITTED', readOnly: true }),
    );
    const fbBlob =
      ((sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.nativeBlob as FbBlob | undefined) ??
      new FbBlob(attachment, sqlOrHandle.blobId);
    let stream: Awaited<ReturnType<Attachment['openBlob']>>;
    try {
      stream = await attachment.openBlob(tx, fbBlob);
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }

    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          const buf = Buffer.alloc(maxBytes);
          const n = await stream.read(buf);
          if (n < 0) return null;
          return new Uint8Array(buf.buffer, buf.byteOffset, n);
        },
        close: async () => {
          await stream.close().catch(() => undefined);
          await tx.commit().catch(() => tx.rollback().catch(() => undefined));
        },
      },
      opts,
    );
  }

  const { statement, options } = resolveQueryCall<BlobStreamOptions>(
    sqlOrHandle,
    paramsOrOptions,
    maybeOptions,
  );
  resolveBlobSegmentSize(options.segmentSize, false);
  await host.endReadTransaction();

  const tx = await attachment.startTransaction(
    buildTransactionOptions({ isolationLevel: 'READ_COMMITTED', readOnly: true }),
  );
  try {
    return await openNativeQueryBlobStream(
      attachment,
      tx,
      host.getStatements()!,
      statement.sql,
      host.serialize(statement.params),
      options,
      true,
    );
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  }
}

async function detachNodeAttachment(host: NodeStreamHost): Promise<void> {
  await host.endReadTransaction();
  for (const stmt of [...host.preparedStatements]) {
    await stmt.close().catch(() => undefined);
  }
  const stmts = host.getStatements();
  await stmts?.flush();
  let attachment: Attachment | null = null;
  try {
    attachment = host.getAttachment();
  } catch {
    attachment = null;
  }
  host.setAttachmentAndCache(null, null);
  if (attachment) {
    await attachment.disconnect().catch(() => undefined);
  }
}

async function reattachNodeAttachment(host: NodeStreamHost): Promise<void> {
  const attachment = await host.getClient()!.connect(host.dbPath, host.connectOptions);
  const statements = new StatementCache(attachment, host.statementCacheSize);
  host.setAttachmentAndCache(attachment, statements);
}

export async function captureNodeSnapshot(
  host: NodeStreamHost,
  labelOrOptions?: string | SnapshotOptions,
): Promise<DatabaseSnapshot> {
  if (host.isClosed()) {
    throw new Error('FirebirdLite instance has been closed');
  }
  await host.ensureReady();
  await detachNodeAttachment(host);
  try {
    const buf = await fs.promises.readFile(host.dbPath);
    const image = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return host.snapshotStore.createSnapshot(image, labelOrOptions);
  } finally {
    await reattachNodeAttachment(host);
  }
}

export async function restoreNodeSnapshot(
  host: NodeStreamHost,
  snapshotOrId: DatabaseSnapshot | string | Uint8Array,
): Promise<void> {
  if (host.isClosed()) {
    throw new Error('FirebirdLite instance has been closed');
  }
  await host.ensureReady();
  const bytes =
    snapshotOrId instanceof Uint8Array
      ? snapshotOrId
      : host.snapshotStore.getSnapshot(snapshotOrId).toUint8Array();

  await detachNodeAttachment(host);
  await fs.promises.writeFile(host.dbPath, bytes);
  await reattachNodeAttachment(host);
}

export function createNodeDumpDataStream(
  ensureReady: () => Promise<void>,
  dbPath: string,
  options: DataStreamOptions = {},
): ReadableStream<Uint8Array> {
  const chunkSize = resolveStreamChunkSize(options.chunkSize);
  let handle: fs.promises.FileHandle | null = null;
  let totalSize = 0;
  let offset = 0;

  const closeHandle = async (): Promise<void> => {
    if (handle) {
      const h = handle;
      handle = null;
      await h.close().catch(() => undefined);
    }
  };

  const raw = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        await ensureReady();
        if (!handle) {
          handle = await fs.promises.open(dbPath, 'r');
          const stat = await handle.stat();
          totalSize = stat.size;
        }
        if (offset >= totalSize) {
          await closeHandle();
          controller.close();
          return;
        }
        const toRead = Math.min(chunkSize, totalSize - offset);
        const buf = new Uint8Array(toRead);
        const { bytesRead } = await handle.read(buf, 0, toRead, offset);
        if (bytesRead <= 0) {
          await closeHandle();
          controller.close();
          return;
        }
        offset += bytesRead;
        controller.enqueue(bytesRead === toRead ? buf : buf.slice(0, bytesRead));
        if (offset >= totalSize) {
          await closeHandle();
          controller.close();
        }
      } catch (err) {
        await closeHandle();
        throw err;
      }
    },
    cancel: async () => {
      await closeHandle();
    },
  });

  return options.compression === 'gzip' ? compressGzipStream(raw) : raw;
}

export async function runNodeLoadDataStream(
  host: NodeStreamHost,
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DataStreamOptions = {},
): Promise<void> {
  if (host.isClosed()) {
    throw new Error('FirebirdLite instance has been closed');
  }
  await host.ensureReady();
  await detachNodeAttachment(host);

  const handle = await fs.promises.open(host.dbPath, 'w');
  let offset = 0;
  try {
    for await (const chunk of readDatabaseStreamChunks(stream, options)) {
      await handle.write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (offset === 0) {
    throw new RangeError(
      'loadDataStream received an empty stream; pass a stream from dumpDataStream()',
    );
  }

  await reattachNodeAttachment(host);
}

export async function readNodeDatabaseInfo(
  rawAttachment: unknown,
  queryFn: (sql: string) => Promise<QueryResult<Record<string, unknown>>>,
): Promise<DatabaseInfo> {
  const attachment = rawAttachment as {
    attachmentHandle?: {
      getInfoAsync?: (
        status: unknown,
        itemsLength: number,
        items: Uint8Array,
        bufferLength: number,
        buffer: Uint8Array,
      ) => Promise<void>;
      getInfoSync?: (
        status: unknown,
        itemsLength: number,
        items: Uint8Array,
        bufferLength: number,
        buffer: Uint8Array,
      ) => void;
    };
    client?: {
      statusAction?: <T>(fn: (status: unknown) => Promise<T>) => Promise<T>;
    };
  };

  const client = attachment?.client;
  const getInfoAsync = attachment?.attachmentHandle?.getInfoAsync;
  const getInfoSync = attachment?.attachmentHandle?.getInfoSync;

  if (typeof client?.statusAction === 'function' && typeof getInfoAsync === 'function') {
    return client.statusAction(async (status) => {
      const buffer = new Uint8Array(512);
      await getInfoAsync.call(
        attachment.attachmentHandle,
        status,
        DATABASE_INFO_REQUEST_ITEMS.byteLength,
        DATABASE_INFO_REQUEST_ITEMS,
        buffer.byteLength,
        buffer,
      );
      return parseDatabaseInfoBuffer(buffer);
    });
  }
  if (typeof client?.statusAction === 'function' && typeof getInfoSync === 'function') {
    return client.statusAction(async (status) => {
      const buffer = new Uint8Array(512);
      getInfoSync.call(
        attachment.attachmentHandle,
        status,
        DATABASE_INFO_REQUEST_ITEMS.byteLength,
        DATABASE_INFO_REQUEST_ITEMS,
        buffer.byteLength,
        buffer,
      );
      return parseDatabaseInfoBuffer(buffer);
    });
  }

  const dbRes = await queryFn(
    'SELECT MON$PAGE_SIZE, MON$PAGES, MON$ODS_MAJOR, MON$ODS_MINOR, ' +
      'MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$OLDEST_SNAPSHOT, ' +
      'MON$NEXT_TRANSACTION, MON$PAGE_BUFFERS FROM MON$DATABASE',
  );
  const dbRow = dbRes.rows[0] ?? {};
  let currentMemory = 0;
  let maxMemory = 0;
  let reads = 0;
  let writes = 0;
  let fetches = 0;
  let marks = 0;
  try {
    const memRes = await queryFn(
      'SELECT MON$MEMORY_USED, MON$MEMORY_MAX_USED FROM MON$MEMORY_USAGE WHERE MON$STAT_GROUP = 0',
    );
    const memRow = memRes.rows[0] ?? {};
    currentMemory = Number(memRow['MON$MEMORY_USED'] ?? 0);
    maxMemory = Number(memRow['MON$MEMORY_MAX_USED'] ?? 0);
  } catch {
    // Optional monitoring table
  }
  try {
    const ioRes = await queryFn(
      'SELECT MON$PAGE_READS, MON$PAGE_WRITES, MON$PAGE_FETCHES, MON$PAGE_MARKS FROM MON$IO_STATS WHERE MON$STAT_GROUP = 0',
    );
    const ioRow = ioRes.rows[0] ?? {};
    reads = Number(ioRow['MON$PAGE_READS'] ?? 0);
    writes = Number(ioRow['MON$PAGE_WRITES'] ?? 0);
    fetches = Number(ioRow['MON$PAGE_FETCHES'] ?? 0);
    marks = Number(ioRow['MON$PAGE_MARKS'] ?? 0);
  } catch {
    // Optional monitoring table
  }
  return normalizeDatabaseInfo({
    pageSize: Number(dbRow['MON$PAGE_SIZE'] ?? 0),
    allocatedPages: Number(dbRow['MON$PAGES'] ?? 0),
    odsVersion: Number(dbRow['MON$ODS_MAJOR'] ?? 0),
    odsMinorVersion: Number(dbRow['MON$ODS_MINOR'] ?? 0),
    oldestTransaction: Number(dbRow['MON$OLDEST_TRANSACTION'] ?? 0),
    oldestActive: Number(dbRow['MON$OLDEST_ACTIVE'] ?? 0),
    oldestSnapshot: Number(dbRow['MON$OLDEST_SNAPSHOT'] ?? 0),
    nextTransaction: Number(dbRow['MON$NEXT_TRANSACTION'] ?? 0),
    currentMemory,
    maxMemory,
    pageBuffers: Number(dbRow['MON$PAGE_BUFFERS'] ?? 0),
    reads,
    writes,
    fetches,
    marks,
  });
}
