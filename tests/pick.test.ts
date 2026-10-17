import { describe, expect, it } from 'vitest';
import type { BuildingInfo } from '../src/shared/contract';
import { BuildingGrid, edgeLength, hitToVoxel, nearestEdge, pickFromHit, pointInPolygon, polygonDistance } from '../src/renderer/pick/geometry';

const sq = (x: number, z: number, s: number): Array<[number, number]> => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
const B = (id: string, fp: Array<[number, number]>, baseY = 0, topY = 10): BuildingInfo =>
  ({ id, kind: 'residential', levels: 3, heightM: 10, footprint: fp, baseY, topY });

describe('pointInPolygon', () => {
  const L: Array<[number, number]> = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  it('handles concave', () => {
    expect(pointInPolygon(L, 2, 8)).toBe(true);
    expect(pointInPolygon(L, 8, 8)).toBe(false);
    expect(pointInPolygon(L, 8, 2)).toBe(true);
  });
  it('distance outside', () => {
    expect(polygonDistance(sq(0, 0, 10), 12, 5)).toBeCloseTo(2);
    expect(polygonDistance(sq(0, 0, 10), 5, 5)).toBe(0);
  });
});

describe('nearestEdge', () => {
  const ring = sq(0, 0, 10); // edges: 0 north(z=0), 1 east(x=10), 2 south, 3 west
  it('nearest by distance', () => {
    expect(nearestEdge(ring, 5, 0.2)).toBe(0);
    expect(nearestEdge(ring, 9.8, 5)).toBe(1);
  });
  it('uses face normal near a corner', () => {
    // point close to the corner (9.9,0.1): nearer to the east edge but face normal says north wall
    expect(nearestEdge(ring, 9.9, 0.4, 0, -1)).toBe(0);
    expect(nearestEdge(ring, 9.9, 0.4, 1, 0)).toBe(1);
  });
  it('winding independent and edge length', () => {
    const cw = ring.slice().reverse();
    const e = nearestEdge(cw, 5, 10 - 0.1, 0, 1);
    const a = cw[e]!, b = cw[(e + 1) % 4]!;
    expect(a[1]).toBe(10); expect(b[1]).toBe(10);
    expect(edgeLength(ring, 0)).toBe(10);
  });
});

describe('nearestEdge signed normals / diagonal walls', () => {
  // CCW seen from above (x east, z south): east along south edge, north along east edge, ...
  const ccw: Array<[number, number]> = [[0, 10], [10, 10], [10, 0], [0, 0]];
  it('outward normals point out', async () => {
    const { edgeOutwardNormal } = await import('../src/renderer/pick/geometry');
    expect(edgeOutwardNormal(ccw, 0).map((v) => v + 0)).toEqual([0, 1]);   // south wall -> +z
    expect(edgeOutwardNormal(ccw, 1).map((v) => v + 0)).toEqual([1, 0]);   // east wall -> +x
    expect(edgeOutwardNormal(ccw.slice().reverse(), 0).map((v) => v + 0)).toEqual([0, -1]); // other winding handled: (0,0)->(10,0) is the north wall
  });
  const rot = (pt: [number, number], deg: number): [number, number] => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return [5 + (pt[0] - 5) * c - (pt[1] - 5) * s, 5 + (pt[0] - 5) * s + (pt[1] - 5) * c];
  };
  const poly = ccw.map((q) => rot(q, 40));
  it('stair-step (axis-aligned) faces on a 40deg wall select that wall', async () => {
    const { edgeOutwardNormal } = await import('../src/renderer/pick/geometry');
    for (const e of [0, 1, 2, 3]) {
      const [ox, oz] = edgeOutwardNormal(poly, e);
      const axis: [number, number] = Math.abs(ox) > Math.abs(oz) ? [Math.sign(ox), 0] : [0, Math.sign(oz)];
      const A = poly[e]!, B = poly[(e + 1) % 4]!;
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const px = A[0] + (B[0] - A[0]) * t + ox * 0.5, pz = A[1] + (B[1] - A[1]) * t + oz * 0.5;
        expect(nearestEdge(poly, px, pz, axis[0], axis[1])).toBe(e);
      }
    }
  });
  it('a back-facing wall on the far side loses even if close', () => {
    // thin slab: north wall (edge 2) and south wall (edge 0) 1.5 voxels apart; click south face -> south edge
    const slab: Array<[number, number]> = [[0, 1.5], [20, 1.5], [20, 0], [0, 0]]; // CCW from above
    expect(nearestEdge(slab, 10, 1.4, 0, 1)).toBe(0);
    expect(nearestEdge(slab, 10, 0.1, 0, -1)).toBe(2);
  });
});

describe('BuildingGrid', () => {
  const bs = [B('a', sq(0, 0, 10)), B('b', sq(20, 0, 10), 0, 5), B('part', sq(2, 2, 3), 0, 20)];
  const g = new BuildingGrid(bs);
  it('finds by xz and y', () => {
    expect(g.query(15, 5, 15)).toBeNull();
    expect(g.query(25.5, 2, 5.5)?.id).toBe('b');
    expect(g.query(25.5, 7, 5.5)).toBeNull();
    expect(g.query(8, 5, 8)?.id).toBe('a');
  });
  it('smaller part wins when nested', () => {
    expect(g.query(3, 5, 3)?.id).toBe('part');
  });
  it('tolerance on boundary', () => {
    expect(g.query(10.5, 3, 5, 1)?.id).toBe('a');
    expect(g.query(12.5, 3, 5, 1)).toBeNull();
  });
  it('scales to many buildings', () => {
    const many: BuildingInfo[] = [];
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) many.push(B(`${i}_${j}`, sq(i * 15, j * 15, 10)));
    const gg = new BuildingGrid(many);
    expect(gg.query(15 * 37 + 5, 3, 15 * 62 + 5)?.id).toBe('37_62');
    expect(gg.query(15 * 37 + 12, 3, 15 * 62 + 12)).toBeNull();
  });
});

describe('pickFromHit', () => {
  const g = new BuildingGrid([B('a', sq(0, 0, 10))]);
  it('roof hit', () => {
    const r = pickFromHit(g, [5, 10, 0.3], [0, 1, 0])!;
    expect(r.building.id).toBe('a');
    expect(r.edge).toBe(0);
  });
  it('wall hit on footprint line selects that wall', () => {
    // east wall voxel x=10 sits just outside footprint [0,10]; face at x=11 pointing +x
    const r = pickFromHit(g, [11, 4, 5], [1, 0, 0])!;
    expect(r.building.id).toBe('a');
    expect(r.edge).toBe(1);
  });
  it('ground hits are not attributed (y < baseY)', () => {
    const g2 = new BuildingGrid([B('a', sq(0, 0, 10), 5, 15)]);
    expect(pickFromHit(g2, [5, 5, 5], [0, 1, 0])).toBeNull(); // top of ground column right at baseY
    expect(pickFromHit(g2, [10.5, 3, 5], [0, 1, 0])).toBeNull();
  });
  it('ground misses', () => {
    expect(pickFromHit(g, [5, 0, 5], [0, 1, 0])).toBeNull();
    expect(hitToVoxel([5, 3, 5], [0, 1, 0]).voxel).toEqual([5, 2, 5]);
  });
});
