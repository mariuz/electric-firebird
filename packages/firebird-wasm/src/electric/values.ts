/**
 * values.ts – Postgres values, as Electric sends them, into Firebird.
 *
 * Electric sends every value as Postgres's text output and describes the
 * columns once, in the `electric-schema` response header.  This turns one
 * into a parameter Firebird converts exactly, and refuses what it does not
 * map by name rather than storing something that looks right and is not.
 *
 * Observed from Electric 1.8 (not all of it in the documentation): a boolean
 * is `"true"` in the initial snapshot and `"f"` in a live update; a
 * `timestamptz` arrives in UTC as `2024-05-01 10:00:00+00`; arrays are marked
 * `dims`, and the primary key `pk_index`.
 */

/** One column of `electric-schema`. */
export interface ElectricColumn {
  type: string;
  dims?: number;
  pk_index?: number;
  not_null?: boolean;
  max_length?: number;
  length?: number;
  precision?: number;
  scale?: number;
}

/** The `electric-schema` header, parsed: Postgres column name to its type. */
export type ElectricSchema = Record<string, ElectricColumn>;

type Convert = (text: string, column: string) => unknown;

const asText: Convert = (text) => text;

const asInteger: Convert = (text) => Number(text);

// As text, which Firebird converts to BIGINT exactly; the Node driver cannot
// bind a JavaScript bigint at all.
const asBigInt: Convert = (text, column) => {
  if (!/^-?\d+$/.test(text)) {
    throw new RangeError(`Column ${column} holds ${text}, which is not a whole number`);
  }
  return text;
};

const asFloat: Convert = (text, column) => {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    // Postgres has NaN and ±Infinity; Firebird has no literal for them.
    throw new RangeError(`Column ${column} holds ${text}, which Firebird cannot store`);
  }
  return value;
};

const asNumeric: Convert = (text, column) => {
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    throw new RangeError(`Column ${column} holds ${text}, which Firebird cannot store`);
  }
  // Exact: the text goes to a NUMERIC or DECFLOAT column, which converts it digit for digit.
  return text;
};

const asBoolean: Convert = (text, column) => {
  // Both forms occur: the snapshot says "true", the replication stream "t".
  if (text === 't' || text === 'true') return true;
  if (text === 'f' || text === 'false') return false;
  throw new RangeError(`Column ${column} holds ${text}, which is not a boolean`);
};

/** Firebird keeps time to 1/10000 s; Postgres sends up to six digits. */
function fourDigitFraction(text: string): string {
  return text.replace(/(\.\d{4})\d+/, '$1');
}

/** `+05:30` from `+05:30`, `+05` or `+0530`, as Firebird reads an offset. */
function offset(sign: string, hours: string, minutes = '00'): string {
  return ` ${sign}${hours}:${minutes}`;
}

const asDate: Convert = (text, column) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(text)) {
    // 'infinity', BC dates and years past 9999 have no Firebird DATE.
    throw new RangeError(`Column ${column} holds ${text}, which Firebird cannot store`);
  }
  return text;
};

const asTime: Convert = (text) => fourDigitFraction(text);

const asTimestamp: Convert = (text, column) => {
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(text)) {
    throw new RangeError(`Column ${column} holds ${text}, which Firebird cannot store`);
  }
  return fourDigitFraction(text);
};

const ZONED = /^(.*?)([+-])(\d\d):?(\d\d)?(?::\d\d)?$/;

const asZoned: Convert = (text, column) => {
  const match = ZONED.exec(text);
  if (!match || !/^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d(\.\d+)?$/.test(match[1]!)) {
    throw new RangeError(`Column ${column} holds ${text}, which Firebird cannot store`);
  }
  return fourDigitFraction(match[1]!) + offset(match[2]!, match[3]!, match[4]);
};

// Postgres's hex output (`\x` and two digits a byte), the default since 9.0,
// into the bytes, which bind as themselves into a BLOB SUB_TYPE BINARY.
const asBytes: Convert = (text, column) => {
  if (!/^\\x([0-9a-fA-F]{2})*$/.test(text)) {
    throw new RangeError(
      `Column ${column} holds bytea that is not in hex form (\\x…); ` +
        "Postgres's bytea_output must be 'hex', its default",
    );
  }
  const bytes = new Uint8Array((text.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
};

/** Postgres type name to its conversion, for every type this maps. */
const CONVERSIONS: Record<string, Convert> = {
  int2: asInteger,
  int4: asInteger,
  int8: asBigInt,
  numeric: asNumeric,
  decfloat: asNumeric,
  float4: asFloat,
  float8: asFloat,
  bool: asBoolean,
  text: asText,
  varchar: asText,
  bpchar: asText,
  name: asText,
  citext: asText,
  uuid: asText,
  json: asText,
  jsonb: asText,
  date: asDate,
  time: asTime,
  timestamp: asTimestamp,
  timetz: asZoned,
  timestamptz: asZoned,
  bytea: asBytes,
};

/** Why a type is not mapped, where there is more to say than "not yet". */
const REFUSED: Record<string, string> = {};

/**
 * Check that every column of `schema` can be stored, before any row is.
 * @throws naming each column and type that cannot.
 */
export function checkSchema(schema: ElectricSchema): void {
  const problems: string[] = [];
  for (const [column, info] of Object.entries(schema)) {
    if ((info.dims ?? 0) > 0) continue; // arrays: stored as JSON text
    if (CONVERSIONS[info.type]) continue;
    problems.push(`${column} (${info.type}): ${REFUSED[info.type] ?? 'this Postgres type is not mapped to Firebird'}`);
  }
  if (problems.length > 0) {
    throw new TypeError(
      `This shape has columns firebird-wasm/electric cannot store:\n  ${problems.join('\n  ')}\n` +
        'Leave them out with the shape\'s columns parameter, or cast them to text in a view',
    );
  }
}

/**
 * One value from Electric as a Firebird parameter.
 *
 * `value` is Electric's text, `null`, or for an array column the array the
 * client parsed (of texts), which is stored as JSON.
 */
export function toFirebird(value: unknown, column: string, info: ElectricColumn): unknown {
  if (value === null || value === undefined) return null;
  if ((info.dims ?? 0) > 0) return JSON.stringify(value);
  const convert = CONVERSIONS[info.type];
  if (!convert) {
    throw new TypeError(`Column ${column} has type ${info.type}, which is not mapped to Firebird`);
  }
  return convert(String(value), column);
}

/**
 * The Firebird identifier for a Postgres column, quoted.
 *
 * Postgres folds unquoted names to lower case and Firebird to upper, so a
 * plain lower-case Postgres name maps to the upper-case Firebird name that
 * the same unquoted word finds (`title` → `"TITLE"`).  Anything else was
 * quoted in Postgres to exist and stays exactly as it is (`"camelCase"`).
 */
export function firebirdColumn(postgresName: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(postgresName)) return quote(postgresName.toUpperCase());
  return quote(postgresName);
}

/**
 * A table or column name as written in Firebird SQL, quoted: `items` and
 * `ITEMS` are `"ITEMS"`; a name given in double quotes keeps its case.
 */
export function firebirdName(name: string): string {
  const quoted = /^"((?:[^"]|"")+)"$/.exec(name);
  if (quoted) return name;
  if (/^[A-Za-z][A-Za-z0-9_$]*$/.test(name)) return quote(name.toUpperCase());
  throw new TypeError(`${name} is not a Firebird name; write it in double quotes to use it as it is`);
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The Firebird column type for one Postgres column, for `tableFromSchema`. */
function firebirdType(info: ElectricColumn): string {
  if ((info.dims ?? 0) > 0) return 'BLOB SUB_TYPE TEXT';
  switch (info.type) {
    case 'int2': return 'SMALLINT';
    case 'int4': return 'INTEGER';
    case 'int8': return 'BIGINT';
    case 'numeric':
      return info.precision !== undefined
        ? `NUMERIC(${Math.min(info.precision, 38)}, ${info.scale ?? 0})`
        : 'DECFLOAT(34)';
    case 'decfloat':
      return 'DECFLOAT(34)';
    case 'float4': return 'FLOAT';
    case 'float8': return 'DOUBLE PRECISION';
    case 'bool': return 'BOOLEAN';
    case 'varchar': return info.max_length ? `VARCHAR(${info.max_length})` : 'BLOB SUB_TYPE TEXT';
    case 'bpchar': return `CHAR(${info.length ?? 1})`;
    // Not CHAR(36): a CHAR column reads back padded to its byte length.
    case 'uuid': return 'VARCHAR(36)';
    case 'date': return 'DATE';
    case 'time': return 'TIME';
    case 'timetz': return 'TIME WITH TIME ZONE';
    case 'timestamp': return 'TIMESTAMP';
    case 'timestamptz': return 'TIMESTAMP WITH TIME ZONE';
    case 'bytea': return 'BLOB SUB_TYPE BINARY';
    case 'text':
    case 'name':
    case 'citext':
    case 'json':
    case 'jsonb':
      return 'BLOB SUB_TYPE TEXT';
    default:
      throw new TypeError(`${info.type} is not mapped to Firebird`);
  }
}

/**
 * `CREATE TABLE` for a shape's columns, to read and adjust before running.
 *
 * Unbounded text becomes `BLOB SUB_TYPE TEXT`, which cannot be part of a key
 * or an index; a text primary key gets `VARCHAR(255)` instead, and is worth
 * a look.  Nothing here runs the statement: what types a table should have
 * is the app's call, and a later change to the Postgres table does not
 * migrate this one.
 */
export function tableFromSchema(table: string, schema: ElectricSchema): string {
  checkSchema(schema);
  const columns = Object.entries(schema);
  const key = columns
    .filter(([, info]) => info.pk_index !== undefined)
    .sort(([, a], [, b]) => a.pk_index! - b.pk_index!)
    .map(([name]) => name);
  const lines = columns.map(([name, info]) => {
    let type = firebirdType(info);
    if (key.includes(name) && type === 'BLOB SUB_TYPE TEXT') type = 'VARCHAR(255)';
    if (key.includes(name) && type === 'BLOB SUB_TYPE BINARY') type = 'VARCHAR(255) CHARACTER SET OCTETS';
    const notNull = info.not_null || key.includes(name) ? ' NOT NULL' : '';
    return `  ${firebirdColumn(name)} ${type}${notNull}`;
  });
  if (key.length > 0) lines.push(`  PRIMARY KEY (${key.map(firebirdColumn).join(', ')})`);
  return `CREATE TABLE ${firebirdName(table)} (\n${lines.join(',\n')}\n)`;
}

/** The shape's primary key, as Postgres column names in key order. */
export function primaryKeyOf(schema: ElectricSchema): string[] {
  return Object.entries(schema)
    .filter(([, info]) => info.pk_index !== undefined)
    .sort(([, a], [, b]) => a.pk_index! - b.pk_index!)
    .map(([name]) => name);
}
