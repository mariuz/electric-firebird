/**
 * http-client-ops.ts – Resumable Chunked Snapshot & `"FBCHANGELOG\0"` Segment
 * Operations for `HttpReplicationClient` (`M28 Item 5`).
 */

import type { PublicationSnapshot, ReplicableDatabase } from './types';
import {
  base64ToBytes,
  bytesToBase64,
  gunzipBytes,
  gzipBytes,
  isGzipBytes,
} from './shared';
import {
  applyFbChangelogSegmentToDatabase,
  type ApplyFbChangelogResult,
  type JrdColumnDescriptor,
} from './native-changelog';
import type {
  FetchSnapshotResumableOptions,
  ResumableSnapshotCheckpoint,
  ResumableSnapshotManifest,
} from './transports';

export interface HttpClientTransportDeps {
  readonly baseUrl: string;
  fetchFn(input: string, init?: RequestInit): Promise<Response>;
  buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>>;
}

export async function runHttpFetchSnapshotResumable(
  deps: HttpClientTransportDeps,
  resumableOpts: FetchSnapshotResumableOptions = {},
): Promise<PublicationSnapshot> {
  const chunkSize = Math.max(1, resumableOpts.chunkSize ?? 500);
  const cp: ResumableSnapshotCheckpoint =
    resumableOpts.checkpoint ?? {
      currentTableIndex: 0,
      currentRowOffset: 0,
      completedTables: [],
      partialRows: [],
    };

  if (!cp.manifest) {
    const mRes = await deps.fetchFn(`${deps.baseUrl}/snapshot/manifest`, {
      method: 'GET',
      headers: await deps.buildHeaders(),
    });
    if (!mRes.ok) {
      throw new Error(
        `HTTP replication fetchSnapshotResumable manifest failed with status ${mRes.status}`,
      );
    }
    const mJson = (await mRes.json()) as { manifest: ResumableSnapshotManifest };
    cp.manifest = mJson.manifest;
  }

  const manifest = cp.manifest;
  const grandTotalRows = manifest.tables.reduce((acc, t) => acc + t.totalRows, 0);
  let loadedPriorTables = cp.completedTables.reduce(
    (acc, t) => acc + t.rows.length,
    0,
  );

  while (cp.currentTableIndex < manifest.tables.length) {
    const tblMeta = manifest.tables[cp.currentTableIndex]!;

    while (cp.currentRowOffset < tblMeta.totalRows) {
      const params = new URLSearchParams({
        snapshotId: manifest.snapshotId,
        table: tblMeta.table,
        offset: String(cp.currentRowOffset),
        limit: String(chunkSize),
      });
      const cRes = await deps.fetchFn(
        `${deps.baseUrl}/snapshot/chunk?${params.toString()}`,
        {
          method: 'GET',
          headers: await deps.buildHeaders(),
        },
      );
      if (!cRes.ok) {
        throw new Error(
          `HTTP replication fetchSnapshotResumable chunk failed with status ${cRes.status}`,
        );
      }
      const cJson = (await cRes.json()) as {
        rows?: Record<string, unknown>[];
        hasMore?: boolean;
      };
      const rows = cJson.rows ?? [];
      if (rows.length === 0) {
        cp.currentRowOffset = tblMeta.totalRows;
        break;
      }
      cp.partialRows.push(...rows);
      cp.currentRowOffset += rows.length;

      resumableOpts.onProgress?.({
        table: tblMeta.table,
        tableLoadedRows: cp.partialRows.length,
        tableTotalRows: tblMeta.totalRows,
        totalLoadedRows: loadedPriorTables + cp.partialRows.length,
        totalRows: grandTotalRows,
      });
    }

    cp.completedTables.push({
      table: tblMeta.table,
      primaryKey: tblMeta.primaryKey,
      ddlSql: tblMeta.ddlSql,
      rows: cp.partialRows,
    });
    loadedPriorTables += cp.partialRows.length;
    cp.partialRows = [];
    cp.currentRowOffset = 0;
    cp.currentTableIndex++;
  }

  return {
    publication: manifest.publication,
    origin: manifest.origin,
    watermarkLsn: manifest.watermarkLsn,
    timestamp: manifest.timestamp,
    mode: 'logical',
    tables: cp.completedTables,
  };
}

export async function runHttpFetchChangelogSegments(
  deps: HttpClientTransportDeps,
  sinceSequence = 0,
  fetchOpts: { compress?: boolean } = {},
): Promise<Uint8Array[]> {
  const params = new URLSearchParams({ sinceSequence: String(sinceSequence) });
  if (fetchOpts.compress) {
    params.set('compress', 'gzip');
  }
  const res = await deps.fetchFn(`${deps.baseUrl}/changelog?${params.toString()}`, {
    method: 'GET',
    headers: await deps.buildHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `HTTP replication fetchChangelogSegments failed with status ${res.status}`,
    );
  }
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ctype.includes('application/octet-stream')) {
    const raw = new Uint8Array(await res.arrayBuffer());
    const decoded =
      res.headers.get('x-fb-changelog-encoding') === 'gzip' || isGzipBytes(raw)
        ? await gunzipBytes(raw)
        : raw;
    return decoded.byteLength > 0 ? [decoded] : [];
  }
  const data = (await res.json()) as {
    segments?: Array<{ sequence: number; encoding?: string; data: string }>;
  };
  const out: Uint8Array[] = [];
  for (const s of data.segments ?? []) {
    const raw = base64ToBytes(s.data);
    out.push(
      s.encoding === 'gzip+base64' || isGzipBytes(raw) ? await gunzipBytes(raw) : raw,
    );
  }
  return out;
}

export async function runHttpPushChangelogSegment(
  deps: HttpClientTransportDeps,
  segments: Uint8Array | ReadonlyArray<Uint8Array>,
  pushOpts: { compress?: boolean } = {},
): Promise<ApplyFbChangelogResult[]> {
  const list = segments instanceof Uint8Array ? [segments] : segments;
  if (list.length === 1) {
    const single = list[0]!;
    const bodyBytes = pushOpts.compress ? await gzipBytes(single) : single;
    const res = await deps.fetchFn(`${deps.baseUrl}/changelog`, {
      method: 'POST',
      headers: await deps.buildHeaders({
        'content-type': 'application/octet-stream',
        ...(pushOpts.compress ? { 'x-fb-changelog-encoding': 'gzip' } : {}),
      }),
      body: new Uint8Array(bodyBytes),
    });
    if (!res.ok) {
      throw new Error(
        `HTTP replication pushChangelogSegment failed with status ${res.status}`,
      );
    }
    const data = (await res.json()) as { results?: ApplyFbChangelogResult[] };
    return data.results ?? [];
  }

  const encoded: Array<{ encoding: 'base64' | 'gzip+base64'; data: string }> = [];
  for (const seg of list) {
    if (pushOpts.compress) {
      const gz = await gzipBytes(seg);
      encoded.push({ encoding: 'gzip+base64', data: bytesToBase64(gz) });
    } else {
      encoded.push({ encoding: 'base64', data: bytesToBase64(seg) });
    }
  }
  const res = await deps.fetchFn(`${deps.baseUrl}/changelog`, {
    method: 'POST',
    headers: await deps.buildHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ segments: encoded }),
  });
  if (!res.ok) {
    throw new Error(
      `HTTP replication pushChangelogSegment failed with status ${res.status}`,
    );
  }
  const data = (await res.json()) as { results?: ApplyFbChangelogResult[] };
  return data.results ?? [];
}

export async function runHttpPullAndApplyChangelog(
  deps: HttpClientTransportDeps,
  targetDb: ReplicableDatabase,
  sinceSequence = 0,
  pullOpts: {
    compress?: boolean;
    preferLogicalFallback?: boolean;
    tableSchemas?: Readonly<Record<string, ReadonlyArray<JrdColumnDescriptor>>>;
  } = {},
): Promise<ApplyFbChangelogResult[]> {
  const segments = await runHttpFetchChangelogSegments(deps, sinceSequence, {
    compress: pullOpts.compress,
  });
  const results: ApplyFbChangelogResult[] = [];
  for (const segBytes of segments) {
    results.push(
      await applyFbChangelogSegmentToDatabase(targetDb, segBytes, {
        preferLogicalFallback: pullOpts.preferLogicalFallback,
        ...(pullOpts.tableSchemas !== undefined
          ? { tableSchemas: pullOpts.tableSchemas }
          : {}),
      }),
    );
  }
  return results;
}
