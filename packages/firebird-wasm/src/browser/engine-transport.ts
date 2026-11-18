/**
 * engine-transport.ts – DirectTransport implementation over the Firebird WASM C ABI.
 * Types live in wasm-abi-types.ts; result/info decoders live in result-decoder.ts (`M21 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import { acquireFirebirdWasm, releaseFirebirdWasm, allocString } from '../wasm-loader';
import type {
  Row,
  QueryResult,
  QueryDescription,
  DatabaseInfo,
  SweepResult,
  FieldInfo,
  QueryParams,
  RowMode,
  TransactionOptions,
} from '../types';
import { isolationCode } from './isolation';
import { encodeParams, encodeParamRows } from './params';
import {
  isWireParamRowsBuffer,
  isWireParamsBuffer,
  wireParamRowsToCAbi,
  wireParamsToCAbi,
} from './wire-params';
import type {
  EnginePipelineStepRequest,
  EnginePipelineStepResponse,
  EnginePipelineWireOptions,
} from '../pipeline';
import { DirectBlobSubsystem, type DirectBlobHost } from './direct-blob-ops';
import {
  decodeBinaryResultSet,
  encodeBinaryResultSet,
  BINARY_HEADER_HAS_SHAPE_ID,
  type BinaryResultPayload,
} from './binary-result';
import { applyIcuLocaleDataToModule } from './icu-locales';
import {
  OPFS_MOUNT,
  type EngineHandle,
  type EngineTransport,
  type DirectTransportOptions,
} from './wasm-abi-types';
import {
  fsExists,
  fsFileSize,
  fsMkdir,
  fsReadFile,
  fsReadFileChunk,
  fsUnlink,
  fsWriteFile,
  fsWriteFileChunk,
  mountOpfsDatabase,
  unmountOpfsDatabase,
  type OpfsSyncHandleLike,
} from './opfs-chunk-io';
import {
  engineError,
  toFields,
  MAX_FIELD_LISTS,
  rowBuilder,
  decodeResultSet,
  DATABASE_INFO_REQUEST_ITEMS,
  parseDatabaseInfoBuffer,
  normalizeDatabaseInfo,
  decodeDatabaseInfo,
  buildSweepResult,
  decodeDescription,
  BLOB_SIDE_CHANNEL,
  SHAPE_IDS,
  readBlobs,
  attachBlobs,
  fallbackExplainQuery,
  fallbackReadDatabaseInfo,
  type EncodedColumn,
} from './result-decoder';

export {
  OPFS_MOUNT,
  decodeBinaryResultSet,
  encodeBinaryResultSet,
  decodeResultSet,
  DATABASE_INFO_REQUEST_ITEMS,
  parseDatabaseInfoBuffer,
  normalizeDatabaseInfo,
  decodeDatabaseInfo,
  buildSweepResult,
  decodeDescription,
  BLOB_SIDE_CHANNEL,
  SHAPE_IDS,
  attachBlobs,
};
export type {
  EngineHandle,
  EngineTransport,
  DirectTransportOptions,
  BinaryResultPayload,
};

// ---------------------------------------------------------------------------
// DirectTransport
// ---------------------------------------------------------------------------

/**
 * Calls the engine in the current thread.
 *
 * Used by Node, by the Worker (which is where a browser's engine actually
 * runs), and by tests that install a stub `createFirebirdModule`.
 */
export class DirectTransport implements EngineTransport {
  private mod: FirebirdWasmModule | null = null;
  private initPromise: Promise<void> | null = null;
  /** The OPFS database this transport mounted, closed on dispose. */
  private opfsHandle: OpfsSyncHandleLike | null = null;
  /** What each shape id of this module's engine means (see SHAPE_IDS). */
  private readonly shapes = new Map<number, readonly FieldInfo[]>();
  /** Fallback cursor state when running against an older WASM artifact without `_fb_cursor_open`. */
  private readonly fallbackCursors = new Map<
    EngineHandle,
    { fields: FieldInfo[]; rows: unknown[][]; offset: number }
  >();
  private nextFallbackCursor = 1;
  private readonly blobOps = new DirectBlobSubsystem();
  private readonly preparedStatements = new Map<
    EngineHandle,
    { dbHandle: EngineHandle; sql: string; native: boolean }
  >();
  private nextFallbackStmtHandle = 1_000_000;

  /**
   * The fields of shape `id`: remembered, or asked of the engine once. Called
   * while decoding, right after the query that named the id and before any
   * other engine call, when the statement holding that shape is the cache's
   * most recently used and still kept.
   */
  private readonly shapeColumns = (id: number): readonly FieldInfo[] => {
    const known = this.shapes.get(id);
    if (known) return known;

    const mod = this.module;
    const ptr = mod._fb_shape_columns(id);
    if (ptr === 0) {
      throw engineError(mod, `Firebird returned rows of a shape it no longer has (${id})`);
    }
    let parsed: { columns: EncodedColumn[] };
    try {
      parsed = JSON.parse(mod.UTF8ToString(ptr)) as { columns: EncodedColumn[] };
    } finally {
      mod._fb_free_result(ptr);
    }
    const fields = toFields(parsed.columns);
    if (this.shapes.size >= MAX_FIELD_LISTS) this.shapes.clear();
    this.shapes.set(id, fields);
    return fields;
  };

  readonly acceptsWireParams = true;

  constructor(private readonly options: DirectTransportOptions = {}) {}

  async init(): Promise<void> {
    // Concurrent first calls must not each load the module.
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  async loadIcuLocaleData(data: Uint8Array): Promise<void> {
    await this.init();
    await applyIcuLocaleDataToModule(this.module, data);
  }

  private async doInit(): Promise<void> {
    this.mod = await acquireFirebirdWasm({
      wasmBinary: this.options.wasmBinary,
      locateFile: this.options.locateFile,
      threads: this.options.threads,
    });

    const rc = this.mod._fb_init();
    if (rc !== 0) {
      throw engineError(this.mod, 'Failed to initialise the Firebird engine', rc);
    }
  }

  private get module(): FirebirdWasmModule {
    if (!this.mod) {
      throw new Error('EngineTransport used before init()');
    }
    return this.mod;
  }

  /** Run `fn` with `str` allocated on the WASM heap, freeing it afterwards. */
  private withString<T>(str: string, fn: (ptr: number) => T): T {
    const mod = this.module;
    const ptr = allocString(mod, str);
    try {
      return fn(ptr);
    } finally {
      mod._free(ptr);
    }
  }

  async createDatabase(path: string): Promise<EngineHandle> {
    const mod = this.module;
    const handle = this.withString(path, (p) => mod._fb_create_database(p));
    if (handle === 0) {
      throw engineError(mod, `Failed to create database "${path}"`);
    }
    return handle;
  }

  async attachDatabase(path: string): Promise<EngineHandle> {
    const mod = this.module;
    const handle = this.withString(path, (p) => mod._fb_attach_database(p));
    if (handle === 0) {
      throw engineError(mod, `Failed to open database "${path}"`);
    }
    return handle;
  }

  async detachDatabase(dbHandle: EngineHandle): Promise<void> {
    for (const [stmtHandle, entry] of this.preparedStatements) {
      if (entry.dbHandle === dbHandle) {
        this.preparedStatements.delete(stmtHandle);
      }
    }
    this.module._fb_detach_database(dbHandle);
  }

  /**
   * Run `fn` with the packed parameters on the WASM heap.
   *
   * An empty list is passed as a null pointer rather than an empty buffer, so
   * the C side takes its "no parameters" path and skips preparing an input
   * message it would not use.
   */
  private withParams<T>(
    params: QueryParams | Uint8Array,
    fn: (ptr: number, length: number) => T,
  ): T {
    if (!params) {
      return fn(0, 0);
    }
    if (isWireParamsBuffer(params)) {
      const view = new DataView(params.buffer, params.byteOffset, params.byteLength);
      if (view.getUint32(4, true) === 0) {
        return fn(0, 0);
      }
      const mod = this.module;
      const packed = wireParamsToCAbi(params);
      const ptr = mod._malloc(packed.length);
      try {
        mod.HEAPU8.set(packed, ptr);
        return fn(ptr, packed.length);
      } finally {
        mod._free(ptr);
      }
    }
    if (params.length === 0) {
      return fn(0, 0);
    }

    const mod = this.module;
    const resolved = this.resolveStagedBlobParams(params);
    const packed = encodeParams(resolved);
    const ptr = mod._malloc(packed.length);
    try {
      mod.HEAPU8.set(packed, ptr);
      return fn(ptr, packed.length);
    } finally {
      mod._free(ptr);
    }
  }

  async execute(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams | Uint8Array = [],
  ): Promise<number> {
    const mod = this.module;
    const rc = this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) =>
        paramLen === 0
          ? mod._fb_execute(dbHandle, txHandle, sqlPtr)
          : mod._fb_execute_params(dbHandle, txHandle, sqlPtr, paramPtr, paramLen),
      ),
    );
    if (rc !== 0) {
      throw engineError(mod, `Firebird exec failed for: ${sql}`, rc);
    }
    return mod._fb_last_affected_rows();
  }

  async executeBatch(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    rows: QueryParams[] | Uint8Array,
  ): Promise<number> {
    const mod = this.module;
    let packed: Uint8Array;
    if (isWireParamRowsBuffer(rows)) {
      const view = new DataView(rows.buffer, rows.byteOffset, rows.byteLength);
      if (view.getUint32(4, true) === 0) return 0;
      packed = wireParamRowsToCAbi(rows);
    } else {
      if (rows.length === 0) return 0;
      const resolvedRows = rows.map((row) => this.resolveStagedBlobParams(row));
      packed = encodeParamRows(resolvedRows);
    }
    const ptr = mod._malloc(packed.length);
    let rc: number;
    try {
      mod.HEAPU8.set(packed, ptr);
      rc = this.withString(sql, (sqlPtr) =>
        mod._fb_execute_batch(dbHandle, txHandle, sqlPtr, ptr, packed.length),
      );
    } finally {
      mod._free(ptr);
    }
    if (rc !== 0) {
      throw engineError(mod, `Firebird batch failed for: ${sql}`, rc);
    }
    return mod._fb_last_affected_rows();
  }

  async query<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams | Uint8Array = [],
    rowMode: RowMode = 'object',
    binaryBlobs = false,
  ): Promise<QueryResult<T>> {
    const mod = this.module;
    const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
    return this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) => {
      if (typeof mod._fb_query_binary === 'function') {
        const lenPtr = mod._malloc(4);
        let binPtr = 0;
        try {
          binPtr = mod._fb_query_binary(
            dbHandle,
            txHandle,
            sqlPtr,
            paramPtr,
            paramLen,
            flags,
            lenPtr,
          );
          if (binPtr === 0) {
            throw engineError(mod, `Firebird query failed for: ${sql}`);
          }
          const lenView = new DataView(
            mod.HEAPU8.buffer,
            mod.HEAPU8.byteOffset + lenPtr,
            4,
          );
          const byteLen = lenView.getUint32(0, true);
          const view = mod.HEAPU8.subarray(binPtr, binPtr + byteLen);
          return decodeBinaryResultSet<T>(
            view,
            rowMode,
            binaryBlobs,
            this.shapeColumns,
          );
        } finally {
          if (binPtr !== 0) {
            mod._fb_free_result(binPtr);
          }
          mod._free(lenPtr);
        }
      }
      const resultPtr =
        paramLen === 0
          ? mod._fb_query(dbHandle, txHandle, sqlPtr, flags)
          : mod._fb_query_params(
              dbHandle,
              txHandle,
              sqlPtr,
              paramPtr,
              paramLen,
              flags,
            );
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird query failed for: ${sql}`);
      }

      // The engine owns the buffer until fb_free_result.
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);

      // Read before anything else can run: the side buffer belongs to the
      // engine and the next query replaces it.
      const blobs = binaryBlobs ? readBlobs(mod) : null;

      const result = decodeResultSet<T>(json, rowMode, this.shapeColumns);
      return blobs ? attachBlobs(result, blobs, rowMode) : result;
      }),
    );
  }

  private extractBinaryPayload(
    mod: FirebirdWasmModule,
    binPtr: number,
    byteLen: number,
  ): BinaryResultPayload {
    const binaryResult = new Uint8Array(byteLen);
    binaryResult.set(mod.HEAPU8.subarray(binPtr, binPtr + byteLen));
    if (
      byteLen >= 9 &&
      (binaryResult[4]! & BINARY_HEADER_HAS_SHAPE_ID) !== 0
    ) {
      const view = new DataView(
        binaryResult.buffer,
        binaryResult.byteOffset,
        binaryResult.byteLength,
      );
      const shapeId = view.getUint32(5, true);
      const shapeFields = this.shapeColumns(shapeId);
      return { binaryResult, shapeId, shapeFields };
    }
    return { binaryResult };
  }

  async queryBinary(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams | Uint8Array = [],
    binaryBlobs = false,
  ): Promise<BinaryResultPayload> {
    const mod = this.module;
    if (typeof mod._fb_query_binary === 'function') {
      const queryBinaryFn = mod._fb_query_binary;
      const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
      return this.withString(sql, (sqlPtr) =>
        this.withParams(params, (paramPtr, paramLen) => {
          const lenPtr = mod._malloc(4);
          let binPtr = 0;
          try {
            binPtr = queryBinaryFn.call(
              mod,
              dbHandle,
              txHandle,
              sqlPtr,
              paramPtr,
              paramLen,
              flags,
              lenPtr,
            );
            if (binPtr === 0) {
              throw engineError(mod, `Firebird query failed for: ${sql}`);
            }
            const lenView = new DataView(
              mod.HEAPU8.buffer,
              mod.HEAPU8.byteOffset + lenPtr,
              4,
            );
            const byteLen = lenView.getUint32(0, true);
            return this.extractBinaryPayload(mod, binPtr, byteLen);
          } finally {
            if (binPtr !== 0) {
              mod._fb_free_result(binPtr);
            }
            mod._free(lenPtr);
          }
        }),
      );
    }

    const decoded = await this.query<unknown[]>(
      dbHandle,
      txHandle,
      sql,
      params,
      'array',
      binaryBlobs,
    );
    return {
      binaryResult: encodeBinaryResultSet(decoded, { rowMode: 'array' }),
    };
  }

  async cursorOpen(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams | Uint8Array = [],
  ): Promise<EngineHandle> {
    const mod = this.module;
    if (typeof mod._fb_cursor_open !== 'function') {
      const full = await this.query<unknown[]>(
        dbHandle,
        txHandle,
        sql,
        params,
        'array',
        true,
      );
      const handle = this.nextFallbackCursor++;
      this.fallbackCursors.set(handle, {
        fields: full.fields,
        rows: full.rows,
        offset: 0,
      });
      return handle;
    }

    const openFn = mod._fb_cursor_open;
    const handle = this.withString(sql, (sqlPtr) =>
      this.withParams(params, (paramPtr, paramLen) =>
        openFn.call(mod, dbHandle, txHandle, sqlPtr, paramPtr, paramLen),
      ),
    );
    if (handle === 0) {
      throw engineError(mod, `Firebird cursor open failed for: ${sql}`);
    }
    return handle;
  }

  async cursorFetch<T = Row>(
    cursorHandle: EngineHandle,
    batchSize: number,
    rowMode: RowMode = 'object',
    binaryBlobs = false,
  ): Promise<QueryResult<T>> {
    const mod = this.module;
    if (typeof mod._fb_cursor_fetch_binary === 'function') {
      const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
      const lenPtr = mod._malloc(4);
      let binPtr = 0;
      try {
        binPtr = mod._fb_cursor_fetch_binary(
          cursorHandle,
          batchSize,
          flags,
          lenPtr,
        );
        if (binPtr === 0) {
          throw engineError(mod, 'Firebird cursor fetch failed');
        }
        const lenView = new DataView(
          mod.HEAPU8.buffer,
          mod.HEAPU8.byteOffset + lenPtr,
          4,
        );
        const byteLen = lenView.getUint32(0, true);
        const view = mod.HEAPU8.subarray(binPtr, binPtr + byteLen);
        return decodeBinaryResultSet<T>(
          view,
          rowMode,
          binaryBlobs,
          this.shapeColumns,
        );
      } finally {
        if (binPtr !== 0) {
          mod._fb_free_result(binPtr);
        }
        mod._free(lenPtr);
      }
    }
    if (typeof mod._fb_cursor_fetch !== 'function') {
      const entry = this.fallbackCursors.get(cursorHandle);
      if (!entry) {
        throw new Error('Firebird cursor fetch failed: unknown cursor handle');
      }
      const fields = entry.fields.map((f) => ({ ...f }));
      const slice = entry.rows.slice(entry.offset, entry.offset + batchSize);
      entry.offset += slice.length;
      if (rowMode === 'array') {
        return { rows: slice.map((r) => [...r]) as T[], fields };
      }
      const names = fields.map((f) => f.name);
      const build = rowBuilder(names);
      const rows = (
        build
          ? slice.map(build)
          : slice.map((cols) =>
              Object.fromEntries(names.map((name, i) => [name, cols[i]])),
            )
      ) as T[];
      return { rows, fields };
    }

    const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
    const resultPtr = mod._fb_cursor_fetch(cursorHandle, batchSize, flags);
    if (resultPtr === 0) {
      throw engineError(mod, 'Firebird cursor fetch failed');
    }

    const json = mod.UTF8ToString(resultPtr);
    mod._fb_free_result(resultPtr);

    const blobs = binaryBlobs ? readBlobs(mod) : null;
    const result = decodeResultSet<T>(json, rowMode, this.shapeColumns);
    return blobs ? attachBlobs(result, blobs, rowMode) : result;
  }

  async cursorFetchBinary(
    cursorHandle: EngineHandle,
    batchSize: number,
    binaryBlobs = false,
  ): Promise<BinaryResultPayload> {
    const mod = this.module;
    if (typeof mod._fb_cursor_fetch_binary === 'function') {
      const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
      const lenPtr = mod._malloc(4);
      let binPtr = 0;
      try {
        binPtr = mod._fb_cursor_fetch_binary(
          cursorHandle,
          batchSize,
          flags,
          lenPtr,
        );
        if (binPtr === 0) {
          throw engineError(mod, 'Firebird cursor fetch failed');
        }
        const lenView = new DataView(
          mod.HEAPU8.buffer,
          mod.HEAPU8.byteOffset + lenPtr,
          4,
        );
        const byteLen = lenView.getUint32(0, true);
        return this.extractBinaryPayload(mod, binPtr, byteLen);
      } finally {
        if (binPtr !== 0) {
          mod._fb_free_result(binPtr);
        }
        mod._free(lenPtr);
      }
    }

    const decoded = await this.cursorFetch<unknown[]>(
      cursorHandle,
      batchSize,
      'array',
      binaryBlobs,
    );
    return {
      binaryResult: encodeBinaryResultSet(decoded, { rowMode: 'array' }),
    };
  }

  async cursorClose(cursorHandle: EngineHandle): Promise<void> {
    const mod = this.module;
    if (typeof mod._fb_cursor_close !== 'function') {
      if (!this.fallbackCursors.delete(cursorHandle)) {
        throw new Error('Firebird cursor close failed: unknown cursor handle');
      }
      return;
    }

    const rc = mod._fb_cursor_close(cursorHandle);
    if (rc !== 0) {
      throw engineError(mod, 'Firebird cursor close failed', rc);
    }
  }

  private get blobHost(): DirectBlobHost {
    return {
      getModule: () => this.module,
      withString: (s, fn) => this.withString(s, fn),
      withParams: (p, fn) => this.withParams(p, fn),
      describe: (d, t, s) => this.describe(d, t, s),
      queryArray: (d, t, s, p) => this.query<unknown[]>(d, t, s, p, 'array', true),
    };
  }

  private resolveStagedBlobParams(params: QueryParams): QueryParams {
    return this.blobOps.resolveStagedBlobParams(params);
  }

  blobCreate(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
  ): Promise<{ blobHandle: EngineHandle; blobId: Uint8Array }> {
    return this.blobOps.blobCreate(this.blobHost, dbHandle, txHandle);
  }

  blobPutSegment(blobHandle: EngineHandle, segment: Uint8Array): Promise<void> {
    return this.blobOps.blobPutSegment(this.blobHost, blobHandle, segment);
  }

  blobOpenId(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    blobId: Uint8Array,
  ): Promise<EngineHandle> {
    return this.blobOps.blobOpenId(this.blobHost, dbHandle, txHandle, blobId);
  }

  blobOpenQuery(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
    colIndex = 0,
  ): Promise<EngineHandle> {
    return this.blobOps.blobOpenQuery(this.blobHost, dbHandle, txHandle, sql, params, colIndex);
  }

  blobGetSegment(blobHandle: EngineHandle, maxLength: number): Promise<Uint8Array | null> {
    return this.blobOps.blobGetSegment(this.blobHost, blobHandle, maxLength);
  }

  blobClose(blobHandle: EngineHandle, cancel = false): Promise<Uint8Array> {
    return this.blobOps.blobClose(this.blobHost, blobHandle, cancel);
  }

  async setSharedReads(dbHandle: EngineHandle, on: boolean): Promise<void> {
    const mod = this.module;
    if (mod._fb_read_transaction(dbHandle, on ? 1 : 0) < 0) {
      throw engineError(mod, 'Firebird could not change shared reads');
    }
  }

  async describe(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription> {
    const mod = this.module;
    return this.withString(sql, (sqlPtr) => {
      const resultPtr = mod._fb_describe(dbHandle, txHandle, sqlPtr);
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird could not describe: ${sql}`);
      }

      // Same ownership rule as a result set: the engine owns it until freed.
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);

      return decodeDescription(json);
    });
  }

  async prepare(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
  ): Promise<QueryDescription & { handle?: EngineHandle }> {
    const mod = this.module;
    if (typeof mod._fb_prepare !== 'function') {
      const desc = await this.describe(dbHandle, txHandle, sql);
      const fallbackHandle = this.nextFallbackStmtHandle++;
      this.preparedStatements.set(fallbackHandle, {
        dbHandle,
        sql,
        native: false,
      });
      return { ...desc, handle: fallbackHandle };
    }
    const prepareFn = mod._fb_prepare;
    return this.withString(sql, (sqlPtr) => {
      const resultPtr = prepareFn.call(mod, dbHandle, txHandle, sqlPtr);
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird could not prepare: ${sql}`);
      }
      const json = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);
      const parsed = JSON.parse(json) as { handle?: number };
      const rawHandle = typeof parsed.handle === 'number' ? parsed.handle : 0;
      const handle =
        rawHandle > 0 ? rawHandle : this.nextFallbackStmtHandle++;
      this.preparedStatements.set(handle, {
        dbHandle,
        sql,
        native: rawHandle > 0,
      });
      return {
        ...decodeDescription(json),
        handle,
      };
    });
  }

  async stmtClose(stmtHandle: EngineHandle): Promise<void> {
    if (stmtHandle <= 0) return;
    const entry = this.preparedStatements.get(stmtHandle);
    this.preparedStatements.delete(stmtHandle);
    const mod = this.module;
    if (
      (!entry || entry.native) &&
      typeof mod._fb_stmt_close === 'function'
    ) {
      mod._fb_stmt_close(stmtHandle);
    }
  }

  private lookupPreparedEntry(
    dbHandle: EngineHandle,
    stmtHandle: EngineHandle,
    context: string,
  ): { dbHandle: EngineHandle; sql: string; native: boolean } {
    const entry = this.preparedStatements.get(stmtHandle);
    if (!entry || entry.dbHandle !== dbHandle) {
      throw new Error(`Firebird ${context} failed: unknown statement handle (${stmtHandle})`);
    }
    return entry;
  }

  async executeStmt(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params: QueryParams | Uint8Array = [],
  ): Promise<number> {
    const mod = this.module;
    const entry = this.preparedStatements.get(stmtHandle);
    if (
      typeof mod._fb_execute_stmt === 'function' &&
      (!entry || entry.native)
    ) {
      const executeStmtFn = mod._fb_execute_stmt;
      const rc = this.withParams(params, (paramPtr, paramLen) =>
        executeStmtFn.call(
          mod,
          dbHandle,
          txHandle,
          stmtHandle,
          paramPtr,
          paramLen,
        ),
      );
      if (rc !== 0) {
        throw engineError(
          mod,
          `Firebird executeStmt failed for statement #${stmtHandle}`,
          rc,
        );
      }
      return mod._fb_last_affected_rows();
    }

    const fallback = this.lookupPreparedEntry(
      dbHandle,
      stmtHandle,
      'executeStmt',
    );
    return this.execute(dbHandle, txHandle, fallback.sql, params);
  }

  async executeBatchStmt(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    rows: QueryParams[] | Uint8Array,
  ): Promise<number> {
    const mod = this.module;
    const entry = this.preparedStatements.get(stmtHandle);
    if (
      typeof mod._fb_execute_batch_stmt === 'function' &&
      (!entry || entry.native)
    ) {
      const executeBatchStmtFn = mod._fb_execute_batch_stmt;
      let packed: Uint8Array;
      if (isWireParamRowsBuffer(rows)) {
        const view = new DataView(rows.buffer, rows.byteOffset, rows.byteLength);
        if (view.getUint32(4, true) === 0) return 0;
        packed = wireParamRowsToCAbi(rows);
      } else {
        if (rows.length === 0) return 0;
        const resolvedRows = rows.map((row) => this.resolveStagedBlobParams(row));
        packed = encodeParamRows(resolvedRows);
      }
      const ptr = mod._malloc(packed.length);
      let rc: number;
      try {
        mod.HEAPU8.set(packed, ptr);
        rc = executeBatchStmtFn.call(
          mod,
          dbHandle,
          txHandle,
          stmtHandle,
          ptr,
          packed.length,
        );
      } finally {
        mod._free(ptr);
      }
      if (rc !== 0) {
        throw engineError(
          mod,
          `Firebird executeBatchStmt failed for statement #${stmtHandle}`,
          rc,
        );
      }
      return mod._fb_last_affected_rows();
    }

    const fallback = this.lookupPreparedEntry(
      dbHandle,
      stmtHandle,
      'executeBatchStmt',
    );
    return this.executeBatch(dbHandle, txHandle, fallback.sql, rows);
  }

  async queryStmt<T = Row>(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params: QueryParams | Uint8Array = [],
    rowMode: RowMode = 'object',
    binaryBlobs = false,
  ): Promise<QueryResult<T>> {
    const mod = this.module;
    const entry = this.preparedStatements.get(stmtHandle);
    const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;

    if (
      typeof mod._fb_query_stmt_binary === 'function' &&
      (!entry || entry.native)
    ) {
      const queryStmtBinaryFn = mod._fb_query_stmt_binary;
      return this.withParams(params, (paramPtr, paramLen) => {
        const lenPtr = mod._malloc(4);
        let binPtr = 0;
        try {
          binPtr = queryStmtBinaryFn.call(
            mod,
            dbHandle,
            txHandle,
            stmtHandle,
            paramPtr,
            paramLen,
            flags,
            lenPtr,
          );
          if (binPtr === 0) {
            throw engineError(
              mod,
              `Firebird queryStmt failed for statement #${stmtHandle}`,
            );
          }
          const lenView = new DataView(
            mod.HEAPU8.buffer,
            mod.HEAPU8.byteOffset + lenPtr,
            4,
          );
          const byteLen = lenView.getUint32(0, true);
          const view = mod.HEAPU8.subarray(binPtr, binPtr + byteLen);
          return decodeBinaryResultSet<T>(
            view,
            rowMode,
            binaryBlobs,
            this.shapeColumns,
          );
        } finally {
          if (binPtr !== 0) {
            mod._fb_free_result(binPtr);
          }
          mod._free(lenPtr);
        }
      });
    }

    if (
      typeof mod._fb_query_stmt === 'function' &&
      (!entry || entry.native)
    ) {
      const queryStmtFn = mod._fb_query_stmt;
      return this.withParams(params, (paramPtr, paramLen) => {
        const resultPtr = queryStmtFn.call(
          mod,
          dbHandle,
          txHandle,
          stmtHandle,
          paramPtr,
          paramLen,
          flags,
        );
        if (resultPtr === 0) {
          throw engineError(
            mod,
            `Firebird queryStmt failed for statement #${stmtHandle}`,
          );
        }
        const json = mod.UTF8ToString(resultPtr);
        mod._fb_free_result(resultPtr);
        const blobs = binaryBlobs ? readBlobs(mod) : null;
        const result = decodeResultSet<T>(json, rowMode, this.shapeColumns);
        return blobs ? attachBlobs(result, blobs, rowMode) : result;
      });
    }

    const fallback = this.lookupPreparedEntry(
      dbHandle,
      stmtHandle,
      'queryStmt',
    );
    return this.query<T>(
      dbHandle,
      txHandle,
      fallback.sql,
      params,
      rowMode,
      binaryBlobs,
    );
  }

  async queryStmtBinary(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params: QueryParams | Uint8Array = [],
    binaryBlobs = false,
  ): Promise<BinaryResultPayload> {
    const mod = this.module;
    const entry = this.preparedStatements.get(stmtHandle);
    if (
      typeof mod._fb_query_stmt_binary === 'function' &&
      (!entry || entry.native)
    ) {
      const queryStmtBinaryFn = mod._fb_query_stmt_binary;
      const flags = (binaryBlobs ? BLOB_SIDE_CHANNEL : 0) | SHAPE_IDS;
      return this.withParams(params, (paramPtr, paramLen) => {
        const lenPtr = mod._malloc(4);
        let binPtr = 0;
        try {
          binPtr = queryStmtBinaryFn.call(
            mod,
            dbHandle,
            txHandle,
            stmtHandle,
            paramPtr,
            paramLen,
            flags,
            lenPtr,
          );
          if (binPtr === 0) {
            throw engineError(
              mod,
              `Firebird queryStmt failed for statement #${stmtHandle}`,
            );
          }
          const lenView = new DataView(
            mod.HEAPU8.buffer,
            mod.HEAPU8.byteOffset + lenPtr,
            4,
          );
          const byteLen = lenView.getUint32(0, true);
          return this.extractBinaryPayload(mod, binPtr, byteLen);
        } finally {
          if (binPtr !== 0) {
            mod._fb_free_result(binPtr);
          }
          mod._free(lenPtr);
        }
      });
    }

    const decoded = await this.queryStmt<unknown[]>(
      dbHandle,
      txHandle,
      stmtHandle,
      params,
      'array',
      binaryBlobs,
    );
    return {
      binaryResult: encodeBinaryResultSet(decoded, { rowMode: 'array' }),
    };
  }

  async cursorOpenStmt(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    stmtHandle: EngineHandle,
    params: QueryParams | Uint8Array = [],
  ): Promise<EngineHandle> {
    const mod = this.module;
    const entry = this.preparedStatements.get(stmtHandle);
    if (
      typeof mod._fb_cursor_open_stmt === 'function' &&
      (!entry || entry.native)
    ) {
      const openStmtFn = mod._fb_cursor_open_stmt;
      const handle = this.withParams(params, (paramPtr, paramLen) =>
        openStmtFn.call(
          mod,
          dbHandle,
          txHandle,
          stmtHandle,
          paramPtr,
          paramLen,
        ),
      );
      if (handle === 0) {
        throw engineError(
          mod,
          `Firebird cursorOpenStmt failed for statement #${stmtHandle}`,
        );
      }
      return handle;
    }

    const fallback = this.lookupPreparedEntry(
      dbHandle,
      stmtHandle,
      'cursorOpenStmt',
    );
    return this.cursorOpen(dbHandle, txHandle, fallback.sql, params);
  }

  async stmtSetTimeout(
    stmtHandle: EngineHandle,
    timeoutMs: number,
  ): Promise<void> {
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0
    ) {
      throw new RangeError('timeoutMs must be a non-negative finite number');
    }
    const mod = this.module;
    if (typeof mod._fb_stmt_set_timeout === 'function') {
      const rc = mod._fb_stmt_set_timeout(
        stmtHandle,
        Math.floor(timeoutMs) >>> 0,
      );
      if (rc !== 0) {
        throw engineError(
          mod,
          `Firebird stmtSetTimeout failed for statement #${stmtHandle}`,
          rc,
        );
      }
    }
  }

  async cancelOperation(
    dbHandle: EngineHandle,
    option = 3,
  ): Promise<void> {
    const mod = this.module;
    if (typeof mod._fb_wasm_cancel_operation === 'function') {
      const rc = mod._fb_wasm_cancel_operation(dbHandle, option);
      if (rc !== 0) {
        throw engineError(mod, 'Firebird cancelOperation failed', rc);
      }
    } else if (typeof mod._fb_cancel_operation === 'function') {
      const rc = mod._fb_cancel_operation(dbHandle, option);
      if (rc !== 0) {
        throw engineError(mod, 'Firebird cancelOperation failed', rc);
      }
    }
  }

  async explain(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    detailed = false,
  ): Promise<string> {
    const mod = this.module;
    if (typeof mod._fb_explain !== 'function') {
      return this.fallbackExplain(dbHandle, txHandle, sql, detailed);
    }

    const explainFn = mod._fb_explain;
    return this.withString(sql, (sqlPtr) => {
      const resultPtr = explainFn.call(
        mod,
        dbHandle,
        txHandle,
        sqlPtr,
        detailed ? 1 : 0,
      );
      if (resultPtr === 0) {
        throw engineError(mod, `Firebird could not explain: ${sql}`);
      }

      const plan = mod.UTF8ToString(resultPtr);
      mod._fb_free_result(resultPtr);
      return plan.replace(/^[\r\n]+|[\r\n]+$/g, '');
    });
  }

  private fallbackExplain(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    detailed: boolean,
  ): Promise<string> {
    return fallbackExplainQuery(
      (s) => this.describe(dbHandle, txHandle, s),
      (s, p) => this.query(dbHandle, txHandle, s, p),
      sql,
      detailed,
    );
  }

  async databaseInfo(dbHandle: EngineHandle): Promise<DatabaseInfo> {
    const mod = this.module;
    if (typeof mod._fb_database_info !== 'function') {
      return this.fallbackDatabaseInfo(dbHandle);
    }

    const resultPtr = mod._fb_database_info(dbHandle);
    if (resultPtr === 0) {
      throw engineError(mod, 'Firebird could not read database info');
    }

    const json = mod.UTF8ToString(resultPtr);
    mod._fb_free_result(resultPtr);
    return decodeDatabaseInfo(json);
  }

  async sweep(dbHandle: EngineHandle): Promise<SweepResult> {
    const started = performance.now();
    const before = await this.databaseInfo(dbHandle);
    const mod = this.module;

    // 1. Scan all user tables to trigger cooperative garbage collection of
    //    old record versions on data pages.
    let tablesScanned = 0;
    try {
      const relRes = await this.query<Record<string, unknown>>(
        dbHandle,
        0,
        'SELECT TRIM(RDB$RELATION_NAME) AS REL FROM RDB$RELATIONS ' +
          'WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ' +
          'ORDER BY RDB$RELATION_NAME',
      );
      for (const row of relRes.rows) {
        const rel = String(row['REL'] ?? row['rel'] ?? '').trim();
        if (!rel) continue;
        const escaped = rel.replace(/"/g, '""');
        await this.query(dbHandle, 0, `SELECT COUNT(*) AS C FROM "${escaped}"`);
        tablesScanned += 1;
      }
    } catch {
      // Ignore table scan errors during sweep if a relation is inaccessible.
    }

    // 2. Run native DPB sweep (`isc_dpb_sweep = isc_dpb_records`) when
    //    exported by the WASM bridge to advance OIT.
    if (typeof mod._fb_sweep === 'function') {
      const rc = mod._fb_sweep(dbHandle);
      if (rc !== 0) {
        throw engineError(mod, 'Database sweep failed', rc);
      }
    } else {
      // Fallback for older WASM binaries without `_fb_sweep`: commit a fresh
      // transaction so OAT/OST move forward.
      const tx = await this.startTransaction(dbHandle, {
        isolationLevel: 'READ_COMMITTED',
      });
      await this.commit(tx);
    }

    const after = await this.databaseInfo(dbHandle);
    return buildSweepResult(before, after, tablesScanned, performance.now() - started);
  }

  async setReplicaMode(
    dbHandle: EngineHandle,
    mode: 0 | 1 | 2 | 'none' | 'read_only' | 'read_write',
  ): Promise<void> {
    const mod = this.module;
    const modeCode: 0 | 1 | 2 =
      mode === 'none' || mode === 0
        ? 0
        : mode === 'read_only' || mode === 1
          ? 1
          : 2;

    for (const [stmtHandle, entry] of this.preparedStatements) {
      if (entry.dbHandle === dbHandle) {
        this.preparedStatements.delete(stmtHandle);
      }
    }

    if (typeof mod._fb_set_replica_mode === 'function') {
      const rc = mod._fb_set_replica_mode(dbHandle, modeCode);
      if (rc !== 0) {
        throw engineError(mod, 'Failed to set database replica mode', rc);
      }
      return;
    }

    throw new Error(
      'Native _fb_set_replica_mode is not exported by the loaded Firebird WASM module.',
    );
  }

  async replicateChangelog(
    dbHandle: EngineHandle,
    data: Uint8Array,
  ): Promise<number> {
    const mod = this.module;
    if (typeof mod._fb_replicate_changelog !== 'function') {
      throw new Error(
        'Native _fb_replicate_changelog (IAttachment::createReplicator) is not exported by the loaded Firebird WASM module.',
      );
    }
    if (data.byteLength === 0) {
      return 0;
    }
    const ptr = mod._malloc(data.byteLength);
    let processed: number;
    try {
      mod.HEAPU8.set(data, ptr);
      processed = mod._fb_replicate_changelog(dbHandle, ptr, data.byteLength);
    } finally {
      mod._free(ptr);
    }
    if (processed < 0) {
      throw engineError(mod, 'Failed to apply Firebird changelog segment', processed);
    }
    return processed;
  }

  private fallbackDatabaseInfo(dbHandle: EngineHandle): Promise<DatabaseInfo> {
    return fallbackReadDatabaseInfo((s) => this.query(dbHandle, 0, s));
  }

  async startTransaction(
    dbHandle: EngineHandle,
    options: TransactionOptions = {},
  ): Promise<EngineHandle> {
    const mod = this.module;
    const txHandle = mod._fb_start_transaction_ex(
      dbHandle,
      isolationCode(options),
      options.readOnly === true ? 1 : 0,
    );
    if (txHandle === 0) {
      throw engineError(mod, 'Failed to start transaction');
    }
    return txHandle;
  }

  async commit(txHandle: EngineHandle): Promise<void> {
    const mod = this.module;
    const rc = mod._fb_commit(txHandle);
    if (rc !== 0) {
      // fb_commit finishes the transaction whatever the outcome, so there is
      // nothing left to roll back here.
      throw engineError(mod, 'Transaction commit failed', rc);
    }
  }

  async rollback(txHandle: EngineHandle): Promise<void> {
    this.module._fb_rollback(txHandle);
  }

  async pipeline(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    steps: readonly EnginePipelineStepRequest[],
    options: EnginePipelineWireOptions = {},
  ): Promise<EnginePipelineStepResponse[]> {
    let activeTx = txHandle;
    const ownsTx = activeTx === 0 && Boolean(options.transaction);
    if (ownsTx) {
      const txOpts =
        typeof options.transaction === 'object' && options.transaction !== null
          ? options.transaction
          : {};
      activeTx = await this.startTransaction(dbHandle, txOpts);
    }

    const out: EnginePipelineStepResponse[] = new Array(steps.length);
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        if (step.op === 'execute') {
          const affectedRows =
            step.stmtHandle && step.stmtHandle > 0
              ? await this.executeStmt(
                  dbHandle,
                  activeTx,
                  step.stmtHandle,
                  step.params,
                )
              : await this.execute(
                  dbHandle,
                  activeTx,
                  step.sql,
                  step.params,
                );
          out[i] = { kind: 'affected', affectedRows };
        } else if (step.op === 'executeBatch') {
          const affectedRows =
            step.stmtHandle && step.stmtHandle > 0
              ? await this.executeBatchStmt(
                  dbHandle,
                  activeTx,
                  step.stmtHandle,
                  step.rows,
                )
              : await this.executeBatch(
                  dbHandle,
                  activeTx,
                  step.sql,
                  step.rows,
                );
          out[i] = { kind: 'affected', affectedRows };
        } else {
          const payload =
            step.stmtHandle && step.stmtHandle > 0
              ? await this.queryStmtBinary(
                  dbHandle,
                  activeTx,
                  step.stmtHandle,
                  step.params,
                  step.binaryBlobs,
                )
              : await this.queryBinary(
                  dbHandle,
                  activeTx,
                  step.sql,
                  step.params,
                  step.binaryBlobs,
                );
          out[i] = { kind: 'binary', payload };
        }
      }

      if (ownsTx) {
        await this.commit(activeTx);
      }
      return out;
    } catch (err) {
      if (ownsTx && activeTx !== 0) {
        await this.rollback(activeTx).catch(() => undefined);
      }
      throw err;
    }
  }

  // ── Filesystem ─────────────────────────────────────────────────────────

  async mkdir(path: string): Promise<void> {
    fsMkdir(this.module, path);
  }

  async exists(path: string): Promise<boolean> {
    return fsExists(this.module, this.opfsHandle, path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return fsReadFile(this.module, this.opfsHandle, path);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    fsWriteFile(this.module, this.opfsHandle, path, data);
  }

  async fileSize(path: string): Promise<number> {
    return fsFileSize(this.module, this.opfsHandle, path);
  }

  async readFileChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    return fsReadFileChunk(this.module, this.opfsHandle, path, offset, length);
  }

  async writeFileChunk(
    path: string,
    data: Uint8Array,
    offset: number,
    truncate = false,
  ): Promise<void> {
    fsWriteFileChunk(this.module, this.opfsHandle, path, data, offset, truncate);
  }

  async unlink(path: string): Promise<void> {
    fsUnlink(this.module, this.opfsHandle, path);
  }

  async eventsSubscribe(dbHandle: EngineHandle, names: string[]): Promise<number> {
    const mod = this.module;
    return this.withString(names.join(','), (namesPtr) => {
      const handle = mod._fb_events_subscribe(dbHandle, namesPtr);
      if (handle === 0) {
        throw engineError(mod, `Could not subscribe to events: ${names.join(', ')}`);
      }
      return handle;
    });
  }

  async eventsPoll(subscription: number): Promise<Record<string, number>> {
    const mod = this.module;
    const ptr = mod._fb_events_poll(subscription);
    if (ptr === 0) {
      throw engineError(mod, 'Could not poll events');
    }

    const json = mod.UTF8ToString(ptr);
    mod._free(ptr);
    return JSON.parse(json) as Record<string, number>;
  }

  async eventsCancel(subscription: number): Promise<void> {
    this.module._fb_events_cancel(subscription);
  }

  async mountOpfs(dbName: string): Promise<string> {
    const { handle, path } = await mountOpfsDatabase(this.module, dbName);
    this.opfsHandle = handle;
    return path;
  }

  async dispose(): Promise<void> {
    const mod = this.mod;
    const init = this.initPromise;
    const opfs = this.opfsHandle;
    this.mod = null;
    this.initPromise = null;
    this.opfsHandle = null;
    this.fallbackCursors.clear();
    this.blobOps.clear();
    this.preparedStatements.clear();
    if (opfs && mod) {
      unmountOpfsDatabase(mod, opfs);
    }
    if (mod) {
      await releaseFirebirdWasm(mod);
    } else if (init) {
      await init.then(() => undefined, () => undefined);
      const late = this.mod as FirebirdWasmModule | null;
      this.mod = null;
      if (late) await releaseFirebirdWasm(late);
    }
  }
}
