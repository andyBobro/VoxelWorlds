/**
 * Walking-demo render budget, derived from the preview's planBudget (AA / pixel ratio / power tiers by scene size)
 * but with its own, tighter geometry caps: the walker only keeps the area around the player resident, so the budget is
 * about frame time (triangles) and a bounded GPU footprint, not about fitting the whole world.
 *
 * Measured on an Apple GPU at DPR 1: ~0.58 ms per million triangles. 12 M triangles is ~7 ms of GPU time, which leaves
 * room for 60 FPS on a mid-range integrated GPU; the view radius shrinks (fog closes in) before this is exceeded.
 */
import { planBudget, type RenderBudget } from '../preview/budget';

const MB = 1024 * 1024;

export interface WalkBudget {
  render: RenderBudget;
  /** resident triangle cap */
  maxTriangles: number;
  /** resident GPU geometry cap, bytes */
  maxGeometryBytes: number;
  /** view radius limits, metres */
  rMin: number;
  rMax: number;
  /** meshing time per frame, ms */
  sliceMs: number;
  ao: boolean;
}

/** `voxels`: source .vwg voxel count; `span`: metres per super-chunk edge; `degrade`: context-loss escalation level. */
export function planWalkBudget(voxels: number, span: number, degrade = 0): WalkBudget {
  const render = planBudget(voxels, degrade);
  const d = Math.min(4, Math.max(0, degrade));
  const f = Math.pow(0.65, d);
  const rMax = Math.max(120, (voxels >= 25_000_000 ? 650 : 900) * Math.pow(0.8, d));
  return {
    render,
    maxTriangles: Math.min(render.maxTriangles, 12e6 * f),
    maxGeometryBytes: Math.min(render.maxGeometryBytes, 384 * MB * f),
    rMin: Math.min(rMax, Math.max(80, span * 1.25)),
    rMax,
    sliceMs: 4,
    ao: true,
  };
}

/** Budget for the building interior scene: small and fully fogged beyond ~90 m. */
export function planDetailBudget(base: WalkBudget): WalkBudget {
  return {
    ...base,
    maxTriangles: Math.min(base.maxTriangles, 8e6),
    maxGeometryBytes: Math.min(base.maxGeometryBytes, 256 * MB),
    rMin: 40,
    rMax: 90,
    sliceMs: 8,
    ao: true,
  };
}
