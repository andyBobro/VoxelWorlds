import { describe, expect, it } from 'vitest';
import { orientBitmap, orientedSize, readImageInfo } from '../src/main/image';
import { validateAnalyzeFacade, validateDetail, validateDetailStats, validateFacadeSpec } from '../src/main/validate';
import type { DetailParams, FacadeSpec } from '../src/shared/contract';

const bbox = { latMin: 1, lonMin: 2, latMax: 1.01, lonMax: 2.01 };
const spec: FacadeSpec = {
  version: 1, wallWidthM: 10, wallHeightM: 9, floors: 3, floorLinesV: [3, 6],
  wallColour: [200, 200, 200], trimColour: [10, 10, 10], glassColour: [0, 0, 255], material: 'brick',
  windows: [{ u: 1, v: 1, w: 1, h: 1 }], doors: [], confidence: { floors: 1, windows: 1, doors: 0, colour: 0.5 },
};
const det = (o: Partial<DetailParams> = {}): DetailParams => ({
  ref: { bbox: { ...bbox }, buildingId: 'way/123#2' }, voxelSize: 0.15, maxVoxels: 1_000_000, ...o,
});

describe('validateDetail', () => {
  it('accepts id with #n suffix and matching bbox', () => expect(() => validateDetail(det(), bbox)).not.toThrow());
  it('rejects bbox mismatch / no generate', () => {
    expect(() => validateDetail(det(), { ...bbox, latMin: 1.5 })).toThrow(/BAD_REQUEST/);
    expect(() => validateDetail(det(), null)).toThrow(/BAD_REQUEST/);
  });
  it('caps maxVoxels at 30M and checks interior', () => {
    expect(() => validateDetail(det({ maxVoxels: 30_000_001 }), bbox)).toThrow();
    expect(() => validateDetail(det({ interior: { enabled: true, levelsOverride: 0 } }), bbox)).toThrow();
    expect(() => validateDetail(det({ interior: { enabled: true, seed: 1.5 } }), bbox)).toThrow();
    expect(() => validateDetail(det({ interior: { enabled: true, roomMinM: 2.5, wallThicknessM: 0.2, seed: 7 } }), bbox)).not.toThrow();
  });
  it('validates facade spec', () => {
    expect(() => validateDetail(det({ facade: { edge: 0, spec } }), bbox)).not.toThrow();
    expect(() => validateFacadeSpec({ ...spec, floorLinesV: [3, 3] })).toThrow();
    expect(() => validateFacadeSpec({ ...spec, wallColour: [256, 0, 0] })).toThrow();
    expect(() => validateFacadeSpec({ ...spec, material: 'x' as never })).toThrow();
  });
  it('validates stats', () => {
    const st = { voxelCount: 1, levels: 1, rooms: 1, windows: 1, doors: 1, elapsedMs: 1, floorYs: [0] };
    expect(() => validateDetailStats(st)).not.toThrow();
    expect(() => validateDetailStats({ ...st, floorYs: [0.5] })).toThrow();
  });
});

describe('validateAnalyzeFacade', () => {
  it('rejects bad corners', () => {
    const ok = { photoPath: '/a.jpg', corners: [[0, 0], [1, 0], [1, 1], [0, 1]], wallWidthM: 5, wallHeightM: 5 } as never;
    expect(() => validateAnalyzeFacade(ok)).not.toThrow();
    for (const k of ['wallWidthM', 'wallHeightM']) {
      for (const v of [0.4, 300.1]) expect(() => validateAnalyzeFacade({ ...(ok as object), [k]: v } as never)).toThrow();
      for (const v of [0.5, 300]) expect(() => validateAnalyzeFacade({ ...(ok as object), [k]: v } as never)).not.toThrow();
    }
    expect(() => validateFacadeSpec({ ...spec, wallWidthM: 301 })).toThrow();
    expect(() => validateFacadeSpec({ ...spec, wallHeightM: 0.4 })).toThrow();
    expect(() => validateAnalyzeFacade({ ...(ok as object), corners: [[0, 0], [1, 0], [1, 1], [NaN, 1]] } as never)).toThrow();
  });
});

function exifJpeg(orientation: number, w: number, h: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const a = Buffer.alloc(4); a[0] = 0xff; a[1] = 0xe1; a.writeUInt16BE(app1.length + 2, 2);
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), a, app1, sof]);
}

describe('image header', () => {
  it('reads EXIF-6 JPEG', () => {
    const i = readImageInfo(exifJpeg(6, 4000, 3000))!;
    expect(i).toEqual({ width: 4000, height: 3000, orientation: 6 });
    expect(orientedSize(i.width, i.height, i.orientation)).toEqual({ width: 3000, height: 4000 });
  });
  it('reads PNG dims and rejects junk', () => {
    const p = Buffer.alloc(24); p[0] = 0x89; p.write('PNG', 1, 'latin1'); p.writeUInt32BE(20000, 16); p.writeUInt32BE(20000, 20);
    expect(readImageInfo(p)!.width * readImageInfo(p)!.height).toBeGreaterThan(100_000_000);
    expect(readImageInfo(Buffer.from('hello world, not an image at all....'))).toBeNull();
  });
  it('orientBitmap 6 rotates 90 CW', () => {
    // 2x1 image [A B] -> 1x2 column [A; B]
    const src = Buffer.from([1, 1, 1, 255, 2, 2, 2, 255]);
    const r = orientBitmap(src, 2, 1, 6);
    expect([r.width, r.height]).toEqual([1, 2]);
    expect([r.data[0], r.data[4]]).toEqual([1, 2]);
  });
});
