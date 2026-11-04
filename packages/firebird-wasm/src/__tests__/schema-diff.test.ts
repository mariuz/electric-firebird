import { diffSchema, generateMigration } from '../browser/schema';
import type { SchemaIntrospection } from '../types';

function emptySchema(overrides: Partial<SchemaIntrospection> = {}): SchemaIntrospection {
  return {
    tables: [],
    views: [],
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    indexes: [],
    sequences: [],
    triggers: [],
    ...overrides,
  };
}

describe('diffSchema & generateMigration – Schema Diff & Automatic Migration Generator', () => {
  it('returns hasChanges: false and empty statements when two schemas are identical', async () => {
    const schema = emptySchema({
      tables: [
        {
          name: 'USERS',
          columns: [
            {
              tableName: 'USERS',
              name: 'ID',
              position: 0,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
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
          ],
          primaryKey: ['ID'],
          foreignKeys: [],
          indexes: [],
          triggers: [],
        },
      ],
      primaryKeys: [
        {
          tableName: 'USERS',
          constraintName: 'PK_USERS',
          indexName: 'PK_USERS',
          columns: ['ID'],
        },
      ],
    });

    const diff = await diffSchema(schema, schema);
    expect(diff.hasChanges).toBe(false);
    expect(diff.upStatements).toEqual([]);
    expect(diff.downStatements).toEqual([]);
  });

  it('detects added/removed/modified tables, columns, sequences, indexes, foreign keys, views, and triggers and emits symmetric up/down DDL', async () => {
    const schemaV1 = emptySchema({
      sequences: [{ name: 'SEQ_OLD', initialValue: 0, increment: 1 }],
      tables: [
        {
          name: 'USERS',
          columns: [
            {
              tableName: 'USERS',
              name: 'ID',
              position: 0,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
              fieldType: 8,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 4,
              nullable: false,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: true,
            },
            {
              tableName: 'USERS',
              name: 'NAME',
              position: 1,
              typeName: 'VARCHAR(50)',
              dataType: 'VARYING',
              fieldType: 37,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 50,
              nullable: true,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: false,
            },
            {
              tableName: 'USERS',
              name: 'LEGACY_COL',
              position: 2,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
              fieldType: 8,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 4,
              nullable: true,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: false,
            },
          ],
          primaryKey: ['ID'],
          foreignKeys: [],
          indexes: [],
          triggers: [],
        },
        {
          name: 'OBSOLETE_TABLE',
          columns: [
            {
              tableName: 'OBSOLETE_TABLE',
              name: 'ID',
              position: 0,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
              fieldType: 8,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 4,
              nullable: false,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: true,
            },
          ],
          primaryKey: ['ID'],
          foreignKeys: [],
          indexes: [],
          triggers: [],
        },
      ],
      primaryKeys: [
        {
          tableName: 'USERS',
          constraintName: 'PK_USERS',
          indexName: 'PK_USERS',
          columns: ['ID'],
        },
      ],
    });

    const schemaV2 = emptySchema({
      sequences: [{ name: 'SEQ_ORDERS', initialValue: 100, increment: 5 }],
      tables: [
        {
          name: 'USERS',
          columns: [
            {
              tableName: 'USERS',
              name: 'ID',
              position: 0,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
              fieldType: 8,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 4,
              nullable: false,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: true,
            },
            {
              tableName: 'USERS',
              name: 'NAME',
              position: 1,
              typeName: 'VARCHAR(120)',
              dataType: 'VARYING',
              fieldType: 37,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 120,
              nullable: false,
              defaultSource: "DEFAULT 'anon'",
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: false,
            },
            {
              tableName: 'USERS',
              name: 'EMAIL',
              position: 2,
              typeName: 'VARCHAR(255)',
              dataType: 'VARYING',
              fieldType: 37,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 255,
              nullable: false,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: false,
            },
          ],
          primaryKey: ['ID'],
          foreignKeys: [],
          indexes: [],
          triggers: [],
        },
        {
          name: 'ORDERS',
          columns: [
            {
              tableName: 'ORDERS',
              name: 'ID',
              position: 0,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
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
              tableName: 'ORDERS',
              name: 'USER_ID',
              position: 1,
              typeName: 'INTEGER',
              dataType: 'INTEGER',
              fieldType: 8,
              subType: 0,
              scale: 0,
              precision: 0,
              length: 4,
              nullable: false,
              defaultSource: null,
              isIdentity: false,
              isComputed: false,
              isPrimaryKey: false,
            },
          ],
          primaryKey: ['ID'],
          foreignKeys: [],
          indexes: [],
          triggers: [],
        },
      ],
      primaryKeys: [
        {
          tableName: 'USERS',
          constraintName: 'PK_USERS',
          indexName: 'PK_USERS',
          columns: ['ID'],
        },
        {
          tableName: 'ORDERS',
          constraintName: 'PK_ORDERS',
          indexName: 'PK_ORDERS',
          columns: ['ID'],
        },
      ],
      foreignKeys: [
        {
          name: 'FK_ORDERS_USER',
          tableName: 'ORDERS',
          columns: ['USER_ID'],
          referencedTableName: 'USERS',
          referencedColumns: ['ID'],
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        },
      ],
      indexes: [
        {
          name: 'IDX_USERS_EMAIL',
          tableName: 'USERS',
          columns: ['EMAIL'],
          unique: true,
          descending: false,
          inactive: false,
        },
      ],
      views: [
        {
          name: 'V_ACTIVE_USERS',
          columns: [],
          source: 'SELECT ID, NAME, EMAIL FROM USERS',
        },
      ],
      triggers: [
        {
          name: 'TRG_USERS_AI',
          tableName: 'USERS',
          triggerType: 1,
          timing: 'AFTER',
          events: ['INSERT'],
          sequence: 0,
          inactive: false,
          source: "AS BEGIN POST_EVENT 'users_changed'; END",
        },
      ],
    });

    const migration = await generateMigration(schemaV1, schemaV2, {
      version: '20261105_001',
      name: 'add_orders_and_user_email',
    });

    expect(migration.version).toBe('20261105_001');
    expect(migration.name).toBe('add_orders_and_user_email');
    expect(migration.diff.hasChanges).toBe(true);

    // Verify UP statements
    expect(migration.up).toContain('ALTER TABLE USERS DROP LEGACY_COL');
    expect(migration.up).toContain('DROP TABLE OBSOLETE_TABLE');
    expect(migration.up).toContain('CREATE SEQUENCE SEQ_ORDERS START WITH 100 INCREMENT BY 5');
    expect(migration.up.some((s) => s.startsWith('CREATE TABLE ORDERS ('))).toBe(true);
    expect(migration.up).toContain('ALTER TABLE USERS ADD EMAIL VARCHAR(255) NOT NULL');
    expect(migration.up).toContain('ALTER TABLE USERS ALTER COLUMN NAME TYPE VARCHAR(120)');
    expect(migration.up).toContain("ALTER TABLE USERS ALTER COLUMN NAME SET DEFAULT 'anon'");
    expect(migration.up).toContain('ALTER TABLE USERS ALTER COLUMN NAME SET NOT NULL');
    expect(migration.up).toContain('CREATE UNIQUE INDEX IDX_USERS_EMAIL ON USERS (EMAIL)');
    expect(migration.up).toContain(
      'ALTER TABLE ORDERS ADD CONSTRAINT FK_ORDERS_USER FOREIGN KEY (USER_ID) REFERENCES USERS (ID) ON DELETE CASCADE',
    );
    expect(migration.up).toContain(
      'CREATE OR ALTER VIEW V_ACTIVE_USERS AS\nSELECT ID, NAME, EMAIL FROM USERS',
    );
    expect(migration.up).toContain('DROP SEQUENCE SEQ_OLD');

    // Verify DOWN statements reverse the migration
    expect(migration.down).toContain('DROP TRIGGER TRG_USERS_AI');
    expect(migration.down).toContain('DROP VIEW V_ACTIVE_USERS');
    expect(migration.down).toContain('ALTER TABLE ORDERS DROP CONSTRAINT FK_ORDERS_USER');
    expect(migration.down).toContain('DROP INDEX IDX_USERS_EMAIL');
    expect(migration.down).toContain('ALTER TABLE USERS DROP EMAIL');
    expect(migration.down).toContain('DROP TABLE ORDERS');
    expect(migration.down).toContain('CREATE SEQUENCE SEQ_OLD');
    expect(migration.down.some((s) => s.startsWith('CREATE TABLE OBSOLETE_TABLE ('))).toBe(true);
    expect(migration.down).toContain('ALTER TABLE USERS ADD LEGACY_COL INTEGER');
    expect(migration.down).toContain('ALTER TABLE USERS ALTER COLUMN NAME TYPE VARCHAR(50)');
    expect(migration.down).toContain('ALTER TABLE USERS ALTER COLUMN NAME DROP DEFAULT');
    expect(migration.down).toContain('ALTER TABLE USERS ALTER COLUMN NAME DROP NOT NULL');
    expect(migration.down).toContain('DROP SEQUENCE SEQ_ORDERS');
  });
});
