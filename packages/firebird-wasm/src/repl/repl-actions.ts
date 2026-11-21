/**
 * repl-actions.ts – Arrow Export/Import, Cell Editing, Materialized View Refresh &
 * Search Index Telemetry Helpers for `<firebird-repl>` (`M25 Item 5`).
 */

import { encodeArrowIpc, rowsToColumnarResult } from '../columnar';
import { splitStatements, type ScriptStatement } from '../browser/sql-script';
import { parseQueryPlan, type ParsedQueryPlan } from './plan-tree';
import type { ExplainOptions, MonitorStats } from '../types';
import { asError } from './repl-styles';
import {
  loadArrowIpcIntoDatabase,
  type ArrowIngestHost,
  type ArrowIngestResult,
  type ArrowIngestSource,
  type LoadArrowIpcOptions,
} from '../arrow-ingest';
import type { OptimisticMutationStore } from '../optimistic-store';
import type { UndoRedoManager } from '../undo-redo';
import {
  syncDatabaseSchema,
  type DeclarativeSchemaInput,
  type SchemaSyncResult,
} from '../schema-sync';
import { fetchReplMaterializedViews, fetchReplSchema } from './repl-inspectors';
import type { ReplDatabase, ReplEntry } from './index';

export interface ReplSearchIndexSummary {
  readonly kind: 'vector' | 'fts';
  readonly name: string;
  readonly tableName: string;
  readonly entryCount: number;
  readonly details: string;
}

export async function fetchReplSearchIndexes(
  db: ReplDatabase,
): Promise<ReplSearchIndexSummary[]> {
  const out: ReplSearchIndexSummary[] = [];
  try {
    const vecRel = await db.query(
      `SELECT 1 FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = 'FB_VECTOR_INDEX$'`,
      [],
      { rowMode: 'array' },
    );
    if (vecRel.rows.length > 0) {
      const res = await db.query(
        `SELECT "INDEX_NAME", "TABLE_NAME", "COLUMN_NAME", "METRIC", "GRAPH_JSON" FROM "FB_VECTOR_INDEX$" ORDER BY "INDEX_NAME"`,
        [],
        { rowMode: 'array' },
      );
      for (const r of res.rows) {
        let nodeCount = 0;
        let dims = 0;
        let quant = 'float32';
        try {
          const parsed = JSON.parse(String(r[4] ?? '{}')) as {
            dimensions?: number | null;
            quantization?: string;
            nodes?: unknown[];
          };
          nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
          dims = Number(parsed.dimensions ?? 0);
          if (parsed.quantization && parsed.quantization !== 'none') {
            quant = parsed.quantization;
          }
        } catch {
          // Ignore malformed JSON
        }
        out.push({
          kind: 'vector',
          name: String(r[0] ?? '').trim(),
          tableName: String(r[1] ?? '').trim(),
          entryCount: nodeCount,
          details: `HNSW (${String(r[2] ?? '').trim()}) · ${dims}d · ${String(r[3] ?? 'cosine').trim()} · ${quant}`,
        });
      }
    }
  } catch {
    // Optional vector index table
  }

  try {
    const ftsRel = await db.query(
      `SELECT 1 FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = 'FB_FTS_INDEX$'`,
      [],
      { rowMode: 'array' },
    );
    if (ftsRel.rows.length > 0) {
      const res = await db.query(
        `SELECT "INDEX_NAME", "TABLE_NAME", "COLUMNS_CSV", "INDEX_JSON" FROM "FB_FTS_INDEX$" ORDER BY "INDEX_NAME"`,
        [],
        { rowMode: 'array' },
      );
      for (const r of res.rows) {
        let docCount = 0;
        try {
          const parsed = JSON.parse(String(r[3] ?? '{}')) as { docs?: unknown[] };
          docCount = Array.isArray(parsed.docs) ? parsed.docs.length : 0;
        } catch {
          // Ignore malformed JSON
        }
        out.push({
          kind: 'fts',
          name: String(r[0] ?? '').trim(),
          tableName: String(r[1] ?? '').trim(),
          entryCount: docCount,
          details: `BM25 (${String(r[2] ?? '').trim()})`,
        });
      }
    }
  } catch {
    // Optional FTS index table
  }

  return out;
}

export async function executeReplSchemaDiff(
  db: ReplDatabase,
  desiredSource: DeclarativeSchemaInput,
  options: { dryRun?: boolean; allowDestructive?: boolean } = { dryRun: true },
): Promise<SchemaSyncResult> {
  return syncDatabaseSchema(
    desiredSource,
    {
      introspect: (opts) => fetchReplSchema(db, opts),
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const res = await db.query(sql, params, { rowMode: 'array' });
        const objRows = res.rows.map((cols) =>
          Object.fromEntries(res.fields.map((f, idx) => [f.name, cols[idx]])),
        ) as unknown as T[];
        return { fields: res.fields, rows: objRows };
      },
      exec: async (sql: string) => {
        if (typeof db.execute === 'function') {
          await db.execute(sql);
        } else {
          await db.transaction((tx) => tx.exec(sql));
        }
      },
    },
    options,
  );
}

export function triggerArrowBrowserDownload(bytes: Uint8Array): void {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blob = new Blob(
      [new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as BlobPart],
      { type: 'application/vnd.apache.arrow.stream' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query.arrow';
    a.click();
    URL.revokeObjectURL(url);
  }
}

export function stepReplHistoryKey(
  event: KeyboardEvent,
  editor: HTMLTextAreaElement,
  history: readonly string[],
  state: { cursor: number; draft: string },
  onRun: () => void,
): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    onRun();
    return;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const { value, selectionStart, selectionEnd } = editor;
  if (selectionStart !== selectionEnd) return;
  const onFirstLine = !value.slice(0, selectionStart).includes('\n');
  const onLastLine = !value.slice(selectionEnd).includes('\n');

  if (event.key === 'ArrowUp' && onFirstLine && state.cursor > 0) {
    if (state.cursor === history.length) state.draft = value;
    state.cursor--;
  } else if (
    event.key === 'ArrowDown' &&
    onLastLine &&
    state.cursor < history.length
  ) {
    state.cursor++;
  } else {
    return;
  }
  event.preventDefault();
  editor.value =
    state.cursor === history.length ? state.draft : history[state.cursor]!;
  const end = editor.value.length;
  editor.setSelectionRange(end, end);
}

export async function executeReplArrowExport(
  db: ReplDatabase,
  editorValue: string,
  sql?: string,
): Promise<{ targetSql: string; bytes: Uint8Array }> {
  const targetSql =
    (sql ?? editorValue ?? '').trim() || 'SELECT 1 AS SAMPLE_ID FROM RDB$DATABASE';
  let bytes: Uint8Array;
  if (typeof db.queryArrow === 'function') {
    bytes = await db.queryArrow(targetSql);
  } else {
    const res = await db.query(targetSql, [], { rowMode: 'array' });
    const rowsObj = res.rows.map((arr) => {
      const r: Record<string, unknown> = {};
      for (let i = 0; i < res.fields.length; i++) {
        r[res.fields[i]!.name] = arr[i];
      }
      return r;
    });
    bytes = encodeArrowIpc(rowsToColumnarResult({ rows: rowsObj, fields: res.fields }));
  }
  return { targetSql, bytes };
}

export async function executeReplArrowImport(
  db: ReplDatabase,
  tableName: string,
  source: ArrowIngestSource,
  options: LoadArrowIpcOptions = {},
): Promise<{ result: ArrowIngestResult; entry: ReplEntry }> {
  const started = performance.now();
  let result: ArrowIngestResult;
  if (typeof db.loadArrowIpc === 'function') {
    result = await db.loadArrowIpc(tableName, source, options);
  } else {
    const fallbackHost: ArrowIngestHost = {
      execute: async (s) => {
        const r = await db.transaction((tx) => tx.exec(s));
        return { affectedRows: r.affectedRows };
      },
      execBatch: async (s, rows) => {
        if (typeof db.execBatch === 'function') {
          return db.execBatch(s, rows);
        }
        let total = 0;
        for (const row of rows) {
          if (typeof db.execute === 'function') {
            const er = await db.execute(s, row);
            total += er.affectedRows;
          }
        }
        return { affectedRows: total };
      },
      query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) => {
        const arr = await db.query(s, p ?? [], { rowMode: 'array' });
        const objs = arr.rows.map((rowArr) => {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < arr.fields.length; i++) {
            obj[arr.fields[i]!.name] = rowArr[i];
          }
          return obj as T;
        });
        return { rows: objs };
      },
    };
    result = await loadArrowIpcIntoDatabase(fallbackHost, tableName, source, options);
  }
  return {
    result,
    entry: {
      sql: `IMPORT ARROW INTO "${result.tableName}"`,
      line: 1,
      ms: performance.now() - started,
      affectedRows: result.rowsIngested,
    },
  };
}

export async function executeReplCellEdit(
  db: ReplDatabase,
  undoRedoRef: UndoRedoManager | null,
  optStoreRef: OptimisticMutationStore | null,
  tableName: string,
  keyValue: unknown,
  column: string,
  newValue: unknown,
  primaryKey = 'ID',
): Promise<{ table: string; keyValue: unknown; column: string; value: unknown }> {
  const tblUpper = tableName.trim().toUpperCase();
  const colUpper = column.trim().toUpperCase();
  const pkUpper = primaryKey.trim().toUpperCase();
  const coerced: unknown =
    typeof newValue === 'string' && /^-?\d+$/.test(newValue.trim())
      ? Number(newValue.trim())
      : typeof newValue === 'string' && /^-?\d+\.\d+$/.test(newValue.trim())
        ? Number(newValue.trim())
        : newValue;

  if (undoRedoRef) {
    await undoRedoRef.update(tblUpper, keyValue, { [colUpper]: coerced }, { primaryKey: pkUpper });
  } else if (optStoreRef) {
    await optStoreRef.update(tblUpper, keyValue, { [colUpper]: coerced }, { primaryKey: pkUpper });
  } else if (typeof db.execute === 'function') {
    await db.execute(
      `UPDATE "${tblUpper.replace(/"/g, '""')}" SET "${colUpper.replace(/"/g, '""')}" = ? WHERE "${pkUpper.replace(/"/g, '""')}" = ?`,
      [coerced, keyValue],
    );
  } else {
    await db.query(
      `UPDATE "${tblUpper.replace(/"/g, '""')}" SET "${colUpper.replace(/"/g, '""')}" = ? WHERE "${pkUpper.replace(/"/g, '""')}" = ?`,
      [coerced, keyValue],
      { rowMode: 'array' },
    );
  }

  return { table: tblUpper, keyValue, column: colUpper, value: coerced };
}

export async function executeReplMatViewRefresh(
  db: ReplDatabase,
  name: string,
): Promise<ReplEntry | null> {
  const started = performance.now();
  const views = await fetchReplMaterializedViews(db);
  const target = views.find((v) => v.name.toUpperCase() === name.trim().toUpperCase());
  if (!target) {
    throw new Error(`Materialized view '${name}' not found in FB_MATVIEWS$`);
  }
  const quoted = `"${target.name.replace(/"/g, '""')}"`;
  if (typeof db.execute === 'function') {
    await db.execute(`DELETE FROM ${quoted}`);
    await db.execute(`INSERT INTO ${quoted} ${target.selectSql}`);
    const cnt = await db.query(`SELECT COUNT(*) FROM ${quoted}`, [], { rowMode: 'array' });
    const nextRows = Number(cnt.rows[0]?.[0] ?? 0);
    const dur = performance.now() - started;
    await db.execute(
      `UPDATE "FB_MATVIEWS$" SET "ROW_COUNT" = ?, "LAST_REFRESHED_AT" = ?, "LAST_DURATION_MS" = ? WHERE "VIEW_NAME" = ?`,
      [nextRows, Date.now(), dur, target.name],
    );
    return {
      sql: `REFRESH MATERIALIZED VIEW ${quoted}`,
      line: 1,
      ms: dur,
      affectedRows: nextRows,
    };
  }
  return null;
}

export async function executeReplScriptBatch(
  db: ReplDatabase,
  text: string,
  onEntry: (entry: ReplEntry) => void,
): Promise<ReplEntry[]> {
  const entries: ReplEntry[] = [];
  let statements: ScriptStatement[];
  try {
    statements = splitStatements(text);
  } catch (err) {
    const entry: ReplEntry = {
      sql: text.trim(),
      line: 1,
      ms: 0,
      error: asError(err),
    };
    entries.push(entry);
    onEntry(entry);
    return entries;
  }

  for (const statement of statements) {
    const started = performance.now();
    const entry: ReplEntry = {
      sql: statement.sql,
      line: statement.line,
      ms: 0,
    };
    try {
      const { hasResultSet } = await db.describeQuery(statement.sql);
      if (hasResultSet) {
        const result = await db.query(statement.sql, [], { rowMode: 'array' });
        entry.fields = result.fields;
        entry.rows = result.rows;
      } else {
        entry.affectedRows = (
          await db.transaction((tx) => tx.exec(statement.sql))
        ).affectedRows;
      }
    } catch (err) {
      entry.error = asError(err);
    }
    entry.ms = performance.now() - started;
    entries.push(entry);
    onEntry(entry);
    if (entry.error) break;
  }
  return entries;
}

export async function executeReplExplainBatch(
  db: ReplDatabase,
  text: string,
  options: ExplainOptions | undefined,
  lastStats: MonitorStats | null,
  onEntry: (entry: ReplEntry) => void,
): Promise<{
  entries: ReplEntry[];
  explainedPlans: Array<{ sql: string; parsed: ParsedQueryPlan }>;
}> {
  const entries: ReplEntry[] = [];
  let statements: ScriptStatement[];
  try {
    statements = splitStatements(text);
  } catch (err) {
    const entry: ReplEntry = {
      sql: text.trim(),
      line: 1,
      ms: 0,
      error: asError(err),
    };
    entries.push(entry);
    onEntry(entry);
    return { entries, explainedPlans: [] };
  }

  const explainedPlans: Array<{ sql: string; parsed: ParsedQueryPlan }> = [];
  for (const statement of statements) {
    const started = performance.now();
    const entry: ReplEntry = {
      sql: statement.sql,
      line: statement.line,
      ms: 0,
    };
    try {
      entry.plan = await db.explain!(statement.sql, options);
      entry.planTree = parseQueryPlan(entry.plan, lastStats);
      explainedPlans.push({
        sql: statement.sql,
        parsed: entry.planTree,
      });
    } catch (err) {
      entry.error = asError(err);
    }
    entry.ms = performance.now() - started;
    entries.push(entry);
    onEntry(entry);
    if (entry.error) break;
  }
  return { entries, explainedPlans };
}
