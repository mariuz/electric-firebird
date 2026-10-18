/**
 * electric-example.ts – what playwright.examples.config.ts and
 * examples-electric.spec.ts share about examples/electric: whether the
 * services it needs are configured, and the ports its servers listen on.
 */

const env = process.env;

/** Postgres with Electric, and a Firebird server, as build-wasm.yml starts them. */
export const electricExampleConfigured = Boolean(
  env['ELECTRIC_URL'] && env['PG_URL'] && env['FIREBIRD_SHAPES_HOST'] && env['FIREBIRD_SHAPES_PASSWORD'] !== undefined,
);

/** Served twice, as the other examples: the threaded engine, then the build without threads. */
export const ELECTRIC_EXAMPLE_PORTS = [
  { port: 4184, isolated: true },
  { port: 4185, isolated: false },
];

/** The example server's environment for one port: its own database on the Firebird server. */
export function electricExampleEnv(port: number): Record<string, string> {
  return {
    PORT: String(port),
    PG_URL: env['PG_URL'] ?? '',
    ELECTRIC_URL: env['ELECTRIC_URL'] ?? '',
    FIREBIRD_DATABASE: `${env['FIREBIRD_SHAPES_HOST']}:/tmp/electric-example-${port}-${Date.now()}.fdb`,
    FIREBIRD_USER: 'SYSDBA',
    FIREBIRD_PASSWORD: env['FIREBIRD_SHAPES_PASSWORD'] ?? '',
  };
}
