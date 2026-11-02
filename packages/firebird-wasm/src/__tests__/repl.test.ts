/**
 * repl.test.ts – unit tests for the <firebird-repl> custom element, including
 * the Interactive Schema Inspector & Migration Viewer.
 */

import type { FirebirdBrowser } from '../browser/firebird-browser';
import type {
  FirebirdReplElement,
  ReplDatabase,
  ReplEntry,
} from '../repl';
import type { SchemaIntrospection } from '../types';

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

  it('renders the interactive Schema Inspector & Migration Viewer sidebar and logs schema/migration entries', async () => {
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
        describeQuery: jest.fn(async () => ({ hasResultSet: true })),
        introspect: jest.fn(async () => fakeSchema),
        monitorStats: jest.fn(async () => ({
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
              io: { reads: 0, writes: 0, fetches: 4, marks: 0 },
            },
          ],
        })),
        query: jest.fn(async (sqlText: string) => {
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
          return { fields: [], rows: [] };
        }),
        transaction: jest.fn(async (fn) =>
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

      // 3. Inspect profiler telemetry via el.profiler()
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
      expect(inspectorNode.allText()).toContain('SELECT * FROM USERS');
      expect(inspectorNode.allText()).toContain('cached');

      // 4. Toggle inspector closed
      await el.toggleInspector('profiler');
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
