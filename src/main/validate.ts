import type { AnalyzeFacadeParams, BBox, BuildingIndex, DetailParams, DetailStats, FacadeSpec, GenerateParams } from '../shared/contract';

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

export function validateGenerate(p: GenerateParams): void {
  validateBBox(p?.bbox);
  if (!(p.voxelSize >= 0.05 && p.voxelSize <= 5)) bad('voxelSize out of range');
  if (p.tileSize !== undefined && !(p.tileSize >= 50 && p.tileSize <= 5000)) bad('tileSize out of range');
  if (p.workers !== undefined && !(Number.isInteger(p.workers) && p.workers >= 0 && p.workers <= 16)) {
    bad('workers out of range');
  }
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

/** `lastBBox` = bbox of the last generate in this session; detail must reference it. */
export function validateDetail(p: DetailParams, lastBBox: BBox | null): void {
  if (!p || typeof p !== 'object') bad('missing params');
  validateBBox(p.ref?.bbox);
  if (!lastBBox || !sameBBox(p.ref.bbox, lastBBox)) bad('ref.bbox does not match the last generated area');
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
