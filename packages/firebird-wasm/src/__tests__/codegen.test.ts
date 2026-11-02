import * as ts from 'typescript';
import {
  drizzle,
  generateDrizzleSchema,
  generateDrizzleSchemaFromCatalog,
} from '../drizzle';
import type { FirebirdDrizzleClient, FirebirdDrizzleTransactionClient } from '../drizzle';
import {
  generateKyselyTypes,
  generateKyselyTypesFromCatalog,
} from '../kysely';
import type {
  ArrayRow,
  ColumnSchemaInfo,
  ForeignKeySchemaInfo,
  IndexSchemaInfo,
  QueryParams,
  QueryResult,
  Row,
  SchemaIntrospection,
  TransactionOptions,
} from '../types';

function makeCol(
  overrides: Partial<ColumnSchemaInfo> & Pick<ColumnSchemaInfo, 'tableName' | 'name' | 'dataType'>,
): ColumnSchemaInfo {
  return {
    position: 0,
    typeName: overrides.dataType,
    fieldType: 8,
    subType: 0,
    scale: 0,
    precision: 0,
    length: 0,
    nullable: true,
    defaultSource: null,
    isIdentity: false,
    isComputed: false,
    isPrimaryKey: false,
    ...overrides,
  };
}

function buildRichCatalog(): SchemaIntrospection {
  const usersCols: ColumnSchemaInfo[] = [
    makeCol({
      tableName: 'USERS',
      name: 'ID',
      position: 0,
      dataType: 'INTEGER',
      typeName: 'INTEGER',
      nullable: false,
      isIdentity: true,
      isPrimaryKey: true,
    }),
    makeCol({
      tableName: 'USERS',
      name: 'EMAIL',
      position: 1,
      dataType: 'VARYING',
      typeName: 'VARCHAR(120)',
      fieldType: 37,
      length: 120,
      nullable: false,
    }),
    makeCol({
      tableName: 'USERS',
      name: 'COUNTRY_CODE',
      position: 2,
      dataType: 'TEXT',
      typeName: 'CHAR(2)',
      fieldType: 14,
      length: 2,
      nullable: false,
      defaultSource: "DEFAULT 'US'",
    }),
    makeCol({
      tableName: 'USERS',
      name: 'IS_ACTIVE',
      position: 3,
      dataType: 'BOOLEAN',
      typeName: 'BOOLEAN',
      fieldType: 23,
      nullable: false,
      defaultSource: 'DEFAULT TRUE',
    }),
    makeCol({
      tableName: 'USERS',
      name: 'BIO',
      position: 4,
      dataType: 'BLOB',
      typeName: 'BLOB SUB_TYPE TEXT',
      fieldType: 261,
      subType: 1,
      nullable: true,
    }),
    makeCol({
      tableName: 'USERS',
      name: 'AVATAR',
      position: 5,
      dataType: 'BLOB',
      typeName: 'BLOB',
      fieldType: 261,
      subType: 0,
      nullable: true,
    }),
    makeCol({
      tableName: 'USERS',
      name: 'MANAGER_ID',
      position: 6,
      dataType: 'INTEGER',
      typeName: 'INTEGER',
      nullable: true,
    }),
    makeCol({
      tableName: 'USERS',
      name: 'CREATED_AT',
      position: 7,
      dataType: 'TIMESTAMP',
      typeName: 'TIMESTAMP',
      fieldType: 35,
      nullable: false,
      defaultSource: 'DEFAULT CURRENT_TIMESTAMP',
    }),
  ];

  const ordersCols: ColumnSchemaInfo[] = [
    makeCol({
      tableName: 'ORDERS',
      name: 'ID',
      position: 0,
      dataType: 'BIGINT',
      typeName: 'BIGINT',
      fieldType: 16,
      nullable: false,
      isIdentity: true,
      isPrimaryKey: true,
    }),
    makeCol({
      tableName: 'ORDERS',
      name: 'USER_ID',
      position: 1,
      dataType: 'INTEGER',
      typeName: 'INTEGER',
      nullable: false,
    }),
    makeCol({
      tableName: 'ORDERS',
      name: 'SUBTOTAL',
      position: 2,
      dataType: 'NUMERIC',
      typeName: 'NUMERIC(10,2)',
      fieldType: 16,
      subType: 1,
      precision: 10,
      scale: -2,
      nullable: false,
      defaultSource: 'DEFAULT 0.00',
    }),
    makeCol({
      tableName: 'ORDERS',
      name: 'DISCOUNT_RATE',
      position: 3,
      dataType: 'DOUBLE',
      typeName: 'DOUBLE PRECISION',
      fieldType: 27,
      nullable: false,
      defaultSource: 'DEFAULT 0',
    }),
    makeCol({
      tableName: 'ORDERS',
      name: 'GRAND_TOTAL',
      position: 4,
      dataType: 'NUMERIC',
      typeName: 'NUMERIC(10,2)',
      fieldType: 16,
      subType: 1,
      precision: 10,
      scale: -2,
      nullable: true,
      isComputed: true,
    }),
  ];

  const orderItemsCols: ColumnSchemaInfo[] = [
    makeCol({
      tableName: 'ORDER_ITEMS',
      name: 'ORDER_ID',
      position: 0,
      dataType: 'BIGINT',
      typeName: 'BIGINT',
      fieldType: 16,
      nullable: false,
      isPrimaryKey: true,
    }),
    makeCol({
      tableName: 'ORDER_ITEMS',
      name: 'LINE_NO',
      position: 1,
      dataType: 'SMALLINT',
      typeName: 'SMALLINT',
      fieldType: 7,
      nullable: false,
      isPrimaryKey: true,
    }),
    makeCol({
      tableName: 'ORDER_ITEMS',
      name: 'SKU',
      position: 2,
      dataType: 'VARYING',
      typeName: 'VARCHAR(64)',
      fieldType: 37,
      length: 64,
      nullable: false,
    }),
  ];

  const usersFks: ForeignKeySchemaInfo[] = [
    {
      name: 'FK_USERS_MANAGER',
      tableName: 'USERS',
      columns: ['MANAGER_ID'],
      referencedTableName: 'USERS',
      referencedColumns: ['ID'],
      onUpdate: 'NO ACTION',
      onDelete: 'SET NULL',
    },
  ];

  const ordersFks: ForeignKeySchemaInfo[] = [
    {
      name: 'FK_ORDERS_USER',
      tableName: 'ORDERS',
      columns: ['USER_ID'],
      referencedTableName: 'USERS',
      referencedColumns: ['ID'],
      onUpdate: 'RESTRICT',
      onDelete: 'CASCADE',
    },
  ];

  const orderItemsFks: ForeignKeySchemaInfo[] = [
    {
      name: 'FK_ORDER_ITEMS_ORDER',
      tableName: 'ORDER_ITEMS',
      columns: ['ORDER_ID'],
      referencedTableName: 'ORDERS',
      referencedColumns: ['ID'],
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  ];

  const usersIndexes: IndexSchemaInfo[] = [
    {
      name: 'RDB$PRIMARY1',
      tableName: 'USERS',
      columns: ['ID'],
      unique: true,
      descending: false,
      inactive: false,
    },
    {
      name: 'IDX_USERS_EMAIL',
      tableName: 'USERS',
      columns: ['EMAIL'],
      unique: true,
      descending: false,
      inactive: false,
    },
    {
      name: 'IDX_USERS_COUNTRY_ACTIVE',
      tableName: 'USERS',
      columns: ['COUNTRY_CODE', 'IS_ACTIVE'],
      unique: false,
      descending: false,
      inactive: false,
    },
    {
      name: 'IDX_USERS_INACTIVE_OLD',
      tableName: 'USERS',
      columns: ['BIO'],
      unique: false,
      descending: false,
      inactive: true,
    },
  ];

  // Deliberately list ORDER_ITEMS before ORDERS and USERS to test topological sorting
  return {
    tables: [
      {
        name: 'ORDER_ITEMS',
        columns: orderItemsCols,
        primaryKey: ['ORDER_ID', 'LINE_NO'],
        foreignKeys: orderItemsFks,
        indexes: [],
        triggers: [],
      },
      {
        name: 'ORDERS',
        columns: ordersCols,
        primaryKey: ['ID'],
        foreignKeys: ordersFks,
        indexes: [],
        triggers: [],
      },
      {
        name: 'USERS',
        columns: usersCols,
        primaryKey: ['ID'],
        foreignKeys: usersFks,
        indexes: usersIndexes,
        triggers: [],
      },
    ],
    views: [
      {
        name: 'ACTIVE_USERS',
        columns: [
          makeCol({
            tableName: 'ACTIVE_USERS',
            name: 'ID',
            position: 0,
            dataType: 'INTEGER',
            typeName: 'INTEGER',
            nullable: false,
          }),
          makeCol({
            tableName: 'ACTIVE_USERS',
            name: 'EMAIL',
            position: 1,
            dataType: 'VARYING',
            typeName: 'VARCHAR(120)',
            fieldType: 37,
            length: 120,
            nullable: true,
          }),
        ],
        source: 'SELECT ID, EMAIL FROM USERS WHERE IS_ACTIVE = TRUE',
      },
    ],
    columns: [...orderItemsCols, ...ordersCols, ...usersCols],
    primaryKeys: [
      {
        tableName: 'USERS',
        constraintName: 'INTEG_1',
        indexName: 'RDB$PRIMARY1',
        columns: ['ID'],
      },
      {
        tableName: 'ORDERS',
        constraintName: 'INTEG_2',
        indexName: 'RDB$PRIMARY2',
        columns: ['ID'],
      },
      {
        tableName: 'ORDER_ITEMS',
        constraintName: 'PK_ORDER_ITEMS',
        indexName: 'PK_ORDER_ITEMS',
        columns: ['ORDER_ID', 'LINE_NO'],
      },
    ],
    foreignKeys: [...orderItemsFks, ...ordersFks, ...usersFks],
    indexes: usersIndexes,
    sequences: [{ name: 'GEN_AUDIT_ID', initialValue: 0, increment: 1 }],
    triggers: [],
  };
}

describe('Drizzle & Kysely Codegen Introspection Adapters', () => {
  it('generates valid Drizzle firebirdTable(...) definitions, indexes, foreign keys, and relations in topological order', () => {
    const catalog = buildRichCatalog();
    const code = generateDrizzleSchemaFromCatalog(catalog);

    // 1. Topological ordering: users before orders before orderItems
    const usersIdx = code.indexOf('export const users = firebirdTable(');
    const ordersIdx = code.indexOf('export const orders = firebirdTable(');
    const orderItemsIdx = code.indexOf('export const orderItems = firebirdTable(');
    expect(usersIdx).toBeGreaterThan(-1);
    expect(ordersIdx).toBeGreaterThan(usersIdx);
    expect(orderItemsIdx).toBeGreaterThan(ordersIdx);

    // 2. Column builders, defaults, identity, and binary blob customType
    expect(code).toContain("const blob = customType<{ data: Uint8Array; driverData: Uint8Array }>");
    expect(code).toContain("id: integer('id').generatedByDefaultAsIdentity().primaryKey()");
    expect(code).toContain("email: varchar('email', { length: 120 }).notNull()");
    expect(code).toContain("countryCode: char('country_code', { length: 2 }).notNull().default('US')");
    expect(code).toContain("isActive: boolean('is_active').notNull().default(true)");
    expect(code).toContain("bio: text('bio')");
    expect(code).toContain("avatar: blob('avatar')");
    expect(code).toContain("createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)");

    // 3. Self-reference foreign key on users + user-defined indexes (filtering out RDB$PRIMARY1 and inactive index)
    expect(code).toContain(
      "foreignKey({ columns: [table.managerId], foreignColumns: [table.id], name: 'fk_users_manager' }).onDelete('set null')",
    );
    expect(code).toContain("uniqueIndex('idx_users_email').on(table.email)");
    expect(code).toContain(
      "index('idx_users_country_active').on(table.countryCode, table.isActive)",
    );
    expect(code).not.toContain('rdb$primary1');
    expect(code).not.toContain('idx_users_inactive_old');

    // 4. Inline single-column foreign key on orders and composite PK on orderItems
    expect(code).toContain(
      "userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' })",
    );
    expect(code).toContain(
      "subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull().default('0.00')",
    );
    expect(code).toContain(
      'primaryKey({ columns: [table.orderId, table.lineNo] })',
    );
    expect(code).toContain(
      "orderId: bigint('order_id', { mode: 'number' }).notNull().references(() => orders.id, { onDelete: 'cascade', onUpdate: 'cascade' })",
    );

    // 5. Relations
    expect(code).toContain('export const usersRelations = relations(users,');
    expect(code).toContain('export const ordersRelations = relations(orders,');
    expect(code).toContain('export const orderItemsRelations = relations(orderItems,');

    // 6. Verify the generated TypeScript transpiles cleanly without syntax errors
    const transpiled = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
  });

  it('supports identifierCase: "preserve", camelCase: false, bigintMode: "bigint", and disabling relations/indexes', () => {
    const catalog = buildRichCatalog();
    const code = generateDrizzleSchemaFromCatalog(catalog, {
      identifierCase: 'preserve',
      camelCase: false,
      bigintMode: 'bigint',
      includeRelations: false,
      includeIndexes: false,
      includeHeader: false,
    });

    expect(code).not.toContain('// Generated by');
    expect(code).toContain("export const USERS = firebirdTable(");
    expect(code).toContain("COUNTRY_CODE: char('COUNTRY_CODE', { length: 2 }).notNull().default('US')");
    expect(code).toContain("ID: bigint('ID', { mode: 'bigint' }).generatedByDefaultAsIdentity().primaryKey()");
    expect(code).not.toContain('Relations = relations(');
    expect(code).not.toContain('uniqueIndex(');
  });

  it('generates Kysely Database, table, and read-only view TypeScript interfaces', () => {
    const catalog = buildRichCatalog();
    const code = generateKyselyTypesFromCatalog(catalog);

    expect(code).toContain(
      "import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';",
    );
    expect(code).toContain('export interface UsersTable {');
    expect(code).toContain('  id: Generated<number>;');
    expect(code).toContain('  email: string;');
    expect(code).toContain('  country_code: Generated<string>;');
    expect(code).toContain('  is_active: Generated<boolean>;');
    expect(code).toContain('  bio: string | null;');
    expect(code).toContain('  avatar: Uint8Array | null;');
    expect(code).toContain('  manager_id: number | null;');
    expect(code).toContain('  created_at: Generated<string>;');

    expect(code).toContain('export interface OrdersTable {');
    expect(code).toContain('  subtotal: Generated<number>;');
    expect(code).toContain('  grand_total: ColumnType<number | null, never, never>;');
    expect(code).toContain('export type Orders = Selectable<OrdersTable>;');
    expect(code).toContain('export type NewOrders = Insertable<OrdersTable>;');
    expect(code).toContain('export type OrdersUpdate = Updateable<OrdersTable>;');

    expect(code).toContain('export interface ActiveUsersView {');
    expect(code).toContain('  id: ColumnType<number, never, never>;');
    expect(code).toContain('  email: ColumnType<string | null, never, never>;');

    expect(code).toContain('export interface Database {');
    expect(code).toContain('  order_items: OrderItemsTable;');
    expect(code).toContain('  orders: OrdersTable;');
    expect(code).toContain('  users: UsersTable;');
    expect(code).toContain('  active_users: ActiveUsersView;');

    const transpiled = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
  });

  it('resolves SchemaIntrospection from db.introspect() or Drizzle $client in generateDrizzleSchema / generateKyselyTypes', async () => {
    const catalog = buildRichCatalog();
    const introspectSpy = jest.fn(async () => catalog);

    const fakeDbWithIntrospect = {
      introspect: introspectSpy,
    };

    const drizzleCode = await generateDrizzleSchema(fakeDbWithIntrospect);
    expect(introspectSpy).toHaveBeenCalledTimes(1);
    expect(drizzleCode).toContain('export const users = firebirdTable(');

    const kyselyCode = await generateKyselyTypes(fakeDbWithIntrospect, {
      numericType: 'string',
      bigintType: 'bigint',
      dateType: 'Date',
      includeViews: false,
      exportCrudTypes: false,
    });
    expect(introspectSpy).toHaveBeenCalledTimes(2);
    expect(kyselyCode).toContain('  id: Generated<bigint>;');
    expect(kyselyCode).toContain('  subtotal: Generated<string>;');
    expect(kyselyCode).toContain('  created_at: Generated<Date>;');
    expect(kyselyCode).not.toContain('ActiveUsersView');
    expect(kyselyCode).not.toContain('Selectable<');

    // Also works when passed a Drizzle database instance whose $client has introspect()
    const fakeDrizzleClient: FirebirdDrizzleClient & {
      introspect: () => Promise<SchemaIntrospection>;
    } = {
      introspect: introspectSpy,
      query: (async () => ({ rows: [] as ArrayRow[], fields: [] })) as FirebirdDrizzleClient['query'],
      exec: async (_sql: string, _params?: QueryParams): Promise<QueryResult<Row>> => ({
        rows: [],
        fields: [],
      }),
      transaction: async <T>(
        fn: (tx: FirebirdDrizzleTransactionClient) => Promise<T>,
        _opts?: TransactionOptions,
      ): Promise<T> =>
        fn({
          query: (async () => ({ rows: [] as ArrayRow[], fields: [] })) as FirebirdDrizzleTransactionClient['query'],
          exec: async () => ({ rows: [], fields: [] }),
          rollback: async () => undefined,
        }),
    };
    const ormDb = drizzle(fakeDrizzleClient);
    const fromOrm = await generateDrizzleSchema(ormDb);
    expect(fromOrm).toBe(drizzleCode);
  });
});
