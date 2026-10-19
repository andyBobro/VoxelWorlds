/**
 * Pure, GPU-free selection logic for streaming a large voxel world around the player. No Three.js, no DOM.
 *
 * The world is cut into super-chunks (GROUP^3 chunks of 32^3 voxels, same as the preview's merge.ts). Each frame the
 * streamer needs to know which super-chunks to build (nearest first, biased towards the view direction), which to drop
 * (beyond radius + hysteresis) and how far to look (radius adapts to a triangle / GPU byte budget).
 */
import { CS } from '../preview/mesher';
import { GROUP, groupChunks } from '../preview/merge';
import type { ChunkStore } from './chunkStore';

export interface GroupTable {
  count: number;
  /** chunk ids of group g: order[starts[g] .. starts[g+1]) */
  order: Uint32Array;
  starts: Int32Array;
  /** super-chunk coordinates, 3 ints per group */
  coords: Int32Array;
  /** world-space bounds of the non-empty chunks of each group, metres */
  minX: Float32Array; minY: Float32Array; minZ: Float32Array;
  maxX: Float32Array; maxY: Float32Array; maxZ: Float32Array;
  /** metres per super-chunk edge */
  span: number;
}

export function buildGroupTable(store: ChunkStore): GroupTable {
  const ids: number[] = [];
  const nChunks = store.starts.length - 1;
  for (let k = 0; k < nChunks; k++) if (store.starts[k + 1]! > store.starts[k]!) ids.push(k);
  const g = groupChunks(store.dims, ids);
  const count = g.coords.length / 3;
  const t: GroupTable = {
    count, order: g.order, starts: g.starts, coords: g.coords,
    minX: new Float32Array(count), minY: new Float32Array(count), minZ: new Float32Array(count),
    maxX: new Float32Array(count), maxY: new Float32Array(count), maxZ: new Float32Array(count),
    span: GROUP * CS * store.vs,
  };
  const vs = store.vs;
  for (let i = 0; i < count; i++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = g.starts[i]!; k < g.starts[i + 1]!; k++) {
      const [cx, cy, cz] = store.chunkCoords(g.order[k]!);
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx + 1);
      y0 = Math.min(y0, cy); y1 = Math.max(y1, cy + 1);
      z0 = Math.min(z0, cz); z1 = Math.max(z1, cz + 1);
    }
    t.minX[i] = (store.min[0] + x0 * CS) * vs; t.maxX[i] = (store.min[0] + x1 * CS) * vs;
    t.minY[i] = (store.min[1] + y0 * CS) * vs; t.maxY[i] = (store.min[1] + y1 * CS) * vs;
    t.minZ[i] = (store.min[2] + z0 * CS) * vs; t.maxZ[i] = (store.min[2] + z1 * CS) * vs;
  }
  return t;
}

/** Distance from a point to the box of group `g` (0 inside). */
export function distToGroup(t: GroupTable, g: number, px: number, py: number, pz: number): number {
  const dx = Math.max(t.minX[g]! - px, 0, px - t.maxX[g]!);
  const dy = Math.max(t.minY[g]! - py, 0, py - t.maxY[g]!);
  const dz = Math.max(t.minZ[g]! - pz, 0, pz - t.maxZ[g]!);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const ABSENT = 0;
export const RESIDENT = 1;

export interface StreamPlan {
  /** groups to build, best first */
  load: Int32Array;
  loadCount: number;
  /** resident groups to drop */
  unload: Int32Array;
  unloadCount: number;
}

/** Priority of loading a group: lower = sooner. Groups behind the viewer are deferred by up to +60% of their distance. */
export function loadScore(dist: number, span: number, toX: number, toZ: number, dirX: number, dirZ: number): number {
  if (dist <= span * 0.6) return dist * 0.5; // the ground under and around the player always first
  const len = Math.hypot(toX, toZ);
  const cos = len > 1e-6 ? (toX * dirX + toZ * dirZ) / len : 1;
  return dist * (1 + 0.6 * (1 - cos) * 0.5);
}

/** Reusable planner (scratch buffers sized once). */
export class StreamPlanner {
  readonly plan: StreamPlan;
  private readonly score: Float32Array;
  constructor(private readonly t: GroupTable) {
    this.plan = { load: new Int32Array(t.count), loadCount: 0, unload: new Int32Array(t.count), unloadCount: 0 };
    this.score = new Float32Array(t.count);
  }

  /**
   * state[g] is ABSENT or RESIDENT. A group is wanted when its box is within `radius` of the player; resident groups
   * farther than `radius + hysteresis` are dropped (the band in between keeps what it has but starts nothing new).
   * (dirX, dirZ) is the unit horizontal view direction.
   */
  run(state: Uint8Array, px: number, py: number, pz: number, dirX: number, dirZ: number, radius: number, hysteresis: number): StreamPlan {
    const t = this.t, plan = this.plan, score = this.score;
    let nl = 0, nu = 0;
    const drop = radius + hysteresis;
    for (let g = 0; g < t.count; g++) {
      const d = distToGroup(t, g, px, py, pz);
      if (state[g] === RESIDENT) {
        if (d > drop) plan.unload[nu++] = g;
      } else if (d <= radius) {
        const cx = (t.minX[g]! + t.maxX[g]!) * 0.5 - px, cz = (t.minZ[g]! + t.maxZ[g]!) * 0.5 - pz;
        score[g] = loadScore(d, t.span, cx, cz, dirX, dirZ);
        plan.load[nl++] = g;
      }
    }
    if (nl > 1) plan.load.subarray(0, nl).sort((a, b) => score[a]! - score[b]!);
    plan.loadCount = nl;
    plan.unloadCount = nu;
    return plan;
  }
}

export interface RadiusLimits {
  rMin: number;
  rMax: number;
  maxTriangles: number;
  maxBytes: number;
}

/**
 * Largest radius whose resident groups fit the budgets: resident groups sorted by distance, accumulate until a cap is
 * hit. Returns the distance of the last group that fits (shrinking drops everything beyond it), `Infinity` if all fit.
 */
export function radiusForBudget(dist: ArrayLike<number>, tris: ArrayLike<number>, bytes: ArrayLike<number>, n: number, maxTris: number, maxBytes: number): number {
  const ord = new Int32Array(n);
  for (let i = 0; i < n; i++) ord[i] = i;
  ord.sort((a, b) => dist[a]! - dist[b]!);
  let t = 0, b = 0, last = 0;
  for (let k = 0; k < n; k++) {
    const i = ord[k]!;
    t += tris[i]!; b += bytes[i]!;
    if (t > maxTris || b > maxBytes) return last;
    last = dist[i]!;
  }
  return Infinity;
}

export interface RadiusInput extends RadiusLimits {
  radius: number;
  tris: number;
  bytes: number;
  /** nothing left to build inside the radius */
  idle: boolean;
}

/**
 * Next view radius. Over budget -> `shrinkTo` (from radiusForBudget, with a 2% margin). Comfortably under budget
 * (<70%) and idle -> grow 12%. In between nothing changes: the dead band stops grow/shrink oscillation.
 */
export function nextRadius(i: RadiusInput, shrinkTo: number): number {
  const over = i.tris > i.maxTriangles || i.bytes > i.maxBytes;
  if (over) return Math.max(i.rMin, Math.min(i.radius, shrinkTo * 0.98));
  if (i.idle && i.tris < 0.7 * i.maxTriangles && i.bytes < 0.7 * i.maxBytes && i.radius < i.rMax) {
    return Math.min(i.rMax, i.radius * 1.12 + 1);
  }
  return i.radius;
}

/** Fog distances matching a view radius: groups at the radius are fully fogged, so nothing pops in visibly. */
export function fogRange(radius: number): { near: number; far: number } {
  return { near: radius * 0.45, far: radius * 0.97 };
}

/** Resident groups within `radius` of the player are all present (used to hold the loading screen / fade). */
export function nearReady(t: GroupTable, state: Uint8Array, px: number, py: number, pz: number, radius: number): { needed: number; have: number } {
  let needed = 0, have = 0;
  for (let g = 0; g < t.count; g++) {
    if (distToGroup(t, g, px, py, pz) > radius) continue;
    needed++;
    if (state[g] === RESIDENT) have++;
  }
  return { needed, have };
}
