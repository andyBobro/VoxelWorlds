import { CS, P } from './mesher';

/** Voxels bucketed by 32^3 chunk using a counting sort (no per-voxel objects). */
export interface ChunkIndex {
  min: [number, number, number]; // voxel coords of chunk grid origin
  max: [number, number, number]; // exclusive voxel bounds of data
  dims: [number, number, number]; // chunk grid size
  starts: Int32Array; // dims product + 1, offsets into `order`
  order: Uint32Array; // voxel indices grouped by chunk; within a chunk, boundary-layer voxels come first
  /** per chunk: number of leading `order` entries on the chunk's outer 1-voxel layer (local coord 0 or CS-1 on any axis) */
  shell: Int32Array;
  /** nonempty chunk ids sorted by distance from the data centre */
  chunkIds: Uint32Array;
}

export function buildChunkIndex(x: Int32Array, y: Int32Array, z: Int32Array): ChunkIndex {
  const n = x.length;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = x[i]!, b = y[i]!, c = z[i]!;
    if (a < x0) x0 = a;
    if (a > x1) x1 = a;
    if (b < y0) y0 = b;
    if (b > y1) y1 = b;
    if (c < z0) z0 = c;
    if (c > z1) z1 = c;
  }
  if (n === 0) x0 = y0 = z0 = x1 = y1 = z1 = 0;
  const dx = Math.floor((x1 - x0) / CS) + 1;
  const dy = Math.floor((y1 - y0) / CS) + 1;
  const dz = Math.floor((z1 - z0) / CS) + 1;
  const total = dx * dy * dz;
  const starts = new Int32Array(total + 1);
  const keyOf = (i: number): number =>
    (((y[i]! - y0) >> 5) * dz + ((z[i]! - z0) >> 5)) * dx + ((x[i]! - x0) >> 5);

  for (let i = 0; i < n; i++) starts[keyOf(i) + 1]!++;
  for (let k = 0; k < total; k++) starts[k + 1]! += starts[k]!;
  const cursor = starts.slice(0, total);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) { const kk = keyOf(i); order[cursor[kk]!] = i; cursor[kk]!++; }

  // partition each chunk so its outer-layer voxels (the only ones a neighbour's padded grid can need) lead
  const shell = new Int32Array(total);
  const onShell = (i: number): boolean => {
    const lx = (x[i]! - x0) & 31, ly = (y[i]! - y0) & 31, lz = (z[i]! - z0) & 31;
    return lx === 0 || lx === 31 || ly === 0 || ly === 31 || lz === 0 || lz === 31;
  };
  for (let k = 0; k < total; k++) {
    let lo = starts[k]!, hi = starts[k + 1]! - 1;
    while (lo <= hi) {
      if (onShell(order[lo]!)) lo++;
      else { const t = order[lo]!; order[lo] = order[hi]!; order[hi] = t; hi--; }
    }
    shell[k] = lo - starts[k]!;
  }

  let nonEmpty = 0;
  for (let k = 0; k < total; k++) if (starts[k + 1]! > starts[k]!) nonEmpty++;
  const ids = new Uint32Array(nonEmpty);
  const dist = new Float64Array(nonEmpty);
  let j = 0;
  for (let k = 0; k < total; k++) {
    if (starts[k + 1]! === starts[k]!) continue;
    const cx = k % dx, cz = Math.floor(k / dx) % dz, cy = Math.floor(k / (dx * dz));
    const ex = cx - (dx - 1) / 2, ey = cy - (dy - 1) / 2, ez = cz - (dz - 1) / 2;
    ids[j] = k;
    dist[j++] = ex * ex + ey * ey * 4 + ez * ez;
  }
  const perm = Array.from(ids.keys()).sort((a, b) => dist[a]! - dist[b]!);
  const sorted = new Uint32Array(nonEmpty);
  for (let i = 0; i < nonEmpty; i++) sorted[i] = ids[perm[i]!]!;

  return {
    min: [x0, y0, z0],
    max: [x1 + 1, y1 + 1, z1 + 1],
    dims: [dx, dy, dz],
    starts,
    order,
    shell,
    chunkIds: sorted,
  };
}

export function chunkCoords(idx: ChunkIndex, id: number): [number, number, number] {
  const [dx, dy, dz] = idx.dims;
  void dy;
  return [id % dx, Math.floor(id / (dx * dz)), Math.floor(id / dx) % dz];
}

/**
 * Fill the padded grid for chunk `id`: own voxels plus the one-voxel shell
 * contributed by the six face neighbours.
 */
export function fillChunkGrid(
  idx: ChunkIndex,
  x: Int32Array, y: Int32Array, z: Int32Array, c: Uint16Array,
  id: number, grid: Uint16Array,
): void {
  grid.fill(0);
  const [dx, dy, dz] = idx.dims;
  const [cx, cy, cz] = chunkCoords(idx, id);
  const ox = idx.min[0] + cx * CS, oy = idx.min[1] + cy * CS, oz = idx.min[2] + cz * CS;
  const PP = P * P;

  let s = idx.starts[id]!, e = idx.starts[id + 1]!;
  for (let k = s; k < e; k++) {
    const i = idx.order[k]!;
    grid[x[i]! - ox + 1 + (z[i]! - oz + 1) * P + (y[i]! - oy + 1) * PP] = c[i]!;
  }

  // neighbour shells: every one of the 26 surrounding chunks contributes the voxels inside the 1-voxel border
  // (faces, edges and corners; AO samples diagonal neighbours).
  for (let ddx = -1; ddx <= 1; ddx++) {
    for (let ddy = -1; ddy <= 1; ddy++) {
      for (let ddz = -1; ddz <= 1; ddz++) {
        if (ddx === 0 && ddy === 0 && ddz === 0) continue;
        const ncx = cx + ddx, ncy = cy + ddy, ncz = cz + ddz;
        if (ncx < 0 || ncy < 0 || ncz < 0 || ncx >= dx || ncy >= dy || ncz >= dz) continue;
        const nid = (ncy * dz + ncz) * dx + ncx;
        s = idx.starts[nid]!;
        e = s + idx.shell[nid]!;
        for (let k = s; k < e; k++) {
          const i = idx.order[k]!;
          const gx = x[i]! - ox + 1, gy = y[i]! - oy + 1, gz = z[i]! - oz + 1;
          if (gx < 0 || gx >= P || gy < 0 || gy >= P || gz < 0 || gz >= P) continue;
          grid[gx + gz * P + gy * PP] = c[i]!;
        }
      }
    }
  }
}
