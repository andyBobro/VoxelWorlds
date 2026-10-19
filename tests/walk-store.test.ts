import { describe, expect, it } from 'vitest';
import type { VwgData } from '../src/shared/vwg';
import { buildChunkIndex, fillChunkGrid } from '../src/renderer/preview/chunking';
import { GRID_SIZE } from '../src/renderer/preview/mesher';
import { buildChunkStore } from '../src/renderer/walk/chunkStore';
import { buildGroupTable, StreamPlanner, RESIDENT, ABSENT, nextRadius, radiusForBudget, loadScore } from '../src/renderer/walk/streaming';
import { findSpawn, snapDoorCell } from '../src/renderer/walk/spawn';
import { Mover, scaleFromCityVoxel } from '../src/renderer/walk/physics';

function randomData(n: number, seed = 1): VwgData {
  let s = seed;
  const r = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const x = new Int32Array(n), y = new Int32Array(n), z = new Int32Array(n), c = new Uint16Array(n);
  const seen = new Set<string>();
  let k = 0;
  while (k < n) {
    const a = Math.floor(r() * 150) - 20, b = Math.floor(r() * 70), d = Math.floor(r() * 140) + 5;
    const key = `${a},${b},${d}`;
    if (seen.has(key)) continue; // duplicates would make the colour order-dependent
    seen.add(key);
    x[k] = a; y[k] = b; z[k] = d; c[k] = 1 + Math.floor(r() * 3); k++;
  }
  const header = { version: 1, voxelSize: 0.5, voxelCount: n, palette: [[0, 0, 0], [1, 2, 3], [4, 5, 6], [7, 8, 9]] } as unknown as VwgData['header'];
  return { header, x, y, z, c };
}
const pal = new Uint8Array(12);

describe('ChunkStore', () => {
  const d = randomData(20000);
  const store = buildChunkStore(d, pal);
  const idx = buildChunkIndex(d.x, d.y, d.z);
  const ref = new Map<string, number>();
  for (let i = 0; i < d.x.length; i++) ref.set(`${d.x[i]},${d.y[i]},${d.z[i]}`, d.c[i]!);

  it('keeps 4 bytes per voxel and the same bounds as the preview index', () => {
    expect(store.voxels).toBe(d.x.length);
    expect(store.min).toEqual(idx.min);
    expect(store.max).toEqual(idx.max);
    expect(store.dims).toEqual(idx.dims);
  });

  it('cell() agrees with the source at every voxel and is air elsewhere', () => {
    let seen = 0;
    for (const [k, v] of ref) { const [a, b, c] = k.split(',').map(Number) as [number, number, number]; expect(store.cell(a, b, c)).toBe(v); seen++; }
    expect(seen).toBe(ref.size);
    for (let i = 0; i < 3000; i++) {
      const a = (i * 7) % 190 - 30, b = (i * 13) % 90 - 10, c = (i * 31) % 170 - 5;
      if (!ref.has(`${a},${b},${c}`)) expect(store.cell(a, b, c)).toBe(0);
    }
  });

  it('fills the padded mesher grid exactly like the preview path', () => {
    const g1 = new Uint16Array(GRID_SIZE), g2 = new Uint16Array(GRID_SIZE);
    for (let id = 0; id < idx.starts.length - 1; id++) {
      if (idx.starts[id + 1] === idx.starts[id]) continue;
      fillChunkGrid(idx, d.x, d.y, d.z, d.c, id, g1);
      store.fillPadded(id, g2);
      expect(g2).toEqual(g1);
    }
  });

  it('dense cache is LRU: a chunk touched again survives eviction pressure, the oldest untouched one is evicted', () => {
    const n = 14 * 14;
    const x = new Int32Array(n), y = new Int32Array(n).fill(3), z = new Int32Array(n), c = new Uint16Array(n).fill(1);
    for (let i = 0; i < n; i++) { x[i] = (i % 14) * 32 + 5; z[i] = Math.floor(i / 14) * 32 + 5; }
    const header = { version: 1, voxelSize: 1, voxelCount: n, palette: [[0, 0, 0], [1, 1, 1]] } as unknown as VwgData['header'];
    const st = buildChunkStore({ header, x, y, z, c }, pal);
    const priv = st as unknown as { cache: Map<number, unknown>; denseFor(id: number): unknown };
    const nonEmpty: number[] = [];
    for (let id = 0; id < st.starts.length - 1; id++) if (!st.isEmptyChunk(id)) nonEmpty.push(id);
    expect(nonEmpty.length).toBeGreaterThan(110);
    const [first, second, ...rest] = nonEmpty;
    priv.denseFor(first!); priv.denseFor(second!);
    for (const id of rest.slice(0, 100)) { priv.denseFor(first!); priv.denseFor(id); } // `first` is hot, `second` is not
    expect(priv.cache.size).toBeLessThanOrEqual(96);
    expect(priv.cache.has(first!)).toBe(true);
    expect(priv.cache.has(second!)).toBe(false);
  });

  it('topSolid finds the highest voxel of a column', () => {
    for (const [a, c] of [[10, 20], [50, 100], [-5, 60]] as const) {
      let top = -Infinity;
      for (let y = 0; y < 70; y++) if (ref.has(`${a},${y},${c}`)) top = y;
      expect(store.topSolid(a, c)).toBe(top);
    }
  });
});

describe('streaming selection', () => {
  // flat 20 x 20 super-chunk plate of 1 m voxels (span 128 m)
  const n = 20 * 20;
  const x = new Int32Array(n), y = new Int32Array(n), z = new Int32Array(n), c = new Uint16Array(n).fill(1);
  for (let i = 0; i < n; i++) { x[i] = (i % 20) * 128 + 3; z[i] = Math.floor(i / 20) * 128 + 3; y[i] = 1; }
  const header = { version: 1, voxelSize: 1, voxelCount: n, palette: [[0, 0, 0], [1, 1, 1]] } as unknown as VwgData['header'];
  const store = buildChunkStore({ header, x, y, z, c }, pal);
  const t = buildGroupTable(store);
  const planner = new StreamPlanner(t);
  const state = new Uint8Array(t.count);

  it('loads only groups within the radius, nearest first, and none beyond', () => {
    const p = planner.run(state, 1280, 1, 1280, 1, 0, 300, 100);
    expect(p.loadCount).toBeGreaterThan(0);
    const ids = Array.from(p.load.subarray(0, p.loadCount));
    for (const g of ids) {
      const dx = Math.max(t.minX[g]! - 1280, 0, 1280 - t.maxX[g]!), dz = Math.max(t.minZ[g]! - 1280, 0, 1280 - t.maxZ[g]!);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(300);
    }
    expect(ids.length).toBeLessThan(t.count);
  });

  it('prefers groups in the view direction at equal distance', () => {
    const near = 200;
    expect(loadScore(near, 128, 200, 0, 1, 0)).toBeLessThan(loadScore(near, 128, -200, 0, 1, 0));
    expect(loadScore(50, 128, -50, 0, 1, 0)).toBeLessThan(loadScore(near, 128, 200, 0, 1, 0)); // close ground first
  });

  it('keeps groups inside the hysteresis band and drops those beyond it', () => {
    state.fill(RESIDENT);
    const p = planner.run(state, 1280, 1, 1280, 1, 0, 300, 200);
    const dropped = new Set(Array.from(p.unload.subarray(0, p.unloadCount)));
    for (let g = 0; g < t.count; g++) {
      const dx = Math.max(t.minX[g]! - 1280, 0, 1280 - t.maxX[g]!), dz = Math.max(t.minZ[g]! - 1280, 0, 1280 - t.maxZ[g]!);
      const d = Math.hypot(dx, dz);
      expect(dropped.has(g)).toBe(d > 500);
    }
    state.fill(ABSENT);
  });

  it('radius shrinks to fit the triangle budget and grows only with headroom', () => {
    const dist = [10, 20, 30, 40], tris = [4, 4, 4, 4], bytes = [1, 1, 1, 1];
    expect(radiusForBudget(dist, tris, bytes, 4, 9, 100)).toBe(20);
    expect(radiusForBudget(dist, tris, bytes, 4, 100, 100)).toBe(Infinity);
    const lim = { rMin: 50, rMax: 800, maxTriangles: 10, maxBytes: 100 };
    expect(nextRadius({ ...lim, radius: 400, tris: 12, bytes: 5, idle: true }, 250)).toBeCloseTo(245);
    expect(nextRadius({ ...lim, radius: 400, tris: 12, bytes: 5, idle: true }, 10)).toBe(50); // never below rMin
    expect(nextRadius({ ...lim, radius: 400, tris: 8, bytes: 5, idle: true }, Infinity)).toBe(400); // dead band
    expect(nextRadius({ ...lim, radius: 400, tris: 3, bytes: 5, idle: false }, Infinity)).toBe(400); // still building
    expect(nextRadius({ ...lim, radius: 400, tris: 3, bytes: 5, idle: true }, Infinity)).toBeGreaterThan(400);
    expect(nextRadius({ ...lim, radius: 790, tris: 3, bytes: 5, idle: true }, Infinity)).toBe(800);
  });
});

describe('spawn rule', () => {
  // ground (material 1 'ground') at y=0; a building block (material 2 'wall', y 0..9, x 0..9) with a roof
  const materials = ['', 'ground', 'wall'];
  const world = {
    vs: 1, min: [-40, 0, -40] as [number, number, number], max: [40, 20, 40] as [number, number, number], materials,
    cell: (x: number, y: number, z: number) => (x < -40 || x >= 40 || z < -40 || z >= 40 ? 0 : x >= 0 && x < 10 && z >= 0 && z < 10 && y < 10 ? 2 : y === 0 ? 1 : 0),
    topSolid: (x: number, z: number) => (x >= 0 && x < 10 && z >= 0 && z < 10 ? 9 : 0),
  };
  const mover = new Mover(world, scaleFromCityVoxel(1));
  const fits = (x: number, y: number, z: number): boolean => { mover.p.set([x, y, z]); return !mover.overlaps(); };

  it('uses the requested column when it is open ground', () => {
    const s = findSpawn(world, 20, 20, fits);
    expect(s.how).toBe('requested');
    expect(s.y).toBeCloseTo(1.001, 3);
  });
  it('never puts the player on a roof or in a building: moves to the nearest open ground', () => {
    const s = findSpawn(world, 5, 5, fits);
    expect(s.how).toBe('nearby');
    expect(s.y).toBeCloseTo(1.001, 3);
    expect(s.x < 0 || s.x > 10 || s.z < 0 || s.z > 10).toBe(true);
    expect(s.movedM).toBeGreaterThan(0);
  });
});

describe('door ground snapping and spawn fallbacks', () => {
  const materials = ['', 'ground', 'wall', 'vegetation'];
  // ground at y=0 (voxel 0), a tree canopy over x 20..24 at y 6, a pit-free map x,z in [0,60)
  const mk = (extra: (x: number, y: number, z: number) => number) => ({
    vs: 0.5, min: [0, 0, 0] as [number, number, number], max: [60, 40, 60] as [number, number, number], materials,
    cell: (x: number, y: number, z: number) => (x < 0 || x >= 60 || z < 0 || z >= 60 ? 0 : extra(x, y, z) || (y === 0 ? 1 : 0)),
    topSolid: (x: number, z: number) => { for (let y = 39; y >= 0; y--) if ((x < 0 || x >= 60 || z < 0 || z >= 60 ? 0 : (extra(x, y, z) || (y === 0 ? 1 : 0))) !== 0) return y; return -Infinity; },
  });
  const fitsAll = () => true;

  it('keeps a door on open ground at the hinted height', () => {
    expect(snapDoorCell(mk(() => 0), [10, 1, 10], fitsAll)).toEqual([10, 1, 10]);
  });
  it('ignores the canopy above and the wrong hint: stands on the real ground, not on top of the tree', () => {
    const w = mk((x, y) => (x >= 20 && x < 24 && y === 12 ? 3 : 0)); // canopy at y 12 (6 m), ground voxel y 0
    expect(snapDoorCell(w, [21, 40, 21], fitsAll)).toEqual([21, 1, 21]);
  });
  it('rejects a door whose cell is outside the map and one with no standable ground nearby', () => {
    expect(snapDoorCell(mk(() => 0), [70, 1, 10], fitsAll)).toBeNull();
    expect(snapDoorCell(mk(() => 0), [10, 1, 10], () => false)).toBeNull();
  });
  it('spawn fallback never lands on an empty column', () => {
    const w = { ...mk(() => 0), cell: (x: number, y: number, z: number) => (x >= 30 && y === 0 ? 1 : 0), topSolid: (x: number, _z: number) => (x >= 30 ? 0 : -Infinity), materials: [] as string[] };
    const s = findSpawn(w, 5, 5, () => false, 40);
    expect(s.how).toBe('fallback');
    expect(s.x).toBeGreaterThanOrEqual(15);
    expect(Number.isFinite(s.y)).toBe(true);
  });
});
