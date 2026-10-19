/**
 * Pure logic for finding and triggering building entrances. No Three.js, no DOM.
 *
 * City frame: voxel indices of the city .vwg (metres = index * vs), +x east, +z south. Footprints are in the same
 * (continuous) voxel units, counter-clockwise from above, so for edge a->b the outward normal is (-tz, tx).
 */
import type { BuildingInfo, DetailRecord, WalkEntrance } from '../../shared/contract';

// ───────────────────────── saved entrances (instant) ─────────────────────────

export interface SavedEntrance {
  buildingId: string;
  buildingName?: string;
  detailId: string;
  entrance: WalkEntrance;
}

/** Newest detail of each building that has an interior and entrances; `noEntrance` lists buildings with an interior detail but no usable door. */
export function collectSavedEntrances(details: readonly DetailRecord[]): { entrances: SavedEntrance[]; noEntrance: Set<string> } {
  const done = new Set<string>();
  const entrances: SavedEntrance[] = [];
  const noEntrance = new Set<string>();
  for (const d of details) { // newest first
    if (!d.interior || done.has(d.buildingId)) continue;
    const list = d.stats.entrances;
    if (list && list.length > 0) {
      done.add(d.buildingId);
      noEntrance.delete(d.buildingId);
      for (const e of list) entrances.push({ buildingId: d.buildingId, buildingName: d.buildingName, detailId: d.id, entrance: e });
    } else noEntrance.add(d.buildingId);
  }
  return { entrances, noEntrance };
}

/** Metres of the city ground cell directly outside a door (cell centre in x/z, bottom of the first free cell in y). */
export function entranceCityMetres(e: WalkEntrance, vs: number): [number, number, number] {
  return [(e.city[0] + 0.5) * vs, e.city[1] * vs, (e.city[2] + 0.5) * vs];
}

export interface TriggerConfig {
  /** auto-enter radius around the door cell, metres (>= this much so a player pressed against the wall still reaches it) */
  zoneM: number;
  /** "Press E to enter" radius, metres */
  promptM: number;
  /** max |feet y - door y|, metres */
  yTolM: number;
  /** min speed (m/s) and cos(angle) between velocity and the door direction to auto-enter */
  minSpeed: number;
  minCos: number;
}

export function triggerConfig(vs: number): TriggerConfig {
  return { zoneM: Math.max(1.6, 1.5 * vs), promptM: Math.max(3.5, 3 * vs), yTolM: Math.max(2.5, 2.5 * vs), minSpeed: 0.6, minCos: 0.45 };
}

export interface EntranceHit {
  index: number;
  dist: number;
  /** player is inside the zone and moving towards the door */
  auto: boolean;
}

/**
 * Nearest saved entrance within prompt range of the feet position (metres) and whether walking into it should enter.
 * `vx, vz`: horizontal velocity (m/s). Returns null when none is in range.
 */
export function findEntrance(
  list: readonly SavedEntrance[], vs: number, x: number, y: number, z: number, vx: number, vz: number, cfg: TriggerConfig,
): EntranceHit | null {
  let best: EntranceHit | null = null;
  const speed = Math.hypot(vx, vz);
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!.entrance;
    const [ex, ey, ez] = entranceCityMetres(e, vs);
    if (Math.abs(y - ey) > cfg.yTolM) continue;
    const dx = ex - x, dz = ez - z;
    const d = Math.hypot(dx, dz);
    if (d > cfg.promptM || (best && d >= best.dist)) continue;
    // moving towards the door means moving against its outward direction
    const cos = speed > 1e-6 ? -(vx * e.cityDir[0] + vz * e.cityDir[1]) / speed : 0;
    best = { index: i, dist: d, auto: d <= cfg.zoneM && speed >= cfg.minSpeed && cos >= cfg.minCos };
  }
  return best;
}

/** Is the door's city cell (voxel indices) inside the map's x/z extent? Doors outside lead nowhere: the player would be teleported off the map. */
export function entranceInBounds(e: WalkEntrance, min: readonly number[], max: readonly number[]): boolean {
  return e.city[0] >= min[0]! && e.city[0] < max[0]! && e.city[2] >= min[2]! && e.city[2] < max[2]!;
}

/** The entrance whose city cell is nearest to the point (voxel units x, z). */
export function nearestEntrance(list: readonly WalkEntrance[], x: number, z: number): WalkEntrance | null {
  let best: WalkEntrance | null = null, bd = Infinity;
  for (const e of list) {
    const d = Math.hypot(e.city[0] + 0.5 - x, e.city[2] + 0.5 - z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// ───────────────────────── leaving a building ─────────────────────────

/**
 * Detail scene: has the player walked out through the door plane of `e`? The plane lies halfway between `inside` and
 * `outside`; the player must be within the opening (+0.5 m) laterally and at about door level.
 */
export function crossedDoor(e: WalkEntrance, x: number, y: number, z: number): boolean {
  const mx = (e.inside[0] + e.outside[0]) / 2, mz = (e.inside[2] + e.outside[2]) / 2;
  const along = (x - mx) * e.dir[0] + (z - mz) * e.dir[1]; // > 0 inside, < 0 outside
  const lat = Math.abs(-(x - mx) * e.dir[1] + (z - mz) * e.dir[0]);
  if (along > -0.05) return false;
  if (along < -2.5) return false; // far outside the plane laterally unrelated (e.g. spawned outside)
  return lat <= e.widthM / 2 + 0.5 && Math.abs(y - e.outside[1]) < 1.6;
}

// ───────────────────────── on-demand buildings (no saved detail) ─────────────────────────

export const MINOR_KINDS = new Set(['minor', 'shed', 'garage', 'garages', 'carport', 'roof', 'hut', 'cabin', 'service', 'greenhouse']);

export interface Eligibility { ok: boolean; reason?: string }

export function polygonArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** A plausible interior: levels >= 1, not a minor kind, >= 2.4 m tall, footprint 20 m2 .. 6000 m2. */
export function interiorEligibility(b: BuildingInfo, vs: number): Eligibility {
  if (MINOR_KINDS.has(b.kind)) return { ok: false, reason: 'kind' };
  if (!(b.levels >= 1)) return { ok: false, reason: 'levels' };
  if (b.heightM < 2.4) return { ok: false, reason: 'height' };
  if (b.footprint.length < 3) return { ok: false, reason: 'footprint' };
  const area = polygonArea(b.footprint) * vs * vs;
  if (area < 20) return { ok: false, reason: 'small' };
  if (area > 6000) return { ok: false, reason: 'huge' };
  return { ok: true };
}

export interface EdgeProximity {
  edge: number;
  /** distance outside the wall, voxel units */
  dist: number;
  /** wall point nearest the player, voxel units */
  qx: number; qz: number;
  /** outward unit normal */
  nx: number; nz: number;
}

/**
 * The footprint edge the point (voxel units) is closest to ON ITS OUTWARD SIDE, within `maxDist` voxels and within the
 * edge's extent (+ half a voxel slack). Edges shorter than `minLen` voxels are skipped (no door fits).
 */
export function nearestOutwardEdge(ring: ReadonlyArray<readonly [number, number]>, px: number, pz: number, maxDist: number, minLen: number): EdgeProximity | null {
  let best: EdgeProximity | null = null;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!;
    const tx = b[0] - a[0], tz = b[1] - a[1];
    const len = Math.hypot(tx, tz);
    if (len < minLen) continue;
    const ux = tx / len, uz = tz / len;
    const nx = -uz, nz = ux; // outward for counter-clockwise rings
    const along = (px - a[0]) * ux + (pz - a[1]) * uz;
    const out = (px - a[0]) * nx + (pz - a[1]) * nz;
    if (out <= 0 || out > maxDist || along < -0.5 || along > len + 0.5) continue;
    if (!best || out < best.dist) {
      const t = Math.min(len, Math.max(0, along));
      best = { edge: i, dist: out, qx: a[0] + ux * t, qz: a[1] + uz * t, nx, nz };
    }
  }
  return best;
}

/** Uniform grid over footprint bounding boxes so per-frame queries touch only the few buildings nearby. */
export class BuildingGrid {
  private readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  private readonly out: number[] = [];

  constructor(readonly buildings: readonly BuildingInfo[], voxelSize: number, cellMetres = 32, marginMetres = 4) {
    this.cell = Math.max(2, cellMetres / voxelSize);
    const margin = marginMetres / voxelSize;
    buildings.forEach((b, bi) => {
      if (b.footprint.length < 3) return;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of b.footprint) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
      const c = this.cell;
      for (let cx = Math.floor((x0 - margin) / c); cx <= Math.floor((x1 + margin) / c); cx++) {
        for (let cz = Math.floor((z0 - margin) / c); cz <= Math.floor((z1 + margin) / c); cz++) {
          const k = cx * 1_000_003 + cz;
          const l = this.cells.get(k);
          if (l) l.push(bi); else this.cells.set(k, [bi]);
        }
      }
    });
  }

  /** Candidate building indices near a point (voxel units). The returned array is reused between calls. */
  near(px: number, pz: number): readonly number[] {
    const l = this.cells.get(Math.floor(px / this.cell) * 1_000_003 + Math.floor(pz / this.cell));
    this.out.length = 0;
    if (l) for (const i of l) this.out.push(i);
    return this.out;
  }
}

export interface DoorCandidate {
  building: BuildingInfo;
  edge: EdgeProximity;
}

/**
 * Closest eligible building edge on whose outward side the player stands within `reachM` metres (feet height must lie
 * within the building's [baseY, topY) band +- 3 m so a rooftop neighbour does not count).
 */
export function findDoorCandidate(
  grid: BuildingGrid, eligible: (b: BuildingInfo) => boolean, vs: number, x: number, y: number, z: number, reachM = 1.5,
): DoorCandidate | null {
  const px = x / vs, pz = z / vs, maxD = reachM / vs, minLen = 2 / vs;
  let best: DoorCandidate | null = null;
  for (const bi of grid.near(px, pz)) {
    const b = grid.buildings[bi]!;
    if (y < b.baseY * vs - 3 || y > b.topY * vs + 3) continue;
    if (!eligible(b)) continue;
    const e = nearestOutwardEdge(b.footprint, px, pz, maxD, minLen);
    if (e && (!best || e.dist < best.edge.dist)) best = { building: b, edge: e };
  }
  return best;
}
