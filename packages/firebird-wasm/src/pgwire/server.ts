/**
 * pgwire/server.ts – Node TCP & WebSocket PostgreSQL v3 Wire Protocol Server
 * (`createPgWireServer`) (`M32 Item 3`).
 */

import * as net from 'node:net';
import {
  createPgWireSession,
  type PgWireDatabase,
  type PgWireSessionOptions,
} from './protocol';

export interface PgWireWebSocketLike {
  send(data: Uint8Array): void;
  close(): void;
  addEventListener?(
    type: 'message' | 'close',
    listener: (ev: { data?: unknown }) => void,
  ): void;
  on?(event: 'message' | 'close', listener: (data?: unknown) => void): void;
}

export interface CreatePgWireServerOptions extends PgWireSessionOptions {
  /** TCP bind port (`0` selects an ephemeral OS port). @default 5432 */
  readonly port?: number;
  /** TCP bind host. @default '127.0.0.1' */
  readonly host?: string;
}

export interface PgWireServerHandle {
  readonly host: string;
  readonly port: number;
  readonly activeConnections: number;
  /** Attach a binary WebSocket client speaking `pgwire` v3 frames. */
  attachWebSocket(ws: PgWireWebSocketLike): void;
  close(): Promise<void>;
}

/**
 * Start a PostgreSQL v3 wire protocol TCP server backed by `FirebirdDatabase` (`M32 Item 3`).
 */
export async function createPgWireServer(
  db: PgWireDatabase,
  options: CreatePgWireServerOptions = {},
): Promise<PgWireServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 5432;
  const sockets = new Set<net.Socket>();
  let pidSeq = options.backendPid ?? 5000;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const session = createPgWireSession(db, {
      ...options,
      backendPid: ++pidSeq,
    });

    let queue = Promise.resolve();
    socket.on('data', (buf: Buffer) => {
      const chunk = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      queue = queue
        .then(async () => {
          const { response, closed } = await session.feed(chunk);
          if (response.byteLength > 0 && !socket.destroyed) {
            socket.write(Buffer.from(response.buffer, response.byteOffset, response.byteLength));
          }
          if (closed && !socket.destroyed) {
            socket.end();
          }
        })
        .catch(() => {
          if (!socket.destroyed) socket.destroy();
        });
    });

    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  return {
    host,
    port: boundPort,
    get activeConnections() {
      return sockets.size;
    },
    attachWebSocket(ws: PgWireWebSocketLike): void {
      const session = createPgWireSession(db, {
        ...options,
        backendPid: ++pidSeq,
      });
      let queue = Promise.resolve();
      const onMsg = (raw: unknown) => {
        const payload =
          raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw;
        const bytes =
          payload instanceof Uint8Array
            ? payload
            : payload instanceof ArrayBuffer
              ? new Uint8Array(payload)
              : Buffer.isBuffer(payload)
                ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
                : null;
        if (!bytes) return;
        queue = queue.then(async () => {
          const { response, closed } = await session.feed(bytes);
          if (response.byteLength > 0) ws.send(response);
          if (closed) ws.close();
        });
      };
      if (typeof ws.on === 'function') ws.on('message', onMsg);
      else if (typeof ws.addEventListener === 'function') ws.addEventListener('message', onMsg);
    },
    async close(): Promise<void> {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
