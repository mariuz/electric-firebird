/**
 * cli-mcp-backup-commands.ts – CLI Subcommands for Model Context Protocol
 * (`mcp`) and Authenticated Encrypted `.fbkp` Backups (`backup`, `verify-backup`)
 * (`M27 Items 1 & 4`).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as readline from 'readline';
import type { FirebirdDatabase } from './database-core';
import type { CliIo } from './cli';
import { createFirebirdMcpServer } from './mcp-server';
import {
  createEncryptedBackup,
  restoreEncryptedBackup,
  verifyBackupArchive,
} from './encrypted-backup';

export interface CliMcpBackupContext {
  positional: readonly string[];
  flags: Map<string, string | boolean>;
  cwd: string;
  backend?: 'auto' | 'wasm' | 'native';
  io: CliIo;
  out: (text: string) => void;
  err: (text: string) => void;
  openCliDatabase: (
    uri: string,
    opts: { cwd: string; backend?: 'auto' | 'wasm' | 'native'; allowMissing?: boolean },
  ) => Promise<{
    readonly db: FirebirdDatabase;
    flushAndClose(persistChanges: boolean): Promise<void>;
  }>;
}

export async function runCliMcp(ctx: CliMcpBackupContext): Promise<number> {
  const { positional, flags, cwd, backend, io, out, err, openCliDatabase } = ctx;
  const uri = positional[1] ?? 'memory://mcp';
  const allowWrites = flags.get('allow-writes') === true;
  const audit = flags.get('audit') === true;
  const apiKey = typeof flags.get('api-key') === 'string' ? String(flags.get('api-key')) : undefined;
  const portRaw = flags.get('port');
  const port = typeof portRaw === 'string' ? Number(portRaw) : undefined;
  const host = typeof flags.get('host') === 'string' ? String(flags.get('host')) : '127.0.0.1';

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: true });
  const mcp = createFirebirdMcpServer(managed.db, {
    allowWrites,
    audit,
    apiKey,
  });

  if (port !== undefined && Number.isFinite(port)) {
    const durationMs =
      typeof flags.get('duration-ms') === 'string' ? Number(flags.get('duration-ms')) : undefined;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const rawBody = Buffer.concat(chunks);
          const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url ?? '/mcp'}`;
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(', '));
          }
          const fetchReq = new Request(url, {
            method: req.method ?? 'GET',
            headers,
            body:
              req.method !== 'GET' && req.method !== 'HEAD' && rawBody.byteLength > 0
                ? rawBody
                : undefined,
          });
          const fetchRes = await mcp.fetchHandler(fetchReq);
          res.statusCode = fetchRes.status;
          fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
          const buf = Buffer.from(await fetchRes.arrayBuffer());
          res.end(buf);
        })();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    if (flags.get('json') === true) {
      out(`${JSON.stringify({ url: `http://${host}:${boundPort}/mcp`, allowWrites, audit })}\n`);
    } else {
      out(`MCP HTTP server listening on http://${host}:${boundPort}/mcp (allowWrites=${allowWrites})\n`);
    }

    if (durationMs !== undefined && durationMs >= 0) {
      await new Promise((r) => setTimeout(r, durationMs));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await managed.flushAndClose(allowWrites);
      return 0;
    }

    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await managed.flushAndClose(allowWrites);
    return 0;
  }

  try {
    const lineSource: AsyncIterable<string> =
      io.stdinLines !== undefined
        ? (async function* () {
            for await (const l of io.stdinLines!) yield l;
          })()
        : readline.createInterface({ input: process.stdin, terminal: false });

    await mcp.serveStdio(lineSource, (line) => out(`${line}\n`));
    return 0;
  } catch (e) {
    err(`MCP error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    await managed.flushAndClose(allowWrites);
  }
}

export async function runCliBackup(ctx: CliMcpBackupContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  const outFlag = flags.get('out');
  const keyFlag = flags.get('key');
  if (!uri || typeof outFlag !== 'string' || typeof keyFlag !== 'string' || !keyFlag) {
    err(
      'Usage: firebird-wasm backup <uri> --out <file.fbkp> --key <passphrase> [--base <base.fdb>] [--json]\n',
    );
    return 1;
  }

  const basePath = typeof flags.get('base') === 'string' ? path.resolve(cwd, String(flags.get('base'))) : null;
  const baseImage = basePath ? new Uint8Array(fs.readFileSync(basePath)) : null;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  try {
    const created = await createEncryptedBackup(managed.db, {
      key: keyFlag,
      baseImage,
      pbkdf2Iterations: 10_000,
    });
    const absOut = path.resolve(cwd, outFlag);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, created.archiveBytes);

    if (flags.get('json') === true) {
      out(
        `${JSON.stringify(
          {
            file: absOut,
            byteLength: created.archiveBytes.byteLength,
            header: created.header,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      out(
        `Created ${created.header.kind} encrypted backup -> ${absOut} (${created.archiveBytes.byteLength} bytes, chunks=${created.header.chunkCount})\n`,
      );
    }
    return 0;
  } finally {
    await managed.flushAndClose(false);
  }
}

export async function runCliVerifyBackup(ctx: CliMcpBackupContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const fileArg = positional[1];
  if (!fileArg) {
    err(
      'Usage: firebird-wasm verify-backup <file.fbkp> [--key <passphrase>] [--restore-to <uri>] [--base <base.fdb>] [--json]\n',
    );
    return 1;
  }
  const absFile = path.resolve(cwd, fileArg);
  if (!fs.existsSync(absFile)) {
    err(`Backup archive not found: ${absFile}\n`);
    return 1;
  }
  const archiveBytes = new Uint8Array(fs.readFileSync(absFile));
  const key = typeof flags.get('key') === 'string' ? String(flags.get('key')) : undefined;
  const restoreUri =
    typeof flags.get('restore-to') === 'string' ? String(flags.get('restore-to')) : undefined;

  const report = await verifyBackupArchive(archiveBytes, { key });
  if (restoreUri && report.valid) {
    if (!key) {
      err('--restore-to requires --key <passphrase>\n');
      return 1;
    }
    const basePath =
      typeof flags.get('base') === 'string' ? path.resolve(cwd, String(flags.get('base'))) : null;
    const baseImage = basePath ? new Uint8Array(fs.readFileSync(basePath)) : null;
    const managed = await openCliDatabase(restoreUri, { cwd, backend, allowMissing: true });
    try {
      await restoreEncryptedBackup(archiveBytes, managed.db, { key, baseImage });
    } finally {
      await managed.flushAndClose(true);
    }
  }

  if (flags.get('json') === true) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.valid) {
    out(
      `Backup VALID (id=${report.header?.backupId}, kind=${report.header?.kind}, decrypted=${report.decrypted}, merkle=${report.header?.manifestMerkleRoot})\n`,
    );
  } else {
    err(`Backup INVALID: ${report.reason ?? 'unknown error'}\n`);
  }
  return report.valid ? 0 : 2;
}
