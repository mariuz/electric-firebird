/**
 * catalog.ts – a Firebird table described as an Electric shape: its columns
 * in Postgres's type names, its key, and the SQL that renders each value as
 * the text the client parses.
 */

import type { ElectricColumn, ElectricSchema } from '../electric/values';

/** A column as the system tables describe it. */
export interface FirebirdColumn {
  /** The Firebird name, exactly (upper case unless it was quoted). */
  name: string;
  /** RDB$FIELD_TYPE. */
  type: number;
  subType: number;
  scale: number;
  precision: number;
  charLength: number;
  notNull: boolean;
  /** RDB$CHARACTER_SET_ID: 1 is OCTETS, the set of BINARY and VARBINARY. */
  charSet?: number;
}

/** How one column is read and described. */
export interface ColumnPlan {
  /** The Firebird name. */
  name: string;
  /** The name the shape uses: lower case where Firebird folded it. */
  shapeName: string;
  /** The SELECT expression that yields the value. */
  select: string;
  /** How the fetched value becomes text. */
  render: 'text' | 'number' | 'boolean' | 'blob' | 'bytes' | 'utc';
  /** The column in `electric-schema`. */
  schema: ElectricColumn;
}

export function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The shape's name for a Firebird column: a name Firebird folded to upper
 * case is lower case, as Postgres would fold it, and the client folds it back
 * (`TITLE` → `title` → `"TITLE"`); any other name is kept as it is.
 */
export function shapeName(firebirdName: string): string {
  return /^[A-Z][A-Z0-9_$]*$/.test(firebirdName) ? firebirdName.toLowerCase() : firebirdName;
}

/** RDB$CHARACTER_SET_ID of OCTETS. */
const OCTETS = 1;

/** The plan for one column, from its system-table description. */
export function planColumn(column: FirebirdColumn): ColumnPlan {
  const q = quote(column.name);
  const base = { name: column.name, shapeName: shapeName(column.name) };
  const schema = (type: string, extra: Partial<ElectricColumn> = {}): ElectricColumn => ({
    type,
    ...(column.notNull ? { not_null: true } : {}),
    ...extra,
  });
  const exact = (type: string, extra: Partial<ElectricColumn> = {}): ColumnPlan => ({
    ...base, select: `CAST(${q} AS VARCHAR(64))`, render: 'text', schema: schema(type, extra),
  });

  switch (column.type) {
    case 7: // SMALLINT, or NUMERIC/DECIMAL stored in one
    case 8: // INTEGER, likewise
    case 16: // BIGINT, likewise
    case 26: { // INT128, likewise
      if (column.scale < 0 || column.subType === 1 || column.subType === 2) {
        return exact('numeric', { precision: column.precision, scale: -column.scale });
      }
      if (column.type === 7) return { ...base, select: q, render: 'number', schema: schema('int2') };
      if (column.type === 8) return { ...base, select: q, render: 'number', schema: schema('int4') };
      if (column.type === 16) return exact('int8');
      return exact('numeric', { precision: 38, scale: 0 });
    }
    case 10: return { ...base, select: q, render: 'number', schema: schema('float4') };
    case 27: return { ...base, select: q, render: 'number', schema: schema('float8') };
    case 23: return { ...base, select: q, render: 'boolean', schema: schema('bool') };
    // BINARY(n) and VARBINARY(n) are CHAR and VARCHAR in OCTETS: bytes. Read
    // as a binary BLOB: the native driver decodes an OCTETS column as text.
    case 14:
      return column.charSet === OCTETS
        ? { ...base, select: `CAST(${q} AS BLOB SUB_TYPE BINARY)`, render: 'bytes', schema: schema('bytea') }
        : { ...base, select: q, render: 'text', schema: schema('bpchar', { length: column.charLength }) };
    case 37:
      return column.charSet === OCTETS
        ? { ...base, select: `CAST(${q} AS BLOB SUB_TYPE BINARY)`, render: 'bytes', schema: schema('bytea') }
        : { ...base, select: q, render: 'text', schema: schema('varchar', { max_length: column.charLength }) };
    case 261:
      return column.subType === 1
        ? { ...base, select: q, render: 'blob', schema: schema('text') }
        : { ...base, select: q, render: 'bytes', schema: schema('bytea') };
    case 12: return { ...base, select: `CAST(${q} AS VARCHAR(10))`, render: 'text', schema: schema('date') };
    case 13: return { ...base, select: `CAST(${q} AS VARCHAR(13))`, render: 'text', schema: schema('time') };
    case 35: return { ...base, select: `CAST(${q} AS VARCHAR(24))`, render: 'text', schema: schema('timestamp') };
    // The zoned types, in UTC: Firebird renders the zone as a name, the
    // client wants an offset.
    case 28:
      return { ...base, select: `CAST(${q} AT TIME ZONE 'UTC' AS VARCHAR(40))`, render: 'utc', schema: schema('timetz') };
    case 29:
      return { ...base, select: `CAST(${q} AT TIME ZONE 'UTC' AS VARCHAR(48))`, render: 'utc', schema: schema('timestamptz') };
    case 24:
    case 25:
      // DECFLOAT renders in exponent notation, which numeric does not take.
      return { ...base, select: 'NULL', render: 'text', schema: schema('decfloat') };
    default:
      return { ...base, select: 'NULL', render: 'text', schema: schema(`firebird_type_${column.type}`) };
  }
}

/** A table as the server serves it. */
export interface TablePlan {
  /** The Firebird name, exactly. */
  name: string;
  columns: ColumnPlan[];
  /** Key columns, Firebird names, in key order. */
  key: string[];
  schema: ElectricSchema;
}

/** Combine a table's columns and key into its plan. */
export function planTable(name: string, columns: FirebirdColumn[], key: string[]): TablePlan {
  if (columns.length === 0) throw new Error(`Table ${name} does not exist or has no columns`);
  if (key.length === 0) throw new Error(`Table ${name} has no primary key, which a shape needs`);
  if (key.length > 4) throw new Error(`Table ${name} has a key of ${key.length} columns; at most 4 are supported`);
  const plans = columns.map(planColumn);
  const schema: ElectricSchema = {};
  for (const plan of plans) {
    const index = key.indexOf(plan.name);
    schema[plan.shapeName] = index >= 0 ? { ...plan.schema, pk_index: index } : plan.schema;
  }
  return { name, columns: plans, key, schema };
}

/** Render one fetched value as the text Electric sends, or null. */
export function renderValue(plan: ColumnPlan, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (plan.render) {
    case 'number':
      // String() of a double is the shortest text that reads back as it.
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bytes': {
      // Postgres's hex form, of the bytes of a BLOB read whole.
      const bytes = Buffer.from(value as Uint8Array);
      return `\\x${bytes.toString('hex')}`;
    }
    case 'utc':
      // '2024-05-01 10:00:00.0000 UTC' → '2024-05-01 10:00:00.0000+00'
      return String(value).replace(/ (UTC|GMT|\+00:00)$/, '+00');
    default:
      return String(value);
  }
}

/**
 * A table name as a client gives it (`items`, `ITEMS` or `"Mixed"`) as the
 * name in the system tables.
 */
export function relationName(given: string): string {
  const quoted = /^"((?:[^"]|"")+)"$/.exec(given);
  if (quoted) return quoted[1]!.replace(/""/g, '"');
  return given.toUpperCase();
}
