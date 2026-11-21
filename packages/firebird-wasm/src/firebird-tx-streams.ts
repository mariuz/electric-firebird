/**
 * firebird-tx-streams.ts – Segmented BLOB & Cursor Streaming Helpers
 * for Node.js `FirebirdTransaction` (`M28 Item 5`).
 */

import { Blob as FbBlob } from 'node-firebird-driver';
import type { Attachment, Transaction } from 'node-firebird-driver';
import type {
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  FieldInfo,
  QueryParams,
  QueryResult,
  RowMode,
  StatementExecutionOptions,
} from './types';
import type { TypeOptions } from './browser/value-types';
import {
  assertNotAborted,
  createTimeoutError,
  validateTimeoutMs,
} from './database-core';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobSegmentSize,
} from './browser/blob-stream';
import { resolveQueryCall, type SqlFragment, type Statement as ParsedStatement } from './sql-tag';
import {
  StatementCache,
  applyStatementHandleTimeout,
  openNativeQueryBlobStream,
  outputFields,
  streamRows,
} from './node-native-bindings';

export interface NodeTxStreamHost {
  readonly attachment: Attachment;
  readonly transaction: Transaction;
  readonly statements: StatementCache;
  readonly types: TypeOptions | undefined;
  assertUsable(): void;
  beforeStatement(): Promise<void>;
  serialize(params: QueryParams): QueryParams;
}

export async function createNodeTxBlobStream(
  host: NodeTxStreamHost,
  options: BlobStreamOptions = {},
): Promise<BlobWritableStream> {
  host.assertUsable();
  await host.beforeStatement();
  resolveBlobSegmentSize(options.segmentSize, true);

  if (typeof host.attachment.createBlob === 'function') {
    const stream = await host.attachment.createBlob(host.transaction);
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          host.assertUsable();
          const buf = Buffer.from(
            segment.buffer,
            segment.byteOffset,
            segment.byteLength,
          );
          await stream.write(buf);
        },
        close: async (totalBytes) => {
          host.assertUsable();
          await stream.close();
          const nativeBlob = stream.blob;
          const idBytes =
            nativeBlob?.id instanceof Uint8Array
              ? new Uint8Array(
                  nativeBlob.id.buffer,
                  nativeBlob.id.byteOffset,
                  nativeBlob.id.byteLength,
                )
              : new Uint8Array(8);
          return createBlobHandle(idBytes, totalBytes, { nativeBlob });
        },
        abort: async () => {
          await stream.cancel().catch(() => undefined);
        },
      },
      options,
    );
  }

  const chunks: Uint8Array[] = [];
  return buildBlobWritableStream(
    {
      writeSegment: async (segment) => {
        host.assertUsable();
        chunks.push(segment.slice());
      },
      close: async (totalBytes) => {
        host.assertUsable();
        const stagedBytes = new Uint8Array(totalBytes);
        let pos = 0;
        for (const c of chunks) {
          stagedBytes.set(c, pos);
          pos += c.byteLength;
        }
        return createBlobHandle(new Uint8Array(8), totalBytes, { stagedBytes });
      },
      abort: async () => {
        chunks.length = 0;
      },
    },
    options,
  );
}

export async function openNodeTxBlobStream(
  host: NodeTxStreamHost,
  sqlOrHandle: string | SqlFragment | BlobHandle,
  paramsOrOptions: QueryParams | BlobStreamOptions = [],
  maybeOptions: BlobStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  host.assertUsable();
  await host.beforeStatement();

  if (isBlobHandle(sqlOrHandle)) {
    const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
    resolveBlobSegmentSize(opts.segmentSize, false);
    const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
    if (staged) {
      let offset = 0;
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            host.assertUsable();
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

    const fbBlob =
      ((sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.nativeBlob as FbBlob | undefined) ??
      new FbBlob(host.attachment, sqlOrHandle.blobId);
    const stream = await host.attachment.openBlob(host.transaction, fbBlob);
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          host.assertUsable();
          const buf = Buffer.alloc(maxBytes);
          const n = await stream.read(buf);
          if (n < 0) return null;
          return new Uint8Array(buf.buffer, buf.byteOffset, n);
        },
        close: async () => {
          await stream.close().catch(() => undefined);
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

  return openNativeQueryBlobStream(
    host.attachment,
    host.transaction,
    host.statements,
    statement.sql,
    host.serialize(statement.params),
    options,
    false,
    () => host.assertUsable(),
  );
}

export async function* streamNodeTxQuery<T>(
  host: NodeTxStreamHost,
  statement: ParsedStatement,
  rowMode: RowMode,
  batchSize: number,
  options: StatementExecutionOptions = {},
): AsyncIterableIterator<QueryResult<T>> {
  host.assertUsable();
  assertNotAborted(options.signal);
  const totalTimeoutMs = validateTimeoutMs(options.timeoutMs);
  const deadline =
    totalTimeoutMs && totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
  const checkStreamDeadline = (): void => {
    assertNotAborted(options.signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw createTimeoutError(totalTimeoutMs!);
    }
  };
  await host.beforeStatement();

  const serialized = host.serialize(statement.params);
  let engineFailed = false;
  const lease = await host.statements.acquire(host.transaction, statement.sql);
  const stmt = lease.stmt;

  try {
    let fields: FieldInfo[];
    try {
      fields = await outputFields(stmt);
      if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
        await applyStatementHandleTimeout(stmt, totalTimeoutMs);
      }
    } catch (err) {
      engineFailed = true;
      throw err;
    }

    for await (const batch of streamRows<T>(
      stmt,
      host.transaction,
      serialized,
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
  } finally {
    if (totalTimeoutMs !== undefined && totalTimeoutMs > 0 && !engineFailed) {
      await applyStatementHandleTimeout(stmt, 0).catch(() => undefined);
    }
    await lease.release(engineFailed);
  }
}
