/**
 * cli-m32-commands.ts – CLI Subcommand `serve-pgwire` for PostgreSQL v3 Wire Protocol
 * Server (`M32 Item 3`).
 */

import type { CliM28Context } from './cli-m28-commands';
import { createPgWireServer } from './pgwire/server';

export async function runCliServePgWire(ctx: CliM28Context): Promise<number> {
  const { positional, flags, cwd, backend, out, openCliDatabase } = ctx;
  const uri = positional[1] ?? 'memory://serve-pgwire';
  const port = typeof flags.get('port') === 'string' ? Number(flags.get('port')) : 5432;
  const host = typeof flags.get('host') === 'string' ? String(flags.get('host')) : '127.0.0.1';
  const username = typeof flags.get('user') === 'string' ? String(flags.get('user')) : undefined;
  const password =
    typeof flags.get('password') === 'string' ? String(flags.get('password')) : undefined;
  const durationMs =
    typeof flags.get('duration-ms') === 'string' ? Number(flags.get('duration-ms')) : 0;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: true });
  const pgServer = await createPgWireServer(managed.db, {
    host,
    port,
    auth: password
      ? { mode: 'cleartext', username, password }
      : { mode: 'trust' },
  });

  out(`PostgreSQL v3 pgwire server listening on postgresql://${host}:${pgServer.port}\n`);

  if (durationMs > 0) {
    await new Promise((r) => setTimeout(r, durationMs));
    await pgServer.close();
    await managed.flushAndClose(true);
  }
  return 0;
}
