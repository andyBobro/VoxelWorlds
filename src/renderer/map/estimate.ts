import type { BBox } from '../../shared/contract';

export interface BBoxEstimate {
  widthM: number;
  heightM: number;
  areaKm2: number;
  columns: number;
  /** ground layer (one voxel per column) */
  groundVoxels: number;
  /** approximate total (calibrated ~3.5 voxels per ground column) */
  voxels: number;
  /** tiles the bbox splits into for the given tile size (>= 1) */
  tilesX: number;
  tilesY: number;
  tileCount: number;
  /** largest extent in voxels along any horizontal axis */
  maxAxisVoxels: number;
}

/** Voxel grid indices are int32; leave a little headroom. */
export const INT32_AXIS_LIMIT = 2e9;
/** Flattened (x,z) column index limit (2^31). */
export const INT32_FLAT_LIMIT = 2 ** 31;

// Calibrated on measured runs (2 m: 12.1k columns -> 40.5k voxels; 0.5 m: 194k -> 704k):
// total voxels are roughly 3.5x the ground columns (ground + building shells + roads).
const VOXELS_PER_COLUMN = 3.5;

export function estimateBBox(b: BBox, voxelSize: number, tileSize = 500): BBoxEstimate {
  const midLat = ((b.latMin + b.latMax) / 2) * (Math.PI / 180);
  const widthM = (b.lonMax - b.lonMin) * 111_320 * Math.cos(midLat);
  const heightM = (b.latMax - b.latMin) * 110_574;
  const columns = (widthM / voxelSize) * (heightM / voxelSize);
  const tilesX = Math.max(1, Math.ceil(widthM / tileSize - 1e-9));
  const tilesY = Math.max(1, Math.ceil(heightM / tileSize - 1e-9));
  return {
    widthM,
    heightM,
    areaKm2: (widthM * heightM) / 1e6,
    columns,
    groundVoxels: columns,
    voxels: columns * VOXELS_PER_COLUMN,
    tilesX,
    tilesY,
    tileCount: tilesX * tilesY,
    maxAxisVoxels: Math.max(widthM, heightM) / voxelSize,
  };
}

export function fmtCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
