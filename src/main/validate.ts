import type { AnalyzeFacadeParams, BBox, BuildingIndex, DataSource, DetailParams, DetailStats, FacadeSpec, GenerateParams } from '../shared/contract';

/** Pure parameter validation (no electron imports so it is unit-testable). All errors are BAD_REQUEST. */

export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const MAX_DETAIL_VOXELS = 30_000_000;
export const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

const bad = (m: string): never => {
  throw new Error(`BAD_REQUEST: ${m}`);
};
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function validateBBox(b: BBox | undefined): void {
  const nums = b ? [b.latMin, b.lonMin, b.latMax, b.lonMax] : [];
  if (nums.length !== 4 || !nums.every(fin)) bad('invalid bbox');
  if (b!.latMin >= b!.latMax || b!.lonMin >= b!.lonMax) bad('empty bbox');
}

/** Geofabrik ids: lower-case segments joined by '/', e.g. "monaco", "us/alabama". No '..', no leading dots. */
const REGION_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}(\/[a-z0-9][a-z0-9_.-]{0,63}){0,3}$/;
export const isRegionId = (id: unknown): id is string => typeof id === 'string' && id.length <= 200 && REGION_ID_RE.test(id);

/** Shape check of a renderer-supplied DataSource (missing = overpass). Any pbfPath it carries is ignored/overwritten by main. */
export function validateDataSource(ds: unknown): void {
  if (ds === undefined || ds === null) return;
  const d = ds as DataSource;
  if (typeof d !== 'object') bad('invalid dataSource');
  if (d.kind === 'overpass') return;
  if (d.kind !== 'pbf') bad('unknown dataSource kind');
  if (!isRegionId((d as { regionId?: unknown }).regionId)) bad('invalid dataSource.regionId');
}

/** Identity of a data source for the "detail must match last generate" rule (pbfPath is irrelevant). */
export const sourceKey = (ds: DataSource | undefined | null): string => (ds && ds.kind === 'pbf' ? `pbf:${ds.regionId}` : 'overpass');

export function validateGenerate(p: GenerateParams): void {
  if (!p || typeof p !== 'object') bad('missing params');
  validateBBox(p.bbox);
  validateDataSource(p.dataSource);
  if (!(p.voxelSize >= 0.05 && p.voxelSize <= 5)) bad('voxelSize out of range');
  if (p.tileSize !== undefined && !(p.tileSize >= 50 && p.tileSize <= 5000)) bad('tileSize out of range');
  if (p.workers !== undefined && !(Number.isInteger(p.workers) && p.workers >= 0 && p.workers <= 16)) {
    bad('workers out of range');
  }
  const f = p.features as unknown as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object') bad('features missing');
  for (const k of ['roads', 'elevation', 'proceduralFacades']) if (typeof f![k] !== 'boolean') bad(`features.${k} must be a boolean`);
  if (!rng(p.metersPerFloor, 0.5, 10)) bad('metersPerFloor out of range (0.5-10)');
  if (!rng(p.defaultBuildingHeight, 1, 1000)) bad('defaultBuildingHeight out of range (1-1000)');
  if (!int(p.maxVoxels, 1, 2_000_000_000)) bad('maxVoxels out of range');
  if (p.mapillaryToken !== undefined && (typeof p.mapillaryToken !== 'string' || p.mapillaryToken.length > 512)) bad('invalid mapillaryToken');
}

export function validateAnalyzeFacade(p: AnalyzeFacadeParams): void {
  if (!p || typeof p !== 'object') bad('missing params');
  if (typeof p.photoPath !== 'string' || !p.photoPath) bad('photoPath required');
  const c = p.corners as unknown;
  if (!Array.isArray(c) || c.length !== 4) bad('corners must be 4 points');
  for (const pt of c as unknown[]) {
    if (!Array.isArray(pt) || pt.length !== 2 || !fin(pt[0]) || !fin(pt[1]) || pt[0] < 0 || pt[1] < 0) {
      bad('corners must be 4 finite [x, y] pairs');
    }
  }
  if (!rng(p.wallWidthM, 0.5, 300)) bad('wallWidthM out of range (0.5-300)');
  if (!rng(p.wallHeightM, 0.5, 300)) bad('wallHeightM out of range (0.5-300)');
  if (p.floorsHint !== undefined && !(Number.isInteger(p.floorsHint) && p.floorsHint >= 1 && p.floorsHint <= 200)) {
    bad('floorsHint out of range');
  }
}

const MATERIALS = ['plaster', 'brick', 'stone', 'concrete', 'glass', 'wood', 'metal'];
const int = (n: unknown, lo: number, hi: number): boolean => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
const rng = (n: unknown, lo: number, hi: number): boolean => fin(n) && n >= lo && n <= hi;

const rgb = (c: unknown): boolean => Array.isArray(c) && c.length === 3 && c.every((v) => int(v, 0, 255));
const rects = (a: unknown, max: number): boolean =>
  Array.isArray(a) &&
  a.length <= max &&
  a.every((r) => r && fin(r.u) && fin(r.v) && fin(r.w) && fin(r.h) && r.w >= 0 && r.h >= 0);

/** Full FacadeSpec check; used for renderer input to detail and for python's analyze output. */
export function validateFacadeSpec(s: FacadeSpec): void {
  if (!s || typeof s !== 'object' || s.version !== 1) bad('facade.spec invalid');
  if (!rng(s.wallWidthM, 0.5, 300) || !rng(s.wallHeightM, 0.5, 300)) bad('facade.spec wall size invalid');
  if (!int(s.floors, 1, 250)) bad('facade.spec floors invalid');
  const fl = s.floorLinesV;
  if (!Array.isArray(fl) || fl.length > 300 || !fl.every(fin) || fl.some((v, i) => v <= 0 || (i > 0 && v <= fl[i - 1]))) {
    bad('facade.spec floorLinesV invalid');
  }
  if (!rgb(s.wallColour) || !rgb(s.trimColour) || !rgb(s.glassColour)) bad('facade.spec colours invalid');
  if (!MATERIALS.includes(s.material)) bad('facade.spec material invalid');
  if (!rects(s.windows, 2000) || !rects(s.doors, 2000)) bad('facade.spec windows/doors invalid');
  const c = s.confidence;
  if (!c || !['floors', 'windows', 'doors', 'colour'].every((k) => rng((c as unknown as Record<string, unknown>)[k], 0, 1))) {
    bad('facade.spec confidence invalid');
  }
}

export function validateDetailStats(s: DetailStats): void {
  const ok =
    s &&
    ['voxelCount', 'levels', 'rooms', 'windows', 'doors', 'elapsedMs'].every((k) => fin((s as unknown as Record<string, unknown>)[k])) &&
    Array.isArray(s.floorYs) &&
    s.floorYs.length <= 300 &&
    s.floorYs.every((v) => Number.isInteger(v));
  if (!ok) throw new Error('INTERNAL: backend returned malformed detail stats');
}

const sameBBox = (a: BBox, b: BBox): boolean =>
  (['latMin', 'lonMin', 'latMax', 'lonMax'] as const).every((k) => Math.abs(a[k] - b[k]) <= 1e-9);

export interface LastGenerate {
  bbox: BBox;
  dataSource?: DataSource;
}

/**
 * `last` = the last generate (or opened world): detail must reference the same bbox AND the same data source
 * (kind + regionId). A bare BBox means "overpass" (legacy callers/tests).
 */
export function validateDetail(p: DetailParams, last: BBox | LastGenerate | null): void {
  if (!p || typeof p !== 'object') bad('missing params');
  validateBBox(p.ref?.bbox);
  const lg: LastGenerate | null = last && 'bbox' in last ? last : last ? { bbox: last } : null;
  if (!lg || !sameBBox(p.ref.bbox, lg.bbox)) bad('ref.bbox does not match the last generated area');
  validateDataSource(p.ref.dataSource);
  if (sourceKey(p.ref.dataSource) !== sourceKey(lg!.dataSource)) bad('ref.dataSource does not match the last generated area');
  if (typeof p.ref.buildingId !== 'string' || !/^(way|relation|node)\/\d+(#\d+)?$/.test(p.ref.buildingId)) {
    bad('invalid buildingId');
  }
  const ref = p.ref as unknown as Record<string, unknown>;
  if (ref.metersPerFloor !== undefined && !rng(ref.metersPerFloor, 0.5, 10)) bad('ref.metersPerFloor out of range');
  if (ref.defaultBuildingHeight !== undefined && !rng(ref.defaultBuildingHeight, 1, 1000)) {
    bad('ref.defaultBuildingHeight out of range');
  }
  if (!fin(p.voxelSize) || p.voxelSize < 0.05 || p.voxelSize > 0.5) bad('voxelSize out of range (0.05-0.5)');
  if (!int(p.maxVoxels, 1, MAX_DETAIL_VOXELS)) bad('maxVoxels out of range');
  if (p.includeNeighbours !== undefined && typeof p.includeNeighbours !== 'boolean') bad('includeNeighbours invalid');
  if (p.facade !== undefined) {
    if (!p.facade || !int(p.facade.edge, 0, 10_000)) bad('facade.edge invalid');
    validateFacadeSpec(p.facade.spec);
  }
  const i = p.interior;
  if (i !== undefined) {
    if (!i || typeof i.enabled !== 'boolean') bad('interior.enabled invalid');
    if (i.levelsOverride !== undefined && !int(i.levelsOverride, 1, 250)) bad('interior.levelsOverride invalid');
    if (i.wallThicknessM !== undefined && !rng(i.wallThicknessM, 0.05, 2)) bad('interior.wallThicknessM invalid');
    if (i.roomMinM !== undefined && !rng(i.roomMinM, 1, 20)) bad('interior.roomMinM invalid');
    if (i.seed !== undefined && !(fin(i.seed) && Number.isInteger(i.seed))) bad('interior.seed invalid');
  }
}

/** Shape check of a parsed `.buildings.json`; returns it typed or throws. */
export function validateBuildingIndex(x: unknown): BuildingIndex {
  const idx = x as BuildingIndex;
  if (!idx || typeof idx !== 'object' || idx.version !== 1 || !Array.isArray(idx.buildings)) bad('not a building index');
  for (const b of idx.buildings) {
    const ok =
      b &&
      typeof b.id === 'string' &&
      typeof b.kind === 'string' &&
      fin(b.levels) &&
      fin(b.heightM) &&
      fin(b.baseY) &&
      fin(b.topY) &&
      Array.isArray(b.footprint) &&
      b.footprint.length >= 3 &&
      b.footprint.every((q) => Array.isArray(q) && q.length === 2 && fin(q[0]) && fin(q[1]));
    if (!ok) bad(`malformed building entry${b && typeof b.id === 'string' ? ` ${b.id}` : ''}`);
  }
  return idx;
}
