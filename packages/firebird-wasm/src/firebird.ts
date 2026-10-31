import * as fs from 'fs';
import * as os from 'os';
import {
  Blob as FbBlob,
  TransactionIsolation,
} from 'node-firebird-driver';
import type {
  Client,
  Attachment,
  Statement,
  Transaction,
  TransactionOptions as NativeTransactionOptions,
} from 'node-firebird-driver';
import type {
  ArrayRow,
  FirebirdLiteOptions,
  QueryDescription,
  ExplainOptions,
  DatabaseInfo,
  SweepResult,
  PreparedStatement,
  DataStreamOptions,
  IntrospectOptions,
  SchemaIntrospection,
  Migration,
  MigrateOptions,
  BlobStreamOptions,
  BlobHandle,
  BlobWritableStream,
  MigrateResult,
  QueryResult,
  QueryOptions,
  QueryStreamOptions,
  Row,
  QueryParams,
  RowMode,
  TransactionOptions,
  FieldInfo,
} from './types';
import { statementKind } from './statement-types';
import { firebirdTypeName } from './browser/field-types';
import {
  compressGzipStream,
  readDatabaseStreamChunks,
  resolveStreamChunkSize,
} from './browser/data-stream';
import {
  DATABASE_INFO_REQUEST_ITEMS,
  parseDatabaseInfoBuffer,
  normalizeDatabaseInfo,
  buildSweepResult,
} from './browser/engine-transport';
import { applyTypes, applySerializers } from './browser/value-types';
import { introspect as introspectSchema, migrate as runMigrations } from './browser/schema';
import {
  BLOB_INTERNAL_DATA,
  type InternalBlobHandle,
  buildBlobReadableStream,
  buildBlobWritableStream,
  createBlobHandle,
  extractBlobHandle,
  isBlobHandle,
  resolveBlobColumnIndex,
  resolveBlobSegmentSize,
} from './browser/blob-stream';
import type { TypeOptions } from './browser/value-types';
import { toStatement, resolveQueryCall, resolveBatchSize } from './sql-tag';
import { blockParamType, buildBlock, placeholderOffsets } from './batch-block';
import type { CharacterSet, ParamDescriptor } from './batch-block';
import type { SqlFragment, Statement as ParsedStatement } from './sql-tag';

type NativeDriver = typeof import('node-firebird-driver-native');

const littleEndian = os.endianness() === 'LE';

/** `isc_info_sql_stmt_select`: the statement type the shared read transaction runs. */
const STMT_SELECT = 1;
let nativeDriver: NativeDriver | undefined;

/**
 * The native driver, loaded on first use rather than at import.
 *
 * It is an optional dependency: a browser-only install (`--omit=optional`) has
 * none, and a top-level import made the whole root entry fail to load there,
 * `sql` and `loadFirebirdWasm` included, with a bare MODULE_NOT_FOUND.
 */
function loadNativeDriver(): NativeDriver {
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

/** `QueryOptions` with the array mode pinned, for the overloads below. */
type ArrayModeOptions = QueryOptions & { rowMode: 'array' };
/** `QueryStreamOptions` with the array mode pinned, for the overloads below. */
type ArrayStreamOptions = QueryStreamOptions & { rowMode: 'array' };

/**
 * FirebirdLite – a PGlite-style wrapper around Firebird Embedded.
 *
 * Provides a simple async API for running SQL against a Firebird database
 * using the Firebird embedded engine (single-process mode).
 *
 * @example
 * ```ts
 * const db = new FirebirdLite('/tmp/my-database.fdb');
 * await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR(100))');
 * await db.query('INSERT INTO t VALUES (?, ?)', [1, 'hello']);
 * const result = await db.query('SELECT * FROM t');
 * // { rows: [ { ID: 1, NAME: 'hello' } ], fields: [...] }
 * await db.close();
 * ```
 */
export class FirebirdLite {
  private readonly dbPath: string;
  private readonly libraryPath: string | undefined;
  private readonly connectOptions: { username?: string; password?: string; charSetForNONE?: string };
  private client: Client | null = null;
  private attachment: Attachment | null = null;
  private closed = false;
  private readonly sharedReads: boolean;
  /** The read-only transaction `query()` shares when `sharedReads` is on. */
  private readTransaction: Transaction | null = null;
  /** SQL texts that are not a SELECT, or that wrote: they get a transaction of their own. */
  private readonly ownTransaction = new Set<string>();
  private readonly statementCacheSize: number;
  /** Statements kept prepared by their SQL text, once connected (`statementCache`). */
  private statements: StatementCache | null = null;
  private readonly preparedStatements = new Set<PreparedStatement>();
  private readonly types: TypeOptions | undefined;

  constructor(dbPath: string, options: FirebirdLiteOptions = {}) {
    this.dbPath = dbPath;
    this.libraryPath = options.libraryPath;
    this.connectOptions = {
      username: options.username,
      password: options.password,
      charSetForNONE: options.charset,
    };
    this.sharedReads = options.sharedReads ?? false;
    const size = options.statementCache ?? 0;
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError('statementCache is a whole number of statements, 0 or more');
    }
    this.statementCacheSize = size;
    this.types = options.types;
  }

  private serialize(params: QueryParams): QueryParams {
    return applySerializers(params, this.types?.serializers);
  }

  /**
   * Lazily initialize the native client and open (or create) the database.
   */
  private async ensureReady(): Promise<void> {
    if (this.attachment) return;
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }

    const { createNativeClient, getDefaultLibraryFilename } = loadNativeDriver();
    this.client = createNativeClient(this.libraryPath ?? getDefaultLibraryFilename());

    try {
      this.attachment = await this.client.connect(this.dbPath, this.connectOptions);
    } catch {
      // Database does not exist yet – create it.
      this.attachment = await this.client.createDatabase(this.dbPath, this.connectOptions);
    }
    this.statements = new StatementCache(this.attachment, this.statementCacheSize);
  }

  /**
   * Execute a DDL or DML statement that does not return rows.
   *
   * The statement is executed in its own auto-committed transaction.
   *
   * Accepts a `` sql`…` `` fragment in place of a string, in which case its
   * values are bound rather than interpolated.
   */
  async exec(sql: string | SqlFragment, params: QueryParams = []): Promise<void> {
    // Delegated rather than reimplemented: "parameters present → prepare,
    // execute, dispose; otherwise execute directly" is a rule that belongs in
    // one place, and `transaction()` already wraps it in the commit-or-roll-
    // back this needs. Two copies would drift the first time either grows a
    // case.
    await this.transaction((tx) => tx.exec(sql, params));
  }

  /**
   * Execute one statement once per row of parameters: a batch, prepared once
   * and executed per row in one transaction, all or nothing.  The same call
   * as the browser backend's.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<void> {
    await this.transaction((tx) => tx.execBatch(sql, rows));
  }

  /**
   * Execute a (parameterised) SQL statement and return the result rows.
   *
   * For SELECT queries the rows are returned as plain objects keyed by the
   * column name as Firebird reports it, mirroring the PGlite convention: an
   * unquoted name in upper case (`SELECT title` gives `TITLE`), a quoted alias
   * as written (`SELECT title AS "title"` gives `title`).
   *
   * ```ts
   * await db.query('SELECT * FROM items WHERE id = ?', [id]);
   * await db.query(sql`SELECT * FROM items WHERE id = ${id}`);
   * ```
   */
  // `rowMode: 'array'` first, so the literal in the options object picks these
  // and the return type follows the mode rather than the caller's hope.
  async query(
    sql: SqlFragment,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  async query<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  // Both shapes at once, so a caller holding a `string | SqlFragment` — one
  // built conditionally — can call this without casting. Last, so the two
  // specific overloads still win where they apply.
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryOptions = [],
    maybeOptions: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    await this.ensureReady();
    const { statement, options } = resolveQueryCall(sql, paramsOrOptions, maybeOptions);
    const rowMode: RowMode = (options as QueryOptions).rowMode ?? 'object';
    const attachment = this.attachment!;

    if (
      this.sharedReads &&
      options.isolationLevel === undefined &&
      options.readOnly === undefined &&
      !this.ownTransaction.has(statement.sql)
    ) {
      const shared = await this.sharedRead<T>(statement.sql, statement.params, rowMode);
      if (shared) return shared;
    }
    await this.endReadTransaction();

    const serializedParams = this.serialize(statement.params);
    const txOptions = buildTransactionOptions(options);
    const transaction = await attachment.startTransaction(txOptions);

    let rows: T[];
    let fields: FieldInfo[];
    try {
      const lease = await this.statements!.acquire(transaction, statement.sql);
      const stmt = lease.stmt;

      // Released in `finally`, not after the fetch: a statement that throws on
      // execute — a lock conflict, an overflow, a wrong parameter count — would
      // otherwise leak its handle, and the retry loop such failures are usually
      // wrapped in leaks one per attempt until the attachment refuses more.
      let failed = true;
      try {
        fields = await outputFields(stmt);

        rows = shapeRows<T>(
          await fetchRows(stmt, transaction, serializedParams, fields, this.types),
          fields,
          rowMode,
        );
        failed = false;
      } finally {
        await lease.release(failed);
      }

      // After the statement is disposed, as before — the commit is the last
      // thing that happens on the success path.
      try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }

    return applyTypes({ rows, fields }, this.types, rowMode);
  }

  /**
   * Stream a SQL query's result set in batches of `batchSize` rows (default 500).
   *
   * Yields one `QueryResult<T>` batch per cursor fetch instead of materialising
   * the entire result set into memory at once.  Breaking out of the `for await`
   * loop early closes the cursor and finishes the transaction immediately.
   */
  queryStream(
    sql: SqlFragment,
    options: ArrayStreamOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayStreamOptions,
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    sql: SqlFragment,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: QueryStreamOptions,
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | QueryStreamOptions = [],
    maybeOptions: QueryStreamOptions = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    const { statement, options } = resolveQueryCall<QueryStreamOptions>(
      sql,
      paramsOrOptions,
      maybeOptions,
    );
    const batchSize = resolveBatchSize(options.batchSize);
    return this.streamQuery<T>(statement, options, batchSize);
  }

  private async *streamQuery<T>(
    statement: ParsedStatement,
    options: QueryStreamOptions,
    batchSize: number,
  ): AsyncIterableIterator<QueryResult<T>> {
    await this.ensureReady();
    const rowMode: RowMode = options.rowMode ?? 'object';
    const attachment = this.attachment!;
    await this.endReadTransaction();

    const serializedParams = this.serialize(statement.params);
    const txOptions = buildTransactionOptions(options);
    const transaction = await attachment.startTransaction(txOptions);

    let engineFailed = false;
    let lease: StatementLease | undefined;
    let txFinished = false;

    try {
      try {
        lease = await this.statements!.acquire(transaction, statement.sql);
      } catch (err) {
        engineFailed = true;
        throw err;
      }
      const stmt = lease.stmt;

      let fields: FieldInfo[];
      try {
        fields = await outputFields(stmt);
      } catch (err) {
        engineFailed = true;
        throw err;
      }

      yield* streamRows<T>(
        stmt,
        transaction,
        serializedParams,
        fields,
        rowMode,
        batchSize,
        this.types,
        () => {
          engineFailed = true;
        },
      );

      const toRelease = lease;
      lease = undefined;
      await toRelease.release(false);

      txFinished = true;
      try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
    } finally {
      if (lease) {
        await lease.release(engineFailed);
      }
      if (!txFinished) {
        if (engineFailed) {
          await transaction.rollback().catch(() => undefined);
        } else {
          await transaction
            .commit()
            .catch(() => transaction.rollback().catch(() => undefined));
        }
      }
    }
  }

  /**
   * Run a SELECT in the shared read-only transaction, starting it if need be.
   *
   * `undefined` means "run it in a transaction of its own": the statement is
   * not a SELECT, or it tried to write ("attempted update during read-only
   * transaction"). Either way its text is remembered, so the next call goes
   * there directly. Any other failure ends the shared transaction, so the
   * next read starts afresh, and is thrown.
   */
  private async sharedRead<T>(
    sql: string,
    params: QueryParams,
    rowMode: RowMode,
  ): Promise<QueryResult<T> | undefined> {
    const serializedParams = this.serialize(params);
    const attachment = this.attachment!;
    this.readTransaction ??= await attachment.startTransaction({
      isolation: TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      accessMode: 'READ_ONLY',
    });
    const transaction = this.readTransaction;

    let lease: StatementLease;
    try {
      lease = await this.statements!.acquire(transaction, sql);
    } catch (err) {
      await this.endReadTransaction();
      throw err;
    }
    const stmt = lease.stmt;
    // A writing SELECT stays kept: only the transaction was wrong for it.
    let failed = false;
    let fields: FieldInfo[];
    let rawRows: unknown[][];
    try {
      if ((await stmt.type) !== STMT_SELECT) {
        this.remember(sql);
        return undefined;
      }
      fields = await outputFields(stmt);
      rawRows = await fetchRows(stmt, transaction, serializedParams, fields, this.types);
    } catch (err) {
      // The native driver's errors carry only the message text.
      if (/attempted update during read-only transaction/.test(String((err as Error)?.message))) {
        this.remember(sql);
        return undefined;
      }
      failed = true;
      await this.endReadTransaction();
      throw err;
    } finally {
      await lease.release(failed);
    }
    return applyTypes({ rows: shapeRows<T>(rawRows, fields, rowMode), fields }, this.types, rowMode);
  }

  private remember(sql: string): void {
    if (this.ownTransaction.size >= 1024) this.ownTransaction.clear();
    this.ownTransaction.add(sql);
  }

  /**
   * End the shared read transaction, before anything but a shared read runs.
   *
   * On a server, an open transaction that has read a table makes `DROP TABLE`
   * fail with "object in use", and `exec()` runs DDL without preparing it, so
   * this cannot be kept to DDL as the WASM engine does: the shared transaction
   * lives across consecutive reads only. A run of reads keeps it; a write
   * between two reads costs what a transaction per read used to.
   */
  private async endReadTransaction(): Promise<void> {
    const transaction = this.readTransaction;
    this.readTransaction = null;
    if (transaction) await transaction.commit().catch(() => transaction.rollback().catch(() => undefined));
  }

  /**
   * Describe a statement's shape without running it.
   *
   * ```ts
   * const shape = await db.describeQuery('SELECT id, name FROM items WHERE id = ?');
   * // shape.params        → [{ name: '', type: 496, typeName: 'INTEGER', ... }]
   * // shape.fields        → [{ name: 'ID', type: 496, typeName: 'INTEGER', ... }, ...]
   * // shape.statementType → 'SELECT'
   * ```
   *
   * The statement is prepared and disposed, so nothing runs: describing an
   * `INSERT` inserts nothing. Both `params` and `fields` carry the full
   * {@link FieldInfo} from Firebird's prepared input and output metadata.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const text = toStatement(sql).sql;

    const transaction = await attachment.startTransaction();
    try {
      const stmt = await attachment.prepare(transaction, text);
      try {
        const params = await describeInputFields(stmt);
        const fields = await outputFields(stmt);
        const type = await stmt.type;

        return {
          params,
          fields,
          statementType: statementKind(type),
          hasResultSet: stmt.hasResultSet,
        };
      } finally {
        await stmt.dispose().catch(() => undefined);
      }
    } finally {
      // Nothing ran, so there is nothing to commit — but the transaction still
      // has to be finished.
      await transaction.commit().catch(() => undefined);
    }
  }

  /**
   * Return Firebird's execution plan for `sql` (`IStatement::getPlan`) without
   * executing the statement.
   *
   * By default (`{ detailed: false }`), returns the compact `PLAN (...)` string.
   * With `{ detailed: true }`, returns Firebird 5/6's structured multi-line
   * explained plan tree (`Select Expression\n    -> ...`). Statements that carry
   * no execution plan (such as DDL) return `""`.
   */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const text = toStatement(sql).sql;
    const detailed = options.detailed === true;

    const transaction = await attachment.startTransaction();
    try {
      const stmt = await attachment.prepare(transaction, text);
      try {
        return await explainStatement(stmt, detailed);
      } finally {
        await stmt.dispose().catch(() => undefined);
      }
    } finally {
      await transaction.commit().catch(() => undefined);
    }
  }

  /**
   * Inspect database size, page utilization, ODS version, transaction counters
   * (OIT/OAT/OST/Next), memory pool usage, and page I/O statistics
   * (`IAttachment::getInfo`).
   *
   * ```ts
   * const info = await db.databaseInfo();
   * // info.pageSize          → 8192
   * // info.allocatedPages    → 280
   * // info.databaseSizeBytes → 2293760
   * // info.transactionGap    → info.nextTransaction - info.oldestActive
   * ```
   */
  async databaseInfo(): Promise<DatabaseInfo> {
    await this.ensureReady();
    const attachment = this.attachment as unknown as {
      attachmentHandle?: {
        getInfoAsync?: (
          status: unknown,
          itemsLength: number,
          items: Uint8Array,
          bufferLength: number,
          buffer: Uint8Array,
        ) => Promise<void>;
        getInfoSync?: (
          status: unknown,
          itemsLength: number,
          items: Uint8Array,
          bufferLength: number,
          buffer: Uint8Array,
        ) => void;
      };
      client?: {
        statusAction?: <T>(fn: (status: unknown) => Promise<T>) => Promise<T>;
      };
    };

    const client = attachment?.client;
    const getInfoAsync = attachment?.attachmentHandle?.getInfoAsync;
    const getInfoSync = attachment?.attachmentHandle?.getInfoSync;

    if (typeof client?.statusAction === 'function' && typeof getInfoAsync === 'function') {
      return client.statusAction(async (status) => {
        const buffer = new Uint8Array(512);
        await getInfoAsync.call(
          attachment.attachmentHandle,
          status,
          DATABASE_INFO_REQUEST_ITEMS.byteLength,
          DATABASE_INFO_REQUEST_ITEMS,
          buffer.byteLength,
          buffer,
        );
        return parseDatabaseInfoBuffer(buffer);
      });
    }
    if (typeof client?.statusAction === 'function' && typeof getInfoSync === 'function') {
      return client.statusAction(async (status) => {
        const buffer = new Uint8Array(512);
        getInfoSync.call(
          attachment.attachmentHandle,
          status,
          DATABASE_INFO_REQUEST_ITEMS.byteLength,
          DATABASE_INFO_REQUEST_ITEMS,
          buffer.byteLength,
          buffer,
        );
        return parseDatabaseInfoBuffer(buffer);
      });
    }

    const dbRes = await this.query<Record<string, unknown>>(
      'SELECT MON$PAGE_SIZE, MON$PAGES, MON$ODS_MAJOR, MON$ODS_MINOR, ' +
        'MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$OLDEST_SNAPSHOT, ' +
        'MON$NEXT_TRANSACTION, MON$PAGE_BUFFERS FROM MON$DATABASE',
    );
    const dbRow = dbRes.rows[0] ?? {};
    let currentMemory = 0;
    let maxMemory = 0;
    let reads = 0;
    let writes = 0;
    let fetches = 0;
    let marks = 0;
    try {
      const memRes = await this.query<Record<string, unknown>>(
        'SELECT MON$MEMORY_USED, MON$MEMORY_MAX_USED FROM MON$MEMORY_USAGE WHERE MON$STAT_GROUP = 0',
      );
      const memRow = memRes.rows[0] ?? {};
      currentMemory = Number(memRow['MON$MEMORY_USED'] ?? 0);
      maxMemory = Number(memRow['MON$MEMORY_MAX_USED'] ?? 0);
    } catch {
      // Optional monitoring table
    }
    try {
      const ioRes = await this.query<Record<string, unknown>>(
        'SELECT MON$PAGE_READS, MON$PAGE_WRITES, MON$PAGE_FETCHES, MON$PAGE_MARKS FROM MON$IO_STATS WHERE MON$STAT_GROUP = 0',
      );
      const ioRow = ioRes.rows[0] ?? {};
      reads = Number(ioRow['MON$PAGE_READS'] ?? 0);
      writes = Number(ioRow['MON$PAGE_WRITES'] ?? 0);
      fetches = Number(ioRow['MON$PAGE_FETCHES'] ?? 0);
      marks = Number(ioRow['MON$PAGE_MARKS'] ?? 0);
    } catch {
      // Optional monitoring table
    }
    return normalizeDatabaseInfo({
      pageSize: Number(dbRow['MON$PAGE_SIZE'] ?? 0),
      allocatedPages: Number(dbRow['MON$PAGES'] ?? 0),
      odsVersion: Number(dbRow['MON$ODS_MAJOR'] ?? 0),
      odsMinorVersion: Number(dbRow['MON$ODS_MINOR'] ?? 0),
      oldestTransaction: Number(dbRow['MON$OLDEST_TRANSACTION'] ?? 0),
      oldestActive: Number(dbRow['MON$OLDEST_ACTIVE'] ?? 0),
      oldestSnapshot: Number(dbRow['MON$OLDEST_SNAPSHOT'] ?? 0),
      nextTransaction: Number(dbRow['MON$NEXT_TRANSACTION'] ?? 0),
      currentMemory,
      maxMemory,
      pageBuffers: Number(dbRow['MON$PAGE_BUFFERS'] ?? 0),
      reads,
      writes,
      fetches,
      marks,
    });
  }

  /**
   * Introspect the database catalog (`RDB$RELATIONS`, `RDB$RELATION_FIELDS`,
   * `RDB$FIELDS`, `RDB$RELATION_CONSTRAINTS`, `RDB$REF_CONSTRAINTS`,
   * `RDB$INDICES`, `RDB$GENERATORS`, and `RDB$TRIGGERS`) and return typed
   * metadata (`tables`, `views`, `columns`, `primaryKeys`, `foreignKeys`,
   * `indexes`, `sequences`, and `triggers`).
   */
  async introspect(options: IntrospectOptions = {}): Promise<SchemaIntrospection> {
    await this.ensureReady();
    return introspectSchema(this, options);
  }

  /**
   * Apply (or revert with `direction: 'down'`) versioned schema migrations
   * transactionally, recording applied versions in `FB_MIGRATIONS$`.
   */
  async migrate(
    migrations: readonly Migration[],
    options: MigrateOptions = {},
  ): Promise<MigrateResult> {
    await this.ensureReady();
    return runMigrations(this, migrations, options);
  }

  /**
   * Trigger an immediate database garbage-collection sweep, scanning user
   * tables to collect old record versions and advancing OIT/OAT counters.
   */
  async sweep(): Promise<SweepResult> {
    await this.ensureReady();
    const started = performance.now();
    await this.endReadTransaction();
    const before = await this.databaseInfo();

    let tablesScanned = 0;
    try {
      const relRes = await this.query<Record<string, unknown>>(
        'SELECT TRIM(RDB$RELATION_NAME) AS REL FROM RDB$RELATIONS ' +
          'WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ' +
          'ORDER BY RDB$RELATION_NAME',
      );
      for (const row of relRes.rows) {
        const rel = String(row['REL'] ?? row['rel'] ?? '').trim();
        if (!rel) continue;
        const escaped = rel.replace(/"/g, '""');
        await this.query(`SELECT COUNT(*) AS C FROM "${escaped}"`);
        tablesScanned += 1;
      }
    } catch {
      // Ignore scan errors if a relation is inaccessible.
    }

    await this.endReadTransaction();
    const attachment = this.attachment!;
    const tx = await attachment.startTransaction();
    await tx.commit().catch(() => tx.rollback().catch(() => undefined));

    const after = await this.databaseInfo();
    return buildSweepResult(before, after, tablesScanned, performance.now() - started);
  }

  /**
   * Prepare a SQL statement explicitly and return a reusable
   * {@link PreparedStatement} handle exposing `fields`, `params`, `query()`,
   * `exec()`, `execBatch()`, and `close()`.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const sqlText = toStatement(sql).sql;

    const prepareTx = await attachment.startTransaction();
    let nativeStmt: Statement;
    let params: FieldInfo[];
    let fields: FieldInfo[];
    let type: number;
    try {
      nativeStmt = await attachment.prepare(prepareTx, sqlText);
      try {
        params = await describeInputFields(nativeStmt);
        fields = await outputFields(nativeStmt);
        type = await nativeStmt.type;
      } catch (err) {
        await nativeStmt.dispose().catch(() => undefined);
        throw err;
      }
    } finally {
      await prepareTx.commit().catch(() => undefined);
    }

    const statementType = statementKind(type);
    const hasResultSet = nativeStmt.hasResultSet;
    let isClosed = false;
    let busy = false;
    const isDbClosed = () => this.closed;

    const assertOpen = (): void => {
      if (isClosed || this.closed) {
        throw new Error('PreparedStatement has been closed');
      }
    };

    const checkParamCount = (actual: number): void => {
      if (actual !== params.length) {
        throw new Error(
          `PreparedStatement expects ${params.length} parameter(s) but ${actual} were supplied`,
        );
      }
    };

    const withStatement = async <R>(
      transaction: Transaction,
      fn: (target: Statement) => Promise<R>,
    ): Promise<R> => {
      if (!busy) {
        busy = true;
        try {
          return await fn(nativeStmt);
        } finally {
          busy = false;
          if (isClosed) {
            await nativeStmt.dispose().catch(() => undefined);
          }
        }
      }
      const tempStmt = await attachment.prepare(transaction, sqlText);
      try {
        return await fn(tempStmt);
      } finally {
        await tempStmt.dispose().catch(() => undefined);
      }
    };

    const stmt: PreparedStatement = {
      sql: sqlText,
      get params() {
        return params.map((p) => ({ ...p }));
      },
      get fields() {
        return fields.map((f) => ({ ...f }));
      },
      statementType,
      hasResultSet,
      get closed() {
        return isClosed || isDbClosed();
      },
      query: (async <T = Row>(
        paramsOrOptions: QueryParams | QueryOptions = [],
        maybeOptions: QueryOptions = {},
      ): Promise<QueryResult<T>> => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const callOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        checkParamCount(callParams.length);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const serializedParams = this.serialize(callParams);
        await this.endReadTransaction();
        const txOptions = buildTransactionOptions(callOptions);
        const transaction = await attachment.startTransaction(txOptions);
        try {
          const rawRows = await withStatement(transaction, (target) =>
            fetchRows(target, transaction, serializedParams, fields, this.types),
          );
          try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          const outFields = fields.map((f) => ({ ...f }));
          return applyTypes(
            { rows: shapeRows<T>(rawRows, outFields, rowMode), fields: outFields },
            this.types,
            rowMode,
          );
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      }) as PreparedStatement['query'],
      queryStream: (<T = Row>(
        paramsOrOptions: QueryParams | QueryStreamOptions = [],
        maybeOptions: QueryStreamOptions = {},
      ): AsyncIterableIterator<QueryResult<T>> => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const callOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        checkParamCount(callParams.length);
        const batchSize = resolveBatchSize(callOptions.batchSize);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const serializeParams = () => this.serialize(callParams);
        const endReadTx = () => this.endReadTransaction();
        const customTypes = this.types;

        return (async function* (): AsyncIterableIterator<QueryResult<T>> {
          assertOpen();
          const serializedParams = serializeParams();
          await endReadTx();
          const txOptions = buildTransactionOptions(callOptions);
          const transaction = await attachment.startTransaction(txOptions);

          let engineFailed = false;
          let txFinished = false;
          let claimedPrimary = false;
          let tempStmt: Statement | undefined;

          try {
            let target: Statement;
            if (!busy) {
              busy = true;
              claimedPrimary = true;
              target = nativeStmt;
            } else {
              try {
                tempStmt = await attachment.prepare(transaction, sqlText);
              } catch (err) {
                engineFailed = true;
                throw err;
              }
              target = tempStmt;
            }

            yield* streamRows<T>(
              target,
              transaction,
              serializedParams,
              fields,
              rowMode,
              batchSize,
              customTypes,
              () => {
                engineFailed = true;
              },
            );

            if (tempStmt) {
              const toDispose = tempStmt;
              tempStmt = undefined;
              await toDispose.dispose().catch(() => undefined);
            }
            if (claimedPrimary) {
              claimedPrimary = false;
              busy = false;
              if (isClosed) {
                await nativeStmt.dispose().catch(() => undefined);
              }
            }

            txFinished = true;
            try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          } finally {
            if (tempStmt) {
              await tempStmt.dispose().catch(() => undefined);
            }
            if (claimedPrimary) {
              busy = false;
              if (isClosed) {
                await nativeStmt.dispose().catch(() => undefined);
              }
            }
            if (!txFinished) {
              if (engineFailed) {
                await transaction.rollback().catch(() => undefined);
              } else {
                await transaction
                  .commit()
                  .catch(() => transaction.rollback().catch(() => undefined));
              }
            }
          }
        })();
      }) as PreparedStatement['queryStream'],
      exec: async (callParams: QueryParams = []) => {
        assertOpen();
        checkParamCount(callParams.length);
        const serializedParams = this.serialize(callParams);
        await this.endReadTransaction();
        const transaction = await attachment.startTransaction();
        try {
          const affectedRows = await withStatement(transaction, async (target) => {
            await target.execute(
              transaction,
              await bindParams(target, transaction, serializedParams),
            );
            return readAffectedRecords(target);
          });
          try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          return { affectedRows };
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        if (!Array.isArray(rows)) {
          throw new TypeError('execBatch takes an array of parameter rows');
        }
        for (const row of rows) {
          checkParamCount(row.length);
        }
        if (rows.length === 0) return { affectedRows: 0 };
        const serializedRows = this.types?.serializers?.length
          ? rows.map((row) => this.serialize(row))
          : rows;
        await this.endReadTransaction();
        const transaction = await attachment.startTransaction();
        try {
          const affectedRows = await withStatement(transaction, async (target) => {
            if (
              serializedRows.length > 1 &&
              (await tryExecuteNativeBatch(target, transaction, serializedRows))
            ) {
              return serializedRows.length;
            }
            let total = 0;
            for (const row of serializedRows) {
              await target.execute(
                transaction,
                await bindParams(target, transaction, row),
              );
              total += (await readAffectedRecords(target)) || 1;
            }
            return total;
          });
          try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
          return { affectedRows };
        } catch (err) {
          await transaction.rollback().catch(() => undefined);
          throw err;
        }
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        this.preparedStatements.delete(stmt);
        if (!busy) {
          await nativeStmt.dispose().catch(() => undefined);
        }
      },
      [Symbol.asyncDispose]: async () => {
        await stmt.close();
      },
    };

    this.preparedStatements.add(stmt);
    return stmt;
  }

  /**
   * Run a function inside an explicit transaction.
   *
   * The transaction is automatically committed on success or rolled back on
   * error.
   */
  async transaction<T>(
    fn: (tx: FirebirdTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const txOptions = buildTransactionOptions(options);
    await this.endReadTransaction();
    const transaction = await attachment.startTransaction(txOptions);

    // A shared read made from inside the callback starts the shared
    // transaction again; each statement here ends it first.
    const tx = new FirebirdTransaction(
      attachment,
      transaction,
      () => this.endReadTransaction(),
      this.statements ?? undefined,
      this.types,
    );

    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      // The callback may have rolled back before throwing; rolling back twice
      // targets a transaction the driver has already finished with.
      if (!tx.isFinished) {
        await transaction.rollback().catch(() => undefined);
      }
      throw err;
    }

    // A callback that rolled back deliberately must not then be committed.
    if (tx.isFinished) {
      return result;
    }

    try {
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
    return result;
  }

  /**
   * Read the database file as a `Uint8Array`.
   */
  /**
   * Create a segmented writable BLOB stream (`WritableStream<Uint8Array>`)
   * backed by Firebird `IBlob::putSegment`.
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    await this.ensureReady();
    resolveBlobSegmentSize(options.segmentSize, true);

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

  /**
   * Open a Firebird `BLOB` column (from a `SELECT` query or a {@link BlobHandle})
   * as a segmented Web `ReadableStream<Uint8Array>` backed by `IBlob::getSegment`.
   */
  async openBlobStream(
    handle: BlobHandle,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: SqlFragment,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: string | SqlFragment,
    params?: QueryParams | BlobStreamOptions,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions: QueryParams | BlobStreamOptions = [],
    maybeOptions: BlobStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    await this.ensureReady();
    const attachment = this.attachment!;

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
      const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      if (staged) {
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              if (offset >= staged.byteLength) return null;
              const end = Math.min(offset + maxBytes, staged.byteLength);
              const slice = staged.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      await this.endReadTransaction();
      const tx = await attachment.startTransaction(
        buildTransactionOptions({ isolationLevel: 'READ_COMMITTED', readOnly: true }),
      );
      const fbBlob =
        ((sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.nativeBlob as FbBlob | undefined) ??
        new FbBlob(attachment, sqlOrHandle.blobId);
      let stream: Awaited<ReturnType<Attachment['openBlob']>>;
      try {
        stream = await attachment.openBlob(tx, fbBlob);
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }

      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            const buf = Buffer.alloc(maxBytes);
            const n = await stream.read(buf);
            if (n < 0) return null;
            return new Uint8Array(buf.buffer, buf.byteOffset, n);
          },
          close: async () => {
            await stream.close().catch(() => undefined);
            await tx.commit().catch(() => tx.rollback().catch(() => undefined));
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
    await this.endReadTransaction();

    const tx = await attachment.startTransaction(
      buildTransactionOptions({ isolationLevel: 'READ_COMMITTED', readOnly: true }),
    );
    try {
      return await openNativeQueryBlobStream(
        attachment,
        tx,
        this.statements!,
        statement.sql,
        this.serialize(statement.params),
        options,
        true,
      );
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  async dumpDataDir(): Promise<Uint8Array> {
    await this.ensureReady();
    const buf = await fs.promises.readFile(this.dbPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Stream the database file in fixed-size chunks
   * (`ReadableStream<Uint8Array>`) without allocating a single contiguous
   * `Uint8Array` of the entire database in memory.
   *
   * Pass `{ compression: 'gzip' }` to compress on the fly via
   * `CompressionStream('gzip')`.
   */
  dumpDataStream(options: DataStreamOptions = {}): ReadableStream<Uint8Array> {
    const chunkSize = resolveStreamChunkSize(options.chunkSize);
    let handle: fs.promises.FileHandle | null = null;
    let totalSize = 0;
    let offset = 0;

    const closeHandle = async (): Promise<void> => {
      if (handle) {
        const h = handle;
        handle = null;
        await h.close().catch(() => undefined);
      }
    };

    const raw = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          await this.ensureReady();
          if (!handle) {
            handle = await fs.promises.open(this.dbPath, 'r');
            const stat = await handle.stat();
            totalSize = stat.size;
          }
          if (offset >= totalSize) {
            await closeHandle();
            controller.close();
            return;
          }
          const toRead = Math.min(chunkSize, totalSize - offset);
          const buf = new Uint8Array(toRead);
          const { bytesRead } = await handle.read(buf, 0, toRead, offset);
          if (bytesRead <= 0) {
            await closeHandle();
            controller.close();
            return;
          }
          offset += bytesRead;
          controller.enqueue(bytesRead === toRead ? buf : buf.slice(0, bytesRead));
          if (offset >= totalSize) {
            await closeHandle();
            controller.close();
          }
        } catch (err) {
          await closeHandle();
          throw err;
        }
      },
      cancel: async () => {
        await closeHandle();
      },
    });

    return options.compression === 'gzip' ? compressGzipStream(raw) : raw;
  }

  /**
   * Replace the database file with a raw or gzip-compressed `.fdb` byte stream
   * produced by {@link dumpDataStream} without buffering the entire database
   * in a single `Uint8Array`.
   */
  async loadDataStream(
    stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options: DataStreamOptions = {},
  ): Promise<void> {
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }
    await this.ensureReady();

    await this.endReadTransaction();
    for (const stmt of [...this.preparedStatements]) {
      await stmt.close().catch(() => undefined);
    }
    await this.statements?.flush();
    this.statements = null;
    if (this.attachment) {
      await this.attachment.disconnect().catch(() => undefined);
      this.attachment = null;
    }

    const handle = await fs.promises.open(this.dbPath, 'w');
    let offset = 0;
    try {
      for await (const chunk of readDatabaseStreamChunks(stream, options)) {
        await handle.write(chunk, 0, chunk.byteLength, offset);
        offset += chunk.byteLength;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (offset === 0) {
      throw new RangeError(
        'loadDataStream received an empty stream; pass a stream from dumpDataStream()',
      );
    }

    this.attachment = await this.client!.connect(this.dbPath, this.connectOptions);
    this.statements = new StatementCache(this.attachment, this.statementCacheSize);
  }

  /**
   * Close the database connection and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.endReadTransaction();
    for (const stmt of [...this.preparedStatements]) {
      await stmt.close().catch(() => undefined);
    }
    await this.statements?.flush();
    this.statements = null;
    if (this.attachment) {
      await this.attachment.disconnect().catch(() => undefined);
      this.attachment = null;
    }
    if (this.client) {
      await this.client.dispose().catch(() => undefined);
      this.client = null;
    }
  }
}

const SAVEPOINT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function validateSavepointName(name: string): string {
  if (typeof name !== 'string' || !SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid savepoint name "${String(name)}": must be a valid SQL identifier (1-63 ASCII letters, digits, '_', or '$', starting with a letter or '_')`,
    );
  }
  return name;
}

/**
 * A handle to an active Firebird transaction (or nested savepoint), exposed to
 * callers of `FirebirdLite.transaction()`.
 */
export class FirebirdTransaction {
  private finished = false;
  private readonly nextSavepointId: () => number;

  constructor(
    private readonly attachment: Attachment,
    private readonly transaction: Transaction,
    private readonly beforeStatement: () => Promise<void> = async () => undefined,
    private readonly statements: StatementCache = new StatementCache(attachment, 0),
    private readonly types?: TypeOptions,
    readonly savepointName?: string,
    private readonly parent?: FirebirdTransaction,
    nextSavepointId?: () => number,
  ) {
    if (nextSavepointId) {
      this.nextSavepointId = nextSavepointId;
    } else {
      let counter = 0;
      this.nextSavepointId = () => {
        counter += 1;
        return counter;
      };
    }
  }

  private serialize(params: QueryParams): QueryParams {
    return applySerializers(params, this.types?.serializers);
  }

  /** Whether this transaction (or savepoint) has already finished or been rolled back. */
  get isFinished(): boolean {
    return this.finished || (this.parent ? this.parent.isFinished : false);
  }

  private markFinished(): void {
    this.finished = true;
  }

  /**
   * Roll this transaction (or savepoint) back and stop.
   *
   * When called on the root transaction, the enclosing `transaction()` will not
   * commit afterwards. When called on a savepoint handle inside `tx.savepoint()`,
   * only the work since the savepoint is undone (`ROLLBACK TO SAVEPOINT` +
   * `RELEASE SAVEPOINT ... ONLY`) and the enclosing transaction remains active.
   */
  async rollback(): Promise<void> {
    if (this.isFinished) return;
    this.finished = true;
    if (this.savepointName) {
      await this.beforeStatement();
      await this.attachment.execute(
        this.transaction,
        `ROLLBACK TO SAVEPOINT ${this.savepointName}`,
      );
      await this.attachment.execute(
        this.transaction,
        `RELEASE SAVEPOINT ${this.savepointName} ONLY`,
      );
      return;
    }
    await this.transaction.rollback();
  }

  private assertUsable(): void {
    if (this.isFinished) {
      throw new Error(
        this.savepointName
          ? `Savepoint "${this.savepointName}" has already finished`
          : 'Transaction has already been rolled back',
      );
    }
  }

  /**
   * Run `fn` inside a SQL `SAVEPOINT` within this transaction.
   *
   * - If `fn` resolves (and `sp.rollback()` was not called), the savepoint is
   *   released via `RELEASE SAVEPOINT <name> ONLY`.
   * - If `fn` throws an error, the work inside the savepoint is undone via
   *   `ROLLBACK TO SAVEPOINT <name>` + `RELEASE SAVEPOINT <name> ONLY` and the
   *   error is re-thrown while the outer transaction stays active.
   * - If `await sp.rollback()` is called inside `fn`, the savepoint is rolled
   *   back and released without throwing, and `fn`'s return value is returned.
   * - Savepoints can be nested arbitrarily; when `name` is omitted, unique
   *   names (`sp_1`, `sp_2`, ...) are generated automatically.
   */
  savepoint<T>(fn: (sp: FirebirdTransaction) => Promise<T>): Promise<T>;
  savepoint<T>(
    name: string,
    fn: (sp: FirebirdTransaction) => Promise<T>,
  ): Promise<T>;
  async savepoint<T>(
    nameOrFn: string | ((sp: FirebirdTransaction) => Promise<T>),
    maybeFn?: (sp: FirebirdTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    const name =
      typeof nameOrFn === 'string'
        ? validateSavepointName(nameOrFn)
        : `sp_${this.nextSavepointId()}`;
    const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn;
    if (typeof fn !== 'function') {
      throw new TypeError('savepoint requires a callback function');
    }

    await this.beforeStatement();
    await this.attachment.execute(this.transaction, `SAVEPOINT ${name}`);

    const sp = new FirebirdTransaction(
      this.attachment,
      this.transaction,
      this.beforeStatement,
      this.statements,
      this.types,
      name,
      this,
      this.nextSavepointId,
    );

    let result: T;
    try {
      result = await fn(sp);
    } catch (err) {
      if (!sp.isFinished) {
        sp.markFinished();
        await this.beforeStatement().catch(() => undefined);
        await this.attachment
          .execute(this.transaction, `ROLLBACK TO SAVEPOINT ${name}`)
          .catch(() => undefined);
        await this.attachment
          .execute(this.transaction, `RELEASE SAVEPOINT ${name} ONLY`)
          .catch(() => undefined);
      }
      throw err;
    }

    if (!sp.isFinished) {
      sp.markFinished();
      await this.beforeStatement();
      await this.attachment.execute(
        this.transaction,
        `RELEASE SAVEPOINT ${name} ONLY`,
      );
    }

    return result;
  }

  /**
   * Execute a DDL or DML statement inside this transaction.
   */
  async exec(sql: string | SqlFragment, params: QueryParams = []): Promise<void> {
    this.assertUsable();
    await this.beforeStatement();
    const statement = toStatement(sql, params);
    const serialized = this.serialize(statement.params);
    // With the cache off, a statement without parameters runs as it always
    // did. With it on, every statement goes through the cache, which is also
    // what sees DDL coming and empties itself first.
    if (serialized.length > 0 || this.statements.enabled) {
      const lease = await this.statements.acquire(this.transaction, statement.sql);
      let failed = true;
      try {
        await lease.stmt.execute(this.transaction, await bindParams(lease.stmt, this.transaction, serialized));
        failed = false;
      } finally {
        await lease.release(failed);
      }
    } else {
      await this.attachment.execute(this.transaction, statement.sql);
    }
  }

  /**
   * Execute one statement once per row of parameters inside this
   * transaction: prepared once, executed per row.
   */
  async execBatch(sql: string, rows: QueryParams[]): Promise<void> {
    this.assertUsable();
    await this.beforeStatement();
    if (!Array.isArray(rows)) {
      throw new TypeError('execBatch takes an array of parameter rows');
    }
    if (rows.length === 0) return;
    const serializedRows = this.types?.serializers?.length
      ? rows.map((row) => this.serialize(row))
      : rows;
    const lease = await this.statements.acquire(this.transaction, sql);
    let failed = true;
    try {
      if (
        serializedRows.length > 1 &&
        (await tryExecuteNativeBatch(lease.stmt, this.transaction, serializedRows))
      ) {
        failed = false;
        return;
      }
      const plan = serializedRows.length > 1 ? await this.blockPlan(sql, lease.stmt) : undefined;
      if (plan) {
        await this.executeInBlocks(lease.stmt, plan, serializedRows);
      } else {
        for (const row of serializedRows) {
          await lease.stmt.execute(this.transaction, await bindParams(lease.stmt, this.transaction, row));
        }
      }
      failed = false;
    } finally {
      await lease.release(failed);
    }
  }

  /**
   * How to run `sql` as an `EXECUTE BLOCK` over many rows, or `undefined` to
   * run it row by row: it is not plain DML or a procedure call, it returns
   * something, or a parameter's type cannot be declared. See batch-block.ts.
   */
  private async blockPlan(
    sql: string,
    stmt: Statement,
  ): Promise<{ build: (rows: number) => string } | undefined> {
    const type = await stmt.type;
    // INSERT, UPDATE, DELETE, EXECUTE PROCEDURE; nothing with a result.
    if (![2, 3, 4, 8].includes(type) || stmt.hasResultSet) return undefined;
    if ((await outputFields(stmt)).length > 0) return undefined;

    const params = await inputParams(stmt);
    const offsets = placeholderOffsets(sql);
    if (!params || params.length === 0 || !offsets || offsets.length !== params.length) {
      return undefined;
    }
    const charsets = await characterSets(this.attachment, this.transaction);
    const types = params.map((p) => blockParamType(p, charsets));
    if (types.some((t) => t === undefined)) return undefined;
    return { build: (rows) => buildBlock(sql, offsets, types as string[], rows) };
  }

  /**
   * Run `rows` through blocks of up to {@link BLOCK_ROWS} rows each.
   *
   * A block that will not prepare (more contexts than the engine's 256,
   * a message or BLR too long) is halved until it does; at one row the
   * statement itself runs. A block that fails while running was undone as
   * one statement, so its rows run again one by one: the failing row then
   * throws exactly the error the row-by-row loop would have thrown.
   */
  private async executeInBlocks(
    single: Statement,
    plan: { build: (rows: number) => string },
    rows: QueryParams[],
  ): Promise<void> {
    let size = Math.min(BLOCK_ROWS, rows.length);
    let current: { rows: number; lease: StatementLease } | undefined;
    try {
      for (let at = 0; at < rows.length; ) {
        const chunk = rows.slice(at, at + size);
        if (chunk.length === 1) {
          await single.execute(this.transaction, await bindParams(single, this.transaction, chunk[0]!));
          at += 1;
          continue;
        }
        if (current?.rows !== chunk.length) {
          await current?.lease.release(false);
          current = undefined;
          try {
            current = {
              rows: chunk.length,
              lease: await this.statements.acquire(this.transaction, plan.build(chunk.length)),
            };
          } catch {
            size = Math.max(1, chunk.length >> 1);
            continue;
          }
        }
        try {
          await current.lease.stmt.execute(this.transaction, await bindParams(current.lease.stmt, this.transaction, chunk.flat()));
        } catch {
          for (const row of chunk) {
            await single.execute(this.transaction, await bindParams(single, this.transaction, row));
          }
        }
        at += chunk.length;
      }
    } finally {
      await current?.lease.release(false);
    }
  }

  /**
   * Execute a SELECT statement inside this transaction and return rows.
   */
  async query(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: ArrayModeOptions,
  ): Promise<QueryResult<ArrayRow>>;
  async query<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode },
  ): Promise<QueryResult<T>>;
  async query<T = Row>(
    sql: string | SqlFragment,
    params: QueryParams = [],
    options: { rowMode?: RowMode } = {},
  ): Promise<QueryResult<T>> {
    this.assertUsable();
    await this.beforeStatement();
    const statement = toStatement(sql, params);
    const serialized = this.serialize(statement.params);
    const rowMode = options.rowMode ?? 'object';

    const lease = await this.statements.acquire(this.transaction, statement.sql);
    const stmt = lease.stmt;
    // Same leak as FirebirdLite.query had: a statement or result set that
    // throws must still be released. More so here, because a transaction
    // callback that catches its own errors goes on using the same attachment.
    let failed = true;
    let fields: FieldInfo[];
    let rawRows: unknown[][];
    try {
      fields = await outputFields(stmt);
      rawRows = await fetchRows(stmt, this.transaction, serialized, fields, this.types);
      failed = false;
    } finally {
      await lease.release(failed);
    }
    return applyTypes({ rows: shapeRows<T>(rawRows, fields, rowMode), fields }, this.types, rowMode);
  }

  /**
   * Stream a SELECT statement inside this transaction in batches of `batchSize` rows.
   */
  queryStream(
    sql: SqlFragment,
    options: { rowMode: 'array'; batchSize?: number },
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream(
    sql: string | SqlFragment,
    params: QueryParams | undefined,
    options: { rowMode: 'array'; batchSize?: number },
  ): AsyncIterableIterator<QueryResult<ArrayRow>>;
  queryStream<T extends Row = Row>(
    sql: SqlFragment,
    options?: { rowMode?: RowMode; batchSize?: number },
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T extends Row = Row>(
    sql: string | SqlFragment,
    params?: QueryParams,
    options?: { rowMode?: RowMode; batchSize?: number },
  ): AsyncIterableIterator<QueryResult<T>>;
  queryStream<T = Row>(
    sql: string | SqlFragment,
    paramsOrOptions: QueryParams | { rowMode?: RowMode; batchSize?: number } = [],
    maybeOptions: { rowMode?: RowMode; batchSize?: number } = {},
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    const { statement, options } = resolveQueryCall<{
      rowMode?: RowMode;
      batchSize?: number;
    }>(sql, paramsOrOptions, maybeOptions);
    const batchSize = resolveBatchSize(options.batchSize);
    return this.streamQuery<T>(
      statement,
      options.rowMode ?? 'object',
      batchSize,
    );
  }

  /**
   * Prepare a SQL statement inside this transaction and return a reusable
   * {@link PreparedStatement} handle.
   */
  async prepare(sql: string | SqlFragment): Promise<PreparedStatement> {
    this.assertUsable();
    await this.beforeStatement();
    const sqlText = toStatement(sql).sql;
    const nativeStmt = await this.attachment.prepare(this.transaction, sqlText);

    let params: FieldInfo[];
    let fields: FieldInfo[];
    let type: number;
    try {
      params = await describeInputFields(nativeStmt);
      fields = await outputFields(nativeStmt);
      type = await nativeStmt.type;
    } catch (err) {
      await nativeStmt.dispose().catch(() => undefined);
      throw err;
    }

    const statementType = statementKind(type);
    const hasResultSet = nativeStmt.hasResultSet;
    let isClosed = false;
    const isTxFinished = () => this.isFinished;

    const assertOpen = (): void => {
      if (isClosed) {
        throw new Error('PreparedStatement has been closed');
      }
      this.assertUsable();
    };

    const checkParamCount = (actual: number): void => {
      if (actual !== params.length) {
        throw new Error(
          `PreparedStatement expects ${params.length} parameter(s) but ${actual} were supplied`,
        );
      }
    };

    const stmt: PreparedStatement = {
      sql: sqlText,
      get params() {
        return params.map((p) => ({ ...p }));
      },
      get fields() {
        return fields.map((f) => ({ ...f }));
      },
      statementType,
      hasResultSet,
      get closed() {
        return isClosed || isTxFinished();
      },
      query: (async <T = Row>(
        paramsOrOptions: QueryParams | QueryOptions = [],
        maybeOptions: QueryOptions = {},
      ): Promise<QueryResult<T>> => {
        assertOpen();
        await this.beforeStatement();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const callOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        checkParamCount(callParams.length);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const rawRows = await fetchRows(
          nativeStmt,
          this.transaction,
          this.serialize(callParams),
          fields,
          this.types,
        );
        const outFields = fields.map((f) => ({ ...f }));
        return applyTypes(
          { rows: shapeRows<T>(rawRows, outFields, rowMode), fields: outFields },
          this.types,
          rowMode,
        );
      }) as PreparedStatement['query'],
      queryStream: (<T = Row>(
        paramsOrOptions: QueryParams | QueryStreamOptions = [],
        maybeOptions: QueryStreamOptions = {},
      ): AsyncIterableIterator<QueryResult<T>> => {
        assertOpen();
        const callParams = Array.isArray(paramsOrOptions)
          ? paramsOrOptions
          : [];
        const callOptions = Array.isArray(paramsOrOptions)
          ? maybeOptions
          : (paramsOrOptions ?? {});
        checkParamCount(callParams.length);
        const batchSize = resolveBatchSize(callOptions.batchSize);
        const rowMode: RowMode = callOptions.rowMode ?? 'object';
        const beforeStmt = () => this.beforeStatement();
        const serializeParams = () => this.serialize(callParams);
        const tx = this.transaction;
        const customTypes = this.types;

        return (async function* (): AsyncIterableIterator<QueryResult<T>> {
          assertOpen();
          await beforeStmt();
          const serializedParams = serializeParams();
          yield* streamRows<T>(
            nativeStmt,
            tx,
            serializedParams,
            fields,
            rowMode,
            batchSize,
            customTypes,
            () => undefined,
          );
        })();
      }) as PreparedStatement['queryStream'],
      exec: async (callParams: QueryParams = []) => {
        assertOpen();
        await this.beforeStatement();
        checkParamCount(callParams.length);
        await nativeStmt.execute(
          this.transaction,
          await bindParams(nativeStmt, this.transaction, this.serialize(callParams)),
        );
        const affectedRows = await readAffectedRecords(nativeStmt);
        return { affectedRows };
      },
      execBatch: async (rows: QueryParams[]) => {
        assertOpen();
        await this.beforeStatement();
        if (!Array.isArray(rows)) {
          throw new TypeError('execBatch takes an array of parameter rows');
        }
        for (const row of rows) {
          checkParamCount(row.length);
        }
        if (rows.length === 0) return { affectedRows: 0 };
        const serializedRows = this.types?.serializers?.length
          ? rows.map((row) => this.serialize(row))
          : rows;
        if (
          serializedRows.length > 1 &&
          (await tryExecuteNativeBatch(nativeStmt, this.transaction, serializedRows))
        ) {
          return { affectedRows: serializedRows.length };
        }
        let total = 0;
        for (const row of serializedRows) {
          await nativeStmt.execute(
            this.transaction,
            await bindParams(nativeStmt, this.transaction, row),
          );
          total += (await readAffectedRecords(nativeStmt)) || 1;
        }
        return { affectedRows: total };
      },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        await nativeStmt.dispose().catch(() => undefined);
      },
      [Symbol.asyncDispose]: async () => {
        await stmt.close();
      },
    };

    return stmt;
  }

  /**
   * Describe a statement's shape inside this transaction without running it.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    this.assertUsable();
    await this.beforeStatement();
    const text = toStatement(sql).sql;

    const stmt = await this.attachment.prepare(this.transaction, text);
    try {
      const params = await describeInputFields(stmt);
      const fields = await outputFields(stmt);
      const type = await stmt.type;

      return {
        params,
        fields,
        statementType: statementKind(type),
        hasResultSet: stmt.hasResultSet,
      };
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
  }

  /**
    * Create a segmented writable BLOB stream (`WritableStream<Uint8Array>`)
   */
  async createBlobStream(
    options: BlobStreamOptions = {},
  ): Promise<BlobWritableStream> {
    this.assertUsable();
    await this.beforeStatement();
    resolveBlobSegmentSize(options.segmentSize, true);

    if (typeof this.attachment.createBlob === 'function') {
      const stream = await this.attachment.createBlob(this.transaction);
      return buildBlobWritableStream(
        {
          writeSegment: async (segment) => {
            this.assertUsable();
            const buf = Buffer.from(
              segment.buffer,
              segment.byteOffset,
              segment.byteLength,
            );
            await stream.write(buf);
          },
          close: async (totalBytes) => {
            this.assertUsable();
            await stream.close();
            const nativeBlob = stream.blob;
            const idBytes =
              nativeBlob?.id instanceof Uint8Array
                ? new Uint8Array(
                    nativeBlob.id.buffer,
                    nativeBlob.id.byteOffset,
                    nativeBlob.id.byteLength,
                  )
                : new Uint8Array(8);
            return createBlobHandle(idBytes, totalBytes, { nativeBlob });
          },
          abort: async () => {
            await stream.cancel().catch(() => undefined);
          },
        },
        options,
      );
    }

    const chunks: Uint8Array[] = [];
    return buildBlobWritableStream(
      {
        writeSegment: async (segment) => {
          this.assertUsable();
          chunks.push(segment.slice());
        },
        close: async (totalBytes) => {
          this.assertUsable();
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

  /**
   * Open a Firebird `BLOB` column (from a `SELECT` query or a {@link BlobHandle})
   * inside this transaction as a segmented Web `ReadableStream<Uint8Array>`
   * backed by `IBlob::getSegment`.
   */
  async openBlobStream(
    handle: BlobHandle,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: SqlFragment,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sql: string | SqlFragment,
    params?: QueryParams | BlobStreamOptions,
    options?: BlobStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  async openBlobStream(
    sqlOrHandle: string | SqlFragment | BlobHandle,
    paramsOrOptions: QueryParams | BlobStreamOptions = [],
    maybeOptions: BlobStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertUsable();
    await this.beforeStatement();

    if (isBlobHandle(sqlOrHandle)) {
      const opts = Array.isArray(paramsOrOptions) ? maybeOptions : paramsOrOptions;
      resolveBlobSegmentSize(opts.segmentSize, false);
      const staged = (sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.stagedBytes;
      if (staged) {
        let offset = 0;
        return buildBlobReadableStream(
          {
            readSegment: async (maxBytes) => {
              this.assertUsable();
              if (offset >= staged.byteLength) return null;
              const end = Math.min(offset + maxBytes, staged.byteLength);
              const slice = staged.slice(offset, end);
              offset = end;
              return slice;
            },
            close: async () => undefined,
          },
          opts,
        );
      }

      const fbBlob =
        ((sqlOrHandle as InternalBlobHandle)[BLOB_INTERNAL_DATA]?.nativeBlob as FbBlob | undefined) ??
        new FbBlob(this.attachment, sqlOrHandle.blobId);
      const stream = await this.attachment.openBlob(this.transaction, fbBlob);
      return buildBlobReadableStream(
        {
          readSegment: async (maxBytes) => {
            this.assertUsable();
            const buf = Buffer.alloc(maxBytes);
            const n = await stream.read(buf);
            if (n < 0) return null;
            return new Uint8Array(buf.buffer, buf.byteOffset, n);
          },
          close: async () => {
            await stream.close().catch(() => undefined);
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

    return openNativeQueryBlobStream(
      this.attachment,
      this.transaction,
      this.statements,
      statement.sql,
      this.serialize(statement.params),
      options,
      false,
      () => this.assertUsable(),
    );
  }

  /**
   * Return Firebird's execution plan for `sql` (`IStatement::getPlan`) inside
   * this transaction without executing the statement.
   */
  async explain(
    sql: string | SqlFragment,
    options: ExplainOptions = {},
  ): Promise<string> {
    this.assertUsable();
    await this.beforeStatement();
    const text = toStatement(sql).sql;
    const detailed = options.detailed === true;

    const stmt = await this.attachment.prepare(this.transaction, text);
    try {
      return await explainStatement(stmt, detailed);
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
  }

  private async *streamQuery<T>(
    statement: ParsedStatement,
    rowMode: RowMode,
    batchSize: number,
  ): AsyncIterableIterator<QueryResult<T>> {
    this.assertUsable();
    await this.beforeStatement();

    const serialized = this.serialize(statement.params);
    let engineFailed = false;
    const lease = await this.statements.acquire(this.transaction, statement.sql);
    const stmt = lease.stmt;

    try {
      let fields: FieldInfo[];
      try {
        fields = await outputFields(stmt);
      } catch (err) {
        engineFailed = true;
        throw err;
      }

      yield* streamRows<T>(
        stmt,
        this.transaction,
        serialized,
        fields,
        rowMode,
        batchSize,
        this.types,
        () => {
          engineFailed = true;
        },
      );
    } finally {
      await lease.release(engineFailed);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Rows per `EXECUTE BLOCK` in `execBatch`: a single-table statement uses
 * one of the engine's 256 contexts per row, so 200 leaves room. */
const BLOCK_ROWS = 200;

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

type NativeStatement = Partial<InputMessage> &
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
      createBatchAsync?: (
        status: unknown,
        inMetadata: NativeMetadata | undefined,
        parLength: number,
        par: unknown,
      ) => Promise<NativeBatch | undefined>;
    };
  };

interface NativeXpbBuilder {
  insertIntSync(status: unknown, tag: number, value: number): void;
  getBufferLengthSync(status: unknown): number;
  getBufferSync(status: unknown): unknown;
  disposeSync(): void;
}

interface NativeBatchCompletionState {
  getSizeSync(status: unknown): number;
  getStateSync(status: unknown, pos: number): number;
  findErrorSync?(status: unknown, pos: number): number;
  getStatusSync(status: unknown, to: unknown, pos: number): void;
  disposeSync(): void;
}

interface NativeBatch {
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
async function explainStatement(stmt: Statement, detailed: boolean): Promise<string> {
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

async function readAffectedRecords(stmt: Statement): Promise<number> {
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
async function describeInputFields(stmt: Statement): Promise<FieldInfo[]> {
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
async function outputFields(stmt: Statement): Promise<FieldInfo[]> {
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
async function inputParams(stmt: Statement): Promise<ParamDescriptor[] | undefined> {
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
const SQL_BLOB = 520;
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
const TEXT_TYPES: ReadonlySet<number> = new Set([
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
async function resolveOutputRows(
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
async function openNativeQueryBlobStream(
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

async function bindParams(stmt: Statement, transaction: Transaction, given: QueryParams): Promise<QueryParams> {
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
async function writeBlob(stmt: Statement, transaction: Transaction, bytes: Buffer): Promise<unknown> {
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

const XPB_BATCH = 5;
const BATCH_VERSION1 = 1;
const BATCH_TAG_RECORD_COUNTS = 2;
const BATCH_TAG_BUFFER_BYTES_SIZE = 3;
const BATCH_TAG_BLOB_POLICY = 4;
const BATCH_BLOB_ID_ENGINE = 1;
const BATCH_EXECUTE_FAILED = -1;

/**
 * Execute `rows` through Firebird 4+'s native `IBatch` interface
 * (`statementHandle.createBatchAsync`, added in
 * `asfernandes/node-firebird-drivers#178`).
 *
 * Returns `true` when the batch ran via `IBatch`, or `false` when the loaded
 * `node-firebird-native-api` build or the connected server (e.g. Firebird 3)
 * does not support `IBatch`, allowing `execBatch` to fall back to
 * `EXECUTE BLOCK`.
 */
async function tryExecuteNativeBatch(
  stmt: Statement,
  transaction: Transaction,
  rows: QueryParams[],
): Promise<boolean> {
  const internal = stmt as unknown as NativeStatement;
  const createBatchAsync = internal.statementHandle?.createBatchAsync;
  const client = internal.attachment?.client;
  const txHandle = (transaction as unknown as { transactionHandle?: unknown }).transactionHandle;
  if (
    typeof createBatchAsync !== 'function' ||
    typeof client?.statusAction !== 'function' ||
    txHandle === undefined
  ) {
    return false;
  }
  if (stmt.hasResultSet || (await outputFields(stmt)).length > 0) {
    return false;
  }
  const described = await inputParams(stmt);
  if (!described || described.length === 0) {
    return false;
  }
  const paramCount = described.length;
  for (const row of rows) {
    if (row.length !== paramCount) return false;
  }

  const textSet = new Set<number>();
  const blobCols: number[] = [];
  for (let i = 0; i < paramCount; i++) {
    const type = (described[i]?.type ?? 0) & ~1;
    if (type === SQL_BLOB) {
      blobCols.push(i);
      continue;
    }
    if (!TEXT_TYPES.has(type)) continue;
    let sawString = false;
    let sawDate = false;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'bigint') {
        sawString = true;
      } else if (v instanceof Date || (typeof v === 'object' && v !== null && 'date' in v)) {
        sawDate = true;
      }
    }
    if (sawString && sawDate) return false;
    if (sawString) textSet.add(i);
  }

  const textPositions = [...textSet].sort((a, b) => a - b);
  if (!(await useMessage(stmt, textPositions))) {
    return false;
  }

  const inMetadata = internal.inMetadata;
  const inBuffer = internal.inBuffer;
  const dataWriter = internal.dataWriter as
    | ((attachment: unknown, transaction: unknown, buffer: Uint8Array, values: unknown[]) => Promise<void>)
    | undefined;
  if (
    !inMetadata ||
    !inBuffer ||
    typeof inMetadata.getAlignedLengthSync !== 'function' ||
    typeof dataWriter !== 'function'
  ) {
    return false;
  }

  const hasBlobs = blobCols.length > 0;
  let totalBlobBytes = 0;
  const normalizedRows: unknown[][] = new Array(rows.length);
  const rowBlobs: (Buffer | null)[][] | undefined = hasBlobs ? new Array(rows.length) : undefined;

  for (let r = 0; r < rows.length; r++) {
    const src = rows[r]!;
    const dst = new Array<unknown>(paramCount);
    const blobsForRow = hasBlobs ? new Array<Buffer | null>(paramCount).fill(null) : undefined;
    for (let i = 0; i < paramCount; i++) {
      let v = src[i];
      if (v === undefined || v === null) {
        dst[i] = null;
        continue;
      }
      if (v instanceof ArrayBuffer) {
        v = Buffer.from(v);
      } else if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
        v = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      } else if (typeof v === 'bigint') {
        v = v.toString();
      }
      if (hasBlobs && (described[i]!.type & ~1) === SQL_BLOB) {
        if (typeof v === 'string') {
          const buf = Buffer.from(v, 'utf8');
          blobsForRow![i] = buf;
          totalBlobBytes += buf.byteLength;
          dst[i] = null;
          continue;
        }
        if (Buffer.isBuffer(v)) {
          blobsForRow![i] = v;
          totalBlobBytes += v.byteLength;
          dst[i] = null;
          continue;
        }
        return false;
      }
      if (textSet.has(i) && typeof v !== 'string') {
        v = String(v);
      }
      dst[i] = v;
    }
    normalizedRows[r] = dst;
    if (rowBlobs && blobsForRow) rowBlobs[r] = blobsForRow;
  }

  return client.statusAction(async (status) => {
    const stride = inMetadata.getAlignedLengthSync!(status);
    const msgLen = inMetadata.getMessageLengthSync(status);
    if (stride <= 0 || msgLen <= 0) return false;

    const blobOffsets = hasBlobs
      ? blobCols.map((col) => ({
          col,
          offset: inMetadata.getOffsetSync(status, col),
          nullOffset: inMetadata.getNullOffsetSync(status, col),
        }))
      : [];

    if (hasBlobs && typeof internal.statementHandle?.createBatchAsync === 'function') {
      // Verify addBlobAsync will be present on the batch below.
    }

    const needed = stride * rows.length + totalBlobBytes + 4096;
    let pb: NativeXpbBuilder | undefined;
    let parLength = 0;
    let parBuffer: unknown;

    try {
      pb = client.util?.getXpbBuilderSync?.(status, XPB_BATCH, undefined, 0);
      if (pb) {
        pb.insertIntSync(status, BATCH_TAG_RECORD_COUNTS, 1);
        if (hasBlobs) {
          pb.insertIntSync(status, BATCH_TAG_BLOB_POLICY, BATCH_BLOB_ID_ENGINE);
        }
        if (needed > 16 * 1024 * 1024) {
          pb.insertIntSync(
            status,
            BATCH_TAG_BUFFER_BYTES_SIZE,
            Math.min(256 * 1024 * 1024, needed),
          );
        }
        parLength = pb.getBufferLengthSync(status);
        parBuffer = pb.getBufferSync(status);
      } else {
        const bytes: number[] = [BATCH_VERSION1, BATCH_TAG_RECORD_COUNTS, 4, 1, 0, 0, 0];
        if (hasBlobs) {
          bytes.push(BATCH_TAG_BLOB_POLICY, 4, BATCH_BLOB_ID_ENGINE, 0, 0, 0);
        }
        const raw = new Uint8Array(bytes);
        parLength = raw.byteLength;
        parBuffer = raw;
      }

      let batch: NativeBatch | undefined;
      try {
        batch = await createBatchAsync.call(
          internal.statementHandle,
          status,
          inMetadata,
          parLength,
          parBuffer,
        );
      } catch {
        // Unsupported by server (e.g. Firebird 3) or client library: fall back to EXECUTE BLOCK.
        return false;
      }
      if (!batch) return false;
      if (hasBlobs && typeof batch.addBlobAsync !== 'function') {
        await batch.closeAsync(status).catch(() => undefined);
        return false;
      }

      try {
        const messages = new Uint8Array(stride * rows.length);
        const blobIdBuf = hasBlobs ? new Uint8Array(8) : undefined;

        for (let r = 0; r < rows.length; r++) {
          inBuffer.fill(0);
          await dataWriter(internal.attachment, transaction, inBuffer, normalizedRows[r]!);
          if (hasBlobs) {
            const blobsForRow = rowBlobs![r]!;
            for (const { col, offset, nullOffset } of blobOffsets) {
              const blobBytes = blobsForRow[col];
              if (!blobBytes) continue;
              blobIdBuf!.fill(0);
              await batch.addBlobAsync!(
                status,
                blobBytes.byteLength,
                blobBytes,
                blobIdBuf!,
                0,
                undefined,
              );
              inBuffer[nullOffset] = 0;
              inBuffer[nullOffset + 1] = 0;
              inBuffer.set(blobIdBuf!, offset);
            }
          }
          messages.set(inBuffer.subarray(0, msgLen), r * stride);
        }

        await batch.addAsync(status, rows.length, messages);
        const completion = await batch.executeAsync(status, txHandle);
        if (!completion) {
          throw new Error('IBatch.executeAsync returned no completion state');
        }
        try {
          const reported = completion.getSizeSync(status);
          for (let i = 0; i < reported; i++) {
            const state = completion.getStateSync(status, i);
            if (state === BATCH_EXECUTE_FAILED) {
              completion.getStatusSync(status, status, i);
              throw new Error(`IBatch execution failed at row ${i}`);
            }
          }
        } finally {
          completion.disposeSync();
        }
      } finally {
        await batch.closeAsync(status).catch(() => undefined);
      }
    } finally {
      pb?.disposeSync();
    }
    return true;
  });
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
async function useMessage(stmt: Statement, positions: number[]): Promise<boolean> {
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

/** Character sets by id, read once per connection. */
const charsetCache = new WeakMap<Attachment, Map<number, CharacterSet>>();

async function characterSets(
  attachment: Attachment,
  transaction: Transaction,
): Promise<Map<number, CharacterSet>> {
  let charsets = charsetCache.get(attachment);
  if (!charsets) {
    const resultSet = await attachment.executeQuery(
      transaction,
      'SELECT RDB$CHARACTER_SET_ID, TRIM(RDB$CHARACTER_SET_NAME), RDB$BYTES_PER_CHARACTER FROM RDB$CHARACTER_SETS',
    );
    try {
      charsets = new Map();
      for (const [id, name, bytes] of (await resultSet.fetch()) as [number, string, number][]) {
        charsets.set(id, { name, bytesPerCharacter: bytes });
      }
    } finally {
      await resultSet.close().catch(() => undefined);
    }
    charsetCache.set(attachment, charsets);
  }
  return charsets;
}

/** Statement types (`isc_info_sql_stmt_*`) the cache keeps: plain DML, SELECT, procedures. */
const CACHEABLE_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 8, 12]);
/** `isc_info_sql_stmt_ddl`. */
const STMT_DDL = 5;

/** A statement handed out by {@link StatementCache.acquire}; release it once, when done. */
interface StatementLease {
  stmt: Statement;
  /** `failed` drops a kept statement, in case it went stale. */
  release(failed: boolean): Promise<void>;
}

interface KeptStatement {
  stmt: Statement;
  busy: boolean;
  /** False once evicted or flushed while busy: disposed on release instead. */
  kept: boolean;
}

/**
 * Prepared statements kept per connection, keyed by their SQL text, the most
 * recently used last: what the WASM bridge does in C (`fb_statement_cache`),
 * for the Node backend, where every prepare is a round trip to the server.
 *
 * A Firebird statement belongs to the attachment, not to the transaction it
 * was prepared in, so a kept one runs in whichever transaction comes next.
 * Only SELECT, INSERT, UPDATE, DELETE and EXECUTE PROCEDURE / BLOCK are kept.
 * DDL is never kept, and empties the cache before it runs: a kept statement
 * makes this connection's `DROP TABLE` fail with "object in use", and keeps
 * running a procedure's old body after it is altered. A statement whose
 * execution fails is dropped. One busy with a call still running is not
 * handed to a second, concurrent call, which prepares its own.
 *
 * Size 0, the default, keeps nothing: each statement is prepared and disposed
 * as before, and its type is never asked for.
 */
class StatementCache {
  private readonly kept = new Map<string, KeptStatement>();

  constructor(
    private readonly attachment: Attachment,
    private readonly size: number,
  ) {}

  get enabled(): boolean {
    return this.size > 0;
  }

  async acquire(transaction: Transaction, sql: string): Promise<StatementLease> {
    const hit = this.kept.get(sql);
    if (hit && !hit.busy) {
      // Most recently used last: a Map iterates in insertion order.
      this.kept.delete(sql);
      this.kept.set(sql, hit);
      hit.busy = true;
      return this.lease(hit);
    }

    const stmt = await this.attachment.prepare(transaction, sql);
    if (!this.enabled) {
      return { stmt, release: () => stmt.dispose().catch(() => undefined) };
    }

    const type = await stmt.type;
    if (type === STMT_DDL) await this.flush();

    const entry: KeptStatement = { stmt, busy: true, kept: false };
    if (!hit && CACHEABLE_TYPES.has(type)) {
      entry.kept = true;
      this.kept.set(sql, entry);
      await this.evictBeyondSize();
    }
    return this.lease(entry);
  }

  /** Dispose every kept statement; those still busy go when released. */
  async flush(): Promise<void> {
    const entries = [...this.kept.values()];
    this.kept.clear();
    for (const entry of entries) {
      entry.kept = false;
      if (!entry.busy) await entry.stmt.dispose().catch(() => undefined);
    }
  }

  private lease(entry: KeptStatement): StatementLease {
    return {
      stmt: entry.stmt,
      release: async (failed: boolean) => {
        entry.busy = false;
        if (entry.kept && failed) {
          entry.kept = false;
          for (const [sql, e] of this.kept) {
            if (e === entry) {
              this.kept.delete(sql);
              break;
            }
          }
        }
        if (!entry.kept) await entry.stmt.dispose().catch(() => undefined);
      },
    };
  }

  private async evictBeyondSize(): Promise<void> {
    for (const [sql, entry] of this.kept) {
      if (this.kept.size <= this.size) return;
      if (entry.busy) continue;
      this.kept.delete(sql);
      entry.kept = false;
      await entry.stmt.dispose().catch(() => undefined);
    }
  }
}

/**
 * Run a prepared statement and return its rows, positionally.
 *
 * A SELECT has a cursor and is fetched. `EXECUTE PROCEDURE` has output
 * columns but no cursor: it runs once, and its outputs are one row — run as
 * a plain execute, they were dropped (`query()` returned no rows), and
 * `executeQuery` refused it outright inside a transaction. Anything else
 * runs and returns nothing.
 */
async function fetchRows(
  stmt: Statement,
  transaction: Transaction,
  params: QueryParams,
  fields: FieldInfo[],
  types?: TypeOptions,
): Promise<unknown[][]> {
  params = await bindParams(stmt, transaction, params);
  let rawRows: unknown[][];
  if (stmt.hasResultSet) {
    const resultSet = await stmt.executeQuery(transaction, params);
    // A failing fetch must still close.
    try {
      rawRows = await resultSet.fetch();
    } finally {
      await resultSet.close().catch(() => undefined);
    }
  } else if (fields.length > 0) {
    rawRows = [await stmt.executeSingleton(transaction, params)];
  } else {
    await stmt.execute(transaction, params);
    return [];
  }
  await resolveOutputRows(stmt, transaction, fields, rawRows, types);
  return rawRows;
}

/**
 * Stream a prepared statement's result set in batches of up to `batchSize` rows.
 */
async function* streamRows<T>(
  stmt: Statement,
  transaction: Transaction,
  params: QueryParams,
  fields: FieldInfo[],
  rowMode: RowMode,
  batchSize: number,
  types: TypeOptions | undefined,
  onEngineError: () => void,
): AsyncIterableIterator<QueryResult<T>> {
  let boundParams: QueryParams;
  try {
    boundParams = await bindParams(stmt, transaction, params);
  } catch (err) {
    onEngineError();
    throw err;
  }

  if (stmt.hasResultSet) {
    let resultSet;
    try {
      resultSet = await stmt.executeQuery(transaction, boundParams);
    } catch (err) {
      onEngineError();
      throw err;
    }
    try {
      while (true) {
        let rawRows: unknown[][];
        try {
          rawRows = await resultSet.fetch({ fetchSize: batchSize });
          await resolveOutputRows(stmt, transaction, fields, rawRows, types);
        } catch (err) {
          onEngineError();
          throw err;
        }
        if (rawRows.length === 0) break;
        const batchFields = fields.map((f) => ({ ...f }));
        yield applyTypes(
          {
            rows: shapeRows<T>(rawRows, batchFields, rowMode),
            fields: batchFields,
          },
          types,
          rowMode,
        );
      }
    } finally {
      await resultSet.close().catch(() => undefined);
    }
    return;
  }

  if (fields.length > 0) {
    let rawRows: unknown[][];
    try {
      rawRows = [await stmt.executeSingleton(transaction, boundParams)];
      await resolveOutputRows(stmt, transaction, fields, rawRows, types);
    } catch (err) {
      onEngineError();
      throw err;
    }
    const batchFields = fields.map((f) => ({ ...f }));
    yield applyTypes(
      {
        rows: shapeRows<T>(rawRows, batchFields, rowMode),
        fields: batchFields,
      },
      types,
      rowMode,
    );
    return;
  }

  try {
    await stmt.execute(transaction, boundParams);
  } catch (err) {
    onEngineError();
    throw err;
  }
}

/**
 * The driver hands back positional rows, so array mode is the shape that
 * costs nothing — object mode is the one that builds.
 */
function shapeRows<T>(rawRows: unknown[][], fields: FieldInfo[], rowMode: RowMode): T[] {
  return (
    rowMode === 'array'
      ? rawRows
      : rawRows.map((cols) => Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])))
  ) as T[];
}

function buildTransactionOptions(
  options: TransactionOptions,
): NativeTransactionOptions {
  const isolationMap: Record<
    NonNullable<TransactionOptions['isolationLevel']>,
    TransactionIsolation
  > = {
    READ_COMMITTED: TransactionIsolation.READ_COMMITTED,
    SNAPSHOT: TransactionIsolation.SNAPSHOT,
    SNAPSHOT_TABLE_STABILITY: TransactionIsolation.CONSISTENCY,
  };

  return {
    isolation: options.isolationLevel
      ? isolationMap[options.isolationLevel]
      : undefined,
    accessMode: options.readOnly ? 'READ_ONLY' : undefined,
  };
}
