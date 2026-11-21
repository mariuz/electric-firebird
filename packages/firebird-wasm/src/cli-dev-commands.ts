/**
 * cli-dev-commands.ts – `codegen`, `migrate`, and interactive `repl` Subcommand
 * Runners for `npx firebird-wasm` (`M27 Item 5`).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { VERSION } from './version';
import type { FirebirdDatabase } from './database-core';
import type { FieldInfo, Migration, Row } from './types';
import { splitStatements } from './browser/sql-script';
import {
  generateDrizzleSchema,
  generateKyselyTypes,
  type CodegenIdentifierCase,
} from './browser/codegen';
import { syncDatabases } from './replication/presets';
import type { BootstrapStrategy, ReplicableDatabase } from './replication/types';
import { collectArrowStreamBytes } from './columnar-stream';
import { decodeArrowIpc } from './columnar';
import type { CliIo } from './cli';

export interface CliDevCommandContext {
  positional: readonly string[];
  flags: Map<string, string | boolean>;
  cwd: string;
  backend?: 'auto' | 'wasm' | 'native';
  io: CliIo;
  out: (text: string) => void;
  err: (text: string) => void;
  formatCliTable: (fields: readonly FieldInfo[], rows: readonly Row[]) => string;
  isSelectLike: (sql: string) => boolean;
  isMutatingStatement: (sql: string) => boolean;
  loadMigrationsFromDirectory: (absDir: string) => Promise<Migration[]>;
  openCliDatabase: (
    uri: string,
    opts: { cwd: string; backend?: 'auto' | 'wasm' | 'native'; allowMissing?: boolean },
  ) => Promise<{
    readonly db: FirebirdDatabase;
    flushAndClose(persistChanges: boolean): Promise<void>;
  }>;
}

export async function runCliCodegen(ctx: CliDevCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  if (!uri) {
    err('Usage: firebird-wasm codegen <uri> [--kysely | --drizzle] [--out <file>]\n');
    return 1;
  }
  const target =
    flags.get('drizzle') === true ||
    String(flags.get('target') ?? '').toLowerCase() === 'drizzle'
      ? 'drizzle'
      : 'kysely';
  const identifierCase: CodegenIdentifierCase =
    flags.get('case') === 'preserve' ? 'preserve' : 'lower';
  const outPath = typeof flags.get('out') === 'string' ? String(flags.get('out')) : null;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  let code: string;
  try {
    code =
      target === 'drizzle'
        ? await generateDrizzleSchema(managed.db, { identifierCase })
        : await generateKyselyTypes(managed.db, { identifierCase });
  } finally {
    await managed.flushAndClose(false);
  }

  if (outPath) {
    const absOut = path.resolve(cwd, outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, code, 'utf8');
    out(`Generated ${target} schema -> ${absOut}\n`);
  } else {
    out(code.endsWith('\n') ? code : `${code}\n`);
  }
  return 0;
}

export async function runCliMigrate(ctx: CliDevCommandContext): Promise<number> {
  const {
    positional,
    flags,
    cwd,
    backend,
    out,
    err,
    loadMigrationsFromDirectory,
    openCliDatabase,
  } = ctx;
  const uri = positional[1];
  const dirFlag = flags.get('dir');
  if (!uri || typeof dirFlag !== 'string') {
    err('Usage: firebird-wasm migrate <uri> --dir <migrations-dir> [--down] [--target <ver>]\n');
    return 1;
  }
  const absDir = path.resolve(cwd, dirFlag);
  const migrations = await loadMigrationsFromDirectory(absDir);
  const direction = flags.get('down') === true ? 'down' : 'up';
  const targetRaw = flags.get('target');
  const targetVersion =
    typeof targetRaw === 'string' && /^\d+$/.test(targetRaw) ? Number(targetRaw) : undefined;

  const managed = await openCliDatabase(uri, { cwd, backend });
  try {
    const result = await managed.db.migrate(migrations, {
      direction,
      ...(targetVersion !== undefined ? { targetVersion } : {}),
    });
    out(
      JSON.stringify(
        {
          direction,
          applied: result.applied,
          reverted: result.reverted,
          currentVersion: result.currentVersion,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await managed.flushAndClose(true);
  }
  return 0;
}

export async function runCliInteractiveRepl(ctx: CliDevCommandContext): Promise<number> {
  const {
    positional,
    cwd,
    backend,
    io,
    out,
    err,
    formatCliTable,
    isSelectLike,
    isMutatingStatement,
    openCliDatabase,
  } = ctx;
  const uri = positional[1] ?? 'memory://repl';
  const managed = await openCliDatabase(uri, { cwd, backend });
  let dirty = false;
  out(
    `firebird-wasm v${VERSION} interactive SQL shell (${uri})\nType .help for commands, .quit to exit.\n`,
  );

  const lineSource: AsyncIterable<string> =
    io.stdinLines !== undefined
      ? (async function* () {
          for await (const l of io.stdinLines!) yield l;
        })()
      : readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: 'SQL> ',
        });

  const rl =
    'prompt' in lineSource && typeof (lineSource as readline.Interface).prompt === 'function'
      ? (lineSource as readline.Interface)
      : null;

  let buffer = '';
  try {
    rl?.prompt();
    for await (const rawLine of lineSource) {
      const trimmed = rawLine.trim();
      if (!buffer && (trimmed === '.quit' || trimmed === '.exit')) {
        break;
      }
      if (!buffer && trimmed === '.help') {
        out(
          'Commands:\n  .tables          List user tables\n  .schema [table]  Show catalog summary\n  .info            Show database page/transaction info\n  .quit / .exit    Close database and exit\n',
        );
        rl?.prompt();
        continue;
      }
      if (!buffer && trimmed === '.tables') {
        const cat = await managed.db.introspect();
        out(
          cat.tables.map((t) => t.name).join('\n') +
            (cat.tables.length ? '\n' : '(no tables)\n'),
        );
        rl?.prompt();
        continue;
      }
      if (!buffer && trimmed.startsWith('.schema')) {
        const filterTbl = trimmed.slice('.schema'.length).trim().toUpperCase();
        const cat = await managed.db.introspect();
        const cols = filterTbl
          ? cat.columns.filter((c) => c.tableName.toUpperCase() === filterTbl)
          : cat.columns;
        for (const c of cols) {
          out(`${c.tableName}.${c.name} ${c.typeName}${c.nullable ? '' : ' NOT NULL'}\n`);
        }
        rl?.prompt();
        continue;
      }
      if (!buffer && trimmed === '.info') {
        const info = await managed.db.databaseInfo();
        out(`${JSON.stringify(info, null, 2)}\n`);
        rl?.prompt();
        continue;
      }

      if (!trimmed && !buffer) {
        rl?.prompt();
        continue;
      }

      buffer = buffer ? `${buffer}\n${rawLine}` : rawLine;
      if (!trimmed.endsWith(';')) {
        rl?.setPrompt('...> ');
        rl?.prompt();
        continue;
      }

      const sqlBatch = buffer;
      buffer = '';
      rl?.setPrompt('SQL> ');
      try {
        const stmts = splitStatements(sqlBatch);
        for (const s of stmts) {
          if (isMutatingStatement(s.sql)) dirty = true;
          if (isSelectLike(s.sql)) {
            const res = await managed.db.query<Row>(s.sql);
            out(formatCliTable(res.fields, res.rows));
          } else {
            const res = await managed.db.execute(s.sql);
            out(`OK (${res.affectedRows} rows affected)\n`);
          }
        }
      } catch (sqlErr) {
        err(`Error: ${sqlErr instanceof Error ? sqlErr.message : String(sqlErr)}\n`);
      }
      rl?.prompt();
    }
  } finally {
    rl?.close();
    await managed.flushAndClose(dirty);
  }
  return 0;
}

export async function runCliSync(ctx: CliDevCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const sourceUri = positional[1];
  const targetUri = positional[2];
  if (!sourceUri || !targetUri) {
    err(
      'Usage: firebird-wasm sync <source-uri> <target-uri> [--mode auto|native|logical] [--bootstrap logical|binary-image|page-diff] [--direction one-way|bidirectional] [--json]\n',
    );
    return 1;
  }
  const modeRaw = String(flags.get('mode') ?? 'auto').toLowerCase();
  const mode: 'auto' | 'native' | 'logical' =
    modeRaw === 'native' || modeRaw === 'logical' ? modeRaw : 'auto';
  const bootRaw = String(flags.get('bootstrap') ?? 'logical').toLowerCase();
  const bootstrapStrategy: BootstrapStrategy =
    bootRaw === 'binary-image' || bootRaw === 'page-diff' || bootRaw === 'arrow-ipc'
      ? bootRaw
      : 'logical';
  const direction: 'one-way' | 'bidirectional' =
    String(flags.get('direction') ?? 'one-way').toLowerCase() === 'bidirectional'
      ? 'bidirectional'
      : 'one-way';

  const srcManaged = await openCliDatabase(sourceUri, {
    cwd,
    backend,
    allowMissing: false,
  });
  const dstManaged = await openCliDatabase(targetUri, { cwd, backend });
  try {
    const handle = await syncDatabases(
      srcManaged.db as unknown as ReplicableDatabase,
      dstManaged.db as unknown as ReplicableDatabase,
      { mode, bootstrapStrategy, direction, live: false },
    );
    try {
      const cycle = await handle.syncNow();
      const stats = await handle.stats();
      const appliedCount =
        'primaryToReplica' in cycle
          ? cycle.primaryToReplica.appliedCount
          : cycle.appliedCount;
      const summary = {
        mode: handle.mode,
        bootstrapStrategy,
        direction,
        appliedCount,
        primaryLsn: stats.primaryLsn,
        replicaWatermark: stats.replicaWatermark,
        lagEntries: stats.lagEntries,
      };
      if (flags.get('json') === true) {
        out(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        out(
          `Synced ${sourceUri} -> ${targetUri} (mode=${summary.mode}, bootstrap=${bootstrapStrategy}, applied=${summary.appliedCount}, LSN=${summary.replicaWatermark}/${summary.primaryLsn})\n`,
        );
      }
    } finally {
      await handle.stop();
    }
  } finally {
    await dstManaged.flushAndClose(true);
    await srcManaged.flushAndClose(true);
  }
  return 0;
}

export async function runCliExportArrow(ctx: CliDevCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  const sqlText = positional.slice(2).join(' ').trim();
  const outFlag = flags.get('out');
  if (!uri || !sqlText || typeof outFlag !== 'string' || !outFlag.trim()) {
    err(
      'Usage: firebird-wasm export-arrow <uri> <sql> --out <file.arrow> [--gzip] [--batch-size <n>] [--json]\n',
    );
    return 1;
  }
  const outPath = path.resolve(cwd, outFlag);
  const batchSize = Math.max(
    1,
    Number(typeof flags.get('batch-size') === 'string' ? flags.get('batch-size') : 1024) || 1024,
  );
  const useGzip = flags.get('gzip') === true || outPath.toLowerCase().endsWith('.gz');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const managed = await openCliDatabase(uri, { cwd, backend });
  try {
    const arrowStream = managed.db.queryArrowStream(sqlText, { batchSize });
    const rawArrowBytes = await collectArrowStreamBytes(arrowStream);
    const decoded = decodeArrowIpc(rawArrowBytes);
    const finalBytes = useGzip
      ? new Uint8Array(zlib.gzipSync(rawArrowBytes))
      : rawArrowBytes;
    fs.writeFileSync(outPath, finalBytes);

    if (flags.get('json') === true) {
      out(
        `${JSON.stringify(
          {
            out: outPath,
            rows: decoded.rowCount,
            columns: decoded.fields.map((f) => f.name),
            bytes: finalBytes.byteLength,
            gzip: useGzip,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      out(
        `Exported ${decoded.rowCount} row(s) (${finalBytes.byteLength} bytes${useGzip ? ', gzip' : ''}) to ${outPath}\n`,
      );
    }
  } finally {
    await managed.flushAndClose(false);
  }
  return 0;
}

export async function runCliImportArrow(ctx: CliDevCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  const tableName = positional[2]?.trim();
  const inFlag = flags.get('in');
  if (!uri || !tableName || typeof inFlag !== 'string' || !inFlag.trim()) {
    err(
      'Usage: firebird-wasm import-arrow <uri> <table> --in <file.arrow> [--gzip] [--create-table] [--pk <col>] [--upsert] [--json]\n',
    );
    return 1;
  }
  const inPath = path.resolve(cwd, inFlag);
  if (!fs.existsSync(inPath)) {
    err(`Input Arrow file not found: ${inPath}\n`);
    return 1;
  }
  const rawBuf = fs.readFileSync(inPath);
  const isGzip =
    flags.get('gzip') === true ||
    (rawBuf.byteLength >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b);
  const unpacked = isGzip ? zlib.gunzipSync(rawBuf) : rawBuf;
  const arrowBytes = new Uint8Array(
    unpacked.buffer,
    unpacked.byteOffset,
    unpacked.byteLength,
  );

  const pkFlag = flags.get('pk');
  const primaryKey =
    typeof pkFlag === 'string' && pkFlag.trim()
      ? pkFlag
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const createTable = flags.get('create-table') === true;
  const upsert = flags.get('upsert') === true;
  const batchSize = Math.max(
    1,
    Number(typeof flags.get('batch-size') === 'string' ? flags.get('batch-size') : 1000) || 1000,
  );

  const managed = await openCliDatabase(uri, { cwd, backend });
  try {
    const result = await managed.db.loadArrowIpc(tableName, arrowBytes, {
      createTable,
      primaryKey,
      upsertMatching: upsert ? (primaryKey ?? true) : undefined,
      batchSize,
    });
    if (flags.get('json') === true) {
      out(
        `${JSON.stringify(
          {
            table: result.tableName,
            rowsIngested: result.rowsIngested,
            batchesExecuted: result.batchesExecuted,
            bytesProcessed: result.bytesProcessed,
            tableCreated: result.tableCreated,
            columns: result.columns,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      out(
        `Imported ${result.rowsIngested} row(s) into ${result.tableName} (${result.batchesExecuted} batch(es))\n`,
      );
    }
  } finally {
    await managed.flushAndClose(true);
  }
  return 0;
}
