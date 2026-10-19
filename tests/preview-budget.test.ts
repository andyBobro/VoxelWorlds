import { describe, expect, it } from 'vitest';
import {
  DegradeTracker, RemountLimiter, detailGeometryBudget, MIN_DETAIL_BUDGET, MIN_GEOMETRY_BUDGET,
  HUGE_VOXELS, LARGE_VOXELS, MEDIUM_VOXELS, friendlyPreviewError, geometryBytes, peekVoxelCount, planBudget, rendererAttempts,
} from '../src/renderer/preview/budget';

describe('planBudget', () => {
  it('keeps full quality for normal sizes', () => {
    const b = planBudget(1_000_000);
    expect(b).toMatchObject({ antialias: true, shadows: true, shadowMapSize: 4096, maxPixelRatio: 2, powerPreference: 'high-performance' });
  });

  it('gets monotonically cheaper with scene size', () => {
    const sizes = [1e6, MEDIUM_VOXELS, LARGE_VOXELS, HUGE_VOXELS, 5e8];
    const bs = sizes.map((v) => planBudget(v));
    for (let i = 1; i < bs.length; i++) {
      expect(bs[i]!.maxPixelRatio).toBeLessThanOrEqual(bs[i - 1]!.maxPixelRatio);
      expect(bs[i]!.shadowMapSize).toBeLessThanOrEqual(bs[i - 1]!.shadowMapSize);
      expect(bs[i]!.maxGeometryBytes).toBeLessThanOrEqual(bs[i - 1]!.maxGeometryBytes);
      expect(Number(bs[i]!.shadows)).toBeLessThanOrEqual(Number(bs[i - 1]!.shadows));
      expect(Number(bs[i]!.antialias)).toBeLessThanOrEqual(Number(bs[i - 1]!.antialias));
    }
    expect(planBudget(LARGE_VOXELS)).toMatchObject({ antialias: false, shadows: false, maxPixelRatio: 1 });
    expect(planBudget(1e6).maxTriangles).toBe(Infinity);
    expect(planBudget(HUGE_VOXELS).maxTriangles).toBeLessThan(planBudget(LARGE_VOXELS).maxTriangles);
    expect(planBudget(LARGE_VOXELS).maxTriangles).toBeLessThan(planBudget(1e6).maxTriangles);
  });

  it('degrade bumps the tier and is clamped', () => {
    expect(planBudget(1000, 0).antialias).toBe(true);
    expect(planBudget(1000, 2).antialias).toBe(false);
    expect(planBudget(1000, 2).shadows).toBe(false);
    expect(planBudget(1e9, 99)).toEqual(planBudget(1e9, 4));
    expect(planBudget(1000, -3)).toEqual(planBudget(1000, 0));
    expect(planBudget(1000, 0.9)).toEqual(planBudget(1000, 0));
  });

  it('a GPU geometry cap always exists and is finite', () => {
    for (const v of [0, 1e6, 1e8]) expect(Number.isFinite(planBudget(v).maxGeometryBytes)).toBe(true);
  });
});

describe('rendererAttempts', () => {
  it('starts at the budget and ends at the cheapest option set', () => {
    const a = rendererAttempts(planBudget(1000), 2);
    expect(a[0]).toMatchObject({ antialias: true, pixelRatio: 2, shadows: true });
    expect(a[a.length - 1]).toMatchObject({ antialias: false, powerPreference: 'default', pixelRatio: 1, shadows: false, detailShadows: false });
    expect(a.length).toBeGreaterThanOrEqual(3);
  });

  it('never gets more expensive from one attempt to the next', () => {
    const a = rendererAttempts(planBudget(1000), 3);
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!.pixelRatio).toBeLessThanOrEqual(a[i - 1]!.pixelRatio);
      expect(a[i]!.shadowMapSize).toBeLessThanOrEqual(a[i - 1]!.shadowMapSize);
      expect(Number(a[i]!.antialias)).toBeLessThanOrEqual(Number(a[i - 1]!.antialias));
      expect(Number(a[i]!.shadows)).toBeLessThanOrEqual(Number(a[i - 1]!.shadows));
    }
  });

  it('already-cheap budgets do not repeat identical attempts and tolerate a bad dpr', () => {
    const a = rendererAttempts(planBudget(1e9), NaN);
    const keys = a.map((o) => JSON.stringify(o));
    expect(new Set(keys).size).toBe(keys.length);
    expect(a[0]!.pixelRatio).toBe(1);
  });
});

describe('peekVoxelCount', () => {
  const mk = (header: unknown): ArrayBuffer => {
    const h = new TextEncoder().encode(JSON.stringify(header));
    const buf = new ArrayBuffer(8 + h.length);
    const dv = new DataView(buf);
    new Uint8Array(buf).set([0x56, 0x57, 0x47, 0x31]);
    dv.setUint32(4, h.length, true);
    new Uint8Array(buf, 8).set(h);
    return buf;
  };
  it('reads voxelCount from the header', () => {
    expect(peekVoxelCount(mk({ version: 1, voxelCount: 12345 }))).toBe(12345);
  });
  it('returns 0 for garbage instead of throwing', () => {
    expect(peekVoxelCount(new ArrayBuffer(3))).toBe(0);
    expect(peekVoxelCount(mk({ voxelCount: 'x' }))).toBe(0);
    const bad = new ArrayBuffer(16);
    new DataView(bad).setUint32(4, 1000, true);
    expect(peekVoxelCount(bad)).toBe(0);
  });
});

describe('geometryBytes', () => {
  it('scales with vertices and index width', () => {
    expect(geometryBytes(100, 150, 2)).toBeLessThan(geometryBytes(100, 150, 4));
    expect(geometryBytes(0, 0)).toBe(0);
  });
});

describe('friendlyPreviewError', () => {
  it('makes WebGL failures actionable and mentions the voxel size', () => {
    const t = friendlyPreviewError('Error: THREE.WebGLRenderer: Error creating WebGL context.', 1);
    expect(t).toMatch(/larger voxel size/);
    expect(t).toMatch(/2 m/);
    expect(t).toMatch(/Reload preview/);
    expect(t.startsWith('Error:')).toBe(false);
  });
  it('leaves other errors untouched', () => {
    expect(friendlyPreviewError('VWG: bad magic', 1)).toBe('VWG: bad magic');
  });
  it('does not blame a small world: only advises reloading', () => {
    const t = friendlyPreviewError('WebGL context lost', 1, 1_000_000);
    expect(t).toMatch(/Reload preview/);
    expect(t).not.toMatch(/voxel size|very large/);
    expect(friendlyPreviewError('WebGL context lost', 1, 40_000_000)).toMatch(/larger voxel size/);
  });
  it('works without a voxel size', () => {
    expect(friendlyPreviewError('WebGL context lost')).toMatch(/larger voxel size/);
  });
});

describe('geometry cap vs degrade', () => {
  it('steps down with every degrade level, for every scene size', () => {
    for (const v of [1e6, 1e7, 3e7, 8e7]) {
      for (let d = 1; d <= 4; d++) {
        const a = planBudget(v, d - 1).maxGeometryBytes, b = planBudget(v, d).maxGeometryBytes;
        expect(b).toBeLessThanOrEqual(a);
      }
      expect(planBudget(v, 3).maxGeometryBytes).toBeLessThan(planBudget(v, 0).maxGeometryBytes);
      expect(planBudget(v, 99).maxGeometryBytes).toBeGreaterThanOrEqual(MIN_GEOMETRY_BUDGET);
    }
    expect(planBudget(1e6, 1).maxGeometryBytes).toBeLessThan(planBudget(1e6, 0).maxGeometryBytes);
  });
  it('detail scene shares the budget with the city', () => {
    const cap = 1000 * 1024 * 1024;
    expect(detailGeometryBudget(cap, 400 * 1024 * 1024)).toBe(600 * 1024 * 1024);
    expect(detailGeometryBudget(cap, cap)).toBe(MIN_DETAIL_BUDGET);
    expect(detailGeometryBudget(cap, cap * 2)).toBe(MIN_DETAIL_BUDGET);
  });
});

describe('DegradeTracker', () => {
  it('counts one incident once', () => {
    const t = new DegradeTracker();
    expect(t.bump(1000)).toBe(1);
    expect(t.bump(1000 + 3000)).toBe(1); // e.g. the failed remount right after the loss
    expect(t.bump(1000 + DegradeTracker.INCIDENT_MS + 1)).toBe(2);
  });
  it('is clamped and resettable', () => {
    const t = new DegradeTracker();
    let now = 0;
    for (let i = 0; i < 10; i++) { now += 20_000; t.bump(now); }
    expect(t.level(now)).toBe(DegradeTracker.MAX);
    t.reset();
    expect(t.level(now)).toBe(0);
    expect(t.bump(now + 1)).toBe(1); // reset also forgets the incident window
  });
  it('decays one level per stable period', () => {
    const t = new DegradeTracker();
    let now = 1000;
    for (let i = 0; i < 3; i++) { t.bump(now); now += 20_000; }
    const last = now - 20_000;
    expect(t.level(last + DegradeTracker.DECAY_MS - 1)).toBe(3);
    expect(t.level(last + DegradeTracker.DECAY_MS)).toBe(2);
    expect(t.level(last + 3 * DegradeTracker.DECAY_MS)).toBe(0);
  });
});

describe('RemountLimiter', () => {
  it('allows two per window, then refuses until the window passes', () => {
    const l = new RemountLimiter(2, 60_000);
    expect(l.tryAcquire(0)).toBe(true);
    expect(l.tryAcquire(10_000)).toBe(true);
    expect(l.tryAcquire(20_000)).toBe(false);
    expect(l.tryAcquire(60_001)).toBe(true);
    expect(l.tryAcquire(60_002)).toBe(false);
  });
});

import { hudTruncationNote } from '../src/renderer/preview/hud';
describe('hudTruncationNote', () => {
  it('names the detail scene when the detail itself is truncated', () => {
    expect(hudTruncationNote(true)).toMatch(/detail/);
    expect(hudTruncationNote(false)).toMatch(/outer area/);
    expect(hudTruncationNote(true)).not.toBe(hudTruncationNote(false));
  });
});
