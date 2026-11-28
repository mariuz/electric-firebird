/**
 * pgwire/protocol.ts – Zero-Dependency PostgreSQL v3 Binary Frontend/Backend Wire Protocol
 * State Machine (`createPgWireSession`, `PgTypeOid`, `encodePg*`) (`M32 Item 3`).
 *
 * Browser & WinterCG safe (zero `node:*` imports) — runs over WebSockets, Duplex streams,
 * or `node:net` TCP via `pgwire/server.ts`.
 */

import type { FieldInfo, QueryParams, QueryResult, Row } from '../types';
import { rewritePositionalPlaceholders } from '../prisma';

export const PG_PROTOCOL_V3 = 196608; // (3 << 16) | 0
export const PG_SSL_REQUEST_CODE = 80877103;
export const PG_CANCEL_REQUEST_CODE = 80877102;

/** Standard PostgreSQL `pg_type` OIDs mapped from Firebird `FieldInfo`. */
export const PgTypeOid = {
  BOOL: 16,
  BYTEA: 17,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  FLOAT4: 700,
  FLOAT8: 701,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  JSONB: 3802,
} as const;

export interface PgWireDatabase {
  query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: { rowMode?: 'array' | 'object' },
  ): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
}

export interface PgWireAuthOptions {
  /** Authentication mode (`'trust'` accepts any user; `'cleartext'` verifies password). @default 'trust' */
  readonly mode?: 'trust' | 'cleartext';
  readonly username?: string;
  readonly password?: string;
  readonly validateCredentials?: (username: string, password: string) => boolean | Promise<boolean>;
}

export interface PgWireSessionOptions {
  readonly auth?: PgWireAuthOptions;
  readonly serverVersion?: string;
  readonly backendPid?: number;
  readonly secretKey?: number;
}

export interface PgWireSession {
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly databaseName: string | null;
  readonly txStatus: 'I' | 'T' | 'E';
  /** Feed incoming client bytes and receive concatenated PostgreSQL v3 backend response frames. */
  feed(chunk: Uint8Array): Promise<{ response: Uint8Array; closed: boolean }>;
}

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

function concatUint8(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function cString(str: string): Uint8Array {
  const b = textEnc.encode(str);
  const out = new Uint8Array(b.byteLength + 1);
  out.set(b, 0);
  out[b.byteLength] = 0;
  return out;
}

function readCString(buf: Uint8Array, offset: number): { value: string; nextOffset: number } {
  let end = offset;
  while (end < buf.byteLength && buf[end] !== 0) end++;
  return {
    value: textDec.decode(buf.subarray(offset, end)),
    nextOffset: Math.min(buf.byteLength, end + 1),
  };
}

/** Frame a PostgreSQL v3 Backend message: `[type: 1B][len: Int32BE (4 + payload.length)][payload]`. */
export function buildPgBackendFrame(typeChar: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = typeChar.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + payload.byteLength, false);
  out.set(payload, 5);
  return out;
}

export function encodePgAuthOk(): Uint8Array {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, 0, false);
  return buildPgBackendFrame('R', p);
}

export function encodePgAuthCleartext(): Uint8Array {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, 3, false); // AuthenticationCleartextPassword = 3
  return buildPgBackendFrame('R', p);
}

export function encodePgParameterStatus(name: string, value: string): Uint8Array {
  return buildPgBackendFrame('S', concatUint8([cString(name), cString(value)]));
}

export function encodePgBackendKeyData(pid: number, secretKey: number): Uint8Array {
  const p = new Uint8Array(8);
  const dv = new DataView(p.buffer);
  dv.setInt32(0, pid, false);
  dv.setInt32(4, secretKey, false);
  return buildPgBackendFrame('K', p);
}

export function encodePgReadyForQuery(txStatus: 'I' | 'T' | 'E'): Uint8Array {
  return buildPgBackendFrame('Z', new Uint8Array([txStatus.charCodeAt(0)]));
}

export function encodePgErrorResponse(message: string, sqlState = '42000', severity = 'ERROR'): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array(['S'.charCodeAt(0)]),
    cString(severity),
    new Uint8Array(['V'.charCodeAt(0)]),
    cString(severity),
    new Uint8Array(['C'.charCodeAt(0)]),
    cString(sqlState),
    new Uint8Array(['M'.charCodeAt(0)]),
    cString(message),
    new Uint8Array([0]),
  ];
  return buildPgBackendFrame('E', concatUint8(parts));
}

export function mapFirebirdFieldToPgOid(field: FieldInfo): { oid: number; size: number } {
  const tn = (field.typeName ?? '').toUpperCase();
  if ((field.scale ?? 0) < 0 || tn === 'NUMERIC' || tn === 'DECFLOAT16' || tn === 'DECFLOAT34') {
    return { oid: PgTypeOid.NUMERIC, size: -1 };
  }
  switch (tn) {
    case 'BOOLEAN':
      return { oid: PgTypeOid.BOOL, size: 1 };
    case 'SMALLINT':
      return { oid: PgTypeOid.INT2, size: 2 };
    case 'INTEGER':
      return { oid: PgTypeOid.INT4, size: 4 };
    case 'BIGINT':
    case 'INT128':
      return { oid: PgTypeOid.INT8, size: 8 };
    case 'FLOAT':
      return { oid: PgTypeOid.FLOAT4, size: 4 };
    case 'DOUBLE':
      return { oid: PgTypeOid.FLOAT8, size: 8 };
    case 'DATE':
      return { oid: PgTypeOid.DATE, size: 4 };
    case 'TIME':
    case 'TIME_TZ':
      return { oid: PgTypeOid.TIME, size: 8 };
    case 'TIMESTAMP':
      return { oid: PgTypeOid.TIMESTAMP, size: 8 };
    case 'TIMESTAMP_TZ':
      return { oid: PgTypeOid.TIMESTAMPTZ, size: 8 };
    case 'BLOB':
      return field.subType === 1
        ? { oid: PgTypeOid.TEXT, size: -1 }
        : { oid: PgTypeOid.BYTEA, size: -1 };
    default:
      return { oid: PgTypeOid.VARCHAR, size: -1 };
  }
}

export function encodePgRowDescription(fields: readonly FieldInfo[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const countBuf = new Uint8Array(2);
  new DataView(countBuf.buffer).setInt16(0, fields.length, false);
  parts.push(countBuf);

  for (const f of fields) {
    parts.push(cString(f.name.toLowerCase()));
    const meta = new Uint8Array(18);
    const dv = new DataView(meta.buffer);
    const { oid, size } = mapFirebirdFieldToPgOid(f);
    dv.setInt32(0, 0, false); // table OID
    dv.setInt16(4, 0, false); // attr num
    dv.setInt32(6, oid, false); // data type OID
    dv.setInt16(10, size, false); // data type size
    dv.setInt32(12, -1, false); // type modifier
    dv.setInt16(16, 0, false); // format code = 0 (text)
    parts.push(meta);
  }
  return buildPgBackendFrame('T', concatUint8(parts));
}

function serializePgTextCell(val: unknown): Uint8Array | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return textEnc.encode(val ? 't' : 'f');
  if (val instanceof Date) return textEnc.encode(val.toISOString());
  if (val instanceof Uint8Array) {
    let hex = '\\x';
    for (let i = 0; i < val.byteLength; i++) hex += val[i]!.toString(16).padStart(2, '0');
    return textEnc.encode(hex);
  }
  if (typeof val === 'object') return textEnc.encode(JSON.stringify(val));
  return textEnc.encode(String(val));
}

export function encodePgDataRow(cells: readonly unknown[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const countBuf = new Uint8Array(2);
  new DataView(countBuf.buffer).setInt16(0, cells.length, false);
  parts.push(countBuf);

  for (const c of cells) {
    const encoded = serializePgTextCell(c);
    const lenBuf = new Uint8Array(4);
    if (encoded === null) {
      new DataView(lenBuf.buffer).setInt32(0, -1, false);
      parts.push(lenBuf);
    } else {
      new DataView(lenBuf.buffer).setInt32(0, encoded.byteLength, false);
      parts.push(lenBuf, encoded);
    }
  }
  return buildPgBackendFrame('D', concatUint8(parts));
}

export function encodePgCommandComplete(tag: string): Uint8Array {
  return buildPgBackendFrame('C', cString(tag));
}

export const encodePgEmptyQuery = (): Uint8Array => buildPgBackendFrame('I', new Uint8Array(0));
export const encodePgParseComplete = (): Uint8Array => buildPgBackendFrame('1', new Uint8Array(0));
export const encodePgBindComplete = (): Uint8Array => buildPgBackendFrame('2', new Uint8Array(0));
export const encodePgCloseComplete = (): Uint8Array => buildPgBackendFrame('3', new Uint8Array(0));
export const encodePgNoData = (): Uint8Array => buildPgBackendFrame('n', new Uint8Array(0));

export function encodePgParameterDescription(paramCount: number): Uint8Array {
  const buf = new Uint8Array(2 + paramCount * 4);
  const dv = new DataView(buf.buffer);
  dv.setInt16(0, paramCount, false);
  for (let i = 0; i < paramCount; i++) {
    dv.setInt32(2 + i * 4, PgTypeOid.TEXT, false);
  }
  return buildPgBackendFrame('t', buf);
}

/** Rewrite common `pg_catalog` / `information_schema` / Postgres session commands for Firebird (`M32 Item 3`). */
export function translatePgCompatSql(
  rawSql: string,
  serverVersion: string,
):
  | { kind: 'noop'; tag: string }
  | { kind: 'tx'; action: 'BEGIN' | 'COMMIT' | 'ROLLBACK' }
  | { kind: 'synthetic'; fields: FieldInfo[]; rows: unknown[][] }
  | { kind: 'firebird'; sql: string; isSelect: boolean } {
  const trimmed = rawSql.trim().replace(/;+\s*$/, '').trim();
  if (!trimmed) return { kind: 'noop', tag: '' };

  if (/^BEGIN(\s+TRANSACTION|\s+WORK)?$/i.test(trimmed) || /^START\s+TRANSACTION/i.test(trimmed)) {
    return { kind: 'tx', action: 'BEGIN' };
  }
  if (/^COMMIT(\s+TRANSACTION|\s+WORK)?$/i.test(trimmed) || /^END(\s+TRANSACTION)?$/i.test(trimmed)) {
    return { kind: 'tx', action: 'COMMIT' };
  }
  if (/^ROLLBACK(\s+TRANSACTION|\s+WORK)?$/i.test(trimmed)) {
    return { kind: 'tx', action: 'ROLLBACK' };
  }
  if (/^SET\s+/i.test(trimmed)) return { kind: 'noop', tag: 'SET' };
  if (/^(DISCARD\s+ALL|DEALLOCATE\s+ALL|UNLISTEN\s+\*)/i.test(trimmed)) {
    return { kind: 'noop', tag: trimmed.split(/\s+/)[0]!.toUpperCase() };
  }
  if (/^SHOW\s+TRANSACTION\s+ISOLATION\s+LEVEL$/i.test(trimmed)) {
    return {
      kind: 'synthetic',
      fields: [{ name: 'transaction_isolation', typeName: 'VARYING' }],
      rows: [['read committed']],
    };
  }
  if (/^SHOW\s+/i.test(trimmed)) {
    return {
      kind: 'synthetic',
      fields: [{ name: 'setting', typeName: 'VARYING' }],
      rows: [['UTF8']],
    };
  }
  if (/^SELECT\s+version\s*\(\s*\)/i.test(trimmed)) {
    return {
      kind: 'synthetic',
      fields: [{ name: 'version', typeName: 'VARYING' }],
      rows: [[`PostgreSQL ${serverVersion} on wasm32-electric-firebird`]],
    };
  }
  if (/^SELECT\s+current_schema\s*\(\s*\)/i.test(trimmed)) {
    return {
      kind: 'synthetic',
      fields: [{ name: 'current_schema', typeName: 'VARYING' }],
      rows: [['public']],
    };
  }
  if (/^SELECT\s+current_database\s*\(\s*\)/i.test(trimmed)) {
    return {
      kind: 'synthetic',
      fields: [{ name: 'current_database', typeName: 'VARYING' }],
      rows: [['firebird']],
    };
  }
  if (/information_schema\.tables/i.test(trimmed)) {
    return {
      kind: 'firebird',
      isSelect: true,
      sql: `SELECT 'public' AS "table_schema", LOWER(TRIM(RDB$RELATION_NAME)) AS "table_name", 'BASE TABLE' AS "table_type"
              FROM RDB$RELATIONS
             WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL
             ORDER BY RDB$RELATION_NAME`,
    };
  }
  if (/information_schema\.columns/i.test(trimmed)) {
    return {
      kind: 'firebird',
      isSelect: true,
      sql: `SELECT 'public' AS "table_schema",
                   LOWER(TRIM(rf.RDB$RELATION_NAME)) AS "table_name",
                   LOWER(TRIM(rf.RDB$FIELD_NAME)) AS "column_name",
                   rf.RDB$FIELD_POSITION + 1 AS "ordinal_position"
              FROM RDB$RELATION_FIELDS rf
              JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = rf.RDB$RELATION_NAME
             WHERE COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0
             ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`,
    };
  }

  // Standalone `SELECT <expr>` without `FROM` (e.g. `SELECT 1 + 1 AS sum` or `SELECT $1::text`)
  let fbSql = trimmed.replace(/::[a-zA-Z_][a-zA-Z0-9_]*(?:\[\])?/g, '');
  if (/^SELECT\b/i.test(fbSql) && !/\bFROM\b/i.test(fbSql)) {
    fbSql = `${fbSql} FROM RDB$DATABASE`;
  }
  const isSelect = /^\s*(SELECT|WITH)\b/i.test(fbSql) || /\bRETURNING\b/i.test(fbSql);
  return { kind: 'firebird', sql: fbSql, isSelect };
}

interface PreparedStmtEntry {
  readonly name: string;
  readonly rawSql: string;
  readonly paramCount: number;
}

interface BoundPortalEntry {
  readonly name: string;
  readonly stmt: PreparedStmtEntry;
  readonly args: unknown[];
}

function countPositionalParams(sql: string): number {
  let maxIdx = 0;
  const re = /\$(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const idx = Number(m[1]);
    if (idx > maxIdx) maxIdx = idx;
  }
  return maxIdx;
}

/**
 * Create a stateful PostgreSQL v3 wire protocol session over a `FirebirdDatabase` (`M32 Item 3`).
 */
export function createPgWireSession(
  db: PgWireDatabase,
  options: PgWireSessionOptions = {},
): PgWireSession {
  const serverVersion = options.serverVersion ?? '16.0 (electric-firebird)';
  const pid = options.backendPid ?? 4201;
  const secretKey = options.secretKey ?? 0x51a7e32;
  const authMode = options.auth?.mode ?? 'trust';

  let phase: 'startup' | 'await_password' | 'ready' | 'closed' = 'startup';
  let authenticated = false;
  let username: string | null = null;
  let databaseName: string | null = null;
  let txStatus: 'I' | 'T' | 'E' = 'I';
  let buffer: Uint8Array = new Uint8Array(0);

  const statements = new Map<string, PreparedStmtEntry>();
  const portals = new Map<string, BoundPortalEntry>();

  const completeStartupHandshake = (): Uint8Array[] => {
    authenticated = true;
    phase = 'ready';
    return [
      encodePgAuthOk(),
      encodePgParameterStatus('server_version', serverVersion),
      encodePgParameterStatus('server_encoding', 'UTF8'),
      encodePgParameterStatus('client_encoding', 'UTF8'),
      encodePgParameterStatus('DateStyle', 'ISO, MDY'),
      encodePgParameterStatus('integer_datetimes', 'on'),
      encodePgParameterStatus('TimeZone', 'UTC'),
      encodePgBackendKeyData(pid, secretKey),
      encodePgReadyForQuery(txStatus),
    ];
  };

  const executeTranslatedStatement = async (
    rawSql: string,
    args: unknown[],
    maxRows = 0,
    includeRowDescription = true,
  ): Promise<Uint8Array[]> => {
    const frames: Uint8Array[] = [];
    const compat = translatePgCompatSql(rawSql, serverVersion);

    if (compat.kind === 'noop') {
      frames.push(compat.tag ? encodePgCommandComplete(compat.tag) : encodePgEmptyQuery());
      return frames;
    }
    if (compat.kind === 'tx') {
      if (compat.action === 'BEGIN') txStatus = 'T';
      else txStatus = 'I';
      frames.push(encodePgCommandComplete(compat.action));
      return frames;
    }
    if (compat.kind === 'synthetic') {
      if (includeRowDescription) frames.push(encodePgRowDescription(compat.fields));
      const slice = maxRows > 0 ? compat.rows.slice(0, maxRows) : compat.rows;
      for (const r of slice) frames.push(encodePgDataRow(r));
      frames.push(encodePgCommandComplete(`SELECT ${slice.length}`));
      return frames;
    }

    const { sql, params } =
      args.length > 0 ? rewritePositionalPlaceholders(compat.sql, args) : { sql: compat.sql, params: [] };

    if (compat.isSelect) {
      const res = await db.query<Row>(sql, params);
      const fields: FieldInfo[] =
        res.fields && res.fields.length > 0
          ? res.fields
          : res.rows.length > 0
            ? Object.keys(res.rows[0]!).map((k) => ({ name: k, typeName: 'VARYING' }))
            : [];
      if (includeRowDescription) frames.push(encodePgRowDescription(fields));
      const rows = maxRows > 0 ? res.rows.slice(0, maxRows) : res.rows;
      for (const r of rows) {
        if (Array.isArray(r)) {
          frames.push(encodePgDataRow(r));
        } else {
          const cells = fields.map((f) => {
            if (f.name in r) return r[f.name];
            const u = f.name.toUpperCase();
            if (u in r) return r[u];
            return r[f.name.toLowerCase()];
          });
          frames.push(encodePgDataRow(cells));
        }
      }
      frames.push(encodePgCommandComplete(`SELECT ${rows.length}`));
      return frames;
    }

    let affected = 0;
    if (typeof db.execute === 'function') {
      const r = await db.execute(sql, params);
      affected = r.affectedRows ?? 0;
    } else if (typeof db.exec === 'function') {
      await db.exec(sql, params);
    } else {
      await db.query(sql, params);
    }
    const verb = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? 'OK';
    const tag =
      verb === 'INSERT'
        ? `INSERT 0 ${affected}`
        : verb === 'UPDATE' || verb === 'DELETE'
          ? `${verb} ${affected}`
          : verb;
    frames.push(encodePgCommandComplete(tag));
    return frames;
  };

  return {
    get authenticated() {
      return authenticated;
    },
    get username() {
      return username;
    },
    get databaseName() {
      return databaseName;
    },
    get txStatus() {
      return txStatus;
    },

    async feed(chunk: Uint8Array): Promise<{ response: Uint8Array; closed: boolean }> {
      if (phase === 'closed') return { response: new Uint8Array(0), closed: true };
      buffer = buffer.byteLength === 0 ? new Uint8Array(chunk) : concatUint8([buffer, chunk]);
      const outFrames: Uint8Array[] = [];

      while (buffer.byteLength > 0) {
        if (phase === 'startup') {
          if (buffer.byteLength < 8) break;
          const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const msgLen = dv.getInt32(0, false);
          if (msgLen < 8 || buffer.byteLength < msgLen) break;
          const code = dv.getInt32(4, false);
          const pkt = buffer.subarray(0, msgLen);
          buffer = buffer.subarray(msgLen);

          if (code === PG_SSL_REQUEST_CODE) {
            // Decline TLS upgrade with 'N' so client proceeds with v3 StartupMessage
            outFrames.push(new Uint8Array(['N'.charCodeAt(0)]));
            continue;
          }
          if (code === PG_CANCEL_REQUEST_CODE) {
            phase = 'closed';
            return { response: concatUint8(outFrames), closed: true };
          }
          if (code !== PG_PROTOCOL_V3) {
            outFrames.push(encodePgErrorResponse(`Unsupported protocol version: ${code}`, '0A000', 'FATAL'));
            phase = 'closed';
            return { response: concatUint8(outFrames), closed: true };
          }

          let off = 8;
          const kv = new Map<string, string>();
          while (off < pkt.byteLength && pkt[off] !== 0) {
            const k = readCString(pkt, off);
            off = k.nextOffset;
            const v = readCString(pkt, off);
            off = v.nextOffset;
            kv.set(k.value, v.value);
          }
          username = kv.get('user') ?? 'postgres';
          databaseName = kv.get('database') ?? username;

          if (authMode === 'cleartext') {
            phase = 'await_password';
            outFrames.push(encodePgAuthCleartext());
          } else {
            outFrames.push(...completeStartupHandshake());
          }
          continue;
        }

        // Standard 1-byte type + 4-byte length messages
        if (buffer.byteLength < 5) break;
        const msgType = String.fromCharCode(buffer[0]!);
        const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const len = dv.getInt32(1, false);
        if (len < 4 || buffer.byteLength < 1 + len) break;
        const body = buffer.subarray(5, 1 + len);
        buffer = buffer.subarray(1 + len);

        if (phase === 'await_password') {
          if (msgType !== 'p') {
            outFrames.push(encodePgErrorResponse('Expected PasswordMessage', '28P01', 'FATAL'));
            phase = 'closed';
            return { response: concatUint8(outFrames), closed: true };
          }
          const pw = readCString(body, 0).value;
          const ok = options.auth?.validateCredentials
            ? await options.auth.validateCredentials(username ?? '', pw)
            : (options.auth?.username === undefined || options.auth.username === username) &&
              options.auth?.password === pw;
          if (!ok) {
            outFrames.push(
              encodePgErrorResponse(`password authentication failed for user "${username}"`, '28P01', 'FATAL'),
            );
            phase = 'closed';
            return { response: concatUint8(outFrames), closed: true };
          }
          outFrames.push(...completeStartupHandshake());
          continue;
        }

        if (msgType === 'X') {
          phase = 'closed';
          return { response: concatUint8(outFrames), closed: true };
        }

        if (msgType === 'Q') {
          const queryText = readCString(body, 0).value;
          const parts = queryText
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (parts.length === 0) {
            outFrames.push(encodePgEmptyQuery(), encodePgReadyForQuery(txStatus));
            continue;
          }
          try {
            for (const stmt of parts) {
              const frames = await executeTranslatedStatement(stmt, [], 0, true);
              outFrames.push(...frames);
            }
          } catch (err) {
            if (txStatus === 'T') txStatus = 'E';
            outFrames.push(
              encodePgErrorResponse(err instanceof Error ? err.message : String(err)),
            );
          }
          outFrames.push(encodePgReadyForQuery(txStatus));
          continue;
        }

        if (msgType === 'P') {
          // Parse: stmtName\0 + query\0 + int16 numParamTypes + int32[] oids
          const sName = readCString(body, 0);
          const qStr = readCString(body, sName.nextOffset);
          const bodyDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
          const declaredCount =
            qStr.nextOffset + 2 <= body.byteLength ? bodyDv.getInt16(qStr.nextOffset, false) : 0;
          const paramCount = Math.max(declaredCount, countPositionalParams(qStr.value));
          statements.set(sName.value, {
            name: sName.value,
            rawSql: qStr.value,
            paramCount,
          });
          outFrames.push(encodePgParseComplete());
          continue;
        }

        if (msgType === 'B') {
          // Bind: portalName\0 + stmtName\0 + formatCodes + paramValues + resultFormatCodes
          const pName = readCString(body, 0);
          const sName = readCString(body, pName.nextOffset);
          const stmt = statements.get(sName.value);
          if (!stmt) {
            outFrames.push(encodePgErrorResponse(`Prepared statement "${sName.value}" does not exist`, '26000'));
            continue;
          }
          let off = sName.nextOffset;
          const bDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
          const numFormats = bDv.getInt16(off, false);
          off += 2;
          const formats: number[] = [];
          for (let i = 0; i < numFormats; i++) {
            formats.push(bDv.getInt16(off, false));
            off += 2;
          }
          const numParams = bDv.getInt16(off, false);
          off += 2;
          const args: unknown[] = [];
          for (let i = 0; i < numParams; i++) {
            const pLen = bDv.getInt32(off, false);
            off += 4;
            if (pLen === -1) {
              args.push(null);
            } else {
              const fmt = formats.length === 1 ? formats[0]! : (formats[i] ?? 0);
              const slice = body.subarray(off, off + pLen);
              off += pLen;
              if (fmt === 1) {
                const sDv = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
                if (pLen === 4) args.push(sDv.getInt32(0, false));
                else if (pLen === 8) args.push(Number(sDv.getBigInt64(0, false)));
                else if (pLen === 2) args.push(sDv.getInt16(0, false));
                else if (pLen === 1) args.push(slice[0] !== 0);
                else args.push(new Uint8Array(slice));
              } else {
                const txt = textDec.decode(slice);
                if (/^-?\d+$/.test(txt) && Math.abs(Number(txt)) <= Number.MAX_SAFE_INTEGER) {
                  args.push(Number(txt));
                } else {
                  args.push(txt);
                }
              }
            }
          }
          portals.set(pName.value, { name: pName.value, stmt, args });
          outFrames.push(encodePgBindComplete());
          continue;
        }

        if (msgType === 'D') {
          // Describe: 'S' | 'P' + name\0
          const targetKind = String.fromCharCode(body[0]!);
          const name = readCString(body, 1).value;
          if (targetKind === 'S') {
            const stmt = statements.get(name);
            if (!stmt) {
              outFrames.push(encodePgErrorResponse(`Prepared statement "${name}" does not exist`, '26000'));
              continue;
            }
            outFrames.push(encodePgParameterDescription(stmt.paramCount));
            const compat = translatePgCompatSql(stmt.rawSql, serverVersion);
            if (compat.kind === 'synthetic') outFrames.push(encodePgRowDescription(compat.fields));
            else outFrames.push(encodePgNoData());
          } else {
            const portal = portals.get(name);
            if (!portal) {
              outFrames.push(encodePgErrorResponse(`Portal "${name}" does not exist`, '34000'));
              continue;
            }
            const compat = translatePgCompatSql(portal.stmt.rawSql, serverVersion);
            if (compat.kind === 'synthetic') outFrames.push(encodePgRowDescription(compat.fields));
            else outFrames.push(encodePgNoData());
          }
          continue;
        }

        if (msgType === 'E') {
          // Execute: portalName\0 + int32 maxRows
          const pName = readCString(body, 0);
          const eDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
          const maxRows = pName.nextOffset + 4 <= body.byteLength ? eDv.getInt32(pName.nextOffset, false) : 0;
          const portal = portals.get(pName.value);
          if (!portal) {
            outFrames.push(encodePgErrorResponse(`Portal "${pName.value}" does not exist`, '34000'));
            continue;
          }
          try {
            const frames = await executeTranslatedStatement(
              portal.stmt.rawSql,
              portal.args,
              maxRows,
              true,
            );
            outFrames.push(...frames);
          } catch (err) {
            if (txStatus === 'T') txStatus = 'E';
            outFrames.push(
              encodePgErrorResponse(err instanceof Error ? err.message : String(err)),
            );
          }
          continue;
        }

        if (msgType === 'C') {
          const targetKind = String.fromCharCode(body[0]!);
          const name = readCString(body, 1).value;
          if (targetKind === 'S') statements.delete(name);
          else portals.delete(name);
          outFrames.push(encodePgCloseComplete());
          continue;
        }

        if (msgType === 'H') {
          // Flush — frames are flushed at the end of feed()
          continue;
        }

        if (msgType === 'S') {
          if (txStatus === 'E') txStatus = 'I';
          outFrames.push(encodePgReadyForQuery(txStatus));
          continue;
        }
      }

      return { response: concatUint8(outFrames), closed: false };
    },
  };
}
