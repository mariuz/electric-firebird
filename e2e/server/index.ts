/**
 * Minimal HTTP demo server that exposes a FirebirdLite database
 * over a REST-like API.  Used exclusively for Playwright e2e tests.
 *
 * Routes:
 *   POST /query  { sql, params? }  →  QueryResult
 *   POST /exec   { sql }           →  { ok: true }
 *   GET  /health                   →  { status: 'ok' }
 */

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FirebirdLite } from 'firebird-wasm';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_HOST = process.env['FIREBIRD_HOST'] ?? 'localhost';
const DB_USER = process.env['FIREBIRD_USER'] ?? 'SYSDBA';
const DB_PASS = process.env['FIREBIRD_PASSWORD'] ?? '';
const DB_FILE = path.join(
  os.tmpdir(),
  `firebird-e2e-demo-${Date.now()}.fdb`,
);
const DB_URI = `${DB_HOST}:${DB_FILE}`;

const db = new FirebirdLite(DB_URI, { username: DB_USER, password: DB_PASS });

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/exec') {
      const body = JSON.parse(await readBody(req)) as { sql: string };
      await db.exec(body.sql);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/query') {
      const body = JSON.parse(await readBody(req)) as {
        sql: string;
        params?: unknown[];
      };
      const result = await db.query(body.sql, body.params ?? []);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Demo server listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_URI}`);
});

process.on('SIGTERM', async () => {
  server.close();
  await db.close();
  if (fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
  }
  process.exit(0);
});
