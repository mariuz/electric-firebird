/**
 * batch-block.ts – one statement for many rows of parameters, as an
 * `EXECUTE BLOCK`, for the Node backend's `execBatch`.
 *
 * Firebird's batch interface (`IBatch`) sends many rows in one request; the
 * Node driver does not bind it (node-firebird-native-api 3.3.0, and upstream
 * master as of August 2026). Without it a batch is one round trip per row.
 * An `EXECUTE BLOCK` whose parameters are several rows' worth, and whose body
 * repeats the statement once per row, does the same work in one round trip:
 *
 *   EXECUTE BLOCK (p0_0 INTEGER = ?, p0_1 VARCHAR(20) CHARACTER SET UTF8 = ?,
 *                  p1_0 INTEGER = ?, p1_1 VARCHAR(20) CHARACTER SET UTF8 = ?)
 *   AS BEGIN
 *     INSERT INTO t VALUES (:p0_0, :p0_1);
 *     INSERT INTO t VALUES (:p1_0, :p1_1);
 *   END
 *
 * The parameters are declared with the types the driver already sends for
 * the statement's own `?` (its input metadata, after the driver's own type
 * rewrites), so the bytes on the wire and the conversions into each column
 * are the ones a row-by-row execute would make.
 *
 * Everything here is text and numbers: no driver, no server.
 */

/** One `?` as the driver binds it: its input metadata. */
export interface ParamDescriptor {
  /** `SQL_*` type, the nullable bit included or not. */
  type: number;
  subType: number;
  /** Bytes. */
  length: number;
  scale: number;
  /** Character set id; the collation in the high byte is ignored. */
  charSet: number;
}

/** A character set by id, as `RDB$CHARACTER_SETS` lists it. */
export interface CharacterSet {
  name: string;
  bytesPerCharacter: number;
}

/**
 * The offsets of the `?` placeholders in `sql`, skipping string literals
 * (`'…'`, with `''` inside, and Q-strings `q'{…}'`), quoted identifiers
 * (`"…"`) and comments (`-- …` and block comments). `undefined` if the text
 * ends inside one of them.
 */
export function placeholderOffsets(sql: string): number[] | undefined {
  const offsets: number[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === '?') {
      offsets.push(i);
      i++;
    } else if ((c === 'q' || c === 'Q') && sql[i + 1] === "'" && i + 2 < n && !isWordChar(sql[i - 1])) {
      // q'<open>…<close>' — the closing delimiter mirrors a bracket.
      const open = sql[i + 2];
      const close = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
      const end = sql.indexOf(`${close}'`, i + 3);
      if (end < 0) return undefined;
      i = end + 2;
    } else if (c === "'" || c === '"') {
      // A doubled quote is the quote itself, so scanning on is enough.
      let j = i + 1;
      for (;;) {
        if (j >= n) return undefined;
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 2;
    } else {
      i++;
    }
  }
  return offsets;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/**
 * The SQL type to declare a block parameter as, for one `?`, or `undefined`
 * when there is none to give (an untyped `?`, an array, a character set not
 * listed). Character lengths are in characters: the metadata counts bytes.
 */
export function blockParamType(
  p: ParamDescriptor,
  charsets: ReadonlyMap<number, CharacterSet>,
): string | undefined {
  const charset = () => charsets.get(p.charSet & 0xff);
  const numeric = (precision: number, plain: string) =>
    p.scale < 0 ? `NUMERIC(${precision}, ${-p.scale})` : plain;

  switch (p.type & ~1) {
    case 448: // SQL_VARYING
    case 452: {
      // SQL_TEXT
      const cs = charset();
      if (!cs || cs.bytesPerCharacter < 1) return undefined;
      const chars = Math.max(1, Math.floor(p.length / cs.bytesPerCharacter));
      return `${(p.type & ~1) === 452 ? 'CHAR' : 'VARCHAR'}(${chars}) CHARACTER SET ${cs.name}`;
    }
    case 480:
      return 'DOUBLE PRECISION';
    case 482:
      return 'FLOAT';
    case 500:
      return numeric(4, 'SMALLINT');
    case 496:
      return numeric(9, 'INTEGER');
    case 580:
      return numeric(18, 'BIGINT');
    case 32752:
      return numeric(38, 'INT128');
    case 510:
      return 'TIMESTAMP';
    case 570:
      return 'DATE';
    case 560:
      return 'TIME';
    case 32748: // SQL_TIMESTAMP_TZ_EX
    case 32754:
      return 'TIMESTAMP WITH TIME ZONE';
    case 32750: // SQL_TIME_TZ_EX
    case 32756:
      return 'TIME WITH TIME ZONE';
    case 32760:
      return 'DECFLOAT(16)';
    case 32762:
      return 'DECFLOAT(34)';
    case 32764:
      return 'BOOLEAN';
    case 520: {
      // SQL_BLOB
      if (p.subType !== 1) return `BLOB SUB_TYPE ${p.subType}`;
      const cs = charset();
      return cs ? `BLOB SUB_TYPE TEXT CHARACTER SET ${cs.name}` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The `EXECUTE BLOCK` running `sql` once for each of `rows` rows of
 * parameters: row r's k-th `?` becomes `:p<r>_<k>`, declared as `types[k]`.
 * A trailing semicolon on `sql` is dropped; each repetition ends with one.
 */
export function buildBlock(sql: string, offsets: number[], types: string[], rows: number): string {
  const text = sql.replace(/[\s;]+$/, '');
  const parts: string[] = [];
  let last = 0;
  for (const at of offsets) {
    parts.push(text.slice(last, at));
    last = at + 1;
  }
  const tail = text.slice(last);

  const decl: string[] = [];
  const body: string[] = [];
  for (let r = 0; r < rows; r++) {
    let stmt = parts[0] ?? '';
    for (let k = 0; k < offsets.length; k++) {
      decl.push(`p${r}_${k} ${types[k]} = ?`);
      stmt += `:p${r}_${k}${k + 1 < offsets.length ? parts[k + 1] : ''}`;
    }
    body.push(`${offsets.length ? stmt + tail : text};`);
  }
  return `EXECUTE BLOCK (${decl.join(', ')}) AS BEGIN\n${body.join('\n')}\nEND`;
}
