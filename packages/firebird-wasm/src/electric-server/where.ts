/**
 * where.ts – a shape's `where`, as Electric's clients write it (Postgres
 * SQL), read and written again as Firebird SQL with every value bound.
 *
 * Only a small, closed part of SQL is taken: column names, literals,
 * Electric's positional parameters (`$1`, given as `params[1]=…`),
 * comparisons, `AND` / `OR` / `NOT`, `IS [NOT] NULL`, `[NOT] IN (…)`,
 * `[NOT] LIKE` / `ILIKE`, `[NOT] BETWEEN … AND …`, and parentheses.  Anything
 * else (a function, a subquery, a cast, a column of another table) is
 * refused by name, never passed on: the text comes from a client, and the
 * server runs what it writes.  Every literal and parameter is bound, so no
 * text a client sends ever becomes SQL.
 */

/** Thrown for a `where` this server does not take; the server answers 400. */
export class WhereError extends Error {}

/** Metadata for a relational `IN (SELECT ...)` subquery inside a shape `where` (`M31 Item 3`). */
export interface SubqueryDependency {
  readonly childColumnSql: string;
  readonly childColumnName?: string;
  readonly parentTable: string;
  readonly parentColumn: string;
  readonly parentColumnSql: string;
  readonly negated: boolean;
  readonly parentWhere?: FirebirdWhere;
}

/** A `where`, as Firebird SQL over the table's own columns, and its values. */
export interface FirebirdWhere {
  sql: string;
  params: unknown[];
  subqueries?: SubqueryDependency[];
}

/** Options for {@link translateWhere}. */
export interface TranslateWhereOptions {
  /**
   * Optional SQL table alias (e.g. `'t'`) to prefix every translated column
   * reference (`t."COL"`), used when pushing `WHERE` predicates into
   * `ELECTRIC_CHANGES` / base-table joins.
   */
  tableAlias?: string;
  /**
   * Opt-in safe scalar functions (`LOWER`, `UPPER`, `TRIM`, `COALESCE`, `ABS`,
   * `CHAR_LENGTH`, `CHARACTER_LENGTH`). Defaults to `false` so strict single-table
   * callers keep refusing all functions unless opted in (`M31 Item 3`).
   */
  allowFunctions?: boolean;
  /**
   * Served tables map (`UPPER_TABLE_NAME` -> `(shapeColName -> quotedFirebirdCol)`)
   * enabling validated `col [NOT] IN (SELECT parent_col FROM parent_table [WHERE ...])`
   * relational subqueries (`M31 Item 3`).
   */
  servedTables?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'quoted'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'param'; index: number }
  | { kind: 'op'; text: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i))!;
      tokens.push({ kind: 'word', text: m[0] });
      i += m[0].length;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i))!;
      tokens.push({ kind: 'number', text: m[0] });
      i += m[0].length;
    } else if (ch === "'" || ch === '"') {
      // Doubled to escape, in both.
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new WhereError(`where: unterminated ${ch === "'" ? 'string' : 'name'}`);
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            value += ch;
            j += 2;
            continue;
          }
          break;
        }
        value += text[j];
        j++;
      }
      tokens.push(ch === "'" ? { kind: 'string', text: value } : { kind: 'quoted', text: value });
      i = j + 1;
    } else if (ch === '$') {
      const m = /^\$(\d+)/.exec(text.slice(i));
      if (!m) throw new WhereError('where: $ must be followed by a parameter number');
      tokens.push({ kind: 'param', index: Number(m[1]) });
      i += m[0].length;
    } else {
      const m = /^(<>|!=|<=|>=|=|<|>|\(|\)|,|-)/.exec(text.slice(i));
      if (!m) throw new WhereError(`where: ${JSON.stringify(text.slice(i, i + 10))} is not supported`);
      tokens.push({ kind: 'op', text: m[0] });
      i += m[0].length;
    }
  }
  return tokens;
}

const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'NULL',
  'IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'TRUE',
  'FALSE',
  'SELECT',
  'FROM',
  'WHERE',
]);

const SAFE_FUNCTIONS = new Set([
  'LOWER',
  'UPPER',
  'TRIM',
  'COALESCE',
  'ABS',
  'CHAR_LENGTH',
  'CHARACTER_LENGTH',
]);

/**
 * Translate `text` into Firebird SQL.
 *
 * `columns` maps the names a client writes (the shape's names: `title` for
 * Firebird's `TITLE`) to the Firebird column, quoted.  `params` are the
 * values of `$1`, `$2`…, as text.
 */
export function translateWhere(
  text: string,
  columns: ReadonlyMap<string, string>,
  params: ReadonlyMap<number, string>,
  options: TranslateWhereOptions = {},
): FirebirdWhere {
  const tokens = tokenize(text);
  const bound: unknown[] = [];
  const subqueries: SubqueryDependency[] = [];
  let pos = 0;
  let lastColumnShapeName: string | undefined;

  const peek = () => tokens[pos];
  const isWord = (t: Token | undefined, word: string) => t?.kind === 'word' && t.text.toUpperCase() === word;
  const isOp = (t: Token | undefined, op: string) => t?.kind === 'op' && t.text === op;
  const expectOp = (op: string) => {
    if (!isOp(peek(), op)) throw new WhereError(`where: expected ${op}`);
    pos++;
  };

  const column = (name: string, quoted: boolean): string => {
    const key = quoted ? name : name.toLowerCase();
    const found = columns.get(key) ?? columns.get(name);
    if (!found) throw new WhereError(`where: ${name} is not a column of this shape's table`);
    lastColumnShapeName = columns.has(key) ? key : name;
    return options.tableAlias ? `${options.tableAlias}.${found}` : found;
  };

  const bind = (value: unknown) => {
    bound.push(value);
    return '?';
  };

  // operand := column | safe_func(...) | literal | $n | '(' expr ')' | '-' number
  const operand = (): string => {
    const t = peek();
    if (!t) throw new WhereError('where: ends too soon');
    if (isOp(t, '(')) {
      pos++;
      const inner = or();
      expectOp(')');
      return `(${inner})`;
    }
    if (isOp(t, '-')) {
      pos++;
      const n = peek();
      if (n?.kind !== 'number') throw new WhereError('where: - must be followed by a number');
      pos++;
      return bind(`-${n.text}`);
    }
    pos++;
    switch (t.kind) {
      case 'number': return bind(t.text);
      case 'string': return bind(t.text);
      case 'param': {
        const value = params.get(t.index);
        if (value === undefined) throw new WhereError(`where: $${t.index} has no value (params[${t.index}])`);
        return bind(value);
      }
      case 'quoted': return column(t.text, true);
      case 'word': {
        const upper = t.text.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE') return upper;
        if (upper === 'NULL') return 'NULL';
        if (isOp(peek(), '(')) {
          if (!options.allowFunctions || !SAFE_FUNCTIONS.has(upper)) {
            throw new WhereError(`where: functions (${t.text}) are not supported`);
          }
          expectOp('(');
          const args = [operand()];
          while (isOp(peek(), ',')) {
            pos++;
            args.push(operand());
          }
          expectOp(')');
          return `${upper === 'CHAR_LENGTH' ? 'CHAR_LENGTH' : upper}(${args.join(', ')})`;
        }
        if (KEYWORDS.has(upper)) throw new WhereError(`where: ${t.text} is out of place`);
        return column(t.text, false);
      }
      default:
        throw new WhereError(`where: ${'text' in t ? t.text : 'this'} is out of place`);
    }
  };

  // predicate := operand [comparison | IS [NOT] NULL | [NOT] IN (…) | [NOT] LIKE … | [NOT] BETWEEN … AND …]
  const predicate = (): string => {
    const left = operand();
    const t = peek();
    if (t?.kind === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      pos++;
      return `${left} ${t.text === '!=' ? '<>' : t.text} ${operand()}`;
    }
    if (isWord(t, 'IS')) {
      pos++;
      const not = isWord(peek(), 'NOT');
      if (not) pos++;
      if (isWord(peek(), 'NULL')) {
        pos++;
        return `${left} IS ${not ? 'NOT ' : ''}NULL`;
      }
      if (isWord(peek(), 'TRUE')) {
        pos++;
        return `${left} IS ${not ? 'NOT ' : ''}TRUE`;
      }
      if (isWord(peek(), 'FALSE')) {
        pos++;
        return `${left} IS ${not ? 'NOT ' : ''}FALSE`;
      }
      throw new WhereError('where: IS takes only [NOT] NULL, TRUE, or FALSE');
    }
    const not = isWord(t, 'NOT') && (isWord(tokens[pos + 1], 'IN') || isWord(tokens[pos + 1], 'LIKE')
      || isWord(tokens[pos + 1], 'ILIKE') || isWord(tokens[pos + 1], 'BETWEEN'));
    if (not) pos++;
    const neg = not ? 'NOT ' : '';
    if (isWord(peek(), 'IN')) {
      const childColShape = lastColumnShapeName;
      pos++;
      expectOp('(');
      if (isWord(peek(), 'SELECT')) {
        if (!options.servedTables) {
          throw new WhereError('where: subqueries require servedTables configuration');
        }
        pos++; // consume SELECT
        const selColTok = peek();
        if (!selColTok || (selColTok.kind !== 'word' && selColTok.kind !== 'quoted')) {
          throw new WhereError('where: subquery SELECT must name a single column');
        }
        pos++;
        if (!isWord(peek(), 'FROM')) {
          throw new WhereError('where: subquery expected FROM after column');
        }
        pos++;
        const tblTok = peek();
        if (!tblTok || (tblTok.kind !== 'word' && tblTok.kind !== 'quoted')) {
          throw new WhereError('where: subquery expected table name after FROM');
        }
        pos++;
        const parentTableKey = tblTok.kind === 'quoted' ? tblTok.text : tblTok.text.toUpperCase();
        const parentCols =
          options.servedTables.get(parentTableKey) ??
          options.servedTables.get(tblTok.text.toUpperCase());
        if (!parentCols) {
          throw new WhereError(`where: subquery table ${tblTok.text} is not served`);
        }
        const parentColKey = selColTok.kind === 'quoted' ? selColTok.text : selColTok.text.toLowerCase();
        const parentColSql = parentCols.get(parentColKey) ?? parentCols.get(selColTok.text);
        if (!parentColSql) {
          throw new WhereError(
            `where: ${selColTok.text} is not a column of subquery table ${tblTok.text}`,
          );
        }

        let subWhere: FirebirdWhere | undefined;
        if (isWord(peek(), 'WHERE')) {
          pos++;
          let depth = 1;
          const startIdx = pos;
          while (pos < tokens.length) {
            if (isOp(tokens[pos], '(')) depth++;
            else if (isOp(tokens[pos], ')')) {
              depth--;
              if (depth === 0) break;
            }
            pos++;
          }
          if (depth !== 0) throw new WhereError('where: unterminated subquery');
          const subTokens = tokens.slice(startIdx, pos);
          const subText = subTokens
            .map((tk) => {
              if (tk.kind === 'string') return `'${tk.text.replace(/'/g, "''")}'`;
              if (tk.kind === 'quoted') return `"${tk.text.replace(/"/g, '""')}"`;
              if (tk.kind === 'param') return `$${tk.index}`;
              return tk.text;
            })
            .join(' ');
          subWhere = translateWhere(subText, parentCols, params, {
            allowFunctions: options.allowFunctions,
            servedTables: options.servedTables,
          });
          bound.push(...subWhere.params);
        }
        expectOp(')');
        const quotedParentTbl = `"${parentTableKey.replace(/"/g, '""')}"`;
        const subSql =
          `SELECT ${parentColSql} FROM ${quotedParentTbl}` +
          (subWhere ? ` WHERE ${subWhere.sql}` : '');
        subqueries.push({
          childColumnSql: left,
          childColumnName: childColShape,
          parentTable: parentTableKey,
          parentColumn: parentColKey,
          parentColumnSql: parentColSql,
          negated: not,
          parentWhere: subWhere,
        });
        return `${left} ${neg}IN (${subSql})`;
      }

      const items = [operand()];
      while (isOp(peek(), ',')) {
        pos++;
        items.push(operand());
      }
      expectOp(')');
      return `${left} ${neg}IN (${items.join(', ')})`;
    }
    if (isWord(peek(), 'LIKE')) {
      pos++;
      return `${left} ${neg}LIKE ${operand()}`;
    }
    if (isWord(peek(), 'ILIKE')) {
      pos++;
      return `UPPER(${left}) ${neg}LIKE UPPER(${operand()})`;
    }
    if (isWord(peek(), 'BETWEEN')) {
      pos++;
      const low = operand();
      if (!isWord(peek(), 'AND')) throw new WhereError('where: BETWEEN needs AND');
      pos++;
      return `${left} ${neg}BETWEEN ${low} AND ${operand()}`;
    }
    if (not) throw new WhereError('where: NOT is out of place');
    // A column or value on its own: a boolean.
    return left;
  };

  const notExpr = (): string => {
    if (isWord(peek(), 'NOT')) {
      pos++;
      return `NOT (${notExpr()})`;
    }
    return predicate();
  };

  const and = (): string => {
    const parts = [notExpr()];
    while (isWord(peek(), 'AND')) {
      pos++;
      parts.push(notExpr());
    }
    return parts.join(' AND ');
  };

  function or(): string {
    const parts = [and()];
    while (isWord(peek(), 'OR')) {
      pos++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(' OR ');
  }

  if (tokens.length === 0) throw new WhereError('where is empty');
  const sql = or();
  if (pos < tokens.length) {
    const t = tokens[pos]!;
    throw new WhereError(`where: ${'text' in t ? t.text : `$${(t as { index: number }).index}`} is out of place`);
  }
  return subqueries.length > 0 ? { sql, params: bound, subqueries } : { sql, params: bound };
}
