import type { BuildingInfo, FacadeRect, FacadeSpec, InteriorOptions } from '../../shared/contract';
import { perimeter, polygonArea } from '../pick/geometry';

/** Pure FacadeSpec editing helpers. All functions return new objects; rect lists are copied. */

export type RGB = [number, number, number];
export const MIN_RECT_M = 0.2;
export const LOW_CONFIDENCE = 0.5;
/** main/python accept wall sizes only in this range (metres). */
export const WALL_MIN_M = 0.5;
export const WALL_MAX_M = 300;
export const clampWall = (v: number): number => Math.min(WALL_MAX_M, Math.max(WALL_MIN_M, v));
/** null when both sizes are finite and within range, else a user-facing message. */
export function wallSizeError(w: number | null, h: number | null): string | null {
  const ok = (v: number | null): boolean => v !== null && Number.isFinite(v) && v >= WALL_MIN_M && v <= WALL_MAX_M;
  return ok(w) && ok(h) ? null : `Wall width and height must each be ${WALL_MIN_M} - ${WALL_MAX_M} m.`;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function rgbToHex(c: readonly number[]): string {
  return '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(h: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function floorLinesFor(wallHeightM: number, floors: number): number[] {
  const f = Math.max(1, Math.round(floors));
  const out: number[] = [];
  for (let i = 1; i < f; i++) out.push(round2((i * wallHeightM) / f));
  return out;
}
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Empty spec used for manual (no-analysis) editing. */
export function blankSpec(wallWidthM: number, wallHeightM: number, floors: number): FacadeSpec {
  return {
    version: 1, wallWidthM, wallHeightM, floors,
    floorLinesV: floorLinesFor(wallHeightM, floors),
    wallColour: [200, 190, 175], trimColour: [235, 230, 220], glassColour: [120, 160, 190],
    material: 'plaster', windows: [], doors: [],
    confidence: { floors: 1, windows: 1, doors: 1, colour: 1 },
  };
}

export function setFloors(spec: FacadeSpec, floors: number): FacadeSpec {
  const f = Math.max(1, Math.min(200, Math.round(floors) || 1));
  return { ...spec, floors: f, floorLinesV: floorLinesFor(spec.wallHeightM, f) };
}

/** Keep rect inside the wall (and at least MIN_RECT_M). */
export function clampRect(r: FacadeRect, wallW: number, wallH: number): FacadeRect {
  const w = clamp(r.w, MIN_RECT_M, Math.max(MIN_RECT_M, wallW));
  const h = clamp(r.h, MIN_RECT_M, Math.max(MIN_RECT_M, wallH));
  return { u: clamp(r.u, 0, Math.max(0, wallW - w)), v: clamp(r.v, 0, Math.max(0, wallH - h)), w, h };
}

export function moveRect(r: FacadeRect, du: number, dv: number, wallW: number, wallH: number): FacadeRect {
  return clampRect({ ...r, u: r.u + du, v: r.v + dv }, wallW, wallH);
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** Resize by dragging a handle; n = top edge (higher v), w = left edge (lower u). du/dv in metres, v up. */
export function resizeRect(r: FacadeRect, handle: Handle, du: number, dv: number, wallW: number, wallH: number): FacadeRect {
  let u0 = r.u, u1 = r.u + r.w, v0 = r.v, v1 = r.v + r.h;
  if (handle.includes('w')) u0 = Math.min(u0 + du, u1 - MIN_RECT_M);
  if (handle.includes('e')) u1 = Math.max(u1 + du, u0 + MIN_RECT_M);
  if (handle.includes('n')) v1 = Math.max(v1 + dv, v0 + MIN_RECT_M);
  if (handle.includes('s')) v0 = Math.min(v0 + dv, v1 - MIN_RECT_M);
  u0 = clamp(u0, 0, wallW); u1 = clamp(u1, 0, wallW); v0 = clamp(v0, 0, wallH); v1 = clamp(v1, 0, wallH);
  return clampRect({ u: u0, v: v0, w: u1 - u0, h: v1 - v0 }, wallW, wallH);
}

const overlaps = (a: FacadeRect, b: FacadeRect, gap = 0.1): boolean =>
  a.u < b.u + b.w + gap && a.u + a.w + gap > b.u && a.v < b.v + b.h + gap && a.v + a.h + gap > b.v;

/** First spot (scanning left to right, bottom row first) where a w x h rect at height v overlaps nothing; null if none. */
export function findFreeSpot(spec: FacadeSpec, w: number, h: number, vs: number[]): { u: number; v: number } | null {
  const taken = [...spec.windows, ...spec.doors];
  for (const v of vs) {
    for (let u = 0.2; u + w <= spec.wallWidthM - 0.2 + 1e-9; u += 0.1) {
      const r = { u, v, w, h };
      if (!taken.some((t) => overlaps(r, t))) return { u, v };
    }
  }
  return null;
}

/**
 * New door: ground row, 0.9-1.0 x 2.0-2.2 m (shrunk only for very low walls), left-most free bay.
 * New window: 1.2 x 1.4 m on the first floor row, left-most free spot. Falls back to the wall centre if nothing is free.
 */
export function addRect(spec: FacadeSpec, kind: 'windows' | 'doors', at?: { u: number; v: number }): FacadeSpec {
  const isDoor = kind === 'doors';
  const w = Math.min(isDoor ? 1.0 : 1.2, Math.max(MIN_RECT_M, spec.wallWidthM * 0.8));
  const h = Math.min(isDoor ? 2.1 : 1.4, Math.max(MIN_RECT_M, spec.wallHeightM * 0.9));
  let u = (spec.wallWidthM - w) / 2, v = isDoor ? 0 : Math.min(1, spec.wallHeightM / 3);
  if (at) { u = at.u - w / 2; v = isDoor ? 0 : at.v - h / 2; }
  else {
    const rows = isDoor ? [0] : [v, ...spec.floorLinesV.map((f) => f + 0.9), 0.9, 2.2].filter((x) => x + h <= spec.wallHeightM);
    const free = findFreeSpot(spec, w, h, rows.length ? rows : [v]);
    if (free) ({ u, v } = free);
  }
  const r = clampRect({ u, v, w, h }, spec.wallWidthM, spec.wallHeightM);
  return { ...spec, [kind]: [...spec[kind], r] };
}

export function removeRect(spec: FacadeSpec, kind: 'windows' | 'doors', index: number): FacadeSpec {
  return { ...spec, [kind]: spec[kind].filter((_, i) => i !== index) };
}

export function updateRect(spec: FacadeSpec, kind: 'windows' | 'doors', index: number, r: FacadeRect): FacadeSpec {
  return { ...spec, [kind]: spec[kind].map((x, i) => (i === index ? r : x)) };
}

/** Change wall size (user edited the fields) and re-clamp everything. */
export function resizeWall(spec: FacadeSpec, wallW: number, wallH: number): FacadeSpec {
  wallW = clampWall(wallW);
  wallH = clampWall(wallH);
  const clampAll = (l: FacadeRect[]): FacadeRect[] => l.map((r) => clampRect(r, wallW, wallH));
  return {
    ...spec, wallWidthM: wallW, wallHeightM: wallH,
    floorLinesV: spec.floorLinesV.filter((v) => v > 0 && v < wallH),
    windows: clampAll(spec.windows), doors: clampAll(spec.doors),
  };
}

export function moveFloorLine(spec: FacadeSpec, index: number, v: number): FacadeSpec {
  const lines = spec.floorLinesV.slice();
  const lo = (lines[index - 1] ?? 0) + 0.1, hi = (lines[index + 1] ?? spec.wallHeightM) - 0.1;
  lines[index] = round2(clamp(v, lo, Math.max(lo, hi)));
  return { ...spec, floorLinesV: lines };
}

/** Which detected groups should be highlighted for review. */
export function lowConfidenceFields(spec: FacadeSpec, threshold = LOW_CONFIDENCE): Array<keyof FacadeSpec['confidence']> {
  return (Object.keys(spec.confidence) as Array<keyof FacadeSpec['confidence']>).filter((k) => spec.confidence[k] < threshold);
}

/** Final sanitise before sending: strictly increasing floor lines in (0, H), finite numbers, clamped rects. */
export function finalizeSpec(spec: FacadeSpec): FacadeSpec {
  const W = clampWall(spec.wallWidthM), H = clampWall(spec.wallHeightM);
  const lines = [...new Set(spec.floorLinesV.filter((v) => Number.isFinite(v) && v > 0 && v < H).map(round2))].sort((a, b) => a - b);
  const ok = (r: FacadeRect): boolean => [r.u, r.v, r.w, r.h].every(Number.isFinite);
  return {
    ...spec,
    wallWidthM: W, wallHeightM: H,
    floors: Math.max(1, Math.round(spec.floors)),
    floorLinesV: lines,
    windows: spec.windows.filter(ok).map((r) => clampRect(r, W, H)),
    doors: spec.doors.filter(ok).map((r) => clampRect(r, W, H)),
  };
}

/** Ground plate margin per side (m) in python's detail scene. */
export const DETAIL_MARGIN_M = 3.5;

/** Interior cost coefficient c(vs) per building class, sampled at vs = 0.10 / 0.15 / 0.25 (python agent's fit). */
const C_VS = [0.1, 0.15, 0.25];
const C_TYPICAL = [3.2, 2.1, 1.9];
const C_SMALL = [4.7, 3.1, 2.5]; // small compact: A < 200 m2 and >= 5 levels
const C_LARGE = [3.0, 1.7, 1.1]; // large: A > 1000 m2 or courtyard
/** Kinds that python always builds as a single level. */
const SINGLE_LEVEL_KINDS = new Set(['religious', 'industrial', 'minor']);
/** The python fit classed a 913 m2 building as typical, so "large" starts above this footprint area (m2). */
export const LARGE_AREA_M2 = 1000;

function interp(table: number[], vs: number): number {
  if (vs <= C_VS[0]!) return table[0]!;
  for (let i = 1; i < C_VS.length; i++) {
    if (vs <= C_VS[i]!) {
      const t = (vs - C_VS[i - 1]!) / (C_VS[i]! - C_VS[i - 1]!);
      return table[i - 1]! + t * (table[i]! - table[i - 1]!);
    }
  }
  return table[table.length - 1]!;
}

/**
 * Detail voxel count (python's measured fit, within ~6% on 7 Zurich buildings; counts scale 1/vs^2):
 *   N_off = [ (w+7)(h+7) + 1.16 A + 0.96 P H ] / vs^2        (w,h = footprint bbox sides, A area, P perimeter, H height; metres)
 *   N_on  = N_off + c(vs) * A * levels / vs^2
 * The index holds only the outer ring (no building parts), so this is an approximation for complex buildings.
 */
export function estimateDetailVoxels(
  b: BuildingInfo, cityVoxelSize: number, detailVoxelSize: number, interior: InteriorOptions,
): number {
  const vs = detailVoxelSize;
  if (!(vs > 0)) return 0;
  const k = cityVoxelSize;
  const A = polygonArea(b.footprint) * k * k;
  const P = perimeter(b.footprint) * k;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of b.footprint) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const w = (x1 - x0) * k, d = (z1 - z0) * k;
  const H = b.heightM > 0 ? b.heightM : (b.topY - b.baseY) * k;
  const m2 = 2 * DETAIL_MARGIN_M;
  const off = (w + m2) * (d + m2) + 1.16 * A + 0.96 * P * H;
  let total = off;
  if (interior.enabled) {
    const levels = SINGLE_LEVEL_KINDS.has(b.kind) ? 1 : Math.max(1, interior.levelsOverride ?? b.levels ?? 1);
    const table = A > LARGE_AREA_M2 ? C_LARGE : A < 200 && levels >= 5 ? C_SMALL : C_TYPICAL;
    total += interp(table, vs) * A * levels;
  }
  return Math.round(total / (vs * vs));
}
