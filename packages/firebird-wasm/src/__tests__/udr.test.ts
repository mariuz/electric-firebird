import {
  UdrManager,
  invokeGlobalJsUdr,
  normalizeRoutineIdentifier,
  normalizeSqlTypeDeclaration,
  sqlTypeToFieldInfo,
  coerceValueToSqlType,
  buildFunctionExternalDdl,
  buildFunctionPsqlStubDdl,
  buildProcedureExternalDdl,
  buildProcedurePsqlStubDdl,
  splitTopLevelCommaList,
  countPlaceholders,
  type UdrSqlExecutor,
} from '../browser/udr';
import type { QueryParams, QueryResult, Row, RowMode } from '../types';

/**
 * In-memory mock SQL executor that simulates Firebird DDL catalog operations,
 * RDB$DATABASE queries, and basic table storage for testing `UdrManager` in
 * both `'wasm-js'` and `'psql-bridge'` modes.
 */
function createMockExecutor(options: {
  isDirect?: boolean;
  supportNativeEngineJs?: boolean;
} = {}): {
  executor: UdrSqlExecutor;
  executedDdl: string[];
  tables: Map<string, Array<Record<string, unknown>>>;
} {
  const executedDdl: string[] = [];
  const tables = new Map<string, Array<Record<string, unknown>>>();

  const executor: UdrSqlExecutor = {
    isDirect: options.isDirect ?? false,
    exec: async (sql: string, params: QueryParams = []) => {
      const trimmed = sql.trim();
      if (/^(CREATE|ALTER|DROP|RECREATE)\s+/i.test(trimmed)) {
        executedDdl.push(trimmed);
        const createTableMatch = /^CREATE\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(trimmed);
        if (createTableMatch) {
          tables.set(createTableMatch[1]!.toUpperCase(), []);
        }
        return 0;
      }
      const insertMatch =
        /^INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(
          trimmed,
        );
      if (insertMatch) {
        const tableName = insertMatch[1]!.toUpperCase();
        const cols = insertMatch[2]!.split(',').map((c) => c.trim().replace(/^"|"$/g, '').toUpperCase());
        const valsRaw = splitTopLevelCommaList(insertMatch[3]!);
        let pIdx = 0;
        const row: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) {
          const v = valsRaw[i]!;
          if (v === '?') {
            row[cols[i]!] = params[pIdx++];
          } else if (v.startsWith("'") && v.endsWith("'")) {
            row[cols[i]!] = v.slice(1, -1).replace(/''/g, "'");
          } else if (/^-?\d+(\.\d+)?$/.test(v)) {
            row[cols[i]!] = Number(v);
          } else if (/^NULL$/i.test(v)) {
            row[cols[i]!] = null;
          } else {
            row[cols[i]!] = v;
          }
        }
        const list = tables.get(tableName) ?? [];
        list.push(row);
        tables.set(tableName, list);
        return 1;
      }
      return 0;
    },
    query: async <T extends Row = Row>(
      sql: string,
      params: QueryParams = [],
      opts?: { rowMode?: RowMode },
    ): Promise<QueryResult<T>> => {
      const trimmed = sql.trim();
      const rowMode = opts?.rowMode ?? 'object';

      // Probe query for ENGINE JS
      if (/FROM\s+RDB\$DATABASE/i.test(trimmed) && !options.supportNativeEngineJs && /\w+\s*\(/.test(trimmed)) {
        const callMatch = /^\s*SELECT\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\(/i.exec(trimmed);
        if (callMatch) {
          throw new Error(`Engine JS not found for function ${callMatch[1]}`);
        }
      }

      // Simple SELECT <expr> AS <alias> FROM RDB$DATABASE
      const rdbMatch = /^SELECT\s+([\s\S]+?)\s+FROM\s+RDB\$DATABASE$/i.exec(trimmed);
      if (rdbMatch) {
        const items = splitTopLevelCommaList(rdbMatch[1]!);
        let pIdx = 0;
        const rowObj: Record<string, unknown> = {};
        const rowArr: unknown[] = [];
        const fields = items.map((item, idx) => {
          const asMatch = /^([\s\S]+?)\s+AS\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?$/i.exec(item.trim());
          const expr = (asMatch ? asMatch[1]! : item).trim();
          const alias = (asMatch ? asMatch[2]! : `COL_${idx + 1}`).toUpperCase();
          let val: unknown;
          if (expr === '?') {
            val = params[pIdx++];
          } else if (expr.startsWith("'") && expr.endsWith("'")) {
            val = expr.slice(1, -1).replace(/''/g, "'");
          } else if (/^-?\d+(\.\d+)?$/.test(expr)) {
            val = Number(expr);
          } else if (/^NULL$/i.test(expr)) {
            val = null;
          } else {
            val = expr;
          }
          rowObj[alias] = val;
          rowArr.push(val);
          return sqlTypeToFieldInfo(alias, typeof val === 'number' ? 'INTEGER' : 'VARCHAR(200)');
        });
        return {
          rows: [rowMode === 'array' ? (rowArr as unknown as T) : (rowObj as unknown as T)],
          fields,
        };
      }

      // Simple SELECT * FROM <table>
      const tableMatch = /^SELECT\s+\*\s+FROM\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?(?:\s+AS\s+"?[A-Za-z_][A-Za-z0-9_$]*"?)?$/i.exec(
        trimmed,
      );
      if (tableMatch) {
        const tableName = tableMatch[1]!.toUpperCase();
        const storedRows = tables.get(tableName) ?? [];
        const colNames = storedRows.length > 0 ? Object.keys(storedRows[0]!) : [];
        const fields = colNames.map((c) => sqlTypeToFieldInfo(c, 'VARCHAR(200)'));
        const outRows = storedRows.map((r) =>
          rowMode === 'array'
            ? (colNames.map((c) => r[c]) as unknown as T)
            : ({ ...r } as unknown as T),
        );
        return { rows: outRows, fields };
      }

      return { rows: [], fields: [] };
    },
  };

  return { executor, executedDdl, tables };
}

describe('JavaScript UDR (db.registerFunction / db.registerProcedure)', () => {
  describe('Identifier and SQL Type helpers', () => {
    it('normalizes routine identifiers and rejects invalid SQL identifiers', () => {
      expect(normalizeRoutineIdentifier('slugify')).toBe('SLUGIFY');
      expect(normalizeRoutineIdentifier('"my_func$"')).toBe('MY_FUNC$');
      expect(() => normalizeRoutineIdentifier('')).toThrow(/cannot be empty/);
      expect(() => normalizeRoutineIdentifier('123bad')).toThrow(/valid SQL identifier/);
      expect(() => normalizeRoutineIdentifier('drop; table')).toThrow(/valid SQL identifier/);
    });

    it('normalizes SQL type declarations and maps them to FieldInfo', () => {
      expect(normalizeSqlTypeDeclaration('  varchar( 200 ) ')).toBe('VARCHAR( 200 )');
      expect(() => normalizeSqlTypeDeclaration('')).toThrow(/non-empty/);
      expect(() => normalizeSqlTypeDeclaration('INTEGER; DROP TABLE x')).toThrow(/Invalid/);

      expect(sqlTypeToFieldInfo('SLUG', 'VARCHAR(200)')).toMatchObject({
        name: 'SLUG',
        typeName: 'VARYING',
        length: 200,
      });
      expect(sqlTypeToFieldInfo('CNT', 'INTEGER')).toMatchObject({
        name: 'CNT',
        typeName: 'INTEGER',
        length: 4,
      });
      expect(sqlTypeToFieldInfo('BIG', 'BIGINT')).toMatchObject({
        name: 'BIG',
        typeName: 'BIGINT',
        length: 8,
      });
      expect(sqlTypeToFieldInfo('PRICE', 'NUMERIC(10, 2)')).toMatchObject({
        name: 'PRICE',
        typeName: 'NUMERIC',
        scale: -2,
      });
      expect(sqlTypeToFieldInfo('FLAG', 'BOOLEAN')).toMatchObject({
        name: 'FLAG',
        typeName: 'BOOLEAN',
        length: 1,
      });
    });

    it('coerces JS return values to match target Firebird SQL types', () => {
      expect(coerceValueToSqlType(null, 'VARCHAR(50)')).toBeNull();
      expect(coerceValueToSqlType(undefined, 'INTEGER')).toBeNull();
      expect(coerceValueToSqlType('42.9', 'INTEGER')).toBe(42);
      expect(coerceValueToSqlType(123n, 'BIGINT')).toBe(123);
      expect(coerceValueToSqlType('3.14159', 'DOUBLE PRECISION')).toBeCloseTo(3.14159);
      expect(coerceValueToSqlType(19.5, 'NUMERIC(10, 2)')).toBe('19.50');
      expect(coerceValueToSqlType(1, 'BOOLEAN')).toBe(true);
      expect(coerceValueToSqlType('false', 'BOOLEAN')).toBe(false);
      expect(coerceValueToSqlType(new Date('2026-05-10T12:30:00.000Z'), 'DATE')).toBe('2026-05-10');
    });

    it('builds valid EXTERNAL NAME ... ENGINE JS and PSQL fallback DDL statements', () => {
      const fnRec = {
        kind: 'function' as const,
        name: 'SLUGIFY',
        entryPoint: 'fn_1_SLUGIFY',
        args: [{ name: 'P1', type: 'VARCHAR(200)', fieldInfo: sqlTypeToFieldInfo('P1', 'VARCHAR(200)') }],
        returns: 'VARCHAR(200)',
        returnField: sqlTypeToFieldInfo('RESULT', 'VARCHAR(200)'),
        deterministic: true,
        engine: 'wasm-js' as const,
        fn: (s: unknown) => String(s),
      };
      expect(buildFunctionExternalDdl(fnRec, true)).toBe(
        `CREATE OR ALTER FUNCTION "SLUGIFY" ("P1" VARCHAR(200)) RETURNS VARCHAR(200) DETERMINISTIC EXTERNAL NAME 'fn_1_SLUGIFY' ENGINE JS`,
      );
      expect(buildFunctionPsqlStubDdl(fnRec, false)).toBe(
        `CREATE FUNCTION "SLUGIFY" ("P1" VARCHAR(200)) RETURNS VARCHAR(200) DETERMINISTIC AS BEGIN RETURN NULL; END`,
      );

      const procRec = {
        kind: 'procedure' as const,
        name: 'SPLIT_WORDS',
        entryPoint: 'proc_2_SPLIT_WORDS',
        args: [{ name: 'TXT', type: 'VARCHAR(200)', fieldInfo: sqlTypeToFieldInfo('TXT', 'VARCHAR(200)') }],
        returns: [
          { name: 'IDX', type: 'INTEGER', fieldInfo: sqlTypeToFieldInfo('IDX', 'INTEGER') },
          { name: 'WORD', type: 'VARCHAR(100)', fieldInfo: sqlTypeToFieldInfo('WORD', 'VARCHAR(100)') },
        ],
        engine: 'wasm-js' as const,
        fn: () => [],
      };
      expect(buildProcedureExternalDdl(procRec, true)).toBe(
        `CREATE OR ALTER PROCEDURE "SPLIT_WORDS" ("TXT" VARCHAR(200)) RETURNS ("IDX" INTEGER, "WORD" VARCHAR(100)) EXTERNAL NAME 'proc_2_SPLIT_WORDS' ENGINE JS`,
      );
      expect(buildProcedurePsqlStubDdl(procRec, true)).toBe(
        `CREATE OR ALTER PROCEDURE "SPLIT_WORDS" ("TXT" VARCHAR(200)) RETURNS ("IDX" INTEGER, "WORD" VARCHAR(100)) AS BEGIN SUSPEND; END`,
      );
    });

    it('splits top-level comma lists and counts placeholders outside quotes', () => {
      expect(splitTopLevelCommaList("SLUGIFY('a, b', UPPER('c,d')), 42, 'x''y,z'")).toEqual([
        "SLUGIFY('a, b', UPPER('c,d'))",
        '42',
        "'x''y,z'",
      ]);
      expect(countPlaceholders("SELECT ?, 'not ? here', \"col?\", ? FROM t")).toBe(2);
    });
  });

  describe('C++ IExternalEngine wire protocol (invokeGlobalJsUdr)', () => {
    it('invokes synchronous scalar functions and procedures via globalThis.__fbJsUdrInvoke', async () => {
      const udr = new UdrManager();
      const { executor } = createMockExecutor({ isDirect: false });

      const fnHandle = await udr.registerFunction(
        'SLUGIFY',
        { args: ['VARCHAR(200)'], returns: 'VARCHAR(200)' },
        (s: unknown) =>
          typeof s === 'string'
            ? s
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
            : null,
        executor,
      );

      const rawScalarResp = invokeGlobalJsUdr(
        0,
        fnHandle.entryPoint,
        fnHandle.name,
        JSON.stringify(['Hello World!']),
      );
      expect(rawScalarResp).toEqual({ ok: true, value: 'hello-world' });

      const nullScalarResp = invokeGlobalJsUdr(
        0,
        fnHandle.entryPoint,
        fnHandle.name,
        JSON.stringify([null]),
      );
      expect(nullScalarResp).toEqual({ ok: true, value: null });

      const procHandle = await udr.registerProcedure(
        'GEN_SERIES',
        {
          args: ['INTEGER', 'INTEGER'],
          returns: [
            { name: 'NUM', type: 'INTEGER' },
            { name: 'LABEL', type: 'VARCHAR(50)' },
          ],
        },
        (start: unknown, stop: unknown) => {
          const rows: Array<{ NUM: number; LABEL: string }> = [];
          for (let i = Number(start); i <= Number(stop); i++) {
            rows.push({ NUM: i, LABEL: `item-${i}` });
          }
          return rows;
        },
        executor,
      );

      const rawProcResp = invokeGlobalJsUdr(
        1,
        procHandle.entryPoint,
        procHandle.name,
        JSON.stringify([2, 4]),
      );
      expect(rawProcResp).toEqual({
        ok: true,
        rows: [
          [2, 'item-2'],
          [3, 'item-3'],
          [4, 'item-4'],
        ],
      });

      // Unknown routine returns structured error
      const missingResp = invokeGlobalJsUdr(0, 'non_existent_entry', 'MISSING_FN', '[]');
      expect(missingResp).toMatchObject({
        ok: false,
        error: expect.stringContaining('is not registered'),
      });

      udr.clear();
    });
  });

  describe('UdrManager scalar functions and procedures in psql-bridge mode', () => {
    it('evaluates scalar functions in constant expressions, nested calls, and table queries with WHERE and COMPUTED BY', async () => {
      const udr = new UdrManager();
      const { executor, tables } = createMockExecutor({ isDirect: false });

      await udr.registerFunction(
        'SLUGIFY',
        { args: ['VARCHAR(200)'], returns: 'VARCHAR(200)', deterministic: true },
        (s: unknown) =>
          typeof s === 'string'
            ? s
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
            : null,
        executor,
      );

      await udr.registerFunction(
        'ADD_TAX',
        { args: ['INTEGER', 'INTEGER'], returns: 'INTEGER' },
        (price: unknown, ratePct: unknown) => Math.round(Number(price) * (1 + Number(ratePct) / 100)),
        executor,
      );

      // 1. Constant / parameterized expression rewriting
      const rw = await udr.rewriteStatement(
        "SELECT SLUGIFY('Hello Firebird WASM!') AS SLUG, ADD_TAX(?, 20) AS TOTAL FROM RDB$DATABASE",
        [100],
      );
      expect(rw.sql).toBe(
        'SELECT CAST(? AS VARCHAR(200)) AS SLUG, CAST(? AS INTEGER) AS TOTAL FROM RDB$DATABASE',
      );
      expect(rw.params).toEqual(['hello-firebird-wasm', 120]);

      // 2. Table with COMPUTED BY column referencing SLUGIFY(title)
      const createDdl =
        'CREATE TABLE articles (id INTEGER, title VARCHAR(200), slug COMPUTED BY (SLUGIFY(title)))';
      udr.inspectDdl(createDdl);
      await executor.exec(createDdl);

      tables.set('ARTICLES', [
        { ID: 1, TITLE: 'First Post!', SLUG: null },
        { ID: 2, TITLE: 'Second_Article & More', SLUG: null },
      ]);

      // 3. SELECT with column-argument UDF call, computed column, and WHERE filter using UDF
      const res = await udr.queryIfIntercepted<{ ID: number; SLUG: string; CUSTOM: string }>(
        "SELECT id, slug, SLUGIFY(title) AS custom FROM articles WHERE SLUGIFY(title) = 'second-article-more'",
        [],
        'object',
        executor,
      );
      expect(res).not.toBeNull();
      expect(res!.rows).toEqual([
        {
          ID: 2,
          SLUG: 'second-article-more',
          CUSTOM: 'second-article-more',
        },
      ]);
    });

    it('evaluates selectable and executable procedures via queryIfIntercepted and executeIfIntercepted', async () => {
      const udr = new UdrManager();
      const { executor } = createMockExecutor({ isDirect: false });

      const auditLog: string[] = [];
      await udr.registerProcedure(
        'LOG_EVENT',
        { args: ['VARCHAR(100)'] },
        async (msg: unknown) => {
          auditLog.push(String(msg));
        },
        executor,
      );

      const execRes = await udr.executeIfIntercepted('EXECUTE PROCEDURE LOG_EVENT(?)', ['user.login']);
      expect(execRes).toEqual({ intercepted: true, affectedRows: 0 });
      expect(auditLog).toEqual(['user.login']);

      await udr.registerProcedure(
        'TOKENIZE',
        {
          args: ['VARCHAR(200)'],
          returns: [
            { name: 'POS', type: 'INTEGER' },
            { name: 'TOKEN', type: 'VARCHAR(60)' },
          ],
        },
        async function* (input: unknown) {
          const words = String(input ?? '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          for (let i = 0; i < words.length; i++) {
            yield { POS: i + 1, TOKEN: words[i]! };
          }
        },
        executor,
      );

      const selectRes = await udr.queryIfIntercepted<{ POS: number; TOKEN: string }>(
        "SELECT TOKEN, POS FROM TOKENIZE('alpha beta gamma') WHERE POS >= 2 ORDER BY POS DESC",
        [],
        'object',
        executor,
      );
      expect(selectRes).not.toBeNull();
      expect(selectRes!.rows).toEqual([
        { TOKEN: 'gamma', POS: 3 },
        { TOKEN: 'beta', POS: 2 },
      ]);

      const countRes = await udr.queryIfIntercepted<{ CNT: number }>(
        'SELECT COUNT(*) AS CNT FROM TOKENIZE(?)',
        ['one two three four'],
        'object',
        executor,
      );
      expect(countRes!.rows).toEqual([{ CNT: 4 }]);
    });
  });
});
