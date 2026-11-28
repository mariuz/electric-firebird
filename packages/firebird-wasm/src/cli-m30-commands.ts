/**
 * cli-m30-commands.ts – CLI Subcommands for CQRS Event Projections (`projections`)
 * & Zero-Code Introspected GraphQL / REST / OpenAPI Gateway (`serve-api`) (`M30 Items 2 & 3`).
 */

import * as http from 'http';
import type { CliM28Context } from './cli-m28-commands';
import { createAutoApiGateway } from './auto-api-gateway';
import { fetchPersistedEventProjections } from './event-store';

export async function runCliProjections(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, formatCliTable, openCliDatabase } = ctx;
  const uri = positional[1] ?? 'memory://projections';
  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: true });
  try {
    const statuses = await fetchPersistedEventProjections(managed.db);
    if (flags.get('json') === true) {
      out(`${JSON.stringify({ projections: statuses }, null, 2)}\n`);
    } else if (statuses.length === 0) {
      out('No CQRS event projections recorded in FB_EVENT_PROJECTIONS$.\n');
    } else {
      const rows = statuses.map((s) => ({
        PROJECTION: s.name,
        LAST_SEQ: s.lastGlobalSeq,
        PROCESSED: s.processedCount,
        LAG: s.lagEvents,
      }));
      out(formatCliTable([], rows));
    }
    return 0;
  } finally {
    await managed.flushAndClose(false);
  }
}

export async function runCliServeApi(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, openCliDatabase } = ctx;
  const uri = positional[1] ?? 'memory://serve-api';
  const apiKey = typeof flags.get('api-key') === 'string' ? String(flags.get('api-key')) : undefined;
  const jwtSecret =
    typeof flags.get('jwt-secret') === 'string' ? String(flags.get('jwt-secret')) : undefined;
  const readOnly = flags.get('read-only') === true;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: true });
  const gateway = createAutoApiGateway(managed.db, {
    apiKey,
    jwtSecret,
    readOnly,
  });

  if (flags.get('openapi') === true) {
    try {
      const spec = await gateway.getOpenApiSpec();
      out(`${JSON.stringify(spec, null, 2)}\n`);
      return 0;
    } finally {
      await managed.flushAndClose(false);
    }
  }

  if (flags.get('sdl') === true) {
    try {
      const sdl = await gateway.getGraphqlSdl();
      out(`${sdl}\n`);
      return 0;
    } finally {
      await managed.flushAndClose(false);
    }
  }

  const port = typeof flags.get('port') === 'string' ? Number(flags.get('port')) : 4040;
  const host = typeof flags.get('host') === 'string' ? String(flags.get('host')) : '127.0.0.1';
  const durationMs =
    typeof flags.get('duration-ms') === 'string' ? Number(flags.get('duration-ms')) : 0;

  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const bodyBuf = Buffer.concat(chunks);
      const fullUrl = `http://${req.headers.host ?? `${host}:${port}`}${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const webReq = new Request(fullUrl, {
        method: req.method ?? 'GET',
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
      });
      const webRes = await gateway.fetch(webReq);
      res.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => res.setHeader(key, val));
      const arrBuf = await webRes.arrayBuffer();
      res.end(Buffer.from(arrBuf));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  out(`Auto-API GraphQL & REST gateway listening on http://${host}:${boundPort}\n`);

  if (durationMs > 0) {
    await new Promise((r) => setTimeout(r, durationMs));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await managed.flushAndClose(!readOnly);
  }
  return 0;
}
