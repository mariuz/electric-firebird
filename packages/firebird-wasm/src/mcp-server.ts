/**
 * mcp-server.ts – Model Context Protocol (MCP) JSON-RPC 2.0 Server & Guarded
 * Agent SQL / Hybrid RAG Tooling (`createFirebirdMcpServer`) (`M27 Item 1`).
 *
 * Zero-dependency MCP server supporting in-process JSON-RPC, Web Fetch HTTP
 * (`POST /mcp` & `GET /mcp`), and newline-delimited `stdio` transport for AI
 * coding and data agents.
 */

import { VERSION } from './version';
import { introspect as introspectCatalog, generateMigration } from './browser/schema';
import {
  createAuditLog,
  verifyAuditChain,
  type AuditLogHandle,
} from './audit-log';
import { createFtsIndex, hybridSearch } from './fts';
import { graphRagSearch } from './knowledge-graph';
import { createWorkloadAdvisor } from './workload-advisor';
import { runWithCancellation, validateTimeoutMs } from './database-core';
import type {
  ExplainOptions,
  QueryParams,
  QueryResult,
  Row,
  SchemaIntrospection,
  TransactionOptions,
} from './types';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Minimal database interface required by {@link createFirebirdMcpServer} (`M27 Item 1`). */
export interface McpDatabaseExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  explain?(sql: string, options?: ExplainOptions): Promise<string>;
  introspect?(): Promise<SchemaIntrospection>;
  transaction?<T>(
    fn: (tx: { query<R extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<R>> }) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  cancelOperation?(): Promise<void>;
}

/** JSON-RPC 2.0 request envelope (`M27 Item 1`). */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope (`M27 Item 1`). */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/** MCP Tool descriptor returned by `tools/list` (`M27 Item 1`). */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** MCP Resource descriptor returned by `resources/list` (`M27 Item 1`). */
export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** Options for {@link createFirebirdMcpServer} (`M27 Item 1`). */
export interface FirebirdMcpServerOptions {
  /** Server display name advertised in `initialize`. @default 'firebird-wasm-mcp' */
  name?: string;
  /** Server version advertised in `initialize`. @default VERSION */
  version?: string;
  /** Enable `write_query` tool for DML/DDL mutations. @default false */
  allowWrites?: boolean;
  /** Maximum rows returned by `read_query` before truncation. @default 200 */
  maxRows?: number;
  /** Per-query execution timeout in milliseconds. @default 5000 */
  queryTimeoutMs?: number;
  /** Automatically record `write_query` calls in `FB_AUDIT_LOG$` (`true` or custom `AuditLogHandle`). @default false */
  audit?: boolean | AuditLogHandle;
  /** Actor name recorded in `FB_AUDIT_LOG$` for agent writes. @default 'mcp-agent' */
  auditActor?: string;
  /** Optional Bearer API key enforced on HTTP `fetchHandler` requests. */
  apiKey?: string;
  /** Advertise `graph_search` (GraphRAG over `FB_GRAPH_NODES` / `FB_GRAPH_EDGES`) in `tools/list` (`M28 Item 2`). @default false */
  enableGraphRag?: boolean;
  /** Advertise `advise_workload` (Adaptive Index & Workload Advisor) in `tools/list` (`M28 Item 4`). @default false */
  enableAdvisor?: boolean;
}

/** Handle returned by {@link createFirebirdMcpServer} (`M27 Item 1`). */
export interface FirebirdMcpServer {
  readonly name: string;
  readonly allowWrites: boolean;
  listTools(): McpToolDescriptor[];
  listResources(): Promise<McpResourceDescriptor[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
  readResource(uri: string): Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }>;
  handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  fetchHandler(request: Request): Promise<Response>;
  serveStdio(
    inputLines: AsyncIterable<string> | Iterable<string>,
    writeLine: (line: string) => void,
  ): Promise<void>;
}

const MUTATING_SQL_RE =
  /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|RECREATE|TRUNCATE|GRANT|REVOKE|COMMENT|SET\s+GENERATOR|EXECUTE\s+(?:PROCEDURE|BLOCK))\b/i;

const SELECT_READ_SQL_RE = /^\s*(SELECT|WITH)\b/i;

function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('SQL query must not be empty.');
  }
  if (MUTATING_SQL_RE.test(trimmed) || !SELECT_READ_SQL_RE.test(trimmed)) {
    throw new Error(
      'read_query only permits read-only SELECT / WITH queries. Mutating or procedural SQL is blocked.',
    );
  }
  if (/\bINTO\s+[A-Za-z0-9_$"]/i.test(trimmed) && /\bINSERT\b/i.test(trimmed)) {
    throw new Error('Mutating statements are not allowed in read_query.');
  }
}

function bytesToBase64Mcp(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function jsonSafeReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Uint8Array) {
    return { $bytesBase64: bytesToBase64Mcp(val), byteLength: val.byteLength };
  }
  return val;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function getDbSchema(db: McpDatabaseExecutor): Promise<SchemaIntrospection> {
  if (typeof db.introspect === 'function') {
    return db.introspect();
  }
  return introspectCatalog({
    query: (s, p) => db.query(s, p),
    exec: async (s, p) => {
      if (typeof db.exec === 'function') await db.exec(s, p);
      else if (typeof db.execute === 'function') await db.execute(s, p);
      else await db.query(s, p);
    },
  });
}

async function buildSchemaDdlText(db: McpDatabaseExecutor): Promise<string> {
  const schema = await getDbSchema(db);
  const emptySchema: SchemaIntrospection = {
    tables: [],
    views: [],
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    indexes: [],
    sequences: [],
    triggers: [],
  };
  const mig = await generateMigration(emptySchema, schema, { quoteIdentifiers: true });
  return mig.upSql || '-- (empty database schema)';
}

/**
 * Create a zero-dependency **Model Context Protocol (MCP)** JSON-RPC 2.0 server
 * exposing guarded Firebird SQL, schema introspection, query plans, audit chain
 * status, and BM25/Vector hybrid search to AI agents (`M27 Item 1`).
 */
export function createFirebirdMcpServer(
  db: McpDatabaseExecutor,
  options: FirebirdMcpServerOptions = {},
): FirebirdMcpServer {
  const serverName = options.name ?? 'firebird-wasm-mcp';
  const serverVersion = options.version ?? VERSION;
  const allowWrites = options.allowWrites === true;
  const maxRows = Math.max(1, options.maxRows ?? 200);
  const queryTimeoutMs = validateTimeoutMs(options.queryTimeoutMs ?? 5_000) ?? 5_000;
  const auditActor = options.auditActor ?? 'mcp-agent';

  const auditHandle: AuditLogHandle | null =
    options.audit === true
      ? createAuditLog(db, { actorResolver: () => auditActor })
      : options.audit && typeof options.audit === 'object'
        ? options.audit
        : null;

  const listTools = (): McpToolDescriptor[] => {
    const tools: McpToolDescriptor[] = [
      {
        name: 'list_tables',
        description:
          'List user tables and views in the Firebird database along with primary keys and row counts.',
        inputSchema: {
          type: 'object',
          properties: {
            includeRowCounts: {
              type: 'boolean',
              description: 'Include exact SELECT COUNT(*) per table (default: true).',
            },
          },
        },
      },
      {
        name: 'describe_table',
        description:
          'Return column definitions, types, nullability, primary keys, foreign keys, and indexes for a Firebird table.',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name to describe.' },
          },
          required: ['table'],
        },
      },
      {
        name: 'read_query',
        description:
          'Execute a guarded read-only SELECT / WITH SQL query against Firebird inside a READ ONLY transaction with row cap.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'Read-only Firebird SELECT or WITH SQL query.' },
            params: {
              type: 'array',
              description: 'Optional positional ? parameter bindings.',
              items: {},
            },
            limit: {
              type: 'number',
              description: `Maximum rows to return (capped at ${maxRows}).`,
            },
          },
          required: ['sql'],
        },
      },
      {
        name: 'explain_query',
        description:
          'Return Firebird optimizer execution plan (PLAN / detailed tree) without executing the query.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL query to explain.' },
            detailed: {
              type: 'boolean',
              description: 'Return multi-line detailed Firebird 5 plan tree.',
            },
          },
          required: ['sql'],
        },
      },
      {
        name: 'hybrid_search',
        description:
          'Run BM25 full-text search or RRF hybrid (BM25 + vector cosine) search over a Firebird table.',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Target table name.' },
            textQuery: { type: 'string', description: 'Keyword/natural-language search query.' },
            ftsColumns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Text columns for BM25 ranking.',
            },
            vectorColumn: {
              type: 'string',
              description: 'Optional vector embedding column name when vectorQuery is provided.',
            },
            vectorQuery: {
              type: 'array',
              items: { type: 'number' },
              description: 'Optional float32 query embedding array for hybrid RRF fusion.',
            },
            diversityLambda: {
              type: 'number',
              description: 'Optional MMR diversity weight in [0, 1].',
            },
            limit: { type: 'number', description: 'Maximum hits to return (default: 10).' },
          },
          required: ['table', 'textQuery', 'ftsColumns'],
        },
      },
    ];

    if (allowWrites) {
      tools.push({
        name: 'write_query',
        description:
          'Execute a parameterized DML or DDL write statement (INSERT, UPDATE, DELETE, CREATE, ALTER) on Firebird.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL DML or DDL statement.' },
            params: {
              type: 'array',
              description: 'Optional positional ? parameter bindings.',
              items: {},
            },
          },
          required: ['sql'],
        },
      });
    }

    if (options.enableGraphRag) {
      tools.push({
        name: 'graph_search',
        description:
          'Run multi-hop Knowledge-GraphRAG search over FB_GRAPH_NODES and FB_GRAPH_EDGES via Firebird WITH RECURSIVE.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language or entity search query.' },
            queryVector: { type: 'array', items: { type: 'number' } },
            maxHops: { type: 'number', description: 'Maximum graph hops (default: 2).' },
            tokenBudget: { type: 'number', description: 'Context token budget (default: 512).' },
          },
          required: ['query'],
        },
      });
    }

    if (options.enableAdvisor) {
      tools.push({
        name: 'advise_workload',
        description:
          'Analyze query plans, RDB$INDICES, and foreign keys to recommend CREATE/DROP/ALTER INDEX tuning DDL.',
        inputSchema: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional SQL queries to explain and analyze.',
            },
          },
        },
      });
    }

    return tools;
  };

  const listResources = async (): Promise<McpResourceDescriptor[]> => {
    const schema = await getDbSchema(db);
    const resources: McpResourceDescriptor[] = [
      {
        uri: 'firebird://schema',
        name: 'Database DDL Schema',
        description: 'Complete SQL DDL schema of user tables, primary keys, foreign keys, and indexes.',
        mimeType: 'application/sql',
      },
      {
        uri: 'firebird://audit/head',
        name: 'Cryptographic Audit Chain Status',
        description: 'Current SHA-256 hash chain & Merkle root integrity report for FB_AUDIT_LOG$.',
        mimeType: 'application/json',
      },
    ];
    for (const tbl of schema.tables) {
      resources.push({
        uri: `firebird://table/${encodeURIComponent(tbl.name)}/sample`,
        name: `${tbl.name} Sample Rows`,
        description: `Column metadata and up to 10 sample rows from table ${tbl.name}.`,
        mimeType: 'application/json',
      });
    }
    return resources;
  };

  const readResource = async (uri: string) => {
    if (uri === 'firebird://schema') {
      const ddl = await buildSchemaDdlText(db);
      return {
        contents: [{ uri, mimeType: 'application/sql', text: ddl }],
      };
    }
    if (uri === 'firebird://audit/head') {
      const report = await verifyAuditChain(db);
      return {
        contents: [
          { uri, mimeType: 'application/json', text: JSON.stringify(report, null, 2) },
        ],
      };
    }
    const sampleMatch = /^firebird:\/\/table\/([^/]+)\/sample$/i.exec(uri);
    if (sampleMatch) {
      const requested = decodeURIComponent(sampleMatch[1]!).toUpperCase();
      const schema = await getDbSchema(db);
      const tbl = schema.tables.find((t) => t.name.toUpperCase() === requested);
      if (!tbl) {
        throw new Error(`Unknown Firebird table resource: ${requested}`);
      }
      const cols = schema.columns.filter((c) => c.tableName.toUpperCase() === requested);
      const sampleRes = await db.query(`SELECT FIRST 10 * FROM ${quoteIdent(tbl.name)}`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                table: tbl.name,
                columns: cols.map((c) => ({
                  name: c.name,
                  type: c.typeName,
                  nullable: c.nullable,
                  isPrimaryKey: c.isPrimaryKey,
                })),
                sampleRows: sampleRes.rows,
              },
              jsonSafeReplacer,
              2,
            ),
          },
        ],
      };
    }
    throw new Error(`Unsupported MCP resource URI: ${uri}`);
  };

  const callTool: FirebirdMcpServer['callTool'] = async (name, args = {}) => {
    try {
      if (name === 'list_tables') {
        const schema = await getDbSchema(db);
        const includeCounts = args.includeRowCounts !== false;
        const tables: Array<Record<string, unknown>> = [];
        for (const t of schema.tables) {
          const pk =
            schema.primaryKeys.find((p) => p.tableName.toUpperCase() === t.name.toUpperCase())
              ?.columns ?? [];
          let rowCount: number | undefined;
          if (includeCounts) {
            const cntRes = await db.query<{ CNT: number }>(
              `SELECT COUNT(*) AS CNT FROM ${quoteIdent(t.name)}`,
            );
            rowCount = Number(cntRes.rows[0]?.CNT ?? 0);
          }
          tables.push({
            name: t.name,
            primaryKey: pk,
            ...(rowCount !== undefined ? { rowCount } : {}),
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { tables, views: schema.views.map((v) => v.name) },
                jsonSafeReplacer,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'describe_table') {
        const tblName = String(args.table ?? '').trim();
        if (!tblName) throw new Error('describe_table requires a "table" argument.');
        const upper = tblName.toUpperCase();
        const schema = await getDbSchema(db);
        const cols = schema.columns.filter((c) => c.tableName.toUpperCase() === upper);
        if (cols.length === 0) {
          throw new Error(`Table "${tblName}" not found in database catalog.`);
        }
        const pk =
          schema.primaryKeys.find((p) => p.tableName.toUpperCase() === upper)?.columns ?? [];
        const fks = schema.foreignKeys.filter((f) => f.tableName.toUpperCase() === upper);
        const idxs = schema.indexes.filter((idx) => idx.tableName.toUpperCase() === upper);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { table: upper, primaryKey: pk, columns: cols, foreignKeys: fks, indexes: idxs },
                jsonSafeReplacer,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'read_query') {
        const sql = String(args.sql ?? '');
        assertReadOnlySql(sql);
        const params = Array.isArray(args.params) ? (args.params as QueryParams) : [];
        const requestedLimit =
          typeof args.limit === 'number' && args.limit > 0
            ? Math.min(maxRows, Math.floor(args.limit))
            : maxRows;

        const execRead = async (): Promise<QueryResult<Row>> => {
          if (typeof db.transaction === 'function') {
            return db.transaction((tx) => tx.query(sql, params), { readOnly: true });
          }
          return db.query(sql, params);
        };

        const res = await runWithCancellation(
          execRead,
          { timeoutMs: queryTimeoutMs },
          async () => {
            await db.cancelOperation?.();
          },
        );
        const truncated = res.rows.length > requestedLimit;
        const rows = truncated ? res.rows.slice(0, requestedLimit) : res.rows;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  rowCount: rows.length,
                  truncated,
                  fields: res.fields.map((f) => ({ name: f.name, type: f.typeName })),
                  rows,
                },
                jsonSafeReplacer,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'write_query') {
        if (!allowWrites) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Write operations are disabled on this MCP server (pass allowWrites: true to enable write_query).',
              },
            ],
          };
        }
        const sql = String(args.sql ?? '').trim();
        if (!sql) throw new Error('write_query requires a non-empty "sql" statement.');
        const params = Array.isArray(args.params) ? (args.params as QueryParams) : [];
        let affectedRows = 0;
        if (typeof db.execute === 'function') {
          const r = await db.execute(sql, params);
          affectedRows = r.affectedRows;
        } else if (typeof db.exec === 'function') {
          await db.exec(sql, params);
        } else {
          await db.query(sql, params);
        }

        if (auditHandle) {
          const opMatch = /^\s*([A-Za-z]+)/.exec(sql);
          const op = (opMatch?.[1] ?? 'WRITE').toUpperCase();
          const tblMatch =
            /\b(?:INTO|UPDATE|FROM|TABLE)\s+"?([A-Za-z0-9_$]+)"?/i.exec(sql);
          const table = (tblMatch?.[1] ?? 'MCP_SQL').toUpperCase();
          await auditHandle.record({
            table,
            op,
            actor: auditActor,
            ddlSql: sql,
            after: params.length > 0 ? { params } : null,
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, affectedRows }, null, 2),
            },
          ],
        };
      }

      if (name === 'explain_query') {
        const sql = String(args.sql ?? '').trim();
        if (!sql) throw new Error('explain_query requires "sql".');
        if (typeof db.explain !== 'function') {
          throw new Error('Underlying database executor does not support explain().');
        }
        const plan = await db.explain(sql, { detailed: args.detailed === true });
        return {
          content: [{ type: 'text', text: plan || '(no execution plan for statement)' }],
        };
      }

      if (name === 'hybrid_search') {
        const table = String(args.table ?? '').trim();
        const textQuery = String(args.textQuery ?? '').trim();
        const ftsColumns = Array.isArray(args.ftsColumns)
          ? (args.ftsColumns as unknown[]).map(String)
          : [];
        const limit =
          typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 10;
        if (!table || !textQuery || ftsColumns.length === 0) {
          throw new Error('hybrid_search requires table, textQuery, and ftsColumns.');
        }

        if (typeof args.vectorColumn === 'string' && Array.isArray(args.vectorQuery)) {
          const vecQuery = (args.vectorQuery as unknown[]).map(Number);
          const hits = await hybridSearch(db, {
            table,
            ftsColumns,
            vectorColumn: args.vectorColumn,
            textQuery,
            vectorQuery: vecQuery,
            limit,
            diversityLambda:
              typeof args.diversityLambda === 'number' ? args.diversityLambda : undefined,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({ hits }, jsonSafeReplacer, 2) }],
          };
        }

        const ftsIdx = await createFtsIndex(db, {
          table,
          columns: ftsColumns,
          persist: false,
        });
        const ftsHits = await ftsIdx.search(textQuery, { limit });
        ftsIdx.dispose();
        return {
          content: [
            { type: 'text', text: JSON.stringify({ hits: ftsHits }, jsonSafeReplacer, 2) },
          ],
        };
      }

      if (name === 'graph_search') {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('graph_search requires "query".');
        const qVec = Array.isArray(args.queryVector)
          ? (args.queryVector as unknown[]).map(Number)
          : undefined;
        const graphRes = await graphRagSearch(db, {
          query,
          queryVector: qVec,
          maxHops: typeof args.maxHops === 'number' ? args.maxHops : 2,
          tokenBudget: typeof args.tokenBudget === 'number' ? args.tokenBudget : 512,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(graphRes, jsonSafeReplacer, 2) }],
        };
      }

      if (name === 'advise_workload') {
        const extraQueries = Array.isArray(args.queries)
          ? (args.queries as unknown[]).map(String)
          : [];
        const advisor = createWorkloadAdvisor(db, { captureLiveQueries: false });
        const report = await advisor.analyze(extraQueries);
        advisor.dispose();
        return {
          content: [{ type: 'text', text: JSON.stringify(report, jsonSafeReplacer, 2) }],
        };
      }

      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown MCP tool: "${name}"` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  };

  const handleMessage = async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: msg?.id ?? null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
      };
    }

    // Notifications (no id) produce no response frame
    if (msg.id === undefined) {
      return null;
    }

    const id = msg.id;
    const params = msg.params ?? {};

    try {
      switch (msg.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {
                tools: {},
                resources: {},
                prompts: {},
              },
              serverInfo: {
                name: serverName,
                version: serverVersion,
              },
            },
          };

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: listTools() },
          };

        case 'tools/call': {
          const toolName = String(params.name ?? '');
          const toolArgs =
            params.arguments && typeof params.arguments === 'object'
              ? (params.arguments as Record<string, unknown>)
              : {};
          const outcome = await callTool(toolName, toolArgs);
          return { jsonrpc: '2.0', id, result: outcome };
        }

        case 'resources/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { resources: await listResources() },
          };

        case 'resources/templates/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              resourceTemplates: [
                {
                  uriTemplate: 'firebird://table/{name}/sample',
                  name: 'Table Sample Rows & Columns',
                  description: 'Inspect schema columns and sample rows for any user table.',
                  mimeType: 'application/json',
                },
              ],
            },
          };

        case 'resources/read': {
          const uri = String(params.uri ?? '');
          return {
            jsonrpc: '2.0',
            id,
            result: await readResource(uri),
          };
        }

        case 'prompts/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              prompts: [
                {
                  name: 'firebird_sql_assistant',
                  description:
                    'Schema-grounded Firebird 5 SQL authoring prompt with live DDL context.',
                  arguments: [
                    {
                      name: 'question',
                      description: 'Natural-language data question to answer with Firebird SQL.',
                      required: true,
                    },
                  ],
                },
              ],
            },
          };

        case 'prompts/get': {
          const promptName = String(params.name ?? '');
          if (promptName !== 'firebird_sql_assistant') {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown prompt: ${promptName}` },
            };
          }
          const argsObj = (params.arguments ?? {}) as Record<string, unknown>;
          const question = String(argsObj.question ?? '');
          const ddl = await buildSchemaDdlText(db);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              description: 'Firebird 5 SQL assistant grounded on live schema DDL',
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text:
                      `You are querying an embedded Firebird 5 SQL database (use FIRST/SKIP or FETCH FIRST N ROWS ONLY, positional ? parameters, and standard SQL).\n\n` +
                      `Schema:\n${ddl}\n\nQuestion: ${question}`,
                  },
                },
              ],
            },
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          };
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };

  const fetchHandler = async (request: Request): Promise<Response> => {
    if (options.apiKey) {
      const auth = request.headers.get('authorization') ?? '';
      const keyHdr = request.headers.get('x-mcp-key') ?? '';
      if (auth !== `Bearer ${options.apiKey}` && keyHdr !== options.apiKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized MCP request' }), {
          status: 401,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    }

    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: serverName,
          version: serverVersion,
          protocolVersion: MCP_PROTOCOL_VERSION,
          allowWrites,
          tools: listTools().map((t) => t.name),
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
        { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of body) {
        const res = await handleMessage(item as JsonRpcRequest);
        if (res) responses.push(res);
      }
      if (responses.length === 0) return new Response(null, { status: 202 });
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const single = await handleMessage(body as JsonRpcRequest);
    if (!single) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(single), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  const serveStdio: FirebirdMcpServer['serveStdio'] = async (inputLines, writeLine) => {
    for await (const rawLine of inputLines) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(line) as JsonRpcRequest;
      } catch {
        writeLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
        continue;
      }
      const reply = await handleMessage(parsed);
      if (reply) {
        writeLine(JSON.stringify(reply));
      }
    }
  };

  return {
    name: serverName,
    allowWrites,
    listTools,
    listResources,
    callTool,
    readResource,
    handleMessage,
    fetchHandler,
    serveStdio,
  };
}
