/**
 * writes-schema.ts – DDL provisioning helper for `ELECTRIC_WRITES` / `FB_WRITE_QUEUE$`.
 */

import type { ElectricTransaction } from './apply';

/** Standard durable write-queue table name (`FB_WRITE_QUEUE$`). */
export const DEFAULT_WRITE_QUEUE_TABLE = 'FB_WRITE_QUEUE$';

/** What a write queue needs of a database: `FirebirdBrowser` and `FirebirdLite` have it. */
export interface WritesDatabase {
  transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T>;
}

/** One write, as `send` receives it. */
export interface LocalWrite {
  id: number;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  key: Record<string, unknown>;
  value: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  conflictResolved?: boolean;
}

/** What `send` may return: the source transaction that applied the write. */
export interface SendResult {
  txid?: string | number | bigint;
}

/** Thrown by `send` when the source refuses a write: it is rolled back, not retried. */
export class WriteRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRejected';
  }
}

/**
 * Thrown by `send` when the remote server reports a concurrency / version
 * conflict (e.g. HTTP 409) and optionally provides the current server row.
 */
export class WriteConflict extends Error {
  readonly conflict = true;
  readonly server: Record<string, unknown> | null;

  constructor(
    message: string,
    serverOrOptions?:
      | { server?: Record<string, unknown> | null }
      | Record<string, unknown>
      | null,
  ) {
    super(message);
    this.name = 'WriteConflict';
    if (serverOrOptions === undefined || serverOrOptions === null) {
      this.server = null;
    } else if (
      typeof serverOrOptions === 'object' &&
      'server' in serverOrOptions &&
      Object.keys(serverOrOptions).every((k) => k === 'server')
    ) {
      this.server =
        (serverOrOptions as { server?: Record<string, unknown> | null }).server ?? null;
    } else {
      this.server = serverOrOptions as Record<string, unknown>;
    }
  }
}

export interface WriteConflictContext {
  write: LocalWrite;
  before: Record<string, unknown> | null;
  server: Record<string, unknown> | null;
  source: 'send' | 'sync';
  error?: Error;
  attempt: number;
}

export type ResolvedConflictOutcome =
  | { action: 'client-wins' }
  | { action: 'server-wins' }
  | {
      action: 'merge';
      value: Record<string, unknown>;
      operation: LocalWrite['operation'];
    };

export type ConflictResolution =
  | 'client-wins'
  | 'server-wins'
  | 'merge'
  | { action: 'client-wins' }
  | { action: 'server-wins' }
  | {
      action: 'merge';
      value: Record<string, unknown>;
      operation?: LocalWrite['operation'];
    }
  | Record<string, unknown>;

export type ConflictStrategy =
  | 'client-wins'
  | 'server-wins'
  | 'merge'
  | ((context: WriteConflictContext) => ConflictResolution | Promise<ConflictResolution>);

export interface WriteQueueOptions {
  send: (write: LocalWrite) => Promise<SendResult | void>;
  onConflict?: ConflictStrategy;
  getServerRow?: (write: LocalWrite) => Promise<Record<string, unknown> | null>;
  onConflictResolved?: (context: WriteConflictContext, outcome: ResolvedConflictOutcome) => void;
  onError?: (error: Error, write: LocalWrite) => void;
  onFlush?: (sent: LocalWrite[]) => void;
  retryMs?: number;
  confirmTimeoutMs?: number;
  tableName?: string;
  autoFlushOnOnline?: boolean;
  paused?: boolean;
}

export interface WriteQueue {
  insert(table: string, value: Record<string, unknown>): Promise<LocalWrite>;
  update(table: string, key: Record<string, unknown>, value: Record<string, unknown>): Promise<LocalWrite>;
  delete(table: string, key: Record<string, unknown>): Promise<LocalWrite>;
  pending(): Promise<LocalWrite[]>;
  discard(id: number): Promise<boolean>;
  clear(): Promise<number>;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly sync: WriteSync;
}

export interface WriteSync {
  reconcile(
    tx: ElectricTransaction,
    table: string,
    touched: Set<string> | 'all',
    txids: Set<string>,
  ): Promise<void>;
  register(table: string, refetch: () => void): () => void;
}

const MAX_VALUE = 3900;
const MAX_BEFORE_VALUE = 3900;

export async function ensureWritesTable(
  db: WritesDatabase,
  writesQuoted: string,
  writesRawName: string,
): Promise<boolean> {
  const relationCheckSql =
    writesRawName === 'ELECTRIC_WRITES'
      ? "SELECT 1 AS X FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'ELECTRIC_WRITES'"
      : 'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?';
  const relationCheckParams = writesRawName === 'ELECTRIC_WRITES' ? undefined : [writesRawName];

  for (let attempt = 1; ; attempt++) {
    try {
      let hasBeforeColumn = true;
      await db.transaction(async (tx) => {
        const { rows } = relationCheckParams
          ? await tx.query(relationCheckSql, relationCheckParams)
          : await tx.query(relationCheckSql);
        if (rows.length > 0) {
          try {
            const colCheck = await tx.query(
              'SELECT 1 AS X FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?',
              [writesRawName, 'BEFORE_JSON'],
            );
            if (colCheck.rows.length === 0) {
              await tx.exec(
                `ALTER TABLE ${writesQuoted} ADD BEFORE_JSON VARCHAR(${MAX_BEFORE_VALUE}) CHARACTER SET UTF8`,
              );
            }
          } catch {
            hasBeforeColumn = false;
          }
          return;
        }
        await tx.exec(
          `CREATE TABLE ${writesQuoted} (ID INTEGER NOT NULL PRIMARY KEY, TABLE_NAME VARCHAR(255) NOT NULL, ` +
            'OP CHAR(1) NOT NULL, KEY_JSON VARCHAR(2000) CHARACTER SET UTF8 NOT NULL, ' +
            `VALUE_JSON VARCHAR(${MAX_VALUE}) CHARACTER SET UTF8, ` +
            `BEFORE_JSON VARCHAR(${MAX_BEFORE_VALUE}) CHARACTER SET UTF8, ` +
            "STATE CHAR(1) DEFAULT 'P' NOT NULL, TXID VARCHAR(40), SENT_AT DOUBLE PRECISION)",
        );
      });
      return hasBeforeColumn;
    } catch (error) {
      const made = await db.transaction(async (tx) => {
        const res = relationCheckParams
          ? await tx.query(relationCheckSql, relationCheckParams)
          : await tx.query(relationCheckSql);
        return res.rows.length > 0;
      });
      if (made) return true;
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}
