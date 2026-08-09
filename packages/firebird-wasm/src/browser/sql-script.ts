/**
 * sql-script.ts – split a SQL script into individual statements.
 *
 * The engine executes one statement at a time, so running a migration means
 * splitting it first.  Splitting on `;` alone is wrong in ways that corrupt
 * data rather than merely failing: a semicolon inside a string literal, an
 * identifier or a comment is not a terminator.
 *
 * Firebird adds `SET TERM`, which changes the terminator so that PSQL bodies —
 * full of their own semicolons — can be written at all.  A splitter that
 * ignores it cuts every stored procedure and trigger in half, which is most of
 * what a real migration contains.
 */

/** A statement and where it started, for error messages. */
export interface ScriptStatement {
  sql: string;
  /** 1-based line number of the statement's first character. */
  line: number;
}

const DEFAULT_TERMINATOR = ';';

/** Is `text` at `pos` the start of a `SET TERM <new> <old>` directive? */
function matchSetTerm(
  text: string,
  pos: number,
  terminator: string,
): { newTerminator: string; end: number } | null {
  const match = /^set\s+term\s+(\S+)/i.exec(text.slice(pos));
  if (!match) return null;

  let newTerminator = match[1]!;
  let end = pos + match[0].length;

  // isql accepts "SET TERM ^;" — the old terminator glued to the new one.
  if (newTerminator.length > terminator.length && newTerminator.endsWith(terminator)) {
    newTerminator = newTerminator.slice(0, -terminator.length);
  } else {
    // Otherwise the directive is itself closed by the current terminator.
    const rest = text.slice(end);
    const closing = rest.indexOf(terminator);
    if (closing !== -1) {
      end += closing + terminator.length;
    }
  }

  return { newTerminator, end };
}

/**
 * Split `script` into executable statements.
 *
 * Comments and empty statements are dropped; `SET TERM` directives are obeyed
 * and not emitted, since they configure the splitter rather than the engine.
 */
export function splitStatements(script: string): ScriptStatement[] {
  const statements: ScriptStatement[] = [];

  let terminator = DEFAULT_TERMINATOR;
  let current = '';
  let statementLine = 1;
  let line = 1;
  let i = 0;

  const push = (): void => {
    const sql = current.trim();
    if (sql) statements.push({ sql, line: statementLine });
    current = '';
  };

  while (i < script.length) {
    const ch = script[i]!;
    const two = script.slice(i, i + 2);

    // Line comment: to end of line, newline preserved so line numbers hold.
    if (two === '--') {
      const nl = script.indexOf('\n', i);
      i = nl === -1 ? script.length : nl;
      continue;
    }

    // Block comment.
    if (two === '/*') {
      const close = script.indexOf('*/', i + 2);
      const end = close === -1 ? script.length : close + 2;
      line += (script.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
      continue;
    }

    // String literal or quoted identifier: copied verbatim, terminators inside
    // are just characters.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      current += quote;
      while (j < script.length) {
        if (script[j] === quote) {
          // A doubled quote is an escaped quote, not the end.
          if (script[j + 1] === quote) {
            current += quote + quote;
            j += 2;
            continue;
          }
          current += quote;
          j++;
          break;
        }
        if (script[j] === '\n') line++;
        current += script[j];
        j++;
      }
      i = j;
      continue;
    }

    // SET TERM, only at the start of a statement.
    if ((ch === 's' || ch === 'S') && current.trim() === '') {
      const directive = matchSetTerm(script, i, terminator);
      if (directive) {
        line += (script.slice(i, directive.end).match(/\n/g) ?? []).length;
        terminator = directive.newTerminator;
        i = directive.end;
        current = '';
        statementLine = line;
        continue;
      }
    }

    // Statement terminator.
    if (script.startsWith(terminator, i)) {
      i += terminator.length;
      push();
      statementLine = line;
      continue;
    }

    if (ch === '\n') {
      line++;
      if (current.trim() === '') statementLine = line;
    }

    current += ch;
    i++;
  }

  // Trailing statement without a terminator.
  push();

  return statements;
}
