import {
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
  QueryResult,
  QueryOptions,
  Row,
  QueryParams,
  RowMode,
  TransactionOptions,
  FieldInfo,
} from './types';
import { statementKind } from './statement-types';
import { toStatement, resolveQueryCall } from './sql-tag';
import type { SqlFragment } from './sql-tag';

type NativeDriver = typeof import('node-firebird-driver-native');

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

  constructor(dbPath: string, options: FirebirdLiteOptions = {}) {
    this.dbPath = dbPath;
    this.libraryPath = options.libraryPath;
    this.connectOptions = {
      username: options.username,
      password: options.password,
      charSetForNONE: options.charset,
    };
    this.sharedReads = options.sharedReads ?? false;
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
   * (upper-cased) column name, mirroring the PGlite convention.
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

    const txOptions = buildTransactionOptions(options);
    const transaction = await attachment.startTransaction(txOptions);

    try {
      const stmt = await attachment.prepare(transaction, statement.sql);

      let rows: T[];
      let fields: FieldInfo[];
      // Disposed in `finally`, not after the fetch: a statement that throws on
      // execute — a lock conflict, an overflow, a wrong parameter count — would
      // otherwise leak its handle, and the retry loop such failures are usually
      // wrapped in leaks one per attempt until the attachment refuses more.
      try {
        const columnLabels = await stmt.columnLabels;
        fields = columnLabels.map((label) => ({ name: label.toUpperCase() }));

        rows = shapeRows<T>(
          await fetchRows(stmt, transaction, statement.params, fields.length),
          fields,
          rowMode,
        );
      } finally {
        await stmt.dispose().catch(() => undefined);
      }

      // After the statement is disposed, as before — the commit is the last
      // thing that happens on the success path.
      await transaction.commit();
      return { rows, fields };
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
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
    const attachment = this.attachment!;
    this.readTransaction ??= await attachment.startTransaction({
      isolation: TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      accessMode: 'READ_ONLY',
    });
    const transaction = this.readTransaction;

    let stmt;
    try {
      stmt = await attachment.prepare(transaction, sql);
    } catch (err) {
      await this.endReadTransaction();
      throw err;
    }
    try {
      if ((await stmt.type) !== STMT_SELECT) {
        this.remember(sql);
        return undefined;
      }
      const fields: FieldInfo[] = (await stmt.columnLabels).map((label) => ({
        name: label.toUpperCase(),
      }));
      const rawRows = await fetchRows(stmt, transaction, params, fields.length);
      return { rows: shapeRows<T>(rawRows, fields, rowMode), fields };
    } catch (err) {
      // The native driver's errors carry only the message text.
      if (/attempted update during read-only transaction/.test(String((err as Error)?.message))) {
        this.remember(sql);
        return undefined;
      }
      await this.endReadTransaction();
      throw err;
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
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
   * // shape.fields        → [{ name: 'ID' }, { name: 'NAME' }]
   * // shape.statementType → 'SELECT'
   * ```
   *
   * The statement is prepared and disposed, so nothing runs: describing an
   * `INSERT` inserts nothing.
   *
   * **`params` is `undefined` here.** The native driver exposes no input
   * metadata — `Statement` offers `columnLabels`, `hasResultSet` and `type`
   * and nothing about `?` placeholders — and an empty array would claim the
   * statement takes none. `fields` carries names only, for the same reason
   * `FieldInfo` does everywhere on this backend. The WASM backend reports both
   * in full.
   */
  async describeQuery(sql: string | SqlFragment): Promise<QueryDescription> {
    await this.ensureReady();
    const attachment = this.attachment!;
    const text = toStatement(sql).sql;

    const transaction = await attachment.startTransaction();
    try {
      const stmt = await attachment.prepare(transaction, text);
      try {
        const columnLabels = await stmt.columnLabels;
        const type = await stmt.type;

        return {
          params: undefined,
          fields: columnLabels.map((label) => ({ name: label.toUpperCase() })),
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
    const tx = new FirebirdTransaction(attachment, transaction, () => this.endReadTransaction());

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

    await this.endReadTransaction();
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
    private readonly beforeStatement: () => Promise<void> = async () => undefined,
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
  async exec(sql: string | SqlFragment, params: QueryParams = []): Promise<void> {
    this.assertUsable();
    await this.beforeStatement();
    const statement = toStatement(sql, params);
    if (statement.params.length > 0) {
      const stmt = await this.attachment.prepare(this.transaction, statement.sql);
      try {
        await stmt.execute(this.transaction, statement.params);
      } finally {
        await stmt.dispose().catch(() => undefined);
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
    const stmt = await this.attachment.prepare(this.transaction, sql);
    try {
      for (const row of rows) {
        await stmt.execute(this.transaction, row);
      }
    } finally {
      await stmt.dispose().catch(() => undefined);
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
    const rowMode = options.rowMode ?? 'object';

    const stmt = await this.attachment.prepare(this.transaction, statement.sql);
    // Same leak as FirebirdLite.query had: a statement or result set that
    // throws must still be released. More so here, because a transaction
    // callback that catches its own errors goes on using the same attachment.
    try {
      const columnLabels = await stmt.columnLabels;
      const fields: FieldInfo[] = columnLabels.map((label) => ({
        name: label.toUpperCase(),
      }));

      const rawRows = await fetchRows(stmt, this.transaction, statement.params, fields.length);
      return { rows: shapeRows<T>(rawRows, fields, rowMode), fields };
    } finally {
      await stmt.dispose().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

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
  columnCount: number,
): Promise<unknown[][]> {
  if (stmt.hasResultSet) {
    const resultSet = await stmt.executeQuery(transaction, params);
    // A failing fetch must still close.
    try {
      return await resultSet.fetch();
    } finally {
      await resultSet.close().catch(() => undefined);
    }
  }
  if (columnCount > 0) {
    return [await stmt.executeSingleton(transaction, params)];
  }
  await stmt.execute(transaction, params);
  return [];
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
