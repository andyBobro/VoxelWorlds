import type { BuildingInfo } from '../../shared/contract';

/** Pure picking maths. Coordinates are the .vwg voxel grid (x, z); y is a voxel index. */

export type Ring = ReadonlyArray<readonly [number, number]>;

/** Even-odd ray casting. Points exactly on an edge may land either way; use polygonDistance for tolerance. */
export function pointInPolygon(ring: Ring, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** 0 when inside, else distance to the nearest edge. */
export function polygonDistance(ring: Ring, x: number, z: number): number {
  if (ring.length < 3) return Infinity;
  if (pointInPolygon(ring, x, z)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    best = Math.min(best, distToSegment(x, z, a[0], a[1], b[0], b[1]));
  }
  return best;
}

export function polygonArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

export function edgeLength(ring: Ring, edge: number): number {
  const a = ring[edge]!, b = ring[(edge + 1) % ring.length]!;
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function perimeter(ring: Ring): number {
  let p = 0;
  for (let i = 0; i < ring.length; i++) p += edgeLength(ring, i);
  return p;
}

/** Shoelace sum in (x, z); negative = counter-clockwise seen from above (x east, z south, north up). */
export function signedArea2(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** Outward unit normal (x, z) of edge i. Ring is expected CCW seen from above (outside on the right of travel); the other winding is detected and handled. */
export function edgeOutwardNormal(ring: Ring, edge: number): [number, number] {
  const a = ring[edge]!, b = ring[(edge + 1) % ring.length]!;
  const ex = b[0] - a[0], ez = b[1] - a[1];
  const l = Math.hypot(ex, ez) || 1;
  return signedArea2(ring) <= 0 ? [-ez / l, ex / l] : [ez / l, -ex / l];
}

/** Weight (voxels) of the normal-disagreement term in nearestEdge. */
export const NORMAL_WEIGHT = 3;

/**
 * Edge for a hit at (px, pz) (voxel units). Score = distance to the edge + NORMAL_WEIGHT * (1 - cos) where cos is
 * the dot of the edge's SIGNED outward normal with the hit face's horizontal normal (nx, nz). No hard cut-off, so
 * stair-stepped faces of diagonal walls (axis-aligned normals) still pick the right wall, and a back-facing edge is
 * penalised most. Roof/ground hits (no horizontal normal) use distance only. Returns -1 for a degenerate ring.
 */
export function nearestEdge(ring: Ring, px: number, pz: number, nx = 0, nz = 0): number {
  const n = ring.length;
  if (n < 2) return -1;
  const nl = Math.hypot(nx, nz);
  let best = -1, bestS = Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    let s = distToSegment(px, pz, a[0], a[1], b[0], b[1]);
    if (nl > 1e-6) {
      const [ox, oz] = edgeOutwardNormal(ring, i);
      s += NORMAL_WEIGHT * (1 - (ox * nx + oz * nz) / nl);
    }
    if (s < bestS) { bestS = s; best = i; }
  }
  return best;
}

interface Entry { b: BuildingInfo; area: number; }

/** Uniform grid over footprint bounding boxes; query is O(buildings in one cell). */
export class BuildingGrid {
  private readonly cells = new Map<number, Entry[]>();
  readonly cell: number;
  readonly count: number;

  constructor(buildings: ReadonlyArray<BuildingInfo>, cell?: number, private readonly pad = 1.5) {
    this.count = buildings.length;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const b of buildings) for (const [x, z] of b.footprint) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (cell === undefined) {
      const area = Math.max(1, (x1 - x0) * (z1 - z0));
      cell = buildings.length ? Math.max(8, Math.sqrt(area / buildings.length) * 2) : 32;
    }
    this.cell = cell;
    for (const b of buildings) {
      if (b.footprint.length < 3) continue;
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      for (const [x, z] of b.footprint) {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
      }
      const e: Entry = { b, area: polygonArea(b.footprint) };
      const cx0 = Math.floor((bx0 - pad) / cell), cx1 = Math.floor((bx1 + pad) / cell);
      const cz0 = Math.floor((bz0 - pad) / cell), cz1 = Math.floor((bz1 + pad) / cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
        const k = this.key(cx, cz);
        const l = this.cells.get(k);
        if (l) l.push(e); else this.cells.set(k, [e]);
      }
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + 1048576) * 2097152 + (cz + 1048576);
  }

  /**
   * Building containing the voxel centre (x, y, z) (y within [baseY, topY)), allowing `tol` voxels of slack
   * horizontally (wall voxels sit on the footprint boundary). Smallest-footprint wins ties (building parts).
   */
  query(x: number, y: number, z: number, tol = 1): BuildingInfo | null {
    const list = this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return null;
    let best: Entry | null = null, bestD = Infinity;
    for (const e of list) {
      const b = e.b;
      if (y < b.baseY || y >= b.topY) continue;
      const d = polygonDistance(b.footprint, x, z);
      if (d > tol) continue;
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && e.area < best.area)) { best = e; bestD = d; }
    }
    return best ? best.b : null;
  }
}

/**
 * Hit voxel from a surface hit: step half a voxel against the face normal. Inputs in voxel-grid units
 * (world metres / voxelSize). Returns the voxel centre and integer indices.
 */
export function hitToVoxel(p: readonly [number, number, number], n: readonly [number, number, number]) {
  const c: [number, number, number] = [p[0] - n[0] * 0.5, p[1] - n[1] * 0.5, p[2] - n[2] * 0.5];
  const i: [number, number, number] = [Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2])];
  return { voxel: i, centre: [i[0] + 0.5, i[1] + 0.5, i[2] + 0.5] as [number, number, number] };
}

export interface BuildingPick { building: BuildingInfo; edge: number; }

/** Full pick: surface point/normal (voxel-grid units) -> building + nearest wall edge. */
export function pickFromHit(
  grid: BuildingGrid,
  p: readonly [number, number, number],
  n: readonly [number, number, number],
): BuildingPick | null {
  const { centre } = hitToVoxel(p, n);
  let b = grid.query(centre[0], centre[1], centre[2], 1);
  if (!b) {
    // grazing a wall voxel on the footprint line: retry one voxel deeper
    b = grid.query(centre[0] - n[0], centre[1] - n[1], centre[2] - n[2], 1.5);
  }
  if (!b) return null;
  const horizontal = Math.abs(n[1]) < 0.5;
  const edge = nearestEdge(b.footprint, p[0], p[2], horizontal ? n[0] : 0, horizontal ? n[2] : 0);
  return { building: b, edge };
}
