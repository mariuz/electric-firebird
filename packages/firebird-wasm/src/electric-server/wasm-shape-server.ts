/**
 * wasm-shape-server.ts – Isomorphic WinterCG Electric v1.x `/v1/shape` Server
 * over `FirebirdBrowser` / `FirebirdLite` (`M31 Items 1, 2 & 3`).
 */

import type { QueryParams } from '../types';
import { quote, relationName, type ColumnPlan, type TablePlan } from './catalog';
import { WhereError, translateWhere, type FirebirdWhere, type SubqueryDependency } from './where';
import type { ServerWrite } from './index';
import {
  EXPOSED_SHAPE_HEADERS,
  HttpShapeError,
  WASM_SHAPE_CHANGES_TABLE,
  WASM_SHAPE_META_TABLE,
  computeElectricCursor,
  computeShapeEtag,
  createWasmNodeHttpHandler,
  describeWasmTable,
  evalParentCurrentMatch,
  evalParentOldMatch,
  executeWasmShapeWrite,
  hash36,
  installWasmShapeSchema,
  keyStringOf,
  parseParamsRecord,
  renderRowObject,
  wsCol,
  type ParsedWasmShape,
  type WasmShapeDatabase,
  type WasmShapeServer,
  type WasmShapeServerOptions,
} from './wasm-shape-helpers';

export {
  WASM_SHAPE_CHANGES_TABLE,
  WASM_SHAPE_META_TABLE,
  computeElectricCursor,
  computeShapeEtag,
  type SubqueryDependency,
  type WasmShapeDatabase,
  type WasmShapeServer,
  type WasmShapeServerOptions,
};

/**
 * Create an isomorphic WinterCG Electric v1.x `/v1/shape` server backed by
 * `FirebirdBrowser` or `FirebirdLite` (`M31 Items 1, 2 & 3`).
 */
export async function createWasmShapeServer(
  db: WasmShapeDatabase,
  options: WasmShapeServerOptions,
): Promise<WasmShapeServer> {
  const pageRows = Math.max(1, options.snapshotPageRows ?? 1_000);
  const maxChunkRows = Math.max(1, options.maxChunkRows ?? 500);
  const liveTimeoutMs = Math.max(20, options.liveTimeoutMs ?? 5_000);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 50);
  const cursorBucketMs = Math.max(100, options.cursorBucketMs ?? 5_000);
  const allowFunctions = options.allowFunctions !== false;

  const tables = new Map<string, TablePlan>();
  for (const given of options.tables) {
    const rel = relationName(given);
    tables.set(rel, await describeWasmTable(db, rel));
  }

  const servedColumnsMap = new Map<string, ReadonlyMap<string, string>>();
  for (const [rel, plan] of tables) {
    servedColumnsMap.set(rel, new Map(plan.columns.map((c) => [c.shapeName, quote(c.name)])));
  }

  if (options.install !== false) {
    await installWasmShapeSchema(db, tables.values());
  }

  let globalEpoch = `ep_${Date.now().toString(36)}`;
  const tableEpochs = new Map<string, number>();
  try {
    const epRes = await db.query<Record<string, unknown>>(
      `SELECT FIRST 1 "EPOCH" FROM "${WASM_SHAPE_META_TABLE}"`,
    );
    if (epRes.rows[0]) globalEpoch = String(wsCol(epRes.rows[0], 'EPOCH') ?? globalEpoch);
  } catch {
    // fallback if install: false
  }

  let closed = false;
  let wakeWaiters: () => void = () => undefined;
  let nextWake = new Promise<void>((r) => {
    wakeWaiters = r;
  });
  const notifyChanges = () => {
    const fn = wakeWaiters;
    nextWake = new Promise<void>((r) => {
      wakeWaiters = r;
    });
    fn();
  };

  const unsubDb =
    typeof db.onQuery === 'function'
      ? db.onQuery((ev) => {
          if (/^\s*(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(ev.sql)) {
            setTimeout(notifyChanges, 0);
          }
        })
      : null;

  const getHeadSeqAndPruned = async (): Promise<{ head: number; pruned: number }> => {
    const res = await db.query<Record<string, unknown>>(
      `SELECT COALESCE((SELECT MAX("SEQ") FROM "${WASM_SHAPE_CHANGES_TABLE}"), 0) AS HEAD_SEQ,
              COALESCE((SELECT MAX("PRUNED_THROUGH") FROM "${WASM_SHAPE_META_TABLE}"), 0) AS PRUNED_SEQ
       FROM RDB$DATABASE`,
    );
    const r = res.rows[0] ?? {};
    return {
      head: Number(wsCol(r, 'HEAD_SEQ') ?? 0),
      pruned: Number(wsCol(r, 'PRUNED_SEQ') ?? 0),
    };
  };

  const parseShapeRequest = (params: URLSearchParams): ParsedWasmShape => {
    const given = params.get('table');
    if (!given) throw new HttpShapeError(400, 'table is required');
    const rel = relationName(given);
    const table = tables.get(rel);
    if (!table) throw new HttpShapeError(404, `Table ${given} is not served`);

    const colsParam = params.get('columns');
    let columns = table.columns;
    if (colsParam) {
      const wanted = colsParam.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
      columns = table.columns.filter((c) => wanted.includes(c.shapeName) || wanted.includes(c.name));
      for (const k of table.key) {
        if (!columns.some((c) => c.name === k)) {
          const shapeK = table.columns.find((c) => c.name === k)!.shapeName;
          throw new HttpShapeError(400, `columns must include primary key ${shapeK}`);
        }
      }
    }
    const schema = Object.fromEntries(columns.map((c) => [c.shapeName, table.schema[c.shapeName]]));

    const whereText = params.get('where');
    const whereVals = parseParamsRecord(params, 'params', 'params');
    let where: FirebirdWhere | undefined;
    if (whereText) {
      const colMap = servedColumnsMap.get(table.name)!;
      where = translateWhere(whereText, colMap, whereVals, {
        allowFunctions,
        servedTables: servedColumnsMap,
      });
    }

    const replicaParam = params.get('replica');
    if (replicaParam !== null && replicaParam !== 'default' && replicaParam !== 'full') {
      throw new HttpShapeError(400, `Unsupported replica mode: ${replicaParam}`);
    }
    const replica: 'default' | 'full' = replicaParam === 'full' ? 'full' : 'default';
    const tblVer = tableEpochs.get(table.name) ?? 0;
    const def = `${table.name}\0${tblVer}\0${columns.map((c) => c.name).join(',')}\0${whereText ?? ''}\0${JSON.stringify([...whereVals].sort())}\0${replica}`;
    const handle = `${globalEpoch}-v${tblVer}-${hash36(def)}`;

    return { table, columns, schema, where, replica, handle };
  };

  const selectAliasList = (cols: readonly ColumnPlan[]): string =>
    cols.map((c, idx) => `${c.select} AS C${idx}`).join(', ');

  const querySnapshotPage = async (
    shape: ParsedWasmShape,
    pageIndex: number,
  ): Promise<{ messages: Array<Record<string, unknown>>; more: boolean }> => {
    const skip = pageIndex * pageRows;
    const whereClause = shape.where ? ` WHERE ${shape.where.sql}` : '';
    const orderClause = ` ORDER BY ${shape.table.key.map(quote).join(', ')}`;
    const sql =
      `SELECT FIRST ${pageRows + 1} SKIP ${skip} ${selectAliasList(shape.columns)} ` +
      `FROM ${quote(shape.table.name)}${whereClause}${orderClause}`;
    const res = await db.query<Record<string, unknown>>(sql, (shape.where?.params ?? []) as QueryParams);
    const more = res.rows.length > pageRows;
    const kept = more ? res.rows.slice(0, pageRows) : res.rows;
    const messages = kept.map((r) => {
      const { key, value } = renderRowObject(shape.table, shape.columns, r);
      return { key, value, headers: { operation: 'insert' } };
    });
    return { messages, more };
  };

  const queryChangesBetween = async (
    shape: ParsedWasmShape,
    after: number,
    upTo: number,
  ): Promise<{
    gone: boolean;
    messages: Array<Record<string, unknown>>;
    offset: number;
    seen: number;
    hasMoreChunks: boolean;
  }> => {
    const { head, pruned } = await getHeadSeqAndPruned();
    if (after < pruned) {
      return { gone: true, messages: [], offset: after, seen: head, hasMoreChunks: false };
    }
    const targetTop = Math.min(head, upTo);
    if (targetTop <= after) {
      return { gone: false, messages: [], offset: after, seen: head, hasMoreChunks: false };
    }

    const chgRes = await db.query<Record<string, unknown>>(
      `SELECT FIRST ${maxChunkRows + 1} "SEQ", "TX_ID", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON"
       FROM "${WASM_SHAPE_CHANGES_TABLE}"
       WHERE "TABLE_NAME" = ? AND "SEQ" > ? AND "SEQ" <= ?
       ORDER BY "SEQ" ASC`,
      [shape.table.name, after, targetTop],
    );
    const hasMoreChunks = chgRes.rows.length > maxChunkRows;
    const chgRows = hasMoreChunks ? chgRes.rows.slice(0, maxChunkRows) : chgRes.rows;
    const chunkEndSeq =
      chgRows.length > 0 && hasMoreChunks
        ? Number(wsCol(chgRows[chgRows.length - 1]!, 'SEQ') ?? targetTop)
        : targetTop;

    const byKey = new Map<
      string,
      {
        firstOp: string;
        lastOp: string;
        pkVals: unknown[];
        firstOld: Record<string, unknown> | null;
        lastOld: Record<string, unknown> | null;
        txids: Set<number>;
      }
    >();

    for (const r of chgRows) {
      const op = String(wsCol(r, 'OP') ?? 'U').trim();
      const txid = Number(wsCol(r, 'TX_ID') ?? 0);
      const pkVals = JSON.parse(String(wsCol(r, 'PK_JSON') ?? '[]')) as unknown[];
      const pkId = JSON.stringify(pkVals);
      const oldRaw = wsCol(r, 'OLD_JSON');
      const parsedOld =
        typeof oldRaw === 'string' && oldRaw.trim()
          ? (JSON.parse(oldRaw) as Record<string, unknown>)
          : null;
      const prev = byKey.get(pkId);
      if (prev) {
        prev.lastOp = op;
        if (parsedOld) prev.lastOld = parsedOld;
        prev.txids.add(txid);
      } else {
        byKey.set(pkId, {
          firstOp: op,
          lastOp: op,
          pkVals,
          firstOld: parsedOld,
          lastOld: parsedOld,
          txids: new Set([txid]),
        });
      }
    }

    const messages: Array<Record<string, unknown>> = [];
    const emittedKeys = new Set<string>();

    for (const item of byKey.values()) {
      const pkWhere = shape.table.key.map((k) => `${quote(k)} = ?`).join(' AND ');
      const fullWhere = shape.where ? `(${pkWhere}) AND (${shape.where.sql})` : pkWhere;
      const curRes =
        item.lastOp === 'D'
          ? { rows: [] as Array<Record<string, unknown>> }
          : await db.query<Record<string, unknown>>(
              `SELECT FIRST 1 ${selectAliasList(shape.columns)} FROM ${quote(shape.table.name)} WHERE ${fullWhere}`,
              [...item.pkVals, ...(shape.where?.params ?? [])] as QueryParams,
            );

      const curRow = curRes.rows[0];
      const msgKey = keyStringOf(shape.table, item.pkVals);
      emittedKeys.add(msgKey);

      if (curRow) {
        const { value } = renderRowObject(shape.table, shape.columns, curRow);
        const effectiveOp: 'insert' | 'update' = item.firstOp === 'I' ? 'insert' : 'update';
        const msg: Record<string, unknown> = {
          key: msgKey,
          value,
          headers: {
            operation: shape.where && effectiveOp === 'update' ? 'insert' : effectiveOp,
            txids: [...item.txids],
          },
        };
        if (shape.replica === 'full' && effectiveOp === 'update') {
          (msg.headers as Record<string, unknown>).operation = 'update';
          const oldVal: Record<string, unknown> = {};
          if (item.firstOld) {
            for (const col of shape.columns) {
              const prevV = item.firstOld[col.shapeName];
              if (prevV !== undefined && String(prevV) !== String(value[col.shapeName])) {
                oldVal[col.shapeName] = prevV === null ? null : String(prevV);
              }
            }
          }
          msg.old_value = oldVal;
        }
        messages.push(msg);
      } else {
        if (item.firstOp === 'I') continue;
        const delVal: Record<string, unknown> = {};
        if (shape.replica === 'full' && item.lastOld) {
          for (const col of shape.columns) {
            const v = item.lastOld[col.shapeName];
            delVal[col.shapeName] = v === null || v === undefined ? null : String(v);
          }
        } else {
          shape.table.key.forEach((k, idx) => {
            const plan = shape.table.columns.find((c) => c.name === k)!;
            delVal[plan.shapeName] = item.pkVals[idx] === null ? null : String(item.pkVals[idx]);
          });
        }
        const delMsg: Record<string, unknown> = {
          key: msgKey,
          value: delVal,
          headers: { operation: 'delete', txids: [...item.txids] },
        };
        if (shape.replica === 'full' && item.lastOld) {
          delMsg.old_value = { ...delVal };
        }
        messages.push(delMsg);
      }
    }

    // Relational Subquery `move-in` / `move-out` propagation (`M31 Item 3`)
    if (shape.where?.subqueries?.length) {
      for (const sub of shape.where.subqueries) {
        const parentPlan = tables.get(sub.parentTable);
        if (!parentPlan) continue;
        const pChgRes = await db.query<Record<string, unknown>>(
          `SELECT "SEQ", "TX_ID", "OP", "PK_JSON", "OLD_JSON", "NEW_JSON"
           FROM "${WASM_SHAPE_CHANGES_TABLE}"
           WHERE "TABLE_NAME" = ? AND "SEQ" > ? AND "SEQ" <= ?
           ORDER BY "SEQ" ASC`,
          [parentPlan.name, after, chunkEndSeq],
        );
        if (pChgRes.rows.length === 0) continue;

        const parentByKey = new Map<
          string,
          {
            firstOp: string;
            lastOp: string;
            pkVals: unknown[];
            firstOld: Record<string, unknown> | null;
            txids: Set<number>;
          }
        >();
        for (const pr of pChgRes.rows) {
          const op = String(wsCol(pr, 'OP') ?? 'U').trim();
          const txid = Number(wsCol(pr, 'TX_ID') ?? 0);
          const pkVals = JSON.parse(String(wsCol(pr, 'PK_JSON') ?? '[]')) as unknown[];
          const pkId = JSON.stringify(pkVals);
          const oldRaw = wsCol(pr, 'OLD_JSON');
          const parsedOld =
            typeof oldRaw === 'string' && oldRaw.trim()
              ? (JSON.parse(oldRaw) as Record<string, unknown>)
              : null;
          const prev = parentByKey.get(pkId);
          if (prev) {
            prev.lastOp = op;
            prev.txids.add(txid);
          } else {
            parentByKey.set(pkId, {
              firstOp: op,
              lastOp: op,
              pkVals,
              firstOld: parsedOld,
              txids: new Set([txid]),
            });
          }
        }

        for (const pItem of parentByKey.values()) {
          const rawBefore =
            pItem.firstOp === 'I'
              ? false
              : await evalParentOldMatch(db, parentPlan, pItem.firstOld, sub.parentWhere);
          const rawNow =
            pItem.lastOp === 'D'
              ? false
              : await evalParentCurrentMatch(db, parentPlan, pItem.pkVals, sub.parentWhere);
          const inSetBefore = sub.negated ? !rawBefore : rawBefore;
          const inSetNow = sub.negated ? !rawNow : rawNow;
          if (inSetBefore === inSetNow) continue;

          const parentJoinVal = pItem.pkVals[0];
          if (inSetNow && !inSetBefore) {
            const childRes = await db.query<Record<string, unknown>>(
              `SELECT ${selectAliasList(shape.columns)} FROM ${quote(shape.table.name)}
               WHERE (${sub.childColumnSql} = ?) AND (${shape.where.sql})
               ORDER BY ${shape.table.key.map(quote).join(', ')}`,
              [parentJoinVal, ...shape.where.params] as QueryParams,
            );
            for (const cr of childRes.rows) {
              const { key, value } = renderRowObject(shape.table, shape.columns, cr);
              if (emittedKeys.has(key)) continue;
              emittedKeys.add(key);
              messages.push({
                key,
                value,
                headers: { operation: 'insert', move_in: true, txids: [...pItem.txids] },
              });
            }
          } else if (inSetBefore && !inSetNow) {
            const childRes = await db.query<Record<string, unknown>>(
              `SELECT ${selectAliasList(shape.columns)} FROM ${quote(shape.table.name)}
               WHERE ${sub.childColumnSql} = ?
               ORDER BY ${shape.table.key.map(quote).join(', ')}`,
              [parentJoinVal] as QueryParams,
            );
            for (const cr of childRes.rows) {
              const { key, value } = renderRowObject(shape.table, shape.columns, cr);
              if (emittedKeys.has(key)) continue;
              emittedKeys.add(key);
              const delPayload =
                shape.replica === 'full'
                  ? value
                  : Object.fromEntries(
                      shape.table.key.map((k) => {
                        const kp = shape.table.columns.find((c) => c.name === k)!;
                        return [kp.shapeName, value[kp.shapeName] ?? null];
                      }),
                    );
              messages.push({
                key,
                value: delPayload,
                ...(shape.replica === 'full' ? { old_value: value } : {}),
                headers: { operation: 'delete', move_out: true, txids: [...pItem.txids] },
              });
            }
          }
        }
      }
    }

    return {
      gone: false,
      messages,
      offset: chunkEndSeq,
      seen: chunkEndSeq,
      hasMoreChunks,
    };
  };

  const handleSubsetSnapshot = async (
    shape: ParsedWasmShape,
    subsetSpec: {
      where?: string;
      params?: Record<string, unknown>;
      orderBy?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<Response> => {
    const { head } = await getHeadSeqAndPruned();
    const conditions: string[] = [];
    const sqlParams: unknown[] = [];

    if (shape.where) {
      conditions.push(`(${shape.where.sql})`);
      sqlParams.push(...shape.where.params);
    }
    if (subsetSpec.where?.trim()) {
      const pMap = new Map<number, string>();
      if (subsetSpec.params && typeof subsetSpec.params === 'object') {
        for (const [k, v] of Object.entries(subsetSpec.params)) {
          const idx = Number(k.replace(/^\$/, ''));
          if (Number.isInteger(idx) && idx > 0 && v !== undefined && v !== null) {
            pMap.set(idx, String(v));
          }
        }
      }
      const subW = translateWhere(
        subsetSpec.where,
        servedColumnsMap.get(shape.table.name)!,
        pMap,
        { allowFunctions, servedTables: servedColumnsMap },
      );
      conditions.push(`(${subW.sql})`);
      sqlParams.push(...subW.params);
    }

    let orderBySql = shape.table.key.map(quote).join(', ');
    if (subsetSpec.orderBy?.trim()) {
      const colMap = servedColumnsMap.get(shape.table.name)!;
      const clauses = subsetSpec.orderBy.split(',').map((part) => {
        const tokens = part.trim().split(/\s+/);
        const colRaw = (tokens[0] ?? '').replace(/^"(.*)"$/, '$1');
        const quoted = colMap.get(colRaw.toLowerCase()) ?? colMap.get(colRaw);
        if (!quoted) throw new WhereError(`subset order_by: unknown column ${colRaw}`);
        const dir = tokens[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${quoted} ${dir}`;
      });
      if (clauses.length > 0) orderBySql = clauses.join(', ');
    }

    const limitClause =
      subsetSpec.limit !== undefined ? `FIRST ${Math.max(0, Math.floor(subsetSpec.limit))} ` : '';
    const offsetClause =
      subsetSpec.offset !== undefined && subsetSpec.offset > 0
        ? `SKIP ${Math.max(0, Math.floor(subsetSpec.offset))} `
        : '';
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const res = await db.query<Record<string, unknown>>(
      `SELECT ${limitClause}${offsetClause}${selectAliasList(shape.columns)} FROM ${quote(shape.table.name)}${whereSql} ORDER BY ${orderBySql}`,
      sqlParams as QueryParams,
    );

    const snapshotMark = 1;
    const data = res.rows.map((r) => {
      const { key, value } = renderRowObject(shape.table, shape.columns, r);
      return {
        key,
        value,
        headers: { operation: 'insert', snapshot_mark: snapshotMark },
      };
    });

    return new Response(
      JSON.stringify({
        metadata: {
          snapshot_mark: snapshotMark,
          database_lsn: String(head),
          xmin: String(head),
          xmax: String(head + 1),
          xip_list: [] as string[],
        },
        data,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=5, stale-while-revalidate=30',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': EXPOSED_SHAPE_HEADERS,
          'electric-handle': shape.handle,
          'electric-offset': `${head}_0`,
          'electric-schema': JSON.stringify(shape.schema),
        },
      },
    );
  };

  const inflightLive = new Map<
    string,
    Promise<{
      gone: boolean;
      messages: Array<Record<string, unknown>>;
      offset: number;
      seen: number;
      hasMoreChunks: boolean;
    }>
  >();

  const invalidateShape = async (table?: string): Promise<string> => {
    if (table) {
      const rel = relationName(table);
      tableEpochs.set(rel, (tableEpochs.get(rel) ?? 0) + 1);
    } else {
      globalEpoch = `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }
    notifyChanges();
    return globalEpoch;
  };

  const mustRefetchResp = (latestHandle: string): Response =>
    new Response(JSON.stringify([{ headers: { control: 'must-refetch' } }]), {
      status: 409,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': EXPOSED_SHAPE_HEADERS,
        'electric-handle': latestHandle,
      },
    });

  const fetchHandler = async (request: Request): Promise<Response> => {
    if (closed) {
      return new Response(JSON.stringify({ message: 'The shape server is closed' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
    }

    const url = new URL(request.url, 'http://shape.local');
    if (url.pathname !== '/v1/shape') {
      return new Response(JSON.stringify({ message: 'Only /v1/shape is served' }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }

    try {
      const params = url.searchParams;
      if (request.method === 'DELETE') {
        await invalidateShape(params.get('table') ?? undefined);
        return new Response(JSON.stringify({ invalidated: true }), {
          status: 202,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        });
      }

      const shape = parseShapeRequest(params);

      if (request.method === 'POST') {
        const body = (await request.json()) as {
          where?: string;
          params?: Record<string, unknown>;
          order_by?: string;
          orderBy?: string;
          limit?: number;
          offset?: number;
        };
        return await handleSubsetSnapshot(shape, {
          where: body.where,
          params: body.params,
          orderBy: body.orderBy ?? body.order_by,
          limit: body.limit,
          offset: body.offset,
        });
      }

      if (request.method !== 'GET') {
        throw new HttpShapeError(405, `Method ${request.method} not allowed`);
      }

      if (
        params.has('subset__where') ||
        params.has('subset__limit') ||
        params.has('subset__offset') ||
        params.has('subset__order_by')
      ) {
        const subParamsMap = parseParamsRecord(params, 'subset__params', 'subset__params');
        const subParamsObj: Record<string, string> = {};
        for (const [idx, val] of subParamsMap) subParamsObj[String(idx)] = val;
        return await handleSubsetSnapshot(shape, {
          where: params.get('subset__where') ?? undefined,
          params: subParamsObj,
          orderBy: params.get('subset__order_by') ?? undefined,
          limit: params.has('subset__limit') ? Number(params.get('subset__limit')) : undefined,
          offset: params.has('subset__offset') ? Number(params.get('subset__offset')) : undefined,
        });
      }

      const offsetParam = params.get('offset') ?? '-1';
      const ifNoneMatch = request.headers.get('if-none-match');

      if (offsetParam === '-1') {
        const { head } = await getHeadSeqAndPruned();
        const first = await querySnapshotPage(shape, 0);
        const nextOffset = first.more ? `${head}_1` : `${head}_0`;
        const outMsgs = first.more
          ? first.messages
          : [
              ...first.messages,
              { headers: { control: 'up-to-date', global_last_seen_lsn: String(head) } },
            ];
        const etag = computeShapeEtag(shape.handle, nextOffset, head, outMsgs.length);
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=60, stale-while-revalidate=300',
          etag,
          'access-control-allow-origin': '*',
          'access-control-expose-headers': EXPOSED_SHAPE_HEADERS,
          'electric-handle': shape.handle,
          'electric-offset': nextOffset,
          'electric-schema': JSON.stringify(shape.schema),
          ...(first.more ? {} : { 'electric-up-to-date': '' }),
        };
        if (ifNoneMatch && ifNoneMatch === etag) return new Response(null, { status: 304, headers });
        return new Response(JSON.stringify(outMsgs), { status: 200, headers });
      }

      const givenHandle = params.get('handle');
      if (offsetParam !== 'now' && givenHandle !== shape.handle) {
        return mustRefetchResp(shape.handle);
      }
      if (offsetParam === 'now' && givenHandle && givenHandle !== shape.handle) {
        return mustRefetchResp(shape.handle);
      }

      const [posStr, partStr] = offsetParam === 'now' ? ['now', '0'] : offsetParam.split('_');

      if (partStr !== undefined && partStr !== '0') {
        const pageIdx = Number(partStr);
        const snapTop = Number(posStr);
        if (!Number.isSafeInteger(pageIdx) || pageIdx < 1 || !Number.isSafeInteger(snapTop)) {
          throw new HttpShapeError(400, `Invalid snapshot offset ${offsetParam}`);
        }
        const pg = await querySnapshotPage(shape, pageIdx);
        const nextOffset = pg.more ? `${snapTop}_${pageIdx + 1}` : `${snapTop}_0`;
        const outMsgs = pg.more
          ? pg.messages
          : [
              ...pg.messages,
              { headers: { control: 'up-to-date', global_last_seen_lsn: String(snapTop) } },
            ];
        const etag = computeShapeEtag(shape.handle, nextOffset, snapTop, outMsgs.length);
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=604800, immutable',
          etag,
          'access-control-allow-origin': '*',
          'access-control-expose-headers': EXPOSED_SHAPE_HEADERS,
          'electric-handle': shape.handle,
          'electric-offset': nextOffset,
          'electric-schema': JSON.stringify(shape.schema),
          ...(pg.more ? {} : { 'electric-up-to-date': '' }),
        };
        if (ifNoneMatch && ifNoneMatch === etag) return new Response(null, { status: 304, headers });
        return new Response(JSON.stringify(outMsgs), { status: 200, headers });
      }

      const { head } = await getHeadSeqAndPruned();
      const after = posStr === 'now' ? head : Number(posStr);
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new HttpShapeError(400, `Invalid offset ${offsetParam}`);
      }

      const isLiveSse =
        params.get('live_sse') === 'true' || params.get('experimental_live_sse') === 'true';
      if (isLiveSse) {
        const encoder = new TextEncoder();
        let sseCursor = after;
        const sseDeadline = Date.now() + liveTimeoutMs;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const sendSseMsg = (obj: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            try {
              const initial = await queryChangesBetween(shape, sseCursor, Number.MAX_SAFE_INTEGER);
              if (initial.gone) {
                sendSseMsg({ headers: { control: 'must-refetch' } });
                return;
              }
              for (const m of initial.messages) sendSseMsg(m);
              sseCursor = initial.offset;
              sendSseMsg({
                headers: { control: 'up-to-date', global_last_seen_lsn: String(initial.seen) },
              });

              while (!closed && !request.signal.aborted && Date.now() < sseDeadline) {
                if (parseShapeRequest(params).handle !== shape.handle) {
                  sendSseMsg({ headers: { control: 'must-refetch' } });
                  break;
                }
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                  nextWake,
                  new Promise((r) => {
                    timer = setTimeout(
                      r,
                      Math.min(pollIntervalMs, Math.max(5, sseDeadline - Date.now())),
                    );
                  }),
                ]);
                clearTimeout(timer);
                if (closed || request.signal.aborted) break;

                const delta = await queryChangesBetween(shape, sseCursor, Number.MAX_SAFE_INTEGER);
                if (delta.gone) {
                  sendSseMsg({ headers: { control: 'must-refetch' } });
                  break;
                }
                if (delta.messages.length > 0) {
                  for (const m of delta.messages) sendSseMsg(m);
                  sseCursor = delta.offset;
                  sendSseMsg({
                    headers: { control: 'up-to-date', global_last_seen_lsn: String(delta.seen) },
                  });
                }
              }
            } finally {
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'access-control-allow-origin': '*',
            'access-control-expose-headers': EXPOSED_SHAPE_HEADERS,
            'electric-handle': shape.handle,
            'electric-offset': `${after}_0`,
            'electric-schema': JSON.stringify(shape.schema),
            'electric-cursor': computeElectricCursor(shape.handle, `${after}_0`, cursorBucketMs),
          },
        });
      }

      const isLive = params.get('live') === 'true';
      let result = await queryChangesBetween(shape, after, Number.MAX_SAFE_INTEGER);

      if (!result.gone && isLive && result.messages.length === 0) {
        const coalesceKey = `${shape.handle}:${after}`;
        let shared = inflightLive.get(coalesceKey);
        if (!shared) {
          shared = (async () => {
            const deadline = Date.now() + liveTimeoutMs;
            let cur = result;
            while (
              !cur.gone &&
              cur.messages.length === 0 &&
              Date.now() < deadline &&
              !closed &&
              !request.signal.aborted
            ) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                nextWake,
                new Promise((r) => {
                  timer = setTimeout(
                    r,
                    Math.min(pollIntervalMs, Math.max(5, deadline - Date.now())),
                  );
                }),
              ]);
              clearTimeout(timer);
              if (closed) break;
              cur = await queryChangesBetween(shape, after, Number.MAX_SAFE_INTEGER);
            }
            return cur;
          })().finally(() => {
            inflightLive.delete(coalesceKey);
          });
          inflightLive.set(coalesceKey, shared);
        }
        result = await shared;
      }

      const latestShape = parseShapeRequest(params);
      if (result.gone || latestShape.handle !== shape.handle) {
        return mustRefetchResp(latestShape.handle);
      }

      const outMsgs = result.hasMoreChunks
        ? result.messages
        : [
            ...result.messages,
            { headers: { control: 'up-to-date', global_last_seen_lsn: String(result.seen) } },
          ];
      const nextOffset = `${result.offset}_0`;
      const etag = computeShapeEtag(shape.handle, nextOffset, result.seen, outMsgs.length);
      const isImmutableChunk =
        !isLive && posStr !== 'now' && (result.hasMoreChunks || result.offset > after);
      const cacheControl = isLive
        ? 'public, max-age=5, stale-while-revalidate=5'
        : isImmutableChunk
          ? 'public, max-age=604800, immutable'
          : 'public, max-age=60, stale-while-revalidate=300';

      const respHeaders: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': cacheControl,
        etag,
        'access-control-allow-origin': '*',
        'access-control-expose-headers': EXPOSED_SHAPE_HEADERS,
        'electric-handle': shape.handle,
        'electric-offset': nextOffset,
        ...(result.hasMoreChunks ? {} : { 'electric-up-to-date': '' }),
      };
      if (isLive) {
        respHeaders['electric-cursor'] = computeElectricCursor(
          shape.handle,
          nextOffset,
          cursorBucketMs,
        );
      } else {
        respHeaders['electric-schema'] = JSON.stringify(shape.schema);
      }

      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, { status: 304, headers: respHeaders });
      }
      return new Response(JSON.stringify(outMsgs), { status: 200, headers: respHeaders });
    } catch (err) {
      const status =
        err instanceof HttpShapeError ? err.status : err instanceof WhereError ? 400 : 500;
      return new Response(
        JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
        {
          status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
          },
        },
      );
    }
  };

  return {
    tables,
    fetch: fetchHandler,
    handler: createWasmNodeHttpHandler(fetchHandler),
    applyWrite: async (write: ServerWrite) => {
      if (closed) throw new HttpShapeError(503, 'The shape server is closed');
      return executeWasmShapeWrite(db, tables, write, notifyChanges);
    },
    invalidateShape,
    notifyChanges,
    async close() {
      if (closed) return;
      closed = true;
      if (unsubDb) unsubDb();
      notifyChanges();
    },
  };
}
