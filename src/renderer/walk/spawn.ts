/**
 * Spawn placement. Pure: needs only column lookups.
 *
 * Rule (documented): start at the requested city column (session.spawn, else the centre of the world). The column's
 * HIGHEST solid voxel is the candidate standing surface (so a roof, canopy or bridge deck above ground is a surface of
 * its own column, never the dark floor underneath), accepted only if
 *   1. its material is natural ground or road (when the file has material tags; otherwise any),
 *   2. the player's box fits there (no wall/hedge/tree overlapping 0.6 x 1.8 m).
 * Otherwise the search widens in rings (stride ~ player width) up to `maxRadiusM`; a second pass also accepts water.
 * Fallback if nothing fits: the highest voxel of the requested column (the player is then depenetrated upwards).
 * The result is a feet position in metres with a 1 mm lift; physics settles it onto the ground in the first frames.
 */
import type { Mover } from './physics';

export interface SpawnColumns {
  vs: number;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  materials: ReadonlyArray<string>;
  topSolid(ix: number, iz: number): number;
  cell(ix: number, iy: number, iz: number): number;
}

export interface SpawnResult {
  /** feet position, metres */
  x: number; y: number; z: number;
  /** how far from the requested column, metres */
  movedM: number;
  /** which rule produced it */
  how: 'requested' | 'nearby' | 'water' | 'fallback';
}

const GOOD = new Set(['ground', 'road']);

/** Upper bound of columns examined by one search (keeps a hopeless search from stalling the UI). */
export const MAX_SPAWN_COLUMNS = 150_000;

export function findSpawn(
  w: SpawnColumns, wantX: number, wantZ: number, fits: (x: number, y: number, z: number) => boolean, maxRadiusM = 150,
  maxColumns = MAX_SPAWN_COLUMNS,
): SpawnResult {
  let budget = maxColumns;
  const vs = w.vs;
  const cx0 = Math.min(w.max[0] - 1, Math.max(w.min[0], Math.floor(wantX)));
  const cz0 = Math.min(w.max[2] - 1, Math.max(w.min[2], Math.floor(wantZ)));
  const tagged = w.materials.length > 0;
  const stride = Math.max(1, Math.round(0.5 / vs));
  const maxR = Math.ceil(maxRadiusM / vs);

  const tryColumn = (ix: number, iz: number, allowWater: boolean): SpawnResult | null => {
    if (--budget < 0) return null;
    if (ix < w.min[0] || ix >= w.max[0] || iz < w.min[2] || iz >= w.max[2]) return null;
    const top = w.topSolid(ix, iz);
    if (top === -Infinity) return null;
    if (tagged) {
      const mat = w.materials[w.cell(ix, top, iz)];
      if (!(mat && (GOOD.has(mat) || (allowWater && mat === 'water')))) return null;
    }
    const x = (ix + 0.5) * vs, z = (iz + 0.5) * vs;
    // on a slope a neighbouring column can poke into the box: allow lifting it ~0.6 m (physics drops it back)
    let y = (top + 1) * vs + 0.001, ok = false;
    for (let lift = 0, L = Math.max(1, Math.ceil(0.6 / vs)); lift <= L && !ok; lift++) {
      y = (top + 1 + lift) * vs + 0.001;
      ok = fits(x, y, z);
    }
    if (!ok) return null;
    return { x, y, z, movedM: Math.hypot(ix - cx0, iz - cz0) * vs, how: allowWater && tagged && w.materials[w.cell(ix, top, iz)] === 'water' ? 'water' : (ix === cx0 && iz === cz0 ? 'requested' : 'nearby') };
  };

  for (const allowWater of [false, true]) {
    const r0 = tryColumn(cx0, cz0, allowWater);
    if (r0) return r0;
    for (let r = stride; r <= maxR; r += stride) {
      for (let i = -r; i <= r; i += stride) {
        const hits = [
          tryColumn(cx0 + i, cz0 - r, allowWater), tryColumn(cx0 + i, cz0 + r, allowWater),
          i > -r && i < r ? tryColumn(cx0 - r, cz0 + i, allowWater) : null,
          i > -r && i < r ? tryColumn(cx0 + r, cz0 + i, allowWater) : null,
        ];
        for (const h of hits) if (h) return h;
      }
    }
  }
  // Nothing fits: take the nearest column that has any voxel at all (never an empty column: the player would fall forever)
  budget = maxColumns;
  for (let r = 0; r <= maxR && budget > 0; r += stride) {
    for (let i = -r; i <= r; i += stride) {
      for (const [ix, iz] of [[cx0 + i, cz0 - r], [cx0 + i, cz0 + r], [cx0 - r, cz0 + i], [cx0 + r, cz0 + i]] as const) {
        budget--;
        if (ix < w.min[0] || ix >= w.max[0] || iz < w.min[2] || iz >= w.max[2]) continue;
        const top = w.topSolid(ix, iz);
        if (top !== -Infinity) return { x: (ix + 0.5) * vs, y: (top + 1) * vs + 0.001, z: (iz + 0.5) * vs, movedM: Math.hypot(ix - cx0, iz - cz0) * vs, how: 'fallback' };
      }
    }
  }
  return { x: (cx0 + 0.5) * vs, y: w.min[1] * vs + 0.001, z: (cz0 + 0.5) * vs, movedM: 0, how: 'fallback' };
}

/**
 * Where a door's outside cell really is. Python only knows the building's base height (`hint`, first free voxel
 * above its ground), not the terrain, and the cell may be under a canopy or awning. Picks the support voxel in the
 * door's column (ground/road material when tagged, `headroom` free cells above, the player's box fits) closest to the
 * hint; otherwise the nearest open ground within `maxSearchM`. Returns the voxel [x, y, z] (y = first free cell) or
 * null when the door is outside the map or no standable ground is near it.
 */
export function snapDoorCell(
  w: SpawnColumns, city: readonly [number, number, number], fits: (x: number, y: number, z: number) => boolean, maxSearchM = 6,
): [number, number, number] | null {
  const [ix, hint, iz] = city;
  if (!Number.isFinite(ix + hint + iz) || ix < w.min[0] || ix >= w.max[0] || iz < w.min[2] || iz >= w.max[2]) return null;
  const vs = w.vs, tagged = w.materials.length > 0, hc = Math.ceil(1.8 / vs) + 1;
  const x = (ix + 0.5) * vs, z = (iz + 0.5) * vs;
  let best: number | null = null, bd = Infinity;
  for (let iy = w.min[1]; iy < w.max[1]; iy++) {
    const c = w.cell(ix, iy, iz);
    if (!c || (tagged && !GOOD.has(w.materials[c] ?? ''))) continue;
    let free = true;
    for (let k = 1; k <= hc; k++) if (w.cell(ix, iy + k, iz) !== 0) { free = false; break; }
    if (!free) continue;
    const d = Math.abs(iy + 1 - hint);
    if (d < bd && fits(x, (iy + 1) * vs + 0.001, z)) { bd = d; best = iy + 1; }
  }
  if (best !== null) return [ix, best, iz];
  const sp = findSpawn(w, ix + 0.5, iz + 0.5, fits, maxSearchM, 20_000);
  if (sp.how === 'fallback') return null;
  return [Math.floor(sp.x / vs), Math.round((sp.y - 0.001) / vs), Math.floor(sp.z / vs)];
}

/** Convenience: placement test using a throw-away Mover on the same world. */
export function boxFits(m: Mover): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => {
    const px = m.p[0]!, py = m.p[1]!, pz = m.p[2]!;
    m.p[0] = x; m.p[1] = y; m.p[2] = z;
    const bad = m.overlaps();
    m.p[0] = px; m.p[1] = py; m.p[2] = pz;
    return !bad;
  };
}
