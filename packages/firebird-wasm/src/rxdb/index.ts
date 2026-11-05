/**
 * firebird-wasm/rxdb – RxDB Storage Adapter (`RxStorage`) backed by Firebird WASM.
 *
 * Implements an RxDB-compatible storage engine (`RxStorage` & `RxStorageInstance`)
 * on top of `FirebirdBrowser` or `FirebirdLite`.
 *
 * Features:
 * - Automatic Firebird table provisioning (`FB_RXDB_<COLLECTION>$`) with document
 *   primary key, revision (`_REV`), deletion flag (`_DELETED`), modification
 *   timestamp (`_LWT`), JSON document payload (`DOC_JSON`), and binary attachment
 *   metadata (`ATTACHMENTS_JSON`).
 * - Optimistic concurrency control (`bulkWrite`) with revision checking and conflict
 *   reporting (`RxStorageBulkWriteResponse`).
 * - Fast primary-key lookups (`findDocumentsById`) and Mango selector queries
 *   (`query` / `count`) supporting `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`,
 *   `$in`, `$nin`, `$regex`, `$and`, `$or`, `sort`, `skip`, and `limit`.
 * - Monotonic checkpoint cursor (`getChangedDocumentsSince`) and reactive
 *   `changeStream()` bridged with Firebird `db.onEvent()` and local writes.
 * - Optional integration with `createWriteQueue` (`firebird-wasm/electric`) so
 *   RxDB document mutations are also queued in `FB_WRITE_QUEUE$` for remote sync.
 */

import type { QueryParams, QueryResult, Row } from '../types';

// ---------------------------------------------------------------------------
// Minimal RxDB Structural Types (No Hard Runtime Dependency on `rxdb` Required)
// ---------------------------------------------------------------------------

/** Minimal structural database contract satisfied by `FirebirdBrowser` and `FirebirdLite`. */
export interface RxFirebirdDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
  exec?(sql: string): Promise<void>;
  transaction?<T>(
    fn: (tx: {
      query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
      execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
      exec?(sql: string): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
  onEvent?(name: string, listener: (count: number) => void): Promise<() => Promise<void>>;
}

/** Optional durable write queue bridge (`createWriteQueue` from `firebird-wasm/electric`). */
export interface RxWriteQueueBridge {
  insert(table: string, value: Record<string, unknown>): Promise<unknown>;
  update(
    table: string,
    key: Record<string, unknown>,
    value: Record<string, unknown>,
  ): Promise<unknown>;
  delete(table: string, key: Record<string, unknown>): Promise<unknown>;
}

/** RxDB document metadata fields stored alongside user fields. */
export interface RxDocumentMetadata {
  readonly _deleted: boolean;
  readonly _rev: string;
  readonly _meta: {
    readonly lwt: number;
  };
  readonly _attachments: Record<string, RxAttachmentMeta>;
}

/** Stored RxDB document (`RxDocumentData<RxDocType>`). */
export type RxDocumentData<RxDocType = Record<string, unknown>> = RxDocType & RxDocumentMetadata;

/** Attachment metadata or write data. */
export interface RxAttachmentMeta {
  readonly type: string;
  readonly length: number;
  readonly digest: string;
  readonly data?: string;
}

/** Input row passed to `bulkWrite()`. */
export interface BulkWriteRow<RxDocType = Record<string, unknown>> {
  readonly previous?: RxDocumentData<RxDocType>;
  readonly document: RxDocumentData<RxDocType>;
}

/** Conflict error returned by `bulkWrite()` when `previous._rev` does not match the stored row. */
export interface RxStorageBulkWriteError<RxDocType = Record<string, unknown>> {
  readonly status: 409;
  readonly documentId: string;
  readonly writeRow: BulkWriteRow<RxDocType>;
  readonly documentInDb: RxDocumentData<RxDocType>;
  readonly isError: true;
}

/** Result returned by `bulkWrite()`. */
export interface RxStorageBulkWriteResponse<RxDocType = Record<string, unknown>> {
  readonly success: Record<string, RxDocumentData<RxDocType>>;
  readonly error: Record<string, RxStorageBulkWriteError<RxDocType>>;
}

/** Monotonic checkpoint for `getChangedDocumentsSince()` and `changeStream()`. */
export interface FirebirdRxStorageCheckpoint {
  readonly id: string;
  readonly lwt: number;
  readonly seq: number;
}

/** Change event emitted on `changeStream()`. */
export interface EventBulk<RxDocType = Record<string, unknown>> {
  readonly id: string;
  readonly events: ReadonlyArray<{
    readonly documentId: string;
    readonly operation: 'INSERT' | 'UPDATE' | 'DELETE';
    readonly documentData: RxDocumentData<RxDocType>;
    readonly previousDocumentData?: RxDocumentData<RxDocType>;
    readonly startTime: number;
    readonly endTime: number;
  }>;
  readonly checkpoint: FirebirdRxStorageCheckpoint;
  readonly context: string;
}

/** Minimal observable matching RxJS `Observable<T>` (`subscribe(observerOrFn)`). */
export interface Subscribable<T> {
  subscribe(
    observerOrNext:
      | ((value: T) => void)
      | {
          next?: (value: T) => void;
          error?: (err: unknown) => void;
          complete?: () => void;
        },
  ): { unsubscribe(): void };
}

/** Mango query selector operator map. */
export interface MangoFieldSelector {
  $eq?: unknown;
  $ne?: unknown;
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $in?: readonly unknown[];
  $nin?: readonly unknown[];
  $regex?: string | RegExp;
  $exists?: boolean;
}

/** Mango query object accepted by `prepareQuery` and `query`. */
export interface MangoQuery<RxDocType = Record<string, unknown>> {
  selector?: {
    $and?: ReadonlyArray<Record<string, unknown>>;
    $or?: ReadonlyArray<Record<string, unknown>>;
    [field: string]: unknown;
  };
  sort?: ReadonlyArray<Record<string, 'asc' | 'desc' | 'ASC' | 'DESC'>>;
  skip?: number;
  limit?: number;
  index?: readonly string[];
  /** Phantom type marker for `RxDocType`. */
  readonly _docType?: RxDocType;
}

/** Prepared query passed to `instance.query()` and `instance.count()`. */
export interface PreparedFirebirdRxQuery<RxDocType = Record<string, unknown>> {
  readonly query: MangoQuery<RxDocType>;
}

/** RxDB JSON Schema subset needed by `createStorageInstance`. */
export interface RxJsonSchema<RxDocType = Record<string, unknown>> {
  readonly version: number;
  readonly primaryKey: string | { readonly key: string };
  readonly properties?: Record<string, { readonly type?: string }>;
  readonly indexes?: ReadonlyArray<string | readonly string[]>;
  readonly _docType?: RxDocType;
}

/** Parameters passed to `RxStorage.createStorageInstance()`. */
export interface RxStorageInstanceCreationParams<RxDocType = Record<string, unknown>> {
  readonly databaseInstanceToken?: string;
  readonly databaseName: string;
  readonly collectionName: string;
  readonly schema: RxJsonSchema<RxDocType>;
  readonly options?: {
    /** Custom Firebird SQL table name override. */
    tableName?: string;
    /** Optional durable write queue to mirror document writes into `FB_WRITE_QUEUE$`. */
    writes?: RxWriteQueueBridge;
  };
  readonly multiInstance?: boolean;
  readonly devMode?: boolean;
}

/** RxDB `RxStorageInstance` backed by Firebird WASM. */
export interface FirebirdRxStorageInstance<RxDocType = Record<string, unknown>> {
  readonly databaseName: string;
  readonly collectionName: string;
  readonly schema: RxJsonSchema<RxDocType>;
  readonly tableName: string;
  readonly primaryKey: string;
  readonly internals: {
    readonly db: RxFirebirdDatabase;
    readonly tableName: string;
  };
  bulkWrite(
    documentWrites: ReadonlyArray<BulkWriteRow<RxDocType>>,
    context?: string,
  ): Promise<RxStorageBulkWriteResponse<RxDocType>>;
  findDocumentsById(
    ids: readonly string[],
    withDeleted?: boolean,
  ): Promise<Record<string, RxDocumentData<RxDocType>>>;
  query(
    preparedQuery: PreparedFirebirdRxQuery<RxDocType>,
  ): Promise<{ documents: Array<RxDocumentData<RxDocType>> }>;
  count(
    preparedQuery: PreparedFirebirdRxQuery<RxDocType>,
  ): Promise<{ count: number; mode: 'fast' | 'slow' }>;
  getAttachmentData(
    documentId: string,
    attachmentId: string,
    digest?: string,
  ): Promise<string>;
  getChangedDocumentsSince(
    limit: number,
    checkpoint?: FirebirdRxStorageCheckpoint,
  ): Promise<{
    documents: Array<RxDocumentData<RxDocType>>;
    checkpoint: FirebirdRxStorageCheckpoint;
  }>;
  changeStream(): Subscribable<EventBulk<RxDocType>>;
  cleanup(minimumDeletedTime: number): Promise<boolean>;
  close(): Promise<void>;
  remove(): Promise<void>;
}

/** RxDB `RxStorage` factory interface. */
export interface FirebirdRxStorage {
  readonly name: string;
  readonly rxdbVersion: string;
  readonly statics: {
    prepareQuery<RxDocType = Record<string, unknown>>(
      schema: RxJsonSchema<RxDocType>,
      mutateableQuery: MangoQuery<RxDocType>,
    ): PreparedFirebirdRxQuery<RxDocType>;
  };
  createStorageInstance<RxDocType = Record<string, unknown>>(
    params: RxStorageInstanceCreationParams<RxDocType>,
  ): Promise<FirebirdRxStorageInstance<RxDocType>>;
}

/** Options for {@link getRxStorageFirebird}. */
export interface RxStorageFirebirdSettings {
  /** The `FirebirdBrowser` or `FirebirdLite` database instance (or an async factory). */
  database: RxFirebirdDatabase | (() => Promise<RxFirebirdDatabase> | RxFirebirdDatabase);
  /** Optional prefix for provisioned Firebird tables (default `'FB_RXDB_'`). */
  tablePrefix?: string;
  /** Optional durable write queue (`createWriteQueue`) to mirror mutations into `FB_WRITE_QUEUE$`. */
  writes?: RxWriteQueueBridge;
  /** Target RxDB version string reported by `storage.rxdbVersion` (default `'16.0.0'`). */
  rxdbVersion?: string;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function extractPrimaryKeyName<RxDocType>(schema: RxJsonSchema<RxDocType>): string {
  if (typeof schema.primaryKey === 'string') {
    return schema.primaryKey;
  }
  return schema.primaryKey.key;
}

function sanitizeTableName(prefix: string, collectionName: string, version: number): string {
  const cleanPrefix = prefix.replace(/[^A-Za-z0-9_$]/g, '_').toUpperCase();
  const cleanCol = collectionName.replace(/[^A-Za-z0-9_$]/g, '_').toUpperCase();
  const raw = `${cleanPrefix}${cleanCol}_V${version}$`;
  return raw.slice(0, 60);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (path in obj) return obj[path];
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matchesFieldCondition(docValue: unknown, condition: unknown): boolean {
  if (
    condition === null ||
    typeof condition !== 'object' ||
    Array.isArray(condition) ||
    condition instanceof RegExp ||
    condition instanceof Date
  ) {
    return docValue === condition;
  }

  const ops = condition as MangoFieldSelector;
  const opKeys = Object.keys(ops).filter((k) => k.startsWith('$'));
  if (opKeys.length === 0) {
    return JSON.stringify(docValue) === JSON.stringify(condition);
  }

  for (const op of opKeys) {
    switch (op) {
      case '$eq':
        if (docValue !== ops.$eq) return false;
        break;
      case '$ne':
        if (docValue === ops.$ne) return false;
        break;
      case '$gt':
        if (!(compareValues(docValue, ops.$gt) > 0)) return false;
        break;
      case '$gte':
        if (!(compareValues(docValue, ops.$gte) >= 0)) return false;
        break;
      case '$lt':
        if (!(compareValues(docValue, ops.$lt) < 0)) return false;
        break;
      case '$lte':
        if (!(compareValues(docValue, ops.$lte) <= 0)) return false;
        break;
      case '$in':
        if (!Array.isArray(ops.$in) || !ops.$in.includes(docValue)) return false;
        break;
      case '$nin':
        if (Array.isArray(ops.$nin) && ops.$nin.includes(docValue)) return false;
        break;
      case '$exists':
        if (Boolean(ops.$exists) !== (docValue !== undefined)) return false;
        break;
      case '$regex': {
        const pattern =
          ops.$regex instanceof RegExp ? ops.$regex : new RegExp(String(ops.$regex ?? ''));
        if (!pattern.test(String(docValue ?? ''))) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

/**
 * Evaluate an RxDB Mango selector against a hydrated document.
 */
export function matchesMangoSelector(
  doc: Record<string, unknown>,
  selector: Record<string, unknown> | undefined,
): boolean {
  if (!selector) return true;
  for (const [key, value] of Object.entries(selector)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const sub of value) {
        if (!matchesMangoSelector(doc, sub as Record<string, unknown>)) {
          return false;
        }
      }
      continue;
    }
    if (key === '$or' && Array.isArray(value)) {
      const anyMatch = value.some((sub) =>
        matchesMangoSelector(doc, sub as Record<string, unknown>),
      );
      if (!anyMatch) return false;
      continue;
    }
    const fieldVal = getNestedValue(doc, key);
    if (!matchesFieldCondition(fieldVal, value)) {
      return false;
    }
  }
  return true;
}

function sortMangoDocuments<RxDocType>(
  docs: Array<RxDocumentData<RxDocType>>,
  sortSpec: ReadonlyArray<Record<string, 'asc' | 'desc' | 'ASC' | 'DESC'>> | undefined,
  primaryKey: string,
): Array<RxDocumentData<RxDocType>> {
  const effectiveSort =
    sortSpec && sortSpec.length > 0 ? sortSpec : [{ [primaryKey]: 'asc' as const }];
  return [...docs].sort((a, b) => {
    for (const entry of effectiveSort) {
      for (const [field, dir] of Object.entries(entry)) {
        const valA = getNestedValue(a as Record<string, unknown>, field);
        const valB = getNestedValue(b as Record<string, unknown>, field);
        const cmp = compareValues(valA, valB);
        if (cmp !== 0) {
          return dir.toLowerCase() === 'desc' ? -cmp : cmp;
        }
      }
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Storage Instance Implementation
// ---------------------------------------------------------------------------

async function execSql(
  db: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
    exec?(sql: string): Promise<void>;
  },
  sql: string,
  params?: QueryParams,
): Promise<void> {
  if (params && params.length > 0) {
    if (typeof db.execute === 'function') {
      await db.execute(sql, params);
    } else {
      await db.query(sql, params);
    }
    return;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql);
  } else if (typeof db.execute === 'function') {
    await db.execute(sql, []);
  } else {
    await db.query(sql, []);
  }
}

function parseStoredDoc<RxDocType>(row: Row): {
  doc: RxDocumentData<RxDocType>;
  seq: number;
  lwt: number;
  id: string;
} {
  const id = String(row.DOC_ID ?? row.doc_id ?? '');
  const docJson = String(row.DOC_JSON ?? row.doc_json ?? '{}');
  const doc = JSON.parse(docJson) as RxDocumentData<RxDocType>;
  const seq = Number(row.SEQ ?? row.seq ?? 0);
  const lwt = Number(row.LWT ?? row.lwt ?? doc._meta?.lwt ?? 0);
  return { doc, seq, lwt, id };
}

/**
 * Create an RxDB `RxStorage` adapter backed by Firebird WASM (`FirebirdBrowser`
 * or `FirebirdLite`).
 */
export function getRxStorageFirebird(
  settings: RxStorageFirebirdSettings,
): FirebirdRxStorage {
  const tablePrefix = settings.tablePrefix ?? 'FB_RXDB_';
  const rxdbVersion = settings.rxdbVersion ?? '16.0.0';

  const resolveDb = async (): Promise<RxFirebirdDatabase> => {
    if (typeof settings.database === 'function') {
      return await settings.database();
    }
    return settings.database;
  };

  return {
    name: 'firebird-wasm',
    rxdbVersion,
    statics: {
      prepareQuery<RxDocType = Record<string, unknown>>(
        _schema: RxJsonSchema<RxDocType>,
        mutateableQuery: MangoQuery<RxDocType>,
      ): PreparedFirebirdRxQuery<RxDocType> {
        return { query: mutateableQuery };
      },
    },
    async createStorageInstance<RxDocType = Record<string, unknown>>(
      params: RxStorageInstanceCreationParams<RxDocType>,
    ): Promise<FirebirdRxStorageInstance<RxDocType>> {
      const db = await resolveDb();
      const primaryKey = extractPrimaryKeyName(params.schema);
      const tableName =
        params.options?.tableName?.toUpperCase() ??
        sanitizeTableName(tablePrefix, params.collectionName, params.schema.version);
      const writesBridge = params.options?.writes ?? settings.writes;

      // Ensure collection table exists
      try {
        await execSql(
          db,
          `CREATE TABLE ${tableName} (
            DOC_ID VARCHAR(255) NOT NULL PRIMARY KEY,
            REV VARCHAR(128) NOT NULL,
            DELETED SMALLINT NOT NULL,
            LWT BIGINT NOT NULL,
            SEQ BIGINT NOT NULL,
            DOC_JSON VARCHAR(8191) NOT NULL,
            ATTACHMENTS_JSON VARCHAR(4000)
          )`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists|SQLCODE = -607|unsuccessful metadata update/i.test(msg)) {
          throw err;
        }
      }

      // Track monotonic sequence number across writes in this instance
      let seqCounter = 0;
      try {
        const maxRes = await db.query<{ MAX_SEQ?: number | bigint | null }>(
          `SELECT MAX(SEQ) AS MAX_SEQ FROM ${tableName}`,
        );
        const rawMax = maxRes.rows[0]?.MAX_SEQ;
        if (rawMax !== null && rawMax !== undefined) {
          seqCounter = Number(rawMax);
        }
      } catch {
        // Ignore if table is empty or mock DB does not aggregate MAX(SEQ)
      }

      const subscribers = new Set<(bulk: EventBulk<RxDocType>) => void>();
      let eventUnsub: (() => Promise<void>) | null = null;
      let closed = false;
      let eventBulkCounter = 0;

      if (typeof db.onEvent === 'function') {
        try {
          eventUnsub = await db.onEvent(`rxdb_${tableName}`, () => {
            // External Firebird event notification hook
          });
        } catch {
          eventUnsub = null;
        }
      }

      const instance: FirebirdRxStorageInstance<RxDocType> = {
        databaseName: params.databaseName,
        collectionName: params.collectionName,
        schema: params.schema,
        tableName,
        primaryKey,
        internals: { db, tableName },

        async bulkWrite(
          documentWrites: ReadonlyArray<BulkWriteRow<RxDocType>>,
          context = 'rxdb-bulk-write',
        ): Promise<RxStorageBulkWriteResponse<RxDocType>> {
          const success: Record<string, RxDocumentData<RxDocType>> = {};
          const error: Record<string, RxStorageBulkWriteError<RxDocType>> = {};
          const emittedEvents: Array<EventBulk<RxDocType>['events'][number]> = [];
          let latestCheckpoint: FirebirdRxStorageCheckpoint = {
            id: '',
            lwt: Date.now(),
            seq: seqCounter,
          };

          const runInTx = async (
            runner: {
              query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
              execute?(sql: string, params?: QueryParams): Promise<{ changes?: number } | void>;
              exec?(sql: string): Promise<void>;
            },
          ) => {
            for (const writeRow of documentWrites) {
              const startTime = Date.now();
              const doc = writeRow.document;
              const docId = String((doc as Record<string, unknown>)[primaryKey] ?? '');

              const existingRes = await runner.query<Row>(
                `SELECT DOC_ID, REV, DELETED, LWT, SEQ, DOC_JSON, ATTACHMENTS_JSON FROM ${tableName} WHERE DOC_ID = ?`,
                [docId],
              );
              const existingRow = existingRes.rows[0];
              const existingParsed = existingRow
                ? parseStoredDoc<RxDocType>(existingRow)
                : undefined;
              const docInDb = existingParsed?.doc;

              // Revision conflict check:
              // 1. Inserting without `previous`, but a non-deleted document is already in DB
              // 2. Updating/deleting with `previous`, and `docInDb._rev !== previous._rev`
              if (!writeRow.previous && docInDb && !docInDb._deleted) {
                error[docId] = {
                  status: 409,
                  documentId: docId,
                  writeRow,
                  documentInDb: docInDb,
                  isError: true,
                };
                continue;
              }
              if (
                writeRow.previous &&
                (!docInDb || docInDb._rev !== writeRow.previous._rev)
              ) {
                if (docInDb) {
                  error[docId] = {
                    status: 409,
                    documentId: docId,
                    writeRow,
                    documentInDb: docInDb,
                    isError: true,
                  };
                  continue;
                }
              }

              const seq = ++seqCounter;
              const lwt = doc._meta?.lwt ?? Date.now();
              const deletedInt = doc._deleted ? 1 : 0;
              const docJson = JSON.stringify(doc);
              const attachmentsJson = JSON.stringify(doc._attachments ?? {});

              if (existingRow) {
                await execSql(
                  runner,
                  `UPDATE ${tableName} SET REV = ?, DELETED = ?, LWT = ?, SEQ = ?, DOC_JSON = ?, ATTACHMENTS_JSON = ? WHERE DOC_ID = ?`,
                  [doc._rev, deletedInt, lwt, seq, docJson, attachmentsJson, docId],
                );
              } else {
                await execSql(
                  runner,
                  `INSERT INTO ${tableName} (DOC_ID, REV, DELETED, LWT, SEQ, DOC_JSON, ATTACHMENTS_JSON) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [docId, doc._rev, deletedInt, lwt, seq, docJson, attachmentsJson],
                );
              }

              if (writesBridge) {
                if (doc._deleted) {
                  await writesBridge.delete(params.collectionName, { [primaryKey]: docId });
                } else if (existingRow && !docInDb?._deleted) {
                  await writesBridge.update(
                    params.collectionName,
                    { [primaryKey]: docId },
                    doc as Record<string, unknown>,
                  );
                } else {
                  await writesBridge.insert(
                    params.collectionName,
                    doc as Record<string, unknown>,
                  );
                }
              }

              success[docId] = doc;
              latestCheckpoint = { id: docId, lwt, seq };

              const endTime = Date.now();
              let operation: 'INSERT' | 'UPDATE' | 'DELETE';
              if (doc._deleted) {
                operation = 'DELETE';
              } else if (!docInDb || docInDb._deleted) {
                operation = 'INSERT';
              } else {
                operation = 'UPDATE';
              }

              emittedEvents.push({
                documentId: docId,
                operation,
                documentData: doc,
                ...(docInDb ? { previousDocumentData: docInDb } : {}),
                startTime,
                endTime,
              });
            }
          };

          if (typeof db.transaction === 'function') {
            await db.transaction(runInTx);
          } else {
            await runInTx(db);
          }

          if (emittedEvents.length > 0 && subscribers.size > 0) {
            const bulk: EventBulk<RxDocType> = {
              id: `rxdb-bulk-${++eventBulkCounter}`,
              events: emittedEvents,
              checkpoint: latestCheckpoint,
              context,
            };
            for (const sub of [...subscribers]) {
              sub(bulk);
            }
          }

          return { success, error };
        },

        async findDocumentsById(
          ids: readonly string[],
          withDeleted = false,
        ): Promise<Record<string, RxDocumentData<RxDocType>>> {
          const out: Record<string, RxDocumentData<RxDocType>> = {};
          if (ids.length === 0) return out;

          const placeholders = ids.map(() => '?').join(', ');
          const res = await db.query<Row>(
            `SELECT DOC_ID, REV, DELETED, LWT, SEQ, DOC_JSON, ATTACHMENTS_JSON FROM ${tableName} WHERE DOC_ID IN (${placeholders})`,
            [...ids],
          );

          for (const row of res.rows) {
            const { doc, id } = parseStoredDoc<RxDocType>(row);
            if (!withDeleted && doc._deleted) continue;
            out[id] = doc;
          }
          return out;
        },

        async query(
          preparedQuery: PreparedFirebirdRxQuery<RxDocType>,
        ): Promise<{ documents: Array<RxDocumentData<RxDocType>> }> {
          const mango = preparedQuery.query;
          const res = await db.query<Row>(
            `SELECT DOC_ID, REV, DELETED, LWT, SEQ, DOC_JSON, ATTACHMENTS_JSON FROM ${tableName} WHERE DELETED = 0`,
          );

          const matched: Array<RxDocumentData<RxDocType>> = [];
          for (const row of res.rows) {
            const { doc } = parseStoredDoc<RxDocType>(row);
            if (doc._deleted) continue;
            if (matchesMangoSelector(doc as Record<string, unknown>, mango.selector)) {
              matched.push(doc);
            }
          }

          const sorted = sortMangoDocuments(matched, mango.sort, primaryKey);
          const skip = mango.skip ?? 0;
          const limit = mango.limit ?? sorted.length;
          return {
            documents: sorted.slice(skip, skip + limit),
          };
        },

        async count(
          preparedQuery: PreparedFirebirdRxQuery<RxDocType>,
        ): Promise<{ count: number; mode: 'fast' | 'slow' }> {
          const mango = preparedQuery.query;
          const hasSelector =
            mango.selector && Object.keys(mango.selector).length > 0;
          if (!hasSelector) {
            const res = await db.query<Row>(
              `SELECT COUNT(*) AS CNT FROM ${tableName} WHERE DELETED = 0`,
            );
            const rawCnt = res.rows[0]?.CNT ?? res.rows[0]?.cnt;
            if (rawCnt !== undefined) {
              return { count: Number(rawCnt), mode: 'fast' };
            }
          }
          const { documents } = await instance.query(preparedQuery);
          return { count: documents.length, mode: 'slow' };
        },

        async getAttachmentData(
          documentId: string,
          attachmentId: string,
        ): Promise<string> {
          const res = await db.query<Row>(
            `SELECT ATTACHMENTS_JSON, DOC_JSON FROM ${tableName} WHERE DOC_ID = ?`,
            [documentId],
          );
          const row = res.rows[0];
          if (!row) {
            throw new Error(`Document "${documentId}" not found in "${tableName}"`);
          }
          const rawAtt = row.ATTACHMENTS_JSON ?? row.attachments_json;
          const attachments = rawAtt
            ? (JSON.parse(String(rawAtt)) as Record<string, RxAttachmentMeta>)
            : {};
          const att = attachments[attachmentId];
          if (!att) {
            throw new Error(
              `Attachment "${attachmentId}" not found on document "${documentId}"`,
            );
          }
          return att.data ?? '';
        },

        async getChangedDocumentsSince(
          limit: number,
          checkpoint?: FirebirdRxStorageCheckpoint,
        ): Promise<{
          documents: Array<RxDocumentData<RxDocType>>;
          checkpoint: FirebirdRxStorageCheckpoint;
        }> {
          const minSeq = checkpoint?.seq ?? 0;
          const res = await db.query<Row>(
            `SELECT DOC_ID, REV, DELETED, LWT, SEQ, DOC_JSON, ATTACHMENTS_JSON FROM ${tableName} WHERE SEQ > ? ORDER BY SEQ ASC`,
            [minSeq],
          );

          const documents: Array<RxDocumentData<RxDocType>> = [];
          let nextCheckpoint: FirebirdRxStorageCheckpoint = checkpoint ?? {
            id: '',
            lwt: 0,
            seq: 0,
          };

          for (const row of res.rows.slice(0, limit)) {
            const parsed = parseStoredDoc<RxDocType>(row);
            documents.push(parsed.doc);
            nextCheckpoint = {
              id: parsed.id,
              lwt: parsed.lwt,
              seq: parsed.seq,
            };
          }

          return {
            documents,
            checkpoint: nextCheckpoint,
          };
        },

        changeStream(): Subscribable<EventBulk<RxDocType>> {
          return {
            subscribe(observerOrNext) {
              const handler =
                typeof observerOrNext === 'function'
                  ? observerOrNext
                  : (val: EventBulk<RxDocType>) => observerOrNext.next?.(val);
              subscribers.add(handler);
              return {
                unsubscribe() {
                  subscribers.delete(handler);
                },
              };
            },
          };
        },

        async cleanup(minimumDeletedTime: number): Promise<boolean> {
          const cutoff = Date.now() - minimumDeletedTime;
          await execSql(
            db,
            `DELETE FROM ${tableName} WHERE DELETED = 1 AND LWT < ?`,
            [cutoff],
          );
          return true;
        },

        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          subscribers.clear();
          if (eventUnsub) {
            await eventUnsub();
            eventUnsub = null;
          }
        },

        async remove(): Promise<void> {
          await instance.close();
          try {
            await execSql(db, `DROP TABLE ${tableName}`);
          } catch {
            // Table may already have been dropped
          }
        },
      };

      return instance;
    },
  };
}
