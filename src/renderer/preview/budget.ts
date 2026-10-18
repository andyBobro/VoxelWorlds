/**
 * Pure, GPU-free policy for how much the preview may ask of WebGL, as a function of scene size.
 *
 * Why this exists: a multi-million-voxel city is tens of millions of triangles. Every chunk is uploaded to the GPU
 * and never evicted, plus a 4096^2 shadow map and an MSAA backbuffer. On a unified-memory Mac that can exhaust what
 * the GPU process is allowed to hold; the process is then lost and the NEXT `new WebGLRenderer()` fails with
 * "Error creating WebGL context" until memory is released. The budget keeps the peak bounded and the retry ladder
 * makes context creation survive a stressed GPU process.
 */

export interface RenderBudget {
  antialias: boolean;
  powerPreference: 'high-performance' | 'default';
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Hard cap for geometry bytes resident on the GPU; meshing stops (centre outwards) once exceeded. */
  maxGeometryBytes: number;
  /**
   * Triangle cap (frame-rate budget): measured ~0.58 ms/M triangles on an Apple GPU at DPR 1, so 42 M is about 40 FPS.
   * Meshing stops (centre outwards) once exceeded, like the byte cap.
   */
  maxTriangles: number;
}

/** Approx. GPU bytes per mesh vertex (Uint8 position, Int8 normal, Uint8 colour; each 3 -> padded to 4 on Metal). */
export const BYTES_PER_VERTEX = 12;
export const BYTES_PER_INDEX = 4;

const MB = 1024 * 1024;
export const MIN_GEOMETRY_BUDGET = 192 * MB;
/** Geometry cap for the detail scene: whatever the city has not used, but never less than this. */
export const MIN_DETAIL_BUDGET = 96 * MB;

/** Bytes the detail scene may use so city + detail together stay inside `cap`. */
export function detailGeometryBudget(cap: number, cityBytes: number): number {
  return Math.max(MIN_DETAIL_BUDGET, cap - cityBytes);
}

/** Scene-size tiers (voxel count of the source .vwg). */
export const MEDIUM_VOXELS = 8_000_000;
export const LARGE_VOXELS = 25_000_000;
export const HUGE_VOXELS = 60_000_000;

/**
 * Settings for a scene of `voxels` voxels. `degrade` (0 = none) is bumped by callers after a context loss or a
 * failed context creation so a remount asks for strictly less than the attempt that just failed.
 */
export function planBudget(voxels: number, degrade = 0): RenderBudget {
  const sizeTier = voxels >= HUGE_VOXELS ? 3 : voxels >= LARGE_VOXELS ? 2 : voxels >= MEDIUM_VOXELS ? 1 : 0;
  const d = Math.min(4, Math.max(0, Math.floor(degrade)));
  const tier = Math.min(4, sizeTier + d);
  // Geometry cap: base by scene size, then 35% less per degrade step regardless of tier (so small scenes shrink too).
  const geometry = Math.max(MIN_GEOMETRY_BUDGET, [1536 * MB, 1536 * MB, 1536 * MB, 1200 * MB][sizeTier]! * Math.pow(0.65, d));
  return {
    antialias: tier < 2,
    powerPreference: tier < 3 ? 'high-performance' : 'default',
    maxPixelRatio: tier === 0 ? 2 : tier === 1 ? 1.5 : 1,
    // The shadow pass re-draws every chunk (doubling draw calls) at a texel size too coarse to matter on a km-wide scene.
    shadows: tier < 2,
    shadowMapSize: tier === 0 ? 4096 : 2048,
    maxGeometryBytes: geometry,
    maxTriangles: [Infinity, Infinity, 42e6, 36e6, 24e6][tier]!,
  };
}

export interface RendererOptions {
  antialias: boolean;
  alpha: true;
  powerPreference: 'high-performance' | 'default';
  stencil: false;
  /** pixel ratio to apply after creation */
  pixelRatio: number;
  /** city scene shadows */
  shadows: boolean;
  /** shadows in the (small) building detail scene; only the last-resort rung turns these off */
  detailShadows: boolean;
  shadowMapSize: number;
}

/**
 * Ordered, progressively cheaper creation attempts, starting from `budget`.
 * Final rung: no AA, default power preference, DPR 1, no shadows.
 */
export function rendererAttempts(budget: RenderBudget, dpr: number): RendererOptions[] {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const first: RendererOptions = {
    antialias: budget.antialias, alpha: true, powerPreference: budget.powerPreference, stencil: false,
    pixelRatio: Math.min(d, budget.maxPixelRatio), shadows: budget.shadows, detailShadows: true, shadowMapSize: budget.shadowMapSize,
  };
  const out: RendererOptions[] = [first];
  const push = (o: Partial<RendererOptions>): void => {
    const prev = out[out.length - 1]!;
    const next = { ...prev, ...o };
    if (JSON.stringify(next) !== JSON.stringify(prev)) out.push(next);
  };
  push({ antialias: false });
  push({ powerPreference: 'default', pixelRatio: Math.min(first.pixelRatio, 1.25), shadowMapSize: Math.min(first.shadowMapSize, 1024) });
  push({ pixelRatio: 1, shadows: false, detailShadows: false });
  return out;
}

/** Voxel count from a .vwg buffer header without building anything; 0 if unreadable (the real parse reports errors). */
export function peekVoxelCount(buf: ArrayBuffer): number {
  try {
    if (buf.byteLength < 8) return 0;
    const dv = new DataView(buf);
    const len = dv.getUint32(4, true);
    if (8 + len > buf.byteLength) return 0;
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len))) as { voxelCount?: unknown };
    return typeof h.voxelCount === 'number' && h.voxelCount > 0 ? h.voxelCount : 0;
  } catch {
    return 0;
  }
}

/** Estimated GPU bytes of one chunk mesh. */
export function geometryBytes(vertexCount: number, indexCount: number, indexBytes: 2 | 4 = 4): number {
  return vertexCount * BYTES_PER_VERTEX + indexCount * indexBytes;
}

/** Human, actionable text for a preview failure. `voxelSize` in metres when known. */
export function friendlyPreviewError(raw: string, voxelSize?: number | null): string {
  const m = raw.replace(/^Error:\s*/, '');
  if (/WebGL|context/i.test(m)) {
    const hint = voxelSize && voxelSize > 0
      ? ` Generate a smaller area or use a larger voxel size (currently ${voxelSize} m; try ${+(voxelSize * 2).toFixed(2)} m).`
      : ' Generate a smaller area or use a larger voxel size.';
    return `${m}. The graphics process ran out of memory or was reset while showing a very large world.${hint} Then press "Reload preview".`;
  }
  return m;
}

/**
 * Render-budget degradation level shared by every remount of the preview. One incident (a context loss that is then
 * followed by a failed remount, say) raises it once: bumps within `INCIDENT_MS` of the last one are ignored. It decays
 * one level per `DECAY_MS` without incidents so a single transient loss does not pin the user to the cheapest tier.
 */
export class DegradeTracker {
  static readonly MAX = 3;
  static readonly INCIDENT_MS = 10_000;
  static readonly DECAY_MS = 5 * 60_000;
  private lvl = 0;
  private decayAt = 0;
  private lastBump: number | null = null;

  level(now = Date.now()): number {
    if (this.lvl > 0) {
      const steps = Math.floor((now - this.decayAt) / DegradeTracker.DECAY_MS);
      if (steps > 0) {
        this.lvl = Math.max(0, this.lvl - steps);
        this.decayAt += steps * DegradeTracker.DECAY_MS;
      }
    }
    return this.lvl;
  }

  /** Records an incident; returns the new level. */
  bump(now = Date.now()): number {
    const cur = this.level(now);
    if (this.lastBump !== null && now - this.lastBump < DegradeTracker.INCIDENT_MS) return cur; // same incident
    this.lvl = Math.min(DegradeTracker.MAX, cur + 1);
    this.lastBump = now;
    this.decayAt = now;
    return this.lvl;
  }

  reset(): void {
    this.lvl = 0;
    this.decayAt = 0;
    this.lastBump = null;
  }
}

/** Allows at most `max` automatic recoveries per `windowMs`. */
export class RemountLimiter {
  private stamps: number[] = [];
  constructor(private readonly max = 2, private readonly windowMs = 60_000) {}
  tryAcquire(now = Date.now()): boolean {
    while (this.stamps.length && now - this.stamps[0]! > this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
}
