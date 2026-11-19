/**
 * cli-audit-seed-commands.ts – CLI Subcommands for Cryptographic Audit Log
 * Verification (`verify-audit`), Deterministic PII Anonymization (`anonymize`),
 * and Foreign-Key-Aware Seeding (`seed`) (`M26 Items 2 & 4`).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FirebirdDatabase } from './database-core';
import { verifyAuditChain, DEFAULT_AUDIT_LOG_TABLE, type AuditSignAlgorithm } from './audit-log';
import {
  anonymizeDatabase,
  seedDatabase,
  type AnonymizeRulesMap,
} from './data-seeder';

export interface CliAuditSeedCommandContext {
  positional: readonly string[];
  flags: Map<string, string | boolean>;
  cwd: string;
  backend?: 'auto' | 'wasm' | 'native';
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

export async function runCliVerifyAudit(ctx: CliAuditSeedCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  if (!uri) {
    err('Usage: firebird-wasm verify-audit <uri> [--table <name>] [--sign-key <secret>] [--json]\n');
    return 1;
  }
  const tableName =
    typeof flags.get('table') === 'string'
      ? (flags.get('table') as string)
      : DEFAULT_AUDIT_LOG_TABLE;
  const signKey =
    typeof flags.get('sign-key') === 'string' ? (flags.get('sign-key') as string) : undefined;
  const signAlgorithm: AuditSignAlgorithm = 'HMAC';

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  try {
    const report = await verifyAuditChain(managed.db, {
      tableName,
      verifyKey: signKey,
      signAlgorithm,
    });
    if (flags.get('json') === true) {
      out(`${JSON.stringify(report, null, 2)}\n`);
    } else if (report.valid) {
      out(
        `Audit chain VALID (${report.checkedCount} record(s), head=${report.headHash ?? 'empty'}, merkleRoot=${report.merkleRoot ?? 'empty'})\n`,
      );
    } else {
      err(
        `Audit chain TAMPERED at SEQ ${report.tamperedAtSeq ?? '?'}: ${report.reason ?? 'unknown error'}\n`,
      );
    }
    return report.valid ? 0 : 2;
  } finally {
    await managed.flushAndClose(false);
  }
}

export async function runCliAnonymize(ctx: CliAuditSeedCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const srcUri = positional[1];
  const rawRules = flags.get('rules');
  if (!srcUri || typeof rawRules !== 'string' || !rawRules.trim()) {
    err(
      'Usage: firebird-wasm anonymize <srcUri> [--out <dstUri>] --rules <jsonOrFile> [--seed <n>] [--json]\n',
    );
    return 1;
  }

  let parsedRules: AnonymizeRulesMap;
  const trimmedRules = rawRules.trim();
  if (trimmedRules.startsWith('{')) {
    parsedRules = JSON.parse(trimmedRules) as AnonymizeRulesMap;
  } else {
    const ruleFile = path.resolve(cwd, trimmedRules);
    parsedRules = JSON.parse(fs.readFileSync(ruleFile, 'utf8')) as AnonymizeRulesMap;
  }

  const seedVal =
    typeof flags.get('seed') === 'string' ? Number(flags.get('seed')) : 42;
  const outUri =
    typeof flags.get('out') === 'string' ? (flags.get('out') as string).trim() : undefined;
  const tableFilter =
    typeof flags.get('table') === 'string'
      ? (flags.get('table') as string)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

  const srcManaged = await openCliDatabase(srcUri, {
    cwd,
    backend,
    allowMissing: false,
  });
  let dstManaged: Awaited<ReturnType<typeof openCliDatabase>> | null = null;

  try {
    if (outUri && outUri !== srcUri) {
      dstManaged = await openCliDatabase(outUri, {
        cwd,
        backend,
        allowMissing: true,
      });
    }
    const result = await anonymizeDatabase(
      srcManaged.db,
      dstManaged ? dstManaged.db : 'in-place',
      {
        rules: parsedRules,
        seed: Number.isFinite(seedVal) ? seedVal : 42,
        tables: tableFilter,
      },
    );

    if (flags.get('json') === true) {
      out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      out(
        `Anonymized ${result.rowsProcessed} row(s) (${result.columnsScrubbed} cell(s)) across ${result.tablesProcessed.length} table(s)${result.inPlace ? ' (in-place)' : ` -> ${outUri}`}\n`,
      );
    }
    return 0;
  } finally {
    if (dstManaged) {
      await dstManaged.flushAndClose(true);
      await srcManaged.flushAndClose(false);
    } else {
      await srcManaged.flushAndClose(true);
    }
  }
}

export async function runCliSeed(ctx: CliAuditSeedCommandContext): Promise<number> {
  const { positional, flags, cwd, backend, out, err, openCliDatabase } = ctx;
  const uri = positional[1];
  if (!uri) {
    err(
      'Usage: firebird-wasm seed <uri> [--rows <n>] [--table <name>] [--seed <n>] [--truncate] [--json]\n',
    );
    return 1;
  }

  const rowsPerTable =
    typeof flags.get('rows') === 'string' ? Math.max(1, Number(flags.get('rows')) || 10) : 10;
  const seedVal =
    typeof flags.get('seed') === 'string' ? Number(flags.get('seed')) : 42;
  const tables =
    typeof flags.get('table') === 'string'
      ? (flags.get('table') as string)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const truncateFirst = flags.get('truncate') === true;

  const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
  try {
    const result = await seedDatabase(managed.db, {
      tables,
      rowsPerTable,
      seed: Number.isFinite(seedVal) ? seedVal : 42,
      truncateFirst,
    });
    if (flags.get('json') === true) {
      out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      out(
        `Seeded ${result.totalRowsInserted} row(s) across ${result.insertionOrder.length} table(s): ${result.insertionOrder.join(' -> ')}\n`,
      );
    }
    return 0;
  } finally {
    await managed.flushAndClose(true);
  }
}
