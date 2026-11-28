/**
 * features-barrel.ts – Shared Browser & Node Universal Feature Barrel (`M26`–`M32`).
 *
 * Keeps `src/index.ts` and `src/browser/index.ts` strictly `< 1,000` lines while
 * ensuring 100% browser-safe exports (zero `node:*` runtime imports).
 */

export * from './rag-cache';
export * from './data-seeder';
export * from './mcp-server';
export * from './rag-ingester';
export * from './otel-metrics';
export * from './encrypted-backup';
export * from './job-queue';
export * from './knowledge-graph';
export * from './online-migrator';
export * from './workload-advisor';
export * from './timeseries';
export * from './spatial';
export * from './cdc-sink';
export * from './edge-gateway';
export * from './temporal-table';
export * from './event-store';
export * from './auto-api-gateway';
export * from './federation';
export * from './jsonb-gin';
export * from './trigram';
export * from './prisma';
export {
  WASM_SHAPE_CHANGES_TABLE,
  WASM_SHAPE_META_TABLE,
  computeElectricCursor,
  computeShapeEtag,
  createWasmShapeServer,
  type WasmShapeDatabase,
  type WasmShapeServer,
  type WasmShapeServerOptions,
} from './electric-server/wasm-shape-server';
export * from './tanstack-db';
export * from './ivm';
export * from './pgwire/protocol';
export * from './electric-proxy';
export * from './age-graph';
