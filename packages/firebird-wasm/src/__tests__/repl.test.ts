/**
 * repl.test.ts – unit tests for the <firebird-repl> custom element, including
 * the Interactive Schema Inspector, Migration Viewer, Profiler & Visual Query
 * Plan / Flamegraph Explorer.
 */

import type { FirebirdBrowser } from '../browser/firebird-browser';
import {
  parseQueryPlan,
  computeTableIoBreakdown,
  type FirebirdReplElement,
  type ReplDatabase,
  type ReplEntry,
} from '../repl';
import type { MonitorStats, SchemaIntrospection } from '../types';

const fits: (db: FirebirdBrowser) => ReplDatabase = (db) => db;
void fits;

class FakeNode {
  tagName: string;
  className = '';
  textContent = '';
  title = '';
  type = '';
  value!: string;
  placeholder = '';
  spellcheck = false;
  disabled = false;
  hidden = false;
  open = false;
  scrollTop = 0;
  scrollHeight = 0;
  children: FakeNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  classList = {
    add: (...tokens: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      tokens.forEach((t) => set.add(t));
      this.className = [...set].join(' ');
    },
    remove: (...tokens: string[]) => {
      const removeSet = new Set(tokens);
      this.className = this.className
        .split(/\s+/)
        .filter((t) => t && !removeSet.has(t))
        .join(' ');
    },
    toggle: (token: string, force?: boolean) => {
      const has = this.className.split(/\s+/).includes(token);
      const shouldHave = force !== undefined ? force : !has;
      if (shouldHave) this.classList.add(token);
      else this.classList.remove(token);
      return shouldHave;
    },
    contains: (token: string) =>
      this.className.split(/\s+/).filter(Boolean).includes(token),
  };

  constructor(tagName = 'div') {
    this.tagName = tagName.toLowerCase();
    if (this.tagName === 'textarea' || this.tagName === 'input') {
      this.value = '';
    }
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [...nodes];
  }

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, val);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(ev: { type: string }): boolean {
    for (const fn of this.listeners.get(ev.type) ?? []) {
      fn(ev);
    }
    return true;
  }

  focus(): void {}

  setSelectionRange(): void {}

  findByClass(cls: string): FakeNode | undefined {
    if (this.classList.contains(cls)) return this;
    for (const child of this.children) {
      const found = child.findByClass(cls);
      if (found) return found;
    }
    return undefined;
  }

  findAllByClass(cls: string, out: FakeNode[] = []): FakeNode[] {
    if (this.classList.contains(cls)) out.push(this);
    for (const child of this.children) {
      child.findAllByClass(cls, out);
    }
    return out;
  }

  allText(): string {
    if (this.children.length === 0) return this.textContent;
    return (
      this.textContent +
      this.children.map((c) => c.allText()).join(' ')
    );
  }
}

describe('firebird-wasm/repl', () => {
  it('imports where there is no DOM, and defines nothing until asked', async () => {
    expect(
      typeof (globalThis as { HTMLElement?: unknown }).HTMLElement,
    ).toBe('undefined');
    const repl = await import('../repl');
    expect(typeof repl.defineFirebirdRepl).toBe('function');
  });

  it('parses both legacy PLAN (...) and Firebird 3.0+/5.0 explained -> trees with per-table I/O attribution', () => {
    const sampleStats: MonitorStats = {
      totalQueries: 2,
      totalExecs: 0,
      totalErrors: 0,
      totalDurationMs: 10,
      avgDurationMs: 5,
      maxDurationMs: 7,
      slowestSql: 'SELECT * FROM ORDERS',
      prepareCacheHits: 1,
      prepareCacheMisses: 1,
      prepareCacheHitRate: 0.5,
      io: {
        reads: 12,
        writes: 0,
        fetches: 140,
        marks: 0,
        pageBuffers: 2048,
        currentMemory: 1024,
        maxMemory: 2048,
      },
      transactions: {
        oldestTransaction: 1,
        oldestActive: 2,
        oldestSnapshot: 2,
        nextTransaction: 3,
        transactionGap: 1,
      },
      activeStatements: 0,
      recentQueries: [
        {
          sql: 'SELECT * FROM USERS u JOIN ORDERS o ON o.USER_ID = u.ID',
          params: [],
          kind: 'query',
          durationMs: 8.4,
          rowCount: 15,
          cacheHit: false,
          timestamp: 1000,
          io: { reads: 10, writes: 0, fetches: 100, marks: 0 },
        },
      ],
    };

    // 1. Legacy PLAN expression
    const legacy = parseQueryPlan(
      'PLAN SORT (JOIN (USERS U INDEX (PK_USERS), ORDERS O NATURAL))',
      sampleStats,
    );
    expect(legacy.format).toBe('legacy');
    expect(legacy.root.kind).toBe('sort');
    expect(legacy.tables).toEqual(['USERS', 'ORDERS']);
    expect(legacy.indexes).toEqual(['PK_USERS']);
    expect(legacy.naturalScanCount).toBe(1);
    expect(legacy.indexScanCount).toBe(1);

    const ordersNode = legacy.nodes.find((n) => n.tableName === 'ORDERS');
    expect(ordersNode?.accessMethod).toBe('NATURAL');
    expect(ordersNode?.warnings[0]).toContain('Full table scan (NATURAL) on ORDERS');
    expect(ordersNode?.tableIo?.fetches).toBe(50);

    // 2. Firebird 5.0 explained indentation plan
    const explainedText = [
      'Select Expression',
      '    -> Sort (record length: 64, key length: 12)',
      '        -> Nested Loop Join (inner)',
      '            -> Table "USERS" as "U" Access By ID',
      '                -> Bitmap',
      '                    -> Index "PK_USERS" Unique Scan',
      '            -> Filter',
      '                -> Table "ORDERS" as "O" Full Scan',
    ].join('\n');

    const explained = parseQueryPlan(explainedText, sampleStats);
    expect(explained.format).toBe('explained');
    expect(explained.root.kind).toBe('select');
    expect(explained.tables).toEqual(['USERS', 'ORDERS']);
    expect(explained.indexes).toEqual(['PK_USERS']);
    expect(explained.naturalScanCount).toBe(1);

    const usersExplained = explained.nodes.find((n) => n.tableName === 'USERS');
    expect(usersExplained?.indexNames).toEqual(['PK_USERS']);

    const breakdown = computeTableIoBreakdown(sampleStats);
    expect(breakdown.get('USERS')?.fetches).toBe(50);
    expect(breakdown.get('ORDERS')?.reads).toBe(5);
  });

  it('renders the interactive Schema Inspector, Migration Viewer, Profiler & Visual Query Plan / Flamegraph Explorer', async () => {
    const g = globalThis as Record<string, unknown>;
    const registry = new Map<string, unknown>();

    class FakeHTMLElement extends FakeNode {
      shadowRoot: FakeNode | null = null;
      constructor() {
        super('firebird-repl');
      }
      attachShadow(): FakeNode {
        this.shadowRoot = new FakeNode('shadow-root');
        return this.shadowRoot;
      }
    }

    class FakeCustomEvent<T = unknown> {
      readonly type: string;
      readonly detail: T;
      constructor(type: string, init?: { detail?: T }) {
        this.type = type;
        this.detail = init?.detail as T;
      }
    }

    g['HTMLElement'] = FakeHTMLElement;
    g['CustomEvent'] = FakeCustomEvent;
    g['customElements'] = {
      get: (tag: string) => registry.get(tag),
      define: (tag: string, ctor: unknown) => registry.set(tag, ctor),
    };
    g['document'] = {
      createElement: (tag: string) => new FakeNode(tag),
    };

    try {
      const { defineFirebirdRepl } = await import('../repl');
      const Ctor = defineFirebirdRepl('firebird-repl-test');
      const el = new Ctor() as FirebirdReplElement & {
        shadowRoot: FakeNode;
      };

      const fakeColumns = [
        {
          tableName: 'USERS',
          name: 'ID',
          position: 0,
          typeName: 'INTEGER',
          dataType: 'INTEGER' as const,
          fieldType: 8,
          subType: 0,
          scale: 0,
          precision: 0,
          length: 4,
          nullable: false,
          defaultSource: null,
          isIdentity: true,
          isComputed: false,
          isPrimaryKey: true,
        },
        {
          tableName: 'USERS',
          name: 'EMAIL',
          position: 1,
          typeName: 'VARCHAR(120)',
          dataType: 'VARYING' as const,
          fieldType: 37,
          subType: 0,
          scale: 0,
          precision: 0,
          length: 120,
          nullable: false,
          defaultSource: "DEFAULT 'anon@example.com'",
          isIdentity: false,
          isComputed: false,
          isPrimaryKey: false,
        },
      ];
      const fakeFks = [
        {
          name: 'FK_USERS_ORG',
          tableName: 'USERS',
          columns: ['ID'],
          referencedTableName: 'ORGS',
          referencedColumns: ['ID'],
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
      ];
      const fakeIndexes = [
        {
          name: 'IDX_USERS_EMAIL',
          tableName: 'USERS',
          columns: ['EMAIL'],
          unique: true,
          descending: false,
          inactive: false,
        },
      ];
      const fakeTriggers = [
        {
          name: 'TRG_USERS_BI',
          tableName: 'USERS',
          triggerType: 1,
          timing: 'BEFORE',
          events: ['INSERT'],
          sequence: 0,
          inactive: false,
          source: 'AS BEGIN END',
        },
      ];

      const fakeSchema: SchemaIntrospection = {
        tables: [
          {
            name: 'USERS',
            columns: fakeColumns,
            primaryKey: ['ID'],
            foreignKeys: fakeFks,
            indexes: fakeIndexes,
            triggers: fakeTriggers,
          },
        ],
        views: [
          {
            name: 'ACTIVE_USERS',
            columns: [],
            source: 'SELECT ID, EMAIL FROM USERS',
          },
        ],
        columns: fakeColumns,
        primaryKeys: [
          {
            tableName: 'USERS',
            constraintName: 'PK_USERS',
            indexName: 'PK_USERS',
            columns: ['ID'],
          },
        ],
        foreignKeys: fakeFks,
        indexes: fakeIndexes,
        sequences: [{ name: 'GEN_USER_ID', initialValue: 0, increment: 1 }],
        triggers: fakeTriggers,
      };

      const fakeDb: ReplDatabase = {
        describeQuery: vi.fn(async () => ({ hasResultSet: true })),
        explain: vi.fn(
          async () =>
            'PLAN JOIN (USERS INDEX (IDX_USERS_EMAIL), ORGS NATURAL)',
        ),
        introspect: vi.fn(async () => fakeSchema),
        monitorStats: vi.fn(async () => ({
          totalQueries: 2,
          totalExecs: 1,
          totalErrors: 0,
          totalDurationMs: 12.5,
          avgDurationMs: 4.16,
          maxDurationMs: 6.2,
          slowestSql: 'SELECT * FROM USERS',
          prepareCacheHits: 2,
          prepareCacheMisses: 1,
          prepareCacheHitRate: 2 / 3,
          io: {
            reads: 14,
            writes: 3,
            fetches: 120,
            marks: 8,
            pageBuffers: 2048,
            currentMemory: 262144,
            maxMemory: 524288,
          },
          transactions: {
            oldestTransaction: 10,
            oldestActive: 11,
            oldestSnapshot: 11,
            nextTransaction: 12,
            transactionGap: 1,
          },
          activeStatements: 0,
          recentQueries: [
            {
              sql: 'SELECT * FROM USERS',
              params: [],
              kind: 'query' as const,
              durationMs: 3.1,
              rowCount: 2,
              cacheHit: true,
              timestamp: 1000,
              io: { reads: 2, writes: 0, fetches: 18, marks: 0 },
            },
          ],
        })),
        query: vi.fn(async (sqlText: string) => {
          if (sqlText.includes('RDB$RELATIONS') && sqlText.includes('IN (?, ?, ?, ?)')) {
            return {
              fields: [{ name: 'REL_NAME' }],
              rows: [
                ['FB_REPL_JOURNAL$'],
                ['FB_REPL_SLOTS$'],
                ['FB_REPL_WATERMARKS$'],
                ['FB_REPL_DLQ$'],
              ],
            };
          }
          if (sqlText.includes('RDB$RELATIONS')) {
            return { fields: [{ name: 'X' }], rows: [[1]] };
          }
          if (sqlText.includes('FB_MIGRATIONS$')) {
            return {
              fields: [
                { name: 'VERSION' },
                { name: 'NAME' },
                { name: 'APPLIED_AT' },
              ],
              rows: [
                ['001', 'create_users', '2026-10-30T10:00:00.000Z'],
                ['002', 'add_email_index', '2026-10-31T12:00:00.000Z'],
              ],
            };
          }
          if (sqlText.includes('COUNT(*)') && sqlText.includes('FB_REPL_JOURNAL$')) {
            return {
              fields: [{ name: 'COUNT' }, { name: 'MIN' }, { name: 'MAX' }],
              rows: [[5, 2, 6]],
            };
          }
          if (sqlText.includes('FROM "FB_REPL_JOURNAL$"')) {
            return {
              fields: [
                { name: 'LSN' },
                { name: 'ORIGIN_NODE' },
                { name: 'TABLE_NAME' },
                { name: 'OP' },
                { name: 'PK_JSON' },
                { name: 'CREATED_AT' },
              ],
              rows: [
                [
                  6,
                  'node-a',
                  'USERS',
                  'I',
                  '{"ID":42}',
                  '2026-11-05T12:00:00.000Z',
                ],
              ],
            };
          }
          if (sqlText.includes('FROM "FB_REPL_SLOTS$"')) {
            return {
              fields: [
                { name: 'SLOT_NAME' },
                { name: 'NODE_ID' },
                { name: 'CONFIRMED_FLUSH_LSN' },
                { name: 'UPDATED_AT' },
              ],
              rows: [
                [
                  'slot_edge_1',
                  'edge-1',
                  4,
                  '2026-11-05T11:59:00.000Z',
                ],
              ],
            };
          }
          if (sqlText.includes('FROM "FB_REPL_WATERMARKS$"')) {
            return {
              fields: [
                { name: 'PEER_ID' },
                { name: 'LAST_LSN' },
                { name: 'UPDATED_AT' },
              ],
              rows: [['edge-1', 5, '2026-11-05T11:59:30.000Z']],
            };
          }
          if (sqlText.includes('FROM "FB_REPL_DLQ$"')) {
            return {
              fields: [
                { name: 'LSN' },
                { name: 'SUB_NAME' },
                { name: 'ERROR_MSG' },
                { name: 'RETRY_COUNT' },
                { name: 'QUARANTINED_AT' },
              ],
              rows: [[7, 'sub_edge_1', 'CHECK constraint failed', 2, '1730800001000']],
            };
          }
          if (sqlText.includes('FROM RDB$PUBLICATIONS')) {
            return {
              fields: [
                { name: 'PUB_NAME' },
                { name: 'ACTIVE_FLAG' },
                { name: 'AUTO_ENABLE' },
              ],
              rows: [['RDB$DEFAULT', 1, 1]],
            };
          }
          if (sqlText.includes('FROM RDB$PUBLICATION_TABLES')) {
            return {
              fields: [{ name: 'TABLE_NAME' }],
              rows: [['ORGS'], ['USERS']],
            };
          }
          if (sqlText.includes("RDB$GET_CONTEXT('SYSTEM', 'REPLICA_MODE')")) {
            return {
              fields: [{ name: 'REPL_MODE' }, { name: 'REPL_SEQ' }],
              rows: [['NONE', 12]],
            };
          }
          return { fields: [], rows: [] };
        }),
        transaction: vi.fn(async (fn) =>
          fn({ exec: async () => ({ affectedRows: 1 }) }),
        ),
      };

      el.db = fakeDb;
      expect(el.inspectorOpen).toBe(false);

      // 1. Inspect schema via el.schema()
      let schemaEventDetail: ReplEntry | undefined;
      el.addEventListener('firebird-repl-schema', ((ev: { detail: ReplEntry }) => {
        schemaEventDetail = ev.detail;
      }) as unknown as EventListener);

      const schemaEntry = await el.schema();
      expect(schemaEntry?.schema).toEqual(fakeSchema);
      expect(schemaEventDetail?.schema).toEqual(fakeSchema);
      expect(el.inspectorOpen).toBe(true);
      expect(el.inspectorTab).toBe('schema');

      const inspectorNode = el.shadowRoot.findByClass('inspector')!;
      expect(inspectorNode.hidden).toBe(false);
      expect(inspectorNode.allText()).toContain('USERS');
      expect(inspectorNode.allText()).toContain('VARCHAR(120)');
      expect(inspectorNode.allText()).toContain('FK_USERS_ORG');
      expect(inspectorNode.allText()).toContain('IDX_USERS_EMAIL');
      expect(inspectorNode.allText()).toContain('TRG_USERS_BI');
      expect(inspectorNode.allText()).toContain('ACTIVE_USERS');
      expect(inspectorNode.allText()).toContain('GEN_USER_ID');

      // Clicking the SELECT button on USERS populates the SQL editor
      const queryBtn = inspectorNode.findByClass('schema-query-btn')!;
      queryBtn.dispatchEvent({
        type: 'click',
        preventDefault() {},
        stopPropagation() {},
      } as unknown as { type: string });
      expect(el.value).toBe('SELECT * FROM USERS;');

      // 2. Inspect migrations via el.migrations()
      let migrationsEventDetail: ReplEntry | undefined;
      el.addEventListener('firebird-repl-migrations', ((ev: {
        detail: ReplEntry;
      }) => {
        migrationsEventDetail = ev.detail;
      }) as unknown as EventListener);

      const migEntry = await el.migrations();
      expect(migEntry?.migrations).toEqual([
        {
          version: '001',
          name: 'create_users',
          appliedAt: '2026-10-30T10:00:00.000Z',
        },
        {
          version: '002',
          name: 'add_email_index',
          appliedAt: '2026-10-31T12:00:00.000Z',
        },
      ]);
      expect(migrationsEventDetail?.migrations).toHaveLength(2);
      expect(el.inspectorOpen).toBe(true);
      expect(el.inspectorTab).toBe('migrations');
      expect(inspectorNode.allText()).toContain('Current version: 002 · 2 applied');
      expect(inspectorNode.allText()).toContain('create_users');
      expect(inspectorNode.allText()).toContain('add_email_index');

      // 3. Inspect profiler telemetry & Per-Table Page I/O Flamegraph via el.profiler()
      let profilerEventDetail: ReplEntry | undefined;
      el.addEventListener('firebird-repl-profiler', ((ev: {
        detail: ReplEntry;
      }) => {
        profilerEventDetail = ev.detail;
      }) as unknown as EventListener);

      const profEntry = await el.profiler();
      expect(profEntry?.stats?.totalQueries).toBe(2);
      expect(profEntry?.stats?.totalExecs).toBe(1);
      expect(profEntry?.stats?.prepareCacheHits).toBe(2);
      expect(profilerEventDetail?.stats?.io.fetches).toBe(120);
      expect(el.inspectorOpen).toBe(true);
      expect(el.inspectorTab).toBe('profiler');
      expect(inspectorNode.allText()).toContain('3 queries');
      expect(inspectorNode.allText()).toContain('cache 66.7% (2/3)');
      expect(inspectorNode.allText()).toContain('Per-Table Page I/O Flamegraph');
      expect(inspectorNode.allText()).toContain('fetches: 18 · reads: 2');
      expect(inspectorNode.allText()).toContain('SELECT * FROM USERS');
      expect(inspectorNode.allText()).toContain('cached');

      // 4. Explain query -> opens 'plan' tab with interactive Plan Tree + Cost Flamegraph
      const explainEntries = await el.explain(
        'SELECT * FROM USERS JOIN ORGS ON ORGS.ID = USERS.ID;',
      );
      expect(explainEntries).toHaveLength(1);
      expect(explainEntries[0]?.planTree?.tables).toEqual(['USERS', 'ORGS']);
      expect(el.inspectorOpen).toBe(true);
      expect(el.inspectorTab).toBe('plan');
      expect(inspectorNode.allText()).toContain('Cost Flamegraph:');
      expect(inspectorNode.allText()).toContain('Plan Tree:');
      expect(inspectorNode.allText()).toContain('NATURAL SCAN');
      expect(inspectorNode.allText()).toContain('INDEX: IDX_USERS_EMAIL');
      expect(inspectorNode.allText()).toContain('Full table scan (NATURAL) on ORGS');

      // 5. Inspect replication topology, slots, watermarks & lag via el.replication()
      el.replicator = {
        stats: async () => ({
          status: 'idle' as const,
          primaryLsn: 6,
          replicaWatermark: 5,
          lagEntries: 1,
          lagMs: 45,
          totalFetched: 5,
          totalApplied: 5,
          totalConflicts: 1,
          bytesTransferred: 512,
          lastSyncedAt: 1730800000000,
        }),
      };

      let replicationEventDetail: ReplEntry | undefined;
      el.addEventListener('firebird-repl-replication', ((ev: {
        detail: ReplEntry;
      }) => {
        replicationEventDetail = ev.detail;
      }) as unknown as EventListener);

      const replEntry = await el.replication();
      expect(replEntry?.replication?.journalTableExists).toBe(true);
      expect(replEntry?.replication?.journalEntryCount).toBe(5);
      expect(replEntry?.replication?.minJournalLsn).toBe(2);
      expect(replEntry?.replication?.maxJournalLsn).toBe(6);
      expect(replEntry?.replication?.slots).toHaveLength(1);
      expect(replEntry?.replication?.slots[0]?.slotName).toBe('slot_edge_1');
      expect(replEntry?.replication?.watermarks).toHaveLength(1);
      expect(replEntry?.replication?.dlqTableExists).toBe(true);
      expect(replEntry?.replication?.dlqEntryCount).toBe(1);
      expect(replEntry?.replication?.dlqEntries?.[0]?.errorMessage).toBe(
        'CHECK constraint failed',
      );
      expect(replEntry?.replication?.liveStats?.lagEntries).toBe(1);
      expect(replicationEventDetail?.replication?.journalEntryCount).toBe(5);
      expect(el.inspectorOpen).toBe(true);
      expect(el.inspectorTab).toBe('replication');
      expect(inspectorNode.allText()).toContain(
        'Journal: 5 entries (LSN 2 → 6) · 1 slot · 1 watermark · 1 DLQ',
      );
      expect(inspectorNode.allText()).toContain('1 entries / 45 ms');
      expect(inspectorNode.allText()).toContain('slot_edge_1');
      expect(inspectorNode.allText()).toContain('ack LSN 4 · lag 2');
      expect(inspectorNode.allText()).toContain('#6');
      expect(inspectorNode.allText()).toContain('Dead-Letter Queue (1)');
      expect(inspectorNode.allText()).toContain('CHECK constraint failed');
      expect(replEntry?.replication?.enginePublication).toEqual({
        name: 'RDB$DEFAULT',
        active: true,
        autoEnable: true,
        publishedTables: ['ORGS', 'USERS'],
        replicaMode: 'NONE',
        replicationSequence: 12,
      });
      expect(inspectorNode.allText()).toContain('Native Engine Publication (RDB$PUBLICATIONS):');
      expect(inspectorNode.allText()).toContain('RDB$DEFAULT (ACTIVE · INCLUDE ALL)');
      expect(inspectorNode.allText()).toContain('ORGS, USERS');
      expect(inspectorNode.allText()).toContain('NONE / seq 12');

      // 6. Toggle inspector closed
      await el.toggleInspector('replication');
      expect(el.inspectorOpen).toBe(false);
      expect(inspectorNode.hidden).toBe(true);
    } finally {
      delete g['HTMLElement'];
      delete g['CustomEvent'];
      delete g['customElements'];
      delete g['document'];
    }
  });
});
