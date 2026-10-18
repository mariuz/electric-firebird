import { decodeResultSet } from '../browser/engine-transport';

/** What the C bridge writes for a result set. */
const encode = (columns: { name: string; type: number }[], rows: unknown[][]): string =>
  JSON.stringify({
    columns: columns.map((c) => ({ ...c, subType: 0, scale: 0, length: 4, nullable: true })),
    rows,
  });

describe('decodeResultSet', () => {
  // As the engine names them: unquoted names folded to upper case.
  const columns = [
    { name: 'ID', type: 496 },
    { name: 'NAME', type: 448 },
  ];

  it('decodes columns and rows, in both row modes', () => {
    const json = encode(columns, [[1, 'a'], [2, 'b']]);
    const objects = decodeResultSet(json);
    expect(objects.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
    expect(objects.fields[0]).toMatchObject({ type: 496, typeName: 'INTEGER', nullable: true });
    expect(objects.rows).toEqual([{ ID: 1, NAME: 'a' }, { ID: 2, NAME: 'b' }]);

    const arrays = decodeResultSet(json, 'array');
    expect(arrays.rows).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('gives every call fields of its own, though the description is decoded once', () => {
    const first = decodeResultSet(encode(columns, [[1, 'a']]));
    first.fields[0].name = 'CHANGED';
    (first.fields as unknown[]).pop();

    const second = decodeResultSet(encode(columns, [[2, 'b']]));
    expect(second.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
    expect(second.rows).toEqual([{ ID: 2, NAME: 'b' }]);
    expect(second.fields[0]).not.toBe(first.fields[0]);
  });

  it('is not misled by a column name that contains the boundary text', () => {
    const odd = [{ name: '],"rows":[', type: 496 }, { name: 'x', type: 496 }];
    const result = decodeResultSet(encode(odd, [[1, 2]]), 'array');
    expect(result.fields.map((f) => f.name)).toEqual(['],"rows":[', 'x']);
    expect(result.rows).toEqual([[1, 2]]);
  });

  it('decodes no columns and no rows', () => {
    const result = decodeResultSet('{"columns":[],"rows":[]}');
    expect(result).toEqual({ fields: [], rows: [] });
  });

  it('takes the columns of a result named by shape id from the resolver', () => {
    const fields = decodeResultSet(encode(columns, [])).fields;
    const asked: number[] = [];
    const resolve = (id: number) => {
      asked.push(id);
      return fields;
    };
    const result = decodeResultSet('{"shape":42,"rows":[[1,"a"],[2,"b"]]}', 'object', resolve);
    expect(asked).toEqual([42]);
    expect(result.fields.map((f) => f.name)).toEqual(['ID', 'NAME']);
    expect(result.fields[0]).not.toBe(fields[0]);
    expect(result.rows).toEqual([{ ID: 1, NAME: 'a' }, { ID: 2, NAME: 'b' }]);
  });

  it('parses any other shape whole', () => {
    // Keys in another order: not the bridge's layout, so no split is attempted.
    const json = JSON.stringify({ rows: [[7]], columns: [{ name: 'N', type: 496, subType: 0, scale: 0, length: 4, nullable: false }] });
    expect(decodeResultSet(json, 'array')).toMatchObject({ rows: [[7]], fields: [{ name: 'N' }] });
  });

  it('keeps a quoted name as the engine reports it', () => {
    const quoted = [{ name: 'camelCase', type: 496 }, { name: 'TITLE', type: 448 }];
    const result = decodeResultSet(encode(quoted, [[1, 'a']]));
    expect(result.fields.map((f) => f.name)).toEqual(['camelCase', 'TITLE']);
    expect(result.rows).toEqual([{ camelCase: 1, TITLE: 'a' }]);
  });
});
