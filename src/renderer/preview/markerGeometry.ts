import type { BuildingInfo } from '../../shared/contract';

export interface MarkerGeometry {
  /** line segment endpoint pairs (xyz, metres): roof outline + pin stem */
  lines: Float32Array;
  /** pin head positions (xyz, metres), one per building */
  pins: Float32Array;
  count: number;
}

/** Pin stem height in voxels is derived from building height so pins clear neighbours but stay readable. */
export function pinHeightM(heightM: number, voxelSize: number): number {
  return Math.max(voxelSize * 3, Math.min(30, heightM * 0.6 + 4 * voxelSize));
}

/**
 * Pure: one roof outline (slightly above the roof) plus a vertical stem and a pin head at the footprint centroid
 * per building. All markers share one LineSegments + one Points draw call.
 */
export function buildMarkerGeometry(buildings: readonly BuildingInfo[], voxelSize: number): MarkerGeometry {
  let segs = 0;
  const usable = buildings.filter((b) => b.footprint.length >= 3);
  for (const b of usable) segs += b.footprint.length + 1;
  const lines = new Float32Array(segs * 6);
  const pins = new Float32Array(usable.length * 3);
  let li = 0, pi = 0;
  for (const b of usable) {
    const n = b.footprint.length;
    const y = b.topY * voxelSize + voxelSize * 0.15;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const a = b.footprint[i]!, c = b.footprint[(i + 1) % n]!;
      lines[li++] = a[0] * voxelSize; lines[li++] = y; lines[li++] = a[1] * voxelSize;
      lines[li++] = c[0] * voxelSize; lines[li++] = y; lines[li++] = c[1] * voxelSize;
      cx += a[0]; cz += a[1];
    }
    cx = (cx / n) * voxelSize; cz = (cz / n) * voxelSize;
    const top = y + pinHeightM(b.heightM, voxelSize);
    lines[li++] = cx; lines[li++] = y; lines[li++] = cz;
    lines[li++] = cx; lines[li++] = top; lines[li++] = cz;
    pins[pi++] = cx; pins[pi++] = top; pins[pi++] = cz;
  }
  return { lines, pins, count: usable.length };
}

/** Voxel-grid centre + radius of a building's footprint box (for camera focus). */
export function buildingFocus(b: BuildingInfo): { cx: number; cy: number; cz: number; radius: number } {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of b.footprint) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const dx = x1 - x0, dz = z1 - z0, dy = b.topY - b.baseY;
  return { cx: (x0 + x1) / 2, cy: (b.baseY + b.topY) / 2, cz: (z0 + z1) / 2, radius: Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2) };
}
