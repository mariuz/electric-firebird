/**
 * subset-ddl.ts – Automatic Schema DDL (`autoCreateTable` / `migrateColumns`) &
 * On-Demand / Progressive `subset__*` Snapshot Hydration for `firebird-wasm/electric` (`M31 Item 2`).
 */

import type { ElectricTransaction } from './apply';
import { applyEntries, defaultColumn } from './apply';
import type { ElectricColumn, ElectricSchema } from './values';
import { checkSchema, firebirdColumn, firebirdName, primaryKeyOf, tableFromSchema } from './values';

export type AutoCreateTableOption =
  | boolean
  | {
      /** Automatically add newly appearing columns via `ALTER TABLE <table> ADD <col> <type>`. @default true */
      readonly migrateColumns?: boolean;
    };

export type ElectricSyncMode = 'full' | 'progressive' | 'on-demand';

export interface SubsetSnapshotRequest {
  readonly where?: string;
  readonly params?: Record<string, string | number | boolean>;
  readonly orderBy?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly method?: 'GET' | 'POST';
}

function unquoteFirebirdIdent(quoted: string): string {
  const m = /^"((?:[^"]|"")+)"$/.exec(quoted.trim());
  if (m) return m[1]!.replace(/""/g, '"');
  return quoted.trim().toUpperCase();
}

function columnDdlTypeForAlter(info: ElectricColumn): string {
  if ((info.dims ?? 0) > 0) return 'BLOB SUB_TYPE TEXT';
  switch (info.type) {
    case 'int2':
      return 'SMALLINT';
    case 'int4':
      return 'INTEGER';
    case 'int8':
      return 'BIGINT';
    case 'numeric':
      return info.precision !== undefined
        ? `NUMERIC(${Math.min(info.precision, 38)}, ${info.scale ?? 0})`
        : 'DECFLOAT(34)';
    case 'decfloat':
      return 'DECFLOAT(34)';
    case 'float4':
      return 'FLOAT';
    case 'float8':
      return 'DOUBLE PRECISION';
    case 'bool':
      return 'BOOLEAN';
    case 'varchar':
      return info.max_length ? `VARCHAR(${info.max_length})` : 'BLOB SUB_TYPE TEXT';
    case 'bpchar':
      return `CHAR(${info.length ?? 1})`;
    case 'uuid':
      return 'VARCHAR(36)';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'timetz':
      return 'TIME WITH TIME ZONE';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'timestamptz':
      return 'TIMESTAMP WITH TIME ZONE';
    case 'bytea':
      return 'BLOB SUB_TYPE BINARY';
    default:
      return 'BLOB SUB_TYPE TEXT';
  }
}

/**
 * Ensure `tableName` exists (running `tableFromSchema` in its own DDL transaction
 * before data writes, because Firebird activates new tables on commit) and optionally
 * evolve newly added columns (`M31 Item 2`).
 */
export async function ensureTableFromElectricSchema(
  db: { transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T> },
  tableName: string,
  schema: ElectricSchema,
  option: AutoCreateTableOption,
  columnMapper?: Record<string, string>,
): Promise<{ created: boolean; addedColumns: string[] }> {
  if (!option) return { created: false, addedColumns: [] };
  checkSchema(schema);
  const migrateCols = typeof option === 'object' ? option.migrateColumns !== false : true;
  const quotedTable = firebirdName(tableName);
  const relName = unquoteFirebirdIdent(quotedTable);

  const exists = await db.transaction(async (tx) => {
    const res = await tx.query(
      'SELECT 1 AS X FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [relName],
    );
    return res.rows.length > 0;
  });

  if (!exists) {
    let ddl = tableFromSchema(tableName, schema);
    if (columnMapper) {
      for (const [pgCol, fbCol] of Object.entries(columnMapper)) {
        ddl = ddl.replace(firebirdColumn(pgCol), firebirdName(fbCol));
      }
    }
    await db.transaction(async (tx) => {
      await tx.exec(ddl);
    });
    return { created: true, addedColumns: [] };
  }

  if (!migrateCols) return { created: false, addedColumns: [] };

  const existingCols = await db.transaction(async (tx) => {
    const res = await tx.query(
      'SELECT TRIM(RDB$FIELD_NAME) AS C FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ?',
      [relName],
    );
    const set = new Set<string>();
    for (const r of res.rows) {
      const c = r['C'] ?? r['c'];
      if (c) set.add(String(c).trim());
    }
    return set;
  });

  const addedColumns: string[] = [];
  for (const [pgName, colInfo] of Object.entries(schema)) {
    const fbQuoted =
      columnMapper?.[pgName] !== undefined
        ? firebirdName(columnMapper[pgName]!)
        : firebirdColumn(pgName);
    const fbBare = unquoteFirebirdIdent(fbQuoted);
    if (!existingCols.has(fbBare) && !existingCols.has(fbBare.toUpperCase())) {
      const sqlType = columnDdlTypeForAlter(colInfo);
      await db.transaction(async (tx) => {
        await tx.exec(`ALTER TABLE ${quotedTable} ADD ${fbQuoted} ${sqlType}`);
      });
      addedColumns.push(fbBare);
    }
  }

  return { created: false, addedColumns };
}

/**
 * Fetch an on-demand `subset__*` snapshot from an Electric v1.1+ `/v1/shape` endpoint
 * and apply the returned rows atomically into `tableName` (`M31 Item 2`).
 */
export async function fetchAndApplyShapeSubset(opts: {
  db: { transaction<T>(fn: (tx: ElectricTransaction) => Promise<T>): Promise<T> };
  shapeUrl: string;
  shapeParams?: Record<string, unknown>;
  shapeHeaders?: Record<string, string>;
  fetchClient?: typeof fetch;
  table: string;
  columns?: Record<string, string>;
  primaryKey?: string[];
  knownSchema?: ElectricSchema;
  autoCreateTable?: AutoCreateTableOption;
  subset: SubsetSnapshotRequest;
  eventName?: string | null;
}): Promise<{ appliedRows: number; handle?: string; offset?: string; schema: ElectricSchema }> {
  const fetcher = opts.fetchClient ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const url = new URL(opts.shapeUrl, 'http://localhost');

  if (opts.shapeParams) {
    for (const [k, v] of Object.entries(opts.shapeParams)) {
      if (v === undefined || v === null) continue;
      if (k === 'columns' && Array.isArray(v)) {
        url.searchParams.set('columns', v.join(','));
      } else if (k === 'params' && typeof v === 'object') {
        url.searchParams.set('params', JSON.stringify(v));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const method = opts.subset.method ?? 'GET';
  const reqHeaders: Record<string, string> = { ...(opts.shapeHeaders ?? {}) };
  let body: string | undefined;

  if (method === 'POST') {
    reqHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify({
      where: opts.subset.where,
      params: opts.subset.params,
      orderBy: opts.subset.orderBy,
      limit: opts.subset.limit,
      offset: opts.subset.offset,
    });
  } else {
    url.searchParams.set('offset', '-1');
    if (opts.subset.where) url.searchParams.set('subset__where', opts.subset.where);
    if (opts.subset.params) {
      url.searchParams.set('subset__params', JSON.stringify(opts.subset.params));
    }
    if (opts.subset.orderBy) url.searchParams.set('subset__order_by', opts.subset.orderBy);
    if (opts.subset.limit !== undefined) {
      url.searchParams.set('subset__limit', String(opts.subset.limit));
    }
    if (opts.subset.offset !== undefined) {
      url.searchParams.set('subset__offset', String(opts.subset.offset));
    }
  }

  const res = await fetcher(url.toString(), { method, headers: reqHeaders, body });
  if (!res.ok) {
    throw new Error(`Subset snapshot request failed (${res.status}): ${await res.text()}`);
  }

  const schemaHeader = res.headers.get('electric-schema');
  const schema: ElectricSchema | undefined = schemaHeader
    ? (JSON.parse(schemaHeader) as ElectricSchema)
    : opts.knownSchema;
  if (!schema) {
    throw new Error('Subset snapshot response did not include an electric-schema header.');
  }

  if (opts.autoCreateTable) {
    await ensureTableFromElectricSchema(
      opts.db,
      opts.table,
      schema,
      opts.autoCreateTable,
      opts.columns,
    );
  }

  const json = (await res.json()) as
    | Array<{ headers?: { operation?: string }; value?: Record<string, unknown> }>
    | {
        data?: Array<{ headers?: { operation?: string }; value?: Record<string, unknown> }>;
      };
  const rawMessages = Array.isArray(json) ? json : (json.data ?? []);
  const entries = rawMessages
    .filter((m) => m.value && (!m.headers?.operation || m.headers.operation === 'insert' || m.headers.operation === 'update'))
    .map((m) => ({
      kind: 'insert' as const,
      value: m.value!,
    }));

  const pk = opts.primaryKey ?? primaryKeyOf(schema);
  if (pk.length === 0) {
    throw new Error(`Table ${opts.table} subset sync requires a primary key.`);
  }

  const quotedTable = firebirdName(opts.table);
  const colFn = (name: string) =>
    opts.columns?.[name] !== undefined ? firebirdName(opts.columns[name]!) : defaultColumn(name);

  if (entries.length > 0) {
    await opts.db.transaction(async (tx) => {
      await applyEntries(tx, { table: quotedTable, primaryKey: pk, column: colFn, schema }, entries);
      if (opts.eventName) {
        await tx.exec(
          'EXECUTE BLOCK (event_name VARCHAR(127) = ?) AS BEGIN POST_EVENT :event_name; END',
          [opts.eventName],
        );
      }
    });
  }

  return {
    appliedRows: entries.length,
    handle: res.headers.get('electric-handle') ?? undefined,
    offset: res.headers.get('electric-offset') ?? undefined,
    schema,
  };
}
