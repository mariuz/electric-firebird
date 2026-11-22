/**
 * spatial.ts – 2D Spatial R-Tree Index, GeoJSON / WKT Geometry Engine,
 * Geodesic Haversine Search & SQL Spatial UDRs (`M29 Item 2`).
 */

import type {
  JsFunctionHandler,
  QueryParams,
  QueryResult,
  RegisterFunctionOptions,
  RegisteredRoutine,
  Row,
} from './types';
import type { ReplicationIndexHook } from './replication/types';
import {
  attachIndexAutoSync,
  buildReplicationIndexHook,
  type QueryObservableExecutor,
} from './vector/auto-sync';

export const DEFAULT_SPATIAL_INDEX_TABLE = 'FB_SPATIAL_INDEX$';

/** `[minLon, minLat, maxLon, maxLat]` axis-aligned bounding box (`M29 Item 2`). */
export type BoundingBox = readonly [number, number, number, number];

export interface GeoPoint {
  readonly type: 'Point';
  readonly coordinates: readonly [number, number];
}

export interface GeoLineString {
  readonly type: 'LineString';
  readonly coordinates: ReadonlyArray<readonly [number, number]>;
}

export interface GeoPolygon {
  readonly type: 'Polygon';
  readonly coordinates: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

export type GeoGeometry = GeoPoint | GeoLineString | GeoPolygon;

export interface SpatialDatabaseExecutor extends QueryObservableExecutor {
  query<T extends Row = Row>(sql: string, params?: QueryParams): Promise<QueryResult<T>>;
  exec?(sql: string, params?: QueryParams): Promise<unknown>;
  execute?(sql: string, params?: QueryParams): Promise<{ affectedRows: number }>;
  registerFunction?(
    name: string,
    options: RegisterFunctionOptions,
    fn: JsFunctionHandler,
  ): Promise<RegisteredRoutine>;
}

export interface SerializedRTree<ID = string | number> {
  readonly version: 1;
  readonly maxEntries: number;
  readonly items: ReadonlyArray<{
    readonly id: ID;
    readonly bbox: BoundingBox;
    readonly geometry: GeoGeometry;
  }>;
}

export interface SpatialIndexOptions {
  readonly table: string;
  readonly column: string;
  readonly keyColumn?: string;
  readonly name?: string;
  readonly maxEntries?: number;
  readonly persist?: boolean;
  readonly forceRebuild?: boolean;
  readonly autoSync?: boolean;
}

export type SpatialSearchRow<T extends Row = Row> = T & {
  DISTANCE_M?: number;
};

export interface PersistentSpatialIndex<ID = string | number> {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  readonly keyColumn: string;
  readonly rtree: RTreeIndex<ID>;
  readonly size: number;
  upsert(id: ID, geom: string | GeoGeometry): Promise<void>;
  remove(id: ID): Promise<boolean>;
  rebuild(): Promise<void>;
  save(): Promise<void>;
  drop(): Promise<void>;
  asReplicationIndexHook(): ReplicationIndexHook;
  dispose(): void;
  bboxSearch<T extends Row = Row>(
    bbox: BoundingBox,
    options?: { where?: string; params?: QueryParams; limit?: number },
  ): Promise<T[]>;
  knnSearch<T extends Row = Row>(
    lon: number,
    lat: number,
    options?: {
      k?: number;
      maxDistanceMeters?: number;
      where?: string;
      params?: QueryParams;
      distanceColumn?: string;
    },
  ): Promise<Array<SpatialSearchRow<T>>>;
  withinRadius<T extends Row = Row>(
    lon: number,
    lat: number,
    radiusMeters: number,
    options?: { where?: string; params?: QueryParams; limit?: number; distanceColumn?: string },
  ): Promise<Array<SpatialSearchRow<T>>>;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

function parseCoordList(raw: string): Array<readonly [number, number]> {
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const parts = pair.split(/\s+/);
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error(`Invalid WKT coordinate pair: "${pair}"`);
      }
      return [lon, lat] as const;
    });
}

/**
 * Parse a GeoJSON object, GeoJSON string, or OGC WKT string (`POINT`, `LINESTRING`,
 * `POLYGON`) into a normalized {@link GeoGeometry} (`M29 Item 2`).
 */
export function parseGeoGeometry(input: string | GeoGeometry): GeoGeometry {
  if (typeof input === 'object' && input !== null && 'type' in input) {
    return input;
  }
  const str = String(input).trim();
  if (!str) throw new Error('Geometry input cannot be empty.');
  if (str.startsWith('{')) {
    const parsed = JSON.parse(str) as GeoGeometry | { type: 'Feature'; geometry: GeoGeometry };
    if ((parsed as { type: string }).type === 'Feature') {
      return (parsed as { type: 'Feature'; geometry: GeoGeometry }).geometry;
    }
    return parsed as GeoGeometry;
  }

  const ptMatch = /^POINT\s*\(\s*([^\s()]+)\s+([^\s()]+)\s*\)$/i.exec(str);
  if (ptMatch) {
    const lon = Number(ptMatch[1]);
    const lat = Number(ptMatch[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new Error(`Invalid WKT POINT: "${str}"`);
    }
    return { type: 'Point', coordinates: [lon, lat] };
  }

  const lineMatch = /^LINESTRING\s*\(([^()]+)\)$/i.exec(str);
  if (lineMatch) {
    return { type: 'LineString', coordinates: parseCoordList(lineMatch[1]!) };
  }

  const polyMatch = /^POLYGON\s*\(\s*(\([\s\S]+\))\s*\)$/i.exec(str);
  if (polyMatch) {
    const rings: Array<Array<readonly [number, number]>> = [];
    const ringRe = /\(([^()]+)\)/g;
    let rm: RegExpExecArray | null;
    while ((rm = ringRe.exec(polyMatch[1]!)) !== null) {
      rings.push(parseCoordList(rm[1]!));
    }
    if (rings.length === 0) throw new Error(`Invalid WKT POLYGON: "${str}"`);
    return { type: 'Polygon', coordinates: rings };
  }

  throw new Error(`Unsupported geometry format: "${str.slice(0, 80)}"`);
}

export function toGeoJson(input: string | GeoGeometry): string {
  return JSON.stringify(parseGeoGeometry(input));
}

export function toWkt(input: string | GeoGeometry): string {
  const g = parseGeoGeometry(input);
  if (g.type === 'Point') {
    return `POINT (${g.coordinates[0]} ${g.coordinates[1]})`;
  }
  if (g.type === 'LineString') {
    return `LINESTRING (${g.coordinates.map((c) => `${c[0]} ${c[1]}`).join(', ')})`;
  }
  const rings = g.coordinates
    .map((r) => `(${r.map((c) => `${c[0]} ${c[1]}`).join(', ')})`)
    .join(', ');
  return `POLYGON (${rings})`;
}

export function computeBoundingBox(input: string | GeoGeometry): BoundingBox {
  const g = parseGeoGeometry(input);
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const visit = (c: readonly [number, number]): void => {
    if (c[0] < minLon) minLon = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[0] > maxLon) maxLon = c[0];
    if (c[1] > maxLat) maxLat = c[1];
  };
  if (g.type === 'Point') visit(g.coordinates);
  else if (g.type === 'LineString') g.coordinates.forEach(visit);
  else g.coordinates.forEach((ring) => ring.forEach(visit));
  return [minLon, minLat, maxLon, maxLat];
}

export function bboxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Great-circle Haversine distance in meters on WGS-84 sphere (`M29 Item 2`). */
export function haversineDistanceMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const rLat1 = lat1 * DEG_TO_RAD;
  const rLat2 = lat2 * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(rLat1) * Math.cos(rLat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pointToSegmentMeters(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return haversineDistanceMeters(px, py, ax, ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return haversineDistanceMeters(px, py, ax + t * dx, ay + t * dy);
}

/** Ray-casting point-in-polygon check supporting interior hole rings (`M29 Item 2`). */
export function pointInPolygon(lon: number, lat: number, polygon: GeoPolygon): boolean {
  const inRing = (ring: ReadonlyArray<readonly [number, number]>): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]![0];
      const yi = ring[i]![1];
      const xj = ring[j]![0];
      const yj = ring[j]![1];
      const intersect =
        yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-18) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };
  if (polygon.coordinates.length === 0) return false;
  if (!inRing(polygon.coordinates[0]!)) return false;
  for (let r = 1; r < polygon.coordinates.length; r++) {
    if (inRing(polygon.coordinates[r]!)) return false;
  }
  return true;
}

/** Geodesic distance in meters from `(lon, lat)` to a geometry (`0` if inside polygon). */
export function distanceToGeometryMeters(
  lon: number,
  lat: number,
  geom: string | GeoGeometry,
): number {
  const g = parseGeoGeometry(geom);
  if (g.type === 'Point') {
    return haversineDistanceMeters(lon, lat, g.coordinates[0], g.coordinates[1]);
  }
  if (g.type === 'LineString') {
    let best = Infinity;
    for (let i = 0; i < g.coordinates.length - 1; i++) {
      const d = pointToSegmentMeters(
        lon,
        lat,
        g.coordinates[i]![0],
        g.coordinates[i]![1],
        g.coordinates[i + 1]![0],
        g.coordinates[i + 1]![1],
      );
      if (d < best) best = d;
    }
    return g.coordinates.length === 1
      ? haversineDistanceMeters(lon, lat, g.coordinates[0]![0], g.coordinates[0]![1])
      : best;
  }
  if (pointInPolygon(lon, lat, g)) return 0;
  let best = Infinity;
  for (const ring of g.coordinates) {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = pointToSegmentMeters(lon, lat, ring[i]![0], ring[i]![1], ring[i + 1]![0], ring[i + 1]![1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Approximate geodesic surface area of a `Polygon` in $\text{m}^2$ (`M29 Item 2`). */
export function polygonAreaSqMeters(input: string | GeoGeometry): number {
  const g = parseGeoGeometry(input);
  if (g.type !== 'Polygon' || g.coordinates.length === 0) return 0;
  const ringArea = (ring: ReadonlyArray<readonly [number, number]>): number => {
    if (ring.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const p1 = ring[i]!;
      const p2 = ring[(i + 1) % ring.length]!;
      sum +=
        (p2[0] - p1[0]) * DEG_TO_RAD * (2 + Math.sin(p1[1] * DEG_TO_RAD) + Math.sin(p2[1] * DEG_TO_RAD));
    }
    return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
  };
  let total = ringArea(g.coordinates[0]!);
  for (let i = 1; i < g.coordinates.length; i++) {
    total -= ringArea(g.coordinates[i]!);
  }
  return Math.max(0, total);
}

export function geometriesIntersect(
  aInput: string | GeoGeometry,
  bInput: string | GeoGeometry,
): boolean {
  const a = parseGeoGeometry(aInput);
  const b = parseGeoGeometry(bInput);
  const ba = computeBoundingBox(a);
  const bb = computeBoundingBox(b);
  if (!bboxesIntersect(ba, bb)) return false;
  if (a.type === 'Point' && b.type === 'Point') {
    return a.coordinates[0] === b.coordinates[0] && a.coordinates[1] === b.coordinates[1];
  }
  if (a.type === 'Point' && b.type === 'Polygon') {
    return pointInPolygon(a.coordinates[0], a.coordinates[1], b);
  }
  if (a.type === 'Polygon' && b.type === 'Point') {
    return pointInPolygon(b.coordinates[0], b.coordinates[1], a);
  }
  if (a.type === 'Polygon' && b.type === 'Polygon') {
    for (const pt of a.coordinates[0] ?? []) {
      if (pointInPolygon(pt[0], pt[1], b)) return true;
    }
    for (const pt of b.coordinates[0] ?? []) {
      if (pointInPolygon(pt[0], pt[1], a)) return true;
    }
  }
  return bboxesIntersect(ba, bb);
}

// ---------------------------------------------------------------------------
// 2D R-Tree Spatial Index (`RTreeIndex`)
// ---------------------------------------------------------------------------

interface RTreeLeafItem<ID> {
  id: ID;
  bbox: BoundingBox;
  geometry: GeoGeometry;
}

interface RTreeNode<ID> {
  bbox: BoundingBox;
  leaf: boolean;
  children?: RTreeNode<ID>[];
  items?: RTreeLeafItem<ID>[];
}

function unionBbox(a: BoundingBox, b: BoundingBox): BoundingBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function bboxArea(b: BoundingBox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function enlargement(nodeBbox: BoundingBox, itemBbox: BoundingBox): number {
  return bboxArea(unionBbox(nodeBbox, itemBbox)) - bboxArea(nodeBbox);
}

function minBoxDistMeters(lon: number, lat: number, bbox: BoundingBox): number {
  const clampedLon = Math.max(bbox[0], Math.min(lon, bbox[2]));
  const clampedLat = Math.max(bbox[1], Math.min(lat, bbox[3]));
  if (clampedLon === lon && clampedLat === lat) return 0;
  return haversineDistanceMeters(lon, lat, clampedLon, clampedLat);
}

/**
 * In-memory 2D R-Tree spatial index supporting bounding-box intersection and
 * Haversine branch-and-bound $k$-nearest-neighbor search (`M29 Item 2`).
 */
export class RTreeIndex<ID = string | number> {
  readonly maxEntries: number;
  private root: RTreeNode<ID>;
  private readonly byId = new Map<ID, RTreeLeafItem<ID>>();

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(4, options.maxEntries ?? 16);
    this.root = { bbox: [Infinity, Infinity, -Infinity, -Infinity], leaf: true, items: [] };
  }

  get size(): number {
    return this.byId.size;
  }

  insert(id: ID, geomOrWkt: string | GeoGeometry): void {
    if (this.byId.has(id)) {
      this.remove(id);
    }
    const geometry = parseGeoGeometry(geomOrWkt);
    const bbox = computeBoundingBox(geometry);
    const item: RTreeLeafItem<ID> = { id, bbox, geometry };
    this.byId.set(id, item);
    const split = this.insertInternal(this.root, item);
    if (split) {
      this.root = {
        bbox: unionBbox(this.root.bbox, split.bbox),
        leaf: false,
        children: [this.root, split],
      };
    }
  }

  private insertInternal(node: RTreeNode<ID>, item: RTreeLeafItem<ID>): RTreeNode<ID> | null {
    node.bbox =
      node.bbox[0] === Infinity ? item.bbox : unionBbox(node.bbox, item.bbox);
    if (node.leaf) {
      node.items!.push(item);
      if (node.items!.length <= this.maxEntries) return null;
      return this.splitLeaf(node);
    }

    let bestChild = node.children![0]!;
    let bestEnl = Infinity;
    for (const child of node.children!) {
      const enl = enlargement(child.bbox, item.bbox);
      if (enl < bestEnl || (enl === bestEnl && bboxArea(child.bbox) < bboxArea(bestChild.bbox))) {
        bestEnl = enl;
        bestChild = child;
      }
    }
    const splitChild = this.insertInternal(bestChild, item);
    if (!splitChild) return null;
    node.children!.push(splitChild);
    if (node.children!.length <= this.maxEntries) return null;
    return this.splitBranch(node);
  }

  private splitLeaf(node: RTreeNode<ID>): RTreeNode<ID> {
    const sorted = [...node.items!].sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
    const mid = Math.ceil(sorted.length / 2);
    const left = sorted.slice(0, mid);
    const right = sorted.slice(mid);
    node.items = left;
    node.bbox = left.reduce((acc, it) => unionBbox(acc, it.bbox), left[0]!.bbox);
    return {
      bbox: right.reduce((acc, it) => unionBbox(acc, it.bbox), right[0]!.bbox),
      leaf: true,
      items: right,
    };
  }

  private splitBranch(node: RTreeNode<ID>): RTreeNode<ID> {
    const sorted = [...node.children!].sort(
      (a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1],
    );
    const mid = Math.ceil(sorted.length / 2);
    const left = sorted.slice(0, mid);
    const right = sorted.slice(mid);
    node.children = left;
    node.bbox = left.reduce((acc, ch) => unionBbox(acc, ch.bbox), left[0]!.bbox);
    return {
      bbox: right.reduce((acc, ch) => unionBbox(acc, ch.bbox), right[0]!.bbox),
      leaf: false,
      children: right,
    };
  }

  remove(id: ID): boolean {
    if (!this.byId.delete(id)) return false;
    const remaining = [...this.byId.values()];
    this.root = { bbox: [Infinity, Infinity, -Infinity, -Infinity], leaf: true, items: [] };
    this.byId.clear();
    for (const it of remaining) {
      this.insert(it.id, it.geometry);
    }
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.root = { bbox: [Infinity, Infinity, -Infinity, -Infinity], leaf: true, items: [] };
  }

  searchBbox(bbox: BoundingBox): Array<{ id: ID; bbox: BoundingBox; geometry: GeoGeometry }> {
    if (this.byId.size === 0) return [];
    const results: Array<{ id: ID; bbox: BoundingBox; geometry: GeoGeometry }> = [];
    const stack: RTreeNode<ID>[] = [this.root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (!bboxesIntersect(cur.bbox, bbox)) continue;
      if (cur.leaf) {
        for (const it of cur.items!) {
          if (bboxesIntersect(it.bbox, bbox)) {
            results.push({ id: it.id, bbox: it.bbox, geometry: it.geometry });
          }
        }
      } else {
        for (const ch of cur.children!) stack.push(ch);
      }
    }
    return results;
  }

  knn(
    lon: number,
    lat: number,
    k = 10,
    options: { maxDistanceMeters?: number; filter?: (id: ID) => boolean } = {},
  ): Array<{ id: ID; distanceMeters: number; geometry: GeoGeometry }> {
    if (this.byId.size === 0 || k <= 0) return [];
    const maxDist = options.maxDistanceMeters ?? Infinity;
    const queue: Array<{ node: RTreeNode<ID>; minDist: number }> = [
      { node: this.root, minDist: minBoxDistMeters(lon, lat, this.root.bbox) },
    ];
    const best: Array<{ id: ID; distanceMeters: number; geometry: GeoGeometry }> = [];

    while (queue.length > 0) {
      queue.sort((a, b) => a.minDist - b.minDist);
      const cur = queue.shift()!;
      const kthDist = best.length >= k ? best[k - 1]!.distanceMeters : maxDist;
      if (cur.minDist > kthDist) break;

      if (cur.node.leaf) {
        for (const it of cur.node.items!) {
          if (options.filter && !options.filter(it.id)) continue;
          const d = distanceToGeometryMeters(lon, lat, it.geometry);
          if (d <= maxDist) {
            best.push({ id: it.id, distanceMeters: d, geometry: it.geometry });
            best.sort((a, b) => a.distanceMeters - b.distanceMeters);
            if (best.length > k) best.length = k;
          }
        }
      } else {
        for (const ch of cur.node.children!) {
          const md = minBoxDistMeters(lon, lat, ch.bbox);
          if (md <= kthDist) {
            queue.push({ node: ch, minDist: md });
          }
        }
      }
    }
    return best;
  }

  toJSON(): SerializedRTree<ID> {
    return {
      version: 1,
      maxEntries: this.maxEntries,
      items: [...this.byId.values()].map((it) => ({
        id: it.id,
        bbox: it.bbox,
        geometry: it.geometry,
      })),
    };
  }

  static deserialize<ID = string | number>(raw: string | SerializedRTree<ID>): RTreeIndex<ID> {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as SerializedRTree<ID>;
    const tree = new RTreeIndex<ID>({ maxEntries: parsed.maxEntries });
    for (const it of parsed.items) {
      tree.insert(it.id, it.geometry);
    }
    return tree;
  }
}

function qSpIdent(name: string): string {
  return `"${name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/"/g, '""')}"`;
}

function spFieldCI(
  row: Record<string, unknown>,
  name: string,
): { key: string; value: unknown } | undefined {
  const clean = name.replace(/^"|"$/g, '');
  if (clean in row) return { key: clean, value: row[clean] };
  const upper = clean.toUpperCase();
  if (upper in row) return { key: upper, value: row[upper] };
  for (const k of Object.keys(row)) {
    if (k.toUpperCase() === upper) return { key: k, value: row[k] };
  }
  return undefined;
}

async function execSpSql(
  db: SpatialDatabaseExecutor,
  sql: string,
  params?: QueryParams,
): Promise<void> {
  if (typeof db.execute === 'function') await db.execute(sql, params);
  else if (typeof db.exec === 'function') await db.exec(sql, params);
  else await db.query(sql, params);
}

/**
 * Create (or load) a persistent 2D R-Tree spatial index over a Firebird WKT or
 * GeoJSON column (`M29 Item 2`).
 */
export async function createSpatialIndex<ID = number | string>(
  db: SpatialDatabaseExecutor,
  options: SpatialIndexOptions,
): Promise<PersistentSpatialIndex<ID>> {
  const tableIdent = qSpIdent(options.table);
  const colIdent = qSpIdent(options.column);
  const keyRaw = options.keyColumn ?? 'ID';
  const keyIdent = qSpIdent(keyRaw);
  const cleanTable = options.table.trim().replace(/^"|"$/g, '').toUpperCase();
  const cleanCol = options.column.trim().replace(/^"|"$/g, '').toUpperCase();
  const cleanKey = keyRaw.trim().replace(/^"|"$/g, '');
  const indexName = (options.name ?? `IDX_${cleanTable}_${cleanCol}_RTREE`).toUpperCase();
  const persist = options.persist !== false;

  let rtree = new RTreeIndex<ID>({ maxEntries: options.maxEntries });

  const ensureCatalog = async (): Promise<void> => {
    const chk = await db.query<{ CNT: number }>(
      `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = '${DEFAULT_SPATIAL_INDEX_TABLE}'`,
    );
    if (Number(chk.rows[0]?.CNT ?? 0) > 0) return;
    await execSpSql(
      db,
      `CREATE TABLE "${DEFAULT_SPATIAL_INDEX_TABLE}" (
        INDEX_NAME VARCHAR(128) NOT NULL PRIMARY KEY,
        TABLE_NAME VARCHAR(128) NOT NULL,
        COLUMN_NAME VARCHAR(128) NOT NULL,
        KEY_COLUMN VARCHAR(128) NOT NULL,
        ITEM_COUNT INTEGER NOT NULL,
        RTREE_JSON BLOB SUB_TYPE TEXT NOT NULL,
        UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  };

  const populateFromTable = async (): Promise<void> => {
    const nextTree = new RTreeIndex<ID>({ maxEntries: options.maxEntries });
    const res = await db.query<Record<string, unknown>>(
      `SELECT ${keyIdent}, ${colIdent} FROM ${tableIdent} WHERE ${colIdent} IS NOT NULL`,
    );
    for (const r of res.rows) {
      const k = spFieldCI(r, cleanKey);
      const v = spFieldCI(r, cleanCol);
      if (!k || k.value == null || !v || v.value == null) continue;
      nextTree.insert(k.value as ID, String(v.value));
    }
    rtree = nextTree;
  };

  const saveToCatalog = async (): Promise<void> => {
    await ensureCatalog();
    await execSpSql(
      db,
      `UPDATE OR INSERT INTO "${DEFAULT_SPATIAL_INDEX_TABLE}" (
        INDEX_NAME, TABLE_NAME, COLUMN_NAME, KEY_COLUMN, ITEM_COUNT, RTREE_JSON, UPDATED_AT
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) MATCHING (INDEX_NAME)`,
      [indexName, cleanTable, cleanCol, cleanKey.toUpperCase(), rtree.size, JSON.stringify(rtree.toJSON())],
    );
  };

  if (persist) {
    await ensureCatalog();
    if (!options.forceRebuild) {
      const saved = await db.query<{ RTREE_JSON: string }>(
        `SELECT RTREE_JSON FROM "${DEFAULT_SPATIAL_INDEX_TABLE}" WHERE INDEX_NAME = ?`,
        [indexName],
      );
      const rawJson = saved.rows[0]?.RTREE_JSON;
      if (typeof rawJson === 'string' && rawJson.length > 0) {
        rtree = RTreeIndex.deserialize<ID>(rawJson);
      } else {
        await populateFromTable();
        await saveToCatalog();
      }
    } else {
      await populateFromTable();
      await saveToCatalog();
    }
  } else {
    await populateFromTable();
  }

  const autoSyncCtrl = attachIndexAutoSync(db, cleanTable, options.autoSync === true, async () => {
    await populateFromTable();
    if (persist) await saveToCatalog();
  });

  const fetchAllowedSet = async (where?: string, params?: QueryParams): Promise<Set<string> | null> => {
    if (!where?.trim()) return null;
    const res = await db.query<Record<string, unknown>>(
      `SELECT ${keyIdent} FROM ${tableIdent} WHERE (${where.trim()}) AND ${colIdent} IS NOT NULL`,
      params ?? [],
    );
    const set = new Set<string>();
    for (const r of res.rows) {
      const kv = spFieldCI(r, cleanKey);
      if (kv && kv.value != null) set.add(String(kv.value));
    }
    return set;
  };

  const fetchRowsByIds = async (ids: readonly ID[]): Promise<Map<string, Record<string, unknown>>> => {
    const map = new Map<string, Record<string, unknown>>();
    if (ids.length === 0) return map;
    const ph = ids.map(() => '?').join(', ');
    const res = await db.query<Record<string, unknown>>(
      `SELECT * FROM ${tableIdent} WHERE ${keyIdent} IN (${ph})`,
      ids as unknown as QueryParams,
    );
    for (const r of res.rows) {
      const kv = spFieldCI(r, cleanKey);
      if (kv && kv.value != null) map.set(String(kv.value), r);
    }
    return map;
  };

  const handle: PersistentSpatialIndex<ID> = {
    name: indexName,
    table: options.table,
    column: options.column,
    keyColumn: keyRaw,
    get rtree() {
      return rtree;
    },
    get size() {
      return rtree.size;
    },
    async upsert(id, geom) {
      rtree.insert(id, geom);
      if (persist) await saveToCatalog();
    },
    async remove(id) {
      const ok = rtree.remove(id);
      if (ok && persist) await saveToCatalog();
      return ok;
    },
    async rebuild() {
      await populateFromTable();
      if (persist) await saveToCatalog();
    },
    async save() {
      await saveToCatalog();
    },
    async drop() {
      autoSyncCtrl.dispose();
      rtree.clear();
      if (persist) {
        await ensureCatalog();
        await execSpSql(db, `DELETE FROM "${DEFAULT_SPATIAL_INDEX_TABLE}" WHERE INDEX_NAME = ?`, [
          indexName,
        ]);
      }
    },
    asReplicationIndexHook(): ReplicationIndexHook {
      return buildReplicationIndexHook<ID>({
        cleanTableUpper: cleanTable,
        keyColumn: cleanKey,
        async onUpsertRow(id, row) {
          const v = spFieldCI(row, cleanCol);
          if (!v || v.value == null) {
            await handle.remove(id);
            return;
          }
          await handle.upsert(id, String(v.value));
        },
        async onDeleteId(id) {
          await handle.remove(id);
        },
      });
    },
    dispose() {
      autoSyncCtrl.dispose();
    },
    async bboxSearch<T extends Row = Row>(
      bbox: BoundingBox,
      bOpts: { where?: string; params?: QueryParams; limit?: number } = {},
    ) {
      await autoSyncCtrl.ensureSynced();
      const allowed = await fetchAllowedSet(bOpts.where, bOpts.params);
      if (allowed && allowed.size === 0) return [];
      let hits = rtree.searchBbox(bbox);
      if (allowed) hits = hits.filter((h) => allowed.has(String(h.id)));
      if (bOpts.limit !== undefined) hits = hits.slice(0, bOpts.limit);
      const rowMap = await fetchRowsByIds(hits.map((h) => h.id));
      return hits
        .map((h) => rowMap.get(String(h.id)) as T | undefined)
        .filter((r): r is T => r !== undefined);
    },
    async knnSearch<T extends Row = Row>(
      lon: number,
      lat: number,
      kOpts: {
        k?: number;
        maxDistanceMeters?: number;
        where?: string;
        params?: QueryParams;
        distanceColumn?: string;
      } = {},
    ) {
      await autoSyncCtrl.ensureSynced();
      const allowed = await fetchAllowedSet(kOpts.where, kOpts.params);
      if (allowed && allowed.size === 0) return [];
      const hits = rtree.knn(lon, lat, kOpts.k ?? 10, {
        maxDistanceMeters: kOpts.maxDistanceMeters,
        filter: allowed ? (id) => allowed.has(String(id)) : undefined,
      });
      const distCol = kOpts.distanceColumn ?? 'DISTANCE_M';
      const rowMap = await fetchRowsByIds(hits.map((h) => h.id));
      const out: Array<SpatialSearchRow<T>> = [];
      for (const h of hits) {
        const row = rowMap.get(String(h.id));
        if (!row) continue;
        out.push({ ...(row as T), [distCol]: h.distanceMeters });
      }
      return out;
    },
    async withinRadius<T extends Row = Row>(
      lon: number,
      lat: number,
      radiusMeters: number,
      rOpts: {
        where?: string;
        params?: QueryParams;
        limit?: number;
        distanceColumn?: string;
      } = {},
    ) {
      await autoSyncCtrl.ensureSynced();
      return handle.knnSearch<T>(lon, lat, {
        k: rOpts.limit ?? Math.max(1, rtree.size),
        maxDistanceMeters: radiusMeters,
        where: rOpts.where,
        params: rOpts.params,
        distanceColumn: rOpts.distanceColumn,
      });
    },
  };

  return handle;
}

/**
 * Register OGC-style spatial SQL UDR functions on `db` (`M29 Item 2`):
 * `ST_DISTANCE_M`, `ST_DWITHIN`, `ST_CONTAINS`, `ST_INTERSECTS`, `ST_AREA_M2`, `ST_ASGEOJSON`.
 */
export async function registerSpatialFunctions(
  db: SpatialDatabaseExecutor,
  options: { replace?: boolean } = {},
): Promise<RegisteredRoutine[]> {
  if (typeof db.registerFunction !== 'function') {
    throw new TypeError('Database instance does not support db.registerFunction()');
  }
  const replace = options.replace !== false;
  const routines: RegisteredRoutine[] = [];

  routines.push(
    await db.registerFunction(
      'ST_DISTANCE_M',
      { args: ['VARCHAR(4096)', 'VARCHAR(4096)'], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (a: unknown, b: unknown) => {
        if (a == null || b == null) return null;
        const ga = parseGeoGeometry(String(a));
        const gb = parseGeoGeometry(String(b));
        if (ga.type === 'Point') return distanceToGeometryMeters(ga.coordinates[0], ga.coordinates[1], gb);
        if (gb.type === 'Point') return distanceToGeometryMeters(gb.coordinates[0], gb.coordinates[1], ga);
        const ca = computeBoundingBox(ga);
        return distanceToGeometryMeters((ca[0] + ca[2]) / 2, (ca[1] + ca[3]) / 2, gb);
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'ST_DWITHIN',
      {
        args: ['VARCHAR(4096)', 'VARCHAR(4096)', 'DOUBLE PRECISION'],
        returns: 'SMALLINT',
        deterministic: true,
        replace,
      },
      (a: unknown, b: unknown, radiusM: unknown) => {
        if (a == null || b == null || radiusM == null) return null;
        const ga = parseGeoGeometry(String(a));
        const gb = parseGeoGeometry(String(b));
        const d =
          ga.type === 'Point'
            ? distanceToGeometryMeters(ga.coordinates[0], ga.coordinates[1], gb)
            : gb.type === 'Point'
              ? distanceToGeometryMeters(gb.coordinates[0], gb.coordinates[1], ga)
              : 0;
        return d <= Number(radiusM) ? 1 : 0;
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'ST_CONTAINS',
      { args: ['VARCHAR(4096)', 'VARCHAR(4096)'], returns: 'SMALLINT', deterministic: true, replace },
      (polyRaw: unknown, ptRaw: unknown) => {
        if (polyRaw == null || ptRaw == null) return null;
        const poly = parseGeoGeometry(String(polyRaw));
        const pt = parseGeoGeometry(String(ptRaw));
        if (poly.type !== 'Polygon' || pt.type !== 'Point') return 0;
        return pointInPolygon(pt.coordinates[0], pt.coordinates[1], poly) ? 1 : 0;
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'ST_INTERSECTS',
      { args: ['VARCHAR(4096)', 'VARCHAR(4096)'], returns: 'SMALLINT', deterministic: true, replace },
      (a: unknown, b: unknown) => {
        if (a == null || b == null) return null;
        return geometriesIntersect(String(a), String(b)) ? 1 : 0;
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'ST_AREA_M2',
      { args: ['VARCHAR(4096)'], returns: 'DOUBLE PRECISION', deterministic: true, replace },
      (polyRaw: unknown) => {
        if (polyRaw == null) return null;
        return polygonAreaSqMeters(String(polyRaw));
      },
    ),
  );

  routines.push(
    await db.registerFunction(
      'ST_ASGEOJSON',
      { args: ['VARCHAR(4096)'], returns: 'VARCHAR(4096)', deterministic: true, replace },
      (raw: unknown) => {
        if (raw == null) return null;
        return toGeoJson(String(raw));
      },
    ),
  );

  return routines;
}
