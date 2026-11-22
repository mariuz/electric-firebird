/**
 * cdc-sink.ts – CloudEvents v1.0 Change-Data-Capture (CDC) Streamer,
 * WebCrypto HMAC-SHA256 Signed Webhook Dispatcher & Persistent LSN Offsets (`M29 Item 3`).
 */

import { encodeArrowIpc, rowsToColumnarResult } from './columnar';
import { DEFAULT_REPL_JOURNAL_TABLE } from './replication/types';
import type { ReplicationLogEntry, ReplicationOperation } from './replication/types';
import type { FieldInfo, QueryParams, QueryResult, Row } from './types';

export const DEFAULT_CDC_OFFSETS_TABLE = 'FB_CDC_OFFSETS$';
export const DEFAULT_CDC_DLQ_TABLE = 'FB_CDC_DLQ$';

export type CdcDeliveryFormat = 'cloudevents-json' | 'cloudevents-ndjson' | 'arrow-ipc';

/** CNCF CloudEvents v1.0 envelope for a Firebird CDC row mutation (`M29 Item 3`). */
export interface CloudEventV1<TData = CdcChangePayload> {
  readonly specversion: '1.0';
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: TData;
}

export interface CdcChangePayload {
  readonly lsn: number;
  readonly originNode: string;
  readonly hlc: string | null;
  readonly table: string;
  readonly op: ReplicationOperation;
  readonly key: Record<string, unknown>;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

export interface CdcBatchEnvelope {
  readonly sinkId: string;
  readonly idempotencyKey: string;
  readonly fromLsn: number;
  readonly toLsn: number;
  readonly events: readonly CloudEventV1[];
  readonly entries: readonly ReplicationLogEntry[];
}

export type CdcSinkHandler = (batch: CdcBatchEnvelope) => Promise<void> | void;

export interface CdcDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
}

export interface HttpWebhookSinkOptions {
  readonly url: string;
  readonly secret?: string;
  readonly format?: CdcDeliveryFormat;
  readonly source?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

export interface ChangeStreamSinkOptions {
  readonly sinkId: string;
  readonly sink: CdcSinkHandler;
  readonly journalTable?: string;
  readonly offsetsTable?: string;
  readonly dlqTable?: string;
  readonly source?: string;
  readonly tables?: readonly string[];
  readonly batchSize?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly pollIntervalMs?: number;
}

export interface CdcDeadLetterRecord {
  readonly sinkId: string;
  readonly fromLsn: number;
  readonly toLsn: number;
  readonly eventCount: number;
  readonly error: string;
  readonly payloadJson: string;
  readonly failedAt: number;
}

export interface ChangeStreamSinkHandle {
  readonly sinkId: string;
  flushOnce(): Promise<{ deliveredEvents: number; fromLsn: number | null; toLsn: number | null; quarantined: boolean }>;
  getOffset(): Promise<number>;
  rewind(lsn: number): Promise<void>;
  listDlq(): Promise<CdcDeadLetterRecord[]>;
  start(): { stop(): Promise<void> };
}

const utf8Enc = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Convert a {@link ReplicationLogEntry} into a CNCF **CloudEvents v1.0** record (`M29 Item 3`).
 */
export function toCloudEvent(
  entry: ReplicationLogEntry & {
    readonly originNode?: string;
    readonly op?: ReplicationOperation;
    readonly createdAt?: string | number;
  },
  options: { source?: string } = {},
): CloudEventV1 {
  const originNode = entry.originNode || entry.origin || 'primary';
  const opVal = entry.op || entry.operation || 'INSERT';
  const source = options.source ?? `urn:firebird:node:${originNode}`;
  const opLower = String(opVal).toLowerCase();
  const keyVals = Object.values(entry.key ?? {}).map(String).join(':');
  const subject = keyVals ? `${entry.table}/${keyVals}` : entry.table;
  const rawTime = entry.createdAt ?? entry.timestamp;
  const parsedTime =
    typeof rawTime === 'number' && Number.isFinite(rawTime)
      ? rawTime
      : typeof rawTime === 'string' && !Number.isNaN(Date.parse(rawTime))
        ? Date.parse(rawTime)
        : Date.now();
  const isoTime = new Date(parsedTime).toISOString();

  return {
    specversion: '1.0',
    id: `lsn-${entry.lsn}-${originNode}`,
    source,
    type: `org.firebirdsql.cdc.${opLower}`,
    subject,
    time: isoTime,
    datacontenttype: 'application/json',
    data: {
      lsn: entry.lsn,
      originNode,
      hlc: entry.hlc ?? null,
      table: entry.table,
      op: opVal,
      key: (entry.key ?? {}) as Record<string, unknown>,
      before: (entry.before as Record<string, unknown> | undefined) ?? null,
      after: (entry.after as Record<string, unknown> | undefined) ?? null,
    },
  };
}

/**
 * Compute a WebCrypto `HMAC-SHA256` webhook signature header (`t=<sec>,v1=<hex>`) (`M29 Item 3`).
 */
export async function signWebhookPayload(
  payload: string | Uint8Array,
  secret: string,
  timestampSec = Math.floor(Date.now() / 1000),
): Promise<{ signatureHeader: string; timestamp: string; signatureHex: string }> {
  const ts = String(timestampSec);
  const bodyBytes = typeof payload === 'string' ? utf8Enc.encode(payload) : payload;
  const prefixBytes = utf8Enc.encode(`${ts}.`);
  const signedInput = new Uint8Array(prefixBytes.byteLength + bodyBytes.byteLength);
  signedInput.set(prefixBytes, 0);
  signedInput.set(bodyBytes, prefixBytes.byteLength);

  const keyBytes = utf8Enc.encode(secret);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, signedInput));
  const signatureHex = bytesToHex(mac);
  return {
    signatureHeader: `t=${ts},v1=${signatureHex}`,
    timestamp: ts,
    signatureHex,
  };
}

/**
 * Verify a `X-Firebird-Signature` (`t=<sec>,v1=<hex>`) header using constant-time comparison (`M29 Item 3`).
 */
export async function verifyWebhookSignature(
  payload: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  options: { nowSec?: number; toleranceSec?: number } = {},
): Promise<boolean> {
  const parts = new Map<string, string>();
  for (const seg of signatureHeader.split(',')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts.set(seg.slice(0, eq).trim(), seg.slice(eq + 1).trim());
  }
  const tsRaw = parts.get('t');
  const v1 = parts.get('v1');
  if (!tsRaw || !v1) return false;
  const tsNum = Number(tsRaw);
  if (!Number.isFinite(tsNum)) return false;

  const tolerance = options.toleranceSec ?? 300;
  if (tolerance > 0) {
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > tolerance) return false;
  }

  const expected = await signWebhookPayload(payload, secret, tsNum);
  return timingSafeEqualHex(expected.signatureHex, v1.toLowerCase());
}

function encodeEventsAsArrowIpc(events: readonly CloudEventV1[]): Uint8Array {
  const fields: FieldInfo[] = [
    { name: 'LSN', type: 16, typeName: 'BIGINT', nullable: false },
    { name: 'EVENT_ID', type: 37, typeName: 'VARYING', nullable: false },
    { name: 'EVENT_TYPE', type: 37, typeName: 'VARYING', nullable: false },
    { name: 'TABLE_NAME', type: 37, typeName: 'VARYING', nullable: false },
    { name: 'SUBJECT', type: 37, typeName: 'VARYING', nullable: false },
    { name: 'DATA_JSON', type: 37, typeName: 'VARYING', nullable: false },
  ];
  const rows: Row[] = events.map((ev) => ({
    LSN: ev.data.lsn,
    EVENT_ID: ev.id,
    EVENT_TYPE: ev.type,
    TABLE_NAME: ev.data.table,
    SUBJECT: ev.subject,
    DATA_JSON: JSON.stringify(ev.data),
  }));
  return encodeArrowIpc(rowsToColumnarResult({ fields, rows }));
}

/**
 * Create an HTTP/HTTPS webhook {@link CdcSinkHandler} emitting CloudEvents v1.0 JSON,
 * NDJSON, or Apache Arrow IPC micro-batches with optional `HMAC-SHA256` signing (`M29 Item 3`).
 */
export function createHttpWebhookSink(options: HttpWebhookSinkOptions): CdcSinkHandler {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const format = options.format ?? 'cloudevents-json';

  return async (batch: CdcBatchEnvelope): Promise<void> => {
    let body: string | Uint8Array;
    let contentType: string;

    if (format === 'arrow-ipc') {
      body = encodeEventsAsArrowIpc(batch.events);
      contentType = 'application/vnd.apache.arrow.stream';
    } else if (format === 'cloudevents-ndjson') {
      body = batch.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      contentType = 'application/x-ndjson';
    } else {
      body = JSON.stringify(batch.events);
      contentType = 'application/cloudevents-batch+json';
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Idempotency-Key': batch.idempotencyKey,
      'X-Firebird-Sink-Id': batch.sinkId,
      'X-Firebird-Lsn-Range': `${batch.fromLsn}-${batch.toLsn}`,
      ...(options.headers ?? {}),
    };

    if (options.secret) {
      const signed = await signWebhookPayload(body, options.secret);
      headers['X-Firebird-Signature'] = signed.signatureHeader;
      headers['X-Firebird-Timestamp'] = signed.timestamp;
    }

    const bodyInit: BodyInit =
      typeof body === 'string'
        ? body
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit;

    const resp = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: bodyInit,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Webhook sink HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
  };
}

function qCdcIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function cdcCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execCdcSql(
  db: CdcDatabaseExecutor,
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

/**
 * Create a transactional CDC journal consumer with durable `FB_CDC_OFFSETS$` LSN
 * checkpointing, retry backoff, and `FB_CDC_DLQ$` quarantine (`M29 Item 3`).
 */
export function createChangeStreamSink(
  db: CdcDatabaseExecutor,
  options: ChangeStreamSinkOptions,
): ChangeStreamSinkHandle {
  const sinkId = options.sinkId.trim();
  if (!sinkId) throw new Error('sinkId must not be empty');
  const journalTable = (options.journalTable ?? DEFAULT_REPL_JOURNAL_TABLE).toUpperCase();
  const offsetsTable = (options.offsetsTable ?? DEFAULT_CDC_OFFSETS_TABLE).toUpperCase();
  const dlqTable = (options.dlqTable ?? DEFAULT_CDC_DLQ_TABLE).toUpperCase();
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const backoffBaseMs = Math.max(5, options.backoffBaseMs ?? 25);
  const pollIntervalMs = Math.max(15, options.pollIntervalMs ?? 250);
  const tableFilter = options.tables?.length
    ? new Set(options.tables.map((t) => t.trim().toUpperCase()))
    : null;

  let schemaReady = false;

  const ensureCdcTables = async (): Promise<void> => {
    if (schemaReady) return;
    const chkOff = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [offsetsTable],
    );
    if (Number(cdcCol(chkOff.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execCdcSql(
        db,
        `CREATE TABLE ${qCdcIdent(offsetsTable)} (
          SINK_ID VARCHAR(128) NOT NULL PRIMARY KEY,
          LAST_LSN BIGINT NOT NULL,
          UPDATED_AT BIGINT NOT NULL
        )`,
      );
    }

    const chkDlq = await db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
      [dlqTable],
    );
    if (Number(cdcCol(chkDlq.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
      await execCdcSql(
        db,
        `CREATE TABLE ${qCdcIdent(dlqTable)} (
          SINK_ID VARCHAR(128) NOT NULL,
          FROM_LSN BIGINT NOT NULL,
          TO_LSN BIGINT NOT NULL,
          EVENT_COUNT INTEGER NOT NULL,
          ERROR_MSG VARCHAR(1024) NOT NULL,
          PAYLOAD_JSON BLOB SUB_TYPE TEXT NOT NULL,
          FAILED_AT BIGINT NOT NULL,
          PRIMARY KEY (SINK_ID, FROM_LSN)
        )`,
      );
    }
    schemaReady = true;
  };

  const getOffset = async (): Promise<number> => {
    await ensureCdcTables();
    const res = await db.query<Record<string, unknown>>(
      `SELECT LAST_LSN FROM ${qCdcIdent(offsetsTable)} WHERE SINK_ID = ?`,
      [sinkId],
    );
    return res.rows.length > 0 ? Number(cdcCol(res.rows[0]!, 'LAST_LSN') ?? 0) : 0;
  };

  const saveOffset = async (lsn: number): Promise<void> => {
    await execCdcSql(
      db,
      `UPDATE OR INSERT INTO ${qCdcIdent(offsetsTable)} (SINK_ID, LAST_LSN, UPDATED_AT)
       VALUES (?, ?, ?) MATCHING (SINK_ID)`,
      [sinkId, lsn, Date.now()],
    );
  };

  const parseJsonSafe = (raw: unknown): Record<string, unknown> | undefined => {
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  return {
    sinkId,
    getOffset,

    async rewind(lsn: number): Promise<void> {
      await ensureCdcTables();
      await saveOffset(Math.max(0, Math.floor(lsn)));
    },

    async flushOnce() {
      await ensureCdcTables();
      const jChk = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [journalTable],
      );
      if (Number(cdcCol(jChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
        return { deliveredEvents: 0, fromLsn: null, toLsn: null, quarantined: false };
      }

      const lastLsn = await getOffset();
      const rowsRes = await db.query<Record<string, unknown>>(
        `SELECT FIRST ${batchSize} * FROM ${qCdcIdent(journalTable)}
         WHERE LSN > ?
         ORDER BY LSN ASC`,
        [lastLsn],
      );
      if (rowsRes.rows.length === 0) {
        return { deliveredEvents: 0, fromLsn: null, toLsn: null, quarantined: false };
      }

      const maxScannedLsn = Number(
        cdcCol(rowsRes.rows[rowsRes.rows.length - 1]!, 'LSN') ?? lastLsn,
      );
      const entries: ReplicationLogEntry[] = [];
      for (const r of rowsRes.rows) {
        const tbl = String(cdcCol(r, 'TABLE_NAME') ?? '').trim().toUpperCase();
        if (tableFilter && !tableFilter.has(tbl)) continue;
        const lsnNum = Number(cdcCol(r, 'LSN') ?? 0);
        const rawTs = cdcCol(r, 'CREATED_AT') ?? cdcCol(r, 'TIMESTAMP_MS');
        const tsNum =
          typeof rawTs === 'number'
            ? rawTs
            : typeof rawTs === 'string' && !Number.isNaN(Date.parse(rawTs))
              ? Date.parse(rawTs)
              : Date.now();
        entries.push({
          lsn: lsnNum,
          txid: String(cdcCol(r, 'TX_ID') ?? cdcCol(r, 'TXID') ?? `lsn-${lsnNum}`).trim(),
          origin: String(cdcCol(r, 'ORIGIN_NODE') ?? cdcCol(r, 'ORIGIN') ?? 'primary').trim(),
          publication: String(cdcCol(r, 'PUBLICATION_NAME') ?? 'default').trim(),
          hlc: cdcCol(r, 'HLC') ? String(cdcCol(r, 'HLC')).trim() : undefined,
          table: tbl,
          operation: String(
            cdcCol(r, 'OP') ?? cdcCol(r, 'OPERATION') ?? 'INSERT',
          )
            .trim()
            .toUpperCase() as ReplicationOperation,
          key: parseJsonSafe(cdcCol(r, 'PK_JSON') ?? cdcCol(r, 'KEY_JSON')) ?? {},
          before: parseJsonSafe(cdcCol(r, 'BEFORE_JSON')) ?? null,
          after: parseJsonSafe(cdcCol(r, 'AFTER_JSON')) ?? null,
          timestamp: tsNum,
        });
      }

      if (entries.length === 0) {
        await saveOffset(maxScannedLsn);
        return { deliveredEvents: 0, fromLsn: null, toLsn: maxScannedLsn, quarantined: false };
      }

      const fromLsn = entries[0]!.lsn;
      const toLsn = maxScannedLsn;
      const events = entries.map((e) => toCloudEvent(e, { source: options.source }));
      const envelope: CdcBatchEnvelope = {
        sinkId,
        idempotencyKey: `${sinkId}:${fromLsn}-${toLsn}`,
        fromLsn,
        toLsn,
        events,
        entries,
      };

      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await options.sink(envelope);
          await saveOffset(toLsn);
          return { deliveredEvents: events.length, fromLsn, toLsn, quarantined: false };
        } catch (err) {
          lastErr = err;
          if (attempt < maxRetries) {
            const delay = backoffBaseMs * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      const errMsg = (lastErr instanceof Error ? lastErr.message : String(lastErr)).slice(0, 1000);
      await execCdcSql(
        db,
        `UPDATE OR INSERT INTO ${qCdcIdent(dlqTable)} (
          SINK_ID, FROM_LSN, TO_LSN, EVENT_COUNT, ERROR_MSG, PAYLOAD_JSON, FAILED_AT
        ) VALUES (?, ?, ?, ?, ?, ?, ?) MATCHING (SINK_ID, FROM_LSN)`,
        [sinkId, fromLsn, toLsn, events.length, errMsg, JSON.stringify(events), Date.now()],
      );
      await saveOffset(toLsn);
      return { deliveredEvents: 0, fromLsn, toLsn, quarantined: true };
    },

    async listDlq(): Promise<CdcDeadLetterRecord[]> {
      await ensureCdcTables();
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qCdcIdent(dlqTable)} WHERE SINK_ID = ? ORDER BY FROM_LSN ASC`,
        [sinkId],
      );
      return res.rows.map((r) => ({
        sinkId: String(cdcCol(r, 'SINK_ID') ?? ''),
        fromLsn: Number(cdcCol(r, 'FROM_LSN') ?? 0),
        toLsn: Number(cdcCol(r, 'TO_LSN') ?? 0),
        eventCount: Number(cdcCol(r, 'EVENT_COUNT') ?? 0),
        error: String(cdcCol(r, 'ERROR_MSG') ?? ''),
        payloadJson: String(cdcCol(r, 'PAYLOAD_JSON') ?? '[]'),
        failedAt: Number(cdcCol(r, 'FAILED_AT') ?? 0),
      }));
    },

    start() {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let inFlight: Promise<unknown> | null = null;

      const loop = async (): Promise<void> => {
        if (stopped) return;
        try {
          inFlight = this.flushOnce();
          const r = (await inFlight) as { deliveredEvents: number };
          inFlight = null;
          if (!stopped) {
            timer = setTimeout(() => void loop(), r.deliveredEvents > 0 ? 5 : pollIntervalMs);
          }
        } catch {
          inFlight = null;
          if (!stopped) {
            timer = setTimeout(() => void loop(), pollIntervalMs);
          }
        }
      };

      void loop();
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (inFlight) await inFlight.catch(() => undefined);
        },
      };
    },
  };
}
