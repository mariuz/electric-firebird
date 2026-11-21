/**
 * cli-dev-commands.ts – `codegen`, `migrate`, and interactive `repl` Subcommand
 * Runners for `npx firebird-wasm` (`M27 Item 5`).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { VERSION } from './version';
import type { FirebirdDatabase } from './database-core';
import type { FieldInfo, Migration, Row } from './types';
import { splitStatements } from './browser/sql-script';
import {
  generateDrizzleSchema,
  generateKyselyTypes,
  type CodegenIdentifierCase,
} from './browser/codegen';
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
