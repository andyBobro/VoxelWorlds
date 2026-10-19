/**
 * Compact, chunked voxel store for the walking demo. No Three.js, no DOM.
 *
 * The source .vwg is 14 bytes/voxel (x,y,z as Int32 + Uint16 colour). A 58M-voxel world is 815 MB, which we do not want
 * to keep resident next to GPU geometry. This store re-buckets the voxels into 32^3 chunks (counting sort) and keeps
 * 4 bytes/voxel: a packed local position (lx | lz << 5 | ly << 10, 15 bits) and the palette index. The caller drops the
 * original buffer afterwards.
 *
 * Two consumers:
 *  - collision: `cell(ix,iy,iz)` is O(1): chunk id arithmetic + a small LRU of dense 32^3 Uint16 arrays (built lazily
 *    from the chunk's compact list the first time the player is near it).
 *  - meshing: `fillPadded(chunkId, grid)` fills the (CS+2)^3 padded grid GreedyMesher expects, identical to the
 *    preview's `fillChunkGrid` (the unit test compares both).
 */
import type { VwgData } from '../../shared/vwg';
import { CS, P } from '../preview/mesher';

const SHIFT = 5; // log2(CS)
const MASK = CS - 1;
const DENSE = CS * CS * CS;
const ZERO = new Uint16Array(DENSE);
const DENSE_CACHE_MAX = 96;

export class ChunkStore {
  /** voxel size, metres */
  readonly vs: number;
  /** voxel index of the chunk grid origin */
  readonly min: [number, number, number];
  /** exclusive voxel bounds of the data */
  readonly max: [number, number, number];
  readonly dims: [number, number, number];
  readonly voxels: number;

  private memoId = -1;
  private memo: Uint16Array = ZERO;
  private readonly cache = new Map<number, Uint16Array>();
  private readonly pool: Uint16Array[] = [];

  constructor(
    vs: number,
    min: [number, number, number], max: [number, number, number], dims: [number, number, number],
    /** chunks+1 offsets into pos/col */
    readonly starts: Int32Array,
    /** packed local position per voxel */
    readonly pos: Uint16Array,
    readonly col: Uint16Array,
    /** per chunk: number of leading entries lying on the chunk's outer 1-voxel layer */
    readonly shell: Int32Array,
    /** linear-RGB bytes, 3 per palette entry */
    readonly palette: Uint8Array,
    /** palette index -> material tag (may be empty) */
    readonly materials: ReadonlyArray<string>,
  ) {
    this.vs = vs; this.min = min; this.max = max; this.dims = dims;
    this.voxels = pos.length;
  }

  chunkId(cx: number, cy: number, cz: number): number {
    return (cy * this.dims[2] + cz) * this.dims[0] + cx;
  }

  chunkCoords(id: number): [number, number, number] {
    const [dx, , dz] = this.dims;
    return [id % dx, Math.floor(id / (dx * dz)), Math.floor(id / dx) % dz];
  }

  isEmptyChunk(id: number): boolean {
    return this.starts[id + 1]! === this.starts[id]!;
  }

  /** Palette index at a voxel (0 = air; also 0 outside the data bounds). O(1). */
  cell(ix: number, iy: number, iz: number): number {
    const lx = ix - this.min[0], ly = iy - this.min[1], lz = iz - this.min[2];
    if (lx < 0 || ly < 0 || lz < 0 || ix >= this.max[0] || iy >= this.max[1] || iz >= this.max[2]) return 0;
    const id = ((ly >> SHIFT) * this.dims[2] + (lz >> SHIFT)) * this.dims[0] + (lx >> SHIFT);
    if (id !== this.memoId) { this.memo = this.denseFor(id); this.memoId = id; }
    return this.memo[(lx & MASK) | ((lz & MASK) << SHIFT) | ((ly & MASK) << (2 * SHIFT))]!;
  }

  /** Voxel y of the highest non-air voxel in column (ix, iz), or -Infinity. Skips empty chunks 32 at a time. */
  topSolid(ix: number, iz: number): number {
    const lx = ix - this.min[0], lz = iz - this.min[2];
    if (lx < 0 || lz < 0 || ix >= this.max[0] || iz >= this.max[2]) return -Infinity;
    const cx = lx >> SHIFT, cz = lz >> SHIFT;
    for (let cy = this.dims[1] - 1; cy >= 0; cy--) {
      const id = this.chunkId(cx, cy, cz);
      if (this.isEmptyChunk(id)) continue;
      const d = this.denseFor(id);
      const base = (lx & MASK) | ((lz & MASK) << SHIFT);
      for (let l = MASK; l >= 0; l--) if (d[base | (l << (2 * SHIFT))] !== 0) return this.min[1] + cy * CS + l;
    }
    return -Infinity;
  }

  private denseFor(id: number): Uint16Array {
    const s = this.starts[id]!, e = this.starts[id + 1]!;
    if (s === e) return ZERO;
    const hit = this.cache.get(id);
    if (hit) {
      // LRU: a hit moves the entry to the back of the Map's insertion order (the front is evicted first)
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    let arr: Uint16Array;
    if (this.cache.size >= DENSE_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as number;
      arr = this.cache.get(oldest)!;
      this.cache.delete(oldest);
      if (this.memoId === oldest) this.memoId = -1;
      arr.fill(0);
    } else arr = this.pool.pop() ?? new Uint16Array(DENSE);
    const { pos, col } = this;
    for (let k = s; k < e; k++) arr[pos[k]!] = col[k]!;
    this.cache.set(id, arr);
    return arr;
  }

  /**
   * Fills the padded (CS+2)^3 grid for chunk `id`: its own voxels plus the one-voxel shell of the 26 neighbours
   * (index = (x+1) + (z+1)*P + (y+1)*P*P). Same output as preview/chunking.ts fillChunkGrid.
   */
  fillPadded(id: number, grid: Uint16Array): void {
    grid.fill(0);
    const [dx, dy, dz] = this.dims;
    const [cx, cy, cz] = this.chunkCoords(id);
    const PP = P * P;
    const { pos, col, starts } = this;

    for (let k = starts[id]!, e = starts[id + 1]!; k < e; k++) {
      const p = pos[k]!;
      grid[(p & MASK) + 1 + (((p >> SHIFT) & MASK) + 1) * P + ((p >> (2 * SHIFT)) + 1) * PP] = col[k]!;
    }
    for (let ddx = -1; ddx <= 1; ddx++) {
      const ncx = cx + ddx;
      if (ncx < 0 || ncx >= dx) continue;
      for (let ddy = -1; ddy <= 1; ddy++) {
        const ncy = cy + ddy;
        if (ncy < 0 || ncy >= dy) continue;
        for (let ddz = -1; ddz <= 1; ddz++) {
          if (ddx === 0 && ddy === 0 && ddz === 0) continue;
          const ncz = cz + ddz;
          if (ncz < 0 || ncz >= dz) continue;
          const nid = (ncy * dz + ncz) * dx + ncx;
          const s = starts[nid]!, e = s + this.shell[nid]!;
          const ox = ddx * CS + 1, oy = ddy * CS + 1, oz = ddz * CS + 1;
          for (let k = s; k < e; k++) {
            const p = pos[k]!;
            const gx = (p & MASK) + ox, gz = ((p >> SHIFT) & MASK) + oz, gy = (p >> (2 * SHIFT)) + oy;
            if (gx < 0 || gx >= P || gy < 0 || gy >= P || gz < 0 || gz >= P) continue;
            grid[gx + gz * P + gy * PP] = col[k]!;
          }
        }
      }
    }
  }

  /** Releases the dense cache (collision data is rebuilt lazily). */
  dropCaches(): void {
    this.cache.clear();
    this.pool.length = 0;
    this.memoId = -1;
    this.memo = ZERO;
  }
}

/** sRGB 0..255 palette -> linear RGB bytes (same as preview/mesher buildLinearPalette; kept local so tests need no mesher). */
export { buildLinearPalette } from '../preview/mesher';

/**
 * Generator form of the store builder: yields the progress (0..1) every `slice` voxels so a caller can hand control
 * back to the UI. Returns the store. Three passes over the voxels: bounds, count, scatter.
 */
export function* buildChunkStoreSteps(
  data: VwgData, palette: Uint8Array, slice = 1 << 20,
): Generator<number, ChunkStore, void> {
  const { x, y, z, c } = data;
  const n = x.length;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i0 = 0; i0 < n; i0 += slice) {
    const iEnd = Math.min(n, i0 + slice);
    for (let i = i0; i < iEnd; i++) {
      const a = x[i]!, b = y[i]!, d = z[i]!;
      if (a < x0) x0 = a;
      if (a > x1) x1 = a;
      if (b < y0) y0 = b;
      if (b > y1) y1 = b;
      if (d < z0) z0 = d;
      if (d > z1) z1 = d;
    }
    yield (i0 / n) * 0.2;
  }
  if (n === 0) x0 = y0 = z0 = x1 = y1 = z1 = 0;
  const dx = ((x1 - x0) >> SHIFT) + 1, dy = ((y1 - y0) >> SHIFT) + 1, dz = ((z1 - z0) >> SHIFT) + 1;
  const total = dx * dy * dz;
  if (!(total > 0) || total > 0x7fffffff) throw new Error(`VWG: chunk grid too large (${dx} x ${dy} x ${dz})`);
  const starts = new Int32Array(total + 1);
  const shell = new Int32Array(total);

  for (let i0 = 0; i0 < n; i0 += slice) {
    const iEnd = Math.min(n, i0 + slice);
    for (let i = i0; i < iEnd; i++) {
      const lx = x[i]! - x0, ly = y[i]! - y0, lz = z[i]! - z0;
      const k = ((ly >> SHIFT) * dz + (lz >> SHIFT)) * dx + (lx >> SHIFT);
      starts[k + 1]!++;
      const ax = lx & MASK, ay = ly & MASK, az = lz & MASK;
      if (ax === 0 || ax === MASK || ay === 0 || ay === MASK || az === 0 || az === MASK) shell[k]!++;
    }
    yield 0.2 + (i0 / n) * 0.3;
  }
  for (let k = 0; k < total; k++) starts[k + 1]! += starts[k]!;
  const sCur = starts.slice(0, total);
  const iCur = new Int32Array(total);
  for (let k = 0; k < total; k++) iCur[k] = starts[k]! + shell[k]!;
  const pos = new Uint16Array(n);
  const col = new Uint16Array(n);
  for (let i0 = 0; i0 < n; i0 += slice) {
    const iEnd = Math.min(n, i0 + slice);
    for (let i = i0; i < iEnd; i++) {
      const lx = x[i]! - x0, ly = y[i]! - y0, lz = z[i]! - z0;
      const k = ((ly >> SHIFT) * dz + (lz >> SHIFT)) * dx + (lx >> SHIFT);
      const ax = lx & MASK, ay = ly & MASK, az = lz & MASK;
      const slot = (ax === 0 || ax === MASK || ay === 0 || ay === MASK || az === 0 || az === MASK) ? sCur[k]!++ : iCur[k]!++;
      pos[slot] = ax | (az << SHIFT) | (ay << (2 * SHIFT));
      col[slot] = c[i]!;
    }
    yield 0.5 + (i0 / n) * 0.5;
  }
  const mats = data.header.materials ?? [];
  return new ChunkStore(
    data.header.voxelSize, [x0, y0, z0], [x1 + 1, y1 + 1, z1 + 1], [dx, dy, dz],
    starts, pos, col, shell, palette, mats,
  );
}

/** Synchronous build (tests, small detail scenes). */
export function buildChunkStore(data: VwgData, palette: Uint8Array): ChunkStore {
  const g = buildChunkStoreSteps(data, palette, 1 << 22);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Async build that yields to the event loop between slices; `onProgress` gets 0..1. */
export async function buildChunkStoreAsync(
  data: VwgData, palette: Uint8Array, onProgress?: (f: number) => void, yieldFn: () => Promise<void> = yieldToUi,
): Promise<ChunkStore> {
  const g = buildChunkStoreSteps(data, palette);
  let t = performance.now();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (performance.now() - t > 40) {
      onProgress?.(r.value);
      await yieldFn();
      t = performance.now();
    }
  }
}

export const yieldToUi = (): Promise<void> => new Promise((res) => setTimeout(res, 0));
