/**
 * where.test.ts – a shape's where, from Electric's Postgres SQL into
 * Firebird SQL with every value bound, and what is refused.
 */

import { translateWhere, WhereError } from '../electric-server/where';

const COLUMNS = new Map([
  ['id', '"ID"'],
  ['title', '"TITLE"'],
  ['done', '"DONE"'],
  ['camelCase', '"camelCase"'],
]);
const t = (where: string, params: Record<number, string> = {}) =>
  translateWhere(where, COLUMNS, new Map(Object.entries(params).map(([k, v]) => [Number(k), v])));

describe('translateWhere', () => {
  it('writes comparisons over the shape\'s columns, binding every value', () => {
    expect(t("id >= 10 AND title <> 'it''s'")).toEqual({ sql: '"ID" >= ? AND "TITLE" <> ?', params: ['10', "it's"] });
    expect(t('id = $1 OR id != $2', { 1: '5', 2: '6' })).toEqual({ sql: '("ID" = ?) OR ("ID" <> ?)', params: ['5', '6'] });
    expect(t('"camelCase" = -1.5e3')).toEqual({ sql: '"camelCase" = ?', params: ['-1.5e3'] });
    expect(t('ID = 1')).toEqual({ sql: '"ID" = ?', params: ['1'] });
  });

  it('takes IS NULL, IN, LIKE, ILIKE, BETWEEN, NOT and parentheses', () => {
    expect(t('title IS NOT NULL AND done IS NULL').sql).toBe('"TITLE" IS NOT NULL AND "DONE" IS NULL');
    expect(t('id IN (1, 2, $1)', { 1: '3' })).toEqual({ sql: '"ID" IN (?, ?, ?)', params: ['1', '2', '3'] });
    expect(t("id NOT IN (1) AND title NOT LIKE 'a%'").sql).toBe('"ID" NOT IN (?) AND "TITLE" NOT LIKE ?');
    expect(t("title ILIKE 'a%'").sql).toBe('UPPER("TITLE") LIKE UPPER(?)');
    expect(t('id BETWEEN 1 AND 5 AND done').sql).toBe('"ID" BETWEEN ? AND ? AND "DONE"');
    expect(t('NOT (done = TRUE OR id < 0)').sql).toBe('NOT ((("DONE" = TRUE) OR ("ID" < ?)))');
  });

  it('refuses whatever it does not take, by name', () => {
    expect(() => t('lower(title) = \'a\'')).toThrow(/functions \(lower\) are not supported/);
    expect(() => t('nope = 1')).toThrow(/nope is not a column/);
    expect(() => t('id = $2', { 1: 'x' })).toThrow(/\$2 has no value/);
    expect(() => t('id = 1; DROP TABLE items')).toThrow(WhereError);
    expect(() => t('id::text = \'1\'')).toThrow(WhereError);
    expect(() => t('id = (SELECT 1)')).toThrow(/SELECT is not a column|out of place/);
    expect(() => t("title = 'open")).toThrow(/unterminated/);
    expect(() => t('')).toThrow(/empty/);
  });
});
