/**
 * node-native-bindings.ts – Low-level `node-firebird-driver` OO-API statement,
 * metadata, batch (`IBatch`), BLOB, and `StatementCache` helpers (`M20 Item 5`).
 */

import * as os from 'os';
import { Blob as FbBlob } from 'node-firebird-driver';
import type {
  Attachment,
  Statement,
  Transaction,
} from 'node-firebird-driver';
import type {
  BlobStreamOptions,
  FieldInfo,
  QueryParams,
} from './types';
import { firebirdTypeName } from './browser/field-types';
import type { TypeOptions } from './browser/value-types';
import { validateTimeoutMs } from './database-core';
import {
  BLOB_INTERNAL_DATA,
  buildBlobReadableStream,
  extractBlobHandle,
  resolveBlobColumnIndex,
} from './browser/blob-stream';
import type { ParamDescriptor } from './batch-block';
import type { StatementCache } from './node-native-batch';

type NativeDriver = typeof import('node-firebird-driver-native');

const littleEndian = os.endianness() === 'LE';

/** `isc_info_sql_stmt_select`: the statement type the shared read transaction runs. */
export const STMT_SELECT = 1;
let nativeDriver: NativeDriver | undefined;

/**
 * The native driver, loaded on first use rather than at import.
 *
 * It is an optional dependency: a browser-only install (`--omit=optional`) has
 * none, and a top-level import made the whole root entry fail to load there,
 * `sql` and `loadFirebirdWasm` included, with a bare MODULE_NOT_FOUND.
 */
export function loadNativeDriver(): NativeDriver {
  if (!nativeDriver) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nativeDriver = require('node-firebird-driver-native') as NativeDriver;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
      throw new Error(
        "FirebirdLite needs the optional dependency 'node-firebird-driver-native', which is not " +
          'installed (an install with --omit=optional skips it). Install it, or use the WASM ' +
          "engine from 'firebird-wasm/browser'.",
      );
    }
  }
  return nativeDriver;
}

export async function cancelAttachmentOperation(
  attachment: Attachment | null,
  option = 3,
): Promise<void> {
  if (!attachment) return;
  const internal = attachment as unknown as {
    cancelOperation?: (option?: number) => Promise<void>;
    attachmentHandle?: {
      cancelOperationAsync?: (status: unknown, opt: number) => Promise<void>;
      cancelOperationSync?: (status: unknown, opt: number) => void;
    };
    client?: {
      statusAction?: <T>(fn: (status: unknown) => Promise<T>) => Promise<T>;
    };
  };
  if (typeof internal.cancelOperation === 'function') {
    await internal.cancelOperation(option);
    return;
  }
  const client = internal.client;
  const cancelAsync = internal.attachmentHandle?.cancelOperationAsync;
  const cancelSync = internal.attachmentHandle?.cancelOperationSync;
  if (typeof client?.statusAction === 'function' && typeof cancelAsync === 'function') {
    await client.statusAction((status) =>
      cancelAsync.call(internal.attachmentHandle, status, option),
    );
    return;
  }
  if (typeof client?.statusAction === 'function' && typeof cancelSync === 'function') {
    await client.statusAction(async (status) => {
      cancelSync.call(internal.attachmentHandle, status, option);
    });
  }
}

export async function applyStatementHandleTimeout(
  stmt: Statement,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) return;
  const validated = validateTimeoutMs(timeoutMs) ?? 0;
  const internal = stmt as unknown as NativeStatement & {
    setTimeout?: (ms: number) => Promise<void> | void;
  };
  if (typeof internal.setTimeout === 'function') {
    await internal.setTimeout(validated);
    return;
  }
  const client = internal.attachment?.client;
  const setAsync = internal.statementHandle?.setTimeoutAsync;
  const setSync = internal.statementHandle?.setTimeoutSync;
  if (typeof client?.statusAction === 'function' && typeof setAsync === 'function') {
    await client.statusAction((status) =>
      setAsync.call(internal.statementHandle, status, validated),
    );
    return;
  }
  if (typeof client?.statusAction === 'function' && typeof setSync === 'function') {
    await client.statusAction(async (status) => {
      setSync.call(internal.statementHandle, status, validated);
    });
  }
}


// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Rows per `EXECUTE BLOCK` in `execBatch`: a single-table statement uses
 * one of the engine's 256 contexts per row, so 200 leaves room. */
export const BLOCK_ROWS = 200;

// The driver's statement internals this file reads and, for text/exact types,
// rewrites. Not public API: each use checks they are there and falls back to
// the driver's own behaviour when they are not.

interface NativeMetadata {
  getCountSync(status: unknown): number;
  getTypeSync(status: unknown, i: number): number;
  getSubTypeSync(status: unknown, i: number): number;
  getLengthSync(status: unknown, i: number): number;
  getScaleSync(status: unknown, i: number): number;
  getCharSetSync(status: unknown, i: number): number;
  getOffsetSync(status: unknown, i: number): number;
  getNullOffsetSync(status: unknown, i: number): number;
  getAliasSync?(status: unknown, i: number): string;
  isNullableSync?(status: unknown, i: number): boolean;
  getMessageLengthSync(status: unknown): number;
  getAlignedLengthSync?(status: unknown): number;
  getBuilderSync(status: unknown): NativeMetadataBuilder;
  releaseSync(): number;
}

interface NativeMetadataBuilder {
  setTypeSync(status: unknown, i: number, type: number): void;
  setSubTypeSync(status: unknown, i: number, subType: number): void;
  setLengthSync(status: unknown, i: number, length: number): void;
  setCharSetSync(status: unknown, i: number, charSet: number): void;
  setScaleSync(status: unknown, i: number, scale: number): void;
  getMetadataSync(status: unknown): NativeMetadata;
  releaseSync(): number;
}

/** What the driver encodes a statement's parameters with: the message and its writer. */
interface InputMessage {
  inMetadata: NativeMetadata;
  inBuffer: Uint8Array;
  dataWriter: unknown;
}

/** What the driver decodes a statement's output row with: the message and its reader. */
interface OutputMessage {
  outMetadata: NativeMetadata | undefined;
  outBuffer: Uint8Array | undefined;
  dataReader: unknown;
}

interface OutputDescriptor {
  msgType: number;
  preparedType: number;
  subType: number;
  scale: number;
  length: number;
  preparedLength: number;
  charSet: number;
  preparedCharSet: number;
  offset: number;
  nullOffset: number;
}

export type NativeStatement = Partial<InputMessage> &
  Partial<OutputMessage> & {
    attachment?: Attachment & {
      charSetForNONE?: string;
      client?: {
        statusAction?: <T>(fn: (status: unknown) => Promise<T>) => Promise<T>;
        util?: {
          getXpbBuilderSync?: (
            status: unknown,
            kind: number,
            buf: Uint8Array | undefined,
            len: number,
          ) => NativeXpbBuilder | undefined;
        };
      };
    };
    internalDispose?: () => Promise<void>;
    statementHandle?: {
      getInputMetadataAsync?: (status: unknown) => Promise<NativeMetadata | undefined>;
      getOutputMetadataAsync?: (status: unknown) => Promise<NativeMetadata | undefined>;
      getPlanAsync?: (status: unknown, detailed: boolean) => Promise<string | undefined>;
      getAffectedRecordsAsync?: (status: unknown) => Promise<number>;
      getAffectedRecordsSync?: (status: unknown) => number;
      getPlanSync?: (status: unknown, detailed: boolean) => string | undefined;
      setTimeoutAsync?: (status: unknown, timeOut: number) => Promise<void>;
      setTimeoutSync?: (status: unknown, timeOut: number) => void;
      createBatchAsync?: (
        status: unknown,
        inMetadata: NativeMetadata | undefined,
        parLength: number,
        par: unknown,
      ) => Promise<NativeBatch | undefined>;
    };
  };

export interface NativeXpbBuilder {
  insertIntSync(status: unknown, tag: number, value: number): void;
  getBufferLengthSync(status: unknown): number;
  getBufferSync(status: unknown): unknown;
  disposeSync(): void;
}

export interface NativeBatchCompletionState {
  getSizeSync(status: unknown): number;
  getStateSync(status: unknown, pos: number): number;
  findErrorSync?(status: unknown, pos: number): number;
  getStatusSync(status: unknown, to: unknown, pos: number): void;
  disposeSync(): void;
}

export interface NativeBatch {
  addAsync(status: unknown, count: number, inBuffer: Uint8Array): Promise<void>;
  addBlobAsync?(
    status: unknown,
    length: number,
    inBuffer: Uint8Array,
    blobId: Uint8Array,
    parLength: number,
    par: Uint8Array | undefined,
  ): Promise<void>;
  executeAsync(
    status: unknown,
    transaction: unknown,
  ): Promise<NativeBatchCompletionState | undefined>;
  closeAsync(status: unknown): Promise<void>;
}

/** A statement's parameters and output columns as prepared, and the messages made for it. */
interface Binding {
  params: ParamDescriptor[] | undefined;
  fields?: FieldInfo[];
  outDescriptors?: OutputDescriptor[];
  /** The driver's own input message, kept while another is in place. */
  original?: InputMessage;
  /** The driver's own output message, kept while customOut is in place. */
  originalOut?: OutputMessage;
  /** Custom output metadata that avoids the driver's lossy SQL_DOUBLE rewrite. */
  customOut?: NativeMetadata;
  /** Input messages by the positions they take as text: `"1,3"`. */
  variants: Map<string, InputMessage>;
  /** The positions of the input message in place; `''` is the driver's own. */
  current: string;
  disposeHooked?: boolean;
}

/**
 * Read the execution plan of a prepared statement (`IStatement::getPlan`),
 * trimming Firebird's leading/trailing newlines. Returns `""` for statements
 * that have no plan (such as DDL).
 */
export async function explainStatement(stmt: Statement, detailed: boolean): Promise<string> {
  const internal = stmt as unknown as NativeStatement & {
    getPlan?: (detailed: boolean) => Promise<string | undefined> | string | undefined;
  };
  let raw: string | undefined;
  const client = internal.attachment?.client;
  const getPlanAsync = internal.statementHandle?.getPlanAsync;
  const getPlanSync = internal.statementHandle?.getPlanSync;
  if (typeof client?.statusAction === 'function' && typeof getPlanAsync === 'function') {
    raw = await client.statusAction((status) => getPlanAsync.call(internal.statementHandle, status, detailed));
  } else if (typeof client?.statusAction === 'function' && typeof getPlanSync === 'function') {
    raw = await client.statusAction(async (status) => getPlanSync.call(internal.statementHandle, status, detailed));
  } else if (typeof internal.getPlan === 'function') {
    raw = await internal.getPlan(detailed);
  } else if (!detailed && typeof stmt.getExecPathText === 'function') {
    raw = await stmt.getExecPathText();
  }
  if (!raw) return '';
  return raw.replace(/^[\r\n]+|[\r\n]+$/g, '');
}

export async function readAffectedRecords(stmt: Statement): Promise<number> {
  const internal = stmt as unknown as NativeStatement;
  const client = internal.attachment?.client;
  const getAsync = internal.statementHandle?.getAffectedRecordsAsync;
  const getSync = internal.statementHandle?.getAffectedRecordsSync;
  if (typeof client?.statusAction === 'function' && typeof getAsync === 'function') {
    try {
      return await client.statusAction((status) => getAsync.call(internal.statementHandle, status));
    } catch {
      return 0;
    }
  }
  if (typeof client?.statusAction === 'function' && typeof getSync === 'function') {
    try {
      return await client.statusAction(async (status) => getSync.call(internal.statementHandle, status));
    } catch {
      return 0;
    }
  }
  return 0;
}

const bindings = new WeakMap<Statement, Binding>();

async function bindingOf(stmt: Statement): Promise<Binding> {
  let binding = bindings.get(stmt);
  if (!binding) {
    // Read before anything here rewrites the message; a statement is used
    // by one call at a time, so nothing else reads it meanwhile.
    binding = { params: await readInputParams(stmt), variants: new Map(), current: '' };
    await setupOutput(stmt, binding);
    bindings.set(stmt, binding);
  }
  return binding;
}

/**
 * Return `stmt`'s prepared input parameter metadata (`FieldInfo[]`), reading
 * `statementHandle.getInputMetadataAsync` directly so the driver's `fixMetadata`
 * coercion (`INTEGER`/`BIGINT`/`NUMERIC` → `SQL_DOUBLE`, `CHAR` → `VARCHAR`)
 * does not obscure the real parameter types. Falls back to `stmt.params` for
 * unit test stubs.
 */
export async function describeInputFields(stmt: Statement): Promise<FieldInfo[]> {
  const internal = stmt as unknown as NativeStatement & { params?: FieldInfo[] };
  const client = internal.attachment?.client;
  if (
    typeof internal.statementHandle?.getInputMetadataAsync === 'function' &&
    typeof client?.statusAction === 'function'
  ) {
    return client.statusAction(async (status) => {
      const prepared = await internal.statementHandle!.getInputMetadataAsync!(status);
      if (!prepared) return [];
      try {
        const count = prepared.getCountSync(status);
        const params: FieldInfo[] = [];
        for (let i = 0; i < count; i++) {
          const rawType = prepared.getTypeSync(status, i);
          const type = rawType & ~1;
          const subType = prepared.getSubTypeSync(status, i);
          const scale = prepared.getScaleSync(status, i);
          const length = prepared.getLengthSync(status, i);
          const nullable =
            typeof prepared.isNullableSync === 'function'
              ? Boolean(prepared.isNullableSync(status, i))
              : (rawType & 1) !== 0;
          const alias =
            typeof prepared.getAliasSync === 'function'
              ? prepared.getAliasSync(status, i)
              : '';
          params.push({
            name: alias || '',
            type,
            typeName: firebirdTypeName(type, scale),
            subType,
            scale,
            length,
            nullable,
          });
        }
        return params;
      } finally {
        prepared.releaseSync();
      }
    });
  }
  if (Array.isArray(internal.params)) {
    return internal.params.map((p) => ({
      ...p,
      ...(p.type !== undefined && p.typeName === undefined
        ? { typeName: firebirdTypeName(p.type, p.scale ?? 0) }
        : {}),
    }));
  }
  return [];
}

/**
 * Return a fresh copy of `stmt`'s output column metadata (`FieldInfo[]`).
 *
 * When the native driver's prepared output metadata is available, each entry
 * carries `type`, `typeName`, `subType`, `scale`, `length` and `nullable`,
 * matching `FirebirdBrowser`. Falls back to `stmt.fields` (for unit test stubs)
 * or `stmt.columnLabels` (names only).
 */
export async function outputFields(stmt: Statement): Promise<FieldInfo[]> {
  const binding = await bindingOf(stmt);
  if (binding.fields) {
    return binding.fields.map((f) => ({ ...f }));
  }
  const mockFields = (stmt as unknown as { fields?: FieldInfo[] }).fields;
  if (Array.isArray(mockFields)) {
    binding.fields = mockFields.map((f) => ({
      ...f,
      ...(f.type !== undefined && f.typeName === undefined
        ? { typeName: firebirdTypeName(f.type, f.scale ?? 0) }
        : {}),
    }));
    return binding.fields.map((f) => ({ ...f }));
  }
  const columnLabels = await stmt.columnLabels;
  binding.fields = columnLabels.map((label) => ({ name: label }));
  return binding.fields.map((f) => ({ ...f }));
}

/**
 * A statement's `?` parameters: its input metadata as the driver rewrote it
 * (CHAR as VARCHAR, the zoned types in their `_EX` forms), except that an
 * integer or NUMERIC parameter, which the driver binds as a double, is
 * described as prepared: SMALLINT, INTEGER or BIGINT, with its scale. That is
 * what `execBatch` declares a block's parameters as, and what tells a string
 * to send as text. `undefined` whenever the internals are not there, so a
 * driver that changes shape makes `execBatch` fall back to one execute per
 * row and strings go to the driver as they are.
 */
export async function inputParams(stmt: Statement): Promise<ParamDescriptor[] | undefined> {
  return (await bindingOf(stmt)).params;
}

async function readInputParams(stmt: Statement): Promise<ParamDescriptor[] | undefined> {
  const internal = stmt as unknown as NativeStatement;
  const meta = internal.inMetadata;
  const client = internal.attachment?.client;
  if (!meta || typeof meta.getCountSync !== 'function' || typeof client?.statusAction !== 'function') {
    return undefined;
  }
  try {
    return await client.statusAction(async (status) => {
      const read = (m: NativeMetadata, i: number): ParamDescriptor => ({
        type: m.getTypeSync(status, i),
        subType: m.getSubTypeSync(status, i),
        length: m.getLengthSync(status, i),
        scale: m.getScaleSync(status, i),
        charSet: m.getCharSetSync(status, i),
      });
      const params: ParamDescriptor[] = [];
      for (let i = 0, n = meta.getCountSync(status); i < n; i++) params.push(read(meta, i));

      if (!params.some((p) => (p.type & ~1) === SQL_DOUBLE)) return params;
      // The metadata as prepared, before the driver's rewrite.
      const prepared = await internal.statementHandle?.getInputMetadataAsync?.(status);
      if (!prepared) return params;
      try {
        return params.map((p, i) => {
          if ((p.type & ~1) !== SQL_DOUBLE) return p;
          const as = read(prepared, i);
          return INTEGER_TYPES.has(as.type & ~1) ? as : p;
        });
      } finally {
        prepared.releaseSync();
      }
    });
  } catch {
    return undefined;
  }
}

// Firebird SQL type codes (without the nullable low bit).
const SQL_TEXT = 452;
const SQL_VARYING = 448;
const SQL_SHORT = 500;
const SQL_LONG = 496;
const SQL_FLOAT = 482;
const SQL_DOUBLE = 480;
const SQL_D_FLOAT = 530;
const SQL_TIMESTAMP = 510;
export const SQL_BLOB = 520;
const SQL_TYPE_TIME = 560;
const SQL_TYPE_DATE = 570;
const SQL_INT64 = 580;
const SQL_TIMESTAMP_TZ = 32754;
const SQL_TIME_TZ = 32756;
const SQL_INT128 = 32752;
const SQL_DEC16 = 32760;
const SQL_DEC34 = 32762;
const SQL_BOOLEAN = 32764;
const SQL_NULL = 32766;

/** SMALLINT, INTEGER, BIGINT, and NUMERIC / DECIMAL kept in them. */
const INTEGER_TYPES: ReadonlySet<number> = new Set([SQL_SHORT, SQL_LONG, SQL_INT64]);
/** Character set ids from Firebird's `RDB$CHARACTER_SETS`. */
const CHARSET_OCTETS = 1;
const CS_UNICODE_FSS = 3;
const CS_UTF8 = 4;
/** `Number.MAX_SAFE_INTEGER` as a `bigint`: beyond this, IEEE-754 doubles round. */
const SAFE_INT64 = 9007199254740991n;
/**
 * Firebird 4+ output types whose binary format needs `IUtil` (`IInt128`,
 * `IDecFloat16`/`34`, `decodeTimeTz`/`decodeTimeStampTz`): coerced in the
 * output message to `SQL_VARYING` so Firebird formats them directly.
 */
const COERCE_TO_VARYING: ReadonlySet<number> = new Set([
  SQL_INT128,
  SQL_DEC16,
  SQL_DEC34,
  SQL_TIME_TZ,
  SQL_TIMESTAMP_TZ,
]);
/**
 * DATE, TIME, TIMESTAMP, and TIME / TIMESTAMP WITH TIME ZONE in both forms
 * (the driver rewrites the zoned ones to their `_EX` forms).
 */
const DATE_TIME_TYPES: ReadonlySet<number> = new Set([570, 560, 510, 32756, 32754, 32750, 32748]);
/** The types a string is sent to as text, for Firebird to convert. */
export const TEXT_TYPES: ReadonlySet<number> = new Set([
  ...DATE_TIME_TYPES,
  ...INTEGER_TYPES,
  SQL_INT128,
  SQL_DEC16,
  SQL_DEC34,
  SQL_BOOLEAN,
]);
/** Bytes a value takes as text: a timestamp with the longest zone name fits twice. */
const TEXT_LENGTH = 128;

/**
 * Replace the driver's `outMetadata` and `dataReader` on `stmt` with ones built
 * from Firebird's prepared output metadata.
 *
 * `node-firebird-driver-native`'s `fixMetadata` rewrites `SMALLINT`, `INTEGER`,
 * `BIGINT`, `FLOAT`, `NUMERIC` and `DECIMAL` to `SQL_DOUBLE` (losing precision
 * on `BIGINT` past 2^53 and turning exact `NUMERIC`/`DECIMAL` values into
 * floats), decodes `DATE`/`TIME`/`TIMESTAMP` into local-timezone `Date`
 * objects (truncating 100 µs fractions), and returns raw `Blob` handles that
 * expire when `query()` commits its transaction. Keeping the prepared types and
 * decoding them with the same rules as `fb_wasm_api.cpp` gives Node and
 * browser queries identical wire values and `FieldInfo` metadata.
 */
async function setupOutput(stmt: Statement, binding: Binding): Promise<void> {
  const internal = stmt as unknown as NativeStatement;
  const client = internal.attachment?.client;
  if (
    typeof internal.statementHandle?.getOutputMetadataAsync !== 'function' ||
    typeof client?.statusAction !== 'function'
  ) {
    return;
  }
  if (!internal.outMetadata) {
    binding.fields = [];
    return;
  }
  try {
    await client.statusAction(async (status) => {
      const prepared = await internal.statementHandle!.getOutputMetadataAsync!(status);
      if (!prepared) {
        binding.fields = [];
        return;
      }
      try {
        const count = prepared.getCountSync(status);
        if (count === 0) {
          binding.fields = [];
          return;
        }
        const fields: FieldInfo[] = [];
        const builder = prepared.getBuilderSync(status);
        let outMetadata: NativeMetadata;
        try {
          for (let i = 0; i < count; i++) {
            const rawType = prepared.getTypeSync(status, i);
            const type = rawType & ~1;
            const subType = prepared.getSubTypeSync(status, i);
            const scale = prepared.getScaleSync(status, i);
            const length = prepared.getLengthSync(status, i);
            const nullable =
              typeof prepared.isNullableSync === 'function'
                ? Boolean(prepared.isNullableSync(status, i))
                : (rawType & 1) !== 0;
            const name =
              typeof prepared.getAliasSync === 'function'
                ? prepared.getAliasSync(status, i)
                : '';

            fields.push({
              name,
              type,
              typeName: firebirdTypeName(type, scale),
              subType,
              scale,
              length,
              nullable,
            });

            if (COERCE_TO_VARYING.has(type)) {
              builder.setTypeSync(status, i, SQL_VARYING);
              builder.setSubTypeSync(status, i, 0);
              builder.setLengthSync(status, i, 64);
              builder.setCharSetSync(status, i, CS_UTF8);
              builder.setScaleSync(status, i, 0);
            } else if (type === SQL_D_FLOAT) {
              builder.setTypeSync(status, i, SQL_DOUBLE);
              builder.setLengthSync(status, i, 8);
              builder.setScaleSync(status, i, 0);
            }
          }
          outMetadata = builder.getMetadataSync(status);
        } finally {
          builder.releaseSync();
        }

        const descriptors: OutputDescriptor[] = [];
        for (let i = 0; i < count; i++) {
          descriptors.push({
            msgType: outMetadata.getTypeSync(status, i) & ~1,
            preparedType: fields[i]!.type!,
            subType: fields[i]!.subType ?? 0,
            scale: fields[i]!.scale ?? 0,
            length: outMetadata.getLengthSync(status, i),
            preparedLength: fields[i]!.length ?? 0,
            charSet: outMetadata.getCharSetSync(status, i),
            preparedCharSet: prepared.getCharSetSync(status, i),
            offset: outMetadata.getOffsetSync(status, i),
            nullOffset: outMetadata.getNullOffsetSync(status, i),
          });
        }

        binding.fields = fields;
        binding.outDescriptors = descriptors;
        binding.originalOut = {
          outMetadata: internal.outMetadata,
          outBuffer: internal.outBuffer,
          dataReader: internal.dataReader,
        };
        binding.customOut = outMetadata;
        hookDispose(internal, binding);

        internal.outMetadata = outMetadata;
        internal.outBuffer = new Uint8Array(outMetadata.getMessageLengthSync(status));
        internal.dataReader = createOutputDataReader(descriptors);
      } finally {
        prepared.releaseSync();
      }
    });
  } catch {
    // Fall back to the driver's own output metadata if internals differ.
  }
}

function createOutputDataReader(
  descriptors: OutputDescriptor[],
): (attachment: unknown, transaction: unknown, buffer: Uint8Array) => Promise<unknown[]> {
  return async (attachment, _transaction, buffer) => {
    const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const row = new Array<unknown>(descriptors.length);
    for (let i = 0; i < descriptors.length; i++) {
      const d = descriptors[i]!;
      if (dataView.getInt16(d.nullOffset, littleEndian) === -1) {
        row[i] = null;
      } else {
        row[i] = readColumnValue(d, attachment, buffer, dataView);
      }
    }
    return row;
  };
}

function readColumnValue(
  d: OutputDescriptor,
  attachment: unknown,
  buffer: Uint8Array,
  dataView: DataView,
): unknown {
  switch (d.msgType) {
    case SQL_TEXT: {
      const raw = buffer.subarray(d.offset, d.offset + d.length);
      if ((d.preparedCharSet & 0xff) === CHARSET_OCTETS) {
        return Buffer.from(raw);
      }
      const byteLen = charTextLength(raw, d.length, d.preparedCharSet);
      return decodeText(raw.subarray(0, byteLen), d.preparedCharSet, attachment);
    }

    case SQL_VARYING: {
      const varLength = dataView.getUint16(d.offset, littleEndian);
      const raw = buffer.subarray(d.offset + 2, d.offset + 2 + varLength);
      if ((d.preparedCharSet & 0xff) === CHARSET_OCTETS) {
        return Buffer.from(raw);
      }
      const text = decodeText(raw, d.charSet, attachment);
      if (d.preparedType === SQL_TIMESTAMP_TZ) {
        return text.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
      }
      return text;
    }

    case SQL_SHORT: {
      const val = dataView.getInt16(d.offset, littleEndian);
      return d.scale !== 0 ? formatScaledDecimal(BigInt(val), d.scale) : val;
    }

    case SQL_LONG: {
      const val = dataView.getInt32(d.offset, littleEndian);
      return d.scale !== 0 ? formatScaledDecimal(BigInt(val), d.scale) : val;
    }

    case SQL_INT64: {
      const val = dataView.getBigInt64(d.offset, littleEndian);
      if (d.scale !== 0) return formatScaledDecimal(val, d.scale);
      return val >= -SAFE_INT64 && val <= SAFE_INT64 ? Number(val) : val.toString();
    }

    case SQL_FLOAT: {
      const val = dataView.getFloat32(d.offset, littleEndian);
      return Number.isFinite(val) ? Number(val.toPrecision(9)) : null;
    }

    case SQL_DOUBLE: {
      const val = dataView.getFloat64(d.offset, littleEndian);
      return Number.isFinite(val) ? val : null;
    }

    case SQL_BOOLEAN:
      return dataView.getInt8(d.offset) !== 0;

    case SQL_TYPE_DATE:
      return formatDate(dataView.getInt32(d.offset, littleEndian));

    case SQL_TYPE_TIME:
      return formatTime(dataView.getUint32(d.offset, littleEndian));

    case SQL_TIMESTAMP:
      return `${formatDate(dataView.getInt32(d.offset, littleEndian))}T${formatTime(
        dataView.getUint32(d.offset + 4, littleEndian),
      )}`;

    case SQL_BLOB:
      return new FbBlob(attachment as Attachment, buffer.slice(d.offset, d.offset + 8));

    case SQL_NULL:
    default:
      return null;
  }
}

/**
 * How many bytes of a `CHAR(n)` buffer represent its `n` characters.
 * Mirrors `charTextLength` in `fb_wasm_api.cpp`.
 */
function charTextLength(data: Uint8Array, length: number, charSet: number): number {
  const cs = charSet & 0xff;
  const bytesPerChar = cs === CS_UTF8 ? 4 : cs === CS_UNICODE_FSS ? 3 : 1;
  if (bytesPerChar === 1) return length;

  const chars = Math.floor(length / bytesPerChar);
  let pos = 0;
  for (let n = 0; n < chars && pos < length; n++) {
    const c = data[pos]!;
    pos += c < 0x80 ? 1 : (c >> 5) === 0x6 ? 2 : (c >> 4) === 0xe ? 3 : (c >> 3) === 0x1e ? 4 : 1;
  }
  return pos < length ? pos : length;
}

function decodeText(bytes: Uint8Array, charSet: number, attachment: unknown): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if ((charSet & 0xff) === 0) {
    const noneCharset = (attachment as { charSetForNONE?: string } | undefined)?.charSetForNONE;
    if (noneCharset && noneCharset.toLowerCase() !== 'utf8' && noneCharset.toLowerCase() !== 'utf-8') {
      try {
        return new TextDecoder(noneCharset).decode(bytes);
      } catch {
        // fall through to utf8
      }
    }
  }
  return buf.toString('utf8');
}

/** Firebird `ISC_DATE` (days since 1858-11-17) to `'YYYY-MM-DD'`. */
function formatDate(iscDate: number): string {
  let nday = (iscDate + 2400001 - 1721119) | 0;
  const century = ((4 * nday - 1) / 146097) | 0;
  nday = (4 * nday - 1 - 146097 * century) | 0;
  let d = (nday / 4) | 0;

  nday = ((4 * d + 3) / 1461) | 0;
  d = (4 * d + 3 - 1461 * nday) | 0;
  d = ((d + 4) / 4) | 0;

  let m = ((5 * d - 3) / 153) | 0;
  d = (5 * d - 3 - 153 * m) | 0;
  d = ((d + 5) / 5) | 0;

  let y = (100 * century + nday) | 0;
  if (m < 10) {
    m += 3;
  } else {
    m -= 9;
    y += 1;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Firebird `ISC_TIME` (1/10000 s since midnight) to `'HH:MM:SS.ffff'`. */
function formatTime(iscTime: number): string {
  const hours = Math.floor(iscTime / 36_000_000);
  let rem = iscTime % 36_000_000;
  const minutes = Math.floor(rem / 600_000);
  rem %= 600_000;
  const seconds = Math.floor(rem / 10_000);
  const fractions = rem % 10_000;
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}.${String(fractions).padStart(4, '0')}`
  );
}

/** Scaled integer (`NUMERIC` / `DECIMAL`) to exact decimal string. */
function formatScaledDecimal(value: bigint, scale: number): string {
  if (scale >= 0) {
    return value === 0n ? '0' : `${value}${'0'.repeat(scale)}`;
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const decimals = -scale;
  const padded = digits.length <= decimals ? digits.padStart(decimals + 1, '0') : digits;
  const dot = padded.length - decimals;
  return `${negative ? '-' : ''}${padded.slice(0, dot)}.${padded.slice(dot)}`;
}

/**
 * Resolve `SQL_BLOB` handles and `OCTETS` byte buffers in `rawRows` after a
 * fetch call completes (when no pipelined `fetchNextAsync` call is in flight
 * on the attachment).
 */
export async function resolveOutputRows(
  stmt: Statement,
  transaction: Transaction,
  fields: FieldInfo[],
  rawRows: unknown[][],
  types: TypeOptions | undefined,
): Promise<void> {
  if (rawRows.length === 0) return;

  const binaryBlobs = types?.binary === true;
  const attachment = (stmt as unknown as NativeStatement).attachment;
  const outDescriptors = bindings.get(stmt)?.outDescriptors;

  for (const row of rawRows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (cell === null || cell === undefined) continue;

      const field = fields[i];
      const type = (field?.type ?? 0) & ~1;

      if (
        cell instanceof FbBlob ||
        (type === SQL_BLOB &&
          typeof cell === 'object' &&
          !(cell instanceof Uint8Array) &&
          'id' in (cell as Record<string, unknown>))
      ) {
        if (typeof attachment?.openBlob !== 'function') continue;
        const bytes = await readBlobBytes(attachment, transaction, cell as FbBlob);
        if (field?.subType === 1) {
          const charSet = outDescriptors?.[i]?.preparedCharSet ?? CS_UTF8;
          row[i] = decodeText(bytes, charSet, attachment);
        } else {
          row[i] = binaryBlobs ? new Uint8Array(bytes) : bytes.toString('base64');
        }
      } else if (Buffer.isBuffer(cell) || cell instanceof Uint8Array) {
        const buf = Buffer.isBuffer(cell)
          ? cell
          : Buffer.from(cell.buffer, cell.byteOffset, cell.byteLength);
        if (type === SQL_BLOB && field?.subType === 1) {
          row[i] = buf.toString('utf8');
        } else {
          row[i] = binaryBlobs ? new Uint8Array(buf) : buf.toString('base64');
        }
      }
    }
  }
}

async function readBlobBytes(
  attachment: Attachment,
  transaction: Transaction,
  blob: FbBlob,
): Promise<Buffer> {
  const stream = await attachment.openBlob(transaction, blob);
  try {
    const chunks: Buffer[] = [];
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const n = await stream.read(buffer);
      if (n < 0) break;
      if (n > 0) chunks.push(buffer.subarray(0, n));
    }
    return Buffer.concat(chunks);
  } finally {
    await stream.close().catch(() => undefined);
  }
}

/**
 * The parameters as the driver will take them, the statement made ready to
 * take them.
 *
 * A `Uint8Array` or `ArrayBuffer` goes on as a Buffer, the driver's bytes.
 *
 * A string or Buffer bound to a BLOB parameter is written to a new blob here,
 * and the blob passed on. The driver takes a Buffer or a Blob there and
 * refused a string ("Unrecognized type used as BLOB"); and given a Buffer,
 * it writes the blob while encoding the other parameters, under a
 * `Promise.all` that rejects as soon as one of them fails, with the blob's
 * native calls still running. The transaction is then rolled back under
 * them, and the process died with a segmentation fault: a date given as a
 * string beside a BLOB did it, so did a string too long for its VARCHAR.
 * Written first, the blob is done before the driver encodes anything, and
 * nothing is in flight when a parameter fails.
 *
 * A string bound to a DATE, TIME or TIMESTAMP parameter (with or without a
 * time zone) is sent as text, and Firebird converts it: the driver takes a
 * JS `Date` there (`date.getFullYear is not a function` for a string),
 * which holds milliseconds where Firebird keeps 1/10000 s, and is read in
 * the process's time zone. The browser engine binds every parameter as text,
 * so the same call now means the same there and here, to the last digit.
 * A `Date` still goes the driver's way.
 *
 * So does a string or `bigint` bound to a SMALLINT, INTEGER, BIGINT or
 * NUMERIC parameter: the driver binds those as doubles, and
 * `'9007199254740993'` arrived as 9007199254740992, `'0.1'` in a
 * NUMERIC(18,17) as 0.10000000000000001. A JS number still goes as a double
 * (it is one); a string to a DOUBLE PRECISION or FLOAT parameter is still
 * converted by JS, which rounds correctly.
 */
export async function openNativeQueryBlobStream(
  attachment: Attachment,
  transaction: Transaction,
  statements: StatementCache,
  sql: string,
  serializedParams: QueryParams,
  options: BlobStreamOptions,
  ownsTransaction: boolean,
  assertUsable?: () => void,
): Promise<ReadableStream<Uint8Array>> {
  const lease = await statements.acquire(transaction, sql);
  const stmt = lease.stmt;
  let failed = true;
  let cell: unknown;

  try {
    const fields = await outputFields(stmt);
    const colIndex = resolveBlobColumnIndex(
      options.column,
      fields.map((f) => f.name),
    );
    if (fields[colIndex]!.typeName !== 'BLOB') {
      throw new Error(
        `openBlobStream: column "${fields[colIndex]!.name}" is ${fields[colIndex]!.typeName}, not BLOB`,
      );
    }

    const bound = await bindParams(stmt, transaction, serializedParams);
    const rs = await stmt.executeQuery(transaction, bound);
    try {
      const rawRows = (await rs.fetch({ fetchSize: 1 })) as unknown[][];
      if (rawRows.length === 0) {
        throw new Error('openBlobStream: query returned no rows');
      }
      cell = rawRows[0]![colIndex];
    } finally {
      await rs.close().catch(() => undefined);
    }
    failed = false;
  } finally {
    await lease.release(failed);
  }

  if (cell === null || cell === undefined) {
    throw new Error('openBlobStream: BLOB column value is NULL');
  }

  if (
    (cell instanceof FbBlob ||
      (typeof cell === 'object' &&
        !(cell instanceof Uint8Array) &&
        'id' in (cell as Record<string, unknown>))) &&
    typeof attachment.openBlob === 'function'
  ) {
    const stream = await attachment.openBlob(transaction, cell as FbBlob);
    return buildBlobReadableStream(
      {
        readSegment: async (maxBytes) => {
          assertUsable?.();
          const buf = Buffer.alloc(maxBytes);
          const n = await stream.read(buf);
          if (n < 0) return null;
          return new Uint8Array(buf.buffer, buf.byteOffset, n);
        },
        close: async () => {
          await stream.close().catch(() => undefined);
          if (ownsTransaction) {
            await transaction
              .commit()
              .catch(() => transaction.rollback().catch(() => undefined));
          }
        },
      },
      options,
    );
  }

  const bytes = Buffer.isBuffer(cell)
    ? new Uint8Array(cell.buffer, cell.byteOffset, cell.byteLength)
    : cell instanceof Uint8Array
      ? cell
      : typeof cell === 'string'
        ? new TextEncoder().encode(cell)
        : new Uint8Array(0);

  if (ownsTransaction) {
    await transaction
      .commit()
      .catch(() => transaction.rollback().catch(() => undefined));
  }

  let offset = 0;
  return buildBlobReadableStream(
    {
      readSegment: async (maxBytes) => {
        assertUsable?.();
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

export async function bindParams(stmt: Statement, transaction: Transaction, given: QueryParams): Promise<QueryParams> {
  given = given.map((p, idx) => {
    const handle = extractBlobHandle(p, idx);
    if (!handle) return p;
    const staged = handle[BLOB_INTERNAL_DATA]?.stagedBytes;
    if (staged) {
      return Buffer.from(staged.buffer, staged.byteOffset, staged.byteLength);
    }
    const nativeBlob = handle[BLOB_INTERNAL_DATA]?.nativeBlob;
    if (nativeBlob) {
      return nativeBlob;
    }
    const attachment = (stmt as unknown as NativeStatement).attachment;
    return attachment ? new FbBlob(attachment, handle.blobId) : p;
  });
  // Bytes as the driver takes them: a Buffer (the browser engine takes a
  // Uint8Array or an ArrayBuffer, so the same call works on both).
  const params = given.some((p) => p instanceof Uint8Array || p instanceof ArrayBuffer)
    ? given.map((p) => p instanceof ArrayBuffer
      ? Buffer.from(p)
      : p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p)
    : given;
  const binding = bindings.get(stmt);
  if (
    !params.some((p) => typeof p === 'string' || typeof p === 'bigint' || Buffer.isBuffer(p)) &&
    (!binding || binding.current === '')
  ) {
    return params;
  }
  const described = (binding ?? (await bindingOf(stmt))).params;
  if (!described) return params;

  const text: number[] = [];
  const bound: unknown[] = [...params];
  for (let i = 0; i < bound.length; i++) {
    let p = bound[i];
    if (typeof p === 'bigint') {
      p = p.toString();
      bound[i] = p;
    }
    const type = (described[i]?.type ?? 0) & ~1;
    if (type === SQL_BLOB && (typeof p === 'string' || Buffer.isBuffer(p))) {
      bound[i] = await writeBlob(stmt, transaction, typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
    } else if (typeof p === 'string' && TEXT_TYPES.has(type)) {
      text.push(i);
    }
  }
  if (!(await useMessage(stmt, text))) return params;
  return bound as QueryParams;
}

/** A new blob holding `bytes`, in `transaction`; `bytes` itself where the driver's internals are not there. */
export async function writeBlob(stmt: Statement, transaction: Transaction, bytes: Buffer): Promise<unknown> {
  const attachment = (stmt as unknown as NativeStatement).attachment;
  if (typeof attachment?.createBlob !== 'function') return bytes;
  const stream = await attachment.createBlob(transaction);
  try {
    await stream.write(bytes);
  } catch (err) {
    await stream.cancel().catch(() => undefined);
    throw err;
  }
  await stream.close();
  return stream.blob;
}

/**
 * Put in place the input message that takes the parameters at `positions`
 * as VARCHAR text and every other as the driver prepared it, making it the
 * first time. False when that cannot be done: the driver's internals are not
 * what this expects.
 *
 * The message is what the driver encodes into and what Firebird reads from;
 * Firebird converts each value from the message's type to the parameter's,
 * which is how the driver itself binds every integer as a double. A
 * statement is used by one call at a time (the cache leases it), so the
 * message in place is the one this call chose.
 */
export async function useMessage(stmt: Statement, positions: number[]): Promise<boolean> {
  const binding = await bindingOf(stmt);
  const key = positions.join(',');
  if (binding.current === key) return true;
  const internal = stmt as unknown as NativeStatement;

  let message = key === '' ? binding.original : binding.variants.get(key);
  if (!message) {
    const made = await makeTextMessage(internal, binding, positions);
    if (!made) return positions.length === 0;
    if (!binding.original) {
      binding.original = {
        inMetadata: internal.inMetadata!,
        inBuffer: internal.inBuffer!,
        dataWriter: internal.dataWriter,
      };
      hookDispose(internal, binding);
    }
    binding.variants.set(key, made);
    message = made;
  }
  internal.inMetadata = message.inMetadata;
  internal.inBuffer = message.inBuffer;
  internal.dataWriter = message.dataWriter;
  binding.current = key;
  return true;
}

let driverUtil: { createDataWriter(d: unknown): unknown; createDescriptors(s: unknown, m: unknown): unknown } | null | undefined;

async function makeTextMessage(
  internal: NativeStatement,
  binding: Binding,
  positions: number[],
): Promise<InputMessage | undefined> {
  if (driverUtil === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      driverUtil = require('node-firebird-driver-native/dist/lib/fb-util');
      if (typeof driverUtil?.createDataWriter !== 'function' || typeof driverUtil.createDescriptors !== 'function') {
        driverUtil = null;
      }
    } catch {
      driverUtil = null;
    }
  }
  const util = driverUtil;
  // Made from the driver's own message, whichever is in place.
  const base = binding.original?.inMetadata ?? internal.inMetadata;
  const client = internal.attachment?.client;
  if (!util || !base || typeof base.getBuilderSync !== 'function' || typeof client?.statusAction !== 'function') {
    return undefined;
  }
  return client.statusAction(async (status) => {
    const builder = base.getBuilderSync(status);
    let inMetadata: NativeMetadata;
    try {
      for (const i of positions) {
        builder.setTypeSync(status, i, SQL_VARYING);
        builder.setSubTypeSync(status, i, 0);
        builder.setLengthSync(status, i, TEXT_LENGTH);
        builder.setCharSetSync(status, i, CS_UTF8);
        builder.setScaleSync(status, i, 0);
      }
      inMetadata = builder.getMetadataSync(status);
    } finally {
      builder.releaseSync();
    }
    return {
      inMetadata,
      inBuffer: new Uint8Array(inMetadata.getMessageLengthSync(status)),
      dataWriter: util.createDataWriter(util.createDescriptors(status, inMetadata)),
    };
  });
}

/**
 * Hand the driver back its own input/output messages when the statement is
 * disposed, for it to release as it always does, and release the ones made
 * here.
 */
function hookDispose(internal: NativeStatement, binding: Binding): void {
  if (binding.disposeHooked) return;
  const dispose = internal.internalDispose;
  if (typeof dispose !== 'function') return;
  binding.disposeHooked = true;
  internal.internalDispose = async function (this: NativeStatement) {
    if (binding.original) {
      internal.inMetadata = binding.original.inMetadata;
      internal.inBuffer = binding.original.inBuffer;
      internal.dataWriter = binding.original.dataWriter;
    }
    for (const message of binding.variants.values()) message.inMetadata.releaseSync();
    binding.variants.clear();
    binding.current = '';
    if (binding.customOut) {
      if (binding.originalOut) {
        internal.outMetadata = binding.originalOut.outMetadata;
        internal.outBuffer = binding.originalOut.outBuffer;
        internal.dataReader = binding.originalOut.dataReader;
      }
      binding.customOut.releaseSync();
      binding.customOut = undefined;
    }
    return dispose.call(this);
  };
}


export {
  tryExecuteNativeBatch,
  characterSets,
  StatementCache,
  fetchRows,
  streamRows,
  shapeRows,
  buildTransactionOptions,
  type StatementLease,
} from './node-native-batch';
