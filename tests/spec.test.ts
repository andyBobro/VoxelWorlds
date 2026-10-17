import { describe, expect, it } from 'vitest';
import { WALL_MAX_M, WALL_MIN_M, clampWall, resizeWall, wallSizeError, addRect, blankSpec, clampRect, estimateDetailVoxels, finalizeSpec, hexToRgb, lowConfidenceFields, moveRect, removeRect, resizeRect, rgbToHex, setFloors } from '../src/renderer/detail/spec';
import { applyH, quadIsConvex, validateQuad, rectify, squareToQuad } from '../src/renderer/detail/homography';

describe('spec helpers', () => {
  const s = blankSpec(10, 9, 3);
  it('floors', () => {
    expect(s.floorLinesV).toEqual([3, 6]);
    expect(setFloors(s, 4).floorLinesV).toEqual([2.25, 4.5, 6.75]);
    expect(setFloors(s, 0).floors).toBe(1);
  });
  it('clamp/move/resize', () => {
    expect(clampRect({ u: 9.5, v: -1, w: 2, h: 1 }, 10, 9)).toEqual({ u: 8, v: 0, w: 2, h: 1 });
    expect(moveRect({ u: 1, v: 1, w: 1, h: 1 }, -5, 20, 10, 9)).toEqual({ u: 0, v: 8, w: 1, h: 1 });
    const r = resizeRect({ u: 1, v: 1, w: 2, h: 2 }, 'ne', 1, 1, 10, 9);
    expect(r).toEqual({ u: 1, v: 1, w: 3, h: 3 });
    const m = resizeRect({ u: 1, v: 1, w: 2, h: 2 }, 'w', 5, 0, 10, 9);
    expect(m.w).toBeCloseTo(0.2); expect(m.u).toBeCloseTo(2.8);
  });
  it('add/remove', () => {
    const a = addRect(addRect(s, 'windows'), 'doors');
    expect(a.windows).toHaveLength(1);
    expect(a.doors[0]!.v).toBe(0);
    expect(removeRect(a, 'windows', 0).windows).toHaveLength(0);
    expect(s.windows).toHaveLength(0); // immutable
  });
  it('finalize', () => {
    const f = finalizeSpec({ ...s, floorLinesV: [6, 3, 3, 0, 20, NaN], windows: [{ u: 50, v: 0, w: 1, h: 1 }] });
    expect(f.floorLinesV).toEqual([3, 6]);
    expect(f.windows[0]!.u).toBe(9);
  });
  it('colour + confidence', () => {
    expect(rgbToHex([255, 0, 16])).toBe('#ff0010');
    expect(hexToRgb('#ff0010')).toEqual([255, 0, 16]);
    expect(lowConfidenceFields({ ...s, confidence: { floors: 0.9, windows: 0.2, doors: 0.4, colour: 1 } })).toEqual(['windows', 'doors']);
  });
  const rect = (w: number, d: number, kind = 'residential', levels = 3, heightM = 10) => ({
    id: 'x', kind, levels, heightM, footprint: [[0, 0], [w, 0], [w, d], [0, d]] as Array<[number, number]>, baseY: 0, topY: 10,
  });
  it('estimate follows the python fit (counts scale 1/vs^2)', () => {
    const b = rect(25, 36.5, 'residential', 4, 23.6); // 912.5 m2
    const off = estimateDetailVoxels(b, 1, 0.15, { enabled: false });
    expect(Math.abs(off / 233_000 - 1)).toBeLessThan(0.02);
    expect(Math.abs(estimateDetailVoxels(b, 1, 0.15, { enabled: true }) / 599_000 - 1)).toBeLessThan(0.06);
    const small = rect(10.9, 10.9, 'residential', 6, 23.8); // ~119 m2, 6 levels: small compact
    expect(Math.abs(estimateDetailVoxels(small, 1, 0.15, { enabled: false }) / 64_600 - 1)).toBeLessThan(0.02);
    expect(Math.abs(estimateDetailVoxels(small, 1, 0.15, { enabled: true }) / 162_000 - 1)).toBeLessThan(0.06);
    // 1/vs^2 scaling
    expect(estimateDetailVoxels(b, 1, 0.075, { enabled: false }) / off).toBeCloseTo(4, 5);
  });
  it('estimate: interior classes, single-level kinds, footprint units', () => {
    const typ = rect(20, 20, 'residential', 3, 10);
    const on = estimateDetailVoxels(typ, 1, 0.15, { enabled: true }) - estimateDetailVoxels(typ, 1, 0.15, { enabled: false });
    expect(on).toBeCloseTo((2.1 * 400 * 3) / 0.0225, -1);
    const church = rect(20, 20, 'religious', 3, 10);
    const onC = estimateDetailVoxels(church, 1, 0.15, { enabled: true }) - estimateDetailVoxels(church, 1, 0.15, { enabled: false });
    expect(onC).toBeCloseTo((2.1 * 400 * 1) / 0.0225, -1);
    const large = rect(40, 40, 'commercial', 3, 10);
    const onL = estimateDetailVoxels(large, 1, 0.15, { enabled: true }) - estimateDetailVoxels(large, 1, 0.15, { enabled: false });
    expect(onL).toBeCloseTo((1.7 * 1600 * 3) / 0.0225, -1);
    // interpolation between samples, and city voxel size scales the footprint into metres
    const mid = estimateDetailVoxels(typ, 1, 0.125, { enabled: true }) - estimateDetailVoxels(typ, 1, 0.125, { enabled: false });
    expect(mid).toBeCloseTo((2.65 * 400 * 3) / (0.125 * 0.125), -1);
    expect(estimateDetailVoxels(rect(10, 10, 'residential', 3, 10), 2, 0.15, { enabled: false })).toBe(estimateDetailVoxels(typ, 1, 0.15, { enabled: false }));
  });
  it('new door: door-sized, ground row, left-most free spot, overlaps no window', () => {
    let sp = blankSpec(12, 9, 3);
    sp = { ...sp, windows: [{ u: 0.3, v: 0.5, w: 1.2, h: 1.4 }, { u: 2, v: 0.5, w: 1.2, h: 1.4 }] };
    const d = addRect(sp, 'doors').doors[0]!;
    expect(d.v).toBe(0);
    expect(d.w).toBeGreaterThanOrEqual(0.9); expect(d.w).toBeLessThanOrEqual(1.0);
    expect(d.h).toBeGreaterThanOrEqual(2.0); expect(d.h).toBeLessThanOrEqual(2.2);
    for (const w of sp.windows) expect(d.u + d.w <= w.u || d.u >= w.u + w.w).toBe(true);
    expect(d.u).toBeGreaterThan(3.2 - 1e-9); // first bay right of the second window
    // fully packed ground row: falls back to something valid inside the wall
    const full = { ...blankSpec(2, 3, 1), windows: [{ u: 0.2, v: 0, w: 1.6, h: 2 }] };
    const f = addRect(full, 'doors').doors[0]!;
    expect(f.u).toBeGreaterThanOrEqual(0); expect(f.u + f.w).toBeLessThanOrEqual(2 + 1e-9);
  });
});

describe('wall size range', () => {
  it('validates 0.5..300 m', () => {
    expect(wallSizeError(10, 3)).toBeNull();
    expect(wallSizeError(WALL_MIN_M, WALL_MAX_M)).toBeNull();
    expect(wallSizeError(0.4, 3)).not.toBeNull();
    expect(wallSizeError(10, 300.1)).not.toBeNull();
    expect(wallSizeError(null, 3)).not.toBeNull();
    expect(wallSizeError(NaN, 3)).not.toBeNull();
  });
  it('clamps defaults, rescaled and finalized specs', () => {
    expect(clampWall(0.1)).toBe(0.5);
    expect(clampWall(1000)).toBe(300);
    const r = resizeWall(blankSpec(10, 9, 3), 1000, 0.1);
    expect([r.wallWidthM, r.wallHeightM]).toEqual([300, 0.5]);
    const f = finalizeSpec({ ...blankSpec(10, 9, 3), wallWidthM: 500, wallHeightM: 0.01 });
    expect([f.wallWidthM, f.wallHeightM]).toEqual([300, 0.5]);
  });
});

describe('homography', () => {
  it('maps unit square corners to the quad', () => {
    const q = [[10, 20], [110, 30], [100, 120], [5, 100]] as const;
    const H = squareToQuad(q);
    for (const [i, [s, t]] of ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).entries()) {
      const [x, y] = applyH(H, s, t);
      expect(x).toBeCloseTo(q[i]![0]); expect(y).toBeCloseTo(q[i]![1]);
    }
    expect(quadIsConvex(q)).toBe(true);
    expect(quadIsConvex([[0, 0], [10, 0], [2, 2], [0, 10]])).toBe(false);
  });
  it('validateQuad rejects mirrored, tiny and sliver quads', () => {
    const ok = [[100, 100], [700, 120], [690, 500], [110, 480]] as const;
    expect(validateQuad(ok, 800, 600)).toBeNull();
    expect(validateQuad([ok[1], ok[0], ok[3], ok[2]], 800, 600)).not.toBeNull(); // mirrored
    expect(validateQuad([ok[0], ok[3], ok[2], ok[1]], 800, 600)).not.toBeNull(); // counter-clockwise
    expect(validateQuad([[0, 0], [30, 0], [30, 30], [0, 30]], 800, 600)).toMatch(/small/);
    expect(validateQuad([[0, 0], [700, 0], [700, 8], [0, 8]], 800, 600)).not.toBeNull(); // sliver
  });
  it('identity rectify', () => {
    const w = 4, h = 4, src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { src[i * 4] = i * 10; src[i * 4 + 3] = 255; }
    const out = new Uint8ClampedArray(w * h * 4);
    rectify(src, w, h, [[0, 0], [4, 0], [4, 4], [0, 4]], out, w, h);
    expect(Array.from(out.filter((_, i) => i % 4 === 0))).toEqual(Array.from(src.filter((_, i) => i % 4 === 0)));
  });
});

describe('friendlyPhotoError', () => {
  it('maps backend photo errors to plain language', async () => {
    const { friendlyPhotoError } = await import('../src/renderer/ui/detailPanel');
    expect(friendlyPhotoError('PHOTO_UNREADABLE: image is 150.0 MP, over the 100 MP limit')).toMatch(/too large \(over 100 megapixels\)/);
    expect(friendlyPhotoError('PHOTO_UNREADABLE: cannot identify image file')).toMatch(/not a readable image/);
    expect(friendlyPhotoError('PHOTO_UNREADABLE: could not be read')).toMatch(/could not be read/);
  });
});

describe('detail max voxels + memory hint', () => {
  it('accepts 1..30 M only', async () => {
    const { parseDetailMaxVoxels, DETAIL_MAX_VOXELS_MAX } = await import('../src/renderer/ui/detailPanel');
    expect(DETAIL_MAX_VOXELS_MAX).toBe(30_000_000);
    expect(parseDetailMaxVoxels('20')).toBe(20_000_000);
    expect(parseDetailMaxVoxels('30')).toBe(30_000_000);
    expect(parseDetailMaxVoxels('1')).toBe(1_000_000);
    expect(parseDetailMaxVoxels('30.1')).toBeNull();
    expect(parseDetailMaxVoxels('60')).toBeNull();
    expect(parseDetailMaxVoxels('0.5')).toBeNull();
    expect(parseDetailMaxVoxels('x')).toBeNull();
  });
  it('memory hint only for fine voxels with interior on', async () => {
    const { detailMemoryHint } = await import('../src/renderer/ui/detailPanel');
    expect(detailMemoryHint(0.05, true)).toMatch(/GB/);
    expect(detailMemoryHint(0.09, true)).not.toBeNull();
    expect(detailMemoryHint(0.1, true)).toBeNull();
    expect(detailMemoryHint(0.05, false)).toBeNull();
  });
});
