/**
 * cli-schema-commands.ts – CLI Subcommands for Declarative Schema Diff / Push
 * (`schema-diff`, `schema-push`) and Engine Micro-Benchmarks (`bench`) (`M25 Item 4`).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FirebirdDatabase } from './database-core';
import type { FieldInfo, Row, SchemaIntrospection } from './types';
import { collectArrowStreamBytes } from './columnar-stream';
import { decodeArrowIpc } from './columnar';
import { generateMigration } from './browser/schema-diff';
import {
  DestructiveSchemaSyncError,
  introspectSqlScript,
  syncDatabaseSchema,
} from './schema-sync';

export interface CliManagedDatabase {
  readonly db: FirebirdDatabase;
  flushAndClose(persistChanges: boolean): Promise<void>;
}

export interface CliSubcommandContext {
  readonly positional: readonly string[];
  readonly flags: Map<string, string | boolean>;
  readonly cwd: string;
  readonly backend: 'auto' | 'wasm' | 'native';
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly formatCliTable: (fields: readonly FieldInfo[], rows: readonly Row[]) => string;
  readonly openCliDatabase: (
    uri: string,
    options: {
      cwd: string;
      backend?: 'auto' | 'wasm' | 'native';
      allowMissing?: boolean;
    },
  ) => Promise<CliManagedDatabase>;
}

function isSqlFileSpec(spec: string, cwd: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed.toLowerCase().endsWith('.sql')) return null;
  const resolved = path.resolve(cwd, trimmed);
  return fs.existsSync(resolved) ? resolved : resolved;
}

async function loadSchemaFromCliSpec(
  spec: string,
  ctx: CliSubcommandContext,
): Promise<SchemaIntrospection> {
  const sqlFilePath = isSqlFileSpec(spec, ctx.cwd);
  if (sqlFilePath) {
    if (!fs.existsSync(sqlFilePath)) {
      throw new Error(`SQL schema file does not exist: ${sqlFilePath}`);
    }
    const ddl = fs.readFileSync(sqlFilePath, 'utf8');
    return introspectSqlScript(ddl);
  }
  const managed = await ctx.openCliDatabase(spec, {
    cwd: ctx.cwd,
    backend: ctx.backend,
    allowMissing: false,
  });
  try {
    return await managed.db.introspect();
  } finally {
    await managed.flushAndClose(false);
  }
}

/**
 * Execute `firebird-wasm schema-diff <fromUriOrSql> <toUriOrSql> [--sql | --json]` (`M25 Item 4`).
 */
export async function runCliSchemaDiff(ctx: CliSubcommandContext): Promise<number> {
  const fromFlag = ctx.flags.get('from');
  const toFlag = ctx.flags.get('to');
  const fromSpec =
    typeof fromFlag === 'string' && fromFlag.trim()
      ? fromFlag.trim()
      : ctx.positional[1]?.trim();
  const toSpec =
    typeof toFlag === 'string' && toFlag.trim()
      ? toFlag.trim()
      : ctx.positional[2]?.trim();

  if (!fromSpec || !toSpec) {
    ctx.err(
      'Usage: firebird-wasm schema-diff <fromUriOrSql> <toUriOrSql> [--sql | --json]\n',
    );
    return 1;
  }

  const [fromSchema, toSchema] = await Promise.all([
    loadSchemaFromCliSpec(fromSpec, ctx),
    loadSchemaFromCliSpec(toSpec, ctx),
  ]);

  const migration = await generateMigration(fromSchema, toSchema, {
    name: 'cli_schema_diff',
  });
  const diff = migration.diff;

  const wantJson =
    ctx.flags.get('json') === true ||
    String(ctx.flags.get('format') ?? '').toLowerCase() === 'json';
  const wantSql =
    ctx.flags.get('sql') === true ||
    String(ctx.flags.get('format') ?? '').toLowerCase() === 'sql';

  if (wantJson) {
    ctx.out(
      `${JSON.stringify(
        {
          from: fromSpec,
          to: toSpec,
          hasChanges: diff.hasChanges,
          addedTables: diff.addedTables.map((t) => t.name),
          removedTables: diff.removedTables.map((t) => t.name),
          addedColumns: diff.addedColumns.map((c) => `${c.tableName}.${c.name}`),
          removedColumns: diff.removedColumns.map((c) => `${c.tableName}.${c.name}`),
          modifiedColumns: diff.modifiedColumns.map(
            (m) => `${m.tableName}.${m.after.name}`,
          ),
          addedIndexes: diff.addedIndexes.map((i) => i.name),
          removedIndexes: diff.removedIndexes.map((i) => i.name),
          upStatements: migration.up,
          downStatements: migration.down,
          upSql: migration.upSql,
          downSql: migration.downSql,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (wantSql) {
    if (!diff.hasChanges) {
      ctx.out('-- No schema differences detected.\n');
    } else {
      ctx.out(`${migration.upSql}\n`);
    }
    return 0;
  }

  if (!diff.hasChanges) {
    ctx.out('No schema differences detected.\n');
    return 0;
  }

  ctx.out(
    `Schema diff (${fromSpec} -> ${toSpec}): ${migration.up.length} DDL statement(s)\n`,
  );
  for (const stmt of migration.up) {
    ctx.out(`${stmt};\n`);
  }
  return 0;
}

/**
 * Execute `firebird-wasm schema-push <targetUri> --from <sourceUriOrSqlFile> [--dry-run] [--allow-destructive] [--json]` (`M25 Item 4`).
 */
export async function runCliSchemaPush(ctx: CliSubcommandContext): Promise<number> {
  const targetUri = ctx.positional[1]?.trim();
  const fromFlag = ctx.flags.get('from');
  const sourceSpec =
    typeof fromFlag === 'string' && fromFlag.trim()
      ? fromFlag.trim()
      : ctx.positional[2]?.trim();

  if (!targetUri || !sourceSpec) {
    ctx.err(
      'Usage: firebird-wasm schema-push <targetUri> --from <sourceUriOrSqlFile> [--dry-run] [--allow-destructive] [--json]\n',
    );
    return 1;
  }

  const dryRun = ctx.flags.get('dry-run') === true;
  const allowDestructive = ctx.flags.get('allow-destructive') === true;
  const wantJson =
    ctx.flags.get('json') === true ||
    String(ctx.flags.get('format') ?? '').toLowerCase() === 'json';

  const desiredSchema = await loadSchemaFromCliSpec(sourceSpec, ctx);
  const managedTarget = await ctx.openCliDatabase(targetUri, {
    cwd: ctx.cwd,
    backend: ctx.backend,
    allowMissing: true,
  });

  let persist = false;
  try {
    const syncRes = await syncDatabaseSchema(desiredSchema, managedTarget.db, {
      dryRun,
      allowDestructive,
    });
    persist = syncRes.applied && syncRes.statementsExecuted > 0;

    if (wantJson) {
      ctx.out(
        `${JSON.stringify(
          {
            target: targetUri,
            from: sourceSpec,
            applied: syncRes.applied,
            dryRun: syncRes.dryRun,
            statementsExecuted: syncRes.statementsExecuted,
            hasDestructiveChanges: syncRes.hasDestructiveChanges,
            destructiveStatements: syncRes.destructiveStatements,
            statements: syncRes.statements,
            sql: syncRes.sql,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (syncRes.statements.length === 0) {
      ctx.out(`Schema on ${targetUri} is already up to date with ${sourceSpec}.\n`);
      return 0;
    }

    if (dryRun) {
      ctx.out(
        `Dry-run schema push (${sourceSpec} -> ${targetUri}): ${syncRes.statements.length} pending DDL statement(s)` +
          `${syncRes.hasDestructiveChanges ? ' [CONTAINS DESTRUCTIVE CHANGES]' : ''}\n`,
      );
      for (const stmt of syncRes.statements) {
        ctx.out(`${stmt};\n`);
      }
      return 0;
    }

    ctx.out(
      `Applied ${syncRes.statementsExecuted} DDL statement(s) to ${targetUri} from ${sourceSpec}.\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof DestructiveSchemaSyncError) {
      if (wantJson) {
        ctx.err(
          `${JSON.stringify(
            {
              error: e.message,
              code: e.code,
              destructiveStatements: e.destructiveStatements,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        ctx.err(`Error: ${e.message} (pass --allow-destructive to override)\n`);
      }
      return 1;
    }
    throw e;
  } finally {
    await managedTarget.flushAndClose(persist);
  }
}

/**
 * Execute `firebird-wasm bench [uri] [--rows <n>] [--json]`.
 */
export async function runCliBench(ctx: CliSubcommandContext): Promise<number> {
  const uri = ctx.positional[1] ?? 'memory://cli_bench';
  const rowCount = Math.max(
    10,
    Number(typeof ctx.flags.get('rows') === 'string' ? ctx.flags.get('rows') : 250) || 250,
  );
  const format =
    ctx.flags.get('json') === true ||
    String(ctx.flags.get('format') ?? '').toLowerCase() === 'json'
      ? 'json'
      : 'table';

  const managed = await ctx.openCliDatabase(uri, {
    cwd: ctx.cwd,
    backend: ctx.backend,
  });
  try {
    await managed.db.execute(
      'RECREATE TABLE FB_CLI_BENCH$ (ID INTEGER NOT NULL PRIMARY KEY, LABEL VARCHAR(64), SCORE DOUBLE PRECISION)',
    );
    const tbl = managed.db.table<{ ID: number; LABEL: string; SCORE: number }, number>(
      'FB_CLI_BENCH$',
      { primaryKey: 'ID' },
    );

    const batchInput = Array.from({ length: rowCount }, (_, i) => ({
      ID: i + 1,
      LABEL: `row_${i + 1}`,
      SCORE: (i + 1) * 1.25,
    }));

    const tInsert0 = performance.now();
    await tbl.insertMany(batchInput);
    const insertMs = performance.now() - tInsert0;

    const tRow0 = performance.now();
    const rowRes = await managed.db.query(
      'SELECT ID, LABEL, SCORE FROM FB_CLI_BENCH$ ORDER BY ID',
    );
    const rowQueryMs = performance.now() - tRow0;

    const tCol0 = performance.now();
    const colRes = await managed.db.queryColumnar(
      'SELECT ID, LABEL, SCORE FROM FB_CLI_BENCH$ ORDER BY ID',
    );
    const colQueryMs = performance.now() - tCol0;

    const tArrow0 = performance.now();
    const arrowBytes = await collectArrowStreamBytes(
      managed.db.queryArrowStream(
        'SELECT ID, LABEL, SCORE FROM FB_CLI_BENCH$ ORDER BY ID',
        { batchSize: Math.max(25, Math.ceil(rowCount / 4)) },
      ),
    );
    const decodedArrow = decodeArrowIpc(arrowBytes);
    const arrowStreamMs = performance.now() - tArrow0;

    const prepPipe = await managed.db.preparePipeline([
      { kind: 'query', sql: 'SELECT ID, SCORE FROM FB_CLI_BENCH$ WHERE ID = ?' },
      {
        kind: 'queryColumnar',
        sql: 'SELECT ID, SCORE FROM FB_CLI_BENCH$ WHERE ID <= ?',
      },
    ] as const);
    const tPipe0 = performance.now();
    try {
      await prepPipe.run([[1], [Math.min(20, rowCount)]]);
    } finally {
      await prepPipe.close();
    }
    const prepPipeMs = performance.now() - tPipe0;

    await managed.db.execute('DROP TABLE FB_CLI_BENCH$');

    const metrics = [
      {
        WORKLOAD: 'insertMany (IBatch)',
        ROWS: rowCount,
        MS: Number(insertMs.toFixed(2)),
        ROWS_PER_SEC: Math.round((rowCount / Math.max(0.05, insertMs)) * 1000),
      },
      {
        WORKLOAD: 'query (JS objects)',
        ROWS: rowRes.rows.length,
        MS: Number(rowQueryMs.toFixed(2)),
        ROWS_PER_SEC: Math.round((rowRes.rows.length / Math.max(0.05, rowQueryMs)) * 1000),
      },
      {
        WORKLOAD: 'queryColumnar (TypedArrays)',
        ROWS: colRes.rowCount,
        MS: Number(colQueryMs.toFixed(2)),
        ROWS_PER_SEC: Math.round((colRes.rowCount / Math.max(0.05, colQueryMs)) * 1000),
      },
      {
        WORKLOAD: 'queryArrowStream (IPC V5)',
        ROWS: decodedArrow.rowCount,
        MS: Number(arrowStreamMs.toFixed(2)),
        ROWS_PER_SEC: Math.round(
          (decodedArrow.rowCount / Math.max(0.05, arrowStreamMs)) * 1000,
        ),
      },
      {
        WORKLOAD: 'preparePipeline (stmtHandle)',
        ROWS: Math.min(20, rowCount) + 1,
        MS: Number(prepPipeMs.toFixed(2)),
        ROWS_PER_SEC: Math.round(
          ((Math.min(20, rowCount) + 1) / Math.max(0.05, prepPipeMs)) * 1000,
        ),
      },
    ];

    if (format === 'json') {
      ctx.out(`${JSON.stringify({ uri, rows: rowCount, benchmarks: metrics }, null, 2)}\n`);
    } else {
      ctx.out(
        ctx.formatCliTable(
          [{ name: 'WORKLOAD' }, { name: 'ROWS' }, { name: 'MS' }, { name: 'ROWS_PER_SEC' }],
          metrics,
        ),
      );
    }
  } finally {
    await managed.flushAndClose(false);
  }
  return 0;
}
