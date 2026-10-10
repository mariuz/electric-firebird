import { blockParamType, buildBlock, placeholderOffsets } from '../batch-block';
import type { CharacterSet } from '../batch-block';

describe('placeholderOffsets', () => {
  it('finds each ? in plain SQL', () => {
    const sql = 'INSERT INTO t VALUES (?, ?, ?)';
    expect(placeholderOffsets(sql)).toEqual([22, 25, 28]);
  });

  it('skips strings, quoted identifiers and comments', () => {
    const sql = `INSERT INTO "odd?name" VALUES (?, 'what?', 'it''s ?') -- a ? here
      /* and ? here */ RETURNING ?`;
    const offsets = placeholderOffsets(sql)!;
    expect(offsets.map((i) => sql[i])).toEqual(['?', '?']);
    expect(offsets).toHaveLength(2);
  });

  it('skips Q-strings, with bracket and plain delimiters', () => {
    const sql = "UPDATE t SET a = q'{is it?}', b = Q'!what?!', c = ?";
    expect(placeholderOffsets(sql)).toEqual([sql.lastIndexOf('?')]);
  });

  it('does not read a word ending in q as a Q-string', () => {
    const sql = "SELECT seq'x' FROM t WHERE a = ?";
    // seq followed by a string literal: the literal is skipped, the ? found.
    expect(placeholderOffsets(sql)).toEqual([sql.length - 1]);
  });

  it('refuses text that ends inside a string or comment', () => {
    expect(placeholderOffsets("INSERT INTO t VALUES ('?")).toBeUndefined();
    expect(placeholderOffsets('INSERT INTO t VALUES (?) /* ?')).toBeUndefined();
    expect(placeholderOffsets("SELECT q'{?' FROM t")).toBeUndefined();
  });
});

describe('blockParamType', () => {
  const charsets = new Map<number, CharacterSet>([
    [0, { name: 'NONE', bytesPerCharacter: 1 }],
    [2, { name: 'ASCII', bytesPerCharacter: 1 }],
    [4, { name: 'UTF8', bytesPerCharacter: 4 }],
  ]);
  const p = (type: number, extra: Partial<{ subType: number; length: number; scale: number; charSet: number }> = {}) =>
    blockParamType({ type, subType: 0, length: 8, scale: 0, charSet: 0, ...extra }, charsets);

  it('declares character types in characters, with their character set', () => {
    expect(p(448, { length: 80, charSet: 4 })).toBe('VARCHAR(20) CHARACTER SET UTF8');
    expect(p(449, { length: 80, charSet: 4 })).toBe('VARCHAR(20) CHARACTER SET UTF8'); // nullable bit
    expect(p(452, { length: 10, charSet: 0 })).toBe('CHAR(10) CHARACTER SET NONE');
    expect(p(448, { length: 10, charSet: 4 | (1 << 8) })).toBe('VARCHAR(2) CHARACTER SET UTF8'); // collation ignored
    expect(p(448, { length: 10, charSet: 99 })).toBeUndefined();
  });

  it('declares numbers, scaled ones as NUMERIC', () => {
    expect(p(480)).toBe('DOUBLE PRECISION');
    expect(p(482)).toBe('FLOAT');
    expect(p(496)).toBe('INTEGER');
    expect(p(580)).toBe('BIGINT');
    expect(p(580, { scale: -2 })).toBe('NUMERIC(18, 2)');
    expect(p(500, { scale: -1 })).toBe('NUMERIC(4, 1)');
    expect(p(32752)).toBe('INT128');
    expect(p(32762)).toBe('DECFLOAT(34)');
  });

  it('declares dates, times, booleans and blobs', () => {
    expect(p(510)).toBe('TIMESTAMP');
    expect(p(570)).toBe('DATE');
    expect(p(560)).toBe('TIME');
    expect(p(32748)).toBe('TIMESTAMP WITH TIME ZONE');
    expect(p(32750)).toBe('TIME WITH TIME ZONE');
    expect(p(32764)).toBe('BOOLEAN');
    expect(p(520, { subType: 0 })).toBe('BLOB SUB_TYPE 0');
    expect(p(520, { subType: 1, charSet: 4 })).toBe('BLOB SUB_TYPE TEXT CHARACTER SET UTF8');
  });

  it('has nothing to declare for an untyped parameter', () => {
    expect(p(32766)).toBeUndefined(); // SQL_NULL
    expect(p(540)).toBeUndefined(); // an array
  });
});

describe('buildBlock', () => {
  it('repeats the statement per row, each ? a declared parameter', () => {
    const sql = 'INSERT INTO t VALUES (?, ?);';
    const block = buildBlock(sql, placeholderOffsets(sql)!, ['INTEGER', 'VARCHAR(5) CHARACTER SET UTF8'], 2);
    expect(block).toBe(
      'EXECUTE BLOCK (p0_0 INTEGER = ?, p0_1 VARCHAR(5) CHARACTER SET UTF8 = ?, ' +
        'p1_0 INTEGER = ?, p1_1 VARCHAR(5) CHARACTER SET UTF8 = ?) AS BEGIN\n' +
        'INSERT INTO t VALUES (:p0_0, :p0_1);\n' +
        'INSERT INTO t VALUES (:p1_0, :p1_1);\n' +
        'END',
    );
  });

  it('keeps the text around and after the placeholders', () => {
    const sql = "UPDATE t SET a = ?, note = 'why?' WHERE id = ? AND b > 0";
    const block = buildBlock(sql, placeholderOffsets(sql)!, ['INTEGER', 'INTEGER'], 1);
    expect(block).toContain("UPDATE t SET a = :p0_0, note = 'why?' WHERE id = :p0_1 AND b > 0;");
  });
});
