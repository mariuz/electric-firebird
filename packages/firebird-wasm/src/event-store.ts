/**
 * event-store.ts – Append-Only Event Sourcing Store (`FB_EVENT_STORE$`),
 * Optimistic Concurrency (`expectedVersion`), Aggregate Snapshots (`FB_EVENT_SNAPSHOTS$`),
 * Schema Upcasters & Checkpointed CQRS Projections (`FB_EVENT_PROJECTIONS$`) (`M30 Item 2`).
 */

import type { QueryParams, QueryResult, Row } from './types';

export const DEFAULT_EVENT_STORE_TABLE = 'FB_EVENT_STORE$';
export const DEFAULT_EVENT_SNAPSHOTS_TABLE = 'FB_EVENT_SNAPSHOTS$';
export const DEFAULT_EVENT_PROJECTIONS_TABLE = 'FB_EVENT_PROJECTIONS$';

export interface EventStoreDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  onQuery?: (listener: (event: { sql: string; params?: unknown }) => void) => () => void;
  transaction?<T>(
    fn: (tx: {
      query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T>;
}

export type ExpectedStreamVersion = number | 'any' | 'no_stream';

export class ConcurrencyConflictError extends Error {
  readonly streamId: string;
  readonly expectedVersion: ExpectedStreamVersion;
  readonly actualVersion: number;

  constructor(streamId: string, expectedVersion: ExpectedStreamVersion, actualVersion: number) {
    super(
      `Optimistic concurrency conflict on stream "${streamId}": expected version ${String(expectedVersion)}, actual version is ${actualVersion}.`,
    );
    this.name = 'ConcurrencyConflictError';
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface AppendEventInput<TPayload = Record<string, unknown>> {
  readonly type: string;
  readonly payload: TPayload;
  readonly metadata?: Record<string, unknown>;
}

export interface StoredDomainEvent<TPayload = Record<string, unknown>> {
  readonly globalSeq: number;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly type: string;
  readonly payload: TPayload;
  readonly metadata: Record<string, unknown>;
  readonly createdAtMs: number;
}

export interface EventSnapshotRecord<TState = unknown> {
  readonly streamId: string;
  readonly version: number;
  readonly state: TState;
  readonly updatedAtMs: number;
}

export type EventUpcasterFn = (
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
) => {
  readonly type?: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
};

export interface EventProjectionDefinition {
  readonly name: string;
  readonly eventTypes?: readonly string[];
  readonly handler: (
    event: StoredDomainEvent,
    db: EventStoreDatabaseExecutor,
  ) => Promise<void> | void;
  readonly reset?: (db: EventStoreDatabaseExecutor) => Promise<void> | void;
}

export interface EventProjectionStatus {
  readonly name: string;
  readonly lastGlobalSeq: number;
  readonly processedCount: number;
  readonly lagEvents: number;
  readonly updatedAtMs: number;
}

export interface EventStoreOptions {
  readonly eventsTable?: string;
  readonly snapshotsTable?: string;
  readonly projectionsTable?: string;
  readonly upcasters?: Readonly<Record<string, EventUpcasterFn>>;
  readonly autoProject?: boolean;
}

export interface EventStoreHandle {
  readonly eventsTable: string;
  readonly snapshotsTable: string;
  readonly projectionsTable: string;
  ensureSchema(): Promise<void>;
  appendToStream(
    streamId: string,
    events: readonly AppendEventInput[],
    options?: { expectedVersion?: ExpectedStreamVersion },
  ): Promise<{ streamVersion: number; appendedEvents: StoredDomainEvent[] }>;
  readStream<TPayload = Record<string, unknown>>(
    streamId: string,
    options?: { fromVersion?: number; limit?: number },
  ): Promise<Array<StoredDomainEvent<TPayload>>>;
  readAll<TPayload = Record<string, unknown>>(options?: {
    afterGlobalSeq?: number;
    limit?: number;
    eventTypes?: readonly string[];
  }): Promise<Array<StoredDomainEvent<TPayload>>>;
  saveSnapshot<TState>(streamId: string, version: number, state: TState): Promise<void>;
  getSnapshot<TState>(streamId: string): Promise<EventSnapshotRecord<TState> | null>;
  loadAggregate<TState>(
    streamId: string,
    reducer: (state: TState, event: StoredDomainEvent) => TState,
    initialState: TState,
    options?: { snapshotEvery?: number },
  ): Promise<{ state: TState; version: number; eventsReplayed: number; fromSnapshot: boolean }>;
  registerProjection(projection: EventProjectionDefinition): void;
  runProjections(
    projectionName?: string,
    options?: { batchSize?: number },
  ): Promise<{ processedEvents: number; projectionsUpdated: string[] }>;
  rebuildProjection(projectionName: string): Promise<{ processedEvents: number }>;
  listProjections(): Promise<EventProjectionStatus[]>;
  dispose(): void;
}

function qEvIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function evCol(row: Record<string, unknown>, upper: string): unknown {
  if (upper in row) return row[upper];
  const lower = upper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return row[k];
  }
  return undefined;
}

async function execEvSql(
  runner: {
    query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
    execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
    exec?(sql: string, params?: QueryParams): Promise<unknown>;
  },
  sql: string,
  params: QueryParams = [],
): Promise<void> {
  if (typeof runner.execute === 'function') await runner.execute(sql, params);
  else if (typeof runner.exec === 'function') await runner.exec(sql, params);
  else await runner.query(sql, params);
}

/**
 * Inspect persisted `FB_EVENT_PROJECTIONS$` statuses without mutating schema (`M30 Item 2` / `Item 5`).
 */
export async function fetchPersistedEventProjections(
  db: EventStoreDatabaseExecutor,
  options: { eventsTable?: string; projectionsTable?: string } = {},
): Promise<EventProjectionStatus[]> {
  const projTbl = (options.projectionsTable ?? DEFAULT_EVENT_PROJECTIONS_TABLE).toUpperCase();
  const evTbl = (options.eventsTable ?? DEFAULT_EVENT_STORE_TABLE).toUpperCase();

  const pChk = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [projTbl],
  );
  if (Number(evCol(pChk.rows[0] ?? {}, 'CNT') ?? 0) === 0) return [];

  let headSeq = 0;
  const eChk = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [evTbl],
  );
  if (Number(evCol(eChk.rows[0] ?? {}, 'CNT') ?? 0) > 0) {
    const hRes = await db.query<Record<string, unknown>>(
      `SELECT COALESCE(MAX("GLOBAL_SEQ"), 0) AS HEAD_SEQ FROM ${qEvIdent(evTbl)}`,
    );
    headSeq = Number(evCol(hRes.rows[0] ?? {}, 'HEAD_SEQ') ?? 0);
  }

  const rowsRes = await db.query<Record<string, unknown>>(
    `SELECT * FROM ${qEvIdent(projTbl)} ORDER BY "PROJECTION_NAME" ASC`,
  );
  return rowsRes.rows.map((r) => {
    const lastSeq = Number(evCol(r, 'LAST_GLOBAL_SEQ') ?? 0);
    return {
      name: String(evCol(r, 'PROJECTION_NAME') ?? '').trim(),
      lastGlobalSeq: lastSeq,
      processedCount: Number(evCol(r, 'PROCESSED_COUNT') ?? 0),
      lagEvents: Math.max(0, headSeq - lastSeq),
      updatedAtMs: Number(evCol(r, 'UPDATED_AT_MS') ?? 0),
    };
  });
}

/**
 * Create an append-only Event Sourcing & CQRS projection engine over Firebird (`M30 Item 2`).
 */
export function createEventStore(
  db: EventStoreDatabaseExecutor,
  options: EventStoreOptions = {},
): EventStoreHandle {
  const eventsTable = (options.eventsTable ?? DEFAULT_EVENT_STORE_TABLE).toUpperCase();
  const snapshotsTable = (options.snapshotsTable ?? DEFAULT_EVENT_SNAPSHOTS_TABLE).toUpperCase();
  const projectionsTable = (
    options.projectionsTable ?? DEFAULT_EVENT_PROJECTIONS_TABLE
  ).toUpperCase();
  const upcasters = options.upcasters ?? {};
  const projections = new Map<string, EventProjectionDefinition>();

  let schemaInitialized = false;
  let unsubAutoProject: (() => void) | null = null;
  let autoProjectRunning = false;

  const applyUpcasters = <TPayload>(rawRow: Record<string, unknown>): StoredDomainEvent<TPayload> => {
    let evType = String(evCol(rawRow, 'EVENT_TYPE') ?? '').trim();
    let payload: Record<string, unknown> = {};
    let metadata: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(evCol(rawRow, 'PAYLOAD_JSON') ?? '{}')) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    try {
      const mRaw = evCol(rawRow, 'METADATA_JSON');
      if (mRaw != null && String(mRaw).trim() !== '') {
        metadata = JSON.parse(String(mRaw)) as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }

    let guard = 0;
    while (upcasters[evType] && guard < 16) {
      const next = upcasters[evType]!(payload, metadata);
      payload = next.payload;
      if (next.metadata) metadata = next.metadata;
      if (next.type && next.type !== evType) {
        evType = next.type;
        guard++;
      } else {
        break;
      }
    }

    return {
      globalSeq: Number(evCol(rawRow, 'GLOBAL_SEQ') ?? 0),
      streamId: String(evCol(rawRow, 'STREAM_ID') ?? '').trim(),
      streamVersion: Number(evCol(rawRow, 'STREAM_VERSION') ?? 0),
      type: evType,
      payload: payload as unknown as TPayload,
      metadata,
      createdAtMs: Number(evCol(rawRow, 'CREATED_AT_MS') ?? 0),
    };
  };

  const ensureSchema = async (): Promise<void> => {
    if (schemaInitialized) return;
    const checkAndCreate = async (tbl: string, ddl: string) => {
      const chk = await db.query<Record<string, unknown>>(
        `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
        [tbl],
      );
      if (Number(evCol(chk.rows[0] ?? {}, 'CNT') ?? 0) === 0) {
        await execEvSql(db, ddl);
      }
    };

    await checkAndCreate(
      eventsTable,
      `CREATE TABLE ${qEvIdent(eventsTable)} (
        "GLOBAL_SEQ" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        "STREAM_ID" VARCHAR(256) NOT NULL,
        "STREAM_VERSION" INTEGER NOT NULL,
        "EVENT_TYPE" VARCHAR(128) NOT NULL,
        "PAYLOAD_JSON" BLOB SUB_TYPE TEXT NOT NULL,
        "METADATA_JSON" BLOB SUB_TYPE TEXT,
        "CREATED_AT_MS" BIGINT NOT NULL,
        CONSTRAINT ${qEvIdent(`UQ_${eventsTable}_SV`.slice(0, 31))} UNIQUE ("STREAM_ID", "STREAM_VERSION")
      )`,
    );

    await checkAndCreate(
      snapshotsTable,
      `CREATE TABLE ${qEvIdent(snapshotsTable)} (
        "STREAM_ID" VARCHAR(256) NOT NULL PRIMARY KEY,
        "STREAM_VERSION" INTEGER NOT NULL,
        "STATE_JSON" BLOB SUB_TYPE TEXT NOT NULL,
        "UPDATED_AT_MS" BIGINT NOT NULL
      )`,
    );

    await checkAndCreate(
      projectionsTable,
      `CREATE TABLE ${qEvIdent(projectionsTable)} (
        "PROJECTION_NAME" VARCHAR(128) NOT NULL PRIMARY KEY,
        "LAST_GLOBAL_SEQ" BIGINT NOT NULL,
        "PROCESSED_COUNT" BIGINT NOT NULL,
        "UPDATED_AT_MS" BIGINT NOT NULL
      )`,
    );

    schemaInitialized = true;
  };

  const runInTx = async <T>(
    fn: (runner: {
      query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>>;
      execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
      exec?(sql: string, params?: QueryParams): Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T> => {
    if (typeof db.transaction === 'function') {
      return db.transaction((tx) => fn(tx));
    }
    return fn(db);
  };

  const handle: EventStoreHandle = {
    eventsTable,
    snapshotsTable,
    projectionsTable,
    ensureSchema,

    async appendToStream(streamId, events, appendOpts = {}) {
      const cleanStream = streamId.trim();
      if (!cleanStream) throw new Error('streamId must not be empty');
      await ensureSchema();

      const expected = appendOpts.expectedVersion ?? 'any';
      const result = await runInTx(async (tx) => {
        const verRes = await tx.query<Record<string, unknown>>(
          `SELECT COALESCE(MAX("STREAM_VERSION"), 0) AS CUR_VER
           FROM ${qEvIdent(eventsTable)}
           WHERE "STREAM_ID" = ?`,
          [cleanStream],
        );
        const currentVer = Number(evCol(verRes.rows[0] ?? {}, 'CUR_VER') ?? 0);

        if (expected === 'no_stream' && currentVer !== 0) {
          throw new ConcurrencyConflictError(cleanStream, expected, currentVer);
        }
        if (typeof expected === 'number' && currentVer !== expected) {
          throw new ConcurrencyConflictError(cleanStream, expected, currentVer);
        }
        if (events.length === 0) {
          return { streamVersion: currentVer, appendedEvents: [] as StoredDomainEvent[] };
        }

        const appended: StoredDomainEvent[] = [];
        let nextVer = currentVer;
        const nowMs = Date.now();

        for (const ev of events) {
          nextVer += 1;
          const payloadStr = JSON.stringify(ev.payload ?? {});
          const metaStr = JSON.stringify(ev.metadata ?? {});
          const insRes = await tx.query<Record<string, unknown>>(
            `INSERT INTO ${qEvIdent(eventsTable)} (
              "STREAM_ID", "STREAM_VERSION", "EVENT_TYPE", "PAYLOAD_JSON", "METADATA_JSON", "CREATED_AT_MS"
            ) VALUES (?, ?, ?, ?, ?, ?)
            RETURNING "GLOBAL_SEQ"`,
            [cleanStream, nextVer, ev.type, payloadStr, metaStr, nowMs],
          );
          const gSeq = Number(evCol(insRes.rows[0] ?? {}, 'GLOBAL_SEQ') ?? 0);
          appended.push(
            applyUpcasters({
              GLOBAL_SEQ: gSeq,
              STREAM_ID: cleanStream,
              STREAM_VERSION: nextVer,
              EVENT_TYPE: ev.type,
              PAYLOAD_JSON: payloadStr,
              METADATA_JSON: metaStr,
              CREATED_AT_MS: nowMs,
            }),
          );
        }

        return { streamVersion: nextVer, appendedEvents: appended };
      });

      if (options.autoProject && projections.size > 0 && !autoProjectRunning) {
        autoProjectRunning = true;
        try {
          await handle.runProjections();
        } finally {
          autoProjectRunning = false;
        }
      }

      return result;
    },

    async readStream<TPayload = Record<string, unknown>>(
      streamId: string,
      readOpts: { fromVersion?: number; limit?: number } = {},
    ) {
      await ensureSchema();
      const fromVer = readOpts.fromVersion ?? 1;
      const limitSql =
        readOpts.limit !== undefined ? `FIRST ${Math.max(1, Math.floor(readOpts.limit))} ` : '';
      const res = await db.query<Record<string, unknown>>(
        `SELECT ${limitSql}* FROM ${qEvIdent(eventsTable)}
         WHERE "STREAM_ID" = ? AND "STREAM_VERSION" >= ?
         ORDER BY "STREAM_VERSION" ASC`,
        [streamId.trim(), fromVer],
      );
      return res.rows.map((r) => applyUpcasters<TPayload>(r));
    },

    async readAll<TPayload = Record<string, unknown>>(
      readOpts: { afterGlobalSeq?: number; limit?: number; eventTypes?: string[] } = {},
    ) {
      await ensureSchema();
      const afterSeq = readOpts.afterGlobalSeq ?? 0;
      const limitSql =
        readOpts.limit !== undefined ? `FIRST ${Math.max(1, Math.floor(readOpts.limit))} ` : '';
      const params: unknown[] = [afterSeq];
      let typeFilterSql = '';
      if (readOpts.eventTypes && readOpts.eventTypes.length > 0) {
        const ph = readOpts.eventTypes.map(() => '?').join(', ');
        typeFilterSql = ` AND "EVENT_TYPE" IN (${ph})`;
        params.push(...readOpts.eventTypes);
      }
      const res = await db.query<Record<string, unknown>>(
        `SELECT ${limitSql}* FROM ${qEvIdent(eventsTable)}
         WHERE "GLOBAL_SEQ" > ?${typeFilterSql}
         ORDER BY "GLOBAL_SEQ" ASC`,
        params,
      );
      return res.rows.map((r) => applyUpcasters<TPayload>(r));
    },

    async saveSnapshot<TState>(streamId: string, version: number, state: TState): Promise<void> {
      await ensureSchema();
      await execEvSql(
        db,
        `UPDATE OR INSERT INTO ${qEvIdent(snapshotsTable)} (
          "STREAM_ID", "STREAM_VERSION", "STATE_JSON", "UPDATED_AT_MS"
        ) VALUES (?, ?, ?, ?) MATCHING ("STREAM_ID")`,
        [streamId.trim(), version, JSON.stringify(state), Date.now()],
      );
    },

    async getSnapshot<TState>(streamId: string): Promise<EventSnapshotRecord<TState> | null> {
      await ensureSchema();
      const res = await db.query<Record<string, unknown>>(
        `SELECT * FROM ${qEvIdent(snapshotsTable)} WHERE "STREAM_ID" = ?`,
        [streamId.trim()],
      );
      if (res.rows.length === 0) return null;
      const r = res.rows[0]!;
      return {
        streamId: String(evCol(r, 'STREAM_ID') ?? '').trim(),
        version: Number(evCol(r, 'STREAM_VERSION') ?? 0),
        state: JSON.parse(String(evCol(r, 'STATE_JSON') ?? 'null')) as TState,
        updatedAtMs: Number(evCol(r, 'UPDATED_AT_MS') ?? 0),
      };
    },

    async loadAggregate<TState>(
      streamId: string,
      reducer: (state: TState, event: StoredDomainEvent) => TState,
      initialState: TState,
      aggOpts: { snapshotEvery?: number } = {},
    ) {
      await ensureSchema();
      const snap = await handle.getSnapshot<TState>(streamId);
      let state = snap ? snap.state : initialState;
      const startVer = snap ? snap.version + 1 : 1;
      const deltaEvents = await handle.readStream(streamId, { fromVersion: startVer });

      let version = snap ? snap.version : 0;
      for (const ev of deltaEvents) {
        state = reducer(state, ev);
        version = ev.streamVersion;
      }

      if (
        aggOpts.snapshotEvery !== undefined &&
        aggOpts.snapshotEvery > 0 &&
        deltaEvents.length >= aggOpts.snapshotEvery
      ) {
        await handle.saveSnapshot(streamId, version, state);
      }

      return {
        state,
        version,
        eventsReplayed: deltaEvents.length,
        fromSnapshot: snap !== null,
      };
    },

    registerProjection(projection: EventProjectionDefinition): void {
      projections.set(projection.name.trim(), projection);
    },

    async runProjections(projectionName?: string, runOpts = {}) {
      await ensureSchema();
      const batchSize = Math.max(1, runOpts.batchSize ?? 200);
      const targets = projectionName
        ? [projections.get(projectionName.trim())].filter(
            (p): p is EventProjectionDefinition => p !== undefined,
          )
        : [...projections.values()];

      let processedEvents = 0;
      const projectionsUpdated: string[] = [];

      for (const proj of targets) {
        const pName = proj.name.trim();
        const wmRes = await db.query<Record<string, unknown>>(
          `SELECT "LAST_GLOBAL_SEQ", "PROCESSED_COUNT" FROM ${qEvIdent(projectionsTable)} WHERE "PROJECTION_NAME" = ?`,
          [pName],
        );
        let lastSeq =
          wmRes.rows.length > 0 ? Number(evCol(wmRes.rows[0]!, 'LAST_GLOBAL_SEQ') ?? 0) : 0;
        let procCount =
          wmRes.rows.length > 0 ? Number(evCol(wmRes.rows[0]!, 'PROCESSED_COUNT') ?? 0) : 0;

        if (wmRes.rows.length === 0) {
          await execEvSql(
            db,
            `INSERT INTO ${qEvIdent(projectionsTable)} ("PROJECTION_NAME", "LAST_GLOBAL_SEQ", "PROCESSED_COUNT", "UPDATED_AT_MS")
             VALUES (?, 0, 0, ?)`,
            [pName, Date.now()],
          );
        }

        let touched = false;
        for (;;) {
          const batch = await handle.readAll({
            afterGlobalSeq: lastSeq,
            limit: batchSize,
          });
          if (batch.length === 0) break;

          const typeAllow = proj.eventTypes?.length ? new Set(proj.eventTypes) : null;
          for (const ev of batch) {
            if (!typeAllow || typeAllow.has(ev.type)) {
              await proj.handler(ev, db);
              procCount += 1;
              processedEvents += 1;
            }
            lastSeq = ev.globalSeq;
            touched = true;
          }

          await execEvSql(
            db,
            `UPDATE ${qEvIdent(projectionsTable)}
             SET "LAST_GLOBAL_SEQ" = ?, "PROCESSED_COUNT" = ?, "UPDATED_AT_MS" = ?
             WHERE "PROJECTION_NAME" = ?`,
            [lastSeq, procCount, Date.now(), pName],
          );
          if (batch.length < batchSize) break;
        }
        if (touched) projectionsUpdated.push(pName);
      }

      return { processedEvents, projectionsUpdated };
    },

    async rebuildProjection(projectionName: string): Promise<{ processedEvents: number }> {
      await ensureSchema();
      const proj = projections.get(projectionName.trim());
      if (!proj) throw new Error(`Projection "${projectionName}" is not registered.`);
      if (proj.reset) {
        await proj.reset(db);
      }
      await execEvSql(
        db,
        `UPDATE OR INSERT INTO ${qEvIdent(projectionsTable)} (
          "PROJECTION_NAME", "LAST_GLOBAL_SEQ", "PROCESSED_COUNT", "UPDATED_AT_MS"
        ) VALUES (?, 0, 0, ?) MATCHING ("PROJECTION_NAME")`,
        [proj.name.trim(), Date.now()],
      );
      const res = await handle.runProjections(proj.name.trim());
      return { processedEvents: res.processedEvents };
    },

    async listProjections(): Promise<EventProjectionStatus[]> {
      return fetchPersistedEventProjections(db, { eventsTable, projectionsTable });
    },

    dispose(): void {
      unsubAutoProject?.();
      unsubAutoProject = null;
    },
  };

  if (options.autoProject && typeof db.onQuery === 'function') {
    const escapedTbl = eventsTable.replace(/\$/g, '\\$');
    const re = new RegExp(`INSERT\\s+INTO\\s+(?:"${escapedTbl}"|${escapedTbl})`, 'i');
    unsubAutoProject = db.onQuery((ev) => {
      if (autoProjectRunning || projections.size === 0) return;
      if (re.test(ev.sql)) {
        autoProjectRunning = true;
        void handle
          .runProjections()
          .catch(() => undefined)
          .finally(() => {
            autoProjectRunning = false;
          });
      }
    });
  }

  return handle;
}
