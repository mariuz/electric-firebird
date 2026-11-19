/**
 * cli-sync-commands.ts – CLI Subcommands for WAL Shipping (`wal-ship`),
 * Point-in-Time Recovery (`pitr-restore`), and Replication Server (`serve-sync`) (`M26 Item 5`).
 */

import {
  createObjectStoreReplicationTarget,
  restoreDatabaseToPointInTime,
  type ObjectStoreAdapter,
  type ObjectStorePitrTarget,
} from './replication/object-store-wal';
import type { ReplicableDatabase } from './replication/types';
import { startCliReplicationServer } from './cli-sync-server';
import type { CliSubcommandContext } from './cli-schema-commands';

export async function runCliWalShip(
  ctx: CliSubcommandContext,
  resolveStore: (flags: Map<string, string | boolean>, cwd: string) => ObjectStoreAdapter | null,
): Promise<number> {
  const sourceUri = ctx.positional[1];
  const store = resolveStore(ctx.flags, ctx.cwd);
  if (!sourceUri || !store) {
    ctx.err(
      'Usage: firebird-wasm wal-ship <source-uri> (--dir <wal-dir> | --url <store-url>) [--prefix <pfx>] [--checkpoint] [--prune] [--key <passphrase>] [--json]\n',
    );
    return 1;
  }
  const prefix =
    typeof ctx.flags.get('prefix') === 'string' ? String(ctx.flags.get('prefix')) : undefined;
  const encryptionKey =
    typeof ctx.flags.get('key') === 'string' ? String(ctx.flags.get('key')) : undefined;

  const srcManaged = await ctx.openCliDatabase(sourceUri, {
    cwd: ctx.cwd,
    backend: ctx.backend,
    allowMissing: false,
  });
  try {
    const target = await createObjectStoreReplicationTarget({
      db: srcManaged.db as unknown as ReplicableDatabase,
      store,
      prefix,
      encryptionKey,
      installTriggers: true,
    });
    try {
      let checkpointId: string | null = null;
      const currentManifest = await target.getManifest();
      if (ctx.flags.get('checkpoint') === true || currentManifest.checkpoints.length === 0) {
        const ckpt = await target.createCheckpoint();
        checkpointId = ckpt.id;
      }
      const shipped = await target.shipWalOnce();
      const pruned =
        ctx.flags.get('prune') === true ? await target.pruneArchivedSegments() : null;
      const finalManifest = await target.getManifest();
      const report = {
        checkpointCreated: checkpointId,
        segmentsShipped: shipped.length,
        entriesShipped: shipped.reduce((acc, s) => acc + s.entryCount, 0),
        prunedSegments: pruned?.deletedSegments ?? 0,
        latestLsn: finalManifest.latestLsn,
        totalCheckpoints: finalManifest.checkpoints.length,
        totalSegments: finalManifest.segments.length,
      };
      if (ctx.flags.get('json') === true) {
        ctx.out(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        ctx.out(
          `Shipped WAL for ${sourceUri}: checkpoint=${report.checkpointCreated ?? 'none'}, segments=${report.segmentsShipped}, latestLsn=${report.latestLsn}\n`,
        );
      }
    } finally {
      await target.stop();
    }
  } finally {
    await srcManaged.flushAndClose(true);
  }
  return 0;
}

export async function runCliPitrRestore(
  ctx: CliSubcommandContext,
  resolveStore: (flags: Map<string, string | boolean>, cwd: string) => ObjectStoreAdapter | null,
): Promise<number> {
  const targetUri = ctx.positional[1];
  const store = resolveStore(ctx.flags, ctx.cwd);
  if (!targetUri || !store) {
    ctx.err(
      'Usage: firebird-wasm pitr-restore <target-uri> (--dir <wal-dir> | --url <store-url>) [--prefix <pfx>] [--lsn <n>] [--timestamp <iso-or-ms>] [--hlc <hlc>] [--key <passphrase>] [--json]\n',
    );
    return 1;
  }
  const prefix =
    typeof ctx.flags.get('prefix') === 'string' ? String(ctx.flags.get('prefix')) : undefined;
  const decryptionKey =
    typeof ctx.flags.get('key') === 'string' ? String(ctx.flags.get('key')) : undefined;

  const pitrTarget: ObjectStorePitrTarget = {};
  let hasCutoff = false;
  if (typeof ctx.flags.get('lsn') === 'string') {
    pitrTarget.lsn = Number(ctx.flags.get('lsn'));
    hasCutoff = true;
  }
  if (typeof ctx.flags.get('timestamp') === 'string') {
    const rawTs = String(ctx.flags.get('timestamp'));
    pitrTarget.timestamp = /^\d+$/.test(rawTs) ? Number(rawTs) : Date.parse(rawTs);
    hasCutoff = true;
  }
  if (typeof ctx.flags.get('hlc') === 'string') {
    pitrTarget.hlc = String(ctx.flags.get('hlc'));
    hasCutoff = true;
  }

  const dstManaged = await ctx.openCliDatabase(targetUri, {
    cwd: ctx.cwd,
    backend: ctx.backend,
  });
  try {
    const res = await restoreDatabaseToPointInTime({
      targetDb: dstManaged.db as unknown as ReplicableDatabase,
      store,
      prefix,
      decryptionKey,
      ...(hasCutoff ? { target: pitrTarget } : {}),
    });
    if (ctx.flags.get('json') === true) {
      ctx.out(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      ctx.out(
        `Restored ${targetUri} to LSN ${res.restoredToLsn} (checkpoint=${res.checkpointUsed ?? 'none'}, segments=${res.segmentsReplayed}, entries=${res.entriesApplied})\n`,
      );
    }
  } finally {
    await dstManaged.flushAndClose(true);
  }
  return 0;
}

export async function runCliServeSync(ctx: CliSubcommandContext): Promise<number> {
  const uri = ctx.positional[1] ?? 'memory://cli_serve_sync';
  const port =
    typeof ctx.flags.get('port') === 'string' ? Number(ctx.flags.get('port')) : 8787;
  const host =
    typeof ctx.flags.get('host') === 'string' ? String(ctx.flags.get('host')) : '127.0.0.1';
  const apiKey =
    typeof ctx.flags.get('api-key') === 'string' ? String(ctx.flags.get('api-key')) : undefined;
  const tenantColumn =
    typeof ctx.flags.get('tenant-column') === 'string'
      ? String(ctx.flags.get('tenant-column'))
      : undefined;
  const sharedTables =
    typeof ctx.flags.get('shared-tables') === 'string'
      ? String(ctx.flags.get('shared-tables'))
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const cors = ctx.flags.get('no-cors') !== true;
  const durationMs =
    typeof ctx.flags.get('duration-ms') === 'string'
      ? Number(ctx.flags.get('duration-ms'))
      : undefined;

  const managed = await ctx.openCliDatabase(uri, {
    cwd: ctx.cwd,
    backend: ctx.backend,
  });
  const jwtSecret =
    typeof ctx.flags.get('jwt-secret') === 'string'
      ? String(ctx.flags.get('jwt-secret'))
      : undefined;
  const jwksUrl =
    typeof ctx.flags.get('jwks-url') === 'string'
      ? String(ctx.flags.get('jwks-url'))
      : undefined;
  const jwtTenantClaim =
    typeof ctx.flags.get('jwt-tenant-claim') === 'string'
      ? String(ctx.flags.get('jwt-tenant-claim'))
      : undefined;

  const srv = await startCliReplicationServer({
    db: managed.db,
    port,
    host,
    apiKey,
    jwtSecret,
    jwksUrl,
    jwtTenantClaim,
    tenantColumn,
    sharedTables,
    cors,
  });

  try {
    if (ctx.flags.get('json') === true) {
      ctx.out(
        `${JSON.stringify(
          {
            url: srv.url,
            host: srv.host,
            port: srv.port,
            publication: srv.publication.name,
            tenantColumn: tenantColumn ?? null,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      ctx.out(
        `Serving Firebird replication & Arrow IPC on ${srv.url} (publication=${srv.publication.name}${tenantColumn ? `, tenant=${tenantColumn}` : ''})\n`,
      );
    }

    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    } else {
      await new Promise<void>((resolve) => {
        const onStop = () => {
          process.off('SIGINT', onStop);
          process.off('SIGTERM', onStop);
          resolve();
        };
        process.on('SIGINT', onStop);
        process.on('SIGTERM', onStop);
      });
    }
  } finally {
    await srv.close();
    await managed.flushAndClose(true);
  }
  return 0;
}
