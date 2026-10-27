import {
  DEFAULT_MIGRATIONS_TABLE,
  decodeFirebirdTriggerType,
  formatFirebirdColumnType,
  getAppliedMigrations,
  introspect,
  migrate,
} from '../browser/schema';
import type {
  MigratableDatabase,
  Migration,
  MigrationExecutor,
  QueryParams,
  QueryResult,
  Row,
} from '../types';

class MockCatalogDb implements MigratableDatabase {
  readonly executed: Array<{ sql: string; params: QueryParams }> = [];
  readonly appliedRows: Array<{
    SEQ: number;
    VERSION: string;
    NAME: string | null;
    APPLIED_AT: string;
  }> = [];
  hasMigrationsTable = false;
  failOnSqlPattern?: RegExp;
  txCount = 0;
  commitCount = 0;
  rollbackCount = 0;

  async query<T extends Row = Row>(
    sql: string,
    params: QueryParams = [],
  ): Promise<QueryResult<T>> {
    this.executed.push({ sql, params });

    if (sql.includes('FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?')) {
      const target = String(params[0] ?? '').toUpperCase();
      if (target === DEFAULT_MIGRATIONS_TABLE || target === 'CUSTOM_MIGRATIONS') {
        return {
          rows: (this.hasMigrationsTable ? [{ X: 1 }] : []) as unknown as T[],
          fields: [],
        };
      }
      return { rows: [], fields: [] };
    }

    if (sql.startsWith('SELECT VERSION, NAME, APPLIED_AT FROM')) {
      const sorted = [...this.appliedRows].sort((a, b) => a.SEQ - b.SEQ);
      return {
        rows: sorted as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes('FROM RDB$RELATIONS')) {
      return {
        rows: [
          { REL_NAME: 'RDB$DATABASE', IS_VIEW: 0, VIEW_SOURCE: null, SYS_FLAG: 1 },
          { REL_NAME: 'FB_MIGRATIONS$', IS_VIEW: 0, VIEW_SOURCE: null, SYS_FLAG: 0 },
          { REL_NAME: 'USERS', IS_VIEW: 0, VIEW_SOURCE: null, SYS_FLAG: 0 },
          { REL_NAME: 'POSTS', IS_VIEW: 0, VIEW_SOURCE: null, SYS_FLAG: 0 },
          {
            REL_NAME: 'ACTIVE_USERS',
            IS_VIEW: 1,
            VIEW_SOURCE: 'SELECT ID, EMAIL FROM USERS',
            SYS_FLAG: 0,
          },
        ] as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes("WHERE c.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      return {
        rows: [
          {
            REL_NAME: 'USERS',
            CONST_NAME: 'INTEG_1',
            IDX_NAME: 'RDB$PRIMARY1',
            FIELD_NAME: 'ID',
            FIELD_POS: 0,
          },
          {
            REL_NAME: 'POSTS',
            CONST_NAME: 'PK_POSTS',
            IDX_NAME: 'PK_POSTS',
            FIELD_NAME: 'USER_ID',
            FIELD_POS: 0,
          },
          {
            REL_NAME: 'POSTS',
            CONST_NAME: 'PK_POSTS',
            IDX_NAME: 'PK_POSTS',
            FIELD_NAME: 'SLUG',
            FIELD_POS: 1,
          },
        ] as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes('FROM RDB$RELATION_FIELDS rf')) {
      return {
        rows: [
          {
            REL_NAME: 'USERS',
            FIELD_NAME: 'ID',
            FIELD_POS: 0,
            FIELD_TYPE: 8,
            FIELD_SUB_TYPE: 0,
            FIELD_SCALE: 0,
            FIELD_PRECISION: 0,
            FIELD_LEN: 4,
            NULL_FLAG: 1,
            DEFAULT_SRC: null,
            IS_IDENTITY: 1,
            IS_COMPUTED: 0,
          },
          {
            REL_NAME: 'USERS',
            FIELD_NAME: 'EMAIL',
            FIELD_POS: 1,
            FIELD_TYPE: 37,
            FIELD_SUB_TYPE: 0,
            FIELD_SCALE: 0,
            FIELD_PRECISION: 0,
            FIELD_LEN: 120,
            NULL_FLAG: 1,
            DEFAULT_SRC: null,
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
          {
            REL_NAME: 'USERS',
            FIELD_NAME: 'BALANCE',
            FIELD_POS: 2,
            FIELD_TYPE: 16,
            FIELD_SUB_TYPE: 1,
            FIELD_SCALE: -2,
            FIELD_PRECISION: 12,
            FIELD_LEN: 8,
            NULL_FLAG: 0,
            DEFAULT_SRC: 'DEFAULT 0.00',
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
          {
            REL_NAME: 'POSTS',
            FIELD_NAME: 'USER_ID',
            FIELD_POS: 0,
            FIELD_TYPE: 8,
            FIELD_SUB_TYPE: 0,
            FIELD_SCALE: 0,
            FIELD_PRECISION: 0,
            FIELD_LEN: 4,
            NULL_FLAG: 1,
            DEFAULT_SRC: null,
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
          {
            REL_NAME: 'POSTS',
            FIELD_NAME: 'SLUG',
            FIELD_POS: 1,
            FIELD_TYPE: 37,
            FIELD_SUB_TYPE: 0,
            FIELD_SCALE: 0,
            FIELD_PRECISION: 0,
            FIELD_LEN: 64,
            NULL_FLAG: 1,
            DEFAULT_SRC: null,
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
          {
            REL_NAME: 'ACTIVE_USERS',
            FIELD_NAME: 'ID',
            FIELD_POS: 0,
            FIELD_TYPE: 8,
            FIELD_SUB_TYPE: 0,
            FIELD_SCALE: 0,
            FIELD_PRECISION: 0,
            FIELD_LEN: 4,
            NULL_FLAG: 1,
            DEFAULT_SRC: null,
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
          {
            REL_NAME: 'ACTIVE_USERS',
            FIELD_NAME: 'EMAIL',
            FIELD_POS: 1,
            FIELD_TYPE: 37,
            FIELD_SUB_TYPE: 0,
            FIELD_SCALE: 0,
            FIELD_PRECISION: 0,
            FIELD_LEN: 120,
            NULL_FLAG: 1,
            DEFAULT_SRC: null,
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
        ] as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes("WHERE c.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY'")) {
      return {
        rows: [
          {
            CONST_NAME: 'FK_POSTS_USER',
            REL_NAME: 'POSTS',
            FIELD_NAME: 'USER_ID',
            REF_REL_NAME: 'USERS',
            REF_FIELD_NAME: 'ID',
            UPDATE_RULE: 'CASCADE',
            DELETE_RULE: 'CASCADE',
            FIELD_POS: 0,
          },
        ] as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes('FROM RDB$INDICES i')) {
      return {
        rows: [
          {
            IDX_NAME: 'IDX_USERS_EMAIL',
            REL_NAME: 'USERS',
            UNIQUE_FLAG: 1,
            IDX_TYPE: 0,
            IDX_INACTIVE: 0,
            SYS_FLAG: 0,
            FIELD_NAME: 'EMAIL',
            FIELD_POS: 0,
          },
          {
            IDX_NAME: 'RDB$PRIMARY1',
            REL_NAME: 'USERS',
            UNIQUE_FLAG: 1,
            IDX_TYPE: 0,
            IDX_INACTIVE: 0,
            SYS_FLAG: 1,
            FIELD_NAME: 'ID',
            FIELD_POS: 0,
          },
        ] as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes('FROM RDB$GENERATORS')) {
      return {
        rows: [
          { GEN_NAME: 'RDB$PROCEDURES', INIT_VAL: 0, INC_VAL: 1, SYS_FLAG: 1 },
          { GEN_NAME: 'SEQ_AUDIT', INIT_VAL: 100, INC_VAL: 5, SYS_FLAG: 0 },
        ] as unknown as T[],
        fields: [],
      };
    }

    if (sql.includes('FROM RDB$TRIGGERS')) {
      return {
        rows: [
          {
            TRG_NAME: 'FB$LIVE_USERS_AI',
            REL_NAME: 'USERS',
            TRG_TYPE: 2,
            TRG_SEQ: 0,
            TRG_INACTIVE: 0,
            TRG_SOURCE: 'AS BEGIN POST_EVENT \'x\'; END',
            SYS_FLAG: 0,
          },
          {
            TRG_NAME: 'TRG_USERS_BIU',
            REL_NAME: 'USERS',
            TRG_TYPE: 17,
            TRG_SEQ: 10,
            TRG_INACTIVE: 0,
            TRG_SOURCE: 'AS BEGIN END',
            SYS_FLAG: 0,
          },
        ] as unknown as T[],
        fields: [],
      };
    }

    return { rows: [], fields: [] };
  }

  async exec(sql: string, params: QueryParams = []): Promise<{ affectedRows: number }> {
    if (this.failOnSqlPattern && this.failOnSqlPattern.test(sql)) {
      throw new Error(`Simulated failure on SQL: ${sql}`);
    }
    this.executed.push({ sql, params });
    if (sql.startsWith('CREATE TABLE "FB_MIGRATIONS$"') || sql.startsWith('CREATE TABLE "CUSTOM_MIGRATIONS"')) {
      this.hasMigrationsTable = true;
    } else if (sql.startsWith('INSERT INTO "FB_MIGRATIONS$"') || sql.startsWith('INSERT INTO "CUSTOM_MIGRATIONS"')) {
      this.appliedRows.push({
        SEQ: Number(params[0]),
        VERSION: String(params[1]),
        NAME: params[2] === null || params[2] === undefined ? null : String(params[2]),
        APPLIED_AT: String(params[3]),
      });
    } else if (sql.startsWith('DELETE FROM "FB_MIGRATIONS$"') || sql.startsWith('DELETE FROM "CUSTOM_MIGRATIONS"')) {
      const v = String(params[0]);
      const idx = this.appliedRows.findIndex((r) => r.VERSION === v);
      if (idx !== -1) this.appliedRows.splice(idx, 1);
    }
    return { affectedRows: 1 };
  }

  async transaction<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
    this.txCount += 1;
    const snapshot = [...this.appliedRows.map((r) => ({ ...r }))];
    const execSnapshotLen = this.executed.length;
    const hadTable = this.hasMigrationsTable;
    try {
      const res = await fn(this);
      this.commitCount += 1;
      return res;
    } catch (err) {
      this.rollbackCount += 1;
      this.appliedRows.length = 0;
      this.appliedRows.push(...snapshot);
      this.executed.length = execSnapshotLen;
      this.hasMigrationsTable = hadTable;
      throw err;
    }
  }
}

describe('schema introspection & migrations (unit)', () => {
  it('formats Firebird column types and decodes trigger bitmasks', () => {
    expect(formatFirebirdColumnType(7, 0, 0, 0, 2)).toEqual({
      dataType: 'SMALLINT',
      typeName: 'SMALLINT',
    });
    expect(formatFirebirdColumnType(8, 0, 0, 0, 4)).toEqual({
      dataType: 'INTEGER',
      typeName: 'INTEGER',
    });
    expect(formatFirebirdColumnType(16, 0, 0, 0, 8)).toEqual({
      dataType: 'BIGINT',
      typeName: 'BIGINT',
    });
    expect(formatFirebirdColumnType(16, 1, -2, 12, 8)).toEqual({
      dataType: 'NUMERIC',
      typeName: 'NUMERIC(12,2)',
    });
    expect(formatFirebirdColumnType(16, 2, -4, 18, 8)).toEqual({
      dataType: 'NUMERIC',
      typeName: 'DECIMAL(18,4)',
    });
    expect(formatFirebirdColumnType(14, 0, 0, 0, 10)).toEqual({
      dataType: 'TEXT',
      typeName: 'CHAR(10)',
    });
    expect(formatFirebirdColumnType(37, 0, 0, 0, 100)).toEqual({
      dataType: 'VARYING',
      typeName: 'VARCHAR(100)',
    });
    expect(formatFirebirdColumnType(261, 1, 0, 0, 8)).toEqual({
      dataType: 'BLOB',
      typeName: 'BLOB SUB_TYPE TEXT',
    });
    expect(formatFirebirdColumnType(261, 0, 0, 0, 8)).toEqual({
      dataType: 'BLOB',
      typeName: 'BLOB',
    });
    expect(formatFirebirdColumnType(23, 0, 0, 0, 1)).toEqual({
      dataType: 'BOOLEAN',
      typeName: 'BOOLEAN',
    });
    expect(formatFirebirdColumnType(35, 0, 0, 0, 8)).toEqual({
      dataType: 'TIMESTAMP',
      typeName: 'TIMESTAMP',
    });

    expect(decodeFirebirdTriggerType(1)).toEqual({
      timing: 'BEFORE',
      events: ['INSERT'],
    });
    expect(decodeFirebirdTriggerType(2)).toEqual({
      timing: 'AFTER',
      events: ['INSERT'],
    });
    expect(decodeFirebirdTriggerType(17)).toEqual({
      timing: 'BEFORE',
      events: ['INSERT', 'UPDATE'],
    });
    expect(decodeFirebirdTriggerType(114)).toEqual({
      timing: 'AFTER',
      events: ['INSERT', 'UPDATE', 'DELETE'],
    });
    expect(decodeFirebirdTriggerType(8192)).toEqual({
      timing: 'ON CONNECT',
      events: ['CONNECT'],
    });
  });

  it('introspects tables, views, columns, primaryKeys, foreignKeys, indexes, sequences, and triggers', async () => {
    const db = new MockCatalogDb();
    const schema = await introspect(db);

    expect(schema.tables.map((t) => t.name)).toEqual(['USERS', 'POSTS']);
    expect(schema.views).toEqual([
      {
        name: 'ACTIVE_USERS',
        source: 'SELECT ID, EMAIL FROM USERS',
        columns: expect.arrayContaining([
          expect.objectContaining({ name: 'ID', typeName: 'INTEGER' }),
          expect.objectContaining({ name: 'EMAIL', typeName: 'VARCHAR(120)' }),
        ]),
      },
    ]);

    const users = schema.tables.find((t) => t.name === 'USERS')!;
    expect(users.primaryKey).toEqual(['ID']);
    expect(users.columns.map((c) => ({
      name: c.name,
      typeName: c.typeName,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
      isIdentity: c.isIdentity,
      defaultSource: c.defaultSource,
    }))).toEqual([
      {
        name: 'ID',
        typeName: 'INTEGER',
        nullable: false,
        isPrimaryKey: true,
        isIdentity: true,
        defaultSource: null,
      },
      {
        name: 'EMAIL',
        typeName: 'VARCHAR(120)',
        nullable: false,
        isPrimaryKey: false,
        isIdentity: false,
        defaultSource: null,
      },
      {
        name: 'BALANCE',
        typeName: 'NUMERIC(12,2)',
        nullable: true,
        isPrimaryKey: false,
        isIdentity: false,
        defaultSource: 'DEFAULT 0.00',
      },
    ]);
    expect(users.indexes).toEqual([
      {
        name: 'IDX_USERS_EMAIL',
        tableName: 'USERS',
        columns: ['EMAIL'],
        unique: true,
        descending: false,
        inactive: false,
      },
    ]);
    expect(users.triggers).toEqual([
      {
        name: 'TRG_USERS_BIU',
        tableName: 'USERS',
        triggerType: 17,
        timing: 'BEFORE',
        events: ['INSERT', 'UPDATE'],
        sequence: 10,
        inactive: false,
        source: 'AS BEGIN END',
      },
    ]);

    const posts = schema.tables.find((t) => t.name === 'POSTS')!;
    expect(posts.primaryKey).toEqual(['USER_ID', 'SLUG']);
    expect(posts.foreignKeys).toEqual([
      {
        name: 'FK_POSTS_USER',
        tableName: 'POSTS',
        columns: ['USER_ID'],
        referencedTableName: 'USERS',
        referencedColumns: ['ID'],
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
    ]);

    expect(schema.sequences).toEqual([
      { name: 'SEQ_AUDIT', initialValue: 100, increment: 5 },
    ]);

    // Filter by single tableName
    const filtered = await introspect(db, { tableName: 'posts' });
    expect(filtered.tables.map((t) => t.name)).toEqual(['POSTS']);
    expect(filtered.views).toEqual([]);
  });

  it('applies, skips, rolls back on error, and reverts migrations via migrate()', async () => {
    const db = new MockCatalogDb();
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'create_users',
        up: 'CREATE TABLE users (id INTEGER NOT NULL PRIMARY KEY, email VARCHAR(120) NOT NULL);',
        down: 'DROP TABLE users;',
      },
      {
        version: 2,
        name: 'create_posts',
        up: [
          'CREATE TABLE posts (id INTEGER NOT NULL PRIMARY KEY, user_id INTEGER NOT NULL)',
          'CREATE INDEX idx_posts_user ON posts (user_id)',
        ],
        down: ['DROP INDEX idx_posts_user', 'DROP TABLE posts'],
      },
      {
        version: 3,
        name: 'seed_admin',
        up: async (tx) => {
          await tx.exec("INSERT INTO users (id, email) VALUES (1, 'admin@example.com')");
        },
        down: async (tx) => {
          await tx.exec('DELETE FROM users WHERE id = 1');
        },
      },
    ];

    // Migrate up to targetVersion 2
    const r1 = await migrate(db, migrations, { targetVersion: 2 });
    expect(r1.applied.map((m) => m.version)).toEqual(['1', '2']);
    expect(r1.currentVersion).toBe('2');
    expect(r1.history.map((m) => m.version)).toEqual(['1', '2']);

    // Running remaining migrations applies only version 3
    const r2 = await migrate(db, migrations);
    expect(r2.applied.map((m) => m.version)).toEqual(['3']);
    expect(r2.currentVersion).toBe('3');

    // Re-running when all are applied is a no-op
    const r3 = await migrate(db, migrations);
    expect(r3.applied).toEqual([]);
    expect(r3.currentVersion).toBe('3');

    // Revert the latest migration (direction: 'down' without targetVersion)
    const down1 = await migrate(db, migrations, { direction: 'down' });
    expect(down1.reverted.map((m) => m.version)).toEqual(['3']);
    expect(down1.currentVersion).toBe('2');

    // Revert all remaining migrations (targetVersion: 0)
    const downAll = await migrate(db, migrations, {
      direction: 'down',
      targetVersion: 0,
    });
    expect(downAll.reverted.map((m) => m.version)).toEqual(['2', '1']);
    expect(downAll.currentVersion).toBeNull();
    expect(await getAppliedMigrations(db)).toEqual([]);

    // Atomic rollback when a migration fails mid-way
    db.failOnSqlPattern = /CREATE INDEX idx_posts_user/;
    await expect(migrate(db, migrations)).rejects.toThrow(/Simulated failure/);
    const afterFail = await getAppliedMigrations(db);
    expect(afterFail.map((m) => m.version)).toEqual(['1']);
    expect(db.rollbackCount).toBe(1);
  });

  it('validates duplicate versions and invalid table names', async () => {
    const db = new MockCatalogDb();
    await expect(
      migrate(db, [
        { version: 1, up: 'SELECT 1 FROM RDB$DATABASE' },
        { version: '1', up: 'SELECT 1 FROM RDB$DATABASE' },
      ]),
    ).rejects.toThrow(/Duplicate migration version "1"/);

    await expect(
      migrate(db, [], { tableName: 'bad table; DROP TABLE x' }),
    ).rejects.toThrow(/Invalid migrations table name/);
  });
});
