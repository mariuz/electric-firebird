import {
  createNativeClient,
  getDefaultLibraryFilename,
} from 'node-firebird-driver-native';
import {
  TransactionIsolation,
} from 'node-firebird-driver';
import type {
  Client,
  Attachment,
  Transaction,
  TransactionOptions as NativeTransactionOptions,
} from 'node-firebird-driver';
import type {
  FirebirdLiteOptions,
  QueryResult,
  Row,
  QueryParams,
  TransactionOptions,
  FieldInfo,
} from './types';

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
  private readonly libraryPath: string;
  private readonly connectOptions: { username?: string; password?: string; charSetForNONE?: string };
  private client: Client | null = null;
  private attachment: Attachment | null = null;
  private closed = false;

  constructor(dbPath: string, options: FirebirdLiteOptions = {}) {
    this.dbPath = dbPath;
    this.libraryPath = options.libraryPath ?? getDefaultLibraryFilename();
    this.connectOptions = {
      username: options.username,
      password: options.password,
      charSetForNONE: options.charset,
    };
  }

  /**
   * Lazily initialize the native client and open (or create) the database.
   */
  private async ensureReady(): Promise<void> {
    if (this.attachment) return;
    if (this.closed) {
      throw new Error('FirebirdLite instance has been closed');
    }

    this.client = createNativeClient(this.libraryPath);

    try {
      this.attachment = await this.client.connect(this.dbPath, this.connectOptions);
    } catch {
      // Database does not exist yet – create it.
      this.attachment = await this.client.createDatabase(this.dbPath, this.connectOptions);
    }
  }

  /**
   * Execute a DDL or DML statement that does not return rows.
   *
   * The statement is executed in its own auto-committed transaction.
   */
  async exec(sql: string): Promise<void> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const transaction = await attachment.startTransaction();
    try {
      await attachment.execute(transaction, sql);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Execute a (parameterised) SQL statement and return the result rows.
   *
   * For SELECT queries the rows are returned as plain objects keyed by the
   * (upper-cased) column name, mirroring the PGlite convention.
   */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
    options: TransactionOptions = {},
  ): Promise<QueryResult<T>> {
    await this.ensureReady();
    const attachment = this.attachment!;

    const txOptions = buildTransactionOptions(options);
    const transaction = await attachment.startTransaction(txOptions);

    try {
      const stmt = await attachment.prepare(transaction, sql);
      const columnLabels = await stmt.columnLabels;
      const fields: FieldInfo[] = columnLabels.map((label) => ({
        name: label.toUpperCase(),
      }));

      let rows: T[];
      if (stmt.hasResultSet) {
        const resultSet = await stmt.executeQuery(transaction, params);
        const rawRows = await resultSet.fetch();
        await resultSet.close();
        rows = rawRows.map((cols) =>
          Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])),
        ) as T[];
      } else {
        await stmt.execute(transaction, params);
        rows = [];
      }

      await stmt.dispose();
      await transaction.commit();

      return { rows, fields };
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
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
    const transaction = await attachment.startTransaction(txOptions);

    const tx = new FirebirdTransaction(attachment, transaction);

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

    await transaction.commit();
    return result;
  }

  /**
   * Close the database connection and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

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

/**
 * A handle to an active Firebird transaction, exposed to callers of
 * `FirebirdLite.transaction()`.
 */
export class FirebirdTransaction {
  private finished = false;

  constructor(
    private readonly attachment: Attachment,
    private readonly transaction: Transaction,
  ) {}

  /** Whether this transaction has already been rolled back. */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Roll this transaction back and stop.
   *
   * The enclosing `transaction()` will not commit afterwards.  Use this to
   * abandon a transaction deliberately, rather than throwing an error you do
   * not mean — throwing also rolls back, but it propagates to the caller.
   */
  async rollback(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.transaction.rollback();
  }

  private assertUsable(): void {
    if (this.finished) {
      throw new Error('Transaction has already been rolled back');
    }
  }

  /**
   * Execute a DDL or DML statement inside this transaction.
   */
  async exec(sql: string, params: QueryParams = []): Promise<void> {
    this.assertUsable();
    if (params.length > 0) {
      const stmt = await this.attachment.prepare(this.transaction, sql);
      try {
        await stmt.execute(this.transaction, params);
      } finally {
        await stmt.dispose().catch(() => undefined);
      }
    } else {
      await this.attachment.execute(this.transaction, sql);
    }
  }

  /**
   * Execute a SELECT statement inside this transaction and return rows.
   */
  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
  ): Promise<QueryResult<T>> {
    this.assertUsable();

    const stmt = await this.attachment.prepare(this.transaction, sql);
    const columnLabels = await stmt.columnLabels;
    const fields: FieldInfo[] = columnLabels.map((label) => ({
      name: label.toUpperCase(),
    }));

    const resultSet = await stmt.executeQuery(this.transaction, params);
    const rawRows = await resultSet.fetch();
    await resultSet.close();
    await stmt.dispose();

    const rows = rawRows.map((cols) =>
      Object.fromEntries(fields.map((f, i) => [f.name, cols[i]])),
    ) as T[];

    return { rows, fields };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

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
