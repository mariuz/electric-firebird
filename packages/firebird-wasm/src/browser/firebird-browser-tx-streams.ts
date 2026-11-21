/**
 * firebird-browser-tx-streams.ts – Segmented BLOB & Cursor Streaming Helpers
 * for `FirebirdBrowserTransaction` (`M28 Item 5`).
 */

import type { EngineHandle, EngineTransport } from './engine-transport';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  isBlobHandle,
  resolveBlobColumnIndex,
  resolveBlobSegmentSize,
} from './blob-stream';
import { applyTypes, applySerializers, type TypeOptions } from './value-types';
import { resolveQueryCall, type SqlFragment, type Statement } from '../sql-tag';
import {
  assertNotAborted,
  createTimeoutError,
  runWithCancellation,
  validateTimeoutMs,
} from '../database-core';
import type {
  ArrayRow,
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  QueryDescription,
  QueryOptions,
  QueryParams,
  QueryResult,
  RowMode,
  StatementExecutionOptions,
} from '../types';

export interface BrowserTxStreamHost {
  readonly engine: EngineTransport;
  readonly dbHandle: EngineHandle;
  readonly txHandle: EngineHandle;
  readonly types: TypeOptions | undefined;
  readonly isFinished: boolean;
  assertUsable(): void;
  applyOneShotTimeout(timeoutMs: number | undefined): Promise<void>;
  cancelOperation(): Promise<void>;
  describeQuery(sql: string): Promise<QueryDescription>;
  queryArray(sql: string, params: QueryParams): Promise<QueryResult<ArrayRow>>;
  queryFull<T>(
    sql: string,
    params: QueryParams,
    options: QueryOptions<T>,
  ): Promise<QueryResult<T>>;
}

export async function createBrowserTxBlobStream(
  host: BrowserTxStreamHost,
  options: BlobStreamOptions = {},
): Promise<BlobWritableStream> {
  host.assertUsable();
  resolveBlobSegmentSize(options.segmentSize, true);

  if (
    typeof host.engine.blobCreate === 'function' &&
    typeof host.engine.blobPutSegment === 'function' &&
    typeof host.engine.blobClose === 'function'
  ) {
    const { blobHandle, blobId } = await host.engine.blobCreate(
      host.dbHandle,
      host.txHandle,
    );
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          host.assertUsable();
          await host.engine.blobPutSegment!(blobHandle, segment);
        },
        close: async (totalBytes) => {
          host.assertUsable();
          const finalId = await host.engine.blobClose!(blobHandle, false);
          return createBlobHandle(
            finalId.byteLength === 8 ? finalId : blobId,
            totalBytes,
          );
        },
        abort: async () => {
          if (!host.isFinished) {
            await host.engine.blobClose!(blobHandle, true).catch(() => undefined);
          }
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

export async function openBrowserTxBlobStream(
  host: BrowserTxStreamHost,
  sqlOrHandle: string | SqlFragment | BlobHandle,
  paramsOrOptions: QueryParams | BlobStreamOptions = [],
  maybeOptions: BlobStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  host.assertUsable();

  if (isBlobHandle(sqlOrHandle)) {
    const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
    resolveBlobSegmentSize(opts.segmentSize, false);
    const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
    if (staged || typeof host.engine.blobOpenId !== 'function') {
      const bytes = staged ?? new Uint8Array(0);
      let offset = 0;
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            host.assertUsable();
            if (offset >= bytes.byteLength) return null;
            const end = Math.min(offset + maxBytes, bytes.byteLength);
            const slice = bytes.slice(offset, end);
            offset = end;
            return slice;
          },
          close: async () => undefined,
        },
        opts,
      );
    }

    const blobHandle = await host.engine.blobOpenId(
      host.dbHandle,
      host.txHandle,
      sqlOrHandle.blobId,
    );
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          host.assertUsable();
          return host.engine.blobGetSegment!(blobHandle, maxBytes);
        },
        close: async () => {
          if (!host.isFinished) {
            await host.engine.blobClose!(blobHandle, false);
          }
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

  let colIndex = 0;
  if (options.column !== undefined) {
    const desc = await host.describeQuery(statement.sql);
    colIndex = resolveBlobColumnIndex(
      options.column,
      desc.fields.map((f) => f.name),
    );
  }

  if (
    typeof host.engine.blobOpenQuery === 'function' &&
    typeof host.engine.blobGetSegment === 'function' &&
    typeof host.engine.blobClose === 'function'
  ) {
    const blobHandle = await host.engine.blobOpenQuery(
      host.dbHandle,
      host.txHandle,
      statement.sql,
      applySerializers(statement.params, host.types?.serializers),
      colIndex,
    );
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          host.assertUsable();
          return host.engine.blobGetSegment!(blobHandle, maxBytes);
        },
        close: async () => {
          if (!host.isFinished) {
            await host.engine.blobClose!(blobHandle, false);
          }
        },
      },
      options,
    );
  }

  const res = await host.queryArray(statement.sql, statement.params);
  if (res.rows.length === 0) {
    throw new Error('openBlobStream: query returned no rows');
  }
  const cell = res.rows[0]![colIndex];
  if (cell === null || cell === undefined) {
    throw new Error('openBlobStream: BLOB column value is NULL');
  }
  const bytes =
    cell instanceof Uint8Array
      ? cell
      : typeof cell === 'string'
        ? new TextEncoder().encode(cell)
        : new Uint8Array(0);
  let offset = 0;
  return buildBlobReadableStream(
    {
      readSegment: async (maxBytes) => {
        host.assertUsable();
        if (offset >= bytes.byteLength) return null;
        const end = Math.min(offset + maxBytes, bytes.byteLength);
        const slice = bytes.slice(offset, end);
        offset = end;
        return slice;
      },
      close: async () => undefined,
    },
    options,
  );
}

export async function* streamBrowserTxQuery<T>(
  host: BrowserTxStreamHost,
  statement: Statement,
  rowMode: RowMode,
  batchSize: number,
  stmtHandle?: EngineHandle,
  execOptions: StatementExecutionOptions = {},
): AsyncIterableIterator<QueryResult<T>> {
  host.assertUsable();
  assertNotAborted(execOptions.signal);
  const totalTimeoutMs = validateTimeoutMs(execOptions.timeoutMs);
  const deadline =
    totalTimeoutMs && totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
  const stepOptions = (): StatementExecutionOptions => ({
    signal: execOptions.signal,
    timeoutMs: deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined,
  });

  if (
    typeof host.engine.cursorOpen !== 'function' ||
    typeof host.engine.cursorFetch !== 'function' ||
    typeof host.engine.cursorClose !== 'function'
  ) {
    const full = await host.queryFull<T>(statement.sql, statement.params, {
      rowMode,
      signal: execOptions.signal,
      timeoutMs: execOptions.timeoutMs,
    } as QueryOptions<T>);
    for (let i = 0; i < full.rows.length; i += batchSize) {
      assertNotAborted(execOptions.signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw createTimeoutError(totalTimeoutMs!);
      }
      yield {
        rows: full.rows.slice(i, i + batchSize),
        fields: full.fields.map((f) => ({ ...f })),
      };
    }
    return;
  }

  const binaryBlobs = host.types?.binary === true;
  const serialized = applySerializers(statement.params, host.types?.serializers);
  let cursorHandle = await runWithCancellation(
    async () => {
      await host.applyOneShotTimeout(totalTimeoutMs);
      return stmtHandle &&
        stmtHandle > 0 &&
        typeof host.engine.cursorOpenStmt === 'function'
        ? host.engine.cursorOpenStmt(
            host.dbHandle,
            host.txHandle,
            stmtHandle,
            serialized,
          )
        : host.engine.cursorOpen!(
            host.dbHandle,
            host.txHandle,
            statement.sql,
            serialized,
          );
    },
    stepOptions(),
    () => host.cancelOperation(),
  );

  try {
    while (true) {
      host.assertUsable();
      assertNotAborted(execOptions.signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw createTimeoutError(totalTimeoutMs!);
      }
      const batch = await runWithCancellation(
        () =>
          host.engine.cursorFetch!<T>(
            cursorHandle,
            batchSize,
            rowMode,
            binaryBlobs,
          ),
        stepOptions(),
        () => host.cancelOperation(),
      );
      if (batch.rows.length === 0) {
        break;
      }
      yield applyTypes(batch, host.types, rowMode);
    }

    const toClose = cursorHandle;
    cursorHandle = 0;
    if (!host.isFinished) {
      await host.engine.cursorClose(toClose);
    }
  } finally {
    if (cursorHandle !== 0) {
      await host.engine.cursorClose(cursorHandle).catch(() => undefined);
    }
  }
}
