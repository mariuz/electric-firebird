/**
 * worker-protocol.ts – the messages exchanged with the engine Worker.
 *
 * Shared by both ends so the request and response shapes cannot drift apart.
 * Every request carries an `id`; the reply quotes it, which is what lets
 * several calls be in flight at once.
 */

import type { Row, QueryResult } from '../types';
import type { EngineHandle } from './engine-transport';

/** Operations the Worker understands.  One per EngineTransport method. */
export type EngineOp =
  | 'init'
  | 'createDatabase'
  | 'attachDatabase'
  | 'detachDatabase'
  | 'execute'
  | 'query'
  | 'describe'
  | 'startTransaction'
  | 'commit'
  | 'rollback'
  | 'mkdir'
  | 'exists'
  | 'readFile'
  | 'writeFile'
  | 'unlink'
  | 'mountOpfs';

/** A call from the main thread to the Worker. */
export interface EngineRequest {
  id: number;
  op: EngineOp;
  args: unknown[];
}

/** The Worker's reply.  Exactly one of `result` / `error` is meaningful. */
export interface EngineResponse {
  id: number;
  ok: boolean;
  /** Present when `ok`. */
  result?: EngineHandle | number | boolean | Uint8Array | QueryResult<Row> | null;
  /**
   * Present when not `ok`.  A string rather than an Error because structured
   * cloning drops the prototype and the stack is the Worker's, not the
   * caller's — the message is the part worth keeping.
   */
  error?: string;
}

/** Sent once when the Worker's own bootstrap fails, without a request to quote. */
export interface EngineFatal {
  id: -1;
  ok: false;
  error: string;
}
