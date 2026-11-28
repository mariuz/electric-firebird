/**
 * auto-api-gateway.ts – Zero-Code Introspected GraphQL (`POST /graphql`, DataLoader
 * FK batching without N+1 queries), REST CRUD (`/rest/<table>`), JWT `rls` Enforcement
 * & OpenAPI 3.1 Schema Generator (`GET /openapi.json`) (`M30 Item 3`).
 */

import { introspect as introspectCatalog } from './browser/schema';
import {
  verifySyncJwt,
  type JwksKeyProvider,
  type SyncJwtClaims,
} from './replication/jwt-auth';
import type {
  IntrospectOptions,
  QueryParams,
  QueryResult,
  Row,
  SchemaIntrospection,
  TableSchemaInfo,
} from './types';

export interface AutoApiDatabase {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  introspect?(options?: IntrospectOptions): Promise<SchemaIntrospection>;
}

export interface AutoApiGatewayOptions {
  readonly apiKey?: string;
  readonly jwtSecret?: string | Uint8Array;
  readonly jwksProvider?: JwksKeyProvider;
  readonly readOnly?: boolean;
  readonly allowedTables?: readonly string[];
  readonly maxLimit?: number;
  readonly corsOrigin?: string;
  readonly title?: string;
}

export interface AutoApiGatewayHandle {
  fetch(request: Request): Promise<Response>;
  getGraphqlSdl(): Promise<string>;
  getOpenApiSpec(): Promise<Record<string, unknown>>;
  refreshSchema(): Promise<void>;
}

interface RelationLink {
  readonly fieldName: string;
  readonly kind: 'many-to-one' | 'one-to-many';
  readonly localCol: string;
  readonly remoteTable: TableSchemaInfo;
  readonly remoteCol: string;
}

interface GqlFieldNode {
  readonly alias: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly children: GqlFieldNode[];
}

function qApiIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function toCamel(ident: string): string {
  const parts = ident.toLowerCase().split('_').filter(Boolean);
  if (parts.length === 0) return ident.toLowerCase();
  return (
    parts[0]! +
    parts
      .slice(1)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join('')
  );
}

function toPascal(ident: string): string {
  const c = toCamel(ident);
  return c ? c[0]!.toUpperCase() + c.slice(1) : ident;
}

function apiCol(row: Record<string, unknown>, colUpper: string): unknown {
  if (colUpper in row) return row[colUpper];
  const lower = colUpper.toLowerCase();
  if (lower in row) return row[lower];
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === colUpper) return row[k];
  }
  return undefined;
}

async function execApiSql(
  db: AutoApiDatabase,
  sql: string,
  params: QueryParams = [],
): Promise<number> {
  if (typeof db.execute === 'function') {
    const r = await db.execute(sql, params);
    return r.affectedRows;
  }
  if (typeof db.exec === 'function') {
    await db.exec(sql, params);
    return 1;
  }
  await db.query(sql, params);
  return 1;
}

function mapFbTypeToGraphql(typeName: string): string {
  const u = typeName.toUpperCase();
  if (u.includes('INT') || u === 'SHORT' || u === 'LONG') return 'Int';
  if (u.includes('FLOAT') || u.includes('DOUBLE') || u.includes('NUMERIC') || u.includes('DECIMAL')) {
    return 'Float';
  }
  if (u.includes('BOOL')) return 'Boolean';
  return 'String';
}

function mapFbTypeToOpenApi(typeName: string): { type: string; format?: string } {
  const g = mapFbTypeToGraphql(typeName);
  if (g === 'Int') return { type: 'integer' };
  if (g === 'Float') return { type: 'number' };
  if (g === 'Boolean') return { type: 'boolean' };
  return { type: 'string' };
}

// ---------------------------------------------------------------------------
// Minimal Recursive-Descent GraphQL Document Parser (Zero Dependencies)
// ---------------------------------------------------------------------------

interface GqlToken {
  readonly kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'var';
  readonly value: string;
}

function tokenizeGraphql(src: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if ('{}():=[]!'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          j += 2;
        } else {
          out += src[j]!;
          j++;
        }
      }
      i = j + 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/-|\d/.test(ch)) {
      let j = i + (ch === '-' ? 1 : 0);
      let isFloat = false;
      while (j < src.length && /[\d.]/.test(src[j]!)) {
        if (src[j] === '.') isFloat = true;
        j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected GraphQL character "${ch}" at offset ${i}`);
  }
  return tokens;
}

function parseGraphqlDocument(
  queryText: string,
  variables: Readonly<Record<string, unknown>> = {},
): { operation: 'query' | 'mutation'; fields: GqlFieldNode[] } {
  const tokens = tokenizeGraphql(queryText);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++]!;
  const expectPunct = (p: string) => {
    const t = next();
    if (!t || t.kind !== 'punct' || t.value !== p) {
      throw new Error(`Expected GraphQL "${p}", got "${t?.value ?? 'EOF'}"`);
    }
  };

  const parseValue = (): unknown => {
    const t = next();
    if (!t) throw new Error('Unexpected EOF in GraphQL value');
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return Number(t.value);
    if (t.kind === 'float') return Number(t.value);
    if (t.kind === 'var') return variables[t.value];
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value;
    }
    if (t.kind === 'punct' && t.value === '[') {
      const arr: unknown[] = [];
      while (peek() && !(peek()!.kind === 'punct' && peek()!.value === ']')) {
        arr.push(parseValue());
      }
      expectPunct(']');
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (peek() && !(peek()!.kind === 'punct' && peek()!.value === '}')) {
        const keyTok = next();
        expectPunct(':');
        obj[keyTok.value] = parseValue();
      }
      expectPunct('}');
      return obj;
    }
    throw new Error(`Unsupported GraphQL token "${t.value}"`);
  };

  const parseSelectionSet = (): GqlFieldNode[] => {
    expectPunct('{');
    const fields: GqlFieldNode[] = [];
    while (peek() && !(peek()!.kind === 'punct' && peek()!.value === '}')) {
      const first = next();
      const alias = first.value;
      let name = first.value;
      if (peek()?.kind === 'punct' && peek()!.value === ':') {
        next();
        name = next().value;
      }
      const args: Record<string, unknown> = {};
      if (peek()?.kind === 'punct' && peek()!.value === '(') {
        next();
        while (peek() && !(peek()!.kind === 'punct' && peek()!.value === ')')) {
          const argName = next().value;
          expectPunct(':');
          args[argName] = parseValue();
        }
        expectPunct(')');
      }
      let children: GqlFieldNode[] = [];
      if (peek()?.kind === 'punct' && peek()!.value === '{') {
        children = parseSelectionSet();
      }
      fields.push({ alias, name, args, children });
    }
    expectPunct('}');
    return fields;
  };

  let operation: 'query' | 'mutation' = 'query';
  if (peek()?.kind === 'name' && (peek()!.value === 'query' || peek()!.value === 'mutation')) {
    operation = next().value as 'query' | 'mutation';
    if (peek()?.kind === 'name') next(); // optional operation name
    if (peek()?.kind === 'punct' && peek()!.value === '(') {
      let depth = 1;
      next();
      while (pos < tokens.length && depth > 0) {
        const tk = next();
        if (tk.kind === 'punct' && tk.value === '(') depth++;
        else if (tk.kind === 'punct' && tk.value === ')') depth--;
      }
    }
  }
  const fields = parseSelectionSet();
  return { operation, fields };
}

/**
 * Create a zero-code introspected GraphQL (`POST /graphql`), REST (`/rest/<table>`),
 * & OpenAPI 3.1 (`GET /openapi.json`) gateway over Firebird (`M30 Item 3`).
 */
export function createAutoApiGateway(
  db: AutoApiDatabase,
  options: AutoApiGatewayOptions = {},
): AutoApiGatewayHandle {
  const maxLimit = Math.max(1, options.maxLimit ?? 500);
  const corsOrigin = options.corsOrigin ?? '*';
  const allowedSet = options.allowedTables?.length
    ? new Set(options.allowedTables.map((t) => t.trim().toUpperCase()))
    : null;

  let cachedSchema: SchemaIntrospection | null = null;
  let relationsByTable = new Map<string, RelationLink[]>();

  const loadSchema = async (): Promise<SchemaIntrospection> => {
    if (cachedSchema) return cachedSchema;
    const raw =
      typeof db.introspect === 'function'
        ? await db.introspect()
        : await introspectCatalog({
            query: (s, p) => db.query(s, p),
            exec: async (s, p) => (db.exec ? db.exec(s, p) : db.execute!(s, p)),
          });
    const filteredTables = allowedSet
      ? raw.tables.filter((t) => allowedSet.has(t.name.toUpperCase()))
      : raw.tables;
    cachedSchema = { ...raw, tables: filteredTables };

    const tblMap = new Map<string, TableSchemaInfo>();
    for (const t of filteredTables) tblMap.set(t.name.toUpperCase(), t);

    const relMap = new Map<string, RelationLink[]>();
    for (const t of filteredTables) relMap.set(t.name.toUpperCase(), []);

    for (const t of filteredTables) {
      for (const fk of t.foreignKeys) {
        const localCol = fk.columns[0]?.toUpperCase();
        const remoteCol = fk.referencedColumns[0]?.toUpperCase();
        const remoteTbl = tblMap.get(fk.referencedTableName.toUpperCase());
        if (!localCol || !remoteCol || !remoteTbl) continue;

        const m2oBase = localCol.replace(/_ID$/i, '');
        const m2oField = toCamel(m2oBase || remoteTbl.name);
        relMap.get(t.name.toUpperCase())!.push({
          fieldName: m2oField,
          kind: 'many-to-one',
          localCol,
          remoteTable: remoteTbl,
          remoteCol,
        });

        const o2mField = `${toCamel(t.name)}List`;
        relMap.get(remoteTbl.name.toUpperCase())!.push({
          fieldName: o2mField,
          kind: 'one-to-many',
          localCol: remoteCol,
          remoteTable: t,
          remoteCol: localCol,
        });
      }
    }
    relationsByTable = relMap;
    return cachedSchema;
  };

  const resolveColumnName = (tbl: TableSchemaInfo, inputKey: string): string | null => {
    const upper = inputKey.toUpperCase();
    for (const c of tbl.columns) {
      if (c.name.toUpperCase() === upper || toCamel(c.name) === inputKey) {
        return c.name.toUpperCase();
      }
    }
    return null;
  };

  const buildWhereSql = (
    tbl: TableSchemaInfo,
    whereObj: Record<string, unknown> | undefined,
    rlsClaims: SyncJwtClaims['rls'] | undefined,
  ): { sql: string; params: unknown[] } => {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (whereObj) {
      for (const [k, val] of Object.entries(whereObj)) {
        const col = resolveColumnName(tbl, k);
        if (!col) continue;
        if (val === null) {
          clauses.push(`${qApiIdent(col)} IS NULL`);
        } else if (Array.isArray(val)) {
          if (val.length === 0) {
            clauses.push('1 = 0');
          } else {
            clauses.push(`${qApiIdent(col)} IN (${val.map(() => '?').join(', ')})`);
            params.push(...val);
          }
        } else if (typeof val === 'object') {
          const ops = val as Record<string, unknown>;
          if ('eq' in ops) {
            clauses.push(`${qApiIdent(col)} = ?`);
            params.push(ops.eq);
          }
          if ('gt' in ops) {
            clauses.push(`${qApiIdent(col)} > ?`);
            params.push(ops.gt);
          }
          if ('gte' in ops) {
            clauses.push(`${qApiIdent(col)} >= ?`);
            params.push(ops.gte);
          }
          if ('lt' in ops) {
            clauses.push(`${qApiIdent(col)} < ?`);
            params.push(ops.lt);
          }
          if ('lte' in ops) {
            clauses.push(`${qApiIdent(col)} <= ?`);
            params.push(ops.lte);
          }
          if ('contains' in ops) {
            clauses.push(`${qApiIdent(col)} CONTAINING ?`);
            params.push(String(ops.contains));
          }
        } else {
          clauses.push(`${qApiIdent(col)} = ?`);
          params.push(val);
        }
      }
    }

    const tblRls = rlsClaims?.[tbl.name.toUpperCase()] ?? rlsClaims?.[tbl.name.toLowerCase()];
    if (tblRls) {
      for (const [colRaw, rlsVal] of Object.entries(tblRls)) {
        const col = resolveColumnName(tbl, colRaw);
        if (!col) continue;
        if (Array.isArray(rlsVal)) {
          clauses.push(`${qApiIdent(col)} IN (${rlsVal.map(() => '?').join(', ')})`);
          params.push(...rlsVal);
        } else {
          clauses.push(`${qApiIdent(col)} = ?`);
          params.push(rlsVal);
        }
      }
    }

    return {
      sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  };

  const assertRlsWriteAllowed = (
    tbl: TableSchemaInfo,
    obj: Record<string, unknown>,
    rlsClaims: SyncJwtClaims['rls'] | undefined,
  ): string | null => {
    const tblRls = rlsClaims?.[tbl.name.toUpperCase()] ?? rlsClaims?.[tbl.name.toLowerCase()];
    if (!tblRls) return null;
    for (const [colRaw, expected] of Object.entries(tblRls)) {
      const col = resolveColumnName(tbl, colRaw);
      if (!col) continue;
      const providedKey = Object.keys(obj).find((k) => resolveColumnName(tbl, k) === col);
      if (providedKey === undefined) {
        return `RLS requires column "${col}" on table "${tbl.name}".`;
      }
      const actual = obj[providedKey];
      const ok = Array.isArray(expected) ? expected.includes(actual as never) : actual === expected;
      if (!ok) {
        return `RLS policy violation on "${tbl.name}.${col}".`;
      }
    }
    return null;
  };

  // DataLoader-style batched relation projection (0 N+1 queries!)
  const projectRows = async (
    tbl: TableSchemaInfo,
    rows: Array<Record<string, unknown>>,
    selections: readonly GqlFieldNode[],
    rlsClaims: SyncJwtClaims['rls'] | undefined,
  ): Promise<Array<Record<string, unknown>>> => {
    if (rows.length === 0) return [];
    const rels = relationsByTable.get(tbl.name.toUpperCase()) ?? [];

    // Pre-batch every selected FK relation in ONE `WHERE col IN (...)` query per relation
    const batchedRelMaps = new Map<string, Map<string, Array<Record<string, unknown>>>>();
    for (const sel of selections) {
      if (sel.children.length === 0) continue;
      const rel = rels.find(
        (r) =>
          r.fieldName.toLowerCase() === sel.name.toLowerCase() ||
          r.remoteTable.name.toLowerCase() === sel.name.toLowerCase(),
      );
      if (!rel) continue;

      const joinKeys = [
        ...new Set(
          rows
            .map((r) => apiCol(r, rel.localCol))
            .filter((v) => v !== null && v !== undefined),
        ),
      ];
      const grouped = new Map<string, Array<Record<string, unknown>>>();
      if (joinKeys.length > 0) {
        const w = buildWhereSql(
          rel.remoteTable,
          { [rel.remoteCol]: joinKeys },
          rlsClaims,
        );
        const relRes = await db.query<Record<string, unknown>>(
          `SELECT * FROM ${qApiIdent(rel.remoteTable.name)}${w.sql}`,
          w.params,
        );
        const projectedChildren = await projectRows(
          rel.remoteTable,
          relRes.rows,
          sel.children,
          rlsClaims,
        );
        relRes.rows.forEach((rawChild, idx) => {
          const k = String(apiCol(rawChild, rel.remoteCol));
          const list = grouped.get(k) ?? [];
          list.push(projectedChildren[idx]!);
          grouped.set(k, list);
        });
      }
      batchedRelMaps.set(sel.alias, grouped);
    }

    return rows.map((raw) => {
      if (selections.length === 0) {
        const full: Record<string, unknown> = {};
        for (const c of tbl.columns) full[toCamel(c.name)] = apiCol(raw, c.name);
        return full;
      }
      const out: Record<string, unknown> = {};
      for (const sel of selections) {
        if (sel.name === '__typename') {
          out[sel.alias] = toPascal(tbl.name);
          continue;
        }
        const col = resolveColumnName(tbl, sel.name);
        if (col && sel.children.length === 0) {
          const v = apiCol(raw, col);
          out[sel.alias] = typeof v === 'string' ? v.trimEnd() : v;
          continue;
        }
        const rel = rels.find(
          (r) =>
            r.fieldName.toLowerCase() === sel.name.toLowerCase() ||
            r.remoteTable.name.toLowerCase() === sel.name.toLowerCase(),
        );
        if (rel) {
          const k = String(apiCol(raw, rel.localCol));
          const matches = batchedRelMaps.get(sel.alias)?.get(k) ?? [];
          out[sel.alias] = rel.kind === 'many-to-one' ? (matches[0] ?? null) : matches;
        }
      }
      return out;
    });
  };

  const authorize = async (
    req: Request,
  ): Promise<{ ok: boolean; claims?: SyncJwtClaims; error?: string }> => {
    const needsAuth = Boolean(options.apiKey || options.jwtSecret || options.jwksProvider);
    if (!needsAuth) return { ok: true };
    const xKey = req.headers.get('x-api-key')?.trim();
    const auth = req.headers.get('authorization')?.trim() ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const token = bearer || xKey || '';
    if (!token) return { ok: false, error: 'Missing Authorization Bearer token or X-Api-Key.' };

    if (options.apiKey && token === options.apiKey) return { ok: true };
    try {
      if (options.jwksProvider) {
        return { ok: true, claims: await verifySyncJwt(token, options.jwksProvider) };
      }
      if (options.jwtSecret) {
        return { ok: true, claims: await verifySyncJwt(token, options.jwtSecret) };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Invalid JWT' };
    }
    return { ok: false, error: 'Invalid credentials.' };
  };

  const corsHeaders = (): Record<string, string> => ({
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Api-Key, Content-Type',
  });

  const jsonResp = (status: number, body: unknown): Response =>
    new Response(
      JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      {
        status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
      },
    );

  return {
    async refreshSchema(): Promise<void> {
      cachedSchema = null;
      await loadSchema();
    },

    async getGraphqlSdl(): Promise<string> {
      const schema = await loadSchema();
      const lines: string[] = [];
      for (const t of schema.tables) {
        const typeName = toPascal(t.name);
        lines.push(`type ${typeName} {`);
        for (const c of t.columns) {
          lines.push(`  ${toCamel(c.name)}: ${mapFbTypeToGraphql(c.typeName)}${c.nullable ? '' : '!'}`);
        }
        for (const r of relationsByTable.get(t.name.toUpperCase()) ?? []) {
          const targetType = toPascal(r.remoteTable.name);
          lines.push(
            `  ${r.fieldName}: ${r.kind === 'many-to-one' ? targetType : `[${targetType}!]!`}`,
          );
        }
        lines.push(`}`, ``);
      }
      lines.push(`type Query {`);
      for (const t of schema.tables) {
        const p = toPascal(t.name);
        lines.push(`  ${toCamel(t.name)}(limit: Int, offset: Int, orderBy: String): [${p}!]!`);
        lines.push(`  ${toCamel(t.name)}ByPk(id: String!): ${p}`);
      }
      lines.push(`}`);
      return lines.join('\n');
    },

    async getOpenApiSpec(): Promise<Record<string, unknown>> {
      const schema = await loadSchema();
      const paths: Record<string, unknown> = {};
      const schemas: Record<string, unknown> = {};

      for (const t of schema.tables) {
        const props: Record<string, unknown> = {};
        for (const c of t.columns) {
          props[c.name] = mapFbTypeToOpenApi(c.typeName);
        }
        const modelName = toPascal(t.name);
        schemas[modelName] = { type: 'object', properties: props };
        const basePath = `/rest/${t.name.toLowerCase()}`;
        paths[basePath] = {
          get: { summary: `List ${t.name}`, responses: { '200': { description: 'OK' } } },
          post: { summary: `Insert ${t.name}`, responses: { '201': { description: 'Created' } } },
        };
        paths[`${basePath}/{id}`] = {
          get: { summary: `Get ${t.name} by PK`, responses: { '200': { description: 'OK' } } },
          patch: { summary: `Update ${t.name}`, responses: { '200': { description: 'OK' } } },
          delete: { summary: `Delete ${t.name}`, responses: { '200': { description: 'OK' } } },
        };
      }

      return {
        openapi: '3.1.0',
        info: { title: options.title ?? 'Firebird Auto-API Gateway', version: '1.0.0' },
        paths,
        components: { schemas },
      };
    },

    async fetch(request: Request): Promise<Response> {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (request.method === 'GET' && pathname === '/openapi.json') {
        return jsonResp(200, await this.getOpenApiSpec());
      }
      if (request.method === 'GET' && pathname === '/graphql/sdl') {
        return new Response(await this.getGraphqlSdl(), {
          status: 200,
          headers: { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const auth = await authorize(request);
      if (!auth.ok) return jsonResp(401, { error: auth.error ?? 'Unauthorized' });
      const isReadOnly =
        Boolean(options.readOnly) ||
        auth.claims?.role === 'reader' ||
        (auth.claims?.role as string | undefined) === 'readonly';

      const schema = await loadSchema();
      const findTable = (rawName: string): TableSchemaInfo | undefined => {
        const lower = rawName.toLowerCase();
        return schema.tables.find(
          (t) => t.name.toLowerCase() === lower || toCamel(t.name).toLowerCase() === lower,
        );
      };

      try {
        // 1. GraphQL Endpoint (`POST /graphql`)
        if (pathname === '/graphql' && request.method === 'POST') {
          const body = (await request.json()) as {
            query?: string;
            variables?: Record<string, unknown>;
          };
          const doc = parseGraphqlDocument(String(body.query ?? ''), body.variables ?? {});
          if (doc.operation === 'mutation' && isReadOnly) {
            return jsonResp(403, { errors: [{ message: 'Mutations forbidden in read-only mode.' }] });
          }

          const data: Record<string, unknown> = {};
          for (const rootField of doc.fields) {
            if (doc.operation === 'query') {
              const isByPk = /ByPk$/i.test(rootField.name);
              const tblKey = isByPk ? rootField.name.replace(/ByPk$/i, '') : rootField.name;
              const tbl = findTable(tblKey);
              if (!tbl) {
                return jsonResp(400, { errors: [{ message: `Unknown query field "${rootField.name}"` }] });
              }
              const pkCol = (tbl.primaryKey?.[0] ?? tbl.columns[0]?.name ?? 'ID').toUpperCase();
              if (isByPk) {
                const pkVal = rootField.args.id ?? rootField.args[toCamel(pkCol)];
                const w = buildWhereSql(tbl, { [pkCol]: pkVal }, auth.claims?.rls);
                const res = await db.query<Record<string, unknown>>(
                  `SELECT FIRST 1 * FROM ${qApiIdent(tbl.name)}${w.sql}`,
                  w.params,
                );
                const proj = await projectRows(tbl, res.rows, rootField.children, auth.claims?.rls);
                data[rootField.alias] = proj[0] ?? null;
              } else {
                const limit = Math.min(maxLimit, Math.max(1, Number(rootField.args.limit ?? 100)));
                const offset = Math.max(0, Number(rootField.args.offset ?? 0));
                const w = buildWhereSql(
                  tbl,
                  rootField.args.where as Record<string, unknown> | undefined,
                  auth.claims?.rls,
                );
                let orderSql = ` ORDER BY ${qApiIdent(pkCol)} ASC`;
                if (typeof rootField.args.orderBy === 'string') {
                  const [oColRaw, oDirRaw] = rootField.args.orderBy.trim().split(/\s+/);
                  const oCol = oColRaw ? resolveColumnName(tbl, oColRaw) : null;
                  if (oCol) {
                    const dir = oDirRaw?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                    orderSql = ` ORDER BY ${qApiIdent(oCol)} ${dir}`;
                  }
                }
                const res = await db.query<Record<string, unknown>>(
                  `SELECT FIRST ${limit} SKIP ${offset} * FROM ${qApiIdent(tbl.name)}${w.sql}${orderSql}`,
                  w.params,
                );
                data[rootField.alias] = await projectRows(
                  tbl,
                  res.rows,
                  rootField.children,
                  auth.claims?.rls,
                );
              }
            } else {
              // Mutation: insert<Table>, update<Table>, delete<Table>
              const mMatch = /^(insert|update|delete)(.+)$/i.exec(rootField.name);
              if (!mMatch) {
                return jsonResp(400, { errors: [{ message: `Unknown mutation "${rootField.name}"` }] });
              }
              const verb = mMatch[1]!.toLowerCase();
              const tbl = findTable(mMatch[2]!);
              if (!tbl) {
                return jsonResp(400, { errors: [{ message: `Unknown table in "${rootField.name}"` }] });
              }
              const pkCol = (tbl.primaryKey?.[0] ?? tbl.columns[0]?.name ?? 'ID').toUpperCase();

              if (verb === 'insert') {
                const obj = (rootField.args.object ?? rootField.args.input ?? {}) as Record<
                  string,
                  unknown
                >;
                const rlsErr = assertRlsWriteAllowed(tbl, obj, auth.claims?.rls);
                if (rlsErr) return jsonResp(403, { errors: [{ message: rlsErr }] });

                const cols: string[] = [];
                const vals: unknown[] = [];
                for (const [k, v] of Object.entries(obj)) {
                  const col = resolveColumnName(tbl, k);
                  if (col) {
                    cols.push(qApiIdent(col));
                    vals.push(v);
                  }
                }
                const insRes = await db.query<Record<string, unknown>>(
                  `INSERT INTO ${qApiIdent(tbl.name)} (${cols.join(', ')})
                   VALUES (${cols.map(() => '?').join(', ')})
                   RETURNING *`,
                  vals,
                );
                const proj = await projectRows(tbl, insRes.rows, rootField.children, auth.claims?.rls);
                data[rootField.alias] = proj[0] ?? null;
              } else if (verb === 'update') {
                const pkVal = rootField.args.pk ?? rootField.args.id;
                const setObj = (rootField.args.set ??
                  rootField.args.input ??
                  rootField.args.object ??
                  {}) as Record<string, unknown>;
                const sets: string[] = [];
                const vals: unknown[] = [];
                for (const [k, v] of Object.entries(setObj)) {
                  const col = resolveColumnName(tbl, k);
                  if (col) {
                    sets.push(`${qApiIdent(col)} = ?`);
                    vals.push(v);
                  }
                }
                const w = buildWhereSql(tbl, { [pkCol]: pkVal }, auth.claims?.rls);
                const updRes = await db.query<Record<string, unknown>>(
                  `UPDATE ${qApiIdent(tbl.name)} SET ${sets.join(', ')}${w.sql} RETURNING *`,
                  [...vals, ...w.params],
                );
                const proj = await projectRows(tbl, updRes.rows, rootField.children, auth.claims?.rls);
                data[rootField.alias] = proj[0] ?? null;
              } else {
                const pkVal = rootField.args.pk ?? rootField.args.id;
                const w = buildWhereSql(tbl, { [pkCol]: pkVal }, auth.claims?.rls);
                const affected = await execApiSql(
                  db,
                  `DELETE FROM ${qApiIdent(tbl.name)}${w.sql}`,
                  w.params,
                );
                data[rootField.alias] = { affectedRows: affected };
              }
            }
          }
          return jsonResp(200, { data });
        }

        // 2. REST CRUD Endpoints (`/rest/<table>[/<id>]`)
        const restMatch = /^\/rest\/([^/]+)(?:\/([^/]+))?$/i.exec(pathname);
        if (restMatch) {
          const tbl = findTable(decodeURIComponent(restMatch[1]!));
          if (!tbl) return jsonResp(404, { error: `Table "${restMatch[1]}" not found.` });
          const idSeg = restMatch[2] !== undefined ? decodeURIComponent(restMatch[2]) : undefined;
          const pkCol = (tbl.primaryKey?.[0] ?? tbl.columns[0]?.name ?? 'ID').toUpperCase();
          const pkType = tbl.columns.find((c) => c.name.toUpperCase() === pkCol)?.typeName ?? '';
          const coercePk = (raw: string): string | number =>
            mapFbTypeToGraphql(pkType) === 'Int' && /^-?\d+$/.test(raw) ? Number(raw) : raw;

          if (request.method !== 'GET' && isReadOnly) {
            return jsonResp(403, { error: 'Gateway is in read-only mode.' });
          }

          if (request.method === 'GET') {
            if (idSeg !== undefined) {
              const w = buildWhereSql(tbl, { [pkCol]: coercePk(idSeg) }, auth.claims?.rls);
              const res = await db.query<Record<string, unknown>>(
                `SELECT FIRST 1 * FROM ${qApiIdent(tbl.name)}${w.sql}`,
                w.params,
              );
              if (res.rows.length === 0) return jsonResp(404, { error: 'Row not found.' });
              return jsonResp(200, res.rows[0]);
            }
            const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
            const filterObj: Record<string, unknown> = {};
            for (const [k, v] of url.searchParams.entries()) {
              if (k === 'limit' || k === 'offset' || k === 'orderBy') continue;
              const col = resolveColumnName(tbl, k);
              if (col) {
                const cInfo = tbl.columns.find((c) => c.name.toUpperCase() === col);
                filterObj[col] =
                  cInfo && mapFbTypeToGraphql(cInfo.typeName) === 'Int' && /^-?\d+$/.test(v)
                    ? Number(v)
                    : v;
              }
            }
            const w = buildWhereSql(tbl, filterObj, auth.claims?.rls);
            const res = await db.query<Record<string, unknown>>(
              `SELECT FIRST ${limit} SKIP ${offset} * FROM ${qApiIdent(tbl.name)}${w.sql} ORDER BY ${qApiIdent(pkCol)} ASC`,
              w.params,
            );
            return jsonResp(200, { rows: res.rows, count: res.rows.length });
          }

          if (request.method === 'POST' && idSeg === undefined) {
            const obj = (await request.json()) as Record<string, unknown>;
            const rlsErr = assertRlsWriteAllowed(tbl, obj, auth.claims?.rls);
            if (rlsErr) return jsonResp(403, { error: rlsErr });
            const cols: string[] = [];
            const vals: unknown[] = [];
            for (const [k, v] of Object.entries(obj)) {
              const col = resolveColumnName(tbl, k);
              if (col) {
                cols.push(qApiIdent(col));
                vals.push(v);
              }
            }
            const ins = await db.query<Record<string, unknown>>(
              `INSERT INTO ${qApiIdent(tbl.name)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`,
              vals,
            );
            return jsonResp(201, ins.rows[0] ?? {});
          }

          if (request.method === 'PATCH' && idSeg !== undefined) {
            const setObj = (await request.json()) as Record<string, unknown>;
            const sets: string[] = [];
            const vals: unknown[] = [];
            for (const [k, v] of Object.entries(setObj)) {
              const col = resolveColumnName(tbl, k);
              if (col) {
                sets.push(`${qApiIdent(col)} = ?`);
                vals.push(v);
              }
            }
            const w = buildWhereSql(tbl, { [pkCol]: coercePk(idSeg) }, auth.claims?.rls);
            const upd = await db.query<Record<string, unknown>>(
              `UPDATE ${qApiIdent(tbl.name)} SET ${sets.join(', ')}${w.sql} RETURNING *`,
              [...vals, ...w.params],
            );
            if (upd.rows.length === 0) return jsonResp(404, { error: 'Row not found.' });
            return jsonResp(200, upd.rows[0]);
          }

          if (request.method === 'DELETE' && idSeg !== undefined) {
            const w = buildWhereSql(tbl, { [pkCol]: coercePk(idSeg) }, auth.claims?.rls);
            const affected = await execApiSql(
              db,
              `DELETE FROM ${qApiIdent(tbl.name)}${w.sql}`,
              w.params,
            );
            return jsonResp(200, { deleted: affected > 0, affectedRows: affected });
          }
        }

        return jsonResp(404, { error: `Unknown endpoint "${request.method} ${pathname}".` });
      } catch (err) {
        return jsonResp(400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
