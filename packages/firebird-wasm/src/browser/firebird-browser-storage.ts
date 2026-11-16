/**
 * firebird-browser-storage.ts – BLOB streams, copy-on-write snapshots, page diffs,
 * file streams (`dumpDataStream`/`loadDataStream`), and ICU locale loading for
 * `FirebirdBrowser` (`M22 Item 5`).
 */

import type { EngineHandle, EngineTransport } from './engine-transport';
import {
  compressGzipStream,
  readDatabaseStreamChunks,
  resolveStreamChunkSize,
} from './data-stream';
import {
  type ApplyPageDiffOptions,
  type DatabaseSnapshot,
  type PageDiffOptions,
  type SnapshotOptions,
  CowSnapshotStore,
} from './snapshots';
import { ICU_LOCALE_DATA_PATH, isValidIcuDataPackage } from './icu-locales';
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
import { resolveQueryCall, type SqlFragment } from '../sql-tag';
import { runDriverApplyDiff, runDriverExportDiff } from '../shared-driver-ops';
import type {
  ArrayRow,
  BlobHandle,
  BlobStreamOptions,
  BlobWritableStream,
  DataStreamOptions,
  PreparedStatement,
  QueryDescription,
  QueryParams,
  QueryResult,
} from '../types';

export interface BrowserStorageHost {
  ensureReady(): Promise<void>;
  isClosed(): boolean;
  readonly engine: EngineTransport;
  getDbPath(): string;
  readonly sharedReads: boolean | undefined;
  readonly snapshotStore: CowSnapshotStore;
  readonly preparedStatements: Set<PreparedStatement>;
  readonly liveTriggerPromises: Map<string, Promise<string>>;
  readonly liveQueries: Set<{ unsubscribe(): Promise<void> }>;
  getDbHandle(): EngineHandle;
  setDbHandle(handle: EngineHandle): void;
  cancelScheduledPersist(): void;
  markDirty(): void;
  serialize(params: QueryParams): QueryParams;
  describeQuery(sql: string | SqlFragment): Promise<QueryDescription>;
  queryArray(sql: string, params: QueryParams): Promise<QueryResult<ArrayRow>>;
}

export async function createBrowserBlobStream(
  host: BrowserStorageHost,
  options: BlobStreamOptions = {},
): Promise<BlobWritableStream> {
  await host.ensureReady();
  resolveBlobSegmentSize(options.segmentSize, true);

  if (
    typeof host.engine.blobCreate === 'function' &&
    typeof host.engine.blobPutSegment === 'function' &&
    typeof host.engine.blobClose === 'function'
  ) {
    const { blobHandle, blobId } = await host.engine.blobCreate(
      host.getDbHandle(),
      0,
    );
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          await host.engine.blobPutSegment!(blobHandle, segment);
        },
        close: async (totalBytes) => {
          const finalId = await host.engine.blobClose!(blobHandle, false);
          return createBlobHandle(
            finalId.byteLength === 8 ? finalId : blobId,
            totalBytes,
          );
        },
        abort: async () => {
          await host.engine
            .blobClose!(blobHandle, true)
            .catch(() => undefined);
        },
      },
      options,
    );
  }

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

export async function openBrowserBlobStream(
  host: BrowserStorageHost,
  sqlOrHandle: string | SqlFragment | BlobHandle,
  paramsOrOptions: QueryParams | BlobStreamOptions = [],
  maybeOptions: BlobStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  await host.ensureReady();

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
      host.getDbHandle(),
      0,
      sqlOrHandle.blobId,
    );
    return buildBlobReadableStream(
      {
        readSegment: (maxBytes) =>
          host.engine.blobGetSegment!(blobHandle, maxBytes),
        close: async () => {
          await host.engine.blobClose!(blobHandle, false);
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
      host.getDbHandle(),
      0,
      statement.sql,
      host.serialize(statement.params),
      colIndex,
    );
    return buildBlobReadableStream(
      {
        readSegment: (maxBytes) =>
          host.engine.blobGetSegment!(blobHandle, maxBytes),
        close: async () => {
          await host.engine.blobClose!(blobHandle, false);
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

export async function readBrowserDetachedImage(
  host: BrowserStorageHost,
): Promise<Uint8Array> {
  const current = host.getDbHandle();
  if (current) {
    await host.engine.detachDatabase(current);
    host.setDbHandle(0);
  }
  try {
    return await host.engine.readFile(host.getDbPath());
  } finally {
    const next = await host.engine.attachDatabase(host.getDbPath());
    host.setDbHandle(next);
    if (host.sharedReads) {
      await host.engine.setSharedReads!(next, true);
    }
  }
}

export async function captureBrowserSnapshot(
  host: BrowserStorageHost,
  labelOrOptions?: string | SnapshotOptions,
): Promise<DatabaseSnapshot> {
  if (host.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  await host.ensureReady();
  const image = await readBrowserDetachedImage(host);
  return host.snapshotStore.createSnapshot(image, labelOrOptions);
}

export async function restoreBrowserSnapshot(
  host: BrowserStorageHost,
  snapshotOrId: DatabaseSnapshot | string | Uint8Array,
): Promise<void> {
  if (host.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  await host.ensureReady();
  const bytes =
    snapshotOrId instanceof Uint8Array
      ? snapshotOrId
      : host.snapshotStore.getSnapshot(snapshotOrId).toUint8Array();

  host.cancelScheduledPersist();
  for (const stmt of [...host.preparedStatements]) {
    await stmt.close().catch(() => undefined);
  }
  host.liveTriggerPromises.clear();

  const current = host.getDbHandle();
  if (current) {
    await host.engine.detachDatabase(current);
    host.setDbHandle(0);
  }

  await host.engine.writeFile(host.getDbPath(), bytes);
  const next = await host.engine.attachDatabase(host.getDbPath());
  host.setDbHandle(next);
  if (host.sharedReads) {
    await host.engine.setSharedReads!(next, true);
  }
  host.markDirty();

  for (const live of [...host.liveQueries]) {
    const refreshable = live as { refresh?: () => Promise<void> };
    if (typeof refreshable.refresh === 'function') {
      await refreshable.refresh().catch(() => undefined);
    }
  }
}

export async function exportBrowserDiff(
  host: BrowserStorageHost,
  fromSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
  toSnapshot?: DatabaseSnapshot | string | Uint8Array,
  options?: PageDiffOptions,
): Promise<Uint8Array> {
  if (host.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  await host.ensureReady();
  return runDriverExportDiff(
    host.snapshotStore,
    () => readBrowserDetachedImage(host),
    fromSnapshot,
    toSnapshot,
    options,
  );
}

export async function applyBrowserDiff(
  host: BrowserStorageHost,
  diffBytes: Uint8Array,
  baseSnapshot?: DatabaseSnapshot | string | Uint8Array | null,
  options: ApplyPageDiffOptions = {},
): Promise<Uint8Array> {
  if (host.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  await host.ensureReady();
  return runDriverApplyDiff(
    host.snapshotStore,
    () => readBrowserDetachedImage(host),
    (bytes) => restoreBrowserSnapshot(host, bytes),
    diffBytes,
    baseSnapshot,
    options,
  );
}

export function createBrowserDumpDataStream(
  host: BrowserStorageHost,
  options: DataStreamOptions = {},
): ReadableStream<Uint8Array> {
  const chunkSize = resolveStreamChunkSize(options.chunkSize);
  let offset = 0;
  let totalSize: number | null = null;
  let fallbackBytes: Uint8Array | null = null;

  const raw = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      await host.ensureReady();
      if (totalSize === null) {
        if (
          typeof host.engine.fileSize === 'function' &&
          typeof host.engine.readFileChunk === 'function'
        ) {
          totalSize = await host.engine.fileSize(host.getDbPath());
        } else {
          fallbackBytes = await host.engine.readFile(host.getDbPath());
          totalSize = fallbackBytes.byteLength;
        }
      }
      if (offset >= totalSize) {
        controller.close();
        return;
      }
      const length = Math.min(chunkSize, totalSize - offset);
      const chunk = fallbackBytes
        ? fallbackBytes.slice(offset, offset + length)
        : await host.engine.readFileChunk!(host.getDbPath(), offset, length);
      if (chunk.byteLength === 0) {
        controller.close();
        return;
      }
      offset += chunk.byteLength;
      controller.enqueue(chunk);
      if (offset >= totalSize) {
        controller.close();
      }
    },
  });

  return options.compression === 'gzip' ? compressGzipStream(raw) : raw;
}

export async function writeBrowserStreamToDbPath(
  engine: EngineTransport,
  dbPath: string,
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DataStreamOptions = {},
): Promise<void> {
  let offset = 0;
  let first = true;
  if (typeof engine.writeFileChunk === 'function') {
    for await (const chunk of readDatabaseStreamChunks(stream, options)) {
      await engine.writeFileChunk(dbPath, chunk, offset, first);
      first = false;
      offset += chunk.byteLength;
    }
  } else {
    const chunks: Uint8Array[] = [];
    for await (const chunk of readDatabaseStreamChunks(stream, options)) {
      chunks.push(chunk);
      offset += chunk.byteLength;
    }
    if (offset > 0) {
      const merged = new Uint8Array(offset);
      let pos = 0;
      for (const c of chunks) {
        merged.set(c, pos);
        pos += c.byteLength;
      }
      await engine.writeFile(dbPath, merged);
    }
  }
  if (offset === 0) {
    throw new RangeError(
      'loadDataStream received an empty stream; pass a stream from dumpDataStream()',
    );
  }
}

export async function runBrowserLoadDataStream(
  host: BrowserStorageHost,
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DataStreamOptions = {},
): Promise<void> {
  if (host.isClosed()) {
    throw new Error('FirebirdBrowser instance has been closed');
  }
  await host.ensureReady();
  host.cancelScheduledPersist();

  for (const stmt of [...host.preparedStatements]) {
    await stmt.close().catch(() => undefined);
  }
  host.liveTriggerPromises.clear();

  const current = host.getDbHandle();
  if (current) {
    await host.engine.detachDatabase(current);
    host.setDbHandle(0);
  }

  await writeBrowserStreamToDbPath(host.engine, host.getDbPath(), stream, options);

  const next = await host.engine.attachDatabase(host.getDbPath());
  host.setDbHandle(next);
  if (host.sharedReads) {
    await host.engine.setSharedReads!(next, true);
  }
  host.markDirty();
}

export async function applyBrowserIcuLocaleData(
  engine: EngineTransport,
  data: Uint8Array | ArrayBufferLike,
): Promise<void> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (engine.loadIcuLocaleData) {
    await engine.loadIcuLocaleData(bytes);
    return;
  }
  if (!isValidIcuDataPackage(bytes)) {
    throw new Error(
      'Invalid ICU locale data package: expected an ICU CmnD (.dat) header (magic 0xda 0x27)',
    );
  }
  await engine.mkdir('/firebird');
  await engine.mkdir('/firebird/icu');
  await engine.writeFile(ICU_LOCALE_DATA_PATH, bytes);
}

export async function setBrowserReplicaMode(
  host: BrowserStorageHost,
  queryReplicaMode: () => Promise<string | null>,
  mode: 'none' | 'read_only' | 'read_write' | 0 | 1 | 2 = 'read_write',
): Promise<void> {
  await host.ensureReady();
  const modeCode: 0 | 1 | 2 =
    mode === 0 || mode === 'none'
      ? 0
      : mode === 1 || mode === 'read_only'
        ? 1
        : 2;
  const expectedContext =
    modeCode === 0 ? null : modeCode === 1 ? 'READ-ONLY' : 'READ-WRITE';

  for (const stmt of [...host.preparedStatements]) {
    await stmt.close().catch(() => undefined);
  }

  if (typeof host.engine.setReplicaMode === 'function') {
    try {
      await host.engine.setReplicaMode(host.getDbHandle(), modeCode);
    } catch {
      // Fall through to ODS header page update if DPB/bridge call is unsupported
    }
  }

  let currentMode: string | null = null;
  try {
    currentMode = await queryReplicaMode();
  } catch {
    currentMode = expectedContext;
  }

  if (currentMode !== expectedContext) {
    const dbPath = host.getDbPath();
    const cur = host.getDbHandle();
    if (cur) {
      await host.engine.detachDatabase(cur);
      host.setDbHandle(0);
    }
    try {
      if (typeof host.engine.writeFileChunk === 'function') {
        await host.engine.writeFileChunk(
          dbPath,
          new Uint8Array([modeCode]),
          26,
          false,
        );
      } else {
        const rawBytes = await host.engine.readFile(dbPath);
        if (rawBytes.byteLength >= 152) {
          const copy = rawBytes.slice();
          copy[26] = modeCode;
          await host.engine.writeFile(dbPath, copy);
        }
      }
    } finally {
      const next = await host.engine.attachDatabase(dbPath);
      host.setDbHandle(next);
      if (host.sharedReads) {
        await host.engine.setSharedReads!(next, true);
      }
    }
  }

  host.markDirty();
}

export async function openBrowserDatabaseFile(params: {
  engine: EngineTransport;
  dbPath: string;
  mayPersist: boolean;
  exportStored: () => Promise<Uint8Array>;
  loadDataDir?: Uint8Array;
  loadDataStream?:
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array>
    | (() =>
        | ReadableStream<Uint8Array>
        | AsyncIterable<Uint8Array>
        | Promise<ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>);
  sharedReads?: boolean;
}): Promise<EngineHandle> {
  const { engine, dbPath, mayPersist, exportStored, loadDataDir, loadDataStream, sharedReads } =
    params;
  await engine.mkdir('/data');

  if (mayPersist) {
    const stored = await exportStored();
    if (stored.byteLength > 0) {
      await engine.writeFile(dbPath, stored);
    }
  }

  if (loadDataDir && !(await engine.exists(dbPath))) {
    if (loadDataDir.byteLength === 0) {
      throw new RangeError(
        'loadDataDir is empty; pass the bytes from dumpDataDir() or omit it',
      );
    }
    await engine.writeFile(dbPath, loadDataDir);
  }

  if (loadDataStream && !(await engine.exists(dbPath))) {
    const seedStream =
      typeof loadDataStream === 'function'
        ? await loadDataStream()
        : loadDataStream;
    await writeBrowserStreamToDbPath(engine, dbPath, seedStream);
  }

  const handle = (await engine.exists(dbPath))
    ? await engine.attachDatabase(dbPath)
    : await engine.createDatabase(dbPath);

  if (sharedReads) {
    await engine.setSharedReads!(handle, true);
  }
  return handle;
}
