/**
 * direct-blob-ops.ts – Segmented BLOB I/O & Fallback Staging Subsystem for
 * `DirectTransport` (`M24 Item 5`).
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import type { QueryDescription, QueryParams, QueryResult } from '../types';
import { extractBlobHandle } from './blob-stream';
import type { EngineHandle } from './wasm-abi-types';
import { engineError } from './result-decoder';

export interface DirectBlobHost {
  getModule(): FirebirdWasmModule;
  withString<T>(str: string, fn: (ptr: number) => T): T;
  withParams<T>(params: QueryParams | Uint8Array, fn: (ptr: number, length: number) => T): T;
  describe(dbHandle: EngineHandle, txHandle: EngineHandle, sql: string): Promise<QueryDescription>;
  queryArray(
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams,
  ): Promise<QueryResult<unknown[]>>;
}

export class DirectBlobSubsystem {
  private readonly fallbackBlobWrites = new Map<
    EngineHandle,
    { blobId: Uint8Array; chunks: Uint8Array[]; totalBytes: number }
  >();
  private readonly fallbackBlobReaders = new Map<
    EngineHandle,
    { bytes: Uint8Array; offset: number; blobId: Uint8Array }
  >();
  private readonly stagedBlobs = new Map<string, Uint8Array>();
  private nextFallbackBlobHandle = 1;

  private static blobIdKey(blobId: Uint8Array): string {
    return Array.from(blobId)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  clear(): void {
    this.fallbackBlobWrites.clear();
    this.fallbackBlobReaders.clear();
    this.stagedBlobs.clear();
  }

  resolveStagedBlobParams(params: QueryParams): QueryParams {
    if (!params || params.length === 0 || this.stagedBlobs.size === 0) {
      return params;
    }
    let changed = false;
    const out: unknown[] = new Array(params.length);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const handle = extractBlobHandle(p, i);
      if (handle) {
        const key = DirectBlobSubsystem.blobIdKey(handle.blobId);
        const staged = this.stagedBlobs.get(key);
        if (staged) {
          out[i] = staged;
          changed = true;
          continue;
        }
      }
      out[i] = p;
    }
    return changed ? (out as QueryParams) : params;
  }

  async blobCreate(
    host: DirectBlobHost,
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
  ): Promise<{ blobHandle: EngineHandle; blobId: Uint8Array }> {
    const mod = host.getModule();
    if (txHandle > 0 && typeof mod._fb_blob_create === 'function') {
      const outPtr = mod._malloc(8);
      try {
        const blobHandle = mod._fb_blob_create(dbHandle, txHandle, outPtr);
        if (blobHandle === 0) {
          throw engineError(mod, 'Firebird blobCreate failed');
        }
        const blobId = mod.HEAPU8.slice(outPtr, outPtr + 8);
        return { blobHandle, blobId };
      } finally {
        mod._free(outPtr);
      }
    }

    const handle = this.nextFallbackBlobHandle++;
    const blobId = new Uint8Array([
      0xfb,
      0xb1,
      0x0b,
      0x7f,
      handle & 0xff,
      (handle >>> 8) & 0xff,
      (handle >>> 16) & 0xff,
      (handle >>> 24) & 0xff,
    ]);
    this.fallbackBlobWrites.set(handle, {
      blobId,
      chunks: [],
      totalBytes: 0,
    });
    return { blobHandle: handle, blobId: blobId.slice() };
  }

  async blobPutSegment(
    host: DirectBlobHost,
    blobHandle: EngineHandle,
    segment: Uint8Array,
  ): Promise<void> {
    if (segment.byteLength === 0) return;
    const fallback = this.fallbackBlobWrites.get(blobHandle);
    if (fallback) {
      fallback.chunks.push(segment.slice());
      fallback.totalBytes += segment.byteLength;
      return;
    }

    const mod = host.getModule();
    if (typeof mod._fb_blob_put_segment !== 'function') {
      throw new Error('Firebird blobPutSegment failed: unknown blob handle');
    }
    const ptr = mod._malloc(segment.byteLength);
    try {
      mod.HEAPU8.set(segment, ptr);
      const rc = mod._fb_blob_put_segment(blobHandle, ptr, segment.byteLength);
      if (rc !== 0) {
        throw engineError(mod, 'Firebird blobPutSegment failed', rc);
      }
    } finally {
      mod._free(ptr);
    }
  }

  async blobOpenId(
    host: DirectBlobHost,
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    blobId: Uint8Array,
  ): Promise<EngineHandle> {
    const key = DirectBlobSubsystem.blobIdKey(blobId);
    const staged = this.stagedBlobs.get(key);
    if (staged) {
      const handle = this.nextFallbackBlobHandle++;
      this.fallbackBlobReaders.set(handle, {
        bytes: staged,
        offset: 0,
        blobId: blobId.slice(0, 8),
      });
      return handle;
    }

    const mod = host.getModule();
    if (typeof mod._fb_blob_open_id !== 'function') {
      throw new Error('Firebird blobOpenId failed: unknown or uncommitted BLOB ID');
    }

    const idPtr = mod._malloc(8);
    try {
      mod.HEAPU8.set(blobId.subarray(0, 8), idPtr);
      const handle = mod._fb_blob_open_id(dbHandle, txHandle, idPtr);
      if (handle === 0) {
        throw engineError(mod, 'Firebird blobOpenId failed');
      }
      return handle;
    } finally {
      mod._free(idPtr);
    }
  }

  async blobOpenQuery(
    host: DirectBlobHost,
    dbHandle: EngineHandle,
    txHandle: EngineHandle,
    sql: string,
    params: QueryParams = [],
    colIndex = 0,
  ): Promise<EngineHandle> {
    const mod = host.getModule();
    if (typeof mod._fb_blob_open_query === 'function') {
      const openQueryFn = mod._fb_blob_open_query;
      const handle = host.withString(sql, (sqlPtr) =>
        host.withParams(params, (paramPtr, paramLen) =>
          openQueryFn.call(mod, dbHandle, txHandle, sqlPtr, paramPtr, paramLen, colIndex),
        ),
      );
      if (handle === 0) {
        throw engineError(mod, `Firebird openBlobStream failed for: ${sql}`);
      }
      return handle;
    }

    const desc = await host.describe(dbHandle, txHandle, sql);
    if (desc.fields.length === 0) {
      throw new Error('openBlobStream: query does not return any columns');
    }
    if (colIndex < 0 || colIndex >= desc.fields.length) {
      throw new RangeError(
        `openBlobStream: column index ${colIndex} is out of range (0..${desc.fields.length - 1})`,
      );
    }
    if (desc.fields[colIndex]!.typeName !== 'BLOB') {
      throw new Error(
        `openBlobStream: column "${desc.fields[colIndex]!.name}" is ${desc.fields[colIndex]!.typeName}, not BLOB`,
      );
    }

    const res = await host.queryArray(dbHandle, txHandle, sql, params);
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
    const handle = this.nextFallbackBlobHandle++;
    this.fallbackBlobReaders.set(handle, {
      bytes,
      offset: 0,
      blobId: new Uint8Array(8),
    });
    return handle;
  }

  async blobGetSegment(
    host: DirectBlobHost,
    blobHandle: EngineHandle,
    maxLength: number,
  ): Promise<Uint8Array | null> {
    const fallback = this.fallbackBlobReaders.get(blobHandle);
    if (fallback) {
      if (fallback.offset >= fallback.bytes.byteLength) {
        return null;
      }
      const end = Math.min(fallback.offset + maxLength, fallback.bytes.byteLength);
      const slice = fallback.bytes.slice(fallback.offset, end);
      fallback.offset = end;
      return slice;
    }

    const mod = host.getModule();
    if (typeof mod._fb_blob_get_segment !== 'function') {
      throw new Error('Firebird blobGetSegment failed: unknown blob handle');
    }
    const outPtr = mod._malloc(maxLength);
    const actualPtr = mod._malloc(4);
    try {
      const rc = mod._fb_blob_get_segment(blobHandle, outPtr, maxLength, actualPtr);
      if (rc < 0) {
        throw engineError(mod, 'Firebird blobGetSegment failed', rc);
      }
      if (rc === 1) {
        return null;
      }
      const view = new DataView(
        mod.HEAPU8.buffer,
        mod.HEAPU8.byteOffset + actualPtr,
        4,
      );
      const actualLen = view.getUint32(0, true);
      if (actualLen === 0) {
        return null;
      }
      return mod.HEAPU8.slice(outPtr, outPtr + actualLen);
    } finally {
      mod._free(actualPtr);
      mod._free(outPtr);
    }
  }

  async blobClose(
    host: DirectBlobHost,
    blobHandle: EngineHandle,
    cancel = false,
  ): Promise<Uint8Array> {
    const writeFallback = this.fallbackBlobWrites.get(blobHandle);
    if (writeFallback) {
      this.fallbackBlobWrites.delete(blobHandle);
      if (!cancel) {
        const merged = new Uint8Array(writeFallback.totalBytes);
        let pos = 0;
        for (const chunk of writeFallback.chunks) {
          merged.set(chunk, pos);
          pos += chunk.byteLength;
        }
        this.stagedBlobs.set(DirectBlobSubsystem.blobIdKey(writeFallback.blobId), merged);
      }
      return writeFallback.blobId.slice();
    }

    const readFallback = this.fallbackBlobReaders.get(blobHandle);
    if (readFallback) {
      this.fallbackBlobReaders.delete(blobHandle);
      return readFallback.blobId.slice();
    }

    const mod = host.getModule();
    if (typeof mod._fb_blob_close !== 'function') {
      throw new Error('Firebird blobClose failed: unknown blob handle');
    }
    const outPtr = mod._malloc(8);
    let rc = 0;
    let outBlobId = new Uint8Array(8);
    try {
      rc = mod._fb_blob_close(blobHandle, cancel ? 1 : 0, outPtr);
      if (rc !== 0) {
        throw engineError(mod, 'Firebird blobClose failed', rc);
      }
      outBlobId = mod.HEAPU8.slice(outPtr, outPtr + 8);
    } finally {
      mod._free(outPtr);
    }
    return outBlobId;
  }
}
