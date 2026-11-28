/**
 * prisma/index.ts – `@prisma/driver-adapter-utils`-Compatible Driver Adapter
 * (`createFirebirdPrismaAdapter`) + Monotonic `UUIDv7` & `ULID` Generators (`M31 Item 5`).
 */

import type { FieldInfo, IsolationLevel, QueryParams, QueryResult, TransactionOptions } from '../types';

export interface PrismaCompatibleDatabase {
  query(
    sql: string,
    params?: QueryParams,
    options?: { rowMode?: 'array' | 'object' },
  ): Promise<QueryResult<unknown>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<{ affectedRows?: number } | unknown>;
  transaction?<T>(
    fn: (tx: {
      query(
        sql: string,
        params?: QueryParams,
        options?: { rowMode?: 'array' | 'object' },
      ): Promise<QueryResult<unknown>>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
      exec?(sql: string, params?: QueryParams): Promise<{ affectedRows?: number } | unknown>;
    }) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  registerFunction?: (
    name: string,
    options: { args: string[]; returns: string; deterministic?: boolean },
    fn: (...args: unknown[]) => unknown,
  ) => Promise<unknown>;
  close?(): Promise<void>;
}

/** Prisma `@prisma/driver-adapter-utils` ColumnType enum numeric codes. */
export const PrismaColumnType = {
  Int32: 0,
  Int64: 1,
  Float: 2,
  Double: 3,
  Numeric: 4,
  Boolean: 5,
  Character: 6,
  Text: 7,
  Date: 8,
  Time: 9,
  DateTime: 10,
  Json: 11,
  Enum: 12,
  Bytes: 13,
  Uuid: 15,
} as const;

export interface PrismaSqlQuery {
  readonly sql: string;
  readonly args: unknown[];
  readonly argTypes?: unknown[];
}

export interface PrismaSqlResultSet {
  readonly columnNames: string[];
  readonly columnTypes: number[];
  readonly rows: unknown[][];
  readonly lastInsertId?: string;
}

export interface PrismaTransaction {
  readonly provider: 'postgres' | 'sqlite';
  readonly adapterName: string;
  readonly options: { readonly usePhantomQuery: boolean };
  queryRaw(query: PrismaSqlQuery): Promise<PrismaSqlResultSet>;
  executeRaw(query: PrismaSqlQuery): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface FirebirdPrismaAdapter {
  readonly provider: 'postgres' | 'sqlite';
  readonly adapterName: string;
  connect(): Promise<FirebirdPrismaAdapter>;
  queryRaw(query: PrismaSqlQuery): Promise<PrismaSqlResultSet>;
  executeRaw(query: PrismaSqlQuery): Promise<number>;
  executeScript(script: string): Promise<void>;
  startTransaction(isolationLevel?: string): Promise<PrismaTransaction>;
  dispose(): Promise<void>;
}

export interface CreateFirebirdPrismaAdapterOptions {
  /** Prisma flavour reported to Prisma Client (`'postgres'` translates `$1..$n` placeholders to `?`). @default 'postgres' */
  readonly provider?: 'postgres' | 'sqlite';
  readonly closeOnDispose?: boolean;
}

/** Translate Postgres `$1, $2` positional parameters to Firebird `?` while respecting string literals & quotes. */
export function rewritePositionalPlaceholders(
  sql: string,
  args: readonly unknown[],
): { sql: string; params: QueryParams } {
  const params: unknown[] = [];
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    const ch = sql[i]!;
    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') {
        if (sql[i + 1] === '"') {
          out += '"';
          i += 2;
          continue;
        }
        inDouble = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '$' && /[1-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j]!)) j++;
      const idx = Number(sql.slice(i + 1, j)) - 1;
      params.push(idx >= 0 && idx < args.length ? args[idx] : null);
      out += '?';
      i = j;
      continue;
    }
    if (ch === '?') {
      params.push(args[params.length] ?? null);
      out += '?';
      i++;
      continue;
    }
    out += ch;
    i++;
  }

  return { sql: out, params: params as QueryParams };
}

function mapFieldToPrismaColumnType(f: FieldInfo): number {
  const t = (f.typeName ?? '').toUpperCase();
  if (t.includes('SMALLINT') || t === 'INTEGER' || t === 'LONG' || t === 'SHORT') {
    return PrismaColumnType.Int32;
  }
  if (t.includes('BIGINT') || t === 'INT64') return PrismaColumnType.Int64;
  if (t === 'FLOAT') return PrismaColumnType.Float;
  if (t.includes('DOUBLE')) return PrismaColumnType.Double;
  if (t.includes('NUMERIC') || t.includes('DECIMAL') || t.includes('DECFLOAT')) {
    return PrismaColumnType.Numeric;
  }
  if (t.includes('BOOL')) return PrismaColumnType.Boolean;
  if (t === 'DATE') return PrismaColumnType.Date;
  if (t.includes('TIME') && !t.includes('STAMP')) return PrismaColumnType.Time;
  if (t.includes('TIMESTAMP')) return PrismaColumnType.DateTime;
  if (t.includes('BLOB') && f.subType !== 1) return PrismaColumnType.Bytes;
  return PrismaColumnType.Text;
}

/** Create a `@prisma/driver-adapter-utils`-compatible adapter over `FirebirdBrowser` or `FirebirdLite` (`M31 Item 5`). */
export function createFirebirdPrismaAdapter(
  db: PrismaCompatibleDatabase,
  options: CreateFirebirdPrismaAdapterOptions = {},
): FirebirdPrismaAdapter {
  const provider = options.provider ?? 'postgres';
  const adapterName = 'firebird-wasm/prisma';

  const runQueryRaw = async (
    runner: Pick<PrismaCompatibleDatabase, 'query'>,
    q: PrismaSqlQuery,
  ): Promise<PrismaSqlResultSet> => {
    const { sql, params } = rewritePositionalPlaceholders(q.sql, q.args);
    const res = await runner.query(sql, params, { rowMode: 'array' });
    const columnNames = res.fields.map((f) => f.name);
    const columnTypes = res.fields.map(mapFieldToPrismaColumnType);
    const rows = (res.rows as unknown[]).map((r) =>
      Array.isArray(r)
        ? r
        : columnNames.map((c) => (r as Record<string, unknown>)[c] ?? null),
    );
    return { columnNames, columnTypes, rows };
  };

  const runExecuteRaw = async (
    runner: Pick<PrismaCompatibleDatabase, 'execute' | 'exec' | 'query'>,
    q: PrismaSqlQuery,
  ): Promise<number> => {
    const { sql, params } = rewritePositionalPlaceholders(q.sql, q.args);
    if (typeof runner.execute === 'function') {
      const r = await runner.execute(sql, params);
      return r.affectedRows;
    }
    if (typeof runner.exec === 'function') {
      const r = await runner.exec(sql, params);
      if (r && typeof r === 'object' && 'affectedRows' in r) {
        return Number((r as { affectedRows: number }).affectedRows ?? 0);
      }
      return 0;
    }
    await runner.query(sql, params);
    return 0;
  };

  const adapter: FirebirdPrismaAdapter = {
    provider,
    adapterName,
    async connect() {
      return adapter;
    },
    queryRaw: (q) => runQueryRaw(db, q),
    executeRaw: (q) => runExecuteRaw(db, q),
    async executeScript(script: string) {
      if (typeof db.exec === 'function') await db.exec(script);
      else if (typeof db.execute === 'function') await db.execute(script);
    },
    async startTransaction(isolationLevel?: string): Promise<PrismaTransaction> {
      if (typeof db.transaction !== 'function') {
        throw new Error('Database does not support interactive transactions.');
      }
      const isoUpper = (isolationLevel ?? '').toUpperCase();
      const fbIso: IsolationLevel =
        isoUpper === 'SERIALIZABLE'
          ? 'SNAPSHOT_TABLE_STABILITY'
          : isoUpper === 'REPEATABLE READ'
            ? 'SNAPSHOT'
            : 'READ_COMMITTED';

      let resolveTxReady!: (tx: PrismaTransaction) => void;
      let rejectTxReady!: (err: unknown) => void;
      const txReady = new Promise<PrismaTransaction>((res, rej) => {
        resolveTxReady = res;
        rejectTxReady = rej;
      });

      let finishDecision!: (action: 'commit' | 'rollback') => void;
      const decisionPromise = new Promise<'commit' | 'rollback'>((res) => {
        finishDecision = res;
      });

      const txDone = db
        .transaction(
          async (txClient) => {
            let settled = false;
            resolveTxReady({
              provider,
              adapterName,
              options: { usePhantomQuery: false },
              queryRaw: (q) => runQueryRaw(txClient, q),
              executeRaw: (q) => runExecuteRaw(txClient, q),
              async commit() {
                if (settled) return;
                settled = true;
                finishDecision('commit');
                await txDone;
              },
              async rollback() {
                if (settled) return;
                settled = true;
                finishDecision('rollback');
                await txDone.catch(() => undefined);
              },
            });
            const action = await decisionPromise;
            if (action === 'rollback') {
              throw new Error('__PRISMA_TX_ROLLBACK__');
            }
          },
          { isolationLevel: fbIso },
        )
        .catch((err) => {
          if (err instanceof Error && err.message === '__PRISMA_TX_ROLLBACK__') return;
          rejectTxReady(err);
          throw err;
        });

      return txReady;
    },
    async dispose() {
      if (options.closeOnDispose && typeof db.close === 'function') {
        await db.close();
      }
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Monotonic RFC 9562 UUIDv7 & Crockford ULID Generators (`M31 Item 5`)
// ---------------------------------------------------------------------------

let lastUuidMs = 0;
let uuidSeq = 0;

function fillRandomBytes(buf: Uint8Array): void {
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
}

/** Generate a monotonic, k-sortable RFC 9562 `UUIDv7` string (`M31 Item 5`). */
export function uuidv7(nowMs = Date.now()): string {
  const ts = Math.max(0, Math.floor(nowMs));
  if (ts === lastUuidMs) {
    uuidSeq = (uuidSeq + 1) & 0x0fff;
  } else {
    lastUuidMs = ts;
    uuidSeq = 0;
  }
  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);
  // 48-bit big-endian Unix epoch ms
  const hi = Math.floor(ts / 0x100000000);
  const lo = ts >>> 0;
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;
  // version 7 (0111) + 12-bit monotonic seq
  bytes[6] = 0x70 | ((uuidSeq >>> 8) & 0x0f);
  bytes[7] = uuidSeq & 0xff;
  // RFC 9562 variant 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlidMs = 0;
let lastUlidRand: Uint8Array | null = null;

/** Generate a monotonic 26-char Crockford Base32 `ULID` string (`M31 Item 5`). */
export function ulid(nowMs = Date.now()): string {
  let ts = Math.max(0, Math.floor(nowMs));
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD[ts % 32]! + out;
    ts = Math.floor(ts / 32);
  }
  const rand = new Uint8Array(16);
  if (Math.floor(nowMs) === lastUlidMs && lastUlidRand) {
    rand.set(lastUlidRand);
    for (let i = 15; i >= 0; i--) {
      if (rand[i]! < 31) {
        rand[i]!++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    fillRandomBytes(rand);
    for (let i = 0; i < 16; i++) rand[i] = rand[i]! & 31;
    lastUlidMs = Math.floor(nowMs);
  }
  lastUlidRand = rand;
  for (let i = 0; i < 16; i++) out += CROCKFORD[rand[i]!];
  return out;
}

/** Register `GEN_UUID_V7()` and `GEN_ULID()` SQL scalar functions on `db` (`M31 Item 5`). */
export async function registerIdFunctions(db: PrismaCompatibleDatabase): Promise<void> {
  if (typeof db.registerFunction !== 'function') {
    throw new Error('Database instance does not support registerFunction().');
  }
  await db.registerFunction(
    'GEN_UUID_V7',
    { args: [], returns: 'VARCHAR(36)', deterministic: false },
    () => uuidv7(),
  );
  await db.registerFunction(
    'GEN_ULID',
    { args: [], returns: 'VARCHAR(26)', deterministic: false },
    () => ulid(),
  );
}
