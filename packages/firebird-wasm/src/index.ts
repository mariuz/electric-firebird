/**
 * firebird-wasm – Firebird Embedded for Node.js / TypeScript
 *
 * Provides a PGlite-style async API backed by the Firebird embedded engine.
 *
 * @example
 * ```ts
 * import { FirebirdLite } from 'firebird-wasm';
 *
 * const db = new FirebirdLite('/tmp/my-app.fdb');
 * await db.exec('CREATE TABLE items (id INTEGER, name VARCHAR(100))');
 * await db.exec('INSERT INTO items VALUES (1, \'hello\')');
 * const result = await db.query('SELECT * FROM items');
 * console.log(result.rows); // [{ ID: 1, NAME: 'hello' }]
 * await db.close();
 * ```
 */

export { FirebirdLite, FirebirdTransaction } from './firebird';
export type {
  FirebirdLiteOptions,
  QueryResult,
  QueryParams,
  Row,
  FieldInfo,
  TransactionOptions,
  IsolationLevel,
} from './types';
