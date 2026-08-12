import {
  sql,
  SqlFragment,
  isSqlFragment,
  toStatement,
  resolveQueryCall,
} from '../sql-tag';

describe('sql`…`', () => {
  it('turns every interpolation into a placeholder', () => {
    const fragment = sql`SELECT * FROM items WHERE id = ${7} AND name = ${'a'}`;

    expect(fragment.sql).toBe('SELECT * FROM items WHERE id = ? AND name = ?');
    expect(fragment.params).toEqual([7, 'a']);
  });

  it('handles a template with no interpolations', () => {
    const fragment = sql`SELECT 1 FROM RDB$DATABASE`;

    expect(fragment.sql).toBe('SELECT 1 FROM RDB$DATABASE');
    expect(fragment.params).toEqual([]);
  });

  it('keeps adjacent interpolations in order', () => {
    const fragment = sql`${1}${2}${3}`;

    expect(fragment.sql).toBe('???');
    expect(fragment.params).toEqual([1, 2, 3]);
  });

  it('binds null and undefined rather than writing them into the text', () => {
    // Both become SQL NULL at the encoder; what matters here is that neither
    // is stringified into the statement.
    const fragment = sql`SET a = ${null}, b = ${undefined}`;

    expect(fragment.sql).toBe('SET a = ?, b = ?');
    expect(fragment.params).toEqual([null, undefined]);
  });

  // The property the whole tag exists for.
  it('cannot be escaped by a value that looks like SQL', () => {
    const name = "'; DROP TABLE items; --";
    const fragment = sql`SELECT * FROM items WHERE name = ${name}`;

    expect(fragment.sql).toBe('SELECT * FROM items WHERE name = ?');
    expect(fragment.params).toEqual([name]);
    // The dangerous text is a value, and appears nowhere in the statement.
    expect(fragment.sql).not.toContain('DROP');
  });

  it('rejects an invalid escape sequence instead of writing "undefined"', () => {
    // A tagged template hands the tag `undefined` for a segment whose escape
    // is invalid rather than failing to parse (ES2018). Built by hand because
    // the compiler will not emit one from source in this file.
    const strings = Object.assign([undefined, ' rest'], {
      raw: ['\\unicode', ' rest'],
    }) as unknown as TemplateStringsArray;

    expect(() => sql(strings, 1)).toThrow(/invalid escape sequence/);
  });

  it('names sql.join when an array is interpolated directly', () => {
    expect(() => sql`WHERE id IN ${[1, 2, 3]}`).toThrow(/sql\.join/);
  });
});

describe('nesting', () => {
  it('splices a fragment and its parameters', () => {
    const condition = sql`active = ${true}`;
    const fragment = sql`SELECT * FROM items WHERE owner = ${'me'} AND ${condition}`;

    expect(fragment.sql).toBe(
      'SELECT * FROM items WHERE owner = ? AND active = ?',
    );
    expect(fragment.params).toEqual(['me', true]);
  });

  it('keeps parameters in text order across several levels', () => {
    const inner = sql`c = ${3}`;
    const middle = sql`b = ${2} AND ${inner}`;
    const outer = sql`a = ${1} AND ${middle} AND d = ${4}`;

    expect(outer.sql).toBe('a = ? AND b = ? AND c = ? AND d = ?');
    expect(outer.params).toEqual([1, 2, 3, 4]);
  });

  it('splices an empty fragment as nothing, which is what makes it a no-op', () => {
    const nothing = sql``;
    const fragment = sql`SELECT * FROM items WHERE id = ${1} ${nothing}`;

    expect(fragment.sql).toBe('SELECT * FROM items WHERE id = ? ');
    expect(fragment.params).toEqual([1]);
  });
});

describe('sql.join', () => {
  it('expands a list into placeholders', () => {
    const fragment = sql`SELECT * FROM items WHERE id IN (${sql.join([1, 2, 3])})`;

    expect(fragment.sql).toBe('SELECT * FROM items WHERE id IN (?, ?, ?)');
    expect(fragment.params).toEqual([1, 2, 3]);
  });

  it('takes a separator', () => {
    const fragment = sql.join(['a', 'b'], ' OR ');

    expect(fragment.sql).toBe('? OR ?');
    expect(fragment.params).toEqual(['a', 'b']);
  });

  it('joins fragments, so conditions compose', () => {
    const conditions = [sql`a = ${1}`, sql`b = ${2}`];
    const fragment = sql`SELECT * FROM t WHERE ${sql.join(conditions, ' AND ')}`;

    expect(fragment.sql).toBe('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(fragment.params).toEqual([1, 2]);
  });

  it('refuses an empty list rather than emitting IN ()', () => {
    expect(() => sql.join([])).toThrow(/at least one value/);
  });

  it('names sql.join, not the enclosing template, for a nested array', () => {
    // The remedy for an array in a template is "use sql.join" — useless advice
    // when sql.join is what failed, and the index would name a hole in the
    // enclosing template rather than the element that is wrong.
    expect(() => sql.join([1, [2, 3]])).toThrow(
      /Element 1 passed to sql\.join\(\).*does not flatten/s,
    );
  });

  it('splices a parameter list too large to spread', () => {
    // `params.push(...value.params)` made every parameter an argument, and
    // past roughly 100k V8 throws "Maximum call stack size exceeded" from
    // inside the tag — naming neither the list nor the limit.
    const ids = Array.from({ length: 200_000 }, (_, i) => i);
    const fragment = sql`SELECT * FROM t WHERE id IN (${sql.join(ids)})`;

    expect(fragment.params).toHaveLength(200_000);
    expect(fragment.params[199_999]).toBe(199_999);
  });
});

describe('sql.identifier', () => {
  it('quotes a name', () => {
    expect(sql.identifier('ITEMS').sql).toBe('"ITEMS"');
  });

  it('doubles an embedded quote, so the quoting cannot be ended', () => {
    // The attack: a name that closes the quote and appends a statement.
    const hostile = 'x"; DROP TABLE items; --';

    expect(sql.identifier(hostile).sql).toBe('"x""; DROP TABLE items; --"');
  });

  it('interpolates as text rather than as a parameter', () => {
    const fragment = sql`SELECT * FROM ${sql.identifier('ITEMS')} WHERE id = ${1}`;

    expect(fragment.sql).toBe('SELECT * FROM "ITEMS" WHERE id = ?');
    expect(fragment.params).toEqual([1]);
  });

  it('preserves case, because quoting turns Firebird\'s folding off', () => {
    // Deliberate: `CREATE TABLE items` stores ITEMS, so this will not find it.
    // Upper-casing here would instead break names created with quotes, which
    // is the worse of the two failures — it corrupts a name that was correct.
    expect(sql.identifier('items').sql).toBe('"items"');
  });

  it('rejects an empty name or a NUL', () => {
    expect(() => sql.identifier('')).toThrow(/non-empty/);
    expect(() => sql.identifier('a\0b')).toThrow(/NUL/);
  });
});

describe('sql.unsafe', () => {
  it('splices text with nothing bound', () => {
    const fragment = sql`SELECT * FROM t ORDER BY name ${sql.unsafe('DESC')}`;

    expect(fragment.sql).toBe('SELECT * FROM t ORDER BY name DESC');
    expect(fragment.params).toEqual([]);
  });

  it('escapes nothing, which is the whole warning', () => {
    expect(sql.unsafe("'; DROP TABLE items; --").sql).toBe(
      "'; DROP TABLE items; --",
    );
  });
});

describe('isSqlFragment', () => {
  it('recognises a fragment', () => {
    expect(isSqlFragment(sql`SELECT 1`)).toBe(true);
    expect(isSqlFragment(new SqlFragment('SELECT 1', []))).toBe(true);
  });

  it('rejects everything else, including a look-alike', () => {
    expect(isSqlFragment('SELECT 1')).toBe(false);
    expect(isSqlFragment(null)).toBe(false);
    expect(isSqlFragment(undefined)).toBe(false);
    expect(isSqlFragment({ sql: 'SELECT 1', params: [] })).toBe(false);
  });

  it('keeps the brand off enumerable keys', () => {
    // A fragment is logged, spread and serialised; the brand should not show
    // up in any of that.
    const fragment = sql`SELECT ${1}`;

    expect(Object.keys(fragment)).toEqual(['sql', 'params']);
    expect(JSON.parse(JSON.stringify(fragment))).toEqual({
      sql: 'SELECT ?',
      params: [1],
    });
  });
});

describe('toStatement', () => {
  it('passes a string and its parameters through', () => {
    expect(toStatement('SELECT * FROM t WHERE id = ?', [1])).toEqual({
      sql: 'SELECT * FROM t WHERE id = ?',
      params: [1],
    });
  });

  it('unpacks a fragment', () => {
    expect(toStatement(sql`SELECT * FROM t WHERE id = ${1}`)).toEqual({
      sql: 'SELECT * FROM t WHERE id = ?',
      params: [1],
    });
  });

  it('refuses a fragment with extra parameters, which would bind to nothing', () => {
    expect(() => toStatement(sql`SELECT ${1}`, [2])).toThrow(
      /already carries its parameters/,
    );
  });

  // Before this check the object fell through as the statement text and
  // reached the engine as "[object Object]", a syntax error naming a token
  // rather than the argument — with the fragment's values silently dropped.
  it('refuses a { sql, params } look-alike rather than sending it as text', () => {
    const lookAlike = { sql: 'SELECT * FROM t WHERE id = ?', params: [1] };

    expect(() => toStatement(lookAlike as never)).toThrow(
      /not a fragment|Expected a SQL string/,
    );
  });

  it('refuses a fragment that lost its brand crossing a clone boundary', () => {
    // The brand is a symbol, which neither structuredClone nor JSON carries —
    // so a fragment built in a Worker arrives on the main thread like this.
    const cloned = JSON.parse(JSON.stringify(sql`SELECT id FROM t WHERE id = ${1}`));

    expect(isSqlFragment(cloned)).toBe(false);
    expect(() => toStatement(cloned)).toThrow(/structuredClone or JSON/);
  });

  it('refuses other non-statements, naming what it got', () => {
    expect(() => toStatement(42 as never)).toThrow(/got a number/);
    expect(() => toStatement(null as never)).toThrow(/got null/);
  });
});

describe('resolveQueryCall', () => {
  it('reads (sql, params, options)', () => {
    const { statement, options } = resolveQueryCall('SELECT ?', [1], {
      readOnly: true,
    });

    expect(statement).toEqual({ sql: 'SELECT ?', params: [1] });
    expect(options).toEqual({ readOnly: true });
  });

  it('reads (fragment, options), the slot params would have used', () => {
    const { statement, options } = resolveQueryCall(sql`SELECT ${1}`, {
      isolationLevel: 'READ_COMMITTED',
    });

    expect(statement).toEqual({ sql: 'SELECT ?', params: [1] });
    expect(options).toEqual({ isolationLevel: 'READ_COMMITTED' });
  });

  it('defaults both', () => {
    const { statement, options } = resolveQueryCall(sql`SELECT ${1}`);

    expect(statement).toEqual({ sql: 'SELECT ?', params: [1] });
    expect(options).toEqual({});
  });

  // The options slot is only free when the statement is a fragment. With a
  // string, a non-array here used to be silently taken for options: the
  // statement then ran with no parameters at all, and the engine complained
  // about a placeholder count, naming nothing the caller wrote.
  it('refuses a non-array second argument after a string statement', () => {
    expect(() => resolveQueryCall('SELECT * FROM t WHERE id = ?', 5 as never)).toThrow(
      /Expected an array of parameters, got a number/,
    );
    expect(() =>
      resolveQueryCall('SELECT * FROM t WHERE id = ?', { readOnly: true }),
    ).toThrow(/Expected an array of parameters/);
  });
});
