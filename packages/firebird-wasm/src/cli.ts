#!/usr/bin/env node
/**
 * cli.ts – `npx firebird-wasm` Developer CLI (`M19 Item 5`).
 *
 * Subcommands:
 *   - `firebird-wasm query <uri> <sql> [--format table|json|csv|jsonl]`
 *   - `firebird-wasm repl [uri]`
 *   - `firebird-wasm codegen <uri> [--kysely | --drizzle | --target kysely|drizzle] [--out <file>]`
 *   - `firebird-wasm migrate <uri> --dir <dir> [--down] [--target <version>]`
 *   - `firebird-wasm dump <uri> --out <file> [--gzip]`
 *   - `firebird-wasm restore <uri> --in <file> [--gzip]`
 *   - `firebird-wasm inspect-changelog <file> [--json]`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';
import { VERSION } from './version';
import { openDatabase } from './open-database';
import { FirebirdBrowser } from './browser/firebird-browser';
import type { FirebirdDatabase } from './database-core';
import type { FieldInfo, Migration, Row } from './types';
import { splitStatements } from './browser/sql-script';
import { encodeCsvRow, encodeJsonlRow } from './browser/copy-stream';
import {
  generateDrizzleSchema,
  generateKyselyTypes,
  type CodegenIdentifierCase,
} from './browser/codegen';
import {
  decodeFbChangelogOperations,
  FbChangelogOpcode,
  isFbChangelogSegment,
  parseFbChangelogSegment,
} from './replication/native-changelog';

/** Injectable I/O handles for programmatic and unit-tested CLI execution. */
export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stdinLines?: AsyncIterable<string> | Iterable<string>;
  cwd?: string;
}

/** Structured inspection report returned by {@link inspectChangelogBuffer} and `inspect-changelog --json`. */
export interface CliChangelogInspection {
  readonly magic: string;
  readonly version: number;
  readonly sequence: number;
  readonly state: number;
  readonly stateName: string;
  readonly guid: string;
  readonly blockCount: number;
  readonly totalOperations: number;
  readonly transactions: readonly number[];
  readonly opcodeCounts: Readonly<Record<string, number>>;
  readonly blocks: ReadonlyArray<{
    readonly index: number;
    readonly traNumber: number;
    readonly protocol: number;
    readonly flags: number;
    readonly beginTrans: boolean;
    readonly endTrans: boolean;
    readonly length: number;
    readonly operationCount: number;
  }>;
}

const HELP_TEXT = `firebird-wasm v${VERSION} — Embedded Firebird WASM & Node.js Developer CLI

Usage:
  firebird-wasm <command> [options]

Commands:
  query <uri> <sql>              Execute SQL and print results (--format table|json|csv|jsonl)
  repl [uri]                     Interactive SQL shell (defaults to memory://repl)
  codegen <uri>                  Generate TypeScript types (--kysely | --drizzle) [--out <file>]
  migrate <uri> --dir <dir>      Apply (or --down revert) SQL/JSON migrations in <dir>
  dump <uri> --out <file>        Export database bytes to <file> [--gzip]
  restore <uri> --in <file>      Restore database bytes from <file> [--gzip]
  inspect-changelog <file>       Inspect a binary Firebird "FBCHANGELOG\\0" segment [--json]

Global Options:
  --backend <auto|wasm|native>   Engine backend override (default: auto)
  -h, --help                     Show help
  -v, --version                  Show package version
`;

function hasNativeFirebirdDriver(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require.resolve('node-firebird-driver-native');
    return true;
  } catch {
    return false;
  }
}

function isVirtualOrRemoteUri(uri: string): boolean {
  return (
    uri.startsWith('memory://') ||
    uri.startsWith('idb://') ||
    uri.startsWith('opfs://') ||
    uri.startsWith('wasm://') ||
    uri.startsWith('firebird://') ||
    /^[A-Za-z0-9._-]+(?:\/\d+)?:.+/.test(uri)
  );
}

function isWindowsDrivePath(uri: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(uri);
}

function resolveLocalFilePath(uri: string, cwd: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return path.resolve(cwd, trimmed.replace(/^file:\/\/\/?/, ''));
    }
  }
  if (isWindowsDrivePath(trimmed)) {
    return path.resolve(trimmed);
  }
  if (isVirtualOrRemoteUri(trimmed)) {
    return null;
  }
  return path.resolve(cwd, trimmed);
}

interface ManagedCliDb {
  readonly db: FirebirdDatabase;
  flushAndClose(persistChanges: boolean): Promise<void>;
}

let cliMemCounter = 0;

async function openCliDatabase(
  uri: string,
  options: {
    cwd: string;
    backend?: 'auto' | 'wasm' | 'native';
    allowMissing?: boolean;
  },
): Promise<ManagedCliDb> {
  const cleanUri = uri.trim() || 'memory://cli';
  const backend = options.backend ?? 'auto';
  const localPath = resolveLocalFilePath(cleanUri, options.cwd);

  // Use WASM file-backed mode for local `.fdb` files whenever `--backend wasm` is
  // requested or `node-firebird-driver-native` is not installed on the host.
  if (
    localPath &&
    (backend === 'wasm' || (backend === 'auto' && !hasNativeFirebirdDriver()))
  ) {
    let loadDataDir: Uint8Array | undefined;
    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      if (stat.size > 0) {
        const raw = fs.readFileSync(localPath);
        loadDataDir = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      }
    } else if (options.allowMissing === false) {
      throw new Error(`Database file does not exist: ${localPath}`);
    }

    cliMemCounter += 1;
    const db = new FirebirdBrowser(`memory://cli_${process.pid}_${cliMemCounter}`, {
      threads: false,
      ...(loadDataDir ? { loadDataDir } : {}),
      types: { binary: true },
    });

    return {
      db,
      async flushAndClose(persistChanges: boolean) {
        try {
          if (persistChanges) {
            const bytes = await db.dumpDataDir();
            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            fs.writeFileSync(localPath, bytes);
          }
        } finally {
          await db.close();
        }
      },
    };
  }

  const db = await openDatabase(cleanUri, {
    backend,
    threads: false,
    types: { binary: true },
  });
  return {
    db,
    async flushAndClose() {
      await db.close();
    },
  };
}

function formatCellText(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Uint8Array) {
    let hex = '0x';
    for (let i = 0; i < Math.min(val.byteLength, 32); i++) {
      hex += val[i]!.toString(16).padStart(2, '0');
    }
    if (val.byteLength > 32) hex += `…(${val.byteLength}B)`;
    return hex;
  }
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function jsonReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Uint8Array) {
    return Array.from(val);
  }
  return val;
}

/** Render query rows as a padded ASCII/Unicode box table. */
export function formatCliTable(
  fields: readonly FieldInfo[],
  rows: readonly Row[],
): string {
  const colNames =
    fields.length > 0
      ? fields.map((f) => f.name)
      : rows.length > 0
        ? Object.keys(rows[0]!)
        : [];
  if (colNames.length === 0) {
    return `(0 columns, ${rows.length} rows)\n`;
  }

  const widths = colNames.map((n) => n.length);
  const grid: string[][] = rows.map((row) =>
    colNames.map((col, idx) => {
      const cell = formatCellText(row[col]);
      if (cell.length > widths[idx]!) widths[idx] = cell.length;
      return cell;
    }),
  );

  const sep = '+-' + widths.map((w) => '-'.repeat(w)).join('-+-') + '-+';
  const header =
    '| ' + colNames.map((n, i) => n.padEnd(widths[i]!)).join(' | ') + ' |';
  const body = grid.map(
    (r) => '| ' + r.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |',
  );

  return [sep, header, sep, ...body, sep, `(${rows.length} row${rows.length === 1 ? '' : 's'})`, ''].join(
    '\n',
  );
}

/** Render query rows as RFC 4180 CSV with header row. */
export function formatCliCsv(
  fields: readonly FieldInfo[],
  rows: readonly Row[],
): string {
  const colNames =
    fields.length > 0
      ? fields.map((f) => f.name)
      : rows.length > 0
        ? Object.keys(rows[0]!)
        : [];
  if (colNames.length === 0) return '';
  let out = encodeCsvRow(colNames, ',', '"', '');
  for (const row of rows) {
    const vals = colNames.map((c) => row[c]);
    out += encodeCsvRow(vals, ',', '"', '');
  }
  return out;
}

function isSelectLike(sql: string): boolean {
  return /^\s*(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

function isMutatingStatement(sql: string): boolean {
  return !/^\s*(SELECT|SHOW|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

/**
 * Load sorted {@link Migration} definitions from a directory containing:
 *   - `<version>_<name>.sql` (with optional `-- @down` or `-- migrate:down` section)
 *   - `<version>_<name>.up.sql` + optional `<version>_<name>.down.sql`
 *   - `.json` files containing a `Migration` or `Migration[]`
 */
export async function loadMigrationsFromDirectory(
  dirPath: string,
): Promise<Migration[]> {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Migrations directory does not exist: ${dirPath}`);
  }
  const entries = fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
  const byVersion = new Map<
    number,
    { version: number; name?: string; up?: string | string[]; down?: string | string[] }
  >();

  for (const file of entries) {
    const fullPath = path.join(dirPath, file);
    if (!fs.statSync(fullPath).isFile()) continue;

    if (file.endsWith('.json')) {
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as
        | Migration
        | Migration[];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (typeof item.version !== 'number') {
          throw new Error(`Invalid migration version in ${file}`);
        }
        byVersion.set(item.version, {
          version: item.version,
          name: item.name,
          up: item.up as string | string[],
          down: item.down as string | string[] | undefined,
        });
      }
      continue;
    }

    if (!file.endsWith('.sql')) continue;

    const upDownMatch = /^(\d+)[_-]?(.*?)\.(up|down)\.sql$/i.exec(file);
    if (upDownMatch) {
      const version = Number(upDownMatch[1]);
      const name = upDownMatch[2] || `migration_${version}`;
      const kind = upDownMatch[3]!.toLowerCase() as 'up' | 'down';
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      const stmts = splitStatements(content)
        .map((s) => s.sql.trim())
        .filter(Boolean);
      const existing = byVersion.get(version) ?? { version, name };
      existing[kind] = stmts;
      byVersion.set(version, existing);
      continue;
    }

    const sqlMatch = /^(\d+)[_-]?(.*)\.sql$/i.exec(file);
    if (sqlMatch) {
      const version = Number(sqlMatch[1]);
      const name = sqlMatch[2] || `migration_${version}`;
      const content = fs.readFileSync(fullPath, 'utf8');
      const downSplit = content.split(/^\s*--\s*(?:@down|migrate:down)\b.*$/im);
      const upStmts = splitStatements((downSplit[0] ?? '').trim())
        .map((s) => s.sql.trim())
        .filter(Boolean);
      const downStmts =
        downSplit[1] !== undefined
          ? splitStatements(downSplit[1].trim())
              .map((s) => s.sql.trim())
              .filter(Boolean)
          : undefined;
      byVersion.set(version, {
        version,
        name,
        up: upStmts,
        ...(downStmts && downStmts.length > 0 ? { down: downStmts } : {}),
      });
    }
  }

  return Array.from(byVersion.values())
    .filter((m) => m.up !== undefined)
    .sort((a, b) => a.version - b.version)
    .map((m) => ({
      version: m.version,
      ...(m.name ? { name: m.name } : {}),
      up: m.up!,
      ...(m.down ? { down: m.down } : {}),
    }));
}

function stateCodeName(state: number): string {
  switch (state) {
    case 0:
      return 'FREE';
    case 1:
      return 'USED';
    case 2:
      return 'FULL';
    case 3:
      return 'ARCHIVABLE';
    default:
      return `UNKNOWN(${state})`;
  }
}

function opcodeLabel(opcode: number): string {
  const entries = Object.entries(FbChangelogOpcode) as Array<[string, number]>;
  for (const [k, v] of entries) {
    if (v === opcode) return k;
  }
  return `op_${opcode}`;
}

/**
 * Parse and summarize a binary Firebird `"FBCHANGELOG\0"` segment (supporting
 * both raw and gzip-compressed `.journal` files).
 */
export function inspectChangelogBuffer(rawBytes: Uint8Array): CliChangelogInspection {
  const bytes =
    rawBytes.byteLength >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b
      ? new Uint8Array(zlib.gunzipSync(rawBytes))
      : rawBytes;

  if (!isFbChangelogSegment(bytes)) {
    throw new Error(
      'Not a valid Firebird "FBCHANGELOG\\0" binary changelog segment.',
    );
  }

  const parsed = parseFbChangelogSegment(bytes);
  const ops = decodeFbChangelogOperations(parsed);

  const opcodeCounts: Record<string, number> = {};
  const txSet = new Set<number>();
  const opsPerBlockOffset = new Map<number, number>();

  for (const op of ops) {
    const label = opcodeLabel(op.opcode);
    opcodeCounts[label] = (opcodeCounts[label] ?? 0) + 1;
    if (op.traNumber > 0) txSet.add(op.traNumber);
    opsPerBlockOffset.set(
      op.blockOffset,
      (opsPerBlockOffset.get(op.blockOffset) ?? 0) + 1,
    );
  }

  return {
    magic: 'FBCHANGELOG\\0',
    version: parsed.header.version,
    sequence: Number(parsed.header.sequence),
    state: parsed.header.state,
    stateName: stateCodeName(parsed.header.state),
    guid: parsed.header.guid,
    blockCount: parsed.blocks.length,
    totalOperations: ops.length,
    transactions: Array.from(txSet).sort((a, b) => a - b),
    opcodeCounts,
    blocks: parsed.blocks.map((b, idx) => ({
      index: idx,
      traNumber: Number(b.traNumber),
      protocol: b.protocol,
      flags: b.flags,
      beginTrans: b.beginTrans,
      endTrans: b.endTrans,
      length: b.length,
      operationCount: opsPerBlockOffset.get(b.offset) ?? 0,
    })),
  };
}

interface ParsedFlags {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseCliArgs(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (
          next !== undefined &&
          !next.startsWith('-') &&
          (key === 'format' ||
            key === 'out' ||
            key === 'in' ||
            key === 'dir' ||
            key === 'target' ||
            key === 'backend' ||
            key === 'case')
        ) {
          flags.set(key, next);
          i += 1;
        } else {
          flags.set(key, true);
        }
      }
    } else if (arg === '-h') {
      flags.set('help', true);
    } else if (arg === '-v') {
      flags.set('version', true);
    } else if (arg === '-o' && argv[i + 1] !== undefined) {
      flags.set('out', argv[++i]!);
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

/**
 * Execute the `firebird-wasm` CLI with `argv` (excluding `node` and script path)
 * and return an OS exit code (`0` on success, `1` on error).
 */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = {},
): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s));
  const err = io.stderr ?? ((s: string) => process.stderr.write(s));
  const cwd = io.cwd ?? process.cwd();

  const { positional, flags } = parseCliArgs(argv);
  const cmd = positional[0]?.toLowerCase();

  if (flags.get('version') === true || cmd === 'version') {
    out(`${VERSION}\n`);
    return 0;
  }

  if (!cmd || flags.get('help') === true || cmd === 'help') {
    out(HELP_TEXT);
    return 0;
  }

  const backendFlag = flags.get('backend');
  const backend =
    backendFlag === 'wasm' || backendFlag === 'native' || backendFlag === 'auto'
      ? backendFlag
      : 'auto';

  try {
    switch (cmd) {
      case 'query': {
        const uri = positional[1];
        const sqlText = positional.slice(2).join(' ').trim();
        if (!uri || !sqlText) {
          err('Usage: firebird-wasm query <uri> <sql> [--format table|json|csv|jsonl]\n');
          return 1;
        }
        const format = String(flags.get('format') ?? 'table').toLowerCase();
        const stmts = splitStatements(sqlText);
        const mutated = stmts.some((s) => isMutatingStatement(s.sql));
        const managed = await openCliDatabase(uri, { cwd, backend });
        try {
          for (let i = 0; i < stmts.length; i++) {
            const stmt = stmts[i]!;
            if (isSelectLike(stmt.sql)) {
              const res = await managed.db.query<Row>(stmt.sql);
              if (format === 'json') {
                out(`${JSON.stringify(res.rows, jsonReplacer, 2)}\n`);
              } else if (format === 'jsonl' || format === 'ndjson') {
                const cols = res.fields.map((f) => f.name);
                for (const r of res.rows) {
                  out(encodeJsonlRow(res.fields, cols.map((c) => r[c])));
                }
              } else if (format === 'csv') {
                out(formatCliCsv(res.fields, res.rows));
              } else {
                out(formatCliTable(res.fields, res.rows));
              }
            } else {
              const execRes = await managed.db.execute(stmt.sql);
              if (format === 'json') {
                out(`${JSON.stringify(execRes)}\n`);
              } else {
                out(`OK (${execRes.affectedRows} row${execRes.affectedRows === 1 ? '' : 's'} affected)\n`);
              }
            }
          }
        } finally {
          await managed.flushAndClose(mutated);
        }
        return 0;
      }

      case 'codegen': {
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

      case 'migrate': {
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
          typeof targetRaw === 'string' && /^\d+$/.test(targetRaw)
            ? Number(targetRaw)
            : undefined;

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

      case 'dump': {
        const uri = positional[1];
        const outFile = flags.get('out');
        if (!uri || typeof outFile !== 'string') {
          err('Usage: firebird-wasm dump <uri> --out <file> [--gzip]\n');
          return 1;
        }
        const absOut = path.resolve(cwd, outFile);
        const managed = await openCliDatabase(uri, { cwd, backend, allowMissing: false });
        try {
          const rawBytes = await managed.db.dumpDataDir();
          const useGzip = flags.get('gzip') === true || absOut.endsWith('.gz');
          const payload = useGzip ? zlib.gzipSync(rawBytes) : rawBytes;
          fs.mkdirSync(path.dirname(absOut), { recursive: true });
          fs.writeFileSync(absOut, payload);
          out(`Dumped ${payload.byteLength} bytes -> ${absOut}\n`);
        } finally {
          await managed.flushAndClose(false);
        }
        return 0;
      }

      case 'restore': {
        const uri = positional[1];
        const inFile = flags.get('in');
        if (!uri || typeof inFile !== 'string') {
          err('Usage: firebird-wasm restore <uri> --in <file> [--gzip]\n');
          return 1;
        }
        const absIn = path.resolve(cwd, inFile);
        if (!fs.existsSync(absIn)) {
          err(`Input file not found: ${absIn}\n`);
          return 1;
        }
        const fileBuf = fs.readFileSync(absIn);
        const isGz =
          flags.get('gzip') === true ||
          absIn.endsWith('.gz') ||
          (fileBuf.byteLength >= 2 && fileBuf[0] === 0x1f && fileBuf[1] === 0x8b);
        const dbBytes = isGz
          ? new Uint8Array(zlib.gunzipSync(fileBuf))
          : new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);

        const localTarget = resolveLocalFilePath(uri, cwd);
        if (
          localTarget &&
          (backend === 'wasm' || (backend === 'auto' && !hasNativeFirebirdDriver()))
        ) {
          // Validate the restored image via WASM engine before writing atomically
          cliMemCounter += 1;
          const validator = new FirebirdBrowser(
            `memory://cli_restore_${process.pid}_${cliMemCounter}`,
            { threads: false, loadDataDir: dbBytes },
          );
          try {
            await validator.query('SELECT 1 FROM RDB$DATABASE');
            const verified = await validator.dumpDataDir();
            fs.mkdirSync(path.dirname(localTarget), { recursive: true });
            fs.writeFileSync(localTarget, verified);
          } finally {
            await validator.close();
          }
          out(`Restored ${dbBytes.byteLength} bytes -> ${localTarget}\n`);
          return 0;
        }

        const managed = await openCliDatabase(uri, { cwd, backend });
        try {
          await managed.db.restoreSnapshot(dbBytes);
          out(`Restored ${dbBytes.byteLength} bytes -> ${uri}\n`);
        } finally {
          await managed.flushAndClose(true);
        }
        return 0;
      }

      case 'inspect-changelog': {
        const fileArg = positional[1];
        if (!fileArg) {
          err('Usage: firebird-wasm inspect-changelog <file> [--json]\n');
          return 1;
        }
        const absFile = path.resolve(cwd, fileArg);
        if (!fs.existsSync(absFile)) {
          err(`Changelog file not found: ${absFile}\n`);
          return 1;
        }
        const raw = fs.readFileSync(absFile);
        const report = inspectChangelogBuffer(
          new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
        );
        if (flags.get('json') === true) {
          out(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          out(
            [
              `Firebird Changelog Segment: ${path.basename(absFile)}`,
              `  Version      : ${report.version}`,
              `  Sequence     : ${report.sequence}`,
              `  State        : ${report.stateName} (${report.state})`,
              `  Database GUID: ${report.guid}`,
              `  Blocks       : ${report.blockCount}`,
              `  Transactions : ${report.transactions.length > 0 ? report.transactions.join(', ') : '(none)'}`,
              `  Operations   : ${report.totalOperations}`,
              ...Object.entries(report.opcodeCounts).map(
                ([opName, count]) => `    - ${opName}: ${count}`,
              ),
              '',
            ].join('\n'),
          );
        }
        return 0;
      }

      case 'repl': {
        const uri = positional[1] ?? 'memory://repl';
        const managed = await openCliDatabase(uri, { cwd, backend });
        let dirty = false;
        out(`firebird-wasm v${VERSION} interactive SQL shell (${uri})\nType .help for commands, .quit to exit.\n`);

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
              out(cat.tables.map((t) => t.name).join('\n') + (cat.tables.length ? '\n' : '(no tables)\n'));
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

      default: {
        err(`Unknown command "${cmd}". Run "firebird-wasm --help" for usage.\n`);
        return 1;
      }
    }
  } catch (e) {
    err(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
