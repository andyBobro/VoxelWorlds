import { describe, expect, it } from 'vitest';
import { GROUP, boundsSphere, groupChunks, mergeMeshes } from '../src/renderer/preview/merge';
import type { MeshData } from '../src/renderer/preview/mesher';

const id = (dims: [number, number, number], cx: number, cy: number, cz: number): number => (cy * dims[2] + cz) * dims[0] + cx;

describe('groupChunks', () => {
  const dims: [number, number, number] = [10, 2, 9];
  const all: number[] = [];
  for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 9; cz++) for (let cx = 0; cx < 10; cx++) all.push(id(dims, cx, cy, cz));

  it('puts every chunk in exactly one group and groups are spatially coherent', () => {
    const g = groupChunks(dims, all);
    expect(g.order.length).toBe(all.length);
    expect(new Set(g.order).size).toBe(all.length);
    const ng = g.coords.length / 3;
    expect(ng).toBe(Math.ceil(10 / GROUP) * Math.ceil(2 / GROUP) * Math.ceil(9 / GROUP));
    for (let k = 0; k < ng; k++) {
      for (let i = g.starts[k]!; i < g.starts[k + 1]!; i++) {
        const c = g.order[i]!;
        const cx = c % 10, cz = Math.floor(c / 10) % 9, cy = Math.floor(c / 90);
        expect([Math.floor(cx / GROUP), Math.floor(cy / GROUP), Math.floor(cz / GROUP)]).toEqual([g.coords[k * 3], g.coords[k * 3 + 1], g.coords[k * 3 + 2]]);
      }
    }
  });

  it('orders groups nearest the grid centre first', () => {
    const g = groupChunks([40, 1, 40], Array.from({ length: 1600 }, (_, i) => i));
    const d = (k: number): number => {
      const ex = g.coords[k * 3]! * GROUP + GROUP / 2 - 20, ez = g.coords[k * 3 + 2]! * GROUP + GROUP / 2 - 20;
      return ex * ex + ez * ez;
    };
    for (let k = 1; k < g.coords.length / 3; k++) expect(d(k)).toBeGreaterThanOrEqual(d(k - 1) - 1e-9);
  });

  it('skips empty chunks and handles no chunks', () => {
    expect(groupChunks([5, 5, 5], []).order.length).toBe(0);
    const g = groupChunks([40, 1, 1], [0, 39]);
    expect(g.coords.length / 3).toBe(2);
  });
});

function quadMesh(x: number, y: number, z: number): MeshData {
  return {
    positions: new Float32Array([x, y, z, x + 1, y, z, x + 1, y + 1, z, x, y + 1, z]),
    normals: new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127]),
    colors: new Uint8Array(12).fill(200),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    triangleCount: 2,
  };
}

describe('mergeMeshes', () => {
  it('offsets positions and indices and reports exact bounds', () => {
    const m = mergeMeshes([
      { mesh: quadMesh(0, 0, 0), ox: 0, oy: 0, oz: 0 },
      { mesh: quadMesh(31, 5, 2), ox: 96, oy: 32, oz: 64 },
    ])!;
    expect(m.vertexCount).toBe(8);
    expect(m.triangleCount).toBe(4);
    expect(m.positions).toBeInstanceOf(Uint8Array);
    expect(Array.from(m.positions.subarray(12, 15))).toEqual([127, 37, 66]);
    expect(Array.from(m.indices.slice(6))).toEqual([4, 5, 6, 4, 6, 7]);
    expect(m.indices).toBeInstanceOf(Uint16Array);
    expect(m.bounds).toEqual([0, 0, 0, 128, 38, 66]);
    expect(m.normals.length).toBe(24);
  });

  it('switches to 32-bit indices above 65535 vertices and returns null for nothing', () => {
    const big = (n: number): MeshData => ({
      positions: new Float32Array(n * 3), normals: new Int8Array(n * 3), colors: new Uint8Array(n * 3),
      indices: new Uint32Array([n - 3, n - 2, n - 1]), vertexCount: n, triangleCount: 1,
    });
    const m = mergeMeshes([{ mesh: big(40000), ox: 0, oy: 0, oz: 0 }, { mesh: big(40000), ox: 32, oy: 0, oz: 0 }])!;
    expect(m.indices).toBeInstanceOf(Uint32Array);
    expect(m.indices[3]).toBe(40000 + 39997);
    expect(mergeMeshes([])).toBeNull();
  });

  it('boundsSphere encloses the box', () => {
    const [cx, cy, cz, r] = boundsSphere([0, 0, 0, 128, 64, 32]);
    expect([cx, cy, cz]).toEqual([64, 32, 16]);
    expect(r).toBeCloseTo(Math.hypot(128, 64, 32) / 2);
  });
});
