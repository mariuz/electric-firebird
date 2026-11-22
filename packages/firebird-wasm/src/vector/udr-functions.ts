/**
 * udr-functions.ts – SQL UDR Registration (`registerVectorFunctions`) for `firebird-wasm/vector`.
 */

import type { RegisteredRoutine } from '../types';
import {
  cosineDistance,
  cosineSimilarity,
  decodeVector,
  dotProduct,
  formatVectorText,
  l2Distance,
  vectorNorm,
  type RegisterVectorFunctionsOptions,
  type VectorDatabaseExecutor,
  type VectorInput,
} from './index';

export async function registerVectorFunctions(
  db: VectorDatabaseExecutor,
  options: RegisterVectorFunctionsOptions = {},
): Promise<RegisteredRoutine[]> {
  if (typeof db.registerFunction !== 'function') {
    throw new TypeError('Database instance does not support db.registerFunction()');
  }

  const maxLen = Math.max(64, Math.min(8191, options.maxArgLength ?? 8191));
  const replace = options.replace !== false;
  const vecArgType = `VARBINARY(${maxLen})`;
  const routines: RegisteredRoutine[] = [];

  routines.push(
    await db.registerFunction(
      'COSINE_DISTANCE',
      { args: [vecArgType, vecArgType], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (a: unknown, b: unknown) => (a == null || b == null ? null : cosineDistance(a as VectorInput, b as VectorInput)),
    ),
  );

  routines.push(
    await db.registerFunction(
      'COSINE_SIMILARITY',
      { args: [vecArgType, vecArgType], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (a: unknown, b: unknown) => (a == null || b == null ? null : cosineSimilarity(a as VectorInput, b as VectorInput)),
    ),
  );

  routines.push(
    await db.registerFunction(
      'L2_DISTANCE',
      { args: [vecArgType, vecArgType], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (a: unknown, b: unknown) => (a == null || b == null ? null : l2Distance(a as VectorInput, b as VectorInput)),
    ),
  );

  routines.push(
    await db.registerFunction(
      'DOT_PRODUCT',
      { args: [vecArgType, vecArgType], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (a: unknown, b: unknown) => (a == null || b == null ? null : dotProduct(a as VectorInput, b as VectorInput)),
    ),
  );

  routines.push(
    await db.registerFunction(
      'VECTOR_DIMS',
      { args: [vecArgType], returns: 'INTEGER', deterministic: true, replace },
      (v: unknown) => (v == null ? null : decodeVector(v).length),
    ),
  );

  routines.push(
    await db.registerFunction(
      'VECTOR_NORM',
      { args: [vecArgType], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (v: unknown) => (v == null ? null : vectorNorm(v as VectorInput)),
    ),
  );

  routines.push(
    await db.registerFunction(
      'VECTOR_TO_TEXT',
      { args: [vecArgType], returns: 'VARCHAR(4096)', deterministic: true, replace },
      (v: unknown) => (v == null ? null : formatVectorText(v as VectorInput)),
    ),
  );

  return routines;
}
