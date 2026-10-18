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
import { blockParamType, buildBlock, placeholderOffsets } from './batch-block';
import type { CharacterSet, ParamDescriptor } from './batch-block';
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
  private readonly statementCacheSize: number;
  /** Statements kept prepared by their SQL text, once connected (`statementCache`). */
  private statements: StatementCache | null = null;

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

    const txOptions = buildTransactionOptions(options);
    const transaction = await attachment.startTransaction(txOptions);

    try {
      const lease = await this.statements!.acquire(transaction, statement.sql);
      const stmt = lease.stmt;

      let rows: T[];
      let fields: FieldInfo[];
      // Released in `finally`, not after the fetch: a statement that throws on
      // execute — a lock conflict, an overflow, a wrong parameter count — would
      // otherwise leak its handle, and the retry loop such failures are usually
      // wrapped in leaks one per attempt until the attachment refuses more.
      let failed = true;
      try {
        const columnLabels = await stmt.columnLabels;
        fields = columnLabels.map((label) => ({ name: label }));

        rows = shapeRows<T>(
          await fetchRows(stmt, transaction, statement.params, fields.length),
          fields,
          rowMode,
        );
        failed = false;
      } finally {
        await lease.release(failed);
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
    try {
      if ((await stmt.type) !== STMT_SELECT) {
        this.remember(sql);
        return undefined;
      }
      const fields: FieldInfo[] = (await stmt.columnLabels).map((label) => ({
        name: label,
      }));
      const rawRows = await fetchRows(stmt, transaction, params, fields.length);
      return { rows: shapeRows<T>(rawRows, fields, rowMode), fields };
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
          fields: columnLabels.map((label) => ({ name: label })),
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
    const tx = new FirebirdTransaction(
      attachment,
      transaction,
      () => this.endReadTransaction(),
      this.statements ?? undefined,
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
    private readonly statements: StatementCache = new StatementCache(attachment, 0),
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
    // With the cache off, a statement without parameters runs as it always
    // did. With it on, every statement goes through the cache, which is also
    // what sees DDL coming and empties itself first.
    if (statement.params.length > 0 || this.statements.enabled) {
      const lease = await this.statements.acquire(this.transaction, statement.sql);
      let failed = true;
      try {
        await lease.stmt.execute(this.transaction, await bindParams(lease.stmt, this.transaction, statement.params));
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
    const lease = await this.statements.acquire(this.transaction, sql);
    let failed = true;
    try {
      const plan = rows.length > 1 ? await this.blockPlan(sql, lease.stmt) : undefined;
      if (plan) {
        await this.executeInBlocks(lease.stmt, plan, rows);
      } else {
        for (const row of rows) {
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
    if ((await stmt.columnLabels).length > 0) return undefined;

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
    const rowMode = options.rowMode ?? 'object';

    const lease = await this.statements.acquire(this.transaction, statement.sql);
    const stmt = lease.stmt;
    // Same leak as FirebirdLite.query had: a statement or result set that
    // throws must still be released. More so here, because a transaction
    // callback that catches its own errors goes on using the same attachment.
    let failed = true;
    try {
      const columnLabels = await stmt.columnLabels;
      const fields: FieldInfo[] = columnLabels.map((label) => ({
        name: label,
      }));

      const rawRows = await fetchRows(stmt, this.transaction, statement.params, fields.length);
      failed = false;
      return { rows: shapeRows<T>(rawRows, fields, rowMode), fields };
    } finally {
      await lease.release(failed);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Rows per `EXECUTE BLOCK` in `execBatch`: a single-table statement uses
 * one of the engine's 256 contexts per row, so 200 leaves room. */
const BLOCK_ROWS = 200;

// The driver's statement internals this file reads and, for text, rewrites.
// Not public API: each use checks they are there and falls back to the
// driver's own behaviour when they are not.

interface NativeMetadata {
  getCountSync(status: unknown): number;
  getTypeSync(status: unknown, i: number): number;
  getSubTypeSync(status: unknown, i: number): number;
  getLengthSync(status: unknown, i: number): number;
  getScaleSync(status: unknown, i: number): number;
  getCharSetSync(status: unknown, i: number): number;
  getMessageLengthSync(status: unknown): number;
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

type NativeStatement = Partial<InputMessage> & {
  attachment?: Attachment & {
    client?: { statusAction?: <T>(fn: (status: unknown) => Promise<T>) => Promise<T> };
  };
  internalDispose?: () => Promise<void>;
  statementHandle?: { getInputMetadataAsync?: (status: unknown) => Promise<NativeMetadata | undefined> };
};

/** A statement's parameters as prepared, and the input messages made for text. */
interface Binding {
  params: ParamDescriptor[] | undefined;
  /** The driver's own message, kept while another is in place. */
  original?: InputMessage;
  /** Messages by the positions they take as text: `"1,3"`. */
  variants: Map<string, InputMessage>;
  /** The positions of the message in place; `''` is the driver's own. */
  current: string;
}

const bindings = new WeakMap<Statement, Binding>();

async function bindingOf(stmt: Statement): Promise<Binding> {
  let binding = bindings.get(stmt);
  if (!binding) {
    // Read before anything here rewrites the message; a statement is used
    // by one call at a time, so nothing else reads it meanwhile.
    binding = { params: await readInputParams(stmt), variants: new Map(), current: '' };
    bindings.set(stmt, binding);
  }
  return binding;
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

/** `SQL_BLOB`, without the nullable bit. */
const SQL_BLOB = 520;
/** `SQL_DOUBLE`: what the driver binds every integer and NUMERIC as. */
const SQL_DOUBLE = 480;
/** SMALLINT, INTEGER, BIGINT, and NUMERIC / DECIMAL kept in them. */
const INTEGER_TYPES: ReadonlySet<number> = new Set([500, 496, 580]);
/** `SQL_VARYING`. */
const SQL_VARYING = 448;
/** Character set id of UTF8. */
const CS_UTF8 = 4;
/**
 * DATE, TIME, TIMESTAMP, and TIME / TIMESTAMP WITH TIME ZONE in both forms
 * (the driver rewrites the zoned ones to their `_EX` forms).
 */
const DATE_TIME_TYPES: ReadonlySet<number> = new Set([570, 560, 510, 32756, 32754, 32750, 32748]);
/** The types a string is sent to as text, for Firebird to convert. */
const TEXT_TYPES: ReadonlySet<number> = new Set([...DATE_TIME_TYPES, ...INTEGER_TYPES]);
/** Bytes a value takes as text: a timestamp with the longest zone name fits twice. */
const TEXT_LENGTH = 128;

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
 * So does a string bound to a SMALLINT, INTEGER, BIGINT or NUMERIC parameter:
 * the driver binds those as doubles, and `'9007199254740993'` arrived as
 * 9007199254740992, `'0.1'` in a NUMERIC(18,17) as 0.10000000000000001.
 * A JS number still goes as a double (it is one); a string to a DOUBLE
 * PRECISION or FLOAT parameter is still converted by JS, which rounds
 * correctly.
 */
async function bindParams(stmt: Statement, transaction: Transaction, given: QueryParams): Promise<QueryParams> {
  // Bytes as the driver takes them: a Buffer (the browser engine takes a
  // Uint8Array or an ArrayBuffer, so the same call works on both).
  const params = given.some((p) => p instanceof Uint8Array || p instanceof ArrayBuffer)
    ? given.map((p) => p instanceof ArrayBuffer
      ? Buffer.from(p)
      : p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p)
    : given;
  const binding = bindings.get(stmt);
  if (!params.some((p) => typeof p === 'string' || Buffer.isBuffer(p)) && (!binding || binding.current === '')) {
    return params;
  }
  const described = (binding ?? (await bindingOf(stmt))).params;
  if (!described) return params;

  const text: number[] = [];
  const bound: unknown[] = [...params];
  for (let i = 0; i < bound.length; i++) {
    const p = bound[i];
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
      releaseMessagesOnDispose(internal, binding);
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
 * Hand the driver back its own message when the statement is disposed, for
 * it to release as it always does, and release the ones made here.
 */
function releaseMessagesOnDispose(internal: NativeStatement, binding: Binding): void {
  const dispose = internal.internalDispose;
  if (typeof dispose !== 'function') return;
  internal.internalDispose = async function (this: NativeStatement) {
    if (binding.original) {
      internal.inMetadata = binding.original.inMetadata;
      internal.inBuffer = binding.original.inBuffer;
      internal.dataWriter = binding.original.dataWriter;
    }
    for (const message of binding.variants.values()) message.inMetadata.releaseSync();
    binding.variants.clear();
    binding.current = '';
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
  columnCount: number,
): Promise<unknown[][]> {
  params = await bindParams(stmt, transaction, params);
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
