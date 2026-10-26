/**
 * live-tables.ts – automatic table extraction and POST_EVENT trigger DDL for
 * zero-config `db.live()` / `useLiveQuery()`.
 */

interface SqlToken {
  type: 'word' | 'quoted' | 'punct';
  /** Uppercase for `word`, unescaped exact identifier for `quoted`, character for `punct`. */
  value: string;
}

/**
 * Tokenize a SQL statement while stripping line comments (`--`), block
 * comments (`/* ... *\/`), and single-quoted string literals (`'...'`).
 * Double-quoted identifiers (`"..."`) are preserved as `'quoted'` tokens.
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }

    // Line comment: -- ...
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i < len) i += 2;
      continue;
    }

    // Single-quoted string literal: '...' (with '' escapes)
    if (ch === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          i++;
          if (sql[i] === "'") {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      // Represent string literal as a placeholder token so expressions like
      // TRIM('x' FROM col) see a non-clause token before FROM.
      tokens.push({ type: 'punct', value: "'" });
      continue;
    }

    // Double-quoted identifier: "..." (with "" escapes)
    if (ch === '"') {
      i++;
      let ident = '';
      while (i < len) {
        if (sql[i] === '"') {
          i++;
          if (sql[i] === '"') {
            ident += '"';
            i++;
            continue;
          }
          break;
        }
        ident += sql[i]!;
        i++;
      }
      if (ident.length > 0) {
        tokens.push({ type: 'quoted', value: ident });
      }
      continue;
    }

    // Bare identifier / keyword (Firebird allows A-Z, a-z, 0-9, _, $)
    if (
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      ch === '_'
    ) {
      const start = i;
      i++;
      while (i < len) {
        const c = sql[i]!;
        if (
          (c >= 'A' && c <= 'Z') ||
          (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') ||
          c === '_' ||
          c === '$'
        ) {
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: 'word', value: sql.slice(start, i).toUpperCase() });
      continue;
    }

    // Punctuation of interest: ( ) , ; .
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.') {
      tokens.push({ type: 'punct', value: ch });
      i++;
      continue;
    }

    // Skip numbers and operators
    i++;
  }

  return tokens;
}

/**
 * SQL keywords that terminate a `FROM t1 [alias], t2 [alias]` list.
 */
const FROM_CLAUSE_END = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'WINDOW',
  'ORDER',
  'ROWS',
  'OFFSET',
  'FETCH',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'PLAN',
  'FOR',
  'INTO',
  'LIMIT',
  'WHEN',
  'SET',
  'VALUES',
  'RETURNING',
]);

/**
 * SQL functions whose syntax uses `FROM` inside their argument list
 * (`EXTRACT(YEAR FROM d)`, `TRIM(BOTH ' ' FROM s)`, `SUBSTRING(s FROM 1 FOR 2)`,
 * `OVERLAY(s PLACING 'x' FROM 1)`).
 */
const FUNC_WITH_FROM = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'OVERLAY']);

function isSystemTable(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith('RDB$') ||
    upper.startsWith('MON$') ||
    upper.startsWith('SEC$') ||
    upper.startsWith('PLG$')
  );
}

/**
 * Extract the deduplicated list of user table names referenced by a SQL
 * statement (`FROM`, `JOIN`, `UPDATE`, `INTO`, `DELETE FROM`), excluding
 * CTEs (`WITH name AS (...)`), selectable stored procedures (`FROM proc(...)`),
 * and Firebird system tables (`RDB$*`, `MON$*`, `SEC$*`, `PLG$*`).
 *
 * Unquoted identifiers are normalized to uppercase (matching Firebird's
 * catalog storage); double-quoted identifiers preserve their exact case.
 */
export function extractReferencedTables(sql: string): string[] {
  const tokens = tokenizeSql(sql);
  const cteNames = new Set<string>();
  const tables: string[] = [];
  const seen = new Set<string>();

  // First pass: collect CTE names in `WITH [RECURSIVE] cte_name [(...)] AS (...)`
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type === 'word' && tok.value === 'WITH') {
      let j = i + 1;
      if (j < tokens.length && tokens[j]!.type === 'word' && tokens[j]!.value === 'RECURSIVE') {
        j++;
      }
      while (j < tokens.length) {
        const nameTok = tokens[j];
        if (!nameTok || (nameTok.type !== 'word' && nameTok.type !== 'quoted')) break;
        const candidateName = nameTok.value;
        j++;
        // Optional column list: WITH cte (a, b) AS (...)
        if (j < tokens.length && tokens[j]!.type === 'punct' && tokens[j]!.value === '(') {
          let depth = 1;
          j++;
          while (j < tokens.length && depth > 0) {
            if (tokens[j]!.type === 'punct' && tokens[j]!.value === '(') depth++;
            else if (tokens[j]!.type === 'punct' && tokens[j]!.value === ')') depth--;
            j++;
          }
        }
        // Expect AS (
        if (
          j < tokens.length &&
          tokens[j]!.type === 'word' &&
          tokens[j]!.value === 'AS' &&
          j + 1 < tokens.length &&
          tokens[j + 1]!.type === 'punct' &&
          tokens[j + 1]!.value === '('
        ) {
          cteNames.add(candidateName);
          j += 2; // skip AS (
          let depth = 1;
          while (j < tokens.length && depth > 0) {
            if (tokens[j]!.type === 'punct' && tokens[j]!.value === '(') depth++;
            else if (tokens[j]!.type === 'punct' && tokens[j]!.value === ')') depth--;
            j++;
          }
          // If followed by `,`, another CTE definition follows
          if (j < tokens.length && tokens[j]!.type === 'punct' && tokens[j]!.value === ',') {
            j++;
            continue;
          }
        }
        break;
      }
    }
  }

  const addTable = (name: string): void => {
    if (!name || isSystemTable(name) || cteNames.has(name) || seen.has(name)) return;
    seen.add(name);
    tables.push(name);
  };

  // Track enclosing parentheses to know whether we are inside EXTRACT/TRIM/SUBSTRING/OVERLAY.
  const parenStack: Array<string | null> = [];
  // Whether we are currently inside a top-level (for that paren depth) FROM clause list
  // so comma-separated tables `FROM t1 a, t2 b` are recognized.
  const inFromClauseAtDepth = new Set<number>();

  const consumeTableRef = (startIdx: number): number => {
    let idx = startIdx;
    if (idx >= tokens.length) return idx;
    let tok = tokens[idx]!;
    if (tok.type !== 'word' && tok.type !== 'quoted') return idx;
    if (tok.type === 'word' && FROM_CLAUSE_END.has(tok.value)) return idx;

    // Handle optional schema/package prefix: schema.table
    if (
      idx + 2 < tokens.length &&
      tokens[idx + 1]!.type === 'punct' &&
      tokens[idx + 1]!.value === '.' &&
      (tokens[idx + 2]!.type === 'word' || tokens[idx + 2]!.type === 'quoted')
    ) {
      idx += 2;
      tok = tokens[idx]!;
    }

    // If immediately followed by `(`, it is a selectable stored procedure or table function
    if (idx + 1 < tokens.length && tokens[idx + 1]!.type === 'punct' && tokens[idx + 1]!.value === '(') {
      return idx + 1;
    }

    addTable(tok.value);
    return idx + 1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const depth = parenStack.length;

    if (tok.type === 'punct') {
      if (tok.value === '(') {
        const prev = i > 0 ? tokens[i - 1]! : undefined;
        parenStack.push(prev && prev.type === 'word' ? prev.value : null);
      } else if (tok.value === ')') {
        inFromClauseAtDepth.delete(depth);
        parenStack.pop();
      } else if (tok.value === ';') {
        inFromClauseAtDepth.clear();
      } else if (tok.value === ',' && inFromClauseAtDepth.has(depth)) {
        // Next item in `FROM t1 a, t2 b`
        i = consumeTableRef(i + 1) - 1;
      }
      continue;
    }

    if (tok.type === 'word') {
      const currentParenFunc = depth > 0 ? parenStack[depth - 1] : null;
      if (currentParenFunc && FUNC_WITH_FROM.has(currentParenFunc)) {
        continue;
      }

      if (tok.value === 'FROM') {
        const next = tokens[i + 1];
        if (next && next.type === 'punct' && next.value === '(') {
          // Derived table `FROM (SELECT ...)`
          inFromClauseAtDepth.add(depth);
          continue;
        }
        inFromClauseAtDepth.add(depth);
        i = consumeTableRef(i + 1) - 1;
        continue;
      }

      if (tok.value === 'JOIN') {
        const next = tokens[i + 1];
        if (next && next.type === 'punct' && next.value === '(') {
          continue;
        }
        i = consumeTableRef(i + 1) - 1;
        continue;
      }

      if (FROM_CLAUSE_END.has(tok.value)) {
        inFromClauseAtDepth.delete(depth);
      }
    }
  }

  return tables;
}

/**
 * Deterministic 16-character event and trigger identifier (`FB_LIVE$XXXXXXXX`)
 * for a table name. Fits well within Firebird's 31-byte event/identifier limit.
 */
export function liveTableEventName(table: string): string {
  let hash = 0x811c9dc5;
  for (const ch of table) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `FB_LIVE$${hash.toString(16).padStart(8, '0').toUpperCase()}`;
}

/** Quote a SQL identifier with double quotes, escaping internal `"` as `""`. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build the idempotent `CREATE OR ALTER TRIGGER` DDL and event name for
 * watching a user table via `POST_EVENT`.
 */
export function liveTableTriggerDDL(table: string): { eventName: string; ddl: string } {
  const eventName = liveTableEventName(table);
  const ddl =
    `CREATE OR ALTER TRIGGER ${eventName} FOR ${quoteIdentifier(table)} ` +
    `ACTIVE AFTER INSERT OR UPDATE OR DELETE POSITION 32767 ` +
    `AS BEGIN POST_EVENT '${eventName}'; END`;
  return { eventName, ddl };
}
