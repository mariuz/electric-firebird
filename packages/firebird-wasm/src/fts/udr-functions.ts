/**
 * SQL UDR Registration (`registerFtsFunctions`) for `firebird-wasm/fts`.
 */

import type { RegisteredRoutine } from '../types';
import {
  highlightSnippet,
  stemWord,
  tokenizeText,
  type FtsDatabaseExecutor,
} from './index';

/**
 * Register Full-Text Search utility functions on `db` via `db.registerFunction()`:
 * - `FTS_TOKENIZE(text)` -> JSON array of stemmed tokens (`VARCHAR(4096)`)
 * - `FTS_STEM(word)` -> Porter-stemmed token (`VARCHAR(256)`)
 * - `FTS_BM25(doc_text, query_text)` -> single-document BM25 relevance score (`DOUBLE PRECISION`)
 * - `FTS_HIGHLIGHT(doc_text, query_text)` -> `<mark>`-highlighted snippet (`VARCHAR(4096)`)
 */
export async function registerFtsFunctions(
  db: FtsDatabaseExecutor,
  options: { replace?: boolean } = {},
): Promise<RegisteredRoutine[]> {
  if (typeof db.registerFunction !== 'function') {
    throw new TypeError('Database instance does not support db.registerFunction()');
  }
  const replace = options.replace !== false;
  const routines: RegisteredRoutine[] = [];

  routines.push(
    await db.registerFunction(
      'FTS_TOKENIZE',
      {
        args: ['VARCHAR(8191)'],
        returns: 'VARCHAR(4096)',
        deterministic: true,
        replace,
      },
      (text: unknown) => {
        if (text == null) return null;
        return JSON.stringify(tokenizeText(String(text)));
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'FTS_STEM',
      {
        args: ['VARCHAR(256)'],
        returns: 'VARCHAR(256)',
        deterministic: true,
        replace,
      },
      (word: unknown) => {
        if (word == null) return null;
        return stemWord(String(word));
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'FTS_BM25',
      {
        args: ['VARCHAR(8191)', 'VARCHAR(1024)'],
        returns: 'DOUBLE PRECISION',
        deterministic: true,
        replace,
      },
      (docText: unknown, queryText: unknown) => {
        if (docText == null || queryText == null) return null;
        const docTokens = tokenizeText(String(docText));
        const qTokens = tokenizeText(String(queryText));
        if (docTokens.length === 0 || qTokens.length === 0) return 0;
        const tfMap = new Map<string, number>();
        for (const t of docTokens) {
          tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
        }
        const k1 = 1.2;
        const b = 0.75;
        const avgdl = 50;
        const normLen = 1 - b + b * (docTokens.length / avgdl);
        let score = 0;
        for (const q of new Set(qTokens)) {
          const tf = tfMap.get(q) ?? 0;
          if (tf > 0) {
            score += (tf * (k1 + 1)) / (tf + k1 * normLen);
          }
        }
        return score;
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'FTS_HIGHLIGHT',
      {
        args: ['VARCHAR(8191)', 'VARCHAR(1024)'],
        returns: 'VARCHAR(4096)',
        deterministic: true,
        replace,
      },
      (docText: unknown, queryText: unknown) => {
        if (docText == null || queryText == null) return null;
        return highlightSnippet(String(docText), String(queryText));
      },
    ),
  );

  return routines;
}
